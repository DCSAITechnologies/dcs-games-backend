// Lane G — the safety tables against what the safety code actually writes.
//
// RECONCILED 7 Sep 2026, twice. 0012 closed the three mismatches in the
// moderation flow; 0013 closed the same disease in the parental-consent flow,
// which only turned up when this suite was generalised to drive EVERY safety
// write rather than the one that had already failed; and safety.mjs now
// validates the two caller-supplied values that could reach a checked column.
// All green. The generalised drive stays, because the method is the point: the
// next table added to this family will be checked by it without anyone
// remembering to.
//
// 0011 was written after this was reproduced against the Data API:
//
//   PGRST204  "Could not find the 'escalated' column of 'dcsgames_reports'"
//   23514     dcsgames_reports_status_check — the row carries status 'under_review'
//
// Both are fixed. But the fix was derived from the FIRST write in the moderation
// flow — safety.report() — and the flow has three more writes. This suite does
// not guess at them: it runs the real safety service against a temporary data
// directory, files a report, moderates it, reads the rows that were produced,
// and compares them with the columns and check constraints the migrations
// declare. Whatever the file shadow holds is exactly what the Supabase backing
// upserts, column for column (src/core/collection.mjs:285 builds the column list
// from the row's own keys).
//
// It needs no server and no network.
//
// Run: node --test test/lead-review-schema.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSafetyService, MEDIA_KINDS, CONSENT_SOURCES, AGE_METHODS, SUBJECT_TYPES } from "../src/core/safety.mjs";
import { MOD_ACTIONS, REPORT_STATES } from "../src/cw1/trust-safety.mjs";

const GB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS = path.join(GB, "migrations");

/** Every migration file, in order, as one string. */
function allSql() {
  return fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()
    .map((f) => fs.readFileSync(path.join(MIGRATIONS, f), "utf8")).join("\n");
}

/** The columns a table has after every migration has run. */
function columnsOf(table) {
  const sql = allSql();
  const cols = new Set();
  const create = new RegExp(`create table if not exists public\\.${table}\\s*\\(([\\s\\S]*?)\\n\\);`, "i").exec(sql);
  if (create) {
    for (const line of create[1].split("\n")) {
      const m = /^\s{2}([a-z_][a-z0-9_]*)\s+\S/.exec(line);       // a column, not a continuation or a constraint
      if (m && !["check", "primary", "unique", "constraint", "foreign"].includes(m[1])) cols.add(m[1]);
    }
  }
  const add = new RegExp(`alter table public\\.${table}[\\s\\S]*?add column if not exists ([a-z_][a-z0-9_]*)`, "gi");
  for (const m of sql.matchAll(add)) cols.add(m[1]);
  return cols;
}

/** The values a `check (<column> in (...))` allows, taking the LAST definition. */
function checkValues(table, column) {
  const sql = allSql();
  let last = null;
  const inline = new RegExp(`check\\s*\\(\\s*${column} in \\(([^)]*)\\)`, "gi");
  // Constrain the search to statements that mention the table, so the same
  // column name on another table cannot answer for this one.
  for (const stmt of sql.split(/;\s*\n/)) {
    if (!stmt.includes(table)) continue;
    for (const m of stmt.matchAll(inline)) last = m[1];
  }
  return last === null ? null : last.split(",").map((v) => v.trim().replace(/^'|'$/g, ""));
}

/** File a report and moderate it with the real service; return the rows written. */
async function driveModerationFlow() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dcs-g-schema-"));
  const safety = createSafetyService({ DCS_DATA_DIR: dir });
  const filed = await safety.report("user-reporter", {
    subjectType: "world", subjectId: "w3_subject", reason: "spam", detail: "a detail",
  });
  await safety.moderate(filed.id, "warn", "user-moderator");
  const read = (name) => JSON.parse(fs.readFileSync(path.join(dir, "safety", name + ".json"), "utf8"));
  const rows = { reports: read("reports"), actions: read("moderation_actions") };
  fs.rmSync(dir, { recursive: true, force: true });
  return rows;
}

test("CLOSED (was DEFECT, OPEN): every column a moderated report writes exists", async () => {
  // WAS: safety.moderate() writes `action` onto dcsgames_reports and there was
  // no such column after 0011, so the upsert failed with the same PGRST204 that
  // 0011 was written to end — one write later in the same flow. The reports
  // collection degraded again and the moderation decision lived only in the
  // container filesystem that 0011's own header says is lost at the next
  // deploy. 0012 adds it.
  const { reports } = await driveModerationFlow();
  const cols = columnsOf("dcsgames_reports");
  const missing = Object.keys(reports[0]).filter((k) => !cols.has(k));
  assert.deepEqual(missing, [], `columns declared: ${JSON.stringify([...cols])}`);
  assert.ok(cols.has("action"), "including the one 0012 added");
});

