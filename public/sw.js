// Service worker: every request made by a proxied page passes through here.
importScripts("/scram/scramjet.all.js?v=2", "/codec.js");

const { ScramjetServiceWorker } = $scramjetLoadWorker();
const scramjet = new ScramjetServiceWorker();

// --- Recent failures, for /diagnostics.html ---------------------------------
// Kept in Cache Storage too, because the browser stops idle service workers
// after ~30 s and the user runs diagnostics after something went wrong.
const ERROR_LOG = "/__orbit/errors.json";
let recentErrors = null;
async function loadErrors() {
  if (recentErrors) return recentErrors;
  try {
    const saved = await (await caches.open("orbit-diagnostics")).match(ERROR_LOG);
    recentErrors = saved ? await saved.json() : [];
  } catch (e) {
    recentErrors = [];
  }
  return recentErrors;
}
async function logError(entry) {
  const list = await loadErrors();
  list.push({ time: new Date().toISOString(), ...entry });
  while (list.length > 30) list.shift();
  try {
    await (await caches.open("orbit-diagnostics")).put(ERROR_LOG, new Response(JSON.stringify(list)));
  } catch (e) {}
}
function realUrl(proxied) {
  try {
    const url = new URL(proxied);
    return url.pathname.startsWith(OrbitCodec.prefix) ? OrbitCodec.decode(url.pathname.slice(OrbitCodec.prefix.length)) : proxied;
  } catch (e) {
    return String(proxied);
  }
}
// Scramjet reports failed requests with console.error("ERROR FROM SERVICE WORKER FETCH: ", details).
const consoleError = console.error.bind(console);
console.error = (...args) => {
  try {
    if (typeof args[0] === "string" && args[0].startsWith("ERROR FROM SERVICE WORKER FETCH") && args[1]) {
      const details = args[1];
      logError({ url: realUrl(details.url), type: details.destination || "fetch", error: String(details.message).slice(0, 300) });
    }
  } catch (e) {}
  consoleError(...args);
};
self.addEventListener("message", (event) => {
  if (!event.data || event.data.type !== "orbit-diagnostics") return;
  event.waitUntil(loadErrors().then((errors) => event.source && event.source.postMessage({ type: "orbit-diagnostics", errors })));
});

// Retry requests that fail in transit (dropped tunnel, connection reset, TLS
// hiccup on the way out through WARP) instead of showing Scramjet's error
// page. Only for requests that are safe to repeat: GET/HEAD without a body.
// HTTP error statuses from the site are real answers and are not retried.
const RETRY_DELAYS = [250, 1000];
const clientFetch = scramjet.client.fetch.bind(scramjet.client);
scramjet.client.fetch = async (url, init = {}) => {
  const method = String(init.method || "GET").toUpperCase();
  const repeatable = (method === "GET" || method === "HEAD") && init.body == null;
  for (let attempt = 0; ; attempt++) {
    try {
      return await clientFetch(url, init);
    } catch (error) {
      if (!repeatable || attempt >= RETRY_DELAYS.length || (init.signal && init.signal.aborted)) throw error;
      console.warn("[orbit] retrying " + url + " after: " + (error && error.message));
      logError({ url: String(url), type: "retried", error: String(error && error.message).slice(0, 300) });
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS[attempt]));
    }
  }
};

// Scramjet holds a response until the page acknowledges a cookie message
// (see scripts/patch-scramjet.js). Never let a missing reply stall a page:
// the worker has already stored the cookie, so stop waiting after a moment.
const dispatch = scramjet.dispatch.bind(scramjet);
scramjet.dispatch = (client, message) => Promise.race([
  dispatch(client, message),
  new Promise((resolve) => setTimeout(resolve, 3000)),
]);

// Take control straight away after an update instead of waiting for every
// tab to close.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil((async () => {
  await self.clients.claim();
  // Drop asset caches from older versions (their rewritten code may differ).
  for (const name of await caches.keys()) {
    if (name.startsWith("orbit-assets-") && name !== ASSET_CACHE) await caches.delete(name);
  }
})()));

