# DCS Games — current AI / game-creation pipeline (audit, 28 Sep 2026)

Read-only audit. No provider keys were added, read or used. Code facts are cited as `file:line` at backend
`gb` @ `cd9856d` (branch `fix/dcs-games-website-dashboard-recovery-28sep2026`), frontend `dcs-games-LIVE`,
netcode `cw4-deploy/dcs-games-netcode` @ `524a7f6`. Live facts come from public GET endpoints only.

## Headline

- **Two generation engines exist.** The UI uses only the newer one (V3).
  - **CW2 legacy:** `POST /worlds/generate`. A deterministic seeder builds the world, then an optional Cerebras rewrite changes the names and text ("cerebras-hybrid").
  - **V3 Assembly Router:** `POST /v3/worlds/generate[/async]`. Seven provider lanes, and every lane falls back to a local deterministic generator.
- **What is actually live on staging (`GET /v3/providers`, 28 Sep):** only **Cerebras** is keyed.
  - `cerebras:gpt-oss-120b` serves the world-architect, fast-inference and gameplay lanes.
  - DeepSeek and Together are UNAVAILABLE.
  - Spatial, 3D assets, media and vision all run on their `local:*` fallbacks.
  - So on staging, **the LLM writes the plan and the text; terrain, 3D assets, playtest, edit, expand, companion and memory are deterministic code.**
- **Production API (`api.games.dcsai.ai`) has no V3 routes at all** (`/v3/providers` → 404). It is the older CW1/2/5/7 build. The production site cannot run the create → play → history journey the recovered frontend links to. Staging can.
- **No OpenAI, Anthropic, Google/Gemini, Runway, World Labs, LTX, Stability, Hedra, HeyGen, Replicate, fal, ElevenLabs, Groq or Mistral integration exists** anywhere in backend or frontend code. A few of those names appear only in a manifest key-ban regex (`src/v3/manifest/schema.mjs:344`) and in secret-scan patterns.

## Provider adapters

| Provider | Env var names (names only) | Adapter | Models | Status on staging |
|---|---|---|---|---|
| Cerebras (V3) | `CEREBRAS_API_KEY`, `CEREBRAS_API_KEY_1`, `CEREBRAS_KEY_2`, `CEREBRAS_API_KEY_2` | `src/v3/providers/text.mjs:25`; call in `contract.mjs:222-252` | `gpt-oss-120b` (architect rank 30, fast rank 10, gameplay rank 30); `qwen-3.8-27b` (fast rank 15) | **AVAILABLE** |
| Cerebras (CW2) | `CEREBRAS_API_KEY`, `CEREBRAS_API_KEY_<n>`, `CEREBRAS_MODEL`, `CEREBRAS_BASE_URL`, `CEREBRAS_TIMEOUT_MS` | `src/cw2/cerebras-client.mjs:12-92` | `gpt-oss-120b` | Keyed (`/health`: `cerebras-hybrid:gpt-oss-120b ×2key`). No frontend page calls this route |
| DeepSeek | `DEEPSEEK_API_KEY` | `text.mjs:24`, `vision.mjs:213` | `deepseek-v4-pro`, `deepseek-v4-flash-vision-exp` | UNAVAILABLE |
| Together (text / vision) | `TOGETHER_API_KEY` | `text.mjs:26`, `vision.mjs:214` | `zai-org/GLM-5.3`, `GLM-5.3-Flash`, `deepseek-ai/DeepSeek-V4-Pro-0813`, `Qwen/Qwen3.8-Flash` | UNAVAILABLE |
| Together (media) | `TOGETHER_API_KEY` | `src/v3/providers/media.mjs:70-139` | FLUX.1-kontext-pro (image), cartesia/sonic-3 (audio), Seedance-1.0-lite (video) | UNAVAILABLE |
| KINIX / Kynex (media) | `DCS_KINIX_URL`, `DCS_KINIX_KEY` / `KINIX_API_KEY` | `media.mjs:27-67` | — | UNAVAILABLE (written against a documented payload only) |
| External spatial | `DCS_SPATIAL_URL/KEY/NAME` | `spatial.mjs:15-40` | generic seam | UNAVAILABLE; falls back to `local:heightmap-generator` |
| External 3D | `DCS_ASSET3D_URL/KEY/NAME` | `asset3d.mjs:35-60` | generic seam | UNAVAILABLE; falls back to `local:curated-archetypes` |

