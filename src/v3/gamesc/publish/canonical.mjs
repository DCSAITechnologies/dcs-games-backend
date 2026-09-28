// canonical.mjs — stable JSON + hashing for the GAMES-C publish pipeline.
//
// canonicalJSON produces the same bytes as the patch lane's canonicalJSON for
// any JSON-valid value (sorted keys, no whitespace); it is stricter (throws on
// non-finite numbers instead of writing null). A test pins the agreement.
//
// hashManifestExact is NOT the patch lane's hashManifest: that one strips the
// volatile fields (world_version, meta.updated_at, provenance.manifest_hash) to
// give a CONTENT hash for edit lineage. A package must bind every byte it
// ships, so the package's manifest_hash covers the whole canonical manifest;
// the patch-lane content hash is recorded alongside as manifest_content_hash.
import crypto from "node:crypto";

export function canonicalJSON(value) {
  return JSON.stringify(normalise(value, new Set()));
}

function normalise(v, seen) {
  if (v === null) return null;
  const t = typeof v;
  if (t === "number") {
    if (!Number.isFinite(v)) throw new TypeError("canonicalJSON: non-finite number");
    return v;
  }
  if (t === "string" || t === "boolean") return v;
  if (t === "undefined" || t === "function" || t === "symbol") return undefined;
  if (t === "bigint") throw new TypeError("canonicalJSON: bigint is not JSON");
  if (seen.has(v)) throw new TypeError("canonicalJSON: cycle");
  seen.add(v);
  let out;
  if (Array.isArray(v)) {
    out = v.map((x) => { const n = normalise(x, seen); return n === undefined ? null : n; });
  } else {
    out = {};
    for (const k of Object.keys(v).sort()) {
      const n = normalise(v[k], seen);
      if (n !== undefined) out[k] = n;
    }
  }
  seen.delete(v);
  return out;
}

export function sha256Hex(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

export function hashManifestExact(manifest) {
  return "sha256:" + sha256Hex(Buffer.from(canonicalJSON(manifest), "utf8"));
}
