# DCS Games — overnight autonomous closure report

**7 September 2026.** Governing order: `DCS_GAMES_OVERNIGHT_AUTONOMOUS_FULL_CLOSURE_ORDER_07SEP2026.md`.

Production was never touched. `PAYMENTS_LIVE` stayed `false` throughout.
`0002_seed.sql` was never executed. No production Railway deploy, no production
Supabase migration, no production Cloudflare promotion, no payment activation,
no force-push, no history rewrite.

---

## 1. Executive status

Seven lanes ran against one shared working tree with strict file ownership: a
Lead plus six agents, three to four concurrent at any time. No rate limiting
was encountered.

The session's character was not "add features". It was **finding the places
where this estate says something that is not true** — and there were a great
many. A route inventory hiding 37 live routes including all of V2. A
configuration variable that looked like a security control and enforced
nothing. A moderation queue that reported healthy while every write failed. A
CI gate pinned to a commit that exists on no ref, so it had never run. A cold
rebuild reporting green against a commit sixty behind. A gate that refused
worlds while naming repairs nothing implemented. A publish authorization that a
save could walk around.

Most of those were found by running the thing, remotely, and reading what came
back — not by reading code.

**Release label: `V3_VERTICAL_SLICE_PROVEN`.** Reasoning in §19.

---

## 2. Final Git state

| Repo | Branch | HEAD | Remote in sync |
| --- | --- | --- | --- |
| `dcs-games-backend` (gb) | `sprint/2026-09-canonical` | `7afc539464cb92b60d42f624f8bb222d2adde788` | yes |
| `dcs-games-LIVE` (frontend) | `main` | `2c32d0a2d18ea477ddcb52e198957314dc30fa89` | yes |
| netcode | `main` | `49f103531b6701b64afe03bf89a4615442e9aef3` | verified, unchanged |

83 backend commits this session. Every one pushed.

**Rollback bundles re-cut and RESTORE-TESTED**, not merely created:

    backend-gb-7afc539-20260907T012857Z.bundle   sha256 629b8790…
    frontend-live-2c32d0a-20260907T012857Z.bundle sha256 09c29a77…

A clone from the backend bundle produced branch `sprint/2026-09-canonical` at
`7afc539` with 187 tracked files and all 11 migrations.

---

## 3. Test matrix

`node --test --test-concurrency=4 test/*.test.mjs`

| | count |
| --- | --- |
| tests | 1332 |
| pass | 1324 |
| **fail** | **4 — all frontend accessibility/touch, see §11** |
| skipped | 4 |

**Zero unintended skips.** All four skips share one conditional cause — the CW5
engine is TypeScript with parameter properties, which plain `node --test` cannot
load. Under `tsx --test` those same tests run **27/27, 0 skipped**. The skip is
conditional on the loader, never on the outcome.

---

## 4. Staging deployment state

**15 verified deployments today**, ledger at `reports/DEPLOYMENTS.md`.

`scripts/deploy-staging.sh` will not claim a deploy it cannot prove: it captures
the deployment id it just created and asserts the live service reports **that**
id before writing a ledger row. If the service comes back on a different
deployment — which is exactly what happened earlier when a variable change
silently reverted the service to its GitHub-source build while every health
check stayed green — it exits 4 and says the deploy failed.

It ships a `git archive` export of the commit rather than the working tree, so
what is deployed is provably the commit in the ledger and never another lane's
half-finished edit. That also fixed the build stamp: `railway up` enumerates
files through git, so an untracked stamp never reached the image; the export has
no `.git`, so it travels. `/health` now reports its own commit, branch, build
time and deployment id.

Current: deployment `330d80ab-cad2-41f2-8cac-45825a52ca1f`, schema v11,
`payments_live: false`, CORS allowlist enforced.

---

## 5. Database and migrations

Chain `0001 → 0011`, linear, per-migration checksums, boot-time assertion.

**Migration 0011 was written and applied to staging today**, after a real backup
(5,433,597 bytes, sha256 `80062b75dc8b…`, held outside the repo). It fixes the
defect described in §8. Applied through the migrator so the ledger records it;
`verify` reports `{ok: true, version: 11, required: 11, missing: []}` on both
the remote staging project and the local `dcs_games_staging`.

`0002_seed.sql` remains quarantined and was never executed. Quarantine is
enforced by CONTENT as well as filename.

---

## 6. What was found and closed

### Truthfulness of the estate's own reports

- **`/health` was hiding 37 live routes**, including the entire V2 world surface
  — `POST /worlds/:id/save`, `GET /worlds/:id/load`, `POST /worlds/:id/publish`,
  `GET /worlds/:id/manifest`. V2 is live and carries traffic; the inventory made
  it look retired. A test now derives routable paths from the dispatcher and
  advertised paths from a RUNNING server and fails on disagreement in either
  direction. It also reaches into the cw1 slice, which dispatches on
  `path === "…"` and was invisible to anything scanning `server.mts` alone.
