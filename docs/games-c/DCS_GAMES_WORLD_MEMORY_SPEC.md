# DCS GAMES — World Memory v2 (versioning / persistence) spec

Owner: GAMES-C Agent 2 · Module: `src/v3/gamesc/memory/` · Tests: `test/gamesc-memory.test.mjs`
Date: 28 Sep 2026 · Worktree: `~/Developer/dcs-games-c-systems` (branch `games-c/systems-28sep2026`)

## 1. Status at a glance

| Capability | Status | Evidence |
|---|---|---|
| SAVE checkpoint, idempotent by content hash | PROVEN | `SAVE/RETURN round trip` |
| RETURN (manifest + spec + player state + companion context + last N history) | PROVEN | `SAVE/RETURN round trip`, `FS adapter survives RESTART` |
| EDIT via injected `applyPatch`, stale `base_version`/`base_hash` refused | PROVEN (real patch module and local stub) | `EDIT chain`, `STALE edit rejected` |
| EDIT idempotent by `patch_id`; reused id with different body refused | PROVEN | `EDIT idempotent by patch_id` |
| Immutable, monotonic, hash-chained versions | PROVEN | `EDIT chain`, `TAMPER detection` |
| Snapshot every K + replay reconstruction == stored hash | PROVEN | `REPLAY reconstruction` |
| RESTORE VERSION = new version, same content hash (non-destructive) | PROVEN | `RESTORE is non-destructive` |
| Integrity verification / tamper detection (memory + on-disk) | PROVEN | `TAMPER detection` ×2 |
| Optimistic concurrency (`expected_version`), per-world in-process lock | PROVEN | `CONCURRENT edits` |
| Two writers (two instances, one directory): exactly one owns vN | PROVEN for version records (atomic `link(2)`) | `CONCURRENT writers in two PROCESS-LIKE instances` |
| Cross-process safety of bounded logs / rev docs on the FS adapter | PARTIAL — in-process lock only | stated in `adapters.mjs` |
| Expansion lineage DAG (area edges, forks, ancestors, cycle refusal, endpoint verification) | PROVEN | `EXPANSION lineage` |
| Player state / companion context persistence with revs and size caps | PROVEN | `PLAYER STATE + COMPANION CONTEXT` |
| Asset identity map (content hash, stable across edits and renames) | PROVEN | `ASSET identity` |
| Bounded history sizes | PROVEN | `SIZE bounds` |
| Head repair after a crash between version write and head write | PROVEN | `HEAD repair` |
| Supabase adapter | DESIGN-ONLY — mapping §6, proposed migration §7 | none |
| server.mts wiring | DESIGN-ONLY — diff proposal §8 | none |
| Patch-body pruning / compaction for very long chains | DESIGN-ONLY | none |
| Live-state protection on restore (planRollback refusal) | NOT IN THIS MODULE — the caller keeps it (§5.5) | existing `world-rollback.test.mjs` |

Test counts (28 Sep): `node --test test/gamesc-memory*.test.mjs` → **20 tests, 20 pass, 0 fail**. That run uses the real `src/v3/gamesc/patch/index.mjs`. With `GAMESC_MEMORY_FORCE_STUB=1` the same suite runs against the local stub: also 20/20.

## 2. What already existed, and what v2 adds

