// GAMES-C publish pipeline (STAGING ONLY). Offline: throwaway ed25519 keys,
// temp dirs, loopback preview server. Never reads a real signing key.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { emptyManifest } from "../src/v3/manifest/schema.mjs";
import { createAssemblyRouter } from "../src/v3/router/assembly.mjs";
import { playtestAndRepair } from "../src/v3/playtest/agent.mjs";
import { canonicalBody } from "../src/cw7/atlas-local-sign.mjs";
import {
  buildStagingPackage, generateThrowawaySigner, verifyPackageSignature, verifyArchive,
  createStagingRegistry, openPreview, previewUrl, startPreviewServer,
  assertStagingTarget, assertStagingOnlyEnv, ProductionTargetError, PublishError,
  hashManifestExact, canonicalJSON, readTar, writeTar, sha256Hex, DEFAULT_PREVIEW_BASE,
} from "../src/v3/gamesc/publish/index.mjs";

const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const FIXED = "2026-09-28T00:00:00.000Z";
const PASS = { passed: true, verdict: "PASSED", summary: { blocker: 0, major: 0, minor: 0 } };
const SIGNER = generateThrowawaySigner("test-signer");
const ENV = { DCS_STAGING_PREVIEW_BASE: "" };

function world(id = "w_pub", extra = {}) {
  const m = emptyManifest({ worldId: id, title: "Publish Test" });
  m.meta.created_at = FIXED; m.meta.updated_at = FIXED;
  return Object.assign(m, extra);
}
const GLB = Buffer.concat([Buffer.from("glTF"), Buffer.from([2, 0, 0, 0]), Buffer.alloc(56, 7)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(24, 1)]);
const asset = (p, bytes, mime, over = {}) => ({ path: p, bytes, mime, sha256: sha(bytes), ...over });

function build(over = {}) {
  const manifest = over.manifest || world();
  return buildStagingPackage({
    manifest,
    assets: [asset("assets/tree.glb", GLB, "model/gltf-binary", { id: "a_tree" }), asset("assets/sky.png", PNG, "image/png")],
    runtime: { version: "3.1.0", sha256: sha("dcs-runtime.js v3.1.0") },
    provenance: { generated_by: ["games-c/companion", "games-c/patch"], patch_lineage: ["p_0a1b2c3d", "p_ffee0011"] },
    playtestVerdict: PASS,
    signer: SIGNER,
    ...over,
  });
}
const codes = (r) => r.errors.map((e) => e.code);

function tmpRoot() { return fs.mkdtempSync(path.join(os.tmpdir(), "gamesc-publish-")); }
function makeWritable(dir) {
  if (!fs.existsSync(dir)) return;
  fs.chmodSync(dir, 0o755);
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) makeWritable(p); else fs.chmodSync(p, 0o644);
  }
}
function cleanup(root) { makeWritable(root); fs.rmSync(root, { recursive: true, force: true }); }
function clock() { let i = 0; return () => new Date(Date.UTC(2026, 8, 28, 0, 0, i++)).toISOString(); }

// ---------------------------------------------------------------- determinism

test("PUBLISH: same input -> byte-identical archive -> same package_id", () => {
  const a = build(), b = build();
  assert.equal(a.ok, true, JSON.stringify(a.errors));
  assert.equal(a.package.package_id, b.package.package_id);
  assert.ok(a.package.archive.equals(b.package.archive));
  assert.equal(a.package.package_id, sha256Hex(a.package.archive));
  assert.match(a.package.package_id, /^[0-9a-f]{64}$/);
});

test("PUBLISH: package_id is independent of the signer (signature is detached)", () => {
  const a = build(), b = build({ signer: generateThrowawaySigner("other") });
  assert.equal(a.package.package_id, b.package.package_id);
  assert.notEqual(a.package.signature.sig, b.package.signature.sig);
});

