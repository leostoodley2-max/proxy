(() => {
  "use strict";

  const $ = selector => document.querySelector(selector);
  const strip = $("#tabs");
  const home = $("#home");
  const address = $("#address");
  const search = $("#search");
  const dialog = $("#pin-dialog");
  const shortcuts = $("#shortcuts");
  const tabs = [];
  const sessionsKey = "orbit.tabs.v1";
  const pinsKey = "orbit.shortcuts.v1";
  const defaults = [
    { name: "Google", url: "https://www.google.com", brand: "google" },
    { name: "YouTube", url: "https://www.youtube.com", brand: "youtube" },
    { name: "Wikipedia", url: "https://www.wikipedia.org", brand: "wikipedia" },
    { name: "Reddit", url: "https://www.reddit.com", brand: "reddit" }
  ];
  let active;
  let nextId = 0;
  let ready = false;
  let setupError = "";
  let addressEdited = false;

  // Storage is optional in private or restricted browsing contexts.
  function read(key) {
    try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
  }
  function write(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* Session still works. */ }
  }
  function saveTabs() {
    write(sessionsKey, { active: tabs.indexOf(active), tabs: tabs.map(({ url, title, history, historyIndex }) => {
      const start = Math.max(0, Math.min(historyIndex, history.length - 50));
      return { url, title, history: history.slice(start, start + 50), historyIndex: historyIndex - start };
    }) });
  }
  function message(text) {
    $("#banner").textContent = text;
    $("#banner").hidden = !text;
  }
  function errorText(error) { return error?.message || String(error); }
  function hostname(url) {
    try { return new URL(url).hostname || url; } catch { return ""; }
  }
  function label(tab) { return tab.title || hostname(tab.url) || "New Tab"; }
  // The address bar shows the disguised address (see codec.js), not the real site.
  function shown(url) {
    return url ? location.host + OrbitCodec.prefix + OrbitCodec.encode(url) : "";
  }

  // Keep the tab buttons stable so focus and strip scrolling survive updates.
  function addTab(url = "", title = "", saved = {}) {
    const node = $("#tab-template").content.firstElementChild.cloneNode(true);
    const tab = { id: ++nextId, url, title, node, engine: null, pending: false, restored: !!url,
      loading: false, icon: "", cleanups: [], searchDraft: "",
      history: url ? [url] : [], historyIndex: url ? 0 : -1, traversing: null };
    if (Array.isArray(saved.history) && saved.history.every(item => typeof item === "string") &&
        Number.isInteger(saved.historyIndex) && saved.history[saved.historyIndex] === url) {
      tab.history = saved.history;
      tab.historyIndex = saved.historyIndex;
    }
    node.dataset.id = tab.id;
    tab.button = node.querySelector(".tab-select");
    tab.caption = node.querySelector(".tab-title");
    tab.image = node.querySelector("img");
    tab.image.onerror = () => { tab.image.hidden = true; };
    tab.button.id = "tab-" + tab.id;
    tabs.push(tab);
    strip.append(node);
    paint(tab);
    return tab;
  }
  function paint(tab) {
    const name = label(tab);
    const selected = tab === active;
    tab.caption.textContent = name;
    tab.button.title = name;
    tab.button.setAttribute("aria-selected", selected);
    tab.button.tabIndex = selected ? 0 : -1;
    tab.node.classList.toggle("selected", selected);
    tab.node.classList.toggle("loading", tab.loading);
    tab.node.querySelector(".close-tab").setAttribute("aria-label", "Close " + name);
    if (selected) document.title = name;
  }
  function updateControls() {
    if (!(addressEdited && document.activeElement === address)) address.value = shown(active.url);
    $('[data-command="back"]').disabled = !ready || active.historyIndex <= 0;
    $('[data-command="forward"]').disabled = !ready || active.historyIndex >= active.history.length - 1;
    $('[data-command="reload"]').disabled = !(active.url && active.engine && ready);
  }
  function showPage(focusHome = false) {
    home.hidden = !!active.url;
    for (const tab of tabs) {
      if (tab.engine) tab.engine.frame.hidden = tab !== active || !tab.url;
    }
    if (!active.url) {
      home.setAttribute("aria-labelledby", active.button.id);
      search.value = active.searchDraft;
      if (focusHome) search.focus();
    }
    updateControls();
  }
  function activate(tab) {
    if (active && !active.url) active.searchDraft = search.value;
    const previous = active;
    active = tab;
    if (tab.restored) { tab.restored = false; tab.pending = true; tab.traversing = tab.historyIndex; }
    addressEdited = false;
    if (previous && previous !== tab) paint(previous);
    paint(tab);
    showPage(true);
    tab.node.scrollIntoView({ block: "nearest", inline: "nearest" });
    startPending(tab);
    saveTabs();
  }
  function closeTab(tab) {
    const index = tabs.indexOf(tab);
    if (index < 0) return;
    tabs.splice(index, 1);
    for (const cleanup of tab.cleanups) cleanup();
    tab.engine?.frame.remove();
    tab.image.onerror = null;
    tab.node.remove();
    if (tab === active) activate(tabs[index] || tabs[index - 1] || addTab());
    else saveTabs();
  }
  function targetTab(event) {
    const id = event.target.closest(".tab")?.dataset.id;
    return tabs.find(tab => tab.id === Number(id));
  }
  strip.addEventListener("click", event => {
    const tab = targetTab(event);
    if (!tab) return;
    if (event.target.closest(".close-tab")) closeTab(tab);
    else activate(tab);
  });
  strip.addEventListener("auxclick", event => {
    const tab = targetTab(event);
    if (event.button === 1 && tab) { event.preventDefault(); closeTab(tab); }
  });
  $("#new-tab").addEventListener("click", () => activate(addTab()));

  // Frame metadata can be unavailable during redirects or document replacement.
  function setIcon(tab, href) {
    if (href === tab.icon) return;
    tab.icon = href;
    tab.image.hidden = !href;
    if (href) tab.image.src = href;
    else tab.image.removeAttribute("src");
  }
  // Favicons must load through the proxy: the UI is cross-origin isolated, so
  // a direct request to the real site would be blocked (and would skip the proxy).
  function iconFor(tab, doc) {
    let href = "";
    try {
      const raw = doc.querySelector('link[rel~="icon" i][href]')?.getAttribute("href");
      href = raw ? new URL(raw, tab.url).href : new URL("/favicon.ico", tab.url).href;
    } catch { return ""; }
    if (/^data:image\//i.test(href)) return href;
    if (href.startsWith(location.origin + "/")) return href;
    if (!/^https?:/i.test(href)) return "";
    try { return window.Engine.scramjet.encodeUrl(href); } catch { return ""; }
  }
  function inspect(tab) {
    if (!tab.url || !tab.engine || tab.pending || tab.loading) return;
    try {
      const doc = tab.engine.frame.contentDocument;
      if (!doc || doc.URL === "about:blank") return;
      const title = doc.title.trim();
      setIcon(tab, iconFor(tab, doc));
      if (title !== tab.title) { tab.title = title; paint(tab); saveTabs(); }
    } catch { /* A later poll can read the new document. */ }
  }
  function pushHistory(tab, url) {
    if (tab.history[tab.historyIndex] === url) return;
    tab.history.splice(tab.historyIndex + 1);
    tab.history.push(url);
    tab.historyIndex++;
  }
  function navigated(tab, value) {
    if (!tab.url || tab.pending || !value || value === "about:blank") return;
    const url = String(value);
    if (tab.traversing !== null) {
      tab.historyIndex = tab.traversing;
      tab.history[tab.historyIndex] = url;
    } else {
      pushHistory(tab, url);
    }
    if (url !== tab.url) {
      tab.url = url;
      tab.title = "";
      setIcon(tab, "");
      paint(tab);
      if (tab === active) updateControls();
      saveTabs();
    }
  }
  function createFrame(tab) {
    const engine = window.Engine.createFrame();
    const frame = engine.frame;
    frame.allow = "fullscreen; autoplay; encrypted-media; picture-in-picture; clipboard-write; gamepad; screen-wake-lock";
    frame.allowFullscreen = true;
    frame.title = "Web page";
    frame.id = "page-" + tab.id;
    frame.hidden = tab !== active;
    function leavingDocument() {
      if (tab.url) { tab.loading = true; paint(tab); }
    }
    function urlChanged(event) {
      navigated(tab, event.url);
      inspect(tab);
    }
    function loaded() {
      if (!tab.url || tab.pending) return;
      try {
        if (frame.contentDocument?.URL === "about:blank") return;
      } catch { /* Cross-origin frames can still finish loading. */ }
      try { navigated(tab, engine.url?.href); } catch { /* urlchange supplies the URL. */ }
      tab.traversing = null;
      try {
        frame.contentWindow.addEventListener("pagehide", leavingDocument, { once: true });
      } catch { /* Metadata and child window access are optional. */ }
      tab.loading = false;
      paint(tab);
      inspect(tab);
    }
    // target="_blank" / Ctrl+click / middle-click links open as tabs here.
    engine.onnewtab = (url, opts) => {
      const created = addTab(url);
      if (opts?.background) saveTabs();
      else activate(created);
    };
    engine.addEventListener("urlchange", urlChanged);
    frame.addEventListener("load", loaded);
    tab.cleanups.push(() => engine.removeEventListener?.("urlchange", urlChanged),
      () => frame.removeEventListener("load", loaded),
      () => {
        try { frame.contentWindow?.removeEventListener("pagehide", leavingDocument); } catch { /* Frame is inaccessible. */ }
      });
    tab.engine = engine;
    $("#pages").append(frame);
  }
  function startPending(tab) {
    if (!tab.pending || !ready) return;
    tab.pending = false;
    try {
      if (!tab.engine) createFrame(tab);
      tab.loading = true;
      paint(tab);
      updateControls();
      tab.engine.go(tab.url);
    } catch (error) {
      tab.traversing = null;
      tab.loading = false;
      paint(tab);
      message(errorText(error));
    }
  }
  function navigate(input) {
    if (!input.trim()) return;
    if (setupError) { message(setupError); return; }
    try {
      const url = window.Engine.toUrl(input.trim());
      if (!active.history.length) pushHistory(active, "");
      pushHistory(active, url);
      message("");
      openEntry();
    } catch (error) { message(errorText(error)); }
  }
  // Until the page finishes loading, URL changes (server redirects such as
  // youtube.com -> www.youtube.com) replace this entry instead of adding one,
  // so Back never lands on a URL that just redirects forward again.
  function openEntry() {
    const url = active.history[active.historyIndex];
    Object.assign(active, { url, title: "", loading: false, pending: !!url, searchDraft: "",
      traversing: url ? active.historyIndex : null });
    addressEdited = false;
    setIcon(active, "");
    paint(active);
    showPage(!url);
    saveTabs();
    startPending(active);
  }
  function command(name) {
    if (name === "home") {
      pushHistory(active, "");
      openEntry();
    } else if (name === "back" || name === "forward") {
      const index = active.historyIndex + (name === "back" ? -1 : 1);
      if (!ready || index < 0 || index >= active.history.length) return;
      active.historyIndex = index;
      openEntry();
    } else if (name === "reload" && active.url && active.engine && ready) {
      try {
        active.loading = true;
        paint(active);
        active.engine.reload();
      } catch (error) {
        active.loading = false;
        paint(active);
        message(errorText(error));
      }
    }
  }

  // Browser controls and top-document keyboard shortcuts.
  $(".toolbar").addEventListener("click", event => {
    const button = event.target.closest("[data-command]");
    if (button) command(button.dataset.command);
  });
  address.addEventListener("focus", () => address.select());
  address.addEventListener("input", () => { addressEdited = true; });
  address.addEventListener("blur", () => { addressEdited = false; updateControls(); });
  for (const [form, input] of [[$("#address-form"), address], [$("#search-form"), search]]) {
    form.addEventListener("submit", event => { event.preventDefault(); navigate(input.value); });
  }
  function cycle(step) {
    activate(tabs[(tabs.indexOf(active) + step + tabs.length) % tabs.length]);
    if (active.url) active.button.focus();
  }
  document.addEventListener("keydown", event => {
    if (dialog.open || event.isComposing || event.metaKey) return;
    const key = event.key.toLowerCase();
    const ctrl = event.ctrlKey && !event.altKey;
    const alt = event.altKey && !event.ctrlKey;
    let action;
    if (ctrl && key === "tab") action = () => cycle(event.shiftKey ? -1 : 1);
    else if (event.shiftKey) return;
    else if (ctrl && key === "t") action = () => activate(addTab());
    else if (ctrl && key === "w") action = () => closeTab(active);
    else if ((ctrl && key === "l") || key === "f6") action = () => { address.focus(); address.select(); };
    else if (alt && key === "arrowleft") action = () => command("back");
    else if (alt && key === "arrowright") action = () => command("forward");
    else if ((ctrl && key === "r") || key === "f5") action = () => command("reload");
    else if (event.target.matches(".tab-select") && ["arrowleft", "arrowright"].includes(key)) {
      action = () => { cycle(key === "arrowleft" ? -1 : 1); active.button.focus(); };
    }
    if (action) { event.preventDefault(); action(); }
  });

  // Built-in destinations and locally pinned shortcuts share one tile grid.
  function pinUrl(value) {
    try {
      const url = new URL(/^https?:\/\//i.test(value) ? value : "https://" + value);
      if (/^[a-z][a-z\d+.-]*:\/\//i.test(value) && !/^https?:/i.test(value)) return "";
      return url.href;
    } catch { return ""; }
  }
  const storedPins = read(pinsKey);
  const pins = Array.isArray(storedPins) ? storedPins.filter(pin =>
    typeof pin?.name === "string" && typeof pin.url === "string" && /^https?:\/\//i.test(pin.url)
  ).slice(0, 8) : [];
  function glyph(id, line = true) {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    const use = document.createElementNS(ns, "use");
    if (line) svg.classList.add("icon");
    svg.setAttribute("aria-hidden", "true");
    use.setAttribute("href", "#" + id);
    svg.append(use);
    return svg;
  }
  function renderShortcuts() {
    shortcuts.replaceChildren();
    const items = [...defaults, ...pins];
    if (pins.length < 8) items.push({ name: "Add shortcut" });
    items.forEach((item, index) => {
      const wrap = document.createElement("div");
      wrap.className = "tile-wrap";
      const button = document.createElement("button");
      button.className = item.url ? "tile" : "tile add";
      button.dataset.index = index;
      const badge = document.createElement("span");
      badge.className = "badge";
      badge.setAttribute("aria-hidden", "true");
      if (item.brand === "wikipedia") { badge.classList.add("wikipedia"); badge.textContent = "W"; }
      else if (item.brand) badge.append(glyph("brand-" + item.brand, false));
      else badge.append(glyph(item.url ? "i-globe" : "i-plus"));
      const caption = document.createElement("span");
      caption.className = "tile-label";
      caption.textContent = item.name;
      button.append(badge, caption);
      wrap.append(button);
      if (index >= defaults.length && item.url) {
        const remove = document.createElement("button");
        remove.className = "remove-pin";
        remove.dataset.remove = index - defaults.length;
        remove.setAttribute("aria-label", "Remove " + item.name);
        remove.title = "Remove shortcut";
        remove.append(glyph("i-close"));
        wrap.append(remove);
      }
      shortcuts.append(wrap);
    });
  }
  shortcuts.addEventListener("click", event => {
    const button = event.target.closest("button");
    if (!button) return;
    if (button.dataset.remove !== undefined) {
      pins.splice(Number(button.dataset.remove), 1);
      write(pinsKey, pins);
      renderShortcuts();
      return;
    }
    const index = Number(button.dataset.index);
    const item = defaults[index] || pins[index - defaults.length];
    if (item) navigate(item.url);
    else { $("#pin-form").reset(); dialog.showModal(); $("#pin-name").focus(); }
  });
  $("#cancel-pin").addEventListener("click", () => dialog.close());
  $("#pin-form").addEventListener("submit", event => {
    event.preventDefault();
    const name = $("#pin-name").value.trim();
    const url = pinUrl($("#pin-url").value.trim());
    for (const [selector, value, hint] of [
      ["#pin-name", name, "Enter a shortcut name."], ["#pin-url", url, "Enter a valid web address."]
    ]) {
      if (!value) {
        const input = $(selector);
        input.setCustomValidity(hint);
        input.reportValidity();
        input.setCustomValidity("");
        return;
      }
    }
    if (pins.length < 8) pins.push({ name, url });
    write(pinsKey, pins);
    dialog.close();
    renderShortcuts();
  });

  // A static star atlas and curved orbital paths scale with the start page.
  function drawSky() {
    const canvas = $("#sky");
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(w * ratio);
    canvas.height = Math.round(h * ratio);
    ctx.scale(ratio, ratio);
    let seed = 412;
    function random() { seed = seed * 16807 % 2147483647; return seed / 2147483647; }
    for (let i = 0; i < w * h / 4500; i++) {
      const x = random() * w, y = random() * h, size = .5 + random();
      ctx.fillStyle = "rgba(216,204,232," + (.18 + random() * .48) + ")";
      ctx.fillRect(x, y, size, size);
      if (i % 19 === 0) {
        ctx.fillRect(x - 2, y, size + 4, .8);
        ctx.fillRect(x, y - 2, .8, size + 4);
      }
    }
    const radius = Math.max(w * .87, 680);
    const centerY = h * .82 + radius;
    const glow = ctx.createRadialGradient(w * .5, centerY, radius * .96, w * .5, centerY, radius + 18);
    glow.addColorStop(0, "rgba(84,49,80,0)");
    glow.addColorStop(.67, "rgba(170,84,114,.11)");
    glow.addColorStop(1, "rgba(170,84,114,0)");
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = "rgba(204,125,151,.24)";
    ctx.beginPath();
    ctx.arc(w * .5, centerY, radius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.save();
    ctx.clip();
    ctx.strokeStyle = "rgba(180,113,146,.13)";
    for (let i = 1; i < 7; i++) {
      ctx.beginPath();
      ctx.ellipse(w * .5, centerY, radius, radius - i * i * 3.4, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    for (let i = -8; i <= 8; i++) {
      const x = w * .5 + i * radius / 10;
      ctx.beginPath();
      ctx.moveTo(x, h * .78);
      ctx.quadraticCurveTo(x + i * 8, h * .91, x + i * 20, h + 10);
      ctx.stroke();
    }
    ctx.restore();
  }

  // Restore tab labels now and allocate frames only when selected and ready.
  const saved = read(sessionsKey);
  if (Array.isArray(saved?.tabs)) {
    for (const entry of saved.tabs) {
      if (typeof entry?.url === "string") addTab(entry.url, typeof entry.title === "string" ? entry.title : "", entry);
    }
  }
  renderShortcuts();
  activate(tabs[saved?.active] || tabs[0] || addTab());
  new ResizeObserver(drawSky).observe(home);
  window.setInterval(() => tabs.forEach(inspect), 1000);
  async function connect() {
    try {
      if (!window.Engine?.ready) throw new Error("The browser engine could not be loaded.");
      await window.Engine.ready;
      ready = true;
      tabs.forEach(startPending);
      updateControls();
    } catch (error) {
      setupError = errorText(error);
      message(setupError);
    }
  }
  connect();
})();
