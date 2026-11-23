// Compatibility check: runs a page of browser-feature tests (the things
// YouTube, TikTok and web games rely on) directly and through the proxy,
// and reports which ones break under the proxy.
//
//   node test/compat.js      (needs `playwright`, like test/smoke.js)
//
// Exits non-zero if a test that passes directly fails through the proxy.

"use strict";

const http = require("node:http");
const zlib = require("node:zlib");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { WebSocketServer } = require("ws");
const { chromium } = require("playwright");
const codec = require("../public/codec.js");

const PROXY_PORT = 19500 + Math.floor(Math.random() * 400);
const VIDEO = fs.readFileSync(path.join(__dirname, "fixtures", "clip.webm"));   // VP9, 6 s, no audio
const SOUND = fs.readFileSync(path.join(__dirname, "fixtures", "sound.webm"));  // Opus, 3 s
const BIG = Buffer.alloc(16 * 1024 * 1024, "proxy throughput test ");
const WASM = Buffer.from("0061736d0100000001070160027f7f017f030201000707010361646400000a09010700200020016a0b", "hex");
const beacons = [];
let wsPort;
function wsServer() {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  wss.on("connection", (ws) => ws.on("message", (m) => ws.send("echo:" + m)));
  return new Promise((r) => wss.on("listening", () => { wsPort = wss.address().port; r(wss); }));
}

