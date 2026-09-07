// B5 — the personal AI companion.
//
// Reuses the existing companion shell verbs (adopt, follow, caption, dismiss)
// and upgrades them with world context, zone awareness, active-quest awareness,
// guidance, a persistent identity, selected player memory, a persona and
// world-history awareness.
//
// The honesty rule that governs everything here: the companion may only state
// something it can point to. World facts come from the manifest, history comes
// from B7 world memory, and player facts come from recorded session state. If it
// cannot cite a source, it says it does not know. A model may PHRASE an answer,
// but the facts are assembled here first and the model is given nothing else.
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Errors } from "../../core/errors.mjs";

export const PERSONAS = {
  guide: { name: "Guide", tone: "clear and practical", greeting: "I'll keep track of where we are and what's next." },
  scholar: { name: "Scholar", tone: "curious and precise", greeting: "There's a lot here worth understanding. Ask me anything about this place." },
  scout: { name: "Scout", tone: "terse and forward-looking", greeting: "I'll watch the route. Say the word and I'll point you at what's next." },
  companion: { name: "Companion", tone: "warm and encouraging", greeting: "I'm with you. Let's see what this place holds." },
};

export const STATES = ["dismissed", "adopted", "following"];

/**
 * @param {{worldMemory?:object, env?:object}|object} [opts]
 *   Options, or a bare environment — see below for why both are accepted.
 */
