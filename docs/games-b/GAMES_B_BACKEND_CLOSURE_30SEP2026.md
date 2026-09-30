# Games-B backend closure: internal staging preview (30 Sep 2026)

- **Branch:** `fix/games-b-backend-closure`
- **Base:** `acb8270`, the integration candidate's final staging-preview gate.
- **Owner:** Games-B, the final data/backend owner. This lane exclusively owns `server.mts`.
- **Scope:** the INTERNAL STAGING PREVIEW bar. The public moderation system (classifier, human review, takedown) is the production-canary bar and is **not** built here.

## Verdicts

| Item | Verdict | Where |
|---|---|---|
| Migration 0014 | Rehearsed locally on a staging-equivalent cluster: forward, idempotent, restart. **Not applied to real staging.** | `migrations/0014_world_memory_v2.sql`, `test/migration-0014-rehearsal.test.mjs` |
| World Memory state | Survives a restart on the file adapter under `DCS_DATA_DIR`. The Postgres-backed adapter is still design-only (see below). | `test/integration-restart.test.mjs`, `test/games-b-backend-closure.test.mjs` |
| Route guards (backend) | Every route `/health` advertises, called anonymously, is refused or on an explicit public list. No public answer names an internally published world. | `games-b-backend-closure` "route guards" |
| Token security (backend-owned) | Closed: every response is `no-store`/`nosniff`/`no-referrer`; a credential in a URL gets a 400; the login proxy no longer echoes upstream errors. | "token" test |
| SEC-01 | Closed. The public moderation log carries no moderator id, report id or rationale. | "SEC-01" test |
| Internal publish control | Built. Visibility is internal by default; publishing needs a tester on the allowlist; the prompt guard is always on; a hash-chained, append-only log records prompts, output hashes and publish actions. | "publish control" and "audit" tests |
| B5 | Kept. Editing a published world returns it to draft; republishing re-attests with a new package. | "B5" test |
| Publish package integrity | The package is verified from disk after writing, against the trusted Atlas key only. `GET /worlds/:id/staging/verify` re-checks it on demand, and tampering is detected. | "integrity" tests |
| Save/restart/reload | Passes. | restart tests |
| Health/readiness | `/ready` added. It returns 200, or 503 naming each failing check. `/health` gains `publish_control`. | "readiness" tests |

## 1. Migration 0014 (World Memory v2)

This is the Games-C proposal, promoted into the chain with two changes:
- the `rolled_back` fix to `dcsgames_world_events.kind` is applied rather than left commented out;
- an access block is added: RLS on, `service_role` DML, and nothing for `anon`/`authenticated`, matching 0010.

`REQUIRED_SCHEMA_VERSION` is now **14**.

**Deploy order.** Apply 0014 *before* deploying this build to any instance that sets `DATABASE_URL`. Against v13 the build exits 78 at boot, and that behaviour is tested.

**What the rehearsal does.** It runs on a dedicated throwaway Postgres cluster with the Supabase roles present:
1. Apply the chain to v13, as staging has it, and write realistic rows: a published world with 3 versions, a draft, and a chronicle that includes the legacy `rollback` kind.
2. **Forward.** 0014 applies. Every pre-existing row is byte-identical (md5 over the original columns). The new columns are NULL or their constant default. The 8 new tables are empty, have RLS on, and give `anon`/`authenticated` nothing.
3. **Behaviour.** Rows are insert-only (UPDATE and DELETE raise). The parent, kind and version-hash constraints hold. `rolled_back` is accepted and an unknown kind is refused.
4. **Idempotent.** `migrate()` re-run applies 0. The raw file re-applied outside the ledger is harmless.
5. **Restart.** Postgres is really stopped and started, and the schema and rows survive. The API boots against it, `/health` reports `schema_assertion` v14 ok, and `/ready` is 200.
6. **Forward-only.** The same build refuses a v13 database with exit 78.

**Not done: applying 0014 to real staging.** That needs the staging database credential and a founder GO. This lane has neither and did not look for them.

