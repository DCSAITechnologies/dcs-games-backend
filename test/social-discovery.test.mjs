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
  assert.equal((await s.getParty(p.id, "u1")).size, 2);
  await assert.rejects(() => s.joinParty("u3", p.id), (e) => e.httpStatus === 409 && /full/.test(e.detail));
});

test("B15: an invite-only party refuses an uninvited join", async () => {
  const s = svc();
  const p = await s.createParty("u1", { open: false });
  await assert.rejects(() => s.joinParty("u2", p.id), (e) => e.httpStatus === 404);
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
  const after = await s.getStudio(st.id, "u1");
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
  await assert.rejects(() => s.addOrgMember("outsider", o.id, "outsider"), (e) => e.httpStatus === 404 || e.httpStatus === 403);
});

test("B15 GATE: an org is visible only to its members", async () => {
  const s = svc();
  const o = await s.createOrg("u1", { name: "DCS Studios" });
  await assert.rejects(() => s.getOrg(o.id, "outsider"), (e) => e.httpStatus === 404 && /not found/.test(e.detail));
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
  assert.deepEqual((await a.getParty(p1.id, "A")).members, ["A"]);

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

test("a client cannot award itself an achievement with an absurd play duration", async () => {
  // progression grants "hour played" from total seconds_played, and `seconds`
  // is reported by the client — so an unbounded value is an achievement anyone
  // can grant themselves in one request. Nothing times a session server-side,
  // so the number is clamped and marked self-reported rather than trusted.
  const social = createSocialService(tmp());
  const row = await social.recordPlay("w1", "u1", 999_999_999);
  assert.ok(row.seconds <= 4 * 60 * 60, `an absurd duration must be clamped, got ${row.seconds}`);
  assert.equal(row.seconds_clamped, true);
  assert.equal(row.seconds_self_reported, true, "nothing on this estate timed this, and the row must say so");

  const nonsense = await social.recordPlay("w1", "u1", "not-a-number");
  assert.equal(nonsense.seconds, null, "an unparseable duration is unknown, not zero and not accepted");

  const honest = await social.recordPlay("w1", "u1", 120);
  assert.equal(honest.seconds, 120, "a plausible duration is still recorded exactly");
  assert.equal(honest.seconds_clamped, false);
});

// =============================================================================
// Round-4 — CHECK-THEN-WRITE. Lane J's sweep measured the class: a rule decided
// from an unlocked read and then written by a locked write is not enforced at
// all, because every concurrent caller reads the same "there is room" and all of
// them pass. Measured before the fix: a party with max_size 2 held 9 members
// after 8 concurrent joins, a 2-seat org held 9, and 16 concurrent friend
// requests wrote 16 rows for one pair.
//
// EVERY test in this section runs its operations with Promise.all (really
// concurrently, not in sequence) and asserts the STORED STATE on disk rather
// than the return values — the return values all said "success" while the data
// was wrong, so a test that trusts them proves nothing.
// =============================================================================

/** The rows actually on disk for one collection of a service. */
const stored = (s, name) => {
  const f = path.join(s.dir, name + ".json");
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : [];
};
const nofail = (results) => results.filter((r) => r.status === "fulfilled").length;

test("R4 GATE: a party's size limit holds against 8 concurrent joins", async () => {
  // The reproduction from test/regression-sweep.test.mjs, asserted against the
  // file rather than the responses.
  const s = svc();
  const p = await s.createParty("leader", { maxSize: 2 });
  const r = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => s.joinParty("member-" + i, p.id)));

  const rows = stored(s, "party_members").filter((m) => m.party_id === p.id);
  assert.equal(rows.length, 2, `max_size 2 must mean 2 rows on disk, got ${rows.length}`);
  assert.equal(new Set(rows.map((m) => m.member_id)).size, 2, "and no duplicate member rows");
  assert.equal(nofail(r), 1, "exactly one joiner may be told it succeeded");
  assert.equal((await s.getParty(p.id, "leader")).size, 2);
  // The refusals are honest 409s, not swallowed.
  for (const x of r.filter((y) => y.status === "rejected")) {
    assert.equal(x.reason.httpStatus, 409);
    assert.match(x.reason.detail, /full/);
  }
});

