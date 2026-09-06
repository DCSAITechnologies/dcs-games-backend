// B6 — the version diff must be exact.
//
// A creator decides whether to keep an expansion on the strength of what the
// diff tells them. So these tests are less about the prose and more about the
// arithmetic: every count is compared against the delta that produced it, and a
// world compared with itself has to say so rather than find something to report.
import test from "node:test";
import assert from "node:assert/strict";
import { createAssemblyRouter } from "../src/v3/router/assembly.mjs";
import { newDelta, applyDelta, COLLECTIONS } from "../src/v3/expansion/delta.mjs";
import { planExpansion, planEdit } from "../src/v3/expansion/planner.mjs";
import { diffManifests } from "../src/v3/expansion/diff.mjs";

const OFFLINE = { DCS_PROVIDERS_OFFLINE: "1" };

async function world(prompt = "A small nordic port town", worldId = "w_diff") {
  const out = await createAssemblyRouter(OFFLINE).assemble({ prompt, worldId, creatorId: "u1" });
  return out.manifest;
}

const idsIn = (d) => new Set(d.entities.map((e) => e.id));

// ==================================================== nothing changed at all

test("B6 diff: an identical manifest reports plainly that nothing changed", async () => {
  const m = await world();
  const d = diffManifests(m, structuredClone(m));

  assert.equal(d.summary.changed, false);
  assert.match(d.summary.text, /Nothing changed/);
  assert.deepEqual(d.summary.lines, []);
  assert.equal(d.added.total, 0);
  assert.equal(d.removed.total, 0);
  assert.equal(d.modified.total, 0);
  assert.equal(d.environment.changed, false);
  assert.deepEqual(d.environment.fields, []);
  assert.equal(d.terrain.changed, false);
  assert.equal(d.terrain.cells_changed, 0);
  for (const c of COLLECTIONS) {
    assert.equal(d.added.by_collection[c], 0, `${c} should show no additions`);
    assert.equal(d.removed.by_collection[c], 0, `${c} should show no removals`);
    assert.equal(d.modified.by_collection[c], 0, `${c} should show no changes`);
  }
});

test("B6 diff: a version bump on its own is not a content change", async () => {
  const m = await world();
  const bumped = structuredClone(m);
  bumped.world_version = m.world_version + 1;
  bumped.meta.updated_at = new Date().toISOString();

  const d = diffManifests(m, bumped);
  assert.equal(d.summary.changed, false);
  assert.match(d.summary.text, /Nothing changed between v1 and v2/);
  assert.equal(d.summary.from_version, 1);
  assert.equal(d.summary.to_version, 2);
});

// ============================================================= an expansion

test("B6 diff: an expansion is counted exactly, collection by collection", async () => {
  const v1 = await world();
  const delta = planExpansion(v1, { request: "add a hospital district", author: "u1" });
  const v2 = applyDelta(v1, delta).manifest;

  const d = diffManifests(v1, v2);
  assert.equal(d.summary.changed, true);

  for (const c of COLLECTIONS) {
    assert.equal(d.added.by_collection[c], delta.add[c].length, `${c}: the diff must count exactly what the delta added`);
  }
  assert.equal(d.added.total, COLLECTIONS.reduce((n, c) => n + delta.add[c].length, 0));
  assert.equal(d.removed.total, 0, "an expansion removes nothing");
  assert.equal(d.modified.total, 0, "an expansion must not rewrite existing entities");
  assert.equal(d.environment.changed, false, "an expansion is not a weather change");

  // Every added entity is named, and nothing else is claimed.
  const added = idsIn(d.added);
  for (const c of COLLECTIONS) for (const x of delta.add[c]) assert.ok(added.has(x.id), `${x.id} was added but not reported`);
  assert.equal(added.size, d.added.total);

  const zone = d.added.entities.find((e) => e.collection === "zones");
  assert.equal(zone.name, delta.add.zones[0].name);
  assert.match(d.summary.text, new RegExp(zone.name));
  assert.match(d.summary.text, /Added 1 zone/);
});

