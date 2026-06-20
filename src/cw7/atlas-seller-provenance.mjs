// atlas-seller-provenance.mjs — CW7 P5 + P6.
// P5: verified-seller gating — revenue is tied to reputation; only verified, sufficient-score builders
//     may sell. CW7 owns the SELL ELIGIBILITY decision; CW6/CW8 own the actual money flow (DARK until
//     DK flips). This module returns eligibility + reason, never moves money.
// P6: provenance for sellable AI agents/assets — a verifiable origin/ownership chain from receipts,
//     so a buyer can confirm who authored an asset and that it wasn't tampered.
// Pure DI, builds on atlas-trust. Honest-data: eligibility always carries a reason; money stays DARK.

import { computeBuilderScore, buildOwnershipHistory } from './atlas-trust.mjs';

// ---------- P5: verified-seller gating ----------
// Selling requires a higher bar than publishing (real money at stake). Simple defaults; tune at gate.
export const DEFAULT_SELLER_GATE = {
  min_seller_score: 60,       // higher than publish (40) — money raises the bar
  require_verified: true,
  require_no_recent_strikes: true,
};

// → { eligible, reason, money_flow: 'DARK' }  — money_flow is ALWAYS 'DARK' here (CW6/CW8 + DK own it)
export function sellerEligibility({ builderId, worlds, events, opts = {} }) {
  const gate = { ...DEFAULT_SELLER_GATE, ...(opts.gate || {}) };
  const score = computeBuilderScore(builderId, worlds, events, opts);

  const deny = (reason) => ({ eligible: false, reason, money_flow: 'DARK' });
  const allow = (reason) => ({ eligible: true, reason, money_flow: 'DARK' });

  if (gate.require_verified && !score.verified) return deny('seller must be verified');
  if (score.trust_score < gate.min_seller_score) return deny(`seller needs score >= ${gate.min_seller_score} (have ${score.trust_score})`);
  if (gate.require_no_recent_strikes && (opts.recentStrikes ?? 0) > 0) return deny('seller has unresolved strikes');
  return allow('verified + score met; revenue eligibility ON (money flow remains DARK until DK flips)');
}

// ---------- P6: provenance for sellable agents/assets ----------
// asset receipts: [{ receipt_id, asset_id, author_id, action:'create'|'derive'|'transfer',
//                    prev_receipt_id, ts, sig, parent_asset_id? }]
// Returns a verifiable provenance record a buyer can check before purchase.
export function assetProvenance(assetId, receipts, deps = {}) {
  const verify = deps.verifyReceiptSig || (() => true);
  const chain = receipts
    .filter((r) => r.asset_id === assetId)
    .filter((r) => verify(r))
    .sort((a, b) => (a.ts || '').localeCompare(b.ts || ''));

  let intact = true;
  let prevId = null;
  const lineage = [];
  let author = null;
  let currentOwner = null;
  for (const r of chain) {
    if (r.action === 'create') {
      if (lineage.length > 0) intact = false;
      author = r.author_id; currentOwner = r.author_id;
      lineage.push({ action: 'create', by: r.author_id, ts: r.ts, receipt_id: r.receipt_id });
      prevId = r.receipt_id;
    } else if (r.action === 'derive') {
      if (r.prev_receipt_id !== prevId) intact = false;
      lineage.push({ action: 'derive', by: r.author_id, from: r.parent_asset_id ?? null, ts: r.ts, receipt_id: r.receipt_id });
      prevId = r.receipt_id;
    } else if (r.action === 'transfer') {
      if (r.prev_receipt_id !== prevId) intact = false;
      currentOwner = r.author_id; // 'author_id' holds the new owner on transfer
      lineage.push({ action: 'transfer', to: r.author_id, ts: r.ts, receipt_id: r.receipt_id });
      prevId = r.receipt_id;
    }
  }
  return {
    asset_id: assetId,
    original_author: author,
    current_owner: currentOwner,
    lineage,
    chain_intact: intact,
    provenance_verified: intact && lineage.length > 0,   // buyer-facing: trust this origin?
    is_derivative: lineage.some((l) => l.action === 'derive'),
  };
}

// A sellable asset must have verified provenance AND a verified seller (composes P5+P6).
export function canSellAsset({ assetId, receipts, builderId, worlds, events, opts = {} }) {
  const prov = assetProvenance(assetId, receipts, opts);
  const seller = sellerEligibility({ builderId, worlds, events, opts });
  const deny = (reason) => ({ allowed: false, reason, money_flow: 'DARK' });
  if (!prov.provenance_verified) return deny('asset provenance not verified (broken/forged chain)');
  if (prov.current_owner !== builderId) return deny('seller is not the current owner of the asset');
  if (!seller.eligible) return deny(`seller ineligible: ${seller.reason}`);
  return { allowed: true, reason: 'verified provenance + eligible seller', money_flow: 'DARK' };
}
