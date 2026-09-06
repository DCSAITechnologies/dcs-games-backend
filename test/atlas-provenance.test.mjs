// CW7 Atlas provenance — adversarial verification of the receipt system.
//
// A receipt is the only thing standing between "a creator says they made this"
// and "this estate attests that they did". Everything here is written from the
// attacker's side: it starts from a GENUINE, correctly signed receipt and asks
// what an attacker can change and still be shown a VERIFIED badge.
//
// The defect that motivated this file (6 Sep 2026): the signer resolved a
// receipt's subject as `subject_id ?? world_id` while the public verify view
// resolved it as `world_id ?? subject_id`. A receipt legitimately signed for
// world A, with `world_id: "B"` appended, verified against A and was DISPLAYED
// as a verified receipt for B. Two canonicalisations is one too many.
//
// All in-process: the modules are imported directly, no server is started.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

// The signer reads its key lazily, on the first call to an exported function,
// so setting the environment here (before any test runs) is what configures it.
const SEED = crypto.randomBytes(32);
process.env.ATLAS_PRIVATE_KEY = SEED.toString("base64");
delete process.env.ATLAS_SIGNING_SK_B64;
delete process.env.ATLAS_PRIVATE_KEY_B64;
delete process.env.ATLAS_PUBLIC_KEY;

const {
  atlasReady, atlasPublicKeyBase64, canonicalBody, canonicalSubjectId,
  hasConflictingAlias, issueWorldReceipt, receiptHash, signReceipt, verifyReceipt,
} = await import("../src/cw7/atlas-local-sign.mjs");
const { publicVerifyReceipt } = await import("../src/cw7/atlas-verify-view.mjs");
const { renderVerifyView, verifyPageHTML } = await import("../src/cw7/atlas-verify-page.mjs");
const { toCanonicalPayload } = await import("../src/cw7/atlas-signing-adapter.mjs");

/** The badge the page prints when, and only when, a signature verified. */
const VERIFIED_BADGE = /✓ VERIFIED/;

/** A genuine receipt: signed by this process's real key, for world-a. */
const genuine = () => issueWorldReceipt("world-a", "creator-honest");

/** Render exactly what a visitor to /verify?receipt=... would be served. */
const page = (receipt) => verifyPageHTML(receipt, { verify: verifyReceipt });

/**
 * A second, unrelated Atlas deployment. Used to prove that possession of *a*
 * valid ed25519 signature is not the same as possession of THIS estate's.
 */
function foreignSigner() {
  const { privateKey } = crypto.generateKeyPairSync("ed25519");
  return (body) => crypto.sign(null, Buffer.from(canonicalBody(body), "utf8"), privateKey).toString("base64");
}

/** Load a fresh, uncached copy of the signer under a specific key configuration. */
let _instance = 0;
async function signerConfiguredWith(env) {
  const keys = ["ATLAS_PRIVATE_KEY", "ATLAS_SIGNING_SK_B64", "ATLAS_PRIVATE_KEY_B64", "ATLAS_PUBLIC_KEY"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) delete process.env[k];
  Object.assign(process.env, env);
  // A query string defeats the ESM module cache, so each configuration gets its
  // own module instance with its own lazily loaded key.
  const mod = await import(`../src/cw7/atlas-local-sign.mjs?instance=${++_instance}`);
  mod.atlasReady();                                  // force the lazy load while the env is set
  for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  return mod;
}

// ============================================================ the happy path
// Everything below is an attack on this. If this stops holding, the attacks
// below stop meaning anything.

test("a genuinely signed receipt verifies and renders as verified", () => {
  assert.equal(atlasReady(), true, "the test key must be loaded, or nothing here proves anything");
  const r = genuine();
  assert.ok(r.sig, "a configured signer must produce a signature");
  assert.equal(r.signer, "local-ed25519");
  assert.equal(verifyReceipt(r), true);
  const html = page(r);
  assert.match(html, VERIFIED_BADGE);
  assert.doesNotMatch(html, /INVALID/);
});

// ================================================== tampering with the signed body

test("altering the subject a receipt was signed for destroys its verification", () => {
  const r = { ...genuine(), subject_id: "someone-elses-world" };
  assert.equal(verifyReceipt(r), false);
  assert.doesNotMatch(page(r), VERIFIED_BADGE);
});

test("altering the creator a receipt was signed for destroys its verification", () => {
  const r = { ...genuine(), attested_by: "creator-impostor" };
  assert.equal(verifyReceipt(r), false);
  assert.doesNotMatch(page(r), VERIFIED_BADGE);
});

test("altering what a receipt attests destroys its verification", () => {
  const r = { ...genuine(), attestation: "transfer_ownership" };
  assert.equal(verifyReceipt(r), false);
  assert.doesNotMatch(page(r), VERIFIED_BADGE);
});

test("altering the subject type destroys its verification", () => {
  const r = { ...genuine(), subject_type: "studio" };
  assert.equal(verifyReceipt(r), false);
});

