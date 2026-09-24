// ── "On web version info of message should be implemented" ──────────────────
//
// The server has answered `message_info` since the app grew this panel — it
// reads read-mark HISTORY rather than each member's current position, so it
// can say when somebody passed THIS message rather than only where they are
// now. The web simply never asked.
//
// The presentation rules were written inline in ChatScreen. They moved into a
// module when the web needed the same panel, because the alternative was
// typing them out a second time and letting two clients drift over whether a
// message has been read — which is the kind of disagreement nobody notices
// until somebody is sure they were ignored.
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const NAT = path.join(ROOT, 'native-app');
const WEB = require(path.join(ROOT, 'public', 'js', 'messageInfo.js'));

const tests = [];
const test = (n, f) => tests.push({ n, f });

// The app copy is compiled, so the two are compared as running code rather
// than as two files that look similar.
let APP = null;
const TSC = path.join(NAT, 'node_modules', '.bin', 'tsc');
if (fs.existsSync(TSC)) {
  const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'minfo-'));
  process.on('exit', () => fs.rmSync(OUT, { recursive: true, force: true }));
  execFileSync(TSC, [path.join(NAT, 'src', 'messageInfo.ts'),
    '--outDir', OUT, '--module', 'commonjs', '--target', 'es2019',
    '--skipLibCheck', '--esModuleInterop'], { stdio: 'pipe' });
  APP = require(path.join(OUT, 'messageInfo.js'));
}

test('A MESSAGE STILL BEING SENT HAS NO INFO TO SHOW', () => {
  // Its id is this client's invention; the server has never heard of it, so
  // the panel could only ever say "not found".
  assert.strictEqual(WEB.canShowInfo({ id: 42 }), true);
  assert.strictEqual(WEB.canShowInfo({ id: '42' }), true);
  for (const id of ['c-17368123', -1, 0, null, undefined, '', 'abc', NaN]) {
    assert.strictEqual(WEB.canShowInfo({ id }), false, JSON.stringify(id));
  }
  assert.strictEqual(WEB.canShowInfo(null), false);
  assert.strictEqual(WEB.canShowInfo(), false);
});

test('SQLITE\'S TIMESTAMP IS PARSED, on Safari too', () => {
  // The server sends "YYYY-MM-DD HH:MM:SS", which is UTC and which Safari
  // returns Invalid Date for. Left alone it prints a blank where the time
  // should be, on the one browser the report came from.
  const out = WEB.fullWhen('2026-09-24 08:30:00');
  assert.ok(out, 'a plain SQLite timestamp produced nothing');
  assert.ok(!/Invalid/.test(out));
  // It is read as UTC, not as local time — a space-separated string with no
  // zone is otherwise local on some engines and UTC on others, which is hours
  // of difference in whether a message looks read before it was sent.
  const asUtc = new Date('2026-09-24T08:30:00Z').getTime();
  assert.strictEqual(WEB.fullWhen(asUtc), out);
});

test('…and so are the forms that are already unambiguous', () => {
  assert.ok(WEB.fullWhen('2026-09-24T08:30:00Z'));
  assert.ok(WEB.fullWhen(1_800_000_000_000));
});

test('NOTHING IS NEVER PRINTED AS A DATE', () => {
  // A missing timestamp reads as the epoch if it is passed straight to Date,
  // and "01 Jan 1970" beside somebody's name is worse than a blank.
  for (const v of [null, undefined, '', 'not a date', NaN]) {
    assert.strictEqual(WEB.fullWhen(v), '', JSON.stringify(v));
  }
});

test('the headings carry the count', () => {
  // "Seen by" over a list of four names makes the reader count them, and the
  // count is what they opened this to learn.
  assert.strictEqual(WEB.seenHeading(3), 'Seen by 3');
  assert.strictEqual(WEB.notSeenHeading(2), 'Not seen yet 2');
  // Never a negative or a fraction, whatever arrives.
  assert.strictEqual(WEB.seenHeading(-1), 'Seen by 0');
  assert.strictEqual(WEB.seenHeading(null), 'Seen by 0');
  assert.strictEqual(WEB.seenHeading(undefined), 'Seen by 0');
  assert.strictEqual(WEB.seenHeading(2.7), 'Seen by 2');
});

