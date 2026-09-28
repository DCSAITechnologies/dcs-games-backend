# DCS Games — Multiplayer / Netcode Recovery (GAMES-C, Agent 4)

Date: 28 Sep 2026. Author: GAMES-C Agent 4 (netcode recovery).
Repos examined:
- Netcode: `~/Developer/dcs-games-c-netcode`, branch `games-c/netcode-slice-28sep2026`, base `524a7f6` (= `repair/2026-09-netcode` = `bank/repair/2026-09-netcode` = tag `DCS_GAMES_V3_CHECKPOINT_07SEP2026`).
- Backend: `~/Developer/dcs-games-c-systems`, branch `games-c/systems-28sep2026`, base `cd9856d`.

All line references are to the netcode repo at `524a7f6` unless prefixed `backend:`.

## Verdict

**MULTIPLAYER: VERTICAL_SLICE_PROVEN_LOCAL**

Proven: the real deploy entrypoint (`src/server.ts`, which `railway.json`/`Procfile` run as `dist/server.js`) boots on an ephemeral localhost port, two real WebSocket clients join one session, each sees the other's server-authoritative state, speedhack/teleport/forged-dt are rejected over the wire, placements broadcast, rate limits fire, and a dropped client reconnects to its preserved state (`tests/games-c-vertical-slice.test.ts`, 36/36, 5 consecutive green runs).

Not proven, and not claimed: any backend integration (no session issuance, no WS client in the frontend, no identity binding), any deployed service, persistence into the backend, manifest-driven spawn points, max-player caps, real auth. The backend still reports `netcode:"ws-separate-service"` (backend:`server.mts:561`) and the flagship E2E still asserts `multiplayer.enabled === false` (backend:`test/flagship-e2e.test.mjs:382-388`) — both unchanged and correct.

It is not production-safe as is: auth is a mock that accepts `tok:<anything>` (gateway.ts:250-256, wired at server.ts:100), and `POST /sessions` is unauthenticated and creates unbounded, never-closed 15 Hz sessions (server.ts:103-121, session.ts:584-589).

## 1. What exists

| Area | Files | Status |
|---|---|---|
| WS server (zero-dep RFC6455 over `node:http`) | `src/server.ts` (206 lines) | PROVEN (slice) |
| Gateway: auth handshake, join routing, party frames | `src/gateway.ts` | PROVEN (mp0/mp1/party/slice) |
| Authoritative session, 15 Hz tick, delta/AOI | `src/session.ts` | PROVEN |
| Anti-cheat validation + rate limiter | `src/validation.ts` | PROVEN |
| Party (max size 4) / presence | `src/party.ts`, `src/presence.ts` | PROVEN in-memory; NOT wired in `server.ts` |
| Inventory w/ ownership-store seam | `src/inventory.ts` (`MockOwnershipStore`) | PROVEN in-memory; NOT wired in `server.ts` |
| Persistence client (C3/C5 deltas → HTTP) | `src/persistence-client.ts` | PROVEN vs stub fetch; endpoint does not exist on backend |
| Headless bot (in-memory transport) | `bots/headless-bot.ts` | used by in-memory suites |
| Protocol contract C2 | `contracts/netcode-protocol.json` (`version: 0.1.0-pre-day0-reconcile`) | stale in places (see §3) |
| Standalone JS mock server | `mock-server.mjs` == `netcode-mock-server.mjs` (byte-identical) | used by mp2 + smoke suites |
| Deploy config | `railway.json`, `Procfile`, `.github/workflows/ci.yml` | never deployed by this lane |

Note: before this work, **no suite booted `src/server.ts`**. `mp2-conformance` and `mock-server-smoke` boot `netcode-mock-server.mjs` (tests/mp2-conformance.test.ts:101-102), a separate wrapper. The new slice is the first test of the actual deploy entrypoint.

## 2. What passes (exact counts, Node v25.8.2, macOS arm64, offline)

Baseline at `524a7f6` (before any change): `npm test` exit 0 — **13 suites / 197 checks / 0 failed**
(mp0 27 · mp1 29 · mp2 19 · inventory 14 · party 23 · reconnect 16 · delta 10 · lagcomp 13 · aoi 8 · persistence 13 · movement 7 · smoke 7 · speedhack 11).

