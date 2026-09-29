# DCS GAMES — Edit Patch Schema (GAMES-C, patch agent)

Module: `src/v3/gamesc/patch/` (`index.mjs`, `whitelist.mjs`, `safety.mjs`, `history.mjs`)
Tests: `test/gamesc-patch.test.mjs` — run with `node --test test/gamesc-patch*.test.mjs`
Builds on: `src/v3/manifest/schema.mjs` (validateManifest, enums), `src/v3/expansion/delta.mjs`
(COLLECTIONS, MODIFIABLE, specRefsOf). Zero dependencies; Node built-ins only (`node:crypto`, `structuredClone`).

Status labels: **PROVEN** = backed by a named test in `test/gamesc-patch.test.mjs`.
**DESIGN-ONLY** = specified, not wired or not consumed yet.

---

## 1. Exported API

| Export | Signature | Notes |
|---|---|---|
| `PATCH_VERSION` | `"1"` | |
| `OP_KINDS` | `["set","unset","add","remove","update","move","replace_asset"]` | `unset` added: it is the exact inverse of a `set` on a path that did not exist |
| `EDIT_CATEGORIES` | scene, asset_replace, gameplay_rule, npc, lighting_weather, ui, objective, expand_area | checked on `intent.category` |
| `canonicalJSON(value)` | `-> string` | sorted keys, `undefined` members dropped, cycles throw |
| `hashManifest(m)` | `-> "sha256:<64hex>"` | **content** hash; excludes `world_version`, `meta.updated_at`, `provenance.manifest_hash` (`VOLATILE_PATHS`) |
| `validatePatch(patch, manifest?, opts?)` | `-> {ok, errors:[{op_index, path, message, code?}]}` | never throws; without a manifest = shape/safety only; with a manifest = full dry-run (identical verdict to `applyPatch`) |
| `applyPatch(manifest, patch, opts?)` | `-> {ok, manifest\|null, inverse\|null, errors, warnings}` | pure; deep-copies; bumps `world_version` by 1; result must pass `validateManifest` |
| `invertPatch(patch, manifestBefore)` | `-> patch` | equals `applyPatch(...).inverse`; throws if the patch does not apply |
| `replayPatches(base, patches[], opts?)` | `-> {ok, manifest, applied, errors}` | stops at first failure; `manifest` = last good state; errors carry `patch_index` |
| `diffManifests(a, b)` | `-> ops[]` | ops that turn `a` into `b` over the patchable surface |
| `diffManifestsDetailed(a, b)` | `-> {ops, exact, uncovered[]}` | replays the ops to prove exactness; lists top-level keys it cannot express |
| `createPatch({manifest, ops, author, intent?, created_at?, world_id?})` | `-> patch` | fills base_version/base_hash; deterministic `patch_id` |
| `rebasePatch(patch, manifest)` | `-> patch` | re-pins base fields (used by undo/redo) |
| `createEditHistory(manifest, {limit=500})` | `-> {apply, undo, redo, canUndo, canRedo, current, currentHash, list, size, cursor}` | linear undo/redo; redo tail truncated on new apply |
| also | `SET_PATH_WHITELIST`, `SET_PATH_SPECS`, `UPDATE_FIELDS`, `MOVE_TARGETS`, `ASSET_URI_ALLOWLIST`, `LIMITS`, `COLLECTIONS`, `AUTHOR_KINDS`, `VOLATILE_PATHS`, `looksLikeCode`, `looksLikeUrl`, `POLLUTION_KEYS` | |

`opts.trusted` (applyPatch / validatePatch / replayPatches): **server-held patches only** (inverses the
engine produced, history redo, diff replay). It skips the content heuristics (code/URL), the per-collection
field whitelist, the owned-entity removal guard and the asset-uri allowlist. Structural checks (types,
finiteness, pollution keys, ids, enums, validateManifest, dangling refs) always run. Never pass it for a
client- or companion-supplied patch.

