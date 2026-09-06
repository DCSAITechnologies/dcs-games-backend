// A3 — durable world persistence. PARENT-OWNED.
//
// Round-2: manifests lived in a process-local Map and the Supabase write sat
// inside a bare try{}catch{} that discarded the error, so a failed write looked
// identical to a successful one and a restart silently lost the world.
//
// This store is lossless (the whole manifest round-trips byte-for-byte),
// idempotent on world_id, ownership-aware, and never swallows a write failure.
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { AppError, Errors, optional } from "./errors.mjs";
import { createKeyedMutex } from "./mutex.mjs";

/** Serialises writes to one world; different worlds never wait on each other. */
const withLock = createKeyedMutex();

export function canonicalize(v) {
  // Stable key order so a manifest hash is reproducible across processes.
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return "[" + v.map(canonicalize).join(",") + "]";
  const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalize(v[k])).join(",") + "}";
}
export function manifestHash(manifest) {
  return crypto.createHash("sha256").update(canonicalize(manifest)).digest("hex");
}

/** The one suffix a listing sidecar is allowed to occupy. */
const SIDECAR_SUFFIX = ".summary.json";
/** How much of a record file is read to recover its scalar head. */
const HEAD_BYTES = 8192;

/**
 * Durable JSON-on-disk store. Atomic writes (tmp + rename) survive a kill mid-write.
 *
 * TWO NAMESPACES, ONE DIRECTORY. A world id may legally contain a dot, and the
 * listing cache lives at `<id>.summary.json` beside the record at `<id>.json`.
 * Those namespaces used to overlap: the RECORD of world `x.summary` and the
 * SIDECAR of world `x` were the same path. Saving `x` overwrote the record of
 * `x.summary` — whose creator was told `ok`, and then got a 403 on their own
 * world, because the row on disk now carried somebody else's owner_id. That is
 * silent data destruction plus an id takeover, from a legal id.
 *
 * _name() therefore escapes a trailing `.summary` to `%2Esummary`, so no record
 * file name can end in `.summary.json` and the two namespaces are disjoint by
 * construction:
 *   records  = name + ".json"          where name never ends in ".summary"
 *   sidecars = name + ".summary.json"
 * `%` is not a legal id character, so the escape cannot be spelled by an id and
 * the id -> name mapping stays one-to-one. Ids written by an earlier build are
 * still read from — and migrated out of — their old location; see _legacyP().
 */
export class FileWorldStore {
  constructor(dir) {
    this.dir = dir || process.env.DCS_DATA_DIR || path.join(process.cwd(), ".dcs-data", "worlds");
    fs.mkdirSync(this.dir, { recursive: true });
    this.kind = "file";
  }
  /** The on-disk stem for an id: validated, encoded, and out of the sidecar namespace. */
  _name(id) {
    if (!/^[A-Za-z0-9._:-]{1,200}$/.test(String(id))) throw Errors.validation(`unsafe world id: ${id}`);
    const enc = encodeURIComponent(String(id));
    return enc.endsWith(".summary") ? enc.slice(0, -".summary".length) + "%2Esummary" : enc;
  }
  _p(id) { return path.join(this.dir, this._name(id) + ".json"); }
  _sp(id) { return path.join(this.dir, this._name(id) + SIDECAR_SUFFIX); }
  /**
   * Where a pre-fix build would have put this world's record — which is only a
   * different path for the ids that used to collide, i.e. those ending in
   * `.summary`. Every other id keeps the exact path it has always had, so no
   * world already on disk moves or disappears.
   */
  _legacyP(id) {
    this._name(id);                                      // validates the id, and only the id
    const enc = encodeURIComponent(String(id));
    return enc.endsWith(".summary") ? path.join(this.dir, enc + ".json") : null;
  }

  /**
   * The fields a LISTING needs, and nothing else.
   *
   * A world record holds its entire manifest, which is the largest thing this
   * system stores. list() parsed every one of them to build discovery cards
   * that use nine fields — so a 200-world catalogue parsed 200 full manifests
   * to return 24 cards. Measured: /v3/discover p50 6ms at 1 world, 908ms at 200.
   * The cliff was catalogue size, not traffic.
   */
  static summarise(record) {
    return {
      world_id: record.world_id,
      owner_id: record.owner_id,
      title: record.title,
      state: record.state,
      version: record.version,
      manifest_hash: record.manifest_hash,
      manifest_version: record.manifest_version,
      created_at: record.created_at,
      updated_at: record.updated_at,
      manifest: { meta: record.manifest?.meta ?? null, media: record.manifest?.media ?? null },
      _summary: true,
    };
  }

