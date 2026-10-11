// ── Offering the screenshot just taken ──────────────────────────────────────
//
// Asked for as: after taking a screenshot, paste it without opening the
// gallery.
//
// The app could already paste an image two ways — the keyboard's image key and
// the 📋 button — and neither could help, because A SCREENSHOT IS NEVER ON THE
// CLIPBOARD. Android writes the file and shows a floating preview; unless the
// person taps "Copy" there, nothing is copied. So both routes correctly
// reported nothing to paste and the gallery was the only way in.
//
// What is tested here is the deciding, because the cost of getting it wrong is
// not a missing feature: the offer puts a THUMBNAIL of the newest screenshot
// on screen, and screenshots are very often of something private.
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Compiled and RUN, not grepped: a test that looks for the text of a rule
// passes whatever that rule actually decides.
const NAT = path.join(__dirname, '..', 'native-app');
const TSC = path.join(NAT, 'node_modules', '.bin', 'tsc');
if (!fs.existsSync(TSC)) {
  console.log('  ! skipping screenshot tests (native-app deps not installed)');
  process.exit(0);
}
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'screenshots-'));
execFileSync(TSC, [path.join(NAT, 'src', 'screenshots.ts'),
  '--outDir', OUT, '--module', 'commonjs', '--target', 'es2019', '--skipLibCheck'], { stdio: 'pipe' });
const { isScreenshotAlbum, isScreenshotName, pickShot, FRESH_MS } = require(path.join(OUT, 'screenshots.js'));

const tests = [];
const test = (n, f) => tests.push({ n, f });

const NOW = Date.UTC(2026, 9, 11, 12, 0, 0);
const shot = (id, agoMs, filename = 'Screenshot_20261011-120000.png') =>
  ({ id, filename, creationTime: NOW - agoMs });

test('THE ALBUM IS WHAT IDENTIFIES THEM, because the filenames are translated', () => {
  // This is the whole reason the album is consulted first. Android builds the
  // screenshot's FILENAME from a localized string, so on the Persian and
  // Kurdish phones this app is for, the file is not called "Screenshot"
  // anything. The album is the FOLDER name on disk, which is not translated.
  assert.ok(isScreenshotAlbum('Screenshots'), 'the ordinary album is not recognised');
  assert.ok(isScreenshotAlbum('screenshots'), 'the match is case-sensitive');
  assert.ok(isScreenshotAlbum('Screenshot'), 'the singular some Xiaomi builds use is missed');
  assert.ok(isScreenshotAlbum('  Screenshots  '), 'a padded title is not trimmed');
});

test('…and somebody\'s own album is not mistaken for the system\'s', () => {
  // Anchored, not a substring search: this one would put a thumbnail of a
  // private picture on screen out of an album the person made themselves.
  assert.ok(!isScreenshotAlbum('Screenshots to send mum'), 'a personal album is treated as the system one');
  assert.ok(!isScreenshotAlbum('Old screenshots'), 'any album with the word in it matches');
  assert.ok(!isScreenshotAlbum('Camera'), 'the camera roll is treated as screenshots');
  assert.ok(!isScreenshotAlbum(''), 'an album with no title matches');
  assert.ok(!isScreenshotAlbum(undefined), 'a missing title throws or matches');
});

test('THE FILENAME FALLBACK KNOWS EVERY VENDOR\'S SHAPE', () => {
  // Only reached when there is no album to ask. Each of these is a real
  // on-disk name from a different Android maker.
  for (const n of [
    'Screenshot_20261011-120000.png',            // AOSP, Pixel, OnePlus
    'Screenshot_20261011-120000_Chrome.png',     // AOSP, with the app's name
    'Screenshot_20261011_120000.jpg',            // Samsung, Huawei
    'Screenshot_2026-10-11-12-00-00-000.png',    // Xiaomi
    'screenshot_20261011_120000.png',            // lower case
    'Screen-20261011-120000.png',                // a few others
  ]) {
    assert.ok(isScreenshotName(n), `not recognised as a screenshot: ${n}`);
  }
});

