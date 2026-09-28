// Games-B shared validation helpers. ISOMORPHIC.
//
// Same shape as the WorldManifestV3 validator (src/v3/manifest/schema.mjs):
// hand-written, zero-dependency, and every issue carries a path, a message and
// optionally a hint the repair pass can act on.

export const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
export const isArr = Array.isArray;
export const isStr = (v) => typeof v === "string" && v.length > 0;
export const isNum = (v) => typeof v === "number" && Number.isFinite(v);
export const isInt = (v) => Number.isInteger(v);
export const isBool = (v) => typeof v === "boolean";
export const isVec3 = (v) => isObj(v) && isNum(v.x) && isNum(v.y) && isNum(v.z);
export const isVec2 = (v) => isObj(v) && isNum(v.x) && isNum(v.z);
export const isHex = (v) => typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v);
export const isSemver = (v) => typeof v === "string" && /^\d+\.\d+\.\d+$/.test(v);

export class Issues {
  constructor() { this.errors = []; this.warnings = []; }
  err(path, message, hint) { this.errors.push({ path, message, ...(hint ? { hint } : {}) }); }
  warn(path, message, hint) { this.warnings.push({ path, message, ...(hint ? { hint } : {}) }); }
  get ok() { return this.errors.length === 0; }
  /** Pull another validator's result in under a path prefix. */
  merge(result, prefix = "") {
    for (const e of result?.errors || []) this.errors.push({ ...e, path: prefix ? `${prefix}.${e.path}` : e.path });
    for (const w of result?.warnings || []) this.warnings.push({ ...w, path: prefix ? `${prefix}.${w.path}` : w.path });
  }
  toJSON() { return { ok: this.ok, errors: this.errors, warnings: this.warnings }; }
}

export function requireEnum(iss, v, allowed, path, { optional = false } = {}) {
  if (v === undefined || v === null) {
    if (!optional) iss.err(path, `is required (one of: ${allowed.join(", ")})`);
    return false;
  }
  if (!allowed.includes(v)) { iss.err(path, `'${v}' is not permitted`, `use one of: ${allowed.join(", ")}`); return false; }
  return true;
}

export function requireNum(iss, v, path, { min = -Infinity, max = Infinity, optional = false, integer = false } = {}) {
  if (v === undefined || v === null) {
    if (!optional) iss.err(path, "is required and must be a number");
    return false;
  }
  if (!isNum(v) || (integer && !isInt(v))) { iss.err(path, `must be ${integer ? "an integer" : "a finite number"}`); return false; }
  if (v < min || v > max) { iss.err(path, `must be in [${min}, ${max}], got ${v}`); return false; }
  return true;
}

/** Check that every element of an id-bearing array has a unique string id; returns the id set. */
export function uniqueIds(iss, arr, path) {
  const ids = new Set();
  if (!isArr(arr)) { iss.err(path, "must be an array"); return ids; }
  arr.forEach((x, i) => {
    if (!isStr(x?.id)) { iss.err(`${path}[${i}].id`, "is required"); return; }
    if (ids.has(x.id)) iss.err(`${path}[${i}].id`, `duplicate id '${x.id}'`);
    ids.add(x.id);
  });
  return ids;
}
