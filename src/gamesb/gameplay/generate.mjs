// GameplaySpec generation (CONTRACT §5, pipeline stage after assets). NODE-ONLY.
//
// The deterministic SKELETON is the product: a main chain built from the §4.5
// ids the world stage guarantees (talk to the quest giver → collect the pickups
// → wake each location's focal interactable → reach and wake the finale). It is
// always valid against the world it was built from, because every reference in
// it was read out of that world rather than predicted.
//
// The LLM path only decorates it — titles, descriptions, an intro line, up to
// three extra OPTIONAL objectives — and each decoration is kept only if the
// spec still validates with the world and characters. The skeleton always
// survives, so a model can make a game more flavourful but never unwinnable.
import { Lane, STATUS } from "../../v3/providers/contract.mjs";
import { validateGameplay, GAMEPLAY_VERSION, GAME_TYPES, OBJECTIVE_TARGETS, refIndex } from "./gameplay.schema.mjs";
import { cerebrasJsonAdapter, localAdapter, stageProvenance, withFallback, slugify } from "../concept/llm.mjs";

export const GAMEPLAY_LANE = "gamesb_gameplay";

const HOSTILE_ROLES = new Set(["guard", "enemy", "creature"]);
const STORMY = new Set(["storm", "sandstorm", "ash", "snow"]);
const TIMED_GENRES = new Set(["survival", "mission"]);

// Item display names by the pickup's library mesh (§4.1a pickups).
const PICKUP_NAMES = {
  lantern_core: "Lantern Core", relic: "Relic", gem: "Gem", key: "Key", scroll: "Scroll", herb: "Herb", shard: "Shard",
};

const titleCase = (s) => String(s).replace(/_/g, " ").replace(/\b[a-z]/g, (c) => c.toUpperCase());
const num = (id) => { const m = /(\d+)$/.exec(id); return m ? Number(m[1]) : Infinity; };
const byNum = (a, b) => (num(a) - num(b)) || (a < b ? -1 : a > b ? 1 : 0);

// ------------------------------------------------------------ world reading

/** Everything the skeleton needs from the world, read once. */
export function readWorld(concept, world, characters) {
  const regions = new Set((world.regions || []).map((r) => r.id));
  const ix = new Map((world.interactables || []).map((x) => [x.id, x]));
  const placements = new Map((world.placements || []).map((p) => [p.id, p]));
  const spawns = new Set((world.spawn_points || []).map((s) => s.id));
  const chars = (characters?.characters || []).map((c) => c);

  const locations = (concept.key_locations || []).map((l, i) => ({
    ...l, hub: i === 0, region: `region_${l.id}`, ix: `ix_${l.id}`,
  })).filter((l) => regions.has(l.region));

  // Pickups: interactables that grant an item, grouped by the region their placement sits in.
  const pickups = [...ix.values()].filter((x) => typeof x.item_ref === "string" && x.item_ref)
    .map((x) => {
      const pl = placements.get(x.placement_ref);
      return { id: x.id, item: x.item_ref, region: pl?.region ?? null, lib: String(pl?.asset_ref || "").replace(/^lib:/, "") };
    })
    .sort((a, b) => byNum(a.id, b.id));

  const isHostile = (c) => c.behavior?.hostile === true || HOSTILE_ROLES.has(c.role);
  return { regions, ix, spawns, chars, locations, pickups, isHostile };
}

// -------------------------------------------------------------- skeleton