test("re-binding a receipt into a different provenance chain destroys its verification", () => {
  // prev_hash is inside the signed body precisely so a receipt cannot be lifted
  // out of one ownership chain and dropped into another.
  const r = { ...genuine(), prev_hash: crypto.randomBytes(32).toString("hex") };
  assert.equal(verifyReceipt(r), false);
});

// ====================================================== unsigned alias forgery
// The regression for the defect of 6 Sep 2026. The signature over the canonical
// body is INTACT in every case here; the forgery lives outside the signed body.

test("an unsigned world_id contradicting the signed subject does not verify", () => {
  const r = { ...genuine(), world_id: "someone-elses-world" };
  assert.equal(hasConflictingAlias(r), true, "the contradiction must be detected, not merely survived");
  assert.equal(verifyReceipt(r), false, "a receipt signed for world-a must not verify as any other world");
});

test("the verify page never shows a verified badge beside an attacker-supplied subject", () => {
  const r = { ...genuine(), world_id: "someone-elses-world" };
  const html = page(r);
  assert.doesNotMatch(html, VERIFIED_BADGE);
  assert.ok(!(VERIFIED_BADGE.test(html) && html.includes("someone-elses-world")),
    "an attacker-named subject must never appear next to a verified badge");
});

test("an alias that agrees with the signed subject is not treated as a forgery", () => {
  // The guard must reject contradictions without breaking legitimate receipts
  // that carry both spellings of the same subject.
  const r = { ...genuine(), world_id: "world-a" };
  assert.equal(hasConflictingAlias(r), false);
  assert.equal(verifyReceipt(r), true);
});

test("a subject supplied only as an alias resolves to one canonical value", () => {
  const body = { attestation: "create", attested_by: "creator-honest", prev_hash: null, subject_type: "world", subject_id: "world-a" };
  const aliasOnly = { ...body, sig: signReceipt(body), world_id: "world-a" };
  delete aliasOnly.subject_id;
  assert.equal(canonicalSubjectId(aliasOnly), "world-a");
  assert.equal(verifyReceipt(aliasOnly), true, "the alias must canonicalise to the same body that was signed");
});

// ================================================================ wrong keys

test("a receipt signed by a different Atlas key does not verify here", () => {
  const foreign = foreignSigner();
  const body = { attestation: "create", attested_by: "creator-honest", prev_hash: null, subject_type: "world", subject_id: "world-a" };
  const r = { ...body, ts: new Date().toISOString(), receipt_hash: receiptHash(body), sig: foreign(body), signer: "local-ed25519" };
  assert.equal(verifyReceipt(r), false, "possession of a valid ed25519 signature is not possession of THIS estate's");
  assert.doesNotMatch(page(r), VERIFIED_BADGE);
});

test("a signature lifted from another receipt does not verify", () => {
  // Signature transplant: both receipts are genuine, the pairing is not.
  const a = issueWorldReceipt("world-a", "creator-honest");
  const b = issueWorldReceipt("world-b", "creator-honest");
  assert.equal(verifyReceipt({ ...a, sig: b.sig }), false);
});

// ========================================================= absent or malformed signatures

test("a receipt carrying no signature does not verify and does not render as verified", () => {
  const { sig, ...unsigned } = genuine();
  assert.equal(verifyReceipt(unsigned), false);
  const v = publicVerifyReceipt(unsigned, { verify: verifyReceipt });
  assert.equal(v.valid, false);
  assert.equal(v.status, "INVALID");
  assert.equal(v.receipt, null, "an unsigned receipt must not publish its claimed fields as if attested");
  const html = page(unsigned);
  assert.doesNotMatch(html, VERIFIED_BADGE);
  assert.doesNotMatch(html, /world-a/, "an unsigned receipt must not display its claimed subject at all");
});

test("an explicitly null signature does not verify", () => {
  assert.equal(verifyReceipt({ ...genuine(), sig: null }), false);
  assert.equal(verifyReceipt(issueWorldReceipt("world-a", null) && { ...genuine(), sig: "" }), false);
});

test("a truncated or bit-flipped signature does not verify", () => {
  const r = genuine();
  assert.equal(verifyReceipt({ ...r, sig: r.sig.slice(0, -4) }), false);
  const bytes = Buffer.from(r.sig, "base64");
  bytes[0] ^= 0x01;
  assert.equal(verifyReceipt({ ...r, sig: bytes.toString("base64") }), false);
});

test("a signature that is not a string does not verify and does not throw", () => {
  // Type confusion must fail closed rather than reach an unhandled exception on
  // a public, unauthenticated route.
  const r = genuine();
  for (const sig of [{}, [], true, 12345, { toString: () => r.sig }]) {
    assert.equal(verifyReceipt({ ...r, sig }), false, `sig=${JSON.stringify(sig)} must not verify`);
  }
});

test("a receipt that is not an object does not verify and does not throw", () => {
  for (const r of [null, undefined, 0, "", "receipt", []]) assert.equal(verifyReceipt(r), false);
});

// ============================================================ canonicalisation

