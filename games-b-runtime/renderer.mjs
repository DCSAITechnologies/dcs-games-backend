// Games-B browser renderer (contract §10). Browser-only; THREE is the r147 global.
//
// Turns a GamePackage into a lit three.js scene and, each frame, poses it from a
// read-only "view" of the simulation. The renderer never decides anything about
// the game: where the player is, what was collected and which beacon is lit all
// come from sim-core, so what you see is exactly what the headless playtest saw.
//
// Budget, not LOD. Every static asset is instanced per material per 64 m chunk,
// so a whole forest of one tree species costs a handful of draw calls; only
// objects that change (pickups, interactables, characters) are individual.
// Shadows are cast only by what is near the player; at most six point lights
// move to the nearest glowing things.
/* global THREE */

import { bakeRecipe, mergeGeometries } from "./geometry.mjs";
import { MaterialLibrary, hexToColor } from "./materials.mjs";
import { buildCharacter, defaultPlayerRecipe } from "./characters.mjs";
import { rng } from "../src/gamesb/common/rng.mjs";

const CHUNK = 64;
const MAX_POINT_LIGHTS = 6;
const SHADOW_RADIUS = 60;
const DEG = Math.PI / 180;

/** Bilinear height, identical to world/terrain-sample.mjs sampleHeight — used when that module is absent. */
export function localSampleHeight(t, x, z) {
  const cl = (v, a, b) => (v < a ? a : v > b ? b : v);
  const fx = cl(x / t.cell, 0, t.cols - 1), fz = cl(z / t.cell, 0, t.rows - 1);
  const i0 = Math.floor(fx), j0 = Math.floor(fz), tx = fx - i0, tz = fz - j0;
  const h = (i, j) => t.heights[cl(j, 0, t.rows - 1) * t.cols + cl(i, 0, t.cols - 1)];
  return (h(i0, j0) * (1 - tx) + h(i0 + 1, j0) * tx) * (1 - tz) + (h(i0, j0 + 1) * (1 - tx) + h(i0 + 1, j0 + 1) * tx) * tz;
}

/** A geometry that shares another's buffers but carries its own bounding sphere
 *  (r147 InstancedMesh culls against the base geometry's sphere, not the instances'). */
function shareGeometry(g, sphere) {
  const n = new THREE.BufferGeometry();
  for (const k of Object.keys(g.attributes)) n.setAttribute(k, g.attributes[k]);
  n.setIndex(g.index);
  n.boundingSphere = sphere;
  return n;
}

function radialTexture(inner = "rgba(255,220,160,1)", outer = "rgba(255,160,60,0)") {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d");
  const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, inner); gr.addColorStop(0.25, inner.replace(/[\d.]+\)$/, "0.55)")); gr.addColorStop(1, outer);
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.encoding = THREE.sRGBEncoding;
  return t;
}

function labelSprite(text, color = "#fff4e0") {
  const c = document.createElement("canvas");
  const g = c.getContext("2d");
  const font = "600 34px system-ui, -apple-system, Segoe UI, sans-serif";
  g.font = font;
  const w = Math.ceil(g.measureText(text).width) + 28;
  c.width = w; c.height = 52;
  g.font = font;
  g.fillStyle = "rgba(12,14,24,0.55)";
  const r = 16;
  g.beginPath(); g.moveTo(r, 0); g.lineTo(w - r, 0); g.quadraticCurveTo(w, 0, w, r); g.lineTo(w, 52 - r); g.quadraticCurveTo(w, 52, w - r, 52);
  g.lineTo(r, 52); g.quadraticCurveTo(0, 52, 0, 52 - r); g.lineTo(0, r); g.quadraticCurveTo(0, 0, r, 0); g.fill();
  g.fillStyle = color; g.textBaseline = "middle"; g.fillText(text, 14, 27);
  const tex = new THREE.CanvasTexture(c);
  tex.encoding = THREE.sRGBEncoding;
  // Nameplates draw over scenery (a signpost must not eat a name); distance fades them instead.
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthWrite: false, depthTest: false, transparent: true, fog: false }));
  s.scale.set(w / 110, 52 / 110, 1);
  s.renderOrder = 10;
  return s;
}

// ---------------------------------------------------------------- shaders

const SKY_VERT = `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p.xyww;
}`;
const SKY_FRAG = `
uniform vec3 uTop; uniform vec3 uHorizon; uniform vec3 uBottom; uniform vec3 uSunDir; uniform vec3 uSunColor;
uniform float uTime; uniform float uCloud; uniform float uFlash; uniform vec3 uCloudColor;
varying vec3 vDir;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y); }
float fbm(vec2 p) { float a = 0.5, s = 0.0; for (int i = 0; i < 5; i++) { s += a * noise(p); p = p * 2.03 + 11.7; a *= 0.5; } return s; }
void main() {
  vec3 d = normalize(vDir);
  float h = d.y;
  vec3 col = h >= 0.0 ? mix(uHorizon, uTop, pow(clamp(h, 0.0, 1.0), 0.55)) : mix(uHorizon, uBottom, clamp(-h * 4.0, 0.0, 1.0));
  float sd = max(dot(d, uSunDir), 0.0);
  // Heavy cloud hides the sun's disc but keeps its glow on the horizon.
  col += uSunColor * (pow(sd, 900.0) * 6.0 * (1.0 - uCloud * 0.9) + pow(sd, 12.0) * 0.45 + pow(sd, 3.0) * 0.12);
  if (h > -0.02 && uCloud > 0.0) {
    vec2 uv = d.xz / (h + 0.12) * 0.9 + vec2(uTime * 0.012, uTime * 0.004);
    float n = fbm(uv * 1.3);
    float cov = smoothstep(1.0 - uCloud * 0.85, 1.05 - uCloud * 0.35, n);
    vec3 cc = mix(uCloudColor, uHorizon * 1.1, pow(sd, 4.0) * 0.6 + 0.12 * (1.0 - h));
    float shade = 0.75 + 0.35 * fbm(uv * 2.6 + 4.0);
    col = mix(col, cc * shade, cov * smoothstep(-0.02, 0.12, h) * 0.95);
  }
  col += vec3(0.75, 0.8, 1.0) * uFlash;
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <encodings_fragment>
}`;

// ---------------------------------------------------------------- renderer

