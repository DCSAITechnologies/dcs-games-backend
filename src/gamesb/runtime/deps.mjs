// Games-B runtime dependency set. ISOMORPHIC.
//
// sim-core.mjs takes its world, rules and character modules by injection so it
// can be unit-tested against mocks. This file is the production wiring: it
// statically imports the real ISOMORPHIC stage modules and registers them as
// sim-core's defaults, so `import "./deps.mjs"` once (browser or Node) is enough
// for createSim(pkg) to work without passing deps around.

import * as terrainMod from "../world/terrain-sample.mjs";
import * as collisionMod from "../world/collision.mjs";
import * as navMod from "../world/nav-grid.mjs";
import * as rulesMod from "../gameplay/rules-engine.mjs";
import * as npcBrainMod from "../characters/npc-brain.mjs";
import * as dialogueMod from "../characters/dialogue.mjs";
import { registerDefaultDeps } from "./sim-core.mjs";

export const realDeps = Object.freeze({
  terrain: { sampleHeight: terrainMod.sampleHeight, slopeAt: terrainMod.slopeAt },
  collision: { buildColliders: collisionMod.buildColliders, resolveCapsule: collisionMod.resolveCapsule, pointInCollider: collisionMod.pointInCollider },
  nav: { isWalkable: navMod.isWalkable, findPath: navMod.findPath, reachableSet: navMod.reachableSet, navIndex: navMod.navIndex },
  rules: { createGameState: rulesMod.createGameState, applyGameEvent: rulesMod.applyGameEvent, evaluateEnd: rulesMod.evaluateEnd },
  npcBrain: { createNpcState: npcBrainMod.createNpcState, stepNpc: npcBrainMod.stepNpc, setNpcState: npcBrainMod.setNpcState },
  dialogue: { openDialogue: dialogueMod.openDialogue, availableChoices: dialogueMod.availableChoices, choose: dialogueMod.choose },
  expandScatter: terrainMod.expandScatter,
});

registerDefaultDeps(realDeps);
