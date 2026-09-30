// ── Asking before saving a whole album ─────────────────────────────────────
//
// Asked for: tapping Download on a message holding several photos should save
// all of them, and should ask first.
//
// Saving all of them is what both clients already did — a gallery message
// keeps its paths in one column and both loop over them. What neither did was
// SAY so. One tap on a menu item called "Download" quietly wrote eleven files
// to somebody's phone, on a connection paid for by the megabyte.
//
// The rule is written once and mirrored, and the two copies are compared as
// running code below rather than as two files that merely look alike.
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const NAT = path.join(ROOT, 'native-app');
const WEB = require(path.join(ROOT, 'public', 'js', 'saveConfirm.js'));

let APP = null;
const TSC = path.join(NAT, 'node_modules', '.bin', 'tsc');
if (fs.existsSync(TSC)) {
  const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'sconf-'));
  process.on('exit', () => fs.rmSync(OUT, { recursive: true, force: true }));
  execFileSync(TSC, [path.join(NAT, 'src', 'saveConfirm.ts'),
    '--outDir', OUT, '--module', 'commonjs', '--target', 'es2019',
    '--skipLibCheck', '--esModuleInterop'], { stdio: 'pipe' });
  APP = require(path.join(OUT, 'saveConfirm.js'));
}

const tests = [];
const test = (n, f) => tests.push({ n, f });

test('SEVERAL PHOTOS ARE ASKED ABOUT', () => {
  assert.strictEqual(WEB.needsConfirm(2), true);
  assert.strictEqual(WEB.needsConfirm(11), true);
});

test('…and ONE is not', () => {
  // A confirmation whose answer is always yes teaches people to dismiss
  // confirmations, and "Download" on a single picture is not ambiguous.
  assert.strictEqual(WEB.needsConfirm(1), false);
  assert.strictEqual(WEB.needsConfirm(0), false);
});

test('nonsense is not asked about either', () => {
  for (const v of [null, undefined, '', 'x', NaN, -3, {}, [], Infinity]) {
    assert.strictEqual(WEB.needsConfirm(v), false, JSON.stringify(v));
  }
});

test('COUNTING IGNORES WHAT IS NOT A PATH', () => {
  assert.strictEqual(WEB.fileCount(['/uploads/a.jpg', '/uploads/b.jpg']), 2);
  assert.strictEqual(WEB.fileCount(['/uploads/a.jpg', '', null, 42, undefined]), 1);
  assert.strictEqual(WEB.fileCount([]), 0);
  for (const v of [null, undefined, 'not an array', 7, {}]) {
    assert.strictEqual(WEB.fileCount(v), 0, JSON.stringify(v));
  }
});

test('THE COUNT LEADS THE SENTENCE', () => {
  // It is the fact the person does not have, and the reason they are being
  // asked. "Are you sure?" would be a worse question than no question.
  const t = WEB.confirmText(11);
  assert.ok(/\b11\b/.test(t.title), `the count is not in the title: ${t.title}`);
  assert.ok(/\b11\b/.test(t.body), `the count is not in the body: ${t.body}`);
  assert.ok(t.confirm && t.cancel, 'the buttons have no labels');
  assert.notStrictEqual(t.confirm, t.cancel);
});

test('…and it never claims a number it was not given', () => {
  // Called with rubbish it must still read sensibly, because the dialog is
  // already on screen by then.
  for (const v of [null, undefined, NaN, 'x', 1, 0, -5]) {
    const t = WEB.confirmText(v);
    assert.ok(t.title && t.body, JSON.stringify(v));
    assert.ok(!/NaN|undefined|null/.test(t.title + t.body), `${JSON.stringify(v)} → ${t.title}`);
  }
});

// ── The two copies agree ────────────────────────────────────────────────────

test('THE APP AND THE WEB ANSWER IDENTICALLY', () => {
  if (!APP) { console.log('    (app copy not compiled — native-app deps missing)'); return; }
  for (const v of [0, 1, 2, 3, 11, 500, -1, null, undefined, NaN, 'x', '3']) {
    assert.strictEqual(APP.needsConfirm(v), WEB.needsConfirm(v), `needsConfirm(${JSON.stringify(v)})`);
    assert.deepStrictEqual(APP.confirmText(v), WEB.confirmText(v), `confirmText(${JSON.stringify(v)})`);
  }
  for (const v of [[], ['/a'], ['/a', '', '/b'], null, 'x', [1, 2]]) {
    assert.strictEqual(APP.fileCount(v), WEB.fileCount(v), `fileCount(${JSON.stringify(v)})`);
  }
});

// ── The wiring ──────────────────────────────────────────────────────────────

const app = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const chat = fs.readFileSync(path.join(NAT, 'src', 'screens', 'ChatScreen.tsx'), 'utf8');

test('THE WEB ASKS, and saves all of them when told to', () => {
  const i = app.indexOf('function ctxDownload');
  assert.ok(i > 0, 'the web can no longer download');
  const body = app.slice(i, app.indexOf('\n}', i));
  assert.ok(/SaveConfirm\.needsConfirm/.test(body), 'the web saves an album without asking');
  assert.ok(/SaveConfirm\.confirmText/.test(body), 'the web asks in its own words rather than the shared ones');
  // Still every photo, which is the half that already worked.
  assert.ok(/JSON\.parse\(ctxTarget\.filePath\)/.test(body), 'the web stopped saving the whole album');
  assert.ok(/<script src="\/js\/saveConfirm\.js"><\/script>/.test(html),
    'the shared rule is never loaded by the page');
});

test('THE APP ASKS, and saves all of them when told to', () => {
  const i = chat.indexOf('async function downloadMedia');
  assert.ok(i > 0, 'the app can no longer download');
  const body = chat.slice(i, i + 2200);
  assert.ok(/saveConfirm\.needsConfirm/.test(body), 'the app saves an album without asking');
  assert.ok(/saveConfirm\.confirmText/.test(body), 'the app asks in its own words rather than the shared ones');
  assert.ok(/urls\.length/.test(body), 'the app stopped saving the whole album');
});

test('…and saying no saves nothing at all', () => {
  // The failure that would make this worse than no dialog: asking, being told
  // no, and downloading anyway.
  const i = chat.indexOf('async function downloadMedia');
  const body = chat.slice(i, i + 2200);
  assert.ok(/style: 'cancel'/.test(body), 'there is no way to decline');
  const web = app.slice(app.indexOf('function ctxDownload'), app.indexOf('function ctxCopy'));
  assert.ok(/if \(!confirm|return;/.test(web), 'declining on the web downloads anyway');
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
