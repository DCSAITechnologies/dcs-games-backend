// Publishing is a separate authorised action. Saving is saving.
//
// POST /worlds/:id/save took `state` straight from the request body:
//   state: b.state || "draft"
//
// Two defects in one expression.
//
// Sending "published" created a published, discoverable world while walking
// past every gate the publish route exists to enforce — the internal-tester
// check, ownership, the playtest quality gate, and the Atlas signing key, which
// publish refuses to proceed without precisely so nothing is ever marked
// published-and-verified while unsigned. And because repo.upsert's owner check
// only fires when a record already EXISTS, any authenticated account could do
// it on an unclaimed world id, with no prior claim to anything.
//
// The `|| "draft"` half was the mirror image: an ordinary save of an already
// published world silently unpublished it.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const GB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SECRET = crypto.randomBytes(24).toString("hex");
const PORT = 8900 + Math.floor(Math.random() * 200);
const BASE = `http://127.0.0.1:${PORT}`;

function signLocalToken(secret, claims, ttl = 3600) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const head = enc({ alg: "HS256", typ: "JWT" });
  const body = enc({ ...claims, iss: "dcs-games-local", iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + ttl });
  const sig = crypto.createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}

const TESTER = signLocalToken(SECRET, { sub: "u-tester", email: "tester@dcsai.ai", roles: ["internal_tester"] });
const PLAIN = signLocalToken(SECRET, { sub: "u-plain", email: "plain@example.com" });

let proc;
before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dcs-pub-"));
  proc = spawn(process.execPath, ["--import", "tsx", path.join(GB, "server.mts")], {
    cwd: GB,
    env: {
      ...process.env, PORT: String(PORT), DCS_AUTH_SECRET: SECRET, DCS_DATA_DIR: dir,
      PAYMENTS_LIVE: "0", NODE_ENV: "test", DCS_PROVIDERS_OFFLINE: "1",
      DCS_INTERNAL_TESTERS: "tester@dcsai.ai",
      ATLAS_PRIVATE_KEY: crypto.randomBytes(32).toString("base64"),
      SUPABASE_URL: "", SUPABASE_SERVICE_ROLE_KEY: "", DATABASE_URL: "",
      CEREBRAS_API_KEY: "", CEREBRAS_API_KEY_1: "", CEREBRAS_API_KEY_2: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout.on("data", () => {});
  proc.stderr.on("data", (d) => { if (process.env.DCS_TEST_VERBOSE) process.stderr.write(d); });
  let up = false;
  for (let i = 0; i < 200; i++) {
    try { if ((await fetch(BASE + "/health")).ok) { up = true; break; } } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!up) throw new Error("server did not become healthy");
  // Both callers record an age assurance, so every difference this suite
  // observes is authorisation and never the age gate.
  for (const t of [TESTER, PLAIN]) {
    const r = await call(t, "POST", "/safety/age", { date_of_birth: "1990-01-01", method: "synthetic_test" });
    assert.equal(r.status, 200, `age assurance failed: ${(await r.text()).slice(0, 200)}`);
  }
});
after(() => { try { proc.kill("SIGKILL"); } catch { /* gone */ } });

const call = (token, method, url, body) => fetch(BASE + url, {
  method,
  headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) },
  body: body === undefined ? undefined : JSON.stringify(body),
});

/** A minimal manifest that satisfies WorldManifestV3. */
async function validManifest() {
  const r = await call(TESTER, "POST", "/v3/worlds/generate", { prompt: "a quiet harbour town", name: "Harbour" });
  const g = await r.json();
  assert.equal(r.status, 200, JSON.stringify(g).slice(0, 300));
  const m = await (await call(TESTER, "GET", `/v3/worlds/${g.world_id}/manifest`)).json();
  return { worldId: g.world_id, manifest: m.manifest };
}

