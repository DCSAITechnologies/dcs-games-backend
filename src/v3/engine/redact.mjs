// GAMES-A — secret redaction for anything the engine logs or records.
//
// Provider error bodies sometimes echo the request, and a request carries an
// Authorization header or a key in its query string. Every string that leaves
// the engine — log lines, attempt reasons, provenance, benchmark rows — goes
// through redact() first.

const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)/i;

const PATTERNS = [
  [/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [REDACTED]"],
  [/\b(sk|rk|pk)-[A-Za-z0-9_-]{12,}/g, "[REDACTED]"],
  [/\bAIza[0-9A-Za-z_-]{20,}/g, "[REDACTED]"],
  [/\b(key|api_key|apikey|access_token|token|x-api-key|x-goog-api-key)=([^&\s"']+)/gi, "$1=[REDACTED]"],
  [/("(?:api[_-]?key|authorization|x-api-key|x-goog-api-key|token|secret)"\s*:\s*")[^"]*(")/gi, "$1[REDACTED]$2"],
];

/**
 * Remove secrets from a string. Values of every secret-named environment
 * variable are replaced by name, then generic credential shapes are masked.
 */
export function redact(input, env = process.env) {
  let s = String(input ?? "");
  for (const [name, value] of Object.entries(env || {})) {
    if (!SECRET_NAME.test(name) || typeof value !== "string") continue;
    const v = value.trim();
    if (v.length >= 8) s = s.split(v).join(`[REDACTED:${name}]`);
  }
  for (const [re, rep] of PATTERNS) s = s.replace(re, rep);
  return s;
}

/** Redact every string inside a JSON-shaped value. */
export function redactDeep(value, env = process.env) {
  if (typeof value === "string") return redact(value, env);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, env));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = /^(authorization|api[_-]?key|x-api-key|token|secret)$/i.test(k) ? "[REDACTED]" : redactDeep(v, env);
    return out;
  }
  return value;
}

/** One structured log line, redacted. Never pass request headers in. */
export function safeLog(level, fields, env = process.env, sink = console) {
  const line = JSON.stringify(redactDeep({ level, component: "generation-engine", ...fields, ts: new Date().toISOString() }, env));
  (level === "error" ? sink.error : level === "warn" ? sink.warn : sink.log).call(sink, line);
}
