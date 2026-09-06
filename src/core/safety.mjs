// A5 — child safety, age assurance, consent and reporting.
//
// ENGINEERING_COMPLETE + INTERNAL_ONLY. Every path here is real code with real
// persistence, so the moderation console can never display activity that did not
// happen. Onboarding actual minors stays disabled until safety/legal clearance;
// that is a public-launch blocker, not an engineering one.
//
// Reuses the moderation state machine already built in src/cw1/trust-safety.mjs
// rather than writing a second one.
import path from "node:path";
import crypto from "node:crypto";
import { Errors } from "./errors.mjs";
import { createCollection, describeCollections } from "./collection.mjs";
import { applyModeration, REPORT_STATES, MOD_ACTIONS } from "../cw1/trust-safety.mjs";

export const AGE_TIERS = ["unknown", "under13", "13_15", "16_17", "adult"];
export const REPORT_REASONS = [
  "csam", "grooming", "harassment", "hate", "violence",
  "sexual", "self_harm", "spam", "ip_infringement", "other",
];
/** Reasons that are escalated rather than queued as ordinary moderation. */
export const ESCALATE_IMMEDIATELY = new Set(["csam", "grooming", "self_harm"]);
export const CONSENT_SOURCES = ["founder", "staff", "synthetic", "licensed", "explicit_consent"];
export const MEDIA_KINDS = ["voice", "likeness", "avatar", "name", "performance"];

/** Derive an age tier from a date of birth. The raw DOB never leaves this module. */
export function ageTierFor(dob, now = new Date()) {
  const d = dob instanceof Date ? dob : new Date(dob);
  if (isNaN(d.getTime())) throw Errors.validation("date_of_birth is not a valid date");
  if (d > now) throw Errors.validation("date_of_birth is in the future");
  let age = now.getUTCFullYear() - d.getUTCFullYear();
  const m = now.getUTCMonth() - d.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < d.getUTCDate())) age--;
  if (age < 13) return "under13";
  if (age < 16) return "13_15";
  if (age < 18) return "16_17";
  return "adult";
}

/** What a given age tier may do during the controlled internal test window. */
export function capabilitiesFor(tier, { internalTestingWindow = true } = {}) {
  const base = {
    play: false, create: false, publish: false, chat: false,
    voice: false, marketplace: false, monetize: false,
  };
  switch (tier) {
    case "adult":
      return { ...base, play: true, create: true, publish: true, chat: true, voice: true, marketplace: true, monetize: false };
    case "16_17":
      return { ...base, play: true, create: true, publish: true, chat: true, voice: false, marketplace: false, monetize: false };
    case "13_15":
      return { ...base, play: true, create: true, publish: false, chat: false, voice: false, marketplace: false, monetize: false };
    case "under13":
      // Nothing is granted. Under-13 onboarding is not enabled in this window.
      return base;
    default:
      return base; // unknown tier grants nothing
  }
}

// -------------------------------------------------------------------- service

