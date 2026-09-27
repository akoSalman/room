// ── Nobody sees a file they do not have access to ───────────────────────────
//
// Asked for exactly that way, and it was not true. The protection on /uploads
// was a signed url and nothing else, which server.js described honestly:
//
//     "Access is therefore decided when the message is DELIVERED"
//
// That is a bearer token. It proves somebody was once allowed to be given the
// link; it says nothing about who is asking now. Forward the url and a
// stranger with no account gets the file. Leave a private room and every url
// you kept still works. And because send_message stored whatever `filePath`
// string it was sent, a signature could be minted for ANY file on the server.
//
// Two rules replace it, and both are tested here: a signature names its
// viewer, and access is checked when the bytes are asked for.
const assert = require('assert');
const M = require('../mediaAccess');

const tests = [];
const test = (n, f) => tests.push({ n, f });

// ── The name (this is also the arbitrary-file-deletion fix) ─────────────────

test('A NAME THAT ESCAPES THE DIRECTORY IS NOT A NAME', () => {
  // The one that mattered most. `file_path` was stored with only its query
  // stripped, and destroyMessage did:
  //
  //     if (p.startsWith('/uploads/')) fs.unlink(path.join(__dirname, p))
  //
  // path.join normalises '..' away, so '/uploads/../../../etc/crontab'
  // passed that test and resolved outside the directory. Any account could
  // delete any file the service could write, the database included.
  for (const v of ['../server.js', '../../etc/crontab', 'a/../../b', './../x',
                   'a/b.jpg', 'a\\b.jpg', '..', '.', '']) {
    assert.strictEqual(M.safeUploadName(v), null, JSON.stringify(v));
  }
  for (const p of ['/uploads/../server.js', '/uploads/../../etc/crontab',
                   '/uploads/./../chat.db', '/uploads/a/../../db.js']) {
    assert.strictEqual(M.nameFromPath(p), null, p);
  }
});

test('…and neither is one of our own hidden directories', () => {
  // uploads/.thumbs, uploads/.partial and uploads/.tiles are caches, not
  // anybody's media, and a leading dot is how they are kept out of listings.
  for (const v of ['.thumbs', '.partial/x', '.env', '.htaccess']) {
    assert.strictEqual(M.safeUploadName(v), null, v);
  }
});

test('…nor anything carrying a control character', () => {
  for (const v of ['a\u0000b.jpg', 'a\nb.jpg', 'a\u007f.jpg']) {
    assert.strictEqual(M.safeUploadName(v), null, JSON.stringify(v));
  }
  assert.strictEqual(M.safeUploadName('a'.repeat(300)), null);
});

test('AN ORDINARY NAME STILL WORKS, whatever shape it is', () => {
  // Deliberately not a regex describing how names are generated today: every
  // file already on disk has to keep working, including any made before the
  // current scheme.
  for (const v of ['1727441234567-123456789.jpg', 'photo.jpeg', 'no-extension',
                   'گزارش.pdf', 'a.b.c.mp4', '1-2']) {
    assert.strictEqual(M.safeUploadName(v), v, v);
  }
  assert.strictEqual(M.nameFromPath('/uploads/x.jpg?e=1&s=2'), 'x.jpg');
  assert.strictEqual(M.nameFromPath('/uploads/x.jpg#frag'), 'x.jpg');
  assert.strictEqual(M.nameFromPath('/elsewhere/x.jpg'), null);
  assert.strictEqual(M.nameFromPath(null), null);
});

test('A GALLERY IS SEVERAL FILES, and all of them are checked', () => {
  // A gallery message keeps a JSON array in the one column. A caller that
  // forgets that checks the access of a photo nobody asked about while
  // serving the one they did.
  assert.deepStrictEqual(
    M.uploadNamesIn(JSON.stringify(['/uploads/a.jpg', '/uploads/b.jpg'])),
    ['a.jpg', 'b.jpg']);
  assert.deepStrictEqual(M.uploadNamesIn('/uploads/only.jpg'), ['only.jpg']);
  // Repeats collapse; rubbish inside the array is dropped, not trusted.
  assert.deepStrictEqual(
    M.uploadNamesIn(JSON.stringify(['/uploads/a.jpg', '/uploads/a.jpg',
                                    '/uploads/../escape', 42, null])),
    ['a.jpg']);
  for (const v of [null, undefined, '', '[', '[]', 'not a path', 42]) {
    assert.deepStrictEqual(M.uploadNamesIn(v), [], JSON.stringify(v));
  }
});

// ── Minting a signature (the hole that made every other one worse) ──────────

test('YOU CANNOT ATTACH A FILE YOU HAVE NO CLAIM TO', () => {
  // send_message stored whatever filePath arrived and the server then SIGNED
  // it on delivery. So knowing a filename was enough to be handed a fresh,
  // valid url for it — for media from a room you were thrown out of, or from
  // a message that had been deleted.
  assert.strictEqual(M.mayAttach({ owns: false, referencedIn: [], canSee: () => true }), false);
  assert.strictEqual(M.mayAttach({ owns: false, referencedIn: [7], canSee: () => false }), false);
  assert.strictEqual(M.mayAttach({}), false);
  assert.strictEqual(M.mayAttach(null), false);
});

