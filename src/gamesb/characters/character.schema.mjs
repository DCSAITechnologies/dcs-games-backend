// Games-B CharactersSpec validator (CONTRACT §6). ISOMORPHIC: the browser
// runtime re-validates a package before it trusts it, so this imports nothing
// but the shared issue helpers.
//
// Two entry points:
//   validateCharacters(spec, ctx?)  structure, behaviour sanity, references into
//                                   the WorldSpec when ctx.world is given, and
//                                   the dialogues (merged under "dialogues").
//   validateDialogues(specOrDialogues, ctx?)
//                                   graph checks: every entry/next resolves, no
//                                   unreachable node, no loop the player cannot
//                                   leave, ≤4 choices, §5 action kinds only.
//
// Graph problems are errors, not warnings: a dialogue the player cannot leave
// soft-locks the runtime (the talk UI is modal), and an unreachable node is
// authored text nobody will ever read, which always means a generator bug.

import { Issues, isObj, isArr, isStr, isNum, isBool, isHex, isSemver, requireEnum, requireNum, uniqueIds } from "../common/issues.mjs";

export const CHARACTER_SPEC_VERSION = "1.0.0";
export const ROLES = ["companion", "quest_giver", "merchant", "guard", "enemy", "creature", "ambient"];
export const KINDS = ["humanoid", "creature", "robot", "spirit"];
export const BUILDS = ["slim", "average", "broad"];
export const ACCESSORIES = ["hat", "hood", "cape", "lantern", "backpack", "staff", "goggles", "scarf", "satchel"];
export const BEHAVIOR_STATES = ["idle", "patrol", "guard", "wander", "follow_player", "flee", "chase"];
// Optional additions to §6 body (see docs/games-b/DCS_GAMES_CHARACTER_NPC_SYSTEM.md):
// locomotion tells the asset stage which rig kind to build; glow is an emissive
// accent colour (sentinels, spirits) the renderer may light.
export const LOCOMOTION = ["biped", "quadruped", "hover"];
export const COND_KINDS = ["objective_state", "has_item", "flag"];
export const OBJECTIVE_STATES = ["locked", "active", "done"];
// §5 action kinds — dialogue choices hand these to the rules engine verbatim,
// so anything else would be dropped (or worse, crash) at apply time.
export const ACTION_KINDS = ["message", "give_item", "remove_item", "set_npc_state", "unlock", "set_weather", "set_time",
  "checkpoint", "damage", "heal", "win", "lose", "reveal", "play_cinematic", "set_flag"];
export const MAX_CHOICES = 4; // the runtime binds keys 1–4

const ID_RE = /^[a-z0-9][a-z0-9_]*$/;

/**
 * @param {object} spec CharactersSpec
 * @param {{ world?: object, concept?: object }} [ctx]
 */
