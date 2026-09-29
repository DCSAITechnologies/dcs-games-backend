// Save -> restart -> reload, against the real server and the same data dir.
//
// Everything the integration candidate added keeps state on disk: the world
// repository, the World Memory v2 ledger, the undo stack and the staging
// packages. A restart is the test that none of it only lived in memory.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const GB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SECRET = crypto.randomBytes(24).toString("hex");
const ATLAS = crypto.randomBytes(32).toString("base64");
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "dcs-restart-"));

function signLocalToken(secret, claims, ttl = 3600) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const head = enc({ alg: "HS256", typ: "JWT" });
  const body = enc({ ...claims, iss: "dcs-games-local", iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + ttl });
  const sig = crypto.createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}
const TESTER = signLocalToken(SECRET, { sub: "u-tester", email: "tester@dcsai.ai", roles: ["internal_tester"] });

let proc, BASE;
async function boot() {
  const port = 9400 + Math.floor(Math.random() * 400);
  BASE = `http://127.0.0.1:${port}`;
  proc = spawn(process.execPath, ["--import", "tsx", path.join(GB, "server.mts")], {
    cwd: GB,
    env: {
      ...process.env, PORT: String(port), DCS_AUTH_SECRET: SECRET, DCS_DATA_DIR: DATA,
      PAYMENTS_LIVE: "0", NODE_ENV: "test", DCS_PROVIDERS_OFFLINE: "1",
      DCS_INTERNAL_TESTERS: "tester@dcsai.ai", ATLAS_PRIVATE_KEY: ATLAS,
      SUPABASE_URL: "", SUPABASE_SERVICE_ROLE_KEY: "", DATABASE_URL: "",
      CEREBRAS_API_KEY: "", CEREBRAS_API_KEY_1: "", CEREBRAS_API_KEY_2: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout.on("data", () => {});
  proc.stderr.on("data", (d) => { if (process.env.DCS_TEST_VERBOSE) process.stderr.write(d); });
  for (let i = 0; i < 200; i++) {
    try { if ((await fetch(BASE + "/health")).ok) return; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("server did not become healthy");
}
async function stop() {
  const exited = new Promise((r) => proc.once("exit", r));
  proc.kill("SIGKILL");
  await exited;
}
after(async () => {
  try { await stop(); } catch { /* gone */ }
  fs.rmSync(DATA, { recursive: true, force: true });
});

const call = (method, url, body) => fetch(BASE + url, {
  method,
  headers: { "Content-Type": "application/json", Authorization: "Bearer " + TESTER },
  body: body === undefined ? undefined : JSON.stringify(body),
});
const json = async (r) => ({ status: r.status, body: await r.json() });

test("a world, its history, its ledger, its undo and its staging package all survive a restart", async () => {
  await boot();
  assert.equal((await call("POST", "/safety/age", { date_of_birth: "1990-01-01", method: "synthetic_test" })).status, 200);
  const g = await json(await call("POST", "/v3/worlds/generate", { prompt: "a lakeside village with a mill", seed: 5 }));
  assert.equal(g.status, 200, JSON.stringify(g.body).slice(0, 300));
  const id = g.body.world_id;
  assert.equal((await call("POST", `/v3/worlds/${id}/edit`, { request: "make it rain" })).status, 200);
  const pub = await json(await call("POST", `/worlds/${id}/publish`, {}));
  assert.equal(pub.status, 200);
  assert.equal((await call("POST", `/v3/worlds/${id}/edit`, { request: "make it snow" })).status, 200);
  const before = (await json(await call("GET", `/v3/worlds/${id}/manifest`))).body;
  const versionsBefore = (await json(await call("GET", `/v3/worlds/${id}/versions`))).body.versions.length;

  await stop();
  await boot();

  const after = await json(await call("GET", `/v3/worlds/${id}/manifest`));
  assert.equal(after.status, 200);
  assert.equal(after.body.manifest_hash, before.manifest_hash, "the manifest changed across a restart");
  assert.equal(after.body.world_version, before.world_version);
  assert.equal(after.body.state, "draft", "B5: the post-publish edit's draft state must persist");
  assert.equal((await json(await call("GET", `/v3/worlds/${id}/versions`))).body.versions.length, versionsBefore);

  const integ = await json(await call("GET", `/v3/worlds/${id}/integrity`));
  assert.equal(integ.body.tracked, true);
  assert.equal(integ.body.integrity.ok, true, JSON.stringify(integ.body.integrity).slice(0, 300));
  assert.equal(integ.body.undo?.kind, "edit", "the undo stack did not survive the restart");

  const load = await json(await call("GET", `/worlds/${id}/load`));
  assert.ok(load.body.resume?.edit_history?.length >= 2, "resume history did not survive the restart");

  // The undo recorded before the restart still works after it.
  const u = await json(await call("POST", `/v3/worlds/${id}/undo`, {}));
  assert.equal(u.status, 200, JSON.stringify(u.body).slice(0, 300));

  // The staging package written before the restart is still on disk and verifiable.
  const pkgDir = path.join(DATA, "staging-packages", id, pub.body.staging_package.package_id);
  assert.ok(fs.existsSync(path.join(pkgDir, "package.sig.json")), "the staging package is gone after a restart");
});
