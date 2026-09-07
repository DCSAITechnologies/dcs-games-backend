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

---

## 11. V2 completion matrix

Proven by `scripts/staging-v2-proof.mjs` against the deployed service — 20/20.

| Capability | State | Evidence |
| --- | --- | --- |
| Generate a world | COMPLETE | V2 proof; an empty prompt is now refused rather than defaulted to a pirate world |
| Load a world | COMPLETE | V2 proof; save-then-load answered 500 until today |
| Save a full manifest | COMPLETE | V2 proof; idempotent on identical bytes |
| Versioning | COMPLETE | V2 proof; monotonic, stale `expected_version` is a 409 |
| Publish | COMPLETE | V2 proof; owner-only, signs an Atlas receipt |
| Public listing | COMPLETE | V2 proof; a draft is absent, a published world present |
| Creator's own listing | COMPLETE | V2 proof |
| State transitions | COMPLETE | a save cannot change state; publish is the only route that does |
| Advertised in `/health` | COMPLETE | the whole V2 surface was missing; now a `world_v2` group |
| Identity slice | COMPLETE | fixture-backed halves retired; the live P2 verification surface unblocked |
| T&S reports | COMPLETE | retired to `/safety/report`, which escalates and now persists |
| Marketplace / payouts | DARK BY DESIGN | proven dark; `assert-dark` endpoints confirm nothing has moved |

## 12. V3 completion matrix

Proven by `scripts/staging-proofs.mjs` at schema v11 — 42/42.

| Capability | State | Evidence |
| --- | --- | --- |
| WorldManifest V3 | COMPLETE | schema gate; 40-seed sweep across 7 prompts, all valid, unique zone ids |
| Assembly / router | COMPLETE | real providers on staging; degraded lanes reported honestly |
| Describe → Generate | COMPLETE | staging proof, real Cerebras providers |
| Play | COMPLETE | staging proof; entering is counted |
| Save / Return | COMPLETE | staging proof; found again at the expected version |
| Restart durability | COMPLETE | byte-identical across a real process restart |
| Version history | COMPLETE | staging proof; strictly sequential under 36 concurrent writers |
| Rollback | COMPLETE, one caveat | content restored exactly (via diff); residual risk in §13 |
| Expansion deltas | COMPLETE | staging proof; new version, not an overwrite |
| World memory | COMPLETE | creation, every edit and the rollback all recorded |
| AI companion | COMPLETE | answers, and is GROUNDED — names a real zone from the world's own manifest |
| Chat-based editing | COMPLETE | staging proof; refuses an unsupported intent and says what IS supported |
| Playtest / critic / repair | COMPLETE | every validator fix name implemented or declared unrepairable with a reason; no repair may leave a blocker it did not arrive with |
| Publish gate | COMPLETE | owner-only, signed, and a save can no longer walk around it |
| Atlas / provenance | COMPLETE | signature verified TRUSTLESSLY, 16/16; the encoding is now published so an outsider can reproduce it |
| Netcode | COMPLETE | 186 checks; the CI gate had never run and now can |
| Concurrency / reliability | COMPLETE | no lost updates, no duplicates, strictly sequential |
| Security posture | COMPLETE | 35/35 remote; the anon key reads nothing from eight tables |
| Mobile / touch / a11y | **IN PROGRESS** | see §13 |
| Browser compatibility | IN PROGRESS | same lane |

## 13. What is NOT closed

Stated plainly, because a report that omits these is worth less than no report.

1. **Frontend accessibility and touch — 6 failing tests.** The entire remaining
   red in the estate. A control under the 44px touch target on the narrowest
   phone; a page needing a second scroll axis at 320 CSS px; a control under
   24px; a field named only by its placeholder; the mobile menu not openable
   from the keyboard; and contrast below the WCAG minimum for its size. These
   are real defects in real pages, found by tests written today, and they are
   red on purpose rather than deleted.
2. **The diligence crawl fails** — three pages render bundled sample data
   without the visible sample label the truth layer requires. A regression from
   this session's own frontend work, and precisely the defect class that layer
   exists to prevent.
3. **Rollback and undetermined live state.** An undetermined category arrives as
   an empty array, indistinguishable from "nothing is held there", so a rollback
   that removes entities can proceed on evidence never gathered. Gating on the
   completeness flag was tried and REVERTED: it is never true by design, so the
   gate disabled every deleting rollback. Closing it properly needs per-category
   deletion analysis. Manifest-recorded ownership IS enforced independently, so
   what the world knows is owned is protected; the residual risk is runtime
   holdings in categories with no source.
4. **Three tables the code names exist nowhere** — `dcsgames_ts_audit`,
   `dcsgames_payout_kyc`, `dcsgames_economy_ledger`. All behind paths that cannot
   run today, now a declared decision with a gate that fails if one becomes
   reachable.
5. **No real internal testers have used the deployed build.** Founder item, not
   engineering: the original blocker was "no deployed build", and that is gone.

---

## 14. The adversarial review of the Lead's own work

Late in the session a lane was given one job: review the code the Lead wrote
today. The Lead had been author and sole reviewer of it — the arrangement that
lets a defect survive — and the review found the signature of exactly that.
Its own summary put it best: **the fix is right and its NEIGHBOUR is not.**

Thirteen findings, all now closed. The three it called blockers:

