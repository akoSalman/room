// The web's copy of "cannot read this YET vs cannot read this at all".
//
// A mirror of native-app/src/e2eState.ts, compared function by function in
// test/e2eState.test.js. The reasoning — why a chat spent two seconds telling
// people their conversation was lost, and why it then stayed that way — is
// written out in full there.
(function (global) {
  'use strict';

  var RETRY_LADDER = [400, 1200, 3000, 6000];
  var KEY_ATTEMPTS = RETRY_LADDER.length + 1;

  function keyRetryDelay(attempt) {
    var i = Math.min(Math.max(Math.floor(attempt), 0), RETRY_LADDER.length - 1);
    return RETRY_LADDER[i];
  }

  function keepTryingKey(attempt) {
    return attempt < KEY_ATTEMPTS;
  }

  function phaseFor(o) {
    if (o && o.hasKey) return 'ready';
    if (!o || !o.ready) return 'unavailable';
    return keepTryingKey(o.attempts) ? 'waiting' : 'unavailable';
  }

  function stillTrying(phase) { return phase === 'waiting'; }

  function undecryptedBody(phase) {
    return phase === 'waiting'
      ? '🔒 Decrypting…'
      : '🔒 Encrypted message (cannot decrypt on this device)';
  }

  function undecryptedQuote(phase) {
    return phase === 'waiting' ? '🔒 Decrypting…' : '🔒 Encrypted';
  }

  function repaintNeeded(prev, next) {
    return !(prev && prev.hasKey) && !!(next && next.hasKey);
  }

  global.E2EState = {
    KEY_ATTEMPTS: KEY_ATTEMPTS,
    keyRetryDelay: keyRetryDelay,
    keepTryingKey: keepTryingKey,
    phaseFor: phaseFor,
    stillTrying: stillTrying,
    undecryptedBody: undecryptedBody,
    undecryptedQuote: undecryptedQuote,
    repaintNeeded: repaintNeeded,
  };
})(typeof window !== 'undefined' ? window : globalThis);

if (typeof module !== 'undefined' && module.exports) {
  module.exports = (typeof window !== 'undefined' ? window : globalThis).E2EState;
}