test("B6 diff: four expansions in a row sum exactly", async () => {
  let m = await world();
  const v1 = structuredClone(m);
  const expected = Object.fromEntries(COLLECTIONS.map((c) => [c, 0]));

  for (const request of ["add a hospital district", "add an airport", "add a university campus", "add an island"]) {
    const delta = planExpansion(m, { request, author: "u1" });
    for (const c of COLLECTIONS) expected[c] += delta.add[c].length;
    m = applyDelta(m, delta).manifest;
  }

  const d = diffManifests(v1, m);
  for (const c of COLLECTIONS) assert.equal(d.added.by_collection[c], expected[c], `${c} count is wrong across four expansions`);
  assert.equal(d.removed.total, 0);
  assert.equal(d.modified.total, 0);
  assert.equal(d.added.by_collection.zones, 4);
  assert.match(d.summary.text, /New zones:/);
});

test("B6 diff: direction matters — the reverse diff reports the same entities as removals", async () => {
  const v1 = await world();
  const v2 = applyDelta(v1, planExpansion(v1, { request: "add a market district" })).manifest;

  const forward = diffManifests(v1, v2);
  const back = diffManifests(v2, v1);

  assert.deepEqual(back.removed.by_collection, forward.added.by_collection);
  assert.deepEqual(idsIn(back.removed), idsIn(forward.added));
  assert.equal(back.added.total, 0);
  assert.match(back.summary.text, /Removed 1 zone/);
});

// ================================================================== an edit

test("B6 diff: a weather edit is reported as an environment change and nothing else", async () => {
  const m = await world();
  // The fixture's weather depends on its prompt, so pick a genuinely different one.
  const wanted = m.environment.weather === "snow" ? "fog" : "snow";
  const r = planEdit(m, { request: `set weather to ${wanted}` });
  assert.ok(r.delta, r.error);
  const after = applyDelta(m, r.delta).manifest;

  const d = diffManifests(m, after);
  assert.equal(d.summary.changed, true);
  assert.equal(d.environment.changed, true);
  assert.deepEqual(d.environment.fields, [{ field: "weather", before: m.environment.weather, after: wanted }]);
  assert.equal(d.added.total, 0);
  assert.equal(d.removed.total, 0);
  assert.equal(d.modified.total, 0);
  assert.equal(d.terrain.changed, false);
  assert.match(d.summary.text, new RegExp(`weather changed from '${m.environment.weather}' to '${wanted}'`));
});

test("B6 diff: night mode reports the time of day, not a rebuilt world", async () => {
  const m = await world();
  const after = applyDelta(m, planEdit(m, { request: "night mode" }).delta).manifest;

  const d = diffManifests(m, after);
  assert.equal(d.environment.fields.length, 1);
  assert.equal(d.environment.fields[0].field, "time_of_day");
  assert.equal(d.environment.fields[0].before, m.environment.time_of_day);
  assert.equal(d.added.total + d.removed.total + d.modified.total, 0);
});

test("B6 diff: a modified entity is named, with the fields that changed", async () => {
  const m = await world();
  const target = m.structures[0];
  const delta = newDelta({ label: "repurpose" });
  delta.modify.push({ collection: "structures", id: target.id, changes: { purpose: "Field Hospital" } });
  const after = applyDelta(m, delta).manifest;

  const d = diffManifests(m, after);
  assert.equal(d.modified.total, 1);
  assert.equal(d.modified.by_collection.structures, 1);
  assert.equal(d.modified.entities[0].id, target.id);
  assert.deepEqual(d.modified.entities[0].fields, ["purpose"]);
  assert.equal(d.added.total, 0);
  assert.equal(d.removed.total, 0);
  assert.match(d.summary.text, /Changed 1 structure/);
  assert.match(d.summary.text, new RegExp(target.id));
});

// ============================================================== a removal

