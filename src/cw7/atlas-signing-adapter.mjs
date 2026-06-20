// atlas-signing-adapter.mjs — reconciles CW7's receipt shape to the LIVE atlas-sign interface
// (from _SHARED_Day0/_frozen_lane_contracts/LIVE_atlas-sign.interface.md). This is the wiring my
// Round-3 order called for: inject the real verifyReceiptSig against the canonical payload.
//
// Live signed body (keys sorted): { attestation, attested_by, prev_hash, subject_type, subject_id }
//   ts / receipt_hash / sig are NOT in the signed body.
// CW7 receipt  -> live payload:
//   world_id        -> subject_id   (subject_type:'world')
//   builder_id      -> attested_by
//   action          -> attestation
//   prev_receipt_id -> resolve to prior receipt_hash -> prev_hash
//   ts, receipt_id  -> CW7 metadata (unsigned)

// Map one CW7 receipt to the canonical signed payload. prevHashOf resolves prev_receipt_id→prev_hash.
export function toCanonicalPayload(cw7Receipt, prevHashOf = () => null) {
  return {
    attestation: cw7Receipt.action,                 // 'create' | 'update' (world) etc.
    attested_by: cw7Receipt.builder_id,
    prev_hash: cw7Receipt.prev_receipt_id ? prevHashOf(cw7Receipt.prev_receipt_id) : null,
    subject_type: cw7Receipt.subject_type || 'world',
    subject_id: cw7Receipt.world_id ?? cw7Receipt.asset_id,
  };
}

// Wrap the LIVE verifyReceiptSig so CW7's modules (which call verify(cw7Receipt)) can inject it.
// liveVerify is the real atlas-sign.verifyReceiptSig(receiptWithSig)->bool.
// We reconstruct the canonical receipt {payload..., receipt_hash, sig} the live fn expects.
export function makeInjectedVerify(liveVerify, { prevHashOf } = {}) {
  return function verify(cw7Receipt) {
    if (!cw7Receipt || !cw7Receipt.sig) return false;     // no signature → not verifiable
    const payload = toCanonicalPayload(cw7Receipt, prevHashOf);
    const canonicalReceipt = {
      ...payload,
      receipt_hash: cw7Receipt.receipt_hash ?? cw7Receipt.receipt_id, // live fn recomputes/compares
      sig: cw7Receipt.sig,
    };
    return !!liveVerify(canonicalReceipt);
  };
}

// CW1 owns the canonical level vocabulary (api-surface: explorer→builder→publisher→verified_builder→studio).
// CW7's publisher_level_hint must speak THAT vocabulary, advisory only. Map score+verified → CW1 level term.
// CW1 owns level computation; these thresholds are CW1's canonical values (Round-4 dispatch):
//   atlas_score >=20 -> publisher, >=50 -> verified_builder, >=60 -> studio.
// CW7's hint MUST match CW1's thresholds so the advisory never contradicts CW1's computed level.
export function levelHint(atlasScore, verified) {
  if (verified && atlasScore >= 60) return 'studio';
  if (verified && atlasScore >= 50) return 'verified_builder';
  if (atlasScore >= 20) return 'publisher';
  if (atlasScore > 0) return 'builder';
  return 'explorer';
}
