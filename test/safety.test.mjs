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
  await assert.rejects(() => s.requestParentalConsent("adult1", { guardianEmail: "g@x.com", requestedBy: "adult1" }), (e) => e.httpStatus === 422);

  await s.recordAge("teen", { dateOfBirth: "2011-01-01", method: "synthetic_test" });
  const a = await s.requestParentalConsent("teen", { guardianEmail: "G@X.com", requestedBy: "teen" });
  const b = await s.requestParentalConsent("teen", { guardianEmail: "g@x.com", requestedBy: "teen" });
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

// =====================================================================
// A5 GATE: the age assurance is an assurance, not a retry loop.
//
// Reproduced 7 Sep 2026 against the running server, same principal, two
// requests, seconds apart:
//   POST /safety/age {"date_of_birth":"2020-01-01"} -> 403 under13,
//        capabilities {play:false, create:false, publish:false, chat:false,
//                      voice:false, marketplace:false}
//   POST /safety/age {"date_of_birth":"1990-01-01"} -> 200 adult,
//        capabilities all true
//   GET  /safety/age                                -> adult, persisted
// The control that exists to keep an under-13 off this platform was defeated
// by sending the request again with a different birthday.
// =====================================================================

test("A5 GATE: a recorded tier cannot be relaxed by re-declaring a different birthday", async () => {
  const s = svc();
  const kid = await s.recordAge("kid2", { dateOfBirth: "2020-01-01" });
  assert.equal(kid.age_tier, "under13");
  assert.equal(kid.capabilities.create, false);

  await assert.rejects(
    () => s.recordAge("kid2", { dateOfBirth: "1990-01-01" }),
    (e) => e.httpStatus === 403 && /cannot be relaxed by re-declaring/.test(e.detail),
    "an under-13 must not be able to become an adult by asking again",
  );

  // And nothing moved: the refusal must not have written the row first.
  const after = await s.ageStatus("kid2");
  assert.equal(after.age_tier, "under13", "the recorded tier must survive the attempt");
  assert.equal(after.capabilities.create, false);
  await assert.rejects(() => s.requireCapability("kid2", "create"), (e) => e.httpStatus === 403);
});

test("naming a stronger-sounding method does not buy a relaxation", async () => {
  // `method` reaches recordAge from the request body (server.mts:581), so a
  // method the caller chose can never be evidence. There is no age-verification
  // provider integrated either, so no method reaching this module is evidence
  // of anything at all.
  const s = svc();
  await s.recordAge("kid3", { dateOfBirth: "2020-01-01" });
  // Two refusals, for two reasons, and both are correct.
  //
  // An INVENTED method is now refused as invalid (422) before the tier logic is
  // reached — `method` reaches a check-constrained column, and one row the
  // database rejects fails the whole batched write, taking every other
  // principal's row with it. That is a stronger guarantee than the 403, not a
  // weaker one: the request never gets as far as being about age.
  //
  // A REAL method still reaches the tier logic and is refused there (403),
  // which is the assertion this test exists for.
  for (const method of ["verified", "government_id", "kyc", "staff_override"]) {
    await assert.rejects(
      () => s.recordAge("kid3", { dateOfBirth: "1990-01-01", method }),
      (e) => e.httpStatus === 422,
      `invented method '${method}' must be refused as invalid`,
    );
  }
  for (const method of ["self_declared", "parental_attested", "document_verified"]) {
    await assert.rejects(
      () => s.recordAge("kid3", { dateOfBirth: "1990-01-01", method }),
      (e) => e.httpStatus === 403,
      `method '${method}' must not unlock a relaxation`,
    );
  }
  assert.equal((await s.ageStatus("kid3")).age_tier, "under13");
});

/** A date of birth for somebody exactly `age` years and one day old today, so
 *  these cases do not rot as the calendar moves. */
function dobForAge(age) {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - age);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

test("a declaration that TIGHTENS the tier is always accepted", async () => {
  // The dangerous direction is refusing this one. Someone telling us they are
  // younger than we thought must be believed immediately.
  const s = svc();
  assert.equal((await s.recordAge("u_t", { dateOfBirth: dobForAge(30) })).age_tier, "adult");
  const tighter = await s.recordAge("u_t", { dateOfBirth: dobForAge(14) });
  assert.equal(tighter.age_tier, "13_15");
  assert.equal(tighter.capabilities.publish, false);
  // ...and having tightened, they cannot loosen back.
  await assert.rejects(() => s.recordAge("u_t", { dateOfBirth: dobForAge(30) }), (e) => e.httpStatus === 403);
});

