// Lane G — adversarial review of the CORS gate the Lead added today.
//
// test/cors.test.mjs proves the gate exists and that the obvious lookalikes are
// refused. It only ever inspects Access-Control-Allow-Origin, and it only ever
// configures the allowlist one way. This suite attacks the string matching from
// the other directions, and looks at the rest of the preflight.
//
// Most of the attacks FAILED — originAllowed() is careful — and those are
// recorded as `DISPROVED:` so nobody re-derives them. Two things did not hold.
//
// Run: node --import tsx --test test/lead-review-cors.test.mjs
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
  const port = 8940 + Math.floor(Math.random() * 200);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dcs-g-cors-"));
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
    try { if ((await fetch(base + "/health")).ok) return { p, base, dir }; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  p.kill("SIGKILL");
  throw new Error("server did not become healthy");
}

const acao = (r) => r.headers.get("access-control-allow-origin");
const acah = (r) => r.headers.get("access-control-allow-headers");

// ------------------------------------------- the allowlist as staging spells it

let strict;
before(async () => {
  strict = await bootWith({ ALLOWED_ORIGINS: "https://games.dcsai.ai,https://*.dcs-games.pages.dev" });
});
after(() => { try { strict.p.kill("SIGKILL"); fs.rmSync(strict.dir, { recursive: true, force: true }); } catch { /* gone */ } });

// ---------------------------------------- the same allowlist, written bare
//
// Nothing documents that an entry must carry a scheme, the parser accepts an
// entry without one, and `*.dcs-games.pages.dev` is how a wildcard host is
// normally written down. So this spelling will happen.

let bare;
before(async () => {
  bare = await bootWith({ ALLOWED_ORIGINS: "games.dcsai.ai,*.dcs-games.pages.dev" });
});
after(() => { try { bare.p.kill("SIGKILL"); fs.rmSync(bare.dir, { recursive: true, force: true }); } catch { /* gone */ } });

test("DEFECT, OPEN: an allowlist entry without a scheme matches http as well as https", async () => {
  // server.mts:222 — `if (e.scheme && o.scheme && e.scheme !== o.scheme) continue;`
  // The comparison is skipped entirely when EITHER side has no scheme, so a bare
  // host entry silently allows the plaintext origin of the same name. The
  // absence of a scheme in the configuration is not permission to ignore the
  // scheme in the request; an unspecified scheme should mean https, or the entry
  // should be refused at boot as unparseable.
  const https_ = await fetch(bare.base + "/health", { headers: { Origin: "https://games.dcsai.ai" } });
  assert.equal(acao(https_), "https://games.dcsai.ai", "the intended origin is allowed");

  const http_ = await fetch(bare.base + "/health", { headers: { Origin: "http://games.dcsai.ai" } });
  assert.equal(
    acao(http_), null,
    "a plaintext origin was allowed by an entry that names no scheme. A page served over http on that " +
    "host — which is what a network attacker on the path can serve — may now read this API's responses."
  );

  const httpPreview = await fetch(bare.base + "/health", { headers: { Origin: "http://abc123.dcs-games.pages.dev" } });
  assert.equal(acao(httpPreview), null, "and the same for the wildcard entry");
});

test("DEFECT, OPEN: the preflight wildcard does not authorise the Authorization header", async () => {
  // Every authenticated call this API defines carries `Authorization: Bearer`,
  // which is a CORS-unsafe request header, so the browser preflights it. Per the
  // Fetch standard, `Access-Control-Allow-Headers: *` matches any header name
  // EXCEPT `Authorization` — it has to be listed explicitly. (MDN, Access-Control-
  // Allow-Headers: "The Authorization header can't be wildcarded and always needs
  // to be listed explicitly.")
  //
  // So with the allowlist now enforced, an allowlisted browser origin gets its
  // ACAO echoed and its authenticated requests blocked anyway, at the preflight,
  // before the response the gate just permitted is ever fetched. Nothing in
  // test/cors.test.mjs looks at this header, and no test on the estate sends an
  // Access-Control-Request-Headers at all.
  const pre = await fetch(strict.base + "/me/home", {
    method: "OPTIONS",
    headers: {
      Origin: "https://games.dcsai.ai",
      "Access-Control-Request-Method": "GET",
      "Access-Control-Request-Headers": "authorization",
    },
  });
  assert.equal(acao(pre), "https://games.dcsai.ai", "the origin is allowed");
  assert.match(
    String(acah(pre) || ""), /authorization/i,
    `the preflight answered Access-Control-Allow-Headers: ${JSON.stringify(acah(pre))}. The wildcard does ` +
    "not cover Authorization, so a browser at https://games.dcsai.ai cannot make a single authenticated " +
    "request to this API. Echo the requested headers, or list them."
  );
});

