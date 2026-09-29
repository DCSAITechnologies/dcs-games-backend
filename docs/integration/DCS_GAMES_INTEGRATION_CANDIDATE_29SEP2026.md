# DCS Games: integration candidate (29 Sep 2026)

This is one controlled candidate built from the completed lanes. Nothing has been pushed, deployed, or sent to a paid provider. Production is untouched.

## Branches (all local)

| Repo | Branch | Base | Head |
|---|---|---|---|
| backend (`dcs-games-backend`) | `integration/dcs-games-candidate-29sep2026` | Games-D `c1a23e0` | this commit's parent chain (see `git log`) |
| frontend (`dcs-games-frontend`) | `integration/dcs-games-frontend-candidate-29sep2026` | recovery `e64ffe7` | `3c2e092` |
| netcode (`dcs-games-netcode`) | `integration/dcs-games-netcode-hardening-29sep2026` | Games-C netcode `bdd8b74` | `4f51915` |

Worktrees:
- `~/Developer/dcs-games-integration-29sep2026`
- `~/Developer/dcs-games-frontend-integration-29sep2026`
- `~/Developer/dcs-games-netcode-integration-29sep2026`

## What went in

### Phase 1: Games-D as the base

`c1a23e0` is Games-B `29448c1` plus 6 later commits, so Games-B came in through Games-D.

### Phase 2: Games-C

Merged `50cf262`. Its route wiring was DESIGN-ONLY and is now live in `server.mts`.

- **Edit.** `POST /v3/worlds/:id/edit` takes a typed `patch` or a `request`.
  - A patch on a stale base returns 409 `stale_edit`.
  - The author is always the signed-in principal, whatever the patch claims.
  - A request that `planEdit` cannot parse goes to the companion. The companion answers with either a patch or a clarifying question.
  - Patches are recorded in `expansion.history`. Without this, `verifyPreservation` refused every patch and companion edit.
- **Undo.** `POST /v3/worlds/:id/undo`.
  - The undo stack is held on the server.
  - Undo runs through the rollback path, so it gets the ownership refusal and the playtest gate.
  - It returns 409 `undo_history_diverged` once anything else has changed the world.
- **World Memory v2.** It mirrors generate, edit, expand, fork, rollback, quest and save. The repository stays the head; a v2 failure is reported and never fails the write.
  - `GET /v3/worlds/:id/integrity` (owner only).
  - `/worlds/:id/load` returns `resume`: the full version to the owner, and only their own state to anyone else.
- **Publish.** Publish now runs the security guard and a gate-only playtest (no repair on publish), then builds a signed, content-addressed **staging** package.
  - `POST /worlds/:id/staging/rollback` moves the staging pointer back.
  - Package directories are made read-only only with `DCS_STAGING_READONLY=1`. A read-only tree broke every test teardown and could not be pruned.
- **Guards.**
  - `guardManifest` runs on every v3 write.
  - `guardUserPrompt` runs on generate, edit, expand and the companion's `ask`.
  - A per-user daily generation cap applies. It is **PARTIAL**: a flat estimate at request level, and only when an external lane is configured; it does not meter each provider call.
  - The media lane's own placeholder SVG is accepted. Any SVG data URI that carries script, event handlers or external references is still refused.

### Phase 3: netcode (local only)

These changes are on `4f51915`:
- HS256 JWT verifier that fails closed.
- Maximum players per session (default 16).
- Caps on WebSocket frames and HTTP bodies.
- Session cleanup: idle/empty GC, a session cap, and per-player state removed after the reconnect grace period.
- `world_id` checked against the world-store format, with one world per session.
- A bounded, non-blocking persistence client that does nothing without a URL.
- Spawn points in the protocol.

Test totals went from 14 suites / 234 checks to 17 / 411 (0 failures).

### Phase 4: website/dashboard recovery

Backend `40e4312` is merged. The frontend is built on `e64ffe7`.

- **B6** (header overflow): fixed in the frontend at `52be8b7`. Signed in, there is 0 overflow at 25 widths from 320 to 1440 with 19- and 53-character names. The same fix covers the shared marketing header.
- **B4** (reopen a world): fixed in the frontend at `52be8b7`.
  - `create-v3?world=` reopens a saved world.
  - A fresh generation writes `?world=` into the URL.
  - The editor is linked from `play-v3` (owner only), `history-v3` and `profile-v3`.
