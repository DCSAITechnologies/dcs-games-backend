// B1 — text-lane adapters: world architect, fast inference, gameplay behaviour.
//
// Three vendors are configured on this estate and all three answered a live
// probe on 6 Sep 2026: DeepSeek (reasoning), Cerebras (fast inference, two keys)
// and Together (a broad catalogue). Each lane ranks them differently and every
// lane ends in a deterministic local implementation, so a world can still be
// built with every vendor down.
import { STATUS, LANES, ProviderError, chatCompletion, parseJsonLoose, offline } from "./contract.mjs";
import { planWorldLocally, classifyLocally, behaviorsLocally } from "./local-planner.mjs";

const ok = () => STATUS.AVAILABLE;

function keyed(env, ...names) {
  for (const n of names) {
    const v = env[n];
    if (v && String(v).trim()) return String(v).trim();
  }
  return "";
}

// --------------------------------------------------------------- vendor bases

const VENDORS = {
  deepseek: { baseUrl: "https://api.deepseek.com/v1", keys: ["DEEPSEEK_API_KEY"] },
  cerebras: { baseUrl: "https://api.cerebras.ai/v1", keys: ["CEREBRAS_API_KEY", "CEREBRAS_API_KEY_1", "CEREBRAS_KEY_2", "CEREBRAS_API_KEY_2"] },
  together: { baseUrl: "https://api.together.xyz/v1", keys: ["TOGETHER_API_KEY"] },
};

function makeChatAdapter({ vendor, model, lane, rank, name, system, build, parse, temperature, maxTokens, env = process.env }) {
  const v = VENDORS[vendor];
  const apiKey = keyed(env, ...v.keys);
  return {
    name: name || `${vendor}:${model}`,
    lane,
    rank,
    model,
    isFallback: false,
    async status() {
      if (offline(env)) return STATUS.UNAVAILABLE;   // CI and tests never spend money
      return apiKey ? ok() : STATUS.UNAVAILABLE;
    },
    async invoke(req, ctx) {
      const { text, model: usedModel, usage } = await chatCompletion({
        baseUrl: v.baseUrl,
        apiKey,
        model,
        system,
        user: build(req, ctx),
        temperature: temperature ?? 0.7,
        maxTokens: maxTokens ?? 6000,
        json: true,
        providerName: `${vendor}:${model}`,
      });
      const parsed = parse(text, req);
      if (!parsed) throw new ProviderError(`${vendor}:${model}`, "response was not usable JSON for this lane");
      parsed._model = usedModel;
      parsed._usage = usage;
      return parsed;
    },
  };
}

// ------------------------------------------------------------ world architect
//
// The premium reasoning lane. It is explicitly asked to design SPACE and
// GAMEPLAY — zones with real extents, structures with real positions, quests
// whose steps target real entities — because the previous generator asked for
// flavour text and then dropped it onto a fixed skeleton.

const ARCHITECT_SYSTEM = `You are the world architect for DCS Games. You design playable 3D worlds, not prose.

Return ONE JSON object with exactly these keys:
{
  "title": string,
  "genre": string,
  "style": string,                       // a concrete visual direction
  "maturity": "13+" | "16+" | "18+",
  "size": { "w": number, "h": number },  // world extent in metres, 120-600
  "environment": { "weather": "clear"|"cloudy"|"rain"|"storm"|"snow"|"fog"|"sandstorm"|"ash", "time_of_day": number },
  "zones": [ { "id": snake_case, "name": string, "kind": "district"|"interior"|"landmark"|"wilderness"|"transit"|"arena",
               "bounds": [minX,minZ,maxX,maxZ], "description": string, "density": number } ],
  "structures": [ { "id": snake_case, "zone": zone id, "archetype": string,
                    "position": {"x":n,"y":n,"z":n}, "footprint": {"w":n,"d":n,"h":n},
                    "enterable": boolean, "purpose": string } ],
  "npcs": [ { "id": snake_case, "name": string, "role": string, "zone": zone id,
              "position": {"x":n,"y":n,"z":n}, "behavior": "idle"|"patrol"|"vendor"|"guard"|"wander"|"hostile",
              "dialogue_seed": string } ],
  "items": [ { "id": snake_case, "name": string, "kind": string } ],
  "quests": [ { "id": snake_case, "title": string, "giver_npc": npc id, "difficulty": "easy"|"normal"|"hard",
                "steps": [ { "id": snake_case, "kind": "reach"|"talk"|"collect"|"deliver"|"defeat"|"activate"|"survive"|"escort"|"solve",
                             "target": "an id from zones, structures, npcs or items", "description": string } ] } ],
  "gameplay_loop": string,
  "expansion_hooks": [ string ]          // districts a later version could add
}

Hard rules:
- Every zone's bounds must lie inside the world size and must not be degenerate.
- Every structure and npc position must be inside its zone's bounds.
- Every quest step target MUST be an id you defined above. Never invent an id.
- At least 3 zones, 8 structures, 5 npcs, 2 quests, and every quest needs 2+ steps.
- Vary positions. Do not lay everything out on a grid or at the origin.
Return JSON only.`;

