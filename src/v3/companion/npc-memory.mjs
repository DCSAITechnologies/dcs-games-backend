// Section 9.5 — dynamic NPC memory and procedural quests, from RECORDED state.
//
// The rule from B7 applies here without exception: an NPC may only refer to
// something that was actually written down. A villager can say "they built the
// hospital last week" because a world event says so. A villager may never say
// "I remember when the river flooded" unless a flood was recorded.
//
// Procedural quests follow the same discipline. A generated quest targets
// entities that exist in the manifest right now, and its premise comes from a
// recorded event or from present world state — never from a story the generator
// made up about a past that did not happen.
import crypto from "node:crypto";
import { Errors } from "../../core/errors.mjs";
import { simulatePlaythrough } from "../playtest/agent.mjs";

/** How an NPC relates to a recorded event, given who they are and where. */
function relevance(npc, event, manifest) {
  let score = 0;
  const detail = JSON.stringify(event.detail || {}).toLowerCase();
  const summary = String(event.summary || "").toLowerCase();

  // Their own zone being changed matters most.
  const zone = (manifest.zones || []).find((z) => z.id === npc.zone);
  if (zone && (summary.includes(String(zone.name).toLowerCase()) || detail.includes(zone.id))) score += 3;

  // Their role being named matters.
  if (npc.role && summary.includes(String(npc.role).toLowerCase())) score += 2;

  // An expansion is the kind of thing everyone notices.
  if (event.kind === "expanded") score += 2;
  if (event.kind === "player_event") score += 2;
  if (event.kind === "seasonal") score += 1;
  if (event.kind === "created") score += 0;    // nobody remembers the world beginning

  return score;
}

