// atlas-embed.mjs — CW7 v3.0 "public verify ecosystem": an EMBEDDABLE widget an external site drops
// in to independently verify an Atlas receipt against /atlas/key. The point of v3.0's acceptance —
// "an external site embeds + independently verifies a receipt via /atlas/key" — is that trust is
// portable: a third party verifies WITHOUT trusting our API to tell the truth; it fetches the public
// key and checks the signature itself. This module produces the embed snippet + the client verify
// logic (as a string the host inlines) that does exactly that.

const ATLAS_BASE = 'https://api.games.dcsai.ai';

// Returns an HTML+JS snippet an external site pastes in. It fetches /atlas/key, rebuilds the canonical
// body from the receipt, and verifies the ed25519 signature IN THE BROWSER via WebCrypto — so the
// verification does not trust our verify endpoint, only the public key.
export function embedSnippet({ receiptId, base = ATLAS_BASE, elementId = 'atlas-verify' } = {}) {
  const safeId = sanitizeId(receiptId);
  const safeBase = sanitizeBase(base);
  return `<div id="${escAttr(elementId)}" data-atlas-receipt="${escAttr(safeId)}">Verifying…</div>
<script>(${clientVerifier.toString()})(${JSON.stringify({ base: safeBase, elementId, receiptId: safeId })});</script>`;
}

// Receipt ids are opaque tokens/hashes — restrict to a safe charset so nothing can break out of the
// attribute or the script context. Anything outside [A-Za-z0-9_.:-] is stripped.
function sanitizeId(s) { return String(s ?? '').replace(/[^A-Za-z0-9_.:-]/g, ''); }
function sanitizeBase(s) { return /^https:\/\/[A-Za-z0-9.\-/]+$/.test(String(s)) ? s : ATLAS_BASE; }

// The client-side verifier (serialized into the snippet). Runs on the external site.
// It: fetches the receipt's public fields + sig, fetches /atlas/key, and verifies with WebCrypto.
export function clientVerifier(cfg) {
  var el = document.getElementById(cfg.elementId);
  function show(status, detail) {
    el.textContent = (status === 'VERIFIED' ? '\u2713 ' : '\u2717 ') + status + (detail ? ' — ' + detail : '');
    el.setAttribute('data-status', status);
  }
  function canonicalBody(r, fields, aliases, fallbacks) {
    // Resolve exactly as the signer does. The ORDER alone is not enough: the
    // signer resolves aliases and applies fallbacks before serialising, so a
    // receipt written in the CW7 spelling has none of the canonical keys on it
    // and a raw read builds "{}". /atlas/key serves the rules for this reason.
    // Built from the field list the SERVER serves, never from a list restated
    // here. This function used to name the five fields in its own order, which
    // did not match the signer's sorted order, so every genuine receipt showed
    // INVALID in the widget. A verifier must follow the signer, not agree with
    // it by hand.
    var b = {};
    for (var i = 0; i < fields.length; i++) {
      var f = fields[i], v = r[f];
      var alt = (aliases && aliases[f]) || [];
      for (var j = 0; j < alt.length && (v === undefined || v === null); j++) v = r[alt[j]];
      if (v === undefined || v === null) v = fallbacks && f in fallbacks ? fallbacks[f] : null;
      b[f] = v === undefined ? null : v;
    }
    return JSON.stringify(b, fields);
  }
  Promise.all([
    fetch(cfg.base + '/api/atlas/receipt/' + encodeURIComponent(cfg.receiptId)).then(function (x) { return x.json(); }),
    fetch(cfg.base + '/api/atlas/key').then(function (x) { return x.json(); })
  ]).then(function (res) {
    var receipt = res[0], key = res[1];
    if (!key || !key.public_key) return show('UNVERIFIABLE', 'no public key');
    // import the ed25519 public key + verify the signature over the canonical body
    var raw = Uint8Array.from(atob(key.public_key), function (c) { return c.charCodeAt(0); });
    var sig = Uint8Array.from(atob(receipt.sig), function (c) { return c.charCodeAt(0); });
    // If the server did not tell us the field order, we cannot rebuild the
    // signed bytes; guessing would produce a confident wrong answer.
    if (!key.canonical_fields || !key.canonical_fields.length) return show('UNVERIFIABLE', 'server did not publish the canonical field order');
    var msg = new TextEncoder().encode(canonicalBody(receipt, key.canonical_fields, key.canonical_aliases, key.canonical_fallbacks));
    crypto.subtle.importKey('raw', raw, { name: 'Ed25519' }, false, ['verify']).then(function (pk) {
      return crypto.subtle.verify({ name: 'Ed25519' }, pk, sig, msg);
    }).then(function (okSig) {
      show(okSig ? 'VERIFIED' : 'INVALID', okSig ? 'signature checks out' : 'signature mismatch');
    }).catch(function () { show('UNVERIFIABLE', 'verify error'); });
  }).catch(function () { show('UNVERIFIABLE', 'fetch error'); });
}

// A JSON descriptor for programmatic embedders (the "API" half of the verify ecosystem).
export function embedDescriptor({ receiptId, base = ATLAS_BASE } = {}) {
  return {
    receipt_id: receiptId,
    verify_independently: {
      steps: [
        'GET ' + base + '/api/atlas/key  → { alg:"ed25519", public_key }',
        'GET ' + base + '/api/atlas/receipt/' + receiptId + '  → receipt + sig',
        'rebuild canonical body {attestation, attested_by, prev_hash, subject_type, subject_id} (keys sorted)',
        'ed25519 verify(sig, body, public_key) in your own runtime',
      ],
      trustless: true, // the embedder does not have to trust our verify endpoint
    },
    embed_html: embedSnippet({ receiptId, base }),
  };
}

function escAttr(s) { return String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
