# DCS Games-B: character, NPC and interaction system

Code: `src/gamesb/characters/`. Contract: `src/gamesb/CONTRACT.md` §6 (with §1, §4.5 and §5).
Tests: `node --test test/gamesb-characters*.test.mjs`.

| File | Isomorphic | Role |
|---|---|---|
| `characters.mjs` | no (but has no Node imports) | `generateCharacters({ concept, world })` builds a CharactersSpec. It is deterministic. |
| `character.schema.mjs` | yes | `validateCharacters(spec, ctx?)` and `validateDialogues(specOrDialogues, ctx?)` |
| `npc-brain.mjs` | yes | `createNpcState`, `stepNpc`, `setNpcState` |
| `dialogue.mjs` | yes | `openDialogue`, `availableChoices`, `choose`, `evalCondition` |
| `index.mjs` | no | Re-exports all of the above. The browser should import the iso files directly. |

## 1. Character spec

The generator creates one character per `concept.characters[]` entry. Each character gets its own RNG stream, `seeded(concept.seed ^ hashString("char:" + id))`, so adding or removing one character never changes the others. A test asserts this.

- **Fixed ids.** `asset_ref = "char:<id>"`, `spawn_ref = "spawn_npc_<id>"`, and `dialogue_ref = "dlg_<id>"` for every role except `enemy`, which gets `null`.
- **`kind`.**
  - Keywords in the name or description win: robot/drone/machine gives `robot`, and spirit/ghost/wisp gives `spirit`.
  - Otherwise it follows the role and biome:
    - The companion is a `creature`. It is a `robot` on `scifi_base` and a `spirit` in `ruins`.
    - An enemy is a `robot` in scifi_base or city, a `spirit` in ruins or volcanic, and a `creature` elsewhere.
    - Everyone else is `humanoid`.
- **Flags.** `companion: true` goes on the first `companion`-role character only. The validator rejects more than one. `invulnerable` is false only for `enemy` and `creature`.
- **`interaction_radius`.** 0 for enemies, 3 for the companion and 2.5 for everyone else.

## 2. Body and accessory model

`body = { height, build, palette{skin,primary,secondary,accent}, accessories[], locomotion?, glow? }`

| Role | Kind | Height (m) | Accessories | Palette |
|---|---|---|---|---|
| quest_giver | humanoid | 1.62–1.9 | `hood`, `lantern` (keeper). On scifi_base or city: `goggles`, `backpack` | primary is the concept primary, darkened |
| merchant | humanoid | 1.62–1.9 | `satchel`, `hat` | primary is the concept secondary |
| guard | humanoid, broad build | 1.62–1.9 | `hat` (read as a **helmet**), `staff`, `cape` | darkened primary and secondary |
| ambient | humanoid | 1.62–1.9 | one of `hat`, `backpack`, `scarf` | ground-toned |
| companion | creature, robot or spirit | 0.55–0.9 | none (plus `scarf` in snow) | light, with accent-tinted skin |
| enemy / creature | robot, spirit or creature | 0.9–1.3 for a creature, 1.9–2.4 otherwise | none | very dark, with `glow` set to the concept accent |

Biome extras for humanoids: `scarf` in snow, and `goggles` in desert or sandstorm.

## 3. Rig expectations for the asset stage and renderer

The asset stage builds the `char:<id>` mesh recipe from `body`, with `rig.kind` taken from `body.locomotion`: `biped`, `quadruped` or `hover`. For the runtime's procedural walk cycle, the joint names should be:

- **biped:** `root`, `hips`, `torso`, `head`, `arm_l`, `arm_r`, `leg_l`, `leg_r`
- **quadruped:** `root`, `torso`, `head`, `leg_fl`, `leg_fr`, `leg_bl`, `leg_br`, `tail`. Where only two leg joints are practical, use `leg_l` and `leg_r` with `tail`.
- **hover:** `root`, `torso`, `head`, and optionally `arm_l` and `arm_r`. There are no legs. The renderer bobs the root, and it lights `glow` as an emissive part (the "eye" or core).

Accessories attach as follows:

| Joint | Accessories |
|---|---|
| `head` | hat, hood, goggles |
| `torso` | cape, backpack, scarf, satchel |
| `arm_r` | lantern, staff |

The joint names are a **recommendation** and not part of the contract. The contract only says `joints: {...}`.

The brain's `anim` field drives the cycle:

