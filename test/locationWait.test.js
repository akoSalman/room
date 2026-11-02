// Waiting for a fix, and the tiles a map that cannot be panned should not ask
// for (native-app/src/locationWait.ts, geo.ts, locationManager.ts).
//
// Three things, all from one report.
//
// 1. ASKED FOR: when sharing a live location, if the location is not
//    recognised, show a processing dialog with a cancel button. There was
//    nothing at all — sendLocation closes the menu and the picker and THEN
//    waits for a fix, so the app looked untouched for however long the phone
//    took, and the outcomes were a message appearing from nowhere or an alert
//    long after the user had given up. Worse, getCurrentPositionAsync does not
//    reliably fail when it cannot get a fix: indoors it can simply never
//    settle, and the existing fallback to a cached position only ran when it
//    THREW. So "forever" was a real outcome.
//
// 2. TWO LIVE SHARES IN ONE CHAT, one of them permanently stale. Only one
//    share can be active — `active` is a single slot — and starting a second
//    ended the first with `stopSharing({ silent: true })`, where silent means
//    the server is not told. The first message kept a liveUntil hours in the
//    future, so its card went on counting down and saying "Live location"
//    while nothing would ever update it again. From the outside that is
//    indistinguishable from the fault that took three builds to find.
//
// 3. A REGRESSION OF MINE. TILE_MARGIN — a ring of off-screen tiles so a drag
//    has map under it — was applied to every map including the one in a
//    message bubble, which is 224x132 and interactive={false}. At that size
//    the ring is not "more than double": the viewport needs two to four tiles
//    and the ring takes it to twelve or sixteen. Four to six times the images
//    and the bytes, on metered connections, to pre-fetch the surroundings of a
//    map with no gesture to reveal them — and for a live pin, re-laid-out
//    every few seconds as the centre moves.
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const NATIVE = path.join(__dirname, '..', 'native-app');
const SRC = path.join(NATIVE, 'src');
const TSC = path.join(NATIVE, 'node_modules', '.bin', 'tsc');
if (!fs.existsSync(TSC)) {
  console.log('  ! skipping location-wait tests (native-app deps not installed)');
  process.exit(0);
}
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'locwait-'));
execFileSync(TSC, [
  path.join(SRC, 'locationWait.ts'), path.join(SRC, 'geo.ts'),
  '--outDir', OUT, '--module', 'commonjs', '--target', 'es2019', '--skipLibCheck',
], { stdio: 'pipe' });
const W = require(path.join(OUT, 'locationWait.js'));
const G = require(path.join(OUT, 'geo.js'));

const chatSrc = fs.readFileSync(path.join(SRC, 'screens', 'ChatScreen.tsx'), 'utf8');
const mgrSrc = fs.readFileSync(path.join(SRC, 'locationManager.ts'), 'utf8');
const mapSrc = fs.readFileSync(path.join(SRC, 'components', 'TileMap.tsx'), 'utf8');
const dlgSrc = fs.readFileSync(path.join(SRC, 'components', 'LocatingDialog.tsx'), 'utf8');

const tests = [];
const test = (n, f) => tests.push({ n, f });
const code = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/^\s*\/\/.*$/gm, ' ')
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ');

/**
 * The body of a function declaration.
 *
 * The return type has to be stepped over, not just searched past: a signature
 * like `currentPosition(): Promise<{ lat: number }>` contains a brace, and
 * taking the first one after the parameters starts the "body" inside the type
 * annotation. That is how the first version of this read a few characters of
 * a type and reported the function as missing its contents.
 */
function fnBody(src, name) {
  const at = src.indexOf(`function ${name}(`);
  assert.ok(at >= 0, `${name} is not in the file`);
  // Step over the parameter list.
  let i = src.indexOf('(', at), paren = 0;
  for (; i < src.length; i++) {
    if (src[i] === '(') paren++;
    else if (src[i] === ')' && --paren === 0) { i++; break; }
  }
  // Then over any generic return type, so a brace inside it is not the body.
  let angle = 0, open = -1;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '<') angle++;
    else if (c === '>') angle = Math.max(0, angle - 1);
    else if (c === '{') {
      if (angle === 0) { open = i; break; }
      // A brace inside the annotation: skip to its close.
      let d = 0;
      for (; i < src.length; i++) {
        if (src[i] === '{') d++;
        else if (src[i] === '}' && --d === 0) break;
      }
    }
  }
  assert.ok(open >= 0, `${name} has no body`);
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(open, j + 1);
  }
  throw new Error(`${name} never closes`);
}

// ── 0. The files this reads are real code ───────────────────────────────────

test('the sources these assertions read actually parse', () => {
  // Everything below matches text. Text being present says nothing about the
  // file being valid — mutation proved it by replacing the dialog with
  // malformed JSX that still contained its name, and every assertion passed.
  // One parse closes that whole class.
  let parser;
  try {
    parser = require(path.join(NATIVE, 'node_modules', '@babel', 'parser'));
  } catch {
    console.log('      (babel parser unavailable — parse check skipped)');
    return;
  }
  for (const [name, src] of [
    ['screens/ChatScreen.tsx', chatSrc], ['locationManager.ts', mgrSrc],
    ['components/TileMap.tsx', mapSrc], ['components/LocatingDialog.tsx', dlgSrc],
  ]) {
    try {
      parser.parse(src, { sourceType: 'module', plugins: ['typescript', 'jsx'] });
    } catch (e) {
      throw new Error(`${name} does not parse: ${e.message}`);
    }
  }
});

