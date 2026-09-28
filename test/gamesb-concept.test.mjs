// Games-B concept stage: deterministic fallback, validator, and LLM repair.
// Runs offline; the "LLM" is an injected transport returning canned text.
process.env.DCS_PROVIDERS_OFFLINE = "1";

import test from "node:test";
import assert from "node:assert/strict";
import { generateConcept, conceptLocally, repairConcept, conceptAdapters, validateConcept, BIOMES, GENRES } from "../src/gamesb/concept/index.mjs";
import { estimateCostUsd } from "../src/gamesb/concept/llm.mjs";

// Lane.run logs degraded adapters as JSON on stderr; keep test output readable.
console.warn = () => {};

const PROMPTS = [
  "A haunted lighthouse on a stormy island at night",
  "a cozy forest village puzzle with mushroom lanterns",
  "stealth heist through a neon city at midnight",
  "survive a blizzard on a frozen mountain",
  "explore ancient desert ruins at dawn",
  "vast volcanic caldera mission to stop an eruption",
  "sci-fi mars colony reactor repair",
  "collect gems across a sunny canyon",
  "a misty temple labyrinth full of secrets",
  "small tropical beach adventure",
];

test("same prompt → byte-identical concept; seed changes it", async () => {
  for (const p of PROMPTS.slice(0, 4)) {
    const a = await generateConcept(p);
    const b = await generateConcept(p);
    assert.equal(JSON.stringify(a.concept), JSON.stringify(b.concept));
  }
  const x = conceptLocally(PROMPTS[0], { seed: 1 });
  const y = conceptLocally(PROMPTS[0], { seed: 2 });
  assert.notEqual(JSON.stringify(x), JSON.stringify(y));
  assert.equal(x.biome, y.biome, "biome comes from the prompt, not the seed");
});

test("diverse prompts give valid concepts across biomes and genres", async () => {
  const biomes = new Set(), genres = new Set();
  for (const p of PROMPTS) {
    const { concept, provenance } = await generateConcept(p);
    const v = validateConcept(concept);
    assert.ok(v.ok, `${p}: ${JSON.stringify(v.errors)}`);
    assert.deepEqual(v.warnings, [], p);
    assert.equal(concept.key_locations[0].kind, "hub");
    assert.ok(concept.key_locations.length >= 4 && concept.key_locations.length <= 6);
    const roles = concept.characters.map((c) => c.role);
    assert.ok(roles.includes("companion") && roles.includes("quest_giver"), p);
    if (concept.genre !== "puzzle") assert.ok(roles.some((r) => ["guard", "enemy", "creature"].includes(r)), `${p}: needs a hostile`);
    assert.ok(concept.characters.length >= 3 && concept.characters.length <= 5);
    assert.equal(concept.seed, (await import("../src/gamesb/common/rng.mjs")).hashString(p.trim()));
    assert.equal(provenance.status, "FALLBACK");
    biomes.add(concept.biome); genres.add(concept.genre);
  }
  assert.ok(biomes.size >= 7, `biomes covered: ${[...biomes]}`);
  assert.ok(genres.size >= 5, `genres covered: ${[...genres]}`);
  for (const b of biomes) assert.ok(BIOMES.includes(b));
  for (const g of genres) assert.ok(GENRES.includes(g));
});

test("prompt keywords drive the concept", () => {
  const c = conceptLocally("A haunted lighthouse on a stormy island at night");
  assert.equal(c.biome, "island");
  assert.equal(c.weather, "storm");
  assert.equal(c.mood, "eerie");
  assert.equal(c.time_of_day, 0.9);
  assert.match(c.key_locations.at(-1).name, /Lighthouse/, "the prompt's landmark is the finale");
  assert.equal(conceptLocally("a cozy puzzle garden in the woods").genre, "puzzle");
  assert.ok(!conceptLocally("a cozy puzzle garden in the woods").characters.some((c) => ["guard", "enemy", "creature"].includes(c.role)));
  assert.equal(conceptLocally("a vast open desert").scale, "large");
});

