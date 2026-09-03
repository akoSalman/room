// Names the app uses that do not exist.
//
// Reported as a crash report, from the crash screen added the day before:
//
//     Property 'hit' doesn't exist
//     at ChatScreen (index.android.bundle:1:1560034)
//
// `hitSlop={hit}` in the comments header. Every other component in this app
// defines its own module-level `const hit`; ChatScreen did not, and I copied
// the idiom in from one that does. So opening a thread drew a header that
// touched an undefined name, and the whole screen died. That is the entire
// "tapping the comment button crashes the app".
//
// WHY IT SHIPPED, which matters more than the typo.
//
// TypeScript had already caught it — `error TS2304: Cannot find name 'hit'`.
// I ran tsc on ChatScreen before building, counted seven errors, compared that
// to a "baseline" measured from git HEAD, saw seven there too, and concluded
// they were all pre-existing. But HEAD already contained my comments commit,
// so the baseline contained the bug. I compared the defect against itself and
// called it clean.
//
// A count is not a check. This runs the compiler over every source file in the
// app and fails on the two error codes that are ALWAYS a crash at runtime:
//
//   TS2304  Cannot find name 'x'          — the name does not exist
//   TS2552  Cannot find name 'x'. Did you mean 'y'? — the same, misspelled
//
// Deliberately only those two. A full typecheck of this project reports a
// handful of long-standing type mismatches that do not crash anything, and a
// test that fails for them would be turned off within a week. These two cannot
// be argued with: the name is not there, and reaching it throws.
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const NAT = path.join(__dirname, '..', 'native-app');
const TSC = path.join(NAT, 'node_modules', '.bin', 'tsc');
if (!fs.existsSync(TSC)) {
  console.log('  ! skipping native name check (native-app deps not installed)');
  process.exit(0);
}

/** Every TypeScript source in the app, App.tsx included. */
function sources(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...sources(full));
    else if (/\.tsx?$/.test(e.name) && !/\.d\.ts$/.test(e.name)) out.push(full);
  }
  return out;
}

const files = [
  ...(fs.existsSync(path.join(NAT, 'App.tsx')) ? [path.join(NAT, 'App.tsx')] : []),
  ...sources(path.join(NAT, 'src')),
];

let output = '';
try {
  execFileSync(TSC, [
    '--noEmit', ...files,
    '--jsx', 'react-native', '--esModuleInterop', '--skipLibCheck',
    '--target', 'es2019', '--moduleResolution', 'node', '--module', 'esnext',
    '--lib', 'es2019,dom',
  ], { cwd: NAT, stdio: 'pipe' });
} catch (e) {
  // tsc exits non-zero whenever it reports anything, including the errors this
  // test deliberately ignores — so the exit code is not the signal, the output
  // is.
  output = String(e.stdout || '') + String(e.stderr || '');
}

const tests = [];
const test = (n, f) => tests.push({ n, f });

test('every source file was actually compiled', () => {
  // Without this the check passes gloriously by compiling nothing at all.
  assert.ok(files.length > 30, `only ${files.length} sources found`);
  assert.ok(files.some(f => f.endsWith('ChatScreen.tsx')), 'the biggest screen is not being checked');
  assert.ok(files.some(f => f.endsWith('App.tsx')), 'the app entry point is not being checked');
});

test('THE CRASH: no file uses a name that does not exist', () => {
  const missing = output.split('\n').filter(l => /error TS(2304|2552):/.test(l));
  assert.deepStrictEqual(missing, [],
    `a name is used that is not defined — this is a crash, not a type quibble:\n${missing.join('\n')}`);
});

test('and the compiler really ran', () => {
  // A tsc that failed to start produces no output at all, and an empty haystack
  // makes the check above pass without looking at anything. Either it emitted
  // diagnostics, or it exited clean with none.
  assert.ok(output === '' || /error TS\d+/.test(output),
    `tsc produced output that is not diagnostics:\n${output.slice(0, 400)}`);
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
