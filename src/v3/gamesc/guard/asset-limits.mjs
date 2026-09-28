// GAMES-C guard — asset bomb limits.
//
// A generated or uploaded asset can be hostile without containing a single line
// of code: a 2 GB GLB, a glTF claiming 400 M triangles, a 32k texture, a gzip
// that inflates 1000:1, a JSON nested 100k deep. Each of those takes down the
// player's tab (or the server that parses it). Everything here is pure except
// safeInflate, which uses node:zlib with a hard output cap.
import zlib from "node:zlib";

export const ASSET_LIMITS = Object.freeze({
  maxAssetBytes: 25 * 1024 * 1024,        // one GLB / texture
  maxTotalBytes: 150 * 1024 * 1024,       // everything a world loads
  maxAssets: 2000,
  maxVerticesPerAsset: 500_000,
  maxTrianglesPerAsset: 1_000_000,
  maxTrianglesTotal: 5_000_000,
  maxTextureDim: 4096,
  maxInstances: 20_000,
  maxInflateBytes: 64 * 1024 * 1024,
  maxInflateRatio: 100,
  maxJsonBytes: 8 * 1024 * 1024,
  maxJsonDepth: 64,
  maxJsonKeys: 200_000,
  maxStringLength: 64 * 1024,
});

const lim = (o) => ({ ...ASSET_LIMITS, ...(o || {}) });

/**
 * Check declared asset metadata (bytes, vertices, triangles, texture dims,
 * instance counts) against limits.
 * @param {Array<{id, bytes?, vertices?, triangles?, polycount?, textures?:[{width,height}], instances?}>} assets
 */
export function checkAssetBudget(assets, opts) {
  const L = lim(opts);
  const findings = [];
  const list = Array.isArray(assets) ? assets : [];
  if (list.length > L.maxAssets) findings.push({ code: "too_many_assets", count: list.length, limit: L.maxAssets });
  let totalBytes = 0, totalTris = 0, totalInst = 0;
  for (const a of list) {
    const id = a?.id ?? "?";
    const bytes = Number(a?.bytes ?? 0), verts = Number(a?.vertices ?? 0);
    const tris = Number(a?.triangles ?? a?.polycount ?? 0), inst = Number(a?.instances ?? 0);
    if (![bytes, verts, tris, inst].every((n) => Number.isFinite(n) && n >= 0)) { findings.push({ code: "bad_number", id }); continue; }
    totalBytes += bytes; totalTris += tris * Math.max(1, inst || 1); totalInst += inst;
    if (bytes > L.maxAssetBytes) findings.push({ code: "asset_too_large", id, bytes, limit: L.maxAssetBytes });
    if (verts > L.maxVerticesPerAsset) findings.push({ code: "too_many_vertices", id, vertices: verts, limit: L.maxVerticesPerAsset });
    if (tris > L.maxTrianglesPerAsset) findings.push({ code: "too_many_triangles", id, triangles: tris, limit: L.maxTrianglesPerAsset });
    for (const t of a?.textures || []) {
      if (Number(t?.width) > L.maxTextureDim || Number(t?.height) > L.maxTextureDim) findings.push({ code: "texture_too_large", id, width: t.width, height: t.height, limit: L.maxTextureDim });
    }
  }
  if (totalBytes > L.maxTotalBytes) findings.push({ code: "total_too_large", bytes: totalBytes, limit: L.maxTotalBytes });
  if (totalTris > L.maxTrianglesTotal) findings.push({ code: "total_triangles", triangles: totalTris, limit: L.maxTrianglesTotal });
  if (totalInst > L.maxInstances) findings.push({ code: "too_many_instances", instances: totalInst, limit: L.maxInstances });
  return { ok: findings.length === 0, findings, totals: { bytes: totalBytes, triangles: totalTris, instances: totalInst } };
}

/**
 * GLB header sanity: magic 'glTF', version 2, declared length == actual,
 * chunk lengths inside the buffer, first chunk JSON, JSON parse under limits,
 * and accessor counts under the vertex cap.
 * @param {Buffer|Uint8Array} buf
 */