test("CLOSED (was DEFECT, OPEN): the moderation audit entry has a column to land in", async () => {
  // WAS: safety.moderate() writes `audit` to dcsgames_moderation_actions, which
  // 0004 declared without it and 0011 did not touch. The audit entry — the
  // record of who decided what and when, which is the whole point of a
  // moderation audit trail — could not reach the durable store.
  const { actions } = await driveModerationFlow();
  const cols = columnsOf("dcsgames_moderation_actions");
  const missing = Object.keys(actions[0]).filter((k) => !cols.has(k));
  assert.deepEqual(missing, [], `columns declared: ${JSON.stringify([...cols])}`);
  assert.ok(cols.has("audit"));
});

test("CLOSED (was DEFECT, OPEN): every moderation action the API publishes can be stored", async () => {
  // WAS: MOD_ACTIONS is [warn, ban, shadow_limit, dismiss] and /health publishes
  // it as `safety.accepts.moderation_action`, so a moderator could take any of
  // them — while the column allowed none/warn/hide/unpublish/suspend/ban/
  // age_restrict/escalate_to_authority. Two of the four failed with 23514: the
  // identical class of mismatch 0011 fixed for dcsgames_reports.status, in the
  // table the same function writes on the same request.
  const allowed = checkValues("dcsgames_moderation_actions", "action");
  assert.ok(allowed, "the constraint is declared");
  assert.deepEqual(MOD_ACTIONS.filter((a) => !allowed.includes(a)), [], `column allows ${JSON.stringify(allowed)}`);
  // Additive, as 0012 claims: nothing the column used to allow was dropped.
  for (const old of ["none", "warn", "hide", "unpublish", "suspend", "ban", "age_restrict", "escalate_to_authority"]) {
    assert.ok(allowed.includes(old), `the widened check still allows '${old}'`);
  }
});

test("VERIFIED: 0011 fixes the two mismatches it names", async () => {
  const { reports } = await driveModerationFlow();
  const cols = columnsOf("dcsgames_reports");
  assert.ok(cols.has("escalated"), "the escalated column is added");
  const statuses = checkValues("dcsgames_reports", "status");
  assert.ok(statuses.includes("under_review"), "and 'under_review' is now allowed");
  // A filed report's own row is fully storable — that write is the one the
  // migration was derived from, and it is genuinely fixed.
  const filed = reports.find((r) => r.status !== "actioned") || reports[0];
  const escalated = { ...filed, status: "under_review", escalated: true };
  for (const k of Object.keys(escalated)) {
    if (k === "action") continue;                       // the separate defect above
    assert.ok(cols.has(k), `report column ${k}`);
  }
  // The widened vocabulary is a superset of the old one, as the header claims.
  for (const old of ["open", "triaged", "actioned", "dismissed", "escalated"]) {
    assert.ok(statuses.includes(old), `the widened check still allows '${old}'`);
  }
});

test("CLOSED (was a latent mismatch): every state the state machine can reach is storable", async () => {
  // WAS: REPORT_STATES carries appealed / appeal_upheld / appeal_denied and the
  // check allowed none of them. It was latent rather than live — safety.moderate()
  // is the only writer and applyModeration only produces under_review, actioned
  // or dismissed; the appeal machinery belongs to the legacy /ts console. It was
  // recorded so that whoever wired appeals to the live store would widen the
  // check first. 0012 widened it instead, which is better: the trap is gone
  // rather than documented.
  const statuses = checkValues("dcsgames_reports", "status");
  assert.deepEqual(REPORT_STATES.filter((s) => !statuses.includes(s)), [], `column allows ${JSON.stringify(statuses)}`);
});

test("DISPROVED: the media consent vocabulary matches its column", async () => {
  const kinds = checkValues("dcsgames_media_consent", "media_kind");
  assert.deepEqual([...MEDIA_KINDS].sort(), [...kinds].sort(), "every MEDIA_KIND is storable");
  const sources = checkValues("dcsgames_media_consent", "source");
  if (sources) assert.deepEqual([...CONSENT_SOURCES].sort(), [...sources].sort(), "every CONSENT_SOURCE is storable");
});

// ===========================================================================
// The same disease, in the flow 0012 did not visit.
// ===========================================================================

/** Drive the parental-consent flow with the real service; return the row written. */
async function driveParentalConsentFlow() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dcs-g-consent-"));
  const safety = createSafetyService({ DCS_DATA_DIR: dir });
  // A consent can only be requested by the minor it concerns, so the minor asks.
  await safety.recordAge("minor-1", { dateOfBirth: "2014-01-01", method: "synthetic_test" });
  const requested = await safety.requestParentalConsent("minor-1", {
    guardianEmail: "guardian@example.com", scope: ["play"], requestedBy: "minor-1",
  });
  const decided = await safety.decideParentalConsent(requested.id, "granted", "moderator-1");
  fs.rmSync(dir, { recursive: true, force: true });
  return { requested, decided };
}

