// P2 — email and phone verification.
//
// The build this replaces returned the verification code in its own HTTP
// response as `_devCode`, so any authenticated user could verify their own
// address without receiving anything — and computeLevel treats email_verified
// as a TRUST signal that unlocks the `publisher` level and its publish credits.
//
// The single most important assertion in this file is that no response, in any
// mode, ever contains the code.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createVerificationService, CHANNELS, MAX_ATTEMPTS, CODE_TTL_MS } from "../src/core/verification.mjs";

const tmp = (extra = {}) => ({ DCS_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "dcs-ver-")), ...extra });

/** A provider that captures what it was asked to send, standing in for a real one. */
function capturingProvider(channel) {
  const sent = [];
  return {
    sent,
    provider: {
      channel,
      name: "test-" + channel,
      status: () => "AVAILABLE",
      async send(args) { sent.push(args); return { delivered: true }; },
    },
  };
}

function withProvider(channel = "email", extra = {}) {
  const cap = capturingProvider(channel);
  const svc = createVerificationService(tmp(extra), { [channel]: cap.provider });
  return { svc, cap };
}

// ================================================ the code never leaks

test("P2 GATE: no response EVER contains the verification code", async () => {
  const { svc, cap } = withProvider("email");
  const r = await svc.start("u1", "email", "alice@dcsai.ai");
  const code = cap.sent[0].code;

  assert.match(code, /^\d{6}$/, "the provider really was given a code");
  const json = JSON.stringify(r);
  assert.ok(!json.includes(code), "the code must never reach the caller");
  assert.equal(r._devCode, undefined, "the field that caused this defect must not exist");
  assert.ok(!("code" in r));
  assert.equal(r.sent, true);
});

test("P2 GATE: with no provider configured, a challenge is not issued at all", async () => {
  const svc = createVerificationService(tmp());
  await assert.rejects(
    () => svc.start("u1", "email", "alice@dcsai.ai"),
    (e) => e.httpStatus === 503 && /no provider is configured/.test(e.detail)
  );
  // And the service says so rather than implying the capability exists.
  const d = svc.describe();
  assert.equal(d.channels.email.status, "UNAVAILABLE");
  assert.match(d.note, /cannot be completed/);
});

test("P2 GATE: dev mode logs the code to the SERVER only, never to a response", async () => {
  const svc = createVerificationService(tmp({ DCS_VERIFICATION_DEV_MODE: "1" }));
  const logged = [];
  const orig = console.warn;
  console.warn = (m) => logged.push(String(m));
  let r;
  try { r = await svc.start("u1", "email", "alice@dcsai.ai"); } finally { console.warn = orig; }

  const entry = JSON.parse(logged.find((l) => l.includes("verification_dev_mode")));
  assert.match(entry.code, /^\d{6}$/, "an operator can read the code from the log");
  assert.ok(!JSON.stringify(r).includes(entry.code), "but it still never reaches the client");
  assert.equal(r.dev_mode, true, "and the response says plainly that nothing was delivered");
  assert.match(r.delivered_by, /server-log/);
});

test("P2 GATE: a dev-mode verification is permanently marked untrustworthy", async () => {
  const svc = createVerificationService(tmp({ DCS_VERIFICATION_DEV_MODE: "1" }));
  const logged = [];
  const orig = console.warn;
  console.warn = (m) => logged.push(String(m));
  try { await svc.start("u1", "email", "alice@dcsai.ai"); } finally { console.warn = orig; }
  const code = JSON.parse(logged.find((l) => l.includes("verification_dev_mode"))).code;

  const c = await svc.confirm("u1", "email", code);
  assert.equal(c.verified, true);
  assert.equal(c.dev_mode, true);

  const st = await svc.statusFor("u1");
  assert.equal(st.email_verified, true);
  assert.equal(st.trustworthy, false, "nobody received anything, so this is not evidence of ownership");
  assert.deepEqual(st.dev_mode_verifications, ["email"]);
  assert.match(st.note, /not evidence of address ownership/);
});

// ============================================================ happy path

test("P2: a real provider delivers, and the code then verifies once", async () => {
  const { svc, cap } = withProvider("email");
  await svc.start("u1", "email", "alice@dcsai.ai");
  const code = cap.sent[0].code;
  assert.equal(cap.sent[0].to, "alice@dcsai.ai");
  assert.ok(cap.sent[0].ttlMinutes >= 1);

  const r = await svc.confirm("u1", "email", code);
  assert.equal(r.verified, true);
  assert.equal(r.dev_mode, false);

  const st = await svc.statusFor("u1");
  assert.equal(st.email_verified, true);
  assert.equal(st.trustworthy, true);

  // Single use: the same code cannot be replayed.
  await assert.rejects(() => svc.confirm("u1", "email", code), (e) => e.httpStatus === 404);
});

test("P2: the destination is masked in every response", async () => {
  const { svc, cap } = withProvider("email");
  const r = await svc.start("u1", "email", "alice.smith@dcsai.ai");
  assert.ok(!r.destination.includes("alice.smith"), `destination leaked: ${r.destination}`);
  assert.match(r.destination, /@dcsai\.ai$/, "enough to recognise, not enough to harvest");
  const c = await svc.confirm("u1", "email", cap.sent[0].code);
  assert.ok(!c.destination.includes("alice.smith"));
});

// ============================================================ hardening

