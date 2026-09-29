// package.mjs — build an IMMUTABLE, content-addressed, signed STAGING package.
//
//   buildStagingPackage({ manifest, assets, runtime, provenance, playtestVerdict, signer, ... })
//     -> { ok:true, package } | { ok:false, errors:[{code, path, message}] }
//
// package_id = sha256(hex) of the deterministic archive bytes (ustar + gzip,
// every variable header field pinned). Same input => byte-identical archive =>
// same package_id. The archive carries game-package.json, manifest.json and
// assets/*; the detached signature (package.sig.json) signs the package_id with
// the Atlas canonical receipt body, so it verifies with the same rules as every
// other Atlas receipt.
import crypto from "node:crypto";
import zlib from "node:zlib";
import { validateManifest } from "../../manifest/schema.mjs";
import { canonicalBody, receiptHash, atlasReady, atlasPublicKeyBase64, signReceipt } from "../../../cw7/atlas-local-sign.mjs";
import { canonicalJSON, hashManifestExact, sha256Hex } from "./canonical.mjs";
import { hashManifest as patchContentHash } from "../patch/index.mjs";
import { writeTar, readTar, safeEntryPath } from "./tar.mjs";
import {
  scanSecrets, scanTextSecrets, checkUrls, magicMatches,
  DEFAULT_MIME_ALLOWLIST, NEVER_MIME, TEXT_MIME,
} from "./guards.mjs";

export const PACKAGE_VERSION = "1";
export const BUILDER = Object.freeze({ name: "dcs-gamesc-publish", version: "1.0.0" });
export const ARCHIVE_FILE = "package.tar.gz";
export const SIGNATURE_FILE = "package.sig.json";
export const DESCRIPTOR_FILE = "game-package.json";
export const MANIFEST_FILE = "manifest.json";
export const RUNTIME_ENTRY = "dcs-runtime.js";
export const PASSING_VERDICTS = Object.freeze(["PASSED", "PASSED_WITH_NOTES"]);
export const DEFAULT_BUDGETS = Object.freeze({
  maxAssetBytes: 25 * 1024 * 1024,
  maxTotalBytes: 100 * 1024 * 1024,
  maxManifestBytes: 2 * 1024 * 1024,
  maxAssets: 500,
});
export const WORLD_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
export const PACKAGE_ID_RE = /^[0-9a-f]{64}$/;
const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/;
const PATCH_ID_RE = /^p_[0-9a-f]{6,}$/;

// ------------------------------------------------------------------ signers
//
// A signer signs the Atlas CANONICAL RECEIPT BODY (atlas-local-sign.canonicalBody),
// never ad-hoc bytes, so a package signature is an ordinary Atlas receipt.

function rawPublicB64(pubKeyObj) {
  const spki = pubKeyObj.export({ type: "spki", format: "der" });
  return spki.subarray(spki.length - 32).toString("base64");
}
function spkiFromRawB64(b64) {
  const raw = Buffer.from(String(b64), "base64");
  if (raw.length !== 32) throw new Error("public key must be 32 raw bytes");
  return crypto.createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]), format: "der", type: "spki" });
}

/** Signer from an in-memory ed25519 KeyObject. Never reads env or disk. */
export function createEd25519Signer({ privateKey, id = "local-ed25519" }) {
  const pub = crypto.createPublicKey(privateKey);
  return Object.freeze({
    id, kind: "local-ed25519", publicKeyB64: rawPublicB64(pub),
    signBody: (body) => crypto.sign(null, Buffer.from(canonicalBody(body), "utf8"), privateKey).toString("base64"),
  });
}

/** Fresh throwaway key (tests, local dry runs). The private key never leaves this object. */
export function generateThrowawaySigner(id = "throwaway") {
  const { privateKey } = crypto.generateKeyPairSync("ed25519");
  return createEd25519Signer({ privateKey, id });
}

/**
 * The configured Atlas key (ATLAS_PRIVATE_KEY via atlas-local-sign). Only
 * constructed when a caller asks for it explicitly — tests never do. Returns
 * null when no key is configured (fail closed; nothing is packaged unsigned).
 */
