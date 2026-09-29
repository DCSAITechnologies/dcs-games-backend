// GAMES-C guard — per-game cost budget ledger.
//
// Every paid provider call must be preceded by reserve() and followed by
// commit() (actual cost) or release() (call failed / not made). reserve() is the
// HARD STOP: it throws BudgetExceeded BEFORE the call if the category cap, the
// game total cap, the per-iteration cap or the user's daily cap would be
// crossed, RunawayDetected if the request pattern looks like a loop, and
// ProvidersOffline when the kill switch DCS_PROVIDERS_OFFLINE=1 is set.
//
// Pure: no I/O, no timers. Clock and env are injected. Persisting the ledger is
// the caller's job (snapshot() / restore via `initial`).
//
// PRICES: no price is recorded anywhere in this repository (checked: src/v3/
// providers/*.mjs name models and endpoints only; reports/*.md carry no unit
// prices). Every number below is an ESTIMATE from public list prices the agent
// recalls for the model families referenced in src/v3/providers/{text,media,
// vision,asset3d}.mjs, and must be replaced with contracted prices before any
// revenue decision. `source` says which file references the model.

export const CATEGORIES = Object.freeze(["planning", "images", "textures", "3d", "video", "voice", "iteration", "playtest"]);

/** Unit prices in USD. unit: "1M_in"/"1M_out" tokens, "image", "clip_5s", "1k_chars", "model", "call". */
export const PRICES = Object.freeze({
  "deepseek:deepseek-v4-pro": { in_per_1m: 0.30, out_per_1m: 1.20, status: "ESTIMATE", source: "src/v3/providers/text.mjs:160,250" },
  "together:zai-org/GLM-5.3": { in_per_1m: 1.00, out_per_1m: 3.20, status: "ESTIMATE", source: "src/v3/providers/text.mjs:161" },
  "together:zai-org/GLM-5.3-Flash": { in_per_1m: 0.20, out_per_1m: 0.80, status: "ESTIMATE", source: "src/v3/providers/text.mjs:190" },
  "together:deepseek-ai/DeepSeek-V4-Pro-0813": { in_per_1m: 0.60, out_per_1m: 1.80, status: "ESTIMATE", source: "src/v3/providers/text.mjs:251" },
  "cerebras:gpt-oss-120b": { in_per_1m: 0.35, out_per_1m: 0.75, status: "ESTIMATE", source: "src/v3/providers/text.mjs:162,188,252" },
  "cerebras:qwen-3.8-27b": { in_per_1m: 0.10, out_per_1m: 0.40, status: "ESTIMATE", source: "src/v3/providers/text.mjs:189" },
  "deepseek:deepseek-v4-flash-vision-exp": { in_per_1m: 0.30, out_per_1m: 1.20, status: "ESTIMATE", source: "src/v3/providers/vision.mjs:213" },
  "together:Qwen/Qwen3.8-Flash": { in_per_1m: 0.20, out_per_1m: 0.60, status: "ESTIMATE", source: "src/v3/providers/vision.mjs:214" },
  "together:black-forest-labs/FLUX.1-kontext-pro": { per_image: 0.04, status: "ESTIMATE", source: "src/v3/providers/media.mjs:71" },
  "together:cartesia/sonic-3": { per_1k_chars: 0.065, status: "ESTIMATE", source: "src/v3/providers/media.mjs:72" },
  "together:ByteDance/Seedance-1.0-lite": { per_clip_5s: 0.14, status: "ESTIMATE", source: "src/v3/providers/media.mjs:73" },
  "kinix:kynex": { per_image: 0.05, per_clip_5s: 0.20, per_1k_chars: 0.08, status: "ESTIMATE (vendor pricing unknown; set at or above Together)", source: "src/v3/providers/media.mjs:39" },
  "external-3d": { per_model: 0.40, status: "ESTIMATE (no 3D vendor named in code)", source: "src/v3/providers/asset3d.mjs:35" },
  "local": { per_call: 0, status: "EXACT (deterministic/local lanes)", source: "local-planner.mjs, asset3d curated, media placeholder, playtest agent" },
});

/** Default per-game caps in USD (ESTIMATE-derived; see DCS_GAMES_COST_BUDGETS.md). */
export const DEFAULT_LIMITS = Object.freeze({
  categories: Object.freeze({ planning: 0.50, images: 2.00, textures: 1.50, "3d": 4.00, video: 3.00, voice: 1.00, iteration: 2.00, playtest: 0.50 }),
  totalUsd: 10.00,
  perIterationUsd: 0.25,        // any single reservation in "iteration"
  perCallUsd: 1.00,             // any single reservation anywhere
  userDailyUsd: 25.00,
  maxConsecutiveWithoutUser: 12, // generations since the last user action
  maxIdenticalRequests: 3,       // same request hash within the window
  identicalWindowMs: 10 * 60 * 1000,
  maxRetries: 2,                 // attempt index 0,1,2 allowed
});

