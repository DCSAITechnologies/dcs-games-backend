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

// canonical signed body (sorted keys) from a receipt-or-body object
export function canonicalBody(r) {
  const b = {
    attestation:  r.attestation ?? r.action ?? "create",
    attested_by:  r.attested_by ?? r.builder_id ?? null,
    prev_hash:    r.prev_hash ?? null,
    subject_type: r.subject_type ?? "world",
    subject_id:   r.subject_id ?? r.world_id ?? null,
  };
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

// verify(receipt) -> bool. Injected into the /verify route + atlas verify view.
export function verifyReceipt(receipt) {
  load(); if (!_pub || !receipt || !receipt.sig) return false;
  try { return crypto.verify(null, Buffer.from(canonicalBody(receipt), "utf8"), _pub, Buffer.from(receipt.sig, "base64")); }
  catch (e) { return false; }
}

// Issue a complete receipt for a world (canonical body + ts + hash + sig).
export function issueWorldReceipt(worldId, builderId) {
  const body = { attestation: "create", attested_by: builderId || "creator_demo", prev_hash: null, subject_type: "world", subject_id: worldId };
  const sig = signReceipt(body);
  return { ...body, ts: new Date().toISOString(), receipt_hash: receiptHash(body), sig: sig || null, signer: sig ? "local-ed25519" : "unsigned" };
}
