// B15 — retention and progression, backed ONLY by measured data.
//
// The Round-2 site showed daily-reward streaks with days already "Claimed", an
// achievement count of 184 and 9,240 points, and a battle-pass level — none of
// which any system had measured. Those were removed in A6.
//
// This is the replacement. Every number here is derived from a row that exists:
// a recorded play, a recorded rating, a world actually created or published. An
// achievement with no supporting rows is reported as locked with its real
// progress, never as "almost there" to manufacture urgency.
//
// Nothing here awards currency. Progression is XP and recognition only, because
// PAYMENTS_LIVE is false and a reward with monetary value would not be honest.
import { Errors } from "./errors.mjs";

/**
 * Achievements are DEFINITIONS, not stored state. Progress is computed from the
 * measured tables every time it is read, so it can never drift out of step with
 * reality and can never be granted by writing a row.
 */
export const ACHIEVEMENTS = [
  { id: "first_world", name: "First Light", description: "Create your first world.", metric: "worlds_created", target: 1 },
  { id: "five_worlds", name: "Cartographer", description: "Create five worlds.", metric: "worlds_created", target: 5 },
  { id: "first_publish", name: "Open to the Public", description: "Publish a world.", metric: "worlds_published", target: 1 },
  { id: "first_expansion", name: "It Grows", description: "Expand a world into a new version.", metric: "expansions", target: 1 },
  { id: "five_expansions", name: "City Planner", description: "Expand worlds five times.", metric: "expansions", target: 5 },
  { id: "first_play", name: "Boots on the Ground", description: "Play a world.", metric: "plays", target: 1 },
  { id: "explorer_ten", name: "Well Travelled", description: "Play ten sessions.", metric: "plays", target: 10 },
  { id: "hour_played", name: "An Hour In", description: "Spend an hour in worlds.", metric: "seconds_played", target: 3600 },
  { id: "first_friend", name: "Not Alone", description: "Make a friend.", metric: "friends", target: 1 },
  { id: "first_rating", name: "Critic", description: "Rate a world.", metric: "ratings_given", target: 1 },
  { id: "played_by_others", name: "Someone Came", description: "Have someone else play a world you made.", metric: "plays_by_others", target: 1 },
];

/** XP is awarded for measured events only, and is recorded when the event happens. */
export const XP_TABLE = { world_created: 25, world_published: 100, world_expanded: 40, play_session: 5, rating_given: 5 };

