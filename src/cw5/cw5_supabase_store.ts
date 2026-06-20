// CW5 Persistence — Supabase-backed store (RUNBOOK §4 durability swap)
//
// Implements the SAME PersistenceStore interface as InMemoryPersistenceStore, so
// the engine/merge wiring is unchanged — only the store is swapped. Talks to
// Supabase via its PostgREST HTTP API (no new npm deps; uses global fetch, Node 18+).
//
// Tables (see dcsgames_002_persistence.sql):
//   dcsgames_base_worlds  (world_id PK, base jsonb, created_at)        — immutable base
//   dcsgames_world_deltas (world_id, seq, session_id, ts, actor_id, ops jsonb,
//                          PRIMARY KEY (world_id, seq))                — append-only
//   dcsgames_world_snapshots (world_id PK, as_of_seq, snapshot jsonb, ts) — latest compacted
//
// Durability contract preserved from the in-memory store:
//   - base immutable: insert once; a second insert for the same world_id is rejected.
//   - deltas append-only + idempotent on (world_id, seq): PK conflict → not applied.
//   - snapshot is last-writer-wins but never regresses as_of_seq.

import {
  SaveDelta,
  WorldSnapshot,
  BaseWorld,
} from './cw5_persistence_types.js';
import type { PersistenceStore } from './cw5_persistence.js';

export interface SupabaseConfig {
  url: string;             // https://<project>.supabase.co
  serviceRoleKey: string;  // server-side only
  fetchImpl?: typeof fetch; // injectable for tests
}

export class SupabasePersistenceStore implements PersistenceStore {
  private base: string;
  private key: string;
  private f: typeof fetch;