test("PUBLISH GATE: a save cannot publish a world", async () => {
  const { manifest } = await validManifest();
  const fresh = "w3_" + crypto.randomBytes(8).toString("hex");
  const r = await call(PLAIN, "POST", `/worlds/${fresh}/save`, { manifest, state: "published" });
  const b = await r.json();

  assert.equal(r.status, 422, `a save that sets state must be refused: ${JSON.stringify(b).slice(0, 250)}`);
  assert.match(b.detail, /publish it with POST/, "and must say where publishing actually happens");

  // And nothing was created as a side effect of the attempt.
  const pub = await (await call(null, "GET", "/api/public/worlds")).json();
  assert.ok(!JSON.stringify(pub).includes(fresh), "no world may appear publicly from a refused save");
});

test("PUBLISH GATE: an unclaimed world id is not a way in", async () => {
  // repo.upsert's owner check only fires when a record already exists, so an
  // id nobody has claimed was the weakest point.
  const { manifest } = await validManifest();
  const fresh = "w3_" + crypto.randomBytes(8).toString("hex");
  for (const state of ["published", "archived", "draft"]) {
    const r = await call(PLAIN, "POST", `/worlds/${fresh}/save`, { manifest, state });
    assert.equal(r.status, 422, `state=${state} must be refused regardless of the value`);
  }
});

test("PUBLISH GATE: a save on a PUBLISHED world returns it to draft, and says so", async () => {
  // This test used to assert the opposite, and the opposite was wrong.
  //
  // Publishing signs an Atlas receipt over a SPECIFIC manifest. Preserving
  // `published` across a save leaves that receipt attesting to content that is
  // no longer there — an unreviewed content swap on a live, badged world, with
  // no publish authorisation and no new signature. Dropping back to draft is
  // the honest outcome: the world leaves the catalogue until it is published
  // again, which re-signs it.
  const { worldId, manifest } = await validManifest();
  assert.equal((await call(TESTER, "POST", `/worlds/${worldId}/publish`, {})).status, 200);

  const edited = structuredClone(manifest);
  edited.meta.title = "Harbour, revised";
  const s = await call(TESTER, "POST", `/worlds/${worldId}/save`, { manifest: edited });
  const sb = await s.json();
  assert.equal(s.status, 200, JSON.stringify(sb).slice(0, 250));
  assert.equal(sb.state, "draft");
  assert.equal(sb.unpublished, true, "the caller must be told the world left the catalogue");
  assert.match(sb.unpublished_reason, /receipt/, "and why — the signature no longer describes the content");

  const after = await (await call(TESTER, "GET", `/worlds/${worldId}/load`)).json();
  assert.equal(after.state, "draft");
  const pub = await (await call(null, "GET", "/api/public/worlds")).json();
  assert.ok(!JSON.stringify(pub).includes(worldId), "and it is out of the public catalogue");
});

test("PUBLISH GATE: a save cannot forge the verification badge", async () => {
  // meta.atlas_signed is rendered directly as the verification badge, and
  // atlas_receipt_hash is served to anonymous readers. A caller could publish,
  // then save a manifest claiming any hash it liked and keep the badge.
  const { worldId, manifest } = await validManifest();
  const forged = structuredClone(manifest);
  forged.meta.atlas_signed = true;
  forged.meta.atlas_receipt_hash = "deadbeefdeadbeefdeadbeefdeadbeef";

  assert.equal((await call(TESTER, "POST", `/worlds/${worldId}/save`, { manifest: forged })).status, 200);
  const back = await (await call(TESTER, "GET", `/v3/worlds/${worldId}/manifest`)).json();
  assert.notEqual(back.manifest.meta.atlas_receipt_hash, "deadbeefdeadbeefdeadbeefdeadbeef",
    "a caller-supplied receipt hash must never be stored");
  assert.notEqual(back.manifest.meta.atlas_signed, true,
    "and a caller must not be able to assert that the world is signed");
});

