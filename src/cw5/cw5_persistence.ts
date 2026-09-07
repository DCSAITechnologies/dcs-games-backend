// CW5 Persistence — Core Engine
//
// Implements C3 (canonical): append-only delta store + snapshot writer + load merge.
// Reconciled to _SHARED_Day0/contracts/save-delta.schema.json + C1 world.json +
// the C4 /load response shape from mock-server.mjs.
//
// North star: whatever players build today exists tomorrow. Reload = base world
// + saved state, byte-stable.
//
// M-P0 acceptance: apply 50 synthetic deltas → load == replay-on-base; reload
// after restart is byte-stable. (DoD in CW5 brief.)

import fs from 'node:fs';
import path from 'node:path';
import {
  SaveDelta,
  WorldSnapshot,
  WorldObject,
  BaseWorld,
  LoadResult,
  Op,
  SaveAccepted,
  InventoryItem,
} from './cw5_persistence_types.js';

// ============================================================================
// STORE INTERFACE (in-memory now → dcsgames_* tables later)
// ============================================================================

export interface PersistenceStore {
  appendDelta(delta: SaveDelta): Promise<{ applied: boolean }>;
  getDeltas(worldId: string, afterSeq?: number): Promise<SaveDelta[]>;
  getMaxSeq(worldId: string): Promise<number>;
  hasSeq(worldId: string, seq: number): Promise<boolean>;
  putSnapshot(snap: WorldSnapshot): Promise<void>;
  getLatestSnapshot(worldId: string): Promise<WorldSnapshot | null>;
  putBaseWorld(base: BaseWorld): Promise<void>;
  getBaseWorld(worldId: string): Promise<BaseWorld | null>;
}

// ============================================================================
// FILE STORE — durable without a database
// ============================================================================

/**
 * Runtime deltas on disk, for every deployment that has no Supabase.
 *
 * Until this existed, a deployment without Supabase used InMemoryPersistenceStore
 * — a Map. An object saved and acknowledged `ok:true` was gone at the next
 * restart; `seq 1` was then accepted again as a fresh delta; and the engine's
 * append-only, monotonic and idempotent guarantees held only as long as the
 * process did. That is every local run, every CI run, and any deploy that loses
 * its Supabase variables — so the suites that assert those guarantees were
 * asserting them against a store that could not keep them.
 *
 * Append-only on disk, one JSON-lines file per world. A partially written final
 * line is DISCARDED on read rather than throwing: a delta that never finished
 * being written was never acknowledged, and refusing to open the world because
 * of it would turn a torn write into permanent data loss.
 */
export class FilePersistenceStore implements PersistenceStore {
  private dir: string;
  constructor(dir: string) {
    this.dir = dir;
    fs.mkdirSync(this.dir, { recursive: true });
  }

  private safe(worldId: string): string {
    // World ids may legally contain dots; they must never contain a separator.
    return String(worldId).replace(/[^A-Za-z0-9._-]/g, "_");
  }
  private deltaFile(worldId: string) { return path.join(this.dir, this.safe(worldId) + ".deltas.jsonl"); }
  private baseFile(worldId: string) { return path.join(this.dir, this.safe(worldId) + ".base.json"); }
  private snapFile(worldId: string) { return path.join(this.dir, this.safe(worldId) + ".snapshot.json"); }