/**
 * The boundary where a model's answer becomes this system's data.
 *
 * Exported because it IS the boundary: everything downstream trusts whatever
 * comes out of here, so it is worth testing directly rather than only through a
 * live HTTP call.
 *
 * This checked that `zones` and `structures` were ARRAYS and nothing about
 * what was in them. Every lane downstream then reads the elements —
 * `classifyLocally` reads `z.name`, `generateTerrainLocally` reads `z.bounds`
 * and `s.position`, `behaviorsLocally` reads `n.position` — so a model
 * answering `"zones": ["downtown","harbour"]` with strings instead of
 * objects, or slipping one null into a list, took the whole generation down
 * with a 500 from inside a lane's own fallback. Five ordinary model slips,
 * five 500s, and the deterministic fallback that exists to prevent exactly
 * that could not run because the bad data reached it too.
 *
 * Unusable rows are DROPPED rather than repaired: a zone that is the string
 * "downtown" carries no bounds and inventing them would be making up the
 * world. If too little survives to be a world, this returns null and the lane
 * falls through to the local architect — a plainer world, which is the
 * outcome the fallback exists to provide.
 */
export function parseArchitectPlan(t) {
  const j = parseJsonLoose(t);
  if (!j || !Array.isArray(j.zones) || !Array.isArray(j.structures)) return null;

  const rows = (v) => (Array.isArray(v) ? v : []).filter(
    (x) => x !== null && typeof x === "object" && !Array.isArray(x) && typeof x.id === "string" && x.id !== "",
  );
  const bounded = (z) => Array.isArray(z.bounds) && z.bounds.length === 4
    && z.bounds.every((n) => typeof n === "number" && Number.isFinite(n))
    && z.bounds[2] > z.bounds[0] && z.bounds[3] > z.bounds[1];

  const plan = { ...j };
  plan.zones = rows(j.zones).filter(bounded);
  plan.structures = rows(j.structures);
  plan.npcs = rows(j.npcs);
  plan.items = rows(j.items);
  plan.quests = rows(j.quests);
  const dim = (v, d) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : d);
  plan.size = { w: dim(j.size?.w, 260), h: dim(j.size?.h, 260) };

  // A world needs somewhere to be and something to be there. Below that, the
  // deterministic architect does a better job than a salvage of this would.
  if (!plan.zones.length || !plan.structures.length) return null;
  return plan;
}

export function architectAdapters(env = process.env) {
  const build = (req) =>
    `Design a world for this prompt: "${req.prompt}"\n` +
    (req.style ? `Requested style: ${req.style}\n` : "") +
    (req.constraints ? `Constraints: ${JSON.stringify(req.constraints)}\n` : "") +
    `Seed: ${req.seed ?? 0}. Make the layout specific to this prompt, not generic.`;
  return [
    makeChatAdapter({ vendor: "deepseek", model: "deepseek-v4-pro", lane: LANES.WORLD_ARCHITECT, rank: 10, system: ARCHITECT_SYSTEM, build, parse: parseArchitectPlan, temperature: 0.8, maxTokens: 8000, env }),
    makeChatAdapter({ vendor: "together", model: "zai-org/GLM-5.3", lane: LANES.WORLD_ARCHITECT, rank: 20, system: ARCHITECT_SYSTEM, build, parse: parseArchitectPlan, temperature: 0.8, maxTokens: 8000, env }),
    makeChatAdapter({ vendor: "cerebras", model: "gpt-oss-120b", lane: LANES.WORLD_ARCHITECT, rank: 30, system: ARCHITECT_SYSTEM, build, parse: parseArchitectPlan, temperature: 0.8, maxTokens: 6000, env }),
    {
      name: "local:procedural-architect",
      lane: LANES.WORLD_ARCHITECT,
      rank: 99,
      isFallback: true,
      model: "deterministic",
      async status() { return STATUS.FALLBACK; },
      async invoke(req) { return planWorldLocally(req); },
    },
  ];
}

// -------------------------------------------------------------- fast inference
//
// Cerebras first: this lane is deliberately cheap and high-volume — tags,
// classification, metadata, short validations.

const FAST_SYSTEM = `You classify and tag game worlds. Return ONE JSON object:
{ "genre": string, "tags": [string], "maturity": "13+"|"16+"|"18+", "mood": string, "summary": string }
Return JSON only. Be terse.`;

export function fastAdapters(env = process.env) {
  const build = (req) => `Classify this world.\nTitle: ${req.title || "(untitled)"}\nPrompt: ${req.prompt}\nZones: ${(req.zones || []).map((z) => z.name).join(", ")}`;
  const parse = (t) => parseJsonLoose(t);
  return [
    makeChatAdapter({ vendor: "cerebras", model: "gpt-oss-120b", lane: LANES.FAST_INFERENCE, rank: 10, system: FAST_SYSTEM, build, parse, temperature: 0.3, maxTokens: 700, env }),
    makeChatAdapter({ vendor: "cerebras", model: "qwen-3.8-27b", lane: LANES.FAST_INFERENCE, rank: 15, system: FAST_SYSTEM, build, parse, temperature: 0.3, maxTokens: 700, env }),
    makeChatAdapter({ vendor: "together", model: "zai-org/GLM-5.3-Flash", lane: LANES.FAST_INFERENCE, rank: 20, system: FAST_SYSTEM, build, parse, temperature: 0.3, maxTokens: 700, env }),
    {
      name: "local:keyword-classifier",
      lane: LANES.FAST_INFERENCE,
      rank: 99,
      isFallback: true,
      model: "deterministic",
      async status() { return STATUS.FALLBACK; },
      async invoke(req) { return classifyLocally(req); },
    },
  ];
}

