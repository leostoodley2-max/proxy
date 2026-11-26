const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const https = require("node:https");
const tls = require("node:tls");
const { generateKeyPairSync, randomUUID } = require("node:crypto");
const { spawn } = require("node:child_process");
const { setTimeout: delay } = require("node:timers/promises");
const { connectSocks } = require("./wisp-socks");

const cache = path.join(__dirname, ".warp.json");
const direct = Object.freeze({ warp: false, ip: null, colo: null });
let egress = direct;
let activeRoute = null;
let stop = () => {};

function validate(config) {
  const key = /^[A-Za-z0-9+/]{43}=$/;
  if (!key.test(config?.privateKey) || !key.test(config?.peerPublicKey)) {
    throw new Error("Invalid WireGuard key in configuration");
  }
  const address = {};
  for (const [field, family, prefix] of [["v4", 4, 32], ["v6", 6, 128]]) {
    const value = config.address?.[field];
    if (value == null || value === "") continue;
    const ip = value.replace(new RegExp("/" + prefix + "$"), "");
    if (net.isIP(ip) !== family || ip.includes("%")) throw new Error("Invalid WARP " + field + " address");
    address[field] = ip;
  }
  if (!address.v4 && !address.v6) throw new Error("Missing WARP interface addresses");
  let endpoint = config.endpoint || "engage.cloudflareclient.com:2408";
  if (/^[a-z0-9.-]+$/i.test(endpoint)) endpoint += ":2408";
  const match = /^([a-z0-9.-]+|\[[a-f0-9:]+\]):(\d{1,5})$/i.exec(endpoint);
  if (!match || !Number(match[2]) || Number(match[2]) > 65535) throw new Error("Invalid WARP endpoint");
  return { privateKey: config.privateKey, address, peerPublicKey: config.peerPublicKey, endpoint };
}

function parseConfig(json) {
  let data;
  try { data = JSON.parse(json); }
  catch { throw new Error("WARP credentials contain invalid JSON"); }
  return validate(data);
}

