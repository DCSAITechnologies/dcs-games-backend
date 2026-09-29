# GAMES-C — Companion / World Memory / Multiplayer / Publish / QA — closure report (28 Sep 2026)

Lane: GAMES-C. Isolated branches only. The website/dashboard recovery branch
(`fix/dcs-games-website-dashboard-recovery-28sep2026` in `gb` and `dcs-games-LIVE`), the original
netcode checkout and the GAMES-A worktree were not modified.

| Repo | Branch | Base | Worktree |
|---|---|---|---|
| backend (`gb`) | `games-c/systems-28sep2026` | `cd9856d` | `~/Developer/dcs-games-c-systems` |
| netcode | `games-c/netcode-slice-28sep2026` | `524a7f6` | `~/Developer/dcs-games-c-netcode` (commit `bdd8b74`) |

Commit SHAs, bundle hashes and restore proof are recorded in the lane hand-off (they cannot be
written into the commit that they identify).

## What was built (all new code under `src/v3/gamesc/`)

| Area | Module | Tests | Status |
|---|---|---|---|
| Edit / patch / undo | `patch/` | `gamesc-patch` 23/23 | PROVEN (module). Route wiring DESIGN-ONLY |
| Companion | `companion/` | `gamesc-companion` 101/101 | PROVEN (module, deterministic, offline). Route wiring DESIGN-ONLY |
| World Memory v2 | `memory/` | `gamesc-memory` 20/20 | PROVEN (in-memory + FS adapters). Supabase adapter + migration 0014 PROPOSED only |
| Publish / package | `publish/` | `gamesc-publish` 26/26 | PROVEN locally (immutable signed package, staging registry, rollback, preview). No deploy performed |
| Multiplayer shim | `multiplayer/` | `gamesc-multiplayer` 18/18 | Default OFF; not wired to `/health` |
| Security + cost | `guard/` | `gamesc-guard` 29/29 | PROVEN in tests; not yet on the live request path |
| Playtest gates | `qa/` | `gamesc-qa` 16/16 | PROVEN: 13/13 gates PASS with browser gates on (report JSON in this folder) |
| Netcode slice | netcode `tests/games-c-vertical-slice.test.ts` | 37/37 | VERTICAL_SLICE_PROVEN_LOCAL |

## Test results on the final tree (Node v25.8.2, offline)

| Suite | Result |
|---|---|
| `test:unit` (now includes the 7 `gamesc-*` suites) | 1346 / 1346 |
| `test:unit:tsx` | 69 / 69 |
| `test:api` | 126 / 126 |
| `test:load` | 6 / 6 |
| `test:e2e` (with `DCS_SITE_DIR` = clean `git archive` of frontend `2cce536`) | 12 / 12 |
| netcode `npm test` | 14 suites / 234 checks / 0 fail (baseline 13 / 197) |
| `secret-scan .` | CLEAN, 268 files |
| `test:browser` | not run in this lane |

Baseline at `cd9856d` was 1113 / 69 / 126 / 6, all passing.

## Gate reports
- `GAMES_C_GATES_REPORT_offline.json` — 10 PASS / 0 FAIL / 3 SKIPPED (browser gates off) → INCOMPLETE.
- `GAMES_C_GATES_REPORT_browser.json` — 13 / 13 PASS. FPS 44.9 (min 20, headless SwiftShader), heap 11.8 MB, 0 console errors.
  The earlier run by the QA agent measured 24.4 fps, so FPS is variable under software rendering. It is not proven on real devices.

## Integration work left for the final game-engine integration lane
1. Wire into `server.mts`:
   - the `/v3/worlds/:id/edit` companion fallback plus the patch path, with 409 on a stale base (companion + patch specs §8);
   - a new `/v3/worlds/:id/undo` route;
   - WorldMemory v2 in save/rollback/expand/fork/load (memory spec §8);
   - staging packaging in publish (publish spec §6.1);
   - `guardManifest` before save/publish, and `guardUserPrompt` on generate/companion;
   - the budget ledger around the provider lanes.
2. Runtime (`dcs-runtime.js`) must read the new `gameplay.player.*`, `gameplay.rules.*` and `ui.*` fields. They are DESIGN-ONLY until then.
3. Apply migration `0014_world_memory_v2` (proposed) to staging. It also fixes an existing mismatch: `rolled_back` vs the 0003 check, which only allows `rollback`.
4. Schema hardening: reject `behaviors[].script` (`schema.mjs:181`).
5. Pull the secret rules, now copied in 3 places, into one module.
6. Netcode:
   - real token verification (currently `mockTokenVerifier`);
   - session caps and GC;
   - frame and body size caps;
   - a max-players limit;
   - a `world_id` check on join;
   - wiring party/presence/inventory in `server.ts`;
   - a `/persistence/delta` backend route;
   - spawn points in the protocol.
7. CI pin: `ci.yml:184` pins netcode `49f1035`, which predates the speedhack fix (the slice fails 3/36 on it).
   Push `524a7f6`/`bdd8b74` to origin `dcs-games-netcode`, then re-pin. This is outward-facing and needs founder GO.
8. The moderation gate is missing everywhere. Packages record `moderation.status:"not_performed"`.

## Spend
REAL_API_CALLS = 0. ESTIMATED_API_SPEND = $0.00. All provider paths ran with `DCS_PROVIDERS_OFFLINE=1`.
The browser gate loaded three.js from cdnjs (a public CDN GET). Nothing else touched the network.