  private readJson<T>(file: string): T | null {
    try { return JSON.parse(fs.readFileSync(file, "utf8")) as T; } catch { return null; }
  }
  private writeJsonAtomic(file: string, value: unknown) {
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(value));
    fs.renameSync(tmp, file);       // atomic: a reader sees the old file or the new one
  }

  private readDeltas(worldId: string): SaveDelta[] {
    let raw: string;
    try { raw = fs.readFileSync(this.deltaFile(worldId), "utf8"); } catch { return []; }
    const out: SaveDelta[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* torn final line: never acknowledged */ }
    }
    return out;
  }

  async appendDelta(delta: SaveDelta) {
    const existing = this.readDeltas(delta.world_id);
    if (existing.some((d) => d.seq === delta.seq)) return { applied: false };
    fs.appendFileSync(this.deltaFile(delta.world_id), JSON.stringify(delta) + "\n");
    return { applied: true };
  }
  async getDeltas(worldId: string, afterSeq = 0) {
    return this.readDeltas(worldId).filter((d) => d.seq > afterSeq).sort((a, b) => a.seq - b.seq);
  }
  async getMaxSeq(worldId: string) {
    return this.readDeltas(worldId).reduce((m, d) => Math.max(m, d.seq), 0);
  }
  async hasSeq(worldId: string, seq: number) {
    return this.readDeltas(worldId).some((d) => d.seq === seq);
  }
  async putSnapshot(snap: WorldSnapshot) { this.writeJsonAtomic(this.snapFile(snap.world_id), snap); }
  async getLatestSnapshot(worldId: string) { return this.readJson<WorldSnapshot>(this.snapFile(worldId)); }
  async putBaseWorld(base: BaseWorld) {
    // Same contract as the in-memory store, INCLUDING the refusal.
    //
    // This returned silently on a second write while InMemoryPersistenceStore
    // throws under a BASE IMMUTABILITY GUARD — so the same caller bug was a 500
    // in one deployment and invisible in another, and the comment claiming a
    // shared contract told the next reader not to check. The data was safe
    // either way; the divergence was the defect.
    if (fs.existsSync(this.baseFile(base.world_id))) {
      throw new Error(`putBaseWorld: base world ${base.world_id} already exists and is immutable`);
    }
    this.writeJsonAtomic(this.baseFile(base.world_id), base);
  }
  async getBaseWorld(worldId: string) { return this.readJson<BaseWorld>(this.baseFile(worldId)); }
}

// ============================================================================
// IN-MEMORY STORE (synthetic / tests)
// ============================================================================

export class InMemoryPersistenceStore implements PersistenceStore {
  private deltas = new Map<string, SaveDelta[]>();
  private seqSeen = new Map<string, Set<number>>();
  private snapshots = new Map<string, WorldSnapshot>();
  private baseWorlds = new Map<string, BaseWorld>();

  async appendDelta(delta: SaveDelta) {
    const seen = this.seqSeen.get(delta.world_id) ?? new Set<number>();
    if (seen.has(delta.seq)) return { applied: false };
    seen.add(delta.seq);
    this.seqSeen.set(delta.world_id, seen);

    const list = this.deltas.get(delta.world_id) ?? [];
    list.push(delta);
    list.sort((a, b) => a.seq - b.seq);
    this.deltas.set(delta.world_id, list);
    return { applied: true };
  }

  async getDeltas(worldId: string, afterSeq = -Infinity) {
    return (this.deltas.get(worldId) ?? []).filter((d) => d.seq > afterSeq);
  }
  async getMaxSeq(worldId: string) {
    const list = this.deltas.get(worldId) ?? [];
    return list.length ? list[list.length - 1].seq : 0;
  }
  async hasSeq(worldId: string, seq: number) {
    return this.seqSeen.get(worldId)?.has(seq) ?? false;
  }
  async putSnapshot(snap: WorldSnapshot) {
    const existing = this.snapshots.get(snap.world_id);
    if (existing && existing.as_of_seq >= snap.as_of_seq) return;
    this.snapshots.set(snap.world_id, snap);
  }
  async getLatestSnapshot(worldId: string) {
    return this.snapshots.get(worldId) ?? null;
  }
  async putBaseWorld(base: BaseWorld) {
    // BASE IMMUTABILITY GUARD: base is Atlas-signed; never overwrite once set.
    if (this.baseWorlds.has(base.world_id)) {
      throw new Error(`Base world ${base.world_id} is immutable; cannot overwrite`);
    }
    this.baseWorlds.set(base.world_id, structuredClone(base));
  }
  async getBaseWorld(worldId: string) {
    const b = this.baseWorlds.get(worldId);
    return b ? structuredClone(b) : null;
  }

  reset() {
    this.deltas.clear();
    this.seqSeen.clear();
    this.snapshots.clear();
    this.baseWorlds.clear();
  }
}

// ============================================================================
// MATERIALIZED STATE (mutable working copy during merge/replay)
// ============================================================================

interface MaterializedState {
  objects: Map<string, WorldObject>;
  inventories: Record<string, InventoryItem[]>;
  npc_states: Record<string, Record<string, unknown>>;
  economy: Record<string, unknown>;
  vars: Record<string, unknown>;
}

function emptyState(): MaterializedState {
  return { objects: new Map(), inventories: {}, npc_states: {}, economy: {}, vars: {} };
}

function stateFromBase(base: BaseWorld): MaterializedState {
  const s = emptyState();
  for (const o of base.objects ?? []) s.objects.set(o.object_id, structuredClone(o));
  // base world.json carries no saved inventories/npc_states/economy/vars;
  // those accrue via deltas. (npcs[] in base are spawn defs, not runtime state.)
  return s;
}

