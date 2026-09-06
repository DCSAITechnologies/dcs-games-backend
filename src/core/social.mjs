// B15 — recovering the BUILT_DARK social capabilities with real persistence.
//
// Round-2 found profiles, friends, parties, teams and studios all reachable but
// backed by a process-local Map seeded with three fixture users, so anything a
// tester did vanished on restart. It also found a column conflict that would
// have broken the first real friend request: the running code wrote
// dcsgames_friends(a_id, b_id) while the production table declared in the
// lineage baseline has (user_id, friend_id).
//
// This module is the durable replacement. It uses the BASELINE column names,
// because those are what production actually has, and every write survives a
// restart. Money stays dark: a studio may record a revenue split, and that split
// never settles anything.
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Errors } from "./errors.mjs";
import { computeLevel, publishCredits, canPublish } from "../cw1/identity-core.mjs";

const FRIEND_STATES = ["requested", "accepted", "blocked"];
const TEAM_ROLES = ["owner", "admin", "member"];
const STUDIO_ROLES = ["owner", "admin", "creator", "member"];

/** Durable JSON table with atomic writes. */
class Table {
  constructor(dir, name) {
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, name + ".json");
  }
  async all() {
    try { return JSON.parse(await fsp.readFile(this.file, "utf8")); }
    catch (e) { if (e.code === "ENOENT") return []; throw e; }
  }
  async write(rows) {
    const tmp = this.file + ".tmp-" + crypto.randomBytes(4).toString("hex");
    await fsp.writeFile(tmp, JSON.stringify(rows));
    await fsp.rename(tmp, this.file);
    return rows;
  }
  async find(pred) { return (await this.all()).filter(pred); }
  async one(pred) { return (await this.all()).find(pred) || null; }
  async insert(row) { const rows = await this.all(); rows.push(row); await this.write(rows); return row; }
  async update(pred, mut) {
    const rows = await this.all();
    const i = rows.findIndex(pred);
    if (i < 0) return null;
    rows[i] = mut(rows[i]);
    await this.write(rows);
    return rows[i];
  }
  async remove(pred) {
    const rows = await this.all();
    const kept = rows.filter((r) => !pred(r));
    await this.write(kept);
    return rows.length - kept.length;
  }
}

const id = (p) => p + "_" + crypto.randomBytes(6).toString("hex");

