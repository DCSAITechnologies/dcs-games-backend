# DCS GAMES — Publish / Build / Package Pipeline (GAMES-C, agent 5)

Status date: 28 Sep 2026. Scope: **staging packaging only, built and verified locally.**
Nothing in this lane deploys, contacts Cloudflare/Railway, or knows a production credential.

Code: `src/v3/gamesc/publish/` (`index.mjs` re-exports everything).
Tests: `test/gamesc-publish.test.mjs` (26 tests, offline, throwaway ed25519 keys, temp dirs, loopback server).

Labels: **PROVEN** = test-backed here · **PARTIAL** = works with a stated gap · **DESIGN-ONLY** = described, not built · **BLOCKED** = cannot be done in this lane.

## 1. Pipeline stages

| # | Stage | What happens | Status |
|---|-------|--------------|--------|
| 1 | validate | `validateManifest()` (src/v3/manifest/schema.mjs); world_id must be FS-safe; canonical JSON ≤ 2 MiB | PROVEN |
| 2 | playtest gate | verdict must be `passed:true` and `PASSED`/`PASSED_WITH_NOTES` (same pass rule as `critique()`); if the verdict carries `manifest` (as `playtestAndRepair()` returns) or `manifest_hash`, it must match the manifest being packaged — a verdict for the pre-repair manifest is not a verdict for this one | PROVEN |
| 3 | moderation | **MISSING.** No moderation gate exists anywhere in this repo for generated content. The descriptor records `moderation.status = "not_performed"`; if a caller passes a `moderation` object it is hashed and recorded as `recorded_not_enforced`. Staging is permitted without it; **promotion to production must not be** (see §6). | DESIGN-ONLY (honest gap) |
| 4 | preconditions | assets: declared sha256 required and must match bytes; per-asset 25 MiB / total 100 MiB / 500 assets budgets; MIME allowlist (glTF, png/jpeg/webp/ktx2, ogg/mpeg/wav, json, text); `text/html`, `image/svg+xml`, JS, wasm refused even if allowlisted; magic-byte check for glb/png/jpeg; safe `assets/…` paths only. Manifest: every `http(s)://` / `//` string must be on a host allowlist (default empty); `javascript:`/`data:`/`file:`/`blob:`/`vbscript:` refused; `assets/…` refs must resolve inside the package. Secret-like strings in manifest, provenance and text assets refused (findings never echo the secret). Runtime pin: semver, ≥ manifest `min_runtime`. Patch lineage ids must be `p_<hex>`. | PROVEN |
| 5 | package | deterministic ustar (mode 0644, uid/gid 0, mtime 0, sorted) + gzip level 9 → `package_id = sha256(archive)` | PROVEN |
| 6 | sign | detached ed25519 signature over the **Atlas canonical receipt body** (`canonicalBody()` from `src/cw7/atlas-local-sign.mjs`), `subject_type:"game_package"`, `subject_id:<package_id>` | PROVEN (throwaway keys); real Atlas key path PARTIAL — `atlasEnvSigner()` exists but is never exercised by tests by design |
| 7 | stage | `publishStaging(pkg)`: re-verifies in-memory package, writes `<root>/<world_id>/<package_id>/` atomically (tmp dir + rename), files 0444 / dirs 0555, moves `channels/staging.json` pointer | PROVEN (local FS adapter) |
| 8 | preview | `openPreview()` = the "reopen published preview" gate; `previewUrl()`; loopback `startPreviewServer()` serves only verified packages | PROVEN (local); CF Pages staging DESIGN-ONLY |
| 9 | promote | manual, out of scope. No production channel exists in this code. | BLOCKED here by design |
| 10 | rollback | `rollback(world_id, to_package_id)` moves the staging pointer back; history append-only; target must re-verify; nothing is deleted | PROVEN |

## 2. Package format (package_version "1")

Directory `<root>/<world_id>/<package_id>/`:

```
package.tar.gz      deterministic archive; sha256(this file) == package_id == dir name
package.sig.json    detached signature (NOT in the archive)
game-package.json   descriptor (also inside the archive)
manifest.json       canonical JSON manifest (also inside the archive)
assets/...          packaged assets (also inside the archive)
```

