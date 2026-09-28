// Materials and textures from AssetRecords (contract §4.3), browser-only.
//
// Texture recipes are synthesised here, in the page, by the same isomorphic
// synthesizeTexture the publisher uses — so a package carries a few bytes of
// recipe per texture rather than megabytes of PNG. When that module is absent
// (early development, or a trimmed deployment) a small built-in generator keeps
// the world textured rather than flat-shaded, and the page says so in debug.
/* global THREE */

import { rng, hashString } from "../src/gamesb/common/rng.mjs";

// Colours used when a material ref has no record at all. Better a brown plank
// than a magenta error — the package validator is where missing refs get caught.
const FALLBACK_COLORS = {
  grass: "#5d7a3a", sand: "#c9b48a", rock: "#6b6b70", dirt: "#6a5238", snow: "#e8eef2", stone: "#8a8580",
  wood: "#6b4a2f", planks: "#7a5a3a", roof: "#7a3b2e", metal: "#8a9098", plaster: "#d8cdb8", leaves: "#3f6b35",
  bark: "#4a3627", water: "#2a5a78", cloth: "#3d4f6e", glow: "#ffb347", crystal: "#7fd6ff", brass: "#b08d3c", ember: "#ff7a2a",
};
const EMISSIVE_NAMES = new Set(["glow", "ember", "crystal"]);

export function hexToColor(hex, fallback = "#888888") {
  return new THREE.Color(typeof hex === "string" && /^#[0-9a-f]{6}$/i.test(hex) ? hex : fallback);
}

// ---- built-in fallback texture generator ---------------------------------------
function periodicNoise(size, period, seed) {
  const r = rng(seed);
  const g = Array.from({ length: period * period }, () => r());
  const s = (t) => t * t * (3 - 2 * t);
  return (x, y) => {
    const fx = (x / size) * period, fy = (y / size) * period;
    const xi = Math.floor(fx), yi = Math.floor(fy), tx = s(fx - xi), ty = s(fy - yi);
    const at = (i, j) => g[((j % period) + period) % period * period + ((i % period) + period) % period];
    return (at(xi, yi) * (1 - tx) + at(xi + 1, yi) * tx) * (1 - ty) + (at(xi, yi + 1) * (1 - tx) + at(xi + 1, yi + 1) * tx) * ty;
  };
}

export function fallbackSynth(recipe) {
  const size = [64, 128, 256, 512].includes(recipe?.size) ? recipe.size : 128;
  const seed = (recipe?.seed ?? 1) >>> 0;
  const cols = (recipe?.colors?.length ? recipe.colors : ["#808080", "#606060"]).map((c) => hexToColor(c));
  const n1 = periodicNoise(size, 4, seed), n2 = periodicNoise(size, 16, seed + 1), n3 = periodicNoise(size, 64, seed + 2);
  const albedo = new Uint8ClampedArray(size * size * 4);
  const gen = recipe?.generator || "noise";
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let v = n1(x, y) * 0.5 + n2(x, y) * 0.3 + n3(x, y) * 0.2;
    const u = x / size, w = y / size;
    if (gen === "planks") v = v * 0.5 + 0.5 * ((Math.floor(w * 6) % 2) ? 0.65 : 0.35) - (Math.abs((w * 6) % 1 - 0.02) < 0.03 ? 0.4 : 0);
    else if (gen === "bricks" || gen === "stone_tiles") {
      const row = Math.floor(w * 8), off = row % 2 ? 0.5 : 0;
      const mortar = (w * 8) % 1 < 0.08 || ((u * 4 + off) % 1) < 0.05;
      v = mortar ? 0.1 : v;
    } else if (gen === "roof_tiles") v = v * 0.6 + 0.4 * ((w * 10) % 1);
    else if (gen === "bark") v = v * 0.4 + 0.6 * Math.abs(Math.sin(u * Math.PI * 12 + n1(x, y) * 4));
    else if (gen === "grass") v = v * 0.6 + 0.4 * n3(x * 3 % size, y);
    const c = cols.length === 1 ? cols[0].clone().multiplyScalar(0.75 + v * 0.5)
      : cols[0].clone().lerp(cols[Math.min(cols.length - 1, 1 + Math.floor(v * (cols.length - 1)))], v);
    const i = (y * size + x) * 4;
    albedo[i] = c.r * 255; albedo[i + 1] = c.g * 255; albedo[i + 2] = c.b * 255; albedo[i + 3] = 255;
  }
  return { width: size, height: size, albedo, normal: null, roughness: null };
}

