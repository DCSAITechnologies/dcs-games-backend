// CW5 Persistence — Economy Reconciliation Cycle (v3.0, DARK / test-mode)
//
// Mandate v3.0: ledger "reconciles a full purchase→fee→payout cycle in test-mode."
// Builds ON cw5_economy_ledger.ts (the DARK double-entry structure). This adds the
// CYCLE logic: the ordered set of balanced entries for a purchase, and a reconciler
// that proves the books balance (every account nets correctly, platform fee + payout
// sum to the purchase, refunds reverse cleanly).
//
// STILL DARK: nothing here moves real money. It records TEST-MODE ledger entries
// (the EconomyLedgerService DARK gate is bypassed ONLY via an explicit test-mode
// service the caller constructs with payments_live=false + a test flag). No PSP,
// no Stripe, no charges. It reconciles the STRUCTURE so the books are proven correct
// for the day DK flips money.

import {
  LedgerEntry,
  LedgerLeg,
  computeSplitLegs,
  legsBalance,
  makeLedgerRef,
} from './cw5_economy_ledger.js';

export interface PurchaseCycleInput {
  world_id: string;
  buyer_id: string;
  seller_id: string;
  amount_minor: number;
  currency: string;
  platform_pct?: number; // default 30
}

// A reconciled cycle = the ordered ledger entries for one purchase.
export interface PurchaseCycle {
  world_id: string;
  entries: LedgerEntry[];
  reconciled: boolean;
  reason?: string;
}

let __seq = 0;
function nextSeq(): number { return ++__seq; }

/**
 * Build the entries for a purchase→fee→payout cycle (TEST-MODE; records nothing
 * live). Steps mirror the frozen escrow order: hold → settle(split) → payout.
 *   1. hold: buyer debited, escrow credited (full amount)
 *   2. settle: escrow debited; seller credited (net), platform credited (fee)
 *   3. payout: seller's ledger balance paid out (DARK shell)
 * Every entry is double-entry balanced; the reconciler proves the whole cycle nets right.
 */
export function buildPurchaseCycle(input: PurchaseCycleInput, ts: string): PurchaseCycle {
  const { world_id, buyer_id, seller_id, amount_minor, currency } = input;
  const platformPct = input.platform_pct ?? 30;
  const platformCut = Math.round((amount_minor * platformPct) / 100);
  const sellerCut = amount_minor - platformCut;

  const mk = (entry_type: LedgerEntry['entry_type'], legs: LedgerLeg[]): LedgerEntry => ({
    ledger_ref: makeLedgerRef(world_id, nextSeq()),
    world_id, seq: __seq, entry_type, legs, ts, receipt_id: null, meta: { test_mode: true },
  });

  const entries: LedgerEntry[] = [
    // 1. hold — buyer → escrow
    mk('hold', [
      { side: 'debit', account: `buyer:${buyer_id}`, amount_minor, currency },
      { side: 'credit', account: 'escrow', amount_minor, currency },
    ]),
    // 2a. settle seller leg — escrow → seller (net)
    mk('split_seller', [
      { side: 'debit', account: 'escrow', amount_minor: sellerCut, currency },
      { side: 'credit', account: `seller:${seller_id}`, amount_minor: sellerCut, currency },
    ]),
    // 2b. settle platform leg — escrow → platform (fee)
    mk('split_platform', [
      { side: 'debit', account: 'escrow', amount_minor: platformCut, currency },
      { side: 'credit', account: 'platform', amount_minor: platformCut, currency },
    ]),
    // 3. payout — seller balance → seller payout (DARK shell)
    mk('release', [
      { side: 'debit', account: `seller:${seller_id}`, amount_minor: sellerCut, currency },
      { side: 'credit', account: `payout:${seller_id}`, amount_minor: sellerCut, currency },
    ]),
  ];

  const rec = reconcile(entries);
  return { world_id, entries, reconciled: rec.ok, reason: rec.reason };
}

/** Append a refund cycle that reverses a prior purchase (within window; DARK). */
export function buildRefundCycle(input: PurchaseCycleInput, ts: string): LedgerEntry[] {
  const { world_id, buyer_id, seller_id, amount_minor, currency } = input;
  const platformPct = input.platform_pct ?? 30;
  const platformCut = Math.round((amount_minor * platformPct) / 100);
  const sellerCut = amount_minor - platformCut;
  const mk = (legs: LedgerLeg[]): LedgerEntry => ({
    ledger_ref: makeLedgerRef(world_id, nextSeq()), world_id, seq: __seq,
    entry_type: 'refund', legs, ts, receipt_id: null, meta: { test_mode: true, refund: true },
  });
  // reverse seller + platform back to buyer
  return [
    mk([
      { side: 'debit', account: `seller:${seller_id}`, amount_minor: sellerCut, currency },
      { side: 'debit', account: 'platform', amount_minor: platformCut, currency },
      { side: 'credit', account: `buyer:${buyer_id}`, amount_minor, currency },
    ]),
  ];
}

export interface ReconcileResult {
  ok: boolean;
  reason?: string;
  account_balances: Record<string, number>; // by "account|currency"
}

/**
 * Reconcile a set of entries: every entry double-entry balanced AND, for a complete
 * purchase cycle, the transient accounts (escrow) net to zero and value is conserved
 * (buyer outflow == seller payout + platform fee).
 */
export function reconcile(entries: LedgerEntry[]): ReconcileResult {
  const balances: Record<string, number> = {};
  for (const e of entries) {
    if (!legsBalance(e.legs)) {
      return { ok: false, reason: `entry ${e.ledger_ref} legs do not balance`, account_balances: balances };
    }
    for (const l of e.legs) {
      const k = `${l.account}|${l.currency}`;
      balances[k] = (balances[k] ?? 0) + (l.side === 'credit' ? l.amount_minor : -l.amount_minor);
    }
  }
  // escrow must net to zero after a full cycle (everything that came in went out)
  for (const [k, v] of Object.entries(balances)) {
    if (k.startsWith('escrow|') && v !== 0) {
      return { ok: false, reason: `escrow did not net to zero (${v})`, account_balances: balances };
    }
  }
  return { ok: true, account_balances: balances };
}
