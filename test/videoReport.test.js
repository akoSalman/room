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
  // ls -t orders the report, so the fixtures get distinct, decreasing
  // modification times. Left identical, which files appear at all depends on
  // how the filesystem happens to break the tie.
  let age = 0;
  const up = (n, b) => {
    const f = path.join(dir, 'uploads', n);
    fs.writeFileSync(f, b);
    const t = new Date(Date.now() - (age++ * 60_000));
    fs.utimesSync(f, t, t);
  };
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
  // MANY boxes, and sound. This is the case the first version of the walk
  // got wrong: it stopped after a fixed number of boxes and reported the
  // unwalked remainder as "stops N bytes short", which reads exactly like a
  // truncation. Every real video on the server came back that way, and the
  // shortfalls it printed were megabytes.
  const many = [ftyp, moov];
  for (let i = 0; i < 120; i++) many.push(box('mdat', Buffer.alloc(64, 0x33)));
  up('many.mp4', Buffer.concat(many));
  // Chunk offsets: one file whose moov was moved to the front WITH its
  // offsets rewritten, and one without — which is structurally perfect and
  // plays nothing. Only the second check can tell them apart.
  const stbl = (offsets) => box('stbl', box('stco', Buffer.concat([
    Buffer.alloc(4),
    (() => { const b = Buffer.alloc(4); b.writeUInt32BE(offsets.length, 0); return b; })(),
    ...offsets.map(o => { const b = Buffer.alloc(4); b.writeUInt32BE(o, 0); return b; }),
  ])));
  const moovWith = (offsets) => box('moov', box('trak', box('mdia', box('minf', stbl(offsets)))));
  const sftyp = box('ftyp', Buffer.from('isom\x00\x00\x00\x00isomiso2', 'binary'));
  const md1 = box('mdat', Buffer.alloc(1000, 0xaa));
  const md2 = box('mdat', Buffer.alloc(1000, 0xbb));
  const moovLen = moovWith([0, 0]).length;
  const at1 = sftyp.length + moovLen + 8;
  const at2 = at1 + md1.length;
  up('offs_good.mp4', Buffer.concat([sftyp, moovWith([at1, at2]), md1, md2]));
  // The classic faststart-done-wrong: the offsets still describe the layout
  // the file had before the moov was moved in front of the media.
  up('offs_bad.mp4', Buffer.concat([sftyp, moovWith([sftyp.length + 8, sftyp.length + 8 + 1008]), md1, md2]));
  // The same thing with 64-bit offsets. A file over 4GB uses co64 instead of
  // stco, and code that claims to read it while no test ever does is a
  // liability in an instrument whose whole job is to be believed.
  const stbl64 = (offsets) => box('stbl', box('co64', Buffer.concat([
    Buffer.alloc(4),
    (() => { const b = Buffer.alloc(4); b.writeUInt32BE(offsets.length, 0); return b; })(),
    ...offsets.map(o => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(o), 0); return b; }),
  ])));
  const moov64 = (offsets) => box('moov', box('trak', box('mdia', box('minf', stbl64(offsets)))));
  const m64len = moov64([0, 0]).length;
  const b1 = sftyp.length + m64len + 8;
  up('offs64_bad.mp4', Buffer.concat([sftyp, moov64([8, 9]), md1, md2]));
  up('offs64_good.mp4', Buffer.concat([sftyp, moov64([b1, b1 + md1.length]), md1, md2]));
  // A voice note. Not an MP4, and must not be judged as one.
  up('voice.webm', Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(900, 7)]));
  fs.writeFileSync(path.join(dir, 'server.js'), 'function streamChunkToPart() {}\n');
}

/**
 * Run the report over the fixtures.
 *
 * `hidePython` runs it with python3 unreachable, which is the SHELL walk —
 * the one that spawns processes per box, needs a cap, and lied because of
 * that cap. Whether the server has python3 is not something this repository
 * gets to decide, so both paths are tested and both must agree.
 */
function run(hidePython) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vidreport-'));
  fixtures(dir);
  const script = path.join(dir, 'report.sh');
  fs.writeFileSync(script, remoteScript());
  const env = { ...process.env, APP_DIR: dir, COUNT: '12' };
  if (hidePython) {
    // A PATH with the ordinary tools and no python3 anywhere on it.
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    for (const t of ['bash', 'dd', 'od', 'stat', 'ls', 'head', 'grep', 'sed',
                     'tr', 'find', 'wc', 'date', 'printf', 'seq', 'tail', 'cut']) {
      try { fs.symlinkSync(execFileSync('bash', ['-c', `command -v ${t}`], { encoding: 'utf8' }).trim(), path.join(bin, t)); } catch {}
    }
    env.PATH = bin;
  }
  return execFileSync('bash', [script], { cwd: dir, env, encoding: 'utf8' });
}

