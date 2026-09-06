// A1 — canonical authenticated principal. PARENT-OWNED CHOKEPOINT.
//
// Round-2 P0 defect, confirmed live against production on 6 Sep 2026:
//   GET /api/worlds/mine
//   Authorization: Bearer nope
//   x-user-id: victim-uuid
//   -> HTTP 200 {"ok":true,"owner":"victim-uuid"}
// An unverifiable token fell through to an attacker-controlled header.
//
// This module is the single place a request becomes an identity. There is no
// header fallback, no "bearer is the id" shortcut against a live project, and
// no path where a failed verification yields a principal.
import crypto from "node:crypto";
import { Errors } from "./errors.mjs";

/** @typedef {{id:string, source:string, email:string|null, roles:string[], ageTier:string|null, isInternalTester:boolean}} Principal */

const VERIFY_CACHE_TTL_MS = 60_000;
const _cache = new Map(); // token-hash -> { principal, expires }

function hashToken(t) {
  return crypto.createHash("sha256").update(t).digest("base64url");
}

function b64urlJson(s) {
  return JSON.parse(Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
}

/** Constant-time compare that never throws on length mismatch. */
function safeEqual(a, b) {
  const A = Buffer.from(a), B = Buffer.from(b);
  if (A.length !== B.length) return false;
  return crypto.timingSafeEqual(A, B);
}

// ---------------------------------------------------------------- local HS256
// Used for internal testing and CI when no Supabase project is configured.
// These are real signed JWTs: a forged or edited token fails verification.

export function signLocalToken(secret, claims, ttlSeconds = 3600) {
  const header = { alg: "HS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const payload = { iat: now, exp: now + ttlSeconds, iss: "dcs-games-local", ...claims };
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const signingInput = `${enc(header)}.${enc(payload)}`;
  const sig = crypto.createHmac("sha256", secret).update(signingInput).digest("base64url");
  return `${signingInput}.${sig}`;
}

export function verifyLocalToken(secret, token) {
  const parts = String(token).split(".");
  if (parts.length !== 3) throw Errors.invalidToken("malformed token");
  const [h, p, sig] = parts;
  let header;
  try { header = b64urlJson(h); } catch { throw Errors.invalidToken("malformed header"); }
  // Reject alg confusion outright — "none" and asymmetric algs are never accepted here.
  if (!header || header.alg !== "HS256") throw Errors.invalidToken("unsupported algorithm");
  const expected = crypto.createHmac("sha256", secret).update(`${h}.${p}`).digest("base64url");
  if (!safeEqual(sig, expected)) throw Errors.invalidToken("signature mismatch");
  let payload;
  try { payload = b64urlJson(p); } catch { throw Errors.invalidToken("malformed payload"); }
  if (!payload.sub) throw Errors.invalidToken("token carries no subject");
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp === "number" && payload.exp < now) throw Errors.invalidToken("token expired");
  if (typeof payload.nbf === "number" && payload.nbf > now) throw Errors.invalidToken("token not yet valid");
  return payload;
}

// ------------------------------------------------------------------ resolver

export function createPrincipalResolver(cfg = {}) {
  const supabaseUrl = (cfg.supabaseUrl ?? process.env.SUPABASE_URL ?? "").replace(/\/$/, "");
  const supabaseKey = cfg.supabaseKey ?? process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  const localSecret = cfg.localSecret ?? process.env.DCS_AUTH_SECRET ?? "";
  const fetchImpl = cfg.fetch || globalThis.fetch;
  const testers = new Set(
    String(cfg.internalTesters ?? process.env.DCS_INTERNAL_TESTERS ?? "")
      .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)
  );

  const hasSupabase = !!(supabaseUrl && supabaseKey);
  let ephemeralSecret = "";
  if (!hasSupabase && !localSecret) {
    // Never silently accept anything. Boot with a random secret so no previously
    // issued or guessed token can validate, and say so loudly.
    ephemeralSecret = crypto.randomBytes(32).toString("hex");
    console.warn(JSON.stringify({
      level: "warn",
      auth: "ephemeral-secret",
      detail: "Neither SUPABASE_URL/SERVICE_ROLE_KEY nor DCS_AUTH_SECRET is set. A random per-boot secret was generated; all tokens are invalid across restarts.",
      ts: new Date().toISOString(),
    }));
  }
  const secret = localSecret || ephemeralSecret;
  const mode = hasSupabase ? "supabase-jwt" : (localSecret ? "local-hs256" : "local-hs256-ephemeral");

  function decorate(id, source, email, claims = {}) {
    const roles = Array.isArray(claims.roles) ? claims.roles.slice() : [];
    const key = String(email || id).toLowerCase();
    const isInternalTester = testers.has(key) || testers.has(String(id).toLowerCase()) || roles.includes("internal_tester");
    if (isInternalTester && !roles.includes("internal_tester")) roles.push("internal_tester");
    return Object.freeze({
      id: String(id),
      source,
      email: email || null,
      roles: Object.freeze(roles),
      ageTier: claims.age_tier || claims.ageTier || null,
      isInternalTester,
    });
  }

  /**
   * Resolve the caller. Returns null for an anonymous request (no credential
   * presented at all). THROWS AppError for a credential that was presented and
   * failed — a bad token is never downgraded to anonymous, and never to a header.
   * @returns {Promise<Principal|null>}
   */
  async function resolve(headers = {}, correlationId) {
    const get = (n) => {
      const v = headers[n] ?? headers[n.toLowerCase()];
      return Array.isArray(v) ? v[0] : (v == null ? "" : String(v));
    };
    const raw = get("authorization");
    const token = raw.replace(/^Bearer\s+/i, "").trim();

    // The header that caused the P0. It is read only to refuse it loudly.
    const legacy = get("x-user-id");
    if (legacy && !token) {
      throw Errors.unauthenticated(
        "x-user-id is not an authentication mechanism and was removed on 6 Sep 2026; present a Bearer token",
        { correlationId, meta: { removed_header: "x-user-id" } }
      );
    }
    if (!token) return null;

    const ck = hashToken(token);
    const hit = _cache.get(ck);
    if (hit && hit.expires > Date.now()) return hit.principal;

    let principal;
    if (hasSupabase) {
      let r;
      try {
        r = await fetchImpl(supabaseUrl + "/auth/v1/user", {
          headers: { apikey: supabaseKey, Authorization: "Bearer " + token },
        });
      } catch (e) {
        // Verification could not be performed. Fail closed — never guess.
        throw Errors.upstream("supabase-auth", String(e?.message || e), { correlationId });
      }
      if (!r.ok) throw Errors.invalidToken("supabase rejected the token", { correlationId, meta: { upstream_status: r.status } });
      const u = await r.json().catch(() => null);
      if (!u || !u.id) throw Errors.invalidToken("supabase returned no subject", { correlationId });
      principal = decorate(u.id, "supabase", u.email, { ...(u.user_metadata || {}), ...(u.app_metadata || {}) });
    } else {
      const claims = verifyLocalToken(secret, token); // throws AppError on any failure
      principal = decorate(claims.sub, "local-hs256", claims.email, claims);
    }

    _cache.set(ck, { principal, expires: Date.now() + VERIFY_CACHE_TTL_MS });
    return principal;
  }

  /** Resolve, and refuse anonymous. Use on every private route. */
  async function require_(headers, correlationId) {
    const p = await resolve(headers, correlationId);
    if (!p) throw Errors.unauthenticated("this route requires an authenticated principal", { correlationId });
    return p;
  }

  return {
    mode,
    hasSupabase,
    resolve,
    require: require_,
    /**
     * Is this id or email on the internal-tester ALLOWLIST?
     *
     * Deliberately narrower than a resolved principal's isInternalTester, which
     * also honours an `internal_tester` role carried in that principal's own
     * token. We are being asked about somebody else, and we do not hold their
     * token — so the only evidence available is the allowlist this operator
     * controls. Comping a plan for a subject whose tester status we cannot
     * verify is exactly the ambiguous grant the dark-subscription rules exist
     * to prevent, so an unverifiable claim reads as "no".
     */
    isInternalTesterId(idOrEmail) {
      const k = String(idOrEmail || "").toLowerCase();
      return !!k && testers.has(k);
    },
    /** Test/internal helper — only meaningful in local-hs256 mode. */
    issueLocalToken: (claims, ttl) => signLocalToken(secret, claims, ttl),
    _clearCache: () => _cache.clear(),
  };
}
