// Decrypting messages in the browser (public/js/e2e.js), and how often.
//
// Reported, again, after the app was fixed: "still on every chat open
// decryption occurs." The app had been given a plaintext cache; the web had
// not, so every time a DM was opened the page decrypted the whole visible
// history from scratch — and re-decrypted it on every re-render, because
// decryption happens while rendering. tweetnacl is pure JavaScript on the same
// thread that draws the page.
//
// The web module also kept exactly ONE shared key, so alternating between two
// chats redid the Diffie-Hellman step — the most expensive operation in the
// file — on every switch.
const assert = require('assert');
const path = require('path');
const fs = require('fs');

const NAT = path.join(__dirname, '..', 'native-app');
let nacl;
try {
  nacl = require(require.resolve('tweetnacl', { paths: [NAT] }));
} catch {
  console.log('  ! skipping web e2e tests (tweetnacl not installed)');
  process.exit(0);
}

// e2e.js is a classic script that expects a browser. Give it the two globals
// it actually touches and load the REAL file — nothing here is a
// reimplementation, or it would prove nothing about what ships.
const mem = new Map();
global.window = global;
global.nacl = nacl;
global.localStorage = {
  getItem: k => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: k => mem.delete(k),
};
require(path.join(__dirname, '..', 'public', 'js', 'e2e.js'));
const E = global.window.E2E;

const tests = [];
const test = (n, f) => tests.push({ n, f });

const b64 = u8 => Buffer.from(u8).toString('base64');
const me = nacl.box.keyPair();
const peer = nacl.box.keyPair();
const other = nacl.box.keyPair();

/** Encrypt as `from` would, for `to` — the same envelope encrypt() makes. */
function sealFor(fromSk, toPk, text) {
  const nonce = nacl.randomBytes(24);
  const ct = nacl.box(Buffer.from(text, 'utf8'), nonce, toPk, fromSk);
  const packed = new Uint8Array(24 + ct.length);
  packed.set(nonce, 0);
  packed.set(ct, 24);
  return 'e2e:' + b64(packed);
}

function useMyKeys() {
  E._setKeysForTest({ publicKey: me.publicKey, secretKey: me.secretKey });
}

/** Count real openings of a box while `fn` runs. */
function countOpens(fn) {
  const real = nacl.box.open.after;
  let calls = 0;
  nacl.box.open.after = function (...args) { calls++; return real.apply(this, args); };
  try { fn(); } finally { nacl.box.open.after = real; }
  return calls;
}

/** Count Diffie-Hellman derivations while `fn` runs. */
function countDh(fn) {
  const real = nacl.box.before;
  let calls = 0;
  nacl.box.before = function (...args) { calls++; return real.apply(this, args); };
  try { fn(); } finally { nacl.box.before = real; }
  return calls;
}

test('the module exposes a way to install keys for testing', () => {
  assert.strictEqual(typeof E._setKeysForTest, 'function',
    'no way to install a key pair — every test below would be vacuous');
});

test('THE BUG: opening a chat again does not decrypt it again', () => {
  useMyKeys();
  E.forgetPlaintext();
  const history = ['سلام', 'خوبی؟', 'کجایی؟'].map(t => sealFor(peer.secretKey, me.publicKey, t));

  const first = countOpens(() => history.forEach(c => E.decrypt(c, peer.publicKey)));
  assert.strictEqual(first, 3, 'the first open did not decrypt the history at all');

  // Opening the chat again, and twenty re-renders of it.
  const again = countOpens(() => {
    for (let i = 0; i < 20; i++) {
      history.forEach((c, j) => assert.strictEqual(
        E.decrypt(c, peer.publicKey), ['سلام', 'خوبی؟', 'کجایی؟'][j]));
    }
  });
  assert.strictEqual(again, 0, `re-opening decrypted ${again} more times`);
});

