// CW5 Persistence — Contract Types (C3 save-delta + snapshot)
//
// RECONCILED to canonical C3: _SHARED_Day0/contracts/save-delta.schema.json
// + C1 world.schema.json (base world) + C4 load response (mock-server.mjs).
// No longer inferred. Op fields are FLAT per the schema (object_id/kind/transform/
// owner_id/player_id/inventory/npc_id/state/key/value), ts is ISO date-time,
// actor_id is nullable.

// ============================================================================
// OPS (canonical C3 — flat fields, op-specific subset used per type)
// ============================================================================

export type OpType =
  | 'place_object'
  | 'remove_object'
  | 'move_object'
  | 'set_inventory'
  | 'npc_state'
  | 'economy'
  | 'var_set';

export interface Transform {
  x?: number;
  y?: number;
  z?: number;
  rot?: number;
  scale?: number;
}

export interface InventoryItem {
  item_id: string;
  qty: number;
}

// The schema defines one flat op object with all possible fields optional except
// `op`. We model it as a single interface (matching the schema's `items`) plus
// per-op narrowing helpers — this mirrors the contract exactly rather than
// inventing a stricter discriminated union the producer (CW4) isn't bound to.
export interface Op {
  op: OpType;
  object_id?: string;        // place/remove/move target
  kind?: string;             // asset key on place
  transform?: Transform;     // place/move
  owner_id?: string | null;  // place (ownership)
  player_id?: string;        // set_inventory owner
  inventory?: InventoryItem[]; // set_inventory payload
  npc_id?: string;           // npc_state target
  state?: Record<string, unknown>; // npc_state payload
  key?: string;              // var_set key
  value?: unknown;           // var_set value
  // economy ops carry their own fields under the same flat object; DARK until P5.
  [extra: string]: unknown;
}

// ============================================================================
// DELTA (canonical C3 top-level)
// ============================================================================

export interface SaveDelta {
  world_id: string;
  session_id: string;
  seq: number;               // monotonic per world; ordering + idempotency
  ts: string;                // ISO 8601 date-time
  actor_id?: string | null;  // player who caused the change (nullable)
  ops: Op[];
}

// ============================================================================
// BASE WORLD (C1 world.json — immutable, Atlas-signed)
// ============================================================================

export interface WorldObject {
  object_id: string;
  kind: string;
  transform: Transform;
  interactable?: boolean;
  owner_id?: string | null;  // null = world-owned (from base)
}

export interface BaseWorld {
  world_id: string;
  schema_version?: string;
  meta?: Record<string, unknown>;
  terrain?: Record<string, unknown>;
  spawns?: unknown[];
  objects: WorldObject[];
  npcs?: Array<{ npc_id: string; [k: string]: unknown }>;
  quests?: unknown[];
  items?: unknown[];
}

// ============================================================================
// SNAPSHOT (canonical: the C4 /load response shape, fully materialized)
//   { world_id, base_world_id, as_of_seq, ts, objects[], inventories{},
//     npc_states{}, economy{}, vars{} }
// ============================================================================

export interface WorldSnapshot {
  world_id: string;
  base_world_id: string;
  as_of_seq: number;
  ts: string;                          // ISO 8601
  objects: WorldObject[];              // materialized object list
  inventories: Record<string, InventoryItem[]>; // player_id -> items
  npc_states: Record<string, Record<string, unknown>>; // npc_id -> state
  economy: Record<string, unknown>;    // DARK until P5
  vars: Record<string, unknown>;       // var key -> value
}

// LoadResult IS the WorldSnapshot shape (C4 /load returns the snapshot directly).
export type LoadResult = WorldSnapshot;

// ============================================================================
// API RESPONSE SHAPES (C4 endpoints CW5 owns)
// ============================================================================

// POST /worlds/:id/save  → { ok, seq }
export interface SaveAccepted {
  ok: boolean;
  seq: number;
  duplicate?: boolean; // true if (world_id, seq) already applied (idempotent)
}

// GET /worlds/:id/load → WorldSnapshot
export type LoadResponse = WorldSnapshot;
