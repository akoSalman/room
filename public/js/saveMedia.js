// ── Saving a photo or a video from the web, on a phone ──────────────────────
//
// Reported: "on web version ios the save for media should save to gallery not
// files, image and video to gallery and files to files".
//
// Everything went through `<a download>`, which on iOS does not save anything:
// Safari ignores the attribute, and the file lands in Files (or simply opens),
// so a photo saved from a chat is somewhere the Photos app will never show it.
//
// The route to the camera roll from a web page is the share sheet — the one
// with "Save Image" and "Save Video" on it — reached through the Web Share
// API with a file attached. That is the whole trick, plus two details that
// decide whether it works at all:
//
//   • only pictures and video belong there. A PDF has no place in Photos, and
//     iOS would offer "Save to Files" for it anyway — which is exactly where a
//     document should go, so documents keep the plain download.
//
//   • the share sheet may only be opened from a user's tap. Fetching the file
//     first spends that tap on some browsers, so the bytes are fetched AHEAD
//     of time (when the viewer opens, or the menu is opened) and the tap does
//     nothing but share what is already in hand.
//
// Web only: the app saves through MediaLibrary, which writes to the gallery
// directly and has never had this problem.
(function (global) {
  'use strict';

  /** Extensions that belong in the camera roll rather than in Files. */
  var IMAGE_EXT = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'bmp'];
  var VIDEO_EXT = ['mp4', 'mov', 'm4v', 'webm', '3gp', 'mkv'];

  function extOf(nameOrUrl) {
    var s = String(nameOrUrl || '').split('?')[0].split('#')[0];
    var dot = s.lastIndexOf('.');
    return dot === -1 ? '' : s.slice(dot + 1).toLowerCase();
  }

  /**
   * Is this something the gallery should hold?
   *
   * The mime type when there is one, the extension when there is not — a chat
   * file can arrive with an empty or useless type, and the name is then the
   * only evidence there is.
   */
  function isGalleryMedia(o) {
    var s = o || {};
    var mime = String(s.mime || '').toLowerCase();
    if (mime.indexOf('image/') === 0 || mime.indexOf('video/') === 0) return true;
    if (mime && mime !== 'application/octet-stream') return false;
    var ext = extOf(s.name || s.url);
    return IMAGE_EXT.indexOf(ext) !== -1 || VIDEO_EXT.indexOf(ext) !== -1;
  }

  /** Can this browser hand a FILE to the system share sheet? */
  function canShareFiles(env) {
    var nav = (env && env.navigator) || (typeof navigator !== 'undefined' ? navigator : null);
    if (!nav || typeof nav.share !== 'function' || typeof nav.canShare !== 'function') return false;
    try {
      // Asked with a real file: a browser can have share() for links and still
      // refuse files, and answering that wrongly means a tap that does nothing.
      var probe = (env && env.probeFile)
        || new File([new Blob([''], { type: 'image/png' })], 'probe.png', { type: 'image/png' });
      return !!nav.canShare({ files: [probe] });
    } catch (e) {
      return false;
    }
  }

  /**
   * Which way this file should be saved.
   *
   * 'share'    — the system sheet, which is the only route to the camera roll.
   * 'download' — a plain link, for documents and for browsers with no sheet.
   */
  function routeFor(o) {
    var s = o || {};
    if (!isGalleryMedia(s)) return 'download';
    return s.canShareFiles ? 'share' : 'download';
  }

  /** A sensible filename, whatever the caller happened to know. */
  function saveName(url, name) {
    var given = String(name || '').trim();
    // A gallery message keeps every name in one comma-joined string; that is
    // not a filename, it is a list, and it must not become one.
    if (given && given.indexOf(',') === -1) return given;
    var last = String(url || '').split('?')[0].split('#')[0].split('/').pop();
    return last || 'file';
  }

  /**
   * Did the share fail, or did the person simply change their mind?
   *
   * Dismissing the sheet rejects with AbortError, and reporting that as a
   * failure would put an error in front of someone who just tapped Cancel.
   */
  function shareCancelled(err) {
    return !!err && (err.name === 'AbortError' || err.code === 20);
  }

  global.SaveMedia = {
    IMAGE_EXT: IMAGE_EXT,
    VIDEO_EXT: VIDEO_EXT,
    isGalleryMedia: isGalleryMedia,
    canShareFiles: canShareFiles,
    routeFor: routeFor,
    saveName: saveName,
    shareCancelled: shareCancelled,
  };
})(typeof window !== 'undefined' ? window : globalThis);

if (typeof module !== 'undefined' && module.exports) {
  module.exports = (typeof window !== 'undefined' ? window : globalThis).SaveMedia;
}
