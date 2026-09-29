// registry.mjs — STAGING publish registry on a local filesystem root.
//
//   <root>/<world_id>/<package_id>/            immutable, read-only files
//       package.tar.gz  package.sig.json  game-package.json  manifest.json  assets/...
//   <root>/<world_id>/channels/staging.json    { world_id, channel, current, history:[...] }  (append-only history)
//
// There is deliberately no "production" channel here. Promotion is manual and
// out of scope (see DCS_GAMES_PUBLISH_PIPELINE.md).
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { sha256Hex } from "./canonical.mjs";
import {
  verifyArchive, ARCHIVE_FILE, SIGNATURE_FILE, DESCRIPTOR_FILE, WORLD_ID_RE, PACKAGE_ID_RE,
} from "./package.mjs";
import { assertStagingTarget, assertStagingOnlyEnv } from "./guards.mjs";

export const CHANNEL = "staging";
export const DEFAULT_PREVIEW_BASE = "http://127.0.0.1:8788/preview";

export class PublishError extends Error {
  constructor(code, message) { super(message); this.name = "PublishError"; this.code = code; }
}

function checkIds(worldId, packageId) {
  if (!WORLD_ID_RE.test(String(worldId))) throw new PublishError("world_id_unsafe", "unsafe world_id");
  if (packageId != null && !PACKAGE_ID_RE.test(String(packageId))) throw new PublishError("package_id_invalid", "package_id must be 64 hex chars");
}

function writeJsonAtomic(file, value) {
  const tmp = file + ".tmp-" + process.pid + "-" + Math.random().toString(16).slice(2);
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

function listTree(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isSymbolicLink()) throw new PublishError("symlink_in_package", `symlink in package: ${path.relative(base, full)}`);
    if (e.isDirectory()) listTree(full, base, out);
    else out.push(path.relative(base, full).split(path.sep).join("/"));
  }
  return out;
}

function chmodTree(dir, fileMode, dirMode) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { chmodTree(full, fileMode, dirMode); fs.chmodSync(full, dirMode); }
    else fs.chmodSync(full, fileMode);
  }
}

/** The files a package directory must contain, as name -> bytes. */
function packageFiles(pkg) {
  const files = new Map(pkg.files);
  files.set(ARCHIVE_FILE, pkg.archive);
  files.set(SIGNATURE_FILE, Buffer.from(JSON.stringify(pkg.signature, null, 2) + "\n", "utf8"));
  return files;
}

/**
 * Open a staged package for preview — the "reopen published preview" gate.
 * Verifies: dir name == sha256(archive) == signed subject; ed25519 signature;
 * every archived file against the descriptor; every LOOSE file byte-equal to
 * its archived copy; no extra loose files. Returns the manifest ready for the
 * runtime, or {ok:false, code, message}. Never throws.
 */
export function openPreview(root, worldId, packageId, { trustedPublicKeys = null } = {}) {
  try {
    checkIds(worldId, packageId);
    const dir = path.join(root, worldId, packageId);
    if (!fs.existsSync(dir)) return { ok: false, code: "not_found", message: "no such staged package" };
    const archive = fs.readFileSync(path.join(dir, ARCHIVE_FILE));
    let signature;
    try { signature = JSON.parse(fs.readFileSync(path.join(dir, SIGNATURE_FILE), "utf8")); }
    catch { return { ok: false, code: "signature_invalid", message: "missing or unparseable signature" }; }
    const v = verifyArchive(archive, signature, { expectedPackageId: packageId, trustedPublicKeys });
    if (!v.ok) return v;
    if (v.descriptor.world_id !== worldId) return { ok: false, code: "world_id_mismatch", message: "package belongs to another world" };
    const expected = new Set([ARCHIVE_FILE, SIGNATURE_FILE, ...v.entries.keys()]);
    for (const rel of listTree(dir)) {
      if (!expected.has(rel)) return { ok: false, code: "file_unlisted", message: `unexpected file ${rel}` };
    }
    for (const [rel, bytes] of v.entries) {
      const p = path.join(dir, rel);
      if (!fs.existsSync(p)) return { ok: false, code: "file_missing", message: `${rel} missing on disk` };
      const disk = fs.readFileSync(p);
      if (!disk.equals(bytes)) return { ok: false, code: "file_hash_mismatch", message: `${rel} on disk does not match the signed archive` };
    }
    return {
      ok: true, package_id: packageId, world_id: worldId, manifest: v.manifest, descriptor: v.descriptor,
      manifest_hash: v.descriptor.manifest_hash, runtime: v.descriptor.runtime, key_trusted: v.key_trusted, dir,
    };
  } catch (e) {
    return { ok: false, code: e.code || "open_failed", message: e.message };
  }
}

