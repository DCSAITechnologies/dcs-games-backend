// Games-B gameplay stage. NODE-ONLY because generate.mjs reaches providers.
// The browser runtime imports rules-engine.mjs / solver.mjs / gameplay.schema.mjs
// directly (all three are isomorphic), never this index.
export { generateGameplay, gameplaySkeleton, mergeProposal, gameplayAdapters, readWorld, GAMEPLAY_LANE } from "./generate.mjs";
export {
  validateGameplay, findRequiresCycle, itemSupply, refIndex, GAMEPLAY_VERSION, GAME_TYPES, OBJECTIVE_KINDS, OBJECTIVE_TARGETS,
  TRIGGER_KINDS, ACTION_KINDS, ITEM_KINDS, HAZARD_KINDS, WIN_KINDS, LOSE_KINDS, NPC_STATES,
} from "./gameplay.schema.mjs";
export { createGameState, applyGameEvent, evaluateEnd, timeLimit } from "./rules-engine.mjs";
export { solveGameplay, locksFromWorld } from "./solver.mjs";
