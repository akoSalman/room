// ── Pasting and dropping files ───────────────────────────────────────────────
//
// Asked for as: let the app and the web accept pasted and dropped images and
// files.
//
// Neither did anything with them. On the web, dropping a photo onto the chat
// made the BROWSER open it — navigating away from the conversation, which is
// the worst possible response — and Ctrl+V with a screenshot on the clipboard
// pasted nothing at all. On the phone there was no way to paste a screenshot
// into a chat, only to go and find it in the gallery.
//
// The decisions are here, away from the DOM and away from React, because they
// are the parts that are easy to get subtly wrong: which of the several things
// a paste carries is the one the user meant, what a file with no usable name
// should be called, and when a drag is worth reacting to at all.
//
// public/js/pasteDrop.js mirrors this file; a drift test compares them.

/** What a clipboard or a drag is carrying, as far as we care. */
export type Carried = {
  /** Files worth staging. */
  files: { name: string; type: string; size?: number }[];
  /** Text that should go into the composer instead. */
  text: string;
};

/** Matches the server's limit, so the refusal is immediate and specific. */
export const MAX_BYTES = 80 * 1024 * 1024;

/**
 * Does this paste carry files, or is it an ordinary text paste?
 *
 * The question matters because copying an image out of a web page, a document,
 * or a spreadsheet puts SEVERAL things on the clipboard at once: the image
 * itself, some HTML, and often a fragment of text. Taking the text would paste
 * a stray filename into the message box while silently dropping the photo the
 * user was actually copying.
 *
 * So: if anything file-shaped is there, that is what was meant. Plain text
 * pastes are left completely alone — they must keep working exactly as before,
 * including inside a message being edited.
 */
export function pasteCarriesFiles(kinds: { kind: string; type: string }[]): boolean {
  return (kinds || []).some(k => k && k.kind === 'file' && !!k.type);
}

/**
 * Should a drag be intercepted?
 *
 * During a drag the browser will not let a page read the contents — only the
 * TYPES — so this is the only question answerable at that moment, and it has
 * to be answered on every dragover event to keep the drop.
 *
 * Dragging selected text within the page, or a link from another tab, is not
 * ours: taking those would break dragging a word around a half-written
 * message. Only an actual file drag counts.
 */
export function dragCarriesFiles(types: string[]): boolean {
  return (types || []).includes('Files');
}

/**
 * A name for something pasted.
 *
 * Every screenshot on the clipboard arrives called "image.png", so pasting
 * three of them produced three attachments with the same name — indistinguish-
 * able in the preview strip, and confusing once they arrived in the chat. A
 * timestamp makes them tell themselves apart, and matches what the phone's
 * gallery does.
 */
