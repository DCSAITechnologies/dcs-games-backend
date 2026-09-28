// GAMES-C companion — optional model-assist seam.
//
// A model may PROPOSE ops when the deterministic grammar did not understand an
// utterance. Its output is untrusted data: it is parsed with JSON.parse (never
// eval / Function / import), checked against a strict closed schema, scanned for
// code/URLs/paths, and must then pass the patch module's validatePatch(). If no
// validator is supplied the proposal is rejected (fail closed). The model can
// never emit replace_asset (the only op that may carry a URI).
import { CATEGORIES, SET_PATHS, LIMITS } from "./lexicon.mjs";
import { isUnsafeString, cleanFreeText } from "./safety.mjs";

export const LLM_OP_KINDS = ["set", "add", "remove", "update", "move"];
const LLM_COLLECTIONS = ["zones", "structures", "npcs", "items", "quests", "behaviors", "interactions", "assets"];
const OP_KEYS = {
  set: ["op", "path", "value"],
  add: ["op", "collection", "value"],
  remove: ["op", "collection", "id"],
  update: ["op", "collection", "id", "set"],
  move: ["op", "collection", "id", "position"],
};
const ID_RE = /^[a-z0-9_]{1,64}$/;
const KEY_RE = /^[a-z_][a-z0-9_]{0,40}$/;
const BANNED_KEYS = new Set(["__proto__", "constructor", "prototype", "owner_id", "script", "uri", "url", "href", "src"]);
export const MAX_PROPOSAL_BYTES = 16384;
export const LLM_CONFIDENCE_CAP = 0.6;

function scanValue(v, path, errors, depth = 0) {
  if (depth > 6) { errors.push(`${path}: nested too deep`); return; }
  if (v === null || typeof v === "boolean") return;
  if (typeof v === "number") { if (!Number.isFinite(v) || Math.abs(v) > 1e6) errors.push(`${path}: number out of range`); return; }
  if (typeof v === "string") {
    if (v.length > 200) errors.push(`${path}: string too long`);
    if (isUnsafeString(v)) errors.push(`${path}: unsafe string`);
    return;
  }
  if (Array.isArray(v)) { if (v.length > 64) errors.push(`${path}: array too long`); v.forEach((x, i) => scanValue(x, `${path}[${i}]`, errors, depth + 1)); return; }
  if (typeof v === "object") {
    if (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) { errors.push(`${path}: not a plain object`); return; }
    const keys = Object.keys(v);
    if (keys.length > 48) errors.push(`${path}: too many keys`);
    for (const k of keys) {
      if (BANNED_KEYS.has(k) || !KEY_RE.test(k)) { errors.push(`${path}.${k}: key not permitted`); continue; }
      scanValue(v[k], `${path}.${k}`, errors, depth + 1);
    }
    return;
  }
  errors.push(`${path}: unsupported type ${typeof v}`);
}

/**
 * Structural validation of a model proposal. Pure; never throws.
 * @returns {{ok:true, proposal:{category, ops, summary, confidence}} | {ok:false, errors:string[]}}
 */
export function validateProposal(raw) {
  const errors = [];
  let obj = raw;
  if (typeof raw === "string") {
    if (raw.length > MAX_PROPOSAL_BYTES) return { ok: false, errors: ["proposal too large"] };
    try { obj = JSON.parse(raw); } catch { return { ok: false, errors: ["proposal is not JSON"] }; }
  } else {
    // Round-trip through JSON: drops functions/symbols/prototypes the adapter may have attached.
    try {
      const s = JSON.stringify(raw);
      if (typeof s !== "string" || s.length > MAX_PROPOSAL_BYTES) return { ok: false, errors: ["proposal too large or not serialisable"] };
      obj = JSON.parse(s);
    } catch { return { ok: false, errors: ["proposal not serialisable"] }; }
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return { ok: false, errors: ["proposal must be an object"] };
  for (const k of Object.keys(obj)) if (!["category", "ops", "summary", "confidence"].includes(k)) errors.push(`unexpected key '${k}'`);
  if (!CATEGORIES.includes(obj.category)) errors.push("category not recognised");
  if (!Array.isArray(obj.ops) || obj.ops.length < 1 || obj.ops.length > LIMITS.MAX_OPS) errors.push(`ops must be an array of 1..${LIMITS.MAX_OPS}`);
  const setPaths = new Set(Object.values(SET_PATHS));
  (Array.isArray(obj.ops) ? obj.ops : []).forEach((op, i) => {
    const p = `ops[${i}]`;
    if (!op || typeof op !== "object" || Array.isArray(op)) { errors.push(`${p}: not an object`); return; }
    if (!LLM_OP_KINDS.includes(op.op)) { errors.push(`${p}: op '${op.op}' not permitted from a model`); return; }
    const keys = Object.keys(op);
    for (const k of keys) if (!OP_KEYS[op.op].includes(k)) errors.push(`${p}: unexpected key '${k}'`);
    for (const k of OP_KEYS[op.op]) if (!(k in op)) errors.push(`${p}: missing '${k}'`);
    if (op.op === "set") {
      if (!setPaths.has(op.path)) errors.push(`${p}: path '${op.path}' not permitted`);
      if (!["string", "number", "boolean"].includes(typeof op.value)) errors.push(`${p}: set value must be a scalar`);
    } else {
      if (!LLM_COLLECTIONS.includes(op.collection)) errors.push(`${p}: collection not permitted`);
      if (op.op !== "add" && !ID_RE.test(String(op.id))) errors.push(`${p}: bad id`);
      if (op.op === "add" && (!op.value || typeof op.value !== "object" || !ID_RE.test(String(op.value.id)))) errors.push(`${p}: add needs value.id`);
      if (op.op === "move") {
        const q = op.position;
        if (!q || typeof q !== "object" || !["x", "y", "z"].every((a) => Number.isFinite(q[a]) && Math.abs(q[a]) <= LIMITS.WORLD_COORD_LIMIT)) errors.push(`${p}: bad position`);
      }
      if (op.op === "update" && (!op.set || typeof op.set !== "object" || Array.isArray(op.set))) errors.push(`${p}: update needs a set object`);
    }
    scanValue(op, p, errors);
  });
  const summary = cleanFreeText(typeof obj.summary === "string" ? obj.summary : "", 200);
  if (typeof obj.summary === "string" && isUnsafeString(obj.summary)) errors.push("summary: unsafe string");
  if (errors.length) return { ok: false, errors: errors.slice(0, 20) };
  const confidence = Math.min(LLM_CONFIDENCE_CAP, Number.isFinite(obj.confidence) ? Math.max(0, obj.confidence) : 0.5);
  return { ok: true, proposal: { category: obj.category, ops: obj.ops, summary: summary || "model-proposed edit", confidence } };
}

/** What a model adapter is given: a closed vocabulary + entity labels. No raw manifest. */
export function llmContextFor(manifest, capabilities) {
  const ents = [];
  for (const c of ["structures", "npcs", "zones", "items", "quests"]) for (const e of manifest?.[c] || []) {
    if (ents.length >= 50) break;
    ents.push({ collection: c, id: e.id, label: String(e.name || e.purpose || e.title || e.id).slice(0, 60) });
  }
  return { categories: [...CATEGORIES], op_kinds: [...LLM_OP_KINDS], set_paths: Object.values(SET_PATHS), capabilities, entities: ents };
}

export async function withTimeout(promise, ms) {
  let t;
  try {
    return await Promise.race([Promise.resolve(promise), new Promise((_, rej) => { t = setTimeout(() => rej(new Error("llm_timeout")), ms); })]);
  } finally { clearTimeout(t); }
}
