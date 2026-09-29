# DCS Games — next build roadmap (from the 28 Sep 2026 recovery)

Ordered by what unblocks what. Items marked **FD** need a founder decision before anyone acts.

## Stage 0: ship the recovery (days, not weeks)

| # | Item | Owner | Notes |
|---|---|---|---|
| 0.1 | **FD: approve a staging preview of `fix/dcs-games-website-dashboard-recovery-28sep2026`** (Cloudflare Pages *preview* branch deploy, never `--branch main`) | founder | Nothing was deployed by this work |
| 0.2 | Human acceptance on the preview: real email sign-in against staging Supabase, then a return after more than 1 h (or set a short JWT expiry on staging) | founder / staff | The only auth proof not automatable without credentials |
| 0.3 | Verify the Supabase **redirect URL allowlist** has `https://games.dcsai.ai/auth-callback.html` (production) and the preview origin (staging) | founder | Cannot be checked from outside (auth report A-5) |
| 0.4 | **FD: production cut-over.** Production frontend is `efcb7c6` (6 Sep); production API has no V3 routes. The recovered frontend's journey (create-v3 / history-v3 / play-v3) needs the V3 backend. Promote the backend first (`DCS_GAMES_PRODUCTION_CUTOVER_PLAN.md` in `DCS_GAMES_SPRINT_SEP2026`), then the frontend | founder | Frontend-only promotion would link to routes production cannot serve |
| 0.5 | **FD: beta-lock on production.** Keep the two-email client-side overlay on `/login` and `/studio`, replace it with the server allowlist that already exists (`DCS_INTERNAL_TESTERS`), or remove it | founder | Recommendation: remove it. The server allowlist is the real gate |
| 0.6 | **FD: guest play.** Enable anonymous sign-ins on production Supabase, or remove the "Continue as guest" button | founder | Today it always fails on production |
| 0.7 | The internal-testing window in copy and banners ends **30 Sep 2026** (2 days). Decide the next window and update `WINDOW_ENDS` in `dcs-truth.js` and the backend `internal_testing_window_ends` | founder | Otherwise every page asserts a date that has passed |

## Stage 1: backend hygiene the audit surfaced (1–2 weeks)

1. **Public routes must ignore a bad bearer.** `/v3/discover` and `/api/public/*` answer 401 to an invalid token. That should be "treat as anonymous"; the frontend currently works around it with an anonymous retry.
2. **`POST /v3/worlds/generate/async` does not call `registerV3BaseWorld`.** The sync route does (`server.mts:1583`). Add it, with a test.
3. **One Cerebras key convention.** `CEREBRAS_KEY_2` is honoured by V3 and ignored by CW2; also give V3 the key rotation CW2 already has.
4. **Retire or wire the CW2 `POST /worlds/generate` path.** No page calls it, yet `/health` still advertises it.
5. **Jobs are in-process, file-backed and single-instance.** They are lost on a multi-instance deploy. Move them to Supabase before scaling.
6. **Remove the frontend pages with no real function.**
   - The 8 `cr-*` pages are now redirected; delete the files.
   - Remove the 10 "not built" AI-Studio builders from navigation until they exist.

## Stage 2: the AI game-creation phase (this is what the recovery unblocks)

Current reality: see `DCS_GAMES_CURRENT_AI_PIPELINE.md`.
- One LLM (Cerebras `gpt-oss-120b`) writes the plan.
- Everything else is deterministic and well tested.
- Multiplayer is not integrated.

1. **Provider strategy (FD).** Decide the model roster per lane before adding keys. Today only Cerebras is keyed, and DeepSeek/Together are coded but UNAVAILABLE. Lanes and their current fallbacks:
   - architect, fast and gameplay (currently Cerebras)
   - spatial (currently a local heightmap)
   - 3D (currently curated archetypes)
   - media (currently a placeholder SVG)
   - vision (currently none)
2. **Evaluation harness first.** Before swapping models, add a fixed prompt set and score each lane's output on:
   - manifest validity
   - playtest pass rate
   - diversity
   - latency and cost

   `tools/live-provider-check.mjs` is the seed of it.
3. **Make generation visibly AI where it matters.** Vision input from create-v3 (the backend already accepts `image_data_url`), and key art via the media lane once a vendor is chosen.
4. **Companion and world memory are deterministic today.** Decide whether an LLM should back them (cost and safety review), grounded in the existing memory stores.
5. **Multiplayer.**
   - Replace netcode's `mockTokenVerifier` with Supabase JWT verification.
   - Add the missing `/persistence/delta` route to `gb`.
   - Add a WebSocket client to `play-v3`.
   - Deploy netcode as its own Railway service.

## Stage 3: UI debt still open after this recovery

- The dashboard still has many player pages rendering honestly labelled **sample** content (133 pages carry the sample banner). Wire them to real routes as they land, or trim navigation to what is real.
- Dead `href="#"` links remain on a number of legacy marketing pages (see the route matrix, `deadLinks`).
- The `.app` legacy shell rule in `dcsgames.css` is unused and can be deleted.
- `index.html` carries its own header instead of `site-chrome.js`. Consolidate onto one header component so a fix lands everywhere at once. That split is why the home page kept "Log in" and "OV" after the shared header was fixed once before.