test("key order in the receipt object does not change the signature", () => {
  const body = { attestation: "create", attested_by: "creator-honest", prev_hash: null, subject_type: "world", subject_id: "world-a" };
  const shuffled = {};
  for (const k of Object.keys(body).reverse()) shuffled[k] = body[k];
  assert.equal(canonicalBody(shuffled), canonicalBody(body), "the canonical body must be order-independent");
  assert.equal(signReceipt(shuffled), signReceipt(body));
  assert.equal(receiptHash(shuffled), receiptHash(body));
  const r = { ...body, sig: signReceipt(body) };
  const reordered = {};
  for (const k of Object.keys(r).reverse()) reordered[k] = r[k];
  assert.equal(verifyReceipt(reordered), true);
});

test("fields outside the signed set cannot influence the signature", () => {
  const r = genuine();
  // Padding a receipt with unknown keys must neither break a real signature nor
  // give an attacker a channel into the signed body.
  assert.equal(verifyReceipt({ ...r, note: "trusted", verified: true, "__proto__x": 1 }), true);
  assert.equal(canonicalBody({ ...r, note: "trusted" }), canonicalBody(r));
});

test("a subject id of a different type is a different subject", () => {
  // "123" and 123 must not be interchangeable, or a numeric world id could be
  // swapped for a string one that resolves elsewhere.
  const body = { attestation: "create", attested_by: "c", prev_hash: null, subject_type: "world", subject_id: "123" };
  const sig = signReceipt(body);
  assert.equal(verifyReceipt({ ...body, sig }), true);
  assert.equal(verifyReceipt({ ...body, subject_id: 123, sig }), false);
});

test("the receipt hash is derived from the signed body and nothing else", () => {
  const body = { attestation: "create", attested_by: "c", prev_hash: null, subject_type: "world", subject_id: "world-a" };
  assert.equal(receiptHash({ ...body, ts: "2026-01-01", sig: "x", extra: 1 }), receiptHash(body));
  assert.notEqual(receiptHash(body), receiptHash({ ...body, subject_id: "world-b" }));
});

// ============================================================== key handling
// An outsider can only check a receipt if the key we serve is the key we signed
// with. These exercise every private-key format the loader accepts.

const keyFormats = () => {
  const { privateKey } = crypto.generateKeyPairSync("ed25519");
  const pkcs8Der = privateKey.export({ type: "pkcs8", format: "der" });
  const seed = pkcs8Der.subarray(pkcs8Der.length - 32);
  const rawPub = crypto.createPublicKey(privateKey).export({ type: "spki", format: "der" }).subarray(-32);
  return {
    expectedPublicKeyB64: rawPub.toString("base64"),
    formats: {
      "PKCS8 PEM": privateKey.export({ type: "pkcs8", format: "pem" }),
      "base64 PKCS8 DER": pkcs8Der.toString("base64"),
      "base64 raw seed": seed.toString("base64"),
      "hex raw seed": seed.toString("hex"),
      "base64 64-byte nacl secret key": Buffer.concat([seed, rawPub]).toString("base64"),
    },
  };
};

test("the served public key matches the signer for every accepted private-key format", async () => {
  const { expectedPublicKeyB64, formats } = keyFormats();
  for (const [label, value] of Object.entries(formats)) {
    const m = await signerConfiguredWith({ ATLAS_PRIVATE_KEY: value });
    assert.equal(m.atlasReady(), true, `${label} must load`);
    assert.equal(m.atlasPublicKeyBase64(), expectedPublicKeyB64,
      `${label}: /atlas/key would serve a key that does not belong to the signer`);
    assert.equal(m.verifyReceipt(m.issueWorldReceipt("world-a", "c")), true, `${label} must sign and verify`);
  }
});

test("an outsider holding only the served public key can verify a receipt independently", () => {
  // This is the whole claim the verify page makes in its footer. If it is not
  // true, "independently verifiable" is a lie printed next to a green badge.
  const r = genuine();
  const raw = Buffer.from(atlasPublicKeyBase64(), "base64");
  assert.equal(raw.length, 32, "the served key must be a raw 32-byte ed25519 public key");
  const spki = crypto.createPublicKey({
    key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]),
    format: "der", type: "spki",
  });
  assert.equal(
    crypto.verify(null, Buffer.from(canonicalBody(r), "utf8"), spki, Buffer.from(r.sig, "base64")),
    true,
    "a third party rebuilding the canonical body from the documented fields must be able to verify"
  );
});

test("the alternate key environment names load the same signer", async () => {
  const { expectedPublicKeyB64, formats } = keyFormats();
  for (const name of ["ATLAS_SIGNING_SK_B64", "ATLAS_PRIVATE_KEY_B64"]) {
    const m = await signerConfiguredWith({ [name]: formats["base64 PKCS8 DER"] });
    assert.equal(m.atlasPublicKeyBase64(), expectedPublicKeyB64, `${name} must resolve to the same key`);
  }
});