test("R4: 40 concurrent joins on a 5-seat party store exactly 5 members", async () => {
  const s = svc();
  const p = await s.createParty("leader", { maxSize: 5 });
  await Promise.all(Array.from({ length: 40 }, (_, i) => s.joinParty("m" + i, p.id).catch(() => null)));
  assert.equal(stored(s, "party_members").filter((m) => m.party_id === p.id).length, 5);
});

test("R4: the same principal joining a party 12 times concurrently is one member", async () => {
  const s = svc();
  const p = await s.createParty("leader", { maxSize: 8 });
  await Promise.all(Array.from({ length: 12 }, () => s.joinParty("u2", p.id).catch(() => null)));
  const rows = stored(s, "party_members").filter((m) => m.party_id === p.id);
  assert.equal(rows.length, 2, "(party_id, member_id) is the primary key; a repeat join is idempotent");
});

test("R4 GATE: an org's seat limit holds against 8 concurrent adds, and stays recoverable", async () => {
  const s = svc();
  const o = await s.createOrg("owner", { name: "Acme Interactive", seats: 2 });
  const r = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => s.addOrgMember("owner", o.id, "u" + i)));

  const rows = stored(s, "org_members").filter((m) => m.org_id === o.id);
  assert.equal(rows.length, 2, `2 seats must mean 2 rows on disk, got ${rows.length}`);
  assert.equal(nofail(r), 1);
  assert.equal((await s.getOrg(o.id, "owner")).seats_used, 2);
  // The overflow used to be unrecoverable through the API: setOrgSeats refuses
  // to shrink below the member count, so an org that overshot could never be
  // brought back. With the limit actually held, the owner can still resize.
  assert.equal((await s.setOrgSeats("owner", o.id, 4)).seats, 4);
  assert.equal((await s.setOrgSeats("owner", o.id, 2)).seats, 2);
});

test("R4: a seat shrink racing a seat fill never lands an org above its seats", async () => {
  const s = svc();
  const o = await s.createOrg("owner", { name: "Org", seats: 6 });
  await Promise.all([
    ...Array.from({ length: 5 }, (_, i) => s.addOrgMember("owner", o.id, "u" + i).catch(() => null)),
    s.setOrgSeats("owner", o.id, 3).catch(() => null),
  ]);
  const after = await s.getOrg(o.id, "owner");
  assert.ok(after.seats_used <= after.seats,
    `an org must never hold more members than seats, got ${after.seats_used}/${after.seats}`);
});

test("R4 GATE: 16 concurrent friend requests write ONE row for one relationship", async () => {
  const s = svc();
  await Promise.all(Array.from({ length: 16 }, () => s.requestFriend("alice", "bob").catch(() => null)));

  // Against the DECLARED primary key: locally every duplicate survived, while
  // Supabase upserts on (user_id, friend_id) and would have kept one — so the
  // two backings held genuinely different data.
  const rows = stored(s, "friends");
  assert.equal(rows.length, 1, `16 concurrent requests must write 1 row, got ${rows.length}`);
  assert.equal(rows[0].status, "requested");
  assert.equal((await s.friendList("alice")).outgoing.length, 1);
  assert.equal((await s.friendList("bob")).incoming.length, 1);

  // And acceptFriend, which only ever rewrote the FIRST matching row, now
  // leaves nothing behind still claiming to be pending.
  await s.acceptFriend("bob", "alice");
  assert.equal(stored(s, "friends").filter((f) => f.status === "requested").length, 0);
  assert.equal(await s.areFriends("alice", "bob"), true);
});

