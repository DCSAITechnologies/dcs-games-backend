// GAMES-C guard — remote asset substitution (content-hash pinning).
//
// A URL names a location, not content. If the bytes behind an allowlisted URL
// change after review (CDN compromise, a provider re-using an id, a bucket
// overwrite), the world silently changes too. The rule: every REMOTE asset in a
// manifest carries `sha256` (hex, or "sha256:<hex>"), recorded when it was
// reviewed; the loader verifies the fetched bytes against it; an unpinned
// remote asset is refused. Primitive/instanced assets have no remote bytes and
// are exempt. data: urls are self-describing and exempt.
import crypto from "node:crypto";

export function sha256Hex(bytes) {
  return crypto.createHash("sha256").update(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)).digest("hex");
}

const HEX64 = /^[0-9a-f]{64}$/;
export function normalizePin(pin) {
  if (typeof pin !== "string") return null;
  const h = pin.toLowerCase().replace(/^sha256[:-]/, "");
  return HEX64.test(h) ? h : null;
}

const pinOf = (a) => normalizePin(a?.sha256 ?? a?.content_hash ?? a?.integrity?.sha256);
const isRemote = (a) => typeof a?.uri === "string" && /^https?:/i.test(a.uri);

/** Every remote asset must be pinned. */
export function checkPinnedAssets(manifest) {
  const findings = [];
  for (const a of manifest?.assets || []) {
    if (!isRemote(a)) continue;
    const raw = a.sha256 ?? a.content_hash ?? a.integrity?.sha256;
    if (raw === undefined) findings.push({ id: a.id, code: "unpinned_remote_asset", uri: a.uri });
    else if (!pinOf(a)) findings.push({ id: a.id, code: "malformed_pin", uri: a.uri });
  }
  return { ok: findings.length === 0, findings };
}

/** Verify fetched bytes against the asset's recorded pin. */
export function verifyAssetBytes(asset, bytes) {
  const pin = pinOf(asset);
  if (!pin) return { ok: false, code: "unpinned_remote_asset", reason: `asset '${asset?.id}' has no sha256 pin` };
  const got = sha256Hex(bytes);
  if (!crypto.timingSafeEqual(Buffer.from(got, "hex"), Buffer.from(pin, "hex"))) {
    return { ok: false, code: "hash_mismatch", reason: `asset '${asset?.id}' content changed`, expected: pin, actual: got };
  }
  return { ok: true, sha256: got };
}

/** Pin an asset (reviewer path). Returns a copy with sha256 set. */
export function pinAsset(asset, bytes) {
  return { ...asset, sha256: sha256Hex(bytes) };
}

/**
 * A replace_asset patch op may not swap a pinned asset for an unpinned remote,
 * nor keep the same uri with a different hash without a reviewer pin.
 */
export function checkAssetReplacement(before, after) {
  if (!isRemote(after)) return { ok: true };
  if (!pinOf(after)) return { ok: false, code: "unpinned_remote_asset", reason: "replacement remote asset must carry sha256" };
  if (before && before.uri === after.uri && pinOf(before) && pinOf(before) !== pinOf(after)) {
    return { ok: true, note: "same uri, new pin — content changed under review" };
  }
  return { ok: true };
}
