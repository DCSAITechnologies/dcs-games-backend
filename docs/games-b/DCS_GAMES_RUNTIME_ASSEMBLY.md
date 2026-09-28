# DCS Games-B: runtime assembly and validation

This document covers the half of the Games-B pipeline that turns stage outputs into a game you can actually play, and the gates that prove it. The binding shapes are in `src/gamesb/CONTRACT.md`, and this document does not restate them.

| Area | Files |
|---|---|
| Runtime | `src/gamesb/runtime/{sim-core,deps,assemble,validate-package,headless-playtest,to-manifest-v3}.mjs` |
| Pipeline | `src/gamesb/pipeline.mjs` |
| Hooks | `src/gamesb/hooks/{edit,expand,publish}.mjs` |
| CLI | `scripts/gamesb-build.mjs` |

## 1. Pipeline (`buildGame(prompt, { seed, env, gameId, cache, createdAt, overrides, playtest, deps })`)

| # | stage | module | notes |
|---|---|---|---|
| 1 | concept | `concept/concept.mjs` | `overrides.concept` as an object replaces generation, for flagship authoring. As a function it patches the result. |
| 2 | world | `world/world-spec.mjs` | deterministic |
| 3 | characters | `characters/characters.mjs` | deterministic |
| 4 | gameplay | `gameplay/generate.mjs` | **Runs before assets on purpose (§4.5 lists it after).** Gameplay reads only concept, world and characters. `resolveAssets` accepts the optional `gameplay`, which it uses to emit an `icon:<item_id>` per item. |
| 5 | assets | `assets/asset-pipeline.mjs` | `clock` is pinned to `createdAt` when one is given |
| 6 | scene | `world/scene-graph.mjs` | |
| 7 | assemble | `runtime/assemble.mjs` | §7 package, `hooks`, companion pick, `integrity.sha256 = sha256(canonicalJson(pkg without integrity))` |
| 8 | validate | `runtime/validate-package.mjs` | see §4 |
| 9 | playtest | `runtime/headless-playtest.mjs` | Covers reachability, the autonomous run, and save/reload |

- **Timing and provenance.** Every stage is timed in `timings` and records a ProvenanceStage.
- **The `ok` result.** It is `validation.ok && reachability.ok && playtest.won && save_reload.ok`.
- **Stage patching.** `overrides.<stage>` functions patch a stage's output, and every stage after it sees the patched value.
- **Writing.** `writePackage(pkg, file)` writes compact JSON. `readPackage(file)` reads it back.
- **CLI.** Run `node scripts/gamesb-build.mjs --prompt "…" --out dir [--seed n] [--game-id id] [--offline] [--publish]`.
  - It writes `game.package.json` and `BUILD_REPORT.json`, and with `--publish` it also writes `site/`.
  - It exits 1 when any gate fails.
  - It never prints env values.

## 2. Package

The package follows §7 exactly. `hooks.edit.ops` lists the 11 edit ops. `hooks.expand = { ops: ["add_region"], history? }`, where `history` is an **optional addition**. `hooks.companion` is the first `companion` character, falling back to the first quest giver.

## 3. sim-core (ISOMORPHIC, fixed step 1/60 s)

- **No static imports of other stages.** Deps are injected as `{ terrain, collision, nav, rules, npcBrain, dialogue, expandScatter }`.
  - `runtime/deps.mjs` imports the real modules, exports `realDeps` and calls `registerDefaultDeps`, so `createSim(pkg)` works once deps.mjs has been imported.
  - The browser runtime imports both.
  - If a dep is missing, the error names it.
- **Player.** Horizontal velocity chases the wish velocity (accel 42 m/s² and decel 55 m/s², scaled by `air_control` in the air). `run_speed` applies while `run` is held.
  - Jumping triggers on the press edge, then gravity applies.
  - The player lands on `sampleHeight` and snaps down to follow downhill ground.
  - `fall_damage` applies above an impact speed of 14 m/s.
- **Slope limit.** An uphill XZ step with rise/run > tan(`max_slope_deg`) is refused per axis, so the player slides along the face.
- **Collision.** Colliders are built once and bucketed on a 16 m grid. `resolveCapsule` only sees nearby colliders, and collision is XZ only.
- **Out of world.** Water deeper than `level − 1.2`, or `y < rules.fall_y`, produces a `fell_out` event and a respawn at the checkpoint or `spawn_player`.
- **Regions.** The smallest containing region wins. `enter_region` fires on each transition.
  - The rules engine completes `reach` only on an event seen while the objective is active. The sim therefore re-announces the current region when a reach objective targeting it becomes active.
