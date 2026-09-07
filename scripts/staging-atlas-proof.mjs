#!/usr/bin/env node
// Atlas provenance, verified TRUSTLESSLY against the deployed service.
//
// The claim a receipt makes is "this world was published by this principal, and
// here is a signature you can check without trusting us". A proof that asks the
// server "is this valid?" and believes the answer establishes nothing — the
// server could say yes to anything. So this fetches the public key and the
// receipt separately and verifies the signature HERE, with Node's own crypto,
// over a canonical form rebuilt from the published field rules.
//
//   STAGE_JWT=... node scripts/staging-atlas-proof.mjs
import crypto from "node:crypto";

const U = process.env.STAGE_URL || "https://dcs-games-backend-staging.up.railway.app";
const JWT = process.env.STAGE_JWT;
if (!JWT) { console.error("STAGE_JWT required"); process.exit(2); }

let pass = 0, fail = 0;
const out = [];
const ok = (n, c, d = "") => { if (c) { pass++; out.push(`  PASS  ${n}`); } else { fail++; out.push(`  FAIL  ${n}${d ? " — " + d : ""}`); } };

const api = (p, i = {}) => fetch(U + p, { ...i, headers: { Authorization: "Bearer " + JWT, "Content-Type": "application/json", ...(i.headers || {}) } });
const anon = (p) => fetch(U + p);
const j = async (r) => { try { return JSON.parse(await r.text()); } catch { return {}; } };

// ---------------------------------------------------- the key, and its rules

const key = await j(await anon("/atlas/key"));
ok("the public key is served without a login", key.available === true && !!key.public_key);
ok("and it is ed25519", key.alg === "ed25519", String(key.alg));
// The rules for rebuilding the signed body must be PUBLISHED, or a third party
// cannot reproduce the canonical form and the signature is unverifiable in
// practice even though it is valid in principle.
ok("and the canonical field list is published", Array.isArray(key.canonical_fields) && key.canonical_fields.length > 0);
ok("and the aliases are published", !!key.canonical_aliases,
   "a field with two spellings cannot be canonicalised by a third party without this");
ok("and the fallbacks are published", !!key.canonical_fallbacks);

// ------------------------------------------------------ publish something

const gen = await j(await api("/api/v3/worlds/generate", {
  method: "POST", body: JSON.stringify({ prompt: "A signal station on a cold coast, still sending." }),
}));
if (!gen.ok) { console.error("could not generate:", JSON.stringify(gen).slice(0, 300)); process.exit(1); }
const W = gen.world_id;

const pub = await api(`/worlds/${W}/publish`, { method: "POST", body: JSON.stringify({}) });
const pb = await j(pub);
ok("publishing issues a receipt", pub.status === 200, `HTTP ${pub.status}`);
const hash = pb.receipt?.receipt_hash || pb.atlas_receipt_hash || pb.receipt_hash;
ok("and the receipt has a hash", !!hash, JSON.stringify(Object.keys(pb)));

// ------------------------------------- fetch it as a third party would

const r = await anon(`/atlas/receipt/${hash}`);
const rb = await j(r);
ok("a third party can fetch the receipt WITHOUT a login", r.status === 200, `HTTP ${r.status}`);
const receipt = rb.receipt || rb;
ok("and it names the world it is about", String(receipt.subject_id || receipt.world_id) === W,
   `${receipt.subject_id ?? receipt.world_id} vs ${W}`);
ok("and it carries a signature", !!receipt.sig);

// --------------------------------------- verify it here, trusting nothing

// Rebuild the canonical body from the PUBLISHED rules, exactly as an outside
// verifier would have to.
const resolved = {};
for (const field of key.canonical_fields) {
  const aliases = [field, ...(key.canonical_aliases[field] || [])];
  let value;
  for (const a of aliases) {
    if (receipt[a] !== undefined && receipt[a] !== null) { value = receipt[a]; break; }
  }
  if (value === undefined) value = key.canonical_fallbacks[field] ?? null;
  resolved[field] = value;
}
// The encoding is now published too, so this follows the served instructions
// rather than inside knowledge. That is the whole point: a verifier who does
// not trust this server must be able to reproduce the signed bytes from what
// the server tells everyone.
ok("and the ENCODING is published, so the bytes are reproducible",
   key.canonical_encoding?.form === "json-object-sorted-keys" && Array.isArray(key.canonical_encoding.steps),
   "a signature valid in principle and unreproducible in practice is not evidence of anything");
const body = JSON.stringify(resolved, key.canonical_fields.slice().sort());

let verified = false, why = "";
try {
  const pk = crypto.createPublicKey({
    key: Buffer.concat([
      Buffer.from("302a300506032b6570032100", "hex"),      // ed25519 SPKI prefix
      Buffer.from(key.public_key, "base64"),
    ]),
    format: "der", type: "spki",
  });
  verified = crypto.verify(null, Buffer.from(body, "utf8"), pk, Buffer.from(receipt.sig, "base64"));
} catch (e) { why = String(e.message).slice(0, 160); }

ok("THE SIGNATURE VERIFIES, checked here with the published key and rules",
   verified, why || `canonical body did not verify:\n${body.split("\n").map((l) => "      " + l).join("\n")}`);

// And a tampered body must NOT verify — otherwise the check above proves nothing.
if (verified) {
  const tampered = JSON.stringify({ ...resolved, subject_id: "some_other_world" }, key.canonical_fields.slice().sort());
  let stillOk = true;
  try {
    const pk = crypto.createPublicKey({
      key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(key.public_key, "base64")]),
      format: "der", type: "spki",
    });
    stillOk = crypto.verify(null, Buffer.from(tampered, "utf8"), pk, Buffer.from(receipt.sig, "base64"));
  } catch { stillOk = false; }
  ok("and a receipt claiming a DIFFERENT world does not verify", stillOk === false,
     "the signature accepted altered content, which would make it worthless");
}

// ------------------------------------------------------------- the feed

const feed = await j(await anon("/api/public/atlas/feed"));
ok("the receipt appears in the public feed", (feed.receipts || []).some((x) => x.receipt_hash === hash));
const stats = await j(await anon("/api/public/atlas/stats"));
ok("signed and issued are counted separately", stats.receipts_signed <= stats.receipts_issued,
   `signed ${stats.receipts_signed} of ${stats.receipts_issued}`);

// A receipt that does not exist must not be fabricated.
const ghost = await anon("/atlas/receipt/" + "0".repeat(64));
ok("an unknown receipt hash is a 404, not an invented receipt", ghost.status === 404, `HTTP ${ghost.status}`);

console.log(out.join("\n"));
console.log(`\n  ${pass} passed, ${fail} failed   world=${W}`);
process.exit(fail ? 1 : 0);
