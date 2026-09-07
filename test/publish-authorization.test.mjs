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

test("PUBLISH GATE: an ordinary save does not silently unpublish a published world", async () => {
  const { worldId, manifest } = await validManifest();
  const p = await call(TESTER, "POST", `/worlds/${worldId}/publish`, {});
  assert.equal(p.status, 200, JSON.stringify(await p.json()).slice(0, 250));

  const edited = structuredClone(manifest);
  edited.meta.title = "Harbour, revised";
  const s = await call(TESTER, "POST", `/worlds/${worldId}/save`, { manifest: edited });
  assert.equal(s.status, 200, JSON.stringify(await s.json()).slice(0, 250));

  const after = await (await call(TESTER, "GET", `/worlds/${worldId}/load`)).json();
  assert.equal(after.state, "published", "saving an edit must not revert the world to a draft");
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
