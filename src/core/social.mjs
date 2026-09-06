// B15 — recovering the BUILT_DARK social capabilities with real persistence.
//
// Round-2 found profiles, friends, parties, teams and studios all reachable but
// backed by a process-local Map seeded with three fixture users, so anything a
// tester did vanished on restart. It also found a column conflict that would
// have broken the first real friend request: the running code wrote
// dcsgames_friends(a_id, b_id) while the production table declared in the
// lineage baseline has (user_id, friend_id).
//
// This module is the durable replacement. It uses the BASELINE column names,
// because those are what production actually has, and every write survives a
// restart. Money stays dark: a studio may record a revenue split, and that split
// never settles anything.
//
// Round-3 closed two holes in it:
//
//   * A live block stopped a friend REQUEST (checked at the route) and nothing
//     else. acceptFriend had no block check at all and party join had none
//     either, so a request made before a block could be accepted after it. The
//     check now lives here, on every path, and cannot be switched off.
//
//   * me() hardcoded dcs_plus:false, so a comped internal tester read as free
//     here and as DCS Plus in subscriptions.entitlementsFor(). The real status
//     is now an injected, optional dependency — and the entitlement fact
//     (dcs_plus_effective) is kept strictly apart from the money fact
//     (dcs_plus_paid, always false).
//
// Round-4 closed two more, both of them a CLASS rather than an instance:
//
//   * CHECK-THEN-WRITE. Every capacity and uniqueness rule in here was decided
//     from an unlocked read and then written by a locked write, so the lock
//     protected the write and nothing protected the decision. Measured: a party
//     with max_size 2 held 9 members after 8 concurrent joins, a 2-seat org held
//     9, and 16 concurrent friend requests wrote 16 rows for one pair. See the
//     note on the locks below for how each shape is now closed and why.
//
//   * OPEN READS. getParty and getTeam took no requester and checked nothing, so
//     anyone holding an id — with no credential at all — got the full member
//     list, the owner's principal id and the world, invite-only parties
//     included. They now take a requesterId, as getOrg already did.
import crypto from "node:crypto";
import path from "node:path";
import { Errors } from "./errors.mjs";
import { createCollection, describeCollections } from "./collection.mjs";
import { createKeyedMutex } from "./mutex.mjs";
import { createSafetyService } from "./safety.mjs";
import { computeLevel, publishCredits, canPublish } from "../cw1/identity-core.mjs";

/** The longest single play session that will be believed from a client, in
 *  seconds (4 hours). Nothing on this estate times a session server-side. */
const MAX_SESSION_SECONDS = 4 * 60 * 60;

const FRIEND_STATES = ["requested", "accepted", "blocked"];
const TEAM_ROLES = ["owner", "admin", "member"];
const STUDIO_ROLES = ["owner", "admin", "creator", "member"];
const ORG_ROLES = ["owner", "admin", "member"];

const id = (p) => p + "_" + crypto.randomBytes(6).toString("hex");

/**
 * @param {object} [env]
 * @param {object} [deps]
 * @param {(a:string,b:string)=>Promise<boolean>} [deps.isBlocked]
 *        The block check. Omit it and the real safety service over the same env
 *        is used; it CANNOT be switched off — see the note below.
 * @param {{isBlocked?:Function}} [deps.safety]  a safety service, as an alternative
 * @param {{statusFor:Function}} [deps.subscriptions]
 *        Optional. Absent means "no subscription service is wired", which reads
 *        exactly as it did before: free plan, no entitlement, no crash.
 */
