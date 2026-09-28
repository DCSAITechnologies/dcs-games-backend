// Games-B PNG encoder. NODE-ONLY (node:zlib).
//
// Hand-written rather than pulled from npm because the repo is zero-dependency
// and the format we need is tiny: 8-bit RGBA, one IDAT, per-row adaptive
// filtering (the "minimum sum of absolute differences" heuristic from the PNG
// spec), which roughly halves file size on noise textures versus filter 0.

import { deflateSync } from "node:zlib";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf, crc = 0xffffffff) {
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

const paeth = (a, b, c) => {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

/**
 * Encode RGBA pixels to a PNG buffer.
 * @param {{width:number, height:number, data:Uint8Array|Uint8ClampedArray}} img
 */
export function encodePng({ width, height, data }, { level = 6 } = {}) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw new Error("encodePng: bad dimensions");
  if (!data || data.length !== width * height * 4) throw new Error(`encodePng: expected ${width * height * 4} RGBA bytes, got ${data?.length}`);
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  const cand = [0, 1, 2, 3, 4].map(() => Buffer.alloc(stride));
  for (let y = 0; y < height; y++) {
    const row = y * stride, prev = (y - 1) * stride;
    let best = 0, bestSum = Infinity;
    for (let f = 0; f < 5; f++) {
      const out = cand[f];
      let sum = 0;
      for (let i = 0; i < stride; i++) {
        const x = data[row + i];
        const a = i >= 4 ? data[row + i - 4] : 0;
        const b = y > 0 ? data[prev + i] : 0;
        const c = i >= 4 && y > 0 ? data[prev + i - 4] : 0;
        const v = f === 0 ? x : f === 1 ? x - a : f === 2 ? x - b : f === 3 ? x - ((a + b) >> 1) : x - paeth(a, b, c);
        const byte = v & 0xff;
        out[i] = byte;
        sum += byte < 128 ? byte : 256 - byte;
        if (sum >= bestSum) break;
      }
      if (sum < bestSum) { bestSum = sum; best = f; }
    }
    // Only a losing filter can stop early, so the winner's row buffer is complete.
    const o = y * (stride + 1);
    raw[o] = best;
    cand[best].copy(raw, o + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;   // 8-bit RGBA, deflate, adaptive, no interlace
  return Buffer.concat([SIGNATURE, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level })), chunk("IEND", Buffer.alloc(0))]);
}

/**
 * Parse the signature and IHDR of a PNG and verify every chunk CRC.
 * Returns { width, height, bit_depth, color_type, chunks:[type], crc_ok } or throws.
 */
export function decodePngHeader(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  if (buf.length < 33 || !buf.subarray(0, 8).equals(SIGNATURE)) throw new Error("not a PNG (bad signature)");
  const chunks = [];
  let off = 8, crcOk = true, ihdr = null;
  while (off + 12 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    const end = off + 12 + len;
    if (end > buf.length) throw new Error(`truncated chunk ${type}`);
    const want = buf.readUInt32BE(off + 8 + len);
    if (crc32(buf.subarray(off + 4, off + 8 + len)) !== want) crcOk = false;
    if (type === "IHDR") ihdr = buf.subarray(off + 8, off + 8 + len);
    chunks.push(type);
    off = end;
    if (type === "IEND") break;
  }
  if (!ihdr || chunks[0] !== "IHDR") throw new Error("PNG has no leading IHDR");
  return { width: ihdr.readUInt32BE(0), height: ihdr.readUInt32BE(4), bit_depth: ihdr[8], color_type: ihdr[9], chunks, crc_ok: crcOk };
}

/** Concatenated IDAT payload (still deflated) — for tests and inspection. */
export function extractIdat(buf) {
  const parts = [];
  let off = 8;
  while (off + 12 <= buf.length) {
    const len = buf.readUInt32BE(off), type = buf.toString("ascii", off + 4, off + 8);
    if (type === "IDAT") parts.push(buf.subarray(off + 8, off + 8 + len));
    off += 12 + len;
    if (type === "IEND") break;
  }
  return Buffer.concat(parts);
}
