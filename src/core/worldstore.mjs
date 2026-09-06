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


/**
 * The nine scalar columns a discovery card is made of, plus the two manifest
 * sub-objects it projects. `select=*` pulled the WHOLE manifest to build a card
 * that keeps `manifest.meta` and `manifest.media`: measured at 24 published
 * worlds with 60-zone manifests, 941KB arrived to serve 10KB of cards — 98.9%
 * of the transfer was decoded, allocated and thrown away on this side.
 */
const CARD_SCALARS = ["world_id", "owner_id", "title", "state", "version", "manifest_hash", "manifest_version", "created_at", "updated_at"];
/**
 * PostgREST's json arrow selector projects into a jsonb column server-side, so
 * the manifest body never leaves the database. The response names an arrow
 * column after its last segment (`manifest->meta` arrives as `meta`), which is
 * why _cardFromRow accepts both spellings.
 */
const CARD_PROJECTION = CARD_SCALARS.join(",") + ",manifest->meta,manifest->media";

/** Supabase-backed store. Every failure surfaces — nothing is best-effort here. */
export class SupabaseWorldStore {
  constructor({ url, serviceRoleKey, table = "dcsgames_base_worlds", fetchImpl } = {}) {
    this.url = String(url || "").replace(/\/$/, "");
    this.key = serviceRoleKey;
    this.table = table;
    this.fetch = fetchImpl || globalThis.fetch;
    this.kind = "supabase";
    // Set once if this endpoint rejects the json-arrow projection (an older
    // PostgREST, a view, or a `manifest` column that is text rather than jsonb).
    // Then we stop asking for it rather than degrading every listing.
    this._noJsonProjection = false;
  }
  get _h() {
    return { apikey: this.key, Authorization: "Bearer " + this.key, "Content-Type": "application/json" };
  }
  /** A projected row, in exactly the shape FileWorldStore.summarise produces. */
  static _cardFromRow(row) {
    const r = row || {};
    const meta = r.meta !== undefined ? r.meta : (r.manifest?.meta ?? null);
    const media = r.media !== undefined ? r.media : (r.manifest?.media ?? null);
    const card = {};
    for (const k of CARD_SCALARS) card[k] = r[k] === undefined ? null : r[k];
    card.manifest = { meta: meta ?? null, media: media ?? null };
    card._summary = true;
    return card;
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
  /**
   * @param summary  ask the DATABASE for a card instead of a whole record.
   *                 MirroredWorldStore re-summarises whatever it gets, so the
   *                 manifest body it discarded had already been paid for on the
   *                 wire; the option has to reach the query or the projection is
   *                 not a projection, it is a filter applied after the transfer.
   */
  async list({ ownerId = null, state = null, limit = 50, summary = false } = {}) {
    const wantCards = !!summary && !this._noJsonProjection;
    // `limit` is interpolated into a query string, so it is coerced to a number
    // here. Every call site passes an integer today; one route that forwards a
    // query parameter would otherwise append filters of the caller's choosing.
    const n = Number.isFinite(Number(limit)) ? Math.max(0, Math.trunc(Number(limit))) : 50;
    let q = `${this.url}/rest/v1/${this.table}?select=${wantCards ? CARD_PROJECTION : "*"}&limit=${n}&order=updated_at.desc`;
    if (ownerId) q += `&owner_id=eq.${encodeURIComponent(ownerId)}`;
    if (state) q += `&state=eq.${encodeURIComponent(state)}`;
    const r = await this.fetch(q, { headers: this._h });
    if (!r.ok) {
      // A 400 on the projected select is a statement about the SELECT, not about
      // the data: this endpoint cannot project into the manifest. Fall back to
      // the whole row once, remember it, and let the caller re-summarise.
      if (wantCards && r.status === 400) {
        this._noJsonProjection = true;
        // The shape the caller asked for is still the shape it gets — the
        // saving is what is lost, not the contract.
        const rows = await this.list({ ownerId, state, limit });
        return rows.map((row) => FileWorldStore.summarise(row));
      }
      throw Errors.upstream("supabase", `world list failed (${r.status})`);
    }
    const rows = await r.json();
    return wantCards ? rows.map((row) => SupabaseWorldStore._cardFromRow(row)) : rows;
  }
  async delete(id) {
    const r = await this.fetch(`${this.url}/rest/v1/${this.table}?world_id=eq.${encodeURIComponent(id)}`, { method: "DELETE", headers: this._h });
    if (!r.ok) throw Errors.upstream("supabase", `world delete failed (${r.status})`);
  }
}

/** Where the pending-mirror markers live, inside the shadow's own directory. */
const PENDING_DIR = ".mirror-pending";
const PENDING_SUFFIX = ".pending";

/**
 * Mirrors writes to a primary and a durable local shadow.
 *
 * WHICH BACKING IS THE TRUTH. The two can disagree, and until now they were
 * asked different questions by different methods: get() read the shadow, list()
 * read the primary, and one repository answered the same question two ways —
 * different title, different manifest_hash, for the same world.
 *
 * The rule, applied identically by get(), list() and delete():
 *
 *   1. THE PRIMARY IS THE TRUTH whenever it answers. It is the only backing the
 *      whole fleet shares; it holds rows this node has never seen (another
 *      instance, a dashboard, a seed, a migration), and an empty answer from it
 *      is an ANSWER — this used to be read as a failure, so a world genuinely
 *      removed from the primary reappeared from the shadow forever.
 *   2. The shadow is authoritative for exactly one set of worlds: those with a
 *      PENDING marker, meaning this node accepted a write or a delete that the
 *      primary has not confirmed. The shadow is written first and
 *      unconditionally, so for those worlds it is strictly ahead.
 *   3. The shadow is also the degraded fallback: when the primary does not
 *      answer at all, the last thing we know beats nothing at all.
 *
 * That is the whole rule, and get(), list() and delete() apply it identically —
 * which is what stops one repository answering the same question two ways.
 *
 * WHAT THIS COSTS. A shadow row with NO marker means the primary confirmed that
 * row at some point, so the primary no longer having it means it was deleted
 * there. That inference is sound for every row this class has written, and it
 * is wrong in exactly two places: a marker file whose write failed (the marker
 * still exists in memory, so only a restart loses it), and a row written by a
 * build older than these markers whose mirror had failed. In both cases the row
 * is not served and not destroyed — the shadow file is untouched and re-saving
 * the world restores it. The alternative, serving any shadow row the primary
 * lacks, cannot ever converge: it re-creates deleted worlds indefinitely and
 * pushes them back to the primary. Losing sight of a row that is still on disk
 * is recoverable; resurrecting deleted content is not. The divergence is logged
 * rather than passed over in silence.
 *
 * The markers are files, not a process-local flag: a restart between the failed
 * write and the recovery used to destroy the only record that a row still had
 * to be pushed. They live in <shadow.dir>/.mirror-pending, which FileWorldStore
 * .list skips (it is not a `.json` name), so the two namespaces do not overlap.
 */
export class MirroredWorldStore {
  /**
   * @param resyncBackoffMs  minimum gap between two failed resync sweeps. 0 (the
   *   default) retries on every operation, which converges as fast as possible
   *   at the cost of one extra failing call per pending world while the primary
   *   is down. Raise it if a long outage with many pending worlds is a concern.
   */
  constructor(primary, shadow, { resyncBackoffMs = 0 } = {}) {
    this.primary = primary;
    this.shadow = shadow;
    this.kind = `${primary.kind}+${shadow.kind}`;
    this._dir = typeof shadow?.dir === "string" ? path.join(shadow.dir, PENDING_DIR) : null;
    this._pending = null;            // Map<world_id, "put"|"delete">, loaded from disk once
    this._draining = false;
    this._lastFailedSweep = 0;
    this._backoff = Number(resyncBackoffMs) || 0;
  }