test('THE OTHER HALF: switching between two chats does not redo the key exchange', () => {
  useMyKeys();
  E.forgetPlaintext();
  const a = sealFor(peer.secretKey, me.publicKey, 'from peer');
  const b = sealFor(other.secretKey, me.publicKey, 'from other');
  // Prime both.
  E.decrypt(a, peer.publicKey);
  E.decrypt(b, other.publicKey);
  E.forgetPlaintext();   // plaintext gone; the shared keys must not be
  const dh = countDh(() => {
    for (let i = 0; i < 6; i++) {
      E.decrypt(a, peer.publicKey);
      E.decrypt(b, other.publicKey);
    }
  });
  assert.strictEqual(dh, 0, `alternating between two chats redid the DH ${dh} times`);
});

test('different messages are each decrypted, not confused for one another', () => {
  useMyKeys();
  E.forgetPlaintext();
  const a = sealFor(peer.secretKey, me.publicKey, 'first');
  const b = sealFor(peer.secretKey, me.publicKey, 'second');
  assert.strictEqual(E.decrypt(a, peer.publicKey), 'first');
  assert.strictEqual(E.decrypt(b, peer.publicKey), 'second');
  assert.strictEqual(E.decrypt(a, peer.publicKey), 'first');
});

test('plaintext is never served across identities', () => {
  // The one mistake in a cache like this that is a security bug rather than a
  // performance one: handing back text decrypted under somebody else's key.
  useMyKeys();
  E.forgetPlaintext();
  const ct = sealFor(peer.secretKey, me.publicKey, 'for the right peer');
  assert.strictEqual(E.decrypt(ct, peer.publicKey), 'for the right peer');
  assert.strictEqual(E.decrypt(ct, other.publicKey), null,
    "a message was decrypted with the wrong peer's key");
});

test('"no keys yet" is not remembered as a failure', () => {
  // The keys are read from storage on load, so a render can happen before they
  // are there. That is not a failed decryption — it is one that has not been
  // attempted, and remembering it would leave a readable message showing the
  // padlock for the rest of the session.
  E._setKeysForTest(null);
  E.forgetPlaintext();
  const ct = sealFor(peer.secretKey, me.publicKey, 'readable in a moment');
  assert.strictEqual(E.decrypt(ct, peer.publicKey), null);
  useMyKeys();
  assert.strictEqual(E.decrypt(ct, peer.publicKey), 'readable in a moment',
    'the message stayed unreadable after the keys arrived');
});

test('a genuine failure IS remembered rather than retried on every render', () => {
  useMyKeys();
  E.forgetPlaintext();
  const ct = sealFor(other.secretKey, other.publicKey, 'not for us');
  assert.strictEqual(E.decrypt(ct, peer.publicKey), null);
  const again = countOpens(() => assert.strictEqual(E.decrypt(ct, peer.publicKey), null));
  assert.strictEqual(again, 0, 'a hopeless decryption was attempted again');
});

test('signing out drops every decrypted message', () => {
  useMyKeys();
  E.forgetPlaintext();
  const ct = sealFor(peer.secretKey, me.publicKey, 'private');
  assert.strictEqual(E.decrypt(ct, peer.publicKey), 'private');
  E.clear();
  useMyKeys();   // a different session, same device
  const opens = countOpens(() => E.decrypt(ct, peer.publicKey));
  assert.strictEqual(opens, 1,
    'plaintext survived a sign-out — it was served without decrypting anything');
});

test('the cache is bounded, so a long chat cannot grow it forever', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'e2e.js'), 'utf8');
  assert.ok(/PLAIN_CACHE_MAX\s*=\s*\d+/.test(src), 'the plaintext cache has no bound');
  useMyKeys();
  E.forgetPlaintext();
  const max = parseInt(src.match(/PLAIN_CACHE_MAX\s*=\s*(\d+)/)[1], 10);
  // One past the bound, then ask for the oldest again: it must have been
  // dropped, which means decrypting it once more.
  const first = sealFor(peer.secretKey, me.publicKey, 'oldest');
  E.decrypt(first, peer.publicKey);
  for (let i = 0; i < max; i++) E.decrypt(sealFor(peer.secretKey, me.publicKey, 'm' + i), peer.publicKey);
  const opens = countOpens(() => E.decrypt(first, peer.publicKey));
  assert.strictEqual(opens, 1, 'the oldest entry was never evicted — the cache is unbounded in practice');
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
