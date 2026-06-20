// CW5 Persistence — P9 Persistent-Civilization State at Scale (continuous worlds)
//
// Spec: "[P9] persistent-civilization state at scale (continuous worlds)."
// Built ON the verified P0 engine (cw5_persistence.ts) + canonical C3 deltas.
//
// THE SCALING PROBLEM (why P0's model isn't enough on its own for continuous worlds):
//   P0 load = base + snapshot + replay-tail. For a continuous, always-on civilization
//   world, two things break at scale:
//     1. The delta log grows without bound → replay cost grows without bound.
//     2. The world is too large to materialize whole → you can't load it all per player.
//
// P9 solves both WITHOUT changing C3 (deltas stay canonical):
//   A. REGION PARTITIONING — deltas are routed to a region by their spatial op
//      (transform x/z → region cell). Load/snapshot operate per-region, so a player
//      materializes only the regions near them, in bounded memory.
//   B. SNAPSHOT CADENCE — per region, once the tail since last snapshot exceeds a
//      threshold, compact automatically. Replay cost per load stays bounded by the
//      threshold, not by total world history.
//   C. ACTIVE-SET LOAD — load N regions (a player's neighborhood) as one merged view.
//
// Region assignment is deterministic from the op's transform; ops without a spatial
// component (var_set/economy/npc_state without a position) go to a WORLD region
// (region key "__world__") that every active-set load includes.

import {
  SaveDelta,
  WorldSnapshot,
  WorldObject,
  BaseWorld,
  Op,
  InventoryItem,
} from './cw5_persistence_types.js';
import { PersistenceEngine, InMemoryPersistenceStore, PersistenceStore } from './cw5_persistence.js';

// ============================================================================
// REGION MODEL
// ============================================================================

export const WORLD_REGION = '__world__'; // non-spatial state (vars, economy, global npcs)

export interface RegionConfig {
  cellSize: number;          // world units per region cell edge (e.g. 64)
  snapshotEveryNDeltas: number; // compact a region after this many tail deltas
}

const DEFAULT_REGION_CONFIG: RegionConfig = { cellSize: 64, snapshotEveryNDeltas: 100 };

/** Deterministic region key from a transform; null when the op has no position. */
export function regionForTransform(t: { x?: number; z?: number } | undefined, cellSize: number): string | null {
  if (!t || typeof t.x !== 'number' || typeof t.z !== 'number') return null;
  const cx = Math.floor(t.x / cellSize);
  const cz = Math.floor(t.z / cellSize);
  return `r_${cx}_${cz}`;
}

/** Which region does a single op belong to? Spatial ops → cell; others → WORLD_REGION. */
export function regionForOp(op: Op, cellSize: number): string {
  switch (op.op) {
    case 'place_object':
    case 'move_object':
      return regionForTransform(op.transform, cellSize) ?? WORLD_REGION;
    case 'remove_object':
      // remove carries no transform; routed by object_id ownership map (see splitter).
      return WORLD_REGION; // resolved/overridden by the splitter when the object's region is known
    case 'set_inventory':
    case 'npc_state':
    case 'var_set':
    case 'economy':
    default:
      return WORLD_REGION;
  }
}

// ============================================================================
// CIVILIZATION ENGINE (region-partitioned, on top of the P0 engine)
// ============================================================================
//
// Internally, each region is its own "world" inside a PersistenceEngine, keyed
// `${world_id}::${region}`. The base world is split into per-region base worlds at
// registration. This reuses the verified P0 store/merge/snapshot machinery wholesale.

export class CivilizationEngine {
  private engine: PersistenceEngine;
  private cfg: RegionConfig;
  private objectRegion = new Map<string, string>(); // world_id::object_id -> region (for remove routing)
  private regionSeq = new Map<string, number>();     // region engine-key -> last seq
  private regionTailSinceSnap = new Map<string, number>(); // region engine-key -> deltas since snapshot
  private knownRegions = new Map<string, Set<string>>(); // world_id -> set of region keys seen
  private now: () => string;

