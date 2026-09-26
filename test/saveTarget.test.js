// ── The photo that saved itself as "photo.jpg?e=…&s=…" ─────────────────────
//
// Photographed: downloading an image in a private room produced two messages
// — the "Saved to your device" indicator AND a dialog reading
//
//     Downloaded
//     Saved as 1790426577952-41739317.jpg?e=1791072000000&s=crcyuha3xLWbXEUhYB…
//
// and the photo was then not in the gallery.
//
// Two lines caused all of that. The name was `url.split('/').pop()`, which on
// an HMAC-signed URL keeps the expiry and the signature — so the file landed
// on disk with an "extension" of `jpg?e=1791072000000&s=crcyuha…`, which
// Android cannot read as an image. And the destination was chosen from the
// message's `type` field rather than from the file, so a photo whose type was
// not exactly 'image' went down the document path: no gallery, plus the
// dialog that exists to name a document.
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const NAT = path.join(ROOT, 'native-app');
const TSC = path.join(NAT, 'node_modules', '.bin', 'tsc');
if (!fs.existsSync(TSC)) {
  console.log('  ! skipping save-target tests (native-app deps not installed)');
  process.exit(0);
}
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'savet-'));
process.on('exit', () => fs.rmSync(OUT, { recursive: true, force: true }));
execFileSync(TSC, [path.join(NAT, 'src', 'saveTarget.ts'),
  '--outDir', OUT, '--module', 'commonjs', '--target', 'es2019',
  '--skipLibCheck', '--esModuleInterop'], { stdio: 'pipe' });
const S = require(path.join(OUT, 'saveTarget.js'));

const tests = [];
const test = (n, f) => tests.push({ n, f });

// The exact URL from the photograph.
const SIGNED = '/uploads/1790426577952-41739317.jpg'
  + '?e=1791072000000&s=crcyuha3xLWbXEUhYB7yP3jd3FulzVWa';

test('THE BUG: the signature is not part of the filename', () => {
  assert.strictEqual(S.fileNameFor({ url: SIGNED }), '1790426577952-41739317.jpg');
});

test('…so the file is an image again, and lands in the gallery', () => {
  const name = S.fileNameFor({ url: SIGNED });
  assert.strictEqual(S.extensionOf(name), 'jpg');
  assert.strictEqual(S.goesToGallery({ name }), true);
  // And the name that goes to disk carries none of it. This is the part that
  // mattered: Android reads what a file IS from the characters after the last
  // dot in its NAME, and "jpg?e=1791072000000&s=crcyuha…" is not a type
  // anything knows — so the file existed and nothing could see it.
  assert.ok(!name.includes('?'), 'the query string is still in the filename');
  assert.ok(!name.includes('&'));
  assert.ok(name.endsWith('.jpg'), `saved as ${name}`);
});

test('AND THEREFORE NO SECOND DIALOG', () => {
  // The dialog exists to name a DOCUMENT, because the indicator has no room
  // for a filename. It was appearing over photos only because photos were
  // being mistaken for documents.
  assert.strictEqual(S.shouldAnnounce({ name: S.fileNameFor({ url: SIGNED }) }), false);
  assert.strictEqual(S.shouldAnnounce({ name: 'report.pdf' }), true);
});

test('a photo is a photo whatever the message record says', () => {
  // The decision used to be msg.type alone, and in the room this was reported
  // from the type was not 'image'.
  assert.strictEqual(S.goesToGallery({ name: 'a.jpg', type: 'file' }), true);
  assert.strictEqual(S.goesToGallery({ name: 'a.mp4', type: undefined }), true);
  assert.strictEqual(S.goesToGallery({ name: 'a.heic', type: null }), true);
  // …and the type still decides when the file cannot: a URL with no
  // extension at all is common enough to matter.
  assert.strictEqual(S.goesToGallery({ name: 'blob', type: 'image' }), true);
  assert.strictEqual(S.goesToGallery({ name: 'blob', type: 'gallery' }), true);
});

test('a document is NOT dropped into the gallery', () => {
  // The opposite mistake, which would put PDFs and voice notes in somebody's
  // photo roll.
  for (const n of ['report.pdf', 'song.mp3', 'notes.txt', 'archive.zip', 'sheet.xlsx']) {
    assert.strictEqual(S.goesToGallery({ name: n }), false, n);
    assert.strictEqual(S.shouldAnnounce({ name: n }), true, n);
  }
});

test('THE SERVER\'S OWN NAME IS PREFERRED, unless it is a list', () => {
  // A gallery message keeps every name in that one field, comma separated —
  // using it whole would write one file called "a.jpg,b.jpg,c.jpg".
  assert.strictEqual(S.fileNameFor({ url: SIGNED, fileName: 'holiday.jpg' }), 'holiday.jpg');
  assert.strictEqual(S.fileNameFor({ url: SIGNED, fileName: 'a.jpg,b.jpg' }),
    '1790426577952-41739317.jpg');
});

test('NOTHING IS EVER WRITTEN SOMEWHERE ELSE', () => {
  // A name from a URL is attacker-adjacent input. A slash in it would write
  // outside the directory the caller chose.
  assert.ok(!S.fileNameFor({ url: 'x', fileName: '../../etc/passwd' }).includes('/'));
  assert.ok(!S.fileNameFor({ url: 'x', fileName: 'a/b.jpg' }).includes('/'));
  assert.ok(!S.fileNameFor({ url: 'x', fileName: 'a\\b.jpg' }).includes('\\'));
  // …and a name that is nothing, or is only dots, gets a real one.
  for (const n of ['', '   ', '.', '..', null, undefined]) {
    const out = S.fileNameFor({ url: '', fileName: n, now: 1700000000000 });
    assert.ok(out.length > 0, JSON.stringify(n));
    assert.ok(!/^\.+$/.test(out), JSON.stringify(n));
  }
});

test('a name is not allowed to be 300 characters long', () => {
  // Which is exactly what a URL mistaken for a filename produces, and what
  // some filesystems refuse outright.
  const long = 'a'.repeat(400) + '.jpg';
  assert.ok(S.fileNameFor({ url: 'x', fileName: long }).length <= 120);
});

test('a percent-encoded name comes back readable', () => {
  assert.strictEqual(S.fileNameFor({ url: '/uploads/my%20photo.jpg' }), 'my photo.jpg');
  // …and a broken encoding does not throw, which would abort the download.
  assert.ok(S.fileNameFor({ url: '/uploads/%E0%A4%A.jpg' }).length > 0);
});

// ── The wiring ──────────────────────────────────────────────────────────────

test('THE DOWNLOAD USES THEM', () => {
  const chat = fs.readFileSync(path.join(NAT, 'src', 'screens', 'ChatScreen.tsx'), 'utf8');
  const code = chat.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  assert.ok(/saveTarget\.fileNameFor\(/.test(code), 'the name is still taken from the raw URL');
  assert.ok(/saveTarget\.goesToGallery\(/.test(code), 'the destination is still msg.type alone');
  assert.ok(/saveTarget\.shouldAnnounce\(/.test(code), 'the dialog still follows the old rule');
  // The exact line that caused it must be gone.
  assert.ok(!/u\.split\('\/'\)\.pop\(\) \|\| `file-\$\{Date\.now\(\)\}`/.test(code),
    'the query string is back in the filename');
  assert.ok(!/const toGallery = msg\.type === 'gallery'/.test(code),
    'the destination is decided from msg.type again');
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