export function createSocialService(env = process.env, deps = {}) {
  const dir = path.join(env.DCS_DATA_DIR || path.join(process.cwd(), ".dcs-data"), "social");
  // Supabase primary when configured, atomic local file always. Without this the
  // data survived a restart but not a redeploy, because a container disk is
  // ephemeral unless a volume is mounted.
  const mk = (name, table, primaryKey) => createCollection({ dir, name, table, primaryKey, env });
  const principals = mk("principals", "dcsgames_principals", ["principal_id"]);
  const friends = mk("friends", "dcsgames_principal_friends", ["user_id", "friend_id"]);   // the canonical columns
  const parties = mk("parties", "dcsgames_parties", ["id"]);
  const partyMembers = mk("party_members", "dcsgames_party_members", ["party_id", "member_id"]);
  const teams = mk("teams", "dcsgames_teams", ["id"]);
  const teamMembers = mk("team_members", "dcsgames_team_members", ["team_id", "member_id"]);
  const studios = mk("studios", "dcsgames_studios", ["id"]);
  const studioMembers = mk("studio_members", "dcsgames_studio_members", ["studio_id", "member_id"]);
  const orgs = mk("orgs", "dcsgames_orgs", ["id"]);
  const orgMembers = mk("org_members", "dcsgames_org_members", ["org_id", "member_id"]);
  const plays = mk("world_plays", "dcsgames_world_plays", ["id"]);
  const ratings = mk("world_ratings", "dcsgames_world_ratings", ["world_id", "principal_id"]);
  const collections = { principals, friends, parties, partyMembers, teams, teamMembers, studios, studioMembers, orgs, orgMembers, plays, ratings };

  const has = (k) => deps != null && Object.prototype.hasOwnProperty.call(deps, k);

  // ==================================================== check-then-write, ended
  //
  // Round-4 (Lane J's sweep) measured the class this module was full of: a rule
  // is decided from an UNLOCKED read and then written by a locked write, so the
  // lock protects the write and nothing protects the decision. Every concurrent
  // caller reads the same "there is room" / "there is no row yet" and all of
  // them proceed. Measured: a party with max_size 2 held 9 members after 8
  // concurrent joins, an org with 2 seats held 9, and 16 concurrent friend
  // requests wrote 16 rows for a pair whose primary key is (user_id, friend_id).
  //
  // Two tools close it, and which one applies depends on where the rule lives:
  //
  //   * WITHIN ONE COLLECTION — "is this row already here, and is there room for
  //     it?" — createCollection.ensure(pred, build) is exactly right and needs no
  //     help. build() runs while the collection's write lock is HELD, and reads
  //     are never locked, so a count taken inside build() sees the rows ensure()
  //     is about to append to and no concurrent insert can land between the two.
  //     A capacity test IS expressible as an ensure(): throw from build() when
  //     the count is at the limit. That is not a narrowed window — it is the same
  //     critical section.
  //
  //   * ACROSS TWO COLLECTIONS — "members of THIS party against max_size on the
  //     PARTY row", "members against seats while the owner is resizing the org" —
  //     ensure() alone cannot serialise, because the two rows live under two
  //     different locks. Those paths take a per-object lock as well, keyed by the
  //     party/org/studio id, so the pair of writes is one critical section.
  //
  // Lock ORDER is always object lock -> collection lock, never the reverse, so
  // the two can never deadlock against each other. The scope is the same one
  // mutex.mjs states plainly: one process. Two server instances sharing a
  // directory still need the database to hold these constraints.
  const withObjectLock = createKeyedMutex();
  const partyLock = (partyId, fn) => withObjectLock("party:" + partyId, fn);
  const orgLock = (orgId, fn) => withObjectLock("org:" + orgId, fn);
  const studioLock = (studioId, fn) => withObjectLock("studio:" + studioId, fn);

  // ============================================================ the block check
  //
  // Round-3: POST /social/friends checked safety.isBlocked at the ROUTE, and
  // nothing else did. So A could request B, B could block A, and B (or A) could
  // still accept — the pending row survived the block and either side could turn
  // it into a friendship. Party join had no check at all. A guard that lives on
  // one route out of three is not a guard; it is a habit that the next caller
  // will not share.
  //
  // So it lives in the service, and it is REQUIRED rather than optional: there
  // is no way to construct a social service that has no block check. Passing an
  // explicit non-function is a startup error, not a silent skip, because
  // "optional and quietly absent" is how the hole above was drilled. Omitting it
  // binds the real safety service over the same env, which is the same durable
  // store the rest of the estate blocks into.
  let injectedIsBlocked = null;
  if (has("isBlocked") || has("safety")) {
    const raw = has("isBlocked")
      ? deps.isBlocked
      : (deps.safety && typeof deps.safety.isBlocked === "function" ? (a, b) => deps.safety.isBlocked(a, b) : deps.safety);
    if (typeof raw !== "function") {
      throw Errors.validation(
        "a block check is required: pass deps.isBlocked(a, b) or deps.safety with an isBlocked method. It cannot be disabled — omit it entirely to use the real safety service.",
      );
    }
    injectedIsBlocked = raw;
  }
  let ownSafety = null;
  const blockCheck = () => {
    if (injectedIsBlocked) return injectedIsBlocked;
    // Built on first use so a service that never touches friends or parties does
    // not create the safety store as a side effect of construction.
    ownSafety = ownSafety || createSafetyService(env);
    return (a, b) => ownSafety.isBlocked(a, b);
  };

  /**
   * Blocked in EITHER direction. safety.isBlocked is already symmetric, but this
   * asks both ways anyway: an injected check that only looks one way would
   * otherwise let the blocker befriend the person they blocked.
   */
  async function isBlockedEitherWay(a, b) {
    if (!a || !b || a === b) return false;
    const check = blockCheck();
    return !!(await check(a, b)) || !!(await check(b, a));
  }

  /**
   * What happens to the stale row.
   *
   * A pending request that can never be accepted must not sit in the
   * recipient's incoming list forever — the recipient's own block is what put it
   * there, and the product would be telling them "someone you blocked wants to
   * be your friend" indefinitely. So the row between the two is DELETED on
   * discovery, whatever its status: a block also ends an existing friendship,
   * which is what a user blocking someone means by it.
   *
   * It is deleted rather than rewritten as status:'blocked'. The block lives in
   * the safety service, which is the authority on it; a second copy here would
   * outlive an unblock and would then silently refuse a later, legitimate
   * request that safety would have allowed.
   */
  async function dropFriendRowsBetween(a, b) {
    return await friends.remove((f) =>
      (f.user_id === a && f.friend_id === b) || (f.user_id === b && f.friend_id === a));
  }

  /** True (and the stale rows are gone) if these two are blocked. Never throws. */
  async function purgeIfBlocked(a, b) {
    if (!(await isBlockedEitherWay(a, b))) return false;
    await dropFriendRowsBetween(a, b);
    return true;
  }

  /** The refusal, for the write paths. */
  async function refuseIfBlocked(a, b, action) {
    if (await purgeIfBlocked(a, b)) {
      throw Errors.forbidden("this relationship is blocked", { meta: { action } });
    }
  }

  // ========================================================== subscription facts
  //
  // Round-3: me() hardcoded dcs_plus:false, so a comped internal tester's
  // profile reported the free allowance of 1 publish credit while
  // subscriptions.entitlementsFor() reported 10 for the same principal. Two
  // answers to one question is worse than either answer.
  //
  // The two facts are kept apart and separately named everywhere below:
  //   dcs_plus_effective — this principal has the entitlements;
  //   dcs_plus_paid      — money changed hands. ALWAYS false. There is no PSP,
  //                        so nothing here can ever set it, and a comped
  //                        test grant must never read as revenue.
  const subscriptions = has("subscriptions") ? deps.subscriptions : null;
  if (subscriptions != null && typeof subscriptions.statusFor !== "function") {
    throw Errors.validation("deps.subscriptions must expose statusFor(principal_id)");
  }

  const NO_SUBSCRIPTION = {
    plan: "free", status: "none",
    dcs_plus_effective: false,
    dcs_plus_paid: false,
    comped: false, test_mode: null, expires_at: null,
    degraded: false, paid_claim_rejected: false,
  };

  async function subscriptionFacts(principalId) {
    if (!subscriptions) {
      return { ...NO_SUBSCRIPTION, source: "none", note: "No subscription service is wired here, so no plan is reported." };
    }
    let st;
    try {
      st = await subscriptions.statusFor(principalId);
    } catch (e) {
      // Degrading to the free allowance is the safe direction: it under-grants
      // rather than handing out an entitlement nobody can confirm, and it says
      // so instead of pretending the answer is a real "free".
      return { ...NO_SUBSCRIPTION, degraded: true, source: "unavailable", note: "The subscription service could not be read, so the free allowance is reported. This is a degraded answer, not a confirmed 'free'." };
    }
    const effective = !!st && st.plan === "dcs_plus" && st.active_grant !== false;
    return {
      plan: effective ? "dcs_plus" : "free",
      status: st?.status ?? "none",
      dcs_plus_effective: effective,
      // Never read from the status row. Nothing may set this true.
      dcs_plus_paid: false,
      // A status that claims a purchase is not believed AND not swallowed.
      paid_claim_rejected: !!(st && st.paid),
      comped: !!(st && st.comped),
      test_mode: st?.test_mode ?? null,
      expires_at: st?.expires_at ?? null,
      degraded: false,
      source: effective ? "comped_internal_test_grant" : "none",
      note: effective
        ? "This plan was comped for internal testing. It was not purchased and nobody was charged."
        : "No subscription. Subscribing is not possible: no payment provider is integrated.",
    };
  }

  /** The row a brand-new principal gets. Kept out of ensureProfile so the
   *  find-or-insert around it stays a single atomic step. */
  async function buildProfileRow(principal) {
    const row = {
      principal_id: principal.id,
      username: (principal.email ? String(principal.email).split("@")[0] : principal.id).toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 24) || principal.id,
      display_name: null,
      email: principal.email || null,
      bio: null,
      avatar_color: "#2563FF",
      xp: 0,
      worlds_created: 0,
      worlds_published: 0,
      is_internal_tester: !!principal.isInternalTester,
      created_at: new Date().toISOString(),
    };
    // A username collision must not fail a first login.
    if (await principals.one((p) => p.username === row.username)) row.username = row.username + "_" + crypto.randomBytes(2).toString("hex");
    return row;
  }

  /**
   * The unredacted party and team records.
   *
   * These are INTERNAL. Every path that hands one to a caller goes through
   * svc.getParty / svc.getTeam, which decide what that caller may see. They
   * exist because the service itself legitimately needs the full record for a
   * caller who is NOT yet (or no longer) a member — joinParty must read the
   * membership to run the block check before the joiner is in it, and
   * leaveParty must read it after the leaver is out.
   */
  async function readParty(partyId) {
    const p = await parties.one((x) => x.id === partyId);
    if (!p) throw Errors.notFound(`party ${partyId}`);
    const members = (await partyMembers.find((m) => m.party_id === partyId)).map((m) => m.member_id);
    return { ...p, members, size: members.length };
  }

  async function readTeam(teamId) {
    const t = await teams.one((x) => x.id === teamId);
    if (!t) throw Errors.notFound(`team ${teamId}`);
    return { ...t, members: await teamMembers.find((m) => m.team_id === teamId) };
  }

  const svc = {
    dir,
    /** Where this service is actually persisting, and whether it is degraded. */
    describe: () => describeCollections(collections),

    // ================================================================ profile
    /** Create the profile row on first sight. Idempotent. */
    async ensureProfile(principal) {
      if (!principal?.id) throw Errors.unauthenticated("a profile needs an authenticated principal");
      // Find-or-insert must be ATOMIC. Looking first and then inserting leaves a
      // window that every concurrent caller walks through: 128 simultaneous
      // first sign-ins produced 128 profile rows for the same principal, all of
      // them "successful". A first login is exactly when this happens, because
      // a client that loads several panels at once issues several /me requests.
      const { row: profile } = await principals.ensure(
        (p) => p.principal_id === principal.id,
        async () => await buildProfileRow(principal),
      );
      return profile;
    },


    /**
     * The /me view. Level and publish credits come from the CW1 identity-core
     * rules that already exist rather than a second implementation.
     */
    async me(principal) {
      const p = await svc.ensureProfile(principal);
      // computeLevel takes trust SIGNALS, not counters. Feed it what is actually
      // known: email verification has no provider configured (Round-2 capability
      // 15), so it is false rather than assumed, and atlas_score stays 0 until a
      // real reputation exists. The level is therefore honestly conservative.
      const sub = await subscriptionFacts(p.principal_id);
      const signals = {
        email_verified: !!p.email_verified,
        phone_verified: !!p.phone_verified,
        atlas_score: Number(p.atlas_score || 0),
        // The ENTITLEMENT fact, which is what publishCredits/canPublish read.
        // It used to be hardcoded false, so a comped internal tester was told
        // they had 1 publish credit while entitlementsFor() said 10.
        dcs_plus: sub.dcs_plus_effective,
        dcs_plus_effective: sub.dcs_plus_effective,
        // The MONEY fact, kept separate and always false. Never an input to a
        // level, an allowance or a total.
        dcs_plus_paid: false,
        active_players: Number(p.active_players || 0),
        reports: Number(p.reports || 0),
        is_studio: !!p.is_studio,
      };
      const level = computeLevel(signals);
      const credits = publishCredits({ level, dcs_plus: sub.dcs_plus_effective });
      const gate = canPublish({ level, dcs_plus: sub.dcs_plus_effective, published_count: p.worlds_published });
      return {
        principal_id: p.principal_id,
        username: p.username,
        display_name: p.display_name,
        bio: p.bio,
        avatar_color: p.avatar_color,
        level,
        xp: p.xp,
        worlds_created: p.worlds_created,
        worlds_published: p.worlds_published,
        is_internal_tester: p.is_internal_tester,
        // ONLY the signals that actually determine the level. `signals` also
        // carries the plan, because publishCredits() reads it — but publishing
        // the whole object listed dcs_plus beside five real inputs, so a user
        // could reasonably read "DCS Plus raises my level". It does not: level
        // is trust and gates public reach, the plan is an allowance. The plan's
        // facts are reported under `subscription` below, where they are true.
        level_signals: {
          email_verified: signals.email_verified,
          phone_verified: signals.phone_verified,
          atlas_score: signals.atlas_score,
          active_players: signals.active_players,
          reports: signals.reports,
          is_studio: signals.is_studio,
        },
        // Infinity does not survive JSON, so it is reported as null with an
        // explicit unlimited flag rather than silently becoming zero.
        publish_credits: credits === Infinity ? null : credits,
        publish_credits_unlimited: credits === Infinity,
        can_publish: { ...gate, remaining: gate.remaining === Infinity ? null : gate.remaining, unlimited: gate.remaining === Infinity },
        // The plan, as an entitlement fact. Nothing here is revenue.
        subscription: {
          plan: sub.plan,
          status: sub.status,
          dcs_plus_effective: sub.dcs_plus_effective,
          dcs_plus_paid: false,
          comped: sub.comped,
          test_mode: sub.test_mode,
          expires_at: sub.expires_at,
          source: sub.source,
          degraded: sub.degraded,
          // A status row claiming a purchase is refused rather than copied.
          paid_claim_rejected: sub.paid_claim_rejected,
          note: sub.note,
        },
        // Everything money-shaped is explicitly dark, not merely absent. Note
        // what dcs_plus means HERE: paid. It is false for a comped tester too,
        // because nobody was charged — a comped grant is not revenue and must
        // not be counted as any, in this object or in any total built from it.
        economy: {
          payments_live: false,
          balance_minor: 0,
          dcs_plus: false,
          dcs_plus_paid: false,
          paid_subscriptions: 0,
          revenue_minor: 0,
          note: "money is disabled during controlled internal testing; a comped internal-test grant is not a purchase and is never counted as revenue",
        },
        created_at: p.created_at,
      };
    },

    async updateProfile(principal, patch) {
      await svc.ensureProfile(principal);
      const allowed = ["display_name", "bio", "avatar_color"];
      const changes = {};
      for (const k of allowed) if (patch[k] !== undefined) changes[k] = patch[k] === null ? null : String(patch[k]).slice(0, k === "bio" ? 400 : 60);
      for (const k of Object.keys(patch)) {
        if (!allowed.includes(k)) throw Errors.forbidden(`'${k}' is not editable`, { meta: { editable: allowed } });
      }
      return await principals.update((p) => p.principal_id === principal.id, (p) => ({ ...p, ...changes, updated_at: new Date().toISOString() }));
    },

    /**
     * Record a verification signal. A DEV-MODE verification is stored separately
     * and never counts towards the trust signals computeLevel reads: nobody
     * received anything, so it is not evidence of address ownership.
     */
    async setVerification(principalId, channel, isVerified, devMode = false) {
      await svc.ensureProfile({ id: principalId });
      const field = channel === "email" ? "email_verified" : "phone_verified";
      return await principals.update((p) => p.principal_id === principalId, (p) => ({
        ...p,
        [field]: isVerified && !devMode,
        [`${field}_dev_mode`]: isVerified && devMode ? true : false,
        updated_at: new Date().toISOString(),
      }));
    },

    async publicProfile(username) {
      const p = await principals.one((x) => x.username === String(username).toLowerCase());
      if (!p) throw Errors.notFound(`profile ${username}`);
      // A public profile shows nothing private: no email, no principal id.
      return { username: p.username, display_name: p.display_name, bio: p.bio, avatar_color: p.avatar_color, worlds_published: p.worlds_published, created_at: p.created_at };
    },

    async recordWorldCreated(principalId) {
      return await principals.update((p) => p.principal_id === principalId, (p) => ({ ...p, worlds_created: p.worlds_created + 1, xp: p.xp + 25 }));
    },
    async recordWorldPublished(principalId) {
      return await principals.update((p) => p.principal_id === principalId, (p) => ({ ...p, worlds_published: p.worlds_published + 1, xp: p.xp + 100 }));
    },

    // ================================================================ friends
    /**
     * Request a friendship. Canonical columns user_id/friend_id — the live code
     * used a_id/b_id, which does not exist in production.
     */
    async requestFriend(meId, otherId) {
      if (!meId) throw Errors.unauthenticated("a friend request needs an authenticated principal");
      if (!otherId) throw Errors.validation("friend_id is required");
      if (meId === otherId) throw Errors.validation("you cannot befriend yourself");
      // In the service, not only at the route: every path to a friendship goes
      // through a block check now.
      await refuseIfBlocked(meId, otherId, "request_friend");

      // one() then insert() is check-then-write, and the friends table's
      // declared primary key is (user_id, friend_id) — so the duplicates it
      // produced were duplicates of a key the store believes is unique. Measured:
      // 16 concurrent requests wrote 16 rows; locally all 16 survived and the
      // same person appeared 16 times in `outgoing`, while against Supabase
      // collection.write() upserts on that key and 15 vanished. The two backings
      // therefore held genuinely different data, and acceptFriend only ever
      // rewrote the first of them, so the rest stayed "requested" forever.
      //
      // ensure() collapses the look and the write into one locked step. The
      // predicate is SYMMETRIC, so a crossing request finds the row the other
      // side wrote rather than adding a second one.
      const pair = (f) =>
        (f.user_id === meId && f.friend_id === otherId) || (f.user_id === otherId && f.friend_id === meId);
      const { row: existing, created } = await friends.ensure(pair, () => ({
        user_id: meId, friend_id: otherId, status: "requested",
        created_at: new Date().toISOString(), decided_at: null,
      }));
      if (created) return existing;
      if (existing.status === "blocked") throw Errors.forbidden("this relationship is blocked");
      // They already asked you: accept rather than creating a second row.
      // Deliberately OUTSIDE ensure(): acceptFriend writes to this same
      // collection, and build() may read it but must never write to it.
      if (existing.status === "requested" && existing.user_id === otherId) return await svc.acceptFriend(meId, otherId);
      return { ...existing, idempotent: true };
    },

    /**
     * Accept a pending request. This had NO block check of any kind, so a
     * request made before a block could still be accepted after it, by either
     * side, and the friendship was real.
     */
    async acceptFriend(meId, otherId) {
      if (!meId) throw Errors.unauthenticated("accepting a friend request needs an authenticated principal");
      if (!otherId) throw Errors.validation("friend_id is required");
      await refuseIfBlocked(meId, otherId, "accept_friend");
      // one() then update() was the same check-then-write shape: the row could be
      // removed (or already accepted) between the look and the write, and
      // update() then returned null — which the route reported as ok:true with a
      // null friend. update() finds and rewrites under one lock, so the decision
      // and the write are the same step and "not found" is decided by the write.
      const accepted = await friends.update(
        (f) => f.user_id === otherId && f.friend_id === meId && f.status === "requested",
        (f) => ({ ...f, status: "accepted", decided_at: new Date().toISOString() }),
      );
      if (accepted) return accepted;
      // Losing an accept race is not an error: the friendship exists either way.
      const already = await friends.one((f) =>
        ((f.user_id === otherId && f.friend_id === meId) || (f.user_id === meId && f.friend_id === otherId))
        && f.status === "accepted");
      if (already) return { ...already, idempotent: true };
      throw Errors.notFound(`a pending friend request from ${otherId}`);
    },

    async removeFriend(meId, otherId) {
      const n = await friends.remove((f) =>
        (f.user_id === meId && f.friend_id === otherId) || (f.user_id === otherId && f.friend_id === meId));
      if (!n) throw Errors.notFound("that friendship");
      return { removed: true };
    },

    /** Accepted friends, plus incoming and outgoing requests, each clearly labelled. */
    async friendList(meId) {
      let rows = await friends.find((f) => f.user_id === meId || f.friend_id === meId);
      // Sweep the rows a block has invalidated. A request that can never be
      // accepted is removed here as well as at accept time, so it disappears
      // from the list the moment its owner looks rather than lingering until
      // someone tries to act on it.
      const stale = [];
      for (const f of rows) {
        const other = f.user_id === meId ? f.friend_id : f.user_id;
        if (await purgeIfBlocked(meId, other)) stale.push(other);
      }
      if (stale.length) rows = rows.filter((f) => !stale.includes(f.user_id === meId ? f.friend_id : f.user_id));
      return {
        friends: rows.filter((f) => f.status === "accepted").map((f) => ({ id: f.user_id === meId ? f.friend_id : f.user_id, since: f.decided_at })),
        incoming: rows.filter((f) => f.status === "requested" && f.friend_id === meId).map((f) => ({ id: f.user_id, at: f.created_at })),
        outgoing: rows.filter((f) => f.status === "requested" && f.user_id === meId).map((f) => ({ id: f.friend_id, at: f.created_at })),
        // Said out loud: rows dropped because a block now stands between them.
        removed_blocked: stale,
      };
    },

    async areFriends(a, b) {
      // A block ends the friendship, so this must not keep answering true off a
      // row the block should have taken with it.
      if (await purgeIfBlocked(a, b)) return false;
      const row = await friends.one((f) =>
        ((f.user_id === a && f.friend_id === b) || (f.user_id === b && f.friend_id === a)) && f.status === "accepted");
      return !!row;
    },

    // ================================================================ parties
    async createParty(meId, { worldId = null, maxSize = 8, open = true } = {}) {
      if (!meId) throw Errors.unauthenticated("creating a party needs an authenticated principal");
      if (!Number.isInteger(maxSize) || maxSize < 1 || maxSize > 64) throw Errors.validation("max_size must be between 1 and 64");
      const party = { id: id("pty"), leader_id: meId, world_id: worldId, max_size: maxSize, open: !!open, created_at: new Date().toISOString(), closed_at: null };
      await parties.insert(party);
      await partyMembers.insert({ party_id: party.id, member_id: meId, joined_at: party.created_at });
      return { ...party, members: [meId] };
    },

    /**
     * A party, as much of it as this requester may see. A MEMBER gets the whole
     * record; everyone else gets the decision below.
     */
    async getParty(partyId, requesterId = null) {
      const p = await readParty(partyId);
      if (p.members.includes(requesterId)) return p;
      // Round-4 (Lane L): getParty took no requester at all, so server.mts:717 —
      // which has no mustBe either — handed an anonymous caller with an id the
      // full member list, the leader's principal id and the world the party is
      // in, INCLUDING for a party created with open:false, the estate's own
      // marker for "invite only". The same sprint closed exactly this on orgs by
      // giving getOrg a requesterId; this is that check, on parties.
      //
      // An INVITE-ONLY party is private, full stop: refused, as an org is.
      if (!p.open) {
      // Same answer as a thing that does not exist. A 403 here confirms the id
      // is real to somebody who may not see it — the existence oracle already
      // closed on worlds and on retained versions, one surface along.
        throw Errors.notFound(`party ${partyId}`, {
          meta: { action: "get_party", party_id: partyId },
        });
      }
      // An OPEN party is one anyone may join, so its existence and whether it has
      // room are legitimately public — that is what a join button needs. WHO is
      // in it is not: no member list, no leader id, no world id leaves here.
      return {
        id: p.id,
        open: true,
        closed_at: p.closed_at,
        max_size: p.max_size,
        size: p.size,
        full: p.size >= p.max_size,
        redacted: true,
        note: "This party is open, so its capacity is public. Its member list, leader and world are visible only to its members.",
      };
    },

    async joinParty(meId, partyId) {
      if (!meId) throw Errors.unauthenticated("joining a party needs an authenticated principal");
      // The party lock covers the WHOLE decision, because the capacity rule spans
      // two collections: the member count lives in party_members and max_size
      // lives on the parties row. It also keeps a join from interleaving with the
      // leave that closes the party or hands over the leadership.
      return await partyLock(partyId, async () => {
        const p = await readParty(partyId);
        if (p.closed_at) throw Errors.conflict("this party has closed");
        if (p.members.includes(meId)) return { ...p, idempotent: true };
        // Same answer as a party that does not exist: refusing a join with a
      // distinguishable status confirms the id to someone who may not see it.
      if (!p.open) throw Errors.notFound(`party ${partyId}`);
        // A party is a shared room. Joining one that holds someone you blocked —
        // or who blocked you — puts the two of you back together, which is the
        // thing the block exists to prevent, so it is refused here rather than
        // left to whatever calls joinParty.
        for (const member of p.members) {
          if (await isBlockedEitherWay(meId, member)) {
            await dropFriendRowsBetween(meId, member);
            throw Errors.forbidden(
              "this party includes someone you have blocked, or who has blocked you",
              { meta: { action: "join_party", party_id: partyId } },
            );
          }
        }
        // The capacity decision and the insert are ONE step. build() runs holding
        // the party_members write lock, so the count it takes is the count
        // ensure() is about to append to — no other insert can land between them.
        // Measured before this: 8 concurrent joins put 9 members in a party whose
        // max_size was 2, and every one of them reported success.
        await partyMembers.ensure(
          (m) => m.party_id === partyId && m.member_id === meId,
          async () => {
            const row = await parties.one((x) => x.id === partyId);
            if (!row) throw Errors.notFound(`party ${partyId}`);
            if (row.closed_at) throw Errors.conflict("this party has closed");
            const size = (await partyMembers.find((m) => m.party_id === partyId)).length;
            if (size >= row.max_size) throw Errors.conflict(`this party is full (${size}/${row.max_size})`);
            return { party_id: partyId, member_id: meId, joined_at: new Date().toISOString() };
          },
        );
        return await readParty(partyId);
      });
    },

    async leaveParty(meId, partyId) {
      return await partyLock(partyId, async () => {
        const p = await readParty(partyId);
        if (!p.members.includes(meId)) throw Errors.notFound("your membership of that party");
        await partyMembers.remove((m) => m.party_id === partyId && m.member_id === meId);
        const left = await readParty(partyId);
        // A party with nobody in it is closed rather than left as a ghost row.
        if (left.size === 0) {
          await parties.update((x) => x.id === partyId, (x) => ({ ...x, closed_at: new Date().toISOString() }));
          return { ...left, closed: true };
        }
        // The leader leaving hands over rather than orphaning the party. Read
        // under the same lock as the removal, so the successor is someone who is
        // still a member — two concurrent leaves used to be able to hand the
        // party to the person who had just left it.
        if (p.leader_id === meId) await parties.update((x) => x.id === partyId, (x) => ({ ...x, leader_id: left.members[0] }));
        // The leaver gets the full view of the party they just left: it is the
        // result of their own action, and they already knew who was in it. Same
        // rule removeOrgMember applies to a self-removal.
        return await readParty(partyId);
      });
    },

    async myParties(meId) {
      const mine = await partyMembers.find((m) => m.member_id === meId);
      const out = [];
      for (const m of mine) {
        const p = await parties.one((x) => x.id === m.party_id);
        if (p && !p.closed_at) out.push(await svc.getParty(p.id, meId));
      }
      return out;
    },

    // ================================================================== teams
    async createTeam(meId, name) {
      if (!meId) throw Errors.unauthenticated("creating a team needs an authenticated principal");
      if (!name || String(name).trim().length < 2) throw Errors.validation("a team needs a name of at least 2 characters");
      const team = { id: id("team"), name: String(name).trim().slice(0, 60), owner_id: meId, created_at: new Date().toISOString() };
      await teams.insert(team);
      await teamMembers.insert({ team_id: team.id, member_id: meId, role: "owner", joined_at: team.created_at });
      return { ...team, members: [{ member_id: meId, role: "owner" }] };
    },

    /**
     * A team is private to its members — the same rule as an org, and the same
     * hole this had: the WRITE side checked the caller's role and the READ side
     * checked nothing, so anyone with the id got the name, the owner's principal
     * id and every member row. A team has no "open" state to make public, so
     * unlike a party there is nothing to redact down to.
     */
    async getTeam(teamId, requesterId = null) {
      const t = await readTeam(teamId);
      if (!requesterId || !t.members.some((m) => m.member_id === requesterId)) {
        // Same answer as a thing that does not exist: a 403 confirms the id is real
      // to somebody who may not see it.
      throw Errors.notFound(`team ${teamId}`, {
          meta: { action: "get_team", team_id: teamId },
        });
      }
      return t;
    },

    async addTeamMember(meId, teamId, memberId, role = "member") {
      if (!TEAM_ROLES.includes(role)) throw Errors.validation(`role must be one of: ${TEAM_ROLES.join(", ")}`);
      if (!memberId) throw Errors.validation("member_id is required");
      const t = await svc.getTeam(teamId, meId);
      const mine = t.members.find((m) => m.member_id === meId);
      if (!mine || !["owner", "admin"].includes(mine.role)) throw Errors.forbidden("only an owner or admin can add members");
      if (role === "owner") throw Errors.forbidden("a team has exactly one owner; transfer ownership instead");
      if (t.members.some((m) => m.member_id === memberId)) return { ...t, idempotent: true };
      // (team_id, member_id) is the declared primary key, so two concurrent adds
      // of the same person wrote two rows locally and one against Supabase — the
      // friends defect, one capability along. ensure() makes the look and the
      // insert one step, and the adder's role is re-read INSIDE it so a
      // permission that was revoked while this call was in flight cannot be used.
      const { created } = await teamMembers.ensure(
        (m) => m.team_id === teamId && m.member_id === memberId,
        async () => {
          const still = await teamMembers.one((m) => m.team_id === teamId && m.member_id === meId);
          if (!still || !["owner", "admin"].includes(still.role)) throw Errors.forbidden("only an owner or admin can add members");
          return { team_id: teamId, member_id: memberId, role, joined_at: new Date().toISOString() };
        },
      );
      const after = await svc.getTeam(teamId, meId);
      return created ? after : { ...after, idempotent: true };
    },

    async removeTeamMember(meId, teamId, memberId) {
      const t = await svc.getTeam(teamId, meId);
      const mine = t.members.find((m) => m.member_id === meId);
      const isSelf = meId === memberId;
      if (!isSelf && (!mine || !["owner", "admin"].includes(mine.role))) throw Errors.forbidden("only an owner or admin can remove members");
      if (t.owner_id === memberId) throw Errors.forbidden("the owner cannot be removed; transfer ownership first");
      const n = await teamMembers.remove((m) => m.team_id === teamId && m.member_id === memberId);
      if (!n) throw Errors.notFound("that membership");
      // A member who removed THEMSELVES is no longer a member, so getTeam would
      // now refuse them the answer to their own request. They get the full view
      // of the team they just left, which is what removeOrgMember already does.
      return await readTeam(teamId);
    },

    async myTeams(meId) {
      const mine = await teamMembers.find((m) => m.member_id === meId);
      const out = [];
      for (const m of mine) out.push(await svc.getTeam(m.team_id, meId));
      return out;
    },

    // ================================================================ studios
    async createStudio(meId, name) {
      if (!meId) throw Errors.unauthenticated("creating a studio needs an authenticated principal");
      if (!name || String(name).trim().length < 2) throw Errors.validation("a studio needs a name of at least 2 characters");
      const studio = { id: id("std"), name: String(name).trim().slice(0, 60), owner_id: meId, created_at: new Date().toISOString() };
      await studios.insert(studio);
      await studioMembers.insert({ studio_id: studio.id, member_id: meId, role: "owner", split_bps: 10000, joined_at: studio.created_at });
      return await svc.getStudio(studio.id, meId);
    },

    /**
     * @param requesterId  who is asking. A studio's member list carries each
     *   member's principal id, role and REVENUE SPLIT — the same shape that was
     *   closed on orgs, teams and parties this sprint. A caller who is not a
     *   member gets the same answer as one asking about a studio that does not
     *   exist, so this cannot be used to confirm a studio id either.
     */
    async getStudio(studioId, requesterId = null) {
      const s = await studios.one((x) => x.id === studioId);
      if (!s) throw Errors.notFound(`studio ${studioId}`);
      const members = await studioMembers.find((m) => m.studio_id === studioId);
      if (!requesterId || !members.some((m) => m.member_id === requesterId)) {
        throw Errors.notFound(`studio ${studioId}`);
      }
      return {
        ...s,
        members,
        split_total_bps: members.reduce((a, m) => a + m.split_bps, 0),
        // Recorded, never settled.
        payments_live: false,
        split_note: "revenue splits are recorded for modelling only; no money moves while PAYMENTS_LIVE is false",
      };
    },

    /**
     * The split must total exactly 10000 bps. That invariant is validated from a
     * read and then written as N separate row updates, so two concurrent calls
     * used to interleave into a total that is neither of them: A writing
     * 6000/4000 against B writing 3000/7000 could land 6000/7000 = 13000, and
     * the rule the whole method exists to enforce would be violated by the
     * method itself. The studio lock makes the validate-and-write one step.
     */
    async setStudioSplit(meId, studioId, splits) {
      return await studioLock(studioId, async () => {
      const s = await svc.getStudio(studioId, meId);
        const mine = s.members.find((m) => m.member_id === meId);
        if (!mine || !["owner", "admin"].includes(mine.role)) throw Errors.forbidden("only an owner or admin can configure the split");
        if (!Array.isArray(splits) || !splits.length) throw Errors.validation("splits must be a non-empty array of { member_id, split_bps }");
        const total = splits.reduce((a, x) => a + Number(x.split_bps || 0), 0);
        if (total !== 10000) throw Errors.validation(`splits must total exactly 10000 basis points (100%), got ${total}`);
        for (const x of splits) {
          if (!s.members.some((m) => m.member_id === x.member_id)) throw Errors.validation(`'${x.member_id}' is not a member of this studio`);
        }
        // Every named member is rewritten, and anyone not named is zeroed — a
        // split that leaves an old share standing is a split that does not total
        // 100%. A member added by a concurrent addStudioMember starts at 0, so it
        // cannot break the total either.
        const named = new Map(splits.map((x) => [x.member_id, Number(x.split_bps)]));
        for (const m of s.members) {
          const bps = named.has(m.member_id) ? named.get(m.member_id) : 0;
          if (bps === m.split_bps) continue;
          await studioMembers.update((r) => r.studio_id === studioId && r.member_id === m.member_id, (r) => ({ ...r, split_bps: bps }));
        }
      return await svc.getStudio(studioId, meId);
      });
    },

    async addStudioMember(meId, studioId, memberId, role = "member") {
      if (!STUDIO_ROLES.includes(role)) throw Errors.validation(`role must be one of: ${STUDIO_ROLES.join(", ")}`);
      if (!memberId) throw Errors.validation("member_id is required");
      const s = await svc.getStudio(studioId, meId);
      const mine = s.members.find((m) => m.member_id === meId);
      if (!mine || !["owner", "admin"].includes(mine.role)) throw Errors.forbidden("only an owner or admin can add members");
      if (role === "owner") throw Errors.forbidden("a studio has exactly one owner");
      if (s.members.some((m) => m.member_id === memberId)) return { ...s, idempotent: true };
      // (studio_id, member_id) is the declared primary key, and the same
      // check-then-write shape wrote duplicates of it. The adder's role is
      // re-read inside the atomic step for the same reason as the team above.
      const { created } = await studioMembers.ensure(
        (m) => m.studio_id === studioId && m.member_id === memberId,
        async () => {
          const still = await studioMembers.one((m) => m.studio_id === studioId && m.member_id === meId);
          if (!still || !["owner", "admin"].includes(still.role)) throw Errors.forbidden("only an owner or admin can add members");
          // A new member starts on zero: adding someone must never silently
          // dilute an existing split.
          return { studio_id: studioId, member_id: memberId, role, split_bps: 0, joined_at: new Date().toISOString() };
        },
      );
      const after = await svc.getStudio(studioId, meId);
      return created ? after : { ...after, idempotent: true };
    },

    // =================================================================== orgs
    //
    // Round-2 capability 87: real seat-check logic, an in-memory store and no
    // tables. It also had NO permission check on adding a member -- anyone could
    // add themselves to any org, and then read it. Both are fixed here.

    async createOrg(meId, { name, seats = 5 }) {
      if (!meId) throw Errors.unauthenticated("creating an org needs an authenticated principal");
      if (!name || String(name).trim().length < 2) throw Errors.validation("an org needs a name of at least 2 characters");
      if (!Number.isInteger(seats) || seats < 1 || seats > 1000) throw Errors.validation("seats must be between 1 and 1000");
      const org = { id: id("org"), name: String(name).trim().slice(0, 80), billing_owner: meId, seats, created_at: new Date().toISOString() };
      await orgs.insert(org);
      await orgMembers.insert({ org_id: org.id, member_id: meId, role: "owner", joined_at: org.created_at });
      return await svc.getOrg(org.id, meId);
    },

    /** An org is private to its members. It used to be readable by anyone. */
    async getOrg(orgId, requesterId) {
      const o = await orgs.one((x) => x.id === orgId);
      if (!o) throw Errors.notFound(`org ${orgId}`);
      const members = await orgMembers.find((m) => m.org_id === orgId);
      // `requesterId &&` used to mean an anonymous caller skipped the check
      // entirely — the one case that most needs it. No caller relies on that:
      // every route and every internal path passes a principal.
      if (!requesterId || !members.some((m) => m.member_id === requesterId)) {
        // Same answer as a thing that does not exist: a 403 confirms the id is real
      // to somebody who may not see it.
      throw Errors.notFound(`org ${orgId}`);
      }
      const used = members.length;
      return {
        ...o, members,
        seats_used: used,
        seats_remaining: Math.max(0, o.seats - used),
        // Seats are a capacity limit, not a billing charge: money is dark.
        payments_live: false,
        billing_note: "Seats are enforced as a capacity limit. No seat is billed while payments are disabled.",
      };
    },

    async addOrgMember(meId, orgId, memberId, role = "member") {
      if (!ORG_ROLES.includes(role)) throw Errors.validation(`role must be one of: ${ORG_ROLES.join(", ")}`);
      if (!memberId) throw Errors.validation("member_id is required");
      const o = await svc.getOrg(orgId, meId);
      const mine = o.members.find((m) => m.member_id === meId);
      // The missing check. Without it anyone could add themselves to any org.
      if (!mine || !["owner", "admin"].includes(mine.role)) {
        throw Errors.forbidden("only an owner or admin can add members to an org");
      }
      if (role === "owner") throw Errors.forbidden("an org has exactly one billing owner; transfer ownership instead");
      if (o.members.some((m) => m.member_id === memberId)) return { ...o, idempotent: true };
      // Seats are the only limit an org has, and they were decided from an
      // unlocked read: 8 concurrent adds put 9 members in a 2-seat org, all
      // reporting success, and setOrgSeats then refused to shrink back below the
      // overflow — so the state could not be recovered through the API at all.
      //
      // The org lock is needed as well as ensure(), because the count is in
      // org_members and the limit is on the orgs row: without it the owner could
      // shrink the seat count in the window between the count and the insert.
      return await orgLock(orgId, async () => {
        const { created } = await orgMembers.ensure(
          (m) => m.org_id === orgId && m.member_id === memberId,
          async () => {
            const row = await orgs.one((x) => x.id === orgId);
            if (!row) throw Errors.notFound(`org ${orgId}`);
            // Re-read the adder's own role in the same step: a permission that
            // was revoked while this call was in flight must not be usable.
            const still = await orgMembers.one((m) => m.org_id === orgId && m.member_id === meId);
            if (!still || !["owner", "admin"].includes(still.role)) {
              throw Errors.forbidden("only an owner or admin can add members to an org");
            }
            const used = (await orgMembers.find((m) => m.org_id === orgId)).length;
            if (used >= row.seats) {
              throw Errors.conflict(`this org has no seats left (${used}/${row.seats})`, { meta: { seats: row.seats, used } });
            }
            return { org_id: orgId, member_id: memberId, role, joined_at: new Date().toISOString() };
          },
        );
        const after = await svc.getOrg(orgId, meId);
        return created ? after : { ...after, idempotent: true };
      });
    },

    async removeOrgMember(meId, orgId, memberId) {
      const o = await svc.getOrg(orgId, meId);
      const mine = o.members.find((m) => m.member_id === meId);
      const isSelf = meId === memberId;
      if (!isSelf && (!mine || !["owner", "admin"].includes(mine.role))) {
        throw Errors.forbidden("only an owner or admin can remove members");
      }
      if (o.billing_owner === memberId) throw Errors.forbidden("the billing owner cannot be removed; transfer ownership first");
      const n = await orgMembers.remove((m) => m.org_id === orgId && m.member_id === memberId);
      if (!n) throw Errors.notFound("that membership");
      return await svc.getOrg(orgId, isSelf ? o.billing_owner : meId);
    },

    async setOrgSeats(meId, orgId, seats) {
      if (!Number.isInteger(seats) || seats < 1 || seats > 1000) throw Errors.validation("seats must be between 1 and 1000");
      // Under the same lock addOrgMember takes: a shrink that reads the member
      // count and an add that reads the seat count would otherwise cross, and
      // land an org above the seat limit that both of them had just checked.
      return await orgLock(orgId, async () => {
        const o = await svc.getOrg(orgId, meId);
        if (o.billing_owner !== meId) throw Errors.forbidden("only the billing owner can change the seat count");
        if (seats < o.seats_used) {
          // Silently dropping members to fit a smaller plan would be a data loss.
          throw Errors.conflict(`this org already has ${o.seats_used} members; remove some before reducing to ${seats} seats`);
        }
        await orgs.update((x) => x.id === orgId, (x) => ({ ...x, seats }));
        return await svc.getOrg(orgId, meId);
      });
    },

    async myOrgs(meId) {
      const mine = await orgMembers.find((m) => m.member_id === meId);
      const out = [];
      for (const m of mine) out.push(await svc.getOrg(m.org_id, meId));
      return out;
    },

    // ============================================================== discovery
    /** Record a real play. Discovery ranks on these rows and nothing else. */
    async recordPlay(worldId, principalId, seconds = null) {
      if (!worldId) throw Errors.validation("world_id is required");
      // `seconds` is reported by the client, and progression grants the
      // "hour played" achievement from the total — so an unbounded number here
      // is an achievement anyone can award themselves in one request. It is
      // clamped to a plausible single session and marked as self-reported, so
      // no later reader can mistake it for something the server timed.
      const raw = seconds == null ? null : Number(seconds);
      const clean = raw == null || !Number.isFinite(raw) ? null : Math.min(MAX_SESSION_SECONDS, Math.max(0, Math.round(raw)));
      return await plays.insert({
        id: crypto.randomUUID(), world_id: worldId, principal_id: principalId || null,
        started_at: new Date().toISOString(),
        seconds: clean,
        seconds_self_reported: clean != null,
        seconds_clamped: clean != null && raw > MAX_SESSION_SECONDS,
      });
    },

    async rateWorld(principalId, worldId, rating) {
      if (!principalId) throw Errors.unauthenticated("rating a world needs an authenticated principal");
      if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw Errors.validation("rating must be an integer from 1 to 5");
      if (!worldId) throw Errors.validation("world_id is required");
      // one()-then-update-or-insert is check-then-write against a declared
      // primary key of (world_id, principal_id): two ratings submitted at once by
      // the same player wrote two rows, so worldStats counted one person twice
      // and rating_avg — the number discover() ranks on — was skewed by a double
      // click. upsert() decides and writes under one lock.
      const row = { world_id: worldId, principal_id: principalId, rating, created_at: new Date().toISOString() };
      await ratings.upsert((r) => r.world_id === worldId && r.principal_id === principalId, row);
      return row;
    },

    /** Raw measured rows, for services that compute over them (progression). */
    async allPlays() { return await plays.all(); },
    async allRatings() { return await ratings.all(); },

    /** Measured stats for one world. Zero means zero, never a placeholder. */
    async worldStats(worldId) {
      const p = await plays.find((x) => x.world_id === worldId);
      const r = await ratings.find((x) => x.world_id === worldId);
      const players = new Set(p.map((x) => x.principal_id).filter(Boolean));
      return {
        plays: p.length,
        unique_players: players.size,
        total_seconds: p.reduce((a, x) => a + (x.seconds || 0), 0),
        rating_count: r.length,
        rating_avg: r.length ? Number((r.reduce((a, x) => a + x.rating, 0) / r.length).toFixed(2)) : null,
      };
    },

    /**
     * Browse published worlds. Sorting is over MEASURED activity, so an empty
     * platform ranks everything at zero rather than inventing popularity.
     */
    /**
     * Stats for MANY worlds in one pass.
     *
     * discover() used to call worldStats() per world, and each of those reads
     * the whole plays file and the whole ratings file — so a catalogue of N
     * worlds cost 2N full-file reads. Measured: /v3/discover p50 went 6ms at 1
     * world, 53ms at 12, 220ms at 50, 908ms at 200, and throughput fell 47x.
     * The cliff was catalogue size, not traffic. Both files are now read once
     * and indexed.
     */
    async _statsIndex() {
      const [allPlays, allRatings] = await Promise.all([plays.all(), ratings.all()]);
      const idx = new Map();
      const of = (id) => {
        let e = idx.get(id);
        if (!e) { e = { plays: 0, players: new Set(), total_seconds: 0, rating_sum: 0, rating_count: 0 }; idx.set(id, e); }
        return e;
      };
      for (const x of allPlays) {
        const e = of(x.world_id);
        e.plays++;
        e.total_seconds += x.seconds || 0;
        if (x.principal_id) e.players.add(x.principal_id);
      }
      for (const x of allRatings) {
        const e = of(x.world_id);
        e.rating_sum += x.rating;
        e.rating_count++;
      }
      return (worldId) => {
        const e = idx.get(worldId);
        if (!e) return { plays: 0, unique_players: 0, total_seconds: 0, rating_count: 0, rating_avg: null };
        return {
          plays: e.plays,
          unique_players: e.players.size,
          total_seconds: e.total_seconds,
          rating_count: e.rating_count,
          rating_avg: e.rating_count ? Number((e.rating_sum / e.rating_count).toFixed(2)) : null,
        };
      };
    },

    async discover(worlds, { sort = "recent", genre = null, limit = 24, q = null } = {}) {
      const rows = [];
      const statsFor = await svc._statsIndex();
      for (const w of worlds) {
        const meta = w.manifest?.meta || {};
        // Filter BEFORE building the row: a world excluded by genre or search
        // does not need its stats looked up at all.
        if (genre && String(meta.genre || "").toLowerCase() !== String(genre).toLowerCase()) continue;
        if (q) {
          const hay = `${meta.title || ""} ${meta.description || ""} ${(meta.tags || []).join(" ")}`.toLowerCase();
          if (!hay.includes(String(q).toLowerCase())) continue;
        }
        const stats = statsFor(w.world_id);
        rows.push({
          world_id: w.world_id,
          title: w.title || meta.title || null,
          genre: meta.genre || null,
          maturity: meta.maturity || null,
          tags: meta.tags || [],
          world_version: w.version,
          owner: w.owner_id,
          updated_at: w.updated_at,
          thumbnail_ref: w.manifest?.media?.thumbnail_ref || null,
          thumbnail_is_placeholder: !!w.manifest?.media?.thumbnail_is_placeholder,
          stats,
          // Verification is a fact about a receipt, never a decoration.
          atlas_signed: !!w.manifest?.meta?.atlas_signed,
        });
      }
      const by = {
        recent: (a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")),
        most_played: (a, b) => b.stats.plays - a.stats.plays || String(b.updated_at || "").localeCompare(String(a.updated_at || "")),
        top_rated: (a, b) => (b.stats.rating_avg ?? -1) - (a.stats.rating_avg ?? -1) || b.stats.rating_count - a.stats.rating_count,
      };
      rows.sort(by[sort] || by.recent);
      return {
        count: rows.length,
        sort,
        worlds: rows.slice(0, limit),
        note: rows.every((r) => r.stats.plays === 0)
          ? "No play activity has been recorded yet, so every world ranks equally. These are real zeros, not placeholders."
          : null,
      };
    },
  };

  return svc;
}

export { FRIEND_STATES, TEAM_ROLES, STUDIO_ROLES, ORG_ROLES };