Loose files exist for serving; `openPreview` requires each to be byte-identical to its archived copy and refuses any unlisted file.

`game-package.json`:

```json
{
  "package_version": "1",
  "world_id": "w_pub", "world_version": 1, "title": "…",
  "manifest_file": "manifest.json",
  "manifest_hash": "sha256:<hex over the full canonical manifest>",
  "manifest_content_hash": "sha256:<patch-lane hashManifest: volatile fields stripped>",
  "runtime": { "entry": "dcs-runtime.js", "version": "3.1.0", "sha256": "<hex|null>" },
  "assets": [ { "path": "assets/tree.glb", "id": "a_tree", "sha256": "…", "size": 64, "mime": "model/gltf-binary" } ],
  "files":  [ { "path": "manifest.json", "sha256": "…", "size": 1234 }, … ],
  "provenance": { "generated_by": ["games-c/companion", …], "patch_lineage": ["p_…"], "source_prompt_hash": null, "source": null },
  "playtest": { "verdict": "PASSED", "passed": true, "verdict_hash": "sha256:…" },
  "moderation": { "status": "not_performed", "note": "…" },
  "channel": "staging",
  "created_at": "<input; defaults to manifest.meta.updated_at || created_at — never the wall clock>",
  "builder": { "name": "dcs-gamesc-publish", "version": "1.0.0" }
}
```

Why two manifest hashes: the patch lane's `hashManifest` deliberately ignores `world_version`, `meta.updated_at`, `provenance.manifest_hash` (content identity for edit lineage / `base_hash`). A package must bind every byte it ships, so `manifest_hash` is over the whole canonical manifest; `manifest_content_hash` lets a package be joined to patch lineage.

The runtime is not in this repo (play-v3 frontend loads `dcs-runtime.js`), so it is recorded as a pinned version plus an optional sha256 of the runtime file. The package does not ship the runtime.

`package.sig.json`:

```json
{ "attestation": "stage_package", "attested_by": "<signer id>", "prev_hash": null,
  "subject_type": "game_package", "subject_id": "<package_id>",
  "alg": "ed25519", "receipt_hash": "<sha256 of canonical body>", "sig": "<b64>",
  "public_key_b64": "<raw 32-byte key, b64>", "signer": "local-ed25519|atlas-env" }
```

Same signed body and field order as every Atlas receipt, so `/verify`-style tooling can check it given the public key. Unsigned aliases (`world_id`, `asset_id`, `builder_id`, `author_id`, `action`) are rejected, as `hasConflictingAlias` does. `openPreview(..., { trustedPublicKeys })` enforces a key trust list; without one, the result reports `key_trusted: null` (integrity proven, origin not). **Callers that gate anything real must pass the trust list** (e.g. the value of `GET /atlas/key`).

Determinism: identical inputs → byte-identical archive → identical `package_id` (PROVEN; also independent of asset input order and of the signer, since the signature is detached).

## 3. API

```js
import {
  buildStagingPackage,            // ({manifest, assets, runtime:{version, sha256?}, provenance, playtestVerdict, signer,
                                  //   createdAt?, moderation?, hostAllowlist?, mimeAllowlist?, budgets?})
                                  //   -> {ok:true, package:{package_id, world_id, archive, descriptor, signature, files}} | {ok:false, errors:[{code,path,message}]}
  generateThrowawaySigner, createEd25519Signer, atlasEnvSigner,
  verifyPackageSignature, verifyArchive,
  createStagingRegistry,          // ({root, now?, env?}) -> {publishStaging, rollback, channel, current, openPreview}
  openPreview,                    // (root, world_id, package_id, {trustedPublicKeys?}) -> {ok, manifest, descriptor, manifest_hash, runtime, ...} | {ok:false, code, message}
  previewUrl,                     // (pkg, {env}) -> "<DCS_STAGING_PREVIEW_BASE or http://127.0.0.1:8788/preview>/<world>/<package_id>/"
  startPreviewServer,             // ({root, trustedPublicKeys?}) -> {base, port, close}  127.0.0.1, ephemeral port
  assertStagingTarget, assertStagingOnlyEnv,
} from "./src/v3/gamesc/publish/index.mjs";
```

