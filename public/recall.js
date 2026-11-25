// Recall: a small flashcard and focus-timer app. Accounts and decks live in
// this browser's localStorage (passwords are stored only as salted PBKDF2
// hashes) and are for revision only. One special sign-in opens the web
// browser at /app instead, which then asks for a (paid) browser account.
"use strict";

(() => {
  const $ = (id) => document.getElementById(id);
  const ACCOUNTS = "recall.accounts.v1";
  const CURRENT = "recall.current.v1";
  // SHA-256 of "<username>:<password>" for the sign-in that opens /app.
  const BROWSER_KEY = "de28b315be7a7f934354a091ef77a2263965b0870eddfa02f413d7a7ba20ab67";

  const read = (key, fallback) => {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
  };
  const write = (key, value) => {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage full or disabled */ }
  };
  const id = () => Math.random().toString(36).slice(2, 10);

  // ---- Accounts ------------------------------------------------------------
  const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const sha256 = async (text) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  async function passwordHash(password, salt) {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: new TextEncoder().encode(salt), iterations: 120000 }, key, 256);
    return hex(bits);
  }
  const normal = (name) => name.trim().toLowerCase();
  let user = read(CURRENT, null);

  async function signIn(name, password) {
    if ((await sha256(normal(name) + ":" + password)) === BROWSER_KEY) {
      // Opens the web browser's own sign-in (its paid accounts live on the server).
      document.cookie = "orbit_gate=1; Path=/; Max-Age=31536000; SameSite=Lax" + (location.protocol === "https:" ? "; Secure" : "");
      location.href = "/app";
      return null;
    }
    const account = read(ACCOUNTS, {})[normal(name)];
    if (!account || (await passwordHash(password, account.salt)) !== account.hash) return "Wrong username or password.";
    setUser(account.name);
    return null;
  }
  async function signUp(name, password) {
    const key = normal(name);
    if (!/^[a-z0-9_.-]{3,40}$/.test(key)) return "Usernames are 3–40 letters, numbers, dots, dashes or underscores.";
    if (!password) return "Enter a password.";
    const accounts = read(ACCOUNTS, {});
    if (accounts[key] || key === "proxy") return "That username is taken.";
    const salt = id() + id();
    accounts[key] = { name: name.trim(), salt, hash: await passwordHash(password, salt) };
    write(ACCOUNTS, accounts);
    setUser(name.trim());
    return null;
  }
  function setUser(name) {
    user = name;
    write(CURRENT, name);
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
    $("who").hidden = $("signout").hidden = !user;
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
      if (!window.crypto || !crypto.subtle) throw new Error("Accounts need a secure (https) connection.");
      const error = mode === "signin"
        ? await signIn($("auth-user").value, $("auth-pass").value)
        : await signUp($("auth-user").value, $("auth-pass").value);
      if (error) {
        $("auth-error").textContent = error;
        $("auth-error").hidden = false;
      } else {
        $("auth").close();
      }
    } catch (e) {
      $("auth-error").textContent = e.message;
      $("auth-error").hidden = false;
    } finally {
      submit.disabled = false;
    }
  });
  $("signout").addEventListener("click", () => { user = null; write(CURRENT, null); load(); });

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
})();