Notes:
- **Rotation and fallback:**
  - The CW2 client rotates across all keys on 429/5xx (`cerebras-client.mjs:73-89`).
  - V3 takes the first non-empty key and has no rotation (`text.mjs:13-19`). A lane falls through to its next-ranked adapter instead (`contract.mjs:80-131`).
- **Key naming mismatch:** `CEREBRAS_KEY_2` is honoured by V3 but ignored by the CW2 key regex (`cerebras-client.mjs:23`).
- **CI never calls a vendor.** `DCS_PROVIDERS_OFFLINE=1`, or `NODE_ENV=test` without `DCS_PROVIDERS_ONLINE=1`, marks every vendor UNAVAILABLE (`contract.mjs:49-51`).
- **Provider check tool:** `tools/live-provider-check.mjs` is the only live check, and it is not part of `npm test`.

## Pipeline stages

The table uses these labels:
- **EXISTS**: the code exists.
- **BACKEND / FRONTEND**: where it is present.
- **WORKING**: evidence of working behaviour.
- **DETERMINISTIC**: works, but no model is involved.
- **PLACEHOLDER**: exists but is not real.

| Stage | Exists | Backend | Frontend | Provider | Status |
|---|---|---|---|---|---|
| Prompt / describe | y | part of the generate routes | `create-v3.html` prompt box; `games-create` and the studio world-builder hand off via `?prompt=` | — | WORKING |
| Generation (V3) | y | `POST /v3/worlds/generate/async` `server.mts:1447` (internal tester); sync at :1530 | `create-v3.html:414` (async), polls `/v3/jobs/:id` | Cerebras on staging; otherwise local | WORKING on staging (`reports/STAGING_PROOFS.md`) |
| Generation (CW2) | y | `POST /worlds/generate` :2155 | **none** (orphaned) | Cerebras-hybrid, or seeder | WORKING in code; unused by the UI |
| World / terrain | y | `assembly.mjs:151`, `spatial.mjs:66-213` | rendered by `assets/v3/dcs-runtime.js` | local heightmap | DETERMINISTIC |
| Assets (3D) | y | `assembly.mjs:154-165`, `asset3d.mjs:68` | runtime | curated archetypes | DETERMINISTIC |
| Characters / NPCs | y | architect lane + `compose()` | npc-builder labelled "not built" | LLM, or `local:procedural-architect` | WORKING when keyed |
| Scenes / zones | y | `assembly.mjs:273+` | runtime | same | WORKING / DETERMINISTIC |
| Save | y | `POST /worlds/:id/save` :2230 | not called by any V3 page | — | WORKING (tests); not wired to the UI |
| Load | y | `GET /v3/worlds/:id/manifest` :1609 | `play-v3.html:253` | — | WORKING |
| Edit | y | `POST /v3/worlds/:id/edit` :1684 | `create-v3.html:544` | none | DETERMINISTIC (`planner.mjs:12-13`) |
| Playtest | y | `POST /v3/worlds/:id/playtest` :1623; runs inside every generate | `create-v3.html:491` | none | DETERMINISTIC simulation agent |
| Publish | y | `POST /worlds/:id/publish` :2204 | `create-v3.html:517` | local ed25519 | WORKING if `ATLAS_PRIVATE_KEY` is set |
| Versions / diff / rollback | y | :1981, :1985, :2111, :1997 | `history-v3.html` | none | WORKING |
| Expand / evolve | y | `POST /v3/worlds/:id/expand` :1635 | `create-v3.html:573` | none | DETERMINISTIC (`DISTRICT_BLUEPRINTS`) |
| Companion | y | `GET/POST /v3/worlds/:id/companion` :2129 | `play-v3.html:430-453` | none | DETERMINISTIC grounded answers (file store) |
| World / NPC memory | y | :2122, :1939 | `create-v3`, `history-v3` | none | DETERMINISTIC (file store) |
| Vision input | y | `assembly.mjs:130-143` | create-v3 never sends an image | UNAVAILABLE on staging | backend only |
| Media (key art / audio / video) | y | `POST /v3/worlds/:id/media` :1722 | none | UNAVAILABLE on staging; placeholder SVG | PLACEHOLDER |
| Stitch / fork / procedural quests | y | :1826, :1903, :1955 | none | none | backend only, DETERMINISTIC |
| Jobs queue | y | `/v3/jobs*` :1514 | create-v3 | — | WORKING; in-process, single instance, file-backed |
| Multiplayer | partial | manifest `multiplayer.enabled:false` (`assembly.mjs:474`) | **no WebSocket client anywhere in the frontend** | — | PLACEHOLDER (see netcode) |
| Atlas receipts | y | `/atlas/key` :872, `/atlas/receipt/:id` :880, `/verify` :895 | `DCSTruth.verifyReceipt` (in-browser ed25519) | local ed25519 | WORKING. `/atlas/builder` and `/atlas/world` read an empty corpus: PLACEHOLDER |

