// atlas-publish-gate.mjs — CW7 P2/P3: the publish gate + the atlas_score feed to CW1.
// P2: expose atlas_score (gates publisher level). P3: publish requires verification + Atlas score —
// an unverified / low-score user is blocked from publishing PUBLIC worlds (acceptance gate M-P3).
// Builds on atlas-trust.mjs (computeBuilderScore / buildOwnershipHistory). Pure DI, mock-buildable.
// Honest-data: a gate decision always carries its reason; nothing is silently allowed or denied.

import { computeBuilderScore, buildOwnershipHistory } from './atlas-trust.mjs';
import { levelHint } from './atlas-signing-adapter.mjs';

// Thresholds are SIMPLE DEFAULTS (tune at a real gate, not hard-tuned on guesses).
// Visibility tiers: 'private' always allowed; 'unlisted' needs verification; 'public' needs both.
export const DEFAULT_GATE = {
  min_public_score: 40,      // builder trust_score required to publish public
  min_unlisted_score: 0,     // unlisted only needs verification, not score
  require_verified_public: true,
};

// The score CW1 consumes to gate publisher level. Thin, stable shape.
// The seam CW1 consumes (freeze #4): atlas_score + verified_by_cw7 FEED CW1's level computation.
// CW1 owns the authoritative `level`; CW7 provides the trust inputs. `publisher_level_hint` is CW7's
// suggested band — advisory only, CW1's computed level wins.
// → { builder_id, atlas_score, verified, verified_by_cw7, publisher_level_hint }
export function atlasScoreForCW1(builderId, worlds, events, opts = {}) {
  const s = computeBuilderScore(builderId, worlds, events, opts);
  return {
    builder_id: builderId,
    atlas_score: s.trust_score,
    verified: s.verified,
    verified_by_cw7: s.verified_by_cw7,        // frozen enum: none|pending|verified (CW1/CW6 read this)
    publisher_level_hint: levelHint(s.trust_score, s.verified), // CW1 vocab: explorer..studio; advisory, CW1 computes canonical
  };
}

// Publisher level bands (P2 — gates what CW1 lets them do). Simple, monotonic.
function publisherLevel(score, verified) {
  if (!verified) return 'unverified';
  if (score >= 75) return 'trusted';
  if (score >= 40) return 'standard';
  return 'limited';
}

// The P3 publish gate. visibility ∈ 'private'|'unlisted'|'public'.
// Returns { allowed, reason } — reason is ALWAYS present (honest decision).
export function canPublish({ builderId, worlds, events, visibility, worldId, receipts }, opts = {}) {
  const gate = { ...DEFAULT_GATE, ...(opts.gate || {}) };
  const score = computeBuilderScore(builderId, worlds, events, opts);

  // private: always allowed (only the builder sees it)
  if (visibility === 'private') return allow('private always allowed');

  // verification check — uses the world's own ownership chain if a worldId+receipts given,
  // else the builder-level verified flag.
  let verified = score.verified;
  if (worldId && receipts) {
    const own = buildOwnershipHistory(worldId, receipts, opts);
    verified = own.verified && own.owner === builderId; // must own it AND chain intact
  }

  if (visibility === 'unlisted') {
    if (!verified) return deny('unlisted requires a verified (signed, intact-chain) world');
    if (score.trust_score < gate.min_unlisted_score) return deny(`unlisted needs score >= ${gate.min_unlisted_score}`);
    return allow('unlisted: verified');
  }

  if (visibility === 'public') {
    if (gate.require_verified_public && !verified) return deny('public requires verification');
    if (score.trust_score < gate.min_public_score) return deny(`public requires atlas_score >= ${gate.min_public_score} (have ${score.trust_score})`);
    return allow('public: verified + score met');
  }

  return deny(`unknown visibility: ${visibility}`);
}

function allow(reason) { return { allowed: true, reason }; }
function deny(reason) { return { allowed: false, reason }; }
