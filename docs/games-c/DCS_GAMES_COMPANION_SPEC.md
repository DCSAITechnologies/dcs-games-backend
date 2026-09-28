# DCS GAMES — Companion chat editing (GAMES-C, agent 1)

Status date: 28 Sep 2026 · Worktree `~/Developer/dcs-games-c-systems` (branch `games-c/systems-28sep2026`) · Not committed (lead commits).

The companion turns a creator's sentence into a **structured patch** (CONTRACT.md "Patch contract"). It never executes code, never fetches, and never calls a provider. It proposes data; `src/v3/gamesc/patch` validates and applies it.

## Status labels

| Capability | Label | Evidence |
|---|---|---|
| Deterministic intent parser (8 categories, 30+ phrasings) | **PROVEN** | `test/gamesc-companion.test.mjs` — every example becomes a patch that passes `validatePatch`, `applyPatch` and `validateManifest` |
| Multi-intent → one ordered patch | **PROVEN** | "make it night and add two enemies", "stormy night, then add three wolves near the tower" |
| Pronouns within an utterance and across turns ("it", "them") | **PROVEN** | "add a tower and move it east"; "add a tower" → "move it east"; "add two enemies" → "move them north" |
| Clarification (ambiguous / missing slot / unknown target / quest dependency / owned entity) | **PROVEN** | clarification suite |
| Honest unsupported response + capability list | **PROVEN** | unsupported suite; same `supported` shape the existing 422 uses |
| Input safety (injection, markup, URLs, paths, code, secrets) | **PROVEN** | 15 rejection cases; nothing reaches ops or context |
| Clamping (counts, speeds, jump, gravity, move distance, coordinates) | **PROVEN** | clamp test |
| Determinism / no mutation of the input manifest | **PROVEN** | determinism suite |
| Rolling context `toContext()/fromContext()` (plain JSON, hostile input sanitised) | **PROVEN** (module) / **DESIGN-ONLY** (persistence — owned by the memory agent) | context suite |
| `llmPropose` model-assist seam (untrusted JSON → strict schema → `validatePatch`) | **PROVEN** with fake adapters; **DESIGN-ONLY** with a real model (no provider wired; offline by default) | 12 hostile proposals rejected; valid one accepted with confidence ≤ 0.6 and `requires_confirmation` |
| `gameplay.player.*`, `gameplay.rules.difficulty`, `ui.*` edits | **PARTIAL** — patches apply and validate (fields are whitelisted by the patch module as `source:"added"`), but **no runtime reads them yet** | patch whitelist |
| `expand_area` | **PROVEN** for the manifest (reuses `planner.planExpansion`) / **PARTIAL** for play: the navigation link and terrain extension from the delta can't be written as patch ops, so they are dropped and listed in `notes` | forest test |
| Server route integration | **DESIGN-ONLY** — proposed diff below, not applied | — |

## Architecture

```
utterance ─► safety.screenInput ──(unsafe)──► status:"rejected", no ops
                │
                ▼
        index.splitClauses   (split on and/then/,/;/. only where a VERB follows)
                │
                ▼  per clause, first handler that claims it wins (intents.HANDLERS):
   objective → rename → ui → lighting_weather → gameplay_rule → asset_replace
             → remove → move → resize → add (enemy | npc | structure | expand_area)
                │         ▲
                │         └─ resolve.resolveEntity (fuzzy match over manifest + entities
                │            added earlier in the same utterance; pronouns from context)
                ▼
   combine: any clarify ⇒ clarify (no ops) · some unknown ⇒ clarify (no ops)
            all unknown ⇒ unsupported + capabilities · else ok (ops concatenated in order)
                │
                ▼
   buildPatch(result, manifest)  → patch envelope via patch.createPatch (base_hash pinned)
```

Files (all in `src/v3/gamesc/companion/`):

| File | Role |
|---|---|
| `index.mjs` | Public API: `interpret`, `interpretWithAssist`, `buildPatch`, `createCompanionSession`, `splitClauses`, `capabilities`, context re-exports, `patchModuleAvailable` |
| `intents.mjs` | Clause handlers (the grammar). Pure; build values only from closed vocabularies |
| `lexicon.mjs` | Synonym tables, number words, directions, `SET_PATHS`, `LIMITS`, `CAPABILITIES` |
| `resolve.mjs` | Entity index + fuzzy matching (synonyms, plural, Levenshtein ≤ 1 for ≥ 5-letter words), positions |
| `safety.mjs` | `screenInput`, `isUnsafeString`, `cleanFreeText`, `clamp` |
| `context.mjs` | Rolling context: `emptyContext`, `fromContext`, `toContext`, `advanceContext` |
| `llm-seam.mjs` | `validateProposal`, `llmContextFor`, timeout helper |

