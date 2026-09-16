// The web's copy of "two different things both called delete".
//
// A mirror of native-app/src/messageDelete.ts, compared function by function in
// test/messageDelete.test.js. Why your own message gets `delete_message` and
// somebody else's gets `hide_message` — and why sending the first for the
// second would be one person deleting another person's words — is written out
// in full there.
(function (global) {
  'use strict';

  function deleteKind(o) {
    return o && o.mine ? 'everyone' : 'me';
  }

  function deleteEvent(kind) {
    return kind === 'everyone' ? 'delete_message' : 'hide_message';
  }

  function deleteLabel(kind) {
    return kind === 'everyone' ? 'Delete' : 'Delete for me';
  }

  function deleteConfirm(kind, count) {
    var n = Math.max(1, Number(count) || 1);
    var what = n === 1 ? 'message' : n + ' messages';
    if (kind === 'everyone') {
      return {
        title: 'Delete ' + what + '?',
        body: n === 1
          ? 'This removes it for everyone in the chat.'
          : 'This removes them for everyone in the chat.',
      };
    }
    return {
      title: 'Delete ' + what + ' for me?',
      body: n === 1
        ? 'It disappears from your chat only. The sender still has it.'
        : 'They disappear from your chat only. The senders still have them.',
    };
  }

  function splitForDeletion(ids, isMine) {
    var out = { forEveryone: [], forMe: [] };
    (ids || []).forEach(function (id) {
      if (deleteKind({ mine: !!isMine(id) }) === 'everyone') out.forEveryone.push(id);
      else out.forMe.push(id);
    });
    return out;
  }

  function splitConfirm(split) {
    var mine = split.forEveryone.length;
    var theirs = split.forMe.length;
    if (!mine) return deleteConfirm('me', theirs);
    if (!theirs) return deleteConfirm('everyone', mine);
    var total = mine + theirs;
    return {
      title: 'Delete ' + total + ' messages?',
      body: mine + ' of yours will be removed for everyone. '
        + theirs + ' from other people will disappear from your chat only.',
    };
  }

  global.MessageDelete = {
    deleteKind: deleteKind,
    deleteEvent: deleteEvent,
    deleteLabel: deleteLabel,
    deleteConfirm: deleteConfirm,
    splitForDeletion: splitForDeletion,
    splitConfirm: splitConfirm,
  };
})(typeof window !== 'undefined' ? window : globalThis);

if (typeof module !== 'undefined' && module.exports) {
  module.exports = (typeof window !== 'undefined' ? window : globalThis).MessageDelete;
}
