// atlas-verify-page.mjs — CW7 v2.0 "public Atlas verify view" as a renderable surface.
// publicVerifyReceipt (atlas-verify-view) is the DATA; this is the self-contained PAGE a verifier
// lands on (e.g. /verify?receipt=...). No framework — returns an HTML fragment CW6 embeds, plus a
// JSON view for API consumers. Honest states: VERIFIED / INVALID / NOT-FOUND, never "trusted" on fail.
// All dynamic values are HTML-escaped (no injection). The page tells the user HOW to re-verify
// independently (fetch /atlas/key + check the canonical body) — trust is provable, not asserted.

import { publicVerifyReceipt } from './atlas-verify-view.mjs';

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Render the verify view for a receipt. deps.verify = injected live verifyReceiptSig wrapper.
// Returns { status, json, html } — json for API, html for the page surface.
export function renderVerifyView(receipt, deps = {}) {
  if (!receipt) {
    return { status: 'NOT_FOUND', json: { status: 'NOT_FOUND', reason: 'no receipt supplied' }, html: notFoundHTML() };
  }
  const v = publicVerifyReceipt(receipt, { verify: deps.verify });
  return { status: v.status, json: v, html: resultHTML(v) };
}

function badge(status) {
  if (status === 'VERIFIED') return `<span class="av-badge av-badge--ok" role="status">✓ VERIFIED</span>`;
  return `<span class="av-badge av-badge--bad" role="status">✗ ${esc(status)}</span>`;
}

function resultHTML(v) {
  const r = v.receipt || {};
  const rows = [
    ['Subject', `${esc(r.subject_type)} · ${esc(r.subject_id)}`],
    ['Attested by', esc(r.attested_by)],
    ['Action', esc(r.action)],
    ['Receipt hash', esc(r.receipt_hash)],
    ['Issued', esc(r.ts)],
  ].filter(([, val]) => val && val !== 'null')
   .map(([k, val]) => `<div class="av-row"><span class="av-k">${k}</span><span class="av-v">${val}</span></div>`)
   .join('');

  return `<section class="atlas-verify" aria-label="Atlas receipt verification">
  <header class="av-head">${badge(v.status)}<span class="av-reason">${esc(v.reason)}</span></header>
  <div class="av-body">${rows || '<p class="av-empty">No public fields on this receipt.</p>'}</div>
  <footer class="av-foot">
    <p class="av-independent">Verify this yourself: fetch <code>/atlas/key</code> (ed25519 public key),
    rebuild the canonical body <code>{attestation, attested_by, prev_hash, subject_type, subject_id}</code>,
    and check the signature. ${v.independently_verifiable ? 'This receipt is independently verifiable.' : ''}</p>
  </footer>
</section>`;
}

function notFoundHTML() {
  return `<section class="atlas-verify"><header class="av-head">${badge('NOT_FOUND')}<span class="av-reason">no receipt supplied</span></header></section>`;
}

// A full standalone page (for a direct /verify landing) wrapping the fragment + minimal styles.
export function verifyPageHTML(receipt, deps = {}) {
  const { html, status } = renderVerifyView(receipt, deps);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Atlas Receipt Verification — ${esc(status)}</title>
<style>
  .atlas-verify{max-width:640px;margin:2rem auto;font-family:system-ui,sans-serif;border:1px solid #2a2a2a;border-radius:12px;overflow:hidden}
  .av-head{display:flex;gap:.75rem;align-items:center;padding:1rem 1.25rem;border-bottom:1px solid #2a2a2a}
  .av-badge{font-weight:700;padding:.25rem .6rem;border-radius:999px;font-size:.85rem}
  .av-badge--ok{background:#0f3;color:#031}.av-badge--bad{background:#f33;color:#fff}
  .av-reason{color:#888;font-size:.9rem}
  .av-row{display:flex;justify-content:space-between;padding:.5rem 1.25rem;border-bottom:1px solid #1c1c1c}
  .av-k{color:#888}.av-v{font-family:ui-monospace,monospace;word-break:break-all}
  .av-foot{padding:1rem 1.25rem;color:#777;font-size:.8rem}.av-foot code{background:#1c1c1c;padding:.1rem .3rem;border-radius:4px}
</style></head><body>${html}</body></html>`;
}
