// GAMES-A — the generation engine.
//
// One call: engine.run(task, request). The engine walks the task's route
// (primary, fallback 1, fallback 2, local) and for each provider decides, in
// this order: does it serve the task, is it configured, is its circuit closed,
// does its estimated cost fit the budget. Only then is it called, under a
// per-attempt timeout inside the route's overall deadline. Retries happen only
// for failure classes that were rejected before execution (failures.mjs), and
// a content-policy refusal stops the route rather than shopping it elsewhere.
//
// Every result carries deterministic request metadata, one asset per output
// with a deterministic asset ID, a provenance record, the attempts that were
// skipped or failed (classified and redacted), and its cost.
import { assertTask, OUTPUT_KIND, DEADLINE_MS, ATTEMPT_TIMEOUT_MS } from "./task-classes.mjs";
import { FAILURE, GenerationError, classify } from "./failures.mjs";
import { requestMetadata, assetId, contentHash, ENGINE_VERSION } from "./provenance.mjs";
import { BudgetLedger, budgetFromEnv } from "./budget.mjs";
import { HealthRegistry } from "./health.mjs";
import { redact, safeLog } from "./redact.mjs";
import { offline } from "../providers/contract.mjs";

const sleep = (ms, signal) => new Promise((res, rej) => {
  const t = setTimeout(res, ms);
  signal?.addEventListener("abort", () => { clearTimeout(t); rej(signal.reason); }, { once: true });
});

/** Does an adapter's output match what the task promised? */
export function validateOutputs(task, outputs) {
  if (!Array.isArray(outputs) || !outputs.length) return "no outputs";
  const kind = OUTPUT_KIND[task];
  for (const o of outputs) {
    if (!o || typeof o !== "object") return "output is not an object";
    if (kind === "json") {
      if (o.json === null || typeof o.json !== "object") return "expected a JSON object";
    } else if (o.placeholder) {
      continue;                                    // an honest local stand-in, labelled as such
    } else if ((typeof o.uri !== "string" || !o.uri) && (o.json === null || typeof o.json !== "object")) {
      return `expected a ${kind} uri or inline ${kind} data`;
    }
  }
  return null;
}

export class GenerationEngine {
  /**
   * @param {object} o
   * @param {Record<string,object>} o.adapters  provider id -> adapter
   * @param {Record<string,Array<{provider:string, model?:string}>>} o.routes  task -> ordered route
   */
  constructor({ adapters, routes, env = process.env, budget, health, fetchImpl, clock, sleepImpl, maxRetries = 1, logger } = {}) {
    this.adapters = adapters;
    this.routes = routes;
    this.env = env;
    this.budget = budget || new BudgetLedger(budgetFromEnv(env));
    this.health = health || new HealthRegistry();
    this.fetch = fetchImpl || globalThis.fetch;
    this.clock = clock || (() => new Date());
    this.sleep = sleepImpl || sleep;
    this.maxRetries = maxRetries;
    this.logger = logger || console;
  }

  /** Where each task would go right now, without calling anything. */
  describe() {
    const out = {};
    for (const [task, route] of Object.entries(this.routes)) {
      out[task] = route.map((s) => {
        const a = this.adapters[s.provider];
        return {
          provider: s.provider, model: s.model || null, local: !!a?.isLocal,
          configured: !!a && (a.isLocal || (!offline(this.env) && a.configured(this.env))),
          circuit_open: !!a && !a.isLocal && !this.health.canCall(s.provider),
        };
      });
    }
    return { engine_version: ENGINE_VERSION, routes: out, health: this.health.snapshot(), budget: this.budget.snapshot() };
  }

