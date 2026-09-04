// "Cannot decrypt on this device", said about a conversation that was fine.
//
// Reported with a photograph: every bubble of a DM, both sides, reading
// "🔒 Encrypted message (cannot decrypt on this device)" — and the note that
// entering a chat sometimes takes a couple of seconds to decrypt and then
// stays like that.
//
// Two mistakes on top of each other.
//
// THE WORDING WAS A LIE IN PROGRESS. The peer's public key is fetched over the
// network when the chat opens; until it lands there is no key, and every
// message was drawn with the sentence reserved for a message that can NEVER be
// read here. On these connections that is a couple of seconds spent telling
// somebody their conversation is lost.
//
// AND IT WAS PERMANENT. A key arriving is not a re-render on either client: on
// the app it lands in a ref, and on the web the text is already written into
// the DOM. So the case where the messages were drawn first — exactly the case
// where the key is slow — kept the failure on screen until the chat was closed
// and reopened.
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const NAT = path.join(ROOT, 'native-app');
const TSC = path.join(NAT, 'node_modules', '.bin', 'tsc');

global.window = global;
const W = require(path.join(ROOT, 'public', 'js', 'e2eState.js'));

let A = null;
if (fs.existsSync(TSC)) {
  const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'e2est-'));
  execFileSync(TSC, [path.join(NAT, 'src', 'e2eState.ts'),
    '--outDir', OUT, '--module', 'commonjs', '--target', 'es2019', '--skipLibCheck'], { stdio: 'pipe' });
  A = require(path.join(OUT, 'e2eState.js'));
  process.on('exit', () => fs.rmSync(OUT, { recursive: true, force: true }));
} else {
  console.log('  ! app-side rules skipped (native-app deps not installed); web copy still checked');
}

const tests = [];
const test = (n, f) => tests.push({ n, f });

// ── What a chat is allowed to claim ─────────────────────────────────────────

test('THE LIE: no key YET is not "cannot decrypt on this device"', () => {
  const waiting = W.phaseFor({ hasKey: false, ready: true, attempts: 1 });
  assert.strictEqual(waiting, 'waiting');
  const body = W.undecryptedBody(waiting);
  assert.ok(/Decrypting/.test(body), `a chat still fetching its key says "${body}"`);
  assert.ok(!/cannot decrypt/i.test(body), 'a wait is announced as a permanent failure');
});

test('once the key is here there is nothing to say', () => {
  assert.strictEqual(W.phaseFor({ hasKey: true, ready: true, attempts: 3 }), 'ready');
  // Even when the identity check has not answered, a key IS a key.
  assert.strictEqual(W.phaseFor({ hasKey: true, ready: false, attempts: 0 }), 'ready');
});

test('a device with no identity is not kept waiting for one', () => {
  // There is nothing to retry: it needs the password, which is a different
  // conversation with the user.
  assert.strictEqual(W.phaseFor({ hasKey: false, ready: false, attempts: 0 }), 'unavailable');
});

test('and after enough tries, the honest answer', () => {
  const phase = W.phaseFor({ hasKey: false, ready: true, attempts: W.KEY_ATTEMPTS });
  assert.strictEqual(phase, 'unavailable', 'a chat says "Decrypting…" forever');
  assert.ok(/cannot decrypt/i.test(W.undecryptedBody(phase)));
  assert.strictEqual(W.stillTrying(phase), false);
  assert.strictEqual(W.stillTrying('waiting'), true);
});

test('a reply quote says the same thing in fewer words', () => {
  assert.ok(/Decrypting/.test(W.undecryptedQuote('waiting')));
  assert.ok(!/Decrypting/.test(W.undecryptedQuote('unavailable')));
});

// ── Asking again ────────────────────────────────────────────────────────────

test('THE SECOND HALF: the key is asked for more than once', () => {
  assert.ok(W.KEY_ATTEMPTS > 1, 'one attempt, and a failed one loses the conversation');
  assert.strictEqual(W.keepTryingKey(0), true);
  assert.strictEqual(W.keepTryingKey(W.KEY_ATTEMPTS - 1), true);
  assert.strictEqual(W.keepTryingKey(W.KEY_ATTEMPTS), false, 'it retries forever');
});

test('the first retry is quick and the last is not', () => {
  // The commonest failure is a request made in the second before the network
  // came up; after that, backing off matters more than speed.
  assert.ok(W.keyRetryDelay(0) <= 600, `first retry after ${W.keyRetryDelay(0)}ms`);
  assert.ok(W.keyRetryDelay(3) >= 3000, 'the ladder never backs off');
  for (let i = 1; i < 4; i++) {
    assert.ok(W.keyRetryDelay(i) > W.keyRetryDelay(i - 1), `step ${i} does not grow`);
  }
  // Out of range is clamped rather than undefined.
  assert.strictEqual(W.keyRetryDelay(99), W.keyRetryDelay(3));
  assert.strictEqual(W.keyRetryDelay(-1), W.keyRetryDelay(0));
});

test('only an ARRIVING key redraws anything', () => {
  assert.strictEqual(W.repaintNeeded({ hasKey: false }, { hasKey: true }), true);
  assert.strictEqual(W.repaintNeeded({ hasKey: true }, { hasKey: true }), false,
    'the conversation is redrawn every time the key is set again');
  // Leaving a chat clears the key; that cannot make anything readable.
  assert.strictEqual(W.repaintNeeded({ hasKey: true }, { hasKey: false }), false);
  assert.strictEqual(W.repaintNeeded(null, { hasKey: true }), true);
});