/** Deterministic GameplaySpec built only from ids present in the world. */
export function gameplaySkeleton({ concept, world, characters }) {
  const W = readWorld(concept, world, characters);
  const genre = GAME_TYPES.includes(concept.genre) ? concept.genre : "adventure";
  const hub = W.locations.find((l) => l.hub) || null;
  const nonHub = W.locations.filter((l) => !l.hub);
  const finale = nonHub[nonHub.length - 1] || null;
  const locByRegion = new Map(W.locations.map((l) => [l.region, l]));

  const talkable = (c) => W.ix.has(`ix_talk_${c.id}`);
  const giver = W.chars.find((c) => c.role === "quest_giver" && talkable(c)) || W.chars.find((c) => !W.isHostile(c) && talkable(c)) || null;
  const companion = W.chars.find((c) => (c.companion === true || c.role === "companion") && !W.isHostile(c)) || null;
  const hostiles = W.chars.filter(W.isHostile);

  // Items: one inventory entry per item any interactable grants.
  const lockItems = new Set([...W.ix.values()].map((x) => x.locked_by).filter(Boolean));
  const itemIds = [...new Set(W.pickups.map((p) => p.item))].sort(byNum);
  const items = itemIds.map((id) => {
    const p = W.pickups.find((x) => x.item === id);
    const base = PICKUP_NAMES[p?.lib] || titleCase(p?.lib || "Relic");
    const where = locByRegion.get(p?.region);
    return {
      id,
      name: where && !where.hub ? `${where.name} ${base}` : base,
      kind: lockItems.has(id) ? "key" : "quest",
      stackable: true, max_stack: 9,
      icon_ref: `icon:${id}`,
    };
  });
  const itemName = (id) => items.find((i) => i.id === id)?.name || titleCase(id);

  const objectives = [];
  const events = [];
  const R = (xp) => ({ xp });
  const add = (o) => { objectives.push({ count: 1, requires: [], optional: false, ...o }); return o.id; };

  // 1. Talk to the quest giver (or, with nobody to talk to, walk out of the hub).
  let startId;
  if (giver) {
    startId = add({ id: `talk_${giver.id}`, title: `Speak with ${giver.name}`, description: `${giver.name} is waiting${hub ? ` in ${hub.name}` : ""} and knows what has gone wrong.`, kind: "talk", target_ref: giver.id, reward: R(25) });
  } else if (nonHub[0]) {
    startId = add({ id: `reach_${nonHub[0].id}`, title: `Set out for ${nonHub[0].name}`, description: `Leave ${hub?.name || "the start"} and find ${nonHub[0].name}.`, kind: "reach", target_ref: nonHub[0].region, reward: R(25) });
  }

  // 2. Collect each item, one objective per item for per-location pacing.
  const collectOf = new Map();
  for (const id of itemIds) {
    const n = W.pickups.filter((p) => p.item === id).length;
    const where = locByRegion.get(W.pickups.find((p) => p.item === id)?.region);
    const oid = add({
      id: `collect_${id}`,
      title: n > 1 ? `Gather ${n} × ${itemName(id)}` : `Find the ${itemName(id)}`,
      description: where && !where.hub ? `It lies somewhere around ${where.name}.` : "It lies somewhere out in the world.",
      kind: "collect", target_ref: id, count: n, requires: startId && startId !== `reach_${where?.id}` ? [startId] : [], reward: R(20),
    });
    collectOf.set(id, oid);
  }
  const collectsIn = (loc) => [...new Set(W.pickups.filter((p) => p.region === loc.region).map((p) => collectOf.get(p.item)))].filter(Boolean);
  const lockReq = (ixId) => { const it = W.ix.get(ixId)?.locked_by; return it && collectOf.has(it) ? [collectOf.get(it)] : []; };

  // 3. Wake each non-finale location's focal interactable.
  const wakeIds = [];
  for (const loc of nonHub) {
    if (loc === finale || !W.ix.has(loc.ix)) continue;
    const reqs = [...new Set([...collectsIn(loc), ...lockReq(loc.ix)])];
    const verb = VERB[W.ix.get(loc.ix).kind] || "Activate";
    wakeIds.push(add({
      id: `activate_${loc.id}`, title: `${verb} the ${loc.name}`,
      description: `${loc.description} ${W.ix.get(loc.ix).prompt ? `(${W.ix.get(loc.ix).prompt})` : ""}`.trim(),
      kind: "activate", target_ref: loc.ix, requires: reqs.length ? reqs : startId ? [startId] : [], reward: R(50),
    }));
  }

  // 4. The finale: reach it once everything else is done, then wake it.
  let finalId = null, reachFinalId = null;
  if (finale) {
    // The finale's own pickups gate waking it, not reaching it: they lie inside
    // its region, and a reach objective that unlocks while the player is already
    // standing there would only complete on leaving and coming back.
    const finaleCollects = collectsIn(finale);
    const allCollects = [...collectOf.values()].filter((id) => !finaleCollects.includes(id));
    const before = [...new Set([...wakeIds, ...allCollects])];
    reachFinalId = add({
      id: `reach_${finale.id}`, title: `Journey to the ${finale.name}`, description: `With everything gathered, make for the ${finale.name}.`,
      kind: "reach", target_ref: finale.region, requires: before.length ? before : startId && startId !== `reach_${finale.id}` ? [startId] : [], reward: R(30),
    });
    if (W.ix.has(finale.ix)) {
      const verb = VERB[W.ix.get(finale.ix).kind] || "Activate";
      finalId = add({
        id: `activate_${finale.id}`, title: `${verb} the ${finale.name}`, description: finale.description,
        kind: "activate", target_ref: finale.ix, requires: [...new Set([reachFinalId, ...finaleCollects, ...lockReq(finale.ix)])], reward: R(100),
      });
    } else {
      // No focal interactable: the finale's pickups become the last step instead.
      finalId = reachFinalId;
      if (finaleCollects.length) objectives.find((o) => o.id === reachFinalId).requires.push(...finaleCollects);
    }
  }

  // Optional: talk to everyone else who can be talked to, read the hub sign.
  for (const c of W.chars) {
    if (c === giver || W.isHostile(c) || !talkable(c)) continue;
    add({ id: `talk_${c.id}`, title: `Chat with ${c.name}`, description: c.role === "companion" ? "Your companion has a few ideas." : `${c.name} may know something useful.`, kind: "talk", target_ref: c.id, optional: true, reward: R(10) });
  }
  if (hub && W.ix.has(hub.ix)) {
    add({ id: `inspect_${hub.id}`, title: `Check the ${W.ix.get(hub.ix).kind === "sign" ? "notice board" : "landmark"} in ${hub.name}`, description: "Get your bearings.", kind: "interact", target_ref: hub.ix, optional: true, reward: R(5) });
  }

  // ---- events
  const intro = [
    ...(W.ix.size ? [{ kind: "play_cinematic", ref: "cine:intro" }] : []),
    { kind: "message", value: concept.logline || `Welcome to ${concept.title}.` },
    ...(companion ? [{ kind: "set_npc_state", ref: companion.id, value: "follow_player" }] : []),
  ];
  events.push({ id: "ev_intro", once: true, trigger: { kind: "game_start" }, actions: intro });
  if (giver && startId) {
    events.push({
      id: "ev_briefed", once: true, trigger: { kind: "objective_complete", ref: startId },
      actions: [
        { kind: "message", value: `${giver.name}: "Find what was lost${nonHub.length ? ` around ${nonHub.slice(0, -1).map((l) => l.name).join(", ") || finale?.name}` : ""}, then bring the ${finale?.name || "light"} back."` },
        ...nonHub.map((l) => ({ kind: "reveal", ref: l.region })),
      ],
    });
  }
  for (const [item, oid] of collectOf) {
    events.push({ id: `ev_found_${item}`, once: true, trigger: { kind: "objective_complete", ref: oid }, actions: [{ kind: "message", value: `You found the ${itemName(item)}.` }] });
  }
  for (const loc of nonHub) {
    const oid = `activate_${loc.id}`;
    if (!objectives.some((o) => o.id === oid) || oid === finalId) continue;
    const cp = `spawn_cp_${loc.region}`;
    events.push({
      id: `ev_woke_${loc.id}`, once: true, trigger: { kind: "objective_complete", ref: oid },
      actions: [
        { kind: "message", value: `The ${loc.name} stirs back to life.` },
        { kind: "set_flag", ref: `${loc.id}_restored`, value: true },
        ...(W.spawns.has(cp) ? [{ kind: "checkpoint", ref: cp }] : []),
      ],
    });
  }
  if (reachFinalId && finale) {
    events.push({ id: "ev_final_call", once: true, trigger: { kind: "objective_active", ref: reachFinalId }, actions: [{ kind: "message", value: `Everything is ready. Head for the ${finale.name}.` }, { kind: "reveal", ref: finale.region }] });
  }
  if (finalId && finale) {
    events.push({ id: "ev_finale", once: true, trigger: { kind: "objective_complete", ref: finalId }, actions: [{ kind: "message", value: `The ${finale.name} blazes to life. ${concept.title} is saved.` }, { kind: "set_flag", ref: "finale_complete", value: true }] });
  }
  events.push({ id: "ev_low_health", once: false, trigger: { kind: "health_below", value: 30 }, actions: [{ kind: "message", value: "You are badly hurt. Back off and recover." }] });

  // ---- hazards
  const hazards = [];
  const firstId = objectives[0]?.id;
  for (const h of hostiles) {
    hazards.push({ id: `hz_${h.id}`, kind: "sentinel", character_ref: h.id, damage_per_s: 10, ...(firstId ? { active_after: firstId } : {}) });
  }
  if (STORMY.has(concept.weather) && finale) {
    hazards.push({ id: `hz_${concept.weather}_${finale.id}`, kind: "storm_zone", region: finale.region, damage_per_s: 2, ...(firstId ? { active_after: firstId } : {}) });
  }

  // ---- checkpoints: entering a non-hub region makes its checkpoint current.
  const checkpoints = nonHub.filter((l) => W.spawns.has(`spawn_cp_${l.region}`))
    .map((l) => ({ id: `cp_${l.id}`, spawn_ref: `spawn_cp_${l.region}`, trigger: { kind: "enter_region", ref: l.region } }));

  const required = objectives.filter((o) => !o.optional).length;
  const timed = TIMED_GENRES.has(genre);
  // Generous: 5 minutes plus 2.5 per required objective, in 30 s steps.
  const time_limit_s = timed ? Math.ceil((300 + 150 * required) / 30) * 30 : null;
  const terrain = world.terrain || {};
  const nav = world.navigation || {};
  const cam = world.camera || {};

  return {
    gameplay_version: GAMEPLAY_VERSION,
    game_type: genre,
    rules: {
      player_health: 100, lives: 3, fall_damage: false,
      fall_y: Math.round(((typeof terrain.min_y === "number" ? terrain.min_y : 0) - 15) * 100) / 100,
      time_limit_s,
    },
    movement: {
      walk_speed: 4.5, run_speed: 7.5, jump_velocity: 6.5, gravity: -20,
      max_slope_deg: typeof nav.max_slope_deg === "number" ? nav.max_slope_deg : 40,
      step_height: typeof nav.step_height === "number" ? nav.step_height : 0.45,
      air_control: 0.35, player_radius: 0.4, player_height: 1.8,
    },
    camera: {
      mode: ["third_person", "first_person", "top_down"].includes(cam.mode) ? cam.mode : "third_person",
      distance: typeof cam.distance === "number" ? cam.distance : 6,
      height: typeof cam.height === "number" ? cam.height : 2.5,
      fov: typeof cam.fov === "number" ? cam.fov : 60,
      sensitivity: 1,
    },
    interaction: { radius: 2.5, key: "KeyE", hold_ms: 0 },
    inventory: { slots: Math.max(8, items.length + 4), items },
    objectives,
    events,
    combat: hostiles.length
      ? { enabled: true, mode: "avoid", player_damage: 0, hazard_damage_per_s: 10 }
      : { enabled: false, mode: "none", player_damage: 0, hazard_damage_per_s: hazards.length ? 2 : 0 },
    hazards,
    progression: { xp_per_level: 100, max_level: 10 },
    difficulty: { level: "normal", damage_mult: 1, speed_mult: 1, time_mult: 1 },
    checkpoints,
    win_conditions: [{ kind: "all_required_objectives" }],
    lose_conditions: [
      { kind: "health_zero" }, { kind: "lives_zero" }, { kind: "fell_out" },
      ...(timed ? [{ kind: "time_expired" }] : []),
    ],
  };
}

