// ── What the play button on a voice message is doing ─────────────────────────
//
// Reported from an iPhone: when someone sends a voice message and you tap play,
// the button spins forever and nothing plays until the page is reloaded — and
// it happens to the newest message only.
//
// Two faults, and the first is the one that made it iPhone-only:
//
//   THE GESTURE. Safari on iOS will only start audio from inside the click
//   that asked for it. The old code, for a file it had not buffered yet, added
//   a `canplay` listener and called play() from THERE — a callback that runs
//   long after the tap, in no gesture at all. iOS refuses it. On top of that
//   nothing ever asked the browser to load the file, and iOS does not preload
//   media on its own, so for a message that had just arrived `canplay` had
//   nothing to fire from: the spinner was waiting on an event that would never
//   come. Reloading the page made it work because by then the file was in the
//   browser's cache and the element was ready without any loading at all —
//   which is exactly why only the NEWEST message misbehaved.
//
//   THE DEAD END. Whatever the reason a file fails to play, "spinning" is not
//   a state anything recovers from. There was no timeout, no error handler and
//   no way back to a play button short of reloading the page.
//
// So: the click always calls play() itself, synchronously, and the spinner is
// only ever a report of what the audio element says it is doing — with an end
// to it either way.
(function (global) {
  // How long a voice message may sit buffering before we admit it is not
  // coming. Long enough for a slow connection to open a file, short enough
  // that nobody is left watching a circle turn.
  var SPIN_TIMEOUT_MS = 12000;

  // idle → nothing has been played yet, or it finished
  // buffering → play() has been called and the audio has not started
  // playing / paused → what it says
  // failed → it will not play; the button offers another go
  function reduce(state, event) {
    switch (event) {
      case 'click':
        // A click while it is playing pauses; anything else asks it to play,
        // and that request must be made in the click itself.
        return state === 'playing' ? 'paused' : 'buffering';
      case 'playing': return 'playing';
      case 'waiting': return state === 'paused' ? 'paused' : 'buffering';
      case 'pause': return state === 'buffering' ? 'buffering' : 'paused';
      case 'ended': return 'idle';
      case 'timeout': return state === 'buffering' ? 'failed' : state;
      case 'error':
      case 'blocked': return 'failed';
      default: return state;
    }
  }

  /**
   * Must this click call play() right now, in the handler?
   *
   * On iOS the answer decides whether the audio plays at all: a play() call
   * that happens later, from a listener, is not allowed to make a sound.
   */
  function playsNow(state) { return state !== 'playing'; }

  /** Is the spinner showing? */
  function spins(state) { return state === 'buffering'; }

  /** The glyph on the button. Empty while spinning — the CSS draws the circle. */
  function buttonFace(state) {
    if (state === 'buffering') return '';
    return state === 'playing' ? '⏸' : '▶';
  }

  /** Should a spin timeout be armed after this state change? */
  function armsTimeout(state) { return state === 'buffering'; }

  /** What to tell somebody whose voice message would not play. */
  function failureMessage(reason) {
    return reason === 'blocked'
      ? 'Tap play again to start the sound'
      : 'Could not play this voice message';
  }

  global.VoicePlayback = {
    SPIN_TIMEOUT_MS: SPIN_TIMEOUT_MS,
    reduce: reduce,
    playsNow: playsNow,
    spins: spins,
    buttonFace: buttonFace,
    armsTimeout: armsTimeout,
    failureMessage: failureMessage,
  };
})(typeof window !== 'undefined' ? window : this);
