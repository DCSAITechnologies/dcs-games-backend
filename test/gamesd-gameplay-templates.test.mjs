// Games-D gameplay/objective templates: every template at every difficulty
// builds, validates, is reachable, survives save/reload and is WON by the
// headless agent; templates play differently; difficulty bites; builds are
// deterministic; a template whose needs are unmet degrades instead of throwing.
process.env.DCS_PROVIDERS_OFFLINE = "1";

import test from "node:test";
import assert from "node:assert/strict";
import { buildFromRecipe, makeContext } from "../src/gamesd/engine.mjs";
import { normaliseRecipe, recipeFromPrompt } from "../src/gamesd/recipe.mjs";
import { THEMES } from "../src/gamesd/world/themes.mjs";
import { LAYOUTS } from "../src/gamesd/missions/layouts.mjs";
import { DIFFICULTY } from "../src/gamesd/difficulty.mjs";
import { TEMPLATES, applyTemplate, templateConceptPatch, requiredKinds, effectiveHazardDps } from "../src/gamesd/gameplay/templates.mjs";
import { validateGameplay, GAME_TYPES } from "../src/gamesb/gameplay/gameplay.schema.mjs";
import { gameplaySkeleton } from "../src/gamesb/gameplay/generate.mjs";
import { timeLimit } from "../src/gamesb/gameplay/rules-engine.mjs";

console.warn = () => {};

// Other agents replace the theme/layout tables concurrently: read them at run time.
const THEME_IDS = Object.keys(THEMES);
const LAYOUT = Object.keys(LAYOUTS)[0];
const IDS = Object.keys(TEMPLATES);
const LEVELS = ["easy", "normal", "hard"];
const themeFor = (i) => THEME_IDS[i % THEME_IDS.length];
const degraded = (res, id) => res.notes.some((n) => n.startsWith(`template ${id}:`));
const why = (res) => JSON.stringify({ reason: res.playtest?.reason, pending: res.playtest?.pending, validation: res.validation?.errors?.slice?.(0, 3), reach: res.reachability?.ok, notes: res.notes });

const maxDps = (g) => Math.max(0, ...g.hazards.map((h) => effectiveHazardDps(h, g)));

test("the template table: 8+ distinct play patterns with the contract fields", () => {
  assert.ok(IDS.length >= 8, `only ${IDS.length} templates`);
  for (const id of IDS) {
    const t = TEMPLATES[id];
    assert.equal(t.id, id);
    for (const k of ["name", "summary"]) assert.ok(typeof t[k] === "string" && t[k].length > 3, `${id}.${k}`);
    assert.ok(GAME_TYPES.includes(t.genre), `${id} genre ${t.genre}`);
    assert.equal(typeof t.timed, "boolean");
    assert.equal(typeof t.apply, "function");
    assert.ok(Array.isArray(t.keywords) && t.keywords.length >= 3, `${id} keywords`);
    assert.ok(t.needs && typeof t.needs === "object");
    for (const k of ["hostiles_min", "hostiles_max", "locations_min"]) if (t.needs[k] !== undefined) assert.ok(Number.isInteger(t.needs[k]) && t.needs[k] >= 0, `${id}.needs.${k}`);
    if (t.needs.hostiles_min !== undefined && t.needs.hostiles_max !== undefined) assert.ok(t.needs.hostiles_min <= t.needs.hostiles_max);
    assert.ok(!t.kinds.includes("escort"), `${id} must not rely on escort`);
  }
  assert.ok(new Set(IDS.map((id) => TEMPLATES[id].genre)).size >= 5, "templates should span several genres");
});

test("templateConceptPatch sets the genre and the outline", () => {
  const c0 = { title: "X", genre: "adventure", objectives_outline: ["a"] };
  for (const id of IDS) {
    const c = templateConceptPatch(c0, { template: TEMPLATES[id] });
    assert.equal(c.genre, TEMPLATES[id].genre);
    assert.ok(Array.isArray(c.objectives_outline) && c.objectives_outline.length);
  }
  assert.equal(c0.genre, "adventure", "does not mutate its input");
});

test("recipeFromPrompt picks templates by keyword", () => {
  const cases = { "a stealth heist past the guards": "stealth_infiltration", "a courier who must deliver parcels": "courier_run", "hunt the monster and slay the beast": "hunt", "survive the siege and hold the line": "last_stand", "a timed race against the clock": "timed_rush", "find the key to unlock the vault": "lock_and_key" };
  for (const [p, want] of Object.entries(cases)) assert.equal(recipeFromPrompt(p, { seed: 1 }).template, want, p);
});

