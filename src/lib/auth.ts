// Auth helpers. Player/creator requests carry a Supabase Auth JWT as a bearer
// token; we resolve it to a dcsgames_users row. Until Supabase is wired, getUser
// returns null and authed routes respond 401 (honest — no fake session).
import type { Request } from 'express';
import { supa } from './supabase.js';

export function extractBearer(h?: string): string | null {
  if (!h) return null;
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1] : null;
}

export interface GameUser {
  id: string;
  username: string;
  is_creator: boolean;
  role: 'player' | 'creator';
}

export async function getUser(req: Request): Promise<GameUser | null> {
  const token = extractBearer(req.headers.authorization);
  if (!token || !supa) return null;
  // Validate the JWT with Supabase Auth, then map to our users table.
  const { data: auth } = await supa.auth.getUser(token);
  if (!auth?.user) return null;
  const { data: row } = await supa
    .from('dcsgames_users')
    .select('id, username, is_creator')
    .eq('id', auth.user.id)
    .maybeSingle();
  if (!row) return null;
  return { id: row.id, username: row.username, is_creator: !!row.is_creator, role: row.is_creator ? 'creator' : 'player' };
}

export function requireCreator(u: GameUser | null): u is GameUser {
  return !!u && u.is_creator;
}
