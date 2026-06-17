// PLAYER APP surface — authed. games.dcsai.ai/app.
import { Router } from 'express';
import { supa } from '../lib/supabase.js';
import { getUser } from '../lib/auth.js';

export const playerRouter = Router();

// gate every player route on a valid session
playerRouter.use(async (req, res, next) => {
  const u = await getUser(req);
  if (!u) return res.status(401).json({ ok: false, error: 'invalid_session' });
  (req as any).user = u;
  next();
});
const uid = (req: any) => (req.user.id as string);

playerRouter.get('/me', async (req, res) => {
  if (!supa) return res.json({ ok: true, user: null, note: 'db_not_provisioned' });
  const { data } = await supa.from('dcsgames_users').select('*').eq('id', uid(req)).maybeSingle();
  return res.json({ ok: true, user: data });
});

// One call powers the whole Home dashboard.
playerRouter.get('/me/home', async (req, res) => {
  if (!supa) return res.json({ ok: true, note: 'db_not_provisioned', kpis: {}, continue_playing: null, daily_missions: [], friends_activity: [], recommended: [] });
  const id = uid(req);
  const me = (await supa.from('dcsgames_users').select('*').eq('id', id).maybeSingle()).data;
  const last = (await supa.from('dcsgames_play_sessions').select('world_id, progress_pct, started_at').eq('user_id', id).order('started_at', { ascending: false }).limit(1).maybeSingle()).data;
  const recommended = (await supa.from('dcsgames_worlds').select('id, slug, title, genre, thumbnail_url, rating_avg, atlas_verified').eq('status', 'published').order('total_plays', { ascending: false }).limit(10)).data || [];
  res.set('Cache-Control', 'private, max-age=15');
  return res.json({
    ok: true,
    kpis: me ? { level: me.level, xp: me.xp, coins: me.coins, streak: me.daily_streak, rank: me.rank_tier } : {},
    continue_playing: last,
    daily_missions: [],   // wire to a missions table when added
    friends_activity: [],
    recommended,
  });
});

playerRouter.get('/me/friends', async (req, res) => {
  if (!supa) return res.json({ ok: true, friends: [], note: 'db_not_provisioned' });
  const { data } = await supa.from('dcsgames_friends').select('friend_id, status').eq('user_id', uid(req)).neq('status', 'blocked');
  return res.json({ ok: true, friends: data || [] });
});
playerRouter.post('/me/friends/invite', async (req, res) => {
  if (!supa) return res.status(503).json({ ok: false, error: 'db_not_provisioned' });
  const to = String((req.body || {}).to || '');
  const target = (await supa.from('dcsgames_users').select('id').eq('username', to).maybeSingle()).data;
  if (!target) return res.status(404).json({ ok: false, error: 'user_not_found' });
  await supa.from('dcsgames_friends').upsert({ user_id: uid(req), friend_id: target.id, status: 'pending' });
  return res.json({ ok: true });
});

playerRouter.get('/me/crew', async (req, res) => {
  if (!supa) return res.json({ ok: true, crew: null, note: 'db_not_provisioned' });
  const m = (await supa.from('dcsgames_crew_members').select('crew_id, role').eq('user_id', uid(req)).maybeSingle()).data;
  if (!m) return res.json({ ok: true, crew: null });
  const crew = (await supa.from('dcsgames_crews').select('*').eq('id', m.crew_id).maybeSingle()).data;
  return res.json({ ok: true, crew, role: m.role });
});

playerRouter.get('/me/events', async (req, res) => {
  if (!supa) return res.json({ ok: true, events: [], note: 'db_not_provisioned' });
  const { data } = await supa.from('dcsgames_events').select('*').order('starts_at', { ascending: true }).limit(50);
  return res.json({ ok: true, events: data || [] });
});

