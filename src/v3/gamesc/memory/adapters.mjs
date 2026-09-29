// GAMES-C memory — pluggable storage adapters.
//
// The facade (index.mjs) talks to storage ONLY through this interface, so the
// same code runs over an in-memory map (tests), a directory of JSON files
// (local/staging), and — proposed, not built — Supabase/PostgREST (see
// docs/games-c/DCS_GAMES_WORLD_MEMORY_SPEC.md for the table mapping).
//
// Interface (all async):
//   get(worldId, ns, key)                    -> value | null
//   put(worldId, ns, key, value, {ifAbsent}) -> {ok:true} | {ok:false, exists:true}
//        ifAbsent is an ATOMIC create: exactly one of two racing writers wins.
//        That primitive is what makes version numbers safe across processes.
//   del(worldId, ns, key)                    -> void   (used only for bounded docs, never versions)
//   keys(worldId, ns)                        -> string[]
//   append(worldId, ns, entry, {max})        -> entry with a monotonic `seq`
//        keeps at most `max` newest entries (bounded history); seq never resets.
//   tail(worldId, ns, limit)                 -> newest `limit` entries, oldest first
//   worlds()                                 -> world ids with any data
//
// Values are JSON; adapters deep-copy on the way in and out so callers can never
// mutate stored state by reference.
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createKeyedMutex } from "../../../core/mutex.mjs";

const SAFE_ID = /^[A-Za-z0-9._:@-]{1,200}$/;
const SAFE_NS = /^[a-z][a-z0-9_:-]{0,40}$/;
function assertId(kind, v) {
  if (!SAFE_ID.test(String(v))) throw new Error(`memory adapter: unsafe ${kind}: ${String(v).slice(0, 60)}`);
}
const clone = (v) => (v === undefined || v === null ? null : JSON.parse(JSON.stringify(v)));

/** In-process adapter. Fast, lossless within a process, gone on restart. */
export function createMemoryAdapter() {
  const docs = new Map();     // `${w}\0${ns}\0${key}` -> json string
  const logs = new Map();     // `${w}\0${ns}` -> {seq, entries:[json string]}
  const k3 = (w, ns, key) => `${w}\0${ns}\0${key}`;
  return {
    kind: "memory",
    async get(w, ns, key) {
      assertId("world id", w); const s = docs.get(k3(w, ns, key));
      return s === undefined ? null : JSON.parse(s);
    },
    async put(w, ns, key, value, { ifAbsent = false } = {}) {
      assertId("world id", w); assertId("key", key);
      if (!SAFE_NS.test(ns)) throw new Error(`memory adapter: unsafe ns ${ns}`);
      const k = k3(w, ns, key);
      if (ifAbsent && docs.has(k)) return { ok: false, exists: true };
      docs.set(k, JSON.stringify(value));
      return { ok: true };
    },
    async del(w, ns, key) { docs.delete(k3(w, ns, key)); },
    async keys(w, ns) {
      const pre = `${w}\0${ns}\0`;
      return [...docs.keys()].filter((k) => k.startsWith(pre)).map((k) => k.slice(pre.length));
    },
    async append(w, ns, entry, { max = Infinity } = {}) {
      assertId("world id", w);
      const k = `${w}\0${ns}`;
      const log = logs.get(k) || { seq: 0, entries: [] };
      const row = { ...clone(entry), seq: ++log.seq };
      log.entries.push(JSON.stringify(row));
      if (log.entries.length > max) log.entries.splice(0, log.entries.length - max);
      logs.set(k, log);
      return clone(row);
    },
    async tail(w, ns, limit = Infinity) {
      const log = logs.get(`${w}\0${ns}`);
      if (!log) return [];
      const n = Number.isFinite(limit) ? Math.max(0, limit) : log.entries.length;
      return log.entries.slice(Math.max(0, log.entries.length - n)).map((s) => JSON.parse(s));
    },
    async worlds() {
      const out = new Set();
      for (const k of docs.keys()) out.add(k.split("\0")[0]);
      for (const k of logs.keys()) out.add(k.split("\0")[0]);
      return [...out];
    },
    /** Test hook: raw access for tamper tests. Not part of the interface. */
    _raw: { docs, logs, k3 },
  };
}

