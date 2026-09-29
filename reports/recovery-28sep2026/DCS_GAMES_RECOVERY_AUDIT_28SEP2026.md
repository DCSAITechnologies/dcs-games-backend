# DCS Games — website + dashboard recovery audit (28 Sep 2026)

**Scope:**
- A forensic audit of the website and dashboard.
- Root-cause fixes for the two founder-reported defects: bounced out after login, and a dashboard that cannot scroll.
- A full route audit, then UI cleanup.
- An audit of the current AI game-creation surface.

**Nothing was deployed. Production was not touched.** All proof is local, against a Pages-faithful server with the staging API read-only.

| Companion document | Contents |
|---|---|
| `DCS_GAMES_AUTH_ROOT_CAUSE.md` | The login loop: four defects, the fix, and before/after tests |
| `DCS_GAMES_UI_ROUTE_AUDIT.md` + `DCS_GAMES_ROUTE_MATRIX.csv` | 191 routes × 5 viewports × signed in / signed out |
| `DCS_GAMES_CURRENT_AI_PIPELINE.md` | Providers, the generation flow, and stage-by-stage status |
| `DCS_GAMES_NEXT_BUILD_ROADMAP.md` | What to do next, with founder decisions flagged |
| `evidence/`, `screenshots/` | Raw crawl JSON, tooling, and before/after screenshots |

## Phase 0: authoritative source

Sixteen DCS Games checkouts exist on disk, plus copies in `~/.Trash` and `~/Downloads`. They were fingerprinted by remote, branch, last commit and, for the frontend, **byte comparison against what games.dcsai.ai actually serves**.

| | Value |
|---|---|
| AUTHORITATIVE_REPO (frontend) | `~/Desktop/Project DCSAI/dcs-games-LIVE`, remote `DCSAITechnologies/dcs-games-frontend`, `main` @ `2cce536` (in sync with origin) |
| AUTHORITATIVE_REPO (backend) | `~/Desktop/Project DCSAI/dcs-games-6month-deploy/gb`, remote `bank` = `DCSAITechnologies/dcs-games-backend-sprint-sep2026`, branch `sprint/2026-09-canonical` @ `cd9856d`. Its `test/helpers/site.mjs` resolves the frontend at `../../../dcs-games-LIVE` |
| Evidence / runbooks repo | `~/Desktop/Project DCSAI/DCS_GAMES_SPRINT_SEP2026` (`dcs-games-sprint-sep2026`) |
| Netcode | `~/Desktop/Project DCSAI/cw4-deploy/dcs-games-netcode` (`repair/2026-09-netcode` @ `524a7f6`) |
| FRAMEWORK | Frontend: static multi-page HTML/CSS/vanilla JS (191 pages), supabase-js from a CDN. Backend: Node + `tsx` (`server.mts`), Supabase Postgres + file store |
| DEPLOY_TARGET | Frontend: Cloudflare Pages project `dcs-games`. Backend: Railway project `dcs-games-backend` (`caba432a-…`), environments `production` and `Staging` |
| PUBLIC_URL | https://games.dcsai.ai (API `https://api.games.dcsai.ai`) |
| STAGING_URL | API `https://dcs-games-backend-staging.up.railway.app` (serving `e7d175f`); frontend previews on `*.dcs-games.pages.dev` (e.g. `sprint-preview-07sep2026`) |
| SUPABASE_PROJECT | Production `hznrmbxppcxrrrmyutjn`; staging `nemmayskbjugulrncufd`. They are paired with the API by hostname in `assets/dcs-truth.js` |
| RAILWAY_PROJECT | `dcs-games-backend` (`caba432a-9de3-488b-9613-cc2902999dd7`) |

**What production actually serves:**
- **games.dcsai.ai is commit `efcb7c6` (6 Sep).** Every sampled file matches that commit byte for byte, apart from Cloudflare's injected challenge script.
- The 34 frontend commits after it, including the 7 Sep auth fix, **have never been deployed**.
- `api.games.dcsai.ai` is an older backend with **no V3 routes** (`/v3/providers` → 404).

