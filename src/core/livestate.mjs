// B2 — reading what players actually hold in a world, from stored data.
//
// `POST /v3/worlds/:id/rollback` is supposed to guarantee that going back a
// version cannot cost a player anything. It decided what players held from a
// `live_state` object supplied in the REQUEST BODY, so a caller that simply
// omitted the field got `emptyLiveState()` and the guarantee evaporated for
// five of the six categories in `HOLDS`. The protection was opt-in by the very
// caller it protects against.
//
// This module is the server's own answer to the same question. It reads the
// durable stores this estate actually has and reports, per category, whether it
// could determine the answer.
//
// THE RULE THAT GOVERNS EVERY LINE HERE:
//
//   "I could not check" is NOT "nothing is held".
//
// Treating an unreachable source as an empty result is exactly how a rollback
// deletes a player's house. So a source that throws, a world the runtime store
// has never heard of, and a category with no source at all are all reported as
// UNDETERMINED, never as an empty array that a caller would read as safety.
//
// The second rule: never invent a hold. Every id returned here came out of a
// stored row. Where a category has no store on this estate today, the seam is
// declared and a null implementation reports UNAVAILABLE, following the
// convention `src/core/verification.mjs` set for having no delivery provider —
// `status()` returns AVAILABLE/UNAVAILABLE and the null path refuses rather
// than pretending.
//
// ---------------------------------------------------------------------------
// WHAT EXISTS ON THIS ESTATE TODAY (measured, 6 Sep 2026)
//
//   owned_entity_ids       CW5 runtime state: snapshot `objects[].owner_id`.
//                          `object_id` is the same id as a v3 manifest
//                          `structures[].id` (migrate.mjs maps
//                          `objects[].object_id -> structures[].id`), so the
//                          ids line up with the manifest a rollback compares.
//                          AVAILABLE when a persistence engine is injected.
//
//   inventory_item_ids     CW5 runtime state: snapshot `inventories`
//                          (player_id -> [{item_id, qty}]), written by the
//                          `set_inventory` op. `item_id` is the same id as a v3
//                          manifest `items[].id` (migrate.mjs maps
//                          `items[].item_id -> items[].id`).
//                          AVAILABLE when a persistence engine is injected.
//
//   companion_memory_refs  The companion store (`.dcs-data/companions`), one
//                          JSON file per (principal, world), `memories[].refs`.
//                          This IS where companion memory lives, so the source
//                          is complete. AVAILABLE.
//
//   visited_zone_ids       PARTIAL, and only partial. The single record of a
//                          player being anywhere is the companion's `last_zone`
//                          — written by the companion `context` action. It is
//                          one zone, for players who adopted a companion. Every
//                          id it yields is real; the set is not the whole set,
//                          so the category is reported as not determined.
//
//   completed_quest_ids    NO SOURCE. Nothing on this estate records a quest
//                          completion: no route, no table, no world-memory
//                          kind. `nullQuestProgressSource()` reports
//                          UNAVAILABLE, and the category comes back unknown.
//
//   known_npc_ids          NO SOURCE. Nothing records that a player has met an
//                          NPC. CW5 `npc_states` records an NPC's own runtime
//                          state, which is not evidence a player met it, and
//                          reading it as such would be inventing a hold.
//                          `nullNpcAcquaintanceSource()` reports UNAVAILABLE.
//
// Two further honest caveats, because they change what this can promise:
//
//   * With no SUPABASE_URL/SERVICE_ROLE_KEY, `server.mts` builds CW5 on
//     `InMemoryPersistenceStore`, so the runtime state this reads is
//     process-local and does not survive a restart. `describe()` cannot see
//     which store it was handed, so it says so as a caveat rather than as a
//     claim about the store.
//   * Only `POST /worlds/generate` calls `persistence.registerBaseWorld()`.
//     Worlds created through the v3 stack have no base world registered, so
//     `persistence.load()` throws for them. That is reported as unknown, which
//     is the whole point: it is precisely the case where an empty result would
//     be a lie.
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Errors } from "./errors.mjs";
import { emptyLiveState } from "../v3/expansion/delta.mjs";

