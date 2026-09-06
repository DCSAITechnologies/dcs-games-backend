// A1 exit gate. These tests encode the Round-2 P0 as executable regressions:
// forged identity must fail, an invalid token must never fall through, and two
// users must never collapse onto the same principal.
import test from "node:test";
import assert from "node:assert/strict";
import { createPrincipalResolver, signLocalToken, verifyLocalToken } from "../src/core/principal.mjs";

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

// =============================================================================
// SECOND PASS — Lane L, 6 Sep 2026.
//
// The tests above prove the x-user-id P0 is closed at the resolver. This pass
// asks the questions they do not: does the resolver hold when there is more
// than one of it in a process, does a verification stay true after the token
// stops being valid, and is the refusal of the removed header actually
// insensitive to how the header is spelled.
//
// The verification cache is module-level state shared by every resolver, so
// every test below clears it on the way in AND on the way out. Without that a
// failing test here would corrupt the tests above it.
// =============================================================================

const clearAuthCache = () => mk()._clearCache();

// ---------------------------------------------------------------- the cache

test("DEFECT, OPEN: a token verified by one resolver is accepted by a resolver with a different secret", async () => {
  // DEFECT, OPEN (found by Lane L, 6 Sep 2026). SEVERITY: HIGH.
  //
  // src/core/principal.mjs:19 declares the verification cache at MODULE scope:
  //     const _cache = new Map();               // token-hash -> { principal, expires }
  // and src/core/principal.mjs:137 keys it on hashToken(token) alone — nothing
  // about WHICH resolver, which secret, or which mode did the verifying. Every
  // resolver in the process therefore shares one another's verdicts.
  //
  // REPRODUCTION (below): resolver A is configured with secret "SECRET-A" and
  // resolves a token signed with it. Resolver B is configured with "SECRET-B" —
  // a completely different key — and returns the SAME principal for the SAME
  // token, having verified nothing.
  //
  // CONSEQUENCES: rotating DCS_AUTH_SECRET does not take effect for
  // VERIFY_CACHE_TTL_MS; and see the two tests below for the mode and
  // internal-tester variants, which are worse.
  //
  // FIX BELONGS IN src/core/principal.mjs:19 — the cache must live INSIDE
  // createPrincipalResolver, or its key must include the resolver's mode and a
  // digest of the secret it verifies against.
  clearAuthCache();
  try {
    const a = createPrincipalResolver({ localSecret: "SECRET-A", supabaseUrl: "", supabaseKey: "" });
    const tok = signLocalToken("SECRET-A", { sub: "alice" });
    assert.equal((await a.resolve({ authorization: "Bearer " + tok })).id, "alice");

    const b = createPrincipalResolver({ localSecret: "SECRET-B", supabaseUrl: "", supabaseKey: "" });
    await assert.rejects(
      () => b.resolve({ authorization: "Bearer " + tok }),
      (e) => e.httpStatus === 401,
      "a resolver that does not hold the signing secret must not authenticate the token",
    );
  } finally { clearAuthCache(); }
});

test("DEFECT, OPEN: a supabase-mode resolver returns a cached local principal without contacting supabase", async () => {
  // DEFECT, OPEN (found by Lane L, 6 Sep 2026). SEVERITY: HIGH — this is
  // token-mode confusion, and it is the sharpest form of the shared-cache bug.
  // The cache hit at src/core/principal.mjs:138-139 returns BEFORE the
  // `if (hasSupabase)` branch, so a locally-signed HS256 token that some other
  // resolver in the process accepted is handed to a resolver whose entire job
  // is to ask Supabase who the caller is. The injected fetch below THROWS if it
  // is ever called, so the assertion cannot pass by accident.
  // FIX: src/core/principal.mjs:19 (see previous test).
  clearAuthCache();
  try {
    const localR = mk();
    const tok = signLocalToken(SECRET, { sub: "alice" });
    await localR.resolve({ authorization: "Bearer " + tok });

    const supa = createPrincipalResolver({
      supabaseUrl: "https://example.supabase.co", supabaseKey: "svc",
      fetch: async () => { throw new Error("supabase was never asked"); },
    });
    await assert.rejects(
      () => supa.resolve({ authorization: "Bearer " + tok }),
      (e) => e.httpStatus === 401 || e.httpStatus === 502,
      "a supabase-mode resolver must verify against supabase, not against another resolver's cache",
    );
  } finally { clearAuthCache(); }
});

