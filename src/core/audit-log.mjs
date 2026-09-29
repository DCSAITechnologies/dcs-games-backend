// Append-only, hash-chained audit log for the internal staging preview.
//
// What it records, and why each kind exists:
//   prompt   every creator prompt that reached a generating or editing route,
//            refused or not. Refused prompts keep only their hash: the guard
//            refuses credential-bearing text, and writing that text to disk
//            would store the very secret it refused.
//   output   the hash of what a generating or editing route actually stored,
//            so a prompt can be joined to the content it produced.
//   publish  every publish-control action (publish, refusal, staging
//            rollback, and a published world returned to draft by an edit).
//
// APPEND-ONLY, and provably so:
//   * the file is only ever opened with the "a" flag; no code path rewrites it;
//   * every line carries `prev_hash` and `hash = sha256(canonical line without
//     hash)`, so an edited, removed or reordered line breaks the chain at the
//     next line;
//   * a sidecar head file records the last seq/hash. A log truncated back to
//     an earlier, still self-consistent prefix fails against it.
// What it does NOT protect against: someone with write access to BOTH files
// rewriting the whole chain. That needs an external anchor (the same limit
// World Memory v2 documents), and is a production-canary item, not preview.
//
// Writes are synchronous (appendFileSync + fsync), so two requests in one
// process can never interleave a line, and an acknowledged entry is on disk.
// Single process only, like every other file store on this estate.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const AUDIT_KINDS = Object.freeze(["prompt", "output", "publish"]);
export const PROMPT_TEXT_CAP = 2000;
const GENESIS = "0".repeat(64);

function canonical(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  return "{" + Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => JSON.stringify(k) + ":" + canonical(v[k])).join(",") + "}";
}
export const sha256 = (s) => crypto.createHash("sha256").update(String(s), "utf8").digest("hex");
export function lineHash(entry) {
  const { hash: _h, ...rest } = entry;
  return sha256(canonical(rest));
}

/** Verify a sequence of parsed entries. Pure. */
export function verifyEntries(entries, head = null) {
  let prev = GENESIS;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (!e || typeof e !== "object") return { ok: false, count: i, broken_at: i + 1, reason: "unparseable line" };
    if (e.seq !== i + 1) return { ok: false, count: i, broken_at: i + 1, reason: `seq ${e.seq} where ${i + 1} was expected` };
    if (e.prev_hash !== prev) return { ok: false, count: i, broken_at: i + 1, reason: "prev_hash does not match the previous line" };
    if (lineHash(e) !== e.hash) return { ok: false, count: i, broken_at: i + 1, reason: "line hash does not match its content" };
    prev = e.hash;
  }
  if (head && (head.seq > entries.length || (head.seq > 0 && entries[head.seq - 1]?.hash !== head.hash))) {
    return { ok: false, count: entries.length, broken_at: Math.min(head.seq, entries.length + 1), reason: "the log is shorter than, or diverges from, its recorded head (truncated or rewritten)" };
  }
  return { ok: true, count: entries.length, head_hash: prev };
}

export function createAuditLog({ dir, now = () => new Date().toISOString() } = {}) {
  if (!dir) throw new Error("audit log: dir is required");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, "audit.jsonl");
  const headFile = path.join(dir, "audit.head.json");

  function readAll() {
    if (!fs.existsSync(file)) return [];
    const text = fs.readFileSync(file, "utf8");
    return text.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } });
  }
  function readHead() {
    try { return JSON.parse(fs.readFileSync(headFile, "utf8")); } catch { return null; }
  }

  // Boot: establish the head from the file itself, and check it against the
  // sidecar. A broken chain is REPORTED (readiness fails on it) and appends
  // continue from the last good line's hash, so a later verify still names the
  // first break rather than hiding it under new entries.
  let entries = readAll();
  let bootCheck = verifyEntries(entries, readHead());
  let seq = entries.length;
  let prev = entries.length ? (entries.at(-1)?.hash || GENESIS) : GENESIS;
  entries = null;   // not kept in memory; verify() re-reads the file

  function append(kind, fields = {}) {
    if (!AUDIT_KINDS.includes(kind)) throw new Error(`audit log: unknown kind ${kind}`);
    const entry = { seq: seq + 1, at: now(), kind, ...fields, prev_hash: prev };
    entry.hash = lineHash(entry);
    const fd = fs.openSync(file, "a", 0o600);
    try {
      fs.writeSync(fd, JSON.stringify(entry) + "\n");
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    seq = entry.seq; prev = entry.hash;
    const tmp = headFile + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ seq, hash: prev, at: entry.at }), { mode: 0o600 });
    fs.renameSync(tmp, headFile);
    return { seq: entry.seq, hash: entry.hash };
  }

  return {
    file,
    append,
    /** Re-read the file and verify the whole chain against the recorded head. */
    verify() { return verifyEntries(readAll(), readHead()); },
    /** The newest n entries, newest last. */
    tail(n = 50) { const all = readAll(); return all.slice(Math.max(0, all.length - Math.max(1, Math.min(500, n)))); },
    describe() { return { kind: "file-jsonl-hash-chained", seq, head_hash: prev, boot_check: bootCheck }; },
  };
}

/** The fields recorded for a prompt. Text only when the guard accepted it. */
export function promptFields(text, { accepted }) {
  const s = typeof text === "string" ? text : JSON.stringify(text ?? null);
  return {
    prompt_sha256: sha256(s),
    prompt_chars: s.length,
    prompt_text: accepted ? s.slice(0, PROMPT_TEXT_CAP) : undefined,
    prompt_text_truncated: accepted && s.length > PROMPT_TEXT_CAP ? true : undefined,
  };
}
