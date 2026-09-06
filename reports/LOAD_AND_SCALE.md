# Load and scale — measured, 2026-09-06

`DCS_GAMES_LAUNCH_REQUIREMENTS.md` listed load and scale as an unverified gap. It
is no longer unverified. It is now a set of measurements and **three correctness
defects**, all of which reproduce deterministically.

**Read this first:** the headline finding is not a latency number. Under a
concurrency of **two**, this service accepts writes with `2xx` and then throws
most of them away, silently. Everything else in this document is secondary to
that.

---

## 1. What was measured, and on what

Everything below came from `gb/scripts/load-test.mjs` run against a **locally
spawned `server.mts`** on `127.0.0.1`. Nothing was pointed at a remote or
production host. `PAYMENTS_LIVE=0` throughout; the harness refuses to run if
`/health` reports otherwise.

| | |
|---|---|
| Machine | Apple M4 Pro, 14 logical CPUs, 24 GiB RAM |
| OS | macOS 15.1 (Darwin 24.1.0), arm64 |
| Node | v25.8.2 |
| Server | `server.mts` via `tsx`, single child process, one core's worth of event loop |
| Persistence | file store (`DCS_DATA_DIR` = a fresh temp dir per run), **no Supabase** |
| Providers | `DCS_PROVIDERS_OFFLINE=1` — deterministic, no vendor calls |
| Auth | local HS256, real tokens from `signLocalToken` |
| Client | the same machine as the server — loopback, no network hop |

**These are local single-machine numbers. They are not a production capacity
statement.** Client and server shared 14 cores and a loopback interface; there is
no proxy, no TLS termination, no real network latency, no Supabase round trip, no
container CPU quota, and no cold start. Nothing here should be converted into a
user count, and this document deliberately does not attempt that conversion.

Reproduce with:

```
cd gb
node scripts/load-test.mjs                                   # default ramp, 33s wall
node scripts/load-test.mjs --levels=1,2,4,8,16,32,64,128 --duration=5
node scripts/load-test.mjs --levels=8 --worlds=200 --duration=5
node --import tsx --test test/load-smoke.test.mjs            # the CI-safe subset
```

The read mix is weighted like a public launch: `/v3/discover` 4,
`/v3/worlds/:id/manifest` 4, `/v3/worlds/:id/stats` 3, `/me/profile` 2 (authenticated),
`/health` 1.

---

## 2. The defects — what broke first, and at what concurrency

All three are the same bug in three places: **read the whole store, mutate in
memory, write the whole store back**, with `await` points in between. In a
single-threaded event loop every one of those awaits is a yield, so two
overlapping requests both read the same snapshot and the second write erases the
first. The HTTP layer returns `2xx` to both. Nothing anywhere logs a warning.

### LF-1 — Lost play records (`src/core/collection.mjs`, `insert`)

`POST /v3/worlds/:id/play` → `social.recordPlay` → `collection.insert` →
`all()` (read whole JSON file) → `push` → `write()` (write whole JSON file).

Measured across the canonical run and the 1→128 ramp, 12 published worlds:

| concurrent plays | accepted `201` | rows actually persisted | **lost** |
|---:|---:|---:|---:|
| 1 | 1 | 1 | 0 |
| 2 | 2 | 1 | **1** |
| 4 | 4 | 1 | **3** |
| 8 | 8 | 1 | **7** |
| 16 | 16 | 1 | **15** |
| 32 | 32 | 1 | **31** |
| 64 | 64 | 1 | **63** |
| 128 | 128 | 1 | **127** |

Any burst that overlaps collapses to **exactly one surviving row**, regardless of
size. The `/v3/worlds/:id/stats` endpoint then reports the collapsed count, and
`/v3/discover` — which the code comments describe as ranking "on MEASURED
activity only" — ranks on that.

**Minimal reproduction (100% deterministic, 5/5 runs):**

```
cd gb
node scripts/load-test.mjs --levels=2 --duration=1 --warmup=0 --worlds=1 --write-probe=2
# ! concurrency 2: LOST WRITE — 2 plays accepted with 2xx, only 1 persisted (1 lost)
```

