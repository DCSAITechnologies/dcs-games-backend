// P2 — email and phone verification, with a real provider seam.
//
// The build this replaces returned the verification code in the HTTP response
// body (`_devCode`). Any authenticated user could therefore verify their own
// address without ever receiving anything, which makes the signal worthless —
// and `computeLevel` treats email_verified as a TRUST signal that unlocks the
// `publisher` level and its publish credits. A verification you can grant
// yourself is not a verification.
//
// The rules here:
//   - the code is NEVER returned to a client, in any mode, ever
//   - with no provider configured, a challenge is not issued at all; the caller
//     gets an honest 503 rather than a code it can read
//   - a dev mode exists for internal testing, and it writes the code to the
//     SERVER LOG only, never to a response
//   - codes are compared in constant time, rate limited, attempt capped and
//     expiring, and are stored hashed rather than in the clear
import crypto from "node:crypto";
import path from "node:path";
import { Errors } from "./errors.mjs";
import { createCollection } from "./collection.mjs";

export const CHANNELS = ["email", "phone"];
export const CODE_TTL_MS = 10 * 60 * 1000;
export const MAX_ATTEMPTS = 5;
export const RESEND_COOLDOWN_MS = 60 * 1000;
const MAX_SENDS_PER_DAY = 10;

function sixDigit() {
  // Uniform over 000000..999999 without modulo bias.
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
}

function hashCode(code, salt) {
  return crypto.createHash("sha256").update(salt + ":" + code).digest("hex");
}

function constantTimeEqual(a, b) {
  const A = Buffer.from(String(a)), B = Buffer.from(String(b));
  if (A.length !== B.length) return false;
  return crypto.timingSafeEqual(A, B);
}

// ------------------------------------------------------------------ providers

/**
 * A delivery provider. `status()` reports whether it can actually send.
 * No provider is configured on this estate today, which is why the service
 * refuses to issue rather than pretending.
 */
export function emailProvider(env = process.env) {
  const url = env.DCS_EMAIL_PROVIDER_URL || "";
  const key = env.DCS_EMAIL_PROVIDER_KEY || "";
  return {
    channel: "email",
    name: env.DCS_EMAIL_PROVIDER_NAME || "email-provider",
    status: () => (url && key ? "AVAILABLE" : "UNAVAILABLE"),
    async send({ to, code, ttlMinutes }) {
      const r = await fetch(url.replace(/\/$/, "") + "/send", {
        method: "POST",
        headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
        body: JSON.stringify({
          to,
          subject: "Your DCS Games verification code",
          text: `Your DCS Games verification code is ${code}. It expires in ${ttlMinutes} minutes. If you did not request this, ignore this message.`,
        }),
        signal: AbortSignal.timeout(20000),
      }).catch((e) => { throw Errors.upstream("email-provider", String(e?.message || e)); });
      if (!r.ok) throw Errors.upstream("email-provider", `HTTP ${r.status}`);
      return { delivered: true };
    },
  };
}

export function smsProvider(env = process.env) {
  const url = env.DCS_SMS_PROVIDER_URL || "";
  const key = env.DCS_SMS_PROVIDER_KEY || "";
  return {
    channel: "phone",
    name: env.DCS_SMS_PROVIDER_NAME || "sms-provider",
    status: () => (url && key ? "AVAILABLE" : "UNAVAILABLE"),
    async send({ to, code, ttlMinutes }) {
      const r = await fetch(url.replace(/\/$/, "") + "/send", {
        method: "POST",
        headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
        body: JSON.stringify({ to, text: `DCS Games code ${code}, valid ${ttlMinutes} minutes.` }),
        signal: AbortSignal.timeout(20000),
      }).catch((e) => { throw Errors.upstream("sms-provider", String(e?.message || e)); });
      if (!r.ok) throw Errors.upstream("sms-provider", `HTTP ${r.status}`);
      return { delivered: true };
    },
  };
}

// -------------------------------------------------------------------- service

