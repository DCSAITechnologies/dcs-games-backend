// Games-B asset provider seam. NODE-ONLY.
//
// Two lanes, both built on the shared `Lane` (src/v3/providers/contract.mjs),
// so the asset stage inherits its guarantees: ranked adapters, a mandatory
// deterministic fallback, and a provenance record for every call.
//
//   image lane  Together FLUX.1-schnell (TOGETHER_API_KEY) → local procedural
//   mesh lane   external text-to-3D (DCS_ASSET3D_URL + _KEY, the same adapter
//               the v3 pipeline uses) → local procedural mesh recipe
//
// Honest status on this machine (28 Sep 2026): neither TOGETHER_API_KEY nor
// DCS_ASSET3D_* is set, so both lanes resolve to the procedural fallback. That
// is the designed path, not an error: every record says FALLBACK and why.
//
// Tests run with DCS_PROVIDERS_OFFLINE=1, where every non-fallback adapter
// reports UNAVAILABLE without touching the network. Adapters can be injected
// (`adapters:`), which is how the tests exercise the AVAILABLE path.

import { Lane, STATUS, LANES, ProviderError, offline } from "../../v3/providers/contract.mjs";
import { externalAsset3dAdapter } from "../../v3/providers/asset3d.mjs";

export const FLUX_SCHNELL_MODEL = "black-forest-labs/FLUX.1-schnell";
// Estimate, not a quote: Together's published FLUX.1-schnell list price was
// about $0.0027 per megapixel (checked Sep 2026). Recorded per image so cost
// accounting is never silently zero for a paid call; re-check before billing.
export const FLUX_SCHNELL_USD_PER_MEGAPIXEL = 0.0027;
export const IMAGE_LANE = "gamesb_image";
export const MESH_LANE = "gamesb_mesh";

const TOGETHER = "https://api.together.xyz/v1";
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

export const estimateFluxCost = (w, h) => Math.round(((w * h) / 1e6) * FLUX_SCHNELL_USD_PER_MEGAPIXEL * 1e6) / 1e6;

export function togetherFluxAdapter(env = process.env, { fetchImpl = globalThis.fetch } = {}) {
  const key = String(env.TOGETHER_API_KEY || "").trim();
  return {
    name: "together",
    lane: LANES.MEDIA,
    rank: 10,
    isFallback: false,
    model: FLUX_SCHNELL_MODEL,
    async status() {
      if (offline(env)) return STATUS.UNAVAILABLE;
      return key ? STATUS.AVAILABLE : STATUS.UNAVAILABLE;
    },
    /** req: { prompt, width, height } → { kind:"image", bytes:Buffer, mime, px_w, px_h, cost_usd } */
    async invoke(req) {
      const w = Math.min(1024, Math.max(256, Math.round((req.width || 512) / 64) * 64));
      const h = Math.min(1024, Math.max(256, Math.round((req.height || 512) / 64) * 64));
      const r = await fetchImpl(TOGETHER + "/images/generations", {
        method: "POST",
        headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
        body: JSON.stringify({ model: FLUX_SCHNELL_MODEL, prompt: req.prompt, width: w, height: h, steps: 4, n: 1, response_format: "b64_json", output_format: "png" }),
        signal: AbortSignal.timeout(120000),
      }).catch((e) => { throw new ProviderError("together", String(e?.message || e)); });
      if (!r.ok) throw new ProviderError("together", `image HTTP ${r.status}`, { status: r.status, retryable: r.status >= 500 || r.status === 429 });
      const j = await r.json();
      const b64 = j?.data?.[0]?.b64_json;
      if (typeof b64 !== "string" || !b64.length) throw new ProviderError("together", "image response carried no b64_json");
      const bytes = Buffer.from(b64, "base64");
      // PNG only: AssetRecord.format has no jpeg, and there is no zero-dependency
      // way to transcode here. A JPEG answer falls through to the procedural path.
      if (!bytes.subarray(0, 4).equals(PNG_SIG)) throw new ProviderError("together", "image bytes are not PNG", { retryable: false });
      const mime = "image/png";
      return { kind: "image", bytes, mime, px_w: w, px_h: h, cost_usd: estimateFluxCost(w, h), cost_estimated: true, _model: FLUX_SCHNELL_MODEL };
    },
  };
}

/** Fallback for the image lane: keep the procedural texture recipe. */
export function proceduralImageAdapter() {
  return {
    name: "local:procedural", lane: LANES.MEDIA, rank: 99, isFallback: true, model: "deterministic",
    async status() { return STATUS.FALLBACK; },
    async invoke(req) { return { kind: "procedural", recipe: req.recipe ?? null, cost_usd: 0, _model: "deterministic" }; },
  };
}

/**
 * External 3D, wrapped so a result carries cost. The provider contract has no
 * price field, so cost is DCS_ASSET3D_COST_USD per asset when set, else 0 and
 * flagged `cost_estimated: false` — unknown, not free.
 */
export function external3dAdapter(env = process.env) {
  const inner = externalAsset3dAdapter(env);
  const perAsset = Number(env.DCS_ASSET3D_COST_USD);
  return {
    ...inner,
    async invoke(req, ctx) {
      const v = await inner.invoke(req, ctx);
      return { ...v, kind: "glb", cost_usd: Number.isFinite(perAsset) ? perAsset : 0, cost_known: Number.isFinite(perAsset) };
    },
  };
}

/** Fallback for the mesh lane: the procedural recipe the caller already built. */
export function proceduralMeshAdapter() {
  return {
    name: "local:procedural-mesh", lane: LANES.ASSET_3D, rank: 99, isFallback: true, model: "deterministic",
    async status() { return STATUS.FALLBACK; },
    async invoke(req) { return { kind: "mesh-recipe", recipe: req.recipe ?? null, cost_usd: 0, _model: "deterministic" }; },
  };
}

export function createImageLane({ env = process.env, adapters = null } = {}) {
  return new Lane(IMAGE_LANE, adapters || [togetherFluxAdapter(env), proceduralImageAdapter()]);
}
export function createMeshLane({ env = process.env, adapters = null } = {}) {
  return new Lane(MESH_LANE, adapters || [external3dAdapter(env), proceduralMeshAdapter()]);
}

/** Names of non-fallback adapters currently reporting AVAILABLE (no invocation). */
export async function availableProviders(lane) {
  const d = await lane.describe();
  return d.adapters.filter((a) => !a.is_fallback && a.status === STATUS.AVAILABLE).map((a) => a.name).sort();
}

/**
 * Run a lane and shape its provenance as a §8 ProvenanceStage.
 * @returns {{ value, stage: {stage, lane, provider, model, status, latency_ms, cost_usd, after_failed?, at} }}
 */
export async function runLane(lane, req, stageName) {
  const { value, provenance } = await lane.run(req);
  const stage = {
    stage: stageName,
    lane: provenance.lane,
    provider: provenance.provider,
    model: provenance.model || "unknown",
    status: provenance.status,
    latency_ms: provenance.latency_ms,
    cost_usd: Number.isFinite(value?.cost_usd) ? value.cost_usd : 0,
    ...(provenance.after_failed ? { after_failed: provenance.after_failed } : {}),
    at: provenance.at,
  };
  return { value, stage };
}