// ── 1. The wait, and the way out of it ──────────────────────────────────────

test('ASKED FOR: there is a dialog, and it has a cancel', () => {
  assert.ok(/<LocatingDialog/.test(chatSrc), 'nothing is shown while the phone is being asked');
  assert.ok(/visible={acquiringAt !== null}/.test(chatSrc),
    'the dialog is not driven by whether a fix is actually being waited for');
  assert.ok(/onCancel=/.test(code(dlgSrc)) || /onCancel\s*[,}]/.test(code(dlgSrc)),
    'the dialog takes no cancel');
  assert.ok(/Cancel<\/Text>/.test(dlgSrc), 'there is no cancel button to press');
  // Android's back button must cancel, not dismiss the dialog and leave the
  // request running invisibly behind it — which is the state this replaces.
  assert.ok(/onRequestClose={onCancel}/.test(dlgSrc),
    'the back button dismisses the dialog without cancelling the wait');
});

test('…and only the branch that actually waits shows it', () => {
  // A pin placed by hand already has its answer; a spinner there would be a
  // lie, and a cancel button on it would do nothing.
  const body = code(fnBody(chatSrc, 'sendLocation'));
  assert.ok(/if \(!chosen\) \{/.test(body),
    'the wait is entered even when the user has already placed the pin');
  const guarded = body.slice(body.indexOf('if (!chosen) {'));
  assert.ok(/setAcquiringAt\(Date\.now\(\)\)/.test(guarded),
    'the dialog is never opened');
});

test('cancelling means the answer stops being wanted', () => {
  // The request cannot be cancelled — expo-location gives no handle — so the
  // only honest cancel is to stop listening. If a fix still posted a message
  // after Cancel, the button would be decoration.
  assert.ok(/fixAttempt\.current\+\+; setAcquiringAt\(null\)/.test(chatSrc),
    'cancel does not invalidate the attempt, so a late fix still posts a location');
  const body = code(fnBody(chatSrc, 'sendLocation'));
  assert.ok(/if \(!stillWanted\(attempt, fixAttempt\.current\)\) return;/.test(body),
    'a cancelled attempt still goes on to send');
});

test('an answer for a superseded attempt is dropped', () => {
  assert.strictEqual(W.stillWanted(3, 3), true, 'the live attempt was discarded');
  assert.strictEqual(W.stillWanted(2, 3), false, 'a stale attempt is still accepted');
  assert.strictEqual(W.stillWanted(4, 3), false);
});

test('…and an attempt that cannot be identified is never wanted', () => {
  // A missing ref reads as undefined and arithmetic on it gives NaN. Treating
  // that as "wanted" would post a location from a cancelled request.
  for (const bad of [NaN, undefined, null, '3', {}, Infinity]) {
    assert.strictEqual(W.stillWanted(bad, 3), false, `attempt ${String(bad)} was accepted`);
    assert.strictEqual(W.stillWanted(3, bad), false, `current ${String(bad)} accepted anything`);
  }
  assert.strictEqual(W.stillWanted(NaN, NaN), false, 'NaN matched itself');
});

test('the wording explains itself once the wait stops looking normal', () => {
  const first = W.waitMessage(0);
  const later = W.waitMessage(W.SLOW_AFTER_MS);
  assert.notStrictEqual(first, later, 'the message never changes, however long it takes');
  assert.ok(/indoors/i.test(later), 'the long wait is never explained');
  assert.strictEqual(W.waitMessage(W.SLOW_AFTER_MS - 1), first, 'it explains itself too early');
  // Nonsense is a wait that has only just started, not a crash.
  for (const bad of [NaN, -5, undefined, null, 'ages']) {
    assert.strictEqual(W.waitMessage(bad), first, `elapsed ${String(bad)} produced the wrong text`);
  }
});

test('the wait is bounded, so the dialog cannot spin for ever', () => {
  assert.strictEqual(W.fixTimedOut(W.FIX_TIMEOUT_MS), true, 'the wait never times out');
  assert.strictEqual(W.fixTimedOut(W.FIX_TIMEOUT_MS - 1), false, 'it gives up early');
  for (const bad of [NaN, undefined, null, 'long']) {
    assert.strictEqual(W.fixTimedOut(bad), false, `elapsed ${String(bad)} timed out the wait`);
  }
  // A bad limit falls back rather than timing out instantly or never.
  for (const bad of [0, -1, NaN]) {
    assert.strictEqual(W.fixTimedOut(W.FIX_TIMEOUT_MS, bad), true);
    assert.strictEqual(W.fixTimedOut(1, bad), false);
  }
  assert.ok(W.FIX_TIMEOUT_MS >= 10_000, 'gives up before a cold GPS fix is even likely');
  assert.ok(W.FIX_TIMEOUT_MS <= 60_000, 'a minute of spinner is not a bounded wait');
});

test('…and the request itself is raced against that bound', () => {
  // getCurrentPositionAsync can hang rather than throw, and the fallback to a
  // cached fix only ran on a throw. Without the race there is nothing to
  // recover from the hang.
  const body = code(fnBody(mgrSrc, 'currentPosition'));
  assert.ok(/Promise\.race\(/.test(body), 'a fix request that never settles waits for ever');
  assert.ok(/FIX_TIMEOUT_MS/.test(body), 'the race is not bounded by the shared limit');
  assert.ok(/getLastKnownPositionAsync/.test(body),
    'a timed-out request gives up entirely instead of falling back to a cached fix');
});

// ── 2. One live share at a time, and the other one properly closed ──────────

test('THE BUG: starting a live share CLOSES the previous one on the server', () => {
  const body = code(fnBody(mgrSrc, 'startSharing'));
  assert.ok(/await stopSharing\(\);/.test(body),
    'the previous share is ended without telling the server, so its card claims to be live for ever');
  assert.ok(!/await stopSharing\(\{ silent: true \}\)/.test(body),
    'the previous share is still ended silently');
});

test('…and the server closing one makes its card stop saying "live"', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const stop = /socket\.on\('location_stop'[\s\S]*?\n  \}\);/.exec(server);
  assert.ok(stop, 'the stop handler is gone');
  assert.ok(/liveUntil: Date\.now\(\)/.test(stop[0]),
    'stopping a share leaves its deadline in the future, so it still reads as live');
  assert.ok(/emit\('location_updated'/.test(stop[0]),
    'nobody is told the share ended, so every open chat keeps showing it as live');
});

test('a silent stop is still used where the server already knows', () => {
  // The server itself said the share had ended. Telling it again is pointless,
  // and this is the one caller for which silence is correct.
  assert.ok(/res\?\.ended\) \{ stopSharing\(\{ silent: true \}\)/.test(mgrSrc),
    'the one legitimate silent stop has been changed too');
});

// ── 3. The margin belongs to maps that can be panned ────────────────────────

test('THE REGRESSION: a map that cannot be panned asks for no margin', () => {
  assert.ok(/interactive \? TILE_MARGIN : 0/.test(mapSrc),
    'every map still pays for a ring of tiles, including the ones nobody can drag');
  const deps = /\[center\.lat, center\.lng, zoom, width, height, interactive\]/.test(mapSrc);
  assert.ok(deps, 'the tile list is not recomputed when interactivity changes');
});

test('…which is four to six times the tiles for a message bubble', () => {
  // The real numbers from the real card: 224x132.
  const W_ = 224, H_ = 132, Z = 15;
  const at = { lat: 35.6892, lng: 51.3890 };
  const bare = G.tilesForViewport(at, Z, W_, H_, 0).length;
  const ringed = G.tilesForViewport(at, Z, W_, H_, 1).length;
  assert.ok(bare <= 4, `a bubble needs ${bare} tiles, so this test is measuring the wrong thing`);
  assert.ok(ringed >= bare * 3,
    `the ring only takes ${bare} tiles to ${ringed} — the regression this records is not real`);
});

test('…while a map that CAN be panned still gets one', () => {
  const at = { lat: 35.6892, lng: 51.3890 };
  const withRing = G.tilesForViewport(at, 16, 400, 700);
  const without = G.tilesForViewport(at, 16, 400, 700, 0);
  assert.ok(withRing.length > without.length,
    'the picker lost its margin, so dragging pulls in grey again');
  assert.strictEqual(G.tilesForViewport(at, 16, 400, 700, undefined).length, withRing.length,
    'the default is no longer the margin');
});

test('a nonsense margin is treated as none, not as a crash', () => {
  const at = { lat: 35.6892, lng: 51.3890 };
  const none = G.tilesForViewport(at, 15, 224, 132, 0).length;
  for (const bad of [-1, NaN, Infinity, 'one', null]) {
    assert.strictEqual(G.tilesForViewport(at, 15, 224, 132, bad).length, none,
      `margin ${String(bad)} produced a different tile set`);
  }
  // A fractional margin is floored rather than producing fractional indices.
  for (const t of G.tilesForViewport(at, 15, 224, 132, 1.7)) {
    assert.ok(Number.isInteger(t.x) && Number.isInteger(t.y),
      `tile ${t.x},${t.y} is not a whole tile index`);
  }
});

test('the viewport is still covered with no margin at all', () => {
  // Removing the ring must not take the tiles the bubble actually shows.
  const W_ = 224, H_ = 132;
  const tiles = G.tilesForViewport({ lat: 35.6892, lng: 51.3890 }, 15, W_, H_, 0);
  for (const px of [0, W_ - 1]) {
    for (const py of [0, H_ - 1]) {
      const hit = tiles.some(t =>
        px >= t.left && px < t.left + G.TILE_SIZE && py >= t.top && py < t.top + G.TILE_SIZE);
      assert.ok(hit, `bubble pixel ${px},${py} has no tile`);
    }
  }
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
fs.rmSync(OUT, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
