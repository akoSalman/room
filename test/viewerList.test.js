// ── The counter that counted the wrong thing ────────────────────────────────
//
// Reported as: opening an image in a chat, the counter counts only the images
// loaded on that screen rather than every image in the chat, and swiping is
// limited to those same few.
//
// One cause: the viewer's list was built from the messages currently loaded in
// the chat window. So the total was a page size, and the swipe range was a page.
//
// The fix asks the server for the room's whole list, which makes the risky part
// the MERGE — putting that list together with the one already on screen without
// losing the photo the person is looking at, and without re-downloading it.
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const NAT = path.join(ROOT, 'native-app');
const TSC = path.join(NAT, 'node_modules', '.bin', 'tsc');
if (!fs.existsSync(TSC)) {
  console.log('  ! skipping viewer-list tests (native-app deps not installed)');
  process.exit(0);
}
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'vlist-'));
process.on('exit', () => fs.rmSync(OUT, { recursive: true, force: true }));
execFileSync(TSC, [path.join(NAT, 'src', 'viewerList.ts'),
  '--outDir', OUT, '--module', 'commonjs', '--target', 'es2019',
  '--skipLibCheck', '--esModuleInterop'], { stdio: 'pipe' });
const V = require(path.join(OUT, 'viewerList.js'));

const tests = [];
const test = (n, f) => tests.push({ n, f });

// A signed url, the way the server makes them. The expiry is bucketed to the
// day, so the SAME photo has one url today and a different one tomorrow.
const sign = (name, day = 1) => `https://c.example/uploads/${name}?e=${day}0000000&s=${'a'.repeat(32)}`;

test('A PHOTO IS IDENTIFIED BY ITS FILENAME, not by its url', () => {
  // The whole merge rests on this. The signature rotates daily; the name does
  // not.
  assert.strictEqual(V.photoKey(sign('p1.jpg', 1)), 'p1.jpg');
  assert.strictEqual(V.photoKey(sign('p1.jpg', 2)), 'p1.jpg');
  assert.strictEqual(V.photoKey(sign('p1.jpg', 1)), V.photoKey(sign('p1.jpg', 9)));
  assert.strictEqual(V.photoKey('/uploads/p1.jpg'), 'p1.jpg');
  assert.strictEqual(V.photoKey('p1.jpg'), 'p1.jpg');
});

test('…and a slash inside the signature is not a path separator', () => {
  // base64url has no '/', but base64 does, and one careless change to mediaSig
  // would make the name read as the tail of the signature. Query first, then
  // the last slash — never the other way round.
  assert.strictEqual(V.photoKey('/uploads/p1.jpg?s=aa/bb/cc'), 'p1.jpg');
  assert.strictEqual(V.photoKey('/uploads/p1.jpg#x/y'), 'p1.jpg');
});

test('…and %20 is not a different photo from a space', () => {
  assert.strictEqual(V.photoKey('/uploads/my%20photo.jpg'), 'my photo.jpg');
  // Broken encoding must not throw; it is just a name then.
  assert.doesNotThrow(() => V.photoKey('/uploads/100%.jpg'));
  assert.strictEqual(V.photoKey('/uploads/100%.jpg'), '100%.jpg');
});

test('NOTHING IS A KEY WHEN THERE IS NO NAME', () => {
  // Null must mean "matches nothing". If it were treated as a key, every
  // unidentifiable url would collide with every other one and the merge would
  // dedupe real photos out of the list.
  for (const u of [null, undefined, '', 42, {}, '/uploads/', '/uploads/?e=1']) {
    assert.strictEqual(V.photoKey(u), null, JSON.stringify(u));
  }
});

// ── The merge ───────────────────────────────────────────────────────────────

test('THE WHOLE CHAT IS BROWSABLE, which is the bug', () => {
  const local = [sign('p8.jpg'), sign('p9.jpg')];
  const full = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8', 'p9'].map(n => sign(`${n}.jpg`));
  const r = V.mergeViewerList({ local, full, current: sign('p8.jpg') });
  assert.strictEqual(r.images.length, 9, 'the viewer still only reaches the loaded messages');
  assert.strictEqual(r.index, 7, 'the photo on screen is not where the index points');
});

test('THE PHOTO ON SCREEN STAYS ON SCREEN, across the daily boundary', () => {
  // The chat loaded its url yesterday; the full list is signed today. Compared
  // as strings, `current` is absent from a list that plainly contains it — and
  // the person watches the photo they tapped turn into a different one.
  const r = V.mergeViewerList({
    local: [sign('p4.jpg', 1)],
    full: ['p1', 'p2', 'p3', 'p4', 'p5'].map(n => sign(`${n}.jpg`, 2)),
    current: sign('p4.jpg', 1),
  });
  assert.strictEqual(r.index, 3);
  assert.strictEqual(V.photoKey(r.images[r.index]), 'p4.jpg');
});

