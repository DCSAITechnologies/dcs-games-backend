// CW1 Identity — data-access layer. Talks to live Supabase when SUPABASE_URL + key are present;
// falls back to in-memory (the mock store) otherwise so tests run without live creds.
// DK deploys with env creds → same code hits the live DB. Honest: no live verification claimed here.
//
// env: SUPABASE_URL, SUPABASE_SERVICE_KEY (server-side, RLS-bypassing service role for the API),
//      PAYMENTS_LIVE=0 (money DARK).

let _supabase = null;
let _mode = "memory";

export async function getDb() {
  if (_supabase || _mode === "memory_locked") return { client: _supabase, mode: _mode };
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_KEY;
  if (url && key) {
    try {
      const { createClient } = await import("@supabase/supabase-js");
      _supabase = createClient(url, key, { auth: { persistSession: false } });
      _mode = "supabase";
    } catch (e) {
      console.warn("[cw1] @supabase/supabase-js not installed or failed; using memory:", e.message);
      _mode = "memory_locked";
    }
  } else {
    _mode = "memory_locked"; // no creds → memory (tests / local)
  }
  return { client: _supabase, mode: _mode };
}

// ---------- in-memory fallback store (same seed as the mock) ----------
import { createIdentityStore } from "./identity-slice.mjs";
const mem = createIdentityStore();

