// AUTH — signup / login proxied through the backend so the browser holds no
// Supabase keys. We sign the user up/in via Supabase Auth, ensure a matching
// dcsgames_users row (id = auth user id, the mapping getUser() expects), and
// return the access token the SPA stores and sends as Bearer on /api/* calls.
import { Router } from 'express';
import { createClient } from '@supabase/supabase-js';
import { supa } from '../lib/supabase.js';

export const authRouter = Router();

// A dedicated auth client (anon key preferred; falls back to service role if unset).
const AUTH_URL = process.env.SUPABASE_URL || '';
const AUTH_KEY = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const authClient = (AUTH_URL && AUTH_KEY) ? createClient(AUTH_URL, AUTH_KEY, { auth: { persistSession: false } }) : null;

function slugifyUsername(s: string): string {
  return (s || '').toLowerCase().replace(/[^a-z0-9_]+/g, '').slice(0, 24) || ('player' + Date.now().toString(36));
}

// Make sure a dcsgames_users row exists for this auth user (idempotent).
async function ensureUserRow(authUser: any, desiredUsername?: string) {
  if (!supa || !authUser) return null;
  const existing = (await supa.from('dcsgames_users').select('id, username, is_creator').eq('id', authUser.id).maybeSingle()).data;
  if (existing) return existing;
  // pick a unique-ish username
  let base = slugifyUsername(desiredUsername || (authUser.email || '').split('@')[0] || 'player');
  let username = base;
  for (let i = 0; i < 4; i++) {
    const taken = (await supa.from('dcsgames_users').select('id').eq('username', username).maybeSingle()).data;
    if (!taken) break;
    username = base + Math.floor(Math.random() * 9000 + 1000);
  }
  const { data, error } = await supa.from('dcsgames_users')
    .insert({ id: authUser.id, username, email: authUser.email || null })
    .select('id, username, is_creator').single();
  if (error) return existing || null;
  return data;
}

authRouter.post('/signup', async (req, res) => {
  if (!authClient || !supa) return res.status(503).json({ ok: false, error: 'auth_not_provisioned' });
  const { email, password, username } = req.body || {};
  if (!email || !password) return res.status(400).json({ ok: false, error: 'email_password_required' });

  const { data, error } = await authClient.auth.signUp({ email: String(email), password: String(password) });
  if (error) return res.status(400).json({ ok: false, error: error.message });

  // If email confirmation is ON, signUp returns no session. Try an immediate sign-in;
  // if that also yields no session, tell the client to confirm their email.
  let session = data.session;
  let user = data.user;
  if (!session) {
    const si = await authClient.auth.signInWithPassword({ email: String(email), password: String(password) });
    session = si.data.session; user = si.data.user || user;
  }
  if (user) await ensureUserRow(user, username);
  if (!session) return res.json({ ok: true, needs_confirmation: true, message: 'Check your email to confirm, then log in.' });
  const row = await ensureUserRow(user, username);
  return res.json({ ok: true, token: session.access_token, user: row });
});

authRouter.post('/login', async (req, res) => {
  if (!authClient || !supa) return res.status(503).json({ ok: false, error: 'auth_not_provisioned' });
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ ok: false, error: 'email_password_required' });

  const { data, error } = await authClient.auth.signInWithPassword({ email: String(email), password: String(password) });
  if (error || !data.session) return res.status(401).json({ ok: false, error: 'invalid_credentials' });
  const row = await ensureUserRow(data.user);
  return res.json({ ok: true, token: data.session.access_token, user: row });
});

// Lightweight session check — the SPA calls this on load with its stored token.
authRouter.get('/me', async (req, res) => {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
  if (!m || !authClient || !supa) return res.json({ ok: true, user: null });
  const { data } = await authClient.auth.getUser(m[1]);
  if (!data?.user) return res.json({ ok: true, user: null });
  const row = (await supa.from('dcsgames_users').select('id, username, is_creator, level, coins, rank_tier').eq('id', data.user.id).maybeSingle()).data;
  return res.json({ ok: true, user: row });
});
