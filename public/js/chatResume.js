// ── Coming back to the chat you were in ──────────────────────────────────────
//
// Reported as: after refreshing the page you have to select the chat and enter
// it again, while the composer is sitting there as though you were already in
// one.
//
// Both halves of that sentence are the bug:
//
//   • the page remembered nothing. A reload — which iOS does on its own to a
//     backgrounded tab, so this is not something people choose — dropped you
//     back on the room list with the chat you were reading gone.
//   • and it did not LOOK like it had. The composer, the attachment strip and
//     the emoji bar are part of the page rather than part of a chat, so they
//     stayed on screen with nothing behind them: a message box that, if you
//     typed into it, had nowhere to send anything.
//
// The rules are here so both clients — and the tests — agree on what "the chat
// I was in" means, and on when the composer is a real offer.
(function (global) {
  var KEY = 'lastRoom';

  /** What to write down when a chat is opened. */
  function serialise(room) {
    if (!room || room.id === undefined || room.id === null || room.id === '') return null;
    return JSON.stringify({
      id: String(room.id),
      name: String(room.name == null ? '' : room.name),
      isDm: !!room.isDm,
      at: Number(room.at) || 0,
    });
  }

  /** Read it back, tolerating anything at all in storage. */
  function parse(raw) {
    if (!raw) return null;
    var v;
    try { v = JSON.parse(raw); } catch (e) { return null; }
    if (!v || typeof v !== 'object') return null;
    var id = String(v.id == null ? '' : v.id);
    if (!id) return null;
    return { id: id, name: String(v.name || ''), isDm: !!v.isDm, at: Number(v.at) || 0 };
  }

  /**
   * Which chat to reopen, if any.
   *
   * A saved chat is only reopened if it is still in the list the server just
   * sent: rooms get left, deleted, and revoked, and reopening one you are no
   * longer in would show an empty screen with a name at the top of it.
   *
   * A room link in the address bar outranks it — that is a decision made just
   * now, and the saved room is only ever a memory of where you were.
   */
  function resumeTarget(o) {
    if (!o || o.joinParam) return null;
    var saved = parse(o.saved);
    if (!saved) return null;
    var rooms = Array.isArray(o.rooms) ? o.rooms : [];
    var dms = Array.isArray(o.dms) ? o.dms : [];
    var all = dms.concat(rooms);
    var found = null;
    for (var i = 0; i < all.length; i++) {
      if (all[i] && String(all[i].id) === saved.id) { found = all[i]; break; }
    }
    if (!found) return null;
    // The name and kind come from the list, not from storage: a room can be
    // renamed while the tab is closed.
    var isDm = found.is_dm !== undefined ? !!found.is_dm : saved.isDm;
    return {
      id: found.id,
      name: isDm ? (found.other_username || found.name || saved.name) : (found.name || saved.name),
      isDm: isDm,
    };
  }

  /**
   * Is the composer a real offer right now?
   *
   * With no chat open there is nowhere for a message to go, and a message box
   * that cannot send is what made a forgotten reload look like a broken app.
   */
  function composerVisible(roomId) {
    return !!roomId || roomId === 0;
  }

  global.ChatResume = {
    KEY: KEY,
    serialise: serialise,
    parse: parse,
    resumeTarget: resumeTarget,
    composerVisible: composerVisible,
  };
})(typeof window !== 'undefined' ? window : this);
