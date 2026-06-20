// atlas-cross-product.mjs — CW7 Part B: the cross-product reputation seam (Games ↔ Sports ↔ Atlas).
// A creator's trust should be PORTABLE across DCS products. Each product produces a per-product
// portable identity (Games via portableIdentity; Sports/others via the same shape). This seam
// composes them into ONE reconciled cross-product reputation, re-verifying each product's proof
// anchors so the unified score is earned, not self-asserted.
//
// Delivery constraint (handover): a clean GATEWAY-MOUNTABLE router that reconciles overlap — NOT a
// separate server. So this exports a route table the gateway mounts, with all data sources injected.
//
// Honest discipline: a product's contribution counts ONLY if its proof anchors re-verify against that
// product's /atlas/key. Unverifiable contributions are excluded (and reported), never silently trusted.

import { verifyPortableIdentity } from './atlas-portable-identity.mjs';

// A "product identity" is { product, identity, verifyReceiptSig, receiptStore } where identity is the
// output of that product's portableIdentity(...). reconcileCrossProduct re-verifies each and merges.
export function reconcileCrossProduct(subjectId, productIdentities = [], opts = {}) {
  const contributions = [];
  for (const p of productIdentities) {
    if (!p || !p.identity) continue;
    // identity must be for THIS subject (reconcile overlap: same creator across products)
    if (p.identity.builder_id !== subjectId && p.identity.subject_id !== subjectId) continue;

    const check = verifyPortableIdentity(p.identity, {
      verifyReceiptSig: p.verifyReceiptSig,
      receiptStore: p.receiptStore || [],
    });
    contributions.push({
      product: p.product,
      atlas_score: p.identity.atlas_score ?? 0,
      verified: !!p.identity.verified,
      proof_valid: check.portable_proof_valid,
      accepted: check.accepted,                 // only accepted products count toward the unified score
      reason: check.accepted ? 'proof anchors re-verified' : 'proof did not re-verify — excluded',
    });
  }

  const accepted = contributions.filter((c) => c.accepted);
  // unified score = max of accepted per-product scores (reputation doesn't sum across products — a
  // creator's standing is their best earned, re-verified standing), with a small multi-product bonus.
  const base = accepted.length ? Math.max(...accepted.map((c) => c.atlas_score)) : 0;
  const breadthBonus = Math.min(10, Math.max(0, accepted.length - 1) * 5); // +5 per extra verified product, cap 10
  const unified = Math.min(100, base + (base > 0 ? breadthBonus : 0));

  return {
    subject_id: subjectId,
    unified_reputation: unified,
    verified_across: accepted.map((c) => c.product),
    products: contributions,                    // full transparency incl. excluded ones + why
    cross_product_verified: accepted.length >= 2, // trusted in 2+ products = genuinely portable
    note: 'unified = best re-verified per-product score + breadth bonus; unverifiable products excluded',
  };
}

// Gateway-mountable router. The gateway injects resolvers that fetch each product's portable identity
// (Games from this Atlas service; Sports from the Sports Atlas; etc.). No separate server.
//   deps.resolveProductIdentities(subjectId) -> [ {product, identity, verifyReceiptSig, receiptStore} ]
export function makeCrossProductRouter(deps = {}) {
  const resolve = deps.resolveProductIdentities || (() => []);

  function reputation(subjectId) {
    return reconcileCrossProduct(subjectId, resolve(subjectId), deps);
  }

  function routeTable() {
    return [
      // GET /api/atlas/cross/:subjectId -> unified cross-product reputation
      ['GET', /^\/api\/atlas\/cross\/(.+)$/, (m) => reputation(m[1])],
    ];
  }

  return { reputation, routeTable };
}