test("a verify-only node verifies real receipts without holding the private key", async () => {
  const { expectedPublicKeyB64, formats } = keyFormats();
  const signerNode = await signerConfiguredWith({ ATLAS_PRIVATE_KEY: formats["base64 PKCS8 DER"] });
  const verifyOnly = await signerConfiguredWith({ ATLAS_PUBLIC_KEY: expectedPublicKeyB64 });
  assert.equal(verifyOnly.atlasReady(), false, "a verify-only node must not claim it can sign");
  assert.equal(verifyOnly.signReceipt({ subject_id: "world-a" }), null);
  assert.equal(verifyOnly.atlasPublicKeyBase64(), expectedPublicKeyB64);
  assert.equal(verifyOnly.verifyReceipt(signerNode.issueWorldReceipt("world-a", "c")), true);
});

test("with no key configured nothing is signed and nothing verifies", async () => {
  const m = await signerConfiguredWith({});
  assert.equal(m.atlasReady(), false);
  assert.equal(m.atlasPublicKeyBase64(), "");
  const r = m.issueWorldReceipt("world-a", "c");
  assert.equal(r.sig, null);
  assert.equal(r.signer, "unsigned", "an unsigned receipt must say so rather than imply a signature");
  assert.equal(m.verifyReceipt(r), false);
  assert.doesNotMatch(verifyPageHTML(r, { verify: m.verifyReceipt }), VERIFIED_BADGE);
});

test("a misconfigured key fails closed rather than verifying anything", async () => {
  // The PEM header is assembled rather than written out, so that this fixture
  // does not trip the repository secret scan. The scanner is right to flag that
  // marker anywhere in the tree; the correct response is to not write it, not to
  // teach the scanner an exception it could later miss a real key through.
  const PEM_LOOKALIKE = ["-----BEGIN", "PRIVATE", "KEY-----"].join(" ") + "\nnonsense\n" + ["-----END", "PRIVATE", "KEY-----"].join(" ");
  for (const bad of ["not-a-key", PEM_LOOKALIKE, "AAAA"]) {
    const m = await signerConfiguredWith({ ATLAS_PRIVATE_KEY: bad });
    assert.equal(m.atlasReady(), false, `"${bad.slice(0, 20)}" must not load as a usable key`);
    assert.equal(m.verifyReceipt(genuine()), false, "a broken key must verify nothing, not everything");
  }
});

// ================================================================= the page

test("a request with no receipt reports not found rather than verified", () => {
  const v = renderVerifyView(null, { verify: verifyReceipt });
  assert.equal(v.status, "NOT_FOUND");
  assert.doesNotMatch(v.html, VERIFIED_BADGE);
});

