// ── Searching inside a chat (web) ───────────────────────────────────────────
//
// The app has had this for a while; the web had the endpoints and no way to
// reach them. Same shape as the app and as every chat people already use: the
// header turns into a search field, matches are counted, and up/down step
// through them while the chat scrolls to each one.
//
// The search runs on the SERVER, so it covers the whole history rather than
// whatever the page happens to have scrolled through. Encrypted messages are
// searched on the device — see the `local` hook below, filled in by
// encsearch.js.
(function () {
  'use strict';

  var hits = [];
  var idx = 0;
  var skipped = 0;
  var searched = false;
  var timer = null;
  var runId = 0;      // guards against an older, slower response landing last

  function $(id) { return document.getElementById(id); }

  function open() {
    if (!window.currentRoomId) return;
    $('chat-search').classList.remove('hidden');
    $('chat-search-input').value = '';
    reset();
    $('chat-search-input').focus();
  }

  function close() {
    $('chat-search').classList.add('hidden');
    clearTimeout(timer);
    runId++;                       // abandon anything still in flight
    reset();
  }

  function reset() {
    hits = []; idx = 0; skipped = 0; searched = false;
    render();
  }

  function onInput() {
    clearTimeout(timer);
    var term = $('chat-search-input').value.trim();
    if (term.length < 2) { reset(); return; }
    $('chat-search-count').textContent = 'Searching…';
    // Typing a word should not be one request per keystroke.
    timer = setTimeout(function () { run(term); }, 350);
  }

  async function run(term) {
    var mine = ++runId;
    var roomId = window.currentRoomId;
    var r = await window.api('/search-messages/' + roomId + '?q=' + encodeURIComponent(term));
    if (mine !== runId) return;                       // superseded
    var server = (r && !r.error && r.results) ? r.results : [];
    skipped = (r && !r.error && r.encryptedSkipped) ? r.encryptedSkipped : 0;

    // Encrypted messages cannot be matched by a server holding no key. If the
    // on-device searcher is loaded, hand the work to it.
    if (skipped && window.EncSearch) {
      try {
        var extra = await window.EncSearch.search(roomId, term);
        if (mine !== runId) return;
        server = window.LocalSearch.mergeResults(server, extra.results);
        skipped = extra.stillSkipped;
      } catch (e) { /* keep the server's answer */ }
    }

    hits = server;
    idx = 0;
    searched = true;
    render();
    // Land on the newest match straight away — what somebody searching a chat
    // almost always wants.
    if (hits.length) window.jumpToMessage(hits[0].id);
  }

  function step(delta) {
    if (!hits.length) return;
    idx = (idx + delta + hits.length) % hits.length;
    render();
    window.jumpToMessage(hits[idx].id);
  }

  function render() {
    var count = $('chat-search-count');
    var note = $('chat-search-note');
    if (!searched) { count.textContent = ''; note.textContent = ''; return; }
    count.textContent = hits.length ? (idx + 1) + ' of ' + hits.length : 'No messages found';
    // Honest about what could not be reached, rather than reporting "no
    // matches" for a chat whose history is longer than the handover cap.
    note.textContent = skipped
      ? skipped + ' older ' + (skipped === 1 ? 'message' : 'messages') + ' not searched'
      : '';
  }

  window.ChatSearch = {
    open: open, close: close, onInput: onInput,
    next: function () { step(1); },
    prev: function () { step(-1); },
    isOpen: function () { return !$('chat-search').classList.contains('hidden'); },
  };
})();