test("PUBLISH: asset order does not change the package; content does", () => {
  const a = build();
  const b = build({ assets: [asset("assets/sky.png", PNG, "image/png"), asset("assets/tree.glb", GLB, "model/gltf-binary", { id: "a_tree" })] });
  assert.equal(a.package.package_id, b.package.package_id);
  const m = world(); m.environment.weather = "rain";
  const c = build({ manifest: m });
  assert.notEqual(a.package.package_id, c.package.package_id);
});

test("PUBLISH: game-package.json carries the contract fields", () => {
  const { package: p } = build();
  const d = p.descriptor;
  assert.equal(d.package_version, "1");
  assert.equal(d.world_id, "w_pub");
  assert.equal(d.world_version, 1);
  assert.equal(d.manifest_hash, hashManifestExact(world()));
  assert.deepEqual(d.runtime, { entry: "dcs-runtime.js", version: "3.1.0", sha256: sha("dcs-runtime.js v3.1.0") });
  assert.deepEqual(d.assets.map((x) => [x.path, x.size, x.mime]), [["assets/sky.png", PNG.length, "image/png"], ["assets/tree.glb", GLB.length, "model/gltf-binary"]]);
  assert.ok(d.assets.every((x) => /^[0-9a-f]{64}$/.test(x.sha256)));
  assert.deepEqual(d.provenance.generated_by, ["games-c/companion", "games-c/patch"]);
  assert.deepEqual(d.provenance.patch_lineage, ["p_0a1b2c3d", "p_ffee0011"]);
  assert.match(d.playtest.verdict_hash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(d.moderation.status, "not_performed");
  assert.equal(d.created_at, FIXED);
  assert.equal(d.builder.name, "dcs-gamesc-publish");
  const entries = readTar(zlib.gunzipSync(p.archive));
  assert.deepEqual([...entries.keys()].sort(), ["assets/sky.png", "assets/tree.glb", "game-package.json", "manifest.json"]);
});

test("PUBLISH: deterministic tar round-trips and pins header fields", () => {
  const t1 = writeTar([{ path: "b.txt", bytes: Buffer.from("B") }, { path: "a.txt", bytes: Buffer.from("A") }]);
  const t2 = writeTar([{ path: "a.txt", bytes: Buffer.from("A") }, { path: "b.txt", bytes: Buffer.from("B") }]);
  assert.ok(t1.equals(t2));
  assert.deepEqual([...readTar(t1).entries()].map(([k, v]) => [k, v.toString()]), [["a.txt", "A"], ["b.txt", "B"]]);
  assert.throws(() => writeTar([{ path: "../x", bytes: Buffer.from("") }]), /unsafe/);
  const bad = Buffer.from(t1); bad[0] ^= 1;
  assert.throws(() => readTar(bad), /checksum/);
});

test("PUBLISH: canonical bytes agree with the patch lane; content hash is recorded, exact hash binds world_version", async () => {
  const patch = await import("../src/v3/gamesc/patch/index.mjs");
  const m = world();
  assert.equal(canonicalJSON(m), patch.canonicalJSON(m));
  const { package: p } = build();
  assert.equal(p.descriptor.manifest_content_hash, patch.hashManifest(m));
  const v2 = world(); v2.world_version = 2;
  assert.equal(patch.hashManifest(v2), patch.hashManifest(m), "patch content hash ignores world_version");
  assert.notEqual(hashManifestExact(v2), hashManifestExact(m), "package hash does not");
});

// ----------------------------------------------------------------- signature

test("PUBLISH: detached signature is an Atlas-canonical ed25519 receipt over the package_id", () => {
  const { package: p } = build();
  const s = p.signature;
  assert.equal(s.subject_type, "game_package");
  assert.equal(s.subject_id, p.package_id);
  assert.equal(s.public_key_b64, SIGNER.publicKeyB64);
  assert.deepEqual(verifyPackageSignature(s, p.package_id), { ok: true, key_trusted: null });
  assert.equal(verifyPackageSignature(s, p.package_id, { trustedPublicKeys: [SIGNER.publicKeyB64] }).key_trusted, true);
  assert.equal(verifyPackageSignature(s, p.package_id, { trustedPublicKeys: [generateThrowawaySigner().publicKeyB64] }).ok, false);
  // same bytes the Atlas verifier checks
  const pub = crypto.createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(s.public_key_b64, "base64")]), format: "der", type: "spki" });
  assert.ok(crypto.verify(null, Buffer.from(canonicalBody(s)), pub, Buffer.from(s.sig, "base64")));
});