  async run(task, req = {}, { signal: outerSignal } = {}) {
    assertTask(task);
    const route = this.routes[task];
    if (!route?.length) throw new GenerationError(FAILURE.UNSUPPORTED, `no route for ${task}`);
    const meta = requestMetadata(task, req, { clock: this.clock });
    const deadline = AbortSignal.timeout(req.deadlineMs || DEADLINE_MS[task]);
    const routeSignal = outerSignal ? AbortSignal.any([deadline, outerSignal]) : deadline;
    const attempts = [];
    const skip = (step, cls, reason) => attempts.push({ provider: step.provider, model: step.model || null, class: cls, reason: redact(reason, this.env), ms: 0, tries: 0 });

    for (const step of route) {
      if (routeSignal.aborted) {
        const e = new GenerationError(FAILURE.DEADLINE, `${task}: route deadline reached`);
        e.attempts = attempts; e.request = meta; throw e;
      }
      const a = this.adapters[step.provider];
      if (!a) { skip(step, FAILURE.UNSUPPORTED, "no adapter registered"); continue; }
      if (!a.tasks.includes(task)) { skip(step, FAILURE.UNSUPPORTED, `does not serve ${task}`); continue; }
      if (!a.isLocal) {
        if (offline(this.env)) { skip(step, FAILURE.NOT_CONFIGURED, "external providers are offline in this process"); continue; }
        if (!a.configured(this.env)) { skip(step, FAILURE.NOT_CONFIGURED, "no credential configured"); continue; }
        if (!this.health.canCall(step.provider)) { skip(step, FAILURE.CIRCUIT_OPEN, "circuit open after recent failures"); continue; }
      }
      const model = step.model || a.defaultModel?.(task) || null;
      const estimateUsd = a.isLocal ? 0 : (a.estimateUsd?.(task, model, req) ?? 0);

      let reservation;
      try {
        reservation = this.budget.reserve({ worldId: req.worldId, requestId: meta.request_id, provider: step.provider, model, estimateUsd });
      } catch (e) { skip(step, FAILURE.BUDGET_EXCEEDED, e.message); continue; }

      const maxTries = a.isLocal ? 1 : 1 + (a.retrySafe?.(task) ? this.maxRetries : 0);
      const t0 = Date.now();
      let lastCls = null, tries = 0, stop = false, lastMsg = "";
      while (tries < maxTries) {
        tries++;
        const attemptSignal = AbortSignal.any([routeSignal, AbortSignal.timeout(req.attemptTimeoutMs || ATTEMPT_TIMEOUT_MS[task])]);
        try {
          const res = await a.invoke({ task, model, req, meta, env: this.env, fetch: this.fetch, signal: attemptSignal, sleep: this.sleep });
          const bad = validateOutputs(task, res?.outputs);
          if (bad) throw new GenerationError(FAILURE.INVALID_OUTPUT, bad, { provider: step.provider });
          const latency = Date.now() - t0;
          const cost = this.budget.settle(reservation, res.costUsd ?? null);
          if (!a.isLocal) this.health.recordSuccess(step.provider, latency);
          const usedModel = res.model || model;
          const assets = res.outputs.map((o, i) => ({
            asset_id: assetId(task, meta.request_id, step.provider, usedModel, i),
            task, kind: OUTPUT_KIND[task], mime: o.mime || null,
            ...(o.json !== undefined ? { json: o.json } : {}),
            ...(o.uri !== undefined ? { uri: o.uri } : {}),
            ...(o.placeholder ? { placeholder: true } : {}),
            ...(o.meta ? { meta: o.meta } : {}),
            content_sha256: contentHash(o),
          }));
          const provenance = {
            request_id: meta.request_id, task, provider: step.provider, vendor: a.vendor, model: usedModel,
            status: a.isLocal ? "FALLBACK" : "AVAILABLE", route_position: route.indexOf(step),
            latency_ms: latency, tries, cost_usd: +cost.toFixed(6), cost_basis: res.costUsd == null ? "estimate" : "reported",
            usage: res.usage || null, upstream_job_id: res.jobId || null, engine_version: ENGINE_VERSION,
            at: this.clock().toISOString(),
            ...(attempts.length ? { after: attempts.map((x) => `${x.provider}:${x.class}`) } : {}),
          };
          return { ok: true, request: meta, assets, provenance, attempts, cost_usd: provenance.cost_usd };
        } catch (e) {
          const c = classify(e);
          // A timeout whose cause was the ROUTE deadline is the route's failure, not the provider's.
          if (c.class === FAILURE.TIMEOUT && routeSignal.aborted) { lastCls = FAILURE.DEADLINE; lastMsg = "route deadline reached"; stop = true; break; }
          lastCls = c.class; lastMsg = String(e?.message || e);
          if (!a.isLocal) this.health.recordFailure(step.provider, c.class);
          safeLog("warn", { task, request_id: meta.request_id, provider: step.provider, failure: c.class, detail: lastMsg.slice(0, 300) }, this.env, this.logger);
          if (!c.fallthrough) stop = true;
          if (c.retryable && tries < maxTries && !stop && this.health.canCall(step.provider)) {
            const wait = Math.min(e?.retryAfterMs ?? 500 * 2 ** (tries - 1), 8000);
            try { await this.sleep(wait, routeSignal); } catch { break; }
            continue;
          }
          break;
        }
      }
      this.budget.release(reservation, { possiblyBilled: lastCls === FAILURE.TIMEOUT || lastCls === FAILURE.DEADLINE });
      attempts.push({ provider: step.provider, model, class: lastCls, reason: redact(lastMsg, this.env).slice(0, 300), ms: Date.now() - t0, tries });
      if (stop) {
        const e = new GenerationError(lastCls, `${task}: ${step.provider} ${lastCls === FAILURE.CONTENT_POLICY ? "refused the request on content policy; not retried elsewhere" : "stopped the route"}`, { provider: step.provider });
        e.attempts = attempts; e.request = meta; throw e;
      }
    }
    const e = new GenerationError(FAILURE.UNKNOWN, `${task}: every provider in the route failed`);
    e.attempts = attempts; e.request = meta; throw e;
  }
}
