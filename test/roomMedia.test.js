// The shared-media gallery (native-app/src/roomMedia.ts).
//
// Reported as: "gallery does not work good at all, redesign and implement from
// scratch, it lags all the time, does extra scroll and loads every time
// opening it."
//
// Three complaints, three sets of rules:
//
//  • LOADS EVERY TIME — nothing was remembered between opens, and every open
//    fetched the whole room's media before anything could be drawn.
//  • EXTRA SCROLL — the grid restored its position from an effect that re-ran
//    on tab changes and re-renders, throwing the list around under the user.
//  • LAGS — one list of every photo in the room, measured as it scrolled.
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'roommedia-'));
const SRC = path.join(__dirname, '..', 'native-app', 'src', 'roomMedia.ts');
const TSC = path.join(__dirname, '..', 'native-app', 'node_modules', '.bin', 'tsc');
if (!fs.existsSync(TSC)) {
  console.log('  ! skipping room-media tests (native-app deps not installed)');
  process.exit(0);
}
execFileSync(TSC, [SRC, '--outDir', OUT, '--module', 'commonjs', '--target', 'es2019', '--skipLibCheck'],
  { stdio: 'pipe' });
const M = require(path.join(OUT, 'roomMedia.js'));

const tests = [];
const test = (n, f) => tests.push({ n, f });
const img = (n) => ({ url: `/uploads/p${n}.jpg`, msgId: n, name: 'Photo' });
const imgs = (...ns) => ns.map(img);

// ── Loading a page at a time ────────────────────────────────────────────────

test('a first page becomes what the gallery knows', () => {
  const st = M.fromFirstPage({
    images: imgs(9, 8, 7), files: [], music: [], links: [],
    imagesCursor: 7, imagesHasMore: true,
  }, 1000);
  assert.strictEqual(st.images.length, 3);
  assert.strictEqual(st.imagesCursor, 7);
  assert.strictEqual(st.imagesHasMore, true);
  assert.strictEqual(st.fetchedAt, 1000);
});

test('an old server sending everything at once is not asked for more', () => {
  // No paging fields at all means the whole list arrived. Treating that as
  // "there is more" leaves the grid asking for a page that never comes.
  const st = M.fromFirstPage({ images: imgs(3, 2, 1) });
  assert.strictEqual(st.imagesHasMore, false);
  assert.strictEqual(st.imagesCursor, null);
});

test('bare url strings still work', () => {
  // The endpoint used to send strings; a stale server must not empty the grid.
  const st = M.fromFirstPage({ images: ['/uploads/a.jpg', '/uploads/b.jpg'] });
  assert.deepStrictEqual(st.images.map(i => i.url), ['/uploads/a.jpg', '/uploads/b.jpg']);
});

test('the next page goes on the end, oldest last', () => {
  const first = M.fromFirstPage({ images: imgs(9, 8), imagesCursor: 8, imagesHasMore: true });
  const st = M.appendImages(first, { images: imgs(7, 6), imagesCursor: 6, imagesHasMore: false });
  assert.deepStrictEqual(st.images.map(i => i.msgId), [9, 8, 7, 6]);
  assert.strictEqual(st.imagesCursor, 6);
  assert.strictEqual(st.imagesHasMore, false);
});

test('a photo that arrives on two pages is only kept once', () => {
  // A page boundary moves when something is deleted between two requests.
  // Two copies would also mean two rows with the same key.
  const first = M.fromFirstPage({ images: imgs(9, 8), imagesCursor: 8, imagesHasMore: true });
  const st = M.appendImages(first, { images: imgs(8, 7), imagesCursor: 7, imagesHasMore: true });
  assert.deepStrictEqual(st.images.map(i => i.msgId), [9, 8, 7]);
});

