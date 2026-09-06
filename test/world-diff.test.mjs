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

// ======================================= the parts of a world that are not entities
//
// Navigation, spawn, audio, media and metadata move without any entity count
// moving. A diff that covered only the collections would report "nothing
// changed" about a world whose districts had been disconnected — which is
// exactly the change a diff exists to surface, because it is invisible on the
// map and instant for the player.

test("B6 diff: navigation links are named as they go, not just counted", async () => {
  const v1 = await world();
  const v2 = applyDelta(v1, planExpansion(v1, { request: "add a hospital district" })).manifest;

  const forward = diffManifests(v1, v2);
  const gained = v2.navigation.links.filter((l) => !v1.navigation.links.some((o) => o.from === l.from && o.to === l.to));
  assert.ok(gained.length, "the fixture's expansion must link its new district in");
  assert.equal(forward.navigation.changed, true);
  assert.equal(forward.navigation.links.added.length, gained.length);
  assert.equal(forward.navigation.links.removed.length, 0);
  assert.equal(forward.summary.navigation_links_added, gained.length);

  // And the reverse — the shape a rollback takes — reports them as losses, by name.
  const back = diffManifests(v2, v1);
  assert.equal(back.navigation.links.removed.length, gained.length);
  assert.equal(back.summary.navigation_links_removed, gained.length);
  for (const l of gained) assert.match(back.summary.text, new RegExp(`${l.from} <-> ${l.to}`));
});

test("B6 diff: a single dropped navigation link is reported, with nothing else claimed", async () => {
  const m = await world();
  assert.ok(m.navigation.links.length, "the fixture needs a linked world");
  const after = structuredClone(m);
  const [cut] = after.navigation.links.splice(0, 1);

  const d = diffManifests(m, after);
  assert.equal(d.summary.changed, true, "silently dropping a link is not 'nothing changed'");
  assert.equal(d.navigation.links.removed.length, 1);
  assert.equal(d.navigation.links.removed[0].from, cut.from);
  assert.equal(d.navigation.links.removed[0].to, cut.to);
  assert.equal(d.added.total + d.removed.total + d.modified.total, 0, "no entity moved");
  assert.equal(d.environment.changed, false);
  assert.equal(d.terrain.changed, false);
  assert.match(d.summary.text, /1 zone link removed/);
  assert.match(d.summary.text, new RegExp(`${cut.from} <-> ${cut.to}`));
});

test("B6 diff: which way round a link is written is not a change to the world", async () => {
  const m = await world();
  const after = structuredClone(m);
  after.navigation.links = after.navigation.links.map((l) => ({ ...l, from: l.to, to: l.from }));

  const d = diffManifests(m, after);
  assert.equal(d.navigation.links.added.length, 0, "a link the runtime walks both ways is the same link");
  assert.equal(d.navigation.links.removed.length, 0);
});

test("B6 diff: a zone's measured walkability is compared, not assumed", async () => {
  const m = await world();
  assert.ok(m.navigation.walkable_zones.length, "the fixture needs measured walkability");
  const after = structuredClone(m);
  const target = after.navigation.walkable_zones[0];
  target.walkable_fraction = 0.1;

  const d = diffManifests(m, after);
  assert.equal(d.navigation.changed, true);
  assert.equal(d.navigation.walkable_zones.modified.length, 1);
  assert.equal(d.navigation.walkable_zones.modified[0].key, target.zone);
  assert.deepEqual(d.navigation.walkable_zones.modified[0].fields, ["walkable_fraction"]);
  assert.match(d.summary.text, new RegExp(`walkability of '${target.zone}' changed`));
});

test("B6 diff: the navmesh is part of navigation", async () => {
  const m = await world();
  const after = structuredClone(m);
  after.navigation.navmesh_ref = "navmesh_v2";
  const d = diffManifests(m, after);
  assert.equal(d.navigation.navmesh_ref.changed, true);
  assert.equal(d.navigation.navmesh_ref.before, m.navigation.navmesh_ref ?? null);
  assert.equal(d.navigation.navmesh_ref.after, "navmesh_v2");
  assert.equal(d.summary.changed, true);
});

