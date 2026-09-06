// A2 exit gate: a staging database is reproducible from the migration chain
// alone, and an unsupported schema fails loudly instead of looking like empty data.
//
// Requires a local Postgres. Skips (rather than fails) when one is unavailable,
// so the unit suite still runs on a machine without a database.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadMigrations, validateChain, migrate, assertSchema, currentVersion,
  listTables, proveReproducible, psqlExec, psqlScalar,
  REQUIRED_SCHEMA_VERSION, REQUIRED_TABLES, MIGRATIONS_DIR,
} from "../src/core/schema.mjs";

const ADMIN = process.env.DCS_PG_ADMIN_DSN || "postgresql://127.0.0.1:5432/postgres";

let pgUp = false;
try { await psqlScalar(ADMIN, "select 1"); pgUp = true; } catch { pgUp = false; }
const dbTest = (name, fn) => test(name, { skip: pgUp ? false : "no local Postgres reachable" }, fn);

const rnd = () => "dcs_t_" + Math.random().toString(36).slice(2, 10);

// ------------------------------------------------------------- static checks

test("the migration chain is linear with no gaps or duplicates", () => {
  const ms = loadMigrations();
  assert.ok(ms.length >= 4, "expected at least the four canonical migrations");
  assert.deepEqual(validateChain(ms), []);
  assert.equal(ms[0].version, 1);
  assert.match(ms[0].file, /lineage_9937f22/, "0001 must be baselined from the live schema lineage");
});

test("the code's required schema version matches the highest migration", () => {
  const ms = loadMigrations();
  assert.equal(REQUIRED_SCHEMA_VERSION, ms[ms.length - 1].version);
});

test("the forensic seed cannot re-enter the chain", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dcs-mig-"));
  fs.writeFileSync(path.join(dir, "0001_ok.sql"), "create table if not exists t(id int);");
  fs.writeFileSync(
    path.join(dir, "0002_seed.sql"),
    "insert into public.dcsgames_users (username, atlas_verified) values ('novastudio', 'verified');"
  );
  assert.throws(() => loadMigrations(dir), /forensic seed/);
});

test("a reordered or gapped chain is rejected", () => {
  assert.notDeepEqual(validateChain([{ version: 1, file: "a" }, { version: 3, file: "c" }]), []);
  assert.notDeepEqual(validateChain([{ version: 1, file: "a" }, { version: 1, file: "b" }]), []);
});

// ------------------------------------------------------------ database proof

dbTest("A2 GATE: a staging database is fully reproducible from migrations alone", async () => {
  const db = rnd();
  try {
    const r = await proveReproducible(ADMIN, db);
    assert.equal(r.version, REQUIRED_SCHEMA_VERSION);
    for (const t of REQUIRED_TABLES) assert.ok(r.tables.includes(t), `missing required table ${t}`);
    assert.ok(r.tables.includes("dcsgames_users"), "the lineage baseline must be present");
    // second build from scratch lands identically
    const db2 = rnd();
    try {
      const r2 = await proveReproducible(ADMIN, db2);
      assert.deepEqual(r2.tables, r.tables, "two clean builds must produce the same schema");
    } finally { await psqlExec(ADMIN, `drop database if exists ${db2};`).catch(() => {}); }
  } finally { await psqlExec(ADMIN, `drop database if exists ${db};`).catch(() => {}); }
});

dbTest("migrate() is idempotent: re-running applies nothing", async () => {
  const db = rnd();
  try {
    const { dsn } = await proveReproducible(ADMIN, db);
    const again = await migrate(dsn, { log: () => {} });
    assert.equal(again.applied, 0);
    assert.equal(again.version, REQUIRED_SCHEMA_VERSION);
  } finally { await psqlExec(ADMIN, `drop database if exists ${db};`).catch(() => {}); }
});

dbTest("editing an already-applied migration is a hard error (append-only chain)", async () => {
  const db = rnd();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dcs-mig2-"));
  try {
    fs.writeFileSync(path.join(dir, "0001_first.sql"), "create table if not exists a(id int);");
    await psqlExec(ADMIN, `drop database if exists ${db};`).catch(() => {});
    await psqlExec(ADMIN, `create database ${db};`);
    const dsn = ADMIN.replace(/\/[^/]*$/, "") + "/" + db;
    await migrate(dsn, { dir, log: () => {} });
    fs.writeFileSync(path.join(dir, "0001_first.sql"), "create table if not exists a(id int, extra text);");
    await assert.rejects(() => migrate(dsn, { dir, log: () => {} }), /append-only|edited after being applied/);
  } finally { await psqlExec(ADMIN, `drop database if exists ${db};`).catch(() => {}); }
});

