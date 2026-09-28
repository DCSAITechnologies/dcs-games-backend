# Games-D local fallback engine contract (v1.0.0)

Games-D is the **zero-API** path for DCS Games. It makes a playable 3D game from
a *recipe* using only procedural generation and the libraries and assets already
in this repo. No provider key is needed and no network call is made (the one
exception is the browser runtime's Three.js script, which comes from the public
cdnjs CDN; that is a free static file, not an API).

It is built **on top of** the Games-B pipeline (`src/gamesb/CONTRACT.md`) and never forks it:
`buildFromRecipe()` calls `buildGame()` with `env = { DCS_PROVIDERS_OFFLINE: "1" }`,
a fixed `createdAt`, and `overrides` composed from the modules below. The Games-B
validators, headless playtest and reachability gates therefore judge every
fallback game exactly as they judge a provider-backed one.

The Games-B rules still apply: determinism (only `src/gamesb/common/rng.mjs`, never `Math.random()`),
add-only schema changes, and the isomorphic lint for anything the browser loads.

## 1. Recipe (`recipe_version: "1.0.0"`)

```js
{
  recipe_version: "1.0.0",
  seed: int >= 0,
  theme: THEME_ID,                     // src/gamesd/world/themes.mjs
  template: TEMPLATE_ID,               // src/gamesd/gameplay/templates.mjs
  layout: LAYOUT_ID,                   // src/gamesd/missions/layouts.mjs
  difficulty: "easy"|"normal"|"hard",  // src/gamesd/difficulty.mjs
  lighting: LIGHTING_ID|null,          // src/gamesd/world/lighting.mjs; null → theme default
  scale: "small"|"medium"|"large"|null,// null → layout default
  title?: string, prompt?: string      // optional flavour; never changes structure
}
```

- `recipeId(recipe)` is `rcp_` plus the first 12 hex characters of the sha256 of the canonical recipe.
- `gameIdFor(recipe)` is `fb_<theme>_<template>_<difficulty>_<seed>`.
- The same recipe always rebuilds a byte-identical package (the same `integrity.sha256`).
- `recipeFromPrompt(prompt, { seed })` maps free text onto a recipe with keyword scoring. This is the entry point when every provider is down.

## 2. Stage context

Every module hook receives `ctx`:

```js
ctx = { recipe, theme, template, layout, lighting, difficulty /* DIFFICULTY[recipe.difficulty] */,
        rand(stage) → seeded(...) /* independent deterministic stream per stage name */ }
```

## 3. Module hooks (each module owns its own file; the engine composes them)

The concept stage runs its patches in this order: theme, then layout, then npc roster, then template.

| module | exports |
|---|---|
| `world/themes.mjs` | `THEMES: {id → Theme}`, `themeConceptPatch(concept, ctx) → concept`, `themeWorldPatch(world, ctx) → world` |
| `world/lighting.mjs` | `LIGHTING: {id → LightingPreset}`, `applyLighting(world, ctx) → world` (environment only) |
| `missions/layouts.mjs` | `LAYOUTS: {id → Layout}`, `layoutConceptPatch(concept, ctx) → concept` (key_locations) |
| `npc/behaviours.mjs` | `ARCHETYPES`, `npcConceptPatch(concept, ctx) → concept` (roster), `applyNpcPresets(characters, ctx & {world}) → characters` |
| `gameplay/templates.mjs` | `TEMPLATES: {id → Template}`, `templateConceptPatch(concept, ctx)`, `applyTemplate(gameplay, ctx & {concept, world, characters}) → gameplay` |
| `materials/material-styles.mjs` | `MATERIAL_STYLES`, `materialConceptPatch(concept, ctx) → concept` (sets optional `concept.material_style`) |
| `audio/sfx.mjs` | `AUDIO_PRESETS`, `audioFor(ctx & {concept, world, gameplay}) → AudioSpec` (optional `pkg.audio`), `validateAudioSpec` |

A module that cannot honour a recipe **must not throw**. It degrades to the
nearest valid behaviour and pushes a string into `ctx.notes`.

**Theme** `{ id, name, biome, terrain_shape?, weathers: [w], lightings: [LIGHTING_ID], palette: {...}, mood, scatter_density?, pickup_lib?, material_style?, audio?: AUDIO_PRESET_ID, tags: [] }`

**Template** `{ id, name, genre, summary, needs: { hostiles_min?, hostiles_max?, locations_min?, companion?: bool }, timed: bool }`

**Layout** `{ id, name, scale, locations: int, kinds?: [kind], finale_kinds?: [kind], ordering: "linear"|"hub_spoke"|"loop"|"gauntlet"|"cluster", keywords }`. The ordering reaches world-spec as the optional `concept.layout_ordering`; when it is absent or `"linear"`, the world is bit-identical to Games-B.

**Difficulty** `{ level, damage_mult, speed_mult, time_mult, lives, player_health, hostile_bonus, npc_speed_mult, sight_mult }`

## 4. Budgets (`budgets.mjs`)

`ASSET_BUDGET`, `PERF_BUDGET` and `CPU_PERF_BUDGET` are keyed by scale.

- `checkBudgets(pkg, { perf?, cpuPerf?, build_ms?, expandScatter? })` returns `{ ok, scale, figures, over: [{ key, value, limit }], perf_gate, cpu_advisory }`.
- `PERF_BUDGET` (20/15/12 fps, p95 80/100/120 ms for small/medium/large) gates frame rate **only** for a hardware-GL measurement. Draw calls and triangles always gate.
- `CPU_PERF_BUDGET` (the SwiftShader worst case) is advisory and never affects `ok`.

A fallback game that is over budget is **not** counted as playable.

## 5. Quality (`quality/`)

`scoreSample(result, { browser?, browserCpu?, rebuild?, probe?, perfGate?, cpuCompare? }) → SampleScore`.
It measures launch, objective completion, collision, FPS, save/reload, visual signature and deterministic rebuild,
and adds `playable` plus `reasons[]`. `varietyReport(scores)` returns the pairwise visual distances and the
counts of world and gameplay variants. The bench CLI
`tools/gamesd-bench.mjs` builds the sample catalogue (`samples/catalogue.mjs`) and writes
`docs/games-d/DCS_GAMES_*`.

## 6. Optional fields Games-D adds to Games-B shapes

All of these are add-only. When a field is absent, Games-B output is unchanged.

| where | field | read by |
|---|---|---|
| GameConcept | `terrain_shape` (`archipelago`, `caldera`, `terraces`, `dunes`, `marsh`, or a base shape) | world-spec → `generateBaseTerrain({ shape })` |
| GameConcept | `layout_ordering` | world-spec `layoutRegions` / path graph |
| GameConcept | `material_style` (the full style object) | `resolveAssets` → `buildMaterialSpec` |
| GameConcept | `fallback_recipe` (the recipe, plus `recipe_id` and `engine`) | provenance only |
| WorldSpec.environment | `exposure`, `lamp_boost`, `lighting` | browser renderer |
| CharactersSpec behavior | `home`, `avoid`, `sight_los`, `chase_max_s`, `archetype` | npc-brain |
| GamePackage | `audio` (AudioSpec) | `games-b-runtime/audio.mjs` |
