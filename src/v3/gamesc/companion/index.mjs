// GAMES-C companion — natural-language chat editing → structured patches.
//
//   interpret(text, manifest, {context})            sync, deterministic, offline
//   interpretWithAssist(text, manifest, {...})      async; optional llmPropose seam
//   buildPatch(result, manifest, {...})             wrap ops in the GAMES-C patch envelope
//   createCompanionSession({context})               stateful convenience wrapper
//   toContext / fromContext / emptyContext          plain-JSON rolling context
//
// The companion NEVER executes anything. It produces typed data ops (see
// docs/games-c/CONTRACT.md); the patch module validates and applies them.
import crypto from "node:crypto";
import { CATEGORIES, CAPABILITIES, CLAUSE_VERBS, LIMITS, SET_PATHS } from "./lexicon.mjs";
import { screenInput } from "./safety.mjs";
import { HANDLERS } from "./intents.mjs";
import { emptyContext, fromContext, toContext, advanceContext, CONTEXT_VERSION } from "./context.mjs";
import { validateProposal, llmContextFor, withTimeout, LLM_CONFIDENCE_CAP } from "./llm-seam.mjs";

// The patch module (agent 3) owns hashing/validation. Loaded optionally so the
// companion still works (rules only, local envelope) if it is absent.
let patchMod = null;
try { patchMod = await import("../patch/index.mjs"); } catch { patchMod = null; }
export const patchModuleAvailable = () => !!patchMod;

export { CATEGORIES, CAPABILITIES, LIMITS, SET_PATHS, emptyContext, fromContext, toContext, CONTEXT_VERSION, validateProposal };