test("R4: two people requesting each other at the same moment become friends once", async () => {
  const s = svc();
  await Promise.all([
    s.requestFriend("alice", "bob").catch(() => null),
    s.requestFriend("bob", "alice").catch(() => null),
  ]);
  const rows = stored(s, "friends");
  assert.equal(rows.length, 1, "a crossing request must not write a second row for the same pair");
  const l = await s.friendList("alice");
  assert.equal(l.friends.length + l.outgoing.length, 1);
});

test("R4: concurrent accepts of one request do not error and do not duplicate", async () => {
  const s = svc();
  await s.requestFriend("alice", "bob");
  const r = await Promise.allSettled(Array.from({ length: 4 }, () => s.acceptFriend("bob", "alice")));
  assert.equal(nofail(r), 4, "losing an accept race is not an error: the friendship exists either way");
  const rows = stored(s, "friends");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "accepted");
});

test("R4: 8 concurrent adds of the same team member write one membership row", async () => {
  const s = svc();
  const t = await s.createTeam("u1", "Harbour Crew");
  await Promise.all(Array.from({ length: 8 }, () => s.addTeamMember("u1", t.id, "u2").catch(() => null)));
  const rows = stored(s, "team_members").filter((m) => m.team_id === t.id);
  assert.equal(rows.length, 2, `(team_id, member_id) is the primary key, got ${rows.length} rows`);
  assert.equal(rows.filter((m) => m.member_id === "u2").length, 1);
});

test("R4: 8 concurrent adds of the same studio member write one row and do not dilute the split", async () => {
  const s = svc();
  const st = await s.createStudio("u1", "NovaStudio");
  await Promise.all(Array.from({ length: 8 }, () => s.addStudioMember("u1", st.id, "u2", "creator").catch(() => null)));
  const rows = stored(s, "studio_members").filter((m) => m.studio_id === st.id);
  assert.equal(rows.length, 2);
  assert.equal((await s.getStudio(st.id, "u1")).split_total_bps, 10000, "a duplicate row would have shown up as a broken total");
});

test("R4: two concurrent splits cannot land a total that is neither of them", async () => {
  // setStudioSplit validates "exactly 10000 bps" from a read and then writes the
  // members one row at a time, so two interleaved calls could write A's share of
  // one and B's share of the other: 6000 + 7000 = 13000, breaking the only rule
  // the method exists to enforce.
  const s = svc();
  const st = await s.createStudio("u1", "NovaStudio");
  await s.addStudioMember("u1", st.id, "u2", "creator");
  await Promise.all([
    s.setStudioSplit("u1", st.id, [{ member_id: "u1", split_bps: 6000 }, { member_id: "u2", split_bps: 4000 }]).catch(() => null),
    s.setStudioSplit("u1", st.id, [{ member_id: "u1", split_bps: 3000 }, { member_id: "u2", split_bps: 7000 }]).catch(() => null),
  ]);
  const after = await s.getStudio(st.id, "u1");
  assert.equal(after.split_total_bps, 10000, `a split must always total 100%, got ${after.split_total_bps}`);
  assert.equal(after.payments_live, false, "and none of it moves any money");
});

test("R4: a split that does not name a member zeroes them rather than leaving a stale share", async () => {
  const s = svc();
  const st = await s.createStudio("u1", "NovaStudio");
  await s.addStudioMember("u1", st.id, "u2", "creator");
  await s.setStudioSplit("u1", st.id, [{ member_id: "u1", split_bps: 5000 }, { member_id: "u2", split_bps: 5000 }]);
  await s.setStudioSplit("u1", st.id, [{ member_id: "u1", split_bps: 10000 }]);
  const after = await s.getStudio(st.id, "u1");
  assert.equal(after.split_total_bps, 10000, "leaving u2's old 5000 standing would have totalled 15000");
  assert.equal(after.members.find((m) => m.member_id === "u2").split_bps, 0);
});

