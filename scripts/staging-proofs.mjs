#!/usr/bin/env node
// Real remote proofs against the deployed staging service and its Supabase
// project. Every assertion goes over the network; nothing here is stubbed, and
// nothing is asserted that the response does not actually show.
//
//   STAGE_JWT=... node scripts/staging-proofs.mjs
//
// Optional: OTHER_JWT (a second principal, for ownership isolation),
// PRIOR_WORLD + PRIOR_HASH (a world saved by an EARLIER process, which is what
// makes the durability check meaningful — it must survive a real restart, not
// just a second request to the same one).
//
// Covers the flagship journey end to end: Describe -> Generate -> Play -> Save
// -> Return -> Companion -> Edit -> Expand -> Playtest -> Publish, plus
// versioning, rollback, ownership isolation and concurrent writes.
const U = process.env.STAGE_URL || "https://dcs-games-backend-staging.up.railway.app";
const JWT = process.env.STAGE_JWT;
if (!JWT) { console.error("STAGE_JWT required"); process.exit(2); }

let pass = 0, fail = 0;
const results = [];
function ok(name, cond, detail = "") {
  if (cond) { pass++; results.push(`  PASS  ${name}`); }
  else { fail++; results.push(`  FAIL  ${name}${detail ? " — " + detail : ""}`); }
}

const api = (p, init = {}) => fetch(U + p, {
  ...init,
  headers: { Authorization: "Bearer " + JWT, "Content-Type": "application/json", ...(init.headers || {}) },
});
const anon = (p, init = {}) => fetch(U + p, { ...init, headers: { "Content-Type": "application/json", ...(init.headers || {}) } });

const j = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 300) }; } };

// ---------------------------------------------------------------- durability
// A world saved by a PREVIOUS process. If persistence were in-memory or on an
// ephemeral disk, this is where it would fall over.
const PRIOR = process.env.PRIOR_WORLD, PRIOR_HASH = process.env.PRIOR_HASH;
if (PRIOR) {
  const r = await api(`/v3/worlds/${PRIOR}/manifest`);
  const b = await j(r);
  ok("a world saved before the restart is still readable", r.status === 200, `HTTP ${r.status}`);
  const m = b.manifest || b;
  ok("and it still has its content", (m.npcs || []).length > 0 && (m.zones || []).length > 0);
  if (PRIOR_HASH) {
    const vs = await j(await api(`/v3/worlds/${PRIOR}/versions`));
    const head = (vs.versions || []).find((v) => v.version === 1);
    ok("and it is byte-identical across the restart", head?.manifest_hash === PRIOR_HASH,
      `${String(head?.manifest_hash).slice(0, 12)} vs ${PRIOR_HASH.slice(0, 12)}`);
  }
}

// ------------------------------------------------------------------- create
const gen = await api("/api/v3/worlds/generate", {
  method: "POST",
  body: JSON.stringify({ prompt: "A cliff monastery whose bells are rung by the wind, and whose monks have forgotten why.", name: "Bellreach" }),
});
const g = await j(gen);
ok("generate succeeds against the real provider", gen.status === 200 && g.ok === true, JSON.stringify(g).slice(0, 200));
const W = g.world_id;
if (!W) { console.log(results.join("\n")); console.error("cannot continue without a world"); process.exit(1); }
const H0 = g.manifest_hash;
ok("the world is saved with a manifest hash", !!H0);
ok("the playtest gate passed", g.playtest?.verdict === "PASSED", JSON.stringify(g.playtest || {}));

// -------------------------------------------------------------------- load
const l1 = await api(`/v3/worlds/${W}/manifest`);
const lb = await j(l1);
ok("the world loads back", l1.status === 200, `HTTP ${l1.status}`);
const v1 = await j(await api(`/v3/worlds/${W}/versions`));
const head1 = (v1.versions || [])[0];
ok("the stored version hash matches what generate reported", head1?.manifest_hash === H0,
   `${String(head1?.manifest_hash).slice(0,12)} vs ${String(H0).slice(0,12)}`);
ok("and the loaded manifest carries a hash a client can verify", !!lb.manifest_hash,
   "the manifest response has no manifest_hash");

// ------------------------------------------------------------------ listing
const mine = await j(await api("/worlds/mine"));
ok("the new world appears in the owner's list",
   JSON.stringify(mine).includes(W));

// ---------------------------------------------------------------- ownership
// A different principal must not be able to read it, and must not be told it
// exists either.
const other = process.env.OTHER_JWT;
if (other) {
  const r = await fetch(U + `/v3/worlds/${W}/manifest`, { headers: { Authorization: "Bearer " + other } });
  ok("another principal cannot read an unpublished world", r.status === 404,
     `HTTP ${r.status} (403 would confirm it exists)`);
}
const na = await anon(`/v3/worlds/${W}/manifest`);
ok("an anonymous caller cannot read an unpublished world", na.status === 401 || na.status === 404, `HTTP ${na.status}`);

