// The secret-scan allowlist excuses one exact literal in one file, and nothing else.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SCAN = path.resolve("scripts/secret-scan.mjs");
const LIT = "synthetic-drive-token-0123456789abcdef";
const OTHER = "a-different-literal-0123456789abcdef0123";
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");

function scan(files, entries) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dcs-scan-"));
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  }
  const list = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dcs-allow-")), "allow.json");
  fs.writeFileSync(list, JSON.stringify({ entries }));
  const r = spawnSync(process.execPath, [SCAN, root], { env: { ...process.env, DCS_SECRET_SCAN_ALLOWLIST: list }, encoding: "utf8" });
  return { code: r.status, out: r.stdout };
}
const entry = (p, literal = LIT) => ({ path: p, rule: "generic-assignment", sha256: sha(literal), reason: "synthetic" });

test("an exact path + rule + sha256 entry excuses that literal, and says so", () => {
  const r = scan({ "tests/a.test.ts": `const TOKEN = "${LIT}";\n` }, [entry("tests/a.test.ts")]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /allowlisted tests\/a\.test\.ts:1/);
  assert.match(r.out, /1 synthetic test literal\(s\) allowlisted/);
});

test("a different literal in the allowlisted file is still a finding", () => {
  const r = scan({ "tests/a.test.ts": `const TOKEN = "${LIT}";\nconst SECRET = "${OTHER}";\n` }, [entry("tests/a.test.ts")]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /tests\/a\.test\.ts:2 \[generic-assignment\]/);
});

test("the allowlisted literal in any other file is still a finding", () => {
  const r = scan({ "src/b.mjs": `const TOKEN = "${LIT}";\n` }, [entry("tests/a.test.ts")]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /src\/b\.mjs:1/);
});

test("an incomplete allowlist entry fails the scan instead of excusing anything", () => {
  const r = scan({ "tests/a.test.ts": `const TOKEN = "${LIT}";\n` }, [{ path: "tests/a.test.ts", rule: "generic-assignment", sha256: sha(LIT) }]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /allowlist entry is incomplete/);
});
