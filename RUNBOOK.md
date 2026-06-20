# DCS Games — Backend Deploy Runbook (P0)
**From "8 repos green locally" → P0 live. 19 Jun 2026.**

## What this package is
A **merged Core API** that wires the real lane modules into ONE deployable service. Verified locally over HTTP:
`/health` ✅ · `POST /worlds/generate` (CW2) ✅ · `POST /worlds/:id/save` + `GET /worlds/:id/load` (CW5) ✅ — **house-1 placed → saved → survived reload.**
Persistence is **in-memory** here; §4 swaps it to Supabase for durable reload. Atlas (CW7), auth (CW1), Stripe mount the same way (§5).

## Services to deploy (2 Railway + 1 Supabase)
1. **`dcs-games-backend`** (this Core API) → Railway → `api.games.dcsai.ai` (already exists; update it).
2. **`dcs-games-netcode`** (CW4) → **separate** Railway service (long-running WebSocket).
3. **Supabase (games project)** → Postgres + `dcsgames_*` schema + RLS.

---

## §1 · Run locally (sanity)
```
cd dcs-games-backend-merged
npm i -g tsx        # or rely on npx tsx
PORT=8080 npm start
# smoke:
curl -s localhost:8080/health
GID=$(curl -s -X POST localhost:8080/worlds/generate -H 'Content-Type: application/json' -d '{"prompt":"Pirate Island"}' | python3 -c "import sys,json;print(json.load(sys.stdin)['world_id'])")
curl -s -X POST localhost:8080/worlds/$GID/save -H 'Content-Type: application/json' -d '{"delta":{"session_id":"s1","seq":1,"ts":"2026-06-19T00:00:00Z","ops":[{"op":"place_object","object_id":"house-1","kind":"building.house","transform":{"x":5,"y":0,"z":5}}]}}'
curl -s localhost:8080/worlds/$GID/load   # expect house-1 in objects
```

## §2 · Env vars (Railway → dcs-games-backend)
```
PORT=8080
PAYMENTS_LIVE=0                 # Stripe DARK until flip — keep 0
STRIPE_SECRET_KEY=sk_test_...   # reuse Atlas/Agentic Stripe (test keys)
STRIPE_WEBHOOK_SECRET=whsec_...
SUPABASE_URL=https://<games-project>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=...   # server-side only, never in frontend
```

## §3 · Deploy the Core API
```
# from dcs-games-backend-merged/, with Railway CLI linked to the games project:
railway up                      # builds + deploys; start cmd = `tsx server.mts`
# verify:
curl -s https://api.games.dcsai.ai/health   # -> {"ok":true,"persistence":"in-memory"|"supabase",...}
```

## §4 · Swap persistence in-memory → Supabase (the durability step)
Today CW5 uses `InMemoryPersistenceStore` (data resets on restart). For real "reload tomorrow":
1. **Supabase migration order** (run in the games project SQL editor):
   `dcsgames_001_core.sql` (athletes? no — games: users/worlds) → `dcsgames_002_persistence.sql` (world_deltas, world_snapshots) → RLS policies (athlete/world ownership) → seed.
   *(Use the `_SHARED_Day0` C1/C3 schemas as the column source of truth.)*
2. In `src/cw5/cw5_persistence.ts`, replace `InMemoryPersistenceStore` with a Supabase-backed store (same interface: `appendDelta`, `readDeltas`, `writeSnapshot`, `readSnapshot`). CW5 owns this swap — interface is already factored.
3. Redeploy; `/health` should report `persistence:"supabase"`. Re-run §1 smoke twice across a restart → state survives.

## §5 · Mount the rest (incremental, same pattern)
- **Atlas (CW7):** `import` its route module → mount `/atlas/builder/:id`, `/atlas/world/:id`, `/atlas/key` (ed25519 already live).
- **Auth/Identity (CW1):** mount `/me`, `/publish/check`; wire Supabase Auth (reuse DCS Rank pattern).
- **Stripe:** add the webhook route on this service; keep `PAYMENTS_LIVE=0` — no charges until DK flips.

## §6 · Netcode service (separate)
```
# from CW4 repo (DCS-Games-CW4-Netcode):
npm install && npm run build        # tsc -> dist/
# Railway: new service `dcs-games-netcode`, start cmd:
node dist/server.js                 # WebSocket server
# frontend/runtime (CW3) connects to wss://<netcode-host>/play
```
CW4 acceptance verified locally: **M-P0 27/27, M-P1 29/29 GREEN.**

## §7 · Frontend (Cloudflare Pages, alongside)
CW6 dashboard + CW3 runtime → `games.dcsai.ai`. Point `DCS_API_URL` → `https://api.games.dcsai.ai`, netcode `wss://<netcode-host>/play`.

## §8 · Smoke-check URLs (post-deploy)
- `GET https://api.games.dcsai.ai/health` → ok
- generate→save→load (the §1 curls against the live host) → house survives reload
- `wss://<netcode-host>/play` → 2 clients see each other (CW4 bot)
- `GET https://api.games.dcsai.ai/atlas/key` → ed25519 pubkey

## DO NOT deploy yet (gated)
Redis/BullMQ workers · Cloudflare R2 (video) · Vision CV worker · LLM agents · **Stripe LIVE** (stays DARK). Money DARK; honest data; CWs ship, DK deploys.
