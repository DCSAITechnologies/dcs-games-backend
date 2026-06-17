// PUBLIC / MARKETING surface — no auth. Powers games.dcsai.ai homepage, explore,
// world pages, events, top creators, the live counters, and the public Atlas feed.
import { Router } from 'express';
import { supa } from '../lib/supabase.js';

export const publicRouter = Router();

const VALID_ROWS = new Set(['trending', 'most_played', 'new', 'recommended', 'highest_rated', 'fast_growing', 'recently_updated']);

publicRouter.get('/worlds', async (req, res) => {
  const row = String(req.query.row || 'trending');
  const genre = req.query.genre ? String(req.query.genre) : null;
  const limit = Math.min(60, Math.max(1, parseInt(String(req.query.limit ?? '24'), 10) || 24));
  if (!supa) return res.json({ ok: true, rows: [], note: 'db_not_provisioned' });

  let q = supa.from('dcsgames_worlds')
    .select('id, slug, title, genre, difficulty, thumbnail_url, trailer_url, rating_avg, total_plays, atlas_verified, creator_id, creator:dcsgames_users(username, display_name)')
    .eq('status', 'published');
  if (genre) q = q.eq('genre', genre);
  if (row === 'new' || row === 'recently_updated') q = q.order('updated_at', { ascending: false });
  else if (row === 'highest_rated') q = q.order('rating_avg', { ascending: false });
  else q = q.order('total_plays', { ascending: false }); // trending/most_played/fast_growing/recommended
  const { data, error } = await q.limit(limit);
  if (error) return res.status(500).json({ ok: false, error: error.message });
  // flatten the joined creator name so the public client gets a simple field
  const rows = (data || []).map((w: any) => ({
    ...w,
    creator_name: w.creator?.display_name || w.creator?.username || null,
    creator: undefined,
  }));
  res.set('Cache-Control', 'public, max-age=30');
  return res.json({ ok: true, row: VALID_ROWS.has(row) ? row : 'trending', rows });
});

publicRouter.get('/world/:slug', async (req, res) => {
  if (!supa) return res.json({ ok: true, world: null, note: 'db_not_provisioned' });
  const { data: world } = await supa.from('dcsgames_worlds').select('*').eq('slug', req.params.slug).maybeSingle();
  if (!world) return res.status(404).json({ ok: false, error: 'not_found' });
  const { data: live } = await supa.from('dcsgames_world_live').select('live_players').eq('world_id', world.id).maybeSingle();
  res.set('Cache-Control', 'public, max-age=15');
  return res.json({ ok: true, world: { ...world, live_players: live?.live_players ?? 0 } });
});

publicRouter.get('/events', async (req, res) => {
  if (!supa) return res.json({ ok: true, events: [], note: 'db_not_provisioned' });
  let q = supa.from('dcsgames_events').select('*').order('starts_at', { ascending: true });
  if (req.query.kind) q = q.eq('kind', String(req.query.kind));
  const { data } = await q.limit(50);
  res.set('Cache-Control', 'public, max-age=30');
  return res.json({ ok: true, events: data || [] });
});

publicRouter.get('/creators/top', async (_req, res) => {
  if (!supa) return res.json({ ok: true, creators: [], note: 'db_not_provisioned' });
  const { data } = await supa.from('dcsgames_users')
    .select('id, username, display_name, avatar_color, rank_tier, level')
    .eq('is_creator', true).order('level', { ascending: false }).limit(12);
  res.set('Cache-Control', 'public, max-age=60');
  return res.json({ ok: true, creators: data || [] });
});

publicRouter.get('/stats', async (_req, res) => {
  if (!supa) return res.json({ ok: true, players: 0, live: 0, worlds: 0, creators: 0, note: 'db_not_provisioned' });
  const players = await supa.from('dcsgames_users').select('id', { count: 'exact', head: true });
  const worlds = await supa.from('dcsgames_worlds').select('id', { count: 'exact', head: true }).eq('status', 'published');
  const creators = await supa.from('dcsgames_users').select('id', { count: 'exact', head: true }).eq('is_creator', true);
  const live = await supa.from('dcsgames_world_live').select('live_players');
  const liveSum = (live.data || []).reduce((s: number, r: any) => s + (r.live_players || 0), 0);
  res.set('Cache-Control', 'public, max-age=30');
  return res.json({ ok: true, players: players.count || 0, live: liveSum, worlds: worlds.count || 0, creators: creators.count || 0 });
});

publicRouter.get('/atlas/feed', async (_req, res) => {
  if (!supa) return res.json({ ok: true, feed: [], note: 'db_not_provisioned' });
  const { data } = await supa.from('dcsgames_atlas_receipts')
    .select('subject_type, subject_id, trust_status, created_at').order('created_at', { ascending: false }).limit(20);
  res.set('Cache-Control', 'public, max-age=15');
  return res.json({ ok: true, feed: data || [] });
});

publicRouter.get('/atlas/stats', async (_req, res) => {
  if (!supa) return res.json({ ok: true, verified_worlds: 0, verified_creators: 0, receipts: 0, note: 'db_not_provisioned' });
  const vw = await supa.from('dcsgames_worlds').select('id', { count: 'exact', head: true }).eq('atlas_verified', true);
  const vc = await supa.from('dcsgames_users').select('id', { count: 'exact', head: true }).eq('verified_by_atlas', 'verified');
  const rc = await supa.from('dcsgames_atlas_receipts').select('id', { count: 'exact', head: true });
  res.set('Cache-Control', 'public, max-age=30');
  return res.json({ ok: true, verified_worlds: vw.count || 0, verified_creators: vc.count || 0, receipts: rc.count || 0 });
});
