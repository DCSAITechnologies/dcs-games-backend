// CW1 Identity — CANONICAL SLICE for _SHARED_Day0/mock-server.mjs (manager ruling: do (a)).
// Drop-in merge: in the shared mock, import this and call handleIdentity(req,res,ctx) FIRST in the
// router; if it returns true it handled the request, else fall through to the shared routes.
// This is the identity slice that "wins" per the ruling — richer than the Day0 stub.
//
// Zero deps. Reuses CW1's frozen logic. The shared mock keeps its world/netcode/save routes;
// this owns: /me, /profile/:id, /subscriptions (DARK), /publish/check, /invite,
// /identity/portable, /auth/*.
//
// It no longer owns friends, parties, teams, studios or orgs. Those were served
// here from process-local Maps while /social/* served the same four objects
// durably, so the estate had two stores for one concept — see RETIRED_SOCIAL
// below for what that actually cost and what replaced it.

import { computeLevel, buildMe, canPublish, publishCredits } from "./identity-core.mjs";
import { portableIdentity } from "./identity-studio.mjs";
// createVerificationStore is deliberately NOT imported any more: the only routes
// that used it (/verify/:channel/{start,confirm}) are retired below, so the
// module-level store it built was a third in-memory challenge store that nothing
// could read. An unused store is one a future route can start writing to by
// accident, which is exactly how the duplication above happened.

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
// Retired the way the CW6 economy routes and the legacy /verify/:channel/*
// routes were: 410 Gone naming the replacement, so a caller still on the old
// path is told where to go instead of being handed a silent 404 or, worse,
// a second set of books.
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

/**
 * handleIdentity(req, res, ctx) -> boolean
 *   ctx = { db, send, body, who }  (the shared mock supplies its own helpers; or use the defaults)
 *   returns true if this slice handled the route, false to fall through to shared routes.
 */
export async function handleIdentity(req, res, ctx) {
  const { db, send, body, who } = ctx;
  const url = new URL(req.url, "http://x");
  const path = url.pathname, m = req.method;
  const seg = path.split("/").filter(Boolean);
  const uid = (p) => p + "_" + (++db.seq) + Math.random().toString(36).slice(2,6);

  // auth
  if (path === "/auth/login" || path === "/auth/signup" || path === "/auth/ensure") {
    const b = await body(req); let id = b.id || "u_new";
    if (!db.users.has(id)) db.users.set(id, { id, name:b.name||"New Player", email_verified:false, atlas_score:0, dcs_plus:false, published_count:0 });
    send(res, 200, { token:id, user: buildMe(db.users.get(id)) }); return true;
  }
  if (path === "/me" && m === "GET") { send(res, 200, buildMe(db.users.get(who(req)))); return true; }
  if (seg[0]==="profile" && m==="GET") { const p=db.profiles.get(seg[1]); send(res, p?200:404, p||{error:"not_found"}); return true; }

  // friends / parties / teams / studios / orgs — RETIRED (see RETIRED_SOCIAL above).
  // One guard, so a new sub-path under any of these concepts cannot quietly
  // resurrect the second store by being added below.
  if (RETIRED_SOCIAL[seg[0]] && m !== "OPTIONS") {
    const r = RETIRED_SOCIAL[seg[0]];
    send(res, 410, { ok:false, error:"gone", detail:r.detail, superseded_by:r.superseded_by });
    return true;
  }

  // subscriptions (DARK)
  if (path==="/subscriptions"&&m==="GET") { const me=who(req); send(res,200,db.subscriptions.get(me)||{plan:"free",status:"none",_shadow:true}); return true; }
  if (path==="/subscriptions"&&m==="POST") { send(res,200,{status:"dark",note:"written by CW8 payments; DARK until DK flips",_shadow:true}); return true; }

  // verification (P2) → feeds level
  // SECURITY (6 Sep 2026): this route returned the verification code in its own
  // response body as `_devCode`. Any authenticated user could therefore verify
  // their own address without receiving anything, and computeLevel treats
  // email_verified as a TRUST signal that unlocks the `publisher` level and its
  // publish credits. A verification you can grant yourself is not a
  // verification. Both routes now refuse and point at the replacement, which
  // never returns a code in any mode.
  if (seg[0]==="verify"&&(seg[2]==="start"||seg[2]==="confirm")&&m==="POST") {
    send(res,410,{ok:false,error:"gone",detail:"this endpoint returned the verification code to the caller and has been removed; use POST /verify/"+seg[1]+"/{start,confirm} on the current service",superseded_by:"/verify/:channel/start"});
    return true;
  }

  // publish gate (M-P3) + portable identity (P9) + invite
  if (path==="/publish/check"&&m==="POST") { const me=who(req); const u=db.users.get(me); const level=computeLevel(u); send(res,200,{...canPublish({level,dcs_plus:u.dcs_plus,published_count:u.published_count}),level,credits:publishCredits({level,dcs_plus:u.dcs_plus})}); return true; }
  if (path==="/identity/portable"&&m==="GET") { const u=db.users.get(who(req)); u.level_cache=computeLevel(u); const att={verified:u.email_verified&&u.phone_verified&&u.atlas_score>=50,atlas_score:u.atlas_score}; send(res,200,portableIdentity(u,att)); return true; }
  if (path==="/invite"&&m==="POST") { const me=who(req); const tok=uid("inv"); db.invites.set(tok,{by:me,created:Date.now()}); send(res,200,{invite_token:tok,url:"https://games.dcsai.ai/join/"+tok}); return true; }

  return false; // not an identity route — let the shared mock handle it
}

/**
 * The retired social routes, in the shape server.mts's /health `routes.retired`
 * array already uses. Derived from RETIRED_SOCIAL so the advertisement and the
 * behaviour cannot drift apart.
 */
export function retiredSocialRoutes() {
  return Object.keys(RETIRED_SOCIAL).map(
    (k) => `ALL /${k}/* on the legacy identity slice (410 -> ${RETIRED_SOCIAL[k].superseded_by})`,
  );
}
