// Pasting and dropping files.
//
// Asked for as: let the app and the web accept pasted and dropped images and
// files.
//
// The web did neither. Dropping a photo onto the chat made the BROWSER open
// it — navigating away from the conversation mid-sentence, which is the worst
// possible response — and Ctrl+V with a screenshot on the clipboard pasted
// nothing at all.
//
// The rules live here rather than in the event handlers, because the parts
// that are easy to get subtly wrong are decisions, not plumbing: which of the
// several things a paste carries is the one the user meant, what to call a
// file that arrives with no name, and when a drag is worth reacting to.
//
// This mirrors native-app/src/pasteDrop.ts, and a drift test compares the two
// over every input that changes an answer.
(function (root) {
  'use strict';

  /** Matches the server's limit, so a refusal is immediate and specific. */
  var MAX_BYTES = 80 * 1024 * 1024;

  /**
   * Does this paste carry files, or is it an ordinary text paste?
   *
   * Copying an image out of a web page, a document or a spreadsheet puts
   * SEVERAL things on the clipboard at once: the image, some HTML, and often a
   * fragment of text. Taking the text would paste a stray filename into the
   * message box while silently dropping the photo the user was copying.
   *
   * So if anything file-shaped is there, that is what was meant. Plain text
   * pastes are left completely alone.
   */
  function pasteCarriesFiles(kinds) {
    return (kinds || []).some(function (k) { return k && k.kind === 'file' && !!k.type; });
  }

  /**
   * Should a drag be intercepted?
   *
   * During a drag the browser will not let the page read the contents, only
   * the TYPES — so this is the only question answerable at that moment, and it
   * must be answered on every dragover event or the drop never happens.
   *
   * Dragging selected text within the page, or a link from another tab, is not
   * ours: taking those would break dragging a word around a half-written
   * message.
   */
  function dragCarriesFiles(types) {
    return (types || []).indexOf('Files') !== -1;
  }

  /**
   * A name for something pasted.
   *
   * Every screenshot on the clipboard arrives called "image.png", so pasting
   * three of them produced three attachments with the same name —
   * indistinguishable in the preview strip and confusing in the chat. A
   * timestamp makes them tell themselves apart.
   */
  function pastedName(mime, at, existing) {
    var named = (existing || '').trim();
    // A real name from a real file beats one we invent — but "image.png" is
    // what the clipboard calls everything, so it is not one.
    if (named && named !== 'image.png' && named !== 'blob' && /\.[A-Za-z0-9]{1,5}$/.test(named)) {
      return named;
    }
    var d = new Date(at);
    var p = function (n) { return String(n).padStart(2, '0'); };
    var stamp = '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate())
      + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
    return prefixFor(mime) + '-' + stamp + '.' + extensionFor(mime);
  }

  function prefixFor(mime) {
    var m = (mime || '').toLowerCase();
    if (m.indexOf('image/') === 0) return 'photo';
    if (m.indexOf('video/') === 0) return 'video';
    if (m.indexOf('audio/') === 0) return 'audio';
    return 'file';
  }

  var KNOWN_EXT = {
    'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/gif': 'gif',
    'image/webp': 'webp', 'image/heic': 'heic', 'image/svg+xml': 'svg',
    'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm',
    'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/ogg': 'ogg', 'audio/wav': 'wav',
    'application/pdf': 'pdf', 'text/plain': 'txt',
  };

  /** The extension for a pasted blob, which arrives with a type but no name. */
  function extensionFor(mime) {
    var m = (mime || '').toLowerCase().split(';')[0].trim();
    if (KNOWN_EXT[m]) return KNOWN_EXT[m];
    var tail = m.split('/')[1] || '';
    // A Word document's type is not an extension, and neither is anything else
    // with a dot or a plus in it — better a file called .bin than .vnd.
    return /^[a-z0-9]{1,5}$/.test(tail) ? tail : 'bin';
  }

  /**
   * Which of the dropped files can actually be sent.
   *
   * Refused here, where the message can name the file and the reason, rather
   * than by an upload that fails ten seconds later:
   *   - anything over the server's limit,
   *   - anything with no type and no size, which in a browser means a FOLDER.
   *     Dropping a folder is a natural thing to try, and without this it
   *     produces an upload that hangs forever on a zero-byte read.
   */
  function partitionDropped(files, max) {
    if (max === undefined) max = MAX_BYTES;
    var accepted = [], tooLarge = [], folders = [];
    (files || []).forEach(function (f) {
      if (!f) return;
      var size = typeof f.size === 'number' ? f.size : -1;
      if (!f.type && size === 0) folders.push(f);
      else if (size > max) tooLarge.push(f);
      else accepted.push(f);
    });
    return { accepted: accepted, tooLarge: tooLarge, folders: folders };
  }

  /** What to tell someone whose drop was not entirely accepted. */
  function rejectionMessage(o, max) {
    if (max === undefined) max = MAX_BYTES;
    var mb = Math.round(max / (1024 * 1024));
    var parts = [];
    if (o.folders.length) {
      parts.push(o.folders.length === 1
        ? '“' + (o.folders[0].name || 'That') + '” looks like a folder — send the files inside it instead.'
        : o.folders.length + ' folders were skipped — send the files inside them instead.');
    }
    if (o.tooLarge.length) {
      parts.push(o.tooLarge.length === 1
        ? '“' + (o.tooLarge[0].name || 'That file') + '” is over the ' + mb + ' MB limit.'
        : o.tooLarge.length + ' files are over the ' + mb + ' MB limit.');
    }
    return parts.join(' ');
  }

  /**
   * The files carried by a paste or a drop, named.
   *
   * `items` is preferred over `files` because it is the only one that carries
   * the type for a pasted screenshot, which has no file behind it at all —
   * it is a blob the browser materialises when asked.
   */
  function filesFrom(dt, now) {
    if (!dt) return [];
    var at = now || Date.now();
    var out = [];
    var items = dt.items;
    if (items && items.length) {
      for (var i = 0; i < items.length; i++) {
        var it = items[i];
        if (!it || it.kind !== 'file') continue;
        var f = it.getAsFile && it.getAsFile();
        if (f) out.push(rename(f, at));
      }
      if (out.length) return out;
    }
    var list = dt.files || [];
    for (var j = 0; j < list.length; j++) out.push(rename(list[j], at));
    return out;
  }

  /**
   * Give a file the name we decided on.
   *
   * A File's name is read-only, so this makes a new one around the SAME bytes
   * — no copy, and the original blob is untouched. If the environment will not
   * construct a File (older Safari), the original is used as it is: a
   * duplicate name is a far smaller problem than a paste that does nothing.
   */
  function rename(file, at) {
    var wanted = pastedName(file.type, at, file.name);
    if (wanted === file.name) return file;
    try {
      return new File([file], wanted, { type: file.type, lastModified: file.lastModified || at });
    } catch (e) {
      return file;
    }
  }

  // ── Pasting from a button, for phones ──────────────────────────────────────
  //
  // Ctrl+V and drag-and-drop are both keyboard-and-mouse gestures. On a phone
  // there is neither, so the paste support above — which works — was
  // unreachable for most of the people using this. The app has had a Paste
  // item in its attachment sheet all along; this is the web's.

  /**
   * Can this browser be ASKED for the clipboard, rather than waiting to be
   * given it?
   *
   * Safari and Chrome can (both put up their own permission prompt, which is
   * as it should be — a page reading your clipboard unasked would be a bug).
   * Firefox cannot, and there the button is not offered at all: an option that
   * always fails is worse than no option.
   */
  function clipboardReadable(nav) {
    return !!(nav && nav.clipboard && typeof nav.clipboard.read === 'function');
  }

  /**
   * Which of the several forms a clipboard entry offers is the one to send?
   *
   * A copied image usually arrives as an image AND as HTML AND as a scrap of
   * text. Same rule as a paste event: if something file-shaped is there, that
   * is what was meant. Returns null when the entry really is just text, which
   * the caller puts in the message box instead of refusing.
   */
  function pickType(types) {
    var list = types || [];
    for (var i = 0; i < list.length; i++) {
      if (String(list[i]).toLowerCase().indexOf('image/') === 0) return list[i];
    }
    for (var j = 0; j < list.length; j++) {
      if (String(list[j]).toLowerCase().indexOf('text/') !== 0) return list[j];
    }
    return null;
  }

  /**
   * What to say when a paste produced nothing.
   *
   * Each of these is a different situation and none of them is "an error":
   * being refused the clipboard is a choice the user just made, and an empty
   * clipboard is simply empty. Saying "paste failed" to all three would teach
   * people the button is broken.
   */
  function clipboardProblem(o) {
    var name = (o && o.error && (o.error.name || o.error)) || '';
    if (name === 'NotAllowedError') return 'Allow this page to read the clipboard to paste here.';
    if (name) return 'Nothing could be read from the clipboard.';
    if (!o || !o.items) return 'The clipboard is empty.';
    return null;
  }

  root.PasteDrop = {
    MAX_BYTES: MAX_BYTES,
    clipboardReadable: clipboardReadable,
    pickType: pickType,
    clipboardProblem: clipboardProblem,
    pasteCarriesFiles: pasteCarriesFiles,
    dragCarriesFiles: dragCarriesFiles,
    pastedName: pastedName,
    extensionFor: extensionFor,
    partitionDropped: partitionDropped,
    rejectionMessage: rejectionMessage,
    filesFrom: filesFrom,
  };
})(typeof window !== 'undefined' ? window : globalThis);

if (typeof module !== 'undefined' && module.exports) {
  module.exports = (typeof window !== 'undefined' ? window : globalThis).PasteDrop;
}
