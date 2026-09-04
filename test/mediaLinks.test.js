// The links tab, and the menu on every row.
//
// Reported as: "Profile media menu does not list links, also each file and
// link should have a show in chat in menu."
//
// TWO DIFFERENT THINGS, and the first is the interesting one.
//
//   1. NO LINKS. The tab works in an ordinary room. In a DM it never could,
//      and the reason is the encryption working exactly as designed: the
//      server builds that tab by scanning message text, and an end-to-end
//      encrypted message is ciphertext to it. Its collector skips anything
//      starting with `e2e:`, which in a DM is everything. The tab was not
//      broken — it was permanently empty, and said "No links yet" as though
//      that were a fact about the conversation.
//
//      The device has the key. So the device does the work, exactly as it
//      already does to search an encrypted chat: the server hands over the
//      ciphertext it cannot read, and nothing goes back.
//
//   2. NO MENU. The web's gallery rows were bare links — tapping one opened
//      the file or the web page, and there was no way at all to get back to
//      the message it came from. The app has had "Show in chat" since its
//      browser was written.
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const NAT = path.join(ROOT, 'native-app');
const TSC = path.join(NAT, 'node_modules', '.bin', 'tsc');

global.window = global;
const W = require(path.join(ROOT, 'public', 'js', 'mediaLinks.js'));

let A = null;
if (fs.existsSync(TSC)) {
  const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'medialinks-'));
  execFileSync(TSC, [path.join(NAT, 'src', 'mediaLinks.ts'),
    '--outDir', OUT, '--module', 'commonjs', '--target', 'es2019', '--skipLibCheck'], { stdio: 'pipe' });
  A = require(path.join(OUT, 'mediaLinks.js'));
  process.on('exit', () => fs.rmSync(OUT, { recursive: true, force: true }));
} else {
  console.log('  ! app-side rules skipped (native-app deps not installed); web copy still checked');
}

const tests = [];
const test = (n, f) => tests.push({ n, f });

// ── Finding the links ───────────────────────────────────────────────────────

test('THE BUG: links are found in messages the server cannot read', () => {
  const msgs = [
    { id: 9, content: 'have a look https://example.com/a' },
    { id: 8, content: 'nothing here' },
    { id: 7, content: 'two: soundcloud.com/x/y and https://b.org' },
  ];
  assert.deepStrictEqual(W.linksFrom(msgs), [
    { url: 'https://example.com/a', msgId: 9 },
    { url: 'soundcloud.com/x/y', msgId: 7 },
    { url: 'https://b.org', msgId: 7 },
  ]);
});

test('each link remembers the message it came from', () => {
  // Without this "Show in chat" has nowhere to go, which is the other half of
  // what was asked for.
  const [first] = W.linksFrom([{ id: 42, content: 'https://x.com' }]);
  assert.strictEqual(first.msgId, 42);
});

test('the same link sent twice is listed once, at its most recent sighting', () => {
  // Messages arrive newest-first, so the first sighting is the newest — and
  // the one whose "Show in chat" lands somewhere the reader remembers.
  const out = W.linksFrom([
    { id: 9, content: 'https://x.com again' },
    { id: 3, content: 'https://x.com' },
  ]);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].msgId, 9, 'it jumps to the oldest time the link was sent');
});

test('a chat with nothing but chatter yields nothing', () => {
  assert.deepStrictEqual(W.linksFrom([{ id: 1, content: 'hello there' }]), []);
  assert.deepStrictEqual(W.linksFrom([]), []);
  assert.deepStrictEqual(W.linksFrom(null), []);
  assert.deepStrictEqual(W.linksFrom([{ id: 1 }, { id: 2, content: null }]), []);
});

test('a very chatty history is capped', () => {
  const many = Array.from({ length: 500 }, (_, i) => ({ id: i, content: `https://x.com/${i}` }));
  assert.strictEqual(W.linksFrom(many).length, 200);
  assert.strictEqual(W.linksFrom(many, 5).length, 5);
});

test('the expression is the SERVER\'s, so a room and a DM agree', () => {
  // A link found in a room and the same link found in a DM must produce the
  // same row; two regexes drifting apart would be invisible until somebody
  // compared two chats side by side.
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const m = /^const LINK_RE = \/(.*)\/g;$/m.exec(server);
  assert.ok(m, 'the server no longer has LINK_RE — this check would be vacuous');
  assert.strictEqual(new RegExp(W.LINK_SRC).source, new RegExp(m[1]).source,
    'the device finds different links than the server does');
});

// ── Putting the two lists together ──────────────────────────────────────────

