// CW1 Identity — production service entrypoint. node src/service.mjs
// Uses the Supabase repo when creds are present (DK deploy), in-memory otherwise (local/CI).
// Reuses ALL pure logic: computeLevel, canPublish, studio rules, verification, attestation.
// /health reports db mode so the integrator can confirm `supabase` on the live deploy.
//
// WHAT THIS IS NOT (6 Sep 2026): this is a STANDALONE entrypoint. It only runs when
// invoked directly (`node src/cw1/service.mjs`); the gateway in server.mts does not
// mount it. So its /friends, /parties and /studios routes are not the estate's
// social surface — server.mts serves those durably from src/core/social.mjs at
// /social/*, and the legacy in-memory copies on the gateway are retired (410).
// Anything running this process without Supabase creds gets a process-local store,
// and /health now says exactly that rather than printing a bare db:"memory".
//
// Its `who()` below reads the bearer token as a raw user id and does not verify a
// signature — that is a mock, not authentication, and it is why this entrypoint is
// not mounted. Do not deploy this process without replacing who().

import { createServer } from "node:http";
import { getDb, makeRepo, describeDb } from "./db.mjs";
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
    if (path === "/health") {
      const persistence = describeDb();
      return send(res, 200, {
        ok:true, service:"cw1-identity",
        db: persistence.mode,          // unchanged field, for anything already reading it
        // `db:"memory"` on its own does not tell a reader that this process keeps
        // nothing across a restart. This does, in the same words the log uses.
        persistence,
        durable: persistence.durable,
        // The verification challenge store (src/cw1/verification.mjs) is a plain
        // Map with no backing at all, in EVERY mode — including supabase. A code
        // issued before a restart cannot be confirmed after one. Said here rather
        // than left for a tester to discover.
        verification_store: { kind:"memory", durable:false, scope:"process-local",
          note:"challenges are held in-process in every mode; a restart invalidates every outstanding code" },
        payments_live: PAYMENTS_LIVE,
      });
    }

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
  // Refuse to start unless someone says so deliberately, exactly as
  // mock-server.mjs does. who() below reads the bearer token as a raw user id
  // and verifies no signature — anyone can be anyone here. The file says so in
  // its header, but a header does not stop a deploy script, and this listens on
  // a port. The guard is what stops it.
  if (process.env.NODE_ENV !== "development" && process.env.DCS_ALLOW_CW1_SERVICE !== "1") {
    console.error(JSON.stringify({
      level: "fatal",
      detail: "Refusing to start src/cw1/service.mjs: its who() accepts an unverified bearer token as an identity, so any caller can act as any user.",
      fix: "The estate's real identity surface is server.mts, which authenticates through src/core/principal.mjs. To run this anyway for local contract work, set DCS_ALLOW_CW1_SERVICE=1.",
      ts: new Date().toISOString(),
    }));
    process.exit(78);
  }
  // getDb() is awaited before listen so the in-memory warning (db.mjs) is on the
  // log BEFORE the "ready" line, rather than appearing later next to a request.
  getDb().then((db) => {
    const p = describeDb();
    server.listen(PORT, () => console.log(
      `CW1 identity service on :${PORT} · db=${p.mode} · durable=${p.durable} · payments_live=${PAYMENTS_LIVE}` +
      (p.durable ? "" : " · WARNING: all identity data is process-local and is lost on restart"),
    ));
  });
}
export { server, handler };