  /**
   * The record's bytes, with the manifest LAST.
   *
   * Everything except the manifest is a scalar, so this puts the whole of a
   * record's head — including its manifest_hash — in the first few hundred
   * bytes of the file, where _head() can read it without parsing the manifest.
   * That is what makes the sidecar checkable at a cost the sidecar was built to
   * avoid paying. The key ORDER of a JSON object carries no meaning to any
   * reader, so nothing downstream can tell.
   */
  static serialise(record) {
    const { manifest, ...head } = record;
    return JSON.stringify({ ...head, manifest });
  }

  /** tmp + rename: a reader sees either the old file or the new one, never half of one. */
  async _atomicWrite(p, data) {
    const tmp = p + ".tmp-" + crypto.randomBytes(4).toString("hex");
    await fsp.writeFile(tmp, data);
    await fsp.rename(tmp, p);          // atomic on POSIX
  }

  /**
   * The scalar head of a record file, read WITHOUT parsing its manifest.
   *
   * serialise() writes the manifest last, so the text is
   *   {"world_id":...,"manifest_hash":...,"updated_at":...,"manifest":{ ... }}
   * and everything before `,"manifest":` is a complete object once closed. That
   * marker cannot occur inside a JSON string, because JSON.stringify escapes
   * every `"` inside a string as `\"` — so an unescaped `,"` is always a key
   * boundary. Anything unexpected (an old byte order, a title long enough to
   * push the marker past HEAD_BYTES, a truncated file) returns null, and the
   * caller falls back to reading the whole record. Null is never an answer,
   * only a slower path.
   */
  async _head(p) {
    let fh = null;
    try {
      fh = await fsp.open(p, "r");
      const buf = Buffer.alloc(HEAD_BYTES);
      const { bytesRead } = await fh.read(buf, 0, HEAD_BYTES, 0);
      const text = buf.subarray(0, bytesRead).toString("utf8");
      const cut = text.indexOf(',"manifest":');
      if (cut < 0) return null;
      return JSON.parse(text.slice(0, cut) + "}");
    } catch { return null; }
    finally { if (fh) await fh.close().catch(() => {}); }
  }

  /** Every field of a card that does NOT come out of the manifest. */
  static get BOUND_FIELDS() {
    return ["world_id", "owner_id", "title", "state", "version", "manifest_hash", "manifest_version", "created_at", "updated_at"];
  }
  /**
   * Is this sidecar a cache OF THIS RECORD, or just a file sitting next to it?
   *
   * The old freshness test was `sidecarMtime >= recordMtime`, which answers a
   * different question — "was this file touched recently" — and answers it with
   * a clock whose granularity the filesystem does not promise. It could not see
   * a sidecar whose CONTENT disagreed with its record, so a sidecar saying
   * "published" put a private draft in the public catalogue, and two writes
   * inside one mtime tick pinned a stale card that no later list() could repair.
   *
   * This compares content instead. Every scalar the card carries must equal the
   * record's own, read from the record itself; and manifest_hash — a sha256 of
   * the manifest — binds the cached `manifest.meta`/`manifest.media` projection
   * to the exact manifest the record holds. A sidecar that disagrees anywhere is
   * not stale-or-fresh, it is simply not this record's cache, and is discarded.
   */
  static sidecarMatches(cached, head) {
    if (!cached || cached._summary !== true || typeof head?.manifest_hash !== "string" || !head.manifest_hash) return false;
    return FileWorldStore.BOUND_FIELDS.every((k) => (cached[k] ?? null) === (head[k] ?? null));
  }

