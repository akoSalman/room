// ── The unread divider, a fourth time — and this time not the arithmetic ────
//
// Reported three times as the same thing: "3 NEW MESSAGES" with the line
// sitting after the first of them. Twice I read that as a counting bug and
// fixed the counting. Both fixes were real. Neither touched the cause.
//
// The divider was drawn exactly where the app believed the unread messages
// began. That belief came from the server's read position, and the app had
// already moved it past messages nobody had seen — because the chat screen
// marked a message read the instant it ARRIVED, with no check that anybody was
// looking.
//
// Backgrounding the app emits leave_room, so notifications resume, but the
// screen stays mounted and its socket handler keeps running. Every message
// that landed while the phone was locked was reported as read. Same for
// messages arriving while the reader was scrolled back through history.
//
// So the label and the line agreed with each other and both disagreed with the
// user, which is why two rounds of making them agree harder changed nothing.
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const NAT = path.join(ROOT, 'native-app');
const TSC = path.join(NAT, 'node_modules', '.bin', 'tsc');

global.window = global;
const W = require(path.join(ROOT, 'public', 'js', 'readPosition.js'));

let A = null;
if (fs.existsSync(TSC)) {
  const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'readpos-'));
  execFileSync(TSC, [path.join(NAT, 'src', 'readPosition.ts'),
    '--outDir', OUT, '--module', 'commonjs', '--target', 'es2019', '--skipLibCheck'], { stdio: 'pipe' });
  A = require(path.join(OUT, 'readPosition.js'));
  process.on('exit', () => fs.rmSync(OUT, { recursive: true, force: true }));
} else {
  console.log('  ! app-side rule skipped (native-app deps not installed); web copy still checked');
}

const tests = [];
const test = (n, f) => tests.push({ n, f });

// ── The rule ────────────────────────────────────────────────────────────────

test('THE BUG: a message arriving while the phone is locked is NOT read', () => {
  // The chat screen stays mounted when the app goes to the background, and its
  // socket handler kept marking every arrival read. This is the case that put
  // the unread line below messages the user had never seen.
  assert.strictEqual(W.marksRead({ appActive: false, atBottom: true }), false);
});

test('…nor is one arriving while the reader is scrolled back through history', () => {
  // The app already knows the difference — it uses it to decide whether to
  // follow new messages. It just did not use it here.
  assert.strictEqual(W.marksRead({ appActive: true, atBottom: false }), false);
});

test('a message that actually reached their eyes IS read', () => {
  // The fix must not be "never mark anything read", which would leave the
  // divider up for ever and is the same bug from the other side.
  assert.strictEqual(W.marksRead({ appActive: true, atBottom: true }), true);
});

test('your own message is read wherever you are', () => {
  // Sending it put it on screen. Without this, sending a message from a
  // scrolled-up position would leave it sitting under an unread line.
  assert.strictEqual(W.marksRead({ appActive: true, atBottom: false, fromMe: true }), true);
  assert.strictEqual(W.marksRead({ appActive: false, atBottom: false, fromMe: true }), true);
});

test('nothing at all is not a reason to mark anything read', () => {
  assert.strictEqual(W.marksRead(null), false);
  assert.strictEqual(W.marksRead(undefined), false);
  assert.strictEqual(W.marksRead({}), false);
});

test('readUpTo sends NOTHING rather than a lower id', () => {
  // A refused mark must send no event. Sending an older id would drag the read
  // position BACKWARDS and resurrect messages the user really had read.
  assert.strictEqual(W.readUpTo(42, { appActive: false, atBottom: true }), null);
  assert.strictEqual(W.readUpTo(42, { appActive: true, atBottom: true }), 42);
  assert.strictEqual(W.readUpTo(null, { appActive: true, atBottom: true }), null);
  assert.strictEqual(W.readUpTo('', { appActive: true, atBottom: true }), null);
  assert.strictEqual(W.readUpTo('tmp-9', { appActive: true, atBottom: true }), 'tmp-9');
});

test('opening a chat IS reading it — but not while the screen is off', () => {
  // This path also runs from a refresh, which fires on a locked phone.
  assert.strictEqual(W.opensAsRead({ appActive: true }), true);
  assert.strictEqual(W.opensAsRead({ appActive: false }), false);
  assert.strictEqual(W.opensAsRead(null), false);
});

test('opening is a SEPARATE rule from arriving, not the same one with a flag', () => {
  // Opening a chat marks the whole page read from wherever the list happens to
  // be sitting; an arriving message must not. Folding them together is how the
  // socket case borrowed the permission that belongs to the deliberate one.
  assert.strictEqual(W.opensAsRead({ appActive: true }), true);
  assert.strictEqual(W.marksRead({ appActive: true, atBottom: false }), false,
    'arriving messages inherited the permission that belongs to opening a chat');
});

