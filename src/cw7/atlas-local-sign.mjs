// atlas-local-sign.mjs — local ed25519 Atlas signer + verifier for the Games backend.
// Off-chain, no gas, no blockchain: a receipt is a detached ed25519 signature over the CANONICAL body
//   { attestation, attested_by, prev_hash, subject_type, subject_id }   (keys sorted, stable JSON)
// matching the shape the public verify view + in-browser embed already check.
//
// KEYS (server-side only; never sent to the browser, never committed):
//   ATLAS_PRIVATE_KEY  — ed25519 private key. Either a PKCS8 PEM ("-----BEGIN PRIVATE KEY-----")
//                        OR a base64-encoded 32-byte raw seed. The public key is DERIVED from it,
//                        so /atlas/key always matches the signer.
//   (optional) ATLAS_PUBLIC_KEY — raw base64 ed25519 public key, used only if no private key is set
//                        (verify-only node). When a private key is present this is ignored.
// If no key is configured, signReceipt() returns null (honest: world still publishes, receipt unsigned).

import crypto from "node:crypto";

let _loaded = false, _priv = null, _pub = null, _pubB64 = "";

function buildPkcs8FromSeed(seed32) {
  const prefix = Buffer.from("302e020100300506032b657004220420", "hex"); // ed25519 PKCS8 header
  return crypto.createPrivateKey({ key: Buffer.concat([prefix, seed32]), format: "der", type: "pkcs8" });
}
function buildSpkiFromRaw(raw32) {
  const prefix = Buffer.from("302a300506032b6570032100", "hex"); // ed25519 SPKI header
  return crypto.createPublicKey({ key: Buffer.concat([prefix, raw32]), format: "der", type: "spki" });
}
function rawFromPublic(pubKeyObj) {
  const spki = pubKeyObj.export({ type: "spki", format: "der" });
  return spki.subarray(spki.length - 32); // last 32 bytes = raw ed25519 public key
}

// Accept any ed25519 private-key format we might already have in env:
//   • PKCS8 PEM ("-----BEGIN PRIVATE KEY-----")
//   • base64 of PKCS8 DER   (the Atlas ecosystem standard, e.g. ATLAS_SIGNING_SK_B64)
//   • base64 / hex of a 32-byte raw seed
//   • base64 of a 64-byte libsodium/nacl secret key (first 32 bytes = seed)
function parsePrivateKey(env) {
  if (env.includes("BEGIN")) return crypto.createPrivateKey(env);
  if (/^[0-9a-fA-F]{64}$/.test(env)) return buildPkcs8FromSeed(Buffer.from(env, "hex")); // hex seed
  const buf = Buffer.from(env, "base64");
  if (buf.length === 32) return buildPkcs8FromSeed(buf);                 // raw seed
  if (buf.length === 64) return buildPkcs8FromSeed(buf.subarray(0, 32)); // nacl secret key → seed
  return crypto.createPrivateKey({ key: buf, format: "der", type: "pkcs8" }); // PKCS8 DER (Atlas standard)
}

function load() {
  if (_loaded) return;
  _loaded = true;
  // accept the key under any of the names it might already be set as
  const env = (process.env.ATLAS_PRIVATE_KEY || process.env.ATLAS_SIGNING_SK_B64 || process.env.ATLAS_PRIVATE_KEY_B64 || "").trim();
  try {
    if (env) {
      _priv = parsePrivateKey(env);
      _pub = crypto.createPublicKey(_priv);
    } else if ((process.env.ATLAS_PUBLIC_KEY || "").trim()) {
      _pub = buildSpkiFromRaw(Buffer.from(process.env.ATLAS_PUBLIC_KEY.trim(), "base64"));
    }
    if (_pub) _pubB64 = rawFromPublic(_pub).toString("base64");
  } catch (e) {
    _priv = null; _pub = null; _pubB64 = ""; // misconfigured key → behave as "no key" (honest, never throws)
  }
}