// --- Asset cache ------------------------------------------------------------
// Proxied requests bypass the browser's HTTP cache, so without this every
// script, stylesheet, font, image and game data file is downloaded through
// the tunnel (and rewritten) again on every page load. Cache the finished
// response for as long as the site itself allows, following the same rules
// as the browser's own cache. Bump the version whenever Scramjet or its
// settings change, since that changes the rewritten output.
const ASSET_CACHE = "orbit-assets-v2"; // v2: disguised addresses (codec.js)
// "" is fetch()/XMLHttpRequest: game engines (Unity, Godot...) load their
// large .wasm/.data files that way.
const CACHEABLE = new Set(["script", "style", "font", "image", "worker", "sharedworker", ""]);
const MAX_BYTES = 200 * 1024 * 1024;
const MIN_AGE = 60;                 // seconds; shorter-lived responses aren't worth it
const MAX_AGE = 30 * 24 * 3600;     // seconds
const MAX_ENTRIES = 3000;
const EXPIRES = "x-orbit-expires";  // internal header, never shown to pages
let stores = 0;

// Decide from the site's real (upstream) response whether the rewritten
// response may be cached, and mark it for the fetch handler below.
scramjet.addEventListener("handleResponse", (event) => {
  try {
    if (event.status !== 200 || !CACHEABLE.has(event.destination)) return;
    const raw = {};
    const headers = event.rawResponse && event.rawResponse.rawHeaders;
    for (const key in headers || {}) raw[key.toLowerCase()] = String(headers[key]).toLowerCase();
    if (raw["set-cookie"]) return;
    // The cache key is just the URL, so only allow Vary on headers that are
    // the same for every request from this browser.
    const vary = (raw.vary || "").split(",").map((v) => v.trim()).filter(Boolean);
    if (vary.some((v) => !["accept-encoding", "accept", "origin"].includes(v))) return;
    if (Number(raw["content-length"]) > MAX_BYTES) return;
    const control = raw["cache-control"] || "";
    if (/no-store|no-cache/.test(control)) return;
    const match = /(?:^|,)\s*max-age\s*=\s*(\d+)/.exec(control);
    if (!match) return;
    const age = Math.min(Number(match[1]), MAX_AGE) - (Number(raw.age) || 0);
    if (age < MIN_AGE) return;
    event.responseHeaders[EXPIRES] = String(Date.now() + age * 1000);
  } catch (e) {
    // Never let caching break a page.
  }
});

function cacheKey(request) {
  // Proxied URLs are same-origin; keep scripts and styles of the same URL apart.
  return request.url + (request.url.includes("?") ? "&" : "?") + "__orbit_dest=" + request.destination;
}

function canUseCache(request) {
  return request.method === "GET" && CACHEABLE.has(request.destination) &&
    !request.headers.has("range") && !["no-store", "reload", "no-cache"].includes(request.cache);
}

async function fromCache(key) {
  const cache = await caches.open(ASSET_CACHE);
  const hit = await cache.match(key);
  if (!hit) return null;
  if (Number(hit.headers.get(EXPIRES)) > Date.now()) return hit;
  cache.delete(key);
  return null;
}

async function store(key, response) {
  const cache = await caches.open(ASSET_CACHE);
  await cache.put(key, response);
  if (++stores % 200 === 0) {
    // Keys come back oldest first: trim the oldest when over the limit.
    const keys = await cache.keys();
    for (const old of keys.slice(0, Math.max(0, keys.length - MAX_ENTRIES))) await cache.delete(old);
  }
}

function withoutMarker(response) {
  const headers = new Headers(response.headers);
  headers.delete(EXPIRES);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function handleRequest(event) {
  await scramjet.loadConfig();
  if (!scramjet.route(event)) return fetch(event.request);

  const request = event.request;
  // A proxied address opened on its own in a browser tab (typed, pasted,
  // bookmarked: no referrer) goes to the revision front page instead of the
  // site. Links opened in a new tab from a proxied page carry a referrer and
  // still open normally; pages inside the proxy's own tabs are frames, so
  // this never affects them.
  if (request.mode === "navigate" && request.destination === "document" && !request.referrer) {
    return Response.redirect(self.location.origin + "/", 302);
  }
  if (!canUseCache(request)) return scramjet.fetch(event);
  const key = cacheKey(request);
  try {
    const hit = await fromCache(key);
    if (hit) return withoutMarker(hit);
  } catch (e) {}

  const response = await scramjet.fetch(event);
  if (!response.headers.has(EXPIRES)) return response;
  const copy = response.clone();
  event.waitUntil(store(key, copy).catch(() => {}));
  return withoutMarker(response);
}

self.addEventListener("fetch", (event) => {
  event.respondWith(handleRequest(event));
});
