// A4 — error honesty. One structured error shape, correlation IDs, no silent swallow.
// Rule enforced by this module: a failure can never be reported as ok:true.
import crypto from "node:crypto";

export function newCorrelationId() {
  return "cid_" + crypto.randomBytes(9).toString("base64url");
}

/** The only error type the API is allowed to emit. */
export class AppError extends Error {
  constructor(code, httpStatus, detail, opts = {}) {
    super(detail || code);
    this.name = "AppError";
    this.code = code;
    this.httpStatus = httpStatus;
    this.detail = detail || code;
    this.retryable = !!opts.retryable;
    this.correlationId = opts.correlationId || newCorrelationId();
    this.meta = opts.meta || null;
    if (opts.cause) this.cause = opts.cause;
  }
  toJSON() {
    return {
      ok: false,
      error: this.code,
      detail: this.detail,
      retryable: this.retryable,
      correlation_id: this.correlationId,
      ...(this.meta ? { meta: this.meta } : {}),
    };
  }
}

export const Errors = {
  unauthenticated: (d = "authentication required", o) => new AppError("unauthenticated", 401, d, o),
  invalidToken: (d = "token could not be verified", o) => new AppError("invalid_token", 401, d, o),
  forbidden: (d = "not permitted", o) => new AppError("forbidden", 403, d, o),
  notFound: (what, o) => new AppError("not_found", 404, `${what} not found`, o),
  conflict: (d, o) => new AppError("conflict", 409, d, o),
  validation: (d, o) => new AppError("validation_failed", 422, d, o),
  notConfigured: (what, o) => new AppError("not_configured", 503, `${what} is not configured`, o),
  upstream: (who, d, o) => new AppError("upstream_failure", 502, `${who}: ${d}`, { ...o, retryable: true }),
  internal: (d, o) => new AppError("server_error", 500, d, o),
};

/**
 * Wrap an operation that MUST NOT be silently swallowed.
 * Logs with the correlation id and rethrows as an AppError.
 */
export async function required(label, fn, correlationId) {
  try {
    return await fn();
  } catch (e) {
    const err = e instanceof AppError ? e : Errors.internal(`${label}: ${e?.message || e}`, { correlationId, cause: e });
    logError(err, label);
    throw err;
  }
}

/**
 * Wrap an operation that is genuinely optional. Unlike a bare try{}catch{},
 * this ALWAYS logs the failure and reports it back to the caller, so a
 * degraded result is visible rather than invisible.
 */
export async function optional(label, fn, correlationId) {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    const detail = String(e?.message || e);
    console.warn(JSON.stringify({ level: "warn", degraded: label, detail, correlation_id: correlationId || null, ts: new Date().toISOString() }));
    return { ok: false, error: detail, degraded: label };
  }
}

export function logError(err, label) {
  console.error(JSON.stringify({
    level: "error",
    label: label || null,
    code: err.code || "unknown",
    status: err.httpStatus || 500,
    detail: err.detail || String(err?.message || err),
    correlation_id: err.correlationId || null,
    ts: new Date().toISOString(),
  }));
}
