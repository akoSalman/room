// ── The gallery, with no connection ─────────────────────────────────────────
//
// Reported twice. The second time: "still gallery is not loaded after closing
// app and turning off internet and opening app again — gallery should keep
// downloaded files and images as download even after closing app several
// times".
//
// The first round fixed the LIST: it lived in a Map that died with the
// process, and it is written to the device now. That was necessary and not
// sufficient, because a list of photographs is not photographs.
//
// Every tile in the grid is a network request. It asks for /thumb/<name>, a
// size the server renders on demand, and the only thing that has ever made
// that work twice is expo-image's own disk cache — which this app does not
// control, keys on the whole URL including a signature that rotates every
// day, and evicts on its own terms. With no connection and a cold cache there
// is nothing to draw, however many of those pictures the phone is holding.
//
// And it IS holding them. mediaCache keeps every full-size photo the person
// has actually looked at, under a key with the signature stripped, for as
// long as the two-gigabyte cap allows. The gallery simply never asked.
//
// ── Why the obvious fix is a trap ───────────────────────────────────────────
//
// The tempting change is to put the thumbnails in mediaCache too. Do not:
// mediaCache keys on the URL's BASENAME with the query stripped, so
//
//     /uploads/1760-12.jpg?e=…&s=…      -> md-1760-12.jpg
//     /thumb/1760-12.jpg?w=96&e=…&s=…   -> md-1760-12.jpg
//
// are the same key. Caching a thumbnail would overwrite the full-size photo
// with a 96-pixel one, and every bubble in the chat would quietly start
// showing a blurred square. There is a test for this.
//
// So the tile falls back to the picture the device already has, at the moment
// the thumbnail fails and not before. Online it costs nothing.

/**
 * The absolute URL of the full-size image behind a gallery item.
 *
 * Items carry a server path (`/uploads/x.jpg?e=…`), but a few arrive already
 * absolute, and a file:// one is already local and must be returned untouched
 * rather than having a host glued to the front of it.
 */
export function fullImageUrl(uploadPath: unknown, baseUrl: unknown): string | null {
  const p = typeof uploadPath === 'string' ? uploadPath.trim() : '';
  if (!p) return null;
  // Already somewhere: another origin, or a file already on this device.
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(p)) return p;
  const base = typeof baseUrl === 'string' ? baseUrl.replace(/\/+$/, '') : '';
  if (!base) return null;
  return p.startsWith('/') ? base + p : `${base}/${p}`;
}

/**
 * What a tile should draw.
 *
 * `local` is whatever the device turned out to be holding, and it wins once it
 * is known — it is the same picture, and it needs no network. Until then the
 * thumbnail is used, which is the smaller file and the faster one.
 *
 * Kept apart from the component because getting it the wrong way round is not
 * visible in a screenshot: preferring the local copy TOO EARLY would draw a
 * full-size photograph into every 96-pixel square in the grid, which is the
 * memory the thumbnails exist to avoid.
 */
export function tileUri(o: { thumb?: string | null; local?: string | null }): string | null {
  const local = typeof o?.local === 'string' && o.local ? o.local : null;
  if (local) return local;
  const thumb = typeof o?.thumb === 'string' && o.thumb ? o.thumb : null;
  return thumb;
}

/**
 * Is it worth asking the device for this one?
 *
 * Only after the thumbnail has actually failed. Asking up front would be a
 * disk check for every tile in a grid of two thousand, on the open the person
 * is already waiting through — and online the thumbnail never fails, so the
 * answer would always be "not needed".
 */
export function shouldLookLocally(o: { failed?: boolean; have?: string | null }): boolean {
  if (o?.have) return false;
  return !!o?.failed;
}
