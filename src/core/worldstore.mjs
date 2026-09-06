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
  async put(record) {
    const p = this._p(record.world_id);
    const tmp = p + ".tmp-" + crypto.randomBytes(4).toString("hex");
    await fsp.writeFile(tmp, JSON.stringify(record));
    await fsp.rename(tmp, p);          // atomic on POSIX
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
  async list({ ownerId = null, state = null, limit = 50 } = {}) {
    const names = await fsp.readdir(this.dir).catch(() => []);
    const out = [];
    for (const n of names) {
      if (!n.endsWith(".json")) continue;
      try {
        const r = JSON.parse(await fsp.readFile(path.join(this.dir, n), "utf8"));
        if (ownerId && r.owner_id !== ownerId) continue;
        if (state && r.state !== state) continue;
        out.push(r);
      } catch { /* a half-written temp file is not a world; skip */ }
    }
    out.sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")));
    return out.slice(0, limit);
  }
  async delete(id) { await fsp.rm(this._p(id), { force: true }); }
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

/** The repository the router talks to. Owns ownership rules and the record shape. */
export class WorldRepository {
  constructor(store) { this.store = store; }
  get kind() { return this.store.kind; }

  /**
   * Idempotent create-or-update. Re-running with the same manifest is a no-op
   * that returns the same hash, so a retried request cannot fork a world.
   */
  async upsert({ worldId, ownerId, manifest, state = "draft", title = null, expected_version = null }) {
    if (!worldId) throw Errors.validation("world_id is required");
    if (!manifest || typeof manifest !== "object") throw Errors.validation("manifest must be an object");
    const existing = await this.store.get(worldId);
    if (existing && ownerId && existing.owner_id && existing.owner_id !== ownerId) {
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
    return { ...record, ...(saved && saved._mirrored === false ? { _mirrored: false, _mirror_error: saved._mirror_error } : {}), idempotent: false };
  }

  async get(worldId, { requesterId = null, requireOwner = false } = {}) {
    const r = await this.store.get(worldId);
    if (!r) throw Errors.notFound(`world ${worldId}`);
    if (requireOwner && r.owner_id && r.owner_id !== requesterId) throw Errors.forbidden("this world belongs to another creator");
    // Published worlds are readable by anyone; drafts only by their owner (IDOR guard).
    if (!requireOwner && r.state !== "published" && r.owner_id && requesterId !== r.owner_id) {
      throw Errors.forbidden("this world is a draft and is readable only by its creator");
    }
    return r;
  }
  async listOwned(ownerId, limit = 50) {
    if (!ownerId) throw Errors.validation("owner is required");
    return await this.store.list({ ownerId, limit });
  }
  async listPublished(limit = 50) { return await this.store.list({ state: "published", limit }); }
}

export function createWorldRepository(env = process.env) {
  const url = (env.SUPABASE_URL || "").replace(/\/$/, "");
  const key = env.SUPABASE_SERVICE_ROLE_KEY || "";
  const file = new FileWorldStore(env.DCS_DATA_DIR ? path.join(env.DCS_DATA_DIR, "worlds") : undefined);
  if (url && key) return new WorldRepository(new MirroredWorldStore(new SupabaseWorldStore({ url, serviceRoleKey: key }), file));
  return new WorldRepository(file);
}