test("B6 diff: a removal names exactly what went, and counts nothing else", async () => {
  const m = await world();
  // An item no quest step depends on, so the removal is legitimate.
  const questTargets = new Set((m.quests || []).flatMap((q) => q.steps.map((s) => s.target)));
  const item = m.items.find((it) => !questTargets.has(it.id));
  assert.ok(item, "the fixture needs an item that no quest requires");
  const pickup = m.behaviors.find((b) => b.kind === "pickup" && b.spec?.item === item.id);

  const delta = newDelta({ label: "clear out" });
  delta.remove.push({ collection: "items", id: item.id, reason: "no longer stocked" });
  if (pickup) delta.remove.push({ collection: "behaviors", id: pickup.id, reason: "its item is gone" });
  const after = applyDelta(m, delta).manifest;

  const d = diffManifests(m, after);
  assert.equal(d.removed.by_collection.items, 1);
  assert.ok(idsIn(d.removed).has(item.id));
  assert.equal(d.removed.entities.find((e) => e.id === item.id).name, item.name);
  assert.equal(d.added.total, 0);
  // Removing a behaviour orphans its interaction, and applyDelta prunes those.
  // The diff must count the prune too, not just the entity that was asked for.
  const pruned = (m.interactions || []).filter((x) => !after.interactions.some((y) => y.id === x.id));
  assert.equal(d.removed.by_collection.interactions, pruned.length);
  assert.equal(d.removed.total, 1 + (pickup ? 1 : 0) + pruned.length);
  assert.match(d.summary.text, /Removed/);
});

// ================================================================= terrain

test("B6 diff: terrain growth is reported with the real figures", async () => {
  const m = await world();
  const before = { w: m.terrain.size.w, h: m.terrain.size.h };
  const delta = newDelta({ label: "more ground" });
  delta.terrain_extend = { w: before.w + 120, h: before.h };
  const after = applyDelta(m, delta).manifest;

  const d = diffManifests(m, after);
  assert.equal(d.terrain.changed, true);
  assert.equal(d.terrain.grew, true);
  assert.equal(d.terrain.shrank, false);
  assert.deepEqual(d.terrain.size_before, before);
  assert.deepEqual(d.terrain.size_after, { w: after.terrain.size.w, h: after.terrain.size.h });
  assert.deepEqual(d.terrain.size_change, { w: after.terrain.size.w - before.w, h: 0 });
  assert.ok(d.terrain.cells_after > d.terrain.cells_before, "new ground means new cells");
  assert.equal(d.terrain.cells_changed, 0, "growing the map must not rewrite an existing height cell");
  assert.match(d.summary.text, new RegExp(`grew from ${before.w}x${before.h} to ${after.terrain.size.w}x${after.terrain.size.h}`));
  assert.equal(d.added.total, 0, "ground is not an entity");
});

test("B6 diff: a re-sculpted patch is counted cell by cell, not estimated", async () => {
  const m = await world();
  const after = structuredClone(m);
  let touched = 0;
  for (let j = 0; j < 3; j++) for (let i = 0; i < 4; i++) { after.terrain.data[j][i] += 1.5; touched++; }

  const d = diffManifests(m, after);
  assert.equal(d.terrain.cells_changed, touched);
  assert.equal(d.terrain.grew, false);
  assert.deepEqual(d.terrain.size_before, d.terrain.size_after);
  assert.equal(d.terrain.changed, true);
  assert.match(d.summary.text, new RegExp(`${touched} height cells were re-sculpted`));
});

// ============================================================== honesty

test("B6 diff: key order is not a change", async () => {
  const m = await world();
  const reordered = JSON.parse(JSON.stringify(m));
  reordered.structures = reordered.structures.map((s) => Object.fromEntries(Object.entries(s).reverse()));
  const d = diffManifests(m, reordered);
  assert.equal(d.modified.total, 0, "reordering an object's keys must not be reported as a modification");
  assert.equal(d.summary.changed, false);
});

test("B6 diff: a missing manifest is refused rather than diffed against nothing", async () => {
  const m = await world();
  assert.throws(() => diffManifests(null, m), (e) => e.httpStatus === 422);
  assert.throws(() => diffManifests(m, undefined), (e) => e.httpStatus === 422);
});
