# DCS Games local fallback: sample report

Generated 2026-09-29T21:03:20.410Z by `node tools/gamesd-bench.mjs --gpu` in 485 s on games-d/local-fallback-29sep2026 @ c1a23e0 (61 uncommitted paths). Zero paid APIs: every build ran with `DCS_PROVIDERS_OFFLINE=1` through `buildFromRecipe()`.

Recipes: src/gamesd/samples/catalogue.mjs. Preset matrix: see `DCS_GAMES_PROCEDURAL_PRESET_MATRIX.csv`. Raw data: `evidence/bench.json`.

## Totals

| metric | value |
|---|---|
| SAMPLES_CREATED | 18 |
| SAMPLES_ATTEMPTED | 18 |
| SAMPLES_PLAYABLE | 18 |
| WORLD_VARIANTS | 18 |
| GAMEPLAY_VARIANTS | 17 |
| AVG_FPS | 59.71 |
| AVG_FPS_RENDERER | ANGLE (Apple, ANGLE Metal Renderer: Apple M4 Pro, Unspecified Version) |
| PERF_VERIFIED_ON_GPU | 18/18 |
| CPU_WORST_CASE_AVG_FPS | 5.82 |
| CPU_WORST_CASE_RENDERER | ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (LLVM 10.0.0) (0x0000C0DE)), SwiftShader driver) |
| SAVE_RELOAD_PASS | 18/18 |
| SAVE_RELOAD_BROWSER_PASS | 18/18 |
| DETERMINISTIC_REBUILD | 18/18 |
| WON_HEADLESS | 18/18 |
| BROWSER_LAUNCH_OK | 18/18 |
| BUDGET_OK | 18/18 |
| INSIDE_SOLID_SAMPLES | 0 |
| SAMPLES_NEEDING_UNSTUCK | 0 |
| MIN_PAIRWISE_VISUAL_DISTANCE | 0.241 |
| MEAN_PAIRWISE_VISUAL_DISTANCE | 0.481 |
| NEAR_DUPLICATE_PAIRS | 0 |

**AVG_FPS renderer:** ANGLE (Apple, ANGLE Metal Renderer: Apple M4 Pro, Unspecified Version). AVG_FPS is the only frame rate that can make a sample playable or not (PERF_BUDGET floor: 20/15/12 fps small/medium/large, p95 ≤ 80/100/120 ms). CPU_WORST_CASE_AVG_FPS is SwiftShader (software WebGL in headless Chrome): advisory only, compared with CPU_PERF_BUDGET for regression detection.

Headless Chrome paces requestAnimationFrame to a 60 Hz display, so a GPU figure near 60 fps is the vsync cap, not the renderer's limit.

Host: darwin arm64, 14 cores, load average 11 before and 23 after the browser passes.

**The host was overloaded** (load per core above 1.5): SwiftShader wall-clock numbers measure the machine's queue as much as the game, so they are reported but were not compared with CPU_PERF_BUDGET. Hardware-GL numbers were still gated.

## Per-sample results

