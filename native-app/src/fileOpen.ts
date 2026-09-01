// ── What tapping a file in a chat should do ──────────────────────────────────
//
// Reported as: an APK sent in a chat had no download on the message for the
// person receiving it, and tapping the file said "error opening file". It
// should download like other files and install when tapped.
//
// Three separate things were wrong, and they are worth naming because only one
// of them is about APKs at all:
//
//   1. NOTHING DOWNLOADED IT. A file bubble was a single "tap to open" card.
//      Every tap fetched the file into the app's cache, invisibly, with no
//      button, no progress and no evidence it had worked — on the connections
//      these users have, a 40 MB APK is minutes of a card that looks inert.
//      Videos have had a download button with a progress ring for months; file
//      messages never got one.
//
//   2. AN APK IS NOT OPENED, IT IS INSTALLED. The card fired a VIEW intent
//      with the APK's mime type. Nothing on Android answers that in a way that
//      leads anywhere: installing is ACTION_INSTALL_PACKAGE, which is exactly
//      what this app already uses for its own updates. VIEW got the package
//      installer to appear and immediately fail — "error opening file".
//
//   3. AND WHEN IT FAILS, IT USUALLY MEANS ONE THING. Android will not let an
//      app install another app until the user has allowed it for that app
//      specifically ("Install unknown apps"). That is a switch in Settings the
//      person has to flip, and a dialog saying "no app can open this file" is
//      the least useful thing to tell them at that moment.
//
// The rules are here so the card, the tap and the error message cannot
// disagree about what kind of file is in front of them.

export type FileKind = 'apk' | 'document';

export type TapAction =
  /** Fetch it first — nothing can be opened before it is on the device. */
  | 'download'
  /** Hand it to Android's package installer. */
  | 'install'
  /** Open it in whatever app handles this type. */
  | 'open'
  /** It is already coming; a second tap must not start it again. */
  | 'wait';

const APK_MIME = 'application/vnd.android.package-archive';

/** Is this the kind of file that gets installed rather than opened? */
export function isApk(name: string | null | undefined, mime?: string | null): boolean {
  if (String(mime || '').toLowerCase() === APK_MIME) return true;
  return /\.apk$/i.test(String(name || '').split(/[?#]/)[0]);
}

export function kindOf(name: string | null | undefined, mime?: string | null): FileKind {
  return isApk(name, mime) ? 'apk' : 'document';
}

/**
 * What a tap on the card means right now.
 *
 * Downloading is always the first step. It used to happen invisibly inside
 * "open", which is why a slow download looked like a card that did nothing.
 */
export function tapAction(o: {
  kind: FileKind;
  downloaded: boolean;
  downloading: boolean;
}): TapAction {
  if (o.downloading) return 'wait';
  if (!o.downloaded) return 'download';
  return o.kind === 'apk' ? 'install' : 'open';
}

/**
 * The line under the file's name.
 *
 * It says what the next tap will do, because a card that only names a file
 * gives no reason to believe a tap will achieve anything.
 */
export function cardMeta(o: {
  kind: FileKind;
  ext: string;
  downloaded: boolean;
  downloading: boolean;
  percent?: number;
  failed?: boolean;
  uploading?: boolean;
}): string {
  const label = (o.ext || (o.kind === 'apk' ? 'apk' : 'file')).toUpperCase();
  if (o.uploading) return 'Uploading…';
  if (o.downloading) {
    const pct = Math.max(0, Math.min(100, Math.round(o.percent || 0)));
    return pct > 0 ? `Downloading… ${pct}%` : 'Downloading…';
  }
  if (o.failed) return 'Download failed — tap to try again';
  if (!o.downloaded) return `${label} · tap to download`;
  return o.kind === 'apk' ? `${label} · tap to install` : `${label} · tap to open`;
}

/** Does the card show a download button? */
export function showsDownloadButton(o: {
  downloaded: boolean; downloading: boolean; uploading?: boolean;
}): boolean {
  // Not while it is being sent — that file is already on this device — and not
  // once it is here, when the card itself is the way to open it.
  return !o.uploading && !o.downloaded && !o.downloading;
}

/**
 * What to say when the package installer refuses.
 *
 * Nearly always the same cause, and it is one the person can fix in about ten
 * seconds — but only if they are told which switch to look for. "No app on
 * this device can open this file type" sent them looking for an app instead.
 */
export function installHelp(): { title: string; message: string } {
  return {
    title: 'Allow installing apps',
    message: 'Android blocks installing apps from a chat until you allow it. '
      + 'Open Settings → Apps → this app → "Install unknown apps" and turn it on, '
      + 'then tap the file again.',
  };
}

/** What to say when nothing on the device can open an ordinary document. */
export function openHelp(ext: string): { title: string; message: string } {
  const kind = ext ? `.${ext.toLowerCase()} ` : '';
  return {
    title: 'Cannot open',
    message: `No app on this device can open a ${kind}file. It has been downloaded, `
      + 'so you can open it from your files or send it to another app.',
  };
}
