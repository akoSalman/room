// Saving a photo from the web on a phone.
//
// Reported: "on web version ios the save for media should save to gallery not
// files, image and video to gallery and files to files".
//
// Everything went out through `<a download>`, and on iOS that attribute is
// ignored: the file opens, or lands in Files, and a photo saved from a chat is
// somewhere the Photos app will never show it. The only route from a web page
// to the camera roll is the system share sheet — "Save Image" / "Save Video" —
// reached by handing a File to navigator.share.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
global.window = global;
const S = require(path.join(ROOT, 'public', 'js', 'saveMedia.js'));

const tests = [];
const test = (n, f) => tests.push({ n, f });

// A browser that can share files, and one that cannot.
const sharer = {
  navigator: { share: () => {}, canShare: () => true },
  probeFile: {},
};
const plain = { navigator: { share: () => {} }, probeFile: {} };
const refuses = {
  navigator: { share: () => {}, canShare: () => false },
  probeFile: {},
};

// ── What belongs in the gallery ─────────────────────────────────────────────

test('THE BUG: photos and videos go to the gallery, documents to Files', () => {
  assert.strictEqual(S.routeFor({ mime: 'image/jpeg', canShareFiles: true }), 'share');
  assert.strictEqual(S.routeFor({ mime: 'video/mp4', canShareFiles: true }), 'share');
  // A PDF has no place in Photos, and iOS offers "Save to Files" for it
  // anyway — which is where a document should go.
  assert.strictEqual(S.routeFor({ mime: 'application/pdf', canShareFiles: true }), 'download');
  assert.strictEqual(S.routeFor({ mime: 'audio/mpeg', canShareFiles: true }), 'download');
});

test('a file with no usable type is judged by its name', () => {
  // Chat files routinely arrive as octet-stream or with no type at all.
  assert.strictEqual(S.isGalleryMedia({ name: 'holiday.HEIC', mime: '' }), true);
  assert.strictEqual(S.isGalleryMedia({ name: 'clip.mov', mime: 'application/octet-stream' }), true);
  assert.strictEqual(S.isGalleryMedia({ url: '/uploads/123-x.png' }), true);
  assert.strictEqual(S.isGalleryMedia({ name: 'contract.pdf', mime: '' }), false);
  assert.strictEqual(S.isGalleryMedia({ name: 'notes', mime: '' }), false);
  // A query string is not part of the extension.
  assert.strictEqual(S.isGalleryMedia({ url: '/uploads/a.jpg?e=123&s=abc' }), true);
});

test('a real type beats the name, in both directions', () => {
  assert.strictEqual(S.isGalleryMedia({ name: 'weird.dat', mime: 'image/png' }), true);
  assert.strictEqual(S.isGalleryMedia({ name: 'trick.jpg', mime: 'application/pdf' }), false);
});

// ── Whether the sheet is there at all ───────────────────────────────────────

test('a browser with no share sheet keeps the plain download', () => {
  assert.strictEqual(S.canShareFiles({ navigator: {} }), false);
  // share() for links but no canShare(): answering "yes" here is a tap that
  // does nothing at all.
  assert.strictEqual(S.canShareFiles(plain), false);
  assert.strictEqual(S.routeFor({ mime: 'image/jpeg', canShareFiles: false }), 'download');
});

test('a browser that refuses FILES is not asked to take one', () => {
  assert.strictEqual(S.canShareFiles(refuses), false);
});

test('a browser that can, is used', () => {
  assert.strictEqual(S.canShareFiles(sharer), true);
});

test('a browser that throws when asked is treated as unable', () => {
  assert.strictEqual(S.canShareFiles({
    navigator: { share: () => {}, canShare: () => { throw new Error('no'); } }, probeFile: {},
  }), false);
});

// ── Names, and cancelling ───────────────────────────────────────────────────

test('a gallery message\'s comma-joined names never become a filename', () => {
  assert.strictEqual(S.saveName('/uploads/9-a.jpg', 'one.jpg,two.jpg'), '9-a.jpg');
  assert.strictEqual(S.saveName('/uploads/9-a.jpg', 'holiday.jpg'), 'holiday.jpg');
  assert.strictEqual(S.saveName('/uploads/9-a.jpg?e=1&s=2', ''), '9-a.jpg');
  assert.strictEqual(S.saveName('', ''), 'file');
});