- `idle`: no movement this step
- `walk`: moving at up to 3.2 m/s
- `run`: faster than 3.2 m/s
- `talk`: in conversation

`rotation_y = atan2(dx, dz)`, so 0 faces +z (the Three.js convention).

## 4. Behaviour states and transitions

The role presets are below. Distances are in metres and speeds in m/s.

| Role | Initial state | Speed | Sight | Leash | Near → | Far → | Hostile |
|---|---|---|---|---|---|---|---|
| companion | follow_player | 6.2 | 12 | 40 | – | – | no |
| quest_giver, merchant | idle | 1.4 | 6 | 6 | – | – | no |
| guard | patrol (a 4-point loop in its region) | 1.8 | 8 | 20 | idle | patrol | no |
| enemy | patrol | 3.6 | 14 | 30 | chase | patrol | yes |
| creature | patrol | 3.2 | 10 | 24 | chase | patrol | yes |
| ambient | wander (radius 8) | 1.2 | 5 | 12 | – | – | no |

**Patrol loops.** The four patrol points sit around the NPC spawn at 0.3 × the region's short side, clamped to 3–12 m. They are kept inside the region and the world, and each is snapped to the nearest walkable nav cell. If there is no world, or fewer than two points survive, the NPC falls back to `guard`.

**Companion speed.** 6.2 m/s is chosen to beat an **assumed** player walk speed of 4.5 m/s (`ASSUMED_PLAYER_WALK`). The gameplay stage sets the real walk speed later.

What each state does in `stepNpc`:

| State | Behaviour |
|---|---|
| **idle** | Stands still and turns to face the player inside `sight_radius`. |
| **guard** | Returns to `home` (the spawn) if it has drifted more than 1 m away, then faces the player. |
| **patrol** | Walks the points in order and loops. `patrol_idx` advances on arrival (0.6 m) or when a point is unreachable. |
| **wander** | Picks a random target within `wander_radius` of home using `ctx.rand`. The target must be unblocked, and it must be either in line of sight or reachable by a path that stays inside radius + 1. After arriving it lingers for 1–3 s. |
| **follow_player** | Targets a point 3 m behind the player on the NPC's side. It moves once the gap leaves [2, 3.25] m, at 1.5× speed when more than 8 m behind. Beyond 40 m it teleports to a free spot about 3 m from the player. |
| **flee** | Moves directly away from the player at 1.25× speed. It fans out ±45°, ±90° and ±135° when a wall is in the way, and stops once it is more than max(2 × sight, 20) m away. |
| **chase** | Paths to the player and stops at 1.2 m. It **gives up** when the NPC is more than `leash_radius` from home, or the player is. It then switches to `on_player_far` (or the initial state) with `returning: true`, walks home, and ignores the player until it arrives. |

**Transitions.**

- `on_player_near` fires when the player is within `sight_radius` and the NPC is in a resting state: its initial state or its `on_player_far` state.
- `on_player_far` fires when the distance exceeds 1.2 × sight. The 1.2 factor is hysteresis.
- A chase is never started toward a player who is already outside the leash.
- A state forced by gameplay through `set_npc_state` (for example flee) is not overridden by the near/far transitions.

**Steering.**

- If the straight line to the goal is clear (sampled every 0.4 m), the NPC walks it.
- Otherwise it calls `ctx.findPath`. The result is cached, re-planned every 1 s, and re-planned at once if the goal moves more than 1.5 m.
- Up to four path nodes that are in line of sight are skipped, which smooths the grid staircase.
- Every step candidate is checked with `ctx.isBlocked`: the full step first, then an x-only or z-only slide. If all three are blocked, the NPC stays put and re-plans on the next step.

**The invariant.** An NPC never ends a step on a blocked cell. The tests check this every step for 10,000 steps per character, with a randomly moving player that sometimes sprints.

`y` comes from `ctx.heightAt`.

**State shape.** The state keeps the §6 fields and adds `home`, `path`, `path_goal`, `repath_t`, `patrol_idx` and `returning`. All of them are plain JSON. SaveState stores only `{position, state}`, so a restored NPC re-derives `home` from its spawn and re-plans its path. This is intended.

## 5. Dialogue model

`dialogues[] = { id, character_ref, entry[{node, conditions}], nodes[{id, speaker, text, choices[{text, next, conditions?, actions?}]}] }`. The first entry whose conditions all hold wins.

The generated trees use only `flag` and `has_item` conditions. They use no objective ids, because gameplay is generated later.

