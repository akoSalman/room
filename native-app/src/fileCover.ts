// ── What a file looks like before you open it ───────────────────────────────
//
// Asked for: show files with a cover, so you know what is in one without
// opening it.
//
// The files tab listed everything as the same small emoji and a name, so a
// video, a photo somebody sent as a document, a PDF and a zip were four
// identical rows. On a metered connection "open it and see" is a real cost,
// and for a video it is the whole file.
//
// Three kinds of cover, and which one a file gets is decided here rather than
// in the list, because the honest answer differs by format and guessing wrong
// is worse than the emoji was:
//
//   • VIDEO — a real frame from the file itself. The app already extracts
//     these for the chat (src/videoCoverStore.ts), so the files tab shows the
//     same picture the message bubble does, usually without decoding anything
//     twice.
//   • IMAGE — a real thumbnail from the server. Pictures sent as documents
//     rather than as photos live in this tab, and the server can already make
//     a thumbnail of one.
//   • TYPED — everything else. There is no way to render the first page of a
//     PDF or the contents of a zip on this device, and a generic grey sheet
//     pretending to be a preview tells you less than the words "PDF" do. So
//     those get their extension, large, on a colour that is consistent per
//     family — which is a cover in the sense that matters: you can tell the
//     spreadsheets from the archives at a glance.

export type CoverKind = 'video' | 'image' | 'typed';

const IMAGE_EXT = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'heic', 'heif', 'avif'];

/** The extension, lowercased, with no dot. '' when there is not one. */
export function extOf(name: unknown): string {
  const n = String(name || '');
  const dot = n.lastIndexOf('.');
  if (dot <= 0 || dot === n.length - 1) return '';
  const ext = n.slice(dot + 1).toLowerCase();
  // A "extension" longer than this is a full stop in a filename, not a type.
  return /^[a-z0-9]{1,5}$/.test(ext) ? ext : '';
}

/**
 * Which kind of cover this file gets.
 *
 * `kind` is what the server said the message was, and it is trusted over the
 * name: a video with no extension is still a video, and that is the case
 * where a real cover is worth the most.
 */
export function coverKindFor(o: { name?: unknown; kind?: unknown }): CoverKind {
  const e = o || {};
  if (e.kind === 'video') return 'video';
  if (IMAGE_EXT.indexOf(extOf(e.name)) >= 0) return 'image';
  return 'typed';
}

/** What a typed cover says. Never empty — an unknown file is still a file. */
export function coverLabel(name: unknown): string {
  return (extOf(name) || 'file').toUpperCase();
}

/**
 * The colour behind a typed cover.
 *
 * By FAMILY, not by extension: .doc and .docx are the same thing to somebody
 * looking for a document, and giving them different colours would make the
 * list harder to scan rather than easier. Everything unknown shares one
 * colour, so an unrecognised type looks deliberately plain instead of looking
 * like a category of its own.
 */
export function coverTint(name: unknown): string {
  const e = extOf(name);
  if (e === 'pdf') return '#dc2626';
  if (['doc', 'docx', 'rtf', 'odt', 'txt', 'md'].indexOf(e) >= 0) return '#2563eb';
  if (['xls', 'xlsx', 'csv', 'ods'].indexOf(e) >= 0) return '#16a34a';
  if (['ppt', 'pptx', 'odp'].indexOf(e) >= 0) return '#ea580c';
  if (['zip', 'rar', '7z', 'tar', 'gz'].indexOf(e) >= 0) return '#a16207';
  if (['apk', 'exe', 'dmg', 'deb'].indexOf(e) >= 0) return '#7c3aed';
  return '#475569';
}

/**
 * Is it worth asking for a cover for this one yet?
 *
 * Extracting a video frame costs a decode, so it is only done for rows the
 * person can actually see. A list of two hundred files must not decode two
 * hundred videos because the screen was opened.
 */
export function wantsCover(o: { kind?: CoverKind; visible?: unknown }): boolean {
  const e = o || {};
  if (e.kind !== 'video') return false;
  return e.visible === true;
}