test("DEFECT, OPEN: the internal-tester flag crosses resolvers through the cache", async () => {
  // DEFECT, OPEN (found by Lane L, 6 Sep 2026). SEVERITY: HIGH — this is a
  // privilege decision, not just an identity one.
  //
  // decorate() (src/core/principal.mjs:99-110) stamps isInternalTester onto the
  // principal from THAT resolver's allowlist, and the whole decorated principal
  // is what gets cached. A resolver built with an EMPTY allowlist then returns a
  // principal marked isInternalTester: true. server.mts:229-238 gates on exactly
  // that field, so the surfaces behind mustBeInternalTester — /ts/*, world
  // generation, expansion, rollback, marketplace listings, subscription grants —
  // are reachable by a principal the operator did not allowlist.
  // FIX: src/core/principal.mjs:19 (see above).
  clearAuthCache();
  try {
    const withList = mk({ internalTesters: "alice@example.com" });
    const withoutList = mk();
    const tok = signLocalToken(SECRET, { sub: "u-alice", email: "alice@example.com" });
    assert.equal((await withList.resolve({ authorization: "Bearer " + tok })).isInternalTester, true);
    assert.equal(
      (await withoutList.resolve({ authorization: "Bearer " + tok })).isInternalTester, false,
      "a resolver with an empty allowlist must not report an internal tester",
    );
  } finally { clearAuthCache(); }
});

test("DEFECT, OPEN: an expired token keeps working for as long as the cache holds it", async () => {
  // DEFECT, OPEN (found by Lane L, 6 Sep 2026). SEVERITY: MEDIUM, and unlike
  // the three above this one is reachable with the SINGLE resolver server.mts
  // builds.
  //
  // verifyLocalToken checks exp (src/core/principal.mjs:64) — but only on a
  // cache MISS. The cache entry's own expiry is `Date.now() + 60_000`
  // (src/core/principal.mjs:154), taken from the moment of verification and not
  // capped by the token's exp. A token with one second left is therefore honoured
  // for up to a further sixty. Revocation by expiry — the only revocation local
  // mode has — is late by a fixed minute, on every route.
  //
  // FIX BELONGS IN src/core/principal.mjs:152-155 — cap the entry at the
  // token's own exp (`Math.min(now + TTL, exp * 1000)`), or re-check exp on a
  // cache hit at :138-139.
  clearAuthCache();
  try {
    const r = mk();
    const tok = signLocalToken(SECRET, { sub: "bob" }, 1);
    assert.equal((await r.resolve({ authorization: "Bearer " + tok })).id, "bob");
    await new Promise((res) => setTimeout(res, 1600));
    await assert.rejects(
      () => r.resolve({ authorization: "Bearer " + tok }),
      (e) => e.httpStatus === 401,
      "an expired token must stop authenticating the moment it expires, not a cache TTL later",
    );
  } finally { clearAuthCache(); }
});

// ------------------------------------------------------------- header spelling

test("DEFECT, OPEN: the removed x-user-id header is refused only in lower case", async () => {
  // DEFECT, OPEN (found by Lane L, 6 Sep 2026). SEVERITY: LOW — not reachable
  // through node:http, which lower-cases req.headers, but the code is written
  // as though it were case-insensitive and is not.
  //
  // src/core/principal.mjs:120-123:
  //     const get = (n) => { const v = headers[n] ?? headers[n.toLowerCase()]; ... }
  // Both call sites pass an already-lower-case name ("authorization",
  // "x-user-id"), so `n` and `n.toLowerCase()` are the same string and the
  // fallback does nothing. HTTP header names are case-INSENSITIVE by RFC 9110;
  // any caller that does not pre-normalise — a fetch Headers object spread into
  // a plain object, a serverless/proxy adapter, a test — gets:
  //   * "X-User-Id: victim" with no token  -> anonymous, SILENTLY, instead of
  //     the loud "x-user-id is not an authentication mechanism" refusal that is
  //     the entire A1 guarantee; and
  //   * "Authorization: Bearer <valid>"    -> anonymous, so a legitimate caller
  //     is logged out rather than authenticated.
  // The refusal going quiet is the security-relevant half: it is the one line
  // that tells an operator someone is still trying the removed header.
  //
  // FIX BELONGS IN src/core/principal.mjs:120-123 — normalise the HEADERS once
  // (lower-case every key) rather than the name.
  clearAuthCache();
  try {
    const r = mk();
    await assert.rejects(
      () => r.resolve({ "X-User-Id": "victim-uuid" }),
      (e) => e.code === "unauthenticated",
      "the removed header must be refused however it is capitalised",
    );
    const p = await r.resolve({ Authorization: "Bearer " + signLocalToken(SECRET, { sub: "carol" }) });
    assert.equal(p && p.id, "carol", "a canonically capitalised Authorization header must still authenticate");
  } finally { clearAuthCache(); }
});

