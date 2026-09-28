// Games-B asset stage (CONTRACT §4, §4.5): logical refs in → AssetRecords out.
// NODE-ONLY (hashing, cache, provider lanes).
//
//   resolveAssets({ concept, world, characters, gameplay?, gameId, cache?, env? })
//     → { records, byRef, materials, stats, provenance: [ProvenanceStage], warnings, validation, blobs }
//
// Flow:
//   1. Collect every logical ref the game needs, with who uses it (bindings):
//      world placements / scatter / terrain layers / water, characters, item
//      icons, sky:main, ui:*, cine:intro — then every mat: a mesh part names
//      and every tex: a material needs.
//   2. For each ref build the procedural payload (cheap: recipes, not pixels).
//   3. Derive a request key from (kind, ref, payload, which providers are
//      AVAILABLE). Cache hit → the stored record, re-stamped CACHED at cost 0.
//      Miss → run the provider lane (mesh, or image for albedo textures); the
//      procedural adapter is the lane's fallback, so an offline run still
//      produces every asset and says FALLBACK.
//   4. asset_id = "ast_" + sha256(canonicalJson({kind, payload}))[0..16], so
//      identical content is one record however many placements use it.

import { canonicalJson, sha256, promptHash } from "../common/hash.mjs";
import { buildMeshRecipe, buildCharacterRecipe, nearestLibName, libAssetKind, estimateTriangles, LIB_ROLES } from "./mesh-recipes.mjs";
import { buildMaterialSpec, MATERIAL_NAMES } from "./materials.mjs";
import { iconSvg, uiSvg, skyRecipe, UI_NAMES } from "./svg.mjs";
import { buildIntroCinematic } from "./cinematic.mjs";
import { createImageLane, createMeshLane, runLane, availableProviders } from "./providers.mjs";
import { validateAssetSet, ASSET_RECORD_VERSION } from "./asset-record.schema.mjs";

export const ASSET_PIPELINE_VERSION = "gamesb-assets-1.0.0";
const PROCEDURAL_LICENSE = Object.freeze({ spdx: "LicenseRef-DCS-Procedural", commercial_use: "cleared" });
const FLUX_LICENSE = Object.freeze({ spdx: "LicenseRef-Together-FLUX.1-schnell", commercial_use: "internal-testing-only" });

export const assetIdFor = (kind, payload) => "ast_" + sha256(canonicalJson({ kind, payload })).slice(0, 16);

const PICKUPS = new Set(LIB_ROLES.pickup);
const ITEM_KIND_ICON = { key: "key", consumable: "herb", quest: "relic", collectible: "gem" };

// ------------------------------------------------------------- ref collection

/**
 * Every logical ref the game needs, before materials/textures.
 * @returns {{ uses: Map<ref, Set<string>>, roles: Map<ref,string>, instances: Map<ref,number>, items: Map<itemId, iconKind> }}
 */
