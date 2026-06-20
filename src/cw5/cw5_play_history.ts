// CW5 Persistence — P4 Play History
//
// Spec line: "[P4] play-history store (feeds CW6 recommendations + CW7 retention)."
// Data model: dcsgames_play_history (user_id, world_id, played_at, duration).
//
// M-P4 acceptance: play-history powers a recommendation read.
//
// Append-only record of who played what, for how long. Two downstream consumers:
//   - CW6 recommendations: "worlds you might like" from play affinity
//   - CW7 retention: per-user return cadence, DAU/retention windows
// Storage behind an interface (in-memory now → dcsgames_play_history later).

// ============================================================================
// TYPES
// ============================================================================

export interface PlayRecord {
  play_id: string;
  user_id: string;
  world_id: string;
  played_at: number;       // epoch ms (session start)
  duration: number;        // seconds
}

// CW6 read shape: ranked world recommendations for a user.
export interface WorldRecommendation {
  world_id: string;
  score: number;           // affinity score (higher = stronger recommendation)
  reason: 'most_played' | 'similar_players' | 'recent_session';
}

// CW7 read shape: retention signal for a user.
export interface RetentionSignal {
  user_id: string;
  first_played_at: number | null;
  last_played_at: number | null;
  distinct_days_active: number;
  total_sessions: number;
  total_duration: number;          // seconds
  worlds_played: number;           // distinct worlds
  is_retained_d7: boolean;         // played on a day ≥7 days after first
  is_retained_d30: boolean;        // played on a day ≥30 days after first
}

// ============================================================================
// STORE INTERFACE
// ============================================================================

export interface PlayHistoryStore {
  append(rec: PlayRecord): Promise<void>;
  byUser(userId: string): Promise<PlayRecord[]>;
  byWorld(worldId: string): Promise<PlayRecord[]>;
  all(): Promise<PlayRecord[]>;
}

export class InMemoryPlayHistoryStore implements PlayHistoryStore {
  private records: PlayRecord[] = [];

  async append(rec: PlayRecord) {
    this.records.push(structuredClone(rec));
  }
  async byUser(userId: string) {
    return this.records.filter((r) => r.user_id === userId).map((r) => structuredClone(r));
  }
  async byWorld(worldId: string) {
    return this.records.filter((r) => r.world_id === worldId).map((r) => structuredClone(r));
  }
  async all() {
    return this.records.map((r) => structuredClone(r));
  }

  reset() {
    this.records = [];
  }
}

// ============================================================================
// PLAY HISTORY SERVICE
// ============================================================================

const DAY_MS = 24 * 60 * 60 * 1000;
let __pid = 0;
function nextPlayId(): string {
  __pid += 1;
  return `play_${Date.now().toString(36)}_${__pid}`;
}

export class PlayHistoryService {
  constructor(private store: PlayHistoryStore, private now: () => number = () => Date.now()) {}

  // ---- write ----

  /**
   * Record a completed play session. Append-only (history is never mutated).
   */
  async record(params: { user_id: string; world_id: string; played_at?: number; duration: number }): Promise<PlayRecord> {
    if (!params.user_id || !params.world_id) throw new Error('user_id and world_id required');
    if (params.duration == null || params.duration < 0) throw new Error('duration must be ≥ 0');

    const rec: PlayRecord = {
      play_id: nextPlayId(),
      user_id: params.user_id,
      world_id: params.world_id,
      played_at: params.played_at ?? this.now(),
      duration: params.duration,
    };
    await this.store.append(rec);
    return rec;
  }

  // ---- CW6: recommendations ----