/**
 * The six ways live state can hold an entity. Deliberately derived from
 * `emptyLiveState()` rather than restated, so this file cannot drift out of
 * step with the shape `planRollback` reads.
 */
export const CATEGORIES = Object.freeze(Object.keys(emptyLiveState()));

/** How completely a source covers a category, and whether it can be read now. */
export const COVERAGE = Object.freeze({ AVAILABLE: "AVAILABLE", PARTIAL: "PARTIAL", UNAVAILABLE: "UNAVAILABLE" });

/**
 * ------------------------------------------------------------------ THE SEAM
 *
 * A LIVE STATE SOURCE. Every store that can substantiate a hold implements it,
 * and every category that has no store gets a null implementation of it rather
 * than a fabricated one.
 *
 * @typedef {Object} LiveStateSource
 * @property {string} name
 *   Stable identifier, reported in the coverage so a reader can tell which
 *   store an id came from.
 * @property {Record<string, "AVAILABLE"|"PARTIAL">} covers
 *   The categories this source speaks for, and how completely. AVAILABLE means
 *   "if a hold of this kind exists, it is in here". PARTIAL means "everything I
 *   return is real, but I am not the whole picture" — the category is then
 *   never reported as determined.
 * @property {() => "AVAILABLE"|"UNAVAILABLE"} status
 *   Whether this source can be read at all right now. A source that is not
 *   configured says UNAVAILABLE instead of returning nothing.
 * @property {(worldId: string) => Promise<Record<string, string[]>>} read
 *   The ids it can substantiate for this world, keyed by category.
 *
 *   CONTRACT: `read` returns an empty array for a category ONLY when it
 *   genuinely looked and found nothing. If it cannot look — the store is
 *   unreachable, the world is not in it, the query failed — it MUST THROW.
 *   Throwing is how a source says "unknown"; returning empty is how it says
 *   "nothing is held", and a rollback acts on that difference.
 */

// ------------------------------------------------------- CW5 runtime state

/**
 * Player-placed objects and player inventories, from the CW5 persistence
 * engine's materialised snapshot.
 *
 * The engine is INJECTED rather than imported: `src/cw5/*.ts` uses TypeScript
 * parameter properties, which Node's strip-only type support refuses, so a
 * static import here would make this module unloadable outside tsx. Injection
 * also means a test can hand in a store that fails, which is the case that
 * matters most.
 *
 * @param {{persistence: {load: (worldId: string) => Promise<object>}}} deps
 * @returns {LiveStateSource}
 */
export function cw5RuntimeStateSource({ persistence = null } = {}) {
  return {
    name: "cw5-runtime-state",
    covers: { owned_entity_ids: COVERAGE.AVAILABLE, inventory_item_ids: COVERAGE.AVAILABLE },
    status: () => (persistence && typeof persistence.load === "function" ? COVERAGE.AVAILABLE : COVERAGE.UNAVAILABLE),
    async read(worldId) {
      if (this.status() !== COVERAGE.AVAILABLE) {
        throw Errors.notConfigured("the CW5 persistence engine (no runtime state can be read, so what players hold is unknown)");
      }
      // Anything this throws — a world with no registered base, a Supabase
      // outage, a malformed snapshot — reaches the caller as "unknown". It is
      // never flattened into an empty hold set.
      const snap = await persistence.load(worldId);
      if (!snap || typeof snap !== "object") {
        throw Errors.upstream("cw5-persistence", `load('${worldId}') returned no snapshot`);
      }

      const owned = [];
      for (const o of Array.isArray(snap.objects) ? snap.objects : []) {
        // owner_id null is the world owning it, which is not a player hold.
        if (o && typeof o.object_id === "string" && o.object_id && o.owner_id) owned.push(o.object_id);
      }

      const inventory = [];
      const inventories = snap.inventories && typeof snap.inventories === "object" ? snap.inventories : {};
      for (const items of Object.values(inventories)) {
        for (const it of Array.isArray(items) ? items : []) {
          // A row with qty 0 is a held slot that has been emptied, not a held
          // item. Counting it would refuse a rollback over something nobody has.
          if (it && typeof it.item_id === "string" && it.item_id && Number(it.qty ?? 0) > 0) inventory.push(it.item_id);
        }
      }

      return { owned_entity_ids: owned, inventory_item_ids: inventory };
    },
  };
}