test("B6 diff: moving, adding or losing a spawn is reported", async () => {
  const m = await world();
  const moved = structuredClone(m);
  moved.spawn.player_spawns[0].position = { x: 99, y: 2, z: 99 };
  const d1 = diffManifests(m, moved);
  assert.equal(d1.spawn.changed, true);
  assert.equal(d1.summary.spawn_changed, true);
  assert.equal(d1.spawn.player_spawns.modified.length, 1);
  assert.deepEqual(d1.spawn.player_spawns.modified[0].fields, ["position"]);
  assert.match(d1.summary.text, new RegExp(`Spawn: '${m.spawn.player_spawns[0].id}' changed \\(position\\)`));

  const extra = structuredClone(m);
  extra.spawn.player_spawns.push({ id: "spawn_docks", position: { x: 10, y: 1, z: 10 }, zone: null });
  extra.spawn.respawn_policy = "origin";
  const d2 = diffManifests(m, extra);
  assert.equal(d2.spawn.player_spawns.added.length, 1);
  assert.equal(d2.spawn.player_spawns.added[0].id, "spawn_docks");
  assert.deepEqual(d2.spawn.fields.map((f) => f.field), ["respawn_policy"]);
  assert.match(d2.summary.text, /Spawn: 'spawn_docks' was added/);

  const back = diffManifests(extra, m);
  assert.equal(back.spawn.player_spawns.removed.length, 1);
  assert.match(back.summary.text, /Spawn: 'spawn_docks' was removed/);
});

test("B6 diff: audio is compared channel by channel", async () => {
  const m = await world();
  const after = structuredClone(m);
  after.audio.ambient = [...(after.audio.ambient || []), { id: "amb_harbour", uri: "asset://gulls", loop: true }];
  after.audio.music = [...(after.audio.music || []), { id: "music_theme", uri: "asset://theme" }];

  const d = diffManifests(m, after);
  assert.equal(d.audio.changed, true);
  assert.equal(d.summary.audio_changed, true);
  assert.equal(d.audio.channels.ambient.added.length, 1);
  assert.equal(d.audio.channels.music.added.length, 1);
  assert.equal(d.audio.channels.sfx.changed, false);
  assert.match(d.summary.text, /Audio: 1 ambient track added/);

  // And the reverse is a loss, which is what a rollback of an audio pass looks like.
  const back = diffManifests(after, m);
  assert.equal(back.audio.channels.ambient.removed.length, 1);
  assert.match(back.summary.text, /Audio: 1 ambient track removed/);
});

test("B6 diff: media refs are compared", async () => {
  const m = await world();
  const after = structuredClone(m);
  after.media.thumbnail_ref = "asset_thumbnail";
  const d = diffManifests(m, after);
  assert.equal(d.media.changed, true);
  assert.equal(d.summary.media_fields_changed, 1);
  assert.deepEqual(d.media.fields, [{ field: "thumbnail_ref", before: m.media.thumbnail_ref ?? null, after: "asset_thumbnail" }]);
  assert.match(d.summary.text, /Media: thumbnail_ref changed from nothing to 'asset_thumbnail'/);
});

test("B6 diff: a renamed or reclassified world is reported through meta", async () => {
  const m = await world();
  const after = structuredClone(m);
  after.meta.title = "Ashfall Harbour";
  after.meta.maturity = "16+";

  const d = diffManifests(m, after);
  assert.equal(d.meta.changed, true);
  assert.equal(d.summary.meta_fields_changed, 2);
  assert.deepEqual(d.meta.fields.map((f) => f.field), ["maturity", "title"]);
  assert.match(d.summary.text, /Meta: title changed from/);
});

test("B6 diff: a re-save is not a change — updated_at alone reports nothing", async () => {
  const m = await world();
  const resaved = structuredClone(m);
  resaved.meta.updated_at = new Date(Date.now() + 60000).toISOString();

  const d = diffManifests(m, resaved);
  assert.equal(d.meta.changed, false, "updated_at moves on every write and must not be reported as a change");
  assert.equal(d.summary.changed, false);
  assert.match(d.summary.text, /Nothing changed/);
});

test("B6 diff: an untouched world reports nothing changed in EVERY section", async () => {
  const m = await world();
  const d = diffManifests(m, structuredClone(m));
  for (const section of ["navigation", "spawn", "audio", "media", "meta"]) {
    assert.equal(d[section].changed, false, `${section} must report no change`);
  }
  assert.deepEqual(d.navigation.links.added, []);
  assert.deepEqual(d.navigation.links.removed, []);
  assert.deepEqual(d.spawn.player_spawns.modified, []);
  assert.deepEqual(d.media.fields, []);
  assert.deepEqual(d.meta.fields, []);
  assert.equal(d.summary.navigation_changed, false);
  assert.equal(d.summary.changed, false);
});

test("B6 diff: an expansion's new navigation is reported alongside its new entities", async () => {
  const v1 = await world();
  const delta = planExpansion(v1, { request: "add an airport" });
  const v2 = applyDelta(v1, delta).manifest;

  const d = diffManifests(v1, v2);
  assert.equal(d.added.by_collection.zones, 1);
  assert.equal(d.navigation.walkable_zones.added.length, 1, "a new district brings its own walkability figure");
  assert.equal(d.navigation.walkable_zones.added[0].zone, delta.add.zones[0].id);
  assert.equal(d.spawn.changed, false, "an expansion does not move the player's spawn");
  assert.equal(d.meta.changed, false, "nor rename the world");
});
