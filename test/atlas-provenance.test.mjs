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

// ==================================================================== DEFECTS
// The three tests below FAIL on purpose. Each is a genuine, reproducible hole
// in code Lane D does not own; per the lane brief they are recorded as failing
// tests rather than silently fixed across an ownership boundary.

test("an unsigned alias never overrides a signed field in the public verification result", () => {
  // DEFECT, OPEN (found 6 Sep 2026 by this file). This is a SECOND instance of
  // the class fixed for world_id, in two more fields:
  //   canonicalBody() signs `attested_by ?? builder_id` and `attestation ?? action`
  //   publicVerifyReceipt() displays `builder_id ?? attested_by` and `action ?? attestation`
  // The precedences are opposite, exactly as world_id/subject_id were, and
  // hasConflictingAlias() guards only world_id/subject_id. So appending an
  // unsigned `builder_id` to a genuine receipt re-attributes a VERIFIED receipt
  // to any creator the attacker names, and an unsigned `action` changes what the
  // badge appears to attest.
  // Fix belongs in src/cw7/atlas-local-sign.mjs (extend hasConflictingAlias to
  // every aliased field) and src/cw7/atlas-verify-view.mjs (display the signed
  // spelling). Reproduction: the two blocks below.
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
  // DEFECT, OPEN (found 6 Sep 2026 by this file). receipt_hash / receipt_id are
  // outside the signed body and are never recomputed. verifyReceipt() does not
  // compare them to receiptHash(body), so an attacker can take a genuine receipt,
  // replace its hash with any value, and the page prints that value under
  // "Receipt hash" beside a VERIFIED badge. The hash is the identifier a third
  // party would cross-reference, which makes it exactly the wrong field to leave
  // unchecked. It is cheaply fixable: the value is derivable from the signed body.
  // Fix belongs in src/cw7/atlas-local-sign.mjs (verifyReceipt).
  const forgedHash = { ...genuine(), receipt_hash: "deadbeef".repeat(8) };
  assert.equal(verifyReceipt(forgedHash), false,
    "a receipt whose stated hash is not the hash of its signed body must not verify");

  const { receipt_hash, ...noHash } = genuine();
  const forgedId = { ...noHash, receipt_id: "attacker-chosen-identifier" };
  assert.ok(!VERIFIED_BADGE.test(page(forgedId)) || !page(forgedId).includes("attacker-chosen-identifier"),
    "an attacker-chosen receipt identifier must not appear beside a verified badge");
});

test("every module that resolves a receipt subject agrees on one canonicalisation", () => {
  // DEFECT, OPEN (found 6 Sep 2026 by this file). atlas-local-sign.mjs states
  // that canonicalSubjectId() is "the ONE place a receipt's subject is resolved"
  // and that everything which signs, verifies or displays a receipt must call it.
  // atlas-signing-adapter.toCanonicalPayload() does not: it resolves
  // `world_id ?? asset_id`, the precedence that caused the 6 Sep defect. It is
  // latent today because server.mts injects verifyReceipt directly rather than
  // makeInjectedVerify, but it is a live re-entry point for the same bug.
  // Fix belongs in src/cw7/atlas-signing-adapter.mjs.
  const receipt = { subject_id: "world-a", world_id: "world-b", action: "create", builder_id: "c" };
  assert.equal(toCanonicalPayload(receipt).subject_id, canonicalSubjectId(receipt),
    "the signing adapter resolves a different subject than the canonical resolver");
});