test("PUBLISH: signature rejects a different package, a swapped key, an alias, a forged receipt_hash", () => {
  const { package: p } = build();
  const s = p.signature;
  assert.equal(verifyPackageSignature(s, "0".repeat(64)).ok, false);
  assert.equal(verifyPackageSignature({ ...s, public_key_b64: generateThrowawaySigner().publicKeyB64 }, p.package_id).ok, false);
  assert.equal(verifyPackageSignature({ ...s, world_id: "w_other" }, p.package_id).ok, false);
  assert.equal(verifyPackageSignature({ ...s, receipt_hash: "f".repeat(64) }, p.package_id).ok, false);
  assert.equal(verifyPackageSignature({ ...s, sig: Buffer.alloc(64).toString("base64") }, p.package_id).ok, false);
  assert.equal(verifyPackageSignature(null, p.package_id).ok, false);
});

// ------------------------------------------------------------------- refusals

test("REFUSE: invalid manifest", () => {
  const m = world(); delete m.terrain;
  const r = build({ manifest: m });
  assert.equal(r.ok, false); assert.ok(codes(r).includes("manifest_invalid"));
});

test("REFUSE: playtest verdict missing / not passing / for a different manifest", () => {
  assert.ok(codes(build({ playtestVerdict: null })).includes("playtest_missing"));
  for (const v of [{ passed: false, verdict: "REJECTED" }, { passed: false, verdict: "NEEDS_WORK" }, { passed: true, verdict: "REJECTED" }]) {
    assert.ok(codes(build({ playtestVerdict: v })).includes("playtest_not_passing"), JSON.stringify(v));
  }
  const other = world(); other.environment.weather = "snow";
  assert.ok(codes(build({ playtestVerdict: { ...PASS, manifest: other } })).includes("playtest_manifest_mismatch"));
  assert.ok(codes(build({ playtestVerdict: { ...PASS, manifest_hash: "sha256:" + "0".repeat(64) } })).includes("playtest_manifest_mismatch"));
});

test("REFUSE: asset missing hash, wrong hash, missing bytes, over budget", () => {
  assert.ok(codes(build({ assets: [asset("assets/t.glb", GLB, "model/gltf-binary", { sha256: undefined })] })).includes("asset_hash_missing"));
  assert.ok(codes(build({ assets: [asset("assets/t.glb", GLB, "model/gltf-binary", { sha256: sha("x") })] })).includes("asset_hash_mismatch"));
  assert.ok(codes(build({ assets: [{ path: "assets/t.glb", mime: "model/gltf-binary", sha256: sha(GLB) }] })).includes("asset_missing"));
  assert.ok(codes(build({ budgets: { maxAssetBytes: 16 } })).includes("asset_over_budget"));
  assert.ok(codes(build({ budgets: { maxTotalBytes: 100 } })).includes("package_over_budget"));
});

test("REFUSE: disallowed or mislabelled MIME, unsafe asset paths", () => {
  const html = Buffer.from("<script>alert(1)</script>");
  assert.ok(codes(build({ assets: [asset("assets/x.html", html, "text/html")] })).includes("asset_mime_disallowed"));
  // svg can carry script: refused even when a caller allowlists it
  assert.ok(codes(build({ assets: [asset("assets/x.svg", html, "image/svg+xml")], mimeAllowlist: ["image/svg+xml"] })).includes("asset_mime_disallowed"));
  assert.ok(codes(build({ assets: [asset("assets/x.glb", PNG, "model/gltf-binary")] })).includes("asset_mime_mismatch"));
  for (const p of ["../escape.png", "/abs/x.png", "assets/../x.png", "other/x.png"]) {
    assert.ok(codes(build({ assets: [asset(p, PNG, "image/png")] })).includes("asset_path_unsafe"), p);
  }
});

