// The layout stays left-to-right on a Persian phone
// (native-app/index.js, App.tsx, Composer, RoomsScreen).
//
// Reported with a photograph: on a device set to Persian the whole app is
// mirrored — the back arrow on the right, the microphone on the left, every
// name and timestamp against the wrong edge.
//
// WHY THE EXISTING GUARD DID NOTHING. App.tsx already called
// I18nManager.allowRTL(false) and forceRTL(false), under a comment saying
// they "keep the app layout LTR even on RTL locales". React Native's own
// source says otherwise:
//
//     const i18nConstants = getI18nManagerConstants();   // read ONCE, at load
//     allowRTL: (shouldAllow) => { NativeI18nManager.allowRTL(shouldAllow); }
//
// isRTL is a constant captured when the module loads, and allowRTL only
// writes a flag the native side reads at startup. Neither call can change the
// session it runs in — so the launch after installing on a Persian phone is
// mirrored wherever they are called from, and stays mirrored until the
// process is next started cold. With a keep-alive service holding the app in
// memory, that can be days.
//
// So the flags move to the earliest point, and the one thing that CAN act on
// them in the same session — a reload — is paired with them, once.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const NATIVE = path.join(__dirname, '..', 'native-app');
const read = f => fs.readFileSync(path.join(NATIVE, f), 'utf8');
const index = read('index.js');
const app = read('App.tsx');
const composer = read(path.join('src', 'components', 'Composer.tsx'));
const rooms = read(path.join('src', 'screens', 'RoomsScreen.tsx'));

// These files explain the bug at length; a regex that reads its own comments
// proves nothing.
const code = src => src
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ')
  .replace(/^\s*\/\/.*$/gm, ' ');

const tests = [];
const test = (n, f) => tests.push({ n, f });

test('the flags are written BEFORE the app is loaded', () => {
  // They decide the layout of the next start, so the only thing that matters
  // is that they run — but running them before App's import graph is what
  // makes the ordering obvious to the next reader, and App.tsx is where they
  // used to hide.
  const c = code(index);
  assert.match(c, /I18nManager\.allowRTL\(false\)/, 'nothing stops RTL layout');
  assert.match(c, /I18nManager\.forceRTL\(false\)/);
  const flag = c.indexOf('I18nManager.allowRTL(false)');
  const loadApp = c.indexOf("require('./App')");
  assert.ok(flag > 0 && loadApp > flag,
    'the app is loaded before the layout direction is settled');
});

test('App.tsx no longer claims to do it', () => {
  // Two copies would say the problem was handled twice over when it was not
  // handled at all.
  const c = code(app);
  assert.doesNotMatch(c, /I18nManager\.allowRTL/,
    'the ineffective call is still in App.tsx as well');
  assert.doesNotMatch(c, /I18nManager\.forceRTL/);
});

test('A MIRRORED SESSION RESTARTS ITSELF, exactly once', () => {
  // The flags land on the next start; without this the person waits for the
  // process to die on its own.
  const c = code(app);
  assert.match(c, /function unmirrorOnce\(\)/, 'nothing applies the flags now');
  const fn = c.slice(c.indexOf('function unmirrorOnce()'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /I18nManager\.isRTL/, 'it reloads without checking anything');
  assert.match(body, /reloadAppAsync\(\)/);
  // One shot. A flag that never sticks must not restart the app for ever.
  assert.match(body, /getItem\(RTL_RELOAD_KEY\)/, 'nothing stops a reload loop');
  assert.match(body, /if \(tried\) return;/);
  assert.ok(body.indexOf('getItem') < body.indexOf('reloadAppAsync'),
    'it reloads before checking whether it already tried');
  // …and re-arms when the layout is right, so a later locale change is
  // handled the same way rather than once per install.
  assert.match(body, /removeItem\(RTL_RELOAD_KEY\)/,
    'the marker is never cleared, so this works only once ever');
});

test('THE RELOAD IS NOT IN THE HEADLESS PATH', () => {
  // index.js also runs when Android wakes the app for an incoming call, with
  // no UI at all. Restarting the process mid-call to fix the look of a screen
  // nobody is on would be a poor trade.
  const c = code(index);
  assert.doesNotMatch(c, /reloadAppAsync/,
    'the entry point can restart the app during a headless call start');
  // It belongs where a UI exists by definition.
  assert.match(code(app), /useEffect\(\(\) => \{ unmirrorOnce\(\); \}, \[\]\)/,
    'the reload is never actually run on mount');
});

test('inputs are aligned by WHAT IS IN THEM, not by the phone locale', () => {
  // textAlign: isRTL ? 'right' : 'left' is now always 'left', because the
  // layout is pinned LTR — so Persian would be typed against the wrong edge.
  // Direction is a property of the text, and bidi.ts already decides it per
  // message by counting strong characters.
  for (const [name, src] of [['Composer', composer], ['RoomsScreen', rooms]]) {
    const c = code(src);
    assert.doesNotMatch(c, /textAlign: isRTL/,
      `${name} still aligns its input by the device locale`);
    assert.match(c, /alignFor\(baseDirection\(/,
      `${name} does not align its input by its content`);
  }
});

test('every text input that had locale alignment now has content alignment', () => {
  // Counted, so an input added later with the old pattern is noticed.
  const c = code(rooms);
  const aligned = (c.match(/alignFor\(baseDirection\(/g) || []).length;
  assert.ok(aligned >= 4, `only ${aligned} of RoomsScreen's inputs align by content`);
});

test('nothing reads isRTL for layout any more', () => {
  // theme.ts may still export it; what matters is that no screen branches on
  // it, because it is now a constant that is always false.
  for (const [name, src] of [['Composer', composer], ['RoomsScreen', rooms]]) {
    assert.doesNotMatch(code(src), /\bisRTL\b/,
      `${name} still branches on isRTL, which cannot change`);
  }
});

test('THE TYPE CHECK IS A REAL CHECK', () => {
  // tsconfig.json was never tracked: Expo generates it on demand, so a fresh
  // container has none — and `npx tsc --noEmit -p tsconfig.json` then exits
  // with "the specified path does not exist" rather than checking anything.
  // Filtered through a grep for a filename, that failure reads exactly like
  // success, and several type checks in this repository's history were that.
  const cfgPath = path.join(NATIVE, 'tsconfig.json');
  assert.ok(fs.existsSync(cfgPath),
    'native-app/tsconfig.json is missing, so tsc silently checks nothing');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  assert.ok(cfg.extends, 'the tsconfig extends nothing, so it checks almost nothing');
});

let failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ok  ${n}`); }
  catch (e) { failed++; console.log(`  FAIL ${n}\n       ${e.message}`); }
}
if (failed) { console.log(`\n  ${failed} rtl-layout test(s) failed`); process.exit(1); }
console.log(`  ${tests.length} rtl-layout tests passed`);
