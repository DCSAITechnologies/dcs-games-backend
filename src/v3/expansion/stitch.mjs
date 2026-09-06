// Section 9.2 — World stitching.
//
// Join two generated worlds into one, preserving navigation and version history.
//
// A stitch is expressed as an ordinary WorldDelta, so it goes through exactly the
// same machinery as any other change: the compatibility check, the preservation
// verifier and the B4 playtest gate all apply. Nothing about stitching gets a
// private path around the safety rails.
//
// The rules that keep it honest:
//   - every guest id is NAMESPACED, so nothing in the host is overwritten and
//     the guest's own ids stay traceable
//   - every reference inside the guest is remapped; a reference that cannot be
//     remapped is DROPPED rather than left dangling
//   - the guest's terrain is COPIED into the joined world, not regenerated, so
//     its ground is the ground its creator made
//   - navigation is linked and the seam is levelled, so the two halves are
//     genuinely walkable between — the playtest gate would catch it if not
//   - both version histories are preserved: the host's own history is untouched
//     and the guest's lineage is recorded as a nested fact, never claimed as the
//     host creator's work
//   - permission reuses the fork policy: you may stitch your own world freely,
//     and someone else's only if it is published and permits remixing
import crypto from "node:crypto";
import { newDelta, COLLECTIONS } from "./delta.mjs";
import { forkPolicyOf } from "./fork.mjs";
import { Errors } from "../../core/errors.mjs";

/** Where the guest region is placed relative to the host. */
export const SEAM_SIDES = ["east", "south"];
const DEFAULT_GAP = 24;              // metres of joining ground between the two

const num = (v, d = 0) => (typeof v === "number" && isFinite(v) ? v : d);

/**
 * Namespace prefix for a guest world. Derived from its id so the same guest
 * stitched twice into different hosts is labelled consistently, and two
 * different guests can never collide.
 */
export function nsFor(guestWorldId, existingPrefixes = []) {
  const base = "g" + crypto.createHash("sha256").update(String(guestWorldId)).digest("hex").slice(0, 6) + "_";
  if (!existingPrefixes.includes(base)) return base;
  // Extremely unlikely, but a collision must not silently merge two guests.
  for (let i = 2; i < 100; i++) {
    const alt = base.slice(0, -1) + i + "_";
    if (!existingPrefixes.includes(alt)) return alt;
  }
  throw Errors.conflict("could not allocate a unique namespace for this guest world");
}

/** Check whether a stitch is permitted, without mutating anything. */
export function checkStitchPermission(host, guest, stitcherId) {
  const problems = [];
  if (!stitcherId) problems.push({ code: "unauthenticated", detail: "stitching requires an authenticated principal" });
  if (host.world_id === guest.world_id) problems.push({ code: "same_world", detail: "a world cannot be stitched to itself" });
  if (host.owner_id && host.owner_id !== stitcherId) {
    problems.push({ code: "not_host_owner", detail: "you can only stitch into a world you own" });
  }
  if (guest.owner_id !== stitcherId) {
    // Someone else's world: the same bar as a fork.
    if (guest.state !== "published") {
      problems.push({ code: "guest_not_published", detail: "another creator's world can only be stitched in once it is published" });
    }
    const policy = forkPolicyOf(guest.manifest);
    if (policy === "deny") {
      problems.push({ code: "guest_forbids_remix", detail: "that world's creator has not permitted remixing" });
    }
  }
  const hv = String(host.manifest?.manifest_version || "");
  const gv = String(guest.manifest?.manifest_version || "");
  if (!hv.startsWith("3.") || !gv.startsWith("3.")) {
    problems.push({ code: "incompatible_manifest", detail: `both worlds must be WorldManifestV3 (host ${hv || "unknown"}, guest ${gv || "unknown"})` });
  }
  return { ok: problems.length === 0, problems };
}

