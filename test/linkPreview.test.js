// Previews for links sent in chats and rooms.
//
// Asked for as: "Add preview of cover and title for sent links in chats or
// rooms."
//
// Two halves, and the dangerous half is the server's. An endpoint that fetches
// a URL a user hands it is a request-forgery machine sitting inside whatever
// network the server is on, so most of this file is about what it REFUSES to
// fetch: loopback, the RFC1918 ranges, the cloud metadata address, and a public
// host that redirects to any of them.
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const NAT = path.join(ROOT, 'native-app');
const TSC = path.join(NAT, 'node_modules', '.bin', 'tsc');
const M = require(path.join(ROOT, 'linkMeta.js'));

// The web's copy, loaded the way the browser loads it.
global.window = global;
require(path.join(ROOT, 'public', 'js', 'linkPreview.js'));
const W = global.window.LinkPreview;

let P = null;   // the app's rules, when the native deps are installed
if (fs.existsSync(TSC)) {
  const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'linkprev-'));
  execFileSync(TSC, [path.join(NAT, 'src', 'linkPreview.ts'),
    '--outDir', OUT, '--module', 'commonjs', '--target', 'es2019', '--skipLibCheck'], { stdio: 'pipe' });
  P = require(path.join(OUT, 'linkPreview.js'));
  process.on('exit', () => fs.rmSync(OUT, { recursive: true, force: true }));
} else {
  console.log('  ! app-side rules skipped (native-app deps not installed); web copy still checked');
}

const tests = [];
const test = (n, f) => tests.push({ n, f });

// ── Which link gets a card ──────────────────────────────────────────────────

test('THE POINT: a message with a link names the link to preview', () => {
  const tokens = [
    { text: 'look at ', kind: 'text' },
    { text: 'https://example.com/a', kind: 'url' },
  ];
  assert.strictEqual(W.pickUrl(tokens), 'https://example.com/a');
});

test('a message with five links gets ONE card, not five', () => {
  const tokens = ['https://a.com/1', 'https://b.com/2', 'https://c.com/3']
    .map(text => ({ text, kind: 'url' }));
  assert.strictEqual(W.pickUrl(tokens), 'https://a.com/1');
});

test('a message with no link asks for nothing', () => {
  assert.strictEqual(W.pickUrl([{ text: 'hello', kind: 'text' }]), null);
  assert.strictEqual(W.pickUrl([{ text: '07701234567', kind: 'phone' }]), null);
  assert.strictEqual(W.pickUrl([]), null);
  assert.strictEqual(W.pickUrl(null), null);
});

test('a typed domain becomes a real URL', () => {
  // The tokenizer marks "example.com" as a url; a fetch needs a scheme.
  assert.strictEqual(W.normalizeUrl('example.com'), 'https://example.com/');
  assert.strictEqual(W.normalizeUrl('www.bbc.com/persian'), 'https://www.bbc.com/persian');
});

test('#section is the same page, so it is not asked about twice', () => {
  assert.strictEqual(W.normalizeUrl('https://a.com/x#top'), 'https://a.com/x');
});

test('things that are not pages are never asked about', () => {
  // Each of these would cost a round trip per message for a card that can
  // never appear.
  for (const u of ['https://a.com/photo.jpg', 'https://a.com/clip.MP4',
    'https://a.com/doc.pdf', 'https://a.com/app.apk', 'https://a.com/x.png?w=2']) {
    assert.strictEqual(W.previewable(u), false, `${u} was going to be fetched`);
  }
  assert.strictEqual(W.previewable('https://a.com/photos/holiday'), true);
});

test('non-web links, IP addresses and credentials are refused before anything is sent', () => {
  for (const u of ['mailto:me@a.com', 'tel:+9647701', 'javascript:alert(1)',
    'file:///etc/passwd', 'http://127.0.0.1/x', 'http://192.168.1.1/',
    'https://user:pw@a.com/', 'localhost', 'not a url']) {
    assert.strictEqual(W.normalizeUrl(u), null, `${u} was accepted`);
  }
});

