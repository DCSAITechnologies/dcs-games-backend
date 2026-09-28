# DCS Games — generation core specification (GAMES-A v1.0.0)

The engine version is `games-a/1.0.0` (`ENGINE_VERSION`). Everything below is covered by `test/games-engine.test.mjs` (36 tests).

## 1. API

```js
import { createGenerationEngine, TASK } from "./src/v3/engine/index.mjs";
const engine = createGenerationEngine({ env: process.env });   // adapters + routes + budget + health
const res = await engine.run(TASK.WORLD_DESIGN, { prompt, worldId, creatorId, seed, style });
engine.describe();   // routes × configured × circuit state × budget — no calls, no secrets
```

`run()` either returns `GenerationResult`, or throws `GenerationError { failureClass, attempts[], request }`.

## 2. Task classes

| Task | Output | Request fields used | Local fallback |
|---|---|---|---|
| WORLD_DESIGN | JSON world plan (the B1 architect schema) | prompt, style, constraints, seed | procedural architect |
| GAMEPLAY_LOGIC | JSON `{behaviors, interactions}` | zones, structures, npcs, items, genre, prompt | behaviour library |
| FAST_ITERATION | JSON `{genre, tags, maturity, mood, summary}` | prompt, title, zones | keyword classifier |
| CODE_GENERATION | JSON `{behaviors, interactions, checks}` (declarative; never executable code) | prompt + world | behaviour library |
| IMAGE_ASSET | image URI | prompt, style, size / aspectRatio | labelled SVG placeholder |
| TEXTURE | tileable image URI | prompt, material, style | seeded tileable SVG (procedural) |
| CHARACTER | concept-sheet image URI | prompt, style, archetype | parametric rigged archetype (JSON) |
| SPATIAL_3D | GLB or SPZ URI + world metadata | prompt, title, size, zones | heightmap + navigation graph (JSON) |
| VIDEO_CINEMATIC | MP4 URI | prompt, durationS, aspectRatio | honest "absent" placeholder |
| VOICE_AUDIO | audio URI | text \| prompt, voice, voiceId | honest "absent" placeholder |

## 3. Result shape

```js
{
  ok: true,
  request: { request_id, task, world_id, creator_id, seed, prompt_sha256, fingerprint, engine_version, created_at },
  assets: [ { asset_id, task, kind, mime, uri? | json?, placeholder?, meta?, content_sha256 } ],
  provenance: { request_id, task, provider, vendor, model, status: "AVAILABLE"|"FALLBACK",
                route_position, latency_ms, tries, cost_usd, cost_basis: "reported"|"estimate",
                usage, upstream_job_id, engine_version, at, after?: ["provider:CLASS", ...] },
  attempts: [ { provider, model, class, reason /* redacted */, ms, tries } ],
  cost_usd
}
```

## 4. Determinism

- **`fingerprint`**: sha256 of the canonical JSON (sorted keys) of `{task, ...request}`, excluding callbacks and signals. An attached image contributes its sha256, never its bytes.
- **`request_id`**: `gr_<task-short>_<first 24 hex of fingerprint>`.
- **`asset_id`**: `ga_<task-short>_<24 hex of sha256({task, requestId, provider, model, index})>`. The same request answered by the same provider and model always yields the same ID. A different provider yields a different ID, because it is a different asset.
- **Offline runs** are fully deterministic in content as well as in IDs; this is tested.

## 5. Failure classes

| Class | Retry at same provider | Counts against health | Fall through |
|---|---|---|---|
| NOT_CONFIGURED, UNSUPPORTED, CIRCUIT_OPEN, BUDGET_EXCEEDED | – | – | yes |
| AUTH (401/403) | no | yes, opens circuit at once | yes |
| RATE_LIMITED (429) | yes, honours `retry-after` (≤ 8 s), text only | yes | yes |
| NETWORK, UPSTREAM_5XX | yes, text only | yes | yes |
| TIMEOUT | **no** (may have executed; the estimate stays charged) | yes | yes |
| BAD_REQUEST (400/404/422) | no | no | yes |
| INVALID_OUTPUT, JOB_FAILED, UNKNOWN | no | yes | yes |
| CONTENT_POLICY | no | no | **no**: the route stops |
| DEADLINE | no | no | **no**: the route stops |

