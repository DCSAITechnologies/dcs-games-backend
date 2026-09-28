# Games-B pipeline contract (v1.0.0)

This is the parent-owned contract for the Games-B prompt → playable 3D game pipeline.
Every module under `src/gamesb/` and `games-b-runtime/` codes against these shapes.
If you need a field that is not here, add it as **optional**, and never rename or remove one.

## 0. Ground rules

- **Units and axes.** Distances are in metres and the y axis is up. The world occupies `x ∈ [0, size.w]` and `z ∈ [0, size.h]`, which matches WorldManifestV3. `rotation_y` is in radians. Colours are `#rrggbb`.
- **Determinism.** The same prompt with the same seed gives a byte-identical result on the deterministic path. Use `src/gamesb/common/rng.mjs` (`rng`, `seeded`, `hashString`) and never `Math.random()` in the pipeline.
- **Validation.** Validators are hand-written, zero-dependency and return `{ ok, errors: [{ path, message, hint? }], warnings }`. Use the `Issues` helpers in `src/gamesb/common/issues.mjs`.
- **ISOMORPHIC modules.** These files run in the browser runtime as native ES modules, loaded by relative path.
  - They may import only other ISOMORPHIC modules, with relative paths and a `.mjs` extension.
  - They must not import `node:*`, npm packages or anything from `src/v3/`.
  - They must not touch `process`, `Buffer` or `fs`.
  - A lint test enforces this (`test/gamesb-iso-lint.test.mjs`).
  - The modules:
    - `src/gamesb/common/rng.mjs`
    - `src/gamesb/common/issues.mjs`
    - `src/gamesb/world/terrain-sample.mjs`
    - `src/gamesb/world/nav-grid.mjs`
    - `src/gamesb/world/collision.mjs`
    - `src/gamesb/assets/texture-synth.mjs`
    - `src/gamesb/assets/mesh-recipes.mjs`
    - `src/gamesb/gameplay/rules-engine.mjs`
    - `src/gamesb/characters/npc-brain.mjs`
    - `src/gamesb/characters/dialogue.mjs`
    - `src/gamesb/runtime/sim-core.mjs`
    - every schema validator file (`*.schema.mjs`)
- **Node-only.** `src/gamesb/common/hash.mjs` (sha256, `canonicalJson`, `promptHash`), the provider adapters and the file writers.
- **Providers.** Every provider call goes through the `Lane` class in `src/v3/providers/contract.mjs`, which is ranked adapters ending in a deterministic local fallback. Build adapters with `chatCompletion` from the same file, or with the adapter factories in `src/v3/providers/text.mjs`.
  - Tests run offline (`DCS_PROVIDERS_OFFLINE=1`).
  - Never log, print or persist a credential.
  - Every provider result is recorded as a `ProvenanceStage` (§8).
- **Tests.** Use `node --test` with plain `.mjs` files named `test/gamesb-<area>.test.mjs`. Nothing needs a build step or an npm install.

## 1. GameConcept (`concept_version: "1.0.0"`), produced from the prompt

```js
{
  concept_version: "1.0.0",
  title: string, logline: string,
  source_prompt: string, prompt_hash: string /* sha256 hex */, seed: int,
  genre: "adventure"|"exploration"|"mission"|"puzzle"|"survival"|"collectathon"|"stealth",
  biome: "island"|"forest"|"desert"|"snow"|"volcanic"|"canyon"|"ruins"|"city"|"scifi_base",
  scale: "small"|"medium"|"large",            // world edge 160 / 240 / 320 m
  mood: string, time_of_day: number /*0..1*/, weather: "clear"|"cloudy"|"rain"|"storm"|"snow"|"fog"|"sandstorm"|"ash",
  palette: { primary, secondary, accent, ground, sky, water } /* hex */,
  player_fantasy: string,
  key_locations: [{ id, name, kind: "hub"|"landmark"|"ruin"|"shrine"|"camp"|"cave"|"tower"|"village"|"dock"|"summit"|"grove", description }],
  characters:    [{ id, name, role: "companion"|"quest_giver"|"merchant"|"guard"|"enemy"|"creature"|"ambient", description }],
  objectives_outline: [string], hazards: [string]
}
```

## 2. WorldSpec (`world_spec_version: "1.0.0"`), owned by `src/gamesb/world/`

