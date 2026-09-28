// Games-D mission/level variety: layouts, the sample catalogue and the preset matrix.
import { test } from "node:test";
import assert from "node:assert/strict";

import { LAYOUTS, ORDERINGS, LOCATION_KINDS, layoutConceptPatch } from "../src/gamesd/missions/layouts.mjs";
import { buildFromRecipe, makeContext } from "../src/gamesd/engine.mjs";
import { normaliseRecipe, recipeFromPrompt, validateRecipe } from "../src/gamesd/recipe.mjs";
import { THEMES } from "../src/gamesd/world/themes.mjs";
import { TEMPLATES } from "../src/gamesd/gameplay/templates.mjs";
import { LIGHTING } from "../src/gamesd/world/lighting.mjs";
import { DIFFICULTY_LEVELS } from "../src/gamesd/difficulty.mjs";
import { SAMPLE_RECIPES, sampleRecipes, catalogueCoverage } from "../src/gamesd/samples/catalogue.mjs";
import { presetMatrix, matrixCsv, compatibility, tables, PRESET_MATRIX_COLUMNS } from "../src/gamesd/samples/matrix.mjs";
import { conceptLocally } from "../src/gamesb/concept/concept.mjs";
import { validateConcept } from "../src/gamesb/concept/concept.schema.mjs";
import { generateWorldSpec, isConnected, SIZE_BY_SCALE } from "../src/gamesb/world/world-spec.mjs";

const DRAMA = { hub: 0, camp: 1, dock: 1, village: 1, grove: 2, cave: 2, ruin: 3, landmark: 4, shrine: 4, tower: 5, summit: 5 };
const theme0 = THEMES.pine_valley ? "pine_valley" : Object.keys(THEMES)[0];
const template0 = TEMPLATES.classic_chain ? "classic_chain" : Object.keys(TEMPLATES)[0];

// ------------------------------------------------------------ geometry

function geometry(world) {
  const regs = world.regions, hub = regs[0], fin = regs[regs.length - 1];
  const edge = world.size.w;
  const d = regs.slice(1).map((r) => Math.hypot(r.center.x - hub.center.x, r.center.z - hub.center.z));
  const adj = new Map(regs.map((r) => [r.id, []]));
  for (const p of world.paths) { adj.get(p.from_region)?.push(p.to_region); adj.get(p.to_region)?.push(p.from_region); }
  // BFS depth of the finale on the path graph *without* any loop-closing edge back to the hub.
  const depth = (skipClosure) => {
    const D = new Map([[hub.id, 0]]), q = [hub.id];
    while (q.length) {
      const c = q.shift();
      for (const x of adj.get(c)) {
        if (skipClosure && ((c === hub.id && x === fin.id) || (c === fin.id && x === hub.id))) continue;
        if (!D.has(x)) { D.set(x, D.get(c) + 1); q.push(x); }
      }
    }
    return D.get(fin.id);
  };
  return {
    n: regs.length, edge, paths: world.paths.length,
    meanHub: d.reduce((a, b) => a + b, 0) / d.length,
    meanHubRel: d.reduce((a, b) => a + b, 0) / d.length / edge,
    finaleRel: d[d.length - 1] / edge,
    hubDegree: adj.get(hub.id).length,
    finaleDepth: depth(true),
    closesLoop: world.paths.some((p) => (p.from_region === fin.id && p.to_region === hub.id) || (p.from_region === hub.id && p.to_region === fin.id)),
  };
}

// Fixed seeds per layout that play through today on the default theme.
const SEED = { compact_trail: 1, classic: 1, hub_spoke: 1, grand_loop: 1, gauntlet: 1, outpost_cluster: 1, archipelago_hop: 1 };
const built = new Map();
async function buildLayout(layout, { theme = theme0, seed = SEED[layout] ?? 1, playtest = true } = {}) {
  const key = `${layout}|${theme}|${seed}|${playtest}`;
  if (!built.has(key)) built.set(key, buildFromRecipe({ seed, theme, template: template0, layout, difficulty: "normal" }, { playtest }));
  return built.get(key);
}

// ------------------------------------------------------------ table shape

