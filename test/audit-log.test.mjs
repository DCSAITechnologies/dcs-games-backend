// src/core/audit-log.mjs — append-only, hash-chained, reopen-safe.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAuditLog, verifyEntries, promptFields, lineHash, PROMPT_TEXT_CAP } from "../src/core/audit-log.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "dcs-audit-"));

test("entries chain from genesis, and a reopened log continues the same chain", () => {
  const dir = tmp();
  try {
    const a = createAuditLog({ dir });
    a.append("prompt", { actor: "u1", prompt_sha256: "x" });
    a.append("output", { actor: "u1", content_hash: "sha256:y" });
    const b = createAuditLog({ dir });                         // a restart
    assert.equal(b.describe().seq, 2);
    assert.equal(b.describe().boot_check.ok, true);
    const r = b.append("publish", { actor: "u1", action: "publish" });
    assert.equal(r.seq, 3);
    const v = b.verify();
    assert.equal(v.ok, true);
    assert.equal(v.count, 3);
    assert.equal((fs.statSync(b.file).mode & 0o777), 0o600, "the log is private to the service user");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("an edited, reordered, removed or truncated line is detected", () => {
  const dir = tmp();
  try {
    const a = createAuditLog({ dir });
    for (let i = 0; i < 4; i++) a.append("prompt", { n: i });
    const lines = fs.readFileSync(a.file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const edited = lines.map((e, i) => (i === 2 ? { ...e, n: 99 } : e));
    assert.equal(verifyEntries(edited).broken_at, 3);
    const resealed = edited.map((e, i) => (i === 2 ? { ...e, hash: lineHash(e) } : e));
    assert.equal(verifyEntries(resealed).broken_at, 4, "re-hashing the edited line breaks its successor");
    assert.equal(verifyEntries([lines[1], lines[0], lines[2], lines[3]]).ok, false);
    assert.equal(verifyEntries([lines[0], lines[2], lines[3]]).ok, false);
    const head = { seq: 4, hash: lines[3].hash };
    assert.equal(verifyEntries(lines.slice(0, 2), head).ok, false, "a self-consistent prefix fails against the head");
    assert.equal(verifyEntries(lines, head).ok, true);
    // A broken log reports at boot, and still appends from its last line.
    fs.writeFileSync(a.file, lines.slice(0, 2).map((e) => JSON.stringify(e)).join("\n") + "\n");
    const b = createAuditLog({ dir });
    assert.equal(b.describe().boot_check.ok, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a refused prompt is recorded by hash only; an accepted one is capped", () => {
  const refused = promptFields("key sk-live-123", { accepted: false });
  assert.equal(refused.prompt_text, undefined);
  assert.match(refused.prompt_sha256, /^[0-9a-f]{64}$/);
  const long = promptFields("x".repeat(PROMPT_TEXT_CAP + 10), { accepted: true });
  assert.equal(long.prompt_text.length, PROMPT_TEXT_CAP);
  assert.equal(long.prompt_text_truncated, true);
  assert.equal(long.prompt_chars, PROMPT_TEXT_CAP + 10);
});

test("unknown kinds are refused rather than logged", () => {
  const dir = tmp();
  try {
    assert.throws(() => createAuditLog({ dir }).append("gossip", {}), /unknown kind/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
