# Cold rebuild — can this estate be rebuilt by somebody who is not us?

**Lane W · 6–7 September 2026**
**Script:** `scripts/reproduce.mjs` · **Runs:** 2 complete cold rebuilds
**Verdict:** **Yes, for the backend and the browser stack — with four prerequisites that are
nowhere written down, and with three ways for a newcomer's run to come out green while
having proved nothing.**

Everything below describes runs that actually happened. Nothing here is an idealised
process. Where something was not exercised, it says so.

---

## 1 · What the script does

`node scripts/reproduce.mjs` builds the estate from scratch in a temporary directory and
reads **nothing** from the working tree — not its checkout, not its `node_modules`, not its
`.dcs-data`, not its `.env`. That is the whole point: every claim in this sprint rests on
tests that ran in one working directory with whatever had accumulated in it, and that is a
different statement from "this rebuilds".

It:

1. records the machine, OS and toolchain, and refuses to start without them;
2. clones both banked repositories at their **exact SHAs**, into the directory layout the
   suites actually require (§4);
3. installs dependencies the way a new machine would;
4. creates a randomly-named scratch database, runs the migration chain into it, proves the
   schema version out of the database rather than out of the log, and re-runs the chain to
   prove it is a no-op;
5. runs **every** test suite `package.json` declares;
6. reports per step what happened and how long it took;
7. drops the scratch database and removes the temporary tree;
8. exits non-zero if any step fails.

Child processes get a deliberately narrow environment (`PATH`, `HOME`, `SHELL`, `LANG`,
`TMPDIR`, `USER`, `TERM`, CA vars, `PSQL_BIN`, `DCS_CHROME`, `GH_TOKEN`/`GITHUB_TOKEN`,
`XDG_CACHE_HOME`, plus `CI=1` and npm quiet flags). Everything this machine happens to
export — DSNs, provider keys, data directories — is withheld, because a fresh machine
would not have it.

```
node scripts/reproduce.mjs                  full cold rebuild
node scripts/reproduce.mjs --keep           leave the temp tree for inspection
node scripts/reproduce.mjs --skip-browser   skip the Chrome-dependent suites
node scripts/reproduce.mjs --only test:unit run one declared suite
```

---

## 2 · The machine it actually ran on

| | |
|---|---|
| Host | `MacBook-Pro-4.local` |
| Hardware | Apple **M4 Pro**, 14 cores, 24.0 GB RAM, arm64 |
| OS | macOS **15.1** (build 24B2082), Darwin 24.1.0 |
| Node | **v25.8.2** (`/usr/local/bin/node`) — note: CI pins Node 22, and `engines` only says `>=18`; **the estate has not been rebuilt under Node 22 on this machine** |
| npm | **11.11.1** |
| git | **2.39.5** (Apple Git-154) |
| psql client | **16.14** (Homebrew, `/opt/homebrew/opt/postgresql@16/bin/psql`) — a 18.4 client from `libpq` is also on `PATH`; `src/core/schema.mjs` probes `postgresql@16` first, so 16.14 is what ran |
| Postgres server | **16.14 (Homebrew)** on `aarch64-apple-darwin24.6.0`, local, `postgresql@16` launch agent, listening on `127.0.0.1:5432`, trust auth (no password) |
| gh | **2.97.0**, logged in as `DCSAITechnologies` (keyring), scopes `gist, read:org, repo, workflow` |
| Chrome | **Chrome for Testing 152.0.7977.75**, `~/.cache/puppeteer/chrome/mac_arm-152.0.7977.75` |

---

## 3 · What was rebuilt, and from what

| Repository | Branch | Banked SHA | Result |
|---|---|---|---|
| `DCSAITechnologies/dcs-games-backend-sprint-sep2026` | `sprint/2026-09-canonical` | `e00c7cdf07e9c23c0a930422dbfd61b4422626fa` | cloned, **156 tracked files** |
| `DCSAITechnologies/dcs-games-frontend` | `main` | `1e2df15ad48be0bb6acb28cfb1316fe320d39a28` | cloned, **208 tracked files** |