| Existing piece | What it persists | v2 relationship |
|---|---|---|
| `src/core/worldstore.mjs` `WorldRepository` → `dcsgames_base_worlds` (0003) | One current manifest per world (`version`, `manifest_hash` = bare hex over the whole manifest) | Stays the "head row" for the public routes. v2 is a separate facade. The integration plan (§8) mirrors v2 heads into it. |
| `VersionHistoryStore` / `SupabaseVersionHistoryStore` → `dcsgames_world_versions` (0003) | Full manifest per version, immutable. No parent pointer, patches or chain | v2 **extends this table** with chain columns (§7) and does not create a second version table |
| `src/v3/memory/world-memory.mjs` (B7) → file store (0003 declares `dcsgames_world_events`) | The fact chronicle NPCs may cite | Unchanged. v2 does not replace it. Routes still record `edited`/`expanded`/`rolled_back` events there. |
| `src/v3/expansion/rollback.mjs` `planRollback` | Rollback = NEW version with old content, and it refuses deletions that would cost a player something | v2 `restoreVersion` follows the same "never rewind" rule. The live-state refusal stays in `planRollback`. |
| `src/v3/expansion/fork.mjs`, `stitch.mjs` | Attribution chain inside the manifest | v2 lineage stores the same fact as graph edges with version hashes, so it can be verified |
| `dcsgames_world_deltas` / `dcsgames_world_snapshots` (0009) | CW5 runtime object op log | A different concept (runtime objects, not manifests). Untouched. |
| `src/core/playerprogress.mjs` (file) | Server-derived quest/NPC/zone progress: the rollback evidence | Stays authoritative. v2 player state is resume state, labelled by `source`. |
| `src/v3/companion/companion.mjs` (file) | Companion service state | v2 stores an opaque context blob handed over by the GAMES-C companion module |

## 3. Data model

All records are JSON. Storage goes through an adapter using the namespaces below (FS layout: `<dir>/<world>/<ns>/<key>.json`, logs in `<dir>/<world>/_logs/<ns>.json`).

**Version record** (`ns=version`, key = zero-padded version number, **insert-only**):
```
{ memory_version:"2", world_id, version:int>=1, parent_version:int|null, parent_hash:"sha256:…"|null,
  manifest_hash:"sha256:…",            // injected hashManifest (patch contract; excludes VOLATILE_PATHS)
  patch_ids:[…], patch_hashes:[…],     // [] for save/restore/fork; [patch_id] for edit/expand-by-patch
  version_hash:"sha256:…",             // H(canonicalJSON([parent_hash, manifest_hash, patch_ids]))
  kind:"save"|"edit"|"restore"|"expand"|"fork", snapshot:bool,
  author:{kind:"user"|"companion"|"system", id}, label, restored_from:int|null,
  spec_hash, lineage:{parent_world_id,parent_version,parent_version_hash,kind}|null,
  created_at, record_hash:"sha256:…" } // digest of every other field
```
- **snapshot** (`ns=snapshot`, key = hex of `manifest_hash`, content-addressed, insert-only): `{manifest_hash, manifest}`. Written for every save/restore/fork/manifest-expand, and for edit versions where `version % K == 0` (default K=10). A restore to old content reuses the old snapshot. A writer that loses a version race leaves nothing another writer could misread.
- **patch** (`ns=patch`, key `patch_id`): `{patch_id, world_id, version, patch, patch_hash, inverse, author, created_at}`.
- **head** (`ns=head`, key `current`): `{version, version_hash, manifest_hash}`. This is a cache only. Version records are the source of truth, and a lagging head is repaired forward on read.
- **spec** (`ns=spec`, content-addressed): `{spec_hash, spec}`. The head version carries `spec_hash`.
- **assets** (`ns=assets`, key `map`): `{by_content:{hex:{identity:"asset_<16hex>", content_hash, first_version, asset_ids[]}}, by_asset_id:{id:[{version, content_hash, identity}]}}`. Identity = hash of every asset field except `id`.
- **player** (`ns=player`, key player id): `{key, rev, at_version, source:"client_reported"|"server_authoritative", updated_at, data:{position:{x,y,z}, inventory:[], progress:{}, …}}`.
- **companion** (`ns=companion`, key scope = player id or `world`): `{key, rev, at_version, context_hash, updated_at, data:<opaque>}`.
- **logs** (bounded, `seq` monotonic even after trimming): `edit_history` (version, kind, patch_id, author, intent, op_count, manifest_hash, restored_from), `generation_history` (lane, stage, provider, model, status, version, input_hash, output_hash, asset_ids, note), `lineage_in` / `lineage_out` (unbounded edges `{kind, area_id, label, author, from:{world_id,version,version_hash}, to:{…}, at}`).

