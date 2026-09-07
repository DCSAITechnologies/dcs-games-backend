#!/usr/bin/env node
// A7 — release manifest. Records exactly what is being deployed, so a rollback
// target is a fact rather than a memory.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { loadMigrations, REQUIRED_SCHEMA_VERSION } from "../src/core/schema.mjs";

const GB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SITE = path.resolve(GB, "../../dcs-games-LIVE");

const git = (dir, args) => {
  try { return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim(); }
  catch { return null; }
};

/**
 * Digest of a working tree. Returns an ABSENT marker instead of throwing when
 * the directory is not there.
 *
 * It used to throw an unhandled ENOENT, which killed the whole script. That is
 * exactly the layout of the `release` job in .github/workflows/ci.yml, which
 * checks out only the backend — so `node scripts/release-manifest.mjs` there
 * crashed with a stack trace and no manifest. A manifest generator that dies
 * when one of the two trees is missing records nothing about the one that is
 * present.
 */
function treeDigest(dir, filter = () => true) {
  if (!fs.existsSync(dir)) {
    return { present: false, digest: null, files: 0, note: `ABSENT: ${dir} is not on this machine, so nothing about that tree is recorded here.` };
  }
  const files = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if ([".git", "node_modules", ".dcs-data"].includes(e.name)) continue;
      const full = path.join(d, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) walk(full);
      else if (filter(full)) files.push(full);
    }
  })(dir);
  files.sort();
  const h = crypto.createHash("sha256");
  for (const f of files) h.update(path.relative(dir, f)).update(crypto.createHash("sha256").update(fs.readFileSync(f)).digest());
  return { present: true, digest: h.digest("hex"), files: files.length };
}

/**
 * The rollback block used to be a hand-written string naming three bundle
 * files. A string cannot notice that a bundle is eight commits behind the
 * repository it is supposed to be able to restore -- which is exactly what had
 * happened to the frontend bundle, in a repository that has NO REMOTE and
 * therefore no second copy of its history anywhere.
 *
 * So this reads the rollback directory, verifies each bundle with git, and
 * records whether the CURRENT head of each repository is actually inside one.
 * Nothing here is asserted; every field is read back out of git.
 */
function bundleFacts(file) {
  const heads = [];
  const lh = spawnSync("git", ["bundle", "list-heads", file], { encoding: "utf8" });
  if (lh.status === 0) {
    for (const line of lh.stdout.trim().split("\n").filter(Boolean)) {
      const [sha, ...ref] = line.trim().split(/\s+/);
      heads.push({ sha, ref: ref.join(" ") });
    }
  }
  const v = spawnSync("git", ["bundle", "verify", file], { encoding: "utf8" });
  return {
    file: path.basename(file),
    bytes: fs.statSync(file).size,
    sha256: crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"),
    // git's own words, not ours: a bundle is only restorable on its own if it
    // "records a complete history".
    self_contained: v.status === 0 && /records a complete history/.test(String(v.stdout) + String(v.stderr)),
    heads,
  };
}

function rollbackInventory(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith(".bundle")).sort().map((f) => bundleFacts(path.join(dir, f)));
}

/** Is this repository's HEAD commit the tip of a ref inside one of the bundles? */
function preservation(label, repoDir, inventory) {
  const head = git(repoDir, ["rev-parse", "HEAD"]);
  const holder = inventory.find((b) => b.heads.some((h) => h.sha === head));
  return {
    head,
    preserved_in_a_bundle: !!holder,
    bundle: holder ? holder.file : null,
    has_git_remote: (git(repoDir, ["remote"]) || "") !== "",
    note: holder
      ? null
      : `NOT PRESERVED: no bundle in the rollback directory has ${label} HEAD ${String(head).slice(0, 7)} as a ref tip. Re-cut a bundle before relying on rollback.`,
  };
}

/**
 * What the manifest used to say here was a hand-written sentence:
 *
 *   "QUARANTINED — 0002_seed.sql replaced by an abort stub; original preserved
 *    under forensics/"
 *
 * Two of those three claims were false on 7 Sep 2026. There is no abort stub —
 * `migrations/0002` is `0002_schema_version_tracking.sql` — and there is no
 * `forensics/` directory in this repository, so nothing is "preserved" there.
 * A release manifest that describes an intended arrangement instead of the one
 * on disk is worse than one that says nothing: it is the artefact a reader
 * consults precisely when they cannot check for themselves.
 *
 * So every field below is read. The quarantine that genuinely holds is the
 * loader's, and it is exercised rather than asserted.
 */
