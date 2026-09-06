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
import { manifestHash } from "../../core/worldstore.mjs";
import { Errors } from "../../core/errors.mjs";
import { OWNABLE_COLLECTIONS } from "./fork.mjs";

/**
 * Fields on meta that express a creator's DECISION rather than the world's
 * content: who may remix it, and on what terms. A rollback restores content;
 * it must never restore a permission the creator has since changed.
 */
export const CARRIED_FORWARD_PERMISSIONS = ["fork_policy", "revenue_policy", "remix_terms", "attribution_required"];

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
  // Ownership was read from structures only, so a rollback that deleted a
  // player's ITEM or NPC went through silently — the refusal existed but looked
  // past two thirds of what a player can own.
  for (const key of OWNABLE_COLLECTIONS) {
    for (const e of current[key] || []) if (e.owner_id) hold(e.id, `owned by ${e.owner_id}`);
  }

  return [...held.values()];
}

/**
 * A manifest's chronology has to agree with the version it claims to be.
 *
 * Every manifest this system produces satisfies this: applyDelta and
 * planRollback both bump world_version and append one history entry carrying
 * that same number, and a world that has never been expanded carries an empty
 * history. So a manifest whose chronology and version disagree did not come out
 * of that path, and treating it as an ordinary input is what lets a caller
 * fabricate a lineage.
 *
 * Two attacks this closes, both of which produced a chronicle that no later
 * reader could straighten out:
 *
 *   a manifest resaved from a STALE read (world_version behind its own history)
 *   makes the rollback mint a version number the chronicle already contains, so
 *   the world's history ends ... v2, v3, v3;
 *
 *   a manifest whose world_version runs AHEAD of its history leaves a gap, so
 *   the history ends ... v2, v3, v10 and the versions in between are neither
 *   recorded nor recoverable;
 *
 * and the forged-ancestor case, where a manifest claiming to be v1 carries v3's
 * whole history. The prefix test alone waves that through — an identical
 * history is a prefix of itself — but a real v1 has no history at all.
 */
function assertChronologyMatchesVersion(manifest, which) {
  const history = manifest.expansion?.history || [];
  if (!Array.isArray(history)) throw Errors.validation(`the ${which} manifest's expansion.history is not a chronology`);
  const version = Number(manifest.world_version);
  let previous = 0;
  for (const [i, entry] of history.entries()) {
    const v = Number(entry?.version);
    if (!Number.isInteger(v) || v < 1) {
      throw Errors.conflict(`the ${which} manifest's history entry ${i} records no usable version`, { meta: { entry: i } });
    }
    if (v <= previous) {
      throw Errors.conflict(
        `the ${which} manifest's chronology does not move forward: entry ${i} records v${v} after v${previous}`,
        { meta: { entry: i, version: v, previous } }
      );
    }
    if (v > version) {
      throw Errors.conflict(
        `the ${which} manifest claims to be v${version} but its history records a later v${v}`,
        { meta: { entry: i, version: v, claimed: version } }
      );
    }
    previous = v;
  }
  if (history.length && previous !== version) {
    throw Errors.conflict(
      `the ${which} manifest claims to be v${version} but its chronology ends at v${previous}`,
      { meta: { claimed: version, chronology_ends_at: previous } }
    );
  }
}

