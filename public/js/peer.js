// ── One person, and what you can do about them (web) ────────────────────────
//
// The app has had this for a while: tap somebody and get mute, block, and
// clear-history, each with a line saying what it actually does. The web had
// none of it — the endpoints existed and nothing could reach them.
//
// The three decisions and their wording come from PeerActions (peerActions.js),
// shared with the app and checked against it by a test, so the two clients
// cannot quietly disagree about what "block" means.
(function () {
  'use strict';

  var peer = null;        // the person on screen: { id, username, avatar, muted, blocked, isSelf }
  var forRoomId = null;   // the chat this sheet was opened from, for "clear"
  var isDm = false;

  function $(id) { return document.getElementById(id); }

  /**
   * Open the sheet for a person.
   *
   * Drawn immediately from the name alone and filled in when the server
   * answers. Waiting would mean a tap that does nothing for a beat on a
   * connection where a beat is a second and a half.
   */
  async function open(usernameArg, opts) {
    opts = opts || {};
    if (!usernameArg || usernameArg === window.username) return;
    isDm = !!opts.isDm;
    forRoomId = opts.roomId || null;
    peer = { username: usernameArg, muted: false, blocked: false };
    render();
    show();
    var p = await window.api('/user-profile/' + encodeURIComponent(usernameArg));
    if (!p || p.error) return;
    if (!peer || peer.username !== usernameArg) return;   // moved on already
    peer = {
      id: p.id, username: p.username, avatar: p.avatar,
      muted: !!p.muted, blocked: !!p.blocked, isSelf: !!p.isSelf,
    };
    render();
  }

  function show() { $('peer-modal').classList.remove('hidden'); }
  function close() { $('peer-modal').classList.add('hidden'); }

  function render() {
    if (!peer) return;
    var A = window.PeerActions;
    $('peer-avatar').textContent = A.avatarFor(peer);
    $('peer-name').textContent = peer.username;
    var tag = $('peer-tag');
    tag.textContent = peer.blocked ? 'Blocked' : peer.muted ? 'Notifications muted' : '';
    tag.className = peer.blocked ? 'peer-tag peer-tag-blocked' : 'peer-tag';

    var body = $('peer-actions');
    body.innerHTML = '';
    var actions = A.actionsFor(peer, isDm);

    if (actions.indexOf('mute') !== -1) {
      body.appendChild(row(
        peer.muted ? '🔔' : '🔕',
        A.muteLabel(peer.muted), A.muteHint(peer.muted, peer.username), false,
        function () { setFlag('mute', !peer.muted); }));
    }
    if (actions.indexOf('block') !== -1) {
      body.appendChild(row(
        peer.blocked ? '🔓' : '🚫',
        A.blockLabel(peer.blocked), A.blockHint(peer.blocked, peer.username), !peer.blocked,
        function () {
          ask(A.blockConfirm(peer.blocked, peer.username), function () {
            setFlag('block', !peer.blocked);
          });
        }));
    }
    if (actions.indexOf('clear') !== -1) {
      var sep = document.createElement('div');
      sep.className = 'peer-sep';
      body.appendChild(sep);
      A.clearScopes(isDm).forEach(function (scope) {
        body.appendChild(row(
          scope === 'both' ? '🗑' : '🙈',
          A.clearLabel(scope), A.clearHint(scope, peer.username), scope === 'both',
          function () {
            ask(A.clearConfirm(scope, peer.username), function () { clearHistory(scope); });
          }));
      });
    }
  }

  function row(icon, label, hint, danger, onClick) {
    var b = document.createElement('button');
    b.className = 'peer-row' + (danger ? ' peer-row-danger' : '');
    b.onclick = onClick;
    var i = document.createElement('span');
    i.className = 'peer-row-icon';
    i.textContent = icon;
    var txt = document.createElement('span');
    txt.className = 'peer-row-text';
    var l = document.createElement('b');
    l.textContent = label;
    var h = document.createElement('em');
    h.textContent = hint;
    txt.appendChild(l); txt.appendChild(h);
    b.appendChild(i); b.appendChild(txt);
    return b;
  }

  /** Irreversible things get asked about; reversible ones just happen. */
  function ask(confirmSpec, go) {
    if (!confirmSpec) { go(); return; }
    if (window.confirm(confirmSpec.title + '\n\n' + confirmSpec.body)) go();
  }

  async function setFlag(kind, on) {
    if (!peer || !peer.id) return;
    var r = await window.api('/' + kind + '/' + peer.id, on ? 'POST' : 'DELETE');
    if (r && r.error) { alert(r.error); return; }
    if (kind === 'mute') peer.muted = on; else peer.blocked = on;
    render();
  }

  async function clearHistory(scope) {
    if (!forRoomId) return;
    var r = await window.api('/clear-history/' + forRoomId, 'POST', { scope: scope });
    if (r && r.error) { alert(r.error); return; }
    close();
    // The chat is emptied here rather than on the next load: clearing is the
    // one action where a delay looks exactly like it did not work.
    if (String(forRoomId) === String(window.currentRoomId)) {
      var list = $('messages');
      if (list) list.innerHTML = '';
    }
    if (window.onHistoryCleared) window.onHistoryCleared(forRoomId);
  }

  window.Peer = { open: open, close: close };
})();