export function collectRequiredRefs({ world, characters, gameplay } = {}) {
  const uses = new Map(), roles = new Map(), instances = new Map(), items = new Map();
  const use = (ref, by) => { if (typeof ref !== "string" || !ref) return; if (!uses.has(ref)) uses.set(ref, new Set()); if (by) uses.get(ref).add(by); };
  const count = (ref, n) => instances.set(ref, (instances.get(ref) || 0) + n);

  const placements = Array.isArray(world?.placements) ? world.placements : [];
  for (const p of placements) {
    use(p.asset_ref, p.id); count(p.asset_ref, 1);
    if (p.role && !roles.has(p.asset_ref)) roles.set(p.asset_ref, p.role);
  }
  for (const s of world?.scatter || []) {
    use(s.asset_ref, s.id); count(s.asset_ref, Math.max(0, s.count | 0));
    if (!roles.has(s.asset_ref)) roles.set(s.asset_ref, "foliage");
  }
  for (const l of world?.terrain?.material_layers || []) use(l.material_ref, "world.terrain");
  if (world?.environment?.water?.enabled) use("mat:water", "world.water");

  const chars = characters?.characters || [];
  for (const c of chars) use(charRef(c), c.id);
  if (!chars.some((c) => c.id === "player")) use("char:player", "player");

  // Item icons: gameplay's inventory when there is one, else what pickups grant.
  const placementById = new Map(placements.map((p) => [p.id, p]));
  const ixByItem = new Map();
  for (const ix of world?.interactables || []) if (ix.item_ref && !ixByItem.has(ix.item_ref)) ixByItem.set(ix.item_ref, ix);
  const iconKind = (itemId, itemKind) => {
    const ix = ixByItem.get(itemId);
    const lib = ix ? placementById.get(ix.placement_ref)?.asset_ref : null;
    if (typeof lib === "string") { const n = nearestLibName(lib, { role: "pickup" }).name; if (PICKUPS.has(n)) return n; }
    return ITEM_KIND_ICON[itemKind] || "generic";
  };
  const invItems = gameplay?.inventory?.items;
  if (Array.isArray(invItems) && invItems.length) {
    for (const it of invItems) {
      const ref = typeof it.icon_ref === "string" && it.icon_ref.startsWith("icon:") ? it.icon_ref : `icon:${it.id}`;
      use(ref, it.id); items.set(ref, { item_id: it.id, name: it.name || it.id, icon_kind: iconKind(it.id, it.kind) });
    }
  } else {
    for (const [itemId] of ixByItem) { const ref = `icon:${itemId}`; use(ref, itemId); items.set(ref, { item_id: itemId, name: itemId, icon_kind: iconKind(itemId, null) }); }
  }

  use("sky:main", "world.environment");
  for (const n of UI_NAMES) use(`ui:${n}`, "hud");
  use("cine:intro", "intro");
  return { uses, roles, instances, items };
}

const charRef = (c) => (typeof c?.asset_ref === "string" && c.asset_ref.startsWith("char:") ? c.asset_ref : `char:${c.id}`);

// ------------------------------------------------------------------ helpers

function recordBase({ ref, kind, name, format, payload, dimensions }) {
  const body = canonicalJson(payload);
  return {
    asset_record_version: ASSET_RECORD_VERSION,
    asset_id: assetIdFor(kind, payload),
    ref, kind, name,
    provider: "local:procedural", model: "deterministic",
    prompt: null, prompt_hash: sha256(body),
    version: 1, source: "procedural",
    cost_usd: 0, latency_ms: 0,
    format, dimensions: dimensions ?? null,
    bytes: Buffer.byteLength(body), sha256: sha256(body),
    game_bindings: [],
    provenance: null,
    payload, uri: null,
  };
}

const prov = (at, lane, adapter, status, after_failed = [], license = PROCEDURAL_LICENSE) =>
  ({ generated_at: at, lane, adapter, status, after_failed: [...after_failed], license: { ...license } });

function unknownMaterialFallback(name) {
  const n = String(name).toLowerCase();
  const table = [[/lava|magma|fire|coal/, "ember"], [/ice|frost/, "snow"], [/glass|gem/, "crystal"], [/gold|bronze|copper/, "brass"], [/iron|steel/, "metal"],
    [/marble|granite|brick|cobble|concrete/, "stone"], [/mud|soil|earth|path/, "dirt"], [/moss|turf|lawn/, "grass"], [/fabric|canvas|rope|leather/, "cloth"],
    [/thatch|shingle|tile/, "roof"], [/timber|log|board/, "wood"], [/foliage|leaf|hedge/, "leaves"], [/light|lamp|neon|emissive/, "glow"], [/sea|ocean|lake|river/, "water"]];
  for (const [re, m] of table) if (re.test(n)) return m;
  return "rock";
}

// ------------------------------------------------------------------- main