async function credentials(log, signal) {
  if (process.env.WARP_CONFIG !== undefined) return parseConfig(process.env.WARP_CONFIG);
  try { return parseConfig(fs.readFileSync(cache, "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }

  const { privateKey, publicKey } = generateKeyPairSync("x25519");
  const base64 = value => Buffer.from(value, "base64url").toString("base64");
  const url = "https://api.cloudflareclient.com/v0a5641/reg";
  const headers = {
    "CF-Client-Version": "a-6.38.9-5641",
    "User-Agent": "1.1.1.1/6.38.9-5641 (Android 16.0.0)",
    "Content-Type": "application/json; charset=UTF-8",
  };
  const response = await fetch(url, {
    method: "POST", headers, signal, redirect: "error",
    body: JSON.stringify({
      install_id: "", fcm_token: "", serial_number: "", tos: new Date().toISOString(),
      key: base64(publicKey.export({ format: "jwk" }).x), type: "Android", model: "PC",
      locale: "en_US", os_version: "16.0.0", key_type: "curve25519",
      tunnel_type: "wireguard", warp_enabled: true,
    }),
  });
  if (!response.ok) throw new Error("WARP registration returned HTTP " + response.status);
  let device;
  try { device = await response.json(); }
  catch { throw new Error("Invalid registration response"); }
  if (device.warp_enabled === false) {
    if (!device.id || !device.token) throw new Error("Missing WARP activation credentials");
    const activation = await fetch(url + "/" + encodeURIComponent(device.id), {
      method: "PATCH", signal, redirect: "error",
      headers: { ...headers, Authorization: "Bearer " + device.token },
      body: JSON.stringify({ warp_enabled: true }),
    });
    if (!activation.ok) throw new Error("WARP activation returned HTTP " + activation.status);
    await activation.body?.cancel();
  }
  const peer = device.config?.peers?.[0];
  const config = validate({
    privateKey: base64(privateKey.export({ format: "jwk" }).d),
    address: device.config?.interface?.addresses, peerPublicKey: peer?.public_key,
    endpoint: peer?.endpoint?.host || peer?.endpoint?.v4 || peer?.endpoint?.v6,
  });
  const staging = cache + "." + randomUUID() + ".tmp";
  try {
    fs.writeFileSync(staging, JSON.stringify(config), { mode: 0o600, flag: "wx" });
    fs.renameSync(staging, cache);
    log.info("[warp] Registered device. Use the contents of .warp.json as the WARP_CONFIG secret.");
  } catch (error) {
    log.warn("[warp] Could not cache registration (" + error.code + "). Using it for this process.");
  } finally {
    fs.rmSync(staging, { force: true });
  }
  return config;
}

function splitEndpoint(endpoint) {
  const match = /^(\[[a-f0-9:]+\]|[^:]+):(\d{1,5})$/i.exec(endpoint);
  return match ? { host: match[1], port: Number(match[2]) } : { host: endpoint, port: 2408 };
}

function wireConfig(config, port, endpoint = config.endpoint) {
  const addresses = [config.address.v4 && config.address.v4 + "/32",
    config.address.v6 && config.address.v6 + "/128"].filter(Boolean);
  return [
    "[Interface]", "PrivateKey = " + config.privateKey, "Address = " + addresses.join(", "),
    "DNS = 1.1.1.1", "", "[Peer]", "PublicKey = " + config.peerPublicKey,
    "Endpoint = " + endpoint, "AllowedIPs = 0.0.0.0/0, ::/0", "PersistentKeepalive = 25",
    "", "[Socks5]", "BindAddress = 127.0.0.1:" + port, "",
  ].join("\n");
}

function launch(binary, file) {
  const args = ["-s", "-c", file];
  try {
    return spawn(binary, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
  } catch (error) {
    // Some Windows job environments prohibit creating a child stderr pipe.
    if (process.platform !== "win32" || error.code !== "EPERM") throw error;
    return spawn(binary, args, { stdio: "ignore", windowsHide: true });
  }
}

async function verify(route, signal) {
  // Retry only a local refusal while the child is bringing up its listener.
  const host = "www.cloudflare.com";
  let socket;
  while (!socket) {
    try { socket = await connectSocks(route, host, 443, signal); }
    catch (error) {
      if (error.code !== "ECONNREFUSED") throw error;
      await delay(150, undefined, { signal });
    }
  }
  const agent = new https.Agent();
  agent.createConnection = () => tls.connect({ socket, servername: host });
  try {
    const body = await new Promise((resolve, reject) => {
      const req = https.get({ hostname: host, path: "/cdn-cgi/trace", agent, signal }, res => {
        if (res.statusCode !== 200) return req.destroy(new Error("Trace returned HTTP " + res.statusCode));
        let body = "";
        res.setEncoding("utf8").on("data", chunk => {
          body += chunk;
          if (body.length > 16384) req.destroy(new Error("Oversized trace response"));
        }).on("end", () => resolve(body)).on("error", reject);
      });
      req.on("error", reject);
    });
    const fields = new URLSearchParams(body.trim().split(/\r?\n/).join("&"));
    const ip = fields.get("ip"), colo = fields.get("colo"), status = fields.get("warp");
    if (!["on", "plus"].includes(status) || !net.isIP(ip) || !/^[A-Z]{3}$/.test(colo)) {
      throw new Error("Cloudflare trace did not confirm WARP egress");
    }
    return { status, ip, colo };
  } finally {
    agent.destroy();
    socket.destroy();
  }
}

async function startWarp({ log = console } = {}) {
  if (process.env.WARP?.toLowerCase() === "off") return null;
  const lifetime = new AbortController();
  const binary = process.env.WIREPROXY_PATH || path.join(__dirname, "bin",
    process.platform === "win32" ? "wireproxy.exe" : "wireproxy");
  const route = { socksHost: "127.0.0.1", socksPort: Number(process.env.WARP_SOCKS_PORT || 40000) };
  let dir, child;
  function deactivate() { activeRoute = null; egress = direct; }
  function cleanup() {
    lifetime.abort();
    deactivate();
    child?.kill();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    process.off("exit", cleanup);
  }
  stop = cleanup;
  process.once("exit", cleanup);
  try {
    fs.accessSync(binary, fs.constants.X_OK);
    if (!Number.isInteger(route.socksPort) || route.socksPort < 1 || route.socksPort > 65535) {
      throw new Error("Invalid WARP_SOCKS_PORT");
    }
    const config = await credentials(log, AbortSignal.any([lifetime.signal, AbortSignal.timeout(10_000)]));
    lifetime.signal.throwIfAborted();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "wisp-warp-"));
    const file = path.join(dir, "wireproxy.conf");
    // Cloudflare WARP accepts the WireGuard handshake on several UDP ports. If
    // the network blocks the default (2408) we try the alternatives in turn,
    // rewriting the wireproxy config for each attempt.
    const { host: warpHost, port: warpPort } = splitEndpoint(config.endpoint);
    const portsEnv = (process.env.WARP_ENDPOINT_PORTS || "").split(",").map(Number).filter(Boolean);
    const ports = [...new Set([warpPort, ...(portsEnv.length ? portsEnv : [2408, 500, 1701, 4500])])];
    // The hostname can resolve to IPv6, which some hosts (e.g. Fly.io) won't
    // route for UDP; Cloudflare's WARP IPv4 anycast addresses work there.
    const hostsEnv = (process.env.WARP_ENDPOINT_HOSTS || "").split(",").map((h) => h.trim()).filter(Boolean);
    const hosts = [...new Set([...(hostsEnv.length ? hostsEnv : []), warpHost, "162.159.192.1", "162.159.193.10"])];
    const endpoints = hosts.flatMap((h) => ports.map((p) => h + ":" + p));
    let firstResult;
    const ready = new Promise(resolve => { firstResult = resolve; });
    async function supervise() {
      let verifiedOnce = false;
      let attempt = 0;        // which candidate port to try before the first success
      let activePort = endpoints[0];
      let backoff = 500;
      while (!lifetime.signal.aborted) {
        if (!verifiedOnce) activePort = endpoints[attempt % endpoints.length];
        fs.writeFileSync(file, wireConfig(config, route.socksPort, activePort), { mode: 0o600 });
        const exited = new AbortController();
        child = launch(binary, file);
        // Surface recognizable OS diagnostics on failure. Raw child output
        // can contain configuration values and must never enter service logs.
        let diagnostic = "";
        child.stderr?.setEncoding("utf8").on("data", chunk => {
          const match = /address already in use|permission denied|network is unreachable|no such host|access is denied/i.exec(chunk);
          if (match) diagnostic = " (" + match[0] + ")";
        });
        const done = new Promise(resolve => {
          child.once("error", error => exited.abort(error));
          child.once("close", (code, signal) => {
            deactivate();
            exited.abort(new Error("wireproxy exited (" + (signal || code) + ")"));
            resolve();
          });
        });
        try {
          const signal = AbortSignal.any([lifetime.signal, exited.signal, AbortSignal.timeout(15_000)]);
          const result = await verify(route, signal);
          signal.throwIfAborted();
          egress = { warp: true, ip: result.ip, colo: result.colo };
          activeRoute = route;
          verifiedOnce = true;
          log.info("[warp] Verified ip=" + result.ip + " colo=" + result.colo + " warp=" + result.status + " endpoint=" + activePort);
          firstResult(route);
          await done;
          throw exited.signal.reason;
        } catch (error) {
          deactivate();
          if (!lifetime.signal.aborted) {
            log.warn("[warp] endpoint " + activePort + " failed: " + (exited.signal.reason || error).message + diagnostic + ". Using direct egress.");
          }
          child.kill();
          await done;
          child = null;
          if (!verifiedOnce) {
            attempt++;
            // After every candidate failed once, carry on with direct egress
            // but keep retrying in the background (once a minute).
            if (attempt === endpoints.length) firstResult(null);
            if (attempt >= endpoints.length) {
              await delay(60_000, undefined, { signal: lifetime.signal }).catch(() => {});
              continue;
            }
          }
        }
        await delay(backoff, undefined, { signal: lifetime.signal });
        backoff = Math.min(5000, backoff * 2);
      }
    }
    supervise().catch(error => {
      if (!lifetime.signal.aborted) log.warn("[warp] " + error.message + ". Using direct egress.");
      cleanup();
      firstResult(null);
    });
    return await ready;
  } catch (error) {
    cleanup();
    log.warn("[warp] " + error.message + ". Using direct egress.");
    return null;
  }
}

module.exports = {
  startWarp, stopWarp: () => stop(), getRoute: () => activeRoute, getEgress: () => egress,
};