test("re-declaring the SAME tier is idempotent, not a refusal", async () => {
  const s = svc();
  await s.recordAge("u_i", { dateOfBirth: "1990-01-01" });
  const again = await s.recordAge("u_i", { dateOfBirth: "1991-06-06" });   // still adult
  assert.equal(again.age_tier, "adult", "a correction within the same tier is not a relaxation");
});

test("a birthday moves the tier on its own, which is why refusing a relaxation is fair", async () => {
  // ageStatus used to return the tier STORED at declaration time. It went stale
  // the moment the principal had a birthday: someone who declared at 15 was
  // still reported 13_15 at 30, and refused publish and chat forever. That
  // staleness was the only legitimate reason to re-declare upward, so it is
  // fixed rather than used to justify the loophole.
  const s = svc();
  const dob = dobForAge(15);
  const birthday = (age) => {          // the moment they turn `age`, from that DOB
    const d = new Date(dob + "T00:00:00Z");
    d.setUTCFullYear(d.getUTCFullYear() + age);
    return d;
  };
  const at15 = await s.recordAge("u_b", { dateOfBirth: dob });
  assert.equal(at15.age_tier, "13_15");
  assert.equal(at15.capabilities.publish, false);

  const at16 = await s.ageStatus("u_b", { now: birthday(16) });
  assert.equal(at16.age_tier, "16_17", "a 16th birthday must move the tier with no re-declaration");
  assert.equal(at16.capabilities.publish, true);

  const at18 = await s.ageStatus("u_b", { now: birthday(18) });
  assert.equal(at18.age_tier, "adult");
  assert.equal(at18.minor, false);

  // The day BEFORE the birthday is still the old tier — an off-by-one here
  // would hand a 15-year-old publish rights a year early.
  const dayBefore = new Date(birthday(16).getTime() - 24 * 3600 * 1000);
  assert.equal((await s.ageStatus("u_b", { now: dayBefore })).age_tier, "13_15");
});

test("the derived tier survives a restart, and is derived from the stored DOB", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dcs-safety-age-"));
  const a = createSafetyService({ DCS_DATA_DIR: dir });
  const dob = dobForAge(15);
  await a.recordAge("u_p", { dateOfBirth: dob });
  const b = createSafetyService({ DCS_DATA_DIR: dir });
  assert.equal((await b.ageStatus("u_p")).age_tier, "13_15");
  const at18 = new Date(dob + "T00:00:00Z");
  at18.setUTCFullYear(at18.getUTCFullYear() + 18);
  assert.equal((await b.ageStatus("u_p", { now: at18 })).age_tier, "adult",
    "a fresh service object over the same disk must derive from the DOB, not a stale column");
  // And the relaxation guard holds across the restart too.
  await assert.rejects(() => b.recordAge("u_p", { dateOfBirth: dobForAge(30) }), (e) => e.httpStatus === 403);
});

// =====================================================================
// A5 GATE: a parental consent nobody can be held to is not a consent.
//
// Reproduced 7 Sep 2026: user-a, an ordinary authenticated tester, filed a
// guardian-consent record naming user-b as a minor and an arbitrary address
// as their guardian —
//   POST /safety/consent/parental {"minor_id":"user-b","guardian_email":"g@x.com"}
//   -> 201 {"consent":{"minor_id":"user-b","guardian_email":"g@x.com",
//                      "status":"pending","is_synthetic":true}}
// That writes a real person's email into a child-safety table against someone
// else's identity. It is the same hole grantMediaConsent closed on 6 Sep.
// =====================================================================

test("A5 GATE: nobody can file a parental consent on another principal's behalf", async () => {
  const s = svc();
  await s.recordAge("minor-x", { dateOfBirth: "2012-01-01" });

  await assert.rejects(
    () => s.requestParentalConsent("minor-x", { guardianEmail: "attacker@x.com", requestedBy: "user-a" }),
    (e) => e.httpStatus === 403 && /only be requested by the minor it concerns/.test(e.detail),
    "an unrelated principal must not be able to name someone else's guardian",
  );
  assert.deepEqual(await s.consentsFor("minor-x"), [], "and the refused request must not have written a row");

  // The minor's own request is accepted, and is attributed.
  const own = await s.requestParentalConsent("minor-x", { guardianEmail: "Guardian@X.com", requestedBy: "minor-x" });
  assert.equal(own.status, "pending");
  assert.equal(own.requested_by, "minor-x", "every consent row must name who filed it");
  assert.equal(own.guardian_email, "guardian@x.com");
});

