// GAMES-C guard — public surface.
//
// guardManifest() is the one call the store/publish/patch paths should make on
// any manifest before persisting or publishing it. It aggregates every
// manifest-level threat check; each finding names its threat class.
export * from "./url-policy.mjs";
export * from "./asset-limits.mjs";
export * from "./injection.mjs";
export * from "./pinning.mjs";
export * from "./provider-output.mjs";
export * from "./secrets.mjs";
export * from "./ratelimit.mjs";
export * from "./sandbox-policy.mjs";
export * from "./budget.mjs";

import { checkManifestUrls } from "./url-policy.mjs";
import { checkAssetBudget, checkJsonLimits } from "./asset-limits.mjs";
import { scanForInjection } from "./injection.mjs";
import { checkPinnedAssets } from "./pinning.mjs";
import { scanValue } from "./secrets.mjs";
import { assertDataOnly } from "./sandbox-policy.mjs";

export const GUARD_VERSION = "1";

/**
 * @param manifest  WorldManifestV3 (or a publish package / patch)
 * @param opts      { allowHosts?, requirePins?=true, limits? }
 * @returns {{ok:boolean, blocking:Array, advisory:Array, by_threat:Object}}
 */
export function guardManifest(manifest, opts = {}) {
  const by = {};
  const add = (threat, r, list) => { by[threat] = { ok: r.ok, count: (list || []).length }; return (list || []).map((f) => ({ threat, ...f })); };
  const blocking = [], advisory = [];

  const lim = checkJsonLimits(manifest, opts.limits);
  blocking.push(...add("json_limits", lim, lim.ok ? [] : [{ code: lim.code, reason: lim.reason }]));
  if (!lim.ok) return { ok: false, blocking, advisory, by_threat: by };

  const code = assertDataOnly(manifest);
  blocking.push(...add("generated_code", code, code.findings));
  const urls = checkManifestUrls(manifest, opts);
  blocking.push(...add("unsafe_url", urls, urls.findings));
  const bomb = checkAssetBudget(manifest?.assets, opts.limits);
  blocking.push(...add("asset_bomb", bomb, bomb.findings));
  const inj = scanForInjection(manifest);
  // Template/markup text is escaped at display; forbidden keys and script tags block.
  const injBlock = inj.findings.filter((f) => ["forbidden_key", "script_tag", "javascript_url", "event_handler", "eval_call", "function_ctor", "proto_pollution"].includes(f.code));
  blocking.push(...add("script_injection", { ok: injBlock.length === 0 }, injBlock));
  advisory.push(...inj.findings.filter((f) => !injBlock.includes(f)).map((f) => ({ threat: "script_injection", ...f })));
  const pins = checkPinnedAssets(manifest);
  (opts.requirePins === false ? advisory : blocking).push(...add("remote_asset_substitution", pins, pins.findings));
  const sec = scanValue(manifest, { clientFacing: true });
  blocking.push(...add("secret_leakage", sec, sec.findings));

  return { ok: blocking.length === 0, blocking, advisory, by_threat: by };
}
