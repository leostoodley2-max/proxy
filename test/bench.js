// Page-load benchmark: proxies a local test site that looks like a heavy
// modern page (many scripts, stylesheets and images, long cache lifetimes)
// and reports how long it takes to load, first and on repeat visits.
//
//   node test/bench.js        (needs `playwright`, like test/smoke.js)
//
// Each test-site response is delayed by LATENCY ms to mimic a real network.

"use strict";

const http = require("node:http");
const { spawn } = require("node:child_process");
const path = require("node:path");
const { chromium } = require("playwright");

const LATENCY = Number(process.env.LATENCY || 80);
const SCRIPTS = 40, STYLES = 10, IMAGES = 20;
const PROXY_PORT = 19000 + Math.floor(Math.random() * 500);

function script(i) {
  let out = `window.__n = (window.__n || 0) + 1;\n`;
  for (let f = 0; f < 250; f++) {
    out += `function f${i}_${f}(a, b) { const s = "value ${i} ${f} " + a; ` +
      `return [s, b, location.href, document.title].map((x) => String(x).length).reduce((p, q) => p + q, ${f}); }\n`;
  }
  return out; // ~100 KB
}
const css = (i) => Array.from({ length: 400 }, (_, r) => `.c${i}-${r} { color: #${(r * 997 % 4096).toString(16).padStart(3, "0")}; margin: ${r % 9}px; background: url(/img/${r % IMAGES}.svg); }`).join("\n");
const svg = (i) => `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="#${(i * 4099 % 4096).toString(16).padStart(3, "0")}"/>${"<!-- padding -->".repeat(300)}</svg>`;
function page(name) {
  return `<!doctype html><html><head><title>${name}</title>
${Array.from({ length: STYLES }, (_, i) => `<link rel="stylesheet" href="/css/${i}.css">`).join("\n")}
${Array.from({ length: SCRIPTS }, (_, i) => `<script src="/js/${i}.js"></script>`).join("\n")}
</head><body><h1>${name}</h1>
${Array.from({ length: IMAGES }, (_, i) => `<img src="/img/${i}.svg">`).join("\n")}
<script>addEventListener("load", () => { window.__done = window.__n; });</script>
</body></html>`;
}

function startSite() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    let m, body, type;
    const cached = "public, max-age=31536000, immutable";
    if (url.pathname.startsWith("/page")) [body, type] = [page(url.pathname.slice(1)), "text/html"];
    else if ((m = /^\/js\/(\d+)\.js$/.exec(url.pathname))) [body, type] = [script(+m[1]), "text/javascript"];
    else if ((m = /^\/css\/(\d+)\.css$/.exec(url.pathname))) [body, type] = [css(+m[1]), "text/css"];
    else if ((m = /^\/img\/(\d+)\.svg$/.exec(url.pathname))) [body, type] = [svg(+m[1]), "image/svg+xml"];
    setTimeout(() => {
      if (!body) return res.writeHead(404).end();
      res.writeHead(200, { "Content-Type": type, "Cache-Control": type === "text/html" ? "no-cache" : cached });
      res.end(body);
    }, LATENCY);
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r(server)));
}

function startProxy() {
  const child = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    env: { ...process.env, PORT: String(PROXY_PORT), WARP: "off", ORBIT_TEST_ALLOW_LOOPBACK: "1" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  return new Promise((resolve) => child.stdout.on("data", (c) => String(c).includes("Proxy running") && resolve(child)));
}

async function timeLoad(page, url) {
  const start = Date.now();
  await page.fill("#address", url);
  await page.press("#address", "Enter");
  for (;;) {
    const frame = page.frames().find((f) => f.url().includes(encodeURIComponent(url)));
    if (frame) {
      const done = await frame.evaluate(() => window.__done).catch(() => undefined);
      if (done !== undefined) {
        if (done !== SCRIPTS) throw new Error("only " + done + " scripts ran");
        return Date.now() - start;
      }
    }
    if (Date.now() - start > 120000) throw new Error("timed out loading " + url);
    await page.waitForTimeout(20);
  }
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
  const site = await startSite();
  const proxy = await startProxy();
  const base = "http://127.0.0.1:" + site.address().port;
  const browser = signedIn(await chromium.launch());
  try {
    const context = await browser.newContext();
    let page = await context.newPage();
    await page.goto("http://localhost:" + PROXY_PORT + "/app");
    await page.waitForFunction(() => window.Engine && navigator.serviceWorker.controller);
    await page.evaluate(() => window.Engine.ready);
    const results = {};
    results["first visit"] = await timeLoad(page, base + "/page1");
    results["second page, same assets"] = await timeLoad(page, base + "/page2");
    // Reopen the app: the service worker restarts, but its caches remain.
    await page.close();
    page = await context.newPage();
    await page.goto("http://localhost:" + PROXY_PORT + "/app");
    await page.waitForFunction(() => window.Engine && navigator.serviceWorker.controller);
    await page.evaluate(() => window.Engine.ready);
    results["after reopening the app"] = await timeLoad(page, base + "/page3");
    for (const [name, ms] of Object.entries(results)) console.log(name.padEnd(28) + String(ms).padStart(6) + " ms");
  } finally {
    await browser.close();
    proxy.kill();
    site.close();
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