**Stale or duplicate checkouts: do not work in these.**
- **Old backend clones:** `dcs-games-backend` (origin `dcs-games-backend`, 6 Sep), `dcs-games-deploy/…`, `games-backend-v3/…`, `games-backend-v4/…`, `backend-deploy/…` and `dcs-games-3month-deploy/backend`. All are June-era.
- **Old frontend-era folders:** `DCS Game/…` and `Downloads/DCS Game/…` (CW3/CW4/CW6/CW8 hand-offs), plus the `.Trash` copies.
- **Wrong path in `DEPLOY.md`:** it pointed at `Project TRDN/dcs-games-LIVE`, which no longer holds the repo. Corrected.

## Phase 1: baseline and backup

- **Bundles:** `~/Desktop/Project DCSAI/_backups/dcs-games-recovery-28sep2026/`
  - `dcs-games-frontend-2cce536.bundle` and `dcs-games-backend-gb-cd9856d.bundle` (both `git bundle verify` OK)
  - a patch of the one pre-existing uncommitted frontend change
  - the production byte snapshot
- **Branch** `fix/dcs-games-website-dashboard-recovery-28sep2026` was created in **both** repos.
  - The pre-existing uncommitted `login.html` change (a WCAG placeholder removal) was preserved as its own first commit.
- **Build/test commands** (backend `package.json`):
  - `test:unit`, `test:unit:tsx`, `test:api`, `test:load`, `test:browser`, `test:e2e`
  - `secret-scan`
  - The frontend has no build step, no lint and no typecheck.

## Phase 3: login / "bounced out" root cause

Four frontend defects. Detail and tests are in `DCS_GAMES_AUTH_ROOT_CAUSE.md`.

1. **The token was never refreshed.** The 1-hour access-token copy was never refreshed on 186 of 191 pages, and even on the other 5 it was used before supabase-js hydrated.
2. **`/login` bounced a dead token back.** It redirected on "a token string exists", straight back to a dashboard that had just rejected it. That is the loop.
3. **The header said "Log in" to signed-in people** on 73 pages, plus a fake "OV" avatar on the home page.
4. **Sign-out was wrong.** It was global across all devices, and the V3 header's sign-out did not end the Supabase session at all.

Also fixed: an **open redirect** via `?next=`.

Founder decisions surfaced:
- Production anonymous sign-ins are **off**, so the guest button always fails there.
- The client-side beta-lock uses a two-email allowlist.
- The Google OAuth allowlist is **UNVERIFIED** from outside.

## Phase 4: scroll / layout root cause

- **Production:** `body:has(.pd){height:100vh;overflow:hidden}`. Body overflow propagates to the viewport, so every player page was exactly one screen tall.
- **HEAD:** moved the same lock onto `.pd` (`height:100vh; overflow:hidden`) with no scroll container inside, so content was clipped instead.
- **Measured before:** content was unreachable on 56/56 player pages at 1440×900 and 1280×800, and 55/56 at 390×844 and 320×700. Production: 57/58 at 390×844.
- **Fix:**
  - One primary scroll per screen: the document.
  - The sidebar is `position:sticky` and scrolls itself when its links outgrow the window.
  - The phone drawer scrolls itself and locks the page behind it while open.
- **The same bug class, found and fixed:**
  - the Creator Studio shell (42 routes)
  - `/play`
  - the studio Atlas page (a pre-existing markup break)
- **Tested** at 1920×1080, 1440×900, 1280×800, 390×844 and 320×700.

## Phase 5: UI cleanup (preserving product identity)

No redesign: same tokens, same components, same copy voice. Summary (full list in the route audit):
- **Dashboard layout:**
  - a phone header that fits
  - search that works
  - styled KPI tiles
  - no off-screen column
  - consistent hero alignment
  - a sign-out control
  - a compact phone banner
- **Studio:**
  - banners no longer push the panes off-screen
  - the phone top bar no longer covers content
  - two metric columns on phones
  - the Atlas page is repaired
