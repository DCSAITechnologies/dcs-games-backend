// A5 exit gate. The safety architecture must be real code with real persistence,
// gated correctly, and honest about what it does NOT do.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSafetyService, ageTierFor, capabilitiesFor, REPORT_REASONS } from "../src/core/safety.mjs";

const svc = () => createSafetyService({ DCS_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "dcs-safety-")) });
const NOW = new Date("2026-09-06T00:00:00Z");

// ------------------------------------------------------------------ age tiers

test("age tiers are derived correctly, including the birthday boundary", () => {
  assert.equal(ageTierFor("2008-09-06", NOW), "adult");       // exactly 18 today
  assert.equal(ageTierFor("2008-09-07", NOW), "16_17");       // 18 tomorrow
  assert.equal(ageTierFor("2010-09-06", NOW), "16_17");
  assert.equal(ageTierFor("2011-09-06", NOW), "13_15");
  assert.equal(ageTierFor("2013-09-06", NOW), "13_15");       // exactly 13
  assert.equal(ageTierFor("2013-09-07", NOW), "under13");     // 13 tomorrow
  assert.equal(ageTierFor("2020-01-01", NOW), "under13");
});

test("an invalid or future date of birth is rejected", () => {
  assert.throws(() => ageTierFor("not-a-date"), (e) => e.httpStatus === 422);
  assert.throws(() => ageTierFor("2099-01-01"), (e) => e.httpStatus === 422);
});

test("A5 GATE: under-13 is granted nothing, and unknown age is granted nothing", () => {
  for (const tier of ["under13", "unknown"]) {
    const c = capabilitiesFor(tier);
    assert.deepEqual(Object.values(c).filter(Boolean), [], `${tier} must grant no capability`);
  }
});

test("no age tier can monetize while payments are dark", () => {
  for (const tier of ["unknown", "under13", "13_15", "16_17", "adult"]) {
    assert.equal(capabilitiesFor(tier).monetize, false);
  }
});

test("minors are progressively restricted, not uniformly blocked", () => {
  assert.equal(capabilitiesFor("13_15").play, true);
  assert.equal(capabilitiesFor("13_15").publish, false, "under-16 may not publish to others");
  assert.equal(capabilitiesFor("13_15").chat, false);
  assert.equal(capabilitiesFor("16_17").publish, true);
  assert.equal(capabilitiesFor("16_17").voice, false, "voice generation stays adult-only");
  assert.equal(capabilitiesFor("adult").voice, true);
});

test("recording an age never returns the date of birth back to a caller", async () => {
  const s = svc();
  const st = await s.recordAge("u1", { dateOfBirth: "1990-04-04" });
  assert.equal(st.age_tier, "adult");
  assert.ok(!("date_of_birth" in st), "the raw DOB must not leave the safety module");
});

test("A5 GATE: an under-13 principal is recorded honestly and refused onboarding", async () => {
  const s = svc();
  const st = await s.recordAge("kid", { dateOfBirth: "2020-01-01", method: "synthetic_test" });
  assert.equal(st.age_tier, "under13");
  assert.equal(st.onboarding_permitted, false);
  assert.match(st.note, /public-launch blocker/);
  await assert.rejects(() => s.requireCapability("kid", "play"), (e) => e.httpStatus === 403);
});

test("a principal with no recorded age cannot create", async () => {
  const s = svc();
  await assert.rejects(() => s.requireCapability("nobody", "create"), (e) => e.meta.required_action === "record an age assurance");
});

// ------------------------------------------------------------ report / block

test("a report is persisted and readable, so a moderation queue cannot be fabricated", async () => {
  const s = svc();
  const r = await s.report("reporter", { subjectType: "world", subjectId: "w1", reason: "harassment" });
  assert.equal(r.severity, "high");
  const rows = await s.listReports({});
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, r.id);
});

test("A5 GATE: a child-safety report is escalated immediately, not queued", async () => {
  const s = svc();
  for (const reason of ["csam", "grooming", "self_harm"]) {
    const r = await s.report("reporter", { subjectType: "user", subjectId: "u9", reason });
    assert.equal(r.escalated, true, `${reason} must escalate`);
    assert.equal(r.severity, "critical");
    assert.equal(r.status, "under_review");
  }
});

test("an unknown report reason is rejected rather than stored as 'other'", async () => {
  const s = svc();
  await assert.rejects(() => s.report("r", { subjectType: "world", subjectId: "w", reason: "made_up" }), (e) => e.httpStatus === 422);
  assert.ok(REPORT_REASONS.includes("ip_infringement"));
});

test("reporting requires an authenticated principal", async () => {
  const s = svc();
  await assert.rejects(() => s.report(null, { subjectType: "world", subjectId: "w", reason: "spam" }), (e) => e.httpStatus === 401);
});

test("moderation uses the existing CW1 state machine and writes an audit entry", async () => {
  const s = svc();
  const r = await s.report("reporter", { subjectType: "world", subjectId: "w1", reason: "spam" });
  assert.deepEqual(await s.moderationHistory(), [], "nothing has been moderated yet");
  const done = await s.moderate(r.id, "warn", "mod-1");
  assert.equal(done.status, "actioned");
  assert.equal(done.action, "warn");
  const hist = await s.moderationHistory("world", "w1");
  assert.equal(hist.length, 1);
  assert.equal(hist[0].decided_by, "mod-1");
  assert.ok(hist[0].audit, "the CW1 audit entry is retained");
});

test("an invalid moderation transition is refused", async () => {
  const s = svc();
  const r = await s.report("reporter", { subjectType: "world", subjectId: "w1", reason: "spam" });
  await s.moderate(r.id, "dismiss", "mod-1");                 // dismissed is terminal
  await assert.rejects(() => s.moderate(r.id, "ban", "mod-1"), (e) => e.httpStatus === 409);
});

