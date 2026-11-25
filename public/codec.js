// Address disguise for proxied pages. Instead of
//   /scramjet/https%3A%2F%2Fwww.youtube.com%2F
// a proxied page's address looks like
//   /study/photosynthesis-flashcards-Xk3v...
// The two words are school topics picked from the site's hostname (each
// site gets its own, always the same pair); the rest is the real address,
// scrambled. This is a disguise, not encryption: the key is in this file.
//
// Scramjet copies encode/decode as source text into the service worker and
// every page, so each function must be self-contained (no outside variables).
// Loaded as a script (sets self.OrbitCodec) and by Node tests (module.exports).
(function (root) {
  "use strict";
  var PREFIX = "/study/";

  function encode(url) {
    if (!url) return url;
    var words = ["revision", "flashcards", "algebra", "biology", "chemistry", "physics", "history", "geography",
      "grammar", "spelling", "fractions", "equations", "photosynthesis", "vocabulary", "timeline", "quiz", "notes",
      "practice", "worksheet", "summary", "glossary", "essay", "poetry", "shakespeare", "volcanoes", "rivers",
      "atoms", "cells", "forces", "electricity", "magnets", "ecosystems", "romans", "tudors", "victorians",
      "decimals", "percentages", "geometry", "statistics", "french", "spanish", "german", "coding", "literature",
      "climate", "energy", "genetics", "evolution", "calculus", "trigonometry", "punctuation", "revolution"];
    var key = "orbit-study-7f3a91";
    var host = url;
    try { host = new URL(url).hostname || url; } catch (e) {}
    var h = 2166136261;
    for (var j = 0; j < host.length; j++) h = Math.imul(h ^ host.charCodeAt(j), 16777619) >>> 0;
    var a = h % words.length, b = (h >>> 12) % words.length;
    var seed = a * 61 + b * 7; // differs per site, recoverable from the words
    var bytes = new TextEncoder().encode(url);
    var mixed = "";
    for (var i = 0; i < bytes.length; i++) {
      mixed += String.fromCharCode(bytes[i] ^ key.charCodeAt(i % key.length) ^ ((i * 31 + seed) & 255));
    }
    var scrambled = btoa(mixed).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    return words[a] + "-" + words[b] + "-" + scrambled;
  }

  function decode(text) {
    if (!text) return text;
    // Scramjet passes its own query (e.g. "?dest=worker") and the #fragment after
    // the encoded part, and expects them back unchanged after the real address.
    var whole = String(text);
    var cut = whole.search(/[?#]/);
    var rest = cut < 0 ? "" : whole.slice(cut);
    text = cut < 0 ? whole : whole.slice(0, cut);
    var parts = text.split("-");
    var scrambled = parts.slice(2).join("-");
    // Not one of ours (e.g. an old /scramjet/-style address): plain decoding.
    if (parts.length < 3 || !/^[a-z]+$/.test(parts[0]) || !/^[A-Za-z0-9_-]+$/.test(scrambled)) {
      try { return decodeURIComponent(whole); } catch (e) { return whole; }
    }
    var words = ["revision", "flashcards", "algebra", "biology", "chemistry", "physics", "history", "geography",
      "grammar", "spelling", "fractions", "equations", "photosynthesis", "vocabulary", "timeline", "quiz", "notes",
      "practice", "worksheet", "summary", "glossary", "essay", "poetry", "shakespeare", "volcanoes", "rivers",
      "atoms", "cells", "forces", "electricity", "magnets", "ecosystems", "romans", "tudors", "victorians",
      "decimals", "percentages", "geometry", "statistics", "french", "spanish", "german", "coding", "literature",
      "climate", "energy", "genetics", "evolution", "calculus", "trigonometry", "punctuation", "revolution"];
    var a = words.indexOf(parts[0]), b = words.indexOf(parts[1]);
    if (a < 0 || b < 0) return whole;
    var seed = a * 61 + b * 7;
    var key = "orbit-study-7f3a91";
    var b64 = scrambled.replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) b64 += "=";
    var mixed;
    try { mixed = atob(b64); } catch (e) { return whole; }
    var bytes = new Uint8Array(mixed.length);
    for (var i = 0; i < mixed.length; i++) {
      bytes[i] = mixed.charCodeAt(i) ^ key.charCodeAt(i % key.length) ^ ((i * 31 + seed) & 255);
    }
    return new TextDecoder().decode(bytes) + rest;
  }

  var codec = { prefix: PREFIX, encode: encode, decode: decode };
  if (typeof module !== "undefined" && module.exports) module.exports = codec;
  else root.OrbitCodec = codec;
})(typeof self !== "undefined" ? self : this);
