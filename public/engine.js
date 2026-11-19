// Proxy engine: sets up Scramjet (service worker + Wisp transport) and gives
// the browser UI a small API. See browser.js for how it is used.
//
//   Engine.ready              Promise, resolves once proxying works
//   Engine.toUrl(text)        address-bar text -> real URL (or a Google search)
//   Engine.createFrame()      -> { frame, go, back, forward, reload, url, addEventListener }
//   Engine.decode(proxied)    proxied URL -> real URL
"use strict";

(function () {
  // Google shows a bot check ("unusual traffic") for most proxied searches,
  // so the address bar searches DuckDuckGo. Google itself still works as a site.
  const SEARCH = "https://duckduckgo.com/?q=%s";
  const TRANSPORT = "/libcurl/index.mjs";

  const { ScramjetController } = $scramjetLoadController();
  const scramjet = new ScramjetController({
    prefix: "/scramjet/",
    files: {
      wasm: "/scram/scramjet.wasm.wasm",
      all: "/scram/scramjet.all.js",
      sync: "/scram/scramjet.sync.js",
    },
  });

  const connection = new BareMux.BareMuxConnection("/baremux/worker.js");

  async function setup() {
    if (!("serviceWorker" in navigator)) {
      throw new Error(
        location.protocol === "https:" || location.hostname === "localhost"
          ? "This browser doesn't support service workers, so the proxy can't run."
          : "The proxy needs https:// (service workers are blocked on plain http)."
      );
    }
    await scramjet.init();
    await navigator.serviceWorker.register("/sw.js", { scope: "/" });
    await navigator.serviceWorker.ready;

    const wispUrl = (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/wisp/";
    // libcurl-transport 1.5.x creates its HTTP session in init() before the
    // libcurl wasm has finished loading, so the first request after the worker
    // (re)imports it fails with "wasm not loaded yet". Wrap it so init() waits
    // and retries. Always (re)set it so a reload never keeps a broken instance.
    await connection.setManualTransport(
      `
      const { default: Libcurl } = await import(${JSON.stringify(TRANSPORT)});
      class SafeLibcurl extends Libcurl {
        async init() {
          for (let i = 0; ; i++) {
            try {
              return await super.init();
            } catch (err) {
              if (i >= 150 || !/wasm not loaded/i.test(String(err && err.message))) throw err;
              await new Promise((r) => setTimeout(r, 100));
            }
          }
        }
      }
      return [SafeLibcurl, ${JSON.stringify(TRANSPORT)}];
      `,
      [{ websocket: wispUrl }]
    );
  }

  const ready = setup();
  ready.catch((err) => console.error("[engine] setup failed:", err));

  function toUrl(input) {
    const text = String(input || "").trim();
    if (!text) return "";
    // Already a full URL.
    try {
      const u = new URL(text);
      if (u.protocol === "http:" || u.protocol === "https:") return u.href;
    } catch (e) {}
    // Looks like a domain or host (no spaces, has a dot or a port): add https://
    if (!/\s/.test(text) && (/^[^/]+\.[a-z]{2,}(?::\d+)?(\/.*)?$/i.test(text) || /^localhost(:\d+)?(\/.*)?$/i.test(text))) {
      try {
        return new URL("https://" + text).href;
      } catch (e) {}
    }
    return SEARCH.replace("%s", encodeURIComponent(text));
  }

  function createFrame() {
    const sj = scramjet.createFrame();
    const frame = sj.frame;
    let pending = 0;

    // Links with target="_blank" would open the raw proxied page in a real
    // browser tab, outside the mini-browser. Send them to onnewtab instead.
    const api = {};
    frame.addEventListener("load", () => {
      let doc;
      try {
        doc = frame.contentDocument;
      } catch (e) {
        return;
      }
      if (!doc) return;
      doc.addEventListener(
        "click",
        (ev) => {
          if (typeof api.onnewtab !== "function" || ev.defaultPrevented) return;
          const a = ev.target && ev.target.closest ? ev.target.closest("a[href]") : null;
          if (!a) return;
          const target = (a.getAttribute("target") || "").toLowerCase();
          const wantsNew = target === "_blank" || target === "_new" || ev.ctrlKey || ev.metaKey || ev.button === 1;
          if (!wantsNew) return;
          const real = realHref(a);
          if (!real) return;
          ev.preventDefault();
          ev.stopPropagation();
          api.onnewtab(real, { background: ev.ctrlKey || ev.metaKey || ev.button === 1 });
        },
        true
      );
      doc.addEventListener("auxclick", (ev) => {
        if (ev.button !== 1 || typeof api.onnewtab !== "function") return;
        const a = ev.target && ev.target.closest ? ev.target.closest("a[href]") : null;
        const real = a && realHref(a);
        if (!real) return;
        ev.preventDefault();
        api.onnewtab(real, { background: true });
      }, true);
    });

    function realHref(a) {
      // Read the raw (proxied) href from outside Scramjet's hooks, then decode.
      let raw;
      try {
        raw = HTMLAnchorElement.prototype.__lookupGetter__("href").call(a);
      } catch (e) {
        raw = a.href;
      }
      if (!raw || /^(javascript|mailto|tel|blob|data):/i.test(raw)) return null;
      try {
        const u = new URL(raw, location.href);
        if (u.origin === location.origin && u.pathname.startsWith("/scramjet/")) return scramjet.decodeUrl(u.href);
        if (u.protocol === "http:" || u.protocol === "https:") return u.href;
      } catch (e) {}
      return null;
    }

    return Object.assign(api, {
      frame,
      go(url) {
        const id = ++pending;
        // Navigations requested before setup finishes are queued; only the
        // latest one runs.
        ready.then(() => {
          if (id === pending) sj.go(url);
        });
      },
      back() { sj.back(); },
      forward() { sj.forward(); },
      reload() { sj.reload(); },
      get url() {
        try {
          return sj.url;
        } catch (e) {
          return new URL("about:blank");
        }
      },
      addEventListener(type, fn, opts) {
        sj.addEventListener(type, fn, opts);
      },
      removeEventListener(type, fn, opts) {
        sj.removeEventListener(type, fn, opts);
      },
      // Set by the UI: called with (realUrl, { background }) for new-window links.
      onnewtab: null,
    });
  }

  function decode(proxied) {
    return scramjet.decodeUrl(proxied);
  }

  window.Engine = { ready, toUrl, createFrame, decode, scramjet };
})();