## 2. Patch shape

```json
{ "patch_version": "1", "patch_id": "p_<8-64 hex>", "world_id": "w_…",
  "base_version": 7, "base_hash": "sha256:<64 hex>",
  "author": { "kind": "user|companion|system", "id": "…" },
  "intent": { "text": "make it snow", "category": "lighting_weather" },
  "created_at": "2026-09-28T00:00:00.000Z",
  "ops": [ … 1..64 ops … ],
  "inverse_of": "p_…"            // only on inverses
}
```
Unknown top-level keys are rejected unless prefixed `x_`. `patch_id` from `createPatch` is
`"p_" + sha256(canonicalJSON(patch without patch_id))[0:24]` — deterministic.

## 3. Ops

| op | shape | effect | inverse |
|---|---|---|---|
| `set` | `{op, path, value}` | write a whitelisted path; creates missing ancestor objects | `set` old value, or `unset` with `prune` = ancestors it created |
| `unset` | `{op, path, prune?}` | delete a whitelisted leaf, then up to `prune` now-empty ancestors | `set` old value |
| `add` | `{op, collection, value:{id,…}, index?}` | insert entity (append, or at `index`) | `remove` |
| `remove` | `{op, collection, id}` | delete entity | `add` with the removed value **and its original index** (so array order, hence hash, is restored) |
| `update` | `{op, collection, id, set?:{field:v}, unset?:[field]}` | replace/delete top-level fields of an entity | `update` restoring old values / unsetting fields that did not exist |
| `move` | `{op, collection, id, position:{x,y,z}}` | structures → `transform.position`; npcs → `spawn`; `player_spawns` → `spawn.player_spawns[id].position` | `move` to old position |
| `replace_asset` | `{op, asset_id, value:{…}}` | replace the whole asset entry, id preserved | `replace_asset` with the old entry |

Collections (`add`/`remove`/`update`): `zones, structures, npcs, items, quests, behaviors, interactions, assets`
(from `delta.mjs` COLLECTIONS). The contract's example `entities` is **not** a manifest collection and is
rejected. Zones are not movable (move their `bounds` via `update`). Ops execute in order; a later op sees
earlier ones; the inverse lists inverted ops in reverse order.

## 4. Set-path whitelist (`SET_PATH_SPECS`)

| path | type / bounds | source |
|---|---|---|
| environment.weather | enum `WEATHERS` (schema.mjs) | schema |
| environment.time_of_day | number [0,1] | schema |
| environment.gravity | number [-50,0] | schema |
| environment.sky / fog / ambient_light / directional_light / wind | null or plain object ≤4 KB | emptyManifest |
| environment.palette | ≤16 `#rrggbb` colours | assembly output |
| meta.title | string 1..120 | schema |
| meta.description | string ≤2000 or null | emptyManifest |
| meta.tags | ≤32 strings (1..40) | schema |
| meta.genre, meta.style | string ≤64 or null | emptyManifest |
| meta.gameplay_loop | string ≤500 or null | assembly output |
| physics.gravity | number [-50,0] | emptyManifest |
| physics.ground_friction | number [0,2] | assembly output |
| spawn.safe_radius | number [0,100] | emptyManifest |
| multiplayer.enabled | boolean | emptyManifest |
| multiplayer.max_players | int [1,64] | schema |
| companion.enabled | boolean | emptyManifest |
| runtime_config.render_distance | number [40,2000] | emptyManifest |
| runtime_config.streaming | boolean | emptyManifest |
| **gameplay.player.move_speed** | number [0.5,30] | **ADDED** |
| **gameplay.player.jump_height** | number [0,20] | **ADDED** |
| **gameplay.player.max_health** | int [1,10000] | **ADDED** |
| **gameplay.rules.difficulty** | enum easy/normal/hard | **ADDED** |
| **gameplay.rules.permadeath** | boolean | **ADDED** |
| **gameplay.rules.time_limit_s** | int [0,86400] or null | **ADDED** |
| **ui.hud_visible / ui.minimap / ui.show_objectives / ui.crosshair** | boolean | **ADDED** |
| **ui.theme** | enum default/dark/light/high_contrast | **ADDED** |