playerRouter.get('/leaderboard', async (req, res) => {
  const scope = String(req.query.scope || 'global');
  if (!supa) return res.json({ ok: true, rows: [], scope, note: 'db_not_provisioned' });
  let q = supa.from('dcsgames_leaderboard').select('user_id, score, scope, season').eq('scope', scope);
  if (req.query.ref) q = q.eq('scope_ref', String(req.query.ref));
  const { data } = await q.order('score', { ascending: false }).limit(100);
  res.set('Cache-Control', 'private, max-age=30');
  return res.json({ ok: true, scope, rows: (data || []).map((r: any, i: number) => ({ rank: i + 1, ...r })) });
});

playerRouter.get('/market', async (req, res) => {
  if (!supa) return res.json({ ok: true, items: [], note: 'db_not_provisioned' });
  let q = supa.from('dcsgames_market_items').select('id, type, title, creator_id, price_cents, preview_url, rating_avg, sales_count, atlas_verified');
  if (req.query.type) q = q.eq('type', String(req.query.type));
  const { data } = await q.order('sales_count', { ascending: false }).limit(48);
  res.set('Cache-Control', 'private, max-age=20');
  return res.json({ ok: true, items: data || [] }); // prices in cents; purchases DARK
});

playerRouter.get('/me/battle-pass', async (req, res) => {
  if (!supa) return res.json({ ok: true, pass: null, note: 'db_not_provisioned' });
  const { data } = await supa.from('dcsgames_battle_pass').select('*').eq('user_id', uid(req)).order('season', { ascending: false }).limit(1).maybeSingle();
  return res.json({ ok: true, pass: data });
});
playerRouter.post('/me/daily-rewards/claim', async (req, res) => {
  if (!supa) return res.status(503).json({ ok: false, error: 'db_not_provisioned' });
  const today = new Date().toISOString().slice(0, 10);
  const { error } = await supa.from('dcsgames_daily_rewards').upsert({ user_id: uid(req), reward_date: today }, { onConflict: 'user_id,reward_date' });
  if (error) return res.status(500).json({ ok: false, error: error.message });
  return res.json({ ok: true, claimed: today });
});

playerRouter.get('/me/inventory', async (req, res) => {
  if (!supa) return res.json({ ok: true, items: [], note: 'db_not_provisioned' });
  let q = supa.from('dcsgames_inventory').select('*').eq('user_id', uid(req));
  if (req.query.kind) q = q.eq('kind', String(req.query.kind));
  const { data } = await q.order('acquired_at', { ascending: false });
  return res.json({ ok: true, items: data || [] });
});

playerRouter.get('/me/notifications', async (req, res) => {
  if (!supa) return res.json({ ok: true, items: [], unread: 0, note: 'db_not_provisioned' });
  const { data } = await supa.from('dcsgames_notifications').select('*').eq('user_id', uid(req)).order('created_at', { ascending: false }).limit(30);
  const items = data || [];
  return res.json({ ok: true, items, unread: items.filter((n: any) => !n.read_at).length });
});
playerRouter.post('/me/notifications/read', async (req, res) => {
  if (!supa) return res.status(503).json({ ok: false, error: 'db_not_provisioned' });
  const id = (req.body || {}).id ? String((req.body as any).id) : null;
  let q = supa.from('dcsgames_notifications').update({ read_at: new Date().toISOString() }).eq('user_id', uid(req)).is('read_at', null);
  if (id) q = q.eq('id', id);
  await q;
  return res.json({ ok: true });
});

playerRouter.get('/profile/:username', async (req, res) => {
  if (!supa) return res.json({ ok: true, profile: null, note: 'db_not_provisioned' });
  const u = (await supa.from('dcsgames_users').select('id, username, display_name, avatar_color, level, rank_tier').eq('username', req.params.username).maybeSingle()).data;
  if (!u) return res.status(404).json({ ok: false, error: 'not_found' });
  const p = (await supa.from('dcsgames_profiles').select('*').eq('user_id', u.id).maybeSingle()).data;
  return res.json({ ok: true, profile: { ...u, ...(p || {}) } });
});
