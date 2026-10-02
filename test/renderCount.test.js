// ── The render counters ─────────────────────────────────────────────────────
//
// Small, but the reason they exist is that four readings of ChatScreen have
// failed to explain the reaction slowdown. A counter that is wired up wrongly
// would send two zeros for ever and look exactly like "nothing is wrong",
// which is the failure mode this whole file is guarding against — the same
// one that made the notification counters lie for a week.
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const NAT = path.join(ROOT, 'native-app');
const TSC = path.join(NAT, 'node_modules', '.bin', 'tsc');
if (!fs.existsSync(TSC)) {
  console.log('  ! skipping render-count tests (native-app deps not installed)');
  process.exit(0);
}
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'rcount-'));
process.on('exit', () => fs.rmSync(OUT, { recursive: true, force: true }));
execFileSync(TSC, [path.join(NAT, 'src', 'renderCount.ts'),
  '--outDir', OUT, '--module', 'commonjs', '--target', 'es2019',
  '--skipLibCheck', '--esModuleInterop'], { stdio: 'pipe' });
const R = require(path.join(OUT, 'renderCount.js'));

const tests = [];
const test = (n, f) => tests.push({ n, f });

test('IT COUNTS, and counts the two things separately', () => {
  R.reset();
  R.noteScreen();
  R.noteRow(); R.noteRow(); R.noteRow();
  assert.deepStrictEqual(R.snapshot(), { screens: 1, rows: 3 });
});

test('READING DOES NOT RESET IT', () => {
  // The question is how these numbers GROW. A counter that cleared on read
  // would make two readings impossible to compare, which is the only thing
  // they are for.
  R.reset();
  R.noteScreen();
  R.snapshot();
  R.snapshot();
  assert.strictEqual(R.snapshot().screens, 1);
});

test('THE SNAPSHOT IS NOT A LIVE HANDLE ON THE COUNTERS', () => {
  // A caller that kept the object and read it later would get numbers from
  // the future, so "before" and "after" would always look identical.
  R.reset();
  R.noteScreen();
  const before = R.snapshot();
  R.noteScreen();
  assert.strictEqual(before.screens, 1, 'the snapshot changed under the caller');
  assert.strictEqual(R.snapshot().screens, 2);
});

test('THE CHAT SCREEN ACTUALLY CALLS BOTH', () => {
  // Wired into the render body and into the row renderer. A counter nobody
  // calls reports zero for ever and reads as "no problem here".
  const chat = fs.readFileSync(
    path.join(NAT, 'src', 'screens', 'ChatScreen.tsx'), 'utf8')
    .replace(/\/\/[^\n]*/g, '');
  assert.ok(/renderCount\.noteScreen\(\)/.test(chat), 'the screen is never counted');
  assert.ok(/renderCount\.noteRow\(\)/.test(chat), 'rows are never counted');
  // The row counter must be INSIDE renderMessage, not somewhere it runs once.
  const fn = /function renderMessage\([^)]*\)\s*\{([\s\S]{0,400})/.exec(chat);
  assert.ok(fn, 'could not find renderMessage');
  assert.ok(/renderCount\.noteRow\(\)/.test(fn[1]),
    'noteRow is not called when a row renders, so it measures nothing');
});

test('THE NUMBERS ACTUALLY LEAVE THE PHONE', () => {
  // They are read off the server log, not a screenshot. If they are not on
  // the health event they are unreachable, and this whole module is dead
  // weight that looks like a measurement.
  const app = fs.readFileSync(path.join(NAT, 'App.tsx'), 'utf8')
    .replace(/\/\/[^\n]*/g, '');
  assert.ok(/renders:\s*renderCount\.snapshot\(\)\.screens/.test(app),
    'the render count is never sent');
  assert.ok(/rows:\s*renderCount\.snapshot\(\)\.rows/.test(app),
    'the row count is never sent');
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8')
    .replace(/\/\/[^\n]*/g, '');
  assert.ok(/renders=\$\{n\(h && h\.renders\)\}/.test(server),
    'the server receives them and does not log them');
  assert.ok(/rows=\$\{n\(h && h\.rows\)\}/.test(server),
    'the row count is received and not logged');
});

test('THE LOG LINE STILL CARRIES NO NAME AND NO TOKEN', () => {
  // This log is read into a repository that has been public. Adding a field
  // to that line is exactly when somebody adds a username next to it.
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const line = /\[device\] user=\$\{socket\.user\.id\}[\s\S]{0,1400}?;\n/.exec(server);
  assert.ok(line, 'could not find the device log line');
  assert.ok(!/username/.test(line[0]), 'the device log line now names the user');
  assert.ok(!/token/i.test(line[0]), 'the device log line now carries a token');
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
