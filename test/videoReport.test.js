// ── The report that has to be right about broken video ─────────────────────
//
// A diagnostic that lies is worse than none, and this one has lied before: its
// first version globbed the webm voice notes in with the MP4s and tested them
// for boxes that exist only in MP4, so every healthy voice note came back
// looking corrupt — and I read that as the uploads being broken.
//
// So the report is RUN here, against files built to be good and bad in known
// ways, rather than read. The case that matters most is a file the old columns
// call healthy:
//
//   ftyp present, moov present, and the last few hundred bytes missing.
//
// A player opens that happily and fails part way through, which is exactly how
// an unplayable video gets described. "moov_head=1" says nothing about it. A
// walk of the box tree does: the boxes of an MP4 lie end to end and must tile
// the file exactly, so a box claiming bytes that are not there IS the
// truncation, measured.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const WF = path.join(ROOT, '.github', 'workflows', 'video-report.yml');

const tests = [];
const test = (n, f) => tests.push({ n, f });

/**
 * The script the workflow runs on the server.
 *
 * Pulled out of the YAML the way YAML itself would: the `run: |` block, minus
 * the indentation that makes it a block, and then the heredoc inside it. No
 * parser is available here and adding a dependency for one line of structure
 * would be worse than this.
 */
function remoteScript() {
  const raw = fs.readFileSync(WF, 'utf8');
  const lines = raw.split('\n');
  const at = lines.findIndex(l => /^\s*run: \|\s*$/.test(l));
  assert.ok(at > 0, 'the workflow no longer has a run block');
  const indent = (lines[at + 1].match(/^ */) || [''])[0].length;
  const body = [];
  for (let i = at + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() && (l.match(/^ */) || [''])[0].length < indent) break;
    body.push(l.slice(indent));
  }
  const step = body.join('\n');
  const from = step.indexOf("<<'EOF'");
  const to = step.indexOf('\nEOF', from);
  assert.ok(from > 0 && to > from, 'the server script is no longer a heredoc');
  return step.slice(from + "<<'EOF'".length, to);
}

/** An MP4 box: four bytes of length, four of type, then the payload. */
function box(type, payload) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(payload.length + 8, 0);
  head.write(type, 4, 'ascii');
  return Buffer.concat([head, payload]);
}

function fixtures(dir) {
  fs.mkdirSync(path.join(dir, 'uploads', '.partial'), { recursive: true });
  const ftyp = box('ftyp', Buffer.from('isom\x00\x00\x02\x00isomiso2avc1mp41', 'binary'));
  const moov = box('moov', Buffer.alloc(400));
  const mdat = box('mdat', Buffer.alloc(5000, 0x11));
  const good = Buffer.concat([ftyp, moov, mdat]);
  const up = (n, b) => fs.writeFileSync(path.join(dir, 'uploads', n), b);
  up('good.mp4', good);
  // The upload that stopped 137 bytes from the end.
  up('short.mp4', good.subarray(0, good.length - 137));
  // Truncated AND padded, which is what makes "size 0 means to the end of the
  // file" dangerous: a run of nulls reads as a box unless the type is checked.
  up('extra.mp4', Buffer.concat([good, Buffer.alloc(64)]));
  // A 64-bit length: size 1, and the real length after the type.
  const big = Buffer.alloc(16);
  big.writeUInt32BE(1, 0);
  big.write('mdat', 4, 'ascii');
  big.writeUInt32BE(0, 8);
  big.writeUInt32BE(16 + 3000, 12);
  up('big64.mp4', Buffer.concat([ftyp, moov, big, Buffer.alloc(3000, 0x22)]));
  // A voice note. Not an MP4, and must not be judged as one.
  up('voice.webm', Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(900, 7)]));
  fs.writeFileSync(path.join(dir, 'server.js'), 'function streamChunkToPart() {}\n');
}

function run() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vidreport-'));
  fixtures(dir);
  const script = path.join(dir, 'report.sh');
  fs.writeFileSync(script, remoteScript());
  return execFileSync('bash', [script], {
    cwd: dir,
    env: { ...process.env, APP_DIR: dir, COUNT: '12' },
    encoding: 'utf8',
  });
}

let out = null;
try { out = run(); } catch (e) { out = `REPORT CRASHED: ${e.message}\n${e.stdout || ''}`; }

/** The lines of one section, by its heading. */
function section(heading) {
  const lines = out.split('\n');
  const at = lines.findIndex(l => l.includes(heading));
  assert.ok(at >= 0, `the report no longer has a "${heading}" section:\n${out}`);
  const rows = [];
  for (let i = at + 1; i < lines.length; i++) {
    if (lines[i].startsWith('###')) break;
    if (lines[i].trim()) rows.push(lines[i]);
  }
  return rows;
}

