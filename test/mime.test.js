// Tests for the app's mime inference (native-app/src/mime.ts).
//
// This is pure logic and directly decides whether a shared file arrives as
// music (with a player), a video, an image, or a generic document — the exact
// thing that broke when Android's share sheet supplied no mime type.
//
// The module is TypeScript, so it's transpiled to a temp dir first.
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'mimetest-'));
const SRC = path.join(__dirname, '..', 'native-app', 'src', 'mime.ts');
const TSC = path.join(__dirname, '..', 'native-app', 'node_modules', '.bin', 'tsc');

if (!fs.existsSync(TSC)) {
  console.log('  ! skipping mime tests (native-app deps not installed)');
  process.exit(0);
}
execFileSync(TSC, [SRC, '--outDir', OUT, '--module', 'commonjs', '--target', 'es2019', '--skipLibCheck'],
  { stdio: 'pipe' });
const mime = require(path.join(OUT, 'mime.js'));

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('infers audio from extension when the share sheet gives nothing', () => {
  assert.strictEqual(mime.guessMime('song.mp3', null), 'audio/mpeg');
  assert.strictEqual(mime.guessMime('track.m4a', undefined), 'audio/mp4');
  assert.strictEqual(mime.guessMime('voice.ogg', ''), 'audio/ogg');
});

test('octet-stream is overridden by the extension (the actual share-sheet bug)', () => {
  assert.strictEqual(mime.guessMime('song.mp3', 'application/octet-stream'), 'audio/mpeg');
  assert.strictEqual(mime.guessMime('doc.pdf', 'application/octet-stream'), 'application/pdf');
  assert.strictEqual(mime.messageTypeFor('application/octet-stream', 'song.mp3'), 'music',
    'a shared mp3 with no mime must still become a music message');
});

test('a real supplied mime always wins over the extension', () => {
  assert.strictEqual(mime.guessMime('weird.bin', 'audio/mpeg'), 'audio/mpeg');
});

test('message types map correctly', () => {
  assert.strictEqual(mime.messageTypeFor('image/png', 'a.png'), 'image');
  assert.strictEqual(mime.messageTypeFor('video/mp4', 'a.mp4'), 'video');
  assert.strictEqual(mime.messageTypeFor('audio/mpeg', 'a.mp3'), 'music');
  assert.strictEqual(mime.messageTypeFor('application/pdf', 'a.pdf'), 'file');
});

test('extension parsing survives query strings, paths and dotfiles', () => {
  assert.strictEqual(mime.extOf('/path/to/Song Name.MP3'), 'mp3');
  assert.strictEqual(mime.extOf('https://x.com/a/b.pdf?token=1#p2'), 'pdf');
  assert.strictEqual(mime.extOf('noextension'), '');
  assert.strictEqual(mime.extOf('.gitignore'), '', 'a dotfile has no extension');
});

test('file icons distinguish document types', () => {
  const icons = ['report.pdf', 'notes.docx', 'data.xlsx', 'deck.pptx', 'bundle.zip', 'song.mp3']
    .map(f => mime.fileIcon(f, null));
  assert.strictEqual(new Set(icons).size, icons.length, `icons must differ per type, got ${icons}`);
});

let passed = 0, failed = 0;
for (const { name, fn } of tests) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n      ${e.message}`); failed++; }
}
fs.rmSync(OUT, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
