// ── Playing a link from SoundCloud, YouTube, Aparat… inside the app ──────────
//
// Asked for as: music from SoundCloud and other music or video platforms
// should be playable in the app if it is possible.
//
// What is possible, and what is not, is worth writing down because the second
// half is the part that will disappoint:
//
//   • POSSIBLE, and done here: each of these platforms publishes an official
//     embedded player — a small page they host, meant to be put inside another
//     app. Given a link, this file works out that player's address, and the
//     app opens it in a web view instead of throwing the user out into a
//     browser. The platform serves its own audio or video, counts its own
//     play, and shows its own advertising, which is the arrangement they offer
//     and the only one that is theirs to give.
//
//   • NOT possible, deliberately: pulling the audio file out of a SoundCloud
//     or YouTube page and streaming it through our own server. It would work
//     where the platforms are blocked — which is exactly why it is tempting —
//     but it is against the terms of every one of them, it would put the
//     brand's server in the business of redistributing other people's
//     copyrighted music, and one popular track would cost more bandwidth than
//     the whole chat does in a month.
//
// The consequence, and it must not be hidden from the user: an embedded player
// still fetches its media from the platform. Where a platform is unreachable
// the player will not load, and the app says so and offers the browser rather
// than spinning. Aparat and the other local platforms are reachable and work;
// YouTube and SoundCloud need whatever the user already uses to reach them.

export type Platform =
  | 'youtube' | 'soundcloud' | 'vimeo' | 'aparat' | 'dailymotion' | 'spotify';

export type Media = {
  platform: Platform;
  /** Video for a player with a picture, audio for one that is a strip. */
  kind: 'video' | 'audio';
  /** The platform's own embedded player, ready to load. */
  embed: string;
  /** Where the tap would otherwise have gone. */
  original: string;
  /** Seconds into the track the link points at, when it says. */
  start: number;
};

/** Human name, for the button under the cover. */
export const PLATFORM_NAMES: Record<Platform, string> = {
  youtube: 'YouTube', soundcloud: 'SoundCloud', vimeo: 'Vimeo',
  aparat: 'Aparat', dailymotion: 'Dailymotion', spotify: 'Spotify',
};

/**
 * Is this platform likely to load without help where these users are?
 *
 * Used for what the app says when a player fails, not for whether to offer it
 * — plenty of people have a way through, and refusing to try on their behalf
 * would be worse than a failed load.
 */
/**
 * The hosts SoundCloud's own share sheet produces.
 *
 * None of these carry the track's name — only the platform can say what they
 * point at, which is why the widget is handed the short link untouched.
 */
const SC_SHORT = new Set(['on.soundcloud.com', 'snd.sc', 'soundcloud.app.goo.gl']);

export function localToIran(p: Platform): boolean {
  return p === 'aparat';
}

function host(u: URL): string {
  return u.hostname.toLowerCase().replace(/^(?:www|m|mobile)\./, '');
}

