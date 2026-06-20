// src/validator.mjs
// Zero-dep validator for the CANONICAL C1 world.json (from _SHARED_Day0, reconciled 2026-06-19).
// CI gate: a world that doesn't conform is REJECTED (fail-closed) so CW3 never gets a bad world.
// Reconciled to canonical: 3D coords (x,y,z), spawns {id,x,y,z,role?}, objects flat transform,
// looser required sets (genre/atlas_receipt_hash/zones/reward/stackable/icon are OPTIONAL per canonical).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA = JSON.parse(fs.readFileSync(path.join(__dir, "../contracts/world.schema.json"), "utf8"));

const errs = [];
function req(obj, fields, where) {
  for (const f of fields) if (obj == null || !(f in obj)) errs.push(`${where}: missing required '${f}'`);
}
function num(v) { return typeof v === "number"; }

export function validateWorld(world) {
  errs.length = 0;
  if (!world || typeof world !== "object" || Array.isArray(world)) return { valid: false, errors: ["root: not an object"] };

  req(world, ["world_id", "schema_version", "meta", "terrain", "spawns", "objects", "npcs", "quests", "items"], "root");
  if (world.schema_version !== "1.0") errs.push(`schema_version: must be "1.0"`);

  if (world.meta) req(world.meta, ["title", "prompt", "creator_id", "created_at"], "meta");

  if (world.terrain) {
    req(world.terrain, ["type", "size", "data"], "terrain");
    if (world.terrain.type && !["tilegrid", "heightmap"].includes(world.terrain.type)) errs.push("terrain.type: must be tilegrid|heightmap");
    if (world.terrain.size) req(world.terrain.size, ["w", "h"], "terrain.size");
    if (world.terrain.data !== undefined && !Array.isArray(world.terrain.data)) errs.push("terrain.data: must be array");
  }

  (world.spawns || []).forEach((s, i) => {
    req(s, ["id", "x", "y", "z"], `spawns[${i}]`);
    if (!(num(s.x) && num(s.y) && num(s.z))) errs.push(`spawns[${i}]: x,y,z must be numbers`);
    if (s.role && !["player", "npc", "item"].includes(s.role)) errs.push(`spawns[${i}].role invalid`);
  });

  (world.objects || []).forEach((o, i) => {
    req(o, ["object_id", "kind", "transform"], `objects[${i}]`);
    if (o.transform) {
      req(o.transform, ["x", "y", "z"], `objects[${i}].transform`);
      if (!(num(o.transform.x) && num(o.transform.y) && num(o.transform.z))) errs.push(`objects[${i}].transform: x,y,z must be numbers`);
    }
  });

  (world.npcs || []).forEach((n, i) => req(n, ["npc_id", "kind", "spawn"], `npcs[${i}]`));
  (world.quests || []).forEach((q, i) => req(q, ["quest_id", "title", "objectives"], `quests[${i}]`));
  (world.items || []).forEach((it, i) => req(it, ["item_id", "name"], `items[${i}]`));

  return { valid: errs.length === 0, errors: [...errs] };
}

export { SCHEMA };
