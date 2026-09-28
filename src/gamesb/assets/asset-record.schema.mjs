// Games-B AssetRecord validator (CONTRACT §4.1). ISOMORPHIC — every
// *.schema.mjs is, so the runtime can check a package it was handed.
//
// Hand-written like the rest of the v3/gamesb validators: every issue has a
// path, a message and (where the fix is mechanical) a hint.

import { Issues, isObj, isArr, isStr, isNum, isInt, isVec3, requireEnum, requireNum } from "../common/issues.mjs";

export const ASSET_RECORD_VERSION = "1.0.0";
export const ASSET_KINDS = ["character", "npc", "creature", "prop", "structure", "foliage", "texture", "material", "environment", "sky", "ui", "icon", "cinematic"];
export const ASSET_FORMATS = ["mesh-recipe", "texture-recipe", "material", "png", "svg", "glb", "json", "camera-path"];
export const ASSET_SOURCES = ["procedural", "curated", "generated", "cached"];
export const ASSET_STATUSES = ["AVAILABLE", "FALLBACK", "CACHED"];
export const COMMERCIAL_USE = ["internal-testing-only", "cleared", "unknown"];
export const REF_PREFIXES = ["lib:", "char:", "mat:", "tex:", "sky:", "icon:", "ui:", "cine:"];
export const PART_SHAPES = ["box", "cylinder", "cone", "sphere", "capsule", "torus", "lathe", "extrude", "rock", "icosphere"];
const GENERATORS = ["grass", "sand", "rock", "dirt", "snow", "bricks", "planks", "stone_tiles", "roof_tiles", "bark", "leaves", "metal", "plaster", "water", "cloth", "noise"];
const FILE_FORMATS = ["png", "svg", "glb"];

export const REQUIRED_FIELDS = ["asset_id", "ref", "kind", "provider", "model", "prompt_hash", "version", "source", "cost_usd", "latency_ms", "format", "dimensions", "bytes", "sha256", "game_bindings", "provenance"];

const HEX64 = /^[0-9a-f]{64}$/;
const ASSET_ID = /^ast_[0-9a-f]{16}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

function checkMeshRecipe(iss, p, path) {
  if (!isObj(p)) { iss.err(path, "mesh-recipe payload must be an object"); return; }
  if (p.builder !== "parts") iss.err(`${path}.builder`, "must be 'parts'");
  if (!isObj(p.bounds) || !isNum(p.bounds.w) || !isNum(p.bounds.h) || !isNum(p.bounds.d)) iss.err(`${path}.bounds`, "must be {w,h,d} numbers", "compute with computeBounds(parts)");
  if (!isArr(p.parts) || !p.parts.length) { iss.err(`${path}.parts`, "must be a non-empty array"); return; }
  if (p.parts.length > 40) iss.warn(`${path}.parts`, `${p.parts.length} parts exceeds the 40-part budget`);
  p.parts.forEach((part, i) => {
    const pp = `${path}.parts[${i}]`;
    requireEnum(iss, part?.shape, PART_SHAPES, `${pp}.shape`);
    if (!isStr(part?.material_ref) || !part.material_ref.startsWith("mat:")) iss.err(`${pp}.material_ref`, "must be a mat: ref");
    if (!isVec3(part?.position)) iss.err(`${pp}.position`, "must be {x,y,z}");
    if (!isVec3(part?.rotation)) iss.err(`${pp}.rotation`, "must be {x,y,z}");
    if (part?.shape === "lathe" && (!isArr(part.profile) || part.profile.length < 2)) iss.err(`${pp}.profile`, "lathe needs ≥ 2 [r,y] points");
    if (part?.shape === "extrude" && (!isArr(part.outline) || part.outline.length < 3 || !isNum(part.depth))) iss.err(`${pp}`, "extrude needs an outline of ≥ 3 points and a depth");
  });
  if (p.rig !== undefined) {
    if (!isObj(p.rig) || !["biped", "quadruped", "hover"].includes(p.rig.kind) || !isObj(p.rig.joints)) iss.err(`${path}.rig`, "must be { kind: biped|quadruped|hover, joints: {...} }");
    else for (const [name, j] of Object.entries(p.rig.joints)) {
      if (!isVec3(j?.pivot)) iss.err(`${path}.rig.joints.${name}.pivot`, "must be {x,y,z}");
      if (j?.parent !== null && j?.parent !== undefined && !p.rig.joints[j.parent]) iss.err(`${path}.rig.joints.${name}.parent`, `unknown joint '${j.parent}'`);
    }
  }
}

