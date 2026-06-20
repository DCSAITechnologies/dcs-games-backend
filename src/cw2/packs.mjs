// src/packs.mjs
// P5: sellable asset packs (buildings, vehicles, weapons, NPC packs, quest packs, world templates).
// P6: sellable AI agents (Teacher/Police/Zombie/Merchant/Boss) = behavior + dialogue, packaged.
//
// MONEY IS DARK: price is recorded but no transaction occurs. listForSale produces a CW6 marketplace
// handoff in shadow mode ($0 settled) until DK flips. Honest — nothing moves money here.
// Each pack/agent carries provenance so CW7 ownership resolves (ties to P2).
// Zero npm deps.

import crypto from "node:crypto";

const PACK_KINDS = ["buildings", "vehicles", "weapons", "npc-pack", "quest-pack", "world-template"];

function packId(prefix, seed) {
  return prefix + "_" + crypto.createHash("sha256").update(seed).digest("hex").slice(0, 12);
}

// ---------- P5: asset pack ----------
export function buildAssetPack({ kind, name, items, creator_id, price_micro = 0 }) {
  if (!PACK_KINDS.includes(kind)) return { ok: false, reason: `unknown_pack_kind:${kind}` };
  if (!Array.isArray(items) || items.length === 0) return { ok: false, reason: "empty_pack" };
  const id = packId("pack", name + kind + creator_id);
  return {
    ok: true,
    pack: {
      pack_id: id,
      type: "asset-pack",
      kind, name, creator_id,
      item_count: items.length,
      items,
      content_hash: crypto.createHash("sha256").update(JSON.stringify(items)).digest("hex").slice(0, 16),
      price_micro,                 // recorded, NOT charged
      receipt_hash: null,          // Atlas signs at publish
      provenance: { generated_by: "cw2", creator_id },
    },
  };
}

// ---------- P6: AI agent ----------
const AGENT_ARCHETYPES = ["teacher", "police", "zombie", "merchant", "boss"];
export function buildAIAgent({ archetype, name, creator_id, price_micro = 0 }) {
  if (!AGENT_ARCHETYPES.includes(archetype)) return { ok: false, reason: `unknown_archetype:${archetype}` };
  const behaviors = {
    teacher:  { behavior: "instruct", dialogue_seed: "Today's lesson: survival.", memory: true },
    police:   { behavior: "patrol",   dialogue_seed: "Move along, citizen.",      memory: true },
    zombie:   { behavior: "hunt",     dialogue_seed: "*guttural snarl*",          memory: false },
    merchant: { behavior: "trade",    dialogue_seed: "Best prices in the wasteland.", memory: true },
    boss:     { behavior: "phase-fight", dialogue_seed: "You will not leave here.", memory: true },
  }[archetype];
  const id = packId("agent", archetype + name + creator_id);
  return {
    ok: true,
    agent: {
      agent_id: id,
      type: "ai-agent",
      archetype, name, creator_id,
      ...behaviors,
      content_hash: crypto.createHash("sha256").update(JSON.stringify({ archetype, behaviors })).digest("hex").slice(0, 16),
      price_micro,                 // recorded, NOT charged
      receipt_hash: null,
      provenance: { generated_by: "cw2", creator_id },
    },
  };
}

// ---------- CW6 marketplace handoff (DARK / shadow mode) ----------
// Packages a pack or agent into the shape CW6's marketplace consumes. Settled=$0 until DK flips.
export function listForSale(packOrAgent, { dk_money_live = false } = {}) {
  const id = packOrAgent.pack_id || packOrAgent.agent_id;
  if (!id) return { ok: false, reason: "not_a_sellable" };
  return {
    listing_id: packId("listing", id),
    subject_id: id,
    subject_type: packOrAgent.type,
    creator_id: packOrAgent.creator_id,
    price_micro: packOrAgent.price_micro,
    // HONEST: money is DARK. Even with a price, nothing settles unless DK has flipped money live.
    mode: dk_money_live ? "live" : "shadow",
    settled_micro: 0,            // always 0 here — CW6+DK own real settlement
    status: dk_money_live ? "listed" : "shadow-listed",
    note: dk_money_live ? "live listing" : "shadow/$0 — ready to flip when DK enables money",
  };
}

export { PACK_KINDS, AGENT_ARCHETYPES };
