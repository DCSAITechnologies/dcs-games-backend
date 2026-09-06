// Lane I — the durable player-progress store the live-state seams were declared for.
//
// `src/core/livestate.mjs` reports two of the six categories in rollback's
// `HOLDS` as having NO SOURCE AT ALL: `completed_quest_ids` and `known_npc_ids`.
// Its null sources REFUSE rather than return empty, which is correct and also
// means the rollback guarantee — "going back a version cannot cost a player
// anything" — is not in force for a finished quest or an NPC someone knows. A
// third, `visited_zone_ids`, has only the companion's single `last_zone`.
//
// This module is the store those seams need. It records, per (principal, world):
// quest completions, NPC acquaintance and visited zones, and it exports source
// adapters that drop straight into `createLiveStateService`.
//
// =============================================================================
// THE DESIGN DECISION THIS MODULE IS ACTUALLY ABOUT
// =============================================================================
//
// A progress store is trivial to build and almost always built wrong. The wrong
// version has one route, `POST /progress { quest_id, completed: true }`, and it
// writes the row. That store is WORSE THAN NOTHING, and not by a small margin:
//
//   1. It launders a claim into evidence. The client said it; the database now
//      says it; every later reader — the rollback planner, the creator
//      dashboard, an NPC citing what a player has done — reads a stored row and
//      has no way to tell it apart from an observation. This estate already
//      decided that question twice: `verification.mjs` refuses to issue a code
//      it cannot deliver, and `world-memory.mjs` lets an NPC cite only a
//      recorded event. A quest store that believes the client breaks both rules
//      at once.
//
//   2. It is now a weapon, because this data GATES DELETION. `heldEntitiesLost`
//      refuses a rollback for any id in `completed_quest_ids`, `known_npc_ids`
//      or `visited_zone_ids`. So a client that can assert progress can assert
//      one id from every collection and permanently freeze a creator's world at
//      its current version. The usual reassurance — "a false positive is the
//      safe direction, it only makes the rollback more conservative" — is
//      FALSE HERE. A false hold is a denial of service against the creator, and
//      a false absence is a deleted quest. Both directions cost somebody
//      something real, so "record it anyway, it is safer" is not available.
//
// So: what can THIS SERVER actually verify today, on the estate as it stands?
//
// -----------------------------------------------------------------------------
// WHAT WAS MEASURED (6 Sep 2026), AND WHAT IT ESTABLISHES
// -----------------------------------------------------------------------------
//
// The world model. `src/v3/expansion/delta.mjs` defines the interaction and
// behaviour model: `interactions[] = {trigger, target_ref, behavior_ref}` wired
// to `behaviors[] = {kind, spec}` (pickup, container, door, teleporter, ...),
// and `quests[].steps[] = {id, kind, target}`. `src/v3/playtest/validators.mjs`
// (`validateQuests`) and the playtest agent (`simulatePlaythrough`,
// `simulateQuests`) establish, rigorously and reproducibly:
//
//     * that a quest EXISTS, and what its steps are;
//     * that each step's target exists and is of the right kind for the step;
//     * that an item required by a `collect` step is obtainable somewhere;
//     * that every step's target is REACHABLE from the spawn.
//
// Every one of those is a fact about the WORLD. Not one of them is a fact about
// a PLAYER. The agent proves a quest is completABLE. It can therefore falsify a
// claim — a quest whose steps target unreachable things cannot have been
// finished by anyone — but it can never substantiate one. Structural
// possibility is not occurrence, and the whole failure mode above is treating
// the first as the second.
//
// So the question becomes: which acts inside a world does the SERVER itself
// perform, such that the record is a log of its own behaviour rather than a
// report from a client? On this estate there are exactly two.
//
//   (A) THE SERVER PLACES THE PLAYER AT THE SPAWN.
//       `POST /v3/worlds/:id/play` records a session. The player does not
//       choose where they arrive: `manifest.spawn.player_spawns[0].zone` does,
//       and the server reads it out of the manifest it holds. "This principal
//       entered this world, and the world put them in zone Z" is the server's
//       own act. Note what this module does NOT do with it: `recordWorldEntry`
//       takes NO zone argument. A client physically cannot influence which zone
//       is written, because there is no parameter through which to try.
//
//   (B) THE SERVER SERVES AN NPC'S DIALOGUE.
//       `GET /v3/worlds/:id/npcs/:npcId/memory` resolves the NPC against the
//       manifest and returns, through `npcMemory.linesFor`, what that NPC can
//       truthfully say. That is a dialogue turn the server conducted on behalf
//       of an authenticated principal with a named NPC. "Someone a player has
//       met" is precisely what that is — and `recordNpcDialogueServed` is
//       handed the ACTUAL `linesFor` payload and checks that it names the same
//       NPC, so the evidence is the artefact the server produced, not a flag
//       the caller set.
//
// And the things that look like evidence and are not:
//
//   * CW5 `inventories`. It is durable, it is the estate's own record, and
//     `livestate.mjs` reads it as AVAILABLE for `inventory_item_ids`. It is
//     still NOT usable as evidence for a `collect` step, because of how it is
//     written: `POST /worlds/:id/save` (server.mts) authenticates the caller
//     and then hands `b.delta` straight to `persistence.save()`, whose
//     `set_inventory` op carries its OWN `player_id` and whose `place_object`
//     op carries its own `owner_id` (src/cw5/cw5_persistence.ts:176, :144).
//     Nothing checks either against the caller, and nothing checks the caller
//     against the world. An inventory row is therefore an unauthenticated
//     assertion about an arbitrary player. Deriving "you collected the amulet"
//     from it would let any authenticated account complete any quest for any
//     other player. Refused, and reported as a defect rather than consumed.
//
//   * The companion's `last_zone`. Written by the companion `context` action
//     from `b.zone` in the request body. It is a client assertion about the
//     client's own position, and `livestate.mjs` is already generous in calling
//     it PARTIAL-but-real. This module does not build on it.
//
//   * CW5 `npc_states`. The NPC's own runtime state. `livestate.mjs` already
//     says reading it as acquaintance would be inventing a hold. Agreed.
//
// -----------------------------------------------------------------------------
// WHAT THIS MODULE THEREFORE DOES, AND REFUSES TO DO
// -----------------------------------------------------------------------------
//
// It records OBSERVATIONS — (A) and (B) above, and nothing else. There is no
// row shape for a claim and no evidence value meaning "the client said so";
// `ACCEPTED_EVIDENCE` is a closed set of two server-performed acts.
//
// A quest completion is never recorded. It is DERIVED, and only when EVERY step
// of the quest, as the manifest defines it, is matched by a stored observation,
// in step order:
//
//     talk  <npc>    -> an NPC-dialogue observation for that npc     [yes]
//     reach <zone>   -> a spawn-placement observation for that zone  [yes, spawn only]
//     reach <structure>                                              [no]
//     collect / deliver / activate / defeat / escort / craft / use   [no]
//
// A quest containing even one unsubstantiable step CANNOT be completed as far
// as this server is concerned, today, and `reconcileQuests` says so by name and
// reason instead of guessing. In practice that means completions are derivable
// for talk-shaped quests and for the `talk` + `reach`-to-spawn-zone opening of
// a procedural quest, and for nothing else. That is a small answer. It is the
// true one, and a small true answer is the only kind that may gate a deletion.
//
// This is why all three source adapters report PARTIAL and never AVAILABLE.
// PARTIAL, in `livestate.mjs`'s contract, means "everything I return is real,
// but I am not the whole picture", and the category is then never reported as
// determined. That is exactly the situation: a rollback is now refused over
// more real holds than before, and it still cannot be GUARANTEED. Saying
// AVAILABLE here would be the same lie in a new place.
//
// WHAT WOULD MAKE COMPLETIONS FULLY VERIFIABLE (not built here, not faked):
// a server-authoritative session — the runtime reporting step satisfaction over
// an authenticated channel the client cannot forge, or CW5 gaining an op whose
// `player_id` is bound to the caller's principal. Until one of those exists,
// this module refuses, out loud, in `recordClientClaim`.
//
// -----------------------------------------------------------------------------
// THE OTHER RULES
// -----------------------------------------------------------------------------
//
//   * Reads follow `livestate.mjs`'s source contract exactly: empty ONLY after
//     genuinely looking and finding nothing; if it cannot look, it THROWS.
//     `status()` is AVAILABLE/UNAVAILABLE, as `verification.mjs` established.
//   * Persistence is `createCollection` — the estate's durable store — never a
//     new persistence layer.
//   * Every mutation goes through `ensure`/`update`, never read-then-insert.
//     `collection.mjs` serialises the WRITE; it does not make a check followed
//     by an insert atomic, and that exact gap produced 128 profile rows for one
//     principal here recently.
//   * A player's progress is that player's. Reads and writes are self-only.
//     The world-scoped read used by rollback returns ENTITY ids and never
//     principal ids, so it cannot be turned into a way to see who played.
import path from "node:path";
import crypto from "node:crypto";
import { Errors } from "./errors.mjs";
import { createCollection } from "./collection.mjs";
import { COVERAGE } from "./livestate.mjs";

