// Where the canonical frontend lives, and what to do when it does not.
//
// THE DEFECT THIS EXISTS TO PREVENT: every browser suite used to resolve the
// site itself and, when it was not there, pass `{ skip: "dcs-games-LIVE not
// found" }` to every test. `npm run test:browser` then exited 0 having run
// nothing — measured on a clean clone: 83 tests, 0 passed, 83 skipped, exit 0.
// The entire browser, accessibility, performance and frontend-truth evidence
// turned itself off, and said so only in output nobody reads on a green run.
// CI made it worse: it never checked the frontend out at all, so those 83 tests
// had been skipping there for as long as the job has existed.
//
// A suite that cannot run must FAIL, loudly, and say exactly what is missing.
// Skipping is available, but only when a human asks for it by name.
import fs from "node:fs";
import path from "node:path";

/** The layout, stated once. Two levels above the backend root. */
const DEFAULT_REL = "../../../dcs-games-LIVE";

/**
 * @param testDir  the calling test file's directory
 * @returns the site directory; throws if it is not there
 *
 * Override with DCS_SITE_DIR — necessary because the directory must be named
 * `dcs-games-LIVE` while the repository it comes from is called
 * `dcs-games-frontend`, which nothing wrote down until now.
 *
 * Opt out with DCS_ALLOW_MISSING_SITE=1 to genuinely skip, for a backend-only
 * checkout. Then the skip is a decision somebody made, not an accident.
 */
export function resolveSite(testDir) {
  const site = process.env.DCS_SITE_DIR
    ? path.resolve(process.env.DCS_SITE_DIR)
    : path.resolve(testDir, DEFAULT_REL);

  if (fs.existsSync(path.join(site, "index.html"))) return site;

  // Opted out: hand back the path anyway. Callers do module-level
  // path.join(SITE, ...) and then guard on existence, so returning null would
  // crash at import — turning a deliberate skip into a different failure.
  if (process.env.DCS_ALLOW_MISSING_SITE === "1") return site;

  throw new Error(
    `The canonical frontend is not at ${site}, so this suite cannot test anything.\n` +
    `  It is expected two levels above the backend root, in a directory named\n` +
    `  'dcs-games-LIVE' — note the repository is called 'dcs-games-frontend'.\n` +
    `  Clone it there, or set DCS_SITE_DIR to where it is.\n` +
    `  To run the backend suites without it, set DCS_ALLOW_MISSING_SITE=1 — the\n` +
    `  browser tests will then skip, which is a choice rather than an accident.`
  );
}

/** Chrome gets the same treatment, for the same reason. */
export function requireChrome(findChrome) {
  const bin = findChrome();
  if (bin) return bin;
  if (process.env.DCS_ALLOW_MISSING_SITE === "1") return null;
  throw new Error(
    "No Chrome binary was found, so the browser suites cannot run.\n" +
    "  Install Chrome for Testing:\n" +
    "    npx --yes @puppeteer/browsers install chrome@stable --path \"$HOME/.cache/puppeteer\"\n" +
    "  Or set DCS_ALLOW_MISSING_SITE=1 to skip the browser suites deliberately."
  );
}
