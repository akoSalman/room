// Where the incoming-call handlers are registered, which decides whether the
// phone rings when the app is closed.
//
// The server side of this is already covered by callpush.test.js: the push
// goes out data-only and high priority, so Android wakes the JS bundle instead
// of drawing a banner itself. That is only half of it. Waking the bundle
// achieves nothing unless a handler has been registered by the time the push
// lands, and the registration used to sit at module scope in App.tsx.
//
// App.tsx runs on a background start — but only as the final step of
// evaluating its whole import graph: the chat screen, the socket, WebRTC, the
// media cache, the player. In a headless context there is no UI and some
// native modules are not ready, and any one of those throwing takes the module
// down before the registration line is reached. The call then never rings, and
// nothing anywhere reports why.
//
// So this checks the arrangement rather than the behaviour: registration
// happens first, from a file that pulls in almost nothing. Static analysis is
// the only tool available here — the alternative is a device and a phone call
// — but it does pin the exact thing that regressed.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const APP = path.join(__dirname, '..', 'native-app');
const read = p => fs.readFileSync(path.join(APP, p), 'utf8');

const tests = [];
const test = (n, f) => tests.push({ n, f });

test('the entry point registers the call handlers', () => {
  const index = read('index.js');
  assert.ok(/registerCallPush\s*\(\s*\)/.test(index),
    'index.js never registers the incoming-call handlers');
});

test('THE BUG: they are registered BEFORE the app is imported', () => {
  const index = read('index.js');
  const reg = index.indexOf('registerCallPush()');
  // Whichever way App is pulled in, it must come after.
  const app = Math.min(
    ...[/require\(['"]\.\/App['"]\)/, /^import App from/m]
      .map(re => { const m = index.match(re); return m ? index.indexOf(m[0]) : Infinity; }),
  );
  assert.ok(reg > 0, 'registerCallPush() is not called in index.js');
  assert.ok(app !== Infinity, 'index.js does not import App at all');
  assert.ok(reg < app,
    'App is imported before the call handlers are registered, so a failure '
    + "anywhere in the app's import graph silences incoming calls");
});

// Walk the TOP-LEVEL relative imports of a module and return everything
// reachable.
//
// Only top-level imports count. A `require()` inside a handler body — which is
// how callPush.ts reaches callManager and locationManager — is evaluated when
// the user presses a button, long after registration has happened, so it
// cannot stop the handler being registered in the first place. Counting those
// would flag the safe case and say nothing about the dangerous one.
function localClosure(entry) {
  const seen = new Set();
  const stack = [entry];
  while (stack.length) {
    const rel = stack.pop();
    if (seen.has(rel)) continue;
    seen.add(rel);
    let src;
    try { src = read(rel); } catch { continue; }
    const re = /^\s*import\s(?:[^;]*?from\s*)?['"](\.[^'"]+)['"]/gm;
    let m;
    while ((m = re.exec(src))) {
      const base = path.normalize(path.join(path.dirname(rel), m[1]));
      // Try the usual extensions; a directory import is not used here.
      for (const ext of ['.ts', '.tsx', '.js', '.jsx']) {
        if (fs.existsSync(path.join(APP, base + ext))) { stack.push(base + ext); break; }
      }
    }
  }
  return seen;
}

test('the call-push module does not drag in the rest of the app', () => {
  const closure = localClosure('src/callPush.ts');
  const heavy = [...closure].filter(f =>
    f.includes('screens/') || f === 'App.tsx' || f.includes('components/'));
  assert.deepStrictEqual(heavy, [],
    `callPush.ts reaches ${heavy.join(', ')} — a failure in any of those during a `
    + 'headless start would stop the phone ringing');
});

test('the call-push module stays small', () => {
  // Not a style rule. Every module in this closure is another thing that can
  // throw in a headless context before the handler is registered.
  const closure = localClosure('src/callPush.ts');
  assert.ok(closure.size <= 4,
    `callPush.ts now reaches ${closure.size} local modules: ${[...closure].join(', ')}`);
});

test('only one notifee background handler is registered', () => {
  // Notifee allows exactly one; a second registration silently replaces the
  // first, so Accept/Decline from the shade would stop working.
  const files = ['index.js', 'App.tsx', 'src/callPush.ts'];
  // The call, not the word — App.tsx still explains in a comment why the
  // handler is not here, and a comment is not a registration.
  const found = files.filter(f => /notifee\.onBackgroundEvent\s*\(/.test(read(f)));
  assert.deepStrictEqual(found, ['src/callPush.ts'],
    `onBackgroundEvent is registered in ${found.join(' and ')}`);
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
