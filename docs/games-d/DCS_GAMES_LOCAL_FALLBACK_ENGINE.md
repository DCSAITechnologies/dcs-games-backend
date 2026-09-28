# DCS Games — Local Fallback Engine (Games-D)

Zero-API path: a **recipe** (seed, theme, template, layout, difficulty, lighting, scale) builds a playable 3D game with procedural generation only. Code: `src/gamesd/` (contract `src/gamesd/CONTRACT.md`), built on the Games-B pipeline through `overrides` (never forked), so every game passes the Games-B validators, reachability check and headless playtest.

- Entry: `buildFromRecipe(recipe)` (`src/gamesd/engine.mjs`); `recipeFromPrompt(text)` maps free text to a recipe when every provider is down.
- Determinism: fixed `createdAt`, provenance `at`/`latency_ms` pinned (bug fixed in Games-B pipeline), seeded RNG only → same recipe = same sha256.
- Presets: 18 themes (all 9 biomes, 9 terrain shapes incl. archipelago/caldera/terraces/dunes/marsh), 8 lighting presets, 19 material styles, 19 procedural WebAudio sound presets + event cues, 7 layouts (linear/star/loop/chain/cluster), 10 gameplay templates, 9 NPC archetypes, 3 difficulties. Full list: `DCS_GAMES_PROCEDURAL_PRESET_MATRIX.csv`.
- Budgets: `src/gamesd/budgets.mjs` — asset budget per scale; GPU perf floor 20/15/12 fps (gates); SwiftShader CPU budget advisory only.
- Quality: `src/gamesd/quality/` scores launch, objective completion, collision (inside-solid probe), FPS, save/reload (headless + browser), visual signature/variety, deterministic rebuild, budgets. Bench: `node tools/gamesd-bench.mjs [--gpu]`. Results: `DCS_GAMES_LOCAL_SAMPLE_REPORT.md`.
- Tests: `npm run test:gamesd`, `npm run test:gamesb`.

## Known open issues (not fixed yet)
1. Hazard damage gets `damage_mult` applied twice (sim-core + rules engine); templates compensate.
2. `checkObjectiveReachability` can report false negatives (nearest cell in a sealed pocket); `village` sites removed from layouts as a workaround.
3. Containers are one-shot in sim-core; the Games-B skeleton (`classic_chain`) can become unwinnable if opened early.
4. The headless agent avoids all non-target hostiles, so it can deadlock on clustered hunt targets (hunt uses no swarms); it also gets stuck on about 1% of seeds.
5. One nav/collision mismatch in a diagonal gap (seed 145, obsidian_mesa).
6. The runtime loads Three.js from the cdnjs CDN (free, not an API); a fully offline copy is not vendored.
7. The bench numbers come from a run on a tree other agents were still editing; they have not been re-run after the final commit.