// ── Whether the answer is worth drawing ─────────────────────────────────────

test('a title alone, or a cover alone, still makes a card', () => {
  assert.strictEqual(W.worthShowing({ title: 'BBC Persian' }), true);
  assert.strictEqual(W.worthShowing({ image: '/link-image/abc' }), true);
});

test('but nothing at all does NOT draw an empty grey box', () => {
  // Which is what most sites behind a login return, and is worse than the
  // bare link it would be sitting under.
  assert.strictEqual(W.worthShowing({ title: '   ', description: 'x' }), false);
  assert.strictEqual(W.worthShowing({}), false);
  assert.strictEqual(W.worthShowing(null), false);
});

test('a long title is cut at a word, not mid-word', () => {
  const t = W.trimTitle('Iran and the region: what the new agreement actually says about energy exports', 40);
  assert.ok(t.length <= 41, t);
  assert.ok(t.endsWith('…'));
  assert.ok(!/\s…$/.test(t), 'a space was left before the ellipsis');
  assert.ok(t.startsWith('Iran and the region'), t);
});

test('a short title is left exactly alone', () => {
  assert.strictEqual(W.trimTitle('BBC News'), 'BBC News');
  assert.strictEqual(W.trimTitle('  spaced   out  '), 'spaced out');
  assert.strictEqual(W.trimTitle(null), '');
});

test('the source line is the site name, or the host without www.', () => {
  assert.strictEqual(W.displayHost({ siteName: 'BBC', url: 'https://www.bbc.com/x' }), 'BBC');
  assert.strictEqual(W.displayHost({ url: 'https://www.bbc.com/x' }), 'bbc.com');
  assert.strictEqual(W.displayHost({ url: 'not a url' }), '');
});

test('a failed preview is not retried on every redraw', () => {
  // A blocked host fails for every message carrying the link; retrying per
  // render is a tight loop against a host that is not answering.
  const now = 1_000_000;
  assert.strictEqual(W.shouldRetry({ state: 'failed', failedAt: now - 1000, now }), false);
  assert.strictEqual(W.shouldRetry({ state: 'failed', failedAt: now - 11 * 60 * 1000, now }), true);
  assert.strictEqual(W.shouldRetry({ state: 'done', failedAt: 0, now }), false);
  assert.strictEqual(W.shouldRetry({ state: 'loading', now }), false);
});

test('the app and the web agree, input by input', () => {
  if (!P) return;
  const urls = ['example.com', 'https://a.com/x#y', 'http://1.2.3.4/x', 'mailto:a@b.c',
    'https://a.com/p.jpg', 'https://user:pw@a.com', '', null, 'https://xn--mgbh0fb.com/ص',
    'HTTPS://A.COM/X', 'a.com/b?c=d&e=f'];
  let checked = 0;
  for (const u of urls) {
    assert.strictEqual(W.normalizeUrl(u), P.normalizeUrl(u), `normalizeUrl disagrees for ${u}`);
    assert.strictEqual(W.previewable(u), P.previewable(u), `previewable disagrees for ${u}`);
    checked++;
  }
  const metas = [{ title: 'x' }, { image: '/i' }, {}, { title: '  ' },
    { siteName: 'BBC' }, { url: 'https://www.a.com/x' }];
  for (const m of metas) {
    assert.strictEqual(W.worthShowing(m), P.worthShowing(m));
    assert.strictEqual(W.displayHost(m), P.displayHost(m));
    checked++;
  }
  for (const s of ['short', 'x'.repeat(200), 'a b c '.repeat(40), null]) {
    assert.strictEqual(W.trimTitle(s), P.trimTitle(s));
    assert.strictEqual(W.trimDescription(s), P.trimDescription(s));
    checked++;
  }
  assert.strictEqual(checked, urls.length + metas.length + 4, 'the drift check did not run');
});

// ── What the server refuses to fetch ────────────────────────────────────────