test("R4: 12 concurrent ratings from one player are one rating", async () => {
  // rating_avg is what discover() ranks on, so a double-click that wrote two
  // rows counted one person twice.
  const s = svc();
  await Promise.all(Array.from({ length: 12 }, (_, i) => s.rateWorld("p1", "w1", (i % 5) + 1)));
  assert.equal(stored(s, "world_ratings").filter((r) => r.world_id === "w1").length, 1);
  const st = await s.worldStats("w1");
  assert.equal(st.rating_count, 1, "one player, one rating, however fast they click");
  await s.rateWorld("p2", "w1", 5);
  assert.equal((await s.worldStats("w1")).rating_count, 2);
});

test("R4: concurrent leaves never hand a party to someone who has left it", async () => {
  const s = svc();
  const p = await s.createParty("u1", { maxSize: 4 });
  await s.joinParty("u2", p.id);
  await s.joinParty("u3", p.id);
  await Promise.all([s.leaveParty("u1", p.id), s.leaveParty("u2", p.id)]);
  const after = await s.getParty(p.id, "u3");
  assert.deepEqual(after.members, ["u3"]);
  assert.ok(after.members.includes(after.leader_id),
    `the leader must be someone who is still in the party, got ${after.leader_id}`);
});

test("R4: the counters that were already atomic stay atomic — 60 concurrent creates", async () => {
  // AUDITED AND SAFE, pinned so it stays that way: recordWorldCreated and
  // recordWorldPublished increment inside collection.update()'s mutator, which
  // runs under the write lock, so the read and the write are already one step.
  // This is the check-then-write shape they are NOT.
  const s = svc();
  await s.ensureProfile(P("u1"));
  await Promise.all([
    ...Array.from({ length: 60 }, () => s.recordWorldCreated("u1")),
    ...Array.from({ length: 20 }, () => s.recordWorldPublished("u1")),
  ]);
  const me = await s.me(P("u1"));
  assert.equal(me.worlds_created, 60, "a lost increment here would understate a real counter");
  assert.equal(me.worlds_published, 20);
  assert.equal(me.xp, 60 * 25 + 20 * 100);
});

test("R4: concurrent plays all survive — an append has no rule to race", async () => {
  const s = svc();
  await Promise.all(Array.from({ length: 30 }, () => s.recordPlay("w1", "p1", 60)));
  assert.equal(stored(s, "world_plays").length, 30);
  assert.equal((await s.worldStats("w1")).plays, 30);
});

// =============================================================================
// Round-4 — the open reads. getParty and getTeam took no requester and checked
// nothing, so an anonymous caller holding an id received the full member list,
// the leader/owner principal id and the world — invite-only parties included.
// getOrg had already been given a requesterId; these match it.
// =============================================================================

test("R4 GATE: an invite-only party is not readable without a requester, or by a stranger", async () => {
  const s = svc();
  const p = await s.createParty("leader", { worldId: "w-secret", maxSize: 4, open: false });
  await assert.rejects(() => s.getParty(p.id), (e) => e.httpStatus === 404 && /not found/.test(e.detail));
  await assert.rejects(() => s.getParty(p.id, "stranger"), (e) => e.httpStatus === 404);
  const seen = await s.getParty(p.id, "leader");
  assert.deepEqual(seen.members, ["leader"]);
  assert.equal(seen.world_id, "w-secret");
});

test("R4 GATE: an open party tells a stranger its capacity and nobody's identity", async () => {
  // An open party is one anyone may join, so "does it have room" is public —
  // that is what a join button needs. WHO is in it is not.
  const s = svc();
  const p = await s.createParty("leader", { worldId: "w-secret", maxSize: 3 });
  await s.joinParty("u2", p.id);

  const anon = await s.getParty(p.id);
  assert.equal(anon.size, 2);
  assert.equal(anon.full, false);
  assert.equal(anon.redacted, true);
  assert.equal("members" in anon, false, "a stranger must not receive the member list");
  assert.equal("leader_id" in anon, false, "nor the leader's principal id");
  assert.equal("world_id" in anon, false, "nor the world the party is in");

  const member = await s.getParty(p.id, "u2");
  assert.deepEqual(member.members, ["leader", "u2"]);
  assert.equal(member.leader_id, "leader");
  assert.equal(member.world_id, "w-secret");
  assert.equal(member.redacted, undefined);
});