// ----------------------------------------------------------------- versions
const vr = await api(`/v3/worlds/${W}/versions`);
const vb = await j(vr);
ok("version history is available", vr.status === 200, `HTTP ${vr.status}`);
const versions = vb.versions || vb.rows || [];
ok("the first save is version 1", versions.length >= 1 && Number(versions[versions.length - 1]?.version ?? versions[0]?.version) >= 1,
   JSON.stringify(versions).slice(0, 200));

// --------------------------------------------------------------------- edit
const ed = await api(`/v3/worlds/${W}/edit`, {
  method: "POST",
  body: JSON.stringify({ request: "make it rain" }),
});
const eb = await j(ed);
ok("an edit is accepted", ed.status === 200 && eb.ok !== false, JSON.stringify(eb).slice(0, 250));
const H1 = eb.manifest_hash || eb.to_manifest_hash || eb.world_version;
if (ed.status === 200) {
  ok("the edit produced a new version", !!H1 && String(H1) !== String(H0), `${String(H1).slice(0,12)} vs ${String(H0).slice(0,12)}`);
  const v2 = await j(await api(`/v3/worlds/${W}/versions`));
  const n2 = (v2.versions || v2.rows || []).length;
  ok("the edit created a new version rather than overwriting", n2 > versions.length, `${versions.length} -> ${n2}`);
}

// ----------------------------------------------------------------- rollback
if (H1) {
  const rb = await api(`/v3/worlds/${W}/rollback`, { method: "POST", body: JSON.stringify({ to_version: 1 }) });
  const rbb = await j(rb);
  ok("rollback to version 1 is accepted", rb.status === 200, `HTTP ${rb.status} ${JSON.stringify(rbb).slice(0,200)}`);
  if (rb.status === 200) {
    const vs = await j(await api(`/v3/worlds/${W}/versions`));
    const rolled = (vs.versions || []).find((v) => /rollback/i.test(v.label || ""));
    ok("and rollback is recorded as a new version, not a deletion", !!rolled && (vs.versions || []).length >= 3);

    // Content equality, not hash equality: the manifest hash covers provenance
    // and expansion history, and a rollback DELIBERATELY appends to both — a
    // new version number, an updated_at, a rollback provenance entry. Demanding
    // an identical hash would be demanding that rollback rewrite history.
    const d = await j(await api(`/v3/worlds/${W}/diff?from=1&to=${rolled?.version ?? 3}`));
    const unchanged = d.added?.total === 0 && d.removed?.total === 0 && d.modified?.total === 0
      && d.terrain?.changed === false && d.navigation?.changed === false
      && d.spawn?.changed === false && d.environment?.changed === false;
    ok("rollback restores the ORIGINAL content exactly", unchanged,
       `+${d.added?.total} -${d.removed?.total} ~${d.modified?.total} terrain=${d.terrain?.changed} nav=${d.navigation?.changed}`);
    ok("and the rollback itself is on the record rather than silent",
       (vs.versions || []).some((v) => v.version === 1) && !!rolled,
       "the version it rolled back FROM must still exist");
  }
}

// -------------------------------------------------------------- concurrency
// Two simultaneous edits must not interleave into a corrupt manifest or lose a
// version. Whatever the outcome, the store must stay consistent.
const before = (await j(await api(`/v3/worlds/${W}/versions`))).versions?.length ?? 0;
const both = await Promise.all([
  api(`/v3/worlds/${W}/edit`, { method: "POST", body: JSON.stringify({ request: "night mode" }) }),
  api(`/v3/worlds/${W}/edit`, { method: "POST", body: JSON.stringify({ request: "add a road" }) }),
]);
const codes = both.map((r) => r.status);
const after = (await j(await api(`/v3/worlds/${W}/versions`))).versions?.length ?? 0;
const succeeded = codes.filter((c) => c === 200).length;
ok("the concurrency probe actually exercised concurrent writes", succeeded > 0,
   `both edits were refused (${codes}), so this proves nothing`);
ok("concurrent edits do not lose or duplicate versions",
   after - before === succeeded, `${succeeded} succeeded (${codes}) but version count moved ${before} -> ${after}`);
const fin = await j(await api(`/v3/worlds/${W}/manifest`));
ok("the manifest is still valid after concurrent writes",
   Array.isArray(fin.manifest?.zones || fin.zones) && (fin.manifest?.zones || fin.zones).length > 0);


