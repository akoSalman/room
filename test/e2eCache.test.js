// Decrypting messages (native-app/src/e2e.ts), and how often.
//
// Asked as: does a chat really have to decrypt everything again every time it
// is opened, even without leaving the app?
//
// It was worse than that. Decryption ran inside the message list's renderItem,
// so it happened on every RENDER of every visible row — on each scroll, on
// every reaction or read receipt that re-rendered the window, and completely
// afresh on re-entering the chat. tweetnacl is pure JavaScript, so all of it
// competes with the scroll for the same thread.
//
// A message's plaintext cannot change, so it is decrypted once and remembered.
// These tests are about the parts of "remembered" that can go wrong: serving
// plaintext under the wrong identity, and — the one that would be visible to
// users — remembering a failure that was only ever "the keys have not loaded
// yet", which would leave a readable message showing the padlock forever.
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const NAT = path.join(__dirname, '..', 'native-app');
const TSC = path.join(NAT, 'node_modules', '.bin', 'tsc');
if (!fs.existsSync(TSC) || !fs.existsSync(path.join(NAT, 'node_modules', 'tweetnacl'))) {
  console.log('  ! skipping e2e tests (native-app deps not installed)');
  process.exit(0);
}

const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'e2ecache-'));
execFileSync(TSC, [
  path.join(NAT, 'src', 'e2e.ts'),
  '--outDir', OUT, '--module', 'commonjs', '--target', 'es2019',
  '--skipLibCheck', '--esModuleInterop', '--moduleResolution', 'node',
], { stdio: 'pipe' });

// e2e.ts talks to React Native and to the app's own api module. None of that
// is what is under test, so it is stubbed — everything below exercises the
// real crypto and the real cache.
const NM = path.join(OUT, 'node_modules');
function stub(name, body) {
  const dir = path.join(NM, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, main: 'index.js' }));
  fs.writeFileSync(path.join(dir, 'index.js'), body);
}
stub('react-native-get-random-values', 'module.exports = {};');
stub('@react-native-async-storage/async-storage', `
  const mem = new Map();
  // __esModule, or TypeScript's interop helper wraps this a second time and
  // every call lands on undefined.
  module.exports = { __esModule: true, __mem: mem, default: {
    getItem: async k => (mem.has(k) ? mem.get(k) : null),
    setItem: async (k, v) => { mem.set(k, v); },
    multiRemove: async ks => { ks.forEach(k => mem.delete(k)); },
  } };
`);
// tweetnacl is the REAL one — the same instance the test spies on.
const NACL_PATH = require.resolve('tweetnacl', { paths: [NAT] });
stub('tweetnacl', `module.exports = require(${JSON.stringify(NACL_PATH)});`);
// The app's api module: never reached by anything here.
fs.writeFileSync(path.join(OUT, 'api.js'),
  'exports.apiFetch = async () => { throw new Error("network in a unit test"); };');

const nacl = require(NACL_PATH);
const store = require(path.join(NM, '@react-native-async-storage', 'async-storage')).__mem;
const E = require(path.join(OUT, 'e2e.js'));

const tests = [];
const test = (n, f) => tests.push({ n, f });

// ── A pair of identities, and a way to make real ciphertext ─────────────────

const b64 = (u8) => Buffer.from(u8).toString('base64');
const me = nacl.box.keyPair();
const peer = nacl.box.keyPair();
const other = nacl.box.keyPair();

/** Encrypt as `from` would, for `to` — the same envelope e2eEncrypt makes. */
function sealFor(fromSk, toPk, text) {
  const nonce = nacl.randomBytes(24);
  const ct = nacl.box(Buffer.from(text, 'utf8'), nonce, toPk, fromSk);
  const packed = new Uint8Array(24 + ct.length);
  packed.set(nonce, 0);
  packed.set(ct, 24);
  return 'e2e:' + b64(packed);
}

// e2e.ts keeps its keys module-private, and the only public way in that does
// not touch the network is the setup path. Rather than reach around it, the
// tests drive the exported surface and assert on what it produces.
//
// _setKeysForTest exists for exactly this; if it is ever removed these tests
// should fail loudly rather than silently testing nothing.
test('the module exposes a way to install keys for testing', () => {
  assert.strictEqual(typeof E._setKeysForTest, 'function',
    'no way to install a key pair — the tests below would all be vacuous');
});

function useMyKeys() {
  E._setKeysForTest({ publicKey: me.publicKey, secretKey: me.secretKey });
}

