// What a message will let you do, and what it says after a forward.
//
// Two reports:
//
//   "When the message is still uploading don't allow pop up message menu"
//   "When forwarding a message, after forward done, tell user that Forwarded
//    to <user>"
//
// The first is a correctness bug wearing a UI complaint's clothes. A bubble
// that is still uploading is a LOCAL PLACEHOLDER: it has no server id yet, so
// every entry in its menu — Reply, Forward, Edit, Comment, Show in chat,
// Delete — names a message the server has never heard of, and Copy copies a
// file that is not on disk anywhere useful. The second is plain silence:
// forwarding said nothing at all unless it failed, so a correct forward and a
// missed tap looked identical.
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const NAT = path.join(ROOT, 'native-app');
const TSC = path.join(NAT, 'node_modules', '.bin', 'tsc');

global.window = global;
const W = require(path.join(ROOT, 'public', 'js', 'messageMenu.js'));

let A = null;
if (fs.existsSync(TSC)) {
  const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'msgmenu-'));
  execFileSync(TSC, [path.join(NAT, 'src', 'messageMenu.ts'),
    '--outDir', OUT, '--module', 'commonjs', '--target', 'es2019', '--skipLibCheck'], { stdio: 'pipe' });
  A = require(path.join(OUT, 'messageMenu.js'));
  process.on('exit', () => fs.rmSync(OUT, { recursive: true, force: true }));
} else {
  console.log('  ! app-side rules skipped (native-app deps not installed); web copy still checked');
}

const tests = [];
const test = (n, f) => tests.push({ n, f });

// ── The menu ────────────────────────────────────────────────────────────────

test('THE BUG: a message that is still uploading has no menu', () => {
  assert.strictEqual(W.canOpenMenu({ _uploading: true }), false);
  assert.strictEqual(W.canOpenMenu({ id: 12, _uploading: true, file_url: 'blob:x' }), false);
});

test('an ordinary message still has one', () => {
  assert.strictEqual(W.canOpenMenu({ id: 12, content: 'hi' }), true);
  assert.strictEqual(W.canOpenMenu({ id: 12, file_url: '/uploads/a.jpg' }), true);
});

test('a FAILED upload keeps its menu', () => {
  // That one is finished, badly, and is exactly the message a person needs to
  // delete. Locking its menu would strand it in the chat for good.
  assert.strictEqual(W.canOpenMenu({ _uploadFailed: true }), true);
  assert.strictEqual(W.canOpenMenu({ _uploading: false, _uploadFailed: true }), true);
});

test('nothing at all is not a menu either', () => {
  assert.strictEqual(W.canOpenMenu(null), false);
  assert.strictEqual(W.canOpenMenu(undefined), false);
});

// ── What it says afterwards ─────────────────────────────────────────────────

test('THE BUG: a finished forward names where it went', () => {
  assert.strictEqual(W.forwardedTo('Ali'), 'Forwarded to Ali');
  // The destination is the whole point: forwarding to the wrong chat is the
  // mistake this feature invites, and "Forwarded" alone cannot catch it.
  assert.ok(W.forwardedTo('Ali').includes('Ali'));
});

test('several messages are counted', () => {
  assert.strictEqual(W.forwardedTo('Ali', 3), '3 messages forwarded to Ali');
  assert.strictEqual(W.forwardedTo('Ali', 1), 'Forwarded to Ali');
});

test('a nameless destination still confirms the forward', () => {
  // Better a bare confirmation than the silence this replaced.
  assert.strictEqual(W.forwardedTo(''), 'Forwarded');
  assert.strictEqual(W.forwardedTo(null), 'Forwarded');
  assert.strictEqual(W.forwardedTo('   '), 'Forwarded');
  assert.strictEqual(W.forwardedTo(undefined, 2), '2 messages forwarded');
});

test('a nonsense count never reads as zero or a fraction', () => {
  assert.strictEqual(W.forwardedTo('Ali', 0), 'Forwarded to Ali');
  assert.strictEqual(W.forwardedTo('Ali', -4), 'Forwarded to Ali');
  assert.strictEqual(W.forwardedTo('Ali', 2.7), '2 messages forwarded to Ali');
  assert.strictEqual(W.forwardedTo('Ali', NaN), 'Forwarded to Ali');
});

test('the web and the app agree', () => {
  if (!A) return;
  let checked = 0;
  for (const m of [null, undefined, {}, { _uploading: true }, { _uploading: false },
    { _uploadFailed: true }, { _uploading: true, _uploadFailed: true }]) {
    assert.strictEqual(W.canOpenMenu(m), A.canOpenMenu(m), `menu rules diverge for ${JSON.stringify(m)}`);
    checked++;
  }
  for (const [t, n] of [['Ali', 1], ['Ali', 3], ['', 1], [null, 2], ['  ', 1], ['Ali', 0]]) {
    assert.strictEqual(W.forwardedTo(t, n), A.forwardedTo(t, n), `wording diverges for ${t}/${n}`);
    checked++;
  }
  assert.strictEqual(checked, 13, 'the drift check did not actually run');
});

// ── The wiring ──────────────────────────────────────────────────────────────

const app = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const chat = fs.readFileSync(path.join(NAT, 'src', 'screens', 'ChatScreen.tsx'), 'utf8');

test('the web asks before opening a message menu', () => {
  const fn = app.slice(app.indexOf('function openCtxMenu('),
    app.indexOf('function openCtxMenu(') + 700);
  assert.ok(/MessageMenu\.canOpenMenu\(msg\)/.test(fn) && /return/.test(fn),
    'the web opens the menu on a message that is still going out');
  assert.ok(/src="\/js\/messageMenu\.js"/.test(html),
    'messageMenu.js is never loaded, so MessageMenu is undefined and long-press throws');
  // Loaded BEFORE the code that calls it.
  assert.ok(html.indexOf('messageMenu.js') < html.indexOf('js/app.js'));
});

test('the app asks too — from both ways of opening it', () => {
  // Long press opens the menu; a second kind of long press starts selection,
  // which offers the same actions from the header.
  for (const entry of ['function openMenuFor(msg', 'function enterSelectMode(msg']) {
    const i = chat.indexOf(entry);
    assert.ok(i > -1, `${entry} moved`);
    assert.ok(/canOpenMenu\(/.test(chat.slice(i, i + 700)),
      `${entry} still opens on a message that is still uploading`);
  }
  assert.ok(/from '\.\.\/messageMenu'/.test(chat), 'the app keeps a private copy of the rule');
});

test('both clients say where the forward went', () => {
  const fwd = app.slice(app.indexOf('async function openForwardModal('),
    app.indexOf('async function openForwardModal(') + 2500);
  assert.ok(/MessageMenu\.forwardedTo\(/.test(fwd), 'the web forward is still silent');
  assert.ok(/showToast\(/.test(fwd), 'the web has nowhere to show it');
  const dof = chat.slice(chat.indexOf('function doForward(target'),
    chat.indexOf('function doForward(target') + 2000);
  assert.ok(/forwardedTo\(/.test(dof), 'the app forward is still silent');
  assert.ok(/toast\(/.test(dof), 'the app has nowhere to show it');
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
