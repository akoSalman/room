// The web's copy of "an indicator is a claim that was true a moment ago".
//
// A mirror of native-app/src/liveIndicator.ts, compared function by function
// in test/liveIndicator.test.js. Why "Dr.Soran is recording…" stood on screen
// for somebody who had gone offline — and why these are heartbeats rather than
// latches — is written out in full there.
(function (global) {
  'use strict';

  var HEARTBEAT_MS = 3000;
  var EXPIRY_MS = 8000;

  function note(claims, name, now) {
    var out = {};
    var c = claims || {};
    for (var k in c) if (Object.prototype.hasOwnProperty.call(c, k)) out[k] = c[k];
    var who = String(name === null || name === undefined ? '' : name).replace(/^\s+|\s+$/g, '');
    if (!who) return out;
    var t = Number(now);
    out[who] = isFinite(t) ? t : 0;
    return out;
  }

  function drop(claims, name) {
    var out = {};
    var c = claims || {};
    for (var k in c) if (Object.prototype.hasOwnProperty.call(c, k)) out[k] = c[k];
    delete out[String(name === null || name === undefined ? '' : name).replace(/^\s+|\s+$/g, '')];
    return out;
  }

  function active(claims, now, expiryMs) {
    if (expiryMs === undefined) expiryMs = EXPIRY_MS;
    var c = claims || {};
    var t = Number(now);
    if (!isFinite(t)) return [];
    var out = [];
    for (var name in c) {
      if (!Object.prototype.hasOwnProperty.call(c, name)) continue;
      var at = Number(c[name]);
      if (!isFinite(at) || at <= 0) continue;
      if (t - at < expiryMs) out.push(name);
    }
    return out;
  }

  function anyActive(claims, now, expiryMs) {
    return active(claims, now, expiryMs).length > 0;
  }

  global.LiveIndicator = {
    HEARTBEAT_MS: HEARTBEAT_MS,
    EXPIRY_MS: EXPIRY_MS,
    note: note,
    drop: drop,
    active: active,
    anyActive: anyActive,
  };
})(typeof window !== 'undefined' ? window : globalThis);

if (typeof module !== 'undefined' && module.exports) {
  module.exports = (typeof window !== 'undefined' ? window : globalThis).LiveIndicator;
}