```js
{
  world_spec_version: "1.0.0", id: string, title: string, seed: int,
  size: { w, h }, biome,
  environment: {
    time_of_day, weather,
    sky:  { top: hex, horizon: hex, bottom: hex },
    fog:  { color: hex, near: number, far: number },
    sun:  { azimuth_deg, elevation_deg, color: hex, intensity, shadows: bool },
    ambient: { color: hex, ground_color: hex, intensity },
    water: { enabled: bool, level: number, color: hex, opacity }
  },
  terrain: {
    kind: "heightfield", shape: "island"|"valley"|"plateau"|"open",
    cols, rows, cell /* metres per cell */, heights: number[] /* rows*cols, row-major, z-major: heights[j*cols+i] is at x=i*cell, z=j*cell */,
    min_y, max_y,
    material_layers: [{ material_ref, min_h, max_h, max_slope_deg }]   // first matching layer wins
  },
  regions: [{ id, name, kind: "district"|"interior"|"landmark"|"wilderness"|"transit"|"arena"|"instance",
              bounds: [minX, minZ, maxX, maxZ], center: {x,y,z}, location_ref? /* concept key_location id */ }],
  paths: [{ id, from_region, to_region, width, points: [{x,z}] }],
  placements: [{ id, asset_ref, region, position:{x,y,z}, rotation_y, scale,
                 role: "structure"|"prop"|"landmark"|"foliage"|"interactable"|"pickup"|"decor",
                 collider: { shape: "box"|"cylinder"|"none", size?:{x,y,z}, radius?, height?, solid: bool },
                 tags: [string] }],
  scatter: [{ id, asset_ref, region: string|null, count, min_scale, max_scale, seed, avoid_paths: bool, collider_radius /* 0 = none */ }],
  spawn_points: [{ id, kind: "player"|"npc"|"respawn"|"checkpoint", position:{x,y,z}, rotation_y, region }],
  camera: { mode: "third_person"|"first_person"|"top_down", distance, height, fov, min_pitch, max_pitch, collide: bool },
  interactables: [{ id, placement_ref, kind: "door"|"switch"|"pickup"|"container"|"terminal"|"lantern"|"altar"|"talk"|"portal"|"lever"|"sign",
                    radius, prompt: string, item_ref?: string /* pickup|container: the item it grants */, locked_by?: string /* item id needed */, character_ref?: string /* talk: the character it follows */ }],
  navigation: { cell, cols, rows, max_slope_deg, step_height, walkable: string /* rows*cols chars '1'|'0', same indexing as a nav cell */ }
}
```

- **Heights.** Heights are sampled **bilinearly** by `sampleHeight(terrain, x, z)` in `world/terrain-sample.mjs`, which also exports `slopeAt(terrain, x, z)` and `normalAt`.
- **Scattered instances.** `scatter` entries expand deterministically into instances with `expandScatter(world)` in `world/terrain-sample.mjs`. It returns `[{ scatter_id, asset_ref, position, rotation_y, scale, collider_radius }]` and is ISOMORPHIC, so the runtime and the validators agree on where every tree is.
- **Navigation API.** `world/nav-grid.mjs` exports:
  - `navIndex(nav, x, z)`
  - `isWalkable(nav, x, z)`
  - `findPath(nav, from{x,z}, to{x,z}) → [{x,z}] | null`, an 8-connected A* over walkable cells.
  - `reachableSet(nav, from)`
- **Collision API.** `world/collision.mjs` exports:
  - `buildColliders(world, scene?)`, which returns `[{ id, shape: "box"|"cylinder", center:{x,y,z}, half:{x,y,z} | radius, height, rotation_y, solid, ref }]` for every placement with a solid collider plus every expanded scatter instance with `collider_radius > 0`.
  - `resolveCapsule(colliders, pos{x,y,z}, radius, height) → { x, z, hit: bool }`, which pushes the capsule out of solids on the XZ plane.
  - `pointInCollider(colliders, x, z, pad)`

## 3. SceneGraph (`scene_graph_version: "1.0.0"`), compiled from a WorldSpec with `compileSceneGraph(world, { assets, characters })`

```js
{
  scene_graph_version: "1.0.0", world_id,
  nodes: [{ id, type, parent: string|null, name?,
            transform?: { position:{x,y,z}, rotation_y, scale },
            ...typeFields }]
}
```

