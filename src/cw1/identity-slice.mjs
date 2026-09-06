// CW1 Identity — CANONICAL SLICE for _SHARED_Day0/mock-server.mjs (manager ruling: do (a)).
// Drop-in merge: in the shared mock, import this and call handleIdentity(req,res,ctx) FIRST in the
// router; if it returns true it handled the request, else fall through to the shared routes.
// This is the identity slice that "wins" per the ruling — richer than the Day0 stub.
//
// Zero deps. The shared mock keeps its world/netcode/save routes.
//
// This slice now OWNS NO LIVE ROUTE. It is a retirement table: every path it
// once served is answered with a 410 that names the durable surface which
// answers the same question. Two rounds got it here —
//   * friends, parties, teams, studios and orgs were process-local Maps while
//     /social/* served the same objects durably: two stores for one concept.
//     See RETIRED_SOCIAL.
//   * /me, /profile/:id, /subscriptions, /publish/check, /identity/portable and
//     /invite read a SEEDED DEMO STORE that no real principal is a key in, so
//     they 500ed, 404ed, or served fabricated fixtures — one of them to an
//     unauthenticated caller. See RETIRED_IDENTITY.
//
// createIdentityStore() survives because src/cw1/db.mjs seeds its in-memory
// fallback repo from it. Nothing in this file reads it any more.

// identity-core and identity-studio are deliberately NOT imported any more.
// The only routes that used computeLevel/buildMe/canPublish/publishCredits and
// portableIdentity are retired below, and every one of them fed those pure
// functions a row out of a seeded demo store. src/core/social.mjs calls the
// same identity-core rules over the DURABLE profile row, which is where the
// level and the publish allowance are now computed exactly once.
// createVerificationStore is deliberately NOT imported any more: the slice's own
// /verify/:channel/{start,confirm} handler is gone, so the module-level store it
// built was a third in-memory challenge store that nothing could read. An unused
// store is one a future route can start writing to by accident, which is exactly
// how the duplication above happened. Verification now lives entirely in
// src/core/verification.mjs, behind the routes at server.mts:783 and 791.

// ---- identity store (merge into the shared mock's db, or keep namespaced) ----
// NOTE: friends/parties/teams/studios/orgs are no longer read or written by any
// route in this file — the routes below are retired. They remain on the shape
// only because src/cw1/db.mjs seeds its in-memory fallback repo from this
// factory. Deleting them would break that fallback silently; db.mjs is where
// that store is now described and announced.
export function createIdentityStore() {
  return {
    users: new Map([
      ["u_dk", { id:"u_dk", name:"Deepak Dudi", email_verified:true, phone_verified:true, atlas_score:72, dcs_plus:true, active_players:240, reports:0, is_studio:true, target_exam_year:null, published_count:3 }],
      ["u_kanya", { id:"u_kanya", name:"Kanya R", email_verified:true, phone_verified:false, atlas_score:30, dcs_plus:false, active_players:4, reports:0, published_count:1 }],
      ["u_new", { id:"u_new", name:"New Player", email_verified:false, atlas_score:0, dcs_plus:false, published_count:0 }]
    ]),
    profiles: new Map([
      ["u_dk", { id:"u_dk", avatar_url:null, bio:"Founder. Builder.", achievements:["Pioneer","Verified"], worlds:3, followers:1284, following:312 }],
      ["u_kanya", { id:"u_kanya", avatar_url:null, bio:"Horror co-op main.", achievements:["Untouchable"], worlds:1, followers:86, following:140 }]
    ]),
    friends: [], parties: new Map(), teams: new Map(),
    studios: new Map([["std_dk", { id:"std_dk", name:"NovaStudio", owner:"u_dk", members:[{id:"u_dk",role:"owner"}], worlds:["w_blackout"], split:null }]]),
    orgs: new Map(),
    subscriptions: new Map([["u_dk", { plan:"dcs_plus", status:"active", renews_at:"2026-07-01", _shadow:true }]]),
    invites: new Map(), seq: 0
  };
}