  constructor(cfg: SupabaseConfig) {
    if (!cfg.url || !cfg.serviceRoleKey) throw new Error('SupabasePersistenceStore: url + serviceRoleKey required');
    this.base = cfg.url.replace(/\/$/, '') + '/rest/v1';
    this.key = cfg.serviceRoleKey;
    this.f = cfg.fetchImpl ?? fetch;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      apikey: this.key,
      Authorization: `Bearer ${this.key}`,
      'Content-Type': 'application/json',
      ...extra,
    };
  }

  private async req(path: string, init: RequestInit): Promise<Response> {
    const res = await this.f(`${this.base}${path}`, { ...init, headers: { ...this.headers(), ...(init.headers as any) } });
    return res;
  }

  // ---- base world (immutable) ----

  async putBaseWorld(base: BaseWorld): Promise<void> {
    // Insert-only. If the row exists, PostgREST returns 409 on PK conflict → treat as
    // immutability violation, matching InMemory's throw.
    const res = await this.req('/dcsgames_base_worlds', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ world_id: base.world_id, base }),
    });
    if (await isDuplicateKey(res)) {
      throw new Error(`Base world ${base.world_id} is immutable; cannot overwrite`);
    }
    if (!res.ok) throw new Error(`putBaseWorld failed: ${res.status} ${await safeText(res)}`);
  }

  async getBaseWorld(worldId: string): Promise<BaseWorld | null> {
    const res = await this.req(`/dcsgames_base_worlds?world_id=eq.${enc(worldId)}&select=base`, { method: 'GET' });
    if (!res.ok) throw new Error(`getBaseWorld failed: ${res.status}`);
    const rows = (await res.json()) as Array<{ base: BaseWorld }>;
    return rows.length ? rows[0].base : null;
  }

  // ---- deltas (append-only, idempotent on (world_id, seq)) ----

  async appendDelta(delta: SaveDelta): Promise<{ applied: boolean }> {
    const res = await this.req('/dcsgames_world_deltas', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        world_id: delta.world_id,
        seq: delta.seq,
        session_id: delta.session_id,
        ts: delta.ts,
        actor_id: delta.actor_id ?? null,
        ops: delta.ops,
      }),
    });
    if (await isDuplicateKey(res)) return { applied: false }; // PK (world_id, seq) conflict → idempotent
    if (!res.ok) throw new Error(`appendDelta failed: ${res.status} ${await safeText(res)}`);
    return { applied: true };
  }

  async getDeltas(worldId: string, afterSeq = -Infinity): Promise<SaveDelta[]> {
    const gt = Number.isFinite(afterSeq) ? `&seq=gt.${afterSeq}` : '';
    // PostgREST caps a single response at a default max (commonly 1000 rows). A
    // busy world can have more deltas than that between snapshots, so a single GET
    // would SILENTLY TRUNCATE the tail and lose state on reload. Paginate with the
    // Range header until a short page proves we've reached the end.
    const PAGE = 1000;
    const out: SaveDelta[] = [];
    let offset = 0;
    for (;;) {
      const res = await this.req(
        `/dcsgames_world_deltas?world_id=eq.${enc(worldId)}${gt}&order=seq.asc&select=world_id,seq,session_id,ts,actor_id,ops`,
        { method: 'GET', headers: { Range: `${offset}-${offset + PAGE - 1}`, 'Range-Unit': 'items' } }
      );
      if (!res.ok && res.status !== 206) throw new Error(`getDeltas failed: ${res.status}`);
      const page = (await res.json()) as SaveDelta[];
      out.push(...page);
      if (page.length < PAGE) break; // last (short) page → done
      offset += PAGE;
    }
    return out;
  }

  async getMaxSeq(worldId: string): Promise<number> {
    const res = await this.req(
      `/dcsgames_world_deltas?world_id=eq.${enc(worldId)}&order=seq.desc&limit=1&select=seq`,
      { method: 'GET' }
    );
    if (!res.ok) throw new Error(`getMaxSeq failed: ${res.status}`);
    const rows = (await res.json()) as Array<{ seq: number }>;
    return rows.length ? rows[0].seq : 0;
  }

  async hasSeq(worldId: string, seq: number): Promise<boolean> {
    const res = await this.req(
      `/dcsgames_world_deltas?world_id=eq.${enc(worldId)}&seq=eq.${seq}&select=seq&limit=1`,
      { method: 'GET' }
    );
    if (!res.ok) throw new Error(`hasSeq failed: ${res.status}`);
    const rows = (await res.json()) as unknown[];
    return rows.length > 0;
  }

  // ---- snapshot (latest; never regresses) ----

  async putSnapshot(snap: WorldSnapshot): Promise<void> {
    // Upsert on world_id; guard against regressing as_of_seq is enforced here
    // (read current, skip if newer exists) to match InMemory semantics.
    const current = await this.getLatestSnapshot(snap.world_id);
    if (current && current.as_of_seq >= snap.as_of_seq) return;
    const res = await this.req('/dcsgames_world_snapshots', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ world_id: snap.world_id, as_of_seq: snap.as_of_seq, snapshot: snap, ts: snap.ts }),
    });
    if (!res.ok) throw new Error(`putSnapshot failed: ${res.status} ${await safeText(res)}`);
  }

  async getLatestSnapshot(worldId: string): Promise<WorldSnapshot | null> {
    const res = await this.req(
      `/dcsgames_world_snapshots?world_id=eq.${enc(worldId)}&select=snapshot`,
      { method: 'GET' }
    );
    if (!res.ok) throw new Error(`getLatestSnapshot failed: ${res.status}`);
    const rows = (await res.json()) as Array<{ snapshot: WorldSnapshot }>;
    return rows.length ? rows[0].snapshot : null;
  }
}


// Robust duplicate-key detection: PostgREST returns 409 for a PK conflict, but
// some versions/configs surface Postgres error 23505 with a 400/409 + a JSON body
// carrying { code: "23505" }. Live backends have bitten lanes with exactly this
// kind of status-vs-body mismatch, so we check both rather than status alone.
async function isDuplicateKey(res: Response): Promise<boolean> {
  if (res.status === 409) return true;
  if (res.status === 400 || res.status === 422) {
    try {
      const body = (await res.clone().json()) as { code?: string; message?: string };
      if (body && (body.code === '23505' || String(body.message || '').includes('duplicate key'))) return true;
    } catch { /* not json */ }
  }
  return false;
}

function enc(s: string): string {
  return encodeURIComponent(s);
}
async function safeText(res: Response): Promise<string> {
  try { return await res.text(); } catch { return ''; }
}
