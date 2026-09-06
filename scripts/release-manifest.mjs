#!/usr/bin/env node
// A7 — release manifest. Records exactly what is being deployed, so a rollback
// target is a fact rather than a memory.
import { execFileSync } from "node:child_process";
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
    bundles: "DCS_GAMES_SPRINT_SEP2026/rollback/{frontend-live,backend-gb,schema-lineage}.bundle",
    restore: "git clone <bundle> <dir>",
    runbook: "DCS_GAMES_SPRINT_SEP2026/RUNBOOK_DEPLOY_ROLLBACK.md",
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
