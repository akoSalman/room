// Playing a SoundCloud, YouTube or Aparat link inside the app.
//
// Asked for as: music from SoundCloud and other music or video platforms
// should be playable in the app if it is possible.
//
// What is possible is the platform's OWN embedded player — a page they publish
// for exactly this purpose, serving their own media. What is deliberately not
// done is pulling the audio file out of the page and streaming it through our
// server: it is against the terms of every one of these platforms, it would
// put a brand's server in the business of redistributing other people's music,
// and one popular track would cost more bandwidth than the chat does in a
// month.
//
// So most of this file is about NOT offering a play button that leads nowhere:
// a channel, a playlist page, somebody's profile, a search.
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const NAT = path.join(ROOT, 'native-app');
const TSC = path.join(NAT, 'node_modules', '.bin', 'tsc');

global.window = global;
require(path.join(ROOT, 'public', 'js', 'mediaEmbed.js'));
const W = global.window.MediaEmbed;

let A = null;
if (fs.existsSync(TSC)) {
  const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'embed-'));
  execFileSync(TSC, [path.join(NAT, 'src', 'mediaEmbed.ts'),
    '--outDir', OUT, '--module', 'commonjs', '--target', 'es2019', '--skipLibCheck'], { stdio: 'pipe' });
  A = require(path.join(OUT, 'mediaEmbed.js'));
  process.on('exit', () => fs.rmSync(OUT, { recursive: true, force: true }));
} else {
  console.log('  ! app-side rules skipped (native-app deps not installed); web copy still checked');
}

const tests = [];
const test = (n, f) => tests.push({ n, f });

// ── What plays ──────────────────────────────────────────────────────────────

test('THE POINT: a SoundCloud track plays in the app', () => {
  const m = W.detect('https://soundcloud.com/artist-name/some-track');
  assert.ok(m, 'a SoundCloud link is still just a link');
  assert.strictEqual(m.platform, 'soundcloud');
  assert.strictEqual(m.kind, 'audio', 'a track was going to be given a 16:9 video box');
  assert.ok(m.embed.startsWith('https://w.soundcloud.com/player/'), m.embed);
  // The widget resolves the track from its URL — there is no id to extract.
  assert.ok(m.embed.includes(encodeURIComponent('https://soundcloud.com/artist-name/some-track')), m.embed);
});

test('a YouTube link plays, in every shape people send them', () => {
  const ids = [
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://youtu.be/dQw4w9WgXcQ',
    'https://m.youtube.com/watch?v=dQw4w9WgXcQ&feature=share',
    'https://www.youtube.com/shorts/dQw4w9WgXcQ',
    'https://www.youtube.com/embed/dQw4w9WgXcQ',
    'https://www.youtube.com/live/dQw4w9WgXcQ',
  ];
  for (const u of ids) {
    const m = W.detect(u);
    assert.ok(m, `${u} does not play`);
    assert.ok(m.embed.includes('/embed/dQw4w9WgXcQ'), `${u} → ${m && m.embed}`);
  }
});

test('an Aparat link plays — the one on this list that is reachable here', () => {
  const m = W.detect('https://www.aparat.com/v/aB3xY');
  assert.ok(m && m.platform === 'aparat', 'the local platform is the one that does not play');
  assert.ok(m.embed.includes('videohash/aB3xY'), m.embed);
  assert.strictEqual(W.localToIran('aparat'), true);
  assert.strictEqual(W.localToIran('youtube'), false);
});

test('Vimeo, Dailymotion and Spotify play too', () => {
  assert.ok(W.detect('https://vimeo.com/123456789').embed.includes('player.vimeo.com/video/123456789'));
  assert.ok(W.detect('https://dai.ly/x8abcde').embed.includes('/embed/video/x8abcde'));
  assert.ok(W.detect('https://www.dailymotion.com/video/x8abcde').embed.includes('/embed/video/x8abcde'));
  const sp = W.detect('https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT');
  assert.strictEqual(sp.kind, 'audio');
  assert.ok(sp.embed.includes('/embed/track/4cOdK2wGLETKBW3PvgPWqT'), sp.embed);
});

test('THE OTHER HALF: a page with nothing to play gets no play button', () => {
  // A play button that opens an empty player is worse than no play button.
  for (const u of [
    'https://www.youtube.com/channel/UCabcdef',
    'https://www.youtube.com/@somebody',
    'https://www.youtube.com/results?search_query=music',
    'https://www.youtube.com/playlist?list=PL123',
    'https://soundcloud.com/artist-name',
    'https://soundcloud.com/search?q=music',
    'https://soundcloud.com/discover/sets/x',
    'https://vimeo.com/channels/staffpicks',
    'https://www.aparat.com/somebody',
    'https://open.spotify.com/artist/abc',
    'https://example.com/song.mp3',
    'https://bbc.com/news',
    'not a url', '', null,
  ]) {
    assert.strictEqual(W.detect(u), null, `${u} was offered as playable`);
  }
});

