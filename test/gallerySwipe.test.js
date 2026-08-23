// Closing a photo in the gallery.
//
// Two reports, both about the same gesture:
//
//   "Sometimes on swiping down to close an image it acts like a swipe right
//    and shows the previous image, and then the close happens."
//
//   "When swiping the image down to close it in the gallery, for one instant
//    you see the chat and then the gallery."
//
// The first is upstream: react-native-awesome-gallery decides whether a pan is
// vertical or horizontal ONCE, at touch-down, from velocity alone — and a
// swipe that starts gently has almost no velocity in either axis, so the
// decision is a coin toss between "close this" and "go back one photo". The
// library is patched; this checks the patch is present and says what it does.
//
// The second was ours: two Android modal windows swapping places.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const NAT = path.join(__dirname, '..', 'native-app');
const LIB = path.join(NAT, 'node_modules', 'react-native-awesome-gallery');
const PATCH = path.join(NAT, 'patches', 'react-native-awesome-gallery+0.4.3.patch');

const tests = [];
const test = (n, f) => tests.push({ n, f });

test('THE FIX IS RECORDED: the patch file exists and survives npm install', () => {
  // node_modules is not committed, so an edit made only there is gone the
  // moment CI installs. patch-package re-applies it from this file.
  assert.ok(fs.existsSync(PATCH), 'the gallery patch is not committed — CI would build without it');
  const pkg = JSON.parse(fs.readFileSync(path.join(NAT, 'package.json'), 'utf8'));
  assert.strictEqual(pkg.scripts?.postinstall, 'patch-package',
    'nothing re-applies the patch after an install');
  assert.ok(pkg.devDependencies?.['patch-package'], 'patch-package is not a dependency');
});

test('the gallery version is PINNED, so the patch cannot silently stop applying', () => {
  // With a caret range, a 0.4.4 published tomorrow installs instead and
  // patch-package refuses the patch — failing the build if we are lucky, and
  // shipping without the fix if the failure is tolerated.
  const pkg = JSON.parse(fs.readFileSync(path.join(NAT, 'package.json'), 'utf8'));
  assert.strictEqual(pkg.dependencies['react-native-awesome-gallery'], '0.4.3',
    'the patched library is on a floating version range');
});

test('the patch is for the version actually installed', () => {
  // A patch naming a version that is no longer there fails the install loudly,
  // but a version bump that silently drops the fix is worse.
  const installed = JSON.parse(fs.readFileSync(path.join(LIB, 'package.json'), 'utf8')).version;
  assert.ok(PATCH.includes(`+${installed}.patch`),
    `the patch is for a different version than the installed ${installed}`);
});

test('THE BUG: swipe direction is decided by movement, not by initial velocity', () => {
  const patch = fs.readFileSync(PATCH, 'utf8');
  assert.ok(/directionSettled/.test(patch), 'the patch no longer settles the direction');
  assert.ok(/isVertical\.value = ay > ax;/.test(patch),
    'the direction is not taken from the actual travel');
});

test('…and it is applied to the files the app really loads', () => {
  // The package ships three copies: src (nobody bundles it), lib/module and
  // lib/commonjs. Patching only src fixes nothing at all.
  for (const rel of ['lib/module/index.js', 'lib/commonjs/index.js']) {
    const src = fs.readFileSync(path.join(LIB, rel), 'utf8');
    assert.ok(src.includes('directionSettled'), `${rel} is unpatched — this is what actually runs`);
  }
});

test('the decision is re-made only before the pan has really begun', () => {
  // Flipping direction halfway through a gesture would tear the image sideways
  // and then drop it. Eight pixels is before anything has visibly moved.
  const src = fs.readFileSync(path.join(LIB, 'lib/module/index.js'), 'utf8');
  assert.ok(/if \(!directionSettled\.value && scale\.value === 1\)/.test(src),
    'the direction can be re-decided mid-gesture, or while zoomed in');
  assert.ok(/ax > 8 \|\| ay > 8/.test(src), 'there is no travel threshold');
  assert.ok(/directionSettled\.value = false;/.test(src),
    'the flag is never reset, so only the first swipe of the session is fixed');
});

test('a zoomed-in image still pans in both directions', () => {
  // While zoomed, dragging moves the picture inside the frame; deciding a
  // direction there would lock it to one axis.
  const src = fs.readFileSync(path.join(LIB, 'lib/module/index.js'), 'utf8');
  const hunk = src.slice(src.indexOf('!directionSettled.value'), src.indexOf('!directionSettled.value') + 260);
  assert.ok(hunk.includes('scale.value === 1'), 'the new rule also applies while zoomed in');
});

// ── The flash of chat ───────────────────────────────────────────────────────

const screen = fs.readFileSync(path.join(NAT, 'src', 'screens', 'ChatScreen.tsx'), 'utf8');

test('THE OTHER BUG: the grid is not closed when a photo opens on top of it', () => {
  // It used to be. Two Android modal windows then swap: the photo's window is
  // torn down before the grid's is created, and in between the chat behind
  // them both is on screen for a frame.
  const open = screen.slice(screen.indexOf('onOpenImage={(i, all) => {'),
    screen.indexOf('onAction={onMediaAction}'));
  assert.ok(open.length > 0, 'onOpenImage is gone — this check would be vacuous');
  assert.ok(!open.includes('setShowMedia(false)'),
    'opening a photo still closes the grid underneath it, which is the flash of chat');
  assert.ok(open.includes('openViewer('), 'the viewer is not opened at all');
});

test('and closing the photo does not re-open a grid that never closed', () => {
  const close = screen.slice(screen.indexOf('function closeViewer()'),
    screen.indexOf('const [replyTo, setReplyTo]'));
  assert.ok(close.length > 0, 'closeViewer is gone — this check would be vacuous');
  assert.ok(!close.includes('setShowMedia(true)'), 'the grid is opened again, so the windows still swap');
  // The grid still has to be told which photo to scroll back to.
  assert.ok(close.includes('setMediaFocusIndex('), 'the grid no longer returns to the photo you were on');
  assert.ok(close.includes('setMediaOpenId('), 'the grid is not told to restore its position');
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
