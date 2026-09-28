// Games-D NPC/enemy behaviour presets. ISOMORPHIC (pure data + pure patches; the
// only imports are the iso rng and nav-grid modules and the plain-data budgets).
//
// Two hooks (CONTRACT §3):
//   npcConceptPatch(concept, ctx)          builds the roster: which characters exist,
//                                          their roles, themed names and archetypes.
//   applyNpcPresets(characters, ctx)       turns each character's archetype into a
//                                          CONTRACT §6 behavior block on the real world:
//                                          difficulty-scaled speed/sight, patrol loops on
//                                          walkable nav cells, keep-out discs for fairness.
//
// Everything here is deterministic: randomness comes from seeded() streams keyed
// by the recipe seed and the character id, never Math.random().
//
// Template needs read here (all optional; the templates declare them):
//   hostiles_min, hostiles_max   bounds on the hostile count (hostile_bonus is added to min)
//   companion                    false drops the companion, true guarantees one
//   vulnerable_min               at least this many hostiles a melee hit can defeat
//                                (role enemy/creature). A template with "defeat" in its
//                                kinds, or id/tag "hunt", defaults to max(2, hostiles_min).
//   archetypes                   explicit hostile archetype cycle, e.g. ["sentinel_patrol"]
//
// Concept characters carry add-only hints: `archetype` (read by applyNpcPresets),
// `kind` and `size` (read by the character stage for the body).
// The behaviour fields beyond §6 that the presets set (home, avoid, sight_los,
// chase_max_s, archetype) are add-only and implemented in src/gamesb/characters/npc-brain.mjs.

import { seeded, hashString, clamp, round2 } from "../../gamesb/common/rng.mjs";
import { isWalkable, findPath, nearestWalkable, cellCenter, reachableSet, navIndex } from "../../gamesb/world/nav-grid.mjs";
import { ASSET_BUDGET } from "../budgets.mjs";

// ---------------------------------------------------------------- archetypes
// Numbers are metres and m/s at "normal"; hostile ones are scaled by the
// difficulty's npc_speed_mult and sight_mult. The player walks 4.5 and runs 7.5.

export const ARCHETYPES = Object.freeze({
  sentinel_patrol: Object.freeze({
    id: "sentinel_patrol", hostile: true, route: "loop",
    summary: "Walks a fixed loop on walkable ground; runs down a player it can see (line of sight), gives up at a short leash and resumes the loop.",
    behavior: Object.freeze({ initial: "patrol", on_player_near: "chase", on_player_far: "patrol", speed: 2.6, sight_radius: 11, wander_radius: 0, leash_radius: 14, sight_los: true, chase_max_s: 6 }),
  }),
  guard_post: Object.freeze({
    id: "guard_post", hostile: true, route: null,
    summary: "Holds its post and turns to watch; lunges at a player who comes close, then walks back to the post.",
    behavior: Object.freeze({ initial: "guard", on_player_near: "chase", on_player_far: "guard", speed: 3.4, sight_radius: 8, wander_radius: 0, leash_radius: 10, sight_los: true, chase_max_s: 5 }),
  }),
  stalker: Object.freeze({
    id: "stalker", hostile: true, route: null,
    summary: "Prowls around its lair; chases on sight and is quick, but leashes back home past its leash radius.",
    behavior: Object.freeze({ initial: "wander", on_player_near: "chase", on_player_far: "wander", speed: 3.9, sight_radius: 13, wander_radius: 7, leash_radius: 20, chase_max_s: 8 }),
  }),
  swarm: Object.freeze({
    id: "swarm", hostile: true, route: null, size: "small",
    summary: "A pack of 2–3 small, slow, short-sighted hostiles milling around one shared spot.",
    behavior: Object.freeze({ initial: "wander", on_player_near: "chase", on_player_far: "wander", speed: 3.0, sight_radius: 7, wander_radius: 5, leash_radius: 10, chase_max_s: 6 }),
  }),
  wanderer: Object.freeze({
    id: "wanderer", hostile: false, route: null,
    summary: "Ambient local strolling around home and lingering between strolls.",
    behavior: Object.freeze({ initial: "wander", speed: 1.2, sight_radius: 5, wander_radius: 8, leash_radius: 12 }),
  }),
  skittish: Object.freeze({
    id: "skittish", hostile: false, route: null, size: "small",
    summary: "Harmless critter: potters about, bolts from a close player (never past its leash) and wanders home after.",
    behavior: Object.freeze({ initial: "wander", on_player_near: "flee", on_player_far: "wander", speed: 2.2, sight_radius: 5, wander_radius: 6, leash_radius: 12 }),
  }),
  companion: Object.freeze({
    id: "companion", hostile: false, route: null,
    summary: "Follows 2–4 m behind the player, backs off when crowded, teleports to catch up. NPCs never collide with the player, so it cannot block a path.",
    behavior: Object.freeze({ initial: "follow_player", speed: 6.2, sight_radius: 12, wander_radius: 0, leash_radius: 40 }),
  }),
  vendor: Object.freeze({
    id: "vendor", hostile: false, route: null,
    summary: "Stands at its stall, turns to face a nearby player and plays the talk anim in conversation.",
    behavior: Object.freeze({ initial: "idle", speed: 1.4, sight_radius: 6, wander_radius: 0, leash_radius: 6 }),
  }),
  quest: Object.freeze({
    id: "quest", hostile: false, route: null,
    summary: "The quest giver: holds still at its post and faces the player when near or talking.",
    behavior: Object.freeze({ initial: "idle", speed: 1.4, sight_radius: 7, wander_radius: 0, leash_radius: 6 }),
  }),
});