1. **The A5 consent gate was keyed on a list of words.** It gated
   `voice|narration|avatar`. `MEDIA_KINDS` is
   `[voice, likeness, avatar, name, performance]` and `/health` publishes that
   list, so `kind:"likeness"` naming another principal returned **200** while the
   identical request as `"voice"` returned 403 — and `kind:"image"` was ungated
   and *stores the asset in the world*. A consent gate that can be stepped
   around by choosing a different word for the same act is not a gate. It now
   keys on whether a subject is NAMED.
2. **Preserving `published` across a save was an unreviewed content swap.**
   Killing the body `state` was right; `prior?.state` was not the smaller
   change. Publishing signs a receipt over a SPECIFIC manifest, so swapping the
   manifest underneath left the receipt attesting to content that was no longer
   there — on a live, badged, publicly listed world. And `meta.atlas_signed`
   came straight from the request body, and `/v3/discover` renders it as the
   verification badge.
3. **Migration 0011 fixed the first write in the safety flow and left three
   failing.** Filing a report worked; acting on one did not. 0012 closes it.

And the ones about telling the truth:

- a play was a REQUEST, not a session: ten calls from one token in twenty
  milliseconds became ten plays and forty hours of watch time, served publicly
  as measured platform figures
- `seconds` are self-reported and nothing times a session, so the neutral name
  `play_seconds` is gone and the value now carries its provenance
- `/me/home` reported a page size as a total
- `/api/public/events` labelled the last EDIT as the publication time
- CORS: a schemeless allowlist entry matched `http` as well as `https`; and
  `Allow-Headers: *` matches every header EXCEPT `Authorization`, so every
  authenticated call was blocked at the preflight while the ACAO said welcome
- cw5 validated every op and never validated `seq`
- and the two honest changes collided: the engine throws plain `Error`s, the
  handler now withholds internal messages, so every carefully worded refusal
  reached the caller as a bare 500 telling it to retry

The largest fix came from its finding that a deployment without Supabase kept
runtime state in a **Map** — so acknowledged state vanished at restart, a used
`seq` was accepted again, and every local and CI run was asserting append-only
guarantees against a store that could not keep them. There is now a
`FilePersistenceStore`; durability is real on both branches.

**Fourteen of its attacks bounced**, and those are recorded too: `originAllowed`
survived scheme downgrade, trailing dot, port, userinfo, `%2e`, two-label
wildcard, empty label and `null`; the `state` refusal has no bypass in any
spelling or on any route; no public endpoint leaks a draft; the error handler
genuinely withholds; and cw5's op validation accepts nothing replay refuses.
A disproved hypothesis is a result — it stops the next person re-deriving it.

---

## 15. Proof suites — final

| Proof | Result |
| --- | --- |
| V3 flagship + persistence, schema v11 | 42 / 42 |
| V2 surface | 20 / 20 |
| Atlas provenance, verified trustlessly | 16 / 16 |
| Remote security posture | 35 / 35 |
| Concurrency under load | 26 / 26 |
| Frontend ↔ staging, in a browser | 42 / 42 |
| Netcode anti-cheat | 186 checks |

All re-run against the final deployment after the security fixes.

---

## 16. Browser, mobile and accessibility — what is real and what is not

A lane spent the session proving what is true about the frontend rather than
changing it, which is why its output is a set of red tests that survive the
handover.

**Now genuinely covered:** all 190 HTML documents navigated at 320 CSS px with
touch enabled and measured for reflow, 24px targets, `lang`, viewport, zoom
lock, field labels, skip-link and tab distance, menu naming and contrast. Both
navigation shells driven with real CDP key events. 44px targets, focus rings,
forced-colors and reduced-motion on the five V3 pages. Backend honesty across
200-with-data, 200-empty, 401, 500 and connection-refused, with fixtures that
record every unstubbed path so drift accuses itself by name. Six deployment
tests against the live preview — staging resolution proven from the request URLs
rather than the configuration, CORS proven by a browser performing a real
cross-origin fetch and being refused for an unlisted origin, and the internal
gate proven fail-closed anonymously.

**Still unproven, and stated rather than implied:** Chrome only — no Firefox or
WebKit engine anywhere on this estate. No real device, no real screen reader, no
VoiceOver or NVDA output. The estate sweep measures each page in its default
load state, so interactive states outside the five V3 pages are untested.
Contrast is measured against painted backgrounds, not over images.

**The cheapest large win, measured precisely:** `--dim: #5f6f92` → `#7488b3` in
`assets/dcsgames.css`. That single token measures 3.90/3.55/3.37/3.18:1 against
the four surface colours — all below the WCAG 1.4.3 minimum — and **112 of 191
pages fail on it alone**. `#7488b3` gives 5.53/5.03/4.78/4.51:1.

## 17. A note on how the lanes worked

Three things are worth recording because they changed the outcome.

**Every lane corrected itself in public.** One nearly filed a lost-update defect
against a repository that was correct, and said so; the cause was its own
harness counting idempotent no-ops as losses. One attributed a contrast failure
to the wrong CSS token, corrected it, and re-verified rule by rule rather than
inferring from a single ratio. One twice judged a healthy test run to be wedged
and killed it, and recorded that the misreading was its own. None of those
corrections were necessary to look good; all of them make the report more
usable.

**A red test was treated as a deliverable.** The accessibility lane's job was to
find out what is true, and it handed over failing tests that name a page and a
selector rather than patches. Those tests survive; a message would not have.

**The Lead's own work was reviewed by someone else.** That review found three
blockers in code written and self-reviewed the same day, including a consent
gate that could be stepped around by choosing a different word. Everything in
§14 exists because the reviewing was separated from the writing.
