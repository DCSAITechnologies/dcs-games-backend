// src/generate.mjs
// CW2 generation: prompt -> world.json (C1 contract).
// P0 path is deterministic seeding. The AI path matures later BEHIND THE SAME CONTRACT —
// callers get a schema-valid world.json either way (spec: "generate returns a fixture until the AI path matures").
// Zero npm deps.

import crypto from "node:crypto";

// --- prompt parser: prompt -> genre + params ---
const GENRE_KEYS = {
  horror: ["zombie", "haunted", "ghost", "horror", "survival", "dead", "asylum", "nightmare"],
  cyberpunk: ["cyberpunk", "neon", "mumbai", "hacker", "android", "megacorp", "chrome"],
  fantasy: ["dragon", "kingdom", "fantasy", "castle", "magic", "knight", "wizard", "elf"],
  pirate: ["pirate", "island", "ship", "treasure", "sea", "cove", "galleon", "buccaneer"],
  scifi: ["space", "station", "spaceship", "alien", "galaxy", "orbital", "starship", "mars"],
  western: ["western", "wild west", "cowboy", "saloon", "desert town", "outlaw", "frontier"],
  underwater: ["underwater", "ocean", "reef", "submarine", "abyss", "deep sea", "atlantis"],
  jungle: ["jungle", "temple", "ruins", "rainforest", "aztec", "mayan", "tomb"],
  apocalypse: ["apocalypse", "wasteland", "fallout", "post-apocalyptic", "bunker", "radiation"],
  medieval: ["medieval", "village", "tavern", "siege", "peasant", "blacksmith", "moat"],
};
export function parsePrompt(prompt) {
  const p = String(prompt).toLowerCase();
  let genre = "adventure", best = 0;
  for (const [g, keys] of Object.entries(GENRE_KEYS)) {
    const score = keys.reduce((n, k) => n + (p.includes(k) ? 1 : 0), 0);
    if (score > best) { best = score; genre = g; }
  }
  const size = p.length > 60 ? { w: 24, h: 24 } : { w: 16, h: 16 };
  return { genre, size, title: titleFromPrompt(prompt) };
}
function titleFromPrompt(prompt) {
  return String(prompt).split(/[,.;]/)[0].trim().replace(/\b\w/g, (c) => c.toUpperCase()).slice(0, 48) || "Untitled World";
}

// --- seeders (deterministic per prompt+seed) ---
function rng(seedStr) {
  let h = 2166136261;
  for (const ch of seedStr) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return () => { h ^= h << 13; h ^= h >>> 17; h ^= h << 5; return ((h >>> 0) % 1000) / 1000; };
}
function tilegrid(size, r) {
  const data = [];
  for (let y = 0; y < size.h; y++) {
    const row = [];
    for (let x = 0; x < size.w; x++) row.push(r() < 0.18 ? 1 : 0); // 1 = wall/obstacle, 0 = floor
    data.push(row);
  }
  return data;
}

// citygrid: STRUCTURED layout (border + solid building blocks + streets) so the map reads as a
// designed place, not random noise. `reserved` cells (spawns/objects/npcs) are carved back to floor
// with a 1-tile buffer so nothing spawns inside a wall. 1 = wall, 0 = floor.
function citygrid(size, r, reserved = []) {
  const { w, h } = size;
  const g = Array.from({ length: h }, () => Array(w).fill(0));
  // perimeter wall
  for (let x = 0; x < w; x++) { g[0][x] = 1; g[h - 1][x] = 1; }
  for (let y = 0; y < h; y++) { g[y][0] = 1; g[y][w - 1] = 1; }
  // solid building blocks of varied size, leaving streets (floor) between them
  const blocks = 5 + Math.floor(r() * 5);
  for (let b = 0; b < blocks; b++) {
    const bw = 2 + Math.floor(r() * 4), bh = 2 + Math.floor(r() * 4);
    const bx = 2 + Math.floor(r() * Math.max(1, w - bw - 3));
    const by = 2 + Math.floor(r() * Math.max(1, h - bh - 3));
    for (let y = by; y < by + bh && y < h - 1; y++) for (let x = bx; x < bx + bw && x < w - 1; x++) g[y][x] = 1;
  }
  // a few scattered single pillars for texture
  const pillars = Math.floor(r() * 6);
  for (let p = 0; p < pillars; p++) { const x = 1 + Math.floor(r() * (w - 2)), y = 1 + Math.floor(r() * (h - 2)); g[y][x] = 1; }
  // carve reserved cells + 1-tile buffer back to floor (keeps spawns/NPCs/objects walkable)
  for (const [cx, cz] of reserved) {
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      const x = cx + dx, z = cz + dz;
      if (x > 0 && z > 0 && x < w - 1 && z < h - 1) g[z][x] = 0;
    }
  }
  return g;
}