function stateFromSnapshot(snap: WorldSnapshot): MaterializedState {
  const s = emptyState();
  for (const o of snap.objects) s.objects.set(o.object_id, structuredClone(o));
  s.inventories = structuredClone(snap.inventories);
  s.npc_states = structuredClone(snap.npc_states);
  s.economy = structuredClone(snap.economy);
  s.vars = structuredClone(snap.vars);
  return s;
}

// ============================================================================
// OP APPLICATION (canonical C3 op semantics — flat fields)
// ============================================================================
// Deterministic, in-order. This is the function reconciled to save-delta.schema.json.

function applyOp(state: MaterializedState, op: Op): void {
  switch (op.op) {
    case 'place_object': {
      if (!op.object_id) throw new Error('place_object requires object_id');
      const obj: WorldObject = {
        object_id: op.object_id,
        kind: op.kind ?? 'unknown',
        transform: structuredClone(op.transform ?? {}),
        owner_id: op.owner_id ?? null,
      };
      if (typeof op.interactable === 'boolean') obj.interactable = op.interactable as boolean;
      state.objects.set(op.object_id, obj);
      break;
    }
    case 'move_object': {
      if (!op.object_id) throw new Error('move_object requires object_id');
      const existing = state.objects.get(op.object_id);
      if (existing) {
        existing.transform = { ...existing.transform, ...structuredClone(op.transform ?? {}) };
      } else {
        // move on an absent object → treat as a placement with the given transform
        state.objects.set(op.object_id, {
          object_id: op.object_id,
          kind: op.kind ?? 'unknown',
          transform: structuredClone(op.transform ?? {}),
          owner_id: op.owner_id ?? null,
        });
      }
      break;
    }
    case 'remove_object': {
      if (!op.object_id) throw new Error('remove_object requires object_id');
      state.objects.delete(op.object_id);
      break;
    }
    case 'set_inventory': {
      // owner is player_id (schema field); set-semantics replace the inventory.
      const owner = op.player_id;
      if (!owner) throw new Error('set_inventory requires player_id');
      state.inventories[owner] = structuredClone(op.inventory ?? []);
      break;
    }
    case 'npc_state': {
      if (!op.npc_id) throw new Error('npc_state requires npc_id');
      state.npc_states[op.npc_id] = structuredClone(op.state ?? {});
      break;
    }
    case 'economy': {
      // DARK until P5: merge payload for deterministic replay; moves no money.
      const { op: _op, ...payload } = op;
      state.economy = { ...state.economy, ...structuredClone(payload) };
      break;
    }
    case 'var_set': {
      if (!op.key) throw new Error('var_set requires key');
      state.vars[op.key] = structuredClone(op.value);
      break;
    }
    default: {
      const _never: never = op.op as never;
      throw new Error(`Unknown op type: ${String(_never)}`);
    }
  }
}

function materialize(base: BaseWorld, state: MaterializedState, asOfSeq: number, ts: string): WorldSnapshot {
  return {
    world_id: base.world_id,
    base_world_id: base.world_id,
    as_of_seq: asOfSeq,
    ts,
    objects: Array.from(state.objects.values()),
    inventories: state.inventories,
    npc_states: state.npc_states,
    economy: state.economy,
    vars: state.vars,
  };
}

// ============================================================================
// PERSISTENCE ENGINE
// ============================================================================

export class PersistenceEngine {
  constructor(private store: PersistenceStore, private now: () => string = () => new Date().toISOString()) {}

  async registerBaseWorld(base: BaseWorld): Promise<void> {
    await this.store.putBaseWorld(base);
  }

  /**
   * Every op that names a PERSON, and the field it names them in.
   *
   * A delta used to be applied exactly as sent: set_inventory carries its own
   * player_id and place_object its own owner_id, and neither was ever compared
   * with the caller. Any authenticated account could therefore write any other
   * player's inventory and hand itself — or anyone — ownership of any object in
   * any world. That is not only forgery of player property: livestate.mjs reads
   * precisely these two fields as the evidence that decides whether a rollback
   * may delete something, so a forged hold freezes a creator's world and a
   * stripped owner_id licenses a deletion.
   *
   * The binding lives HERE rather than in the route, so a future caller cannot
   * forget it.
   */
  static readonly ACTOR_BOUND_FIELDS: Record<string, string[]> = {
    set_inventory: ['player_id'],
    place_object: ['owner_id'],
    move_object: ['owner_id'],
  };

