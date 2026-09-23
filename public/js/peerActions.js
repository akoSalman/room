// ── What you can do about another person, and what it means (web) ───────────
//
// Mirrors native-app/src/peerActions.ts EXACTLY — same rules, same wording,
// same decisions about what is offered and what is confirmed. The same
// arrangement e2e.js already has with the app's e2e.ts, and for the same
// reason: the two clients must not quietly disagree.
//
// "Mirrors exactly" is a claim that rots unless something checks it, so
// test/peerActions.test.js loads BOTH this file and the compiled TypeScript
// and asserts they answer identically for every input. If one is edited
// without the other, that test fails.
//
// Why these rules are worth this trouble: mute, block and clear all read as
// "make this go away" and mean three very different things. Getting the
// wording wrong is how somebody destroys a conversation they meant to hide, or
// believes they have stopped a person contacting them when they have only
// silenced the buzz.
(function (root) {
  'use strict';

  /**
   * Which clear options may be offered.
   *
   * "For both" deletes the other person's copy too, so it is only ever offered
   * in a DIRECT chat. In a group it would be one member destroying everybody
   * else's record of a conversation they were all part of — and unlike a DM,
   * where the two people involved can simply talk again, there is no one there
   * whose agreement it represents.
   */
  function clearScopes(isDm) {
    return isDm ? ['me', 'both'] : ['me'];
  }

  function canClearForBoth(isDm) {
    return clearScopes(isDm).indexOf('both') !== -1;
  }

  function clearLabel(scope) {
    return scope === 'both' ? 'Clear for both of us' : 'Clear just for me';
  }

  /**
   * Both say what happens to the OTHER person's copy, because that is the whole
   * difference between them and the only thing a person can get wrong here.
   */
  function clearHint(scope, name) {
    return scope === 'both'
      ? 'Deletes these messages for you and for ' + name + '. This cannot be undone.'
      : 'Removes them from your device only. ' + name + ' keeps their copy.';
  }

  /** Irreversible things get asked about; reversible ones do not. */
  function clearConfirm(scope, name) {
    if (scope === 'both') {
      return {
        title: 'Clear for both?',
        body: 'These messages will be deleted for you and for ' + name + ', permanently.',
      };
    }
    // Clearing your own copy takes nothing from anyone else and the chat
    // returns the moment either of you says something, so a confirmation here
    // would be a dialog that only ever gets in the way.
    return null;
  }

  function muteLabel(muted) {
    return muted ? 'Unmute notifications' : 'Mute notifications';
  }

  // Kept in step with native-app/src/peerActions.ts — a test compares the two,
  // because two clients quietly disagreeing about what "mute" means is the
  // worst kind of bug: no error anywhere, and a phone that stays silent for a
  // different length of time than the one that set it.
  var MUTE_CHOICES = ['2h', 'forever'];

  function muteChoiceLabel(choice) {
    return choice === '2h' ? 'For 2 hours' : 'Until I turn it back on';
  }

  function mutedUntilLabel(until, now) {
    now = now === undefined ? Date.now() : now;
    var t = Number(until);
    if (!isFinite(t) || t <= 0) return 'Muted';
    if (t <= now) return 'Muted';
    var mins = Math.ceil((t - now) / 60000);
    if (mins < 60) return 'Muted for ' + mins + ' more minute' + (mins === 1 ? '' : 's');
    var hours = Math.round(mins / 60);
    return 'Muted for ' + hours + ' more hour' + (hours === 1 ? '' : 's');
  }

  function muteHint(muted, name) {
    return muted
      ? 'You will be notified about ' + name + ' again.'
      // Spelled out because "mute" is widely assumed to hide the messages too,
      // and someone who wanted that wanted block.
      : 'Messages from ' + name + ' still arrive — your phone just will not ring.';
  }

  function blockLabel(blocked) {
    return blocked ? 'Unblock' : 'Block';
  }

  function blockHint(blocked, name) {
    return blocked
      ? name + "'s messages will reach you again."
      // Says what the BLOCKER gets, not what the other person is stopped from
      // doing — because they are not stopped. Their app still lets them type
      // and send; the messages simply never arrive here, and they are never
      // told why.
      : 'You will stop receiving ' + name + "'s messages, and they will not see when you are online.";
  }

  function blockConfirm(blocked, name) {
    if (blocked) return null;
    return {
      title: 'Block ' + name + '?',
      body: 'Their messages will stop reaching you, and they will not see when you are online. '
        + 'They are not told that they have been blocked.',
    };
  }

  /**
   * How a message of mine that was never delivered should be drawn.
   *
   * Faded, dashed, and with no delivery tick. It should FEEL wrong without
   * saying anything: a ✓ would be an outright lie about a message the server
   * deliberately withheld, and a banner reading "you have been blocked" would
   * turn one person's quiet decision into a confrontation with them.
   */
  function vanishedStyle(blockedDelivery) {
    var gone = !!blockedDelivery;
    return { faded: gone, dashed: gone, showTicks: !gone };
  }

  /** None of it makes sense pointed at yourself. */
  function actionsFor(peer, isDm) {
    if (peer && peer.isSelf) return [];
    // Clearing needs a conversation to clear. Blocking and muting do not.
    return isDm ? ['mute', 'block', 'clear'] : ['mute', 'block'];
  }

  function avatarFor(peer) {
    return (peer && peer.avatar) || String((peer && peer.username) || '').slice(0, 2).toUpperCase();
  }

  root.PeerActions = {
    clearScopes: clearScopes,
    canClearForBoth: canClearForBoth,
    clearLabel: clearLabel,
    clearHint: clearHint,
    clearConfirm: clearConfirm,
    muteLabel: muteLabel,
    muteHint: muteHint,
    muteChoiceLabel: muteChoiceLabel,
    mutedUntilLabel: mutedUntilLabel,
    MUTE_CHOICES: MUTE_CHOICES,
    blockLabel: blockLabel,
    blockHint: blockHint,
    blockConfirm: blockConfirm,
    vanishedStyle: vanishedStyle,
    actionsFor: actionsFor,
    avatarFor: avatarFor,
  };
})(typeof window !== 'undefined' ? window : globalThis);

// Node, for the test that checks this file and the TypeScript agree.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = (typeof window !== 'undefined' ? window : globalThis).PeerActions;
}
