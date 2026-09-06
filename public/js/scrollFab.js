// The web's copy of the go-to-newest button's rules.
//
// A mirror of native-app/src/scrollFab.ts, compared function by function in
// test/scrollFab.test.js. Why the button has to be lifted clear of the typing
// line — and why the reply banner already was — is written out in full there.
(function (global) {
  'use strict';

  var FAB_BASE = 148;
  var FAB_GAP = 12;
  var FAB_BANNER_LIFT = 66;
  var FAB_ACTIVITY_LIFT = 26;

  function atPresent(o) { return !!(o && o.atEndOfWindow && !o.hasNewer); }

  function fabMode(o) {
    if (((o && o.unseen) || 0) > 0) return 'bottom';
    return atPresent(o) ? 'hidden' : 'bottom';
  }

  function clearsUnseenOnTap(mode) { return mode === 'bottom'; }

  function fabBottom(o) {
    return FAB_BASE
      + (o && o.banner ? FAB_BANNER_LIFT : 0)
      + (o && o.activity ? FAB_ACTIVITY_LIFT : 0);
  }

  global.ScrollFab = {
    FAB_BASE: FAB_BASE,
    FAB_GAP: FAB_GAP,
    FAB_BANNER_LIFT: FAB_BANNER_LIFT,
    FAB_ACTIVITY_LIFT: FAB_ACTIVITY_LIFT,
    atPresent: atPresent,
    fabMode: fabMode,
    clearsUnseenOnTap: clearsUnseenOnTap,
    fabBottom: fabBottom,
  };
})(typeof window !== 'undefined' ? window : globalThis);

if (typeof module !== 'undefined' && module.exports) {
  module.exports = (typeof window !== 'undefined' ? window : globalThis).ScrollFab;
}