export function createProgressionService({ social, worldMemory } = {}) {
  if (!social) throw new Error("progression needs the social service");

  /** Gather every measured signal for one principal. Nothing is inferred. */
  async function metrics(principalId, ownedWorldIds = []) {
    const me = await social.me({ id: principalId });
    const friendList = await social.friendList(principalId);

    let plays = 0, seconds = 0, ratingsGiven = 0, playsByOthers = 0, expansions = 0;

    // Sessions this principal played.
    for (const p of await social.allPlays()) {
      if (p.principal_id === principalId) { plays++; seconds += p.seconds || 0; }
      else if (ownedWorldIds.includes(p.world_id)) playsByOthers++;
    }
    ratingsGiven = (await social.allRatings()).filter((r) => r.principal_id === principalId).length;

    // Expansions come from the world chronology, which records only real events.
    if (worldMemory) {
      for (const wid of ownedWorldIds) {
        const rows = await worldMemory.recall(wid, { kinds: ["expanded"], limit: 100 });
        expansions += rows.length;
      }
    }

    return {
      worlds_created: me.worlds_created,
      worlds_published: me.worlds_published,
      expansions,
      plays,
      seconds_played: seconds,
      friends: friendList.friends.length,
      ratings_given: ratingsGiven,
      plays_by_others: playsByOthers,
      xp: me.xp,
    };
  }

  return {
    ACHIEVEMENTS,
    metrics,

    /**
     * Achievement state. An unearned achievement shows its REAL progress, so a
     * player can see exactly how far off they are rather than being nudged.
     */
    async achievements(principalId, ownedWorldIds = []) {
      const m = await metrics(principalId, ownedWorldIds);
      const rows = ACHIEVEMENTS.map((a) => {
        const have = Number(m[a.metric] || 0);
        return {
          id: a.id, name: a.name, description: a.description,
          metric: a.metric, target: a.target, progress: have,
          unlocked: have >= a.target,
          // The exact figure, not a rounded-up percentage that flatters.
          progress_text: `${Math.min(have, a.target)} of ${a.target}`,
        };
      });
      return {
        unlocked: rows.filter((r) => r.unlocked).length,
        total: rows.length,
        achievements: rows,
        metrics: m,
        note: "Every figure here is computed from recorded activity. Nothing is seeded.",
      };
    },

    /**
     * A play streak, computed from the actual play rows.
     *
     * The old UI showed days pre-marked "Claimed" with a Day 7 "Legendary"
     * reward. There is no claiming here and no reward: a streak is a description
     * of what happened, and today counts only once the player has actually played.
     */
    async streak(principalId) {
      const days = new Set(
        (await social.allPlays()).filter((p) => p.principal_id === principalId)
          .map((p) => String(p.started_at).slice(0, 10))
      );
      if (!days.size) {
        return { current: 0, longest: 0, played_today: false, days: [], note: "No sessions have been recorded for this player." };
      }
      const sorted = [...days].sort();
      const today = new Date().toISOString().slice(0, 10);
      const dayBefore = (d) => { const x = new Date(d + "T00:00:00Z"); x.setUTCDate(x.getUTCDate() - 1); return x.toISOString().slice(0, 10); };

      let longest = 1, run = 1;
      for (let i = 1; i < sorted.length; i++) {
        run = sorted[i] === dayBefore(sorted[i - 1]) || dayBefore(sorted[i]) === sorted[i - 1] ? run + 1 : 1;
        if (run > longest) longest = run;
      }
      // The current streak counts back from today, and only if today was played.
      let current = 0, cursor = today;
      while (days.has(cursor)) { current++; cursor = dayBefore(cursor); }

      return {
        current, longest,
        played_today: days.has(today),
        days: sorted.slice(-14),
        // Deliberately no reward, no claim button, no currency.
        rewards: null,
        note: "A streak is a record of days played. There is nothing to claim, and no reward attached.",
      };
    },

    /**
     * The creator dashboard. Only measured numbers, and it says plainly when a
     * world has no activity rather than filling the space.
     */
    async creatorDashboard(principalId, ownedWorlds = []) {
      // One pass over plays and ratings, then one lookup per world.
      //
      // This used to call social.worldStats() inside the loop, and worldStats
      // scans the WHOLE plays collection and the WHOLE ratings collection every
      // time — so the cost was worlds x (all plays + all ratings), sequentially,
      // with a round trip each. Measured against staging it took 6.4 seconds
      // while /me/home took 2.0 and /me/profile 0.8, and two pages sat on a
      // placeholder for the duration.
      //
      // _statsIndex reads both collections ONCE and returns a lookup. The
      // timelines are fetched together rather than one after another, because
      // they do not depend on each other and waiting for each in turn is the
      // same latency paid N times.
      const statsFor = await social._statsIndex();
      const timelines = worldMemory
        ? await Promise.all(ownedWorlds.map((w) => worldMemory.timeline(w.world_id).catch(() => [])))
        : ownedWorlds.map(() => []);

      const worlds = [];
      for (const [i, w] of ownedWorlds.entries()) {
        const stats = statsFor(w.world_id);
        const history = timelines[i];
        worlds.push({
          world_id: w.world_id,
          title: w.title,
          state: w.state,
          world_version: w.version,
          stats,
          versions: history.length,
          // Recommendations require data. With none, this says so instead of guessing.
          recommendation: stats.plays === 0
            ? "No sessions recorded yet. There is nothing to recommend from."
            : stats.rating_count === 0
              ? `${stats.plays} session(s) recorded, no ratings yet.`
              : `${stats.plays} session(s), average rating ${stats.rating_avg}.`,
        });
      }
      const totals = worlds.reduce((a, w) => ({
        plays: a.plays + w.stats.plays,
        players: a.players + w.stats.unique_players,
        seconds: a.seconds + w.stats.total_seconds,
      }), { plays: 0, players: 0, seconds: 0 });

      return {
        worlds,
        totals,
        payments_live: false,
        revenue: null,
        revenue_note: "Revenue is not reported because no sale can occur: PAYMENTS_LIVE is false.",
        note: worlds.length === 0 ? "You have not created a world yet." : null,
      };
    },

    /** Award XP for a measured event. Refuses an event that is not in the table. */
    async awardXp(principalId, event) {
      const amount = XP_TABLE[event];
      if (!amount) throw Errors.validation(`'${event}' is not an XP-earning event`, { meta: { events: Object.keys(XP_TABLE) } });
      return { principal_id: principalId, event, xp: amount };
    },
  };
}