  // -- the pending set -------------------------------------------------------

  _markerPath(id) { return path.join(this._dir, encodeURIComponent(String(id)) + PENDING_SUFFIX); }

  /**
   * The divergences this node knows about, recovered from disk on first use so
   * a restart does not forget them. Loaded once: a marker written by ANOTHER
   * process is not seen here, and does not need to be — that process drains its
   * own, and get() reports any divergence it meets (see _reportDivergence).
   */
  async _pendingSet() {
    if (this._pending) return this._pending;
    const map = new Map();
    if (this._dir) {
      for (const n of await fsp.readdir(this._dir).catch(() => [])) {
        if (!n.endsWith(PENDING_SUFFIX)) continue;
        try {
          const j = JSON.parse(await fsp.readFile(path.join(this._dir, n), "utf8"));
          if (j && j.world_id) map.set(String(j.world_id), j.op === "delete" ? "delete" : "put");
        } catch { /* an unreadable marker is not a claim about anything */ }
      }
    }
    this._pending = map;
    return map;
  }
  async _mark(id, op) {
    (await this._pendingSet()).set(String(id), op);
    if (!this._dir) return;                       // no shadow directory: in-process only
    try {
      await fsp.mkdir(this._dir, { recursive: true });
      const p = this._markerPath(id);
      const tmp = p + ".tmp-" + crypto.randomBytes(4).toString("hex");
      await fsp.writeFile(tmp, JSON.stringify({ world_id: String(id), op, at: new Date().toISOString() }));
      await fsp.rename(tmp, p);
    } catch { /* best effort: losing the marker costs convergence speed, not data */ }
  }
  async _clear(id) {
    (await this._pendingSet()).delete(String(id));
    if (this._dir) await fsp.rm(this._markerPath(id), { force: true }).catch(() => {});
  }
  /** What this store still owes the primary for one world: null | "put" | "delete". */
  async mirrorState(id) { return (await this._pendingSet()).get(String(id)) || null; }

