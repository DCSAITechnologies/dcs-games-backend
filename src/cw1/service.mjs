// CW1 Identity — production service entrypoint. node src/service.mjs
// Uses the Supabase repo when creds are present (DK deploy), in-memory otherwise (local/CI).
// Reuses ALL pure logic: computeLevel, canPublish, studio rules, verification, attestation.
// /health reports db mode so the integrator can confirm `supabase` on the live deploy.

import { createServer } from "node:http";
import { getDb, makeRepo } from "./db.mjs";
import { buildMe, computeLevel, canPublish, publishCredits } from "./identity-core.mjs";
import { can, validateSplit, seatCheck } from "./identity-studio.mjs";
import { createVerificationStore } from "./verification.mjs";
import { applyAttestation } from "./attestation.mjs";

const PAYMENTS_LIVE = process.env.PAYMENTS_LIVE === "1"; // DARK by default
const verifier = createVerificationStore();

const send = (res, code, body) => { res.writeHead(code, { "content-type":"application/json", "access-control-allow-origin":"*",
  "access-control-allow-methods":"GET,POST,DELETE,OPTIONS", "access-control-allow-headers":"content-type,authorization" }); res.end(JSON.stringify(body)); };
const readBody = (req) => new Promise(r => { let d=""; req.on("data",c=>d+=c); req.on("end",()=>{try{r(d?JSON.parse(d):{})}catch{r({})}}); });
// auth: in prod, resolve the Supabase JWT → user id. Here we accept Bearer <user_id> (mock) until
// the live auth middleware is injected. Google OAuth is already on the project per the mandate.
const who = (req) => (req.headers.authorization||"").replace(/^Bearer\s+/,"") || "u_dk";

async function handler(req, res) {
  if (req.method === "OPTIONS") return send(res, 204, {});
  const url = new URL(req.url, "http://x"); const path = url.pathname, m = req.method;
  const seg = path.split("/").filter(Boolean);
  const db = await getDb(); const repo = makeRepo(db);

  try {
    if (path === "/health")
      return send(res, 200, { ok:true, service:"cw1-identity", db: db.mode === "supabase" ? "supabase" : "memory", payments_live: PAYMENTS_LIVE });

    if (path === "/me" && m === "GET") {
      const u = await repo.getUser(who(req));
      if (!u) return send(res, 404, { error:"no_user" });
      return send(res, 200, buildMe(u));
    }
    if (seg[0]==="profile" && m==="GET") {
      const p = await repo.getProfile(seg[1]); return send(res, p?200:404, p||{error:"not_found"});
    }
    if (path === "/friends" && m==="GET") return send(res, 200, { friends: await repo.listFriends(who(req)) });
    if (path === "/friends" && m==="POST") { const b=await readBody(req); if(!b.id) return send(res,400,{error:"id_required"}); return send(res,200, await repo.addFriend(who(req), b.id)); }
    if (seg[0]==="friends" && seg[1] && m==="DELETE") return send(res,200, await repo.removeFriend(who(req), seg[1]));
    if (seg[0]==="friends" && seg[1] && m==="POST") return send(res,200, await repo.acceptFriend(who(req), seg[1]));

    if (path==="/parties" && m==="POST") return send(res,200, await repo.createParty(who(req)));
    if (seg[0]==="parties" && seg[1] && seg[2]==="join" && m==="POST") { const p=await repo.joinParty(seg[1], who(req)); return send(res, p?200:404, p||{error:"no_party"}); }

    // publish gate (M-P3) — server-side, real credit check
    if (path==="/publish/check" && m==="POST") {
      const u = await repo.getUser(who(req)); if(!u) return send(res,404,{error:"no_user"});
      const level = computeLevel(u);
      return send(res, 200, { ...canPublish({ level, dcs_plus:u.dcs_plus, published_count:u.published_count }), level, credits: publishCredits({level, dcs_plus:u.dcs_plus}) });
    }

    // studios (P6) — role-gated split, persisted via repo
    if (path==="/studios" && m==="POST") { const b=await readBody(req); return send(res,200, await repo.createStudio(who(req), b.name||"Studio")); }
    if (seg[0]==="studios" && seg[1] && m==="GET") { const s=await repo.getStudio(seg[1]); return send(res, s?200:404, s||{error:"no_studio"}); }
    if (seg[0]==="studios" && seg[1] && seg[2]==="split" && m==="POST") {
      const me=who(req); const st=await repo.getStudio(seg[1]); const b=await readBody(req);
      if(!st) return send(res,404,{error:"no_studio"});
      const role=(st.members.find(x=>x.id===me)||{}).role;
      if(!can(role,"configure_split")) return send(res,403,{error:"forbidden",need:"configure_split"});
      const v=validateSplit(b.splits, st.owner); if(!v.valid) return send(res,400,{error:"invalid_split",reason:v.reason});
      const updated=await repo.setStudioSplit(seg[1], v.normalized);
      return send(res,200,{ ok:true, studio:seg[1], split:updated.split });
    }

    // subscriptions — DARK
    if (path==="/subscriptions" && m==="GET") return send(res,200, await repo.getSubscription(who(req)));
    if (path==="/subscriptions" && m==="POST") return send(res,200, { status:"dark", payments_live:PAYMENTS_LIVE, note:"CW8 writes; DARK until DK flips" });

    // verification (P2)
    if (seg[0]==="verify" && seg[2]==="start" && m==="POST") { const r=verifier.issue(who(req), seg[1]); return send(res, r.ok?200:400, r); }
    if (seg[0]==="verify" && seg[2]==="confirm" && m==="POST") {
      const me=who(req); const b=await readBody(req); const r=verifier.verify(me, seg[1], b.code);
      if(!r.ok) return send(res,400,r);
      const u=await repo.getUser(me); if(seg[1]==="email")u.email_verified=true; if(seg[1]==="phone")u.phone_verified=true;
      await repo.upsertUser(u);
      return send(res,200,{ ok:true, channel:seg[1], level_after: computeLevel(u) });
    }

    // attestation ingest (CW1<-CW7) — applies a CW7 attestation, persists resulting signals
    if (path==="/identity/attestation" && m==="POST") {
      const b=await readBody(req); const u=await repo.getUser(b.subject||who(req)); if(!u) return send(res,404,{error:"no_user"});
      const r=applyAttestation(u, b); if(r.applied) await repo.upsertUser(u);
      return send(res,200,{ applied:r.applied, level_after:r.level_after, promoted:r.promoted, demoted:r.demoted, reason:r.reason });
    }

    return send(res, 404, { error:"no_route", path });
  } catch (e) { return send(res, 500, { error:String(e&&e.message||e) }); }
}

const server = createServer(handler);
const PORT = process.env.PORT || 8788;
if (process.argv[1] && process.argv[1].endsWith("service.mjs")) {
  getDb().then(db => server.listen(PORT, () => console.log(`CW1 identity service on :${PORT} · db=${db.mode==="supabase"?"supabase":"memory"} · payments_live=${PAYMENTS_LIVE}`)));
}
export { server, handler };
