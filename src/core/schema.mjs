// A2 — canonical migration chain + boot-time schema assertions. PARENT-OWNED.
//
// Round-2 found two divergent schema lineages, a table the service wrote to that
// no migration declared, and no way to tell what schema a running process was
// talking to. This module is the single answer to both questions:
//   * migrate()  applies the chain in order, once, recording a checksum
//   * assertSchema()  refuses to run against a schema the code does not support
//
// It shells out to psql rather than adding a driver dependency, because the
// deployed service is intentionally zero-dep and migrations are an operator
// action, not a request path.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Errors } from "./errors.mjs";

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = path.resolve(HERE, "../../migrations");

/** The schema version this code requires. Boot fails loudly below it. */
export const REQUIRED_SCHEMA_VERSION = 11;

/** Tables the running service genuinely depends on. Missing one is fatal. */
export const REQUIRED_TABLES = [
  "dcsgames_schema_migrations",
  "dcsgames_base_worlds",
  "dcsgames_world_versions",
  "dcsgames_world_events",
  "dcsgames_internal_testers",
  "dcsgames_reports",
  "dcsgames_principals",
  "dcsgames_principal_friends",
  "dcsgames_world_plays",
  "dcsgames_listings",
  "dcsgames_ledger",
  "dcsgames_orgs",
  "dcsgames_subscriptions",
  "dcsgames_subscription_events",
  // CW5 runtime persistence. Listed so the boot assertion catches their absence:
  // two of these had never existed in any migration, and nothing noticed because
  // nothing checked.
  "dcsgames_cw5_base_worlds",
  "dcsgames_world_deltas",
  "dcsgames_world_snapshots",
];

export function loadMigrations(dir = MIGRATIONS_DIR) {
  const files = fs.readdirSync(dir)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .sort();
  return files.map((f) => {
    const m = /^(\d{4})_(.*)\.sql$/.exec(f);
    const body = fs.readFileSync(path.join(dir, f), "utf8");
    if (/insert\s+into\s+public\.dcsgames_users[\s\S]*atlas_verified/i.test(body) ||
        /atlas_verified\s*,?\s*\)?\s*values[\s\S]*'verified'/i.test(body)) {
      // Belt and braces: the quarantined forensic seed can never re-enter the chain.
      throw Errors.validation(`migration ${f} looks like the quarantined forensic seed (inserts verified creators); refusing to load`);
    }
    return {
      version: parseInt(m[1], 10),
      name: m[2],
      file: f,
      body,
      checksum: crypto.createHash("sha256").update(body).digest("hex"),
    };
  });
}

export function validateChain(migrations) {
  const problems = [];
  const seen = new Set();
  let expected = 1;
  for (const m of migrations) {
    if (seen.has(m.version)) problems.push(`duplicate migration version ${m.version}`);
    seen.add(m.version);
    if (m.version !== expected) problems.push(`gap or reorder: expected ${String(expected).padStart(4, "0")}, found ${m.file}`);
    expected = m.version + 1;
  }
  return problems;
}

// ------------------------------------------------------------------- psql I/O

function psqlArgs(dsn) {
  return ["-v", "ON_ERROR_STOP=1", "-X", "-q", "-d", dsn];
}
function psqlBin() {
  // An explicitly set PSQL_BIN that does not exist is an operator error, and
  // silently falling through to the system psql hides it — they would be told
  // about schemas, or served by a different binary than the one they named.
  if (process.env.PSQL_BIN && !fs.existsSync(process.env.PSQL_BIN)) {
    throw Object.assign(
      new Error(`PSQL_BIN is set to '${process.env.PSQL_BIN}', which does not exist. Point it at a psql binary or unset it.`),
      { code: "PSQL_NOT_FOUND" }
    );
  }
  for (const p of [process.env.PSQL_BIN, "/opt/homebrew/opt/postgresql@16/bin/psql", "/opt/homebrew/opt/libpq/bin/psql", "psql"]) {
    if (!p) continue;
    if (p === "psql" || fs.existsSync(p)) return p;
  }
  return "psql";
}

