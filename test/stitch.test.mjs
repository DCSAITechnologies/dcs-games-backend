// Section 9.2 — World stitching.
//
// Joining two worlds is only useful if the result is genuinely one world: no id
// collisions, no dangling references, walkable across the seam, and with both
// lineages preserved rather than one creator's work absorbed into the other's.
import test from "node:test";
import assert from "node:assert/strict";
import { createAssemblyRouter } from "../src/v3/router/assembly.mjs";
import { planStitch, checkStitchPermission, recordStitch, stitchSummary, nsFor, SEAM_SIDES } from "../src/v3/expansion/stitch.mjs";
import { applyDelta, verifyPreservation, emptyLiveState } from "../src/v3/expansion/delta.mjs";
import { planExpansion } from "../src/v3/expansion/planner.mjs";
import { playtestAndRepair, simulatePlaythrough } from "../src/v3/playtest/agent.mjs";
import { validateManifest } from "../src/v3/manifest/schema.mjs";

const OFFLINE = { DCS_PROVIDERS_OFFLINE: "1" };

async function world(prompt, worldId, ownerId, extra = {}) {
  const out = await createAssemblyRouter(OFFLINE).assemble({ prompt, worldId, creatorId: ownerId });
  return { world_id: worldId, owner_id: ownerId, state: "published", version: 1, manifest: out.manifest, ...extra };
}

const pair = async () => ({
  host: await world("A rainy nordic port town", "w_host", "creator-a"),
  guest: await world("A neon city block after the power failed", "w_guest", "creator-a"),
});

function stitched(host, guest, opts = {}) {
  const { delta, stitch } = planStitch(host, guest, { stitcherId: opts.stitcherId ?? "creator-a", ...opts });
  const applied = applyDelta(host.manifest, delta, opts.live ?? emptyLiveState());
  recordStitch(applied.manifest, stitch);
  return { manifest: applied.manifest, delta, stitch, applied };
}

// ============================================================== permission

test("9.2: a world cannot be stitched to itself", async () => {
  const { host } = await pair();
  assert.throws(() => planStitch(host, host, { stitcherId: "creator-a" }), (e) => e.httpStatus === 422 && /itself/.test(e.detail));
});

test("9.2 GATE: you may only stitch INTO a world you own", async () => {
  const { host, guest } = await pair();
  assert.throws(
    () => planStitch(host, guest, { stitcherId: "someone-else" }),
    (e) => e.httpStatus === 403 && /only stitch into a world you own/.test(e.detail)
  );
});

test("9.2 GATE: another creator's DRAFT cannot be stitched in", async () => {
  const host = await world("A port town", "w_host", "creator-a");
  const guest = await world("A neon city", "w_guest", "creator-b", { state: "draft" });
  const r = checkStitchPermission(host, guest, "creator-a");
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => p.code === "guest_not_published"));
  assert.throws(() => planStitch(host, guest, { stitcherId: "creator-a" }), (e) => e.httpStatus === 403);
});

test("9.2 GATE: a 'deny' fork policy blocks stitching too", async () => {
  const host = await world("A port town", "w_host", "creator-a");
  const guest = await world("A neon city", "w_guest", "creator-b");
  guest.manifest.meta.fork_policy = "deny";
  assert.throws(() => planStitch(host, guest, { stitcherId: "creator-a" }), (e) => e.httpStatus === 403 && /permitted remixing/.test(e.detail));
});

test("9.2: another creator's PUBLISHED, remixable world may be stitched in", async () => {
  const host = await world("A port town", "w_host", "creator-a");
  const guest = await world("A neon city", "w_guest", "creator-b");
  const r = checkStitchPermission(host, guest, "creator-a");
  assert.equal(r.ok, true, JSON.stringify(r.problems));
  const s = stitched(host, guest, { stitcherId: "creator-a" });
  assert.equal(s.stitch.attribution_required, true, "someone else's work must be attributed");
});