/**
 * Roll a world back to an earlier version.
 *
 * @param {object} currentManifest the world as it stands now
 * @param {object} targetManifest  the earlier version's manifest, as it was saved
 * @param {{actorId:string, toVersion?:number, liveState?:object, label?:string, reason?:string}} opts
 * @returns {{manifest:object, record:object, memory_event:object}} the new
 *   version, the history entry it gained, and the world-memory event to record
 *   for it
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

  // Comparing the two chronologies is not enough on its own, because an
  // identical history is a prefix of itself: a manifest calling itself v1 while
  // carrying v3's entries passes the test above unchallenged. So each manifest
  // is then held to its own account of where it sits in its chronology. This
  // runs after the comparison so that the two-manifest failures keep their more
  // specific wording; what is left here is a manifest that is incoherent on its
  // own terms.
  assertChronologyMatchesVersion(current, "current");
  assertChronologyMatchesVersion(target, "target");

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
  // A PERMISSION is not content either. Rolling the world's content back to v1
  // used to restore v1's remix policy with it, so a creator who set
  // fork_policy:"deny" at v2 silently returned to "allow" — the rollback
  // re-granting a permission they had deliberately revoked. Attribution and
  // consent both carry forward from the CURRENT state, which is where the
  // creator's latest decision lives.
  for (const key of CARRIED_FORWARD_PERMISSIONS) {
    if (current.meta?.[key] !== undefined) next.meta[key] = structuredClone(current.meta[key]);
    else delete next.meta[key];
  }

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
    // The hashes identify the exact retained versions this rollback moved
    // between, so a caller can prove afterwards that it restored the snapshot it
    // meant to and not a different one that happened to carry the same number.
    from_manifest_hash: manifestHash(current),
    to_manifest_hash: manifestHash(target),
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
    // The chronology holds its own copy of every entry, the new one included, so
    // nothing a caller does with the returned record can edit the record.
    history: [...historyNow.map((h) => structuredClone(h)), structuredClone(record)],
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
  // The world it just built has to satisfy the same chronology rule it demanded
  // of its inputs. If it does not, the bug is here, and shipping the manifest
  // anyway would put the inconsistency into the permanent record.
  assertChronologyMatchesVersion(next, "restored");

  const preservation = verifyPreservation(current, next, liveState);
  if (!preservation.ok) {
    throw Errors.conflict(
      `rollback to v${toV} refused: ${preservation.problems.map((p) => p.detail).join("; ")}`,
      { meta: { to_version: toV, from_version: fromVersion, problems: preservation.problems } }
    );
  }

  return { manifest: next, record, memory_event: rollbackMemoryEvent(record) };
}

/**
 * The world-memory event for a rollback.
 *
 * A rollback is a world event, not a piece of database bookkeeping, and it has
 * to read as one in the world's own history: this is the same chronicle an NPC
 * or the companion draws on, and they may only cite what is written here. A
 * world that quietly went back two versions while its memory says only
 * "expanded, expanded" would have its inhabitants talking about a hospital that
 * is no longer standing.
 *
 * Built from the history record rather than from the caller's intent, so the
 * chronicle and the manifest's own chronology cannot disagree. Returned rather
 * than written: world memory is async and file-backed while planRollback is
 * pure, and a rollback that has not been persisted yet must not already have
 * been announced as having happened.
 */
export function rollbackMemoryEvent(record) {
  if (!record || typeof record !== "object") throw Errors.validation("a rollback memory event needs the rollback record");
  // Cloned, not referenced. The chronicle is written from this event, and a
  // caller that edits the record it was handed must not thereby edit what the
  // world remembers happening to it.
  const detailOf = (v) => (v === undefined || v === null ? v : structuredClone(v));
  return {
    kind: "rolled_back",
    // Factual and self-contained: which way it went, and who did it.
    summary: `the world was rolled back from v${record.from_version} to the content of v${record.to_version} by ${record.author}`,
    worldVersion: record.version,
    fromVersion: record.from_version,
    toVersion: record.to_version,
    actorId: record.author,
    occurredAt: record.at,
    detail: {
      from_version: record.from_version,
      to_version: record.to_version,
      restored_as_version: record.version,
      from_manifest_hash: record.from_manifest_hash ?? null,
      to_manifest_hash: record.to_manifest_hash ?? null,
      label: record.label,
      reason: record.reason ?? null,
      // What it actually did to the world, counted from the manifests.
      added: detailOf(record.added) || {},
      modified: record.modified ?? 0,
      removed: record.removed ?? 0,
      change_summary: record.summary ?? null,
      ...(record.ownership_preserved ? { ownership_preserved: detailOf(record.ownership_preserved) } : {}),
    },
  };
}

/**
 * Write a rollback into the world chronicle. A thin, deliberate seam: callers
 * that hold a world memory hand it and the plan's result here rather than
 * assembling the event themselves, so every rollback is recorded the same way.
 */
export async function recordRollback(worldMemory, worldId, planned) {
  if (!worldMemory?.record) throw Errors.validation("recording a rollback needs a world memory");
  const event = planned?.memory_event || rollbackMemoryEvent(planned?.record);
  return await worldMemory.record(worldId, event);
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
      from_manifest_hash: h.from_manifest_hash ?? null,
      to_manifest_hash: h.to_manifest_hash ?? null,
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