| Role | Tree |
|---|---|
| quest_giver | Entries in order: one `progress` entry per pickup `item_*` in the world (`has_item`), `welcome_back` (flag `met_<id>`), then `first_meet`. Every choice out of `first_meet` sets `met_<id>`. `lore` offers 2–3 choices that branch to one or two location nodes. `task` names the concept's locations. |
| companion | `intro` (sets `met_<id>` and `set_npc_state follow_player`) → `banter`. Its choices are `sense`, "stay here" (`set_npc_state idle`) and "stay close" (`set_npc_state follow_player`). |
| merchant | `shop` ↔ `wares` / `rumour` |
| guard | `halt` (sets the met flag) and `again` → `warn`. `warn` quotes the concept's first hazard. |
| creature | A single node, "back away slowly". |
| ambient | `chat` → `place` |

The text interpolates the concept title, the logline, the location names and descriptions, the weather and the mood.

**Runner semantics** (`dialogue.mjs`):

- **Conditions.**
  - `has_item` means `inventory[ref] >= (value ?? 1)`.
  - `objective_state` treats a missing objective as `"locked"`.
  - An unset `flag` equals `false`.
  - Unknown condition kinds fail closed.
- **Nodes.** `openDialogue` returns `{ dialogue_id, node, dialogue }` with the node **object**. Every function also accepts a node id.
- **Choice indices.** `choose(dialogue, node, choiceIdx, gs)` indexes **visible** choices, the same list `availableChoices` returns. The runtime's 1–4 keys map to what is shown.
- **Result.** `choose` returns `{ node: next|null, actions }` and does not apply the actions; the rules engine applies them. An out-of-range index returns `{ node: <same>, actions: [], invalid: true }`.

**Validation** (`validateDialogues`). These are all errors:

- an entry or `next` that does not resolve
- a node that no entry can reach
- a reachable node that can never reach a `next: null` exit (a loop with no exit)
- a node with 0 choices, or more than 4
- an action kind outside §5
- `set_npc_state` without a valid state, or a ref-bearing action without a `ref`
- a malformed condition

These are warnings:

- a node whose choices are all conditional
- a conditional last entry, which leaves some states with no dialogue

## 6. Interaction binding

The world stage emits a `talk` interactable `ix_talk_<id>` (with `placement_ref: null` and `character_ref: <id>`) for every non-enemy character, and the runtime binds its position to the NPC each frame. On interact, the runtime is expected to:

1. Emit the rules event `{kind:"talk", ref:<id>}`.
2. Call `openDialogue(pkg.characters, id, game)`.
3. Pass `ctx.talking = id` to `stepNpc` so the NPC holds still, faces the player and plays `talk`.
4. Feed each `choose` result's `actions` to the rules engine.

`ctx.talking` is an optional addition to the §6 ctx. Hostile `creature`s get a one-node "back away" dialogue, because §4.5 gives every non-enemy an `ix_talk_`.

## 7. Companion hook

The single `companion: true` character is the one `pkg.hooks.companion.character_ref` should name. The existing `/v3/worlds/:id/companion` endpoint (`src/v3/companion/companion.mjs`, with the adopt, follow, dismiss, ask and caption actions) supplies persistence and grounded Q&A. The mapping is:

- `adopt` ↔ the companion `intro` choice
- `follow true/false` ↔ `set_npc_state follow_player/idle`
- `ask` answers from `hooks.companion.knowledge`

Nothing in `src/gamesb/characters/` imports `src/v3`, because the iso rule forbids it. The wiring belongs to the package or server layer.

## 8. Known gaps

- There is no combat or damage in the brain. `hostile` and the chase state are exposed, and contact damage is the rules and sim layer's job (via `hazards.sentinel`).
- Steering is cell-occupancy only. It ignores capsule radius and `buildColliders` solids that are not in the nav grid, so the sim should still run `resolveCapsule` for NPCs if props are not baked into `walkable`.
- There is no NPC–NPC avoidance, and there is no line-of-sight test for "sight". Sight is a radius through walls.
- Follow uses teleport catch-up at 40 m with no fade. The renderer may want to hide the pop.
- Dialogue text is template-authored and is not produced by a model. There is no localisation.
- The 4.5 m/s player walk speed is an assumption until gameplay is generated.
- `validateCharacters` checks patrol points against the world bounds (an error) and the nav grid (a warning). It does not check that the points are reachable from the spawn.
