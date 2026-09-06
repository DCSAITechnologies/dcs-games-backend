// Section 9.4 — Remix / Fork a world.
//
// A permitted public world can be forked, with provenance, attribution and a
// place for a future revenue policy to attach. Money stays dark: a fork records
// what a revenue policy WOULD apply to, and settles nothing.
//
// The rules that make this safe rather than a content-laundering tool:
//   - only a PUBLISHED world may be forked, never someone's private draft
//   - the original creator is recorded in the fork's provenance permanently
//   - the fork starts at version 1 with its OWN history; it does not inherit the
//     original's expansion history as if it had done that work
//   - no player state, ownership or completed quest carries across: a fork is a
//     new world, not a copy of someone's save
//   - forking is refused when the original forbids it
import crypto from "node:crypto";
import { validateManifest } from "../manifest/schema.mjs";
import { Errors } from "../../core/errors.mjs";

/** A world's own statement about whether it may be remixed. */
export const FORK_POLICIES = ["allow", "allow_with_attribution", "deny"];
export const DEFAULT_FORK_POLICY = "allow_with_attribution";

export function forkPolicyOf(manifest) {
  const p = manifest?.meta?.fork_policy;
  return FORK_POLICIES.includes(p) ? p : DEFAULT_FORK_POLICY;
}

/**
 * Fork a world.
 *
 * @param {object} source        the published world record { world_id, owner_id, state, version, manifest }
 * @param {{forkerId:string, newWorldId:string, title?:string}} opts
 * @returns {{manifest:object, attribution:object}}
 */
export function forkWorld(source, { forkerId, newWorldId, title = null } = {}) {
  if (!forkerId) throw Errors.unauthenticated("forking requires an authenticated principal");
  if (!newWorldId) throw Errors.validation("a fork needs a new world id");
  if (!source?.manifest) throw Errors.validation("the source world has no manifest");

  if (source.state !== "published") {
    throw Errors.forbidden(
      "only a published world can be forked; a draft belongs to its creator",
      { meta: { state: source.state } }
    );
  }

  const policy = forkPolicyOf(source.manifest);
  if (policy === "deny") {
    throw Errors.forbidden("this world's creator has not permitted remixing", { meta: { fork_policy: policy } });
  }
  if (source.owner_id === forkerId) {
    throw Errors.validation("you already own this world; expand or edit it instead of forking it");
  }

  const m = structuredClone(source.manifest);
  const now = new Date().toISOString();

  // Identity: a new world, not a continuation of someone else's.
  m.world_id = newWorldId;
  m.world_version = 1;
  m.meta = {
    ...m.meta,
    title: title || `${m.meta?.title || "Untitled"} (remix)`,
    creator_id: forkerId,
    created_at: now,
    updated_at: now,
    // A fork cannot inherit the original's Atlas receipt: that receipt attests
    // to the original creator's world, not to this one.
    atlas_receipt_hash: null,
    atlas_signed: false,
  };

  // Attribution is permanent and structural, not a courtesy line in a description.
  const attribution = {
    forked_from_world_id: source.world_id,
    forked_from_creator: source.owner_id,
    forked_from_version: source.version ?? source.manifest.world_version ?? 1,
    forked_from_title: source.manifest?.meta?.title ?? null,
    fork_policy: policy,
    attribution_required: policy === "allow_with_attribution",
    forked_by: forkerId,
    forked_at: now,
    source_manifest_hash: crypto.createHash("sha256").update(JSON.stringify(source.manifest)).digest("hex"),
  };
  m.meta.forked_from = attribution;

  // Its own history, starting now. Claiming the original's expansion history
  // would be claiming work this creator did not do.
  m.expansion = {
    history: [],
    compatibility: { min_runtime: source.manifest?.expansion?.compatibility?.min_runtime || "3.0.0", migrated_from: null },
    hooks: source.manifest?.expansion?.hooks || [],
    forked_from: attribution,
  };

  // Provenance keeps the original's generation record — those providers really
  // did make this geometry — and adds the fork as its own event.
  m.provenance = {
    ...(m.provenance || { generated_by: [] }),
    generated_by: [
      ...((source.manifest?.provenance?.generated_by) || []),
      { lane: "fork", provider: "dcs-games", model: null, status: "AVAILABLE", at: now, note: `forked from ${source.world_id} by ${forkerId}` },
    ],
    forked_from: attribution,
  };

  // No player state travels. Ownership on structures is cleared, so a fork can
  // never hand someone else's property to the forker.
  for (const s of m.structures || []) s.owner_id = null;

  // A revenue policy has somewhere to attach, and settles nothing today.
  m.meta.revenue_policy = {
    payments_live: false,
    original_creator: source.owner_id,
    remix_creator: forkerId,
    // Deliberately null: no split has been agreed, and inventing one would be
    // exactly the kind of unsupported claim this sprint removed.
    agreed_split_bps: null,
    note: "No revenue policy is in force. Payments are disabled, and no split has been agreed between the original creator and the remixer.",
  };

  const validation = validateManifest(m);
  if (!validation.ok) {
    throw Errors.internal("the forked world did not satisfy WorldManifestV3", { meta: { errors: validation.errors.slice(0, 6) } });
  }

  return { manifest: m, attribution };
}

/**
 * The attribution chain for a world: who made the original, and who remixed it.
 * Reads only what is recorded, so it cannot overstate a lineage.
 */
export function attributionChain(manifest) {
  const f = manifest?.meta?.forked_from;
  if (!f) return { is_fork: false, chain: [] };
  return {
    is_fork: true,
    original_creator: f.forked_from_creator,
    original_world_id: f.forked_from_world_id,
    attribution_required: !!f.attribution_required,
    chain: [
      { role: "original", creator: f.forked_from_creator, world_id: f.forked_from_world_id, title: f.forked_from_title, version: f.forked_from_version },
      { role: "remix", creator: manifest.meta.creator_id, world_id: manifest.world_id, title: manifest.meta.title, version: manifest.world_version },
    ],
  };
}
