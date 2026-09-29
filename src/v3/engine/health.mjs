// GAMES-A — provider health and circuit breaking.
//
// A provider that keeps failing is skipped for a cooldown instead of being
// asked again on every request (each ask costs the caller a timeout). AUTH
// failures open the circuit at once and for longer: a revoked key does not
// recover by itself. After the cooldown one trial call is let through
// (half-open); success closes the circuit, failure re-opens it.
import { failurePolicy, FAILURE } from "./failures.mjs";

export class HealthRegistry {
  constructor({ failureThreshold = 3, cooldownMs = 60_000, authCooldownMs = 15 * 60_000, now = () => Date.now() } = {}) {
    Object.assign(this, { failureThreshold, cooldownMs, authCooldownMs, now });
    this.state = new Map();
  }

  _get(p) {
    if (!this.state.has(p)) this.state.set(p, { circuit: "closed", consecutive: 0, successes: 0, failures: 0, openUntil: 0, lastFailure: null, latencyEwmaMs: null });
    return this.state.get(p);
  }

  canCall(p) {
    const s = this._get(p);
    if (s.circuit !== "open") return true;
    if (this.now() >= s.openUntil) { s.circuit = "half_open"; return true; }
    return false;
  }

  recordSuccess(p, latencyMs) {
    const s = this._get(p);
    s.circuit = "closed"; s.consecutive = 0; s.successes++;
    s.latencyEwmaMs = s.latencyEwmaMs == null ? latencyMs : Math.round(s.latencyEwmaMs * 0.7 + latencyMs * 0.3);
  }

  recordFailure(p, cls) {
    if (!failurePolicy(cls).health) return;
    const s = this._get(p);
    s.failures++; s.consecutive++; s.lastFailure = cls;
    if (cls === FAILURE.AUTH) this._open(s, this.authCooldownMs);
    else if (s.circuit === "half_open" || s.consecutive >= this.failureThreshold) this._open(s, this.cooldownMs);
  }

  _open(s, ms) { s.circuit = "open"; s.openUntil = this.now() + ms; }

  snapshot() {
    const out = {};
    for (const [p, s] of this.state) out[p] = { circuit: s.circuit, consecutive_failures: s.consecutive, successes: s.successes, failures: s.failures, last_failure: s.lastFailure, latency_ewma_ms: s.latencyEwmaMs };
    return out;
  }
}
