// Service worker: every request made by a proxied page passes through here.
importScripts("/scram/scramjet.all.js?v=2");

const { ScramjetServiceWorker } = $scramjetLoadWorker();
const scramjet = new ScramjetServiceWorker();

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
// script, stylesheet, font and image is downloaded through the tunnel and
// rewritten again on every page load. Cache the finished (rewritten) response
// for as long as the site itself allows. Bump the version whenever Scramjet
// or its settings change, since that changes the rewritten output.
const ASSET_CACHE = "orbit-assets-v1";
const CACHEABLE = new Set(["script", "style", "font", "image"]);
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
    if (raw["set-cookie"] || /\*|cookie/.test(raw.vary || "")) return;
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