export function atlasEnvSigner(id = "atlas-env") {
  if (!atlasReady()) return null;
  return Object.freeze({ id, kind: "atlas-env", publicKeyB64: atlasPublicKeyBase64(), signBody: (body) => signReceipt(body) });
}

export function signatureBody(packageId, attestedBy) {
  return { attestation: "stage_package", attested_by: attestedBy, prev_hash: null, subject_type: "game_package", subject_id: packageId };
}

/** Verify a detached package signature. Pure; never throws. */
export function verifyPackageSignature(sig, packageId, { trustedPublicKeys = null } = {}) {
  try {
    if (!sig || typeof sig !== "object") return { ok: false, reason: "no signature" };
    if (sig.alg !== "ed25519") return { ok: false, reason: "unsupported alg" };
    if (sig.subject_type !== "game_package" || sig.attestation !== "stage_package") return { ok: false, reason: "not a package signature" };
    if (sig.subject_id !== packageId) return { ok: false, reason: "signature is for a different package" };
    for (const a of ["world_id", "asset_id", "builder_id", "author_id", "action"]) {
      if (sig[a] != null) return { ok: false, reason: `unsigned alias '${a}' present` };
    }
    if (sig.receipt_hash !== receiptHash(sig)) return { ok: false, reason: "receipt_hash does not match the signed body" };
    const pub = spkiFromRawB64(sig.public_key_b64);
    const good = crypto.verify(null, Buffer.from(canonicalBody(sig), "utf8"), pub, Buffer.from(String(sig.sig), "base64"));
    if (!good) return { ok: false, reason: "bad signature" };
    const trusted = Array.isArray(trustedPublicKeys) ? trustedPublicKeys.includes(sig.public_key_b64) : null;
    if (trusted === false) return { ok: false, reason: "signing key is not trusted" };
    return { ok: true, key_trusted: trusted };
  } catch (e) {
    return { ok: false, reason: "signature unverifiable: " + e.message };
  }
}

// ---------------------------------------------------------------- helpers

function semverCmp(a, b) {
  const x = SEMVER_RE.exec(a), y = SEMVER_RE.exec(b);
  if (!x || !y) return NaN;
  for (let i = 1; i <= 3; i++) { const d = Number(x[i]) - Number(y[i]); if (d) return d; }
  return 0;
}

/** Hash of a playtest verdict, independent of the (large) repaired manifest it may carry. */
export function playtestVerdictHash(verdict) {
  const { manifest: _m, ...rest } = verdict || {};
  return "sha256:" + sha256Hex(Buffer.from(canonicalJSON(rest), "utf8"));
}

function toBuffer(b) {
  if (Buffer.isBuffer(b)) return b;
  if (b instanceof Uint8Array) return Buffer.from(b);
  if (typeof b === "string") return Buffer.from(b, "utf8");
  return null;
}

// ------------------------------------------------------------------- build

/**
 * @param {object} a
 * @param {object} a.manifest           WorldManifestV3
 * @param {Array<{path:string, bytes:Buffer|string, mime:string, sha256:string, id?:string}>} [a.assets]
 *        path is package-relative and must start with "assets/"; sha256 is the
 *        DECLARED hash (hex) and must match the bytes.
 * @param {{version:string, sha256?:string}} a.runtime   pinned play-v3 runtime (dcs-runtime.js)
 * @param {{generated_by?:string[], patch_lineage?:string[], source?:string}} [a.provenance]
 * @param {object} a.playtestVerdict    result of playtestAndRepair()/critique()
 * @param {object} [a.signer]           createEd25519Signer()/generateThrowawaySigner()/atlasEnvSigner()
 * @param {string} [a.createdAt]        ISO; defaults to manifest.meta.updated_at || created_at (deterministic)
 * @param {object} [a.moderation]       placeholder; recorded, not enforced (no moderation gate exists yet)
 * @param {string[]} [a.hostAllowlist]  external asset hosts permitted in the manifest
 * @param {string[]} [a.mimeAllowlist]
 * @param {object} [a.budgets]
 */
