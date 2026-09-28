// Games-B dialogue runner (CONTRACT §6). ISOMORPHIC and pure.
//
// The runner never changes game state itself. `choose` hands back the chosen
// choice's actions and the rules engine applies them, so a set_flag from a
// conversation goes through the same path (and the same save file) as one
// from a gameplay event. That keeps dialogue replayable in the headless
// playtest with no UI in the loop.
//
// Node handles: openDialogue and choose return node OBJECTS ({id, speaker,
// text, choices}), because the UI needs the text immediately. Every function
// that takes a node also accepts its id.
//
// Choice indices: `choose(..., choiceIdx, ...)` indexes the list
// `availableChoices` returns, i.e. what the player actually sees, because
// the runtime's 1–4 keys map to the shown choices and not to the authored ones.

/** Does one §6 condition hold in this GameState? */
export function evalCondition(cond, gameState) {
  const gs = gameState || {};
  if (!cond || typeof cond !== "object") return false;
  switch (cond.kind) {
    case "objective_state": return (gs.objectives?.[cond.ref] ?? "locked") === cond.value;
    case "has_item": return (gs.inventory?.[cond.ref] ?? 0) >= (cond.value ?? 1);
    case "flag": {
      const v = gs.flags?.[cond.ref];
      // An unset flag counts as false, so `{flag, value:false}` means "not yet".
      if (cond.value === false) return v === undefined || v === false;
      return v === cond.value;
    }
    default: return false; // unknown kinds never pass: fail closed
  }
}

export const allHold = (conds, gs) => !Array.isArray(conds) || conds.every((c) => evalCondition(c, gs));

const list = (dialogues) => (Array.isArray(dialogues) ? dialogues : dialogues?.dialogues || []);

const nodeOf = (dialogue, node) => (typeof node === "string" ? (dialogue?.nodes || []).find((n) => n.id === node) || null : node || null);

/**
 * Find the character's dialogue and its first entry whose conditions hold.
 * @param {object[]|{dialogues:object[]}} dialogues
 * @returns {{ dialogue_id: string, node: object, dialogue: object } | null}
 */
export function openDialogue(dialogues, characterId, gameState) {
  const d = list(dialogues).find((x) => x?.character_ref === characterId);
  if (!d) return null;
  for (const e of d.entry || []) {
    if (allHold(e.conditions, gameState)) {
      const node = nodeOf(d, e.node);
      if (node) return { dialogue_id: d.id, node, dialogue: d };
    }
  }
  return null;
}

/** The choices the player can see now, each tagged with its authored index. */
export function availableChoices(node, gameState, dialogue) {
  const n = typeof node === "string" ? nodeOf(dialogue, node) : node;
  if (!n) return [];
  const out = [];
  (n.choices || []).forEach((ch, index) => {
    if (allHold(ch.conditions, gameState)) out.push({ index, text: ch.text, next: ch.next, actions: ch.actions || [] });
  });
  return out;
}

/**
 * Pick a visible choice. Returns the next node (null = conversation over) and
 * the actions for the rules engine. An out-of-range pick leaves the player on
 * the same node with no actions rather than throwing, since it usually just
 * means a stray key press.
 */
export function choose(dialogue, node, choiceIdx, gameState) {
  const n = nodeOf(dialogue, node);
  if (!n) return { node: null, actions: [], invalid: true };
  const visible = availableChoices(n, gameState);
  const pick = Number.isInteger(choiceIdx) ? visible[choiceIdx] : undefined;
  if (!pick) return { node: n, actions: [], invalid: true };
  // Copy the actions so a caller that decorates them cannot edit the package.
  const actions = pick.actions.map((a) => ({ ...a }));
  return { node: pick.next === null ? null : nodeOf(dialogue, pick.next), actions };
}
