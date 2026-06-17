// CREATOR STUDIO surface — authed, creator role. studio.games.dcsai.ai.
import { Router } from 'express';
import { supa } from '../lib/supabase.js';
import { getUser } from '../lib/auth.js';

export const studioRouter = Router();

studioRouter.use(async (req, res, next) => {
  const u = await getUser(req);
  if (!u) return res.status(401).json({ ok: false, error: 'invalid_session' });
  if (!u.is_creator) return res.status(403).json({ ok: false, error: 'not_a_creator' });
  (req as any).user = u; next();
});
const uid = (req: any) => req.user.id as string;

studioRouter.get('/overview', async (req, res) => {
  if (!supa) return res.json({ ok: true, kpis: {}, suggestions: [], note: 'db_not_provisioned' });
  const worlds = (await supa.from('dcsgames_worlds').select('id, total_plays, rating_avg').eq('creator_id', uid(req))).data || [];
  const ids = worlds.map((w: any) => w.id);
  let revenue = 0, dauSum = 0, days = 0;
  if (ids.length) {
    const an = (await supa.from('dcsgames_world_analytics').select('dau, revenue_cents').in('world_id', ids)).data || [];
    an.forEach((r: any) => { revenue += r.revenue_cents || 0; dauSum += r.dau || 0; days++; });
  }
  const plays = worlds.reduce((s: number, w: any) => s + (w.total_plays || 0), 0);
  const rating = worlds.length ? (worlds.reduce((s: number, w: any) => s + Number(w.rating_avg || 0), 0) / worlds.length) : 0;
  res.set('Cache-Control', 'private, max-age=20');
  return res.json({
    ok: true,
    kpis: { players: plays, revenue_cents: revenue, retention: 0, followers: 0, rating: Number(rating.toFixed(2)), engagement: days ? Math.round(dauSum / days) : 0 },
    suggestions: [], // AI Director suggestions wire to the analytics model
  });
});

studioRouter.get('/worlds', async (req, res) => {
  if (!supa) return res.json({ ok: true, worlds: [], note: 'db_not_provisioned' });
  let q = supa.from('dcsgames_worlds').select('*').eq('creator_id', uid(req));
  if (req.query.status) q = q.eq('status', String(req.query.status));
  const { data } = await q.order('updated_at', { ascending: false });
  return res.json({ ok: true, worlds: data || [] });
});

studioRouter.post('/worlds', async (req, res) => {
  if (!supa) return res.status(503).json({ ok: false, error: 'db_not_provisioned' });
  const b = req.body || {};
  const { data, error } = await supa.from('dcsgames_worlds').insert({
    slug: String(b.slug || 'world-' + Date.now()), title: String(b.title || 'Untitled'),
    creator_id: uid(req), genre: String(b.genre || 'adventure'), maturity: b.maturity || '13+', status: 'draft',
  }).select('id, slug').single();
  if (error) return res.status(500).json({ ok: false, error: error.message });
  return res.json({ ok: true, world: data });
});

studioRouter.post('/worlds/:id/publish', async (req, res) => {
  if (!supa) return res.status(503).json({ ok: false, error: 'db_not_provisioned' });
  await supa.from('dcsgames_worlds').update({ status: 'published', updated_at: new Date().toISOString() }).eq('id', req.params.id).eq('creator_id', uid(req));
  return res.json({ ok: true });
});

// AI generation — GATED on the AI model + sandbox (DK/ops provision). Until then
// returns a structured MOCK proposal so the Studio UI is fully clickable. Never fakes
// a "live generated" claim — the response is flagged source:"mock".
studioRouter.post('/generate', async (req, res) => {
  const b = req.body || {};
  const builder = String(b.builder || 'world');
  const prompt = String(b.prompt || '');
  return res.json({
    ok: true, source: 'mock', builder, prompt,
    note: 'ai_sandbox_not_provisioned',
    steps: ['building terrain', 'creating rooms', 'placing NPCs', 'wiring quests', 'balancing economy', 'ready to publish'],
    proposal: { genre: 'horror-survival-coop', spaces: [], spawns: [], props: [], rules: { maxPlayers: 4 } },
  });
});

studioRouter.get('/analytics', async (req, res) => {
  if (!supa) return res.json({ ok: true, metrics: {}, series: [], note: 'db_not_provisioned' });
  const worldId = req.query.world_id ? String(req.query.world_id) : null;
  let q = supa.from('dcsgames_world_analytics').select('*');
  if (worldId) q = q.eq('world_id', worldId);
  const { data } = await q.order('day', { ascending: true }).limit(90);
  const rows = data || [];
  const latest: any = rows[rows.length - 1] || {};
  res.set('Cache-Control', 'private, max-age=20');
  return res.json({ ok: true, metrics: { dau: latest.dau || 0, wau: latest.wau || 0, mau: latest.mau || 0, retention: latest.retention_d7 || 0 }, series: rows });
});

studioRouter.get('/revenue', async (req, res) => {
  if (!supa) return res.json({ ok: true, revenue: { today: 0, d7: 0, d30: 0, lifetime: 0 }, sources: {}, dark: true, note: 'db_not_provisioned' });
  const worlds = (await supa.from('dcsgames_worlds').select('id').eq('creator_id', uid(req))).data || [];
  const ids = worlds.map((w: any) => w.id);
  let lifetime = 0;
  if (ids.length) {
    const an = (await supa.from('dcsgames_world_analytics').select('revenue_cents').in('world_id', ids)).data || [];
    lifetime = an.reduce((s: number, r: any) => s + (r.revenue_cents || 0), 0);
  }
  return res.json({ ok: true, revenue: { today: 0, d7: 0, d30: 0, lifetime }, sources: {}, dark: true }); // cents; DARK
});

studioRouter.get('/atlas', async (req, res) => {
  if (!supa) return res.json({ ok: true, receipts: [], note: 'db_not_provisioned' });
  const { data } = await supa.from('dcsgames_atlas_receipts').select('*').eq('subject_type', 'creator').eq('subject_id', uid(req)).order('created_at', { ascending: false }).limit(50);
  return res.json({ ok: true, receipts: data || [] });
});