function forensicSeedFacts() {
  const dir = path.join(GB, "migrations");
  const tracked = (git(GB, ["ls-files", "-z"]) || "").split("\0").filter(Boolean);
  const seedNamed = tracked.filter((f) => /(^|\/)\d{4}_seed\.sql$/.test(f));
  const forensicsDir = path.join(GB, "forensics");

  // Exercise the by-content guard rather than claiming it. A temporary file
  // with the seed's shape must be refused by the real loader.
  let guard = "UNKNOWN";
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), "dcs-manifest-seed-"));
  try {
    fs.writeFileSync(path.join(probe, "0001_ok.sql"), "create table if not exists t(id int);");
    fs.writeFileSync(path.join(probe, "0002_seed.sql"),
      "insert into public.dcsgames_users (username, atlas_verified) values ('novastudio', 'verified');");
    try { loadMigrations(probe); guard = "NOT ARMED — the loader accepted a forensic-seed-shaped migration"; }
    catch (e) { guard = /forensic seed/.test(String(e?.detail || e?.message || e)) ? "ARMED — refused by content, not by filename" : `UNKNOWN — the loader threw something else: ${e?.message || e}`; }
  } finally { fs.rmSync(probe, { recursive: true, force: true }); }

  return {
    status: seedNamed.length ? "PRESENT IN THE REPOSITORY — investigate before promoting" : "NOT PRESENT",
    tracked_seed_files: seedNamed,
    migrations_0002_is: fs.existsSync(dir) ? (fs.readdirSync(dir).find((f) => /^0002_/.test(f)) || null) : null,
    abort_stub_present: false,
    forensics_directory: fs.existsSync(forensicsDir) ? "present" : "ABSENT — no copy of the original seed is preserved in this repository",
    loader_guard: guard,
    never_executed_claim: "NOT VERIFIABLE FROM THIS REPOSITORY. Whether it was ever run against a database is a property of that database, not of this tree. reports/STAGING_PROOFS.md records that it was not run against staging; nothing here can speak for production.",
  };
}

const ROLLBACK_DIR = path.resolve(GB, "../../DCS_GAMES_SPRINT_SEP2026/rollback");
const rollbackBundles = rollbackInventory(ROLLBACK_DIR);

const manifest = {
  generated_at: new Date().toISOString(),
  release: process.env.DCS_RELEASE || `sprint-${new Date().toISOString().slice(0, 10)}`,
  // The environment of the shell that GENERATED this manifest. Not a statement
  // about any deployed service — for that, read /health `payments_live` on the
  // service in question.
  payments_live_in_generating_shell: process.env.PAYMENTS_LIVE === "1",
  public_launch_authorized: false,
  internal_testing_window_ends: "2026-09-30",
  backend: {
    path: "dcs-games-6month-deploy/gb",
    branch: git(GB, ["rev-parse", "--abbrev-ref", "HEAD"]),
    commit: git(GB, ["rev-parse", "HEAD"]),
    commit_short: git(GB, ["rev-parse", "--short", "HEAD"]),
    // `git` returns null when the command fails (an absent tree, say). null is
    // not "dirty" — it is "unknown", and reporting it as dirty is a claim.
    dirty: (() => { const st = git(GB, ["status", "--porcelain"]); return st === null ? null : st !== ""; })(),
    // Read back, not asserted: the string used to be a bare SHA that nothing
    // confirmed still existed in this repository.
    baselined_from_deployed: (() => {
      const tag = "preserved/deployed-e979d87";
      const sha = git(GB, ["rev-list", "-n", "1", tag]);
      return sha ? { tag, commit: sha, resolves: true } : { tag, commit: null, resolves: false, note: `NOT FOUND: the tag ${tag} does not resolve in this repository, so the pre-sprint rollback point is not reachable from here.` };
    })(),
    tree: treeDigest(GB, (f) => /\.(mts|mjs|ts|json|sql)$/.test(f)),
  },
  frontend: {
    path: "dcs-games-LIVE",
    branch: git(SITE, ["rev-parse", "--abbrev-ref", "HEAD"]),
    commit: git(SITE, ["rev-parse", "HEAD"]),
    dirty: (() => { const st = git(SITE, ["status", "--porcelain"]); return st === null ? null : st !== ""; })(),
    cloudflare_project: "dcs-games",
    tree: treeDigest(SITE, (f) => /\.(html|js|css)$/.test(f)),
  },
  schema: {
    required_version: REQUIRED_SCHEMA_VERSION,
    chain: loadMigrations().map((m) => ({ version: m.version, file: m.file, checksum: m.checksum.slice(0, 16) })),
    forensic_seed: forensicSeedFacts(),
  },
  rollback: {
    directory: "DCS_GAMES_SPRINT_SEP2026/rollback",
    bundles_glob: "DCS_GAMES_SPRINT_SEP2026/rollback/*.bundle",
    restore: "git clone <bundle> <dir>   # step-by-step: rollback/RESTORE_FRONTEND_FROM_BUNDLE.md",
    runbook: "DCS_GAMES_SPRINT_SEP2026/RUNBOOK_DEPLOY_ROLLBACK.md",
    bundles: rollbackBundles,
    preservation: {
      backend: preservation("the backend", GB, rollbackBundles),
      frontend: preservation("the frontend", SITE, rollbackBundles),
    },
  },
};

