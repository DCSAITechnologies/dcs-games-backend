// CW1 identity store for the gateway: durable on the same Supabase client as the
// rest of the data layer, or memory ONLY where memory is permitted.
//
// WHAT WAS WRONG (staging L1, 1 Oct 2026). server.mts mounted the T&S/KYC slice
// with a literal `{ mode: "memory" }`, so every staging deployment logged
//   [cw1][db] IN-MEMORY FALLBACK ENGAGED (reason=repo_constructed_without_client)
// and served anyway. Whatever CW1 held was lost at each restart. db.mjs's own
// Supabase path could not have been switched on to fix it: it reads
// SUPABASE_SERVICE_KEY (deployments set SUPABASE_SERVICE_ROLE_KEY), imports
// @supabase/supabase-js (not a dependency), and its queries name columns and
// tables the v14 schema does not have (profiles.id, friends.a_id/b_id,
// reports.target_id/state, dcsgames_ts_audit, dcsgames_payout_kyc).
//
// WHAT THIS DOES
//   * The durable repo is built on src/core/collection.mjs — the same client
//     (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY over PostgREST) and the same
//     file shadow + durable pending journal that social, safety and
//     subscriptions use — over the v14 tables that exist: dcsgames_users and
//     dcsgames_profiles, with rows projected to their real columns.
//   * Reports and the moderation audit trail are already durable in
//     src/core/safety.mjs (dcsgames_reports, dcsgames_moderation_actions); the
//     durable repo does not keep a second copy, and the slice sends a
//     moderator there. Payout KYC has NO table in v14, so in durable mode it
//     refuses to write (503) rather than holding rows in memory.
//   * resolveDcsEnv + checkCw1Boot are the fail-closed boot guard: DCS_ENV
//     staging or production without a durable, reachable CW1 store must not serve.
//
// The memory repo (db.mjs makeRepo) remains for local, test and CI runs, where
// it is intended, and is still announced when it engages.
import { createCollection } from "../core/collection.mjs";
import { makeRepo } from "./db.mjs";

export const DCS_ENVS = ["local", "development", "test", "ci", "staging", "production"];
export const DURABLE_REQUIRED = new Set(["staging", "production"]);

/**
 * Which environment this process is, and whether CW1 must be durable here.
 * DCS_ENV is the switch. On Railway with DCS_ENV unset we refuse to guess: a
 * deployed process that forgot to say what it is must not quietly behave as local.
 */
