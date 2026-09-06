#!/usr/bin/env node
// A7 — release manifest. Records exactly what is being deployed, so a rollback
// target is a fact rather than a memory.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
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

function treeDigest(dir, filter = () => true) {
  const files = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if ([".git", "node_modules", ".dcs-data"].includes(e.name)) continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (filter(full)) files.push(full);
    }
  })(dir);
  files.sort();
  const h = crypto.createHash("sha256");
  for (const f of files) h.update(path.relative(dir, f)).update(crypto.createHash("sha256").update(fs.readFileSync(f)).digest());
  return { digest: h.digest("hex"), files: files.length };
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

const ROLLBACK_DIR = path.resolve(GB, "../../DCS_GAMES_SPRINT_SEP2026/rollback");
const rollbackBundles = rollbackInventory(ROLLBACK_DIR);

const manifest = {
  generated_at: new Date().toISOString(),
  release: process.env.DCS_RELEASE || `sprint-${new Date().toISOString().slice(0, 10)}`,
  payments_live: process.env.PAYMENTS_LIVE === "1",
  public_launch_authorized: false,
  internal_testing_window_ends: "2026-09-30",
  backend: {
    path: "dcs-games-6month-deploy/gb",
    branch: git(GB, ["rev-parse", "--abbrev-ref", "HEAD"]),
    commit: git(GB, ["rev-parse", "HEAD"]),
    commit_short: git(GB, ["rev-parse", "--short", "HEAD"]),
    dirty: git(GB, ["status", "--porcelain"]) !== "",
    baselined_from_deployed: "e979d87",
    tree: treeDigest(GB, (f) => /\.(mts|mjs|ts|json|sql)$/.test(f)),
  },
  frontend: {
    path: "dcs-games-LIVE",
    branch: git(SITE, ["rev-parse", "--abbrev-ref", "HEAD"]),
    commit: git(SITE, ["rev-parse", "HEAD"]),
    dirty: git(SITE, ["status", "--porcelain"]) !== "",
    cloudflare_project: "dcs-games",
    tree: treeDigest(SITE, (f) => /\.(html|js|css)$/.test(f)),
  },
  schema: {
    required_version: REQUIRED_SCHEMA_VERSION,
    chain: loadMigrations().map((m) => ({ version: m.version, file: m.file, checksum: m.checksum.slice(0, 16) })),
    forensic_seed: "QUARANTINED — 0002_seed.sql replaced by an abort stub; original preserved under forensics/",
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
