# DCS Games-B: 3D world specification and scene graph

This document covers the world stage of the Games-B pipeline (`src/gamesb/world/`). The binding shapes are in `src/gamesb/CONTRACT.md` §2, §3, §4.1a and §4.5. This document records how the world stage fills those shapes, which conventions it adds, and what it cannot do yet.

## 1. Pipeline

```
prompt ─► GameConcept (concept stage)
        ─► generateWorldSpec(concept, { seed })          world-spec.mjs   sync, deterministic
             1 base heightfield by biome shape            terrain.mjs
             2 region layout (greedy + seeded relaxation)
             3 pads levelled, MST paths routed and carved, seams relaxed
             4 location compositions from lib: pieces with colliders
             5 scatter entries by biome                   (expanded by terrain-sample.mjs)
             6 navigation baked (slope, water, colliders) collision.mjs
             7 spawns / checkpoints / pickups picked from cells REACHABLE from spawn_player
             8 focal, pickup and talk interactables (§4.5 ids)
             → connectivity check; if it fails, re-lay out (up to 4 salted attempts)
        ─► validateWorldSpec(world, { concept })         world-spec.schema.mjs  (ISO)
        ─► compileSceneGraph(world, { assets, characters }) scene-graph.mjs
        ─► validateSceneGraph(scene, { assets, world })  scene-graph.schema.mjs (ISO)
```

The runtime loads the following isomorphic modules directly into the browser: `terrain-sample.mjs` (heights, slope, normals, scatter expansion), `nav-grid.mjs`, `collision.mjs` and both `*.schema.mjs` files. They import only `../common/*.mjs`, and `test/gamesb-iso-lint.test.mjs` passes.

### Public API (`src/gamesb/world/index.mjs`)

| Module | Exports |
|---|---|
| world-spec.mjs | `generateWorldSpec`, `isConnected`, `bakeNavigation`, `buildEnvironment`, `LIB`, `PICKUP_LIBS`, `FOCAL_KIND`, `SIZE_BY_SCALE` |
| world-spec.schema.mjs | `validateWorldSpec(world, { concept?, reachability? })`, `LIB_NAMES`, `BIOMES` |
| terrain-sample.mjs | `sampleHeight`, `slopeAt`, `normalAt`, `expandScatter`, `footprintRadius`, `distToPolyline`, `regionCoreRadius` |
| terrain.mjs | `generateBaseTerrain`, `flattenPad`, `corridorProfile`, `carveCorridors`, `flattenCorridor`, `relaxPathSeams`, `SHAPE_BY_BIOME`, `terrainGrid` |
| nav-grid.mjs | `navIndex`, `isWalkable`, `findPath`, `reachableSet`, plus `nearestWalkable`, `segmentWalkable`, `cellCenter` |
| collision.mjs | `buildColliders(world, scene?, instances?)`, `resolveCapsule`, `pointInCollider`, `containsXZ` |
| scene-graph.mjs / .schema.mjs | `compileSceneGraph`, `validateSceneGraph`, `sceneAssetRefs`, `sceneMaterialRefs` |

## 2. WorldSpec as generated

### Size and grids

| Concept `scale` | World edge (m) | Terrain cell (m) | Terrain vertices | Nav grid |
|---|---|---|---|---|
| small | 160 | 2 | 81 × 81 | 80 × 80 |
| medium | 240 | 2 | 121 × 121 | 120 × 120 |
| large | 320 | 2.5 | 129 × 129 | 128 × 128 |

- **Terrain indexing.** `heights[j*cols+i]` is the vertex at `x=i*cell`, `z=j*cell`. It never exceeds 160 × 160 vertices.
- **Nav indexing.** Nav cell `(i,j)` covers `[i*cell,(i+1)*cell) × [j*cell,(j+1)*cell)`, and walkability is judged at the cell centre.

### Terrain shapes

| Biome | Shape | Character |
|---|---|---|
| island | island | Radial falloff with an angle-noise coastline that drops to a seabed of −7 m, so about 45% of the map is land. Beach rise, rolling fbm hills, an off-centre summit (+16 m × √(edge/240)), inland terraced cliff bands, and a stretch of sea cliff on one side |
| forest, snow, canyon | valley | Meandering floor between walls. Canyon walls are steep and terraced, and snow adds peaks |
| ruins, volcanic | plateau | Central tableland with a rim. Volcanic adds a cone with a crater |
| desert, city, scifi_base | open | Dunes (desert) or near-flat ground |