**ADDED** paths: WorldManifestV3 has no player/ui/gameplay-rule fields today. `validateManifest` ignores
unknown top-level keys, so these are structurally safe and fully patchable/undoable (PROVEN), but no runtime
in this repo reads them — their in-game effect is **DESIGN-ONLY** until the runtime consumes
`manifest.gameplay` / `manifest.ui`. "Objectives" are edited through the `quests` collection
(`update` title/steps/difficulty/…) and `meta.gameplay_loop`.

Deliberately **not** settable: `world_id`, `world_version`, `manifest_version`, `meta.maturity`
(moderation/publish decision), `meta.created_at`, `meta.creator_id`, `terrain.*`, `navigation.*`,
`provenance.*`, `expansion.*`, `spawn.respawn_policy` (only "nearest" exists; no enum to validate against).

## 5. Update-field whitelist (`UPDATE_FIELDS`)

Starts from `delta.mjs` MODIFIABLE, widened with reference fields (re-checked by validateManifest after apply):

| collection | fields |
|---|---|
| zones | name, ambience, tags, density, kind, bounds, parent_zone |
| structures | purpose, interactable, enterable, transform, footprint, asset_ref, zone |
| npcs | name, role, dialogue, schedule, faction, stats, behavior_ref, spawn, zone, asset_ref |
| items | name, effects, stackable, asset_ref, kind |
| quests | title, rewards, difficulty, steps, giver_npc, zone, prerequisites, description |
| behaviors | spec, kind |
| interactions | trigger, target_ref, behavior_ref, params |
| assets | name, tags, collision, lod, composition, primitive (uri/format/kind/license only via `replace_asset`) |

Never writable by an untrusted patch: `id`, `owner_id`, `script`, `uri` (except asset `uri` via the allowlist).
`add` may carry `owner_id: null` / `script: null` only.

## 6. Validation rules

Patch level: version, `p_<hex>` id, world_id match, integer base_version, `sha256:` base_hash, author kind/id,
intent category ∈ EDIT_CATEGORIES, ISO created_at, 1..64 ops, ≤256 KB canonical size; the patch is
`structuredClone`d first (Proxies/functions rejected; getters evaluated once — no check/apply TOCTOU).

**Stale edit:** `base_version !== manifest.world_version` **or** `base_hash !== hashManifest(manifest)` →
rejected with `code: "stale_base"`.

Op level:
- strict op keys (unknown keys rejected); op ≤32 KB canonical.
- every string/number/object inside a value: finite numbers only; depth ≤10; ≤256 keys; arrays ≤2048, no holes;
  strings ≤4000; plain objects only; keys match `[A-Za-z0-9_+\-.:#]{1,64}`;
  **`__proto__`, `constructor`, `prototype` rejected anywhere** (also in `unset` lists and at patch top level).
- **code heuristics** reject `<script|iframe|svg|img|…`, `on*=`, `eval(`, `Function(`, `new Function`, `import(`,
  `require(`, `=>`, `function(`, `document.|window.|globalThis.|process.`, `${…}`, `setTimeout(`.
- **URL heuristics** reject `scheme:` for http/https/ftp/file/ws/data/javascript/vbscript/blob/about/chrome,
  `//host.tld`, `www.` — everywhere except asset `uri`.
- asset `uri` must match `ASSET_URI_ALLOWLIST` (`/assets/…glb|gltf`, `dcs-asset://…`, `https://assets.dcsai.ai/…`), no `..`.
- enums from schema.mjs: WEATHERS, ZONE_KINDS, ASSET_KINDS, ASSET_FORMATS, BEHAVIOR_KINDS, TRIGGERS, QUEST_STEP_KINDS.
- typed fields: bounds `[minX,minZ,maxX,maxZ]` max>min; vec3 exactly `{x,y,z}` within ±100000; footprint
  positive ≤10000; density [0,1]; ids `[A-Za-z0-9_\-:.]{1,96}`.
