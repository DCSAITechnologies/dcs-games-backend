# GAMES-C shared contract (read first — all agents)

Worktree: ~/Developer/dcs-games-c-systems (branch games-c/systems-28sep2026, base cd9856d).
Netcode worktree: ~/Developer/dcs-games-c-netcode (branch games-c/netcode-slice-28sep2026, base 524a7f6).
NEVER touch: ~/Desktop/Project DCSAI/dcs-games-6month-deploy/gb, ~/Desktop/Project DCSAI/dcs-games-LIVE,
~/Desktop/Project DCSAI/cw4-deploy/dcs-games-netcode (active recovery / original checkouts), ~/Developer/dcs-games-a-providers (GAMES-A lane).

## Rules
- Build ON existing code (src/v3/manifest/schema.mjs, src/v3/expansion/{planner,delta,diff,rollback}.mjs,
  src/v3/memory/world-memory.mjs, src/v3/companion/*.mjs, src/v3/playtest/*.mjs, src/cw7/atlas-local-sign.mjs). Read them; don't duplicate them.
- Each agent writes ONLY inside its own dir `src/v3/gamesc/<area>/`, its own tests `test/gamesc-<area>*.test.mjs`,
  and its own doc(s) in `docs/games-c/`. Do NOT edit server.mts, package.json, existing src/ or test/ files — the lead integrates.
  If an existing file needs a change, describe the exact diff in your final report instead.
- Zero new npm dependencies. Node built-ins only (node:crypto, node:test, node:assert, node:zlib, node:fs...).
- Do NOT run git add/commit/checkout/stash/reset (shared worktree; the lead commits).
- No network calls to providers. No deploys. No secrets read or printed. Tests must run offline (`DCS_PROVIDERS_OFFLINE=1`).
- Run your tests with: `node --test test/gamesc-<area>*.test.mjs`. Also confirm `npm run test:unit` still passes at the end.
- Be honest in docs: label each capability PROVEN (test-backed) / PARTIAL / DESIGN-ONLY / BLOCKED.

## Patch contract (owned by patch agent; consumed by companion + memory + publish + guard)
Module: `src/v3/gamesc/patch/index.mjs` exports:
- `PATCH_VERSION = "1"`, `OP_KINDS` (array of op names)
- `canonicalJSON(value) -> string` (sorted keys, stable) and `hashManifest(manifest) -> "sha256:<hex>"`
- `validatePatch(patch, manifest) -> {ok, errors:[{op_index, path, message}]}`  (pure; never throws)
- `applyPatch(manifest, patch) -> {ok, manifest, inverse, errors}` (pure; deep-copies; result must pass validateManifest)
- `invertPatch(patch, manifestBefore) -> patch`
- `replayPatches(baseManifest, patches[]) -> {ok, manifest, applied, errors}`
- `diffManifests(a, b) -> ops[]` (may wrap src/v3/expansion/diff.mjs)

Patch shape:
```
{ patch_version:"1", patch_id:"p_<hex>", world_id, base_version:int, base_hash:"sha256:…",
  author:{kind:"user"|"companion"|"system", id}, intent?:{text, category}, created_at:ISO, ops:[Op] }
```
Op kinds (typed, data-only — NO code, NO URLs except via replace_asset allowlist check):
- `{op:"set", path:"environment.weather", value}` — path must be in a whitelist (environment.*, meta.title, meta.description,
   gameplay/rules fields, player params such as speed, ui fields, objectives fields — exact list decided by reading schema.mjs)
- `{op:"add", collection:<manifest array e.g. zones|entities|npcs|quests|assets|behaviors>, value:{id,...}}`
- `{op:"remove", collection, id}`
- `{op:"update", collection, id, set:{field:value}}`
- `{op:"move", collection, id, position:{x,y,z}}`
- `{op:"replace_asset", asset_id, value:{...asset ref}}`
Every op is invertible; applyPatch returns the inverse patch. Base-hash mismatch => reject (stale edit).

Edit categories (companion must cover): scene, asset_replace, gameplay_rule, npc, lighting_weather, ui, objective, expand_area.

## Module dirs
- companion (agent 1): src/v3/gamesc/companion/  → DCS_GAMES_COMPANION_SPEC.md
- memory    (agent 2): src/v3/gamesc/memory/     → DCS_GAMES_WORLD_MEMORY_SPEC.md
- patch     (agent 3): src/v3/gamesc/patch/      → DCS_GAMES_EDIT_PATCH_SCHEMA.md
- netcode   (agent 4): ~/Developer/dcs-games-c-netcode + src/v3/gamesc/multiplayer/ (client/integration shim only) → DCS_GAMES_MULTIPLAYER_RECOVERY.md
- publish   (agent 5): src/v3/gamesc/publish/    → DCS_GAMES_PUBLISH_PIPELINE.md
- guard     (agent 6): src/v3/gamesc/guard/ + src/v3/gamesc/qa/ → DCS_GAMES_PLAYTEST_GATES.md, DCS_GAMES_SECURITY_THREAT_MODEL.md, DCS_GAMES_COST_BUDGETS.md

Baseline at cd9856d (lead-verified 28 Sep): test:unit 1113/0, test:unit:tsx 69/0, test:api 126/0, test:load 6/0. Netcode npm test: 13 suites / 197 checks / 0 fail.
Note: netcode repo has untracked-looking iCloud dupes tracked in git: "src/session 2.ts", "src/validation 2.ts", "tests/speedhack-regression.test 2.ts".
