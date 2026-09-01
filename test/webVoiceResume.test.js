// Two iPhone-web reports, both about state the page could not get out of.
//
//   1. "When someone sends a voice message and you tap play, it all spins and
//      doesn't play until refreshing the page — this happens for the last
//      message just."
//
//      Safari on iOS only lets a sound start from inside the click that asked
//      for it. The old code, for a file it had not buffered, added a `canplay`
//      listener and called play() from THERE — long after the tap, in no
//      gesture at all. And since iOS does not preload media on its own and
//      nothing ever asked it to load, `canplay` had nothing to fire from for a
//      message that had just arrived: the spinner waited on an event that
//      would never come. A reload "fixed" it because the file was then in the
//      browser cache and the element was ready with no loading at all — which
//      is exactly why only the NEWEST message misbehaved.
//
//   2. "On refreshing the page I have to select the chat and enter again,
//      while the composer is there."
//
//      The page remembered nothing about which chat was open — and iOS reloads
//      a backgrounded tab by itself, so this is not something people choose —
//      and the composer, which belongs to the page rather than to a chat, sat
//      there offering a message box with nowhere to send anything.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
global.window = global;
require(path.join(ROOT, 'public', 'js', 'voicePlayback.js'));
require(path.join(ROOT, 'public', 'js', 'chatResume.js'));
const V = global.window.VoicePlayback;
const R = global.window.ChatResume;

const tests = [];
const test = (n, f) => tests.push({ n, f });

// ── The spinner that never ended ────────────────────────────────────────────

test('THE BUG: a tap always calls play() itself, in the click', () => {
  // This is the whole of the iOS fault. A play() made later, from a listener,
  // is not allowed to make a sound.
  assert.strictEqual(V.playsNow('idle'), true);
  assert.strictEqual(V.playsNow('paused'), true);
  assert.strictEqual(V.playsNow('failed'), true, 'a failed message could not be tried again');
  assert.strictEqual(V.playsNow('buffering'), true);
  // The one case that is not a play: it is already playing, so the tap pauses.
  assert.strictEqual(V.playsNow('playing'), false);
});

test('the spinner is only ever what the audio element reports', () => {
  assert.strictEqual(V.spins('buffering'), true);
  for (const s of ['idle', 'playing', 'paused', 'failed']) {
    assert.strictEqual(V.spins(s), false, `${s} spins`);
  }
  assert.strictEqual(V.reduce('buffering', 'playing'), 'playing',
    'the audio started and the button kept spinning');
});

test('THE DEAD END: a spinner always ends, one way or the other', () => {
  // There was no timeout, no error handler, and no way back to a play button
  // short of reloading the page.
  assert.strictEqual(V.reduce('buffering', 'timeout'), 'failed');
  assert.strictEqual(V.reduce('buffering', 'error'), 'failed');
  assert.strictEqual(V.reduce('buffering', 'blocked'), 'failed');
  assert.strictEqual(V.armsTimeout('buffering'), true, 'nothing is armed to end the spin');
  for (const s of ['idle', 'playing', 'paused', 'failed']) {
    assert.strictEqual(V.armsTimeout(s), false, `${s} arms a pointless timeout`);
  }
  assert.ok(V.SPIN_TIMEOUT_MS >= 5000, 'a slow connection is called a failure too soon');
  assert.ok(V.SPIN_TIMEOUT_MS <= 20000, 'somebody is left watching a circle turn');
});

test('a timeout cannot interrupt something that is playing', () => {
  assert.strictEqual(V.reduce('playing', 'timeout'), 'playing');
  assert.strictEqual(V.reduce('paused', 'timeout'), 'paused');
});

test('tapping while it plays pauses; tapping again resumes', () => {
  assert.strictEqual(V.reduce('playing', 'click'), 'paused');
  assert.strictEqual(V.reduce('paused', 'click'), 'buffering');
  assert.strictEqual(V.reduce('idle', 'click'), 'buffering');
  assert.strictEqual(V.reduce('failed', 'click'), 'buffering', 'a failure could not be retried');
});

