// Games-B asset stage — public surface. NODE-ONLY as a whole (it re-exports
// the cache, providers and baker). Browser code imports the isomorphic files
// directly: texture-synth.mjs, mesh-recipes.mjs, asset-record.schema.mjs
// (materials.mjs, svg.mjs and cinematic.mjs are also browser-safe).

export { resolveAssets, collectRequiredRefs, assetIdFor, ASSET_PIPELINE_VERSION } from "./asset-pipeline.mjs";
export { validateAssetRecord, validateAssetSet, ASSET_RECORD_VERSION, ASSET_KINDS, ASSET_FORMATS, REQUIRED_FIELDS, REF_PREFIXES, PART_SHAPES } from "./asset-record.schema.mjs";
export { buildMeshRecipe, buildCharacterRecipe, nearestLibName, estimateTriangles, computeBounds, partTriangles, LIB_NAMES, LIB_ROLES, libRole, libAssetKind } from "./mesh-recipes.mjs";
export { synthesizeTexture, synthesizeChannel, TEXTURE_GENERATORS, TEXTURE_SIZES, hexToRgb } from "./texture-synth.mjs";
export { buildMaterialSpec, MATERIAL_NAMES, MATERIAL_REFS, mixHex } from "./materials.mjs";
export { iconSvg, uiSvg, skyRecipe, ICON_KINDS, UI_NAMES } from "./svg.mjs";
export { buildIntroCinematic } from "./cinematic.mjs";
export { encodePng, decodePngHeader, extractIdat, crc32 } from "./png.mjs";
export { bake } from "./bake.mjs";
export { createAssetCache, DEFAULT_CACHE_DIR } from "./cache.mjs";
export { createImageLane, createMeshLane, togetherFluxAdapter, external3dAdapter, proceduralImageAdapter, proceduralMeshAdapter, runLane, availableProviders, estimateFluxCost, FLUX_SCHNELL_MODEL, FLUX_SCHNELL_USD_PER_MEGAPIXEL } from "./providers.mjs";
