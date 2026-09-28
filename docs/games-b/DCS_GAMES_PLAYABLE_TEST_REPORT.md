# DCS Games · Games-B playable test report

**Lane:** GAMES-B (3D world, assets and gameplay)
**Date:** 29 Sep 2026
**Branch:** `games-b/3d-world-pipeline-28sep2026`, in the worktree `~/Developer/dcs-games-b-world`. It was cut from backend `gb` at `cd9856d`, and it is isolated from the website/dashboard recovery worktree.

## 1. Verdict

Lanternfall is playable in a real browser (headless Chrome with SwiftShader WebGL), and it was built entirely by the offline pipeline.

| Check | Result |
|---|---|
| Validation | 0 errors, 0 warnings |
| Headless playtest | Wins by walking, in 72.65 s of simulated time |
| Save/reload mid-run | Round-trips exactly |
| Browser: movement, camera, collision, interaction, NPC dialogue, pickups, save → page reload → load, win, lose | All pass |

**Not verified:**
- Frame rate on a real GPU. The only numbers are from SwiftShader.
- Human keyboard play. The tests drive the page through its test hook.
- Any real provider generation. See §6.

## 2. Suites run

| Suite | Command | Result |
|---|---|---|
| Games-B unit / pipeline / hooks / lint | `npm run test:gamesb` | **190 / 190 pass**, 8.7 s |
| Games-B browser + flagship | `npm run test:gamesb:browser` | **27 / 27 pass**, 283 s |
| Existing backend unit suite (regression) | `npm run test:unit` | **1113 / 1113 pass** |

The existing suite first failed 1 test, `ci-coverage`, because the new Games-B test files were not referenced by any npm script. They are now wired into `test:gamesb` and `test:gamesb:browser`, and chained into `test` and `test:ci`. After that it passed 1113 / 1113.

The existing `test:api`, `test:browser` and `test:e2e` suites were not re-run. They were not touched by this branch.

## 3. Coverage against the brief's required tests

| Required test | Where it is covered |
|---|---|
| Schema validation | Each schema has valid fixtures plus mutated-invalid cases that must be caught: world (25), gameplay (≥12), characters (24), concept, asset records, and the WorldManifestV3 bridge through `validateManifest`. |
| Scene completeness | `gamesb-world-scene`: the required node set and parent links. `validatePackage` checks this again on every build. |
| Missing asset references | `gamesb-world-scene` checks by name. `gamesb-assets` covers `validateAssetSet`. `gamesb-pipeline` removes a record from a built package and expects rejection. |
| Collision | `gamesb-world-nav-collision` covers rotated boxes, cylinders and a wedged capsule. `gamesb-runtime` covers sim push-out. The browser test walks into a solid and stops at its face. |
| Spawn validity | World validator and tests: every spawn is in bounds, on walkable ground, not inside a collider and not under water. This held for all 27 biome × scale combinations, plus a 1,890-world sweep. |
| Objective reachability | `findPath` from `spawn_player` reaches every region, interactable, NPC and checkpoint. `solveGameplay` gives a logical plan, and `checkObjectiveReachability` confirms it physically. The headless agent actually wins 5 different prompts plus the flagship. |
| Stale navigation | This is new at integration: a solid added without re-baking navigation is now a validator error. It used to be caught only by the playtest. Covered by `gamesb-world-stale-nav`. |
| Save/reload | `snapshot → restoreSim → snapshot` is identical. The playtest restores into a fresh sim mid-run and still wins. The browser saves, reloads the page, loads, and position and inventory come back. |
| Broken scripts | `validatePackage` rejects an injected unknown action kind. Dialogue graphs are checked for unreachable nodes and exit-less loops. The headless agent has a loop guard for cyclic dialogue. |
| Console errors | The browser suite asserts zero page errors, zero console errors and zero hook errors, for both the mini fixture and the flagship. |
| Performance budget | `validatePackage` estimates triangles, draw calls and texture memory. The browser suite measures actuals over 300 frames against the asserted budgets. |

The runtime paths the brief lists are all covered by the browser suite, on both the mini fixture and the flagship: launch, movement, camera, collision, objective, interaction, NPC, win/lose, save and reload.

## 4. Performance

