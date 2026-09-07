> # ⚠ SUPERSEDED — 20 June 2026. DO NOT FOLLOW THE COMMANDS IN THIS FILE.
>
> Kept as the historical record. Read for context; do not execute. Reconciled
> 7 September 2026.
>
> - **"Push this folder to `DCSAITechnologies/dcs-games-backend`"** — that repo is
>   **PUBLIC**, and this branch contains working reproductions of defects that are
>   still live and unpatched in production. Pushing it there publishes an exploit
>   kit against a running service. The sprint is banked on the private mirror
>   `dcs-games-backend-sprint-sep2026`. Publishing to the public repo is a founder
>   decision, and the safe order is: deploy the fixes, then publish.
> - **"Railway service start command: `npm start`… Custom domain stays
>   `api.games.dcsai.ai`"** — that is the **production** service. Deploy staging
>   with `scripts/deploy-staging.sh`; production has its own plan,
>   `DCS_GAMES_PRODUCTION_CUTOVER_PLAN.md`, and has deliberately not been touched.
> - **"Persistence is in-memory in `server.mts`"** — no longer true.
>   `createWorldRepository()` mirrors a Supabase store onto a file store; the
>   deployed staging service reports `persistence: "supabase+file"` against a
>   dedicated Supabase project, with the schema chain `0001`…`0011` applied.
> - **"CW8 certify-all: 72 passed / 0 failed"** — superseded. On 7 Sep 2026:
>   `test:unit` 997, `test:unit:tsx` 24, `test:api` 119, `test:load` 5,
>   `test:e2e` 12, all 0 failures; `test:browser` had 1 failing check on a tree
>   another lane was mid-edit on.
> - **The env var list is incomplete and one entry is wrong by omission**:
>   `SUPABASE_ANON_KEY` must be set, because `/auth/signup` and `/auth/login` fall
>   back to the **service-role key** without it. The full list, by name, is in
>   `DCS_GAMES_PRODUCTION_CUTOVER_PLAN.md` §3.
>
> **`PAYMENTS_LIVE=0` and "money DARK" are still true**, and are now enforced by
> database CHECK constraints as well as by the flag — a priced or non-comped row
> cannot be stored at all.

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