test('one page at a time is only asked for once at a time', () => {
  // The list fires its end-reached callback more than once for one arrival at
  // the end; without the guard that is several requests for the same page.
  assert.strictEqual(M.shouldLoadMore({ hasMore: true, loading: false, itemCount: 90 }), true);
  assert.strictEqual(M.shouldLoadMore({ hasMore: true, loading: true, itemCount: 90 }), false);
  assert.strictEqual(M.shouldLoadMore({ hasMore: false, loading: false, itemCount: 90 }), false);
  // An empty grid fires end-reached on mount, before anything has loaded.
  assert.strictEqual(M.shouldLoadMore({ hasMore: true, loading: false, itemCount: 0 }), false);
});

// ── Not loading every time ──────────────────────────────────────────────────

test('THE BUG: reopening a gallery uses what it already had', () => {
  M.forgetCached();
  const st = M.fromFirstPage({ images: imgs(3, 2, 1) }, 1000);
  M.putCached('room-1', st);
  assert.strictEqual(M.getCached('room-1').images.length, 3);
  // Within the freshness window, opening it again asks the server nothing.
  assert.strictEqual(M.shouldRefresh(M.getCached('room-1'), false, 1000 + 5_000), false);
});

test('a gallery it has never seen is always fetched', () => {
  M.forgetCached();
  assert.strictEqual(M.shouldRefresh(null, false, 1000), true);
});

test('a stale gallery is refreshed', () => {
  const st = M.fromFirstPage({ images: imgs(1) }, 1000);
  assert.strictEqual(M.shouldRefresh(st, false, 1000 + M.MEDIA_TTL_MS), true);
});

test('a photo arriving marks the gallery for refresh but does not empty it', () => {
  // Throwing the cache away would put a spinner back over an open gallery,
  // which is the thing being fixed.
  M.forgetCached();
  M.putCached('room-1', M.fromFirstPage({ images: imgs(2, 1) }, 1000));
  M.markDirty('room-1');
  assert.strictEqual(M.isDirty('room-1'), true);
  assert.strictEqual(M.getCached('room-1').images.length, 2);
  assert.strictEqual(M.shouldRefresh(M.getCached('room-1'), true, 1000), true);
});

test('only messages that change the gallery mark it', () => {
  assert.strictEqual(M.affectsMedia({ type: 'image', file_path: '/uploads/a.jpg' }), true);
  assert.strictEqual(M.affectsMedia({ type: 'gallery' }), true);
  assert.strictEqual(M.affectsMedia({ type: 'video' }), true);
  assert.strictEqual(M.affectsMedia({ type: 'file' }), true);
  assert.strictEqual(M.affectsMedia({ type: 'music' }), true);
  assert.strictEqual(M.affectsMedia({ type: 'text', content: 'look: https://x.com/a' }), true);
  // A chatty room would otherwise throw its gallery away all day long.
  assert.strictEqual(M.affectsMedia({ type: 'text', content: 'سلام، خوبی؟' }), false);
  assert.strictEqual(M.affectsMedia({ type: 'audio' }), false);
  assert.strictEqual(M.affectsMedia(null), false);
});

test('a refresh brings in the new photos and keeps the loaded ones', () => {
  // The user has scrolled through four pages; two new photos have been sent.
  // Reloading page one must not discard pages two to four, or scrolling back
  // down starts over.
  const loaded = M.appendImages(
    M.fromFirstPage({ images: imgs(5, 4, 3), imagesCursor: 3, imagesHasMore: true }, 1000),
    { images: imgs(2, 1), imagesCursor: 1, imagesHasMore: false },
  );
  const st = M.mergeRefresh(loaded, { images: imgs(7, 6, 5, 4, 3), imagesCursor: 3, imagesHasMore: true }, 2000);
  assert.deepStrictEqual(st.images.map(i => i.msgId), [7, 6, 5, 4, 3, 2, 1]);
  // The cursor describes the END of the loaded run; a first page must not
  // rewind it to photos already on screen.
  assert.strictEqual(st.imagesCursor, 1);
  assert.strictEqual(st.imagesHasMore, false);
  assert.strictEqual(st.fetchedAt, 2000);
});

