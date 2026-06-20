// src/extensions.mjs
// P1 + P2 — additive to the frozen C1 world.json (never break C1; only add optional fields).
//
// P1: per-world community scaffolding (chat/posts/announcements/events).
// P2: asset provenance metadata so CW7's ownership chain resolves to a creator + a receipt slot.
//
// Both attach to a world WITHOUT changing any C1-required field, so existing fixtures + validator stay green.
// Zero npm deps.

import crypto from "node:crypto";

// ---------- P1: community template ----------
// Attached at world.community (optional, additive). Scaffolding only — no live data faked.
export function buildCommunityTemplate(world) {
  return {
    world_id: world.world_id,
    chat:    { channels: [{ id: "general", name: "General" }, { id: "lfg", name: "Looking For Group" }], moderated: true },
    posts:   { board_id: `board_${world.world_id}`, allow_player_posts: true, pinned: [] },
    announcements: [{ id: "a1", title: `${world.meta.title} is live`, body: "", author_id: world.meta.creator_id, ts: null }],
    events:  { scaffold: [{ id: "ev_launch", name: "Launch Week", starts_at: null, ends_at: null }] },
    source: "template", // honest: scaffolding, not real community activity
  };
}

// ---------- P2: asset provenance ----------
// Every generated asset (object/npc/item) gets a provenance record CW7 can resolve to ownership.
// provenance = { asset_id, asset_type, generated_by:"cw2", creator_id, world_id, content_hash, receipt_hash:null }
function provenanceFor(asset, asset_type, world) {
  const content_hash = crypto.createHash("sha256")
    .update(JSON.stringify(asset)).digest("hex").slice(0, 16);
  return {
    asset_id: asset.object_id || asset.npc_id || asset.item_id,
    asset_type,
    generated_by: "cw2",
    creator_id: world.meta.creator_id,
    world_id: world.world_id,
    content_hash,
    receipt_hash: null, // honest: CW7/Atlas issues the receipt; CW2 only emits the provenance to be signed
  };
}

// Attach provenance[] to the world (additive). Returns a new world with world.provenance set.
export function attachProvenance(world) {
  const prov = [];
  for (const o of world.objects || []) prov.push(provenanceFor(o, "object", world));
  for (const n of world.npcs || [])    prov.push(provenanceFor(n, "npc", world));
  for (const it of world.items || [])  prov.push(provenanceFor(it, "item", world));
  return { ...world, provenance: prov };
}

// CW7 ownership-chain resolver (the M-P2 gate): given a world + an asset_id,
// resolve asset -> creator -> (receipt slot). Fail-closed: unknown asset or missing creator -> not resolved.
export function resolveOwnership(world, asset_id) {
  const rec = (world.provenance || []).find((p) => p.asset_id === asset_id);
  if (!rec) return { resolved: false, reason: "asset_not_in_provenance" };
  if (!rec.creator_id) return { resolved: false, reason: "no_creator" };
  return {
    resolved: true,
    asset_id,
    asset_type: rec.asset_type,
    creator_id: rec.creator_id,
    world_id: rec.world_id,
    content_hash: rec.content_hash,
    receipt_hash: rec.receipt_hash, // null until Atlas signs — honest
    chain: `${asset_id} → creator:${rec.creator_id} → world:${rec.world_id}`,
  };
}