test("R4 GATE: a team's membership is visible only to its members", async () => {
  const s = svc();
  const t = await s.createTeam("owner", "Secret Team");
  await assert.rejects(() => s.getTeam(t.id), (e) => e.httpStatus === 404 && /not found/.test(e.detail));
  await assert.rejects(() => s.getTeam(t.id, "stranger"), (e) => e.httpStatus === 404);
  assert.equal((await s.getTeam(t.id, "owner")).name, "Secret Team");

  // A member added later can read it; one removed again cannot.
  await s.addTeamMember("owner", t.id, "u2");
  assert.equal((await s.getTeam(t.id, "u2")).members.length, 2);
  await s.removeTeamMember("owner", t.id, "u2");
  await assert.rejects(() => s.getTeam(t.id, "u2"), (e) => e.httpStatus === 404);
  assert.equal((await s.myTeams("u2")).length, 0);
});

test("R4: an org with no requester at all is refused, not waved through", async () => {
  // getOrg's check read `if (requesterId && ...)`, so the anonymous case — the
  // one that most needs it — skipped it entirely.
  const s = svc();
  const o = await s.createOrg("u1", { name: "DCS Studios" });
  await assert.rejects(() => s.getOrg(o.id), (e) => e.httpStatus === 404 && /not found/.test(e.detail));
  assert.equal((await s.getOrg(o.id, "u1")).id, o.id);
});

test("R4: leaving a party or a team still answers the person who left", async () => {
  // They are no longer a member, so the permission check would refuse them the
  // result of their own request. Same rule removeOrgMember already applied.
  const s = svc();
  const p = await s.createParty("u1", { maxSize: 4 });
  await s.joinParty("u2", p.id);
  const leftParty = await s.leaveParty("u2", p.id);
  assert.deepEqual(leftParty.members, ["u1"]);

  const t = await s.createTeam("u1", "Crew");
  await s.addTeamMember("u1", t.id, "u2");
  const leftTeam = await s.removeTeamMember("u2", t.id, "u2");
  assert.equal(leftTeam.members.length, 1);
});

test("R4: a revoked role cannot be used, and the check is re-taken inside the atomic step", async () => {
  // The role check is a READ, and a read taken before the write is a read that
  // can go stale. It is re-taken inside the atomic step so a revoked admin
  // cannot complete an add.
  //
  // Deliberately NOT written as two concurrent calls and an assertion about the
  // final state: from the end state alone you cannot tell "the add landed while
  // they were still an admin", which is legitimate, from "the add landed after
  // they were removed", which is the defect. The ordering that must be refused
  // is therefore made to happen.
  const s = svc();
  const o = await s.createOrg("u1", { name: "Org", seats: 10 });
  await s.addOrgMember("u1", o.id, "u2", "admin");

  await s.removeOrgMember("u1", o.id, "u2");
  await assert.rejects(
    () => s.addOrgMember("u2", o.id, "u3"),
    (e) => e.httpStatus === 403 || e.httpStatus === 404,
    "a principal who is no longer an admin cannot add anyone",
  );

  const after = await s.getOrg(o.id, "u1");
  const ids = after.members.map((m) => m.member_id);
  assert.ok(!ids.includes("u2"), "the admin really was removed");
  assert.ok(!ids.includes("u3"), "and their add did not land afterwards");

  // The concurrent form must still leave a coherent org whichever way it races.
  const o2 = await s.createOrg("u1", { name: "Org2", seats: 10 });
  await s.addOrgMember("u1", o2.id, "u2", "admin");
  await Promise.all([
    s.removeOrgMember("u1", o2.id, "u2").catch(() => null),
    s.addOrgMember("u2", o2.id, "u3").catch(() => null),
  ]);
  const after2 = await s.getOrg(o2.id, "u1");
  assert.ok(!after2.members.some((m) => m.member_id === "u2"), "the admin was removed");
  assert.equal(new Set(after2.members.map((m) => m.member_id)).size, after2.members.length, "no duplicate members either way");
});