/**
 * The closed set of facts this store will record. Each names an act the SERVER
 * performed; there is deliberately no member meaning "a client reported it".
 */
export const EVIDENCE = Object.freeze({
  /** The server placed this principal at the world's spawn, in the spawn's zone. */
  SERVER_SPAWN_PLACEMENT: "server_spawn_placement",
  /** The server served this NPC's dialogue to this principal. */
  SERVER_NPC_DIALOGUE: "server_npc_dialogue",
});

export const ACCEPTED_EVIDENCE = Object.freeze(Object.values(EVIDENCE));

/** Quest step kinds a stored observation can substantiate today. */
export const SUBSTANTIABLE_STEP_KINDS = Object.freeze(["talk", "reach"]);

/**
 * Why a step kind cannot be substantiated. Stated per kind, because "we cannot
 * check this" is a different fact for each one and a caller deserves the real
 * reason rather than a shrug.
 */
const NO_EVIDENCE_FOR = Object.freeze({
  collect: "nothing records that a player picked an item up: CW5 inventories are written by POST /worlds/:id/save, whose set_inventory op names its own player_id and is never checked against the caller, so an inventory row is an unauthenticated assertion about an arbitrary player",
  deliver: "nothing records a hand-over; the server never sees an item change hands",
  activate: "nothing records a player triggering an interaction; behaviours run in the client",
  defeat: "nothing records combat; the server runs no simulation",
  escort: "nothing records an escort; the server does not track a player's position",
  craft: "nothing records crafting; the server never sees the recipe run",
  use: "nothing records an item being used; behaviours run in the client",
});

