// ── Telling somebody a new version is waiting ───────────────────────────────
//
// Reported as: "web version doesn't prompt update".
//
// Two things were wrong, and only one of them was the prompt.
//
// The fingerprint the page compares against hashed six named files out of the
// fifty-three public/js holds, so a deploy touching any of the other
// forty-seven was invisible and no client ever reloaded. That is fixed in
// server.js, where the whole directory is walked.
//
// The second is here, and I got it wrong on the way past. Having fixed the
// fingerprint I also replaced the automatic reload with a banner to tap,
// reasoning that a reload would throw away a half-written message. It would
// not: textDraft.js writes drafts to localStorage and puts them back when the
// chat reopens. So the only thing the banner achieved was to make the update
// optional — and an optional update is one people carry on ignoring while
// still running the version with the bug they reported.
//
// It updates by itself again. It waits for the three things a reload really
// does end — an upload, a call, a recording — and takes the new version the
// moment they are done.
(function (global) {
  'use strict';

  /**
   * Is the server serving something other than what this page loaded?
   *
   * The FIRST answer is never a change: the page has to learn its own version
   * from somewhere, and treating that first reading as an update would reload
   * every tab the moment it opened.
   */
  function versionChanged(o) {
    var s = o || {};
    if (!s.latest) return false;
    if (s.loaded === null || s.loaded === undefined) return false;
    return String(s.latest) !== String(s.loaded);
  }

  /**
   * Would reloading right now throw away something that cannot come back?
   *
   * THREE things, and a typed message is not one of them. Drafts are written
   * to localStorage by textDraft.js and restored when the chat reopens, so a
   * reload does not cost a half-written message — I asked people to confirm
   * an update on the strength of a risk that does not exist, and that is why
   * the update stopped happening.
   *
   * What a reload really ends:
   *
   *   uploading   bytes on their way up, which start again from zero
   *   inCall      a call, which simply drops
   *   recording   a voice message being spoken
   *
   * None of these is a reason to ASK. They are a reason to WAIT, and then to
   * update without asking, which is what somebody wants from an app they did
   * not come here to administer.
   */
  function wouldLoseWork(o) {
    var s = o || {};
    return !!(s.uploading || s.inCall || s.recording);
  }

  /**
   * What to do about a version that has changed.
   *
   *   'none'    nothing has changed, or nothing is known yet
   *   'wait'    something is in flight; take it the moment that ends
   *   'reload'  now
   *
   * There is deliberately no "ask" any more. A prompt that can be ignored is
   * ignored, and the person carries on using a version with the bug they
   * reported still in it — which is what happened, and is the whole reason
   * this is being written a third time.
   */
  function updateAction(o) {
    var s = o || {};
    if (!versionChanged(s)) return 'none';
    return wouldLoseWork(s) ? 'wait' : 'reload';
  }

  global.AppVersion = {
    versionChanged: versionChanged,
    wouldLoseWork: wouldLoseWork,
    updateAction: updateAction,
  };
})(typeof window !== 'undefined' ? window : globalThis);

if (typeof module !== 'undefined' && module.exports) {
  module.exports = (typeof window !== 'undefined' ? window : globalThis).AppVersion;
}
