// A test suite must know it is talking to its OWN server.
//
// Two orphaned server processes were found still listening on ports inside two
// suites' ranges. A leaked server answers /health perfectly well — with a
// different secret, a different data directory and different code — so a suite
// that boots into an occupied port finds a healthy service and proceeds. It
// then passes or fails against a server nobody meant it to touch, and the
// result looks exactly like a real one.
//
// The fix is not to pick better ports. It is to make the question answerable:
// the server reports the instance id it was given, and a suite refuses anything
// that is not its own.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const GB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function boot(instanceId) {
  const port = 8950 + Math.floor(Math.random() * 40);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dcs-inst-"));
  const p = spawn(process.execPath, ["--import", "tsx", path.join(GB, "server.mts")], {
    cwd: GB,
    env: {
      ...process.env, PORT: String(port), DCS_DATA_DIR: dir,
      DCS_INSTANCE_ID: instanceId,
      DCS_AUTH_SECRET: crypto.randomBytes(16).toString("hex"),
      PAYMENTS_LIVE: "0", NODE_ENV: "test", DCS_PROVIDERS_OFFLINE: "1",
      SUPABASE_URL: "", SUPABASE_SERVICE_ROLE_KEY: "", DATABASE_URL: "",
      CEREBRAS_API_KEY: "", CEREBRAS_API_KEY_1: "", CEREBRAS_API_KEY_2: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  p.stdout.on("data", () => {});
  p.stderr.on("data", () => {});
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 200; i++) {
    try { if ((await fetch(base + "/health")).ok) return { p, base, port }; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  p.kill("SIGKILL");
  throw new Error("server did not become healthy");
}

test("HARNESS GATE: /health names the process answering it", async () => {
  const id = "probe-" + crypto.randomBytes(4).toString("hex");
  const s = await boot(id);
  try {
    const h = await (await fetch(s.base + "/health")).json();
    assert.equal(h.instance_id, id, "a suite must be able to tell its own server from someone else's");
    assert.equal(typeof h.pid, "number");
    assert.ok(h.pid > 0);
  } finally { try { s.p.kill("SIGKILL"); } catch { /* gone */ } }
});

test("HARNESS GATE: a server that is not yours is distinguishable from one that is", async () => {
  // The scenario, exactly: two servers, and a suite that must not accept the
  // wrong one merely because it answered.
  const mine = "mine-" + crypto.randomBytes(4).toString("hex");
  const theirs = "theirs-" + crypto.randomBytes(4).toString("hex");
  const a = await boot(mine);
  let b;
  try {
    b = await boot(theirs);
    const ha = await (await fetch(a.base + "/health")).json();
    const hb = await (await fetch(b.base + "/health")).json();

    assert.equal(ha.instance_id, mine);
    assert.equal(hb.instance_id, theirs);
    assert.notEqual(ha.pid, hb.pid, "two servers are two processes");

    // Both are healthy. Health is exactly what does NOT distinguish them.
    assert.equal(ha.ok, true);
    assert.equal(hb.ok, true);
  } finally {
    try { a.p.kill("SIGKILL"); } catch { /* gone */ }
    try { b?.p.kill("SIGKILL"); } catch { /* gone */ }
  }
});

test("HARNESS: without an instance id the field is null, not invented", async () => {
  const s = await boot("");
  try {
    const h = await (await fetch(s.base + "/health")).json();
    assert.equal(h.instance_id, null, "an absent id must read as absent");
  } finally { try { s.p.kill("SIGKILL"); } catch { /* gone */ } }
});
