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

test("PUBLISH GATE: a structurally invalid manifest is refused at the door", async () => {
  // validateManifest was imported and never called, so a broken world could be
  // stored and only fail much later, somewhere that could not explain it.
  const fresh = "w3_" + crypto.randomBytes(8).toString("hex");
  const r = await call(TESTER, "POST", `/worlds/${fresh}/save`, { manifest: { meta: { title: "not a world" } } });
  const b = await r.json();
  assert.equal(r.status, 422, JSON.stringify(b).slice(0, 200));
  assert.match(b.detail, /WorldManifestV3/);
  assert.ok(Array.isArray(b.meta?.errors) && b.meta.errors.length > 0, "and must say what is wrong with it");
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
