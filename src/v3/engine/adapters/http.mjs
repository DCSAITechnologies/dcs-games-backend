// GAMES-A — shared HTTP plumbing for external adapters.
//
// Every request goes through jsonRequest(), which turns transport and HTTP
// failures into classified GenerationErrors and never lets a credential reach
// an error message: bodies are redacted before they are quoted.
import { GenerationError, FAILURE, classifyHttp } from "../failures.mjs";
import { redact } from "../redact.mjs";

/** First non-empty value among env var NAMES. The value is never logged. */
export function keyFrom(env, names) {
  for (const n of names) { const v = env?.[n]; if (typeof v === "string" && v.trim()) return v.trim(); }
  return "";
}

export async function jsonRequest(call, provider, url, { method = "POST", headers = {}, body, raw = false } = {}) {
  let r;
  try {
    r = await call.fetch(url, {
      method,
      headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: call.signal,
    });
  } catch (e) {
    if (e?.name === "TimeoutError" || e?.name === "AbortError") throw e;
    throw new GenerationError(FAILURE.NETWORK, `${provider}: request failed: ${redact(e?.message || e, call.env)}`, { provider });
  }
  if (!r.ok) {
    const text = redact(await r.text().catch(() => ""), call.env).slice(0, 240);
    const ra = Number(r.headers?.get?.("retry-after"));
    throw new GenerationError(classifyHttp(r.status, text), `${provider}: HTTP ${r.status} ${text}`, { provider, status: r.status, retryAfterMs: Number.isFinite(ra) && ra > 0 ? ra * 1000 : null });
  }
  if (raw) return r;
  try { return await r.json(); } catch { throw new GenerationError(FAILURE.INVALID_OUTPUT, `${provider}: response was not JSON`, { provider }); }
}

/**
 * Poll an async job until it finishes. `check` returns {done, result} or
 * {failed, reason}. Bounded by the call's signal and by maxPolls, so a job that
 * never finishes cannot hold a slot forever.
 */
export async function pollJob(call, provider, check, { intervalMs = 4000, maxPolls = 150 } = {}) {
  for (let i = 0; i < maxPolls; i++) {
    const s = await check();
    if (s.done) return s.result;
    if (s.failed) throw new GenerationError(/polic|safety|moderat/i.test(s.reason || "") ? FAILURE.CONTENT_POLICY : FAILURE.JOB_FAILED, `${provider}: job failed: ${redact(s.reason || "unknown", call.env)}`, { provider });
    await call.sleep(intervalMs, call.signal);
  }
  throw new GenerationError(FAILURE.TIMEOUT, `${provider}: job did not finish after ${maxPolls} polls`, { provider });
}

/** Parse the JSON a text task asked for; a non-object answer is INVALID_OUTPUT. */
export function requireJsonObject(provider, text, parse) {
  const j = parse(text);
  if (!j || typeof j !== "object" || Array.isArray(j)) throw new GenerationError(FAILURE.INVALID_OUTPUT, `${provider}: response was not a usable JSON object`, { provider });
  return j;
}