- **Structure.** The node list is flat, with `parent` links.
- **Node types and their fields:**
  - `root`
  - `environment`
  - `sky` { top, horizon, bottom }
  - `sun_light` { color, intensity, direction:{x,y,z}, shadows }
  - `ambient_light` { color, ground_color, intensity }
  - `fog` { color, near, far }
  - `water` { level, color, opacity, size:{w,h} }
  - `terrain` { terrain_ref: "world.terrain", material_layers }
  - `region` { region_ref, bounds }
  - `mesh_instance` { asset_ref, placement_ref, material_overrides? }
  - `instanced_group` { asset_ref, scatter_ref, count }
  - `character` { character_ref, asset_ref, spawn_ref }
  - `spawn` { spawn_ref, kind }
  - `camera_rig` { mode, distance, height, fov, min_pitch, max_pitch }
  - `collider` { collider_ref }, optional; colliders are normally derived
  - `trigger_volume` { shape, radius | half, ref /* region or interactable id */ }
  - `interactable` { interactable_ref, placement_ref, radius, prompt }
  - `audio_emitter` { cue, radius }
  - `nav_grid` { nav_ref: "world.navigation" }
- **Completeness.** A complete scene has exactly one `root`, one `environment`, `sky`, `sun_light`, `ambient_light`, `terrain`, `camera_rig` and `nav_grid`, plus at least one player `spawn`. Every `asset_ref` must resolve to an AssetRecord and every parent must exist. `validateSceneGraph(scene, ctx)` checks all of this.

## 4. Assets, owned by `src/gamesb/assets/`

### 4.1 AssetRecord (`asset_record_version: "1.0.0"`)

```js
{
  asset_record_version: "1.0.0",
  asset_id: string,            // content-addressed: "ast_" + sha256(canonicalJson({kind, payload}))[0..16]
  kind: "character"|"npc"|"creature"|"prop"|"structure"|"foliage"|"texture"|"material"|"environment"|"sky"|"ui"|"icon"|"cinematic",
  name: string,
  provider: string,            // e.g. "local:procedural", "together", "cerebras", "external-3d"
  model: string,               // e.g. "deterministic", "black-forest-labs/FLUX.1-schnell"
  prompt: string|null, prompt_hash: string /* sha256 hex of normalised prompt, or of the recipe when there is no prompt */,
  version: int,                // bumps when the payload changes under the same logical name
  source: "procedural"|"curated"|"generated"|"cached",
  cost_usd: number, latency_ms: number,
  format: "mesh-recipe"|"texture-recipe"|"material"|"png"|"svg"|"glb"|"json"|"camera-path",
  dimensions: { w, h, d } /* metres, meshes */ | { px_w, px_h } /* images */ | null,
  bytes: int, sha256: string /* of canonical payload or of file bytes */,
  game_bindings: [{ game_id, refs: [string] }],   // which placements/characters/materials use it
  provenance: { generated_at: iso, lane: string, adapter: string, status: "AVAILABLE"|"FALLBACK"|"CACHED",
                after_failed: [string], license: { spdx: string, commercial_use: "internal-testing-only"|"cleared"|"unknown" } },
  payload: object | null,      // the recipe (mesh/texture/material/camera path) for procedural assets
  uri: string | null           // for file-backed assets (png/svg/glb), relative to the package
}
```

### 4.1a Logical refs (how the world stage references assets before assets exist)

WorldSpec, SceneGraph and CharactersSpec never hold content hashes. They use **logical refs**, and every AssetRecord carries an extra field, `ref: string`, set to the logical ref it satisfies. A scene `asset_ref` resolves when some record has `ref === asset_ref` or `asset_id === asset_ref`.

| prefix | meaning | examples |
|---|---|---|
| `lib:` | curated/procedural mesh from the library | see the list below |
| `char:<character_id>` | a character mesh built from that character's `body` spec | `char:keeper_maren` |
| `mat:` | material | `mat:grass`, `mat:sand`, `mat:rock`, `mat:dirt`, `mat:snow`, `mat:stone`, `mat:wood`, `mat:planks`, `mat:roof`, `mat:metal`, `mat:plaster`, `mat:leaves`, `mat:bark`, `mat:water`, `mat:cloth`, `mat:glow`, `mat:crystal`, `mat:brass`, `mat:ember` |
| `tex:` | texture | `tex:<material name>_albedo`, and so on, created by the material that needs it |
| `sky:` | sky asset | `sky:main` |
| `icon:<item_id>` | inventory icon (SVG) | |
| `ui:` | HUD pieces (SVG) | `ui:hud_frame`, `ui:compass`, `ui:prompt` |
| `cine:` | camera path | `cine:intro` |

