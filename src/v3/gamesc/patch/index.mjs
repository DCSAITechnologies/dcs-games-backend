// GAMES-C — typed, invertible, replayable edit patches for WorldManifestV3.
//
// Contract: docs/games-c/CONTRACT.md ("Patch contract"). Spec + guarantees:
// docs/games-c/DCS_GAMES_EDIT_PATCH_SCHEMA.md.
//
// A patch is DATA: a list of typed ops against a manifest pinned by
// (base_version, base_hash). Applying one is pure (deep copy in, new manifest
// out), deterministic (no clock, no randomness), always yields its exact
// inverse, bumps world_version by one, and is refused unless the result still
// passes validateManifest (src/v3/manifest/schema.mjs).
import crypto from "node:crypto";
import { validateManifest } from "../../manifest/schema.mjs";
import { specRefsOf } from "../../expansion/delta.mjs";
import {
  SET_PATH_SPECS, SET_PATH_WHITELIST, UPDATE_FIELDS, FORBIDDEN_FIELDS, MOVE_TARGETS, FIELD_ENUMS,
  ASSET_URI_ALLOWLIST, LIMITS, COLLECTIONS, QUEST_STEP_KINDS,
} from "./whitelist.mjs";
import { checkData, looksLikeCode, looksLikeUrl, isPlainObject, POLLUTION_KEYS, ID_RE } from "./safety.mjs";

export const PATCH_VERSION = "1";
export const OP_KINDS = Object.freeze(["set", "unset", "add", "remove", "update", "move", "replace_asset"]);
export const EDIT_CATEGORIES = Object.freeze(["scene", "asset_replace", "gameplay_rule", "npc", "lighting_weather", "ui", "objective", "expand_area"]);
export const AUTHOR_KINDS = Object.freeze(["user", "companion", "system"]);
export { SET_PATH_WHITELIST, SET_PATH_SPECS, UPDATE_FIELDS, MOVE_TARGETS, ASSET_URI_ALLOWLIST, LIMITS, COLLECTIONS };

/** Fields excluded from the CONTENT hash: they change on every apply, including an undo. */
export const VOLATILE_PATHS = Object.freeze(["world_version", "meta.updated_at", "provenance.manifest_hash"]);

const OP_KEYS = {
  set: ["op", "path", "value"],
  unset: ["op", "path", "prune"],
  add: ["op", "collection", "value", "index"],
  remove: ["op", "collection", "id"],
  update: ["op", "collection", "id", "set", "unset"],
  move: ["op", "collection", "id", "position"],
  replace_asset: ["op", "asset_id", "value"],
};
const PATCH_KEYS = new Set(["patch_version", "patch_id", "world_id", "base_version", "base_hash", "author", "intent", "created_at", "ops", "inverse_of"]);

const clone = (v) => (v === undefined ? undefined : structuredClone(v));
const hasOwn = (o, k) => o !== null && typeof o === "object" && Object.prototype.hasOwnProperty.call(o, k);
const isFiniteNum = (v) => typeof v === "number" && Number.isFinite(v);

// ------------------------------------------------------------------ hashing

/** Stable JSON: sorted keys, undefined object members dropped, cycles rejected. */
export function canonicalJSON(value) {
  const seen = new Set();
  const enc = (v) => {
    if (v === undefined) return "null";
    if (v === null || typeof v !== "object") {
      if (typeof v === "number" && !Number.isFinite(v)) return "null";
      if (typeof v === "bigint" || typeof v === "function" || typeof v === "symbol") throw new TypeError(`canonicalJSON: unsupported ${typeof v}`);
      return JSON.stringify(v);
    }
    if (seen.has(v)) throw new TypeError("canonicalJSON: cycle");
    seen.add(v);
    let s;
    // Fast path for numeric arrays (terrain heightmaps): JSON.stringify gives the identical encoding.
    if (Array.isArray(v) && v.every((x) => typeof x === "number")) s = JSON.stringify(v);
    else if (Array.isArray(v)) s = "[" + Array.from(v, enc).join(",") + "]";
    else s = "{" + Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => JSON.stringify(k) + ":" + enc(v[k])).join(",") + "}";
    seen.delete(v);
    return s;
  };
  return enc(value);
}

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");

/**
 * Content hash of a manifest: sha256 over canonicalJSON with VOLATILE_PATHS
 * removed. Undo therefore restores the hash exactly while world_version keeps
 * climbing. NOTE: differs from core/worldstore.mjs manifestHash (which hashes
 * everything and has no prefix) — see the schema doc.
 */
export function hashManifest(manifest) {
  if (!isPlainObject(manifest)) return "sha256:" + sha(canonicalJSON(manifest ?? null));
  const m = { ...manifest };
  delete m.world_version;
  if (isPlainObject(m.meta)) { m.meta = { ...m.meta }; delete m.meta.updated_at; }
  if (isPlainObject(m.provenance)) { m.provenance = { ...m.provenance }; delete m.provenance.manifest_hash; }
  return "sha256:" + sha(canonicalJSON(m));
}

