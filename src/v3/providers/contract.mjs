// B1 — provider adapter contract. PARENT-OWNED CHOKEPOINT.
//
// Round-2's finding was NOT simply "Cerebras was the problem". The old generator
// never asked a model to build geometry at all — fixed skeletons dominated the
// output — and the whole runtime hard-depended on one vendor. This contract fixes
// the second half: every lane is served by a ranked list of adapters, each of
// which reports AVAILABLE, UNAVAILABLE or FALLBACK, and no lane may hard-depend
// on any single vendor.
//
// A FALLBACK is not a failure. It is a deterministic, offline, always-available
// implementation that produces a real (if plainer) result and says so in
// provenance, so a world is never silently presented as something it is not.

export const STATUS = Object.freeze({
  AVAILABLE: "AVAILABLE",     // configured and reachable
  UNAVAILABLE: "UNAVAILABLE", // configured but failing, or not configured
  FALLBACK: "FALLBACK",       // deterministic local implementation
});

export const LANES = Object.freeze({
  WORLD_ARCHITECT: "world_architect",   // premium reasoning: design, layout, quests, difficulty
  FAST_INFERENCE: "fast_inference",     // cheap text: classification, tags, metadata, validation
  SPATIAL: "spatial",                   // environment / world generation
  ASSET_3D: "asset_3d",                 // buildings, props, characters, creatures, vehicles
  GAMEPLAY: "gameplay",                 // doors, elevators, enemy AI, vehicles, triggers
  MEDIA: "media",                       // images, textures, portraits, voice, narration, video
});

/**
 * @typedef {Object} ProviderAdapter
 * @property {string} name              vendor/implementation id, recorded in provenance
 * @property {string} lane              one of LANES
 * @property {number} rank              lower is preferred
 * @property {boolean} isFallback       true for the deterministic local implementation
 * @property {() => Promise<string>} status   AVAILABLE | UNAVAILABLE | FALLBACK
 * @property {(req:object, ctx:object) => Promise<object>} invoke
 */

export class ProviderError extends Error {
  constructor(provider, message, { retryable = true, status = null } = {}) {
    super(`${provider}: ${message}`);
    this.name = "ProviderError";
    this.provider = provider;
    this.retryable = retryable;
    this.upstreamStatus = status;
  }
}

/** Are external providers disabled for this process? CI and tests run offline. */
export function offline(env = process.env) {
  return env.DCS_PROVIDERS_OFFLINE === "1" || env.NODE_ENV === "test" && env.DCS_PROVIDERS_ONLINE !== "1";
}

/**
 * A lane: a ranked list of adapters with a mandatory fallback at the end.
 * Constructing a lane without a fallback is a programming error — it would
 * reintroduce the single-vendor dependency this whole module exists to remove.
 */
export class Lane {
  constructor(name, adapters) {
    this.name = name;
    this.adapters = [...adapters].sort((a, b) => a.rank - b.rank);
    if (!this.adapters.some((a) => a.isFallback)) {
      throw new Error(`lane '${name}' has no fallback adapter; every lane must work with all vendors down`);
    }
  }

  /** Report each adapter's status without invoking any of them. */
  async describe() {
    const out = [];
    for (const a of this.adapters) {
      out.push({ name: a.name, rank: a.rank, is_fallback: !!a.isFallback, status: await a.status().catch(() => STATUS.UNAVAILABLE) });
    }
    return { lane: this.name, adapters: out };
  }

