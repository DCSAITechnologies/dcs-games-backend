// Minimal Chrome DevTools Protocol driver.
//
// Used for the A6 page smoke tests, the B3 runtime checks and the B14 flagship
// E2E. It talks CDP over Node's built-in WebSocket, so there is no Puppeteer
// dependency to install or pin — it drives the Chrome for Testing binary that
// is already on the machine.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

const CANDIDATES = [
  process.env.DCS_CHROME,
  ...(() => {
    const roots = [];
    const base = path.join(os.homedir(), ".cache", "puppeteer");
    for (const kind of ["chrome", "chrome-headless-shell"]) {
      const dir = path.join(base, kind);
      if (!fs.existsSync(dir)) continue;
      for (const v of fs.readdirSync(dir).sort().reverse()) {
        const vd = path.join(dir, v);
        for (const inner of fs.existsSync(vd) ? fs.readdirSync(vd) : []) {
          roots.push(path.join(vd, inner, "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"));
          roots.push(path.join(vd, inner, "chrome-headless-shell"));
          roots.push(path.join(vd, inner, "chrome"));
        }
      }
    }
    return roots;
  })(),
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
];

export function findChrome() {
  for (const c of CANDIDATES) {
    if (c && fs.existsSync(c)) return c;
  }
  return null;
}

