// GAMES-C memory — hashing primitives for the version chain.
//
// Manifest hashes come from the INJECTED hashManifest (the patch module owns the
// canonical manifest hash, "sha256:<hex>"). Everything else in this module —
// version-chain hashes, record digests, patch digests, asset content hashes —
// is computed here, with one canonical JSON form, so the chain is reproducible
// across processes regardless of which patch implementation is plugged in.
import crypto from "node:crypto";

/** Stable JSON: sorted object keys, undefined dropped, arrays in order. */
export function canonicalJSON(v) {
  if (v === undefined) return "null";
  if (v === null || typeof v !== "object") {
    if (typeof v === "number" && !Number.isFinite(v)) return "null";
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) return "[" + v.map((x) => (x === undefined ? "null" : canonicalJSON(x))).join(",") + "]";
  const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJSON(v[k])).join(",") + "}";
}

export function sha256(str) {
  return "sha256:" + crypto.createHash("sha256").update(String(str)).digest("hex");
}

/** Hash of any JSON value, in canonical form. */
export const hashValue = (v) => sha256(canonicalJSON(v));

/**
 * Fields that change on every write without changing CONTENT. Mirrors the patch
 * module's VOLATILE_PATHS so the fallback hash agrees with the real one: a
 * restore re-stamps world_version and still hashes equal to the old content.
 */
export const VOLATILE_PATHS = Object.freeze(["world_version", "meta.updated_at", "provenance.manifest_hash"]);
const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** Fallback manifest hash, same "sha256:<hex>" shape and volatile rule as the patch contract. */
export function defaultHashManifest(manifest) {
  if (!isPlain(manifest)) return hashValue(manifest ?? null);
  const m = { ...manifest };
  delete m.world_version;
  if (isPlain(m.meta)) { m.meta = { ...m.meta }; delete m.meta.updated_at; }
  if (isPlain(m.provenance)) { m.provenance = { ...m.provenance }; delete m.provenance.manifest_hash; }
  return hashValue(m);
}

/**
 * THE chain rule. A version's hash commits to its parent's hash, its content
 * hash, and the ordered patch ids that produced it:
 *     version_hash = H(canonicalJSON([parent_hash, manifest_hash, patch_ids]))
 * Changing any ancestor, any content, or the patch list changes every
 * descendant hash, which is what makes tampering detectable.
 */
export function versionHash(parentHash, manifestHash, patchIds) {
  return hashValue([parentHash ?? null, String(manifestHash), (patchIds || []).map(String)]);
}

/** Digest over a whole record minus its own digest field — covers metadata the chain does not. */
export function recordDigest(record, field = "record_hash") {
  const { [field]: _omit, ...rest } = record;
  return hashValue(rest);
}

/** "sha256:abc" -> "abc" (for keys; bare hex is also what worldstore.manifestHash emits). */
export const hexOf = (h) => String(h).replace(/^sha256:/, "");

/** Byte length of a JSON value as it would be stored. */
export const jsonBytes = (v) => Buffer.byteLength(JSON.stringify(v ?? null), "utf8");