test("layouts: at least 6, well-formed, classic kept", () => {
  const ids = Object.keys(LAYOUTS);
  assert.ok(ids.length >= 6, `have ${ids.length}`);
  assert.ok(LAYOUTS.classic && LAYOUTS.classic.locations === 5 && LAYOUTS.classic.ordering === "linear");
  const counts = new Set(), orderings = new Set();
  for (const [id, l] of Object.entries(LAYOUTS)) {
    assert.equal(l.id, id);
    assert.ok(l.name && typeof l.name === "string");
    assert.ok(["small", "medium", "large"].includes(l.scale), `${id} scale`);
    assert.ok(Number.isInteger(l.locations) && l.locations >= 4 && l.locations <= 6, `${id} locations ${l.locations}`);
    assert.ok(ORDERINGS.includes(l.ordering), `${id} ordering`);
    assert.ok(l.kinds.length >= l.locations - 2 && l.kinds.every((k) => LOCATION_KINDS.includes(k) && k !== "hub"), `${id} kinds`);
    assert.ok(l.keywords.length >= 3, `${id} keywords`);
    counts.add(l.locations); orderings.add(l.ordering);
  }
  assert.ok(counts.size >= 3, "different location counts");
  assert.ok(orderings.size >= 5, "every ordering used");
});

test("layoutConceptPatch: hub first, finale last, unique slug ids, valid kinds, themed names", () => {
  for (const layout of Object.keys(LAYOUTS)) for (const seed of [1, 7, 42]) {
    const recipe = normaliseRecipe({ seed, theme: theme0, template: template0, layout });
    const ctx = makeContext(recipe);
    const c0 = { ...conceptLocally("a lighthouse and a cave in the woods", { seed }), biome: THEMES[theme0].biome };
    const c = layoutConceptPatch(c0, ctx);
    const locs = c.key_locations;
    assert.equal(locs.length, LAYOUTS[layout].locations, `${layout}/${seed} count`);
    assert.equal(locs[0].kind, "hub");
    assert.equal(locs.filter((l) => l.kind === "hub").length, 1);
    assert.equal(new Set(locs.map((l) => l.id)).size, locs.length, "unique ids");
    for (const l of locs) {
      assert.match(l.id, /^[a-z0-9_]+$/);
      assert.ok(LOCATION_KINDS.includes(l.kind));
      assert.ok(l.name && l.description);
    }
    const fin = locs[locs.length - 1];
    assert.ok(LAYOUTS[layout].finale_kinds.includes(fin.kind), `${layout} finale kind ${fin.kind}`);
    for (const l of locs.slice(1)) assert.ok(DRAMA[l.kind] <= DRAMA[fin.kind], "finale is the most dramatic");
    assert.equal(c.scale, LAYOUTS[layout].scale);
    assert.equal(c.layout_ordering, LAYOUTS[layout].ordering === "linear" ? undefined : LAYOUTS[layout].ordering);
    assert.ok(c.objectives_outline.at(-1).includes(fin.name));
    const v = validateConcept(c);
    assert.ok(v.ok, JSON.stringify(v.errors));
    assert.deepEqual(v.warnings.filter((w) => w.path === "key_locations"), []);
  }
  // recipe.scale wins over the layout default.
  const r = normaliseRecipe({ seed: 1, theme: theme0, template: template0, layout: "compact_trail", scale: "large" });
  assert.equal(layoutConceptPatch(conceptLocally("x", { seed: 1 }), makeContext(r)).scale, "large");
});

test("world-spec: an absent or 'linear' layout_ordering is bit-identical to the historic layout", () => {
  const c = conceptLocally("a misty forest with an old tower", { seed: 11 });
  const a = JSON.stringify(generateWorldSpec(c));
  assert.equal(JSON.stringify(generateWorldSpec({ ...c, layout_ordering: "linear" })), a);
  assert.equal(JSON.stringify(generateWorldSpec({ ...c, layout_ordering: "no_such_ordering" })), a);
  assert.notEqual(JSON.stringify(generateWorldSpec({ ...c, layout_ordering: "gauntlet" })), a);
});

// ------------------------------------------------------------ builds