test('…and does not sweep up an ordinary picture', () => {
  // The fallback scans a page of MIXED photos, so anything it wrongly accepts
  // is somebody's private photo offered up for sending.
  assert.ok(!isScreenshotName('IMG_20261011_120000.jpg'), 'a camera photo is offered as a screenshot');
  assert.ok(!isScreenshotName('screenshot-tips.png'),
    'a picture saved off a web page is offered — it has the word but no timestamp');
  assert.ok(!isScreenshotName('my screenshots.png'),
    'the word is matched anywhere in the name rather than at the start');
  // The case the anchor exists for, and the one that nearly slipped through:
  // marketing and product images are named exactly like this, they are
  // downloaded into the same gallery this sifts, and the dimensions give them
  // all the digits a timestamp would.
  assert.ok(!isScreenshotName('iphone-screenshot_1920x1080.png'),
    'a downloaded picture with the word in the MIDDLE of its name is offered as a screenshot');
  assert.ok(!isScreenshotName('app-screenshot-20261011.jpg'),
    'the word is accepted anywhere, so a downloaded image is offered');
  assert.ok(!isScreenshotName('PXL_20261011_120000.jpg'), 'a Pixel camera photo is offered');
  assert.ok(!isScreenshotName(''), 'a nameless file is offered');
  assert.ok(!isScreenshotName(undefined), 'a missing name throws or matches');
});

test('THE OFFER IS THE NEWEST ONE, not the first that came back', () => {
  // With an album the library is asked newest-first, but the filename
  // fallback sifts a page of mixed photos and the order there means nothing.
  const got = pickShot({ shots: [shot('a', 60000), shot('c', 1000), shot('b', 30000)], now: NOW });
  assert.strictEqual(got && got.id, 'c', 'an older screenshot is offered over a newer one');
});

test('A STALE SCREENSHOT IS NOT OFFERED', () => {
  // Opening the chat an hour later must not put yesterday's screenshot on
  // screen. That failure is what would make this feel like surveillance.
  assert.strictEqual(pickShot({ shots: [shot('a', FRESH_MS + 1)], now: NOW }), null,
    'a screenshot older than the freshness window is offered');
  assert.ok(pickShot({ shots: [shot('a', FRESH_MS - 1)], now: NOW }),
    'one inside the window is not offered');
});

test('…nor one dated in the FUTURE', () => {
  // A phone whose clock is wrong, or an asset dated ahead of now, would
  // otherwise pass the age test for ever and sit there permanently.
  assert.strictEqual(pickShot({ shots: [shot('a', -5000)], now: NOW }), null,
    'a screenshot dated in the future is offered');
});

test('DISMISSING ONE MAKES IT STAY DISMISSED', () => {
  // The check runs again every time the app comes to the front, so without
  // this the chip would reappear and there would be no way to be rid of it.
  const shots = [shot('a', 1000)];
  assert.ok(pickShot({ shots, now: NOW }), 'it was not offered in the first place');
  assert.strictEqual(pickShot({ shots, now: NOW, handled: ['a'] }), null,
    'a dismissed or already-sent screenshot comes back');
});

test('…and the one BEHIND it is then offered', () => {
  // Waving away the newest should not hide an older one that is still fresh —
  // two screenshots in a row is a normal thing to do.
  const got = pickShot({ shots: [shot('a', 1000), shot('b', 2000)], now: NOW, handled: ['a'] });
  assert.strictEqual(got && got.id, 'b', 'dismissing one hides the rest as well');
});

test('NOTHING AT ALL IS A QUIET NO', () => {
  // Every one of these is reachable: no permission, an empty album, a page of
  // photos none of which is a screenshot, a malformed asset.
  assert.strictEqual(pickShot({ shots: [], now: NOW }), null, 'an empty list is not handled');
  assert.strictEqual(pickShot({ shots: undefined, now: NOW }), null, 'a missing list throws');
  assert.strictEqual(pickShot({ shots: [null, undefined], now: NOW }), null, 'a hole in the list throws');
  assert.strictEqual(pickShot({ shots: [{ filename: 'x.png', creationTime: NOW }], now: NOW }), null,
    'an asset with no id is offered, and nothing could then dismiss it');
});

test('THE WINDOW IS LONG ENOUGH TO BE USED AND SHORT ENOUGH TO BE FORGOTTEN', () => {
  // Long enough to take a screenshot, leave the app it was taken in, open
  // this one and find the conversation; short enough that it is gone by the
  // next time the chat is opened.
  assert.ok(FRESH_MS >= 60 * 1000, 'the window is under a minute, which is not long enough to cross two apps');
  assert.ok(FRESH_MS <= 10 * 60 * 1000, 'the window is over ten minutes, so a stale screenshot is offered');
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