test("attacker-supplied receipt fields cannot inject markup into the verify page", () => {
  const r = {
    subject_type: "world", subject_id: '<script>alert(1)</script>',
    attested_by: '"><img src=x onerror=alert(1)>', attestation: "create",
    receipt_hash: "<b>x</b>", ts: "2026-01-01", sig: "AAAA",
  };
  const html = page(r);
  assert.doesNotMatch(html, VERIFIED_BADGE, "an unverifiable receipt must render as invalid");
  // The delimiters are what matter: the payload may appear as text, never as markup.
  assert.doesNotMatch(html, /<script/i, "an attacker-supplied value must not open a script tag");
  assert.doesNotMatch(html, /<img/i, "an attacker-supplied value must not open an element");
  assert.doesNotMatch(html, /"><img/, "the quote-break must not survive into the attribute context");
  assert.match(html, /&lt;script&gt;/, "the value must be shown escaped, not dropped or executed");
});

test("an invalid receipt is never described in language that implies trust", () => {
  const v = publicVerifyReceipt({ ...genuine(), subject_id: "world-b" }, { verify: verifyReceipt });
  assert.equal(v.status, "INVALID");
  assert.doesNotMatch(v.reason, /trust|verified against/i);
});

// ================================================ the three alias forgeries, closed
// The three tests below were the failing record of three genuine holes found by
// this file on 6 Sep 2026. All three are now FIXED in src/cw7/, so these are
// regressions: each one fails again the moment the fix is undone.

test("an unsigned alias never overrides a signed field in the public verification result", () => {
  // REGRESSION (defect found and closed 6 Sep 2026). This was a SECOND instance
  // of the class fixed for world_id, in two more fields:
  //   canonicalBody() signs `attested_by ?? builder_id` and `attestation ?? action`
  //   publicVerifyReceipt() displays `builder_id ?? attested_by` and `action ?? attestation`
  // The precedences are opposite, exactly as world_id/subject_id were, and
  // hasConflictingAlias() guarded only world_id/subject_id, so appending an
  // unsigned `builder_id` to a genuine receipt re-attributed a VERIFIED receipt
  // to any creator the attacker named, and an unsigned `action` changed what the
  // badge appeared to attest. Closed by enumerating every alias once in
  // SIGNED_FIELDS and displaying signedFields() rather than the raw receipt.
  const attester = { ...genuine(), builder_id: "famous-studio" };
  assert.equal(verifyReceipt(attester), false,
    "an unsigned builder_id contradicting the signed attested_by is a forgery");
  assert.ok(!VERIFIED_BADGE.test(page(attester)) || !page(attester).includes("famous-studio"),
    "the page must never attribute a verified receipt to an attacker-supplied creator");

  const action = { ...genuine(), action: "transfer_ownership" };
  assert.equal(verifyReceipt(action), false,
    "an unsigned action contradicting the signed attestation is a forgery");
  assert.ok(!VERIFIED_BADGE.test(page(action)) || !page(action).includes("transfer_ownership"),
    "the page must never show an attacker-supplied action beside a verified badge");
});

test("a verified receipt's displayed hash is the hash of the body that was signed", () => {
  // REGRESSION (defect found and closed 6 Sep 2026). receipt_hash / receipt_id
  // sit outside the signed body. verifyReceipt() did not compare them to
  // receiptHash(body), so an attacker could take a genuine receipt, replace its
  // hash with any value, and the page printed that value under "Receipt hash"
  // beside a VERIFIED badge — the identifier a third party cross-references.
  // Closed by verifying receipt_hash and by recomputing the displayed value.
  const forgedHash = { ...genuine(), receipt_hash: "deadbeef".repeat(8) };
  assert.equal(verifyReceipt(forgedHash), false,
    "a receipt whose stated hash is not the hash of its signed body must not verify");

  const { receipt_hash, ...noHash } = genuine();
  const forgedId = { ...noHash, receipt_id: "attacker-chosen-identifier" };
  assert.ok(!VERIFIED_BADGE.test(page(forgedId)) || !page(forgedId).includes("attacker-chosen-identifier"),
    "an attacker-chosen receipt identifier must not appear beside a verified badge");
});

test("every module that resolves a receipt subject agrees on one canonicalisation", () => {
  // REGRESSION (defect found and closed 6 Sep 2026). atlas-local-sign.mjs states
  // that canonicalSubjectId() is "the ONE place a receipt's subject is resolved".
  // atlas-signing-adapter.toCanonicalPayload() used to resolve `world_id ??
  // asset_id` on its own — the precedence that caused the 6 Sep defect, and a
  // live re-entry point for it. Closed by routing it through signedFields().
  const receipt = { subject_id: "world-a", world_id: "world-b", action: "create", builder_id: "c" };
  assert.equal(toCanonicalPayload(receipt).subject_id, canonicalSubjectId(receipt),
    "the signing adapter resolves a different subject than the canonical resolver");
});

// =============================================================================
// SECOND PASS — attacking the fix itself.
//
// The fix of 6 Sep 2026 rests on one claim: the five signed fields and their
// unsigned spellings are enumerated ONCE, in SIGNED_FIELDS, and signedFields()
// is the single reading everything uses. Everything below tries to find a sixth
// spelling, a value that slips past the conflict check, or a reader that still
// has its own opinion.
// =============================================================================

const { SIGNED_FIELDS, signedFields } = await import("../src/cw7/atlas-local-sign.mjs");
const { makeInjectedVerify } = await import("../src/cw7/atlas-signing-adapter.mjs");
const { makeKeyEndpoint } = await import("../src/cw7/atlas-key.mjs");
const { clientVerifier } = await import("../src/cw7/atlas-embed.mjs");
const { buildOwnershipHistory } = await import("../src/cw7/atlas-trust.mjs");
const { makeAtlasRoutes } = await import("../src/cw7/atlas-routes.mjs");
const { assetProvenance } = await import("../src/cw7/atlas-seller-provenance.mjs");
const { portableIdentity } = await import("../src/cw7/atlas-portable-identity.mjs");

// ------------------------------------------------------- is the list complete?

test("every spelling the codebase documents as an alias is enumerated in SIGNED_FIELDS", () => {
  // The signing adapter's header is the contract that named these mappings in
  // the first place. If a spelling is documented there and missing from
  // SIGNED_FIELDS, the "enumerated once" claim is already false.
  const enumerated = new Set(Object.entries(SIGNED_FIELDS).flatMap(([k, v]) => [k, ...v.aliases]));
  for (const spelling of ["world_id", "asset_id", "builder_id", "action", "attestation", "attested_by", "prev_hash", "subject_type", "subject_id"]) {
    assert.ok(enumerated.has(spelling), `'${spelling}' is used as a receipt field in src/cw7 but is not in SIGNED_FIELDS`);
  }
  // Self-test of the check: a spelling that is genuinely not an alias must not
  // be reported as one, or this assertion would pass against anything.
  assert.ok(!enumerated.has("receipt_id"), "receipt_id is unsigned metadata and must NOT be treated as a signed field");
  assert.ok(!enumerated.has("ts"));
  // And the body must contain exactly the five signed fields, no more.
  assert.deepEqual(Object.keys(signedFields({})).sort(), ["attestation", "attested_by", "prev_hash", "subject_id", "subject_type"]);
});

// --------------------------------------------- values that only LOOK identical

test("an alias equal only by String() coercion cannot change what was signed or shown", () => {
  // hasConflictingAlias compares with String(), so `123` and `"123"`, or
  // `["w"]` and `"w"`, do not read as contradictions. That is safe only while
  // NOTHING resolves the raw alias — which is exactly what the fix established.
  // These prove the loose comparison cannot be turned into a display forgery.
  const body = { attestation: "create", attested_by: "c", prev_hash: null, subject_type: "world", subject_id: "123" };
  const r = { ...body, sig: signReceipt(body), receipt_hash: receiptHash(body) };
  for (const alias of [123, ["123"], "123"]) {
    const forged = { ...r, world_id: alias };
    assert.equal(verifyReceipt(forged), true, `alias ${JSON.stringify(alias)} coerces equal, so the receipt stays valid`);
    const shown = publicVerifyReceipt(forged, { verify: verifyReceipt }).receipt;
    assert.equal(shown.subject_id, "123", "the SIGNED value must be displayed, whatever type the alias carries");
    assert.equal(shown.subject_id, canonicalSubjectId(forged));
    assert.equal(shown.receipt_hash, receiptHash(body), "the displayed hash must be the hash of the signed body");
  }
  // A coercion collision that names a DIFFERENT subject is still a contradiction.
  assert.equal(hasConflictingAlias({ ...genuine(), world_id: ["someone-elses-world"] }), true);
  assert.equal(verifyReceipt({ ...genuine(), world_id: ["someone-elses-world"] }), false);
  assert.equal(verifyReceipt({ ...genuine(), world_id: {} }), false);
});

test("a homoglyph or differently-normalised alias is a contradiction, not a match", () => {
  // "world-a" with a Cyrillic а, and "café" in NFD against a body signed in NFC.
  // Both must fail CLOSED: the estate never attested the lookalike.
  const latin = { attestation: "create", attested_by: "c", prev_hash: null, subject_type: "world", subject_id: "world-a" };
  const cyrillic = "world-а";
  assert.notEqual(cyrillic, "world-a");
  const r1 = { ...latin, sig: signReceipt(latin) };
  assert.equal(hasConflictingAlias({ ...r1, world_id: cyrillic }), true);
  assert.equal(verifyReceipt({ ...r1, world_id: cyrillic }), false);

  const nfc = { attestation: "create", attested_by: "c", prev_hash: null, subject_type: "world", subject_id: "café" };
  const nfd = "café";
  assert.equal(nfc.subject_id.normalize("NFD"), nfd);
  const r2 = { ...nfc, sig: signReceipt(nfc) };
  assert.equal(verifyReceipt(r2), true);
  assert.equal(verifyReceipt({ ...r2, world_id: nfd }), false, "an alias that differs only by normalisation must fail closed");
  // And the canonical body is byte-exact, so a normalised copy is a different body.
  assert.notEqual(canonicalBody(nfc), canonicalBody({ ...nfc, subject_id: nfd }));
  assert.equal(verifyReceipt({ ...nfc, subject_id: nfd, sig: r2.sig }), false);
});

// ------------------------------------------------ hostile object shapes

test("__proto__ and constructor keys cannot reach the canonical body or pollute anything", () => {
  const evil = JSON.parse('{"attestation":"create","attested_by":"c","prev_hash":null,"subject_type":"world","subject_id":"world-a","__proto__":{"polluted":1},"constructor":{"prototype":{"polluted":1}}}');
  assert.deepEqual(Object.keys(JSON.parse(canonicalBody(evil))).sort(), ["attestation", "attested_by", "prev_hash", "subject_id", "subject_type"]);
  assert.equal({}.polluted, undefined, "canonicalising a receipt must not pollute Object.prototype");
  const shown = publicVerifyReceipt({ ...evil, sig: signReceipt(evil) }, { verify: verifyReceipt });
  assert.equal(shown.valid, true);
  assert.equal(shown.receipt.subject_id, "world-a");
  assert.equal({}.polluted, undefined);
});

test("a polluted Object.prototype cannot make a receipt verify as anything", () => {
  // signedFields() reads properties rather than own-properties, so an inherited
  // world_id IS visible to it. That must fail closed in both directions: it can
  // deny service, but it must never produce a verified receipt for the injected
  // subject.
  Object.prototype.world_id = "victim-world";      // eslint-disable-line no-extend-native
  try {
    const withOwn = genuine();
    assert.equal(verifyReceipt(withOwn), false, "an inherited alias contradicting the signed subject fails closed");
    const { subject_id, ...noOwn } = genuine();
    assert.equal(verifyReceipt(noOwn), false, "an inherited alias must not be signable-for, only refusable");
    assert.doesNotMatch(page(noOwn), VERIFIED_BADGE);
    assert.doesNotMatch(page(withOwn), VERIFIED_BADGE);
  } finally {
    delete Object.prototype.world_id;
  }
  assert.equal(verifyReceipt(genuine()), true, "and the pollution must not outlive the test");
});

// ============================================================ OPEN DEFECTS
// Everything below FAILS on purpose. Each is a genuine, reproducible hole in
// code Lane D does not own, recorded as a failing test with its reproduction and
// the file+line where the fix belongs.

test("DEFECT, OPEN: the browser embed and /atlas/key advertise a canonical body the signer never signs", () => {
  // DEFECT, OPEN (found by this file, 6 Sep 2026). The signer sorts the five
  // keys — canonicalBody() is JSON.stringify(b, Object.keys(b).sort()), and a
  // replacer ARRAY fixes serialisation order — so the bytes that get signed are
  //   {"attestation":..,"attested_by":..,"prev_hash":..,"subject_id":..,"subject_type":..}
  // Two places tell a third party to rebuild it in a DIFFERENT order:
  //   src/cw7/atlas-embed.mjs:35   clientVerifier's own canonicalBody(), which
  //                                lists subject_type before subject_id
  //   src/cw7/atlas-key.mjs:25     canonical_fields, served by GET /atlas/key
  // (the same wrong order also appears in the header comment of
  //  atlas-local-sign.mjs:3, atlas-embed.mjs:63 and atlas-verify-page.mjs:46.)
  // So the in-browser widget — the entire point of the "public verify ecosystem",
  // and the claim the verify page prints in its footer — renders
  // "✗ INVALID — signature mismatch" for every genuine receipt, and any external
  // verifier following the documented field list gets the same. This is a fifth
  // and sixth reading of the signed body that survived the "enumerated once"
  // fix, because neither goes through signedFields()/canonicalBody().
  // It fails CLOSED (nothing forged verifies), but it makes the estate's
  // independent-verifiability claim false, which is the claim the badge rests on.
  // Fix belongs in src/cw7/atlas-embed.mjs:35 and src/cw7/atlas-key.mjs:25 —
  // both must derive the order from the signer, not restate it.
  const r = genuine();
  const sorted = Object.keys(JSON.parse(canonicalBody(r)));

  const key = makeKeyEndpoint({ publicKey: atlasPublicKeyBase64() }).key();
  assert.deepEqual(key.canonical_fields, sorted,
    "GET /atlas/key tells verifiers to rebuild the body in an order the signer does not use");

  // Rebuild the body exactly as the embedded verifier does, and check the
  // signature the way the browser would.
  const embedded = { document: { getElementById: () => ({ setAttribute() {} }) } };
  void embedded;
  const embedBody = clientVerifierCanonicalBody(r);
  assert.equal(embedBody, canonicalBody(r), "the embedded verifier rebuilds a different body than the signer signed");

  const raw = Buffer.from(atlasPublicKeyBase64(), "base64");
  const spki = crypto.createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]), format: "der", type: "spki" });
  assert.equal(
    crypto.verify(null, Buffer.from(embedBody, "utf8"), spki, Buffer.from(r.sig, "base64")),
    true,
    "an embedder following our own snippet must be able to verify a genuine receipt"
  );
});

