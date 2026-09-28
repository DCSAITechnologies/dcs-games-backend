// Games-B characters: one import for the pipeline and the tests. Not itself on
// the ISOMORPHIC list (it pulls in the generator); the browser runtime imports
// npc-brain.mjs and dialogue.mjs directly.
export { generateCharacters, CHARACTER_SPEC_VERSION, ASSUMED_PLAYER_WALK } from "./characters.mjs";
export {
  validateCharacters, validateDialogues, navWalkable,
  ROLES, KINDS, BUILDS, ACCESSORIES, BEHAVIOR_STATES, LOCOMOTION, COND_KINDS, ACTION_KINDS, MAX_CHOICES,
} from "./character.schema.mjs";
export { createNpcState, stepNpc, setNpcState, STATES as NPC_STATES } from "./npc-brain.mjs";
export { openDialogue, availableChoices, choose, evalCondition } from "./dialogue.mjs";