export function inspectGlb(buf, opts) {
  const L = lim(opts);
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []);
  const bad = (code, reason) => ({ ok: false, code, reason });
  if (b.length > L.maxAssetBytes) return bad("asset_too_large", `${b.length}B > ${L.maxAssetBytes}B`);
  if (b.length < 20) return bad("truncated", "shorter than GLB header + chunk header");
  if (b.readUInt32LE(0) !== 0x46546c67) return bad("bad_magic", "not a GLB (magic != glTF)");
  const version = b.readUInt32LE(4);
  if (version !== 2) return bad("bad_version", `GLB version ${version}`);
  const declared = b.readUInt32LE(8);
  if (declared !== b.length) return bad("length_mismatch", `declared ${declared}B, actual ${b.length}B`);
  let off = 12, json = null, chunks = 0;
  while (off < b.length) {
    if (off + 8 > b.length) return bad("chunk_header_oob", `chunk header at ${off} past end`);
    const len = b.readUInt32LE(off), type = b.readUInt32LE(off + 4);
    if (len % 4 !== 0) return bad("chunk_unaligned", `chunk length ${len} not 4-aligned`);
    if (off + 8 + len > b.length) return bad("chunk_oob", `chunk at ${off} claims ${len}B, overruns buffer`);
    if (chunks === 0) {
      if (type !== 0x4e4f534a) return bad("first_chunk_not_json", "first chunk must be JSON");
      const parsed = parseJsonSafe(b.subarray(off + 8, off + 8 + len).toString("utf8"), opts);
      if (!parsed.ok) return bad("json_" + parsed.code, parsed.reason);
      json = parsed.value;
    }
    chunks++;
    if (chunks > 16) return bad("too_many_chunks", "more than 16 chunks");
    off += 8 + len;
  }
  const g = checkGltfJson(json, opts);
  if (!g.ok) return { ok: false, code: g.findings[0].code, reason: JSON.stringify(g.findings[0]), findings: g.findings };
  return { ok: true, chunks, stats: g.stats };
}

/** Structural limits on a glTF JSON document (accessor counts, images, buffers). */
export function checkGltfJson(json, opts) {
  const L = lim(opts);
  const findings = [];
  if (!json || typeof json !== "object") return { ok: false, findings: [{ code: "not_object" }], stats: null };
  let vertices = 0, indices = 0;
  for (const mesh of json.meshes || []) {
    for (const p of mesh?.primitives || []) {
      const pos = json.accessors?.[p?.attributes?.POSITION];
      if (pos) vertices += Number(pos.count) || 0;
      const idx = p?.indices !== undefined ? json.accessors?.[p.indices] : null;
      if (idx) indices += Number(idx.count) || 0;
    }
  }
  const triangles = Math.floor(indices / 3) || Math.floor(vertices / 3);
  if (vertices > L.maxVerticesPerAsset) findings.push({ code: "too_many_vertices", vertices, limit: L.maxVerticesPerAsset });
  if (triangles > L.maxTrianglesPerAsset) findings.push({ code: "too_many_triangles", triangles, limit: L.maxTrianglesPerAsset });
  for (const buf of json.buffers || []) {
    if (Number(buf?.byteLength) > L.maxAssetBytes) findings.push({ code: "buffer_too_large", byteLength: buf.byteLength });
    if (typeof buf?.uri === "string" && !buf.uri.startsWith("data:")) findings.push({ code: "external_buffer_uri", uri: buf.uri.slice(0, 80) });
  }
  for (const img of json.images || []) {
    if (typeof img?.uri === "string" && !img.uri.startsWith("data:")) findings.push({ code: "external_image_uri", uri: img.uri.slice(0, 80) });
  }
  if (Array.isArray(json.extensionsUsed) && json.extensionsUsed.some((e) => /script|js|code/i.test(e))) findings.push({ code: "script_extension", ext: json.extensionsUsed });
  return { ok: findings.length === 0, findings, stats: { vertices, triangles, meshes: (json.meshes || []).length } };
}

