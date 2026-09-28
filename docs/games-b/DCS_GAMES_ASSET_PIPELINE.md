# DCS Games-B asset pipeline

Owner: `src/gamesb/assets/`. Contract: `src/gamesb/CONTRACT.md` §4, §4.1a, §4.5 and §8.
Status on 28–29 Sep 2026: complete on the procedural path, with 32/32 tests passing (`node --test test/gamesb-assets*.test.mjs`). No image or 3D provider is configured on this machine, so every asset is procedural and is labelled as such.

## What it produces

`resolveAssets({ concept, world, characters, gameplay?, gameId, cache?, env?, adapters?, clock? })` returns:

- `{ records, byRef, materials, stats, provenance, warnings, validation, blobs }`
- `records` is deduplicated by `asset_id`.
- `validation` is `validateAssetSet(records, { requiredRefs })` run over every ref the game needs.

| kind | ref | format | built by |
|---|---|---|---|
| structure / prop / foliage | `lib:<name>` (all 47 in §4.1a) | `mesh-recipe` (or `glb` from a 3D provider) | `mesh-recipes.mjs` `buildMeshRecipe` |
| npc / creature / character | `char:<id>`, plus `char:player` | `mesh-recipe` with `rig` | `buildCharacterRecipe` |
| material | `mat:<name>` (all 19) | `material` | `materials.mjs` |
| texture | `tex:<mat>_albedo\|normal\|roughness` | `texture-recipe`, `png` after bake or from a provider | `texture-synth.mjs` |
| icon | `icon:<item_id>` | `svg` | `svg.mjs` `iconSvg` |
| ui | `ui:hud_frame`, `ui:compass`, `ui:prompt` | `svg` | `uiSvg` |
| sky | `sky:main` | `json` (gradient dome, sun, clouds, stars) | `skyRecipe` |
| cinematic | `cine:intro` | `camera-path` | `cinematic.mjs` |

Where refs come from:

- **World placements and scatter:** their `asset_ref` values.
- **Terrain:** `material_layers`, plus `mat:water` when water is enabled.
- **Characters:** each character's `asset_ref`, or `char:<id>`.
- **Icons:** `gameplay.inventory.items`, or failing that the world interactables' `item_ref`. The icon kind comes from the pickup's `lib:` name, then from the item's kind.
- **Fixed refs:** `sky:main`, `ui:*` and `cine:intro`.
- **Materials:** every `mat:` that a mesh part names.
- **Textures:** every `tex:` that a material needs.

## AssetRecord fields

| field | how it is set |
|---|---|
| `asset_id` | `"ast_" + sha256(canonicalJson({kind, payload})).slice(0,16)` |
| `ref` | The logical ref it satisfies (§4.1a). |
| `provider` / `model` | `local:procedural` + `deterministic`, the lane adapter that answered, or the injected or real provider. |
| `prompt` / `prompt_hash` | For procedural records, `prompt` is null and `prompt_hash` is the sha256 of the canonical payload. For generated records, `prompt_hash` is `promptHash(prompt)`. |
| `version` | 1-based index of this `asset_id` in the cache's history for the ref. Changed content under the same ref gives version + 1. |
| `source` | `procedural`, `curated` (the SVG templates), `generated` or `cached` |
| `cost_usd` / `latency_ms` | The provider's cost and the lane's latency. Procedural records are 0 / 0, because recipes are built in microseconds and pixels are made at bake or runtime. Cache hits are 0. |
| `dimensions` | `{w,h,d}` in metres from the recipe bounds, `{px_w,px_h}` for images, or `null` |
| `bytes` / `sha256` | Of the canonical payload, or of the file bytes once baked or generated. |
| `game_bindings` | `[{ game_id, refs }]`. The refs are the placement, scatter or character ids for meshes, the user refs for materials, and the materials for textures. |
| `provenance` | `{ generated_at, lane, adapter, status: AVAILABLE\|FALLBACK\|CACHED, after_failed, license{spdx, commercial_use} }` |

`validateAssetRecord` and `validateAssetSet` live in `asset-record.schema.mjs`, which is isomorphic.

- `validateAssetRecord` checks every field, the cross-field rules (cached means CACHED at cost 0; a file format needs a `uri` or a payload) and the mesh and texture payload shapes.
- `validateAssetSet` checks for duplicate ids or refs, material→texture and part→material links that do not resolve, and required refs that are missing.

## Content addressing and cache