Two simultaneous plays. One is destroyed. This is the floor, not a stress case.

### LF-2 — Lost profiles on first sign-in (`social.ensureProfile`, same store)

`GET /me/profile` calls `ensureProfile`, which **writes** when the principal has
no row yet. Same read-modify-write window, on a route every user hits on their
first login.

| distinct new principals signing in at once | got `200` | profiles persisted | **lost** |
|---:|---:|---:|---:|
| 1 | 1 | 1 | 0 |
| 2 | 2 | 1 | **1** |
| 8 | 8 | 1 | **7** |
| 32 | 32 | 1 | **31** |
| 64 | 64 | 1 | **63** |
| 128 | 128 | 2 | **126** |

Every one of those users got a `200` with a fully populated profile body. Only
one row reached disk. On a launch day where sign-ups arrive in bursts, most new
accounts have no persisted profile and the API said they were fine.

Checked and **not** observed: pre-existing rows were never destroyed
(`pre_existing_rows_lost` was 0 at every level), and `principals.json` never
failed to parse — the `tmp`+`rename` write is genuinely atomic, so this is a lost
*update*, not a corrupted file. That is precisely why it is invisible without a
probe that counts rows.

### LF-3 — Lost world edits (`WorldRepository.upsert` over `FileWorldStore`)

`POST /worlds/:id/save` → `repo.upsert` reads the existing record, derives
`version = existing.version + 1`, then writes. The repository *does* support
optimistic concurrency via `expected_version`, but the route defaults it to
`null`, so nothing forces a caller to use it and no conflict is ever raised.

(measured across the canonical run and a separate 2/8/32 verification run)

| concurrent saves | `200` | `409 conflict` | world version advanced | **edits lost** |
|---:|---:|---:|---:|---:|
| 1 | 1 | 0 | +1 | 0 |
| 2 | 2 | 0 | +1 | **1** |
| 8 | 8 | 0 | +1 | **7** |
| 32 | 32 | 0 | +1 | **31** |
| 64 | 64 | 0 | +1 | **63** |

Sixty-four creators are told their edit was saved (`200`, with a
`world_version` in the body); one edit exists. Because `VersionHistoryStore.put`
is deliberately immutable and keyed on `(world_id, version)`, the retained
version history also gains only one entry — so the rollback feature cannot
recover the discarded edits either. They are simply gone.

### Severity

Zero requests failed while all of this was happening. **Across the concurrency
1→128 ramp — 16,187 requests — every single read returned `200`, and there were
zero transport errors.** The service looks perfectly healthy from the outside
while losing data. A load test that only reported p95 would have
signed this off.

---

## 3. Latency and throughput — where it degrades

Canonical run (`node scripts/load-test.mjs`, default settings): 12 published
worlds, 6 measured seconds per level after 1s warmup.

| concurrency | requests | throughput | p50 | p95 | p99 | max |
|---:|---:|---:|---:|---:|---:|---:|
| 1 | 2,443 | 407 rps | 1.51 ms | 6.75 ms | 8.92 ms | 10.2 ms |
| 8 | 2,760 | 458 rps | 4.27 ms | 57.5 ms | 62.3 ms | 68.5 ms |
| 32 | 2,593 | 429 rps | 14.9 ms | 234 ms | 248 ms | 253 ms |
| 64 | 2,561 | 419 rps | 31.2 ms | 501 ms | 552 ms | 563 ms |

Longer ramp (5s per level, same corpus), showing the shape:

| concurrency | throughput | p50 | p95 | p99 | `/v3/discover` p50 | `/v3/worlds/:id/manifest` p50 |
|---:|---:|---:|---:|---:|---:|---:|
| 1 | 306 rps | 1.89 ms | 9.29 ms | 11.1 ms | 8.23 ms | 2.01 ms |
| 2 | 403 rps | 1.80 ms | 15.4 ms | 19.1 ms | 13.1 ms | 2.31 ms |
| 4 | 447 rps | 2.74 ms | 29.4 ms | 33.0 ms | 25.6 ms | 2.92 ms |
| 8 | 437 rps | 4.41 ms | 61.1 ms | 66.4 ms | 55.4 ms | 4.34 ms |
| 16 | 420 rps | 7.89 ms | 123 ms | 133 ms | 114 ms | 7.36 ms |
| 32 | 418 rps | 16.1 ms | 254 ms | 267 ms | 243 ms | 14.4 ms |
| 64 | 385 rps | 35.4 ms | 547 ms | 598 ms | 511 ms | 29.3 ms |
| 128 | 365 rps | 80.0 ms | 1,074 ms | 1,201 ms | 1,009 ms | 61.8 ms |