**One counter.** The facade owns `manifest.world_version` and always stamps it equal to the record version (`stampWorldVersion`, default on). `world_version` is a volatile field (it is excluded from the content hash in both the patch module and the fallback hash), so stamping never changes a content hash. This removes, for v2, the manifest-counter vs record-counter skew that `rollback.mjs` has to be told about (`versionCounter`), and it is what lets the real patch engine's `base_version === manifest.world_version` check agree with the facade's `base_version === head.version` check.

## 4. API (`src/v3/gamesc/memory/index.mjs`)

```js
import { createWorldMemoryV2, createFsAdapter, createMemoryAdapter,
         createWorldMemoryV2WithPatchModule, loadPatchModule } from "./src/v3/gamesc/memory/index.mjs";

const mem = createWorldMemoryV2({
  adapter,                                   // createMemoryAdapter() | createFsAdapter(dir) | future Supabase adapter
  applyPatch, replayPatches, hashManifest,   // injected patch engine (optional; edit needs applyPatch)
  diffManifests,                             // optional; fallback is a structural diff ignoring volatile fields
  limits: { snapshotEvery, maxEditHistory, maxGenerationHistory, maxHistoryReturn, maxManifestBytes,
            maxSpecBytes, maxPlayerStateBytes, maxInventoryItems, maxCompanionBytes, maxLabelChars, maxAssetIdHistory },
  clock, stampWorldVersion,
});
```
| Operation | Call | Result / errors |
|---|---|---|
| SAVE | `save(w, {manifest, spec?, author?, label?, expected_version?})` | `{idempotent, version}`. Same content and spec as the head: no-op. 409 `version_conflict`. 422 `too_large`/`bad_manifest`. |
| RETURN | `resume(w, {player_id?, history_limit?, companion_scope?})` | `{version, version_hash, manifest_hash, manifest, spec, player_state, companion_context, edit_history, generation_history, lineage}`. The manifest is hash-verified before it is returned. |
| EDIT | `edit(w, patch, {expected_version?, label?})` | `{idempotent, version, inverse, manifest_hash}`. 409 `stale_base` / `version_conflict` / `patch_id_reused`. 422 `patch_rejected` (engine errors attached). 503 `no_patch_engine`. |
| EXPAND (area) | `expand(w, {patch | manifest, area_id?, label?})` | New version `kind:"expand"` plus a `lineage_out` edge v→v+1 |
| EXPAND / FORK (child world) | `expand(parent, {child_world_id, manifest, parent_version?, kind?})` | Child v1 `kind:"fork"` with a `lineage` pointer, and edges on both sides. 409 `lineage_cycle` / `child_exists`. |
| RESTORE | `restoreVersion(w, n, {expected_version?, author?})` | A NEW version whose `manifest_hash` equals vn's, with `restored_from:n`. Refuses if vn does not rebuild to its hash. |
| List / get / diff | `listVersions(w,{limit,before})`, `getVersion(w,n,{withManifest})`, `diffVersions(w,a,b)` | The diff includes `same_content` and `versions_between` |
| Reconstruct | `reconstruct(w, n, {preferReplay?})` | `{manifest, manifest_hash, expected_hash, match, from_snapshot, replayed_patches}` |
| Verify | `verifyIntegrity(w, {deep?})`, `verifyLineage(w)` | `{ok, problems:[{version, code, message}]}` |
| Player / companion | `putPlayerState(w,pid,state,{expected_rev?,source?})`, `getPlayerState`, `listPlayers`, `putCompanionContext(w,scope,blob,{expected_rev?})`, `getCompanionContext` | 409 `rev_conflict`, 422 `too_large`/`bad_player_state` |
| Provenance / history | `recordGeneration(w,{lane,…})`, `generationHistory(w,n)`, `editHistory(w,n)` | Bounded |
| Misc | `head(w)`, `getSpec(w)`, `assetIdentities(w)`, `lineage(w)` | |

All errors are `AppError`s from `src/core/errors.mjs`, with `meta.reason` holding one of the codes above, so they map straight onto the route's HTTP answer.

## 5. Integrity model