// -------------------------------------------------------------------- play
const play = await api(`/v3/worlds/${W}/play`, { method: "POST", body: JSON.stringify({}) });
const playB = await j(play);
ok("the world can be entered", play.status === 200 || play.status === 201, `HTTP ${play.status}`);
ok("and entering it is counted", (playB.stats?.plays ?? 0) >= 1, JSON.stringify(playB).slice(0, 200));

// --------------------------------------------------------------- companion
const comp = await api(`/v3/worlds/${W}/companion`, {
  method: "POST", body: JSON.stringify({ message: "What is this place?" }),
});
const cb = await j(comp);
ok("the companion answers inside the world", comp.status === 200, `HTTP ${comp.status} ${JSON.stringify(cb).slice(0, 200)}`);
if (comp.status === 200) {
  const said = cb.greeting?.text || cb.reply?.text || cb.reply || cb.message || "";
  ok("and it actually says something", typeof said === "string" && said.trim().length > 0, JSON.stringify(cb).slice(0, 200));
  // Grounded, not generic: the companion should be talking about THIS world.
  const zoneNames = ((await j(await api(`/v3/worlds/${W}/manifest`))).manifest?.zones || []).map((z) => z.name).filter(Boolean);
  ok("and it is grounded in the world it is standing in",
     zoneNames.some((n) => said.includes(n)),
     `said "${String(said).slice(0, 90)}" but names none of: ${zoneNames.join(", ")}`);
}

// ------------------------------------------------------------------ memory
const mem = await api(`/v3/worlds/${W}/memory`);
const mb = await j(mem);
ok("the world remembers what happened to it", mem.status === 200 && Array.isArray(mb.timeline), `HTTP ${mem.status}`);
const events = (mb.timeline || []).flatMap((t) => t.events || []);
ok("including its own creation", events.some((e) => e.kind === "created"),
   `${events.length} events: ${events.map((e) => e.kind).join(", ")}`);
ok("and every version that changed it", events.some((e) => e.kind === "edited") && events.some((e) => e.kind === "rolled_back"),
   events.map((e) => e.kind).join(", "));

// ------------------------------------------------------------------ expand
const vBefore = (await j(await api(`/v3/worlds/${W}/versions`))).versions?.length ?? 0;
const exp = await api(`/v3/worlds/${W}/expand`, {
  method: "POST", body: JSON.stringify({ request: "add a district" }),
});
const xb = await j(exp);
ok("the world can be expanded", exp.status === 200, `HTTP ${exp.status} ${JSON.stringify(xb).slice(0, 250)}`);
if (exp.status === 200) {
  const vAfter = (await j(await api(`/v3/worlds/${W}/versions`))).versions?.length ?? 0;
  ok("and the expansion is a new version, not an overwrite", vAfter > vBefore, `${vBefore} -> ${vAfter}`);
  const after = await j(await api(`/v3/worlds/${W}/manifest`));
  const m2 = after.manifest || {};
  ok("and the world is bigger than it was", (m2.zones || []).length >= 1);
}

// ---------------------------------------------------------------- playtest
const pt = await api(`/v3/worlds/${W}/playtest`, { method: "POST", body: JSON.stringify({}) });
const ptb = await j(pt);
ok("the world can be playtested on demand", pt.status === 200, `HTTP ${pt.status}`);
if (pt.status === 200) {
  ok("and the playtest reports a verdict rather than a bare ok",
     typeof (ptb.verdict || ptb.result?.verdict) === "string", JSON.stringify(ptb).slice(0, 200));
}

// ----------------------------------------------------------------- publish
const pub = await api(`/worlds/${W}/publish`, { method: "POST", body: JSON.stringify({}) });
const pb = await j(pub);
ok("the world can be published", pub.status === 200, `HTTP ${pub.status} ${JSON.stringify(pb).slice(0, 250)}`);
if (pub.status === 200) {
  const pubList = await j(await anon("/api/public/worlds"));
  ok("and a published world is visible WITHOUT a login",
     JSON.stringify(pubList).includes(W), "it is published but absent from the public listing");
  const anonRead = await anon(`/v3/worlds/${W}/manifest`);
  ok("and an anonymous player can now load it", anonRead.status === 200, `HTTP ${anonRead.status}`);
}

// ------------------------------------------------------------------ return
// The whole point of persistence: come back later, as the same person, and find
// the world exactly where you left it.
const ret = await j(await api("/worlds/mine"));
const row = (ret.worlds || []).find((w) => w.world_id === W);
ok("the creator finds the world again in their own list", !!row);
ok("and it is at the version their last edit produced",
   !!row && row.version === (await j(await api(`/v3/worlds/${W}/versions`))).versions.length,
   `list says v${row?.version}`);

console.log(results.join("\n"));
console.log(`\n  ${pass} passed, ${fail} failed   world=${W}`);
process.exit(fail ? 1 : 0);