- **Rim.** Every non-island world gets a rim about 6 m high around its edge.
- **Region pads.** Pads are flattened with a smooth 9 m blend.
- **Pad heights along the tree.** Pad heights are clamped along the path tree so that neighbours differ by at most 12° over the distance between their pad edges. This guarantees each corridor has room to climb.

### Paths

- **Routing.** Paths form a Prim MST over the region centres, rooted at the hub. Each edge is routed by A* over the terrain vertex grid. The step cost is `len·(1+4·grade²)`, with ×40 for water and ×20 for the edge band. The route is then simplified (Douglas–Peucker at 1.2 cells) and smoothed (2 Chaikin passes).
- **Profiles.** Each corridor profile is the smoothed ground, grade-limited to 18° in both directions.
  - Samples inside any pad are pinned to the pad height.
  - Where a corridor crosses or overlaps an earlier corridor, it takes that corridor's height. The height is held fixed at a true crossing and is a soft start in the wider band.
- **Carving.** All corridors are carved together, and each vertex takes the height of the nearest centreline sample over all corridors. The level band is `width/2 + 1.5 cells`, followed by a 5 m blend.
- **Seam repair.** A final seam pass relaxes any vertices where the centreline, or a point one cell to either side of it, is still steeper than 30°.

### Regions and compositions

- **Regions.** Each region has the id `region_<location.id>`, and `regions[0]` is the hub.
  - Region kind is mapped from the location: hub/village→district, camp/grove→wilderness, dock→transit, and every other kind→landmark.
  - Regions carry the optional `pad_radius`: 12 for the hub, 11 for a village and 9 for everything else.
  - Half-extents are 18–22 m for the hub and 13–17 m for other regions.
- **Layout.** Candidates are jittered grid points.
  - They must sit on gentle ground: a neighbourhood slope of at most 14°, or 17° for summit and tower.
  - When there is water, candidates must be on dry land, except for a dock.
  - They must also stay clear of the world edge.
- **Scoring.** The hub prefers the centre, summit and tower prefer height, a dock prefers a coastal spot about 1.8 m above the water, and a cave prefers slope. Minimum spacing is `clamp(0.55·edge/√n, 30, 95)` and shrinks when it cannot be met.
- **Pieces.** Each location is composed from `lib:` pieces placed on distance rings around the centre.
  - Every piece stays at least 3.5 m + its footprint from the centre, so the centre stays walkable.
  - Pieces keep clear of path corridors, of other pieces' footprints and of other plazas.
  - Pieces need slope ≤ 26° (40° for rocks) and must be above water.
  - Structures face the centre.

| Location kind | Pieces (focal piece first) | Focal interactable |
|---|---|---|
| hub | signpost, cottage/stone_hut ×2, well, lantern_post ×2, fence ×2, crate, barrel | sign |
| village | cottage (focal), 2 more houses, well, gate, lantern_post, cart | door |
| tower | lantern_post (focal), lighthouse (water) or watchtower, rock_large ×2, crate | lantern |
| summit | beacon_brazier (focal), watchtower, lantern_post, rock_large ×3 | lantern |
| ruin | chest (focal), ruin_arch, ruin_wall ×2, ruin_pillar ×4, rock_small ×2 | container |
| shrine | altar (focal), shrine, obelisk/statue, lantern_post ×2, flowers ×2 | altar |
| dock | signpost (focal), dock (runs from the shoreline into the water), boat, crate ×2, barrel | sign |
| camp | signpost (focal), campfire, tent ×2, crate, barrel | sign |
| cave | chest (focal), cliff_rock ×4 in an arc, rock_large | container |
| grove | altar (focal), biome tree ×7 ring, flowers ×3, mushroom ×2 | altar |
| landmark | obelisk (focal), statue, rock_large ×2, lantern_post | lever |

Colliders are set per `lib:` name in `LIB` (world-spec.mjs):
- The dock, boat and campfire are non-solid.
- Bushes, grass, flowers, reeds and small rocks have no collider.
- **Convention.** Collider `size` and `radius` are in world units and are **not** multiplied by `placement.scale`. Solid placements are always emitted at scale 1.