test('a chat can hold both readable and encrypted links', () => {
  // Messages sent before encryption was set up are readable by the server;
  // everything after is not. Neither list contains the other.
  const merged = W.mergeLinks(
    [{ url: 'https://old.com', msgId: 2 }],
    [{ url: 'https://new.com', msgId: 9 }],
  );
  assert.deepStrictEqual(merged, [
    { url: 'https://new.com', msgId: 9 },
    { url: 'https://old.com', msgId: 2 },
  ], 'the two lists are not merged newest-first');
});

test('a link both sides found is listed once', () => {
  const merged = W.mergeLinks(
    [{ url: 'https://x.com', msgId: 4 }],
    [{ url: 'https://x.com', msgId: 7 }],
  );
  assert.strictEqual(merged.length, 1);
  assert.strictEqual(merged[0].msgId, 7, 'the older sighting won');
});

test('a link with no message is kept, not dropped', () => {
  // It is still worth showing; it just cannot offer "Show in chat".
  const merged = W.mergeLinks([{ url: 'https://a.com' }], [{ url: 'https://b.com', msgId: 5 }]);
  assert.strictEqual(merged.length, 2);
  assert.strictEqual(merged[0].url, 'https://b.com', 'an unplaceable link sorted above a real one');
});

test('…but one that IS placed wins over the same link unplaced', () => {
  const merged = W.mergeLinks([{ url: 'https://x.com' }], [{ url: 'https://x.com', msgId: 5 }]);
  assert.deepStrictEqual(merged, [{ url: 'https://x.com', msgId: 5 }]);
});

test('junk in either list does not break the tab', () => {
  assert.deepStrictEqual(W.mergeLinks(null, null), []);
  assert.deepStrictEqual(W.mergeLinks([null, { url: '' }], [undefined]), []);
});

test('the app and the web build the same list', () => {
  if (!A) return;
  let checked = 0;
  const histories = [
    [], [{ id: 1, content: 'https://a.com https://b.com' }],
    [{ id: 5, content: 'x.co/y' }, { id: 4, content: 'x.co/y' }],
    [{ id: 2, content: null }, { id: 1, content: 'no links' }],
    [{ id: 3, content: 'mail me at a@b.com or see https://c.io/d?e=f#g' }],
  ];
  for (const h of histories) {
    assert.deepStrictEqual(W.linksFrom(h), A.linksFrom(h), `linksFrom drifted on ${JSON.stringify(h)}`);
    checked++;
  }
  const pairs = [
    [[], []], [[{ url: 'a', msgId: 1 }], [{ url: 'a', msgId: 2 }]],
    [[{ url: 'a' }], [{ url: 'b', msgId: 3 }]],
    [[{ url: 'a', msgId: 9 }], [{ url: 'b', msgId: 1 }]],
  ];
  for (const [s, l] of pairs) {
    assert.deepStrictEqual(W.mergeLinks(s, l), A.mergeLinks(s, l), 'mergeLinks drifted');
    checked++;
  }
  assert.strictEqual(checked, 9, 'the drift check did not actually run');
  assert.strictEqual(new RegExp(W.LINK_SRC).source, A.LINK_RE.source);
});

// ── The wiring ──────────────────────────────────────────────────────────────

const app = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'public', 'css', 'style.css'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

test('the web decrypts the history the server skipped', () => {
  const fn = app.slice(app.indexOf('async function addEncryptedLinks('), app.indexOf('function closeMedia()'));
  assert.ok(fn.length > 0, 'addEncryptedLinks is gone — this check would be vacuous');
  assert.ok(fn.includes("api('/encrypted-messages/'"), 'the ciphertext is never asked for');
  assert.ok(/E2E\.decrypt\(m\.content, key\)/.test(fn), 'nothing is decrypted, so nothing is found');
  assert.ok(fn.includes('MediaLinks.linksFrom('), 'the browser picks the links out by hand');
  assert.ok(fn.includes('MediaLinks.mergeLinks('), 'the readable links are thrown away');
  assert.ok(/String\(roomId\) !== String\(currentRoomId\)/.test(fn),
    'a slow answer lands in whatever chat is open by then');
  assert.ok(/if \(mediaTab === 'links'\) renderMedia\(\)/.test(fn),
    'the links arrive but the tab is not redrawn, so it still reads "No links yet"');
  assert.ok(app.includes('addEncryptedLinks(roomId)'), 'it is never called');
  assert.ok(html.includes('/js/mediaLinks.js'), 'the rules are never loaded by the page');
});

test('and it happens AFTER the readable links are on screen', () => {
  // A second request, slow on these connections. Waiting for it would make
  // every gallery open slower to fix a tab most people never touch.
  const open = app.slice(app.indexOf('async function openMedia()'), app.indexOf('async function addEncryptedLinks('));
  assert.ok(open.indexOf('renderMedia();') < open.indexOf('addEncryptedLinks(roomId)'),
    'the whole gallery waits for the encrypted history');
});

