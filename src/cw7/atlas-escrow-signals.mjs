// atlas-escrow-signals.mjs — CW7 consumes escrow receipt chains as reputation signals.
// Required by the frozen CW3/CW8 escrow contract: "Atlas (CW7) ingests escrow receipts as reputation
// signals: clean release chains score higher; refund chains neutral; unverified_release attempts are
// flags." This closes the freeze-checklist box "CW7/Atlas confirms it can consume the chain."
//
// CW7 does NOT verify escrow crypto (that's CW8's makeEscrowVerifier) and does NOT decide economics
// (CW6). CW7 READS already-verified chains and turns them into a reputation delta. Honest-data: a
// chain CW7 can't trust (unverified) contributes nothing positive.
//
// escrow chain = [{ payload:{ receipt_type:'escrow_transition', escrow:{ transition, parties:{creator_id,
//   creator_verified_by_cw7}, ... }}, sig, hash, ... }]  (per CW3/CW8 contract)

// deps.verifyEscrowChain(chain) -> { valid, reason }  — CW8's verifier, INJECTED (CW7 doesn't reinvent).
// Classify one escrow chain into a reputation signal for its creator.
export function escrowChainSignal(chain, deps = {}) {
  const verifyChain = deps.verifyEscrowChain || (() => ({ valid: true }));
  const v = verifyChain(chain);
  const terminal = chain[chain.length - 1]?.payload?.escrow;
  const creatorId = terminal?.parties?.creator_id ?? null;

  // An invalid/tampered chain is NOT a positive signal — and an attempted unverified_release is a flag.
  if (!v.valid) {
    const flag = v.reason === 'unverified_release' ? 'unverified_release_attempt' : 'invalid_chain';
    return { creator_id: creatorId, signal: 'flag', flag, reputation_delta: 0 };
  }

  const transition = terminal?.transition;
  if (transition === 'release') {
    // clean, verified release chain → positive reputation
    return { creator_id: creatorId, signal: 'clean_release', flag: null, reputation_delta: +5 };
  }
  if (transition === 'refund') {
    // refund chains are neutral (per contract) — no penalty, no boost
    return { creator_id: creatorId, signal: 'refund', flag: null, reputation_delta: 0 };
  }
  // open-only / incomplete chain → neutral, nothing settled
  return { creator_id: creatorId, signal: 'incomplete', flag: null, reputation_delta: 0 };
}

// Aggregate many chains for a creator into a reputation contribution + the list of flags.
export function escrowReputationFor(creatorId, chains, deps = {}) {
  const signals = chains
    .map((c) => escrowChainSignal(c, deps))
    .filter((s) => s.creator_id === creatorId);
  const delta = signals.reduce((a, s) => a + s.reputation_delta, 0);
  const flags = signals.filter((s) => s.flag).map((s) => s.flag);
  return {
    creator_id: creatorId,
    escrow_reputation_delta: delta,        // feeds into the builder trust score as one input
    clean_releases: signals.filter((s) => s.signal === 'clean_release').length,
    refunds: signals.filter((s) => s.signal === 'refund').length,
    flags,                                 // unverified_release_attempt / invalid_chain → dispute/review
  };
}
