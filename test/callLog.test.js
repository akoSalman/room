// ── One call, one entry, in the middle ──────────────────────────────────────
//
// Reported as: call logs in a chat should sit in the middle in message order,
// and there should not be two of them.
//
// TWO OF THEM because both ends log it. Every call tears down on both sides
// and both sides emit `call_log`, so one call put two identical rows in the
// chat. Nothing picked a side, and nothing could: either end can be the one
// that hangs up, either can be an older build, either can lose the network
// before it reports. The server is the only place that sees both.
//
// NOT IN THE MIDDLE because a call row was drawn inside an ordinary bubble,
// which is aligned by who sent it — and who "sent" a call log was whichever
// app happened to report it first. So the same call appeared on the left in
// one person's chat and on the right in the other's.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const web = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'public', 'css', 'style.css'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '');
const chat = fs.readFileSync(path.join(ROOT, 'native-app', 'src', 'screens', 'ChatScreen.tsx'), 'utf8');

const tests = [];
const test = (n, f) => tests.push({ n, f });

test('ONE CALL IS ONE ENTRY, however many ends report it', () => {
  const i = server.indexOf("socket.on('call_log'");
  assert.ok(i > 0, 'calls are no longer logged');
  const body = server.slice(i, server.indexOf('\n  });', i));
  assert.ok(/type = 'call'[\s\S]*?datetime\('now', '-15 seconds'\)/.test(body),
    'a second report of the same call is stored as a second entry');
  assert.ok(/if \(twin\) \{[\s\S]{0,260}return;/.test(body),
    'the duplicate is found and stored anyway');
});

test('…matched on what both reports agree about', () => {
  // Not on the duration: one end may round differently, and the one with a
  // duration is no more correct than the one without.
  const i = server.indexOf("socket.on('call_log'");
  const body = server.slice(i, server.indexOf('\n  });', i));
  assert.ok(/c\.kind === mine\.kind && c\.outcome === mine\.outcome/.test(body),
    'the two reports are matched on something they can disagree about');
});

test('…and a genuinely separate call is still logged', () => {
  // The window has to be shorter than any redial somebody would want to see
  // listed separately, and longer than the gap between two teardowns.
  const i = server.indexOf("socket.on('call_log'");
  const body = server.slice(i, server.indexOf('\n  });', i));
  const m = /-(\d+) seconds/.exec(body);
  assert.ok(m, 'there is no window at all');
  const secs = Number(m[1]);
  assert.ok(secs >= 5, 'the window is too short to catch the second report');
  assert.ok(secs <= 60, 'a redial a minute later is swallowed as a duplicate');
});

test('THE WEB PUTS IT IN THE MIDDLE', () => {
  assert.ok(/const centred = msg\.type === 'system' \|\| msg\.type === 'call'/.test(web),
    'a call log is still aligned to whoever reported it');
  assert.ok(/\(centred \? ' centred' : ''\)/.test(web), 'the class is computed and never used');
  const rule = /\.msg-wrapper\.centred \{[^}]*\}/.exec(css);
  assert.ok(rule, 'there is no rule to centre it');
  assert.ok(/align-self: center/.test(rule[0]), 'the row is not centred');
});

test('…and gives it no sender header', () => {
  // "ako" over a call log would be claiming somebody sent it.
  assert.ok(/if \(!isMine && !centred\) \{/.test(web),
    'a call log gets a sender name above it, as though somebody had sent it');
});

test('THE APP PUTS IT IN THE MIDDLE', () => {
  const i = chat.indexOf("if (msg.type === 'call') {");
  assert.ok(i > 0, 'the app no longer draws call logs');
  const body = chat.slice(i, i + 1400);
  assert.ok(/s\.systemRow/.test(body), 'the call log is not in a centred row');
  // Returned early, like a system notice — not drawn inside a bubble.
  assert.ok(i < chat.indexOf("if (msg.type === 'system') {"),
    'the call branch is no longer an early return');
  assert.ok(!/\{msg\.type === 'call' && \(\(\) => \{/.test(chat),
    'the old in-bubble copy is still there, so it draws twice');
});

test('…and can still be long-pressed, like any other message', () => {
  // Deleting a call log is the thing somebody actually wants to do with one.
  const i = chat.indexOf("if (msg.type === 'call') {");
  const body = chat.slice(i, i + 1400);
  assert.ok(/onLongPress=\{\(\) => onMessageLongPress\(msg\)\}/.test(body),
    'a call log cannot be deleted, because nothing opens its menu');
});

// ── The web had no call log at all ─────────────────────────────────────────

const CALLS = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'calls.js'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

test('THE WEB REPORTS ITS CALLS, which it never used to', () => {
  // Calling from a browser left no trace anywhere: the app reported every
  // finished call and the web reported none, so a call made from a laptop
  // never happened as far as the conversation was concerned.
  assert.ok(/sock\.emit\('call_log'/.test(CALLS), 'the web still never reports a call');
  for (const outcome of ['completed', 'missed', 'declined']) {
    assert.ok(new RegExp("'" + outcome + "'").test(CALLS), `no call ever reports ${outcome}`);
  }
});

test('IT LOGS AGAINST THE CALL\'S OWN PEER, not whichever chat is open', () => {
  // dmPeer is the conversation on screen. On an incoming call that is often
  // not the person calling, and logging against it files the call under the
  // wrong chat entirely.
  assert.ok(/callPeerId/.test(CALLS), 'the call does not remember who it is with');
  assert.ok(!/peerId: dmPeer\.userId/.test(CALLS),
    'the log still uses whichever chat happens to be open');
});

test('A DECLINED CALL IS LOGGED, even though it never starts', () => {
  // Declining never reaches teardown, because `mode` is never set -- so a
  // refused call would leave no entry while every other outcome did.
  const fn = /function decline\(\) \{([\s\S]*?)\n  \}/.exec(CALLS);
  assert.ok(fn, 'could not find decline()');
  assert.ok(/logCall\('declined'/.test(fn[1]), 'a refused call is never recorded');
});

test('ROOM VOICE CHAT IS NOT A CALL and is not logged', () => {
  // It has no single peer to log against, and it is not a thing that belongs
  // in a conversation's history.
  assert.ok(/mode\.indexOf\('dm'\) === 0/.test(CALLS) || /mode\.startsWith\('dm'\)/.test(CALLS),
    'room voice chat would be written into a chat as a call');
});

test('ONE CALL IS STILL ONE ENTRY from the web too', () => {
  // Both ends report and the server keeps the first; the web must also not
  // report the same call twice itself.
  assert.ok(/if \(logged \|\|/.test(CALLS), 'the web can report the same call more than once');
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
