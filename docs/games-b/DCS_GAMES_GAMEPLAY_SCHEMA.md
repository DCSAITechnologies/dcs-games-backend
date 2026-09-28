# DCS Games-B — concept and gameplay schema

Status: 28 Sep 2026, branch `games-b/3d-world-pipeline-28sep2026`. The binding shapes are in `src/gamesb/CONTRACT.md` §1 and §5. This document covers what the code does with those shapes: the validation rules, the runtime semantics and the generation strategy.

| Module | Kind | Purpose |
|---|---|---|
| `src/gamesb/concept/concept.schema.mjs` | ISO | `validateConcept(c)` and the enums |
| `src/gamesb/concept/concept.mjs` | Node | `generateConcept(prompt, { seed, env, adapters })` |
| `src/gamesb/concept/llm.mjs` | Node | Cerebras JSON adapter, price constants, §8 provenance helper, `slugify` |
| `src/gamesb/gameplay/gameplay.schema.mjs` | ISO | `validateGameplay(g, ctx?)` |
| `src/gamesb/gameplay/rules-engine.mjs` | ISO | `createGameState`, `applyGameEvent`, `evaluateEnd` |
| `src/gamesb/gameplay/solver.mjs` | ISO | `solveGameplay(g, { reachable, locks })`, `locksFromWorld(world)` |
| `src/gamesb/gameplay/generate.mjs` | Node | `generateGameplay({ concept, world, characters, env, adapters })` |

Tests: `node --test test/gamesb-concept*.test.mjs test/gamesb-gameplay*.test.mjs`. Fixture worlds are in `test/fixtures/gamesb/gameplay/`.

## 1. GameConcept

The fields are as in §1. The validator adds these rules:

- **Ids.** `key_locations[].id` and `characters[].id` are unique and snake_case. The world stage builds `region_<id>`, `ix_<id>`, `spawn_cp_region_<id>` and `ix_talk_<id>` from them, so a bad id would spread into every later stage.
- **Hub.** `key_locations[0].kind === "hub"`, and it is the only hub.
- **Counts.** At least 2 locations are required, and 4–6 is expected (outside that range is a warning). 3–5 characters is expected.
- **Characters.** A `quest_giver` is required. A missing `companion` is only a warning.
- **Other fields.**
  - Palette values are `#rrggbb`.
  - `time_of_day` is in [0, 1], where 0.5 is noon and 0.76 is dusk.
  - `prompt_hash` is 64 hex characters.

### How the fallback path decides each field

The fallback path is deterministic. Its seed defaults to `hashString(prompt)`.

- **Classification.**
  - Biome, genre, mood and weather are scored against keyword tables, and the table with the most hits wins.
  - With no hits, weather and mood come from a seeded pick among the biome's defaults.
  - Time of day comes from keywords such as dawn, noon, dusk or night; otherwise it is a seeded value in 0.36–0.64.
  - Scale comes from words like small/tiny or vast/huge.
- **Palette.** Each biome has a base palette, shifted by a tint and lightness for the mood. The accent colour shifts half as much so it stays readable.
- **Locations.**
  - 4, 5 or 6 locations for small, medium or large scale.
  - The hub is first.
  - Places named in the prompt come next. Plurals match, so "lighthouse" becomes a tower and "shrines" becomes a shrine.
  - The rest are filled from a seeded, shuffled biome pool.
  - Locations are then sorted by how dramatic they are, and a place named in the prompt always wins. The last location is the finale.
- **Characters.** There is always a quest giver and a companion. There is one hostile character unless the genre is `puzzle`: a creature, or a guard for ruins, city and scifi_base (and always a guard for stealth). A merchant is added at medium or large scale, and an ambient character at large scale.
- **Text.** The title and logline come from templates filled with a seeded place name. Objectives and hazards are derived from the locations, weather, biome and hostiles.

### LLM path

The concept lane is `Lane("gamesb_concept", [cerebras:gpt-oss-120b, local:keyword-concept])`.