test('a YouTube id that is not a YouTube id is refused', () => {
  // Eleven characters, always. Anything else is a path we have misread.
  assert.strictEqual(W.detect('https://youtu.be/short'), null);
  assert.strictEqual(W.detect('https://www.youtube.com/watch?v=way-too-long-to-be-an-id'), null);
  assert.ok(W.detect('https://youtu.be/dQw4w9WgXcQ'));
});

test('the moment the sender linked to is kept', () => {
  // Sending "listen from 1:30" and having it start at zero loses the point of
  // the message.
  assert.strictEqual(W.detect('https://youtu.be/dQw4w9WgXcQ?t=90').start, 90);
  assert.strictEqual(W.detect('https://youtu.be/dQw4w9WgXcQ?t=1m30s').start, 90);
  assert.strictEqual(W.detect('https://youtu.be/dQw4w9WgXcQ?t=1h2m3s').start, 3723);
  assert.ok(W.detect('https://youtu.be/dQw4w9WgXcQ?t=90').embed.includes('start=90'));
  assert.strictEqual(W.detect('https://youtu.be/dQw4w9WgXcQ').start, 0);
  assert.ok(!W.detect('https://youtu.be/dQw4w9WgXcQ').embed.includes('start='));
  // Nonsense in the parameter is not a start time.
  assert.strictEqual(W.detect('https://youtu.be/dQw4w9WgXcQ?t=soon').start, 0);
});

test('a non-web scheme is never turned into a player', () => {
  assert.strictEqual(W.detect('javascript:alert(1)'), null);
  assert.strictEqual(W.detect('file:///etc/passwd'), null);
  assert.strictEqual(W.detect('data:text/html,<script>'), null);
  // The one that matters, because it gets PAST the host check: a URL parser
  // reads `javascript://youtu.be/dQw4w9WgXcQ` as host youtu.be with an
  // eleven-character path. Detected, it would be handed to the browser and to
  // the card's "open" link as a javascript: URL.
  assert.strictEqual(W.detect('javascript://youtu.be/dQw4w9WgXcQ'), null,
    'a script URL was recognised as a YouTube video');
  assert.strictEqual(W.detect('data://open.spotify.com/track/abc'), null);
});

test('the embed is always the platform, never a URL from the message', () => {
  // The player address is BUILT from an id we have validated, so a crafted
  // link cannot point the web view at a page of its own.
  for (const u of ['https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://vimeo.com/123456789', 'https://www.aparat.com/v/aB3xY',
    'https://dai.ly/x8abcde', 'https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT']) {
    const host = new URL(W.detect(u).embed).hostname;
    assert.ok(/(?:youtube-nocookie|vimeo|aparat|dailymotion|spotify)\.com$/.test(host), host);
  }
  // SoundCloud is the exception in form but not in kind: the widget is ours to
  // point at, and what goes INTO it is a soundcloud.com path we rebuilt.
  const sc = W.detect('https://soundcloud.com/a/b?x=evil');
  assert.strictEqual(new URL(sc.embed).hostname, 'w.soundcloud.com');
  assert.strictEqual(new URL(sc.embed).searchParams.get('url'), 'https://soundcloud.com/a/b');
});

// ── What the user is told ───────────────────────────────────────────────────

test('the button says what will happen, in the platform\'s name', () => {
  assert.strictEqual(W.playLabel(W.detect('https://soundcloud.com/a/b')), 'Play on SoundCloud');
  assert.strictEqual(W.playLabel(W.detect('https://youtu.be/dQw4w9WgXcQ')), 'Watch on YouTube');
  assert.strictEqual(W.playLabel(null), '');
});

test('a player that does not load blames the connection, not the app', () => {
  // A blank black rectangle is how somebody decides the app is broken. Here
  // the reason is almost always that the platform cannot be reached, and that
  // has an answer.
  const yt = W.failureMessage(W.detect('https://youtu.be/dQw4w9WgXcQ'));
  assert.ok(/could not be reached/i.test(yt), yt);
  assert.ok(/browser/i.test(yt), 'no way out is offered');
  // Aparat is reachable here, so "blocked" would be a lie.
  const ap = W.failureMessage(W.detect('https://www.aparat.com/v/aB3xY'));
  assert.ok(!/could not be reached from this connection/i.test(ap), ap);
  assert.ok(/try again/i.test(ap), ap);
});