After this work: `npm test` exit 0 — **14 suites / 233 checks / 0 failed** (+ `test:gamesc-slice` 36).
`npx tsc --noEmit` exit 0; `tsc --outDir <scratch>` build exit 0 (9 modules after dupe removal; 11 before — the dupes compiled into `dist/` as `session 2.js`, `validation 2.js`).

Backend shim: `node --test test/gamesc-multiplayer*.test.mjs` — **18 tests / 18 pass / 0 fail / 0 skipped** (the cross-repo drift test auto-skips when the netcode checkout is absent, e.g. CI).

## 3. Protocol

Transport: WebSocket text frames, JSON, path `/play` (server.ts:153-154). HTTP: `POST /sessions {world_id}` → `{session_id, world_id}` (server.ts:103-122); `POST /sessions/:id/invite` → `{invite_code}` (server.ts:125-137); `GET /health` → `{ok, active_sessions, persistence:{mode, deltas_emitted}}` (server.ts:139-146).

Inbound (types.ts:18-104): `join{token, world_id, session_id?}`, `input{seq, move, look, dt}`, `interact{target_entity_id, action}`, `place{object_type, position, rotation}`, `inventory{action, item_id, slot?}`, `chat{channel, text}`, `ping{t}`, `party_create|party_join|party_launch|party_leave` (each carries its own `token`).
Outbound (types.ts:106-218): `joined{session_id, your_entity_id, snapshot}`, `state_delta{tick, keyframe, changed[], removed[]}`, `state` (legacy, no longer emitted), `spawn`, `despawn`, `object{op: place|remove|mutate}`, `inventory`, `chat`, `error{code: auth|invalid|rate_limit|not_found|forbidden, message, ref_seq?}`, `pong{t, server_t}`, `party_state`.

Versioning: a single string in the contract file (`0.1.0-pre-day0-reconcile`). **There is no version on the wire** — `join` carries no protocol version, the server never advertises one. The contract JSON is stale: it lists `state` as the tick broadcast and omits `state_delta` and all `party_*` frames (README "Protocol note" acknowledges this).

## 4. Server / client model

One Node process holds a `SessionManager` (session.ts:574-606) mapping `session_id → Session`. Each `Session` is one world instance with its own `setInterval` tick (session.ts:107-110). The `Gateway` binds each transport to `{session, entity_id, user_id}` after a successful `join` (gateway.ts:37, 129). A `join` without `session_id` **creates a new session** (gateway.ts:110-112); with one, it must exist (gateway.ts:104-109). There is no client in this repo besides the test bot; no browser client exists in the backend or frontend.

Entity id is deterministic: `e_` + first 12 hex of `sha256(user_id:session_id)` (gateway.ts:115-119) — this is what makes reconnect resume work.

## 5. Sync model

- Tick rate 15 Hz (session.ts:32-33; contract `tick_hz: 15`).
- Snapshot: full `WorldSnapshot{world_id, session_id, tick, players[], objects[]}` in the `joined` frame (session.ts:559-567).
- Delta compression: per tick, only players whose serialized state (3-decimal rounding) changed are sent in `changed[]`; departures in `removed[]`; idle ticks send nothing (session.ts:37-46, 481-499).
- Keyframes: every 30 ticks (2 s) a `keyframe:true` delta with all players (session.ts:96, 470). Slice check "keyframe state_delta arrives" PROVEN.
- Objects are not in the tick stream; they are event-broadcast (`object` frames, session.ts:347-354, 411).

## 6. Authority — what the server validates

Server-authoritative; clients send intents (contract `principles`). Validated server-side:
- Movement (validation.ts:85-160): finite move vector; client `dt` must be a number ≥ 0.001 but is **not trusted for the budget** — budget is `8.0 u/s × server-elapsed-since-last-accepted-input`, clamped to [0.001, 0.25] s (validation.ts:72-79, session.ts:290-316). Overreach ≤1.5× is clamped; >1.5× is rejected and snapped back (validation.ts:125-146). World bounds ±500 per axis. Only accepted inputs advance the budget (session.ts:314-316).
- Input sequencing: `seq` must be finite; `seq ≤ last` silently dropped (replay/reorder guard) (session.ts:280-288).
- Placement: finite, in bounds, within 20 u of actor, non-empty `object_type` (validation.ts:166-184).
- Interact: rate limit, target exists, within 6 u reach, ownership (session.ts:373-422) — bug B1 **FIXED on games-c netcode branch @ bdd8b74**.
- Chat: 1..500 chars, rate limit (session.ts:448-464).
- Not validated: `look` values, `rotation`, `object_type` length/allowlist, `y` axis physics (no gravity/ground; fly is allowed up to speed), `world_id` in `join` vs the session's world.