**Throughput saturates at ~430–460 rps somewhere between concurrency 4 and 8, and
never goes higher.** Past that point additional concurrency buys nothing and is
paid for entirely in latency, which grows linearly with offered concurrency —
the textbook signature of a fully saturated single-threaded server. p95 crosses
100 ms between concurrency 8 and 16, crosses 250 ms at 32, and crosses one second
at 128.

**`/v3/discover` is the bottleneck and it blocks everything else.** At every
level it is an order of magnitude slower than the other four routes, and because
the server is single-threaded its work sits in front of theirs. At concurrency
128, `/v3/discover` p50 is 1,009 ms while `/health` p50 is 16 ms and
`/v3/worlds/:id/manifest` p50 is 62 ms — the cheap routes are being delayed by
head-of-line blocking behind an expensive one.

### The real scale cliff is the world corpus, not the user count

Fixed concurrency 8; only the number of published worlds varies:

| published worlds | `/v3/discover` p50 | total throughput |
|---:|---:|---:|
| 1 | 6.17 ms | 1,745 rps |
| 12 | 53.5 ms | 425 rps |
| 50 | 220 ms | 127 rps |
| 200 | 908 ms | 37 rps |

That is roughly **4.5 ms of `/v3/discover` latency per published world**, and
whole-site throughput falls **47×** between 1 and 200 worlds at unchanged
concurrency. The cause is structural: `GET /v3/discover` calls
`repo.listPublished(200)`, which reads and parses every world file on disk, and
then calls `social.worldStats(id)` per world, and every one of those calls reads
and parses the *entire* `world_plays.json` and `world_ratings.json` file again.
Cost is O(worlds × plays). Two hundred published worlds is a small catalogue, and
at 200 worlds the whole service is already down to 37 requests per second.

### Memory

40-second soak, concurrency 32, 12 worlds, 17,538 requests, RSS of the server
child sampled every 500 ms:

- baseline before load: 102.5 MB
- rises to ~550 MB within the first ~10 s, then oscillates **550–662 MB** in a
  sawtooth for the remaining 30 s, ending at 609 MB
- no monotonic climb after the plateau

**No unbounded leak was observed over 40 seconds / 17.5k requests.** The plateau
is high — ~600 MB steady-state to serve 12 worlds at 438 rps — but it is stable.
During the multi-level ramp RSS does climb across levels (102 MB → 1,703 MB at
concurrency 128) because each level raises the allocation rate and GC lags; that
is not evidence of a leak and should not be read as one. A longer soak (hours)
was **not** run and would be needed to rule a leak out properly.

---

## 4. Incidental finding, from a single request (not a load finding)

`GET /worlds/:id/load` returns **500** for a world created through
`POST /v3/worlds/generate`:

```
{"ok":false,"error":"server_error","detail":"load: base world w3_… not found"}
```

The CW5 persistence engine requires a "base world" that only `POST /worlds/generate`
registers; the v3 generation path never does. This was found while building the
harness, at concurrency 1, and has nothing to do with load. It is recorded here
only so it is not lost. It is outside this lane to fix.

---

## 5. Netcode CI

The full CW4 netcode suite was run locally on this machine before anything was
made blocking:

```
cd cw4-deploy/dcs-games-netcode && npm test   # exit 0
```

**13 suites, 197 checks, 0 failures**, plus `npm run build` (`tsc`) exit 0:

| suite | checks | | suite | checks |
|---|---:|---|---|---:|
| mp0-acceptance | 27 | | delta-compression | 10 |
| mp1-acceptance | 29 | | lag-comp | 13 |
| mp2-conformance | 19 | | aoi | 8 |
| inventory | 14 | | persistence-client | 13 |
| party-wire | 23 | | movement-regression | 7 |
| reconnect | 16 | | mock-server-smoke | 7 |
| | | | speedhack-regression | 11 |

Because it is green, it is safe to gate on. A blocking workflow now exists at
`cw4-deploy/dcs-games-netcode/.github/workflows/ci.yml` — build plus full suite,
no `continue-on-error`.

**Still open, and outside this lane's file ownership:** the `netcode` job in
`gb/.github/workflows/ci.yml` still carries `continue-on-error: true`. That is the
job the sprint actually runs, and until that one line is removed a netcode
regression still cannot fail the backend pipeline. See §7.

---

## 6. What remains untested

Stated plainly, because an unmeasured thing must not be reported as a measured one.

- **Production topology.** No proxy, no TLS, no container CPU/memory limit, no
  cold start, no multi-instance deployment, no autoscaler. Loopback only.
- **Supabase.** Every run used the file store with `SUPABASE_URL` empty. The
  mirrored/degraded paths in `collection.mjs` and `MirroredWorldStore` — which add
  a network round trip *inside* the same read-modify-write window — were never
  exercised under load. LF-1/LF-2/LF-3 will behave differently there, and the
  wider await window makes the race window larger, not smaller.
- **Write-path latency.** The probes measure write *correctness*, not write
  throughput or percentiles. There are no p50/p95/p99 numbers for any POST.
- **Generation under load.** `POST /v3/worlds/generate` and
  `/v3/worlds/generate/async` were called once each, for setup, with offline
  providers. Concurrent generation, the job queue, and real LLM provider latency
  are entirely unmeasured.
- **Sustained soak.** Longest continuous run was 40 seconds. Nothing about
  hour-scale memory, file descriptor or disk behaviour is known.
- **Corpus beyond 200 worlds.** `listPublished` is capped at 200, so the shape of
  the curve past that point was not measured.
- **Large payloads and slow clients.** No large manifests, no slowloris, no
  connection-churn, no keep-alive-off testing.
- **Multi-process / clustering.** The server was one process. Whether the file
  stores survive two processes writing the same JSON file was not tested — though
  LF-1 through LF-3 already fail within a *single* process, so this is academic
  until they are fixed.
- **Rate limiting and abuse.** Not in scope for this lane and not measured.
- **`npm ci` from the netcode lockfile in a clean CI environment.** The workflow
  falls back to `npm install`; only the local `node_modules` install was verified.

---

## 7. What should happen next

1. **Serialise the read-modify-write in `src/core/collection.mjs`.** A per-collection
   promise chain (each mutation awaits the previous one) closes LF-1 and LF-2 with
   no change to the interface above it. Append-only writes would be better still
   for `world_plays`, which is the collection that grows without bound and is
   re-read in full by `/v3/discover` for every world on every request.
2. **Serialise or version-guard `WorldRepository.upsert`** to close LF-3, and make
   `POST /worlds/:id/save` require `expected_version` rather than defaulting it to
   `null`, so a concurrent editor gets the `409` the repository already knows how
   to raise.
3. **Remove `continue-on-error: true` from the `netcode` job in
   `gb/.github/workflows/ci.yml`.** The suite is green; the gate is currently
   decorative. (Not done here: that file is outside this lane's ownership.)
4. **Fix `/v3/discover`.** It is O(published worlds × plays rows) per request. Even
   with the correctness bugs fixed, 200 published worlds takes the whole service to
   37 rps on a fast machine with an empty plays file.
5. **Wire `test/load-smoke.test.mjs` into `test:ci`** once 1 and 2 land. It is
   deterministic — 5/5 identical runs, 2 pass / 3 fail — and takes about 1.3 s. It
   is currently referenced by no npm script precisely so a known-red test cannot
   break another lane's build.

---

*Every number in this document came from a run performed on 2026-09-06 on the
machine described in §1. Nothing is extrapolated, modelled or estimated. Where
something was not measured it is listed in §6 rather than guessed at.*