const UNKNOWN_KIND = "no observation on this estate substantiates a step of this kind";

/** The real reason, per kind, that a step cannot be substantiated. */
function whyNoEvidence(kind) {
  return NO_EVIDENCE_FOR[String(kind || "")] || UNKNOWN_KIND;
}

const WORLD_ID = /^[A-Za-z0-9._:-]{1,200}$/;

function assertWorldId(worldId) {
  if (!worldId || typeof worldId !== "string" || !WORLD_ID.test(worldId)) {
    throw Errors.validation(`unsafe or missing world id: ${String(worldId)}`);
  }
  return worldId;
}

/** The authenticated principal's id, or a refusal. Never a header, never a body field. */
function principalIdOf(p) {
  const id = typeof p === "string" ? p : p?.id;
  if (!id || typeof id !== "string") {
    throw Errors.unauthenticated("player progress needs an authenticated principal");
  }
  return id;
}

/**
 * A player's progress belongs to that player.
 *
 * `subjectId` exists so a route that carries a player id in its body or path is
 * REFUSED loudly rather than silently recording against the wrong principal.
 * There is no operator override: nothing on this estate needs one, and an
 * override is how self-only checks stop being self-only.
 */
function assertSelf(requester, subjectId) {
  const me = principalIdOf(requester);
  if (subjectId !== null && subjectId !== undefined && String(subjectId) !== me) {
    throw Errors.forbidden(
      "a player's progress is readable and writable only by that player",
      { meta: { requested_subject: String(subjectId) } }
    );
  }
  return me;
}

const nowIso = () => new Date().toISOString();

/** Stable fingerprint of the quest definition a completion was derived against. */
function questFingerprint(quest) {
  const shape = (quest?.steps || []).map((s) => `${s?.id}:${s?.kind}:${s?.target}`).join("|");
  return crypto.createHash("sha256").update(`${quest?.id} ${shape}`).digest("hex").slice(0, 32);
}

// ===========================================================================
// THE SERVICE
// ===========================================================================

/**
 * @param {object} [deps]
 * @param {object} [deps.env]           process env (DCS_DATA_DIR)
 * @param {object} [deps.collections]   inject the four collections (tests)
 */
