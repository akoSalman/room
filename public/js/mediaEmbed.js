// The web's copy of "which links can be played in place, and with what player".
//
// A mirror of native-app/src/mediaEmbed.ts, compared against it link by link
// in test/mediaEmbed.test.js. The reasoning — why the platform's own embedded
// player and not the audio file itself — is written out in full there.
(function (global) {
  var PLATFORM_NAMES = {
    youtube: 'YouTube', soundcloud: 'SoundCloud', vimeo: 'Vimeo',
    aparat: 'Aparat', dailymotion: 'Dailymotion', spotify: 'Spotify',
  };
  var YT_ID = /^[\w-]{11}$/;

  // The hosts SoundCloud's own share sheet produces — see mediaEmbed.ts.
  var SC_SHORT = ['on.soundcloud.com', 'snd.sc', 'soundcloud.app.goo.gl'];

  function localToIran(p) { return p === 'aparat'; }
  function host(u) { return u.hostname.toLowerCase().replace(/^(?:www|m|mobile)\./, ''); }

  function startSeconds(u) {
    var hashT = /(?:^|[#&])t=([^&]+)/.exec(u.hash);
    var raw = u.searchParams.get('t') || u.searchParams.get('start')
      || u.searchParams.get('time_continue') || (hashT ? hashT[1] : '') || '';
    if (!raw) return 0;
    if (/^\d+$/.test(raw)) return parseInt(raw, 10);
    var m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(raw);
    if (!m || !(m[1] || m[2] || m[3])) return 0;
    return (+(m[1] || 0)) * 3600 + (+(m[2] || 0)) * 60 + (+(m[3] || 0));
  }

  function detect(raw) {
    var u;
    try { u = new URL(String(raw || '')); } catch (e) { return null; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    var h = host(u);
    var start = startSeconds(u);
    function made(platform, kind, embed) {
      return { platform: platform, kind: kind, embed: embed, original: u.toString(), start: start };
    }

    if (h === 'youtube.com' || h === 'youtu.be' || h === 'youtube-nocookie.com') {
      var id = '';
      if (h === 'youtu.be') id = u.pathname.slice(1).split('/')[0];
      else if (u.pathname === '/watch') id = u.searchParams.get('v') || '';
      else {
        var my = /^\/(?:embed|v|shorts|live)\/([^/?#]+)/.exec(u.pathname);
        if (my) id = my[1];
      }
      if (!YT_ID.test(id)) return null;
      var q = new URLSearchParams({ playsinline: '1', autoplay: '1', rel: '0' });
      if (start) q.set('start', String(start));
      return made('youtube', 'video', 'https://www.youtube-nocookie.com/embed/' + id + '?' + q);
    }

    // Its own share button hands out on.soundcloud.com/xXxXx, which was not
    // recognised at all — so every shared track arrived as a plain link with
    // no player. The widget resolves these itself.
    if (SC_SHORT.indexOf(h) !== -1) {
      if (!u.pathname.split('/').filter(Boolean).length) return null;
      var qsh = new URLSearchParams({
        url: u.toString(), auto_play: 'true', show_comments: 'false', visual: 'true',
      });
      return made('soundcloud', 'audio', 'https://w.soundcloud.com/player/?' + qsh);
    }

    if (h === 'soundcloud.com') {
      var parts = u.pathname.split('/').filter(Boolean);
      if (parts.length < 2) return null;
      if (parts[0] === 'you' || parts[0] === 'search' || parts[0] === 'discover') return null;
      var qs = new URLSearchParams({
        url: 'https://soundcloud.com' + u.pathname,
        auto_play: 'true', show_comments: 'false', visual: 'true',
      });
      return made('soundcloud', 'audio', 'https://w.soundcloud.com/player/?' + qs);
    }

    if (h === 'vimeo.com' || h === 'player.vimeo.com') {
      var mv = /(?:^|\/)(\d{6,})/.exec(u.pathname);
      if (!mv) return null;
      var qv = new URLSearchParams({ autoplay: '1', playsinline: '1' });
      if (start) qv.set('#t', String(start));
      return made('vimeo', 'video', 'https://player.vimeo.com/video/' + mv[1] + '?' + qv);
    }

    if (h === 'aparat.com') {
      var ma = /^\/v\/([\w-]+)/.exec(u.pathname);
      if (!ma) return null;
      return made('aparat', 'video', 'https://www.aparat.com/video/video/embed/videohash/' + ma[1]
        + '/vt/frame' + (start ? '?startTime=' + start : ''));
    }

    if (h === 'dailymotion.com' || h === 'dai.ly') {
      var md = h === 'dai.ly' ? /^\/([\w]+)/.exec(u.pathname) : /^\/video\/([\w]+)/.exec(u.pathname);
      if (!md) return null;
      return made('dailymotion', 'video', 'https://www.dailymotion.com/embed/video/' + md[1]
        + '?autoplay=1' + (start ? '&start=' + start : ''));
    }

    if (h === 'open.spotify.com') {
      var ms = /^\/(track|album|playlist|episode|show)\/([\w]+)/.exec(u.pathname);
      if (!ms) return null;
      return made('spotify', 'audio', 'https://open.spotify.com/embed/' + ms[1] + '/' + ms[2]);
    }

    return null;
  }

  function playable(raw) { return !!detect(raw); }

  function playLabel(m) {
    if (!m) return '';
    return (m.kind === 'audio' ? 'Play on ' : 'Watch on ') + PLATFORM_NAMES[m.platform];
  }

  function failureMessage(m) {
    if (!m) return 'This link could not be opened.';
    var name = PLATFORM_NAMES[m.platform];
    return localToIran(m.platform)
      ? name + ' did not respond. Try again, or open it in your browser.'
      : name + ' could not be reached from this connection. Open it in your browser instead.';
  }

  function playerHeight(kind, width) {
    if (kind === 'audio') return 166;
    return Math.round(width * 9 / 16);
  }

  global.MediaEmbed = {
    PLATFORM_NAMES: PLATFORM_NAMES, localToIran: localToIran, startSeconds: startSeconds,
    detect: detect, playable: playable, playLabel: playLabel,
    failureMessage: failureMessage, playerHeight: playerHeight,
  };
})(typeof window !== 'undefined' ? window : this);
