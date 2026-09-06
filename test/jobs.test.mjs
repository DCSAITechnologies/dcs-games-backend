// P1 — asynchronous world generation.
//
// The point of this module is honest progress. The creator UI previously moved a
// bar on a timer, which is the same class of dishonesty as a fabricated metric:
// motion that corresponded to nothing. These tests assert that progress is
// derived from stages that actually completed, that a failure says where it
// broke, and that a job orphaned by a restart is reported as interrupted rather
// than left saying "running" forever.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJobService, GENERATION_STAGES, JOB_STATES } from "../src/core/jobs.mjs";

const tmp = () => ({ DCS_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "dcs-jobs-")) });
const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));

test("P1: a new job declares its whole stage list up front", async () => {
  const j = await createJobService(tmp()).create({ kind: "world_generate", principalId: "u1" });
  assert.equal(j.state, "queued");
  assert.deepEqual(j.stages.map((s) => s.id), GENERATION_STAGES.map((s) => s.id));
  assert.ok(j.stages.every((s) => s.state === "pending"), "nothing may claim to have started yet");
});

test("P1 GATE: progress counts stages that ACTUALLY completed, not elapsed time", async () => {
  const svc = createJobService(tmp());
  const j = await svc.create({ kind: "world_generate", principalId: "u1" });

  let cur = await svc.get(j.id);
  assert.equal(cur.progress.fraction, 0);
  assert.equal(cur.progress.basis, "completed stages, not elapsed time");

  await svc.startStage(j.id, "world_architect");
  cur = await svc.get(j.id);
  assert.equal(cur.progress.fraction, 0, "starting a stage is not progress; finishing one is");
  assert.equal(cur.progress.current_stage.id, "world_architect");

  await svc.finishStage(j.id, "world_architect", "deepseek:deepseek-v4-pro (AVAILABLE) 63032ms");
  cur = await svc.get(j.id);
  assert.ok(cur.progress.fraction > 0);
  assert.equal(cur.progress.completed_stages, 1);
  assert.match(cur.stages.find((s) => s.id === "world_architect").detail, /deepseek/, "the provider that answered is recorded");
});

test("P1: a skipped optional stage does not count against progress", async () => {
  const svc = createJobService(tmp());
  const j = await svc.create({ kind: "world_generate", principalId: "u1" });
  const total = (await svc.get(j.id)).progress.total_stages;

  await svc.skipStage(j.id, "vision", "no reference image was supplied");
  await svc.skipStage(j.id, "media", "key art was not requested");
  const after = await svc.get(j.id);
  assert.equal(after.progress.total_stages, total - 2, "skipped optional stages leave the denominator honest");
  assert.match(after.stages.find((s) => s.id === "vision").detail, /no reference image/);
});

test("P1 GATE: a failure records WHERE it broke", async () => {
  const svc = createJobService(tmp());
  const j = await svc.create({ kind: "world_generate", principalId: "u1" });
  await svc.startStage(j.id, "gameplay");
  await svc.fail(j.id, new Error("every adapter failed"));

  const cur = await svc.get(j.id);
  assert.equal(cur.state, "failed");
  assert.equal(cur.progress.failed_stage.id, "gameplay", "the UI must be able to show which stage broke");
  assert.match(cur.error, /every adapter failed/);
  assert.equal(cur.stages.find((s) => s.id === "gameplay").state, "failed");
});

test("P1 GATE: a job orphaned by a restart is marked interrupted, never left running", async () => {
  const env = tmp();
  const first = createJobService(env);
  const j = await first.create({ kind: "world_generate", principalId: "u1", bootId: "boot-1" });
  await first.markRunning(j.id, "boot-1");
  assert.equal((await first.get(j.id)).state, "running");

  // A new process comes up with a different boot id.
  const second = createJobService(env);
  const r = await second.reconcileOnBoot("boot-2");
  assert.equal(r.interrupted, 1);
  const after = await second.get(j.id);
  assert.equal(after.state, "interrupted");
  assert.match(after.error, /restarted while this job was running/);
  assert.ok(after.finished_at, "an interrupted job is finished, not pending forever");
});

test("P1: reconciliation leaves a job from the CURRENT boot alone", async () => {
  const env = tmp();
  const svc = createJobService(env);
  const j = await svc.create({ kind: "world_generate", principalId: "u1", bootId: "boot-1" });
  await svc.markRunning(j.id, "boot-1");
  const r = await svc.reconcileOnBoot("boot-1");
  assert.equal(r.interrupted, 0);
  assert.equal((await svc.get(j.id)).state, "running");
});

test("P1: reconciliation does not disturb jobs that already finished", async () => {
  const env = tmp();
  const a = createJobService(env);
  const done = await a.create({ kind: "world_generate", principalId: "u1", bootId: "boot-1" });
  await a.succeed(done.id, { world_id: "w1" });
  const b = createJobService(env);
  await b.reconcileOnBoot("boot-2");
  assert.equal((await b.get(done.id)).state, "succeeded");
});

