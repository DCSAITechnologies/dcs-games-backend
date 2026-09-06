// B6 — rolling a world back without rewriting its history.
//
// "Undo" is the obvious way to build this and it is the wrong one. A world that
// people are playing has a chronology: players have visited zones, finished
// quests, been given things, met NPCs, and a companion remembers all of it. If a
// rollback deleted v3 and pretended v2 was still the present, every one of those
// records would point at a version of the world that officially never happened.
//
// So a rollback here is not a deletion. It re-saves the EARLIER CONTENT as a NEW
// version: v1 -> v2 -> v3, roll back to v1, and the world is at v4 whose content
// is v1's. The version counter only ever moves forward, and the expansion
// history gains a "rollback" entry alongside the expansions it undoes, so the
// record reads as what actually happened rather than as a tidied-up version of
// it.
//
// The second rule is that a rollback must not cost a player anything. Content is
// the creator's to revert; player state is not. If rolling back would delete an
// entity that live state references — an owned structure, an inventory item, a
// completed quest, a visited zone, a known NPC — the rollback is REFUSED and
// says exactly which entities stand in the way. It does not quietly keep them
// (that would produce a version that matches neither v1 nor v3 and that nobody
// asked for), and it does not quietly drop them.
import crypto from "node:crypto";
import { COLLECTIONS, deltaHash, emptyLiveState, verifyPreservation } from "./delta.mjs";
import { diffManifests } from "./diff.mjs";
import { Errors } from "../../core/errors.mjs";

/** How live state can hold on to an entity, and how to say so to a creator. */
const HOLDS = [
  ["owned_entity_ids", "owned by a player"],
  ["inventory_item_ids", "in a player's inventory"],
  ["completed_quest_ids", "part of a completed quest"],
  ["visited_zone_ids", "somewhere a player has been"],
  ["known_npc_ids", "someone a player has met"],
  ["companion_memory_refs", "remembered by a companion"],
];

function idsOf(manifest) {
  const ids = new Map();
  for (const c of COLLECTIONS) for (const x of manifest?.[c] || []) if (x?.id) ids.set(x.id, c);
  return ids;
}

/**
 * Everything the rollback would delete that somebody is still holding.
 *
 * Ownership is read from BOTH the live state handed in and the manifest's own
 * owner_id fields: a caller that forgets to pass live state must not thereby
 * acquire permission to demolish a player's house.
 */
function heldEntitiesLost(current, target, liveState) {
  const targetIds = idsOf(target);
  const currentIds = idsOf(current);
  const held = new Map();

  const hold = (id, why) => {
    if (!currentIds.has(id) || targetIds.has(id)) return;
    const row = held.get(id) || { id, collection: currentIds.get(id), held_as: [] };
    if (!row.held_as.includes(why)) row.held_as.push(why);
    held.set(id, row);
  };

  for (const [key, why] of HOLDS) for (const id of liveState?.[key] || []) hold(id, why);
  for (const s of current.structures || []) if (s.owner_id) hold(s.id, `owned by ${s.owner_id}`);

  return [...held.values()];
}

/**
 * Roll a world back to an earlier version.
 *
 * @param {object} currentManifest the world as it stands now
 * @param {object} targetManifest  the earlier version's manifest, as it was saved
 * @param {{actorId:string, toVersion?:number, liveState?:object, label?:string, reason?:string}} opts
 * @returns {{manifest:object, record:object}} the new version, and the history entry it gained
 */
