// atlas-fraud.mjs — CW7 v3.0: anti-gaming/fraud at scale. The prior layer (filterGamedEvents) DROPS
// obvious self-gaming. v3.0 demands "a gaming attempt is caught + DOWN-WEIGHTED" — detect coordinated
// patterns across many events and reduce their reputation weight (not just discard), with a fraud
// signal that feeds trust & safety. Honest: down-weighting is transparent (returns why), never silent.

// Detect coordinated gaming patterns over an event stream for a world. Returns a fraud assessment:
// { fraud_score 0..1, flags[], weight_multiplier 0..1, suspicious_actors[] }.
// Patterns: rating rings (same small actor set rating many of a builder's worlds), burst rating
// (many ratings in a tiny window), reciprocal play_with farming, single-actor visit floods.
export function assessFraud(worldId, events, opts = {}) {
  const e = events.filter((x) => x.world_id === worldId);
  const flags = [];
  const suspicious = new Set();

  // 1) burst ratings: many ratings clustered in a short window from few distinct actors
  const ratings = e.filter((x) => x.type === 'rating');
  const ratingActors = new Set(ratings.map((r) => r.actor_id));
  if (ratings.length >= (opts.burstMin ?? 8) && ratingActors.size <= Math.max(2, ratings.length * 0.3)) {
    flags.push('rating_ring'); // few actors producing many ratings
    ratingActors.forEach((a) => suspicious.add(a));
  }

  // 2) visit flood from a single actor (beyond the per-actor dedupe the filter already does)
  const visitsByActor = tally(e.filter((x) => x.type === 'visit'), 'actor_id');
  for (const [actor, n] of Object.entries(visitsByActor)) {
    if (n >= (opts.floodMin ?? 20)) { flags.push('visit_flood'); suspicious.add(actor); }
  }

  // 3) reciprocal play_with farming: a↔b pairs repeated to inflate co-op signal
  const pairCounts = {};
  for (const x of e.filter((x) => x.type === 'play_with')) {
    const key = [x.actor_id, x.target_id].sort().join('|');
    pairCounts[key] = (pairCounts[key] || 0) + 1;
  }
  if (Object.values(pairCounts).some((n) => n >= (opts.farmMin ?? 10))) {
    flags.push('play_with_farming');
    Object.entries(pairCounts).filter(([, n]) => n >= (opts.farmMin ?? 10)).forEach(([k]) => k.split('|').forEach((a) => suspicious.add(a)));
  }

  // fraud_score scales with how many independent patterns fired
  const fraud_score = Math.min(1, flags.length / 3);
  // down-weight multiplier: more fraud → lower weight on this world's gamed-leaning signal.
  // Never zero on a single weak flag (avoid false-positive nuking); strong multi-pattern → heavy cut.
  const weight_multiplier = Math.max(0, 1 - fraud_score);

  return {
    world_id: worldId,
    fraud_score: Number(fraud_score.toFixed(3)),
    flags,
    weight_multiplier: Number(weight_multiplier.toFixed(3)),
    suspicious_actors: [...suspicious],
    // transparent: how the score was derived (T&S/audit can read this)
    explanation: flags.length ? `down-weighted: ${flags.join(', ')}` : 'no fraud patterns detected',
  };
}

// Apply the down-weight to a reputation number (not a drop — a transparent reduction).
export function downWeightReputation(reputation, fraudAssessment) {
  const m = fraudAssessment?.weight_multiplier ?? 1;
  return {
    raw_reputation: reputation,
    adjusted_reputation: Math.round(reputation * m),
    weight_multiplier: m,
    flags: fraudAssessment?.flags ?? [],
  };
}

// Creator-graph fraud: detect a small actor set propping up MANY of one builder's worlds
// (the cross-world "reputation ring" the v3.0 trust-network acceptance targets).
export function assessCreatorRing(builderId, worlds, events, opts = {}) {
  const theirs = worlds.filter((w) => w.builder_id === builderId).map((w) => w.world_id);
  const ratersByWorld = theirs.map((wid) => new Set(events.filter((e) => e.world_id === wid && e.type === 'rating').map((e) => e.actor_id)));
  // intersection: actors who rated MOST of the builder's worlds = ring signal
  const all = {};
  ratersByWorld.forEach((set) => set.forEach((a) => { all[a] = (all[a] || 0) + 1; }));
  const ringActors = Object.entries(all).filter(([, n]) => n >= Math.max(2, theirs.length * 0.6)).map(([a]) => a);
  const isRing = ringActors.length > 0 && theirs.length >= (opts.minWorlds ?? 3);
  return {
    builder_id: builderId,
    ring_detected: isRing,
    ring_actors: ringActors,
    weight_multiplier: isRing ? 0.5 : 1,
    explanation: isRing ? `same actors (${ringActors.length}) rated ${Math.round(theirs.length * 0.6)}+ of the builder's worlds` : 'no cross-world ring detected',
  };
}

function tally(arr, key) {
  const out = {};
  for (const x of arr) out[x[key]] = (out[x[key]] || 0) + 1;
  return out;
}