// ----------------------------------------------------------------- helpers

function getPath(obj, segs) {
  let cur = obj;
  for (const s of segs) { if (!hasOwn(cur, s)) return undefined; cur = cur[s]; }
  return cur;
}

function collectionOf(m, c) {
  if (c === "player_spawns") return m?.spawn?.player_spawns;
  return m?.[c];
}

function isVec3(v) {
  return isPlainObject(v) && Object.keys(v).length === 3 &&
    ["x", "y", "z"].every((k) => isFiniteNum(v[k]) && Math.abs(v[k]) <= LIMITS.MAX_COORD);
}

function uriAllowed(u) {
  return typeof u === "string" && !u.includes("..") && ASSET_URI_ALLOWLIST.some((re) => re.test(u));
}

function checkSetValue(path, value, e) {
  const spec = SET_PATH_SPECS[path];
  if (value === null) { if (!spec.nullable) e(`'${path}' may not be null`); return; }
  switch (spec.type) {
    case "enum": if (!spec.values.includes(value)) e(`'${value}' is not permitted for ${path} (one of: ${spec.values.join(", ")})`); return;
    case "number":
    case "int":
      if (!isFiniteNum(value)) return e(`${path} must be a finite number`);
      if (spec.type === "int" && !Number.isInteger(value)) return e(`${path} must be an integer`);
      if ((spec.min !== undefined && value < spec.min) || (spec.max !== undefined && value > spec.max)) e(`${path} must be within [${spec.min}, ${spec.max}]`);
      return;
    case "boolean": if (typeof value !== "boolean") e(`${path} must be a boolean`); return;
    case "string":
      if (typeof value !== "string") return e(`${path} must be a string`);
      if (value.length < (spec.min ?? 0) || value.length > spec.max) e(`${path} length must be within [${spec.min ?? 0}, ${spec.max}]`);
      return;
    case "tags":
      if (!Array.isArray(value) || value.length > 32 || !value.every((t) => typeof t === "string" && t.length >= 1 && t.length <= 40)) e(`${path} must be an array of <=32 strings (1..40 chars)`);
      return;
    case "palette":
      if (!isPlainObject(value) || Object.keys(value).length > 16 || !Object.values(value).every((c) => typeof c === "string" && /^#[0-9a-fA-F]{6}$/.test(c))) e(`${path} must be an object of <=16 '#rrggbb' colours`);
      return;
    case "data":
      if (!isPlainObject(value)) return e(`${path} must be null or a plain object`);
      if (canonicalJSON(value).length > 4096) e(`${path} is larger than 4096 bytes`);
      return;
  }
}

const STRING_FIELDS = { name: 200, title: 200, purpose: 200, ambience: 200, role: 120, faction: 120, difficulty: 32, description: 2000 };
const REF_FIELDS = new Set(["asset_ref", "zone", "behavior_ref", "target_ref", "giver_npc", "parent_zone"]);

/** Typed checks for known entity fields; unknown fields fall through to checkData only. */
function checkEntityField(collection, field, value, e) {
  const enums = FIELD_ENUMS[collection]?.[field];
  if (enums) { if (!enums.includes(value)) e(`'${value}' is not a permitted ${collection}.${field} (one of: ${enums.join(", ")})`); return; }
  if (STRING_FIELDS[field] && value !== null) {
    if (typeof value !== "string" || value.length > STRING_FIELDS[field]) e(`${field} must be a string of <= ${STRING_FIELDS[field]} chars`);
    return;
  }
  if (REF_FIELDS.has(field)) { if (value !== null && !(typeof value === "string" && ID_RE.test(value))) e(`${field} must be null or an id`); return; }
  switch (field) {
    case "bounds":
      if (!Array.isArray(value) || value.length !== 4 || !value.every((n) => isFiniteNum(n) && Math.abs(n) <= LIMITS.MAX_COORD) || value[2] <= value[0] || value[3] <= value[1]) e("bounds must be [minX,minZ,maxX,maxZ] with max > min");
      return;
    case "spawn": if (collection === "npcs" && !isVec3(value)) e("spawn must be {x,y,z} with finite, bounded numbers"); return;
    case "transform":
      if (!isPlainObject(value) || !isVec3(value.position)) e("transform.position must be {x,y,z}");
      else for (const k of ["rotation", "scale"]) if (value[k] !== undefined && !isVec3(value[k])) e(`transform.${k} must be {x,y,z}`);
      return;
    case "footprint":
      if (!isPlainObject(value) || !["w", "d", "h"].every((k) => isFiniteNum(value[k]) && value[k] > 0 && value[k] <= 10000)) e("footprint must be {w,d,h} positive numbers <= 10000");
      return;
    case "density": if (!isFiniteNum(value) || value < 0 || value > 1) e("density must be a number in [0,1]"); return;
    case "interactable": case "enterable": case "stackable":
      if (typeof value !== "boolean") e(`${field} must be a boolean`); return;
    case "steps":
      if (!Array.isArray(value) || value.length === 0 || value.length > 64) return e("steps must be a non-empty array (<=64)");
      value.forEach((s, j) => {
        if (!isPlainObject(s) || typeof s.id !== "string" || !ID_RE.test(s.id)) e(`steps[${j}].id is required`);
        else if (!QUEST_STEP_KINDS.includes(s.kind)) e(`steps[${j}].kind '${s.kind}' is not permitted (one of: ${QUEST_STEP_KINDS.join(", ")})`);
      });
      return;
  }
}

// ------------------------------------------------------------ op execution

/**
 * Apply ops to `work` IN PLACE (caller passes a clone). Returns {errors, inverse}.
 * Stops at the first op that fails, because later ops may depend on it.
 */
function runOps(work, ops, { trusted = false } = {}) {
  const errors = [];
  const inverse = [];
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    const errs = [];
    const e = (message, path = null) => errs.push({ op_index: i, path, message });
    const inv = execOp(work, op, e, trusted);
    if (errs.length) { errors.push(...errs); break; }
    inverse.unshift(...inv);
  }
  return { errors, inverse };
}

function execOp(work, op, e, trusted) {
  switch (op.op) {
    case "set": {
      const segs = op.path.split(".");
      const prev = getPath(work, segs);
      let cur = work, created = 0;
      for (const s of segs.slice(0, -1)) {
        if (!hasOwn(cur, s)) { cur[s] = {}; created++; }
        else if (!isPlainObject(cur[s])) { e(`cannot set below non-object at '${s}'`, op.path); return []; }
        cur = cur[s];
      }
      cur[segs.at(-1)] = clone(op.value);
      return prev === undefined ? [{ op: "unset", path: op.path, prune: created }] : [{ op: "set", path: op.path, value: clone(prev) }];
    }
    case "unset": {
      const segs = op.path.split(".");
      const parents = [work];
      let cur = work;
      for (const s of segs.slice(0, -1)) { if (!isPlainObject(cur?.[s])) { e("path does not exist", op.path); return []; } cur = cur[s]; parents.push(cur); }
      const leaf = segs.at(-1);
      if (!hasOwn(cur, leaf)) { e("nothing to unset", op.path); return []; }
      const prev = cur[leaf];
      delete cur[leaf];
      const prune = op.prune || 0;
      for (let k = 0; k < prune; k++) {
        const idx = segs.length - 1 - k; // key of the ancestor being pruned
        const parent = parents[idx - 1], key = segs[idx - 1];
        if (!parent || !isPlainObject(parent[key]) || Object.keys(parent[key]).length) break;
        delete parent[key];
      }
      return [{ op: "set", path: op.path, value: clone(prev) }];
    }
    case "add": {
      const arr = collectionOf(work, op.collection);
      if (!Array.isArray(arr)) { e(`collection '${op.collection}' is absent from this manifest`); return []; }
      if (arr.length >= LIMITS.MAX_COLLECTION) { e(`collection '${op.collection}' is full (${LIMITS.MAX_COLLECTION})`); return []; }
      if (arr.some((x) => x?.id === op.value.id)) { e(`id '${op.value.id}' already exists in ${op.collection}`, `${op.collection}.${op.value.id}`); return []; }
      if (op.index !== undefined && op.index > arr.length) { e(`index ${op.index} is past the end of ${op.collection}`); return []; }
      if (op.index === undefined) arr.push(clone(op.value)); else arr.splice(op.index, 0, clone(op.value));
      return [{ op: "remove", collection: op.collection, id: op.value.id }];
    }
    case "remove": {
      const arr = collectionOf(work, op.collection);
      const idx = Array.isArray(arr) ? arr.findIndex((x) => x?.id === op.id) : -1;
      if (idx < 0) { e(`no ${op.collection} entry with id '${op.id}'`, `${op.collection}.${op.id}`); return []; }
      if (!trusted && arr[idx].owner_id !== undefined && arr[idx].owner_id !== null) { e(`'${op.id}' is owned by a player and cannot be removed by an edit`, `${op.collection}.${op.id}`); return []; }
      const [gone] = arr.splice(idx, 1);
      return [{ op: "add", collection: op.collection, value: gone, index: idx }];
    }
    case "update": {
      const arr = collectionOf(work, op.collection);
      const ent = Array.isArray(arr) ? arr.find((x) => x?.id === op.id) : undefined;
      if (!ent) { e(`no ${op.collection} entry with id '${op.id}'`, `${op.collection}.${op.id}`); return []; }
      const invSet = {}, invUnset = [];
      for (const f of op.unset || []) {
        if (!hasOwn(ent, f)) { e(`field '${f}' is not present to unset`, `${op.collection}.${op.id}.${f}`); return []; }
      }
      for (const [f, v] of Object.entries(op.set || {})) {
        if (hasOwn(ent, f)) invSet[f] = clone(ent[f]); else invUnset.push(f);
        ent[f] = clone(v);
      }
      for (const f of op.unset || []) { invSet[f] = clone(ent[f]); delete ent[f]; }
      const inv = { op: "update", collection: op.collection, id: op.id };
      if (Object.keys(invSet).length) inv.set = invSet;
      if (invUnset.length) inv.unset = invUnset;
      return [inv];
    }
    case "move": {
      const arr = collectionOf(work, op.collection);
      const ent = Array.isArray(arr) ? arr.find((x) => x?.id === op.id) : undefined;
      if (!ent) { e(`no ${op.collection} entry with id '${op.id}'`, `${op.collection}.${op.id}`); return []; }
      const segs = MOVE_TARGETS[op.collection];
      const holder = segs.length === 1 ? ent : ent[segs[0]];
      if (!isPlainObject(holder) || !isPlainObject(holder[segs.at(-1)])) { e(`'${op.id}' has no position to move`, `${op.collection}.${op.id}`); return []; }
      const prev = clone(holder[segs.at(-1)]);
      holder[segs.at(-1)] = clone(op.position);
      return [{ op: "move", collection: op.collection, id: op.id, position: prev }];
    }
    case "replace_asset": {
      const arr = work.assets;
      const idx = Array.isArray(arr) ? arr.findIndex((x) => x?.id === op.asset_id) : -1;
      if (idx < 0) { e(`no asset with id '${op.asset_id}'`, `assets.${op.asset_id}`); return []; }
      const prev = arr[idx];
      arr[idx] = { ...clone(op.value), id: op.asset_id };
      return [{ op: "replace_asset", asset_id: op.asset_id, value: prev }];
    }
  }
  e(`unknown op '${op?.op}'`);
  return [];
}

// ------------------------------------------------------ static op checking

function checkOpShape(op, i, errors, trusted) {
  const e = (message, path = null) => errors.push({ op_index: i, path, message });
  if (!isPlainObject(op)) return e("op must be a plain object");
  if (!OP_KINDS.includes(op.op)) return e(`unknown op '${op.op}' (one of: ${OP_KINDS.join(", ")})`);
  for (const k of Reflect.ownKeys(op)) {
    if (typeof k !== "string" || !OP_KEYS[op.op].includes(k)) e(`unexpected key '${String(k)}' on ${op.op} op`);
  }
  try {
    if (canonicalJSON(op).length > LIMITS.MAX_VALUE_BYTES) e(`op is larger than ${LIMITS.MAX_VALUE_BYTES} bytes`);
  } catch (err) { return e(`op is not serialisable data: ${err.message}`); }
  const data = (v, path, opts = {}) => {
    const out = [];
    checkData(v, path, out, { trusted, ...opts });
    for (const x of out) e(x.message, x.path);
  };

  const isColl = (c, list) => typeof c === "string" && list.includes(c);
  const entityChecks = (collection, fields, pathBase, { isAdd }) => {
    for (const [f, v] of Object.entries(fields)) {
      if (POLLUTION_KEYS.has(f)) continue; // reported by data()
      if (f === "id" && isAdd) continue;
      if (f === "uri" && isAdd && collection === "assets") { if (!trusted && !uriAllowed(v)) e("asset uri is not on the asset allowlist", `${pathBase}.uri`); continue; }
      if (!trusted) {
        if (FORBIDDEN_FIELDS.has(f)) {
          if (!(isAdd && (f === "owner_id" || f === "script") && v === null)) e(`field '${f}' may not be written by an edit`, `${pathBase}.${f}`);
          continue;
        }
        if (!isAdd && !UPDATE_FIELDS[collection].has(f)) { e(`field '${f}' is not editable on ${collection} (editable: ${[...UPDATE_FIELDS[collection]].join(", ")})`, `${pathBase}.${f}`); continue; }
      } else if (f === "id") { e("id may not be changed", `${pathBase}.id`); continue; }
      checkEntityField(collection, f, v, (m) => e(m, `${pathBase}.${f}`));
    }
  };

  switch (op.op) {
    case "set":
    case "unset":
      if (typeof op.path !== "string" || !SET_PATH_WHITELIST.includes(op.path)) return e(`path '${op.path}' is not settable (see SET_PATH_WHITELIST)`, typeof op.path === "string" ? op.path : null);
      if (op.op === "set") {
        if (!hasOwn(op, "value")) return e("set needs a value", op.path);
        data(op.value, op.path);
        checkSetValue(op.path, op.value, (m) => e(m, op.path));
      } else if (op.prune !== undefined && (!Number.isInteger(op.prune) || op.prune < 0 || op.prune >= op.path.split(".").length)) {
        e("prune must be an integer below the path depth", op.path);
      }
      return;
    case "add": {
      if (!isColl(op.collection, COLLECTIONS)) return e(`collection '${op.collection}' is not a manifest collection (one of: ${COLLECTIONS.join(", ")})`);
      if (!isPlainObject(op.value)) return e("add needs a plain-object value", op.collection);
      if (typeof op.value.id !== "string" || !ID_RE.test(op.value.id)) return e("value.id must match " + ID_RE, `${op.collection}.id`);
      if (op.index !== undefined && (!Number.isInteger(op.index) || op.index < 0)) e("index must be a non-negative integer");
      const base = `${op.collection}.${op.value.id}`;
      data(op.value, base, { allowUrlAt: op.collection === "assets" ? new Set(["uri"]) : new Set() });
      entityChecks(op.collection, op.value, base, { isAdd: true });
      return;
    }
    case "remove":
      if (!isColl(op.collection, COLLECTIONS)) return e(`collection '${op.collection}' is not a manifest collection`);
      if (typeof op.id !== "string" || !ID_RE.test(op.id)) e("id must be a valid id");
      return;
    case "update": {
      if (!isColl(op.collection, COLLECTIONS)) return e(`collection '${op.collection}' is not a manifest collection`);
      if (typeof op.id !== "string" || !ID_RE.test(op.id)) return e("id must be a valid id");
      const base = `${op.collection}.${op.id}`;
      if (op.set !== undefined && !isPlainObject(op.set)) return e("set must be a plain object", base);
      if (op.unset !== undefined && (!Array.isArray(op.unset) || !op.unset.every((f) => typeof f === "string"))) return e("unset must be an array of field names", base);
      const setKeys = Object.keys(op.set || {});
      if (!setKeys.length && !(op.unset || []).length) return e("update changes nothing", base);
      if ((op.unset || []).some((f) => setKeys.includes(f))) e("a field cannot be both set and unset", base);
      if (op.set) { data(op.set, base); entityChecks(op.collection, op.set, base, { isAdd: false }); }
      for (const f of op.unset || []) {
        if (POLLUTION_KEYS.has(f)) e(`forbidden key '${f}' (prototype pollution)`, `${base}.${f}`);
        else if (f === "id" || (!trusted && (FORBIDDEN_FIELDS.has(f) || !UPDATE_FIELDS[op.collection].has(f)))) e(`field '${f}' may not be unset by an edit`, `${base}.${f}`);
      }
      return;
    }
    case "move":
      if (!isColl(op.collection, Object.keys(MOVE_TARGETS))) return e(`collection '${op.collection}' is not movable (one of: ${Object.keys(MOVE_TARGETS).join(", ")})`);
      if (typeof op.id !== "string" || !ID_RE.test(op.id)) e("id must be a valid id");
      if (!isVec3(op.position)) e(`position must be exactly {x,y,z} with finite numbers within ±${LIMITS.MAX_COORD}`, `${op.collection}.${op.id}.position`);
      return;
    case "replace_asset": {
      if (typeof op.asset_id !== "string" || !ID_RE.test(op.asset_id)) return e("asset_id must be a valid id");
      if (!isPlainObject(op.value)) return e("replace_asset needs a plain-object value", `assets.${op.asset_id}`);
      const base = `assets.${op.asset_id}`;
      if (op.value.id !== undefined && op.value.id !== op.asset_id) e("value.id must equal asset_id", `${base}.id`);
      data(op.value, base, { allowUrlAt: new Set(["uri"]) });
      if (op.value.uri !== undefined && op.value.uri !== null && !trusted && !uriAllowed(op.value.uri)) e("asset uri is not on the asset allowlist", `${base}.uri`);
      for (const f of ["owner_id", "script"]) if (!trusted && op.value[f] !== undefined && op.value[f] !== null) e(`${f} may not be written by an edit`, `${base}.${f}`);
      for (const f of ["kind", "format"]) checkEntityField("assets", f, op.value[f], (m) => e(m, `${base}.${f}`));
      return;
    }
  }
}

function checkPatchShape(patch, errors, { trusted = false } = {}) {
  const e = (message, path = null) => errors.push({ op_index: null, path, message });
  if (!isPlainObject(patch)) { e("patch must be a plain object"); return false; }
  for (const k of Reflect.ownKeys(patch)) {
    if (typeof k !== "string" || POLLUTION_KEYS.has(k)) e(`forbidden key '${String(k)}'`);
    else if (!PATCH_KEYS.has(k) && !k.startsWith("x_")) e(`unexpected patch key '${k}' (extensions must be prefixed x_)`);
  }
  try { if (canonicalJSON(patch).length > LIMITS.MAX_PATCH_BYTES) e(`patch is larger than ${LIMITS.MAX_PATCH_BYTES} bytes`); }
  catch (err) { e(`patch is not serialisable data: ${err.message}`); return false; }
  if (patch.patch_version !== PATCH_VERSION) e(`patch_version must be "${PATCH_VERSION}"`, "patch_version");
  if (typeof patch.patch_id !== "string" || !/^p_[0-9a-f]{8,64}$/.test(patch.patch_id)) e("patch_id must be p_<hex>", "patch_id");
  if (typeof patch.world_id !== "string" || !patch.world_id) e("world_id is required", "world_id");
  if (!Number.isInteger(patch.base_version) || patch.base_version < 1) e("base_version must be an integer >= 1", "base_version");
  if (typeof patch.base_hash !== "string" || !/^sha256:[0-9a-f]{64}$/.test(patch.base_hash)) e("base_hash must be sha256:<64 hex>", "base_hash");
  if (!isPlainObject(patch.author) || !AUTHOR_KINDS.includes(patch.author.kind) || typeof patch.author.id !== "string" || !patch.author.id || patch.author.id.length > 128) {
    e(`author must be {kind: ${AUTHOR_KINDS.join("|")}, id}`, "author");
  }
  if (patch.intent !== undefined) {
    const extra = [];
    checkData(patch.intent, "intent", extra, { trusted: true });
    extra.forEach((x) => e(x.message, x.path));
    if (!isPlainObject(patch.intent)) e("intent must be an object", "intent");
    else {
      if (patch.intent.text !== undefined && (typeof patch.intent.text !== "string" || patch.intent.text.length > 2000)) e("intent.text must be a string <= 2000", "intent.text");
      if (patch.intent.category !== undefined && !EDIT_CATEGORIES.includes(patch.intent.category)) e(`intent.category must be one of: ${EDIT_CATEGORIES.join(", ")}`, "intent.category");
    }
  }
  if (typeof patch.created_at !== "string" || Number.isNaN(Date.parse(patch.created_at))) e("created_at must be an ISO timestamp", "created_at");
  if (!Array.isArray(patch.ops) || patch.ops.length === 0) { e("ops must be a non-empty array", "ops"); return false; }
  if (patch.ops.length > LIMITS.MAX_OPS_PER_PATCH) { e(`at most ${LIMITS.MAX_OPS_PER_PATCH} ops per patch`, "ops"); return false; }
  const before = errors.length;
  for (let i = 0; i < patch.ops.length; i++) checkOpShape(patch.ops[i], i, errors, trusted); // for-loop: holes are checked too
  return errors.length === before;
}

// --------------------------------------------------------- dangling refs

/** References validateManifest does NOT check (behaviour spec refs, multiplayer/navigation zone lists). */
function danglingRefs(m) {
  const ids = {};
  for (const c of COLLECTIONS) ids[c] = new Set((m[c] || []).map((x) => x?.id).filter(Boolean));
  const out = new Set();
  for (const b of m.behaviors || []) {
    for (const { field, id, rule } of specRefsOf(b)) {
      if (!rule.points_at.some((c) => ids[c].has(id))) out.add(`behaviors.${b.id}.spec.${field}->${id}`);
    }
  }
  for (const z of m.multiplayer?.shared_zones || []) if (typeof z === "string" && !ids.zones.has(z)) out.add(`multiplayer.shared_zones->${z}`);
  for (const w of m.navigation?.walkable_zones || []) if (typeof w?.zone === "string" && !ids.zones.has(w.zone)) out.add(`navigation.walkable_zones->${w.zone}`);
  return out;
}

// ------------------------------------------------------------- public API

/**
 * Validate a patch against (optionally) the manifest it targets. Pure; never throws.
 * With a manifest it also checks world_id, staleness (base_version + base_hash)
 * and simulates the ops in order (ids must exist / not collide).
 * @returns {{ok:boolean, errors:Array<{op_index:number|null, path:string|null, message:string}>}}
 */
export function validatePatch(patch, manifest, options = {}) {
  if (manifest === undefined || manifest === null) {
    const r = prepare(patch, manifest, options, { simulate: false });
    return { ok: r.errors.length === 0, errors: r.errors };
  }
  // With a manifest, validation IS a dry-run apply, so validatePatch().ok === applyPatch().ok always.
  const r = applyPatch(manifest, patch, options);
  return { ok: r.ok, errors: r.errors };
}

/** Shape + world + staleness checks, then (optionally) run the ops on a clone. Never throws. */
function prepare(patch, manifest, options, { simulate }) {
  const errors = [];
  try {
    // Snapshot first: getters run exactly once, Proxies/functions/class instances
    // are refused, and nothing the caller does afterwards can change what was checked.
    try { patch = structuredClone(patch); }
    catch (err) { errors.push({ op_index: null, path: null, message: `patch is not plain cloneable data: ${err?.message || err}` }); return { errors }; }
    const shapeOk = checkPatchShape(patch, errors, options);
    if (manifest === undefined || manifest === null) return { errors };
    if (!isPlainObject(manifest)) { errors.push({ op_index: null, path: "$", message: "manifest must be an object" }); return { errors }; }
    if (!shapeOk) return { errors };
    if (patch.world_id !== manifest.world_id) errors.push({ op_index: null, path: "world_id", message: `patch targets '${patch.world_id}' but manifest is '${manifest.world_id}'` });
    const stale = staleCheck(patch, manifest, options[KNOWN_BASE_HASH]);
    if (stale) errors.push(stale);
    if (errors.length || !simulate) return { errors };
    const work = structuredClone(manifest);
    const run = runOps(work, patch.ops, options);
    errors.push(...run.errors);
    return { errors, work, inverse: run.inverse, patch };
  } catch (err) {
    errors.push({ op_index: null, path: null, message: `patch could not be validated: ${err?.message || err}` });
    return { errors };
  }
}

/** Internal (history.mjs only): the caller owns the manifest and already knows its hash. */
export const KNOWN_BASE_HASH = Symbol("gamesc.patch.knownBaseHash");

function staleCheck(patch, manifest, knownHash) {
  const actual = typeof knownHash === "string" ? knownHash : hashManifest(manifest);
  if (patch.base_version !== manifest.world_version || patch.base_hash !== actual) {
    return {
      op_index: null, path: "base_hash", code: "stale_base",
      message: `stale edit: patch was made against v${patch.base_version} (${String(patch.base_hash).slice(0, 19)}…) but the world is at v${manifest.world_version} (${actual.slice(0, 19)}…)`,
    };
  }
  return null;
}

/**
 * Apply a patch. Pure: the input manifest is never mutated.
 * options.trusted — ONLY for server-held inverses/redos (undo history, rollback):
 *   skips content heuristics, the field whitelist and the asset-uri allowlist.
 *   NEVER pass it for a client- or companion-supplied patch.
 * @returns {{ok, manifest|null, inverse|null, errors, warnings}}
 */
export function applyPatch(manifest, patch, options = {}) {
  const fail = (errors) => ({ ok: false, manifest: null, inverse: null, errors, warnings: [] });
  try {
    const prep = prepare(patch, manifest, options, { simulate: true });
    if (prep.errors.length || !prep.work) return fail(prep.errors.length ? prep.errors : [{ op_index: null, path: "$", message: "a manifest is required" }]);
    const before = manifest;
    const { work, inverse } = prep;
    patch = prep.patch;
    work.world_version = before.world_version + 1;

    const vm = validateManifest(work);
    if (!vm.ok) return fail(vm.errors.map((x) => ({ op_index: null, path: x.path, message: `result fails validateManifest: ${x.message}` })));
    const had = danglingRefs(before);
    const fresh = [...danglingRefs(work)].filter((r) => !had.has(r));
    if (fresh.length) return fail(fresh.map((r) => ({ op_index: null, path: r.split("->")[0], message: `edit leaves a dangling reference: ${r}` })));

    const inv = buildPatch({
      world_id: patch.world_id, base_version: work.world_version, base_hash: hashManifest(work),
      author: patch.author, intent: patch.intent, created_at: patch.created_at, ops: inverse, inverse_of: patch.patch_id,
    });
    return { ok: true, manifest: work, inverse: inv, errors: [], warnings: vm.warnings };
  } catch (err) {
    return fail([{ op_index: null, path: null, message: `apply failed: ${err?.message || err}` }]);
  }
}

function buildPatch(fields) {
  const p = { patch_version: PATCH_VERSION, ...fields };
  for (const k of Object.keys(p)) if (p[k] === undefined) delete p[k];
  delete p.patch_id;
  return { patch_id: "p_" + sha(canonicalJSON(p)).slice(0, 24), ...p };
}

/**
 * Build a well-formed patch against `manifest` (fills base_version/base_hash,
 * deterministic patch_id). created_at defaults to now — pass one for determinism.
 */
export function createPatch({ manifest, ops, author = { kind: "user", id: "anonymous" }, intent, created_at = new Date().toISOString(), world_id } = {}) {
  return buildPatch({
    world_id: world_id ?? manifest?.world_id, base_version: manifest?.world_version, base_hash: hashManifest(manifest),
    author, intent, created_at, ops,
  });
}

/** Re-pin a patch onto `manifest` (new base_version/base_hash/patch_id). Used by undo/redo. */
export function rebasePatch(patch, manifest, knownHash) {
  const { patch_id, base_version, base_hash, ...rest } = patch;
  return buildPatch({ ...rest, base_version: manifest.world_version, base_hash: knownHash ?? hashManifest(manifest) });
}

/**
 * The inverse of `patch` given the manifest it applies to. Applying the result
 * to applyPatch(manifestBefore, patch).manifest restores hashManifest(manifestBefore).
 * Throws if the patch does not apply (there is no inverse of a rejected edit).
 */
export function invertPatch(patch, manifestBefore) {
  const r = applyPatch(manifestBefore, patch, { trusted: true });
  if (!r.ok) {
    const err = new Error("cannot invert a patch that does not apply: " + r.errors.map((x) => x.message).join("; "));
    err.errors = r.errors;
    throw err;
  }
  return r.inverse;
}

/**
 * Apply patches in order. Deterministic: same base + same patches => same hashManifest.
 * Stops at the first failure; `manifest` is the last good state.
 */
export function replayPatches(baseManifest, patches, options = {}) {
  let cur = baseManifest;
  let applied = 0;
  if (!Array.isArray(patches)) return { ok: false, manifest: cur, applied, errors: [{ patch_index: null, op_index: null, path: null, message: "patches must be an array" }] };
  for (let i = 0; i < patches.length; i++) {
    const r = applyPatch(cur, patches[i], options);
    if (!r.ok) return { ok: false, manifest: cur, applied, errors: r.errors.map((x) => ({ patch_index: i, ...x })) };
    cur = r.manifest;
    applied++;
  }
  return { ok: true, manifest: cur, applied, errors: [] };
}

// --------------------------------------------------------------- diffing

function sameVal(a, b) {
  if (a === undefined || b === undefined) return a === b;
  return canonicalJSON(a) === canonicalJSON(b);
}

/**
 * Ops that turn `a` into `b`, over the patchable surface: whitelisted set paths,
 * the eight collections (add/remove/update/move), assets (replace_asset) and
 * player-spawn positions. Changes elsewhere (terrain, navigation links, ...) are
 * not expressible as ops — diffManifestsDetailed reports them as `uncovered`.
 * For a human-readable diff with counts use src/v3/expansion/diff.mjs.
 */
export function diffManifests(a, b) {
  return diffManifestsDetailed(a, b).ops;
}

export function diffManifestsDetailed(a, b) {
  const ops = [];
  for (const path of SET_PATH_WHITELIST) {
    const segs = path.split(".");
    const va = getPath(a, segs), vb = getPath(b, segs);
    if (sameVal(va, vb)) continue;
    if (vb === undefined) {
      let prune = 0;
      for (let k = segs.length - 1; k >= 1; k--) {
        const pre = segs.slice(0, k);
        if (getPath(a, pre) !== undefined && getPath(b, pre) === undefined) prune++; else break;
      }
      ops.push(prune ? { op: "unset", path, prune } : { op: "unset", path });
    } else ops.push({ op: "set", path, value: clone(vb) });
  }
  for (const c of COLLECTIONS) {
    const A = Array.isArray(a?.[c]) ? a[c] : [], B = Array.isArray(b?.[c]) ? b[c] : [];
    const mapA = new Map(A.map((x) => [x?.id, x])), mapB = new Map(B.map((x) => [x?.id, x]));
    for (const x of A) if (!mapB.has(x?.id)) ops.push({ op: "remove", collection: c, id: x.id });
    B.forEach((x, idx) => { if (!mapA.has(x?.id)) ops.push({ op: "add", collection: c, value: clone(x), index: idx }); });
    for (const y of B) {
      const x = mapA.get(y?.id);
      if (!x || sameVal(x, y)) continue;
      if (c === "assets") { ops.push({ op: "replace_asset", asset_id: y.id, value: clone(y) }); continue; }
      const fields = [...new Set([...Object.keys(x), ...Object.keys(y)])].filter((f) => !sameVal(x[f], y[f]));
      const mt = MOVE_TARGETS[c];
      if (mt && fields.length === 1 && fields[0] === mt[0]) {
        const px = getPath(x, mt), py = getPath(y, mt);
        const restX = mt.length > 1 ? { ...x[mt[0]], [mt[1]]: undefined } : null;
        const restY = mt.length > 1 ? { ...y[mt[0]], [mt[1]]: undefined } : null;
        if (isPlainObject(px) && isVec3(py) && sameVal(restX, restY)) { ops.push({ op: "move", collection: c, id: y.id, position: clone(py) }); continue; }
      }
      const set = {}, unset = [];
      for (const f of fields) { if (hasOwn(y, f)) set[f] = clone(y[f]); else unset.push(f); }
      const op = { op: "update", collection: c, id: y.id };
      if (Object.keys(set).length) op.set = set;
      if (unset.length) op.unset = unset;
      ops.push(op);
    }
  }
  const psA = new Map((a?.spawn?.player_spawns || []).map((s) => [s?.id, s]));
  for (const s of b?.spawn?.player_spawns || []) {
    const p = psA.get(s?.id);
    if (p && !sameVal(p.position, s.position) && isVec3(s.position)) ops.push({ op: "move", collection: "player_spawns", id: s.id, position: clone(s.position) });
  }
  // Verify: replay the ops and report whatever they could not express.
  const uncovered = [];
  let exact = false;
  try {
    const work = structuredClone(a);
    const { errors } = runOps(work, ops, { trusted: true });
    uncovered.push(...errors.map((x) => `op ${x.op_index}: ${x.message}`));
    exact = errors.length === 0 && hashManifest(work) === hashManifest(b);
    if (!exact) {
      const strip = (m) => { const h = JSON.parse(canonicalJSON(m)); delete h.world_version; if (h.meta) delete h.meta.updated_at; if (h.provenance) delete h.provenance.manifest_hash; return h; };
      const w = strip(work), t = strip(b);
      for (const k of new Set([...Object.keys(w), ...Object.keys(t)])) if (!sameVal(w[k], t[k])) uncovered.push(k);
    }
  } catch (err) { uncovered.push(`diff verification failed: ${err.message}`); }
  return { ops, exact, uncovered };
}

export { createEditHistory } from "./history.mjs";
export { looksLikeCode, looksLikeUrl, POLLUTION_KEYS };