Refusal codes: `manifest_invalid, world_id_unsafe, manifest_over_budget, playtest_missing, playtest_not_passing, playtest_manifest_mismatch, runtime_invalid, runtime_too_old, asset_invalid, asset_path_unsafe, asset_duplicate, asset_missing, asset_hash_missing, asset_hash_mismatch, asset_over_budget, assets_over_budget, package_over_budget, asset_mime_disallowed, asset_mime_mismatch, external_url_not_allowlisted, external_url_unparseable, disallowed_url_scheme, secret_like, provenance_invalid, signer_missing, signing_failed`.

Registry errors (`PublishError.code`): `immutable_conflict, file_hash_mismatch, signature_invalid, not_in_history, already_current, rollback_target_invalid, world_id_unsafe, package_id_invalid, preview_host_refused`.

## 4. Channel pointer

`<root>/<world_id>/channels/staging.json`:

```json
{ "world_id": "w_pub", "channel": "staging", "current": "<package_id>",
  "history": [ { "seq": 1, "action": "stage", "package_id": "…", "from": null, "at": "…" },
               { "seq": 4, "action": "rollback", "package_id": "…", "from": "…", "at": "…", "reason": "…" } ] }
```

Written atomically (tmp + rename). Republishing the current package is a no-op (no history entry). Rollback only to a package that was staged on this channel and that still verifies; a refused rollback appends nothing.

**Known limitation (PARTIAL):** the pointer file is not itself signed and has no lock — two concurrent writers can lose an entry. Fine for a single local staging operator; a shared store needs a CAS/lock (e.g. KV/D1 conditional write) — see §6.

## 5. Staging-only guard

`assertStagingTarget(urlOrHost)` throws `ProductionTargetError` unless the host is loopback or carries a staging marker label (`staging|stage|preview`, dot/dash-delimited). Explicitly refused: `games.dcsai.ai`, `api.games.dcsai.ai`, `dcsai.ai`, `www.dcsai.ai`, and any other unmarked host — including bare `<project>.pages.dev` (that IS the Pages production deployment; only a marked branch alias like `staging.<project>.pages.dev` passes). `createStagingRegistry` checks `DCS_STAGING_PREVIEW_BASE`, `DCS_PUBLISH_TARGET`, `DCS_STAGING_ORIGIN` at construction; `previewUrl` checks its base on every call. PROVEN.

Guard is a string check on configuration, not a network control: it prevents mis-configuration inside this module, not a determined operator.

## 6. Integration proposal (DESCRIBE ONLY — nothing below is implemented)

### 6.1 `server.mts` — `POST /worlds/:id/publish` (~line 2204)

Today the route: owner + internal-tester check → refuses without Atlas key → `issueWorldReceipt` → `repo.upsert(state:"published")`. It does **not** run the playtest gate, build a package, or pin a runtime. Proposed shape (lead to apply):

```ts
import { buildStagingPackage, atlasEnvSigner, createStagingRegistry } from "./src/v3/gamesc/publish/index.mjs";
import { playtestAndRepair } from "./src/v3/playtest/agent.mjs";
// after `if (!atlasReady()) throw Errors.notConfigured(...)`:
const pt = await playtestAndRepair(wm, { maxRounds: 1 });   // gate only; do not silently repair on publish
if (!pt.passed) throw Errors.validation("playtest gate failed", { correlationId: cid, meta: { verdict: pt.verdict } });
const built = buildStagingPackage({
  manifest: wm, assets: [],                                   // asset bytes: see 6.3
  runtime: { version: process.env.DCS_RUNTIME_VERSION || "3.0.0", sha256: process.env.DCS_RUNTIME_SHA256 },
  provenance: { generated_by: wm.provenance?.generated_by || [], patch_lineage: /* from world memory / edit history */ [] },
  playtestVerdict: pt, signer: atlasEnvSigner(), hostAllowlist: ASSET_HOST_ALLOWLIST,
});
if (!built.ok) throw Errors.validation("package preconditions failed", { correlationId: cid, meta: { errors: built.errors } });
const staged = stagingRegistry.publishStaging(built.package);  // STAGING channel only
// response gains: package_id, preview_url: staged.preview_url, manifest_hash
```