test("REFUSE: external asset URL not on the allowlist; allowlisted host passes; bad schemes refused", () => {
  const m = world(); m.assets.push({ id: "a_ext", kind: "prop", format: "glb", uri: "https://cdn.evil.example.net/x.glb", license: {} });
  const r = build({ manifest: m });
  assert.ok(codes(r).includes("external_url_not_allowlisted"));
  assert.equal(build({ manifest: m, hostAllowlist: ["cdn.evil.example.net"] }).ok, true);
  const j = world(); j.meta.description = "javascript:alert(1)";
  assert.ok(codes(build({ manifest: j })).includes("disallowed_url_scheme"));
  const d = world(); d.assets.push({ id: "a_d", kind: "prop", format: "glb", uri: "assets/missing.glb", license: {} });
  assert.ok(codes(build({ manifest: d })).includes("asset_missing"));
});

test("REFUSE: secret-like strings in manifest, provenance or text assets (never echoed)", () => {
  const fake = "sk-" + "A1b2C3d4E5f6G7h8I9j0K1l2M3";
  const m = world(); m.meta.description = "note " + fake;
  const r = build({ manifest: m });
  assert.ok(codes(r).includes("secret_like"));
  assert.ok(!JSON.stringify(r.errors).includes(fake), "the finding must not contain the secret");
  const g = world(); g.runtime_config.api_key = "Zq8" + "Xw2Lp9Rt4Vb7Nm1Kc5Hj3Df6";
  assert.ok(codes(build({ manifest: g })).includes("secret_like"));
  const env = world(); env.meta.description = "set ATLAS_PRIVATE_KEY here";
  assert.ok(codes(build({ manifest: env })).includes("secret_like"));
  assert.ok(codes(build({ provenance: { source: "AKIA" + "ABCDEFGHIJKLMNOP" } })).includes("secret_like"));
  const t = Buffer.from(JSON.stringify({ token: "ghp_" + "a".repeat(36) }));
  assert.ok(codes(build({ assets: [asset("assets/cfg.json", t, "application/json")] })).includes("secret_like"));
  // placeholders are not secrets
  const ok = world(); ok.meta.description = "api_key: 'YOUR_API_KEY_GOES_HERE_PLEASE'";
  assert.equal(build({ manifest: ok }).ok, true);
});

test("REFUSE: runtime pin missing or older than min_runtime; bad patch ids; no signer", () => {
  assert.ok(codes(build({ runtime: null })).includes("runtime_invalid"));
  assert.ok(codes(build({ runtime: { version: "latest" } })).includes("runtime_invalid"));
  assert.ok(codes(build({ runtime: { version: "2.9.9" } })).includes("runtime_too_old"));
  assert.ok(codes(build({ provenance: { patch_lineage: ["rm -rf"] } })).includes("provenance_invalid"));
  assert.ok(codes(build({ signer: undefined })).includes("signer_missing"));
  assert.ok(codes(build({ manifest: world("../etc") })).includes("world_id_unsafe"));
});

test("GATE: a real offline-generated world passes playtest and packages deterministically", async () => {
  const out = await createAssemblyRouter({ DCS_PROVIDERS_OFFLINE: "1" }).assemble({ prompt: "Ashfall Harbour, a rainy nordic port town", worldId: "w_real", creatorId: "u1" });
  const pt = await playtestAndRepair(out.manifest);
  assert.equal(pt.passed, true);
  const r = buildStagingPackage({ manifest: pt.manifest, runtime: { version: "3.0.0" }, playtestVerdict: pt, signer: SIGNER });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  const again = buildStagingPackage({ manifest: pt.manifest, runtime: { version: "3.0.0" }, playtestVerdict: pt, signer: SIGNER });
  assert.equal(again.package.package_id, r.package.package_id);
});

// ------------------------------------------------------------ registry + gate

