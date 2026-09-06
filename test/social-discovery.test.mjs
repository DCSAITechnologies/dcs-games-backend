// B15 — recovering the BUILT_DARK capabilities.
//
// Round-2 classified profiles, friends, parties, teams and studios as reachable
// code with a process-local Map behind it, seeded with three fixture users. It
// also found a column conflict that would have broken the first real friend
// request. These tests assert the replacement is durable, correctly keyed and
// honest about money.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSocialService } from "../src/core/social.mjs";
import { createSafetyService } from "../src/core/safety.mjs";
import { createSubscriptionsService } from "../src/core/subscriptions.mjs";

const tmp = () => ({ DCS_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "dcs-social-")) });
const svc = () => createSocialService(tmp());
const P = (id, email = null, tester = false) => ({ id, email, isInternalTester: tester });

// ================================================================== profile

test("B15: a profile is created on first sight and is idempotent", async () => {
  const s = svc();
  const a = await s.ensureProfile(P("u1", "alice@dcsai.ai"));
  const b = await s.ensureProfile(P("u1", "alice@dcsai.ai"));
  assert.equal(a.principal_id, b.principal_id);
  assert.equal(a.username, "alice");
  assert.equal((await s.me(P("u1"))).username, "alice");
});

test("B15: a username collision does not break a first login", async () => {
  const s = svc();
  const a = await s.ensureProfile(P("u1", "alice@dcsai.ai"));
  const b = await s.ensureProfile(P("u2", "alice@example.com"));
  assert.equal(a.username, "alice");
  assert.notEqual(b.username, "alice");
  assert.match(b.username, /^alice_/);
});

test("B15 GATE: the profile survives a restart — it was an in-memory fixture before", async () => {
  const env = tmp();
  const a = createSocialService(env);
  await a.ensureProfile(P("u1", "alice@dcsai.ai"));
  await a.updateProfile(P("u1"), { display_name: "Alice", bio: "builds harbours" });
  const b = createSocialService(env);                 // new service object, same disk
  const me = await b.me(P("u1"));
  assert.equal(me.display_name, "Alice");
  assert.equal(me.bio, "builds harbours");
});

test("B15: the level comes from real signals, and is honestly conservative", async () => {
  const s = svc();
  const me = await s.me(P("u1", "alice@dcsai.ai"));
  // No email provider is configured, so email_verified is false rather than assumed.
  assert.equal(me.level_signals.email_verified, false);
  assert.equal(me.level, "explorer");
  assert.equal(me.subscription.dcs_plus_effective, false, "subscriptions are dark");
  assert.equal("dcs_plus" in me.level_signals, false, "the plan is not a level input and must not be listed as one");
  assert.equal(me.publish_credits, 1);
  assert.equal(me.publish_credits_unlimited, false);
  assert.equal(me.can_publish.allowed, true);
});

test("B15 GATE: the profile reports money as explicitly dark", async () => {
  const s = svc();
  const me = await s.me(P("u1"));
  assert.equal(me.economy.payments_live, false);
  assert.equal(me.economy.balance_minor, 0);
  assert.equal(me.economy.dcs_plus, false);
  assert.match(me.economy.note, /disabled/);
});

test("B15: only whitelisted profile fields can be edited", async () => {
  const s = svc();
  await s.ensureProfile(P("u1"));
  await s.updateProfile(P("u1"), { display_name: "Alice" });
  await assert.rejects(() => s.updateProfile(P("u1"), { worlds_published: 999 }), (e) => e.httpStatus === 403);
  await assert.rejects(() => s.updateProfile(P("u1"), { is_internal_tester: true }), (e) => e.httpStatus === 403);
});

test("B15: a public profile leaks neither the email nor the principal id", async () => {
  const s = svc();
  await s.ensureProfile(P("u1", "alice@dcsai.ai"));
  const pub = await s.publicProfile("alice");
  assert.equal(pub.username, "alice");
  assert.ok(!("email" in pub), "a public profile must not expose an email address");
  assert.ok(!("principal_id" in pub), "a public profile must not expose the auth principal");
});