Notes for the lead: (a) `validateManifest` is strict V3 — the V2 save route deliberately accepts partial manifests, so a stored V2 world will be refused here; that is the correct outcome for a package but changes publish behaviour for legacy worlds (decide explicitly). (b) keep the existing Atlas world receipt; the package signature is an additional receipt with `subject_type:"game_package"`. (c) `stagingRegistry` root = e.g. `.dcs-data/staging-packages` (already skipped by secret-scan). (d) add a route `POST /worlds/:id/staging/rollback` owner-gated → `registry.rollback`.

### 6.2 `package.json`

`ci-coverage.test.mjs` requires every suite to be named in an npm script. Add `test/gamesc-publish.test.mjs` to `test:unit`. Until then `npm run test:unit` reports the suite as an orphan (1 expected failure — see §7).

### 6.3 Asset bytes

Generated worlds today are mostly `primitive`/`instanced` assets with no bytes; glb/gltf `uri`s point at external CDNs. Proposed: a fetch-and-pin step (separate, network-permitted job, not this module) that downloads each allowlisted external asset once, records sha256+size+mime, and passes it as a packaged asset, rewriting the `uri` to `assets/<sha>.glb`. Until then external URIs must be allowlisted per host. DESIGN-ONLY.

### 6.4 `scripts/secret-scan.mjs`

Its `RULES`/`BENIGN` run at import (CLI + `process.exit`), so they are **copied** into `guards.mjs`. Proposed refactor: move `RULES`, `BENIGN`, `isWordSlug`, `jwtIsPrivileged` to `scripts/secret-rules.mjs` (side-effect free, exported) and import from both. DESIGN-ONLY; drift risk until done.

### 6.5 CF Pages staging

Target: a *separate* Pages project (e.g. `dcs-games-staging`) or a branch alias `staging.<project>.pages.dev`. Upload = the loose files of one package dir under `/preview/<world_id>/<package_id>/`, plus `_headers` with `X-Content-Type-Options: nosniff`, `Cache-Control: public, max-age=31536000, immutable` for package paths (content-addressed ⇒ safe to cache forever), and a tiny `current.json` per world written last. The deploy step must call `assertStagingTarget(<pages url>)` before uploading and refuse `games.dcsai.ai`/bare `*.pages.dev`. The play-v3 runtime (`dcs-runtime.js`, not in this repo) would load `<preview>/<world>/<pkg>/manifest.json`, compare `X-DCS-Manifest-Hash` / descriptor hash, and refuse on mismatch. DESIGN-ONLY; **no wrangler command was run**.

## 7. Honest status

- PROVEN (26/26 tests): determinism; detached ed25519 Atlas-canonical signature; signature rejects wrong id / swapped key / unsigned alias / forged receipt_hash / bad sig; every refusal class above; real offline-generated world (assembly router → `playtestAndRepair`) packages deterministically; immutable dirs + no-op republish + overwrite refusal + in-memory mutation refusal; tamper of any of the 6 file kinds fails `openPreview`, extra file fails, untrusted key fails; re-signed forged archive fails; rollback pointer + append-only history + tampered-target refusal; production-host guard; loopback preview server serves verified manifest with matching hash and returns 409 after tampering; canonical bytes agree with the patch lane.
- PARTIAL: real Atlas key signing path (`atlasEnvSigner`) untested by design (tests never read keys); channel pointer unsigned + unlocked; secret rules copied not shared; gzip byte-identity proven on this machine/Node 25 (Node's bundled zlib; a different zlib build could change compressed bytes — then `package_id` changes, verification still holds).
- DESIGN-ONLY: moderation gate (does not exist), server.mts integration, asset fetch-and-pin, CF Pages staging upload, promotion.
- BLOCKED here by design: any production publish/promote.
- `npm run test:unit` (final run, 28 Sep): 1112/1113 pass. The 1 failure is `ci-coverage` "every test file is referenced by an npm script": the new `test/gamesc-*.test.mjs` suites (this lane's included) are not yet in `package.json` (lead integrates, §6.2). An earlier run also saw two `harness-leak` Chrome-process tests fail under concurrent agent load; they pass in isolation (4/4) and passed on the final run.
