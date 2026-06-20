# DCS Games — Integrated Backend · Deploy Runbook
Integrated by CW Manager. Lanes mounted in ONE node:http server (`server.mts`):
CW1 identity · CW2 generation · CW5 persistence · CW7 atlas. CW4 netcode = separate WS service.

## Proven locally (this build)
- `/health` → lanes: cw1,cw2,cw5,cw7
- CW1 `/me`, `/publish/check` (studio→unlimited) — **the M-P3 unblock**
- CW2 `/worlds/generate`
- CW5 save(delta ops[])→load: placed object **survives reload** (M-P0)
- CW7 `/atlas/builder/:id` (honest zeros for unknown ids)
- CW8 certify-all: 72 passed / 0 failed

## Run
```
npm install            # installs tsx
npm start              # tsx server.mts  (PORT=8080)
```

## Deploy to Railway (the live games backend service)
1. Push this folder to the games backend repo (DCSAITechnologies/dcs-games-backend).
2. Railway service start command: `npm start`  (runs `tsx server.mts`).
3. Env vars (Variables tab): `PORT=8080`, `PAYMENTS_LIVE=0`, and when wiring durable persistence:
   `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (service-role = server-side only, never in chat/repo).
4. Custom domain stays `api.games.dcsai.ai`.

## Save delta shape (for CW3/CW6 + tests)
POST /worlds/:id/save  body: `{ "seq": 1, "ops": [ { "op":"place_object","object_id":"torch1","kind":"torch","transform":{"x":1,"y":0,"z":2} } ] }`

## Persistence note
Persistence is in-memory in `server.mts` (CW5 InMemoryPersistenceStore). For durable reload-after-restart,
swap to the Supabase store (CW5 `cw5_supabase_store.ts`) and set the SUPABASE_* envs. The live deploy already
runs Supabase via the prior merge; keep that wiring.

## Money DARK
PAYMENTS_LIVE=0. No capture. Flip is DK-only.
