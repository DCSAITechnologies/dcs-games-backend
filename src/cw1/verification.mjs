// CW1 Identity — P2 verification flow. Email + phone verification that feeds computed level.
// Pure logic + an in-memory challenge store. Mock generates codes; production sends via
// email/SMS provider (the send step is the only external piece — flagged, not faked here).

const CODE_TTL_MS = 10 * 60 * 1000;   // 10 minutes
const MAX_ATTEMPTS = 5;

// challenge store: key `${user_id}:${channel}` -> { code, expires, attempts, verified }
export function createVerificationStore() {
  const store = new Map();
  const key = (uid, ch) => `${uid}:${ch}`;

  // Issue a challenge. The code is NEVER returned by default.
  //
  // This used to return `_devCode` unconditionally, and every caller inherited
  // that: any user could read their own code out of the response and verify an
  // address they do not own. computeLevel treats a verification as a TRUST
  // signal, so a verification you can grant yourself is not a verification.
  // src/core/verification.mjs is the real implementation and never returns a
  // code in any mode.
  //
  // The runnable development mock genuinely needs to complete the loop with no
  // provider, so it OPTS IN explicitly and visibly at the call site. A dangerous
  // default that one caller needed is now a safe default that one caller asks
  // for by name.
  function issue(user_id, channel, { returnCodeForMockOnly = false } = {}) {
    if (!["email", "phone"].includes(channel)) return { ok: false, reason: "bad_channel" };
    const code = String(Math.floor(100000 + Math.random() * 900000)); // 6-digit
    store.set(key(user_id, channel), { code, expires: Date.now() + CODE_TTL_MS, attempts: 0, verified: false });
    const out = { ok: true, channel, sent: true };
    if (returnCodeForMockOnly) out._devCode = code;
    return out;
  }

  // verify a submitted code. Enforces expiry + attempt cap.
  function verify(user_id, channel, submitted) {
    const k = key(user_id, channel);
    const c = store.get(k);
    if (!c) return { ok: false, reason: "no_challenge" };
    if (c.verified) return { ok: true, already: true, channel };
    if (Date.now() > c.expires) { store.delete(k); return { ok: false, reason: "expired" }; }
    if (c.attempts >= MAX_ATTEMPTS) { store.delete(k); return { ok: false, reason: "too_many_attempts" }; }
    c.attempts++;
    if (String(submitted) !== c.code) return { ok: false, reason: "wrong_code", remaining: MAX_ATTEMPTS - c.attempts };
    c.verified = true;
    return { ok: true, channel };  // caller flips user.<channel>_verified, which re-computes level
  }

  function status(user_id) {
    return {
      email: store.get(key(user_id, "email"))?.verified || false,
      phone: store.get(key(user_id, "phone"))?.verified || false
    };
  }

  return { issue, verify, status, _store: store, CODE_TTL_MS, MAX_ATTEMPTS };
}