test('…and the photo is FOUND by key even when its url is nowhere in the list', () => {
  // The case above passes for the wrong reason on its own: the merged list
  // prefers the local url, so `current` happens to be in it byte for byte and
  // a plain indexOf would find it. This is the case that needs the key — the
  // url on screen is not in either list, only the photo is. Get it wrong and
  // the photo is prepended a second time: the list grows by a phantom and the
  // person swipes forward onto the picture they are already looking at.
  const r = V.mergeViewerList({
    local: [],
    full: [sign('p1.jpg', 2), sign('p2.jpg', 2)],
    current: sign('p2.jpg', 1),
  });
  assert.strictEqual(r.images.length, 2, 'the same photo was added to the list twice');
  assert.strictEqual(r.index, 1);
});

test('THE URL ALREADY ON SCREEN IS THE ONE KEPT', () => {
  // Both are valid. The image cache is keyed by url, so taking the server's
  // would re-download the photo being looked at, over a metered connection, to
  // show the identical bytes.
  const mine = sign('p2.jpg', 1);
  const r = V.mergeViewerList({
    local: [mine],
    full: ['p1', 'p2', 'p3'].map(n => sign(`${n}.jpg`, 2)),
    current: mine,
  });
  assert.strictEqual(r.images[1], mine, 'the loaded photo is re-fetched under a new url');
  // …and the ones the chat never had come from the server, necessarily.
  assert.strictEqual(V.photoKey(r.images[0]), 'p1.jpg');
  assert.ok(r.images[0].includes('e=20000000'));
});

test('NO SERVER LIST MEANS EXACTLY TODAY\'S BEHAVIOUR', () => {
  // This has to degrade to "the feature is missing", never to "the wrong
  // photo". An old server, a dropped request, and an offline phone all land
  // here — and the servers are, at the time of writing, running older code.
  const local = [sign('p1.jpg'), sign('p2.jpg'), sign('p3.jpg')];
  for (const full of [null, undefined, [], 'nope', 0]) {
    const r = V.mergeViewerList({ local, full, current: sign('p2.jpg') });
    assert.deepStrictEqual(r.images, local, JSON.stringify(full));
    assert.strictEqual(r.index, 1, JSON.stringify(full));
  }
});

test('A JUST-SENT PHOTO IS NOT DROPPED', () => {
  // The upload finished on this device after the list was fetched. It is the
  // newest photo and the list runs oldest first, so it belongs at the end —
  // and it must still be reachable, because it is very likely the one being
  // looked at.
  const fresh = 'file:///local/just-taken.jpg';
  const r = V.mergeViewerList({
    local: [sign('p3.jpg'), fresh],
    full: ['p1', 'p2', 'p3'].map(n => sign(`${n}.jpg`)),
    current: fresh,
  });
  assert.strictEqual(r.images.length, 4);
  assert.strictEqual(r.images[3], fresh);
  assert.strictEqual(r.index, 3);
});

test('A PHOTO THE SERVER HAS HIDDEN IS STILL SHOWN, not swapped out', () => {
  // A revealed one-time photo is excluded from the server's list by design.
  // The person is looking at it; losing it would replace it mid-look.
  const secret = sign('one-time.jpg');
  const r = V.mergeViewerList({
    local: [secret],
    full: ['p1', 'p2'].map(n => sign(`${n}.jpg`)),
    current: secret,
  });
  assert.ok(r.images.includes(secret), 'the photo being looked at vanished from the list');
  assert.strictEqual(V.photoKey(r.images[r.index]), 'one-time.jpg');
});

test('…and even a photo in NEITHER list survives', () => {
  const orphan = sign('orphan.jpg');
  const r = V.mergeViewerList({ local: [], full: [sign('p1.jpg')], current: orphan });
  assert.strictEqual(r.images[r.index], orphan);
  assert.strictEqual(r.index, 0);
  const r2 = V.mergeViewerList({ local: [], full: null, current: orphan });
  assert.strictEqual(r2.images[r2.index], orphan);
});

test('THE SAME PHOTO IS NOT LISTED TWICE', () => {
  // A gallery message repeated across a page boundary, or a list merged with
  // itself on a retry. Two entries for one photo means swiping past it shows
  // it again and the total is wrong in the other direction.
  const r = V.mergeViewerList({
    local: [sign('p1.jpg', 1), sign('p1.jpg', 2)],
    full: [sign('p1.jpg', 3), sign('p1.jpg', 4), sign('p2.jpg')],
    current: sign('p1.jpg', 1),
  });
  assert.strictEqual(r.images.length, 2, 'one photo is listed more than once');
});

test('…and two photos with NO readable name are still two photos', () => {
  // A url with no filename cannot be identified, so it cannot be deduped
  // either — it has to pass through as itself. Treating the absent key as a
  // key (stringifying the null, say) makes every such url collide with every
  // other one, and the list quietly loses all but the first.
  const a = 'https://cdn.example/a/';
  const b = 'https://cdn.example/b/?e=1';
  const r = V.mergeViewerList({ local: [], full: [a, sign('p1.jpg'), b], current: a });
  assert.strictEqual(r.images.length, 3, 'unidentifiable photos were deduped into one');
  assert.deepStrictEqual(r.images, [a, sign('p1.jpg'), b]);
  assert.strictEqual(r.index, 0);
});