/**
 * Staging-only preview URL. Base comes from env.DCS_STAGING_PREVIEW_BASE
 * (default a localhost URL) and is refused if it names a production host.
 */
export function previewUrl(pkg, { env = process.env } = {}) {
  const base = String(env.DCS_STAGING_PREVIEW_BASE || DEFAULT_PREVIEW_BASE).replace(/\/+$/, "");
  assertStagingTarget(base);
  const worldId = pkg.world_id ?? pkg.descriptor?.world_id;
  checkIds(worldId, pkg.package_id);
  return `${base}/${encodeURIComponent(worldId)}/${pkg.package_id}/`;
}

// readOnly: chmod each package dir to 0555/0444 once written. Immutability does
// not depend on it (packages are content-addressed, re-verified on read, and a
// differing overwrite is refused), and a read-only tree cannot be pruned or
// cleaned up without a chmod first, so a host can turn it off.
export function createStagingRegistry({ root, now = () => new Date().toISOString(), env = process.env, readOnly = true } = {}) {
  if (!root) throw new PublishError("root_required", "a registry root directory is required");
  assertStagingOnlyEnv(env);
  const channelFile = (worldId) => path.join(root, worldId, "channels", `${CHANNEL}.json`);

  function readChannel(worldId) {
    checkIds(worldId);
    const f = channelFile(worldId);
    if (!fs.existsSync(f)) return { world_id: worldId, channel: CHANNEL, current: null, history: [] };
    return JSON.parse(fs.readFileSync(f, "utf8"));
  }

  function movePointer(worldId, packageId, action, extra = {}) {
    const ch = readChannel(worldId);
    const from = ch.current;
    if (from === packageId && action === "stage") return ch; // idempotent republish
    const next = {
      ...ch, current: packageId,
      history: [...ch.history, { seq: ch.history.length + 1, action, package_id: packageId, from, at: now(), ...extra }],
    };
    fs.mkdirSync(path.dirname(channelFile(worldId)), { recursive: true });
    writeJsonAtomic(channelFile(worldId), next);
    return next;
  }

  /**
   * Write an immutable package dir and point staging at it.
   * Same package_id already present with identical bytes -> no-op write ({created:false}).
   * Same id present but bytes differ on disk -> refuse (tampered or corrupt store).
   */
  function publishStaging(pkg) {
    if (!pkg || !pkg.package_id) throw new PublishError("package_invalid", "not a built package");
    checkIds(pkg.world_id, pkg.package_id);
    // Re-verify what we were handed: an in-memory package can be mutated after build.
    const v = verifyArchive(pkg.archive, pkg.signature, { expectedPackageId: pkg.package_id });
    if (!v.ok) throw new PublishError(v.code, "refusing to stage an unverifiable package: " + v.message);
    for (const [rel, bytes] of pkg.files) {
      const archived = v.entries.get(rel);
      if (!archived || !archived.equals(bytes)) throw new PublishError("file_hash_mismatch", `in-memory ${rel} differs from the signed archive`);
    }
    const dir = path.join(root, pkg.world_id, pkg.package_id);
    let created = false;
    if (fs.existsSync(dir)) {
      const files = packageFiles(pkg);
      const onDisk = listTree(dir);
      const same = onDisk.length === files.size && onDisk.every((rel) => files.has(rel) && fs.readFileSync(path.join(dir, rel)).equals(files.get(rel)));
      if (!same) throw new PublishError("immutable_conflict", `package ${pkg.package_id} already exists with different bytes; refusing to overwrite`);
    } else {
      fs.mkdirSync(path.join(root, pkg.world_id), { recursive: true });
      const tmp = path.join(root, pkg.world_id, `.tmp-${pkg.package_id}-${process.pid}-${Math.random().toString(16).slice(2)}`);
      for (const [rel, bytes] of packageFiles(pkg)) {
        const p = path.join(tmp, ...rel.split("/"));
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, bytes);
      }
      if (readOnly) chmodTree(tmp, 0o444, 0o555);
      try { fs.renameSync(tmp, dir); }
      catch (e) { chmodTree(tmp, 0o644, 0o755); fs.rmSync(tmp, { recursive: true, force: true }); throw new PublishError("immutable_conflict", "concurrent publish of the same id: " + e.message); }
      if (readOnly) fs.chmodSync(dir, 0o555);
      created = true;
    }
    const channel = movePointer(pkg.world_id, pkg.package_id, "stage");
    return { created, package_id: pkg.package_id, world_id: pkg.world_id, dir, channel, preview_url: previewUrl(pkg, { env }) };
  }

  /** Move the staging pointer back to an earlier, still-verifiable package. History is append-only. */
  function rollback(worldId, toPackageId, { reason = null, trustedPublicKeys = null } = {}) {
    checkIds(worldId, toPackageId);
    const ch = readChannel(worldId);
    if (!ch.history.some((h) => h.package_id === toPackageId)) throw new PublishError("not_in_history", "can only roll back to a package that was staged on this channel");
    if (ch.current === toPackageId) throw new PublishError("already_current", "that package is already current");
    const open = openPreview(root, worldId, toPackageId, { trustedPublicKeys });
    if (!open.ok) throw new PublishError("rollback_target_invalid", `rollback target fails verification: ${open.code}`);
    return movePointer(worldId, toPackageId, "rollback", { reason });
  }

  function current(worldId, opts) {
    const ch = readChannel(worldId);
    return ch.current ? openPreview(root, worldId, ch.current, opts) : { ok: false, code: "no_current", message: "nothing staged" };
  }

  return { root, publishStaging, rollback, channel: readChannel, current, openPreview: (w, p, o) => openPreview(root, w, p, o) };
}