  async put(record) {
    await this._atomicWrite(this._p(record.world_id), FileWorldStore.serialise(record));
    // The sidecar is written AFTER the record, so a crash between the two
    // leaves a summary that does not match its world — which list() detects by
    // comparing them and repairs from the record. The record is always the
    // truth; the sidecar is only ever a cache of it.
    const sp = this._sp(record.world_id);
    await this._rescueCollidingLegacy(sp);
    await this._atomicWrite(sp, JSON.stringify(FileWorldStore.summarise(record)));
    // If this world was itself stored at the old colliding path, it now lives in
    // its own namespace and the old copy must go, or list() would report it twice.
    const legacy = this._legacyP(record.world_id);
    if (legacy && await this._isRecordFor(legacy, record.world_id)) await fsp.rm(legacy, { force: true });
    return record;
  }
  /**
   * Before a cache overwrites this path, check that it is not somebody's world.
   * A pre-fix build stored the record of world `<x>.summary` at exactly the name
   * this sidecar wants. Move it into its own namespace first — the collision
   * destroyed data before, and a repair pass must not finish the job.
   */
  async _rescueCollidingLegacy(sp) {
    const name = path.basename(sp);
    let id = null, target = null;
    try { id = decodeURIComponent(name.slice(0, -".json".length)); target = this._p(id); } catch { return; }
    const head = await this._head(sp);
    if (!head || head.world_id !== id) return;            // our own cache, or unreadable: nothing to rescue
    try { await fsp.access(target); return; }             // already migrated; the cache may have the name
    catch { /* the record's own namespace is free */ }
    await fsp.rename(sp, target).catch(() => {});
  }
  /** True when the file at p is a world RECORD for id — not a sidecar, not another world's. */
  async _isRecordFor(p, id) {
    const head = await this._head(p);
    return !!head && head.world_id === String(id) && head._summary !== true;
  }

  async get(id) {
    const direct = await this._readJson(this._p(id));
    if (direct) return direct;
    // An id written before the namespaces were separated still answers from its
    // old path — but only if the file there really is this world's record. The
    // same path may hold the sidecar of the world whose id is our prefix, and a
    // cache must never be served as a world.
    const legacy = this._legacyP(id);
    if (legacy) {
      try {
        const l = await this._readJson(legacy);
        if (l && l._summary !== true && l.world_id === String(id)) return l;
      } catch { /* unreadable legacy file is not a world */ }
    }
    return null;
  }
  async _readJson(p) {
    try {
      return JSON.parse(await fsp.readFile(p, "utf8"));
    } catch (e) {
      if (e && e.code === "ENOENT") return null;
      throw e;
    }
  }

  /**
   * One discovery card, from the cache when the cache proves it is this
   * record's, and from the record itself otherwise.
   *
   * Note what the fallback is: the RECORD. A cache that is corrupt, truncated,
   * missing, stale or forged costs a read, never a row. The sidecar read has its
   * own try/catch for exactly that reason — it used to sit inside the outer
   * per-world `catch { skip }`, so an unparseable cache file DELETED a published
   * world from discovery while its record sat intact on disk.
   */
  async _card(recordPath) {
    const sp = recordPath.slice(0, -".json".length) + SIDECAR_SUFFIX;
    const head = await this._head(recordPath);
    const raw = await fsp.readFile(sp, "utf8").catch(() => null);
    if (head && raw !== null) {
      try {
        const cached = JSON.parse(raw);
        if (FileWorldStore.sidecarMatches(cached, head)) return cached;
      } catch { /* not a usable cache: the record answers */ }
    }
    const card = FileWorldStore.summarise(JSON.parse(await fsp.readFile(recordPath, "utf8")));
    const text = JSON.stringify(card);
    // Repaired with tmp+rename like every other write here. As a bare
    // writeFile, two concurrent list() repairs interleaved into a truncated
    // file — which then took the world out of discovery entirely. Skipped
    // entirely when the cache already holds this exact card, so a record whose
    // head cannot be read cheaply costs reads, never a write per list().
    if (text !== raw) await this._atomicWrite(sp, text).catch(() => {});   // best effort; the record still answered
    return card;
  }

