// The integration candidate (29 Sep 2026): what the final integration lane
// wired into server.mts, asserted against the real server.
//
//   B5   a content change to a PUBLISHED world returns it to draft, strips the
//        trust fields, and re-publishing re-attests with a new signed package.
//   GAMES-C  typed patch edits (409 on a stale base), server-held undo that
//        refuses once history has diverged, World Memory v2 mirroring and
//        integrity, staging packages on publish, owner-only resume on load.
//   Security edge  prompt guard, bounded request bodies.
//   GAMES-A  the engine is visible to builders and LOCAL_ONLY unless approved.
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
const PORT = 9100 + Math.floor(Math.random() * 200);
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

let proc, DATA;
before(async () => {
  DATA = fs.mkdtempSync(path.join(os.tmpdir(), "dcs-candidate-"));
  proc = spawn(process.execPath, ["--import", "tsx", path.join(GB, "server.mts")], {
    cwd: GB,
    env: {
      ...process.env, PORT: String(PORT), DCS_AUTH_SECRET: SECRET, DCS_DATA_DIR: DATA,
      PAYMENTS_LIVE: "0", NODE_ENV: "test", DCS_PROVIDERS_OFFLINE: "1",
      DCS_INTERNAL_TESTERS: "tester@dcsai.ai",
      ATLAS_PRIVATE_KEY: crypto.randomBytes(32).toString("base64"),
      SUPABASE_URL: "", SUPABASE_SERVICE_ROLE_KEY: "", DATABASE_URL: "",
      CEREBRAS_API_KEY: "", CEREBRAS_API_KEY_1: "", CEREBRAS_API_KEY_2: "",
      DCS_GAMES_ENGINE_EXTERNAL: "", DCS_MAX_BODY_BYTES: String(256 * 1024),
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
  for (const t of [TESTER, PLAIN]) {
    const r = await call(t, "POST", "/safety/age", { date_of_birth: "1990-01-01", method: "synthetic_test" });
    assert.equal(r.status, 200, `age assurance failed: ${(await r.text()).slice(0, 200)}`);
  }
});
after(() => {
  try { proc.kill("SIGKILL"); } catch { /* gone */ }
  fs.rmSync(DATA, { recursive: true, force: true });
});

const call = (token, method, url, body) => fetch(BASE + url, {
  method,
  headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) },
  body: body === undefined ? undefined : JSON.stringify(body),
});
const json = async (r) => ({ status: r.status, body: await r.json() });

async function generate(prompt = "a small harbour town with a lighthouse and a market") {
  const r = await json(await call(TESTER, "POST", "/v3/worlds/generate", { prompt, seed: 11 }));
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 400));
  return r.body.world_id;
}
const manifestOf = async (id, token = TESTER) => (await json(await call(token, "GET", `/v3/worlds/${id}/manifest`))).body;

test("the manifest read carries the patch contract's content_hash", async () => {
  const id = await generate();
  const m = await manifestOf(id);
  assert.match(m.content_hash, /^sha256:[0-9a-f]{64}$/);
});

test("undo restores the content the last edit replaced, then there is nothing left to undo", async () => {
  const id = await generate();
  const before = await manifestOf(id);
  const e = await json(await call(TESTER, "POST", `/v3/worlds/${id}/edit`, { request: "make it rain" }));
  assert.equal(e.status, 200, JSON.stringify(e.body).slice(0, 400));
  assert.equal(e.body.undo_available, true);
  assert.notEqual((await manifestOf(id)).content_hash, before.content_hash, "the edit changed nothing to undo");

  const u = await json(await call(TESTER, "POST", `/v3/worlds/${id}/undo`, {}));
  assert.equal(u.status, 200, JSON.stringify(u.body).slice(0, 400));
  assert.equal(u.body.undone.kind, "edit");
  assert.equal((await manifestOf(id)).manifest.environment.weather, before.manifest.environment.weather, "undo did not put the weather back");

  const again = await json(await call(TESTER, "POST", `/v3/worlds/${id}/undo`, {}));
  assert.equal(again.status, 409);
  assert.equal(again.body.error, "nothing_to_undo");
});