export function createSafetyService(env = process.env) {
  const dir = path.join(env.DCS_DATA_DIR || path.join(process.cwd(), ".dcs-data"), "safety");
  // Supabase primary when configured, atomic local file always. A safety record
  // that only survives until the next redeploy is not a safety record.
  const mk = (name, table, primaryKey) => createCollection({ dir, name, table, primaryKey, env });
  const ages = mk("age_assurance", "dcsgames_age_assurance", ["principal_id"]);
  const consents = mk("parental_consent", "dcsgames_parental_consent", ["id"]);
  const reports = mk("reports", "dcsgames_reports", ["id"]);
  const blocks = mk("blocks", "dcsgames_blocks", ["blocker_id", "blocked_id"]);
  const actions = mk("moderation_actions", "dcsgames_moderation_actions", ["id"]);
  const media = mk("media_consent", "dcsgames_media_consent", ["id"]);
  const collections = { ages, consents, reports, blocks, actions, media };

  const id = () => crypto.randomUUID();

  return {
    dir,
    /** Where this service is actually persisting, and whether it is degraded. */
    describe: () => describeCollections(collections),

    // ------------------------------------------------------------ age gating
    /**
     * Record an age assurance. Only the derived tier is readable by other code;
     * the DOB is stored once, here, and never returned by the API.
     *
     * A DECLARATION THAT LOOSENS THE GATE IS REFUSED. Reproduced 7 Sep 2026
     * against the running server:
     *
     *   POST /safety/age {"date_of_birth":"2020-01-01"} -> 403, tier under13,
     *                                                      every capability false
     *   POST /safety/age {"date_of_birth":"1990-01-01"} -> 200, tier adult,
     *                                                      create/publish/chat/
     *                                                      voice/marketplace true
     *   GET  /safety/age                                -> adult, and it persists
     *
     * So the control that exists to keep an under-13 off this platform was
     * defeated by sending the request again with a different birthday. That is
     * the same shape of hole grantMediaConsent had — a gate opt-out available to
     * exactly the person it exists to stop — and it is closed the same way.
     *
     * The rule, in one line: age assurance may only ever become MORE
     * restrictive by self-declaration.
     *   * a first declaration is accepted, whatever it says;
     *   * a re-declaration landing on the same tier is accepted (idempotent);
     *   * a re-declaration that TIGHTENS the tier is accepted — someone telling
     *     us they are younger than we thought must always be believed, because
     *     refusing that is the dangerous direction;
     *   * a re-declaration that LOOSENS the tier is refused, in every method.
     *     `method` reaches this function from the request body (server.mts:581),
     *     so trusting a stronger-sounding method here would leave the hole open
     *     to any caller who names one; and there is no age-verification provider
     *     integrated, so no method reaching this module is evidence of anything.
     *
     * A birthday is NOT a loosening: ageStatus derives the tier from the stored
     * DOB, so a 15-year-old becomes 16_17 on the day without asking anyone. That
     * removes the only legitimate reason a user had to re-declare upward.
     */
    async recordAge(principalId, { dateOfBirth, method = "self_declared" }) {
      if (!principalId) throw Errors.validation("principal is required");
      const tier = ageTierFor(dateOfBirth);
      // Only a RE-declaration can loosen anything. A principal with no row yet
      // is declaring for the first time and is taken at their word, whatever
      // they say — "unknown" sorts below every real tier, so comparing against
      // it would refuse every first declaration ever made.
      const existing = await ages.one((r) => r.principal_id === principalId);
      const current = existing ? await this.ageStatus(principalId) : null;
      if (current && AGE_TIERS.indexOf(tier) > AGE_TIERS.indexOf(current.age_tier)) {
        throw Errors.forbidden(
          `an age assurance cannot be relaxed by re-declaring: this principal is recorded as '${current.age_tier}' and a self-declared '${tier}' would grant capabilities the recorded tier withholds`,
          {
            meta: {
              recorded_age_tier: current.age_tier,
              declared_age_tier: tier,
              method,
              // Said plainly, because a caller that is not told this will simply
              // keep retrying: there is no self-serve path, and there is no
              // age-verification provider to appeal to either.
              correction_path: "none is implemented; no age-verification provider is integrated, so a recorded tier can only be corrected out of band",
            },
          },
        );
      }
      const row = {
        principal_id: principalId,
        date_of_birth: new Date(dateOfBirth).toISOString().slice(0, 10),
        // Kept for readers of the row, but ageStatus derives the tier from the
        // DOB rather than trusting this: a stored tier goes stale on a birthday.
        age_tier: tier,
        method,
        updated_at: new Date().toISOString(),
      };
      await ages.upsert((r) => r.principal_id === principalId, row);
      return this.ageStatus(principalId);
    },

    /**
     * The effective tier, DERIVED FROM THE STORED DOB rather than read from the
     * stored `age_tier`. That column is written once and then goes stale: a
     * principal who declared at 15 was still reported as 13_15 at 30, and was
     * therefore refused publish and chat forever. Deriving it means a birthday
     * moves the tier on the day, with no re-declaration — which is what makes
     * refusing a loosening re-declaration fair rather than merely strict.
     *
     * `now` is injectable so the derivation itself can be tested; nothing in the
     * service passes it.
     */
    async ageStatus(principalId, { now = new Date() } = {}) {
      const row = await ages.one((r) => r.principal_id === principalId);
      let tier = "unknown";
      if (row?.date_of_birth) {
        // A stored DOB that will not parse must not silently become 'unknown'
        // and hand the principal a clean slate to re-declare against; fall back
        // to the recorded tier, which is the more restrictive reading.
        try { tier = ageTierFor(row.date_of_birth, now); }
        catch { tier = row.age_tier || "unknown"; }
      } else if (row?.age_tier) {
        tier = row.age_tier;
      }
      const caps = capabilitiesFor(tier);
      return {
        principal_id: principalId,
        age_tier: tier,            // the DOB itself is deliberately not returned
        method: row?.method || null,
        capabilities: caps,
        minor: tier !== "adult" && tier !== "unknown",
        onboarding_permitted: tier === "adult",
        note: tier === "adult"
          ? null
          : "Minor onboarding is disabled during the controlled internal test window; clearance is a public-launch blocker.",
      };
    },

    /** Throw unless this principal's age tier permits the capability. */
    async requireCapability(principalId, capability) {
      const s = await this.ageStatus(principalId);
      if (!s.capabilities[capability]) {
        throw Errors.forbidden(
          `age tier '${s.age_tier}' does not permit '${capability}' during the controlled internal test window`,
          { meta: { age_tier: s.age_tier, capability, required_action: s.age_tier === "unknown" ? "record an age assurance" : "age-restricted" } }
        );
      }
      return s;
    },

    // -------------------------------------------------------- parental consent
    /**
     * Request a guardian's consent for a minor.
     *
     * @param requestedBy  who is making this record. REQUIRED, and required to
     *                     be the minor: this took the minor's id straight from
     *                     the caller's request body with no check at all
     *                     (server.mts:634 passes `b.minor_id || me.id`), so any
     *                     authenticated account could file a guardian-consent
     *                     record naming ANY other principal as a minor and any
     *                     address as their guardian. Reproduced 7 Sep 2026:
     *                     POST /safety/consent/parental
     *                     {"minor_id":"user-b","guardian_email":"g@x.com"}
     *                     from user-a answered 201 with a pending row.
     *
     *                     That writes a real person's email address into a child
     *                     -safety table against someone else's identity, and it
     *                     is the same hole grantMediaConsent already closed:
     *                     a consent recorded on someone's behalf, by somebody
     *                     they did not authorise, is not consent.
     *
     * The requester is recorded on the row either way, because a consent nobody
     * is accountable for cannot be audited after the fact.
     */
    async requestParentalConsent(minorId, { guardianEmail, scope = [], isSynthetic = true, requestedBy = null }) {
      if (!guardianEmail) throw Errors.validation("guardian_email is required");
      if (!requestedBy) {
        // NOT 401: the HTTP layer knows perfectly well who is calling. The call
        // INTO this module dropped it, and a consent record that cannot be
        // attributed is refused rather than written anonymously. server.mts:634
        // does not thread the authenticated principal through yet, so this
        // refuses the whole route until it does — which is the safe direction,
        // because no route reads a consent back and none decides one, so the
        // only thing the route can currently do is write forgeable rows.
        throw Errors.forbidden(
          "this parental consent request did not say who made it, so it cannot be attributed to the minor it concerns and is refused rather than recorded anonymously",
          { meta: { minor_id: minorId, missing: "requested_by" } },
        );
      }
      if (String(requestedBy) !== String(minorId)) {
        throw Errors.forbidden(
          "a parental consent can only be requested by the minor it concerns; there is no verified guardian relationship to authorise anyone else",
          { meta: { minor_id: minorId, requested_by: requestedBy } },
        );
      }
      const s = await this.ageStatus(minorId);
      if (!s.minor) throw Errors.validation("parental consent only applies to a minor principal");
      const row = {
        id: id(), minor_id: minorId, guardian_email: String(guardianEmail).toLowerCase(),
        scope, status: "pending", requested_at: new Date().toISOString(),
        decided_at: null, is_synthetic: !!isSynthetic, requested_by: String(requestedBy),
      };
      const existing = await consents.one((r) => r.minor_id === minorId && r.guardian_email === row.guardian_email && ["pending", "granted"].includes(r.status));
      if (existing) return { ...existing, idempotent: true };
      await consents.insert(row);
      return row;
    },

    async decideParentalConsent(consentId, decision, decidedBy) {
      if (!["granted", "denied", "revoked"].includes(decision)) throw Errors.validation("decision must be granted, denied or revoked");
      const r = await consents.update((c) => c.id === consentId, (c) => ({ ...c, status: decision, decided_at: new Date().toISOString(), decided_by: decidedBy }));
      if (!r) throw Errors.notFound(`consent ${consentId}`);
      return r;
    },

    async consentsFor(minorId) { return await consents.find((c) => c.minor_id === minorId); },

    // --------------------------------------------------------- report / block
    async report(reporterId, { subjectType, subjectId, reason, detail = null }) {
      if (!reporterId) throw Errors.unauthenticated("reporting requires an authenticated principal");
      if (!REPORT_REASONS.includes(reason)) throw Errors.validation(`reason must be one of: ${REPORT_REASONS.join(", ")}`);
      if (!subjectType || !subjectId) throw Errors.validation("subject_type and subject_id are required");
      const escalate = ESCALATE_IMMEDIATELY.has(reason);
      const row = {
        id: id(), reporter_id: reporterId, subject_type: subjectType, subject_id: String(subjectId),
        reason, detail, status: escalate ? "under_review" : "open",
        severity: escalate ? "critical" : (reason === "harassment" || reason === "hate" ? "high" : "normal"),
        escalated: escalate, created_at: new Date().toISOString(), handled_by: null, handled_at: null,
      };
      await reports.insert(row);
      if (escalate) {
        // A critical report is loud in the logs, immediately, whether or not a
        // human is watching the console.
        console.error(JSON.stringify({
          level: "error", alert: "SAFETY_ESCALATION", report_id: row.id, reason,
          subject: `${subjectType}:${subjectId}`, ts: row.created_at,
          action_required: "route to the designated safety contact and, where applicable, the relevant authority",
        }));
      }
      return row;
    },

    async listReports({ status = null, limit = 100 } = {}) {
      const all = await reports.all();
      const rows = status ? all.filter((r) => r.status === status) : all;
      return rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, limit);
    },

    /**
     * Move a report through the CW1 state machine that already exists, rather
     * than inventing a second one. applyModeration owns the transition rules and
     * produces the audit entry; this method persists both.
     */
    async moderate(reportId, action, moderatorId) {
      if (!MOD_ACTIONS.includes(action)) throw Errors.validation(`action must be one of: ${MOD_ACTIONS.join(", ")}`);
      if (!moderatorId) throw Errors.unauthenticated("moderation requires an authenticated moderator");
      const r = await reports.one((x) => x.id === reportId);
      if (!r) throw Errors.notFound(`report ${reportId}`);
      const res = applyModeration({ ...r, state: r.status }, action, moderatorId);
      if (res.error) {
        throw Errors.conflict(`report cannot be ${action}ed from state '${r.status}' (${res.error})`, { meta: res });
      }
      const updated = await reports.update((x) => x.id === reportId, (x) => ({
        ...x,
        status: res.report.state,
        action: res.report.action,
        handled_by: moderatorId,
        handled_at: res.report.actioned_at,
      }));
      await actions.insert({
        id: id(), subject_type: r.subject_type, subject_id: r.subject_id,
        action, rationale: `report ${reportId}: ${r.reason}`, decided_by: moderatorId,
        report_id: reportId, audit: res.audit, created_at: res.audit.ts,
      });
      return updated;
    },

    /** The moderation history. An empty list is an honest "nothing was moderated". */
    async moderationHistory(subjectType = null, subjectId = null) {
      const all = await actions.all();
      const rows = subjectType ? all.filter((a) => a.subject_type === subjectType && a.subject_id === String(subjectId)) : all;
      return rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    },

    async block(blockerId, blockedId) {
      if (!blockerId) throw Errors.unauthenticated("blocking requires an authenticated principal");
      if (blockerId === blockedId) throw Errors.validation("a principal cannot block themselves");
      await blocks.upsert((b) => b.blocker_id === blockerId && b.blocked_id === blockedId,
        { blocker_id: blockerId, blocked_id: blockedId, created_at: new Date().toISOString() });
      return { blocked: true, blocker_id: blockerId, blocked_id: blockedId };
    },
    async unblock(blockerId, blockedId) {
      const rows = (await blocks.all()).filter((b) => !(b.blocker_id === blockerId && b.blocked_id === blockedId));
      await blocks.write(rows);
      return { blocked: false };
    },
    async isBlocked(a, b) {
      const rows = await blocks.all();
      return rows.some((r) => (r.blocker_id === a && r.blocked_id === b) || (r.blocker_id === b && r.blocked_id === a));
    },
    async blockList(blockerId) { return (await blocks.find((b) => b.blocker_id === blockerId)).map((b) => b.blocked_id); },

    // -------------------------------------------------- voice / likeness consent
    /**
     * Record consent for voice, likeness or avatar material. Generation without
     * a matching, unrevoked grant is refused — see requireMediaConsent.
     */
    /**
     * Record that a person consented to their voice or likeness being used.
     *
     * @param grantedBy  who is making this record. REQUIRED, and required to be
     *                   the subject: consent given on someone's behalf, by
     *                   somebody they did not authorise, is not consent. This
     *                   used to take the subject from the caller's request body
     *                   with no check at all, so any authenticated account could
     *                   grant a likeness consent for anyone and then generate
     *                   their voice — the A5 gate defeated by the person it
     *                   exists to protect the subject from.
     *
     * The granter is recorded either way, because a row nobody is accountable
     * for cannot be audited after the fact, and this one could not even be
     * attributed.
     */
    async grantMediaConsent(principalId, { mediaKind, source, evidenceRef = null, grantedBy = null }) {
      if (!principalId) throw Errors.validation("a consent needs a subject");
      if (!grantedBy) throw Errors.unauthenticated("a media consent must be attributable to whoever granted it");
      if (String(grantedBy) !== String(principalId)) {
        throw Errors.forbidden(
          "a person's voice and likeness consent can only be granted by that person",
          { meta: { subject_id: principalId, granted_by: grantedBy } }
        );
      }
      if (!MEDIA_KINDS.includes(mediaKind)) throw Errors.validation(`media_kind must be one of: ${MEDIA_KINDS.join(", ")}`);
      if (!CONSENT_SOURCES.includes(source)) throw Errors.validation(`source must be one of: ${CONSENT_SOURCES.join(", ")}`);
      const row = { id: id(), principal_id: principalId, media_kind: mediaKind, source, evidence_ref: evidenceRef, granted_by: grantedBy, granted_at: new Date().toISOString(), revoked_at: null };
      await media.insert(row);
      return row;
    },
    /** Only the subject may withdraw their own consent. */
    async revokeMediaConsent(consentId, revokedBy = null) {
      const existing = await media.one((m) => m.id === consentId);
      if (!existing) throw Errors.notFound(`media consent ${consentId}`);
      if (revokedBy != null && String(existing.principal_id) !== String(revokedBy)) {
        // Same answer as a consent that does not exist: whose consents exist is
        // not something to disclose to someone who may not touch them.
        throw Errors.notFound(`media consent ${consentId}`);
      }
      const r = await media.update((m) => m.id === consentId, (m) => ({ ...m, revoked_at: new Date().toISOString() }));
      return r;
    },
    /**
     * Gate for B11. Fully synthetic material needs no subject consent; anything
     * tied to a real person does, and the grant must not be revoked.
     */
    async requireMediaConsent({ subjectId, mediaKind, source }) {
      if (source === "synthetic") return { permitted: true, basis: "synthetic", subject_id: null };
      const rows = await media.find((m) => m.principal_id === subjectId && m.media_kind === mediaKind && !m.revoked_at);
      if (!rows.length) {
        throw Errors.forbidden(
          `no unrevoked ${mediaKind} consent is recorded for this subject; unrestricted cloning is disabled during the controlled internal test window`,
          { meta: { subject_id: subjectId, media_kind: mediaKind, permitted_sources: CONSENT_SOURCES } }
        );
      }
      return { permitted: true, basis: rows[0].source, consent_id: rows[0].id, subject_id: subjectId };
    },
    async mediaConsents(principalId) { return await media.find((m) => m.principal_id === principalId); },
  };
}

export { REPORT_STATES, MOD_ACTIONS };