// ---- RETIRED: the process-local social half of this slice ----------------------
//
// friends, parties, teams, studios and orgs were served from here out of the
// Maps on createIdentityStore(), while src/core/social.mjs served the SAME four
// objects durably at /social/*. Two stores for one concept, and they disagreed
// on every single write. Reproduced 6 Sep 2026 against the real server:
//
//   POST /friends {id:bob}   -> 200, then GET /social/friends -> []
//   POST /social/friends     -> 201, then GET /friends        -> only bob
//   POST /studios            -> 200 std_X, GET /social/studios/std_X -> 404
//   POST /social/studios     -> 201 std_Y, GET /studios/std_Y        -> 404
//   restart -> /social/* returns everything; /friends, /parties/:id,
//              /teams/:id and /studios/:id return empty or 404.
//
// So a tester who used the wrong path lost their data at the next restart and
// had no way to tell which surface was the real one. That is the same failure
// Round-2 found and the reason /social/* was built.
//
// Two of these were also authorisation holes, which is why they are retired
// rather than merely deprecated:
//   * GET /studios/:id and GET /parties/:id never called who(req) at all, so
//     they answered an UNAUTHENTICATED caller with a studio (revenue split
//     included) or a party roster. Verified: `curl` with no Authorization
//     header returns 200 with the std_dk fixture. /social/studios/:id returns
//     401 for the same request.
//   * POST /teams could create a team that no route in the estate could ever
//     read back — the slice has no GET /teams/:id and server.mts has none
//     either, so /teams was a write-only store.
//
// Retired the way the CW6 economy routes were: 410 Gone naming the replacement,
// so a caller still on the old path is told where to go instead of being handed
// a silent 404 or, worse, a second set of books. The replacement must live at a
// DIFFERENT path for that to work — see the /verify note below for what happens
// when it does not.
// Exported so server.mts's /health `routes.retired` list can be generated from the
// same table the guard uses. A hand-copied list drifts; this one cannot.
export const RETIRED_SOCIAL = {
  friends: { superseded_by: "/social/friends",
    detail: "this endpoint kept friendships in a process-local map that /social/friends could not see and a restart erased; use /social/friends" },
  parties: { superseded_by: "/social/parties",
    detail: "this endpoint kept parties in a process-local map that /social/parties could not see, a restart erased, and GET /parties/:id served to an unauthenticated caller; use /social/parties" },
  teams:   { superseded_by: "/social/teams",
    detail: "this endpoint kept teams in a process-local map that /social/teams could not see, a restart erased, and that no route could read back; use /social/teams" },
  studios: { superseded_by: "/social/studios",
    detail: "this endpoint kept studios in a process-local map that /social/studios could not see, a restart erased, and GET /studios/:id served the studio and its split to an unauthenticated caller; use /social/studios" },
  // SECURITY (6 Sep 2026): POST /orgs/:id/members checked SEATS but not
  // PERMISSION, so anyone could add themselves to any org and then read it, and
  // GET /orgs/:id served the whole org unauthenticated. The store was also
  // in-memory with no tables behind it. Replaced by /social/orgs, which is
  // durable and checks the caller's role. Wording preserved from the original
  // retirement so anything pinned to it keeps passing.
  orgs:    { superseded_by: "/social/orgs",
    detail: "this endpoint did not check who was calling; use /social/orgs" },
};

