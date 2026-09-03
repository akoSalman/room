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
// So: the app is sized and positioned from window.visualViewport, and while
// the keyboard is up the two rows of extras — the emoji strip and the
// attachment buttons — are folded away. They are one tap from coming back,
// and they were taking a third of what little was left.
(function (global) {
  /**
   * How much of the screen has to disappear before we call it a keyboard.
   *
   * Safari's own toolbars shrink the visual viewport too, by far less than
   * this — treating those as a keyboard would fold the composer's buttons
   * away every time somebody scrolled.
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

  /** With the keyboard up, the extra rows are folded away to leave room. */
  function hidesExtras(keyboardOpen) { return !!keyboardOpen; }

  global.ViewportFit = {
    KEYBOARD_MIN: KEYBOARD_MIN,
    boxFor: boxFor,
    hidesExtras: hidesExtras,
  };
})(typeof window !== 'undefined' ? window : this);