test("REGISTRY: publish writes an immutable dir and openPreview returns the manifest", (t) => {
  const root = tmpRoot(); t.after(() => cleanup(root));
  const reg = createStagingRegistry({ root, now: clock(), env: ENV });
  const { package: p } = build();
  const res = reg.publishStaging(p);
  assert.equal(res.created, true);
  assert.equal(res.dir, path.join(root, "w_pub", p.package_id));
  assert.equal(res.channel.current, p.package_id);
  assert.equal(fs.statSync(path.join(res.dir, "manifest.json")).mode & 0o222, 0, "files are read-only");
  const open = openPreview(root, "w_pub", p.package_id, { trustedPublicKeys: [SIGNER.publicKeyB64] });
  assert.equal(open.ok, true, open.message);
  assert.deepEqual(open.manifest, world());
  assert.equal(open.manifest_hash, hashManifestExact(world()));
  assert.equal(open.key_trusted, true);
  assert.equal(reg.current("w_pub").package_id, p.package_id);
});

test("REGISTRY: republishing the same id is a no-op; different content gets a new id", (t) => {
  const root = tmpRoot(); t.after(() => cleanup(root));
  const reg = createStagingRegistry({ root, now: clock(), env: ENV });
  const a = build().package;
  reg.publishStaging(a);
  const again = reg.publishStaging(build().package);
  assert.equal(again.created, false);
  assert.equal(again.channel.history.length, 1, "idempotent republish does not append history");
  const m = world(); m.world_version = 2;
  const b = build({ manifest: m }).package;
  assert.notEqual(b.package_id, a.package_id);
  assert.equal(reg.publishStaging(b).created, true);
  assert.equal(reg.channel("w_pub").current, b.package_id);
});

test("REGISTRY: refuses to overwrite an existing id whose bytes differ on disk", (t) => {
  const root = tmpRoot(); t.after(() => cleanup(root));
  const reg = createStagingRegistry({ root, now: clock(), env: ENV });
  const p = build().package;
  const { dir } = reg.publishStaging(p);
  const f = path.join(dir, "assets", "sky.png");
  fs.chmodSync(f, 0o644); fs.writeFileSync(f, Buffer.concat([PNG, Buffer.from([0])]));
  assert.throws(() => reg.publishStaging(p), (e) => e instanceof PublishError && e.code === "immutable_conflict");
});

test("REGISTRY: refuses a package mutated in memory after build", (t) => {
  const root = tmpRoot(); t.after(() => cleanup(root));
  const reg = createStagingRegistry({ root, now: clock(), env: ENV });
  const p = build().package;
  p.files.set("manifest.json", Buffer.from("{}"));
  assert.throws(() => reg.publishStaging(p), (e) => e.code === "file_hash_mismatch");
  const q = build().package;
  assert.throws(() => reg.publishStaging({ ...q, signature: { ...q.signature, sig: Buffer.alloc(64).toString("base64") } }), (e) => e.code === "signature_invalid");
});

test("GATE: tampering with ANY file makes openPreview fail", (t) => {
  const root = tmpRoot(); t.after(() => cleanup(root));
  const reg = createStagingRegistry({ root, now: clock(), env: ENV });
  const p = build().package;
  const { dir } = reg.publishStaging(p);
  const files = ["manifest.json", "game-package.json", "assets/tree.glb", "assets/sky.png", "package.tar.gz", "package.sig.json"];
  for (const rel of files) {
    const f = path.join(dir, ...rel.split("/"));
    const orig = fs.readFileSync(f);
    makeWritable(dir);
    const bad = Buffer.from(orig); bad[Math.floor(bad.length / 2)] ^= 0x01;
    fs.writeFileSync(f, bad);
    const r = openPreview(root, "w_pub", p.package_id);
    assert.equal(r.ok, false, `tampered ${rel} must fail`);
    fs.writeFileSync(f, orig);
    assert.equal(openPreview(root, "w_pub", p.package_id).ok, true, `restored ${rel} verifies`);
  }
  // an extra, unlisted file is also refused
  fs.writeFileSync(path.join(dir, "assets", "extra.js"), "alert(1)");
  assert.equal(openPreview(root, "w_pub", p.package_id).code, "file_unlisted");
  fs.rmSync(path.join(dir, "assets", "extra.js"));
  // an untrusted key is refused when a trust list is given
  assert.equal(openPreview(root, "w_pub", p.package_id, { trustedPublicKeys: ["AAAA"] }).code, "signature_invalid");
  // a copied package under the wrong id / world is refused
  assert.equal(openPreview(root, "w_pub", "0".repeat(64)).ok, false);
  assert.equal(openPreview(root, "../w_pub", p.package_id).ok, false);
});