export function validateCharacters(spec, ctx = {}) {
  const iss = new Issues();
  if (!isObj(spec)) { iss.err("", "CharactersSpec must be an object"); return iss.toJSON(); }
  if (spec.character_spec_version !== CHARACTER_SPEC_VERSION) {
    iss.err("character_spec_version", `must be "${CHARACTER_SPEC_VERSION}"`, isSemver(spec.character_spec_version) ? "only 1.0.0 is supported" : undefined);
  }
  const ids = uniqueIds(iss, spec.characters, "characters");
  const dialogueIds = new Set(isArr(spec.dialogues) ? spec.dialogues.map((d) => d?.id).filter(isStr) : []);
  const world = isObj(ctx.world) ? ctx.world : null;
  const npcSpawns = new Map();
  if (world && isArr(world.spawn_points)) for (const s of world.spawn_points) if (isStr(s?.id)) npcSpawns.set(s.id, s);

  let companions = 0;
  (isArr(spec.characters) ? spec.characters : []).forEach((c, i) => {
    const p = `characters[${i}]`;
    if (!isObj(c)) { iss.err(p, "must be an object"); return; }
    if (isStr(c.id) && !ID_RE.test(c.id)) iss.err(`${p}.id`, `'${c.id}' must be lower_snake_case`, "ids feed spawn_npc_<id> and ix_talk_<id>");
    if (!isStr(c.name)) iss.err(`${p}.name`, "is required");
    requireEnum(iss, c.role, ROLES, `${p}.role`);
    requireEnum(iss, c.kind, KINDS, `${p}.kind`);
    checkBody(iss, c.body, `${p}.body`);
    if (!isStr(c.asset_ref)) iss.err(`${p}.asset_ref`, "is required");
    else if (isStr(c.id) && c.asset_ref !== `char:${c.id}`) iss.warn(`${p}.asset_ref`, `expected 'char:${c.id}'`, "§4.1a: the asset stage satisfies char:<id>");

    if (!isStr(c.spawn_ref)) iss.err(`${p}.spawn_ref`, "is required");
    else if (world) {
      const s = npcSpawns.get(c.spawn_ref);
      if (!s) iss.err(`${p}.spawn_ref`, `'${c.spawn_ref}' is not a spawn point in the world`, `the world stage emits spawn_npc_${c.id}`);
      else if (s.kind !== "npc") iss.err(`${p}.spawn_ref`, `'${c.spawn_ref}' is a '${s.kind}' spawn, not 'npc'`);
    }

    checkBehavior(iss, c.behavior, `${p}.behavior`, world);

    if (c.dialogue_ref !== null && c.dialogue_ref !== undefined) {
      if (!isStr(c.dialogue_ref)) iss.err(`${p}.dialogue_ref`, "must be a string or null");
      else if (!dialogueIds.has(c.dialogue_ref)) iss.err(`${p}.dialogue_ref`, `'${c.dialogue_ref}' does not resolve to a dialogue`);
      else {
        const d = spec.dialogues.find((x) => x?.id === c.dialogue_ref);
        if (d.character_ref !== c.id) iss.err(`${p}.dialogue_ref`, `dialogue '${d.id}' belongs to '${d.character_ref}', not '${c.id}'`);
      }
    } else if (c.dialogue_ref === undefined) iss.err(`${p}.dialogue_ref`, "is required (use null for no dialogue)");
    else if (c.role !== "enemy") iss.warn(`${p}.dialogue_ref`, "non-enemy character has no dialogue", `the world stage still binds ix_talk_${c.id} to it`);

    requireNum(iss, c.interaction_radius, `${p}.interaction_radius`, { min: 0, max: 10 });
    if (!isBool(c.companion)) iss.err(`${p}.companion`, "must be a boolean");
    else if (c.companion) {
      companions++;
      if (c.role !== "companion") iss.warn(`${p}.companion`, `companion flag on a '${c.role}'`);
      if (c.behavior?.hostile === true) iss.err(`${p}.companion`, "a companion cannot be hostile");
    }
    if (!isBool(c.invulnerable)) iss.err(`${p}.invulnerable`, "must be a boolean");
  });
  // The /v3 companion hook and the package's hooks.companion.character_ref both
  // assume a single companion; two would make "the companion" ambiguous.
  if (companions > 1) iss.err("characters", `${companions} characters have companion: true; at most one may`);

  if (isArr(ctx.concept?.characters)) {
    for (const cc of ctx.concept.characters) if (isStr(cc?.id) && !ids.has(cc.id)) iss.warn("characters", `concept character '${cc.id}' has no CharactersSpec entry`);
  }

  // Passing the whole spec keeps issue paths as "dialogues[i]...".
  iss.merge(validateDialogues(spec, { characterIds: ids }));
  return iss.toJSON();
}