// -------------------------------------------------------- local preview server
//
// 127.0.0.1 only, ephemeral port. Serves a package ONLY after openPreview has
// verified it; the manifest carries its hash in X-DCS-Manifest-Hash / ETag.
//   GET /preview/<world_id>/<package_id>/<file>
//   GET /preview/<world_id>/current/<file>        (resolves the staging pointer)
const MIME_BY_EXT = { json: "application/json", glb: "model/gltf-binary", gltf: "model/gltf+json", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", ktx2: "image/ktx2", ogg: "audio/ogg", mp3: "audio/mpeg", wav: "audio/wav", txt: "text/plain", gz: "application/gzip" };

export async function startPreviewServer({ root, trustedPublicKeys = null, host = "127.0.0.1", port = 0 } = {}) {
  if (host !== "127.0.0.1" && host !== "::1" && host !== "localhost") throw new PublishError("preview_host_refused", "the preview server binds loopback only");
  const server = http.createServer((req, res) => {
    const send = (code, body, headers = {}) => { res.writeHead(code, { "content-type": "application/json", "x-content-type-options": "nosniff", "cache-control": "no-store", ...headers }); res.end(body); };
    if (req.method !== "GET" && req.method !== "HEAD") return send(405, JSON.stringify({ error: "method_not_allowed" }));
    const m = /^\/preview\/([A-Za-z0-9_-]{1,128})\/([0-9a-f]{64}|current)\/(.+)$/.exec(new URL(req.url, "http://x").pathname);
    if (!m) return send(404, JSON.stringify({ error: "not_found" }));
    let [, worldId, pkgId, rel] = m;
    try {
      if (pkgId === "current") {
        const f = path.join(root, worldId, "channels", `${CHANNEL}.json`);
        pkgId = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")).current : null;
        if (!pkgId) return send(404, JSON.stringify({ error: "nothing_staged" }));
      }
      const open = openPreview(root, worldId, pkgId, { trustedPublicKeys });
      if (!open.ok) return send(409, JSON.stringify({ error: "package_failed_verification", code: open.code }));
      if (rel === "manifest.json") {
        const bytes = fs.readFileSync(path.join(open.dir, "manifest.json"));
        return send(200, bytes, { "x-dcs-manifest-hash": open.manifest_hash, "x-dcs-package-id": pkgId, "x-dcs-runtime-version": open.runtime.version, etag: `"${sha256Hex(bytes)}"` });
      }
      const listed = new Set([DESCRIPTOR_FILE, ARCHIVE_FILE, SIGNATURE_FILE, ...open.descriptor.files.map((f) => f.path)]);
      if (!listed.has(rel)) return send(404, JSON.stringify({ error: "not_found" }));
      const bytes = fs.readFileSync(path.join(open.dir, ...rel.split("/")));
      const ext = rel.split(".").pop().toLowerCase();
      const assetRow = open.descriptor.assets.find((a) => a.path === rel);
      return send(200, bytes, { "content-type": assetRow?.mime || MIME_BY_EXT[ext] || "application/octet-stream", "x-dcs-package-id": pkgId, etag: `"${sha256Hex(bytes)}"` });
    } catch (e) {
      return send(500, JSON.stringify({ error: "preview_error" }));
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const { port: p } = server.address();
      const base = `http://${host === "::1" ? "[::1]" : host}:${p}/preview`;
      resolve({ base, port: p, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}