export function pastedName(mime: string, at: number, existing?: string): string {
  const named = (existing || '').trim();
  // A real name from a real file is always better than one we invent — but
  // "image.png" is what the clipboard calls everything, so it is not one.
  if (named && named !== 'image.png' && named !== 'blob' && /\.[A-Za-z0-9]{1,5}$/.test(named)) {
    return named;
  }
  const d = new Date(at);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
    + `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `${prefixFor(mime)}-${stamp}.${extensionFor(mime)}`;
}

function prefixFor(mime: string): string {
  const m = (mime || '').toLowerCase();
  if (m.startsWith('image/')) return 'photo';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  return 'file';
}

/** The extension for a pasted blob, which arrives with a type but no name. */
export function extensionFor(mime: string): string {
  const m = (mime || '').toLowerCase().split(';')[0].trim();
  const known: Record<string, string> = {
    'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/gif': 'gif',
    'image/webp': 'webp', 'image/heic': 'heic', 'image/svg+xml': 'svg',
    'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm',
    'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/ogg': 'ogg', 'audio/wav': 'wav',
    'application/pdf': 'pdf', 'text/plain': 'txt',
  };
  if (known[m]) return known[m];
  const tail = m.split('/')[1] || '';
  // "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  // is not an extension, and neither is anything else with a dot or a plus in
  // it — better a file called .bin than one called .vnd.
  return /^[a-z0-9]{1,5}$/.test(tail) ? tail : 'bin';
}

/**
 * Which of the dropped files can actually be sent.
 *
 * Two things get refused, and both are refused HERE so the message can say
 * which file and why, rather than an upload failing silently ten seconds
 * later:
 *
 *   - anything over the server's limit,
 *   - anything with no type and no size, which on the web means a FOLDER.
 *     Dropping a folder is a natural thing to try and produces, without this,
 *     an "upload" that hangs forever on a zero-byte read.
 */
export function partitionDropped<T extends { name?: string; type?: string; size?: number }>(
  files: T[], max = MAX_BYTES,
): { accepted: T[]; tooLarge: T[]; folders: T[] } {
  const accepted: T[] = [], tooLarge: T[] = [], folders: T[] = [];
  for (const f of files || []) {
    if (!f) continue;
    const size = typeof f.size === 'number' ? f.size : -1;
    if (!f.type && size === 0) folders.push(f);
    else if (size > max) tooLarge.push(f);
    else accepted.push(f);
  }
  return { accepted, tooLarge, folders };
}

/** What to tell someone whose drop was not entirely accepted. */
export function rejectionMessage(
  o: { tooLarge: { name?: string }[]; folders: { name?: string }[] }, max = MAX_BYTES,
): string {
  const mb = Math.round(max / (1024 * 1024));
  const parts: string[] = [];
  if (o.folders.length) {
    parts.push(o.folders.length === 1
      ? `“${o.folders[0].name || 'That'}” looks like a folder — send the files inside it instead.`
      : `${o.folders.length} folders were skipped — send the files inside them instead.`);
  }
  if (o.tooLarge.length) {
    parts.push(o.tooLarge.length === 1
      ? `“${o.tooLarge[0].name || 'That file'}” is over the ${mb} MB limit.`
      : `${o.tooLarge.length} files are over the ${mb} MB limit.`);
  }
  return parts.join(' ');
}

// ── The phone's side of the same feature ─────────────────────────────────────
//
// Android has no "paste into the message box" for pictures: the composer is a
// text field, and a screenshot on the clipboard is invisible to it. What the
// system DOES offer is a clipboard that can hold an image, which the app can
// ask for — so pasting becomes a thing the app does on request rather than
// something the keyboard hands over.
//
// expo-clipboard returns that image as a data URI, which has to be turned back
// into a file before it can be uploaded. Both halves of that are here so they
// can be tested without a phone.

/** Split a `data:` URI into its type and its payload. */
export function parseDataUri(uri: string): { mime: string; base64: string } | null {
  const m = /^data:([^;,]+)?(;charset=[^;,]+)?(;base64)?,([\s\S]*)$/.exec(uri || '');
  if (!m) return null;
  // Only base64 payloads: a percent-encoded one is text, and an image never
  // arrives that way. Decoding it as if it were base64 would write a corrupt
  // file that fails silently on the way up.
  if (!m[3]) return null;
  const base64 = (m[4] || '').trim();
  if (!base64) return null;
  return { mime: (m[1] || 'application/octet-stream').trim(), base64 };
}

/**
 * A file URI copied as text, if that is what this is.
 *
 * Some file managers "copy" a file by putting its URI on the clipboard as a
 * string. Pasting that as a message would send somebody a line of gibberish
 * ending in .pdf; sending the file is what was meant.
 *
 * Deliberately narrow: only file:// and content://, and nothing with a
 * newline or a space, so a sentence that happens to mention a path is still
 * treated as the text it is.
 */
export function fileUriFromText(text: string): string | null {
  const t = (text || '').trim();
  if (!/^(file|content):\/\/\S+$/.test(t)) return null;
  if (/\s/.test(t)) return null;
  return t;
}