1. **Request.** The system prompt lists every enum and states the hub-first and role rules.
2. **Parse.** `parseJsonLoose` reads the reply, which also salvages truncated output.
3. **Repair.** `repairConcept(raw, base)` fixes the parsed object:
   - **Identity fields.** Version, source prompt, prompt hash and seed are always taken from the deterministic `base`.
   - **Enums.** Values are coerced through synonym tables, for example "Tropical Beach" → island, "thunderstorm" → storm and "Mentor" → quest_giver. Anything unknown falls back to the base value.
   - **Time of day.** A value between 1 and 24 is read as hours, and words such as dusk or night are mapped.
   - **Palette.** Only valid hex values are kept. Missing slots are filled from a palette recomputed for the repaired biome and mood.
   - **Locations.**
     - Rows that are strings or null are salvaged or dropped.
     - Ids are slugified and deduplicated.
     - The hub is forced first, or the base hub is inserted.
     - Any extra hubs are demoted to villages.
     - The list is capped at 6 and topped up from the base to reach 4.
   - **Characters.** Ids are slugified and deduplicated. Any missing quest_giver, companion or hostile is filled from the base. The list is trimmed to 5, dropping ambient characters first, and the quest giver is sorted first.
4. **Validate.** The repaired concept must pass `validateConcept`. If it fails, the result is the base concept, labelled `FALLBACK`, with the model call still costed.

`adapters` replaces the adapter list; if that list has no fallback, one is appended. `conceptAdapters({ env, chat })` accepts an injected `chat` transport, which the tests use to return messy, partial and truncated text.

## 2. GameplaySpec — sections

| Section | Generated default | Notes |
|---|---|---|
| **game type** | `concept.genre` | |
| **rules** | health 100, 3 lives, `fall_damage: false`, `fall_y = terrain.min_y − 15`, `time_limit_s` | The time limit applies only to `survival` and `mission`. It is generous: `ceil((300 + 150 × required) / 30) × 30` seconds. |
| **movement** | walk 4.5, run 7.5, jump 6.5, gravity −20, air control 0.35, capsule 0.4 × 1.8 | Slope and step height are taken from `world.navigation`. |
| **camera** | `world.camera` mode, distance, height and fov, with sensitivity 1 | |
| **interaction** | radius 2.5, `KeyE`, `hold_ms` 0 | |
| **inventory** | one item per `item_<n>` that any interactable grants | The name is the location plus the pickup mesh, e.g. "Sea Cave Gem". The kind is `key` if the item is some interactable's `locked_by`, otherwise `quest`. `icon_ref` is `"icon:<item_id>"` (see gaps). |
| **objectives** | main chain plus optional objectives (below) | |
| **NPC behaviour hooks** | `set_npc_state` actions and `npc_states` in GameState | `game_start` puts the companion on `follow_player`. The sim applies `set_npc_state` effects with `setNpcState`. `npc_state` events report back, for example `arrived` for escort. |
| **combat / non-combat** | with hostiles: `{ enabled: true, mode: "avoid", player_damage: 0, hazard_damage_per_s: 10 }`, otherwise `{ enabled: false, mode: "none" }` | No weapons are generated; hostiles are hazards to avoid. |
| **hazards** | each hostile character becomes a `sentinel` (10/s, `active_after` the first objective); storm, sandstorm, ash or snow weather becomes a `storm_zone` over the finale region (2/s) | |
| **events** | see below | |
| **progression** | 100 xp per level, max level 10 | Rewards are talk 25, collect 20, activate 50, reach finale 30, finale 100, optional 5–15. |
| **difficulty** | `normal`, all multipliers 1 | `damage_mult` scales damage, and `time_mult` scales the time limit. `speed_mult` is left for the sim to apply. |
| **checkpoints** | entering each non-hub region makes `spawn_cp_region_<loc>` current, if that spawn exists | |
| **win** | `all_required_objectives` | |
| **lose** | `health_zero`, `lives_zero` and `fell_out`, plus `time_expired` when a time limit is set | |

