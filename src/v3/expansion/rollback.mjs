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
import { COLLECTIONS, OWNABLE_COLLECTIONS, deltaHash, emptyLiveState, verifyPreservation } from "./delta.mjs";
import { diffManifests } from "./diff.mjs";
import { namespacedCounts } from "./stitch.mjs";
import { manifestHash } from "../../core/worldstore.mjs";
import { Errors } from "../../core/errors.mjs";

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
 * A manifest has to be able to run on the runtime it says it needs.
 *
 * `manifest_version` (what format this content is) and
 * `expansion.compatibility.min_runtime` (what format a runtime must speak to
 * load it) describe the same thing from two directions, so a manifest declaring
 * itself older than its own minimum is incoherent whichever half is the lie. It
 * is a refusal rather than a repair: picking one of the two numbers to overwrite
 * would be guessing which of them the world is.
 */
const semver = (v) => String(v ?? "0.0.0").split(".").map((n) => Number.parseInt(n, 10) || 0);
function assertFormatCoherent(manifest, which) {
  const declared = manifest?.manifest_version;
  const demanded = manifest?.expansion?.compatibility?.min_runtime;
  if (!declared || !demanded) return;
  const [dMaj, dMin, dPatch] = semver(declared);
  const [rMaj, rMin, rPatch] = semver(demanded);
  const meets = dMaj > rMaj || (dMaj === rMaj && (dMin > rMin || (dMin === rMin && dPatch >= rPatch)));
  if (!meets) {
    throw Errors.conflict(
      `the ${which} manifest declares manifest_version ${declared} while its own compatibility demands a ${demanded} runtime`,
      { meta: { manifest_version: declared, min_runtime: demanded, migrated_from: manifest.expansion.compatibility.migrated_from ?? null } }
    );
  }
}

/**
 * Which counter a caller's `toVersion` is written in.
 *
 * There are two, and they are not the same number:
 *
 *   "manifest"  the world's own `world_version`, which only applyDelta and the
 *               migrator advance — it moves when the CONTENT changes;
 *   "record"    the repository's retained-version number, which advances on
 *               every accepted save (WorldRepository._upsert), a state-only
 *               save included — so publishing a world advances it while the
 *               manifest's own version stands still.
 *
 * `GET /v3/worlds/:id/versions` lists RECORD numbers, so a caller that rolls
 * back to a version the history offered it is speaking the record counter while
 * the manifest it fetched answers in the other one. Comparing the two as if
 * they were one number is how a rollback to a version the server itself just
 * offered came back as "the manifest supplied is v2, not the v3 that was asked
 * for" — a refusal blaming the caller for the server's own numbering.
 */
export const VERSION_COUNTERS = ["manifest", "record"];

/**
 * Check the caller's assertion about WHICH VERSION IT FETCHED, in the counter it
 * wrote that assertion in. Returns the counter the assertion was read in, so the
 * record can say so.
 *
 * The relationship between the counters is the only thing that makes a
 * record-counter assertion checkable at all: the record number advances at least
 * as often as the manifest's own version, so the manifest retained under record
 * number N has `world_version <= N`, never more. That is a real constraint (it
 * still catches a caller that fetched a LATER snapshot than it asked for) but it
 * is weaker than equality, which is why `toManifestHash` exists: a hash names
 * the exact snapshot and belongs to no counter at all.
 */