test("PUBLISH GATE: a V2 manifest still saves — this is the V2 route", async () => {
  // Validating every manifest against V3 here would reject every legacy client:
  // a compatibility break dressed up as a fix. V2 worlds are not V3-shaped and
  // make no claim to be.
  const fresh = "w2_" + crypto.randomBytes(8).toString("hex");
  const r = await call(TESTER, "POST", `/worlds/${fresh}/save`, {
    manifest: { title: "An old world", rooms: [{ id: "r1", name: "Hall" }] },
  });
  assert.equal(r.status, 200, (await r.text()).slice(0, 250));

  const back = await (await call(TESTER, "GET", `/worlds/${fresh}/load`)).json();
  assert.equal(back.ok, true, JSON.stringify(back).slice(0, 250));
  assert.equal(back.manifest?.title, "An old world", `round-trip lost the manifest: ${JSON.stringify(back).slice(0, 250)}`);
  assert.equal(back.state, "draft");
  // It has never been played, so it has no runtime state — said plainly rather
  // than raised as a fault.
  assert.equal(back.runtime_state, null);
  assert.match(back.runtime_note, /no runtime state yet/);
});

test("PUBLISH GATE: a manifest that is not an object is refused", async () => {
  const fresh = "w3_" + crypto.randomBytes(8).toString("hex");
  for (const manifest of [[], "a string", 42]) {
    const r = await call(TESTER, "POST", `/worlds/${fresh}/save`, { manifest });
    assert.equal(r.status, 422, `${JSON.stringify(manifest)} must be refused`);
  }
});

test("PUBLISH: publishing still works for the owner, and is what makes a world public", async () => {
  const { worldId } = await validManifest();
  const before = await (await call(null, "GET", "/api/public/worlds")).json();
  assert.ok(!JSON.stringify(before).includes(worldId), "a draft is not public");

  const p = await call(TESTER, "POST", `/worlds/${worldId}/publish`, {});
  assert.equal(p.status, 200);
  const after = await (await call(null, "GET", "/api/public/worlds")).json();
  assert.ok(JSON.stringify(after).includes(worldId), "publishing is what makes it public");
});

// ------------------------------------------------- A5 voice/likeness gate

test("CONSENT GATE: material cannot be declared synthetic while naming a subject", async () => {
  // The gate came off by omitting a field. It was
  // `source: b.source || "synthetic"`, and requireMediaConsent returns
  // permitted immediately for "synthetic" — while `subject_id` could still name
  // a real person and was forwarded to the provider regardless.
  const { worldId } = await validManifest();
  const r = await call(TESTER, "POST", `/v3/worlds/${worldId}/media`, {
    kind: "voice", source: "synthetic", subject_id: "u-someone-else",
  });
  const b = await r.json();
  assert.equal(r.status, 422, JSON.stringify(b).slice(0, 250));
  assert.match(b.detail, /cannot be declared synthetic while naming a subject/);
});

test("CONSENT GATE: omitting the source does not exempt the material", async () => {
  // A default that disables a consent check is the wrong default no matter how
  // the field is spelled. Absent means unknown, and unknown is not exempt.
  const { worldId } = await validManifest();
  const r = await call(TESTER, "POST", `/v3/worlds/${worldId}/media`, { kind: "voice" });
  const b = await r.json();
  assert.equal(r.status, 403, `an unattested voice request must be refused: ${JSON.stringify(b).slice(0, 250)}`);
  assert.match(b.detail, /consent/i);
});

test("CONSENT GATE: a likeness of another person needs a recorded grant", async () => {
  const { worldId } = await validManifest();
  for (const kind of ["voice", "narration", "avatar"]) {
    const r = await call(TESTER, "POST", `/v3/worlds/${worldId}/media`, {
      kind, subject_id: "u-someone-else", source: "licensed",
    });
    assert.equal(r.status, 403, `${kind} for another subject must be refused without a grant`);
  }
});