  constructor(store: PersistenceStore = new InMemoryPersistenceStore(), cfg: Partial<RegionConfig> = {}, now: () => string = () => new Date().toISOString()) {
    this.cfg = { ...DEFAULT_REGION_CONFIG, ...cfg };
    this.now = now;
    this.engine = new PersistenceEngine(store, now);
  }

  private ek(worldId: string, region: string): string {
    return `${worldId}::${region}`;
  }

  private trackRegion(worldId: string, region: string) {
    const set = this.knownRegions.get(worldId) ?? new Set<string>();
    set.add(region);
    this.knownRegions.set(worldId, set);
  }

  /**
   * Register the base world, partitioned into per-region base worlds.
   * Base objects are placed into their spatial region; the WORLD region holds a
   * base shell so non-spatial state has a home.
   */
  async registerBaseWorld(base: BaseWorld): Promise<void> {
    const byRegion = new Map<string, WorldObject[]>();
    for (const o of base.objects ?? []) {
      const region = regionForTransform(o.transform, this.cfg.cellSize) ?? WORLD_REGION;
      this.objectRegion.set(`${base.world_id}::${o.object_id}`, region);
      const arr = byRegion.get(region) ?? [];
      arr.push(o);
      byRegion.set(region, arr);
    }
    // Always have a WORLD region.
    if (!byRegion.has(WORLD_REGION)) byRegion.set(WORLD_REGION, []);

    for (const [region, objects] of byRegion) {
      const regionBase: BaseWorld = { world_id: this.ek(base.world_id, region), schema_version: base.schema_version, objects };
      await this.engine.registerBaseWorld(regionBase);
      this.trackRegion(base.world_id, region);
    }
  }

  /**
   * Save a delta: split its ops by region, write one sub-delta per affected region.
   * Each region maintains its own monotonic seq. Auto-snapshots a region when its
   * tail since the last snapshot crosses the configured threshold.
   */
  async save(delta: SaveDelta): Promise<{ ok: boolean; regions: string[]; seqByRegion: Record<string, number> }> {
    const opsByRegion = new Map<string, Op[]>();

    const pushOp = (region: string, op: Op) => {
      const arr = opsByRegion.get(region) ?? [];
      arr.push(op);
      opsByRegion.set(region, arr);
    };

    for (const op of delta.ops) {
      const objKey = op.object_id ? `${delta.world_id}::${op.object_id}` : null;

      if (op.op === 'remove_object' && objKey) {
        // route remove to the region the object currently lives in
        const region = this.objectRegion.get(objKey) ?? WORLD_REGION;
        pushOp(region, op);
        this.objectRegion.delete(objKey);
        continue;
      }

      if (op.op === 'place_object' && objKey) {
        const region = regionForTransform(op.transform, this.cfg.cellSize) ?? WORLD_REGION;
        this.objectRegion.set(objKey, region);
        pushOp(region, op);
        continue;
      }

      if (op.op === 'move_object' && objKey) {
        const prevRegion = this.objectRegion.get(objKey) ?? WORLD_REGION;
        const newRegion = regionForTransform(op.transform, this.cfg.cellSize) ?? prevRegion;
        if (newRegion !== prevRegion) {
          // CROSS-REGION MOVE: remove from old region, place into new region.
          // (A move is a transform change; across a boundary it must not leave a
          // ghost in the old region's replay.)
          pushOp(prevRegion, { op: 'remove_object', object_id: op.object_id });
          pushOp(newRegion, { op: 'place_object', object_id: op.object_id, kind: op.kind, transform: op.transform, owner_id: op.owner_id });
        } else {
          pushOp(newRegion, op);
        }
        this.objectRegion.set(objKey, newRegion);
        continue;
      }

      // non-spatial ops (set_inventory / npc_state / var_set / economy)
      pushOp(regionForOp(op, this.cfg.cellSize), op);
    }

    const seqByRegion: Record<string, number> = {};
    const regions: string[] = [];

    for (const [region, ops] of opsByRegion) {
      const key = this.ek(delta.world_id, region);

      // Lazily register an empty base for a region that has never been seen, so
      // its delta log has a base to replay onto. (Continuous worlds grow into new
      // regions at runtime; they aren't all in the original base partition.)
      if (!(this.knownRegions.get(delta.world_id)?.has(region))) {
        await this.engine.registerBaseWorld({ world_id: key, schema_version: '1.0', objects: [] });
        this.trackRegion(delta.world_id, region);
      }

      const nextSeq = (this.regionSeq.get(key) ?? 0) + 1;
      this.regionSeq.set(key, nextSeq);

      await this.engine.save({
        world_id: key,
        session_id: delta.session_id,
        seq: nextSeq,
        ts: delta.ts,
        actor_id: delta.actor_id ?? null,
        ops,
      });
      this.trackRegion(delta.world_id, region);
      regions.push(region);
      seqByRegion[region] = nextSeq;

      // auto-snapshot cadence
      const tail = (this.regionTailSinceSnap.get(key) ?? 0) + 1;
      if (tail >= this.cfg.snapshotEveryNDeltas) {
        await this.engine.writeSnapshot(key);
        this.regionTailSinceSnap.set(key, 0);
      } else {
        this.regionTailSinceSnap.set(key, tail);
      }
    }

    return { ok: true, regions, seqByRegion };
  }

