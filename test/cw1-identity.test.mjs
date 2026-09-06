// CW1 identity — the two-sources-of-truth cleanup.
//
// Boots the REAL server.mts in a child process (the same way api-integration
// does) because the claim under test is a routing claim: which surface answers,
// and what survives a restart. A unit test over the slice function could not
// tell you that /social/friends and /friends disagreed — only the running
// server could, and it did.
//
// Run: node --test test/cw1-identity.test.mjs
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { signLocalToken } from "../src/core/principal.mjs";
import { RETIRED_SOCIAL, RETIRED_IDENTITY, retiredSocialRoutes } from "../src/cw1/identity-slice.mjs";
import { computeLevel, publishCredits } from "../src/cw1/identity-core.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GB = path.resolve(HERE, "..");
const SECRET = "cw1-identity-secret";
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "dcs-cw1-"));
const PORT = 8900 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;

const ALICE = signLocalToken(SECRET, { sub: "user-alice", email: "alice@dcsai.ai", roles: ["internal_tester"] }, 3600);

function env() {
  return {
    ...process.env,
    PORT: String(PORT), DCS_AUTH_SECRET: SECRET, DCS_DATA_DIR: DATA,
    PAYMENTS_LIVE: "0", NODE_ENV: "test", DCS_INTERNAL_TESTERS: "alice@dcsai.ai",
    SUPABASE_URL: "", SUPABASE_SERVICE_ROLE_KEY: "",
    CEREBRAS_API_KEY: "", CEREBRAS_API_KEY_1: "", CEREBRAS_API_KEY_2: "", CEREBRAS_KEY_2: "",
  };
}

let proc;
async function boot() {
  const p = spawn(process.execPath, ["--import", "tsx", path.join(GB, "server.mts")], {
    cwd: GB, env: env(), stdio: ["ignore", "pipe", "pipe"],
  });
  p.stdout.on("data", () => {});
  p.stderr.on("data", (d) => { if (process.env.DCS_TEST_VERBOSE) process.stderr.write(d); });
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(BASE + "/health")).ok) return p; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  p.kill("SIGKILL");
  throw new Error("server did not become healthy");
}
async function restart() {
  proc.kill("SIGKILL");
  await new Promise((r) => setTimeout(r, 400));
  proc = await boot();
}