export function buildStagingPackage(a = {}) {
  const errors = [];
  const E = (code, path, message) => errors.push({ code, path, message });
  const budgets = { ...DEFAULT_BUDGETS, ...(a.budgets || {}) };
  const mimeAllow = new Set((a.mimeAllowlist || DEFAULT_MIME_ALLOWLIST).filter((m) => !NEVER_MIME.includes(m)));
  const { manifest, runtime, playtestVerdict } = a;

  // 1. manifest
  const v = validateManifest(manifest);
  if (!v.ok) for (const e of v.errors) E("manifest_invalid", e.path, e.message);
  if (manifest && typeof manifest === "object" && !WORLD_ID_RE.test(String(manifest.world_id))) E("world_id_unsafe", "world_id", "world_id must match " + WORLD_ID_RE);
  let manifestBytes = null, manifestHash = null;
  try {
    manifestBytes = Buffer.from(canonicalJSON(manifest), "utf8");
    manifestHash = hashManifestExact(manifest);
    if (manifestBytes.length > budgets.maxManifestBytes) E("manifest_over_budget", "$", `manifest is ${manifestBytes.length} bytes (budget ${budgets.maxManifestBytes})`);
  } catch (e) { E("manifest_invalid", "$", "manifest is not canonical JSON: " + e.message); }

  // 2. playtest gate
  if (!playtestVerdict || typeof playtestVerdict !== "object") E("playtest_missing", "playtestVerdict", "a playtest verdict is required");
  else {
    if (playtestVerdict.passed !== true || !PASSING_VERDICTS.includes(playtestVerdict.verdict)) {
      E("playtest_not_passing", "playtestVerdict", `playtest verdict is '${playtestVerdict.verdict}' (passed=${playtestVerdict.passed}); packaging requires ${PASSING_VERDICTS.join(" or ")}`);
    }
    // A verdict about a DIFFERENT manifest is not a verdict about this one.
    if (playtestVerdict.manifest && manifestHash && hashManifestExact(playtestVerdict.manifest) !== manifestHash) {
      E("playtest_manifest_mismatch", "playtestVerdict.manifest", "the playtest verdict was produced for a different manifest (e.g. before repairs were applied)");
    }
    if (playtestVerdict.manifest_hash && manifestHash && playtestVerdict.manifest_hash !== manifestHash) {
      E("playtest_manifest_mismatch", "playtestVerdict.manifest_hash", "verdict manifest_hash does not match the manifest being packaged");
    }
  }

  // 3. runtime pin
  if (!runtime || !SEMVER_RE.test(String(runtime.version || ""))) E("runtime_invalid", "runtime.version", "a pinned semver runtime version is required");
  else {
    const min = manifest?.expansion?.compatibility?.min_runtime;
    if (min && semverCmp(runtime.version, min) < 0) E("runtime_too_old", "runtime.version", `runtime ${runtime.version} is older than the manifest's min_runtime ${min}`);
    if (runtime.sha256 != null && !/^[0-9a-f]{64}$/.test(runtime.sha256)) E("runtime_invalid", "runtime.sha256", "must be 64 lowercase hex chars when present");
  }

  // 4. assets
  const assets = Array.isArray(a.assets) ? a.assets : [];
  if (a.assets != null && !Array.isArray(a.assets)) E("assets_invalid", "assets", "must be an array");
  if (assets.length > budgets.maxAssets) E("assets_over_budget", "assets", `${assets.length} assets (budget ${budgets.maxAssets})`);
  const entries = [];
  const assetRows = [];
  const paths = new Set();
  let total = manifestBytes ? manifestBytes.length : 0;
  assets.forEach((as, i) => {
    const p = `assets[${i}]`;
    if (!as || typeof as !== "object") { E("asset_invalid", p, "must be an object"); return; }
    if (!safeEntryPath(as.path) || !as.path.startsWith("assets/")) { E("asset_path_unsafe", `${p}.path`, "must be a safe relative path under assets/ (<=100 bytes, [A-Za-z0-9._-/])"); return; }
    if (paths.has(as.path)) { E("asset_duplicate", `${p}.path`, `duplicate '${as.path}'`); return; }
    paths.add(as.path);
    const bytes = toBuffer(as.bytes);
    if (!bytes) { E("asset_missing", `${p}.bytes`, "asset bytes are missing"); return; }
    if (typeof as.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(as.sha256)) { E("asset_hash_missing", `${p}.sha256`, "every asset must declare its sha256 (hex)"); return; }
    const actual = sha256Hex(bytes);
    if (actual !== as.sha256) { E("asset_hash_mismatch", `${p}.sha256`, "declared sha256 does not match the bytes"); return; }
    if (bytes.length > budgets.maxAssetBytes) E("asset_over_budget", p, `${bytes.length} bytes (budget ${budgets.maxAssetBytes})`);
    total += bytes.length;
    const mime = String(as.mime || "").toLowerCase();
    if (NEVER_MIME.includes(mime) || !mimeAllow.has(mime)) { E("asset_mime_disallowed", `${p}.mime`, `MIME '${mime || "(none)"}' is not allowed`); return; }
    if (!magicMatches(mime, bytes)) { E("asset_mime_mismatch", `${p}.mime`, `bytes are not ${mime}`); return; }
    if (TEXT_MIME.has(mime)) for (const f of scanTextSecrets(bytes.toString("utf8"), as.path)) errors.push(f);
    entries.push({ path: as.path, bytes });
    assetRows.push({ path: as.path, id: as.id ?? null, sha256: actual, size: bytes.length, mime });
  });
  if (total > budgets.maxTotalBytes) E("package_over_budget", "assets", `${total} bytes total (budget ${budgets.maxTotalBytes})`);

  // 5. external URLs / dangling package refs, 6. secrets
  if (manifest && typeof manifest === "object") {
    errors.push(...checkUrls(manifest, { hostAllowlist: a.hostAllowlist || [], packagedPaths: paths }));
    errors.push(...scanSecrets(manifest, "manifest"));
  }
  const prov = a.provenance || {};
  errors.push(...scanSecrets(prov, "provenance"));
  const lineage = Array.isArray(prov.patch_lineage) ? prov.patch_lineage : [];
  lineage.forEach((id, i) => { if (!PATCH_ID_RE.test(String(id))) E("provenance_invalid", `provenance.patch_lineage[${i}]`, "patch ids must look like p_<hex>"); });

  // 7. signer (fail closed: nothing is staged unsigned)
  const signer = a.signer;
  if (!signer || typeof signer.signBody !== "function" || !signer.publicKeyB64) E("signer_missing", "signer", "a signer is required; pass generateThrowawaySigner() for local runs or atlasEnvSigner() where a key is configured");

  if (errors.length) return { ok: false, errors };

  // ---- descriptor (no wall clock: created_at is an input) ----
  const createdAt = a.createdAt || manifest.meta.updated_at || manifest.meta.created_at;
  const generatedBy = [...new Set([...(manifest.provenance?.generated_by || []), ...(prov.generated_by || [])].map(String))].sort();
  assetRows.sort((x, y) => (x.path < y.path ? -1 : 1));
  const files = [{ path: MANIFEST_FILE, sha256: sha256Hex(manifestBytes), size: manifestBytes.length }, ...assetRows.map(({ path, sha256, size }) => ({ path, sha256, size }))];
  const descriptor = {
    package_version: PACKAGE_VERSION,
    world_id: manifest.world_id,
    world_version: manifest.world_version,
    title: manifest.meta.title,
    manifest_file: MANIFEST_FILE,
    manifest_hash: manifestHash,
    manifest_content_hash: patchContentHash(manifest),
    runtime: { entry: RUNTIME_ENTRY, version: runtime.version, sha256: runtime.sha256 ?? null },
    assets: assetRows,
    files,
    provenance: {
      generated_by: generatedBy,
      patch_lineage: lineage.map(String),
      source_prompt_hash: manifest.provenance?.source_prompt_hash ?? null,
      source: prov.source ?? null,
    },
    playtest: { verdict: playtestVerdict.verdict, passed: true, verdict_hash: playtestVerdictHash(playtestVerdict) },
    moderation: a.moderation
      ? { status: "recorded_not_enforced", verdict_hash: "sha256:" + sha256Hex(Buffer.from(canonicalJSON(a.moderation), "utf8")) }
      : { status: "not_performed", note: "no moderation gate exists in the GAMES-C pipeline; staging only, promotion must require one" },
    channel: "staging",
    created_at: createdAt,
    builder: { ...BUILDER },
  };
  const descriptorBytes = Buffer.from(JSON.stringify(JSON.parse(canonicalJSON(descriptor)), null, 2) + "\n", "utf8");
  entries.push({ path: MANIFEST_FILE, bytes: manifestBytes }, { path: DESCRIPTOR_FILE, bytes: descriptorBytes });

  const archive = zlib.gzipSync(writeTar(entries), { level: 9 });
  const packageId = sha256Hex(archive);

  const body = signatureBody(packageId, String(signer.id));
  const sig = signer.signBody(body);
  if (!sig) return { ok: false, errors: [{ code: "signing_failed", path: "signer", message: "signer returned no signature" }] };
  const signature = { ...body, alg: "ed25519", receipt_hash: receiptHash(body), sig, public_key_b64: signer.publicKeyB64, signer: signer.kind || "local-ed25519" };

  const fileMap = new Map(entries.map((e) => [e.path, e.bytes]));
  return {
    ok: true,
    package: Object.freeze({ package_id: packageId, world_id: manifest.world_id, archive, descriptor, signature, files: fileMap }),
  };
}