// ---- The test page ---------------------------------------------------------
// Each test resolves to true or throws. `OTHER` is a second origin.
const PAGE = (other) => `<!doctype html><html><head><title>compat</title>
<script type="importmap">{"imports":{"lib":"/mod.js"}}</script></head>
<body><canvas id="c" width="64" height="64"></canvas>
<video id="v" muted playsinline width="160"></video>
<script>
const OTHER = ${JSON.stringify(other)};
const WS_PORT = ${wsPort};
const timeout = (ms, what) => new Promise((_, no) => setTimeout(() => no(new Error("timeout: " + what)), ms));
const eq = (a, b, what) => { if (a !== b) throw new Error(what + ": got " + JSON.stringify(a) + ", want " + JSON.stringify(b)); return true; };
const tests = {
  "fetch POST JSON body": async () => {
    const body = JSON.stringify({ hello: "world", n: 42 });
    const r = await fetch("/echo", { method: "POST", headers: { "Content-Type": "application/json" }, body });
    return eq(await r.text(), body, "echo");
  },
  "fetch POST binary body": async () => {
    const bytes = new Uint8Array(70000).map((_, i) => i % 251);
    const r = await fetch("/echo", { method: "POST", body: bytes });
    const back = new Uint8Array(await r.arrayBuffer());
    return eq(back.length + ":" + back[69999], bytes.length + ":" + bytes[69999], "echo");
  },
  "XHR POST form": () => new Promise((ok, no) => {
    const x = new XMLHttpRequest();
    x.open("POST", "/echo");
    x.onload = () => { try { ok(eq(x.responseText.includes("field=value"), true, "form echo")); } catch (e) { no(e); } };
    x.onerror = () => no(new Error("xhr error"));
    x.send(new URLSearchParams({ field: "value" }));
  }),
  "XHR arraybuffer, gzip encoded": () => new Promise((ok, no) => {
    const x = new XMLHttpRequest();
    x.open("GET", "/gzip-data");
    x.responseType = "arraybuffer";
    let progress = 0;
    x.onprogress = () => progress++;
    x.onload = () => { try { ok(eq(x.response.byteLength, 300000, "length")); } catch (e) { no(e); } };
    x.onerror = () => no(new Error("xhr error"));
    x.send();
  }),
  "fetch brotli encoded": async () => eq((await (await fetch("/br-data")).text()).length, 300000, "length"),
  "fetch Range request": async () => {
    const r = await fetch("/big", { headers: { Range: "bytes=10-19" } });
    return eq(r.status + ":" + (await r.arrayBuffer()).byteLength, "206:10", "range");
  },
  "WebAssembly.instantiateStreaming": async () => {
    const { instance } = await WebAssembly.instantiateStreaming(fetch("/add.wasm"));
    return eq(instance.exports.add(2, 3), 5, "add");
  },
  "Worker + importScripts + fetch": () => new Promise((ok, no) => {
    const w = new Worker("/worker.js");
    w.onmessage = (e) => { try { ok(eq(e.data, "lib:pong:echo-ok", "worker")); } catch (err) { no(err); } };
    w.onerror = (e) => no(new Error("worker error " + (e.message || "")));
    w.postMessage("ping");
  }),
  "module Worker": () => new Promise((ok, no) => {
    const w = new Worker("/mworker.js", { type: "module" });
    w.onmessage = (e) => { try { ok(eq(e.data, 7, "module worker")); } catch (err) { no(err); } };
    w.onerror = (e) => no(new Error("worker error " + (e.message || "")));
  }),
  "blob: Worker": () => new Promise((ok, no) => {
    const url = URL.createObjectURL(new Blob(["onmessage = (e) => postMessage(e.data * 2)"], { type: "text/javascript" }));
    const w = new Worker(url);
    w.onmessage = (e) => { try { ok(eq(e.data, 42, "blob worker")); } catch (err) { no(err); } };
    w.onerror = (e) => no(new Error("worker error " + (e.message || "")));
    w.postMessage(21);
  }),
  "dynamic import + import map": async () => eq((await import("lib")).seven, 7, "import"),
  "eval / new Function / toString": async () => {
    function sample(a) { return a + 1; }
    eq(eval("1 + 2"), 3, "eval");
    eq(new Function("a", "return a * 2")(4), 8, "Function");
    return eq(sample.toString(), "function sample(a) { return a + 1; }", "toString");
  },
  "WebGL2 context": async () => eq(!!document.getElementById("c").getContext("webgl2"), true, "webgl2"),
  "SharedArrayBuffer / crossOriginIsolated": async () => eq(typeof SharedArrayBuffer + ":" + crossOriginIsolated, "function:true", "isolation"),
  "WebSocket echo": () => new Promise((ok, no) => {
    const ws = new WebSocket("ws://127.0.0.1:" + WS_PORT + "/ws");
    ws.binaryType = "arraybuffer";
    ws.onopen = () => ws.send("hello");
    ws.onmessage = (e) => { try { ok(eq(e.data, "echo:hello", "ws")); } catch (err) { no(err); } ws.close(); };
    ws.onerror = () => no(new Error("ws error"));
  }),
  "cross-origin iframe postMessage": () => new Promise((ok, no) => {
    const f = document.createElement("iframe");
    f.src = OTHER + "/child";
    addEventListener("message", function on(e) {
      if (e.data !== "child-ready") return;
      removeEventListener("message", on);
      try { ok(eq(e.origin, OTHER, "origin")); } catch (err) { no(err); }
    });
    document.body.append(f);
  }),
  "game frame can use threads (isolated)": () => new Promise((ok, no) => {
    const f = document.createElement("iframe");
    f.src = OTHER + "/threads";
    addEventListener("message", function on(e) {
      if (typeof e.data !== "string" || !e.data.startsWith("threads:")) return;
      removeEventListener("message", on);
      try { ok(eq(e.data, "threads:true:function", "nested isolation")); } catch (err) { no(err); }
    });
    document.body.append(f);
  }),
  "XHR progress events (game loaders)": () => new Promise((ok, no) => {
    const x = new XMLHttpRequest();
    x.open("GET", "/big");
    x.responseType = "arraybuffer";
    let events = 0, total = 0;
    x.onprogress = (e) => { events++; if (e.lengthComputable) total = e.total; };
    x.onload = () => { try { eq(events > 1, true, "several progress events"); ok(eq(total, ${BIG.length}, "total size known")); } catch (e) { no(e); } };
    x.onerror = () => no(new Error("xhr error"));
    x.send();
  }),
  "fullscreen allowed": async () => eq(document.fullscreenEnabled, true, "fullscreenEnabled"),
  "game frame sees the real embedding site (sitelock)": () => new Promise((ok, no) => {
    const f = document.createElement("iframe");
    f.src = OTHER + "/sitelock";
    addEventListener("message", function on(e) {
      if (typeof e.data !== "string" || !e.data.startsWith("sitelock:")) return;
      removeEventListener("message", on);
      try { ok(eq(e.data, "sitelock:" + location.origin + "|" + location.origin + "/", "ancestorOrigins|referrer")); } catch (err) { no(err); }
    });
    document.body.append(f);
  }),
  "CORS fetch with credentials": async () => {
    const r = await fetch(OTHER + "/cors", { credentials: "include" });
    return eq(await r.text(), "cors-ok", "cors");
  },
  "cross-origin image to canvas (CORS)": () => new Promise((ok, no) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      const c = document.createElement("canvas");
      c.getContext("2d").drawImage(img, 0, 0);
      try { c.toDataURL(); ok(true); } catch (e) { no(e); }
    };
    img.onerror = () => no(new Error("image error"));
    img.src = OTHER + "/img.svg";
  }),
  "location / top look like the site": async () => {
    eq(location.hostname, "127.0.0.1", "location.hostname");
    eq(window.top === window, true, "top is this page");
    return eq(document.domain, "127.0.0.1", "document.domain");
  },
  "document.cookie": async () => {
    document.cookie = "game=save1; path=/";
    return eq(document.cookie.includes("game=save1"), true, "cookie");
  },
  "localStorage": async () => { localStorage.setItem("k", "v"); return eq(localStorage.getItem("k"), "v", "localStorage"); },
  "IndexedDB": () => new Promise((ok, no) => {
    const req = indexedDB.open("compat", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("s");
    req.onerror = () => no(req.error);
    req.onsuccess = () => {
      const tx = req.result.transaction("s", "readwrite");
      tx.objectStore("s").put("saved", "slot");
      tx.oncomplete = () => {
        const get = req.result.transaction("s").objectStore("s").get("slot");
        get.onsuccess = () => { try { ok(eq(get.result, "saved", "idb")); } catch (e) { no(e); } };
      };
    };
  }),
  "AudioContext decodeAudioData": async () => {
    const buf = await (await fetch("/sound.webm")).arrayBuffer();
    const ctx = new OfflineAudioContext(1, 48000, 48000);
    const audio = await ctx.decodeAudioData(buf);
    return eq(audio.duration > 1, true, "decoded");
  },
  "sendBeacon": async () => {
    const id = "beacon-" + Math.random().toString(36).slice(2);
    navigator.sendBeacon("/beacon", id);
    await new Promise((r) => setTimeout(r, 500));
    return eq((await (await fetch("/beacons")).text()).split(",").includes(id), true, "beacon received");
  },
  "<video src> plays (range requests)": async () => {
    const v = document.getElementById("v");
    v.src = "/clip.webm";
    await v.play();
    while (v.currentTime < 1) await new Promise((r) => setTimeout(r, 50));
    return true;
  },
  "MediaSource streaming (like YouTube)": async () => {
    const v = document.createElement("video");
    v.muted = true;
    document.body.append(v);
    const ms = new MediaSource();
    v.src = URL.createObjectURL(ms);
    await new Promise((r) => ms.addEventListener("sourceopen", r, { once: true }));
    const sb = ms.addSourceBuffer('video/webm; codecs="vp9"');
    // Fetch the clip in ranged chunks, as players do.
    let start = 0, total = Infinity;
    while (start < total) {
      const r = await fetch("/clip.webm", { headers: { Range: "bytes=" + start + "-" + (start + 39999) } });
      total = Number(r.headers.get("content-range").split("/")[1]);
      const chunk = await r.arrayBuffer();
      sb.appendBuffer(chunk);
      await new Promise((ok) => sb.addEventListener("updateend", ok, { once: true }));
      start += chunk.byteLength;
    }
    ms.endOfStream();
    await v.play();
    while (v.currentTime < 1) await new Promise((r) => setTimeout(r, 50));
    return true;
  },
  "download speed (16 MB)": async () => {
    const t = performance.now();
    const r = await fetch("/big");
    const reader = r.body.getReader();
    let n = 0;
    for (;;) { const { done, value } = await reader.read(); if (done) break; n += value.length; }
    const secs = (performance.now() - t) / 1000;
    eq(n, ${BIG.length}, "bytes");
    return (n / 1e6 / secs).toFixed(1) + " MB/s";
  },
};
(async () => {
  const results = {};
  for (const [name, test] of Object.entries(tests)) {
    window.__progress = name;
    try { results[name] = { ok: true, info: String(await Promise.race([test(), timeout(15000, name)])) }; }
    catch (e) { results[name] = { ok: false, info: String(e && e.message || e) }; }
  }
  window.__results = results;
})();
</script></body></html>`;

