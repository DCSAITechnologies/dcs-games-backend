// Which commit is actually serving.
//
// Until now /health could not answer that. A staging deploy could be verified
// as "healthy" while running a build from days earlier — which is exactly what
// happened when a Railway variable change silently reverted the service to its
// GitHub-source build and discarded a `railway up` upload. "Health is 200" is
// not evidence that the code you just banked is the code that is running.
//
// Three sources, in order of trust:
//   1. build-info.json, written by scripts/stamp-build.mjs at upload time
//   2. RAILWAY_GIT_COMMIT_SHA, injected by Railway for git-source deploys
//   3. nothing — reported honestly as "unknown", never guessed
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export function readBuildInfo(env = process.env, root = ROOT) {
  let stamped = null;
  try {
    stamped = JSON.parse(fs.readFileSync(path.join(root, "build-info.json"), "utf8"));
  } catch { /* not stamped; fall through */ }

  if (stamped?.commit) {
    return {
      commit: String(stamped.commit),
      branch: stamped.branch || null,
      built_at: stamped.built_at || null,
      // A stamp made from a dirty worktree describes no commit that exists
      // anywhere. Say so rather than letting it read as a banked SHA.
      dirty: !!stamped.dirty,
      source: "stamp",
    };
  }

  const railway = env.RAILWAY_GIT_COMMIT_SHA;
  if (railway) {
    return {
      commit: String(railway),
      branch: env.RAILWAY_GIT_BRANCH || null,
      built_at: null,
      dirty: false,
      source: "railway-git",
    };
  }

  return {
    commit: null,
    branch: null,
    built_at: null,
    dirty: false,
    source: "unknown",
    note: "This build carries no commit stamp, so the running code cannot be tied to a commit. Deploy via scripts/stamp-build.mjs.",
  };
}