/**
 * @param {object} o
 * @param {object} o.concept    GameConcept (palette, biome, seed, mood)
 * @param {object} o.world      WorldSpec
 * @param {object} [o.characters] CharactersSpec
 * @param {object} [o.gameplay]  GameplaySpec (for inventory icons)
 * @param {string} o.gameId
 * @param {object} [o.cache]     createAssetCache(dir); omit to run uncached
 * @param {object} [o.env]       process env (lanes read keys / offline flag)
 * @param {object} [o.adapters]  { image: [adapter...], mesh: [adapter...] } — test injection
 * @param {() => string} [o.clock] ISO timestamp source (pin it for byte-identical output)
 * @param {"albedo"|"none"} [o.imageTextures] which texture channels may go to the image lane
 * @param {number} [o.textureSize]
 */
export async function resolveAssets({ concept = null, world, characters = null, gameplay = null, gameId, cache = null, env = process.env, adapters = {}, clock = () => new Date().toISOString(), imageTextures = "albedo", textureSize = 256 } = {}) {
  if (!world || typeof world !== "object") throw new TypeError("resolveAssets: world is required");
  const game_id = String(gameId || world.id || "game");
  const palette = concept?.palette || null;
  const biome = concept?.biome || world.biome || null;
  const seed = Number.isInteger(world.seed) ? world.seed : Number.isInteger(concept?.seed) ? concept.seed : 0;
  // Optional Games-D material style (add-only): absent → the exact Games-B materials.
  const style = concept?.material_style && typeof concept.material_style === "object" ? concept.material_style : null;
  const matOpts = style ? { palette, biome, textureSize, style } : { palette, biome, textureSize };
  const at = clock();

  const imageLane = createImageLane({ env, adapters: adapters.image || null });
  const meshLane = createMeshLane({ env, adapters: adapters.mesh || null });
  const avail = { image: await availableProviders(imageLane), mesh: await availableProviders(meshLane) };

  const { uses, roles, instances, items } = collectRequiredRefs({ world, characters, gameplay });
  const warnings = [];
  const laneStages = [];
  const out = [];                       // produced records, in production order
  const blobs = {};
  let hits = 0, misses = 0;

  /**
   * Produce one record through cache → lane → procedural.
   * job: { ref, kind, name, format, payload, dimensions, lane?: "mesh"|"image", laneReq?, source? }
   */
  async function produce(job) {
    const key = "k_" + sha256(canonicalJson({ v: ASSET_PIPELINE_VERSION, kind: job.kind, ref: job.ref, payload: job.payload, providers: job.lane ? avail[job.lane] : [] })).slice(0, 40);
    if (cache) {
      const hit = cache.get(key);
      if (hit && hit.asset_id) {
        hits++;
        const rec = structuredClone(hit);
        rec.source = "cached"; rec.cost_usd = 0; rec.latency_ms = 0;
        rec.provenance = { ...rec.provenance, status: "CACHED" };
        if (hit.payload?.image?.sha256 && cache.getBlob) { const b = cache.getBlob(hit.payload.image.sha256); if (b) blobs[hit.payload.image.sha256] = b; }
        out.push(rec);
        return rec;
      }
      misses++;
    }
    let rec = recordBase(job);
    if (job.source) rec.source = job.source;
    rec.provenance = prov(at, "local", job.source === "curated" ? "local:curated-svg" : "local:procedural", "FALLBACK");
    if (job.lane) {
      const lane = job.lane === "image" ? imageLane : meshLane;
      const { value, stage } = await runLane(lane, { ...job.laneReq, recipe: job.payload }, job.lane === "image" ? "textures" : "assets");
      laneStages.push(stage);
      const after = stage.after_failed || [];
      if (value.kind === "image" && Buffer.isBuffer(value.bytes)) {
        const imgSha = sha256(value.bytes);
        const payload = { ...job.payload, image: { sha256: imgSha, mime: value.mime, px_w: value.px_w, px_h: value.px_h } };
        rec = recordBase({ ...job, format: "png", payload, dimensions: { px_w: value.px_w, px_h: value.px_h } });
        Object.assign(rec, {
          provider: stage.provider, model: stage.model, prompt: job.laneReq.prompt, prompt_hash: promptHash(job.laneReq.prompt),
          source: "generated", cost_usd: stage.cost_usd, latency_ms: stage.latency_ms,
          bytes: value.bytes.length, sha256: imgSha, uri: `textures/${rec.asset_id}.png`,
          provenance: prov(at, stage.lane, stage.provider, "AVAILABLE", after, FLUX_LICENSE),
        });
        blobs[imgSha] = value.bytes;
        cache?.putBlob?.(value.bytes);
      } else if (value.kind === "glb" && typeof value.uri === "string") {
        const payload = { ...job.payload, glb: { uri: value.uri, polycount: value.polycount ?? null } };
        rec = recordBase({ ...job, format: "glb", payload });
        const lic = value.license && typeof value.license === "object" ? { spdx: String(value.license.spdx || "NOASSERTION"), commercial_use: "unknown" } : { spdx: "NOASSERTION", commercial_use: "unknown" };
        Object.assign(rec, {
          provider: stage.provider, model: stage.model, prompt: job.laneReq.prompt, prompt_hash: promptHash(job.laneReq.prompt),
          source: "generated", cost_usd: stage.cost_usd, latency_ms: stage.latency_ms, uri: value.uri,
          provenance: prov(at, stage.lane, stage.provider, "AVAILABLE", after, lic),
        });
      } else {
        // The lane's fallback answered: the procedural payload stands, and the
        // record says which lane and adapters were tried first.
        rec.provider = stage.provider; rec.model = stage.model;
        rec.provenance = prov(at, stage.lane, stage.provider, "FALLBACK", after);
      }
    }
    rec.version = cache ? cache.versionFor(rec.ref, rec.asset_id) : 1;
    if (cache) cache.put(key, rec);
    out.push(rec);
    return rec;
  }

  const sortedRefs = [...uses.keys()].sort();
  const matUses = new Map();            // mat ref → Set(user ref)
  const addMat = (m, by) => { if (!matUses.has(m)) matUses.set(m, new Set()); if (by) matUses.get(m).add(by); };
  const meshRecords = [];

  // 1. Meshes: library entries and characters.
  for (const ref of sortedRefs) {
    let recipe, kind, name, prompt, archetype;
    if (ref.startsWith("char:")) {
      const id = ref.slice(5);
      const c = (characters?.characters || []).find((x) => charRef(x) === ref);
      const ch = c || (id === "player" ? playerCharacter(concept) : { id, kind: "humanoid", body: {} });
      if (!c && id !== "player") warnings.push(`'${ref}' has no character in the CharactersSpec; built a default humanoid`);
      recipe = buildCharacterRecipe(ch);
      kind = ch.kind === "creature" ? "creature" : id === "player" ? "character" : "npc";
      name = ch.name || id;
      prompt = `${ch.kind || "humanoid"} character '${name}', ${ch.body?.build || "average"} build, stylised low-poly`;
      archetype = ch.kind === "creature" ? "creature_quadruped" : "humanoid";
    } else if (ref.startsWith("lib:") || !/^[a-z]+:/.test(ref)) {
      recipe = buildMeshRecipe(ref, { seed: 0, palette, biome, role: roles.get(ref) });
      if (recipe.warnings) warnings.push(...recipe.warnings);
      if (!ref.startsWith("lib:")) warnings.push(`asset_ref '${ref}' has no lib: prefix; treated as a library name`);
      kind = libAssetKind(recipe.lib); name = recipe.lib;
      prompt = `${recipe.lib.replace(/_/g, " ")} for a ${biome || "fantasy"} adventure game, stylised low-poly`;
      archetype = recipe.lib;
    } else continue;
    const rec = await produce({
      ref, kind, name, format: "mesh-recipe", payload: recipe,
      dimensions: { w: recipe.bounds.w, h: recipe.bounds.h, d: recipe.bounds.d },
      lane: "mesh", laneReq: { prompt, archetype, style: concept?.mood || biome || null, polyBudget: 20000 },
    });
    meshRecords.push(rec);
    for (const p of recipe.parts) addMat(p.material_ref, ref);
  }
  for (const ref of sortedRefs) if (ref.startsWith("mat:")) for (const by of uses.get(ref)) addMat(ref, by);

  // 2. Materials, each preceded by its textures.
  const materialsById = {};
  for (const mref of [...matUses.keys()].sort()) {
    const name = mref.slice(4);
    let spec = buildMaterialSpec(name, matOpts);
    if (!spec) {
      const fb = unknownMaterialFallback(name);
      warnings.push(`unknown material '${mref}' built from 'mat:${fb}'`);
      spec = buildMaterialSpec(fb, matOpts);
      spec.material.material_id = mref;
      // Texture refs keep the requested name so they stay unique per material.
      spec.textures = spec.textures.map((t) => ({ ...t, ref: `tex:${name}_${t.channel}` }));
      spec.material.texture_refs = Object.fromEntries(spec.textures.map((t) => [t.channel, t.ref]));
    }
    const texIds = {};
    for (const t of spec.textures) {
      const useImage = imageTextures === "albedo" && t.channel === "albedo";
      const tr = await produce({
        ref: t.ref, kind: "texture", name: `${name} ${t.channel}`, format: "texture-recipe", payload: t.recipe,
        dimensions: { px_w: t.recipe.size, px_h: t.recipe.size },
        ...(useImage ? { lane: "image", laneReq: { prompt: `seamless tileable ${t.recipe.generator.replace(/_/g, " ")} texture, flat top-down albedo, even lighting, no shadows, ${biome || "temperate"} setting, colours ${t.recipe.colors.slice(0, 3).join(" ")}`, width: Math.max(256, t.recipe.size), height: Math.max(256, t.recipe.size) } } : {}),
      });
      texIds[t.channel] = tr.asset_id;
    }
    const payload = {
      ...spec.material,
      ...(texIds.albedo ? { albedo_texture: texIds.albedo } : {}),
      ...(texIds.normal ? { normal_texture: texIds.normal } : {}),
      ...(texIds.roughness ? { roughness_texture: texIds.roughness } : {}),
    };
    const mr = await produce({ ref: mref, kind: "material", name, format: "material", payload, dimensions: null });
    materialsById[mref] = mr;
  }

  // 3. Icons, HUD, sky, cinematic.
  for (const ref of sortedRefs) {
    if (ref.startsWith("icon:")) {
      const it = items.get(ref) || { item_id: ref.slice(5), name: ref.slice(5), icon_kind: "generic" };
      await produce({ ref, kind: "icon", name: it.name, format: "svg", source: "curated", payload: { svg: iconSvg(it.icon_kind, { palette, title: it.name }), icon_kind: it.icon_kind, item_id: it.item_id }, dimensions: { px_w: 64, px_h: 64 } });
    } else if (ref.startsWith("ui:")) {
      const svg = uiSvg(ref.slice(3), { palette });
      if (!svg) { warnings.push(`unknown ui ref '${ref}'`); continue; }
      const m = /viewBox="0 0 (\d+) (\d+)"/.exec(svg);
      await produce({ ref, kind: "ui", name: ref.slice(3), format: "svg", source: "curated", payload: { svg }, dimensions: { px_w: +m[1], px_h: +m[2] } });
    } else if (ref === "sky:main" || ref.startsWith("sky:")) {
      await produce({ ref, kind: "sky", name: "sky", format: "json", payload: skyRecipe(world.environment || {}, { seed }), dimensions: null });
    } else if (ref.startsWith("cine:")) {
      await produce({ ref, kind: "cinematic", name: "intro flyover", format: "camera-path", payload: buildIntroCinematic(world), dimensions: null });
    }
  }
  cache?.flush?.();

  // 4. Dedupe by asset_id, then bind: who in this game uses each record.
  const byId = new Map();
  for (const r of out) if (!byId.has(r.asset_id)) byId.set(r.asset_id, r); else warnings.push(`'${r.ref}' has the same content as '${byId.get(r.asset_id).ref}'; kept one record`);
  const records = [...byId.values()];
  const bindRefs = (r) => {
    if (r.kind === "texture") return Object.values(materialsById).filter((m) => [m.payload.albedo_texture, m.payload.normal_texture, m.payload.roughness_texture].includes(r.asset_id)).map((m) => m.ref);
    if (r.kind === "material") return [...(matUses.get(r.ref) || [])];
    return [...(uses.get(r.ref) || [])];
  };
  for (const r of records) r.game_bindings = [{ game_id, refs: [...new Set(bindRefs(r))].sort() }];

  const byRef = {};
  for (const r of out) byRef[r.ref] = r.asset_id;
  const materials = Object.fromEntries(Object.entries(materialsById).map(([k, r]) => [k, byId.get(r.asset_id)]));

  // 5. Stats and provenance.
  const by_kind = {};
  let cost = 0, bytes = 0, tris = 0, sceneTris = 0;
  for (const r of records) {
    by_kind[r.kind] = (by_kind[r.kind] || 0) + 1;
    cost += r.cost_usd; bytes += r.bytes;
    if (r.format === "mesh-recipe" || r.format === "glb") {
      const t = estimateTriangles(r.payload);
      tris += t;
      sceneTris += t * Math.max(1, instances.get(r.ref) || (r.ref.startsWith("char:") ? 1 : 0));
    }
  }
  const stats = {
    count: records.length, by_kind, cache_hits: hits, cache_misses: misses,
    cost_usd: Math.round(cost * 1e6) / 1e6, bytes, est_triangles: tris, est_scene_triangles: sceneTris,
    warnings: warnings.length,
  };

  const provenance = aggregateStages(laneStages, { hits, localCount: out.filter((r) => r.provenance.lane === "local" && r.source !== "cached").length, at });
  const requiredRefs = [...uses.keys(), ...matUses.keys()].filter((r) => /^(lib|char|mat|icon|ui|sky|cine):/.test(r) || !/^[a-z]+:/.test(r));
  const validation = validateAssetSet(records, { requiredRefs });
  return { records, byRef, materials, stats, provenance, warnings, validation, blobs };
}