/** The bounding box a manifest's content actually occupies. */
function extentOf(m) {
  const size = m.terrain?.size || { w: 256, h: 256 };
  let maxX = size.w, maxZ = size.h;
  for (const z of m.zones || []) {
    if (Array.isArray(z.bounds)) { maxX = Math.max(maxX, z.bounds[2]); maxZ = Math.max(maxZ, z.bounds[3]); }
  }
  return { w: Math.ceil(maxX), h: Math.ceil(maxZ) };
}

/**
 * Build the stitch delta.
 *
 * @param {object} host   { world_id, owner_id, state, version, manifest }
 * @param {object} guest  { world_id, owner_id, state, version, manifest }
 * @param {{stitcherId:string, side?:string, gap?:number, label?:string}} opts
 * @returns {{delta:object, stitch:object}}
 */
export function planStitch(host, guest, { stitcherId, side = "east", gap = DEFAULT_GAP, label = null } = {}) {
  const perm = checkStitchPermission(host, guest, stitcherId);
  if (!perm.ok) {
    const first = perm.problems[0];
    const meta = { problems: perm.problems };
    if (first.code === "unauthenticated") throw Errors.unauthenticated(first.detail, { meta });
    if (first.code === "incompatible_manifest" || first.code === "same_world") throw Errors.validation(first.detail, { meta });
    throw Errors.forbidden(first.detail, { meta });
  }
  return buildStitch(host, guest, { stitcherId, side, gap, label });
}

