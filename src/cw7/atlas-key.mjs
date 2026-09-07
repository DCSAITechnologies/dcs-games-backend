import { CANONICAL_FIELD_ORDER, SIGNED_FIELDS } from './atlas-local-sign.mjs';
// atlas-key.mjs — serves GET /atlas/key (CW7 mandate item: "/atlas/* + /atlas/key live").
// The public verify view + any external verifier needs the Atlas ed25519 PUBLIC key to independently
// check a receipt's signature. CW7 exposes the public key (never the private key — that stays in the
// live atlas-sign / Railway env, server-side only). The key SOURCE is injected so prod serves the real
// live key and tests serve a generated one. Honest: if no key is configured, this reports unavailable
// rather than fabricating a key.

// deps.publicKey: base64 ed25519 public key (from live atlas-sign.atlasPublicKey).
// deps.alg defaults to 'ed25519'.
export function makeKeyEndpoint(deps = {}) {
  const alg = deps.alg || 'ed25519';

  // GET /atlas/key → { alg, public_key, format } or { available:false } if not configured.
  function key() {
    const pk = typeof deps.publicKey === 'function' ? deps.publicKey() : deps.publicKey;
    if (!pk) {
      return { available: false, reason: 'atlas public key not configured (server-side atlas-sign required)' };
    }
    return {
      available: true,
      alg,
      public_key: pk,                 // base64 — browser/verifier safe (public key only)
      format: 'base64',
      // a verifier reconstructs the canonical body and checks sig with this key
      canonical_fields: CANONICAL_FIELD_ORDER,
      // The ORDER alone is not enough to rebuild the signed bytes: the signer
      // RESOLVES ALIASES and APPLIES FALLBACKS before serialising, so a receipt
      // written in the CW7 spelling (world_id/builder_id/action) has none of the
      // canonical keys on it, and a verifier doing a raw read builds "{}". The
      // rules are served alongside the order, from the same single enumeration
      // the signer uses, so an external verifier can reproduce them exactly.
      canonical_aliases: Object.fromEntries(Object.entries(SIGNED_FIELDS).map(([k, v]) => [k, v.aliases])),
      canonical_fallbacks: Object.fromEntries(Object.entries(SIGNED_FIELDS).map(([k, v]) => [k, v.fallback])),
      // ...and the ENCODING, which was the one piece an outside verifier could
      // not derive. The fields, aliases and fallbacks were published; how they
      // are serialised into the signed bytes was not, so a third party had to
      // guess. A signature that is valid in principle and unreproducible in
      // practice is not evidence of anything — the whole reason a receipt is
      // signed is that somebody who does not trust this server can check it.
      canonical_encoding: {
        form: "json-object-sorted-keys",
        // Written out as executable steps rather than prose, because the point
        // is that a verifier follows them exactly.
        steps: [
          "for each name in canonical_fields, take the first of [name, ...canonical_aliases[name]] present and non-null on the receipt",
          "if none is present, use canonical_fallbacks[name] (which may be null)",
          "coerce each value: strings, numbers and booleans as-is; anything else through JSON.stringify once, and the result must be a primitive",
          "serialise as JSON.stringify(resolved, canonical_fields.slice().sort()) — a JSON OBJECT with the canonical field names as sorted keys",
          "the signed bytes are that string in UTF-8",
        ],
        signature_encoding: "base64",
        verify: "ed25519 verify(signed_bytes, base64decode(receipt.sig), public_key)",
      },
    };
  }

  return { key };
}
