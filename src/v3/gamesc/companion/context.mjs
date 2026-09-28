// GAMES-C companion — short rolling conversation context.
//
// Plain JSON, no class instances, no functions, no timestamps unless the caller
// supplies them — so the memory agent (src/v3/gamesc/memory) can persist it
// verbatim and a restored context behaves identically.
//
//   { context_version: 1,
//     turns:        [{ text, status, categories, summary }]       // last N, oldest first
//     last_entities:[{ collection, id, label }]                     // what "it"/"them" mean
//     last_category: string|null }
import { LIMITS, CATEGORIES } from "./lexicon.mjs";
import { cleanFreeText } from "./safety.mjs";

export const CONTEXT_VERSION = 1;
const COLLECTIONS = new Set(["structures", "npcs", "zones", "items", "quests", "assets", "behaviors", "interactions"]);

export function emptyContext() {
  return { context_version: CONTEXT_VERSION, turns: [], last_entities: [], last_category: null };
}

const safeId = (s) => typeof s === "string" && /^[A-Za-z0-9_.:-]{1,120}$/.test(s);

/** Validate + normalise untrusted persisted context. Never throws; bad parts are dropped. */
export function fromContext(raw) {
  const ctx = emptyContext();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return ctx;
  if (Array.isArray(raw.turns)) {
    ctx.turns = raw.turns.filter((t) => t && typeof t === "object").slice(-LIMITS.CONTEXT_TURNS).map((t) => ({
      text: cleanFreeText(String(t.text ?? ""), 200) || "",
      status: ["ok", "clarify", "unsupported", "rejected"].includes(t.status) ? t.status : "unsupported",
      categories: Array.isArray(t.categories) ? t.categories.filter((c) => CATEGORIES.includes(c)) : [],
      summary: cleanFreeText(String(t.summary ?? ""), 200) || "",
    }));
  }
  if (Array.isArray(raw.last_entities)) {
    ctx.last_entities = raw.last_entities
      .filter((e) => e && COLLECTIONS.has(e.collection) && safeId(e.id))
      .slice(0, LIMITS.CONTEXT_ENTITIES)
      .map((e) => ({ collection: e.collection, id: e.id, label: cleanFreeText(String(e.label ?? e.id), 80) || e.id }));
  }
  if (CATEGORIES.includes(raw.last_category)) ctx.last_category = raw.last_category;
  return ctx;
}

/** A deep, plain copy — safe to JSON.stringify and hand to the memory module. */
export function toContext(ctx) {
  return fromContext(JSON.parse(JSON.stringify(ctx || emptyContext())));
}

/** Fold one interpretation into the context. Pure. */
export function advanceContext(ctx, { text, status, categories = [], summary = "", entities = null }) {
  const next = fromContext(ctx);
  next.turns.push({ text: cleanFreeText(text, 200) || "", status, categories, summary: cleanFreeText(summary, 200) || "" });
  next.turns = next.turns.slice(-LIMITS.CONTEXT_TURNS);
  if (entities && entities.length) {
    next.last_entities = entities.slice(0, LIMITS.CONTEXT_ENTITIES).map((e) => ({ collection: e.collection, id: e.id, label: e.label || e.id }));
  }
  if (status === "ok" && categories.length) next.last_category = categories.at(-1);
  return fromContext(next);
}
