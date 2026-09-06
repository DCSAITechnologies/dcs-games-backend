// B7 — World Memory.
//
// A factual chronology of what has actually happened to a world: district
// additions, major world events, creator edits, player-driven events, seasonal
// events, version milestones.
//
// The rule that makes this trustworthy: an NPC or the companion may ONLY cite an
// event recorded here. They never "remember" something that was not written
// down. `recall()` is the single read path, and it returns records, not prose,
// so a caller physically cannot dress up an invention as a memory.
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Errors } from "../../core/errors.mjs";

export const EVENT_KINDS = [
  "created",        // the world first existed
  "expanded",       // a new district or region was added
  "edited",         // a creator made a surgical change
  "published",      // the world was published
  "player_event",   // something a player did that the world should remember
  "seasonal",       // a seasonal or timed event ran
  "milestone",      // a version milestone
  "rollback",       // legacy spelling of rolled_back, still accepted (see below)
  "rolled_back",    // an earlier version's content was restored as a new version
];

/**
 * Kinds that must say which versions they moved between.
 *
 * A rollback is a world event and has to read as one in the world's own history:
 * "the world was rolled back" with no from and no to is not a chronicle entry,
 * it is a rumour. An NPC or the companion may only cite what is recorded here,
 * so an entry that cannot say what it undid would have them telling a player
 * something happened without being able to say what.
 *
 * `rollback` is kept alongside `rolled_back` because it has been in the
 * published kind list from the start; anything already passing it keeps working,
 * and it carries the same requirement. New callers should use `rolled_back`.
 */
const VERSIONED_KINDS = new Set(["rolled_back", "rollback"]);

export function createWorldMemory(env = process.env) {
  const dir = path.join(env.DCS_DATA_DIR || path.join(process.cwd(), ".dcs-data"), "world-memory");
  fs.mkdirSync(dir, { recursive: true });

  const file = (worldId) => {
    if (!/^[A-Za-z0-9._:-]{1,200}$/.test(String(worldId))) throw Errors.validation(`unsafe world id: ${worldId}`);
    return path.join(dir, encodeURIComponent(String(worldId)) + ".json");
  };

  async function readAll(worldId) {
    try { return JSON.parse(await fsp.readFile(file(worldId), "utf8")); }
    catch (e) { if (e.code === "ENOENT") return []; throw e; }
  }
  async function writeAll(worldId, rows) {
    const p = file(worldId);
    const tmp = p + ".tmp-" + crypto.randomBytes(4).toString("hex");
    await fsp.writeFile(tmp, JSON.stringify(rows));
    await fsp.rename(tmp, p);
  }

  return {
    dir,

    /**
     * Record something that actually happened. The chronology is append-only:
     * there is no update or delete, because a world's history is not editable.
     */
    async record(worldId, { kind, summary, detail = null, actorId = null, worldVersion = null, occurredAt = null, fromVersion = null, toVersion = null }) {
      if (!EVENT_KINDS.includes(kind)) throw Errors.validation(`event kind must be one of: ${EVENT_KINDS.join(", ")}`);
      if (!summary || typeof summary !== "string") throw Errors.validation("an event needs a factual one-line summary");
      if (VERSIONED_KINDS.has(kind)) {
        // null and undefined coerce to 0 through Number(), which would let an
        // event with no versions at all through as if it carried v0.
        const version = (v) => (v === null || v === undefined || v === "" || !Number.isInteger(Number(v)) || Number(v) < 1 ? null : Number(v));
        if (version(fromVersion) === null || version(toVersion) === null) {
          throw Errors.validation(`a '${kind}' event must record fromVersion and toVersion`);
        }
        if (!actorId) throw Errors.validation(`a '${kind}' event must be attributed to a principal`);
      }
      const rows = await readAll(worldId);
      const row = {
        id: crypto.randomUUID(),
        seq: rows.length + 1,
        world_id: worldId,
        world_version: worldVersion,
        kind,
        summary,
        detail,
        actor_id: actorId,
        occurred_at: occurredAt || new Date().toISOString(),
        // Present only on the kinds that move between versions, so the shape
        // every existing consumer already reads is untouched.
        ...(fromVersion !== null || toVersion !== null
          ? { from_version: fromVersion === null ? null : Number(fromVersion), to_version: toVersion === null ? null : Number(toVersion) }
          : {}),
      };
      rows.push(row);
      await writeAll(worldId, rows);
      return row;
    },

    /** The full chronology, oldest first. */
    async chronology(worldId) { return await readAll(worldId); },

    /**
     * The ONLY read path for NPC and companion memory.
     *
     * Returns recorded facts, filtered. It deliberately returns records rather
     * than a sentence: a caller that wants to phrase a memory must phrase it
     * from these rows, and can be checked against them.
     */
    async recall(worldId, { kinds = null, since = null, limit = 20, about = null } = {}) {
      let rows = await readAll(worldId);
      if (kinds) rows = rows.filter((r) => kinds.includes(r.kind));
      if (since) rows = rows.filter((r) => r.occurred_at >= since);
      if (about) {
        const needle = String(about).toLowerCase();
        rows = rows.filter((r) =>
          r.summary.toLowerCase().includes(needle) ||
          JSON.stringify(r.detail || {}).toLowerCase().includes(needle));
      }
      return rows.slice(-limit).reverse();
    },

    /**
     * Verify a claim against the record. Used to keep NPC and companion dialogue
     * honest: if this returns false, the claim must not be spoken.
     */
    async supports(worldId, claim) {
      const rows = await readAll(worldId);
      const needle = String(claim || "").toLowerCase().trim();
      if (!needle) return { supported: false, reason: "empty claim" };
      const hit = rows.find((r) =>
        r.summary.toLowerCase().includes(needle) ||
        needle.includes(r.summary.toLowerCase()));
      return hit
        ? { supported: true, evidence: { id: hit.id, seq: hit.seq, summary: hit.summary, occurred_at: hit.occurred_at } }
        : { supported: false, reason: "no recorded event supports this claim" };
    },

    /** A compact timeline for the creator dashboard and the expansion UI. */
    async timeline(worldId) {
      const rows = await readAll(worldId);
      const byVersion = new Map();
      for (const r of rows) {
        const v = r.world_version ?? 0;
        if (!byVersion.has(v)) byVersion.set(v, []);
        byVersion.get(v).push({ kind: r.kind, summary: r.summary, at: r.occurred_at });
      }
      return [...byVersion.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([version, events]) => ({ world_version: version, events }));
    },
  };
}
