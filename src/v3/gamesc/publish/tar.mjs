// tar.mjs — a minimal DETERMINISTIC ustar writer/reader (regular files only).
//
// Every header field that could vary between machines or runs is pinned:
// mode 0644, uid/gid 0, mtime 0, empty uname/gname, entries sorted by path.
// Gzip is applied by the caller with zlib (Node writes mtime 0 in the gzip
// header), so identical input produces byte-identical archives.

const BLOCK = 512;

function octal(n, width) {
  // width includes the trailing NUL
  const s = n.toString(8);
  if (s.length > width - 1) throw new RangeError(`tar: value ${n} does not fit in ${width} bytes`);
  return s.padStart(width - 1, "0") + "\0";
}

export function safeEntryPath(p) {
  if (typeof p !== "string" || !p.length) return false;
  if (p.startsWith("/") || p.includes("\\") || p.includes("\0")) return false;
  const parts = p.split("/");
  if (parts.some((s) => s === "" || s === "." || s === "..")) return false;
  if (Buffer.byteLength(p, "utf8") > 100) return false; // no prefix-field support, by design
  return /^[A-Za-z0-9._\-/]+$/.test(p);
}

function header(name, size) {
  const h = Buffer.alloc(BLOCK, 0);
  h.write(name, 0, 100, "utf8");
  h.write(octal(0o644, 8), 100, 8, "ascii");
  h.write(octal(0, 8), 108, 8, "ascii");
  h.write(octal(0, 8), 116, 8, "ascii");
  h.write(octal(size, 12), 124, 12, "ascii");
  h.write(octal(0, 12), 136, 12, "ascii");
  h.write("        ", 148, 8, "ascii"); // checksum placeholder (spaces)
  h.write("0", 156, 1, "ascii");
  h.write("ustar\0", 257, 6, "ascii");
  h.write("00", 263, 2, "ascii");
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += h[i];
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
  return h;
}

/** entries: Array<{path, bytes:Buffer}> -> Buffer (uncompressed tar) */
export function writeTar(entries) {
  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const chunks = [];
  const seen = new Set();
  for (const e of sorted) {
    if (!safeEntryPath(e.path)) throw new Error(`tar: unsafe entry path '${e.path}'`);
    if (seen.has(e.path)) throw new Error(`tar: duplicate entry '${e.path}'`);
    seen.add(e.path);
    const bytes = Buffer.isBuffer(e.bytes) ? e.bytes : Buffer.from(e.bytes);
    chunks.push(header(e.path, bytes.length), bytes);
    const pad = (BLOCK - (bytes.length % BLOCK)) % BLOCK;
    if (pad) chunks.push(Buffer.alloc(pad, 0));
  }
  chunks.push(Buffer.alloc(BLOCK * 2, 0));
  return Buffer.concat(chunks);
}

/** Buffer -> Map<path, Buffer>. Throws on anything that is not a plain, safe, checksummed file. */
export function readTar(buf) {
  const out = new Map();
  let off = 0;
  while (off + BLOCK <= buf.length) {
    const h = buf.subarray(off, off + BLOCK);
    if (h.every((b) => b === 0)) return out;
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : h[i];
    const declared = parseInt(h.subarray(148, 156).toString("ascii").replace(/[\0 ]/g, ""), 8);
    if (declared !== sum) throw new Error("tar: header checksum mismatch");
    const name = h.subarray(0, 100).toString("utf8").replace(/\0.*$/s, "");
    const type = String.fromCharCode(h[156]);
    if (type !== "0") throw new Error(`tar: entry '${name}' is not a regular file`);
    if (!safeEntryPath(name)) throw new Error(`tar: unsafe entry path '${name}'`);
    if (out.has(name)) throw new Error(`tar: duplicate entry '${name}'`);
    const size = parseInt(h.subarray(124, 136).toString("ascii").replace(/\0.*$/s, ""), 8);
    off += BLOCK;
    if (off + size > buf.length) throw new Error("tar: truncated");
    out.set(name, Buffer.from(buf.subarray(off, off + size)));
    off += size + ((BLOCK - (size % BLOCK)) % BLOCK);
  }
  throw new Error("tar: missing end-of-archive marker");
}
