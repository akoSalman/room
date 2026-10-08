// ── Sending a photo on a connection that keeps dropping ────────────────────
//
// Reported as: sending an image, the bar reaches about ten per cent, appears
// to reset and start from nothing, and does that several times over.
//
// Two causes, and both are in the loop this file drives:
//
//   1. Every chunk was a flat 512 KB. A chunk only counts when it lands
//      WHOLE, so on a link that drops every few seconds a large one may never
//      land — the phone sends data continuously and the upload never advances.
//      For a one-megabyte photo the first chunk is half the file, so losing it
//      is losing the upload.
//
//   2. Re-sending a chunk starts its byte count again, so the bar was reported
//      backwards. The bytes are not actually lost — the server keeps whatever
//      arrived — which makes the lower number the less truthful one.
//
// The rules themselves are unit-tested in uploadTuning.test.js. What was never
// tested is the LOOP: nothing in the suite had ever run uploadResumable, which
// is how a tuning rule came to exist, be proven correct, and never be called.
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const NAT = path.join(ROOT, 'native-app');
const TSC = path.join(NAT, 'node_modules', '.bin', 'tsc');
if (!fs.existsSync(TSC)) {
  console.log('  ! skipping chunked-upload tests (native-app deps not installed)');
  process.exit(0);
}
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'chunkup-'));
process.on('exit', () => fs.rmSync(OUT, { recursive: true, force: true }));

function stub(name, body) {
  const dir = path.join(OUT, 'node_modules', ...name.split('/'));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.js'), body);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, main: 'index.js' }));
}
// The file on disk. getInfoAsync gives the size; the base64 reader is the
// fallback path and is not exercised here, but must exist to be imported.
stub('expo-file-system', `
  module.exports = {
    getInfoAsync: async () => ({ exists: true, size: global.__fileSize }),
    readAsStringAsync: async () => 'base64-bytes',
    EncodingType: { Base64: 'base64' },
  };
`);

execFileSync(TSC, [path.join(NAT, 'src', 'chunkedUpload.ts'),
  '--outDir', OUT, '--module', 'commonjs', '--target', 'es2019',
  '--skipLibCheck', '--esModuleInterop'], { stdio: 'pipe' });
const U = require(path.join(OUT, 'chunkedUpload.js'));
const S = require(path.join(OUT, 'uploadSession.js'));

const tests = [];
const test = (n, f) => tests.push({ n, f });

/**
 * Run one upload against a scripted connection.
 *
 * `verdict(at, len, nth)` decides what happens to each chunk:
 *   { ok: true }                       — it lands
 *   { drop: n }                        — n bytes are reported as sent, then
 *                                        the connection dies (the reported
 *                                        case: progress, then failure)
 *   { conflict: offset }               — a 409 carrying the server's offset,
 *                                        which is how bytes recovered from a
 *                                        half-delivered chunk come back
 *
 * Returns every chunk attempted and every progress value reported.
 */
function run(total, verdict, opts) {
  const sent = [];        // { at, len } per attempt
  const progress = [];    // every value passed to onProgress
  let served = 0;         // what the fake server holds
  let nth = 0;

  global.__fileSize = total;

  // The file is read as a Blob and sliced; the slice carries its length so the
  // fake request can see how big the chunk was.
  const blob = { size: total, slice: (s, e) => ({ __len: e - s }) };

  global.fetch = async (url, init) => {
    const u = String(url);
    if (u.startsWith('file:')) return { blob: async () => blob };
    if (u.endsWith('/upload/session') && init && init.method === 'POST') {
      return { ok: true, json: async () => ({ id: 'sess1', offset: 0 }) };
    }
    if (/\/upload\/session\/sess1$/.test(u)) {
      return { ok: true, json: async () => ({ id: 'sess1', offset: served, size: total }) };
    }
    if (/\/finish$/.test(u)) {
      return { ok: true, json: async () => ({ url: '/uploads/x.jpg', name: 'x.jpg', mimetype: 'image/jpeg' }) };
    }
    throw new Error('unexpected fetch ' + u);
  };

  global.XMLHttpRequest = class {
    constructor() { this.upload = {}; this.headers = {}; this.status = 0; this.responseText = ''; }
    open(_m, url) { this.url = url; }
    setRequestHeader(k, v) { this.headers[String(k).toLowerCase()] = v; }
    abort() { this.onabort && this.onabort(); }
    send(body) {
      const at = Number(this.headers['x-offset']);
      const len = (body && body.__len) || 0;
      sent.push({ at, len });
      // The real server checks the offset before it writes anything, and a
      // stale one is answered with a 409 carrying the truth. Without this the
      // fake accepted chunks at offsets the server had passed, which made the
      // recovery path look broken when it was the harness that was wrong.
      if (at !== served) {
        setTimeout(() => {
          this.status = 409;
          this.responseText = JSON.stringify({ error: 'Offset mismatch', offset: served });
          this.onload();
        }, 0);
        return;
      }
      const v = verdict(at, len, nth++) || { ok: true };
      setTimeout(() => {
        if (v.conflict !== undefined) {
          served = v.conflict;
          this.status = 409;
          this.responseText = JSON.stringify({ error: 'Offset mismatch', offset: v.conflict });
          this.onload();
          return;
        }
        if (v.drop !== undefined) {
          // Bytes reported as gone out, the way a real upload reports them…
          if (this.upload.onprogress) {
            this.upload.onprogress({ lengthComputable: true, loaded: v.drop });
          }
          // …and then the connection dies. The server keeps what arrived.
          served = Math.max(served, at + (v.keeps === undefined ? v.drop : v.keeps));
          this.onerror();
          return;
        }
        served = at + len;
        this.status = 200;
        this.responseText = JSON.stringify({ offset: served, size: total });
        this.onload();
      }, 0);
    }
  };

  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('upload never finished')), 20000);
    U.uploadResumable('https://x', 'file:///photo.jpg', 'photo.jpg', 'image/jpeg', 'tok', {
      onProgress: (s) => progress.push(s),
      onDone: () => { clearTimeout(t); resolve({ sent, progress, served }); },
      onFailed: (e) => { clearTimeout(t); reject(e); },
    }, ...(opts && opts.chunkBytes !== undefined ? [opts.chunkBytes] : []));
  });
}

