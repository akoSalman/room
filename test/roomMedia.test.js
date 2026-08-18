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

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
fs.rmSync(OUT, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