/** Serve a directory over HTTP. Returns { url, close }. */
export function serveStatic(dir, port = 0) {
  const types = {
    ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
    ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png",
    ".jpg": "image/jpeg", ".glb": "model/gltf-binary", ".wasm": "application/wasm",
  };
  const redirects = new Map();
  const rf = path.join(dir, "_redirects");
  if (fs.existsSync(rf)) {
    for (const line of fs.readFileSync(rf, "utf8").split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const [from, to, code] = t.split(/\s+/);
      if (from && to) redirects.set(from.replace(/\/$/, "") || "/", { to, code: Number(code || 301) });
    }
  }
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent((req.url || "/").split("?")[0]);
    const key = p.replace(/\/$/, "") || "/";
    if (redirects.has(key)) {
      const r = redirects.get(key);
      if (r.code === 200) p = r.to;
      else { res.writeHead(r.code, { Location: r.to }); return res.end(); }
    }
    if (p.endsWith("/")) p += "index.html";
    const file = path.join(dir, p);
    if (!file.startsWith(dir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      const nf = path.join(dir, "404.html");
      if (fs.existsSync(nf)) {
        res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
        return res.end(fs.readFileSync(nf));
      }
      res.writeHead(404, { "Content-Type": "text/plain" });
      return res.end("not found");
    }
    res.writeHead(200, { "Content-Type": types[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const a = server.address();
      resolve({ url: `http://127.0.0.1:${a.port}`, port: a.port, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

export async function launchChrome({ headless = true, extraArgs = [] } = {}) {
  const bin = findChrome();
  if (!bin) throw new Error("no Chrome binary found");
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "dcs-chrome-"));
  const args = [
    "--remote-debugging-port=0",
    `--user-data-dir=${userDir}`,
    "--no-first-run", "--no-default-browser-check",
    "--disable-background-networking", "--disable-sync",
    "--disable-features=Translate,MediaRouter",
    "--use-gl=swiftshader", "--enable-unsafe-swiftshader",
    "--window-size=1280,900",
    ...(headless ? ["--headless=new", "--disable-gpu"] : []),
    ...extraArgs,
    "about:blank",
  ];
  const proc = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
  const wsUrl = await new Promise((resolve, reject) => {
    let buf = "";
    const to = setTimeout(() => reject(new Error("chrome did not report a devtools endpoint:\n" + buf)), 30000);
    proc.stderr.on("data", (d) => {
      buf += d.toString();
      const m = /ws:\/\/[^\s]+/.exec(buf);
      if (m) { clearTimeout(to); resolve(m[0]); }
    });
    proc.on("exit", (c) => { clearTimeout(to); reject(new Error("chrome exited " + c + "\n" + buf)); });
  });
  return {
    proc,
    wsUrl,
    close: async () => {
      try { proc.kill("SIGKILL"); } catch {}
      // Chrome flushes its profile asynchronously after SIGKILL, so a rm can race
      // with the last write. A leftover temp profile must never fail a test run.
      try { fs.rmSync(userDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
    },
  };
}

/** A single CDP session against a fresh tab. */
export class Page {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.consoleLogs = [];
    this.pageErrors = [];
    this.requestFailures = [];
    this.responses = [];
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message + " " + (msg.error.data || ""))) : resolve(msg.result);
        return;
      }
      this._event(msg);
    });
  }
  _event(msg) {
    if (msg.method === "Runtime.consoleAPICalled") {
      this.consoleLogs.push({ type: msg.params.type, text: (msg.params.args || []).map((a) => a.value ?? a.description ?? a.type).join(" ") });
    } else if (msg.method === "Runtime.exceptionThrown") {
      const d = msg.params.exceptionDetails;
      this.pageErrors.push(d.exception?.description || d.text || "unknown error");
    } else if (msg.method === "Network.loadingFailed") {
      this.requestFailures.push({ url: msg.params.request?.url, error: msg.params.errorText, type: msg.params.type });
    } else if (msg.method === "Network.requestWillBeSent") {
      this._urls = this._urls || new Map();
      this._urls.set(msg.params.requestId, msg.params.request.url);
    } else if (msg.method === "Network.responseReceived") {
      this.responses.push({ url: msg.params.response.url, status: msg.params.response.status });
    }
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); } }, 60000);
    });
  }
  static async open(browser) {
    const targets = await fetchJson(browser.wsUrl.replace(/^ws:\/\/([^/]+).*/, "http://$1/json/new?about:blank"), "PUT");
    const ws = new WebSocket(targets.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener("open", res, { once: true }); ws.addEventListener("error", rej, { once: true }); });
    const page = new Page(ws);
    page.targetId = targets.id;
    page.httpBase = browser.wsUrl.replace(/^ws:\/\/([^/]+).*/, "http://$1");
    await page.send("Page.enable");
    await page.send("Runtime.enable");
    await page.send("Network.enable");
    await page.send("Log.enable").catch(() => {});
    return page;
  }
  async goto(url, { waitMs = 900 } = {}) {
    this.consoleLogs = []; this.pageErrors = []; this.requestFailures = []; this.responses = [];
    const loaded = new Promise((resolve) => {
      const h = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.method === "Page.loadEventFired") { this.ws.removeEventListener("message", h); resolve(); }
      };
      this.ws.addEventListener("message", h);
      setTimeout(() => { this.ws.removeEventListener("message", h); resolve(); }, 30000);
    });
    await this.send("Page.navigate", { url });
    await loaded;
    await new Promise((r) => setTimeout(r, waitMs));
  }
  async eval(expr) {
    // async so a test can await inside the page (settling a frame, for example).
    const r = await this.send("Runtime.evaluate", { expression: `(async function(){${expr}})()`, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  }
  text() { return this.eval("return document.body ? document.body.innerText : ''"); }
  async waitFor(expr, { timeout = 15000, interval = 200 } = {}) {
    const end = Date.now() + timeout;
    for (;;) {
      let v = false;
      try { v = await this.eval(`return !!(${expr})`); } catch { v = false; }
      if (v) return true;
      if (Date.now() > end) return false;
      await new Promise((r) => setTimeout(r, interval));
    }
  }
  async screenshot(file) {
    const r = await this.send("Page.captureScreenshot", { format: "png" });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(r.data, "base64"));
    return file;
  }
  /** Errors that indicate a genuinely broken page, ignoring expected offline API calls. */
  realErrors(ignore = []) {
    const pats = [/favicon/i, /fonts\.g(oogleapis|static)/i, ...ignore];
    return this.pageErrors.filter((e) => !pats.some((p) => p.test(e)));
  }
  async close() { try { await fetchJson(this.httpBase + "/json/close/" + this.targetId); } catch {} try { this.ws.close(); } catch {} }
}

function fetchJson(url, method = "GET") {
  return fetch(url, { method }).then((r) => r.json());
}