export class BudgetExceeded extends Error {
  constructor(message, detail) { super(message); this.name = "BudgetExceeded"; this.code = "budget_exceeded"; this.detail = detail; }
}
export class RunawayDetected extends Error {
  constructor(message, detail) { super(message); this.name = "RunawayDetected"; this.code = "runaway_detected"; this.detail = detail; }
}
export class ProvidersOffline extends Error {
  constructor() { super("providers are offline (DCS_PROVIDERS_OFFLINE=1): no paid call may be reserved"); this.name = "ProvidersOffline"; this.code = "providers_offline"; }
}

const round6 = (n) => Math.round(n * 1e6) / 1e6;

/**
 * Estimate a call's cost from the price table.
 * @param {{price:string, tokensIn?, tokensOut?, images?, clips?, chars?, models?}} u
 */
export function estimateCost(u = {}) {
  const p = PRICES[u.price];
  if (!p) throw new BudgetExceeded(`unknown price key '${u.price}' — refusing to reserve an unpriced call`, { price: u.price });
  let usd = 0;
  if (p.in_per_1m) usd += ((u.tokensIn || 0) / 1e6) * p.in_per_1m;
  if (p.out_per_1m) usd += ((u.tokensOut || 0) / 1e6) * p.out_per_1m;
  if (p.per_image) usd += (u.images || 0) * p.per_image;
  if (p.per_clip_5s) usd += Math.ceil((u.clips || 0)) * p.per_clip_5s;
  if (p.per_1k_chars) usd += ((u.chars || 0) / 1000) * p.per_1k_chars;
  if (p.per_model) usd += (u.models || 0) * p.per_model;
  return round6(usd);
}

/** Shared per-user daily cap across all of that user's games. Keyed by UTC day. */
export function createUserDailyCap({ capUsd = DEFAULT_LIMITS.userDailyUsd, clock = () => Date.now() } = {}) {
  const spent = new Map();
  const key = (userId) => `${userId}|${new Date(clock()).toISOString().slice(0, 10)}`;
  return {
    capUsd,
    used(userId) { return spent.get(key(userId)) || 0; },
    wouldExceed(userId, usd) { return (spent.get(key(userId)) || 0) + usd > capUsd + 1e-9; },
    add(userId, usd) { const k = key(userId); spent.set(k, round6((spent.get(k) || 0) + usd)); },
  };
}

/**
 * @param {{gameId, userId, limits?, clock?, env?, userDaily?, initial?}} o
 */
