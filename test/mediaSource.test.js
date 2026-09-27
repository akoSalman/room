// ── The app asking for its own media, as itself ─────────────────────────────
//
// The server now checks WHO is asking for a file. <Image> sends only what its
// `source` says, so every place the app displays one of our files has to say
// who it is.
//
// The interesting half of this is not attaching the token. It is NOT attaching
// it: the very same components also load map tiles, link-preview covers and a
// YouTube player, and the naive version of this change hands the session token
// to youtube.com and to whatever host a stranger's link points at. That would
// be a worse bug than the one being fixed.
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const NAT = path.join(ROOT, 'native-app');
const TSC = path.join(NAT, 'node_modules', '.bin', 'tsc');
if (!fs.existsSync(TSC)) {
  console.log('  ! skipping media-source tests (native-app deps not installed)');
  process.exit(0);
}
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'msrc-'));
process.on('exit', () => fs.rmSync(OUT, { recursive: true, force: true }));
execFileSync(TSC, [path.join(NAT, 'src', 'mediaSource.ts'),
  '--outDir', OUT, '--module', 'commonjs', '--target', 'es2019',
  '--skipLibCheck', '--esModuleInterop'], { stdio: 'pipe' });
const M = require(path.join(OUT, 'mediaSource.js'));
// The module holds the origin and the token; api.ts pushes them in at startup.
M.configureMedia({ baseUrl: 'https://chat.example.com', token: 'header.payload.signature' });

const tests = [];
const test = (n, f) => tests.push({ n, f });
const BASE = 'https://chat.example.com';
const TOK = 'header.payload.signature';

test('OUR OWN GUARDED MEDIA CARRIES THE TOKEN', () => {
  for (const u of [`${BASE}/uploads/a.jpg`, `${BASE}/uploads/a.jpg?e=1&s=2&u=3`,
                   `${BASE}/thumb/a.jpg?w=200`]) {
    const s = M.mediaSource(u);
    assert.strictEqual(s.uri, u, u);
    assert.strictEqual(s.headers.Authorization, `Bearer ${TOK}`, u);
  }
});

test('A THIRD PARTY IS NEVER HANDED THE SESSION TOKEN', () => {
  // The bug the naive version of this change introduces. These urls reach the
  // same components: a YouTube embed, a link preview's cover on a stranger's
  // host, an OSM tile mirror.
  for (const u of [
    'https://www.youtube.com/embed/abc',
    'https://evil.example/cover.jpg',
    'https://chat.example.com.evil.net/uploads/a.jpg',   // prefix, not our origin
    'http://chat.example.com/uploads/a.jpg',             // wrong scheme
    'https://tile.openstreetmap.org/3/4/5.png',
  ]) {
    const s = M.mediaSource(u);
    assert.deepStrictEqual(s, { uri: u }, u);
    assert.strictEqual(M.needsToken(u, BASE), false, u);
  }
});

test('A HOST OF THE RIGHT LENGTH IS STILL A DIFFERENT HOST', () => {
  // Found by mutation testing: deleting the origin check broke nothing,
  // because the path is taken by slicing off the base's LENGTH. A foreign
  // host whose name happens to be exactly as long then lines the slice up on
  // '/uploads/' and is handed the session token.
  //
  //   base  https://chat.example.com   (24 characters)
  //   evil  https://evil.example.abc/uploads/a.jpg
  //                                  ^ slice(24) lands here
  //
  // Contrived to construct, and trivially reachable in practice: a link
  // preview's cover url comes from a message a stranger sent.
  assert.strictEqual(BASE.length, 24, 'the example base changed; recompute the attack');
  const sameLength = 'https://evil.example.abc/uploads/a.jpg';
  assert.strictEqual(sameLength.indexOf('/uploads/'), BASE.length);
  assert.strictEqual(M.needsToken(sameLength, BASE), false,
    'a foreign host of the same length was handed the session token');
  assert.deepStrictEqual(M.mediaSource(sameLength), { uri: sameLength });
});

test('…and neither is a local file or a data uri', () => {
  // A photo staged for sending, a frame from the camera, an edited image.
  for (const u of ['file:///data/user/0/app/cache/x.jpg', 'data:image/png;base64,AAAA',
                   'content://media/external/images/1', '/uploads/a.jpg']) {
    assert.deepStrictEqual(M.mediaSource(u), { uri: u }, u);
  }
});

test('OUR OWN UNAUTHENTICATED PATHS DO NOT GET IT EITHER', () => {
  // /tiles and /link-image deliberately need no identity — they serve bytes
  // that are already ours, re-encoded and size-capped. Sending a token where
  // it is not checked only widens where it can be found.
  for (const u of [`${BASE}/tiles/3/4/5.png`, `${BASE}/link-image/${'a'.repeat(32)}`,
                   `${BASE}/app/download`, `${BASE}/me`, `${BASE}/`]) {
    assert.deepStrictEqual(M.mediaSource(u), { uri: u }, u);
  }
});