test('…but your own file, and one from a chat you can read, are fine', () => {
  // The second clause is forwarding, and re-sending something out of a chat
  // you can see. Written as "a room you can see" rather than "any room".
  assert.strictEqual(M.mayAttach({ owns: true }), true);
  assert.strictEqual(M.mayAttach({ owns: false, referencedIn: [7], canSee: r => r === 7 }), true);
  assert.strictEqual(M.mayAttach({ owns: false, referencedIn: [7, 9], canSee: r => r === 9 }), true);
});

test('a missing canSee refuses rather than allows', () => {
  assert.strictEqual(M.mayAttach({ owns: false, referencedIn: [7] }), false);
  assert.strictEqual(M.mayAttach({ owns: false, referencedIn: 'nope', canSee: () => true }), false);
});

// ── The expiry ──────────────────────────────────────────────────────────────

const NOW = 1_800_000_000_000;

test('A URL IS STABLE WITHIN ITS WINDOW', () => {
  // Not cosmetic. `now + ttl` gives a new url on every request, so every
  // cache that keys on the url misses every time and the same photo is
  // downloaded again on every visit — on connections paid for by the
  // megabyte. Rounding up to a bucket is what gives every client a key that
  // stays put.
  const mid = NOW + 7 * 60 * 60 * 1000;          // somewhere inside a bucket
  assert.strictEqual(M.expiryFor(mid), M.expiryFor(mid + 60_000),
    'the url changes between two requests a minute apart');
  assert.strictEqual(M.expiryFor(mid), M.expiryFor(mid + 3 * 60 * 60 * 1000),
    'the url changes within a single bucket');
  assert.strictEqual(M.expiryFor(mid) % M.BUCKET_MS, 0);
  assert.ok(M.expiryFor(mid) > mid, 'the url is born expired');
});

test('…and the window stays WIDE, because identity is what protects the file now', () => {
  // The instinct when tightening access is to shorten the expiry. It buys
  // almost nothing here — a leaked url is already useless to anybody but the
  // person it names — and it costs a great deal, because a url is only
  // cacheable while it stays the same. An hour-long bucket would have every
  // phone re-download every photo in every chat it opens, once an hour.
  assert.ok(M.BUCKET_MS >= 12 * 60 * 60 * 1000,
    'urls rotate often enough to defeat every image cache on these phones');
  assert.ok(M.TTL_MS <= 2 * 24 * 60 * 60 * 1000,
    'a url outlives its usefulness by days');
});

test('a clock that cannot be read produces no url', () => {
  for (const n of [null, undefined, 0, -1, NaN, 'x', {}]) {
    assert.strictEqual(M.expiryFor(n), null, String(n));
  }
});

// ── The decision ────────────────────────────────────────────────────────────

const ok = (over) => Object.assign({
  name: 'p.jpg', viewerId: 5, sigValid: true,
  exp: NOW + 1000, now: NOW, hasAccess: true, allowLegacy: false,
}, over);

test('THE WHOLE POINT: a valid, current, correctly signed url still needs access', () => {
  assert.strictEqual(M.decide(ok()), 'ok');
  assert.strictEqual(M.decide(ok({ hasAccess: false })), 'no-access');
});

test('AN UNNAMED VIEWER IS REFUSED', () => {
  // A url with no `u` is one made before urls named their viewer. There is
  // nobody to authorise, so there is no authorising it.
  assert.strictEqual(M.decide(ok({ viewerId: null })), 'unidentified');
  assert.strictEqual(M.decide(ok({ viewerId: undefined })), 'unidentified');
  // …unless the operator has deliberately turned the old behaviour back on
  // for a rollout. Off by default, and it is the ONLY way through.
  assert.strictEqual(M.decide(ok({ viewerId: null, allowLegacy: true })), 'legacy');
});

test('…and viewer 0 is a viewer, not an absence', () => {
  // Number(null) is 0 and `!0` is true: the trap this codebase keeps meeting.
  // A falsy-but-present id must take the ordinary path.
  assert.strictEqual(M.decide(ok({ viewerId: 0 })), 'ok');
  assert.strictEqual(M.decide(ok({ viewerId: 0, hasAccess: false })), 'no-access');
});

test('a bad or expired signature never reaches the access question', () => {
  assert.strictEqual(M.decide(ok({ sigValid: false })), 'bad-signature');
  assert.strictEqual(M.decide(ok({ now: NOW + 2000 })), 'expired');
  assert.strictEqual(M.decide(ok({ exp: 'x' })), 'bad-signature');
  assert.strictEqual(M.decide(ok({ exp: null })), 'bad-signature');
  assert.strictEqual(M.decide(ok({ now: null })), 'bad-signature');
  // An unusable name is refused before anything else.
  assert.strictEqual(M.decide(ok({ name: null })), 'bad-request');
  assert.strictEqual(M.decide(null), 'bad-request');
});

test('ONLY TWO DECISIONS SERVE BYTES', () => {
  // Stated as a whole so a new decision cannot be added and quietly default
  // to being served.
  const serving = ['ok', 'legacy', 'no-access', 'expired', 'bad-signature',
                   'unidentified', 'bad-request']
    .filter(d => M.statusFor(d) === 200);
  assert.deepStrictEqual(serving, ['ok', 'legacy']);
  assert.strictEqual(M.statusFor('bad-request'), 400);
  // 403 rather than 404 for a file that exists but is not yours: a 404 would
  // be kinder and would also confirm the file exists, and the names are what
  // stands between a stranger and a guess.
  assert.strictEqual(M.statusFor('no-access'), 403);
  assert.strictEqual(M.statusFor('anything-new'), 403);
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
