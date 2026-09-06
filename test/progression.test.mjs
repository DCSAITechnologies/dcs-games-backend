// B15 — retention and progression, computed only from measured data.
//
// The Round-2 site showed a daily-reward strip with days pre-marked "Claimed",
// 184 achievements, 9,240 points and a battle-pass level. None of it was
// measured. This is the replacement, and these tests assert that every number it
// produces traces back to a row that exists.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSocialService } from "../src/core/social.mjs";
import { createWorldMemory } from "../src/v3/memory/world-memory.mjs";
import { createProgressionService, ACHIEVEMENTS, XP_TABLE } from "../src/core/progression.mjs";

function svc() {
  const env = { DCS_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "dcs-prog-")) };
  const social = createSocialService(env);
  const worldMemory = createWorldMemory(env);
  return { social, worldMemory, prog: createProgressionService({ social, worldMemory }) };
}

const P = (id) => ({ id, email: id + "@dcsai.ai" });

test("B15 GATE: a brand-new player has zero of everything, honestly", async () => {
  const { social, prog } = svc();
  await social.ensureProfile(P("u1"));
  const a = await prog.achievements("u1");
  assert.equal(a.unlocked, 0, "nothing may be unlocked before anything happened");
  assert.ok(a.achievements.every((x) => x.progress === 0 && !x.unlocked));
  assert.match(a.note, /Nothing is seeded/);
  assert.equal(a.metrics.xp, 0);
});

test("B15 GATE: an achievement unlocks only when the measured metric reaches it", async () => {
  const { social, prog } = svc();
  await social.ensureProfile(P("u1"));

  await social.recordWorldCreated("u1");
  let a = await prog.achievements("u1");
  assert.equal(a.achievements.find((x) => x.id === "first_world").unlocked, true);
  assert.equal(a.achievements.find((x) => x.id === "five_worlds").unlocked, false);
  assert.equal(a.achievements.find((x) => x.id === "five_worlds").progress_text, "1 of 5");

  for (let i = 0; i < 4; i++) await social.recordWorldCreated("u1");
  a = await prog.achievements("u1");
  assert.equal(a.achievements.find((x) => x.id === "five_worlds").unlocked, true);
});

test("B15 GATE: progress is the exact figure, never rounded up to flatter", async () => {
  const { social, prog } = svc();
  await social.ensureProfile(P("u1"));
  await social.recordPlay("w1", "u1", 60);
  const a = await prog.achievements("u1");
  const hour = a.achievements.find((x) => x.id === "hour_played");
  assert.equal(hour.progress, 60);
  assert.equal(hour.target, 3600);
  assert.equal(hour.progress_text, "60 of 3600");
  assert.equal(hour.unlocked, false);
});

test("B15: an achievement cannot be granted by writing a row — it is computed", async () => {
  const { social, prog } = svc();
  await social.ensureProfile(P("u1"));
  // There is no achievements table to insert into. The only way to unlock
  // "first_play" is to have a play row.
  assert.equal((await prog.achievements("u1")).achievements.find((x) => x.id === "first_play").unlocked, false);
  await social.recordPlay("w1", "u1", 10);
  assert.equal((await prog.achievements("u1")).achievements.find((x) => x.id === "first_play").unlocked, true);
});

test("B15: expansions come from the recorded world chronology", async () => {
  const { social, worldMemory, prog } = svc();
  await social.ensureProfile(P("u1"));
  assert.equal((await prog.metrics("u1", ["w1"])).expansions, 0);
  await worldMemory.record("w1", { kind: "expanded", summary: "hospital district added", worldVersion: 2 });
  await worldMemory.record("w1", { kind: "edited", summary: "made it rain", worldVersion: 3 });
  const m = await prog.metrics("u1", ["w1"]);
  assert.equal(m.expansions, 1, "an edit is not an expansion");
});

test("B15: 'someone played your world' counts only OTHER players", async () => {
  const { social, prog } = svc();
  await social.ensureProfile(P("u1"));
  await social.recordPlay("w1", "u1", 30);      // the creator playing their own world
  assert.equal((await prog.metrics("u1", ["w1"])).plays_by_others, 0);
  await social.recordPlay("w1", "u2", 30);
  assert.equal((await prog.metrics("u1", ["w1"])).plays_by_others, 1);
});

