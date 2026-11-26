// Debugging aid: opens a real site through the proxy and reports what goes
// wrong (page errors, service worker errors, failed requests, frames), then
// saves a screenshot. For sandboxes, it can use the test-only server-side
// transport (test/support/server-fetch.js) instead of libcurl.
//
//   node test/realsite.js <url> [seconds=40] [screenshot.png]
//   SERVER_FETCH=0 node test/realsite.js ...   (use the real libcurl transport)

"use strict";

const { spawn } = require("node:child_process");
const path = require("node:path");
const { chromium } = require("playwright");
const accounts = require("./support/accounts.js");
const codec = require("../public/codec.js");

const [url, seconds = "40", shot = "realsite.png"] = process.argv.slice(2);
const PORT = 19700 + Math.floor(Math.random() * 200);
const serverFetch = process.env.SERVER_FETCH !== "0";

(async () => {
  const server = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    env: { ...process.env, PORT: String(PORT), WARP: "off", ORBIT_TEST_SERVER_FETCH: serverFetch ? "1" : "0", ...accounts.serverEnv() },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stderr.on("data", (d) => process.stderr.write("[server] " + d));
  await new Promise((r) => server.stdout.on("data", (d) => String(d).includes("running") && r()));

  const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required", "--enable-unsafe-swiftshader"] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  if (process.env.SAVER_OFF) await context.addInitScript(() => { try { if (window === window.top) localStorage.setItem("orbit.dataSaver", "0"); } catch (e) {} });
  await context.addInitScript((test) => {
    if (test) window.__orbitTestTransport = "/__test/transport.mjs";
  }, serverFetch);
  if (process.env.LOG_MESSAGES) {
    await context.addInitScript((max) => {
      addEventListener("message", (e) => {
        let d = e.data;
        try { d = typeof d === "string" ? d : JSON.stringify(d); } catch (x) { d = String(d); }
        if (d && d.length < 20000) console.warn("MSG to " + document.title + " from " + e.origin + ": " + d.slice(0, max));
      }, true);
    }, process.env.LOG_MESSAGES === "long" ? 8000 : 160);
  }
  const { cookie } = await accounts.createAccount("http://localhost:" + PORT);
  await context.addCookies([{ name: "orbit_session", value: cookie, url: "http://localhost:" + PORT }]);
  const seen = new Set();
  const log = (kind, text) => {
    const key = kind + text.slice(0, 200);
    if (seen.has(key)) return;
    seen.add(key);
    console.log(kind.padEnd(10) + text.slice(0, process.env.LOG_MESSAGES === "long" ? 9000 : 500).replace(/\s+/g, " "));
  };
  const real = (u) => {
    try {
      const p = new URL(u);
      return p.pathname.startsWith(codec.prefix) ? codec.decode(p.pathname.slice(codec.prefix.length) + p.search) : u;
    } catch { return u; }
  };
  context.on("console", (m) => { if (["error", "warning"].includes(m.type())) log("console", m.text()); });
  context.on("weberror", (e) => log("EXCEPTION", e.error().message + " " + (e.error().stack || "").split("\n")[1]));
  context.on("requestfailed", (r) => log("REQFAIL", real(r.url()) + " " + (r.failure() && r.failure().errorText)));
  context.on("response", (r) => { if (r.status() >= 400 && r.url().includes(codec.prefix)) log("HTTP " + r.status(), real(r.url())); });

  if (process.env.LIST_REQ) context.on("request", (r) => {
    const u = new URL(r.url());
    if (!u.pathname.startsWith(codec.prefix)) return;
    const realUrl = codec.decode(u.pathname.slice(codec.prefix.length));
    if (new RegExp(process.env.LIST_REQ).test(realUrl)) console.log("REQ       " + r.resourceType().padEnd(8) + " real=" + realUrl.slice(0, 100) + "  proxied-query=" + u.search);
  });
  if (process.env.LOG_POST) context.on("request", (r) => {
    const u = new URL(r.url());
    if (!u.pathname.startsWith(codec.prefix)) return;
    const realUrl = codec.decode(u.pathname.slice(codec.prefix.length));
    if (!new RegExp(process.env.LOG_POST).test(realUrl)) return;
    console.log("POST      " + realUrl.slice(0, 90) + " body=" + String(r.postData() || "").slice(0, 900));
  });
  const page = await context.newPage();
  if (process.env.CDP_INIT) {
    const cdp = await context.newCDPSession(page);
    await cdp.send("Network.enable");
    cdp.on("Network.requestWillBeSent", (e) => {
      const u = new URL(e.request.url);
      if (!u.pathname.startsWith(codec.prefix)) return;
      const realUrl = codec.decode(u.pathname.slice(codec.prefix.length));
      if (!new RegExp(process.env.CDP_INIT).test(realUrl)) return;
      const i = e.initiator || {};
      const frames = (i.stack && i.stack.callFrames || []).slice(0, 4).map((f) => real(f.url).replace(/^.*\//, "") + ":" + f.lineNumber + ":" + f.columnNumber + " " + f.functionName);
      console.log("INIT      " + realUrl.replace(/^.*gameframe/, "") + u.search + " <- " + i.type + " " + (i.url ? real(i.url).slice(0, 90) : "") + " " + frames.join(" < "));
    });
  }
  if (process.env.CDP_NET) {
    const cdp = await context.newCDPSession(page);
    await cdp.send("Network.enable");
    const reqs = {};
    cdp.on("Network.requestWillBeSent", (e) => { reqs[e.requestId] = e; });
    cdp.on("Network.loadingFailed", (e) => {
      const r = reqs[e.requestId];
      if (!r || !new RegExp(process.env.CDP_NET).test(real(r.request.url))) return;
      if (process.env.CDP_RAW) console.log("RAWURL    " + r.request.url);
      console.log("NETFAIL   " + real(r.request.url).slice(0, 90) + " type=" + e.type + " error=" + e.errorText +
        " blocked=" + e.blockedReason + " cors=" + JSON.stringify(e.corsErrorStatus) + " initiator=" + (r.initiator && (r.initiator.url ? real(r.initiator.url).slice(0, 80) : r.initiator.type)) +
        " mode/dest=" + (r.request.headers && r.request.headers["Sec-Fetch-Mode"]));
    });
  }
  await page.goto("http://localhost:" + PORT + "/app");
  await page.waitForFunction(() => window.Engine && navigator.serviceWorker.controller);
  await page.evaluate(() => window.Engine.ready);
  await page.fill("#address", url);
  await page.press("#address", "Enter");
  await page.waitForTimeout(Number(seconds) * 1000);
  // STEPS='[["fill","https://accounts.google.com","input[type=email]","x@example.com"],["click",...],["wait",5]]'
  for (const [action, framePrefix, selector, value] of JSON.parse(process.env.STEPS || "[]")) {
    if (action === "wait") { await page.waitForTimeout(Number(framePrefix) * 1000); continue; }
    if (action === "nav") { // type an address into the proxy's address bar
      await page.fill("#address", framePrefix);
      await page.press("#address", "Enter");
      console.log("STEP      nav " + framePrefix);
      continue;
    }
    const frame = page.frames().find((f) => real(f.url()).startsWith(framePrefix));
    if (!frame) { console.log("STEP      no frame " + framePrefix); continue; }
    try {
      if (action === "fill") await frame.fill(selector, value, { timeout: 10000 });
      if (action === "click") await frame.click(selector, { timeout: 10000 });
      if (action === "press") await frame.press(selector, value, { timeout: 10000 });
      console.log("STEP      " + action + " " + selector + " ok");
    } catch (e) { console.log("STEP      " + action + " " + selector + " failed: " + e.message.split("\n")[0]); }
  }
  for (const f of page.frames()) {
    let info = "";
    try { info = await f.evaluate(() => document.title + " | " + (document.body ? document.body.innerText.slice(0, 150) : "")); } catch (e) { info = "(" + e.message.slice(0, 60) + ")"; }
    console.log("FRAME     " + real(f.url()).slice(0, 120) + " => " + info.replace(/\s+/g, " ").slice(0, 200));
  }
  if (process.env.EVAL) {
    const target = page.frames().find((f) => real(f.url()).startsWith(process.env.EVAL_FRAME || "zzz")) || page.frames().at(-1);
    console.log("EVAL      " + await target.evaluate(process.env.EVAL).catch((e) => "threw " + e.message));
  }
  if (serverFetch && process.env.BYTES) {
    const bytes = await (await fetch("http://localhost:" + PORT + "/__test/bytes")).json();
    const total = Object.values(bytes).reduce((a, b) => a + b, 0);
    for (const [host, n] of Object.entries(bytes).sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log("BYTES     " + (n / 1e6).toFixed(2).padStart(7) + " MB  " + host);
    console.log("BYTES     " + (total / 1e6).toFixed(2).padStart(7) + " MB  TOTAL downloaded from sites");
  }
  await page.screenshot({ path: shot });
  console.log("screenshot: " + shot);
  await browser.close();
  server.kill();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
