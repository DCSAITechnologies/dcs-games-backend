// Migration 0014 (World Memory v2) — the staging rehearsal, run locally.
//
// A dedicated, throwaway Postgres cluster stands in for a copy of staging:
// the Supabase roles exist (service_role, anon, authenticated), the chain is
// applied to v13 exactly as staging has it, and realistic rows are written
// BEFORE 0014 arrives. Then:
//   FORWARD   0014 applies; every pre-existing row is byte-identical; the new
//             columns are null on old rows; the new tables exist, are empty,
//             have RLS on and give the browser roles nothing.
//   BEHAVIOUR the insert-only trigger, the parent and kind checks, and the
//             widened events check do what the header says.
//   IDEMPOTENT migrate() re-run applies nothing, and the raw file re-applied
//             outside the ledger (a partial manual apply) is harmless.
//   RESTART   the Postgres server is stopped and started; schema and rows
//             survive; the API boots against it, asserts v14 and reports
//             ready; the same API refuses to boot against a v13 database.
//
// Skips (never fails) when no Postgres server binaries are installed.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  loadMigrations, migrate, assertSchema, psqlExec, psqlScalar, MIGRATIONS_DIR, REQUIRED_SCHEMA_VERSION,
} from "../src/core/schema.mjs";

const GB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PG_BIN = ["/opt/homebrew/opt/postgresql@17/bin", "/opt/homebrew/opt/postgresql@16/bin", "/usr/lib/postgresql/17/bin", "/usr/lib/postgresql/16/bin"]
  .find((d) => fs.existsSync(path.join(d, "initdb")) && fs.existsSync(path.join(d, "pg_ctl")));
const skip = PG_BIN ? false : "no Postgres server binaries (initdb/pg_ctl) installed";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "dcs-m14-"));
const PGDATA = path.join(ROOT, "pgdata");
const PORT = 55400 + Math.floor(Math.random() * 500);
const ADMIN = `postgresql://postgres@127.0.0.1:${PORT}/postgres`;
const dsn = (db) => `postgresql://postgres@127.0.0.1:${PORT}/${db}`;
const STAGING = "staging_copy";
const V13 = "at_v13";

const pgctl = (...args) => execFileSync(path.join(PG_BIN, "pg_ctl"), ["-D", PGDATA, ...args], { stdio: "pipe", timeout: 60000 });
const startPg = () => pgctl("-o", `-p ${PORT} -k ${ROOT} -c listen_addresses=127.0.0.1 -c fsync=on`, "-l", path.join(ROOT, "pg.log"), "-w", "start");
const stopPg = () => pgctl("-m", "fast", "-w", "stop");

/** The chain as far as 0013, in its own directory: what staging runs today. */
function chainTo(version) {
  const dir = fs.mkdtempSync(path.join(ROOT, `chain${version}-`));
  for (const m of loadMigrations()) if (m.version <= version) fs.copyFileSync(path.join(MIGRATIONS_DIR, m.file), path.join(dir, m.file));
  return dir;
}
const q = (db, sql) => psqlScalar(dsn(db), sql);

// Row fingerprints over the ORIGINAL columns only, ordered, so "unchanged"
// means byte-identical rather than "same count".
const FP = {
  base_worlds: "select md5(coalesce(string_agg(world_id||'|'||coalesce(owner_id,'')||'|'||state||'|'||version||'|'||manifest::text||'|'||manifest_hash||'|'||created_at::text, E'\\n' order by world_id),'')) from public.dcsgames_base_worlds",
  versions: "select md5(coalesce(string_agg(world_id||'|'||version||'|'||manifest::text||'|'||manifest_hash||'|'||coalesce(label,'')||'|'||coalesce(created_by,'')||'|'||created_at::text, E'\\n' order by world_id, version),'')) from public.dcsgames_world_versions",
  events: "select md5(coalesce(string_agg(id||'|'||world_id||'|'||kind||'|'||summary||'|'||occurred_at::text, E'\\n' order by id),'')) from public.dcsgames_world_events",
};
let before14 = {};