function checkBody(iss, b, p) {
  if (!isObj(b)) { iss.err(p, "is required"); return; }
  requireNum(iss, b.height, `${p}.height`, { min: 0.2, max: 6 });
  requireEnum(iss, b.build, BUILDS, `${p}.build`);
  if (!isObj(b.palette)) iss.err(`${p}.palette`, "is required");
  else for (const k of ["skin", "primary", "secondary", "accent"]) if (!isHex(b.palette[k])) iss.err(`${p}.palette.${k}`, "must be #rrggbb");
  if (!isArr(b.accessories)) iss.err(`${p}.accessories`, "must be an array");
  else {
    const seen = new Set();
    b.accessories.forEach((a, j) => {
      requireEnum(iss, a, ACCESSORIES, `${p}.accessories[${j}]`);
      if (seen.has(a)) iss.err(`${p}.accessories[${j}]`, `duplicate accessory '${a}'`);
      seen.add(a);
    });
  }
  requireEnum(iss, b.locomotion, LOCOMOTION, `${p}.locomotion`, { optional: true });
  if (b.glow !== undefined && b.glow !== null && !isHex(b.glow)) iss.err(`${p}.glow`, "must be #rrggbb or null");
}

function checkBehavior(iss, b, p, world) {
  if (!isObj(b)) { iss.err(p, "is required"); return; }
  requireEnum(iss, b.initial, BEHAVIOR_STATES, `${p}.initial`);
  requireEnum(iss, b.on_player_near, BEHAVIOR_STATES, `${p}.on_player_near`, { optional: true });
  requireEnum(iss, b.on_player_far, BEHAVIOR_STATES, `${p}.on_player_far`, { optional: true });
  // Speeds are capped at a sprint: anything faster tunnels through one-cell
  // walls at 60 Hz and reads as a glitch rather than a fast NPC.
  requireNum(iss, b.speed, `${p}.speed`, { min: 0, max: 12 });
  if (b.speed === 0 && ["patrol", "wander", "follow_player", "chase", "flee"].includes(b.initial)) iss.err(`${p}.speed`, `must be > 0 for initial '${b.initial}'`);
  requireNum(iss, b.sight_radius, `${p}.sight_radius`, { min: 0, max: 200 });
  requireNum(iss, b.wander_radius, `${p}.wander_radius`, { min: 0, max: 200 });
  requireNum(iss, b.leash_radius, `${p}.leash_radius`, { min: 0, max: 500 });
  if (!isBool(b.hostile)) iss.err(`${p}.hostile`, "must be a boolean");
  if (b.initial === "wander" && !(b.wander_radius > 0)) iss.err(`${p}.wander_radius`, "must be > 0 when initial is 'wander'");
  const chases = b.initial === "chase" || b.on_player_near === "chase";
  if (chases && isNum(b.leash_radius) && isNum(b.sight_radius) && b.leash_radius < b.sight_radius) {
    iss.warn(`${p}.leash_radius`, "is smaller than sight_radius; the NPC will give up as soon as it starts a chase");
  }
  if ((b.on_player_near || b.on_player_far) && !(b.sight_radius > 0)) iss.err(`${p}.sight_radius`, "must be > 0 when near/far transitions are set");

  if (!isArr(b.patrol)) { iss.err(`${p}.patrol`, "must be an array (empty when unused)"); return; }
  const patrols = b.initial === "patrol" || b.on_player_far === "patrol" || b.on_player_near === "patrol";
  if (patrols && b.patrol.length < 2) iss.err(`${p}.patrol`, "needs at least 2 points for a patrolling NPC");
  b.patrol.forEach((pt, j) => {
    if (!isObj(pt) || !isNum(pt.x) || !isNum(pt.z)) { iss.err(`${p}.patrol[${j}]`, "must be {x,z}"); return; }
    if (world && isObj(world.size) && (pt.x < 0 || pt.z < 0 || pt.x > world.size.w || pt.z > world.size.h)) {
      iss.err(`${p}.patrol[${j}]`, `(${pt.x}, ${pt.z}) is outside the world (${world.size.w}×${world.size.h})`);
    } else if (world && isObj(world.navigation) && !navWalkable(world.navigation, pt.x, pt.z)) {
      iss.warn(`${p}.patrol[${j}]`, `(${pt.x}, ${pt.z}) is on an unwalkable nav cell`, "the brain skips unreachable points");
    }
  });
}