for (const layout of Object.keys(LAYOUTS)) {
  test(`build: layout ${layout} makes a playable game`, async () => {
    const res = await buildLayout(layout);
    assert.ok(res.ok, `${layout}: validation ${JSON.stringify(res.validation?.errors?.slice(0, 3))} reach ${JSON.stringify(res.reachability?.results?.filter((r) => !r.reachable))} playtest ${res.playtest?.reason}`);
    const w = res.pkg.world;
    assert.equal(w.regions.length, LAYOUTS[layout].locations);
    assert.equal(res.pkg.concept.key_locations.length, LAYOUTS[layout].locations);
    assert.equal(w.size.w, SIZE_BY_SCALE[LAYOUTS[layout].scale]);
    assert.ok(isConnected(w), "hub reaches every region");
    assert.equal(res.playtest.won, true);
  });
}

test("geometry: orderings produce measurably different region layouts and path graphs", async () => {
  const g = {};
  for (const layout of Object.keys(LAYOUTS)) g[layout] = geometry((await buildLayout(layout)).pkg.world);
  // hub_spoke: a star, every site one hop from the hub.
  assert.equal(g.hub_spoke.hubDegree, g.hub_spoke.n - 1);
  assert.equal(g.archipelago_hop.hubDegree, g.archipelago_hop.n - 1);
  // gauntlet: a chain; the hub has one path and the finale is n-1 hops away, far across the map.
  assert.equal(g.gauntlet.hubDegree, 1);
  assert.equal(g.gauntlet.finaleDepth, g.gauntlet.n - 1);
  assert.ok(g.gauntlet.finaleRel > 0.55, `gauntlet finale ${g.gauntlet.finaleRel}`);
  assert.ok(g.gauntlet.finaleRel > g.hub_spoke.finaleRel + 0.2);
  // loop: a chain round a ring that closes back on the hub (n paths for n regions).
  assert.equal(g.grand_loop.paths, g.grand_loop.n);
  assert.ok(g.grand_loop.closesLoop);
  assert.equal(g.grand_loop.hubDegree, 2);
  assert.equal(g.grand_loop.finaleDepth, g.grand_loop.n - 1);
  // cluster: everything close to the hub.
  assert.ok(g.outpost_cluster.meanHub < 55, `cluster mean ${g.outpost_cluster.meanHub}`);
  assert.ok(g.outpost_cluster.meanHub < g.hub_spoke.meanHub - 15);
  // tree-shaped layouts have n-1 paths.
  for (const id of ["compact_trail", "classic", "hub_spoke", "gauntlet", "outpost_cluster"]) assert.equal(g[id].paths, g[id].n - 1, id);
  // hub_spoke keeps its ring: the spread of hub distances is tight.
  const w = (await buildLayout("hub_spoke")).pkg.world, hub = w.regions[0];
  const d = w.regions.slice(1).map((r) => Math.hypot(r.center.x - hub.center.x, r.center.z - hub.center.z));
  assert.ok(Math.max(...d) - Math.min(...d) < 0.12 * w.size.w, `spoke spread ${d.map((x) => x.toFixed(0))}`);
});

test("geometry: orderings hold on a water theme too (world connected)", async () => {
  const water = Object.values(THEMES).find((t) => t.biome === "island")?.id;
  if (!water) return;
  for (const layout of ["hub_spoke", "grand_loop", "gauntlet", "outpost_cluster"]) {
    const res = await buildLayout(layout, { theme: water, playtest: false });
    const g = geometry(res.pkg.world);
    assert.ok(isConnected(res.pkg.world), `${water}/${layout} connected`);
    if (layout === "hub_spoke") assert.equal(g.hubDegree, g.n - 1);
    if (layout === "gauntlet") assert.equal(g.finaleDepth, g.n - 1);
    if (layout === "grand_loop") assert.ok(g.closesLoop);
    if (layout === "outpost_cluster") assert.ok(g.meanHub < 60);
  }
});