export function createPlayerProgressService({ env = process.env, collections = null } = {}) {
  const dir = path.join(env.DCS_DATA_DIR || path.join(process.cwd(), ".dcs-data"), "player-progress");

  // Construction must not stop the server booting — `verification.mjs` and
  // `livestate.mjs` both report an absent capability instead of throwing at
  // boot. But an unopenable store is UNAVAILABLE, and every read then THROWS,
  // because "I could not look" must never leave here as an empty array.
  let store = null;
  let unavailable = null;
  try {
    store = collections || {
      sessions: createCollection({ dir, name: "playerprogress_sessions", primaryKey: ["world_id", "principal_id"], env }),
      npcs: createCollection({ dir, name: "playerprogress_npc_encounters", primaryKey: ["world_id", "principal_id", "npc_id"], env }),
      zones: createCollection({ dir, name: "playerprogress_zone_visits", primaryKey: ["world_id", "principal_id", "zone_id"], env }),
      quests: createCollection({ dir, name: "playerprogress_quest_completions", primaryKey: ["world_id", "principal_id", "quest_id"], env }),
    };
  } catch (e) {
    unavailable = `player-progress store at ${dir} could not be opened: ${e?.code || e?.message || String(e)}`;
  }

  function requireStore(what) {
    if (unavailable) throw Errors.notConfigured(`${what} (${unavailable})`);
    return store;
  }

  /**
   * Read a collection, converting ANY failure into a throw.
   *
   * `createCollection().all()` returns [] for a store that has never been
   * written (ENOENT), which is a genuine look that found nothing. Everything
   * else — an unreadable directory, corrupt JSON, an injected failure — comes
   * out as an exception and must stay one.
   */
  async function rowsOf(collection, what) {
    try {
      const rows = await collection.all();
      if (!Array.isArray(rows)) throw new Error("collection did not return rows");
      return rows;
    } catch (e) {
      throw Errors.upstream("player-progress", `${what}: ${e?.detail || e?.message || String(e)}`);
    }
  }

  // ---------------------------------------------------------------- writes

  /**
   * Insert-or-touch, atomically, on the collection's own lock.
   *
   * `one()` then `insert()` is the shape that lost records here before: reads
   * are not locked, so every concurrent caller passes the existence check and
   * they all insert. `ensure` closes that window; the follow-up `update` is
   * itself serialised, so the counter cannot lose an increment either.
   */
  async function observe(collection, pred, build) {
    const { row, created } = await collection.ensure(pred, build);
    if (created) return { row, created: true };
    const bumped = await collection.update(pred, (r) => ({
      ...r,
      last_at: nowIso(),
      occurrences: Number(r.occurrences || 1) + 1,
    }));
    return { row: bumped || row, created: false };
  }

  const svc = {
    dir,

    /**
     * Can this store be read and written at all right now?
     * AVAILABLE/UNAVAILABLE, matching `verification.mjs` and the
     * `LiveStateSource` contract in `livestate.mjs`.
     */
    status() {
      return unavailable ? COVERAGE.UNAVAILABLE : COVERAGE.AVAILABLE;
    },

    /** What this store can and cannot substantiate, before it is asked anything. */
    describe() {
      return {
        status: svc.status(),
        dir,
        reason: unavailable,
        accepted_evidence: ACCEPTED_EVIDENCE,
        substantiable_step_kinds: SUBSTANTIABLE_STEP_KINDS,
        unsubstantiable_step_kinds: Object.keys(NO_EVIDENCE_FOR),
        covers: {
          completed_quest_ids: COVERAGE.PARTIAL,
          known_npc_ids: COVERAGE.PARTIAL,
          visited_zone_ids: COVERAGE.PARTIAL,
        },
        note:
          "Every row here is an act the server itself performed: placing a player at a spawn, or serving an NPC's dialogue to them. " +
          "No client claim is recorded, in any mode. A quest completion is DERIVED from those observations and never written on request, " +
          "so a quest with a collect, deliver, activate, defeat, escort, craft or use step cannot be completed as far as this server knows — " +
          "there is no server-side record that those things happened. All three categories are therefore PARTIAL: what is here is real, " +
          "and it is not the whole set.",
        // The one thing a reader must not mistake for a capability.
        cannot_verify:
          "That a player finished a quest, in general. There is no server-authoritative session on this estate: the runtime is the client, " +
          "and CW5's set_inventory op carries an unchecked player_id, so inventory is not evidence either.",
      };
    },

    // ------------------------------------------------------------ OBSERVE (A)

    /**
     * The server placed this principal in this world, at its spawn.
     *
     * Called from the play route. Records the session, and the spawn's zone as
     * a visited zone. There is NO zone parameter: the zone comes out of the
     * manifest the server holds, so a client cannot name one.
     *
     * @param {object} args
     * @param {object|string} args.principal   the AUTHENTICATED principal
     * @param {string} args.worldId
     * @param {object} args.manifest           the world manifest the server served
     * @param {number} [args.worldVersion]
     * @param {string} [args.subjectId]        refused unless it equals the principal
     */
    async recordWorldEntry({ principal, worldId, manifest, worldVersion = null, subjectId = null } = {}) {
      requireStore("recording that a player entered a world");
      const me = assertSelf(principal, subjectId);
      assertWorldId(worldId);
      if (!manifest || typeof manifest !== "object") {
        throw Errors.validation("recording a world entry needs the manifest the server served, so the spawn zone is read from the world rather than from the caller");
      }

      const at = nowIso();
      const session = await observe(
        store.sessions,
        (r) => r.world_id === worldId && r.principal_id === me,
        () => ({
          id: crypto.randomUUID(),
          world_id: worldId,
          principal_id: me,
          first_at: at,
          last_at: at,
          occurrences: 1,
          world_version: worldVersion,
        })
      );

      // The spawn's zone is the world's decision, not the player's. A manifest
      // whose spawn declares no zone yields nothing — reported, not invented.
      const zoneId = manifest?.spawn?.player_spawns?.[0]?.zone ?? null;
      let zone = null;
      let zoneNote = null;
      if (typeof zoneId === "string" && zoneId) {
        const known = (manifest.zones || []).some((z) => z?.id === zoneId);
        if (known) {
          zone = await observe(
            store.zones,
            (r) => r.world_id === worldId && r.principal_id === me && r.zone_id === zoneId,
            () => ({
              id: crypto.randomUUID(),
              world_id: worldId,
              principal_id: me,
              zone_id: zoneId,
              evidence: EVIDENCE.SERVER_SPAWN_PLACEMENT,
              first_at: at,
              last_at: at,
              occurrences: 1,
              world_version: worldVersion,
            })
          );
        } else {
          zoneNote = `the spawn names zone '${zoneId}', which is not a zone in this manifest, so no visit was recorded`;
        }
      } else {
        zoneNote = "this world's spawn declares no zone, so no visited zone could be recorded from entering it";
      }

      return {
        session: session.row,
        first_entry: session.created,
        zone_recorded: zone ? zone.row.zone_id : null,
        zone_note: zoneNote,
      };
    },

    // ------------------------------------------------------------ OBSERVE (B)

    /**
     * The server served this NPC's dialogue to this principal.
     *
     * `lines` is the payload `npcMemory.linesFor()` actually returned. It is
     * checked, not trusted as a flag: it must name the same NPC. That is the
     * difference between recording what the server did and recording what a
     * caller said the server did.
     *
     * A session in this world is required first. Without it, the NPC-memory
     * route — a GET over a public manifest — would let anyone "meet" every NPC
     * in a world they have never entered, and each of those ids would then
     * refuse the creator's rollback.
     */
    async recordNpcDialogueServed({ principal, worldId, npcId, manifest, lines = null, worldVersion = null, subjectId = null } = {}) {
      requireStore("recording that a player met an NPC");
      const me = assertSelf(principal, subjectId);
      assertWorldId(worldId);
      if (!npcId || typeof npcId !== "string") throw Errors.validation("an NPC id is required");
      if (!manifest || typeof manifest !== "object") throw Errors.validation("recording an NPC encounter needs the manifest, so the NPC can be resolved against the world");

      const npc = (manifest.npcs || []).find((n) => n?.id === npcId);
      if (!npc) {
        // An id that names nothing must never reach known_npc_ids: it would
        // refuse a rollback over an entity that does not exist.
        throw Errors.validation(`'${npcId}' is not an NPC in this world, so no encounter can be recorded`, { meta: { world_id: worldId } });
      }
      if (!lines || typeof lines !== "object" || lines.npc?.id !== npcId) {
        throw Errors.validation(
          "an NPC encounter is recorded from the dialogue the server itself served (npcMemory.linesFor), which must name the same NPC; a caller cannot assert an encounter",
          { meta: { npc_id: npcId, served_npc_id: lines?.npc?.id ?? null } }
        );
      }

      const session = await store.sessions.one((r) => r.world_id === worldId && r.principal_id === me);
      if (!session) {
        throw Errors.conflict(
          "no recorded session: this principal has not entered this world, so serving an NPC's lines is not evidence they met",
          { meta: { world_id: worldId, npc_id: npcId } }
        );
      }

      const at = nowIso();
      const { row, created } = await observe(
        store.npcs,
        (r) => r.world_id === worldId && r.principal_id === me && r.npc_id === npcId,
        () => ({
          id: crypto.randomUUID(),
          world_id: worldId,
          principal_id: me,
          npc_id: npcId,
          evidence: EVIDENCE.SERVER_NPC_DIALOGUE,
          first_at: at,
          last_at: at,
          occurrences: 1,
          world_version: worldVersion,
        })
      );
      return { encounter: row, first_meeting: created };
    },

    // ------------------------------------------------------------- REFUSAL

    /**
     * The seam that must stay refused.
     *
     * It exists so that a route author reaching for "just record what the
     * client sent" gets this explanation instead of a convenient function, and
     * so a test can pin the refusal. It NEVER returns. Same discipline as
     * `livestate.mjs`'s null sources and `verification.mjs` with no provider.
     */
    async recordClientClaim(claim = {}) {
      throw Errors.forbidden(
        "player progress is never recorded from a client claim. A recorded completion gates whether a rollback may delete a quest, " +
        "an NPC or a zone, so a claim written here would let any client both fabricate a hold (freezing a creator's world) and, by " +
        "omission, license a deletion. Only two acts are recorded, both performed by the server itself: placing a player at a spawn " +
        "(recordWorldEntry) and serving an NPC's dialogue (recordNpcDialogueServed). Completions are DERIVED from those. Making a " +
        "completion verifiable in general needs a server-authoritative session — the runtime reporting step satisfaction over a channel " +
        "the client cannot forge, or a CW5 op whose player_id is bound to the caller's principal. Neither exists today.",
        { meta: { refused_claim: Object.keys(claim || {}), accepted_evidence: ACCEPTED_EVIDENCE } }
      );
    },

    // ------------------------------------------------------------ DERIVATION

    /**
     * Derive quest completions for one principal from stored observations.
     *
     * A completion is written only when EVERY step of the quest, as this
     * manifest defines it, is matched by an observation, and the observations
     * are in step order. Anything else is reported as blocked, by step, with
     * the reason — never rounded up to "nearly done" and never written.
     *
     * Idempotent: re-running it against the same evidence changes nothing.
     */
    async reconcileQuests({ principal, worldId, manifest, worldVersion = null, subjectId = null } = {}) {
      requireStore("deriving quest completions");
      const me = assertSelf(principal, subjectId);
      assertWorldId(worldId);
      if (!manifest || typeof manifest !== "object") throw Errors.validation("deriving completions needs the world manifest that defines the quests");
      return await derive(me, worldId, manifest, worldVersion);
    },

    /**
     * Derive completions for EVERY principal with a recorded session in this
     * world. Server-internal, principal-less: it takes no subject and returns
     * no principal ids.
     *
     * The rollback path should call this before reading holds, so a quest added
     * after the evidence was gathered is still derived before it gates a
     * deletion.
     */
    async reconcileWorld(worldId, manifest, worldVersion = null) {
      requireStore("deriving quest completions for a world");
      assertWorldId(worldId);
      if (!manifest || typeof manifest !== "object") throw Errors.validation("deriving completions needs the world manifest that defines the quests");
      const sessions = await rowsOf(store.sessions, "reading recorded sessions");
      let completions = 0;
      let players = 0;
      for (const s of sessions) {
        if (s.world_id !== worldId) continue;
        players++;
        const r = await derive(s.principal_id, worldId, manifest, worldVersion);
        completions += r.completed.length;
      }
      return { world_id: worldId, sessions_seen: players, completions };
    },

    // ----------------------------------------------------------------- READS

    /**
     * One player's own progress. Self-only: there is no path here to another
     * principal's rows, with or without a world id.
     */
    async progressFor(principal, worldId, { subjectId = null } = {}) {
      requireStore("reading a player's progress");
      const me = assertSelf(principal, subjectId);
      assertWorldId(worldId);

      const [sessions, npcs, zones, quests] = await Promise.all([
        rowsOf(store.sessions, "reading recorded sessions"),
        rowsOf(store.npcs, "reading NPC encounters"),
        rowsOf(store.zones, "reading zone visits"),
        rowsOf(store.quests, "reading quest completions"),
      ]);
      const mine = (rows) => rows.filter((r) => r.world_id === worldId && r.principal_id === me);

      const session = mine(sessions)[0] || null;
      return {
        world_id: worldId,
        principal_id: me,
        entered: !!session,
        session,
        known_npc_ids: mine(npcs).map((r) => r.npc_id),
        visited_zone_ids: mine(zones).map((r) => r.zone_id),
        completed_quest_ids: mine(quests).map((r) => r.quest_id),
        npc_encounters: mine(npcs),
        zone_visits: mine(zones),
        quest_completions: mine(quests),
        note:
          "Only what the server observed: the spawn it placed you in, and the NPCs whose dialogue it served you. " +
          "A quest you finished in the client is not here, because nothing on the server saw it.",
      };
    },

    /**
     * What players hold in this world, for the live-state sources.
     *
     * ENTITY IDS ONLY. No principal id leaves this method: a rollback needs to
     * know which quest is held, not who holds it, and returning the second
     * would turn a safety read into a way to enumerate a world's players.
     *
     * THROWS if it cannot look. Returns empty arrays only after looking.
     */
    async heldInWorld(worldId) {
      requireStore("reading what players hold in a world");
      assertWorldId(worldId);
      const [npcs, zones, quests] = await Promise.all([
        rowsOf(store.npcs, "reading NPC encounters"),
        rowsOf(store.zones, "reading zone visits"),
        rowsOf(store.quests, "reading quest completions"),
      ]);
      const idsOf = (rows, key) => {
        const out = [];
        for (const r of rows) {
          if (r.world_id !== worldId) continue;
          const id = r[key];
          if (typeof id === "string" && id && !out.includes(id)) out.push(id);
        }
        return out;
      };
      return {
        world_id: worldId,
        known_npc_ids: idsOf(npcs, "npc_id"),
        visited_zone_ids: idsOf(zones, "zone_id"),
        completed_quest_ids: idsOf(quests, "quest_id"),
      };
    },

    /**
     * Re-derive a stored completion from the evidence still on file.
     *
     * A completion row carries the observations it was built from, so it can be
     * audited rather than taken on trust. If the evidence no longer supports
     * it, this says so — it does not quietly delete the row, because what
     * happened still happened, and it does not quietly keep believing it.
     */
    async verifyCompletion({ principal, worldId, questId, manifest, subjectId = null } = {}) {
      requireStore("verifying a quest completion");
      const me = assertSelf(principal, subjectId);
      assertWorldId(worldId);
      const row = await store.quests.one((r) => r.world_id === worldId && r.principal_id === me && r.quest_id === questId);
      if (!row) throw Errors.notFound(`a recorded completion of quest '${questId}'`);
      const quest = (manifest?.quests || []).find((q) => q?.id === questId) || null;
      const evidence = await evidenceFor(me, worldId);
      const check = quest ? matchSteps(quest, evidence) : null;
      return {
        completion: row,
        quest_still_in_manifest: !!quest,
        fingerprint_matches: quest ? questFingerprint(quest) === row.quest_fingerprint : null,
        still_supported: check ? check.ok : null,
        blocked_steps: check && !check.ok ? check.blocked : [],
        note: quest
          ? null
          : "The quest is no longer in this manifest version. The completion still stands as a record of what happened; it is not evidence about the current world.",
      };
    },
  };

  // ------------------------------------------------------- internal helpers

  /** Every observation this principal has in this world, indexed for matching. */
  async function evidenceFor(principalId, worldId) {
    const [npcs, zones] = await Promise.all([
      rowsOf(store.npcs, "reading NPC encounters"),
      rowsOf(store.zones, "reading zone visits"),
    ]);
    const npcBy = new Map();
    for (const r of npcs) if (r.world_id === worldId && r.principal_id === principalId) npcBy.set(r.npc_id, r);
    const zoneBy = new Map();
    for (const r of zones) if (r.world_id === worldId && r.principal_id === principalId) zoneBy.set(r.zone_id, r);
    return { npcBy, zoneBy };
  }

  /**
   * Match a quest's steps against stored observations, IN ORDER.
   *
   * Order matters and is not pedantry: evidence for every step, gathered in any
   * order, is evidence of having done the things — not of having done the
   * quest. `validateQuests` and `simulateQuests` both read a quest as an
   * ordered sequence, so this reads it the same way.
   */
  function matchSteps(quest, { npcBy, zoneBy }) {
    const steps = quest?.steps || [];
    if (!steps.length) {
      return {
        ok: false,
        matched: [],
        blocked: [{ step_id: null, kind: null, target: null, reason: "the quest has no steps, so there is nothing that could have been completed" }],
      };
    }

    const matched = [];
    const blocked = [];
    let previousAt = null;

    for (const st of steps) {
      const kind = st?.kind;
      const target = st?.target;
      let ev = null;

      if (!target) {
        blocked.push({ step_id: st?.id ?? null, kind: kind ?? null, target: null, reason: "the step has no target" });
        continue;
      }
      if (kind === "talk") ev = npcBy.get(target) || null;
      else if (kind === "reach") ev = zoneBy.get(target) || null;
      else {
        blocked.push({ step_id: st.id, kind, target, reason: whyNoEvidence(kind) });
        continue;
      }

      if (!ev) {
        blocked.push({
          step_id: st.id, kind, target,
          reason: kind === "talk"
            ? "the server has not served this NPC's dialogue to this player"
            : "the server has not placed this player in this zone (only spawn placement is observed, so a zone reached on foot leaves no server-side record)",
        });
        continue;
      }
      if (previousAt && ev.first_at < previousAt) {
        // Real evidence, wrong order. Say which, rather than failing silently.
        blocked.push({
          step_id: st.id, kind, target,
          reason: `observed at ${ev.first_at}, before the previous step's evidence at ${previousAt}: the steps were not done in the quest's order`,
        });
        continue;
      }
      previousAt = ev.first_at;
      matched.push({ step_id: st.id, kind, target, evidence: ev.evidence, evidence_id: ev.id, satisfied_at: ev.first_at });
    }

    return { ok: blocked.length === 0, blocked, matched };
  }

  /** Derive and persist completions for one principal in one world. */
  async function derive(principalId, worldId, manifest, worldVersion) {
    const evidence = await evidenceFor(principalId, worldId);
    const completed = [];
    const blocked = [];

    for (const quest of manifest.quests || []) {
      if (!quest?.id) continue;
      const check = matchSteps(quest, evidence);
      if (!check.ok) {
        blocked.push({ quest_id: quest.id, steps: check.blocked });
        continue;
      }
      const at = check.matched.reduce((latest, m) => (m.satisfied_at > latest ? m.satisfied_at : latest), check.matched[0].satisfied_at);
      // ensure(), not one()+insert(): two concurrent observations can both
      // finish the same quest, and both would pass an unlocked existence check.
      const { row, created } = await store.quests.ensure(
        (r) => r.world_id === worldId && r.principal_id === principalId && r.quest_id === quest.id,
        () => ({
          id: crypto.randomUUID(),
          world_id: worldId,
          principal_id: principalId,
          quest_id: quest.id,
          world_version: worldVersion,
          completed_at: at,
          derived_at: nowIso(),
          // The proof, carried with the row: which observation satisfied which
          // step, and the exact quest definition it was measured against.
          quest_fingerprint: questFingerprint(quest),
          steps: check.matched,
        })
      );
      completed.push({ quest_id: quest.id, newly_completed: created, completion: row });
    }

    return {
      world_id: worldId,
      completed,
      blocked,
      note: blocked.length
        ? `${completed.length} quest(s) are supported by server observations. ${blocked.length} are not, and are NOT recorded: a step this server never saw is not a step that was done.`
        : `${completed.length} quest(s) are supported by server observations.`,
    };
  }

  return svc;
}