test("B15: creating and publishing worlds moves the real counters", async () => {
  const s = svc();
  await s.ensureProfile(P("u1"));
  await s.recordWorldCreated("u1");
  await s.recordWorldCreated("u1");
  await s.recordWorldPublished("u1");
  const me = await s.me(P("u1"));
  assert.equal(me.worlds_created, 2);
  assert.equal(me.worlds_published, 1);
  assert.equal(me.xp, 150);
});

// ================================================================== friends

test("B15 GATE: friendship uses the canonical columns and survives a restart", async () => {
  const env = tmp();
  const a = createSocialService(env);
  const row = await a.requestFriend("u1", "u2");
  // The live code wrote a_id/b_id; production has user_id/friend_id.
  assert.ok("user_id" in row && "friend_id" in row, "the canonical columns must be used");
  assert.ok(!("a_id" in row), "a_id does not exist in production and must not be written");
  assert.equal(row.status, "requested");

  const b = createSocialService(env);
  await b.acceptFriend("u2", "u1");
  assert.equal(await b.areFriends("u1", "u2"), true);
});

test("B15: a friend list separates accepted, incoming and outgoing", async () => {
  const s = svc();
  await s.requestFriend("u1", "u2");
  await s.requestFriend("u3", "u1");
  const mine = await s.friendList("u1");
  assert.deepEqual(mine.friends, []);
  assert.equal(mine.outgoing[0].id, "u2");
  assert.equal(mine.incoming[0].id, "u3");

  await s.acceptFriend("u1", "u3");
  const after = await s.friendList("u1");
  assert.equal(after.friends[0].id, "u3");
  assert.equal(after.incoming.length, 0);
});

test("B15: a crossing friend request accepts rather than creating a duplicate", async () => {
  const s = svc();
  await s.requestFriend("u1", "u2");
  const back = await s.requestFriend("u2", "u1");
  assert.equal(back.status, "accepted", "two people asking each other should just become friends");
  const l = await s.friendList("u1");
  assert.equal(l.friends.length, 1);
  assert.equal(l.outgoing.length, 0);
});

test("B15: you cannot befriend yourself, and a repeat request is idempotent", async () => {
  const s = svc();
  await assert.rejects(() => s.requestFriend("u1", "u1"), (e) => e.httpStatus === 422);
  await s.requestFriend("u1", "u2");
  const again = await s.requestFriend("u1", "u2");
  assert.equal(again.idempotent, true);
  assert.equal((await s.friendList("u1")).outgoing.length, 1);
});

test("B15: accepting a request that does not exist is a 404", async () => {
  const s = svc();
  await assert.rejects(() => s.acceptFriend("u1", "u2"), (e) => e.httpStatus === 404);
});

// ================================================================== parties

test("B15: a party round-trips and enforces its size", async () => {
  const s = svc();
  const p = await s.createParty("u1", { maxSize: 2 });
  assert.deepEqual(p.members, ["u1"]);
  await s.joinParty("u2", p.id);
  assert.equal((await s.getParty(p.id)).size, 2);
  await assert.rejects(() => s.joinParty("u3", p.id), (e) => e.httpStatus === 409 && /full/.test(e.detail));
});

test("B15: an invite-only party refuses an uninvited join", async () => {
  const s = svc();
  const p = await s.createParty("u1", { open: false });
  await assert.rejects(() => s.joinParty("u2", p.id), (e) => e.httpStatus === 403);
});

test("B15: the leader leaving hands over instead of orphaning the party", async () => {
  const s = svc();
  const p = await s.createParty("u1", { maxSize: 4 });
  await s.joinParty("u2", p.id);
  const after = await s.leaveParty("u1", p.id);
  assert.equal(after.leader_id, "u2");
  assert.deepEqual(after.members, ["u2"]);
});

test("B15: the last member leaving closes the party rather than leaving a ghost", async () => {
  const s = svc();
  const p = await s.createParty("u1");
  const after = await s.leaveParty("u1", p.id);
  assert.equal(after.closed, true);
  assert.equal((await s.myParties("u1")).length, 0);
});

// ==================================================================== teams