  /**
   * Push everything the primary has not been told about.
   *
   * This is the piece that did not exist. A write the primary refused left the
   * row in the shadow only, and nothing — not a read, not a listing, not even
   * re-issuing the identical save — ever pushed it back, because the
   * idempotency check was made against the shadow and answered `idempotent`
   * without touching the primary. So a healthy database was permanently missing
   * a world its owner had been told was saved.
   */
  async _drain() {
    const pend = await this._pendingSet();
    if (!pend.size || this._draining) return;
    if (this._backoff && Date.now() - this._lastFailedSweep < this._backoff) return;
    this._draining = true;
    let failed = false;
    try {
      for (const [id, op] of [...pend]) {
        if (op === "delete") {
          const r = await optional("supabase-world-delete-resync", () => this.primary.delete(id));
          if (r.ok) await this._clear(id); else failed = true;
          continue;
        }
        const rec = await this.shadow.get(id).catch(() => null);
        if (!rec) { await this._clear(id); continue; }   // nothing left to push
        const r = await optional("supabase-world-mirror-resync", () => this.primary.put(rec));
        if (r.ok) await this._clear(id); else failed = true;
      }
    } finally {
      this._draining = false;
      if (failed) this._lastFailedSweep = Date.now();
    }
  }

  // -- the store interface ---------------------------------------------------

  async put(record) {
    await this.shadow.put(record);                     // local durability first: cannot be lost
    const mirrored = await optional("supabase-world-mirror", () => this.primary.put(record));
    // A successful write supersedes any tombstone for the same id: the world is
    // back, and the delete it never applied is moot.
    if (mirrored.ok) { await this._clear(record.world_id); await this._drain(); }
    else await this._mark(record.world_id, "put");
    return { ...record, _mirrored: mirrored.ok, ...(mirrored.ok ? {} : { _mirror_error: mirrored.error }) };
  }

  /**
   * A shadow row the primary does not have and no marker explains. Under the
   * rule above it is not served — but it is never passed over in silence, so an
   * operator can see that a row is on this disk and nowhere else. Logged once
   * per world per process; the id is already in this node's own logs.
   */
  async _reportDivergence(id) {
    this._reported = this._reported || new Set();
    if (this._reported.has(String(id))) return;
    const local = await this.shadow.get(id).catch(() => null);
    if (!local) return;                                        // simply not a world: nothing to report
    this._reported.add(String(id));
    console.warn(JSON.stringify({
      level: "warn", degraded: "supabase-world-divergence", world_id: String(id),
      detail: "the shadow holds a world the primary does not, and no pending marker explains it; it is not being served",
      ts: new Date().toISOString(),
    }));
  }