test("P1 GATE: a job is private to its owner", async () => {
  const svc = createJobService(tmp());
  const j = await svc.create({ kind: "world_generate", principalId: "u1" });
  await assert.rejects(() => svc.get(j.id, "u2"), (e) => e.httpStatus === 404, "another principal's job answers exactly as one that does not exist");
  assert.equal((await svc.get(j.id, "u1")).id, j.id);
  assert.equal((await svc.listFor("u2")).length, 0);
  assert.equal((await svc.listFor("u1")).length, 1);
});

test("P1 GATE: an image payload is never stored on the job record", async () => {
  const svc = createJobService(tmp());
  const dataUrl = "data:image/png;base64," + Buffer.from("x".repeat(4000)).toString("base64");
  const j = await svc.create({ kind: "world_generate", principalId: "u1", input: { prompt: "A port", image_data_url: dataUrl, api_key: "secret-value" } });
  const json = JSON.stringify(j.input);
  assert.ok(!json.includes(dataUrl.slice(30, 90)), "the image bytes must not be persisted on the job");
  assert.match(j.input.image_data_url, /omitted/);
  assert.equal(j.input.api_key, "<redacted>");
  assert.equal(j.input.prompt, "A port");
});

test("P1: run() returns immediately and reports the result when it lands", async () => {
  const svc = createJobService(tmp());
  const j = await svc.create({ kind: "world_generate", principalId: "u1", bootId: "b" });
  const t0 = Date.now();
  svc.run(j.id, "b", async (ctx) => {
    await ctx.startStage("world_architect");
    await settle(40);
    await ctx.finishStage("world_architect", "local (FALLBACK)");
    return { world_id: "w_done" };
  });
  assert.ok(Date.now() - t0 < 30, "run() must not block the caller");

  for (let i = 0; i < 40 && (await svc.get(j.id)).state !== "succeeded"; i++) await settle(25);
  const done = await svc.get(j.id);
  assert.equal(done.state, "succeeded");
  assert.deepEqual(done.result, { world_id: "w_done" });
  assert.ok(done.elapsed_ms >= 0);
});

test("P1: a throwing job lands as failed, with the reason", async () => {
  const svc = createJobService(tmp());
  const j = await svc.create({ kind: "world_generate", principalId: "u1", bootId: "b" });
  svc.run(j.id, "b", async (ctx) => {
    await ctx.startStage("spatial");
    throw new Error("terrain provider exploded");
  });
  for (let i = 0; i < 40 && (await svc.get(j.id)).state !== "failed"; i++) await settle(25);
  const done = await svc.get(j.id);
  assert.equal(done.state, "failed");
  assert.match(done.error, /terrain provider exploded/);
  assert.equal(done.progress.failed_stage.id, "spatial");
});

test("P1: cancelling aborts the work and is refused once terminal", async () => {
  const svc = createJobService(tmp());
  const j = await svc.create({ kind: "world_generate", principalId: "u1", bootId: "b" });
  let aborted = false;
  svc.run(j.id, "b", async (ctx) => {
    ctx.signal.addEventListener("abort", () => { aborted = true; });
    await settle(400);
    return {};
  });
  await settle(40);
  const cancelled = await svc.cancel(j.id, "u1");
  assert.equal(cancelled.state, "failed");
  assert.match(cancelled.error, /cancelled by the owner/);
  assert.equal(aborted, true, "the work must observe the abort signal");
  await assert.rejects(() => svc.cancel(j.id, "u1"), (e) => e.httpStatus === 409);
});

test("P1: a stage the job does not declare cannot be reported", async () => {
  const svc = createJobService(tmp());
  const j = await svc.create({ kind: "world_generate", principalId: "u1" });
  await assert.rejects(() => svc.startStage(j.id, "teleportation"), (e) => e.httpStatus === 422);
  await assert.rejects(() => svc.get("job_nope"), (e) => e.httpStatus === 404);
});

test("P1: jobs survive a service restart and stay queryable", async () => {
  const env = tmp();
  const a = createJobService(env);
  const j = await a.create({ kind: "world_generate", principalId: "u1", bootId: "b1" });
  await a.finishStage(j.id, "world_architect", "local (FALLBACK)");
  const b = createJobService(env);
  const seen = await b.get(j.id);
  assert.equal(seen.id, j.id);
  assert.equal(seen.progress.completed_stages, 1);
  assert.ok(JOB_STATES.includes(seen.state));
});

test("P1: creating a job requires an owner and a kind", async () => {
  const svc = createJobService(tmp());
  await assert.rejects(() => svc.create({ kind: "world_generate", principalId: null }), (e) => e.httpStatus === 401);
  await assert.rejects(() => svc.create({ principalId: "u1" }), (e) => e.httpStatus === 422);
});
