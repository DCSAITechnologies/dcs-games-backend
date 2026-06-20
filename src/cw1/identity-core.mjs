// CW1 Identity — core rules: computed level + publish-credit enforcement.
// North star: ONE Builder Account. Capabilities are COMPUTED, never separate account types.
// Pure functions, zero deps — the production Identity service implements these same rules.

// Level tiers (ordered). Computed from signals, never stored as an account "type".
export const LEVELS = ["explorer", "builder", "publisher", "verified_builder", "studio"];

/**
 * computeLevel — derive a user's level from their signals.
 * Inputs (all from owned tables / CW7 atlas_score / CW8 dcs_plus):
 *   email_verified, phone_verified : bool
 *   atlas_score                    : number (0..100, from CW7; null/0 if unknown)
 *   dcs_plus                       : bool   (subscription state, read from CW8)
 *   active_players                 : number (across this user's published worlds)
 *   reports                        : number (moderation reports against them)
 *   is_studio                      : bool   (has a studio account / collaborators)
 */
export function computeLevel(s = {}) {
  const email = !!s.email_verified;
  const phone = !!s.phone_verified;
  const atlas = Number(s.atlas_score || 0);
  const plus = !!s.dcs_plus;
  const players = Number(s.active_players || 0);
  const reports = Number(s.reports || 0);
  const studio = !!s.is_studio;

  // studio: explicit studio account, must be in good standing + a real audience
  if (studio && email && phone && atlas >= 60 && players >= 100 && reports < 5) return "studio";
  // verified_builder: identity proven + strong trust + real players
  if (email && phone && atlas >= 50 && players >= 10 && reports < 5) return "verified_builder";
  // publisher: can publish to the public — needs verified email at minimum + some trust
  if (email && atlas >= 20 && reports < 10) return "publisher";
  // builder: signed in and started building (email on file)
  if (email) return "builder";
  // explorer: default — anyone can play/explore
  return "explorer";
}

// Publish-credit allowance by level (acceptance gate M-P3).
// Free → 1, DCS+ → 10, Verified → ∞. Enforced SERVER-SIDE at publish (with CW2).
export function publishCredits({ level, dcs_plus } = {}) {
  if (level === "verified_builder" || level === "studio") return Infinity;
  if (dcs_plus) return 10;
  // explorer/builder/publisher without DCS+ get the free allowance
  return 1;
}

/**
 * canPublish — the server-side gate. Returns {allowed, remaining, reason}.
 * published_count = worlds this user has already published.
 * This is what blocks a free user at world #2 (M-P3).
 */
export function canPublish({ level, dcs_plus, published_count } = {}) {
  const cap = publishCredits({ level, dcs_plus });
  const used = Number(published_count || 0);
  if (cap === Infinity) return { allowed: true, remaining: Infinity, reason: "unlimited" };
  const remaining = Math.max(0, cap - used);
  if (remaining <= 0) {
    return { allowed: false, remaining: 0,
      reason: dcs_plus ? "dcs_plus_credit_limit_reached" : "free_credit_limit_reached_upgrade_or_verify" };
  }
  return { allowed: true, remaining, reason: "within_credits" };
}

// Build the /me payload shape (contract-exact).
export function buildMe(user = {}) {
  const level = computeLevel(user);
  return {
    id: user.id,
    name: user.name,
    initials: (user.name || "").split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase(),
    level,
    email_verified: !!user.email_verified,
    phone_verified: !!user.phone_verified,
    atlas_score: Number(user.atlas_score || 0),
    dcs_plus: !!user.dcs_plus,
    target_exam_year: user.target_exam_year ?? null
  };
}