  async get(id) {
    await this._drain();
    const state = (await this._pendingSet()).get(String(id));
    if (state === "delete") return null;                       // tombstoned here; the primary is behind
    if (state === "put") return await this.shadow.get(id);     // the shadow is AHEAD of the primary
    const remote = await optional("supabase-world-read", () => this.primary.get(id));
    if (!remote.ok) return await this.shadow.get(id);          // degraded: the last thing we know
    if (remote.value) return remote.value;
    await this._reportDivergence(id);
    return null;                                               // the primary answered, and it said no
  }

  /**
   * The same truth rule as get(), so the two cannot disagree.
   *
   * Three things changed here. An EMPTY answer from the primary used to be
   * treated as a FAILED answer (`remote.ok && remote.value.length`), so a world
   * genuinely removed from the primary reappeared from the shadow forever — and
   * a listing fell back to the WHOLE shadow catalogue on an answer that was
   * simply "nothing matches that filter". The primary's rows were passed
   * straight through without re-applying `ownerId` or `state`, so this file's
   * own listing gate — the thing that keeps drafts out of the public catalogue
   * — was simply absent on the deployed path. And the pending overlay did not
   * exist, so the listing served the stale primary row for a world get()
   * answered from the shadow.
   */
  async list(opts = {}) {
    await this._drain();
    const { ownerId = null, state = null, limit = 50, summary = false } = opts || {};
    const remote = await optional("supabase-world-list", () => this.primary.list(opts));
    if (!remote.ok) return await this.shadow.list(opts);        // outage degrades, never empties
    const pend = await this._pendingSet();
    const rows = [];
    const seen = new Set();
    // Local rows the primary has not accepted are ahead of it, so they come first.
    for (const [id, op] of pend) {
      if (op !== "put") continue;
      const rec = await this.shadow.get(id).catch(() => null);
      if (!rec) continue;
      seen.add(rec.world_id);
      rows.push(rec);
    }
    for (const r of Array.isArray(remote.value) ? remote.value : []) {
      if (!r || seen.has(r.world_id)) continue;
      if (pend.get(String(r.world_id)) === "delete") continue;  // tombstoned here
      seen.add(r.world_id);
      rows.push(r);
    }
    // Re-applied on THIS side as well as on the wire. The wire filter is the
    // fast path, not the gate: a dropped `&state=eq.`, a mis-set RLS policy, a
    // view with a different definition or a future `or=` refactor all look like
    // a primary that answered with rows it should not have, and nothing between
    // the wire and the caller used to notice.
    const filtered = rows.filter((r) => (!ownerId || r.owner_id === ownerId) && (!state || r.state === state));
    filtered.sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")));
    const page = filtered.slice(0, Number.isFinite(Number(limit)) ? Number(limit) : 50);
    // listPublished's contract is "discovery cards only — the manifest is NOT
    // included in full". A store that cannot honour an option that changes the
    // SHAPE of its answer must not silently drop it.
    return summary ? page.map((r) => (r && r._summary ? r : FileWorldStore.summarise(r))) : page;
  }

  /**
   * Delete, honestly.
   *
   * This used to remove the shadow, wrap the primary in optional() and return
   * undefined. With the primary DELETE failing the row survived remotely, the
   * shadow miss fell through to the primary, and the "deleted" world was served
   * again — manifest, owner and all — and stayed in the public catalogue, with
   * no channel to tell the caller anything had gone wrong.
   *
   * Now the tombstone is written BEFORE either copy is touched, so a crash
   * anywhere in here cannot resurrect the world; get() and list() honour it; the
   * resync sweep retries the primary until it converges; and the caller is told
   * whether the primary took it.
   */
  async delete(id) {
    await this._mark(id, "delete");
    await this.shadow.delete(id);
    const mirrored = await optional("supabase-world-delete", () => this.primary.delete(id));
    if (mirrored.ok) await this._clear(id);
    return {
      world_id: String(id), deleted: true, _mirrored: mirrored.ok,
      ...(mirrored.ok ? {} : { _mirror_error: mirrored.error }),
    };
  }
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
    this.kind = "file";
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

/**
 * dcsgames_world_versions, over PostgREST.
 *
 * THE COLUMNS THIS TABLE HAS. Migration 0003 declares exactly
 *   (world_id, version, manifest, manifest_hash, label, created_by, created_at)
 * with `primary key (world_id, version)`. It has no `state` column, and this
 * store must not invent one: PostgREST answers PGRST204 for a key the schema
 * cache does not know, so a payload carrying `state` would fail EVERY write and
 * the history would go on reaching nothing but the disk.
 *
 * The consequence is stated rather than hidden. `state` is the field
 * WorldRepository._versionVisible uses to decide whether a stranger may see a
 * retained version, and a version recovered from the DATABASE alone therefore
 * has no provable state — which the repository already treats as private. So
 * after a disk loss the owner still has every rollback target, and a stranger
 * sees none of them. That is the fail-closed direction: the alternative is
 * deciding visibility from the world's CURRENT state, which retroactively
 * publishes every draft the world passed through. Carrying it properly needs
 * `alter table ... add column state text` in a later migration.
 */
export class SupabaseVersionHistoryStore {
  constructor({ url, serviceRoleKey, table = "dcsgames_world_versions", fetchImpl } = {}) {
    this.url = String(url || "").replace(/\/$/, "");
    this.key = serviceRoleKey;
    this.table = table;
    this.fetch = fetchImpl || globalThis.fetch;
    this.kind = "supabase";
  }
  get _h() { return { apikey: this.key, Authorization: "Bearer " + this.key, "Content-Type": "application/json" }; }