export function planRollback(currentManifest, targetManifest, { actorId, toVersion = null, liveState = emptyLiveState(), label = null, reason = null } = {}) {
  if (!actorId) throw Errors.unauthenticated("a rollback must be attributed to a principal");
  if (!currentManifest || typeof currentManifest !== "object") throw Errors.validation("a rollback needs the current manifest");
  if (!targetManifest || typeof targetManifest !== "object") throw Errors.validation("a rollback needs the manifest of the version to roll back to");

  const current = currentManifest;
  const target = targetManifest;
  const fromVersion = Number(current.world_version);
  const toV = Number(target.world_version);

  if (!Number.isInteger(fromVersion) || fromVersion < 1) throw Errors.validation("the current manifest has no usable world_version");
  if (!Number.isInteger(toV) || toV < 1) throw Errors.validation("the target manifest has no usable world_version");
  if (current.world_id !== target.world_id) {
    throw Errors.validation(`a rollback stays inside one world: '${target.world_id}' is not '${current.world_id}'`);
  }
  // toVersion is an assertion about what the caller believes it fetched. If it
  // disagrees with the manifest, the caller has the wrong snapshot and rolling
  // back to it would silently restore the wrong world.
  if (toVersion !== null && Number(toVersion) !== toV) {
    throw Errors.validation(`the manifest supplied is v${toV}, not the v${toVersion} that was asked for`);
  }
  if (toV >= fromVersion) {
    throw Errors.validation(`v${toV} is not earlier than the current v${fromVersion}; a rollback only goes backwards`);
  }

  // The target must genuinely be an earlier state of THIS world. Because history
  // is append-only, an ancestor's history is a prefix of the current one; if it
  // is not, the two manifests come from diverged lineages and restoring one over
  // the other would fabricate a past.
  const historyNow = current.expansion?.history || [];
  const historyThen = target.expansion?.history || [];
  if (historyThen.length > historyNow.length) {
    throw Errors.conflict(`v${toV} is not an earlier state of this world: it records more history than v${fromVersion} does`);
  }
  for (let i = 0; i < historyThen.length; i++) {
    if (JSON.stringify(historyThen[i]) !== JSON.stringify(historyNow[i])) {
      throw Errors.conflict(
        `v${toV} is not an earlier state of this world: its chronology diverges at history entry ${i}`,
        { meta: { entry: i, then: historyThen[i], now: historyNow[i] } }
      );
    }
  }

  // ---- would this cost a player anything? --------------------------------
  const lost = heldEntitiesLost(current, target, liveState);
  if (lost.length) {
    throw Errors.conflict(
      `rollback to v${toV} refused: it would delete ${lost.map((e) => `'${e.id}' (${e.held_as.join(", ")})`).join(", ")}`,
      { meta: { to_version: toV, from_version: fromVersion, blocked_by: lost } }
    );
  }

  // ---- rebuild the earlier content as the next version -------------------
  const now = new Date().toISOString();
  const next = structuredClone(target);
  next.world_id = current.world_id;
  next.world_version = fromVersion + 1;

  next.meta = {
    ...structuredClone(target.meta || {}),
    created_at: current.meta?.created_at ?? target.meta?.created_at ?? now,
    creator_id: current.meta?.creator_id ?? target.meta?.creator_id ?? null,
    updated_at: now,
  };
  // Credit is not content. An attribution earned by a fork or a stitch describes
  // something that really happened to this world, so it survives a rollback even
  // when the content it arrived with does not.
  if (current.meta?.forked_from) next.meta.forked_from = structuredClone(current.meta.forked_from);
  if (current.meta?.stitched_attribution) next.meta.stitched_attribution = structuredClone(current.meta.stitched_attribution);

  // Ownership is a player's ledger, not the creator's content. A structure that
  // existed at the target version and has since been bought stays bought; the
  // restoration is listed in the record rather than done quietly.
  const ownerNow = new Map((current.structures || []).map((s) => [s.id, s.owner_id ?? null]));
  const ownershipPreserved = [];
  for (const s of next.structures || []) {
    if (!ownerNow.has(s.id)) continue;
    const owner = ownerNow.get(s.id);
    if ((s.owner_id ?? null) === owner) continue;
    s.owner_id = owner;
    ownershipPreserved.push({ id: s.id, owner_id: owner });
  }

  // Counted from the manifests themselves rather than from what the caller
  // expected, so the record cannot overstate what the rollback did.
  const change = diffManifests(current, next);

  const record = {
    version: next.world_version,
    from_version: fromVersion,
    to_version: toV,
    kind: "rollback",
    label: label || `rollback to v${toV}`,
    delta_id: "rollback_" + crypto.randomBytes(8).toString("hex"),
    delta_hash: deltaHash({ kind: "rollback", world_id: current.world_id, from_version: fromVersion, to_version: toV }),
    author: actorId,
    reason,
    at: now,
    added: Object.fromEntries(COLLECTIONS.map((c) => [c, change.added.by_collection[c]]).filter(([, n]) => n > 0)),
    modified: change.modified.total,
    removed: change.removed.total,
    summary: change.summary.text,
    ...(ownershipPreserved.length ? { ownership_preserved: ownershipPreserved } : {}),
  };

  const expansion = structuredClone(current.expansion || {});
  next.expansion = {
    ...expansion,
    compatibility: expansion.compatibility || { min_runtime: "3.0.0", migrated_from: null },
    history: [...historyNow.map((h) => structuredClone(h)), record],
  };

  // The chronicle of what produced this world is append-only too: the providers
  // that made the versions being rolled past still made them.
  next.provenance = structuredClone(current.provenance || { generated_by: [] });
  next.provenance.generated_by = [
    ...(next.provenance.generated_by || []),
    { lane: "rollback", provider: "dcs-games", model: null, status: "AVAILABLE", at: now, note: `rolled back to v${toV} by ${actorId}` },
  ];

  // Belt and braces: the same check an expansion has to pass. It re-proves the
  // live-state guarantee, that ownership is untouched, that the version moved
  // forward by exactly one, that no earlier history entry changed, and that the
  // result is a valid WorldManifestV3. Anything it finds is a refusal, never a
  // repair — a half-restored world is worse than none.
  const preservation = verifyPreservation(current, next, liveState);
  if (!preservation.ok) {
    throw Errors.conflict(
      `rollback to v${toV} refused: ${preservation.problems.map((p) => p.detail).join("; ")}`,
      { meta: { to_version: toV, from_version: fromVersion, problems: preservation.problems } }
    );
  }

  return { manifest: next, record };
}

/**
 * The rollbacks this world has been through. Reads only what is recorded, so it
 * cannot claim a rollback that never happened.
 */
export function rollbackHistoryOf(manifest) {
  return (manifest?.expansion?.history || [])
    .filter((h) => h?.kind === "rollback")
    .map((h) => ({
      version: h.version,
      from_version: h.from_version,
      to_version: h.to_version,
      label: h.label,
      author: h.author ?? null,
      reason: h.reason ?? null,
      at: h.at,
      added: h.added || {},
      modified: h.modified ?? 0,
      removed: h.removed ?? 0,
      summary: h.summary ?? null,
      ownership_preserved: h.ownership_preserved || [],
    }));
}

export { HOLDS };