export function createVerificationService(env = process.env, providers = null) {
  const dir = path.join(env.DCS_DATA_DIR || path.join(process.cwd(), ".dcs-data"), "verification");
  const challenges = createCollection({ dir, name: "challenges", table: null, primaryKey: ["principal_id", "channel"], env });
  const verified = createCollection({ dir, name: "verified", table: null, primaryKey: ["principal_id", "channel"], env });

  const byChannel = {
    email: (providers && providers.email) || emailProvider(env),
    phone: (providers && providers.phone) || smsProvider(env),
  };

  /**
   * Dev mode logs the code to the SERVER, never to a response. It exists so an
   * internal tester can complete the loop without a provider contract; it is
   * off unless explicitly enabled, and it is reported in the response so nobody
   * can mistake a dev-mode verification for a real one.
   */
  const devMode = () => env.DCS_VERIFICATION_DEV_MODE === "1";

  const svc = {
    dir,

    describe() {
      return {
        channels: Object.fromEntries(CHANNELS.map((c) => [c, { provider: byChannel[c].name, status: byChannel[c].status() }])),
        dev_mode: devMode(),
        // Said plainly so /health cannot imply a capability that is absent.
        note: CHANNELS.every((c) => byChannel[c].status() !== "AVAILABLE")
          ? "No delivery provider is configured, so verification cannot be completed. This is why every principal reports email_verified=false."
          : null,
      };
    },

    /**
     * Issue a challenge. The code is sent by a provider and is NOT returned.
     */
    async start(principalId, channel, destination) {
      if (!principalId) throw Errors.unauthenticated("verification needs an authenticated principal");
      if (!CHANNELS.includes(channel)) throw Errors.validation(`channel must be one of: ${CHANNELS.join(", ")}`);
      if (!destination || typeof destination !== "string") throw Errors.validation("a destination address or number is required");
      if (channel === "email" && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(destination)) throw Errors.validation("that is not a valid email address");
      if (channel === "phone" && !/^\+?[0-9]{7,15}$/.test(destination.replace(/[\s-]/g, ""))) throw Errors.validation("that is not a valid phone number");

      const provider = byChannel[channel];
      const available = provider.status() === "AVAILABLE";
      if (!available && !devMode()) {
        // The honest failure. Issuing a code nobody can receive, and then
        // handing it back in the response, is how the previous build made
        // verification meaningless.
        throw Errors.notConfigured(
          `${channel} delivery (no provider is configured, so a code cannot be sent)`,
          { meta: { channel, provider: provider.name, dev_mode: false } }
        );
      }

      const existing = await challenges.one((c) => c.principal_id === principalId && c.channel === channel);
      const now = Date.now();
      if (existing) {
        if (now - new Date(existing.last_sent_at).getTime() < RESEND_COOLDOWN_MS) {
          throw Errors.conflict(`a code was already sent; wait ${Math.ceil((RESEND_COOLDOWN_MS - (now - new Date(existing.last_sent_at).getTime())) / 1000)}s before requesting another`);
        }
        const dayAgo = now - 86400000;
        const sends = (existing.sends || []).filter((t) => new Date(t).getTime() > dayAgo);
        if (sends.length >= MAX_SENDS_PER_DAY) {
          throw Errors.conflict(`too many codes requested for this ${channel} today`);
        }
      }

      const code = sixDigit();
      const salt = crypto.randomBytes(16).toString("hex");
      const row = {
        principal_id: principalId,
        channel,
        destination,
        // Stored hashed: a leaked store must not hand over live codes.
        code_hash: hashCode(code, salt),
        salt,
        expires_at: new Date(now + CODE_TTL_MS).toISOString(),
        attempts: 0,
        last_sent_at: new Date(now).toISOString(),
        sends: [...(existing?.sends || []).filter((t) => new Date(t).getTime() > now - 86400000), new Date(now).toISOString()],
        dev_mode: !available,
      };
      await challenges.upsert((c) => c.principal_id === principalId && c.channel === channel, row);

      if (available) {
        await provider.send({ to: destination, code, ttlMinutes: Math.round(CODE_TTL_MS / 60000) });
      } else {
        // SERVER LOG ONLY. This line is the entire reason dev mode is safe: the
        // code reaches an operator, never an HTTP client.
        console.warn(JSON.stringify({
          level: "warn", verification_dev_mode: true, channel, principal_id: principalId,
          destination, code, expires_at: row.expires_at,
          note: "DCS_VERIFICATION_DEV_MODE is on. This code is in the server log only and is NEVER returned to a client.",
          ts: new Date().toISOString(),
        }));
      }

      return {
        channel,
        destination: mask(channel, destination),
        sent: true,
        // Whether this can actually be trusted, stated up front.
        delivered_by: available ? provider.name : "server-log (dev mode)",
        dev_mode: !available,
        expires_in_seconds: Math.round(CODE_TTL_MS / 1000),
        // Deliberately absent: the code. There is no field for it and no mode
        // in which one appears.
      };
    },

    /** Confirm a code. Constant-time, attempt-capped, single-use. */
    async confirm(principalId, channel, submitted) {
      if (!principalId) throw Errors.unauthenticated("verification needs an authenticated principal");
      if (!CHANNELS.includes(channel)) throw Errors.validation(`channel must be one of: ${CHANNELS.join(", ")}`);
      const c = await challenges.one((x) => x.principal_id === principalId && x.channel === channel);
      if (!c) throw Errors.notFound(`a pending ${channel} verification`);

      if (Date.now() > new Date(c.expires_at).getTime()) {
        await challenges.remove((x) => x.principal_id === principalId && x.channel === channel);
        throw Errors.validation("that code has expired; request a new one");
      }
      if (c.attempts >= MAX_ATTEMPTS) {
        await challenges.remove((x) => x.principal_id === principalId && x.channel === channel);
        throw Errors.conflict("too many attempts; request a new code");
      }

      const ok = constantTimeEqual(hashCode(String(submitted ?? ""), c.salt), c.code_hash);
      if (!ok) {
        const updated = await challenges.update((x) => x.principal_id === principalId && x.channel === channel, (x) => ({ ...x, attempts: x.attempts + 1 }));
        throw Errors.validation("that code is not correct", { meta: { attempts_remaining: Math.max(0, MAX_ATTEMPTS - updated.attempts) } });
      }

      await challenges.remove((x) => x.principal_id === principalId && x.channel === channel);   // single use
      await verified.upsert((x) => x.principal_id === principalId && x.channel === channel, {
        principal_id: principalId,
        channel,
        destination: c.destination,
        verified_at: new Date().toISOString(),
        // A dev-mode verification is permanently marked as such. It must never
        // be mistaken for a delivery someone actually received.
        dev_mode: !!c.dev_mode,
      });

      return { channel, verified: true, dev_mode: !!c.dev_mode, destination: mask(channel, c.destination) };
    },

    /** What this principal has verified. Feeds computeLevel's trust signals. */
    async statusFor(principalId) {
      const rows = await verified.find((x) => x.principal_id === principalId);
      const out = { email_verified: false, phone_verified: false, dev_mode_verifications: [] };
      for (const r of rows) {
        out[`${r.channel}_verified`] = true;
        if (r.dev_mode) out.dev_mode_verifications.push(r.channel);
      }
      out.trustworthy = out.dev_mode_verifications.length === 0;
      if (!out.trustworthy) {
        out.note = `Verified in dev mode (${out.dev_mode_verifications.join(", ")}): no provider delivered anything, so this is not evidence of address ownership.`;
      }
      return out;
    },

    async revoke(principalId, channel) {
      const n = await verified.remove((x) => x.principal_id === principalId && x.channel === channel);
      if (!n) throw Errors.notFound(`a verified ${channel}`);
      return { channel, verified: false };
    },
  };

  return svc;
}

/** Never echo a full address back; enough to recognise, not enough to harvest. */
function mask(channel, value) {
  const v = String(value || "");
  if (channel === "email") {
    const [user, domain] = v.split("@");
    if (!domain) return "***";
    return `${user.slice(0, 2)}${"*".repeat(Math.max(1, user.length - 2))}@${domain}`;
  }
  return v.length > 4 ? "*".repeat(v.length - 4) + v.slice(-4) : "****";
}
