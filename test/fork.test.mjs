// Section 9.4 — Remix / Fork a world.
//
// The feature is only safe if it cannot be used to launder someone else's work.
// These tests assert the boundaries: drafts are not forkable, a "deny" policy is
// honoured, attribution is permanent and structural, no player state or
// ownership travels, and no revenue is implied.
import test from "node:test";
import assert from "node:assert/strict";
import { createAssemblyRouter } from "../src/v3/router/assembly.mjs";
import { forkWorld, attributionChain, forkPolicyOf, DEFAULT_FORK_POLICY } from "../src/v3/expansion/fork.mjs";
import { playtestAndRepair } from "../src/v3/playtest/agent.mjs";
import { validateManifest } from "../src/v3/manifest/schema.mjs";
import { applyDelta } from "../src/v3/expansion/delta.mjs";
import { planExpansion } from "../src/v3/expansion/planner.mjs";

const OFFLINE = { DCS_PROVIDERS_OFFLINE: "1" };

async function publishedWorld(overrides = {}) {
  const out = await createAssemblyRouter(OFFLINE).assemble({ prompt: "Ashfall Harbour, a rainy nordic port town", worldId: "w_origin", creatorId: "creator-a" });
  return { world_id: "w_origin", owner_id: "creator-a", state: "published", version: 1, manifest: out.manifest, ...overrides };
}

test("a world's default fork policy requires attribution", async () => {
  const src = await publishedWorld();
  assert.equal(forkPolicyOf(src.manifest), DEFAULT_FORK_POLICY);
  assert.equal(DEFAULT_FORK_POLICY, "allow_with_attribution");
});

test("FORK GATE: a DRAFT cannot be forked — it belongs to its creator", async () => {
  const src = await publishedWorld({ state: "draft" });
  assert.throws(
    () => forkWorld(src, { forkerId: "creator-b", newWorldId: "w_fork" }),
    (e) => e.httpStatus === 403 && /only a published world/.test(e.detail)
  );
});

test("FORK GATE: a 'deny' policy is honoured", async () => {
  const src = await publishedWorld();
  src.manifest.meta.fork_policy = "deny";
  assert.throws(
    () => forkWorld(src, { forkerId: "creator-b", newWorldId: "w_fork" }),
    (e) => e.httpStatus === 403 && /not permitted remixing/.test(e.detail)
  );
});

test("you cannot fork your own world — expand it instead", async () => {
  const src = await publishedWorld();
  assert.throws(
    () => forkWorld(src, { forkerId: "creator-a", newWorldId: "w_fork" }),
    (e) => e.httpStatus === 422 && /expand or edit it/.test(e.detail)
  );
});

test("FORK GATE: attribution is permanent, structural and complete", async () => {
  const src = await publishedWorld();
  const { manifest, attribution } = forkWorld(src, { forkerId: "creator-b", newWorldId: "w_fork" });

  assert.equal(attribution.forked_from_world_id, "w_origin");
  assert.equal(attribution.forked_from_creator, "creator-a");
  assert.equal(attribution.forked_by, "creator-b");
  assert.equal(attribution.attribution_required, true);
  assert.match(attribution.source_manifest_hash, /^[0-9a-f]{64}$/, "the exact source is hashed, so the claim is checkable");

  // It lives in the manifest itself, not only in a response body.
  assert.deepEqual(manifest.meta.forked_from, attribution);
  assert.deepEqual(manifest.expansion.forked_from, attribution);
  assert.deepEqual(manifest.provenance.forked_from, attribution);
});

test("FORK GATE: a fork does NOT inherit the original's Atlas receipt", async () => {
  const src = await publishedWorld();
  src.manifest.meta.atlas_receipt_hash = "abc123";
  src.manifest.meta.atlas_signed = true;
  const { manifest } = forkWorld(src, { forkerId: "creator-b", newWorldId: "w_fork" });
  assert.equal(manifest.meta.atlas_receipt_hash, null, "that receipt attests to the ORIGINAL creator's world");
  assert.equal(manifest.meta.atlas_signed, false);
});