function assertTargetIsWhatWasAskedFor(target, { toVersion, versionCounter, toManifestHash, toV, fromVersion }) {
  if (toManifestHash !== null && toManifestHash !== undefined) {
    const actual = manifestHash(target);
    if (String(toManifestHash) !== actual) {
      throw Errors.validation(
        "the manifest supplied is not the snapshot that was asked for",
        { meta: { asked_for_manifest_hash: String(toManifestHash), supplied_manifest_hash: actual } }
      );
    }
  }
  if (!VERSION_COUNTERS.includes(versionCounter)) {
    throw Errors.validation(`versionCounter must be one of: ${VERSION_COUNTERS.join(", ")}`);
  }
  if (toVersion === null || toVersion === undefined) return versionCounter;

  const asked = Number(toVersion);
  if (!Number.isInteger(asked) || asked < 1) throw Errors.validation("the version asked for is not a version number");

  // The counter is the caller's to declare, and it is inferred in exactly one
  // place: a number EQUAL to the current manifest's own version.
  //
  // Such a number cannot be a manifest-counter rollback target — a rollback only
  // goes backwards, so a manifest-counter target is strictly earlier than the
  // present — and it is precisely the number a retained-version list produces
  // after a single state-only save: publish a world and the retained version
  // that holds the manifest calling itself v2 is numbered 3, alongside a present
  // that is still manifest v3. Refusing it means refusing a rollback to a
  // version the server itself just offered.
  //
  // The inference stops there. A number ABOVE the current version cannot be
  // bounded by anything this function can see: "roll back to v7 of a world that
  // has only ever had two versions" is a caller asking for something that does
  // not exist, and reading it as a retained-record number would silently restore
  // v1 instead of refusing. A number BELOW it is a perfectly good manifest
  // version, so it is held to the manifest exactly, and a caller that asked for
  // v2 and fetched v1 is still told so. Anything else — a deeper skew, a
  // republished world, a retained number that collides with a real earlier
  // manifest version — must be DECLARED with versionCounter:"record" or, better,
  // asserted with toManifestHash, because it cannot be told apart from a mistake.
  const counter = versionCounter === "manifest" && asked === fromVersion ? "record" : versionCounter;

  if (counter === "manifest") {
    if (asked !== toV) {
      throw Errors.validation(`the manifest supplied is v${toV}, not the v${asked} that was asked for`);
    }
  } else if (toV > asked) {
    // The retained record number can only run AHEAD of the manifest version it
    // holds. A manifest that is LATER than the record number asked for is not
    // the snapshot that number names, whichever counter the caller meant.
    throw Errors.validation(
      `the manifest supplied is v${toV}, which is later than the v${asked} that was asked for`,
      { meta: { asked_for: asked, supplied_world_version: toV, counter } }
    );
  }
  return counter;
}

/**
 * Roll a world back to an earlier version.
 *
 * @param {object} currentManifest the world as it stands now
 * @param {object} targetManifest  the earlier version's manifest, as it was saved
 * @param {{actorId:string, toVersion?:number, versionCounter?:"manifest"|"record", toManifestHash?:string, liveState?:object, label?:string, reason?:string}} opts
 * @returns {{manifest:object, record:object, memory_event:object}} the new
 *   version, the history entry it gained, and the world-memory event to record
 *   for it
 */