/** Validate one AssetRecord. Returns { ok, errors, warnings }. */
export function validateAssetRecord(rec) {
  const iss = new Issues();
  if (!isObj(rec)) { iss.err("", "record must be an object"); return iss.toJSON(); }
  for (const f of REQUIRED_FIELDS) if (!(f in rec)) iss.err(f, "is required");
  if (rec.asset_record_version !== ASSET_RECORD_VERSION) iss.err("asset_record_version", `must be '${ASSET_RECORD_VERSION}'`);
  if ("asset_id" in rec && !(isStr(rec.asset_id) && ASSET_ID.test(rec.asset_id))) iss.err("asset_id", "must be 'ast_' + 16 hex chars", "ast_ + sha256(canonicalJson({kind,payload})).slice(0,16)");
  if ("ref" in rec) {
    if (!isStr(rec.ref)) iss.err("ref", "must be a non-empty string");
    else if (!REF_PREFIXES.some((p) => rec.ref.startsWith(p))) iss.warn("ref", `'${rec.ref}' has no known prefix (${REF_PREFIXES.join(" ")})`);
  }
  if ("kind" in rec) requireEnum(iss, rec.kind, ASSET_KINDS, "kind");
  if (!isStr(rec.name)) iss.err("name", "is required");
  if ("provider" in rec && !isStr(rec.provider)) iss.err("provider", "must be a non-empty string");
  if ("model" in rec && !isStr(rec.model)) iss.err("model", "must be a non-empty string");
  if (rec.prompt !== null && rec.prompt !== undefined && typeof rec.prompt !== "string") iss.err("prompt", "must be a string or null");
  if ("prompt_hash" in rec && !(typeof rec.prompt_hash === "string" && HEX64.test(rec.prompt_hash))) iss.err("prompt_hash", "must be 64 lowercase hex chars");
  if ("version" in rec) requireNum(iss, rec.version, "version", { min: 1, integer: true });
  if ("source" in rec) requireEnum(iss, rec.source, ASSET_SOURCES, "source");
  if ("cost_usd" in rec) requireNum(iss, rec.cost_usd, "cost_usd", { min: 0 });
  if ("latency_ms" in rec) requireNum(iss, rec.latency_ms, "latency_ms", { min: 0 });
  if ("format" in rec) requireEnum(iss, rec.format, ASSET_FORMATS, "format");
  if ("dimensions" in rec && rec.dimensions !== null) {
    const d = rec.dimensions;
    const mesh = isObj(d) && isNum(d.w) && isNum(d.h) && isNum(d.d);
    const img = isObj(d) && isInt(d.px_w) && isInt(d.px_h) && d.px_w > 0 && d.px_h > 0;
    if (!mesh && !img) iss.err("dimensions", "must be {w,h,d} (metres), {px_w,px_h} (pixels) or null");
  }
  if ("bytes" in rec) requireNum(iss, rec.bytes, "bytes", { min: 0, integer: true });
  if ("sha256" in rec && !(typeof rec.sha256 === "string" && HEX64.test(rec.sha256))) iss.err("sha256", "must be 64 lowercase hex chars");
  if ("game_bindings" in rec) {
    if (!isArr(rec.game_bindings)) iss.err("game_bindings", "must be an array");
    else rec.game_bindings.forEach((b, i) => {
      if (!isStr(b?.game_id)) iss.err(`game_bindings[${i}].game_id`, "is required");
      if (!isArr(b?.refs) || b.refs.some((r) => !isStr(r))) iss.err(`game_bindings[${i}].refs`, "must be an array of strings");
    });
  }
  const pv = rec.provenance;
  if ("provenance" in rec) {
    if (!isObj(pv)) iss.err("provenance", "must be an object");
    else {
      if (!(typeof pv.generated_at === "string" && ISO.test(pv.generated_at))) iss.err("provenance.generated_at", "must be an ISO-8601 UTC timestamp");
      if (!isStr(pv.lane)) iss.err("provenance.lane", "is required");
      if (!isStr(pv.adapter)) iss.err("provenance.adapter", "is required");
      requireEnum(iss, pv.status, ASSET_STATUSES, "provenance.status");
      if (!isArr(pv.after_failed)) iss.err("provenance.after_failed", "must be an array");
      if (!isObj(pv.license)) iss.err("provenance.license", "is required", "{ spdx, commercial_use }");
      else {
        if (!isStr(pv.license.spdx)) iss.err("provenance.license.spdx", "is required");
        requireEnum(iss, pv.license.commercial_use, COMMERCIAL_USE, "provenance.license.commercial_use");
      }
    }
  }
  // Cross-field rules.
  if (rec.source === "cached" && pv?.status && pv.status !== "CACHED") iss.err("provenance.status", "a cached record must say CACHED");
  if (pv?.status === "CACHED" && isNum(rec.cost_usd) && rec.cost_usd !== 0) iss.err("cost_usd", "a cache hit costs 0");
  if (rec.payload !== null && rec.payload !== undefined && !isObj(rec.payload)) iss.err("payload", "must be an object or null");
  if (rec.uri !== null && rec.uri !== undefined && typeof rec.uri !== "string") iss.err("uri", "must be a string or null");
  if (FILE_FORMATS.includes(rec.format) && !rec.uri && !isObj(rec.payload)) iss.err("uri", `a ${rec.format} record needs a uri or an inline payload`);
  if (rec.format === "mesh-recipe") checkMeshRecipe(iss, rec.payload, "payload");
  if (rec.format === "texture-recipe") {
    if (!isObj(rec.payload)) iss.err("payload", "texture-recipe needs a payload");
    else {
      requireEnum(iss, rec.payload.generator, GENERATORS, "payload.generator");
      if (![64, 128, 256, 512].includes(rec.payload.size)) iss.err("payload.size", "must be 64|128|256|512");
    }
  }
  if (rec.format === "material" && !isStr(rec.payload?.material_id)) iss.err("payload.material_id", "is required for a material");
  return iss.toJSON();
}

