// Games-D gameplay/objective templates (CONTRACT §3). Node-side (uses the Games-B
// gameplay validator, world reader and nav grid).
//
// The Games-B skeleton gives every game the same chain (talk → collect ×N →
// wake each site → reach the finale → wake it). A template rewrites that into a
// different PLAY PATTERN: an ordered circuit, an open collectathon, a courier
// run, a stealth approach, a hunt, a timed hold, a race, keys and seals, a tour.
//
// Rules every template follows:
//  - Only objective kinds and mechanics that sim-core and the rules engine
//    already realise (reach, collect, talk, interact, activate, deliver, defeat,
//    survive; timers, events, hazards, checkpoints, time limits). No `escort`.
//  - Every reference is read out of the world/characters in ctx (CONTRACT §4.5
//    guaranteed ids); the only new id a template mints is an inventory item the
//    gameplay itself supplies through give_item.
//  - The result must pass validateGameplay(g, { world, characters }). If a
//    template's needs are not met, or its spec does not validate, it degrades
//    to the closest pattern that works and says so in ctx.notes. Never throws.
//  - Container interactables are one-shot in sim-core (opening one marks it
//    collected), so a template never makes a container the target of a step a
//    player could try too early (a sealed, dormant or not-yet-live site).

import { readWorld } from "../../gamesb/gameplay/generate.mjs";
import { validateGameplay, GAME_TYPES } from "../../gamesb/gameplay/gameplay.schema.mjs";
import { findPath } from "../../gamesb/world/nav-grid.mjs";
import { DIFFICULTY, gameplayDifficulty } from "../difficulty.mjs";

const clone = (x) => JSON.parse(JSON.stringify(x));
const STORMY = new Set(["storm", "sandstorm", "ash", "snow"]);
const VERB = { altar: "Awaken", lantern: "Light", container: "Open", sign: "Read", door: "Unseal", lever: "Pull the lever at", switch: "Activate", terminal: "Boot", portal: "Open", pickup: "Take" };
const ONE_SHOT = new Set(["container", "pickup"]);

// ----------------------------------------------------------------- the table
//
// `kinds` lists the objective kinds a template's REQUIRED chain always uses on
// a world that meets its needs (the tests assert them). `needs` is read by the
// roster (npc/behaviours.mjs: hostiles_min/max) and by recipe validation
// (locations_min, counting the hub).

const T = (o) => Object.freeze({ ...o, needs: Object.freeze(o.needs), keywords: Object.freeze(o.keywords), kinds: Object.freeze(o.kinds) });

export const TEMPLATES = Object.freeze({
  classic_chain: T({
    id: "classic_chain", name: "Classic quest chain", genre: "adventure",
    summary: "Talk to the quest giver, gather what was lost, wake each site, then the finale.",
    needs: {}, timed: false, kinds: ["talk", "collect", "activate", "reach"],
    keywords: ["adventure", "quest", "story", "classic", "rpg"],
    apply: (g, ctx) => applyTemplate(g, { ...ctx, template: TEMPLATES.classic_chain }),
  }),
  beacon_circuit: T({
    id: "beacon_circuit", name: "Beacon circuit", genre: "puzzle",
    summary: "Light the sites in one strict order; each lit beacon points to the next.",
    needs: { locations_min: 4 }, timed: false, kinds: ["activate", "reach"],
    keywords: ["beacon", "circuit", "signal", "sequence", "order", "puzzle", "light the"],
    apply: (g, ctx) => applyTemplate(g, { ...ctx, template: TEMPLATES.beacon_circuit }),
  }),
  relic_hunt: T({
    id: "relic_hunt", name: "Relic hunt", genre: "collectathon",
    summary: "Every relic is out there from the first second; find them all, in any order.",
    needs: { locations_min: 3 }, timed: false, kinds: ["collect"],
    keywords: ["collect", "collectathon", "relic", "treasure", "gem", "gather", "scavenger", "find all"],
    apply: (g, ctx) => applyTemplate(g, { ...ctx, template: TEMPLATES.relic_hunt }),
  }),
  courier_run: T({
    id: "courier_run", name: "Courier run", genre: "mission",
    summary: "Pick up each parcel and deliver it to the right person or place before the clock runs out.",
    needs: { locations_min: 3 }, timed: true, kinds: ["collect", "deliver"],
    keywords: ["courier", "deliver", "delivery", "parcel", "mail", "messenger", "errand", "postman"],
    apply: (g, ctx) => applyTemplate(g, { ...ctx, template: TEMPLATES.courier_run }),
  }),
  stealth_infiltration: T({
    id: "stealth_infiltration", name: "Stealth infiltration", genre: "stealth",
    summary: "Slip past heavy sentinels from site to site, lift the intel, and plant the signal at the finale.",
    needs: { hostiles_min: 2, hostiles_max: 4, locations_min: 3 }, timed: false, kinds: ["talk", "reach", "collect"],
    keywords: ["stealth", "sneak", "infiltrate", "infiltration", "spy", "heist", "shadow", "guards"],
    apply: (g, ctx) => applyTemplate(g, { ...ctx, template: TEMPLATES.stealth_infiltration }),
  }),
  hunt: T({
    id: "hunt", name: "The hunt", genre: "adventure",
    summary: "Take the fight to every hostile in melee, then report back.",
    needs: { hostiles_min: 2, hostiles_max: 4 }, timed: false, kinds: ["defeat"],
    keywords: ["hunt", "fight", "combat", "monster", "slay", "battle", "beast", "defeat", "hunter"],
    apply: (g, ctx) => applyTemplate(g, { ...ctx, template: TEMPLATES.hunt }),
  }),
  last_stand: T({
    id: "last_stand", name: "Last stand", genre: "survival",
    summary: "Reach the finale, light it, then hold out against the storm until the timer runs down.",
    needs: { hostiles_min: 1, hostiles_max: 3, locations_min: 2 }, timed: false, kinds: ["reach", "survive"],
    keywords: ["survive", "survival", "hold", "defend", "siege", "last stand", "outlast", "endure"],
    apply: (g, ctx) => applyTemplate(g, { ...ctx, template: TEMPLATES.last_stand }),
  }),
  timed_rush: T({
    id: "timed_rush", name: "Timed rush", genre: "mission",
    summary: "Race through every site on a tight but fair clock and light the finale before time runs out.",
    needs: { locations_min: 3, hostiles_max: 2 }, timed: true, kinds: ["reach"],
    keywords: ["race", "rush", "timed", "speed", "clock", "time trial", "hurry", "countdown"],
    apply: (g, ctx) => applyTemplate(g, { ...ctx, template: TEMPLATES.timed_rush }),
  }),
  lock_and_key: T({
    id: "lock_and_key", name: "Locks and keys", genre: "puzzle",
    summary: "Each site is sealed and its key lies somewhere else. Find a key, break its seal, repeat.",
    needs: { locations_min: 4 }, timed: false, kinds: ["collect", "reach"],
    keywords: ["key", "keys", "lock", "locked", "door", "vault", "dungeon", "unlock", "seal"],
    apply: (g, ctx) => applyTemplate(g, { ...ctx, template: TEMPLATES.lock_and_key }),
  }),
  grand_tour: T({
    id: "grand_tour", name: "Grand tour", genre: "exploration",
    summary: "Visit every corner of the map in any order, then come home.",
    needs: { locations_min: 3, hostiles_max: 1 }, timed: false, kinds: ["reach"],
    keywords: ["explore", "exploration", "wander", "discover", "tour", "scenic", "sightseeing", "roam"],
    apply: (g, ctx) => applyTemplate(g, { ...ctx, template: TEMPLATES.grand_tour }),
  }),
});