// ---- library ------------------------------------------------------------------
export class MaterialLibrary {
  constructor({ records, synth, baseUrl, anisotropy = 4, warn = () => {} }) {
    this.synth = synth;                 // synthesizeTexture or null
    this.baseUrl = baseUrl;
    this.anisotropy = anisotropy;
    this.warn = warn;
    this.byRef = new Map();
    this.byId = new Map();
    for (const r of records || []) {
      if (r?.asset_id) this.byId.set(r.asset_id, r);
      if (r?.ref && !this.byRef.has(r.ref)) this.byRef.set(r.ref, r);
    }
    this.synthCache = new Map();        // recipe hash → synth output
    this.texCache = new Map();          // asset_id|channel → THREE.Texture
    this.matCache = new Map();          // key → THREE.Material
    this.stats = { synthesized: 0, fallback: 0, textures: 0 };
  }

  record(ref) { return this.byRef.get(ref) || this.byId.get(ref) || null; }

  _synth(recipe) {
    const key = JSON.stringify(recipe);
    if (this.synthCache.has(key)) return this.synthCache.get(key);
    let out = null;
    if (this.synth) {
      try { out = this.synth(recipe); this.stats.synthesized++; } catch (e) { this.warn(`texture synth failed: ${e.message}`); }
    }
    if (!out) { out = fallbackSynth(recipe); this.stats.fallback++; }
    this.synthCache.set(key, out);
    return out;
  }