// ---------- repository: one interface, two backends ----------
// Each method returns plain objects; the service/route layer is identical regardless of backend.
export function makeRepo(db) {
  const live = db.mode === "supabase";
  const sb = db.client;

  async function getUser(id) {
    if (!live) return mem.users.get(id) || null;
    const { data } = await sb.from("dcsgames_users").select("*").eq("id", id).single();
    return data || null;
  }
  async function upsertUser(u) {
    if (!live) { mem.users.set(u.id, { ...(mem.users.get(u.id)||{}), ...u }); return mem.users.get(u.id); }
    const { data } = await sb.from("dcsgames_users").upsert(u).select().single();
    return data;
  }
  async function getProfile(id) {
    if (!live) return mem.profiles.get(id) || null;
    const { data } = await sb.from("dcsgames_profiles").select("*").eq("id", id).single();
    return data || null;
  }
  async function listFriends(me) {
    if (!live) return mem.friends.filter(f => f.a_id===me || f.b_id===me).map(f => ({ id: f.a_id===me?f.b_id:f.a_id, status: f.status }));
    const { data } = await sb.from("dcsgames_friends").select("*").or(`a_id.eq.${me},b_id.eq.${me}`);
    return (data||[]).map(f => ({ id: f.a_id===me?f.b_id:f.a_id, status: f.status }));
  }
  async function addFriend(me, other) {
    if (!live) { mem.friends.push({ a_id:me, b_id:other, status:"requested" }); return { id:other, status:"requested" }; }
    await sb.from("dcsgames_friends").insert({ a_id:me, b_id:other, status:"requested" });
    return { id:other, status:"requested" };
  }
  async function removeFriend(me, other) {
    if (!live) { mem.friends = mem.friends.filter(f => !((f.a_id===me&&f.b_id===other)||(f.b_id===me&&f.a_id===other))); return { id:other, status:"removed" }; }
    await sb.from("dcsgames_friends").delete().or(`and(a_id.eq.${me},b_id.eq.${other}),and(a_id.eq.${other},b_id.eq.${me})`);
    return { id:other, status:"removed" };
  }
  async function acceptFriend(me, other) {
    if (!live) { const f = mem.friends.find(x=>x.a_id===other&&x.b_id===me); if(f) f.status="accepted"; return { id:other, status:"accepted" }; }
    await sb.from("dcsgames_friends").update({ status:"accepted" }).eq("a_id", other).eq("b_id", me);
    return { id:other, status:"accepted" };
  }
  async function createParty(host) {
    const id = "pty_" + Date.now() + Math.random().toString(36).slice(2,6);
    if (!live) { mem.parties.set(id, { id, host, members:[host], world_id:null }); return mem.parties.get(id); }
    await sb.from("dcsgames_parties").insert({ id, host });
    await sb.from("dcsgames_party_members").insert({ party_id:id, user_id:host });
    return { id, host, members:[host], world_id:null };
  }
  async function joinParty(id, me) {
    if (!live) { const p = mem.parties.get(id); if(!p) return null; if(!p.members.includes(me)) p.members.push(me); return p; }
    await sb.from("dcsgames_party_members").upsert({ party_id:id, user_id:me });
    const { data:members } = await sb.from("dcsgames_party_members").select("user_id").eq("party_id", id);
    const { data:party } = await sb.from("dcsgames_parties").select("*").eq("id", id).single();
    return party ? { ...party, members:(members||[]).map(m=>m.user_id) } : null;
  }
  async function getSubscription(me) {
    if (!live) return mem.subscriptions.get(me) || { plan:"free", status:"none", _shadow:true };
    const { data } = await sb.from("dcsgames_subscriptions").select("*").eq("user_id", me).single();
    return data || { plan:"free", status:"none", _shadow:true };
  }
  // studios
  async function createStudio(owner, name) {
    const id = "std_" + Date.now() + Math.random().toString(36).slice(2,6);
    if (!live) { mem.studios.set(id, { id, name, owner, members:[{id:owner,role:"owner"}], worlds:[], split:null }); return mem.studios.get(id); }
    await sb.from("dcsgames_studios").insert({ id, name, owner });
    await sb.from("dcsgames_studio_members").insert({ studio_id:id, user_id:owner, role:"owner" });
    return { id, name, owner, members:[{id:owner,role:"owner"}], worlds:[], split:null };
  }
  async function getStudio(id) {
    if (!live) return mem.studios.get(id) || null;
    const { data:st } = await sb.from("dcsgames_studios").select("*").eq("id", id).single();
    if (!st) return null;
    const { data:members } = await sb.from("dcsgames_studio_members").select("user_id,role").eq("studio_id", id);
    return { ...st, members:(members||[]).map(m=>({id:m.user_id,role:m.role})) };
  }
  async function setStudioSplit(id, split) {
    if (!live) { const st = mem.studios.get(id); if(st) st.split = split; return st; }
    await sb.from("dcsgames_studios").update({ split }).eq("id", id);
    return getStudio(id);
  }

  async function leaveParty(id, me) {
    if (!live) { const p = mem.parties.get(id); if(p) p.members = p.members.filter(x=>x!==me); return p||null; }
    await sb.from("dcsgames_party_members").delete().eq("party_id", id).eq("user_id", me);
    const { data:members } = await sb.from("dcsgames_party_members").select("user_id").eq("party_id", id);
    const { data:party } = await sb.from("dcsgames_parties").select("*").eq("id", id).single();
    return party ? { ...party, members:(members||[]).map(m=>m.user_id) } : null;
  }
  async function updateProfile(id, patch) {
    const allowed = (({ avatar_url, bio, achievements }) => {
      const o = { avatar_url, bio };
      if (Array.isArray(achievements)) o.achievements = achievements; // achievements editable (array of strings)
      return o;
    })(patch);
    // drop undefined keys so we only write what was provided
    Object.keys(allowed).forEach(k => allowed[k] === undefined && delete allowed[k]);
    if (!live) { const p = mem.profiles.get(id) || { id }; mem.profiles.set(id, { ...p, ...allowed }); return mem.profiles.get(id); }
    const { data } = await sb.from("dcsgames_profiles").upsert({ id, ...allowed }).select().single();
    return data;
  }
  async function blockFriend(me, other) {
    if (!live) { mem.friends = mem.friends.filter(f => !((f.a_id===me&&f.b_id===other)||(f.b_id===me&&f.a_id===other))); mem.friends.push({ a_id:me, b_id:other, status:"blocked" }); return { id:other, status:"blocked" }; }
    await sb.from("dcsgames_friends").delete().or(`and(a_id.eq.${me},b_id.eq.${other}),and(a_id.eq.${other},b_id.eq.${me})`);
    await sb.from("dcsgames_friends").insert({ a_id:me, b_id:other, status:"blocked" });
    return { id:other, status:"blocked" };
  }
  // teams
  async function createTeam(owner, name) {
    const id = "team_" + Date.now() + Math.random().toString(36).slice(2,6);
    if (!live) { mem.teams.set(id, { id, name, owner, members:[{id:owner,role:"owner"}] }); return mem.teams.get(id); }
    await sb.from("dcsgames_teams").insert({ id, name, owner });
    await sb.from("dcsgames_team_members").insert({ team_id:id, user_id:owner, role:"owner" });
    return { id, name, owner, members:[{id:owner,role:"owner"}] };
  }
  async function addTeamMember(id, userId, role) {
    if (!live) { const t = mem.teams.get(id); if(!t) return null; t.members.push({ id:userId, role }); return t; }
    await sb.from("dcsgames_team_members").upsert({ team_id:id, user_id:userId, role });
    const { data:members } = await sb.from("dcsgames_team_members").select("user_id,role").eq("team_id", id);
    const { data:team } = await sb.from("dcsgames_teams").select("*").eq("id", id).single();
    return team ? { ...team, members:(members||[]).map(m=>({id:m.user_id,role:m.role})) } : null;
  }
  // orgs (+ seats)
  async function createOrg(owner, name, seats) {
    const id = "org_" + Date.now() + Math.random().toString(36).slice(2,6);
    if (!live) { mem.orgs.set(id, { id, name, billing_owner:owner, seats, members:[{id:owner,role:"owner"}] }); return mem.orgs.get(id); }
    await sb.from("dcsgames_orgs").insert({ id, name, billing_owner:owner, seats });
    await sb.from("dcsgames_org_members").insert({ org_id:id, user_id:owner, role:"owner" });
    return { id, name, billing_owner:owner, seats, members:[{id:owner,role:"owner"}] };
  }
  async function getOrg(id) {
    if (!live) return mem.orgs.get(id) || null;
    const { data:org } = await sb.from("dcsgames_orgs").select("*").eq("id", id).single();
    if (!org) return null;
    const { data:members } = await sb.from("dcsgames_org_members").select("user_id,role").eq("org_id", id);
    return { ...org, members:(members||[]).map(m=>({id:m.user_id,role:m.role})) };
  }
  async function addOrgMember(id, userId, role) {
    if (!live) { const o = mem.orgs.get(id); if(!o) return null; o.members.push({ id:userId, role }); return o; }
    await sb.from("dcsgames_org_members").upsert({ org_id:id, user_id:userId, role });
    return getOrg(id);
  }
  async function addStudioMember(id, userId, role) {
    if (!live) { const s = mem.studios.get(id); if(!s) return null; if(!s.members.some(x=>x.id===userId)) s.members.push({ id:userId, role }); return s; }
    await sb.from("dcsgames_studio_members").upsert({ studio_id:id, user_id:userId, role });
    return getStudio(id);
  }

  async function scheduleDeletion(id) {
    const scheduled_at = new Date().toISOString();
    const purge_at = new Date(Date.now() + 30*24*60*60*1000).toISOString(); // 30-day grace
    if (!live) { const u = mem.users.get(id); if(!u) return null; u.deletion_scheduled_at = scheduled_at; u.deletion_purge_at = purge_at; return { id, scheduled_at, purge_at }; }
    await sb.from("dcsgames_users").update({ deletion_scheduled_at: scheduled_at, deletion_purge_at: purge_at }).eq("id", id);
    return { id, scheduled_at, purge_at };
  }
  async function cancelDeletion(id) {
    if (!live) { const u = mem.users.get(id); if(u){ u.deletion_scheduled_at=null; u.deletion_purge_at=null; } return { id, cancelled:true }; }
    await sb.from("dcsgames_users").update({ deletion_scheduled_at: null, deletion_purge_at: null }).eq("id", id);
    return { id, cancelled:true };
  }
  async function exportData(id) {
    // full portable export of everything this user owns (GDPR-style)
    const user = await getUser(id);
    if (!user) return null;
    const profile = await getProfile(id);
    const friends = await listFriends(id);
    const subscription = await getSubscription(id);
    let parties = [], studios = [];
    if (!live) {
      parties = [...mem.parties.values()].filter(p => p.members.includes(id));
      studios = [...mem.studios.values()].filter(s => s.members.some(m=>m.id===id));
    } else {
      const { data:pm } = await sb.from("dcsgames_party_members").select("party_id").eq("user_id", id);
      const { data:sm } = await sb.from("dcsgames_studio_members").select("studio_id").eq("user_id", id);
      parties = (pm||[]).map(x=>x.party_id); studios = (sm||[]).map(x=>x.studio_id);
    }
    return { exported_at: new Date().toISOString(), user, profile, friends, subscription, parties, studios };
  }

  async function listUsers(limit = 50) {
    if (!live) return [...mem.users.values()].slice(0, limit).map(u => ({ id:u.id, name:u.name, email:u.email||null, is_admin:!!u.is_admin, atlas_score:u.atlas_score, dcs_plus:!!u.dcs_plus }));
    const { data } = await sb.from("dcsgames_users").select("id,name,email,is_admin,atlas_score,dcs_plus").limit(limit);
    return data || [];
  }
  async function setAdmin(id, makeAdmin) {
    if (!live) { const u = mem.users.get(id); if(!u) return null; u.is_admin = !!makeAdmin; return { id, is_admin:!!makeAdmin }; }
    await sb.from("dcsgames_users").update({ is_admin: !!makeAdmin }).eq("id", id);
    return { id, is_admin: !!makeAdmin };
  }

  async function createReport(reporterId, targetId, reason) {
    const id = "rpt_" + Date.now() + Math.random().toString(36).slice(2,6);
    const report = { id, reporter_id:reporterId, target_id:targetId, reason:reason||"", state:"open", action:null, created_at:new Date().toISOString() };
    if (!live) { mem.reports = mem.reports || new Map(); mem.reports.set(id, report); return report; }
    const { data } = await sb.from("dcsgames_reports").insert(report).select().single();
    return data || report;
  }
  async function getReport(id) {
    if (!live) { mem.reports = mem.reports || new Map(); return mem.reports.get(id) || null; }
    const { data } = await sb.from("dcsgames_reports").select("*").eq("id", id).single();
    return data || null;
  }
  async function listReports(state) {
    if (!live) { mem.reports = mem.reports || new Map(); const all=[...mem.reports.values()]; return state ? all.filter(r=>r.state===state) : all; }
    let q = sb.from("dcsgames_reports").select("*"); if (state) q = q.eq("state", state);
    const { data } = await q; return data || [];
  }
  async function saveReport(report) {
    if (!live) { mem.reports.set(report.id, report); return report; }
    const { data } = await sb.from("dcsgames_reports").update(report).eq("id", report.id).select().single();
    return data || report;
  }
  async function writeAudit(entry) {
    if (!live) { mem.audit = mem.audit || []; mem.audit.push(entry); return entry; }
    await sb.from("dcsgames_ts_audit").insert(entry); return entry;
  }
  // KYC shell (DARK): stores ONLY status + a provider ref, never PII. Server-side only.
  async function getKyc(userId) {
    if (!live) { mem.kyc = mem.kyc || new Map(); return mem.kyc.get(userId) || { user_id:userId, status:"none", _dark:true }; }
    const { data } = await sb.from("dcsgames_payout_kyc").select("user_id,status,provider_ref").eq("user_id", userId).single();
    return data || { user_id:userId, status:"none", _dark:true };
  }
  async function setKycStatus(userId, status, providerRef) {
    const row = { user_id:userId, status, provider_ref:providerRef||null, _dark:true };
    if (!live) { mem.kyc = mem.kyc || new Map(); mem.kyc.set(userId, row); return row; }
    await sb.from("dcsgames_payout_kyc").upsert(row); return row;
  }

  return { live, getUser, upsertUser, getProfile, updateProfile, listFriends, addFriend, removeFriend, acceptFriend, blockFriend,
           createParty, joinParty, leaveParty, getSubscription, createStudio, getStudio, setStudioSplit, addStudioMember,
           createTeam, addTeamMember, createOrg, getOrg, addOrgMember, scheduleDeletion, cancelDeletion, exportData,
           listUsers, setAdmin, createReport, getReport, listReports, saveReport, writeAudit, getKyc, setKycStatus, _mem: mem };
}