let out = null;
try { out = run(false); } catch (e) { out = `REPORT CRASHED: ${e.message}\n${e.stdout || ''}`; }
let shellOut = null;
try { shellOut = run(true); } catch (e) { shellOut = `REPORT CRASHED: ${e.message}\n${e.stdout || ''}`; }

/** The lines of one section, by its heading. */
function section(heading, from) {
  const lines = (from || out).split('\n');
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

test('A FILE WITH MANY BOXES IS NOT ACCUSED OF BEING SHORT', () => {
  // The lie the second version of this report told, and the reason it is
  // worth a fixture of its own. The walk stopped after a fixed number of
  // boxes and called the unwalked remainder a shortfall, so every real video
  // on the server was reported as missing megabytes. Nothing was wrong with
  // any of them.
  // BOTH walks, because which one runs depends on whether the server has
  // python3, and the shell one is the one that lied.
  for (const [what, src] of [['python walk', out], ['shell walk', shellOut]]) {
    const rows = section('DOES THE BOX TREE REACH THE END', src);
    const many = rows.find(r => /size=9080\b/.test(r));
    assert.ok(many, `${what}: the many-box file is missing:\n${rows.join('\n')}`);
    assert.ok(!/short|TRUNCATED/.test(many),
      `${what}: a sound file with many boxes is reported as incomplete: ${many}`);
    assert.ok(/\bok\b/.test(many), `${what}: a sound file with many boxes was not accepted: ${many}`);
  }
  // And the chain stays readable rather than printing a hundred names.
  const many = section('DOES THE BOX TREE REACH THE END').find(r => /size=9080\b/.test(r));
  assert.ok(/mdatx120/.test(many), `repeated boxes are not collapsed: ${many}`);
});

test('…AND THE TWO WALKS AGREE ABOUT EVERY FILE', () => {
  // A report whose answer depends on what happens to be installed is not a
  // measurement. Compared by verdict, not by formatting.
  const verdicts = (src) => section('DOES THE BOX TREE REACH THE END', src)
    .map(r => r.replace(/age=\S+\s*/, '').replace(/\s+/g, ' ').trim())
    .map(r => r.replace(/boxes:.*/, '').trim())
    .sort();
  assert.deepStrictEqual(verdicts(shellOut), verdicts(out),
    'the shell walk and the python walk disagree about these files');
});

test('THE LAST THING A COMPLETE FILE CAN STILL BE WRONG ABOUT', () => {
  // A moov moved to the front without its chunk offsets rewritten gives a
  // file that tiles perfectly, has every box in the right place, and plays
  // nothing — so the box walk calls it healthy. Every transcoded video on
  // the server has exactly that layout, which is why this check exists.
  const rows = section('DO THE CHUNK OFFSETS POINT AT THE MEDIA');
  assert.ok(rows.length >= 2, `the offset check produced nothing:\n${rows.join('\n')}`);
  const bad = rows.find(r => /outside the media|NO CHUNK OFFSET/.test(r));
  assert.ok(bad, `a file whose offsets point at the wrong place passed:\n${rows.join('\n')}`);
  // …and the file whose offsets WERE rewritten is not accused of it.
  const good = rows.filter(r => /\bok\b/.test(r));
  assert.ok(good.length >= 1, `the sound file was accused too:\n${rows.join('\n')}`);
  // Both widths. A file over 4GB carries its offsets as co64 rather than
  // stco, and reading only one of the two would quietly report the other as
  // having no offsets at all.
  assert.ok(rows.filter(r => /outside the media|NO CHUNK OFFSET/.test(r)).length >= 2,
    `only one width of offset table is being read:\n${rows.join('\n')}`);
  // Files built without sample tables say so, correctly — the fixtures for
  // the box walk have no stbl at all. What matters is that both widths of
  // table are READ where one exists.
  assert.ok(rows.filter(r => /\bok\b/.test(r)).length >= 2,
    `a file whose offsets were rewritten is still accused:\n${rows.join('\n')}`);
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
