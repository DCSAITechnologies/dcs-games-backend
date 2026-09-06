#!/usr/bin/env node
// Write build-info.json so the deployed instance can prove which commit it is.
// Run immediately before `railway up`; see DCS_GAMES_RAILWAY_STAGING_SETUP.md.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const git = (...a) => execFileSync("git", a, { cwd: root, encoding: "utf8" }).trim();

const dirty = git("status", "--porcelain") !== "";
const info = {
  commit: git("rev-parse", "HEAD"),
  branch: git("rev-parse", "--abbrev-ref", "HEAD"),
  built_at: new Date().toISOString(),
  dirty,
};
fs.writeFileSync(path.join(root, "build-info.json"), JSON.stringify(info, null, 2) + "\n");

if (dirty) {
  // Not fatal — staging deploys of work in progress are legitimate — but it
  // must never be reported as if it were the banked commit.
  console.warn("WARNING: worktree is dirty; this build does not match commit " + info.commit);
}
console.log(`stamped ${info.commit.slice(0, 12)} (${info.branch})${dirty ? " DIRTY" : ""}`);