test("DEFECT, OPEN: the issuer this estate stamps on a token is never checked when verifying it", () => {
  // DEFECT, OPEN (found by Lane L, 6 Sep 2026). SEVERITY: LOW, conditional.
  //
  // signLocalToken sets `iss: "dcs-games-local"` (src/core/principal.mjs:44) —
  // the estate names itself in every token it mints. verifyLocalToken
  // (:50-68) checks alg, signature, sub, exp and nbf, and never looks at iss or
  // aud. So a token minted by ANY other service that shares DCS_AUTH_SECRET
  // authenticates here as its own subject. The naming of an issuer implies a
  // multi-product estate — "dcs-games-local" alongside the DCS Sports product
  // the cross-product reputation seam is built for — which is exactly the
  // condition under which an unchecked iss becomes a cross-product
  // authentication bypass.
  //
  // Not exploitable while DCS_AUTH_SECRET is unique to this service. Recorded
  // because the check is one line and the claim is already written into the
  // token.
  //
  // FIX BELONGS IN src/core/principal.mjs:50-68 — reject a token whose iss is
  // present and is not this estate's.
  const foreign = signLocalToken(SECRET, { sub: "alice", iss: "dcs-sports-local", aud: "sports" });
  assert.throws(
    () => verifyLocalToken(SECRET, foreign),
    (e) => e.httpStatus === 401,
    "a token issued for another service must not authenticate here",
  );
});

// ============================================================ HOLDS — regressions
// Attacks that CORRECTLY failed. Pinned so they stay failed.

test("a duplicated or array-valued x-user-id is still refused, not read", async () => {
  // node:http joins repeated headers; a raw adapter may hand over an array.
  // Both must reach the same refusal, and neither may yield a principal.
  clearAuthCache();
  try {
    const r = mk();
    for (const value of ["victim, other", ["victim", "other"], ["victim"]]) {
      await assert.rejects(
        () => r.resolve({ "x-user-id": value }),
        (e) => e.code === "unauthenticated" && e.meta?.removed_header === "x-user-id",
        `x-user-id: ${JSON.stringify(value)}`,
      );
    }
  } finally { clearAuthCache(); }
});

test("an array-valued authorization header authenticates from its first value only", async () => {
  clearAuthCache();
  try {
    const r = mk();
    const good = signLocalToken(SECRET, { sub: "carol" });
    assert.equal((await r.resolve({ authorization: [`Bearer ${good}`, "Bearer nope"] })).id, "carol");
    await assert.rejects(() => r.resolve({ authorization: ["Bearer nope", `Bearer ${good}`] }), (e) => e.httpStatus === 401);
  } finally { clearAuthCache(); }
});

test("a forged x-user-id beside a VALID token is ignored, not merged", async () => {
  // The route-level shape of the P0: the attacker holds a real account and
  // names someone else. The principal must be the token's subject, and nothing
  // on it may carry the header's value.
  clearAuthCache();
  try {
    const r = mk();
    const p = await r.resolve({ authorization: "Bearer " + signLocalToken(SECRET, { sub: "attacker" }), "x-user-id": "victim-uuid" });
    assert.equal(p.id, "attacker");
    assert.equal(JSON.stringify(p).includes("victim-uuid"), false, "no field of the principal may carry the header");
  } finally { clearAuthCache(); }
});

test("a supabase-shaped token is refused by a local-hs256 resolver", async () => {
  // Token confusion, the direction that is reachable: a real Supabase access
  // token is RS256/ES256 and carries a kid. Local mode must refuse it on the
  // algorithm rather than attempt anything with it.
  clearAuthCache();
  try {
    const r = mk();
    for (const alg of ["RS256", "ES256", "HS512", "none", "hs256"]) {
      const h = Buffer.from(JSON.stringify({ alg, typ: "JWT", kid: "abc" })).toString("base64url");
      const p = Buffer.from(JSON.stringify({ sub: "service_role", role: "service_role", aud: "authenticated", exp: 4e9 })).toString("base64url");
      await assert.rejects(
        () => r.resolve({ authorization: `Bearer ${h}.${p}.AAAA` }),
        (e) => e.detail === "unsupported algorithm",
        `alg: ${alg}`,
      );
    }
  } finally { clearAuthCache(); }
});