// ── Decrypting once ─────────────────────────────────────────────────────────

/** Count real openings of a box while `fn` runs. */
function countOpens(fn) {
  const real = nacl.box.open.after;
  let calls = 0;
  nacl.box.open.after = function (...args) { calls++; return real.apply(this, args); };
  try { fn(); } finally { nacl.box.open.after = real; }
  return calls;
}

test('THE POINT: the same message is only ever decrypted once', () => {
  useMyKeys();
  E.e2eForgetPlaintext();
  const ct = sealFor(peer.secretKey, me.publicKey, 'سلام، حالت چطوره؟');

  const first = countOpens(() => {
    assert.strictEqual(E.e2eDecrypt(ct, peer.publicKey), 'سلام، حالت چطوره؟');
  });
  assert.strictEqual(first, 1, 'the first decryption did no work at all');

  // Twenty more renders of the same row — a scroll, a reaction, a read
  // receipt, leaving the chat and coming back.
  const rest = countOpens(() => {
    for (let i = 0; i < 20; i++) {
      assert.strictEqual(E.e2eDecrypt(ct, peer.publicKey), 'سلام، حالت چطوره؟');
    }
  });
  assert.strictEqual(rest, 0, `re-rendering decrypted ${rest} more times`);
});

test('different messages are each decrypted, not confused for one another', () => {
  useMyKeys();
  E.e2eForgetPlaintext();
  const a = sealFor(peer.secretKey, me.publicKey, 'first');
  const b = sealFor(peer.secretKey, me.publicKey, 'second');
  assert.strictEqual(E.e2eDecrypt(a, peer.publicKey), 'first');
  assert.strictEqual(E.e2eDecrypt(b, peer.publicKey), 'second');
  assert.strictEqual(E.e2eDecrypt(a, peer.publicKey), 'first');
});

test('plaintext is never served across identities', () => {
  // The cache is keyed by the peer as well as the ciphertext. Without that, a
  // message could be handed back plaintext that was decrypted under somebody
  // else's key — the one mistake in a cache like this that is a security bug
  // rather than a performance one.
  useMyKeys();
  E.e2eForgetPlaintext();
  const ct = sealFor(peer.secretKey, me.publicKey, 'for the right peer');
  assert.strictEqual(E.e2eDecrypt(ct, peer.publicKey), 'for the right peer');
  assert.strictEqual(E.e2eDecrypt(ct, other.publicKey), null,
    "a message was decrypted with the wrong peer's key");
});

// ── What must NOT be remembered ─────────────────────────────────────────────

test('THE BUG THIS AVOIDS: "no keys yet" is not remembered as a failure', () => {
  // On a cold start the keys are read from storage asynchronously, so the
  // first render of a chat can happen before they arrive. That is not a failed
  // decryption — it is one that has not been attempted. Remembering it would
  // leave a perfectly readable message showing "cannot decrypt on this device"
  // for the rest of the session, moments after the keys landed.
  E._setKeysForTest(null);
  E.e2eForgetPlaintext();
  const ct = sealFor(peer.secretKey, me.publicKey, 'readable in a moment');
  assert.strictEqual(E.e2eDecrypt(ct, peer.publicKey), null);

  useMyKeys();
  assert.strictEqual(E.e2eDecrypt(ct, peer.publicKey), 'readable in a moment',
    'the message stayed unreadable after the keys arrived');
});

test('a message with no peer key yet is also left to be tried again', () => {
  useMyKeys();
  E.e2eForgetPlaintext();
  const ct = sealFor(peer.secretKey, me.publicKey, 'peer key still loading');
  assert.strictEqual(E.e2eDecrypt(ct, null), null);
  assert.strictEqual(E.e2eDecrypt(ct, peer.publicKey), 'peer key still loading');
});

test('a genuine failure IS remembered, rather than retried on every render', () => {
  useMyKeys();
  E.e2eForgetPlaintext();
  // Sealed for somebody else: this will never open with our keys.
  const ct = sealFor(other.secretKey, other.publicKey, 'not for us');
  assert.strictEqual(E.e2eDecrypt(ct, peer.publicKey), null);
  const again = countOpens(() => {
    assert.strictEqual(E.e2eDecrypt(ct, peer.publicKey), null);
  });
  assert.strictEqual(again, 0, 'a hopeless decryption was attempted again');
});

// ── Plaintext must not outlive the keys ─────────────────────────────────────

