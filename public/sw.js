// Service worker: every request made by a proxied page passes through here.
importScripts("/scram/scramjet.all.js?v=2");

const { ScramjetServiceWorker } = $scramjetLoadWorker();
const scramjet = new ScramjetServiceWorker();

// Take control straight away after an update instead of waiting for every
// tab to close.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

async function handleRequest(event) {
  await scramjet.loadConfig();
  if (scramjet.route(event)) {
    return scramjet.fetch(event);
  }
  return fetch(event.request);
}

self.addEventListener("fetch", (event) => {
  event.respondWith(handleRequest(event));
});