  /**
   * @param actorId  the authenticated principal this delta is attributed to.
   *                 Required: passing null means "nobody in particular", and a
   *                 delta from nobody in particular is exactly what this
   *                 refuses. An op may leave an actor-bound field null (an
   *                 unowned object), but it may never name someone else.
   */
  /** Every op kind this engine can actually apply. */
  static readonly KNOWN_OPS = ['place_object', 'move_object', 'remove_object', 'set_inventory', 'npc_state', 'var_set', 'economy'];

  /** Ops that act on an object that may ALREADY belong to someone. */
  static readonly OBJECT_OPS = ['place_object', 'move_object', 'remove_object'];

  /**
   * @param actorId  the authenticated principal this delta is attributed to.
   * @param owned    object_id -> current owner_id, from the world as it stands.
   *
   * The first version of this check only read the OP's own fields, which left
   * three ways to act on someone else's property:
   *   - `place_object` REPLACES an object wholesale, so re-placing a victim's
   *     house with `owner_id: null` stripped their ownership — the exact
   *     "stripped owner_id licenses a deletion" outcome this check exists to
   *     stop, permitted by the check itself.
   *   - `remove_object` carries no person field at all, so it was unbound and
   *     deleted another player's object outright.
   *   - `move_object` omitting `owner_id` relocated anyone's object.
   * The person is on the STORED OBJECT, not on the op, so the current owner has
   * to be looked at. An unowned object stays free for anyone to shape.
   */
  private assertActorBound(delta: SaveDelta, actorId: string | null, owned: Map<string, string | null>): void {
    if (!actorId) throw new Error('save: an actor is required; a delta cannot be applied on nobody\'s behalf');
    for (const op of (delta as any).ops || []) {
      if (!op || typeof op !== 'object') throw new Error('save: every op must be an object');
      const kind = (op as any).op;

      // An unknown kind used to be appended to an APPEND-ONLY store and then
      // throw on every subsequent load — silently and permanently bricking the
      // world, acknowledged with ok:true. Refused before it is written.
      if (!PersistenceEngine.KNOWN_OPS.includes(kind)) {
        throw new Error(`save: unknown op '${String(kind)}' — this world would be unloadable if it were stored`);
      }

      // Own-property lookup: `op.op === "constructor"` used to return the Object
      // constructor from the prototype chain, so `|| []` never fired and the
      // loop threw "fields is not iterable" as a 500 blamed on us.
      const fields = Object.prototype.hasOwnProperty.call(PersistenceEngine.ACTOR_BOUND_FIELDS, kind)
        ? PersistenceEngine.ACTOR_BOUND_FIELDS[kind] : [];
      for (const f of fields) {
        const v = (op as any)[f];
        if (v != null && String(v) !== String(actorId)) {
          throw new Error(`save: op '${kind}' sets ${f}='${v}' but the caller is '${actorId}' — a delta may not act on another player's behalf`);
        }
      }

      if (PersistenceEngine.OBJECT_OPS.includes(kind)) {
        const id = (op as any).object_id;
        const currentOwner = id != null ? owned.get(String(id)) : undefined;
        if (currentOwner != null && String(currentOwner) !== String(actorId)) {
          throw new Error(`save: op '${kind}' acts on object '${id}', which belongs to '${currentOwner}', not to '${actorId}'`);
        }
      }
    }
  }