test("GATE: a re-signed archive with a swapped descriptor hash cannot pass", () => {
  const p = build().package;
  const entries = readTar(zlib.gunzipSync(p.archive));
  entries.set("manifest.json", Buffer.from(canonicalJSON({ ...world(), world_version: 9 })));
  const forged = zlib.gzipSync(writeTar([...entries].map(([k, v]) => ({ path: k, bytes: v }))), { level: 9 });
  const id = sha256Hex(forged);
  const other = generateThrowawaySigner("attacker");
  const body = { attestation: "stage_package", attested_by: "attacker", prev_hash: null, subject_type: "game_package", subject_id: id };
  const { receiptHash } = { receiptHash: (b) => sha(canonicalBody(b)) };
  const sig = { ...body, alg: "ed25519", receipt_hash: receiptHash(body), sig: other.signBody(body), public_key_b64: other.publicKeyB64 };
  const v = verifyArchive(forged, sig);
  assert.equal(v.ok, false);
  assert.equal(v.code, "file_hash_mismatch");
  assert.equal(verifyArchive(forged, sig, { trustedPublicKeys: [SIGNER.publicKeyB64] }).code, "signature_invalid");
});

test("ROLLBACK: pointer moves back, history is append-only, targets must verify", (t) => {
  const root = tmpRoot(); t.after(() => cleanup(root));
  const reg = createStagingRegistry({ root, now: clock(), env: ENV });
  const v1 = build().package;
  const m2 = world(); m2.world_version = 2; const v2 = build({ manifest: m2 }).package;
  const m3 = world(); m3.world_version = 3; const v3 = build({ manifest: m3 }).package;
  reg.publishStaging(v1); reg.publishStaging(v2); reg.publishStaging(v3);
  const ch = reg.rollback("w_pub", v1.package_id, { reason: "v3 regression" });
  assert.equal(ch.current, v1.package_id);
  assert.deepEqual(ch.history.map((h) => [h.seq, h.action, h.package_id, h.from]), [
    [1, "stage", v1.package_id, null],
    [2, "stage", v2.package_id, v1.package_id],
    [3, "stage", v3.package_id, v2.package_id],
    [4, "rollback", v1.package_id, v3.package_id],
  ]);
  assert.equal(ch.history[3].reason, "v3 regression");
  assert.equal(reg.current("w_pub").manifest.world_version, 1);
  // all three package dirs still exist — rollback deletes nothing
  for (const p of [v1, v2, v3]) assert.ok(fs.existsSync(path.join(root, "w_pub", p.package_id)));
  assert.throws(() => reg.rollback("w_pub", v1.package_id), (e) => e.code === "already_current");
  assert.throws(() => reg.rollback("w_pub", "a".repeat(64)), (e) => e.code === "not_in_history");
  // a tampered target is refused
  const f = path.join(root, "w_pub", v2.package_id, "manifest.json");
  makeWritable(path.join(root, "w_pub", v2.package_id)); fs.appendFileSync(f, " ");
  assert.throws(() => reg.rollback("w_pub", v2.package_id), (e) => e.code === "rollback_target_invalid");
  assert.equal(reg.channel("w_pub").history.length, 4, "a refused rollback appends nothing");
});

// -------------------------------------------------------- staging-only guards