test("a parental consent that cannot be attributed is refused, not written anonymously", async () => {
  // server.mts:634 does not pass the authenticated principal into this call, so
  // this is the state the HTTP route is in. Refusing is the safe direction: no
  // route reads a consent back and none decides one, so an unattributable write
  // could only ever add a forgeable row to a child-safety table.
  const s = svc();
  await s.recordAge("minor-y", { dateOfBirth: "2012-01-01" });
  await assert.rejects(
    () => s.requestParentalConsent("minor-y", { guardianEmail: "g@x.com" }),
    (e) => e.httpStatus === 403 && e.meta.missing === "requested_by",
  );
  assert.deepEqual(await s.consentsFor("minor-y"), []);
});

// =====================================================================
// A block nobody withdrew must not disappear because somebody else did.
//
// unblock() read the whole blocks table, filtered it in memory and wrote the
// whole table back, outside the collection lock and with awaits in between.
// Any block created by anyone during that window was erased — at the primary
// too — and both callers were told they succeeded.
//
// This is the worst place in the estate for a lost update. The person whose
// block vanished is never told, and the person they blocked can contact them
// again. test/collection.test.mjs "LANE C/4" pins the safe primitive; these are
// the call site.
// =====================================================================

test("A5 GATE: withdrawing one block does not erase blocks made at the same moment", async () => {
  const s = svc();
  await s.block("alice", "mallory");

  // One withdrawal racing four unrelated blocks by three other principals.
  // Before the fix the withdrawal wrote back a table it had read before any of
  // them existed, and every one of the four vanished.
  await Promise.all([
    s.unblock("alice", "mallory"),
    s.block("bob", "trudy"),
    s.block("carol", "trudy"),
    s.block("bob", "mallory"),
    s.block("dave", "eve"),
  ]);

  assert.deepEqual((await s.blockList("bob")).sort(), ["mallory", "trudy"], "bob's blocks must survive");
  assert.deepEqual(await s.blockList("carol"), ["trudy"], "carol's block must survive");
  assert.deepEqual(await s.blockList("dave"), ["eve"], "dave's block must survive");
  assert.deepEqual(await s.blockList("alice"), [], "and the one that was actually withdrawn is gone");

  // The relationships themselves, which is what the table is for.
  assert.equal(await s.isBlocked("bob", "trudy"), true);
  assert.equal(await s.isBlocked("carol", "trudy"), true);
  assert.equal(await s.isBlocked("dave", "eve"), true);
  assert.equal(await s.isBlocked("alice", "mallory"), false);
});

test("concurrent withdrawals do not erase each other either", async () => {
  const s = svc();
  for (const [a, b] of [["u1", "x"], ["u2", "x"], ["u3", "x"], ["u4", "x"], ["u5", "x"]]) await s.block(a, b);
  await Promise.all([s.unblock("u1", "x"), s.unblock("u2", "x"), s.unblock("u3", "x")]);
  assert.deepEqual(await s.blockList("u4"), ["x"], "an untouched block must survive three concurrent withdrawals");
  assert.deepEqual(await s.blockList("u5"), ["x"]);
  for (const u of ["u1", "u2", "u3"]) assert.deepEqual(await s.blockList(u), [], `${u}'s block was withdrawn`);
});

test("withdrawing reports whether anything was actually withdrawn", async () => {
  // 0 and 1 are different facts. Withdrawing a block that was never there is
  // not a failure, but a caller must be able to tell the difference.
  const s = svc();
  await s.block("alice", "mallory");
  assert.deepEqual(await s.unblock("alice", "mallory"), { blocked: false, removed: 1 });
  assert.deepEqual(await s.unblock("alice", "mallory"), { blocked: false, removed: 0 });
  assert.deepEqual(await s.unblock("nobody", "nobody-else"), { blocked: false, removed: 0 });
});

test("a withdrawal removes exactly one direction, not every block either party holds", async () => {
  const s = svc();
  await s.block("alice", "mallory");
  await s.block("mallory", "alice");
  await s.block("alice", "trudy");
  await s.unblock("alice", "mallory");
  assert.deepEqual(await s.blockList("alice"), ["trudy"], "alice's other block is untouched");
  assert.deepEqual(await s.blockList("mallory"), ["alice"], "mallory's own block is not withdrawn by alice");
  // isBlocked is symmetric for visibility, so mallory's surviving block still
  // hides them from each other. Withdrawing one side must not undo the other.
  assert.equal(await s.isBlocked("alice", "mallory"), true);
});