test('buffering mid-playback does not look like a fresh start', () => {
  assert.strictEqual(V.reduce('playing', 'waiting'), 'buffering');
  // …but a `waiting` fired at a paused element does not start a spinner.
  assert.strictEqual(V.reduce('paused', 'waiting'), 'paused');
});

test('the end of a message resets it to a play button', () => {
  assert.strictEqual(V.reduce('playing', 'ended'), 'idle');
  assert.strictEqual(V.buttonFace('idle'), '▶');
  assert.strictEqual(V.buttonFace('playing'), '⏸');
  assert.strictEqual(V.buttonFace('paused'), '▶');
  assert.strictEqual(V.buttonFace('failed'), '▶', 'a failed message shows no way to try again');
  assert.strictEqual(V.buttonFace('buffering'), '', 'a glyph is drawn over the spinner');
});

test('an unknown event changes nothing', () => {
  assert.strictEqual(V.reduce('playing', 'nonsense'), 'playing');
});

test('a blocked sound says what to do about it', () => {
  assert.ok(/tap play again/i.test(V.failureMessage('blocked')), V.failureMessage('blocked'));
  assert.ok(/could not play/i.test(V.failureMessage('error')));
});

// ── Coming back to the chat you were in ─────────────────────────────────────

const ROOMS = [{ id: 7, name: 'Work' }];
const DMS = [{ id: 3, name: 'dm', is_dm: 1, other_username: 'Ako' }];

test('THE BUG: a reload comes back to the chat that was open', () => {
  const saved = R.serialise({ id: 7, name: 'Work', isDm: false, at: Date.now() });
  assert.deepStrictEqual(R.resumeTarget({ saved, rooms: ROOMS, dms: DMS }),
    { id: 7, name: 'Work', isDm: false });
});

test('a DM comes back named after the person, not "dm"', () => {
  const saved = R.serialise({ id: 3, name: 'Ako', isDm: true });
  assert.deepStrictEqual(R.resumeTarget({ saved, rooms: ROOMS, dms: DMS }),
    { id: 3, name: 'Ako', isDm: true });
});

test('the name comes from the LIST, so a rename is picked up', () => {
  const saved = R.serialise({ id: 7, name: 'Old name', isDm: false });
  assert.strictEqual(R.resumeTarget({ saved, rooms: [{ id: 7, name: 'New name' }], dms: [] }).name,
    'New name');
});

test('a chat you are no longer in is NOT reopened', () => {
  // Rooms get left, deleted and revoked; reopening one would show an empty
  // screen with a name at the top of it.
  const saved = R.serialise({ id: 99, name: 'Gone', isDm: false });
  assert.strictEqual(R.resumeTarget({ saved, rooms: ROOMS, dms: DMS }), null);
});

test('a room link in the address bar outranks the memory', () => {
  // That is a decision made just now; the saved room is only where you were.
  const saved = R.serialise({ id: 7, name: 'Work', isDm: false });
  assert.strictEqual(R.resumeTarget({ saved, rooms: ROOMS, dms: DMS, joinParam: '3' }), null);
});

test('nothing saved, or nonsense saved, opens nothing', () => {
  for (const saved of [null, undefined, '', 'not json', '{}', '[]', '{"id":""}', 'null']) {
    assert.strictEqual(R.resumeTarget({ saved, rooms: ROOMS, dms: DMS }), null, String(saved));
  }
});

test('ids are compared as strings, because storage has no numbers', () => {
  const saved = R.serialise({ id: '7', name: 'Work', isDm: false });
  assert.ok(R.resumeTarget({ saved, rooms: [{ id: 7, name: 'Work' }], dms: [] }));
});

test('a failed room request is not "you are in no rooms"', () => {
  // Otherwise one bad response on a reload forgets where you were.
  const saved = R.serialise({ id: 7, name: 'Work', isDm: false });
  assert.strictEqual(R.resumeTarget({ saved, rooms: { error: 'No connection' }, dms: null }), null);
});