- **Interaction.** Interaction is edge-triggered. The target is the nearest usable interactable within `max(ix.radius, gameplay.interaction.radius)`, and talk interactables follow their NPC.
  - **Locks.** If `locked_by` names an item the player does not hold, the player gets a message plus a `locked` event.
  - **Pickups and containers.** They produce `interact` + `pickup`, then are marked collected and hidden.
  - **Talk.** Talking opens the dialogue and sends `talk`. Movement is rooted while the dialogue is open.
  - **Dialogue choices.** `input.choice` indexes the **visible** choices.
  - **Dialogue actions.** Actions are applied through the rules engine where an event exists (`give_item` becomes `pickup`, `damage` becomes `damage`, `set_npc_state` becomes `npc_state`). Otherwise they are applied to GameState directly (`remove_item`, `heal`, `set_flag`, `set_weather`, `set_time`, `message`).
  - **Deliver.** `deliver` is sent when the target is the target of an active deliver objective.
  - **Melee.** Melee `defeat` is sent only when `combat.mode === "melee"`.
- **Hazards.**
  - `sentinel`: damage within 3 m of its NPC once `active_after` is done.
  - `storm_zone` and `fire`: damage while in their region.
  - Damage is scaled by `difficulty.damage_mult` and emitted in whole points.
- **Rules effects.**
  - `set_npc_state`, `reveal` and `unlock` are realised as marks.
  - `respawn` and `checkpoint` are realised by moving the player or setting the checkpoint.
  - `win` and `lose` are realised as `status`.
  - A decrease in lives always respawns the player.
  - Start-of-game effects are drained by a zero tick in `createSim`.
- **NPCs.** NPCs are stepped every frame with `ctx = { player, heightAt, isBlocked (nav ∪ solid colliders), findPath, rand (seeded, serialised), talking }`.
- **Events.** `stepSim` returns every event except the tick. The kinds are:
  - rules events: `enter_region`, `interact`, `talk`, `pickup`, `deliver`, `defeat`, `damage`, `fell_out`
  - simulation events: `objective_done`, `effect`, `message`, `locked`, `dialogue_choice`, `jump`, `land`, `slope_blocked`, `status`
- **Save.** `snapshot(sim, {now?})` returns a §9 SaveState plus an **optional `runtime` block**: step, velocity, grounded, status, region, RNG state, damage accumulator, input latches, open dialogue, revealed, defeated, stats, and full NpcState.
  - `restoreSim` refuses a save from another `game_id` or another package sha256.
- **Extra exports.** `SIM_DT`, `SAVE_VERSION`, `registerDefaultDeps`, `nearestInteractable`, `currentDialogue`, `interactablePosition`, `applyActions`, `teleport`.

## 4. Validation gates (`validatePackage(pkg, { budgets })`)

`validatePackage` returns `{ ok, package_sha256, errors, warnings, budgets, checks, skipped, module_errors }`.

**Stage validators.** These are loaded if present: `validateWorldSpec(world, {concept})`, `validateSceneGraph`, `validateAssetSet`, `validateGameplay(gameplay, ctx)`, `validateCharacters` and `validateDialogues`. A missing validator produces a warning and is listed in `skipped`. It never silently passes.

**Cross-checks.** These always run:

1. **Shape.** `package_version` is correct, `game_id` is set, `version` is an integer ≥ 1, and all sections are present.
2. **Integrity.** The sha256 matches the recomputed canonical hash.
3. **Asset refs.** Every one of these must resolve to a record by `ref` or `asset_id`:
   - scene node `asset_ref`s
   - placement and scatter refs
   - terrain material layers
   - character meshes
   - item icons
   - mesh-part materials
   - material texture ids

   A mesh recipe with no parts is an error. An unknown licence is a warning.
4. **World refs.**
   - There is a player spawn.
   - Every non-talk interactable sits on an existing placement, and every talk interactable follows an existing character.
   - `item_ref` and `locked_by` name items.
   - Placement regions exist, and character spawns exist.
   - Scene parents and interactable, placement, character and spawn refs resolve.
