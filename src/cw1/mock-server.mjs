// CW1 Identity — runnable mock server. node src/mock-server.mjs  (default port 8787)
// Implements every C4 contract from CW1_IDENTITY_FULL.md so CW3/CW6/CW7 build Day-one.
// In-memory store, zero deps. The production service implements the same shapes against Supabase.
// Honest: money DARK (subscriptions read-only mock), data is seeded test data.
import { createServer } from "node:http";
import { computeLevel, buildMe, canPublish, publishCredits } from "./identity-core.mjs";
import { can, validateSplit, seatCheck, portableIdentity } from "./identity-studio.mjs";
import { createVerificationStore } from "./verification.mjs";
const verifier = createVerificationStore();

// ---------------- in-memory store (seed) ----------------
const db = {
  users: new Map([
    ["u_dk", { id:"u_dk", name:"Deepak Dudi", email_verified:true, phone_verified:true, atlas_score:72, dcs_plus:true, active_players:240, reports:0, is_studio:true, target_exam_year:null, published_count:3 }],
    ["u_kanya", { id:"u_kanya", name:"Kanya R", email_verified:true, phone_verified:false, atlas_score:30, dcs_plus:false, active_players:4, reports:0, published_count:1 }],
    ["u_new", { id:"u_new", name:"New Player", email_verified:false, atlas_score:0, dcs_plus:false, published_count:0 }]
  ]),
  profiles: new Map([
    ["u_dk", { id:"u_dk", avatar_url:null, bio:"Founder. Builder.", achievements:["Pioneer","Verified"], worlds:3, followers:1284, following:312 }],
    ["u_kanya", { id:"u_kanya", avatar_url:null, bio:"Horror co-op main.", achievements:["Untouchable"], worlds:1, followers:86, following:140 }]
  ]),
  friends: [],            // {a_id,b_id,status}
  parties: new Map(),     // id -> {id, host, members:[], world_id?}
  teams: new Map(),       // id -> {id, owner, members:[{id,role}]}
  studios: new Map([      // P6: studio accounts with collaborators + split config
    ["std_dk", { id:"std_dk", name:"NovaStudio", owner:"u_dk", members:[{id:"u_dk",role:"owner"}], worlds:["w_blackout"], split:null }]
  ]),
  orgs: new Map(),        // id -> {id, billing_owner, members:[{id,role}], seats}
  subscriptions: new Map([// written by CW8; read-only here. money DARK.
    ["u_dk", { plan:"dcs_plus", status:"active", renews_at:"2026-07-01", _shadow:true }]
  ]),
  invites: new Map(),
  seq: 0
};
const uid = (p) => p + "_" + (++db.seq) + Math.random().toString(36).slice(2,6);

// ---------------- helpers ----------------
const send = (res, code, body) => {
  res.writeHead(code, { "content-type":"application/json", "access-control-allow-origin":"*",
    "access-control-allow-methods":"GET,POST,DELETE,OPTIONS", "access-control-allow-headers":"content-type,authorization" });
  res.end(JSON.stringify(body));
};
const body = (req) => new Promise(r => { let d=""; req.on("data",c=>d+=c); req.on("end",()=>{ try{r(d?JSON.parse(d):{});}catch{r({});} }); });
// mock auth: a real token maps to a user; default to u_dk for demo
const who = (req) => { const a = req.headers.authorization||""; const id = a.replace(/^Bearer\s+/,"") || "u_dk"; return db.users.get(id) ? id : "u_dk"; };

