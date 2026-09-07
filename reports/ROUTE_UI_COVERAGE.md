# Route-to-UI coverage

Backend: https://dcs-games-backend-staging.up.railway.app
Build:   abbba0ce14d6 (deployment bc0d4c28-4280-4570-8171-35c975f42223)
Site:    /Users/NEWUSER/Desktop/Project DCSAI/dcs-games-LIVE

100 live routes, 14 retired, 29 distinct paths requested by the UI.

## Dead buttons — the UI calls a path the backend genuinely does not serve (0)

None.


## Unadvertised — the route answers, but /health does not list it (1)

The route inventory is what a reader trusts to know what exists. These work and are absent from it.

- `/api/auth/ensure` — exists (unadvertised), HTTP 410 — assets/auth.js

## Unreached capability — a live route no page ever calls (45)

### discovery (4)
- `GET /api/public/atlas/feed`
- `GET /api/public/atlas/stats`
- `GET /api/public/events`
- `GET /api/public/market`

### identity (6)
- `GET /me/home`
- `GET /profiles/:username`
- `POST /auth/login`
- `POST /auth/signup`
- `POST /verify/:channel/confirm`
- `POST /verify/:channel/start`

### social (12)
- `DELETE /social/orgs/:id/members`
- `DELETE /social/teams/:id/members`
- `GET /social/orgs`
- `GET /social/orgs/:id`
- `GET /social/studios/:id`
- `GET /social/teams/:id`
- `POST /social/orgs/:id/members`
- `POST /social/orgs/:id/seats`
- `POST /social/studios`
- `POST /social/studios/:id/members`
- `POST /social/studios/:id/split`
- `POST /social/teams/:id/members`

### marketplace (8)
- `DELETE /v3/marketplace/listings/:id`
- `GET /v3/marketplace/assert-dark`
- `GET /v3/marketplace/ledger`
- `GET /v3/marketplace/owned`
- `GET /v3/marketplace/split`
- `POST /v3/marketplace/listings`
- `POST /v3/marketplace/listings/:id/acquire`
- `POST /v3/marketplace/storefronts`

### subscriptions (5)
- `GET /v3/subscriptions/assert-dark`
- `GET /v3/subscriptions/plans`
- `POST /v3/subscriptions/grant`
- `POST /v3/subscriptions/revoke`
- `POST /v3/subscriptions/subscribe`

### safety (7)
- `GET /safety/age`
- `GET /safety/consent/media`
- `GET /safety/moderation-history`
- `GET /safety/reports`
- `POST /safety/consent/parental`
- `POST /safety/report`
- `POST /safety/reports/:id/moderate`

### jobs (1)
- `GET /v3/jobs`

### trust (2)
- `GET /health`
- `GET /verify`

## Reached (55)

- `POST /worlds/generate` <- create-v3.html, play.html, studio/pages/ai-studio/world-builder.html (+1)
- `GET /worlds/mine` <- create-v3.html, play.html, studio/pages/ai-studio/world-builder.html (+7)
- `GET /worlds/:id/manifest` <- create-v3.html, play.html, studio/pages/ai-studio/world-builder.html (+1)
- `POST /worlds/:id/save` <- create-v3.html, play.html, studio/pages/ai-studio/world-builder.html (+1)
- `GET /worlds/:id/load` <- create-v3.html, play.html, studio/pages/ai-studio/world-builder.html (+1)
- `POST /worlds/:id/publish` <- create-v3.html, play.html, studio/pages/ai-studio/world-builder.html (+1)
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
- `GET /v3/worlds/:id/attribution` <- create-v3.html, history-v3.html, play-v3.html
- `GET /v3/worlds/:id/parts` <- create-v3.html, history-v3.html, play-v3.html
- `POST /v3/worlds/:id/quests/generate` <- create-v3.html, history-v3.html, play-v3.html
- `POST /v3/worlds/:id/stitch/preview` <- create-v3.html, history-v3.html, play-v3.html
- `GET /v3/worlds/:id/versions/:n` <- create-v3.html, history-v3.html, play-v3.html
- `GET /v3/worlds/:id/npcs/:npc/memory` <- create-v3.html, history-v3.html, play-v3.html
- `GET /v3/discover` <- assets/seed-data.js, explore-v3.html, games-atlas.html
- `GET /api/public/worlds` <- player-play.html
- `GET /api/public/stats` <- assets/seed-data.js
- `POST /v3/worlds/:id/play` <- create-v3.html, history-v3.html, play-v3.html
- `POST /v3/worlds/:id/rate` <- create-v3.html, history-v3.html, play-v3.html
- `GET /v3/worlds/:id/stats` <- create-v3.html, history-v3.html, play-v3.html
- `GET /me/profile` <- player-home.html, profile-v3.html
- `GET /me/achievements` <- player-home.html, profile-v3.html
- `GET /me/streak` <- player-home.html, profile-v3.html
- `GET /me/dashboard` <- history-v3.html, player-home.html, profile-v3.html
- `GET /verify/status` <- profile-v3.html
- `GET /social/friends` <- player-home.html, social-v3.html
- `POST /social/friends/accept` <- social-v3.html
- `GET /social/parties` <- social-v3.html
- `GET /social/teams` <- social-v3.html
- `GET /social/parties/:id` <- social-v3.html
- `POST /social/parties/:id/join` <- social-v3.html
- `POST /social/parties/:id/leave` <- social-v3.html
- `GET /v3/marketplace` <- assets/seed-data.js, games-marketplace.html
- `GET /v3/subscriptions/grants` <- assets/dcs-truth.js
- `GET /me/subscription` <- profile-v3.html
- `GET /me/entitlements` <- profile-v3.html
- `GET /safety/blocks` <- social-v3.html
- `POST /safety/block` <- social-v3.html
- `GET /v3/jobs/:id` <- create-v3.html
- `GET /atlas/key` <- assets/dcs-truth.js, games-atlas.html
- `DELETE /verify/:channel` <- profile-v3.html
- `GET /atlas/receipt/:id` <- assets/dcs-truth.js
- `GET /v3/providers` <- create-v3.html