test("determinism: the same layout recipe rebuilds byte-identical", async () => {
  for (const layout of ["gauntlet", "grand_loop"]) {
    const a = await buildFromRecipe({ seed: 5, theme: theme0, template: template0, layout }, { playtest: false });
    const b = await buildFromRecipe({ seed: 5, theme: theme0, template: template0, layout }, { playtest: false });
    assert.equal(a.pkg.integrity.sha256, b.pkg.integrity.sha256);
    assert.deepEqual(a.pkg.concept.key_locations, b.pkg.concept.key_locations);
  }
  // A different seed changes the kinds or the placement.
  const c = await buildFromRecipe({ seed: 6, theme: theme0, template: template0, layout: "gauntlet" }, { playtest: false });
  const a = await buildFromRecipe({ seed: 5, theme: theme0, template: template0, layout: "gauntlet" }, { playtest: false });
  assert.notEqual(a.pkg.integrity.sha256, c.pkg.integrity.sha256);
});

// ------------------------------------------------------------ prompts

test("recipeFromPrompt picks sensible layouts", () => {
  const cases = [
    ["a quick short trail through the woods", "compact_trail"],
    ["hub and spokes: a base camp with trails radiating out", "hub_spoke"],
    ["a grand loop circuit around the island and back", "grand_loop"],
    ["a long gauntlet trek to the far mountain", "gauntlet"],
    ["defend a dense fortified outpost compound", "outpost_cluster"],
    ["island hopping across a tropical archipelago", "archipelago_hop"],
  ];
  for (const [prompt, want] of cases) {
    const r = recipeFromPrompt(prompt, { seed: 3 });
    assert.equal(r.layout, want, prompt);
    assert.ok(validateRecipe(r).ok, prompt);
  }
});

// ------------------------------------------------------------ matrix

test("presetMatrix: one row for every table entry, with the documented columns", () => {
  const rows = presetMatrix();
  const T = tables();
  const need = { theme: T.themes, template: T.templates, layout: T.layouts, lighting: T.lighting, npc_archetype: T.archetypes, material_style: T.material_styles };
  for (const [kind, table] of Object.entries(need)) {
    const ids = rows.filter((r) => r.kind === kind).map((r) => r.id).sort();
    assert.deepEqual(ids, Object.keys(table).sort(), kind);
  }
  assert.deepEqual(rows.filter((r) => r.kind === "difficulty").map((r) => r.id), [...DIFFICULTY_LEVELS]);
  for (const r of rows) assert.deepEqual(Object.keys(r), [...PRESET_MATRIX_COLUMNS]);
  const csv = matrixCsv(rows);
  assert.equal(csv.trim().split("\n").length, rows.length + 1);
  assert.ok(csv.startsWith(PRESET_MATRIX_COLUMNS.join(",")));
});

test("compatibility: hard errors fail, soft mismatches warn", () => {
  const ok = compatibility({ seed: 1, theme: theme0, template: template0, layout: "classic" });
  assert.equal(ok.ok, true);
  const bad = compatibility({ seed: 1, theme: "nope", template: template0, layout: "classic" });
  assert.equal(bad.ok, false);
  assert.ok(bad.reasons.some((s) => s.startsWith("theme")));
  const nonIsland = Object.values(THEMES).find((t) => t.biome !== "island");
  const soft = compatibility({ seed: 1, theme: nonIsland.id, template: template0, layout: "archipelago_hop" });
  assert.equal(soft.ok, true);
  assert.ok(soft.warnings.some((s) => s.includes("archipelago_hop")));
});

// ------------------------------------------------------------ catalogue

test("sample catalogue: >= 12 valid recipes covering every table", () => {
  assert.ok(SAMPLE_RECIPES.length >= 12);
  const s = sampleRecipes();
  assert.ok(s.length >= 10);
  assert.equal(new Set(s.map((x) => x.id)).size, s.length);
  for (const x of s) {
    assert.ok(x.valid, `${x.id}: ${x.notes.join("; ")}`);
    assert.ok(validateRecipe(x.recipe).ok);
    assert.ok(x.title && x.recipe.title);
    assert.equal(compatibility(x.recipe).ok, true);
  }
  const cov = catalogueCoverage(s);
  assert.deepEqual(cov.templates.missing, [], "every template");
  assert.deepEqual(cov.layouts.missing, [], "every layout");
  assert.deepEqual(cov.difficulties.missing, [], "every difficulty");
  assert.ok(cov.lighting.used.length >= Math.min(5, Object.keys(LIGHTING).length), "several lightings");
  assert.ok(cov.themes.used.length >= Math.min(12, Object.keys(THEMES).length), "most themes");
});