test('an empty list says so in words', () => {
  assert.ok(/nobody/i.test(WEB.emptySeenText()));
});

test('THE TWO CLIENTS AGREE, function by function', () => {
  if (!APP) { console.log('    (native-app deps not installed — app copy not compared)'); return; }
  const missing = Object.keys(APP).filter(k => typeof APP[k] === 'function' && typeof WEB[k] !== 'function');
  assert.deepStrictEqual(missing, [], 'the web copy is missing: ' + missing.join(', '));

  // Every input that changes an answer, compared on both.
  for (const id of [42, '42', -1, 0, null, undefined, 'abc']) {
    assert.strictEqual(WEB.canShowInfo({ id }), APP.canShowInfo({ id }), `canShowInfo ${JSON.stringify(id)}`);
  }
  for (const v of ['2026-09-24 08:30:00', '2026-09-24T08:30:00Z', 1_800_000_000_000, null, '', 'nonsense']) {
    assert.strictEqual(WEB.fullWhen(v), APP.fullWhen(v), `fullWhen ${JSON.stringify(v)}`);
  }
  for (const n of [0, 1, 3, -1, null, 2.7]) {
    assert.strictEqual(WEB.seenHeading(n), APP.seenHeading(n), `seenHeading ${n}`);
    assert.strictEqual(WEB.notSeenHeading(n), APP.notSeenHeading(n), `notSeenHeading ${n}`);
  }
  assert.strictEqual(WEB.emptySeenText(), APP.emptySeenText());
});

// ── The wiring ──────────────────────────────────────────────────────────────

const app = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');
const appCode = app.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

test('THE WEB ACTUALLY OFFERS IT', () => {
  assert.ok(/id="ctx-info-btn"/.test(html), 'there is no Info entry in the message menu');
  assert.ok(/js\/messageInfo\.js/.test(html), 'the rules are never loaded by the page');
  assert.ok(/id="msginfo-modal"/.test(html), 'there is nowhere to show the answer');
  assert.ok(/function ctxInfo\(/.test(appCode), 'the menu entry calls nothing');
  assert.ok(/emit\('message_info'/.test(appCode), 'nothing asks the server');
});

test('…and hides it where it would only ever fail', () => {
  const i = appCode.indexOf("function openCtxMenu");
  const body = appCode.slice(i, appCode.indexOf('\n}', i));
  assert.ok(/MessageInfo\.canShowInfo\(msg\)/.test(body),
    'Info is offered on a message the server has never heard of');
});

test('A DEAD SOCKET DOES NOT LEAVE "Loading…" ON SCREEN', () => {
  // The whole panel is one round trip. Without a deadline a socket that has
  // gone quiet leaves a spinner and a Close button, and no way to tell which
  // of the two happened.
  const i = appCode.indexOf('function openMsgInfo');
  const body = appCode.slice(i, appCode.indexOf('\n}\n', i));
  assert.ok(/timeout\(\d+\)/.test(body), 'the request can hang for ever');
  assert.ok(/Could not reach the server|res\.error/.test(body), 'a failure says nothing');
});

test('THE APP USES THE SHARED RULES, rather than its own copy', () => {
  const chat = fs.readFileSync(path.join(NAT, 'src', 'screens', 'ChatScreen.tsx'), 'utf8');
  const code = chat.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  assert.ok(/messageInfo\.canShowInfo\(/.test(code), 'the app still decides for itself');
  assert.ok(/messageInfo\.fullWhen/.test(code), 'the app formats its own times');
  assert.ok(!/Number\(m\.id\) > 0 &&/.test(code), 'the old inline check is still there');
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
