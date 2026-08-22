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
   * @param {{delivered?:boolean, ringing?:boolean, answered?:boolean, connected?:boolean}} s
   */
  function outgoingStatus(s) {
    s = s || {};
    if (s.connected) return 'Connected';
    if (s.answered) return 'Connecting…';
    if (s.ringing) return 'Ringing…';
    // Delivered but not yet alerting, or not delivered at all and being woken
    // by a push. Both mean "still trying to reach them", which is the honest
    // thing to say about a phone that may be face down in a drawer.
    if (s.delivered) return 'Calling…';
    return 'Connecting…';
  }

  root.CallStatus = { outgoingStatus: outgoingStatus };
})(typeof window !== 'undefined' ? window : globalThis);

if (typeof module !== 'undefined' && module.exports) {
  module.exports = (typeof window !== 'undefined' ? window : globalThis).CallStatus;
}