- **`ALLOWED_ORIGINS` was dead configuration.** Every response carried
  `Access-Control-Allow-Origin: *` while the staging service carried a variable
  listing two domains. A setting that appears to restrict something and does not
  is worse than no setting, because someone reads it and believes it. Now
  enforced, with a one-level wildcard for Cloudflare previews and tests pinning
  the traps: two levels deep must not match, `evil-dcs-games.pages.dev` must not
  pass as `.dcs-games.pages.dev`, a suffixed lookalike must not match.
- **The CI netcode gate had never run.** It pinned `524a7f61c373…`, which exists
  on no ref of its repository — `git fetch` answers "not our ref" — so the
  checkout could never succeed. Repinned to `49f103531b67` and verified by
  cloning and running it: **186 checks, 0 failures**, including the speedhack
  regression. `scripts/verify-ci-pins.mjs` now resolves every pinned external
  ref and fails with the file and line when one is dead.
- **The cold rebuild reported green against a stale commit.** The banked SHAs in
  `scripts/reproduce.mjs` sat sixty-odd commits behind; the run passed 11/11 and
  the only trace was "branch head moved to" inside a PASS line. It now refuses a
  superseded pin and names the SHA to update to.
- **The CI release job produced no artifact** and reported success: the manifest
  was written to a sibling directory that does not exist in CI.
- **A proof of mine was lying.** `preview-integration-proof.mjs` asserted "the
  page rendered something" against `/worlds.html`, which was a dead link
  rendering `404.html` — and Cloudflare Pages serves that with a 200, so the
  status code did not catch it either. Found by Lane E looking at what the
  assertion actually said rather than at its green tick.

### Security

- **A save could publish a world.** `POST /worlds/:id/save` took `state` from the
  body, so `state:"published"` created a published, discoverable world while
  walking past the internal-tester check, ownership, the playtest gate and the
  Atlas signing key. Because `repo.upsert`'s owner check only fires when a record
  already exists, any authenticated account could do it on an unclaimed id. The
  mirror-image half — `|| "draft"` — silently unpublished a published world on an
  ordinary save.
- **The A5 voice-and-likeness gate came off by omitting a field.**
  `source: b.source || "synthetic"`, and the consent check returns permitted
  immediately for "synthetic" — while `subject_id` could still name a real
  person and was forwarded to the provider. A default that disables a consent
  check is the wrong default however it is spelled.
- **Object ownership disappeared instead of refusing, in two requests.** A
  malformed `var_set` was accepted, replay then threw forever, and `save()` read
  ownership inside a `try/catch` that treated ANY failure as "nothing is owned" —
  so the check did not refuse, it vanished. Now fail-closed, and every op is
  validated before entering an append-only store.
- **The top-level error handler sent raw runtime messages to clients** — ENOENT
  naming container paths, database errors naming relations and columns.
- Plus, from the security lane: an unauthenticated schema disclosure on
  `/health`, a deletion the caller was told succeeded that never applied, an
  existence oracle on private worlds, arbitrary `state` storable, a principal-id
  collision, a credential that could never expire, unconfirmed email satisfying
  the tester allowlist, and SQL injection into `drop database`.

### Safety

- **The report table could not store a report.** Every write to
  `dcsgames_reports` had been failing: no `escalated` column, and status
  `under_review` violated the check constraint. Reports fell back to the file
  shadow, which on Railway is the container's own disk, so **every deploy emptied
  the moderation queue** — csam, grooming and self_harm among them. Found by Lane
  E driving the deployed preview and noticing reports vanish.
- The store did say so, in a `degraded` list — but only after a write had already
  been lost, and nothing treated a degraded SAFETY collection as more serious
  than a degraded cache. `/health` now raises it as a critical alert and logs it.
- **Withdrawing one block erased everyone else's** (read-modify-write outside the
  lock). **A CSAM report could be filed into a map nobody reads.** **An age
  assurance you could retry** until it gave the answer you wanted.

### The playtest gate

- **Eight of twenty-one fix names had no implementation.** Worlds were rejected
  naming a repair that could not run. Six implemented; two — inventing NPCs and
  buildings — declared as deliberate non-repairs with reasons, because
  fabricating them would let a world pass while staying empty.
- **Repairs manufactured their own blockers.** `add_quest` chose targets the
  player could not reach; `separate` pushed buildings out of the terrain;
  `reseat_on_ground` seated them on spikes. All three now pinned by one
  invariant: *no repair may leave the manifest with a blocker it did not arrive
  with*.
- **`link_zone` linked orphans to each other**, never to the spawn, reporting
  success every round while the world stayed unreachable.
- **A repair could delete state that preservation had just certified**, because
  the certification ran on one manifest and the store received another.
- **The remembered-shape defect class, four times.** NPC `dialogue` is
  `{seed, lines[]}` and not an array; quests use `title` and `steps[].target`,
  not `name`/`target_ref`; `flatten_zone` read `terrain.heightmap`, a field no
  manifest has ever had. Each was code written against a remembered shape rather
  than the schema. There is now a gate that runs every repair over a real
  assembled world and validates the result.
- **Certain seeds could not be generated at all** — the default archetype had
  four district names while the count runs 3..5, so `i % length` wrapped and
  produced a duplicate zone id, failing the manifest schema. Roughly a third of
  default-archetype seeds. It surfaced only because one authorisation test
  happened to land on one, and passed in isolation.

