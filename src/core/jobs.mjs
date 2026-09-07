// P1 — asynchronous world generation.
//
// A premium-lane generation takes around 147 seconds end to end. Holding an HTTP
// request open for that long is the wrong shape: it times out behind proxies, it
// gives the creator no idea which stage is running, and a dropped connection
// loses work that has already been paid for.
//
// This is a small durable job runner. It is deliberately in-process rather than
// a queue service: one API instance is what this estate runs, adding a broker
// would be a deployment dependency nobody asked for, and the durable record
// means a job that was interrupted is reported as interrupted rather than
// silently vanishing.
//
// The honesty rules that matter here:
//   - progress reports the stage that has ACTUALLY completed, never a timer
//   - a job that fails records why, and stays queryable
//   - a job interrupted by a restart is marked interrupted on the next boot; it
//     is never left saying "running" forever, and never quietly marked done
import crypto from "node:crypto";
import path from "node:path";
import { Errors } from "./errors.mjs";
import { createCollection } from "./collection.mjs";

export const JOB_STATES = ["queued", "running", "succeeded", "failed", "interrupted"];

/** The stages a world generation passes through, in order. */
export const GENERATION_STAGES = [
  { id: "vision", label: "Reading the reference image", optional: true },
  { id: "world_architect", label: "Designing the world" },
  { id: "fast_inference", label: "Classifying and tagging" },
  { id: "spatial", label: "Building terrain and navigation" },
  { id: "asset_3d", label: "Assembling 3D assets" },
  { id: "gameplay", label: "Writing interactive behaviour" },
  { id: "media", label: "Generating key art", optional: true },
  { id: "playtest", label: "Playtesting the world" },
  { id: "save", label: "Saving" },
];

const TERMINAL = new Set(["succeeded", "failed", "interrupted"]);

