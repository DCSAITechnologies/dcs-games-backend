// Games-B character stage (CONTRACT §6, pipeline §4.5):
//   generateCharacters({ concept, world }) → CharactersSpec
//
// Synchronous and deterministic: every random choice comes from a stream seeded
// by concept.seed and the character id, so adding a character never reshuffles
// the others. No provider call happens here. The concept already carries the
// names and descriptions, and the stage's job is to turn them into bodies,
// behaviours and dialogue that the runtime can execute and the validator can
// prove are sound.
//
// Written without Node imports, so the browser editor could run it too, but it
// is not on the ISOMORPHIC list and nothing relies on that.

import { seeded, hashString, clamp, round2 } from "../common/rng.mjs";
import { navWalkable } from "./character.schema.mjs";

export const CHARACTER_SPEC_VERSION = "1.0.0";

// The player's walk speed is fixed later by the gameplay stage. This is the
// assumed default; the companion must outpace it or it falls behind forever.
export const ASSUMED_PLAYER_WALK = 4.5;

const SKIN_TONES = ["#f1d3b8", "#e0b594", "#c68e67", "#a86f4c", "#7d4f33", "#5a3825"];

// Role → base behaviour. Numbers are metres and m/s.
const BEHAVIOR = {
  companion: { initial: "follow_player", speed: 6.2, sight_radius: 12, wander_radius: 0, leash_radius: 40, hostile: false },
  quest_giver: { initial: "idle", speed: 1.4, sight_radius: 6, wander_radius: 0, leash_radius: 6, hostile: false },
  merchant: { initial: "idle", speed: 1.4, sight_radius: 6, wander_radius: 0, leash_radius: 6, hostile: false },
  // A guard walks its beat and stops to watch the player go by.
  guard: { initial: "patrol", speed: 1.8, sight_radius: 8, wander_radius: 0, leash_radius: 20, hostile: false, on_player_near: "idle", on_player_far: "patrol" },
  // Sentinels: patrol, chase what they see, and give up at the leash.
  enemy: { initial: "patrol", speed: 3.6, sight_radius: 14, wander_radius: 0, leash_radius: 30, hostile: true, on_player_near: "chase", on_player_far: "patrol" },
  creature: { initial: "patrol", speed: 3.2, sight_radius: 10, wander_radius: 0, leash_radius: 24, hostile: true, on_player_near: "chase", on_player_far: "patrol" },
  ambient: { initial: "wander", speed: 1.2, sight_radius: 5, wander_radius: 8, leash_radius: 12, hostile: false },
};

/**
 * @param {{ concept: object, world?: object }} args
 * @returns {object} CharactersSpec
 */
export function generateCharacters({ concept, world } = {}) {
  if (!concept || !Array.isArray(concept.characters)) throw new TypeError("generateCharacters needs a concept with characters[]");
  const seed = Number.isInteger(concept.seed) ? concept.seed : hashString(concept.title || "gamesb");
  const locs = Array.isArray(concept.key_locations) ? concept.key_locations : [];
  const items = pickupItems(world);
  const characters = [];
  const dialogues = [];
  let companionTaken = false;

  for (const cc of concept.characters) {
    const r = seeded((seed ^ hashString(`char:${cc.id}`)) >>> 0);
    const role = BEHAVIOR[cc.role] ? cc.role : "ambient";
    const kind = kindFor(role, cc, concept.biome);
    const spawnRef = `spawn_npc_${cc.id}`;
    const spawn = (world?.spawn_points || []).find((s) => s.id === spawnRef) || null;
    const behavior = behaviorFor(role, spawn, world, r);
    const isCompanion = role === "companion" && !companionTaken;
    if (isCompanion) companionTaken = true;
    const hasDialogue = role !== "enemy";
    const ch = {
      id: cc.id,
      name: cc.name,
      role: cc.role,
      kind,
      body: bodyFor(role, kind, cc, concept, r),
      asset_ref: `char:${cc.id}`,
      spawn_ref: spawnRef,
      behavior,
      dialogue_ref: hasDialogue ? `dlg_${cc.id}` : null,
      interaction_radius: role === "enemy" ? 0 : role === "companion" ? 3 : 2.5,
      companion: isCompanion,
      invulnerable: !(role === "enemy" || role === "creature"),
    };
    characters.push(ch);
    if (hasDialogue) dialogues.push(dialogueFor(ch, cc, concept, locs, items, r));
  }
  return { character_spec_version: CHARACTER_SPEC_VERSION, characters, dialogues };
}