test("moderation requires a moderator identity", async () => {
  const s = svc();
  const r = await s.report("reporter", { subjectType: "world", subjectId: "w1", reason: "spam" });
  await assert.rejects(() => s.moderate(r.id, "warn", null), (e) => e.httpStatus === 401);
});

test("blocking is symmetric for visibility and is persisted", async () => {
  const s = svc();
  await s.block("alice", "mallory");
  assert.equal(await s.isBlocked("alice", "mallory"), true);
  assert.equal(await s.isBlocked("mallory", "alice"), true, "a block hides both directions");
  assert.deepEqual(await s.blockList("alice"), ["mallory"]);
  await s.unblock("alice", "mallory");
  assert.equal(await s.isBlocked("alice", "mallory"), false);
});

test("a principal cannot block themselves", async () => {
  const s = svc();
  await assert.rejects(() => s.block("alice", "alice"), (e) => e.httpStatus === 422);
});

// --------------------------------------------------------- parental consent

test("parental consent applies only to a minor, and is idempotent", async () => {
  const s = svc();
  await s.recordAge("adult1", { dateOfBirth: "1990-01-01" });
  await assert.rejects(() => s.requestParentalConsent("adult1", { guardianEmail: "g@x.com" }), (e) => e.httpStatus === 422);

  await s.recordAge("teen", { dateOfBirth: "2011-01-01", method: "synthetic_test" });
  const a = await s.requestParentalConsent("teen", { guardianEmail: "G@X.com" });
  const b = await s.requestParentalConsent("teen", { guardianEmail: "g@x.com" });
  assert.equal(b.idempotent, true, "a duplicate request must not create a second pending consent");
  assert.equal(a.status, "pending");
  assert.equal(a.is_synthetic, true, "internal-testing consents are marked synthetic");

  const decided = await s.decideParentalConsent(a.id, "granted", "staff-1");
  assert.equal(decided.status, "granted");
  assert.ok(decided.decided_at);
});

// ------------------------------------------------------ voice / likeness consent

test("A5 GATE: voice cloning without recorded consent is refused", async () => {
  const s = svc();
  await assert.rejects(
    () => s.requireMediaConsent({ subjectId: "some-person", mediaKind: "voice", source: "explicit_consent" }),
    (e) => e.httpStatus === 403 && /unrestricted cloning is disabled/.test(e.detail)
  );
});

test("synthetic media needs no subject consent", async () => {
  const s = svc();
  const r = await s.requireMediaConsent({ subjectId: null, mediaKind: "voice", source: "synthetic" });
  assert.equal(r.permitted, true);
  assert.equal(r.basis, "synthetic");
});

test("a recorded consent permits generation, and revoking it stops generation", async () => {
  const s = svc();
  const g = await s.grantMediaConsent("founder-id", { mediaKind: "voice", source: "founder", evidenceRef: "signed-2026-09-06", grantedBy: "founder-id" });
  const ok = await s.requireMediaConsent({ subjectId: "founder-id", mediaKind: "voice", source: "founder" });
  assert.equal(ok.permitted, true);
  assert.equal(ok.basis, "founder");
  await s.revokeMediaConsent(g.id, "founder-id");
  await assert.rejects(() => s.requireMediaConsent({ subjectId: "founder-id", mediaKind: "voice", source: "founder" }), (e) => e.httpStatus === 403);
});

test("an unrecognised consent source or media kind is rejected", async () => {
  const s = svc();
  await assert.rejects(() => s.grantMediaConsent("u", { mediaKind: "voice", source: "scraped_from_youtube", grantedBy: "u" }), (e) => e.httpStatus === 422);
  await assert.rejects(() => s.grantMediaConsent("u", { mediaKind: "fingerprint", source: "staff", grantedBy: "u" }), (e) => e.httpStatus === 422);
});

test("safety records survive a restart", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dcs-safety-p-"));
  const a = createSafetyService({ DCS_DATA_DIR: dir });
  await a.recordAge("u1", { dateOfBirth: "1990-01-01" });
  const r = await a.report("u1", { subjectType: "world", subjectId: "w", reason: "spam" });
  const b = createSafetyService({ DCS_DATA_DIR: dir });   // new service object, same disk
  assert.equal((await b.ageStatus("u1")).age_tier, "adult");
  assert.equal((await b.listReports({}))[0].id, r.id);
});

test("A5 GATE: nobody can record a voice or likeness consent on someone else's behalf", async () => {
  // The A5 gate was opt-in by the caller it protects the subject FROM. Any
  // authenticated account could POST a consent naming any principal as the
  // subject, and the media route then honoured it: request a person's voice ->
  // 403; forge their consent -> 201; request again -> 200. The row was not even
  // attributable, because nothing recorded who granted it.
  const s = svc();
  await assert.rejects(
    () => s.grantMediaConsent("victim", { mediaKind: "voice", source: "explicit_consent", grantedBy: "attacker" }),
    (e) => e.httpStatus === 403,
    "a consent granted by someone other than its subject is not consent",
  );
  await assert.rejects(
    () => s.grantMediaConsent("victim", { mediaKind: "voice", source: "explicit_consent" }),
    (e) => e.httpStatus === 401,
    "and an unattributable consent must not be recordable at all",
  );

  // The victim's own grant works, and carries who made it.
  const ok = await s.grantMediaConsent("victim", { mediaKind: "voice", source: "explicit_consent", grantedBy: "victim" });
  assert.equal(ok.granted_by, "victim", "every consent must say who granted it, or it cannot be audited");

  // And a stranger cannot revoke it either — nor learn that it exists.
  await assert.rejects(() => s.revokeMediaConsent(ok.id, "attacker"), (e) => e.httpStatus === 404);
});