**One behavioural change to review.** The insert-only trigger means a data-subject purge of `dcsgames_world_versions` must disable `dcsgames_world_versions_no_update` for its own session. This is documented in the migration header and in `migrations/README.md`.

## 2. World Memory state

- The file adapter lives under `DCS_DATA_DIR/world-memory-v2`. The ledger, undo stack, resume state, staging packages and the audit log all survive a SIGKILL restart.
- **Staging requirement.** `DCS_DATA_DIR` must point at a persistent volume. `/ready` reports `data_dir_declared` as an advisory when it is unset.
- **Not done: the Postgres/Supabase adapter** (`SupabaseMemoryAdapter` against the 0014 tables). Restart survival is the preview bar. Surviving a *redeploy* without a volume needs that adapter.

## 3. Internal publish control

| Control | Implementation |
|---|---|
| Internal visibility only | `DCS_PUBLISH_VISIBILITY` defaults to `internal`, and anything other than the literal `public` is treated as internal. A published world is visible only to its owner and to internal testers. Everyone else gets the same 404 a nonexistent world gets, including on the `requireOwner` path. Every public listing (`/v3/discover`, `/api/public/{worlds,stats,events,atlas/feed}`) is empty for them. The public-read cache is keyed on visibility, so a tester's catalogue is never served to an anonymous caller. |
| Tester allowlist | Publishing needs `DCS_INTERNAL_TESTERS` (principal ids preferred, or `app_metadata.roles`). An empty allowlist fails `/ready`. |
| Prompt guard ON | The guard has no setting. At boot it is run against a credential-shaped prompt, and a guard that lets it through fails `/ready`. The v2 `POST /worlds/generate` path and a caller-supplied media prompt are now guarded too; they were the unguarded prompt paths. |
| Append-only log | `src/core/audit-log.mjs` writes JSONL under `DCS_DATA_DIR/audit`, mode 0600, append-only with fsync. Each line carries `prev_hash` and `hash`, and a sidecar head file catches truncation. The log records:<br>• **prompt**: every prompt, *before* it is acted on, and the action is refused if the entry cannot be written. A refused prompt keeps only its hash.<br>• **output**: the stored `content_hash`/`manifest_hash` for each generate, edit, expand, media, quest, stitch, rollback, undo and fork.<br>• **publish**: publish, `publish_refused` (with reason), `staging_rollback` and `returned_to_draft`.<br>A broken chain fails `/ready`. It is readable only by testers whose **principal id** is in `DCS_AUDIT_READERS`, via `GET /v3/audit` and `GET /v3/audit/verify`. |

## 4. SEC-01, token storage, route guards

- **SEC-01.** `GET /safety/moderation-history` answers anonymous callers with only `{action, subject_type, decided_at, decided_by: "human_moderator"}`. A user subject's id is never shown, and a world subject's id is shown only when visibility is public. Staff (testers) keep the full rows.
- **Token storage.** Moving the token from `localStorage` to an HttpOnly cookie is a **frontend** change (A2-26, LOW), and adding cookie auth would need a CSRF design; neither is done here. The backend-owned parts are closed:
  - `Cache-Control: no-store` on every answer, including the one carrying the tokens from `/auth/login`;
  - `nosniff` and `no-referrer` headers;
  - `access_token`, `token`, `refresh_token`, `id_token`, `jwt`, `apikey` and `api_key` in a query string get a 400 without being read or echoed;
  - only the `Authorization` header is ever read;
  - the login proxy no longer returns upstream exception text.
- **Route guards.** The 58 unguarded frontend pages render sample data only (A2-22 is a frontend item). The backend is the real guard. The new matrix calls every advertised route anonymously and fails on anything that is neither refused nor on the explicit public list. The existing `route-authz` suite (Q1–Q5) still passes in public mode.

## 5. Tests

Run offline with `DCS_PROVIDERS_OFFLINE=1` and `CEREBRAS_API_KEY*` unset.

