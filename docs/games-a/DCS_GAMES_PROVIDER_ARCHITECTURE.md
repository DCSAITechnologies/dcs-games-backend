# DCS Games — AI provider architecture (GAMES-A)

**Lane:** GAMES-A, the AI provider and generation engine owner.
**Branch:** `games-a/provider-engine-28sep2026`, in the worktree `~/Developer/dcs-games-a-providers`.
**Base:** backend `gb` at `cd9856d`.
**Date:** 28 Sep 2026.

This lane is isolated. It is a separate worktree outside iCloud. The website/dashboard recovery branch (`fix/dcs-games-website-dashboard-recovery-28sep2026`) and its worktree were not touched.

---

## 1. Forensics: what existed at `cd9856d`

| Area | State at `cd9856d` | Evidence |
|---|---|---|
| Contract | `Lane` holds ranked adapters. Each adapter reports AVAILABLE, UNAVAILABLE or FALLBACK, and every lane must end in a deterministic fallback. There is a shared `chatCompletion` and a JSON salvage parser. | `src/v3/providers/contract.mjs` |
| Lanes | 7 lanes: world_architect, fast_inference, spatial, asset_3d, gameplay, media and vision, composed in the assembly router. | `src/v3/router/assembly.mjs:72-83` |
| Text order | world_architect and gameplay: DeepSeek → Together → Cerebras → local. fast_inference: Cerebras (2 models) → Together → local. | `src/v3/providers/text.mjs` |
| Media | KINIX seam (`DCS_KINIX_URL`, unconfigured) → Together FLUX / sonic-3 / Seedance → SVG placeholder. | `src/v3/providers/media.mjs` |
| 3D and spatial | Generic seams `DCS_ASSET3D_*` and `DCS_SPATIAL_*`, both unconfigured. Worlds come from a local noise heightmap, a navigation graph and parametric archetypes. | `asset3d.mjs`, `spatial.mjs` |
| Live evidence | Only Cerebras `gpt-oss-120b` is evidenced answering on staging (6–8 Sep). On 28 Sep the shell Cerebras key was **rejected** (`wrong_api_key`), per the GAMES-B lane. | `reports/STAGING_PROOFS.md:141-144` |
| Gaps | Timeouts exist per adapter. What was missing: <ul><li>no retry policy (only Cerebras's legacy key failover)</li><li>no budgets</li><li>no circuit breaking</li><li>no cost capture</li><li>no failure classes (a bare `retryable` flag)</li><li>no asset IDs</li><li>no redaction layer</li><li>content-policy refusals fall through to the next vendor</li></ul> | this review |

**Missing providers.** At `cd9856d` there were no adapters for OpenAI, Google, LTX, Runway, World Labs, Hedra or ElevenLabs.

## 2. KINIX adapter discovery

The source is `~/Developer/vl-be-integration` @ `618249d7` (28 Sep), which is the superset of b4, b6, b7, vl-be-gateway and kinix-platform*.

**Ported into the engine.** These were proven live in KINIX. The wire details come from its measured `WIRE_DELTAS`, not from documentation.

| Provider | Source (KINIX) | What was ported | Live in KINIX |
|---|---|---|---|
| Google Gemini, image, TTS, Veo | `services/gateway/src/adapters/google.ts`, `veo.ts` | `generateContent`, `predictLongRunning` + operation poll, the empty-sample-is-failure rule. Veo URIs need a keyed server-side download. | 11 image calls on 10 Sep. Veo rendered on 20 Sep, but the download returned 403. |
| LTX | `adapters/ltx.ts` | `POST /v2/text-to-video`, `GET /v2/{endpoint}/{id}`, and the rule that "completed with no `video_url`" is a failure. | `ltx-2-3-fast` ×5, 10 Sep |
| Runway | `adapters/runway.ts` | The mandatory `X-Runway-Version: 2024-11-06` header, the measured `ratio` enum, the single `GET /v1/tasks/{id}` poll, and no resubmit after a timeout. | gen4.5, gen4_image and aleph2 on 10 Sep |
| World Labs | `backend/src/ace/worlds/worldlabs.ts` | The `WLT-Api-Key` header (Bearer returns 401), `/worlds:generate`, `/operations/{id}`, `/worlds/{id}` assets, and cost from `cost.total_credits`. | `marble-1.1`, 1580 credits, 10 Sep |
| ElevenLabs | `adapters/elevenlabs.ts` | The `xi-api-key` header and `/v1/text-to-speech/{voice}?output_format=mp3_44100_128`. | Internal QA only. No successful run in the ledgers. |
| Hedra | `adapters/hedra.ts` | Registered, but it **never dispatches**. KINIX withholds it because of `HEDRA_INGEST_UNVERIFIED`. | 1 job via the vendor account |

**Gateway patterns reused as concepts:**
- `outbound.ts`: a billed job creation is never retried, and a timeout counts as a possible spend.
- `envValue.ts`: placeholder values such as `changeme`, `false` and `none` count as unset.
- `logRedaction.ts`: the lists of secret header and query-parameter names.
- `provenance.ts`: `assetId`, `contentSha256` and `promptSha256`.
- `routerPolicy.ts`: fallbacks must be a different provider.

**Not reusable:**
- `withdrawn-providers/openai.ts`: stale and untested.
- RunPod: coupled to the ACE runtime.
- DB-bound circuits and idempotency.

**Written new for Games** (KINIX has no adapters for these): OpenAI (text, image, TTS), DeepSeek, Cerebras, Together. They share one OpenAI-compatible adapter and reuse the `chatCompletion` wire shape already running on DCS staging.

## 3. The engine

```
engine.run(task, request)
  │  requestMetadata()      deterministic request_id = sha256(canonical request)
  ▼
  for step in ROUTING_MATRIX[task]   (primary → fallback 1 → fallback 2 → local)
    ├─ serves task?            no → UNSUPPORTED        (skip)
    ├─ offline / no key?       yes → NOT_CONFIGURED    (skip, no health penalty)
    ├─ circuit open?           yes → CIRCUIT_OPEN      (skip)
    ├─ budget.reserve(est)     over cap → BUDGET_EXCEEDED (skip to cheaper step)
    ├─ invoke under attempt timeout ∧ route deadline
    │     success → validate outputs → settle actual cost → health.success
    │               → assets[] with deterministic asset_id + content_sha256
    │               → provenance {provider, model, route_position, latency, tries, cost, basis, job id}
    │     failure → classify → health.failure → release/charge budget → redact reason
    │               retry at same provider ONLY if class is pre-execution (429/5xx/network)
    │                  AND the adapter says the call is retry-safe (text only)
    │               CONTENT_POLICY or DEADLINE → stop the route (no moderation shopping)
    ▼
  throw GenerationError(attempts, request) only when every step failed
```

| Module (`src/v3/engine/`) | Responsibility |
|---|---|
| `task-classes.mjs` | The 10 task classes: output kind, manifest lane, per-attempt timeout, route deadline. |
| `routing.mjs` | `ROUTING_MATRIX`, plus overrides through `DCS_GAMES_ROUTE_<TASK>=provider:model,...`. The local step is always kept. |
| `engine.mjs` | The route walk, timeouts, safe retries, output validation, assets and provenance. |
| `failures.mjs` | 15 failure classes. Each class carries a retry, health and fallthrough policy. |
| `budget.mjs` | Reserve, settle and release. Caps are per request, per world and per UTC day (env `DCS_GAMES_BUDGET_*`; defaults $1, $3, $25). |
| `health.mjs` | A circuit breaker per provider. It opens after 3 failures, or at once on AUTH (15 min), and half-opens after the cooldown. It keeps a latency EWMA. |
| `provenance.mjs` | Canonical JSON, `request_id` `gr_<task>_<24hex>` and `asset_id` `ga_<task>_<24hex>`. Timestamps are kept beside the IDs, never inside them. |
| `redact.mjs` | Masks the values of every env var whose name looks like a secret, plus Bearer, `sk-`, `AIza` and `key=` shapes. `safeLog()` is the only way the engine logs. |
| `pricing.mjs` | List prices (28 Sep), a pessimistic pre-call estimate, and a settle-to-usage cost when token usage is returned. |
| `adapters/*.mjs` | openai-compatible (openai, deepseek, cerebras, together), google, media-vendors (ltx, runway, worldlabs, elevenlabs, hedra, external-3d, kinix) and local. |
| `benchmark.mjs` + `tools/provider-benchmark.mjs` | The capped live benchmark. The default is plan-only with no network. |
| `index.mjs` | `createGenerationEngine()`, `engineLaneAdapter()` (the B1 `Lane` bridge) and `toProvenanceStage()` (the GAMES-B contract, §8). |

## 4. Safety properties, each with a test in `test/games-engine.test.mjs`

- **No secret in any output.** A vendor that echoes the Authorization header back still produces redacted attempts, errors and logs. The Google key travels in a header, never in the URL.
- **No double billing.** Image, video, voice, 3D and world job creations are never retried. A timeout keeps its estimate charged.
- **No moderation shopping.** A content-policy refusal stops the route.
- **The budget can only err toward refusing.** Estimates assume the full max output. When World Labs `marble-1.1` would exceed the cap, the engine takes `marble-1.0-draft` automatically.
- **Offline always works.** Every task class returns a deterministic local result at $0, labelled `FALLBACK` with `placeholder` or `procedural` flags. A placeholder is never presented as generated.
- **Retired endpoints are excluded.** Sora (API sunset 24 Sep 2026) and Imagen 4 (shut down 17 Aug 2026) are asserted absent.

## 5. Integration contract with the game pipeline

- **B1 assembly router.** `engineLaneAdapter(engine, TASK.X)` is a standard `ProviderAdapter`. Put it at rank 1 in any existing `Lane`. When no external step is configured it reports UNAVAILABLE, so the lane's own fallback still runs. `assembly.mjs` is intentionally **unchanged** on this branch; the swap is a one-line change per lane, left to the integration step.
- **GAMES-B pipeline.** `toProvenanceStage(result, stage)` emits the §8 `ProvenanceStage` shape. Asset IDs and content hashes feed the `AssetRecord` fields `sha256` and `provider`.
- **Media storage.** Adapters return `data:` URIs for images and audio, and vendor URLs for video and 3D. Before public use, the pipeline must:
  1. copy vendor URLs into DCS storage (Veo needs a keyed server-side fetch),
  2. wrap Gemini PCM as WAV,
  3. apply the licence gate to World Labs output.