export function createNpcMemory({ worldMemory } = {}) {
  if (!worldMemory) throw new Error("npc memory needs the world memory service");

  return {
    /**
     * What this NPC can truthfully say right now.
     *
     * Returns lines, each with the record it came from. A line with no source is
     * impossible by construction: every line is built from a row.
     */
    async linesFor(worldId, npcId, manifest, { limit = 3 } = {}) {
      const npc = (manifest.npcs || []).find((n) => n.id === npcId);
      if (!npc) throw Errors.notFound(`npc ${npcId}`);

      const events = await worldMemory.recall(worldId, { limit: 40 });
      const ranked = events
        .map((e) => ({ event: e, score: relevance(npc, e, manifest) }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);

      const lines = ranked.map(({ event, score }) => ({
        text: phrase(npc, event),
        source: { kind: "world_memory", event_id: event.id, summary: event.summary, occurred_at: event.occurred_at, world_version: event.world_version },
        relevance: score,
      }));

      // Present-tense observations are also facts: they describe the world as it
      // is right now, which is verifiable from the manifest.
      const here = observations(npc, manifest);

      return {
        npc: { id: npc.id, name: npc.name, role: npc.role, zone: npc.zone },
        remembered: lines,
        observes: here,
        // Said plainly, so a caller cannot mistake silence for a shy NPC.
        note: lines.length ? null : "This NPC has nothing to remember: no recorded event is relevant to them yet.",
      };
    },

    /**
     * Generate a quest from what is actually in the world.
     *
     * Every step targets an entity that exists. The premise is drawn from a
     * recorded event when one is relevant, and is otherwise a plain statement
     * about present state. It never invents a history.
     */
    async proceduralQuest(worldId, manifest, { giverNpcId = null, seed = null } = {}) {
      const npcs = manifest.npcs || [];
      const zones = manifest.zones || [];
      const items = manifest.items || [];
      const structures = manifest.structures || [];
      if (!npcs.length) throw Errors.validation("a procedural quest needs at least one NPC");

      // Only ever send a player somewhere they can get to.
      //
      // Every target here was picked on EXISTENCE alone, and existence is not
      // the test the gate applies: `simulateQuests` judges a step by
      // `walk.reached.has(target)`, so a quest naming a zone behind a cliff is
      // uncompletable from the moment it is written. server.mts runs the
      // playtest gate over the world with this quest added and answers 422
      // `quest_failed_playtest` when it fails, so an unreachable target does not
      // produce a poor quest — it produces no quest and an error. On a world
      // with one ordinary wall across it, 43 of 50 generated quests came out
      // uncompletable.
      //
      // Same defect the add_quest repair had, in a different endpoint, and the
      // same answer: walk the world and build only from what the walk reached.
      const walk = simulatePlaythrough(manifest);
      const canReach = (id) => walk.ok && walk.reached.has(id);

      const reachableNpcs = npcs.filter((n) => canReach(n.id));
      const giver = giverNpcId
        ? npcs.find((n) => n.id === giverNpcId)
        : (reachableNpcs[0] || npcs[0]);
      if (!giver) throw Errors.validation("a procedural quest needs at least one NPC");
      // A named giver who cannot be reached is refused rather than quietly
      // swapped: the caller asked for THIS character, and a quest nobody can
      // start is not an answer to that.
      if (!canReach(giver.id)) {
        throw Errors.validation(
          walk.ok
            ? `'${giver.id}' cannot be reached from the spawn, so a quest they give could never be started`
            : "this world has no spawn, so there is nowhere to start a quest from",
          { meta: { npc: giver.id, reachable_npcs: reachableNpcs.map((n) => n.id).slice(0, 10) } },
        );
      }

      const s = seed ?? hash(worldId + giver.id + String(manifest.world_version));
      const r = rng(s);

      const events = await worldMemory.recall(worldId, { kinds: ["expanded", "player_event", "seasonal"], limit: 10 });
      const basis = events.find((e) => relevance(giver, e, manifest) >= 2) || null;

      // Pick real targets. An item is only usable if something in the world
      // actually holds it, otherwise the quest would be uncompletable.
      const obtainable = new Set();
      for (const b of manifest.behaviors || []) {
        if (b.kind === "pickup" && b.spec?.item) obtainable.add(b.spec.item);
        if (b.kind === "container" && Array.isArray(b.spec?.contains)) for (const it of b.spec.contains) obtainable.add(it);
      }
      // Reachability already implies obtainability — an item enters `reached`
      // only when a pickup or container that grants it hangs off something the
      // walk got to — but the explicit set is kept because it is the thing
      // validateQuests checks, and the two agreeing is not an accident to rely
      // on silently.
      const usableItems = items.filter((i) => obtainable.has(i.id) && canReach(i.id));
      const item = usableItems[Math.floor(r() * usableItems.length)] || null;
      const otherNpcs = reachableNpcs.filter((n) => n.id !== giver.id);
      const otherNpc = otherNpcs[Math.floor(r() * otherNpcs.length)] || null;
      const reachableZones = zones.filter((z) => canReach(z.id));
      const zone = reachableZones[Math.floor(r() * reachableZones.length)] || null;
      const reachableStructures = structures.filter((x) => canReach(x.id));
      const structure = reachableStructures.filter((x) => x.enterable)[0] || reachableStructures[0] || null;

      const steps = [{ id: "step_ask", kind: "talk", target: giver.id, description: `Speak to ${giver.name}.` }];
      if (zone) steps.push({ id: "step_go", kind: "reach", target: zone.id, description: `Go to ${zone.name}.` });
      if (item) steps.push({ id: "step_get", kind: "collect", target: item.id, description: `Recover the ${item.name}.` });
      else if (structure) steps.push({ id: "step_use", kind: "activate", target: structure.id, description: `Get inside the ${structure.purpose || "building"}.` });
      if (otherNpc) steps.push({ id: "step_deliver", kind: "deliver", target: otherNpc.id, description: `Take word to ${otherNpc.name}.` });

      if (steps.length < 2) {
        throw Errors.validation(
          `this world does not contain enough that ${giver.name || giver.id} can send a player to: ` +
          `${reachableZones.length} of ${zones.length} zones, ${usableItems.length} of ${items.length} items and ` +
          `${reachableStructures.length} of ${structures.length} structures can be reached from the spawn`,
          { meta: { reachable: { zones: reachableZones.length, items: usableItems.length, structures: reachableStructures.length } } },
        );
      }

      return {
        quest: {
          id: `quest_proc_${crypto.randomBytes(4).toString("hex")}`,
          title: basis ? titleFromEvent(basis, giver) : `${giver.name}'s Request`,
          giver_npc: giver.id,
          zone: zone ? zone.id : null,
          difficulty: steps.length > 3 ? "normal" : "easy",
          steps,
          rewards: [],
          prerequisites: [],
        },
        // The premise is sourced, or explicitly unsourced.
        premise: basis
          ? { text: `Since ${basis.summary}, ${giver.name} needs help.`, source: { kind: "world_memory", event_id: basis.id, summary: basis.summary } }
          : { text: `${giver.name} has a request.`, source: null, note: "No recorded event applies, so the premise states only that a request exists." },
        grounded_in: basis ? "recorded_event" : "present_state",
      };
    },

    /**
     * Check a proposed NPC line against the record before it is spoken.
     * Used to keep any future model-generated dialogue honest.
     */
    async verifyLine(worldId, text) {
      const r = await worldMemory.supports(worldId, text);
      return {
        speakable: r.supported,
        ...r,
        note: r.supported ? null : "This line refers to something that was never recorded, and must not be spoken.",
      };
    },
  };
}

// ------------------------------------------------------------------ phrasing
//
// Phrasing is templated from the record. It never adds a fact the record does
// not contain — it only changes the wording to suit who is speaking.

function phrase(npc, event) {
  const when = ago(event.occurred_at);
  switch (event.kind) {
    case "expanded":
      return `${event.summary}. ${when} — you can still smell the work on it.`;
    case "edited":
      return `Something changed ${when}: ${event.summary}.`;
    case "published":
      return `Word went out ${when}. Strangers have been arriving since.`;
    case "player_event":
      return `${event.summary}. ${when}. People here still talk about it.`;
    case "seasonal":
      return `${event.summary}. That was ${when}.`;
    case "rollback":
      return `Things went back to how they were, ${when}.`;
    default:
      return `${event.summary} (${when}).`;
  }
}

function observations(npc, manifest) {
  const out = [];
  const zone = (manifest.zones || []).find((z) => z.id === npc.zone);
  if (zone) out.push({ text: `We're in ${zone.name}.`, source: { kind: "manifest", ref: zone.id } });
  const weather = manifest.environment?.weather;
  if (weather && weather !== "clear") out.push({ text: `The weather has been ${weather}.`, source: { kind: "manifest", ref: "environment" } });
  const neighbours = (manifest.npcs || []).filter((n) => n.zone === npc.zone && n.id !== npc.id).slice(0, 2);
  if (neighbours.length) out.push({ text: `${neighbours.map((n) => n.name).join(" and ")} ${neighbours.length > 1 ? "are" : "is"} about.`, source: { kind: "manifest", ref: neighbours.map((n) => n.id) } });
  return out;
}

function titleFromEvent(event, giver) {
  const s = String(event.summary || "").replace(/^the /i, "").replace(/ was added$/i, "");
  return `After the ${s}`.slice(0, 60) || `${giver.name}'s Request`;
}

function ago(iso) {
  const then = new Date(iso).getTime();
  if (!isFinite(then)) return "a while back";
  const days = Math.floor((Date.now() - then) / 86400000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  if (days < 30) return `${Math.floor(days / 7)} weeks ago`;
  return `${Math.floor(days / 30)} months ago`;
}

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < String(s).length; i++) { h ^= String(s).charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function rng(seed) {
  let a = (seed >>> 0) || 1;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