### Scatter (by biome, density per 10 000 m²)

Each scatter entry sets `avoid_paths: true` and uses only §4.1a names.

- **Island:**
  - palm (below water +5 m)
  - broadleaf (+3 to +12 m)
  - pine (above +7 m)
  - bush, grass_tuft, rock_small, rock_large, flowers
  - reeds (`zone: "shore"`, from −0.3 to +0.9 m around the water line)
- **Other biomes:**
  - Forest adds pine, broadleaf, dead_tree and mushroom.
  - Desert uses cactus, rocks and dead_tree.
  - Snow uses pine, dead_tree, rocks and crystal_cluster.
  - Volcanic uses dead_tree, rocks, crystal and cliff_rock.
  - Canyon uses cactus, rocks and cliff_rock.
  - Ruins uses broadleaf, dead_tree, bush, grass and flowers.
  - City uses broadleaf, bush, flowers and grass.
  - Scifi_base uses crystal_cluster and rocks.

`expandScatter(world)` gives each instance its own RNG stream (`seed + k·φ`) with 10 tries. An instance is rejected in any of these cases:
- it is outside the world, with a 1.5 m margin;
- it is under water (unless `zone: "shore"`);
- it is outside `min_h`/`max_h` or above `max_slope_deg`;
- it is on a path (`width/2 + 1 + r`);
- it is within `footprint + 0.8 + r` of any non-pickup placement;
- it is inside any region pad.

Because each instance draws from its own stream, adding an obstacle only affects the instances near that obstacle. Instance `collider_radius` is already multiplied by the instance scale. Pickup placements are deliberately excluded from scatter avoidance, so that choosing pickups after the nav bake cannot move trees.

### Environment

| Field | Rule |
|---|---|
| sun | Day is `t ∈ [0.22, 0.78]`, with elevation `72·sin(π·p)` (floored at 4°) and azimuth `90 + 180·p` (east→west). Night uses a moon at 38°, `#9db4ff`, intensity ≈ 0.3. Colour runs from warm to white with elevation. Intensity is scaled by weather (clear 1 … storm 0.35), and shadows are on when intensity > 0.4 |
| sky | Built from the palette sky colour with a weather tint (cloudy, rain, storm, snow, fog, sandstorm or ash). The horizon warms towards orange when the sun is below 20°, and the whole sky darkens at night |
| fog | `far = edge × {clear 1.6, cloudy 1.2, rain .75, storm .55, snow .6, fog .3, sandstorm .32, ash .45}` and `near = 0.2·far` (0.05 for fog) |
| ambient | Horizon colour mixed with white, with `ground_color` taken from the palette ground. Intensity is 0.3–0.6 by daylight |
| water | Enabled for the island biome and for any concept with a dock. Island water sits at level 0. Other biomes use the 4th-percentile height, and the dock prefers low ground |
| material_layers | First match wins. Island: sand (≤ water+1.6 m, ≤30°), grass (≤30°), rock. The other biomes use similar lists (snow/rock, sand/rock, stone/grass/rock and so on) |
| camera | `third_person`, distance 7, height 2.4, fov 60°, `min_pitch -0.35` and `max_pitch 1.1` (**radians**), `collide: true` |

### Spawns, interactables and navigation (§4.5)

- **spawn_player.** The nearest nav cell to hub centre + (0, 2.5) that is walkable and at least 1.2 m from any solid collider.
- **Placement from reachable cells.** Every other spawn, and every pickup, is placed on a cell in `reachableSet(spawn_player)` inside its region, with a clearance of 0.8–1.0 m.
- **NPC spawns.**
  - Companions, quest givers, merchants and ambient characters spawn in the hub.
  - Guards round-robin over the non-hub regions.
  - Enemies and creatures are assigned from the last non-hub region backwards.
- **Checkpoints.** `spawn_cp_<region id>` sits 4 m from each non-hub region centre, on the side facing the hub.
- **Focal interactables.** Each is `ix_<location.id>` on its focal placement, with `radius = footprint + 1.8 + cell/2` so that a reachable nav cell always lies within reach.
- **Pickups.** `pickup_<n>` (n ≥ 3) is spread round-robin over the non-hub regions, and falls back to the hub when there is only the hub.
  - Each pickup has `item_ref: item_<n>` and a placement with `role: "pickup"` and no collider.
  - The placement stands at ground level + 0.5 m.
  - Its `lib:` ref comes from concept keywords (lantern→`lantern_core`, gem/crystal→`gem`, and so on), or otherwise from the biome.