5. **Broken scripts.**
   - Trigger, action and condition kinds must be known. The rules engine's exported vocabulary is used, with the §5 lists as a fallback.
   - Every action ref must exist:
     - `give_item`/`remove_item` name an item.
     - `set_npc_state` names a character and a known state.
     - `checkpoint` names a spawn.
     - `unlock`/`reveal` name any id.
     - `set_weather` uses the weather enum, and `set_time` is in [0,1].
   - Trigger refs resolve, dialogue `next` and entry nodes resolve, and objective targets, `requires`, rewards, hazard refs and checkpoint spawns resolve.
   - The `requires` graph is acyclic.
6. **Budgets (static estimate).**
   - **Triangles:** `estimateTriangles` (from `assets/mesh-recipes.mjs`, or a fallback) × instances, plus terrain and sky. Limit 1.5 M.
   - **Draw calls:** one per material per placement, per scatter entry (instanced) and per character, plus terrain, water and sky. Limit 600.
   - **Texture memory:** size² × 4 B × 3 maps × 4/3 for mips, plus PNGs. Limit 96 MB.

**Headless gates**, run by the pipeline and by publish:

- **Reachability.** `checkObjectiveReachability`: for every objective target, a walkable cell within interaction range is connected to the spawn.
- **Playtest.** `headlessPlaytest` must return `won`.
- **Save/reload.** It must be ok.

## 5. Headless playtest

`headlessPlaytest(pkg, { deps, maxSimSeconds = 1800, saveReloadAt = 0.5 })` drives `stepSim` only through inputs.

- **Objective order.** The order comes from `gameplay/solver.mjs` `solveGameplay(g, { locks: locksFromWorld(world) })` when available. Otherwise the agent takes the nearest active required objective.
- **Goals.** Each objective resolves to a goal:
  - an interactable to use
  - a region cell to reach
  - an NPC to talk to or defeat
  - a wait (survive)

  Locked interactables recurse to fetching their key. Deliver goals fetch the objective's `item_ref` first.
- **Movement.** The agent paths with `findPath` to the nearest walkable cell, follows waypoints with the target itself as the last one, and presses interact on the edge.
- **Dialogue.** It takes the first visible choice that leads to an unseen node, or else one that ends the conversation. A stricter "always choice 0" rule looped forever on generated dialogues.
- **Hazards.** It steers away from hostile NPCs that are not its target.
- **Stuck recovery.** If it covers less than 0.35 m in 1 s, it sidesteps and jumps for 0.6 s, then re-paths.
- **Save/reload.** At `ceil(required × saveReloadAt)` done objectives the playtest runs the save/reload check:
  - Snapshot the sim.
  - Restore into a fresh sim and require an identical canonical snapshot.
  - Restore two more copies and step both 180 frames with the same scripted inputs. Their snapshots must be identical.
  - The agent then continues on the restored sim.
- **Stopping.** It stops on a terminal status, when `maxSimSeconds` is reached, or after 600 s with no objective progress.
- **Result.** It returns `won, status, sim_seconds, steps, objectives_done, events, stuck_recoveries, save_reload, timeline, plan_source, pending?, reason?`.

## 6. V3 bridge (`toManifestV3(pkg)`)

`toManifestV3` projects the package into a WorldManifestV3 that passes `validateManifest` with 0 errors.

| Package | WorldManifestV3 |
|---|---|
| regions | zones |
| placements | structures (footprint from the collider) |
| used mesh records | assets, keyed by the package's ref string, `format: "external"` or `"instanced"` for scatter, plus `composition_ref { package, package_sha256, asset_id, ref }` and a licence |
| characters | npcs, with `npc_ai`/`enemy_ai` behaviors |
| items | items |
| required objectives | `quest_main` steps |
| each optional objective | its own quest |
| interactable targets | projected onto their placement or NPC |
| interactables and region hazards | interactions + behaviors |
| player, respawn and checkpoint spawns | `spawn.player_spawns` |
| paths | navigation links |
| provenance stages | `generated_by` (CACHED → AVAILABLE with `cached: true`) |

It also adds a top-level `gamesb { package_version, game_id, version, package_sha256, play }` so v3 consumers can find and verify the exact build.

## 7. Hooks

**`applyEdit(pkg, op)`** returns `{ pkg, op, notes, created? }`, or throws `EditRejected` with a reason. The supported ops are:

- `move_placement`
- `add_placement` (shipped assets only)
- `remove_placement` (refused while an interactable, objective or event depends on it)
- `recolor_material`
- `set_time_of_day`
- `set_weather`
- `rename_character`
- `set_character_behavior`
- `set_objective_text`
- `add_optional_objective`
- `set_difficulty`

How an edit is applied:

