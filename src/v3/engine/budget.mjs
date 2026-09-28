// GAMES-A — spend budgets.
//
// A call reserves its ESTIMATED cost before it is sent and settles to the
// actual cost afterwards. A call whose estimate would breach any cap is not
// sent; the route moves on to the next (usually cheaper) provider, and the
// local fallback costs nothing. Caps are per request, per world and per UTC day.
import { FAILURE, GenerationError } from "./failures.mjs";

const num = (v, d) => (v === undefined || v === null || v === "" || !Number.isFinite(Number(v)) ? d : Number(v));

export function budgetFromEnv(env = process.env) {
  return {
    perRequestUsd: num(env.DCS_GAMES_BUDGET_PER_REQUEST_USD, 1.0),
    perWorldUsd: num(env.DCS_GAMES_BUDGET_PER_WORLD_USD, 3.0),
    perDayUsd: num(env.DCS_GAMES_BUDGET_PER_DAY_USD, 25.0),
  };
}

export class BudgetLedger {
  constructor({ perRequestUsd = 1.0, perWorldUsd = 3.0, perDayUsd = 25.0, clock = () => new Date() } = {}) {
    this.caps = { perRequestUsd, perWorldUsd, perDayUsd };
    this.clock = clock;
    this.byWorld = new Map();
    this.byDay = new Map();
    this.entries = [];
    this.seq = 0;
  }

  _day() { return this.clock().toISOString().slice(0, 10); }

  spentWorld(worldId) { return this.byWorld.get(worldId || "_none") || 0; }
  spentToday() { return this.byDay.get(this._day()) || 0; }

  /** Reserve an estimate or throw BUDGET_EXCEEDED. Zero-cost calls always pass. */
  reserve({ worldId = null, requestId, provider, model, estimateUsd }) {
    const est = Math.max(0, Number(estimateUsd) || 0);
    if (est > 0) {
      const w = this.spentWorld(worldId) + est, d = this.spentToday() + est;
      const breach =
        est > this.caps.perRequestUsd ? `estimate $${est.toFixed(4)} exceeds per-request cap $${this.caps.perRequestUsd}` :
        w > this.caps.perWorldUsd ? `world spend would reach $${w.toFixed(4)} (cap $${this.caps.perWorldUsd})` :
        d > this.caps.perDayUsd ? `daily spend would reach $${d.toFixed(4)} (cap $${this.caps.perDayUsd})` : null;
      if (breach) throw new GenerationError(FAILURE.BUDGET_EXCEEDED, breach, { provider });
    }
    const r = { id: ++this.seq, worldId, requestId, provider, model, estimateUsd: est, day: this._day(), settled: false };
    this._add(r.worldId, r.day, est);
    return r;
  }

  /** Replace the reservation with the actual cost (or the estimate if unknown). */
  settle(r, actualUsd) {
    if (!r || r.settled) return 0;
    const actual = Number.isFinite(Number(actualUsd)) && actualUsd !== null ? Math.max(0, Number(actualUsd)) : r.estimateUsd;
    this._add(r.worldId, r.day, actual - r.estimateUsd);
    r.settled = true;
    this.entries.push({ requestId: r.requestId, provider: r.provider, model: r.model, estimateUsd: r.estimateUsd, actualUsd: actual, basis: actualUsd === null || actualUsd === undefined ? "estimate" : "reported" });
    return actual;
  }

  /**
   * A failed call. If the provider may have executed it (a timeout), the
   * estimate stays charged — spend we cannot rule out is spend.
   */
  release(r, { possiblyBilled = false } = {}) {
    if (!r || r.settled) return;
    if (possiblyBilled) return this.settle(r, r.estimateUsd);
    this._add(r.worldId, r.day, -r.estimateUsd);
    r.settled = true;
  }

  _add(worldId, day, delta) {
    const w = worldId || "_none";
    this.byWorld.set(w, Math.max(0, (this.byWorld.get(w) || 0) + delta));
    this.byDay.set(day, Math.max(0, (this.byDay.get(day) || 0) + delta));
  }

  snapshot() {
    return { caps: { ...this.caps }, today_usd: +this.spentToday().toFixed(6), entries: this.entries.length };
  }
}
