const fs = require("node:fs");
const block = (kind) =>
  function () {
    if (process.env.HARNESS_OFFLINE_NETWORK_LOG)
      fs.appendFileSync(process.env.HARNESS_OFFLINE_NETWORK_LOG, JSON.stringify({ kind }) + "\n");
    const error = new Error(`Offline built-in probe blocked ${kind}`);
    error.code = "ERR_OFFLINE_BUILTIN";
    throw error;
  };
for (const name of ["http", "https"]) {
  const api = require(`node:${name}`);
  api.request = block(`${name}.request`);
  api.get = block(`${name}.get`);
}
const net = require("node:net");
net.Socket.prototype.connect = block("net.Socket.connect");
net.connect = net.createConnection = block("net.connect");
require("node:tls").connect = block("tls.connect");
require("node:http2").connect = block("http2.connect");
for (const api of [require("node:dns"), require("node:dns/promises")]) {
  for (const key of Object.keys(api))
    if (key === "lookup" || key.startsWith("resolve") || key === "reverse")
      api[key] = block(`dns.${key}`);
}
const cp = require("node:child_process");
for (const key of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"])
  cp[key] = block(`child_process.${key}`);
globalThis.fetch = async () => block("fetch")();
globalThis.WebSocket = block("WebSocket");
require("node:module").syncBuiltinESMExports();
globalThis.__HARNESS_OFFLINE_PROBE__ = true;