test("offline: FALLBACK provenance per §8, Cerebras recorded as tried", async () => {
  const { provenance } = await generateConcept("snowy ruins", { env: { DCS_PROVIDERS_OFFLINE: "1", CEREBRAS_API_KEY: "not-used" } });
  assert.equal(provenance.stage, "concept");
  assert.equal(provenance.status, "FALLBACK");
  assert.equal(provenance.provider, "local:keyword-concept");
  assert.equal(provenance.model, "deterministic");
  assert.equal(provenance.cost_usd, 0);
  assert.deepEqual(provenance.after_failed, ["cerebras:gpt-oss-120b"]);
  assert.ok(typeof provenance.latency_ms === "number" && provenance.at);
  // The default adapter list leads with Cerebras gpt-oss-120b.
  const [first, last] = [conceptAdapters({ env: {} })[0], conceptAdapters({ env: {} }).at(-1)];
  assert.equal(first.model, "gpt-oss-120b");
  assert.equal(await first.status(), "UNAVAILABLE", "no key → unavailable");
  assert.equal(last.isFallback, true);
  await assert.rejects(() => generateConcept("   "), /non-empty/);
});

function fakeLlm(text, usage = { prompt_tokens: 1200, completion_tokens: 800 }) {
  return conceptAdapters({ env: {}, chat: async () => ({ text, model: "gpt-oss-120b", usage }) }).slice(0, 1);
}