test("a token with no subject, or a not-yet-valid one, is refused", async () => {
  clearAuthCache();
  try {
    const r = mk();
    await assert.rejects(() => r.resolve({ authorization: "Bearer " + signLocalToken(SECRET, { email: "a@b.c" }) }), (e) => e.detail === "token carries no subject");
    const nbf = Math.floor(Date.now() / 1000) + 3600;
    await assert.rejects(() => r.resolve({ authorization: "Bearer " + signLocalToken(SECRET, { sub: "alice", nbf }) }), (e) => e.detail === "token not yet valid");
  } finally { clearAuthCache(); }
});

test("a token cannot promote itself to internal tester in local mode without the secret", async () => {
  // roles are read from the token's claims (src/core/principal.mjs:100-103), so
  // in local mode they are only as forgeable as the signature. Editing the
  // claim without the secret must fail; signing it WITH the secret is by
  // definition the operator's own act.
  clearAuthCache();
  try {
    const r = mk();
    const honest = signLocalToken(SECRET, { sub: "mallory" });
    const [h, , s] = honest.split(".");
    const evil = Buffer.from(JSON.stringify({ sub: "mallory", roles: ["internal_tester"], exp: 4e9 })).toString("base64url");
    await assert.rejects(() => r.resolve({ authorization: `Bearer ${h}.${evil}.${s}` }), (e) => e.httpStatus === 401);
    assert.equal((await r.resolve({ authorization: "Bearer " + honest })).isInternalTester, false);
  } finally { clearAuthCache(); }
});

test("isInternalTesterId answers only from the operator allowlist, never from a claim", async () => {
  // The narrower question: "is this OTHER person a tester". A principal whose
  // own token carries the role is marked, but that must not make the estate
  // answer yes about them when someone else asks.
  clearAuthCache();
  try {
    const r = mk({ internalTesters: "alice@example.com" });
    const selfClaimed = await r.resolve({ authorization: "Bearer " + signLocalToken(SECRET, { sub: "mallory", roles: ["internal_tester"] }) });
    assert.equal(selfClaimed.isInternalTester, true, "their own token says so, so their principal says so");
    assert.equal(r.isInternalTesterId("mallory"), false, "but the estate must not vouch for them to anybody else");
    assert.equal(r.isInternalTesterId("alice@example.com"), true);
    assert.equal(r.isInternalTesterId(""), false);
    assert.equal(r.isInternalTesterId(null), false);
  } finally { clearAuthCache(); }
});

test("a resolved principal is frozen, so no route can edit who the caller is", async () => {
  clearAuthCache();
  try {
    const r = mk();
    const p = await r.resolve({ authorization: "Bearer " + signLocalToken(SECRET, { sub: "alice" }) });
    assert.equal(Object.isFrozen(p), true);
    assert.throws(() => { "use strict"; p.id = "victim"; });
    assert.throws(() => { "use strict"; p.roles.push("internal_tester"); });
    assert.equal(p.id, "alice");
  } finally { clearAuthCache(); }
});

// =============================================================================
// LANE C — auth and session integrity, adversarial closure (section 10).
// Each test is the attack, written first and reproduced against the code as it
// stood before this lane.
// =============================================================================

test("LANE C/P1: two different subjects must never collapse onto one principal id", async () => {
  // ATTACK: `sub` was accepted at any type and then coerced with String(id).
  // So sub:12345 (number) and sub:"12345" (string) resolve to the SAME principal
  // id, and every non-array object collapses onto "[object Object]". Principal
  // ids are the key for world ownership, inventories, collections and every
  // ownership comparison in the estate, so two distinct subjects sharing one id
  // is cross-user access by construction — one reads and writes the other's
  // objects, and every owner check agrees they are the same person.
  const r = mk();
  for (const bad of [12345, true, { a: 1 }, ["x"], null, ""]) {
    await assert.rejects(
      () => r.resolve({ authorization: "Bearer " + signLocalToken(SECRET, { sub: bad }) }),
      (e) => e.code === "invalid_token",
      `sub ${JSON.stringify(bad)} must be refused, not coerced into an id`,
    );
  }
  const ok = await r.resolve({ authorization: "Bearer " + signLocalToken(SECRET, { sub: "12345" }) });
  assert.equal(ok.id, "12345", "a real string subject still resolves");
});

