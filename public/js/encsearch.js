// ── Searching encrypted messages, in the browser ────────────────────────────
//
// The server holds ciphertext and no key, so it cannot match these messages.
// It reported how many it had skipped — honest, and no help to somebody trying
// to find their own message.
//
// So it hands the ciphertext over instead. The decryption and the matching
// happen here: no plaintext and no search term ever leaves the browser. Same
// division of labour the app uses, and the same one Telegram uses for Secret
// Chats — either the server can read the text and can therefore index it, or
// the device does the work. There is no third option.
(function () {
  'use strict';

  /**
   * Decrypt what the server could not search, and match it here.
   *
   * Returns the extra hits and how many messages are STILL beyond reach — the
   * ones past the server's handover cap. Reporting the whole encrypted count
   * would warn about messages that were, in fact, searched.
   */
  async function search(roomId, term) {
    var key = window.currentDMPeerPk;
    if (!key) return { results: [], stillSkipped: 0 };

    var enc = await window.api('/encrypted-messages/' + roomId);
    if (!enc || enc.error || !Array.isArray(enc.messages)) {
      return { results: [], stillSkipped: 0 };
    }

    var plain = enc.messages.map(function (m) {
      var text = m.content;
      if (window.E2E.isEncrypted(text)) text = window.E2E.decrypt(text, key) || '';
      return Object.assign({}, m, { content: text });
    });

    return {
      results: window.LocalSearch.searchLocal(plain, term),
      stillSkipped: Math.max(0, (enc.total || 0) - enc.messages.length),
    };
  }

  window.EncSearch = { search: search };
})();
