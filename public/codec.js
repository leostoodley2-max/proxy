// Address disguise for proxied pages. Instead of
//   /scramjet/https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3Dabc
// a proxied page's address looks like
//   /study/notes-forces-k7XE6Bc4EjaO.%2Fwatch%3Fv%3Dabc
// The two words are school topics picked from the site's hostname (each site
// gets its own, always the same pair). The site itself (scheme and host) is
// scrambled; the rest of the address (path and query) is percent-encoded the
// way Scramjet's default codec does it. That part has to stay in that form:
// sites read proxied addresses back from APIs Scramjet doesn't translate
// (document.styleSheets, error stacks, resource timings) and look for their
// file names in them, or append to them; YouTube, for one, won't apply its
// styles if it can't find them. This is a disguise, not encryption: the key
// is in this file.
//
// Scramjet copies encode/decode as source text into the service worker and
// every page, so each function must be self-contained (no outside variables).
// Loaded as a script (sets self.OrbitCodec) and by Node tests (module.exports).
(function (root) {
  "use strict";
  var PREFIX = "/study/";

  function encode(url) {
    if (!url) return url;
    var origin = null, host = "";
    try {
      var parsed = new URL(url);
      if (parsed.origin && parsed.origin !== "null" && url.indexOf(parsed.origin) === 0) {
        origin = parsed.origin;
        host = parsed.hostname;
      }
    } catch (e) {}
    // Not a plain http(s) address (e.g. a #fragment Scramjet encodes on its own).
    if (!origin) return encodeURIComponent(url);
    var words = ["revision", "flashcards", "algebra", "biology", "chemistry", "physics", "history", "geography",
      "grammar", "spelling", "fractions", "equations", "photosynthesis", "vocabulary", "timeline", "quiz", "notes",
      "practice", "worksheet", "summary", "glossary", "essay", "poetry", "shakespeare", "volcanoes", "rivers",
      "atoms", "cells", "forces", "electricity", "magnets", "ecosystems", "romans", "tudors", "victorians",
      "decimals", "percentages", "geometry", "statistics", "french", "spanish", "german", "coding", "literature",
      "climate", "energy", "genetics", "evolution", "calculus", "trigonometry", "punctuation", "revolution"];
    var key = "orbit-study-7f3a91";
    var h = 2166136261;
    for (var j = 0; j < host.length; j++) h = Math.imul(h ^ host.charCodeAt(j), 16777619) >>> 0;
    var a = h % words.length, b = (h >>> 12) % words.length;
    var seed = a * 61 + b * 7; // differs per site, recoverable from the words
    var bytes = new TextEncoder().encode(origin);
    var mixed = "";
    for (var i = 0; i < bytes.length; i++) {
      mixed += String.fromCharCode(bytes[i] ^ key.charCodeAt(i % key.length) ^ ((i * 31 + seed) & 255));
    }
    var scrambled = btoa(mixed).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    return words[a] + "-" + words[b] + "-" + scrambled + "." + encodeURIComponent(url.slice(origin.length));
  }

  function decode(text) {
    if (!text) return text;
    var whole = String(text);
    var plain = function (s) { try { return decodeURIComponent(s); } catch (e) { return s; } };
    var words = ["revision", "flashcards", "algebra", "biology", "chemistry", "physics", "history", "geography",
      "grammar", "spelling", "fractions", "equations", "photosynthesis", "vocabulary", "timeline", "quiz", "notes",
      "practice", "worksheet", "summary", "glossary", "essay", "poetry", "shakespeare", "volcanoes", "rivers",
      "atoms", "cells", "forces", "electricity", "magnets", "ecosystems", "romans", "tudors", "victorians",
      "decimals", "percentages", "geometry", "statistics", "french", "spanish", "german", "coding", "literature",
      "climate", "energy", "genetics", "evolution", "calculus", "trigonometry", "punctuation", "revolution"];
    var key = "orbit-study-7f3a91";
    var unscramble = function (scrambled, a, b) {
      var seed = a * 61 + b * 7;
      var b64 = scrambled.replace(/-/g, "+").replace(/_/g, "/");
      while (b64.length % 4) b64 += "=";
      var mixed = atob(b64);
      var bytes = new Uint8Array(mixed.length);
      for (var i = 0; i < mixed.length; i++) {
        bytes[i] = mixed.charCodeAt(i) ^ key.charCodeAt(i % key.length) ^ ((i * 31 + seed) & 255);
      }
      return new TextDecoder().decode(bytes);
    };
    // Current form: words-words-<scrambled origin>.<percent-encoded rest>. Anything
    // after it (Scramjet's own "?dest=..." or a "#fragment", or text a page
    // appended) decodes the same way Scramjet's default codec would.
    var m = /^([a-z]+)-([a-z]+)-([A-Za-z0-9_-]+)\.([^]*)$/.exec(whole);
    if (m && words.indexOf(m[1]) >= 0 && words.indexOf(m[2]) >= 0) {
      try { return unscramble(m[3], words.indexOf(m[1]), words.indexOf(m[2])) + plain(m[4]); } catch (e) { return plain(whole); }
    }
    // Older form (whole address scrambled), from saved tabs and bookmarks.
    var cut = whole.search(/[?#]/);
    var token = cut < 0 ? whole : whole.slice(0, cut);
    var old = /^([a-z]+)-([a-z]+)-([A-Za-z0-9_-]+)$/.exec(token);
    if (old && words.indexOf(old[1]) >= 0 && words.indexOf(old[2]) >= 0) {
      try { return unscramble(old[3], words.indexOf(old[1]), words.indexOf(old[2])) + (cut < 0 ? "" : whole.slice(cut)); } catch (e) { return whole; }
    }
    return plain(whole);
  }

  var codec = { prefix: PREFIX, encode: encode, decode: decode };
  if (typeof module !== "undefined" && module.exports) module.exports = codec;
  else root.OrbitCodec = codec;
})(typeof self !== "undefined" ? self : this);
