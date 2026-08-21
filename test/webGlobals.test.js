// Every `window.X` the web scripts read must actually exist.
//
// This exists because four features shipped broken and nothing noticed.
//
// `let` and `const` at the top level of a classic script do NOT become
// properties of window — only `function` declarations and `var` do. app.js
// holds its state in `let`, so `window.token`, `window.currentRoomId`,
// `window.socket` and `window.currentDMPeerPk` were all undefined in every
// module loaded beside it. The uploader sent "Authorization: Bearer undefined"
// on every request and sat at 0 B with no error on screen; the profile sheet,
// in-chat search, encrypted search and the location picker were broken the
// same way, in silence, because reading a missing property is not an error in
// JavaScript — it is `undefined`, and `undefined` flows onwards until
// something far away behaves oddly.
//
// A browser would have caught it in a second. There is no browser here, so
// this reads the scripts instead: collect every `window.X` any of them uses,
// and check that something actually defines X.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const JS = path.join(__dirname, '..', 'public', 'js');
const files = fs.readdirSync(JS).filter(f => f.endsWith('.js') && !f.includes('nacl'));
/**
 * Comments stripped before scanning.
 *
 * Otherwise a comment EXPLAINING this bug — which app.js now carries, and which
 * naturally says "window.token" — is itself read as code and reported as a
 * missing global.
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}
const sources = Object.fromEntries(
  files.map(f => [f, stripComments(fs.readFileSync(path.join(JS, f), 'utf8'))]));
/** Unstripped, for the checks that look at how the source is written. */
const rawSources = Object.fromEntries(
  files.map(f => [f, fs.readFileSync(path.join(JS, f), 'utf8')]));

const tests = [];
const test = (n, f) => tests.push({ n, f });

/** Things the browser itself provides. */
const BUILT_IN = new Set([
  'confirm', 'alert', 'location', 'document', 'navigator', 'localStorage',
  'sessionStorage', 'addEventListener', 'removeEventListener', 'setTimeout',
  'clearTimeout', 'setInterval', 'clearInterval', 'fetch', 'open', 'close',
  'innerWidth', 'innerHeight', 'scrollTo', 'crypto', 'Notification', 'URL',
  'matchMedia', 'requestAnimationFrame', 'isSecureContext', 'top', 'parent',
  'caches', 'visualViewport', 'AudioContext', 'webkitAudioContext', 'Audio',
  'MediaRecorder', 'speechSynthesis', 'history', 'screen', 'performance',
]);

/** Everything the scripts read off window, and which file wanted it. */
function windowReads() {
  const wanted = new Map();
  for (const [file, src] of Object.entries(sources)) {
    // Reads only: `window.X` not immediately followed by `=` (an assignment
    // is a definition, and is picked up by the other scan).
    for (const m of src.matchAll(/window\.([A-Za-z_$][\w$]*)\s*(=[^=]|)/g)) {
      const [, name, assign] = m;
      if (assign.startsWith('=')) continue;
      if (BUILT_IN.has(name)) continue;
      if (!wanted.has(name)) wanted.set(name, new Set());
      wanted.get(name).add(file);
    }
  }
  return wanted;
}

/** Everything the scripts actually put on window, one way or another. */
function windowDefines() {
  const defined = new Set();
  for (const src of Object.values(sources)) {
    // window.X = ...
    for (const m of src.matchAll(/window\.([A-Za-z_$][\w$]*)\s*=[^=]/g)) defined.add(m[1]);
    // root.X = ... inside the (function (root) { … })(window) modules
    for (const m of src.matchAll(/\broot\.([A-Za-z_$][\w$]*)\s*=[^=]/g)) defined.add(m[1]);
    // Object.defineProperties(window, { x: …, y: … })
    for (const m of src.matchAll(/Object\.defineProperties\(\s*window\s*,\s*\{([\s\S]*?)\n\}\)/g)) {
      for (const p of m[1].matchAll(/^\s{2}([A-Za-z_$][\w$]*)\s*:/gm)) defined.add(p[1]);
    }
    // Top-level `function x()` and `async function x()` DO land on window.
    for (const m of src.matchAll(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm)) defined.add(m[1]);
    // …and so does `var x`.
    for (const m of src.matchAll(/^var\s+([A-Za-z_$][\w$]*)/gm)) defined.add(m[1]);
  }
  return defined;
}

test('the scan finds the globals app.js exposes', () => {
  // If this fails the two scans below are vacuous, whatever they report.
  const defined = windowDefines();
  for (const k of ['token', 'currentRoomId', 'socket', 'api', 'jumpToMessage']) {
    assert.ok(defined.has(k), `the scan cannot see ${k}; the checks below prove nothing`);
  }
});

test('the scan finds the globals the modules read', () => {
  const wanted = windowReads();
  assert.ok(wanted.has('token'), 'the scan found no window.token read at all');
  assert.ok(wanted.size > 5, `only ${wanted.size} window reads found — the scan is not working`);
});

test('THE BUG: every window global a module reads is actually defined', () => {
  const wanted = windowReads();
  const defined = windowDefines();
  const missing = [];
  for (const [name, users] of wanted) {
    if (!defined.has(name)) missing.push(`window.${name}  (read by ${[...users].join(', ')})`);
  }
  assert.deepStrictEqual(missing, [],
    'these are undefined at runtime, and reading them is silent:\n      ' + missing.join('\n      '));
});

test('state held in `let` is exposed through a getter, not a copy', () => {
  // A copy has to be re-assigned everywhere the original changes — signing
  // out, switching chats, the socket reconnecting — and the one place somebody
  // forgets is a module reading a stale token for the rest of the session.
  const app = rawSources['app.js'];
  assert.ok(/Object\.defineProperties\(\s*window/.test(app),
    'app.js no longer exposes its state through getters');
  for (const k of ['token', 'currentRoomId', 'socket']) {
    assert.ok(new RegExp(`\\n\\s{2}${k}: \\{ get: \\(\\) =>`).test(app),
      `${k} is not exposed as a getter`);
  }
});

test('every script the page loads exists', () => {
  // A typo'd src is another silent failure: the tag 404s and the feature is
  // simply absent, with nothing on screen to say so.
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const missing = [];
  for (const m of html.matchAll(/<script src="\/js\/([^"]+)"/g)) {
    if (!fs.existsSync(path.join(JS, m[1]))) missing.push(m[1]);
  }
  assert.deepStrictEqual(missing, [], `index.html loads scripts that do not exist: ${missing}`);
});

test('every module the page needs is actually loaded, in an order that works', () => {
  // peer.js reading window.PeerActions is only fine because peerActions.js is
  // loaded first. These are plain scripts, so order is the whole contract.
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const order = [...html.matchAll(/<script src="\/js\/([^"]+)"/g)].map(m => m[1]);
  const pos = f => order.indexOf(f);
  const pairs = [
    ['peerActions.js', 'peer.js'],
    ['localSearch.js', 'encsearch.js'],
    ['localSearch.js', 'chatsearch.js'],
    ['locationPick.js', 'locpicker.js'],
    ['resumable.js', 'app.js'],
    ['mentions.js', 'app.js'],
  ];
  for (const [first, second] of pairs) {
    assert.ok(pos(first) !== -1, `${first} is never loaded`);
    assert.ok(pos(second) !== -1, `${second} is never loaded`);
    assert.ok(pos(first) < pos(second), `${first} must load before ${second}`);
  }
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