// -------------------------------------------------------- companion memory

/**
 * What a player's companion remembers, and the last zone it saw them in.
 *
 * Read straight off the companion store's directory because
 * `src/v3/companion/companion.mjs` has no "every companion in this world" read
 * path — its whole API is keyed by (principal, world) and a rollback does not
 * know which principals have played. The service exposes `dir` deliberately, as
 * `verification.mjs` does, and this only ever reads.
 *
 * @param {{companions: {dir: string}}} deps
 * @returns {LiveStateSource}
 */
export function companionMemorySource({ companions = null, dir = null } = {}) {
  const root = dir || companions?.dir || null;
  return {
    name: "companion-store",
    covers: {
      // The companion store IS companion memory, so for that category it is complete.
      companion_memory_refs: COVERAGE.AVAILABLE,
      // `last_zone` is one zone per companion, recorded only when the client
      // sends a `context` update. Real, and nowhere near the whole set.
      visited_zone_ids: COVERAGE.PARTIAL,
    },
    status: () => (root ? COVERAGE.AVAILABLE : COVERAGE.UNAVAILABLE),
    async read(worldId) {
      if (this.status() !== COVERAGE.AVAILABLE) {
        throw Errors.notConfigured("the companion store (no companion memory can be read, so what companions hold is unknown)");
      }
      let names;
      try {
        names = await fsp.readdir(root);
      } catch (e) {
        // ENOENT here means the companion service has never been constructed in
        // this deployment — not that nobody has a companion. Unknown, not empty.
        throw Errors.upstream("companion-store", `cannot list ${root}: ${e.code || e.message}`);
      }

      const refs = [];
      const zones = [];
      for (const name of names) {
        // The store writes `<key>.json` via a `.json.tmp-xxxx` rename, so a
        // crash can leave a partial temp file behind. Only finished files count.
        if (!name.endsWith(".json")) continue;
        let key;
        try { key = decodeURIComponent(name.slice(0, -".json".length)); } catch { continue; }
        const sep = key.lastIndexOf("::");
        if (sep < 0) continue;
        if (key.slice(sep + 2) !== String(worldId)) continue;

        let rec;
        try {
          rec = JSON.parse(await fsp.readFile(path.join(root, name), "utf8"));
        } catch (e) {
          // A companion file that exists and cannot be read is a hold we cannot
          // see. Refusing to guess is the point of this module.
          throw Errors.upstream("companion-store", `cannot read ${name}: ${e.code || e.message}`);
        }

        for (const m of Array.isArray(rec?.memories) ? rec.memories : []) {
          for (const r of Array.isArray(m?.refs) ? m.refs : []) {
            if (typeof r === "string" && r) refs.push(r);
          }
        }
        if (typeof rec?.last_zone === "string" && rec.last_zone) zones.push(rec.last_zone);
      }

      return { companion_memory_refs: refs, visited_zone_ids: zones };
    },
  };
}

// ------------------------------------------------------------ null sources

/**
 * A declared seam with nothing behind it yet.
 *
 * This is the honest shape for a category that has no store on this estate: the
 * interface exists, the status is UNAVAILABLE, and `read` REFUSES. It does not
 * return an empty set, because an empty set from here would be read as "no
 * player has finished a quest" when the truth is "nobody has ever written one
 * down". Same discipline as `verification.mjs` with no delivery provider.
 */