test('dismissing the sheet is not an error', () => {
  // Otherwise cancelling puts a failure in front of someone who simply
  // changed their mind — and falls through to a download they did not ask for.
  assert.strictEqual(S.shareCancelled({ name: 'AbortError' }), true);
  assert.strictEqual(S.shareCancelled({ code: 20 }), true);
  assert.strictEqual(S.shareCancelled({ name: 'NotAllowedError' }), false);
  assert.strictEqual(S.shareCancelled(null), false);
});

// ── The wiring ──────────────────────────────────────────────────────────────

const app = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

test('every save goes through the router, not straight to a link', () => {
  const save = app.slice(app.indexOf('async function saveToDevice('),
    app.indexOf('/** The plain link'));
  assert.ok(save.length > 200, 'saveToDevice moved');
  assert.ok(/SaveMedia\.routeFor\(\{/.test(save), 'the screen decides for itself where a file goes');
  // …and the answer is what the branch turns on, rather than being computed
  // and then ignored.
  assert.ok(/if \(route === 'share'\) \{/.test(save),
    'the route is worked out and then not used, so everything takes one path');
  assert.ok(/navigator\.share\(\{ files: \[file\] \}\)/.test(save),
    'nothing reaches the camera roll — this is the whole fix');
  assert.ok(/SaveMedia\.shareCancelled\(e\)/.test(save),
    'cancelling the sheet falls through to a download nobody asked for');
  // The viewer and the message menu both use it.
  assert.ok(/saveToDevice\(lightboxSrc/.test(app), 'the photo viewer still saves to Files on iOS');
  assert.ok(/await saveToDevice\(pth/.test(app), 'the message menu still saves to Files on iOS');
});

test('a refusal is never shared as if it were the file', () => {
  // A 403 has a body, and sharing it would hand the person an error page
  // named holiday.jpg.
  const fn = app.slice(app.indexOf('async function fetchAsFile('),
    app.indexOf('async function fetchAsFile(') + 500);
  assert.ok(/if \(!res\.ok\) throw/.test(fn),
    'a failed fetch becomes a file, and the share sheet offers it');
});

test('a gallery is saved one at a time', () => {
  // The share sheet is modal: firing several at once stacks sheets and loses
  // all but the last.
  const fn = app.slice(app.indexOf('function ctxDownload('),
    app.indexOf('function ctxDownload(') + 900);
  assert.ok(/for \(const pth of paths\)/.test(fn) && /await saveToDevice/.test(fn),
    'the downloads are fired together again');
});

test('the bytes are ready before the tap that shares them', () => {
  // Safari opens the sheet only from a user gesture, and an await inside the
  // handler spends it.
  assert.ok(/function primeSave\(/.test(app), 'nothing is primed, so the first tap can be refused');
  assert.ok(/primeSave\(lightboxSrc/.test(app), 'the viewer does not prime the photo it is showing');
  assert.ok(/primeSave\(msg\.file_path/.test(app), 'the message menu does not prime its file');
  const save = app.slice(app.indexOf('async function saveToDevice('),
    app.indexOf('/** The plain link'));
  assert.ok(/savePrimed\.get\(url\) \|\| await fetchAsFile/.test(save),
    'the primed file is ignored, so every save pays for the fetch inside the gesture');
});

test('one-time media is still never saved', () => {
  const fn = app.slice(app.indexOf('function downloadLightboxImage('),
    app.indexOf('function downloadLightboxImage(') + 300);
  assert.ok(/oneTimeMediaUrls\.has\(lightboxSrc\)\) return/.test(fn),
    'a view-once photo can now be saved to the camera roll');
});

test('the page loads the rules before app.js', () => {
  assert.ok(/src="\/js\/saveMedia\.js"/.test(html), 'saveMedia.js is never loaded');
  assert.ok(html.indexOf('saveMedia.js') < html.indexOf('js/app.js'));
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