export function resolveDcsEnv(env = process.env) {
  const raw = String(env.DCS_ENV ?? "").trim().toLowerCase();
  const onRailway = !!(env.RAILWAY_ENVIRONMENT_NAME || env.RAILWAY_ENVIRONMENT);
  if (!raw) {
    if (onRailway) return { name: null, durableRequired: true, problem: "DCS_ENV is not set on a Railway deployment; set DCS_ENV=staging or DCS_ENV=production" };
    return { name: "local", durableRequired: false, problem: null, implicit: true };
  }
  if (!DCS_ENVS.includes(raw)) return { name: raw, durableRequired: true, problem: `DCS_ENV=${raw} is not one of ${DCS_ENVS.join("|")}` };
  return { name: raw, durableRequired: DURABLE_REQUIRED.has(raw), problem: null };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Drop undefined so a write names only the columns it means to set (NOT NULL DEFAULT columns stay defaulted). */
const defined = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

function notServed(method) {
  return async () => {
    const e = new Error(`cw1 durable repo: ${method} is not served by the gateway CW1 store; friends, parties, teams, studios, orgs and subscriptions are durable in src/core/social.mjs and src/core/subscriptions.mjs (/social/*, /me/subscription)`);
    e.code = "cw1_not_served";
    throw e;
  };
}

/**
 * The durable CW1 repo, over v14 dcsgames_users / dcsgames_profiles.
 * Same method names as db.mjs makeRepo for what the gateway actually uses.
 */
export function makeDurableRepo({ env, dir, fetchImpl } = {}) {
  const users = createCollection({ dir, name: "cw1_users", table: "dcsgames_users", primaryKey: ["id"], env, fetchImpl });
  const profiles = createCollection({ dir, name: "cw1_profiles", table: "dcsgames_profiles", primaryKey: ["user_id"], env, fetchImpl });
  const collections = { users, profiles };

  // The CW1 shape callers know ({ id, name, ... }) over the v14 row.
  const userOut = (row) => row ? { ...row, name: row.display_name ?? row.username } : null;

  async function getUser(id) {
    if (!id) return null;
    return userOut(await users.one((r) => r.id === id));
  }
  async function upsertUser(u) {
    if (!u || !UUID.test(String(u.id))) {
      const e = new Error("cw1: a durable user id must be the principal's uuid"); e.code = "cw1_bad_user_id"; throw e;
    }
    const row = defined({
      id: u.id,
      username: u.username ?? u.name ?? u.id,              // v14: unique, not null
      display_name: u.display_name ?? u.name,
      email: u.email,
    });
    await users.upsert((r) => r.id === u.id, row);
    return getUser(u.id);
  }
  async function getProfile(id) {
    const row = await profiles.one((r) => r.user_id === id);
    return row ? { id: row.user_id, ...row } : null;
  }
  async function updateProfile(id, patch = {}) {
    // dcsgames_profiles.user_id references dcsgames_users(id): no orphan profiles.
    if (!(await getUser(id))) { const e = new Error("cw1: no such user for this profile"); e.code = "cw1_no_user"; throw e; }
    const stored = defined({ bio: patch.bio, banner_color: patch.banner_color });
    const notStored = Object.keys(patch).filter((k) => patch[k] !== undefined && !(k in stored));
    await profiles.upsert((r) => r.user_id === id, { user_id: id, ...stored, updated_at: new Date().toISOString() });
    const out = await getProfile(id);
    return notStored.length ? { ...out, not_stored: notStored } : out;
  }

  /** Every CW1 table the gateway relies on, one round trip each. Throws naming the table. */
  async function probe() {
    for (const [name, c] of Object.entries(collections)) {
      try { await c.all(); }
      catch (e) { const err = new Error(`cw1 store probe failed for ${name === "users" ? "dcsgames_users" : "dcsgames_profiles"}: ${e?.message || e}`); err.cause = e; throw err; }
      if (c.degraded) throw new Error(`cw1 store probe: ${name === "users" ? "dcsgames_users" : "dcsgames_profiles"} is degraded: ${JSON.stringify(c.degraded)}`);
    }
  }

  return {
    live: true, durable: true, kind: "supabase",
    // Read by ts-sso-kyc-slice.mjs: where these concerns are durable instead.
    reports_superseded_by: { list: "/safety/reports", moderate: "/safety/reports/:id/moderate", history: "/safety/moderation-history" },
    kyc_store: "not_provisioned",
    describe: () => ({ mode: "supabase", durable: true, tables: ["dcsgames_users", "dcsgames_profiles"],
      reports_and_audit: "src/core/safety.mjs (dcsgames_reports, dcsgames_moderation_actions)",
      kyc: "not provisioned: v14 has no payout-KYC table; writes are refused, never held in memory" }),
    getUser, upsertUser, getProfile, updateProfile, probe, _collections: collections,
    // The rest of the CW1 surface is not served by the gateway; fail loudly if anything reaches for it.
    listReports: undefined, getReport: undefined, saveReport: undefined, writeAudit: undefined,
    getKyc: undefined, setKycStatus: undefined,
    listFriends: notServed("listFriends"), addFriend: notServed("addFriend"), createParty: notServed("createParty"),
    getSubscription: notServed("getSubscription"), createStudio: notServed("createStudio"), createTeam: notServed("createTeam"),
    createOrg: notServed("createOrg"), exportData: notServed("exportData"), listUsers: notServed("listUsers"), setAdmin: notServed("setAdmin"),
  };
}

/**
 * Build the gateway's CW1 store. Durable when SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
 * are set (and, with probe, reachable); memory otherwise. Never throws for memory —
 * whether memory is ALLOWED is checkCw1Boot's decision, made with the environment.
 */
export async function createCw1Store({ env = process.env, dir, fetchImpl, probe = true, probeTimeoutMs = 10000 } = {}) {
  const configured = !!(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY);
  if (!configured) {
    const repo = makeRepo({ mode: "memory" });
    return { mode: "memory", configured: false, healthy: false, reason: "no_credentials", problem: "SUPABASE_URL and/or SUPABASE_SERVICE_ROLE_KEY are not set", repo, describe: () => repo.describe() };
  }
  const repo = makeDurableRepo({ env, dir, fetchImpl });
  let healthy = true, problem = null;
  if (probe) {
    try {
      await Promise.race([
        repo.probe(),
        new Promise((_, rej) => setTimeout(() => rej(new Error(`cw1 store probe timed out after ${probeTimeoutMs}ms`)), probeTimeoutMs).unref?.()),
      ]);
    } catch (e) { healthy = false; problem = e?.message || String(e); }
  }
  // `reason` is a code, safe for /health; `problem` is the detail, for the boot log only.
  return { mode: "supabase", configured: true, healthy, reason: healthy ? null : "probe_failed", problem, repo, describe: () => ({ ...repo.describe(), healthy, reason: healthy ? null : "probe_failed" }) };
}

/**
 * The boot decision. { ok:false } means: do not serve.
 *   staging/production (or an unknown/missing-on-Railway DCS_ENV): durable AND healthy, or refuse.
 *   local/development/test/ci: memory is permitted, and announced by db.mjs.
 */
export function checkCw1Boot(store, env = process.env) {
  const e = resolveDcsEnv(env);
  if (e.problem) return { ok: false, env: e.name, reason: e.problem };
  if (!e.durableRequired) return { ok: true, env: e.name, mode: store.mode };
  if (store.mode !== "supabase") return { ok: false, env: e.name, reason: `DCS_ENV=${e.name} requires a durable CW1 store, but ${store.problem}` };
  if (!store.healthy) return { ok: false, env: e.name, reason: `DCS_ENV=${e.name} requires a durable CW1 store, but the configured Supabase client is not usable: ${store.problem}` };
  return { ok: true, env: e.name, mode: store.mode };
}
