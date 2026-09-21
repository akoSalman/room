// Where the app looks for its own updates, and which indicators believe it.
//
// Two reports, one cause:
//
//   "There is a new version — the update button is active in the profile, but
//    not at the top right of the chat list."
//
//   "Upload the newest version to each brand's server and get the update file
//    from there instead of GitHub."
//
// The second explains the first. The check asked api.github.com, which for the
// people this app is for is unreliable at best and unreachable at worst. When
// it failed, `latestVersion` stayed null — and the two places that show an
// update disagreed about what null meant: the profile fell through to a
// confident "Update now", while the header, which required a version to
// compare, showed nothing. Neither was right. Not knowing is its own answer.
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const NAT = path.join(__dirname, '..', 'native-app');
const TSC = path.join(NAT, 'node_modules', '.bin', 'tsc');
if (!fs.existsSync(TSC)) {
  console.log('  ! skipping update-source tests (native-app deps not installed)');
  process.exit(0);
}
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'updatesrc-'));
execFileSync(TSC, [
  path.join(NAT, 'src', 'updateSource.ts'), path.join(NAT, 'src', 'updateChoice.ts'),
  '--outDir', OUT, '--module', 'commonjs', '--target', 'es2019', '--skipLibCheck'], { stdio: 'pipe' });
const U = require(path.join(OUT, 'updateSource.js'));
const C = require(path.join(OUT, 'updateChoice.js'));

const tests = [];
const test = (n, f) => tests.push({ n, f });

const BASE = 'https://chat.akosalman.com';
const GH = 'https://github.com/akoSalman/room-releases/releases/download/latest-apk/ChatRoom-latest.apk';

// ── Which source answers ────────────────────────────────────────────────────

test('THE POINT: the brand\'s own server is believed first', () => {
  const info = U.chooseSource({
    server: { version: 180, url: '/app/download' }, github: 12, baseUrl: BASE, githubUrl: GH,
  });
  assert.strictEqual(info.latestVersion, 180);
  assert.strictEqual(info.source, 'server');
  assert.strictEqual(info.apkUrl, `${BASE}/app/download`,
    'the download still points somewhere the user may not be able to reach');
});

test('GitHub is the fallback, not the plan', () => {
  const info = U.chooseSource({ server: null, github: 174, baseUrl: BASE, githubUrl: GH });
  assert.strictEqual(info.latestVersion, 174);
  assert.strictEqual(info.source, 'github');
  assert.strictEqual(info.apkUrl, GH);
  assert.strictEqual(info.failed, false);
});

test('THE BUG: neither answering is reported as NOT KNOWN, not as no update', () => {
  const info = U.chooseSource({ server: null, github: null, baseUrl: BASE, githubUrl: GH });
  assert.strictEqual(info.latestVersion, null);
  assert.strictEqual(info.failed, true, 'a failed check was reported as a successful one');
  assert.strictEqual(info.apkUrl, null);
});

test('a manifest URL that is already absolute is left alone', () => {
  // A brand could serve its build from a CDN one day; rewriting that against
  // the chat host would produce a URL that 404s.
  const info = U.chooseSource({
    server: { version: 3, url: 'https://cdn.example.com/x.apk' }, github: null,
    baseUrl: BASE, githubUrl: GH,
  });
  assert.strictEqual(info.apkUrl, 'https://cdn.example.com/x.apk');
});

test('joining a relative URL to the host never doubles or drops the slash', () => {
  assert.strictEqual(U.absoluteUrl('/app/download', 'https://x.test'), 'https://x.test/app/download');
  assert.strictEqual(U.absoluteUrl('app/download', 'https://x.test/'), 'https://x.test/app/download');
  assert.strictEqual(U.absoluteUrl('/app/download', 'https://x.test/'), 'https://x.test/app/download');
});

// ── Reading what each source says ───────────────────────────────────────────

test('a server manifest is read, and anything odd counts as no answer', () => {
  assert.strictEqual(U.parseServerManifest({ version: 42, url: '/app/download' }).version, 42);
  // A string version is what a hand-written manifest tends to have.
  assert.strictEqual(U.parseServerManifest({ version: '42' }).version, 42);
  for (const bad of [null, undefined, {}, { version: 0 }, { version: -3 },
    { version: 'soon' }, 'nope', 42]) {
    assert.strictEqual(U.parseServerManifest(bad), null, `accepted ${JSON.stringify(bad)}`);
  }
});

