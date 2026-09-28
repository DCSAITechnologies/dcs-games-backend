// GAMES-C guard — multiplayer abuse controls.
//
// Pure, clock-injectable primitives the netcode can call per message and per
// connection. No timers, no I/O: a caller passes `now` (ms) or a clock.
// Netcode (dcs-games-c-netcode) has its own speedhack/validation; these cover
// the transport-level abuse classes: flood, oversized payloads, connection
// exhaustion per IP / per session.

export const MP_LIMITS = Object.freeze({
  msgPerSec: 30,            // sustained input rate per session
  burst: 60,                // bucket capacity
  maxPayloadBytes: 16 * 1024,
  maxPayloadDepth: 8,
  maxPayloadKeys: 256,
  maxConnPerIp: 8,
  maxConnPerSession: 2,
  maxConnTotal: 5000,
  chatPerMin: 20,
});

/**
 * Token bucket. `take(key, cost=1, now)` -> {ok, remaining, retryAfterMs}.
 * State is a Map you can inspect/reset; stale keys pruned by `prune(now)`.
 */
export function createTokenBucket({ capacity = MP_LIMITS.burst, refillPerSec = MP_LIMITS.msgPerSec, clock = () => Date.now(), maxKeys = 100_000 } = {}) {
  const state = new Map();
  const refill = (b, now) => {
    const dt = Math.max(0, now - b.t) / 1000;
    b.tokens = Math.min(capacity, b.tokens + dt * refillPerSec);
    b.t = now;
  };
  return {
    state,
    take(key, cost = 1, now = clock()) {
      if (!(cost > 0) || !Number.isFinite(cost)) return { ok: false, remaining: 0, retryAfterMs: 0, code: "bad_cost" };
      let b = state.get(key);
      if (!b) {
        if (state.size >= maxKeys) return { ok: false, remaining: 0, retryAfterMs: 1000, code: "limiter_full" };
        b = { tokens: capacity, t: now }; state.set(key, b);
      }
      refill(b, now);
      if (b.tokens >= cost) { b.tokens -= cost; return { ok: true, remaining: Math.floor(b.tokens) }; }
      return { ok: false, code: "rate_limited", remaining: 0, retryAfterMs: Math.ceil(((cost - b.tokens) / refillPerSec) * 1000) };
    },
    prune(now = clock()) {
      for (const [k, b] of state) { refill(b, now); if (b.tokens >= capacity) state.delete(k); }
    },
  };
}

/** Payload cap: bytes, depth and key count, on a raw string or Buffer. */
export function checkPayload(raw, limits = {}) {
  const L = { ...MP_LIMITS, ...limits };
  const bytes = typeof raw === "string" ? Buffer.byteLength(raw, "utf8") : raw?.length ?? 0;
  if (bytes > L.maxPayloadBytes) return { ok: false, code: "payload_too_large", bytes, limit: L.maxPayloadBytes };
  if (typeof raw !== "string" && !Buffer.isBuffer(raw)) return { ok: false, code: "bad_payload" };
  const text = String(raw);
  let depth = 0, inStr = false, esc = false;
  for (const c of text) {
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === "{" || c === "[") { if (++depth > L.maxPayloadDepth) return { ok: false, code: "payload_too_deep", limit: L.maxPayloadDepth }; }
    else if (c === "}" || c === "]") depth--;
  }
  let value;
  try { value = JSON.parse(text); } catch { return { ok: false, code: "payload_not_json" }; }
  let keys = 0;
  const count = (v) => { if (v && typeof v === "object") { const e = Array.isArray(v) ? v : Object.values(v); keys += e.length; e.forEach(count); } };
  count(value);
  if (keys > L.maxPayloadKeys) return { ok: false, code: "payload_too_many_keys", keys, limit: L.maxPayloadKeys };
  return { ok: true, bytes, value };
}

/**
 * Connection admission. `admit({ip, sessionId})` -> {ok, code?, release()}.
 * Pure bookkeeping; the caller must call release() on disconnect.
 */
export function createConnectionLimiter({ perIp = MP_LIMITS.maxConnPerIp, perSession = MP_LIMITS.maxConnPerSession, total = MP_LIMITS.maxConnTotal } = {}) {
  const byIp = new Map(), bySession = new Map();
  let open = 0;
  const inc = (m, k, d) => { const v = (m.get(k) || 0) + d; if (v <= 0) m.delete(k); else m.set(k, v); };
  return {
    get open() { return open; },
    admit({ ip, sessionId }) {
      if (!ip || !sessionId) return { ok: false, code: "missing_identity" };
      if (open >= total) return { ok: false, code: "server_full" };
      if ((byIp.get(ip) || 0) >= perIp) return { ok: false, code: "too_many_per_ip" };
      if ((bySession.get(sessionId) || 0) >= perSession) return { ok: false, code: "too_many_per_session" };
      inc(byIp, ip, 1); inc(bySession, sessionId, 1); open++;
      let released = false;
      return { ok: true, release() { if (released) return; released = true; inc(byIp, ip, -1); inc(bySession, sessionId, -1); open--; } };
    },
  };
}