  /** POST /worlds/:id/save — accept a delta → { ok, seq }. Append-only, idempotent, monotonic. */
  async save(delta: SaveDelta, opts: { actorId?: string | null } = {}): Promise<SaveAccepted> {
    if (!delta.world_id || delta.seq == null) throw new Error('save: world_id and seq required');
    // `seq` is validated the way the ops are, and for the same reason.
    //
    // `seq: "not-a-number"` passed the null check, compared as NaN against the
    // max (so the monotonicity guard let it through), was APPENDED to an
    // append-only store, and was then filtered back out of every replay by
    // `d.seq > afterSeq`. The caller got ok:true and its ops were applied to
    // nothing, permanently — which is exactly the property the op validation
    // exists to guarantee, one field along. `seq: Infinity` is the same shape
    // and additionally locks every future save behind an unreachable maximum.
    if (typeof delta.seq !== 'number' || !Number.isSafeInteger(delta.seq) || delta.seq < 1) {
      throw new Error(
        `save: seq must be a positive integer, got ${JSON.stringify(delta.seq)}. ` +
        `A delta the store accepts but replay skips is silently lost, and this store cannot forget it.`
      );
    }
    // Who owns what RIGHT NOW. Read before anything is appended, because the
    // person a delta may not act on is recorded on the object, not on the op.
    const owned = new Map<string, string | null>();
    try {
      const snap: any = await this.load(delta.world_id);
      for (const o of (snap?.snapshot?.objects || snap?.objects || [])) owned.set(String(o.object_id), o.owner_id ?? null);
    } catch (e: any) {
      // ONLY "there is no such world yet" means nothing is owned. Every other
      // failure means ownership could not be DETERMINED, and an empty map then
      // silently permits every op — the ownership check disappears rather than
      // refusing.
      //
      // That was reachable in two requests: store one malformed op (a var_set
      // with no key was accepted on the way in), and load() throws on replay
      // from then on, permanently, for that world. The second request could
      // then act on anybody's objects.
      const message = String(e?.message || e);
      if (!/base world .* not found/i.test(message)) {
        throw new Error(
          `save: refusing because the world's current ownership could not be read (${message}). ` +
          `Acting without it would mean applying ops with the ownership check silently disabled.`
        );
      }
      /* no base world yet: nothing is owned, so nothing can be taken */
    }
    this.assertActorBound(delta, opts.actorId ?? null, owned);

    // Validate every op BEFORE it is stored. An op that throws on replay bricks
    // load() for that world forever, and the store is append-only, so there is
    // no way to take it back out. applyOp against a throwaway state is the same
    // check replay will perform, which is the point: nothing can be accepted
    // that replay will later refuse.
    for (const op of delta.ops || []) {
      try {
        applyOp(emptyState(), op as Op);
      } catch (e: any) {
        throw new Error(`save: op '${(op as any).op}' is not valid and would make this world unreadable: ${String(e?.message || e)}`);
      }
    }

    if (await this.store.hasSeq(delta.world_id, delta.seq)) {
      return { ok: true, seq: delta.seq, duplicate: true };
    }
    const maxSeq = await this.store.getMaxSeq(delta.world_id);
    if (delta.seq <= maxSeq) {
      throw new Error(`save: non-monotonic seq ${delta.seq} (max applied ${maxSeq}) for world ${delta.world_id}`);
    }
    const { applied } = await this.store.appendDelta(delta);
    return { ok: true, seq: delta.seq, duplicate: !applied };
  }

  /** GET /worlds/:id/load — base + latest snapshot + tail deltas, as a WorldSnapshot. */
  async load(worldId: string): Promise<LoadResult> {
    const base = await this.store.getBaseWorld(worldId);
    if (!base) throw new Error(`load: base world ${worldId} not found`);

    const snap = await this.store.getLatestSnapshot(worldId);
    const state = snap ? stateFromSnapshot(snap) : stateFromBase(base);
    const fromSeq = snap ? snap.as_of_seq : -Infinity;

    const tail = await this.store.getDeltas(worldId, fromSeq);
    tail.sort((a, b) => a.seq - b.seq);
    for (const d of tail) for (const op of d.ops) applyOp(state, op);

    const asOf = await this.store.getMaxSeq(worldId);
    return materialize(base, state, asOf, this.now());
  }

  /** Write a snapshot = compact all deltas onto the base world. */
  async writeSnapshot(worldId: string): Promise<WorldSnapshot> {
    const base = await this.store.getBaseWorld(worldId);
    if (!base) throw new Error(`writeSnapshot: base world ${worldId} not found`);

    const state = stateFromBase(base);
    const deltas = await this.store.getDeltas(worldId);
    deltas.sort((a, b) => a.seq - b.seq);
    for (const d of deltas) for (const op of d.ops) applyOp(state, op);

    const asOf = deltas.length ? deltas[deltas.length - 1].seq : 0;
    const snapshot = materialize(base, state, asOf, this.now());
    await this.store.putSnapshot(snapshot);
    return snapshot;
  }

  /** Pure replay-on-base (no snapshot) — used by the M-P0 gate. */
  async replayOnBase(worldId: string): Promise<LoadResult> {
    const base = await this.store.getBaseWorld(worldId);
    if (!base) throw new Error(`replayOnBase: base world ${worldId} not found`);

    const state = stateFromBase(base);
    const deltas = await this.store.getDeltas(worldId);
    deltas.sort((a, b) => a.seq - b.seq);
    for (const d of deltas) for (const op of d.ops) applyOp(state, op);

    const asOf = deltas.length ? deltas[deltas.length - 1].seq : 0;
    return materialize(base, state, asOf, this.now());
  }
}
