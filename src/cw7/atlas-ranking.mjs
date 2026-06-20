// atlas-ranking.mjs — CW7 P4: ranking signals (reputation + retention) feed CW6 trending.
// Anti-gaming is the M-P4 acceptance gate: trending can't be moved by self-visits / fake ratings /
// report-bombing. Builds on atlas-trust (filterGamedEvents + computeWorldReputation). Pure DI.
// CW7 produces the ranking SIGNAL; CW6 owns the trending surface. CW8 owns adversarial tests.

import { computeWorldReputation, filterGamedEvents } from './atlas-trust.mjs';

// A ranking signal blends reputation with recent retention + a recency factor. Weights = simple
// defaults (tune at a real gate). Bounded, deterministic.
const DEFAULT_RANK_WEIGHTS = { reputation: 0.6, retention: 0.3, recency: 0.1 };

// Compute a single world's trending signal from its (owner-known) event list.
// opts.now lets tests pin recency deterministically.
export function worldRankingSignal(world, events, opts = {}) {
  const w = opts.weights || DEFAULT_RANK_WEIGHTS;
  const owner = world.builder_id;
  const clean = filterGamedEvents(events.filter((e) => e.world_id === world.world_id), { worldOwner: owner });

  const reputation = computeWorldReputation(world.world_id, events, { ...opts, worldOwner: owner }).reputation; // already gaming-filtered
  const retentionEvents = clean.filter((e) => e.type === 'retention');
  const retention = retentionEvents.length
    ? retentionEvents.reduce((a, e) => a + (e.rate ?? 0), 0) / retentionEvents.length
    : 0;
  // recency: fraction of clean visits in the last `recencyWindowMs`
  const now = opts.now ?? Date.now();
  const windowMs = opts.recencyWindowMs ?? 7 * 864e5;
  const visits = clean.filter((e) => e.type === 'visit');
  const recentVisits = visits.filter((e) => e.ts && (now - Date.parse(e.ts)) <= windowMs);
  const recency = visits.length ? recentVisits.length / visits.length : 0;

  const signal =
    w.reputation * (reputation / 100) +
    w.retention * retention +
    w.recency * recency;

  return {
    world_id: world.world_id,
    ranking_signal: Number(signal.toFixed(4)),  // 0..1
    reputation, retention: Number(retention.toFixed(4)), recency: Number(recency.toFixed(4)),
  };
}

// Produce the trending list CW6 consumes: sorted, gaming-resistant.
export function trendingFeed(worlds, events, opts = {}) {
  return worlds
    .map((w) => worldRankingSignal(w, events, opts))
    .sort((a, b) => b.ranking_signal - a.ranking_signal);
}

// Report-bomb guard (M-P4): a flood of reports from few actors shouldn't tank a world's rank.
// Returns the count of DISTINCT actors reporting — CW6/CW8 can require a distinct-actor threshold.
export function distinctReporters(worldId, events) {
  const actors = new Set(events.filter((e) => e.type === 'report' && e.world_id === worldId).map((e) => e.actor_id));
  return actors.size;
}