## The V3 generation flow (what `create-v3` actually runs)

1. Access checks, then a 202 response:
   - `mustBeInternalTester` checks the caller against the `DCS_INTERNAL_TESTERS` allowlist.
   - `safety.requireCapability(create)` and prompt validation follow.
   - A job is created and the 202 returns its poll URL.
2. `assemble()` runs these lanes in order (`assembly.mjs:103-208`): vision → world_architect → fast_inference → spatial → asset_3d → gameplay → `compose()` → media. Each lane's provenance is recorded in `manifest.provenance.generated_by`.
3. `compose()` post-processes the result:
   - Weather synonyms are normalised onto the 8 allowed values (`assembly.mjs:44-57`). This was fixed after a world was lost to the word "overcast".
   - Enums are checked, bounds clamped, ids re-slugged, dangling references dropped, and a flat terrain is used if the generated one is unusable.
4. `validateManifest` (WorldManifestV3) runs, then `playtestAndRepair`, a deterministic gate. A failure fails the job.
5. The world is persisted:
   - `repo.upsert(state:"draft")` writes to a file store (`.dcs-data/worlds`).
   - With Supabase configured, it is mirrored to `dcsgames_base_worlds` and history to `dcsgames_world_versions`.
6. `play-v3` fetches the manifest and renders it with THREE.js (`assets/v3/dcs-runtime.js`).

**Gap found (verified by reading, not yet tested at runtime):**
- The async route does **not** call `registerV3BaseWorld` (only the sync route does, `server.mts:1583`). So worlds created from the UI are never registered as CW5 runtime base worlds.
- Anything that depends on that registration will not see UI-created worlds.

## Netcode

- **What exists:** `cw4-deploy/dcs-games-netcode` is a zero-dependency RFC6455 WebSocket server (`ws://host:8090/play`).
  - It includes session, anti-cheat, party, AOI, delta and lag-compensation modules, with 186 checks per its README.
- **Blocker: auth is a mock in the production entry point.**
  - `src/server.ts:99` constructs `new Gateway(sessionManager, mockTokenVerifier)`.
  - `mockTokenVerifier` (`src/gateway.ts:250`) accepts any `tok:<user_id>`.
- **Persistence route is missing.** Deltas are posted to `CW5_PERSISTENCE_URL/persistence/delta`, and no such route exists in `gb`.
- **The frontend never connects.** There is no WebSocket client, and `DCS_WS_URL` is unused.
- **Not deployed.** No evidence of a deployment was found.
- **Status: not integrated.** Stray duplicate files also exist: `src/session 2.ts`, `src/validation 2.ts`, `tests/speedhack-regression.test 2.ts`.

## Studio and creator pages

- **`cr-world/npc/quest/story/voice/economy/event/studio.html` were fabricated generators.**
  - Each "Generate" played a 600 ms animation ending "Atlas-verifying… ✅ Ready!" and sent no request.
  - **Fixed in this recovery:** 301-redirected in `_redirects` to `/create-v3` and the studio overview. The files remain for history.
- **`studio/pages/ai-studio/*-builder.html`:**
  - The quest and world builders hand off to `/create-v3`.
  - The other ten are honestly labelled "Not built".
- **Studio pages with real API calls:**
  - `atlas`, `marketplace`, `revenue`, `worlds` and `studio-overview` read real endpoints.
  - The rest render chrome plus "no route measures this" labels behind the internal-tester gate.

## What this means for the next phase

The current "AI game creation" is **one LLM call (Cerebras) that writes a plan, wrapped in a substantial, well-tested deterministic assembly, playtest, versioning and runtime pipeline**. The following lanes are not live anywhere:
- the provider lanes that would make it richer: 3D, spatial, media and vision
- multiplayer

Production cannot run any of it until the V3 backend is promoted. See `DCS_GAMES_NEXT_BUILD_ROADMAP.md`.
