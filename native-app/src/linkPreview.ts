// ── The card under a message that contains a link ────────────────────────────
//
// Asked for as: add a preview of the cover and title for links sent in chats
// or rooms.
//
// A link on its own is unreadable. `https://t.me/c/1234/56` tells the person
// receiving it nothing about whether it is worth the tap — and for these users
// a tap is expensive: it leaves the app, opens a browser, and often waits on a
// site that is slow or blocked. A title and a cover answer the question before
// any of that happens.
//
// Three decisions live here rather than in the screens, because both clients
// have to make them identically and because getting them wrong is invisible:
//
//   1. WHICH url in a message gets the card. One, always the first — a message
//      with five links would otherwise be five cards tall and push everything
//      else off the screen.
//   2. WHETHER a link is worth asking about at all. Bare IP addresses, links to
//      a file that is already an image or a video, and anything that is not
//      http(s) are not pages with a title, and asking about them costs a round
//      trip per message for a card that will never appear.
//   3. WHETHER what came back is worth drawing. A card with no title and no
//      cover is an empty grey box under the message; that is worse than the
//      bare link, and it is what most sites behind a login return.
//
// The fetching itself is the server's job (see /link-preview): these users
// cannot reach most foreign hosts, and a client that fetched pages directly
// would also hand every site they are sent a link to their IP address and a
// request they never made.

export type LinkMeta = {
  url?: string | null;
  title?: string | null;
  description?: string | null;
  /** Already a path on our own server — never a foreign URL. */
  image?: string | null;
  siteName?: string | null;
};

/** Files that are their own preview, or are not pages at all. */
const NOT_A_PAGE = /\.(?:jpe?g|png|gif|webp|bmp|svg|mp4|mov|m4v|webm|mp3|m4a|ogg|wav|pdf|apk|zip|rar|7z|exe|dmg|iso)(?:[?#]|$)/i;

/**
 * Turn a token as it was typed into an absolute URL, or null.
 *
 * People type `example.com`, and the tokenizer marks it as a URL without a
 * scheme. `https` rather than `http`: a downgrade would be our doing, not
 * theirs, and most sites redirect anyway.
 */
export function normalizeUrl(raw: string | null | undefined): string | null {
  const t = String(raw ?? '').trim();
  if (!t) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(t) ? t : `https://${t}`;
  if (!/^https?:\/\//i.test(withScheme)) return null;   // mailto:, tel:, javascript:
  let u: URL;
  try { u = new URL(withScheme); } catch { return null; }
  if (!u.hostname || !u.hostname.includes('.')) return null;
  if (u.username || u.password) return null;            // credentials in a URL are a trap
  // A bare address is never a page worth a card, and asking about one is how a
  // preview endpoint gets talked into scanning a network.
  if (/^[\d.]+$/.test(u.hostname) || u.hostname.includes(':')) return null;
  u.hash = '';                                          // #section is the same page
  return u.toString();
}

/** Is this link worth asking the server about? */
export function previewable(raw: string | null | undefined): boolean {
  const u = normalizeUrl(raw);
  if (!u) return false;
  return !NOT_A_PAGE.test(u);
}

/**
 * Which link in a message gets the card.
 *
 * The first one, and only the first. A message that is a list of links is a
 * list, not five cards.
 */
export function pickUrl(tokens: { text: string; kind: string }[] | null | undefined): string | null {
  for (const t of tokens || []) {
    if (t.kind !== 'url') continue;
    if (previewable(t.text)) return normalizeUrl(t.text);
  }
  return null;
}

/**
 * Is there enough here to draw?
 *
 * A title alone makes a good card; a cover alone still tells you where you are
 * going. Neither is an empty grey box, which is worse than the bare link.
 */
export function worthShowing(meta: LinkMeta | null | undefined): boolean {
  if (!meta) return false;
  return !!(trimTitle(meta.title) || meta.image);
}

/** One line, at most. Titles from news sites run to a full paragraph. */
export function trimTitle(s: string | null | undefined, max = 90): string {
  return clip(s, max);
}

/** Two lines, at most — the card must never be taller than the message. */
export function trimDescription(s: string | null | undefined, max = 140): string {
  return clip(s, max);
}

function clip(s: string | null | undefined, max: number): string {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  // Cut at a word where there is one nearby, so the ellipsis does not land in
  // the middle of a word for the sake of four characters.
  const cut = t.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).trimEnd() + '…';
}

/**
 * What to show as the source, under the title.
 *
 * The site's own name when it gave one, otherwise the host without `www.` —
 * which is what people actually recognise.
 */
export function displayHost(meta: LinkMeta | null | undefined): string {
  const name = String(meta?.siteName ?? '').trim();
  if (name) return clip(name, 40);
  try {
    return new URL(String(meta?.url ?? '')).hostname.replace(/^www\./i, '');
  } catch { return ''; }
}

/**
 * Should the card be asked for again?
 *
 * Only a *failure* is ever retried, and not straight away: a link to a site
 * that is blocked here fails for every message that carries it, and retrying
 * on every render would be a tight loop against a host that is not answering.
 */
export function shouldRetry(o: {
  state: 'none' | 'loading' | 'done' | 'failed';
  failedAt?: number | null;
  now: number;
  cooldownMs?: number;
}): boolean {
  if (o.state !== 'failed') return false;
  const cool = o.cooldownMs ?? 10 * 60 * 1000;
  return !o.failedAt || o.now - o.failedAt >= cool;
}