  /**
   * @param summary  read the lightweight sidecar instead of the whole record.
   *                 Only for callers that need listing fields — discovery cards,
   *                 dashboards. A caller that needs the manifest must get()."
   */
  async list({ ownerId = null, state = null, limit = 50, summary = false } = {}) {
    const names = await fsp.readdir(this.dir).catch(() => []);
    // Canonical records first: a world that exists both in its own namespace and
    // at a legacy colliding path is listed once, from the canonical record.
    const ordered = [...names.filter((n) => !n.endsWith(SIDECAR_SUFFIX)), ...names.filter((n) => n.endsWith(SIDECAR_SUFFIX))];
    const out = [];
    const seen = new Set();
    for (const n of ordered) {
      if (!n.endsWith(".json")) continue;
      const full = path.join(this.dir, n);
      try {
        let r = null;
        if (n.endsWith(SIDECAR_SUFFIX)) {
          // Ambiguous by history: a sidecar, or a record written under a
          // colliding id by a pre-fix build. Skipping the name outright made a
          // world whose id ends in `.summary` vanish from listOwned,
          // listPublished and discovery while get() still returned it. Only the
          // content can tell the two apart.
          const rec = JSON.parse(await fsp.readFile(full, "utf8"));
          if (!rec || rec._summary === true) continue;                              // a cache is not a world
          if (rec.world_id !== decodeURIComponent(n.slice(0, -".json".length))) continue;
          r = summary ? FileWorldStore.summarise(rec) : rec;
        } else if (summary) {
          r = await this._card(full);
        } else {
          r = JSON.parse(await fsp.readFile(full, "utf8"));
        }
        if (!r || seen.has(r.world_id)) continue;
        seen.add(r.world_id);
        // Filtered on the record's own state and owner — never on a cache's
        // claim about them. _card() has already proved that what it returns
        // agrees with the record it came from.
        if (ownerId && r.owner_id !== ownerId) continue;
        if (state && r.state !== state) continue;
        out.push(r);
      } catch { /* a half-written temp file is not a world; skip */ }
    }
    out.sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")));
    return out.slice(0, limit);
  }
  async delete(id) {
    await fsp.rm(this._p(id), { force: true });
    await fsp.rm(this._sp(id), { force: true });
    const legacy = this._legacyP(id);
    if (legacy && await this._isRecordFor(legacy, id)) await fsp.rm(legacy, { force: true });
  }
}

/** Supabase-backed store. Every failure surfaces — nothing is best-effort here. */
export class SupabaseWorldStore {
  constructor({ url, serviceRoleKey, table = "dcsgames_base_worlds", fetchImpl } = {}) {
    this.url = String(url || "").replace(/\/$/, "");
    this.key = serviceRoleKey;
    this.table = table;
    this.fetch = fetchImpl || globalThis.fetch;
    this.kind = "supabase";
  }
  get _h() {
    return { apikey: this.key, Authorization: "Bearer " + this.key, "Content-Type": "application/json" };
  }
  async put(record) {
    const r = await this.fetch(`${this.url}/rest/v1/${this.table}?on_conflict=world_id`, {
      method: "POST",
      headers: { ...this._h, Prefer: "resolution=merge-duplicates,return=representation" },
      body: JSON.stringify(record),
    });
    if (!r.ok) throw Errors.upstream("supabase", `world upsert failed (${r.status}): ${await r.text().catch(() => "")}`);
    return record;
  }
  async get(id) {
    const r = await this.fetch(`${this.url}/rest/v1/${this.table}?world_id=eq.${encodeURIComponent(id)}&select=*&limit=1`, { headers: this._h });
    if (!r.ok) throw Errors.upstream("supabase", `world read failed (${r.status})`);
    const rows = await r.json();
    return rows[0] || null;
  }
  async list({ ownerId = null, state = null, limit = 50 } = {}) {
    let q = `${this.url}/rest/v1/${this.table}?select=*&limit=${limit}&order=updated_at.desc`;
    if (ownerId) q += `&owner_id=eq.${encodeURIComponent(ownerId)}`;
    if (state) q += `&state=eq.${encodeURIComponent(state)}`;
    const r = await this.fetch(q, { headers: this._h });
    if (!r.ok) throw Errors.upstream("supabase", `world list failed (${r.status})`);
    return await r.json();
  }
  async delete(id) {
    const r = await this.fetch(`${this.url}/rest/v1/${this.table}?world_id=eq.${encodeURIComponent(id)}`, { method: "DELETE", headers: this._h });
    if (!r.ok) throw Errors.upstream("supabase", `world delete failed (${r.status})`);
  }
}