  /**
   * Try adapters in rank order until one succeeds. Returns the result together
   * with the provenance record that must be attached to the manifest.
   */
  async run(req, ctx = {}) {
    const attempts = [];
    for (const a of this.adapters) {
      let st;
      try { st = await a.status(); } catch { st = STATUS.UNAVAILABLE; }
      if (st === STATUS.UNAVAILABLE) {
        attempts.push({ provider: a.name, status: st, reason: "not available" });
        continue;
      }
      const t0 = Date.now();
      try {
        const value = await a.invoke(req, ctx);
        return {
          value,
          provenance: {
            lane: this.name,
            provider: a.name,
            model: value?._model || a.model || null,
            status: a.isFallback ? STATUS.FALLBACK : STATUS.AVAILABLE,
            at: new Date().toISOString(),
            latency_ms: Date.now() - t0,
            ...(attempts.length ? { after_failed: attempts.map((x) => x.provider) } : {}),
          },
          attempts,
        };
      } catch (e) {
        attempts.push({ provider: a.name, status: STATUS.UNAVAILABLE, reason: String(e?.message || e), ms: Date.now() - t0 });
        console.warn(JSON.stringify({ level: "warn", lane: this.name, provider: a.name, degraded: String(e?.message || e), ts: new Date().toISOString() }));
      }
    }
    // Unreachable in practice: the fallback is deterministic and local. If it
    // does happen, it is a real failure and must not be dressed up as a result.
    const err = new ProviderError(this.name, `every adapter failed: ${attempts.map((a) => a.provider).join(", ")}`, { retryable: false });
    err.attempts = attempts;
    throw err;
  }
}

/** Extract the first JSON object or array from a model response. */
export function parseJsonLoose(text) {
  if (typeof text !== "string") return null;
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = fenced ? fenced[1] : text;
  const start = body.search(/[[{]/);
  if (start < 0) return null;
  // Walk to the matching close so trailing prose does not break the parse.
  const open = body[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < body.length; i++) {
    const c = body[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(body.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  // Never closed: the model hit its token limit mid-object. Observed live on
  // 6 Sep 2026 with a long gameplay response. Salvage the complete prefix
  // rather than discarding a nearly-good answer — a truncated tail costs one
  // behaviour, whereas failing the whole lane costs the whole world.
  return salvageTruncatedJson(body.slice(start));
}

/**
 * Close a truncated JSON document at its last complete element.
 * Returns null when nothing usable survives — it never invents values.
 */
export function salvageTruncatedJson(src) {
  const stack = [];
  let inStr = false, esc = false;
  let lastSafe = -1;          // index just after the last complete element

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === "{" || c === "[") { stack.push(c === "{" ? "}" : "]"); continue; }
    if (c === "}" || c === "]") { stack.pop(); lastSafe = i + 1; continue; }
    if (c === "," && stack.length) lastSafe = i;      // a comma follows a complete element
  }
  if (lastSafe <= 0 || !stack.length) return null;

  let candidate = src.slice(0, lastSafe).replace(/,\s*$/, "");
  // Re-derive the open frames for the truncated candidate and close them.
  const frames = [];
  inStr = false; esc = false;
  for (let i = 0; i < candidate.length; i++) {
    const c = candidate[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") frames.push("}");
    else if (c === "[") frames.push("]");
    else if (c === "}" || c === "]") frames.pop();
  }
  if (inStr) return null;
  try {
    return JSON.parse(candidate + frames.reverse().join(""));
  } catch {
    return null;
  }
}

/** Shared OpenAI-compatible chat call used by several vendors. */
export async function chatCompletion({ baseUrl, apiKey, model, system, user, maxTokens = 4096, temperature = 0.7, timeoutMs = 90000, json = false, providerName }) {
  const body = {
    model,
    messages: [
      ...(system ? [{ role: "system", content: system }] : []),
      { role: "user", content: user },
    ],
    max_tokens: maxTokens,
    temperature,
    ...(json ? { response_format: { type: "json_object" } } : {}),
  };
  let r;
  try {
    r = await fetch(baseUrl.replace(/\/$/, "") + "/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer " + apiKey, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new ProviderError(providerName || model, `request failed: ${e?.message || e}`);
  }
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new ProviderError(providerName || model, `HTTP ${r.status} ${t.slice(0, 200)}`, { retryable: r.status >= 500 || r.status === 429, status: r.status });
  }
  const j = await r.json();
  const text = j?.choices?.[0]?.message?.content;
  if (typeof text !== "string") throw new ProviderError(providerName || model, "response contained no message content");
  return { text, model: j.model || model, usage: j.usage || null };
}
