// GAMES-C guard — provider (LLM) output injection.
//
// Model output is untrusted input that happens to arrive from a vendor we pay.
// It can carry: prose around the JSON, a second JSON object, instructions aimed
// at the next model in the chain ("ignore previous instructions"), markup, and
// sheer size. The contract here is STRICT: exactly one JSON value (optionally
// inside one ```json fence), within size/depth limits, matching a declared
// schema, with instruction-shaped strings flagged. Nothing is ever executed.
//
// Note: src/v3/providers/contract.mjs parseJsonLoose() deliberately salvages
// truncated JSON for world generation. That is right for "get a world out of a
// flaky model"; it is wrong for edits/patches, which must be all-or-nothing.
// Companion/patch paths should use extractStrictJson below.
import { parseJsonSafe, checkJsonLimits } from "./asset-limits.mjs";
import { scanForInjection } from "./injection.mjs";
import { scanText as secretsScan } from "./secrets.mjs";

export const MAX_PROVIDER_OUTPUT_BYTES = 256 * 1024;

export const INSTRUCTION_PATTERNS = Object.freeze([
  { code: "ignore_previous", re: /\b(ignore|disregard|forget|override)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all|system)\b[^.\n]{0,20}\b(instructions?|prompts?|rules?|messages?)\b/i },
  { code: "role_hijack", re: /\b(you are now|act as|pretend to be|new instructions?|system prompt|developer mode|jailbreak|DAN mode)\b/i },
  { code: "role_marker", re: /(^|\n)\s*(system|assistant|user)\s*:|<\|?(im_start|im_end|system|endoftext)\|?>|\[\/?INST\]/i },
  { code: "exfiltration", re: /\b(send|post|upload|exfiltrate|leak|reveal|print)\b[^.\n]{0,40}\b(api[_ ]?key|secret|token|password|credentials?|env(ironment)? var)/i },
  { code: "tool_call", re: /\b(run|execute|eval(uate)?)\b[^.\n]{0,20}\b(this|the following)\b[^.\n]{0,20}\b(code|script|command|shell)\b/i },
]);

/**
 * Extract exactly one JSON value. Accepts: raw JSON, or JSON inside ONE
 * ```/```json fence with nothing but whitespace outside it. Anything else
 * (prose preamble, two objects, trailing text) is rejected — no salvage.
 */