// ---- Test site servers -----------------------------------------------------
function site(otherOrigin) {
  const handle = (req, res) => {
    const url = new URL(req.url, "http://x");
    const send = (status, headers, body) => { res.writeHead(status, headers); res.end(body); };
    const js = { "Content-Type": "text/javascript" };
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      switch (url.pathname) {
        case "/page": return send(200, { "Content-Type": "text/html" }, PAGE(otherOrigin));
        case "/sitelock": return send(200, { "Content-Type": "text/html" }, "<script>parent.postMessage('sitelock:' + (location.ancestorOrigins ? location.ancestorOrigins[0] : 'none') + '|' + document.referrer.replace(/page$/, ''), '*')</script>");
        case "/threads": return send(200, { "Content-Type": "text/html" }, "<script>parent.postMessage('threads:' + crossOriginIsolated + ':' + typeof SharedArrayBuffer, '*')</script>");
        case "/child": return send(200, { "Content-Type": "text/html" }, "<script>parent.postMessage('child-ready', '*')</script>");
        case "/echo": return send(200, { "Content-Type": req.headers["content-type"] || "application/octet-stream" }, body);
        case "/beacon": beacons.push(body.toString()); return send(204, {});
        case "/beacons": return send(200, { "Content-Type": "text/plain" }, beacons.join(","));
        case "/gzip-data": return send(200, { "Content-Type": "application/octet-stream", "Content-Encoding": "gzip" }, zlib.gzipSync(Buffer.alloc(300000, "g")));
        case "/br-data": return send(200, { "Content-Type": "text/plain", "Content-Encoding": "br" }, zlib.brotliCompressSync(Buffer.alloc(300000, "b")));
        case "/sound.webm": return send(200, { "Content-Type": "audio/webm" }, SOUND);
        case "/add.wasm": return send(200, { "Content-Type": "application/wasm" }, WASM);
        case "/worker.js": return send(200, js, `importScripts("/lib.js"); onmessage = async (e) => { const r = await fetch("/echo", { method: "POST", body: "echo-ok" }); postMessage(LIB + ":" + (e.data === "ping" ? "pong" : "?") + ":" + await r.text()); };`);
        case "/lib.js": return send(200, js, `var LIB = "lib";`);
        case "/mworker.js": return send(200, js, `import { seven } from "/mod.js"; postMessage(seven);`);
        case "/mod.js": return send(200, js, `export const seven = 7;`);
        case "/cors": return send(200, { "Content-Type": "text/plain", "Access-Control-Allow-Origin": req.headers.origin || "*", "Access-Control-Allow-Credentials": "true" }, "cors-ok");
        case "/img.svg": return send(200, { "Content-Type": "image/svg+xml", "Access-Control-Allow-Origin": "*" }, `<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="red"/></svg>`);
        case "/big": case "/clip.webm": {
          const data = url.pathname === "/big" ? BIG : VIDEO;
          const type = url.pathname === "/big" ? "application/octet-stream" : "video/webm";
          let [start, end] = [0, data.length];
          const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range || "") || (url.searchParams.get("range") || "").match(/(\d+)-(\d*)/);
          if (range) [start, end] = [Number(range[1]), range[2] ? Math.min(data.length, Number(range[2]) + (req.headers.range ? 1 : 0)) : data.length];
          const headers = { "Content-Type": type, "Accept-Ranges": "bytes", "Content-Length": end - start };
          if (req.headers.range) headers["Content-Range"] = `bytes ${start}-${end - 1}/${data.length}`;
          res.writeHead(req.headers.range ? 206 : 200, headers);
          return res.end(req.method === "HEAD" ? undefined : data.subarray(start, end));
        }
        default: return send(404, {}, "");
      }
    });
  };
  // No "upgrade" listener here: the proxy's HTTP client offers
  // "Upgrade: h2c" on plain-HTTP requests, which Node then serves normally.
  // WebSockets get their own port (see wsServer).
  const server = http.createServer(handle);
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r(server)));
}