export function createSocialService(env = process.env) {
  const dir = path.join(env.DCS_DATA_DIR || path.join(process.cwd(), ".dcs-data"), "social");
  const principals = new Table(dir, "principals");
  const friends = new Table(dir, "friends");           // user_id / friend_id — the canonical columns
  const parties = new Table(dir, "parties");
  const partyMembers = new Table(dir, "party_members");
  const teams = new Table(dir, "teams");
  const teamMembers = new Table(dir, "team_members");
  const studios = new Table(dir, "studios");
  const studioMembers = new Table(dir, "studio_members");
  const plays = new Table(dir, "world_plays");
  const ratings = new Table(dir, "world_ratings");

  const svc = {
    dir,

    // ================================================================ profile
    /** Create the profile row on first sight. Idempotent. */
    async ensureProfile(principal) {
      if (!principal?.id) throw Errors.unauthenticated("a profile needs an authenticated principal");
      const existing = await principals.one((p) => p.principal_id === principal.id);
      if (existing) return existing;
      const row = {
        principal_id: principal.id,
        username: (principal.email ? String(principal.email).split("@")[0] : principal.id).toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 24) || principal.id,
        display_name: null,
        email: principal.email || null,
        bio: null,
        avatar_color: "#2563FF",
        xp: 0,
        worlds_created: 0,
        worlds_published: 0,
        is_internal_tester: !!principal.isInternalTester,
        created_at: new Date().toISOString(),
      };
      // A username collision must not fail a first login.
      if (await principals.one((p) => p.username === row.username)) row.username = row.username + "_" + crypto.randomBytes(2).toString("hex");
      return await principals.insert(row);
    },

    /**
     * The /me view. Level and publish credits come from the CW1 identity-core
     * rules that already exist rather than a second implementation.
     */
    async me(principal) {
      const p = await svc.ensureProfile(principal);
      // computeLevel takes trust SIGNALS, not counters. Feed it what is actually
      // known: email verification has no provider configured (Round-2 capability
      // 15), so it is false rather than assumed, and atlas_score stays 0 until a
      // real reputation exists. The level is therefore honestly conservative.
      const signals = {
        email_verified: !!p.email_verified,
        phone_verified: !!p.phone_verified,
        atlas_score: Number(p.atlas_score || 0),
        dcs_plus: false,                       // subscriptions are dark
        active_players: Number(p.active_players || 0),
        reports: Number(p.reports || 0),
        is_studio: !!p.is_studio,
      };
      const level = computeLevel(signals);
      const credits = publishCredits({ level, dcs_plus: false });
      const gate = canPublish({ level, dcs_plus: false, published_count: p.worlds_published });
      return {
        principal_id: p.principal_id,
        username: p.username,
        display_name: p.display_name,
        bio: p.bio,
        avatar_color: p.avatar_color,
        level,
        xp: p.xp,
        worlds_created: p.worlds_created,
        worlds_published: p.worlds_published,
        is_internal_tester: p.is_internal_tester,
        level_signals: signals,
        // Infinity does not survive JSON, so it is reported as null with an
        // explicit unlimited flag rather than silently becoming zero.
        publish_credits: credits === Infinity ? null : credits,
        publish_credits_unlimited: credits === Infinity,
        can_publish: { ...gate, remaining: gate.remaining === Infinity ? null : gate.remaining, unlimited: gate.remaining === Infinity },
        // Everything money-shaped is explicitly dark, not merely absent.
        economy: { payments_live: false, balance_minor: 0, dcs_plus: false, note: "money is disabled during controlled internal testing" },
        created_at: p.created_at,
      };
    },

    async updateProfile(principal, patch) {
      await svc.ensureProfile(principal);
      const allowed = ["display_name", "bio", "avatar_color"];
      const changes = {};
      for (const k of allowed) if (patch[k] !== undefined) changes[k] = patch[k] === null ? null : String(patch[k]).slice(0, k === "bio" ? 400 : 60);
      for (const k of Object.keys(patch)) {
        if (!allowed.includes(k)) throw Errors.forbidden(`'${k}' is not editable`, { meta: { editable: allowed } });
      }
      return await principals.update((p) => p.principal_id === principal.id, (p) => ({ ...p, ...changes, updated_at: new Date().toISOString() }));
    },

    async publicProfile(username) {
      const p = await principals.one((x) => x.username === String(username).toLowerCase());
      if (!p) throw Errors.notFound(`profile ${username}`);
      // A public profile shows nothing private: no email, no principal id.
      return { username: p.username, display_name: p.display_name, bio: p.bio, avatar_color: p.avatar_color, worlds_published: p.worlds_published, created_at: p.created_at };
    },

    async recordWorldCreated(principalId) {
      return await principals.update((p) => p.principal_id === principalId, (p) => ({ ...p, worlds_created: p.worlds_created + 1, xp: p.xp + 25 }));
    },
    async recordWorldPublished(principalId) {
      return await principals.update((p) => p.principal_id === principalId, (p) => ({ ...p, worlds_published: p.worlds_published + 1, xp: p.xp + 100 }));
    },

    // ================================================================ friends
    /**
     * Request a friendship. Canonical columns user_id/friend_id — the live code
     * used a_id/b_id, which does not exist in production.
     */
    async requestFriend(meId, otherId) {
      if (!meId) throw Errors.unauthenticated("a friend request needs an authenticated principal");
      if (!otherId) throw Errors.validation("friend_id is required");
      if (meId === otherId) throw Errors.validation("you cannot befriend yourself");

      const existing = await friends.one((f) =>
        (f.user_id === meId && f.friend_id === otherId) || (f.user_id === otherId && f.friend_id === meId));
      if (existing) {
        if (existing.status === "blocked") throw Errors.forbidden("this relationship is blocked");
        // They already asked you: accept rather than creating a second row.
        if (existing.status === "requested" && existing.user_id === otherId) return await svc.acceptFriend(meId, otherId);
        return { ...existing, idempotent: true };
      }
      return await friends.insert({ user_id: meId, friend_id: otherId, status: "requested", created_at: new Date().toISOString(), decided_at: null });
    },

    async acceptFriend(meId, otherId) {
      const row = await friends.one((f) => f.user_id === otherId && f.friend_id === meId && f.status === "requested");
      if (!row) throw Errors.notFound(`a pending friend request from ${otherId}`);
      return await friends.update((f) => f.user_id === otherId && f.friend_id === meId, (f) => ({ ...f, status: "accepted", decided_at: new Date().toISOString() }));
    },

    async removeFriend(meId, otherId) {
      const n = await friends.remove((f) =>
        (f.user_id === meId && f.friend_id === otherId) || (f.user_id === otherId && f.friend_id === meId));
      if (!n) throw Errors.notFound("that friendship");
      return { removed: true };
    },

    /** Accepted friends, plus incoming and outgoing requests, each clearly labelled. */
    async friendList(meId) {
      const rows = await friends.find((f) => f.user_id === meId || f.friend_id === meId);
      return {
        friends: rows.filter((f) => f.status === "accepted").map((f) => ({ id: f.user_id === meId ? f.friend_id : f.user_id, since: f.decided_at })),
        incoming: rows.filter((f) => f.status === "requested" && f.friend_id === meId).map((f) => ({ id: f.user_id, at: f.created_at })),
        outgoing: rows.filter((f) => f.status === "requested" && f.user_id === meId).map((f) => ({ id: f.friend_id, at: f.created_at })),
      };
    },

    async areFriends(a, b) {
      const row = await friends.one((f) =>
        ((f.user_id === a && f.friend_id === b) || (f.user_id === b && f.friend_id === a)) && f.status === "accepted");
      return !!row;
    },

    // ================================================================ parties
    async createParty(meId, { worldId = null, maxSize = 8, open = true } = {}) {
      if (!meId) throw Errors.unauthenticated("creating a party needs an authenticated principal");
      if (!Number.isInteger(maxSize) || maxSize < 1 || maxSize > 64) throw Errors.validation("max_size must be between 1 and 64");
      const party = { id: id("pty"), leader_id: meId, world_id: worldId, max_size: maxSize, open: !!open, created_at: new Date().toISOString(), closed_at: null };
      await parties.insert(party);
      await partyMembers.insert({ party_id: party.id, member_id: meId, joined_at: party.created_at });
      return { ...party, members: [meId] };
    },

    async getParty(partyId) {
      const p = await parties.one((x) => x.id === partyId);
      if (!p) throw Errors.notFound(`party ${partyId}`);
      const members = (await partyMembers.find((m) => m.party_id === partyId)).map((m) => m.member_id);
      return { ...p, members, size: members.length };
    },

    async joinParty(meId, partyId) {
      if (!meId) throw Errors.unauthenticated("joining a party needs an authenticated principal");
      const p = await svc.getParty(partyId);
      if (p.closed_at) throw Errors.conflict("this party has closed");
      if (p.members.includes(meId)) return { ...p, idempotent: true };
      if (!p.open) throw Errors.forbidden("this party is invite-only");
      if (p.size >= p.max_size) throw Errors.conflict(`this party is full (${p.size}/${p.max_size})`);
      await partyMembers.insert({ party_id: partyId, member_id: meId, joined_at: new Date().toISOString() });
      return await svc.getParty(partyId);
    },

    async leaveParty(meId, partyId) {
      const p = await svc.getParty(partyId);
      if (!p.members.includes(meId)) throw Errors.notFound("your membership of that party");
      await partyMembers.remove((m) => m.party_id === partyId && m.member_id === meId);
      const left = await svc.getParty(partyId);
      // A party with nobody in it is closed rather than left as a ghost row.
      if (left.size === 0) {
        await parties.update((x) => x.id === partyId, (x) => ({ ...x, closed_at: new Date().toISOString() }));
        return { ...left, closed: true };
      }
      // The leader leaving hands over rather than orphaning the party.
      if (p.leader_id === meId) await parties.update((x) => x.id === partyId, (x) => ({ ...x, leader_id: left.members[0] }));
      return await svc.getParty(partyId);
    },

    async myParties(meId) {
      const mine = await partyMembers.find((m) => m.member_id === meId);
      const out = [];
      for (const m of mine) {
        const p = await parties.one((x) => x.id === m.party_id);
        if (p && !p.closed_at) out.push(await svc.getParty(p.id));
      }
      return out;
    },

    // ================================================================== teams
    async createTeam(meId, name) {
      if (!meId) throw Errors.unauthenticated("creating a team needs an authenticated principal");
      if (!name || String(name).trim().length < 2) throw Errors.validation("a team needs a name of at least 2 characters");
      const team = { id: id("team"), name: String(name).trim().slice(0, 60), owner_id: meId, created_at: new Date().toISOString() };
      await teams.insert(team);
      await teamMembers.insert({ team_id: team.id, member_id: meId, role: "owner", joined_at: team.created_at });
      return { ...team, members: [{ member_id: meId, role: "owner" }] };
    },

    async getTeam(teamId) {
      const t = await teams.one((x) => x.id === teamId);
      if (!t) throw Errors.notFound(`team ${teamId}`);
      return { ...t, members: await teamMembers.find((m) => m.team_id === teamId) };
    },

    async addTeamMember(meId, teamId, memberId, role = "member") {
      if (!TEAM_ROLES.includes(role)) throw Errors.validation(`role must be one of: ${TEAM_ROLES.join(", ")}`);
      const t = await svc.getTeam(teamId);
      const mine = t.members.find((m) => m.member_id === meId);
      if (!mine || !["owner", "admin"].includes(mine.role)) throw Errors.forbidden("only an owner or admin can add members");
      if (role === "owner") throw Errors.forbidden("a team has exactly one owner; transfer ownership instead");
      if (t.members.some((m) => m.member_id === memberId)) return { ...t, idempotent: true };
      await teamMembers.insert({ team_id: teamId, member_id: memberId, role, joined_at: new Date().toISOString() });
      return await svc.getTeam(teamId);
    },

    async removeTeamMember(meId, teamId, memberId) {
      const t = await svc.getTeam(teamId);
      const mine = t.members.find((m) => m.member_id === meId);
      const isSelf = meId === memberId;
      if (!isSelf && (!mine || !["owner", "admin"].includes(mine.role))) throw Errors.forbidden("only an owner or admin can remove members");
      if (t.owner_id === memberId) throw Errors.forbidden("the owner cannot be removed; transfer ownership first");
      const n = await teamMembers.remove((m) => m.team_id === teamId && m.member_id === memberId);
      if (!n) throw Errors.notFound("that membership");
      return await svc.getTeam(teamId);
    },

    async myTeams(meId) {
      const mine = await teamMembers.find((m) => m.member_id === meId);
      const out = [];
      for (const m of mine) out.push(await svc.getTeam(m.team_id));
      return out;
    },

    // ================================================================ studios
    async createStudio(meId, name) {
      if (!meId) throw Errors.unauthenticated("creating a studio needs an authenticated principal");
      if (!name || String(name).trim().length < 2) throw Errors.validation("a studio needs a name of at least 2 characters");
      const studio = { id: id("std"), name: String(name).trim().slice(0, 60), owner_id: meId, created_at: new Date().toISOString() };
      await studios.insert(studio);
      await studioMembers.insert({ studio_id: studio.id, member_id: meId, role: "owner", split_bps: 10000, joined_at: studio.created_at });
      return await svc.getStudio(studio.id);
    },

    async getStudio(studioId) {
      const s = await studios.one((x) => x.id === studioId);
      if (!s) throw Errors.notFound(`studio ${studioId}`);
      const members = await studioMembers.find((m) => m.studio_id === studioId);
      return {
        ...s,
        members,
        split_total_bps: members.reduce((a, m) => a + m.split_bps, 0),
        // Recorded, never settled.
        payments_live: false,
        split_note: "revenue splits are recorded for modelling only; no money moves while PAYMENTS_LIVE is false",
      };
    },

    async setStudioSplit(meId, studioId, splits) {
      const s = await svc.getStudio(studioId);
      const mine = s.members.find((m) => m.member_id === meId);
      if (!mine || !["owner", "admin"].includes(mine.role)) throw Errors.forbidden("only an owner or admin can configure the split");
      if (!Array.isArray(splits) || !splits.length) throw Errors.validation("splits must be a non-empty array of { member_id, split_bps }");
      const total = splits.reduce((a, x) => a + Number(x.split_bps || 0), 0);
      if (total !== 10000) throw Errors.validation(`splits must total exactly 10000 basis points (100%), got ${total}`);
      for (const x of splits) {
        if (!s.members.some((m) => m.member_id === x.member_id)) throw Errors.validation(`'${x.member_id}' is not a member of this studio`);
      }
      for (const x of splits) {
        await studioMembers.update((m) => m.studio_id === studioId && m.member_id === x.member_id, (m) => ({ ...m, split_bps: Number(x.split_bps) }));
      }
      return await svc.getStudio(studioId);
    },

    async addStudioMember(meId, studioId, memberId, role = "member") {
      if (!STUDIO_ROLES.includes(role)) throw Errors.validation(`role must be one of: ${STUDIO_ROLES.join(", ")}`);
      const s = await svc.getStudio(studioId);
      const mine = s.members.find((m) => m.member_id === meId);
      if (!mine || !["owner", "admin"].includes(mine.role)) throw Errors.forbidden("only an owner or admin can add members");
      if (role === "owner") throw Errors.forbidden("a studio has exactly one owner");
      if (s.members.some((m) => m.member_id === memberId)) return { ...s, idempotent: true };
      // A new member starts on zero: adding someone must never silently dilute
      // an existing split.
      await studioMembers.insert({ studio_id: studioId, member_id: memberId, role, split_bps: 0, joined_at: new Date().toISOString() });
      return await svc.getStudio(studioId);
    },

    // ============================================================== discovery
    /** Record a real play. Discovery ranks on these rows and nothing else. */
    async recordPlay(worldId, principalId, seconds = null) {
      if (!worldId) throw Errors.validation("world_id is required");
      return await plays.insert({
        id: crypto.randomUUID(), world_id: worldId, principal_id: principalId || null,
        started_at: new Date().toISOString(), seconds: seconds == null ? null : Math.max(0, Math.round(seconds)),
      });
    },

    async rateWorld(principalId, worldId, rating) {
      if (!principalId) throw Errors.unauthenticated("rating a world needs an authenticated principal");
      if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw Errors.validation("rating must be an integer from 1 to 5");
      const existing = await ratings.one((r) => r.world_id === worldId && r.principal_id === principalId);
      if (existing) return await ratings.update((r) => r.world_id === worldId && r.principal_id === principalId, (r) => ({ ...r, rating, created_at: new Date().toISOString() }));
      return await ratings.insert({ world_id: worldId, principal_id: principalId, rating, created_at: new Date().toISOString() });
    },

    /** Measured stats for one world. Zero means zero, never a placeholder. */
    async worldStats(worldId) {
      const p = await plays.find((x) => x.world_id === worldId);
      const r = await ratings.find((x) => x.world_id === worldId);
      const players = new Set(p.map((x) => x.principal_id).filter(Boolean));
      return {
        plays: p.length,
        unique_players: players.size,
        total_seconds: p.reduce((a, x) => a + (x.seconds || 0), 0),
        rating_count: r.length,
        rating_avg: r.length ? Number((r.reduce((a, x) => a + x.rating, 0) / r.length).toFixed(2)) : null,
      };
    },

    /**
     * Browse published worlds. Sorting is over MEASURED activity, so an empty
     * platform ranks everything at zero rather than inventing popularity.
     */
    async discover(worlds, { sort = "recent", genre = null, limit = 24, q = null } = {}) {
      const rows = [];
      for (const w of worlds) {
        const stats = await svc.worldStats(w.world_id);
        const meta = w.manifest?.meta || {};
        if (genre && String(meta.genre || "").toLowerCase() !== String(genre).toLowerCase()) continue;
        if (q) {
          const hay = `${meta.title || ""} ${meta.description || ""} ${(meta.tags || []).join(" ")}`.toLowerCase();
          if (!hay.includes(String(q).toLowerCase())) continue;
        }
        rows.push({
          world_id: w.world_id,
          title: w.title || meta.title || null,
          genre: meta.genre || null,
          maturity: meta.maturity || null,
          tags: meta.tags || [],
          world_version: w.version,
          owner: w.owner_id,
          updated_at: w.updated_at,
          thumbnail_ref: w.manifest?.media?.thumbnail_ref || null,
          thumbnail_is_placeholder: !!w.manifest?.media?.thumbnail_is_placeholder,
          stats,
          // Verification is a fact about a receipt, never a decoration.
          atlas_signed: !!w.manifest?.meta?.atlas_signed,
        });
      }
      const by = {
        recent: (a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")),
        most_played: (a, b) => b.stats.plays - a.stats.plays || String(b.updated_at || "").localeCompare(String(a.updated_at || "")),
        top_rated: (a, b) => (b.stats.rating_avg ?? -1) - (a.stats.rating_avg ?? -1) || b.stats.rating_count - a.stats.rating_count,
      };
      rows.sort(by[sort] || by.recent);
      return {
        count: rows.length,
        sort,
        worlds: rows.slice(0, limit),
        note: rows.every((r) => r.stats.plays === 0)
          ? "No play activity has been recorded yet, so every world ranks equally. These are real zeros, not placeholders."
          : null,
      };
    },
  };

  return svc;
}

export { FRIEND_STATES, TEAM_ROLES, STUDIO_ROLES };