test('THE REPORT RUNS AT ALL', () => {
  assert.ok(!/REPORT CRASHED/.test(out), out.slice(0, 600));
});

test('THE BUG THE OLD COLUMNS COULD NOT SEE: a truncated file is named', () => {
  // ftyp is there and moov is there, so every column the report had before
  // says this file is fine. It is missing its last 137 bytes.
  const rows = section('DOES THE BOX TREE REACH THE END');
  const short = rows.find(r => /TRUNCATED/.test(r));
  assert.ok(short, `no file was reported as truncated:\n${rows.join('\n')}`);
  assert.ok(/TRUNCATED by 137 bytes/.test(short),
    `the shortfall is measured wrongly: ${short}`);
});

test('…and the old columns really do call that same file healthy', () => {
  // Not a rhetorical point: this is why the section above was added, so it is
  // worth failing if it ever stops being true.
  const rows = section('the newest videos, and whether they are videos');
  const line = rows.find(r => /size=5311\b/.test(r));
  assert.ok(line, `the truncated file is missing from the old section:\n${rows.join('\n')}`);
  assert.ok(/moov_head=1/.test(line),
    'the truncated file no longer looks healthy to the old columns — check the fixture');
});

test('A SOUND FILE IS NOT ACCUSED', () => {
  // The expensive failure: a report that cries corruption sends me looking
  // for a bug in the upload path that is not there. It has happened.
  const rows = section('DOES THE BOX TREE REACH THE END');
  const good = rows.find(r => /size=5448\b/.test(r));
  assert.ok(good, `the sound file is missing from the walk:\n${rows.join('\n')}`);
  assert.ok(/\bok\b/.test(good), `a well-formed file was reported as broken: ${good}`);
  assert.ok(/boxes: ftyp moov mdat/.test(good), `the box chain is wrong: ${good}`);
});

test('A 64-BIT LENGTH IS NOT MISTAKEN FOR A ONE-BYTE BOX', () => {
  // Large files use it, and reading the 1 as a length would report every one
  // of them as broken — the same false alarm, on exactly the videos most
  // likely to be the subject of a complaint.
  const rows = section('DOES THE BOX TREE REACH THE END');
  const big = rows.find(r => /size=3456\b/.test(r));
  assert.ok(big, `the 64-bit file is missing from the walk:\n${rows.join('\n')}`);
  assert.ok(/\bok\b/.test(big), `a 64-bit box was misread: ${big}`);
});

test('TRAILING JUNK IS NOT READ AS A BOX', () => {
  // A length of 0 legally means "to the end of the file", so a run of nulls
  // on the end of a truncated upload reads as a final box and the file comes
  // back "ok". The four-character type is what stops it.
  const rows = section('DOES THE BOX TREE REACH THE END');
  const extra = rows.find(r => /size=5512\b/.test(r));
  assert.ok(extra, `the padded file is missing from the walk:\n${rows.join('\n')}`);
  assert.ok(/not a box type/.test(extra),
    `64 bytes of nulls were accepted as a box: ${extra}`);
});

test('A VOICE NOTE IS NOT JUDGED AS AN MP4', () => {
  // The lie this report told the first time. webm has no ftyp and no moov,
  // and testing it for them reported every healthy voice note as corrupt.
  for (const h of ['the newest videos, and whether they are videos',
                   'DOES THE BOX TREE REACH THE END']) {
    const rows = section(h);
    assert.ok(!rows.some(r => /size=904\b/.test(r)),
      `a webm is being judged as an MP4 in "${h}":\n${rows.join('\n')}`);
  }
  // It is still ACCOUNTED for, by what it actually is.
  const all = section('the newest uploads of ANY kind');
  assert.ok(all.some(r => /kind=webm\/matroska/.test(r)),
    `the voice note vanished from the report entirely:\n${all.join('\n')}`);
});

test('NOTHING IDENTIFYING IS WRITTEN DOWN', () => {
  // diagnostics/ is committed to a repository that has been public. Sizes,
  // ages and four-character box types only — never a filename, which on this
  // server is a timestamp that ties a video to the moment somebody sent it.
  for (const name of ['good.mp4', 'short.mp4', 'voice.webm', 'big64.mp4', 'extra.mp4']) {
    assert.ok(!out.includes(name), `the report writes the filename ${name} into diagnostics/`);
  }
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