// ---------------------------------------------------------------------------
// Bodies

// Optional concept-character hints (add-only; the Games-B concept never sets them):
//   kind: "humanoid"|"creature"|"robot"|"spirit"   overrides the name/role guess
//   size: "small"|"large"                          scales the body (a swarm member, a brute)
const KIND_HINTS = ["humanoid", "creature", "robot", "spirit"];
const SIZE_MULT = { small: 0.6, large: 1.25 };
const HOSTILE_BODY_ROLES = new Set(["enemy", "creature", "guard"]);

const has = (cc, re) => re.test(`${cc.name || ""} ${cc.description || ""} ${cc.id || ""}`.toLowerCase());

function kindFor(role, cc, biome) {
  if (KIND_HINTS.includes(cc.kind)) return cc.kind;
  if (has(cc, /\b(robot|drone|automaton|machine|mech|android|construct)\b/)) return "robot";
  if (has(cc, /\b(spirit|ghost|wisp|shade|phantom|wraith|spectre|specter)\b/)) return "spirit";
  if (role === "companion") return has(cc, /\b(fox|dog|cat|wolf|hound|otter|bird|pup|beast)\b/) ? "creature"
    : biome === "scifi_base" ? "robot" : biome === "ruins" ? "spirit" : "creature";
  if (role === "enemy") return biome === "scifi_base" || biome === "city" ? "robot" : biome === "ruins" || biome === "volcanic" ? "spirit" : "creature";
  if (role === "creature") return "creature";
  return "humanoid";
}

function bodyFor(role, kind, cc, concept, r) {
  const pal = concept.palette || {};
  const primary = hexOr(pal.primary, "#5a6e8c"), secondary = hexOr(pal.secondary, "#c9b28a"), accent = hexOr(pal.accent, "#f2c14e");
  const ground = hexOr(pal.ground, "#7a6a50");
  let height, build, locomotion, glow = null;
  const palette = { skin: r.pick(SKIN_TONES), primary, secondary, accent };
  const accessories = [];

  if (kind === "humanoid") {
    locomotion = "biped";
    height = round2(r.range(1.62, 1.9));
    build = role === "guard" ? "broad" : role === "merchant" ? r.pick(["average", "broad"]) : r.pick(["slim", "average"]);
    if (role === "quest_giver") {
      // The keeper archetype: hooded, carrying the light the story turns on.
      // A station or city has no lantern-keeper; the same role reads as a technician there.
      if (concept.biome === "scifi_base" || concept.biome === "city") accessories.push("goggles", "backpack");
      else accessories.push("hood", "lantern");
      palette.primary = shade(primary, -0.25); palette.secondary = secondary;
    } else if (role === "merchant") {
      accessories.push("satchel", "hat");
      palette.primary = secondary; palette.secondary = shade(primary, 0.1);
    } else if (role === "guard") {
      // "hat" is the only headgear in the enum; the asset stage reads a
      // guard's hat as a helmet (see the character doc).
      accessories.push("hat", "staff", "cape");
      palette.primary = shade(primary, -0.35); palette.secondary = shade(secondary, -0.2);
    } else {
      accessories.push(r.pick(["hat", "backpack", "scarf"]));
      palette.primary = shade(ground, 0.15); palette.secondary = shade(secondary, -0.1);
    }
    if (concept.biome === "snow" && !accessories.includes("scarf")) accessories.push("scarf");
    if ((concept.biome === "desert" || concept.weather === "sandstorm") && !accessories.includes("goggles")) accessories.push("goggles");
  } else if (role === "companion") {
    locomotion = kind === "creature" ? "quadruped" : "hover";
    height = round2(kind === "creature" ? r.range(0.55, 0.8) : r.range(0.6, 0.9));
    build = "slim";
    palette.skin = kind === "creature" ? shade(ground, 0.35) : shade(accent, 0.4);
    palette.primary = shade(secondary, 0.2); palette.secondary = shade(primary, 0.3);
    if (kind === "creature" && concept.biome === "snow") accessories.push("scarf");
    if (kind !== "creature") glow = accent;
  } else if (!HOSTILE_BODY_ROLES.has(role) && KIND_HINTS.includes(cc.kind)) {
    // A non-hostile animal or wisp (only reachable through the kind hint): a
    // small, soft-coloured critter with no warning glow.
    locomotion = kind === "creature" ? "quadruped" : "hover";
    height = round2(r.range(0.35, 0.6));
    build = "slim";
    palette.skin = shade(ground, 0.25); palette.primary = shade(secondary, 0.1); palette.secondary = shade(primary, 0.35);
  } else {
    // Enemy sentinels and hostile creatures.
    locomotion = kind === "creature" ? "quadruped" : "hover";
    height = round2(kind === "creature" ? r.range(0.9, 1.3) : r.range(1.9, 2.4));
    build = kind === "robot" ? "broad" : kind === "spirit" ? "slim" : "average";
    palette.skin = kind === "robot" ? "#6f757d" : kind === "spirit" ? shade(accent, 0.55) : shade(ground, -0.3);
    palette.primary = shade(primary, -0.45); palette.secondary = shade(secondary, -0.45);
    glow = accent; // the "eye" the player learns to watch for
  }
  if (SIZE_MULT[cc.size]) height = round2(clamp(height * SIZE_MULT[cc.size], 0.3, 5));
  return { height, build, palette, accessories, locomotion, glow };
}