export function createBudgetLedger({ gameId, userId, limits = {}, clock = () => Date.now(), env = process.env, userDaily = null, initial = null } = {}) {
  const L = { ...DEFAULT_LIMITS, ...limits, categories: { ...DEFAULT_LIMITS.categories, ...(limits.categories || {}) } };
  const daily = userDaily || createUserDailyCap({ capUsd: L.userDailyUsd, clock });
  const committed = Object.fromEntries(CATEGORIES.map((c) => [c, initial?.committed?.[c] || 0]));
  const reservations = new Map();
  const recentHashes = [];           // {hash, t}
  let consecutive = initial?.consecutive || 0;
  let seq = 0;
  const events = [];

  const reservedIn = (cat) => [...reservations.values()].filter((r) => r.category === cat).reduce((a, r) => a + r.usd, 0);
  const totalCommitted = () => Object.values(committed).reduce((a, b) => a + b, 0);
  const totalReserved = () => [...reservations.values()].reduce((a, r) => a + r.usd, 0);

  function reserve({ category, usd, estimate, requestHash = null, attempt = 0, local = false, reason = "" } = {}) {
    if (!CATEGORIES.includes(category)) throw new BudgetExceeded(`unknown category '${category}'`, { category });
    const cost = round6(usd !== undefined ? Number(usd) : estimate ? estimateCost(estimate) : NaN);
    if (!Number.isFinite(cost) || cost < 0) throw new BudgetExceeded("reservation needs a finite non-negative usd or estimate", { category });
    if (!local && cost > 0 && env?.DCS_PROVIDERS_OFFLINE === "1") throw new ProvidersOffline();

    // Runaway rules run before money rules: a loop is refused even when cheap.
    if (attempt > L.maxRetries) throw new RunawayDetected(`attempt ${attempt} exceeds max retries ${L.maxRetries}`, { rule: "max_retries", attempt });
    if (!local && consecutive >= L.maxConsecutiveWithoutUser) {
      throw new RunawayDetected(`${consecutive} generations without a user action (cap ${L.maxConsecutiveWithoutUser})`, { rule: "no_user_action", consecutive });
    }
    const now = clock();
    while (recentHashes.length && now - recentHashes[0].t > L.identicalWindowMs) recentHashes.shift();
    if (requestHash && attempt === 0) {
      const same = recentHashes.filter((h) => h.hash === requestHash).length;
      if (same >= L.maxIdenticalRequests) throw new RunawayDetected(`identical request repeated ${same + 1}x within window`, { rule: "identical_request", requestHash });
    }

    const catCap = L.categories[category];
    const detail = { category, usd: cost, gameId, userId };
    if (cost > L.perCallUsd) throw new BudgetExceeded(`single call $${cost} exceeds per-call cap $${L.perCallUsd}`, { ...detail, rule: "per_call" });
    if (category === "iteration" && cost > L.perIterationUsd) throw new BudgetExceeded(`iteration $${cost} exceeds per-iteration cap $${L.perIterationUsd}`, { ...detail, rule: "per_iteration" });
    if (committed[category] + reservedIn(category) + cost > catCap + 1e-9) throw new BudgetExceeded(`category '${category}' cap $${catCap} would be exceeded`, { ...detail, rule: "category", used: round6(committed[category] + reservedIn(category)) });
    if (totalCommitted() + totalReserved() + cost > L.totalUsd + 1e-9) throw new BudgetExceeded(`game total cap $${L.totalUsd} would be exceeded`, { ...detail, rule: "total" });
    if (userId && daily.wouldExceed(userId, cost)) throw new BudgetExceeded(`user daily cap $${daily.capUsd} would be exceeded`, { ...detail, rule: "user_daily" });

    const id = `r${++seq}`;
    reservations.set(id, { id, category, usd: cost, t: now, requestHash, local, reason });
    if (userId) daily.add(userId, cost);            // held against the day until released
    if (requestHash) recentHashes.push({ hash: requestHash, t: now });
    if (!local) consecutive++;
    events.push({ kind: "reserve", id, category, usd: cost, t: now });
    return { id, usd: cost };
  }

  function commit(id, actualUsd) {
    const r = reservations.get(id);
    if (!r) throw new Error(`unknown or settled reservation '${id}'`);
    const actual = round6(actualUsd === undefined ? r.usd : Number(actualUsd));
    if (!Number.isFinite(actual) || actual < 0) throw new Error("actual cost must be finite and non-negative");
    reservations.delete(id);
    committed[r.category] = round6(committed[r.category] + actual);
    if (userId) daily.add(userId, actual - r.usd);
    events.push({ kind: "commit", id, category: r.category, usd: actual, overrun: round6(Math.max(0, actual - r.usd)), t: clock() });
    return { category: r.category, usd: actual };
  }

  function release(id) {
    const r = reservations.get(id);
    if (!r) return false;
    reservations.delete(id);
    if (userId) daily.add(userId, -r.usd);
    events.push({ kind: "release", id, category: r.category, usd: r.usd, t: clock() });
    return true;
  }

  /** A human did something (edit, click, prompt). Resets the runaway counter. */
  function noteUserAction() { consecutive = 0; events.push({ kind: "user_action", t: clock() }); }

  /** Wrap a provider call: reserve → run → commit (or release on throw). */
  async function guarded(req, fn) {
    const r = reserve(req);
    try {
      const out = await fn(r);
      commit(r.id, out?.costUsd);
      return out;
    } catch (e) { release(r.id); throw e; }
  }

  function snapshot() {
    return {
      gameId, userId,
      limits: L,
      committed: { ...committed },
      reserved: Object.fromEntries(CATEGORIES.map((c) => [c, round6(reservedIn(c))])),
      total_committed: round6(totalCommitted()),
      total_reserved: round6(totalReserved()),
      remaining_total: round6(L.totalUsd - totalCommitted() - totalReserved()),
      consecutive_without_user: consecutive,
      user_daily_used: userId ? daily.used(userId) : null,
      open_reservations: reservations.size,
      events: events.slice(-50),
    };
  }

  return { reserve, commit, release, noteUserAction, guarded, snapshot, limits: L };
}
