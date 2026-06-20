// src/ledger-ref.mjs
// Emits a PROPOSED ledger_ref conforming to the frozen _SHARED_Day0 contract
// (CW3_ledger_ref-contract.md). CW2 proposes only: template + account + subject.
// CW1 stamps authoritative; CW6 owns money. DARK invariant: amount_authoritative is ALWAYS null
// at proposal time — CW2 never sets a price. Zero-dep.

// CW6 account taxonomy (resolve targets) — CW2 references, never invents.
export const ACCOUNTS = ["player_wallet", "creator_earnings", "platform_fee", "escrow_hold", "promo_credit"];

// CW6 transaction templates (debit -> credit). CW2 references by id only.
export const TEMPLATES = {
  purchase_cosmetic: { debit: "player_wallet", credit: "creator_earnings" },
  vault_access:      { debit: "player_wallet", credit: "creator_earnings" },
  vip_subscription:  { debit: "player_wallet", credit: "platform_fee" },
  escrow_open:       { debit: "player_wallet", credit: "escrow_hold" },
  escrow_release:    { debit: "escrow_hold",   credit: "creator_earnings" },
  escrow_refund:     { debit: "escrow_hold",   credit: "player_wallet" },
};

/**
 * Build a contract-conformant PROPOSED ledger_ref.
 * @param {object} p
 * @param {string} p.template_id - must exist in TEMPLATES
 * @param {string} p.world_id
 * @param {string} p.creator_id
 * @param {string} [p.sku]
 * @param {string} [p.amount_hint_display] - DISPLAY STRING ONLY (e.g. "320 shards"); not a number, not binding
 * @returns {object} proposed ledger_ref (or a local rejection if CW2 can't even form it)
 */
export function proposeLedgerRef({ template_id, world_id, creator_id, sku, amount_hint_display = null }) {
  const tmpl = TEMPLATES[template_id];
  if (!tmpl) return { kind: "ledger_ref", status: "malformed", reason: "TEMPLATE_UNKNOWN", detail: template_id };
  if (!world_id || !creator_id) return { kind: "ledger_ref", status: "malformed", reason: "SUBJECT_MALFORMED" };

  return {
    kind: "ledger_ref",
    status: "proposed",
    template_id,
    account: tmpl.credit,              // the account this action credits (e.g. creator_earnings)
    counterparty_account: tmpl.debit,  // the debit side (e.g. player_wallet)
    subject: { sku: sku || template_id, world_id, creator_id },
    proposed_by: "cw2-generation",
    proposed_at: new Date().toISOString(),
    amount_hint_display,               // display-only; CW2 sets no price
    amount_authoritative: null,        // DARK invariant — ALWAYS null at proposal
  };
}

// Local pre-check mirroring CW1's rules 1,2,6 so CW2 never emits a knowingly-bad ref.
// (CW1 still does the authoritative validation + stamp; this is CW2 being a good proposer.)
export function preCheck(ref) {
  const reasons = [];
  if (!TEMPLATES[ref.template_id]) reasons.push("TEMPLATE_UNKNOWN");
  if (!ACCOUNTS.includes(ref.account) || !ACCOUNTS.includes(ref.counterparty_account)) reasons.push("ACCOUNT_UNKNOWN");
  if (!ref.subject || !ref.subject.world_id || !ref.subject.creator_id) reasons.push("SUBJECT_MALFORMED");
  if (ref.amount_authoritative !== null) reasons.push("SUBJECT_MALFORMED"); // DARK: CW2 must never price
  return { ok: reasons.length === 0, reasons };
}