test('THE DANGER: the preview endpoint will not fetch a private address', () => {
  for (const u of ['http://127.0.0.1/', 'http://localhost/', 'http://[::1]/',
    'http://169.254.169.254/latest/meta-data/', 'http://10.0.0.5/',
    'http://192.168.0.1/', 'http://172.16.3.4/', 'http://100.64.0.1/',
    'http://0.0.0.0/', 'http://db.internal/', 'http://printer.local/']) {
    assert.strictEqual(M.safeUrl(u), null, `${u} would have been fetched`);
  }
});

test('every private range is recognised, including the v6 disguises', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.4.5', '172.16.0.1', '172.31.255.255',
    '169.254.169.254', '100.64.1.1', '0.0.0.0', '224.0.0.1', '255.255.255.255',
    '::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', '::ffff:127.0.0.1',
    '::ffff:10.0.0.1', 'not-an-ip', '']) {
    assert.strictEqual(M.isPrivateIp(ip), true, `${ip} was treated as public`);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '192.169.0.1', '99.1.1.1',
    '2606:4700::1111', '::ffff:8.8.8.8']) {
    assert.strictEqual(M.isPrivateIp(ip), false, `${ip} was treated as private`);
  }
});

test('a host that does not resolve is not fetched', async () => {
  assert.strictEqual(await M.hostIsPublic('no-such-host-2f8a1c3d.example-not-real.com'), false);
});

test('an ordinary public link passes the textual fence', () => {
  // The guard is only worth anything if it still lets real links through.
  assert.strictEqual(M.safeUrl('https://www.bbc.com/persian'), 'https://www.bbc.com/persian');
  assert.strictEqual(M.safeUrl('https://a.com/x#frag'), 'https://a.com/x');
  assert.strictEqual(M.safeUrl('ftp://a.com/x'), null);
});

