# DCS Games — UI route audit (28 Sep 2026)

The full per-route data is in `DCS_GAMES_ROUTE_MATRIX.csv`: 191 routes × 13 columns, with a STATUS column. This page explains how the data was gathered, the results, and each defect family.

## Method

- **What was crawled.** Every one of the 191 HTML routes in `dcs-games-LIVE` was loaded in headless Chromium (Playwright) at 1920×1080, 1440×900, 1280×800, 390×844 and 320×700.
  - Each route was crawled twice: **signed out**, and **signed in as an internal tester**. That is 1,910 page loads.
  - It ran against a local server that mimics Cloudflare Pages (`_redirects`, `.html` stripping, `index.html` → `dir/`, and a real 404).
- **API calls.** Calls to the staging API (`dcs-games-backend-staging.up.railway.app`) were proxied server-side, so CORS could not hide what the server really answers.
  - Writes (non-GET) were **blocked**, so the audit never wrote to staging.
  - In signed-in mode, identity routes (`/me/*`, `/social/*`) were stubbed as an empty account, because no staging credentials exist on disk. Public routes went to staging without the fake token.
- **"Reachable" means a person can reach it, not a script.**
  - For a sample of controls on each page (the last six plus eight spread through it), the crawler scrolls each control into view and hit-tests its centre.
  - A control only counts as reachable if nothing covers it and no `overflow:hidden` ancestor (including a locked `<html>`/`<body>`) had to be scrolled by script to show it.
- **Also recorded per load:**
  - HTTP status and redirects
  - page errors and console errors
  - failed requests and API status codes
  - horizontal overflow and scroll containers
  - header and sidebar presence
  - sample banners, SOON blocks and `href="#"` links
  - text reading undefined, NaN or `[object Object]`
- **Tooling.** Crawler, server and matrix builder are in `evidence/` (`audit.mjs`, `pages-server.mjs`, `matrix.py`), with the raw JSON.

## Results

| | Before (HEAD `2cce536`, signed-out crawl) | After (this branch, both crawls) |
|---|---|---|
| Routes | 191 | 191 |
| Green | 135 | **190** |
| Broken | 56, all "content unreachable by scrolling" | **0** |
| Unverified | — | 1 (`/profile-v3`: needs a real account, see below) |
| Routes with JS errors | 0 | **0** |
| Routes with horizontal scroll | 0 signed out | **0** at all five widths, signed in and signed out |

The before column **understates** the damage, for two reasons:
- The signed-out crawl never opened the 66 internal-tester pages. Opened as a tester, **all 42 Creator Studio routes** had content cut off (see §3).
- Production (`efcb7c6`) is worse than HEAD. Its dashboard locked the whole viewport, not just the shell: 57 of 58 player pages were unreachable at 390×844.

**Route inventory:**
- 73 marketing pages (site header)
- 59 player-dashboard pages (sidebar shell)
- 42 Creator Studio pages (three-pane app shell)
- 7 V3 journey pages (V3 header)
- the auth pages (login, signup, auth-callback)
- 5 legal pages
- 404
- `play` / `play-v3`

**Auth behaviour, signed out:**
- `/player-home` and `/studio` redirect to `/login?next=…`.
- 66 builder, economy and studio pages show the internal-tester gate.
- Everything else is public.

## Defect families found and fixed

### 1. Dashboard could not scroll (founder-reported)

Covered in detail in the main report. In short:
- `body:has(.pd){height:100vh;overflow:hidden}` in production, then `.pd{height:100vh;overflow:hidden}` in HEAD, with no inner scroller in either.
- **Fix:** the document is the one scroll. The sidebar is sticky and scrolls itself, the phone drawer locks the page behind it while open, and the top bar stays sticky.

### 2. Dashboard layout
- **Phone header.** Burger, search, create, bell and avatar needed about 470px in a 390px bar. The search input was crushed to the width of its icon, and the avatar was squeezed into an oval off the edge.
  - Fixed: create becomes icon-only, the decorative bell steps aside, and search keeps at least 100px (tested).
- **Search did nothing.** The dashboard search box was wired to nothing on 59 pages. It now submits to `/explore-v3?q=`, and Explore reads `q`.
- **KPI tiles were unstyled.** `.kpi-card`, drawn on 15 pages, had no CSS at all and painted as loose stacked text. It is now a card that matches `.kpi`, two per row on phones.
- **Content ran off the right edge.** `.grid2` used `fr` tracks, so a feed of worlds widened the left column to about 1,860px and pushed the dashboard off-screen. Fixed with `minmax(0,…)`.
- **Hero alignment.** The dashboard hero mixed a centred title with a left-set paragraph and buttons, because two `.hero-inner` rules collided. It is now scoped.
- **No sign-out.** The dashboard had no way to sign out. The sidebar now has one.

