# Lanternfall — The Last Keeper of Ashfall Isle

This is the flagship vertical slice for the Games-B pipeline. The prompt goes through the real pipeline and comes out as a package that runs in the browser.

Only the concept is written by hand. The world, characters, assets, gameplay, scene graph and package come from the same stages a typed prompt goes through. Three small, deterministic *story patches* sit on top of them. They go through the pipeline's own `overrides` hook, so the validator and the headless playtest gate the patched game exactly as they gate any other build.

## Pitch

The player is a traveller who arrives by boat at Ashfall Harbour at stormy dusk.

- **The quest.** Keeper Maren, the island's last lighthouse keeper, asks the player to relight the three beacon lanterns before the storm makes landfall.
- **The companion.** Ember is a small fox made of amber light, and it follows the player everywhere.
- **The cores.** The lantern cores that feed the beacons are hidden in three places: the Sunken Ruins, the Whispering Grove shrine and the Cliffside Watch.
- **The danger.** Two Stormwisps, hovering blue storm spirits, patrol the ruins and sting anyone who comes near.
- **The finale.** Once the three beacons burn, the player climbs to the Great Lighthouse on the summit and lights it. The lamp flares, its beams begin to sweep, and the storm eases to rain.

The palette sets dusk ambers (`#e8913a`, `#ffd27a`) against storm blues (`#2f4a6d`, `#1f4b63`). The weather is `storm` and `time_of_day` is 0.78.

## Map (240 × 240 m, a 121² heightfield at 2 m per cell)

| Region | Kind | Centre (x, y, z) | What is there |
|---|---|---|---|
| Ashfall Harbour | hub | 138, 18, 117 | The player spawn, Keeper Maren, Fisher Tomas' stall, cottages, a well, lantern posts and the notice board |
| Sunken Ruins | ruin | 91, 4, 177 | Arches, walls and pillars at the waterline, the ruin beacon brazier, core 1 and both Stormwisps |
| Whispering Grove | grove | 71, 13, 114 | A pine ring, the shrine altar and core 2 |
| Cliffside Watch | tower | 112, 16, 96 | The watchtower, the watch beacon and core 3 |
| Great Lighthouse | summit | 146, 11, 77 | The striped lighthouse and its beacon brazier (the finale) |
| Old Dock | dock | 129, 7, 45 | A jetty, a boat and Tomas' tide chart (optional) |

The scene also holds 53 placements and 388 scattered instances: palms, pines, broadleaf trees, bushes, reeds, flowers and rocks. It uses 108 asset records, all procedural: mesh recipes, texture recipes, materials, SVG icons, the sky, the UI and an intro camera path.

## Quest chain (the required path)

1. **Speak with Keeper Maren** (`talk keeper_maren`). She reveals the four destinations.
2. **Recover the three lantern cores** (`collect item_1..3`, in any order). Each core is a pickup in its region.
3. **Relight the three beacons**: `activate ix_sunken_ruins`, `ix_whispering_grove` and `ix_cliffside_watch`. Each one requires its own core. Every beacon becomes a checkpoint, and a toast counts "n of 3 burning".
4. **Light the Great Lighthouse** (`activate ix_lighthouse_summit`). This requires all three beacons. It sets the weather to `rain`, and the game is won (`all_required_objectives`).

The optional content is: the Old Dock (reach it and read the tide chart), chatting with Ember and with Fisher Tomas, and the harbour notice board.

There are three ways to lose:

- health reaches zero with no lives left (3 lives, respawning at the last beacon);
- the player falls out of the world;
- the **storm timer** of 20 minutes runs out (`time_expired`). A warning fires at 15 minutes.

The Stormwisps are `sentinel` hazards at 10 HP/s. They become active once Maren has briefed the player.

## Characters

| id | Role | Kind / rig | Notes |
|---|---|---|---|
| `keeper_maren` | quest_giver | humanoid / biped | Hood and lantern. Carries the "!" quest marker until you talk to her. |
| `ember` | companion | creature / quadruped | Amber fox with a scarf. Has the `follow_player` behaviour and holds the companion hook's knowledge. |
| `fisher_tomas` | merchant | humanoid / biped | Satchel and hat, at the harbour. |
| `stormwisp_a`, `stormwisp_b` | enemy | spirit / hover | Blue-glowing, on 4-point patrol loops inside the Sunken Ruins. They chase within 14 m and are leashed at 30 m. |