  /** Only the columns migration 0003 declares. Anything else is a PGRST204. */
  static _wire(worldId, version, record) {
    return {
      world_id: String(worldId),
      version: Number(version),
      manifest: record?.manifest ?? null,
      manifest_hash: record?.manifest_hash ?? null,
      label: record?.label ?? null,
      created_by: record?.created_by ?? null,
      created_at: record?.created_at ?? new Date().toISOString(),
    };
  }
  /**
   * Append one version. History is append-only, so this is an INSERT and a
   * duplicate key is a SUCCESS, not a failure — 23505 means the row this write
   * wanted is already there, byte for byte or not, and rewriting it is the one
   * thing rollback must never see.
   */
  async put(worldId, version, record) {
    const r = await this.fetch(`${this.url}/rest/v1/${this.table}`, {
      method: "POST",
      headers: { ...this._h, Prefer: "return=minimal" },
      body: JSON.stringify(SupabaseVersionHistoryStore._wire(worldId, version, record)),
    });
    if (r.status === 409) { await r.text().catch(() => ""); return { ...record, already_recorded: true }; }
    if (!r.ok) throw Errors.upstream("supabase", `world version write failed (${r.status}): ${await r.text().catch(() => "")}`);
    return record;
  }
  async get(worldId, version) {
    const q = `${this.url}/rest/v1/${this.table}?world_id=eq.${encodeURIComponent(String(worldId))}&version=eq.${Number(version)}&select=*&limit=1`;
    const r = await this.fetch(q, { headers: this._h });
    if (!r.ok) throw Errors.upstream("supabase", `world version read failed (${r.status})`);
    const rows = await r.json();
    return rows[0] || null;
  }
  /** The listing projection — never the manifest, which is the whole payload. */
  async list(worldId) {
    const q = `${this.url}/rest/v1/${this.table}?world_id=eq.${encodeURIComponent(String(worldId))}&select=version,manifest_hash,label,created_by,created_at&order=version.asc`;
    const r = await this.fetch(q, { headers: this._h });
    if (!r.ok) throw Errors.upstream("supabase", `world version list failed (${r.status})`);
    const rows = await r.json();
    return rows.map((v) => ({
      version: Number(v.version),
      state: null,                 // the table has no such column; see the class comment
      manifest_hash: v.manifest_hash ?? null,
      label: v.label ?? null,
      created_by: v.created_by ?? null,
      created_at: v.created_at ?? null,
    })).sort((a, b) => a.version - b.version);
  }
}

/**
 * Retained history in both places, built exactly like the world store above.
 *
 * The world store needs the pending-marker machinery because a world CHANGES: a
 * shadow copy can be ahead of the primary, so the two can disagree about
 * content. A retained version cannot. It is immutable and append-only, so the
 * two copies can only ever disagree about PRESENCE, and the union of them is
 * always the correct answer. That is why the truth rule here is simply "either
 * backing counts", with the local row preferred where both have it — the local
 * row carries `state`, which the declared table cannot.
 */
export class MirroredVersionHistoryStore {
  constructor(primary, shadow) {
    this.primary = primary;
    this.shadow = shadow;
    this.kind = `${primary.kind}+${shadow.kind}`;
  }
  get dir() { return this.shadow.dir; }