const ROLE_ARCHETYPE = { companion: "companion", quest_giver: "quest", merchant: "vendor", ambient: "wanderer", guard: "guard_post", enemy: "sentinel_patrol", creature: "stalker" };
const HOSTILE_ROLES = new Set(["guard", "enemy", "creature"]);
const VULNERABLE_ROLES = new Set(["enemy", "creature"]);
const ROBOTIC = new Set(["city", "scifi_base"]);

// Fairness constants (metres).
export const SENTINEL_RADIUS = 3;         // mirrors runtime/sim-core.mjs: a hostile hurts inside this ring
export const SPAWN_CLEAR_R = 10;          // no hostile ever enters this disc around spawn_player
export const CHECKPOINT_CLEAR_R = 7;      // ...or around a checkpoint (the respawn spot)
export const POST_CLEAR_R = 6.5;          // ...or around a quest giver's / vendor's post
export const MIN_SPAWN_GAP = 18;          // a hostile starts at least this far from spawn_player
export const MAX_HOSTILE_SPEED = 5.2;     // well under the player's run (7.5)
const SCALE_HOSTILE_CAP = { small: 4, medium: 5, large: 6 };

// ---------------------------------------------------------------- names

// biome → archetype → [name, kind hint]
const NAMES = {
  island:     { stalker: ["Reef Stalker", "creature"], sentinel_patrol: ["Tide Sentinel", "spirit"], guard_post: ["Wreck Warden", "humanoid"], swarm: ["Snapper Crab", "creature"], skittish: ["Sand Piper", "creature"] },
  forest:     { stalker: ["Thorn Wolf", "creature"], sentinel_patrol: ["Bramble Sentinel", "spirit"], guard_post: ["Oak Warden", "humanoid"], swarm: ["Needle Wasp", "creature"], skittish: ["Moss Hare", "creature"] },
  desert:     { stalker: ["Dune Stalker", "creature"], sentinel_patrol: ["Sandglass Sentinel", "spirit"], guard_post: ["Oasis Warden", "humanoid"], swarm: ["Dust Mite", "creature"], skittish: ["Sand Hopper", "creature"] },
  snow:       { stalker: ["Frost Stalker", "creature"], sentinel_patrol: ["Frost Wisp", "spirit"], guard_post: ["Glacier Warden", "humanoid"], swarm: ["Ice Mite", "creature"], skittish: ["Snow Hare", "creature"] },
  volcanic:   { stalker: ["Cinder Hound", "creature"], sentinel_patrol: ["Magma Sentinel", "spirit"], guard_post: ["Vent Warden", "humanoid"], swarm: ["Ember Imp", "spirit"], skittish: ["Ash Beetle", "creature"] },
  canyon:     { stalker: ["Rock Stalker", "creature"], sentinel_patrol: ["Mesa Sentinel", "spirit"], guard_post: ["Gorge Warden", "humanoid"], swarm: ["Canyon Wasp", "creature"], skittish: ["Dust Lizard", "creature"] },
  ruins:      { stalker: ["Grave Stalker", "creature"], sentinel_patrol: ["Stone Sentinel", "spirit"], guard_post: ["Gate Warden", "humanoid"], swarm: ["Hollow Wisp", "spirit"], skittish: ["Ruin Moth", "creature"] },
  city:       { stalker: ["Hunter Drone", "robot"], sentinel_patrol: ["Patrol Drone", "robot"], guard_post: ["Checkpoint Drone", "robot"], swarm: ["Scrap Drone", "robot"], skittish: ["Street Cat", "creature"] },
  scifi_base: { stalker: ["Hunter Drone", "robot"], sentinel_patrol: ["Security Drone", "robot"], guard_post: ["Turret Sentry", "robot"], swarm: ["Swarm Bot", "robot"], skittish: ["Maintenance Bot", "robot"] },
};