test("FORK GATE: a fork does not claim the original's expansion history", async () => {
  let src = await publishedWorld();
  // Give the original a real history first.
  src.manifest = applyDelta(src.manifest, planExpansion(src.manifest, { request: "add a hospital district" })).manifest;
  src.manifest = applyDelta(src.manifest, planExpansion(src.manifest, { request: "add an airport" })).manifest;
  assert.equal(src.manifest.expansion.history.length, 2);
  src.version = src.manifest.world_version;

  const { manifest } = forkWorld(src, { forkerId: "creator-b", newWorldId: "w_fork" });
  assert.deepEqual(manifest.expansion.history, [], "a remixer has not done the original's expansion work");
  assert.equal(manifest.world_version, 1, "a fork starts at version 1");
  assert.equal(manifest.meta.forked_from.forked_from_version, 3, "but records which version it came from");
});

test("FORK GATE: no ownership travels — a fork cannot hand over someone else's property", async () => {
  const src = await publishedWorld();
  src.manifest.structures[0].owner_id = "some-player";
  src.manifest.structures[1].owner_id = "another-player";
  const { manifest } = forkWorld(src, { forkerId: "creator-b", newWorldId: "w_fork" });
  assert.ok(manifest.structures.every((s) => s.owner_id === null), "player-owned structures must not transfer");
});

test("FORK GATE: no revenue is implied, and no split is invented", async () => {
  const src = await publishedWorld();
  const { manifest } = forkWorld(src, { forkerId: "creator-b", newWorldId: "w_fork" });
  const rp = manifest.meta.revenue_policy;
  assert.equal(rp.payments_live, false);
  assert.equal(rp.agreed_split_bps, null, "inventing a split would be exactly the unsupported claim this sprint removed");
  assert.equal(rp.original_creator, "creator-a");
  assert.equal(rp.remix_creator, "creator-b");
  assert.match(rp.note, /No revenue policy is in force/);
});

test("a fork keeps the original's generation provenance and adds its own", async () => {
  const src = await publishedWorld();
  const originalLanes = src.manifest.provenance.generated_by.length;
  const { manifest } = forkWorld(src, { forkerId: "creator-b", newWorldId: "w_fork" });
  assert.equal(manifest.provenance.generated_by.length, originalLanes + 1);
  const forkEntry = manifest.provenance.generated_by.at(-1);
  assert.equal(forkEntry.lane, "fork");
  assert.match(forkEntry.note, /forked from w_origin by creator-b/);
});

test("a forked world is valid and passes the playtest gate", async () => {
  const src = await publishedWorld();
  const { manifest } = forkWorld(src, { forkerId: "creator-b", newWorldId: "w_fork" });
  assert.equal(validateManifest(manifest).ok, true, JSON.stringify(validateManifest(manifest).errors));
  const gate = await playtestAndRepair(manifest);
  assert.equal(gate.verdict, "PASSED");
});

test("a fork can then be expanded on its own, independently of the original", async () => {
  const src = await publishedWorld();
  const { manifest } = forkWorld(src, { forkerId: "creator-b", newWorldId: "w_fork" });
  const expanded = applyDelta(manifest, planExpansion(manifest, { request: "add a market district" })).manifest;
  assert.equal(expanded.world_version, 2);
  assert.equal(expanded.expansion.history.length, 1, "its own history, from its own work");
  // Attribution survives the expansion.
  assert.equal(expanded.meta.forked_from.forked_from_creator, "creator-a");
});

test("the attribution chain reads only what is recorded", async () => {
  const src = await publishedWorld();
  assert.deepEqual(attributionChain(src.manifest), { is_fork: false, chain: [] });

  const { manifest } = forkWorld(src, { forkerId: "creator-b", newWorldId: "w_fork" });
  const chain = attributionChain(manifest);
  assert.equal(chain.is_fork, true);
  assert.equal(chain.original_creator, "creator-a");
  assert.equal(chain.attribution_required, true);
  assert.equal(chain.chain.length, 2);
  assert.equal(chain.chain[0].role, "original");
  assert.equal(chain.chain[1].creator, "creator-b");
});

test("forking requires an authenticated principal and a new id", async () => {
  const src = await publishedWorld();
  assert.throws(() => forkWorld(src, { forkerId: null, newWorldId: "w" }), (e) => e.httpStatus === 401);
  assert.throws(() => forkWorld(src, { forkerId: "b", newWorldId: null }), (e) => e.httpStatus === 422);
});
