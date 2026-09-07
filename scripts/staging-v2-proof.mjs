#!/usr/bin/env node
// The V2 surface, proven against the deployed staging service.
//
// V2 is live and carries real traffic, and it had been missing from /health's
// route inventory entirely — which made it look retired when it is not. Section
// 4 of the closure order is explicit that V2 must not be left as an orphaned
// product while V3 advances, and "not orphaned" means proven, not merely
// present.
//
// The V2 journey is smaller than the V3 one and that is the point: generate,
// save, load, publish, and see it publicly. Every step here is the legacy
// contract, not the V3 one.
//
//   STAGE_JWT=... node scripts/staging-v2-proof.mjs
const U = process.env.STAGE_URL || "https://dcs-games-backend-staging.up.railway.app";
const JWT = process.env.STAGE_JWT;
if (!JWT) { console.error("STAGE_JWT required"); process.exit(2); }

let pass = 0, fail = 0;
const out = [];
const ok = (n, c, d = "") => { if (c) { pass++; out.push(`  PASS  ${n}`); } else { fail++; out.push(`  FAIL  ${n}${d ? " — " + d : ""}`); } };

const api = (p, init = {}) => fetch(U + p, {
  ...init, headers: { Authorization: "Bearer " + JWT, "Content-Type": "application/json", ...(init.headers || {}) },
});
const anon = (p) => fetch(U + p);
const j = async (r) => { try { return JSON.parse(await r.text()); } catch { return {}; } };

// ------------------------------------------------------------- generate

const gen = await api("/worlds/generate", {
  method: "POST", body: JSON.stringify({ prompt: "A hill fort above a salt road, garrisoned by people who have forgotten the war." }),
});
const g = await j(gen);
ok("V2 generate answers", gen.status === 200 || gen.status === 201, `HTTP ${gen.status} ${JSON.stringify(g).slice(0, 200)}`);
const W = g.world_id || g.id || g.world?.world_id;
ok("and returns a world id", !!W, JSON.stringify(Object.keys(g)));
if (!W) { console.log(out.join("\n")); process.exit(1); }

// An empty prompt must not quietly produce someone else's world.
const empty = await api("/worlds/generate", { method: "POST", body: JSON.stringify({ prompt: "" }) });
ok("an empty prompt is refused rather than defaulted", empty.status === 422,
   `HTTP ${empty.status} — this used to answer 200 with a pirate world presented as the caller's own`);

// ----------------------------------------------------------------- load

const l = await api(`/worlds/${W}/load`);
const lb = await j(l);
ok("V2 load returns the world", l.status === 200 && !!lb.manifest, `HTTP ${l.status}`);
ok("and reports its state", typeof lb.state === "string", JSON.stringify(lb).slice(0, 150));
ok("and its owner", !!lb.owner);

// ----------------------------------------------------------------- save

const edited = structuredClone(lb.manifest);
edited.meta = edited.meta || {};
edited.meta.title = "Saltgate, revised";
const s1 = await api(`/worlds/${W}/save`, { method: "POST", body: JSON.stringify({ manifest: edited }) });
const sb = await j(s1);
ok("V2 save accepts a full manifest", s1.status === 200, `HTTP ${s1.status} ${JSON.stringify(sb).slice(0, 200)}`);
ok("and versions it", Number(sb.world_version) >= 1, JSON.stringify(sb).slice(0, 150));

// Idempotent: the same bytes twice must not invent a version.
const s2 = await j(await api(`/worlds/${W}/save`, { method: "POST", body: JSON.stringify({ manifest: edited }) }));
ok("saving identical content is idempotent", s2.idempotent === true || s2.world_version === sb.world_version,
   `first v${sb.world_version}, second v${s2.world_version} idempotent=${s2.idempotent}`);

// The authorization hole: a save must not be able to publish.
const sneak = await api(`/worlds/${W}/save`, { method: "POST", body: JSON.stringify({ manifest: edited, state: "published" }) });
const sneakB = await j(sneak);
ok("V2 GATE: a save cannot set state", sneak.status === 422, `HTTP ${sneak.status}`);
ok("and it says where publishing actually happens", /publish/.test(sneakB.detail || ""), sneakB.detail);

// Round trip: what was saved is what comes back.
const back = await j(await api(`/worlds/${W}/load`));
ok("the edit round-trips losslessly", back.manifest?.meta?.title === "Saltgate, revised",
   `got "${back.manifest?.meta?.title}"`);
ok("and the world is still a draft after an ordinary save", back.state === "draft", back.state);

// -------------------------------------------------------------- publish

const pubBefore = await j(await anon("/api/public/worlds"));
ok("a draft is not publicly listed", !JSON.stringify(pubBefore).includes(W));

const p = await api(`/worlds/${W}/publish`, { method: "POST", body: JSON.stringify({}) });
const pb = await j(p);
ok("V2 publish succeeds for the owner", p.status === 200, `HTTP ${p.status} ${JSON.stringify(pb).slice(0, 200)}`);
ok("and it signs an Atlas receipt", !!(pb.receipt?.receipt_hash || pb.atlas_receipt_hash || pb.receipt_hash),
   JSON.stringify(Object.keys(pb)));

const pubAfter = await j(await anon("/api/public/worlds"));
ok("a published world IS publicly listed", JSON.stringify(pubAfter).includes(W));

const state = await j(await api(`/worlds/${W}/load`));
ok("and its state says published", state.state === "published", state.state);

// And publishing did not lose the edit.
ok("publishing preserved the saved content", state.manifest?.meta?.title === "Saltgate, revised",
   `got "${state.manifest?.meta?.title}"`);

// ------------------------------------------------------------ listing

const mine = await j(await api("/worlds/mine"));
ok("the creator's own list includes it", JSON.stringify(mine).includes(W));

console.log(out.join("\n"));
console.log(`\n  ${pass} passed, ${fail} failed   world=${W}`);
process.exit(fail ? 1 : 0);