const DESCRIBE = {
  sentinel_patrol: (n) => `A ${n.toLowerCase()} that walks the same beat over and over. Learn the loop and slip past.`,
  guard_post: (n) => `A ${n.toLowerCase()} that never leaves its post, but lunges at anyone who gets close.`,
  stalker: (n) => `A ${n.toLowerCase()} that prowls near its lair and runs down whatever it spots.`,
  swarm: (n) => `One of a pack of ${n.toLowerCase()}s: weak alone, dangerous together.`,
  skittish: (n) => `A harmless ${n.toLowerCase()} that bolts if you come too close.`,
};
const HAZARD_LINE = {
  sentinel_patrol: (n) => `${n} patrolling a fixed loop`,
  guard_post: (n) => `${n} guarding its post`,
  stalker: (n) => `${n} hunting near its lair`,
  swarm: (n) => `A pack of ${n}s`,
};

const PLANS = {
  stealth: ["sentinel_patrol", "sentinel_patrol", "guard_post", "sentinel_patrol", "stalker", "sentinel_patrol"],
  // No swarm in a hunt: every hunted hostile is a defeat target, and a pack-mate
  // standing on the target makes "close in on one, keep clear of the rest" impossible.
  hunt: ["stalker", "stalker", "sentinel_patrol", "stalker", "guard_post", "sentinel_patrol"],
  survival: ["stalker", "swarm", "swarm", "stalker", "sentinel_patrol", "guard_post"],
  puzzle: ["guard_post", "sentinel_patrol", "stalker"],
  default: ["stalker", "sentinel_patrol", "guard_post", "swarm", "swarm", "sentinel_patrol"],
};

