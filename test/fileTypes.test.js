// Every common file type, end to end: what bubble it gets, what icon, what
// mime it is sent with, and what tapping it does.
//
// Asked for after the APK fix: "the previous bug maybe also is for other file
// types, check that every possible (common) type has the correct way of
// downloading and opening."
//
// It was a fair suspicion. The APK failed for three reasons and only one of
// them — the install intent — was specific to APKs; the missing download
// button was every file type's problem. This file is the audit, written as a
// table so a type that is added later either appears in it or is noticed by
// its absence.
//
// Two things it found:
//
//   • SVG and TIFF were routed to an IMAGE bubble. React Native's <Image> on
//     Android draws neither, so they arrived as a permanently broken picture
//     with no download button and no way to get at the file at all. They are
//     files now.
//   • A pile of types people actually send — a contact card, a calendar
//     invitation, subtitles, an OpenDocument file, a .log, an ISO — had no
//     mime at all, so they went out as application/octet-stream and Android
//     had nothing to choose an app with.
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const NAT = path.join(ROOT, 'native-app');
const TSC = path.join(NAT, 'node_modules', '.bin', 'tsc');
if (!fs.existsSync(TSC)) {
  console.log('  ! skipping file-type tests (native-app deps not installed)');
  process.exit(0);
}
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'filetypes-'));
execFileSync(TSC, [path.join(NAT, 'src', 'mime.ts'), path.join(NAT, 'src', 'fileOpen.ts'),
  '--outDir', OUT, '--module', 'commonjs', '--target', 'es2019', '--skipLibCheck'], { stdio: 'pipe' });
const M = require(path.join(OUT, 'mime.js'));
const F = require(path.join(OUT, 'fileOpen.js'));

const tests = [];
const test = (n, f) => tests.push({ n, f });

// name → [expected mime, expected bubble, expected tap once downloaded]
const TABLE = {
  // ── pictures ──────────────────────────────────────────────────────────────
  'holiday.jpg': ['image/jpeg', 'image', null],
  'holiday.jpeg': ['image/jpeg', 'image', null],
  'screenshot.png': ['image/png', 'image', null],
  'meme.gif': ['image/gif', 'image', null],
  'photo.webp': ['image/webp', 'image', null],
  'scan.bmp': ['image/bmp', 'image', null],
  'iphone.heic': ['image/heic', 'image', null],
  // Not displayable by React Native on Android — a file, not a broken picture.
  'logo.svg': ['image/svg+xml', 'file', 'open'],
  'fax.tiff': ['image/tiff', 'file', 'open'],
  // ── video ─────────────────────────────────────────────────────────────────
  'clip.mp4': ['video/mp4', 'video', null],
  'clip.mov': ['video/quicktime', 'video', null],
  'film.mkv': ['video/x-matroska', 'video', null],
  'old.avi': ['video/x-msvideo', 'video', null],
  'web.webm': ['video/webm', 'video', null],
  'phone.3gp': ['video/3gpp', 'video', null],
  // ── audio ─────────────────────────────────────────────────────────────────
  'song.mp3': ['audio/mpeg', 'music', null],
  'voice.m4a': ['audio/mp4', 'music', null],
  'sound.wav': ['audio/wav', 'music', null],
  'track.ogg': ['audio/ogg', 'music', null],
  'lossless.flac': ['audio/flac', 'music', null],
  'note.amr': ['audio/amr', 'music', null],
  // ── documents ─────────────────────────────────────────────────────────────
  'contract.pdf': ['application/pdf', 'file', 'open'],
  'letter.doc': ['application/msword', 'file', 'open'],
  'letter.docx': ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'file', 'open'],
  'budget.xls': ['application/vnd.ms-excel', 'file', 'open'],
  'budget.xlsx': ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'file', 'open'],
  'deck.ppt': ['application/vnd.ms-powerpoint', 'file', 'open'],
  'deck.pptx': ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'file', 'open'],
  'notes.txt': ['text/plain', 'file', 'open'],
  'readme.md': ['text/markdown', 'file', 'open'],
  'data.csv': ['text/csv', 'file', 'open'],
  'config.json': ['application/json', 'file', 'open'],
  'page.html': ['text/html', 'file', 'open'],
  'book.epub': ['application/epub+zip', 'file', 'open'],
  'open.odt': ['application/vnd.oasis.opendocument.text', 'file', 'open'],
  'sheet.ods': ['application/vnd.oasis.opendocument.spreadsheet', 'file', 'open'],
  'server.log': ['text/plain', 'file', 'open'],
  // ── things a phone knows what to do with ─────────────────────────────────
  'ako.vcf': ['text/vcard', 'file', 'open'],
  'meeting.ics': ['text/calendar', 'file', 'open'],
  'movie.srt': ['application/x-subrip', 'file', 'open'],
  // ── archives ──────────────────────────────────────────────────────────────
  'photos.zip': ['application/zip', 'file', 'open'],
  'backup.rar': ['application/vnd.rar', 'file', 'open'],
  'files.7z': ['application/x-7z-compressed', 'file', 'open'],
  'archive.tar': ['application/x-tar', 'file', 'open'],
  'dump.gz': ['application/gzip', 'file', 'open'],
  'disk.iso': ['application/x-iso9660-image', 'file', 'open'],
  // ── apps ──────────────────────────────────────────────────────────────────
  'ChatRoom-1.4.apk': ['application/vnd.android.package-archive', 'file', 'install'],
  // A split bundle is NOT installable by Android's installer; offering "tap
  // to install" for one would fail every single time.
  'game.xapk': ['application/zip', 'file', 'open'],
};