test('a chat with no id is never written down', () => {
  assert.strictEqual(R.serialise(null), null);
  assert.strictEqual(R.serialise({}), null);
  assert.strictEqual(R.serialise({ id: '' }), null);
  assert.ok(R.serialise({ id: 0, name: 'x' }), 'a room whose id is 0 could never be remembered');
});

test('the composer is only offered when there is somewhere to send', () => {
  // A message box with nowhere to send anything is what made a forgotten
  // reload look like a broken app.
  assert.strictEqual(R.composerVisible(null), false);
  assert.strictEqual(R.composerVisible(undefined), false);
  assert.strictEqual(R.composerVisible(7), true);
  assert.strictEqual(R.composerVisible('7'), true);
});

// ── The wiring ──────────────────────────────────────────────────────────────

const app = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

test('play() is called in the click handler, not from a listener', () => {
  const fn = app.slice(app.indexOf('playBtn.onclick = () => {'), app.indexOf('// A tap anywhere on the row'));
  assert.ok(fn.length > 0, 'the play handler is gone — this check would be vacuous');
  assert.ok(/const started = audio\.play\(\);/.test(fn), 'the tap does not start the audio itself');
  assert.ok(!/addEventListener\('canplay'/.test(fn),
    "the play is still deferred to a canplay listener, which iOS will not sound");
  assert.ok(/started\.catch\(/.test(fn), 'a refused play is not noticed at all');
});

test('the element is told to load, and to stay inline', () => {
  assert.ok(/audio\.preload = 'metadata'/.test(app), 'iOS is never asked to load the file');
  assert.ok(/audio\.playsInline = true/.test(app), 'iOS may take the audio fullscreen');
});

test('the button is driven by the state machine, not by a local flag', () => {
  assert.ok(/VoicePlayback\.buttonFace\(state\)/.test(app), 'the glyph is set by hand');
  assert.ok(/VoicePlayback\.spins\(state\)/.test(app), 'the spinner is toggled by hand');
  assert.ok(/setTimeout\(\(\) => apply\('timeout'\)/.test(app), 'nothing ends a stuck spinner');
  for (const ev of ['playing', 'waiting', 'pause', 'error']) {
    assert.ok(app.includes(`audio.addEventListener('${ev}'`), `the element's ${ev} is ignored`);
  }
});

test('the open chat is written down, and read back on load', () => {
  assert.ok(/localStorage\.setItem\(ChatResume\.KEY, saved\)/.test(app), 'the chat is never remembered');
  assert.ok(app.includes('function resumeLastRoom('), 'nothing reopens it');
  assert.ok(/resumeLastRoom\(roomList, dmList\)/.test(app), 'the resume is never called');
  const fn = app.slice(app.indexOf('function resumeLastRoom('), app.indexOf('// ─── App ───'));
  assert.ok(fn.includes('ChatResume.resumeTarget({'), 'the resume decides for itself what to open');
  assert.ok(fn.includes('joinRoom('), 'the room is found and then not opened');
});

test('leaving or losing a chat forgets it', () => {
  // Otherwise the next reload reopens a room you were removed from.
  assert.ok(app.includes('function forgetRoom()'), 'there is no way to forget the saved chat');
  assert.ok(/localStorage\.removeItem\(ChatResume\.KEY\)/.test(app), 'the memory outlives the room');
  const uses = app.match(/forgetRoom\(\)/g) || [];
  assert.ok(uses.length >= 4, `only ${uses.length} of the ways out of a chat forget it`);
  assert.ok(!/currentRoomId = null;\n\s*document\.getElementById\('messages'\)/.test(app),
    'a path still clears the room without forgetting it');
});

test('the composer appears with a chat and not before it', () => {
  assert.ok(app.includes('function showComposer('), 'the composer is always on screen');
  assert.ok(/showComposer\(false\);\s*\/\/ nothing is open yet/.test(app),
    'the app starts with a message box that can send nothing');
  assert.ok(/showComposer\(true\);/.test(app), 'opening a chat never brings the composer back');
});

test('the two rule files are actually loaded by the page', () => {
  assert.ok(html.includes('/js/voicePlayback.js'));
  assert.ok(html.includes('/js/chatResume.js'));
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