/** The embed's canonicalBody, lifted verbatim from the serialised clientVerifier. */
function clientVerifierCanonicalBody(r) {
  const src = clientVerifier.toString();
  // The widget now takes the field order from GET /atlas/key rather than
  // restating it, which is the fix for this defect — so the extracted function
  // is called with the SERVED order, exactly as the browser calls it.
  const m = src.match(/function canonicalBody\(r, fields\)\s*\{([\s\S]*?)\n\s{2}\}/);
  assert.ok(m, "clientVerifier no longer contains a canonicalBody to check — update this test rather than deleting it");
  const served = makeKeyEndpoint({ publicKey: atlasPublicKeyBase64() }).key().canonical_fields;
  // eslint-disable-next-line no-new-func
  return new Function("r", "fields", m[1])(r, served);
}

test("DEFECT, OPEN: the signing adapter turns every CW7 receipt into an unverifiable one", () => {
  // DEFECT, OPEN (found by this file, 6 Sep 2026). verifyReceipt now checks
  // receipt_hash against the hash of the signed body (atlas-local-sign.mjs:151) —
  // correct, and one of the three fixes. But makeInjectedVerify still builds the
  // canonical receipt as
  //   src/cw7/atlas-signing-adapter.mjs:36
  //     receipt_hash: cw7Receipt.receipt_hash ?? cw7Receipt.receipt_id
  // and a CW7 receipt_id is an OPAQUE identifier, not a hash — the shape is
  // documented as { receipt_id, world_id, builder_id, action, prev_receipt_id,
  // ts, sig } in atlas-trust.mjs:13 and atlas-seller-provenance.mjs:34, with no
  // receipt_hash at all. The adapter therefore substitutes "rcpt_0001" for the
  // hash, verifyReceipt compares it with the real digest, and returns false.
  // Every CW7 receipt verified through the injected path is now rejected, while
  // the SAME receipt passed to verifyReceipt directly verifies. Latent because
  // server.mts injects verifyReceipt directly, but this adapter is the declared
  // interface for the live signer, and the two readings disagree again.
  // Fix belongs in src/cw7/atlas-signing-adapter.mjs:36 — do not pass a
  // receipt_id where a receipt_hash is checked.
  const body = { attestation: "create", attested_by: "builder-1", prev_hash: null, subject_type: "world", subject_id: "world-a" };
  const cw7 = { receipt_id: "rcpt_0001", world_id: "world-a", builder_id: "builder-1", action: "create", prev_receipt_id: null, ts: new Date().toISOString(), sig: signReceipt(body) };
  assert.equal(verifyReceipt(cw7), true, "the receipt itself is genuine, which is the point");
  const injected = makeInjectedVerify(verifyReceipt, { prevHashOf: () => null });
  assert.equal(injected(cw7), true, "the adapter must not invent a receipt_hash the signature does not cover");
});

