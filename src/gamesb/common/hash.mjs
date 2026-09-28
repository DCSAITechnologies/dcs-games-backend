// Games-B content hashing. NODE-ONLY (uses node:crypto) — never import this
// from an isomorphic module.

import { createHash } from "node:crypto";

/** JSON with object keys sorted recursively, so equal content hashes equally. */
export function canonicalJson(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canonicalJson).join(",") + "]";
  return "{" + Object.keys(v).filter((k) => v[k] !== undefined).sort()
    .map((k) => JSON.stringify(k) + ":" + canonicalJson(v[k])).join(",") + "}";
}

export function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

export const sha256Json = (v) => sha256(canonicalJson(v));

/** Prompt hash as recorded in every asset record and provenance entry. */
export const promptHash = (prompt) => sha256(String(prompt ?? "").trim().replace(/\s+/g, " "));