test("9.2: stitching requires an authenticated principal and a v3 manifest on both sides", async () => {
  const { host, guest } = await pair();
  assert.throws(() => planStitch(host, guest, { stitcherId: null }), (e) => e.httpStatus === 401);
  const legacy = { ...guest, manifest: { ...guest.manifest, manifest_version: "1.0" } };
  assert.throws(() => planStitch(host, legacy, { stitcherId: "creator-a" }), (e) => e.httpStatus === 422 && /WorldManifestV3/.test(e.detail));
});

test("9.2: an unknown seam side is refused", async () => {
  const { host, guest } = await pair();
  assert.throws(() => planStitch(host, guest, { stitcherId: "creator-a", side: "up" }), (e) => e.httpStatus === 422);
  assert.deepEqual(SEAM_SIDES, ["east", "south"]);
});

// ========================================================== id namespacing

test("9.2 GATE: no guest id can collide with or overwrite a host id", async () => {
  const { host, guest } = await pair();
  // Force the worst case: make the guest's ids identical to the host's.
  guest.manifest.zones[0].id = host.manifest.zones[0].id;
  guest.manifest.npcs[0].id = host.manifest.npcs[0].id;

  const { manifest } = stitched(host, guest);
  const zoneIds = manifest.zones.map((z) => z.id);
  const npcIds = manifest.npcs.map((n) => n.id);
  assert.equal(new Set(zoneIds).size, zoneIds.length, "duplicate zone ids after stitching");
  assert.equal(new Set(npcIds).size, npcIds.length, "duplicate npc ids after stitching");
  // The host's originals are untouched.
  assert.ok(zoneIds.includes(host.manifest.zones[0].id));
});

test("9.2: the namespace is derived from the guest id, so it is stable and unique", () => {
  const a = nsFor("w_guest");
  assert.equal(a, nsFor("w_guest"), "the same guest always gets the same namespace");
  assert.notEqual(a, nsFor("w_other"));
  assert.match(a, /^g[0-9a-f]{6}_$/);
  const alt = nsFor("w_guest", [a]);
  assert.notEqual(alt, a, "a collision must allocate a different namespace, never reuse one");
});

// ====================================================== reference integrity

test("9.2 GATE: the joined world has NO dangling references", async () => {
  const { host, guest } = await pair();
  const { manifest } = stitched(host, guest);
  const v = validateManifest(manifest);
  assert.equal(v.ok, true, JSON.stringify(v.errors, null, 2));
});

test("9.2 GATE: ids INSIDE behaviour specs are remapped, not left pointing at the other world", async () => {
  const { host, guest } = await pair();
  const { manifest, stitch } = stitched(host, guest);

  const guestItemIds = new Set(guest.manifest.items.map((i) => i.id));
  const joinedIds = new Set([
    ...manifest.zones.map((z) => z.id), ...manifest.structures.map((s) => s.id),
    ...manifest.npcs.map((n) => n.id), ...manifest.items.map((i) => i.id),
  ]);

  for (const b of manifest.behaviors) {
    if (!b.id.startsWith(stitch.namespace)) continue;   // only the stitched half
    if (b.spec?.item) {
      assert.ok(joinedIds.has(b.spec.item), `pickup grants '${b.spec.item}', which does not exist in the joined world`);
      assert.ok(!guestItemIds.has(b.spec.item), "a stitched pickup must not still reference the guest's original id");
    }
    if (b.spec?.to_zone) assert.ok(joinedIds.has(b.spec.to_zone), `teleporter targets missing zone '${b.spec.to_zone}'`);
    for (const list of ["contains", "toggles", "unlocks", "call_from"]) {
      for (const ref of b.spec?.[list] || []) assert.ok(joinedIds.has(ref), `${list} references missing '${ref}'`);
    }
  }
});