test("LANE C/P2: a local token with no expiry is refused, because expiry is the only revocation", async () => {
  // ATTACK: verifyLocalToken guarded the expiry check with
  // `typeof payload.exp === "number"`, so a token carrying NO exp skipped it and
  // was valid forever. This file's own comment says expiry is "the only
  // revocation local mode has" — so a token without one can never be withdrawn,
  // and the verification cache had no bound to apply to it either.
  const forever = signLocalToken(SECRET, { sub: "m", exp: undefined });
  assert.equal(JSON.parse(Buffer.from(forever.split(".")[1], "base64url").toString()).exp, undefined,
    "precondition: the token really carries no exp");
  await assert.rejects(
    () => mk().resolve({ authorization: "Bearer " + forever }),
    (e) => e.code === "invalid_token",
    "a credential that can never expire must not be accepted",
  );
  // A normally minted token is unaffected.
  const good = await mk().resolve({ authorization: "Bearer " + signLocalToken(SECRET, { sub: "m" }, 60) });
  assert.equal(good.id, "m");
});

test("LANE C/P3: an unconfirmed email must not satisfy the internal-tester allowlist", async () => {
  // ATTACK: privilege escalation by claiming an allowlisted address.
  //
  // DCS_INTERNAL_TESTERS is matched against u.email straight off the GoTrue user
  // object, with no check that the identity provider ever confirmed the address.
  // isInternalTester gates world generation, rollback, marketplace listings,
  // subscription grants, the T&S console and the moderation queue. An account
  // holding an unconfirmed allowlisted address got all of it.
  //
  // An absent confirmation is not evidence of confirmation, so it is refused
  // too — the same rule the world store applies to an absent owner. The two
  // mechanisms that do not depend on an unverified claim still work: an
  // allowlist entry naming the principal ID, and app_metadata.roles, which is
  // service-role-only and is the mechanism this estate should prefer.
  const supa = (u) => createPrincipalResolver({
    supabaseUrl: "https://example.supabase.co", supabaseKey: "svc",
    internalTesters: "alice@dcsai.ai,real-uuid-on-the-list",
    fetch: async () => ({ ok: true, status: 200, json: async () => u }),
  });
  const who = async (u) => await supa(u).resolve({ authorization: "Bearer t" });

  const unconfirmed = await who({ id: "attacker", email: "alice@dcsai.ai", email_confirmed_at: null });
  assert.equal(unconfirmed.isInternalTester, false, "an unconfirmed allowlisted address grants nothing");
  assert.ok(!unconfirmed.roles.includes("internal_tester"));
  assert.equal(unconfirmed.email, "alice@dcsai.ai", "the address is still reported — it is profile data");

  const silent = await who({ id: "attacker2", email: "alice@dcsai.ai" });
  assert.equal(silent.isInternalTester, false, "absent evidence of confirmation is not evidence of confirmation");

  const confirmed = await who({ id: "alice", email: "alice@dcsai.ai", email_confirmed_at: "2026-01-01T00:00:00Z" });
  assert.equal(confirmed.isInternalTester, true, "a confirmed allowlisted address still works");

  const byConfirmedAt = await who({ id: "alice", email: "alice@dcsai.ai", confirmed_at: "2026-01-01T00:00:00Z" });
  assert.equal(byConfirmedAt.isInternalTester, true, "GoTrue's older confirmed_at spelling is honoured too");

  // The two mechanisms that never depended on an unverified claim.
  const byId = await who({ id: "real-uuid-on-the-list", email: "nobody@example.com", email_confirmed_at: null });
  assert.equal(byId.isInternalTester, true, "an allowlist entry naming the principal id is unaffected");
  const byAppMeta = await who({ id: "x", email: "nobody@example.com", app_metadata: { roles: ["internal_tester"] } });
  assert.equal(byAppMeta.isInternalTester, true, "app_metadata.roles is service-role-only and still authoritative");

  // And user_metadata still cannot grant anything (regression on the closed hole).
  const spoof = await who({ id: "x", email: "nobody@example.com", user_metadata: { roles: ["internal_tester"], email: "alice@dcsai.ai", is_internal_tester: true } });
  assert.equal(spoof.isInternalTester, false, "user_metadata is user-writable and grants nothing");
});

test("LANE C/P4: a locally signed token is trusted for its own email, because the service minted it", async () => {
  // The confirmation rule above is about a claim made by an EXTERNAL identity
  // provider. In local-hs256 mode the service signs the token itself, so the
  // email in it is as trustworthy as the signature — requiring a confirmation
  // field there would break every internal tester with no security gain.
  const r = mk({ internalTesters: "alice@dcsai.ai" });
  const p = await r.resolve({ authorization: "Bearer " + signLocalToken(SECRET, { sub: "u1", email: "alice@dcsai.ai" }) });
  assert.equal(p.isInternalTester, true);
});