Both SHAs are reachable and check out cleanly over HTTPS with `gh`'s git credential helper.

> **The banked backend SHA is no longer the branch head.** At the time of the run,
> `refs/heads/sprint/2026-09-canonical` on the bank pointed at `86a047b670e0f0d1964b917d881d6bf8a0134131`,
> one commit past what is banked; the local working tree was at `defd7c1`, two commits past.
> "Clone the branch" and "rebuild what was banked" are now different actions. The script
> detects this, checks out the banked SHA detached, and says so in its output. Anybody
> quoting these results must quote the SHA, not the branch.

---

## 4 · The directory layout is load-bearing and undocumented

The browser and E2E suites resolve the frontend as

```js
// test/frontend-truth.test.mjs:14, runtime-v3:19, runtime-perf:28,
// a11y-pages:34, browser-compat:50, flagship-e2e:23
const SITE = path.resolve(HERE, "../../../dcs-games-LIVE");
```

`HERE` is `<backend-repo>/test`, so `SITE` is **two directory levels above the backend
repository root**, in a directory that must be named **`dcs-games-LIVE`** — which is *not*
the name of the repository (`dcs-games-frontend`). The evidence directory is resolved the
same way: `../../../DCS_GAMES_SPRINT_SEP2026/evidence[/screenshots]`.

So the layout that works is:

```
<root>/
├── dcs-games-6month-deploy/
│   └── gb/                       ← DCSAITechnologies/dcs-games-backend-sprint-sep2026 @ e00c7cd
├── dcs-games-LIVE/               ← DCSAITechnologies/dcs-games-frontend @ 1e2df15  (name is mandatory)
└── DCS_GAMES_SPRINT_SEP2026/
    └── evidence/screenshots/     ← created by the tests
```

The backend repository has **no README**. Nothing in `RUNBOOK.md`, `RUNBOOK_INTEGRATION.md`,
`package.json` or any comment states this. There is no environment variable to override it.
A person cloning both repositories side by side under their own names gets a green
`test:browser` that ran nothing (§6, Finding 2). `scripts/reproduce.mjs` builds this layout
explicitly, which is why its runs are real.

---

## 5 · The two runs

Both runs were complete and green. Timings are wall clock on the machine in §2.

| Step | Run 1 | Run 2 | What it proved |
|---|---:|---:|---|
| preflight | 0.0s | 0.0s | tools present; Postgres 16.14 reachable; DSN is local |
| clone backend | 1.8s | 1.8s | `e00c7cdf07e9`, 156 tracked files |
| clone frontend | 1.7s | 2.4s | `1e2df15ad48b`, 208 tracked files |
| npm install | 0.4s | 0.5s | `npm ci`, 4 top-level packages |
| database from migrations | 0.7s | 0.9s | chain linear · 9 migrations recorded · **schema v9, code requires v9** · **54 public tables** · re-run applied 0 |
| `test:unit` | 6.1s | 6.0s | **818 tests, 818 pass, 0 fail, 0 skipped** |
| `test:api` | 1.5s | 1.7s | **119 tests, 119 pass, 0 fail, 0 skipped** |
| `test:browser` | 9m28s | 9m27s | **83 tests, 83 pass, 0 fail, 0 skipped** |
| `test:e2e` | 65.8s | 65.5s | **12 tests, 12 pass, 0 fail, 0 skipped** |
| `test:load` | 1.3s | 1.2s | **5 tests, 5 pass, 0 fail, 0 skipped** |
| `test:unit:tsx` | 0.3s | 0.3s | **24 tests, 24 pass, 0 fail, 0 skipped** |
| **total** | **10m48s** | **10m48s** | 11/11 steps, **1,061 tests, 0 failures, 0 skips** |

`test:browser` is 88% of the wall clock. Everything else together is 78 seconds.

