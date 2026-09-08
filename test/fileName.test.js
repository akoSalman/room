// What a file may be called.
//
// Two reports, one rule underneath them:
//
//   "Share file to other apps crashes and doesn't work after preparing file"
//   "Allow renaming file when sharing from both outside of app or through it"
//
// The crash first, because it is the same question. Sharing a file out wrote
// it to the cache under its own name — `cacheDirectory + name` — with `name`
// taken straight from the message. That is whatever the sender's phone called
// the file, and for these users it is routinely Persian, with spaces, and
// sometimes with a "/" or a "#" in it. None of those make a valid path, so the
// download threw before the share sheet could open: prepared, then nothing.
// A signed media URL was worse — the name taken from it ends in "?e=1&s=abc".
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const NAT = path.join(ROOT, 'native-app');
const TSC = path.join(NAT, 'node_modules', '.bin', 'tsc');

global.window = global;
const W = require(path.join(ROOT, 'public', 'js', 'fileName.js'));

let A = null;
if (fs.existsSync(TSC)) {
  const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'fname-'));
  execFileSync(TSC, [path.join(NAT, 'src', 'fileName.ts'),
    '--outDir', OUT, '--module', 'commonjs', '--target', 'es2019', '--skipLibCheck'], { stdio: 'pipe' });
  A = require(path.join(OUT, 'fileName.js'));
  process.on('exit', () => fs.rmSync(OUT, { recursive: true, force: true }));
} else {
  console.log('  ! app-side rule skipped (native-app deps not installed); web copy still checked');
}

const tests = [];
const test = (n, f) => tests.push({ n, f });

// ── Names that broke the share ──────────────────────────────────────────────

