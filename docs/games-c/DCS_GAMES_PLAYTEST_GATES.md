# DCS Games — GAMES-C playtest gates

Code: `src/v3/gamesc/qa/gates.mjs` (`runGates(manifest, opts)` → JSON report) and `src/v3/gamesc/qa/cli.mjs` (runs on an offline-assembled world or a `--manifest` file and prints the report, with exit 1 on FAIL). Tests: `test/gamesc-qa.test.mjs` (16 tests).

## Report contract

```
{ report_version:"1", world_id, manifest_hash:"sha256:…", started_at, finished_at,
  playtest_verdict, overall:"PASS"|"FAIL"|"INCOMPLETE", summary:{pass,fail,skipped,total},
  modules:{patch,memory,publish,companion,multiplayer: "loaded"|reason},
  gates:[{gate, status:"PASS"|"FAIL"|"SKIPPED", reason?, evidence:{…}, duration_ms}] }
```

- **SKIPPED is never PASS.** If any gate is skipped and none fails, `overall` is `INCOMPLETE`. This is tested.
- Sibling modules load via dynamic `import()` of `src/v3/gamesc/<area>/index.mjs`. An absent module, a failed import, or a module missing the function a gate needs each yields SKIPPED with the reason. All three cases are tested.
- A gate that throws is recorded as FAIL with the error. The runner itself never throws.

## Gates

| Gate | What | How | Threshold | Status (28 Sep) |
|---|---|---|---|---|
| launch | The world can boot | `validateManifest` + `guardManifest` (blocking findings) + a player spawn. In browser mode it also requires play-v3.html to boot (`window.__rt`, boot overlay hidden) | schema ok, guard ok, spawn present, booted | **PROVEN** headless. Browser boot measured 1.8 s (see below) |
| navigation | Spawn is not trapped and zones connect | `validators.validateNavigation` | no blocker/major finding | **PROVEN** |
| movement | The player can actually walk | `agent.simulatePlaythrough` (grid walk with the runtime's slope rule and solid footprints) | moves off spawn (≥2 cells) and coverage ≥ 0.05 (same as the critic) | **PROVEN** |
| collision | Solids collide and nothing spawns inside a wall | `validateStructure`/`validateNavigation` ids `asset_no_collision`, `spawn_inside_structure`, `structure_out_of_bounds`. Overlaps are reported as minor | zero such findings | **PROVEN** |
| objective_reachability | Every quest can be finished | `agent.simulateQuests` over the walk + `validateQuests` blockers | ≥1 quest, all completable | **PROVEN** |
| asset_load | Every asset can load | Headless: refs resolve, `checkAssetUrl` on glb/gltf URIs, primitive specs present, `checkAssetBudget` bomb limits. Browser: no failed or ≥400 requests (favicon and the anonymous companion 401 excepted) | zero problems | **PROVEN** headless and browser |
| fps | Runtime frame rate | Browser only: waits for ≥120 runtime frames, then reads `__rt.stats().frame_ms_avg` (the same metric and budget as `test/runtime-perf.test.mjs`: <50 ms), and also samples rAF | ≥ 20 fps | **SKIPPED by default** (needs `DCS_GAMESC_BROWSER_GATES=1`). One real run: **PASS at 24.4 fps** (runtime) / 18.5 fps (rAF) under headless swiftshader, which is marginal. See below |
| memory | JS heap after boot | Browser only: `performance.memory.usedJSHeapSize` | ≤ 512 MB | SKIPPED by default. Real run: **PASS, 10.8 MB** |
| console_errors | No runtime exceptions | Browser only: CDP `Runtime.exceptionThrown` + `console.error` | 0 | SKIPPED by default. Real run: **PASS, 0** |
| save_reload | Save, then reload, gives back the identical world | `memory.createWorldMemoryV2` (in-memory adapter, with patch hashing when present): save, idempotent re-save, `resume`, hash compare, `verifyIntegrity({deep})` | same hash, same version, idempotent | **PROVEN** against agent 2's module (SKIPPED if absent) |
| edit_retest | An edit applies, the world is re-playtested, and the edit undoes cleanly | Companion (when loaded): `interpret("make it stormy")` → `buildPatch`. Otherwise a fixed `patch.createPatch` weather `set`. Then → `validatePatch` → `applyPatch` → `critique` on the result → apply the inverse → hash equals the original (volatile fields stripped) → guard on the edited world | no verdict regression, clean inverse round-trip, guard ok, coverage ≥ threshold | **PROVEN** against agent 3's patch + agent 1's companion (`probe_source:"companion"`). SKIPPED if patch absent |
| publish_package | A playtested world packages | `publish.buildStagingPackage` with a throwaway ed25519 signer and the current critique verdict. The descriptor is also passed through `guardManifest` | build ok, descriptor guard ok | **PROVEN** against agent 5's module. A world that fails playtest FAILs this gate (tested) |
| reopen_published_preview | The staged package reopens and still plays | `createStagingRegistry` in a temp dir → `publishStaging` → `openPreview` + `current` → re-run the walk and quests on the reopened manifest | open ok, manifest hash matches, quests completable | **PROVEN** against agent 5's module. SKIPPED when no package was built |

## Evidence

- `node src/v3/gamesc/qa/cli.mjs` (offline, default) printed overall **INCOMPLETE**: 10 PASS, 0 FAIL, 3 SKIPPED (fps/memory/console_errors, browser disabled). patch, memory and publish loaded. companion loaded on the later run and now drives edit_retest. `multiplayer/index.mjs` failed to import (it wanted `hashManifest` from `publish/canonical.mjs`, which that file did not export at that moment). Neither is used by a gate.
- `DCS_GAMESC_BROWSER_GATES=1 DCS_SITE_DIR="<Desktop>/Project DCSAI/dcs-games-LIVE" node src/v3/gamesc/qa/cli.mjs` printed overall **PASS, 13/13**: boot 1.8 s, 24.4 fps (runtime frame_ms_avg 40.9 ms over 120 frames), heap 10.8 MB, 0 page/console errors, 0 failed requests.
  - The frontend was used **read-only**: served by `test/helpers/browser.mjs serveStatic`, Chrome ran with a temp profile, and nothing was written into the site dir. Files were checked with `ls -lO` first: not dataless.
  - The page loads three.js from cdnjs, so browser mode needs network. It makes no provider calls.
  - **The FPS result is marginal.** A first run that sampled rAF right after boot measured 15.1 fps and FAILed. The gate now waits for 120 frames and uses the runtime's own metric, as runtime-perf does. Swiftshader is software GL, and real GPUs are expected to be far faster. Treat FPS as "does not stall", not as a performance claim.

## Not covered (honest gaps)

- The browser gates only run where Chrome and the frontend checkout exist. CI has neither by default (see `test/helpers/site.mjs`), so in CI they are SKIPPED and the report is INCOMPLETE, never PASS.
- Movement and collision come from the manifest-level simulation (the same one the B4 critic uses), not from physics inside the browser runtime.
- No multiplayer gate: `multiplayer/index.mjs` exposes `worldMultiplayerStatus`, but no join or sync test exists in this lane.
- Only one companion utterance is probed (weather). The full edit-category coverage is agent 1's test suite.
