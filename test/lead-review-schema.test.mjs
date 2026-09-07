// Lane G — migrations/0011_reports_escalation.sql is right about the two
// mismatches it names, and there are three more in the same code path.
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
import { createSafetyService, MEDIA_KINDS, CONSENT_SOURCES } from "../src/core/safety.mjs";
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

test("DEFECT, OPEN: dcsgames_reports has no 'action' column, and moderating writes one", async () => {
  const { reports } = await driveModerationFlow();
  const cols = columnsOf("dcsgames_reports");
  const written = Object.keys(reports[0]);
  const missing = written.filter((k) => !cols.has(k));
  assert.deepEqual(
    missing, [],
    `safety.moderate() (src/core/safety.mjs:319) writes ${JSON.stringify(missing)} and the table has no ` +
    `such column after 0011, so the upsert fails with the same PGRST204 that 0011 was written to end — ` +
    "one write later in the same flow. The reports collection then degrades again, and the moderation " +
    "decision lives only in the container filesystem the migration's own header says is lost at the " +
    `next deploy. Declared columns: ${JSON.stringify([...cols])}`
  );
});

test("DEFECT, OPEN: dcsgames_moderation_actions has no 'audit' column, and every decision writes one", async () => {
  const { actions } = await driveModerationFlow();
  const cols = columnsOf("dcsgames_moderation_actions");
  const written = Object.keys(actions[0]);
  const missing = written.filter((k) => !cols.has(k));
  assert.deepEqual(
    missing, [],
    `safety.moderate() writes ${JSON.stringify(missing)} to dcsgames_moderation_actions, which 0004 ` +
    "declares without it and 0011 does not touch. The audit entry — the record of who decided what, " +
    "which is the whole point of the moderation audit trail — cannot reach the durable store."
  );
});

test("DEFECT, OPEN: two of the four moderation actions violate the moderation_actions check", async () => {
  const allowed = checkValues("dcsgames_moderation_actions", "action");
  assert.ok(allowed, "the constraint is declared");
  const rejected = MOD_ACTIONS.filter((a) => !allowed.includes(a));
  assert.deepEqual(
    rejected, [],
    `MOD_ACTIONS (src/cw1/trust-safety.mjs:8) is ${JSON.stringify(MOD_ACTIONS)}, and /health publishes it ` +
    "to clients as `safety.accepts.moderation_action`, so a moderator can take these actions and the " +
    `route accepts them. The column allows ${JSON.stringify(allowed)}, so ${JSON.stringify(rejected)} ` +
    "fail with 23514 — the identical class of mismatch 0011 fixed for dcsgames_reports.status, in the " +
    "table the same function writes on the same request."
  );
});

test("DISPROVED: 0011 does fix the two mismatches it names", async () => {
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

test("DISPROVED: the appeal states are not reachable in this table", async () => {
  // REPORT_STATES carries appealed / appeal_upheld / appeal_denied, none of which
  // the widened check allows — but nothing writes them to dcsgames_reports.
  // safety.moderate() is the only writer and applyModeration only ever produces
  // 'under_review', 'actioned' or 'dismissed'; the appeal machinery belongs to
  // the legacy /ts console, whose store /health already documents as no longer
  // written to. So this is a latent mismatch, not a live one.
  const statuses = checkValues("dcsgames_reports", "status");
  const unreachableButUndeclared = REPORT_STATES.filter((s) => !statuses.includes(s));
  assert.deepEqual(unreachableButUndeclared, ["appealed", "appeal_upheld", "appeal_denied"]);
  // Recorded so that whoever wires appeals to the live store widens the check first.
});

test("DISPROVED: the media consent vocabulary matches its column", async () => {
  const kinds = checkValues("dcsgames_media_consent", "media_kind");
  assert.deepEqual([...MEDIA_KINDS].sort(), [...kinds].sort(), "every MEDIA_KIND is storable");
  const sources = checkValues("dcsgames_media_consent", "source");
  if (sources) assert.deepEqual([...CONSENT_SOURCES].sort(), [...sources].sort(), "every CONSENT_SOURCE is storable");
});
