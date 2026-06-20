// src/advanced.mjs
// P7: voice-NPC content + AI companion personas.
// P9: procedural systems — AI cities, AI economies, AI nations (autonomous generation).
// All additive to C1; procedural output is still emitted as C1-conformant objects/npcs so the
// validator and CW3 consume it unchanged. Zero npm deps.

import crypto from "node:crypto";
import { proposeLedgerRef } from "./ledger-ref.mjs";
const hash = (s) => crypto.createHash("sha256").update(typeof s === "string" ? s : JSON.stringify(s)).digest("hex").slice(0, 12);

// ---------- P7: voice NPC ----------
const VOICE_PROFILES = {
  raspy: { pitch: 0.4, reverb: true, age_cast: "adult" },
  child: { pitch: 0.7, reverb: false, age_cast: "child", age_safe_filter: true }, // safety: child voices filtered
  robotic: { pitch: 0.5, reverb: true, age_cast: "synthetic" },
  gravel: { pitch: 0.2, reverb: false, age_cast: "adult" },
};
export function buildVoiceNPC(npc, { voice = "raspy", emotions = ["calm", "distressed", "hostile"] } = {}) {
  const profile = VOICE_PROFILES[voice] || VOICE_PROFILES.raspy;
  return {
    ...npc,
    voice: {
      voice_id: "voice_" + hash(npc.npc_id + voice),
      profile: voice,
      ...profile,
      emotion_states: emotions,
      // safety: a child-cast voice MUST carry the age-safe filter (policy, not optional)
      age_safe_filter: profile.age_cast === "child" ? true : (profile.age_safe_filter || false),
    },
  };
}

// ---------- P7: AI companion persona ----------
export function buildCompanion({ name, kind = "ghost-pup", creator_id, traits = ["loyal", "curious"] }) {
  return {
    companion_id: "comp_" + hash(name + kind),
    type: "ai-companion",
    name, kind, creator_id,
    traits,
    memory: true,            // companions remember the player across worlds
    grows_with_player: true,
    monetized: false,        // free P1-P3 (carried policy); cosmetic only later
    provenance: { generated_by: "cw2", creator_id },
  };
}

// ---------- P9: procedural systems ----------
// AI city: generates a set of C1-conformant objects (buildings) + npcs (citizens) procedurally.
export function generateCity({ name, size = 12, creator_id = "system", seed = name }) {
  let h = 2166136261;
  for (const c of seed) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  const r = () => { h ^= h << 13; h ^= h >>> 17; h ^= h << 5; return ((h >>> 0) % 1000) / 1000; };
  const objects = [], npcs = [];
  const districts = Math.max(2, Math.floor(size / 4));
  for (let d = 0; d < districts; d++) {
    for (let b = 0; b < 3; b++) {
      objects.push({
        object_id: `bldg_${d}_${b}`, kind: ["tower", "market", "depot"][b % 3],
        transform: { x: Math.floor(r() * size), y: 0, z: Math.floor(r() * size), rot: 0, scale: 1 },
        interactable: true, owner_id: null,
      });
    }
    npcs.push({
      npc_id: `citizen_${d}`, kind: "citizen", spawn: { x: Math.floor(r() * size), y: 0, z: Math.floor(r() * size) },
      behavior: "wander", dialogue_seed: "The city never sleeps.",
    });
  }
  return { city_id: "city_" + hash(seed), name, districts, objects, npcs, generated_by: "cw2" };
}

// AI economy: a self-contained currency/flow model attached to a city or world (autonomous).
export function generateEconomy({ name, currency = "credits", seed = name, world_id = "world_proc", creator_id = "system" }) {
  return {
    economy_id: "econ_" + hash(seed),
    name, currency,
    faucets: ["work", "loot", "trade"],
    sinks: ["upkeep", "shop", "tax"],
    autonomous: true,            // runs without a human driving it
    // contract-conformant PROPOSED ledger_ref (CW3/CW6 frozen contract). CW1 stamps authoritative.
    proposed_ledger_ref: proposeLedgerRef({ template_id: "purchase_cosmetic", world_id, creator_id, sku: "proc-economy" }),
    money_live: false,           // DARK
  };
}

// AI nation: composes cities + an economy + a governance seed (the P9 ceiling).
export function generateNation({ name, cityCount = 3, seed = name }) {
  const cities = [];
  for (let i = 0; i < cityCount; i++) cities.push(generateCity({ name: `${name} City ${i + 1}`, seed: seed + i }));
  return {
    nation_id: "nation_" + hash(seed),
    name,
    cities: cities.map((c) => c.city_id),
    economy: generateEconomy({ name: `${name} Economy`, seed: seed + "econ" }),
    governance_seed: { policy: "autonomous", upkeep: "self-funded" },
    generated_by: "cw2",
    _cities: cities, // full city objects for downstream embedding
  };
}