test("B15: teams enforce role permissions", async () => {
  const s = svc();
  const t = await s.createTeam("u1", "Harbour Crew");
  await s.addTeamMember("u1", t.id, "u2", "member");
  // A plain member cannot add anyone.
  await assert.rejects(() => s.addTeamMember("u2", t.id, "u3"), (e) => e.httpStatus === 403);
  // But they can leave.
  const after = await s.removeTeamMember("u2", t.id, "u2");
  assert.equal(after.members.length, 1);
});

test("B15: a team's owner cannot be removed, and a second owner cannot be added", async () => {
  const s = svc();
  const t = await s.createTeam("u1", "Crew");
  await assert.rejects(() => s.removeTeamMember("u1", t.id, "u1"), (e) => e.httpStatus === 403);
  await assert.rejects(() => s.addTeamMember("u1", t.id, "u2", "owner"), (e) => e.httpStatus === 403);
});

test("B15: a team needs a real name", async () => {
  const s = svc();
  await assert.rejects(() => s.createTeam("u1", "x"), (e) => e.httpStatus === 422);
  await assert.rejects(() => s.createTeam(null, "Crew"), (e) => e.httpStatus === 401);
});

// ================================================================== studios

test("B15 GATE: a studio split is recorded but never settles money", async () => {
  const s = svc();
  const st = await s.createStudio("u1", "NovaStudio");
  assert.equal(st.payments_live, false);
  assert.equal(st.split_total_bps, 10000);
  assert.match(st.split_note, /no money moves/);

  await s.addStudioMember("u1", st.id, "u2", "creator");
  const after = await s.getStudio(st.id);
  // Adding a member must not silently dilute anyone.
  assert.equal(after.members.find((m) => m.member_id === "u2").split_bps, 0);
  assert.equal(after.split_total_bps, 10000);
});

test("B15: a split must total exactly 100% and only name real members", async () => {
  const s = svc();
  const st = await s.createStudio("u1", "NovaStudio");
  await s.addStudioMember("u1", st.id, "u2", "creator");

  await assert.rejects(() => s.setStudioSplit("u1", st.id, [{ member_id: "u1", split_bps: 5000 }]), (e) => /10000/.test(e.detail));
  await assert.rejects(() => s.setStudioSplit("u1", st.id, [{ member_id: "u1", split_bps: 5000 }, { member_id: "stranger", split_bps: 5000 }]), (e) => /not a member/.test(e.detail));

  const ok = await s.setStudioSplit("u1", st.id, [{ member_id: "u1", split_bps: 7000 }, { member_id: "u2", split_bps: 3000 }]);
  assert.equal(ok.split_total_bps, 10000);
  assert.equal(ok.payments_live, false);
});

test("B15: only an owner or admin can configure a split", async () => {
  const s = svc();
  const st = await s.createStudio("u1", "NovaStudio");
  await s.addStudioMember("u1", st.id, "u2", "creator");
  await assert.rejects(() => s.setStudioSplit("u2", st.id, [{ member_id: "u1", split_bps: 10000 }]), (e) => e.httpStatus === 403);
});

// ================================================================ discovery

const worldRow = (id, title, genre, updated) => ({
  world_id: id, title, version: 1, owner_id: "u1", updated_at: updated,
  manifest: { meta: { title, genre, tags: [genre], maturity: "13+" }, media: {} },
});

test("B15 GATE: discovery ranks on MEASURED activity, and says so when there is none", async () => {
  const s = svc();
  const worlds = [worldRow("w1", "Ashfall", "adventure", "2026-09-01"), worldRow("w2", "Neon", "openworld", "2026-09-05")];
  const d = await s.discover(worlds, { sort: "most_played" });
  assert.equal(d.count, 2);
  assert.ok(d.worlds.every((w) => w.stats.plays === 0));
  assert.match(d.note, /real zeros, not placeholders/);
  assert.ok(d.worlds.every((w) => w.stats.rating_avg === null), "an unrated world has no average, not a default");
});