/** `?t=90`, `?t=1m30s`, `#t=90` — the moment the sender meant. */
export function startSeconds(u: URL): number {
  const raw = u.searchParams.get('t') || u.searchParams.get('start')
    || u.searchParams.get('time_continue') || /(?:^|[#&])t=([^&]+)/.exec(u.hash)?.[1] || '';
  if (!raw) return 0;
  if (/^\d+$/.test(raw)) return parseInt(raw, 10);
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(raw);
  if (!m || !(m[1] || m[2] || m[3])) return 0;
  return (+(m[1] || 0)) * 3600 + (+(m[2] || 0)) * 60 + (+(m[3] || 0));
}

const YT_ID = /^[\w-]{11}$/;

/**
 * What this link plays, and where its player lives.
 *
 * Returns null for anything that is not one of these platforms, or is one of
 * them but not a playable page — a channel, a search, somebody's profile.
 * Offering a play button that opens an empty player is worse than not
 * offering one.
 */
export function detect(raw: string | null | undefined): Media | null {
  let u: URL;
  try { u = new URL(String(raw || '')); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const h = host(u);
  const start = startSeconds(u);
  const made = (platform: Platform, kind: 'video' | 'audio', embed: string): Media =>
    ({ platform, kind, embed, original: u.toString(), start });

  // ── YouTube ───────────────────────────────────────────────────────────────
  if (h === 'youtube.com' || h === 'youtu.be' || h === 'youtube-nocookie.com') {
    let id = '';
    if (h === 'youtu.be') id = u.pathname.slice(1).split('/')[0];
    else if (u.pathname === '/watch') id = u.searchParams.get('v') || '';
    else {
      const m = /^\/(?:embed|v|shorts|live)\/([^/?#]+)/.exec(u.pathname);
      if (m) id = m[1];
    }
    if (!YT_ID.test(id)) return null;   // a channel, a playlist, a search
    // nocookie is YouTube's own privacy-preserving host for embeds; playsinline
    // keeps it in the card rather than taking over the screen on iOS.
    const q = new URLSearchParams({ playsinline: '1', autoplay: '1', rel: '0' });
    if (start) q.set('start', String(start));
    return made('youtube', 'video', `https://www.youtube-nocookie.com/embed/${id}?${q}`);
  }

  // ── SoundCloud ────────────────────────────────────────────────────────────
  //
  // Its OWN share button hands out on.soundcloud.com/xXxXx, which is what
  // people actually paste — and which was not recognised here at all, so every
  // shared track arrived as a plain link with no player. snd.sc was listed
  // below but could never match either: short links have ONE path segment and
  // the rule underneath demands two.
  //
  // The widget resolves these itself, so the short URL is handed over as it
  // stands rather than guessed at.
  if (SC_SHORT.has(h)) {
    if (!u.pathname.split('/').filter(Boolean).length) return null;
    const q = new URLSearchParams({
      url: u.toString(), auto_play: 'true', show_comments: 'false', visual: 'true',
    });
    return made('soundcloud', 'audio', `https://w.soundcloud.com/player/?${q}`);
  }

  if (h === 'soundcloud.com') {
    // The widget takes the track URL itself and resolves it — there is no id
    // in a SoundCloud link to extract.
    const parts = u.pathname.split('/').filter(Boolean);
    // /artist/track and /artist/sets/album are playable; /artist alone is not.
    if (parts.length < 2) return null;
    if (parts[0] === 'you' || parts[0] === 'search' || parts[0] === 'discover') return null;
    const q = new URLSearchParams({
      url: `https://soundcloud.com${u.pathname}`,
      auto_play: 'true', show_comments: 'false', visual: 'true',
    });
    return made('soundcloud', 'audio', `https://w.soundcloud.com/player/?${q}`);
  }

  // ── Vimeo ─────────────────────────────────────────────────────────────────
  if (h === 'vimeo.com' || h === 'player.vimeo.com') {
    const m = /(?:^|\/)(\d{6,})/.exec(u.pathname);
    if (!m) return null;
    const q = new URLSearchParams({ autoplay: '1', playsinline: '1' });
    if (start) q.set('#t', String(start));
    return made('vimeo', 'video', `https://player.vimeo.com/video/${m[1]}?${q}`);
  }

  // ── Aparat ────────────────────────────────────────────────────────────────
  // The one on this list that is reachable here without help, and therefore
  // the one most of these links will actually be.
  if (h === 'aparat.com') {
    const m = /^\/v\/([\w-]+)/.exec(u.pathname);
    if (!m) return null;
    return made('aparat', 'video', `https://www.aparat.com/video/video/embed/videohash/${m[1]}/vt/frame${start ? `?startTime=${start}` : ''}`);
  }

  // ── Dailymotion ───────────────────────────────────────────────────────────
  if (h === 'dailymotion.com' || h === 'dai.ly') {
    const m = h === 'dai.ly' ? /^\/([\w]+)/.exec(u.pathname) : /^\/video\/([\w]+)/.exec(u.pathname);
    if (!m) return null;
    return made('dailymotion', 'video',
      `https://www.dailymotion.com/embed/video/${m[1]}?autoplay=1${start ? `&start=${start}` : ''}`);
  }

  // ── Spotify ───────────────────────────────────────────────────────────────
  if (h === 'open.spotify.com') {
    const m = /^\/(track|album|playlist|episode|show)\/([\w]+)/.exec(u.pathname);
    if (!m) return null;
    // Spotify's embed plays a 30-second preview to anybody not signed in, and
    // the whole track to anybody who is. Both are the platform's own choice.
    return made('spotify', 'audio', `https://open.spotify.com/embed/${m[1]}/${m[2]}`);
  }

  return null;
}

/** Is there an in-app player for this link at all? */
export function playable(raw: string | null | undefined): boolean {
  return !!detect(raw);
}

/** What the button over the cover says. */
export function playLabel(m: Media | null | undefined): string {
  if (!m) return '';
  return m.kind === 'audio' ? `Play on ${PLATFORM_NAMES[m.platform]}` : `Watch on ${PLATFORM_NAMES[m.platform]}`;
}

/**
 * What to say when the player does not load.
 *
 * Never "something went wrong": for these users the overwhelmingly likely
 * reason is that the platform is unreachable from here, and saying so — with
 * the browser as the way out — is the difference between a dead end and a
 * choice.
 */
export function failureMessage(m: Media | null | undefined): string {
  if (!m) return 'This link could not be opened.';
  const name = PLATFORM_NAMES[m.platform];
  return localToIran(m.platform)
    ? `${name} did not respond. Try again, or open it in your browser.`
    : `${name} could not be reached from this connection. Open it in your browser instead.`;
}

/** How tall the player should be, given the width it has. */
export function playerHeight(kind: 'video' | 'audio', width: number): number {
  // An audio widget is a strip: a 16:9 box around it is empty black.
  if (kind === 'audio') return 166;
  return Math.round(width * 9 / 16);
}