const NEW_TABLES = [
  "dcsgames_world_patches", "dcsgames_world_manifest_snapshots", "dcsgames_world_specs",
  "dcsgames_world_player_state", "dcsgames_world_companion_context", "dcsgames_world_memory_log",
  "dcsgames_world_asset_identities", "dcsgames_world_lineage",
];

before(async () => {
  if (skip) return;
  execFileSync(path.join(PG_BIN, "initdb"), ["-D", PGDATA, "-U", "postgres", "--auth=trust", "-E", "UTF8", "--no-locale"], { stdio: "pipe", timeout: 120000 });
  startPg();
  // Supabase's roles, so 0010's grants and 0014's access block run their real branch.
  await psqlExec(ADMIN, "create role service_role nologin; create role anon nologin; create role authenticated nologin;");
  await psqlExec(ADMIN, `create database ${STAGING}; create database ${V13};`);
  const c13 = chainTo(13);
  for (const db of [STAGING, V13]) {
    const r = await migrate(dsn(db), { dir: c13, log: () => {} });
    assert.equal(r.version, 13);
  }
  // Realistic pre-0014 content: two worlds, a published one with three
  // versions, a draft, and a chronicle including the legacy 'rollback' kind.
  const m = (t) => JSON.stringify({ manifest_version: "3.0.0", meta: { title: t }, zones: [{ id: "z1" }] }).replace(/'/g, "''");
  await psqlExec(dsn(STAGING), `
    insert into public.dcsgames_base_worlds(world_id, owner_id, title, state, version, manifest, manifest_hash, manifest_version)
      values ('w3_pub', 'u-a', 'Harbour', 'published', 3, '${m("Harbour v3")}', 'h3', '3.0.0'),
             ('w3_draft', 'u-b', 'Mill', 'draft', 1, '${m("Mill")}', 'hm1', '3.0.0');
    insert into public.dcsgames_world_versions(world_id, version, manifest, manifest_hash, label, created_by) values
      ('w3_pub', 1, '${m("Harbour v1")}', 'h1', 'generated', 'u-a'),
      ('w3_pub', 2, '${m("Harbour v2")}', 'h2', 'add a lighthouse', 'u-a'),
      ('w3_pub', 3, '${m("Harbour v3")}', 'h3', 'rollback to v1', 'u-a'),
      ('w3_draft', 1, '${m("Mill")}', 'hm1', 'generated', 'u-b');
    insert into public.dcsgames_world_events(world_id, world_version, kind, summary, actor_id) values
      ('w3_pub', 1, 'created', 'generated', 'u-a'),
      ('w3_pub', 3, 'rollback', 'rolled back to v1', 'u-a'),
      ('w3_draft', 1, 'created', 'generated', 'u-b');
  `);
  for (const [k, sql] of Object.entries(FP)) before14[k] = await q(STAGING, sql);
});
after(() => {
  if (skip) return;
  try { stopPg(); } catch { /* already down */ }
  fs.rmSync(ROOT, { recursive: true, force: true });
});

test("0014 is in the chain, is the version the code requires, and rewrites no existing row", { skip: false }, () => {
  const ms = loadMigrations();
  const m14 = ms.find((m) => m.version === 14);
  assert.ok(m14, "migrations/0014_world_memory_v2.sql must be in the chain");
  assert.equal(REQUIRED_SCHEMA_VERSION, 14);
  const sql = m14.body.replace(/--.*$/gm, "");
  assert.doesNotMatch(sql, /\bupdate\s+public\./i, "0014 must not UPDATE existing rows");
  assert.doesNotMatch(sql, /\bdelete\s+from\b/i, "0014 must not DELETE rows");
  assert.doesNotMatch(sql, /\bdrop\s+table\b/i, "0014 must not drop a table");
  assert.doesNotMatch(sql, /\balter\s+column\b/i, "0014 must not change an existing column");
  assert.doesNotMatch(sql, /\bbegin\s*;|\bcommit\s*;/i, "migrate() owns the transaction");
});

test("FORWARD: 0014 applies to the staging copy and every pre-existing row is byte-identical", { skip }, async () => {
  const r = await migrate(dsn(STAGING), { log: () => {} });
  assert.equal(r.version, 14);
  assert.deepEqual(r.results.filter((x) => x.status === "applied").map((x) => x.version), [14]);
  for (const [k, sql] of Object.entries(FP)) assert.equal(await q(STAGING, sql), before14[k], `${k} changed under 0014`);
  assert.equal(await q(STAGING, "select count(*) from public.dcsgames_world_versions where version_hash is not null or kind is not null or state is not null or parent_version is not null"), "0", "old rows gain NULL chain columns, nothing invented");
  assert.equal(await q(STAGING, "select count(*) from public.dcsgames_world_versions where snapshot and patch_ids = '[]'::jsonb"), "4", "defaulted columns take their constant default");
  for (const t of NEW_TABLES) {
    assert.equal(await q(STAGING, `select count(*) from public.${t}`), "0", `${t} exists and is empty`);
    assert.equal(await q(STAGING, `select relrowsecurity from pg_class where oid = 'public.${t}'::regclass`), "t", `${t} has RLS on`);
    for (const role of ["anon", "authenticated"]) {
      assert.equal(await q(STAGING, `select has_table_privilege('${role}', 'public.${t}', 'select')`), "f", `${role} can read ${t}`);
    }
    assert.equal(await q(STAGING, `select has_table_privilege('service_role', 'public.${t}', 'insert')`), "t", `service_role cannot write ${t}`);
  }
  const s = await assertSchema(dsn(STAGING));
  assert.equal(s.ok, true);
  assert.equal(s.version, 14);
});

test("BEHAVIOUR: versions are insert-only; parent and kind checks hold; 'rolled_back' is now accepted", { skip }, async () => {
  const D = dsn(STAGING);
  await psqlExec(D, `insert into public.dcsgames_world_versions(world_id, version, manifest, manifest_hash, memory_version, parent_version, parent_hash, version_hash, kind)
    values ('w3_pub', 4, '{"meta":{}}', 'h4', '2', 3, 'ph3', 'vh4', 'edit');`);
  await assert.rejects(psqlExec(D, "update public.dcsgames_world_versions set label = 'x' where world_id = 'w3_pub' and version = 1;"), /immutable/);
  await assert.rejects(psqlExec(D, "delete from public.dcsgames_world_versions where world_id = 'w3_draft';"), /immutable/);
  await assert.rejects(psqlExec(D, `insert into public.dcsgames_world_versions(world_id, version, manifest, manifest_hash, parent_version) values ('w3_pub', 6, '{}', 'h6', 2);`), /parent_ck/);
  await assert.rejects(psqlExec(D, `insert into public.dcsgames_world_versions(world_id, version, manifest, manifest_hash, kind) values ('w3_pub', 7, '{}', 'h7', 'teleport');`), /kind_ck/);
  await assert.rejects(psqlExec(D, `insert into public.dcsgames_world_versions(world_id, version, manifest, manifest_hash, version_hash) values ('w3_pub', 8, '{}', 'h8', 'vh4');`), /vhash_uq|duplicate key/);
  await psqlExec(D, "insert into public.dcsgames_world_events(world_id, world_version, kind, summary) values ('w3_pub', 4, 'rolled_back', 'restored v1 as v4');");
  await assert.rejects(psqlExec(D, "insert into public.dcsgames_world_events(world_id, kind, summary) values ('w3_pub', 'vanished', 'x');"), /kind_check/);
  // The unchanged rows are still unchanged after all of that.
  assert.equal(await q(STAGING, FP.base_worlds), before14.base_worlds);
});

test("IDEMPOTENT: migrate() re-run applies nothing; the raw file re-applied outside the ledger is harmless", { skip }, async () => {
  const again = await migrate(dsn(STAGING), { log: () => {} });
  assert.equal(again.applied, 0);
  const body = fs.readFileSync(path.join(MIGRATIONS_DIR, "0014_world_memory_v2.sql"), "utf8");
  await psqlExec(dsn(STAGING), `begin;\n${body}\ncommit;`);
  assert.equal(await q(STAGING, "select count(*) from public.dcsgames_world_versions"), "5");
  assert.equal(await q(STAGING, "select count(*) from public.dcsgames_schema_migrations where version = 14"), "1");
});

async function bootApi(db, extraEnv = {}) {
  const port = 9800 + Math.floor(Math.random() * 150);
  const data = fs.mkdtempSync(path.join(ROOT, "api-"));
  const proc = spawn(process.execPath, ["--import", "tsx", path.join(GB, "server.mts")], {
    cwd: GB,
    env: {
      ...process.env, PORT: String(port), DCS_AUTH_SECRET: crypto.randomBytes(16).toString("hex"), DCS_DATA_DIR: data,
      DATABASE_URL: dsn(db), SUPABASE_URL: "", SUPABASE_SERVICE_ROLE_KEY: "", DCS_ALLOW_SCHEMA_DRIFT: "",
      DCS_PROVIDERS_OFFLINE: "1", CEREBRAS_API_KEY: "", CEREBRAS_API_KEY_1: "", CEREBRAS_API_KEY_2: "",
      DCS_INTERNAL_TESTERS: "tester@dcsai.ai", ATLAS_PRIVATE_KEY: crypto.randomBytes(32).toString("base64"), NODE_ENV: "test",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let err = "";
  proc.stderr.on("data", (d) => { err += d; });
  proc.stdout.on("data", () => {});
  const exited = new Promise((r) => proc.once("exit", (code) => r(code)));
  for (let i = 0; i < 200; i++) {
    const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r(undefined), 100))]);
    if (code !== undefined) return { exitCode: code, err };
    try { const r = await fetch(`http://127.0.0.1:${port}/health`); if (r.ok) return { proc, base: `http://127.0.0.1:${port}`, exited }; } catch { /* not yet */ }
  }
  proc.kill("SIGKILL");
  throw new Error("API did not come up: " + err.slice(-400));
}