test("B15: recording real plays changes the ranking", async () => {
  const s = svc();
  const worlds = [worldRow("w1", "Ashfall", "adventure", "2026-09-01"), worldRow("w2", "Neon", "openworld", "2026-09-05")];
  await s.recordPlay("w1", "p1", 300);
  await s.recordPlay("w1", "p2", 120);
  await s.recordPlay("w2", "p1", 60);

  const d = await s.discover(worlds, { sort: "most_played" });
  assert.equal(d.worlds[0].world_id, "w1");
  assert.equal(d.worlds[0].stats.plays, 2);
  assert.equal(d.worlds[0].stats.unique_players, 2);
  assert.equal(d.worlds[0].stats.total_seconds, 420);
  assert.equal(d.note, null, "with real activity there is nothing to disclaim");
});

test("B15: ratings are one per player and average honestly", async () => {
  const s = svc();
  await s.rateWorld("p1", "w1", 5);
  await s.rateWorld("p2", "w1", 3);
  await s.rateWorld("p1", "w1", 4);        // a player changing their mind
  const st = await s.worldStats("w1");
  assert.equal(st.rating_count, 2, "one rating per player");
  assert.equal(st.rating_avg, 3.5);
  await assert.rejects(() => s.rateWorld("p1", "w1", 9), (e) => e.httpStatus === 422);
  await assert.rejects(() => s.rateWorld(null, "w1", 4), (e) => e.httpStatus === 401);
});

test("B15: discovery filters by genre and free text", async () => {
  const s = svc();
  const worlds = [worldRow("w1", "Ashfall Harbour", "adventure", "2026-09-01"), worldRow("w2", "Neon Block", "openworld", "2026-09-05")];
  assert.equal((await s.discover(worlds, { genre: "adventure" })).count, 1);
  assert.equal((await s.discover(worlds, { q: "neon" })).count, 1);
  assert.equal((await s.discover(worlds, { q: "nothing matches this" })).count, 0);
});

test("B15: a placeholder thumbnail is labelled as one in discovery", async () => {
  const s = svc();
  const w = worldRow("w1", "Ashfall", "adventure", "2026-09-01");
  w.manifest.media = { thumbnail_ref: "asset_thumbnail", thumbnail_is_placeholder: true };
  const d = await s.discover([w]);
  assert.equal(d.worlds[0].thumbnail_is_placeholder, true, "a placeholder must never pass as generated art");
});

// ===================================================================== orgs
//
// Round-2 capability 87: real seat logic, an in-memory store, no tables — and
// no permission check on adding a member, so anyone could add themselves to any
// org and then read it.

test("B15 GATE: only an owner or admin can add an org member", async () => {
  const s = svc();
  const o = await s.createOrg("u1", { name: "DCS Studios", seats: 5 });
  await s.addOrgMember("u1", o.id, "u2", "member");
  // The check that was missing entirely.
  await assert.rejects(() => s.addOrgMember("u2", o.id, "u3"), (e) => e.httpStatus === 403 && /owner or admin/.test(e.detail));
  // An outsider cannot even see the org, let alone join it.
  await assert.rejects(() => s.addOrgMember("outsider", o.id, "outsider"), (e) => e.httpStatus === 403);
});

test("B15 GATE: an org is visible only to its members", async () => {
  const s = svc();
  const o = await s.createOrg("u1", { name: "DCS Studios" });
  await assert.rejects(() => s.getOrg(o.id, "outsider"), (e) => e.httpStatus === 403 && /only to its members/.test(e.detail));
  assert.equal((await s.getOrg(o.id, "u1")).id, o.id);
});

test("B15: seats are enforced as a capacity limit, and billed to nobody", async () => {
  const s = svc();
  const o = await s.createOrg("u1", { name: "Small", seats: 2 });
  assert.equal(o.payments_live, false);
  assert.match(o.billing_note, /No seat is billed/);
  await s.addOrgMember("u1", o.id, "u2");
  assert.equal((await s.getOrg(o.id, "u1")).seats_remaining, 0);
  await assert.rejects(() => s.addOrgMember("u1", o.id, "u3"), (e) => e.httpStatus === 409 && /no seats left/.test(e.detail));
});