export function createCompanionService(opts = {}) {
  // A bare environment is accepted as well as an options object.
  //
  // Its sibling takes one directly — `createWorldMemory(env)` — and callers
  // reasonably assumed this did too, so several passed `{ DCS_DATA_DIR: ... }`
  // straight in. Destructuring `env` off that yields undefined, `env` falls back
  // to process.env, DCS_DATA_DIR is unset there, and the store quietly lands in
  // `process.cwd()/.dcs-data` instead of the caller's directory.
  //
  // Quietly is the whole problem. Nothing failed: a test that believed it had an
  // isolated temp directory shared ONE directory in the working tree with every
  // other such test and every previous run of the suite, accumulating companion
  // memories run after run. It surfaced only when an unrelated change altered an
  // entity id and a rollback test read back a ref written by a run days earlier
  // — a test that had been passing on stale state rather than on its own.
  //
  // Guessing is safe here because the two shapes cannot be confused: an
  // environment has SCREAMING_CASE keys and neither of the two option names.
  const looksLikeEnv = opts && typeof opts === "object"
    && !("env" in opts) && !("worldMemory" in opts)
    && Object.keys(opts).some((k) => /^[A-Z][A-Z0-9_]*$/.test(k));
  const { worldMemory, env = process.env } = looksLikeEnv ? { env: opts } : opts;

  const dir = path.join(env.DCS_DATA_DIR || path.join(process.cwd(), ".dcs-data"), "companions");
  fs.mkdirSync(dir, { recursive: true });

  const file = (principalId, worldId) => {
    const key = `${principalId}::${worldId}`;
    if (!/^[A-Za-z0-9._:@-]{1,120}::[A-Za-z0-9._:-]{1,200}$/.test(key)) throw Errors.validation("unsafe companion key");
    return path.join(dir, encodeURIComponent(key) + ".json");
  };

  async function read(principalId, worldId) {
    try { return JSON.parse(await fsp.readFile(file(principalId, worldId), "utf8")); }
    catch (e) { if (e.code === "ENOENT") return null; throw e; }
  }
  async function write(rec) {
    const p = file(rec.principal_id, rec.world_id);
    const tmp = p + ".tmp-" + crypto.randomBytes(4).toString("hex");
    await fsp.writeFile(tmp, JSON.stringify(rec));
    await fsp.rename(tmp, p);
    return rec;
  }

  /**
   * One writer at a time, per companion.
   *
   * Every mutating method here is read-then-write with nothing in between, so
   * two calls landing together both read the same record and the second write
   * discarded the first. Ten concurrent `remember()` calls kept ONE memory.
   *
   * That is worse than losing notes. `companion_memory_refs` from this store is
   * what `liveStateFor` reads to decide whether a rollback may go ahead, so a
   * memory lost to a race is a hold the server cannot see — and a rollback that
   * should have been refused deletes the NPC or the item the player's companion
   * remembers. A player asking their companion to remember two things at once is
   * an ordinary thing, not an edge case.
   *
   * Serialised within this process, which is what the deployment has: server.mts
   * constructs one instance over a local directory. This is NOT a cross-process
   * lock and does not pretend to be one.
   */
  const queues = new Map();
  function serialize(principalId, worldId, work) {
    const key = `${principalId}::${worldId}`;
    const prev = queues.get(key) || Promise.resolve();
    // The chain must survive a rejection, or one failed write would wedge this
    // companion for the lifetime of the process.
    const next = prev.then(work, work);
    queues.set(key, next.then(() => {}, () => {}));
    return next;
  }

  return {
    dir,
    PERSONAS,

    /** Adopt: create a persistent companion identity for this player in this world. */
    async adopt(principalId, worldId, { name = null, persona = "guide" } = {}) {
      if (!principalId) throw Errors.unauthenticated("adopting a companion requires an authenticated principal");
      if (!PERSONAS[persona]) throw Errors.validation(`persona must be one of: ${Object.keys(PERSONAS).join(", ")}`);
      return await serialize(principalId, worldId, async () => {
      const existing = await read(principalId, worldId);
      if (existing && existing.state !== "dismissed") return { ...existing, idempotent: true };
      const rec = {
        companion_id: existing?.companion_id || "cmp_" + crypto.randomBytes(6).toString("hex"),
        principal_id: principalId,
        world_id: worldId,
        name: name || existing?.name || PERSONAS[persona].name,
        persona,
        state: "adopted",
        // Persistent identity: an adopt after a dismiss keeps the same companion
        // and the same memories, rather than handing back a stranger.
        adopted_at: existing?.adopted_at || new Date().toISOString(),
        readopted_at: existing ? new Date().toISOString() : null,
        memories: existing?.memories || [],
        last_zone: existing?.last_zone || null,
        active_quest: existing?.active_quest || null,
      };
      return await write(rec);
      });
    },

    async get(principalId, worldId) {
      const rec = await read(principalId, worldId);
      if (!rec) throw Errors.notFound("companion");
      return rec;
    },

    async follow(principalId, worldId, following = true) {
      return await serialize(principalId, worldId, async () => {
        const rec = await this.get(principalId, worldId);
        if (rec.state === "dismissed") throw Errors.conflict("this companion has been dismissed; adopt it again first");
        rec.state = following ? "following" : "adopted";
        return await write(rec);
      });
    },

    /** Dismiss keeps the record so memory survives; only the state changes. */
    async dismiss(principalId, worldId) {
      return await serialize(principalId, worldId, async () => {
        const rec = await this.get(principalId, worldId);
        rec.state = "dismissed";
        rec.dismissed_at = new Date().toISOString();
        return await write(rec);
      });
    },

    /**
     * Selected player memory. The player chooses what the companion keeps, which
     * is both the privacy-respecting default and what makes recall honest.
     */
    async remember(principalId, worldId, { text, kind = "note", refs = [] }) {
      if (!text || typeof text !== "string") throw Errors.validation("a memory needs text");
      return await serialize(principalId, worldId, async () => {
        const rec = await this.get(principalId, worldId);
        rec.memories.push({
          id: crypto.randomUUID(), kind, text: text.slice(0, 400), refs,
          at: new Date().toISOString(),
        });
        // Bounded on purpose: an unbounded memory list is a silent storage leak.
        if (rec.memories.length > 200) rec.memories = rec.memories.slice(-200);
        return await write(rec);
      });
    },

    async forget(principalId, worldId, memoryId) {
      return await serialize(principalId, worldId, async () => {
        const rec = await this.get(principalId, worldId);
        const before = rec.memories.length;
        rec.memories = rec.memories.filter((m) => m.id !== memoryId);
        if (rec.memories.length === before) throw Errors.notFound(`memory ${memoryId}`);
        return await write(rec);
      });
    },

    /** Track where the player is, so the companion is zone-aware. */
    async updateContext(principalId, worldId, { zone = null, activeQuest = null } = {}) {
      return await serialize(principalId, worldId, async () => {
        const rec = await this.get(principalId, worldId);
        if (zone !== null) rec.last_zone = zone;
        if (activeQuest !== null) rec.active_quest = activeQuest;
        rec.context_updated_at = new Date().toISOString();
        return await write(rec);
      });
    },

    /**
     * Build the companion's complete, sourced view of the world right now.
     * This is the ONLY thing a phrasing model is ever given.
     */
    async buildContext(principalId, worldId, manifest, { zone = null, activeQuest = null } = {}) {
      const rec = await read(principalId, worldId);
      const currentZone = zone || rec?.last_zone || manifest?.spawn?.player_spawns?.[0]?.zone || null;
      const z = (manifest?.zones || []).find((x) => x.id === currentZone) || null;
      const questId = activeQuest || rec?.active_quest || null;
      const quest = (manifest?.quests || []).find((q) => q.id === questId) || null;

      const inZone = (id) => (manifest?.zones || []).some((x) => x.id === id);
      const npcsHere = (manifest?.npcs || []).filter((n) => n.zone === currentZone);
      const structuresHere = (manifest?.structures || []).filter((s) => s.zone === currentZone);

      const history = worldMemory ? await worldMemory.recall(worldId, { limit: 12 }) : [];

      return {
        companion: rec ? { id: rec.companion_id, name: rec.name, persona: rec.persona, state: rec.state } : null,
        world: {
          id: worldId,
          title: manifest?.meta?.title ?? null,
          version: manifest?.world_version ?? null,
          genre: manifest?.meta?.genre ?? null,
          weather: manifest?.environment?.weather ?? null,
          time_of_day: manifest?.environment?.time_of_day ?? null,
          zone_count: (manifest?.zones || []).length,
        },
        here: z ? {
          zone_id: z.id, name: z.name, kind: z.kind,
          npcs: npcsHere.map((n) => ({ id: n.id, name: n.name, role: n.role })),
          structures: structuresHere.map((s) => ({ id: s.id, purpose: s.purpose, enterable: !!s.enterable })),
        } : null,
        // Only zones the navigation graph actually connects — the companion never
        // sends a player somewhere there is no route to.
        exits: (manifest?.navigation?.links || [])
          .filter((l) => l.from === currentZone || l.to === currentZone)
          .map((l) => (l.from === currentZone ? l.to : l.from))
          .filter(inZone)
          .map((id) => {
            const zz = manifest.zones.find((x) => x.id === id);
            return { zone_id: id, name: zz?.name ?? id };
          }),
        active_quest: quest ? {
          id: quest.id, title: quest.title,
          steps: quest.steps.map((s) => ({ id: s.id, kind: s.kind, target: s.target, description: s.description })),
        } : null,
        player_memories: (rec?.memories || []).slice(-8),
        world_history: history.map((h) => ({ kind: h.kind, summary: h.summary, at: h.occurred_at, version: h.world_version })),
      };
    },

    /**
     * Answer a player's question from the assembled context.
     *
     * Deterministic and grounded. Every answer carries the sources it was drawn
     * from, and an unanswerable question gets "I don't know" rather than a guess.
     * A phrasing model can be layered on top later; it must be given `context`
     * and nothing else.
     */
    async ask(principalId, worldId, manifest, question, opts = {}) {
      const ctx = await this.buildContext(principalId, worldId, manifest, opts);
      const q = String(question || "").toLowerCase().trim();
      if (!q) throw Errors.validation("ask() needs a question");

      const answer = (text, sources) => ({ answer: text, sources, grounded: true, context_version: ctx.world.version });
      const unknown = (why) => ({
        answer: `I don't know. ${why}`,
        sources: [],
        grounded: true,
        unknown: true,
        context_version: ctx.world.version,
      });

      // --- where am I -------------------------------------------------------
      if (/\b(where am i|what is this place|where are we)\b/.test(q)) {
        if (!ctx.here) return unknown("I can't tell which part of the world you're in yet.");
        return answer(
          `You're in ${ctx.here.name}${ctx.here.kind !== "district" ? ` (${ctx.here.kind})` : ""}, part of ${ctx.world.title}.`,
          [{ kind: "manifest", ref: ctx.here.zone_id }]
        );
      }

      // --- what should I do next -------------------------------------------
      if (/\b(what (should|do) i do|what'?s next|next step|objective)\b/.test(q)) {
        if (!ctx.active_quest) return unknown("You don't have an active quest right now.");
        const step = ctx.active_quest.steps[0];
        return answer(
          `Your quest is "${ctx.active_quest.title}". Next: ${step.description || `${step.kind} ${step.target}`}.`,
          [{ kind: "manifest", ref: ctx.active_quest.id }]
        );
      }

      // --- who is here ------------------------------------------------------
      if (/\b(who('s| is) (here|around)|any(one|body) here|who can i talk to)\b/.test(q)) {
        if (!ctx.here?.npcs.length) return unknown("There's nobody in this zone.");
        return answer(
          `Here you'll find ${ctx.here.npcs.map((n) => `${n.name}${n.role ? ` the ${n.role}` : ""}`).join(", ")}.`,
          ctx.here.npcs.map((n) => ({ kind: "manifest", ref: n.id }))
        );
      }

      // --- where can I go ---------------------------------------------------
      if (/\b(where can i go|what'?s nearby|exits?|other (areas|zones|districts))\b/.test(q)) {
        if (!ctx.exits.length) return unknown("There's no route out of this zone that I can see.");
        return answer(`From here you can reach ${ctx.exits.map((e) => e.name).join(", ")}.`, ctx.exits.map((e) => ({ kind: "manifest", ref: e.zone_id })));
      }

      // --- world history: strictly from the record --------------------------
      if (/\b(what happened|history|when was|has this|changed|new here)\b/.test(q)) {
        if (!ctx.world_history.length) return unknown("Nothing has been recorded about this world's history yet.");
        const h = ctx.world_history.slice(0, 3);
        return answer(
          `What I have on record: ${h.map((e) => `${e.summary} (${String(e.at).slice(0, 10)})`).join("; ")}.`,
          h.map((e) => ({ kind: "world_memory", ref: e.summary }))
        );
      }

      // --- what do you remember about me ------------------------------------
      if (/\b(remember|memory|memories|about me)\b/.test(q)) {
        if (!ctx.player_memories.length) return unknown("You haven't asked me to remember anything yet.");
        return answer(
          `You asked me to remember: ${ctx.player_memories.map((m) => m.text).join("; ")}.`,
          ctx.player_memories.map((m) => ({ kind: "player_memory", ref: m.id }))
        );
      }

      // --- weather / time ---------------------------------------------------
      if (/\b(weather|raining|time of day|dark|night)\b/.test(q)) {
        return answer(
          `It's ${ctx.world.weather ?? "unclear"} here, and the clock reads ${describeTime(ctx.world.time_of_day)}.`,
          [{ kind: "manifest", ref: "environment" }]
        );
      }

      // Deliberately no fallback guess.
      return unknown("That's outside what I can see of this world.");
    },

    /**
     * A caption for the current moment. Assembled from facts, so it can be shown
     * as a subtitle without risking an invented claim.
     */
    async caption(principalId, worldId, manifest, opts = {}) {
      const ctx = await this.buildContext(principalId, worldId, manifest, opts);
      const persona = PERSONAS[ctx.companion?.persona || "guide"];
      const bits = [];
      if (ctx.here) bits.push(ctx.here.name);
      if (ctx.world.weather && ctx.world.weather !== "clear") bits.push(ctx.world.weather);
      if (ctx.active_quest) bits.push(`Quest: ${ctx.active_quest.title}`);
      if (ctx.here?.npcs.length) bits.push(`${ctx.here.npcs.length} nearby`);
      return {
        caption: bits.length ? bits.join(" · ") : (ctx.world.title || "Exploring"),
        tone: persona.tone,
        companion: ctx.companion?.name || persona.name,
      };
    },

    /**
     * The greeting on first adopt. Grounded in the world it is actually in.
     */
    async greeting(principalId, worldId, manifest) {
      const ctx = await this.buildContext(principalId, worldId, manifest);
      const persona = PERSONAS[ctx.companion?.persona || "guide"];
      const where = ctx.here ? ` We're in ${ctx.here.name}.` : "";
      return { text: `${persona.greeting}${where}`, companion: ctx.companion?.name || persona.name };
    },
  };
}

function describeTime(t) {
  if (typeof t !== "number") return "an unknown hour";
  if (t < 0.2) return "night";
  if (t < 0.35) return "early morning";
  if (t < 0.6) return "midday";
  if (t < 0.8) return "late afternoon";
  return "dusk";
}
