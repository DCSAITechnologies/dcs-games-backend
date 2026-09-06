// atlas-routes.mjs — CW7's handler for the canonical /atlas/* endpoints (api-surface C4).
// Replaces the shared mock's hardcoded stubs with REAL computed values from the trust modules,
// so CW6's Atlas tab wires against actual reputation/ownership logic over a (mock, swappable) event
// stream. Pure functions returning the exact canonical shapes; mount into any node:http server or the
// shared mock-server.mjs.
//
// Canonical shapes (api-surface.md):
//   GET /atlas/builder/:id -> { trust_score, reputation, verified }
//   GET /atlas/world/:id   -> { reputation, visits, ratings, verified, ownership_history }
//
// ---- "honest zeros" is a claim about the CORPUS, not about the arithmetic ----
//
// This file's header used to say "unknown ids return zeros/empty, never fabricated stubs", and
// RUNBOOK_INTEGRATION.md repeats it as "honest zeros for unknown ids". That is only true if a KNOWN
// id returns something other than zeros. server.mts constructs this router with
// `{ worlds: [], events: [], receipts: [], verifiedWorldIds: [] }`, so every id is unknown and the
// zeros mean nothing at all. Reproduced 7 Sep 2026 against a locally booted server.mts, one world,
// one publish, one play, in a single run:
//
//   POST /worlds/w3_fc157dc998ef4e9f/publish  -> 200 {"published":true,"signed":true}
//   GET  /atlas/receipt/3616f599...           -> 200 subject_id=w3_fc157dc998ef4e9f,
//                                                    attested_by=user-owner, sig present
//   GET  /v3/worlds/w3_fc157dc998ef4e9f/stats -> 200 {"plays":1,"unique_players":1}
//   GET  /atlas/world/w3_fc157dc998ef4e9f     -> 200 {"reputation":0,"visits":0,"ratings":0,
//                                                    "verified":false,"ownership_history":[]}
//   GET  /atlas/world/undefined               -> 200  ... byte-identical body
//
// So the public trust surface called a world unverified while the receipt surface of the same server
// verified this estate's own signature over it, and its answer for a real, signed, played world was
// indistinguishable from its answer for an id that has never existed. On a TRUST surface that is the
// worst direction for an ambiguity to run: a reader cannot tell "we have not measured this" from
// "we measured this and it is worth nothing".
//
// Two flags now separate the three states, and they are computed here rather than asserted:
//   measured — is there ANY corpus? With no worlds, no events and no receipts injected, nothing this
//              module returns is a measurement, so the numeric fields are null instead of 0. A null
//              renders as blank; a 0 renders as a verdict.
//   known    — with a corpus, does it contain this subject at all? Zeros for a subject the corpus
//              has never heard of are honest, but only if they are labelled as such.
//
// `verified` stays FAIL-CLOSED (false, never null) in every state, matching the rule the rest of CW7
// settled on: a missing verifier or a missing corpus means unverified, never verified.
//
// The corpus itself is server.mts's to inject — the durable world repository and the issued-receipt
// collection both exist there today. This module's job is to refuse to fabricate one.

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

  // Nothing injected at all -> nothing below is a measurement of anything.
  const measured = worlds.length > 0 || events.length > 0 || receipts.length > 0;
  const UNMEASURED_NOTE =
    'No world, event or receipt corpus is wired into this Atlas router, so this is the ABSENCE of a ' +
    'measurement and not a measurement of zero. The numeric fields are null for that reason. ' +
    'verified is false because trust fails closed, not because anything was checked and rejected.';

  // A number only when there is something to count; null when there is not.
  const n = (v) => (measured ? v : null);

  // GET /atlas/builder/:id
  function builder(id) {
    const s = computeBuilderScore(id, worlds, events, opts);
    const known = measured && worlds.some((w) => w.builder_id === id);
    return {
      trust_score: n(s.trust_score),
      reputation: n(s.trust_score),         // numeric reputation (canonical field)
      verified: s.verified,                 // fail-closed: never null, never true without proof
      verified_by_cw7: s.verified_by_cw7,   // frozen enum (extra, harmless to consumers reading `verified`)
      measured,
      known,
      note: describe('builder', id, known),
    };
  }

  // GET /atlas/world/:id
  function world(id) {
    const rep = computeWorldReputation(id, events, { ...opts, worldOwner: ownerOf(id) });
    const own = buildOwnershipHistory(id, receipts, opts);
    const known =
      measured &&
      (worlds.some((w) => w.world_id === id) ||
        events.some((e) => e.world_id === id) ||
        own.ownership_history.length > 0);
    return {
      reputation: n(rep.reputation),
      visits: n(rep.visits),
      ratings: n(rep.ratings),
      verified: own.verified,               // fail-closed, as above
      // An empty history is the same array whether the world is unknown or has no receipts, so it
      // carries the same caveat the numbers do rather than standing on its own.
      ownership_history: own.ownership_history,
      measured,
      known,
      note: describe('world', id, known),
    };
  }

  function describe(kind, id, known) {
    if (!measured) return UNMEASURED_NOTE;
    if (!known) {
      return `No ${kind} "${id}" appears in the corpus this Atlas router was given, so these are ` +
        `real zeros for a subject it has never seen — not a low score.`;
    }
    return null;
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

  // Exposed so a caller — /health, a deploy check, a test — can ask whether this router has anything
  // to measure with, without having to infer it from a probe response.
  function describeCorpus() {
    return {
      measured,
      worlds: worlds.length,
      events: events.length,
      receipts: receipts.length,
      verifier_injected: typeof deps.verifyReceiptSig === 'function',
      note: measured ? null : UNMEASURED_NOTE,
    };
  }

  return { builder, world, routes, describeCorpus };
}