test('the web and the app answer identically', () => {
  if (!A) return;
  let checked = 0;
  for (const appActive of [true, false]) {
    for (const atBottom of [true, false]) {
      for (const fromMe of [true, false, undefined]) {
        const ctx = { appActive, atBottom, fromMe };
        assert.strictEqual(W.marksRead(ctx), A.marksRead(ctx),
          `marksRead diverges for ${JSON.stringify(ctx)}`);
        assert.strictEqual(W.readUpTo(7, ctx), A.readUpTo(7, ctx),
          `readUpTo diverges for ${JSON.stringify(ctx)}`);
        checked++;
      }
    }
    assert.strictEqual(W.opensAsRead({ appActive }), A.opensAsRead({ appActive }));
  }
  assert.strictEqual(W.marksRead(null), A.marksRead(null));
  assert.ok(checked === 12, `the drift check ran ${checked} times`);
});

test('the APP copy holds the pocket rule too, not just the web one', () => {
  // Every test above drives W. Without this the app could be changed alone and
  // only the drift check would notice — and a drift check says "they differ",
  // not "this one is wrong".
  if (!A) return;
  assert.strictEqual(A.marksRead({ appActive: false, atBottom: true }), false,
    'the app still marks messages read while the phone is locked');
  assert.strictEqual(A.marksRead({ appActive: true, atBottom: false }), false,
    'the app still marks messages read while scrolled up');
  assert.strictEqual(A.marksRead({ appActive: true, atBottom: true }), true);
  assert.strictEqual(A.opensAsRead({ appActive: false }), false);
});

// ── The wiring ──────────────────────────────────────────────────────────────

const chat = fs.readFileSync(path.join(NAT, 'src', 'screens', 'ChatScreen.tsx'), 'utf8');
const web = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

test('EVERY mark_read in the app goes through the rule', () => {
  // Counted, not "the rule appears somewhere". One unguarded site is one path
  // that still destroys the read position, and the guarded ones would hide it
  // from a looser check — which is exactly how this survived three reports.
  const sites = (chat.match(/emit\('mark_read'/g) || []).length;
  const guards = (chat.match(/marksRead\(\{|opensAsRead\(\{/g) || []).length;
  assert.ok(sites >= 3, `only ${sites} mark_read sites found; the file moved`);
  assert.strictEqual(guards, sites,
    `${sites} places mark a message read but only ${guards} of them ask whether anyone was looking`);
});

test('…and every one of them asks about the APP STATE, not just the scroll', () => {
  // A guard that only checks the scroll position passes the counting test
  // above and still marks everything read with the phone in a pocket.
  const checks = (chat.match(/AppState\.currentState === 'active'/g) || []).length;
  assert.ok(checks >= 3,
    `only ${checks} of the mark_read guards consider whether the app is in the foreground`);
});

test('the app no longer marks an arriving message read unconditionally', () => {
  // The exact line that caused this, pinned so it cannot come back.
  // Not "the line is gone" — it is still there, inside the guard, so a test
  // for its absence passes either way. This asks what comes BEFORE it.
  const at = chat.indexOf("sock.emit('mark_read', { roomId: room.id, lastMsgId: msg.id })");
  assert.ok(at > -1, 'the arriving-message mark_read moved');
  const before = chat.slice(Math.max(0, at - 400), at);
  assert.ok(/marksRead\(\{[^}]*appActive[^}]*\}\)\) \{\s*$/m.test(before),
    'an arriving message is marked read with no check that anybody saw it');
});

test('the web guards its sites too, and loads the rule', () => {
  const sites = (web.match(/emit\('mark_read'/g) || []).length;
  const guards = (web.match(/ReadPosition\.marksRead\(|ReadPosition\.opensAsRead\(/g) || []).length;
  assert.ok(sites >= 3, `only ${sites} mark_read sites on the web`);
  // One site is the upload-completion swap, where the message is the reader's
  // own and already on screen; the rest must be guarded.
  assert.ok(guards >= sites - 1,
    `${sites} web sites mark read but only ${guards} ask whether the tab is being looked at`);
  assert.ok(/src="\/js\/readPosition\.js"/.test(html),
    'readPosition.js is never loaded, so ReadPosition is undefined and a message throws');
  assert.ok(html.indexOf('readPosition.js') < html.indexOf('js/app.js'),
    'readPosition.js loads after app.js, so the rule is undefined when it is first needed');
});

test('the web asks about visibility, not merely about the chat being open', () => {
  const fn = web.slice(web.indexOf('function readContextNow('),
    web.indexOf('function readContextNow(') + 600);
  assert.ok(fn.length > 150, 'readContextNow is gone');
  assert.ok(/document\.visibilityState === 'visible'/.test(fn),
    'a hidden tab still counts as reading the chat');
  assert.ok(/scrollHeight - container\.scrollTop - container\.clientHeight/.test(fn),
    'the web does not check whether the list is at the end');
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
