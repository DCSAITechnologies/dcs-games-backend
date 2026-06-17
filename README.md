# dcs-games-backend
Platform API for DCS Games (api.games.dcsai.ai). Express + TypeScript + Supabase.

## Deploy
1. Create the dedicated **UGC Supabase project**; run `migrations/0001_init.sql` in its SQL editor.
2. Railway: connect this repo, set env vars:
   - `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
   - `ALLOWED_ORIGINS` (defaults cover games/studio/atlas.dcsai.ai)
3. Point `api.games.dcsai.ai` at the Railway service. Frontend `API_BASE` → that URL.

Until Supabase env is set, every route returns honest empty responses (`note:"db_not_provisioned"`) — it never crashes and never fabricates live user data. Money/marketplace flows are DARK.

## Surfaces
- `/api/public/*` — homepage, explore, worlds, events, creators, stats, atlas feed (no auth)
- `/api/me/*`, `/api/leaderboard`, `/api/market`, `/api/profile/:u` — Player App (auth)
- `/api/studio/*` — Creator Studio (creator role); `/generate` is mock until the AI sandbox is provisioned
- `/api/atlas/*` — trust receipts/verify/reputation