test("B15: reducing seats below the current membership is refused, not applied silently", async () => {
  const s = svc();
  const o = await s.createOrg("u1", { name: "Org", seats: 5 });
  await s.addOrgMember("u1", o.id, "u2");
  await s.addOrgMember("u1", o.id, "u3");
  await assert.rejects(() => s.setOrgSeats("u1", o.id, 2), (e) => e.httpStatus === 409 && /remove some/.test(e.detail));
  const ok = await s.setOrgSeats("u1", o.id, 3);
  assert.equal(ok.seats, 3);
});

test("B15: only the billing owner can change the seat count", async () => {
  const s = svc();
  const o = await s.createOrg("u1", { name: "Org", seats: 5 });
  await s.addOrgMember("u1", o.id, "u2", "admin");
  await assert.rejects(() => s.setOrgSeats("u2", o.id, 9), (e) => e.httpStatus === 403);
});

test("B15: the billing owner cannot be removed, and a member can remove themselves", async () => {
  const s = svc();
  const o = await s.createOrg("u1", { name: "Org", seats: 5 });
  await s.addOrgMember("u1", o.id, "u2");
  await assert.rejects(() => s.removeOrgMember("u1", o.id, "u1"), (e) => e.httpStatus === 403);
  const after = await s.removeOrgMember("u2", o.id, "u2");
  assert.equal(after.members.length, 1);
});

test("B15: a second owner cannot be added, and orgs survive a restart", async () => {
  const env = tmp();
  const a = createSocialService(env);
  const o = await a.createOrg("u1", { name: "Org", seats: 5 });
  await assert.rejects(() => a.addOrgMember("u1", o.id, "u2", "owner"), (e) => e.httpStatus === 403);
  const b = createSocialService(env);
  const seen = await b.getOrg(o.id, "u1");
  assert.equal(seen.name, "Org");
  assert.equal(seen.seats_used, 1);
});

test("B15: creating an org validates its name and seat count", async () => {
  const s = svc();
  await assert.rejects(() => s.createOrg(null, { name: "Org" }), (e) => e.httpStatus === 401);
  await assert.rejects(() => s.createOrg("u1", { name: "x" }), (e) => e.httpStatus === 422);
  await assert.rejects(() => s.createOrg("u1", { name: "Org", seats: 0 }), (e) => e.httpStatus === 422);
  await assert.rejects(() => s.createOrg("u1", { name: "Org", seats: 5000 }), (e) => e.httpStatus === 422);
});

// ======================================================= blocks (Round-3 fix)
//
// A live block must stop a friendship forming through ANY path. It used to stop
// exactly one: POST /social/friends checked safety.isBlocked at the ROUTE.
// acceptFriend had no block check at all, so A could request B, B could block A,
// and the pending row survived for either side to accept. Party join had none
// either. These tests drive the SERVICE, not the route, because that is where
// the guard now lives — a future caller cannot route around it.

/** A social service whose block check is a set of ordered pairs. */
const withBlocks = (pairs = [], extra = {}) => {
  const set = new Set(pairs.map(([a, b]) => a + ">" + b));
  return createSocialService(tmp(), { isBlocked: async (a, b) => set.has(a + ">" + b) || set.has(b + ">" + a), ...extra });
};

test("R3 GATE: acceptFriend refuses across a live block — it had no block check at all", async () => {
  // The exact reproduction: A requests B, then B blocks A.
  const env = tmp();
  const open = createSocialService(env, { isBlocked: async () => false });
  await open.requestFriend("A", "B");
  // Same store, now with the block in force.
  const s = createSocialService(env, { isBlocked: async (a, b) => (a === "B" && b === "A") });
  await assert.rejects(() => s.acceptFriend("B", "A"), (e) => e.httpStatus === 403 && /blocked/.test(e.detail));
  // ...and the blocker's own side cannot accept it either.
  await assert.rejects(() => s.acceptFriend("A", "B"), (e) => e.httpStatus === 403);
  assert.equal(await s.areFriends("A", "B"), false);
});

