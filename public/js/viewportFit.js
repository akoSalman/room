// ── Making room for the keyboard, on iOS ─────────────────────────────────────
//
// Reported with a screen recording: opening the keyboard on the iPhone web
// version pushes the chat header off the top of the screen, and the composer
// ends up under Safari's own toolbar — the row with the ⌃ ⌄ and ✓.
//
// The cause is one of the oldest differences between mobile browsers. Chrome
// on Android shrinks the LAYOUT viewport when the keyboard opens, so a
// full-height page simply becomes shorter. Safari on iOS does not: the layout
// viewport keeps its full height and only the VISUAL viewport — the part you
// can see — gets smaller. A `position: fixed; inset: 0` app therefore keeps
// its full height behind the keyboard, and Safari scrolls the page to bring
// the caret into view, which is what takes the header away.
//
// The page already tried to fix this by setting the height of <html> and
// <body>. That could never work: #app-screen is `position: fixed`, so it is
// laid out against the layout viewport and does not care what its ancestors
// are sized to. It has to be told directly.
//
// So: the app is sized and positioned from window.visualViewport.
//
// A first attempt also folded away the emoji row and the attachment strip
// while the keyboard was up, to win back some room. That was wrong twice
// over, and it was reported straight back — "on web version and opened
// keyboard nothing is above composer". The buttons are needed MOST while
// typing (that is when you attach a photo or a voice note), and the emoji bar
// is only ever shown BECAUSE the keyboard is open, so hiding it made the 😊
// button do nothing at all. Only the install banner — an interruption, not a
// control — stands down while typing.
(function (global) {
  /**
   * How much of the screen has to disappear before we call it a keyboard.
   *
   * Safari's own toolbars shrink the visual viewport too, by far less than
   * this — treating those as a keyboard would dismiss the install banner, and
   * re-lay the app out, every time somebody scrolled the chat.
   */
  var KEYBOARD_MIN = 120;

  /**
   * Where the app should be, and how tall.
   *
   * `top` is the visual viewport's offset: while the keyboard is opening iOS
   * scrolls the layout viewport under it, and an app pinned to 0 would sit
   * that far off the top of the screen.
   */
  function boxFor(o) {
    var inner = Number(o && o.innerHeight) || 0;
    var h = Number(o && o.vvHeight) || inner;
    var top = Number(o && o.vvOffsetTop) || 0;
    var hidden = Math.max(0, inner - h);
    return {
      top: Math.max(0, Math.round(top)),
      height: Math.max(0, Math.round(h)),
      keyboardOpen: hidden >= KEYBOARD_MIN,
    };
  }

  /**
   * With the keyboard up, the install banner stands down — and nothing else.
   *
   * Every control the composer offers stays exactly where it was. Somebody
   * typing is the person most likely to reach for the attachment buttons, and
   * the emoji bar exists only while the keyboard is open.
   */
  function hidesBanner(keyboardOpen) { return !!keyboardOpen; }

  global.ViewportFit = {
    KEYBOARD_MIN: KEYBOARD_MIN,
    boxFor: boxFor,
    hidesBanner: hidesBanner,
  };
})(typeof window !== 'undefined' ? window : this);
