// GAMES-A — controlled real-provider benchmark.
//
// Hard limits, enforced here rather than trusted to the caller:
//   · at most MAX_CALLS_PER_PAIR (3) calls per provider/model/task, default 1
//   · sequential only — no concurrency, no loops beyond the fixed plan
//   · a total USD cap enforced by a BudgetLedger (default $5); cheapest calls run first
//   · a provider is dropped for the rest of the run after an AUTH failure or
//     after 2 failures of any kind
//   · each call targets ONE provider with no fallback, so what is measured is that provider
// The plan is computed without a network; nothing is sent unless run() is called
// with live: true.
import { TASK } from "./task-classes.mjs";
import { ROUTING_MATRIX } from "./routing.mjs";
import { GenerationEngine } from "./engine.mjs";
import { BudgetLedger } from "./budget.mjs";
import { HealthRegistry } from "./health.mjs";
import { FAILURE } from "./failures.mjs";
import { offline } from "../providers/contract.mjs";

export const MAX_CALLS_PER_PAIR = 3;
export const MAX_FAILURES_PER_PROVIDER = 2;

const WORLD = {
  zones: [
    { id: "harbour", name: "Harbour", kind: "district", bounds: [0, 0, 120, 80] },
    { id: "cliff_top", name: "Cliff Top", kind: "landmark", bounds: [120, 0, 200, 80] },
  ],
  structures: [
    { id: "tavern", zone: "harbour", archetype: "tavern", enterable: true },
    { id: "chapel", zone: "cliff_top", archetype: "chapel", enterable: true },
    { id: "lift", zone: "cliff_top", archetype: "elevator", enterable: true },
  ],
  npcs: [{ id: "keeper", role: "tavern keeper", behavior: "vendor" }, { id: "gull_warden", role: "guard", behavior: "guard" }],
  items: [{ id: "cellar_key" }],
};

export const BENCH_REQUESTS = Object.freeze({
  WORLD_DESIGN: { prompt: "Ashfall Harbour, a rainy nordic port town where the tide has stopped", seed: 42 },
  GAMEPLAY_LOGIC: { prompt: "make the harbour feel alive and a little dangerous", genre: "adventure", ...WORLD },
  FAST_ITERATION: { prompt: "a rainy nordic port town where the tide has stopped", title: "Ashfall Harbour", zones: WORLD.zones },
  CODE_GENERATION: { prompt: "a lift between the harbour and the cliff-top chapel, and a tavern cellar door the keeper's key unlocks", ...WORLD },
  IMAGE_ASSET: { prompt: "key art: a rain-soaked nordic harbour at dusk, stranded boats on a tide that has stopped", style: "painterly, muted teal and amber" },
  TEXTURE: { prompt: "wet dark cobblestone street", material: "cobblestone" },
  CHARACTER: { prompt: "weathered harbourmaster in an oilskin coat, lantern at the belt", style: "stylised realism" },
  SPATIAL_3D: { prompt: "a small foggy harbour town on a cliff, wooden piers, a stone chapel on the headland", title: "Ashfall Harbour bench" },
  VIDEO_CINEMATIC: { prompt: "slow establishing drone flyover of a rainy nordic harbour at dusk", durationS: 4, aspectRatio: "16:9" },
  VOICE_AUDIO: { text: "Tide's been still for nine days. Nobody leaves Ashfall until it turns." },
});

