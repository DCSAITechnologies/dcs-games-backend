#!/usr/bin/env node
// Operator CLI for the canonical migration chain.
//   node scripts/migrate.mjs status   [--dsn ...]
//   node scripts/migrate.mjs up       [--dsn ...]
//   node scripts/migrate.mjs verify   [--dsn ...]
//   node scripts/migrate.mjs staging  --admin postgresql://127.0.0.1:5432/postgres --db dcs_games_staging
//
// Production safety: `up` against a DSN that is not obviously local requires
// --i-have-a-backup, so nobody migrates production by muscle memory.
import { migrate, assertSchema, currentVersion, listTables, proveReproducible, loadMigrations, validateChain } from "../src/core/schema.mjs";

const argv = process.argv.slice(2);
const cmd = argv[0] || "status";
const flag = (n, d = null) => { const i = argv.indexOf("--" + n); return i >= 0 ? (argv[i + 1] ?? true) : d; };
const dsn = flag("dsn", process.env.DATABASE_URL || process.env.DCS_PG_DSN || "postgresql://127.0.0.1:5432/dcs_games_staging");
const isLocal = /(?:@|\/\/)(127\.0\.0\.1|localhost)[:/]/.test(dsn);

try {
  if (cmd === "status") {
    const ms = loadMigrations();
    console.log("chain:", ms.map((m) => m.file).join("\n       "));
    const problems = validateChain(ms);
    console.log("chain linear:", problems.length === 0 ? "yes" : problems.join("; "));
    console.log("dsn:", dsn.replace(/:[^:@/]*@/, ":***@"));
    console.log("database version:", await currentVersion(dsn));
    console.log("tables:", (await listTables(dsn)).length);
  } else if (cmd === "up") {
    if (!isLocal && !argv.includes("--i-have-a-backup")) {
      console.error("REFUSING: this DSN is not local. Take a backup, then re-run with --i-have-a-backup.");
      process.exit(2);
    }
    const r = await migrate(dsn);
    console.log(`schema now at v${r.version} (${r.applied} applied this run)`);
  } else if (cmd === "verify") {
    console.log(JSON.stringify(await assertSchema(dsn), null, 2));
  } else if (cmd === "staging") {
    const admin = flag("admin", "postgresql://127.0.0.1:5432/postgres");
    const db = flag("db", "dcs_games_staging");
    const r = await proveReproducible(admin, db);
    console.log(`staging '${db}' rebuilt from migrations: v${r.version}, ${r.tables.length} tables`);
  } else {
    console.error("unknown command:", cmd);
    process.exit(1);
  }
} catch (e) {
  console.error("MIGRATION ERROR:", e?.detail || e?.message || e);
  process.exit(1);
}