The `lib:` names the world stage may use, and which the asset stage MUST provide, are:

- **Structures:** `lighthouse`, `watchtower`, `stone_hut`, `cottage`, `ruin_arch`, `ruin_wall`, `ruin_pillar`, `shrine`, `dock`, `bridge`, `well`, `tent`, `campfire`, `lantern_post`, `altar`, `beacon_brazier`, `gate`, `statue`, `obelisk`
- **Props:** `crate`, `barrel`, `chest`, `signpost`, `fence`, `boat`, `cart`
- **Foliage and terrain:** `pine_tree`, `broadleaf_tree`, `palm_tree`, `dead_tree`, `bush`, `grass_tuft`, `rock_small`, `rock_large`, `cliff_rock`, `cactus`, `crystal_cluster`, `mushroom`, `flowers`, `reeds`
- **Pickups:** `lantern_core`, `relic`, `gem`, `key`, `scroll`, `herb`, `shard`

An unknown `lib:` name must still resolve. The asset stage falls back to the nearest entry of the same role and records a warning, so an unknown name is never a crash.

### 4.2 Mesh recipe (`format: "mesh-recipe"`)

This is the payload shape that `assets/mesh-recipes.mjs` produces and the runtime builds.

```js
{ builder: "parts", bounds: {w,h,d},
  parts: [{ shape: "box"|"cylinder"|"cone"|"sphere"|"capsule"|"torus"|"lathe"|"extrude"|"rock"|"icosphere",
            size?: {x,y,z}, radius?, radius_top?, radius_bottom?, height?, tube?, segments?,
            profile?: [[r,y],...] /* lathe */, outline?: [[x,z],...], depth? /* extrude */,
            detail?, noise?, seed? /* rock / icosphere displacement */,
            position: {x,y,z}, rotation: {x,y,z}, material_ref: string, emissive?: bool, cast_shadow?: bool }] }
```

- **Composition.** Meshes are composed from shaped parts: lathed silhouettes, extruded outlines and noise-displaced rocks. They are not bare boxes, and every part names a material.
- **Characters.** Humanoid and creature recipes carry an extra `rig: { kind: "biped"|"quadruped"|"hover", joints: {...} }`. The runtime uses it for a procedural walk cycle.

### 4.3 Texture recipe and materials

**Texture recipe** (`format: "texture-recipe"`):

```js
{ generator: "grass"|"sand"|"rock"|"dirt"|"snow"|"bricks"|"planks"|"stone_tiles"|"roof_tiles"|"bark"|"leaves"|"metal"|"plaster"|"water"|"cloth"|"noise",
  size: 64|128|256|512, seed: int, colors: [hex, ...], scale: number, params: {...} }
```

`assets/texture-synth.mjs` (ISOMORPHIC) exports `synthesizeTexture(recipe) → { width, height, albedo: Uint8ClampedArray(RGBA), normal: Uint8ClampedArray(RGBA), roughness: Uint8ClampedArray(RGBA) }`. The output is deterministic and tileable. It runs in the browser and is uploaded through canvas `ImageData`. In Node, `assets/png.mjs` encodes it to PNG with `node:zlib` for publishing.

**Material** (`format: "material"`, `kind: "material"`):

```js
{ material_id, albedo_texture?: asset_id, normal_texture?: asset_id, roughness_texture?: asset_id,
  color: hex, roughness, metalness, emissive: hex|null, emissive_intensity, transparent: bool, opacity, repeat: {u, v}, double_sided: bool }
```

**Asset manifest API.** `assets/asset-pipeline.mjs` exports `resolveAssets({ concept, world, characters, gameId, cache }) → { records: AssetRecord[], materials: {material_id → record}, byRef: {ref → asset_id}, stats }`. It deduplicates by `asset_id` and reads through the cache in `assets/cache.mjs`, a content-addressed store on disk under a configurable dir. A cache hit returns the record with `source: "cached"` and `provenance.status: "CACHED"`, at cost 0.