## Authoring: the concept plus three story patches (`src/gamesb/flagship/lanternfall.mjs`)

- **`flagshipConcept()`, `FLAGSHIP_PROMPT`.** The authored GameConcept. It validates against `concept.schema.mjs` with no errors and no warnings.
- **`flagshipWorldPatch`.** Keeps exactly the three cores in the beacon regions. It turns the ruins' focal chest into a beacon brazier and re-blocks the nav cells under the wider collider, so the stale-nav gate stays green. It also moves both Stormwisp spawns into the ruins, and the character stage then derives their patrol loops there.
- **`flagshipCharactersPatch`.** Makes Ember a quadruped fox. The generic stage reads "spirit" and would otherwise build a hovering wisp. It also makes both Stormwisps hover spirits with a cold palette.
- **`flagshipGameplayPatch`.** Adds the 20-minute timer and `time_expired`. It makes the lighthouse require the three beacons, makes the dock finale optional, and writes the story-beat messages, including the finale's `set_weather: rain`.

To build the package, run `node src/gamesb/flagship/build.mjs` or call `buildFlagship({ outDir })`. It runs `buildGame(FLAGSHIP_PROMPT, { overrides, gameId: "lanternfall" })` offline with a fixed `createdAt`, and writes `games-b-runtime/games/lanternfall/package.json` (about 391 KB).

The build takes about 0.3 s. The last build reported: validation ok with 0 errors and 0 warnings; the headless playtest **won by walking** in 72.65 s of sim time, with save/reload proven; reachability ok.

## What the slice exercises

| Area | How |
|---|---|
| 3D world | Heightfield island with 4-layer splat terrain, animated water with shoreline foam, a sky dome with drifting storm clouds, fog, lightning, rain, and PCF soft shadows following the player. |
| Generated assets | Every mesh is a procedural parts recipe, merged per material and instanced per 64 m chunk. Every texture is synthesised in the page by `texture-synth.mjs`. Item icons are SVG records. |
| NPCs | Rigged characters animate procedurally from `NpcState.anim` using the rig's pivots, swing, axis and gait phases. Ember follows the player, the Stormwisps patrol and chase, and Maren turns to face you while talking. |
| Gameplay | The objectives, locks, checkpoints, sentinel hazards, timer, and win and lose conditions all run in `sim-core.mjs`, the same code the headless playtest drives. |
| Save/reload | F5 or the Save button writes `localStorage`. Load, F9, file download and file import are also available. The browser test saves, reloads the page, loads, and checks that position and inventory come back. |
| Edit and expand hooks | The package carries `hooks.edit.ops` (11 ops, from `hooks/edit.mjs`) and `hooks.expand.ops` (`add_region`). The companion hook names Ember with world knowledge. |
| Playtest | The pipeline's headless playtest has to win before the package is written. The browser test separately plays the chain to the Victory screen through the page hook. |
| Publish | `publishPackage(pkg)` runs the gates, then copies the runtime and its import closure. The browser test serves that bundle on its own and checks that it plays with no fallbacks and no 404s. |

## The browser runtime (`games-b-runtime/`)

The runtime is made of these files:

- **`play.html`** is the page shell. It loads three.js r147 from cdnjs as the global `THREE` and installs the error hook before anything else runs.
- **`main.mjs`** boots the game. It fetches the package, imports the isomorphic modules, runs a fixed-step accumulator at 1/60 s, and exposes the `window.__DCS_GAMES_B__` hook.
- **`renderer.mjs`** builds the scene:
  - terrain with an `onBeforeCompile` splat blend;
  - a water shader;
  - the sky dome and a PMREM of it for reflections;
  - lights: a hemisphere light, and a sun whose shadow frustum follows the player with texel snapping;
  - instanced chunks, and individual meshes for interactables;
  - a pool of 6 point lights for glowing things;
  - pickups that bob and glow, flames on lit beacons, and the lighthouse beam;
  - rain and lightning;
  - the third-person orbit camera, which collides with the terrain and with solid colliders.
