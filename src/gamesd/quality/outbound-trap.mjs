// Outbound trap. NODE-ONLY, for tests and tooling.
//
// Replaces every way this process could open a connection to another host
// (fetch, WebSocket, http/https/http2, net/tls sockets, dgram, DNS, and child
// processes that could shell out to curl) with a function that records the
// attempt and refuses it. `trap.calls` is the evidence: an empty list after a
// build means the build made zero external calls.
//
// Refusing (throwing) instead of silently answering is deliberate: a provider
// adapter that did try the network would then fail loudly into the lane's
// fallback AND leave a record here, so the test cannot pass by accident.

import http from "node:http";
import https from "node:https";
import http2 from "node:http2";
import net from "node:net";
import tls from "node:tls";
import dgram from "node:dgram";
import dns from "node:dns";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

const TARGETS = [
  [globalThis, "fetch", "fetch"],
  [globalThis, "WebSocket", "WebSocket"],
  [http, "request", "http.request"], [http, "get", "http.get"],
  [https, "request", "https.request"], [https, "get", "https.get"],
  [http2, "connect", "http2.connect"],
  [net, "connect", "net.connect"], [net, "createConnection", "net.createConnection"],
  [tls, "connect", "tls.connect"],
  [dgram, "createSocket", "dgram.createSocket"],
  [dns, "lookup", "dns.lookup"], [dns, "resolve", "dns.resolve"], [dns, "resolve4", "dns.resolve4"], [dns, "resolve6", "dns.resolve6"],
  [dns.promises, "lookup", "dns.promises.lookup"], [dns.promises, "resolve", "dns.promises.resolve"],
  [childProcess, "spawn", "child_process.spawn"], [childProcess, "exec", "child_process.exec"],
  [childProcess, "execFile", "child_process.execFile"], [childProcess, "fork", "child_process.fork"],
  [childProcess, "spawnSync", "child_process.spawnSync"], [childProcess, "execSync", "child_process.execSync"],
  [childProcess, "execFileSync", "child_process.execFileSync"],
];

function describeTarget(args) {
  const a = args[0];
  try {
    if (typeof a === "string") return a.slice(0, 200);
    if (a instanceof URL) return a.href.slice(0, 200);
    if (a && typeof a === "object") {
      if (typeof a.url === "string") return a.url.slice(0, 200);
      if (a.host || a.hostname) return `${a.hostname || a.host}:${a.port ?? ""}`;
    }
  } catch { /* fall through */ }
  return String(a === undefined ? "" : typeof a).slice(0, 80);
}

export class OutboundBlocked extends Error {
  constructor(api, target) {
    super(`outbound trap: ${api}(${target}) refused`);
    this.name = "OutboundBlocked";
    this.api = api;
    this.target = target;
  }
}

/**
 * Install the trap. Always call `restore()` (use try/finally).
 * @returns {{ calls: {api: string, target: string}[], restore: () => void, apis: string[] }}
 */
export function installOutboundTrap() {
  const calls = [];
  const saved = [];
  for (const [obj, key, api] of TARGETS) {
    if (!obj || !(key in obj)) continue;
    const desc = Object.getOwnPropertyDescriptor(obj, key);
    saved.push([obj, key, desc, api]);
    const blocked = function (...args) {
      const target = describeTarget(args);
      calls.push({ api, target });
      if (api === "fetch" || api === "dns.promises.lookup" || api === "dns.promises.resolve") {
        return Promise.reject(new OutboundBlocked(api, target));
      }
      throw new OutboundBlocked(api, target);
    };
    Object.defineProperty(obj, key, { value: blocked, writable: true, configurable: true, enumerable: desc?.enumerable ?? true });
  }
  // Named ESM imports of builtins (`import { request } from "node:https"`) only
  // see the patch after a sync.
  syncBuiltinESMExports();
  return {
    calls,
    apis: saved.map(([, , , api]) => api),
    restore() {
      for (const [obj, key, desc] of saved.reverse()) {
        if (desc) Object.defineProperty(obj, key, desc);
        else delete obj[key];
      }
      syncBuiltinESMExports();
    },
  };
}