## 4.5 Pipeline order and deterministic ids (`src/gamesb/pipeline.mjs`)

The stages run in this order:

`generateConcept` → `generateWorldSpec` → `generateCharacters` → `generateGameplay` → `resolveAssets` → `compileSceneGraph` → `assemblePackage` → `validatePackage` → `headlessPlaytest`

Gameplay runs before assets (amended at integration) so that `resolveAssets` receives `gameplay.inventory.items` and every `icon:<item_id>` ref resolves.

The stage signatures:

| Stage | Signature |
|---|---|
| `concept/concept.mjs` | `async generateConcept(prompt, { seed?, env? }) → { concept, provenance: ProvenanceStage }` |
| `world/world-spec.mjs` | `generateWorldSpec(concept, { seed? }) → world`, synchronous and deterministic |
| `characters/characters.mjs` | `generateCharacters({ concept, world }) → CharactersSpec`, synchronous and deterministic |
| `assets/asset-pipeline.mjs` | `async resolveAssets({ concept, world, characters, gameplay?, gameId, cache?, env? }) → { records, byRef, stats, provenance: [ProvenanceStage] }` |
| `gameplay/generate.mjs` | `async generateGameplay({ concept, world, characters, env? }) → { gameplay, provenance }` |
| `world/scene-graph.mjs` | `compileSceneGraph(world, { assets: records, characters }) → scene` |

The world stage MUST produce these ids, so that later stages can target them without searching:

- **Regions.** One region per concept key_location, with id `region_<location.id>`. The first key_location is the start hub.
- **Spawns.** One player spawn `spawn_player`, in the start hub on walkable ground, clear of colliders. One npc spawn `spawn_npc_<character.id>` for every concept character. At least one `checkpoint` spawn per non-hub region, with id `spawn_cp_<region id>`.
- **Focal interactables.** One per key_location, with id `ix_<location.id>`. Its kind is mapped from the location kind: shrine→altar, tower→lantern, summit→lantern, ruin→container, dock→sign, camp→sign, cave→container, grove→altar, village→door, hub→sign, landmark→lever.
- **Pickups.** At least three `pickup` interactables with ids `pickup_<n>`, spread over non-hub regions. Each has `item_ref` `item_<n>` and a placement with `role: "pickup"`, using a pickups `lib:` ref chosen to suit the concept.
- **Talk interactables.** One `talk` interactable per non-enemy character, with id `ix_talk_<character.id>`. Its `placement_ref` is null and it follows the character. The runtime binds it to the NPC position.

Gameplay then creates `inventory.items` for every `item_<n>`, and objectives that target the ids above.

## 5. GameplaySpec (`gameplay_version: "1.0.0"`), owned by `src/gamesb/gameplay/`

```js
{
  gameplay_version: "1.0.0", game_type: GameConcept.genre,
  rules: { player_health, lives, fall_damage: bool, fall_y: number /* below this = fell out */, time_limit_s: number|null },
  movement: { walk_speed, run_speed, jump_velocity, gravity /* negative */, max_slope_deg, step_height, air_control, player_radius, player_height },
  camera: { mode, distance, height, fov, sensitivity },
  interaction: { radius, key: "KeyE", hold_ms: 0 },
  inventory: { slots, items: [{ id, name, kind: "key"|"collectible"|"consumable"|"quest", stackable, max_stack, icon_ref: asset_id|null, effect?: { heal?: number } }] },
  objectives: [{ id, title, description,
                 kind: "reach"|"collect"|"interact"|"talk"|"deliver"|"defeat"|"survive"|"escort"|"activate",
                 target_ref /* region | interactable | character | item id */, count /* default 1 */,
                 requires: [objective_id], optional: bool, reward: { xp, item_ref?: string } }],
  events: [{ id, once: bool,
             trigger: { kind: "objective_complete"|"objective_active"|"enter_region"|"interact"|"talk"|"timer"|"item_count"|"health_below"|"game_start", ref?, value? },
             actions: [{ kind: "message"|"give_item"|"remove_item"|"set_npc_state"|"unlock"|"set_weather"|"set_time"|"checkpoint"|"damage"|"heal"|"win"|"lose"|"reveal"|"play_cinematic"|"set_flag",
                         ref?, value? }] }],
  combat: { enabled: bool, mode: "none"|"avoid"|"melee", player_damage, hazard_damage_per_s },
  hazards: [{ id, kind: "storm_zone"|"sentinel"|"deep_water"|"fire"|"fall", region?: string, character_ref?: string, damage_per_s, active_after?: objective_id }],
  progression: { xp_per_level, max_level },
  difficulty: { level: "easy"|"normal"|"hard", damage_mult, speed_mult, time_mult },
  checkpoints: [{ id, spawn_ref, trigger: { kind: "objective_complete"|"enter_region", ref } }],
  win_conditions: [{ kind: "all_required_objectives"|"objective"|"item_count"|"reach_region", ref?, value? }],   // ANY satisfied → win
  lose_conditions: [{ kind: "health_zero"|"lives_zero"|"time_expired"|"fell_out"|"npc_lost", ref? }]            // ANY satisfied → lose (health_zero costs a life and respawns at the checkpoint while lives remain)
}
```