- **B5** (editing a published world): closed with an explicit policy.
  - Every v3 content change goes through `commitContentChange`. This covers edit, expand, rollback, undo, quest, media and stitch; six of these paths used to keep `state: rec.state`.
  - A change to a published world returns it to **draft** and strips the trust fields.
  - Publishing again re-attests with a new signed package.
  - The Atlas world receipt signs only the world id, never the content, so the content-addressed package is what binds attestation to content.
  - The frontend shows the return to draft and offers "Publish again".
- **Security edge.**
  - Request bodies are capped (`DCS_MAX_BODY_BYTES`, default 10 MiB); anything larger gets a 413.
  - The prompt guard is on.
  - Frontend (`468bc40`, `650368e`, `437dee7`, `3c2e092`):
    - 8 XSS sinks where a payload actually ran are fixed.
    - The upload now checks file signatures, not just the declared type.
    - `history-v3?world=..` no longer reaches `/v3/worlds/../*`.
  - B1 and B2 re-verified.

### Phase 5: Games-A

Merged `32d697e`.
- The engine is built with providers forced offline and a fetch that refuses, unless `DCS_GAMES_ENGINE_EXTERNAL=1` is set. It is **not on the generation path**.
- `GET /v3/engine` is builder-only and reports `LOCAL_ONLY`.
- External routes stay **PROVISIONAL**.

## Tests (final heads, offline, `CEREBRAS_API_KEY` unset)

| Suite | Result |
|---|---|
| unit | 1380 / 1380 |
| unit:tsx | 69 / 69 |
| API | 142 / 142. Includes `integration-candidate` (15) and `integration-restart` (1). |
| load | 6 / 6 |
| Games-B | 190 / 190 |
| Games-B browser | 27 / 27 |
| Games-D | 130 / 130 |
| Games-C | inside unit (7 suites) |
| browser + responsive + security | 200 / 206 in the full run. See the note below. |
| e2e / game-flow | 12 / 12 |
| netcode | exit 0, 0 failures (17 suites) |
| deterministic rebuild | Lanternfall: two rebuilds are identical to each other and to the committed build. All 18 Games-D fallback games rebuild identical and match the committed files; 18/18 won headless. |
| save/reload | a world, its versions, B5 state, v2 ledger, undo stack and staging package all survive a server restart |
| secret scan | backend and frontend both CLEAN |

**Browser note.** The full run had 6 failures, all 60-second timeouts in the `play-v3` a11y and perf tests, while the 5-minute load average was 13 to 18.
- Rerun on the final frontend, `a11y-pages` passed 19/19.
- `runtime-perf` passed 16/16 twice in a row.
- The `play-v3` diff does not touch the frame loop.
- At `52be8b7` the same suite was 164/164.
- These are load-induced, but a clean full run on an idle machine is still owed.

**Paid calls.**
- REAL_API_CALLS = 0.
- A preload that logs any non-loopback socket or fetch recorded 0 attempts across the unit, tsx, API and load suites.
- Browser tests stub the API at `https://stub.api.invalid`.

## Blockers and open items

1. **No backend `/persistence/delta` route.** The netcode client's contract is in the netcode README. Mapping service deltas onto world ownership is a design decision. Multiplayer stays off (`DCS_MULTIPLAYER_ENABLED` is unset).
2. **Netcode push and CI re-pin need founder approval.** CI still pins `ci.yml` to `49f1035`, which predates the speedhack fix.
3. **B7: no staging tester account.** Nothing was verified signed in on staging or through Supabase auth.
4. **Migration `0014_world_memory_v2` is not applied.** In this candidate v2 uses the file adapter under `DCS_DATA_DIR`. On an ephemeral disk it is lost at redeploy. The repository, which is the head, is not affected.
5. **Staging package assets.** Only the manifest is packaged; the asset fetch-and-pin step is DESIGN-ONLY. There is no moderation gate (`moderation.status: not_performed`).
6. **Carried over from the QA sweep, not addressed:**
   - route guards on 1 of 59 pages;
   - token in `localStorage`;
   - SEC-01 moderation log UUIDs;
   - dead controls;
   - slow `/v3/discover`.
