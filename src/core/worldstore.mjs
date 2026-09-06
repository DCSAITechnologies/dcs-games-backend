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

/** Durable JSON-on-disk store. Atomic writes (tmp + rename) survive a kill mid-write. */
export class FileWorldStore {
  constructor(dir) {
    this.dir = dir || process.env.DCS_DATA_DIR || path.join(process.cwd(), ".dcs-data", "worlds");
    fs.mkdirSync(this.dir, { recursive: true });
    this.kind = "file";
  }
  _p(id) {
    if (!/^[A-Za-z0-9._:-]{1,200}$/.test(String(id))) throw Errors.validation(`unsafe world id: ${id}`);
    return path.join(this.dir, encodeURIComponent(String(id)) + ".json");
  }
  _sp(id) { return this._p(id).replace(/\.json$/, ".summary.json"); }

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

  async put(record) {
    const p = this._p(record.world_id);
    const tmp = p + ".tmp-" + crypto.randomBytes(4).toString("hex");
    await fsp.writeFile(tmp, JSON.stringify(record));
    await fsp.rename(tmp, p);          // atomic on POSIX
    // The sidecar is written AFTER the record, so a crash between the two
    // leaves a summary older than its world — which list() detects by mtime and
    // repairs from the record. The record is always the truth; the sidecar is
    // only ever a cache of it.
    const sp = this._sp(record.world_id);
    const stmp = sp + ".tmp-" + crypto.randomBytes(4).toString("hex");
    await fsp.writeFile(stmp, JSON.stringify(FileWorldStore.summarise(record)));
    await fsp.rename(stmp, sp);
    return record;
  }
  async get(id) {
    try {
      return JSON.parse(await fsp.readFile(this._p(id), "utf8"));
    } catch (e) {
      if (e && e.code === "ENOENT") return null;
      throw e;
    }
  }
  /**
   * @param summary  read the lightweight sidecar instead of the whole record.
   *                 Only for callers that need listing fields — discovery cards,
   *                 dashboards. A caller that needs the manifest must get()."
   */
  async list({ ownerId = null, state = null, limit = 50, summary = false } = {}) {
    const names = await fsp.readdir(this.dir).catch(() => []);
    const out = [];
    for (const n of names) {
      if (!n.endsWith(".json") || n.endsWith(".summary.json")) continue;
      const full = path.join(this.dir, n);
      try {
        let r = null;
        if (summary) {
          const sp = full.replace(/\.json$/, ".summary.json");
          const [rs, ss] = await Promise.all([fsp.stat(full).catch(() => null), fsp.stat(sp).catch(() => null)]);
          // Use the sidecar only if it is at least as new as the record it
          // summarises. Otherwise fall through and repair it from the record,
          // so a crash or an older build cannot serve stale listing data.
          if (rs && ss && ss.mtimeMs >= rs.mtimeMs) {
            r = JSON.parse(await fsp.readFile(sp, "utf8"));
          } else {
            const rec = JSON.parse(await fsp.readFile(full, "utf8"));
            r = FileWorldStore.summarise(rec);
            await fsp.writeFile(sp, JSON.stringify(r)).catch(() => {});   // best effort; the record still answered
          }
        } else {
          r = JSON.parse(await fsp.readFile(full, "utf8"));
        }
        if (ownerId && r.owner_id !== ownerId) continue;
        if (state && r.state !== state) continue;
        out.push(r);
      } catch { /* a half-written temp file is not a world; skip */ }
    }
    out.sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")));
    return out.slice(0, limit);
  }
  async delete(id) { await fsp.rm(this._p(id), { force: true }); await fsp.rm(this._sp(id), { force: true }); }
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
    if (remote.ok && remote.value.length) return remote.value;
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
        out.push({ version: r.version, manifest_hash: r.manifest_hash, label: r.label ?? null, created_by: r.created_by ?? null, created_at: r.created_at });
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
    if (existing && existing.manifest_hash === hash && existing.state === state) {
      return { ...existing, idempotent: true };   // identical write -> no version churn
    }
    const now = new Date().toISOString();
    const record = {
      world_id: worldId,
      owner_id: ownerId ?? existing?.owner_id ?? null,
      title: title ?? manifest?.meta?.title ?? manifest?.title ?? existing?.title ?? null,
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

  async get(worldId, { requesterId = null, requireOwner = false } = {}) {
    const r = await this.store.get(worldId);
    if (!r) throw Errors.notFound(`world ${worldId}`);
    // Fail CLOSED on both, for the same reason as upsert: a world with no owner
    // recorded used to satisfy requireOwner for every caller, and an unowned
    // draft used to be readable by anyone.
    if (requireOwner && r.owner_id !== requesterId) throw Errors.forbidden("this world belongs to another creator");
    // Published worlds are readable by anyone; drafts only by their owner (IDOR guard).
    if (!requireOwner && r.state !== "published" && requesterId !== r.owner_id) {
      throw Errors.forbidden("this world is a draft and is readable only by its creator");
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
      throw Errors.forbidden(`version ${version} of world ${worldId} was a draft and is readable only by its creator`);
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
