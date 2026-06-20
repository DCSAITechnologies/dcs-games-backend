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
      canonical_fields: ['attestation', 'attested_by', 'prev_hash', 'subject_type', 'subject_id'],
    };
  }

  return { key };
}