## 7. Latency handling

- Client-side prediction + reconciliation support: server acks `last_ack_seq` per player in `state_delta` (types.ts:108-118, session.ts:312-317); rejected inputs are also acked with an `error{ref_seq}` so the client reconciles to the snap-back (session.ts:292-299). PROVEN (slice: "state_delta carries last_ack_seq").
- "Lag compensation" in this repo means input sequencing + ack only (tests/lag-comp.test.ts). **There is no server-side rewind / hit-validation history** — there is no combat.
- Interpolation: client-side by design; no client exists. DESIGN-ONLY.
- Ping/pong app-level clock echo (session.ts:262-264). WS-level ping (opcode 9) is decoded but never answered with a pong (server.ts:80).

## 8. Disconnect / reconnect

`handleDisconnect` → `session.leave(entity_id)` soft by default (gateway.ts:235-242). Soft leave broadcasts `despawn`, keeps the `PlayerState` for `RECONNECT_GRACE_MS = 30 s` (session.ts:81, 192-219), and keeps `lastInputSeq` so replay protection survives. Rejoin with the same user + session_id → same entity id → exact state restored and `spawn` broadcast at the preserved position (session.ts:143-160). After grace expiry → fresh spawn at origin. PROVEN over real sockets (slice: 6 checks) and in-memory (reconnect 16/16). Hard quit (`leave(..., {hard:true})`) exists but no wire frame triggers it.

## 9. State replication

Players: tick deltas (above). Objects: event frames + included in join snapshot. Inventory: point-to-point `inventory` frame to the actor only. Chat: broadcast to whole session regardless of `channel`.

## 10. AOI (interest management)

`Session.AOI_RADIUS` static, default `Infinity` = global broadcast (session.ts:91, 473-477). Finite radius → per-recipient deltas; subjects leaving range go to that recipient's `removed[]` (session.ts:502-539). PROVEN in-memory (aoi 8/8). Not configurable per world or via env in `server.ts`. Objects/chat/spawn are never AOI-culled.

## 11. Persistence client — what backend endpoint it expects

`deltaSinkFromEnv` (persistence-client.ts:132-144): if `CW5_PERSISTENCE_URL` is set, `HttpDeltaSink` POSTs each `C3Delta{op, session_id, world_id, actor_entity_id, tick, payload, ts}` as JSON to `${CW5_PERSISTENCE_URL}${CW5_INGEST_PATH || '/persistence/delta'}` with optional `Authorization: Bearer ${CW5_PERSISTENCE_TOKEN}`; per-session FIFO; 3 retries w/ backoff on 5xx/429/network; 4xx is permanent, logged, dropped (persistence-client.ts:80-112). Otherwise a local in-memory sink.

**Mismatch with the backend:** backend has no `/persistence/delta` route (grep of `server.mts`: none). The nearest route is `POST /worlds/:id/save` (backend:`server.mts:2230`), which requires a user principal who **owns** the world and a delta acting on the caller's own behalf (backend:`server.mts:2324-2345`). A netcode service token and `actor_entity_id = e_<hash>` satisfy neither. Setting `CW5_PERSISTENCE_URL` today would produce 404s → every delta dropped. BLOCKED on a backend service-ingest route.

## 12. Anti-cheat

- Speedhack/teleport: PROVEN. `b5aa816` moved the budget from client `dt` to server wall clock (validation.ts:56-79). Slice proves: 50 u teleport rejected with `ref_seq`; forged `dt=0.25` right after an accepted input rejected; a sustained ~100 u/s burst leaves the peer-visible position under the honest ceiling.
- **Differential proof against the CI pin:** the same slice run against a `git archive 49f1035` extract (scratch dir, node_modules symlinked) gives **33/36 — 3 FAIL**: forged dt accepted, sustained speedhack reached x=22.5 in ~0.5 s with **0 rejections**. The 7.5× speedhack is open at the backend's pinned SHA.
- Rate limits: token buckets per `(entity, action)`: input 30/s, place 10/s, interact 10/s, chat 3/s (validation.ts:17-30, 188-215). PROVEN over wire for chat and input.
- Rejected mutations emit no persistence delta (mp0 checks).