export async function createRenderer({ canvas, pkg, mods = {}, baseUrl = location.href, onProgress = () => {}, warn = () => {}, quality = "high" }) {
  if (THREE.ColorManagement) THREE.ColorManagement.legacyMode = false;   // hex colours are sRGB
  const world = pkg.world;
  const env = world.environment || {};
  const terrain = world.terrain;
  const heightAt = mods.sampleHeight ? (x, z) => mods.sampleHeight(terrain, x, z) : (x, z) => localSampleHeight(terrain, x, z);
  const lowQ = quality === "low";

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: !lowQ, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, lowQ ? 1 : 1.5));
  renderer.outputEncoding = THREE.sRGBEncoding;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  // Optional environment.exposure / lamp_boost (Games-D lighting presets); absent → the Games-B defaults.
  renderer.toneMappingExposure = Number.isFinite(env.exposure) ? Math.min(2, Math.max(0.5, env.exposure)) : 1.05;
  const lampBoost = Number.isFinite(env.lamp_boost) ? Math.min(3, Math.max(0.5, env.lamp_boost)) : 1;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.info.autoReset = true;

  const scene = new THREE.Scene();
  const camRig = world.camera || {};
  const camera = new THREE.PerspectiveCamera(camRig.fov || 60, 1, 0.1, 1400);
  const lib = new MaterialLibrary({ records: pkg.assets?.records || [], synth: mods.synthesizeTexture || null, baseUrl, anisotropy: Math.min(8, renderer.capabilities.getMaxAnisotropy()), warn });

  const W = world.size.w, H = world.size.h;
  const waterOn = env.water?.enabled !== false && !!env.water;
  const waterLevel = waterOn ? (env.water.level ?? 0) : -Infinity;

  // -------------------------------------------------- lights & atmosphere
  await onProgress(0.1, "Lighting the sky");
  const weather = env.weather || "clear";
  // Wet weather cools the air towards the concept's storm colour, so a stormy
  // dusk reads as amber lamps against blue gloom rather than as brown haze.
  const wet = { rain: 0.3, storm: 0.42, snow: 0.2, fog: 0.15 }[weather] || 0;
  const stormHex = pkg.concept?.palette?.secondary || "#2f4a6d";
  const cool = (hex) => hexToColor(hex).lerp(hexToColor(stormHex), wet);
  const sky0 = env.sky || { top: "#335577", horizon: "#aabbcc", bottom: "#445566" };
  const fogCfg = env.fog || { color: sky0.horizon, near: 60, far: 400 };
  const fogCol = cool(fogCfg.color);
  // Keep the near field readable: fog never closes in tighter than ~150 m.
  scene.fog = new THREE.Fog(fogCol, Math.max(20, fogCfg.near ?? 60), Math.max(150, fogCfg.far ?? 400));
  scene.background = fogCol.clone();

  const sunCfg = env.sun || { azimuth_deg: 220, elevation_deg: 35, color: "#ffffff", intensity: 2, shadows: true };
  const el = (sunCfg.elevation_deg ?? 35) * DEG, az = (sunCfg.azimuth_deg ?? 220) * DEG;
  // Direction TOWARDS the sun, matching the scene graph's sun_light (which stores the light's travel direction).
  const sunDir = new THREE.Vector3(Math.cos(el) * Math.sin(az), Math.max(0.05, Math.sin(el)), Math.cos(el) * Math.cos(az)).normalize();
  // A storm can dim the sun to almost nothing; a floor keeps a key light (and its
  // shadows) so forms still read. The world's colour and direction are kept.
  const sunIntensity = Math.max(sunCfg.intensity ?? 2, 0.55);
  const sun = new THREE.DirectionalLight(hexToColor(sunCfg.color, "#ffffff"), sunIntensity);
  sun.castShadow = sunIntensity >= 0.3;
  sun.shadow.mapSize.set(lowQ ? 1024 : 2048, lowQ ? 1024 : 2048);
  const sc = sun.shadow.camera;
  sc.left = -38; sc.right = 38; sc.top = 38; sc.bottom = -38; sc.near = 1; sc.far = 260;
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.04;
  scene.add(sun, sun.target);

  const amb = env.ambient || { color: "#8899aa", ground_color: "#443322", intensity: 0.6 };
  const hemi = new THREE.HemisphereLight(cool(amb.color), hexToColor(amb.ground_color), Math.max(0.45, (amb.intensity ?? 0.6) * 1.2));
  scene.add(hemi);
  const baseHemi = hemi.intensity, baseSun = sun.intensity;

  const sky = { top: cool(sky0.top), horizon: cool(sky0.horizon).lerp(hexToColor(sunCfg.color || "#ffffff"), 0.12), bottom: cool(sky0.bottom) };
  const cloudiness = { clear: 0.15, cloudy: 0.6, rain: 0.8, storm: 0.95, snow: 0.7, fog: 0.5, sandstorm: 0.4, ash: 0.7 }[weather] ?? 0.3;
  const skyMat = new THREE.ShaderMaterial({
    vertexShader: SKY_VERT, fragmentShader: SKY_FRAG, side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: {
      uTop: { value: sky.top }, uHorizon: { value: sky.horizon }, uBottom: { value: sky.bottom },
      uSunDir: { value: sunDir.clone() }, uSunColor: { value: hexToColor(sunCfg.color, "#ffffff").multiplyScalar(0.9) },
      uTime: { value: 0 }, uCloud: { value: cloudiness }, uFlash: { value: 0 },
      uCloudColor: { value: sky.top.clone().lerp(fogCol, 0.55).multiplyScalar(weather === "storm" ? 0.7 : 1.0) },
    },
  });
  const skyDome = new THREE.Mesh(new THREE.SphereGeometry(1000, 32, 16), skyMat);
  skyDome.frustumCulled = false;
  skyDome.renderOrder = -10;
  skyDome.name = "sky";
  scene.add(skyDome);

  // Sky reflection for water and metal: prefilter the dome once.
  let envMap = null;
  try {
    const pm = new THREE.PMREMGenerator(renderer);
    const s2 = new THREE.Scene();
    s2.add(new THREE.Mesh(new THREE.SphereGeometry(10, 24, 12), skyMat));
    envMap = pm.fromScene(s2, 0.02).texture;
    pm.dispose();
  } catch (e) { warn(`env map skipped: ${e.message}`); }

  // -------------------------------------------------- terrain
  await onProgress(0.2, "Raising the island");
  const terrainMesh = buildTerrain();
  scene.add(terrainMesh);

  function buildTerrain() {
    const { cols, rows, cell, heights } = terrain;
    const g = new THREE.BufferGeometry();
    const pos = new Float32Array(cols * rows * 3);
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
      const k = (j * cols + i) * 3;
      pos[k] = i * cell; pos[k + 1] = heights[j * cols + i]; pos[k + 2] = j * cell;
    }
    const idx = new Uint32Array((cols - 1) * (rows - 1) * 6);
    let o = 0;
    for (let j = 0; j < rows - 1; j++) for (let i = 0; i < cols - 1; i++) {
      const a = j * cols + i, b = a + 1, c = a + cols, d = c + 1;
      idx[o++] = a; idx[o++] = c; idx[o++] = b; idx[o++] = b; idx[o++] = c; idx[o++] = d;
    }
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.computeVertexNormals();

    // Up to four splat layers, one per distinct material; weights follow the
    // contract's "first matching layer wins" rule, softened across a band so
    // sand meets grass in a blend rather than along a contour line.
    const layers = (terrain.material_layers || []).slice();
    const slots = [];
    for (const l of layers) if (!slots.includes(l.material_ref) && slots.length < 4) slots.push(l.material_ref);
    if (!slots.length) slots.push("mat:grass");
    const slotOf = (ref) => { const s = slots.indexOf(ref); return s < 0 ? slots.length - 1 : s; };
    const nrm = g.attributes.normal;
    const splat = new Float32Array(cols * rows * 4);
    const jitter = rng(world.seed || 1);
    const smooth = (d, band) => { const t = Math.max(0, Math.min(1, d / band + 0.5)); return t * t * (3 - 2 * t); };
    for (let v = 0; v < cols * rows; v++) {
      const h = pos[v * 3 + 1] + (jitter() - 0.5) * 0.9;
      const slope = Math.acos(Math.max(-1, Math.min(1, nrm.getY(v)))) / DEG + (jitter() - 0.5) * 4;
      let remain = 1;
      for (const l of layers) {
        const m = smooth(h - (l.min_h ?? -1e9), 1.2) * smooth((l.max_h ?? 1e9) - h, 1.2) * smooth((l.max_slope_deg ?? 90) - slope, 7);
        const w = m * remain;
        splat[v * 4 + slotOf(l.material_ref)] += w;
        remain -= w;
        if (remain <= 1e-3) break;
      }
      if (remain > 0) splat[v * 4 + slots.length - 1] += remain;
    }
    g.setAttribute("splat", new THREE.BufferAttribute(splat, 4));
    g.computeBoundingSphere();

    const white = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1, THREE.RGBAFormat);
    white.needsUpdate = true;
    const texs = [], cols4 = [];
    for (let s = 0; s < 4; s++) {
      const ref = slots[Math.min(s, slots.length - 1)];
      const t = lib.albedoOf(ref);
      texs.push(t || white);
      cols4.push(t ? new THREE.Color(1, 1, 1) : lib.colorOf(ref));
    }
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.92, metalness: 0 });
    mat.onBeforeCompile = (sh) => {
      for (let s = 0; s < 4; s++) { sh.uniforms[`tL${s}`] = { value: texs[s] }; sh.uniforms[`cL${s}`] = { value: cols4[s] }; }
      sh.uniforms.uTile = { value: 1 / 6 };
      sh.vertexShader = "attribute vec4 splat;\nvarying vec4 vSplat;\nvarying vec3 vTPos;\n" +
        sh.vertexShader.replace("#include <begin_vertex>", "#include <begin_vertex>\nvSplat = splat; vTPos = position;");
      sh.fragmentShader = "uniform sampler2D tL0; uniform sampler2D tL1; uniform sampler2D tL2; uniform sampler2D tL3;\n" +
        "uniform vec3 cL0; uniform vec3 cL1; uniform vec3 cL2; uniform vec3 cL3; uniform float uTile;\nvarying vec4 vSplat;\nvarying vec3 vTPos;\n" +
        sh.fragmentShader.replace("#include <map_fragment>", `
          vec2 tuv = vTPos.xz * uTile;
          vec2 tuv2 = vTPos.xz * uTile * 0.21 + vec2(0.37, 0.71);
          vec4 sw = vSplat / max(dot(vSplat, vec4(1.0)), 1e-4);
          vec3 tcol = sw.x * mix(texture2D(tL0, tuv).rgb, texture2D(tL0, tuv2).rgb, 0.4) * cL0
                    + sw.y * mix(texture2D(tL1, tuv).rgb, texture2D(tL1, tuv2).rgb, 0.4) * cL1
                    + sw.z * mix(texture2D(tL2, tuv).rgb, texture2D(tL2, tuv2).rgb, 0.4) * cL2
                    + sw.w * mix(texture2D(tL3, tuv).rgb, texture2D(tL3, tuv2).rgb, 0.4) * cL3;
          diffuseColor.rgb *= tcol;`);
    };
    const mesh = new THREE.Mesh(g, mat);
    mesh.name = "terrain";
    mesh.receiveShadow = true;
    mesh.castShadow = true;
    return mesh;
  }

  // Seabed under the open water so the ocean has something beneath it.
  const seabed = new THREE.Mesh(new THREE.PlaneGeometry(W * 5, H * 5).rotateX(-Math.PI / 2),
    new THREE.MeshStandardMaterial({ color: lib.colorOf("mat:sand").multiplyScalar(0.35), roughness: 1 }));
  seabed.position.set(W / 2, (terrain.min_y ?? -5) - 1.5, H / 2);
  seabed.name = "seabed";
  scene.add(seabed);

  // -------------------------------------------------- water
  let waterMesh = null, waterUniforms = null;
  if (waterOn) {
    await onProgress(0.3, "Filling the sea");
    const SEG = lowQ ? 90 : 140;
    const g = new THREE.PlaneGeometry(W * 4, H * 4, SEG, SEG).rotateX(-Math.PI / 2);
    g.translate(W / 2, 0, H / 2);
    const p = g.attributes.position;
    const depth = new Float32Array(p.count);
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), z = p.getZ(i);
      const inside = x >= 0 && x <= W && z >= 0 && z <= H;
      depth[i] = inside ? waterLevel - heightAt(x, z) : 20;
    }
    g.setAttribute("wdepth", new THREE.BufferAttribute(depth, 1));
    const wcol = hexToColor(env.water.color || "#2a5a78");
    const mat = new THREE.MeshStandardMaterial({
      color: wcol, roughness: 0.06, metalness: 0.1, transparent: true, opacity: env.water.opacity ?? 0.8,
      envMap, envMapIntensity: 0.9, depthWrite: false,
    });
    waterUniforms = { uTime: { value: 0 }, uShallow: { value: wcol.clone().lerp(new THREE.Color("#7fc8c0"), 0.55) } };
    mat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, waterUniforms);
      sh.vertexShader = "attribute float wdepth;\nvarying float vDepth;\nvarying vec3 vWPos;\nuniform float uTime;\n" +
        sh.vertexShader.replace("#include <begin_vertex>", `#include <begin_vertex>
          vDepth = wdepth;
          transformed.y += (sin(position.x * 0.21 + uTime * 1.3) + sin(position.z * 0.17 - uTime * 1.1)) * 0.07 * clamp(wdepth, 0.0, 1.0);
          vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;`);
      sh.fragmentShader = "uniform float uTime;\nuniform vec3 uShallow;\nvarying float vDepth;\nvarying vec3 vWPos;\n" +
        sh.fragmentShader
          .replace("#include <color_fragment>", `#include <color_fragment>
            float dd = clamp(vDepth / 3.5, 0.0, 1.0);
            diffuseColor.rgb = mix(uShallow, diffuseColor.rgb, dd);
            float foam = (1.0 - smoothstep(0.0, 0.45, vDepth)) * (0.55 + 0.45 * sin(uTime * 2.2 + vWPos.x * 0.9 + vWPos.z * 0.7));
            diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.92, 0.95, 0.96), clamp(foam, 0.0, 1.0) * 0.75);
            diffuseColor.a = max(mix(0.35, opacity, dd), foam * 0.8);`)
          .replace("#include <normal_fragment_maps>", `#include <normal_fragment_maps>
            {
              vec2 q = vWPos.xz; float t = uTime;
              float nx = sin(q.x * 0.35 + t * 1.1) * 0.09 + sin(q.x * 1.1 - q.y * 0.7 + t * 1.9) * 0.05 + sin(q.y * 2.7 + q.x * 1.3 + t * 3.1) * 0.025;
              float nz = cos(q.y * 0.31 + t * 0.9) * 0.09 + sin(q.y * 1.3 + q.x * 0.5 - t * 1.6) * 0.05 + cos(q.x * 2.9 - q.y * 1.1 + t * 2.7) * 0.025;
              normal = normalize((viewMatrix * vec4(normalize(vec3(nx, 1.0, nz)), 0.0)).xyz);
            }`);
    };
    waterMesh = new THREE.Mesh(g, mat);
    waterMesh.position.y = waterLevel;
    waterMesh.name = "water";
    waterMesh.renderOrder = 2;
    waterMesh.receiveShadow = true;
    scene.add(waterMesh);
  }

  // -------------------------------------------------- assets → geometry
  await onProgress(0.4, "Building structures");
  const assetCache = new Map();
  const missingRefs = new Set();
  function asset(ref) {
    if (assetCache.has(ref)) return assetCache.get(ref);
    const rec = lib.record(ref);
    let out = null;
    if (rec?.format === "mesh-recipe" && rec.payload) {
      try { out = { rec, ...bakeRecipe(rec.payload, { warn }) }; } catch (e) { warn(`recipe ${ref}: ${e.message}`); }
    }
    if (!out) {
      missingRefs.add(ref);
      // A visible stand-in: a plain crate-sized box, so a missing asset is obvious but harmless.
      const g = mergeGeometries([new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0)]);
      out = { rec: null, buckets: [{ key: "missing", material_ref: "mat:wood", emissive: false, castShadow: true, geometry: g }], glow: [] };
    }
    assetCache.set(ref, out);
    return out;
  }

  const glowPoints = [];       // { pos: Vector3, color, strength, obj? }  — point-light candidates
  const shadowCasters = [];    // { obj, pos } toggled by distance
  const matrix = new THREE.Matrix4(), quat = new THREE.Quaternion(), scl = new THREE.Vector3(), vpos = new THREE.Vector3();
  const upAxis = new THREE.Vector3(0, 1, 0);

  const ixByPlacement = new Map();
  for (const ix of world.interactables || []) if (ix.placement_ref) ixByPlacement.set(ix.placement_ref, ix);

  // Static instances: grouped per asset, per 64 m chunk.
  const statics = new Map();   // ref → [{position, rotation_y, scale}]
  const addStatic = (ref, p) => { if (!statics.has(ref)) statics.set(ref, []); statics.get(ref).push(p); };
  const individual = [];
  for (const pl of world.placements || []) {
    if (ixByPlacement.has(pl.id) || pl.role === "pickup" || pl.role === "interactable") individual.push(pl);
    else addStatic(pl.asset_ref, pl);
  }
  let scatterInst = [];
  if (mods.expandScatter) {
    try { scatterInst = mods.expandScatter(world); } catch (e) { warn(`expandScatter failed: ${e.message}`); }
  } else {
    // Visual-only stand-in when terrain-sample.mjs is missing: seeded positions above water.
    for (const s of world.scatter || []) {
      const r = rng(s.seed >>> 0 || 1);
      const reg = s.region ? (world.regions || []).find((x) => x.id === s.region) : null;
      const [x0, z0, x1, z1] = reg ? reg.bounds : [0, 0, W, H];
      for (let k = 0; k < s.count; k++) {
        const x = x0 + (x1 - x0) * r(), z = z0 + (z1 - z0) * r(), y = heightAt(x, z);
        const rot = r() * Math.PI * 2, scv = s.min_scale + (s.max_scale - s.min_scale) * r();
        if (y > waterLevel + 0.4) scatterInst.push({ scatter_id: s.id, asset_ref: s.asset_ref, position: { x, y, z }, rotation_y: rot, scale: scv });
      }
    }
  }
  for (const s of scatterInst) addStatic(s.asset_ref, s);

  let instancedCount = 0;
  const chunkMeshes = [];
  for (const [ref, list] of statics) {
    const a = asset(ref);
    const chunks = new Map();
    for (const p of list) {
      const key = `${Math.floor(p.position.x / CHUNK)},${Math.floor(p.position.z / CHUNK)}`;
      if (!chunks.has(key)) chunks.set(key, []);
      chunks.get(key).push(p);
    }
    for (const items of chunks.values()) {
      const mats = items.map((p) => {
        quat.setFromAxisAngle(upAxis, p.rotation_y || 0);
        const s = p.scale || 1;
        scl.set(s, s, s);
        vpos.set(p.position.x, p.position.y ?? heightAt(p.position.x, p.position.z), p.position.z);
        return new THREE.Matrix4().compose(vpos, quat, scl);
      });
      // A sphere enclosing every instance of this chunk, for correct culling.
      const box = new THREE.Box3();
      const bs = a.buckets[0]?.geometry.boundingSphere || new THREE.Sphere(new THREE.Vector3(), 1);
      let maxS = 1;
      for (const p of items) { box.expandByPoint(new THREE.Vector3(p.position.x, p.position.y ?? 0, p.position.z)); maxS = Math.max(maxS, p.scale || 1); }
      const sphere = new THREE.Sphere(); box.getBoundingSphere(sphere); sphere.radius += (bs.radius + bs.center.length()) * maxS + 2;
      const center = sphere.center.clone();
      for (const b of a.buckets) {
        const mat = lib.material(b.material_ref, { emissive: b.emissive, glowColor: b.glowColor });
        if (mat.metalness > 0.3 && envMap && !mat.envMap) { mat.envMap = envMap; mat.needsUpdate = true; }
        const im = new THREE.InstancedMesh(shareGeometry(b.geometry, sphere), mat, items.length);
        mats.forEach((m, i) => im.setMatrixAt(i, m));
        im.instanceMatrix.needsUpdate = true;
        im.castShadow = b.castShadow;
        im.receiveShadow = true;
        im.userData = { ref, center, wantsShadow: b.castShadow };
        im.name = `inst:${ref}`;
        scene.add(im);
        chunkMeshes.push(im);
      }
      instancedCount += items.length;
      if (a.glow.length) {
        mats.forEach((m) => { for (const gp of a.glow) glowPoints.push({ pos: gp.clone().applyMatrix4(m), color: new THREE.Color(gp.color || "#ffb060"), strength: 1 }); });
      }
    }
  }

  // Individual placements: interactables and pickups, which change at runtime.
  const placementObjs = new Map();   // placement id → { obj, base, ix, flame }
  for (const pl of individual) {
    const a = asset(pl.asset_ref);
    const grp = new THREE.Group();
    for (const b of a.buckets) {
      const m = new THREE.Mesh(b.geometry, lib.material(b.material_ref, { emissive: b.emissive, glowColor: b.glowColor }));
      m.castShadow = b.castShadow; m.receiveShadow = true;
      grp.add(m);
    }
    grp.position.set(pl.position.x, pl.position.y ?? heightAt(pl.position.x, pl.position.z), pl.position.z);
    grp.rotation.y = pl.rotation_y || 0;
    grp.scale.setScalar(pl.scale || 1);
    grp.name = `pl:${pl.id}`;
    scene.add(grp);
    grp.updateMatrixWorld(true);
    const entry = { obj: grp, base: grp.position.clone(), ix: ixByPlacement.get(pl.id) || null, placement: pl, glow: [] };
    for (const gp of a.glow) {
      const g = { pos: gp.clone().applyMatrix4(grp.matrixWorld), color: new THREE.Color(gp.color || "#ffb060"), strength: 1, owner: entry };
      glowPoints.push(g); entry.glow.push(g);
    }
    if (pl.role === "pickup" || entry.ix?.kind === "pickup") {
      const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: radialTexture("rgba(160,220,255,1)", "rgba(80,160,255,0)"), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
      halo.scale.setScalar(1.8);
      halo.position.y = 0.5;
      grp.add(halo);
      entry.pickup = true;
      const g = { pos: grp.position.clone().add(new THREE.Vector3(0, 0.8, 0)), color: new THREE.Color("#8fd0ff"), strength: 0.8, owner: entry };
      glowPoints.push(g); entry.glow.push(g);
    }
    shadowCasters.push({ obj: grp, pos: grp.position });
    placementObjs.set(pl.id, entry);
  }

  // Flames for activatable lights (lanterns, altars, beacons) — shown once lit.
  const flameTex = radialTexture("rgba(255,210,140,1)", "rgba(255,120,30,0)");
  const flames = [];
  for (const entry of placementObjs.values()) {
    const k = entry.ix?.kind;
    if (!["lantern", "altar", "portal", "switch", "lever"].includes(k)) continue;
    const box = new THREE.Box3().setFromObject(entry.obj);
    const top = new THREE.Vector3((box.min.x + box.max.x) / 2, box.max.y + 0.3, (box.min.z + box.max.z) / 2);
    const f = new THREE.Sprite(new THREE.SpriteMaterial({ map: flameTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, color: new THREE.Color("#ffc070") }));
    const size = Math.max(2.2, (box.max.y - box.min.y) * 0.9);
    f.scale.set(size, size * 1.3, 1);
    f.position.copy(top);
    f.visible = false;
    scene.add(f);
    const g = { pos: top.clone(), color: new THREE.Color("#ffa040"), strength: 3.5, owner: entry, litOnly: true };
    glowPoints.push(g);
    flames.push({ entry, sprite: f, base: size, glow: g });
    entry.flame = f;
  }

  // A lighthouse sharing a region with a lit light gets its lamp lit too: a
  // halo and a slowly sweeping pair of beams — the payoff of the whole quest.
  const beams = [];
  for (const f of flames) {
    const region = f.entry.placement?.region;
    const lh = (world.placements || []).find((p) => /lighthouse/.test(p.asset_ref) && p.region === region);
    if (!lh) continue;
    const a = asset(lh.asset_ref);
    let top = 0;
    for (const b of a.buckets) { b.geometry.computeBoundingBox(); top = Math.max(top, b.geometry.boundingBox.max.y); }
    const y = (lh.position.y ?? heightAt(lh.position.x, lh.position.z)) + top * (lh.scale || 1) * 0.86;
    const grp = new THREE.Group();
    grp.position.set(lh.position.x, y, lh.position.z);
    const mat = new THREE.MeshBasicMaterial({ color: 0xffd9a0, transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false });
    for (const dir of [1, -1]) {
      const cone = new THREE.Mesh(new THREE.ConeGeometry(7, 70, 20, 1, true).translate(0, -35, 0).rotateZ(dir * Math.PI / 2), mat);
      grp.add(cone);
    }
    const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: flameTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, color: new THREE.Color("#fff0c0") }));
    halo.scale.set(9, 9, 1);
    grp.add(halo);
    grp.visible = false;
    grp.name = "lighthouse-beam";
    scene.add(grp);
    const g = { pos: grp.position.clone(), color: new THREE.Color("#ffd9a0"), strength: 3, owner: f.entry, litOnly: true };
    glowPoints.push(g);
    beams.push({ entry: f.entry, grp });
  }

  // One Points cloud of halos over every static glowing part: one draw call for all lamps.
  let haloPoints = null;
  {
    const statics = glowPoints.filter((g) => !g.owner && !g.litOnly);
    if (statics.length) {
      const arr = new Float32Array(statics.length * 3);
      statics.forEach((g, i) => { arr[i * 3] = g.pos.x; arr[i * 3 + 1] = g.pos.y; arr[i * 3 + 2] = g.pos.z; });
      const pg = new THREE.BufferGeometry();
      pg.setAttribute("position", new THREE.BufferAttribute(arr, 3));
      haloPoints = new THREE.Points(pg, new THREE.PointsMaterial({ size: 2.2, map: radialTexture(), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, sizeAttenuation: true }));
      haloPoints.name = "halos";
      scene.add(haloPoints);
    }
  }

  const lights = [];
  for (let i = 0; i < MAX_POINT_LIGHTS; i++) {
    const l = new THREE.PointLight(0xffa050, 0, 16, 2);
    l.castShadow = false;
    scene.add(l);
    lights.push(l);
  }

  // -------------------------------------------------- characters
  await onProgress(0.6, "Waking the islanders");
  const chars = new Map();
  for (const ch of pkg.characters?.characters || []) {
    const rec = lib.record(ch.asset_ref) || lib.record(`char:${ch.id}`);
    const recipe = rec?.format === "mesh-recipe" ? rec.payload : null;
    const built = buildCharacter(recipe || defaultPlayerRecipe(), lib, { warn });
    built.root.name = `char:${ch.id}`;
    const sp = (world.spawn_points || []).find((s) => s.id === ch.spawn_ref);
    if (sp) built.root.position.set(sp.position.x, heightAt(sp.position.x, sp.position.z), sp.position.z);
    scene.add(built.root);
    const hostile = !!ch.behavior?.hostile || ch.role === "enemy";
    if (!hostile) {
      const lbl = labelSprite(ch.name || ch.id, ch.companion ? "#ffd49a" : "#fff4e0");
      lbl.position.y = built.height + 0.45;
      built.root.add(lbl);
      built.label = lbl;
    }
    const glowCol = hostile ? new THREE.Color("#6fb8ff") : new THREE.Color("#ffb060");
    for (const g of built.glow) glowPoints.push({ pos: new THREE.Vector3(), color: glowCol, strength: hostile ? 1.4 : 0.7, charGlow: g });
    let marker = null;
    if (ch.role === "quest_giver") {
      marker = labelSprite("!", "#ffcf5a");
      marker.scale.set(0.5, 0.55, 1);
      marker.position.y = built.height + 1.05;
      marker.visible = false;
      built.root.add(marker);
    }
    chars.set(ch.id, { ...built, ch, hostile, marker, prev: built.root.position.clone(), speed: 0 });
  }

  // Player avatar: a package character marked as the player, else the built-in traveller.
  const playerRec = lib.record("char:player");
  const player = buildCharacter(playerRec?.format === "mesh-recipe" ? playerRec.payload : defaultPlayerRecipe(), lib, { warn });
  player.root.name = "player";
  scene.add(player.root);
  const playerLamp = new THREE.PointLight(0xffb366, 0.55 * lampBoost, 7 * Math.sqrt(lampBoost), 2);
  playerLamp.position.set(0.3, 1.1, 0.25);
  player.root.add(playerLamp);
  const spawn = (world.spawn_points || []).find((s) => s.id === "spawn_player") || (world.spawn_points || []).find((s) => s.kind === "player");
  if (spawn) player.root.position.set(spawn.position.x, heightAt(spawn.position.x, spawn.position.z), spawn.position.z);

  // -------------------------------------------------- markers & weather
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.75, 0.95, 40).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0xffd27a, transparent: true, opacity: 0.8, depthWrite: false, fog: false }));
  ring.visible = false; ring.renderOrder = 5;
  scene.add(ring);
  const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.8, 60, 12, 1, true).translate(0, 30, 0),
    new THREE.MeshBasicMaterial({ color: 0xffc860, transparent: true, opacity: 0.16, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false }));
  beam.visible = false; beam.name = "objective-beam";
  scene.add(beam);

  let rain = null;
  if (["rain", "storm", "snow", "ash"].includes(weather)) {
    const N = lowQ ? 700 : 1600;
    const snow = weather === "snow" || weather === "ash";
    const arr = new Float32Array(N * 6);
    const r = rng(99);
    const seeds = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) { seeds[i * 3] = r() * 60 - 30; seeds[i * 3 + 1] = r() * 30; seeds[i * 3 + 2] = r() * 60 - 30; }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(arr, 3));
    const mat = new THREE.LineBasicMaterial({ color: snow ? 0xffffff : 0xa8c0d8, transparent: true, opacity: snow ? 0.8 : 0.42, depthWrite: false, fog: true });
    rain = { lines: new THREE.LineSegments(g, mat), seeds, N, snow, speed: snow ? 2.5 : (weather === "storm" ? 26 : 20), wind: weather === "storm" ? 6 : 2 };
    rain.lines.frustumCulled = false;
    scene.add(rain.lines);
  }
  let flash = 0, nextFlash = 6;
  const flashRng = rng(1234);

  // -------------------------------------------------- camera
  const cam = {
    yaw: (spawn?.rotation_y ?? 0) + Math.PI, pitch: 0.32, dist: camRig.distance || 7,
    minPitch: camRig.min_pitch ?? -0.35, maxPitch: Math.min(1.35, camRig.max_pitch ?? 1.2),
    focus: new THREE.Vector3(), pos: new THREE.Vector3(), initialised: false, free: false, followYaw: true,
  };
  let colliders = [];

  function solidAt(p) {
    for (const c of colliders) {
      if (!c.solid) continue;
      const dx = p.x - c.center.x, dz = p.z - c.center.z;
      const hh = c.shape === "box" ? c.half.y : (c.height || 0) / 2;
      if (Math.abs(p.y - c.center.y) > hh + 0.2) continue;
      if (c.shape === "cylinder") { if (dx * dx + dz * dz < (c.radius + 0.2) ** 2) return true; continue; }
      const cs = Math.cos(c.rotation_y || 0), sn = Math.sin(c.rotation_y || 0);
      const lx = dx * cs - dz * sn, lz = dx * sn + dz * cs;
      if (Math.abs(lx) < c.half.x + 0.2 && Math.abs(lz) < c.half.z + 0.2) return true;
    }
    return false;
  }

  const _dir = new THREE.Vector3(), _want = new THREE.Vector3(), _probe = new THREE.Vector3();
  function updateCamera(dt, focusPos) {
    const lift = camRig.height ? Math.min(2.2, camRig.height * 0.55) : 1.5;
    const f = _want.set(focusPos.x, focusPos.y + lift, focusPos.z);
    if (!cam.initialised) { cam.focus.copy(f); }
    cam.focus.lerp(f, 1 - Math.exp(-dt * 10));
    _dir.set(Math.sin(cam.yaw) * Math.cos(cam.pitch), Math.sin(cam.pitch), Math.cos(cam.yaw) * Math.cos(cam.pitch));
    // March from the focus towards the wanted spot; stop short of ground and solids.
    let d = cam.dist;
    for (let s = 0.4; s <= cam.dist; s += 0.25) {
      _probe.copy(cam.focus).addScaledVector(_dir, s);
      if (_probe.y < heightAt(_probe.x, _probe.z) + 0.35 || (camRig.collide !== false && solidAt(_probe))) { d = Math.max(0.8, s - 0.3); break; }
    }
    const target = _probe.copy(cam.focus).addScaledVector(_dir, d);
    if (!cam.initialised) { cam.pos.copy(target); cam.initialised = true; }
    else {
      // Pull in fast (never clip), ease back out slowly.
      const k = cam.pos.distanceTo(cam.focus) > d ? 1 - Math.exp(-dt * 22) : 1 - Math.exp(-dt * 6);
      cam.pos.lerp(target, k);
    }
    const floor = heightAt(cam.pos.x, cam.pos.z) + 0.3;
    if (cam.pos.y < floor) cam.pos.y = floor;
    if (waterOn && cam.pos.y < waterLevel + 0.25) cam.pos.y = waterLevel + 0.25;
    camera.position.copy(cam.pos);
    camera.lookAt(cam.focus);
  }

  // Free-fly camera for view-only mode (no sim-core).
  function updateFreeCamera(dt, wish) {
    const sp = wish.run ? 40 : 16;
    const fwd = new THREE.Vector3(-Math.sin(cam.yaw), 0, -Math.cos(cam.yaw));
    const right = new THREE.Vector3(Math.cos(cam.yaw), 0, -Math.sin(cam.yaw));
    cam.pos.addScaledVector(fwd, (wish.forward || 0) * sp * dt).addScaledVector(right, (wish.right || 0) * sp * dt);
    cam.pos.y += (wish.up || 0) * sp * dt;
    cam.pos.y = Math.max(cam.pos.y, heightAt(cam.pos.x, cam.pos.z) + 1.5);
    camera.position.copy(cam.pos);
    camera.rotation.set(-cam.pitch, cam.yaw, 0, "YXZ");
  }

  // -------------------------------------------------- per-frame update
  let time = 0, lightTimer = 0, shadowTimer = 0;
  const focusVec = new THREE.Vector3();
  const snap = new THREE.Vector3();

  function assignLights(center, litSet) {
    const cands = [];
    for (const g of glowPoints) {
      if (g.owner?.hidden) continue;
      if (g.litOnly && !g.owner?.lit) continue;
      const p = g.charGlow ? g.pos : g.pos;
      const d = p.distanceTo(center);
      if (d > 45) continue;
      cands.push({ g, score: d / g.strength });
    }
    cands.sort((a, b) => a.score - b.score);
    // Spread: skip a candidate within 3 m of one already lit (a lamp with two glowing parts is one light).
    const chosen = [];
    for (const c of cands) {
      if (chosen.length >= MAX_POINT_LIGHTS) break;
      if (chosen.some((o) => o.g.pos.distanceToSquared(c.g.pos) < 9)) continue;
      chosen.push(c);
    }
    lights.forEach((l, i) => {
      const c = chosen[i];
      if (!c) { l.intensity = 0; l.userData.base = 0; return; }
      l.position.copy(c.g.pos);
      l.color.copy(c.g.color);
      l.userData.base = 1.5 * Math.min(3, c.g.strength) * lampBoost;
      l.distance = 10 + 4 * Math.min(3, c.g.strength);
    });
  }

  /**
   * Pose the scene from a view of the sim:
   * view = { player:{position,rotation_y,velocity,grounded}, npcs:{id:NpcState}, collected:Set, lit:Set,
   *          defeated:Set, nearest:{id}|null, objectiveTarget:{x,y,z}|null, questMarkers:Set, freeWish, weather }
   */
  function update(dt, view) {
    time += dt;
    skyMat.uniforms.uTime.value = time;
    if (waterUniforms) waterUniforms.uTime.value = time;

    // Player
    let focus = null;
    if (view.player) {
      const p = view.player.position;
      player.root.position.set(p.x, p.y, p.z);
      const target = view.player.rotation_y ?? 0;
      let dr = target - player.root.rotation.y;
      dr = Math.atan2(Math.sin(dr), Math.cos(dr));
      player.root.rotation.y += dr * (1 - Math.exp(-dt * 14));
      const v = view.player.velocity || { x: 0, z: 0 };
      const sp = Math.hypot(v.x, v.z);
      player.animate(dt, !view.player.grounded ? "run" : sp > 5.5 ? "run" : sp > 0.3 ? "walk" : "idle", sp);
      focus = focusVec.set(p.x, p.y, p.z);
    }

    // Characters
    for (const [id, c] of chars) {
      const n = view.npcs?.[id];
      const gone = view.defeated?.has(id);
      c.root.visible = !gone;
      if (!n || gone) { c.animate(dt, "idle", 0); continue; }
      const k = 1 - Math.exp(-dt * 18);
      c.root.position.x += (n.position.x - c.root.position.x) * k;
      c.root.position.z += (n.position.z - c.root.position.z) * k;
      c.root.position.y += ((n.position.y ?? heightAt(n.position.x, n.position.z)) - c.root.position.y) * k;
      let dr = (n.rotation_y ?? 0) - c.root.rotation.y;
      if (n.anim === "talk" && view.player) dr = Math.atan2(view.player.position.x - c.root.position.x, view.player.position.z - c.root.position.z) - c.root.rotation.y;
      dr = Math.atan2(Math.sin(dr), Math.cos(dr));
      c.root.rotation.y += dr * (1 - Math.exp(-dt * 8));
      const sp = dt > 0 ? c.prev.distanceTo(c.root.position) / dt : 0;
      c.speed += (sp - c.speed) * 0.2;
      c.prev.copy(c.root.position);
      c.animate(dt, n.anim || "idle", c.speed);
      if (c.label) {
        const d = camera.position.distanceTo(c.root.position);
        c.label.visible = d < 32;
        c.label.material.opacity = Math.max(0, Math.min(1, (32 - d) / 8));
      }
      if (c.marker) { c.marker.visible = !!view.questMarkers?.has(id); c.marker.position.y = c.height + 1.05 + Math.sin(time * 3) * 0.08; }
      for (const gp of glowPoints) if (gp.charGlow && c.glow.includes(gp.charGlow)) gp.pos.copy(gp.charGlow.local).applyMatrix4(gp.charGlow.holder.matrixWorld);
    }

    // Placements: pickups bob and vanish, lights ignite.
    for (const e of placementObjs.values()) {
      const collected = e.ix && view.collected?.has(e.ix.id);
      e.hidden = !!collected;
      e.obj.visible = !collected;
      if (e.pickup && !collected) {
        e.obj.position.y = e.base.y + 0.35 + Math.sin(time * 2.2 + e.base.x) * 0.15;
        e.obj.rotation.y += dt * 1.6;
      }
      e.lit = !!(e.ix && view.lit?.has(e.ix.id));
    }
    for (const b of beams) {
      b.grp.visible = b.entry.lit;
      if (b.entry.lit) b.grp.rotation.y = time * 0.6;
    }
    for (const f of flames) {
      f.sprite.visible = f.entry.lit;
      if (f.entry.lit) {
        const fl = 1 + Math.sin(time * 13 + f.base) * 0.06 + Math.sin(time * 23) * 0.04;
        f.sprite.scale.set(f.base * fl, f.base * 1.3 * fl, 1);
      }
    }

    // Interaction ring and objective beam
    if (view.nearestPos) {
      ring.visible = true;
      ring.position.set(view.nearestPos.x, (view.nearestPos.y ?? heightAt(view.nearestPos.x, view.nearestPos.z)) + 0.06, view.nearestPos.z);
      ring.scale.setScalar(1 + Math.sin(time * 5) * 0.08);
    } else ring.visible = false;
    if (view.objectiveTarget) {
      beam.visible = true;
      beam.position.set(view.objectiveTarget.x, view.objectiveTarget.y ?? heightAt(view.objectiveTarget.x, view.objectiveTarget.z), view.objectiveTarget.z);
      beam.material.opacity = 0.12 + Math.sin(time * 2) * 0.04;
    } else beam.visible = false;

    // Camera
    if (cam.fixed) {
      camera.position.set(cam.fixed.from.x, cam.fixed.from.y, cam.fixed.from.z);
      camera.lookAt(cam.fixed.at.x, cam.fixed.at.y, cam.fixed.at.z);
    } else if (view.freeWish) updateFreeCamera(dt, view.freeWish);
    else if (focus) updateCamera(dt, focus);
    skyDome.position.copy(camera.position);

    // Sun and shadow frustum follow the player, snapped to shadow texels so edges do not crawl.
    const centre = focus || camera.position;
    const texel = (sc.right - sc.left) / sun.shadow.mapSize.x;
    snap.set(Math.round(centre.x / texel) * texel, centre.y, Math.round(centre.z / texel) * texel);
    sun.target.position.copy(snap);
    sun.position.copy(snap).addScaledVector(sunDir, 120);

    // Budgets: nearest lights, nearby shadow casters.
    lightTimer -= dt; shadowTimer -= dt;
    if (lightTimer <= 0) { assignLights(centre); lightTimer = 0.25; }
    for (const [i, l] of lights.entries()) if (l.userData.base) l.intensity = l.userData.base * (0.92 + 0.08 * Math.sin(time * (9 + i) + i * 1.7));
    if (shadowTimer <= 0) {
      shadowTimer = 0.5;
      for (const im of chunkMeshes) im.castShadow = im.userData.wantsShadow && im.userData.center.distanceTo(centre) < SHADOW_RADIUS + CHUNK * 0.75;
      for (const s of shadowCasters) s.obj.traverse((o) => { if (o.isMesh) o.castShadow = s.pos.distanceTo(centre) < SHADOW_RADIUS; });
    }

    // Weather follows the game (a set_weather action), not just the world default.
    const wNow = view.weather || weather;
    if (rain) {
      const target = wNow === "storm" ? 1 : wNow === "rain" ? 0.55 : ["snow", "ash"].includes(wNow) ? 1 : 0;
      rain.level = rain.level === undefined ? target : rain.level + (target - rain.level) * (1 - Math.exp(-dt * 0.8));
      rain.lines.visible = rain.level > 0.02;
      rain.lines.material.opacity = (rain.snow ? 0.8 : 0.42) * Math.min(1, rain.level);
    }
    if (rain && rain.lines.visible) {
      const a = rain.lines.geometry.attributes.position.array;
      const len = rain.snow ? 0.08 : 0.55;
      const fall = (time * rain.speed);
      for (let i = 0; i < rain.N; i++) {
        const sx = rain.seeds[i * 3], sy = rain.seeds[i * 3 + 1], sz = rain.seeds[i * 3 + 2];
        const y = 30 - ((fall + sy * 7.3) % 30);
        const wx = rain.snow ? Math.sin(time + i) * 0.6 : (30 - y) * rain.wind * 0.02;
        const x = camera.position.x + sx + wx, z = camera.position.z + sz, yy = camera.position.y - 8 + y;
        a[i * 6] = x; a[i * 6 + 1] = yy; a[i * 6 + 2] = z;
        a[i * 6 + 3] = x + rain.wind * 0.02; a[i * 6 + 4] = yy - len; a[i * 6 + 5] = z;
      }
      rain.lines.geometry.attributes.position.needsUpdate = true;
    }
    if (wNow === "storm") {
      nextFlash -= dt;
      if (nextFlash <= 0) { flash = 1; nextFlash = 7 + flashRng() * 9; }
      flash = Math.max(0, flash - dt * 4.5);
      const f = flash > 0.6 || (flash > 0.2 && flash < 0.35) ? flash : 0;
      skyMat.uniforms.uFlash.value = f * 0.8;
      hemi.intensity = baseHemi * (1 + f * 2.5);
    } else if (skyMat.uniforms.uFlash.value) { skyMat.uniforms.uFlash.value = 0; hemi.intensity = baseHemi; }
    const cloudTarget = wNow === weather ? cloudiness : ({ clear: 0.15, cloudy: 0.6, rain: 0.7, storm: 0.95 }[wNow] ?? cloudiness);
    skyMat.uniforms.uCloud.value += (cloudTarget - skyMat.uniforms.uCloud.value) * (1 - Math.exp(-dt * 0.5));
    sun.intensity = baseSun;
  }

  function resize(w, h) {
    renderer.setSize(w, h, false);
    camera.aspect = w / Math.max(1, h);
    camera.updateProjectionMatrix();
  }

  function render() { renderer.render(scene, camera); }

  function stats() {
    const i = renderer.info;
    return { draw_calls: i.render.calls, triangles: i.render.triangles, textures: i.memory.textures, geometries: i.memory.geometries, programs: i.programs?.length ?? 0 };
  }

  const project = new THREE.Vector3();
  function worldToScreen(p, w, h) {
    project.set(p.x, p.y, p.z).project(camera);
    return { x: (project.x * 0.5 + 0.5) * w, y: (1 - (project.y * 0.5 + 0.5)) * h, visible: project.z < 1 && project.z > -1 };
  }

  await onProgress(0.8, "Compiling shaders");
  try { renderer.compile(scene, camera); } catch (e) { warn(`precompile: ${e.message}`); }

  return {
    THREE, renderer, scene, camera, cam, lib, heightAt, update, render, resize, stats, worldToScreen,
    setColliders(c) { colliders = c || []; },
    objects: { terrain: terrainMesh, water: waterMesh, sky: skyDome, player, chars, placements: placementObjs, beam, ring },
    info: { instanced: instancedCount, chunks: chunkMeshes.length, missingRefs: [...missingRefs], glowSources: glowPoints.length, textureStats: lib.stats },
  };
}