- **`geometry.mjs`** turns each recipe part into geometry, one case per shape:
  - box, cylinder, cone, sphere, capsule, torus and lathe;
  - extrude, in both the `xz` and `xy` outline planes;
  - rock and icosphere, with position-keyed noise so the seams stay welded.

  It also handles per-part `scale`, and turns `color` tints into vertex colours. It has its own `mergeGeometries`, because the r147 global build ships no BufferGeometryUtils.
- **`materials.mjs`** builds a MeshStandardMaterial from each material record, with synthesised albedo, normal and roughness maps. It carries a small fallback generator for when texture-synth is absent.
- **`characters.mjs`** builds the rig from pivots and drives the procedural walk, idle, talk and hover animations. It also holds the built-in player avatar.
- **`hud.mjs`** draws the objective tracker with progress, the compass with an objective marker and distance, the minimap and region labels, and health, lives and level. It also draws the storm timer, the inventory with icons, the interaction prompt, toasts, the dialogue panel, the win/lose overlay and restart, the loading and error screens, and the F3 debug overlay.
- **`controls.mjs`** handles camera-relative WASD, Shift to run, Space to jump, E to interact and 1–4 for dialogue choices. Dragging the mouse orbits the camera and the wheel zooms. On touch screens there is a floating joystick plus orbit, Jump and E buttons.

If `sim-core` or one of its dependencies cannot load, the page still shows the world in a **view-only** mode with a free camera, and says so.

### Controls

- **Moving and looking:** WASD or the arrow keys move. Shift runs and Space jumps. Drag the mouse to look and use the wheel to zoom.
- **Interacting:** E interacts, and 1–4 pick a dialogue choice.
- **Saving:** F5 saves and F9 loads.
- **Overlays:** F3 shows the debug overlay and H toggles the help.
- **Touch:** use the left half of the screen as a joystick, drag the right half to look, and tap the E and Jump buttons.

### Running it locally

```sh
node src/gamesb/flagship/build.mjs          # writes games-b-runtime/games/lanternfall/package.json
python3 -m http.server 8000                 # from the worktree ROOT (the page imports ../src/gamesb/…)
open http://localhost:8000/games-b-runtime/play.html            # default ?pkg=./games/lanternfall/package.json
open "http://localhost:8000/games-b-runtime/play.html?pkg=/test/fixtures/gamesb/browser/mini.package.json"
```

The test hook is `window.__DCS_GAMES_B__`. It has everything in §10: `ready`, `pkg`, `sim`, `status()`, `input()`, `stepFrames(n)`, `teleport()`, `save()`, `load()`, `stats()` and `errors`. It also has some optional extras:

- `resume()`
- `benchmark(n)` and `lastBenchmark`
- `view({ yaw, pitch, dist })`
- `photo(from, at)`
- `camera()` and `scene()`
- `placementVisible(id)`, `dialogue()`, `nearest()` and `hud()`
- `renderer`, `mode`, `notes` and `warnings`

The hook's presses are rising-edge. `interact`, `jump` and `choice` reach sim-core within 2 steps, and the first `input()` or `stepFrames()` call switches the page to deterministic manual stepping.

## Tests

The test command is `node --test --test-concurrency=1 test/gamesb-browser*.test.mjs test/gamesb-flagship*.test.mjs`.

- **`test/gamesb-browser.test.mjs`** needs Chrome, running WebGL through SwiftShader. It serves the worktree root.
  - One test, which needs no Chrome, checks that the mini fixture validates and wins the headless playtest.
  - Four tests cover the page as a whole: the error screen for an invalid package; a mobile test that drives the touch joystick and checks the HUD fits; a publish test that plays a published bundle standalone; and, for each package, the frame-time benchmark.
  - The mini fixture and the flagship each run the same checks:
    - it reaches ready within 20 s with zero page, console or hook errors;
    - terrain, water and sky are present;
    - movement works and the camera follows;
    - walking into a solid box stops at its face;
    - talking opens the dialogue panel;
    - a pickup goes into the inventory and its mesh is hidden;
    - save, reload the page, then load restores position and inventory;
    - playing the chain shows the Victory overlay;
    - the timer running out shows the Defeat overlay, and restart resets.