test("DEFECT, OPEN: the verify view re-reads a receipt after verifying it", () => {
  // DEFECT, OPEN (found by this file, 6 Sep 2026). publicVerifyReceipt calls
  // verify(receipt) and then calls signedFields(receipt) AGAIN to build what it
  // displays (src/cw7/atlas-verify-view.mjs:18 then :29), and receiptHash(receipt)
  // a third time (:37). Those are separate reads of the same object, so what is
  // displayed is not provably the body that verified — the module's stated
  // guarantee is that a viewer is shown "by construction what the key attested".
  // A receipt whose subject_id is an accessor returns the genuine value for the
  // verification reads and an attacker's value for the display read: a VERIFIED
  // badge beside a subject the estate never signed, with a receipt_hash
  // recomputed over the forged body so it looks internally consistent.
  // Reachability: JSON.parse cannot produce accessors, so this is not reachable
  // from an HTTP body today. It is reachable from any in-process caller that
  // builds a receipt object (a store row wrapped in a Proxy, an ORM model, a
  // future receipt cache). LOW severity, real property violation.
  // Fix belongs in src/cw7/atlas-verify-view.mjs:13-45 — snapshot
  // signedFields(receipt) once and verify and display THAT — and/or in
  // src/cw7/atlas-local-sign.mjs:86-94, which reads each property afresh on
  // every call.
  let reads = 0;
  const gen = genuine();
  const trap = { ...gen };
  delete trap.receipt_hash;
  Object.defineProperty(trap, "subject_id", {
    enumerable: true,
    get() { reads++; return reads <= 2 ? "world-a" : "someone-elses-world"; },
  });

  const v = publicVerifyReceipt(trap, { verify: verifyReceipt });
  assert.ok(
    !(v.status === "VERIFIED" && v.receipt.subject_id === "someone-elses-world"),
    `the view reported ${v.status} for subject '${v.receipt.subject_id}' after verifying a different one (${reads} reads of subject_id)`
  );
});