- **Cache.** `createAssetCache(dir)` (`cache.mjs`) defaults to `<worktree>/.cache/gamesb-assets`, which is git-ignored.
- **On-disk layout:**
  - `records/<key>.json` holds one record per request.
  - `blobs/<sha256>.bin` holds provider image bytes.
  - `index.json` is advisory and holds the per-ref version history.
- **Atomic writes.** Every write goes to a temp file and is then renamed into place.
- **Request key.** The key is `sha256({pipeline version, kind, ref, procedural payload, AVAILABLE providers for that lane})`. Because the provider set is part of the key, a cached offline fallback is not served once a real provider is configured.
- **Cache hit.** The stored record is returned with `source: "cached"`, `provenance.status: "CACHED"`, `cost_usd: 0` and `latency_ms: 0`.
- **Measured.** A second run over the fixture world gives 80/80 hits at $0.
- **Texture seeds.** Texture seeds come from the material name, not the game. Two games with the same palette therefore share texture records.
- **Deterministic output.** Pass `clock` to pin `generated_at`. With a pinned clock, two runs are byte-identical (tested). `pipeline.mjs` already passes `createdAt`.

## Meshes

- **Parts.** Recipes are lists of shaped parts. The shapes are lathe, extrude, noise-displaced rock and icosphere, cylinder, cone, torus, capsule, sphere and box.
- **Budgets.** Each recipe has at most 40 parts and computed `bounds` (`{w,h,d,min,max}`). An `est_triangles` estimate matches the geometry `games-b-runtime/geometry.mjs` builds.
- **Conventions.** They are documented at the top of `mesh-recipes.mjs` and match the runtime's builder:
  - `position` is the part centre. Lathe and "xz" extrudes are the exception: for them `position` is the base.
  - `extrude.outline_plane` is `"xy"` for an upright profile or `"xz"` for a footprint.
  - A capsule's `height` is its straight section.
  - A torus lies in the XY plane.
- **Examples:**
  - The lighthouse has a lathed tapered tower, red stripe bands, a gallery deck, a torus railing with posts, a glass lamp room, an emissive lamp, mullions and a cap.
  - Trees combine a lathe or cylinder trunk with several displaced canopy lobes.
  - The arch is a real extruded outline with an opening.
  - The snow biome adds snow caps.
- **Characters.** Characters come in four kinds:
  - **Humanoid and robot:** a biped with joints `root, spine, neck, shoulder_l/r, hip_l/r`.
  - **Creature:** a quadruped with joints `hip_fl/fr/bl/br, neck, tail`.
  - **Spirit:** a hover rig with joints `core, arm_l/r`.

  Every part names its `joint`. Each joint has a pivot, a parent, an axis and a swing, and the rig also carries a gait phase. Nine accessories are supported.
- **Unknown names.** `nearestLibName` matches an exact name first, then an alias (for example `tree` or `boulder`), then by word overlap, then falls back to the default for the role. It never throws, and the record carries `requested` and `warnings`.
- **Visual QA.** `preview.mjs` `recipeToSvg` draws front and side silhouettes. `games-b-runtime/tools/texture-gallery.html` shows every texture generator (tiled 2×2), every material, every library mesh and five sample characters. Serve the repo root over HTTP and open that page.

## Textures and materials

- **Generators.** `synthesizeTexture(recipe)` supports 16 generators and returns RGBA albedo, normal and roughness. The normal map comes from height via a wrapping Sobel filter.
- **Tileable by construction.** All noise is periodic: a wrapped lattice, wrapped Worley cells, and sines with an integer number of cycles per tile. Structured patterns are phase-shifted so that no tile boundary sits on the texture edge. Tests compare the wrap seam with interior seams.
- **Timing.** Measured on this Mac, best of 3 at 256², in ms: grass 4.4, sand 6.7, rock 10.7, dirt 10.7, snow 4.6, bricks 3.9, planks 5.2, stone_tiles 11.2, roof_tiles 4.3, bark 14.1, leaves 18.9, metal 4.1, plaster 11.7, water 8.5, cloth 5.2, noise 2.2. The budget is under 50. A 512² rock takes about 51 ms.
- **Materials.** Each material is tinted toward one concept-palette key with a modest weight, plus a biome nudge (desert, canyon, snow, volcanic and others).
- **Colour fields.** Two optional material fields control colour:
  - `color` is the flat mid-tone, used when no texture is loaded.
  - `color_with_map` is `#ffffff`, the multiplier to use with the albedo texture.

  The `glow`, `crystal` and `ember` materials are emissive. `water` and `crystal` are transparent.