test('THE AUDIT: every common type has a real mime, a bubble and a tap', () => {
  let checked = 0;
  for (const [name, [mime, bubble, tap]] of Object.entries(TABLE)) {
    assert.strictEqual(M.guessMime(name, null), mime, `${name}: wrong mime`);
    assert.strictEqual(M.messageTypeFor('', name), bubble, `${name}: wrong bubble`);
    if (tap) {
      assert.strictEqual(
        F.tapAction({ kind: F.kindOf(name, null), downloaded: true, downloading: false }), tap,
        `${name}: tapping it does the wrong thing`);
    }
    checked++;
  }
  assert.ok(checked >= 45, `only ${checked} types checked`);
});

test('every one of them downloads before it opens', () => {
  // The missing download button was not an APK problem — it was every file's.
  for (const name of Object.keys(TABLE)) {
    if (M.messageTypeFor('', name) !== 'file') continue;
    assert.strictEqual(
      F.tapAction({ kind: F.kindOf(name, null), downloaded: false, downloading: false }), 'download',
      `${name} is opened without being downloaded first`);
    assert.strictEqual(
      F.showsDownloadButton({ downloaded: false, downloading: false }), true);
  }
});

test('only an APK is treated as installable', () => {
  for (const name of Object.keys(TABLE)) {
    const isApk = /\.apk$/i.test(name);
    assert.strictEqual(F.isApk(name, M.guessMime(name, null)), isApk, `${name}`);
  }
});

test('THE BUG THE AUDIT FOUND: SVG and TIFF are files, not broken pictures', () => {
  // React Native's <Image> draws neither on Android. As image bubbles they had
  // no download button and no way to get at the file at all.
  assert.strictEqual(M.messageTypeFor('image/svg+xml', 'logo.svg'), 'file');
  assert.strictEqual(M.messageTypeFor('image/tiff', 'fax.tif'), 'file');
  // …and every other image is still an image.
  for (const n of ['a.jpg', 'a.png', 'a.gif', 'a.webp', 'a.heic', 'a.bmp']) {
    assert.strictEqual(M.messageTypeFor('', n), 'image', n);
  }
});

test('a type nobody has heard of is still a file, not a crash', () => {
  assert.strictEqual(M.guessMime('thing.qqq', null), 'application/octet-stream');
  assert.strictEqual(M.messageTypeFor('', 'thing.qqq'), 'file');
  assert.strictEqual(M.messageTypeFor('', 'no-extension'), 'file');
  assert.strictEqual(F.kindOf('thing.qqq'), 'document');
  assert.strictEqual(F.cardMeta({ kind: 'document', ext: 'qqq', downloaded: true, downloading: false }),
    'QQQ · tap to open');
});

test('a supplied mime beats the extension, except the meaningless one', () => {
  // Files shared into the app from elsewhere very often claim octet-stream.
  assert.strictEqual(M.guessMime('song.mp3', 'application/octet-stream'), 'audio/mpeg');
  assert.strictEqual(M.guessMime('x.bin', 'application/pdf'), 'application/pdf');
});

test('the icons distinguish what people actually receive', () => {
  const icon = (n) => M.fileIcon(n, null);
  assert.strictEqual(icon('a.pdf'), '📕');
  assert.strictEqual(icon('a.docx'), '📘');
  assert.strictEqual(icon('a.xlsx'), '📗');
  assert.strictEqual(icon('a.pptx'), '📙');
  assert.strictEqual(icon('a.zip'), '🗜');
  assert.strictEqual(icon('a.iso'), '🗜');
  assert.strictEqual(icon('a.apk'), '📦');
  assert.strictEqual(icon('a.xapk'), '📦');
  assert.strictEqual(icon('a.vcf'), '👤');
  assert.strictEqual(icon('a.ics'), '📅');
  assert.strictEqual(icon('a.txt'), '📝');
  assert.strictEqual(icon('a.qqq'), '📄');
});

test('an extension is read the way filenames really arrive', () => {
  // Signed media URLs carry a query; uploads are renamed with dots in them.
  assert.strictEqual(M.extOf('/uploads/1739-123.apk?e=1&s=abc'), 'apk');
  assert.strictEqual(M.extOf('My Report.final.docx'), 'docx');
  assert.strictEqual(M.extOf('LOUD.PDF'), 'pdf');
  assert.strictEqual(M.extOf('no-extension'), '');
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
fs.rmSync(OUT, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