// ------------------------------------------------------------ concept patch

const OUTLINES = {
  beacon_circuit: ["Learn the order of the circuit", "Light each beacon in turn", "Reach and light the finale"],
  relic_hunt: ["Search every region", "Find every relic, in any order", "Bonus: make offerings at the sites"],
  courier_run: ["Take the job", "Pick up each parcel", "Deliver each one to its recipient", "Report back before time runs out"],
  stealth_infiltration: ["Get the briefing", "Slip past the sentinels site by site", "Lift the intel", "Plant the signal at the finale"],
  hunt: ["Take the contract", "Defeat every hostile in close combat", "Report back"],
  last_stand: ["Reach the finale", "Light it", "Hold out until the storm breaks"],
  timed_rush: ["Race to each site", "Light the finale before the clock runs out"],
  lock_and_key: ["Find a key", "Break its seal", "Repeat until the way to the finale opens", "Light the finale"],
  grand_tour: ["Visit every region, in any order", "Return home"],
};

export function templateConceptPatch(concept, ctx) {
  const t = ctx?.template || TEMPLATES.classic_chain;
  const genre = GAME_TYPES.includes(t.genre) ? t.genre : "adventure";
  const outline = OUTLINES[t.id];
  return { ...concept, genre, ...(outline ? { objectives_outline: outline } : {}) };
}

// ------------------------------------------------------------- world model

function model(ctx, g) {
  const { concept, world, characters } = ctx;
  const W = readWorld(concept, world, characters);
  const hub = W.locations.find((l) => l.hub) || null;
  const nonHub = W.locations.filter((l) => !l.hub);
  const finale = nonHub[nonHub.length - 1] || null;
  const sites = nonHub.filter((l) => l !== finale);
  const talkable = (c) => W.ix.has(`ix_talk_${c.id}`);
  const friendlies = W.chars.filter((c) => !W.isHostile(c) && talkable(c));
  const giver = friendlies.find((c) => c.role === "quest_giver") || friendlies[0] || null;
  const companion = W.chars.find((c) => (c.companion === true || c.role === "companion") && !W.isHostile(c)) || null;
  const sentinels = W.chars.filter(W.isHostile);
  // Melee only lands on a behaviour-hostile, vulnerable NPC (sim-core doInteract).
  const prey = W.chars.filter((c) => c.behavior?.hostile === true && c.invulnerable !== true);
  const items = g.inventory.items;
  const itemName = (id) => items.find((i) => i.id === id)?.name || id;
  const locByRegion = new Map(W.locations.map((l) => [l.region, l]));

  const spawnPos = new Map((world.spawn_points || []).map((s) => [s.id, s.position]));
  const placementPos = new Map((world.placements || []).map((p) => [p.id, p.position]));
  const charPos = (id) => spawnPos.get((characters?.characters || []).find((c) => c.id === id)?.spawn_ref) || null;
  const regionPos = (id) => {
    const r = (world.regions || []).find((x) => x.id === id);
    if (!r) return null;
    const [x0, z0, x1, z1] = r.bounds || [0, 0, 0, 0];
    return r.center || { x: (x0 + x1) / 2, z: (z0 + z1) / 2 };
  };
  const ixPos = (id) => { const x = W.ix.get(id); if (!x) return null; return x.placement_ref ? placementPos.get(x.placement_ref) || null : charPos(x.character_ref); };
  const start = spawnPos.get("spawn_player") || regionPos(hub?.region) || { x: 0, z: 0 };
  const hasIx = (l) => !!l && W.ix.has(l.ix);
  const ixKind = (l) => W.ix.get(l?.ix)?.kind;
  const verb = (l) => VERB[ixKind(l)] || "Activate";
  // A site a player may try before its step is live must not be one-shot.
  const reusable = (l) => hasIx(l) && !ONE_SHOT.has(ixKind(l));
  const lockOf = (ixId) => W.ix.get(ixId)?.locked_by || null;
  const itemIds = [...new Set(W.pickups.map((p) => p.item))];
  const supplyOf = (id) => W.pickups.filter((p) => p.item === id).length;

  return { W, world, hub, nonHub, finale, sites, friendlies, giver, companion, sentinels, prey, items, itemIds, supplyOf, itemName, locByRegion, regionPos, ixPos, charPos, start, hasIx, reusable, verb, lockOf };
}

const dist2 = (a, b) => (a && b ? Math.hypot(a.x - b.x, a.z - b.z) : Infinity);
const roundUp = (v, step) => Math.ceil(v / step) * step;

