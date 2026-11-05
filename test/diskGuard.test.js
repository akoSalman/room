// Handling uploads on a disk that could run out
// (diskGuard.js, uploadDedup.js, server.js, db.js).
//
// Asked: what is the best approach to file upload when the server disk is
// limited. Measured before answering, because the answer depended on it:
//
//     /dev/vda1   97G total   43G used   54G free   45%
//     uploads/                2.7G in 3615 files
//     systemd journal         3.9G          <- more than every file ever sent
//     growth                  about 780 MB a month, and not accelerating
//     cold data               31.5 MB unread in 90 days; nothing over 180
//
// So: years of headroom, the largest single consumer is logs rather than
// media, and deleting old media would break people's chats to reclaim almost
// nothing. What is worth building is therefore not a retention policy. It is
// (a) refusing an upload cleanly when space does run out, which today
// produces an HTML 500 the app cannot parse, and (b) storing identical bytes
// once, which costs nobody anything.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const guard = require(path.join(ROOT, 'diskGuard'));
const dedup = require(path.join(ROOT, 'uploadDedup'));
const srv = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const dbSrc = fs.readFileSync(path.join(ROOT, 'db.js'), 'utf8');

// This file argues at length about why each rule exists, so a regex that
// reads its own prose proves nothing.
const code = src => src
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/^\s*\/\/.*$/gm, ' ');
const srvCode = code(srv);

const tests = [];
const test = (n, f) => tests.push({ n, f });
const GIB = 1024 * 1024 * 1024;

// ── THE GUARD ───────────────────────────────────────────────────────────────

test('a disk with room accepts the file', () => {
  const v = guard.spaceVerdict({ freeBytes: 50 * GIB, incomingBytes: 80 * 1024 * 1024 });
  assert.strictEqual(v.ok, true);
  assert.strictEqual(v.reason, 'ok');
});

test('a disk with no room refuses it', () => {
  const v = guard.spaceVerdict({ freeBytes: 100 * 1024 * 1024, incomingBytes: 80 * 1024 * 1024 });
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.reason, 'low-space');
});

test('THE RESERVE IS KEPT, so the database always has somewhere to write', () => {
  // A SQLite database on a full disk is a far worse day than a refused photo,
  // and the journal and the OS need room too. The floor is held even when the
  // file itself would technically fit.
  const free = guard.DEFAULT_RESERVE_BYTES + (10 * 1024 * 1024);   // reserve + 10 MB
  assert.strictEqual(guard.spaceVerdict({ freeBytes: free, incomingBytes: 5 * 1024 * 1024 }).ok,
    true, '5 MB fits above the floor');
  assert.strictEqual(guard.spaceVerdict({ freeBytes: free, incomingBytes: 20 * 1024 * 1024 }).ok,
    false, '20 MB would eat into the reserve and must be refused');
  // Landing exactly ON the floor is allowed: the rule is "at least this much
  // is still free afterwards", and after this upload exactly that much is.
  // One byte more is not.
  assert.strictEqual(
    guard.spaceVerdict({ freeBytes: guard.DEFAULT_RESERVE_BYTES, incomingBytes: 0 }).ok,
    true);
  assert.strictEqual(
    guard.spaceVerdict({ freeBytes: guard.DEFAULT_RESERVE_BYTES, incomingBytes: 1 }).ok,
    false);
});

test('IT FAILS OPEN when free space cannot be measured', () => {
  // The most important rule here, and the least obvious. A guard that cannot
  // read the disk and therefore refuses every upload is a far worse outage
  // than the rare one it guards against — statfs needs Node 18.15, and this
  // runs on whatever the server has.
  for (const freeBytes of [null, undefined, NaN, 'lots', -1, {}]) {
    const v = guard.spaceVerdict({ freeBytes, incomingBytes: 80 * 1024 * 1024 });
    assert.strictEqual(v.ok, true,
      `freeBytes=${JSON.stringify(freeBytes)} must not block uploads`);
    assert.strictEqual(v.reason, 'unmeasured');
  }
});

test('a missing or silly size is treated as zero, not as a refusal', () => {
  // Content-Length can be absent. Refusing for want of a header would block
  // uploads that would have fitted.
  for (const incomingBytes of [undefined, null, NaN, -5, 'big']) {
    assert.strictEqual(guard.spaceVerdict({ freeBytes: 50 * GIB, incomingBytes }).ok, true);
  }
  // …but it still cannot pass on a disk that is already below the floor.
  assert.strictEqual(guard.spaceVerdict({ freeBytes: 1024, incomingBytes: undefined }).ok, false);
});