dbTest("A2 GATE: an unsupported schema fails loudly, not silently", async () => {
  const db = rnd();
  try {
    await psqlExec(ADMIN, `drop database if exists ${db};`).catch(() => {});
    await psqlExec(ADMIN, `create database ${db};`);
    const dsn = ADMIN.replace(/\/[^/]*$/, "") + "/" + db;
    assert.equal(await currentVersion(dsn), 0);
    await assert.rejects(
      () => assertSchema(dsn),
      (e) => e.code === "not_configured" && e.httpStatus === 503 && e.meta.missing.length > 0
    );
  } finally { await psqlExec(ADMIN, `drop database if exists ${db};`).catch(() => {}); }
});

dbTest("A2: constraints that make world writes idempotent actually exist", async () => {
  const db = rnd();
  try {
    const { dsn } = await proveReproducible(ADMIN, db);
    await psqlExec(dsn, `insert into public.dcsgames_base_worlds(world_id, manifest, manifest_hash) values ('w1','{}'::jsonb,'h1');`);
    await assert.rejects(
      () => psqlExec(dsn, `insert into public.dcsgames_base_worlds(world_id, manifest, manifest_hash) values ('w1','{}'::jsonb,'h1');`),
      /duplicate key|unique/i,
      "a second insert of the same world_id must be refused by the database"
    );
    const n = await psqlScalar(dsn, "select count(*) from public.dcsgames_base_worlds;");
    assert.equal(n, "1");
  } finally { await psqlExec(ADMIN, `drop database if exists ${db};`).catch(() => {}); }
});

dbTest("A2 GATE: forward migrate then restore from a dump reproduces the same schema", async () => {
  const src = rnd(), dst = rnd();
  const dump = path.join(os.tmpdir(), src + ".sql");
  try {
    const { dsn } = await proveReproducible(ADMIN, src);
    await psqlExec(dsn, `insert into public.dcsgames_base_worlds(world_id, owner_id, manifest, manifest_hash) values ('w_restore','u1','{"a":1}'::jsonb,'hh');`);

    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const run = promisify(execFile);
    const pgDump = fs.existsSync("/opt/homebrew/opt/postgresql@16/bin/pg_dump") ? "/opt/homebrew/opt/postgresql@16/bin/pg_dump" : "pg_dump";
    await run(pgDump, ["-d", dsn, "-f", dump]);

    await psqlExec(ADMIN, `drop database if exists ${dst};`).catch(() => {});
    await psqlExec(ADMIN, `create database ${dst};`);
    const dstDsn = ADMIN.replace(/\/[^/]*$/, "") + "/" + dst;
    await psqlExec(dstDsn, fs.readFileSync(dump, "utf8"));

    assert.equal(await currentVersion(dstDsn), REQUIRED_SCHEMA_VERSION, "the restored database reports the same schema version");
    assert.deepEqual((await listTables(dstDsn)).sort(), (await listTables(dsn)).sort());
    assert.equal(await psqlScalar(dstDsn, "select owner_id from public.dcsgames_base_worlds where world_id='w_restore';"), "u1", "data survives the restore");
    await assertSchema(dstDsn);
  } finally {
    fs.rmSync(dump, { force: true });
    await psqlExec(ADMIN, `drop database if exists ${src};`).catch(() => {});
    await psqlExec(ADMIN, `drop database if exists ${dst};`).catch(() => {});
  }
});

