// Games-B content-addressed asset cache. NODE-ONLY.
//
// Layout under the cache dir:
//   records/<key>.json   one AssetRecord per request key (atomic write)
//   blobs/<sha256>.bin   provider bytes (generated PNGs), addressed by content
//   index.json           advisory summary + per-ref version history
//
// The record files are the source of truth; index.json is a convenience that
// can be deleted at any time (it is rebuilt from what `put` sees). Every write
// goes to a temp file in the same directory and is renamed into place, so a
// crash mid-write leaves either the old file or the new one — never half.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

export const DEFAULT_CACHE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../.cache/gamesb-assets");

const KEY_RE = /^[A-Za-z0-9_-]{8,128}$/;
const SHA_RE = /^[0-9a-f]{64}$/;

function atomicWrite(file, data) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

export function createAssetCache(dir = DEFAULT_CACHE_DIR) {
  const recDir = path.join(dir, "records"), blobDir = path.join(dir, "blobs"), indexFile = path.join(dir, "index.json");
  fs.mkdirSync(recDir, { recursive: true });
  fs.mkdirSync(blobDir, { recursive: true });

  let index;
  try { index = JSON.parse(fs.readFileSync(indexFile, "utf8")); } catch { index = null; }
  if (!index || index.version !== 1 || typeof index.entries !== "object") index = { version: 1, entries: {}, refs: {} };
  index.refs ||= {};
  let dirty = false;
  const counters = { hits: 0, misses: 0, puts: 0 };

  const recFile = (key) => {
    if (!KEY_RE.test(String(key))) throw new Error(`asset cache: invalid key '${String(key).slice(0, 40)}'`);
    return path.join(recDir, `${key}.json`);
  };

  const cache = {
    dir,
    has(key) { return fs.existsSync(recFile(key)); },

    /** The stored record, or null. Counts a hit or a miss. */
    get(key) {
      const file = recFile(key);           // a bad key throws: it is a caller bug, not a miss
      let rec = null;
      try { rec = JSON.parse(fs.readFileSync(file, "utf8")); } catch { rec = null; }
      if (rec) counters.hits++; else counters.misses++;
      return rec;
    },

    put(key, record) {
      const body = JSON.stringify(record);
      atomicWrite(recFile(key), body);
      index.entries[key] = { asset_id: record.asset_id, ref: record.ref, kind: record.kind, bytes: Buffer.byteLength(body), stored_at: new Date().toISOString() };
      counters.puts++;
      dirty = true;
      return key;
    },

    /** Store raw bytes by their sha256; returns the hash. */
    putBlob(buf) {
      const sha = crypto.createHash("sha256").update(buf).digest("hex");
      const f = path.join(blobDir, `${sha}.bin`);
      if (!fs.existsSync(f)) atomicWrite(f, buf);
      return sha;
    },
    getBlob(sha) {
      if (!SHA_RE.test(String(sha))) return null;
      try { return fs.readFileSync(path.join(blobDir, `${sha}.bin`)); } catch { return null; }
    },

    /**
     * 1-based version of `assetId` under logical `ref`: the first content ever
     * seen for a ref is v1, the next distinct content v2, and so on. This is
     * what AssetRecord.version means ("bumps when the payload changes under
     * the same logical name").
     */
    versionFor(ref, assetId) {
      const hist = (index.refs[ref] ||= []);
      let i = hist.indexOf(assetId);
      if (i < 0) { hist.push(assetId); i = hist.length - 1; dirty = true; }
      return i + 1;
    },

    flush() {
      if (!dirty) return;
      atomicWrite(indexFile, JSON.stringify(index));
      dirty = false;
    },

    stats() {
      let entries = 0, bytes = 0, blobs = 0, blobBytes = 0;
      for (const f of fs.readdirSync(recDir)) if (f.endsWith(".json")) { entries++; bytes += fs.statSync(path.join(recDir, f)).size; }
      for (const f of fs.readdirSync(blobDir)) if (f.endsWith(".bin")) { blobs++; blobBytes += fs.statSync(path.join(blobDir, f)).size; }
      return { dir, entries, bytes, blobs, blob_bytes: blobBytes, hits: counters.hits, misses: counters.misses, puts: counters.puts };
    },
  };
  return cache;
}