const VERB = { altar: "Awaken", lantern: "Light", container: "Open", sign: "Read", door: "Unseal", lever: "Pull the lever at", switch: "Activate", terminal: "Boot", portal: "Open", pickup: "Take" };

// ------------------------------------------------------------- LLM merge

const MAX_TITLE = 80, MAX_DESC = 300, MAX_EXTRA = 3;
const clip = (v, n) => (typeof v === "string" && v.trim() ? v.trim().replace(/\s+/g, " ").slice(0, n) : null);

/**
 * Merge a model proposal onto a valid skeleton. Every accepted change is
 * re-validated with ctx; anything that breaks validation is dropped, and if the
 * merged result somehow fails, the untouched skeleton is returned.
 * Returns { gameplay, applied: { titles, extras, intro }, dropped: [reason] }.
 */
export function mergeProposal(skeleton, proposal, ctx) {
  const dropped = [];
  const applied = { titles: 0, extras: 0, intro: false };
  if (!proposal || typeof proposal !== "object") return { gameplay: skeleton, applied, dropped: ["proposal was not an object"] };
  const g = JSON.parse(JSON.stringify(skeleton));

  // Titles/descriptions for existing objectives — text only, never kind or targets.
  const byId = new Map(g.objectives.map((o) => [o.id, o]));
  for (const p of Array.isArray(proposal.objectives) ? proposal.objectives : []) {
    const o = p && byId.get(p.id);
    if (!o) { if (p?.id) dropped.push(`objective '${p.id}' is not in the skeleton`); continue; }
    const t = clip(p.title, MAX_TITLE), d = clip(p.description, MAX_DESC);
    if (t) o.title = t;
    if (d) o.description = d;
    if (t || d) applied.titles++;
  }
  const intro = clip(proposal.intro, MAX_DESC);
  const ev = g.events.find((e) => e.id === "ev_intro");
  const msg = ev?.actions.find((a) => a.kind === "message");
  if (intro && msg) { msg.value = intro; applied.intro = true; }

  // Extra optional objectives: each must target the right kind of entity.
  const idx = refIndex(g, ctx);
  const firstId = g.objectives[0]?.id;
  for (const x of (Array.isArray(proposal.extra_optional) ? proposal.extra_optional : []).slice(0, MAX_EXTRA * 2)) {
    if (applied.extras >= MAX_EXTRA) break;
    const kind = typeof x?.kind === "string" ? x.kind.trim().toLowerCase() : "";
    if (!["reach", "talk", "interact", "collect"].includes(kind)) { dropped.push(`extra kind '${x?.kind}' not allowed`); continue; }
    const target = typeof x.target_ref === "string" ? x.target_ref.trim() : "";
    const want = OBJECTIVE_TARGETS[kind][0];
    if (!idx[want]?.has(target)) { dropped.push(`extra target '${target}' is not a ${want}`); continue; }
    let id = `opt_${slugify(x.id || x.title || `${kind}_${target}`, "extra")}`.slice(0, 48), n = 2;
    const stem = id;
    while (byId.has(id)) id = `${stem}_${n++}`;
    const o = {
      id, title: clip(x.title, MAX_TITLE) || titleCase(`${kind} ${target}`), description: clip(x.description, MAX_DESC) || "",
      kind, target_ref: target, count: 1, requires: firstId ? [firstId] : [], optional: true, reward: { xp: 15 },
    };
    g.objectives.push(o);
    if (validateGameplay(g, ctx).ok) { byId.set(id, o); applied.extras++; }
    else { g.objectives.pop(); dropped.push(`extra '${id}' failed validation`); }
  }

  if (!validateGameplay(g, ctx).ok) return { gameplay: skeleton, applied: { titles: 0, extras: 0, intro: false }, dropped: [...dropped, "merged spec failed validation; kept skeleton"] };
  return { gameplay: g, applied, dropped };
}