### 3. Creator Studio shell (42 routes)
- **Panes pushed off-screen.** A flat `100vh` grid sat under banners inserted above it, in a body that cannot scroll. The last rail links and the end of every pane were off-screen.
  - Fixed: the body is a flex column and the grid takes the remaining height.
  - Two pages carried their own inline copy of the stylesheet and are fixed identically.
- **Phone top bar spilled over the page.** The top bar wraps on phones, but its grid row was a fixed 58px, so wrapped controls covered the page title. The row is now `auto`.
- **Hidden labels stretched the page.** Absolutely-positioned screen-reader labels made the locked page 80px taller, so focusing the prompt could shove the studio up. The panes are now their containing blocks.
- **Metrics cut off on phones.** Metric tiles stayed at three columns on phones, cutting off the third. It is now two.
- **Atlas page broken.** `studio/pages/atlas.html` had an orphaned block with invented counts ("Verified Worlds 2431", "Receipts Issued 412") and a stray `</div>` that closed the main pane early. Every section below it was painted over the sidebar. **This was already broken in HEAD.**
- **Fake avatar.** The avatar read "GW" for everyone on the two inline-stylesheet pages. It now shows the signed-in account's initials.

### 4. Header and session state
- **Header said "Log in" when signed in.** This affected the marketing header on 73 pages, and the home page carried "Log in" plus a fake "OV" avatar. That is part of the login report; see `DCS_GAMES_AUTH_ROOT_CAUSE.md`.
- **Signed-in header too wide.** The signed-in header gained Log out, and the now-redundant Dashboard button steps aside so the header still fits at 1280px.

### 5. Player pages (`play`, `play-v3`)
- **Title stuck on "Loading…".** Without `?world=`, both left the title on "Loading…" forever. It now says what happened, and `/play` links to Create and Explore.
- **Stage cut off.** `/play` sized its stage as `calc(100vh - 53px)`, ignoring the banner and a wrapped phone header. It is now a flex column.
- **Links pointed at the legacy builder.** "New world" and "Build another world" pointed at the legacy world-builder page; they now go to `/create-v3`.

### 6. Routing
- **`/legal` redirect loop.** `_redirects` `/legal/ → /legal/index.html` meets Pages' own `index.html → dir/` rule. That is the same mechanism as the documented `/play` infinite loop, waiting to happen on deploy. The rule is removed, and the test harness now mirrors Pages for directories.
- **Fake generator pages.** Eight `cr-*` pages were fake generators: a 600 ms animation ending "✅ Ready!", with no request sent. They are 301-redirected to `/create-v3` and the studio overview.
- **404 page links.** It linked "Play" to a player with no world, and "Legal" via two redirect hops. Both fixed.

### 7. Hygiene
- **`hidden` did nothing.** No rule enforced `[hidden]`, so any `display` rule overrode the attribute. This is why login's staff-only email form painted on production hosts. A global `[hidden]{display:none!important}` was added.
- **Obsolete references.** `DEPLOY.md` gave a stale path (`Project TRDN/…`) and claimed guest sign-in works. `beta-lock.js` doc example named another product.

## Remaining, honestly labelled

| Item | Where | Why it is not "fixed" |
|---|---|---|
| `/profile-v3` UNVERIFIED | matrix | Looks up `/profiles/<username>`. The audit's stub identity has no staging profile, so it 404s. Needs a real account |
| 131 routes carry the **sample-data banner** | matrix `PLACEHOLDERS` | Honest labelling of bundled examples, not a bug. Replacing them with live data is roadmap work |
| 36 routes with visible `href="#"` links | matrix `BROKEN_CONTROLS` | Legacy marketing sub-pages. Listed per route for cleanup |
| Beta-lock overlay on `/login`, `/studio`, `/player-home` (production host) | matrix notes | Deliberate modal. Keeping it is a founder decision (auth report A-3) |
| `/v3/discover` NETERR in a few rows | matrix | Staging timeouts under 8-way crawl concurrency. The endpoint answers 200 in 1.4–2.4 s when called directly |

## Screenshots

In `screenshots/after/`, all at 1440×900 and 390×844:
- `home`
- `home-signed-in`
- `login` (production-host view, including the beta overlay)
- `player-home`
- `create-v3`
- the studio overview

In `screenshots/before/`: `player-home` and the studio overview, from the unfixed HEAD, for comparison.
