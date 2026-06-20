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

  /** POST /worlds/:id/save — accept a delta → { ok, seq }. Append-only, idempotent, monotonic. */
  async save(delta: SaveDelta): Promise<SaveAccepted> {
    if (!delta.world_id || delta.seq == null) throw new Error('save: world_id and seq required');

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