const slug = (s) => String(s || "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "npc";
const int = (v, d) => (Number.isInteger(v) && v >= 0 ? v : d);
const note = (ctx, s) => { if (Array.isArray(ctx?.notes)) ctx.notes.push(`npc: ${s}`); };

function templateStyle(ctx, genre) {
  const t = ctx?.template || {};
  const words = [t.id, t.genre, genre, ...(Array.isArray(t.tags) ? t.tags : [])].map((w) => String(w || "").toLowerCase());
  const kinds = Array.isArray(t.kinds) ? t.kinds : [];
  // "relic_hunt" is a collectathon: only a whole-word hunt, or defeat objectives, make a hunt.
  if (kinds.includes("defeat") || words.some((w) => ["hunt", "combat", "arena"].includes(w))) return "hunt";
  if (words.some((w) => /stealth|sneak|heist/.test(w))) return "stealth";
  if (words.includes("survival")) return "survival";
  if (words.includes("puzzle")) return "puzzle";
  return "default";
}

function hostileRole(arch, style, biome) {
  if (style === "hunt") return ROBOTIC.has(biome) || arch !== "stalker" ? "enemy" : "creature";
  if (arch === "guard_post") return "guard";
  if (arch === "sentinel_patrol") return style === "stealth" ? "guard" : "enemy";
  if (arch === "stalker") return ROBOTIC.has(biome) ? "enemy" : "creature";
  return "enemy"; // swarm
}

/**
 * The roster plan (counts and archetypes, no names). Exposed for tests.
 * @returns {{ hostiles, archetypes: string[], style, companion: boolean, vulnerable_min, budget, scale }}
 */
export function rosterPlan(ctx, { genre, scale } = {}) {
  const needs = ctx?.template?.needs || {};
  const style = templateStyle(ctx, genre || ctx?.template?.genre || "adventure");
  const sc = ASSET_BUDGET[scale] ? scale : ASSET_BUDGET[ctx?.scale] ? ctx.scale : "medium";
  const budget = ASSET_BUDGET[sc].characters;
  const bonus = int(ctx?.difficulty?.hostile_bonus, 0);
  const minH = int(needs.hostiles_min, style === "puzzle" ? 0 : 1);
  const maxH = int(needs.hostiles_max, style === "puzzle" ? 1 : SCALE_HOSTILE_CAP[sc]);
  const vulnerable_min = int(needs.vulnerable_min, style === "hunt" ? Math.max(2, minH) : 0);
  const lo = Math.max(minH, vulnerable_min);
  let hostiles = clamp(minH + bonus, lo, Math.max(maxH, lo));
  const cycle = Array.isArray(needs.archetypes) && needs.archetypes.some((a) => ARCHETYPES[a]?.hostile)
    ? needs.archetypes.filter((a) => ARCHETYPES[a]?.hostile) : PLANS[style];
  // Always kept: the quest giver, plus the companion unless declined.
  const companion = needs.companion !== false;
  hostiles = Math.max(0, Math.min(hostiles, budget - 1 - (companion ? 1 : 0)));
  const archetypes = [];
  for (let k = 0; k < hostiles; k++) archetypes.push(cycle[k % cycle.length]);
  // A lone swarm member is not a swarm: make it a sentinel instead.
  if (archetypes.filter((a) => a === "swarm").length === 1) archetypes[archetypes.indexOf("swarm")] = "sentinel_patrol";
  return { hostiles, archetypes, style, companion, vulnerable_min: Math.min(vulnerable_min, hostiles), budget, scale: sc };
}

/**
 * Rebuild concept.characters: keep the quest giver (first), the companion, one
 * merchant and one ambient local; replace every hostile with the planned themed
 * hostiles; add a skittish critter when the budget has headroom. Never throws.
 */
export function npcConceptPatch(concept, ctx) {
  try {
    return rosterPatch(concept, ctx);
  } catch (e) {
    note(ctx, `roster patch failed (${e.message}); kept the generated roster`);
    return concept;
  }
}

function rosterPatch(concept, ctx) {
  const chars0 = Array.isArray(concept.characters) ? concept.characters : [];
  const biome = NAMES[ctx?.theme?.biome] ? ctx.theme.biome : NAMES[concept.biome] ? concept.biome : "forest";
  const plan = rosterPlan(ctx, { genre: ctx?.template?.genre || concept.genre, scale: concept.scale || ctx?.scale });
  const themed = ctx?.theme?.npc_names && typeof ctx.theme.npc_names === "object" ? ctx.theme.npc_names : {};
  const nameFor = (arch) => {
    const t = themed[arch];
    if (typeof t === "string" && t.trim()) return [t.trim(), NAMES[biome][arch][1]];
    if (Array.isArray(t) && typeof t[0] === "string") return [t[0], t[1] || NAMES[biome][arch][1]];
    return NAMES[biome][arch];
  };

  const giver = chars0.find((c) => c.role === "quest_giver");
  let companion = plan.companion ? chars0.find((c) => c.role === "companion") : null;
  const merchant = chars0.find((c) => c.role === "merchant");
  const ambient = chars0.find((c) => c.role === "ambient");
  const out = [];
  const used = new Set();
  const take = (c) => { used.add(c.id); out.push(c); };
  if (giver) take({ ...giver, archetype: "quest" });
  else {
    take({ id: "keeper", name: "The Keeper", role: "quest_giver", description: "Waits in the hub and knows what went wrong.", archetype: "quest" });
    note(ctx, "no quest giver in the generated concept; added one");
  }
  if (plan.companion && !companion && ctx?.template?.needs?.companion === true) {
    companion = { id: "companion_pip", name: "Pip", role: "companion", description: "A small friend who follows you everywhere." };
  }
  if (companion) take({ ...companion, archetype: "companion" });

  // Hostiles: themed names, unique slug ids.
  const hostiles = [];
  const nameCount = {};
  for (const arch of plan.archetypes) {
    const [nm, kind] = nameFor(arch);
    nameCount[nm] = (nameCount[nm] || 0) + 1;
    const n = nameCount[nm];
    let id = n === 1 ? slug(nm) : `${slug(nm)}_${n}`;
    while (used.has(id)) id = `${id}_b`;
    used.add(id);
    hostiles.push({
      id, name: n === 1 ? nm : `${nm} ${n}`, role: hostileRole(arch, plan.style, biome), description: DESCRIBE[arch](nm),
      archetype: arch, kind, ...(ARCHETYPES[arch].size ? { size: ARCHETYPES[arch].size } : {}),
    });
  }
  // Vulnerable minimum (a hunt needs things it can defeat).
  let vul = hostiles.filter((h) => VULNERABLE_ROLES.has(h.role)).length;
  for (const h of hostiles) {
    if (vul >= plan.vulnerable_min) break;
    if (!VULNERABLE_ROLES.has(h.role)) { h.role = h.archetype === "stalker" && !ROBOTIC.has(biome) ? "creature" : "enemy"; vul++; }
  }

  // Optional extras, dropped first when the budget is tight.
  const extras = [];
  if (merchant && !used.has(merchant.id)) extras.push({ ...merchant, archetype: "vendor" });
  if (ambient && !used.has(ambient.id)) extras.push({ ...ambient, archetype: "wanderer" });
  const [cn, ck] = nameFor("skittish");
  let critterId = slug(cn);
  while (used.has(critterId) || extras.some((e) => e.id === critterId)) critterId = `${critterId}_b`;
  const room = plan.budget - out.length - hostiles.length;
  const picked = extras.slice(0, Math.max(0, room));
  // The critter only when it still leaves one slot of headroom under the budget.
  if (picked.length + 1 < room) picked.push({ id: critterId, name: cn, role: "ambient", description: DESCRIBE.skittish(cn), archetype: "skittish", kind: ck, size: "small" });

  // Hazard lines: drop the generator's hostile lines, add one per hostile kind.
  const oldHostileNames = chars0.filter((c) => HOSTILE_ROLES.has(c.role)).map((c) => c.name).filter(Boolean);
  const hz = (Array.isArray(concept.hazards) ? concept.hazards : []).filter((h) => !oldHostileNames.some((n) => String(h).includes(n)));
  const seen = new Set();
  for (const h of hostiles) {
    const base = nameFor(h.archetype)[0];
    if (seen.has(base)) continue;
    seen.add(base);
    hz.push(HAZARD_LINE[h.archetype](base));
  }
  if (!hz.length) hz.push("Unstable ground near the old structures");
  return { ...concept, characters: [...out, ...hostiles, ...picked], hazards: hz };
}

// ---------------------------------------------------------------- presets

/** Keep-out discs a hostile must never enter (npc-brain `avoid`), with the reason for each. */
export function fairnessZones(world, characters) {
  const zones = [];
  const spawns = world?.spawn_points || [];
  const sp = spawns.find((s) => s.id === "spawn_player");
  if (sp) zones.push({ x: sp.position.x, z: sp.position.z, r: SPAWN_CLEAR_R, why: "spawn_player" });
  for (const s of spawns) if (s.kind === "checkpoint") zones.push({ x: s.position.x, z: s.position.z, r: CHECKPOINT_CLEAR_R, why: s.id });
  const pls = new Map((world?.placements || []).map((p) => [p.id, p]));
  for (const ix of world?.interactables || []) {
    const pl = ix.placement_ref ? pls.get(ix.placement_ref) : null;
    if (pl) zones.push({ x: pl.position.x, z: pl.position.z, r: (ix.radius || 2) + SENTINEL_RADIUS + 0.5, why: ix.id });
  }
  for (const ch of characters || []) {
    if (ch.behavior?.hostile || !["quest_giver", "merchant"].includes(ch.role)) continue;
    const s = spawns.find((q) => q.id === ch.spawn_ref);
    if (s) zones.push({ x: s.position.x, z: s.position.z, r: POST_CLEAR_R, why: `post_${ch.id}` });
  }
  return zones.map((z) => ({ x: round2(z.x), z: round2(z.z), r: round2(z.r), why: z.why }));
}

const inZones = (zones, x, z, pad = 0) => zones.some((q) => Math.hypot(x - q.x, z - q.z) < q.r + pad);

/**
 * Assign archetypes and build behaviours on the real world. Never throws.
 * @param {object} characters CharactersSpec
 * @param {object} ctx stage ctx & { world, concept }
 */
export function applyNpcPresets(characters, ctx) {
  try {
    return presets(characters, ctx);
  } catch (e) {
    note(ctx, `presets failed (${e.message}); kept the Games-B behaviours`);
    return characters;
  }
}

function presets(spec, ctx) {
  if (!spec || !Array.isArray(spec.characters)) return spec;
  const world = ctx?.world;
  const concept = ctx?.concept || {};
  const nav = world?.navigation;
  const diff = ctx?.difficulty || {};
  const speedMult = Number.isFinite(diff.npc_speed_mult) ? diff.npc_speed_mult : 1;
  const sightMult = Number.isFinite(diff.sight_mult) ? diff.sight_mult : 1;
  const archOf = new Map((concept.characters || []).map((c) => [c.id, c.archetype]));
  const spawns = world?.spawn_points || [];
  const sp = spawns.find((s) => s.id === "spawn_player")?.position || null;
  const navOk = !!(nav && typeof nav.walkable === "string" && nav.cell > 0 && world?.size);
  const reach = navOk && sp ? reachableSet(nav, sp) : null;
  const seed = int(ctx?.recipe?.seed, int(concept.seed, 1));

  // Behaviours first (hostile flags feed the zones), then the placement-dependent parts.
  const chars = spec.characters.map((ch) => {
    let arch = archOf.get(ch.id);
    if (!ARCHETYPES[arch]) arch = ROLE_ARCHETYPE[ch.role] || "wanderer";
    if (ch.role === "companion" || ch.companion) arch = "companion"; // a companion is never hostile
    const A = ARCHETYPES[arch];
    const b = { ...A.behavior, patrol: [], hostile: A.hostile, archetype: arch };
    if (A.hostile) {
      b.speed = round2(Math.min(MAX_HOSTILE_SPEED, b.speed * speedMult));
      b.sight_radius = round2(b.sight_radius * sightMult);
      b.leash_radius = round2(Math.max(b.leash_radius, b.sight_radius * 1.15));
    } else if (arch === "skittish") {
      b.sight_radius = round2(b.sight_radius * sightMult);
    }
    return { ...ch, behavior: b };
  });
  const zones = fairnessZones(world, chars);
  const avoid = zones.map(({ x, z, r }) => ({ x, z, r }));
  const regions = new Map((world?.regions || []).map((r) => [r.id, r]));
  let swarmHome = null, swarmK = 0;

  const out = chars.map((ch) => {
    const b = { ...ch.behavior };
    const A = ARCHETYPES[b.archetype];
    const spawn = spawns.find((s) => s.id === ch.spawn_ref) || null;
    if (!A.hostile || !navOk || !spawn) {
      if (A.hostile && !navOk) note(ctx, `${ch.id}: no navigation; patrol disabled`);
      if (b.initial === "patrol") degradeToGuard(b);
      return { ...ch, behavior: b };
    }
    const r = seeded((hashString(`npc|${ch.id}`) ^ seed) >>> 0);
    const region = regions.get(spawn.region) || null;
    const box = region?.bounds || [0, 0, world.size.w, world.size.h];
    const fair = (idx, pad = 1) => {
      if (reach && !reach.has(idx)) return false;
      const p = cellCenter(nav, idx);
      if (inZones(zones, p.x, p.z, pad)) return false;
      return !sp || Math.hypot(p.x - sp.x, p.z - sp.z) >= MIN_SPAWN_GAP;
    };
    const inBox = (idx) => { const p = cellCenter(nav, idx); return p.x >= box[0] && p.z >= box[1] && p.x <= box[2] && p.z <= box[3]; };
    // A post in open ground, not a nook between walls: a hunter who defeats the
    // NPC there must be able to walk straight back out.
    const open = (idx, ring) => clearance(nav, idx, ring);

    // Home: the spawn if it is fair, else the nearest fair cell (in its region first).
    // Swarm members after the first gather round the first one's home.
    let home = { x: spawn.position.x, z: spawn.position.z };
    if (b.archetype === "swarm" && swarmHome) {
      const a = (swarmK++ * 2 * Math.PI) / 3 + r.range(-0.3, 0.3);
      const idx = nearestWalkable(nav, swarmHome.x + Math.cos(a) * 2.5, swarmHome.z + Math.sin(a) * 2.5, 6, (i) => fair(i));
      if (idx >= 0) home = cellCenter(nav, idx);
    }
    const hi = navIndex(nav, home.x, home.z);
    if (hi < 0 || !isWalkable(nav, home.x, home.z) || !fair(hi, 0.5) || !open(hi, 1)) {
      let idx = -1;
      for (const ring of [2, 1, 0]) {
        if (idx < 0) idx = nearestWalkable(nav, home.x, home.z, 24, (i) => fair(i) && inBox(i) && open(i, ring));
      }
      if (idx < 0) idx = nearestWalkable(nav, home.x, home.z, 48, (i) => fair(i) && open(i, 1));
      if (idx < 0) idx = nearestWalkable(nav, home.x, home.z, 48, (i) => fair(i));
      if (idx >= 0) home = cellCenter(nav, idx);
      else note(ctx, `${ch.id}: no fair post near its spawn`);
    }
    if (b.archetype === "swarm" && !swarmHome) { swarmHome = home; swarmK = 1; }
    if (Math.hypot(home.x - spawn.position.x, home.z - spawn.position.z) > 1e-6) b.home = { x: round2(home.x), z: round2(home.z) };
    b.avoid = avoid;

    if (A.route === "loop") {
      let loop = patrolLoop(nav, home, box, zones, r, fair);
      // A cramped region (a canyon notch, a walled yard): let the beat spill a little past it.
      if (loop.length < 3) {
        const wide = [Math.max(0, box[0] - 12), Math.max(0, box[1] - 12), Math.min(world.size.w, box[2] + 12), Math.min(world.size.h, box[3] + 12)];
        const alt = patrolLoop(nav, home, wide, zones, r, fair);
        if (alt.length > loop.length) loop = alt;
      }
      if (loop.length >= 2) b.patrol = loop;
      else { degradeToGuard(b); note(ctx, `${ch.id}: no room for a patrol loop; holds a post instead`); }
    }
    return { ...ch, behavior: b };
  });

  // Critters make noises, not villager small talk.
  const dialogues = (spec.dialogues || []).map((d) => {
    const ch = out.find((c) => c.id === d.character_ref);
    if (!ch || ch.behavior?.archetype !== "skittish") return d;
    return {
      id: d.id, character_ref: d.character_ref, entry: [{ node: "wary", conditions: [] }],
      nodes: [{ id: "wary", speaker: ch.name, text: `The ${String(ch.name).toLowerCase()} freezes, watches you with one bright eye, and looks ready to bolt.`, choices: [{ text: "Leave it be.", next: null }] }],
    };
  });
  return { ...spec, characters: out, dialogues };
}

/** Every cell within `ring` cells of idx is walkable. */
function clearance(nav, idx, ring) {
  if (ring <= 0) return true;
  const i0 = idx % nav.cols, j0 = (idx - i0) / nav.cols;
  for (let dj = -ring; dj <= ring; dj++) for (let di = -ring; di <= ring; di++) {
    const i = i0 + di, j = j0 + dj;
    if (i < 0 || j < 0 || i >= nav.cols || j >= nav.rows || nav.walkable.charCodeAt(j * nav.cols + i) !== 49) return false;
  }
  return true;
}

function degradeToGuard(b) {
  b.patrol = [];
  b.initial = "guard";
  if (b.on_player_far === "patrol") b.on_player_far = "guard";
  if (b.on_player_near === "patrol") b.on_player_near = "guard";
}

/**
 * A 4-corner loop around home on walkable, fair cells inside the region box.
 * Every leg, the closing one included, is checked along the real nav path:
 * no blocked cell, no keep-out disc, no long detour.
 */
function patrolLoop(nav, home, box, zones, r, fair) {
  const rad = clamp(Math.min(box[2] - box[0], box[3] - box[1]) * 0.3, 4, 12);
  const phase = r.range(0, Math.PI / 2);
  const inBox = (idx) => { const p = cellCenter(nav, idx); return p.x >= box[0] + 1 && p.z >= box[1] + 1 && p.x <= box[2] - 1 && p.z <= box[3] - 1; };
  // Eight bearings round the compass at two radii; the loop keeps up to four
  // corners in bearing order, so it walks round rather than zig-zagging.
  let best = [];
  for (const rr of [rad, rad * 0.6]) {
    const cands = [];
    for (let k = 0; k < 8; k++) {
      const a = phase + (k * Math.PI) / 4;
      const x = clamp(home.x + Math.cos(a) * rr, box[0] + 1, box[2] - 1), z = clamp(home.z + Math.sin(a) * rr, box[1] + 1, box[3] - 1);
      const idx = nearestWalkable(nav, x, z, 4, (i) => fair(i) && inBox(i));
      if (idx < 0) continue;
      const p = cellCenter(nav, idx);
      if (!cands.some((q) => Math.hypot(q.x - p.x, q.z - p.z) < 2.5)) cands.push({ x: round2(p.x), z: round2(p.z), k });
    }
    for (const start of [0, 1]) {
      const pts = [];
      let from = home, lastK = -2;
      for (const p of cands) {
        if (p.k < start || p.k - lastK < 2 || pts.length >= 4) continue; // every other bearing: 4 corners
        if (legOk(nav, from, p, zones)) { pts.push({ x: p.x, z: p.z }); from = p; lastK = p.k; }
      }
      while (pts.length >= 2 && !legOk(nav, pts[pts.length - 1], pts[0], zones)) pts.pop();
      if (pts.length > best.length) best = pts;
      if (best.length >= 4) return best;
    }
  }
  return best.length >= 2 ? best : [];
}

function legOk(nav, a, b, zones) {
  const straight = Math.hypot(b.x - a.x, b.z - a.z);
  if (straight < 1e-6) return false;
  const path = findPath(nav, a, b);
  if (!Array.isArray(path) || path.length === 0) return false;
  const poly = [a, ...path, b];
  let len = 0;
  for (let k = 1; k < poly.length; k++) {
    const p = poly[k - 1], q = poly[k];
    const d = Math.hypot(q.x - p.x, q.z - p.z);
    len += d;
    const steps = Math.max(1, Math.ceil(d / 0.5));
    for (let s = 0; s <= steps; s++) {
      const x = p.x + ((q.x - p.x) * s) / steps, z = p.z + ((q.z - p.z) * s) / steps;
      if (inZones(zones, x, z, 0.3)) return false;
      if (k > 1 && k < poly.length - 1 && !isWalkable(nav, x, z)) return false;
    }
  }
  return len <= straight * 2.5 + 6;
}