const SPRINT = path.resolve(GB, "../../DCS_GAMES_SPRINT_SEP2026");
const out = path.join(SPRINT, "RELEASE_MANIFEST.json");
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(manifest, null, 2) + "\n");

// The estate-root documents are the source of truth and live where the handoff
// asks for them, but that directory is not a repository. Snapshot them into the
// versioned sprint directory so no deliverable exists only on one laptop --
// the same exposure A0 fixed for the frontend.
const ESTATE = path.resolve(GB, "../..");
const rootDocs = [
  "00_PUBLIC_LAUNCH_BLOCKERS_AND_APPROVALS.md",
  "DCS_GAMES_CONTINUOUS_STATUS.md",
  "DCS_GAMES_ESTATE_PASSPORT.md",
  "DCS_GAMES_EXECUTION_OWNERSHIP.md",
  // Added 7 Sep 2026. It is the launch-blocker list every other document defers
  // to, and it existed only at the estate root — which is not a repository. That
  // is the same exposure A0 closed for the frontend, and leaving the one document
  // that says what is NOT allowed to ship on a single laptop is the version of it
  // that matters most.
  "DCS_GAMES_LAUNCH_REQUIREMENTS.md",
];
const snapDir = path.join(SPRINT, "estate-root-snapshot");
fs.mkdirSync(snapDir, { recursive: true });
const snapped = [];
for (const d of rootDocs) {
  const src = path.join(ESTATE, d);
  if (!fs.existsSync(src)) continue;
  fs.copyFileSync(src, path.join(snapDir, d));
  snapped.push(d);
}
fs.writeFileSync(path.join(snapDir, "README.md"),
  "# Snapshot of the estate-root documents\n\n" +
  "These are COPIES. The source of truth is the estate root, where the handoff\n" +
  "asks for them; that directory is not a repository, so they are snapshotted here\n" +
  "by `scripts/release-manifest.mjs` on every release checkpoint.\n\n" +
  "Snapshotted " + new Date().toISOString() + ":\n" +
  snapped.map((d) => "- " + d).join("\n") + "\n");
manifest.estate_root_documents = snapped;
fs.writeFileSync(out, JSON.stringify(manifest, null, 2) + "\n");
console.log(JSON.stringify(manifest, null, 2));
console.error(`\nwritten: ${out}`);

// A manifest nobody reads the warnings out of is a manifest that documents a
// gap instead of closing it. Say it on stderr, where a release operator sees it.
for (const [label, p] of Object.entries(manifest.rollback.preservation)) {
  if (!p.preserved_in_a_bundle) console.error(`WARNING: ${p.note}`);
  if (!p.has_git_remote) console.error(`WARNING: the ${label} repository has NO GIT REMOTE. Its history exists only on this machine plus whatever bundle is in ${manifest.rollback.directory}. Copy that directory off this machine.`);
}