const KB = 1024;

test('THE FIRST CHUNK IS SMALL, not half the photo', async () => {
  // A flat 512 KB meant the first piece of a one-megabyte photo was half of
  // it: nothing is known about the connection yet, and that is the worst
  // moment to bet a large chunk on it.
  const { sent } = await run(1024 * KB, () => ({ ok: true }));
  assert.strictEqual(sent[0].len, S.FIRST_CHUNK_BYTES,
    `the first chunk is ${sent[0].len} bytes`);
  assert.ok(S.FIRST_CHUNK_BYTES < S.CHUNK_BYTES, 'the first chunk is not smaller than the old fixed size');
});

test('A CHUNK THAT FAILS MAKES THE NEXT ONE SMALLER', async () => {
  // The rate is measured from chunks that SUCCEED, so on a connection where
  // the current size never lands it never adapts — the same doomed chunk is
  // tried until the attempts run out.
  let failed = false;
  const { sent } = await run(1024 * KB, (at, len) => {
    if (!failed) { failed = true; return { drop: 0, keeps: 0 }; }
    return { ok: true };
  });
  assert.ok(sent.length >= 2, 'the upload gave up instead of retrying');
  assert.ok(sent[1].len < sent[0].len,
    `after a failure the next chunk was ${sent[1].len}, not smaller than ${sent[0].len}`);
  assert.ok(sent[1].len >= S.CHUNK_MIN, 'the chunk shrank below the floor');
});

test('THE BAR NEVER GOES BACKWARDS', async () => {
  // The reported symptom itself: ten per cent, then zero, several times.
  let n = 0;
  const { progress } = await run(1024 * KB, (at, len) => {
    // Two chunks that report progress and then die, which is what a dropping
    // connection does.
    if (n++ < 2) return { drop: Math.floor(len * 0.8), keeps: 0 };
    return { ok: true };
  });
  assert.ok(progress.length > 3, 'nothing was reported at all');
  for (let i = 1; i < progress.length; i++) {
    assert.ok(progress[i] >= progress[i - 1],
      `progress went ${progress[i - 1]} → ${progress[i]}, which is the bar resetting`);
  }
  assert.strictEqual(progress[progress.length - 1], 1024 * KB, 'it did not finish at 100%');
});

test('BYTES THE SERVER KEPT ARE NOT SENT AGAIN', async () => {
  // The server appends as the bytes arrive, so an interrupted chunk leaves it
  // ahead of the phone. It answers the retry with a 409 carrying the real
  // offset, and those bytes must not be re-sent.
  let dropped = false;
  const { sent } = await run(512 * KB, (at, len) => {
    if (!dropped) { dropped = true; return { drop: len, keeps: len }; }
    return { ok: true };
  });
  // The retry is answered from the server's offset, so no attempt starts
  // before the bytes it already holds.
  const first = sent[0];
  const after = sent.slice(1);
  assert.ok(after.length, 'the upload never retried');
  assert.ok(after.every(c => c.at >= first.at),
    'a chunk was sent at an offset the server had already passed');
  const resent = after.filter(c => c.at < first.at + first.len);
  assert.strictEqual(resent.length, 1,
    'the bytes the server kept were sent again rather than skipped');
});

test('A FAST CONNECTION STILL GETS BIGGER CHUNKS', async () => {
  // Otherwise this fix makes a 60 MB video slower: hundreds of small
  // round trips where a few large ones would do.
  const { sent } = await run(8 * 1024 * KB, () => ({ ok: true }));
  const biggest = Math.max(...sent.map(c => c.len));
  assert.ok(biggest > S.FIRST_CHUNK_BYTES,
    `every chunk stayed at ${biggest} bytes, so a large file pays for it`);
  assert.ok(biggest <= S.CHUNK_MAX, `a chunk grew to ${biggest}, past the cap`);
});

test('EVERY BYTE OF THE FILE IS COVERED, exactly once', async () => {
  // A gap means a photo that uploads "successfully" and is broken.
  const total = 700 * KB;
  const { sent, served } = await run(total, () => ({ ok: true }));
  let at = 0;
  for (const c of sent) {
    assert.strictEqual(c.at, at, `a chunk started at ${c.at} when ${at} was expected`);
    at += c.len;
  }
  assert.strictEqual(at, total, 'the chunks do not add up to the file');
  assert.strictEqual(served, total, 'the server did not end up with the whole file');
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