export function extractStrictJson(text, { maxBytes = MAX_PROVIDER_OUTPUT_BYTES, ...limits } = {}) {
  if (typeof text !== "string") return { ok: false, code: "not_string", reason: "provider output must be text" };
  if (Buffer.byteLength(text, "utf8") > maxBytes) return { ok: false, code: "too_large", reason: `output exceeds ${maxBytes}B` };
  let body = text.trim();
  const fences = body.match(/```/g) || [];
  if (fences.length) {
    const m = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/.exec(body);
    if (!m || fences.length !== 2) return { ok: false, code: "not_strict", reason: "text outside a single ```json fence" };
    body = m[1].trim();
  }
  if (!/^[[{]/.test(body)) return { ok: false, code: "not_strict", reason: "output does not start with a JSON object/array" };
  const r = parseJsonSafe(body, limits);
  if (!r.ok) return { ok: false, code: r.code === "invalid" ? "not_strict" : r.code, reason: r.reason };
  return { ok: true, value: r.value };
}

/**
 * Minimal schema validator (no deps). Schema language:
 *  {type:"object", required:[..], properties:{k:schema}, additionalProperties:false}
 *  {type:"array", items:schema, maxItems}
 *  {type:"string", maxLength, enum, pattern}
 *  {type:"number"|"integer", minimum, maximum}
 *  {type:"boolean"} | {type:"null"} | {anyOf:[schema]}
 */
export function validateSchema(value, schema, path = "$", errors = []) {
  if (!schema) return errors;
  if (schema.anyOf) {
    if (!schema.anyOf.some((s) => validateSchema(value, s, path, []).length === 0)) errors.push({ path, message: "matches no allowed shape" });
    return errors;
  }
  const t = schema.type;
  const typeOk = t === "array" ? Array.isArray(value)
    : t === "object" ? value !== null && typeof value === "object" && !Array.isArray(value)
    : t === "integer" ? Number.isInteger(value)
    : t === "number" ? typeof value === "number" && Number.isFinite(value)
    : t === "null" ? value === null
    : t ? typeof value === t : true;
  if (!typeOk) { errors.push({ path, message: `expected ${t}` }); return errors; }
  if (t === "string") {
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push({ path, message: `longer than ${schema.maxLength}` });
    if (schema.enum && !schema.enum.includes(value)) errors.push({ path, message: "not an allowed value" });
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push({ path, message: "does not match pattern" });
  }
  if (t === "number" || t === "integer") {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push({ path, message: `< ${schema.minimum}` });
    if (schema.maximum !== undefined && value > schema.maximum) errors.push({ path, message: `> ${schema.maximum}` });
  }
  if (t === "array") {
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push({ path, message: `more than ${schema.maxItems} items` });
    value.forEach((v, i) => validateSchema(v, schema.items, `${path}[${i}]`, errors));
  }
  if (t === "object") {
    for (const k of schema.required || []) if (!(k in value)) errors.push({ path: `${path}.${k}`, message: "is required" });
    for (const [k, v] of Object.entries(value)) {
      const s = schema.properties?.[k];
      if (!s) { if (schema.additionalProperties === false) errors.push({ path: `${path}.${k}`, message: "unexpected property" }); continue; }
      validateSchema(v, s, `${path}.${k}`, errors);
    }
  }
  return errors;
}

/** Flag instruction-shaped strings anywhere in a value. */
export function detectInstructions(value) {
  const hits = [];
  const walk = (v, path) => {
    if (typeof v === "string") { for (const p of INSTRUCTION_PATTERNS) if (p.re.test(v)) hits.push({ path, code: p.code, excerpt: v.slice(0, 80) }); return; }
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${path}[${i}]`));
    if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`);
  };
  walk(value, "$");
  return hits;
}

/**
 * The single entry point for untrusted model output.
 * @returns {{ok, value?, code?, reason?, errors?, flags:[]}}
 *   ok=false when: not strict JSON, too large/deep, schema mismatch, or
 *   (with rejectOnInstructions, default true) instruction/markup injection found.
 */
export function guardProviderOutput(text, schema, { rejectOnInstructions = true, ...opts } = {}) {
  const ex = extractStrictJson(text, opts);
  if (!ex.ok) return { ...ex, flags: [] };
  const lim = checkJsonLimits(ex.value, opts);
  if (!lim.ok) return { ...lim, flags: [] };
  const errors = validateSchema(ex.value, schema);
  if (errors.length) return { ok: false, code: "schema", reason: "output does not match schema", errors, flags: [] };
  const flags = [...detectInstructions(ex.value), ...scanForInjection(ex.value).findings];
  if (flags.length && rejectOnInstructions) return { ok: false, code: "injection", reason: "instruction or markup injection in provider output", flags };
  return { ok: true, value: ex.value, flags };
}

export const MAX_USER_PROMPT_CHARS = 4000;

/**
 * Malicious prompt (user → companion/planner). The prompt is DATA passed to a
 * model, never to an interpreter. This caps size, strips control/bidi chars,
 * flags jailbreak/instruction-override and markup/code shapes, and refuses
 * prompts carrying a credential (so it is never forwarded to a vendor or
 * logged). Flags are returned for the caller to log/deny; hard refusals are
 * size, empty and secret.
 */
export function guardUserPrompt(raw, { maxChars = MAX_USER_PROMPT_CHARS } = {}) {
  if (typeof raw !== "string") return { ok: false, code: "not_string", flags: [] };
  // eslint-disable-next-line no-control-regex
  const text = raw.normalize("NFKC").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f​-‏‪-‮⁦-⁩﻿]/g, "").trim();
  if (!text) return { ok: false, code: "empty", flags: [] };
  if (text.length > maxChars) return { ok: false, code: "too_long", reason: `prompt exceeds ${maxChars} chars`, flags: [] };
  const flags = [...detectInstructions({ prompt: text }), ...scanForInjection({ prompt: text }).findings];
  if (!secretsScan(text).ok) return { ok: false, code: "contains_secret", reason: "prompt contains a credential; refused and not forwarded", flags };
  return { ok: true, text, flags, suspicious: flags.length > 0 };
}
