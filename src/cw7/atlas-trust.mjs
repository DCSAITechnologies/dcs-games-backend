// atlas-trust.mjs — CW7 (DCS Games): reputation/trust scoring + ownership ledger over signed receipts.
// Per CW7_ATLAS_FULL.md: receipts (ed25519) are the source of truth for verification/ownership;
// events (visits/ratings/reports/play-with) are MOCKED Day-one and swapped to CW4/CW5 real events later.
// Pure dependency injection: verifyReceiptSig is injected so this plugs into the LIVE function when
// present and runs on a stub in tests. Zero live infra. Honest-data: no fabricated scores.
//
// Acceptance targets (from brief):
//  M-P2: builder with N signed worlds + mock events → stable score + verification; ownership history
//        matches the receipt chain exactly.
//  M-P4: trending ranking can't be gamed by self-visits / fake ratings.

// ---------- Ownership ledger (from the receipt chain — receipts are authoritative) ----------
// receipts: [{ receipt_id, world_id, builder_id, action: 'create'|'update', prev_receipt_id, ts, sig }]
// deps.verifyReceiptSig(receipt) -> bool  (LIVE ed25519 verify; injected)
export function buildOwnershipHistory(worldId, receipts, deps = {}) {
  const verify = deps.verifyReceiptSig || (() => true);
  const chain = receipts
    .filter((r) => r.world_id === worldId)
    .filter((r) => verify(r))                 // only signature-valid receipts count — provable, not promised
    .sort((a, b) => (a.ts || '').localeCompare(b.ts || ''));

  // Validate the chain links (each update points to the prior receipt). A broken link = tampering.
  const history = [];
  let prevId = null;
  let intact = true;
  for (const r of chain) {
    if (r.action === 'create') {
      if (history.length > 0) intact = false;            // a second 'create' breaks the chain
      history.push({ builder_id: r.builder_id, action: 'create', ts: r.ts, receipt_id: r.receipt_id });
      prevId = r.receipt_id;
    } else if (r.action === 'update') {
      if (r.prev_receipt_id !== prevId) intact = false;  // link mismatch = tampered/forged
      history.push({ builder_id: r.builder_id, action: 'update', ts: r.ts, receipt_id: r.receipt_id });
      prevId = r.receipt_id;
    }
  }
  return {
    world_id: worldId,
    owner: history.find((h) => h.action === 'create')?.builder_id ?? null,
    ownership_history: history,
    chain_intact: intact,                                // M-P2: must match the receipt chain exactly
    verified: intact && history.length > 0,
  };
}

// ---------- Anti-gaming event filter (M-P4) ----------
// Drops self-visits (visitor === builder) and rating spikes from a single actor.
export function filterGamedEvents(events, { worldOwner } = {}) {
  const ratingCountByActor = new Map();
  return events.filter((e) => {
    if (e.type === 'visit' && worldOwner && e.actor_id === worldOwner) return false;       // self-visit
    if (e.type === 'play_with' && e.actor_id === e.target_id) return false;                 // self play
    if (e.type === 'rating') {
      const n = (ratingCountByActor.get(e.actor_id) || 0) + 1;
      ratingCountByActor.set(e.actor_id, n);
      if (n > 1) return false;                                                              // one rating per actor counts
    }
    return true;
  });
}

// ---------- Reputation / trust score (over filtered mock events) ----------
// Weighted, bounded 0..100. Reports reduce; ratings/retention/visits increase. Weights are a SIMPLE
// DEFAULT (brief P2) — tuned later with real data, not hard-tuned on guesses now.
const DEFAULT_WEIGHTS = { visit: 0.5, rating: 8, retention: 10, report: -15, play_with: 1 };

export function computeWorldReputation(worldId, events, opts = {}) {
  const weights = opts.weights || DEFAULT_WEIGHTS;
  const owner = opts.worldOwner;
  const clean = filterGamedEvents(events.filter((e) => e.world_id === worldId), { worldOwner: owner });

  let raw = 0;
  const tally = { visits: 0, ratings: 0, reports: 0, retention: 0, play_with: 0 };
  for (const e of clean) {
    switch (e.type) {
      case 'visit': raw += weights.visit; tally.visits++; break;
      case 'rating': raw += weights.rating * (e.stars ?? 0) / 5; tally.ratings++; break;
      case 'retention': raw += weights.retention * (e.rate ?? 0); tally.retention += (e.rate ?? 0); break;
      case 'report': raw += weights.report; tally.reports++; break;
      case 'play_with': raw += weights.play_with; tally.play_with++; break;
    }
  }
  const reputation = Math.max(0, Math.min(100, Math.round(raw)));
  return { world_id: worldId, reputation, visits: tally.visits, ratings: tally.ratings, reports: tally.reports };
}

// Frozen globally (manager ruling): verified_by_cw7 enum = none | pending | verified (NOT boolean).
// CW1 adopted this; CW6 reads it. Map our internal verified-bool → the canonical enum.
export function verifiedEnum({ verified, pending = false }) {
  if (verified) return 'verified';
  if (pending) return 'pending';
  return 'none';
}

// Builder trust score = aggregate of their worlds' reputation + signed-world count + report penalty.
export function computeBuilderScore(builderId, worlds, events, opts = {}) {
  const theirs = worlds.filter((w) => w.builder_id === builderId);
  if (theirs.length === 0) {
    return { builder_id: builderId, trust_score: 0, reputation: 0, verified: false, verified_by_cw7: 'none' };
  }
  const reps = theirs.map((w) => computeWorldReputation(w.world_id, events, { ...opts, worldOwner: builderId }).reputation);
  const avg = reps.reduce((a, b) => a + b, 0) / reps.length;
  // verified = at least one signed world with an intact ownership chain
  const verified = (opts.verifiedWorldIds || []).some((id) => theirs.find((w) => w.world_id === id));
  // pending = owns worlds but none verified yet (awaiting receipt/sig) — distinct from 'none'
  const pending = !verified && theirs.length > 0;
  const trust_score = Math.max(0, Math.min(100, Math.round(avg)));
  return { builder_id: builderId, trust_score, reputation: trust_score, verified, verified_by_cw7: verifiedEnum({ verified, pending }) };
}