| Suite | Result |
|---|---|
| `test:unit` | 1384 / 1384 (was 1380; `audit-log` adds 4) |
| `test:unit:tsx` | 69 / 69 |
| `test:api` | **161 / 161** (was 142; `games-b-backend-closure` adds 13 and `migration-0014-rehearsal` adds 6) |
| `test:load` | 6 / 6 on three consecutive runs. See the timing note below. |
| `test:gamesb` | 190 / 190 |
| `test:gamesd` | 130 / 130 |
| `test:e2e` (game flow, frontend `git archive 3c2e092`) | 12 / 12 |
| `test:browser` (206) and `test:gamesb:browser` (27) | **not re-run.** The first stubs the API at `stub.api.invalid`; this branch does not touch the second's runtime. |

**Host notes.** The host load average reached 123, and the data volume had run out of space (ENOSPC). Leftover test temp directories older than one day were cleared, with approval.
- One run of the load suite missed its discovery timing ratio. Pristine `acb8270` missed the same assertion on the same host, then passed on the next run.
- The `acb8270` baseline `test:unit` showed 11 `cw1-identity` failures under parallel load. That suite passes 31/31 when run alone.

New suites:
- `test/games-b-backend-closure.test.mjs` (13 tests);
- `test/migration-0014-rehearsal.test.mjs` (6 tests);
- `test/audit-log.test.mjs` (4 tests).

Seven existing suites pin the **public** visibility semantics (production-canary mode), so they now set `DCS_PUBLISH_VISIBILITY=public` explicitly. They had assumed the old always-public behaviour. No assertion in them was changed.

## 6. Staging environment for the preview

| Variable | Value |
|---|---|
| `DCS_DATA_DIR` | a persistent volume path |
| `DCS_INTERNAL_TESTERS` | tester principal ids |
| `DCS_AUDIT_READERS` | principal ids of the reviewers who may read the log |
| `ATLAS_PRIVATE_KEY` | set, or publishing is refused |
| `DCS_PUBLISH_VISIBILITY` | **unset** |
| `DATABASE_URL` | if set, apply 0014 first |

Gate the traffic on `GET /ready`.

## 7. Games-C registration: persistence-delta (follow-up, 30 Sep 2026)

Games-C `498242f` sent `backend/persistence-delta/REGISTRATION.patch`. Games-B applied it; Games-C did not edit `server.mts`.

- **Applied** with `git apply -C1`. Strict `git apply` failed only because the import hunk's context now includes the audit-log import this branch added. All 3 hunks landed without conflict, and the delta handler sits before `whoOrNull`, after `/ready`. The module file at `src/v3/gamesc/persistence-delta/index.mjs` is byte-identical to Games-C's `index.mjs`.
- **One adaptation.** The patch's `accessWorld` used raw `repo.get`, which treats every published world as readable. Under the internal publish control, that would let any user id write deltas into an internally published world. `accessWorld` now goes through `getWorldFor`:
  - a published world takes deltas only from its owner or an internal tester;
  - the netcode sends only a user id, so tester status comes from the **id** allowlist in `DCS_INTERNAL_TESTERS` (fail closed);
  - drafts stay owner-only.

  With `DCS_PUBLISH_VISIBILITY=public`, the Games-C contract applies as written.
- **Flag default OFF.** `DCS_MULTIPLAYER_ENABLED` unset means both routes return 404 and nothing is written.
- **Capability declarations.**
  - `/health.multiplayer` reports the flag, whether the routes are registered and why not, the store, and the routes.
  - `/health.routes.multiplayer` appears only when the routes really exist.
  - `/ready` fails `multiplayer_persistence_delta` when the flag is on but the routes could not register (for example, no token).
- **Tests.**
  - `test/persistence-delta-registration.test.mjs` (5, in `test:api`) covers: flag OFF; ON without a token; ON with internal visibility (owner and tester allowed, stranger 404, user JWT 401, idempotent/409, replay via `/api/`); restart; and ON with public visibility.
  - Games-C's own suites pass: `test:backend-delta` 7/7, `test:closure` 59/59, `test:flag-off` 55/55, `test:persistence` 32/32.