export function planRollback(currentManifest, targetManifest, { actorId, toVersion = null, versionCounter = "manifest", toManifestHash = null, liveState = emptyLiveState(), label = null, reason = null } = {}) {
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
  // back to it would silently restore the wrong world. Which "disagrees" means
  // depends on the counter the assertion is written in — see VERSION_COUNTERS.
  const assertedIn = assertTargetIsWhatWasAskedFor(target, { toVersion, versionCounter, toManifestHash, toV, fromVersion });
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

  // Ownership is a player's ledger, not the creator's content. An entity that
  // existed at the target version and has since been bought, given or assigned
  // stays that way; the restoration is listed in the record rather than done
  // quietly.
  //
  // Read from EVERY collection that can carry an owner, not from structures
  // alone. The refusal above covers an owned entity the rollback would DELETE;
  // this covers the one it keeps. Restoring `next` from the target and then
  // reinstating owners on structures only meant a player's item or NPC — present
  // at both versions, so never in the way of anything — came back carrying the
  // target's `owner_id`, which is to say `undefined`: the entity survived and
  // its owner did not. Worse, `record.ownership_preserved` then affirmatively
  // reported the house as preserved while saying nothing about the sword, so the
  // record read as a positive assurance that ownership had been handled.
  const ownershipPreserved = [];
  for (const key of OWNABLE_COLLECTIONS) {
    const ownerNow = new Map((current[key] || []).map((e) => [e.id, e.owner_id ?? null]));
    for (const e of next[key] || []) {
      if (!ownerNow.has(e.id)) continue;
      const owner = ownerNow.get(e.id);
      if ((e.owner_id ?? null) === owner) continue;
      e.owner_id = owner;
      // { id, owner_id } and nothing else: the shape callers and the chronicle
      // already read. Ids are unique across collections, so the entry is not
      // ambiguous without naming one.
      ownershipPreserved.push({ id: e.id, owner_id: owner });
    }
  }

  // ---- the FORMAT travels with the content it describes ------------------
  //
  // `manifest_version` is part of the restored content (next is a clone of the
  // target), and `expansion.compatibility` says which runtime that format needs.
  // Rebuilding `expansion` wholesale from the CURRENT version took the two from
  // different versions, so a world generated at 3.0.0 and migrated to 3.1.0 at
  // v2, rolled back to v1, came out declaring:
  //     manifest_version: "3.0.0"
  //     compatibility:    { min_runtime: "3.1.0", migrated_from: "3.0.0" }
  // a manifest claiming to be the very version it records being migrated FROM,
  // demanding a runtime newer than itself. validateManifest has nothing to say
  // about it, so nothing downstream noticed.
  const currentExpansion = structuredClone(current.expansion || {});
  const compatibility =
    structuredClone(target.expansion?.compatibility ?? null) ||
    structuredClone(currentExpansion.compatibility ?? null) ||
    { min_runtime: String(next.manifest_version || "3.0.0"), migrated_from: null };

  // A rollback across a migration moves the world's FORMAT backwards as well as
  // its content. That is legitimate — the restored content really is 3.0.0
  // content — but it must not happen silently: the repository stores the
  // manifest_version on the record, and a version that went backwards with
  // nothing recording it is a regression no later reader can account for.
  const formatFrom = current.manifest_version ?? null;
  const formatTo = next.manifest_version ?? null;
  const manifestVersionRestored = formatFrom === formatTo
    ? null
    : { from: formatFrom, to: formatTo, min_runtime: compatibility?.min_runtime ?? null };

  // ---- a count of entities is a claim about content ----------------------
  //
  // `expansion.stitched_from` survived a rollback untouched, `counts` block and
  // all — "this guest contributed 6 zones, 14 structures, 9 npcs" — about
  // entities the rollback had just deleted. This is NOT the "credit is not
  // content" rule that keeps meta.stitched_attribution: a name in an
  // attribution list is a credit, a per-collection count of entities is a claim
  // about the content and it is now false. So the credit stays and the counts
  // are recounted from the restored manifest, with what arrived on the day kept
  // under a name that says that is what it is.
  const stitchedFrom = (currentExpansion.stitched_from || []).map((part) => {
    const held = namespacedCounts(next, part.namespace);
    const claimed = part.counts || {};
    if (JSON.stringify(held) === JSON.stringify(claimed)) return part;
    return {
      ...part,
      counts: held,
      counts_at_stitch: part.counts_at_stitch ?? claimed,
      content_present: Object.values(held).some((n) => n > 0),
      counts_corrected: { by: "rollback", to_version: toV, at_version: next.world_version },
    };
  });

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
    // What the caller asked for and in which counter, whenever that number is
    // not the manifest's own — so a response saying "rolled_back_to: 3" and a
    // chronicle saying "to_version: 2" can be reconciled by a later reader
    // instead of looking like a contradiction.
    ...(toVersion !== null && Number(toVersion) !== toV
      ? { to_version_asked: Number(toVersion), to_version_counter: assertedIn }
      : {}),
    // The format the world went back to, when the rollback crossed a migration.
    ...(manifestVersionRestored ? { manifest_version_restored: manifestVersionRestored } : {}),
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

  next.expansion = {
    ...currentExpansion,
    // Taken from the same version as the content whose format it describes.
    compatibility,
    ...(currentExpansion.stitched_from ? { stitched_from: stitchedFrom } : {}),
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
  // And the format it declares has to be one it can actually run under. If the
  // two halves disagree here the target itself was incoherent, and shipping the
  // manifest anyway would put a world that cannot state its own format into the
  // permanent record.
  assertFormatCoherent(next, "restored");

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
      // A rollback that crossed a migration took the world's FORMAT back too.
      ...(record.manifest_version_restored ? { manifest_version_restored: detailOf(record.manifest_version_restored) } : {}),
      ...(record.to_version_asked !== undefined
        ? { to_version_asked: record.to_version_asked, to_version_counter: record.to_version_counter ?? null }
        : {}),
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
      manifest_version_restored: h.manifest_version_restored ?? null,
    }));
}

export { HOLDS };