// Every template × every difficulty, one seed; the theme rotates per template.
const seen = {};
IDS.forEach((id, i) => {
  test(`${id}: easy, normal and hard all build and are won by the headless agent`, async () => {
    const theme = themeFor(i);
    const out = {};
    for (const difficulty of LEVELS) {
      const res = await buildFromRecipe({ seed: 1, theme, template: id, layout: LAYOUT, difficulty });
      assert.ok(res.validation.ok, `${id}/${difficulty} validation ${why(res)}`);
      assert.ok(res.reachability.ok, `${id}/${difficulty} reachability ${why(res)}`);
      assert.ok(res.playtest.won, `${id}/${difficulty} not won ${why(res)}`);
      assert.ok(res.playtest.save_reload.ok, `${id}/${difficulty} save/reload`);
      assert.ok(res.ok, `${id}/${difficulty} ok ${why(res)}`);
      const g = res.pkg.gameplay;
      assert.ok(validateGameplay(g, { world: res.pkg.world, characters: res.pkg.characters }).ok);
      assert.equal(g.difficulty.level, difficulty);
      assert.equal(g.rules.player_health, DIFFICULTY[difficulty].player_health);
      assert.equal(g.rules.lives, DIFFICULTY[difficulty].lives);
      const kinds = requiredKinds(g);
      assert.ok(!kinds.includes("escort"));
      if (!degraded(res, id)) {
        for (const k of TEMPLATES[id].kinds) assert.ok(kinds.includes(k), `${id}/${difficulty}: declared kind '${k}' missing from ${kinds.join(",")}`);
        assert.equal(g.game_type, TEMPLATES[id].genre);
      }
      out[difficulty] = { g, kinds, degraded: degraded(res, id) };
    }
    seen[id] = out;
    // Difficulty: hard hurts more per second and (when timed) gives less time.
    const E = out.easy.g, H = out.hard.g;
    assert.ok(H.difficulty.damage_mult > E.difficulty.damage_mult);
    if (E.hazards.length && H.hazards.length) assert.ok(maxDps(H) > maxDps(E), `${id}: hard ${maxDps(H)} dps vs easy ${maxDps(E)}`);
    const tE = timeLimit(E), tH = timeLimit(H);
    if (TEMPLATES[id].timed && !out.easy.degraded) {
      assert.ok(tE !== null && tH !== null, `${id} should be timed`);
      assert.ok(tH < tE, `${id}: hard ${tH}s vs easy ${tE}s`);
      assert.ok(H.lose_conditions.some((l) => l.kind === "time_expired"));
    }
    if (id === "last_stand" && !out.easy.degraded) {
      const hold = (g) => g.objectives.find((o) => o.kind === "survive").count;
      assert.ok(hold(H) > hold(E), "hard holds for longer");
    }
  });
});

// A second seed for the patterns with the most moving parts.
for (const [k, id] of ["hunt", "last_stand", "timed_rush", "courier_run", "lock_and_key", "stealth_infiltration"].entries()) {
  test(`${id}: a second seed stays winnable on normal and hard`, async () => {
    for (const difficulty of ["normal", "hard"]) {
      const res = await buildFromRecipe({ seed: 2, theme: themeFor(k + 3), template: id, layout: LAYOUT, difficulty });
      assert.ok(res.ok && res.playtest.won, `${id}/seed 2/${difficulty} ${why(res)}`);
    }
  });
}

test("templates play differently: required objective-kind sequences differ on the same world", async () => {
  const theme = THEME_IDS[0];
  const seqs = new Map();
  for (const id of IDS) {
    const res = await buildFromRecipe({ seed: 7, theme, template: id, layout: LAYOUT, difficulty: "normal" }, { playtest: false });
    assert.ok(res.validation.ok, `${id} ${why(res)}`);
    if (degraded(res, id)) continue;
    const g = res.pkg.gameplay;
    seqs.set(id, `${requiredKinds(g).join(",")}|${g.win_conditions.map((w) => w.kind).join(",")}|${g.rules.time_limit_s ? "timed" : ""}`);
  }
  assert.ok(seqs.size >= 8, `only ${seqs.size} templates ran undegraded: ${[...seqs.keys()].join(",")}`);
  const bySeq = new Map();
  for (const [id, s] of seqs) { assert.ok(!bySeq.has(s), `${id} plays like ${bySeq.get(s)}: ${s}`); bySeq.set(s, id); }
  // Across the rotation built above, the kind sequences (alone) are also mostly distinct.
  const kindSeqs = new Set(Object.values(seen).map((o) => o.normal.kinds.join(",")));
  if (Object.keys(seen).length === IDS.length) assert.ok(kindSeqs.size >= IDS.length - 1, `kind sequences: ${[...kindSeqs].join(" / ")}`);
});

test("the same recipe rebuilds the same package bytes", async () => {
  for (const [id, difficulty] of [["last_stand", "hard"], ["courier_run", "normal"], ["beacon_circuit", "easy"]]) {
    const r = { seed: 3, theme: themeFor(1), template: id, layout: LAYOUT, difficulty };
    const a = await buildFromRecipe(r, { playtest: false });
    const b = await buildFromRecipe(r, { playtest: false });
    assert.equal(a.pkg.integrity.sha256, b.pkg.integrity.sha256, id);
    assert.deepEqual(a.notes, b.notes);
  }
});

test("unmet needs degrade to a valid pattern with a note; bad input never throws", async () => {
  const res = await buildFromRecipe({ seed: 5, theme: THEME_IDS[0], template: "hunt", layout: LAYOUT, difficulty: "normal" }, { playtest: false });
  const { concept, world } = res.pkg;
  // The same world with every hostile removed: nothing to hunt, nothing to sneak past.
  const characters = { ...res.pkg.characters, characters: res.pkg.characters.characters.filter((c) => !c.behavior?.hostile && !["enemy", "creature", "guard"].includes(c.role)) };
  const skeleton = gameplaySkeleton({ concept, world, characters });
  const recipe = normaliseRecipe({ seed: 5, theme: THEME_IDS[0], template: "hunt", layout: LAYOUT, difficulty: "hard" });
  const ctx = { ...makeContext(recipe), concept, world, characters };
  const g = applyTemplate(skeleton, ctx);
  assert.ok(validateGameplay(g, { world, characters }).ok);
  assert.ok(!requiredKinds(g).includes("defeat"));
  assert.ok(ctx.notes.some((n) => n.includes("template hunt:") && n.includes("degrading")), ctx.notes.join(" | "));
  assert.equal(g.difficulty.level, "hard");

  for (const bad of [{}, { template: TEMPLATES.relic_hunt }, { template: { id: "nope" }, concept, world: { regions: [] }, characters: null, notes: [] }]) {
    assert.doesNotThrow(() => applyTemplate(skeleton, bad));
  }
});