test("undo refuses once something else has changed the world since the edit", async () => {
  const id = await generate();
  assert.equal((await call(TESTER, "POST", `/v3/worlds/${id}/edit`, { request: "make it rain" })).status, 200);
  assert.equal((await call(TESTER, "POST", `/worlds/${id}/publish`, {})).status, 200);
  const u = await json(await call(TESTER, "POST", `/v3/worlds/${id}/undo`, {}));
  assert.equal(u.status, 409);
  assert.equal(u.body.error, "undo_history_diverged");
});

test("only the owner can undo", async () => {
  const id = await generate();
  assert.equal((await call(TESTER, "POST", `/v3/worlds/${id}/edit`, { request: "make it rain" })).status, 200);
  assert.ok([403, 404].includes((await call(PLAIN, "POST", `/v3/worlds/${id}/undo`, {})).status));
});

test("a typed patch on a stale base is a 409, never a silent overwrite", async () => {
  const id = await generate();
  const m = await manifestOf(id);
  const patch = {
    patch_version: "1", patch_id: "p_" + crypto.randomBytes(8).toString("hex"), world_id: id,
    base_version: m.manifest.world_version ?? m.world_version, base_hash: "sha256:" + "0".repeat(64),
    author: { kind: "user", id: "spoofed" }, created_at: new Date().toISOString(),
    ops: [{ op: "set", path: "environment.weather", value: "storm" }],
  };
  const r = await json(await call(TESTER, "POST", `/v3/worlds/${id}/edit`, { patch }));
  assert.equal(r.status, 409, JSON.stringify(r.body).slice(0, 400));
  assert.equal(r.body.error, "stale_edit");
  assert.equal(r.body.current_hash, m.content_hash);
});

test("a typed patch on the current base applies, and the author is the principal, not the claim", async () => {
  const id = await generate();
  const m = await manifestOf(id);
  const patch = {
    patch_version: "1", patch_id: "p_" + crypto.randomBytes(8).toString("hex"), world_id: id,
    base_version: m.manifest.world_version ?? m.world_version, base_hash: m.content_hash,
    author: { kind: "system", id: "spoofed" }, created_at: new Date().toISOString(),
    intent: { text: "stormy", category: "lighting_weather" },
    ops: [{ op: "set", path: "environment.weather", value: "storm" }],
  };
  const r = await json(await call(TESTER, "POST", `/v3/worlds/${id}/edit`, { patch }));
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 500));
  assert.equal(r.body.patch_id, patch.patch_id);
  assert.equal((await manifestOf(id)).manifest.environment.weather, "storm");
});

test("an edit planEdit does not understand goes to the companion as a patch, and can be undone", async () => {
  const id = await generate();
  const r = await json(await call(TESTER, "POST", `/v3/worlds/${id}/edit`, { request: "make the player run faster" }));
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 500));
  assert.match(r.body.intent, /^companion:/);
  assert.match(r.body.patch_id, /^p_/);
  assert.equal((await call(TESTER, "POST", `/v3/worlds/${id}/undo`, {})).status, 200);
});

test("an edit nobody understands is still an honest 422 that lists what is supported", async () => {
  const id = await generate();
  const r = await json(await call(TESTER, "POST", `/v3/worlds/${id}/edit`, { request: "set the title to Harbour Nights" }));
  assert.equal(r.status, 422);
  assert.ok(r.body.supported, "the refusal must say what IS supported");
});

test("B5: editing a published world returns it to draft and strips its attestation; re-publishing re-attests", async () => {
  const id = await generate();
  const p1 = await json(await call(TESTER, "POST", `/worlds/${id}/publish`, {}));
  assert.equal(p1.status, 200, JSON.stringify(p1.body).slice(0, 400));
  assert.match(p1.body.staging_package.package_id, /^[0-9a-f]{64}$/);
  assert.equal(p1.body.staging_package.channel, "staging");
  assert.equal((await manifestOf(id)).state, "published");

  const e = await json(await call(TESTER, "POST", `/v3/worlds/${id}/edit`, { request: "make it rain" }));
  assert.equal(e.status, 200, JSON.stringify(e.body).slice(0, 400));
  assert.equal(e.body.unpublished, true);
  assert.equal(e.body.state, "draft");
  const after = await manifestOf(id);
  assert.equal(after.state, "draft");
  for (const k of ["atlas_signed", "atlas_receipt_hash", "published_package_id", "published_manifest_hash"]) {
    assert.equal(after.manifest.meta[k], undefined, `${k} survived a content change`);
  }
  // A stranger can no longer read the changed content as if it were published.
  assert.ok([403, 404].includes((await call(PLAIN, "GET", `/v3/worlds/${id}/manifest`)).status));

  const p2 = await json(await call(TESTER, "POST", `/worlds/${id}/publish`, {}));
  assert.equal(p2.status, 200);
  assert.notEqual(p2.body.staging_package.package_id, p1.body.staging_package.package_id, "new content must be a new package");
  assert.equal((await manifestOf(id)).manifest.meta.published_package_id, p2.body.staging_package.package_id);
});

