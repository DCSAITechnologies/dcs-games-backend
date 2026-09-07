#!/usr/bin/env node
// Every external ref CI pins must actually exist.
//
// The netcode anti-cheat job pinned 524a7f61c373…, which is on no branch of
// its repository. `git fetch` answers "upload-pack: not our ref", so the
// checkout could never succeed and the gate had never run — a job whose own
// comment explains at length why a gate that cannot fail is not a gate.
//
// A pin is the right idea; a pin nobody verifies is how it goes wrong. This
// resolves each one against the remote and says which are real.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const GB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const wf = path.join(GB, ".github", "workflows", "ci.yml");
const src = fs.readFileSync(wf, "utf8");

// `repository: owner/name` followed (within the same step) by `ref: <sha>`.
const pins = [];
const lines = src.split("\n");
for (let i = 0; i < lines.length; i++) {
  const repo = /^\s*repository:\s*(\S+)\s*$/.exec(lines[i]);
  if (!repo) continue;
  for (let j = i + 1; j < Math.min(i + 25, lines.length); j++) {
    const ref = /^\s*ref:\s*([0-9a-f]{7,40})\s*$/.exec(lines[j]);
    if (ref) { pins.push({ repo: repo[1], ref: ref[1], line: j + 1 }); break; }
    if (/^\s*-\s+(uses|name):/.test(lines[j])) break;   // next step; this one has no pin
  }
}

if (!pins.length) {
  console.error("no pinned external refs found in .github/workflows/ci.yml — has the format changed?");
  process.exit(2);
}

let bad = 0;
for (const p of pins) {
  const url = `https://github.com/${p.repo}.git`;
  let exists = false;
  try {
    // ls-remote resolves a SHA only if it is advertised; fetch is the reliable
    // test for an arbitrary commit, so try the cheap one first and fall back.
    const out = execFileSync("git", ["ls-remote", url, p.ref], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    exists = out.trim() !== "";
    if (!exists) {
      execFileSync("git", ["-c", "protocol.version=2", "fetch", "--depth=1", "--dry-run", url, p.ref],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      exists = true;
    }
  } catch { exists = false; }

  console.log(`${exists ? "OK  " : "DEAD"}  ${p.repo}@${p.ref.slice(0, 12)}  (ci.yml:${p.line})`);
  if (!exists) bad++;
}

if (bad) {
  console.error(`\n${bad} pinned ref(s) do not exist. That job cannot check out, so its gate never runs.`);
  process.exit(1);
}
console.log(`\n${pins.length} pinned ref(s) all resolve.`);