---

## 7. Staging proofs — all against the deployed service

| Proof | Result | Script |
| --- | --- | --- |
| Flagship journey + persistence | **42 / 42** | `scripts/staging-proofs.mjs` |
| Remote security posture | **35 / 35** | `scripts/staging-security-probe.mjs` |
| Concurrency under load | **26 / 26** | `scripts/staging-load-proof.mjs` |
| Frontend ↔ staging, in a browser | **42 / 42** | `scripts/preview-integration-proof.mjs` |
| Netcode anti-cheat | **186 checks, 0 fail** | netcode repo `npm test` |

Detail in `reports/STAGING_PROOFS.md`. The ones that matter most:

- **Durability across a real restart**: a world saved by a PREVIOUS process is
  byte-identical afterwards. A single request to the same process would prove
  nothing.
- **Ownership isolation returns 404, not 403**, so a refusal is not an existence
  oracle. And an expired token now fails with its own message rather than being
  reported as an ownership failure.
- **No lost updates**: 36 concurrent edits across three rounds; the version count
  moved by exactly the number of writes the server accepted — one more is a
  duplicate, one fewer is a caller told its write succeeded when it did not.
  Version numbers strictly sequential.
- **The anon key can read nothing.** Eight tables probed directly against the
  Supabase Data API. That is the real test of the RLS posture: a 200 there would
  mean the database serves rows to anyone holding a key that ships in the browser.
- **Rollback restores content exactly** — asserted through the diff, not hash
  equality, because the manifest hash covers provenance and expansion history
  and a rollback deliberately appends to both. Demanding an identical hash would
  be demanding that rollback rewrite history.

---

## 8. Frontend ↔ backend wiring

`reports/ROUTE_UI_COVERAGE.md`, regenerated from a live probe of the deployed
service.

| | at start | now |
| --- | --- | --- |
| Dead buttons (UI calls a path nothing serves) | 9 | **0** |
| Unadvertised (route answers, `/health` silent) | 4 → 37 found | **0** |
| Live routes no page calls | 45 | **11**, all justified |

The eleven are: `/auth/{login,signup}` (the site authenticates through Supabase
OAuth; a second credential path would be worse than an unreached route), the
legacy `/ts/*` moderation console (superseded by `/safety/*`; two queues against
two slices is worse than one unreached), the dark payout-KYC shells, and
marketplace/subscription admin surfaces that are money-adjacent and dark.

Five public endpoints were **added** rather than worked around, so pages stopped
falling back to bundled sample rows: `/api/public/stats`, `/api/public/events`,
`/api/public/market`, `/api/public/atlas/feed`, `/api/public/atlas/stats`, plus
`/me/home`. Every figure is counted at request time and carries `measured_at`
and the basis it was counted on. Two deliberate absences:

- **no platform-wide unique player count** — the index gives uniques per world,
  and summing those double-counts anyone who played two. A figure labelled
  "unique" that is not unique is exactly what the truth layer exists to keep off
  this site. The field is null with a note saying why.
- **the market reports DARK, not empty** — an empty list says "no items" when
  the truth is "this is switched off".

---

## 9. Blockers — founder or external only

| # | Blocker | Needs |
| --- | --- | --- |
| F1 | The banked mirrors are PRIVATE. Both original repos are public, and these branches carry working reproductions of vulnerabilities still live in production. Publishing before fixes ship would be publishing an exploit kit. | Founder decision on when to make them public |
| F2 | No evidence of real internal testers using the deployed build | Founder to invite testers; the original blocker (no deployed build) is gone |
| F3 | Production cutover | Founder execution of `DCS_GAMES_PRODUCTION_CUTOVER_PLAN.md` |
| F4 | Section A launch blockers (legal, compliance, commercial) | Unchanged; outside engineering |

None of these blocked any other lane.

---

## 10. Production cutover and rollback

Prepared, never executed: `DCS_GAMES_PRODUCTION_CUTOVER_PLAN.md` and
`DCS_GAMES_PRODUCTION_ROLLBACK_CHECKLIST.md`. Twelve ordered steps, per-step
verification, environment variables by NAME only, fourteen abort criteria.

Two hazards in it that no existing runbook mentioned: shell contamination
(staging credentials during a production cutover passes every check and prints
"ALREADY MIGRATED"), and repointing `assets/dcs-truth.js`, which hardcodes the
shared production Supabase project — miss it and every authenticated call fails,
reading as "auth is broken".

The rollback checklist names the irreversible part plainly: rolling back forks
the data, and Supabase Auth accounts created in the window cannot log in
afterwards.

**The baseline is v11, and proven there.** Lane F correctly flagged that the
42/42 flagship run had been taken at v10 while the code had moved to v11, which
would have made "the staging-proven baseline" a claim about a schema nobody was
running. Rather than carry that as step 0 of the cutover, the run was repeated:
**42 / 42 against schema v11**, deployment `330d80ab-cad2-41f2-8cac-45825a52ca1f`,
commit `0b477c5f2c80`. The cutover baseline is therefore v11 and the proof for
it exists.