- **Talk interactables.** `ix_talk_<character.id>` is created for every character whose role is not `enemy`, including creatures, as §4.5 says. It has `placement_ref: null` and a `character_ref`.
- **Navigation.**
  - Border cells are blocked.
  - A cell is walkable when its centre is ≥ water + 0.25, its slope is ≤ 38° (`max_slope_deg`), and it lies outside every solid collider grown by the player radius of 0.45 m.
  - Colliders are rasterised over their own bounding boxes.
  - `step_height` is 0.45.
- **findPath.** An 8-connected A* with an octile heuristic.
  - A diagonal step is allowed only when both orthogonal neighbours are walkable.
  - An endpoint that sits on a blocked cell snaps to the nearest walkable cell within 2 cells.
  - The result is string-pulled with a supercover line-of-sight check that applies the same corner rule. The returned points are world-space.

## 3. Validation rules

The validator's checks, in order:

1. **Structure.** Every field in §2 must be present, with the correct enum, number range and hex colour.
2. **Identity and heights.**
   - Ids are unique per array.
   - `heights.length = rows·cols`, and every height is finite.
   - `min_y` and `max_y` must match the heights.
   - `material_layers` must not be empty.
3. **Containment.** Regions, path points, placements and spawns must lie inside `size`. Region centres must lie inside their bounds.
4. **References.**
   - Every path's endpoints must name real regions.
   - Placements and spawns must name real regions.
   - Every `placement_ref` must resolve. `null` is allowed only for `talk` with a `character_ref`.
   - Pickups need an `item_ref`.
5. **Navigation shape.** `cols·cell ≈ size.w` and `rows·cell ≈ size.h`. `walkable` must be exactly `rows·cols` characters of `0`/`1`.
6. **§4.5 ids.**
   - `spawn_player` must be in `regions[0]`, and every non-hub region needs a `spawn_cp_<region>`.
   - Every location region needs its `ix_<loc>`.
   - At least three `pickup_<n>`, each with `item_<n>` and a placement of role `pickup`.
   - Every `ix_talk_<id>` must have `character_ref = id`.
   - With a concept, the validator also checks `region_<loc>`, the hub order, `spawn_npc_<char>`, and `ix_talk_<char>` for each character that is not an enemy.
7. **Geometry.**
   - `spawn_player` must be on a walkable cell, outside every solid collider (0.3 m pad) and above the water.
   - Unless `reachability: false`, every region centre and every npc or checkpoint spawn must be reachable from `spawn_player`.
   - Every interactable with a placement must have reachable ground within its `radius`.

The scene validator checks the following:
- Exactly one each of `root`, `environment`, `sky`, `sun_light`, `ambient_light`, `terrain`, `camera_rig` and `nav_grid`, plus at least one player `spawn`.
- Unique ids, existing parents, only the root with a null parent, and no parent cycles.
- The required fields for each node type.
- Every `asset_ref` resolves: some record has `ref === asset_ref` or `asset_id === asset_ref`.
- With `world` supplied, placement, scatter, spawn and interactable refs are cross-checked.
- Unresolved terrain `material_ref`s produce warnings.

## 4. Scene graph conventions

- **Transforms and nodes.**
  - Every `transform` is **world-space**; `parent` only groups nodes.
  - Node ids are `<kind>:<ref>`, such as `mesh:pl_gull_dock_dock_1` or `trigger:ix_moss_shrine`.
  - There is one `instanced_group` per scatter entry, with `count` equal to the expanded instance count.
- **Sun.** `sun_light.direction` is a unit vector **from the scene towards the light**. Azimuth is measured clockwise from +z towards +x, so 90° points along +x (east).
- **Triggers.**
  - Each region has a box trigger (half-height 20).
  - Each interactable has a sphere trigger.
  - A talk interactable is parented to its character node and positioned at its npc spawn.