test("R3 GATE: the stale pending request is deleted, not left to sit in a list forever", async () => {
  const env = tmp();
  const open = createSocialService(env, { isBlocked: async () => false });
  await open.requestFriend("A", "B");
  assert.equal((await open.friendList("B")).incoming.length, 1);

  const s = createSocialService(env, { isBlocked: async (a, b) => (a === "B" && b === "A") });
  await assert.rejects(() => s.acceptFriend("B", "A"), (e) => e.httpStatus === 403);
  // Gone for both sides: a request that can never be accepted is not a request.
  assert.deepEqual((await s.friendList("B")).incoming, []);
  assert.deepEqual((await s.friendList("A")).outgoing, []);
});

test("R3: merely LOOKING at the friend list sweeps a request a block invalidated", async () => {
  const env = tmp();
  const open = createSocialService(env, { isBlocked: async () => false });
  await open.requestFriend("A", "B");
  const s = createSocialService(env, { isBlocked: async () => true });
  const list = await s.friendList("B");
  assert.deepEqual(list.incoming, []);
  assert.deepEqual(list.removed_blocked, ["A"]);
  // Really removed from the store, not merely filtered out of one response.
  const raw = JSON.parse(fs.readFileSync(path.join(s.dir, "friends.json"), "utf8"));
  assert.deepEqual(raw, []);
});

test("R3: the block is NOT shadowed in the friends table — unblocking lets a request work again", async () => {
  const env = tmp();
  let blocked = true;
  const s = createSocialService(env, { isBlocked: async () => blocked });
  await assert.rejects(() => s.requestFriend("A", "B"), (e) => e.httpStatus === 403);
  blocked = false;                                  // safety.unblock()
  const req = await s.requestFriend("A", "B");
  assert.equal(req.status, "requested");
  const f = await s.acceptFriend("B", "A");
  assert.equal(f.status, "accepted");
});

test("R3 GATE: an existing friendship does not survive a block", async () => {
  const env = tmp();
  const open = createSocialService(env, { isBlocked: async () => false });
  await open.requestFriend("A", "B");
  await open.acceptFriend("B", "A");
  assert.equal(await open.areFriends("A", "B"), true);

  const s = createSocialService(env, { isBlocked: async () => true });
  assert.equal(await s.areFriends("A", "B"), false, "a block ends the friendship, it does not merely hide it");
  assert.deepEqual((await s.friendList("A")).friends, []);
});

test("R3 GATE: requestFriend is guarded in the SERVICE, not only at the route", async () => {
  const s = withBlocks([["B", "A"]]);
  await assert.rejects(() => s.requestFriend("A", "B"), (e) => e.httpStatus === 403 && /blocked/.test(e.detail));
  await assert.rejects(() => s.requestFriend("B", "A"), (e) => e.httpStatus === 403);
});

test("R3: a one-directional block check still refuses both directions", async () => {
  // safety.isBlocked is symmetric, but the service must not depend on that:
  // an injected check that only looks one way would otherwise let the BLOCKER
  // befriend the person they blocked.
  const s = createSocialService(tmp(), { isBlocked: async (a, b) => a === "B" && b === "A" });
  await assert.rejects(() => s.requestFriend("A", "B"), (e) => e.httpStatus === 403);
  await assert.rejects(() => s.requestFriend("B", "A"), (e) => e.httpStatus === 403);
});

test("R3 GATE: party join refuses when a member is blocked, in either direction", async () => {
  const a = withBlocks([["A", "B"]]);               // A blocked B
  const p1 = await a.createParty("A", {});
  await assert.rejects(() => a.joinParty("B", p1.id), (e) => e.httpStatus === 403 && /blocked/.test(e.detail));
  assert.deepEqual((await a.getParty(p1.id)).members, ["A"]);

  const b = withBlocks([["B", "A"]]);               // B blocked A
  const p2 = await b.createParty("A", {});
  await assert.rejects(() => b.joinParty("B", p2.id), (e) => e.httpStatus === 403);

  // A block against a NON-member does not stop the join.
  const c = withBlocks([["C", "B"]]);
  const p3 = await c.createParty("A", {});
  assert.deepEqual((await c.joinParty("B", p3.id)).members, ["A", "B"]);
});