test('the web and the app agree, in every state', () => {
  if (!A) return;
  assert.strictEqual(W.KEY_ATTEMPTS, A.KEY_ATTEMPTS);
  let checked = 0;
  for (const hasKey of [true, false]) {
    for (const ready of [true, false]) {
      for (let attempts = 0; attempts <= W.KEY_ATTEMPTS + 1; attempts++) {
        const o = { hasKey, ready, attempts };
        const p = W.phaseFor(o);
        assert.strictEqual(p, A.phaseFor(o), `phases diverge for ${JSON.stringify(o)}`);
        assert.strictEqual(W.undecryptedBody(p), A.undecryptedBody(p));
        assert.strictEqual(W.undecryptedQuote(p), A.undecryptedQuote(p));
        checked++;
      }
    }
  }
  for (let i = -1; i < 8; i++) assert.strictEqual(W.keyRetryDelay(i), A.keyRetryDelay(i));
  assert.ok(checked >= 24, `the drift check only ran ${checked} times`);
});

// ── The wiring, which the rules above cannot see ────────────────────────────

const webApp = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');
const chat = fs.readFileSync(path.join(NAT, 'src', 'screens', 'ChatScreen.tsx'), 'utf8');

test('neither client writes the permanent sentence by hand any more', () => {
  for (const [name, src] of [['the web', webApp], ['the app', chat]]) {
    const lines = src.split('\n').filter(l => /cannot decrypt on this device/.test(l)
      && !/^\s*(\/\/|\*)/.test(l.trim()));
    assert.deepStrictEqual(lines, [],
      `${name} still spells out the permanent failure: ${lines[0]}`);
  }
});

test('both clients ask again instead of once', () => {
  assert.ok(/function fetchDMPeerKey\(/.test(webApp), 'the web still has a single attempt');
  const web = webApp.slice(webApp.indexOf('async function fetchDMPeerKey('),
    webApp.indexOf('const MESSAGES_PAGE_SIZE'));
  assert.ok(/keepTryingKey\(dmKeyAttempts\)/.test(web), 'the web retries forever, or not at all');
  assert.ok(/setTimeout\(\(\) => fetchDMPeerKey\(roomId, roomName\)/.test(web),
    'nothing is scheduled, so the retry never happens');
  assert.ok(/String\(roomId\) !== String\(currentRoomId\)/.test(web),
    'a retry can land in a chat the user has already left');

  const app = chat.slice(chat.indexOf('// The peer\'s key, asked for until it arrives.'),
    chat.indexOf('async function unlockE2E('));
  assert.ok(app.length > 0, 'the app key effect is gone — this check would be vacuous');
  assert.ok(/keepTryingKey\(attempt\)/.test(app), 'the app retries forever, or not at all');
  assert.ok(/timer = setTimeout\(tick, keyRetryDelay\(attempt - 1\)\)/.test(app),
    'nothing is scheduled, so the retry never happens');
  assert.ok(/alive = false; clearTimeout\(timer\)/.test(app),
    'a retry keeps running after the chat is closed');
  assert.ok(/if \(!alive\) return;/.test(app), 'a slow answer lands in a chat that is gone');
});

test('THE STUCK CHAT: an arriving key redraws what was drawn without it', () => {
  // The web has no message list to re-render — the text is in the DOM — so
  // each unreadable bubble keeps the message it was built from.
  assert.ok(/E2EState\.repaintNeeded\(had, \{ hasKey: !!k \}\)/.test(webApp),
    'the web never notices a key arriving');
  assert.ok(/function repaintEncrypted\(\)/.test(webApp), 'there is nothing to redraw with');
  const paint = webApp.slice(webApp.indexOf('function repaintEncrypted()'),
    webApp.indexOf('function buildMessageElement('));
  assert.ok(/el\._encRaw/.test(paint) && /el\.replaceWith\(fresh\)/.test(paint),
    'the repaint does not actually replace anything');
  assert.ok(/if \(msg\._undecrypted\) wrapper\._encRaw = raw;/.test(webApp),
    'nothing is kept to rebuild from, so the repaint finds no bubbles');
  // …and a bubble that DID decrypt keeps nothing, or every message in the
  // chat would be redrawn for nothing.
  assert.ok(/if \(dec === null\) copy\._undecrypted = true;/.test(webApp),
    'the placeholder is detected by comparing rendered text, which is a trap');

  // The app re-renders from state, but only if the rows are told.
  assert.ok(/selectMode, e2ePhase \}\)/.test(chat),
    'the app rows are not told the phase, so they keep the words they were drawn with');
});

test('a chat that lost its identity is not left saying "Decrypting…"', () => {
  // Running out of attempts changes the words with no key ever arriving, so
  // something has to redraw then too.
  const web = webApp.slice(webApp.indexOf('async function fetchDMPeerKey('),
    webApp.indexOf('const MESSAGES_PAGE_SIZE'));
  assert.ok(/repaintEncrypted\(\);/.test(web),
    'the web leaves "Decrypting…" on screen after it has given up');
  assert.ok(/setKeyAttempts\(attempt\)/.test(chat),
    'the app never records an attempt, so its bubbles cannot change their wording');
});

test('the module is actually loaded by the page', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  assert.ok(/src="\/js\/e2eState\.js"/.test(html),
    'e2eState.js is never loaded, so E2EState is undefined and every DM throws');
  const scripts = html.match(/<script src="\/js\/[^"]+"><\/script>/g) || [];
  assert.ok(scripts.indexOf('<script src="/js/e2eState.js"></script>')
    < scripts.indexOf('<script src="/js/app.js"></script>'),
    'e2eState.js is loaded after app.js');
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