test("messy LLM JSON (fences, prose, synonyms, bad ids) is repaired and validates", async () => {
  const messy = "Sure! Here is your concept:\n```json\n" + JSON.stringify({
    title: "  Lanterns   of the Drowned Coast ",
    logline: "Relight the coast.",
    genre: "Action-Adventure", biome: "Tropical Beach", scale: "HUGE", mood: "Melancholy",
    time_of_day: 19, weather: "thunderstorm",
    palette: { primary: "#123456", secondary: "blue", accent: "#ABCDEF" },
    key_locations: [
      { id: "The Old Lighthouse!", name: "The Old Lighthouse", kind: "Lighthouse", description: "A tower." },
      { id: "harbor-town", name: "Harbor Town", kind: "Base", description: "Start." },
      "Smugglers Cave",
      { name: "Harbor Town", kind: "town" },
      null,
    ],
    characters: [
      { id: "Captain Vey", name: "Captain Vey", role: "Mentor", description: "Old sailor." },
      { name: "Gull", role: "sidekick" },
      { name: "Drowned Sailor", role: "monster" },
      { name: "A", role: "npc" }, { name: "B", role: "npc" }, { name: "C", role: "npc" },
    ],
    objectives_outline: ["Relight the lighthouse", { text: "Find the lens" }, 42],
    hazards: "big waves",
  }) + "\n```\nHope this helps!";
  const { concept, provenance } = await generateConcept("drowned coast lighthouse", { adapters: fakeLlm(messy) });
  const v = validateConcept(concept);
  assert.ok(v.ok, JSON.stringify(v.errors));
  assert.equal(provenance.status, "AVAILABLE");
  assert.equal(provenance.provider, "cerebras:gpt-oss-120b");
  assert.deepEqual(provenance.tokens, { in: 1200, out: 800 });
  assert.equal(provenance.cost_usd, estimateCostUsd("gpt-oss-120b", { in: 1200, out: 800 }));
  assert.ok(provenance.cost_usd > 0);
  assert.equal(concept.title, "Lanterns of the Drowned Coast");
  assert.equal(concept.genre, "adventure");
  assert.equal(concept.biome, "island");
  assert.equal(concept.scale, "medium", "unknown scale falls back to the deterministic value");
  assert.equal(concept.weather, "storm");
  assert.equal(concept.time_of_day, Math.round((19 / 24) * 1000) / 1000);
  assert.equal(concept.palette.primary, "#123456");
  assert.equal(concept.palette.accent, "#abcdef");
  assert.match(concept.palette.secondary, /^#[0-9a-f]{6}$/);
  assert.equal(concept.key_locations[0].id, "harbor_town");
  assert.equal(concept.key_locations[0].kind, "hub");
  assert.equal(concept.key_locations[1].id, "the_old_lighthouse");
  assert.equal(concept.key_locations[1].kind, "tower");
  assert.equal(new Set(concept.key_locations.map((l) => l.id)).size, concept.key_locations.length);
  assert.ok(concept.characters.length <= 5);
  assert.equal(concept.characters[0].role, "quest_giver");
  assert.ok(concept.characters.some((c) => c.role === "companion"));
  assert.ok(concept.characters.some((c) => c.role === "creature"));
  assert.deepEqual(concept.objectives_outline, ["Relight the lighthouse", "Find the lens"]);
  // Identity always comes from the deterministic path.
  const base = conceptLocally("drowned coast lighthouse");
  assert.equal(concept.prompt_hash, base.prompt_hash);
  assert.equal(concept.seed, base.seed);
});

test("truncated LLM JSON is salvaged, gaps filled from the deterministic concept", async () => {
  const full = JSON.stringify({
    title: "Frostbound", genre: "survival", biome: "arctic", weather: "blizzard",
    key_locations: [{ id: "camp", name: "Base Camp", kind: "hub", description: "Tents." }, { id: "peak", name: "The Peak", kind: "summit", description: "High." }],
    characters: [{ id: "sherpa", name: "Sherpa", role: "companion", description: "Guide." }, { id: "yeti", name: "Yeti", role: "creature", description: "Big." }],
    hazards: ["cold", "wind"],
  });
  const cut = full.slice(0, full.indexOf('"hazards"') + 16);   // mid-array, no closing braces
  const { concept, provenance } = await generateConcept("frozen peak", { adapters: fakeLlm(cut, null) });
  const v = validateConcept(concept);
  assert.ok(v.ok, JSON.stringify(v.errors));
  assert.equal(provenance.status, "AVAILABLE");
  assert.equal(provenance.tokens, undefined);
  assert.equal(concept.title, "Frostbound");
  assert.equal(concept.biome, "snow");
  assert.equal(concept.weather, "snow");
  assert.ok(concept.key_locations.length >= 4, "filled up to four from the base concept");
  assert.ok(concept.characters.some((c) => c.role === "quest_giver"), "quest giver filled in");
});

test("unusable LLM output falls through to the deterministic concept", async () => {
  const base = conceptLocally("harbour town");
  const r1 = await generateConcept("harbour town", { adapters: fakeLlm("I cannot help with that.") });
  assert.equal(r1.provenance.status, "FALLBACK");
  assert.deepEqual(r1.concept, base);
  assert.deepEqual(r1.provenance.after_failed, ["cerebras:gpt-oss-120b"]);
  const r2 = await generateConcept("harbour town", { adapters: fakeLlm("[1,2,3]") });
  assert.equal(r2.provenance.status, "FALLBACK");
  // An empty object still repairs into a valid concept — the base fills it.
  const rep = repairConcept({}, base);
  assert.ok(validateConcept(rep).ok);
});

test("validateConcept rejects broken concepts", () => {
  const good = conceptLocally("island");
  const bad = (f) => { const c = JSON.parse(JSON.stringify(good)); f(c); return validateConcept(c); };
  assert.ok(validateConcept(good).ok);
  assert.ok(!bad((c) => { c.biome = "jungle"; }).ok);
  assert.ok(!bad((c) => { c.key_locations.reverse(); }).ok, "hub not first");
  assert.ok(!bad((c) => { c.key_locations[1].id = "Bad Id"; }).ok);
  assert.ok(!bad((c) => { c.key_locations[2].id = c.key_locations[1].id; }).ok);
  assert.ok(!bad((c) => { c.palette.sky = "blue"; }).ok);
  assert.ok(!bad((c) => { c.time_of_day = 2; }).ok);
  assert.ok(!bad((c) => { c.characters = c.characters.filter((x) => x.role !== "quest_giver"); }).ok);
  assert.ok(!bad((c) => { c.prompt_hash = "abc"; }).ok);
  assert.ok(!validateConcept(null).ok);
});