test('a refresh with nothing in common starts clean', () => {
  // Away long enough, or a bulk delete: better a clean reload than a list
  // with a hole in the middle of it.
  const loaded = M.fromFirstPage({ images: imgs(3, 2, 1), imagesCursor: 1, imagesHasMore: false }, 1000);
  const st = M.mergeRefresh(loaded, { images: imgs(90, 89), imagesCursor: 89, imagesHasMore: true }, 2000);
  assert.deepStrictEqual(st.images.map(i => i.msgId), [90, 89]);
  assert.strictEqual(st.imagesHasMore, true);
});

test('a refresh that finds nothing new leaves the list exactly as it was', () => {
  const loaded = M.fromFirstPage({ images: imgs(3, 2, 1), imagesCursor: 1, imagesHasMore: true }, 1000);
  const st = M.mergeRefresh(loaded, { images: imgs(3, 2, 1), imagesCursor: 1, imagesHasMore: true }, 2000);
  assert.strictEqual(st.images, loaded.images);   // same array, no re-render
});

// ── No extra scroll ─────────────────────────────────────────────────────────

test('THE BUG: nothing but opening the gallery can make it scroll itself', () => {
  const open = { visible: true, openId: 4, tab: 'images', focusIndex: 60 };
  const token = M.restoreToken(open);
  assert.ok(token);
  // Honoured once…
  assert.strictEqual(M.shouldRestore(token, null), true);
  // …and never again, however many times the component re-renders.
  assert.strictEqual(M.shouldRestore(M.restoreToken(open), token), false);
});

test('switching tabs does not scroll the grid', () => {
  assert.strictEqual(M.restoreToken({ visible: true, openId: 1, tab: 'files', focusIndex: 60 }), null);
  assert.strictEqual(M.restoreToken({ visible: true, openId: 1, tab: 'links', focusIndex: 60 }), null);
});

test('a closed gallery never scrolls', () => {
  assert.strictEqual(M.restoreToken({ visible: false, openId: 1, tab: 'images', focusIndex: 60 }), null);
});

test('the top of the grid needs no restoring', () => {
  assert.strictEqual(M.restoreToken({ visible: true, openId: 1, tab: 'images', focusIndex: 0 }), null);
});

test('opening the gallery again does restore, having been closed in between', () => {
  // The token that was honoured belongs to the previous open, so this one is
  // free to happen — otherwise closing a photo would dump you at the top.
  const first = M.restoreToken({ visible: true, openId: 1, tab: 'images', focusIndex: 60 });
  const second = M.restoreToken({ visible: true, openId: 2, tab: 'images', focusIndex: 60 });
  assert.notStrictEqual(first, second);
  assert.strictEqual(M.shouldRestore(second, first), true);
});

// ── The grid itself ─────────────────────────────────────────────────────────

test('photos are grouped into rows of three', () => {
  const rows = M.toRows(imgs(1, 2, 3, 4, 5), 3);
  assert.strictEqual(rows.length, 2);
  assert.deepStrictEqual(rows[0].map(i => i.msgId), [1, 2, 3]);
  assert.deepStrictEqual(rows[1].map(i => i.msgId), [4, 5]);   // short last row
});

test('no photos, no rows', () => {
  assert.deepStrictEqual(M.toRows([], 3), []);
});

test('a photo maps to the row that holds it', () => {
  assert.strictEqual(M.rowOf(0, 3), 0);
  assert.strictEqual(M.rowOf(2, 3), 0);
  assert.strictEqual(M.rowOf(3, 3), 1);
  assert.strictEqual(M.rowOf(60, 3), 20);
});

test('cells divide the screen with the gaps taken out', () => {
  // 2 gaps of 2px inside a 360px screen: (360-4)/3 = 118.67 -> 118.
  assert.strictEqual(M.cellSize(360, 3, 2), 118);
  // Rows of a known height are what make scrolling to one land ON it.
  assert.strictEqual(M.cellSize(1080, 3, 0), 360);
});