| Metric | Flagship (Lanternfall) | Mini fixture |
|---|---|---|
| Draw calls | 258 (budget < 600) | 59 |
| Triangles | 166,712 (budget < 1.5M) | 33,312 |
| Textures / geometries | 59 / 281 | 22 / 64 |
| Frame time, SwiftShader (CPU) | p50 331 ms / p95 743 ms (~3 fps, host under heavy load) | p50 119 ms / p95 169 ms |
| Time to ready | 8.3 s (SwiftShader) | 5.2 s |
| Simulation step (Node) | 0.007–0.038 ms per step (budget 0.5 ms) | |
| Full offline build + gates | 271 ms for the flagship; 280–785 ms across 5 prompts | |
| Package size | 391 KB | |

SwiftShader renders on the CPU, and this machine was running other suites at the time. These frame times say nothing about GPU frame rate. The actionable numbers are the draw-call and triangle counts, which are well inside budget for 60 fps on a desktop GPU. A real-device frame-rate check is still open.

## 5. Determinism

The same prompt, seed and `createdAt` give byte-identical world, scene, assets, gameplay and characters. Provenance records the real wall-clock `at` and `latency_ms` per stage, so the package's `integrity.sha256` changes on every build even when the content does not. This is deliberate: provenance is kept honest rather than frozen. Comparing two builds of the flagship showed differences only in `provenance.stages[*].at`, `provenance.stages[*].latency_ms` and `integrity.sha256`.

## 6. Providers and spend

- **Configured:** only `CEREBRAS_API_KEY` exists in this shell. On 28 Sep 2026, `GET /v1/models` returned `wrong_api_key`. That call is free.
- **No other provider:** there is no image, 3D or other text provider key locally.
- **Behaviour:**
  - Every lane ran its deterministic local fallback, and provenance records `FALLBACK` with the adapters that were skipped.
  - The Cerebras concept and gameplay adapters, the FLUX texture adapter and the external-3D adapter are implemented behind `Lane`.
  - Each was tested only against injected fake adapters. That testing covers the parse and repair path, cost accounting and provenance.
- **Real provider assets:** 0.
- **API spend:** $0.00.

## 7. Known gaps

1. There is no GPU frame-rate measurement, and no human play session.
2. Escort objectives can't be completed: the rules engine waits for an `npc_state: arrived` that the simulation never emits. The generator does not produce escort objectives.
3. Collision is XZ-only, so the player can't stand on top of structures. Arches and gates are solid boxes.
4. There is no audio, and the intro cinematic asset is generated but never played.
5. Melee combat is not implemented. Hostile NPCs are damage hazards to avoid.
6. Expansion reuses shipped assets and never grows the terrain.
7. The browser win test teleports between targets. Winning by walking is proven by the headless agent in Node.
8. Storm lighting: the renderer raises the storm sun to intensity 0.55 with shadows on, so the scene doesn't read flat. This is a renderer choice, not package data.
9. `test/helpers/browser.mjs` kills harness Chrome processes older than 2 minutes. Two browser suites running at the same time can therefore break each other.
10. Licensing: procedural assets are marked `cleared`, FLUX output `internal-testing-only`, and external 3D `unknown`. These need legal review before a public launch.

## 8. Evidence

All evidence is under `docs/games-b/evidence/`.
- **Flagship:** `lanternfall-dusk-overview`, `-harbour`, `-ruins`, `-lighthouse`, `-dialogue`, `-hud`, `-win`, `-lighthouse-lit` and `-defeat` (`.png`)
- **Mini fixture:** `mini-start`, `-dialogue`, `-mobile` and `-win` (`.png`)
- **Frame metrics:** `lanternfall-perf.json`

## 9. Bundle and restore proof

**The bundle:**
- Location: `~/Desktop/Project DCSAI/_backups/dcs-games-b-3d-world-29sep2026/`
- It is incremental on top of `cd9856d`, so restoring it needs the `gb` history.
- Its SHA-256 is recorded next to it in a `.sha256` file.

**Restore procedure:**
1. Make a fresh `git clone` of `gb` and check out `cd9856d`.
2. `git fetch <bundle> games-b/3d-world-pipeline-28sep2026:restored`, then check out `restored`.

**Results after restore:**
- The HEAD and tree hashes are identical to the original worktree.
- `npm run test:gamesb` passes.
- `node src/gamesb/flagship/build.mjs` gives 0 errors and 0 warnings, and the playtest wins in 72.65 s of simulated time.

**A flake the first restore run caught:** one run of the texture timing test failed on a heavily loaded host (a 50 ms wall-clock gate). The gate now asserts at 3× the 50 ms budget, using the best of 5 runs, and it still reports the measured timings.
