// ── Three things asked for on the web ───────────────────────────────────────
//
//   1. the composer hides the text once there is more than a little of it
//   2. remove the Paste button
//   3. people should be able to leave rooms
//
// The first has one cause, and it is visible in the markup rather than in any
// rule: the composer was an <input type="text">. A single-line input scrolls
// SIDEWAYS — once the message is wider than the box, everything typed earlier
// is pushed out of sight and there is no way to read it back while writing.
//
// The third was not missing at all. leaveCurrentRoom() was written, worked,
// and nothing anywhere called it.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
// Comments stripped: the stylesheet explains an earlier decision by quoting
// `#msg-input { font-size: 0.95rem }` in prose, and a rule-matching regex
// finds that first. A test about CSS should not be reading commentary.
const css = fs.readFileSync(path.join(ROOT, 'public', 'css', 'style.css'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '');
const app = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');
const code = app.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');

const tests = [];
const test = (n, f) => tests.push({ n, f });

// ── 1. The composer ─────────────────────────────────────────────────────────

test('THE COMPOSER CAN SHOW MORE THAN ONE LINE', () => {
  // The whole of the reported bug. An <input> cannot wrap, so a long message
  // scrolls out of view to the left as it is typed.
  assert.ok(/<textarea id="msg-input"/.test(html),
    'the composer is a single-line input again, so long text scrolls out of sight');
  assert.ok(!/<input id="msg-input"/.test(html), 'the old single-line input is back');
});

test('…and it grows to fit, then stops', () => {
  const rule = /#msg-input \{[^}]*\}/.exec(css);
  assert.ok(rule, 'the composer is not styled');
  assert.ok(/max-height:/.test(rule[0]),
    'the composer can grow without limit and will swallow the conversation');
  assert.ok(/overflow-y:\s*auto/.test(rule[0]),
    'past its maximum the text is clipped instead of scrolling');
  // The drag handle would land on top of the send button.
  assert.ok(/resize:\s*none/.test(rule[0]), 'the textarea can be dragged over the send button');
});

test('THE GROWTH IS MEASURED, and can shrink again', () => {
  const i = code.indexOf('function resizeComposer');
  assert.ok(i > 0, 'nothing sizes the composer');
  const body = code.slice(i, code.indexOf('\n}', i));
  // Reset to auto first or scrollHeight is measured against the height already
  // set, and the box can only ever get taller — so it keeps the size of a
  // message that has already been sent.
  assert.ok(/height = 'auto'/.test(body),
    'the box can only grow, so it stays tall after the message is sent');
  assert.ok(/scrollHeight/.test(body), 'the height is guessed rather than measured');
});

test('A HEIGHT IS NEVER PINNED FROM A MEASUREMENT OF NOTHING', () => {
  // Reported from a screenshot: the composer looked half-rendered, with the
  // placeholder cut through the middle.
  //
  // A textarea that is not laid out yet — the chat pane still hidden, the
  // fonts not settled — measures scrollHeight 0. That was written straight
  // into the inline height, leaving a box one padding tall, and because it is
  // inline it stayed that way afterwards.
  const i = code.indexOf('function resizeComposer');
  const body = code.slice(i, code.indexOf('\n}', i));
  assert.ok(/const next = el\.scrollHeight/.test(body), 'the measurement is not held to be checked');
  assert.ok(/if \(next > 0\)/.test(body),
    'a zero measurement is written into the height, collapsing the composer');
  assert.ok(/else el\.style\.height = '';/.test(body),
    'a bad measurement leaves the previous height pinned instead of clearing it');
});

test('…and the stylesheet has a floor under it either way', () => {
  // Belt as well as braces: the height comes from JS, so the one thing CSS
  // can do is refuse to go under a line.
  const rule = /#msg-input \{[^}]*\}/.exec(css);
  assert.ok(rule, 'the composer is not styled');
  assert.ok(/min-height:/.test(rule[0]),
    'nothing stops the composer collapsing to less than one line');
});

test('…and everything that empties the box also resizes it', () => {
  // Sending, and switching away from a chat. Miss one and the composer keeps
  // the height of text that is no longer in it.
  // Anchored on the send path specifically — clearing the box, resizing it,
  // and dropping the draft are that path and nothing else. `clearOneTime()`
  // alone appears in another function and matched there instead.
  assert.ok(/input\.value = '';\s*resizeComposer\(\);\s*clearDraft\(roomId\);/.test(code),
    'sending no longer resets the composer height');
  const draft = code.indexOf('function restoreDraft');
  const body = code.slice(draft, code.indexOf('\n}', draft));
  assert.ok(/resizeComposer\(\)/.test(body),
    'a restored draft of several lines is shown in a one-line box');
});

test('ENTER STILL SENDS, and Shift+Enter makes a line', () => {
  // A textarea inserts a newline on Enter by default, which would stop the
  // box sending anything at all.
  const i = code.indexOf('function handleInputKey');
  const body = code.slice(i, code.indexOf('\n}', i));
  assert.ok(/e\.key === 'Enter' && !e\.shiftKey/.test(body),
    'Enter no longer sends, or Shift+Enter cannot make a new line');
  assert.ok(/preventDefault\(\)/.test(body),
    'Enter sends AND inserts a newline, leaving a blank line in the box');
});

// ── 2. The Paste button ─────────────────────────────────────────────────────

test('THE PASTE BUTTON IS GONE', () => {
  assert.ok(!/composer-paste/.test(html), 'the Paste button is back in the composer strip');
  assert.ok(!/composerPaste/.test(app), 'the Paste button handler is still there');
});

test('…but pasting and dropping still work', () => {
  // Only the button was asked for. Ctrl+V anywhere on the page and
  // drag-and-drop are the things that actually do the work.
  assert.ok(/function setupPasteAndDrop/.test(code), 'paste and drop were removed with the button');
  assert.ok(/'paste'/.test(code), 'Ctrl+V no longer does anything');
  assert.ok(/'drop'/.test(code), 'dropping a file no longer does anything');
});

// ── 3. Leaving a room ───────────────────────────────────────────────────────

test('LEAVING A ROOM IS REACHABLE — it never was', () => {
  // leaveCurrentRoom() existed, worked, and nothing called it. The button in
  // the room-info panel is wired to it; the chat list had no way in at all,
  // so leaving a chat meant opening it first.
  assert.ok(/function leaveRoom\(roomId\)/.test(code), 'there is no way to leave a room by id');
  assert.ok(/onclick="leaveCurrentRoom\(\)"/.test(html), 'the room-info button lost its handler');
  const i = code.indexOf('function addRoomMenu');
  assert.ok(i > 0, 'the chat list has no menu');
  const menu = code.slice(i, code.indexOf('\n}', i));
  assert.ok(/leaveRoom\(roomId\)/.test(menu), 'the chat list still cannot leave a room');
});

test('…but not for a room you created, which the server refuses', () => {
  const i = code.indexOf('function addRoomMenu');
  const menu = code.slice(i, code.indexOf('\n}', i));
  assert.ok(/isMyRoom\(roomId\)/.test(menu),
    'Leave is offered on your own rooms, where it can only fail');
  assert.ok(/function isMyRoom/.test(code), 'nothing decides whose room it is');
  assert.ok(/function myUserId/.test(code), 'the page does not know who it is signed in as');
});

test('LEAVING ONE ROOM DOES NOT CLOSE ANOTHER', () => {
  // The old body assumed the room being left was the one on screen, because
  // that was the only way to reach it. From the list it usually is not, and
  // tearing the pane down would close a conversation somebody is reading.
  const i = code.indexOf('function leaveRoom(roomId)');
  const body = code.slice(i, code.indexOf('\n}\n', i));
  assert.ok(/String\(currentRoomId\) !== String\(roomId\)\) return/.test(body),
    'leaving a room from the list closes whatever chat is open');
});

test('the room the menu asks about is one the page actually knows', () => {
  assert.ok(/const knownRooms = \{\}/.test(code), 'nothing remembers the rooms in the list');
  const i = code.indexOf('function addRoomToList');
  const body = code.slice(i, i + 400);
  assert.ok(/knownRooms\[String\(room\.id\)\] = room/.test(body), 'the list never records a room');
  // Recorded BEFORE the early return, or a room already on screen is never
  // remembered and Leave is offered on rooms you own.
  const record = body.indexOf('knownRooms[String(room.id)] = room');
  const bail = body.indexOf('if (document.querySelector');
  assert.ok(record < bail, 'a room already in the list is never recorded');
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
