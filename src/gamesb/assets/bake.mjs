// Games-B asset baking. NODE-ONLY (fs, zlib via png.mjs).
//
// Turns recipe-backed records into files a package can ship: texture recipes
// → PNG (one file per channel record), SVG payloads → .svg, generated images →
// their provider bytes. Each baked record gets `uri`, `bytes` and `sha256` of
// the FILE (§4.1: "sha256 of canonical payload or of file bytes"), and keeps
// its payload, so a runtime that prefers to synthesize can still do so.
// `asset_id` does not change: it addresses the content recipe, and the file is
// a deterministic rendering of it.

import fs from "node:fs";
import path from "node:path";
import { sha256, canonicalJson } from "../common/hash.mjs";
import { synthesizeTexture } from "./texture-synth.mjs";
import { encodePng } from "./png.mjs";

function writeFile(outDir, rel, buf) {
  const file = path.join(outDir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, file);
  return file;
}

/**
 * @param {{ records: object[], outDir: string, blobs?: {sha: Buffer}, cache?: object }} o
 * @returns {{ records: object[], files: [{ asset_id, ref, uri, path, bytes, sha256 }] }}
 */
export async function bake({ records, outDir, blobs = {}, cache = null }) {
  if (!outDir) throw new TypeError("bake: outDir is required");
  const synthMemo = new Map();          // one synthesis serves albedo + normal + roughness
  const files = [];
  const baked = records.map((rec) => {
    let buf = null, rel = null, extra = {};
    if (rec.format === "texture-recipe" && rec.payload?.generator) {
      const { channel = "albedo", ...base } = rec.payload;
      const k = canonicalJson(base);
      if (!synthMemo.has(k)) synthMemo.set(k, synthesizeTexture(base));
      const t = synthMemo.get(k);
      buf = encodePng({ width: t.width, height: t.height, data: t[channel] || t.albedo });
      rel = `textures/${rec.asset_id}.png`;
      extra = { format: "png", dimensions: { px_w: t.width, px_h: t.height } };
    } else if (rec.format === "png" && rec.payload?.image?.sha256) {
      const sha = rec.payload.image.sha256;
      buf = blobs[sha] || cache?.getBlob?.(sha) || null;
      if (!buf) return { ...rec, uri: null, bake_error: "provider image bytes unavailable (not in blobs or cache)" };
      rel = rec.uri || `textures/${rec.asset_id}.png`;
    } else if (rec.format === "svg" && typeof rec.payload?.svg === "string") {
      buf = Buffer.from(rec.payload.svg, "utf8");
      rel = `svg/${rec.asset_id}.svg`;
    } else {
      return rec;
    }
    const file = writeFile(outDir, rel, buf);
    const digest = sha256(buf);
    files.push({ asset_id: rec.asset_id, ref: rec.ref, uri: rel, path: file, bytes: buf.length, sha256: digest });
    return { ...rec, ...extra, uri: rel, bytes: buf.length, sha256: digest };
  });
  return { records: baked, files };
}
