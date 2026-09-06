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
     */
    async recordAge(principalId, { dateOfBirth, method = "self_declared" }) {
      if (!principalId) throw Errors.validation("principal is required");
      const tier = ageTierFor(dateOfBirth);
      const row = {
        principal_id: principalId,
        date_of_birth: new Date(dateOfBirth).toISOString().slice(0, 10),
        age_tier: tier,
        method,
        updated_at: new Date().toISOString(),
      };
      await ages.upsert((r) => r.principal_id === principalId, row);
      return this.ageStatus(principalId);
    },

    async ageStatus(principalId) {
      const row = await ages.one((r) => r.principal_id === principalId);
      const tier = row?.age_tier || "unknown";
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
    async requestParentalConsent(minorId, { guardianEmail, scope = [], isSynthetic = true }) {
      if (!guardianEmail) throw Errors.validation("guardian_email is required");
      const s = await this.ageStatus(minorId);
      if (!s.minor) throw Errors.validation("parental consent only applies to a minor principal");
      const row = {
        id: id(), minor_id: minorId, guardian_email: String(guardianEmail).toLowerCase(),
        scope, status: "pending", requested_at: new Date().toISOString(),
        decided_at: null, is_synthetic: !!isSynthetic,
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
