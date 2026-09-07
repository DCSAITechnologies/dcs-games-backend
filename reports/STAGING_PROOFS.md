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

Re-run 7 Sep 2026 against deployment `330d80ab-cad2-41f2-8cac-45825a52ca1f`
(commit `0b477c5f2c80d597991ccfe2d56ceddab236f491`), **schema v11**.

The earlier 42/42 was taken at schema v10. Migration 0011 moved staging to v11,
which would have left "the staging-proven baseline" describing a schema nobody
was running, so the whole suite was repeated at v11 rather than carried as a gap
into the cutover plan.

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


---

# Remote security posture — `scripts/staging-security-probe.mjs`

Everything checked from OUTSIDE, the way an attacker sees it. Unit tests prove
the code refuses; this proves the DEPLOYMENT refuses, which is the only claim
that covers a misconfigured Supabase project, a leaked key, or a service
answering on a path nobody meant to expose.

Run with `railway run` so the values come from the staging environment. The
script prints no secret; it only ever asserts one is ABSENT.

## Result — 35 passed, 0 failed

- payments dark; schema v10; auth is real Supabase JWT verification; the
  `x-user-id` impersonation path gone and provably unusable; CORS an allowlist
  rather than a wildcard; the running commit identifiable
- no service-role key, no anon key and no PRODUCTION project ref anywhere in
  `/health` — the staging estate exists so that work does not touch the shared
  production project, and that is asserted rather than assumed
- every authenticated route refuses an anonymous caller; a garbage token and an
  `alg:none` token are both refused
- both money surfaces confirm nothing has moved; the public market reports
  DARK rather than empty
- **the anon key can read nothing.** Eight tables probed directly against the
  Supabase Data API; it cannot write or list users either. That is the real
  test of the RLS-on-with-no-policies posture — a 200 there would mean the
  database serves rows to anyone holding a key that ships in the browser.
- a hostile path returns no filesystem path

---

# Concurrency and durability under load — `scripts/staging-load-proof.mjs`

36 concurrent edits across three rounds against one world, plus 20 concurrent
reads, against the deployed service and its Supabase primary.

## Result — 26 passed, 0 failed

- every writer got an answer; nothing 5xx'd or dropped
- every writer either applied or was refused — never silently dropped
- **no lost updates and no duplicates**: the version count moved by exactly the
  number of writes the server accepted. One more is a duplicate; one fewer is a
  caller told its write succeeded when it did not.
- version numbers strictly sequential, because a gap or a repeat means two
  writers computed the next version from the same read
- the manifest still loads, still has its content, and the head version matches
  the version list
- a stale `expected_version` is refused rather than silently applied
- the service is still healthy and money is still dark afterwards

---

# Netcode anti-cheat

The CI gate pinned `524a7f61c373…`, which exists on **no ref** of
`DCSAITechnologies/dcs-games-netcode` — `git fetch` answers
"upload-pack: not our ref". The job could never check out, so the anti-cheat
gate had never run. Repinned to `49f103531b67` (HEAD of main) and verified by
cloning and running it:

**186 checks across twelve suites, 0 failures**, including the speedhack
regression the gate exists for: a gross speedhack is rejected and snapped to
origin, an exactly-at-limit move is accepted, and a legitimate walk is not
clamped.

`scripts/verify-ci-pins.mjs` now resolves every pinned external ref against its
remote and fails with the file and line when one is dead.
