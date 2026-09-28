# DCS Games: local fallback engine (Games-D)

**Status (29 Sep 2026):** ready to use as the zero-API fallback. The engine builds a playable 3D game with no provider key and no API call.

- **Branch:** `games-d/local-fallback-29sep2026` in `~/Developer/dcs-games-d-fallback`, based on Games-B `29448c1`.
- **Evidence:**
  - [`DCS_GAMES_LOCAL_SAMPLE_REPORT.md`](DCS_GAMES_LOCAL_SAMPLE_REPORT.md): 18 samples.
  - [`DCS_GAMES_PROCEDURAL_PRESET_MATRIX.csv`](DCS_GAMES_PROCEDURAL_PRESET_MATRIX.csv): 93 presets.
  - `evidence/bench.json` and the screenshots in `evidence/`.

## 1. What it does

When every AI provider is unavailable, DCS Games can still produce a decent, finishable game.

1. **Input.** Free text goes through `recipeFromPrompt(text)` (`src/gamesd/recipe.mjs`), which maps it to a **recipe** using keyword scoring:
   `{ seed, theme, template, layout, difficulty, lighting, scale }`.
2. **Build.** `buildFromRecipe(recipe)` (`src/gamesd/engine.mjs`) runs the normal Games-B pipeline with `DCS_PROVIDERS_OFFLINE=1`. Each recipe module supplies Games-B `overrides`. Games-B is not forked, so every fallback game passes the same checks as a provider-backed game: the validators, the objective-reachability check, and a headless playtest that must win and must round-trip save/reload.
3. **Output.** A standard `GamePackage` that the existing browser runtime (`games-b-runtime/play.html?pkg=…`) plays unchanged. The package may also carry an optional procedural audio block.

**Determinism.** The same recipe always gives the same sha256. `createdAt` is pinned, provenance `at`/`latency_ms` are pinned under `createdAt` (this was broken in Games-B), and all randomness is seeded. The recipe is stored in `concept.fallback_recipe`, so any package can be rebuilt from its recipe.

## 2. The six areas (one agent each)

| Area | Module | What it provides |
|---|---|---|
| World and terrain | `src/gamesd/world/themes.mjs`, `src/gamesb/world/terrain.mjs` | 18 themes, two per biome for all 9 biomes. 9 terrain shapes, 5 of them new: archipelago, caldera, terraces, dunes, marsh. Scatter density and mix are set per theme and kept within budget. |
| Gameplay and objectives | `src/gamesd/gameplay/templates.mjs` | 10 templates: classic_chain, beacon_circuit, relic_hunt, courier_run, stealth_infiltration, hunt, last_stand, timed_rush, lock_and_key, grand_tour. If a world can't support a template, it drops to a simpler one that is always valid. |
| NPCs and enemies | `src/gamesd/npc/behaviours.mjs`, `characters/npc-brain.mjs` | 9 archetypes (sentinel patrol, guard post, stalker, swarm, wanderer, skittish critter, companion, vendor, quest giver). The roster scales with difficulty. Fairness rules: keep-out discs, at least 18 m from the player spawn at the start, and chase timeouts. |
| Textures and materials | `src/gamesd/materials/material-styles.mjs`, `assets/materials.mjs`, `assets/texture-synth.mjs` | A material style per theme, 19 in all. New deterministic, tileable texture effects: moss, cracks, rust, wear, frost, wet, grime and tint. |
| Lighting and sound | `src/gamesd/world/lighting.mjs`, `src/gamesd/audio/sfx.mjs`, `games-b-runtime/audio.mjs` | 8 lighting presets; night stays readable. Procedural WebAudio with no audio files: a sound bed per theme, 9 event cues and placed emitters, plus a mute toggle (M). |
| Missions and level variety | `src/gamesd/missions/layouts.mjs`, `samples/catalogue.mjs`, `samples/matrix.mjs` | 7 layouts: linear, star, loop, chain and cluster orderings, with measurably different geometry. An 18-recipe sample catalogue and the preset matrix. |
| Quality, performance and playtest | `src/gamesd/quality/*`, `tools/gamesd-bench.mjs`, `src/gamesd/budgets.mjs` | Scores launch, objective completion, collision (inside-solid probe), FPS, save/reload (headless and browser), visual signature and variety, deterministic rebuild, and budgets. |

**Replayable recipes.** A recipe combines 18 themes × 10 templates × 7 layouts × 3 difficulties × 8 lightings × any seed. `compatibility(recipe)` explains any combination it rejects or warns about.

## 3. Budgets

Budgets live in `src/gamesd/budgets.mjs` and are set per scale (small / medium / large).

- **Assets:**
  - package size: 450 / 650 / 900 KB
  - asset records: 160 / 200 / 240
  - placements: 70 / 90 / 120
  - scatter instances: 900 / 1400 / 2000
  - characters: 8 / 10 / 12
  - textures: 256 px or smaller
