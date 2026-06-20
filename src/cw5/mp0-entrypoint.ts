// CW5 Persistence — M-P0 Entry Point for CW8 certification
//
// Round-4: CW8's REAL M-P0 imports CW5 persistence to run:
//   generate world → place object → save → reload → assert state survives.
//
// This module is the documented, zero-guess surface for that. It wraps the
// verified PersistenceEngine (cw5_persistence.ts) and exposes the exact names
// Round-4 named: a delta-level applyOp, snapshot(), and load(). Nothing here
// changes the verified engine internals — it's a thin, typed facade.

import { PersistenceEngine, InMemoryPersistenceStore } from './cw5_persistence.js';
import { SaveDelta, BaseWorld, WorldSnapshot, SaveAccepted } from './cw5_persistence_types.js';

/**
 * A self-contained persistence handle for one process / test run.
 * CW8: `const p = createPersistence();` then use the methods below.
 */
export class Persistence {
  private engine: PersistenceEngine;
  constructor(now?: () => string) {
    this.engine = new PersistenceEngine(new InMemoryPersistenceStore(), now);
  }

  /** Register the immutable base world (CW2's world.json output). Call once per world. */
  registerBaseWorld(base: BaseWorld): Promise<void> {
    return this.engine.registerBaseWorld(base);
  }

  /**
   * Apply a save delta (the C3 unit CW4 emits). Append-only, idempotent on
   * (world_id, seq), monotonic. Returns { ok, seq }.
   * NOTE: this is the DELTA-level entry point (op-level application is internal).
   */
  applyOp(delta: SaveDelta): Promise<SaveAccepted> {
    return this.engine.save(delta);
  }

  /** Alias of applyOp for callers who think in "save". */
  save(delta: SaveDelta): Promise<SaveAccepted> {
    return this.engine.save(delta);
  }

  /** Load = base + latest snapshot + tail deltas, as a materialized WorldSnapshot. */
  load(worldId: string): Promise<WorldSnapshot> {
    return this.engine.load(worldId);
  }

  /** Compact deltas into a snapshot. (Named snapshot() per Round-4; engine method is writeSnapshot.) */
  snapshot(worldId: string): Promise<WorldSnapshot> {
    return this.engine.writeSnapshot(worldId);
  }
}

/** Factory CW8 imports: `import { createPersistence } from '@dcs-games/cw5-persistence';` */
export function createPersistence(now?: () => string): Persistence {
  return new Persistence(now);
}

/**
 * One-call M-P0 helper: generate→place→save→reload→assert.
 * CW8 can either use this directly or replicate the steps with the methods above.
 * Returns the reloaded snapshot so the caller asserts state survived.
 */
export async function runMP0(params: {
  base: BaseWorld;
  deltas: SaveDelta[];
}): Promise<WorldSnapshot> {
  const p = new Persistence();
  await p.registerBaseWorld(params.base);
  for (const d of params.deltas) await p.applyOp(d);
  return p.load(params.base.world_id);
}
