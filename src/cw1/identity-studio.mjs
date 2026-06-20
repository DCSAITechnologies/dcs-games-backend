// CW1 Identity — studio (P6), org (P8), portable identity (P9) logic. Pure, testable.

// ---------- P6: Studio accounts ----------
// Roles and what they can do. Computed capability, consistent with the "computed not typed" north star.
export const STUDIO_ROLES = ["owner", "admin", "editor", "viewer"];
const ROLE_CAPS = {
  owner:  { manage_members: true, edit_worlds: true, publish: true, configure_split: true, view: true, delete_studio: true },
  admin:  { manage_members: true, edit_worlds: true, publish: true, configure_split: false, view: true, delete_studio: false },
  editor: { manage_members: false, edit_worlds: true, publish: false, configure_split: false, view: true, delete_studio: false },
  viewer: { manage_members: false, edit_worlds: false, publish: false, configure_split: false, view: true, delete_studio: false }
};
export function can(role, capability) {
  return !!(ROLE_CAPS[role] && ROLE_CAPS[role][capability]);
}

/**
 * validateSplit — revenue-split config across collaborators (M-P6).
 * splits: [{ user_id, pct }]. Must sum to exactly 100, each 0<pct<=100, owner present.
 * Returns {valid, reason, normalized?}.
 */
export function validateSplit(splits, ownerId) {
  if (!Array.isArray(splits) || splits.length === 0)
    return { valid: false, reason: "no_splits" };
  let total = 0;
  const seen = new Set();
  for (const s of splits) {
    if (!s.user_id || seen.has(s.user_id)) return { valid: false, reason: "missing_or_duplicate_user" };
    seen.add(s.user_id);
    const pct = Number(s.pct);
    if (!(pct > 0 && pct <= 100)) return { valid: false, reason: "pct_out_of_range" };
    total += pct;
  }
  // floating tolerance
  if (Math.abs(total - 100) > 0.001) return { valid: false, reason: "must_sum_to_100", total };
  if (ownerId && !seen.has(ownerId)) return { valid: false, reason: "owner_must_have_a_share" };
  return { valid: true, reason: "ok", normalized: splits.map(s => ({ user_id: s.user_id, pct: Number(s.pct) })) };
}

// ---------- P8: Company / org accounts ----------
export const ORG_ROLES = ["owner", "admin", "member"];
/**
 * seatCheck — can the org add another member? seats is the licensed cap.
 */
export function seatCheck({ seats, current_members }) {
  const cap = Number(seats || 0), used = Number(current_members || 0);
  if (used >= cap) return { allowed: false, reason: "no_seats_available", seats: cap, used };
  return { allowed: true, remaining: cap - used };
}

// ---------- P9: cross-world portable identity (with CW7) ----------
/**
 * portableIdentity — the minimal, signed-by-CW7 identity a world receives when a player enters.
 * CW1 owns the shape; CW7 supplies the attestation (verified flag + atlas score). No PII leaves here.
 */
export function portableIdentity(user, cw7Attestation = {}) {
  return {
    id: user.id,
    initials: (user.name || "").split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase(),
    level: user.level_cache || null,           // computed level travels with the player
    verified_by_cw7: cw7Attestation.verified === true ? "verified"
                    : cw7Attestation.verified === false ? "none" : "pending",  // enum, not bool (per CW7 reconciliation)
    atlas_score: Number(cw7Attestation.atlas_score ?? user.atlas_score ?? 0),
    // explicitly NO email/phone/payment — portable identity is privacy-minimal
    _portable: true
  };
}
