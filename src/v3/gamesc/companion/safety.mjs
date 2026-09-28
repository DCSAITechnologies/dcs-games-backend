// GAMES-C companion — input safety.
//
// The companion turns words into DATA ops. It never runs code, never fetches,
// never follows instructions embedded in the utterance. Anything that looks like
// an attempt to smuggle code, markup, URLs, file paths or meta-instructions is
// rejected outright: no partial parse, no ops.
import { LIMITS } from "./lexicon.mjs";

const UNSAFE_PATTERNS = [
  ["prompt_injection", /\b(ignore|disregard|forget|override|bypass)\b[^.]{0,40}\b(previous|prior|above|earlier|all|your|the|system)\b[^.]{0,30}\b(instructions?|prompts?|rules?|messages?|context|guidelines?)\b/i],
  ["prompt_injection", /\b(system prompt|developer mode|jailbreak|you are now|act as (an? )?(admin|root|developer|system)|new instructions?)\b/i],
  ["markup", /<\s*\/?\s*(script|iframe|img|svg|object|embed|style|link|meta|a|body|html)\b/i],
  ["markup", /\bon(error|load|click|mouseover|focus)\s*=/i],
  ["url", /\b(javascript|vbscript|data|file|blob|about)\s*:/i],
  ["url", /\b(https?|ftp|wss?):\/\//i],
  ["url", /\bwww\.[a-z0-9-]+\.[a-z]{2,}/i],
  ["url", /\b[a-z0-9-]+\.(com|net|org|io|ai|dev|app|xyz|ru|cn)(\/|\b)/i],
  ["file_path", /(^|[\s"'(])(\.{1,2}\/|~\/|\/(etc|usr|var|tmp|home|root|bin|proc|Users|dev)\b)/],
  ["file_path", /\b[a-z]:\\/i],
  ["file_path", /\.\.[\\/]/],
  ["code", /\b(eval|Function|require|import|fetch|setTimeout|setInterval|XMLHttpRequest|exec|spawn)\s*\(/],
  ["code", /\b(process\.env|child_process|__proto__|constructor\s*\.|prototype\s*\[|globalThis|document\.cookie|window\.)/],
  ["code", /\$\{|`|=>|\bfunction\s*\(|;\s*(rm|curl|wget)\b/],
  ["code", /\b(rm\s+-rf|sudo\s|curl\s|wget\s|drop\s+table|select\s+\*\s+from)\b/i],
  ["secrets", /\b(api[_ ]?key|secret|password|token|credentials?|private key)\b/i],
];

/**
 * @returns {{ok:true, text:string} | {ok:false, reasons:string[]}}
 */
export function screenInput(raw) {
  if (typeof raw !== "string") return { ok: false, reasons: ["not_text"] };
  // Strip control characters first so they cannot split a pattern.
  const text = raw.replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028\u2029\ufeff]/g, " ").trim();
  if (!text) return { ok: false, reasons: ["empty"] };
  if (text.length > LIMITS.MAX_INPUT_CHARS) return { ok: false, reasons: ["too_long"] };
  const reasons = [];
  for (const [why, re] of UNSAFE_PATTERNS) if (re.test(text) && !reasons.includes(why)) reasons.push(why);
  return reasons.length ? { ok: false, reasons } : { ok: true, text };
}

/** True when a single string value (from anywhere, e.g. a model) is unsafe to put in a manifest. */
export function isUnsafeString(s) {
  if (typeof s !== "string") return false;
  return UNSAFE_PATTERNS.some(([, re]) => re.test(s));
}

/**
 * Free text that lands in the manifest (a world title, a mission title, an NPC
 * name). Only letters, digits, spaces and light punctuation survive; length is
 * capped. Returns null if nothing usable is left.
 */
export function cleanFreeText(s, max = LIMITS.MAX_FREE_TEXT) {
  if (typeof s !== "string") return null;
  const t = s.normalize("NFKC")
    .replace(/[^\p{L}\p{N} '’.,!?&-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["'’]+|["'’.,]+$/g, "")
    .trim()
    .slice(0, max)
    .trim();
  return t.length ? t : null;
}

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const round2 = (v) => Math.round(v * 100) / 100;