test("R3 GATE: the block check cannot be switched off", async () => {
  // Optional-and-silently-skipped is how the hole was drilled in the first
  // place, so an explicit non-function is a startup error.
  for (const bad of [null, false, undefined, "no", {}]) {
    assert.throws(() => createSocialService(tmp(), { isBlocked: bad }), (e) => e.httpStatus === 422 && /block check is required/.test(e.detail));
  }
  assert.throws(() => createSocialService(tmp(), { safety: {} }), (e) => e.httpStatus === 422);
});

test("R3 GATE: with NO deps at all the real safety service is used — not no check", async () => {
  // The default must be a real block check over the same store the rest of the
  // estate blocks into, because server.mts constructs this service with no deps.
  const env = tmp();
  const social = createSocialService(env);
  const safety = createSafetyService(env);
  await social.requestFriend("A", "B");
  await safety.block("B", "A");                      // written by a different service object
  await assert.rejects(() => social.acceptFriend("B", "A"), (e) => e.httpStatus === 403 && /blocked/.test(e.detail));
  const party = await social.createParty("A", {});
  await assert.rejects(() => social.joinParty("B", party.id), (e) => e.httpStatus === 403);
  assert.equal(await social.areFriends("A", "B"), false);
});

test("R3: a safety-shaped dependency is accepted as well as a bare function", async () => {
  const env = tmp();
  const safety = createSafetyService(env);
  const social = createSocialService(env, { safety });
  await safety.block("B", "A");
  await assert.rejects(() => social.requestFriend("A", "B"), (e) => e.httpStatus === 403);
});

test("R3: accepting still 404s when there is no request and nobody is blocked", async () => {
  const s = withBlocks([]);
  await assert.rejects(() => s.acceptFriend("u1", "u2"), (e) => e.httpStatus === 404);
  await assert.rejects(() => s.acceptFriend(null, "u2"), (e) => e.httpStatus === 401);
  await assert.rejects(() => s.acceptFriend("u1", null), (e) => e.httpStatus === 422);
});

// ============================================== subscription wiring (Round-3)
//
// me() hardcoded dcs_plus:false, so a comped internal tester's profile reported
// the free allowance of 1 publish credit while subscriptions.entitlementsFor()
// reported 10 for the same principal.

const fakeSubs = (rows = {}) => ({ statusFor: async (id) => rows[id] || { principal_id: id, plan: "free", status: "none", active_grant: false, paid: false, comped: false, test_mode: null } });

test("R3: with no subscription service wired, /me is exactly what it was", async () => {
  const s = svc();
  const me = await s.me(P("u1", "alice@dcsai.ai"));
  assert.equal(me.subscription.dcs_plus_effective, false);
  assert.equal(me.publish_credits, 1);
  assert.equal(me.subscription.plan, "free");
  assert.equal(me.subscription.source, "none");
  assert.equal(me.subscription.dcs_plus_effective, false);
  assert.equal(me.subscription.dcs_plus_paid, false);
});

test("R3 GATE: a comped tester's profile reports the SAME allowance as entitlementsFor", async () => {
  const env = tmp();
  const subs = createSubscriptionsService(env);
  await subs.grantTestPlan({ id: "staff", isInternalTester: true }, { id: "u1", isInternalTester: true }, "dcs_plus", { reason: "entitlement smoke test" });

  const bare = createSocialService(env);
  assert.equal((await bare.me(P("u1"))).publish_credits, 1, "the defect: unwired, the profile still says 1");

  const s = createSocialService(env, { subscriptions: subs });
  const me = await s.me(P("u1"));
  const ent = await subs.entitlementsFor("u1", { level: me.level, publishedCount: me.worlds_published });
  assert.equal(me.publish_credits, 10);
  assert.equal(ent.entitlements[0].value, 10);
  assert.equal(me.publish_credits, ent.entitlements[0].value, "one question must not have two answers");
  assert.equal(me.can_publish.remaining, 10);
  assert.equal(me.subscription.dcs_plus_effective, true);
  assert.equal(me.subscription.plan, "dcs_plus");
  assert.equal(me.subscription.source, "comped_internal_test_grant");
});