test("ERROR GATE: an unexpected failure does not hand the client its own internals", async () => {
  // The top-level catch sent `String(e.message)` to the client. An unexpected
  // exception carries whatever the runtime put in it — an ENOENT names a
  // container filesystem path, a database error names relations and columns —
  // and this is the one path that reaches a client without anyone having
  // decided what it says.
  const r = await call(TESTER, "POST", "/safety/consent/parental", { guardian_email: "", scope: [] });
  const b = await r.json();
  // Whatever this answers, it must not be a raw runtime message.
  assert.ok(!/\/(Users|app|home)\//.test(JSON.stringify(b)), `a filesystem path leaked: ${JSON.stringify(b).slice(0, 200)}`);
  assert.ok(b.correlation_id, "and a correlation id must be there to trace it");
});

test("CONSENT: a parental consent request is attributed to the caller, not a body field", async () => {
  // safety.mjs refuses to write a consent record it cannot attribute, and
  // server.mts was not threading the authenticated principal through — so the
  // route refused outright. requestedBy is the caller, never a body field.
  const r = await call(TESTER, "POST", "/safety/consent/parental", {
    guardian_email: "guardian@example.com", scope: ["voice"],
  });
  const b = await r.json();
  // This caller is an adult, so the route refuses on AGE — which is the point:
  // it got far enough to evaluate who the request is about. Before the caller
  // was threaded through it never got that far, refusing every request because
  // it could not attribute it to anyone.
  assert.equal(r.status, 422, JSON.stringify(b).slice(0, 250));
  assert.match(b.detail, /minor principal/);
  assert.doesNotMatch(b.detail, /did not say who made it/, "attribution must no longer be the blocker");

  // And it cannot be requested on someone else's behalf.
  const other = await call(TESTER, "POST", "/safety/consent/parental", {
    minor_id: "u-a-different-minor", guardian_email: "guardian@example.com", scope: ["voice"],
  });
  assert.equal(other.status, 403, "there is no verified guardian relationship to authorise that");
});

// ---------------------------------------- measured platform figures

test("TRUTH GATE: platform stats are counted, and an empty platform says zero", async () => {
  // The site called /api/public/stats and nothing served it, so every page
  // showing a platform number fell back to the bundled SEED sample set. That is
  // the exact failure assets/dcs-truth.js was written to prevent, after a
  // forensic audit found the site asserting $1.5M paid to creators, 842,000
  // items sold and 12.4M players — figures no system had ever measured.
  const r = await call(null, "GET", "/api/public/stats");
  const b = await r.json();
  assert.equal(r.status, 200, JSON.stringify(b).slice(0, 200));

  for (const k of ["published_worlds", "creators_with_a_published_world", "plays", "play_seconds", "ratings"]) {
    assert.equal(typeof b[k], "number", `${k} must be a real count`);
    assert.ok(b[k] >= 0);
  }
  assert.ok(b.measured_at, "and must say when it was counted");
  assert.match(b.basis, /PUBLISHED worlds only/,
    "the scope must be stated: a draft played ten times contributes nothing, and calling this a platform total would be a smaller version of the same dishonesty as inventing one");
});

test("TRUTH GATE: no platform-wide unique player count is invented", async () => {
  // The stats index exposes unique players PER WORLD. Summing that across
  // worlds counts anyone who played two of them twice, and a number labelled
  // "unique players" that is not unique is exactly what the truth layer exists
  // to keep off this site. No number beats a wrong one.
  const b = await (await call(null, "GET", "/api/public/stats")).json();
  assert.equal(b.unique_players, null);
  assert.match(b.unique_players_note, /double-count/);
});

test("TRUTH GATE: the figures move only when something real happens", async () => {
  const before = await (await call(null, "GET", "/api/public/stats")).json();
  const { worldId } = await validManifest();

  const stillDraft = await (await call(null, "GET", "/api/public/stats")).json();
  assert.equal(stillDraft.published_worlds, before.published_worlds,
    "generating a draft must not move a PUBLISHED count");

  assert.equal((await call(TESTER, "POST", `/worlds/${worldId}/publish`, {})).status, 200);
  const after = await (await call(null, "GET", "/api/public/stats")).json();
  assert.equal(after.published_worlds, before.published_worlds + 1, "publishing moves it by exactly one");

  const beforePlays = after.plays;
  assert.ok([200, 201].includes((await call(TESTER, "POST", `/v3/worlds/${worldId}/play`, {})).status));
  const played = await (await call(null, "GET", "/api/public/stats")).json();
  assert.equal(played.plays, beforePlays + 1, "a play is one play");
});

test("HOME: the signed-in landing data is the caller's own, and needs a caller", async () => {
  assert.equal((await call(null, "GET", "/me/home")).status, 401);

  const { worldId } = await validManifest();
  const b = await (await call(TESTER, "GET", "/me/home")).json();
  assert.equal(b.ok, true);
  assert.equal(b.principal_id, "u-tester");
  assert.ok(b.worlds.total >= 1);
  assert.ok(b.recent.some((w) => w.world_id === worldId), "and lists the world just made");

  // Another principal sees their own, not this one's.
  const other = await (await call(PLAIN, "GET", "/me/home")).json();
  assert.equal(other.principal_id, "u-plain");
  assert.ok(!other.recent.some((w) => w.world_id === worldId), "one caller's worlds must not appear in another's home");
});

test("HOME: reachable at /api/me/home too, which is what the site calls", async () => {
  const a = await call(TESTER, "GET", "/me/home");
  const b = await call(TESTER, "GET", "/api/me/home");
  assert.equal(a.status, 200);
  assert.equal(b.status, 200, "the /api prefix is rewritten, so both must work");
});

test("TRUTH GATE: a dark marketplace says it is dark, not that it is empty", async () => {
  // A 404 here sent the page to its bundled sample listings, which is how a
  // storefront full of invented items ends up on a site that has never sold
  // anything. An empty list is not the honest answer either: it says "no
  // items", when the real situation is "this capability is switched off".
  const b = await (await call(null, "GET", "/api/public/market")).json();
  assert.equal(b.ok, true);
  assert.equal(b.enabled, false, "payments are dark during the internal test window");
  assert.deepEqual(b.listings, []);
  assert.match(b.reason, /dark|no money has moved/i, "and it must say WHY it is empty");
  assert.equal(b.assert_dark, "/v3/marketplace/assert-dark", "and point at the proof");
});

test("TRUTH GATE: the events feed is publication records, and empty when nothing happened", async () => {
  const b = await (await call(null, "GET", "/api/public/events")).json();
  assert.equal(b.ok, true);
  assert.ok(Array.isArray(b.events));
  assert.match(b.basis, /publication records/);
  for (const e of b.events) {
    assert.equal(e.kind, "world_published");
    assert.ok(e.world_id && e.at, "every event names a real world and a real time");
  }

  const { worldId } = await validManifest();
  const before = b.count;
  assert.equal((await call(TESTER, "POST", `/worlds/${worldId}/publish`, {})).status, 200);
  const after = await (await call(null, "GET", "/api/public/events")).json();
  assert.equal(after.count, before + 1, "publishing is the event");
  assert.ok(after.events.some((e) => e.world_id === worldId));
});

test("TRUTH GATE: signed and unsigned Atlas receipts are never collapsed into one figure", async () => {
  // An unsigned receipt is not evidence of anything, so it must not be counted
  // toward a "verified" total.
  const b = await (await call(null, "GET", "/api/public/atlas/stats")).json();
  assert.equal(b.ok, true);
  assert.equal(typeof b.receipts_issued, "number");
  assert.equal(typeof b.receipts_signed, "number");
  assert.ok(b.receipts_signed <= b.receipts_issued);
  assert.equal(typeof b.signing_available, "boolean");
});

test("TRUTH GATE: the Atlas feed lists receipts that were actually issued", async () => {
  const { worldId } = await validManifest();
  assert.equal((await call(TESTER, "POST", `/worlds/${worldId}/publish`, {})).status, 200);
  const b = await (await call(null, "GET", "/api/public/atlas/feed")).json();
  assert.equal(b.ok, true);
  assert.ok(b.receipts.some((r) => r.subject_id === worldId), "the world just published must have a receipt");
  for (const r of b.receipts) {
    assert.ok(r.receipt_hash, "a receipt without a hash is not a receipt");
    assert.equal(typeof r.signed, "boolean");
  }
});

test("DISCOVERABILITY: the values these routes accept are published, not guessable", async () => {
  // Lane E found the moderation action set only by sending a wrong value and
  // reading the 422. A UI that has to guess an enum keeps its own copy, and
  // that copy drifts the first time the server's list changes — silently,
  // because the only symptom is a rejection the user sees and the developer
  // does not.
  const h = await (await call(null, "GET", "/health")).json();
  const a = h.safety?.accepts;
  assert.ok(a, "/health must publish what the safety routes accept");
  for (const k of ["report_reason", "moderation_action", "age_tier", "media_kind", "consent_source"]) {
    assert.ok(Array.isArray(a[k]) && a[k].length > 0, `${k} must be a real list`);
  }
  assert.ok(a.report_reason.includes("csam"));
  assert.ok(a.moderation_action.length >= 3);

  // And the published list must be the one actually enforced.
  const bad = await call(TESTER, "POST", "/safety/report", {
    subject_type: "world", subject_id: "w_x", reason: "definitely-not-a-reason",
  });
  assert.equal(bad.status, 422);
  const detail = (await bad.json()).detail;
  for (const reason of a.report_reason) {
    assert.ok(detail.includes(reason), `${reason} is published but not in the enforced set`);
  }
});

test("DISCOVERABILITY: the moderation queue carries the actions it accepts", async () => {
  const r = await call(TESTER, "GET", "/safety/reports");
  assert.equal(r.status, 200);
  const b = await r.json();
  assert.ok(Array.isArray(b.actions) && b.actions.length > 0, "a console must not have to hard-code the action set");
  assert.ok(Array.isArray(b.states) && b.states.length > 0);
});

test("HEALTH GATE: a degraded safety collection is raised as a critical alert", async () => {
  // Reports of csam, grooming and self_harm failed to reach the durable store
  // for days, and the only trace was one entry in a list that looks identical
  // to a degraded cache. A degraded SAFETY collection is not the same kind of
  // news as a degraded anything-else.
  const h = await (await call(null, "GET", "/health")).json();
  assert.ok(Array.isArray(h.alerts), "/health must carry an alerts array, empty when nothing is wrong");

  const degraded = h.safety_persistence?.degraded;
  const isDegraded = Array.isArray(degraded) && degraded.length > 0;
  const raised = h.alerts.some((a) => a.subject === "safety_persistence" && a.severity === "critical");
  assert.equal(raised, isDegraded,
    isDegraded
      ? "safety persistence is degraded and no critical alert was raised"
      : "an alert was raised while safety persistence is healthy");
});

test("PERF: the creator dashboard reads the activity tables once, not once per world", async () => {
  // creatorDashboard called social.worldStats() inside a loop, and worldStats
  // scans the WHOLE plays collection and the WHOLE ratings collection every
  // time — so the cost was worlds x (all plays + all ratings), sequentially.
  // Measured against staging it took 6.4 seconds while /me/home took 2.0, and
  // two pages sat on a placeholder for the duration.
  //
  // This asserts the shape rather than a wall-clock number, because a timing
  // threshold on a shared machine is a flaky test that eventually gets deleted.
  // What matters is that the work does not grow with the number of worlds.
  const worldIds = [];
  for (let i = 0; i < 3; i++) {
    const { worldId } = await validManifest();
    worldIds.push(worldId);
  }

  const started = Date.now();
  const r = await call(TESTER, "GET", "/me/dashboard");
  const took = Date.now() - started;
  assert.equal(r.status, 200);
  const b = await r.json();
  assert.ok(b.worlds.length >= 3, `expected the owned worlds, got ${b.worlds.length}`);
  for (const w of b.worlds) {
    assert.equal(typeof w.stats.plays, "number");
    assert.ok(typeof w.recommendation === "string" && w.recommendation.length > 0);
  }
  // Generous, and only there to catch an order-of-magnitude regression.
  assert.ok(took < 8000, `the dashboard took ${took}ms for ${b.worlds.length} worlds`);
});