// ---- RETIRED: the fixture-backed half of this slice -----------------------------
//
// Everything below was served out of createIdentityStore()'s seeded Maps —
// u_dk "Deepak Dudi" with atlas_score 72 and an active dcs_plus row, u_kanya,
// u_new. Those ids are demo fixtures. A real principal id (a Supabase user id,
// or the `sub` of a locally signed token) is NEVER a key in them, so on the
// running server these routes did one of three things, none of which is a
// service:
//
//   POST /publish/check   -> 500 "Cannot read properties of undefined
//                            (reading 'dcs_plus')"   [reproduced 7 Sep 2026]
//   GET  /identity/portable -> 500 "Cannot set properties of undefined
//                            (setting 'level_cache')" [reproduced 7 Sep 2026]
//   GET  /me              -> 404 for every principal that will ever call it
//   GET  /subscriptions   -> a second answer to a question /me/subscription
//                            already answers durably
//   GET  /profile/:id     -> 200, TO AN ANONYMOUS CALLER, with the fixture:
//                            {"id":"u_dk","bio":"Founder. Builder.",
//                             "followers":1284,"following":312}
//   POST /invite          -> 200 and a join URL, written into db.invites, which
//                            NO route in this estate reads. A write-only store.
//
// The /profile/:id case is the same authorisation hole GET /studios/:id and
// GET /parties/:id were retired for above: it never called who(req) at all.
// The /publish/check case is worse than a crash — had the store been populated
// it would have computed a publish allowance from fixture signals while
// /me/profile computes the SAME allowance from the durable profile row, which
// is the two-books defect this file was cleaned up for, applied to the gate
// that decides who may publish to the public.
//
// So they are retired the same way, with a 410 that names the durable surface
// that answers the same question for real. Keyed on the exact path (or its
// first segment for /profile/:id) rather than a prefix scan, so a future
// /identity/something is a plain 404 and not a silent inheritance of this
// retirement.
export const RETIRED_IDENTITY = {
  "/me": {
    superseded_by: "/me/profile",
    // `private` = this route demanded a principal before it was retired. Those
    // keep answering 401 to an anonymous caller ahead of the 410, so retiring a
    // private surface does not turn it into an anonymous route-existence
    // oracle. test/route-authz.test.mjs pins that ordering for /subscriptions.
    private: true,
    detail: "this endpoint read a seeded demo store that no real principal is a key in, so it answered 404 to every caller it will ever have; use /me/profile, which is built from the durable profile row",
  },
  "/profile": {
    superseded_by: "/profiles/:username",
    private: false,
    detail: "this endpoint served a hardcoded demo profile (bio, follower and following counts that were never measured) to an unauthenticated caller and never checked who was asking; use /profiles/:username, which serves the durable profile and no private field",
  },
  "/subscriptions": {
    superseded_by: "/me/subscription",
    private: true,
    detail: "this endpoint kept plans in a process-local map seeded with an active dcs_plus row, so it reported a subscription that no service had granted while /me/subscription reported the real one; use /me/subscription to read a plan and POST /v3/subscriptions/subscribe to attempt one, which refuses honestly because no payment provider is integrated",
  },
  "/publish/check": {
    superseded_by: "/me/profile",
    private: true,
    detail: "this endpoint computed the publish gate from a seeded demo store and threw a 500 for every real principal; the same gate, computed from the durable profile, is on /me/profile as can_publish and publish_credits",
  },
  "/identity/portable": {
    superseded_by: "/atlas/key and /atlas/receipt/:id",
    private: true,
    // Deliberately NOT pointed at a portable-identity endpoint: there is not
    // one. Naming a replacement that does not exist would be the same dishonesty
    // as the 500 it replaces.
    detail: "this endpoint built a portable identity from a seeded demo store and threw a 500 for every real principal. There is no durable portable-identity route yet; what is real today is the signed attestation a third party can verify without trusting us — GET /atlas/key for the public key and GET /atlas/receipt/:id for a receipt — and /me/profile for the computed level",
  },
  "/invite": {
    superseded_by: "/social/friends",
    private: true,
    detail: "this endpoint minted an invite token into a process-local map that no route in this estate ever reads and a restart erased, and handed back a join URL that resolves to nothing; to add someone, use POST /social/friends, which is durable and readable back",
  },
};

/**
 * handleIdentity(req, res, ctx) -> boolean
 *   ctx = { send, who }  — `db` and `body` are still accepted for call-site
 *   compatibility but no longer read: there is no live route left to read them.
 *   returns true if this slice handled the route, false to fall through to shared routes.
 */