test("GUARD: production hosts are refused; staging/local targets allowed", () => {
  for (const bad of ["https://games.dcsai.ai", "https://api.games.dcsai.ai/x", "games.dcsai.ai", "https://dcsai.ai", "https://www.dcsai.ai",
    "https://dcs-games.pages.dev", "https://gamesdcsai.example.com", "https://games.dcsai.ai.evil.net"]) {
    assert.throws(() => assertStagingTarget(bad), ProductionTargetError, bad);
  }
  for (const good of ["http://127.0.0.1:8788/preview", "http://localhost:3000", "https://staging.games.dcsai.ai/preview",
    "https://api-staging.games.dcsai.ai", "https://staging.dcs-games.pages.dev", "https://preview.dcs-games.pages.dev"]) {
    assert.doesNotThrow(() => assertStagingTarget(good), good);
  }
  assert.throws(() => assertStagingOnlyEnv({ DCS_PUBLISH_TARGET: "https://games.dcsai.ai" }), ProductionTargetError);
  assert.throws(() => createStagingRegistry({ root: "/nonexistent", env: { DCS_STAGING_PREVIEW_BASE: "https://api.games.dcsai.ai" } }), ProductionTargetError);
});

test("GUARD: previewUrl is staging-only and defaults to localhost", () => {
  const p = build().package;
  assert.equal(previewUrl(p, { env: {} }), `${DEFAULT_PREVIEW_BASE}/w_pub/${p.package_id}/`);
  assert.equal(previewUrl(p, { env: { DCS_STAGING_PREVIEW_BASE: "https://staging.games.dcsai.ai/p/" } }), `https://staging.games.dcsai.ai/p/w_pub/${p.package_id}/`);
  assert.throws(() => previewUrl(p, { env: { DCS_STAGING_PREVIEW_BASE: "https://games.dcsai.ai" } }), ProductionTargetError);
  assert.ok(!previewUrl(p, { env: {} }).includes("dcsai.ai"));
});

// -------------------------------------------------------------- preview server

test("PREVIEW SERVER: loopback only; serves a verified manifest with its hash; refuses tampered packages", async (t) => {
  const root = tmpRoot(); t.after(() => cleanup(root));
  const reg = createStagingRegistry({ root, now: clock(), env: ENV });
  const p = build().package;
  const { dir } = reg.publishStaging(p);
  await assert.rejects(() => startPreviewServer({ root, host: "0.0.0.0" }), (e) => e.code === "preview_host_refused");
  const srv = await startPreviewServer({ root, trustedPublicKeys: [SIGNER.publicKeyB64] });
  t.after(() => srv.close());
  assert.match(srv.base, /^http:\/\/127\.0\.0\.1:\d+\/preview$/);
  const url = previewUrl(p, { env: { DCS_STAGING_PREVIEW_BASE: srv.base } });
  const r = await fetch(url + "manifest.json");
  assert.equal(r.status, 200);
  const body = Buffer.from(await r.arrayBuffer());
  assert.equal(r.headers.get("x-dcs-manifest-hash"), hashManifestExact(world()));
  assert.equal(hashManifestExact(JSON.parse(body.toString("utf8"))), p.descriptor.manifest_hash);
  assert.equal(r.headers.get("x-dcs-runtime-version"), "3.1.0");
  assert.equal(sha(body), p.descriptor.files.find((f) => f.path === "manifest.json").sha256);
  const cur = await fetch(`${srv.base}/w_pub/current/manifest.json`);
  assert.equal(cur.headers.get("x-dcs-package-id"), p.package_id);
  await cur.arrayBuffer();
  const g = await fetch(url + "assets/tree.glb");
  assert.equal(g.headers.get("content-type"), "model/gltf-binary");
  assert.ok(Buffer.from(await g.arrayBuffer()).equals(GLB));
  const miss = await fetch(url + "../../etc/passwd"); await miss.arrayBuffer();
  assert.equal(miss.status, 404);
  const post = await fetch(url + "manifest.json", { method: "POST" }); await post.arrayBuffer();
  assert.equal(post.status, 405);
  makeWritable(dir); fs.appendFileSync(path.join(dir, "assets", "tree.glb"), "x");
  const bad = await fetch(url + "manifest.json"); await bad.arrayBuffer();
  assert.equal(bad.status, 409, "a tampered package is never served");
});
