// Every table the code names must exist, or be a recorded decision.
//
// Three tables are referenced in src/ and created by no migration:
// dcsgames_ts_audit, dcsgames_payout_kyc and dcsgames_economy_ledger. All three
// sit behind paths that cannot run today — the T&S repository is constructed
// in-memory at server.mts, and the CW6 economy router is built with no database
// client at all — so nothing has ever tried to write to them.
//
// Creating tables for code that cannot run would be worse than not having them:
// it would suggest a capability exists. What matters is that the gap is a
// DECISION on the record, so that whoever enables one of those paths discovers
// the missing table here rather than from a 400 in production. The safety
// reports table taught this lesson expensively — writes failed for days behind
// a degraded flag nobody read.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const GB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Table names created anywhere in the migration chain. */
function tablesInMigrations() {
  const dir = path.join(GB, "migrations");
  const found = new Set();
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".sql"))) {
    const sql = fs.readFileSync(path.join(dir, f), "utf8");
    for (const m of sql.matchAll(/create table (?:if not exists )?(?:public\.)?([a-z0-9_]+)/gi)) {
      found.add(m[1].toLowerCase());
    }
  }
  return found;
}

/** Table names the application code addresses, with where it does it. */
function tablesInCode() {
  const found = new Map();
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.(mjs|ts|mts)$/.test(e.name)) continue;
      const src = fs.readFileSync(p, "utf8");
      // `.from("table")` (supabase-js) and `/rest/v1/table` (raw PostgREST).
      for (const m of src.matchAll(/\.from\(\s*["'`](dcsgames_[a-z0-9_]+)["'`]/g)) {
        found.set(m[1], path.relative(GB, p));
      }
      for (const m of src.matchAll(/rest\/v1\/(dcsgames_[a-z0-9_]+)/g)) {
        found.set(m[1], path.relative(GB, p));
      }
    }
  };
  walk(path.join(GB, "src"));
  const server = fs.readFileSync(path.join(GB, "server.mts"), "utf8");
  for (const m of server.matchAll(/\.from\(\s*["'`](dcsgames_[a-z0-9_]+)["'`]/g)) found.set(m[1], "server.mts");
  for (const m of server.matchAll(/rest\/v1\/(dcsgames_[a-z0-9_]+)/g)) found.set(m[1], "server.mts");
  return found;
}

/**
 * Tables referenced by code that CANNOT RUN on this deployment, and why.
 *
 * Each entry is a promise that the path is unreachable. If one becomes
 * reachable, the table has to be created first — and this list is where that is
 * discovered, rather than from a failed write behind a degraded flag.
 */
const UNREACHABLE_BY_DESIGN = {
  dcsgames_ts_audit:
    "the legacy T&S repository is constructed in-memory (server.mts passes db:{mode:'memory'}), so no Supabase write is attempted",
  dcsgames_payout_kyc:
    "payouts are dark; the KYC shell never contacts a provider, and the CW6 economy router that also reads it is built with no database client",
  dcsgames_economy_ledger:
    "the CW6 economy router is retired and constructed with no database client, so its ledger writes are unreachable by construction",
};

test("SCHEMA GATE: every table the code names is created by a migration, or declared unreachable", () => {
  const created = tablesInMigrations();
  const used = tablesInCode();
  assert.ok(used.size > 5, `expected to find the table references, found ${used.size}`);

  const ghosts = [];
  for (const [table, where] of used) {
    if (created.has(table)) continue;
    if (UNREACHABLE_BY_DESIGN[table]) continue;
    ghosts.push(`${table} (${where}) — no migration creates it`);
  }
  assert.deepEqual(ghosts.sort(), [],
    `these tables are addressed by code and exist nowhere:\n  ${ghosts.join("\n  ")}\n` +
    `Either add a migration, or record why the path cannot run in UNREACHABLE_BY_DESIGN.`);
});

test("SCHEMA GATE: nothing is excused that the migrations actually create", () => {
  // The opposite drift: an excuse left behind after the table was added reads
  // as "this cannot run" about something that now can.
  const created = tablesInMigrations();
  const stale = Object.keys(UNREACHABLE_BY_DESIGN).filter((t) => created.has(t));
  assert.deepEqual(stale, [],
    `these are excused as unreachable but a migration creates them, so the excuse is stale: ${stale.join(", ")}`);
});

test("SCHEMA GATE: every excuse says why, in terms someone can act on", () => {
  for (const [table, why] of Object.entries(UNREACHABLE_BY_DESIGN)) {
    assert.ok(why.length > 40, `${table}'s reason is too thin to be useful: "${why}"`);
  }
});