/**
 * Verify an archive + signature pair and return its parsed contents. Shared by
 * publishStaging (before writing) and openPreview (after reading). Never throws.
 */
export function verifyArchive(archive, signature, { expectedPackageId = null, trustedPublicKeys = null } = {}) {
  const fail = (code, message) => ({ ok: false, code, message });
  if (!Buffer.isBuffer(archive)) return fail("archive_missing", "no archive");
  const id = sha256Hex(archive);
  if (expectedPackageId && id !== expectedPackageId) return fail("package_id_mismatch", "archive hash does not match the package id");
  const s = verifyPackageSignature(signature, id, { trustedPublicKeys });
  if (!s.ok) return fail("signature_invalid", s.reason);
  let entries;
  try { entries = readTar(zlib.gunzipSync(archive)); } catch (e) { return fail("archive_corrupt", e.message); }
  const dBytes = entries.get(DESCRIPTOR_FILE);
  if (!dBytes) return fail("descriptor_missing", "archive has no " + DESCRIPTOR_FILE);
  let descriptor;
  try { descriptor = JSON.parse(dBytes.toString("utf8")); } catch { return fail("descriptor_corrupt", "unparseable descriptor"); }
  const listed = new Set([DESCRIPTOR_FILE]);
  for (const f of descriptor.files || []) {
    listed.add(f.path);
    const b = entries.get(f.path);
    if (!b) return fail("file_missing", `${f.path} is listed but not archived`);
    if (b.length !== f.size || sha256Hex(b) !== f.sha256) return fail("file_hash_mismatch", `${f.path} does not match its descriptor hash`);
  }
  for (const k of entries.keys()) if (!listed.has(k)) return fail("file_unlisted", `${k} is archived but not in the descriptor`);
  let manifest;
  try { manifest = JSON.parse(entries.get(descriptor.manifest_file || MANIFEST_FILE).toString("utf8")); } catch { return fail("manifest_corrupt", "unparseable manifest"); }
  if (hashManifestExact(manifest) !== descriptor.manifest_hash) return fail("manifest_hash_mismatch", "manifest does not match manifest_hash");
  if (manifest.world_id !== descriptor.world_id) return fail("world_id_mismatch", "manifest world_id differs from descriptor");
  return { ok: true, package_id: id, descriptor, manifest, entries, key_trusted: s.key_trusted };
}