`validateGameplay(gameplay, ctx?)` checks the structure. When `ctx = { world, characters }` is given, it also checks references: every `target_ref`, region, character, spawn and item must resolve, the `requires` graph must be acyclic, and at least one win condition must be satisfiable.

**Rules engine** (`gameplay/rules-engine.mjs`, ISOMORPHIC):

```js
createGameState(gameplay) → GameState
  GameState = { t, status: "playing"|"won"|"lost", health, lives, xp, level, inventory: {item_id: count},
                objectives: {id: "locked"|"active"|"done"}, progress: {objective_id: number}, fired: [event_id], flags: {},
                checkpoint: spawn_id|null, messages: [{t, text}], npc_states: {character_id: state}, weather, time_of_day }
applyGameEvent(state, gameplay, evt) → { state, effects: [action] }
  evt = { kind: "tick", dt } | { kind: "enter_region", ref } | { kind: "interact", ref } | { kind: "talk", ref }
      | { kind: "pickup", ref /* item id */, count } | { kind: "damage", value } | { kind: "fell_out" } | { kind: "npc_state", ref, value }
      | { kind: "deliver", ref /* target */, item } | { kind: "defeat", ref }
evaluateEnd(state, gameplay) → "playing"|"won"|"lost"
```

`applyGameEvent` is pure: it returns a new state and never mutates its input. `effects` are the fired actions the simulation must realise physically, such as `set_npc_state`, `reveal`, `checkpoint`, `message`, `win`, `lose`, `damage` and `heal`.

## 6. Characters, owned by `src/gamesb/characters/`

```js
characters: {
  character_spec_version: "1.0.0",
  characters: [{ id, name, role /* concept role */, kind: "humanoid"|"creature"|"robot"|"spirit",
                 body: { height, build: "slim"|"average"|"broad", palette: { skin, primary, secondary, accent }, accessories: [ "hat"|"hood"|"cape"|"lantern"|"backpack"|"staff"|"goggles"|"scarf"|"satchel" ] },
                 asset_ref: asset_id /* mesh recipe with rig */, spawn_ref /* WorldSpec spawn_points id, kind npc */,
                 behavior: { initial: "idle"|"patrol"|"guard"|"wander"|"follow_player"|"flee"|"chase",
                             patrol: [{x,z}], wander_radius, speed, sight_radius, hostile: bool,
                             on_player_near?: state, on_player_far?: state, leash_radius },
                 dialogue_ref: string|null, interaction_radius, companion: bool, invulnerable: bool }],
  dialogues: [{ id, character_ref, entry: [{ node, conditions: [cond] }] /* first match wins */,
                nodes: [{ id, speaker, text, choices: [{ text, next: node_id|null, conditions?: [cond], actions?: [gameplay action] }] }] }]
  // cond = { kind: "objective_state", ref, value } | { kind: "has_item", ref, value? } | { kind: "flag", ref, value }
}
```

**NPC brain** (`characters/npc-brain.mjs`, ISOMORPHIC):

- `createNpcState(character, spawnPos) → { id, position:{x,y,z}, rotation_y, state, target:{x,z}|null, path_idx, timer, anim: "idle"|"walk"|"run"|"talk" }`
- `stepNpc(npcState, character, ctx, dt) → npcState`, where `ctx = { player:{x,y,z}, heightAt(x,z), isBlocked(x,z), findPath(from,to), rand() }`. It is pure, returns a new object and never walks into a blocked cell.
- `setNpcState(npcState, state)`