test('a manifest with no url still knows where the file is, VERSIONED', () => {
  // This asserted the constant '/app/download', which is the bug: one path
  // for every build means the previous build's interrupted partial matches
  // the new one and gets resumed. See THE STALE PARTIAL below.
  assert.strictEqual(U.parseServerManifest({ version: 9 }).url, '/app/download?v=9');
});

test('the GitHub release version is read from the notes or the title', () => {
  assert.strictEqual(U.parseGithubRelease({ body: 'version:177 — automated build' }), 177);
  assert.strictEqual(U.parseGithubRelease({ name: 'ChatRoom v176' }), 176);
  // The notes win, because that is what CI writes deliberately.
  assert.strictEqual(U.parseGithubRelease({ body: 'version:177', name: 'ChatRoom v9' }), 177);
});

test('a GitHub answer that says nothing is null, not zero', () => {
  // Zero would compare as "older than everything" and nag forever.
  for (const bad of [{}, { body: 'no version here' }, { name: 'ChatRoom' }, null, 'nope']) {
    assert.strictEqual(U.parseGithubRelease(bad), null, `read a version out of ${JSON.stringify(bad)}`);
  }
});

// ── The two indicators must agree ───────────────────────────────────────────

test('THE BUG: header and profile answer from the same rule', () => {
  // The header used to test "different from what is running", and the profile
  // fell through to an Update button whenever the version was unknown. For a
  // failed check that is one place saying "update available" and the other
  // saying nothing at all — the exact report.
  const failed = { latestVersion: null, currentVersion: 170 };
  assert.strictEqual(U.updateAvailable(failed), false, 'the badge claims an update it cannot name');
  assert.strictEqual(
    C.installChoice({ downloadedVersion: null, latestVersion: null, currentVersion: 170 }),
    'unknown', 'the profile treats a failed check as a known update');
});

test('a newer build shows the badge; the same one does not', () => {
  assert.strictEqual(U.updateAvailable({ latestVersion: 180, currentVersion: 170 }), true);
  assert.strictEqual(U.updateAvailable({ latestVersion: 170, currentVersion: 170 }), false);
});

test('a build AHEAD of the server is not offered a downgrade', () => {
  // Testing a build before it is published is normal; being told to "update"
  // to something older is not.
  assert.strictEqual(U.updateAvailable({ latestVersion: 169, currentVersion: 170 }), false,
    'the badge offered an older build as an update');
});

test('a local dev build is never nagged', () => {
  // CI never stamps 0, so 0 means "built on somebody's machine".
  assert.strictEqual(U.updateAvailable({ latestVersion: 180, currentVersion: 0 }), false);
});

// ── The wiring ──────────────────────────────────────────────────────────────

const rooms = fs.readFileSync(path.join(NAT, 'src', 'screens', 'RoomsScreen.tsx'), 'utf8');
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const webApp = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
const workflow = fs.readFileSync(
  path.join(__dirname, '..', '.github', 'workflows', 'build-native-apk.yml'), 'utf8');