test('A QUERY CANNOT DISGUISE ANOTHER PATH AS A GUARDED ONE', () => {
  // Matched on the path, not the whole string. Otherwise anything with
  // '/uploads/' anywhere in it — including a foreign url carrying ours as a
  // parameter — would be handed the token.
  assert.strictEqual(M.needsToken(`${BASE}/anything?x=/uploads/a.jpg`, BASE), false);
  assert.strictEqual(M.needsToken(`${BASE}/redirect#/uploads/a.jpg`, BASE), false);
  assert.strictEqual(M.needsToken(`https://evil.example/?u=${BASE}/uploads/a.jpg`, BASE), false);
});

/** Run something with a different token, then put it back. */
function withToken(t, fn) {
  M.setMediaToken(t);
  try { return fn(); } finally { M.setMediaToken(TOK); }
}

test('NO TOKEN MEANS NO HEADER, not the word undefined', () => {
  const u = `${BASE}/uploads/a.jpg`;
  for (const t of [null, undefined, '']) {
    assert.deepStrictEqual(withToken(t, () => M.mediaSource(u)), { uri: u }, String(t));
  }
});

test('rubbish is passed through rather than thrown on', () => {
  // These run inside render. An exception here is a blank screen.
  assert.strictEqual(M.needsToken(null, BASE), false);
  assert.strictEqual(M.needsToken('x', null), false);
  assert.strictEqual(M.needsToken(42, BASE), false);
  assert.doesNotThrow(() => M.mediaSource(''));
  // A trailing slash on the base is the same base.
  assert.strictEqual(M.needsToken(`${BASE}/uploads/a.jpg`, BASE + '/'), true);
});

// ── The wiring ──────────────────────────────────────────────────────────────

test('EVERY PLACE THAT SHOWS OUR MEDIA GOES THROUGH IT', () => {
  // A component that keeps its own `{ uri }` shows a broken image, which is
  // the failure this is easiest to miss — it looks like a slow network.
  const must = [
    'components/GalleryImage.tsx',
    'components/ZoomableImage.tsx',
    'components/CachedImage.tsx',
    'components/MediaBrowser.tsx',
    'components/VideoPlayer.tsx',
    'components/VideoBubble.tsx',
  ];
  for (const f of must) {
    const src = fs.readFileSync(path.join(NAT, 'src', f), 'utf8');
    assert.ok(/mediaSource/.test(src), `${f} still asks for media anonymously`);
  }
});

test('…and so does every path that FETCHES bytes rather than showing them', () => {
  // Saving a photo, caching one to disk and downloading a video are fetches
  // the app makes itself, so they can carry a header — but they have to be
  // told to, and each one is a separate call site that 403s on its own.
  for (const [f, what] of [
    ['screens/ChatScreen.tsx', 'saving and caching media'],
    ['mediaCache.ts', 'the on-disk image cache'],
    ['videoDownloads.ts', 'video downloads'],
  ]) {
    const src = fs.readFileSync(path.join(NAT, 'src', f), 'utf8');
    assert.ok(/mediaHeaders\(/.test(src), `${what} asks anonymously, so it is refused`);
  }
});

test('THE APK DOWNLOAD IS LEFT ALONE', () => {
  // /app/download is deliberately unauthenticated — it has to work for
  // somebody whose session has expired, which is exactly when they need it.
  const up = fs.readFileSync(path.join(NAT, 'src', 'appUpdate.ts'), 'utf8');
  assert.ok(!/mediaHeaders/.test(up), 'the update download now needs a session to work');
});

test('AND THE TOKEN REACHES THE MODULE, or none of this does anything', () => {
  // mediaSource depends on nothing, so api.ts has to push the origin and the
  // token into it. Miss either and every picture in the app 403s.
  const api = fs.readFileSync(path.join(NAT, 'src', 'api.ts'), 'utf8');
  assert.ok(/configureMedia\(\{ baseUrl: BASE_URL \}\)/.test(api), 'the origin is never set');
  assert.ok(/setMediaToken/.test(api), 'the token is never handed over');
  const i = api.indexOf('export async function getToken');
  assert.ok(/rememberToken/.test(api.slice(i, i + 250)),
    'reading the token at launch does not tell mediaSource about it');
  // Signing in must go through setAuth, not straight to storage.
  const auth = fs.readFileSync(path.join(NAT, 'src', 'screens', 'AuthScreen.tsx'), 'utf8');
  assert.ok(!/AsyncStorage\.setItem\('token'/.test(auth),
    'sign-in writes the token past setAuth, so media 403s until the next launch');
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