const PALETTE = {
  horror:    { zone:"Quarantine Ward", obj:"barricade", npc:"zombie", behavior:"hunt", line:"They're coming...", item:"Med-kit", quest:"Escape the outbreak" },
  cyberpunk: { zone:"Neon Bazaar", obj:"vending-drone", npc:"android-vendor", behavior:"trade", line:"Chrome or credits?", item:"Data-shard", quest:"Crack the megacorp" },
  fantasy:   { zone:"Throne Approach", obj:"rune-pillar", npc:"dragon", behavior:"guard", line:"You dare enter?", item:"Ancient relic", quest:"Slay the dragon" },
  pirate:    { zone:"Smuggler's Cove", obj:"treasure-chest", npc:"buccaneer", behavior:"patrol", line:"Yarr, lost are ye?", item:"Doubloon", quest:"Find the buried gold" },
  scifi:     { zone:"Docking Bay", obj:"stasis-pod", npc:"rogue-AI", behavior:"scan", line:"Intruder detected.", item:"Fusion cell", quest:"Restore the reactor" },
  western:   { zone:"Dusty Main Street", obj:"hitching-post", npc:"gunslinger", behavior:"standoff", line:"This town ain't big enough.", item:"Silver bullet", quest:"Outdraw the outlaw" },
  underwater:{ zone:"Coral Trench", obj:"air-bubble", npc:"angler-fiend", behavior:"lurk", line:"*deep gurgle*", item:"Oxygen tank", quest:"Surface before the air runs out" },
  jungle:    { zone:"Overgrown Plaza", obj:"vine-trap", npc:"temple-guardian", behavior:"ambush", line:"You disturb the sleeping.", item:"Golden idol", quest:"Escape with the idol" },
  apocalypse:{ zone:"Ruined Overpass", obj:"scrap-pile", npc:"raider", behavior:"scavenge", line:"Got any water?", item:"Ration tin", quest:"Reach the safe zone" },
  medieval:  { zone:"Village Square", obj:"market-stall", npc:"villager", behavior:"barter", line:"Fresh bread, traveler?", item:"Iron coin", quest:"Defend the village" },
  adventure: { zone:"Clearing", obj:"crate", npc:"wanderer", behavior:"idle", line:"Safe travels.", item:"Ration", quest:"Explore the unknown" },
};