test('the reserve can be configured, including to nothing', () => {
  assert.strictEqual(
    guard.spaceVerdict({ freeBytes: 2 * 1024, incomingBytes: 1024, reserveBytes: 0 }).ok, true);
  assert.strictEqual(
    guard.spaceVerdict({ freeBytes: 2 * 1024, incomingBytes: 4096, reserveBytes: 0 }).ok, false);
  // A nonsense value falls back to the default rather than to no floor at all.
  const v = guard.spaceVerdict({ freeBytes: 1024, incomingBytes: 0, reserveBytes: 'none' });
  assert.strictEqual(v.ok, false);
});

test('free space is read from bavail, not bfree', () => {
  // bfree counts blocks reserved for root, which this process cannot use.
  // Counting them is how a guard lets the disk fill the last few percent and
  // then fails anyway, which is the failure it was written to prevent.
  const c = code(fs.readFileSync(path.join(ROOT, 'diskGuard.js'), 'utf8'));
  assert.match(c, /st\.bavail/);
  assert.doesNotMatch(c, /st\.bfree/);
});

test('freeBytesFor answers for a real directory, or honestly says it cannot', () => {
  const v = guard.freeBytesFor(ROOT);
  assert.ok(v === null || (Number.isFinite(v) && v >= 0),
    'it must return a byte count or null, never a guess');
  // Whatever it returns must be a legal input to the verdict, since that is
  // the only thing it is ever passed to.
  assert.ok(typeof guard.spaceVerdict({ freeBytes: v, incomingBytes: 1 }).ok === 'boolean');
});