test("RESTART: Postgres stops and starts; schema and rows survive; the API asserts v14 and is ready", { skip }, async () => {
  const rowsBefore = await q(STAGING, "select md5(string_agg(world_id||version||coalesce(version_hash,''), ',' order by world_id, version)) from public.dcsgames_world_versions");
  stopPg();
  await assert.rejects(q(STAGING, "select 1"), "the server really was down");
  startPg();
  assert.equal(await q(STAGING, "select coalesce(max(version),0) from public.dcsgames_schema_migrations"), "14");
  assert.equal(await q(STAGING, "select md5(string_agg(world_id||version||coalesce(version_hash,''), ',' order by world_id, version)) from public.dcsgames_world_versions"), rowsBefore);
  assert.equal(await q(STAGING, FP.events + " where id <= 3"), before14.events);

  const api = await bootApi(STAGING);
  assert.ok(api.proc, "the API must boot against a v14 database: " + (api.err || "").slice(-300));
  try {
    const h = await (await fetch(api.base + "/health")).json();
    assert.equal(h.schema_assertion.checked, true);
    assert.equal(h.schema_assertion.ok, true);
    assert.equal(h.schema_assertion.version, 14);
    const r = await fetch(api.base + "/ready");
    const ready = await r.json();
    assert.equal(r.status, 200, JSON.stringify(ready.failing));
    assert.equal(ready.checks.find((c) => c.name === "schema_version").ok, true);
  } finally { api.proc.kill("SIGKILL"); await api.exited; }
});

test("FORWARD-ONLY: this build refuses to serve a database still at v13", { skip }, async () => {
  const api = await bootApi(V13);
  if (api.proc) { api.proc.kill("SIGKILL"); await api.exited; }
  assert.equal(api.exitCode, 78, "a v13 database must stop the process (EX_CONFIG), not look like empty data");
  assert.match(api.err, /SCHEMA ASSERTION FAILED/);
});
