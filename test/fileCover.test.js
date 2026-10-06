// ── What a file looks like before you open it ──────────────────────────────
//
// Asked for: show files with a cover, so you know what is in one without
// opening it. The tab listed a video, a photo sent as a document, a PDF and a
// zip as four identical rows of the same emoji — and on a metered connection
// "open it and see" costs the whole file.
//
// The point of testing the RULE rather than the look is that the honest
// answer differs by format: some files can be shown, and some cannot be shown
// by anything on this device. Pretending otherwise is worse than the emoji.
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const NAT = path.join(ROOT, 'native-app');
const TSC = path.join(NAT, 'node_modules', '.bin', 'tsc');
if (!fs.existsSync(TSC)) {
  console.log('  ! skipping file-cover tests (native-app deps not installed)');
  process.exit(0);
}
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'fcover-'));
process.on('exit', () => fs.rmSync(OUT, { recursive: true, force: true }));
execFileSync(TSC, [path.join(NAT, 'src', 'fileCover.ts'),
  '--outDir', OUT, '--module', 'commonjs', '--target', 'es2019', '--skipLibCheck'],
  { stdio: 'pipe' });
const F = require(path.join(OUT, 'fileCover.js'));

const tests = [];
const test = (n, f) => tests.push({ n, f });

test('A VIDEO GETS A REAL FRAME, whatever it is called', () => {
  // The server says what the message was, and that is trusted over the name:
  // a video with no extension is still a video, and that is the case where a
  // real cover is worth the most.
  assert.strictEqual(F.coverKindFor({ kind: 'video', name: 'clip.mp4' }), 'video');
  assert.strictEqual(F.coverKindFor({ kind: 'video', name: 'no-extension' }), 'video');
  assert.strictEqual(F.coverKindFor({ kind: 'video', name: '' }), 'video');
});

test('A PICTURE SENT AS A DOCUMENT IS STILL A PICTURE', () => {
  // These land in the files tab rather than the photos tab, and the server
  // can already thumbnail one.
  for (const n of ['scan.jpg', 'SHOT.PNG', 'a.webp', 'x.heic', 'y.gif']) {
    assert.strictEqual(F.coverKindFor({ kind: 'file', name: n }), 'image', n);
  }
});

test('EVERYTHING ELSE IS TYPED, and does not pretend to be a preview', () => {
  // Nothing on the device can render the first page of a PDF or the contents
  // of a zip. A generic grey sheet standing in for one tells you less than
  // the word "PDF" does.
  for (const n of ['report.pdf', 'book.epub', 'a.zip', 'notes.docx', 'x.apk']) {
    assert.strictEqual(F.coverKindFor({ kind: 'file', name: n }), 'typed', n);
  }
});

test('AN UNKNOWN FILE IS STILL A FILE', () => {
  // Never an empty cover: a blank square is indistinguishable from one that
  // failed to load.
  assert.strictEqual(F.coverLabel(''), 'FILE');
  assert.strictEqual(F.coverLabel(null), 'FILE');
  assert.strictEqual(F.coverLabel('no-extension-here'), 'FILE');
  assert.strictEqual(F.coverLabel('report.pdf'), 'PDF');
});

test('A FULL STOP IN A NAME IS NOT A FILE TYPE', () => {
  // "Minutes, Jan 3. final" would otherwise be a file of type " FINAL".
  assert.strictEqual(F.extOf('Minutes Jan 3. final'), '');
  assert.strictEqual(F.extOf('archive.tar.gz'), 'gz');
  assert.strictEqual(F.extOf('.hidden'), '');
  assert.strictEqual(F.extOf('trailing.'), '');
  assert.strictEqual(F.extOf('CAPS.PDF'), 'pdf');
});