test('the index never points outside the list', () => {
  // -1 hands the gallery a photo that does not exist; the library indexes
  // refs.current[index] with no guard and throws.
  for (const o of [{}, undefined, { local: null, full: null, current: null },
                   { local: [], full: [], current: null },
                   { local: ['a'], full: ['b'], current: undefined }]) {
    const r = V.mergeViewerList(o);
    assert.ok(r.index >= 0, JSON.stringify(o));
    assert.ok(r.index === 0 || r.index < r.images.length, JSON.stringify(o));
    assert.ok(Array.isArray(r.images), JSON.stringify(o));
  }
});

test('rubbish inside the lists is discarded, not rendered', () => {
  const r = V.mergeViewerList({
    local: [null, '', sign('p1.jpg'), 42],
    full: [undefined, sign('p1.jpg'), sign('p2.jpg'), ''],
    current: sign('p1.jpg'),
  });
  assert.deepStrictEqual(r.images.map(V.photoKey), ['p1.jpg', 'p2.jpg']);
});

// ── The wiring ──────────────────────────────────────────────────────────────

const chat = fs.readFileSync(path.join(NAT, 'src', 'screens', 'ChatScreen.tsx'), 'utf8');
const chatCode = chat.split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');

test('THE VIEWER OPENS AT ONCE, and is corrected after', () => {
  // Waiting on a request before showing the photo would make tapping one feel
  // broken on these connections. It opens with what is known and grows.
  assert.ok(/mergeViewerList/.test(chatCode), 'the merge is never used');
  assert.ok(/function openViewer/.test(chatCode));
  const i = chatCode.indexOf('function openViewer');
  const body = chatCode.slice(i, chatCode.indexOf('\n  }', i));
  assert.ok(!/await /.test(body), 'opening a photo now waits on the network');
});

test('THE GALLERY IS REPOSITIONED WHEN THE LIST GROWS', () => {
  // The library renders `data` directly and its offset is index * width, so
  // growing the list moves every photo after the insertion point WITHOUT
  // moving the strip: the photo on screen silently becomes a different one.
  // Its imperative setIndex is the only thing that repositions atomically.
  assert.ok(/galleryRef/.test(chatCode), 'there is no handle on the gallery');
  assert.ok(/galleryRef\.current[\s\S]{0,40}setIndex\(/.test(chatCode),
    'the list can grow under the gallery without the strip being moved with it');
  assert.ok(/ref=\{galleryRef\}/.test(chatCode), 'the handle is never attached');
});

test('THE FULL LIST IS FETCHED ONCE PER CHAT', () => {
  // ~100 bytes per photo over a metered connection. Once, cached, and only
  // when a photo is actually opened.
  assert.ok(/room-images\//.test(chatCode), 'nothing asks the server for the whole list');
  assert.ok(/fullImagesRef/.test(chatCode), 'the list is fetched again on every photo');
});

test('…and a server that does not know the route changes nothing', () => {
  const i = chatCode.indexOf('room-images/');
  const around = chatCode.slice(Math.max(0, i - 400), i + 500);
  assert.ok(/catch/.test(around), 'a failed request is an unhandled rejection');
});

// ── The server ──────────────────────────────────────────────────────────────

const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const serverCode = server.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');

test('THE SERVER SENDS THE ROOM\'S WHOLE LIST, oldest first', () => {
  const i = serverCode.indexOf("app.get('/room-images/:roomId'");
  assert.ok(i > 0, 'the route is missing');
  const body = serverCode.slice(i, serverCode.indexOf('\n});', i));
  // Oldest first, because the chat reads that way and the viewer must match.
  assert.ok(/\.reverse\(\)/.test(body) || /ORDER BY id ASC/.test(body),
    'the list is newest-first, so swiping right goes back in time');
  assert.ok(/signPath|collectImages/.test(body), 'the urls are unsigned and will 403');
});

test('…and only to someone who is allowed to see it', () => {
  const i = serverCode.indexOf("app.get('/room-images/:roomId'");
  const body = serverCode.slice(i, serverCode.indexOf('\n});', i));
  assert.ok(/authMiddleware/.test(serverCode.slice(i, i + 200)), 'the route is unauthenticated');
  assert.ok(/canAccessRoom\(req\.user\.id, room\)/.test(body),
    'any logged-in account can list any room\'s photos');
  assert.ok(/visibleMessagesSql\(req\.user\.id, room\.id/.test(body),
    'messages deleted for this user are listed back to them');
  assert.ok(/one_time_seconds IS NULL/.test(body),
    'one-time photos are handed out in a list, which is the whole point of them');
});

test('THE ROUTE IS DEPLOYED, or the fix ships to nobody', () => {
  // server.js is in the deploy paths already; this states the dependency so a
  // later split into its own module does not silently strand it.
  const wf = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'deploy-servers.yml'), 'utf8');
  assert.ok(/- 'server\.js'/.test(wf), 'server.js is no longer deployed');
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