1. The op is checked against its own rules.
2. It is applied to a deep copy.
3. Derived data is recomputed:
   - nav via `bakeNavigation`
   - environment via `buildEnvironment`
   - scene via `compileSceneGraph`, patched in place if unavailable
4. `version` is incremented and the package is resealed.
5. The edit is **rejected if it introduces any validation error**.

`applyEdits(pkg, ops)` chains edits.

**`expandWorld(pkg, { prompt, direction })`** adds one region, deterministically.

- **Where it goes.** It picks free ground that is ≥ 4 m from other regions, at least 55 % walkable and reachable, with the requested direction as a preference.
- **What it adds:**
  - a themed landmark with a solid collider
  - a focal interactable
  - a pickup with its item
  - a checkpoint
  - a path from the nearest region
  - two **optional** objectives
  - a message event and a checkpoint trigger

  New ids are `*_exp_<n>`. It only reuses shipped assets. Nav is re-baked and reachability is re-checked before a spot is accepted.
- **Result.** It returns `{ pkg, added, direction }`, records `hooks.expand.history`, and refuses on validation regressions or when no ground is free.

**`publishPackage(pkg, { outDir, runtimeDir, deps, validation?, playtest?, now? })`** refuses with `PublishRefused { gates }` unless validation is ok, the playtest won, save/reload is ok and the integrity hash matches. It writes nothing when it refuses. On success it writes:

- `package.json`, unmodified
- `games-b-runtime/**`
- the relative-import closure of the renderer, sim-core and deps at repo-relative paths
- baked PNG/SVG files from `assets/bake.mjs`, mapped in `baked.map`
- `index.html`, which redirects to `games-b-runtime/play.html?pkg=../package.json`
- `PUBLISH_MANIFEST.json`, listing every file with its bytes and sha256, plus the package sha and the gate results

## 8. Measured (offline, Node 25, M-series laptop, 28 Sep 2026)

| prompt | world | tri (est.) | draws | tex MB | won in (sim) | wall: build + gates | sim step |
|---|---|---|---|---|---|---|---|
| lighthouse island | 240 m | 161,786 | 168 | 45 | 100 s | 636 ms (cold) | 0.020 ms |
| desert canyon | 240 m | 113,751 | 143 | 48 | 161 s | 280 ms | 0.007 ms |
| frozen pass | 240 m | 118,796 | 151 | 45 | 164 s | 375 ms | 0.038 ms |
| scifi moon base | 240 m | 99,114 | 121 | 42 | 164 s | 421 ms | 0.037 ms |
| ruined city (large) | 320 m | 154,118 | 186 | 42 | 245 s | 785 ms | 0.031 ms |

- **Playtest runs.** Zero stuck recoveries, save/reload ok, save ≈ 4.4–5.3 KB, package ≈ 320–370 KB. The sim step is 10–70× under the 0.5 ms budget.
- **Tests.** Run `node --test test/gamesb-runtime*.test.mjs test/gamesb-pipeline*.test.mjs test/gamesb-hooks*.test.mjs`.
  - The mock-deps runtime tests and the fixture gates run whatever the other stages' state.
  - The pipeline tests skip, naming the missing file, until every stage module exists.

## 9. Known gaps

- **Escort objectives cannot complete in the sim.** The rules engine completes escort on `npc_state "arrived"`, and nothing in the sim emits that yet.
- **Collision is XZ only.** The player cannot stand on structures, and a jump does not clear a collider.
- **Static gates miss nav/collider disagreement.** If a solid collider is added without re-baking nav, the package passes every static check but is unwinnable. Only the headless playtest catches it; the unwinnable-publish test uses exactly this case.
- **Budgets are static estimates.** The browser hook `stats()` reports the real numbers. The draw-call model assumes one draw per material per placement, with no batching.
- **The agent is a competent player, not an adversary.** It ignores optional objectives unless they are promoted, takes the first non-looping dialogue choice, and avoids hazards only by simple repulsion from hostile NPCs.
- **Byte-identical rebuilds need a fixed `createdAt`.** They also require ignoring provenance `at` and `latency_ms`, which are wall-clock.
- **`recolor_material` keeps the `asset_id` stable.** It bumps `version` and `sha256` instead, so the record is no longer strictly content-addressed after an edit.
- **Expansion limits.** It never grows the world bounds or creates new geometry, and it fails cleanly when the world is full; the 80 m test fixture holds one expansion.
- **Baked PNGs are not referenced from the package.** They ship beside it and are mapped only in the publish manifest.