  async put(worldId, version, record) {
    const local = await this.shadow.put(worldId, version, record);   // durable first
    // Already on disk means it was already offered to the primary. Re-sending
    // it every time an idempotent save runs would be pure write amplification,
    // and the resync in list() covers the case where that offer was refused.
    if (local && local.already_recorded) return local;
    const m = await optional("supabase-world-version-mirror", () => this.primary.put(worldId, version, record));
    return { ...local, _mirrored: m.ok, ...(m.ok ? {} : { _mirror_error: m.error }) };
  }
  async get(worldId, version) {
    const local = await this.shadow.get(worldId, version);
    if (local) return local;
    const r = await optional("supabase-world-version-read", () => this.primary.get(worldId, version));
    return r.ok ? (r.value || null) : null;
  }
  async list(worldId) {
    const local = await this.shadow.list(worldId);
    const r = await optional("supabase-world-version-list", () => this.primary.list(worldId));
    if (!r.ok) return local;                                  // outage degrades to the disk
    const byVersion = new Map();
    for (const v of Array.isArray(r.value) ? r.value : []) byVersion.set(Number(v.version), v);
    for (const v of local) byVersion.set(Number(v.version), v);   // local wins: it has `state`
    // Opportunistic resync, bounded by the difference and only attempted when
    // the primary ANSWERED — so a missing table costs one failed list, not one
    // failed write per retained version per request.
    const remoteHas = new Set((Array.isArray(r.value) ? r.value : []).map((v) => Number(v.version)));
    for (const v of local) {
      if (remoteHas.has(Number(v.version))) continue;
      const full = await this.shadow.get(worldId, Number(v.version)).catch(() => null);
      if (!full) continue;
      await optional("supabase-world-version-resync", () => this.primary.put(worldId, Number(v.version), full));
    }
    return [...byVersion.values()].sort((a, b) => a.version - b.version);
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
    // Same as the read gate: an unowned row must not be writable — or
    // publishable — by an anonymous caller just because both owners are null.
    if (existing && !(ownerId != null && existing.owner_id != null && existing.owner_id === ownerId)) {
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
      // The store's own get() has already drained anything the primary was owed
      // for this world, so an identical re-save is now a genuine remedy for a
      // degraded write rather than a short-circuit that guaranteed it could
      // never be repaired. If the primary is STILL behind, say so — a caller
      // told `idempotent:true` and nothing else would believe it was mirrored.
      const pending = this.store.mirrorState ? await this.store.mirrorState(worldId) : null;
      return { ...existing, idempotent: true, ...(pending === "put" ? { _mirrored: false } : {}) };
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
    // `!==` alone let ANONYMOUS through on a row with no owner: both sides are
    // null, so null === null satisfied the gate. Ownership needs a named owner
    // AND a named caller who are the same person — nobody is not somebody.
    if (r && requireOwner && !(requesterId != null && r.owner_id != null && r.owner_id === requesterId)) throw Errors.forbidden("this world belongs to another creator");
    // Published worlds are readable by anyone; drafts only by their owner (IDOR guard).
    if (!r || (!requireOwner && r.state !== "published" && !(requesterId != null && r.owner_id != null && r.owner_id === requesterId))) {
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
   * state, so it is treated as private. A version recovered from
   * dcsgames_world_versions alone is in exactly that position, because the
   * declared table has no `state` column — see SupabaseVersionHistoryStore.
   */
  _versionVisible(v, world, requesterId) {
    if (requesterId != null && world.owner_id != null && world.owner_id === requesterId) return true;
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
  if (url && key) {
    // Both stores get the same treatment. Retained history used to be built
    // FILE-ONLY whatever the environment said, so migration 0003's
    // dcsgames_world_versions never received a byte and B6 rollback rested
    // entirely on a container disk that a redeploy throws away: the world
    // survived and every rollback target did not.
    return new WorldRepository(
      new MirroredWorldStore(new SupabaseWorldStore({ url, serviceRoleKey: key }), file),
      new MirroredVersionHistoryStore(new SupabaseVersionHistoryStore({ url, serviceRoleKey: key }), versions),
    );
  }
  return new WorldRepository(file, versions);
}