/** Every distinct external provider/model in the routing matrix, per task. */
export function planBenchmark({ adapters, env, calls = 1, tasks = Object.values(TASK), providers = null } = {}) {
  const n = Math.max(1, Math.min(MAX_CALLS_PER_PAIR, Math.floor(Number(calls) || 1)));
  const rows = [];
  for (const task of tasks) {
    const seen = new Set();
    for (const step of ROUTING_MATRIX[task]) {
      const a = adapters[step.provider];
      if (!a || a.isLocal) continue;
      if (providers && !providers.includes(step.provider)) continue;
      const model = step.model || a.defaultModel(task);
      const key = `${step.provider}:${model}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const req = BENCH_REQUESTS[task];
      rows.push({
        task, provider: step.provider, model, calls: n,
        configured: !offline(env) && a.configured(env) ? "yes" : "no",
        est_usd_per_call: +(a.estimateUsd(task, model, req) || 0).toFixed(4),
      });
    }
  }
  rows.sort((x, y) => x.est_usd_per_call - y.est_usd_per_call);
  return rows;
}

/** Structural quality, 0–5. Honest about what it is: a machine check, not a human review. */
export function structuralQuality(task, res) {
  const a = res.assets?.[0];
  if (!a) return 0;
  const j = a.json;
  const ids = (xs) => new Set((xs || []).map((x) => x.id));
  switch (task) {
    case TASK.WORLD_DESIGN: {
      if (!j) return 0;
      const all = new Set([...ids(j.zones), ...ids(j.structures), ...ids(j.npcs), ...ids(j.items)]);
      const steps = (j.quests || []).flatMap((q) => q.steps || []);
      return [j.zones?.length >= 3, j.structures?.length >= 8, j.npcs?.length >= 5, j.quests?.length >= 2,
        steps.length > 0 && steps.every((s) => all.has(s.target))].filter(Boolean).length;
    }
    case TASK.GAMEPLAY_LOGIC: case TASK.CODE_GENERATION: {
      if (!j) return 0;
      const bids = ids(j.behaviors);
      const known = new Set([...ids(WORLD.zones), ...ids(WORLD.structures), ...ids(WORLD.npcs), ...ids(WORLD.items)]);
      const inter = j.interactions || [];
      return [j.behaviors?.length >= 3, new Set((j.behaviors || []).map((b) => b.kind)).size >= 3, inter.length >= 2,
        inter.length > 0 && inter.every((i) => bids.has(i.behavior_ref)), inter.length > 0 && inter.every((i) => known.has(i.target_ref)) ].filter(Boolean).length
        - (task === TASK.CODE_GENERATION && !(j.checks?.length) ? 1 : 0);
    }
    case TASK.FAST_ITERATION:
      return j ? [!!j.genre, Array.isArray(j.tags) && j.tags.length > 0, ["13+", "16+", "18+"].includes(j.maturity), !!j.mood, !!j.summary].filter(Boolean).length : 0;
    default: {
      const bytes = typeof a.uri === "string" && a.uri.startsWith("data:") ? Math.floor(a.uri.length * 0.75) : null;
      return [!!a.uri, !!a.mime, bytes === null || bytes > 10_000, !a.placeholder, !!a.content_sha256].filter(Boolean).length;
    }
  }
}

/**
 * Run the plan. `live` must be true for anything to be sent; the CLI also
 * requires DCS_BENCH_CONFIRM=1 before passing it.
 */
export async function runBenchmark({ adapters, env, plan, live = false, maxUsd = 5, fetchImpl, logger, onRow = () => {} }) {
  if (!live) return plan.map((p) => ({ ...p, success: "NOT_RUN", latency_ms: "", quality: "", cost_usd: "", failure: "", notes: p.configured === "yes" ? "planned" : "no credential in this environment" }));
  const budget = new BudgetLedger({ perRequestUsd: Math.min(maxUsd, 2.5), perWorldUsd: maxUsd, perDayUsd: maxUsd });
  const health = new HealthRegistry({ failureThreshold: MAX_FAILURES_PER_PROVIDER, cooldownMs: 24 * 3600_000 });
  const failures = new Map();
  const out = [];
  for (const p of plan) {
    for (let i = 0; i < p.calls; i++) {
      const base = { ...p, call: i + 1 };
      if (p.configured !== "yes") { out.push(row(base, "SKIPPED", { notes: "no credential in this environment" })); break; }
      if ((failures.get(p.provider) || 0) >= MAX_FAILURES_PER_PROVIDER) { out.push(row(base, "SKIPPED", { notes: `provider dropped after ${MAX_FAILURES_PER_PROVIDER} failures` })); break; }
      const engine = new GenerationEngine({ adapters, env, budget, health, fetchImpl, logger, maxRetries: 0, routes: { [p.task]: [{ provider: p.provider, model: p.model }] } });
      const t0 = Date.now();
      try {
        const res = await engine.run(p.task, { ...BENCH_REQUESTS[p.task], worldId: "games-a-benchmark" });
        out.push(row(base, "YES", { latency_ms: Date.now() - t0, quality: `${Math.max(0, structuralQuality(p.task, res))}/5`, cost_usd: res.cost_usd, notes: `${res.provenance.cost_basis} cost; asset ${res.assets[0].asset_id}` }));
      } catch (e) {
        const cls = e.attempts?.at(-1)?.class || e.failureClass || FAILURE.UNKNOWN;
        if (cls !== FAILURE.BUDGET_EXCEEDED) failures.set(p.provider, (failures.get(p.provider) || 0) + (cls === FAILURE.AUTH ? MAX_FAILURES_PER_PROVIDER : 1));
        out.push(row(base, cls === FAILURE.BUDGET_EXCEEDED ? "SKIPPED" : "NO", { latency_ms: Date.now() - t0, failure: cls, notes: (e.attempts?.at(-1)?.reason || e.message || "").slice(0, 160) }));
        if (cls === FAILURE.BUDGET_EXCEEDED) break;
      }
      onRow(out.at(-1));
    }
  }
  return out;
}

function row(p, success, extra) {
  return { ...p, success, latency_ms: "", quality: "", cost_usd: "", failure: "", notes: "", ...extra };
}
