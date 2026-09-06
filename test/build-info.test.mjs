// Which commit is serving — proved, not assumed.
//
// A staging deploy verified only by "health is 200" tells you nothing about
// whether the code you banked is the code that is running. It bit us once
// already: a Railway variable change reverted the service to its GitHub-source
// build and silently discarded a `railway up` upload, and every health check
// stayed green throughout.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readBuildInfo } from "../src/core/build-info.mjs";

const root = () => fs.mkdtempSync(path.join(os.tmpdir(), "dcs-build-"));
const stamp = (dir, o) => fs.writeFileSync(path.join(dir, "build-info.json"), JSON.stringify(o));

test("a stamped build reports its commit", () => {
  const d = root();
  stamp(d, { commit: "abc123", branch: "sprint/x", built_at: "2026-09-07T00:00:00Z", dirty: false });
  const b = readBuildInfo({}, d);
  assert.equal(b.commit, "abc123");
  assert.equal(b.branch, "sprint/x");
  assert.equal(b.source, "stamp");
  assert.equal(b.dirty, false);
});

test("GATE: a dirty build is never reported as a clean commit", () => {
  const d = root();
  stamp(d, { commit: "abc123", branch: "sprint/x", dirty: true });
  const b = readBuildInfo({}, d);
  assert.equal(b.dirty, true, "a stamp taken from a dirty worktree describes no commit that exists anywhere");
});

test("Railway's injected SHA is used when there is no stamp", () => {
  const b = readBuildInfo({ RAILWAY_GIT_COMMIT_SHA: "deadbeef", RAILWAY_GIT_BRANCH: "main" }, root());
  assert.equal(b.commit, "deadbeef");
  assert.equal(b.branch, "main");
  assert.equal(b.source, "railway-git");
});

test("GATE: an unstamped build says so rather than guessing", () => {
  const b = readBuildInfo({}, root());
  assert.equal(b.commit, null, "no commit may be invented");
  assert.equal(b.source, "unknown");
  assert.match(b.note, /cannot be tied to a commit/);
});

test("a corrupt stamp degrades to unknown rather than throwing", () => {
  // /health must not 500 because a stamp file got truncated mid-write.
  const d = root();
  fs.writeFileSync(path.join(d, "build-info.json"), "{not json");
  assert.equal(readBuildInfo({}, d).source, "unknown");
});

test("a stamp with no commit is not trusted", () => {
  const d = root();
  stamp(d, { branch: "sprint/x", built_at: "2026-09-07T00:00:00Z" });
  assert.equal(readBuildInfo({}, d).source, "unknown");
});

test("an unstamped build still names its deployment", () => {
  // Railway injects RAILWAY_DEPLOYMENT_ID for every deploy including
  // `railway up`. It is not a commit, but it ties a running process to one
  // row in the deploy log, which is far better than nothing.
  const b = readBuildInfo({ RAILWAY_DEPLOYMENT_ID: "078f0774-e6b7" }, root());
  assert.equal(b.source, "unknown");
  assert.equal(b.deployment_id, "078f0774-e6b7");
  assert.ok(b.looked_in.length >= 1, "and says where it looked, so a missing stamp is diagnosable");
});

test("a stamp is found via the working directory too", () => {
  // The module's own location and the process cwd are not the same in every
  // image layout; a stamp present but looked for in the wrong place looks
  // exactly like a stamp that never shipped.
  const d = root();
  stamp(d, { commit: "cafe1234", branch: "b", dirty: false });
  const prev = process.cwd();
  process.chdir(d);
  try {
    // No explicit root, so the default pair (module root, cwd) applies.
    const b = readBuildInfo({});
    assert.equal(b.source, "stamp");
    assert.ok(b.commit, "a stamp reachable from cwd must be found");
  } finally { process.chdir(prev); }
});
