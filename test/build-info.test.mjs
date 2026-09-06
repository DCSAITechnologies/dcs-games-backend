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