- **Fabrications removed:**
  - the "OV" and "GW" avatars
  - the "2431 / 412" counters
  - the eight fake `cr-*` generators, now redirected
- **Routing:** `/legal` redirect loop prevented, 404 links fixed, `play` titles no longer stuck on "Loading…", and the global `[hidden]` rule.

## Phase 6: API and data integrity

Every endpoint the frontend calls was traced from the crawl request logs plus a static grep.

**All 50 endpoints exist in the backend route inventory:**
- no 404s
- no stale endpoints
- no third Supabase project
- staging CORS allows `games.dcsai.ai` and `*.dcs-games.pages.dev`
- no schema change was made or needed

| Endpoint group | Method | Auth | Current response (staging) | Frontend handling |
|---|---|---|---|---|
| `/v3/discover`, `/api/public/{worlds,stats,events,market,atlas/*}`, `/atlas/key`, `/v3/marketplace{,/split,/assert-dark}`, `/v3/subscriptions/{plans,assert-dark}`, `/health` | GET | public | 200 (1.4–2.4 s for discover) | Renders; failure is shown as "unavailable (status)" |
| `/me/{home,profile,streak,achievements,dashboard,subscription,entitlements}`, `/social/*`, `/safety/*`, `/verify/status`, `/v3/marketplace/{owned,ledger,storefronts}`, `/api/worlds/mine`, `/v3/jobs` | GET | bearer | 401 signed out (expected) | 401 → one refresh + retry. Then "session expired" / sign-in. Now never loops |
| `/v3/subscriptions/grants` | GET | internal tester | 200 / 403 | Drives the tester gate (fails closed) |
| `/v3/worlds/generate/async`, `/v3/worlds/:id/{edit,expand,playtest}`, `/worlds/:id/publish` | POST | tester / bearer | not exercised (the audit blocks writes) | Covered by backend tests (API 126/126) |

**Findings:**
- **F-API-1.** Public routes answer **401 to any invalid bearer** instead of treating the caller as anonymous, so a dead session blanked public feeds. Mitigated in the frontend with an anonymous retry for reads. Backend fix is on the roadmap.
- **F-API-2.** `GET /safety/moderation-history` is public by design as a transparency log, but it exposes internal principal ids (`decided_by`) and report ids. **Founder / security review.**
- **F-API-3.** Six pages call `GET /api/worlds/mine` even when signed out. It is harmless (a 401) but noisy.

## Phase 7: current game-creation surface

See `DCS_GAMES_CURRENT_AI_PIPELINE.md`. In short:
- **Only Cerebras (`gpt-oss-120b`) is keyed on staging.**
- DeepSeek, Together, media, vision, spatial and 3D are all unavailable, so their lanes run on deterministic local fallbacks.
- **No OpenAI, Anthropic, Google, Runway, World Labs, LTX, Stability, Hedra or HeyGen integration exists.**
- The V3 create → playtest → publish → versions → play journey works on staging.
- Production cannot run it: there are no V3 routes there.
- **Multiplayer is not integrated.** Netcode uses a mock token verifier, and the frontend has no WebSocket client.

## Phase 8: build and test

| Check | Result |
|---|---|
| Build | N/A. The static frontend has no build step. Backend runs via `tsx` |
| Typecheck | N/A. No typecheck is configured in either repo |
| Lint | Every JS asset and all 190 inline `<script>` blocks on 191 pages parse cleanly (`evidence/lint-inline.mjs`). `npm run secret-scan`: CLEAN, 435 files |
| `test:unit` | 1113 / 1113 |
| `test:unit:tsx` | 69 / 69 |
| `test:api` | 126 / 126 |
| `test:load` | 6 / 6 |
| `test:browser` | **140 / 140 on a complete run (0 skipped).** That run came before the final studio, `/play` and header edits; every suite was then rerun on the final code — see the note below the table |
| `test:e2e` (flagship) | Not run. It needs live staging credentials and performs writes |