test('an audio widget is not given a 16:9 box of black', () => {
  assert.strictEqual(W.playerHeight('audio', 720), 166);
  assert.strictEqual(W.playerHeight('video', 720), 405);
});

test('the app and the web agree, link by link', () => {
  if (!A) return;
  const links = [
    'https://soundcloud.com/artist/track', 'https://soundcloud.com/artist',
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'https://youtu.be/dQw4w9WgXcQ?t=1m30s',
    'https://www.youtube.com/shorts/dQw4w9WgXcQ', 'https://www.youtube.com/@user',
    'https://vimeo.com/123456789', 'https://www.aparat.com/v/aB3xY',
    'https://dai.ly/x8abcde', 'https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT',
    'https://bbc.com/news', 'javascript:alert(1)', '', null,
  ];
  let checked = 0;
  for (const u of links) {
    assert.deepStrictEqual(W.detect(u), A.detect(u), `detect disagrees for ${u}`);
    assert.strictEqual(W.playable(u), A.playable(u));
    assert.strictEqual(W.playLabel(W.detect(u)), A.playLabel(A.detect(u)));
    assert.strictEqual(W.failureMessage(W.detect(u)), A.failureMessage(A.detect(u)));
    checked++;
  }
  assert.strictEqual(checked, links.length, 'the drift check did not actually run');
  assert.deepStrictEqual(W.PLATFORM_NAMES, A.PLATFORM_NAMES);
  assert.strictEqual(W.playerHeight('audio', 300), A.playerHeight('audio', 300));
  assert.strictEqual(W.playerHeight('video', 300), A.playerHeight('video', 300));
});

// ── The wiring ──────────────────────────────────────────────────────────────

const card = fs.readFileSync(path.join(NAT, 'src', 'components', 'LinkCard.tsx'), 'utf8');
const player = fs.readFileSync(path.join(NAT, 'src', 'components', 'MediaEmbedPlayer.tsx'), 'utf8');
const app = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');

test('tapping a playable card opens the player instead of the browser', () => {
  assert.ok(/if \(media\) \{ setPlaying\(true\); return; \}/.test(card),
    'a SoundCloud link still throws the user out into a browser');
  assert.ok(card.includes('<MediaEmbedPlayer'), 'nothing ever renders the player');
});

test('a playable link gets a card even when the preview could not be fetched', () => {
  // Where these platforms are blocked the server cannot read their pages
  // either — losing the play button with the cover would remove the feature
  // exactly where it is most wanted.
  assert.ok(/if \(!url \|\| \(!worthShowing\(meta\) && !media\)\) return null;/.test(card),
    'no preview means no play button');
  assert.ok(/PLATFORM_NAMES\[media\.platform\]/.test(card), 'such a card would have no title at all');
  const fn = app.slice(app.indexOf('async function attachLinkCard'), app.indexOf('function openEmbedPlayer'));
  assert.ok(/if \(!meta && !media\) return;/.test(fn), 'the web drops the card when the preview fails');
});

test('the web view is a player, not a browser', () => {
  // Nobody should end up signing in to an account inside a chat app's window.
  assert.ok(/onShouldStartLoadWithRequest=\{\(req\)/.test(player),
    'the web view will follow any link inside the player');
  assert.ok(/Linking\.openURL\(req\.url\)/.test(player), 'a tapped link goes nowhere at all');
});

test('and it says why when nothing loads', () => {
  assert.ok(/onError=\{\(\) => \{ setLoading\(false\); setFailed\(true\); \}\}/.test(player),
    'a failed player spins forever');
  assert.ok(player.includes('failureMessage(media)'), 'the failure is described in the component');
  assert.ok(/onHttpError/.test(player), 'a 404 from the platform is not treated as a failure');
});

test('the web plays it in a dialog, from the same rules', () => {
  assert.ok(app.includes('function openEmbedPlayer'), 'the web has no player');
  const fn = app.slice(app.indexOf('function openEmbedPlayer'), app.indexOf('function openEmbedPlayer') + 2500);
  assert.ok(fn.includes('frame.src = media.embed'), 'the iframe is pointed somewhere else');
  assert.ok(fn.includes("frame.referrerPolicy = 'no-referrer'"), 'the player is told where the reader came from');
  assert.ok(fn.includes('MediaEmbed.playerHeight('), 'the web sizes the player its own way');
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  assert.ok(html.includes('/js/mediaEmbed.js'), 'the rules are never loaded by the page');
});

test('the web view dependency is declared, or none of this exists', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(NAT, 'package.json'), 'utf8'));
  assert.ok(pkg.dependencies['react-native-webview'], 'react-native-webview is not a dependency');
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
