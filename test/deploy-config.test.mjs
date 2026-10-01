// The deploy configuration the platform actually reads.
//
// Staging L1 (1 Oct 2026) found the service built by RAILPACK, which ignores
// nixpacks.toml: Node 18.20.8 instead of 22, no psql (the boot schema assertion
// fell back to the Supabase Data API and migrations could not run in the image),
// an `npm install` of everything, and `npm start` under NPM_CONFIG_PRODUCTION
// printing "npm warn config production Use `--omit=dev` instead." on every boot.
// The /ready healthcheck had also been lost once already, because a dashboard
// setting does not reach a redeployed manifest. railway.json and railpack.json
// pin all of it in the repo; these tests pin the files.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const GB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => JSON.parse(fs.readFileSync(path.join(GB, f), "utf8"));

test("railway.json: RAILPACK, the start command bypasses npm, /ready gates traffic, draining outlasts the grace", () => {
  const r = read("railway.json");
  assert.equal(r.build.builder, "RAILPACK");
  assert.equal(r.deploy.startCommand, "node --import tsx server.mts", "no npm and no shell layer between the platform's SIGTERM and the server");
  assert.equal(r.deploy.healthcheckPath, "/ready");
  assert.ok(r.deploy.healthcheckTimeout >= 60);
  assert.ok(r.deploy.drainingSeconds * 1000 > 10000, "the platform's SIGKILL must come after the server's 10s drain bound");
});

test("railpack.json: the install step copies package.json AND package-lock.json before npm ci --omit=dev", () => {
  // RC2 (89b53d6) replaced the install step's commands with the npm ci line
  // alone. A step's `commands` REPLACES Railpack's defaults wholesale, and the
  // defaults are what copy the manifests into the step: the RC2 build ran npm ci
  // in an /app with no lockfile and failed EUSAGE (L1 deployment 175fad21,
  // reproduced with a real railpack 0.40.1 build). The copies are explicit now.
  const cmds = read("railpack.json").steps.install.commands;
  const idx = (pred) => cmds.findIndex(pred);
  const pkg = idx((c) => c && c.src === "package.json" && c.dest === "package.json");
  const lock = idx((c) => c && c.src === "package-lock.json" && c.dest === "package-lock.json");
  const ci = idx((c) => (typeof c === "string" ? c : c?.cmd || "").includes("npm ci --omit=dev"));
  assert.ok(pkg >= 0, "package.json must be copied into the install step");
  assert.ok(lock >= 0, "package-lock.json must be copied into the install step");
  assert.ok(ci > pkg && ci > lock, "npm ci must run after both copies");
  assert.match((cmds[ci].cmd || cmds[ci]), /^env -u NPM_CONFIG_PRODUCTION npm ci --omit=dev$/, "npm ci from the lockfile, without the deprecated production config");
  assert.ok(!cmds.some((c) => /npm install/.test(typeof c === "string" ? c : c?.cmd || "")), "no npm install: the lockfile is the install");
});

test("railpack.json: Node 22, psql in the runtime image, and the same start command as railway.json", () => {
  const r = read("railpack.json");
  assert.equal(r.packages.node, "22");
  assert.ok(r.deploy.aptPackages.includes("postgresql-client"), "psql is the migration runner and the boot schema assertion's driver");
  assert.equal(r.deploy.startCommand, read("railway.json").deploy.startCommand, "the image's own command matches what Railway runs");
});

test("--omit=dev keeps what the runtime needs: tsx is a production dependency", () => {
  const pkg = read("package.json");
  assert.ok(pkg.dependencies?.tsx, "tsx must be in dependencies, or --omit=dev removes the loader the start command uses");
  assert.ok(!pkg.devDependencies?.tsx);
});

test("the deploy start command boots without the npm production warning and drains on a direct SIGTERM", async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "dcs-startcmd-"));
  const port = 9990 + Math.floor(Math.random() * 9);
  const [bin, ...args] = read("railway.json").deploy.startCommand.split(" ");
  assert.equal(bin, "node");
  const p = spawn(process.execPath, args, {
    cwd: GB,
    env: { ...process.env, PORT: String(port), DCS_AUTH_SECRET: crypto.randomBytes(24).toString("hex"), DCS_DATA_DIR: data,
      ATLAS_PRIVATE_KEY: crypto.randomBytes(32).toString("base64"), DCS_PROVIDERS_OFFLINE: "1", NODE_ENV: "production",
      NPM_CONFIG_PRODUCTION: "false",                     // what Railpack sets in the image
      SUPABASE_URL: "", SUPABASE_SERVICE_ROLE_KEY: "", DATABASE_URL: "", DCS_ENV: "local", RAILWAY_ENVIRONMENT_NAME: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (out += d));
  const exited = new Promise((r) => p.on("exit", (code) => r(code)));
  try {
    let up = false;
    for (let i = 0; i < 300 && !up; i++) {
      try { up = (await fetch(`http://127.0.0.1:${port}/health`)).ok; } catch { await new Promise((r) => setTimeout(r, 100)); }
    }
    assert.ok(up, "server did not come up:\n" + out.slice(-1500));
    p.kill("SIGTERM");                                     // straight at the server process, as the platform will
    assert.equal(await exited, 0, out.slice(-1500));
    assert.match(out, /\[shutdown\] SIGTERM: draining/);
    assert.doesNotMatch(out, /npm warn config production/);
  } finally {
    if (p.exitCode === null) p.kill("SIGKILL");
    fs.rmSync(data, { recursive: true, force: true });
  }
});
