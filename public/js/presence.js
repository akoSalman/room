// The web's copy of "which chat is this typing indicator about".
//
// A mirror of native-app/src/presence.ts, compared function by function in
// test/presence.test.js. The report — a stranger's "is typing" appearing under
// somebody else's conversation — and why a missing room is accepted rather
// than dropped are written out in full there.
(function (global) {
  'use strict';

  function isForRoom(eventRoomId, openRoomId) {
    if (eventRoomId === null || eventRoomId === undefined || eventRoomId === '') return true;
    if (openRoomId === null || openRoomId === undefined || openRoomId === '') return false;
    return String(eventRoomId) === String(openRoomId);
  }

  global.Presence = { isForRoom: isForRoom };
})(typeof window !== 'undefined' ? window : globalThis);

if (typeof module !== 'undefined' && module.exports) {
  module.exports = (typeof window !== 'undefined' ? window : globalThis).Presence;
}