- **`test/gamesb-flagship.test.mjs`** has 5 tests. They check that the concept validates, and that `buildFlagship` produces a package that validates, wins the headless playtest, keeps the story beats (3 cores → 3 beacons → lighthouse, Stormwisps inside the ruins, the timer, the hooks), and matches the committed copy.
- **`test/fixtures/gamesb/browser/make-mini.mjs`** regenerates `mini.package.json`, the small hand-authored package the runtime was developed against.

## Evidence (`docs/games-b/evidence/`)

These screenshots are written by the browser test:

- `lanternfall-dusk-overview.png`
- `lanternfall-harbour.png`
- `lanternfall-ruins.png`
- `lanternfall-lighthouse.png`
- `lanternfall-dialogue.png`
- `lanternfall-hud.png`
- `lanternfall-win.png`
- `lanternfall-lighthouse-lit.png` (the beacon lit and the beams sweeping)
- `lanternfall-defeat.png`

It also writes `mini-*.png` (including `mini-mobile.png`) and `lanternfall-perf.json`.

## Measured performance

These numbers are honest, but they come from **SwiftShader** — headless Chrome rendering on the CPU. Treat them as an upper bound on cost, not as frame rates a player would see.

| Package | Draw calls | Triangles | Textures | Frame p50 / p95 (300 frames) |
|---|---|---|---|---|
| Flagship | 258–270 | 167–168 k | 59 | 166 ms / 263 ms (≈ 6 fps on the CPU) at a normal host load; 269 ms / 637 ms with the host at a load average of about 340 |
| Mini fixture | 59 | 33 k | 22 | 84 ms / 118 ms (120 frames) at a normal host load; 550 ms / 938 ms under the same heavy load |

`lanternfall-perf.json` holds whichever run came last.

The budget checks are `draw_calls < 600` and `triangles < 1.5 M`. Frame time on a desktop GPU was **not measured**, since this environment has no GPU browser. The design target is 60 fps: pixel ratio of at most 1.5, instancing, shadows only near the player and at most 6 point lights.

The flagship becomes ready in about 5–9 s under SwiftShader. Most of that is texture synthesis, 46 texture recipes run in the page.

## Honest gaps

- **The flagship is patched.** The generic gameplay stage turns this concept into a 5-core chain with an Old Dock finale and no timer. The authored story needs the three patch functions above. The patches go through the pipeline's official override hook and are gated like any other build, but the generator does not produce this chain by itself.
- **The chain test teleports.** The browser test's chain driver teleports to each target and then interacts. Walking the chain is proven by the pipeline's headless playtest, not by the browser test.
- **Animation is simple.** It is procedural limb swing, with no skinning and no IK. Feet can slide on slopes.
- **The player has no package model.** The package has no player character mesh, so the runtime uses a built-in hooded lantern-bearer. That character is built from the same parts vocabulary and materials as the rest of the world.
- **Instancing is chunky.** Static placements are instanced per 64 m chunk. Scatter shadows are toggled per chunk, not per tree, so some off-screen chunks near the player still cast shadows.
- **Audio is not rendered.** `audio_emitter` nodes are ignored, and the intro `cine:intro` camera path is not played.
- **The storm key light is floored.** A storm sun is set as low as intensity 0.2 with shadows off. The renderer floors the sun at 0.55 and keeps shadows on, so forms still read. It also cools the fog, sky and ambient towards the palette's storm blue. These are renderer choices, not package data.
- **Concurrent runs can kill each other's Chrome.** `test/helpers/browser.mjs` reaps any harness Chrome older than 2 minutes whenever another run launches one, so concurrent browser test runs can kill each other's Chrome. The suite launches a fresh browser for each package to shrink that window, but it cannot close it.
- **The publish bundle includes every game.** `publishPackage` copies all of `games-b-runtime/`, which includes `games/lanternfall/package.json` and `tools/`, even when it publishes a different game.