test("P2 GATE: a wrong code is rejected and attempts are capped", async () => {
  const { svc, cap } = withProvider("email");
  await svc.start("u1", "email", "alice@dcsai.ai");
  const real = cap.sent[0].code;
  const wrong = real === "000000" ? "111111" : "000000";

  for (let i = 1; i <= MAX_ATTEMPTS; i++) {
    await assert.rejects(() => svc.confirm("u1", "email", wrong), (e) => e.httpStatus === 422);
  }
  // Once the cap is reached the challenge is destroyed, so even the REAL code is
  // refused. The first refusal says why; the next is a plain 404 because there
  // is genuinely nothing pending any more.
  await assert.rejects(() => svc.confirm("u1", "email", real), (e) => e.httpStatus === 409 && /too many attempts/.test(e.detail));
  await assert.rejects(() => svc.confirm("u1", "email", real), (e) => e.httpStatus === 404);
});

test("P2: attempts remaining is reported, so a user is not left guessing", async () => {
  const { svc, cap } = withProvider("email");
  await svc.start("u1", "email", "alice@dcsai.ai");
  const wrong = cap.sent[0].code === "000000" ? "111111" : "000000";
  await svc.confirm("u1", "email", wrong).catch((e) => {
    assert.equal(e.meta.attempts_remaining, MAX_ATTEMPTS - 1);
  });
});

test("P2 GATE: the stored challenge does not contain the code in the clear", async () => {
  const { svc, cap } = withProvider("email");
  await svc.start("u1", "email", "alice@dcsai.ai");
  const code = cap.sent[0].code;
  const onDisk = fs.readFileSync(path.join(svc.dir, "challenges.json"), "utf8");
  assert.ok(!onDisk.includes(code), "a leaked store must not hand over live codes");
  assert.ok(onDisk.includes("code_hash"));
});

test("P2: an expired code is refused", async () => {
  const { svc, cap } = withProvider("email");
  await svc.start("u1", "email", "alice@dcsai.ai");
  const code = cap.sent[0].code;
  // Age the challenge past its TTL.
  const f = path.join(svc.dir, "challenges.json");
  const rows = JSON.parse(fs.readFileSync(f, "utf8"));
  rows[0].expires_at = new Date(Date.now() - 1000).toISOString();
  fs.writeFileSync(f, JSON.stringify(rows));
  await assert.rejects(() => svc.confirm("u1", "email", code), (e) => /expired/.test(e.detail));
  assert.ok(CODE_TTL_MS > 0);
});

test("P2: resending is rate limited", async () => {
  const { svc } = withProvider("email");
  await svc.start("u1", "email", "alice@dcsai.ai");
  await assert.rejects(() => svc.start("u1", "email", "alice@dcsai.ai"), (e) => e.httpStatus === 409 && /wait/.test(e.detail));
});

test("P2: a malformed destination or channel is refused before anything is sent", async () => {
  const { svc, cap } = withProvider("email");
  await assert.rejects(() => svc.start("u1", "email", "not-an-email"), (e) => e.httpStatus === 422);
  await assert.rejects(() => svc.start("u1", "carrier-pigeon", "x"), (e) => e.httpStatus === 422);
  await assert.rejects(() => svc.start(null, "email", "a@b.co"), (e) => e.httpStatus === 401);
  assert.equal(cap.sent.length, 0, "nothing may be sent for an invalid request");
  assert.deepEqual(CHANNELS, ["email", "phone"]);
});

test("P2: phone numbers are validated too", async () => {
  const { svc } = withProvider("phone");
  await assert.rejects(() => svc.start("u1", "phone", "abc"), (e) => e.httpStatus === 422);
  const r = await svc.start("u1", "phone", "+91 98765 43210");
  assert.equal(r.channel, "phone");
  assert.ok(!r.destination.includes("98765"), "the number is masked");
});

test("P2: confirming with no pending challenge is a 404", async () => {
  const { svc } = withProvider("email");
  await assert.rejects(() => svc.confirm("u1", "email", "123456"), (e) => e.httpStatus === 404);
});

test("P2: a verification can be revoked", async () => {
  const { svc, cap } = withProvider("email");
  await svc.start("u1", "email", "alice@dcsai.ai");
  await svc.confirm("u1", "email", cap.sent[0].code);
  assert.equal((await svc.statusFor("u1")).email_verified, true);
  await svc.revoke("u1", "email");
  assert.equal((await svc.statusFor("u1")).email_verified, false);
  await assert.rejects(() => svc.revoke("u1", "email"), (e) => e.httpStatus === 404);
});

test("P2: verifications survive a restart", async () => {
  const env = tmp();
  const cap = capturingProvider("email");
  const a = createVerificationService(env, { email: cap.provider });
  await a.start("u1", "email", "alice@dcsai.ai");
  await a.confirm("u1", "email", cap.sent[0].code);
  const b = createVerificationService(env, { email: cap.provider });
  assert.equal((await b.statusFor("u1")).email_verified, true);
});

// =========================================== the trust signal it feeds

test("P2 GATE: a dev-mode verification does NOT raise the profile's trust level", async () => {
  const { createSocialService } = await import("../src/core/social.mjs");
  const env = tmp();
  const social = createSocialService(env);
  await social.ensureProfile({ id: "u1", email: "alice@dcsai.ai" });

  await social.setVerification("u1", "email", true, /* devMode */ true);
  const me = await social.me({ id: "u1" });
  assert.equal(me.level_signals.email_verified, false, "a self-granted verification must not unlock a level");
  assert.equal(me.level, "explorer");

  // A real one does.
  await social.setVerification("u1", "email", true, /* devMode */ false);
  const after = await social.me({ id: "u1" });
  assert.equal(after.level_signals.email_verified, true);
  assert.equal(after.level, "builder");
});

test("P2: the legacy _devCode implementation is no longer reachable from the API", async () => {
  const slice = fs.readFileSync(new URL("../src/cw1/identity-slice.mjs", import.meta.url), "utf8");
  assert.ok(!/_devCode\s*:/.test(slice), "the route must not construct a _devCode field");
  assert.match(slice, /410/, "the removed route answers 410 Gone rather than silently vanishing");
});