### Skeleton objective chain

The skeleton is built only from ids that are present in the world.

1. `talk_<quest_giver>`. This needs an `ix_talk_<id>` interactable. If there is none, it falls back to another talkable non-hostile character, and then to `reach_<first non-hub>`.
2. `collect_<item_n>` for each item, requiring step 1. The count is the number of pickups that grant that item.
3. `activate_<loc>` targets `ix_<loc>` for each non-hub location except the finale. It requires the collect objectives in that location's region, plus the collect objective for its `locked_by` item.
4. `reach_<finale>` requires every step 3 and every collect objective outside the finale region.
5. `activate_<finale>` requires step 4, the finale region's own collect objectives, and its lock item. The finale's own pickups gate activating it rather than reaching it. Otherwise a reach objective that unlocks while the player is already standing in the region would only complete once they left and came back.
6. Optional objectives: `talk_<other non-hostile>` and `inspect_<hub>` (the hub's sign).

The skeleton's events are:

- `ev_intro` on `game_start`: plays `cine:intro`, shows the logline and sets the companion to `follow_player`.
- `ev_briefed`: a quest-giver line, and reveals every non-hub region.
- `ev_found_<item>`: a message when an item is found.
- `ev_woke_<loc>`: a message, a `set_flag <loc>_restored` action and a `checkpoint spawn_cp_region_<loc>` action.
- `ev_final_call` on `objective_active` of `reach_<finale>`: a message and a reveal.
- `ev_finale`: a message and the `finale_complete` flag.
- `ev_low_health` on `health_below 30`: repeats (`once: false`).

## 3. Validation (`validateGameplay(g, ctx?)`)

**Always checked:**

- All section shapes and enums.
- Gravity is negative and `fov` is in 20–120.
- Ids are unique within objectives, items, events, hazards and checkpoints.
- `requires` entries resolve, and an objective cannot require itself.
- **The `requires` graph is acyclic.** A cycle is reported as a path, `a → b → a`.
- **No required objective depends on an optional one.**
- Reward items and `item_ref` values are inventory items.
- Every event trigger and action has the fields its kind needs. For example, `set_weather` needs a weather enum, `set_npc_state` an NPC state, and `set_time` a value in [0, 1].
- Every hazard's `active_after` is an objective, and a `sentinel` needs a `character_ref`.
- Checkpoint triggers resolve.
- `time_expired` requires `rules.time_limit_s`.
- **At least one win condition is satisfiable.**
  - `all_required_objectives` needs at least one required objective and an acyclic graph.
  - `objective` needs an existing objective.
  - `item_count` needs enough supply (checked when ctx is given).
  - `reach_region` needs an existing region.

**Also checked with `ctx = { world, characters }`:**

- **Right kind of target.** Every ref must resolve to the right kind of entity. The error names the kind the ref actually is.

  | Objective kind | Target |
  |---|---|
  | talk | character, which must also have `ix_talk_<id>` |
  | collect | item |
  | reach | region |
  | activate, interact | interactable |
  | deliver | character or interactable |
  | defeat, escort | character |
  | survive | region or null |

  Trigger and action refs are checked the same way:

  - `enter_region` → region
  - `interact` → interactable
  - `talk` → character
  - `item_count` → item
  - `checkpoint` → spawn
  - `set_npc_state` → character
  - `unlock` → interactable or region
  - `reveal` → any known id

- Checkpoint `spawn_ref` values and hazard regions and characters resolve, and the world has a player spawn.
- **Supply.**
  - Every collect target has a source: a world interactable with that `item_ref`, a reward or a `give_item`.
  - Required collect counts do not exceed that supply.
  - Every world `item_ref` has an inventory entry.

When a ref cannot be judged without ctx (a region, character, interactable or spawn), it is skipped rather than reported as dangling.

## 4. Rules engine semantics

`createGameState(g)` and `applyGameEvent(state, g, evt) → { state, effects }` are pure. State is copied explicitly and never mutated; the tests deep-freeze inputs to check this.

- **Objectives.**
  - Objectives start `locked`. Any objective whose `requires` are all `done` becomes `active`, both at creation and after every completion. This cascades.
  - Only active objectives progress, and `count` accumulates.
  - How each kind progresses:
    - `collect` counts pickups and `give_item` of the target.
    - `talk` completes on a `talk` event. An `interact` on `ix_talk_<id>` also counts as talking.
    - `reach` completes on `enter_region`.
    - `activate` and `interact` complete on `interact`.
    - `deliver` needs the item in the inventory and consumes it.
    - `defeat` completes on `defeat`, and sets the NPC's state to `defeated`.
    - `escort` completes on `npc_state` with the value `arrived` or `escorted`.
    - `survive` accumulates `tick` seconds while active.
  - When a `collect` objective becomes active, items already held count towards it, so picking something up early is never a softlock.
- **Completion.** Completing an objective:
  - grants xp;
  - levels up (`1 + floor(xp / xp_per_level)`, capped) and emits a `level_up` effect;
  - grants the reward item;
  - applies any checkpoint triggered by it;
  - fires `objective_complete` events;
  - re-runs activation, which fires `objective_active` events.
- **Events.**
  - A `once` event fires at most once; the `fired` list records event ids.
  - `timer`, `item_count` and `health_below` fire on the rising edge. A timer with `once: false` repeats every `value` seconds.
  - A cascade is capped at 512 steps.
- **Actions.**

  | Action | Effect on state |
  |---|---|
  | `message` | appended to `messages` |
  | `give_item` / `remove_item` | inventory changes; `max_stack` is respected |
  | `set_npc_state` | recorded in `npc_states` |
  | `unlock` | added to `unlocked` |
  | `set_weather` / `set_time` | state updated |
  | `checkpoint` | checkpoint set |
  | `damage` | scaled by `damage_mult` |
  | `heal` | capped at `player_health` |
  | `win` / `lose` | status set |
  | `reveal` | sets `flags["revealed:<ref>"]` |
  | `set_flag` | sets the flag |
  | `play_cinematic` | effect only |

  Every action that runs is also returned as an effect. Extra effect kinds are `respawn`, `level_up`, `objective_active` and `objective_complete`.
- **Health and lives.**
  - When health reaches zero, the player loses a life. While lives remain, health is restored and a `respawn` effect is emitted with `ref = checkpoint ?? "spawn_player"`.
  - When lives reach zero the game is lost. This also applies if neither `lives_zero` nor `health_zero` is listed, because no lives is not a playable state.
- **`fell_out`.** With `rules.fall_damage` it is a death; without it, the player gets a free respawn. The `fell_out` lose condition is realised through the life system, never as an instant loss.
- **Time.** `tick` advances `t`. `time_expired` fires when `t ≥ time_limit_s × time_mult`.
- **End of game.** After each event the engine checks for a loss first, then for a win (any win condition). A `win` or `lose` effect is emitted once. After that the status is terminal, and later events return no effects.
- **Start effects.** The effects of `game_start` are produced by `createGameState` and held in `state.pending`. They are delivered as the effects of the first `applyGameEvent` call, for example a `tick` with `dt: 0`.

## 5. Solver

`solveGameplay(g, { reachable, locks })` drives the real rules engine by picking, each round, the first active, reachable and unlocked objective. Required objectives are tried before optional ones. It returns:

- `{ solvable: true, plan: [{ objective_id, kind, target_ref }] }`, or
- `{ solvable: false, plan, reason, blocked: [{ objective_id, state, why }] }`.

A greedy search is complete here because progress is monotonic: objectives only move from locked to active to done. `reachable(ref)` is where physical pathfinding plugs in:

- It receives a region, interactable or character id.
- For `collect`, it receives the item id, and the caller maps that to the item's pickups.
- It defaults to `true`, which makes the solver a pure logic check.

`locks` (`locksFromWorld(world)`) makes an `activate` wait until the `locked_by` item is held. The solver also reports a spec whose time limit expires before the chain can finish.

## 6. Gameplay LLM path and repair

The gameplay lane is `Lane("gamesb_gameplay", [cerebras:gpt-oss-120b, local:gameplay-skeleton])`.

- **What the model may return.** It sees the skeleton's objectives and every region, character, interactable and item id. It may return:
  - `intro`
  - `objectives[{ id, title, description }]`, which is text only; ids that are not in the skeleton are ignored;
  - up to 3 `extra_optional` objectives of kind reach, talk, interact or collect.
- **How extras are checked.** Each extra must target an id of the right kind, gets an `opt_` id, is optional, and requires the first objective. It is kept only if the whole spec still validates with ctx.
- **Fallbacks.**
  - If the merged spec fails validation, the untouched skeleton is returned.
  - If nothing the model said survives, provenance is `FALLBACK`, but the call's tokens and cost are still recorded.
- **Guarantee.** The skeleton's required structure is never changed, so an LLM answer can never make a game unwinnable.

## 7. Provenance and cost

Each stage returns a §8 `ProvenanceStage` with `stage`, `lane`, `provider`, `model`, `status`, `latency_ms`, `cost_usd`, `tokens {in, out}` (from the OpenAI-style `usage`), `after_failed` and `at`.

`cost_usd` is an **estimate**. It is calculated from `PRICE_PER_MTOK` in `concept/llm.mjs`: gpt-oss-120b at $0.25 per million input tokens and $0.69 per million output tokens. These are the vendor's list prices as last checked, not billing data. Each record carries `cost_is_estimate: true`.

## 8. Provider status on this machine

- `CEREBRAS_API_KEY` is set in the environment, but Cerebras currently rejects it with `wrong_api_key`.
- A live run therefore records `cerebras:gpt-oss-120b` in `after_failed` and returns the deterministic `FALLBACK` concept and gameplay.
- Tests run with `DCS_PROVIDERS_OFFLINE=1` and never touch the network. The LLM paths are exercised only through injected transports.
- No credential is logged or persisted.

## 9. Contract additions (all optional, add-only)

- **GameState:**
  - `pending: [action]` — start effects waiting to be delivered;
  - `unlocked: [id]`;
  - `visited: [region_id]` — needed for `reach_region` win conditions.
- **Objective:** `item_ref?` — the item a `deliver` objective needs.
- **Effects:** `respawn { ref: spawn_id, reason }`, `level_up { value }`, `objective_active { ref }` and `objective_complete { ref }`, alongside the fired actions.
- **ProvenanceStage:** `cost_is_estimate: true`.
- **`npc_state` values:** `talk`, `arrived`, `lost`, `dead` and `defeated` are allowed in addition to the §6 behaviour states.

## 10. Known gaps

- **Icons.** `icon_ref` holds a logical ref (`icon:<item_id>`) rather than an `asset_id`. It resolves through `AssetRecord.ref` under §4.1a, but a validator that insists on `ast_…` ids would reject it.
- **Regions.** The engine does not track which region the player is currently in; `enter_region` is an edge event. A `reach` objective completes only on an entry made while it is active.
- **Survive.** `survive` with a `target_ref` region counts every active second; it does not yet check that the player is inside the region.
- **Combat.** `combat.mode: "melee"` and `player_damage` are carried through but nothing generates attacks. Hazard damage is applied by the sim sending `damage` events.
- **Solver.** It proves logical order and locks; physical reachability depends entirely on the `reachable` callback.
- **Costs.** Price constants are estimates and are not refreshed automatically.
- **Live LLM paths.** No live model output has been observed, because the Cerebras key is rejected. Only the repair logic is covered, through injected fixtures.
- **Lint.** `solver.mjs` is isomorphic but is not in the lint list in `test/gamesb-iso-lint.test.mjs`, which is parent-owned.