/** Nearest-neighbour order of locations from a start point (ties break on id). */
function routeOrder(M, locs, from = M.start) {
  const left = [...locs];
  const out = [];
  let p = from;
  while (left.length) {
    left.sort((a, b) => dist2(M.regionPos(a.region), p) - dist2(M.regionPos(b.region), p) || (a.id < b.id ? -1 : 1));
    const n = left.shift();
    out.push(n);
    p = M.regionPos(n.region) || p;
  }
  return out;
}

function shuffle(arr, R) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(R.next() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

/** Walking length of a nav path between two points (straight line × 1.5 when there is none). */
function pathLength(world, a, b) {
  if (!a || !b) return 0;
  let pts = null;
  try { pts = world.navigation ? findPath(world.navigation, { x: a.x, z: a.z }, { x: b.x, z: b.z }) : null; } catch { pts = null; }
  if (!pts || pts.length < 2) return dist2(a, b) * 1.5;
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += dist2(pts[i - 1], pts[i]);
  return s;
}

/**
 * Rough seconds a competent player needs for the required chain, walking the
 * objectives in array order. Running is 7.5 m/s; 5.5 allows for slopes, turns
 * and steering round sentinels. Each step adds a few seconds of interaction.
 */
export function estimateSeconds(M, objectives) {
  let p = M.start, len = 0, extra = 0;
  const posOf = (o) => {
    const t = o.target_ref;
    if (o.kind === "reach") return M.regionPos(t);
    if (o.kind === "talk" || o.kind === "defeat") return M.charPos(t);
    if (o.kind === "collect") {
      const holders = M.W.pickups.filter((x) => x.item === t).map((x) => M.ixPos(x.id)).filter(Boolean);
      holders.sort((a, b) => dist2(a, p) - dist2(b, p));
      return holders[0] || null;
    }
    if (o.kind === "deliver") return M.charPos(t) || M.ixPos(t);
    return M.ixPos(t);
  };
  for (const o of objectives) {
    if (o.optional) continue;
    if (o.kind === "survive") { extra += o.count || 0; continue; }
    const q = posOf(o);
    if (q) { len += pathLength(M.world, p, q); p = q; }
    extra += 3;
  }
  return len / 5.5 + extra;
}

// ------------------------------------------------------------ spec builders

function objective(o) {
  return { count: 1, requires: [], optional: false, reward: { xp: 20 }, description: "", ...o };
}

const sentinelHazards = (M, dps, activeAfter) => M.sentinels.map((h) => ({
  id: `hz_${h.id}`, kind: "sentinel", character_ref: h.id, damage_per_s: dps, ...(activeAfter ? { active_after: activeAfter } : {}),
}));

function stormHazard(M, concept, dps, activeAfter, force = false) {
  if (!M.finale || (!force && !STORMY.has(concept.weather))) return [];
  const kind = STORMY.has(concept.weather) ? concept.weather : "storm";
  return [{ id: `hz_${kind}_${M.finale.id}`, kind: "storm_zone", region: M.finale.region, damage_per_s: dps, ...(activeAfter ? { active_after: activeAfter } : {}) }];
}

function avoid(M, dps = 10) {
  return M.sentinels.length
    ? { enabled: true, mode: "avoid", player_damage: 0, hazard_damage_per_s: dps }
    : { enabled: false, mode: "none", player_damage: 0, hazard_damage_per_s: 2 };
}

/** Optional flavour: chat with the other friendlies, read the hub landmark. */
function optionalExtras(M, used) {
  const out = [];
  for (const c of M.friendlies) {
    if (used.has(`talk_${c.id}`) || used.has(`report_${c.id}`)) continue;
    out.push(objective({ id: `talk_${c.id}`, title: `Chat with ${c.name}`, description: `${c.name} may know something useful.`, kind: "talk", target_ref: c.id, optional: true, reward: { xp: 10 } }));
  }
  if (M.hub && M.reusable(M.hub) && !used.has(`inspect_${M.hub.id}`)) {
    out.push(objective({ id: `inspect_${M.hub.id}`, title: `Check the landmark in ${M.hub.name}`, description: "Get your bearings.", kind: "interact", target_ref: M.hub.ix, optional: true, reward: { xp: 5 } }));
  }
  return out;
}

function startTalk(M, what) {
  if (!M.giver) return null;
  return objective({ id: `talk_${M.giver.id}`, title: `Speak with ${M.giver.name}`, description: `${M.giver.name} ${what}`, kind: "talk", target_ref: M.giver.id, reward: { xp: 25 } });
}

/** Reach the finale, then (when its focal interactable is reusable) wake it. */
function finaleSteps(M, requires, { reachTitle, actTitle, kind = "activate" } = {}) {
  const out = [];
  if (!M.finale) return out;
  const reach = objective({ id: `reach_${M.finale.id}`, title: reachTitle || `Journey to the ${M.finale.name}`, description: `Make for the ${M.finale.name}.`, kind: "reach", target_ref: M.finale.region, requires, reward: { xp: 30 } });
  out.push(reach);
  if (M.reusable(M.finale)) {
    const lock = M.lockOf(M.finale.ix);
    out.push(objective({
      id: `${kind}_${M.finale.id}`, title: actTitle || `${M.verb(M.finale)} the ${M.finale.name}`, description: M.finale.description || "",
      kind, target_ref: M.finale.ix, requires: [reach.id, ...(lock && M.itemIds.includes(lock) ? [`collect_${lock}`] : [])], reward: { xp: 100 },
    }));
  }
  return out;
}

const cpEvent = (M, loc) => (M.W.spawns.has(`spawn_cp_${loc.region}`) ? [{ kind: "checkpoint", ref: `spawn_cp_${loc.region}` }] : []);
const bonusCollects = (M, skip, label) => M.itemIds.filter((id) => !skip.has(id)).map((id) => objective({
  id: `collect_${id}`, title: `${label}: the ${M.itemName(id)}`, kind: "collect", target_ref: id, count: M.supplyOf(id), optional: true, reward: { xp: 10 },
}));
const finaleEvent = (ref, text) => ({ id: "ev_finale", once: true, trigger: { kind: "objective_complete", ref }, actions: [{ kind: "message", value: text }, { kind: "set_flag", ref: "finale_complete", value: true }] });

// Each builder returns { genre, objectives, events, hazards, combat, win, intro,
// time_limit_s?, items? } or a string saying why it cannot run on this world.

const BUILDERS = {
  beacon_circuit(M, ctx) {
    // Only reusable sites can be beacons: a container tried out of turn would be spent.
    // The hub's landmark joins the circuit when the sites alone are too few.
    let lit = M.sites.filter(M.reusable);
    const finaleLit = M.reusable(M.finale) ? 1 : 0;
    if (lit.length + finaleLit < 2 && M.reusable(M.hub)) lit = [M.hub, ...lit];
    if (!M.finale || !lit.length || lit.length + finaleLit < 2) return `needs 2+ beacons among the sites, hub and finale (has ${lit.length + finaleLit})`;
    const order = shuffle(lit, ctx.rand("template:beacon"));
    const objs = [], events = [];
    const s = startTalk(M, "knows the order the beacons must be lit in.");
    if (s) objs.push(s);
    let prev = s?.id || null;
    order.forEach((l, i) => {
      const lock = M.lockOf(l.ix);
      const o = objective({
        id: `activate_${l.id}`, title: `Light the beacon at the ${l.name} (${i + 1} of ${order.length})`, description: `Beacon ${i + 1} of the circuit. ${l.description || ""}`.trim(),
        kind: "activate", target_ref: l.ix, requires: [...(prev ? [prev] : []), ...(lock && M.itemIds.includes(lock) ? [`collect_${lock}`] : [])], reward: { xp: 40 },
      });
      objs.push(o);
      const next = order[i + 1];
      events.push({ id: `ev_next_${l.id}`, once: true, trigger: { kind: "objective_active", ref: o.id }, actions: [{ kind: "message", value: `Next in the circuit: the ${l.name}.` }, { kind: "reveal", ref: l.region }] });
      events.push({ id: `ev_lit_${l.id}`, once: true, trigger: { kind: "objective_complete", ref: o.id }, actions: [
        { kind: "message", value: next ? `The ${l.name} flares; its beam points toward the ${next.name}.` : `The circuit is closed. The ${M.finale.name} answers.` },
        { kind: "set_flag", ref: `${l.id}_lit`, value: true }, ...cpEvent(M, l)] });
      // Trying a later beacon out of turn only earns a hint (the site is reusable).
      if (i > 0) events.push({ id: `ev_dormant_${l.id}`, once: true, trigger: { kind: "interact", ref: l.ix }, actions: [{ kind: "message", value: `The circuit runs ${order.map((x) => x.name).join(" → ")}.` }] });
      prev = o.id;
    });
    objs.push(...finaleSteps(M, [prev], { reachTitle: `Follow the beams to the ${M.finale.name}` }));
    const last = objs[objs.length - 1].id;
    objs.push(...bonusCollects(M, new Set(), "Bonus"));
    events.push(finaleEvent(last, `Every beacon burns. ${ctx.concept.title} is lit again.`));
    return {
      genre: "puzzle", objectives: objs, events,
      hazards: [...sentinelHazards(M, 10, objs[0].id), ...stormHazard(M, ctx.concept, 2, objs[0].id)],
      combat: avoid(M), win: [{ kind: "objective", ref: last }],
      intro: `Light the beacons in order: ${order.map((x) => x.name).join(" → ")}, then the ${M.finale.name}.`,
    };
  },

  relic_hunt(M, ctx) {
    if (M.itemIds.length < 2) return `needs 2+ pickups (has ${M.itemIds.length})`;
    const token = "relic_mark";
    const objs = [], events = [];
    for (const id of M.itemIds) {
      const n = M.supplyOf(id);
      const where = M.locByRegion.get(M.W.pickups.find((p) => p.item === id)?.region);
      const o = objective({ id: `collect_${id}`, title: n > 1 ? `Gather ${n} × ${M.itemName(id)}` : `Find the ${M.itemName(id)}`, description: where ? `Somewhere around ${where.name}.` : "Somewhere out there.", kind: "collect", target_ref: id, count: n, reward: { xp: 25 } });
      objs.push(o);
      events.push({ id: `ev_found_${id}`, once: true, trigger: { kind: "objective_complete", ref: o.id }, actions: [{ kind: "give_item", ref: token, value: 1 }, { kind: "message", value: `Relic secured: the ${M.itemName(id)}.` }] });
    }
    const N = M.itemIds.length;
    const half = Math.max(1, Math.floor(N / 2));
    if (half < N) events.push({ id: "ev_relics_half", once: true, trigger: { kind: "item_count", ref: token, value: half }, actions: [{ kind: "message", value: `${half} of ${N} relics found. Keep searching.` }] });
    events.push({ id: "ev_relics_all", once: true, trigger: { kind: "item_count", ref: token, value: N }, actions: [{ kind: "message", value: "Every relic is home. The hunt is over." }, { kind: "set_flag", ref: "finale_complete", value: true }] });
    for (const l of M.nonHub.filter(M.reusable)) {
      objs.push(objective({ id: `offer_${l.id}`, title: `Bonus: make an offering at the ${l.name}`, kind: "interact", target_ref: l.ix, optional: true, reward: { xp: 15 } }));
    }
    return {
      genre: "collectathon", objectives: objs, events,
      hazards: sentinelHazards(M, 8, null),
      combat: avoid(M, 8), win: [{ kind: "item_count", ref: token, value: N }],
      items: [{ id: token, name: "Relic Mark", kind: "collectible", stackable: true, max_stack: 99, icon_ref: `icon:${token}` }],
      intro: `${N} relics are scattered across ${ctx.concept.title}. Find them all, in any order.`,
    };
  },

  courier_run(M, ctx) {
    const ids = M.itemIds.slice(0, 4);
    if (!ids.length) return "needs at least one pickup";
    // Recipients: friendly NPCs (not the giver, not a tag-along companion), then reusable sites.
    const people = M.friendlies.filter((c) => c !== M.giver && c !== M.companion).map((c) => ({ ref: c.id, name: c.name }));
    const places = M.nonHub.filter(M.reusable).map((l) => ({ ref: l.ix, name: `the ${l.name}` }));
    const recipients = [...people, ...shuffle(places, ctx.rand("template:courier-places"))];
    if (!recipients.length) return "has nobody and nothing to deliver to";
    const objs = [], events = [];
    const s = startTalk(M, "has parcels that need to go out today.");
    if (s) objs.push(s);
    const delivers = [];
    ids.forEach((id, i) => {
      const to = recipients[i % recipients.length];
      const c = objective({ id: `collect_${id}`, title: `Pick up the ${M.itemName(id)}`, kind: "collect", target_ref: id, count: 1, requires: s ? [s.id] : [], reward: { xp: 15 } });
      const d = objective({ id: `deliver_${id}`, title: `Deliver the ${M.itemName(id)} to ${to.name}`, description: `${to.name} is waiting for it.`, kind: "deliver", target_ref: to.ref, item_ref: id, requires: [c.id], reward: { xp: 35 } });
      objs.push(c, d);
      delivers.push(d.id);
      events.push({ id: `ev_delivered_${id}`, once: true, trigger: { kind: "objective_complete", ref: d.id }, actions: [{ kind: "message", value: `Delivered: the ${M.itemName(id)} is with ${to.name}.` }] });
    });
    if (M.giver) objs.push(objective({ id: `report_${M.giver.id}`, title: `Report back to ${M.giver.name}`, description: "Every parcel delivered. Collect your fee.", kind: "talk", target_ref: M.giver.id, requires: delivers, reward: { xp: 60 } }));
    else if (M.hub) objs.push(objective({ id: `return_${M.hub.id}`, title: `Return to ${M.hub.name}`, kind: "reach", target_ref: M.hub.region, requires: delivers, reward: { xp: 60 } }));
    const last = objs[objs.length - 1].id;
    events.push(finaleEvent(last, "Every parcel delivered, on the clock."));
    const est = estimateSeconds(M, objs);
    return {
      genre: "mission", objectives: objs, events,
      hazards: sentinelHazards(M, 10, objs[0].id),
      combat: avoid(M), win: [{ kind: "all_required_objectives" }],
      time_limit_s: roundUp(Math.max(180, est * 1.8), 30),
      intro: `${ids.length} parcels, one clock. Pick each one up and get it where it belongs.`,
    };
  },

  stealth_infiltration(M, ctx) {
    if (!M.sentinels.length) return "no sentinels to sneak past";
    if (!M.finale) return "needs a finale";
    const objs = [], events = [];
    const s = startTalk(M, "has the plan and the patrol routes.");
    if (s) objs.push(s);
    let prev = s?.id || null;
    for (const l of routeOrder(M, M.sites)) {
      const o = objective({ id: `reach_${l.id}`, title: `Slip into the ${l.name}`, description: "Stay out of the sentinels' reach.", kind: "reach", target_ref: l.region, requires: prev ? [prev] : [], reward: { xp: 30 } });
      objs.push(o);
      events.push({ id: `ev_in_${l.id}`, once: true, trigger: { kind: "objective_complete", ref: o.id }, actions: [{ kind: "message", value: `In the ${l.name}. Unseen, for now.` }, ...cpEvent(M, l)] });
      prev = o.id;
    }
    // The intel is the pickup nearest the finale.
    const fpos = M.regionPos(M.finale.region);
    const intel = [...M.W.pickups].sort((a, b) => dist2(M.ixPos(a.id), fpos) - dist2(M.ixPos(b.id), fpos) || (a.id < b.id ? -1 : 1))[0];
    if (!intel) return "needs a pickup to serve as the intel";
    const io = objective({ id: `collect_${intel.item}`, title: `Lift the intel (${M.itemName(intel.item)})`, kind: "collect", target_ref: intel.item, count: 1, requires: prev ? [prev] : [], reward: { xp: 40 } });
    objs.push(io);
    objs.push(...finaleSteps(M, [io.id], { reachTitle: `Infiltrate the ${M.finale.name}`, actTitle: `Plant the signal at the ${M.finale.name}`, kind: "interact" }));
    const last = objs[objs.length - 1].id;
    objs.push(...bonusCollects(M, new Set([intel.item]), "Bonus"));
    events.push({ id: "ev_spotted", once: false, trigger: { kind: "health_below", value: 60 }, actions: [{ kind: "message", value: "Spotted! Break line of sight and get clear." }] });
    events.push(finaleEvent(last, "Signal planted. You were never here."));
    return {
      genre: "stealth", objectives: objs, events,
      hazards: sentinelHazards(M, 16, s ? s.id : null),
      combat: { enabled: true, mode: "avoid", player_damage: 0, hazard_damage_per_s: 16 },
      win: [{ kind: "objective", ref: last }],
      intro: "Heavy sentinels guard every site and they hit hard. Keep your distance.",
    };
  },

  hunt(M, ctx) {
    if (!M.prey.length) return "no vulnerable hostile to hunt";
    const targets = M.prey.slice(0, 5);
    const objs = [], events = [];
    const s = startTalk(M, "has a bounty on every beast in the land.");
    if (s) objs.push(s);
    const kills = [];
    for (const h of targets) {
      const o = objective({ id: `defeat_${h.id}`, title: `Defeat ${h.name}`, description: "Get close and strike (E).", kind: "defeat", target_ref: h.id, requires: s ? [s.id] : [], reward: { xp: 50 } });
      objs.push(o); kills.push(o.id);
      events.push({ id: `ev_down_${h.id}`, once: true, trigger: { kind: "objective_complete", ref: o.id }, actions: [{ kind: "message", value: `${h.name} is down.` }] });
    }
    if (M.giver) objs.push(objective({ id: `report_${M.giver.id}`, title: `Report the hunt to ${M.giver.name}`, kind: "talk", target_ref: M.giver.id, requires: kills, reward: { xp: 80 } }));
    else if (M.hub) objs.push(objective({ id: `return_${M.hub.id}`, title: `Return to ${M.hub.name}`, kind: "reach", target_ref: M.hub.region, requires: kills, reward: { xp: 80 } }));
    const last = objs[objs.length - 1].id;
    objs.push(...bonusCollects(M, new Set(), "Trophy"));
    events.push(finaleEvent(last, "The land is safe again. The bounty is yours."));
    return {
      genre: "adventure", objectives: objs, events,
      hazards: sentinelHazards(M, 8, s ? s.id : null),
      combat: { enabled: true, mode: "melee", player_damage: 25, hazard_damage_per_s: 8 },
      win: [{ kind: "all_required_objectives" }],
      intro: `${targets.length} hostile${targets.length > 1 ? "s roam" : " roams"} ${ctx.concept.title}. Close in and strike with E.`,
    };
  },

  last_stand(M, ctx) {
    if (!M.finale) return "needs a finale location";
    const d = ctx.difficulty || DIFFICULTY.normal;
    const objs = [], events = [];
    const s = startTalk(M, "says the storm is coming, and the finale must be held.");
    if (s) objs.push(s);
    const reach = objective({ id: `reach_${M.finale.id}`, title: `Get to the ${M.finale.name}`, kind: "reach", target_ref: M.finale.region, requires: s ? [s.id] : [], reward: { xp: 30 } });
    objs.push(reach);
    let prev = reach.id;
    if (M.reusable(M.finale)) {
      const o = objective({ id: `activate_${M.finale.id}`, title: `${M.verb(M.finale)} the ${M.finale.name}`, description: "It will draw the storm.", kind: "activate", target_ref: M.finale.ix, requires: [reach.id], reward: { xp: 50 } });
      objs.push(o); prev = o.id;
    }
    // Harder levels hold for longer (time_mult < 1 → more seconds).
    const hold = roundUp(40 / (d.time_mult || 1), 5);
    const surv = objective({ id: `survive_${M.finale.id}`, title: `Hold the ${M.finale.name} for ${hold} seconds`, description: "Survive until the storm breaks. Step out of it if you must.", kind: "survive", target_ref: M.finale.region, count: hold, requires: [prev], reward: { xp: 120 } });
    objs.push(surv);
    // Supplies: every pickup becomes a medkit that heals when picked up.
    for (const id of M.itemIds) {
      objs.push(objective({ id: `collect_${id}`, title: `Scavenge supplies (${medkit(M.itemName(id))})`, description: "Heals you when picked up.", kind: "collect", target_ref: id, count: 1, optional: true, reward: { xp: 10 } }));
      events.push({ id: `ev_use_${id}`, once: false, trigger: { kind: "item_count", ref: id, value: 1 }, actions: [{ kind: "heal", value: 35 }, { kind: "remove_item", ref: id, value: 1 }, { kind: "message", value: "You patch yourself up (+35)." }] });
    }
    events.push({ id: "ev_hold", once: true, trigger: { kind: "objective_active", ref: surv.id }, actions: [{ kind: "message", value: `The storm is here. Hold for ${hold} seconds!` }, { kind: "set_weather", value: "storm" }, ...cpEvent(M, M.finale)] });
    events.push({ id: "ev_second_wind", once: true, trigger: { kind: "health_below", value: 35 }, actions: [{ kind: "heal", value: 50 }, { kind: "message", value: "Second wind! (+50)" }] });
    events.push({ id: "ev_finale", once: true, trigger: { kind: "objective_complete", ref: surv.id }, actions: [{ kind: "set_weather", value: "clear" }, { kind: "message", value: `The storm breaks. The ${M.finale.name} held.` }, { kind: "set_flag", ref: "finale_complete", value: true }] });
    return {
      genre: "survival", objectives: objs, events,
      hazards: [...sentinelHazards(M, 8, objs[0].id), ...stormHazard(M, ctx.concept, 2, prev, true)],
      combat: avoid(M, 8), win: [{ kind: "objective", ref: surv.id }],
      items: M.itemIds.map((id) => ({ id, name: medkit(M.itemName(id)), kind: "consumable", stackable: true, max_stack: 9, icon_ref: `icon:${id}`, effect: { heal: 35 } })),
      intro: `Reach the ${M.finale.name}, light it, and hold out for ${hold} seconds.`,
    };
  },

  timed_rush(M, ctx) {
    if (!M.finale || !M.sites.length) return "needs sites and a finale";
    const objs = [], events = [];
    let prev = null;
    for (const l of routeOrder(M, M.sites)) {
      const o = objective({ id: `reach_${l.id}`, title: `Dash to the ${l.name}`, kind: "reach", target_ref: l.region, requires: prev ? [prev] : [], reward: { xp: 25 } });
      objs.push(o); prev = o.id;
      events.push({ id: `ev_split_${l.id}`, once: true, trigger: { kind: "objective_complete", ref: o.id }, actions: [{ kind: "message", value: `Split: the ${l.name}. Keep going!` }, ...cpEvent(M, l)] });
    }
    objs.push(...finaleSteps(M, [prev], { reachTitle: `Sprint to the ${M.finale.name}` }));
    const last = objs[objs.length - 1].id;
    objs.push(...bonusCollects(M, new Set(), "If you have time"));
    events.push(finaleEvent(last, "Made it, with time to spare!"));
    const est = estimateSeconds(M, objs);
    // Tight but fair. The estimate walks to region centres, while a reach
    // counts at the region's edge, so it already runs ~1.5–2× the agent's time;
    // the hard clock (0.75 ×) still leaves about 2× what the agent needs.
    return {
      genre: "mission", objectives: objs, events,
      hazards: sentinelHazards(M, 8, null),
      combat: avoid(M, 8), win: [{ kind: "all_required_objectives" }],
      time_limit_s: roundUp(Math.max(60, est * 1.3), 10),
      intro: "The clock is already running. Hit every site, then light the finale.",
    };
  },

  lock_and_key(M, ctx) {
    // A reusable site is sealed (activate once the key is held). A one-shot
    // container site cannot be sealed safely, so its key opens the way INTO it
    // (a reach that only counts once the key is held) instead.
    const sealed = M.sites;
    if (!sealed.length || !M.itemIds.length || !M.finale) return `needs sites and keys (sites ${sealed.length}, keys ${M.itemIds.length})`;
    const pool = shuffle(M.itemIds, ctx.rand("template:locks"));
    const regionOfItem = (id) => M.W.pickups.find((p) => p.item === id)?.region;
    const objs = [], events = [];
    let prev = null;
    const used = [];
    for (const l of routeOrder(M, sealed)) {
      // A world lock wins; otherwise prefer a key that lies OUTSIDE the site it opens.
      const wl = M.lockOf(l.ix);
      const key = (wl && M.itemIds.includes(wl) && !used.includes(wl)) ? wl
        : pool.find((k) => !used.includes(k) && regionOfItem(k) !== l.region) || pool.find((k) => !used.includes(k));
      if (!key) break;
      used.push(key);
      const kloc = M.locByRegion.get(regionOfItem(key));
      const c = objective({ id: `collect_${key}`, title: `Find the key: ${M.itemName(key)}`, description: kloc ? `It lies around ${kloc.name}.` : "", kind: "collect", target_ref: key, count: M.supplyOf(key), requires: prev ? [prev] : [], reward: { xp: 20 } });
      const a = M.reusable(l)
        ? objective({ id: `activate_${l.id}`, title: `Break the seal on the ${l.name}`, description: `The ${M.itemName(key)} fits here.`, kind: "activate", target_ref: l.ix, requires: [c.id], reward: { xp: 45 } })
        : objective({ id: `enter_${l.id}`, title: `Unbar the way into the ${l.name}`, description: `The ${M.itemName(key)} opens its gate.`, kind: "reach", target_ref: l.region, requires: [c.id], reward: { xp: 45 } });
      objs.push(c, a);
      if (M.reusable(l)) events.push({ id: `ev_sealed_${l.id}`, once: true, trigger: { kind: "interact", ref: l.ix }, actions: [{ kind: "message", value: `The ${l.name} is sealed by the ${M.itemName(key)}.` }] });
      events.push({ id: `ev_key_${key}`, once: true, trigger: { kind: "objective_complete", ref: c.id }, actions: [{ kind: "message", value: `The ${M.itemName(key)} hums. It opens the ${l.name}.` }, { kind: "reveal", ref: l.region }] });
      events.push({ id: `ev_open_${l.id}`, once: true, trigger: { kind: "objective_complete", ref: a.id }, actions: [{ kind: "message", value: `The seal on the ${l.name} breaks.` }, { kind: "set_flag", ref: `${l.id}_open`, value: true }, ...cpEvent(M, l)] });
      prev = a.id;
    }
    if (!prev) return "could not pair any key with a site";
    objs.push(...finaleSteps(M, [prev], { reachTitle: `The way to the ${M.finale.name} is open` }));
    const last = objs[objs.length - 1].id;
    objs.push(...bonusCollects(M, new Set(used), "A spare key"));
    events.push(finaleEvent(last, "Every seal is broken."));
    return {
      genre: "puzzle", objectives: objs, events,
      hazards: [...sentinelHazards(M, 10, objs[0].id), ...stormHazard(M, ctx.concept, 2, objs[0].id)],
      combat: avoid(M), win: [{ kind: "objective", ref: last }],
      items: used.map((id) => ({ id, kind: "key" })),
      intro: "Every site is sealed, and every key lies somewhere else.",
    };
  },

  grand_tour(M, ctx) {
    if (M.nonHub.length < 2) return "needs 2+ locations beyond the hub";
    const objs = [], events = [];
    const visits = [];
    for (const l of M.nonHub) {
      const o = objective({ id: `visit_${l.id}`, title: `Visit the ${l.name}`, description: l.description || "", kind: "reach", target_ref: l.region, reward: { xp: 30 } });
      objs.push(o); visits.push(o.id);
      events.push({ id: `ev_visit_${l.id}`, once: true, trigger: { kind: "objective_complete", ref: o.id }, actions: [{ kind: "message", value: `You reach the ${l.name}.` }, { kind: "set_flag", ref: `${l.id}_visited`, value: true }, ...cpEvent(M, l)] });
    }
    if (M.hub) {
      const home = objective({ id: `home_${M.hub.id}`, title: `Head home to ${M.hub.name}`, kind: "reach", target_ref: M.hub.region, requires: visits, reward: { xp: 60 } });
      objs.push(home);
      events.push(finaleEvent(home.id, "Home again, with the whole map in your head."));
    }
    for (const l of M.nonHub.filter(M.reusable)) objs.push(objective({ id: `survey_${l.id}`, title: `Survey the ${l.name}`, kind: "interact", target_ref: l.ix, optional: true, reward: { xp: 10 } }));
    objs.push(...bonusCollects(M, new Set(), "Souvenir"));
    return {
      genre: "exploration", objectives: objs, events,
      hazards: [...sentinelHazards(M, 6, null), ...stormHazard(M, ctx.concept, 1.5, visits[0])],
      combat: avoid(M, 6), win: [{ kind: "all_required_objectives" }],
      intro: `Explore all ${M.nonHub.length} corners of ${ctx.concept.title}, in any order, then head home.`,
    };
  },
};

const medkit = (name) => String(name).replace(/\b(Relic|Gem|Shard|Scroll|Lantern Core|Key|Herb)\b/, "Medkit").replace(/^(?!.*Medkit).*$/, (s) => `${s} Medkit`);

// Where a template goes when it cannot run on this world (always ends at classic_chain).
const DEGRADE = {
  hunt: "stealth_infiltration", stealth_infiltration: "timed_rush", beacon_circuit: "lock_and_key", lock_and_key: "classic_chain",
  last_stand: "classic_chain", timed_rush: "classic_chain", courier_run: "relic_hunt", relic_hunt: "grand_tour", grand_tour: "classic_chain",
};

/** A reason the world cannot host the template at all, else null. */
function unmetNeeds(t, M) {
  const n = t.needs || {};
  if (n.locations_min && M.W.locations.length < n.locations_min) return `needs ${n.locations_min} locations, world has ${M.W.locations.length}`;
  return null;
}

// ------------------------------------------------------------ assembly

// sim-core multiplies hazard damage by difficulty.damage_mult and the rules
// engine multiplies the resulting damage event by it again, so a hazard's
// effective rate is damage_per_s × damage_mult². Templates divide the listed
// rate by damage_mult once, so the effective rate is base × damage_mult — the
// scale the difficulty table was written for (easy ½, hard 1.6×).
const round2 = (v) => Math.round(v * 100) / 100;
function scaleHazards(hazards, d) {
  const m = d.damage_mult > 0 ? d.damage_mult : 1;
  return (hazards || []).map((h) => ({ ...h, damage_per_s: round2((h.damage_per_s ?? 0) / m) }));
}

function withDifficulty(g, ctx) {
  const d = ctx.difficulty || DIFFICULTY.normal;
  const out = clone(g);
  out.rules = { ...out.rules, player_health: d.player_health, lives: d.lives };
  out.difficulty = gameplayDifficulty(d);
  out.hazards = scaleHazards(out.hazards, d);
  if (out.combat) out.combat = { ...out.combat, hazard_damage_per_s: round2((out.combat.hazard_damage_per_s ?? 0) / (d.damage_mult > 0 ? d.damage_mult : 1)) };
  return out;
}

/** Effective hazard damage per second the player takes from `h` under `gameplay`'s difficulty. */
export function effectiveHazardDps(h, gameplay) {
  const m = gameplay?.difficulty?.damage_mult ?? 1;
  return (h.damage_per_s ?? gameplay?.combat?.hazard_damage_per_s ?? 5) * m * m;
}

function assemble(g0, ctx, M, spec) {
  const g = withDifficulty(g0, ctx);
  if (GAME_TYPES.includes(spec.genre)) g.game_type = spec.genre;
  const objs = spec.objectives.map(objective);
  objs.push(...optionalExtras(M, new Set(objs.map((o) => o.id))));
  g.objectives = objs;

  // Items: the skeleton's, patched by the template, plus any it mints.
  const items = g.inventory.items.map((it) => ({ ...it }));
  for (const it of spec.items || []) {
    const i = items.findIndex((x) => x.id === it.id);
    if (i >= 0) items[i] = { ...items[i], ...it };
    else if (it.name) items.push(it);
  }
  g.inventory = { ...g.inventory, items, slots: Math.max(g.inventory.slots || 8, items.length + 4) };

  const intro = {
    id: "ev_intro", once: true, trigger: { kind: "game_start" },
    actions: [
      ...(M.W.ix.size ? [{ kind: "play_cinematic", ref: "cine:intro" }] : []),
      { kind: "message", value: ctx.concept.logline || `Welcome to ${ctx.concept.title}.` },
      ...(spec.intro ? [{ kind: "message", value: spec.intro }] : []),
      ...(M.companion ? [{ kind: "set_npc_state", ref: M.companion.id, value: "follow_player" }] : []),
    ],
  };
  const events = [intro, ...spec.events];
  if (!events.some((e) => e.trigger?.kind === "health_below" && e.once === false)) {
    events.push({ id: "ev_low_health", once: false, trigger: { kind: "health_below", value: 30 }, actions: [{ kind: "message", value: "You are badly hurt. Back off and recover." }] });
  }
  const tl = typeof spec.time_limit_s === "number" && spec.time_limit_s > 0 ? spec.time_limit_s : null;
  if (tl) {
    const eff = tl * (g.difficulty.time_mult || 1);
    events.push({ id: "ev_clock_half", once: true, trigger: { kind: "timer", value: Math.round(eff / 2) }, actions: [{ kind: "message", value: "Half your time is gone." }] });
    if (eff > 90) events.push({ id: "ev_clock_last", once: true, trigger: { kind: "timer", value: Math.round(eff - 30) }, actions: [{ kind: "message", value: "30 seconds left!" }] });
  }
  g.events = events;
  const d = ctx.difficulty || DIFFICULTY.normal;
  g.hazards = scaleHazards(spec.hazards, d);
  g.combat = { ...spec.combat, hazard_damage_per_s: round2(spec.combat.hazard_damage_per_s / (d.damage_mult > 0 ? d.damage_mult : 1)) };
  g.rules = { ...g.rules, time_limit_s: tl };
  g.win_conditions = spec.win;
  g.lose_conditions = [{ kind: "health_zero" }, { kind: "lives_zero" }, { kind: "fell_out" }, ...(tl ? [{ kind: "time_expired" }] : [])];
  return g;
}

/**
 * Rewrite the Games-B skeleton into the recipe's template.
 * ctx: { recipe, theme, template, layout, difficulty, concept, world, characters, rand(stage), notes }
 * Always returns a GameplaySpec; never throws.
 */
export function applyTemplate(gameplay, ctx = {}) {
  const notes = Array.isArray(ctx.notes) ? ctx.notes : [];
  const vctx = { world: ctx.world, characters: ctx.characters };
  let base;
  try { base = withDifficulty(gameplay, ctx); } catch { return gameplay; }
  const fallback = () => { try { return validateGameplay(base, vctx).ok ? base : gameplay; } catch { return gameplay; } };
  try {
    const want = ctx.template?.id || ctx.recipe?.template || "classic_chain";
    let id = TEMPLATES[want] ? want : "classic_chain";
    if (id !== want) notes.push(`template '${want}' is unknown; using classic_chain`);
    const M = model(ctx, gameplay);
    const seen = new Set();
    while (!seen.has(id)) {
      seen.add(id);
      if (id === "classic_chain") break;
      const why = unmetNeeds(TEMPLATES[id], M);
      const spec = why || BUILDERS[id](M, ctx);
      const next = DEGRADE[id] || "classic_chain";
      if (typeof spec === "string") { notes.push(`template ${id}: ${spec}; degrading to ${next}`); id = next; continue; }
      const g = assemble(gameplay, ctx, M, spec);
      const v = validateGameplay(g, vctx);
      if (v.ok) return g;
      notes.push(`template ${id}: spec failed validation (${v.errors.slice(0, 3).map((e) => `${e.path}: ${e.message}`).join("; ")}); degrading to ${next}`);
      id = next;
    }
    return fallback();
  } catch (e) {
    notes.push(`template failed (${e?.message || e}); using the Games-B skeleton`);
    return fallback();
  }
}

/** The kinds of a spec's required objectives, in order (tests and tooling). */
export function requiredKinds(gameplay) {
  return (gameplay?.objectives || []).filter((o) => !o.optional).map((o) => o.kind);
}