**Dialogue** (`characters/dialogue.mjs`, ISOMORPHIC):

- `openDialogue(dialogues, characterId, gameState) → { dialogue_id, node } | null`
- `availableChoices(node, gameState)`
- `choose(dialogue, node, choiceIdx, gameState) → { node: next|null, actions }`
- `validateDialogues(characters, ctx)` checks that every `next` resolves, every entry resolves and no node is unreachable. It lives in `characters/character.schema.mjs`.

## 7. GamePackage (`package_version: "1.0.0"`), the runtime input assembled by `src/gamesb/runtime/assemble.mjs`

```js
{
  package_version: "1.0.0", game_id, version: int, title, created_at,
  concept: GameConcept, world: WorldSpec, scene: SceneGraph,
  assets: { records: AssetRecord[] },          // textures, materials, meshes, icons, sky, ui, cinematic
  gameplay: GameplaySpec, characters: CharactersSpec,
  hooks: { edit: { ops: [string] }, expand: { ops: [string] }, companion: { character_ref|null, knowledge: [string] } },
  provenance: { pipeline_version: "gamesb-1.0.0", prompt_hash, stages: [ProvenanceStage] },
  integrity: { sha256: string /* sha256 of canonicalJson(package without integrity) */ }
}
```

## 8. ProvenanceStage

```js
{ stage: "concept"|"world"|"scene"|"assets"|"textures"|"gameplay"|"characters"|"assemble"|"playtest",
  lane, provider, model, status: "AVAILABLE"|"FALLBACK"|"CACHED"|"UNAVAILABLE", latency_ms, cost_usd, tokens?: {in, out}, after_failed?: [string], at: iso }
```

## 9. Simulation core (`runtime/sim-core.mjs`, ISOMORPHIC, fixed step 1/60 s)

```js
createSim(pkg, { rules, npcBrain, nav, collision, terrain } = {}) → sim   // deps default to the real iso modules
stepSim(sim, input, dt = 1/60) → { events: [] }
  input = { move: {x, z} /* world-space wish direction, |v|<=1 */, run: bool, jump: bool, interact: bool, choice?: int }
snapshot(sim) → SaveState
restoreSim(pkg, save, deps?) → sim
nearestInteractable(sim) → { id, kind, prompt, distance } | null
sim fields: { pkg, t, player: { position, velocity, rotation_y, grounded }, game: GameState, npcs: {id: NpcState},
              colliders, activeDialogue, status, stats: { steps, collisions, falls } }
```

**SaveState** (`save_version: "1.0.0"`):

```js
{ save_version: "1.0.0", game_id, package_version, package_sha256, saved_at, t,
  player: { position, rotation_y, health, lives }, game: GameState, npcs: { id: { position, state } },
  collected: [interactable_id], unlocked: [id] }
```

`restoreSim(pkg, snapshot(sim))` followed by `snapshot` must return the original save exactly, apart from `saved_at`.

## 10. Browser runtime (`games-b-runtime/`)

- **Entry point.** `games-b-runtime/play.html?pkg=<url of package json>` loads Three.js r147 as the global `THREE` from `https://cdnjs.cloudflare.com/ajax/libs/three.js/0.147.0/three.min.js`, which is the same build `play-v3.html` uses. It then imports `./renderer.mjs` and `../src/gamesb/runtime/sim-core.mjs`.
- **Test hook.** The runtime exposes `window.__DCS_GAMES_B__`:
  - `ready`, `pkg`, `sim` and `status()`
  - `input(partialInput)`, `stepFrames(n)` (deterministic, not tied to rAF), `teleport(x, z)`
  - `save()` returns a SaveState and also writes it to localStorage, `load(save?)`
  - `stats()` returns `{ fps, frame_ms_p50, frame_ms_p95, draw_calls, triangles, textures, geometries }`
  - `errors: []`
- **Controls.**
  - Keyboard: WASD or the arrow keys to move, Shift to run, Space to jump, E to interact, and 1–4 for dialogue choices.
  - Mouse drag orbits the camera, and there are touch sticks on mobile.
  - F5 or the Save button saves, and Load restores.
