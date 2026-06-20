// atlas-portable-identity.mjs — CW7 P9: portable identity + reputation across worlds.
// One builder/player identity whose reputation aggregates across every world they touch, portable and
// verifiable — anchored to the receipt chain (provable, not self-declared). Builds on atlas-trust +
// ranking. Pure DI. Honest-data: a portable identity only claims what the receipts + events support.

import { computeBuilderScore } from './atlas-trust.mjs';
import { worldRankingSignal } from './atlas-ranking.mjs';

// Build a portable identity record for a builder across all their worlds.
// → { builder_id, atlas_score, verified, worlds:[...], aggregate:{...}, portable_proof }
export function portableIdentity(builderId, worlds, events, receipts, opts = {}) {
  const theirs = worlds.filter((w) => w.builder_id === builderId);
  const score = computeBuilderScore(builderId, worlds, events, opts);

  const worldSummaries = theirs.map((w) => {
    const sig = worldRankingSignal(w, events, opts);
    return { world_id: w.world_id, reputation: sig.reputation, ranking_signal: sig.ranking_signal };
  });

  const totalWorlds = theirs.length;
  const avgReputation = totalWorlds
    ? Math.round(worldSummaries.reduce((a, w) => a + w.reputation, 0) / totalWorlds)
    : 0;

  // portable_proof: the set of signed create-receipts that anchor this identity's claims. A consumer
  // in ANOTHER context can re-verify these against /atlas/key — that's what makes the identity portable
  // rather than a self-asserted profile.
  const verify = opts.verifyReceiptSig || (() => true);
  const anchors = (receipts || [])
    .filter((r) => r.builder_id === builderId && r.action === 'create' && verify(r))
    .map((r) => ({ world_id: r.world_id, receipt_id: r.receipt_id, ts: r.ts }));

  return {
    builder_id: builderId,
    atlas_score: score.trust_score,
    verified: score.verified,
    worlds: worldSummaries,
    aggregate: { total_worlds: totalWorlds, avg_reputation: avgReputation },
    portable_proof: anchors,            // re-verifiable elsewhere → portable
    portable: anchors.length > 0 && score.verified,
  };
}

// Verify a portable identity presented in another context: re-check its proof anchors.
// This is what a DIFFERENT world/platform does when a player brings their identity over.
export function verifyPortableIdentity(identity, deps = {}) {
  const verify = deps.verifyReceiptSig || (() => true);
  // re-resolve the anchors against the (injected) receipt store + signature check
  const store = deps.receiptStore || [];
  const checks = identity.portable_proof.map((p) => {
    const r = store.find((x) => x.receipt_id === p.receipt_id);
    return { receipt_id: p.receipt_id, present: !!r, valid: !!r && verify(r) };
  });
  const allValid = checks.length > 0 && checks.every((c) => c.valid);
  return {
    builder_id: identity.builder_id,
    portable_proof_valid: allValid,         // every anchor re-verified
    checks,
    // honest: an identity whose proofs don't re-verify is NOT accepted, regardless of its claimed score
    accepted: allValid && identity.verified,
  };
}
