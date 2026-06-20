// CW1 ↔ CW7 — attestation ingest (CW1 side of the frozen seam).
// CW7 owns trust/verification; it emits an Attestation. CW1 consumes it: validates, then maps it
// onto the identity signals that feed computeLevel. CW1 never computes atlas_score itself, and
// CW7 never computes level — each owns its half. Pure logic, zero deps.

import { computeLevel } from "./identity-core.mjs";

// The frozen enum (Round-3 freeze #4). NOT a boolean.
export const VERIFIED_STATES = ["none", "pending", "verified"];

const ATTESTATION_TTL_MS = 24 * 60 * 60 * 1000; // 24h — atlas_score is a rolling trust signal, not permanent

/**
 * validateAttestation — is this a well-formed, fresh CW7 attestation?
 * Shape (CW7 → CW1):
 *   { subject: user_id, atlas_score: 0..100, verified_by_cw7: none|pending|verified,
 *     reports: int>=0, issued_at: iso, sig?: <ed25519 from atlas-sign.ts> }
 * Returns {valid, reason}.
 */
export function validateAttestation(att = {}, opts = {}) {
  if (!att || typeof att !== "object") return { valid: false, reason: "no_attestation" };
  if (!att.subject) return { valid: false, reason: "missing_subject" };
  const score = Number(att.atlas_score);
  if (!Number.isFinite(score) || score < 0 || score > 100) return { valid: false, reason: "atlas_score_out_of_range" };
  if (!VERIFIED_STATES.includes(att.verified_by_cw7)) return { valid: false, reason: "verified_by_cw7_not_enum" };
  if (att.reports != null && (!Number.isInteger(att.reports) || att.reports < 0)) return { valid: false, reason: "bad_reports" };
  // freshness: an attestation older than TTL is stale → CW1 treats trust as unknown, doesn't promote on it
  if (att.issued_at) {
    const age = Date.now() - new Date(att.issued_at).getTime();
    if (Number.isFinite(age) && age > (opts.ttl || ATTESTATION_TTL_MS)) return { valid: false, reason: "stale" };
  }
  // sig is verified by CW7's verifyReceiptSig (live atlas-sign.ts ed25519) in production.
  // CW1 does NOT re-implement crypto; if opts.requireSig, a verifier must be supplied.
  if (opts.requireSig) {
    if (typeof opts.verifySig !== "function") return { valid: false, reason: "no_sig_verifier" };
    if (!opts.verifySig(att)) return { valid: false, reason: "bad_signature" };
  }
  return { valid: true, reason: "ok" };
}

/**
 * applyAttestation — fold a valid CW7 attestation into a user's identity signals.
 * Returns { user, level_before, level_after, promoted, demoted, applied }.
 * On an invalid/stale attestation: CW1 keeps the user's last-known signals and does NOT
 * promote on unverified trust (fail-safe — trust must be positively asserted, never assumed).
 */
export function applyAttestation(user, att, opts = {}) {
  const before = computeLevel(user);
  const v = validateAttestation(att, opts);
  if (!v.valid) {
    // fail-safe: on stale/invalid, hold prior signals; if conservative mode, clear trust so we don't
    // keep promoting on an expired score.
    if (opts.conservativeOnStale && v.reason === "stale") {
      user.atlas_score = 0;
      user.verified_by_cw7 = "pending";
    }
    const after = computeLevel(user); user.level_cache = after;
    return { user, level_before: before, level_after: after, promoted: false, demoted: after !== before, applied: false, reason: v.reason };
  }
  // apply: CW7 is authoritative for atlas_score, verified_by_cw7, and reports.
  user.atlas_score = Number(att.atlas_score);
  user.verified_by_cw7 = att.verified_by_cw7;
  if (att.reports != null) user.reports = att.reports;
  const after = computeLevel(user); user.level_cache = after;
  return {
    user, level_before: before, level_after: after,
    promoted: after !== before && rank(after) > rank(before),
    demoted: after !== before && rank(after) < rank(before),
    applied: true, reason: "applied"
  };
}

const ORDER = ["explorer", "builder", "publisher", "verified_builder", "studio"];
const rank = (lvl) => ORDER.indexOf(lvl);