/**
 * Mirrors writes to a primary and a durable local shadow.
 * If the primary is down the world is still recoverable, and the caller is TOLD
 * the write was degraded rather than being handed a false ok:true.
 */
export class MirroredWorldStore {
  constructor(primary, shadow) { this.primary = primary; this.shadow = shadow; this.kind = `${primary.kind}+${shadow.kind}`; }
  async put(record) {
    await this.shadow.put(record);                     // local durability first: cannot be lost
    const mirrored = await optional("supabase-world-mirror", () => this.primary.put(record));
    return { ...record, _mirrored: mirrored.ok, ...(mirrored.ok ? {} : { _mirror_error: mirrored.error }) };
  }
  async get(id) {
    const local = await this.shadow.get(id);
    if (local) return local;
    const remote = await optional("supabase-world-read", () => this.primary.get(id));
    return remote.ok ? remote.value : null;
  }
  async list(opts) {
    const remote = await optional("supabase-world-list", () => this.primary.list(opts));
    if (remote.ok && remote.value.length) {
      // listPublished's contract is "discovery cards only — the manifest is NOT
      // included in full", and it asks for that with summary:true. The primary
      // has no such option, so with SUPABASE_URL set — the deployed
      // configuration — every card carried its whole manifest again and the
      // measured cliff the sidecar exists to remove was untouched in the only
      // deployment that matters. A store that cannot honour an option that
      // changes the SHAPE of its answer must not silently drop it.
      return opts?.summary ? remote.value.map((r) => (r && r._summary ? r : FileWorldStore.summarise(r))) : remote.value;
    }
    return await this.shadow.list(opts);
  }
  async delete(id) { await this.shadow.delete(id); await optional("supabase-world-delete", () => this.primary.delete(id)); }
}

/**
 * Every accepted world version, retained.
 *
 * Migration 0003 declared dcsgames_world_versions for the B6 rollback
 * requirement, and nothing ever wrote to it: the table existed, the feature it
 * was for could not work, and the gap was invisible because no code referenced
 * the table at all. A world could be expanded five times with no way back to
 * version three.
 */
export class VersionHistoryStore {
  constructor(dir) {
    this.dir = dir || path.join(process.cwd(), ".dcs-data", "world-versions");
    fs.mkdirSync(this.dir, { recursive: true });
  }
  _p(worldId, version) {
    if (!/^[A-Za-z0-9._:-]{1,200}$/.test(String(worldId))) throw Errors.validation(`unsafe world id: ${worldId}`);
    if (!Number.isInteger(version) || version < 1) throw Errors.validation(`unsafe version: ${version}`);
    return path.join(this.dir, `${encodeURIComponent(String(worldId))}@${version}.json`);
  }
  async put(worldId, version, record) {
    const p = this._p(worldId, version);
    // A version already written is IMMUTABLE. Overwriting it would silently
    // rewrite history, which is the one thing rollback must be able to trust.
    try { await fsp.access(p); return { ...record, already_recorded: true }; }
    catch { /* not written yet */ }
    const tmp = p + ".tmp-" + crypto.randomBytes(4).toString("hex");
    await fsp.writeFile(tmp, JSON.stringify(record));
    await fsp.rename(tmp, p);
    return record;
  }
  async get(worldId, version) {
    try { return JSON.parse(await fsp.readFile(this._p(worldId, version), "utf8")); }
    catch (e) { if (e.code === "ENOENT") return null; throw e; }
  }
  async list(worldId) {
    const prefix = encodeURIComponent(String(worldId)) + "@";
    const names = (await fsp.readdir(this.dir).catch(() => [])).filter((n) => n.startsWith(prefix) && n.endsWith(".json"));
    const out = [];
    for (const n of names) {
      try {
        const r = JSON.parse(await fsp.readFile(path.join(this.dir, n), "utf8"));
        // `state` is in this projection because the visibility gate reads it:
        // WorldRepository._versionVisible answers `v.state === "published"`, and
        // dropping the field made every listed row `state: undefined`. A
        // stranger was told a fully published world had NO history, while
        // getVersion() — which reads the whole retained record — handed that
        // same caller those same versions. The list and the item must decide on
        // the same field or they answer one question two ways.
        out.push({ version: r.version, state: r.state ?? null, manifest_hash: r.manifest_hash, label: r.label ?? null, created_by: r.created_by ?? null, created_at: r.created_at });
      } catch { /* a half-written temp file is not a version */ }
    }
    out.sort((a, b) => a.version - b.version);
    return out;
  }
}