export async function handleIdentity(req, res, ctx) {
  const { send, who } = ctx;
  const url = new URL(req.url, "http://x");
  const path = url.pathname, m = req.method;
  const seg = path.split("/").filter(Boolean);

  // auth
  // auth — RETIRED.
  //
  // These took the principal id and display name FROM THE REQUEST BODY with no
  // credential of any kind, so an anonymous caller could create or rename any
  // principal's identity record: POST /auth/login {id:"user-owner",name:"PWNED"}
  // answered 200, and that principal's own /me — presented with their real,
  // valid token — then returned the attacker's name.
  //
  // They also returned `{token: <that id>}`, which is not a credential: present
  // it and the real resolver answers 401 "malformed token". A client that
  // treated that field as a session token was broken by design.
  if (path === "/auth/login" || path === "/auth/signup" || path === "/auth/ensure") {
    send(res, 410, {
      ok: false, error: "gone",
      detail: "This route accepted a principal id from the request body with no credential, so anyone could create or rename anyone's identity record. It also returned an id where a token belongs, which never authenticated anything.",
      superseded_by: "the Supabase-backed /auth/signup and /auth/login in server.mts; every private route authenticates through src/core/principal.mjs",
    });
    return true;
  }
  // /me, /profile/:id, /subscriptions, /publish/check, /identity/portable and
  // /invite — RETIRED (see RETIRED_IDENTITY above). One guard for all six, so
  // the retirement notice and the behaviour come from one table.
  //
  // Matched on the WHOLE path, not a prefix — unlike the social guard, which
  // keys on the first segment. It has to be: /me/profile and /me/subscription
  // are the durable replacements and live one segment under a retired path, so
  // a prefix match here would retire the very routes this table points at.
  // /profile/:id is the one exception, because its id is a path segment; note
  // that /profiles/:username is a different first segment and is untouched.
  //
  // Method-agnostic apart from OPTIONS, so a retired route cannot be half-alive
  // on a verb its retirement notice did not mention.
  {
    const key = seg[0] === "profile" ? "/profile" : path;
    const r = RETIRED_IDENTITY[key];
    if (r && m !== "OPTIONS") {
      // A private route stays private: resolve the principal first, so an
      // anonymous caller is refused rather than told which private surfaces
      // this deployment once had.
      if (r.private) who(req);
      send(res, 410, { ok:false, error:"gone", detail:r.detail, superseded_by:r.superseded_by });
      return true;
    }
  }

  // friends / parties / teams / studios / orgs — RETIRED (see RETIRED_SOCIAL above).
  // One guard, so a new sub-path under any of these concepts cannot quietly
  // resurrect the second store by being added below.
  if (RETIRED_SOCIAL[seg[0]] && m !== "OPTIONS") {
    const r = RETIRED_SOCIAL[seg[0]];
    send(res, 410, { ok:false, error:"gone", detail:r.detail, superseded_by:r.superseded_by });
    return true;
  }

  // verification (P2) — the retirement notice that ATE ITS OWN REPLACEMENT.
  //
  // SECURITY (6 Sep 2026): this slice's /verify/:channel/{start,confirm} handler
  // returned the verification code in its own response body as `_devCode`, so
  // any authenticated user could verify their own address without receiving
  // anything. That handler was deleted, correctly. What was left behind was a
  // 410 ON THE SAME PATH, whose superseded_by named "/verify/:channel/start" —
  // the exact path it was refusing.
  //
  // handleIdentity runs at server.mts:414. The REAL P2 routes are at
  // server.mts:783 and 791, after it. So the retirement notice sat in front of
  // its own replacement and the replacement was never reached. Reproduced
  // 7 Sep 2026 against a booted server:
  //
  //   POST /verify/email/start   -> 410 "...use POST /verify/email/{start,confirm}
  //                                 on the current service"   <- this request
  //   POST /verify/email/confirm -> 410, same
  //   DELETE /verify/email       -> 404 "a verified email not found"  <- the real
  //                                 service, reachable on every verb EXCEPT the
  //                                 two the notice sat on
  //   GET  /verify/status        -> 200, the real service
  //
  // start and confirm are the only ways to CREATE a verification, so
  // src/core/verification.mjs — a whole service with a provider seam, hashed
  // codes, rate limits, attempt caps and destination masking — was unreachable
  // over HTTP. email_verified could never become true; computeLevel reads it as
  // the gate for `builder` and `publisher`, so every principal was pinned at
  // `explorer` with one publish credit. Masked only because no delivery provider
  // is configured today; the moment staging gets one, the route still 410s.
  //
  // There is nothing here to retire any more. The dangerous handler is gone, and
  // a retirement must never occupy the path of the thing that replaced it, so
  // this falls through to the live routes. /health's routes.identity has been
  // advertising them as live all along.

  return false; // not an identity route — let the shared mock handle it
}

/**
 * Every route this slice has retired, in the shape server.mts's /health
 * `routes.retired` array already uses. Derived from the two retirement tables
 * so the advertisement and the behaviour cannot drift apart.
 *
 * The name says "social" because server.mts spreads this call into
 * `routes.retired` and server.mts belongs to another lane; it must therefore
 * carry the WHOLE retired surface of this slice, or /health under-reports it
 * and a caller reading /health cannot tell that /publish/check is gone.
 */
export function retiredSocialRoutes() {
  return [
    ...Object.keys(RETIRED_SOCIAL).map(
      (k) => `ALL /${k}/* on the legacy identity slice (410 -> ${RETIRED_SOCIAL[k].superseded_by})`,
    ),
    ...Object.keys(RETIRED_IDENTITY).map(
      (k) => `ALL ${k === "/profile" ? "/profile/:id" : k} on the legacy identity slice (410 -> ${RETIRED_IDENTITY[k].superseded_by})`,
    ),
  ];
}
