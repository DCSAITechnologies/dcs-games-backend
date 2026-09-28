// Games-B world stage: public API.
//
// Node callers import from here; the browser runtime imports the isomorphic
// files (terrain-sample, nav-grid, collision, *.schema) directly by path.

export { generateWorldSpec, isConnected, bakeNavigation, buildEnvironment, WORLD_SPEC_VERSION, SIZE_BY_SCALE, LIB, PICKUP_LIBS, FOCAL_KIND } from "./world-spec.mjs";
export { validateWorldSpec, LIB_NAMES, BIOMES } from "./world-spec.schema.mjs";
export { sampleHeight, slopeAt, normalAt, expandScatter, footprintRadius, distToPolyline } from "./terrain-sample.mjs";
export { generateBaseTerrain, SHAPE_BY_BIOME, terrainGrid } from "./terrain.mjs";
export { navIndex, isWalkable, findPath, reachableSet, nearestWalkable, segmentWalkable, cellCenter } from "./nav-grid.mjs";
export { buildColliders, resolveCapsule, pointInCollider } from "./collision.mjs";
export { compileSceneGraph } from "./scene-graph.mjs";
export { validateSceneGraph, sceneAssetRefs, sceneMaterialRefs, SCENE_GRAPH_VERSION } from "./scene-graph.schema.mjs";