/**
 * Validate a whole set: every record, duplicate ids and refs, texture/material
 * cross-references, and (optionally) that every required logical ref resolves.
 * A ref resolves when a record has `ref === r` or `asset_id === r` (§4.1a).
 */
export function validateAssetSet(records, { requiredRefs = [] } = {}) {
  const iss = new Issues();
  if (!isArr(records)) { iss.err("records", "must be an array"); return { ...iss.toJSON(), missing: [...requiredRefs] }; }
  const byId = new Map(), byRef = new Map();
  records.forEach((r, i) => {
    iss.merge(validateAssetRecord(r), `records[${i}]`);
    if (isStr(r?.asset_id)) {
      if (byId.has(r.asset_id)) iss.err(`records[${i}].asset_id`, `duplicate asset_id '${r.asset_id}' (also records[${byId.get(r.asset_id)}])`, "dedupe by asset_id");
      else byId.set(r.asset_id, i);
    }
    if (isStr(r?.ref)) {
      if (byRef.has(r.ref)) iss.err(`records[${i}].ref`, `ref '${r.ref}' is satisfied twice (also records[${byRef.get(r.ref)}])`, "one record per logical ref");
      else byRef.set(r.ref, i);
    }
  });
  const recOf = (key) => (byId.has(key) ? records[byId.get(key)] : byRef.has(key) ? records[byRef.get(key)] : null);
  records.forEach((r, i) => {
    if (r?.format === "material" && isObj(r.payload)) {
      for (const k of ["albedo_texture", "normal_texture", "roughness_texture"]) {
        const t = r.payload[k];
        if (t === undefined || t === null) continue;
        const target = recOf(t);
        if (!target) iss.err(`records[${i}].payload.${k}`, `texture '${t}' does not resolve to any record`);
        else if (target.kind !== "texture") iss.err(`records[${i}].payload.${k}`, `'${t}' resolves to a ${target.kind}, not a texture`);
      }
    }
    if (r?.format === "mesh-recipe" && isArr(r.payload?.parts)) {
      const seen = new Set();
      r.payload.parts.forEach((p, j) => {
        const m = p?.material_ref;
        if (!isStr(m) || seen.has(m)) return;
        seen.add(m);
        const target = recOf(m);
        if (!target) iss.err(`records[${i}].payload.parts[${j}].material_ref`, `material '${m}' does not resolve to any record`);
        else if (target.kind !== "material") iss.err(`records[${i}].payload.parts[${j}].material_ref`, `'${m}' resolves to a ${target.kind}, not a material`);
      });
    }
  });
  const missing = [];
  for (const ref of requiredRefs) if (!recOf(ref)) { missing.push(ref); iss.err(`refs.${ref}`, `no asset record satisfies '${ref}'`); }
  return { ...iss.toJSON(), missing };
}