function buildStitch(host, guest, { stitcherId, side, gap, label }) {
  if (!SEAM_SIDES.includes(side)) throw Errors.validation(`side must be one of: ${SEAM_SIDES.join(", ")}`);
  const H = host.manifest, G = guest.manifest;

  const hostExtent = extentOf(H);
  const guestExtent = extentOf(G);
  const offset = side === "east"
    ? { x: hostExtent.w + gap, z: 0 }
    : { x: 0, z: hostExtent.h + gap };

  const existingPrefixes = (H.expansion?.stitched_from || []).map((s) => s.namespace);
  const ns = nsFor(guest.world_id, existingPrefixes);

  // ---- id map: every guest entity gets a namespaced id --------------------
  const idMap = new Map();
  for (const c of COLLECTIONS) for (const e of G[c] || []) if (e?.id) idMap.set(e.id, ns + e.id);
  const map = (id) => (id == null ? null : (idMap.get(id) ?? null));

  const shift = (p) => (p ? { x: num(p.x) + offset.x, y: num(p.y), z: num(p.z) + offset.z } : p);

  const delta = newDelta({
    label: label || `Stitched in "${G.meta?.title || guest.world_id}"`,
    author: stitcherId,
    reason: `world stitch: ${guest.world_id} -> ${host.world_id}`,
  });

  // ---- assets (no positions, just ids) ------------------------------------
  for (const a of G.assets || []) {
    delta.add.assets.push({ ...structuredClone(a), id: map(a.id) });
  }

  // ---- zones --------------------------------------------------------------
  for (const z of G.zones || []) {
    const b = Array.isArray(z.bounds) ? z.bounds : [0, 0, 10, 10];
    delta.add.zones.push({
      ...structuredClone(z),
      id: map(z.id),
      bounds: [num(b[0]) + offset.x, num(b[1]) + offset.z, num(b[2]) + offset.x, num(b[3]) + offset.z],
      parent_zone: map(z.parent_zone),
      // Where this zone came from, kept on the zone itself.
      origin: { world_id: guest.world_id, original_zone_id: z.id, creator: guest.owner_id },
    });
  }

  // ---- structures ---------------------------------------------------------
  for (const s of G.structures || []) {
    const asset = map(s.asset_ref);
    if (!asset) continue;                 // an unmappable asset means no model; drop rather than dangle
    delta.add.structures.push({
      ...structuredClone(s),
      id: map(s.id),
      zone: map(s.zone),
      asset_ref: asset,
      transform: { ...structuredClone(s.transform || {}), position: shift(s.transform?.position) },
      // A stitch never carries player ownership across worlds.
      owner_id: null,
    });
  }

  // ---- npcs ---------------------------------------------------------------
  for (const n of G.npcs || []) {
    const asset = map(n.asset_ref);
    if (!asset) continue;
    delta.add.npcs.push({
      ...structuredClone(n),
      id: map(n.id),
      zone: map(n.zone),
      asset_ref: asset,
      behavior_ref: map(n.behavior_ref),
      spawn: shift(n.spawn),
    });
  }

  // ---- items --------------------------------------------------------------
  for (const it of G.items || []) {
    const asset = map(it.asset_ref);
    if (!asset) continue;
    delta.add.items.push({ ...structuredClone(it), id: map(it.id), asset_ref: asset });
  }

  // ---- behaviours: remap every id INSIDE the spec too ---------------------
  for (const b of G.behaviors || []) {
    delta.add.behaviors.push({ ...structuredClone(b), id: map(b.id), spec: remapSpec(b.spec, b.kind, map, offset) });
  }

  // ---- interactions -------------------------------------------------------
  for (const x of G.interactions || []) {
    const target = map(x.target_ref);
    const behavior = map(x.behavior_ref);
    // Drop rather than repair: a half-mapped interaction is a defect the B4
    // critic should never have to see, because it should not exist.
    if (!target || !behavior) continue;
    delta.add.interactions.push({ ...structuredClone(x), id: map(x.id), target_ref: target, behavior_ref: behavior });
  }

  // ---- quests -------------------------------------------------------------
  for (const q of G.quests || []) {
    const steps = (q.steps || [])
      .map((st) => ({ ...structuredClone(st), id: map(q.id) ? `${ns}${q.id}_${st.id}` : st.id, target: map(st.target) }))
      .filter((st) => st.target);         // a step whose target did not survive is not a step
    if (!steps.length) continue;          // and a quest with no steps is not a quest
    delta.add.quests.push({
      ...structuredClone(q),
      id: map(q.id),
      giver_npc: map(q.giver_npc),
      zone: map(q.zone),
      steps,
      prerequisites: (q.prerequisites || []).map(map).filter(Boolean),
    });
  }

  // ---- terrain: grow, then COPY the guest's own ground into place ---------
  const joinedSize = {
    w: Math.max(hostExtent.w, offset.x + guestExtent.w),
    h: Math.max(hostExtent.h, offset.z + guestExtent.h),
  };
  delta.terrain_extend = joinedSize;
  const patch = guestTerrainPatch(H, G, offset);
  if (patch) delta.terrain_patch = patch;

  // ---- navigation ---------------------------------------------------------
  //
  // The guest's OWN navigation graph must travel with it. Carrying only the seam
  // link leaves every guest zone except the one at the seam orphaned in the
  // graph: the playtest agent then reports them unreachable, which is exactly
  // what it should do, because they would be.
  const guestLinks = [];
  for (const l of G.navigation?.links || []) {
    const from = map(l.from), to = map(l.to);
    if (!from || !to) continue;            // a link whose ends did not survive is not a link
    guestLinks.push({ ...structuredClone(l), from, to, from_stitched_world: guest.world_id });
  }

  const seam = chooseSeam(H, G, offset, side, map);
  delta.navigation_links = [
    ...guestLinks,
    ...seam.links.map((l) => ({ ...l, kind: "stitch_seam", added_by: "stitch" })),
  ];

  // The guest's measured walkability travels too, so navigation validation has
  // something real to say about the stitched half rather than assuming it.
  delta.navigation_walkable = (G.navigation?.walkable_zones || [])
    .map((w) => ({ ...structuredClone(w), zone: map(w.zone) }))
    .filter((w) => w.zone);

  // ---- the record of what was joined --------------------------------------
  const stitch = {
    namespace: ns,
    guest_world_id: guest.world_id,
    guest_creator: guest.owner_id,
    guest_title: G.meta?.title ?? null,
    guest_version: guest.version ?? G.world_version ?? 1,
    guest_manifest_hash: crypto.createHash("sha256").update(JSON.stringify(G)).digest("hex"),
    // The guest's OWN history, preserved as a nested fact. The host creator did
    // not do this work and must not appear to have done it.
    guest_expansion_history: structuredClone(G.expansion?.history || []),
    guest_provenance: structuredClone(G.provenance?.generated_by || []),
    offset,
    side,
    gap,
    seam,
    navigation_links_carried: guestLinks.length,
    stitched_by: stitcherId,
    stitched_at: new Date().toISOString(),
    attribution_required: guest.owner_id !== stitcherId,
    counts: Object.fromEntries(COLLECTIONS.map((c) => [c, delta.add[c].length]).filter(([, n]) => n > 0)),
    dropped: {
      structures: (G.structures || []).length - delta.add.structures.length,
      npcs: (G.npcs || []).length - delta.add.npcs.length,
      interactions: (G.interactions || []).length - delta.add.interactions.length,
      quests: (G.quests || []).length - delta.add.quests.length,
    },
  };
  delta.stitch = stitch;

  return { delta, stitch };
}