function nullSource({ name, covers, what }) {
  return {
    name,
    covers,
    status: () => COVERAGE.UNAVAILABLE,
    async read() {
      throw Errors.notConfigured(what);
    },
  };
}

/**
 * completed_quest_ids has no durable source on this estate.
 *
 * WHAT WOULD FILL IT: a store of (world_id, principal_id, quest_id, completed_at)
 * rows written when a quest's last step is satisfied, or a `player_event` in
 * `world-memory.mjs` carrying `detail.completed_quest_id`. Either one can be
 * dropped in here as a real `LiveStateSource` with
 * `covers: { completed_quest_ids: "AVAILABLE" }` and nothing else changes.
 *
 * @returns {LiveStateSource}
 */
export function nullQuestProgressSource() {
  return nullSource({
    name: "quest-progress:none",
    covers: { completed_quest_ids: COVERAGE.UNAVAILABLE },
    what: "a quest-progress store (nothing on this estate records a quest completion, so completed quests cannot be checked)",
  });
}

/**
 * known_npc_ids has no durable source on this estate.
 *
 * WHAT WOULD FILL IT: rows of (world_id, principal_id, npc_id, first_met_at)
 * written when dialogue is opened, or a `player_event` carrying `detail.met_npc_id`.
 * CW5 `npc_states` is NOT that: it is the NPC's own runtime state, and reading
 * it as acquaintance would be inventing a hold.
 *
 * @returns {LiveStateSource}
 */
export function nullNpcAcquaintanceSource() {
  return nullSource({
    name: "npc-acquaintance:none",
    covers: { known_npc_ids: COVERAGE.UNAVAILABLE },
    what: "an NPC-acquaintance store (nothing on this estate records that a player has met an NPC, so known NPCs cannot be checked)",
  });
}

// ---------------------------------------------------------------- the service

/**
 * Read player-held state for a world from the real stores.
 *
 * @param {object} deps
 * @param {{load:Function}} [deps.persistence]  CW5 persistence engine
 * @param {{dir:string}}    [deps.companions]   companion service
 * @param {LiveStateSource[]} [deps.sources]    override the source list entirely (tests)
 */
