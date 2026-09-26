// ── Where a downloaded file goes, and what it is called ────────────────────
//
// Photographed: downloading a photo in a private room produced TWO messages —
// the "Saved to your device" indicator AND a dialog reading
//
//     Downloaded
//     Saved as 1790426577952-41739317.jpg?e=1791072000000&s=crcyuha3xLWbXEUhYB7yP3jd3FulzVWa
//
// and the photo was then not in the gallery.
//
// Both halves of that come from two lines.
//
// THE NAME. It was taken as `url.split('/').pop()`, which is everything after
// the last slash — including the query string. Our media URLs are HMAC-signed,
// so that is an expiry and a signature, and the file was written to disk under
// a name ending in `.jpg?e=…&s=…`. Android decides what a file IS from its
// extension, and the extension of that is `jpg?e=1791072000000&s=crcyuha…`,
// which is nothing. So it is not an image, and nothing that looks for images
// will ever show it.
//
// WHERE IT GOES. That was decided by the message's `type` field. When the
// type was not one of image/gallery/video the file was treated as a document:
// saved to the cache and announced in a dialog, with no call to the media
// library at all. A photo is a photo whatever the message record happens to
// say about it, and deciding from the FILE is both simpler and right in the
// cases the type field is not.
//
// The second message follows from the first: the dialog exists to tell you
// where a document went, because the indicator has no room for a filename. It
// was appearing over photos only because they were being mistaken for
// documents.

/** Extensions Android's gallery will show, and which therefore belong in it. */
const IMAGE = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'bmp'];
const VIDEO = ['mp4', 'mov', 'm4v', '3gp', 'mkv', 'webm', 'avi'];

/**
 * The name to write on disk.
 *
 * Strips the query string, then the fragment, then anything a filesystem will
 * not take. Falls back to a timestamp rather than to '' — a file called
 * nothing is a write that fails for a reason nobody will work out.
 */
export function fileNameFor(o: {
  url?: string | null; fileName?: string | null; now?: number;
}): string {
  const given = String((o && o.fileName) || '').trim();
  // A server-supplied name is preferred, but only when it is ONE name: a
  // gallery stores all of them in that field, comma separated.
  if (given && !given.includes(',')) return sanitise(given, o && o.now);
  const url = String((o && o.url) || '');
  // The query string first. This is the whole bug: a signed URL's tail is not
  // part of the filename, and leaving it on makes the extension meaningless.
  const path = url.split('#')[0].split('?')[0];
  const last = path.split('/').pop() || '';
  return sanitise(decodeSafely(last), o && o.now);
}

/**
 * Does this belong in the gallery, or is it a document?
 *
 * Decided from the file, with the message's type as a hint for the cases where
 * there is no usable name. The type ALONE was what put photos in the document
 * path; the file alone would mis-handle a photo whose URL carries no
 * extension, so both are read and either may say yes.
 */
export function goesToGallery(o: {
  name?: string | null; type?: string | null;
}): boolean {
  const t = String((o && o.type) || '').toLowerCase();
  if (t === 'image' || t === 'gallery' || t === 'video') return true;
  const ext = extensionOf(String((o && o.name) || ''));
  if (!ext) return false;
  return IMAGE.includes(ext) || VIDEO.includes(ext);
}

/**
 * Should a dialog name the file afterwards?
 *
 * Only for what does NOT go to the gallery. The progress indicator already
 * says a download finished and ends with a tick; a dialog on top of that is a
 * second thing to dismiss saying the same thing, which is what was
 * photographed. A document earns one because "saved as <name>" is information
 * the indicator has no room for and the user otherwise cannot discover.
 */
export function shouldAnnounce(o: { name?: string | null; type?: string | null }): boolean {
  return !goesToGallery(o);
}

/** The lowercase extension, or '' when there is not one worth the name. */
export function extensionOf(name: string): string {
  const base = String(name || '').split('#')[0].split('?')[0];
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return '';
  const ext = base.slice(dot + 1).toLowerCase();
  // An "extension" with a slash or a space in it is not one; it is the rest
  // of a URL that has been mistaken for a filename.
  return /^[a-z0-9]{1,5}$/.test(ext) ? ext : '';
}

function decodeSafely(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}

function sanitise(name: string, now?: number): string {
  const cleaned = String(name || '')
    .split('#')[0].split('?')[0]
    // Characters a filesystem will refuse, and the path separators that would
    // silently write somewhere else entirely.
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
    .trim();
  if (!cleaned || cleaned === '.' || cleaned === '..') {
    const t = Number(now);
    return `file-${Number.isFinite(t) && t > 0 ? t : 0}`;
  }
  // Long names are refused by some filesystems, and a 300-character one comes
  // from exactly the mistake this file is about.
  return cleaned.length > 120 ? cleaned.slice(-120) : cleaned;
}
