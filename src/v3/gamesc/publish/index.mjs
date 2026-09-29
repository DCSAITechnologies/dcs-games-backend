// GAMES-C publish pipeline (STAGING ONLY). See docs/games-c/DCS_GAMES_PUBLISH_PIPELINE.md.
export { canonicalJSON, hashManifestExact, sha256Hex } from "./canonical.mjs";
export { writeTar, readTar, safeEntryPath } from "./tar.mjs";
export {
  SECRET_RULES, DEFAULT_MIME_ALLOWLIST, NEVER_MIME, PRODUCTION_HOSTS, ProductionTargetError,
  scanSecrets, checkUrls, assertStagingTarget, assertStagingOnlyEnv,
} from "./guards.mjs";
export {
  PACKAGE_VERSION, BUILDER, DEFAULT_BUDGETS, PASSING_VERDICTS, RUNTIME_ENTRY,
  ARCHIVE_FILE, SIGNATURE_FILE, DESCRIPTOR_FILE, MANIFEST_FILE,
  buildStagingPackage, verifyArchive, verifyPackageSignature, playtestVerdictHash,
  createEd25519Signer, generateThrowawaySigner, atlasEnvSigner, signatureBody,
} from "./package.mjs";
export {
  CHANNEL, DEFAULT_PREVIEW_BASE, PublishError,
  createStagingRegistry, openPreview, previewUrl, startPreviewServer,
} from "./registry.mjs";