dbTest("B15 GATE: the subscription guards are real constraints, not comments", async () => {
  // Migration 0008 is deliberately STRICTER than the service that writes to it.
  // A constraint that only restates what the code already does adds nothing; one
  // that is stricter catches the code being wrong. These prove each guard
  // actually fires in Postgres rather than existing only in a .sql file.
  const db = rnd();
  try {
    const { dsn } = await proveReproducible(ADMIN, db);
    const row = (extra) => `insert into public.dcsgames_subscriptions(principal_id, granted_by, expires_at${extra.cols}) values ('p1','tester-1', timestamptz '2026-09-30T00:00:00Z'${extra.vals});`;

    // There is no status meaning "this person is paying". It cannot be written
    // by accident, by an import, or by a migration that forgets why.
    await assert.rejects(
      () => psqlExec(dsn, row({ cols: ", status", vals: ", 'active'" })),
      /dcsgames_subscriptions_status_check|violates check constraint/,
      "the database must refuse a paid-looking status"
    );

    // A comped subscription cannot carry a price.
    await assert.rejects(
      () => psqlExec(dsn, row({ cols: ", price_minor", vals: ", 49900" })),
      /price_minor|dcsgames_subscriptions_dark/,
      "the database must refuse a priced subscription"
    );

    // A subscription that is not comped cannot exist at all.
    await assert.rejects(
      () => psqlExec(dsn, row({ cols: ", comped", vals: ", false" })),
      /dcsgames_subscriptions_dark/,
      "the database must refuse a non-comped subscription"
    );
    await assert.rejects(
      () => psqlExec(dsn, row({ cols: ", test_mode", vals: ", false" })),
      /dcsgames_subscriptions_dark/,
      "the database must refuse a subscription that is not marked test mode"
    );

    // A grant made for a test window must die with the window. The SERVICE
    // defaults this correctly; the DATABASE is what catches a caller that does not.
    await assert.rejects(
      () => psqlExec(dsn, `insert into public.dcsgames_subscriptions(principal_id, granted_by) values ('p_forever','tester-1');`),
      /null value in column "expires_at"|not-null/,
      "a subscription with no expiry must be impossible"
    );
    await assert.rejects(
      () => psqlExec(dsn, `insert into public.dcsgames_subscriptions(principal_id, granted_by, expires_at) values ('p_late','tester-1', timestamptz '2027-01-01T00:00:00Z');`),
      /internal_window/,
      "a grant outliving the internal window must be impossible"
    );

    // And a legitimate comped grant still works, so the guards are not simply
    // blocking everything — a test that only proves refusals proves nothing.
    await psqlExec(dsn, `insert into public.dcsgames_subscriptions(principal_id, plan, granted_by, expires_at) values ('p_ok','dcs_plus','tester-1', timestamptz '2026-09-30T00:00:00Z');`);
    assert.equal(await psqlScalar(dsn, "select status from public.dcsgames_subscriptions where principal_id='p_ok';"), "comped");
    assert.equal(await psqlScalar(dsn, "select price_minor from public.dcsgames_subscriptions where principal_id='p_ok';"), "0");

    // A refused subscribe is still auditable: demand must not vanish because it
    // was correctly refused.
    await psqlExec(dsn, `insert into public.dcsgames_subscription_events(id, principal_id, event, actor_id) values ('e1','p_ok','subscribe_refused','p_ok');`);
    assert.equal(await psqlScalar(dsn, "select count(*) from public.dcsgames_subscription_events;"), "1");
    await assert.rejects(
      () => psqlExec(dsn, `insert into public.dcsgames_subscription_events(id, principal_id, event, actor_id) values ('e2','p_ok','paid','p_ok');`),
      /violates check constraint/,
      "there is no 'paid' event to record"
    );
  } finally {
    await psqlExec(ADMIN, `drop database if exists ${db};`).catch(() => {});
  }
});

dbTest("B15 GATE: money is dark at the DATABASE level, not only in application code", async () => {
  const db = rnd();
  try {
    const { dsn } = await proveReproducible(ADMIN, db);

    // A test-mode listing cannot carry a price, whatever the service believes.
    await assert.rejects(
      () => psqlExec(dsn, `insert into public.dcsgames_listings(id, seller_id, title, price_minor, test_mode) values ('l1','s','Evil',49900,true);`),
      /dcsgames_listings_dark_price/,
      "the database must refuse a priced test-mode listing"
    );

    // A test-mode ledger entry cannot carry money.
    await assert.rejects(
      () => psqlExec(dsn, `insert into public.dcsgames_ledger(ref,buyer_id,gross_minor,seller_minor,platform_minor,test_mode) values ('lgr1','b',10000,7000,3000,true);`),
      /dcsgames_ledger_dark_amount/,
      "the database must refuse a funded test-mode ledger entry"
    );

    // And a split must always balance, even outside test mode.
    await assert.rejects(
      () => psqlExec(dsn, `insert into public.dcsgames_ledger(ref,buyer_id,gross_minor,seller_minor,platform_minor,test_mode) values ('lgr2','b',10000,7000,1000,false);`),
      /split_balances/,
      "an unbalanced split must never be storable"
    );

    // A legitimate zero-value row still works, so the guard is not simply blocking everything.
    await psqlExec(dsn, `insert into public.dcsgames_listings(id, seller_id, title) values ('l_ok','s','Ashfall');`);
    assert.equal(await psqlScalar(dsn, "select price_minor from public.dcsgames_listings where id='l_ok';"), "0");

    // Ownership carries the same guard.
    await assert.rejects(
      () => psqlExec(dsn, `insert into public.dcsgames_ownership(id, owner_id, acquired_price_minor, test_mode) values ('o1','u',500,true);`),
      /dcsgames_ownership_dark_price/
    );
  } finally { await psqlExec(ADMIN, `drop database if exists ${db};`).catch(() => {}); }
});