`package.json` declares eight test scripts. `test` and `test:ci` are aggregates; the script
runs the six leaves so the per-suite timings are honest. It also reports that **`test:ci`
composes only `test:unit`, `test:unit:tsx`, `test:api` and `test:load`** — the browser and
E2E suites are not in the "CI" aggregate at all.

### The migration chain, applied to an empty database

```
applying 0001_baseline_from_lineage_9937f22.sql   0006_marketplace_dark.sql
        0002_schema_version_tracking.sql          0007_orgs.sql
        0003_world_manifest_durability.sql        0008_subscriptions_dark.sql
        0004_safety_and_internal_testing.sql      0009_cw5_runtime_persistence.sql
        0005_social_and_discovery.sql
schema now at v9 (9 applied this run)
{ "ok": true, "version": 9, "required": 9, "missing": [] }
schema now at v9 (0 applied this run)     ← re-run is a genuine no-op
```

`migrations/0002_seed.sql` does not exist in the banked chain and was never run; the
`loadMigrations` guard against the quarantined forensic seed is exercised by
`test/schema-migrations.test.mjs` inside `test:unit`.

---

## 6 · Everything that went wrong

Nothing failed on the happy path. What failed is the estate's ability to *tell you* when
the happy path was not taken. Three of these are defects in files this lane may not edit.

### Finding 1 — my script, fixed

**Where:** `scripts/reproduce.mjs`, run 1.
**What happened:** every suite reported `tests 0 · pass 0 · fail 0`. The parser looked for
the TAP reporter's `# tests N` summary lines. Node ≥22 defaults to the **spec** reporter,
which emits `ℹ tests N`. Run 1 was green on exit codes alone and would have hidden a suite
that ran nothing.
**Fix:** the parser now accepts `ℹ` and `#`, sums across processes, and **fails the step**
when a suite exits 0 having run zero tests or having skipped everything (see Finding 2).
Run 2 reports real counts. This was my bug, and it is fixed.

### Finding 2 — `test:browser` exits 0 with 83/83 skipped when the frontend is absent

**Proved, not inferred.** A clean clone of the banked backend at `e00c7cd`, with no sibling
frontend checkout:

```
$ npm run test:browser
EXIT=0
ℹ tests 83
ℹ pass 0
ℹ fail 0
ℹ skipped 83
```

**Where:**
`test/frontend-truth.test.mjs:17-19`, `test/runtime-v3.test.mjs:22-24`,
`test/runtime-perf.test.mjs:31-33`, `test/a11y-pages.test.mjs:38-40`,
`test/browser-compat.test.mjs:62-65` — each computes `haveSite`/`haveChrome` and passes
`{ skip: "dcs-games-LIVE not found" }` (or `"no Chrome binary"`) to every test.

**Why it matters:** this is the estate's entire browser, runtime, accessibility and
frontend-truth evidence, 83 tests, and it turns itself off silently. Combined with §4 —
the required directory name and depth are documented nowhere — the *default* outcome for a
newcomer is a green `npm run test:browser` that asserted nothing. **The same is true in the
project's own CI** (Finding 4).