// ===========================================================================
// LIVE STATE SOURCE ADAPTERS
// ===========================================================================
//
// Drop-in replacements for `nullQuestProgressSource()` and
// `nullNpcAcquaintanceSource()`, plus a third for visited zones. Each
// implements the `LiveStateSource` contract in `livestate.mjs` exactly:
//
//   * `covers` is PARTIAL, never AVAILABLE — see the reasoning at the top of
//     this file. PARTIAL is what makes `livestate.mjs` keep the category
//     UNDETERMINED, which is the truth: more real holds are now protected, and
//     the guarantee is still not complete.
//   * `status()` is AVAILABLE only when the store can actually be read.
//   * `read()` returns [] only after genuinely looking; otherwise it THROWS.

function progressSource({ progress, name, category, why }) {
  return {
    name,
    covers: { [category]: COVERAGE.PARTIAL },
    status: () => (progress && typeof progress.heldInWorld === "function" && progress.status() === COVERAGE.AVAILABLE
      ? COVERAGE.AVAILABLE
      : COVERAGE.UNAVAILABLE),
    async read(worldId) {
      if (this.status() !== COVERAGE.AVAILABLE) throw Errors.notConfigured(why);
      // Anything heldInWorld throws — an unreadable store, corrupt rows —
      // reaches livestate as "unknown". It is never flattened into empty.
      const held = await progress.heldInWorld(worldId);
      return { [category]: held[category] };
    },
  };
}

