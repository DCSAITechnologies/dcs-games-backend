// Minimal Cloudflare-Pages-like static server for dcs-games-LIVE.
// - applies _redirects (exact-path rules, 301/302)
// - strips .html (308 /x.html -> /x) and serves /x from x.html, like Pages
// - unmatched -> 404.html with status 404
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(process.argv[2] || ".");
const PORT = Number(process.argv[3] || 8788);
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".json": "application/json", ".webp": "image/webp", ".ico": "image/x-icon", ".woff2": "font/woff2" };

const rules = new Map();
try {
  for (const line of fs.readFileSync(path.join(ROOT, "_redirects"), "utf8").split("\n")) {
    const t = line.trim(); if (!t || t.startsWith("#")) continue;
    const [from, to, code] = t.split(/\s+/); rules.set(from, [to, Number(code || 302)]);
  }
} catch {}

function file(p) { try { const s = fs.statSync(p); return s.isFile() ? p : null; } catch { return null; } }

http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  let p = decodeURIComponent(u.pathname);
  if (rules.has(p)) { const [to, code] = rules.get(p); res.writeHead(code, { Location: to + u.search }); return res.end(); }
  if (p.endsWith("/index.html")) { res.writeHead(308, { Location: p.slice(0, -10) + u.search }); return res.end(); }
  if (p.endsWith(".html")) {
    // Pages strips the extension with a redirect.
    res.writeHead(308, { Location: p.slice(0, -5) + u.search }); return res.end();
  }
  let f = null;
  if (p.endsWith("/")) f = file(path.join(ROOT, p, "index.html"));
  else f = file(path.join(ROOT, p)) || file(path.join(ROOT, p + ".html")) || file(path.join(ROOT, p, "index.html"));
  if (f && !f.startsWith(ROOT)) f = null;
  if (!f) {
    res.writeHead(404, { "Content-Type": TYPES[".html"] });
    return res.end(fs.readFileSync(path.join(ROOT, "404.html")));
  }
  res.writeHead(200, { "Content-Type": TYPES[path.extname(f)] || "application/octet-stream", "Cache-Control": "no-store" });
  fs.createReadStream(f).pipe(res);
}).listen(PORT, "127.0.0.1", () => console.log(`serving ${ROOT} on http://127.0.0.1:${PORT}`));
