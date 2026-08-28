// The web's copy of the link-preview rules.
//
// Deliberately a mirror of native-app/src/linkPreview.ts, function for
// function: a link that gets a card in the app and a bare URL on the web is a
// bug in whichever is behind. test/linkPreview.test.js compares the two over
// every input that changes an answer, so this file cannot drift quietly.
(function (global) {
  var NOT_A_PAGE = /\.(?:jpe?g|png|gif|webp|bmp|svg|mp4|mov|m4v|webm|mp3|m4a|ogg|wav|pdf|apk|zip|rar|7z|exe|dmg|iso)(?:[?#]|$)/i;

  function normalizeUrl(raw) {
    var t = String(raw == null ? '' : raw).trim();
    if (!t) return null;
    var withScheme = /^[a-z][a-z0-9+.-]*:/i.test(t) ? t : 'https://' + t;
    if (!/^https?:\/\//i.test(withScheme)) return null;
    var u;
    try { u = new URL(withScheme); } catch (e) { return null; }
    if (!u.hostname || u.hostname.indexOf('.') === -1) return null;
    if (u.username || u.password) return null;
    if (/^[\d.]+$/.test(u.hostname) || u.hostname.indexOf(':') !== -1) return null;
    u.hash = '';
    return u.toString();
  }

  function previewable(raw) {
    var u = normalizeUrl(raw);
    if (!u) return false;
    return !NOT_A_PAGE.test(u);
  }

  function pickUrl(tokens) {
    var list = tokens || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].kind !== 'url') continue;
      if (previewable(list[i].text)) return normalizeUrl(list[i].text);
    }
    return null;
  }

  function clip(s, max) {
    var t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    if (t.length <= max) return t;
    var cut = t.slice(0, max);
    var sp = cut.lastIndexOf(' ');
    return (sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/\s+$/, '') + '…';
  }

  function trimTitle(s, max) { return clip(s, max === undefined ? 90 : max); }
  function trimDescription(s, max) { return clip(s, max === undefined ? 140 : max); }

  function worthShowing(meta) {
    if (!meta) return false;
    return !!(trimTitle(meta.title) || meta.image);
  }

  function displayHost(meta) {
    var name = String((meta && meta.siteName) || '').trim();
    if (name) return clip(name, 40);
    try {
      return new URL(String((meta && meta.url) || '')).hostname.replace(/^www\./i, '');
    } catch (e) { return ''; }
  }

  function shouldRetry(o) {
    if (o.state !== 'failed') return false;
    var cool = o.cooldownMs === undefined ? 10 * 60 * 1000 : o.cooldownMs;
    return !o.failedAt || o.now - o.failedAt >= cool;
  }

  global.LinkPreview = {
    normalizeUrl: normalizeUrl,
    previewable: previewable,
    pickUrl: pickUrl,
    worthShowing: worthShowing,
    trimTitle: trimTitle,
    trimDescription: trimDescription,
    displayHost: displayHost,
    shouldRetry: shouldRetry,
  };
})(typeof window !== 'undefined' ? window : this);
