# DCS Games roadmap checkpoint (30 Sep 2026)

Frozen at tag `dcs-games-internal-preview-20260930`. The tag points to the backend integration candidate `357a349`.

## Current state

- Engineering closure is complete for the internal staging preview.
- Internal staging preview: **READY**.
- Production canary: **NOT READY**. See "Production canary, deferred" below.
- Production untouched. Nothing has been deployed from this checkpoint.

### Final heads

| lane | repository | branch | head |
|---|---|---|---|
| Backend (Games-B + Games-C registration + Games-D) | dcs-games-backend | `integration/dcs-games-internal-preview-30sep2026` | `357a349c113a233f6189e1ad99513fa1ad6931a2` |
| Frontend (Games-A) | dcs-games-frontend | `integration/dcs-games-frontend-internal-preview-30sep2026` | `1d7fd7c67f7c6f7e7643eea8134494bc891db5fb` |
| Netcode (Games-C) | dcs-games-netcode | `fix/games-c-netcode-closure` | `498242f45ec49f075862af4ede3463d7635f4449` |
| Games-D local fallback | dcs-games-backend | `games-d/local-fallback-29sep2026` | `e103ad3191708b5af7bc622ad546a88dd095d2a3` |

## Completed

- **Games-A founder UI closure** (`c862363`, integrated as `1d7fd7c`).
  - Shell-smoke full matrix: 7196/7200 cells. The 4 failures were keyboard-scroll timing, and each passed on rerun.
  - Header sweep 1134/1134, discover 7/7, a11y 19/19.
- **Games-B backend, security and migration closure** (`7e967d1`).
  - Migration 0014 is in the chain, and the rehearsal passes on Postgres.
  - Internal publish control and SEC-01 redaction are in place.
  - The hash-chained audit log, `/ready` and the route guards are in place.
- **Games-C multiplayer/netcode closure behind a default-OFF flag** (`498242f`).
  - 20 suites, 532/532 checks.
  - The persistence-delta registration is in the backend exactly once.
- **Games-D local fallback** (`e103ad3`).
  - 18/18 samples playable. GPU average 59.99 fps on M4 Pro Metal.
  - Save/reload and deterministic rebuild both 18/18.
  - Zero provider calls, and provenance reads `local_fallback`.
- **Final B→C→A→D integration.**
  - Backend: unit 1384, tsx 69, api 166, load 6, gamesb 190, gamesd 135, e2e 12.
  - Frontend: browser 205/206 plus 1 flake that passes on rerun, and gamesb browser 27/27.
  - Live boot under the outbound trap: 0 outbound calls, multiplayer routes 404, engine LOCAL_ONLY.
  - A world survives a restart byte-identical.
- **Bundles, SHA256 and fresh-restore proof.**
  - Final and pre-merge full-history bundles are in `~/Developer/dcs-games-final-preview-30sep2026/{final,pre-merge}` with `SHA256SUMS`.
  - Fresh clones are self-contained with a clean fsck, and each tree matches its source.
  - Tests pass inside the restored clones.

## Internal staging, next steps

1. Founder staging GO.
2. Staging `DATABASE_URL`.
3. Apply migration 0014 before deploying. The server exits 78 if the schema is below v14.
4. `DCS_AUTH_SECRET` or Supabase (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`).
5. `DCS_INTERNAL_TESTERS`: tester principal ids.
6. Atlas signing key. Without it, `/ready` is 503.
7. `DCS_PROVIDERS_OFFLINE=1`.
8. A persistent `DCS_DATA_DIR` volume.
9. Multiplayer OFF: leave `DCS_MULTIPLAYER_ENABLED` unset.
10. External engine OFF: leave `DCS_GAMES_ENGINE_EXTERNAL` unset.
11. Deploy the backend `357a349` and the frontend `1d7fd7c`.
12. Staging login token for tests.
13. Run the `acceptance:*` tests (session, journey, header, engines, webkit) against the deployed preview.
14. Founder and staff signed-in QA.
15. Staging rollback evidence: previous deploy id, rollback drill and restore.

## Production canary, deferred

- **Multiplayer save-route identity binding.** `/persistence/delta` trusts the `actor_user_id` sent by the netcode, backed only by the service token. This is the one `verify-release` failure (9/10), and it must be closed before `DCS_MULTIPLAYER_ENABLED=1` anywhere.
- **External-engine activation hardening.** On the server, `DCS_GAMES_ENGINE_EXTERNAL=1` can switch the engine on through the environment, whereas Games-D keeps it hard-off. Also, without `DCS_PROVIDERS_OFFLINE=1`, the CW2 adapter uses `CEREBRAS_API_KEY`.
- **Public moderation.** The classifier, human review and takedown are needed before `DCS_PUBLISH_VISIBILITY=public`.
- **Durable DB-backed World Memory.** The Supabase adapter is design-only. Today, restart survival relies only on the `DCS_DATA_DIR` volume, and CW1 identity falls back to in-memory storage when Supabase is absent.
- **Provenance wording cleanup.** Server-generated worlds list skipped providers under `after_failed` without saying that none was called.
- **Stale 30-Sep internal-window text.** Both "until 30 Sep 2026" and the comped-plan expiry of `2026-09-30` need updating.
- **Flaky-test hardening:**
  - load-smoke discovery ratio under CPU contention
  - netcode server-limits chunked 413
  - ESTATE KEYBOARD skip link
  - shell-smoke End-key timing
- **World-ticket minting.** The netcode has no route for it yet.
- **Duplicate-socket behaviour.** The netcode needs a re-seat for duplicate sockets.
- **Stale capability flags** in the backend multiplayer shim.
- **Synthetic-token scanner allowlist.** The netcode test fixtures are flagged by `secret-scan`.
- **Old uncommitted studio change.** The frontend integration worktree (`studio.js`/`studio.css`) has an uncommitted keyboard-scroll change. Decide whether to keep or drop it.
