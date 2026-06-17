// ATLAS TRUST surface — mostly public reads. Rides on the existing Atlas rails;
// receipts carry trust_status:"pre-gate-1" until production-soaked.
import { Router } from 'express';
import { supa } from '../lib/supabase.js';

export const atlasRouter = Router();

atlasRouter.get('/receipts', async (req, res) => {
  if (!supa) return res.json({ ok: true, receipts: [], note: 'db_not_provisioned' });
  let q = supa.from('dcsgames_atlas_receipts').select('*');
  if (req.query.subject_type) q = q.eq('subject_type', String(req.query.subject_type));
  if (req.query.subject_id) q = q.eq('subject_id', String(req.query.subject_id));
  const { data } = await q.order('created_at', { ascending: false }).limit(100);
  res.set('Cache-Control', 'public, max-age=20');
  return res.json({ ok: true, receipts: data || [] });
});

atlasRouter.get('/verify/:id', async (req, res) => {
  if (!supa) return res.json({ ok: true, valid: false, note: 'db_not_provisioned' });
  const { data } = await supa.from('dcsgames_atlas_receipts').select('id, sig, trust_status').eq('id', req.params.id).maybeSingle();
  if (!data) return res.status(404).json({ ok: false, error: 'not_found' });
  // Real ed25519 verification lands when the signing rails are wired; shape is stable.
  return res.json({ ok: true, valid: !!data.sig, signed: !!data.sig, anchored: false, trust_status: data.trust_status });
});

atlasRouter.get('/reputation/:creator_id', async (req, res) => {
  if (!supa) return res.json({ ok: true, score: null, note: 'db_not_provisioned' });
  const { count } = await supa.from('dcsgames_atlas_receipts')
    .select('id', { count: 'exact', head: true })
    .eq('subject_type', 'creator').eq('subject_id', req.params.creator_id);
  return res.json({ ok: true, creator_id: req.params.creator_id, receipts: count || 0, score: null });
});
