// A1 exit gate. These tests encode the Round-2 P0 as executable regressions:
// forged identity must fail, an invalid token must never fall through, and two
// users must never collapse onto the same principal.
import test from "node:test";
import assert from "node:assert/strict";
import { createPrincipalResolver, signLocalToken } from "../src/core/principal.mjs";

const SECRET = "test-secret-not-a-real-key";
const mk = (o = {}) => createPrincipalResolver({ localSecret: SECRET, supabaseUrl: "", supabaseKey: "", ...o });

test("x-user-id alone can no longer authenticate anyone", async () => {
  const r = mk();
  await assert.rejects(
    () => r.resolve({ "x-user-id": "victim-uuid" }),
    (e) => e.code === "unauthenticated" && e.httpStatus === 401
  );
});

test("invalid token + forged x-user-id does NOT fall through to the header (the live P0)", async () => {
  const r = mk();
  await assert.rejects(
    () => r.resolve({ authorization: "Bearer nope", "x-user-id": "victim-uuid" }),
    (e) => e.httpStatus === 401 && e.code === "invalid_token"
  );
});

test("a garbage bearer token is rejected, not downgraded to anonymous", async () => {
  const r = mk();
  await assert.rejects(() => r.resolve({ authorization: "Bearer totally-invalid-token" }), (e) => e.httpStatus === 401);
});

test("no credential at all resolves to anonymous, and private routes then 401", async () => {
  const r = mk();
  assert.equal(await r.resolve({}), null);
  await assert.rejects(() => r.require({}), (e) => e.code === "unauthenticated" && e.httpStatus === 401);
});

test("a validly signed token resolves to its own subject", async () => {
  const r = mk();
  const tok = signLocalToken(SECRET, { sub: "user-alice", email: "alice@example.com" });
  const p = await r.resolve({ authorization: "Bearer " + tok });
  assert.equal(p.id, "user-alice");
  assert.equal(p.source, "local-hs256");
});

test("different users map to different principals (no principal collapse)", async () => {
  const r = mk();
  const a = await r.resolve({ authorization: "Bearer " + signLocalToken(SECRET, { sub: "user-alice" }) });
  const b = await r.resolve({ authorization: "Bearer " + signLocalToken(SECRET, { sub: "user-bob" }) });
  assert.notEqual(a.id, b.id);
});

test("a token signed with the wrong secret fails", async () => {
  const r = mk();
  const forged = signLocalToken("attacker-secret", { sub: "user-alice" });
  await assert.rejects(() => r.resolve({ authorization: "Bearer " + forged }), (e) => e.detail === "signature mismatch");
});

test("tampering with the payload of a valid token fails", async () => {
  const r = mk();
  const tok = signLocalToken(SECRET, { sub: "user-alice" });
  const [h, , s] = tok.split(".");
  const evil = Buffer.from(JSON.stringify({ sub: "user-admin", exp: 4e9 })).toString("base64url");
  await assert.rejects(() => r.resolve({ authorization: `Bearer ${h}.${evil}.${s}` }), (e) => e.httpStatus === 401);
});

test("alg:none is rejected", async () => {
  const r = mk();
  const h = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const p = Buffer.from(JSON.stringify({ sub: "user-admin", exp: 4e9 })).toString("base64url");
  await assert.rejects(() => r.resolve({ authorization: `Bearer ${h}.${p}.` }), (e) => e.detail === "unsupported algorithm");
});

test("an expired token is rejected", async () => {
  const r = mk();
  const tok = signLocalToken(SECRET, { sub: "user-alice" }, -10);
  await assert.rejects(() => r.resolve({ authorization: "Bearer " + tok }), (e) => e.detail === "token expired");
});

test("supabase mode: a rejected token throws 401 and never yields a header identity", async () => {
  const r = createPrincipalResolver({
    supabaseUrl: "https://example.supabase.co",
    supabaseKey: "svc",
    fetch: async () => ({ ok: false, status: 401, json: async () => ({}) }),
  });
  await assert.rejects(
    () => r.resolve({ authorization: "Bearer bad", "x-user-id": "victim-uuid" }),
    (e) => e.code === "invalid_token"
  );
});

test("supabase mode: an unreachable auth service fails closed (502), never open", async () => {
  const r = createPrincipalResolver({
    supabaseUrl: "https://example.supabase.co",
    supabaseKey: "svc",
    fetch: async () => { throw new Error("ECONNREFUSED"); },
  });
  await assert.rejects(() => r.resolve({ authorization: "Bearer whatever" }), (e) => e.httpStatus === 502);
});

test("supabase mode: a verified token yields the supabase subject, not the header", async () => {
  const r = createPrincipalResolver({
    supabaseUrl: "https://example.supabase.co",
    supabaseKey: "svc",
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ id: "real-uuid", email: "real@dcsai.ai" }) }),
  });
  const p = await r.resolve({ authorization: "Bearer good", "x-user-id": "victim-uuid" });
  assert.equal(p.id, "real-uuid");
  assert.equal(p.source, "supabase");
});

test("internal-tester allowlist marks the principal, and outsiders are not marked", async () => {
  const r = mk({ internalTesters: "alice@example.com" });
  const a = await r.resolve({ authorization: "Bearer " + signLocalToken(SECRET, { sub: "u1", email: "alice@example.com" }) });
  const b = await r.resolve({ authorization: "Bearer " + signLocalToken(SECRET, { sub: "u2", email: "mallory@example.com" }) });
  assert.equal(a.isInternalTester, true);
  assert.equal(b.isInternalTester, false);
});
