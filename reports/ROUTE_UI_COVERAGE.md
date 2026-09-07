# Route-to-UI coverage

Backend: https://dcs-games-backend-staging.up.railway.app
Build:   54ccd1722381 (deployment 2fdf2945-9567-47fc-9755-f06e4fb6831c)
Site:    /Users/NEWUSER/Desktop/Project DCSAI/dcs-games-LIVE

105 live routes, 15 retired, 57 distinct paths requested by the UI.

## Dead buttons — the UI calls a path the backend genuinely does not serve (0)

None.


## Unadvertised — the route answers, but /health does not list it (0)

None.


## Unreached capability — a live route no page ever calls (11)

### identity (2)
- `POST /auth/login`
- `POST /auth/signup`

### marketplace (1)
- `POST /v3/marketplace/storefronts`

### subscriptions (2)
- `POST /v3/subscriptions/grant`
- `POST /v3/subscriptions/revoke`

### moderation_legacy (3)
- `GET /ts/reports`
- `POST /ts/reports/:id/action`
- `POST /ts/reports/:id/appeal/decide`

### payouts_dark (2)
- `GET /payout/kyc`
- `POST /payout/kyc/start`

### trust (1)
- `GET /verify`

## Reached (94)

- `POST /worlds/generate` <- create-v3.html, play.html
- `GET /worlds/mine` <- create-v3.html, play.html, player-achievements.html (+5)
- `GET /worlds/:id/manifest` <- create-v3.html, play.html
- `POST /worlds/:id/save` <- create-v3.html, play.html
- `GET /worlds/:id/load` <- create-v3.html, play.html
- `POST /worlds/:id/publish` <- create-v3.html, play.html
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
- `GET /v3/discover` <- assets/seed-data.js, explore-v3.html, games-atlas.html (+1)
- `GET /api/public/worlds` <- player-play.html
- `GET /api/public/stats` <- assets/seed-data.js, studio/pages/atlas.html
- `GET /api/public/events` <- assets/seed-data.js, index.html
- `GET /api/public/market` <- assets/seed-data.js, games-marketplace.html, studio/pages/marketplace.html
- `GET /api/public/atlas/feed` <- assets/seed-data.js, studio/pages/atlas.html
- `GET /api/public/atlas/stats` <- games-atlas.html, index.html, studio/pages/atlas.html
- `POST /v3/worlds/:id/play` <- create-v3.html, history-v3.html, play-v3.html
- `POST /v3/worlds/:id/rate` <- create-v3.html, history-v3.html, play-v3.html
- `GET /v3/worlds/:id/stats` <- create-v3.html, history-v3.html, play-v3.html
- `GET /me/home` <- player-home.html, studio/components/studio.js, studio/pages/ai-studio/world-builder.html (+2)
- `GET /me/profile` <- assets/auth.js, assets/player-chrome.js, profile-v3.html
- `GET /me/achievements` <- player-home.html, profile-v3.html
- `GET /me/streak` <- player-home.html, profile-v3.html
- `GET /me/dashboard` <- history-v3.html, profile-v3.html
- `GET /profiles/:username` <- profile-v3.html
- `GET /verify/status` <- profile-v3.html
- `POST /verify/:channel/start` <- profile-v3.html
- `POST /verify/:channel/confirm` <- profile-v3.html
- `GET /social/friends` <- assets/player-chrome.js, player-home.html, social-v3.html
- `POST /social/friends/accept` <- social-v3.html
- `GET /social/parties` <- social-v3.html
- `GET /social/teams` <- social-v3.html
- `POST /social/studios` <- social-v3.html
- `GET /social/orgs` <- social-v3.html
- `GET /social/orgs/:id` <- social-v3.html
- `POST /social/orgs/:id/members` <- social-v3.html
- `DELETE /social/orgs/:id/members` <- social-v3.html
- `POST /social/orgs/:id/seats` <- social-v3.html
- `GET /social/parties/:id` <- social-v3.html
- `POST /social/parties/:id/join` <- social-v3.html
- `POST /social/parties/:id/leave` <- social-v3.html
- `GET /social/studios/:id` <- social-v3.html
- `POST /social/studios/:id/members` <- social-v3.html
- `POST /social/studios/:id/split` <- social-v3.html
- `GET /social/teams/:id` <- social-v3.html
- `POST /social/teams/:id/members` <- social-v3.html
- `DELETE /social/teams/:id/members` <- social-v3.html
- `GET /v3/marketplace` <- profile-v3.html
- `GET /v3/marketplace/split` <- profile-v3.html, studio/pages/revenue.html
- `POST /v3/marketplace/listings` <- profile-v3.html
- `DELETE /v3/marketplace/listings/:id` <- profile-v3.html
- `POST /v3/marketplace/listings/:id/acquire` <- profile-v3.html
- `GET /v3/marketplace/owned` <- profile-v3.html, studio/pages/marketplace.html
- `GET /v3/marketplace/ledger` <- profile-v3.html, studio/pages/marketplace.html, studio/pages/revenue.html
- `GET /v3/marketplace/assert-dark` <- studio/pages/revenue.html
- `GET /v3/subscriptions/plans` <- profile-v3.html
- `POST /v3/subscriptions/subscribe` <- profile-v3.html
- `GET /v3/subscriptions/grants` <- assets/dcs-truth.js
- `GET /v3/subscriptions/assert-dark` <- profile-v3.html
- `GET /me/subscription` <- profile-v3.html
- `GET /me/entitlements` <- profile-v3.html
- `GET /safety/age` <- safety-v3.html
- `GET /safety/blocks` <- social-v3.html
- `POST /safety/consent/parental` <- safety-v3.html
- `POST /safety/report` <- safety-v3.html
- `GET /safety/reports` <- safety-v3.html, studio/pages/moderation.html
- `POST /safety/block` <- social-v3.html
- `GET /safety/consent/media` <- safety-v3.html
- `GET /safety/moderation-history` <- safety-v3.html, studio/pages/moderation.html
- `POST /safety/reports/:id/moderate` <- safety-v3.html
- `GET /v3/jobs` <- create-v3.html
- `GET /v3/jobs/:id` <- create-v3.html
- `GET /health` <- safety-v3.html
- `GET /atlas/key` <- assets/dcs-truth.js, games-atlas.html, index.html (+1)
- `DELETE /verify/:channel` <- profile-v3.html
- `GET /atlas/receipt/:id` <- assets/dcs-truth.js
- `GET /v3/providers` <- create-v3.html