/**
 * Remap ids that live INSIDE a behaviour spec.
 *
 * Missing this is how a stitched world ends up with a pickup that grants an item
 * belonging to the other half, or a teleporter that sends the player to a zone
 * that no longer exists under that name.
 */
function remapSpec(spec, kind, map, offset) {
  if (!spec || typeof spec !== "object") return spec;
  const out = structuredClone(spec);
  const shiftXZ = (p) => (p && typeof p === "object" ? { ...p, x: num(p.x) + offset.x, z: num(p.z) + offset.z } : p);

  if (out.item) out.item = map(out.item) ?? out.item;
  if (out.locked_by) out.locked_by = map(out.locked_by) ?? null;
  if (Array.isArray(out.contains)) out.contains = out.contains.map((i) => map(i)).filter(Boolean);
  if (Array.isArray(out.toggles)) out.toggles = out.toggles.map((i) => map(i)).filter(Boolean);
  if (Array.isArray(out.unlocks)) out.unlocks = out.unlocks.map((i) => map(i)).filter(Boolean);
  if (Array.isArray(out.call_from)) out.call_from = out.call_from.map((i) => map(i)).filter(Boolean);
  if (out.to_zone) out.to_zone = map(out.to_zone) ?? null;
  if (out.to_position) out.to_position = shiftXZ(out.to_position);
  if (Array.isArray(out.patrol)) out.patrol = out.patrol.map(shiftXZ);
  if (Array.isArray(out.waypoints)) out.waypoints = out.waypoints.map(shiftXZ);
  if (Array.isArray(out.path)) out.path = out.path.map(shiftXZ);
  void kind;
  return out;
}

/**
 * Copy the guest's heightmap into the joined world's cell space.
 *
 * The two worlds may have different cell sizes, so the guest is resampled onto
 * the host's grid rather than assumed to line up. Copying, not regenerating, is
 * the point: the guest's ground is the ground its creator made.
 */
function guestTerrainPatch(H, G, offset) {
  if (H.terrain?.kind !== "heightmap" || G.terrain?.kind !== "heightmap") return null;
  const gData = G.terrain.data;
  if (!Array.isArray(gData) || !gData.length) return null;

  const hcw = H.terrain.resolution?.cell_w || 1;
  const hch = H.terrain.resolution?.cell_h || 1;
  const gcw = G.terrain.resolution?.cell_w || (G.terrain.size.w / gData[0].length);
  const gch = G.terrain.resolution?.cell_h || (G.terrain.size.h / gData.length);

  const cols = Math.ceil(G.terrain.size.w / hcw);
  const rows = Math.ceil(G.terrain.size.h / hch);
  const data = [];
  for (let j = 0; j < rows; j++) {
    const worldZ = j * hch;
    const gj = Math.max(0, Math.min(gData.length - 1, Math.round(worldZ / gch)));
    const row = new Array(cols);
    for (let i = 0; i < cols; i++) {
      const worldX = i * hcw;
      const gi = Math.max(0, Math.min(gData[gj].length - 1, Math.round(worldX / gcw)));
      row[i] = gData[gj][gi];
    }
    data.push(row);
  }
  return { region: [offset.x, offset.z, offset.x + G.terrain.size.w, offset.z + G.terrain.size.h], data, source: "guest_terrain" };
}