// ---------------------------------------------------------------------------
// Behaviours

function behaviorFor(role, spawn, world, r) {
  const base = BEHAVIOR[role];
  const b = {
    initial: base.initial, patrol: [], wander_radius: base.wander_radius, speed: base.speed,
    sight_radius: base.sight_radius, hostile: base.hostile, leash_radius: base.leash_radius,
  };
  if (base.on_player_near) b.on_player_near = base.on_player_near;
  if (base.on_player_far) b.on_player_far = base.on_player_far;
  if (b.initial === "patrol") {
    b.patrol = patrolLoop(spawn, world, r);
    // Without a world (or a region too cramped for a loop) there is nothing
    // to walk, so the NPC holds its post instead of failing validation.
    if (b.patrol.length < 2) {
      b.patrol = [];
      b.initial = "guard";
      if (b.on_player_far === "patrol") b.on_player_far = "guard";
    }
  }
  return b;
}

/**
 * A 4-point loop around the spawn, inside the spawn's region and the world,
 * each corner nudged onto the nearest walkable nav cell. Radius scales with
 * the region so a guard in a big plaza walks a bigger beat.
 */
function patrolLoop(spawn, world, r) {
  if (!spawn || !world?.size) return [];
  const region = (world.regions || []).find((g) => g.id === spawn.region);
  const [minX, minZ, maxX, maxZ] = region?.bounds || [0, 0, world.size.w, world.size.h];
  const rad = clamp(Math.min(maxX - minX, maxZ - minZ) * 0.3, 3, 12);
  const phase = r.range(0, Math.PI / 2);
  const pts = [];
  for (let k = 0; k < 4; k++) {
    const a = phase + (k * Math.PI) / 2;
    let x = clamp(spawn.position.x + Math.cos(a) * rad, minX + 1, maxX - 1);
    let z = clamp(spawn.position.z + Math.sin(a) * rad, minZ + 1, maxZ - 1);
    x = clamp(x, 0.5, world.size.w - 0.5); z = clamp(z, 0.5, world.size.h - 0.5);
    const p = snapWalkable(world.navigation, x, z, { minX, minZ, maxX, maxZ });
    if (p && !pts.some((q) => Math.hypot(q.x - p.x, q.z - p.z) < 1.5)) pts.push(p);
  }
  return pts;
}