/** Texture dimensions from a PNG header (IHDR). Returns null for non-PNG. */
export function pngDimensions(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []);
  if (b.length < 24 || b.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

export function checkTexture(buf, opts) {
  const L = lim(opts);
  const d = pngDimensions(buf);
  if (!d) return { ok: false, code: "unknown_format", reason: "only PNG headers are inspected" };
  if (d.width > L.maxTextureDim || d.height > L.maxTextureDim) return { ok: false, code: "texture_too_large", reason: `${d.width}x${d.height} > ${L.maxTextureDim}`, ...d };
  return { ok: true, ...d };
}

/**
 * Inflate gzip/deflate with a hard output cap and a ratio cap. Never returns
 * more than maxInflateBytes; a bomb is refused, not truncated-and-trusted.
 */
export function safeInflate(buf, opts) {
  const L = lim(opts);
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []);
  const cap = Math.min(L.maxInflateBytes, Math.max(1024, b.length * L.maxInflateRatio));
  const isGzip = b[0] === 0x1f && b[1] === 0x8b;
  let out;
  try {
    out = (isGzip ? zlib.gunzipSync : zlib.inflateSync)(b, { maxOutputLength: cap + 1 });
  } catch (e) {
    if (e && (e.code === "ERR_BUFFER_TOO_LARGE" || /maxOutputLength|buffer.*too large|Cannot create a Buffer larger/i.test(String(e.message)))) {
      return { ok: false, code: "decompression_bomb", reason: `inflated output exceeds cap ${cap}B (ratio > ${L.maxInflateRatio}:1 or > ${L.maxInflateBytes}B)` };
    }
    return { ok: false, code: "corrupt", reason: "not valid gzip/deflate" };
  }
  if (out.length > cap) return { ok: false, code: "decompression_bomb", reason: `inflated ${out.length}B > cap ${cap}B` };
  return { ok: true, bytes: out.length, ratio: b.length ? out.length / b.length : 0, data: out };
}

/**
 * Parse JSON under size/depth/key limits. The depth check is done on the text
 * BEFORE JSON.parse so a 1e6-deep array never reaches the parser's recursion.
 */
export function parseJsonSafe(text, opts) {
  const L = lim(opts);
  if (typeof text !== "string") return { ok: false, code: "not_string", reason: "input must be a string" };
  if (Buffer.byteLength(text, "utf8") > L.maxJsonBytes) return { ok: false, code: "too_large", reason: `json exceeds ${L.maxJsonBytes}B` };
  let depth = 0, max = 0, inStr = false, esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === "{" || c === "[") { depth++; if (depth > max) max = depth; if (depth > L.maxJsonDepth) return { ok: false, code: "too_deep", reason: `nesting exceeds ${L.maxJsonDepth}` }; }
    else if (c === "}" || c === "]") depth--;
  }
  let value;
  try { value = JSON.parse(text); } catch { return { ok: false, code: "invalid", reason: "invalid JSON" }; }
  const lv = checkJsonLimits(value, opts);
  if (!lv.ok) return lv;
  return { ok: true, value, depth: max };
}

/** Limits on an already-parsed value (depth, key count, string length). */
export function checkJsonLimits(value, opts) {
  const L = lim(opts);
  let keys = 0;
  const stack = [[value, 1]];
  while (stack.length) {
    const [v, d] = stack.pop();
    if (d > L.maxJsonDepth) return { ok: false, code: "too_deep", reason: `nesting exceeds ${L.maxJsonDepth}` };
    if (typeof v === "string" && v.length > L.maxStringLength) return { ok: false, code: "string_too_long", reason: `string of ${v.length} chars` };
    if (v && typeof v === "object") {
      const entries = Array.isArray(v) ? v : Object.values(v);
      keys += entries.length;
      if (keys > L.maxJsonKeys) return { ok: false, code: "too_many_keys", reason: `more than ${L.maxJsonKeys} keys/elements` };
      for (const x of entries) stack.push([x, d + 1]);
    }
  }
  return { ok: true, keys };
}
