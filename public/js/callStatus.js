// What the caller is told while they wait.
//
// Reported as: "on calling, check if the user is online or available, then
// show ringing — otherwise connecting."
//
// The screen said "Ringing…" the instant the offer was handed to the socket,
// which is a claim about the OTHER person's device made without hearing from
// it. When they were offline it was simply untrue: nothing was ringing
// anywhere, and the caller waited out the whole timeout staring at a word that
// meant nothing.
//
// This is the same rule as native-app/src/callAudio.ts, and a drift test
// compares the two over every combination — a call that says "Ringing" on one
// platform and "Connecting" on the other for the same facts is a bug in
// whichever one is behind.
(function (root) {
  'use strict';

  /**
   * @param {{delivered?:boolean, pushed?:boolean, ringing?:boolean,
   *          answered?:boolean, connected?:boolean}} s
   */
  function outgoingStatus(s) {
    s = s || {};
    if (s.connected) return 'Connected';
    if (s.answered) return 'Connecting…';
    if (s.ringing) return 'Ringing…';
    // A push went out, so their phone is alerting them — that IS ringing.
    // See callAudio.ts for why this case exists separately from `ringing`.
    if (s.pushed) return 'Ringing…';
    if (s.delivered) return 'Calling…';
    // Nothing reached them by any route. THIS is what "Connecting…" is for.
    return 'Connecting…';
  }

  /**
   * May this call be put down without hanging up?
   *
   * Not while it is ringing IN: an incoming call is a question that wants an
   * answer now, and shrinking it is how a call ends up ringing in a corner
   * while somebody carries on scrolling. Mirrors callWindow.ts on the app.
   */
  function canMinimize(phase) {
    return phase === 'outgoing' || phase === 'connected';
  }

  /**
   * Which video fills the panel, and which sits in the corner.
   *
   * Mirrors callWindow.ts on the app: you are the big pane and the other side
   * is the corner, which is also what the call looks like before their video
   * arrives — so connecting no longer throws the picture across the panel.
   * The two cases handled first are the ones that would otherwise strand
   * somebody looking at black.
   */
  function videoPanes(o) {
    o = o || {};
    var localShowable = !!o.hasLocal && !o.cameraOff;
    if (!localShowable) return { big: 'remote', small: null };
    if (!o.hasRemote) return { big: 'local', small: null };
    return o.swapped
      ? { big: 'remote', small: 'local' }
      : { big: 'local', small: 'remote' };
  }

  /** Is there anything a tap on the small pane would achieve? */
  function canSwapVideos(o) {
    o = o || {};
    return !!o.hasRemote && !!o.hasLocal && !o.cameraOff;
  }


  // ── How big the call window is ────────────────────────────────────────────
  //
  // Asked for: full screen, half screen and minimized.
  //
  // It had two states, and neither was a size: a fixed 260px panel in the
  // corner, and a bar. A video call in a 260px box is a video call you cannot
  // see, and there was no way to make it bigger.
  //
  // Three named sizes, cycled by one button, because a call has three honest
  // uses: watching it, half-watching it beside the conversation, and keeping
  // it alive while reading something else.
  var SIZES = ['minimized', 'half', 'full'];

  /** The next size the button moves to. Wraps, so one control reaches all. */
  function nextCallSize(current) {
    var i = SIZES.indexOf(String(current));
    // Anything unrecognised starts the cycle rather than sticking: a stored
    // value from an older build must not leave the button dead.
    if (i < 0) return 'half';
    return SIZES[(i + 1) % SIZES.length];
  }

  /** The class the panel wears. Never an empty string for a known size. */
  function callSizeClass(size) {
    return SIZES.indexOf(String(size)) >= 0 ? 'size-' + size : 'size-half';
  }

  /**
   * What the size button should say it will do.
   *
   * Named after the DESTINATION, not the current state: a button labelled
   * with where you already are is a button nobody presses.
   */
  function sizeButtonTitle(current) {
    var next = nextCallSize(current);
    return next === 'full' ? 'Full screen'
      : next === 'half' ? 'Half screen'
      : 'Minimize';
  }

  /**
   * Only your OWN camera is mirrored, and only on the front lens.
   *
   * The same rule as native-app/src/callWindow.ts, and a drift test compares
   * them. A mirrored self-view is what everyone expects — it is what a mirror
   * does — but mirroring the other person, or a back camera, shows their text
   * backwards. Which pane it is in makes no difference, which is exactly the
   * bug swapping would introduce if the mirror followed the pane instead of
   * the stream.
   *
   * The web had no mirror at all, so your own face came back the wrong way
   * round while the app showed it correctly.
   */
  function mirrors(pane, frontCamera) {
    return pane === 'local' && !!frontCamera;
  }

  /**
   * Is there a second camera worth offering a flip button for?
   *
   * One camera and the button is a lie. The count is what decides it, not
   * whether the device looks like a phone: a laptop with a USB webcam has two
   * and a tablet may have one.
   */
  function canFlipCamera(cameraCount) {
    var n = Number(cameraCount);
    return Number.isFinite(n) && n > 1;
  }

  /**
   * What a screen share replaces, and what it must put back.
   *
   * Sharing swaps the camera track out of the SAME sender rather than adding
   * a second one: a renegotiation mid-call is a chance for the call to drop,
   * and the far end then has to be told which of two videos is which. When it
   * stops, the camera track goes back into that sender — and if the camera was
   * off when sharing started, it must go back to being off rather than
   * surprising somebody with their own face.
   */
  function screenShareRestore(o) {
    o = o || {};
    return { track: 'camera', enabled: !o.cameraWasOff };
  }

  root.CallStatus = {
    outgoingStatus: outgoingStatus,
    canMinimize: canMinimize,
    videoPanes: videoPanes,
    canSwapVideos: canSwapVideos,
    SIZES: SIZES,
    nextCallSize: nextCallSize,
    callSizeClass: callSizeClass,
    sizeButtonTitle: sizeButtonTitle,
    mirrors: mirrors,
    canFlipCamera: canFlipCamera,
    screenShareRestore: screenShareRestore,
  };
})(typeof window !== 'undefined' ? window : globalThis);

if (typeof module !== 'undefined' && module.exports) {
  module.exports = (typeof window !== 'undefined' ? window : globalThis).CallStatus;
}