| game_id | theme | template | layout | diff | light | scale | playable | won | obj | sim s | stuck | unstuck | falls | in-solid | save H/B | det | fps (GPU) | p95 ms | cpu_worst_case fps | draws | tris | load ms | build ms | budget |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| fb_storm_isle_classic_chain_normal_101 | storm_isle | classic_chain | classic | normal | storm_dark | medium | yes | yes | 10/10 | 118.2 | 0 | 0 | 0 | 0/6293 | yes/yes | yes | 60 | 16.7 | 4.37 | 190 | 168222 | 1168 | 347 | ok |
| fb_tropical_cove_relic_hunt_easy_202 | tropical_cove | relic_hunt | archipelago_hop | easy | golden_hour | large | yes | yes | 5/5 | 76.8 | 1 | 0 | 0 | 0/3828 | yes/yes | yes | 59.5 | 16.8 | 4.78 | 330 | 295570 | 1018 | 263 | ok |
| fb_pine_valley_grand_tour_easy_303 | pine_valley | grand_tour | grand_loop | easy | dawn | large | yes | yes | 6/6 | 83.1 | 0 | 0 | 0 | 0/3647 | yes/yes | yes | 60 | 16.7 | 4.76 | 456 | 325440 | 1070 | 345 | ok |
| fb_swamp_fen_hunt_hard_404 | swamp_fen | hunt | outpost_cluster | hard | overcast | small | yes | yes | 6/6 | 27.9 | 0 | 0 | 0 | 0/1313 | yes/yes | yes | 60 | 16.7 | 6.77 | 208 | 139031 | 1243 | 116 | ok |
| fb_dune_sea_courier_run_normal_505 | dune_sea | courier_run | gauntlet | normal | noon | medium | yes | yes | 10/10 | 109.0 | 0 | 0 | 0 | 0/4472 | yes/yes | yes | 59.5 | 16.7 | 6.72 | 185 | 76358 | 951 | 396 | ok |
| fb_oasis_flats_timed_rush_easy_606 | oasis_flats | timed_rush | compact_trail | easy | golden_hour | small | yes | yes | 4/4 | 22.1 | 0 | 0 | 0 | 0/873 | yes/yes | yes | 57.8 | 16.8 | 5.02 | 153 | 77856 | 894 | 74 | ok |
| fb_frost_peaks_beacon_circuit_normal_707 | frost_peaks | beacon_circuit | hub_spoke | normal | night | medium | yes | yes | 6/6 | 105.4 | 5 | 0 | 0 | 0/5371 | yes/yes | yes | 60 | 16.7 | 6.97 | 250 | 102462 | 881 | 340 | ok |
| fb_glacier_steps_lock_and_key_hard_808 | glacier_steps | lock_and_key | gauntlet | hard | dawn | medium | yes | yes | 8/8 | 45.6 | 0 | 0 | 0 | 0/2362 | yes/yes | yes | 59.5 | 16.7 | 5.37 | 230 | 79946 | 1248 | 189 | ok |
| fb_ember_caldera_last_stand_normal_909 | ember_caldera | last_stand | outpost_cluster | normal | dusk | small | yes | yes | 4/4 | 45.5 | 0 | 0 | 0 | 0/3088 | yes/yes | yes | 60 | 16.7 | 5.85 | 142 | 89156 | 929 | 100 | ok |
| fb_obsidian_mesa_stealth_infiltration_hard_1010 | obsidian_mesa | stealth_infiltration | hub_spoke | hard | night | medium | yes | yes | 8/8 | 48.4 | 0 | 0 | 0 | 0/2181 | yes/yes | yes | 60 | 16.8 | 6.67 | 198 | 85364 | 1173 | 241 | ok |
| fb_red_canyon_timed_rush_hard_1111 | red_canyon | timed_rush | gauntlet | hard | golden_hour | medium | yes | yes | 5/5 | 24.1 | 0 | 0 | 0 | 0/1665 | yes/yes | yes | 60 | 16.8 | 5.25 | 203 | 104978 | 1021 | 79 | ok |
| fb_sandstone_steps_relic_hunt_normal_1212 | sandstone_steps | relic_hunt | compact_trail | normal | noon | small | yes | yes | 3/3 | 38.5 | 0 | 0 | 0 | 0/1526 | yes/yes | yes | 60 | 16.8 | 7.50 | 133 | 54798 | 1037 | 106 | ok |
| fb_sunken_ruins_lock_and_key_normal_1313 | sunken_ruins | lock_and_key | hub_spoke | normal | overcast | medium | yes | yes | 10/10 | 130.0 | 0 | 0 | 0 | 0/5096 | yes/yes | yes | 59.8 | 16.8 | 5.06 | 260 | 159417 | 1120 | 411 | ok |
| fb_overgrown_temple_beacon_circuit_easy_1414 | overgrown_temple | beacon_circuit | grand_loop | easy | dusk | large | yes | yes | 5/5 | 72.0 | 0 | 0 | 0 | 0/2524 | yes/yes | yes | 60 | 16.8 | 3.81 | 379 | 373529 | 1206 | 276 | ok |
| fb_fog_city_stealth_infiltration_normal_1515 | fog_city | stealth_infiltration | outpost_cluster | normal | neon_night | small | yes | yes | 7/7 | 52.3 | 0 | 0 | 0 | 0/1569 | yes/yes | yes | 59.3 | 16.8 | 6.05 | 142 | 89430 | 1070 | 139 | ok |
| fb_hillside_town_grand_tour_easy_1616 | hillside_town | grand_tour | classic | easy | noon | medium | yes | yes | 5/5 | 85.6 | 0 | 0 | 0 | 0/1218 | yes/yes | yes | 59.8 | 16.8 | 6.77 | 231 | 125737 | 877 | 253 | ok |
| fb_orbital_base_last_stand_hard_1717 | orbital_base | last_stand | compact_trail | hard | neon_night | small | yes | yes | 4/4 | 66.3 | 4 | 0 | 0 | 0/3721 | yes/yes | yes | 60 | 16.7 | 7.69 | 118 | 39814 | 1016 | 116 | ok |
| fb_crystal_hollow_hunt_normal_1818 | crystal_hollow | hunt | grand_loop | normal | night | large | yes | yes | 5/5 | 65.7 | 0 | 0 | 0 | 0/2959 | yes/yes | yes | 59.8 | 16.8 | 5.41 | 223 | 153018 | 994 | 268 | ok |