- id existence (update/remove/move/replace_asset), id uniqueness (add), collection must exist, ≤5000 entries.
- `remove` of an entity with non-null `owner_id` is refused (player ownership).

Result level: `validateManifest(result).ok` must hold, and the edit must not create a **new** dangling
reference that validateManifest does not check (behaviour `spec` refs via `specRefsOf`,
`multiplayer.shared_zones`, `navigation.walkable_zones[].zone`). Pre-existing danglers are tolerated.

## 7. Guarantees and the tests that prove them

| Guarantee | Status | Test(s) |
|---|---|---|
| **Versioned** — each apply/undo/redo bumps world_version by exactly 1; stale base rejected | PROVEN | `roundTrip` helper (all op tests), "stale base_hash / base_version / world_id rejected", history test (`+6` after 6 transitions), property test (`+2·N` after N applies + N undos) |
| **Diffable** — `diffManifests(a,b)` replays to exactly `b`; identical manifests diff to `[]`; unexpressible changes reported, not hidden | PROVEN | "diffManifests yields ops that reproduce the target exactly", "diff reports what planner edits changed and what ops cannot express" |
| **Undoable** — every op kind: apply → inverse → identical content hash; `invertPatch == applyPatch().inverse` | PROVEN | "set (existing path)…", "set on a new nested path…", "unset…", "add / remove / update / move / replace_asset round-trip", "a multi-op patch inverts in reverse order" |
| **Undo/redo stack** — linear, redo truncation, rejected patches don't enter history, copies handed out | PROVEN | "history: apply / undo / redo with redo truncation" |
| **Replayable** — same base + patches ⇒ same hash (also after JSON round-trip); out-of-order replay stops at the stale patch | PROVEN | "replay is deterministic", property test (replay of 200 patches == live end hash) |
| **Validated** — validateManifest holds after every apply; enums/ids/bounds/finite/pollution/code/URL/owner rules | PROVEN | "invalid enums…", "unknown ids…", "numbers must be finite…", "prototype-pollution keys…", "code, script and URL strings…", "result must pass validateManifest…", "player-owned entities…", property test (validateManifest after each of 200 applies and each undo) |
| **Pure / never throws** | PROVEN | "applyPatch is pure", "validatePatch never throws on garbage" |
| **Property** — 200 random valid patches (all 7 op kinds) × 2 seeds, full undo restores original hash (recomputed, not cached), full redo + 300 random undo/redo steps match a model | PROVEN | "property: 200 random valid patches…" |
| Runtime honours ADDED gameplay/ui paths | DESIGN-ONLY | — |
| Server edit route uses patches | DESIGN-ONLY | §8 |

Hash note: `hashManifest` ≠ `core/worldstore.mjs manifestHash` (that one hashes everything including
world_version and has no `sha256:` prefix; it is the storage-integrity hash). The patch hash is a content
hash so that undo is verifiable. Both are canonical-JSON sha256.

Performance (fixture: 348×412 heightmap world): ~2 ms clone, ~1.5 ms hash, ~5–10 ms per apply.

## 8. Proposed integration — `server.mts` POST /v3/worlds/:id/edit (describe only; NOT edited)

Current route (~L1684): `planEdit(before,{request})` → `applyDelta` → `playtestAndRepair` → `verifyPreservation`
→ `repo.upsert` → `worldMemory.record`. Proposal — accept **either** `request` (unchanged path) **or** `patch`:

```diff
+import { applyPatch, hashManifest as patchHash, validatePatch } from "./src/v3/gamesc/patch/index.mjs";
 …
   mm = url.match(/^\/v3\/worlds\/([^/]+)\/edit$/);
   if (mm && method === "POST") {
     const me = await mustBeInternalTester(req, cid);
     const b = await readBody(req);
     const rec = await repo.get(mm[1], { requesterId: me.id, requireOwner: true });
     const { manifest: before } = ensureV3(rec.manifest, { worldVersion: rec.version, creatorId: rec.owner_id });
+    if (b.patch) {
+      // author is the principal, never what the client claims
+      const patch = { ...b.patch, author: { kind: b.patch.author?.kind === "companion" ? "companion" : "user", id: me.id } };
+      const r = applyPatch(before, patch);                 // untrusted: NO {trusted:true}
+      if (!r.ok) {
+        const stale = r.errors.some((e) => e.code === "stale_base");
+        return send(res, stale ? 409 : 422, { ok: false, error: stale ? "stale_edit" : "invalid_patch",
+          errors: r.errors.slice(0, 20), current_version: before.world_version, current_hash: patchHash(before), correlation_id: cid });
+      }
+      const live = (await liveStateFor(mm[1], b.live_state)).live;
+      const gate = await playtestAndRepair(r.manifest, { liveState: live });
+      if (!gate.passed) return send(res, 422, { ok: false, error: "edit_failed_playtest", verdict: gate.verdict, correlation_id: cid });
+      const kept = verifyPreservation(before, gate.manifest, live);
+      if (!kept.ok) throw Errors.conflict("the edit would have lost existing state", { correlationId: cid, meta: { problems: kept.problems } });
+      // If the repair pass changed anything, the stored inverse no longer restores `before` exactly:
+      // store the inverse only when patchHash(gate.manifest) === patchHash(r.manifest); otherwise store
+      // diffManifests(gate.manifest, before) as the undo ops (trusted, server-held).
+      const saved = await repo.upsert({ worldId: rec.world_id, ownerId: me.id, manifest: gate.manifest, state: rec.state, title: gate.manifest.meta.title });
+      await worldMemory.record(rec.world_id, { kind: "edited", summary: patch.intent?.text || `${patch.ops.length} op patch`,
+        worldVersion: gate.manifest.world_version, actorId: me.id, detail: { patch_id: patch.patch_id, inverse_id: r.inverse.patch_id, ops: patch.ops.length } });
+      return send(res, 200, { ok: true, world_id: rec.world_id, world_version: gate.manifest.world_version,
+        manifest_hash: patchHash(gate.manifest), patch_id: patch.patch_id, inverse: r.inverse, record_version: saved.version, playtest: gate.verdict, correlation_id: cid });
+    }
     const plan = planEdit(before, { request: b.request, author: me.id });
```

Also proposed (lead's call): `POST /v3/worlds/:id/undo` that applies the **server-stored** inverse with
`{trusted:true}` (never a client-supplied one), and `GET /v3/worlds/:id/manifest` additionally returning
`content_hash: hashManifest(manifest)` so clients can fill `base_hash` without importing this module.
The `planEdit` path can be migrated later by emitting `diffManifests(before, applyDelta(...).manifest)` as
ops (already covered for environment/entity edits; `expansion.history` is reported as `uncovered`).

## 9. Known limits (honest)

- Content heuristics are pattern-based: they block obvious code/URLs, not every obfuscation. The runtime
  must still treat manifest strings as text (never `innerHTML`/eval). The guard agent owns the threat model.
- `add` into a collection absent from the manifest is refused (no implicit creation, so inverses stay exact).
- `diffManifests` cannot express terrain/navigation/expansion/provenance changes or pure re-ordering of a
  collection; `diffManifestsDetailed().uncovered` names them.
- Undo after a playtest *repair* changed the saved manifest needs the §8 fallback (diff-based undo).
- `test/ci-coverage.test.mjs` will fail until `test/gamesc-patch.test.mjs` is added to an npm script
  (lead: append it to `test:unit` in package.json).