test('the message names no path and no number the reader cannot act on', () => {
  const m = guard.lowSpaceMessage();
  assert.ok(m.length > 20 && m.length < 200);
  assert.doesNotMatch(m, /\//, 'a path in a message shown on a phone');
  assert.doesNotMatch(m, /\d/, 'a byte count the person can do nothing with');
});

// ── DEDUPLICATION, WHERE THE ONLY INTERESTING QUESTION IS SAFETY ────────────

test('identical bytes reuse the stored file', () => {
  const rows = [{ name: 'a.jpg', size: 1000, sha256: 'abc' }];
  assert.strictEqual(
    dedup.pickExisting(rows, { hash: 'abc', size: 1000, exists: () => true }), 'a.jpg');
});

test('A ROW WHOSE FILE IS GONE IS NEVER REUSED', () => {
  // The rule that decides whether this feature is safe. A row can outlive its
  // bytes — a message deleted while the upload row lingers, a restore, a
  // directory edited by hand. Returning that name would hand somebody a
  // broken photo in place of the one they just sent, which is far worse than
  // storing a duplicate.
  const rows = [{ name: 'gone.jpg', size: 1000, sha256: 'abc' }];
  assert.strictEqual(
    dedup.pickExisting(rows, { hash: 'abc', size: 1000, exists: () => false }), null);
  // And the first row being gone must not stop a later, present one matching.
  const two = [{ name: 'gone.jpg', size: 1000, sha256: 'abc' },
               { name: 'here.jpg', size: 1000, sha256: 'abc' }];
  assert.strictEqual(
    dedup.pickExisting(two, { hash: 'abc', size: 1000, exists: n => n === 'here.jpg' }),
    'here.jpg');
});

test('a different hash or a different size is never substituted', () => {
  const exists = () => true;
  assert.strictEqual(dedup.pickExisting(
    [{ name: 'a.jpg', size: 1000, sha256: 'other' }], { hash: 'abc', size: 1000, exists }), null);
  // Size is checked as well as the hash. Free, and it means a hash collision
  // alone cannot substitute the wrong file.
  assert.strictEqual(dedup.pickExisting(
    [{ name: 'a.jpg', size: 999, sha256: 'abc' }], { hash: 'abc', size: 1000, exists }), null);
  // A row with no hash at all — every row written before this change — must
  // never match, so old uploads are left exactly as they are.
  assert.strictEqual(dedup.pickExisting(
    [{ name: 'a.jpg', size: 1000, sha256: null }], { hash: 'abc', size: 1000, exists }), null);
});

test('nonsense in gives null out, not a wrong file', () => {
  const exists = () => true;
  const rows = [{ name: 'a.jpg', size: 1000, sha256: 'abc' }];
  for (const bad of [
    { hash: '', size: 1000 }, { hash: null, size: 1000 },
    { hash: 'abc', size: 0 }, { hash: 'abc', size: -1 }, { hash: 'abc', size: 'big' },
  ]) assert.strictEqual(dedup.pickExisting(rows, { ...bad, exists }), null,
    `${JSON.stringify(bad)} must not match anything`);
  assert.strictEqual(dedup.pickExisting(null, { hash: 'abc', size: 1, exists }), null);
  assert.strictEqual(dedup.pickExisting([null, undefined, {}],
    { hash: 'abc', size: 1, exists }), null);
  // With no `exists` given, nothing may be reused: the default must be the
  // safe answer, not the convenient one.
  assert.strictEqual(dedup.pickExisting(rows, { hash: 'abc', size: 1000 }), null);
});

test('tiny files are not worth hashing', () => {
  assert.strictEqual(dedup.worthDeduping(dedup.MIN_DEDUP_BYTES), true);
  assert.strictEqual(dedup.worthDeduping(dedup.MIN_DEDUP_BYTES - 1), false);
  for (const bad of [0, -1, null, undefined, NaN, 'big']) {
    assert.strictEqual(dedup.worthDeduping(bad), false);
  }
});

test('hashFile really hashes the bytes, and rejects on a missing file', async () => {
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dedup-'));
  try {
    const a = path.join(dir, 'a.bin'), b = path.join(dir, 'b.bin'), c = path.join(dir, 'c.bin');
    fs.writeFileSync(a, 'the same bytes');
    fs.writeFileSync(b, 'the same bytes');
    fs.writeFileSync(c, 'different bytes');
    const [ha, hb, hc] = await Promise.all([a, b, c].map(dedup.hashFile));
    assert.strictEqual(ha, hb, 'identical files must hash the same');
    assert.notStrictEqual(ha, hc, 'different files must not');
    assert.match(ha, /^[a-f0-9]{64}$/, 'sha256, hex');
    // A missing file must REJECT rather than resolve to the hash of nothing,
    // which would make every absent file look identical to every other.
    await assert.rejects(() => dedup.hashFile(path.join(dir, 'nope.bin')));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── THE WIRING ──────────────────────────────────────────────────────────────

test('BOTH upload paths ask before writing', () => {
  // The one-shot POST checks before multer runs, so a refusal costs no bytes.
  const post = srvCode.slice(srvCode.indexOf("app.post('/upload',"));
  const head = post.slice(0, post.indexOf("upload.single('file')"));
  assert.match(head, /roomForUpload\(/,
    'the one-shot upload writes first and asks afterwards');
  assert.match(head, /refuseForSpace\(res\)/);
  // The resumable one declares its whole length up front, so it is refused at
  // the start rather than at the last chunk — on a metered connection,
  // finding out at the end means the data has already been spent.
  const sess = srvCode.slice(srvCode.indexOf("app.post('/upload/session',"));
  const body = sess.slice(0, sess.indexOf('res.json({ id'));
  assert.match(body, /roomForUpload\(size\)/,
    'a resumable upload is accepted without checking for room');
});

test('both upload paths dedupe, and the resumable one before its done-marker', () => {
  assert.strictEqual((srvCode.match(/await dedupeUpload\(/g) || []).length, 2,
    'both upload paths must dedupe');
  // The done-marker is the answer a retried finish gets. If it were written
  // before the dedupe, a resumed upload would be handed the name of the copy
  // that was just removed.
  const fin = srvCode.slice(srvCode.indexOf("'/upload/session/:id/finish'"));
  const dd = fin.indexOf('await dedupeUpload(');
  const marker = fin.indexOf('donePath(s.id)');
  assert.ok(dd > 0 && marker > dd,
    'the done-marker is written before the dedupe, so a retry gets a dead name');
});

test('THE REPLY NAMES THE FILE THE MESSAGE WILL POINT AT', () => {
  // Both handlers must send the deduped name, not the one they minted.
  // Replying with the original and deduping afterwards would point every
  // message at a file that had just been unlinked.
  const post = srvCode.slice(srvCode.indexOf("app.post('/upload',"));
  // To the end of the handler, not to the first '});' — that one is inside
  // res.status(400).json({ error: 'No file' }); and cut the slice three lines
  // in, so the assertion was reading almost none of the code it judged.
  const reply = post.slice(0, post.indexOf('} catch (err)'));
  assert.doesNotMatch(reply, /url: '\/uploads\/' \+ req\.file\.filename/,
    'the one-shot reply names the pre-dedupe file');
  assert.match(reply, /url: '\/uploads\/' \+ filename/);
});

test('dedup never loses the new file when something goes wrong', () => {
  // Every failure keeps what was just uploaded. Losing somebody's photo to
  // save a megabyte is not a trade worth making, so the code has no path that
  // makes it.
  const fn = srvCode.slice(srvCode.indexOf('async function dedupeUpload'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /catch\s*\(err\)/, 'dedupeUpload can throw out to its caller');
  assert.match(body, /return filename;/, 'a failure must return the new file unchanged');
  // The unlink of the duplicate happens only inside the branch where an
  // existing file was confirmed present.
  const keep = body.indexOf('if (keep)');
  const unlink = body.indexOf('fs.unlink(abs');
  assert.ok(keep >= 0 && unlink > keep,
    'the new file is unlinked outside the branch that confirmed a replacement');
});

test('deleting one message does not take a shared file with it', () => {
  // The rule that makes pointing two messages at one file safe, and it was
  // here before this change: destroyMessage clears this message's references
  // first, then keeps the file if any reference still names it.
  const d = srvCode.slice(srvCode.indexOf('DELETE FROM upload_refs WHERE message_id'));
  const block = d.slice(0, d.indexOf('message_deleted'));
  const clear = block.indexOf('DELETE FROM upload_refs');
  const check = block.indexOf('SELECT 1 FROM upload_refs WHERE name');
  assert.ok(clear >= 0 && check > clear,
    'the shared-file check runs before this message\'s references are cleared');
  assert.match(block, /if \(shared\) continue;/,
    'a file still referenced elsewhere is deleted anyway');
});

test('the hash column is added without disturbing what is already stored', () => {
  assert.match(dbSrc, /ALTER TABLE uploads ADD COLUMN sha256 TEXT/);
  assert.match(dbSrc, /ALTER TABLE uploads ADD COLUMN size INTEGER/);
  assert.match(dbSrc, /CREATE INDEX IF NOT EXISTS idx_uploads_sha256/);
  // Wrapped, like every other migration here, so a second start is not an
  // error — ALTER TABLE has no IF NOT EXISTS.
  const line = dbSrc.slice(dbSrc.indexOf('ALTER TABLE uploads ADD COLUMN sha256'));
  assert.match(line.slice(-0) && dbSrc, /try \{ db\.exec\('ALTER TABLE uploads ADD COLUMN sha256 TEXT'\); \} catch \{\}/);
});

// ── THE ERROR HANDLER ───────────────────────────────────────────────────────

test('ERRORS LEAVE AS JSON, because there was no handler at all', () => {
  // Express's default handler replies with an HTML page. Every client here
  // speaks JSON: apiFetch parses the body, so an HTML 500 reaches the phone
  // as an unparseable-response error with nothing actionable in it — and a
  // resumable upload's answer to an error it cannot read is to retry, which
  // is the worst possible response to a full disk.
  assert.match(srvCode, /app\.use\(\(err, req, res, next\) => \{/,
    'server.js has no express error handler');
  const h = srvCode.slice(srvCode.indexOf('app.use((err, req, res, next)'));
  const body = h.slice(0, h.indexOf('\n});'));
  assert.match(body, /res\.status\(500\)\.json\(/, 'the fallback is not JSON');
  assert.match(body, /LIMIT_FILE_SIZE/, 'an oversized file gets no useful answer');
  assert.match(body, /ENOSPC/, 'a disk that fills mid-write gets no useful answer');
  assert.match(body, /res\.status\(507\)/, 'out of space should say so, not 500');
  assert.match(body, /headersSent/,
    'writing a second response onto one already sent throws inside the handler');
});

test('the error handler leaks no path and no message to the client', () => {
  // This server's logs are read into a repository that has been public, and
  // an error message carries paths and query fragments. It goes to the
  // journal; the client gets a shape it can parse and nothing else.
  const h = srvCode.slice(srvCode.indexOf('app.use((err, req, res, next)'));
  const body = h.slice(0, h.indexOf('\n});'));
  const generic = body.slice(body.indexOf('console.error'));
  assert.doesNotMatch(generic, /json\([^)]*err\.message/,
    'the raw error message is sent to the client');
  assert.match(generic, /res\.status\(500\)\.json\(\{ error: 'Server error' \}\)/);
});

test('it is registered AFTER every route', () => {
  // Express picks the first four-argument middleware declared after the one
  // that failed, so a handler registered early catches nothing.
  const at = srvCode.indexOf('app.use((err, req, res, next)');
  const lastRoute = Math.max(
    srvCode.lastIndexOf('app.get('), srvCode.lastIndexOf('app.post('),
    srvCode.lastIndexOf('app.delete('), srvCode.lastIndexOf('app.put('));
  assert.ok(at > lastRoute,
    'the error handler is declared before some routes and will not catch them');
  assert.ok(at < srvCode.indexOf('server.listen('),
    'the error handler is registered after the server starts listening');
});

(async () => {
  let failed = 0;
  for (const { n, f } of tests) {
    try { await f(); console.log(`  ok  ${n}`); }
    catch (e) { failed++; console.log(`  FAIL ${n}\n       ${e.message}`); }
  }
  if (failed) { console.log(`\n  ${failed} disk-guard test(s) failed`); process.exit(1); }
  console.log(`  ${tests.length} disk-guard tests passed`);
})();