export function generateWorld(prompt, opts = {}) {
  const { creator_id = "creator_demo", seed = prompt } = opts;
  const { genre, size, title } = parsePrompt(prompt);
  const r = rng(seed);
  const pal = PALETTE[genre] || PALETTE.adventure;
  const world_id = "world_" + crypto.createHash("sha256").update(seed).digest("hex").slice(0, 12);

  const W = size.w, H = size.h, hw = Math.floor(W / 2), hh = Math.floor(H / 2);
  // deterministic placements (deeper world): 3 spawns, 6 objects, 5 npcs
  const objCoords = [[5, 5], [W - 5, 6], [W - 3, H - 4], [hw, hh], [4, H - 8], [W - 8, 5]];
  const npcCoords = [[8, 7], [W - 6, H - 7], [hw, 4], [5, H - 5], [W - 7, hh]];
  const spawnCoords = [[2, 2], [3, 2], [W - 3, H - 3]];
  // cells that must stay walkable
  const reserved = [...spawnCoords, ...objCoords, ...npcCoords];

  const world = {
    world_id,
    schema_version: "1.0",
    meta: {
      title, prompt, genre,
      creator_id,
      created_at: new Date().toISOString(),
      atlas_receipt_hash: null, // honest: receipt is issued at publish, not fabricated at gen time
    },
    terrain: {
      type: "tilegrid",
      size,
      data: citygrid(size, r, reserved),
      zones: [
        { zone_id: "z1", name: pal.zone, rect: [1, 1, Math.floor(size.w/2), Math.floor(size.h/2)] },
        { zone_id: "z2", name: "Outskirts", rect: [Math.floor(size.w/2), Math.floor(size.h/2), size.w-1, size.h-1] },
      ],
    },
    spawns: [
      { id: "sp_p1", x: 2, y: 0, z: 2, role: "player" },
      { id: "sp_p2", x: 3, y: 0, z: 2, role: "player" },
      { id: "sp_obj", x: size.w-3, y: 0, z: size.h-3, role: "item" },
    ],
    objects: [
      { object_id: "ob_1",    kind: pal.obj, transform: { x: objCoords[0][0], y: 0, z: objCoords[0][1], rot: 0,  scale: 1 }, interactable: true, owner_id: null },
      { object_id: "ob_2",    kind: pal.obj, transform: { x: objCoords[1][0], y: 0, z: objCoords[1][1], rot: 90, scale: 1 }, interactable: true, owner_id: null },
      { object_id: "ob_door", kind: "door",  transform: { x: objCoords[2][0], y: 0, z: objCoords[2][1], rot: 0,  scale: 1 }, interactable: true, owner_id: null },
      { object_id: "ob_3",    kind: "crate", transform: { x: objCoords[3][0], y: 0, z: objCoords[3][1], rot: 0,  scale: 1 }, interactable: true, owner_id: null },
      { object_id: "ob_4",    kind: "crate", transform: { x: objCoords[4][0], y: 0, z: objCoords[4][1], rot: 0,  scale: 1 }, interactable: true, owner_id: null },
      { object_id: "ob_5",    kind: pal.obj, transform: { x: objCoords[5][0], y: 0, z: objCoords[5][1], rot: 45, scale: 1 }, interactable: true, owner_id: null },
    ],
    npcs: [
      { npc_id: "npc_1", kind: pal.npc, spawn: { x: npcCoords[0][0], y: 0, z: npcCoords[0][1] }, behavior: pal.behavior, dialogue_seed: pal.line },
      { npc_id: "npc_2", kind: pal.npc, spawn: { x: npcCoords[1][0], y: 0, z: npcCoords[1][1] }, behavior: pal.behavior, dialogue_seed: pal.line },
      { npc_id: "npc_3", kind: pal.npc, spawn: { x: npcCoords[2][0], y: 0, z: npcCoords[2][1] }, behavior: pal.behavior, dialogue_seed: pal.line },
      { npc_id: "npc_4", kind: pal.npc, spawn: { x: npcCoords[3][0], y: 0, z: npcCoords[3][1] }, behavior: pal.behavior, dialogue_seed: pal.line },
      { npc_id: "npc_5", kind: pal.npc, spawn: { x: npcCoords[4][0], y: 0, z: npcCoords[4][1] }, behavior: pal.behavior, dialogue_seed: pal.line },
    ],
    quests: [
      { quest_id: "q1", title: pal.quest, objectives: [
        { id: "o1", text: "Explore and reach the objective zone", trigger: "enter_zone:z2" },
        { id: "o2", text: "Recover the key item from the cache",   trigger: "interact:ob_3" },
        { id: "o3", text: `Reach the ${pal.obj === "door" ? "exit" : "final"} and complete the mission`, trigger: "interact:ob_door" },
      ], reward: { item_id: "it_1", xp: 150 } },
    ],
    items: [
      { item_id: "it_1",   name: pal.item,      stackable: true,  icon: `icon_${genre}_1` },
      { item_id: "it_key", name: "Rusted Key",  stackable: false, icon: "icon_key" },
      { item_id: "it_2",   name: "Relic Fragment", stackable: true, icon: `icon_${genre}_2` },
      { item_id: "it_3",   name: "Cipher Disc",    stackable: false, icon: `icon_${genre}_3` },
    ],
  };
  return world;
}

// The 4 P0 fixture prompts (spec-named).
export const P0_PROMPTS = [
  { key: "zombie-school", prompt: "Zombie School — a quarantined high school overrun by the dead, co-op escape." },
  { key: "cyberpunk-mumbai", prompt: "Cyberpunk Mumbai — neon megacity streets, android vendors, hack the megacorp." },
  { key: "dragon-kingdom", prompt: "Dragon Kingdom — a fantasy castle approach guarded by an ancient dragon." },
  { key: "pirate-island", prompt: "Pirate Island — a smuggler's cove with buried treasure and patrolling buccaneers." },
];