/**
 * Every signed field, and the unsigned spellings that may stand in for it.
 *
 * A receipt is signed over five fields, but callers historically wrote some of
 * them under other names (`world_id` for `subject_id`, `builder_id` for
 * `attested_by`, `action` for `attestation`). Each alias is a place where a
 * signer and a reader can disagree about what the receipt says — and every such
 * disagreement is a forgery primitive. They are enumerated ONCE, here, so that
 * resolution, conflict detection and display cannot drift apart again.
 */
export const SIGNED_FIELDS = {
  attestation:  { aliases: ["action"],      fallback: "create" },
  // author_id is read by atlas-seller-provenance as "who authored this / who
  // owns it now" and was outside the signed body entirely — a sixth spelling of
  // the attesting party that no signature covered.
  attested_by:  { aliases: ["builder_id", "author_id"],  fallback: null },
  prev_hash:    { aliases: [],              fallback: null },
  subject_type: { aliases: [],              fallback: "world" },
  subject_id:   { aliases: ["world_id", "asset_id"], fallback: null },
};

/**
 * The exact object that gets signed. This is the ONE reading of a receipt:
 * anything that signs, verifies, hashes or DISPLAYS one must go through here,
 * so that what a viewer is shown is by construction what the key attested.
 */
/**
 * One reading of a VALUE, not merely of a field.
 *
 * The field-level fix stopped signing and display disagreeing about WHICH key
 * to read. They could still disagree about what the value IS: canonicalBody
 * goes through JSON.stringify, which honours toJSON, while the verify page's
 * escaper goes through String(), which honours toString/Symbol.toPrimitive. An
 * object whose toJSON says "victim-world" and whose toString says "world-a" was
 * therefore SIGNED as one and DISPLAYED as the other, beneath a VERIFIED badge.
 *
 * So a signed value must be a primitive. Anything else is coerced exactly once,
 * here, by the same rule the signature uses.
 */
function signedValue(v) {
  if (v == null) return null;
  const t = typeof v;
  if (t === "string" || t === "number" || t === "boolean") return v;
  // Apply toJSON once — the signature's own rule — then require what comes back
  // to be a primitive. An object that still is not one cannot be signed and
  // displayed consistently, so it is not a value this system can attest.
  let j;
  try { j = JSON.parse(JSON.stringify(v)); } catch { return String(v); }
  const jt = typeof j;
  if (j == null) return null;
  if (jt === "string" || jt === "number" || jt === "boolean") return j;
  return JSON.stringify(j);
}

/**
 * Does any signed field hold something that is not a primitive?
 *
 * Checked on the RAW receipt, before resolution, because the point is that two
 * consumers would coerce the original object differently.
 */
export function hasNonPrimitiveSignedField(receipt) {
  if (!receipt) return false;
  for (const [name, { aliases }] of Object.entries(SIGNED_FIELDS)) {
    for (const key of [name, ...aliases]) {
      const v = receipt[key];
      if (v == null) continue;
      const t = typeof v;
      if (t !== "string" && t !== "number" && t !== "boolean") return true;
    }
  }
  return false;
}

export function signedFields(r) {
  const out = {};
  for (const [name, { aliases, fallback }] of Object.entries(SIGNED_FIELDS)) {
    let v = r?.[name];
    for (const a of aliases) { if (v == null) v = r?.[a]; }
    out[name] = signedValue(v ?? fallback);
  }
  return out;
}

/**
 * The exact field order of the signed bytes. Anything that tells a third party
 * how to rebuild the canonical body must serve THIS, not restate it: the
 * in-browser widget and GET /atlas/key each listed their own order, and both
 * had subject_type before subject_id, so every genuine receipt read INVALID to
 * an external verifier. That failed closed, but it made the independent
 * verifiability claim — the one the badge rests on — false.
 */
export const CANONICAL_FIELD_ORDER = Object.keys(SIGNED_FIELDS).sort();

// canonical signed body (sorted keys) from a receipt-or-body object
export function canonicalBody(r) {
  const b = signedFields(r);
  return JSON.stringify(b, Object.keys(b).sort());
}

