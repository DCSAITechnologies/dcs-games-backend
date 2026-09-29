# The migration chain

Append-only. `migrate()` records a sha256 of each file's body and REFUSES to run
if a file changed after it was applied:

    migration 0013_consent_attribution.sql was edited after being applied
    (recorded a1b2…, file c3d4…). Migrations are append-only; add a new one.

That rule is the reason this file exists. A migration header can turn out to be
wrong, and the fix cannot be to edit it — so corrections live here, next to the
chain, where anyone reading it will find them.

## Corrections

### 0013_consent_attribution.sql

Its header says the status check is widened because *"the service also produces
'withdrawn'"*. **That is not true.** `withdrawn` appears nowhere in `src/`, and
`decideParentalConsent()` constrains the decision to `granted` / `denied` /
`revoked`. The widened check is harmless — it is permissive, and 0004 already
allowed `triaged` and `escalated` on reports without the code reaching them —
but the sentence asserts something false, and a document that asserts something
false is worse than one that says nothing.

The real reason to widen it stands: the recorded vocabulary should be a superset
of what the service can reach, so a state the code produces is never a write
that fails at the worst possible moment.

Found by the adversarial review lane, which checked the claim against `src/`
rather than accepting it.

## Quarantine

`0002_seed.sql` must NEVER be executed. It is forensic content — invented
worlds, creators and activity — and running it would put fabricated records into
a database that is meant to hold measured ones. `loadMigrations()` refuses it by
CONTENT as well as by filename, so renumbering it does not get it past the
guard.

## 0014_world_memory_v2.sql — apply BEFORE deploying the build that requires it

Promoted from `docs/games-c/proposed-migrations/` on 30 Sep 2026. From this
build on, `REQUIRED_SCHEMA_VERSION` is 14, so an instance with `DATABASE_URL`
set **exits 78 at boot** against a v13 database. That is deliberate — an
unsupported schema must stop the process, not look like empty data — and it
fixes the order: run `node scripts/migrate.mjs` (or the equivalent) against the
database first, then deploy.

0014 is additive (nullable chain columns, seven new empty tables, a widened
`dcsgames_world_events.kind` check) plus one behavioural change: rows in
`dcsgames_world_versions` become **insert-only** at the database. No code in
`src/` updates or deletes them. A sanctioned purge (for example a data-subject
erasure) must disable `dcsgames_world_versions_no_update` for its own session,
as a reviewed statement. The rehearsal is `test/migration-0014-rehearsal.test.mjs`.