/**
 * `completed_quest_ids`, from DERIVED completions only.
 *
 * PARTIAL and permanently so until a completion is verifiable in general: today
 * only talk-shaped steps and spawn-zone reach steps can be substantiated, so a
 * quest with a collect or deliver step is absent from this source however many
 * players have finished it.
 */
export function questProgressSource({ progress = null } = {}) {
  return progressSource({
    progress,
    name: "player-progress:quests",
    category: "completed_quest_ids",
    why: "the player-progress store (quest completions cannot be read, so completed quests are unknown rather than absent)",
  });
}

/**
 * `known_npc_ids`, from NPC dialogue the server actually served.
 *
 * PARTIAL: a player can meet an NPC entirely inside the client, and the server
 * never learns of it.
 */
export function npcAcquaintanceSource({ progress = null } = {}) {
  return progressSource({
    progress,
    name: "player-progress:npc-acquaintance",
    category: "known_npc_ids",
    why: "the player-progress store (NPC encounters cannot be read, so known NPCs are unknown rather than absent)",
  });
}

/**
 * `visited_zone_ids`, from spawn placement the server performed.
 *
 * PARTIAL, and narrowly so: this is the zone the world put the player in, not
 * everywhere they walked. It is nonetheless stronger evidence than the
 * companion's `last_zone`, which is whatever the client said.
 */
export function visitedZoneSource({ progress = null } = {}) {
  return progressSource({
    progress,
    name: "player-progress:visited-zones",
    category: "visited_zone_ids",
    why: "the player-progress store (zone visits cannot be read, so visited zones are unknown rather than absent)",
  });
}

/** All three, for `createLiveStateService({ sources: [...] })`. */
export function playerProgressSources({ progress = null } = {}) {
  return [questProgressSource({ progress }), npcAcquaintanceSource({ progress }), visitedZoneSource({ progress })];
}
