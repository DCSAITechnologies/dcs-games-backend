// SIGTERM drains in-flight requests and exits 0 within a bounded time.
//
// Staging L1 (1 Oct 2026): every platform handover cut off whatever the old
// instance was serving, because nothing handled SIGTERM and Node's default is
// to exit on the spot. These tests run the drain in a real child process and
// send it a real signal.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { installGracefulShutdown } from "../src/core/graceful-shutdown.mjs";

const GB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = path.join(GB, "test/fixtures/graceful-server.mjs");

function start(graceMs) {
  const child = spawn(process.execPath, [FIXTURE], { env: { ...process.env, GRACE_MS: String(graceMs) }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal, at: Date.now() })));
  const port = new Promise((resolve, reject) => {
    child.stdout.on("data", (d) => { out += d; const m = /listening (\d+)/.exec(out); if (m) resolve(Number(m[1])); });
    child.on("exit", () => reject(new Error("fixture exited before listening: " + out)));
  });
  return { child, port, exited, log: () => out };
}

// A raw request on its own connection, so "refused" and "reset" are visible.
function get(port, p) {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: p, agent: false }, (res) => {
      let body = ""; res.on("data", (d) => (body += d)); res.on("end", () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });
    req.on("error", (e) => resolve({ error: e.code || String(e) }));
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("SIGTERM: a request in flight is answered, then the process exits 0 without waiting out the grace", async () => {
  const s = start(8000);
  const port = await s.port;
  const slow = get(port, "/slow?ms=1500");
  await sleep(200);
  const t0 = Date.now();
  s.child.kill("SIGTERM");
  const r = await slow;
  assert.equal(r.status, 200, "the in-flight request must complete: " + JSON.stringify(r));
  assert.equal(r.body, "done 1500");
  const e = await s.exited;
  assert.equal(e.code, 0, "clean exit; log:\n" + s.log());
  assert.ok(e.at - t0 < 5000, `exited ${e.at - t0}ms after SIGTERM; it should leave once drained, not at the 8s grace`);
  assert.match(s.log(), /\[shutdown\] SIGTERM: draining, 1 request\(s\) in flight/);
  assert.match(s.log(), /drained after/);
});

test("SIGTERM: no new connection is accepted while draining", async () => {
  const s = start(8000);
  const port = await s.port;
  const slow = get(port, "/slow?ms=1500");     // keeps the process alive while we probe
  await sleep(200);
  s.child.kill("SIGTERM");
  await sleep(200);
  const fresh = await get(port, "/ready");
  assert.equal(fresh.error, "ECONNREFUSED", "a new connection during the drain must be refused: " + JSON.stringify(fresh));
  assert.equal((await slow).status, 200);
  assert.equal((await s.exited).code, 0);
});

test("SIGTERM: shutdown is bounded — a request that outlives the grace is closed and the process still exits 0", async () => {
  const s = start(600);
  const port = await s.port;
  const hung = get(port, "/slow?ms=20000");
  await sleep(200);
  const t0 = Date.now();
  s.child.kill("SIGTERM");
  const e = await s.exited;
  assert.equal(e.code, 0, "log:\n" + s.log());
  assert.ok(e.at - t0 < 3000, `exited ${e.at - t0}ms after SIGTERM with a 600ms grace`);
  assert.match(s.log(), /grace 600ms over with 1 request\(s\) still in flight/);
  const r = await hung;
  assert.ok(r.error, "the over-long request is cut off at the bound, not left hanging");
});

test("in process: begin() flips the draining state, the in-flight request completes, and it exits 0 once drained", async () => {
  const exits = [];
  const server = http.createServer((req, res) => {
    if (req.url === "/ready") { res.writeHead(sd.isDraining() ? 503 : 200); return res.end(); }
    setTimeout(() => { res.writeHead(200); res.end("ok"); }, 300);
  });
  const sd = installGracefulShutdown(server, { graceMs: 3000, signals: [], exit: (c) => exits.push(c), log: () => {} });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const via = (p) => new Promise((resolve) => {
    http.get({ host: "127.0.0.1", port, path: p, agent }, (res) => { res.resume(); res.on("end", () => resolve({ status: res.statusCode, conn: res.headers.connection })); })
      .on("error", (e) => resolve({ error: e.code }));
  });
  assert.equal((await via("/ready")).status, 200);
  assert.equal(sd.isDraining(), false);
  const inflight = via("/work");                 // same socket, queued behind nothing
  await sleep(50);
  sd.begin("TEST");
  assert.equal(sd.isDraining(), true);
  const r = await inflight;
  assert.equal(r.status, 200, "in-flight work completes");
  await sleep(300);
  assert.deepEqual(exits, [0], "exits 0 once drained");
  agent.destroy();
});

test("server.mts wires the drain and reports it on /ready", () => {
  const src = fs.readFileSync(path.join(GB, "server.mts"), "utf8");
  assert.match(src, /installGracefulShutdown\(server,/, "the listening server installs the SIGTERM drain");
  assert.match(src, /add\("not_draining", !shutdown\?\.isDraining\(\), true/, "/ready goes 503 while draining (required check)");
});