const GAMEPLAY_SYSTEM = `You are the quest writer for a small 3D game. The objective structure is FIXED; you only write text and may suggest a few optional side objectives.
Return ONE JSON object and nothing else:
{
  "intro": string (one or two sentences shown at game start),
  "objectives": [ { "id": an id from the list you are given, "title": string (max 60 chars), "description": string (one sentence) } ],
  "extra_optional": [ { "title": string, "description": string, "kind": "reach"|"talk"|"interact"|"collect", "target_ref": an id from the matching list you are given } ]
}
Rules: never invent ids; at most 3 extra_optional; reach targets regions, talk targets characters, interact targets interactables, collect targets items. JSON only.`;

export function gameplayAdapters({ env = process.env, chat = null } = {}) {
  return [
    cerebrasJsonAdapter({
      lane: GAMEPLAY_LANE, system: GAMEPLAY_SYSTEM, env, chat, maxTokens: 3000, temperature: 0.6,
      build: (req) => [
        `Game: ${req.concept.title} — ${req.concept.logline}`,
        `Genre: ${req.concept.genre}. Mood: ${req.concept.mood}.`,
        `Objectives: ${JSON.stringify(req.skeleton.objectives.map((o) => ({ id: o.id, kind: o.kind, target_ref: o.target_ref, title: o.title })))}`,
        `Regions: ${JSON.stringify((req.world.regions || []).map((r) => r.id))}`,
        `Characters: ${JSON.stringify((req.characters?.characters || []).map((c) => ({ id: c.id, name: c.name, role: c.role })))}`,
        `Interactables: ${JSON.stringify((req.world.interactables || []).map((x) => x.id))}`,
        `Items: ${JSON.stringify(req.skeleton.inventory.items.map((i) => ({ id: i.id, name: i.name })))}`,
      ].join("\n"),
    }),
    localAdapter({ lane: GAMEPLAY_LANE, name: "local:gameplay-skeleton", produce: (req) => ({ skeleton: true }) }),
  ];
}