Retries default to 1 (`maxRetries`) and apply only where `adapter.retrySafe(task)` is true. That is text tasks only; billed job creations are never retried. Backoff is 500 ms × 2^n, capped at 8 s.

## 6. Timeouts

| Task | Per attempt | Whole route |
|---|---|---|
| FAST_ITERATION | 15 s | 30 s |
| Text tasks | 120 s | 180 s |
| Image tasks | 120 s | 150 s |
| VOICE_AUDIO | 60 s | 90 s |
| SPATIAL_3D and VIDEO_CINEMATIC (submit + poll) | 600 s | 900 s |

A request can tighten both with `attemptTimeoutMs` and `deadlineMs`. Async jobs are polled with a bounded count, so a job that never finishes cannot hold a slot.

## 7. Budgets

| Env var | Default |
|---|---|
| `DCS_GAMES_BUDGET_PER_REQUEST_USD` | 1.00 |
| `DCS_GAMES_BUDGET_PER_WORLD_USD` | 3.00 |
| `DCS_GAMES_BUDGET_PER_DAY_USD` | 25.00 |

- The engine reserves the estimate before the call and settles to the reported cost after it. Reported cost comes from token usage or World Labs credits.
- A failed call releases its reservation. A timed-out call keeps its reservation.
- The ledger is in-memory per process. Before multi-instance production it needs a durable ledger; see §10.

## 8. Provider health

- One circuit per provider ID: closed → open → half_open.
- It opens after 3 health-counting failures in a row (cooldown 60 s), or after 1 AUTH failure (cooldown 15 min).
- `describe().health` exposes the circuit state, counts, last failure class and latency EWMA.

## 9. Routing overrides

`DCS_GAMES_ROUTE_<TASK>=provider[:model],...`, for example `DCS_GAMES_ROUTE_TEXTURE=google:gemini-3.1-flash-image,together`.

- Unknown providers are dropped.
- The task's local step is appended if it is missing.
- Model IDs are data, so a vendor renaming a model is a config change, not a code change.

## 10. Known limits and integration TODO

1. **The live benchmark has not been run** (see §11). Routes are PROVISIONAL.
2. Model IDs taken from 28 Sep pricing pages postdate training data. Verify each on its first live call. A 404 classifies as BAD_REQUEST and falls through.
3. Budget ledger and circuit state are in-memory. For production, persist them in Supabase, following the KINIX `ai_provider_health` pattern.
4. Media URIs must be copied into DCS storage before publish. Veo needs a keyed server-side fetch. Gemini TTS PCM needs a WAV wrapper.
5. World Labs, and any generated 3D, carries unresolved commercial licence terms. The publish gate must check `meta.license_note`.
6. Hedra is registered but not dispatched. It needs a verified media upload.
7. `assembly.mjs` is not yet switched to the engine. Integration inserts `engineLaneAdapter` per lane.

## 11. Benchmark procedure (the gate for the final routes)

```
node tools/provider-benchmark.mjs                                   # plan: 30 pairs, ≤ $7.12 list, no network
DCS_BENCH_CONFIRM=1 node tools/provider-benchmark.mjs --live --max-usd 5 --out bench.csv
```

Hard limits enforced in code:
- at most 3 calls per provider/model/task (default 1), run sequentially
- one provider per call, with no fallback
- cheapest calls first under the USD cap (maximum $25)
- a provider is dropped after an AUTH failure or 2 failures
- quality is scored structurally (0–5) and is flagged as a machine check

Human visual review of the image, video and 3D outputs is still required before the routes are finalised.
