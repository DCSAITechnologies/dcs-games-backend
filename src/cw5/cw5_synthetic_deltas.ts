// CW5 Persistence — Synthetic Delta Harness (canonical C3 shapes)
//
// Generates contract-valid save-deltas (flat op fields, ISO ts) so CW5 builds
// without waiting on CW4. CW4 emits real deltas into the same store later.
// Deterministic by seed for byte-stable comparisons.

import { SaveDelta, Op, BaseWorld } from './cw5_persistence_types.js';

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SyntheticConfig {
  world_id: string;
  session_id?: string;
  actor_id?: string;
  count: number;
  seed?: number;
  opsPerDelta?: number;
  startSeq?: number;
}

/** Deterministic save-deltas exercising place/move/remove/set_inventory/var_set/npc_state. */
export function generateSyntheticDeltas(cfg: SyntheticConfig): SaveDelta[] {
  const rng = mulberry32(cfg.seed ?? 1);
  const opsPer = cfg.opsPerDelta ?? 1;
  const startSeq = cfg.startSeq ?? 1;
  const session = cfg.session_id ?? `sess_${cfg.world_id}`;
  const actor = cfg.actor_id ?? `actor_${cfg.world_id}`;
  const baseTs = Date.parse('2026-06-18T00:00:00Z');

  const placed: string[] = [];
  const deltas: SaveDelta[] = [];

  for (let i = 0; i < cfg.count; i++) {
    const ops: Op[] = [];
    for (let j = 0; j < opsPer; j++) {
      const roll = rng();
      if (placed.length === 0 || roll < 0.5) {
        const id = `obj_${i}_${j}`;
        placed.push(id);
        ops.push({
          op: 'place_object',
          object_id: id,
          kind: 'prop.crate',
          transform: { x: Math.floor(rng() * 32), y: 0, z: Math.floor(rng() * 32), rot: 0, scale: 1 },
          owner_id: null,
        });
      } else if (roll < 0.7) {
        const id = placed[Math.floor(rng() * placed.length)];
        ops.push({ op: 'move_object', object_id: id, transform: { x: Math.floor(rng() * 32), z: Math.floor(rng() * 32) } });
      } else if (roll < 0.8) {
        const idx = Math.floor(rng() * placed.length);
        const id = placed.splice(idx, 1)[0];
        ops.push({ op: 'remove_object', object_id: id });
      } else if (roll < 0.9) {
        ops.push({ op: 'set_inventory', player_id: actor, inventory: [{ item_id: 'it-plank', qty: Math.floor(rng() * 5) }] });
      } else if (roll < 0.97) {
        ops.push({ op: 'var_set', key: `flag_${i % 3}`, value: rng() > 0.5 });
      } else {
        ops.push({ op: 'npc_state', npc_id: `n-zombie-${i % 2}`, state: { mood: rng() > 0.5 ? 'hostile' : 'calm' } });
      }
    }

    deltas.push({
      world_id: cfg.world_id,
      session_id: session,
      seq: startSeq + i,
      ts: new Date(baseTs + i * 1000).toISOString(),
      actor_id: actor,
      ops,
    });
  }

  return deltas;
}

/** Minimal C1-valid base world (fallback when the real fixture isn't loaded). */
export function syntheticBaseWorld(worldId: string): BaseWorld {
  return {
    world_id: worldId,
    schema_version: '1.0',
    objects: [
      { object_id: 'spawn', kind: 'marker.spawn', transform: { x: 0, y: 0, z: 0 }, owner_id: null },
      { object_id: 'exit', kind: 'marker.exit', transform: { x: 31, y: 0, z: 31 }, owner_id: null },
    ],
  };
}

/**
 * Load the canonical zombie-school fixture as a BaseWorld.
 * Reads _SHARED_Day0/fixtures/zombie-school.world.json relative to a base dir.
 * Used by M-P0 to run against real C1 data, not just the synthetic stub.
 */
export async function loadZombieSchoolBase(sharedDay0Dir: string): Promise<BaseWorld> {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const raw = readFileSync(join(sharedDay0Dir, 'fixtures', 'zombie-school.world.json'), 'utf8');
  return JSON.parse(raw) as BaseWorld;
}
