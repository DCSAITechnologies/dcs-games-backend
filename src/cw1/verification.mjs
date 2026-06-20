// CW1 Identity — P2 verification flow. Email + phone verification that feeds computed level.
// Pure logic + an in-memory challenge store. Mock generates codes; production sends via
// email/SMS provider (the send step is the only external piece — flagged, not faked here).

const CODE_TTL_MS = 10 * 60 * 1000;   // 10 minutes
const MAX_ATTEMPTS = 5;

// challenge store: key `${user_id}:${channel}` -> { code, expires, attempts, verified }
export function createVerificationStore() {
  const store = new Map();
  const key = (uid, ch) => `${uid}:${ch}`;

  // issue a challenge. In prod the code is SENT (email/SMS) and NOT returned to the client.
  // The mock returns _devCode so tests/dev can complete the loop without a real provider.
  function issue(user_id, channel) {
    if (!["email", "phone"].includes(channel)) return { ok: false, reason: "bad_channel" };
    const code = String(Math.floor(100000 + Math.random() * 900000)); // 6-digit
    store.set(key(user_id, channel), { code, expires: Date.now() + CODE_TTL_MS, attempts: 0, verified: false });
    return { ok: true, channel, sent: true, _devCode: code };  // _devCode mock-only
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