// ── Coming back from a photo ────────────────────────────────────────────────
//
// Reported as: after closing an image, the gallery scrolls down until that
// image is on the top row of the screen.
//
// It restored by ROW INDEX, and scrolling to an index puts that row at the top
// — so a photo opened from the middle of the screen came back at the top,
// dragging the whole grid with it.

const ROW = 120;      // a row of tiles
const VIEW = 600;     // five rows visible

test('THE BUG: closing a photo you can already see moves nothing at all', () => {
  // The grid is at 1000; row 9 spans 1080..1200, comfortably on screen.
  const at = M.restoreOffset({ savedOffset: 1000, focusRow: 9, rowHeight: ROW, viewportHeight: VIEW });
  assert.strictEqual(at, 1000, 'the grid scrolled even though the photo was in view');
});

test('a photo at the very top of the view is still "in view"', () => {
  assert.strictEqual(
    M.restoreOffset({ savedOffset: 1200, focusRow: 10, rowHeight: ROW, viewportHeight: VIEW }), 1200);
});

test('a photo swiped to off screen is brought back, centred', () => {
  // Swiping through the viewer can end on a photo hundreds of rows away.
  const at = M.restoreOffset({ savedOffset: 0, focusRow: 40, rowHeight: ROW, viewportHeight: VIEW });
  assert.strictEqual(at, 4560);
  assert.ok(at < 40 * ROW && at + VIEW > 40 * ROW + ROW, 'the photo is not actually on screen');
});

test('a photo just past the bottom edge is scrolled to', () => {
  const at = M.restoreOffset({ savedOffset: 0, focusRow: 5, rowHeight: ROW, viewportHeight: VIEW });
  assert.notStrictEqual(at, 0, 'a photo past the bottom edge was left off screen');
});

test('it never scrolls above the top of the grid', () => {
  assert.strictEqual(
    M.restoreOffset({ savedOffset: 5000, focusRow: 0, rowHeight: ROW, viewportHeight: VIEW }), 0);
});

test('it never scrolls past the end of the grid', () => {
  const at = M.restoreOffset({
    savedOffset: 0, focusRow: 100, rowHeight: ROW, viewportHeight: VIEW, maxOffset: 2000,
  });
  assert.strictEqual(at, 2000, 'scrolled into empty space below the last row');
});

test('nonsense measurements leave the grid where it is', () => {
  // Before the grid has laid out its height is 0; doing arithmetic with that
  // and scrolling somewhere is worse than doing nothing.
  assert.strictEqual(
    M.restoreOffset({ savedOffset: 800, focusRow: 3, rowHeight: 0, viewportHeight: VIEW }), 800);
  assert.strictEqual(
    M.restoreOffset({ savedOffset: 800, focusRow: 3, rowHeight: ROW, viewportHeight: 0 }), 800);
});

// ── Offline ────────────────────────────────────────────────────────────────
//
// Reported as: with no connection the gallery of a chat does not load, and
// "I told you each downloaded image should stay on the device". The pictures
// always were kept — mediaCache writes them to permanent storage and reads
// them back by filename, so a re-signed url is still the same file. What was
// never kept was the LIST, which lived in a Map that dies with the process.

const item = (n, over = {}) => ({ url: `/uploads/${n}.jpg`, msgId: n, ...over });
const full = (over = {}) => ({
  images: [item(1), item(2)], files: [item(3)], music: [item(4)], links: [item(5)],
  imagesCursor: 7, imagesHasMore: true, fetchedAt: 1234, ...over,
});

test('THE LIST IS KEPT, which is what offline needed', () => {
  const out = M.forStorage(full());
  assert.deepStrictEqual(out.images.map(i => i.msgId), [1, 2]);
  assert.deepStrictEqual(out.files.map(i => i.msgId), [3]);
  assert.deepStrictEqual(out.music.map(i => i.msgId), [4]);
  assert.deepStrictEqual(out.links.map(i => i.msgId), [5]);
});