// =====================================================================
// A split that totals 100% on the way in, and does not on the way out.
//
// setStudioSplit checked the total over the array it was handed and then wrote
// through a Map keyed on member_id, so the last entry for a member won and the
// earlier one was discarded AFTER the total had been checked. It also checked
// no share individually. Reproduced 7 Sep 2026 against the running server, all
// three answered 200 and all three persisted:
//
//   POST /social/studios/:id/split
//     [{user-a,6000},{user-a,4000}]  -> 200, persisted a:4000 b:0 — TOTAL 4000
//     [{user-a,20000},{user-b,-10000}] -> 200, a holds 200%, b holds -100%
//     [{user-a,5000.5},{user-b,4999.5}] -> 200, fractional basis points
//
// This method takes a per-studio lock so that validate-and-write is one step;
// the invariant was still breakable by a single well-formed request.
// =====================================================================

/** A studio owned by u1 with u2 and u3 as members. */
async function studioOfThree(s) {
  const st = await s.createStudio("u1", "Split Studio");
  await s.addStudioMember("u1", st.id, "u2");
  await s.addStudioMember("u1", st.id, "u3");
  return st;
}
const totalBps = (studio) => studio.members.reduce((a, m) => a + Number(m.split_bps || 0), 0);

test("a member named twice is refused, rather than silently collapsing the split", async () => {
  const s = svc();
  const st = await studioOfThree(s);
  await s.setStudioSplit("u1", st.id, [{ member_id: "u1", split_bps: 5000 }, { member_id: "u2", split_bps: 5000 }]);

  await assert.rejects(
    () => s.setStudioSplit("u1", st.id, [{ member_id: "u1", split_bps: 6000 }, { member_id: "u1", split_bps: 4000 }]),
    (e) => e.httpStatus === 422 && /appears more than once/.test(e.detail),
  );

  // The refusal must leave the previous, valid split exactly as it was — this
  // used to answer 200 and persist a total of 4000.
  const after = await s.getStudio(st.id, "u1");
  assert.equal(totalBps(after), 10000, "a refused split must not have been half-written");
  assert.equal(after.members.find((m) => m.member_id === "u1").split_bps, 5000);
  assert.equal(after.members.find((m) => m.member_id === "u2").split_bps, 5000);
});

test("no share may be negative or exceed the whole", async () => {
  const s = svc();
  const st = await studioOfThree(s);
  const before = totalBps(await s.getStudio(st.id, "u1"));
  for (const splits of [
    [{ member_id: "u1", split_bps: 20000 }, { member_id: "u2", split_bps: -10000 }],
    [{ member_id: "u1", split_bps: -1 }, { member_id: "u2", split_bps: 10001 }],
  ]) {
    await assert.rejects(
      () => s.setStudioSplit("u1", st.id, splits),
      (e) => e.httpStatus === 422 && /between 0 and 10000/.test(e.detail),
      `${JSON.stringify(splits)} must be refused even though it totals 10000`,
    );
  }
  assert.equal(totalBps(await s.getStudio(st.id, "u1")), before, "nothing was written");
});