// ---------------- router ----------------
const server = createServer(async (req, res) => {
  if (req.method === "OPTIONS") return send(res, 204, {});
  const url = new URL(req.url, "http://x");
  const path = url.pathname, m = req.method;
  const seg = path.split("/").filter(Boolean);
  try {
    // ---- AUTH (already live elsewhere; mock keeps it green) ----
    if (path === "/auth/login" || path === "/auth/signup" || path === "/auth/ensure") {
      const b = await body(req);
      let id = b.id || "u_new";
      if (!db.users.has(id)) db.users.set(id, { id, name:b.name||"New Player", email_verified:false, atlas_score:0, dcs_plus:false, published_count:0 });
      return send(res, 200, { token:id, user: buildMe(db.users.get(id)) });
    }

    // ---- GET /me ----
    if (path === "/me" && m === "GET") {
      const u = db.users.get(who(req));
      return send(res, 200, buildMe(u));
    }

    // ---- GET /profile/:id ----
    if (seg[0] === "profile" && m === "GET") {
      const p = db.profiles.get(seg[1]);
      if (!p) return send(res, 404, { error:"not_found" });
      return send(res, 200, p);
    }

    // ---- FRIENDS ----
    if (path === "/friends" && m === "GET") {
      const me = who(req);
      const list = db.friends.filter(f => f.a_id===me || f.b_id===me)
        .map(f => ({ id: f.a_id===me ? f.b_id : f.a_id, status: f.status }));
      return send(res, 200, { friends: list });
    }
    if (path === "/friends" && m === "POST") {
      const me = who(req); const b = await body(req);
      if (!b.id) return send(res, 400, { error:"id_required" });
      db.friends.push({ a_id: me, b_id: b.id, status:"requested" });
      return send(res, 200, { id: b.id, status:"requested" });
    }
    if (seg[0] === "friends" && seg[1] && m === "DELETE") {
      const me = who(req);
      db.friends = db.friends.filter(f => !((f.a_id===me&&f.b_id===seg[1])||(f.b_id===me&&f.a_id===seg[1])));
      return send(res, 200, { id: seg[1], status:"removed" });
    }
    if (seg[0] === "friends" && seg[1] && m === "POST") { // accept
      const me = who(req);
      const f = db.friends.find(x => x.a_id===seg[1] && x.b_id===me);
      if (f) f.status = "accepted";
      return send(res, 200, { id: seg[1], status:"accepted" });
    }

    // ---- PARTIES ----
    if (path === "/parties" && m === "POST") {
      const me = who(req); const id = uid("pty");
      db.parties.set(id, { id, host: me, members:[me], world_id:null });
      return send(res, 200, db.parties.get(id));
    }
    if (seg[0]==="parties" && seg[1] && seg[2]==="join" && m==="POST") {
      const me = who(req); const p = db.parties.get(seg[1]);
      if (!p) return send(res, 404, { error:"no_party" });
      if (!p.members.includes(me)) p.members.push(me);
      return send(res, 200, p);
    }
    if (seg[0]==="parties" && seg[1] && seg[2]==="leave" && m==="POST") {
      const me = who(req); const p = db.parties.get(seg[1]);
      if (p) p.members = p.members.filter(x=>x!==me);
      return send(res, 200, p||{});
    }
    if (seg[0]==="parties" && seg[1] && m==="GET") {
      const p = db.parties.get(seg[1]);
      return p ? send(res,200,p) : send(res,404,{error:"no_party"});
    }

    // ---- TEAMS ----
    if (path === "/teams" && m === "POST") {
      const me = who(req); const id = uid("team"); const b = await body(req);
      db.teams.set(id, { id, name:b.name||"Team", owner: me, members:[{id:me, role:"owner"}] });
      return send(res, 200, db.teams.get(id));
    }
    if (seg[0]==="teams" && seg[1] && seg[2]==="members" && m==="POST") {
      const b = await body(req); const team = db.teams.get(seg[1]);
      if (!team) return send(res,404,{error:"no_team"});
      const role = ["owner","editor","viewer"].includes(b.role) ? b.role : "viewer";
      team.members.push({ id:b.id, role });
      return send(res, 200, team);
    }

    // ---- ORGS (company accounts) ----
    if (path === "/orgs" && m === "POST") {
      const me = who(req); const id = uid("org"); const b = await body(req);
      db.orgs.set(id, { id, name:b.name||"Org", billing_owner: me, seats: b.seats||5, members:[{id:me, role:"owner"}] });
      return send(res, 200, db.orgs.get(id));
    }
    if (seg[0]==="orgs" && seg[1] && m==="GET") {
      const o = db.orgs.get(seg[1]); return o?send(res,200,o):send(res,404,{error:"no_org"});
    }
    if (seg[0]==="orgs" && seg[1] && seg[2]==="members" && m==="POST") {
      const o = db.orgs.get(seg[1]); const b = await body(req);
      if (!o) return send(res,404,{error:"no_org"});
      const sc = seatCheck({ seats:o.seats, current_members:o.members.length });
      if (!sc.allowed) return send(res, 409, { error:"no_seats", ...sc });  // P8 seat enforcement
      const role = ["owner","admin","member"].includes(b.role) ? b.role : "member";
      if (!o.members.some(x=>x.id===b.id)) o.members.push({ id:b.id, role });
      return send(res, 200, { ...o, remaining_seats: sc.remaining - 1 });
    }

    // ---- SUBSCRIPTIONS (DCS+; money DARK — read-only mock) ----
    if (path === "/subscriptions" && m === "GET") {
      const me = who(req);
      return send(res, 200, db.subscriptions.get(me) || { plan:"free", status:"none", _shadow:true });
    }
    if (path === "/subscriptions" && m === "POST") {
      // money DARK: do not actually charge; reflect intent only, written by CW8 in prod
      return send(res, 200, { status:"dark", note:"subscriptions are written by CW8 payments; DARK until DK flips", _shadow:true });
    }

    // ---- STUDIOS (P6): collaborators + role permissions + revenue-split config ----
    if (path === "/studios" && m === "POST") {
      const me = who(req); const id = uid("std"); const b = await body(req);
      db.studios.set(id, { id, name:b.name||"Studio", owner:me, members:[{id:me,role:"owner"}], worlds:[], split:null });
      return send(res, 200, db.studios.get(id));
    }
    if (seg[0]==="studios" && seg[1] && m==="GET") {
      const s = db.studios.get(seg[1]); return s?send(res,200,s):send(res,404,{error:"no_studio"});
    }
    if (seg[0]==="studios" && seg[1] && seg[2]==="members" && m==="POST") {
      const me = who(req); const st = db.studios.get(seg[1]); const b = await body(req);
      if (!st) return send(res,404,{error:"no_studio"});
      const myRole = (st.members.find(x=>x.id===me)||{}).role;
      if (!can(myRole, "manage_members")) return send(res,403,{error:"forbidden", need:"manage_members"});
      const role = ["owner","admin","editor","viewer"].includes(b.role) ? b.role : "viewer";
      if (!st.members.some(x=>x.id===b.id)) st.members.push({ id:b.id, role });
      return send(res, 200, st);
    }
    if (seg[0]==="studios" && seg[1] && seg[2]==="split" && m==="POST") {
      const me = who(req); const st = db.studios.get(seg[1]); const b = await body(req);
      if (!st) return send(res,404,{error:"no_studio"});
      const myRole = (st.members.find(x=>x.id===me)||{}).role;
      if (!can(myRole, "configure_split")) return send(res,403,{error:"forbidden", need:"configure_split (owner only)"});
      const v = validateSplit(b.splits, st.owner);
      if (!v.valid) return send(res, 400, { error:"invalid_split", reason:v.reason, total:v.total });
      st.split = v.normalized;   // PERSISTS (M-P6)
      return send(res, 200, { ok:true, studio:st.id, split:st.split });
    }

    // ---- VERIFICATION (P2): email + phone → feeds computed level + publisher gate ----
    if (seg[0]==="verify" && seg[2]==="start" && m==="POST") {
      const me = who(req); const channel = seg[1]; // email | phone
      const r = verifier.issue(me, channel);
      if (!r.ok) return send(res, 400, r);
      // prod: code is sent via provider, never returned. mock returns _devCode for the loop.
      return send(res, 200, { ok:true, channel, sent:true, _devCode:r._devCode, note:"prod sends via email/SMS provider; _devCode is mock-only" });
    }
    if (seg[0]==="verify" && seg[2]==="confirm" && m==="POST") {
      const me = who(req); const channel = seg[1]; const b = await body(req);
      const r = verifier.verify(me, channel, b.code);
      if (!r.ok) return send(res, 400, r);
      const u = db.users.get(me);
      const before = computeLevel(u);
      if (channel === "email") u.email_verified = true;
      if (channel === "phone") u.phone_verified = true;
      const after = computeLevel(u);
      u.level_cache = after;
      return send(res, 200, { ok:true, channel, level_before:before, level_after:after, promoted: before!==after });
    }

    // ---- PORTABLE IDENTITY (P9, with CW7) ----
    if (path === "/identity/portable" && m === "GET") {
      const u = db.users.get(who(req)); u.level_cache = computeLevel(u);
      // CW7 attestation would be fetched live; mock derives from user's own signals
      const att = { verified: u.email_verified && u.phone_verified && u.atlas_score>=50, atlas_score: u.atlas_score };
      return send(res, 200, portableIdentity(u, att));
    }

    // ---- PUBLISH GATE (M-P3) — server-side credit check (called by CW2 at publish) ----
    if (path === "/publish/check" && m === "POST") {
      const me = who(req); const u = db.users.get(me);
      const level = computeLevel(u);
      const result = canPublish({ level, dcs_plus:u.dcs_plus, published_count:u.published_count });
      return send(res, 200, { ...result, level, credits: publishCredits({level, dcs_plus:u.dcs_plus}) });
    }

    // ---- INVITE token (P0) ----
    if (path === "/invite" && m === "POST") {
      const me = who(req); const tok = uid("inv");
      db.invites.set(tok, { by: me, created: Date.now() });
      return send(res, 200, { invite_token: tok, url: "https://games.dcsai.ai/join/"+tok });
    }

    if (path === "/" || path === "/health")
      return send(res, 200, { ok:true, service:"cw1-identity-mock", contracts:["/me","/profile/:id","/friends","/parties","/teams","/orgs","/orgs/:id/members","/studios","/studios/:id/members","/studios/:id/split","/identity/portable","/verify/:channel/start","/verify/:channel/confirm","/subscriptions","/publish/check","/invite","/auth/*"] });

    return send(res, 404, { error:"no_route", path });
  } catch (e) {
    return send(res, 500, { error:String(e) });
  }
});

const PORT = process.env.PORT || 8787;
if (process.argv[1] && process.argv[1].endsWith("mock-server.mjs")) {
  server.listen(PORT, () => console.log("CW1 identity mock on :" + PORT));
}
export { server, db };