- **Baking.** `bake({ records, outDir, blobs })` writes texture PNGs and SVGs, then sets `uri`, `bytes` and `sha256` from the file. `asset_id` is unchanged. The fixture world bakes 49 files (2.37 MB) in about 0.65 s. PNGs are encoded by `png.mjs`: RGBA, adaptive filters, zlib level 6, verified CRCs.

## Provider lanes (`providers.mjs`, built on `Lane` from `src/v3/providers/contract.mjs`)

| lane | ranked adapters | configured here? |
|---|---|---|
| `gamesb_image` (albedo textures only) | `together` with FLUX.1-schnell (`TOGETHER_API_KEY`, PNG only), then `local:procedural` | **No.** `TOGETHER_API_KEY` is not set. |
| `gamesb_mesh` (libs and characters) | `external-3d` (the v3 adapter: `DCS_ASSET3D_URL` and `DCS_ASSET3D_KEY`), then `local:procedural-mesh` | **No.** |

The only provider key variable present on this machine is a Cerebras key. Cerebras is a text vendor, not used by this stage, and was reported as currently rejected.

Both lanes therefore resolve to the procedural fallback. Every record then says `FALLBACK`, with `after_failed: ["together"]` or `["external-3d"]`. With `DCS_PROVIDERS_OFFLINE=1`, no adapter touches the network.

`resolveAssets(..., { adapters: { image, mesh } })` accepts injected adapters. The tests use this to cover the AVAILABLE path (cost and latency recorded, cache makes the rerun free), a failing adapter (falls back and is named) and a glb result.

Provenance is returned as §8 stages aggregated per (stage, lane, provider, status), with an added `calls` count. There is also a `local` FALLBACK stage and a `cache` CACHED stage.

## Cost accounting

- **Procedural and cached records** cost $0.
- **FLUX.1-schnell** is recorded at `FLUX_SCHNELL_USD_PER_MEGAPIXEL = 0.0027`, which is about $0.0007 for a 512² image. This is a documented estimate from Together's list price, not a metered bill.
- **External 3D** cost is `DCS_ASSET3D_COST_USD` when that variable is set. Otherwise it is 0 and the result is flagged as unknown.
- **Totals.** `stats.cost_usd` sums the records.

## Licensing

| source | spdx | commercial_use |
|---|---|---|
| procedural or curated SVG | `LicenseRef-DCS-Procedural` | `cleared` |
| FLUX via Together | `LicenseRef-Together-FLUX.1-schnell` | `internal-testing-only` |
| external 3D | whatever the provider returns, else `NOASSERTION` | `unknown` |

- **Procedural and curated SVG** are made by DCS code with no third-party inputs.
- **FLUX via Together:** the model weights are Apache-2.0, but the terms for its output need legal review before public launch.
- **External 3D:** this remains a launch blocker, as `asset3d.mjs` already notes.

## Contract additions (all optional)

- **Record:** `stats.est_scene_triangles`, `stats.warnings`.
- **`resolveAssets` return value:** `materials`, `warnings`, `validation` and `blobs`.
- **ProvenanceStage:** `calls`.
- **Mesh recipe:** `lib`, `role`, `requested`, `warnings`, `est_triangles`, `bounds.min/max`, `character_ref`, `character_kind`.
- **Rig:** `gait` and `hover`.
- **Part:** `name`, `joint`, `color`, `scale`, `outline_plane`.
- **Texture recipe:** `channel`.
- **Material:** `color_with_map`, `tile_m`, `texture_refs`.
- **Generated PNG payload:** `image{sha256,mime,px_w,px_h}`.
- **glb payload:** `glb{uri,polycount}`.
- **Record:** `bake_error`, set only on a failed bake.

## Known gaps

- **No real provider was exercised.** The FLUX and external-3D paths are tested only with injected fakes. FLUX output is not guaranteed to tile, so procedural normal and roughness maps are paired with a non-tiling generated albedo.
- **Previews are silhouettes.** The preview is convex hulls, not a render. Final visual QA needs the Three.js runtime.
- **`char:player` is our addition.** The contract lists no player mesh ref. The stage emits `char:player` unless the CharactersSpec defines a character with id `player`.
- **Unmatched aliases are dropped.** Two refs whose payloads are identical collapse to one record, and only the first ref is on it. In practice this cannot happen for different `lib:` names, because `requested` differs.
- **512² textures miss the budget.** They take about 50 ms each, over the 256² budget, so large sets should bake offline rather than synthesize at runtime.
