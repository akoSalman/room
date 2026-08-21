// ── Typing an @name (web) ───────────────────────────────────────────────────
//
// Mirrors native-app/src/mentions.ts, and checked against it by a test.
//
// The fiddly part is not the dropdown, it is deciding when "@" starts a
// mention and when it is just a character in the middle of something else — an
// email address, a price, "a@b". Getting that wrong pops a suggestion list
// over the keyboard while somebody is typing an email address.
(function (root) {
  'use strict';

  /** Same character set the server and the tokenizer accept in a username. */
  var NAME_CHARS = /^[a-zA-Z0-9._]*$/;

  /**
   * If the caret sits inside an @name still being typed, return where that
   * name begins and what has been typed so far (without the @).
   */
  function mentionQuery(text, caret) {
    if (caret < 0 || caret > text.length) return null;
    var upto = text.slice(0, caret);
    var at = upto.lastIndexOf('@');
    if (at === -1) return null;

    // An @ must start a word. Anything word-like immediately before it means
    // this is an email address or similar, not a mention.
    var before = at > 0 ? upto[at - 1] : '';
    if (before && !/\s/.test(before)) return null;

    var query = upto.slice(at + 1);
    // A space — or any other character a username cannot contain — ends the
    // mention; past that point the person has moved on.
    if (!NAME_CHARS.test(query)) return null;
    if (query.length > 20) return null;

    return { start: at, query: query };
  }

  /**
   * Replace the partially typed name with the chosen one, leaving a trailing
   * space so the next word can just be typed.
   */
  function applyMention(text, start, caret, username) {
    var head = text.slice(0, start);
    var tail = text.slice(caret);
    // Only add the space if there is not one already — completing a name in
    // the middle of a sentence should not leave a double space behind.
    var inserted = '@' + username + (/^\s/.test(tail) ? '' : ' ');
    return { text: head + inserted + tail, caret: head.length + inserted.length };
  }

  /**
   * The names to offer: prefix matches first, so typing "@al" puts "ali"
   * above "kamal".
   */
  function filterUsernames(usernames, query, limit) {
    if (limit === undefined) limit = 6;
    var q = String(query || '').toLowerCase();
    if (!q) return usernames.slice(0, limit);
    var prefix = [], rest = [];
    for (var i = 0; i < usernames.length; i++) {
      var u = usernames[i], l = u.toLowerCase();
      if (l.indexOf(q) === 0) prefix.push(u);
      else if (l.indexOf(q) !== -1) rest.push(u);
    }
    return prefix.concat(rest).slice(0, limit);
  }

  root.Mentions = {
    mentionQuery: mentionQuery,
    applyMention: applyMention,
    filterUsernames: filterUsernames,
  };
})(typeof window !== 'undefined' ? window : globalThis);

if (typeof module !== 'undefined' && module.exports) {
  module.exports = (typeof window !== 'undefined' ? window : globalThis).Mentions;
}