1. **Chain.** `version_hash = H(canonicalJSON([parent_hash, manifest_hash, patch_ids]))`. Rewriting any version, even consistently (recomputing its own hashes), breaks `parent_hash` at its child. This is tested.
2. **Metadata.** `record_hash` is the digest of every other field (author, label, kind, restored_from, lineage, timestamps). It catches a rewritten label or author that the chain formula does not cover. This is tested on both the in-memory and the on-disk adapter.
3. **Content.** Each snapshot must hash to the `manifest_hash` of the version that references it. Each patch body must hash to the `patch_hashes[i]` its version recorded. `reconstruct` refuses (`integrity`) rather than return content that fails either check.
4. **Deep verify.** For every patch version, rebuild it from the previous snapshot, skipping its own snapshot, and compare the result with the stored hash. This cross-checks the snapshots against the patch chain.
5. **What this does not protect against.** Someone with write access to the store could rewrite the entire chain from v1 onward. Detecting that needs an anchor outside the store, for example publishing `head.version_hash` into the Atlas receipt (`src/cw7/atlas-local-sign.mjs`) at publish time. That is proposed, not built. Restore also does not check player live state: routes must keep calling `planRollback` (or its live-state check) before `restoreVersion`, exactly as `/v3/worlds/:id/rollback` does today.

**Concurrency.** Writes to one world are serialised in-process (keyed mutex, `src/core/mutex.mjs`). `expected_version` gives optimistic concurrency across callers. A version record is committed with an atomic create (`put(..., {ifAbsent:true})`: `link(2)` on the FS adapter, and a PK insert in Postgres), so two processes can never both own vN. The loser gets 409 and its orphan patch record is harmlessly overwritten or ignored. On the FS adapter, bounded logs and rev documents are serialised in-process only (PARTIAL). A multi-instance deployment needs the Supabase adapter.

**Bounds.** Edit history, generation history, returned history, companion blob, player state, inventory length, manifest bytes, spec bytes and per-asset history are all capped (§4 `limits`). Version records and patch bodies are never trimmed, because replay needs them. Pruning patch bodies older than a snapshot is DESIGN-ONLY.

## 6. Mapping to Supabase schema v13 (migrations 0001–0013)

| v2 namespace | Existing table (v13) | Needed change |
|---|---|---|
| `version` | `dcsgames_world_versions` (0003) | Add chain columns (proposed 0014 §1). PK `(world_id, version)` = the atomic create. `manifest` NOT NULL is kept in phase 1, so every row is a snapshot. |
| `head` | `dcsgames_base_worlds` (0003) `version`, `manifest_hash` | None. Note the hash formats differ: base_worlds stores bare hex over the whole manifest (`worldstore.manifestHash`), while v2 uses `sha256:<hex>` over the non-volatile content (patch contract). Both hashes are stored and neither is converted into the other. |
| `snapshot` | none; in phase 1 the manifest column in versions covers it | New `dcsgames_world_manifest_snapshots` (phase 2) |
| `patch` | none | New `dcsgames_world_patches` |
| `spec` | none (the spec lives inside manifest/meta today) | New `dcsgames_world_specs` |
| `player` | none. `dcsgames_inventory` (0001) is the legacy economy table and `playerprogress` is file-only. | New `dcsgames_world_player_state` |
| `companion` | none (companion.mjs is file-only) | New `dcsgames_world_companion_context` |
| `edit_history`, `generation_history` | none. `dcsgames_world_events` is the fact chronicle and must stay facts-only. | New `dcsgames_world_memory_log` |
| `assets` | none | New `dcsgames_world_asset_identities` |
| `lineage_in/out` | none (attribution is inside manifest meta) | New `dcsgames_world_lineage` |

## 7. Migration proposal

The file is `docs/games-c/proposed-migrations/0014_world_memory_v2.PROPOSED.sql`. It is **not** in `migrations/`, so no gate or boot assertion sees it. It adds the chain columns (plus the missing `state` column that `SupabaseVersionHistoryStore` documents as a gap) and an insert-only trigger to `dcsgames_world_versions`, and creates the 7 new tables above. It also records a **pre-existing gap** found while mapping: `world-memory.mjs` emits the kind `rolled_back`, but the 0003 CHECK on `dcsgames_world_events.kind` allows only `rollback`. That is harmless while the chronicle is file-backed, and it breaks the first Postgres write. The fix is written as a commented statement.