/**
 * Directory-of-JSON adapter. Layout:
 *   <dir>/<world>/<ns>/<key>.json      one document
 *   <dir>/<world>/_logs/<ns>.json      {seq, entries[]} bounded log
 * Writes are tmp+rename (atomic replace). ifAbsent creates use link(2), which
 * fails with EEXIST if the target exists — atomic across processes on one host.
 * Log appends are serialised per (world, ns) within one process only; two
 * processes appending to the same log can still lose an entry (stated, PARTIAL).
 */
export function createFsAdapter(dir) {
  if (!dir) throw new Error("fs adapter needs a directory");
  fs.mkdirSync(dir, { recursive: true });
  const lock = createKeyedMutex();
  const enc = (s) => encodeURIComponent(String(s));
  const docPath = (w, ns, key) => {
    assertId("world id", w); assertId("key", key);
    if (!SAFE_NS.test(ns)) throw new Error(`fs adapter: unsafe ns ${ns}`);
    return path.join(dir, enc(w), ns.replace(/:/g, "_"), enc(key) + ".json");
  };
  const logPath = (w, ns) => {
    assertId("world id", w);
    if (!SAFE_NS.test(ns)) throw new Error(`fs adapter: unsafe ns ${ns}`);
    return path.join(dir, enc(w), "_logs", ns.replace(/:/g, "_") + ".json");
  };
  const tmpOf = (p) => p + ".tmp-" + process.pid + "-" + crypto.randomBytes(4).toString("hex");
  async function readJson(p) {
    try { return JSON.parse(await fsp.readFile(p, "utf8")); }
    catch (e) { if (e.code === "ENOENT") return null; throw e; }
  }
  async function writeAtomic(p, value) {
    await fsp.mkdir(path.dirname(p), { recursive: true });
    const tmp = tmpOf(p);
    await fsp.writeFile(tmp, JSON.stringify(value));
    await fsp.rename(tmp, p);
  }
  return {
    kind: "fs",
    dir,
    async get(w, ns, key) { return await readJson(docPath(w, ns, key)); },
    async put(w, ns, key, value, { ifAbsent = false } = {}) {
      const p = docPath(w, ns, key);
      if (!ifAbsent) { await writeAtomic(p, value); return { ok: true }; }
      await fsp.mkdir(path.dirname(p), { recursive: true });
      const tmp = tmpOf(p);
      await fsp.writeFile(tmp, JSON.stringify(value));
      try { await fsp.link(tmp, p); return { ok: true }; }
      catch (e) { if (e.code === "EEXIST") return { ok: false, exists: true }; throw e; }
      finally { await fsp.unlink(tmp).catch(() => {}); }
    },
    async del(w, ns, key) { await fsp.unlink(docPath(w, ns, key)).catch((e) => { if (e.code !== "ENOENT") throw e; }); },
    async keys(w, ns) {
      assertId("world id", w);
      const d = path.join(dir, enc(w), ns.replace(/:/g, "_"));
      const names = await fsp.readdir(d).catch(() => []);
      return names.filter((n) => n.endsWith(".json") && !n.includes(".tmp-")).map((n) => decodeURIComponent(n.slice(0, -5)));
    },
    async append(w, ns, entry, { max = Infinity } = {}) {
      const p = logPath(w, ns);
      return await lock(p, async () => {
        const log = (await readJson(p)) || { seq: 0, entries: [] };
        const row = { ...clone(entry), seq: ++log.seq };
        log.entries.push(row);
        if (log.entries.length > max) log.entries.splice(0, log.entries.length - max);
        await writeAtomic(p, log);
        return clone(row);
      });
    },
    async tail(w, ns, limit = Infinity) {
      const log = await readJson(logPath(w, ns));
      if (!log) return [];
      const n = Number.isFinite(limit) ? Math.max(0, limit) : log.entries.length;
      return log.entries.slice(Math.max(0, log.entries.length - n));
    },
    async worlds() {
      const names = await fsp.readdir(dir).catch(() => []);
      return names.filter((n) => !n.startsWith(".")).map(decodeURIComponent);
    },
    _paths: { docPath, logPath },
  };
}