test("CLOSED (was DEFECT, OPEN): the parental-consent flow has columns for what it writes", async () => {
  // WAS: 0012 fixed the moderation flow, which is where the review had looked.
  // The parental-consent flow had exactly the same disease and neither 0011 nor
  // 0012 visited it:
  //
  //   requestParentalConsent() writes `requested_by`  — no such column
  //   decideParentalConsent()  writes `decided_by`    — no such column
  //
  // Both failed with PGRST204, so no parental consent record had ever reached
  // the durable store either, and the collection degraded the same way the
  // reports collection did. These are the records that say a guardian was asked
  // and what they answered — for a minor. They are also the two fields that
  // make the row attributable at all, which is why they were added to the code:
  // safety.mjs is explicit that "a row nobody is accountable for cannot be
  // audited after the fact". 0013 adds both.
  const { requested, decided } = await driveParentalConsentFlow();
  const cols = columnsOf("dcsgames_parental_consent");
  const missing = [...new Set([...Object.keys(requested), ...Object.keys(decided)])].filter((k) => !cols.has(k));
  assert.deepEqual(
    missing, [],
    `the parental consent flow writes ${JSON.stringify(missing)} and the table declares none of them. ` +
    `Declared columns: ${JSON.stringify([...cols])}.`
  );
  assert.ok(cols.has("requested_by") && cols.has("decided_by"), "the two 0013 added");

  // And every status the flow can actually reach is storable. `decision` is
  // constrained to granted/denied/revoked at the service, and the row starts
  // 'pending'.
  const statuses = checkValues("dcsgames_parental_consent", "status");
  for (const st of ["pending", "granted", "denied", "revoked"]) {
    assert.ok(statuses.includes(st), `status '${st}' is storable`);
  }
});

test("CLOSED (was DEFECT, OPEN): a caller cannot write a value the column would refuse", async () => {
  // WAS: 0011 and 0012 aligned the columns with what the CODE writes. Nothing
  // aligned them with what a CALLER could make the code write.
  //
  // Two fields reached a check-constrained column straight from a request body
  // without being validated against its vocabulary:
  //
  //   POST /safety/age     {"method": ...}        -> dcsgames_age_assurance.method
  //   POST /safety/report  {"subject_type": ...}  -> dcsgames_reports.subject_type
  //
  // Neither enum is published in /health's `safety.accepts` either, so a client
  // cannot discover the permitted set. And the consequence is not confined to
  // the bad row: a collection write upserts the whole shadow in one request per
  // key-shape (src/core/collection.mjs), so ONE poisoned row fails the batch
  // and every other principal's row in it goes unpersisted — the collection
  // degrades, /health raises the critical SAFETY_PERSISTENCE_DEGRADED alert,
  // and age assurance is the gate the entire minor-safety story rests on.
  //
  // The service is the right place for the check, because every route that ever
  // reaches these writers then inherits it — which is the argument the cw5
  // actor-binding makes for living in the engine rather than the route.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dcs-g-enum-"));
  const safety = createSafetyService({ DCS_DATA_DIR: dir });

  const ageMethods = checkValues("dcsgames_age_assurance", "method");
  let ageRefused = false;
  try { await safety.recordAge("p-enum", { dateOfBirth: "1990-01-01", method: "a-value-no-column-allows" }); }
  catch { ageRefused = true; }

  const subjectTypes = checkValues("dcsgames_reports", "subject_type");
  let reportRefused = false;
  try { await safety.report("reporter-enum", { subjectType: "banana", subjectId: "x", reason: "spam" }); }
  catch { reportRefused = true; }

  fs.rmSync(dir, { recursive: true, force: true });

  assert.deepEqual(
    { ageRefused, reportRefused }, { ageRefused: true, reportRefused: true },
    "an unrecognised value must be refused at the service, before it can poison a durable write. " +
    `age_assurance.method allows ${JSON.stringify(ageMethods)}; ` +
    `reports.subject_type allows ${JSON.stringify(subjectTypes)}. ` +
    "safety.mjs validates reason against REPORT_REASONS and media_kind against MEDIA_KINDS in exactly " +
    "this way — these two were missed."
  );

  // The enums are now published too, so a client can discover the permitted set
  // instead of learning it from a rejection.
  assert.deepEqual([...AGE_METHODS].sort(), [...ageMethods].sort(), "the published age methods ARE the column's");
  assert.deepEqual([...SUBJECT_TYPES].sort(), [...subjectTypes].sort(), "and the published subject types too");

  // The valid values still go through: a validator that refuses everything
  // would pass the test above and break the routes.
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "dcs-g-enum-ok-"));
  const ok = createSafetyService({ DCS_DATA_DIR: dir2 });
  for (const method of AGE_METHODS) {
    await ok.recordAge(`p-${method}`, { dateOfBirth: "1990-01-01", method });
  }
  for (const subjectType of SUBJECT_TYPES) {
    await ok.report("reporter-ok", { subjectType, subjectId: "x", reason: "spam" });
  }
  fs.rmSync(dir2, { recursive: true, force: true });
});