export function psqlExec(dsn, sql) {
  // psql reads the script from stdin. execFile has no stdin channel, so spawn it
  // and close the pipe — otherwise psql waits on stdin forever.
  return new Promise((resolve, reject) => {
    const p = spawn(psqlBin(), psqlArgs(dsn), { stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    // ENOENT here means psql is not in the image, which is a DEPLOYMENT
    // problem, not a schema problem. Reported as itself: the boot log used to
    // print "A2 SCHEMA ASSERTION FAILED: spawn psql ENOENT" and send whoever
    // read it looking at migrations.
    p.on("error", (e) => reject(asPsqlNotFound(e)));
    p.on("close", (code) => (code === 0 ? resolve({ stdout: out, stderr: err }) : reject(new Error(`psql exited ${code}: ${err.trim() || out.trim()}`))));
    p.stdin.end(sql);
  });
}
/** Map a missing binary to something that says so. See psqlExec. */
function asPsqlNotFound(e) {
  if (e && e.code === "ENOENT") {
    return Object.assign(new Error(
      `psql was not found (tried '${process.env.PSQL_BIN || "psql"}'). This is a MISSING BINARY, not a schema ` +
      `failure: the schema could not be checked at all. Install a postgresql client in the runtime image ` +
      `(Nixpacks: add 'postgresql' to nixPkgs), or set PSQL_BIN to its path.`
    ), { code: "PSQL_NOT_FOUND" });
  }
  return e;
}

export async function psqlScalar(dsn, sql) {
  // execFile, not spawn — so the ENOENT arrives here rather than through
  // psqlExec's handler. Mapping it in only one of the two is how a deployed
  // boot still printed "spawn psql ENOENT" under a schema-assertion heading.
  const { stdout } = await execFileAsync(psqlBin(), [...psqlArgs(dsn), "-Atc", sql], { maxBuffer: 8 * 1024 * 1024 })
    .catch((e) => { throw asPsqlNotFound(e); });
  return stdout.trim();
}

// ------------------------------------------------------------------ migrate

/**
 * Apply every unapplied migration, in order, inside a transaction each.
 * Re-running is a no-op. A migration whose file changed after being applied is
 * a hard error: the chain is append-only.
 */
export async function migrate(dsn, { dir = MIGRATIONS_DIR, log = console.log } = {}) {
  const migrations = loadMigrations(dir);
  const problems = validateChain(migrations);
  if (problems.length) throw Errors.validation("migration chain is not linear: " + problems.join("; "));

  // The ledger has to exist before it can record anything.
  await psqlExec(dsn, `
    create table if not exists public.dcsgames_schema_migrations (
      version integer primary key, name text not null, checksum text not null,
      applied_at timestamptz not null default now(), applied_by text not null default current_user);
  `);

  const appliedRaw = await psqlScalar(dsn, "select coalesce(json_agg(json_build_object('version',version,'checksum',checksum)),'[]') from public.dcsgames_schema_migrations;");
  const applied = new Map(JSON.parse(appliedRaw || "[]").map((r) => [Number(r.version), r.checksum]));

  const results = [];
  for (const m of migrations) {
    const prior = applied.get(m.version);
    if (prior) {
      if (prior !== m.checksum) {
        throw Errors.conflict(`migration ${m.file} was edited after being applied (recorded ${prior.slice(0, 12)}, file ${m.checksum.slice(0, 12)}). Migrations are append-only; add a new one.`);
      }
      results.push({ ...m, status: "already-applied" });
      continue;
    }
    log(`  applying ${m.file}`);
    await psqlExec(dsn, `begin;\n${m.body}\n\ninsert into public.dcsgames_schema_migrations(version,name,checksum) values (${m.version}, '${m.name.replace(/'/g, "''")}', '${m.checksum}') on conflict (version) do update set checksum = excluded.checksum;\ncommit;`);
    results.push({ ...m, status: "applied" });
  }
  const version = Number(await psqlScalar(dsn, "select coalesce(max(version),0) from public.dcsgames_schema_migrations;"));
  return { version, results, applied: results.filter((r) => r.status === "applied").length };
}

export async function currentVersion(dsn) {
  const v = await psqlScalar(dsn, "select coalesce(max(version),0) from public.dcsgames_schema_migrations;").catch(() => "0");
  return Number(v || 0);
}

export async function listTables(dsn) {
  const out = await psqlScalar(dsn, "select coalesce(string_agg(table_name, ','), '') from information_schema.tables where table_schema='public';");
  return out ? out.split(",") : [];
}

/**
 * Boot-time assertion. Refuses to serve against an unsupported schema rather
 * than failing later, per-request, in a way that looks like empty data.
 */
/**
 * Read the schema state through the Supabase Data API instead of psql.
 *
 * The boot-time assertion is one of the few things that must work in EVERY
 * deployed environment, and making it depend on a binary being present in the
 * runtime image makes it depend on the build system's package configuration —
 * which differs between builders and silently ignores a config written for the
 * wrong one. Measured on Railway: nixpacks.toml had no effect, psql was absent,
 * and the process exited 78 before it ever listened.
 *
 * PostgREST can answer both questions with the credential the application
 * already holds: the migration table gives the version, and the OpenAPI root
 * gives the exposed table list. Returns null when Supabase is not configured,
 * so the psql path stays the default everywhere else.
 */
async function restSchemaState(env = process.env) {
  const url = (env.SUPABASE_URL || "").replace(/\/$/, "");
  const key = env.SUPABASE_SERVICE_ROLE_KEY || "";
  if (!url || !key) return null;
  const h = { apikey: key, Authorization: "Bearer " + key };
  const get = async (path, accept) => {
    const r = await fetch(url + path, {
      headers: accept ? { ...h, Accept: accept } : h,
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) throw Errors.upstream("supabase", `HTTP ${r.status} for ${path.split("?")[0]}`);
    return await r.json();
  };
  const rows = await get("/rest/v1/dcsgames_schema_migrations?select=version&order=version.desc&limit=1");
  const root = await get("/rest/v1/", "application/openapi+json");
  const present = Object.keys(root?.paths || {}).filter((x) => x !== "/").map((x) => x.slice(1));
  return { version: Number(rows?.[0]?.version || 0), tables: present, via: "supabase-rest" };
}

export async function assertSchema(dsn, { required = REQUIRED_SCHEMA_VERSION, tables = REQUIRED_TABLES, env = process.env } = {}) {
  let version, present, via = "psql";
  try {
    version = await currentVersion(dsn);
    present = new Set(await listTables(dsn));
  } catch (e) {
    // A missing psql is a deployment fact, not an answer about the schema. If
    // the Data API can answer instead, the guard keeps working rather than
    // taking the process down for a reason unrelated to the schema.
    if (e?.code !== "PSQL_NOT_FOUND") throw e;
    const rest = await restSchemaState(env);
    if (!rest) throw e;
    version = rest.version;
    present = new Set(rest.tables);
    via = rest.via;
    console.warn(JSON.stringify({
      level: "warn", schema_check_via: via,
      detail: "psql is not available in this image, so the schema was verified through the Supabase Data API instead. Migrations still require psql.",
      ts: new Date().toISOString(),
    }));
  }
  const missing = tables.filter((t) => !present.has(t));
  const ok = version >= required && missing.length === 0;
  const report = { ok, version, required, missing, via };
  if (!ok) {
    throw Errors.notConfigured(
      `database schema (at v${version}, code requires v${required}${missing.length ? `; missing tables: ${missing.join(", ")}` : ""})`,
      { meta: report }
    );
  }
  return report;
}

/**
 * Reproducibility proof: build the schema from scratch in a throwaway database
 * and confirm it lands on the same table set and version.
 */
export async function proveReproducible(adminDsn, dbName, { dir = MIGRATIONS_DIR, allowDrop = true } = {}) {
  // A DATABASE NAME IS AN IDENTIFIER, NOT A FRAGMENT OF SQL. This argument was
  // interpolated straight into `drop database if exists ${dbName};`,
  // `create database ${dbName};` and a quoted literal in a pg_database lookup.
  // psql runs a SCRIPT, so a `;` in the name ends the statement and everything
  // after it executes as the ADMIN role — and the whole purpose of this
  // function is to DROP the database it is handed, so the blast radius is every
  // other database on the cluster:
  //
  //   node scripts/migrate.mjs staging --db='t; drop database dcs_games_prod; --'
  //
  // `--db` is read straight from argv (scripts/migrate.mjs:38). Validated here,
  // before any SQL is built and before any connection is made, because this is
  // the only place that knows the value is destined to be an identifier.
  // Postgres identifiers are at most 63 bytes.
  if (typeof dbName !== "string" || !/^[A-Za-z_][A-Za-z0-9_$]{0,62}$/.test(dbName)) {
    throw Errors.validation(
      `'${String(dbName)}' is not a valid database name. A name must start with a letter or underscore, ` +
      `contain only letters, digits, underscore or $, and be at most 63 characters — it is an identifier, not SQL.`
    );
  }
  const base = adminDsn.replace(/\/[^/]*$/, "");
  const target = `${base}/${dbName}`;
  // This DROPS the named database. The name defaults to `dcs_games_staging`
  // everywhere, so two people on one host — or two CI jobs on one runner —
  // destroy each other's staging without being asked. Callers that want a
  // throwaway should pass a unique name; `allowDrop:false` refuses instead.
  if (!allowDrop) {
    const exists = await psqlScalar(adminDsn, `select 1 from pg_database where datname = '${dbName}';`).catch(() => null);
    if (exists) {
      throw Errors.conflict(
        `database '${dbName}' already exists and allowDrop is false; ` +
        `pass a unique name for a throwaway, or drop it deliberately`
      );
    }
  }
  await psqlExec(adminDsn, `drop database if exists ${dbName};`).catch(() => {});
  await psqlExec(adminDsn, `create database ${dbName};`);
  const r = await migrate(target, { dir, log: () => {} });
  const tables = (await listTables(target)).sort();
  return { dsn: target, version: r.version, tables, applied: r.applied };
}
