// ── What a file may be called ────────────────────────────────────────────────
//
// Two reports, one rule underneath them:
//
//   "Share file to other apps crashes and doesn't work after preparing file"
//   "Allow renaming file when sharing from both outside of app or through it"
//
// The crash first, because it is the same question. Sharing a file out writes
// it to the cache under its own name and hands that path to the share sheet:
//
//     const local = FileSystem.cacheDirectory + name;
//
// `name` came straight from the message. It is whatever the sender's phone
// called the file — and for these users that is routinely Persian, with
// spaces, and sometimes with a "/" or a "#" in it. Any of those makes an
// invalid destination URI and the download throws before the sheet ever
// opens: prepared, then nothing. A signed media path is worse still, because
// the name taken from the URL ends up as "1788-4.jpg?e=1&s=abc" — a question
// mark and an ampersand in a filename.
//
// So a name has to be made safe before it becomes a path. And once there is a
// rule for that, renaming is the same rule applied to what the user typed.
//
// Mirrored by public/js/fileName.js, compared function by function in
// test/fileName.test.js.

/** Long enough for a real title, short of what any filesystem refuses. */
export const MAX_NAME = 120;

/**
 * Characters no filesystem, URI or content provider should be asked to take.
 *
 * A SPACE is deliberately not among them. "my holiday photo.jpg" is an
 * ordinary filename, and replacing spaces here would put a dash through every
 * Persian name in the app. Spaces are handled in cacheName, which is where a
 * path is actually built.
 */
const UNSAFE = /[\\/:*?"<>|#%]/g;

/** The extension, lower-cased, or '' — the part that decides what opens it. */
export function extensionOf(name: string | null | undefined): string {
  const s = String(name || '').split('?')[0].split('#')[0];
  const dot = s.lastIndexOf('.');
  if (dot <= 0 || dot === s.length - 1) return '';
  const ext = s.slice(dot + 1);
  // A "dot" that is really part of a sentence is not an extension.
  return /^[A-Za-z0-9]{1,8}$/.test(ext) ? ext.toLowerCase() : '';
}

/**
 * A name that can safely become a path.
 *
 * Everything a filesystem or a URI objects to is replaced rather than
 * stripped, so "a/b.pdf" stays legible as "a-b.pdf" instead of collapsing to
 * "ab.pdf". Non-ASCII is KEPT: a Persian filename is a perfectly good
 * filename, and the point of failure was never the alphabet.
 */
export function safeName(name: string | null | undefined, fallback = 'file'): string {
  // A query string is URL cruft and never part of a name — "1788-4.jpg?e=1"
  // is a filename with a question mark in it. A '#' is NOT stripped the same
  // way: "report #3.pdf" is a real name, and cutting at the hash took its
  // extension with it.
  let s = String(name || '').split('?')[0].trim();
  s = s.replace(UNSAFE, '-').replace(/\s+/g, ' ').replace(/^\.+/, '').trim();
  if (!s) return fallback;
  if (s.length > MAX_NAME) {
    // Trim the STEM, never the extension: a shortened ".pd" opens nothing.
    const ext = extensionOf(s);
    const stem = ext ? s.slice(0, s.length - ext.length - 1) : s;
    const room = MAX_NAME - (ext ? ext.length + 1 : 0);
    s = stem.slice(0, Math.max(1, room)) + (ext ? '.' + ext : '');
  }
  return s;
}

/**
 * What the file should be called after somebody has typed a new name.
 *
 * The extension is kept unless the typed name brings its own, because a person
 * renaming "IMG_20240612_119.jpg" to "beach" means the picture, not a file
 * Android no longer knows how to open. Typing "beach.png" is taken at its
 * word — that is a deliberate change of extension, and refusing it would be
 * second-guessing.
 *
 * An empty answer means "leave it alone", which is what dismissing the prompt
 * should do.
 */
export function renamed(
  original: string | null | undefined,
  typed: string | null | undefined,
): string {
  const want = String(typed ?? '').trim();
  const from = safeName(original);
  if (!want) return from;
  const safe = safeName(want, from);
  if (extensionOf(safe)) return safe;
  const ext = extensionOf(from);
  return ext ? `${safe}.${ext}` : safe;
}

/**
 * The name to show while renaming: the stem, without the extension.
 *
 * Nobody wants to edit around ".pdf" with a phone keyboard, and the extension
 * survives whatever they type anyway.
 */
export function editableStem(name: string | null | undefined): string {
  const s = safeName(name);
  const ext = extensionOf(s);
  return ext ? s.slice(0, s.length - ext.length - 1) : s;
}

/**
 * A cache filename that cannot collide with another share of another file.
 *
 * Two files called "report.pdf" from two different chats would otherwise be
 * the same path, and the second share would hand out the first file.
 */
export function cacheName(name: string | null | undefined, at = Date.now()): string {
  // Spaces are replaced HERE and only here: this is a path, and a raw space in
  // a file:// URI is exactly the kind of thing that works on one platform and
  // throws on the other. The name the message carries keeps its spaces.
  const safe = safeName(name).replace(/\s+/g, '-');
  const ext = extensionOf(safe);
  const stem = ext ? safe.slice(0, safe.length - ext.length - 1) : safe;
  return `${at}-${stem}${ext ? '.' + ext : ''}`;
}
