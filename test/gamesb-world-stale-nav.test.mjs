// A solid placed without re-baking navigation used to pass every static gate
// (paths planned straight through it) and was caught only by the headless
// playtest. The world validator now flags it directly.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateWorldSpec, validateWorldSpec, isWalkable } from "../src/gamesb/world/index.mjs";
import { bakeNavigation } from "../src/gamesb/world/world-spec.mjs";
import { buildColliders } from "../src/gamesb/world/collision.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const concept = JSON.parse(fs.readFileSync(path.join(HERE, "fixtures/gamesb/world/island-concept.json"), "utf8"));

function withCrate(world) {
  const w = structuredClone(world);
  const hub = w.regions[0];
  // A walkable spot a few metres from the hub centre, off the player spawn.
  const sp = w.spawn_points.find((s) => s.id === "spawn_player").position;
  let pos = null;
  for (let d = 6; d < 30 && !pos; d += 2) {
    for (const [dx, dz] of [[d, 0], [-d, 0], [0, d], [0, -d]]) {
      const x = hub.center.x + dx, z = hub.center.z + dz;
      if (Math.hypot(x - sp.x, z - sp.z) > 4 && isWalkable(w.navigation, x, z)) { pos = { x, y: hub.center.y, z }; break; }
    }
  }
  assert.ok(pos, "found a walkable spot for the test crate");
  w.placements.push({ id: "pl_test_crate", asset_ref: "lib:crate", region: hub.id, position: pos, rotation_y: 0, scale: 1,
    role: "prop", collider: { shape: "box", size: { x: 3, y: 2, z: 3 }, solid: true }, tags: [] });
  return w;
}

test("a solid added without re-baking navigation is rejected", () => {
  const w = withCrate(generateWorldSpec(concept));
  const v = validateWorldSpec(w, { concept });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.path === "navigation.walkable" && /pl_test_crate/.test(e.message)), JSON.stringify(v.errors.slice(0, 3)));
});

test("the same solid after re-baking navigation passes", () => {
  const w = withCrate(generateWorldSpec(concept));
  w.navigation = bakeNavigation(w, buildColliders(w));
  const v = validateWorldSpec(w, { concept });
  assert.deepEqual(v.errors.filter((e) => e.path === "navigation.walkable"), []);
});
