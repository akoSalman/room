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
// The second is here. When a change WAS noticed the page reloaded itself after
// a 600ms toast — which is fine if you are reading, and is a half-written
// message thrown away if you are not. A reload is not a small thing to do to
// somebody without asking, so it is now offered and taken when they say so.
//
// The rules live here, away from the DOM, because "is it safe to reload right
// now" is the part that is easy to get wrong and impossible to notice: getting
// it wrong loses work that was never saved anywhere, silently, for the person
// least likely to report it.
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
   * Would reloading right now throw away something the person cannot get back?
   *
   * Each of these is work that exists only in this tab:
   *
   *   composerText  a message typed and not sent
   *   uploading     bytes on their way up, which start again from zero
   *   inCall        a call, which simply ends
   *   recording     a voice message being spoken
   *
   * A draft is the common one and the easiest to dismiss, which is exactly why
   * it is named first: somebody who has typed three lines and gone to check
   * something has not agreed to lose them.
   */
  function wouldLoseWork(o) {
    var s = o || {};
    if (s.uploading || s.inCall || s.recording) return true;
    return String(s.composerText || '').trim().length > 0;
  }

  /**
   * What to do about a version that has changed.
   *
   *   'none'   nothing has changed, or nothing is known yet
   *   'ask'    show the banner and wait to be tapped
   *   'reload' nothing would be lost and nobody is looking — just do it
   *
   * Reloading unasked is allowed in exactly one case: the tab is hidden and
   * there is no work in it. Somebody who comes back to a tab they left an hour
   * ago is not interrupted by anything, and they arrive on the new version
   * without having to be told about versions at all — which is the best
   * outcome and the one they never have to think about.
   */
  function updateAction(o) {
    var s = o || {};
    if (!versionChanged(s)) return 'none';
    if (wouldLoseWork(s)) return 'ask';
    return s.hidden ? 'reload' : 'ask';
  }

  /** What the banner says. Short, and it names the action. */
  function bannerText() {
    return 'A new version is ready';
  }

  function bannerAction() {
    return 'Reload';
  }

  global.AppVersion = {
    versionChanged: versionChanged,
    wouldLoseWork: wouldLoseWork,
    updateAction: updateAction,
    bannerText: bannerText,
    bannerAction: bannerAction,
  };
})(typeof window !== 'undefined' ? window : globalThis);

if (typeof module !== 'undefined' && module.exports) {
  module.exports = (typeof window !== 'undefined' ? window : globalThis).AppVersion;
}
