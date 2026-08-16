// Tests for the media cache's pure parts (native-app/src/mediaCache.ts).
//
// The download side needs a filesystem and a network, so what is tested here
// is what can go quietly wrong without either: the cache KEY (which is what
// makes a re-signed URL still find its existing file) and the pruning plan
// (which decides what gets deleted when the cache is over its cap).
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'mctest-'));
const TSC = path.join(__dirname, '..', 'native-app', 'node_modules', '.bin', 'tsc');
if (!fs.existsSync(TSC)) {
  console.log('  ! skipping media-cache tests (native-app deps not installed)');
  process.exit(0);
}
// mediaCache imports expo-file-system, which cannot load outside a device, so
// the pure functions are compiled with a stub standing in for it.
const SRC = path.join(__dirname, '..', 'native-app', 'src');
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'mcsrc-'));
fs.copyFileSync(path.join(SRC, 'mediaCache.ts'), path.join(WORK, 'mediaCache.ts'));
fs.copyFileSync(path.join(SRC, 'download.ts'), path.join(WORK, 'download.ts'));
fs.mkdirSync(path.join(WORK, 'expo-file-system'), { recursive: true });
fs.writeFileSync(path.join(WORK, 'expo-file-system', 'index.ts'),
  'export const cacheDirectory = "file:///cache/";\n'
  + 'export const documentDirectory = "file:///docs/";\n'
  + 'export const makeDirectoryAsync: any = async () => {};\n'
  + 'export const getInfoAsync: any = async () => ({ exists: false });\n'
  + 'export const downloadAsync: any = async () => ({ uri: "", status: 500 });\n'
  + 'export const moveAsync: any = async () => {};\n'
  + 'export const deleteAsync: any = async () => {};\n'
  + 'export const readDirectoryAsync: any = async () => [];\n');
fs.writeFileSync(path.join(WORK, 'mediaCache.ts'),
  fs.readFileSync(path.join(WORK, 'mediaCache.ts'), 'utf8')
    .replace("from 'expo-file-system'", "from './expo-file-system'"));

execFileSync(TSC, [path.join(WORK, 'mediaCache.ts'), '--outDir', OUT,
  '--module', 'commonjs', '--target', 'es2019', '--skipLibCheck'], { stdio: 'pipe' });
const M = require(path.join(OUT, 'mediaCache.js'));

const tests = [];
const test = (n, f) => tests.push({ n, f });

test('a re-signed URL maps to the SAME cached file', () => {
  // The whole point: media URLs are signed and the signature is renewed, so a
  // key that included the query would re-download every file every time.
  const a = M.keyFor('https://chat.example.com/uploads/pic.jpg?e=111&s=aaa');
  const b = M.keyFor('https://chat.example.com/uploads/pic.jpg?e=999&s=zzz');
  assert.strictEqual(a, b);
});

test('different files never share a key', () => {
  assert.notStrictEqual(
    M.keyFor('/uploads/a.jpg'),
    M.keyFor('/uploads/b.jpg'),
  );
});

test('nothing is deleted while the cache is under its cap', () => {
  const files = [
    { name: 'a', size: 10, modified: 1 },
    { name: 'b', size: 10, modified: 2 },
  ];
  assert.deepStrictEqual(M.planPrune(files, 100), []);
  // Exactly at the cap is still under it.
  assert.deepStrictEqual(M.planPrune(files, 20), []);
});

test('pruning deletes the OLDEST files, and only as many as it must', () => {
  const files = [
    { name: 'newest', size: 30, modified: 300 },
    { name: 'oldest', size: 30, modified: 100 },
    { name: 'middle', size: 30, modified: 200 },
  ];
  // 90 bytes, cap 50 → must free 40, which takes the two oldest.
  assert.deepStrictEqual(M.planPrune(files, 50), ['oldest', 'middle']);
  // 90 bytes, cap 70 → freeing the single oldest is enough.
  assert.deepStrictEqual(M.planPrune(files, 70), ['oldest']);
});

test('pruning does not mutate the list it was given', () => {
  // Deliberately not in date order, so a sort in place is visible.
  const files = [
    { name: 'middle', size: 30, modified: 200 },
    { name: 'newest', size: 30, modified: 300 },
    { name: 'oldest', size: 30, modified: 100 },
  ];
  M.planPrune(files, 10);
  assert.deepStrictEqual(files.map(f => f.name), ['middle', 'newest', 'oldest'],
    'the caller’s array was re-sorted');
});

test('a cache that cannot get under the cap still stops at everything', () => {
  const files = [{ name: 'huge', size: 999, modified: 1 }];
  assert.deepStrictEqual(M.planPrune(files, 10), ['huge']);
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
fs.rmSync(OUT, { recursive: true, force: true });
fs.rmSync(WORK, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