test('WHAT THIS VIEWER MAY NOT KEEP IS NOT KEPT', () => {
  // The same rule the pictures obey. A disappearing message, or someone
  // else's file in a private room, must not be written down — and a url in a
  // stored list is a way to ask for it that outlives the message.
  const out = M.forStorage(full({
    images: [item(1), item(2, { cacheable: false }), item(3)],
    files: [item(4, { cacheable: false })],
  }));
  assert.deepStrictEqual(out.images.map(i => i.msgId), [1, 3],
    'a photo the viewer may not keep was written to the device');
  assert.deepStrictEqual(out.files, [],
    'a file the viewer may not keep was written to the device');
});

test('IT IS BOUNDED, because a gallery can hold thousands', () => {
  const many = Array.from({ length: 500 }, (_, i) => item(i));
  const out = M.forStorage(full({ images: many }));
  assert.strictEqual(out.images.length, M.STORED_PER_TAB);
  // The newest end: the gallery is ordered newest first, and what somebody
  // opens offline is the recent end of it.
  assert.strictEqual(out.images[0].msgId, 0);
  assert.ok(M.STORED_PER_TAB > 0 && M.STORED_PER_TAB <= 500);
  // A smaller cap can be asked for, and is honoured.
  assert.strictEqual(M.forStorage(full({ images: many }), 5).images.length, 5);
});

test('A STORED GALLERY DOES NOT CLAIM TO BE FRESH', () => {
  // fetchedAt drives staleness. Stored unchanged, a gallery from last week
  // would look like one fetched a moment ago and suppress the refresh that
  // should replace it.
  const out = M.forStorage(full({ fetchedAt: Date.now() }));
  assert.strictEqual(out.fetchedAt, 0, 'a stored gallery suppresses its own refresh');
  assert.strictEqual(M.isStale(out, Date.now()), true);
  // And it does not ask the server to carry on from a page it does not have.
  assert.strictEqual(out.imagesCursor, null, 'the cursor points past the stored run');
  assert.strictEqual(out.imagesHasMore, false);
});

test('NOTHING WORTH KEEPING MEANS NOTHING WRITTEN', () => {
  // Otherwise every room with a disappearing photo in it leaves an empty
  // shell on disk that the gallery then treats as a loaded gallery.
  assert.strictEqual(M.forStorage(null), null);
  assert.strictEqual(M.forStorage(M.emptyState()), null);
  assert.strictEqual(M.forStorage(full({
    images: [item(1, { cacheable: false })], files: [], music: [], links: [],
  })), null, 'a gallery of nothing but unkeepable items was still written');
});

test('RUBBISH IN DOES NOT THROW', () => {
  const out = M.forStorage({ images: null, files: undefined, music: 'x', links: [item(1)] });
  assert.deepStrictEqual(out.images, []);
  assert.deepStrictEqual(out.files, []);
  assert.deepStrictEqual(out.music, []);
  assert.strictEqual(out.links.length, 1);
});

test('THE SCREEN READS IT, AND WRITES IT', () => {
  const chat = fs.readFileSync(path.join(__dirname, '..', 'native-app', 'src',
    'screens', 'ChatScreen.tsx'), 'utf8');
  assert.ok(/offline\.loadMedia\(room\.id\)/.test(chat),
    'nothing reads the stored gallery, so offline it is still empty');
  assert.ok(/offline\.saveMedia\(room\.id, rm\.forStorage\(next\)\)/.test(chat),
    'nothing writes the gallery down');
  // Marked dirty on restore, or a stored gallery is treated as a fresh fetch
  // and never refreshed.
  const eff = /offline\.loadMedia\(room\.id\)\.then\(saved => \{([\s\S]*?)\n    \}\)/.exec(chat);
  assert.ok(eff, 'could not find the restore');
  assert.ok(/rm\.markDirty\(room\.id\)/.test(eff[1]),
    'a gallery restored from disk is never refreshed');
  assert.ok(/if \(rm\.getCached\(room\.id\)\) return;/.test(eff[1]),
    'a slow disk read overwrites a fetch that already landed');
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
fs.rmSync(OUT, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