/** Same indexing as world/nav-grid.mjs; duplicated because iso modules may not reach into another stage's files. */
export function navWalkable(nav, x, z) {
  if (!isObj(nav) || !isNum(nav.cell) || typeof nav.walkable !== "string") return true;
  const i = Math.floor(x / nav.cell), j = Math.floor(z / nav.cell);
  if (i < 0 || j < 0 || i >= nav.cols || j >= nav.rows) return false;
  return nav.walkable[j * nav.cols + i] === "1";
}

// ---------------------------------------------------------------------------
// Dialogues

/**
 * @param {object|object[]} specOrDialogues a CharactersSpec, or its dialogues array
 * @param {{ characterIds?: Set<string> }} [ctx]
 */
export function validateDialogues(specOrDialogues, ctx = {}) {
  const iss = new Issues();
  const dialogues = isArr(specOrDialogues) ? specOrDialogues : specOrDialogues?.dialogues;
  let characterIds = ctx.characterIds;
  if (!characterIds && isObj(specOrDialogues) && isArr(specOrDialogues.characters)) {
    characterIds = new Set(specOrDialogues.characters.map((c) => c?.id).filter(isStr));
  }
  const prefix = isArr(specOrDialogues) ? "" : "dialogues";
  const at = (s) => (prefix ? `${prefix}${s.startsWith("[") ? "" : "."}${s}` : s);
  if (!isArr(dialogues)) { iss.err(prefix, "must be an array"); return iss.toJSON(); }
  uniqueIds(iss, dialogues, prefix || "dialogues");

  dialogues.forEach((d, i) => {
    const p = at(`[${i}]`);
    if (!isObj(d)) { iss.err(p, "must be an object"); return; }
    if (!isStr(d.character_ref)) iss.err(`${p}.character_ref`, "is required");
    else if (characterIds && !characterIds.has(d.character_ref)) iss.err(`${p}.character_ref`, `'${d.character_ref}' is not a character`);
    const nodeIds = uniqueIds(iss, d.nodes, `${p}.nodes`);
    if (isArr(d.nodes) && d.nodes.length === 0) iss.err(`${p}.nodes`, "must not be empty");

    if (!isArr(d.entry) || d.entry.length === 0) iss.err(`${p}.entry`, "must be a non-empty array");
    else {
      d.entry.forEach((e, j) => {
        const ep = `${p}.entry[${j}]`;
        if (!isObj(e)) { iss.err(ep, "must be an object"); return; }
        if (!nodeIds.has(e.node)) iss.err(`${ep}.node`, `'${e.node}' does not resolve to a node`);
        if (!isArr(e.conditions)) iss.err(`${ep}.conditions`, "must be an array (empty = always)");
        else e.conditions.forEach((c, k) => checkCondition(iss, c, `${ep}.conditions[${k}]`));
      });
      // First match wins, so without an unconditional last entry some game
      // states open nothing and the talk prompt silently does nothing.
      const last = d.entry[d.entry.length - 1];
      if (isObj(last) && isArr(last.conditions) && last.conditions.length > 0) {
        iss.warn(`${p}.entry`, "the last entry is conditional; some game states will open no dialogue");
      }
    }

    const nodes = isArr(d.nodes) ? d.nodes.filter(isObj) : [];
    d.nodes?.forEach?.((n, j) => {
      const np = `${p}.nodes[${j}]`;
      if (!isObj(n)) { iss.err(np, "must be an object"); return; }
      if (!isStr(n.speaker)) iss.err(`${np}.speaker`, "is required");
      if (!isStr(n.text)) iss.err(`${np}.text`, "is required");
      if (!isArr(n.choices)) { iss.err(`${np}.choices`, "must be an array"); return; }
      if (n.choices.length === 0) iss.err(`${np}.choices`, "must offer at least one choice", "end a conversation with a choice whose next is null");
      if (n.choices.length > MAX_CHOICES) iss.err(`${np}.choices`, `has ${n.choices.length} choices; at most ${MAX_CHOICES}`);
      let unconditional = 0;
      n.choices.forEach((ch, k) => {
        const cp = `${np}.choices[${k}]`;
        if (!isObj(ch)) { iss.err(cp, "must be an object"); return; }
        if (!isStr(ch.text)) iss.err(`${cp}.text`, "is required");
        if (ch.next !== null && !nodeIds.has(ch.next)) iss.err(`${cp}.next`, `'${ch.next}' does not resolve to a node (use null to end)`);
        if (ch.conditions !== undefined) {
          if (!isArr(ch.conditions)) iss.err(`${cp}.conditions`, "must be an array");
          else ch.conditions.forEach((c, m) => checkCondition(iss, c, `${cp}.conditions[${m}]`));
        }
        if (!isArr(ch.conditions) || ch.conditions.length === 0) unconditional++;
        if (ch.actions !== undefined) {
          if (!isArr(ch.actions)) iss.err(`${cp}.actions`, "must be an array");
          else ch.actions.forEach((a, m) => checkAction(iss, a, `${cp}.actions[${m}]`));
        }
      });
      if (n.choices.length > 0 && unconditional === 0) iss.warn(`${np}.choices`, "every choice is conditional; the player can get stuck on this node");
    });

    // Reachability from the entries, then "can this node still reach an exit".
    if (nodes.length && isArr(d.entry)) {
      const byId = new Map(nodes.map((n) => [n.id, n]));
      const reach = new Set();
      const stack = d.entry.map((e) => e?.node).filter((id) => byId.has(id));
      while (stack.length) {
        const id = stack.pop();
        if (reach.has(id)) continue;
        reach.add(id);
        for (const ch of byId.get(id).choices || []) if (isObj(ch) && byId.has(ch.next)) stack.push(ch.next);
      }
      nodes.forEach((n, j) => { if (!reach.has(n.id)) iss.err(at(`[${i}].nodes[${j}]`), `node '${n.id}' is unreachable from every entry`); });

      const exits = new Set(nodes.filter((n) => (n.choices || []).some((ch) => isObj(ch) && ch.next === null)).map((n) => n.id));
      let grew = true;
      while (grew) {
        grew = false;
        for (const n of nodes) {
          if (exits.has(n.id)) continue;
          if ((n.choices || []).some((ch) => isObj(ch) && exits.has(ch.next))) { exits.add(n.id); grew = true; }
        }
      }
      nodes.forEach((n, j) => {
        if (reach.has(n.id) && !exits.has(n.id) && isArr(n.choices) && n.choices.length > 0) {
          iss.err(at(`[${i}].nodes[${j}]`), `node '${n.id}' cannot reach an exit (a loop with no next:null choice)`);
        }
      });
    }
  });
  return iss.toJSON();
}