export function atlasReady() { load(); return !!_priv; }
export function atlasPublicKeyBase64() { load(); return _pubB64; }
export function receiptHash(body) { return crypto.createHash("sha256").update(canonicalBody(body)).digest("hex"); }

export function signReceipt(body) {
  load(); if (!_priv) return null;
  try { return crypto.sign(null, Buffer.from(canonicalBody(body), "utf8"), _priv).toString("base64"); }
  catch (e) { return null; }
}

/**
 * The ONE place a receipt's subject is resolved. Everything that signs, verifies
 * or DISPLAYS a receipt must call this.
 *
 * Defect found 6 Sep 2026 by the flagship E2E: the signer resolved
 * `subject_id ?? world_id` while the public verify view resolved
 * `world_id ?? subject_id` — the opposite precedence. A receipt legitimately
 * signed for world A, with `world_id: "B"` appended, verified against A and was
 * DISPLAYED as a verified receipt for B. Two canonicalisations is one too many.
 */
export function canonicalSubjectId(r) {
  return signedFields(r).subject_id;
}

/**
 * Reject a receipt carrying an unsigned alias that contradicts a signed field.
 * The signature alone cannot catch this: the alias is outside the signed body.
 */
export function hasConflictingAlias(receipt) {
  if (!receipt) return false;
  // Compare each alias against the RESOLVED field, not against the canonical
  // spelling alone.
  //
  // This used to read `receipt[name]` and skip when it was absent — but
  // signedFields() resolves subject_id FROM world_id, so a receipt can carry a
  // signed subject with no canonical field present at all. For exactly those
  // receipts — which is the documented CW7 shape — the check was skipped
  // entirely, and a genuine world attestation could be replayed as verified
  // provenance for an asset the estate never saw:
  //   sign  { world_id: "world-a", builder_id: "honest", action: "create" }
  //   append  asset_id: "premium-asset", author_id: "attacker"
  //   -> verifyReceipt() true, and the provenance view names the attacker.
  // The signature was intact throughout; the disagreement was between which
  // spelling signed and which spelling was read.
  const resolved = signedFields(receipt);
  for (const [name, { aliases }] of Object.entries(SIGNED_FIELDS)) {
    const canonical = resolved[name];
    if (canonical == null) continue;
    for (const a of aliases) {
      if (receipt[a] != null && String(receipt[a]) !== String(canonical)) return true;
    }
  }
  return false;
}

// verify(receipt) -> bool. Injected into the /verify route + atlas verify view.
export function verifyReceipt(receipt) {
  load(); if (!_pub || !receipt || !receipt.sig) return false;
  // An unsigned alias that contradicts the signed subject is a forgery attempt,
  // even though the signature over the canonical body is intact.
  if (hasConflictingAlias(receipt)) return false;
  // A signed field whose value is not a primitive cannot be shown consistently:
  // the signature goes through JSON.stringify (which honours toJSON) and the
  // page through String() (which honours toString), so one object can be signed
  // as one subject and displayed as another beneath a VERIFIED badge. Coercing
  // would pick a winner silently; refusing says plainly that this is not a value
  // the system can attest.
  if (hasNonPrimitiveSignedField(receipt)) return false;
  // receipt_hash is derivable from the signed body, so a value that disagrees
  // with it is either corruption or a forged identifier. It is the field a
  // third party cross-references, so it must not be free to be anything.
  if (receipt.receipt_hash != null && String(receipt.receipt_hash) !== receiptHash(receipt)) return false;
  try { return crypto.verify(null, Buffer.from(canonicalBody(receipt), "utf8"), _pub, Buffer.from(receipt.sig, "base64")); }
  catch (e) { return false; }
}

// Issue a complete receipt for a world (canonical body + ts + hash + sig).
export function issueWorldReceipt(worldId, builderId) {
  const body = { attestation: "create", attested_by: builderId || "creator_demo", prev_hash: null, subject_type: "world", subject_id: worldId };
  const sig = signReceipt(body);
  return { ...body, ts: new Date().toISOString(), receipt_hash: receiptHash(body), sig: sig || null, signer: sig ? "local-ed25519" : "unsigned" };
}
