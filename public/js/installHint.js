// ── Telling an iPhone user the app can be installed ──────────────────────────
//
// Asked for after "can we build an iOS version and install it manually": no —
// iOS installs only what Apple has signed, and Apple does not enrol developers
// from Iran. What DOES work, today, with no account and no signing, is the
// thing this page already is: a PWA that Safari will put on the home screen as
// a standalone app.
//
// The catch is that iOS never offers. Android and desktop Chrome fire an
// `beforeinstallprompt` event and show a button; Safari has nothing — the user
// has to know to tap Share and then "Add to Home Screen". Almost nobody does,
// so the capability exists and is never used.
//
// Hence a one-time hint. The rules are here because the ways to get this wrong
// are all about showing it to somebody it cannot help:
//
//   • not when it is already installed — the hint would be advice to do the
//     thing they have done, inside the thing they did it to;
//   • not in Chrome or Firefox on iOS: those cannot add to the home screen
//     from their own share sheet in the way the instructions describe;
//   • not on Android or desktop, which have a real install prompt;
//   • not again once it has been dismissed, and not for a while after.
(function (global) {
  // Long enough that it is not nagging, short enough to catch somebody who
  // comes back after a month having forgotten it exists.
  var SNOOZE_MS = 30 * 24 * 60 * 60 * 1000;
  var KEY = 'installHintDismissedAt';

  /** An iPhone or iPad, including the iPads that claim to be a Mac. */
  function isIOS(ua, maxTouchPoints) {
    var s = String(ua || '');
    if (/iPad|iPhone|iPod/.test(s)) return true;
    // iPadOS 13+ reports a Mac user agent; touch points give it away.
    return /Macintosh/.test(s) && (maxTouchPoints || 0) > 1;
  }

  /**
   * Safari, and not one of the browsers wearing its engine.
   *
   * Chrome, Firefox and Edge on iOS are all WebKit underneath but each has its
   * own share sheet, and only Safari's has "Add to Home Screen" where these
   * instructions say it is.
   */
  function isSafari(ua) {
    var s = String(ua || '');
    if (/CriOS|FxiOS|EdgiOS|OPiOS|Chrome|Android/.test(s)) return false;
    return /Safari/.test(s);
  }

  /** Already added to the home screen and running from there. */
  function isStandalone(nav, matchMedia) {
    if (nav && nav.standalone) return true;                    // iOS
    try { return !!(matchMedia && matchMedia('(display-mode: standalone)').matches); }
    catch (e) { return false; }
  }

  /**
   * Should the hint be on screen?
   *
   * `signedIn` matters: the first thing somebody sees on this page should be
   * the sign-in form, not advice about home screens.
   */
  function shouldOffer(o) {
    if (!o) return false;
    if (!o.signedIn) return false;
    if (o.standalone) return false;
    if (!o.ios || !o.safari) return false;
    if (!o.dismissedAt) return true;
    var age = o.now - o.dismissedAt;
    return age < 0 || age >= (o.snoozeMs === undefined ? SNOOZE_MS : o.snoozeMs);
  }

  /** The two steps, in the order Safari puts them in. */
  function steps() {
    return ['Tap the Share button below', 'Choose "Add to Home Screen"'];
  }

  global.InstallHint = {
    SNOOZE_MS: SNOOZE_MS,
    KEY: KEY,
    isIOS: isIOS,
    isSafari: isSafari,
    isStandalone: isStandalone,
    shouldOffer: shouldOffer,
    steps: steps,
  };
})(typeof window !== 'undefined' ? window : this);