test("B5 covers every v3 content path, not only edit: expansion and rollback also unpublish", async () => {
  const id = await generate();
  assert.equal((await call(TESTER, "POST", `/worlds/${id}/publish`, {})).status, 200);
  const x = await json(await call(TESTER, "POST", `/v3/worlds/${id}/expand`, { request: "add a market district" }));
  if (x.status === 200) {
    assert.equal(x.body.unpublished, true);
  } else {
    assert.equal(x.status, 422, JSON.stringify(x.body).slice(0, 300));   // a gate refusal leaves it published
  }
  assert.equal((await call(TESTER, "POST", `/worlds/${id}/publish`, {})).status, 200);
  const r = await json(await call(TESTER, "POST", `/v3/worlds/${id}/rollback`, { to_version: 1 }));
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 400));
  assert.equal(r.body.unpublished, true);
});

test("World Memory v2 mirrors the world, and its ledger verifies", async () => {
  const id = await generate();
  assert.equal((await call(TESTER, "POST", `/v3/worlds/${id}/edit`, { request: "make it rain" })).status, 200);
  const r = await json(await call(TESTER, "GET", `/v3/worlds/${id}/integrity`));
  assert.equal(r.status, 200);
  assert.equal(r.body.tracked, true);
  assert.equal(r.body.integrity.ok, true, JSON.stringify(r.body.integrity).slice(0, 300));
  assert.ok([403, 404].includes((await call(PLAIN, "GET", `/v3/worlds/${id}/integrity`)).status));
});

test("load: the owner gets resume history; another player on a published world gets only their own state", async () => {
  const id = await generate();
  assert.equal((await call(TESTER, "POST", `/v3/worlds/${id}/edit`, { request: "make it rain" })).status, 200);
  assert.equal((await call(TESTER, "POST", `/worlds/${id}/publish`, {})).status, 200);
  const own = await json(await call(TESTER, "GET", `/worlds/${id}/load`));
  assert.ok(Array.isArray(own.body.resume?.edit_history), "owner resume carries edit history");
  const other = await json(await call(PLAIN, "GET", `/worlds/${id}/load`));
  assert.equal(other.status, 200);
  assert.equal(other.body.resume?.edit_history, undefined, "edit history leaked to a non-owner");
});

test("security edge: a prompt carrying a credential or past the size cap is refused before generation", async () => {
  const cred = await json(await call(TESTER, "POST", "/v3/worlds/generate", { prompt: "a castle, my key is AKIA" + "ABCDEFGHIJKLMNOP" }));
  assert.equal(cred.status, 422, JSON.stringify(cred.body).slice(0, 300));
  const long = await json(await call(TESTER, "POST", "/v3/worlds/generate", { prompt: "castle ".repeat(1000) }));
  assert.equal(long.status, 422);
});

test("security edge: a body past the cap is a 413, not buffered", async () => {
  const r = await call(TESTER, "POST", "/v3/worlds/generate", { prompt: "x", pad: "y".repeat(300 * 1024) });
  assert.equal(r.status, 413);
});

test("GAMES-A: the engine is builder-only and LOCAL_ONLY until external routes are approved", async () => {
  const r = await json(await call(TESTER, "GET", "/v3/engine"));
  assert.equal(r.status, 200);
  assert.equal(r.body.mode, "LOCAL_ONLY");
  assert.equal(r.body.on_generation_path, false);
  for (const steps of Object.values(r.body.routes)) {
    for (const s of steps) if (!s.local) assert.equal(s.configured, false, `${s.provider} is callable in LOCAL_ONLY`);
  }
  assert.ok([401, 403].includes((await call(PLAIN, "GET", "/v3/engine")).status));
  assert.ok([401, 403].includes((await call(null, "GET", "/v3/engine")).status));
});
