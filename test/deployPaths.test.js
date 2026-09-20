// ── The deploy must actually run when the server changes ────────────────────
//
// A bug that hides itself, and has now happened twice.
//
// deploy-servers.yml triggers on a list of paths. A server module that is not
// on that list can be changed, committed, tested and pushed — everything looks
// exactly like a successful change — and no deploy runs. The servers keep
// running the old code, indefinitely, with nothing anywhere saying so.
//
// It happened first with credentials.js, which got a comment saying so. It
// then happened again with notify.js, which holds the rule deciding whether a
// device's push token is deleted. So the fix for "push notifications stopped
// working" sat in the repository, passing its tests, while every server kept
// throwing tokens away.
//
// A comment did not prevent the second one. This does: the list is checked
// against what server.js actually requires, so adding a module without adding
// it here fails before it can quietly not-deploy.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const wf = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'deploy-servers.yml'), 'utf8');
const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

const tests = [];
const test = (n, f) => tests.push({ n, f });

/** Local modules server.js requires, as filenames. */
function requiredModules(src = server) {
  const out = new Set();
  for (const m of src.matchAll(/require\('\.\/([A-Za-z0-9_/-]+)'\)/g)) {
    out.add(`${m[1]}.js`);
  }
  return [...out].sort();
}

/** The paths the deploy workflow watches. */
function watchedPaths() {
  const at = wf.indexOf('paths:');
  const end = wf.indexOf('workflow_dispatch:');
  const block = wf.slice(at, end > at ? end : at + 1200);
  return (block.match(/- '([^']+)'/g) || []).map(s => s.slice(3, -1));
}

test('THE SELF-HIDING BUG: every module server.js requires triggers a deploy', () => {
  const watched = watchedPaths();
  const missing = requiredModules().filter(f => !watched.includes(f));
  assert.deepStrictEqual(missing, [],
    `server.js requires ${missing.join(', ')}, but changing ${missing.length === 1 ? 'it' : 'them'} `
    + 'alone runs no deploy — the fix is committed and the servers never get it');
});

test('…and the ones this was actually caught by are named', () => {
  // Not a substitute for the check above — a pin, so the two that cost real
  // releases cannot be dropped by someone tidying the list.
  const watched = watchedPaths();
  for (const f of ['server.js', 'db.js', 'credentials.js', 'notify.js']) {
    assert.ok(watched.includes(f), `${f} is not watched, so changing it deploys nothing`);
  }
});

test('the check reads its input rather than answering from a list', () => {
  // A hardcoded list of today's modules passes every other test in this file —
  // and then a NEW module goes unwatched, which is the bug, one module later.
  // So the scanner is driven with source it has never seen.
  assert.deepStrictEqual(
    requiredModules("const a = require('./zzz'); const b = require('./deep/thing');"),
    ['deep/thing.js', 'zzz.js'],
    'the scan does not actually read the source it is given');
  assert.deepStrictEqual(requiredModules("require('express')"), [],
    'a package from node_modules is mistaken for a local file');
  assert.deepStrictEqual(requiredModules(''), []);
  // …and on the real file it finds every module, not just the famous ones.
  const found = requiredModules();
  assert.ok(found.length >= 5,
    `only ${found.length} requires found in server.js; the pattern stopped matching`);
  for (const f of ['notify.js', 'db.js', 'webPush.js', 'linkMeta.js']) {
    assert.ok(found.includes(f), `the scan missed ${f}`);
  }
});

test('a deploy can still be run by hand', () => {
  // Every path-triggered workflow needs this, or a missed trigger has no
  // remedy except an empty commit.
  assert.ok(/workflow_dispatch:/.test(wf), 'the deploy cannot be triggered manually');
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