function startProxy() {
  const child = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    env: { ...process.env, PORT: String(PROXY_PORT), WARP: "off", ORBIT_TEST_ALLOW_LOOPBACK: "1" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  return new Promise((resolve) => child.stdout.on("data", (c) => String(c).includes("Proxy running") && resolve(child)));
}

async function results(frameOrPage) {
  for (let i = 0; i < 240; i++) {
    const r = await frameOrPage.evaluate(() => window.__results).catch(() => undefined);
    if (r) return r;
    await new Promise((ok) => setTimeout(ok, 250));
  }
  const progress = await frameOrPage.evaluate(() => [window.__progress, document.title, location.href]).catch((e) => "unreachable: " + e.message);
  throw new Error("test page never finished: " + JSON.stringify(progress));
}


// The proxy browser (/app) is behind the front page's sign-in; start signed in.
function signedIn(browser) {
  const newContext = browser.newContext.bind(browser);
  browser.newContext = async (options) => {
    const context = await newContext(options);
    await context.addInitScript(() => {
      try { if (window === window.top) localStorage.setItem("orbit.unlocked", "1"); } catch (e) {}
    });
    return context;
  };
  return browser;
}

(async () => {
  const wss = await wsServer();
  const other = await site("");
  const main = await site("http://127.0.0.1:" + other.address().port);
  const pageUrl = "http://127.0.0.1:" + main.address().port + "/page";
  const proxy = await startProxy();
  const browser = signedIn(await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] }));
  let regressions = 0;
  try {
    // Direct (control): served cross-origin isolated like the proxy would be.
    const direct = await (await browser.newContext()).newPage();
    await direct.route("**/*", async (route) => {
      const response = await route.fetch();
      await route.fulfill({ response, headers: { ...response.headers(), "cross-origin-opener-policy": "same-origin", "cross-origin-embedder-policy": "require-corp", "cross-origin-resource-policy": "cross-origin" } });
    });
    await direct.goto(pageUrl);
    const want = await results(direct);

    const page = await (await browser.newContext()).newPage();
    page.on("console", (m) => { if (m.type() === "error") console.log("[page error]", m.text().slice(0, 300)); });
    page.on("pageerror", (e) => console.log("[page exception]", e.message.slice(0, 300)));
    await page.goto("http://localhost:" + PROXY_PORT + "/app");
    await page.waitForFunction(() => window.Engine && navigator.serviceWorker.controller);
    await page.fill("#address", pageUrl);
    await page.press("#address", "Enter");
    let frame;
    while (!(frame = page.frames().find((f) => f.url().includes(codec.encode(pageUrl))))) await page.waitForTimeout(100);
    const got = await results(frame);

    for (const name of Object.keys(want)) {
      const d = want[name], p = got[name] || { ok: false, info: "missing" };
      const mark = p.ok ? "ok  " : d.ok ? "FAIL" : "n/a ";
      if (!p.ok && d.ok) regressions++;
      console.log(mark + " " + name.padEnd(40) + (p.ok ? (p.info === "true" ? "" : p.info) : p.info) +
        (d.ok ? (d.info !== "true" && p.ok ? "   (direct: " + d.info + ")" : "") : "   (fails directly too: " + d.info + ")"));
    }
  } finally {
    await browser.close();
    proxy.kill();
    main.close();
    other.close();
    wss.close();
  }
  console.log(regressions ? regressions + " broken by the proxy" : "nothing broken by the proxy");
  process.exit(regressions ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