  /** channel: "albedo" | "normal" | "roughness" */
  texture(assetId, channel = "albedo", repeat = null) {
    const rec = this.record(assetId);
    if (!rec) return null;
    const key = `${rec.asset_id}|${channel}|${repeat ? repeat.u + "x" + repeat.v : ""}`;
    if (this.texCache.has(key)) return this.texCache.get(key);
    let tex = null;
    if (rec.format === "texture-recipe" && rec.payload) {
      const out = this._synth(rec.payload);
      const data = out[channel] || (channel === "albedo" ? out.albedo : null);
      if (data) {
        tex = new THREE.DataTexture(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), out.width, out.height, THREE.RGBAFormat);
        tex.generateMipmaps = true;
        tex.minFilter = THREE.LinearMipmapLinearFilter;
        tex.magFilter = THREE.LinearFilter;
      }
    } else if (rec.uri && (rec.format === "png" || rec.format === "svg")) {
      tex = new THREE.TextureLoader().load(new URL(rec.uri, this.baseUrl).href);
    }
    if (!tex) return null;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = this.anisotropy;
    if (channel === "albedo") tex.encoding = THREE.sRGBEncoding;
    if (repeat) tex.repeat.set(repeat.u || 1, repeat.v || 1);
    tex.needsUpdate = true;
    this.texCache.set(key, tex);
    this.stats.textures++;
    return tex;
  }

  /** The albedo texture of a material ref, for the terrain splat shader. */
  albedoOf(ref) {
    const rec = this.record(ref);
    const p = rec?.payload;
    if (!p?.albedo_texture) return null;
    return this.texture(p.albedo_texture, "albedo");
  }

  colorOf(ref) {
    const p = this.record(ref)?.payload;
    const name = String(ref).replace(/^mat:/, "");
    return hexToColor(p?.color, FALLBACK_COLORS[name] || "#8a8a8a");
  }

  /**
   * A MeshStandardMaterial for a material ref. `opts.emissive` forces a glowing
   * variant (a lamp part on an otherwise plain material); `opts.glowColor` sets a
   * lamp's own colour; `opts.plain` omits vertex colours (non-recipe geometry).
   */
  material(ref, opts = {}) {
    const key = `${ref}|${opts.emissive ? 1 : 0}|${opts.glowColor || ""}|${opts.plain ? 1 : 0}`;
    if (this.matCache.has(key)) return this.matCache.get(key);
    const rec = this.record(ref);
    const p = rec?.payload || {};
    const name = String(ref).replace(/^mat:/, "");
    const color = hexToColor(p.color, FALLBACK_COLORS[name] || "#8a8a8a");
    const params = {
      color,
      roughness: typeof p.roughness === "number" ? p.roughness : 0.85,
      metalness: typeof p.metalness === "number" ? p.metalness : 0,
      transparent: !!p.transparent || (typeof p.opacity === "number" && p.opacity < 1),
      opacity: typeof p.opacity === "number" ? p.opacity : 1,
      side: p.double_sided ? THREE.DoubleSide : THREE.FrontSide,
    };
    // Mesh parts carry 0..1 UVs per part, so the material's repeat applies as-is.
    const rep = p.repeat && (p.repeat.u || p.repeat.v) ? p.repeat : null;
    if (p.albedo_texture) { params.map = this.texture(p.albedo_texture, "albedo", rep); if (params.map) params.color = new THREE.Color(1, 1, 1); }
    if (p.normal_texture) params.normalMap = this.texture(p.normal_texture, "normal", rep);
    if (p.roughness_texture) params.roughnessMap = this.texture(p.roughness_texture, "roughness", rep);
    const emissiveHex = p.emissive || (opts.emissive || EMISSIVE_NAMES.has(name) ? (p.color || FALLBACK_COLORS[name]) : null);
    if (emissiveHex && (opts.emissive || p.emissive || EMISSIVE_NAMES.has(name))) {
      params.emissive = hexToColor(emissiveHex);
      params.emissiveIntensity = Math.max(opts.emissive ? 1.6 : 0, typeof p.emissive_intensity === "number" ? p.emissive_intensity : 1.2);
    }
    if (opts.glowColor) { params.emissive = hexToColor(opts.glowColor); params.color = hexToColor(opts.glowColor); params.emissiveIntensity = Math.max(1.4, params.emissiveIntensity || 0); }
    if (params.transparent) params.depthWrite = params.opacity > 0.6;
    // Recipe geometry carries per-part tints as vertex colours (white when untinted).
    if (!opts.plain) params.vertexColors = true;
    const m = new THREE.MeshStandardMaterial(params);
    m.name = ref;
    // A part tint (vertex colour) also tints the material's own glow, so a
    // blue-tinted crystal robe glows blue rather than the material's default.
    if (params.vertexColors && params.emissive) {
      m.onBeforeCompile = (sh) => {
        sh.fragmentShader = sh.fragmentShader.replace("#include <emissivemap_fragment>", "#include <emissivemap_fragment>\n#ifdef USE_COLOR\ntotalEmissiveRadiance *= vColor.rgb;\n#endif");
      };
      m.customProgramCacheKey = () => "tint-emissive";
    }
    this.matCache.set(key, m);
    return m;
  }

  /** An <img>-ready URL for an icon record (SVG string in payload, or a uri). */
  iconUrl(refOrId) {
    const rec = this.record(refOrId);
    if (!rec) return null;
    const svg = typeof rec.payload === "string" ? rec.payload : (rec.payload?.svg || rec.payload?.markup || null);
    if (svg && /<svg[\s>]/i.test(svg)) return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
    if (rec.uri) return new URL(rec.uri, this.baseUrl).href;
    return null;
  }

  dispose() {
    for (const t of this.texCache.values()) t.dispose();
    for (const m of this.matCache.values()) m.dispose();
  }
}

export const colorHash = (s) => hashString(s);