test("9.2: an interaction that cannot be fully remapped is DROPPED, never left dangling", async () => {
  const { host, guest } = await pair();
  // Break a guest interaction by pointing it at something that does not exist.
  guest.manifest.interactions[0].target_ref = "entity_that_never_existed";
  const before = guest.manifest.interactions.length;
  const { manifest, stitch } = stitched(host, guest);
  const stitchedInteractions = manifest.interactions.filter((i) => i.id.startsWith(stitch.namespace));
  assert.equal(stitchedInteractions.length, before - 1);
  assert.equal(stitch.dropped.interactions, 1, "the drop is reported, not hidden");
  assert.equal(validateManifest(manifest).ok, true);
});

test("9.2: a quest whose steps do not survive is dropped rather than shipped broken", async () => {
  const { host, guest } = await pair();
  for (const st of guest.manifest.quests[0].steps) st.target = "gone";
  const { manifest, stitch } = stitched(host, guest);
  assert.ok(!manifest.quests.some((q) => q.id === stitch.namespace + guest.manifest.quests[0].id));
  assert.ok(stitch.dropped.quests >= 1);
  assert.equal(validateManifest(manifest).ok, true);
});

// ================================================================ geometry

test("9.2 GATE: the guest is offset so the two halves do not overlap", async () => {
  const { host, guest } = await pair();
  const hostMaxX = Math.max(...host.manifest.zones.map((z) => z.bounds[2]));
  const { manifest, stitch } = stitched(host, guest);
  const stitchedZones = manifest.zones.filter((z) => z.id.startsWith(stitch.namespace));
  assert.ok(stitchedZones.length > 0);
  for (const z of stitchedZones) {
    assert.ok(z.bounds[0] >= hostMaxX, `stitched zone ${z.id} overlaps the host region`);
  }
  // And every host zone is exactly where it was.
  for (const orig of host.manifest.zones) {
    const now = manifest.zones.find((z) => z.id === orig.id);
    assert.deepEqual(now.bounds, orig.bounds, "a stitch must not move the host's own zones");
  }
});

test("9.2 GATE: the guest's OWN terrain is copied in, not regenerated", async () => {
  const { host, guest } = await pair();
  const { manifest, stitch } = stitched(host, guest);
  const t = manifest.terrain;
  const cw = t.resolution.cell_w, ch = t.resolution.cell_h;

  // Sample a few points inside the stitched region and compare with the guest's
  // own heightmap at the corresponding place.
  const gt = guest.manifest.terrain;
  const gcw = gt.resolution.cell_w, gch = gt.resolution.cell_h;
  let matched = 0, checked = 0;
  for (const [gx, gz] of [[20, 20], [60, 40], [100, 80]]) {
    if (gx >= gt.size.w || gz >= gt.size.h) continue;
    const gi = Math.round(gx / gcw), gj = Math.round(gz / gch);
    if (!gt.data[gj] || gt.data[gj][gi] === undefined) continue;
    const expected = gt.data[gj][gi];
    const i = Math.round((gx + stitch.offset.x) / cw), j = Math.round((gz + stitch.offset.z) / ch);
    if (!t.data[j] || t.data[j][i] === undefined) continue;
    checked++;
    if (Math.abs(t.data[j][i] - expected) < 0.5) matched++;
  }
  assert.ok(checked > 0, "the sampling should have found comparable points");
  assert.equal(matched, checked, "the stitched ground must be the guest's ground, not fresh filler");
});

test("9.2 GATE: every host terrain cell is untouched", async () => {
  const { host, guest } = await pair();
  const before = structuredClone(host.manifest.terrain.data);
  const { manifest } = stitched(host, guest);
  for (let j = 0; j < before.length; j++) {
    for (let i = 0; i < before[j].length; i++) {
      assert.equal(manifest.terrain.data[j][i], before[j][i], `host terrain cell (${i},${j}) was rewritten by a stitch`);
    }
  }
});

// ============================================================== navigation