test('THE CRASH: a name that cannot be part of a path is made into one', () => {
  // Each of these threw when concatenated onto cacheDirectory.
  assert.strictEqual(W.safeName('a/b.pdf'), 'a-b.pdf');
  // The hash goes; the space and the extension stay.
  assert.strictEqual(W.safeName('report #3.pdf'), 'report -3.pdf');
  assert.ok(!/[\\/:*?"<>|#%]/.test(W.safeName('x?y*z"w<v>u|t.png')),
    'characters a filesystem refuses survived');
  // A signed media URL's tail: "1788-4.jpg?e=1&s=abc" is not a filename.
  assert.strictEqual(W.safeName('1788-4.jpg?e=1&s=abc'), '1788-4.jpg');
  // A '#' is replaced rather than cut at, or "report #3.pdf" loses its
  // extension along with everything after the hash.
  assert.strictEqual(W.safeName('clip.mp4#t=3'), 'clip.mp4-t=3');
});

test('a space is not a crash, and neither is Persian', () => {
  // The alphabet was never the problem; the punctuation was. A Persian name
  // must survive intact or half these users lose their filenames.
  assert.strictEqual(W.safeName('گزارش ۱۴۰۳.pdf'), 'گزارش ۱۴۰۳.pdf');
  assert.strictEqual(W.safeName('my holiday photo.jpg'), 'my holiday photo.jpg');
});

test('nothing usable still produces a filename', () => {
  // An empty destination path is its own crash.
  assert.strictEqual(W.safeName(''), 'file');
  assert.strictEqual(W.safeName(null), 'file');
  assert.strictEqual(W.safeName('   '), 'file');
  assert.ok(W.safeName('///').length > 0, 'a name of nothing but separators became empty');
  assert.strictEqual(W.safeName('', 'photo.jpg'), 'photo.jpg');
});

test('a leading dot is not left to make a hidden file', () => {
  assert.ok(!W.safeName('.bashrc').startsWith('.'));
  assert.ok(!W.safeName('..\\..\\etc\\passwd').startsWith('.'));
});

test('an absurdly long name is trimmed, but keeps its extension', () => {
  const long = 'x'.repeat(400) + '.pdf';
  const out = W.safeName(long);
  assert.ok(out.length <= W.MAX_NAME, `${out.length} characters`);
  assert.ok(out.endsWith('.pdf'), 'a shortened ".pd" opens nothing');
});

test('two shares of the same name are two different cache files', () => {
  // Otherwise the second share hands out the first file.
  const a = W.cacheName('report.pdf', 1000);
  const b = W.cacheName('report.pdf', 2000);
  assert.notStrictEqual(a, b);
  assert.ok(a.endsWith('report.pdf') && b.endsWith('report.pdf'));
  assert.ok(!/[\\/:*?"<>|#%]/.test(W.cacheName('a/b?c.png', 1)));
});

// ── Renaming ────────────────────────────────────────────────────────────────

test('THE FEATURE: renaming keeps the extension the file needs', () => {
  // Somebody renaming a photo to "beach" means the photo, not a file Android
  // no longer knows how to open.
  assert.strictEqual(W.renamed('IMG_20240612_119.jpg', 'beach'), 'beach.jpg');
  assert.strictEqual(W.renamed('report.pdf', 'quarter one'), 'quarter one.pdf');
});

test('…unless the typed name brings its own, which is deliberate', () => {
  assert.strictEqual(W.renamed('photo.jpg', 'beach.png'), 'beach.png');
  assert.strictEqual(W.renamed('notes', 'notes.txt'), 'notes.txt');
});

test('an empty answer leaves the name alone', () => {
  // Dismissing the prompt must not rename anything to "file".
  assert.strictEqual(W.renamed('report.pdf', ''), 'report.pdf');
  assert.strictEqual(W.renamed('report.pdf', '   '), 'report.pdf');
  assert.strictEqual(W.renamed('report.pdf', null), 'report.pdf');
  assert.strictEqual(W.renamed('report.pdf', undefined), 'report.pdf');
});

test('a typed name is made safe too', () => {
  assert.strictEqual(W.renamed('a.pdf', 'my/report'), 'my-report.pdf');
  assert.ok(!/[\\/#?]/.test(W.renamed('a.pdf', '../../etc/passwd')));
});

test('the box opens on the STEM, not the extension', () => {
  assert.strictEqual(W.editableStem('IMG_20240612_119.jpg'), 'IMG_20240612_119');
  assert.strictEqual(W.editableStem('notes'), 'notes');
  assert.strictEqual(W.editableStem('archive.tar.gz'), 'archive.tar');
});

test('a dot in a sentence is not an extension', () => {
  assert.strictEqual(W.extensionOf('the meeting on friday'), '');
  assert.strictEqual(W.extensionOf('v1.2 of the plan'), '');
  assert.strictEqual(W.extensionOf('report.PDF'), 'pdf');
  assert.strictEqual(W.extensionOf('trailing.'), '');
  assert.strictEqual(W.extensionOf('.hidden'), '');
});

test('the web and the app agree, name for name', () => {
  if (!A) return;
  const names = ['a/b.pdf', 'گزارش ۱۴۰۳.pdf', '1788-4.jpg?e=1&s=abc', '', null, '   ',
    '.bashrc', 'x'.repeat(400) + '.pdf', 'clip.mp4#t=3', 'archive.tar.gz', 'notes',
    'report #3.pdf'];
  let checked = 0;
  for (const n of names) {
    assert.strictEqual(W.safeName(n), A.safeName(n), `safeName diverges for ${n}`);
    assert.strictEqual(W.editableStem(n), A.editableStem(n));
    assert.strictEqual(W.extensionOf(n), A.extensionOf(n));
    assert.strictEqual(W.cacheName(n, 42), A.cacheName(n, 42));
    for (const typed of ['beach', 'beach.png', '', 'my/report']) {
      assert.strictEqual(W.renamed(n, typed), A.renamed(n, typed), `renamed diverges for ${n}/${typed}`);
    }
    checked++;
  }
  assert.strictEqual(W.MAX_NAME, A.MAX_NAME);
  assert.strictEqual(checked, names.length, 'the drift check did not actually run');
});

// ── The wiring ──────────────────────────────────────────────────────────────

const chat = fs.readFileSync(path.join(NAT, 'src', 'screens', 'ChatScreen.tsx'), 'utf8');
const composer = fs.readFileSync(path.join(NAT, 'src', 'components', 'Composer.tsx'), 'utf8');
const app = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

test('THE CRASH IS FIXED: the share writes to a safe path', () => {
  const fn = chat.slice(chat.indexOf('async function shareOut('),
    chat.indexOf('async function shareOut(') + 2200);
  assert.ok(fn.length > 200, 'shareOut moved');
  assert.ok(/cacheDirectory \+ cacheName\(/.test(fn),
    'the cache path is still built from the raw name, which is the crash');
  assert.ok(/safeName\(/.test(fn), 'the name handed to the sheet is not made safe');
  // And when it does fail, it says why rather than "could not share that file".
  assert.ok(/Alert\.alert\('Could not share', String\(e/.test(fn),
    'every cause still reports the same unhelpful sentence');
});

test('renaming exists on the app, and is not the iOS-only prompt', () => {
  // Alert.prompt does nothing at all on Android, which is what this ships as:
  // it would have been a button that looked right and opened nothing.
  // Comments stripped first: this file's own explanation of why that API is
  // wrong contains its name, and matching prose is not checking behaviour.
  const code = chat.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  assert.ok(!/Alert\.prompt\(/.test(code), 'Alert.prompt is back, and does nothing on Android');
  assert.ok(/function renameStaged\(/.test(chat), 'nothing renames a staged file');
  assert.ok(/setRenaming\(\{ index, value: editableStem/.test(chat),
    'the box does not open on the stem');
  assert.ok(/renamed\(r\.of, r\.value\)/.test(chat), 'the typed name is used raw');
  assert.ok(/visible=\{!!renaming\}/.test(chat), 'there is no dialog to type into');
  assert.ok(/from '\.\.\/fileName'/.test(chat), 'the app keeps a private copy of the rule');
});

test('…and it reaches both ways a file gets staged', () => {
  // The share intent and the in-app picker both end up in pendingMedia, so
  // renaming there covers both — which is what was asked for.
  assert.ok(/onRenameMedia=\{renameStaged\}/.test(chat), 'the composer is never given it');
  assert.ok(/onRenameMedia\?: \(index: number\) => void;/.test(composer),
    'the composer does not accept it');
  assert.ok(/onRenameMedia && onRenameMedia\(i\)/.test(composer), 'there is nothing to press');
  assert.ok(/pendingMediaName/.test(composer), 'the name is not shown, so nobody knows to change it');
});

test('the web can rename a staged file too', () => {
  assert.ok(/function renamePendingFile\(/.test(app), 'the web cannot rename');
  const fn = app.slice(app.indexOf('function renamePendingFile('),
    app.indexOf('function renamePendingFile(') + 800);
  assert.ok(/FileName\.editableStem\(/.test(fn), 'the box opens on the whole filename');
  assert.ok(/FileName\.renamed\(/.test(fn), 'the web has its own idea of what a rename means');
  assert.ok(/if \(typed === null\) return;/.test(fn),
    'dismissing the prompt renames the file anyway');
  assert.ok(/new File\(\[p\.file\], next/.test(fn), "a File's name is read-only — it must be rebuilt");
  assert.ok(/pending-name/.test(app), 'there is nothing to click');
  assert.ok(/src="\/js\/fileName\.js"/.test(html), 'fileName.js is never loaded');
  assert.ok(html.indexOf('fileName.js') < html.indexOf('js/app.js'));
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