test('THE MENU: every file, link and audio row has one', () => {
  assert.ok(app.includes('function withRowMenu('), 'there is no row menu at all');
  // All three lists, not just the one that was complained about.
  const renders = app.slice(app.indexOf('function renderMedia()'), app.indexOf('function withRowMenu('));
  const wrapped = renders.match(/withRowMenu\(/g) || [];
  assert.strictEqual(wrapped.length, 3, `only ${wrapped.length} of the three row lists has a menu`);
});

test('and "Show in chat" is in it, and actually jumps', () => {
  const fn = app.slice(app.indexOf('function openMediaRowMenu('), app.indexOf('function openMediaRowMenu(') + 1400);
  assert.ok(fn.length > 0, 'openMediaRowMenu is gone — this check would be vacuous');
  assert.ok(/Show in chat/.test(fn), 'the menu does not offer it');
  assert.ok(/jumpToMessage\(Number\(item\.msgId\)\)/.test(fn), 'it does not go anywhere');
  assert.ok(fn.indexOf('closeMedia()') < fn.indexOf('jumpToMessage('),
    'the gallery stays open over the message it just jumped to');
  assert.ok(/item\.msgId != null/.test(fn),
    'a link whose message is unknown is offered a jump that lands nowhere');
});

test('the ⋮ does not also follow the row it sits on', () => {
  // The rows are anchors. A menu button inside one that does not stop the
  // event opens the file AND the menu.
  const fn = app.slice(app.indexOf('function withRowMenu('), app.indexOf('function openMediaRowMenu('));
  assert.ok(/e\.preventDefault\(\);\s*\n\s*e\.stopPropagation\(\);/.test(fn),
    'tapping the menu also opens the file');
});

test('the sheet closes before it acts', () => {
  const fn = app.slice(app.indexOf('function showSheet('), app.indexOf('function withRowMenu('));
  assert.ok(/b\.onclick = \(\) => \{ close\(\); run\(\); \}/.test(fn),
    'the sheet is left floating over the message it jumped to');
});

test('the menu is a finger-sized target and the sheet clears the home bar', () => {
  const btn = /\.media-row-menu \{([^}]*)\}/.exec(css);
  assert.ok(btn, '.media-row-menu has no rule — this check would be vacuous');
  assert.ok(/min-width:\s*40px/.test(btn[1]) && /height:\s*40px/.test(btn[1]), btn[1]);
  const sheet = /\.row-sheet \{([^}]*)\}/.exec(css);
  assert.ok(sheet && /var\(--sab/.test(sheet[1]), 'the last row sits under the home indicator');
});

test('THE PHOTOS have the same menu the rows do', () => {
  // Reported from an iPhone: media in the gallery has no menu, only links do.
  // The grid cells were bare <img> elements — the ⋮ went on the rows and the
  // photos, which are most of the gallery, were left out.
  const grid = app.slice(app.indexOf("grid.className = 'media-grid'"),
    app.indexOf("body.appendChild(grid)"));
  assert.ok(grid.length > 0, 'the photo grid is gone — this check would be vacuous');
  assert.ok(/media-cell/.test(grid), 'a photo cell has nowhere to put a menu');
  assert.ok(/openMediaRowMenu\(item, 'Photo', 'image'\)/.test(grid),
    'photos in the gallery still have no menu');
  assert.ok(/e\.stopPropagation\(\)/.test(grid),
    'tapping the photo menu also opens the photo underneath it');
  // The menu means what it says for a picture: it views it rather than
  // dumping a bare file into a new tab, and it can be saved.
  const fn = app.slice(app.indexOf('function openMediaRowMenu('),
    app.indexOf('function openMediaRowMenu(') + 2200);
  assert.ok(/kind === 'image'/.test(fn), 'a photo is offered a link menu');
  assert.ok(/🖼 View/.test(fn) && /⬇ Download/.test(fn), 'a photo cannot be viewed or saved');
  assert.ok(/oneTimeMediaUrls\.has\(abs\)/.test(fn),
    'a one-time photo can be downloaded out of the gallery');
});

