// atlas-verify-view.mjs — CW7 block #5: the PUBLIC verify view + reputation history read-model.
// Anyone (no auth) can: (a) verify a receipt and see what it attests, (b) see a builder's/world's
// reputation history — how the score was built from real events over time. Read-only; verify is
// injected (live atlas-sign verifyReceiptSig). Honest: an unverifiable receipt reads INVALID, never
// "trusted"; history shows real events only, nothing fabricated.

import { computeWorldReputation, computeBuilderScore, filterGamedEvents } from './atlas-trust.mjs';

// ---- (a) Public receipt verify view ----
// Given a receipt (+ injected verify), return a public, human-readable verification result.
// deps.verify(receipt) -> bool (the makeInjectedVerify wrapper over live atlas-sign).
export function publicVerifyReceipt(receipt, deps = {}) {
  const verify = deps.verify || (() => false);
  if (!receipt || !receipt.sig) {
    return { valid: false, status: 'INVALID', reason: 'no signature present', receipt: null };
  }
  const valid = verify(receipt);
  return {
    valid,
    status: valid ? 'VERIFIED' : 'INVALID',
    reason: valid ? 'signature verified against the Atlas public key' : 'signature did not verify',
    // public, non-sensitive fields only — what the receipt attests:
    receipt: {
      subject_type: receipt.subject_type ?? 'world',
      subject_id: receipt.world_id ?? receipt.subject_id,
      attested_by: receipt.builder_id ?? receipt.attested_by,
      action: receipt.action ?? receipt.attestation,
      receipt_hash: receipt.receipt_hash ?? receipt.receipt_id ?? null,
      ts: receipt.ts ?? null,
    },
    // a verifier can independently re-check via GET /api/atlas/key + the canonical body
    independently_verifiable: true,
  };
}

// ---- (b) Reputation history (how the score was built, over time) ----
// Returns the time-ordered, anti-gaming-filtered events that contributed to a world's reputation,
// plus a running score, so a public viewer sees provenance of the number (not just the number).
export function worldReputationHistory(worldId, events, opts = {}) {
  const owner = opts.worldOwner;
  const clean = filterGamedEvents(events.filter((e) => e.world_id === worldId), { worldOwner: owner })
    .slice()
    .sort((a, b) => String(a.ts ?? '').localeCompare(String(b.ts ?? '')));

  const timeline = [];
  for (let i = 0; i < clean.length; i++) {
    const upto = clean.slice(0, i + 1);
    const running = computeWorldReputation(worldId, upto, { ...opts, worldOwner: owner }).reputation;
    const e = clean[i];
    timeline.push({
      ts: e.ts ?? null,
      type: e.type,
      // only public-safe descriptors, no actor PII beyond opaque ids
      detail: e.type === 'rating' ? `rating ${e.stars}★` : e.type === 'retention' ? `retention ${Math.round((e.rate ?? 0) * 100)}%` : e.type,
      running_reputation: running,
    });
  }
  const current = computeWorldReputation(worldId, clean, { ...opts, worldOwner: owner });
  return {
    world_id: worldId,
    current_reputation: current.reputation,
    event_count: clean.length,            // gamed events already filtered out
    timeline,                              // running provenance of the score
  };
}

// Builder reputation history = each owned world's contribution + the aggregate, so the trust score
// is explainable, not opaque.
export function builderReputationHistory(builderId, worlds, events, opts = {}) {
  const theirs = worlds.filter((w) => w.builder_id === builderId);
  const worldBreakdown = theirs.map((w) => ({
    world_id: w.world_id,
    reputation: computeWorldReputation(w.world_id, events, { ...opts, worldOwner: builderId }).reputation,
  }));
  const score = computeBuilderScore(builderId, worlds, events, opts);
  return {
    builder_id: builderId,
    trust_score: score.trust_score,
    verified_by_cw7: score.verified_by_cw7,
    world_breakdown: worldBreakdown,       // which worlds drive the score
    explanation: 'trust_score = mean of owned worlds\' reputations; verification from the signed ownership chain',
  };
}