// ------------------------------------------------------ attacks that failed

test("DISPROVED: no crafted origin gets past the scheme-bearing allowlist", async () => {
  // Every one of these was tried against `https://games.dcsai.ai` and
  // `https://*.dcs-games.pages.dev`. All are correctly refused.
  const refused = [
    "http://games.dcsai.ai",                    // scheme downgrade
    "https://games.dcsai.ai.",                  // trailing dot (a distinct DNS name)
    "https://games.dcsai.ai:8443",              // a port the entry does not name
    "https://games.dcsai.ai@evil.example",      // userinfo, real host on the right
    "https://evil.example@games.dcsai.ai",      // userinfo, target host on the right
    "https://games%2edcsai.ai",                 // percent-encoded dot
    "https://games.dcsai.ai/",                  // trailing slash
    "https://evil.example/https://games.dcsai.ai",
    "https://a.b.dcs-games.pages.dev",          // two labels deep
    "https://.dcs-games.pages.dev",             // empty label
    "http://abc.dcs-games.pages.dev",           // wildcard + scheme downgrade
    "https://abc.dcs-games.pages.dev.evil.example",
    "https://evildcs-games.pages.dev",
    "null",                                     // sandboxed iframe / file://
    "chrome-extension://abcdefghijklmnop",
  ];
  for (const origin of refused) {
    const r = await fetch(strict.base + "/health", { headers: { Origin: origin } });
    assert.equal(acao(r), null, `${origin} must not be echoed`);
  }
});

test("DISPROVED: the wildcard boundary is exactly one label", async () => {
  const one = await fetch(strict.base + "/health", { headers: { Origin: "https://5d08c940.dcs-games.pages.dev" } });
  assert.equal(acao(one), "https://5d08c940.dcs-games.pages.dev");
  // The suffix carries its own dot and the label is checked for one, so neither
  // "evil-dcs-games.pages.dev" nor "a.b.dcs-games.pages.dev" can reach it.
  for (const origin of ["https://dcs-games.pages.dev", "https://a.b.dcs-games.pages.dev", "https://xdcs-games.pages.dev"]) {
    const r = await fetch(strict.base + "/health", { headers: { Origin: origin } });
    assert.equal(acao(r), null, `${origin} must not match the wildcard`);
  }
});

test("DISPROVED: the gate applies to error and not-found responses too", async () => {
  // A route that throws answers through the same send(), so a 404 or a 401 does
  // not become a hole in the gate.
  for (const url of ["/definitely-not-a-route", "/me/home", "/api/public/stats"]) {
    const bad = await fetch(strict.base + url, { headers: { Origin: "https://evil.example" } });
    assert.equal(acao(bad), null, `${url} (${bad.status}) must not echo a disallowed origin`);
    const good = await fetch(strict.base + url, { headers: { Origin: "https://games.dcsai.ai" } });
    assert.equal(acao(good), "https://games.dcsai.ai", `${url} (${good.status}) echoes an allowed one`);
    assert.equal(good.headers.get("vary"), "Origin");
  }
});

test("DISPROVED: an allowlisted origin is not echoed with credentials enabled", async () => {
  // Reflecting an origin is only dangerous in combination with
  // Access-Control-Allow-Credentials, which would let a browser send cookies
  // cross-site. This API authenticates with a bearer token and never sets that
  // header, so the reflection carries no ambient authority.
  const r = await fetch(strict.base + "/health", { headers: { Origin: "https://games.dcsai.ai" } });
  assert.equal(r.headers.get("access-control-allow-credentials"), null);
});