function checkCondition(iss, c, p) {
  if (!isObj(c)) { iss.err(p, "must be an object"); return; }
  if (!requireEnum(iss, c.kind, COND_KINDS, `${p}.kind`)) return;
  if (!isStr(c.ref)) iss.err(`${p}.ref`, "is required");
  if (c.kind === "objective_state") requireEnum(iss, c.value, OBJECTIVE_STATES, `${p}.value`);
  else if (c.kind === "has_item") requireNum(iss, c.value, `${p}.value`, { min: 1, integer: true, optional: true });
  else if (c.kind === "flag") {
    if (!["boolean", "number", "string"].includes(typeof c.value)) iss.err(`${p}.value`, "must be a boolean, number or string");
  }
}

function checkAction(iss, a, p) {
  if (!isObj(a)) { iss.err(p, "must be an object"); return; }
  requireEnum(iss, a.kind, ACTION_KINDS, `${p}.kind`);
  if (a.ref !== undefined && !isStr(a.ref)) iss.err(`${p}.ref`, "must be a non-empty string when present");
  if (a.kind === "set_npc_state" && !BEHAVIOR_STATES.includes(a.value)) iss.err(`${p}.value`, `set_npc_state needs a behaviour state (${BEHAVIOR_STATES.join(", ")})`);
  if (["set_flag", "give_item", "remove_item", "set_npc_state", "unlock", "reveal"].includes(a.kind) && !isStr(a.ref)) iss.err(`${p}.ref`, `is required for '${a.kind}'`);
}
