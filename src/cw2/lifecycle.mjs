// src/lifecycle.mjs
// P3: draft <-> public state + publish validation (C1 additive: world.state).
// P4: tag/genre extraction from prompts + a search index over worlds (feeds CW6 discovery).
// Zero npm deps. Builds on the frozen C1 + the validator.

import { validateWorld } from "./validator.mjs";

// ---------- P3: publish lifecycle ----------
export const STATES = ["draft", "published"];

// A world starts as draft. Publish requires: schema-valid + has spawns + has at least one quest objective.
// Fail-closed: anything missing -> publish rejected, stays draft. No "force publish".
export function publishValidation(world) {
  const reasons = [];
  const v = validateWorld(world);
  if (!v.valid) reasons.push(...v.errors.map((e) => "schema:" + e));
  if (!(world.spawns || []).some((s) => s.role === "player")) reasons.push("no_player_spawn");
  const hasObjective = (world.quests || []).some((q) => (q.objectives || []).length > 0);
  if (!hasObjective) reasons.push("no_quest_objective");
  return { publishable: reasons.length === 0, reasons };
}

export function setState(world, target) {
  if (!STATES.includes(target)) return { ok: false, reason: "illegal_state" };
  if (target === "published") {
    const pv = publishValidation(world);
    if (!pv.publishable) return { ok: false, reason: "publish_validation_failed", details: pv.reasons };
  }
  return { ok: true, world: { ...world, state: target } };
}

// ---------- P4: tags + search index ----------
const TAG_MAP = {
  horror: ["horror", "survival", "zombie", "ghost", "dead"],
  cyberpunk: ["cyberpunk", "neon", "android", "hacker", "city"],
  fantasy: ["fantasy", "dragon", "magic", "castle", "knight"],
  pirate: ["pirate", "treasure", "ship", "sea", "cove"],
  coop: ["co-op", "coop", "multiplayer", "friends", "squad"],
  escape: ["escape", "survive", "trapped", "quarantine"],
};
export function extractTags(world) {
  const text = `${world.meta.title} ${world.meta.prompt} ${world.meta.genre}`.toLowerCase();
  const tags = new Set([world.meta.genre]);
  for (const [tag, keys] of Object.entries(TAG_MAP)) {
    if (keys.some((k) => text.includes(k))) tags.add(tag);
  }
  return [...tags];
}

// In-memory search index (feeds CW6 discovery). Real impl swaps store behind the same API.
export class SearchIndex {
  constructor() { this.docs = new Map(); } // world_id -> {world_id,title,genre,tags,state}
  add(world) {
    this.docs.set(world.world_id, {
      world_id: world.world_id,
      title: world.meta.title,
      genre: world.meta.genre,
      tags: extractTags(world),
      state: world.state || "draft",
    });
  }
  // Search by tag or genre. P4 gate: returns relevant worlds. Only surfaces published by default.
  search(query, { includeDrafts = false } = {}) {
    const q = String(query).toLowerCase();
    return [...this.docs.values()].filter((d) => {
      if (!includeDrafts && d.state !== "published") return false;
      return d.genre.includes(q) || d.tags.some((t) => t.includes(q)) || d.title.toLowerCase().includes(q);
    });
  }
}
