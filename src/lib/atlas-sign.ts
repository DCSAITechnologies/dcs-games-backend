// Atlas receipt signing for DCS Games. Real ed25519 signatures + a per-subject
// hash chain (prev_hash), persisted to dcsgames_atlas_receipts. The signing key
// comes from ATLAS_SIGNING_KEY (PKCS8 PEM in env); if absent we generate an
// ephemeral key so dev still works (receipts are signed, just not with the prod key).
import crypto from 'crypto';
import { supa } from './supabase.js';

let _priv: crypto.KeyObject | null = null;
let _pubB64: string | null = null;

function keys() {
  if (_priv) return { priv: _priv, pub: _pubB64! };
  const pem = process.env.ATLAS_SIGNING_KEY;
  if (pem) {
    _priv = crypto.createPrivateKey(pem);
  } else {
    // Ephemeral dev key — signatures are valid within this process lifetime.
    const { privateKey } = crypto.generateKeyPairSync('ed25519');
    _priv = privateKey;
    console.warn('[atlas-sign] ATLAS_SIGNING_KEY not set — using an ephemeral dev key');
  }
  const pub = crypto.createPublicKey(_priv);
  _pubB64 = pub.export({ type: 'spki', format: 'der' }).toString('base64');
  return { priv: _priv, pub: _pubB64 };
}

export function atlasPublicKey(): string { return keys().pub; }

function sha256Hex(s: string): string { return crypto.createHash('sha256').update(s).digest('hex'); }

// Deterministic JSON (sorted keys) so signing + verifying produce identical bytes.
function canonical(o: any): string {
  if (o === null || typeof o !== 'object') return JSON.stringify(o);
  if (Array.isArray(o)) return '[' + o.map(canonical).join(',') + ']';
  return '{' + Object.keys(o).sort().map(k => JSON.stringify(k) + ':' + canonical(o[k])).join(',') + '}';
}

// Issue a signed receipt for a subject (world/creator/event/reward/asset).
// Chains to the subject's previous receipt via prev_hash. Idempotent-ish: callers
// should avoid double-issuing (we expose a guard helper below).
export async function issueReceipt(opts: {
  subject_type: 'creator' | 'world' | 'event' | 'reward' | 'asset';
  subject_id: string;
  attestation: Record<string, unknown>;
  attested_by?: string;
  trust_status?: string;
}): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  if (!supa) return { ok: false, error: 'db_not_provisioned' };
  const { priv } = keys();

  // previous receipt for this subject (hash chain)
  const prev = (await supa.from('dcsgames_atlas_receipts')
    .select('id, sig').eq('subject_type', opts.subject_type).eq('subject_id', opts.subject_id)
    .order('created_at', { ascending: false }).limit(1).maybeSingle()).data;
  const prev_hash = prev?.sig ? sha256Hex(prev.sig) : null;

  // Sign over the exact fields we persist, so the receipt can be strictly re-verified.
  const signed = canonical({
    subject_type: opts.subject_type,
    subject_id: opts.subject_id,
    attestation: opts.attestation,
    attested_by: opts.attested_by || 'dcs-atlas',
    prev_hash,
  });
  const sig = crypto.sign(null, Buffer.from(signed), priv).toString('base64');

  const { data, error } = await supa.from('dcsgames_atlas_receipts').insert({
    subject_type: opts.subject_type,
    subject_id: opts.subject_id,
    attestation: opts.attestation,
    attested_by: payload.attested_by,
    trust_status: opts.trust_status || 'pre-gate-1',
    sig,
    prev_hash,
  }).select('id').single();
  if (error) return { ok: false, error: error.message };
  return { ok: true, id: data.id };
}

// Strictly verify a stored receipt's ed25519 signature against the current public key.
export function verifyReceiptSig(receipt: { subject_type: string; subject_id: string; attestation: any; attested_by?: string; prev_hash?: string | null; sig?: string | null }): boolean {
  if (!receipt?.sig) return false;
  try {
    const pub = crypto.createPublicKey(keys().priv);
    const signed = canonical({
      subject_type: receipt.subject_type,
      subject_id: receipt.subject_id,
      attestation: receipt.attestation,
      attested_by: receipt.attested_by || 'dcs-atlas',
      prev_hash: receipt.prev_hash ?? null,
    });
    return crypto.verify(null, Buffer.from(signed), pub, Buffer.from(receipt.sig, 'base64'));
  } catch { return false; }
}
