// atlas-routes.mjs — CW7's handler for the canonical /atlas/* endpoints (api-surface C4).
// Replaces the shared mock's hardcoded stubs with REAL computed values from the trust modules,
// so CW6's Atlas tab wires against actual reputation/ownership logic over a (mock, swappable) event
// stream. Pure functions returning the exact canonical shapes; mount into any node:http server or the
// shared mock-server.mjs. Honest-data: unknown ids return zeros/empty, never fabricated stubs.
//
// Canonical shapes (api-surface.md):
//   GET /atlas/builder/:id -> { trust_score, reputation, verified }
//   GET /atlas/world/:id   -> { reputation, visits, ratings, verified, ownership_history }

import { computeBuilderScore, computeWorldReputation, buildOwnershipHistory } from './atlas-trust.mjs';

// deps: { worlds, events, receipts, verifyReceiptSig, verifiedWorldIds }
// In production these come from CW4/CW5 (events), the world store, and live atlas-sign (verify).
export function makeAtlasRoutes(deps = {}) {
  const worlds = deps.worlds || [];
  const events = deps.events || [];
  const receipts = deps.receipts || [];
  const opts = {
    verifyReceiptSig: deps.verifyReceiptSig,
    verifiedWorldIds: deps.verifiedWorldIds || [],
  };

  // GET /atlas/builder/:id
  function builder(id) {
    const s = computeBuilderScore(id, worlds, events, opts);
    return {
      trust_score: s.trust_score,
      reputation: s.trust_score,           // numeric reputation (canonical field)
      verified: s.verified,
      verified_by_cw7: s.verified_by_cw7,  // frozen enum (extra, harmless to consumers reading `verified`)
    };
  }

  // GET /atlas/world/:id
  function world(id) {
    const rep = computeWorldReputation(id, events, { ...opts, worldOwner: ownerOf(id) });
    const own = buildOwnershipHistory(id, receipts, opts);
    return {
      reputation: rep.reputation,
      visits: rep.visits,
      ratings: rep.ratings,
      verified: own.verified,
      ownership_history: own.ownership_history,
    };
  }

  function ownerOf(worldId) {
    return (worlds.find((w) => w.world_id === worldId) || {}).builder_id;
  }

  // Convenience: route-matcher entries compatible with the shared mock-server.mjs ROUTES table shape.
  const routes = [
    ['GET', /^\/atlas\/builder\/(.+)$/, (m) => builder(m[1])],
    ['GET', /^\/atlas\/world\/(.+)$/, (m) => world(m[1])],
    // /atlas/key is LIVE (served by the backend); not mocked here.
  ];

  return { builder, world, routes };
}
