// ── A photo you have to ask to see ─────────────────────────────────────────
//
// Asked for: a picture arrives blurred; one tap clears it, a second opens it;
// once cleared, that exact picture never asks again; and every picture has a
// 🙈 button to cover it back, after which it behaves as it did when it
// arrived. The button sits inside the picture, bottom corner — left for your
// own, right for theirs.
//
// The point is other people's eyes: a phone handed over, a shoulder on a bus,
// a chat opened in a room with other people in it. The failure that matters
// is a picture being visible when it should not be, so that is what most of
// these check.
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const NAT = path.join(ROOT, 'native-app');
const TSC = path.join(NAT, 'node_modules', '.bin', 'tsc');
if (!fs.existsSync(TSC)) {
  console.log('  ! skipping image-blur tests (native-app deps not installed)');
  process.exit(0);
}
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'iblur-'));
process.on('exit', () => fs.rmSync(OUT, { recursive: true, force: true }));
execFileSync(TSC, [path.join(NAT, 'src', 'imageBlur.ts'),
  '--outDir', OUT, '--module', 'commonjs', '--target', 'es2019', '--skipLibCheck'],
  { stdio: 'pipe' });
const B = require(path.join(OUT, 'imageBlur.js'));

const tests = [];
const test = (n, f) => tests.push({ n, f });

test("SOMEBODY ELSE'S PICTURE ARRIVES COVERED", () => {
  assert.strictEqual(B.startsBlurred({ mine: false, revealed: false }), true);
});

test('…and ONCE CLEARED it never asks again', () => {
  // "Next times that exact image doesn't have that mechanism."
  assert.strictEqual(B.startsBlurred({ mine: false, revealed: true }), false);
});

test('YOUR OWN PICTURE ARRIVES CLEAR', () => {
  // You chose the file seconds ago. Blurring it back at you protects nobody,
  // and the button still covers it whenever you want — which is the part
  // that serves the same purpose.
  assert.strictEqual(B.startsBlurred({ mine: true, revealed: false }), false);
});

test('A ONE-TIME MESSAGE KEEPS ITS OWN COVER', () => {
  // Two covers over one picture is a picture nobody can open.
  assert.strictEqual(B.startsBlurred({ mine: false, revealed: false, hiddenOneTime: true }), false);
  assert.strictEqual(B.showsButton({ hiddenOneTime: true }), false);
});

test('THE FIRST TAP ONLY CLEARS IT', () => {
  // Opening in the same motion would put the picture full screen before
  // anybody could decide they did not want it there — which is the feature,
  // defeated.
  assert.strictEqual(B.tapAction({ blurred: true }), 'reveal');
  assert.strictEqual(B.tapAction({ blurred: false }), 'open');
  assert.strictEqual(B.tapAction({}), 'open');
});

test('THE BUTTON IS 🙈, and it is in the right corner', () => {
  assert.strictEqual(B.BLUR_BUTTON, '🙈');
  assert.strictEqual(B.buttonCorner(true), 'left', 'my own pictures: bottom LEFT');
  assert.strictEqual(B.buttonCorner(false), 'right', "theirs: bottom RIGHT");
});

test('NO BUTTON ON A PICTURE THAT IS STILL GOING UP', () => {
  // There is nothing to hide yet, and that corner is where the progress is.
  assert.strictEqual(B.showsButton({ uploading: true }), false);
  assert.strictEqual(B.showsButton({}), true);
});

test('THE BLUR IS STRONG ENOUGH TO BE A BLUR', () => {
  // A token blur is worse than none: it looks deliberate while leaving a
  // face or a document readable.
  assert.ok(B.BLUR_RADIUS >= 15, `a radius of ${B.BLUR_RADIUS} is not a cover`);
});

// ── How it is drawn ────────────────────────────────────────────────────────

const strip = (f) => fs.readFileSync(f, 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
const IMG = strip(path.join(NAT, 'src', 'components', 'BlurredImage.tsx'));
const GRID = strip(path.join(NAT, 'src', 'components', 'GalleryGrid.tsx'));

test('THE PICTURE ITSELF IS BLURRED, not covered by something', () => {
  // An overlay can draw a frame late, miss the corners of a rounded bubble,
  // or be absent from a screenshot taken at the wrong moment. Blurring the
  // image means the sharp picture is never on screen at all.
  assert.ok(/blurRadius=\{blurred \? BLUR_RADIUS : 0\}/.test(IMG),
    'the blur is not applied to the image');
  const spinner = strip(path.join(NAT, 'src', 'components', 'ImageWithSpinner.tsx'));
  assert.ok(/blurRadius=\{blurRadius\}/.test(spinner), 'the blur never reaches the image');
});

test('THE BUTTON IS NOT INSIDE THE TAP TARGET', () => {
  // Otherwise covering a picture would also clear or open it.
  const press = /onPress=\{\(\) => \{[\s\S]*?tapAction\([\s\S]*?\}\}/.exec(IMG);
  assert.ok(press, 'could not find the picture tap handler');
  assert.ok(!/BLUR_BUTTON/.test(press[0]), 'the button is inside the tap handler');
  assert.ok(/position: 'absolute', bottom: 8/.test(IMG), 'the button is not pinned to the corner');
});

test('A GALLERY IS COVERED AS ONE, with one button', () => {
  // The photos arrived together and are looked at together. Covering them
  // individually means several buttons on one bubble and a tap that clears a
  // corner of a picture.
  assert.ok(/blurRadius=\{blurred \? BLUR_RADIUS : 0\}/.test(GRID), 'gallery tiles are not blurred');
  assert.ok(/blurred \? onToggleBlur\?\.\(\) : onOpen\(idx\)/.test(GRID),
    'a tap on a covered gallery opens a photo instead of clearing it');
  // Counting USES, not mentions: the import line is not a button, and
  // counting it made the first version of this assertion fail against
  // correct code.
  const buttons = (GRID.match(/\{BLUR_BUTTON\}/g) || []).length;
  assert.strictEqual(buttons, 1, `the mosaic has ${buttons} buttons; it should have one`);
});

test('A GALLERY IS NOT HALF-COVERED', () => {
  // Covered while ANY of its photos is still unseen.
  const chat = strip(path.join(NAT, 'src', 'screens', 'ChatScreen.tsx'));
  assert.ok(/keys\.every\(k => blurStore\.isRevealed\(k\)\)/.test(chat),
    'a gallery clears as soon as one of its photos has been seen');
});

test('CLEARING A PICTURE REDRAWS THE ROW SHOWING IT', () => {
  // The store lives outside React. Without this the picture stays blurred
  // until something else happens to redraw the list.
  const chat = strip(path.join(NAT, 'src', 'screens', 'ChatScreen.tsx'));
  assert.ok(/blurStore\.subscribe\(/.test(chat), 'the screen never hears about a change');
  const extra = /const rowExtraData = useMemo\([\s\S]*?\n  \);/.exec(chat);
  assert.ok(extra && /blurTick/.test(extra[0]),
    'blur changes are not in extraData, so rows will not redraw');
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