test('signing out drops every decrypted message from memory', async () => {
  useMyKeys();
  E.e2eForgetPlaintext();
  const ct = sealFor(peer.secretKey, me.publicKey, 'private');
  assert.strictEqual(E.e2eDecrypt(ct, peer.publicKey), 'private');

  await E.e2eClear();
  assert.strictEqual(E.e2eDecrypt(ct, peer.publicKey), null);

  // Asserting on the null above would prove nothing — with the keys gone that
  // is the answer either way. What proves the cache was emptied is that
  // decrypting the same message after signing back in does REAL work again,
  // rather than being served plaintext that outlived the sign-out.
  E._setKeysForTest({ publicKey: me.publicKey, secretKey: me.secretKey });
  const opens = countOpens(() => {
    assert.strictEqual(E.e2eDecrypt(ct, peer.publicKey), 'private');
  });
  assert.strictEqual(opens, 1, 'plaintext survived the keys being cleared');
});

test('an identity that cannot read a message is not handed its plaintext', async () => {
  // The cache is keyed by the PEER and the ciphertext, so a change to OUR OWN
  // key would not invalidate it on its own — and the plaintext of a
  // conversation belongs to the key pair that could read it. Loading a
  // different identity has to drop it, or the new one is served a decryption
  // it could not have performed.
  useMyKeys();
  E.e2eForgetPlaintext();
  const ct = sealFor(peer.secretKey, me.publicKey, 'only mine to read');
  assert.strictEqual(E.e2eDecrypt(ct, peer.publicKey), 'only mine to read');

  // Somebody else's identity is what is on disk now, and nothing is loaded.
  E._setKeysForTest(null);
  store.set('e2e_pk', b64(other.publicKey));
  store.set('e2e_sk', b64(other.secretKey));
  await E.e2eReady();

  assert.strictEqual(E.e2eDecrypt(ct, peer.publicKey), null,
    'a different identity was served plaintext it could not have decrypted');
});

test('non-encrypted content passes straight through and is not cached', () => {
  useMyKeys();
  assert.strictEqual(E.e2eDecrypt('just a plain message', peer.publicKey), 'just a plain message');
  assert.strictEqual(E.e2eDecrypt('', peer.publicKey), '');
  assert.strictEqual(E.e2eDecrypt(null, peer.publicKey), null);
});

test('the cache does not grow without limit', () => {
  // A long chat would otherwise hold every message it has ever shown.
  useMyKeys();
  E.e2eForgetPlaintext();
  const first = sealFor(peer.secretKey, me.publicKey, 'the oldest one');
  assert.strictEqual(E.e2eDecrypt(first, peer.publicKey), 'the oldest one');
  for (let i = 0; i < 3100; i++) {
    E.e2eDecrypt(sealFor(peer.secretKey, me.publicKey, `m${i}`), peer.publicKey);
  }
  // The oldest entry has been evicted, so decrypting it does real work again.
  const opens = countOpens(() => E.e2eDecrypt(first, peer.publicKey));
  assert.strictEqual(opens, 1, 'the cache kept everything ever decrypted');
});

(async () => {
  test('switching between two chats does not redo the key exchange', () => {
  // The shared key used to be a single slot, so opening another chat evicted
  // it and coming back redid nacl.box.before — hundreds of milliseconds of
  // pure JavaScript, on the thread that draws the chat.
  useMyKeys();
  E.e2eForgetPlaintext();
  const a = sealFor(peer.secretKey, me.publicKey, 'from peer');
  const b = sealFor(other.secretKey, me.publicKey, 'from other');
  E.e2eDecrypt(a, peer.publicKey);
  E.e2eDecrypt(b, other.publicKey);
  E.e2eForgetPlaintext();   // plaintext gone; the shared keys must not be
  const real = nacl.box.before;
  let dh = 0;
  nacl.box.before = function (...args) { dh++; return real.apply(this, args); };
  try {
    for (let i = 0; i < 6; i++) {
      E.e2eDecrypt(a, peer.publicKey);
      E.e2eDecrypt(b, other.publicKey);
    }
  } finally { nacl.box.before = real; }
  assert.strictEqual(dh, 0, `alternating between two chats redid the DH ${dh} times`);
});

let passed = 0, failed = 0;
  for (const { n, f } of tests) {
    try { await f(); console.log(`  ✓ ${n}`); passed++; }
    catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
  }
  fs.rmSync(OUT, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
