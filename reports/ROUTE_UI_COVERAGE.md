# Route-to-UI coverage

Backend: https://dcs-games-backend-staging.up.railway.app
Build:   dd49eff09aaa (deployment d3514782-356d-4554-a6a2-f2f9aedd6c32)
Site:    /Users/NEWUSER/Desktop/Project DCSAI/dcs-games-LIVE

56 live routes, 9 retired, 31 distinct paths requested by the UI.

## Dead buttons — the UI calls a path the backend genuinely does not serve (9)

- `/api/me/home` (HTTP 404) — player-home.html
- `/api/public/atlas/feed` (HTTP 404) — assets/seed-data.js
- `/api/public/atlas/stats` (HTTP 404) — games-atlas.html
- `/api/public/events` (HTTP 404) — assets/seed-data.js
- `/api/public/market` (HTTP 404) — assets/seed-data.js
- `/api/public/stats` (HTTP 404) — assets/seed-data.js
- `/atlas/verify` (HTTP 404) — assets/dcs-truth.js
- `/social/friends/accept` (HTTP 404) — social-v3.html
- `/worlds/generate` (HTTP 404) — games-create.html, studio/pages/ai-studio/world-builder.html, studio/pages/studio-overview-ai-world-builder.html

## Unadvertised — the route answers, but /health does not list it (4)

The route inventory is what a reader trusts to know what exists. These work and are absent from it.

- `/api/auth/ensure` — exists (unadvertised), HTTP 410 — assets/auth.js
- `/api/public/worlds` — exists (unadvertised), HTTP 200 — assets/dcs-truth.js, assets/seed-data.js, games-atlas.html
- `/api/worlds/mine` — exists (auth required), HTTP 401 — assets/dcs-truth.js, player-achievements.html, player-crew-mycrew.html
- `/safety/blocks` — exists (auth required), HTTP 401 — social-v3.html

<!-- 2 path prefixes built by concatenation, matched by prefix: /worlds/, /social/parties/ -->

## Unreached capability — a live route no page ever calls (25)

### identity (3)
- `GET /profiles/:username`
- `POST /verify/:channel/confirm`
- `POST /verify/:channel/start`

### social (2)
- `GET /social/orgs`
- `POST /social/studios`

### marketplace (5)
- `GET /v3/marketplace`
- `GET /v3/marketplace/assert-dark`
- `GET /v3/marketplace/ledger`
- `GET /v3/marketplace/owned`
- `POST /v3/marketplace/listings`

### subscriptions (6)
- `GET /v3/subscriptions/assert-dark`
- `GET /v3/subscriptions/grants`
- `GET /v3/subscriptions/plans`
- `POST /v3/subscriptions/grant`
- `POST /v3/subscriptions/revoke`
- `POST /v3/subscriptions/subscribe`

### safety (5)
- `GET /safety/age`
- `GET /safety/consent/media`
- `GET /safety/moderation-history`
- `GET /safety/reports`
- `POST /safety/report`

### jobs (1)
- `GET /v3/jobs`

### trust (3)
- `GET /atlas/key`
- `GET /atlas/receipt/:id`
- `GET /verify`

## Reached (31)

- `POST /v3/worlds/generate` <- create-v3.html, history-v3.html, play-v3.html
- `POST /v3/worlds/generate/async` <- create-v3.html, history-v3.html, play-v3.html
- `GET /v3/worlds/:id/manifest` <- create-v3.html, history-v3.html, play-v3.html
- `POST /v3/worlds/:id/playtest` <- create-v3.html, history-v3.html, play-v3.html
- `POST /v3/worlds/:id/expand` <- create-v3.html, history-v3.html, play-v3.html
- `POST /v3/worlds/:id/edit` <- create-v3.html, history-v3.html, play-v3.html
- `POST /v3/worlds/:id/stitch` <- create-v3.html, history-v3.html, play-v3.html
- `POST /v3/worlds/:id/fork` <- create-v3.html, history-v3.html, play-v3.html
- `GET /v3/worlds/:id/versions` <- create-v3.html, history-v3.html, play-v3.html
- `POST /v3/worlds/:id/rollback` <- create-v3.html, history-v3.html, play-v3.html
- `GET /v3/worlds/:id/diff` <- create-v3.html, history-v3.html, play-v3.html
- `GET /v3/worlds/:id/memory` <- create-v3.html, history-v3.html, play-v3.html
- `POST /v3/worlds/:id/companion` <- create-v3.html, history-v3.html, play-v3.html
- `POST /v3/worlds/:id/media` <- create-v3.html, history-v3.html, play-v3.html
- `GET /v3/discover` <- explore-v3.html
- `POST /v3/worlds/:id/play` <- create-v3.html, history-v3.html, play-v3.html
- `POST /v3/worlds/:id/rate` <- create-v3.html, history-v3.html, play-v3.html
- `GET /v3/worlds/:id/stats` <- create-v3.html, history-v3.html, play-v3.html
- `GET /me/profile` <- profile-v3.html
- `GET /me/achievements` <- profile-v3.html
- `GET /me/streak` <- profile-v3.html
- `GET /me/dashboard` <- history-v3.html, profile-v3.html
- `GET /verify/status` <- profile-v3.html
- `GET /social/friends` <- social-v3.html
- `GET /social/parties` <- social-v3.html
- `GET /social/teams` <- social-v3.html
- `GET /me/subscription` <- profile-v3.html
- `GET /me/entitlements` <- profile-v3.html
- `POST /safety/block` <- social-v3.html
- `GET /v3/jobs/:id` <- create-v3.html
- `GET /v3/providers` <- create-v3.html