export function createJobService(env = process.env) {
  const dir = path.join(env.DCS_DATA_DIR || path.join(process.cwd(), ".dcs-data"), "jobs");
  const jobs = createCollection({ dir, name: "jobs", table: null, primaryKey: ["id"], env });
  const running = new Map();          // id -> AbortController, for cancellation

  /** Keep the store from growing without bound. */
  const RETAIN = 200;

  const svc = {
    dir,
    GENERATION_STAGES,

    /**
     * Mark anything left "running" or "queued" by a previous process as
     * interrupted. Called once at boot. Without this a job orphaned by a restart
     * would report "running" forever, which is a lie the UI would faithfully
     * repeat.
     */
    async reconcileOnBoot(bootId = crypto.randomUUID()) {
      const rows = await jobs.all();
      const orphans = rows.filter((j) => !TERMINAL.has(j.state) && j.boot_id !== bootId);
      if (!orphans.length) return { interrupted: 0, boot_id: bootId };
      const now = new Date().toISOString();
      await jobs.write(rows.map((j) => (orphans.some((o) => o.id === j.id)
        ? { ...j, state: "interrupted", finished_at: now, error: "the service restarted while this job was running" }
        : j)));
      console.warn(JSON.stringify({ level: "warn", jobs_interrupted: orphans.length, boot_id: bootId, ts: now }));
      return { interrupted: orphans.length, boot_id: bootId, ids: orphans.map((o) => o.id) };
    },

    async create({ kind, principalId, input = {}, bootId }) {
      if (!principalId) throw Errors.unauthenticated("a job needs an authenticated owner");
      if (!kind) throw Errors.validation("a job needs a kind");
      const job = {
        id: "job_" + crypto.randomBytes(8).toString("hex"),
        kind,
        owner_id: principalId,
        state: "queued",
        boot_id: bootId ?? null,
        // The stage list is fixed up front so a client can render the whole
        // sequence immediately and fill it in, rather than guessing what is next.
        stages: GENERATION_STAGES.map((s) => ({ ...s, state: "pending", started_at: null, finished_at: null, detail: null })),
        input: redactInput(input),
        result: null,
        error: null,
        created_at: new Date().toISOString(),
        started_at: null,
        finished_at: null,
      };
      await jobs.insert(job);
      await prune();
      return job;
    },

    async get(jobId, requesterId = null) {
      const j = await jobs.one((x) => x.id === jobId);
      if (!j) throw Errors.notFound(`job ${jobId}`);
      // `undefined`/`null` means no principal was supplied at all: an
      // unattributed internal read, which is how this service reads its own
      // jobs. An EMPTY-BUT-PRESENT principal — "", 0, false — is a call site
      // that meant to pass one and lost it, and the old `if (requesterId && ...)`
      // treated it as "no check required". That is the fail-open shape the world
      // store already closed: a falsy principal must never widen access.
      if (requesterId !== undefined && requesterId !== null && !requesterId) {
        throw Errors.unauthenticated("a job read was given an empty principal; refusing to treat that as an unattributed read", {
          meta: { job_id: jobId },
        });
      }
      // Same answer as a thing that does not exist. A 403 here confirms the id
      // is real to somebody who may not see it — the existence oracle already
      // closed on worlds and on retained versions, one surface along.
      //
      // owner_id is required to be present as well as equal, matching
      // worldstore's shape: a row whose owner is null must not be readable by a
      // principal whose id happens to be null-ish.
      if (requesterId != null && !(j.owner_id != null && j.owner_id === requesterId)) {
        throw Errors.notFound(`job ${jobId}`);
      }
      return withProgress(j);
    },

    async listFor(principalId, { limit = 20 } = {}) {
      const rows = await jobs.find((j) => j.owner_id === principalId);
      rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
      return rows.slice(0, limit).map(withProgress);
    },

    /** Mark a stage started. Only a stage the job actually declares. */
    async startStage(jobId, stageId, detail = null) {
      return await patchStage(jobId, stageId, (st) => ({ ...st, state: "running", started_at: new Date().toISOString(), detail }));
    },

    /** Mark a stage done. `detail` is the FACT of what happened, e.g. which provider answered. */
    async finishStage(jobId, stageId, detail = null) {
      return await patchStage(jobId, stageId, (st) => ({ ...st, state: "done", finished_at: new Date().toISOString(), detail }));
    },

    async skipStage(jobId, stageId, reason) {
      return await patchStage(jobId, stageId, (st) => ({ ...st, state: "skipped", finished_at: new Date().toISOString(), detail: reason }));
    },

    async markRunning(jobId, bootId) {
      return await jobs.update((j) => j.id === jobId, (j) => ({ ...j, state: "running", boot_id: bootId ?? j.boot_id, started_at: j.started_at || new Date().toISOString() }));
    },

    async succeed(jobId, result) {
      running.delete(jobId);
      return await jobs.update((j) => j.id === jobId, (j) => ({ ...j, state: "succeeded", result, finished_at: new Date().toISOString() }));
    },

    async fail(jobId, error, detail = null) {
      running.delete(jobId);
      const message = typeof error === "string" ? error : (error?.detail || error?.message || String(error));
      return await jobs.update((j) => j.id === jobId, (j) => ({
        ...j,
        state: "failed",
        // A failed stage stays visibly failed, so the UI shows WHERE it broke.
        stages: j.stages.map((s) => (s.state === "running" ? { ...s, state: "failed", finished_at: new Date().toISOString(), detail: message } : s)),
        error: message,
        error_detail: detail,
        finished_at: new Date().toISOString(),
      }));
    },

    /** Cancel a running job. The work itself observes the abort signal. */
    async cancel(jobId, requesterId) {
      const j = await svc.get(jobId, requesterId);
      if (TERMINAL.has(j.state)) throw Errors.conflict(`this job already ${j.state}`);
      running.get(jobId)?.abort();
      running.delete(jobId);
      return await jobs.update((x) => x.id === jobId, (x) => ({ ...x, state: "failed", error: "cancelled by the owner", finished_at: new Date().toISOString() }));
    },

    /**
     * Run work in the background, reporting into the job.
     * Returns immediately; the caller hands the job id to the client.
     */
    run(jobId, bootId, work) {
      const controller = new AbortController();
      running.set(jobId, controller);
      // Deliberately not awaited: the HTTP request returns while this continues.
      (async () => {
        try {
          await svc.markRunning(jobId, bootId);
          const result = await work({
            signal: controller.signal,
            startStage: (s, d) => svc.startStage(jobId, s, d),
            finishStage: (s, d) => svc.finishStage(jobId, s, d),
            skipStage: (s, r) => svc.skipStage(jobId, s, r),
          });
          await svc.succeed(jobId, result);
        } catch (e) {
          await svc.fail(jobId, e, e?.meta ?? null);
        }
      })();
      return jobId;
    },

    _jobs: jobs,
  };

  async function patchStage(jobId, stageId, mut) {
    const j = await jobs.one((x) => x.id === jobId);
    if (!j) throw Errors.notFound(`job ${jobId}`);
    if (!j.stages.some((s) => s.id === stageId)) {
      throw Errors.validation(`'${stageId}' is not a stage of this job`, { meta: { stages: j.stages.map((s) => s.id) } });
    }
    return await jobs.update((x) => x.id === jobId, (x) => ({ ...x, stages: x.stages.map((s) => (s.id === stageId ? mut(s) : s)) }));
  }

  /**
   * Drop the oldest jobs past the retention cap.
   *
   * This read the whole table and wrote a truncated copy back — outside the
   * collection lock, with awaits in between. create() calls it immediately after
   * jobs.insert(), so two concurrent creations are exactly the case that
   * triggers it: A inserts, B inserts, then A's prune writes back a table it
   * read before B's row existed, and B's job is gone while B holds its id and is
   * polling for it. The same lost-update shape as safety.unblock(); Lane C
   * pinned the safe primitive in test/collection.test.mjs "LANE C/4".
   *
   * remove() does the read, the filter and the write inside the lock, so it
   * decides what to drop from the table as it actually is at that moment. It is
   * given a SET OF IDS rather than a predicate over position, so a job inserted
   * between the read below and the remove is not in the set and survives — the
   * table may momentarily hold RETAIN + a few, and the next create() trims it.
   * Retaining slightly too much is harmless; erasing a live job is not.
   */
  async function prune() {
    const rows = await jobs.all();
    if (rows.length <= RETAIN) return;
    const oldestFirst = [...rows].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    const doomed = new Set(oldestFirst.slice(RETAIN).map((j) => j.id));
    if (!doomed.size) return;
    await jobs.remove((j) => doomed.has(j.id));
  }

  return svc;
}

