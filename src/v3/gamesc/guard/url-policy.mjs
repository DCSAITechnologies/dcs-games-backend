// GAMES-C guard — asset URL policy.
//
// Every URL a manifest, a patch or a provider hands us is judged here before the
// runtime is allowed to fetch it. The policy is an allowlist, not a blocklist:
// a URL is refused unless it is https, on a named asset host, carries no
// credentials and does not resolve to a literal address. `data:` is tolerated
// only for small raster images (the placeholder lane produces them), with a
// byte cap. Pure; never throws.

/**
 * Default asset hosts. The first three are the DCS domains the backend already
 * names (server.mts / config); cdnjs is where play-v3.html loads three.js from.
 * `assets.dcsai.ai` is a PROPOSED dedicated asset host and is not yet live.
 * Override per call with `allowHosts`, or process-wide with DCS_ASSET_HOSTS
 * (comma separated).
 */
export const DEFAULT_ASSET_HOSTS = Object.freeze([
  "games.dcsai.ai",
  "api.games.dcsai.ai",
  "assets.dcsai.ai",
  "cdnjs.cloudflare.com",
]);

export const DATA_IMAGE_MIME = Object.freeze(["image/png", "image/jpeg", "image/webp", "image/gif"]);
export const DEFAULT_MAX_DATA_BYTES = 64 * 1024;

const BLOCKED_HOSTNAMES = new Set([
  "localhost", "localhost.localdomain", "ip6-localhost", "ip6-loopback",
  "metadata", "metadata.google.internal", "metadata.goog", "instance-data",
]);
const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".intranet", ".lan", ".home.arpa", ".corp"];
const METADATA_IPS = new Set(["169.254.169.254", "169.254.170.2", "100.100.100.200", "fd00:ec2::254"]);

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

function hostsFrom(opts, env) {
  if (Array.isArray(opts.allowHosts)) return opts.allowHosts.map((h) => String(h).toLowerCase());
  const e = env?.DCS_ASSET_HOSTS;
  if (typeof e === "string" && e.trim()) return e.split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
  return [...DEFAULT_ASSET_HOSTS];
}

/** Private, loopback, link-local, CGNAT, multicast and reserved IPv4 space. */
export function isPrivateIPv4(ip) {
  if (!IPV4.test(ip)) return false;
  const [a, b] = ip.split(".").map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224 || (a === 198 && (b === 18 || b === 19));
}

const deny = (code, reason) => ({ ok: false, code, reason });

/**
 * @param {string} raw
 * @param {{allowHosts?:string[], allowDataImages?:boolean, maxDataBytes?:number, env?:object}} opts
 * @returns {{ok:true, url:string, kind:"https"|"data"} | {ok:false, code:string, reason:string}}
 */
export function checkAssetUrl(raw, opts = {}) {
  const env = opts.env ?? (typeof process !== "undefined" ? process.env : {});
  if (typeof raw !== "string" || !raw.length) return deny("not_string", "url must be a non-empty string");
  if (raw.length > 4096 && !raw.startsWith("data:")) return deny("too_long", "url longer than 4096 chars");
  // Control characters and whitespace are how parsers get disagreed with.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\s\\]/.test(raw)) return deny("control_chars", "url contains whitespace, backslash or control characters");

  // Same-origin packaged assets and the dcs-asset:// scheme — the two non-https
  // forms the patch module's ASSET_URI_ALLOWLIST (patch/whitelist.mjs) accepts.
  if (opts.allowSameOrigin !== false) {
    if (/^\/assets\/[A-Za-z0-9_\-/.]+$/.test(raw) && !raw.includes("..") && !raw.includes("//")) return { ok: true, url: raw, kind: "same_origin" };
    if (/^dcs-asset:\/\/[A-Za-z0-9_\-/.]+$/.test(raw) && !raw.includes("..")) return { ok: true, url: raw, kind: "dcs_asset" };
  }
  const scheme = (/^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(raw)?.[1] || "").toLowerCase();
  if (scheme === "data") return checkDataUrl(raw, opts);
  if (["javascript", "vbscript", "file", "blob", "filesystem", "about", "chrome", "ws", "ftp"].includes(scheme)) {
    return deny("scheme_blocked", `scheme '${scheme}:' is never allowed`);
  }
  if (scheme !== "https") return deny("not_https", scheme ? `scheme '${scheme}:' is not https` : "relative or scheme-less url");

  let u;
  try { u = new URL(raw); } catch { return deny("unparseable", "url does not parse"); }
  if (u.username || u.password) return deny("credentials", "credentials embedded in url");
  if (u.port && u.port !== "443") return deny("port", `non-default port ${u.port}`);

  const host = u.hostname.toLowerCase();
  // WHATWG URL already normalises 2130706433, 0x7f.1 and 0177.0.0.1 to dotted
  // IPv4, so one check covers every numeric spelling.
  if (host.startsWith("[") || host.includes(":")) return deny("ip_literal", "IPv6 literal host");
  if (IPV4.test(host)) {
    if (METADATA_IPS.has(host)) return deny("metadata_ip", "cloud metadata address");
    return deny(isPrivateIPv4(host) ? "private_ip" : "ip_literal", "IP literal host");
  }
  if (BLOCKED_HOSTNAMES.has(host) || BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) return deny("internal_host", `internal hostname '${host}'`);
  if (host.split(".").some((l) => l.startsWith("xn--"))) return deny("punycode", `internationalised (punycode) hostname '${host}' — lookalike risk`);
  if (!host.includes(".")) return deny("single_label", "single-label hostname");

  const allowed = hostsFrom(opts, env);
  if (!allowed.some((h) => host === h || host.endsWith("." + h))) return deny("host_not_allowed", `host '${host}' is not on the asset allowlist`);
  return { ok: true, url: u.href, kind: "https", host };
}

function checkDataUrl(raw, opts) {
  if (opts.allowDataImages === false) return deny("data_blocked", "data: urls disabled");
  const m = /^data:([a-z0-9.+/-]+)(;[a-z0-9=.-]+)*?;base64,([A-Za-z0-9+/=]*)$/i.exec(raw);
  if (!m) return deny("data_not_base64_image", "data: url must be base64 image");
  const mime = m[1].toLowerCase();
  if (!DATA_IMAGE_MIME.includes(mime)) return deny("data_mime", `data: mime '${mime}' not allowed (svg/html carry script)`);
  const bytes = Math.floor((m[3].length * 3) / 4);
  const cap = opts.maxDataBytes ?? DEFAULT_MAX_DATA_BYTES;
  if (bytes > cap) return deny("data_too_large", `data: image ${bytes}B exceeds cap ${cap}B`);
  return { ok: true, url: raw, kind: "data", mime, bytes };
}

/** Collect every uri/url-like string field in a manifest and judge each. */
export function checkManifestUrls(manifest, opts = {}) {
  const findings = [];
  const walk = (v, path) => {
    if (v === null || v === undefined) return;
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${path}[${i}]`));
    if (typeof v === "object") {
      for (const [k, x] of Object.entries(v)) {
        if (typeof x === "string" && /^(uri|url|src|href|thumbnail|image|texture|model_url|preview_url)$/i.test(k)) {
          const r = checkAssetUrl(x, opts);
          if (!r.ok) findings.push({ path: `${path}.${k}`, code: r.code, reason: r.reason });
        } else walk(x, `${path}.${k}`);
      }
    }
  };
  walk(manifest, "$");
  return { ok: findings.length === 0, findings };
}