/**
 * CONTRACT §4.5 gameplay stage.
 * @returns {{ gameplay, provenance, merge?: { applied, dropped } }}
 */
export async function generateGameplay({ concept, world, characters, env = process.env, adapters } = {}) {
  if (!concept || !world) throw new TypeError("generateGameplay needs { concept, world, characters }");
  const ctx = { world, characters };
  const skeleton = gameplaySkeleton({ concept, world, characters });
  const sv = validateGameplay(skeleton, ctx);
  if (!sv.ok) {
    // The skeleton only references ids it read from the world, so this means the
    // world broke §4.5 in a way the skeleton could not route around. Fail loudly.
    const e = new Error(`gameplay skeleton does not validate against this world: ${sv.errors.slice(0, 5).map((x) => `${x.path}: ${x.message}`).join("; ")}`);
    e.validation = sv;
    throw e;
  }
  const fallback = localAdapter({ lane: GAMEPLAY_LANE, name: "local:gameplay-skeleton", produce: () => ({ skeleton: true }) });
  const lane = new Lane(GAMEPLAY_LANE, adapters ? withFallback(adapters, fallback) : gameplayAdapters({ env }));
  const { value, provenance } = await lane.run({ concept, world, characters, skeleton });

  if (provenance.status === STATUS.FALLBACK) return { gameplay: skeleton, provenance: stageProvenance("gameplay", provenance) };
  const { _model, _usage, ...proposal } = value;
  const merged = mergeProposal(skeleton, proposal, ctx);
  const changed = merged.applied.titles || merged.applied.extras || merged.applied.intro;
  return {
    gameplay: merged.gameplay,
    provenance: changed
      ? stageProvenance("gameplay", provenance, { usage: _usage, model: _model })
      // The model answered but nothing it said survived: the output is the
      // skeleton, so say FALLBACK — while still recording what the call cost.
      : { ...stageProvenance("gameplay", { ...provenance, provider: "local:gameplay-skeleton", model: _model || provenance.model }, { usage: _usage, statusOverride: STATUS.FALLBACK, extraFailed: [provenance.provider], billed: true }), model: "deterministic" },
    merge: { applied: merged.applied, dropped: merged.dropped },
  };
}