/**
 * Progress is derived from stages that ACTUALLY finished.
 *
 * This is the whole point of the module. The creator UI previously advanced a
 * bar on a timer, which is the same class of dishonesty as a fabricated metric:
 * it showed motion that corresponded to nothing.
 */
function withProgress(job) {
  const counted = job.stages.filter((s) => !(s.optional && s.state === "skipped"));
  const done = counted.filter((s) => s.state === "done").length;
  const current = job.stages.find((s) => s.state === "running") || null;
  const failed = job.stages.find((s) => s.state === "failed") || null;
  return {
    ...job,
    progress: {
      completed_stages: done,
      total_stages: counted.length,
      // A fraction of real stages, not of elapsed time.
      fraction: counted.length ? Number((done / counted.length).toFixed(3)) : 0,
      current_stage: current ? { id: current.id, label: current.label, started_at: current.started_at } : null,
      failed_stage: failed ? { id: failed.id, label: failed.label, detail: failed.detail } : null,
      basis: "completed stages, not elapsed time",
    },
    elapsed_ms: job.started_at ? (new Date(job.finished_at || Date.now()) - new Date(job.started_at)) : null,
  };
}

/** Never store an image payload or anything secret on the job record. */
function redactInput(input) {
  const out = {};
  for (const [k, v] of Object.entries(input || {})) {
    if (typeof v === "string" && v.startsWith("data:")) { out[k] = `<${v.slice(5, v.indexOf(";")) || "data"} omitted, ${Math.round(v.length * 0.75 / 1024)}KB>`; continue; }
    if (/token|secret|key|password/i.test(k)) { out[k] = "<redacted>"; continue; }
    out[k] = typeof v === "string" ? v.slice(0, 500) : v;
  }
  return out;
}