// ------------------------------------------------------------------- gameplay
//
// A strong coding/reasoning model writes DECLARATIVE behaviour specs, not
// arbitrary JavaScript: the runtime interprets a fixed vocabulary, so a
// generated behaviour can never execute untrusted code in a player's browser.

const GAMEPLAY_SYSTEM = `You define interactive behaviour for a 3D game world as DECLARATIVE specs.
You never write code. Return ONE JSON object:
{
  "behaviors": [ { "id": snake_case,
                   "kind": "door"|"elevator"|"vehicle"|"enemy_ai"|"npc_ai"|"combat"|"quest_trigger"|"switch"|"container"|"terminal"|"platform"|"hazard"|"pickup"|"teleporter",
                   "spec": object } ],
  "interactions": [ { "id": snake_case,
                      "trigger": "proximity"|"interact"|"enter_zone"|"exit_zone"|"timer"|"quest_state"|"damage"|"collision",
                      "target_ref": "an id from the world you were given",
                      "behavior_ref": "one of the behavior ids above",
                      "params": object } ]
}
Spec vocabulary by kind:
  door      { "opens": "inward"|"outward"|"slide", "speed": n, "locked_by": item id|null, "auto_close_s": n|null }
  elevator  { "floors": [n], "speed": n, "call_from": [zone ids] }
  vehicle   { "seats": n, "max_speed": n, "acceleration": n, "handling": n, "enterable": true }
  enemy_ai  { "aggro_radius": n, "patrol": [{"x":n,"z":n}], "damage": n, "health": n, "flee_below": n }
  npc_ai    { "routine": "idle"|"patrol"|"vendor"|"guard"|"wander", "waypoints": [{"x":n,"z":n}], "dialogue_topics": [string] }
  switch    { "toggles": [ref], "starts": "on"|"off" }
  container { "contains": [item id], "locked_by": item id|null }
  terminal  { "screens": [string], "unlocks": [ref] }
  platform  { "path": [{"x":n,"y":n,"z":n}], "loop": bool, "speed": n }
  hazard    { "damage_per_second": n, "radius": n }
  pickup    { "item": item id, "respawn_s": n|null }
  teleporter{ "to_zone": zone id, "to_position": {"x":n,"y":n,"z":n} }
Only reference ids that exist in the world you were given. Return JSON only.`;

export function gameplayAdapters(env = process.env) {
  const build = (req) =>
    `Give this world real interactive behaviour.\n\n` +
    `Zones: ${JSON.stringify((req.zones || []).map((z) => ({ id: z.id, kind: z.kind })))}\n` +
    `Structures: ${JSON.stringify((req.structures || []).slice(0, 40).map((s) => ({ id: s.id, archetype: s.archetype || s.asset_ref, enterable: s.enterable })))}\n` +
    `NPCs: ${JSON.stringify((req.npcs || []).slice(0, 30).map((n) => ({ id: n.id, role: n.role, behavior: n.behavior })))}\n` +
    `Items: ${JSON.stringify((req.items || []).map((i) => i.id))}\n` +
    `Genre: ${req.genre || "unspecified"}. Prefer behaviour a player will actually notice: openable doors, a usable vehicle, a working lift, enemies that react.`;
  const parse = (t) => {
    const j = parseJsonLoose(t);
    if (!j || !Array.isArray(j.behaviors)) return null;
    return j;
  };
  return [
    makeChatAdapter({ vendor: "deepseek", model: "deepseek-v4-pro", lane: LANES.GAMEPLAY, rank: 10, system: GAMEPLAY_SYSTEM, build, parse, temperature: 0.5, maxTokens: 12000, env }),
    makeChatAdapter({ vendor: "together", model: "deepseek-ai/DeepSeek-V4-Pro-0813", lane: LANES.GAMEPLAY, rank: 20, system: GAMEPLAY_SYSTEM, build, parse, temperature: 0.5, maxTokens: 12000, env }),
    makeChatAdapter({ vendor: "cerebras", model: "gpt-oss-120b", lane: LANES.GAMEPLAY, rank: 30, system: GAMEPLAY_SYSTEM, build, parse, temperature: 0.5, maxTokens: 5000, env }),
    {
      name: "local:behavior-library",
      lane: LANES.GAMEPLAY,
      rank: 99,
      isFallback: true,
      model: "deterministic",
      async status() { return STATUS.FALLBACK; },
      async invoke(req) { return behaviorsLocally(req); },
    },
  ];
}
