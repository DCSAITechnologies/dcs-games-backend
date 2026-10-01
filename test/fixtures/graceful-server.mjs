// Fixture for test/graceful-shutdown.test.mjs: a server with a slow route and a
// /ready that follows the drain, run as a real process so the test can send it
// a real SIGTERM.
import http from "node:http";
import { installGracefulShutdown } from "../../src/core/graceful-shutdown.mjs";

let shutdown;
const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/ready") {
    const ok = !shutdown.isDraining();
    res.writeHead(ok ? 200 : 503, { "content-type": "application/json" });
    return res.end(JSON.stringify({ ready: ok }));
  }
  if (u.pathname === "/slow") {
    const ms = Number(u.searchParams.get("ms") || 1000);
    return setTimeout(() => { res.writeHead(200, { "content-type": "text/plain" }); res.end("done " + ms); }, ms);
  }
  res.writeHead(404); res.end();
});
shutdown = installGracefulShutdown(server, { graceMs: Number(process.env.GRACE_MS || 5000) });
server.listen(0, "127.0.0.1", () => console.log("listening " + server.address().port));