test("a basis point is the unit, so a fraction of one is not a share", async () => {
  const s = svc();
  const st = await studioOfThree(s);
  await assert.rejects(
    () => s.setStudioSplit("u1", st.id, [{ member_id: "u1", split_bps: 5000.5 }, { member_id: "u2", split_bps: 4999.5 }]),
    (e) => e.httpStatus === 422 && /whole number of basis points/.test(e.detail),
  );
  await assert.rejects(
    () => s.setStudioSplit("u1", st.id, [{ member_id: "u1", split_bps: "5000" }, { member_id: "u2", split_bps: null }]),
    (e) => e.httpStatus === 422,
    "a string or a null is not a basis point either",
  );
});

test("a split refused for any reason leaves the stored split untouched", async () => {
  // Each refusal is driven against a studio that already holds a VALID split,
  // so a partial write shows up as a total that is no longer 10000.
  const s = svc();
  const st = await studioOfThree(s);
  const good = [{ member_id: "u1", split_bps: 4000 }, { member_id: "u2", split_bps: 3000 }, { member_id: "u3", split_bps: 3000 }];
  await s.setStudioSplit("u1", st.id, good);

  const bad = [
    [{ member_id: "u1", split_bps: 6000 }, { member_id: "u1", split_bps: 4000 }],   // duplicate
    [{ member_id: "u1", split_bps: 20000 }, { member_id: "u2", split_bps: -10000 }], // out of range
    [{ member_id: "u1", split_bps: 5000.5 }, { member_id: "u2", split_bps: 4999.5 }],// fractional
    [{ member_id: "u1", split_bps: 5000 }],                                          // does not total
    [{ member_id: "u1", split_bps: 5000 }, { member_id: "stranger", split_bps: 5000 }], // not a member
    [],                                                                              // empty
  ];
  for (const splits of bad) {
    await assert.rejects(() => s.setStudioSplit("u1", st.id, splits), (e) => e.httpStatus === 422);
    const after = await s.getStudio(st.id, "u1");
    assert.equal(totalBps(after), 10000, `${JSON.stringify(splits)} left the studio at ${totalBps(after)}`);
    assert.deepEqual(
      after.members.map((m) => [m.member_id, m.split_bps]).sort(),
      [["u1", 4000], ["u2", 3000], ["u3", 3000]].sort(),
    );
  }
});

test("a body shaped for the OTHER split validator is told which shape this one takes", async () => {
  // src/cw1/identity-studio.mjs validateSplit takes [{ user_id, pct }] and
  // totals to 100. Sent here, every split_bps read as absent, so the refusal
  // said "got 0" for a body that plainly named 100% — a message that sends the
  // reader looking in the wrong place entirely.
  const s = svc();
  const st = await studioOfThree(s);
  await assert.rejects(
    () => s.setStudioSplit("u1", st.id, [{ user_id: "u1", pct: 50 }, { user_id: "u2", pct: 50 }]),
    (e) => e.httpStatus === 422
      && /split_bps/.test(e.detail)
      && e.meta.expected_shape === "[{ member_id, split_bps }]"
      && e.meta.received_keys.includes("pct")
      && e.meta.received_keys.includes("user_id")
      && e.meta.got_total_bps === 0,
    "the refusal must name the shape it wanted and the keys it was given",
  );
});

test("a valid split still applies, and still zeroes anyone left out", async () => {
  // The control. If this stops passing, the checks above have stopped being
  // checks and started being a wall.
  const s = svc();
  const st = await studioOfThree(s);
  const after = await s.setStudioSplit("u1", st.id, [{ member_id: "u1", split_bps: 7000 }, { member_id: "u3", split_bps: 3000 }]);
  assert.equal(totalBps(after), 10000);
  assert.equal(after.members.find((m) => m.member_id === "u2").split_bps, 0, "a member left out of the split holds none of it");
  // 0 and 10000 are both legal shares at the boundary.
  const edge = await s.setStudioSplit("u1", st.id, [{ member_id: "u1", split_bps: 10000 }, { member_id: "u2", split_bps: 0 }]);
  assert.equal(totalBps(edge), 10000);
});
