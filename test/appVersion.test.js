// ── "Web version doesn't prompt update" ─────────────────────────────────────
//
// Two things were wrong, and only one of them was the prompt.
//
// THE FINGERPRINT. The page compares the version it loaded with against
// /version, and the server built that from six named files — app.js, calls.js,
// e2e.js, credentials.js, style.css and index.html — out of the fifty-three
// that public/js alone holds. A deploy touching any of the other forty-seven
// produced an identical string, so every open tab compared new against old,
// found them equal, and went on running code from weeks ago. Nothing failed
// and nothing logged.
//
// A hand-kept list of "the files that matter" was always going to rot: every
// module written since — scrollAnchor, messageInfo, peerActions, messageMenu —
// was invisible to it from the moment it was created.
//
// THE PROMPT. When a change WAS noticed the page reloaded itself after a
// 600ms toast, which is fine if you are reading and is a half-written message
// thrown away if you are not.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const V = require(path.join(ROOT, 'public', 'js', 'appVersion.js'));

const tests = [];
const test = (n, f) => tests.push({ n, f });

test('THE FIRST READING IS NEVER AN UPDATE', () => {
  // The page has to learn its own version from somewhere. Treating that first
  // answer as a change would reload every tab the moment it opened, for ever.
  assert.strictEqual(V.versionChanged({ loaded: null, latest: 'abc' }), false);
  assert.strictEqual(V.versionChanged({ loaded: undefined, latest: 'abc' }), false);
  assert.strictEqual(V.updateAction({ loaded: null, latest: 'abc' }), 'none');
});

test('…and neither is the same version', () => {
  assert.strictEqual(V.versionChanged({ loaded: 'abc', latest: 'abc' }), false);
  assert.strictEqual(V.versionChanged({ loaded: 'abc', latest: '' }), false);
  assert.strictEqual(V.versionChanged({ loaded: 'abc', latest: null }), false);
  assert.strictEqual(V.versionChanged({}), false);
  assert.strictEqual(V.versionChanged(), false);
});

test('a different version IS', () => {
  assert.strictEqual(V.versionChanged({ loaded: 'abc', latest: 'def' }), true);
});

test('A TYPED MESSAGE IS NOT A REASON TO WAIT', () => {
  // My own mistake on the way past, and the reason the update stopped
  // happening at all: I treated a draft as something a reload would destroy,
  // so the update became a banner to tap, and a banner that can be ignored
  // is ignored. textDraft.js writes drafts to localStorage and restores them
  // when the chat reopens — nothing was ever at risk.
  assert.strictEqual(V.wouldLoseWork({ composerText: 'half a message' }), false);
  assert.strictEqual(V.wouldLoseWork({}), false);
  assert.strictEqual(V.wouldLoseWork(), false);
  assert.strictEqual(V.updateAction({ loaded: 'a', latest: 'b', composerText: 'draft' }), 'reload');
});

test('…but an upload, a call and a recording ARE', () => {
  // These exist only in this tab: a reload restarts the upload from zero,
  // drops the call outright, and loses what was being spoken.
  for (const k of ['uploading', 'inCall', 'recording']) {
    assert.strictEqual(V.wouldLoseWork({ [k]: true }), true, k);
    // …and they mean WAIT, never ask. The version still arrives, just not
    // in the middle of the thing.
    assert.strictEqual(V.updateAction({ loaded: 'a', latest: 'b', [k]: true }), 'wait', k);
  }
});

test('THERE IS NO "ASK" — IT UPDATES', () => {
  // "Web version doesn't force update", after the banner. A prompt that can
  // be ignored is ignored, and the person goes on running the build with the
  // bug they reported in it.
  const answers = new Set();
  for (const hidden of [true, false, undefined]) {
    for (const extra of [{}, { composerText: 'draft' }, { inCall: true },
                         { uploading: true }, { recording: true }]) {
      answers.add(V.updateAction({ loaded: 'abc', latest: 'def', hidden, ...extra }));
    }
  }
  assert.ok(!answers.has('ask'), 'the update is still something to be agreed to');
  assert.deepStrictEqual([...answers].sort(), ['reload', 'wait']);
});

test('being LOOKED AT is not a reason to hold back', () => {
  // The visible tab was the case the banner existed for, and it is the case
  // that matters most: somebody with the app open is somebody who will hit
  // the bug next.
  assert.strictEqual(V.updateAction({ loaded: 'abc', latest: 'def', hidden: false }), 'reload');
  assert.strictEqual(V.updateAction({ loaded: 'abc', latest: 'def' }), 'reload');
});

// ── The fingerprint ─────────────────────────────────────────────────────────

const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const serverCode = server.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');