test('a flaky npm cache does not cost a whole brand its build', () => {
  // Build 243 lost bistbarg to this while akosalman, on the same commit,
  // installed cleanly a minute later:
  //   npm error code EEXIST … rename '_cacache/tmp/…' -> '…/content-v2/…'
  // npm's own cache lost a race with itself. Nothing in the project caused it
  // and nothing in the project can prevent it — but asking a second time with
  // the cache cleared costs a minute on the rare failure and nothing at all
  // otherwise.
  const step = workflow.slice(workflow.indexOf('- name: Install dependencies'),
    workflow.indexOf('- name: Generate native Android project'));
  assert.ok(step.length > 0, 'the install step is gone — this check would be vacuous');
  const lines = step.split('\n').filter(l => !/^\s*#/.test(l));
  const installs = lines.filter(l => /npm install/.test(l)).length;
  assert.ok(installs >= 2, 'a single npm install: one bad rename still loses the build');
  assert.ok(lines.some(l => /npm cache clean --force/.test(l)),
    'the retry reuses the cache that just refused to be written');
  assert.ok(lines.some(l => /npm install && exit 0/.test(l)),
    'the second install runs even when the first one worked');
});

test('the app asks its own server before GitHub', () => {
  assert.ok(rooms.includes('SERVER_MANIFEST_URL'), 'the app never asks its own server');
  const check = rooms.slice(rooms.indexOf('async function checkLatestVersion'),
    rooms.indexOf('async function downloadAndInstallUpdate'));
  assert.ok(check.indexOf('SERVER_MANIFEST_URL') < check.indexOf('LATEST_RELEASE_API'),
    'GitHub is asked first, which is the channel these users cannot reach');
  assert.ok(/if \(!server\) \{/.test(check),
    'GitHub is asked even when the server already answered');
  assert.ok(check.includes('upd.chooseSource({'), 'the choice is made by hand rather than by the rule');
});

test('the download goes to whichever source answered', () => {
  assert.ok(/const from = apkUrl \|\| LATEST_APK_URL;/.test(rooms),
    'the APK is always fetched from GitHub whatever the check found');
  assert.ok(rooms.includes('appUpdate.start(from,'), 'the downloader is still pointed at GitHub');
});

test('both indicators use the shared rule', () => {
  assert.ok(rooms.includes('upd.updateAvailable({'), 'the header badge decides for itself again');
  assert.ok(!/BUILD_VERSION !== latestVersion/.test(rooms), 'the old header comparison is back');
  assert.ok(rooms.includes("updateChoice === 'unknown'"),
    'the profile still shows a confident Update button when the check failed');
});

test('the server serves the manifest and the file', () => {
  assert.ok(server.includes("app.get('/app/latest.json'"), 'no manifest endpoint');
  assert.ok(server.includes("app.get('/app/download'"), 'no download endpoint');
  assert.ok(server.includes('res.sendFile('),
    'the APK is not sent with sendFile, so a resumed download (Range) cannot work');
  assert.ok(/status\(404\)/.test(server), 'a server with no build yet does not say so cleanly');
});

test('a manifest is only trusted when the FILE is really there', () => {
  // Advertising a version whose APK is missing turns every phone's update into
  // a failed download.
  const fn = server.slice(server.indexOf('function apkManifest()'), server.indexOf("app.get('/app/latest.json'"));
  assert.ok(fn.includes('statSync(APK_FILE)'), 'the file is never checked');
  assert.ok(/size <= 0/.test(fn), 'a zero-byte APK would be advertised as a build');
});

test('the build workflow publishes to each brand\'s own server', () => {
  assert.ok(/Publish APK to \$\{\{ matrix\.brand \}\}'s own server/.test(workflow),
    'nothing copies the build to the servers');
  // The UPLOAD itself must go to the temp name. Merely mentioning ".part"
  // somewhere in the file is not the same as copying to it: an scp straight
  // onto latest.apk hands a phone that is downloading right now half a file.
  assert.ok(/scp[\s\S]{0,200}latest\.apk\.part"/.test(workflow),
    'the APK is scp-ed straight over the live file');
  assert.ok(workflow.includes('latest.json.part'), 'the manifest is written in place');
  assert.ok(workflow.includes('sha256sum'), 'the manifest carries no checksum');
  assert.ok(/mv -f latest\.apk\.part latest\.apk[\s\S]*mv -f latest\.json\.part latest\.json/.test(workflow),
    'the manifest is moved into place before the file it describes');
  assert.ok(/exit 0/.test(workflow.slice(workflow.indexOf("Publish APK to"), workflow.indexOf('Publish latest APK to public'))),
    'a brand with no deploy secrets fails the build instead of skipping');
});

test('the web page offers this server\'s build too', () => {
  assert.ok(webApp.includes("APK_SERVER_MANIFEST = '/app/latest.json'"), 'the page never asks this server');
  assert.ok(webApp.includes('async function latestAppBuild()'), 'the two callers still duplicate the check');
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.ok(/id="apk-banner" href="\/app\/download"/.test(html),
    'the download banner still points at GitHub before any script runs');
});


// ── The stale-partial bug ───────────────────────────────────────────────────

test('THE STALE PARTIAL: the download URL carries the version', () => {
  // Reported as: "while downloading and installing v297, after installation
  // the update badge is still there and the update seems is just the previous
  // version". Exactly what it says.
  //
  // Every build was served from the constant path /app/download.
  // snapshotMatches() decides whether an interrupted download may be RESUMED
  // by comparing URLs and nothing else — so the previous build's half-finished
  // file matched the new build, was resumed, and the app appended new bytes to
  // an old partial and opened the installer on the result. On connections
  // where a 40 MB download is routinely interrupted, which is the whole reason
  // the resume machinery exists, this is the common case, not a rare one.
  const m = U.parseServerManifest({ version: 297, size: 1, sha256: 'x' });
  assert.ok(/[?&]v=297\b/.test(m.url),
    'the fallback URL is the same for every build, so a stale partial resumes');
  // An explicit url from the server is still honoured — that is where the
  // version-stamped URL normally comes from.
  const given = U.parseServerManifest({ version: 297, url: '/app/download?v=297' });
  assert.strictEqual(given.url, '/app/download?v=297');
});

test('…and the server stamps the version into the url it advertises', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const code = server.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  assert.ok(/url: `\/app\/download\?v=\$\{m\.version\}`/.test(code),
    'the server advertises a constant download URL, so partials resume across builds');
  // And nothing between the server and the phone may keep a copy of a path
  // whose contents are replaced on every build.
  assert.ok(/Cache-Control', 'no-store'/.test(code),
    'the APK path is cacheable, so an intermediary can serve the previous build');
});

// ── Verifying what actually landed ──────────────────────────────────────────

test('THE UNUSED FIELD: the declared size is finally checked', () => {
  // The manifest has always carried an exact size and a sha256, and nothing
  // ever read either. A short file therefore reached Android's installer,
  // where a failure looks like "the update did nothing".
  assert.strictEqual(U.bytesLookRight({ actualBytes: 100, declaredBytes: 100 }), true);
  assert.strictEqual(U.bytesLookRight({ actualBytes: 99, declaredBytes: 100 }), false,
    'a truncated download would still be handed to the installer');
  assert.strictEqual(U.bytesLookRight({ actualBytes: 101, declaredBytes: 100 }), false,
    'a resumed stale partial is LONGER than the build, and must not pass');
});

test('…but an unknown declared size does not block the update', () => {
  // GitHub's fallback has no size. Refusing every update from that source
  // would be worse than not checking at all.
  assert.strictEqual(U.bytesLookRight({ actualBytes: 100, declaredBytes: null }), true);
  assert.strictEqual(U.bytesLookRight({ actualBytes: 100, declaredBytes: 0 }), true);
  assert.strictEqual(U.bytesLookRight({ actualBytes: 100, declaredBytes: undefined }), true);
  // A declared size with nothing on disk is still a failure.
  assert.strictEqual(U.bytesLookRight({ actualBytes: 0, declaredBytes: 100 }), false);
  assert.strictEqual(U.bytesLookRight({ actualBytes: null, declaredBytes: 100 }), false);
  assert.strictEqual(U.bytesLookRight(null), true);
});

test('THE CHECK IS WIRED, and a bad file is DELETED rather than kept', () => {
  // Keeping it is the bug all over again: the next attempt would resume the
  // bad file and arrive at the same place.
  const up = fs.readFileSync(path.join(__dirname, '..', 'native-app', 'src', 'appUpdate.ts'), 'utf8');
  const code = up.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  const i = code.indexOf("if (!res?.uri) throw new Error('no file');");
  assert.ok(i > 0, 'the download completion path moved');
  const done = code.slice(i, code.indexOf('await install(', i));
  assert.ok(/bytesLookRight\(/.test(done),
    'the downloaded file is installed without checking it is the build we asked for');
  assert.ok(/deleteAsync/.test(done),
    'a bad download is left on disk, so the next attempt resumes it');
  assert.ok(done.indexOf('bytesLookRight') < done.indexOf('DOWNLOADED_KEY'),
    'the file is recorded as a ready-to-install build before it has been checked');
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
fs.rmSync(OUT, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