Reuse, not duplication: `providers/asset3d.buildAsset` (curated assets for new buildings/characters and knight-style replacements), `expansion/planner.planExpansion` (area expansion, flattened into add ops), `expansion/planner` night value (0.02) and enemy-tuning semantics, `manifest/schema` enums, and the patch module's `createPatch` / `validatePatch` / `applyPatch`. `companion/companion.mjs` (Q&A, grounded answers) and `npc-memory.mjs` are left alone; this module handles *editing*, not answering questions.

## API

```js
import { interpret, buildPatch, createCompanionSession, interpretWithAssist } from "./src/v3/gamesc/companion/index.mjs";

const r = interpret("make it night and add two enemies", manifest, { context });
// r = { status:"ok"|"clarify"|"unsupported"|"rejected", category, categories[], ops[], summary,
//       confidence, clarification|null, options?, capabilities?, reasons?, notes[], clamped?,
//       clauses:[{text,status,handler,category}], source:"rules", context }
const patch = buildPatch(r, manifest, { text, author:{kind:"companion", id:userId} });  // null unless ok
```

`interpret` is synchronous, deterministic and pure (it doesn't mutate the manifest, read a clock or use randomness). `buildPatch` stamps `created_at` (pass `now` for determinism).

## Supported intents

North is **−z**, east is **+x**. `left/right` = west/east and `forward/back` = north/south, taken from the spawn camera. The default step is 10. "a bit" is 4, "a lot"/"far" is 30, and "by N" is clamped to 200.

| Category | Example utterances | Ops |
|---|---|---|
| lighting_weather | make it night / dusk / dawn / day · make it rain / foggy / sunny / snowy / stormy · clear the fog · stop the rain · make it darker/brighter · change the weather to snow | `set environment.time_of_day` (night 0.02, dawn 0.27, midday 0.5, dusk 0.78) · `set environment.weather` (schema `WEATHERS` only) |
| scene | add a tower near the castle · add a well at 10, 10 · put a castle north of the tower · move the castle north / to 10, 20 / closer / towards the tower / next to the tower / to the north · make the castle bigger/smaller/taller · remove the tower · rename the world to X · rename the castle to X | `add assets`+`add structures` · `move structures` · `update zones.bounds` (zone move) · `update structures.footprint` · `remove interactions`→`remove structures` (cascade) · `set meta.title` · `update structures.purpose` |
| npc | add two enemies · add an enemy near the castle · add three wolves near the tower · add 3 guards next to Tomas · add a merchant named Bob · rename Tomas to Tom · move Tomas east · remove the goblins | per character: `add behaviors` (enemy_ai / npc_ai) → `add npcs` → `add interactions` (+ `add assets` if the archetype is missing) · `update npcs.name` · `move npcs` · remove cascade incl. orphaned behaviours |
| gameplay_rule | make the player faster/slower · set player speed to 8 · make the player jump higher · lower the gravity / moon gravity / no gravity · make it harder / set difficulty to easy · make enemies harder/weaker | `set gameplay.player.move_speed` (default 5, 0.5–30) · `set gameplay.player.jump_height` (default 1.5, 0–20) · `set environment.gravity` (−30…−1) · `set gameplay.rules.difficulty` · `update behaviors.spec` |
| asset_replace | replace character with a knight · make me a knight · replace the tower with a castle · turn the tower into a chapel | `replace_asset` (same id, curated archetype, `composition.style`, **no uri**) · `add assets`+`update structures.asset_ref,purpose` |
| ui | hide the minimap · show the hud · hide the hud and the minimap · show objectives · hide the crosshair | `set ui.minimap` / `ui.hud_visible` / `ui.show_objectives` / `ui.crosshair` |
| objective | change mission to rescue the princess · set the goal to … · new objective: … | `update quests[0].title,description`, or `add quests` (reach first zone / survive) when none exist |
| expand_area | add another area · add a forest · add a village called Brook · add a market district | `planExpansion` delta flattened in dependency order: zones, assets, items, structures, behaviors, npcs, interactions, quests (owner_id stripped). One area per request |

## Clarification policy

The companion asks a question and emits **no ops** when:

- a target is **ambiguous** (two equally good matches; `options[]` lists them). A plural phrase ("the goblins", "all towers") picks every equal match instead;
- a target is **not found** (the reply names what does exist);
- a **slot is missing** ("rename the world", "move the castle", "change the mission to");
- a pronoun has no referent, or points at something that no longer exists;
- a removal would break a **quest** (giver or step target), or the entity has an `owner_id` (player-owned);
- a zone removal is requested (not supported, because it would strand the contents);
- someone asks to light a single object ("make the tower brighter"). Lighting is world-wide, so the companion asks rather than faking it;
- an add names an **unknown noun** ("add a unicorn"). The reply lists what can be added;
- a multi-intent utterance is **partly understood**. The companion says which part it understood and asks whether to go ahead with just that part. It never half-applies;
- there are more than 6 clauses, or more than 64 ops.

An utterance that is **entirely unknown** gets `status:"unsupported"`, with `capabilities` listing each category and its examples. No guessing.

## Safety

- `screenInput` rejects the **whole utterance** (`status:"rejected"`, `reasons[]`) for: prompt-injection phrasing ("ignore previous instructions", "system prompt", "you are now…"), HTML/script markup and `on*=` handlers, `javascript:`/`data:`/`file:` and other schemes, http(s)/www/bare domains, file paths (`../`, `~/`, `/etc`, `C:\`), code (`eval(`, `require(`, `${}`, backticks, `=>`, `process.env`), shell/SQL fragments, and secrets vocabulary. It also strips control and zero-width characters first, and enforces a 500-character cap. The rejected text is **not** stored in context (it's recorded as `[rejected input]`).
- Op values come from closed vocabularies and `buildAsset`. The only free text that reaches an op (world title, mission, NPC/area names) goes through `cleanFreeText`: letters, digits, space and `'’.,!?&-` only, max 80 characters.
- No op the companion builds contains a URI. `replace_asset` values are curated archetypes. `owner_id` is never written.
- Clamps (`LIMITS`): enemies/NPCs/structures ≤ 5 per request (the summary says "capped at 5; you asked for 50"), move ≤ 200, coordinates ±4096, y 0–512, speed 0.5–30, jump 0–20, gravity −30…−1, 64 ops per patch.
- Defence in depth: the patch module re-checks every op (`checkData`, whitelist, `validateManifest`, dangling refs).

## Context format (for the memory agent)

```json
{ "context_version": 1,
  "turns": [ { "text": "add a tower", "status": "ok", "categories": ["scene"], "summary": "added 1 tower" } ],
  "last_entities": [ { "collection": "structures", "id": "struct_tower_1", "label": "Tower" } ],
  "last_category": "scene" }
```

- The context holds at most 8 turns and 8 entities. It has no timestamps, functions or class instances, so it is safe to `JSON.stringify`.
- `fromContext(untrusted)` never throws. It drops unknown collections, unsafe ids, unknown categories and non-objects, and cleans the text.
- `interpret` returns the next context as `result.context`. `createCompanionSession({context})` keeps it for you, and `session.toContext()` exports it.
- `last_entities` updates only on an `ok` result, so a clarification doesn't lose the previous "it".

## `llmPropose` seam contract

```js
await interpretWithAssist(text, manifest, { context, llmPropose, validatePatch /* defaults to patch module */, timeoutMs: 4000 });
```

1. The rules run first. The adapter is consulted **only** when the rules return `unsupported`. It is never consulted for `rejected` input or for anything the rules understand.
2. The adapter receives `(text ≤ 500 chars, { categories, op_kinds, set_paths, capabilities, entities:[{collection,id,label}] ≤ 50 })`. It gets labels, never the raw manifest.
3. Its output (an object or a JSON string ≤ 16 KB) is **data**. It is parsed with `JSON.parse` or round-tripped through `JSON.stringify`, and never goes through `eval`, `Function` or `import`. Validation is strict:
   - top-level keys must be `{category, ops, summary, confidence}`, and `category` must be in `CATEGORIES`;
   - ops are `set|add|remove|update|move` only. **`replace_asset` is never accepted from a model**, and each op may carry only its exact keys;
   - `set` paths must be in `SET_PATHS`, with scalar values only;
   - ids must match `^[a-z0-9_]{1,64}$`, positions must be finite and within ±4096, and nesting may go at most 6 levels deep;
   - keys `__proto__ constructor prototype owner_id script uri url href src` are banned, and every string goes through `isUnsafeString`.
4. The proposal is then wrapped by `buildPatch` and must pass `validatePatch(patch, manifest)`. **If no validator is available, the seam fails closed.**
5. An accepted proposal returns `source:"llm_assist"`, `requires_confirmation:true`, and a confidence capped at 0.6. The UI must show the summary and ask before applying.
6. If the adapter throws or times out, the companion falls back to the honest `unsupported` answer, with `llm.reasons` set to `["adapter_error"|"timeout"]`.

Default: no adapter. Everything runs offline and makes no provider calls.

## Integration proposal for `server.mts` (not applied — for the lead)

This keeps `planEdit` first, so existing behaviour and tests (E2E 11 "make it rain", lead-review "make it brighter", route-authz) are unchanged. The companion replaces only the `edit_not_understood` 422 path. The unsupported shape keeps `supported`, as E2E 11 asserts.

```diff
@@ imports (near line 27)
 import { planExpansion, planEdit } from "./src/v3/expansion/planner.mjs";
+import { interpret as companionInterpret, buildPatch as companionBuildPatch } from "./src/v3/gamesc/companion/index.mjs";
+import { applyPatch as applyEditPatch } from "./src/v3/gamesc/patch/index.mjs";

@@ POST /v3/worlds/:id/edit (≈ line 1691)
         const plan = planEdit(before, { request: b.request, author: me.id });
-        if (plan.error) {
-          // Honest: an unrecognised edit is a 422 that says what IS supported.
-          return send(res, 422, { ok: false, error: "edit_not_understood", detail: plan.error, supported: plan.supported, hint: plan.hint, correlation_id: cid });
-        }
+        let editManifest = null, editSummary = plan.summary, editIntent = plan.intent, editPatchId = null, companionCtx = undefined;
+        if (plan.error) {
+          // GAMES-C companion: structured patch instead of a fixed-intent 422.
+          const cr = companionInterpret(b.request, before, { context: b.companion_context ?? null });
+          companionCtx = cr.context;
+          if (cr.status !== "ok") {
+            const code = cr.status === "rejected" ? 400 : 422;
+            const error = cr.status === "clarify" ? "edit_needs_clarification" : cr.status === "rejected" ? "edit_rejected_unsafe" : "edit_not_understood";
+            return send(res, code, { ok: false, error, detail: cr.clarification || cr.summary, clarification: cr.clarification, options: cr.options,
+              supported: cr.capabilities || plan.supported, hint: plan.hint, reasons: cr.reasons, companion_context: companionCtx, correlation_id: cid });
+          }
+          const patch = companionBuildPatch(cr, before, { text: b.request, author: { kind: "companion", id: me.id } });
+          const ap = applyEditPatch(before, patch);
+          if (!ap.ok) return send(res, 422, { ok: false, error: "edit_patch_invalid", detail: "the companion's patch did not validate", errors: ap.errors.slice(0, 6), correlation_id: cid });
+          editManifest = ap.manifest; editSummary = cr.summary; editIntent = `companion:${cr.categories.join("+")}`; editPatchId = patch.patch_id;
+        }
         const live = (await liveStateFor(mm[1], b.live_state)).live;
-        const applied = applyDelta(before, plan.delta, live);
-        const gate = await playtestAndRepair(applied.manifest, { liveState: live });
+        const applied = editManifest ? { manifest: editManifest } : applyDelta(before, plan.delta, live);
+        const gate = await playtestAndRepair(applied.manifest, { liveState: live });
         ...
-        await worldMemory.record(rec.world_id, { kind: "edited", summary: plan.summary, ..., detail: { request: b.request, intent: plan.intent } });
-        return send(res, 200, { ok: true, world_id: rec.world_id, summary: plan.summary, intent: plan.intent, ...
+        await worldMemory.record(rec.world_id, { kind: "edited", summary: editSummary, ..., detail: { request: b.request, intent: editIntent, patch_id: editPatchId } });
+        return send(res, 200, { ok: true, world_id: rec.world_id, summary: editSummary, intent: editIntent, patch_id: editPatchId, companion_context: companionCtx, ...
```

Notes for the lead:

- The playtest gate and `verifyPreservation` still run on the patched manifest, so live-state protection is unchanged. The patch path doesn't call `applyDelta`, so live-state checks happen only at `verifyPreservation`. That is sufficient, because the companion never removes owned entities and refuses quest-dependent removals.
- `applyPatch` bumps `world_version`, and so does `applyDelta`. Check that `repo.upsert` doesn't bump it a second time for the companion path.
- `companion_context` round-trips through the client until the memory agent persists it (`toContext()`/`fromContext()`).
- `package.json` needs `test/gamesc-companion.test.mjs` added to `test:unit`. The CI gate `test/ci-coverage.test.mjs` ("every test file is referenced by an npm script") currently fails for all seven `gamesc-*` test files until that's done.

## Known limits (honest)

- The grammar is English-only and rule-based. Paraphrases outside the tables return `unsupported`. That is by design until a model adapter is wired and reviewed.
- Lighting is world-wide only. There are no per-object lights or colour palettes (`environment.palette` is whitelisted but not yet emitted).
- `expand_area` drops the navigation link and terrain extension from the planner delta, and reports this in `notes`.
- There is no clarification follow-up resolution yet: a reply like "the first one" to an `options[]` question is not wired. It is **DESIGN-ONLY**; the UI can resend the chosen id.
- Player speed and jump defaults (5, 1.5) are assumptions, because no runtime field exists yet.
