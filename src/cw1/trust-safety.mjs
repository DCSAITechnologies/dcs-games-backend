// CW1 Identity — Trust & Safety (v3.0). Report → review → action → appeal, with an audit trail.
// Pure state machine + helpers; the service layer persists via the repo. Money/PII stay out of here.

// A report moves through these states. Only T&S staff (is_moderator/is_admin) can action.
export const REPORT_STATES = ["open", "under_review", "actioned", "dismissed", "appealed", "appeal_upheld", "appeal_denied"];

// Actions a moderator can take on a report.
export const MOD_ACTIONS = ["warn", "ban", "shadow_limit", "dismiss"];

// valid transitions: from -> [allowed next]
const TRANSITIONS = {
  open:          ["under_review", "dismissed"],
  under_review:  ["actioned", "dismissed"],
  actioned:      ["appealed"],
  dismissed:     [],                         // terminal (reporter can re-report a new incident)
  appealed:      ["appeal_upheld", "appeal_denied"],
  appeal_upheld: [],                         // action reversed — terminal
  appeal_denied: []                          // action stands — terminal
};

export function canTransition(from, to) {
  return Array.isArray(TRANSITIONS[from]) && TRANSITIONS[from].includes(to);
}

// is this user allowed to operate the T&S console?
export function isModerator(user = {}) {
  return user.is_moderator === true || user.is_admin === true;
}

/**
 * applyModeration(report, action, moderator) -> { report, audit } | { error }
 * Validates the action against the report's state + records an audit entry.
 */
export function applyModeration(report, action, moderatorId) {
  if (!report) return { error: "no_report" };
  if (!MOD_ACTIONS.includes(action)) return { error: "bad_action" };
  // an open report must be picked up (under_review) or dismissed directly
  const targetState = action === "dismiss" ? "dismissed" : "actioned";
  // allow moving open->under_review implicitly when actioning
  const from = report.state === "open" ? "under_review" : report.state;
  if (report.state === "open" && action !== "dismiss") report.state = "under_review";
  if (!canTransition(report.state, targetState) && report.state !== "under_review")
    return { error: "invalid_transition", from: report.state, to: targetState };
  report.state = targetState;
  report.action = action === "dismiss" ? null : action;
  report.actioned_by = moderatorId;
  report.actioned_at = new Date().toISOString();
  const audit = { ts: report.actioned_at, report_id: report.id, by: moderatorId, action, result_state: report.state };
  return { report, audit };
}

/**
 * applyAppeal(report, decision, moderatorId) -> { report, audit } | { error }
 * decision: "uphold" (reverse the action) | "deny" (action stands).
 */
export function applyAppeal(report, decision, moderatorId) {
  if (!report) return { error: "no_report" };
  if (report.state !== "appealed") return { error: "not_appealed", state: report.state };
  const to = decision === "uphold" ? "appeal_upheld" : decision === "deny" ? "appeal_denied" : null;
  if (!to) return { error: "bad_decision" };
  report.state = to;
  report.appeal_decided_by = moderatorId;
  report.appeal_decided_at = new Date().toISOString();
  const audit = { ts: report.appeal_decided_at, report_id: report.id, by: moderatorId, action: "appeal_" + decision, result_state: to };
  return { report, audit };
}