test("9.2 GATE: the seam is linked, so the halves are navigably connected", async () => {
  const { host, guest } = await pair();
  const { manifest, stitch } = stitched(host, guest);
  const seamLinks = (manifest.navigation.links || []).filter((l) => l.kind === "stitch_seam");
  assert.equal(seamLinks.length, 1, "exactly one seam should join the two regions");
  const link = seamLinks[0];
  const zoneIds = new Set(manifest.zones.map((z) => z.id));
  assert.ok(zoneIds.has(link.from), "the seam's host end must be a real zone");
  assert.ok(zoneIds.has(link.to), "the seam's guest end must be a real zone");
  assert.ok(link.to.startsWith(stitch.namespace), "the seam must reference the NAMESPACED guest zone");
});

test("9.2 GATE: every zone in the joined world is reachable from the spawn", async () => {
  const { host, guest } = await pair();
  const { manifest } = stitched(host, guest);
  const gate = await playtestAndRepair(manifest);
  const findings = gate.rounds.flatMap((r) => r.findings);
  const unreachable = findings.filter((f) => f.id === "zone_unreachable" || f.id === "zone_unreachable_sim");
  assert.deepEqual(unreachable.map((f) => f.where), [], `zones unreachable after stitching: ${unreachable.map((f) => f.where).join(", ")}`);
});

test("9.2 GATE: the joined world passes the playtest gate", async () => {
  const { host, guest } = await pair();
  const { manifest } = stitched(host, guest);
  const gate = await playtestAndRepair(manifest);
  assert.equal(gate.verdict, "PASSED", JSON.stringify(gate.rounds.at(-1).findings.slice(0, 5), null, 2));
});

// ========================================================= history + credit

test("9.2 GATE: the host's own expansion history is untouched, and gains exactly one entry", async () => {
  let host = await world("A port town", "w_host", "creator-a");
  // Give the host a real history first.
  host.manifest = applyDelta(host.manifest, planExpansion(host.manifest, { request: "add a hospital district" })).manifest;
  host.version = host.manifest.world_version;
  const before = structuredClone(host.manifest.expansion.history);

  const guest = await world("A neon city", "w_guest", "creator-a");
  const { manifest } = stitched(host, guest);

  assert.equal(manifest.expansion.history.length, before.length + 1);
  for (let i = 0; i < before.length; i++) {
    assert.deepEqual(manifest.expansion.history[i], before[i], "an earlier history entry must never change");
  }
  assert.equal(manifest.world_version, host.manifest.world_version + 1);
});

test("9.2 GATE: the guest's lineage is preserved as a nested fact, not claimed as the host's work", async () => {
  const host = await world("A port town", "w_host", "creator-a");
  let guest = await world("A neon city", "w_guest", "creator-b");
  // The guest has done its own expansion work.
  guest.manifest = applyDelta(guest.manifest, planExpansion(guest.manifest, { request: "add an airport" })).manifest;
  guest.version = guest.manifest.world_version;
  const guestHistory = structuredClone(guest.manifest.expansion.history);
  assert.equal(guestHistory.length, 1);

  const { manifest, stitch } = stitched(host, guest, { stitcherId: "creator-a" });

  // The guest's history is recorded ALONGSIDE, not merged into, the host's.
  assert.deepEqual(stitch.guest_expansion_history, guestHistory);
  assert.equal(manifest.expansion.history.length, 1, "the host's history gains one entry for the stitch, not the guest's entries");
  assert.equal(manifest.expansion.stitched_from.length, 1);
  assert.equal(manifest.expansion.stitched_from[0].guest_world_id, "w_guest");
  assert.match(manifest.expansion.stitched_from[0].guest_manifest_hash, /^[0-9a-f]{64}$/);
});

test("9.2 GATE: another creator's contribution is attributed", async () => {
  const host = await world("A port town", "w_host", "creator-a");
  const guest = await world("A neon city", "w_guest", "creator-b");
  const { manifest } = stitched(host, guest, { stitcherId: "creator-a" });
  assert.deepEqual(manifest.meta.stitched_attribution, [
    { world_id: "w_guest", creator: "creator-b", title: guest.manifest.meta.title, version: 1 },
  ]);
});