// ------------------------------------------------------------------- streak

test("B15 GATE: a streak with no sessions is zero and says so — nothing is pre-claimed", async () => {
  const { social, prog } = svc();
  await social.ensureProfile(P("u1"));
  const s = await prog.streak("u1");
  assert.equal(s.current, 0);
  assert.equal(s.longest, 0);
  assert.equal(s.played_today, false);
  assert.deepEqual(s.days, []);
  assert.match(s.note, /No sessions have been recorded/);
});

test("B15 GATE: a streak carries NO reward and nothing to claim", async () => {
  const { social, prog } = svc();
  await social.recordPlay("w1", "u1", 100);
  const s = await prog.streak("u1");
  assert.equal(s.current, 1);
  assert.equal(s.played_today, true);
  assert.equal(s.rewards, null, "the old UI showed a Day 7 'Legendary' reward that did not exist");
  assert.match(s.note, /nothing to claim/);
});

test("B15: a streak counts distinct days, not sessions", async () => {
  const { social, prog } = svc();
  await social.recordPlay("w1", "u1", 10);
  await social.recordPlay("w1", "u1", 10);
  await social.recordPlay("w1", "u1", 10);
  const s = await prog.streak("u1");
  assert.equal(s.current, 1, "three sessions in one day is a one-day streak");
  assert.equal(s.days.length, 1);
});

// -------------------------------------------------------- creator dashboard

test("B15 GATE: the creator dashboard reports no revenue, because none can exist", async () => {
  const { social, prog } = svc();
  await social.ensureProfile(P("u1"));
  const d = await prog.creatorDashboard("u1", [{ world_id: "w1", title: "Ashfall", state: "published", version: 1 }]);
  assert.equal(d.payments_live, false);
  assert.equal(d.revenue, null);
  assert.match(d.revenue_note, /PAYMENTS_LIVE is false/);
});

test("B15 GATE: with no activity, the dashboard says there is nothing to recommend from", async () => {
  const { social, prog } = svc();
  await social.ensureProfile(P("u1"));
  const d = await prog.creatorDashboard("u1", [{ world_id: "w1", title: "Ashfall", state: "draft", version: 1 }]);
  assert.equal(d.worlds[0].stats.plays, 0);
  assert.match(d.worlds[0].recommendation, /nothing to recommend from/);
  assert.equal(d.totals.plays, 0);
});

test("B15: the dashboard reflects real activity once it exists", async () => {
  const { social, prog } = svc();
  await social.ensureProfile(P("u1"));
  await social.recordPlay("w1", "p1", 300);
  await social.recordPlay("w1", "p2", 200);
  await social.rateWorld("p1", "w1", 4);
  const d = await prog.creatorDashboard("u1", [{ world_id: "w1", title: "Ashfall", state: "published", version: 1 }]);
  assert.equal(d.totals.plays, 2);
  assert.equal(d.totals.players, 2);
  assert.equal(d.totals.seconds, 500);
  assert.match(d.worlds[0].recommendation, /average rating 4/);
});

test("B15: an empty creator sees a plain statement, not an empty grid", async () => {
  const { social, prog } = svc();
  await social.ensureProfile(P("u1"));
  const d = await prog.creatorDashboard("u1", []);
  assert.match(d.note, /have not created a world/);
});

// ------------------------------------------------------------------------ xp

test("B15: XP is only awarded for events in the table", async () => {
  const { prog } = svc();
  assert.equal((await prog.awardXp("u1", "world_published")).xp, XP_TABLE.world_published);
  await assert.rejects(() => prog.awardXp("u1", "logged_in"), (e) => e.httpStatus === 422);
  await assert.rejects(() => prog.awardXp("u1", "opened_the_app"), (e) => /not an XP-earning event/.test(e.detail));
});

test("B15: no achievement or reward carries currency", () => {
  const json = JSON.stringify(ACHIEVEMENTS).toLowerCase();
  for (const word of ["coin", "cash", "price", "currency", "gem", "credit"]) {
    assert.ok(!json.includes(word), `an achievement mentions '${word}' while payments are dark`);
  }
});
