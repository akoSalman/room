// The web's copy of "which links a chat holds when the server cannot read it".
//
// A mirror of native-app/src/mediaLinks.ts, compared function by function in
// test/mediaLinks.test.js. The reasoning — why an encrypted DM's links tab was
// permanently empty, and why the device has to do this work — is written out
// in full there.
(function (global) {
  'use strict';

  var LINK_SRC = '(https?:\\/\\/[^\\s]+|(?:[a-zA-Z0-9-]+\\.)+[a-zA-Z]{2,}(?:\\/[^\\s]*)?)';

  function extractLinks(text) {
    var s = String(text || '');
    if (!s) return [];
    return s.match(new RegExp(LINK_SRC, 'g')) || [];
  }

  function linksFrom(messages, max) {
    if (max === undefined) max = 200;
    var seen = Object.create(null);
    var out = [];
    var list = messages || [];
    for (var i = 0; i < list.length; i++) {
      var m = list[i];
      var urls = extractLinks(m && m.content ? m.content : '');
      for (var j = 0; j < urls.length; j++) {
        if (seen[urls[j]]) continue;
        seen[urls[j]] = true;
        out.push({ url: urls[j], msgId: m.id });
        if (out.length >= max) return out;
      }
    }
    return out;
  }

  function mergeLinks(server, local, max) {
    if (max === undefined) max = 200;
    var byUrl = new Map();
    var all = (server || []).concat(local || []);
    for (var i = 0; i < all.length; i++) {
      var item = all[i];
      if (!item || !item.url) continue;
      var had = byUrl.get(item.url);
      if (!had || (had.msgId == null && item.msgId != null)
        || (had.msgId != null && item.msgId != null && Number(item.msgId) > Number(had.msgId))) {
        byUrl.set(item.url, item);
      }
    }
    var out = [];
    byUrl.forEach(function (v) { out.push(v); });
    out.sort(function (a, b) {
      return (a.msgId == null ? -1 : Number(a.msgId)) < (b.msgId == null ? -1 : Number(b.msgId)) ? 1 : -1;
    });
    return out.slice(0, max);
  }

  global.MediaLinks = {
    LINK_SRC: LINK_SRC,
    extractLinks: extractLinks,
    linksFrom: linksFrom,
    mergeLinks: mergeLinks,
  };
})(typeof window !== 'undefined' ? window : globalThis);

if (typeof module !== 'undefined' && module.exports) {
  module.exports = (typeof window !== 'undefined' ? window : globalThis).MediaLinks;
}