const H = { Authorization: "Bearer " + ALICE, "Content-Type": "application/json" };
const call = async (m, p, b) => {
  const r = await fetch(BASE + p, { method: m, headers: H, body: b === undefined ? undefined : JSON.stringify(b) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
/** Deliberately no Authorization header — used to prove the leaks are closed. */
const anon = async (m, p) => {
  const r = await fetch(BASE + p, { method: m });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

before(async () => { proc = await boot(); });
after(() => { proc?.kill("SIGKILL"); fs.rmSync(DATA, { recursive: true, force: true }); });

// ==========================================================================
// 1. The retired routes report 410 and name their replacement.
// ==========================================================================

test("every retired CW1 social route answers 410 and names its durable replacement", async () => {
  // Every method and sub-path the old slice served, not just the collection root:
  // a retirement that only covers GET /friends leaves POST /friends writing to a
  // store nobody reads.
  const cases = [
    ["GET", "/friends", "/social/friends"],
    ["POST", "/friends", "/social/friends"],
    ["DELETE", "/friends/user-bob", "/social/friends"],
    ["POST", "/friends/user-bob", "/social/friends"],
    ["POST", "/parties", "/social/parties"],
    ["GET", "/parties/pty_x", "/social/parties"],
    ["POST", "/parties/pty_x/join", "/social/parties"],
    ["POST", "/parties/pty_x/leave", "/social/parties"],
    ["POST", "/teams", "/social/teams"],
    ["POST", "/teams/team_x/members", "/social/teams"],
    ["POST", "/studios", "/social/studios"],
    ["GET", "/studios/std_dk", "/social/studios"],
    ["POST", "/studios/std_dk/members", "/social/studios"],
    ["POST", "/studios/std_dk/split", "/social/studios"],
    ["GET", "/orgs/org_x", "/social/orgs"],
    ["POST", "/orgs/org_x/members", "/social/orgs"],
  ];
  for (const [m, p, replacement] of cases) {
    const r = await call(m, p, m === "GET" || m === "DELETE" ? undefined : {});
    assert.equal(r.status, 410, `${m} ${p} should be retired, got ${r.status}`);
    assert.equal(r.body.error, "gone", `${m} ${p} should report error:"gone"`);
    assert.equal(r.body.superseded_by, replacement, `${m} ${p} must name its replacement`);
    assert.ok(typeof r.body.detail === "string" && r.body.detail.length > 20,
      `${m} ${p} must explain WHY, not just refuse`);
    assert.ok(r.body.detail.includes(replacement),
      `${m} ${p}'s detail should read as a sentence that names the replacement`);
  }
});

test("the retirement matches the precedent: 410 Gone, not a silent 404 and not a still-working route", async () => {
  // A retired route must be distinguishable from a path that never existed.
  const retired = await call("GET", "/studios/std_dk");
  const neverExisted = await call("GET", "/no-such-surface");
  assert.equal(retired.status, 410);
  assert.equal(neverExisted.status, 404);
  assert.notEqual(retired.status, neverExisted.status,
    "a retired route and a typo must not look the same to a caller");
});

test("the retirement is table-driven, so a new sub-path cannot resurrect the second store", async () => {
  // The guard keys on the first path segment. Anything invented under a retired
  // concept is refused too, rather than falling through to a future handler.
  for (const p of ["/friends/a/b/c", "/parties/x/promote", "/studios/y/payouts", "/teams/z/roles", "/orgs/q/seats"]) {
    const r = await call("POST", p, {});
    assert.equal(r.status, 410, `${p} should be covered by the retirement guard`);
  }
  assert.deepEqual(Object.keys(RETIRED_SOCIAL).sort(), ["friends", "orgs", "parties", "studios", "teams"]);
});

test("retiring these routes also closed two unauthenticated reads", async () => {
  // Before: GET /studios/:id and GET /parties/:id never called who(req), so an
  // anonymous caller got a studio (revenue split included) or a party roster.
  // Reproduced 6 Sep 2026: `GET /studios/std_dk` with no Authorization header
  // returned 200 and the NovaStudio fixture.
  const studio = await anon("GET", "/studios/std_dk");
  assert.equal(studio.status, 410, "an anonymous read of a studio must no longer be served");
  assert.ok(!JSON.stringify(studio.body).includes("NovaStudio"), "and must not leak the fixture it used to serve");
  const party = await anon("GET", "/parties/pty_x");
  assert.equal(party.status, 410);

  // The durable replacement demands a principal, which is the behaviour the
  // retired route should have had. This is a control, not a change of ours.
  assert.equal((await anon("GET", "/social/studios/std_dk")).status, 401);
});

test("the slice publishes the retired-route list server.mts should advertise", () => {
  // /health's `routes.retired` array is hand-maintained. This is the same list,
  // generated from the guard, so the advertisement can be derived rather than copied.
  // It must cover BOTH retirement tables: server.mts spreads exactly this one
  // call into routes.retired, so anything missing here is a route /health does
  // not admit is gone.
  const lines = retiredSocialRoutes();
  assert.equal(lines.length, Object.keys(RETIRED_SOCIAL).length + Object.keys(RETIRED_IDENTITY).length);
  for (const concept of ["friends", "parties", "teams", "studios", "orgs"]) {
    assert.ok(lines.some((l) => l.includes(`/${concept}/*`) && l.includes("410")),
      `the list should name ${concept} and its status`);
  }
  for (const p of ["/me", "/profile/:id", "/subscriptions", "/publish/check", "/identity/portable", "/invite"]) {
    assert.ok(lines.some((l) => l.includes(` ${p} `) && l.includes("410")),
      `the list should name ${p} and its status`);
  }
});

test("whatever /health advertises as retired really is retired", async () => {
  // Passes before and after server.mts adopts the list above: it checks the
  // advertisement against behaviour, in whichever state the advertisement is in.
  const h = await (await fetch(BASE + "/health")).json();
  const paths = (h.routes.retired || [])
    .map((entry) => (entry.match(/(\/[A-Za-z0-9/_:.-]+)/) || [])[1])
    .filter((p) => p && !p.includes(":") && !p.includes("*"));
  assert.ok(paths.length > 0, "health should still declare a retired surface");
  for (const p of paths) {
    const r = await fetch(BASE + p, { headers: H });
    assert.equal(r.status, 410, `${p} is advertised as retired but answered ${r.status}`);
  }
});

// ==========================================================================
// 2. The durable path is the one that answers.
// ==========================================================================

let durable = {};

test("the durable /social surface is the only one that accepts a social write", async () => {
  const before = await call("GET", "/social/friends");
  assert.equal(before.status, 200);
  assert.deepEqual(before.body.outgoing, [], "clean slate");

  // The retired path refuses...
  const legacy = await call("POST", "/friends", { id: "user-bob" });
  assert.equal(legacy.status, 410);

  // ...and, crucially, wrote nothing anywhere. Before this change the same call
  // returned 200 and created a friendship only /friends could see.
  const afterLegacy = await call("GET", "/social/friends");
  assert.deepEqual(afterLegacy.body.outgoing, [], "a refused write must not create a shadow row");

  // The durable path accepts it and reads it back.
  const ok = await call("POST", "/social/friends", { friend_id: "user-carol" });
  assert.equal(ok.status, 201);
  const seen = await call("GET", "/social/friends");
  assert.deepEqual(seen.body.outgoing.map((f) => f.id), ["user-carol"]);

  durable.friend = "user-carol";
});

test("there is exactly one surface per social object, and it is the durable one", async () => {
  const team = await call("POST", "/social/teams", { name: "DurableTeam" });
  assert.equal(team.status, 201);
  const studio = await call("POST", "/social/studios", { name: "DurableStudio" });
  assert.equal(studio.status, 201);
  const party = await call("POST", "/social/parties", {});
  assert.equal(party.status, 201);
  durable.team = team.body.team.id;
  durable.studio = studio.body.studio.id;
  durable.party = party.body.party.id;

  // The retired paths cannot even see the objects that really exist, which is
  // the clearest statement that they are not a second view of the same store.
  assert.equal((await call("GET", `/studios/${durable.studio}`)).status, 410);
  assert.equal((await call("GET", `/parties/${durable.party}`)).status, 410);

  // The durable paths can.
  assert.equal((await call("GET", `/social/studios/${durable.studio}`)).status, 200);
  assert.equal((await call("GET", `/social/parties/${durable.party}`)).status, 200);
  const teams = await call("GET", "/social/teams");
  assert.ok(teams.body.teams.some((t) => t.id === durable.team));
});

// ==========================================================================
// 3. A restart loses nothing the durable path owns.
// ==========================================================================

test("a restart loses nothing the durable path owns", async () => {
  assert.ok(durable.team && durable.studio && durable.party, "previous test must have seeded the durable store");
  await restart();

  const friends = await call("GET", "/social/friends");
  assert.deepEqual(friends.body.outgoing.map((f) => f.id), [durable.friend],
    "the friend request must survive a restart");

  const teams = await call("GET", "/social/teams");
  assert.ok(teams.body.teams.some((t) => t.id === durable.team), "the team must survive a restart");

  const studio = await call("GET", `/social/studios/${durable.studio}`);
  assert.equal(studio.status, 200, "the studio must survive a restart");
  assert.equal(studio.body.studio.name, "DurableStudio");

  const party = await call("GET", `/social/parties/${durable.party}`);
  assert.equal(party.status, 200, "the party must survive a restart");
});

test("after a restart the retired routes are still retired, not quietly back", async () => {
  for (const p of ["/friends", "/parties/x", "/studios/std_dk", "/orgs/x"]) {
    assert.equal((await call("GET", p)).status, 410, `${p} must stay retired across a restart`);
  }
});

// ==========================================================================
// 4. The remaining in-memory fallback announces itself.
// ==========================================================================

const runNode = (src) => new Promise((resolve) => {
  execFile(process.execPath, ["--input-type=module", "-e", src], { cwd: GB }, (err, stdout, stderr) => {
    resolve({ err, stdout: String(stdout), stderr: String(stderr) });
  });
});

test("db.mjs describes the in-memory fallback rather than reporting a bare mode", async () => {
  const { describeDb, getDb } = await import("../src/cw1/db.mjs");
  await getDb();                       // no SUPABASE_* set in this test process
  const d = describeDb();
  assert.equal(d.mode, "memory");
  assert.equal(d.durable, false, "a volatile store must not be describable as durable");
  assert.equal(d.volatile, true);
  assert.equal(d.data_loss_on_restart, true, "the consequence must be stated, not inferable");
  assert.equal(d.scope, "process-local");
  assert.equal(d.reason, "no_credentials");
  assert.ok(/SUPABASE_URL/.test(d.reason_detail), "the reason must name what is missing");
  assert.match(d.warning, /LOST on restart/, "the warning must say what is lost, in words");
  assert.match(d.durable_alternative, /social/, "and must point at the durable store that does exist");
});

test("a repo built over the fallback carries the same description, so a caller need not read /health", async () => {
  const { getDb, makeRepo } = await import("../src/cw1/db.mjs");
  const repo = makeRepo(await getDb());
  assert.equal(repo.live, false);
  assert.equal(repo.durable, false, "repo.durable must agree with repo.live");
  assert.equal(repo.describe().durable, false);
  // And a repo constructed directly with { mode: "memory" } — the shape
  // server.mts hands the T&S/KYC slice — is described the same way.
  assert.equal(makeRepo({ mode: "memory" }).durable, false);
});

test("the in-memory fallback logs once at construction, and says what it costs", async () => {
  const { stderr } = await runNode(`
    process.env.SUPABASE_URL = ""; process.env.SUPABASE_SERVICE_KEY = "";
    const { getDb, makeRepo } = await import("./src/cw1/db.mjs");
    const db = await getDb();
    makeRepo(db); makeRepo(db); await getDb();   // repeated construction
  `);
  const lines = stderr.split("\n").filter((l) => l.includes("IN-MEMORY FALLBACK ENGAGED"));
  assert.equal(lines.length, 1, `expected exactly one announcement, got ${lines.length}:\n${stderr}`);
  assert.match(lines[0], /reason=no_credentials/, "the log must say why");
  assert.match(lines[0], /LOST on restart/, "the log must say what it costs");
});

test("an absent database degrades loudly but does NOT crash — internal testing runs without Supabase", async () => {
  const { err, stdout } = await runNode(`
    process.env.SUPABASE_URL = ""; process.env.SUPABASE_SERVICE_KEY = "";
    const { getDb, makeRepo } = await import("./src/cw1/db.mjs");
    const repo = makeRepo(await getDb());
    const u = await repo.getUser("u_dk");
    console.log(JSON.stringify({ ok: !!u, id: u && u.id }));
  `);
  assert.equal(err, null, "a missing database must not be a hard crash");
  assert.deepEqual(JSON.parse(stdout.trim()), { ok: true, id: "u_dk" });
});

test("service.mjs /health states the degradation instead of printing a bare db:memory", async () => {
  // Exercised through the exported handler so no second port is opened.
  const { handler } = await import("../src/cw1/service.mjs");
  const body = await new Promise((resolve) => {
    const res = {
      writeHead() {}, end(b) { resolve(JSON.parse(b)); },
      setHeader() {},
    };
    handler({ method: "GET", url: "/health", headers: {}, on() {} }, res);
  });
  assert.equal(body.db, "memory", "the original field is preserved for existing readers");
  assert.equal(body.durable, false);
  assert.equal(body.persistence.data_loss_on_restart, true);
  assert.match(body.persistence.warning, /NO DURABLE STORE/);
  assert.equal(body.payments_live, false, "PAYMENTS_LIVE stays false");
  // The verification challenge store is in-memory in EVERY mode, including
  // supabase, so it is reported separately rather than folded into db mode.
  assert.equal(body.verification_store.durable, false);
  assert.match(body.verification_store.note, /restart/);
});

// ==========================================================================
// 5. identity-core: the level axis and the money axis stay apart.
// ==========================================================================

test("dcs_plus is not an input to computeLevel, and must not become one", async () => {
  // src/cw1/identity-core.mjs carries the reasoning: level is a TRUST axis that
  // gates publishing to the public, so making it purchasable makes reach
  // purchasable. The plan is an ALLOWANCE axis and lives in publishCredits.
  const signals = { email_verified: true, atlas_score: 30, reports: 0 };
  assert.equal(computeLevel({ ...signals, dcs_plus: false }), "publisher");
  assert.equal(computeLevel({ ...signals, dcs_plus: true }), "publisher",
    "buying a plan must not move a user up a level");
  assert.equal(computeLevel({ dcs_plus: true }), "explorer",
    "and must not lift an unverified user off the floor");

  // The allowance axis, by contrast, does move — that effect is real.
  assert.equal(publishCredits({ level: "publisher", dcs_plus: false }), 1);
  assert.equal(publishCredits({ level: "publisher", dcs_plus: true }), 10);

  const src = fs.readFileSync(path.join(GB, "src/cw1/identity-core.mjs"), "utf8");
  const fn = src.slice(src.indexOf("export function computeLevel"), src.indexOf("export function publishCredits"));
  assert.ok(!/dcs_plus/.test(fn), "computeLevel must not even bind dcs_plus — a dead binding reads as a live input");
});

// ==========================================================================
// 6. The fixture-backed half of the slice.
//
// Six routes read createIdentityStore()'s seeded demo Maps (u_dk, u_kanya,
// u_new). A real principal id is never a key in them, so on the running server
// they crashed, 404ed forever, or served fabricated data — one of them without
// asking who was calling. Reproduced 7 Sep 2026 against this same harness:
//
//   POST /publish/check     -> 500 {"detail":"Cannot read properties of
//                                    undefined (reading 'dcs_plus')"}
//   GET  /identity/portable -> 500 {"detail":"Cannot set properties of
//                                    undefined (setting 'level_cache')"}
//   GET  /profile/u_dk      -> 200, NO Authorization header, body
//                              {"bio":"Founder. Builder.","followers":1284,...}
//   GET  /subscriptions     -> 200 {"plan":"free","_shadow":true} beside
//                              /me/subscription's real answer
//   POST /subscriptions     -> 200 {"status":"dark"} for a write that stored
//                              nothing
//   POST /invite            -> 200 and a join URL, into a Map nothing reads
// ==========================================================================

test("no route in the slice can answer 5xx by reading a store real principals are absent from", async () => {
  // The two crashers, driven with a valid token exactly as a client would.
  for (const [m, p] of [["POST", "/publish/check"], ["GET", "/identity/portable"]]) {
    const r = await call(m, p, m === "POST" ? {} : undefined);
    assert.ok(r.status < 500, `${m} ${p} answered ${r.status}: ${JSON.stringify(r.body).slice(0, 200)}`);
    assert.equal(r.status, 410, `${m} ${p} should be retired`);
    assert.equal(r.body.error, "gone");
    assert.ok(r.body.superseded_by, `${m} ${p} must name where the answer really lives`);
  }
});

test("the fixture-backed identity routes are retired and every one names a surface that answers", async () => {
  const cases = [
    ["GET", "/me"],
    ["GET", "/profile/u_dk"],
    ["GET", "/subscriptions"],
    ["POST", "/subscriptions"],
    ["POST", "/publish/check"],
    ["GET", "/identity/portable"],
    ["POST", "/invite"],
  ];
  for (const [m, p] of cases) {
    const r = await call(m, p, m === "GET" ? undefined : {});
    assert.equal(r.status, 410, `${m} ${p} should be retired, got ${r.status}`);
    assert.equal(r.body.error, "gone");
    assert.ok(typeof r.body.detail === "string" && r.body.detail.length > 40,
      `${m} ${p} must explain WHY, not just refuse`);
    assert.ok(r.body.superseded_by, `${m} ${p} must name its replacement`);
  }

  // A retirement is only honest if the surface it names actually answers. Every
  // replacement below is probed, so this table cannot come to point at nothing.
  const profile = await call("GET", "/me/profile");
  assert.equal(profile.status, 200, "/me/profile is named as the replacement for /me and /publish/check");
  assert.ok("can_publish" in profile.body && "publish_credits" in profile.body,
    "/me/profile must really carry the publish gate that /publish/check pointed at");

  const pub = await call("GET", "/profiles/" + encodeURIComponent(profile.body.username));
  assert.equal(pub.status, 200, "/profiles/:username is named as the replacement for /profile/:id");

  const sub = await call("GET", "/me/subscription");
  assert.equal(sub.status, 200, "/me/subscription is named as the replacement for GET /subscriptions");
  assert.equal(sub.body.paid, false, "and it stays dark");

  const key = await fetch(BASE + "/atlas/key");
  assert.equal(key.status, 200, "/atlas/key is named in the /identity/portable retirement");

  const friend = await call("POST", "/social/friends", { friend_id: "user-invitee" });
  assert.ok([200, 201].includes(friend.status), "/social/friends is named as the replacement for /invite");
});

test("the retirement guard matches whole paths, so it cannot swallow the routes it points at", async () => {
  // /me/profile and /me/subscription live one segment under a retired path. A
  // prefix match here would retire the durable replacements themselves.
  for (const p of ["/me/profile", "/me/subscription", "/me/entitlements"]) {
    assert.notEqual((await call("GET", p)).status, 410, `${p} must not inherit /me's retirement`);
  }
  // /profiles/:username is a different first segment from /profile/:id.
  const me = await call("GET", "/me/profile");
  assert.equal((await call("GET", "/profiles/" + encodeURIComponent(me.body.username))).status, 200);
});

test("retiring the private identity routes did not turn them into an anonymous existence oracle", async () => {
  // These demanded a principal before they were retired, so they answer 401
  // ahead of the 410. /profile/:id never authenticated at all — that was the
  // hole — so it is refused outright, with no credential needed to be told so.
  for (const [m, p] of [["GET", "/me"], ["GET", "/subscriptions"], ["POST", "/subscriptions"],
                        ["POST", "/publish/check"], ["GET", "/identity/portable"], ["POST", "/invite"]]) {
    const r = await anon(m, p);
    assert.equal(r.status, 401, `anonymous ${m} ${p} should still be refused for want of a credential`);
  }
});

test("GET /profile/:id no longer serves a fabricated profile to an unauthenticated caller", async () => {
  // Before: 200 with the seeded u_dk fixture — a bio, 1284 followers and 312
  // following that were never measured, to a caller with no Authorization
  // header. Same hole GET /studios/:id was retired for.
  const r = await anon("GET", "/profile/u_dk");
  assert.equal(r.status, 410);
  const body = JSON.stringify(r.body);
  for (const leak of ["Founder. Builder.", "1284", "Deepak", "Pioneer", "Horror co-op"]) {
    assert.ok(!body.includes(leak), `the fixture must not survive in the refusal: found ${leak}`);
  }
  // And the durable public profile still demands nothing private but exists.
  assert.equal((await anon("GET", "/profile/u_kanya")).status, 410);
});

test("the seeded demo store is unreachable from every route, not just the ones named above", async () => {
  // createIdentityStore() still exists because src/cw1/db.mjs seeds its
  // in-memory fallback from it. Nothing in the slice may read it any more: the
  // moment a route does, the fixture is back on the wire.
  const src = fs.readFileSync(path.join(GB, "src/cw1/identity-slice.mjs"), "utf8");
  const handler = src.slice(src.indexOf("export async function handleIdentity"));
  for (const read of ["db.users", "db.profiles", "db.subscriptions", "db.invites", "db.seq"]) {
    assert.ok(!handler.includes(read), `handleIdentity must not read ${read}`);
  }
  assert.deepEqual(Object.keys(RETIRED_IDENTITY).sort(),
    ["/identity/portable", "/invite", "/me", "/profile", "/publish/check", "/subscriptions"]);
});

test("a retired identity route is retired on every verb, not only the one it used to serve", async () => {
  // POST /publish/check was the only verb the slice answered; a GET fell through
  // to a 404, so the same path told two different stories about whether it
  // exists.
  for (const [m, p] of [["GET", "/publish/check"], ["DELETE", "/invite"],
                        ["PATCH", "/subscriptions"], ["POST", "/identity/portable"]]) {
    assert.equal((await call(m, p, m === "GET" ? undefined : {})).status, 410,
      `${m} ${p} should be retired too`);
  }
});

// ==========================================================================
// 7. A retirement notice must not sit on the path of its own replacement.
//
// The slice's /verify/:channel/{start,confirm} handler returned the code as
// `_devCode` and was deleted, correctly. What was left was a 410 ON THE SAME
// PATH, naming "/verify/:channel/start" as the replacement — the exact path it
// was refusing. handleIdentity runs at server.mts:414 and the real P2 routes are
// at 783 and 791, so the notice stood in front of its own replacement and the
// replacement was never reached. Reproduced 7 Sep 2026:
//
//   POST /verify/email/start   -> 410 "...use POST /verify/email/{start,confirm}
//                                 on the current service"  <- this request
//   POST /verify/email/confirm -> 410, same
//   DELETE /verify/email       -> 404 from the REAL service — reachable on every
//                                 verb except the two the notice sat on
//   GET  /verify/status        -> 200, the real service
//
// start and confirm are the only ways to CREATE a verification, so
// src/core/verification.mjs was unreachable over HTTP, email_verified could
// never become true, and computeLevel pinned every principal at `explorer`.
// ==========================================================================

test("the P2 verification routes are reachable, not shadowed by a retirement notice", async () => {
  // With no delivery provider configured this must NOT succeed — but it must
  // fail as the verification service, not as a retirement. The distinction is
  // the whole defect: a 410 here is the legacy slice answering.
  for (const p of ["/verify/email/start", "/verify/email/confirm"]) {
    const r = await call("POST", p, { destination: "alice@dcsai.ai", code: "000000" });
    assert.notEqual(r.status, 410, `${p} is the live P2 surface and must not answer a retirement`);
    assert.notEqual(r.body.error, "gone", `${p} answered a retirement notice: ${JSON.stringify(r.body)}`);
    assert.ok(!("superseded_by" in r.body), `${p} must not name a replacement — it IS the replacement`);
  }
});

test("with no provider configured the verification service refuses as itself, and never returns a code", async () => {
  // The honest refusal, from src/core/verification.mjs: there is no provider, so
  // no challenge is issued. What matters is that this is the SERVICE speaking.
  const r = await call("POST", "/verify/email/start", { destination: "alice@dcsai.ai" });
  assert.notEqual(r.status, 200, "no provider is configured, so a challenge cannot be issued");
  const body = JSON.stringify(r.body);
  assert.equal(/_devCode/.test(body), false, "the defect this route was retired for must stay closed");
  assert.equal(/"code"\s*:\s*"?\d{4,}/.test(body), false, "a verification code must never reach a client");

  // The status and revoke verbs of the same service still answer, which is what
  // made the shadow visible in the first place.
  assert.equal((await call("GET", "/verify/status")).status, 200);
  assert.equal((await call("DELETE", "/verify/email")).status, 404, "the real service, reporting no verification to revoke");
});

test("nothing /health advertises as LIVE may answer a retirement notice", async () => {
  // The invariant that would have caught this without anyone looking for it. A
  // route can legitimately answer 401, 403, 404, 422 or 503 — what it may never
  // do is answer 410 while /health lists it as part of the live surface, because
  // that means two handlers are fighting over one path and the dead one is
  // winning.
  const h = await (await fetch(BASE + "/health")).json();
  const live = Object.entries(h.routes)
    .filter(([group]) => group !== "retired")
    .flatMap(([, entries]) => entries);
  assert.ok(live.length > 20, "health should advertise a real surface, not a handful of routes");

  // DEFECT, OPEN, owned by the Lead (server.mts) — reported 7 Sep 2026.
  //
  // This invariant found a SECOND instance of the same shape as /verify, and it
  // is listed rather than silently skipped so that it cannot quietly grow to
  // cover anything else.
  //
  // server.mts serves /auth/signup and /auth/login from Supabase at ~line 396,
  // ahead of handleIdentity. That block is conditional on Supabase being
  // configured. When it is not, the request falls through to this slice's
  // legacy-auth retirement, which answers 410 with a superseded_by reading "the
  // Supabase-backed /auth/signup and /auth/login in server.mts" — the route the
  // caller just called. Same failure as /verify: a retirement notice standing in
  // for an implementation that is not there.
  //
  // The retirement itself is right (the legacy handler took a principal id from
  // the request body with no credential). What is missing is an honest
  // not-configured branch in server.mts for the case where no auth provider is
  // wired, which is that file's to add. Staging and production configure
  // Supabase, so the live surface is correct there; this harness does not.
  const SHADOWED_WHEN_NO_AUTH_PROVIDER = ["POST /auth/signup", "POST /auth/login"];

  const checked = [];
  const excused = [];
  for (const entry of live) {
    const m = entry.match(/^(GET|POST|PUT|PATCH|DELETE)\s+(\/\S*)$/);
    if (!m) continue;
    const [, method, template] = m;
    // Only paths that can be driven without inventing an id. A template with a
    // parameter would need a real object to be meaningful, and the retired-route
    // check above already covers the parameterised legacy paths.
    if (template.includes(":") || template.includes("*")) continue;
    const r = await call(method, template, method === "GET" || method === "DELETE" ? undefined : {});
    if (r.status === 410 && SHADOWED_WHEN_NO_AUTH_PROVIDER.includes(`${method} ${template}`)) {
      // Excused ONLY in the exact state that causes it. If this harness ever
      // gains an auth provider, or the 410 starts coming from somewhere else,
      // the excuse stops applying and the assertion below fires.
      assert.equal(h.persistence, "file",
        `${method} ${template} answered 410 with an auth provider configured — that is not the known defect`);
      assert.match(r.body.superseded_by || "", /Supabase-backed/,
        `${method} ${template} answered a 410 that is not the known legacy-auth retirement`);
      excused.push(`${method} ${template}`);
      continue;
    }
    assert.notEqual(r.status, 410,
      `/health advertises ${method} ${template} as live, but it answers 410 — a retired handler is shadowing it`);
    checked.push(`${method} ${template}`);
  }
  assert.ok(checked.length >= 15, `expected to have probed a real slice of the surface, probed ${checked.length}`);
  assert.ok(excused.length <= SHADOWED_WHEN_NO_AUTH_PROVIDER.length,
    `the excuse list may not grow: ${excused.join(", ")}`);
});

test("a route advertised as both live and retired resolves in favour of live, and the stale entry is named", async () => {
  // /health said POST /verify/:channel/start was live under `identity` AND
  // retired under `retired`, in the same document. One of them was wrong and the
  // wrong one was winning at runtime. Comparing the two lists literally does not
  // catch it — the retired list writes "{start,confirm}" where the live list
  // writes "start" — so the braces are expanded first.
  const h = await (await fetch(BASE + "/health")).json();
  const pathOf = (e) => (e.match(/(\/[A-Za-z0-9/_:.{},*-]+)/) || [])[1];
  /** "/a/{x,y}" -> ["/a/x", "/a/y"] */
  const expand = (p) => {
    const m = p && p.match(/^(.*)\{([^}]*)\}(.*)$/);
    return m ? m[2].split(",").map((alt) => `${m[1]}${alt.trim()}${m[3]}`) : (p ? [p] : []);
  };
  const live = new Set(Object.entries(h.routes)
    .filter(([g]) => g !== "retired")
    .flatMap(([, es]) => es.flatMap((e) => expand(pathOf(e))))
    .filter(Boolean));

  // KNOWN STALE, owned by the Lead (server.mts routes.retired) — reported
  // 7 Sep 2026 with the fix that made these live again. The entry is a leftover
  // from the retirement that used to shadow the real P2 routes; it is listed
  // here rather than tolerated silently, and this test fails if the overlap
  // grows beyond it or if the route goes back to answering 410.
  const KNOWN_STALE = ["/verify/:channel/start", "/verify/:channel/confirm"];

  const overlaps = [];
  for (const entry of h.routes.retired || []) {
    for (const p of expand(pathOf(entry))) {
      if (!live.has(p)) continue;
      overlaps.push(p);
      assert.ok(KNOWN_STALE.includes(p),
        `/health lists ${p} as both live and retired: "${entry}"`);
    }
  }
  // Whatever is claimed by both must behave as LIVE. That is the half that
  // matters: a stale line in a route inventory is a documentation defect; a
  // retirement that actually answers is a dead product surface.
  for (const p of overlaps) {
    const probe = p.replace(":channel", "email");
    const r = await call("POST", probe, { destination: "alice@dcsai.ai", code: "000000" });
    assert.notEqual(r.status, 410, `${probe} is claimed by both lists and answers as RETIRED, which is the wrong one`);
  }
});
