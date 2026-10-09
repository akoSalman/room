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

test('…BUT THE BUTTON STILL COVERS IT', () => {
  // Reported as "the monkey button doesn't work on my sent images", and it
  // did not: `mine` was answered before anything else, so your own pictures
  // could not be covered at all. The button changed a stored state that this
  // rule then ignored, which looks exactly like a dead button.
  //
  // This is the reason the feature exists on your own photos — handing
  // somebody your phone to show them one thing, with the last thing you sent
  // sitting above it.
  assert.strictEqual(B.startsBlurred({ mine: true, hidden: true }), true);
});

test('AN EXPLICIT COVER BEATS HAVING BEEN CLEARED', () => {
  // Otherwise the button is dead on anything already looked at — which is
  // every picture, a moment after it arrives.
  assert.strictEqual(B.startsBlurred({ mine: false, revealed: true, hidden: true }), true);
  assert.strictEqual(B.startsBlurred({ mine: true, revealed: true, hidden: true }), true);
});

test('A ONE-TIME MESSAGE STILL OVERRIDES AN EXPLICIT COVER', () => {
  // Order matters: hiddenOneTime is asked first, so a one-time photo under
  // its own cover cannot also get this one and become unopenable.
  assert.strictEqual(B.startsBlurred({ hidden: true, hiddenOneTime: true }), false);
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

test('THE APP DRAWING CODE ACTUALLY ASKS ABOUT THE COVER', () => {
  // The store and the rules agree (below). This is the part that was wrong
  // in a way no rule test could see: a picture whose drawing code never
  // mentions `hidden` is a picture whose button is dead, whatever the store
  // remembers.
  const call = /startsBlurred\(\{([\s\S]*?)\}\)/.exec(IMG);
  assert.ok(call, 'BlurredImage does not consult the rules');
  assert.ok(/hidden:\s*blurStore\.isHidden\(key\)/.test(call[1]),
    'the app never tells the rules a photo was deliberately covered');

  const chat = strip(path.join(NAT, 'src', 'screens', 'ChatScreen.tsx'));
  const gal = /const galleryBlurred = startsBlurred\(\{([\s\S]*?)\}\);/.exec(chat);
  assert.ok(gal, 'the mosaic does not consult the rules');
  assert.ok(/hidden:\s*keys\.some\(k => blurStore\.isHidden\(k\)\)/.test(gal[1]),
    'covering a mosaic is never told to the rules');
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

// ── The app's memory ───────────────────────────────────────────────────────
//
// Run for real against a fake AsyncStorage. The reported bug lived here as
// much as in the rules: the store knew only "cleared", and your own pictures
// were never in that list, so covering one removed it from a list it was not
// in and wrote nothing anywhere.

const NM = path.join(OUT, 'node_modules');
fs.mkdirSync(path.join(NM, '@react-native-async-storage', 'async-storage'), { recursive: true });
fs.writeFileSync(
  path.join(NM, '@react-native-async-storage', 'async-storage', 'package.json'),
  JSON.stringify({ name: '@react-native-async-storage/async-storage', main: 'index.js' }));
fs.writeFileSync(
  path.join(NM, '@react-native-async-storage', 'async-storage', 'index.js'), `
  const mem = new Map();
  // __esModule, or TypeScript's interop helper wraps this again and every
  // call lands on undefined.
  module.exports = { __esModule: true, __mem: mem, default: {
    getItem: async k => (mem.has(k) ? mem.get(k) : null),
    setItem: async (k, v) => { mem.set(k, v); },
  } };
`);
execFileSync(TSC, [path.join(NAT, 'src', 'blurStore.ts'),
  '--outDir', OUT, '--module', 'commonjs', '--target', 'es2019', '--skipLibCheck'],
  { stdio: 'pipe' });
const MEM = require(path.join(NM, '@react-native-async-storage', 'async-storage')).__mem;
const S = require(path.join(OUT, 'blurStore.js'));
const KEY = 'revealedImages-v1';
// setItem is not awaited by the store — it is fire-and-forget, deliberately,
// so a slow disk never delays the picture being covered on screen.
const settle = () => new Promise(r => setImmediate(r));

test('COVERING YOUR OWN PICTURE IS RECORDED', () => {
  S._reset(); MEM.clear();
  // Never revealed — this is the case that wrote nothing at all.
  S.hide('mine.jpg');
  assert.strictEqual(S.isHidden('mine.jpg'), true,
    'the store forgot immediately, so the button does nothing');
  assert.strictEqual(B.startsBlurred({ mine: true, revealed: S.isRevealed('mine.jpg'), hidden: S.isHidden('mine.jpg') }), true,
    'your own picture is still bare after you covered it');
});

test('…AND SURVIVES CLOSING THE APP', async () => {
  S._reset(); MEM.clear();
  S.hide('mine.jpg');
  await settle();
  assert.ok(MEM.get(KEY), 'nothing was written to storage');
  // A fresh start, reading only what was actually written.
  S._reset();
  await S.load();
  assert.strictEqual(S.isHidden('mine.jpg'), true, 'the cover is forgotten on restart');
});

test('CLEARING IT AGAIN UNDOES THE COVER', async () => {
  S._reset(); MEM.clear();
  S.hide('a.jpg');
  S.reveal('a.jpg');
  assert.strictEqual(S.isHidden('a.jpg'), false, 'a covered picture cannot be cleared again');
  assert.strictEqual(S.isRevealed('a.jpg'), true);
  await settle();
  S._reset();
  await S.load();
  assert.strictEqual(S.isHidden('a.jpg'), false, 'the undo is forgotten on restart');
  assert.strictEqual(S.isRevealed('a.jpg'), true);
});

test('COVERING A PICTURE ALREADY CLEARED TAKES IT OFF THE CLEARED LIST', () => {
  S._reset(); MEM.clear();
  S.reveal('b.jpg');
  S.hide('b.jpg');
  assert.strictEqual(S.isRevealed('b.jpg'), false);
  assert.strictEqual(S.isHidden('b.jpg'), true);
});

test('THE APP STILL READS THE OLDER SHAPE', async () => {
  // Shipped once as a bare array. Losing it makes every photo ask again.
  S._reset(); MEM.clear();
  MEM.set(KEY, JSON.stringify(['old.jpg']));
  await S.load();
  assert.strictEqual(S.isRevealed('old.jpg'), true,
    'photos cleared before the update ask again');
  assert.strictEqual(S.isHidden('old.jpg'), false);
});

test('COVERING TELLS THE SCREEN', () => {
  // Without this the picture stays bare until something else happens to
  // redraw the row, which looks like the button not working.
  S._reset(); MEM.clear();
  let n = 0;
  const off = S.subscribe(() => { n++; });
  S.hide('c.jpg');
  assert.ok(n > 0, 'covering a photo does not redraw the row showing it');
  off();
  const was = n;
  S.hide('d.jpg');
  assert.strictEqual(n, was, 'unsubscribe does not unsubscribe');
});

test('NEITHER LIST GROWS FOR EVER', () => {
  // Read on every render of every photo, on phones that are not fast.
  S._reset(); MEM.clear();
  for (let i = 0; i < S.MAX_REMEMBERED + 50; i++) S.hide('h' + i + '.jpg');
  assert.strictEqual(S.isHidden('h0.jpg'), false, 'the covered list is unbounded');
  assert.strictEqual(S.isHidden('h' + (S.MAX_REMEMBERED + 49) + '.jpg'), true,
    'the newest cover was dropped instead of the oldest');
});

// ── The web's copy ─────────────────────────────────────────────────────────
//
// Mirrored from the app and compared rule by rule. A photo that is covered on
// one platform and bare on the other is a bug in whichever is behind, and
// this is the kind of feature where "behind" means somebody's picture was on
// display when they thought it was not.

const WEB = require(path.join(ROOT, 'public', 'js', 'imageBlur.js'));

test('BOTH PLATFORMS ANSWER THE SAME, over every combination', () => {
  for (const mine of [true, false]) {
    for (const revealed of [true, false]) {
      for (const hidden of [true, false]) {
        for (const hiddenOneTime of [true, false]) {
          const args = { mine, revealed, hidden, hiddenOneTime };
          assert.strictEqual(WEB.startsBlurred(args), B.startsBlurred(args),
            `startsBlurred disagrees for ${JSON.stringify(args)}`);
        }
      }
    }
  }
  // Not just agreement — agreement on something. Two copies that both always
  // said false would pass the loop above.
  assert.strictEqual(WEB.startsBlurred({ mine: true, hidden: true }), true,
    'the web copy cannot cover your own picture either');
  for (const blurred of [true, false]) {
    assert.strictEqual(WEB.tapAction({ blurred }), B.tapAction({ blurred }));
  }
  for (const mine of [true, false]) {
    assert.strictEqual(WEB.buttonCorner(mine), B.buttonCorner(mine));
  }
  for (const uploading of [true, false]) {
    for (const hiddenOneTime of [true, false]) {
      assert.strictEqual(WEB.showsButton({ uploading, hiddenOneTime }),
        B.showsButton({ uploading, hiddenOneTime }));
    }
  }
  assert.strictEqual(WEB.BLUR_BUTTON, B.BLUR_BUTTON);
  assert.strictEqual(WEB.BLUR_RADIUS, B.BLUR_RADIUS);
});

test('THE WEB KEYS A PHOTO THE SAME WAY THE APP DOES', () => {
  // Media urls are signed and re-signed, so the url is not an identity. If
  // the two disagreed, clearing a photo on one would not carry to the other
  // and the same picture would ask twice.
  const { execFileSync: run } = require('child_process');
  const vOut = fs.mkdtempSync(path.join(os.tmpdir(), 'vlist-'));
  run(TSC, [path.join(NAT, 'src', 'viewerList.ts'),
    '--outDir', vOut, '--module', 'commonjs', '--target', 'es2019', '--skipLibCheck'],
    { stdio: 'pipe' });
  const V = require(path.join(vOut, 'viewerList.js'));
  for (const url of ['/uploads/1-2.jpg?e=9&s=ab', '/uploads/1-2.jpg',
      'https://x/uploads/a%20b.png', '', 'nope']) {
    assert.strictEqual(WEB.photoKey(url), V.photoKey(url), `photoKey disagrees for "${url}"`);
  }
  fs.rmSync(vOut, { recursive: true, force: true });
});

// ── And the web actually draws it ──────────────────────────────────────────

const APP_SRC = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');
const APP = APP_SRC
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

/**
 * The web's memory, lifted out of app.js and run for real.
 *
 * app.js is a page: it cannot be required. So the store's own lines are cut
 * out of it and executed against a fake localStorage. That keeps this a test
 * of the shipped code rather than of a copy written in the test — the bug
 * here was precisely a store that recorded nothing, which no amount of
 * grepping for a function name would have caught.
 */
function buildWebStore(seed) {
  const from = APP_SRC.indexOf("var REVEALED_KEY = 'revealedImages-v1';");
  const to = APP_SRC.indexOf('function wrapBlurrable');
  assert.ok(from > 0 && to > from, 'could not find the web blur store in app.js');
  const src = APP_SRC.slice(from, to);

  const mem = new Map();
  if (seed != null) mem.set('revealedImages-v1', seed);
  const localStorage = {
    getItem: k => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => { mem.set(k, v); },
  };
  const make = new Function('localStorage', 'ImageBlur', src + `
    return {
      isRevealed, isHiddenImage, revealImage, hideImage,
      raw: () => localStorage.getItem('revealedImages-v1'),
      // The same composition applyBlurTo performs, over the real store.
      blurredFor: (o) => ImageBlur.startsBlurred({
        mine: o.mine, hiddenOneTime: o.hiddenOneTime,
        revealed: o.keys.length > 0 && o.keys.every(isRevealed),
        hidden: o.keys.some(isHiddenImage),
      }),
    };
  `);
  return make(localStorage, WEB);
}
const CSS = fs.readFileSync(path.join(ROOT, 'public', 'css', 'style.css'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

test('THE WEB COVERS BOTH A PHOTO AND A GALLERY', () => {
  assert.ok(/wrapBlurrable\(\[img\]/.test(APP), 'a single photo is not covered');
  assert.ok(/wrapGalleryBlur\(galleryWrap, galleryImgs/.test(APP), 'a gallery is not covered');
});

test('THE WEB BLURS THE IMAGE, not a panel over it', () => {
  assert.ok(/\.blurrable img\.blurred \{[^}]*filter: blur\(/.test(CSS),
    'the blur is not a filter on the image');
  // The enlargement matters: a blur leaves soft edges, and without it the
  // outermost pixels of the picture stay readable.
  assert.ok(/\.blurrable img\.blurred \{[^}]*scale\(/.test(CSS),
    'the blurred image is not scaled, so its edges stay legible');
  assert.ok(/\.blurrable \{[^}]*overflow: hidden/.test(CSS),
    'the enlargement spills out of the bubble');
});

test('THE WEB BUTTON IS 🙈 AND IN THE RIGHT CORNER', () => {
  assert.ok(/\.blur-btn\.left \{ left: 8px; \}/.test(CSS), 'no left corner rule');
  assert.ok(/\.blur-btn\.right \{ right: 8px; \}/.test(CSS), 'no right corner rule');
  assert.ok(/ImageBlur\.buttonCorner\(opts\.mine\)/.test(APP), 'the corner is not chosen by the rule');
  assert.ok(/ImageBlur\.BLUR_BUTTON/.test(APP), 'the button does not use the shared character');
});

test('THE WEB BUTTON DOES NOT ALSO OPEN THE PHOTO', () => {
  // It sits over the picture, so without stopping the event a click would
  // cover the photo and open it in the same motion.
  // Scoped to applyBlurTo. `btn.onclick` appears five times in this file and
  // an unanchored match found an unrelated one that happens to stop the
  // event — so the first version of this test passed against a broken button.
  const fn = /function applyBlurTo\([\s\S]*?\n\}/.exec(APP);
  assert.ok(fn, 'could not find applyBlurTo');
  const btn = /btn\.onclick = \(e\) => \{([\s\S]*?)\n    \};/.exec(fn[0]);
  assert.ok(btn, 'could not find the blur button handler');
  assert.ok(/stopPropagation/.test(btn[1]), 'covering a photo also opens it');
  assert.ok(/preventDefault/.test(btn[1]), 'the button does not stop the default action');
});

test('THE WEB REMEMBERS, and does not grow for ever', () => {
  assert.ok(/localStorage\.setItem\(REVEALED_KEY/.test(APP),
    'clearing a photo is forgotten on reload');
  assert.ok(/MAX_REVEALED/.test(APP), 'the list of cleared photos is unbounded');
});

test('THE WEB REMEMBERS AN EXPLICIT COVER TOO', () => {
  // Run as code rather than grepped: the bug being fixed was a store that
  // only knew "cleared", so hiding your own photo wrote nothing anywhere.
  const web = buildWebStore();
  web.hideImage('mine.jpg');
  assert.strictEqual(web.isHiddenImage('mine.jpg'), true,
    'covering your own photo records nothing, so the button does nothing');
  assert.strictEqual(web.blurredFor({ mine: true, keys: ['mine.jpg'] }), true,
    'your own photo is still bare after you covered it');

  // And it survives a reload, from what was actually written to storage.
  const again = buildWebStore(web.raw());
  assert.strictEqual(again.isHiddenImage('mine.jpg'), true,
    'the cover is forgotten on reload');

  // Reversible: clearing it again undoes the cover.
  web.revealImage('mine.jpg');
  assert.strictEqual(web.isHiddenImage('mine.jpg'), false);
  assert.strictEqual(web.blurredFor({ mine: true, keys: ['mine.jpg'] }), false);
});

test('THE WEB STILL READS THE OLDER SHAPE', () => {
  // Shipped once as a bare array. Anybody who used that build has cleared
  // photos recorded that way, and losing them makes every one ask again.
  const web = buildWebStore(JSON.stringify(['theirs.jpg']));
  assert.strictEqual(web.isRevealed('theirs.jpg'), true,
    'photos cleared before the update ask again');
  assert.strictEqual(web.blurredFor({ mine: false, keys: ['theirs.jpg'] }), false);
});

test('THE WEB DRAWING CODE ACTUALLY ASKS ABOUT THE COVER', () => {
  // The composition above proves the rule and the store agree. This proves
  // the code that paints the picture is the thing doing that composition —
  // a store nobody reads is the same as no store.
  const fn = /function applyBlurTo\(wrap, imgs, opts\) \{([\s\S]*?)\n\}/.exec(APP);
  assert.ok(fn, 'could not find applyBlurTo');
  const call = /ImageBlur\.startsBlurred\(\{([\s\S]*?)\}\)/.exec(fn[1]);
  assert.ok(call, 'applyBlurTo does not consult the rules');
  assert.ok(/hidden:\s*keys\.some\(isHiddenImage\)/.test(call[1]),
    'the web never tells the rules a photo was deliberately covered');
});

test('THE COVER WRAPPER DOES NOT TAKE THE PHOTO\'S SIZE WITH IT', () => {
  // Reported as: images on the web are stretched vertically.
  //
  // wrapBlurrable puts a <div> between the bubble and the photo, and the
  // rule that sizes a photo is a DIRECT-CHILD selector. It stopped matching
  // the moment the cover shipped, so every single photo lost its width and
  // its 340px ceiling at once. A direct-child selector plus a new wrapper
  // fails silently and completely, and nothing in the suite noticed.
  //
  // So the invariant is checked rather than the spelling: whatever sizes a
  // bare photo in a bubble must also size a wrapped one.
  const fn = /function wrapBlurrable\(imgs, opts\) \{([\s\S]*?)\n\}/.exec(APP_SRC);
  assert.ok(fn, 'could not find wrapBlurrable');
  const cls = /wrap\.className = '([^']+)'/.exec(fn[1]);
  assert.ok(cls, 'the cover wrapper has no class to write a rule against');
  const wrapped = `.msg-bubble > .${cls[1]} > img`;

  // Every rule that names the bare photo must name the wrapped one too.
  const blocks = CSS.split('}');
  const sizing = blocks.filter(b => /\.msg-bubble\s*>\s*img\b/.test(b.split('{')[0] || ''));
  assert.ok(sizing.length, 'nothing sizes a photo in a bubble any more');
  sizing.forEach(b => {
    const sel = b.split('{')[0];
    assert.ok(sel.includes(wrapped),
      `a rule sizes a bare photo but not a covered one, so covered photos lose it:\n${sel.trim()}`);
  });

  // And the properties that were lost are actually in there.
  const main = sizing.find(b => /max-height/.test(b)) || '';
  assert.ok(/width:\s*var\(--media-w\)/.test(main), 'photos have no width');
  assert.ok(/max-height:\s*\d+px/.test(main), 'photos have no ceiling, so a tall one fills the screen');
  assert.ok(/object-fit:\s*cover/.test(main), 'photos are not cropped to shape');
});

test('THE RULES ARE LOADED BEFORE THE PAGE USES THEM', () => {
  const blurAt = HTML.indexOf('/js/imageBlur.js');
  const appAt = HTML.indexOf('/js/app.js');
  assert.ok(blurAt > 0, 'js/imageBlur.js is never loaded, so ImageBlur is undefined');
  assert.ok(blurAt < appAt, 'the rules load after the code that calls them');
});

(async () => {
  let passed = 0, failed = 0;
  for (const { n, f } of tests) {
    try { await f(); console.log(`  ✓ ${n}`); passed++; }
    catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