**About the later full runs (reported, not hidden).**
- Two later complete `test:browser` runs on the final code scored 139/140 and 130/140. The failures were all `CDP timeout`.
- **What the timeouts were:** the shared test tab stopped answering the driver.
  - In the `browser-compat` ESTATE sweep, which visits all 191 pages in one tab and failed as a cascade.
  - In one runtime frame-budget timing test.
- **Why this is load, not a code fault:**
  - The machine's load average was **97–209**, with 230 Chrome processes from other sessions on the same host.
  - Every failing test **passed when rerun in isolation on the same code**:
    - runtime-perf 16/16
    - ESTATE 9/9 (sweep 147 s)
    - the 13 BACKEND / REFLOW / TOUCH / MOTION / CONTRAST / COMPAT tests 13/13
  - The final per-suite reruns are listed at the end of this report.
- **Diagnostic added:** `helpers/browser.mjs` now names the page in a CDP timeout.
- **Recommendation:** rerun `npm run test:browser` once on an idle machine or in CI before merging.

**New regression coverage** (both files are in `test:browser`):
- **`test/auth-session-refresh.test.mjs` (9 tests):**
  - login → dashboard → refresh → navigate → return
  - expired-token refresh
  - the page without `auth.js`
  - the dead-session loop, two ways
  - the accepted-session control
  - the open redirect
  - two sign-out tests
- **`test/dashboard-layout.test.mjs` (19 tests):**
  - dashboard scroll at 5 viewports
  - the sticky sidebar
  - the phone drawer
  - the phone header
  - the studio shell at 5 viewports
  - the create page loading
  - navigation integrity
- **Negative control:** against unfixed HEAD, 23 of the 28 new tests fail, each for the defect it names. The ones that pass there are controls.

**Existing tests adjusted, with reasons:**
- **`test/helpers/browser.mjs`:** the static server now answers a directory without a trailing slash with a redirect to `dir/`, as Cloudflare Pages does. The `/legal` test previously passed only because of the `_redirects` rule that loops on Pages.
- **`test/header-nav.test.mjs`:** the avatar is identified by its class instead of its fake "OV" text. The assertion itself is unchanged.

## Phase 9: preview

- The local, Pages-faithful preview is reproducible: `node evidence/pages-server.mjs <dcs-games-LIVE> 8790`.
- Screenshots of Home, Home signed in, Login, Dashboard, Create and Creator Studio are in `screenshots/after/` at 1440×900 and 390×844. Dashboard and Studio "before" shots are in `screenshots/before/`.
- **No staging (Cloudflare preview) deploy was made.** Creating a Pages preview is an outward action needing founder approval (roadmap 0.1).

## Production

`PRODUCTION_TOUCHED=NO`. Nothing was deployed or pushed to Cloudflare, Railway or Supabase. The only network calls were:
- read-only GETs to public endpoints
- one Supabase `/auth/v1/authorize` probe to inspect redirect handling, which creates no account or session

## Appendix: final per-suite reruns on the final code (29 Sep, 01:30–01:50 IST)

| Suite / group | Result | Machine load avg |
|---|---|---|
| frontend-truth, runtime-v3, a11y-pages, auth-session-continuity, header-nav, auth-session-refresh, dashboard-layout | 95 / 96 | ~230 |
| browser-compat: static COMPAT + focus-ring group | 6 / 6 | ~230 |
| browser-compat: REFLOW, TOUCH, MOTION, CONTRAST MODE, COMPAT gap, 7× BACKEND | 13 / 13 | ~90 |
| browser-compat: 9× ESTATE (the 191-page sweep) | 9 / 9 | high |
| runtime-perf | 16 / 16 | high |

**The one failure is `runtime-v3` "B15 GATE: the world is fully playable from the keyboard alone"** ("J and L must turn the camera, turned 0.058–0.078 rad", threshold 0.1).
- **It is load, not this change.** The **unfixed baseline (`2cce536`) fails it identically** under the same load (load avg 244).
- **Why load breaks it:** the test holds a key for a fixed wall-clock time, and a starved renderer draws fewer frames in that time.
- **It passed in the earlier 140/140 run.**
- **Rerun it on an idle machine.**