/** The repository the router talks to. Owns ownership rules and the record shape. */
export class WorldRepository {
  constructor(store, versions = null) { this.store = store; this.versions = versions; }
  get kind() { return this.store.kind; }

  /**
   * Idempotent create-or-update. Re-running with the same manifest is a no-op
   * that returns the same hash, so a retried request cannot fork a world.
   */
  async upsert(args) {
    // Serialised per world. This method reads the existing record, decides the
    // next version from it, and writes — with awaits throughout. Two concurrent
    // saves both read the same version and the second erased the first: 64
    // concurrent saves returned 64x 200, produced ZERO conflicts, and advanced
    // the world by ONE version. Sixty-three edits were acknowledged and lost,
    // and the retained history did not have them either, so a rollback could
    // not recover them. Only writes to the SAME world wait on each other.
    return await withLock(`world:${args?.worldId}`, () => this._upsert(args));
  }

  async _upsert({ worldId, ownerId, manifest, state = "draft", title = null, expected_version = null }) {
    if (!worldId) throw Errors.validation("world_id is required");
    if (!manifest || typeof manifest !== "object") throw Errors.validation("manifest must be an object");
    const existing = await this.store.get(worldId);
    // Fail CLOSED. This was `existing && ownerId && existing.owner_id && ...`,
    // so it skipped entirely when EITHER side was absent: a caller passing no
    // ownerId could overwrite anyone's world, and a stored row with a null
    // owner could be overwritten — and re-published — by any caller. An absent
    // owner is not permission; it is the absence of evidence of permission.
    if (existing && existing.owner_id !== (ownerId ?? null)) {
      throw Errors.forbidden("this world belongs to another creator");
    }
    if (expected_version != null && existing && Number(existing.version) !== Number(expected_version)) {
      throw Errors.conflict(`world was modified concurrently (have v${existing.version}, expected v${expected_version})`);
    }
    const hash = manifestHash(manifest);
    const nextTitle = title ?? manifest?.meta?.title ?? manifest?.title ?? existing?.title ?? null;
    // The guard must cover EVERY field this write would change, or a write that
    // changes one of them is answered `ok:true, idempotent:true` and thrown
    // away. `title` is not in the manifest hash — it can be passed in on its
    // own — so renaming a world was acknowledged and never stored, and the
    // discovery card kept showing the old name.
    if (existing && existing.manifest_hash === hash && existing.state === state && (existing.title ?? null) === nextTitle) {
      return { ...existing, idempotent: true };   // identical write -> no version churn
    }
    const now = new Date().toISOString();
    const record = {
      world_id: worldId,
      owner_id: ownerId ?? existing?.owner_id ?? null,
      title: nextTitle,
      state,
      version: existing ? Number(existing.version || 1) + 1 : 1,
      manifest,                                    // LOSSLESS: the whole manifest, not a projection
      manifest_hash: hash,
      manifest_version: manifest?.manifest_version ?? existing?.manifest_version ?? null,
      created_at: existing?.created_at || now,
      updated_at: now,
    };
    const saved = await this.store.put(record);
    // Retain the version BEFORE returning, so a rollback target always exists for
    // anything a caller has been told was saved.
    if (this.versions) {
      await this.versions.put(worldId, record.version, {
        world_id: worldId, version: record.version, manifest, manifest_hash: hash,
        label: manifest?.expansion?.history?.at(-1)?.label ?? null,
        // The state this version was saved IN. Without it, publishing a world
        // retroactively exposed every draft-era version: the permission check
        // asked only whether the world is published NOW, and the retained
        // versions carried no state of their own.
        state: record.state,
        created_by: ownerId ?? null, created_at: record.updated_at,
      });
    }
    return { ...record, ...(saved && saved._mirrored === false ? { _mirrored: false, _mirror_error: saved._mirror_error } : {}), idempotent: false };
  }