export function createLiveStateService({ persistence = null, companions = null, sources = null } = {}) {
  const list = sources || [
    cw5RuntimeStateSource({ persistence }),
    companionMemorySource({ companions }),
    nullQuestProgressSource(),
    nullNpcAcquaintanceSource(),
  ];

  /** The best coverage any source claims for a category, before anything is read. */
  function bestCoverage(category) {
    let best = COVERAGE.UNAVAILABLE;
    let by = null;
    for (const s of list) {
      const c = s.covers?.[category];
      if (!c || c === COVERAGE.UNAVAILABLE) continue;
      if (s.status() !== COVERAGE.AVAILABLE) continue;
      if (c === COVERAGE.AVAILABLE) return { coverage: c, source: s.name };
      if (best === COVERAGE.UNAVAILABLE) { best = c; by = s.name; }
    }
    return { coverage: best, source: by };
  }

  const svc = {
    sources: list,

    /**
     * What this service can and cannot determine, before it is asked about any
     * particular world. Shaped like `verification.describe()` so /health can
     * say plainly which of the six protections are actually in force.
     */
    describe() {
      const categories = {};
      for (const c of CATEGORIES) {
        const { coverage, source } = bestCoverage(c);
        categories[c] = { coverage, source };
      }
      const missing = CATEGORIES.filter((c) => categories[c].coverage === COVERAGE.UNAVAILABLE);
      const partial = CATEGORIES.filter((c) => categories[c].coverage === COVERAGE.PARTIAL);
      return {
        sources: list.map((s) => ({ name: s.name, status: s.status(), covers: s.covers })),
        categories,
        // Said in words, because a rollback response quotes it and a reader must
        // not mistake "checked what it could" for "checked everything".
        note: missing.length || partial.length
          ? `A rollback cannot be fully guaranteed against live state yet. No durable source: ${missing.join(", ") || "none"}. Incomplete source: ${partial.join(", ") || "none"}.`
          : "Every category of player-held state has a durable source and can be checked.",
        caveat: "CW5 runtime state is only as durable as the store server.mts was configured with; without SUPABASE_URL it is process-memory and does not survive a restart.",
      };
    },

    /**
     * Everything this world's players are recorded as holding.
     *
     * Safe to call for a world with no recorded activity: every source that can
     * be read reports empty, and the result says so as `nothing_held: true`
     * rather than leaving a caller to infer it from empty arrays it cannot
     * distinguish from silence.
     *
     * @returns {Promise<{
     *   world_id: string,
     *   live_state: object,       exactly `emptyLiveState()`'s shape — hand this to planRollback
     *   coverage: object,         per category: status, source, count, reason
     *   determined: string[],     categories checked completely
     *   undetermined: Array<{category:string,status:string,reason:string}>,
     *   complete: boolean,        every category determined
     *   nothing_held: boolean,    complete AND every category empty
     *   note: string
     * }>}
     */
    async liveStateFor(worldId) {
      if (!worldId || typeof worldId !== "string") throw Errors.validation("reading live state needs a world id");

      const live = emptyLiveState();
      // Per category: how completely it was covered, and why not, if not.
      const coverage = Object.fromEntries(CATEGORIES.map((c) => [c, {
        status: COVERAGE.UNAVAILABLE,
        sources: [],
        count: 0,
        reason: "no source on this estate covers this category",
      }]));

      // A category is only ever determined if EVERY source claiming to cover it
      // could actually be read. One store answering does not make up for
      // another one that did not — the silent one may be holding the house.
      const failed = {};

      for (const source of list) {
        const covered = Object.entries(source.covers || {}).filter(([, v]) => v && v !== COVERAGE.UNAVAILABLE);
        if (!covered.length) {
          // A declared-but-empty seam. Its reason is still worth reporting.
          for (const c of Object.keys(source.covers || {})) {
            if (!CATEGORIES.includes(c)) continue;
            coverage[c].reason = await reasonFor(source);
          }
          continue;
        }
        if (source.status() !== COVERAGE.AVAILABLE) {
          const why = await reasonFor(source);
          for (const [c] of covered) {
            if (!CATEGORIES.includes(c)) continue;
            coverage[c].reason = why;
            failed[c] = why;
          }
          continue;
        }

        let rows;
        try {
          rows = await source.read(worldId);
        } catch (e) {
          // THE LOAD-BEARING LINE. A source that failed leaves its categories
          // undetermined; it never contributes an empty array that a caller
          // would read as "nothing is held".
          for (const [c] of covered) {
            if (!CATEGORIES.includes(c)) continue;
            coverage[c].reason = `${source.name}: ${e?.detail || e?.message || String(e)}`;
            failed[c] = coverage[c].reason;
          }
          continue;
        }

        for (const [c, howComplete] of covered) {
          if (!CATEGORIES.includes(c)) continue;
          const ids = (rows?.[c] || []).filter((x) => typeof x === "string" && x);
          for (const id of ids) if (!live[c].includes(id)) live[c].push(id);
          const cov = coverage[c];
          cov.sources.push(source.name);
          cov.count = live[c].length;
          // AVAILABLE only survives if every contributing source is complete.
          cov.status = cov.status === COVERAGE.UNAVAILABLE
            ? howComplete
            : (cov.status === COVERAGE.AVAILABLE && howComplete === COVERAGE.AVAILABLE ? COVERAGE.AVAILABLE : COVERAGE.PARTIAL);
          cov.reason = howComplete === COVERAGE.AVAILABLE
            ? null
            : `${source.name} records only part of this: everything it returned is real, but it is not the whole set`;
        }
      }

      // Apply the rule: any covering source that could not be read costs the
      // category its AVAILABLE status, however well the others answered.
      for (const c of CATEGORIES) {
        if (!failed[c] || coverage[c].status === COVERAGE.UNAVAILABLE) continue;
        coverage[c].status = coverage[c].sources.length ? COVERAGE.PARTIAL : COVERAGE.UNAVAILABLE;
        coverage[c].reason = failed[c];
      }

      const determined = CATEGORIES.filter((c) => coverage[c].status === COVERAGE.AVAILABLE);
      const undetermined = CATEGORIES
        .filter((c) => coverage[c].status !== COVERAGE.AVAILABLE)
        .map((c) => ({ category: c, status: coverage[c].status, reason: coverage[c].reason, ids_found: coverage[c].count }));
      const complete = undetermined.length === 0;
      const total = CATEGORIES.reduce((n, c) => n + live[c].length, 0);

      return {
        world_id: worldId,
        live_state: live,
        coverage,
        determined,
        undetermined,
        complete,
        // The distinction the whole module exists for: this is true only when
        // every category was checked completely AND all of them came back empty.
        nothing_held: complete && total === 0,
        held_total: total,
        note: complete
          ? (total === 0
            ? "Every category of player-held state was checked and nothing is held in this world."
            : `Every category was checked. ${total} held entity reference(s) found.`)
          : `${determined.length} of ${CATEGORIES.length} categories were checked completely. ` +
            `NOT determined: ${undetermined.map((u) => `${u.category} (${u.reason})`).join("; ")}. ` +
            "An undetermined category is not evidence that nothing is held there.",
      };
    },
  };

  return svc;
}