## 13. Auth — how session tokens tie to backend identity

They don't. `server.ts:100` wires `mockTokenVerifier`, which accepts any string `tok:<non-empty>` and uses the suffix as `user_id` (gateway.ts:250-256). Consequences: anyone can join as anyone; a second connection as `tok:alice` while Alice is connected re-runs a fresh `join` for the same entity id and overwrites her state/conn (session.ts:162-172) — takeover. `POST /sessions` and `/invite` have no auth at all; invite codes are generated but **never checked on join** (`validateInvite` session.ts:236 has no caller). The `TokenVerifier` seam (gateway.ts:22) is synchronous, so a real verifier must be a local signature check (e.g. HMAC/JWT verified with a shared key), not a network call. DESIGN-ONLY.

## 14. Abuse controls (task 3)

| Control | State | Evidence |
|---|---|---|
| Per-message rate limits (input/place/interact/chat) | PROVEN | validation.ts:17-30; slice "chat flood", "input flood" |
| Rate limit on `join`, `party_*`, `ping`, HTTP routes | ABSENT | gateway.ts:60-86; session.ts:262 |
| Auth required to act | PARTIAL — a join is required (slice "frame before join → forbidden"), but the token is a mock | gateway.ts:74-79, 250-256 |
| Payload size cap (WS) | ABSENT — frame length up to 2^64 accepted and fully buffered; slice sent 256 KiB, parsed | server.ts:50-83 |
| Payload size cap (HTTP `POST /sessions`) | ABSENT | server.ts:104-105 |
| Chat length cap | PROVEN (500) | session.ts:453; slice |
| `object_type` length cap | ABSENT (broadcast + persisted verbatim) | validation.ts:180 |
| Session cap / session GC | ABSENT — each `POST /sessions` or session-less `join` starts a 15 Hz interval that is never stopped (`closeSession` has no caller in server.ts) | session.ts:584-601, gateway.ts:110-112 |
| Max players per session | ABSENT | session.ts:140-186 |
| Party size cap | PROVEN (4) in-memory; unreachable via server.ts | party.ts:26, 60 |
| World-id binding on join | ABSENT — slice observed join with a different `world_id` accepted | gateway.ts:104-109 |
| Rate-limiter memory pruning | ABSENT (buckets never deleted) | validation.ts:188-215 |
| Origin check on WS upgrade | ABSENT | server.ts:153-163 |

## 15. Bugs found (not fixed here — netcode `src/` is outside the slice's remit; proposed fixes below)

- **B1 — interact ownership check is dead for placed objects.** session.ts:403 reads `owner_entity_id ?? owner_id`; `WorldObject` stores `owner` (types.ts:221-228; set at session.ts:341). Slice observed Bob picking up Alice's house. **FIXED by the lead on `games-c/netcode-slice-28sep2026` @ `bdd8b74`:** `const owner = target.owner ?? null;`, now asserted in the vertical slice ("bob cannot pick up alice's house (ownership enforced)"; slice 37/37, netcode `npm test` 14 suites / 234 checks / 0 fail). The `b5aa816` commit message claims "harden interact"; the reach and rate-limit parts work, the ownership part does not.
- **B2 — CI pin tests the vulnerable code.** backend:`.github/workflows/ci.yml:184` pins `49f103531b67`, whose comment claims "its suite is green … including the speedhack regression". At 49f1035 there is **no** speedhack suite (12 suites / 186 checks; `test:speedhack` added in `b5aa816`) and the speedhack is open (proved above). The job step named "Speedhack regression must stay closed" therefore guards nothing.
- **B3 — deployed entrypoint lacks party/presence/inventory.** server.ts:99-100 constructs `SessionManager(c3Sink)` and `Gateway(sm, mockTokenVerifier)` without ownership/presence/party; slice observed `"party service not available"` and `"inventory not available"`. The mp1/party/inventory suites pass only because they wire these in-memory.
- **B4 — unbounded session creation** (see §14) — trivial DoS.
- **B5 — no spawn points.** session.ts:163 hard-codes `{0,0,0}`; the protocol carries no spawn info. A manifest's `spawn.player_spawns` (backend default `{x:0,y:1,z:0}`) cannot be honoured.