- **Characters.** Character nodes use `CharactersSpec.characters[].asset_ref` when one is supplied, and otherwise fall back to `char:<id>` for each `spawn_npc_*`.
- **Audio.** The cue names are logical strings, not asset refs:
  - a biome ambience bed (for example `amb_surf`, `amb_gulls` and `amb_wind_light` on the island);
  - a weather layer (`amb_rain`, `amb_thunder`, and so on);
  - `amb_night_insects` at night;
  - local emitters on campfire, brazier, dock, shrine, lighthouse and well.

## 5. Determinism and performance

- **Determinism.** Every random draw comes from `common/rng.mjs`, seeded by FNV-1a hashes of `"<purpose>|<seed>|…"`. Heights and positions are rounded to 0.01 m.
  - The same concept and seed give byte-identical JSON, and a test asserts this.
  - Connectivity retries use salted layout seeds, so retries are deterministic too.
- **Measured timings.** Node 25.8 on the dev Mac, run sequentially. Each scale covers 90 worlds: 9 biomes × 10 seeds, with 5 locations and 2 characters.

| Scale | generate p50 / p95 / max | validate p50 | scene compile | WorldSpec JSON | scatter instances (p50) |
|---|---|---|---|---|---|
| small | 9 / 13 / 17 ms | 2 ms | < 1 ms | ≈ 56 KB | 54 |
| medium | 18 / 26 / 34 ms | 4 ms | < 1 ms | ≈ 105 KB | 120 |
| large | 21 / 27 / 43 ms | 5 ms | < 3 ms | ≈ 119 KB | 213 |

The budget is 1.5 s. Island worlds carry about 2–3× more instances than the table shows because of their foliage density, at 345 instances for the medium fixture.

- **Robustness sweep.**
  - 1 080 worlds (40 seeds × 9 biomes × 3 scales, using the island fixture's 5 locations) and 810 worlds with mixed location kinds and counts of 1, 3 and 8 all passed `validateWorldSpec` including reachability.
  - Before the retry was added, about 1 in 1 000 steep canyon layouts disconnected.

## 6. Limits and known gaps

- **Validator helpers.** `isConnected` and the retry loop mean generation is repaired by re-layout, not by local terrain surgery. If all four attempts fail, the last world is returned and `validateWorldSpec` reports the unreachable ids. This has not been observed in the sweep.
- **Terrain look.** The heightfield is value-noise fbm, with no erosion and no rivers. Valley and plateau "cliffs" are terraces, not overhangs. Water is a single flat plane; a dock in a non-island biome gets a low "lake" line at the 4th percentile of height.
- **Corridor cuts.** Carving corridors through ridges can leave steep cut walls beside the path. These walls are unwalkable on purpose, but they are visually abrupt.
- **Colliders are 2.5D.** They are oriented boxes and vertical cylinders on XZ with a vertical extent. Arches and gates are solid boxes, so there is no walk-through doorway geometry. Scatter colliders use a fixed height of 4 m × scale.
- **Nav resolution.** At 2–2.5 m, narrow gaps under about 3 m between solids close up. NPCs should use `findPath`, and players rely on `resolveCapsule`.
- **Retries under heavy wedging.** `resolveCapsule` runs up to 32 summed passes, and deep wedges converge over those passes, or over frames in the runtime.
- **Audio and material refs.** Audio cues and `mat:` layer refs are logical names. The asset and runtime stages must supply them, and the scene validator only warns on unresolved materials.
- **Pickups and scatter.** Pickup placements are ignored by scatter avoidance, so a bush (which has no collider) can grow over a pickup.

## 7. Contract additions (all optional, additive)

- **`regions[].pad_radius`**: the radius of the flattened plaza, which scatter keeps clear.
- **`scatter[].zone`** (`"land" | "shore" | "any"`), plus `min_h`, `max_h` and `max_slope_deg`.
- **SceneGraph fields.**
  - `transform_space: "world"`.
  - Node extras:
    - `environment.{time_of_day, weather}`;
    - `mesh_instance.role`;
    - `instanced_group.requested_count`;
    - `interactable.{kind, character_ref}`;
    - `audio_emitter.ambient`;
    - `camera_rig.{collide, target_ref}`;
    - `character.name`.
- **Collider records from `buildColliders`** carry `bound`, the XZ bounding radius. `buildColliders` accepts an optional third argument with pre-expanded instances.
- **Extra helpers in `nav-grid.mjs`**: `nearestWalkable`, `segmentWalkable` and `cellCenter`.
