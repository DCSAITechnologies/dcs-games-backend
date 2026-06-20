// src/cw2/hybrid-enrich.mjs
// HYBRID generation adapter: deterministic seeder builds reliable geometry (terrain, spawns,
// object/npc/quest/item structure + ids + triggers); Cerebras rewrites ONLY the creative layer
// (title, lore, zone names, npc kinds+dialogue, quest text, item names) and we merge it back.
//
// Why hybrid: keeps every world C1-valid and render-ready, stays token-light (~1-2k tok/world ->
// ~30 worlds/min within the free tier), and NEVER hard-fails — any model/JSON/rate-limit error
// falls back to the seeder world (which is already valid). Honest: AI enriches, contract validates.

import { generateWorld } from "./generate.mjs";
import { validateWorld } from "./validator.mjs";

const ENRICH_SYSTEM = [
  "You are a game-world creative director for DCS Games.",
  "Given a player's prompt, return STRICT JSON (no prose, no markdown) enriching a world with vivid, original flavor.",
  "Shape EXACTLY:",
  '{"title":string, "lore":string, "zones":[string,...], "npcs":[{"kind":string,"dialogue":string},...], "quest":{"title":string,"objectives":[string,...]}, "items":[string,...]}',
  "Rules: title <= 48 chars. lore = 1-2 punchy sentences. Provide as many zones/npcs/items as asked for in the user message.",
  "dialogue = a short in-character line. objectives = imperative quest steps. Keep it tasteful and age-appropriate. Return ONLY the JSON object.",
].join(" ");

function buildEnrichUser(prompt, base) {
  return [
    `Prompt: ${prompt}`,
    `Detected genre: ${base.meta.genre}`,
    `Provide ${base.terrain.zones.length} zone name(s), ${base.npcs.length} npc(s), ${base.quests[0].objectives.length} quest objective(s), and ${base.items.length} item name(s).`,
  ].join("\n");
}

// Merge model enrichment onto the seeder world WITHOUT touching ids, coords, triggers or terrain data.
function merge(base, e, modelName) {
  const w = base; // mutate the freshly-generated seeder world
  if (typeof e.title === "string" && e.title.trim()) w.meta.title = e.title.trim().slice(0, 48);
  if (typeof e.lore === "string" && e.lore.trim()) w.meta.lore = e.lore.trim();
  w.meta.generator = "cerebras-hybrid:" + modelName;

  if (Array.isArray(e.zones)) w.terrain.zones.forEach((z, i) => { if (typeof e.zones[i] === "string" && e.zones[i].trim()) z.name = e.zones[i].trim(); });

  if (Array.isArray(e.npcs)) w.npcs.forEach((n, i) => {
    const en = e.npcs[i];
    if (en && typeof en === "object") {
      if (typeof en.kind === "string" && en.kind.trim()) n.kind = en.kind.trim();
      if (typeof en.dialogue === "string" && en.dialogue.trim()) n.dialogue_seed = en.dialogue.trim();
    }
  });

  if (e.quest && typeof e.quest === "object" && w.quests[0]) {
    if (typeof e.quest.title === "string" && e.quest.title.trim()) w.quests[0].title = e.quest.title.trim();
    if (Array.isArray(e.quest.objectives)) w.quests[0].objectives.forEach((o, i) => { if (typeof e.quest.objectives[i] === "string" && e.quest.objectives[i].trim()) o.text = e.quest.objectives[i].trim(); });
  }

  if (Array.isArray(e.items)) w.items.forEach((it, i) => { if (typeof e.items[i] === "string" && e.items[i].trim()) it.name = e.items[i].trim(); });

  return w;
}

// makeHybridAdapter({modelClient}) -> adapter with .generate(prompt, opts) -> C1-valid world.json
export function makeHybridAdapter({ modelClient = null } = {}) {
  return {
    name: modelClient ? "hybrid-" + modelClient.name : "hybrid-seeder-only",
    ready: true, // always ready: seeder is the floor
    async generate(prompt, opts = {}) {
      const base = generateWorld(prompt, opts); // valid C1 geometry every time
      if (!modelClient) return base;            // no key -> pure seeder (honest)
      try {
        const raw = await modelClient.complete([
          { role: "system", content: ENRICH_SYSTEM },
          { role: "user", content: buildEnrichUser(prompt, base) },
        ]);
        const enrich = JSON.parse(raw);
        const merged = merge(base, enrich, modelClient.model || modelClient.name);
        const v = validateWorld(merged);
        if (!v.valid) return base; // bad enrich -> ship the valid seeder world instead of failing
        return merged;
      } catch {
        // rate-limited / timeout / non-JSON / network -> graceful fallback, generation never breaks
        return generateWorld(prompt, opts);
      }
    },
  };
}
