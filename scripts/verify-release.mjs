#!/usr/bin/env node
// Release gate — the single command that says whether this build is safe to
// promote. It asserts the invariants that, when they were absent, produced the
// incidents this sprint exists to close: a forged migration lineage, live money,
// a seeded "verified" creator, and an unidentifiable build.
//
//   node scripts/verify-release.mjs
//
// Every check either returns a detail string or throws. Any failure exits 1, so
// this can gate a deploy directly. It reads; it changes nothing.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadMigrations, validateChain, REQUIRED_SCHEMA_VERSION } from "../src/core/schema.mjs";
import { createMarketplaceService } from "../src/core/marketplace.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const checks = [];
const check = (name, fn) => checks.push({ name, fn });

const git = (...args) => execFileSync("git", ["-C", ROOT, ...args], { encoding: "utf8" }).trim();

// ------------------------------------------------------------ migration chain

check("the migration chain is linear and complete", async () => {
  // A gapped, reordered or duplicated chain means two databases built from the
  // same repo can end up with different schemas — the divergent-lineage problem
  // that started this. loadMigrations/validateChain are the canonical answer;
  // this script imports them rather than re-implementing the rule.
  const migrations = loadMigrations();
  if (!migrations.length) throw new Error("no migrations were found at all");
  const problems = validateChain(migrations);
  if (problems.length) throw new Error(problems.join("; "));
  const top = migrations[migrations.length - 1];
  if (top.version !== REQUIRED_SCHEMA_VERSION) {
    throw new Error(`the code requires schema v${REQUIRED_SCHEMA_VERSION} but the chain tops out at v${top.version} (${top.file})`);
  }
  return `${migrations.length} migrations, 0001..${String(top.version).padStart(4, "0")}, code requires v${REQUIRED_SCHEMA_VERSION}`;
});

check("the forensic seed cannot re-enter the migration chain", async () => {
  // The quarantined 0002 inserted invented creators with atlas_verified=true.
  // The loader refuses it by shape, not by filename, so renaming it does not
  // help. This proves the guard is still armed rather than assuming it.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dcs-release-seed-"));
  try {
    fs.writeFileSync(path.join(dir, "0001_ok.sql"), "create table if not exists t(id int);");
    fs.writeFileSync(
      path.join(dir, "0002_seed.sql"),
      "insert into public.dcsgames_users (username, atlas_verified) values ('novastudio', 'verified');"
    );
    let rejected = false;
    try { loadMigrations(dir); } catch (e) { rejected = /forensic seed/.test(String(e?.detail || e?.message || e)); }
    if (!rejected) throw new Error("loadMigrations accepted a forensic seed — the guard is no longer armed");
    return "a seed migration is refused by shape, whatever it is named";
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------------- money

check("PAYMENTS_LIVE is not enabled", async () => {
  const v = process.env.PAYMENTS_LIVE;
  if (v === "1") throw new Error("PAYMENTS_LIVE=1 — real money is reachable and this build must not be promoted");
  return `PAYMENTS_LIVE=${v === undefined ? "(unset)" : JSON.stringify(v)}`;
});

check("the marketplace is dark", async () => {
  // assertDark scans the actual stored rows, so this is a statement about the
  // data this build would ship with, not only about a flag.
  const m = createMarketplaceService(process.env);
  const r = await m.assertDark();
  if (!r.dark) throw new Error(r.problems.join("; "));
  return `no priced listing, paid acquisition or non-test ledger entry (store: ${m.dir})`;
});

// --------------------------------------------------- fabricated verification

// An INSERT that writes an atlas_verified creator. Matched by shape so a rename
// or a new table name does not slip past. Deliberately narrow enough that the
// guard's own regexes in src/core/schema.mjs are not mistaken for the thing they
// guard against.
const SEED_INSERT = /insert\s+into\s+[a-z0-9_."`]*(users|creators|principals|profiles|builders)\b[\s\S]{0,600}?atlas_verified/i;
const SCANNED = /\.(sql|mjs|mts|cjs|js|ts)$/;
// The statement the quarantined 0002 actually contained. The scan below asserts
// the detector still matches it, so this check can never rot into matching
// nothing and reporting a clean sweep.
const KNOWN_SEED = "insert into public.dcsgames_users (username, atlas_verified) values ('novastudio', 'verified');";

check("no shipped source marks a creator atlas-verified", async () => {
  // The forensic seed invented verified creators. Nothing outside forensics/ may
  // ever write that column: a verified builder has to come from a signed
  // ownership chain, not from a fixture.
  if (!SEED_INSERT.test(KNOWN_SEED)) throw new Error("the detector no longer matches the known forensic seed statement");
  const files = git("ls-files", "-z").split("\0").filter(Boolean);
  const violations = [];
  const guards = [];
  for (const rel of files) {
    if (!SCANNED.test(rel)) continue;
    if (rel.startsWith("forensics/") || rel.startsWith("node_modules/")) continue;
    let body;
    try { body = fs.readFileSync(path.join(ROOT, rel), "utf8"); } catch { continue; }
    if (!SEED_INSERT.test(body)) continue;
    // A test file is never applied to a database, and the fixtures that live
    // there exist to PROVE the loader rejects the seed. They are reported, not
    // counted as violations.
    (rel.startsWith("test/") ? guards : violations).push(rel);
  }
  if (violations.length) throw new Error(`these files insert a verified creator: ${violations.join(", ")}`);
  return `${files.filter((f) => SCANNED.test(f)).length} tracked source files scanned, 0 violations` +
    (guards.length ? ` (${guards.length} guard fixture(s) under test/: ${guards.join(", ")})` : "");
});

// ------------------------------------------------------------ build identity

check("the working tree is clean and the build is identifiable", async () => {
  // A release you cannot name is a release you cannot roll back. A dirty tree
  // means the artefact does not correspond to any commit.
  const branch = git("rev-parse", "--abbrev-ref", "HEAD");
  const sha = git("rev-parse", "HEAD");
  const dirty = git("status", "--porcelain").split("\n").filter(Boolean);
  if (dirty.length) {
    throw new Error(`${dirty.length} uncommitted change(s) — commit or stash before promoting: ${dirty.slice(0, 8).join(", ")}${dirty.length > 8 ? ", ..." : ""}`);
  }
  return `${branch} @ ${sha.slice(0, 12)} (clean)`;
});

// -------------------------------------------------------------------- report

const results = [];
for (const c of checks) {
  try { results.push({ name: c.name, ok: true, detail: await c.fn() }); }
  catch (e) { results.push({ name: c.name, ok: false, detail: String(e?.detail || e?.message || e) }); }
}

console.log(`verify-release: ${ROOT}\n`);
for (const r of results) console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.name}\n        ${r.detail}`);
const failed = results.filter((r) => !r.ok);
console.log(`\nRESULT: ${failed.length === 0 ? "PASS — safe to promote" : "FAIL — do not promote"} (${results.length - failed.length}/${results.length})`);
if (failed.length) console.log(`Blocking: ${failed.map((r) => r.name).join("; ")}`);
process.exit(failed.length === 0 ? 0 : 1);