/** Why a source cannot be read, in the source's own words. */
async function reasonFor(source) {
  try {
    await source.read("_status_probe_");
    return `${source.name}: reports UNAVAILABLE`;
  } catch (e) {
    return `${source.name}: ${e?.detail || e?.message || String(e)}`;
  }
}

/**
 * Fold caller-supplied live state into what the server determined for itself.
 *
 * ADDITIVE, in one direction only. A client may tell the server about a hold
 * the server cannot see — that makes a rollback MORE likely to be refused,
 * which is the safe direction and is genuinely useful while
 * `completed_quest_ids` and `known_npc_ids` have no store. A client can never
 * remove a hold the server found, never replace a category, and never opt out
 * by omission, because the base is the server's own result and only unions
 * happen to it.
 *
 * Unknown keys are ignored rather than merged: `planRollback` reads a fixed set
 * of six, and silently accepting a seventh would let a caller believe it had
 * declared something that nothing reads.
 *
 * @param {object} base    live state the server determined (emptyLiveState shape)
 * @param {object} [extra] client-supplied evidence
 * @returns {{live_state: object, added: Record<string,string[]>, ignored_keys: string[]}}
 */
export function mergeLiveState(base, extra = null) {
  const out = emptyLiveState();
  for (const c of CATEGORIES) {
    const from = base?.[c];
    if (Array.isArray(from)) for (const id of from) if (typeof id === "string" && id && !out[c].includes(id)) out[c].push(id);
  }
  const added = {};
  const ignored = [];
  if (extra && typeof extra === "object" && !Array.isArray(extra)) {
    for (const [key, value] of Object.entries(extra)) {
      if (!CATEGORIES.includes(key)) { ignored.push(key); continue; }
      if (!Array.isArray(value)) { ignored.push(key); continue; }
      for (const id of value) {
        if (typeof id !== "string" || !id) continue;
        if (out[key].includes(id)) continue;
        out[key].push(id);
        (added[key] = added[key] || []).push(id);
      }
    }
  }
  return { live_state: out, added, ignored_keys: ignored };
}

/** Present only so a caller can prove the directory it was handed exists. */
export function companionStoreExists(dir) {
  try { return !!dir && fs.statSync(dir).isDirectory(); } catch { return false; }
}
