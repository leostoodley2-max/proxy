// Recall: a small flashcard and focus-timer app. Accounts and decks live in
// this browser's localStorage (passwords are stored only as salted PBKDF2
// hashes). One special sign-in opens the web browser at /app instead.
"use strict";

(() => {
  const $ = (id) => document.getElementById(id);

  const read = (key, fallback) => {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
  };
  const write = (key, value) => {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage full or disabled */ }
  };
  const id = () => Math.random().toString(36).slice(2, 10);

  // ---- Accounts ------------------------------------------------------------
  // Accounts live on the server, so they work on any device. Signing in (or
  // creating an account) opens the study workspace at /app.
  const normal = (name) => name.trim().toLowerCase();
  let user = null;

  async function api(path, body) {
    const res = await fetch("/api/" + path, body === undefined ? { cache: "no-store" } : {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Something went wrong. Try again.");
    return data;
  }
  async function signIn(name, password) {
    await api("login", { username: name.trim(), password });
    location.href = "/app";
  }
  async function signUp(name, password) {
    await api("signup", { username: name.trim(), password });
    location.href = "/app";
  }
  function setUser(name) {
    user = name;
    load();
  }

  // ---- Data ------------------------------------------------------------------
  const sample = () => ({
    decks: [{
      id: id(), name: "Biology: Cells", cards: [
        ["What is the function of the mitochondria?", "Aerobic respiration: releasing energy from glucose."],
        ["What does the cell membrane do?", "Controls what enters and leaves the cell."],
        ["Where is genetic material found in a plant cell?", "In the nucleus."],
        ["What do ribosomes make?", "Proteins."],
        ["Name two structures found in plant cells but not animal cells.", "Cell wall, chloroplasts (and a permanent vacuole)."],
      ].map(([front, back]) => ({ id: id(), front, back, box: 0 })),
    }],
    sessions: { day: "", count: 0 },
  });
  let data;
  const storeKey = () => "recall.data.v1." + (user ? normal(user) : "guest");
  const save = () => write(storeKey(), data);
  function load() {
    data = read(storeKey(), null) || sample();
    save();
    renderAccount();
    showDecks();
  }

  // ---- Views -----------------------------------------------------------------
  let deck = null;
  function show(view) {
    for (const v of ["hero", "deck-view", "study-view"]) $(v).hidden = v !== view;
    document.querySelector(".layout").hidden = view !== "hero";
  }
  function renderAccount() {
    $("who").hidden = $("signout").hidden = $("open-app").hidden = !user;
    $("open-signin").hidden = $("open-signup").hidden = !!user;
    $("who").textContent = user ? "Signed in as " + user : "";
    const today = new Date().toDateString();
    if (data.sessions.day !== today) data.sessions = { day: today, count: 0 };
    $("sessions").textContent = data.sessions.count;
  }
  function showDecks() {
    show("hero");
    const list = $("deck-list");
    list.replaceChildren();
    if (!data.decks.length) {
      const li = document.createElement("li");
      li.className = "empty";
      li.textContent = "No decks yet. Add one above.";
      list.append(li);
    }
    for (const d of data.decks) {
      const li = document.createElement("li");
      const b = document.createElement("button");
      b.className = "deck";
      b.type = "button";
      const name = document.createElement("strong");
      name.textContent = d.name;
      const count = document.createElement("span");
      const known = d.cards.filter((c) => c.box > 0).length;
      count.textContent = d.cards.length + " cards · " + known + " known";
      b.append(name, count);
      b.addEventListener("click", () => openDeck(d));
      li.append(b);
      list.append(li);
    }
  }
  function openDeck(d) {
    deck = d;
    show("deck-view");
    $("deck-title").textContent = d.name;
    const list = $("card-list");
    list.replaceChildren();
    for (const c of d.cards) {
      const li = document.createElement("li");
      li.className = "card-row";
      const front = document.createElement("span");
      front.textContent = c.front;
      const back = document.createElement("span");
      back.className = "back";
      back.textContent = c.back;
      const del = document.createElement("button");
      del.type = "button";
      del.textContent = "×";
      del.setAttribute("aria-label", "Delete card");
      del.addEventListener("click", () => {
        d.cards = d.cards.filter((x) => x !== c);
        save();
        openDeck(d);
      });
      li.append(front, back, del);
      list.append(li);
    }
    $("study").disabled = !d.cards.length;
  }

  // ---- Study -----------------------------------------------------------------
  let queue = [], current = null, total = 0, flipped = false;
  function startStudy() {
    queue = [...deck.cards].sort((a, b) => a.box - b.box);
    total = queue.length;
    show("study-view");
    $("study-title").textContent = deck.name;
    $("study-done").hidden = true;
    next();
  }
  function next() {
    current = queue.shift() || null;
    flipped = false;
    const done = total - queue.length - (current ? 1 : 0);
    $("progress-bar").style.width = (total ? (done / total) * 100 : 100) + "%";
    $("study-progress").textContent = Math.min(done + 1, total) + " / " + total;
    $("flashcard").hidden = $("again").hidden = $("got-it").hidden = !current;
    $("study-done").hidden = !!current;
    if (current) paintCard();
  }
  function paintCard() {
    $("flashcard").classList.toggle("flipped", flipped);
    $("card-side").textContent = flipped ? "Answer" : "Question";
    $("card-text").textContent = flipped ? current.back : current.front;
  }
  function grade(knew) {
    if (!current) return;
    if (knew) current.box++;
    else { current.box = 0; queue.push(current); total++; }
    save();
    next();
  }

  // ---- Timer -----------------------------------------------------------------
  const STUDY = 25 * 60, BREAK = 5 * 60;
  let left = STUDY, studying = true, ticking = null;
  const paintTimer = () => {
    $("timer-clock").textContent = String(Math.floor(left / 60)).padStart(2, "0") + ":" + String(left % 60).padStart(2, "0");
    $("timer-mode").textContent = studying ? "Study" : "Break";
    $("timer-start").textContent = ticking ? "Pause" : "Start";
  };
  function tick() {
    if (--left > 0) return paintTimer();
    if (studying) { data.sessions.count++; save(); renderAccount(); }
    studying = !studying;
    left = studying ? STUDY : BREAK;
    paintTimer();
  }

  // ---- Wiring ----------------------------------------------------------------
  let mode = "signin";
  function openAuth(which) {
    mode = which;
    $("auth-title").textContent = which === "signin" ? "Sign in" : "Create account";
    $("auth-submit").textContent = which === "signin" ? "Sign in" : "Create account";
    $("auth-switch").textContent = which === "signin" ? "No account? Create one" : "Already have an account? Sign in";
    $("auth-pass").autocomplete = which === "signin" ? "current-password" : "new-password";
    // Only new passwords need 8+ characters; signing in accepts whatever the account has.
    if (which === "signup") $("auth-pass").minLength = 8;
    else $("auth-pass").removeAttribute("minlength");
    $("auth-pass").placeholder = which === "signup" ? "At least 8 characters" : "";
    $("auth-error").hidden = true;
    $("auth-form").reset();
    $("auth").showModal();
    $("auth-user").focus();
  }
  $("open-signin").addEventListener("click", () => openAuth("signin"));
  $("open-signup").addEventListener("click", () => openAuth("signup"));
  $("auth-switch").addEventListener("click", () => openAuth(mode === "signin" ? "signup" : "signin"));
  $("auth-cancel").addEventListener("click", () => $("auth").close());
  $("auth-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const submit = $("auth-submit");
    submit.disabled = true;
    try {
      if (mode === "signin") await signIn($("auth-user").value, $("auth-pass").value);
      else await signUp($("auth-user").value, $("auth-pass").value);
    } catch (e) {
      $("auth-error").textContent = e.message;
      $("auth-error").hidden = false;
    } finally {
      submit.disabled = false;
    }
  });
  $("signout").addEventListener("click", async () => {
    await api("logout", {}).catch(() => {});
    user = null;
    load();
  });
  $("open-app").addEventListener("click", () => { location.href = "/app"; });

  $("new-deck").addEventListener("submit", (event) => {
    event.preventDefault();
    const name = $("deck-name").value.trim();
    if (!name) return;
    const d = { id: id(), name, cards: [] };
    data.decks.push(d);
    save();
    $("deck-name").value = "";
    openDeck(d);
  });
  $("new-card").addEventListener("submit", (event) => {
    event.preventDefault();
    deck.cards.push({ id: id(), front: $("card-front").value.trim(), back: $("card-back").value.trim(), box: 0 });
    save();
    $("new-card").reset();
    openDeck(deck);
    $("card-front").focus();
  });
  $("back").addEventListener("click", showDecks);
  $("delete-deck").addEventListener("click", () => {
    if (!confirm('Delete the deck "' + deck.name + '" and all its cards?')) return;
    data.decks = data.decks.filter((d) => d !== deck);
    save();
    showDecks();
  });
  $("study").addEventListener("click", startStudy);
  $("stop-study").addEventListener("click", () => openDeck(deck));
  $("flashcard").addEventListener("click", () => { flipped = !flipped; paintCard(); });
  $("again").addEventListener("click", () => grade(false));
  $("got-it").addEventListener("click", () => grade(true));
  $("timer-start").addEventListener("click", () => {
    if (ticking) { clearInterval(ticking); ticking = null; }
    else ticking = setInterval(tick, 1000);
    paintTimer();
  });
  $("timer-reset").addEventListener("click", () => {
    clearInterval(ticking);
    ticking = null;
    studying = true;
    left = STUDY;
    paintTimer();
  });

  load();
  paintTimer();
  // Already signed in on this device? Show it.
  api("me").then((data) => setUser(data.user.username)).catch(() => {});
})();
