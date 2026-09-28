// GAMES-A — failure classification.
//
// Every provider failure is reduced to one class, and the class alone decides
// three things: may this call be retried at the same provider, does it count
// against that provider's health, and may the route fall through to the next
// provider. Deciding those per class, in one place, is what keeps retries safe:
// a request that may already have been billed or executed upstream is never
// silently sent twice.

export const FAILURE = Object.freeze({
  NOT_CONFIGURED: "NOT_CONFIGURED",   // no credential / offline — not a provider fault
  UNSUPPORTED: "UNSUPPORTED",         // adapter does not serve this task
  CIRCUIT_OPEN: "CIRCUIT_OPEN",       // skipped: provider recently unhealthy
  BUDGET_EXCEEDED: "BUDGET_EXCEEDED", // skipped: estimate would exceed a cap
  AUTH: "AUTH",                       // 401/403 — bad or revoked credential
  RATE_LIMITED: "RATE_LIMITED",       // 429 — rejected before execution
  TIMEOUT: "TIMEOUT",                 // may have executed (and billed) upstream
  NETWORK: "NETWORK",                 // connection failed before a response
  UPSTREAM_5XX: "UPSTREAM_5XX",
  BAD_REQUEST: "BAD_REQUEST",         // 400/404/422 — this vendor will not take it
  CONTENT_POLICY: "CONTENT_POLICY",   // vendor refused the content
  INVALID_OUTPUT: "INVALID_OUTPUT",   // answered, but not usable for this task
  JOB_FAILED: "JOB_FAILED",           // async job reported failure
  DEADLINE: "DEADLINE",               // the route's overall deadline ran out
  UNKNOWN: "UNKNOWN",
});

/**
 * retryable       — safe to send the same request to the same provider again.
 *                   Only for rejections that happened BEFORE execution.
 * health          — counts as a provider failure for the circuit breaker.
 * fallthrough     — the next provider in the route may be tried.
 *
 * CONTENT_POLICY does not fall through on purpose. A refusal is a judgement
 * about the request, and walking it down the vendor list until someone agrees
 * is moderation shopping. The engine stops and reports it instead.
 */
const POLICY = {
  NOT_CONFIGURED: { retryable: false, health: false, fallthrough: true },
  UNSUPPORTED: { retryable: false, health: false, fallthrough: true },
  CIRCUIT_OPEN: { retryable: false, health: false, fallthrough: true },
  BUDGET_EXCEEDED: { retryable: false, health: false, fallthrough: true },
  AUTH: { retryable: false, health: true, fallthrough: true },
  RATE_LIMITED: { retryable: true, health: true, fallthrough: true },
  TIMEOUT: { retryable: false, health: true, fallthrough: true },
  NETWORK: { retryable: true, health: true, fallthrough: true },
  UPSTREAM_5XX: { retryable: true, health: true, fallthrough: true },
  BAD_REQUEST: { retryable: false, health: false, fallthrough: true },
  CONTENT_POLICY: { retryable: false, health: false, fallthrough: false },
  INVALID_OUTPUT: { retryable: false, health: true, fallthrough: true },
  JOB_FAILED: { retryable: false, health: true, fallthrough: true },
  DEADLINE: { retryable: false, health: false, fallthrough: false },
  UNKNOWN: { retryable: false, health: true, fallthrough: true },
};

export function failurePolicy(cls) {
  return POLICY[cls] || POLICY.UNKNOWN;
}

/** An error that already knows its class. Adapters throw these. */
export class GenerationError extends Error {
  constructor(cls, message, { provider = null, status = null, retryAfterMs = null, billed = null } = {}) {
    super(message);
    this.name = "GenerationError";
    this.failureClass = FAILURE[cls] ? cls : FAILURE.UNKNOWN;
    this.provider = provider;
    this.upstreamStatus = status;
    this.retryAfterMs = retryAfterMs;
    this.billed = billed;
  }
}

const POLICY_WORDS = /content[_ ]?policy|safety|moderation|blocked|refus|prohibited|not allowed|violat/i;

/** Map an HTTP status (and optional body text) to a failure class. */
export function classifyHttp(status, bodyText = "") {
  if (status === 401 || status === 403) return POLICY_WORDS.test(bodyText) ? FAILURE.CONTENT_POLICY : FAILURE.AUTH;
  if (status === 429) return FAILURE.RATE_LIMITED;
  if (status === 408) return FAILURE.TIMEOUT;
  if (status >= 500) return FAILURE.UPSTREAM_5XX;
  if (status === 400 || status === 422) return POLICY_WORDS.test(bodyText) ? FAILURE.CONTENT_POLICY : FAILURE.BAD_REQUEST;
  if (status >= 400) return FAILURE.BAD_REQUEST;
  return FAILURE.UNKNOWN;
}

/** Reduce anything thrown by an adapter to a class plus its policy. */
export function classify(err) {
  let cls;
  if (err instanceof GenerationError) cls = err.failureClass;
  else if (err?.name === "TimeoutError" || err?.name === "AbortError") cls = FAILURE.TIMEOUT;
  else if (typeof err?.upstreamStatus === "number") cls = classifyHttp(err.upstreamStatus, String(err.message || ""));
  else if (err instanceof TypeError && /fetch failed|network|ECONN|ENOTFOUND|EAI_AGAIN/i.test(String(err.message) + String(err.cause?.code || ""))) cls = FAILURE.NETWORK;
  else cls = FAILURE.UNKNOWN;
  return { class: cls, ...failurePolicy(cls) };
}
