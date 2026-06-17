// Supabase service client. Until the UGC project is provisioned, SUPABASE_URL /
// SUPABASE_SERVICE_ROLE_KEY are absent → `supa` is null and routes fall back to
// honest empty/seed responses (never crash, never fabricate live user data).
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const URL = process.env.SUPABASE_URL || '';
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

export const supa: SupabaseClient | null =
  URL && KEY ? createClient(URL, KEY, { auth: { persistSession: false } }) : null;

export const dbReady = () => supa !== null;