## 16. Pin question: 49f1035 vs 524a7f6 (local git only)

- `git branch -a --contains 49f1035` → `main`, `remotes/origin/main`, `repair/2026-09-netcode`, `bank/repair/2026-09-netcode`, this slice branch. `origin/main` HEAD = `49f103531b67…`.
- `git branch -a --contains 524a7f6` → only `repair/2026-09-netcode`, `remotes/bank/repair/2026-09-netcode`, this slice branch (+ tag `DCS_GAMES_V3_CHECKPOINT_07SEP2026`, annotated, peels to 524a7f6).
- Remotes: `origin` = `DCSAITechnologies/dcs-games-netcode`; `bank` = `DCSAITechnologies/dcs-games-netcode-sprint-sep2026`.
- So the earlier report is consistent with local evidence: 524a7f6 is **not on `origin`** (the repo CI checks out); it exists only on the `bank` sprint repo. (Remote state not re-queried — no network by contract.)
- `git diff --stat 49f1035 524a7f6`: 10 files, +1253/−18 — ci.yml (+43), .gitignore, package.json (+speedhack suite), session.ts (+38/−), validation.ts (+57/−), aoi.test.ts, speedhack-regression.test.ts (+141), and the three iCloud dupes (+962).
- **It matters:** the diff is precisely the speedhack fix + its regression suite. CI at the pin passes while the exploit is live.

## 17. iCloud duplicates

`src/session 2.ts`, `src/validation 2.ts`, `tests/speedhack-regression.test 2.ts` — each **byte-identical** to its original (`diff` empty), added in `b5aa816`, referenced by nothing (grep across repo excl. node_modules: 0 hits). Because `tsconfig.json` includes `src/**/*.ts`, the two `src/` dupes were compiled into `dist/`. **Deleted in the netcode worktree** (unstaged deletions; lead to `git rm`). Suite and `tsc` green after deletion.

## 18. Changes made

Netcode worktree (`~/Developer/dcs-games-c-netcode`, uncommitted):
- NEW `tests/games-c-vertical-slice.test.ts` — boots `src/server.ts` via `node_modules/.bin/tsx` on a free port with `CW5_PERSISTENCE_*` stripped; two Node global `WebSocket` clients; 36 checks + 6 observed-gap NOTE lines (notes are printed, not asserted, so fixing a gap never breaks the suite). Needs Node ≥ 22 (global WebSocket); CI uses Node 22.
- `package.json` — `test:gamesc-slice` script, appended to `test`.
- DELETED the three iCloud dupes.

Backend worktree (`~/Developer/dcs-games-c-systems`, uncommitted):
- NEW `src/v3/gamesc/multiplayer/index.mjs` — pure shim: `NETCODE_PROTOCOL` (frozen facts incl. capability flags `supports_spawn_points:false`, `enforces_max_players:false`, `real_auth:false`), `sessionConfigFromManifest(manifest)` (validates via `validateManifest`, hashes via `publish/canonical.mjs#hashManifest`, returns world_id/version/hash/max_players/spawn points + honest warnings; rejects non-server authority and spawns outside ±500), `multiplayerGate(env)` (default OFF; needs `DCS_MULTIPLAYER_ENABLED` truthy AND `DCS_NETCODE_URL` ws/wss; plaintext ws only for localhost; no credentials in URL), `worldMultiplayerStatus(manifest, env)`, `buildJoinFrame(...)`.
- NEW `test/gamesc-multiplayer.test.mjs` — 18 tests.
- Nothing wires the shim into `server.mts`; `/health` and the manifest are unchanged.

**Lead action required:** add `test/gamesc-multiplayer.test.mjs` to `test:unit` in backend `package.json` — `test/ci-coverage.test.mjs` ("every test file is referenced by an npm script") fails until then.

## 19. Integration plan (ordered; each step gated by the previous)

