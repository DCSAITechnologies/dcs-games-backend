// src/cw2/cerebras-client.mjs
// Cerebras inference client (OpenAI-compatible) for CW2 world generation.
// Endpoint: https://api.cerebras.ai/v1/chat/completions  ·  free tier: 30 RPM, ~60-131k TPM, 1M tok/day.
// Exposes a `modelClient` with .complete(messages) -> string, matching the adapter seam in adapter.mjs.
//
// MULTI-KEY: reads CEREBRAS_API_KEY *and* CEREBRAS_API_KEY_1, _2, _3, ... — round-robins across them
// and fails over to the next key on a 429/5xx, so stacking several free keys multiplies the rate limit.
//
// SECURITY: keys are read from process.env only (server-side). NEVER logged, returned, or committed.
// Paste them into Railway Variables. Zero npm deps — uses global fetch (Node 18+).

const BASE = process.env.CEREBRAS_BASE_URL || "https://api.cerebras.ai/v1";
const DEFAULT_MODEL = process.env.CEREBRAS_MODEL || "gpt-oss-120b";

export class RateLimitedError extends Error {
  constructor(retryAfter) { super("cerebras_rate_limited"); this.code = "RATE_LIMITED"; this.retryAfter = retryAfter; }
}

// Collect every Cerebras key from env: CEREBRAS_API_KEY plus CEREBRAS_API_KEY_<n> (any suffix).
export function collectKeys(env = process.env) {
  const keys = [];
  for (const [k, v] of Object.entries(env)) {
    if (/^CEREBRAS_API_KEY(_\d+)?$/.test(k) && v && String(v).trim()) keys.push(String(v).trim());
  }
  return [...new Set(keys)]; // dedupe
}

// makeCerebrasClient({apiKey|apiKeys, model, timeoutMs}) -> { name, model, keyCount, complete(messages, opts) } | null
export function makeCerebrasClient({
  apiKey,
  apiKeys,
  model = DEFAULT_MODEL,
  timeoutMs = Number(process.env.CEREBRAS_TIMEOUT_MS || 14000),
} = {}) {
  const keys = (apiKeys && apiKeys.length) ? apiKeys.filter(Boolean)
    : (apiKey ? [apiKey] : collectKeys());
  if (!keys.length) return null; // no key -> caller keeps the deterministic seeder (honest: no fake AI)

  let cursor = 0; // round-robin starting point across requests

  async function callOnce(key, messages, opts) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(`${BASE}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        signal: ctrl.signal,
        body: JSON.stringify({
          model,
          messages,
          temperature: opts.temperature ?? 0.8,
          max_completion_tokens: opts.maxTokens ?? 1400,
          response_format: { type: "json_object" }, // force strict JSON
        }),
      });
      if (r.status === 429) throw new RateLimitedError(Number(r.headers.get("retry-after")) || undefined);
      if (!r.ok) {
        const err = new Error(`cerebras_http_${r.status}`);
        err.code = "HTTP_" + r.status;
        err.status = r.status;
        err.detail = (await r.text().catch(() => "")).slice(0, 300);
        throw err;
      }
      const data = await r.json();
      const content = data?.choices?.[0]?.message?.content;
      if (!content) throw new Error("cerebras_empty_completion");
      return content;
    } finally {
      clearTimeout(t);
    }
  }

  async function complete(messages, opts = {}) {
    let lastErr;
    // try each key once, starting at the rotating cursor; fail over on 429/5xx
    for (let i = 0; i < keys.length; i++) {
      const key = keys[(cursor + i) % keys.length];
      try {
        const out = await callOnce(key, messages, opts);
        cursor = (cursor + i + 1) % keys.length; // advance so the next request starts on the next key
        return out;
      } catch (e) {
        lastErr = e;
        const retryable = e.code === "RATE_LIMITED" || (e.status && e.status >= 500);
        if (!retryable) break; // a real error (bad request/auth) won't be fixed by another key
      }
    }
    throw lastErr || new Error("cerebras_all_keys_failed");
  }

  return { name: "cerebras:" + model, model, keyCount: keys.length, complete };
}