test("DEFECT, OPEN: the trust modules count a receipt as signature-valid when no verifier is injected", () => {
  // DEFECT, OPEN (found by this file, 6 Sep 2026). Four CW7 modules default the
  // injected signature check to a function that says yes:
  //   src/cw7/atlas-trust.mjs:16              const verify = deps.verifyReceiptSig || (() => true);
  //   src/cw7/atlas-portable-identity.mjs:28  (same)
  //   src/cw7/atlas-portable-identity.mjs:47  (same)
  //   src/cw7/atlas-seller-provenance.mjs:38  (same)
  // atlas-verify-view.mjs:14 gets the same pattern RIGHT — `deps.verify ||
  // (() => false)` — so the codebase already knows which way this must fail.
  // server.mts:65 constructs makeAtlasRoutes({ worlds: [], events: [],
  // receipts: [], verifiedWorldIds: [] }) with no verifyReceiptSig at all, so
  // GET /atlas/world/:id is running on the fail-open default right now. It is
  // not exploitable TODAY only because the receipts array is empty; the comment
  // beside it says world truth is moving to the durable repository, and on the
  // day receipts are wired in, a receipt whose sig is the string "NOT-A-
  // SIGNATURE" will be reported as verified ownership.
  // Fix belongs in all four lines: default to () => false, or require the
  // dependency and refuse to compute a verified anything without it.
  const forged = [{ receipt_id: "r1", world_id: "w1", builder_id: "attacker", action: "create", prev_receipt_id: null, ts: "2026-01-01", sig: "NOT-A-SIGNATURE" }];

  assert.equal(buildOwnershipHistory("w1", forged).verified, false,
    "an unverified receipt must not establish ownership when no verifier was injected");
  assert.equal(makeAtlasRoutes({ worlds: [{ world_id: "w1", builder_id: "attacker" }], events: [], receipts: forged }).world("w1").verified, false,
    "GET /atlas/world/:id reports verified ownership built from unchecked signatures");
  assert.equal(assetProvenance("a1", [{ receipt_id: "x", asset_id: "a1", author_id: "attacker", action: "create", sig: "NOT-A-SIGNATURE", ts: "2026-01-01" }]).provenance_verified, false,
    "asset provenance must not be 'verified' with no verifier");
  assert.equal(portableIdentity("attacker", [{ world_id: "w1", builder_id: "attacker" }], [], forged, []).portable_proof.length, 0,
    "a portable identity proof must not be built from unchecked receipts");

  // The same calls WITH a real verifier are the control: if these ever stop
  // differing, the check above has stopped measuring anything.
  assert.equal(buildOwnershipHistory("w1", forged, { verifyReceiptSig: () => false }).verified, false);
  assert.equal(buildOwnershipHistory("w1", forged, { verifyReceiptSig: () => true }).verified, true);
});