  /**
   * A world, or the same answer a stranger gets for a world that is not there.
   *
   * The two refusals are deliberately NOT the same shape:
   *
   *   requireOwner — the caller has authenticated and is acting on a world they
   *     claim as theirs (publish, expand, roll back). They already know the id
   *     exists, because they are being refused for owning something else, and
   *     "this belongs to another creator" is the only answer that makes a real
   *     ownership conflict readable. It stays a 403.
   *
   *   a plain read — the caller may be anonymous and may have guessed the id.
   *     Answering 403 for a world that exists and 404 for one that does not
   *     turned every read route into an existence oracle: the status alone told
   *     an unauthenticated caller which world ids are real. So a caller who may
   *     not see a world is told exactly what a caller asking about a world that
   *     was never created is told — same status, same code, same detail string,
   *     since a differing message leaks it just as well as a differing status.
   *     This costs nothing: a reader who cannot see the world has no use for the
   *     distinction, and the owner still gets their world.
   */
  async get(worldId, { requesterId = null, requireOwner = false } = {}) {
    const r = await this.store.get(worldId);
    // Fail CLOSED on both, for the same reason as upsert: a world with no owner
    // recorded used to satisfy requireOwner for every caller, and an unowned
    // draft used to be readable by anyone.
    if (r && requireOwner && r.owner_id !== requesterId) throw Errors.forbidden("this world belongs to another creator");
    // Published worlds are readable by anyone; drafts only by their owner (IDOR guard).
    if (!r || (!requireOwner && r.state !== "published" && requesterId !== r.owner_id)) {
      throw Errors.notFound(`world ${worldId}`);
    }
    return r;
  }
  /**
   * A retained version is visible if its OWN state was published, or if the
   * caller owns the world. Publishing a world must not retroactively publish
   * the drafts it passed through — that content was private when it was written
   * and there is no way to withdraw it, because history is deliberately
   * append-only. A version recorded before this field existed has no provable
   * state, so it is treated as private.
   */
  _versionVisible(v, world, requesterId) {
    if (world.owner_id != null && world.owner_id === requesterId) return true;
    return v.state === "published";
  }

  /** Every retained version of a world the caller may see, oldest first. */
  async listVersions(worldId, { requesterId = null } = {}) {
    const world = await this.get(worldId, { requesterId });   // permission check first
    const all = this.versions ? await this.versions.list(worldId) : [];
    return all.filter((v) => this._versionVisible(v, world, requesterId));
  }

  /** One retained version, for a rollback or a diff. */
  async getVersion(worldId, version, { requesterId = null } = {}) {
    const world = await this.get(worldId, { requesterId });
    const v = this.versions ? await this.versions.get(worldId, Number(version)) : null;
    if (!v) throw Errors.notFound(`version ${version} of world ${worldId}`);
    if (!this._versionVisible(v, world, requesterId)) {
      // The SAME answer as a version that does not exist. A 403 here said
      // "version 7 exists and was private", which is the world-level existence
      // oracle one level down — it tells a stranger which version numbers a
      // world passed through. The owner still gets the version itself.
      throw Errors.notFound(`version ${version} of world ${worldId}`);
    }
    return v;
  }

  async listOwned(ownerId, limit = 50) {
    if (!ownerId) throw Errors.validation("owner is required");
    return await this.store.list({ ownerId, limit });
  }
  /** Discovery cards only — the manifest is NOT included in full. */
  async listPublished(limit = 50) { return await this.store.list({ state: "published", limit, summary: true }); }
}

export function createWorldRepository(env = process.env) {
  const url = (env.SUPABASE_URL || "").replace(/\/$/, "");
  const key = env.SUPABASE_SERVICE_ROLE_KEY || "";
  const base = env.DCS_DATA_DIR || path.join(process.cwd(), ".dcs-data");
  const file = new FileWorldStore(path.join(base, "worlds"));
  const versions = new VersionHistoryStore(path.join(base, "world-versions"));
  if (url && key) return new WorldRepository(new MirroredWorldStore(new SupabaseWorldStore({ url, serviceRoleKey: key }), file), versions);
  return new WorldRepository(file, versions);
}