  /** Load a single region as a WorldSnapshot (bounded memory). */
  async loadRegion(worldId: string, region: string): Promise<WorldSnapshot> {
    return this.engine.load(this.ek(worldId, region));
  }

  /**
   * Active-set load: merge the player's neighborhood regions + the WORLD region
   * into one snapshot. This is the bounded-memory "what the player sees" view —
   * the whole continuous world is never materialized at once.
   */
  async loadActiveSet(worldId: string, centerRegion: string, radius = 1): Promise<WorldSnapshot> {
    const regions = this.neighborhood(centerRegion, radius);
    regions.add(WORLD_REGION);

    const merged: WorldSnapshot = {
      world_id: worldId,
      base_world_id: worldId,
      as_of_seq: 0,
      ts: this.now(),
      objects: [],
      inventories: {},
      npc_states: {},
      economy: {},
      vars: {},
    };

    const known = this.knownRegions.get(worldId) ?? new Set<string>();
    for (const region of regions) {
      if (!known.has(region)) continue; // skip regions that were never registered/written
      const snap = await this.loadRegion(worldId, region);
      merged.objects.push(...snap.objects);
      Object.assign(merged.inventories, snap.inventories);
      Object.assign(merged.npc_states, snap.npc_states);
      Object.assign(merged.economy, snap.economy);
      Object.assign(merged.vars, snap.vars);
      merged.as_of_seq = Math.max(merged.as_of_seq, snap.as_of_seq);
    }
    return merged;
  }

  /** Region keys within `radius` cells of a center region (Chebyshev neighborhood). */
  neighborhood(centerRegion: string, radius: number): Set<string> {
    const out = new Set<string>();
    if (centerRegion === WORLD_REGION) {
      out.add(WORLD_REGION);
      return out;
    }
    const m = centerRegion.match(/^r_(-?\d+)_(-?\d+)$/);
    if (!m) {
      out.add(centerRegion);
      return out;
    }
    const cx = parseInt(m[1], 10);
    const cz = parseInt(m[2], 10);
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dz = -radius; dz <= radius; dz++) {
        out.add(`r_${cx + dx}_${cz + dz}`);
      }
    }
    return out;
  }

  /** Diagnostics: which regions exist for a world. */
  regionsOf(worldId: string): string[] {
    return Array.from(this.knownRegions.get(worldId) ?? []).sort();
  }

  /** Diagnostics: tail-since-snapshot for a region (replay-cost bound proof). */
  tailSinceSnapshot(worldId: string, region: string): number {
    return this.regionTailSinceSnap.get(this.ek(worldId, region)) ?? 0;
  }
}