  /**
   * Recommend worlds for a user.
   * P4 baseline algorithm (intentionally simple, tune later with CW6):
   *   1. "similar players": worlds played by users who share ≥1 world with this
   *      user — the strongest discovery signal.
   *   2. global popularity: most-played worlds overall.
   * BOTH paths exclude worlds the user already plays — recommendations are a
   * DISCOVERY surface, not a continue-playing list. (Continue-playing is a
   * separate read; see `recentlyPlayed`.)
   * Returns a ranked, de-duplicated list with the highest-weight reason retained.
   */
  async recommendForUser(userId: string, limit: number = 10): Promise<WorldRecommendation[]> {
    const all = await this.store.all();
    const myWorlds = new Set(all.filter((r) => r.user_id === userId).map((r) => r.world_id));

    // reason priority: similar_players (2) outranks most_played (1) when tied.
    const reasonRank: Record<WorldRecommendation['reason'], number> = {
      recent_session: 3,
      similar_players: 2,
      most_played: 1,
    };
    const scores = new Map<string, { score: number; reason: WorldRecommendation['reason'] }>();
    const bump = (worldId: string, by: number, reason: WorldRecommendation['reason']) => {
      const cur = scores.get(worldId);
      if (!cur) {
        scores.set(worldId, { score: by, reason });
        return;
      }
      cur.score += by; // always accumulate
      // keep the higher-priority reason as the displayed explanation
      if (reasonRank[reason] > reasonRank[cur.reason]) cur.reason = reason;
    };

    // (1) similar players — users who share ≥1 world with me; recommend THEIR
    // worlds that I don't already play.
    const peers = new Set<string>();
    for (const r of all) {
      if (r.user_id !== userId && myWorlds.has(r.world_id)) peers.add(r.user_id);
    }
    for (const r of all) {
      if (peers.has(r.user_id) && !myWorlds.has(r.world_id)) bump(r.world_id, 3, 'similar_players');
    }

    // (2) global popularity — most-played worlds I don't already play
    const popularity = new Map<string, number>();
    for (const r of all) {
      if (!myWorlds.has(r.world_id)) popularity.set(r.world_id, (popularity.get(r.world_id) ?? 0) + 1);
    }
    for (const [worldId, count] of popularity) bump(worldId, count, 'most_played');

    return Array.from(scores.entries())
      .map(([world_id, v]) => ({ world_id, score: v.score, reason: v.reason }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  /**
   * Continue-playing surface: the user's own recently-played worlds, newest first.
   * Distinct from recommendations (which are discovery / not-yet-played).
   */
  async recentlyPlayed(userId: string, withinDays = 7, limit = 10): Promise<string[]> {
    const cutoff = this.now() - withinDays * DAY_MS;
    const mine = (await this.store.byUser(userId))
      .filter((r) => r.played_at >= cutoff)
      .sort((a, b) => b.played_at - a.played_at);
    const seen = new Set<string>();
    const out: string[] = [];
    for (const r of mine) {
      if (!seen.has(r.world_id)) {
        seen.add(r.world_id);
        out.push(r.world_id);
      }
      if (out.length >= limit) break;
    }
    return out;
  }

  // ---- CW7: retention ----

  /**
   * Compute a retention signal for a user from their play history.
   */
  async retentionForUser(userId: string): Promise<RetentionSignal> {
    const recs = (await this.store.byUser(userId)).sort((a, b) => a.played_at - b.played_at);

    if (recs.length === 0) {
      return {
        user_id: userId,
        first_played_at: null,
        last_played_at: null,
        distinct_days_active: 0,
        total_sessions: 0,
        total_duration: 0,
        worlds_played: 0,
        is_retained_d7: false,
        is_retained_d30: false,
      };
    }

    const first = recs[0].played_at;
    const last = recs[recs.length - 1].played_at;
    const dayKey = (ts: number) => Math.floor(ts / DAY_MS);
    const distinctDays = new Set(recs.map((r) => dayKey(r.played_at)));
    const firstDay = dayKey(first);

    const retainedD7 = recs.some((r) => dayKey(r.played_at) - firstDay >= 7);
    const retainedD30 = recs.some((r) => dayKey(r.played_at) - firstDay >= 30);

    return {
      user_id: userId,
      first_played_at: first,
      last_played_at: last,
      distinct_days_active: distinctDays.size,
      total_sessions: recs.length,
      total_duration: recs.reduce((s, r) => s + r.duration, 0),
      worlds_played: new Set(recs.map((r) => r.world_id)).size,
      is_retained_d7: retainedD7,
      is_retained_d30: retainedD30,
    };
  }

  /**
   * Aggregate DAU for a given day (CW7 retention dashboards).
   */
  async dauForDay(dayEpochMs: number): Promise<number> {
    const dayKey = Math.floor(dayEpochMs / DAY_MS);
    const all = await this.store.all();
    const users = new Set(all.filter((r) => Math.floor(r.played_at / DAY_MS) === dayKey).map((r) => r.user_id));
    return users.size;
  }
}

// ============================================================================
// FACTORY
// ============================================================================

export const playHistoryService = new PlayHistoryService(new InMemoryPlayHistoryStore());
