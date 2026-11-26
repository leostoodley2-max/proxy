// TEST ONLY (enabled by ORBIT_TEST_SERVER_FETCH=1): lets the proxy reach real
// sites from a sandbox whose network re-encrypts HTTPS with its own CA, which
// the in-browser libcurl transport can't trust. The browser uses the tiny
// bare-mux transport below; the server makes each request with curl, which
// uses the sandbox's proxy and CA. Never enable this on a real deployment.
"use strict";

const { spawn } = require("node:child_process");

const TRANSPORT = `
export default class ServerFetchTransport {
  constructor() { this.ready = true; }
  async init() { this.ready = true; }
  async meta() {}
  async request(remote, method, body, headers, signal) {
    const payload = body ? new Uint8Array(await new Response(body).arrayBuffer()) : undefined;
    const res = await fetch("/__test/fetch", {
      method: "POST", signal, body: payload,
      headers: { "x-url": remote.href, "x-method": method, "x-headers": encodeURIComponent(JSON.stringify(headers)) },
    });
    if (res.status === 599) throw new TypeError("server fetch failed: " + await res.text());
    const meta = JSON.parse(decodeURIComponent(res.headers.get("x-meta")));
    return { body: res.body, headers: meta.headers, status: meta.status, statusText: meta.statusText };
  }
  connect(url, protocols, requestHeaders, onopen, onmessage, onclose, onerror) {
    onerror("WebSockets are not supported by the test transport");
    return [() => {}, () => {}];
  }
}
`;

const DROP_REQUEST = new Set(["host", "connection", "content-length", "accept-encoding", "transfer-encoding", "keep-alive", "upgrade", "te"]);
const DROP_RESPONSE = new Set(["content-encoding", "content-length", "transfer-encoding", "connection", "keep-alive"]);

// Bytes received from sites (as sent on the wire, before decompression), by host.
const downloaded = new Map();

module.exports = function install(app) {
  console.warn("[test] server-side fetch transport ENABLED (test only)");
  app.get("/__test/bytes", (req, res) => {
    res.json(Object.fromEntries(downloaded));
  });
  app.get("/__test/transport.mjs", (req, res) => res.type("text/javascript").send(TRANSPORT));
  app.post("/__test/fetch", (req, res) => {
    const url = req.get("x-url"), method = req.get("x-method") || "GET";
    let headers = {};
    try { headers = JSON.parse(decodeURIComponent(req.get("x-headers") || "%7B%7D")); } catch {}
    const args = ["-sS", "--compressed", "--suppress-connect-headers", "-D", "-", "-o", "-", "-X", method, "--max-time", "60", "-w", "%{stderr}\n@@bytes=%{size_download}+%{size_header}@@"];
    for (const [name, value] of Object.entries(headers)) {
      if (DROP_REQUEST.has(name.toLowerCase())) continue;
      for (const v of [].concat(value)) args.push("-H", name + ": " + v);
    }
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      if (body.length) args.push("--data-binary", "@-");
      args.push(url);
      const curl = spawn("curl", args, { stdio: ["pipe", "pipe", "pipe"] });
      curl.stdin.end(body.length ? body : undefined);
      let buffer = Buffer.alloc(0), started = false, errors = "";
      curl.stderr.on("data", (d) => { errors += d; });
      curl.stdout.on("data", (data) => {
        if (started) return res.write(data);
        buffer = Buffer.concat([buffer, data]);
        for (;;) {
          const end = buffer.indexOf("\r\n\r\n");
          if (end < 0) return;
          const lines = buffer.subarray(0, end).toString("latin1").split("\r\n");
          buffer = buffer.subarray(end + 4);
          const [, code, ...text] = lines[0].split(" ");
          if (/^1\d\d$/.test(code)) continue; // 100 Continue etc.
          const out = {};
          for (const line of lines.slice(1)) {
            const i = line.indexOf(":");
            const name = line.slice(0, i).trim().toLowerCase(), value = line.slice(i + 1).trim();
            if (!name || DROP_RESPONSE.has(name)) continue;
            out[name] = name in out ? [].concat(out[name], value) : value;
          }
          started = true;
          res.writeHead(200, { "x-meta": encodeURIComponent(JSON.stringify({ status: Number(code), statusText: text.join(" "), headers: out })), "Cache-Control": "no-store" });
          if (buffer.length) res.write(buffer);
          return;
        }
      });
      curl.on("close", (code) => {
        const m = /@@bytes=(\d+)\+(\d+)@@/.exec(errors);
        if (m) {
          const host = new URL(url).hostname;
          downloaded.set(host, (downloaded.get(host) || 0) + Number(m[1]) + Number(m[2]));
          errors = errors.replace(m[0], "").trim();
        }
        if (!started) return res.status(599).type("text").send(errors || "curl exited " + code);
        res.end();
      });
      res.on("close", () => curl.kill());
    });
  });
};