When it is promoted: the file must be renamed to the next free number, the new tables added to the boot `REQUIRED_TABLES`, and a `SupabaseMemoryAdapter` built against the interface in `adapters.mjs`. The adapter needs to map `put ifAbsent` to an INSERT that treats a PK conflict as `{ok:false, exists:true}`, and `append` to an INSERT plus a prune. `test/table-references.test.mjs` will require the migration before any code names these tables. For that reason no code in `src/v3/gamesc/memory/` names a `dcsgames_*` table today.

## 8. server.mts integration proposal (describe only; the lead integrates)

1. **Construct** near the other services (~line 104):
   `const { memory: worldMemV2 } = await createWorldMemoryV2WithPatchModule({ adapter: createFsAdapter(path.join(DATA_DIR, "world-memory-v2")) });`
   Swap to the Supabase adapter when it exists.
2. **`POST /worlds/:id/save`** (~2230, manifest branch): after `repo.upsert` succeeds, call `worldMemV2.save(id, { manifest: incoming, author: me.id, expected_version: <v2 head version> })`. The response adds `version_hash`. Keep the repository as the head, and record a v2 mirror failure as `persistence_degraded`, following the existing `_mirrored` pattern.
3. **New `POST /v3/worlds/:id/patch`**: `validatePatch` → `worldMemV2.edit(id, patch, { expected_version: b.expected_version })` → `playtestAndRepair(result)` → `verifyPreservation` → `repo.upsert` → `worldMemory.record("edited")`. Map `stale_base`/`version_conflict` → 409, `patch_rejected` → 422. (The gate currently runs after the v2 commit. The final design must gate before committing: run `applyPatch` plus the gate first, then `edit`. A "dry" flag on `edit` is the smallest follow-up.)
4. **`POST /v3/worlds/:id/rollback`** (~1997): keep `planRollback` (live-state refusal) and the playtest gate. After `repo.upsert`, record in v2 with `worldMemV2.save(id, { manifest: gate.manifest, kind: "restore", restored_from: toVersion, idempotent: false })`. This path does not use `restoreVersion`, because `planRollback` re-stamps history and permissions, so the content is not byte-identical to the old version. That is correct, and it is recorded as a restore.
5. **`/v3/worlds/:id/expand`** (~1635) and **`/fork`** (~1903): after save, call `worldMemV2.expand(...)` (area expansion edge, or a child world with `child_world_id: forked.world_id`).
6. **`GET /worlds/:id/load`** (~2357): add `resume: await worldMemV2.resume(id, { player_id: principal?.id })`, guarded by `optional()`, so a returning player gets their player state, companion context and history in one call.
7. **New `GET /v3/worlds/:id/integrity`** (owner only): return `verifyIntegrity(id, { deep: false })` and `verifyLineage(id)`.
8. **`package.json`**: add `test/gamesc-memory.test.mjs` to `test:unit`. Without this, `test/ci-coverage.test.mjs` fails, as it currently does for every `gamesc-*` suite.

## 9. Honest limitations

- The FS adapter is single-host. Cross-process safety covers version creation only.
- The Supabase adapter and route wiring are DESIGN-ONLY.
- There is no external anchor for the chain yet (§5.5).
- Patch bodies are never pruned, so storage grows linearly with edits.
- `putPlayerState` accepts caller-supplied state. It is labelled `client_reported` by default and must never be read as rollback evidence.
- Two full `npm run test:unit` runs on 28 Sep each ended 1111 pass / 2 fail out of 1113. The first failure is the `ci-coverage` gate, which fails until the `gamesc-*` suites are added to `package.json`. The second was a different harness server-spawn test each time (`harness-leak` "kill() is an alias", then `instance-identity` "a server that is not yours…"). Both pass when rerun alone (7/7), so these look like timing flakes under load from concurrent agents and are unrelated to this module.