/**
 * Choose where the two worlds meet, and link the zones on either side.
 *
 * The seam is picked between the closest pair of zones across the boundary, so
 * the join is short and the walk between halves is plausible.
 */
function chooseSeam(H, G, offset, side, map) {
  const centre = (b) => ({ x: (b[0] + b[2]) / 2, z: (b[1] + b[3]) / 2 });
  const hostZones = (H.zones || []).filter((z) => Array.isArray(z.bounds));
  const guestZones = (G.zones || []).filter((z) => Array.isArray(z.bounds));
  if (!hostZones.length || !guestZones.length) return { links: [], note: "one side has no zones to link" };

  let best = null;
  for (const hz of hostZones) {
    const hc = centre(hz.bounds);
    for (const gz of guestZones) {
      const gcRaw = centre(gz.bounds);
      const gc = { x: gcRaw.x + offset.x, z: gcRaw.z + offset.z };
      const d = Math.hypot(hc.x - gc.x, hc.z - gc.z);
      if (!best || d < best.distance) best = { host_zone: hz.id, guest_zone: gz.id, distance: Number(d.toFixed(1)), host_centre: hc, guest_centre: gc };
    }
  }
  const guestZoneNs = map(best.guest_zone);
  return {
    side,
    host_zone: best.host_zone,
    guest_zone: guestZoneNs,
    guest_zone_original: best.guest_zone,
    distance: best.distance,
    // The link must reference the NAMESPACED guest zone, because that is the id
    // the joined world will actually contain.
    links: guestZoneNs ? [{ from: best.host_zone, to: guestZoneNs, cost: best.distance }] : [],
    note: guestZoneNs ? null : "the closest guest zone could not be mapped, so no seam link was created",
  };
}

/**
 * Record the stitch on the joined manifest.
 *
 * Called after applyDelta, because only then does the host's own history entry
 * exist to sit alongside.
 */
export function recordStitch(manifest, stitch) {
  const m = manifest;
  m.expansion = m.expansion || { history: [], compatibility: { min_runtime: "3.0.0", migrated_from: null } };
  m.expansion.stitched_from = [...(m.expansion.stitched_from || []), stitch];

  m.provenance = m.provenance || { generated_by: [] };
  m.provenance.generated_by = [
    ...(m.provenance.generated_by || []),
    {
      lane: "stitch",
      provider: "dcs-games",
      model: null,
      status: "AVAILABLE",
      at: stitch.stitched_at,
      note: `stitched in ${stitch.guest_world_id} (v${stitch.guest_version}) by ${stitch.stitched_by}`,
    },
    // The guest's own generation lineage travels with its content, so a viewer
    // can see which providers actually made that half of the world.
    ...(stitch.guest_provenance || []).map((p) => ({ ...p, from_stitched_world: stitch.guest_world_id })),
  ];

  if (stitch.attribution_required) {
    m.meta.stitched_attribution = [
      ...(m.meta.stitched_attribution || []),
      { world_id: stitch.guest_world_id, creator: stitch.guest_creator, title: stitch.guest_title, version: stitch.guest_version },
    ];
  }
  return m;
}

/** What a joined world is made of. Reads only what is recorded. */
export function stitchSummary(manifest) {
  const parts = manifest?.expansion?.stitched_from || [];
  return {
    is_stitched: parts.length > 0,
    part_count: parts.length + (parts.length ? 1 : 0),   // the host counts as a part once anything joined it
    parts: parts.map((p) => ({
      world_id: p.guest_world_id,
      title: p.guest_title,
      creator: p.guest_creator,
      version: p.guest_version,
      namespace: p.namespace,
      attribution_required: !!p.attribution_required,
      stitched_at: p.stitched_at,
      contributed: p.counts,
      dropped: p.dropped,
    })),
  };
}