**Fix (not applied — these files are not this lane's to edit):** make the precondition an
explicit, opt-out decision rather than a silent default. Either (a) honour an env var such
as `DCS_REQUIRE_BROWSER_SUITE=1` that turns the skip into a hard failure naming the
resolved `SITE` path, and set it in CI; or (b) invert the default so the suites fail unless
`DCS_ALLOW_SKIP_BROWSER=1` is set. Also give `SITE` an env-var override
(`DCS_SITE_DIR`) so the frontend does not have to be renamed to `dcs-games-LIVE`.
In the meantime `scripts/reproduce.mjs` fails the step itself when a suite passes with
every test skipped, and warns on any non-zero skip count.

### Finding 3 — `test:e2e` fails with a misleading error for the same missing directory

Same clean clone, no sibling frontend:

```
$ npm run test:e2e
EXIT=1
ℹ tests 12 · pass 10 · fail 2

✖ E2E 9-10 — the world plays in a browser and the companion knows where you are (33047ms)
  AssertionError [ERR_ASSERTION]: the world did not load in the browser: []
      at test/flagship-e2e.test.mjs:168:10
✖ E2E SUMMARY — every numbered flagship requirement is covered
  AssertionError [ERR_ASSERTION]: flagship step 9 was not exercised
      at test/flagship-e2e.test.mjs:421:12
```

**Where:** `test/flagship-e2e.test.mjs:23` computes `SITE`; line **81** does
`site = await serveStatic(SITE)` **without ever checking that `SITE` exists**; line **164**
guards only on `haveChrome`, not on the site. `serveStatic` on a non-existent directory
happily starts and 404s everything, so the test waits 33 seconds and then reports that the
world failed to load with an empty error list — which points a reader at the runtime, not
at a missing checkout.

**Note the inconsistency:** the identical missing prerequisite makes `test:browser` pass
vacuously and `test:e2e` fail obscurely. Neither says "`dcs-games-LIVE` is not at
`<path>`".

**Fix (not applied):** in `test/flagship-e2e.test.mjs`, add the same `haveSite` guard the
other five browser tests use —
`const haveSite = fs.existsSync(path.join(SITE, "play-v3.html"));` — and either fail fast in
`before()` with `SITE` printed, or extend the skip reason at line 164 to
`!haveSite ? "dcs-games-LIVE not found at " + SITE : (!haveChrome ? "no Chrome" : false)`.
Failing fast is the better answer, per Finding 2.

### Finding 4 — CI never checks out the frontend for the browser job, and the one job that tries uses a path `actions/checkout` cannot write

**Where:** `.github/workflows/ci.yml`.

* **Line 105** — the `frontend` job does
  `uses: actions/checkout@v4` with `path: ../dcs-games-LIVE`. Two bugs in one line:
  `actions/checkout` **refuses any path outside `$GITHUB_WORKSPACE`**, so the step errors;
  and even if it succeeded, `../dcs-games-LIVE` relative to the workspace is *one level too
  shallow* for the `../../../dcs-games-LIVE` the tests resolve. **Line 106** sets
  `continue-on-error: true`, so the failure is swallowed, and the shell guard at
  **lines 109-113** then prints `"frontend repo not reachable from CI yet"` and exits 0.
  That job cannot fail. It is the same "a gate that cannot fail is not a gate" defect the
  `netcode` job's own comment (lines 144-149) says was already fixed elsewhere.
* **Lines 115-129** — the `browser` job installs Chrome but **never checks out the frontend
  at all**. Given Finding 2, `npm run test:browser` at line 126 skips all 83 tests and
  reports success. Given Finding 3, `npm run test:e2e` at line 129 should be **red today**
  with the `flagship-e2e.test.mjs:168` assertion above.
* **Lines 134 and 175** — `upload-artifact` paths `../../DCS_GAMES_SPRINT_SEP2026/…` are
  also outside the workspace; both steps carry `continue-on-error: true`.

**Fix (not applied):** check the frontend out *inside* the workspace (e.g.
`path: dcs-games-LIVE-src`) in the `browser` job and point the tests at it via the
`DCS_SITE_DIR` override proposed in Finding 2; remove `continue-on-error` from the
frontend checkout; and make the diligence-crawl step fail when the file is absent.

### Finding 5 — a fixed staging database name that the code will drop without asking

**Where:** `scripts/migrate.mjs:15` defaults its DSN to
`postgresql://127.0.0.1:5432/dcs_games_staging`; `scripts/migrate.mjs:38` defaults
`--db` to `dcs_games_staging`; `scripts/staging.sh:12` defaults `STAGING_DB` to the same.
`proveReproducible()` in `src/core/schema.mjs` opens with
`drop database if exists <dbName>`.

**What that means:** `npm run staging` on a shared host destroys whatever is in
`dcs_games_staging` — another engineer's, another lane's — with no confirmation and no
`--i-have-a-backup` guard (that guard only covers `up` against a non-local DSN). A
`dcs_games_staging` database is already present on this machine. This is a collision
waiting to bite two people on one box.

**Fix (not applied):** default the staging database name to something host- or
user-qualified, or require `--db` explicitly for the `staging` subcommand, and apply the
same `--i-have-a-backup` interlock to the drop. `scripts/reproduce.mjs` sidesteps it
entirely by generating `dcs_repro_<random>` per run.

### Finding 6 — the test suites turn off silently without Postgres too

Same clean clone, `DCS_PG_ADMIN_DSN` pointed at a dead port:

```
$ DCS_PG_ADMIN_DSN=postgresql://127.0.0.1:1/postgres npm run test:unit
EXIT=0
ℹ tests 818 · pass 810 · fail 0 · skipped 8
```

Eight tests — the entire database-reproducibility gate in
`test/schema-migrations.test.mjs` — vanish and the suite still reports success. This one is
at least deliberate and documented in that file's header ("Skips (rather than fails) when
one is unavailable"), and CI does run it against a real `postgres:16` service. It is listed
here because a newcomer running `npm test` on a laptop without Postgres gets a green result
that never touched a database. `scripts/reproduce.mjs` now warns whenever any suite skips.

---

## 7 · What a person needs before any of this works

Exactly this, on macOS arm64. Nothing here is optional; each item was required by a step
that would otherwise fail or silently skip.

1. **Node ≥ 18** — verified only on **v25.8.2**. CI pins 22. Node 22 was not exercised here.
2. **npm** (11.11.1 used) — `npm ci` against the banked `package-lock.json`.
3. **git** ≥ 2.x.
4. **`gh`, authenticated**, or a `GH_TOKEN`/`GITHUB_TOKEN` with `repo` scope. **Both banked
   repositories are private.** The script clones with
   `-c credential.helper='!gh auth git-credential'`.
5. **A local PostgreSQL server** and a **`psql` client binary**. Server 16.14 was used;
   `src/core/schema.mjs` shells out to `psql` rather than using a driver, and probes
   `$PSQL_BIN`, then `/opt/homebrew/opt/postgresql@16/bin/psql`, then
   `/opt/homebrew/opt/libpq/bin/psql`, then `psql` on `PATH`. The DSN must be **local** —
   the script refuses anything that is not `127.0.0.1`/`localhost`, and it needs rights to
   `CREATE DATABASE` / `DROP DATABASE`.
6. **Chrome for Testing** (152.0.7977.75 used), at `~/.cache/puppeteer/chrome/…` or
   `/Applications/Google Chrome.app`, or `$DCS_CHROME`. Install with
   `npx --yes @puppeteer/browsers install chrome@stable --path "$HOME/.cache/puppeteer"`.
   Without it, 83 browser tests skip silently and 2 E2E tests fail obscurely.
7. **The directory layout in §4**, with the frontend checkout named exactly
   `dcs-games-LIVE`. Undocumented anywhere in the repositories.
8. **Roughly 11 minutes** and a machine that can run headless Chrome with SwiftShader.

Environment variables the script itself will read, by name — all optional:

| Name | Default | Purpose |
|---|---|---|
| `DCS_PG_ADMIN_DSN` | `postgresql://127.0.0.1:5432/postgres` | admin DSN for the scratch database; must be local |
| `PSQL_BIN` | probed | `psql` binary |
| `DCS_CHROME` | probed | Chrome binary for the browser suites |
| `DCS_REPRO_TMPDIR` | OS temp dir | where the rebuild is built |
| `GH_TOKEN` / `GITHUB_TOKEN` | — | only if `gh` is not already authenticated |

The suites themselves are run with `DCS_PG_ADMIN_DSN`, `PAYMENTS_LIVE=0`, `NODE_ENV=test`,
`DCS_PROVIDERS_OFFLINE=1` and nothing else.

---

## 8 · What this run does **not** prove

Be precise about the edges. None of the following was exercised, and no claim in this
sprint should lean on them without saying so.

* **The npm registry.** `npm ci` completed in ~400 ms both runs. Re-running it as
  `npm ci --offline` in the kept temp tree **also succeeded**, which proves the install was
  served entirely from this machine's `~/.npm` cache. Registry availability of
  `tsx@4.22.4`, `esbuild@0.28.1` and `fsevents@2.3.3` — the whole dependency closure — is
  **not** demonstrated by these runs. (The sprint constraints permit no network host but
  GitHub, so this could not be tested here. On a truly fresh machine this step needs
  `registry.npmjs.org`.)
* **The new Supabase project.** Nothing touched it. Every suite runs with
  `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` empty; `test/supabase-paths.test.mjs`
  exercises the code paths, not the service. Durable persistence against real Supabase is
  unproven by this exercise.
* **Any deployed service.** No Railway service, no `api.games.dcsai.ai`, no
  `dcs-games-netcode` WebSocket. `scripts/smoke.mjs`, `scripts/monitor-dark.mjs` and
  `scripts/verify-release.mjs` were not run; they are not declared test suites.
* **Anything requiring credentials.** No Stripe, no Cerebras/DeepSeek/Together provider
  keys (the E2E runs with `DCS_PROVIDERS_OFFLINE=1` and deterministic fallbacks), no Atlas
  production signing key (the E2E generates a throwaway seed). **`PAYMENTS_LIVE` was `0`
  throughout.**
* **A third repository CI depends on.** `.github/workflows/ci.yml:137-159` checks out
  `DCSAITechnologies/dcs-games-netcode` and runs its anti-cheat suite. **No SHA for that
  repository was banked.** Its `main` is currently `49f103531b6701b64afe03bf89a4615442e9aef3`,
  but nothing pins it, so a CI-equivalent rebuild of the estate is not reproducible today.
  It was out of scope for this script and is not covered by these runs.
* **`npm run secret-scan`.** Declared in `package.json` as
  `node scripts/secret-scan.mjs . ../../dcs-games-LIVE` — it needs the sibling frontend too,
  and is not a test suite. Not run.
* **Linux, Windows, x86-64, and Node 22.** One machine, one OS, one architecture, one Node.
* **Anything requiring input this machine has** that a stranger would not: the `gh` keyring
  session for two private repositories, and a running local Postgres with database-creation
  rights.

---

## 9 · Honest answer

A person who is not us, on a machine that is not this one, **can** rebuild the backend from
`e00c7cd` and the frontend from `1e2df15`, build the v9 schema from the migration chain into
an empty database, and run 1,061 tests to green in under eleven minutes — **provided they
are told four things that no file in either repository tells them**: that the frontend must
be checked out as `dcs-games-LIVE` two levels above the backend root; that a local Postgres
with `CREATE DATABASE` rights must be running; that Chrome for Testing must be installed;
and that the SHA, not the branch, is what was banked.

If they are not told those things, their run comes out **green anyway** — with 83 browser
tests and 8 schema tests silently skipped — and only the flagship E2E fails, with an error
that blames the runtime instead of the missing checkout. That gap between "green" and
"proved something" is the finding of this lane. `scripts/reproduce.mjs` closes it for
anybody who runs the script; Findings 2, 3, 4 and 5 close it for everybody else, and they
are for the owners of those files to apply.

---

### Appendix — reproducing this report

```bash
node scripts/reproduce.mjs          # ~11 min; exit 0 means genuinely green
```

Per-step logs (`clone-*`, `npm-install`, `migrate-*`, `suite-*`) are written to a
`dcs-repro-logs-*` directory under the OS temp dir and are **kept** after the temp tree is
removed; the path is printed in the summary. Run 1: `dcs-repro-logs-2DrRVJ`.
Run 2: `dcs-repro-logs-Ohoiv5`.
