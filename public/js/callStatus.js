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

  root.CallStatus = {
    outgoingStatus: outgoingStatus,
    canMinimize: canMinimize,
    videoPanes: videoPanes,
    canSwapVideos: canSwapVideos,
  };
})(typeof window !== 'undefined' ? window : globalThis);

if (typeof module !== 'undefined' && module.exports) {
  module.exports = (typeof window !== 'undefined' ? window : globalThis).CallStatus;
}