test("9.2: stitching your OWN world needs no attribution", async () => {
  const { host, guest } = await pair();
  const { manifest, stitch } = stitched(host, guest);
  assert.equal(stitch.attribution_required, false);
  assert.equal(manifest.meta.stitched_attribution, undefined);
});

test("9.2: the guest's generation provenance travels with its content", async () => {
  const { host, guest } = await pair();
  const { manifest } = stitched(host, guest);
  const carried = manifest.provenance.generated_by.filter((p) => p.from_stitched_world === "w_guest");
  assert.ok(carried.length > 0, "which providers made the stitched half must remain visible");
  assert.ok(manifest.provenance.generated_by.some((p) => p.lane === "stitch"));
});

// =========================================================== preservation

test("9.2 GATE: a stitch preserves everything a player already had", async () => {
  const { host, guest } = await pair();
  const live = {
    ...emptyLiveState(),
    owned_entity_ids: [host.manifest.structures[0].id],
    inventory_item_ids: [host.manifest.items[0].id],
    completed_quest_ids: [host.manifest.quests[0].id],
    visited_zone_ids: [host.manifest.zones[0].id],
    known_npc_ids: [host.manifest.npcs[0].id],
  };
  const { manifest } = stitched(host, guest, { live });
  const pres = verifyPreservation(host.manifest, manifest, live);
  assert.equal(pres.ok, true, JSON.stringify(pres.problems));
});

test("9.2 GATE: no player ownership crosses from the guest world", async () => {
  const { host, guest } = await pair();
  guest.manifest.structures[0].owner_id = "a-player-in-the-other-world";
  const { manifest, stitch } = stitched(host, guest);
  const stitchedStructures = manifest.structures.filter((s) => s.id.startsWith(stitch.namespace));
  assert.ok(stitchedStructures.length > 0);
  assert.ok(stitchedStructures.every((s) => s.owner_id === null), "ownership must never travel between worlds");
});

// ================================================================ summary

test("9.2: the summary reads only what was recorded", async () => {
  const { host, guest } = await pair();
  assert.deepEqual(stitchSummary(host.manifest), { is_stitched: false, part_count: 0, parts: [] });
  const { manifest } = stitched(host, guest);
  const s = stitchSummary(manifest);
  assert.equal(s.is_stitched, true);
  assert.equal(s.part_count, 2);
  assert.equal(s.parts[0].world_id, "w_guest");
  assert.ok(s.parts[0].contributed.zones > 0);
});

test("9.2: three worlds can be joined, each namespaced separately", async () => {
  const host = await world("A port town", "w_host", "creator-a");
  const g1 = await world("A neon city", "w_g1", "creator-a");
  const g2 = await world("A jungle expedition camp", "w_g2", "creator-a");

  let cur = { ...host, manifest: stitched(host, g1).manifest };
  cur.version = cur.manifest.world_version;
  const final = stitched(cur, g2).manifest;

  const s = stitchSummary(final);
  assert.equal(s.parts.length, 2);
  assert.notEqual(s.parts[0].namespace, s.parts[1].namespace);
  assert.equal(validateManifest(final).ok, true, JSON.stringify(validateManifest(final).errors));

  const gate = await playtestAndRepair(final);
  assert.equal(gate.verdict, "PASSED", "a three-way join must still be playable");

  // And the whole thing is still walkable.
  const walk = simulatePlaythrough(final);
  assert.ok(walk.coverage > 0.2, `only ${(walk.coverage * 100).toFixed(0)}% of the joined world is reachable`);
});

test("9.2: a stitched world can still be expanded afterwards", async () => {
  const { host, guest } = await pair();
  const joined = stitched(host, guest).manifest;
  const expanded = applyDelta(joined, planExpansion(joined, { request: "add a market district" })).manifest;
  assert.equal(expanded.world_version, joined.world_version + 1);
  assert.equal(validateManifest(expanded).ok, true);
  // The stitch record survives the later expansion.
  assert.equal(expanded.expansion.stitched_from.length, 1);
});
