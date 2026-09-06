# Staging proofs — real remote infrastructure

Produced by `scripts/staging-proofs.mjs` against the deployed Railway staging
service and its dedicated Supabase project (`nemmayskbjugulrncufd`). Every
assertion is an HTTP call to the deployed service. Nothing is stubbed and no
result here is asserted that the response does not actually show.

Production was not touched. `PAYMENTS_LIVE` stayed false throughout, and
`0002_seed.sql` was never executed.

## How to reproduce

    STAGE_JWT=<a real Supabase access token for an allowlisted internal tester> \
    OTHER_JWT=<a token for a second principal> \
    PRIOR_WORLD=<a world id saved by an EARLIER process> \
    PRIOR_HASH=<that world's version-1 manifest_hash> \
    node scripts/staging-proofs.mjs

`PRIOR_WORLD`/`PRIOR_HASH` are what make the durability check mean anything:
the world must survive a real process restart, not merely a second request to
the same process. Deploy, then run this against the new deployment.

## Result — 42 passed, 0 failed

Run of 6 Sep 2026 against deployment `0acaf9d2-63a6-4401-a383-65540b083fe9`
(commit `b27e257abd53bf8eac2c592fc84ff7e93dcc34ee`).

### Durability across a real restart
- a world saved by a previous process is still readable
- it still has its content
- its version-1 manifest hash is byte-identical across the restart

### Generation (real providers)
- generate succeeds against the real provider (Cerebras `gpt-oss-120b` serves
  world_architect, fast_inference and gameplay; spatial and asset_3d report
  honestly as deterministic local fallbacks)
- the world is saved with a manifest hash
- the playtest gate passed

### Load and integrity
- the world loads back
- the stored version hash matches what generate reported
- the loaded manifest carries a hash a client can verify
- the new world appears in the owner's list

### Ownership isolation
- another principal cannot read an unpublished world — 404, not 403, so the
  refusal is not an existence oracle
- an anonymous caller cannot read an unpublished world

### Versioning, editing, rollback
- version history is available; the first save is version 1
- an edit is accepted and produces a new version rather than overwriting
- rollback to version 1 is accepted and is recorded as a NEW version
- rollback restores the original content exactly — asserted through the diff
  (0 added / 0 removed / 0 modified, terrain, navigation, spawn and environment
  all unchanged), not through hash equality: the manifest hash covers
  provenance and expansion history, and a rollback deliberately appends to
  both. Demanding an identical hash would be demanding that rollback rewrite
  history.
- the version it rolled back from still exists

### Concurrency
- the probe confirms both writes were actually accepted before asserting
  anything, so it cannot pass vacuously
- concurrent edits neither lose nor duplicate versions
- the manifest is still valid after concurrent writes

### The flagship journey
Describe -> Generate -> Play -> Save -> Return -> Companion -> Edit -> Expand
-> Playtest -> Publish, all against staging:

- the world can be entered, and entering it is counted
- the companion answers, says something, and is GROUNDED — its greeting names
  a real zone from this world's own manifest
- the world remembers what happened to it: its creation, every edit, and the
  rollback
- the world can be expanded, and the expansion is a new version
- the world can be playtested on demand and reports a verdict
- the world can be published; a published world is then visible without a
  login and an anonymous player can load it
- the creator finds it again in their own list, at the expected version