Columns: *obj* required objectives done by the headless playtest agent; *in-solid* steps the player ended inside a solid collider / steps with a collider nearby (collision probe); *save H/B* headless / browser save-reload (every browser pass that ran); *det* a second build of the same recipe has the same `integrity.sha256`; *fps (GPU)*, *p95 ms* real `requestAnimationFrame` rendering on hardware GL while the player walks; *cpu_worst_case fps* the same on SwiftShader (advisory); *load ms* page navigation to runtime ready (GPU pass, else CPU pass).

## Samples that are not playable

None: every sample met every measured criterion.

## Variety

- 18 samples, 153 pairs compared on the visual signature (palette and sky/fog colours in CIE Lab, lighting, terrain height histograms and relief, scatter and placement asset mix, placement footprint, biome/shape/weather/material labels, and a 64-bin colour histogram of a real rendered frame); distance is 0 (identical) to 1.
- Minimum pairwise distance **0.241** (fb_dune_sea_courier_run_normal_505 vs fb_sandstone_steps_relic_hunt_normal_1212); mean **0.481**.
- Near-duplicate threshold 0.08: no pair is below it, so no two samples look alike by this measure.
- World variants (distinct theme × biome × terrain shape × lighting): **18**. Gameplay variants (distinct required-objective kind sequences): **17**.
- Distinct: themes 18, biomes 9, terrain_shapes 9, lightings 8, weathers 6, material_styles 18, templates 10, objective_sequences 17, objective_kinds 8.

## Browser performance

- **GPU (ANGLE (Apple, ANGLE Metal Renderer: Apple M4 Pro, Unspecified Version))**: FPS min 57.76, avg 59.71, max 60; average p50 16.7 ms, p95 16.8 ms; average load 1051 ms; draw calls avg 224 / max 456; max triangles 373529.
- **cpu_worst_case (ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (LLVM 10.0.0) (0x0000C0DE)), SwiftShader driver)), advisory**: FPS min 3.81, avg 5.82, max 7.69; average p50 171.3 ms, p95 246.3 ms; average load 5844 ms; draw calls avg 241 / max 456; max triangles 350697.

## Metric definitions

- **playable** = headless launch ok, every browser pass that ran launched and played without errors, headless playtest won, save/reload ok headless and in every browser pass, rebuild byte-identical, within budget (`src/gamesd/budgets.mjs`: assets, draw calls, triangles, build time, and — only from a hardware-GL pass — FPS, p95 frame time and load time), no player step inside a solid, and no errors.
- **launch**: headless = the package validated and `createSim` started; browser = `play.html` reached `ready` in play mode with no page, hook or console errors. The page's WebGL renderer string is recorded for every pass.
- **objective completion**: the Games-B headless playtest agent (walks, never teleports) against the required objectives.
- **collision**: the playtest is re-run with `resolveCapsule` observed; every settled player position with a collider nearby is checked against the solid colliders (XZ containment plus vertical overlap). *stuck* is the agent's stuck recoveries, *falls* the sim's fall-outs.
- **save/reload**: headless = snapshot → restore → identical snapshot and identical continuation (the playtest's midpoint save, or a fresh sim after 3 s when there are too few objectives); browser = `save()` → walk at least 0.5 m away → `load()` from localStorage → position within 0.25 m and re-saved snapshot equal apart from `saved_at`.
- **fps**: frames per second of real rAF rendering over at least 4 s and 12 frames (capped at 45 s) while W is held; p50/p95 frame intervals from the same frames. GPU pass: headless Chrome with ANGLE/Metal hardware GL; CPU pass: SwiftShader.
- **variety**: see *Variety*; world and gameplay variants are counts of distinct label tuples.
