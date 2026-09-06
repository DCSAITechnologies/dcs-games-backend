// CORS — ALLOWED_ORIGINS must actually restrict something.
//
// Every response used to carry `Access-Control-Allow-Origin: *` unconditionally
// while the Railway staging service carried an ALLOWED_ORIGINS variable listing
// two domains. The variable was dead configuration: it sat there looking
// exactly like a security control and enforced nothing. A setting that appears
// to restrict something and does not is worse than no setting, because someone
// reads it and believes the restriction exists.
//
// Boots the real server twice — once with no allowlist, once with one — because
// the whole point is that the two behave differently.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const GB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function bootWith(extraEnv) {
  const port = 8600 + Math.floor(Math.random() * 300);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dcs-cors-"));
  const p = spawn(process.execPath, ["--import", "tsx", path.join(GB, "server.mts")], {
    cwd: GB,
    env: {
      ...process.env,
      PORT: String(port),
      DCS_AUTH_SECRET: crypto.randomBytes(16).toString("hex"),
      DCS_DATA_DIR: dir,
      PAYMENTS_LIVE: "0",
      NODE_ENV: "test",
      DCS_PROVIDERS_OFFLINE: "1",
      SUPABASE_URL: "", SUPABASE_SERVICE_ROLE_KEY: "", DATABASE_URL: "",
      CEREBRAS_API_KEY: "", CEREBRAS_API_KEY_1: "", CEREBRAS_API_KEY_2: "",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  p.stdout.on("data", () => {});
  p.stderr.on("data", (d) => { if (process.env.DCS_TEST_VERBOSE) process.stderr.write(d); });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 200; i++) {
    try { if ((await fetch(base + "/health")).ok) return { p, base }; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  p.kill("SIGKILL");
  throw new Error("server did not become healthy");
}

const acao = (r) => r.headers.get("access-control-allow-origin");

// ------------------------------------------------------- no allowlist set

let open_;
before(async () => { open_ = await bootWith({ ALLOWED_ORIGINS: "" }); });
after(() => { try { open_.p.kill("SIGKILL"); } catch { /* gone */ } });

test("CORS: with no allowlist the API stays open, and says so", async () => {
  // Deliberate: a local or freshly provisioned instance must not be
  // mysteriously unreachable from a browser.
  const r = await fetch(open_.base + "/health", { headers: { Origin: "https://anything.example" } });
  assert.equal(acao(r), "*");
  const h = await r.json();
  assert.equal(h.cors.mode, "open", "and /health states the mode, so it cannot be assumed");
  assert.equal(h.cors.allowed, null);
});

// ---------------------------------------------------------- allowlist set

let strict;
before(async () => {
  strict = await bootWith({ ALLOWED_ORIGINS: "https://games.dcsai.ai,https://*.dcs-games.pages.dev" });
});
after(() => { try { strict.p.kill("SIGKILL"); } catch { /* gone */ } });

test("CORS GATE: an allowlisted origin is echoed, not starred", async () => {
  const r = await fetch(strict.base + "/health", { headers: { Origin: "https://games.dcsai.ai" } });
  assert.equal(acao(r), "https://games.dcsai.ai");
  assert.equal(r.headers.get("vary"), "Origin", "the answer varies by origin, so caches must key on it");
});

test("CORS GATE: an origin that is not on the list gets no ACAO header at all", async () => {
  const r = await fetch(strict.base + "/health", { headers: { Origin: "https://evil.example" } });
  assert.equal(acao(r), null, "a browser must refuse to hand this response to that page");
  assert.equal(r.status, 200, "the API still answers — CORS is a browser rule, not an auth rule");
});

test("CORS GATE: a wildcard entry matches one subdomain level, and only one", async () => {
  // Cloudflare mints a fresh <hash>.dcs-games.pages.dev for every preview, so
  // listing them individually is impossible.
  const okOrigin = await fetch(strict.base + "/health", { headers: { Origin: "https://5d08c940.dcs-games.pages.dev" } });
  assert.equal(acao(okOrigin), "https://5d08c940.dcs-games.pages.dev");

  const deeper = await fetch(strict.base + "/health", { headers: { Origin: "https://a.b.dcs-games.pages.dev" } });
  assert.equal(acao(deeper), null, "two levels deep is a different host and must not match");
});

test("CORS GATE: a lookalike domain must not match a wildcard suffix", async () => {
  // The classic mistake: endsWith(".dcs-games.pages.dev") would also accept
  // "evil-dcs-games.pages.dev" if the dot is not required.
  for (const origin of [
    "https://evildcs-games.pages.dev",
    "https://dcs-games.pages.dev.evil.example",
    "https://games.dcsai.ai.evil.example",
  ]) {
    const r = await fetch(strict.base + "/health", { headers: { Origin: origin } });
    assert.equal(acao(r), null, `${origin} must not be treated as allowed`);
  }
});

test("CORS: a request with no Origin still works — curl and server-to-server", async () => {
  const r = await fetch(strict.base + "/health");
  assert.equal(r.status, 200);
  assert.equal(acao(r), null, "nothing to echo, and no browser is involved");
});

test("CORS GATE: the preflight answers with the same rules as the real response", async () => {
  const good = await fetch(strict.base + "/health", { method: "OPTIONS", headers: { Origin: "https://games.dcsai.ai" } });
  assert.equal(acao(good), "https://games.dcsai.ai");
  const bad = await fetch(strict.base + "/health", { method: "OPTIONS", headers: { Origin: "https://evil.example" } });
  assert.equal(acao(bad), null, "a permissive preflight would wave through the request the response then refuses");
});

test("CORS: /health reports the allowlist it is enforcing", async () => {
  const h = await (await fetch(strict.base + "/health")).json();
  assert.equal(h.cors.mode, "allowlist");
  assert.deepEqual(h.cors.allowed, ["https://games.dcsai.ai", "https://*.dcs-games.pages.dev"]);
});