1. **Netcode hardening PR** (netcode repo, small): ~~B1 ownership fix~~ (done @ bdd8b74); WS max frame size (e.g. 64 KiB → close 1009) and HTTP body cap; `object_type` ≤ 64 chars; per-session `max_players` (reject `join` with `error{code:'forbidden'}`); global session cap + idle-session GC (close when 0 players and 0 held reconnects for N s); require `world_id` match on join; rate-limit `join`/`party_*`/`ping`; add `protocol_version` to `joined`. Each with a slice/unit check.
2. **Real auth.** Backend mints a short-lived **session ticket**: `POST /v3/worlds/:id/multiplayer/session` (authenticated user; world must pass `worldMultiplayerStatus`) → netcode `POST /sessions` (service-authenticated) → returns `{play_url, session_id, ticket}` where `ticket = HMAC-SHA256(DCS_NETCODE_TICKET_KEY, {sub:user_id, world_id, session_id, manifest_hash, exp≤60s})`. Netcode replaces `mockTokenVerifier` with a synchronous HMAC verifier (fits the existing sync `TokenVerifier` seam, gateway.ts:22) and binds `user_id`/`session_id`/`world_id` from the ticket, not the frame. `POST /sessions` requires a service bearer. Kill `tok:` in any non-test build.
3. **Session config from manifest.** Extend `POST /sessions` to accept the `sessionConfigFromManifest` output (max_players, spawn_points, manifest_hash); server picks a spawn point per join (B5). Flip `NETCODE_PROTOCOL.supports_spawn_points`/`enforces_max_players` only when the server does it — the shim's drift test will fail until both sides agree.
4. **Persistence.** Add a backend service-ingest route (e.g. `POST /internal/netcode/delta`, service token, idempotency key `session_id:tick:op:entity`) that maps `actor_entity_id` → user via the ticket's `sub`, and routes through `PersistenceEngine` ownership rules; point `CW5_INGEST_PATH` at it. Until then leave `CW5_PERSISTENCE_URL` unset (local sink).
5. **Frontend client.** Browser `WebSocket` to `play_url`; send `buildJoinFrame` with the ticket; apply `joined.snapshot`, `state_delta` (changed/removed, keyframe = full resync), predict locally and reconcile on `last_ack_seq`; interpolate remotes ~100 ms behind; handle `error{ref_seq}` snap-backs; reconnect with the same ticket-refresh within 30 s.
6. **CI pin.** Push `524a7f6` (or the hardened successor) to `origin` (`DCSAITechnologies/dcs-games-netcode`), then update backend `.github/workflows/ci.yml:184` `ref:` to the new full SHA and fix the comment (the current one misstates what 49f1035 contains). `scripts/verify-ci-pins.mjs` will then confirm the ref exists. Until the push happens, updating the pin would make the job DEAD again.
7. **Deploy topology.** Netcode stays a separate stateful service (Railway per `railway.json`, single instance — sessions are in-process memory, no sharding/sticky routing exists). Backend on its current host issues tickets; frontend dials `wss://<netcode-host>/play`. Env: netcode `PORT`, `DCS_NETCODE_TICKET_KEY`, `NETCODE_SERVICE_TOKEN`, `CW5_PERSISTENCE_URL` (after step 4); backend `DCS_NETCODE_URL`, `DCS_MULTIPLAYER_ENABLED=1` (staging only first), same ticket key/service token. Only then may `/health` report something other than `ws-separate-service` and the flagship E2E #19 be revised — with a staging E2E proving two browsers, which would be the bar for `INTEGRATED_STAGING`.

## 20. Capability labels

| Capability | Label |
|---|---|
| Two clients, one session, authoritative movement replicated (real server, real sockets) | PROVEN (local) |
| Speedhack/teleport/forged-dt rejection | PROVEN at 524a7f6; OPEN at CI pin 49f1035 |
| Delta compression + keyframes | PROVEN |
| Reconnect/resume within 30 s | PROVEN |
| Per-action rate limits | PROVEN |
| AOI culling | PROVEN in-memory; off in server |
| Party / presence / inventory | PROVEN in-memory; NOT wired in deployable server |
| Manifest spawn points | BLOCKED (server/protocol lacks it) |
| Max players / session caps / payload caps | ABSENT |
| Real auth / backend identity binding | DESIGN-ONLY |
| Persistence into backend | BLOCKED (no ingest route; shape/auth mismatch) |
| Frontend client | ABSENT |
| Backend integration shim (config + default-off gate) | PROVEN (unit) — not wired |
| Deployed service | NOT VERIFIED (no deploy by contract) |