// ------------------------------------------------------------ utterance → clauses
const LEAD = /^\s*(?:(?:hey|hi|ok|okay|so|um|uh)\b[\s,]*(?:companion|buddy|there)?[\s,]*|please\s+|pls\s+|kindly\s+|(?:can|could|would|will) you(?: please)?\s+|i (?:want|need|would like|'d like) you to\s+|i'd like you to\s+|let'?s\s+|go ahead and\s+|just\s+|also\s+|then\s+|and\s+)/i;
const TRAIL = /(?:\s+(?:please|pls|for me|thanks|thank you|now|right now))+\s*$|[\s.!?]+$/i;

function tidy(s) {
  let t = s.trim(), prev;
  do { prev = t; t = t.replace(LEAD, "").replace(TRAIL, "").trim(); } while (t !== prev);
  return t;
}

const VERB_START = new RegExp(`^(?:please\\s+|also\\s+|then\\s+)*(?:${CLAUSE_VERBS.join("|")})\\b`, "i");
/** Split on and/then/,/;/. only where the next part starts with a verb — "near the castle and the tower" stays whole. */
export function splitClauses(text) {
  const delim = /\s*(?:,\s*(?:and\s+)?(?:then\s+)?|;\s*|\.(?!\d)\s*|\s+and then\s+|\s+then\s+|\s+and also\s+|\s+also\s+|\s+and\s+|\s+plus\s+)/gi;
  const cuts = [0];
  let m;
  while ((m = delim.exec(text))) {
    const after = text.slice(m.index + m[0].length);
    if (after && VERB_START.test(after)) cuts.push(m.index, m.index + m[0].length);
    if (m[0].length === 0) delim.lastIndex++;
  }
  cuts.push(text.length);
  const parts = [];
  for (let i = 0; i < cuts.length; i += 2) parts.push(text.slice(cuts[i], cuts[i + 1]));
  return parts.map(tidy).filter(Boolean);
}

function unsupported(text, reasons = ["not_understood"]) {
  return {
    status: "unsupported", category: null, categories: [], ops: [], confidence: 0,
    summary: `I can't do "${String(text).slice(0, 80)}" yet.`,
    clarification: null, reasons,
    capabilities: CAPABILITIES,
  };
}

/**
 * Interpret one utterance against a manifest. Pure and deterministic: the same
 * (text, manifest, context) always yields the same result.
 *
 * @returns {{status:"ok"|"clarify"|"unsupported"|"rejected", category:string|null, categories:string[],
 *   ops:object[], summary:string, confidence:number, clarification:string|null, options?:object[],
 *   capabilities?:object[], reasons?:string[], notes:string[], clauses:object[], source:"rules", context:object}}
 */
export function interpret(text, manifest, { context = null } = {}) {
  const ctx = fromContext(context);
  const finish = (res) => {
    const entities = res.status === "ok" ? res._entities : null;
    delete res._entities;
    res.notes = res.notes || [];
    res.clauses = res.clauses || [];
    res.source = res.source || "rules";
    res.context = advanceContext(ctx, { text: res.status === "rejected" ? "[rejected input]" : String(text ?? ""), status: res.status, categories: res.categories || [], summary: res.summary, entities });
    return res;
  };

  const screen = screenInput(text);
  if (!screen.ok) {
    return finish({
      status: "rejected", category: null, categories: [], ops: [], confidence: 0, clarification: null,
      summary: "I can only make world edits described in plain words — no code, links, file paths or instructions to ignore my rules.",
      reasons: screen.reasons,
    });
  }
  if (!manifest || typeof manifest !== "object") return finish({ ...unsupported(text, ["no_manifest"]), summary: "There is no world loaded to edit." });

  const original = tidy(screen.text);
  const clauses = splitClauses(original);
  if (!clauses.length) return finish(unsupported(text, ["empty"]));
  if (clauses.length > LIMITS.MAX_CLAUSES) {
    return finish({ status: "clarify", category: null, categories: [], ops: [], confidence: 0.5, summary: "too many edits at once",
      clarification: `That's ${clauses.length} changes in one go. Please split it up (at most ${LIMITS.MAX_CLAUSES} per message).` });
  }

  const st = {
    manifest,
    pending: [],
    positions: new Map(),
    usedIds: new Set(),
    lastEntities: ctx.last_entities.map((e) => ({ ...e })),
    expandedOnce: false,
  };

  const done = [];
  for (const orig of clauses) {
    const c = { orig, lc: orig.toLowerCase() };
    if (c.lc.length !== c.orig.length) c.orig = c.lc;          // keep slice offsets aligned
    let out = null, handler = null;
    for (const [name, fn] of HANDLERS) {
      out = fn(c, st);
      if (out) { handler = name; break; }
    }
    if (!out) { done.push({ text: orig, status: "unsupported" }); continue; }
    if (out.clarify) { done.push({ text: orig, status: "clarify", handler, clarification: out.clarify, options: out.options }); continue; }
    done.push({ text: orig, status: "ok", handler, ...out });
    if (out.entities?.length) st.lastEntities = out.entities.map((e) => ({ ...e }));
  }

  const ok = done.filter((d) => d.status === "ok");
  const clar = done.find((d) => d.status === "clarify");
  const unk = done.filter((d) => d.status === "unsupported");
  const clauseInfo = done.map((d) => ({ text: d.text, status: d.status, handler: d.handler ?? null, category: d.category ?? null }));

  if (clar) {
    return finish({
      status: "clarify", category: clar.category ?? null, categories: [], ops: [], confidence: 0.5, clauses: clauseInfo,
      summary: "need clarification", clarification: done.length > 1 ? `About "${clar.text}": ${clar.clarification}` : clar.clarification,
      ...(clar.options ? { options: clar.options } : {}),
    });
  }
  if (unk.length && !ok.length) return finish({ ...unsupported(text), clauses: clauseInfo });
  if (unk.length) {
    return finish({
      status: "clarify", category: null, categories: [], ops: [], confidence: 0.4, clauses: clauseInfo,
      summary: "partly understood",
      clarification: `I understood "${ok.map((d) => d.text).join('" and "')}" (${ok.map((d) => d.summary).join("; ")}), but I don't understand "${unk.map((d) => d.text).join('", "')}". Should I go ahead with just the part I understood?`,
      capabilities: CAPABILITIES,
    });
  }

  const ops = ok.flatMap((d) => d.ops);
  if (!ops.length) return finish({ ...unsupported(text, ["no_ops"]), clauses: clauseInfo });
  if (ops.length > LIMITS.MAX_OPS) {
    return finish({ status: "clarify", category: ok[0].category, categories: [], ops: [], confidence: 0.4, clauses: clauseInfo, summary: "edit too large",
      clarification: `That edit needs ${ops.length} changes; the limit is ${LIMITS.MAX_OPS} per patch. Please split it into smaller requests.` });
  }
  const categories = [...new Set(ok.map((d) => d.category))];
  const lastWithEntities = [...ok].reverse().find((d) => d.entities?.length);
  return finish({
    status: "ok",
    category: categories[0],
    categories,
    ops,
    summary: ok.map((d) => d.summary).join("; "),
    confidence: Math.min(...ok.map((d) => d.confidence ?? 0.8)),
    clarification: null,
    notes: ok.flatMap((d) => d.notes || []),
    clamped: ok.some((d) => d.clamped),
    clauses: clauseInfo,
    _entities: lastWithEntities ? lastWithEntities.entities : null,
  });
}

// ------------------------------------------------------------ patch envelope
function canonicalJSONLocal(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJSONLocal).join(",")}]`;
  return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonicalJSONLocal(v[k])}`).join(",")}}`;
}
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

/**
 * Wrap an "ok" interpretation in the GAMES-C patch envelope (CONTRACT.md).
 * Pass the patch module's hashManifest/canonicalJSON so base_hash matches what
 * applyPatch checks; the local fallback is sorted-key JSON + sha256.
 */
export function buildPatch(result, manifest, { text = null, author = { kind: "companion", id: "companion" }, now = null, hashManifest = null } = {}) {
  if (!result || result.status !== "ok" || !Array.isArray(result.ops) || !result.ops.length) return null;
  const ops = JSON.parse(JSON.stringify(result.ops));
  const intentText = String(text ?? result.clauses?.map((c) => c.text).join("; ") ?? "").slice(0, 500);
  const intent = { text: intentText, category: result.category };
  const created_at = now || new Date().toISOString();
  if (patchMod?.createPatch && !hashManifest) return patchMod.createPatch({ manifest, ops, author, intent, created_at });
  // Fallback envelope (patch module absent). base_hash here is NOT guaranteed to
  // match the patch module's hashManifest, which excludes volatile fields.
  const base_hash = hashManifest ? hashManifest(manifest) : `sha256:${sha256(canonicalJSONLocal(manifest))}`;
  const body = { patch_version: "1", world_id: manifest.world_id, base_version: manifest.world_version, base_hash, author, intent, created_at, ops };
  return { patch_id: `p_${sha256(canonicalJSONLocal(body)).slice(0, 24)}`, ...body };
}

// ------------------------------------------------------------ model-assist seam
/**
 * Rules first. Only if the rules answer "unsupported" AND an llmPropose adapter
 * is injected does a model get a say — and its proposal must pass
 * validateProposal() AND the patch module's validatePatch(). Default: no model.
 *
 * @param {{context?, llmPropose?:(text:string, ctx:object)=>Promise<any>, validatePatch?:Function,
 *          hashManifest?:Function, timeoutMs?:number}} opts
 */
export async function interpretWithAssist(text, manifest, opts = {}) {
  const base = interpret(text, manifest, { context: opts.context });
  const { llmPropose, validatePatch = patchMod?.validatePatch, timeoutMs = 4000 } = opts;
  if (base.status !== "unsupported" || typeof llmPropose !== "function") return { ...base, llm: { used: false } };
  if (typeof validatePatch !== "function") return { ...base, llm: { used: false, reason: "no_validator_fail_closed" } };

  let raw;
  try { raw = await withTimeout(llmPropose(String(text).slice(0, LIMITS.MAX_INPUT_CHARS), llmContextFor(manifest, CAPABILITIES)), timeoutMs); }
  catch (e) { return { ...base, llm: { used: true, accepted: false, reasons: [e?.message === "llm_timeout" ? "timeout" : "adapter_error"] } }; }

  const v = validateProposal(raw);
  if (!v.ok) return { ...base, llm: { used: true, accepted: false, reasons: v.errors } };
  const candidate = { status: "ok", category: v.proposal.category, categories: [v.proposal.category], ops: v.proposal.ops, summary: v.proposal.summary, confidence: v.proposal.confidence, clauses: [{ text: String(text).slice(0, 200), status: "ok", handler: "llm_assist", category: v.proposal.category }] };
  const patch = buildPatch(candidate, manifest, { text, hashManifest: opts.hashManifest, now: "1970-01-01T00:00:00.000Z" });
  let pv;
  try { pv = validatePatch(patch, manifest); } catch { pv = { ok: false, errors: [{ message: "validator threw" }] }; }
  if (!pv?.ok) return { ...base, llm: { used: true, accepted: false, reasons: (pv?.errors || []).slice(0, 10).map((e) => e.message || String(e)) } };

  const ctx = fromContext(opts.context);
  return {
    ...candidate,
    clarification: null, notes: ["proposed by model assist; confirm before applying"], source: "llm_assist",
    requires_confirmation: true, confidence: Math.min(LLM_CONFIDENCE_CAP, candidate.confidence),
    llm: { used: true, accepted: true },
    context: advanceContext(ctx, { text: String(text), status: "ok", categories: candidate.categories, summary: candidate.summary }),
  };
}

// ------------------------------------------------------------ session wrapper
export function createCompanionSession({ context = null } = {}) {
  let ctx = fromContext(context);
  return {
    interpret(text, manifest) {
      const r = interpret(text, manifest, { context: ctx });
      ctx = r.context;
      return r;
    },
    async interpretWithAssist(text, manifest, opts = {}) {
      const r = await interpretWithAssist(text, manifest, { ...opts, context: ctx });
      ctx = r.context;
      return r;
    },
    toContext() { return toContext(ctx); },
    reset() { ctx = emptyContext(); },
  };
}

/** Honest capability listing for UIs and the unsupported response. */
export function capabilities() {
  return { categories: [...CATEGORIES], examples: CAPABILITIES, limits: { ...LIMITS }, set_paths: { ...SET_PATHS } };
}
