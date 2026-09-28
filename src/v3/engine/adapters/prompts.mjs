// GAMES-A — the system prompts for text task classes.
//
// WORLD_DESIGN and GAMEPLAY_LOGIC reuse the B1 prompts verbatim, so a plan from
// the engine drops into the assembly router exactly like one from a B1 lane.
// CODE_GENERATION asks for the same DECLARATIVE behaviour vocabulary — the
// runtime interprets specs and never executes model-written code in a player's
// browser — plus unit-testable acceptance checks.
import { TASK } from "../task-classes.mjs";
import { parseJsonLoose } from "../../providers/contract.mjs";
import { parseArchitectPlan, ARCHITECT_SYSTEM, FAST_SYSTEM, GAMEPLAY_SYSTEM } from "../../providers/text.mjs";

const CODE_SYSTEM = GAMEPLAY_SYSTEM.replace(
  "Only reference ids that exist in the world you were given. Return JSON only.",
  `Only reference ids that exist in the world you were given.
Also return "checks": [ { "id": snake_case, "behavior_ref": behavior id, "given": string, "when": string, "then": string } ]
— one acceptance check per behavior, phrased so a playtest agent can verify it. Return JSON only.`,
);

export const TEXT_TASKS = [TASK.WORLD_DESIGN, TASK.GAMEPLAY_LOGIC, TASK.FAST_ITERATION, TASK.CODE_GENERATION];

const worldBrief = (req) =>
  `Zones: ${JSON.stringify((req.zones || []).map((z) => ({ id: z.id, kind: z.kind })))}\n` +
  `Structures: ${JSON.stringify((req.structures || []).slice(0, 40).map((s) => ({ id: s.id, archetype: s.archetype || s.asset_ref, enterable: s.enterable })))}\n` +
  `NPCs: ${JSON.stringify((req.npcs || []).slice(0, 30).map((n) => ({ id: n.id, role: n.role, behavior: n.behavior })))}\n` +
  `Items: ${JSON.stringify((req.items || []).map((i) => i.id))}\n`;

export const TEXT_SPEC = {
  [TASK.WORLD_DESIGN]: {
    system: ARCHITECT_SYSTEM, temperature: 0.8, maxTokens: 8000,
    user: (req) => `Design a world for this prompt: "${req.prompt}"\n` + (req.style ? `Requested style: ${req.style}\n` : "") +
      (req.constraints ? `Constraints: ${JSON.stringify(req.constraints)}\n` : "") + `Seed: ${req.seed ?? 0}. Make the layout specific to this prompt, not generic.`,
    parse: parseArchitectPlan,
  },
  [TASK.GAMEPLAY_LOGIC]: {
    system: GAMEPLAY_SYSTEM, temperature: 0.5, maxTokens: 12000,
    user: (req) => `Give this world real interactive behaviour.\n\n${worldBrief(req)}Genre: ${req.genre || "unspecified"}.` + (req.prompt ? `\nDesign intent: ${req.prompt}` : ""),
    parse: (t) => { const j = parseJsonLoose(t); return j && Array.isArray(j.behaviors) ? j : null; },
  },
  [TASK.FAST_ITERATION]: {
    system: FAST_SYSTEM, temperature: 0.3, maxTokens: 700,
    user: (req) => `Classify this world.\nTitle: ${req.title || "(untitled)"}\nPrompt: ${req.prompt}\nZones: ${(req.zones || []).map((z) => z.name).join(", ")}`,
    parse: (t) => parseJsonLoose(t),
  },
  [TASK.CODE_GENERATION]: {
    system: CODE_SYSTEM, temperature: 0.3, maxTokens: 12000,
    user: (req) => `Write the behaviour specs and acceptance checks for: ${req.prompt}\n\n${worldBrief(req)}`,
    parse: (t) => { const j = parseJsonLoose(t); return j && Array.isArray(j.behaviors) ? j : null; },
  },
};