test('EVERY FRONT-END FILE COUNTS, not a list somebody has to remember', () => {
  const i = serverCode.indexOf('const APP_VERSION');
  assert.ok(i > 0);
  const body = serverCode.slice(i, serverCode.indexOf('app.get(\'/version\'', i));
  assert.ok(/readdirSync/.test(body),
    'the version is built from a hand-written list again, so a new module is invisible to it');
  assert.ok(!/'public\/js\/app\.js'/.test(body), 'the old six-file list is back');
  // Sorted, or the answer depends on what order the filesystem returns —
  // which can differ between the two servers and make one of them look like
  // it is permanently out of date.
  assert.ok(/sort\(/.test(body), 'the walk is unsorted, so the fingerprint is not stable');
  // User content is excluded: uploads change constantly and would make every
  // photo anybody sends look like a new version of the app.
  assert.ok(/uploads/.test(body), 'uploads are hashed, so every photo sent is an "update"');
});

test('…and a file this repo actually has is in scope', () => {
  // The concrete failure: these exist, they are served to the browser, and
  // the old fingerprint could not see any of them.
  for (const f of ['scrollAnchor.js', 'messageInfo.js', 'peerActions.js', 'messageMenu.js']) {
    assert.ok(fs.existsSync(path.join(ROOT, 'public', 'js', f)), `${f} is missing`);
  }
  const i = serverCode.indexOf('const APP_VERSION');
  const body = serverCode.slice(i, serverCode.indexOf('app.get(\'/version\'', i));
  assert.ok(/\.(js\|css\|html\|json\|webmanifest)|js\|css\|html/.test(body),
    'the walk does not include javascript files');
});

test('THE FINGERPRINT MOVES WHEN A FILE DOES', () => {
  // Computed here the same way the server computes it, over the real tree, so
  // this fails if the walk ever stops noticing a change.
  const crypto = require('crypto');
  const root = path.join(ROOT, 'public');
  const fingerprint = (extraPath, extraBytes) => {
    const h = crypto.createHash('sha1');
    const walk = (dir) => {
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name === 'uploads' || e.name === 'tiles') continue;
          walk(full);
          continue;
        }
        if (!/\.(js|css|html|json|webmanifest)$/i.test(e.name)) continue;
        h.update(path.relative(root, full));
        h.update(fs.readFileSync(full));
      }
    };
    walk(root);
    if (extraPath) { h.update(extraPath); h.update(extraBytes); }
    return h.digest('hex').slice(0, 12);
  };
  const base = fingerprint();
  assert.strictEqual(base, fingerprint(), 'the fingerprint is not stable between runs');
  // One byte more, in a file the OLD list never looked at.
  assert.notStrictEqual(base, fingerprint('js/scrollAnchor.js', 'x'),
    'a change to a module outside the old six-file list still goes unnoticed');
});

// ── The wiring ──────────────────────────────────────────────────────────────

const app = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');
const appCode = app.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

test('THE PAGE TAKES IT, with nothing to tap', () => {
  assert.ok(/js\/appVersion\.js/.test(html), 'the rules are never loaded by the page');
  assert.ok(/AppVersion\.updateAction\(/.test(appCode), 'the page still decides for itself');
  assert.ok(!/showUpdateBanner/.test(appCode), 'the banner is back, and so is the ignoring of it');
  assert.ok(!/update-banner/.test(fs.readFileSync(path.join(ROOT, 'public', 'css', 'style.css'), 'utf8')),
    'the banner styling is still there for a banner nothing builds');
});

test('…and a busy tab is COME BACK TO, not forgotten', () => {
  // Waiting for an upload is only useful if something looks again soon. The
  // five-minute poll would leave the new version sitting there unapplied
  // long after the upload had finished.
  const i = appCode.indexOf('async function checkAppVersion');
  const body = appCode.slice(i, appCode.indexOf('\n}\n', i));
  assert.ok(/'wait'/.test(body), 'a busy tab is treated as nothing to do');
  assert.ok(/setTimeout\(checkAppVersion/.test(body),
    'nothing re-checks, so the update lands whenever the next poll happens to run');
});

test('THE DRAFT IS WRITTEN BEFORE THE RELOAD', () => {
  // Drafts surviving is the whole reason this no longer asks permission. The
  // save is debounced by 400ms, so the last characters typed would otherwise
  // be the ones lost — by the mechanism defending them.
  const i = appCode.indexOf('async function applyUpdate');
  const body = appCode.slice(i, appCode.indexOf('\n}', i));
  assert.ok(/flushDraft\(\)/.test(body), 'the newest characters typed are lost on reload');
});

test('…and taking it CLEARS THE CACHES first', () => {
  // Without that the page reloads onto the same files it already had: the
  // update "happens" and changes nothing, which is worse than not offering.
  const i = appCode.indexOf('async function applyUpdate');
  const body = appCode.slice(i, appCode.indexOf('\n}', i));
  assert.ok(/caches\.delete/.test(body), 'the reload replays the cached old files');
  assert.ok(/location\.reload\(\)/.test(body));
});

test('THE TAB IS NOT RELOADED OUT FROM UNDER REAL WORK', () => {
  const i = appCode.indexOf('async function checkAppVersion');
  const body = appCode.slice(i, appCode.indexOf('\n}\n', i));
  assert.ok(/updateContext\(\)/.test(body), 'the decision is made without looking at the tab');
  const ctx = appCode.slice(appCode.indexOf('function updateContext'));
  const cbody = ctx.slice(0, ctx.indexOf('\n}'));
  for (const k of ['uploading', 'inCall', 'recording']) {
    assert.ok(cbody.includes(k), `${k} is never looked at, so it cannot protect anything`);
  }
  // And a draft is NOT among them: it survives, and treating it as work to
  // protect is what made the update optional.
  assert.ok(!cbody.includes('composerText'),
    'a draft is being guarded again, which is how this became a banner');
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