test('COLOUR IS BY FAMILY, so the list can be scanned', () => {
  // .doc and .docx are the same thing to somebody looking for a document;
  // giving them different colours would make the list harder to read.
  assert.strictEqual(F.coverTint('a.doc'), F.coverTint('b.docx'));
  assert.strictEqual(F.coverTint('a.xls'), F.coverTint('b.csv'));
  assert.strictEqual(F.coverTint('a.zip'), F.coverTint('b.7z'));
  // …and the families are told apart.
  assert.notStrictEqual(F.coverTint('a.pdf'), F.coverTint('a.docx'));
  assert.notStrictEqual(F.coverTint('a.zip'), F.coverTint('a.xlsx'));
  // Everything unrecognised shares one colour, so it looks deliberately plain
  // rather than like a category of its own.
  const unknown = F.coverTint('a.qqq');
  assert.strictEqual(unknown, F.coverTint('b.zzz'));
  assert.strictEqual(F.coverTint(''), F.coverTint('no-extension'));
  // …and a family that HAS a colour must not quietly share the unknown one.
  // Dropping a family from the list leaves it looking unrecognised while
  // every assertion about it matching its siblings still passes — which is
  // how the first version of this test missed exactly that.
  for (const [family, ext] of [['documents', 'docx'], ['sheets', 'xlsx'],
      ['slides', 'pptx'], ['archives', 'zip'], ['installers', 'apk'], ['pdf', 'pdf']]) {
    assert.notStrictEqual(F.coverTint('a.' + ext), unknown,
      `${family} is no longer recognised, so it looks like an unknown file`);
  }
});

test('A COVER IS ONLY EXTRACTED FOR A ROW BEING LOOKED AT', () => {
  // Extracting a frame costs a decode. A tab of two hundred files must not
  // decode two hundred videos because somebody opened it.
  assert.strictEqual(F.wantsCover({ kind: 'video', visible: true }), true);
  assert.strictEqual(F.wantsCover({ kind: 'video', visible: false }), false);
  assert.strictEqual(F.wantsCover({ kind: 'video' }), false);
  // Nothing else needs extracting at all.
  assert.strictEqual(F.wantsCover({ kind: 'image', visible: true }), false);
  assert.strictEqual(F.wantsCover({ kind: 'typed', visible: true }), false);
});

// ── And the list actually uses it ──────────────────────────────────────────

const strip = (f) => fs.readFileSync(f, 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
const BROWSER = strip(path.join(NAT, 'src', 'components', 'MediaBrowser.tsx'));

test('THE FILES TAB DRAWS COVERS, not an emoji', () => {
  assert.ok(/coverKindFor\(/.test(BROWSER), 'the files list never asks what cover to use');
  assert.ok(/<FileRow /.test(BROWSER), 'the files tab still uses the plain row');
  assert.ok(/coverTint\(item\.name\)/.test(BROWSER), 'typed covers have no colour');
});

test('IT NEVER DOWNLOADS A VIDEO TO DRAW A PICTURE OF IT', () => {
  // The whole point of passing local:false with no size: shouldExtract then
  // refuses unless a cover already exists on disk from the chat. On these
  // connections, pulling a video down for a thumbnail is not acceptable.
  const call = /ensureCover\(\{[^}]*\}\)/.exec(BROWSER);
  assert.ok(call, 'the files tab never asks for a video cover at all');
  assert.ok(/local: false/.test(call[0]),
    'the files tab would download videos to make covers');
  assert.ok(!/sizeBytes/.test(call[0]),
    'a size is passed, which lets a remote video be fetched for its frame');
});

test('THE READY COVER IS THE ONE THE STORE ACTUALLY REPORTS', () => {
  // The store's states are none/working/done/failed. I wrote 'ready' first,
  // which is not one of them — every cover would have silently never shown.
  assert.ok(/status === 'done'/.test(BROWSER),
    "the row checks a status the cover store never reports");
  const store = strip(path.join(NAT, 'src', 'videoCover.ts'));
  assert.ok(/'done'/.test(store), 'the store no longer reports done — check the row');
  assert.ok(!/'ready'/.test(store), "the store now reports 'ready' — the row must follow");
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
