// CW1 Identity — CANONICAL SLICE for _SHARED_Day0/mock-server.mjs (manager ruling: do (a)).
// Drop-in merge: in the shared mock, import this and call handleIdentity(req,res,ctx) FIRST in the
// router; if it returns true it handled the request, else fall through to the shared routes.
// This is the identity slice that "wins" per the ruling — richer than the Day0 stub.
//
// Zero deps. Reuses CW1's frozen logic. The shared mock keeps its world/netcode/save routes;
// this owns: /me, /profile/:id, /friends, /parties, /teams, /orgs(+seats), /studios(+split),
// /subscriptions (DARK), /publish/check, /invite, /verify/*, /identity/portable, /auth/*.

import { computeLevel, buildMe, canPublish, publishCredits } from "./identity-core.mjs";
import { can, validateSplit, seatCheck, portableIdentity } from "./identity-studio.mjs";
import { createVerificationStore } from "./verification.mjs";

// ---- identity store (merge into the shared mock's db, or keep namespaced) ----
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

const verifier = createVerificationStore();

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

  // friends
  if (path === "/friends" && m === "GET") {
    const me=who(req); send(res,200,{ friends: db.friends.filter(f=>f.a_id===me||f.b_id===me).map(f=>({id:f.a_id===me?f.b_id:f.a_id,status:f.status})) }); return true; }
  if (path === "/friends" && m === "POST") { const me=who(req); const b=await body(req); if(!b.id){send(res,400,{error:"id_required"});return true;} db.friends.push({a_id:me,b_id:b.id,status:"requested"}); send(res,200,{id:b.id,status:"requested"}); return true; }
  if (seg[0]==="friends" && seg[1] && m==="DELETE") { const me=who(req); db.friends=db.friends.filter(f=>!((f.a_id===me&&f.b_id===seg[1])||(f.b_id===me&&f.a_id===seg[1]))); send(res,200,{id:seg[1],status:"removed"}); return true; }
  if (seg[0]==="friends" && seg[1] && m==="POST") { const me=who(req); const f=db.friends.find(x=>x.a_id===seg[1]&&x.b_id===me); if(f)f.status="accepted"; send(res,200,{id:seg[1],status:"accepted"}); return true; }

  // parties
  if (path==="/parties" && m==="POST") { const me=who(req); const id=uid("pty"); db.parties.set(id,{id,host:me,members:[me],world_id:null}); send(res,200,db.parties.get(id)); return true; }
  if (seg[0]==="parties"&&seg[1]&&seg[2]==="join"&&m==="POST") { const me=who(req); const p=db.parties.get(seg[1]); if(!p){send(res,404,{error:"no_party"});return true;} if(!p.members.includes(me))p.members.push(me); send(res,200,p); return true; }
  if (seg[0]==="parties"&&seg[1]&&seg[2]==="leave"&&m==="POST") { const me=who(req); const p=db.parties.get(seg[1]); if(p)p.members=p.members.filter(x=>x!==me); send(res,200,p||{}); return true; }
  if (seg[0]==="parties"&&seg[1]&&m==="GET") { const p=db.parties.get(seg[1]); send(res,p?200:404,p||{error:"no_party"}); return true; }

  // teams
  if (path==="/teams"&&m==="POST") { const me=who(req); const id=uid("team"); const b=await body(req); db.teams.set(id,{id,name:b.name||"Team",owner:me,members:[{id:me,role:"owner"}]}); send(res,200,db.teams.get(id)); return true; }
  if (seg[0]==="teams"&&seg[1]&&seg[2]==="members"&&m==="POST") { const b=await body(req); const tm=db.teams.get(seg[1]); if(!tm){send(res,404,{error:"no_team"});return true;} tm.members.push({id:b.id,role:["owner","editor","viewer"].includes(b.role)?b.role:"viewer"}); send(res,200,tm); return true; }

  // orgs (+ seats)
  if (path==="/orgs"&&m==="POST") { const me=who(req); const id=uid("org"); const b=await body(req); db.orgs.set(id,{id,name:b.name||"Org",billing_owner:me,seats:b.seats||5,members:[{id:me,role:"owner"}]}); send(res,200,db.orgs.get(id)); return true; }
  if (seg[0]==="orgs"&&seg[1]&&seg[2]==="members"&&m==="POST") { const o=db.orgs.get(seg[1]); const b=await body(req); if(!o){send(res,404,{error:"no_org"});return true;} const sc=seatCheck({seats:o.seats,current_members:o.members.length}); if(!sc.allowed){send(res,409,{error:"no_seats",...sc});return true;} if(!o.members.some(x=>x.id===b.id))o.members.push({id:b.id,role:["owner","admin","member"].includes(b.role)?b.role:"member"}); send(res,200,{...o,remaining_seats:sc.remaining-1}); return true; }
  if (seg[0]==="orgs"&&seg[1]&&m==="GET") { const o=db.orgs.get(seg[1]); send(res,o?200:404,o||{error:"no_org"}); return true; }

  // studios (+ split, role-gated)
  if (path==="/studios"&&m==="POST") { const me=who(req); const id=uid("std"); const b=await body(req); db.studios.set(id,{id,name:b.name||"Studio",owner:me,members:[{id:me,role:"owner"}],worlds:[],split:null}); send(res,200,db.studios.get(id)); return true; }
  if (seg[0]==="studios"&&seg[1]&&m==="GET") { const s=db.studios.get(seg[1]); send(res,s?200:404,s||{error:"no_studio"}); return true; }
  if (seg[0]==="studios"&&seg[1]&&seg[2]==="members"&&m==="POST") { const me=who(req); const st=db.studios.get(seg[1]); const b=await body(req); if(!st){send(res,404,{error:"no_studio"});return true;} const myRole=(st.members.find(x=>x.id===me)||{}).role; if(!can(myRole,"manage_members")){send(res,403,{error:"forbidden",need:"manage_members"});return true;} if(!st.members.some(x=>x.id===b.id))st.members.push({id:b.id,role:["owner","admin","editor","viewer"].includes(b.role)?b.role:"viewer"}); send(res,200,st); return true; }
  if (seg[0]==="studios"&&seg[1]&&seg[2]==="split"&&m==="POST") { const me=who(req); const st=db.studios.get(seg[1]); const b=await body(req); if(!st){send(res,404,{error:"no_studio"});return true;} const myRole=(st.members.find(x=>x.id===me)||{}).role; if(!can(myRole,"configure_split")){send(res,403,{error:"forbidden",need:"configure_split (owner only)"});return true;} const v=validateSplit(b.splits,st.owner); if(!v.valid){send(res,400,{error:"invalid_split",reason:v.reason,total:v.total});return true;} st.split=v.normalized; send(res,200,{ok:true,studio:st.id,split:st.split}); return true; }

  // subscriptions (DARK)
  if (path==="/subscriptions"&&m==="GET") { const me=who(req); send(res,200,db.subscriptions.get(me)||{plan:"free",status:"none",_shadow:true}); return true; }
  if (path==="/subscriptions"&&m==="POST") { send(res,200,{status:"dark",note:"written by CW8 payments; DARK until DK flips",_shadow:true}); return true; }

  // verification (P2) → feeds level
  if (seg[0]==="verify"&&seg[2]==="start"&&m==="POST") { const me=who(req); const r=verifier.issue(me,seg[1]); send(res,r.ok?200:400,r.ok?{ok:true,channel:seg[1],sent:true,_devCode:r._devCode,note:"prod sends via provider; _devCode mock-only"}:r); return true; }
  if (seg[0]==="verify"&&seg[2]==="confirm"&&m==="POST") { const me=who(req); const b=await body(req); const r=verifier.verify(me,seg[1],b.code); if(!r.ok){send(res,400,r);return true;} const u=db.users.get(me); const before=computeLevel(u); if(seg[1]==="email")u.email_verified=true; if(seg[1]==="phone")u.phone_verified=true; const after=computeLevel(u); u.level_cache=after; send(res,200,{ok:true,channel:seg[1],level_before:before,level_after:after,promoted:before!==after}); return true; }

  // publish gate (M-P3) + portable identity (P9) + invite
  if (path==="/publish/check"&&m==="POST") { const me=who(req); const u=db.users.get(me); const level=computeLevel(u); send(res,200,{...canPublish({level,dcs_plus:u.dcs_plus,published_count:u.published_count}),level,credits:publishCredits({level,dcs_plus:u.dcs_plus})}); return true; }
  if (path==="/identity/portable"&&m==="GET") { const u=db.users.get(who(req)); u.level_cache=computeLevel(u); const att={verified:u.email_verified&&u.phone_verified&&u.atlas_score>=50,atlas_score:u.atlas_score}; send(res,200,portableIdentity(u,att)); return true; }
  if (path==="/invite"&&m==="POST") { const me=who(req); const tok=uid("inv"); db.invites.set(tok,{by:me,created:Date.now()}); send(res,200,{invite_token:tok,url:"https://games.dcsai.ai/join/"+tok}); return true; }

  return false; // not an identity route — let the shared mock handle it
}