- **Performance on a GPU (gates playability):**
  - at least 20 / 15 / 12 fps
  - frame-time p95 under 80 / 100 / 120 ms
  - under 450 / 550 / 650 draw calls
  - under 0.9 / 1.2 / 1.6 M triangles
- **Performance on the CPU-only renderer (SwiftShader):** advisory only, used to detect regressions. It never gates playability.

## 4. Results (final bench, `node tools/gamesd-bench.mjs --gpu`, run at fc0cb25)

- **Samples:** 18 built, 18 playable, all 18 won headless, all 18 rebuilt with an identical sha256.
- **Save/reload:** passed 18/18 headless and 18/18 in the browser.
- **Budgets:** all 18 within budget.
- **Collision:** 0 inside-solid samples.
- **Unstuck:** 0 samples needed a checkpoint respawn.
- **FPS on the Apple M4 Pro (ANGLE Metal):** average 59.99, capped by 60 Hz vsync. Frame-time p95 16.7 ms, load about 1.0 s, at most 456 draw calls and 374k triangles.
- **FPS on SwiftShader, CPU only (worst case):** average 8.93 (5.5–12.1).
- **Variety:**
  - 18 world variants (18 themes, 9 biomes, 9 shapes, 8 lightings).
  - 17 distinct gameplay sequences from 10 templates.
  - Visual distance between samples: minimum 0.242, mean 0.481.
  - 0 near-duplicate pairs (the threshold is a distance below 0.08).
- **Wider sweep:** 342 of 342 builds were `ok`. The sweep covered every theme × layout on seeds 3 and 4, plus every template × difficulty on 3 seeds. One build (red_canyon / outpost_cluster / seed 4) needed the unstuck action twice.

## 5. Games-B bugs found and fixed on this branch

Regression tests for these are in `test/gamesd-gamesb-fixes.test.mjs`.

1. **Rebuilds were not byte-identical.** Provenance recorded wall-clock `at` and `latency_ms` values even with `createdAt` set. They are now pinned, and the Lanternfall flagship rebuilds byte-identically (sha256 `9f51568a…`, with the same content as before).
2. **Hazard damage was multiplied by `damage_mult` twice** (in sim-core and again in the rules engine), so hard did 2.56× damage instead of 1.6×. It is now applied once, in the rules engine.
3. **Containers could only be used once.** Opening a container early made an objective that targeted it impossible to finish. An opened container now stays usable (it still grants its item only once) and stays visible.
4. **The reachability check gave false negatives.** It only tested the single nearest cell, which could be a sealed pocket. It now accepts any connected cell within reach and within the sim's 4 m height window. Village sites work again as a result.
5. **Ledges were treated as reachable.** World connectivity accepted a spot at the foot of a cliff as a way to reach a mesa-top interactable. It now requires a matching height.
6. **The headless playtest agent** (the automated player) got stuck in several ways. It now:
   - approaches targets from cells that are connected and at a matching height;
   - keeps its own record of cells it keeps failing to enter and plans around them;
   - routes back to the spawn's walkable area when its path breaks;
   - no longer steers away from a second hunt target standing next to the first;
   - uses the new unstuck action only when truly trapped, and reports how often.
7. **Walkable cells on cliff rims led players into pits.** A new opt-in nav **edge guard** (`bakeNavigation({ edgeGuard })`) removes cells whose step to a neighbour is steeper than the slope limit. Games-D turns it on; plain Games-B worlds are unchanged.
8. **Players had no way out of a pit.** New add-only `input.unstuck` (the **R** key, "back to checkpoint") returns the player to the last checkpoint and leaves game state untouched.

## 6. Known limits

- **Three.js comes from the public cdnjs CDN.** It is a free static file, not an API, but a fully offline install needs a vendored copy.
- **Unstuck is rare but still happens.** In the 342-build sweep, 1 world needed it. The bench reports `SAMPLES_NEEDING_UNSTUCK` so this is tracked.
- **GPU FPS hits the 60 Hz vsync cap.** The figure shows the floor is cleared with a wide margin, not how much headroom there is.
- **The `escort` objective kind is not realised by the sim,** so no template uses it.
- **No vision cones.** NPC line of sight uses nav walkability.

## 7. How to run

```sh
npm run test:gamesd          # Games-D suites plus the Games-B fix regressions
npm run test:gamesb          # Games-B suite (190)
node tools/gamesd-bench.mjs --gpu        # rebuilds the samples and rewrites the docs in docs/games-d/
node -e 'import("./src/gamesd/engine.mjs").then(m => m.buildFromRecipe({ seed: 7, theme: "frost_peaks", template: "hunt", layout: "hub_spoke", difficulty: "hard" })).then(r => console.log(r.ok, r.pkg.game_id))'
```

Play a sample at `games-b-runtime/play.html?pkg=games/fallback/<game_id>/package.json`.
