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
  // Two roots, because the module's own location and the process working
  // directory are not the same thing in every image layout, and a stamp that
  // is present but looked for in the wrong place is indistinguishable from a
  // stamp that never shipped.
  // An explicitly supplied root means "look only here" — otherwise a test
  // asserting the unstamped case would find the repo's own stamp via cwd.
  const roots = root === ROOT ? [root, process.cwd()] : [root];
  const looked = [];
  let stamped = null;
  for (const dir of roots) {
    const f = path.join(dir, "build-info.json");
    if (looked.includes(f)) continue;
    looked.push(f);
    try { stamped = JSON.parse(fs.readFileSync(f, "utf8")); break; } catch { /* keep looking */ }
  }

  if (stamped?.commit) {
    return {
      commit: String(stamped.commit),
      branch: stamped.branch || null,
      built_at: stamped.built_at || null,
      // A stamp made from a dirty worktree describes no commit that exists
      // anywhere. Say so rather than letting it read as a banked SHA.
      dirty: !!stamped.dirty,
      source: "stamp",
      deployment_id: env.RAILWAY_DEPLOYMENT_ID || null,
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
      deployment_id: env.RAILWAY_DEPLOYMENT_ID || null,
    };
  }

  return {
    commit: null,
    branch: null,
    built_at: null,
    dirty: false,
    source: "unknown",
    // Railway injects this for every deploy including `railway up`, so even an
    // unstamped build can be tied to a specific deployment in the deploy log.
    deployment_id: env.RAILWAY_DEPLOYMENT_ID || null,
    looked_in: looked,
    note: "This build carries no commit stamp, so the running code cannot be tied to a commit by itself. Match deployment_id against the deploy log, or deploy via scripts/stamp-build.mjs.",
  };
}