test("R3 GATE: a comped grant is an ENTITLEMENT, never revenue — the two are separately named", async () => {
  const env = tmp();
  const subs = createSubscriptionsService(env);
  await subs.grantTestPlan({ id: "staff", isInternalTester: true }, { id: "u1", isInternalTester: true }, "dcs_plus");
  const me = await createSocialService(env, { subscriptions: subs }).me(P("u1"));

  assert.equal(me.subscription.dcs_plus_effective, true, "the tester has the entitlements");
  assert.equal(me.subscription.dcs_plus_paid, false, "nobody was charged");
  assert.equal(me.subscription.dcs_plus_effective, true);
  assert.equal(me.subscription.dcs_plus_paid, false);
  // The plan reaches the ALLOWANCE and never the level: level_signals carries
  // only what actually determines the level, so nothing here tells a user that
  // paying would raise their reach.
  assert.equal("dcs_plus" in me.level_signals, false);
  assert.equal("dcs_plus_effective" in me.level_signals, false);
  assert.equal(me.subscription.comped, true);
  assert.equal(me.subscription.test_mode, true);

  // Nothing money-shaped moves, in this object or in any total built from it.
  assert.equal(me.economy.dcs_plus, false);
  assert.equal(me.economy.dcs_plus_paid, false);
  assert.equal(me.economy.paid_subscriptions, 0);
  assert.equal(me.economy.revenue_minor, 0);
  assert.equal(me.economy.balance_minor, 0);
  assert.equal(me.economy.payments_live, false);

  // ...and the aggregate on the subscriptions side agrees.
  const g = await subs.listGrants();
  assert.equal(g.count, 1);
  assert.equal(g.paid_count, 0);
  assert.equal(g.total_price_minor, 0);
  assert.equal(g.revenue_minor, 0);
  assert.equal((await subs.assertDark()).dark, true);
});

test("R3 GATE: a status row claiming it was PAID is refused, not copied into the profile", async () => {
  const s = createSocialService(tmp(), {
    subscriptions: fakeSubs({ u1: { plan: "dcs_plus", status: "active", active_grant: true, paid: true, comped: false, test_mode: false } }),
  });
  const me = await s.me(P("u1"));
  assert.equal(me.subscription.dcs_plus_paid, false, "there is no code path that may set this true");
  assert.equal(me.subscription.paid_claim_rejected, true, "and the claim is surfaced rather than swallowed");
  assert.equal(me.economy.dcs_plus, false);
});

test("R3: a subscription service that fails degrades to the free allowance instead of crashing /me", async () => {
  const s = createSocialService(tmp(), { subscriptions: { statusFor: async () => { throw new Error("supabase down"); } } });
  const me = await s.me(P("u1"));
  assert.equal(me.publish_credits, 1, "degrade downwards: never grant an entitlement nobody can confirm");
  assert.equal(me.subscription.degraded, true, "and say it is degraded rather than claiming a real 'free'");
  assert.equal(me.subscription.dcs_plus_effective, false);
});

test("R3: a subscriptions dependency of the wrong shape is a startup error", async () => {
  assert.throws(() => createSocialService(tmp(), { subscriptions: {} }), (e) => e.httpStatus === 422 && /statusFor/.test(e.detail));
  // An explicit null means "none wired", which is legal and is today's behaviour.
  assert.doesNotThrow(() => createSocialService(tmp(), { subscriptions: null }));
});

test("R3: a comped plan raises the ALLOWANCE and does not raise the LEVEL", async () => {
  // computeLevel() deliberately does NOT take dcs_plus: level is a trust axis and must not be purchasable (see src/cw1/identity-core.mjs).
  // This pins the behaviour: a plan buys credits, not trust. If someone makes a
  // level purchasable, this fails and they have to say so out loud.
  const env = tmp();
  const subs = createSubscriptionsService(env);
  await subs.grantTestPlan({ id: "staff", isInternalTester: true }, { id: "u1", isInternalTester: true }, "dcs_plus");
  const me = await createSocialService(env, { subscriptions: subs }).me(P("u1"));
  assert.equal(me.level, "explorer");
  assert.equal(me.publish_credits, 10);
});
