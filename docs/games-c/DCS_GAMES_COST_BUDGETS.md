# DCS Games — GAMES-C cost budgets

Code: `src/v3/gamesc/guard/budget.mjs`. Tests: `test/gamesc-guard.test.mjs` (`budget:*`, 4 tests). Status: **PROVEN** as a pure ledger. **Not wired** to the provider lanes yet (see the integration step in the threat model).

## ⚠ Price provenance

**No unit price is recorded anywhere in this repository.** I checked: `src/v3/providers/*.mjs` name models and endpoints only, and `reports/*.md` and the closure reports carry no per-call prices. Every provider price below is an **ESTIMATE**, recalled from public list prices for the model family each file references. None of these prices was verified against an invoice or a contract. Replace them with contracted prices before making any pricing or revenue decision. Local and deterministic lanes (local-planner, curated asset3d, placeholder media, the playtest simulation) cost exactly $0.

| Price key (`PRICES`) | Referenced at | Unit price (USD) | Status |
|---|---|---|---|
| `deepseek:deepseek-v4-pro` | providers/text.mjs:160,250 | $0.30 / 1M in, $1.20 / 1M out | ESTIMATE |
| `together:zai-org/GLM-5.3` | text.mjs:161 | $1.00 / 1M in, $3.20 / 1M out | ESTIMATE |
| `together:zai-org/GLM-5.3-Flash` | text.mjs:190 | $0.20 / $0.80 per 1M | ESTIMATE |
| `together:deepseek-ai/DeepSeek-V4-Pro-0813` | text.mjs:251 | $0.60 / $1.80 per 1M | ESTIMATE |
| `cerebras:gpt-oss-120b` | text.mjs:162,188,252 | $0.35 / $0.75 per 1M | ESTIMATE |
| `cerebras:qwen-3.8-27b` | text.mjs:189 | $0.10 / $0.40 per 1M | ESTIMATE |
| `deepseek:deepseek-v4-flash-vision-exp` | vision.mjs:213 | $0.30 / $1.20 per 1M | ESTIMATE |
| `together:Qwen/Qwen3.8-Flash` | vision.mjs:214 | $0.20 / $0.60 per 1M | ESTIMATE |
| `together:black-forest-labs/FLUX.1-kontext-pro` | media.mjs:71 | $0.04 / image | ESTIMATE |
| `together:cartesia/sonic-3` | media.mjs:72 | $0.065 / 1k chars | ESTIMATE |
| `together:ByteDance/Seedance-1.0-lite` | media.mjs:73 | $0.14 / 5 s clip | ESTIMATE |
| `kinix:kynex` | media.mjs:39 | $0.05/img, $0.20/clip, $0.08/1k chars | ESTIMATE (vendor pricing unknown; set at or above Together) |
| `external-3d` | asset3d.mjs:35 | $0.40 / model | ESTIMATE (no 3D vendor is named in code) |
| `local` | local lanes | $0 | EXACT |

A reservation that names a price key missing from the table is **refused** (`BudgetExceeded`). Unpriced calls cannot slip through.

## Per-game budget (defaults, `DEFAULT_LIMITS`)

| Category | What it covers | Cap / game (USD) |
|---|---|---|
| planning | architect + gameplay + fast-lane classification (text.mjs lanes) | 0.50 |
| images | concept, key art and thumbnails (media image lane) | 2.00 |
| textures | generated textures (image lane, texture use) | 1.50 |
| 3d | external 3D model generation (asset3d external lane) | 4.00 |
| video | trailer/cutscene clips (media video lane) | 3.00 |
| voice | NPC/narrator TTS (media audio lane) | 1.00 |
| iteration | companion edit turns (LLM → patch) | 2.00 |
| playtest | optional LLM critic. The simulation itself is local and costs $0 | 0.50 |
| **Game total** | the sum is capped independently of the category caps | **10.00** |

| Other cap | Value |
|---|---|
| Per call (any category) | $1.00 |
| Per iteration (one companion turn) | $0.25 |
| Per user per UTC day (across all their games; `createUserDailyCap`) | $25.00 |

Every value can be overridden per ledger (`createBudgetLedger({limits})`), for example a higher tier for paid plans. No paid plans exist yet: `subscriptions.mjs` holds every price at 0.

## Hard-stop semantics

1. `reserve({category, usd | estimate, requestHash?, attempt?, local?})` runs **before** the provider call. It throws, in this order:
   - `ProvidersOffline` when `DCS_PROVIDERS_OFFLINE=1` and the call is paid. This is the kill switch. Local and zero-cost work is still allowed.
   - `RunawayDetected` (see below).
   - `BudgetExceeded` with `detail.rule` ∈ `per_call`, `per_iteration`, `category`, `total`, `user_daily`. Committed spend **and** open reservations count, so concurrent calls cannot jointly overshoot.
2. `commit(id, actualUsd)` records the real cost. An overrun (actual > reserved) is recorded and counts against later reservations.
3. `release(id)` returns an unused reservation, for when the call failed or was not made.
4. `guarded(req, fn)` wraps all three. The test proves `fn` is **never invoked** once the cap would be crossed.
5. `snapshot()` is the persistable state (committed/reserved per category, remaining, runaway counter, last 50 events).

## Runaway rules

| Rule | Default | Detail |
|---|---|---|
| No user action | 12 paid generations since the last `noteUserAction()` | Stops agent loops that keep "improving" with nobody watching |
| Identical request | 4th request with the same `requestHash` within 10 min (retries with `attempt>0` are exempt from this rule) | Stops retry storms and oscillating repair loops |
| Max retries | `attempt` > 2 | Caps per-request retries |
| Kill switch | `DCS_PROVIDERS_OFFLINE=1` | Global off, matching `providers/contract.mjs offline()` |

## Estimated cost per game (ESTIMATE; all figures derive from the ESTIMATE prices above)

Computed with `estimateCost()` on these assumptions: architect call 6k in / 8k out, gameplay call 8k in / 12k out, 5 fast-lane calls 1k/0.7k (planning ≈ **$0.033**), and one iteration turn 4k in / 1.5k out on deepseek-v4-pro (≈ $0.003).

| Profile | Assumptions | Estimated total |
|---|---|---|
| Minimal | planning + 10 fast-lane edits, curated/placeholder visuals (all local) | **≈ $0.05** |
| Typical | planning + 8 images + 12 textures + 6 external 3D models + 3k chars voice + 30 iterations | **≈ $3.50** (3D is about 70% of it) |
| Heavy | planning + images/textures/3D at their caps + 5 video clips + 10k chars voice + 100 iterations | **≈ $9.20** (just under the $10 cap) |
| Worst case allowed | every cap hit | **$10.00** hard stop |

Sensitivity: the 3D price is the dominant unknown. At $0.10–$1.00 per model the typical profile ranges from about $1.70 to $7.10.