function snapWalkable(nav, x, z, box) {
  if (!nav || typeof nav.walkable !== "string") return { x: round2(x), z: round2(z) };
  if (navWalkable(nav, x, z)) return { x: round2(x), z: round2(z) };
  const c = nav.cell;
  // Rings of cells outwards; take the first walkable cell centre inside the box.
  for (let ring = 1; ring <= 6; ring++) {
    for (let dj = -ring; dj <= ring; dj++) {
      for (let di = -ring; di <= ring; di++) {
        if (Math.max(Math.abs(di), Math.abs(dj)) !== ring) continue;
        const px = (Math.floor(x / c) + di + 0.5) * c, pz = (Math.floor(z / c) + dj + 0.5) * c;
        if (px < box.minX || pz < box.minZ || px > box.maxX || pz > box.maxZ) continue;
        if (navWalkable(nav, px, pz)) return { x: round2(px), z: round2(pz) };
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Dialogue

function pickupItems(world) {
  const ids = new Set();
  for (const ix of world?.interactables || []) if (ix?.kind === "pickup" && typeof ix.item_ref === "string" && ix.item_ref.startsWith("item_")) ids.add(ix.item_ref);
  if (ids.size === 0) ["item_1", "item_2", "item_3"].forEach((i) => ids.add(i)); // §4.5 guarantees at least these
  return [...ids].sort();
}

const flagCond = (ref, value = true) => ({ kind: "flag", ref, value });
const setFlag = (ref) => ({ kind: "set_flag", ref, value: true });
const bye = (text) => ({ text, next: null });
const lc = (s) => String(s || "").replace(/\.$/, "");

function dialogueFor(ch, cc, concept, locs, items, r) {
  const id = `dlg_${ch.id}`;
  const hub = locs[0]?.name || "this place";
  const others = locs.slice(1);
  const place = (k) => others[k % Math.max(1, others.length)] || locs[0] || { name: hub, description: "" };
  const met = `met_${ch.id}`;
  const title = concept.title || "this land";
  const speaker = ch.name;
  const entry = [];
  const nodes = [];

  switch (ch.role) {
    case "quest_giver": {
      const a = place(0), b = place(1);
      // Progress first: any item in hand outranks small talk.
      for (const it of items) entry.push({ node: "progress", conditions: [{ kind: "has_item", ref: it, value: 1 }] });
      entry.push({ node: "welcome_back", conditions: [flagCond(met)] });
      entry.push({ node: "first_meet", conditions: [] });
      nodes.push(
        { id: "first_meet", speaker, text: `So you've come to ${hub} at last. I am ${ch.name}. ${lc(concept.logline) || `Much has been lost across ${title}`}.`,
          choices: [
            { text: "What happened here?", next: "lore", actions: [setFlag(met)] },
            { text: "What do you need from me?", next: "task", actions: [setFlag(met)] },
            { text: "I'll look around first.", next: null, actions: [setFlag(met)] },
          ] },
        { id: "welcome_back", speaker, text: `Back again. ${hub} is quieter while you're out there.`,
          choices: [
            { text: "Remind me what to do.", next: "task" },
            { text: "Tell me the old story.", next: "lore" },
            bye("Just passing through."),
          ] },
        { id: "task", speaker, text: `Go to ${a.name}${b !== a ? `, then ${b.name}` : ""}. Whatever still remembers ${title} is out there. Bring it back to me.`,
          choices: [bye("I'll go."), { text: "Why me?", next: "lore" }] },
        { id: "lore", speaker, text: loreLine(concept, hub, r),
          choices: [
            { text: `Tell me about ${a.name}.`, next: "lore_a" },
            ...(b !== a ? [{ text: `And ${b.name}?`, next: "lore_b" }] : []),
            bye("That's enough history."),
          ] },
        { id: "lore_a", speaker, text: `${a.name}: ${lc(a.description) || "few who go there talk about it after"}.`,
          choices: [{ text: "Something else.", next: "lore" }, bye("Thank you.")] },
        { id: "progress", speaker, text: `You found something out there. I can see it on you. That's one piece of ${title} back where it belongs.`,
          choices: [
            { text: "What does it mean?", next: "lore", actions: [setFlag(`progress_seen_${ch.id}`)] },
            { text: "I'll keep looking.", next: null, actions: [setFlag(`progress_seen_${ch.id}`)] },
          ] },
      );
      if (b !== a) nodes.push({ id: "lore_b", speaker, text: `${b.name}: ${lc(b.description) || "go carefully there"}.`,
        choices: [{ text: "Something else.", next: "lore" }, bye("Thank you.")] });
      break;
    }
    case "companion": {
      const a = place(r.int(0, 5));
      entry.push({ node: "banter", conditions: [flagCond(met)] });
      entry.push({ node: "intro", conditions: [] });
      nodes.push(
        { id: "intro", speaker, text: `${ch.name} circles your feet, then looks toward ${a.name} as if it already knows the way.`,
          choices: [{ text: "Come on, then.", next: null, actions: [setFlag(met), { kind: "set_npc_state", ref: ch.id, value: "follow_player" }] }] },
        { id: "banter", speaker, text: r.pick([
          `${ch.name} sniffs the air. Something about ${a.name} has it restless.`,
          `${ch.name} keeps close and glances back at ${hub}.`,
          `${ch.name} hums quietly, the way it does before the weather turns.`]),
          choices: [
            { text: "What do you sense?", next: "sense" },
            { text: "Stay here a while.", next: null, actions: [{ kind: "set_npc_state", ref: ch.id, value: "idle" }] },
            { text: "Stay close.", next: null, actions: [{ kind: "set_npc_state", ref: ch.id, value: "follow_player" }] },
          ] },
        { id: "sense", speaker, text: `It turns toward ${a.name}. ${lc(a.description) || "Something is waiting there"}.`,
          choices: [bye("Let's go."), { text: "Anything else?", next: "banter" }] },
      );
      break;
    }
    case "merchant": {
      const a = place(r.int(0, 5));
      entry.push({ node: "shop", conditions: [] });
      nodes.push(
        { id: "shop", speaker, text: `Welcome to my corner of ${hub}. ${ch.name}'s wares have come a long way to get here.`,
          choices: [{ text: "What are you selling?", next: "wares" }, { text: "Heard any rumours?", next: "rumour" }, bye("Maybe later.")] },
        { id: "wares", speaker, text: `Rope, oil, dried fruit, and maps of ${title} that are only a little wrong. Nothing you can't find for yourself, if you're patient.`,
          choices: [{ text: "Any rumours, then?", next: "rumour" }, bye("I'll manage.")] },
        { id: "rumour", speaker, text: `People say lights move at ${a.name} after dark. I don't go there myself.`,
          choices: [{ text: "Back to business.", next: "shop" }, bye("Thanks for the warning.")] },
      );
      break;
    }
    case "guard": {
      entry.push({ node: "again", conditions: [flagCond(met)] });
      entry.push({ node: "halt", conditions: [] });
      nodes.push(
        { id: "halt", speaker, text: `Halt. ${ch.name}, of the watch at ${hub}. Keep to the paths out there.`,
          choices: [
            { text: "What's out there?", next: "warn", actions: [setFlag(met)] },
            { text: "Understood.", next: null, actions: [setFlag(met)] },
          ] },
        { id: "again", speaker, text: "Still in one piece? Good. Keep it that way.",
          choices: [{ text: "Any danger ahead?", next: "warn" }, bye("Carry on.")] },
        { id: "warn", speaker, text: hazardLine(concept, place(0)),
          choices: [bye("I'll be careful.")] },
      );
      break;
    }
    case "creature": {
      entry.push({ node: "wary", conditions: [] });
      nodes.push({ id: "wary", speaker, text: `The ${lc(ch.name).toLowerCase()} watches you, low and still. It is not going to talk.`,
        choices: [bye("Back away slowly.")] });
      break;
    }
    default: {
      const a = place(r.int(0, 5));
      entry.push({ node: "chat", conditions: [] });
      nodes.push(
        { id: "chat", speaker, text: r.pick([
          `Fine day for it, if you ignore the ${concept.weather && concept.weather !== "clear" ? concept.weather : "wind"}.`,
          `I've lived in ${hub} all my life and I still haven't been out to ${a.name}.`,
          `You're not from around ${hub}, are you?`]),
          choices: [{ text: `What's at ${a.name}?`, next: "place" }, bye("Take care.")] },
        { id: "place", speaker, text: `${a.name}? ${lc(a.description) || "Couldn't tell you. Never been"}.`,
          choices: [bye("Thanks.")] },
      );
    }
  }
  return { id, character_ref: ch.id, entry, nodes };
}

function loreLine(concept, hub, r) {
  const mood = concept.mood ? ` ${concept.mood[0].toUpperCase()}${concept.mood.slice(1)}, even then.` : "";
  return r.pick([
    `Before anyone lived in ${hub}, ${concept.title || "this land"} was kept by people who wrote nothing down.${mood}`,
    `They say ${hub} was built on what was left of an older place.${mood} Ask the stones and they won't argue.`,
  ]);
}

function hazardLine(concept, loc) {
  const hz = Array.isArray(concept.hazards) && concept.hazards.length ? concept.hazards[0] : null;
  return hz ? `${hz[0].toUpperCase()}${hz.slice(1)}. Worst near ${loc.name}.` : `Nothing I can name. But nobody comes back from ${loc.name} in a hurry to go again.`;
}

// ---------------------------------------------------------------------------
// Colour helpers

function hexOr(v, d) { return typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v) ? v.toLowerCase() : d; }

/** Lighten (amt > 0) toward white or darken (amt < 0) toward black. */
function shade(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => Math.round(amt >= 0 ? c + (255 - c) * amt : c * (1 + amt)));
  return "#" + ch.map((c) => clamp(c, 0, 255).toString(16).padStart(2, "0")).join("");
}
