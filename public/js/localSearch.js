// ── Searching end-to-end encrypted messages, on the device (web) ────────────
//
// Mirrors native-app/src/localSearch.ts. The server holds ciphertext and no
// key, so it cannot match these messages; it hands the ciphertext over and the
// matching happens here, with no plaintext and no query leaving the browser.
//
// The matching is mostly about Persian. Written Persian has several ways to
// spell the same word, and a search that ignores them finds nothing while
// looking like it works — so this file and the app's must agree exactly, and
// test/localSearch.test.js checks that they do rather than trusting it.
//
// The character classes below were copied FROM the TypeScript mechanically
// rather than retyped: several of them are invisible characters (zero-width
// joiners) or ranges that differ by one code point, and transcribing them by
// eye is how a search quietly stops finding half of someone's messages.
(function (root) {
  'use strict';

  /**
   * One spelling for text that has several.
   *
   *   • ي (Arabic yeh) and ی (Farsi yeh) look identical in most fonts
   *   • ك (Arabic kaf) and ک (Farsi keheh) likewise
   *   • أ إ آ ٱ vs ا — the same word, different code points
   *   • the zero-width non-joiner inside می‌روم is invisible and often absent
   *   • ٠١٢ (Arabic-Indic), ۰۱۲ (extended) and 012 are the same numbers
   *   • harakat are optional and rarely typed
   */
  function normalise(s) {
    return String(s || '')
    .toLowerCase()
    // Yeh, kaf, heh and the alef family.
    .replace(/[يىۍ]/g, 'ی')
    .replace(/[ك]/g, 'ک')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/[ۀ]/g, 'ه')
    .replace(/[ة]/g, 'ه')
    // Optional vowel marks and the tatweel used to stretch a word.
    .replace(/[ً-ْٰـ]/g, '')
    // Zero-width joiners and non-joiners: invisible, and usually not typed.
    .replace(/[​-‏⁠﻿]/g, '')
    // Arabic-Indic and extended Arabic-Indic digits to ASCII.
    .replace(/[٠-٩]/g, function (d) { return String(d.charCodeAt(0) - 0x0660); })
    .replace(/[۰-۹]/g, function (d) { return String(d.charCodeAt(0) - 0x06F0); })
    // Runs of whitespace are one space.
    .replace(/\s+/g, ' ')
    .trim();
  }

  /** Does this text contain the query, ignoring how either is spelled? */
  function matches(text, query) {
    var q = normalise(query);
    if (!q) return false;
    return normalise(text).indexOf(q) !== -1;
  }

  /** Search already-decrypted messages, newest first. */
  function searchLocal(messages, query, limit) {
    if (limit === undefined) limit = 500;
    var q = normalise(query);
    if (q.length < 2) return [];
    var out = [];
    // Backwards: the newest match is the one most likely to be wanted, and
    // this way the limit keeps the newest rather than the oldest.
    for (var i = messages.length - 1; i >= 0 && out.length < limit; i--) {
      var m = messages[i];
      if (m && typeof m.content === 'string' && matches(m.content, q)) out.push(m);
    }
    return out;
  }

  /**
   * One list of results from the server's and the device's.
   *
   * Both can legitimately return the same message: a chat may hold plain and
   * encrypted messages side by side, from before encryption was switched on.
   */
  function mergeResults(server, local) {
    var seen = {};
    var out = [];
    var all = (server || []).concat(local || []);
    for (var i = 0; i < all.length; i++) {
      var m = all[i];
      if (!m) continue;
      var key = String(m.id);
      if (seen[key]) continue;
      seen[key] = true;
      out.push(m);
    }
    // Newest first, by id — the same order the server returns.
    return out.sort(function (a, b) { return Number(b.id) - Number(a.id); });
  }

  root.LocalSearch = {
    normalise: normalise,
    matches: matches,
    searchLocal: searchLocal,
    mergeResults: mergeResults,
  };
})(typeof window !== 'undefined' ? window : globalThis);

if (typeof module !== 'undefined' && module.exports) {
  module.exports = (typeof window !== 'undefined' ? window : globalThis).LocalSearch;
}
