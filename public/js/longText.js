// The web's copy of how a long message is folded.
//
// A mirror of native-app/src/longText.ts, compared against it message by
// message in test/longText.test.js: a message folded in the app and whole on
// the web would look like two different messages.
(function (global) {
  var FOLD_CHARS = 600;
  var FOLD_LINES = 12;
  var PREVIEW_CHARS = 420;
  var PREVIEW_LINES = 8;

  function lineCount(text) {
    return String(text == null ? '' : text).split('\n').length;
  }

  function isLong(text) {
    var t = String(text == null ? '' : text);
    return t.length > FOLD_CHARS || lineCount(t) > FOLD_LINES;
  }

  function preview(text) {
    var t = String(text == null ? '' : text);
    if (!isLong(t)) return t;
    var byLines = t.split('\n').slice(0, PREVIEW_LINES).join('\n');
    var cutByChars = byLines.length > PREVIEW_CHARS;
    var cut = cutByChars ? byLines.slice(0, PREVIEW_CHARS) : byLines;
    if (cutByChars) {
      var nl = cut.lastIndexOf('\n');
      var sp = cut.lastIndexOf(' ');
      var floor = cut.length * 0.75;
      if (nl > floor) cut = cut.slice(0, nl);
      else if (sp > floor) cut = cut.slice(0, sp);
    }
    return cut.replace(/\s+$/, '');
  }

  function toggleLabel(expanded) { return expanded ? 'Show less' : 'Show more'; }

  function shownText(text, expanded) {
    var t = String(text == null ? '' : text);
    return expanded || !isLong(t) ? t : preview(t) + '…';
  }

  function showsToggle(text) { return isLong(text); }

  global.LongText = {
    FOLD_CHARS: FOLD_CHARS, FOLD_LINES: FOLD_LINES,
    PREVIEW_CHARS: PREVIEW_CHARS, PREVIEW_LINES: PREVIEW_LINES,
    lineCount: lineCount, isLong: isLong, preview: preview,
    toggleLabel: toggleLabel, shownText: shownText, showsToggle: showsToggle,
  };
})(typeof window !== 'undefined' ? window : this);