/** One §8 stage per (stage, lane, provider, status), with a call count. */
function aggregateStages(stages, { hits, localCount, at }) {
  const groups = new Map();
  for (const s of stages) {
    const k = [s.stage, s.lane, s.provider, s.status].join("|");
    const g = groups.get(k) || { stage: s.stage, lane: s.lane, provider: s.provider, model: s.model, status: s.status, latency_ms: 0, cost_usd: 0, calls: 0, at: s.at };
    g.latency_ms += s.latency_ms; g.cost_usd += s.cost_usd; g.calls++;
    if (s.after_failed?.length) g.after_failed = [...new Set([...(g.after_failed || []), ...s.after_failed])];
    groups.set(k, g);
  }
  const outStages = [...groups.values()].map((g) => ({ ...g, cost_usd: Math.round(g.cost_usd * 1e6) / 1e6 }));
  if (localCount) outStages.push({ stage: "assets", lane: "local", provider: "local:procedural", model: "deterministic", status: "FALLBACK", latency_ms: 0, cost_usd: 0, calls: localCount, at });
  if (hits) outStages.push({ stage: "assets", lane: "cache", provider: "local:cache", model: "content-addressed", status: "CACHED", latency_ms: 0, cost_usd: 0, calls: hits, at });
  return outStages;
}

/** The player's own mesh, dressed in the concept palette. */
function playerCharacter(concept) {
  const p = concept?.palette || {};
  return {
    id: "player", name: "Player", kind: "humanoid",
    body: { height: 1.75, build: "average", palette: { skin: "#d9a882", primary: p.primary || "#3f6fa8", secondary: p.secondary || "#3d3a36", accent: p.accent || "#e0b050" }, accessories: ["backpack", "scarf"] },
  };
}

export { MATERIAL_NAMES };
