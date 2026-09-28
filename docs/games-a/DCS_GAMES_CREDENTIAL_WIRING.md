# DCS Games — provider credential wiring (read-only discovery, 29 Sep 2026)

This discovery used code, config and recorded names-only inventories. No secret value was read or printed, no Railway or network command was run, and no provider was called.

**Sources:**
- `~/Developer/vl-be-integration` @ `618249d7`:
  - `backend/src/modules/ai/providerTruth.ts`
  - `docs/KINIX_ACE_PHASE4A_PROVIDER_TRUTH.md` §4 (a `railway variables --kv` read on 2026-09-10, values stripped)
  - `docs/KINIX_INTERNAL_QA_PROVIDER_PRICING_PROPOSAL_20SEP2026.md:208`
  - `services/gateway/src/server.ts`
  - `services/gateway/src/shared/ai.ts`
- The DCS Games backend at `cd9856d`.

## 1. Variable names

The Engine column is the name the GAMES-A engine (`src/v3/engine`) reads. "Where KINIX holds it" comes from the names-only inventory.

| Name | Engine | KINIX code that reads it | Where KINIX holds it | KINIX dispatch |
|---|---|---|---|---|
| `OPENAI_API_KEY` | openai | none (the adapter was withdrawn) | `kinix-platform` (prod gateway), `kinix-platform-dev ` (prod backend) | no |
| `GOOGLE_AI_API_KEY` | google (the engine also accepts `GEMINI_API_KEY`, `GOOGLE_API_KEY`) | gateway google/veo/speech/lyria, worker llm | `kinix-platform`; `kinix-gateway-internal` (20 Sep) | gateway `/generate` |
| `GEMINI_API_KEY` | google (alias) | none (a DCS-only alias) | none | – |
| `TOGETHER_API_KEY` | together | none | `kinix-platform` | no ("deliberately not wired") |
| `CEREBRAS_API_KEY` | cerebras | none | none. DCS only: the shell key was **rejected** with 401 on 28/29 Sep. It answered on DCS staging 6–8 Sep. | – |
| `DEEPSEEK_API_KEY` | deepseek | none | none | – |
| `LTX_API_KEY`, `LTX_API_BASE_URL` | ltx | gateway `ltx.ts` | `kinix-platform`; `LTX_API_KEY` also on `kinix-gateway-internal` | gateway `/generate` |
| `RUNWAYML_API_SECRET` | runway | gateway `runway.ts` | `kinix-platform` | gateway, but no servable KINIX model row (migration 022) |
| `WORLDLABS_API_KEY` | worldlabs | backend `ace/worlds/worldlabs.ts` | `kinix-platform` | **no.** The key is on the gateway service and the adapter is in the backend package, so no mounted route can read it (Phase 4A finding 3). |
| `ELEVENLABS_API_KEY` | elevenlabs | gateway `elevenlabs.ts` (internal QA) | **absent** from the 10 Sep inventory; not on `kinix-gateway-internal` (20 Sep) | internal QA only |
| `HEDRA_API_KEY` | hedra (withheld) | gateway `hedra.ts` (not imported) | `kinix-platform` | no (`HEDRA_INGEST_UNVERIFIED`) |
| `DEEPGRAM_API_KEY` | not a task class (STT) | gateway `deepgram.ts` (library, no caller) | `kinix-platform` | no |
| `RUNPOD_API_KEY` | not a task class (GPU) | backend `ace/runtime/runpod*` | `kinix-platform` (gateway only; founder decision D6) | no (proof harness only) |
| `FAL_KEY` | not routed | gateway `fal*.ts` | `kinix-api-internal` (20 Sep) | internal QA only |

**Result:** the names already match. The engine reads the KINIX names as they are, so no renaming is needed.

## 2. Should DCS Games call providers through the KINIX gateway?

**Not today.** The gateway exists and is the right custody model, but it cannot serve DCS Games as it stands:

1. **The key-holding gateway is KINIX production.** Service `kinix-platform`, served at `https://kinix-platform-production.up.railway.app`. Benchmarking through it would spend KINIX production credentials from a staging lane.
2. **The staging gateway is private and thinly provisioned.** `kinix-gateway-internal` is reachable only at `kinix-gateway-internal.railway.internal:8090`, inside KINIX's own Railway project. On 20 Sep it held only `GOOGLE_AI_API_KEY` and `LTX_API_KEY`. The DCS Games backend (a different project) and this laptop cannot reach it.
3. **The contract is KINIX-internal.** `POST /generate` requires `generationId` (a uuid), a full KINIX `ai_models` row (`AiModel`) and a `GenerationRequestV2`. Admission, wallet debit and the spend ledger happen in the KINIX backend *before* the gateway is called, so a direct caller would bypass KINIX's cost accounting.
4. **The existing DCS KINIX seam uses the wrong contract.** `DCS_KINIX_URL/KEY` expects `POST /generate {kind, prompt}`. That matches no KINIX route, so wiring the gateway into it would fail validation (400).
5. **Coverage is partial.** The gateway dispatches google, ltx, runway, elevenlabs, fal and music. It does not dispatch OpenAI, Together, Cerebras, DeepSeek, World Labs, Hedra, Deepgram or RunPod.
6. **Security note (unverified since 31 Aug).** A `server.ts` comment from commit `981186a4` (31 Aug) records that `AI_GATEWAY_TOKEN` was set to the placeholder `"false"`, which is a guessable bearer on a public URL that fronts paid providers. No later record of rotation was found. The KINIX owner should check it.

**The right long-term shape:** a KINIX **service-to-service** route for DCS Games. It would be staging first, carry its own token, and use its own spend ledger, and a `kinix-gateway` engine adapter would speak the real contract.

## 3. Credential paths for the benchmark

| Provider | Path that exists | Usable for a staging benchmark now? |
|---|---|---|
| Cerebras | The shell env and DCS staging (answered 6–8 Sep) | Shell: **no** (key rejected). DCS staging: **unknown** (not inspected) |
| Google, LTX | `kinix-gateway-internal` (staging, private network) | **no.** Unreachable, and the contract does not fit |
| Google, LTX, Runway, OpenAI, Together, World Labs, Hedra | `kinix-platform` (production gateway) | **no.** KINIX production credentials |
| DeepSeek, ElevenLabs, Gemini alias | none found | **no** |

## 4. Recommended benchmark path

1. **Names-only check of DCS Games' own staging** (needs founder GO; no values). From the gb worktree, *not* from `/private/tmp`, whose Railway link targets production, list the variable NAMES on the `dcs-games-backend` **Staging** environment. This is the same `--kv`, values-stripped method KINIX used on 10 Sep.
2. **If DCS staging holds provider keys:** run `tools/provider-benchmark.mjs --live --max-usd 5` inside that environment, e.g. `railway run --environment staging` from the gb worktree. Keys stay in Railway, and the harness prints only yes/no configuration and redacted results.
3. **For the KINIX-held providers** (Google, LTX, Runway, World Labs, OpenAI, Together), the founder or KINIX owner chooses one of:
   - (a) copy staging-scoped keys into the DCS Games staging environment, or
   - (b) have KINIX expose a staging service route for DCS Games (§2).

   GAMES-A should not call the KINIX production gateway.