test('THE SHEET IS ON TOP of whatever opened it', () => {
  // Reported as: tapping the ⋮ puts the menu UNDER the gallery modal. It was
  // there all along at z-index 60, taking the taps, invisible behind a modal
  // at 500 and a lightbox at 2000.
  const overlay = /\.row-sheet-overlay \{([^}]*)\}/.exec(css);
  assert.ok(overlay, '.row-sheet-overlay has no rule — this check would be vacuous');
  const z = /z-index:\s*(\d+)/.exec(overlay[1]);
  assert.ok(z, 'the sheet has no stacking order at all');
  const modal = /\.modal-overlay \{([^}]*)\}/.exec(css);
  const light = /#lightbox \{([^}]*)\}/.exec(css) || [null, ''];
  const zOf = (block) => parseInt((/z-index:\s*(\d+)/.exec(block || '') || [0, 0])[1], 10);
  assert.ok(Number(z[1]) > zOf(modal[1]),
    `the sheet (${z[1]}) is under the gallery modal (${zOf(modal[1])})`);
  assert.ok(Number(z[1]) > zOf(light[1]),
    `the sheet (${z[1]}) is under the lightbox (${zOf(light[1])})`);
});

test('the open photo carries the menu too, and knows its message', () => {
  assert.ok(/function openLightboxMenu\(/.test(app), 'the open picture has no menu');
  const fn = app.slice(app.indexOf('function openLightboxMenu('),
    app.indexOf('function openLightboxMenu(') + 1200);
  assert.ok(/Show in chat/.test(fn) && /jumpToMessage\(Number\(item\.msgId\)\)/.test(fn),
    'the open picture cannot be traced back to its message');
  // Only when it CAME from the gallery: opened from the conversation, the
  // message is already on screen behind the picture.
  assert.ok(/lightboxItems && lightboxItems\[lightboxIdx\]/.test(fn),
    'Show in chat is offered on photos with no known message');
  assert.ok(/lightboxItems = null;/.test(app.slice(app.indexOf('function openLightbox('),
    app.indexOf('function openLightbox(') + 500)),
    'a photo opened from the chat inherits the gallery\'s items');
  assert.ok(/lightboxItems = mediaData\.images/.test(app),
    'the gallery never hands its items to the lightbox');
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  assert.ok(/onclick="event\.stopPropagation\(\); openLightboxMenu\(\)"/.test(html),
    'the button is missing, or its tap closes the lightbox instead');
});

test('THE ⋮ CAN BE SEEN before it is touched', () => {
  // Asked for: highlight it. On a phone there is no hover at all, so a control
  // that only appears on hover is a control nobody knows exists — and this one
  // is the way into every message action.
  const msg = /\.msg-menu-btn \{([^}]*)\}/.exec(css);
  assert.ok(msg, '.msg-menu-btn has no rule — this check would be vacuous');
  assert.ok(!/background:\s*none/.test(msg[1]), 'the message ⋮ is drawn on nothing');
  assert.ok(/background:\s*rgba/.test(msg[1]), 'the message ⋮ has no chip behind it');
  const op = /opacity:\s*([\d.]+)/.exec(msg[1]);
  assert.ok(op && Number(op[1]) >= 0.8, `the message ⋮ is drawn at ${op && op[1]}`);
  const row = /\.media-row-menu \{([^}]*)\}/.exec(css);
  assert.ok(/background:\s*rgba/.test(row[1]), 'the gallery ⋮ is invisible until hovered');
  // Over a photo it needs its own contrast: a translucent grey chip disappears
  // against half the pictures people send.
  const cell = /\.media-cell \.media-row-menu \{([^}]*)\}/.exec(css);
  assert.ok(cell, 'the photo ⋮ has no rule of its own');
  assert.ok(/background:\s*rgba\(0, 0, 0/.test(cell[1]), 'the photo ⋮ can vanish into the photo');
});

test('the app gets the same links, from its own key', () => {
  const src = fs.readFileSync(path.join(NAT, 'src', 'screens', 'ChatScreen.tsx'), 'utf8');
  const fn = src.slice(src.indexOf('async function addEncryptedLinks('), src.indexOf('/** The next page of photos'));
  assert.ok(fn.length > 0, 'the app never looks for encrypted links');
  assert.ok(fn.includes('`/encrypted-messages/${room.id}`'), 'the ciphertext is never asked for');
  assert.ok(/e2eDecrypt\(m\.content, peer\)/.test(fn), 'nothing is decrypted');
  assert.ok(fn.includes('mergeLinks(base.links || [], found)'), 'the readable links are thrown away');
  assert.ok(fn.includes('rm.putCached('), 'the links are lost as soon as the browser is closed');
  assert.ok(src.includes('addEncryptedLinks(next)'), 'it is never called');
});

test('the app already offers Show in chat, and still does', () => {
  const br = fs.readFileSync(path.join(NAT, 'src', 'components', 'MediaBrowser.tsx'), 'utf8');
  assert.ok(/\['showInChat', 'Show in chat'/.test(br), 'the app lost the row it already had');
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