test('redirects are followed BY HAND, so each hop is checked again', () => {
  // A public host that 302s to 169.254.169.254 is the classic way past a
  // guard that only checks the URL it was given.
  const src = fs.readFileSync(path.join(ROOT, 'linkMeta.js'), 'utf8');
  const fn = src.slice(src.indexOf('async function guardedFetch'), src.indexOf('async function readCapped'));
  assert.ok(fn.includes("redirect: 'manual'"), 'redirects are followed by fetch itself, unchecked');
  assert.ok(fn.includes('hostIsPublic(u.hostname)'), 'no hop is checked against DNS');
  assert.ok(/current = safeUrl\(/.test(fn), 'the redirect target skips the textual fence');
  assert.ok(fn.includes('MAX_REDIRECTS'), 'a redirect loop has nothing to stop it');
});

test('the body is capped as it arrives, not trusted to Content-Length', () => {
  const src = fs.readFileSync(path.join(ROOT, 'linkMeta.js'), 'utf8');
  assert.ok(/for await \(const chunk of res\.body\)/.test(src),
    'the whole body is buffered, so a server that streams forever fills memory');
  assert.ok(/if \(total > max\) break/.test(src), 'nothing stops the read');
});

// ── Reading the page ────────────────────────────────────────────────────────

test('THE POINT: the title and the cover come out of the Open Graph tags', () => {
  const meta = M.parseMeta(`<html><head>
    <meta property="og:title" content="A day in Sanandaj">
    <meta property="og:description" content="What we saw">
    <meta property="og:image" content="/img/cover.jpg">
    <meta property="og:site_name" content="Rudaw">
    <title>ignored when og is there</title>
  </head><body></body></html>`, 'https://rudaw.net/story/1');
  assert.strictEqual(meta.title, 'A day in Sanandaj');
  assert.strictEqual(meta.description, 'What we saw');
  assert.strictEqual(meta.siteName, 'Rudaw');
  assert.strictEqual(meta.image, 'https://rudaw.net/img/cover.jpg',
    'a relative cover was left relative, which is a broken picture');
});

test('a page with no og tags still gives up its <title>', () => {
  // Most of the web, still.
  const meta = M.parseMeta('<html><head><title>  Plain   page </title></head>', 'https://a.com/');
  assert.strictEqual(meta.title, 'Plain page');
  assert.strictEqual(meta.image, '');
});

test('name=, property= and single quotes are all read', () => {
  // Attribute order and quoting vary wildly in the wild.
  const meta = M.parseMeta(`<head>
    <meta content='Twitter title' name='twitter:title'>
    <meta name=description content=Bare>
    <meta property="twitter:image" content="https://cdn.a.com/i.png"></head>`, 'https://a.com/');
  assert.strictEqual(meta.title, 'Twitter title');
  assert.strictEqual(meta.description, 'Bare');
  assert.strictEqual(meta.image, 'https://cdn.a.com/i.png');
});

test('the FIRST og:image wins', () => {
  // Pages repeat og:image for every picture on the page; the first is the one
  // they mean as the cover.
  const meta = M.parseMeta(`<head>
    <meta property="og:image" content="https://a.com/1.jpg">
    <meta property="og:image" content="https://a.com/2.jpg"></head>`, 'https://a.com/');
  assert.strictEqual(meta.image, 'https://a.com/1.jpg');
});

test('entities in a title are decoded, not shown raw', () => {
  const meta = M.parseMeta('<head><meta property="og:title" content="Tom &amp; Jerry &#8212; &quot;live&quot;"></head>', 'https://a.com/');
  assert.strictEqual(meta.title, 'Tom & Jerry — "live"');
});

test('og tags in the BODY are not og tags', () => {
  // Otherwise a user-posted comment containing a meta tag sets the card's
  // title on a page that is not theirs.
  const meta = M.parseMeta(`<head><title>Real</title></head>
    <body><meta property="og:title" content="Injected"></body>`, 'https://a.com/');
  assert.strictEqual(meta.title, 'Real');
});

test('nonsense in, nothing out — no throw', () => {
  for (const html of ['', null, '<<<>>>', '<meta property="og:image" content="::::">']) {
    const meta = M.parseMeta(html, 'https://a.com/');
    assert.strictEqual(typeof meta.title, 'string');
  }
});

// ── The cover, kept here ────────────────────────────────────────────────────

test('a cached cover is served by key, and only by key', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'linkimg-'));
  const key = M.keyFor('https://a.com/cover.jpg');
  fs.writeFileSync(path.join(dir, `${key}.img`), 'JPEGBYTES');
  fs.writeFileSync(path.join(dir, `${key}.type`), 'image/jpeg');
  const found = M.imagePath(key, dir);
  assert.ok(found && found.type === 'image/jpeg', 'a cached cover could not be served');
  // A path from the client must never reach the filesystem. Including one that
  // WOULD find a real file: a key is a hash, and anything else is an attempt.
  fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'escaped.img'), 'JPEGBYTES');
  fs.writeFileSync(path.join(dir, 'escaped.type'), 'image/jpeg');
  for (const bad of ['../escaped', 'sub/../escaped', '../../server', 'abc', '', null,
    `${key}/../../x`, key.toUpperCase()]) {
    assert.strictEqual(M.imagePath(bad, path.join(dir, 'sub')), null, `${bad} was accepted as a key`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a cover that is not an image is not served as one', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'linkimg2-'));
  const key = M.keyFor('https://a.com/x');
  fs.writeFileSync(path.join(dir, `${key}.img`), '<script>alert(1)</script>');
  fs.writeFileSync(path.join(dir, `${key}.type`), 'text/html');
  assert.strictEqual(M.imagePath(key, dir), null, 'HTML would have been served from an <img> src');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── The cache ───────────────────────────────────────────────────────────────

test('a cached preview is returned without going near the network', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'linkcache-'));
  const url = 'https://a.example.com/story';
  const key = M.keyFor(url);
  fs.writeFileSync(path.join(dir, `${key}.json`), JSON.stringify({
    at: Date.now(), ok: true, imageKey: null,
    data: { url, title: 'Cached title', description: '', siteName: '', image: '' },
  }));
  const got = await M.preview(url, { dir });
  assert.strictEqual(got.ok, true);
  assert.strictEqual(got.title, 'Cached title');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a cached FAILURE is remembered too, so a blocked site is not refetched', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'linkcache2-'));
  const url = 'https://blocked.example.com/x';
  fs.writeFileSync(path.join(dir, `${M.keyFor(url)}.json`),
    JSON.stringify({ at: Date.now(), ok: false, reason: 'unreadable' }));
  const got = await M.preview(url, { dir });
  assert.strictEqual(got.ok, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an expired entry is not used', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'linkcache3-'));
  const url = 'https://no-such-host-2f8a1c3d.example-not-real.com/x';
  fs.writeFileSync(path.join(dir, `${M.keyFor(url)}.json`), JSON.stringify({
    at: Date.now() - 30 * 24 * 3600 * 1000, ok: true, imageKey: null,
    data: { url, title: 'Stale', image: '' },
  }));
  const got = await M.preview(url, { dir });
  // The host does not resolve, so the refetch fails — which is the proof that
  // a refetch was attempted rather than the week-old answer being served.
  assert.strictEqual(got.ok, false, 'a month-old preview was served as current');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a hit whose cover has been swept off disk is fetched again', async () => {
  // Otherwise a cleanup leaves every card with a broken picture for a week.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'linkcache4-'));
  const url = 'https://no-such-host-2f8a1c3d.example-not-real.com/y';
  fs.writeFileSync(path.join(dir, `${M.keyFor(url)}.json`), JSON.stringify({
    at: Date.now(), ok: true, imageKey: M.keyFor('https://a.com/gone.jpg'),
    data: { url, title: 'Has a cover', image: '/link-image/x' },
  }));
  const got = await M.preview(url, { dir });
  assert.strictEqual(got.ok, false, 'a card was served pointing at a cover that is gone');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a refused URL never reaches the cache or the network', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'linkcache5-'));
  const got = await M.preview('http://169.254.169.254/latest/meta-data/', { dir });
  assert.strictEqual(got.ok, false);
  assert.strictEqual(got.reason, 'refused');
  assert.deepStrictEqual(fs.readdirSync(dir), [], 'a refused URL was written to the cache');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('old covers and previews are swept, and fresh ones are not', () => {
  // Every link anybody ever sends leaves a cover on disk otherwise, and a chat
  // server whose disk fills up takes the whole thing down.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'linksweep-'));
  const old = path.join(dir, 'old.img');
  const fresh = path.join(dir, 'fresh.img');
  fs.writeFileSync(old, 'x'); fs.writeFileSync(fresh, 'x');
  const longAgo = Date.now() / 1000 - 60 * 24 * 3600;
  fs.utimesSync(old, longAgo, longAgo);
  assert.strictEqual(M.sweep(30 * 24 * 3600 * 1000, dir), 1);
  assert.strictEqual(fs.existsSync(old), false, 'a month-old cover was kept');
  assert.strictEqual(fs.existsSync(fresh), true, 'a cover still in use was deleted');
  assert.strictEqual(M.sweep(30 * 24 * 3600 * 1000, '/no/such/dir'), 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('and the server actually runs that sweep', () => {
  assert.ok(/setInterval\(\(\) => linkMeta\.sweep\(\)/.test(
    fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8')),
    'the cache grows forever');
});

// ── The endpoints ───────────────────────────────────────────────────────────

const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

test('the preview endpoint requires a signed-in user', () => {
  assert.ok(/app\.get\('\/link-preview', authMiddleware/.test(server),
    'anyone at all can make this server fetch a URL');
});

test('and it never hands back a foreign image URL', () => {
  // A card whose picture comes straight from the site is a broken image for
  // these users, and tells that host who is reading the message.
  assert.ok(/image: imageKey \? `\/link-image\/\$\{imageKey\}` : ''/.test(
    fs.readFileSync(path.join(ROOT, 'linkMeta.js'), 'utf8')),
    'the cover is passed through as the original URL');
});

test('one fetch serves everybody who asks at the same moment', () => {
  // A room of thirty people opens the same message at once.
  const slice = server.slice(server.indexOf("app.get('/link-preview'"), server.indexOf("app.get('/link-image/"));
  assert.ok(slice.includes('linkInFlight.get(url)'), 'each viewer causes its own outbound fetch');
  assert.ok(slice.includes('LINK_MAX_INFLIGHT'), 'a burst of links becomes a burst of connections');
  assert.ok(slice.includes('linkInFlight.delete(url)'), 'the in-flight map is never cleared, so it leaks');
});

test('the cover is served with the headers that stop it being a page', () => {
  const slice = server.slice(server.indexOf("app.get('/link-image/"), server.indexOf("app.get('/link-image/") + 900);
  assert.ok(slice.includes('nosniff'), 'a sniffed content type turns a cover into script');
  assert.ok(slice.includes('imagePath('), 'the key is turned into a path by hand');
});

// ── The wiring, which no unit test can reach ────────────────────────────────

test('the chat bubble actually draws a card', () => {
  const chat = fs.readFileSync(path.join(NAT, 'src', 'screens', 'ChatScreen.tsx'), 'utf8');
  assert.ok(/<LinkCard content=\{msg\.content\}/.test(chat), 'no card is rendered under a message');
  assert.ok(chat.includes("import LinkCard from '../components/LinkCard'"), 'LinkCard is not imported');
  assert.ok(/onPress=\{run => tokenPress\(run\)\}/.test(chat),
    'tapping the card also opens the message menu, which is the bug this app keeps having');
});

test('the app asks for each link once, however often the row is redrawn', () => {
  // A chat re-renders constantly and recycles rows as it scrolls; a fetch per
  // render is a request every time a message comes back on screen.
  const card = fs.readFileSync(path.join(NAT, 'src', 'components', 'LinkCard.tsx'), 'utf8');
  assert.ok(/cache\.has\(url\)/.test(card), 'nothing remembers what has already been fetched');
  assert.ok(/inFlight\.get\(url\)/.test(card), 'two rows with the same link cause two fetches');
  assert.ok(/inFlight\.delete\(url\)/.test(card), 'the in-flight map leaks');
});

test('a failure while OFFLINE is not remembered as "this link has no preview"', () => {
  // Otherwise every link that arrived during a dead connection stays blank for
  // as long as the app is open.
  const card = fs.readFileSync(path.join(NAT, 'src', 'components', 'LinkCard.tsx'), 'utf8');
  assert.ok(/if \(meta \|\| \(res && !res\.offline\)\) cache\.set/.test(card),
    'an offline failure is cached as a permanent absence');
});

test('the web draws the same card, from the same rules', () => {
  const app = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');
  assert.ok(app.includes('attachLinkCard(bubble, msg.content'), 'the web never asks for a preview');
  assert.ok(app.includes('LinkPreview.pickUrl('), 'the web picks the link its own way');
  assert.ok(app.includes('LinkPreview.worthShowing('), 'the web draws cards the app would not');
  const fn = app.slice(app.indexOf('async function attachLinkCard'), app.indexOf('// Open a public room'));
  assert.ok(fn.includes('bubble.isConnected'), 'a card is appended to a bubble that has been thrown away');
  assert.ok(fn.includes('e.stopPropagation()'), 'tapping the card also triggers the bubble');
  assert.ok(fn.includes('img.onerror'), 'a swept cover leaves a broken-image icon in the bubble');
  assert.ok(fn.includes('textContent'), 'the card is built with innerHTML from a foreign title');
  assert.ok(!/innerHTML/.test(fn), 'a title from a stranger\'s page is injected as HTML');
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  assert.ok(html.includes('/js/linkPreview.js'), 'the rules are never loaded by the page');
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
