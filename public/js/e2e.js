// ── End-to-end encryption (DMs) ────────────────────────────────────────────────
// X25519 + XSalsa20-Poly1305 via TweetNaCl. Each user has one keypair; the
// private key is stored locally and ALSO kept on the server encrypted with a
// key derived from the user's password, so the same identity unlocks on any
// device at login. The server only ever sees opaque ciphertext.

const E2E = (() => {
  const b64 = {
    enc: (u8) => btoa(String.fromCharCode(...u8)),
    dec: (str) => Uint8Array.from(atob(str), c => c.charCodeAt(0)),
  };

  // Password → 32-byte key: salted, iterated SHA-512 (pure-JS portable KDF —
  // same implementation on web and native so blobs are interchangeable).
  function deriveKey(password, saltU8) {
    const pw = new TextEncoder().encode(password);
    let h = new Uint8Array(64 + pw.length + saltU8.length);
    h.set(saltU8, 0); h.set(pw, saltU8.length);
    let digest = nacl.hash(h.subarray(0, saltU8.length + pw.length));
    for (let i = 0; i < 10000; i++) digest = nacl.hash(digest);
    return digest.subarray(0, 32);
  }

  let myKeys = null; // { publicKey: Uint8Array, secretKey: Uint8Array }
  const peerKeys = {}; // userId -> Uint8Array | null

  function loadLocal() {
    const pk = localStorage.getItem('e2e_pk'), sk = localStorage.getItem('e2e_sk');
    if (pk && sk) {
      myKeys = { publicKey: b64.dec(pk), secretKey: b64.dec(sk) };
      // Plaintext is cached against the PEER's key, so a change to OURS would
      // not invalidate it on its own — and text produced under a different key
      // pair belongs to somebody else's conversation.
      forgetPlaintext();
    }
    return !!myKeys;
  }

  function storeLocal(keys) {
    myKeys = keys;
    forgetPlaintext();   // same reason as in loadLocal

    localStorage.setItem('e2e_pk', b64.enc(keys.publicKey));
    localStorage.setItem('e2e_sk', b64.enc(keys.secretKey));
  }

  function makeEncPrivBlob(secretKey, password) {
    const salt = nacl.randomBytes(16);
    const key = deriveKey(password, salt);
    const nonce = nacl.randomBytes(24);
    const ct = nacl.secretbox(secretKey, nonce, key);
    return { salt: b64.enc(salt), nonce: b64.enc(nonce), ct: b64.enc(ct) };
  }

  // Runs at login while the password is in hand: unlock the existing identity
  // or create one. `api` is the app's fetch helper.
  async function setup(password, api) {
    try {
      const mine = await api('/keys/me');
      if (mine?.encPriv) {
        // Identity exists — unlock only. Never publish a replacement keypair,
        // or peers' messages (encrypted to the original key) become unreadable.
        const key = deriveKey(password, b64.dec(mine.encPriv.salt));
        const sk = nacl.secretbox.open(b64.dec(mine.encPriv.ct), b64.dec(mine.encPriv.nonce), key);
        if (sk) {
          storeLocal({ publicKey: b64.dec(mine.publicKey), secretKey: new Uint8Array(sk) });
          return true;
        }
        console.warn('[e2e] wrong password — key stays locked');
        return false;
      }
      const keys = nacl.box.keyPair();
      const r = await api('/keys', 'POST', {
        publicKey: b64.enc(keys.publicKey),
        encPriv: makeEncPrivBlob(keys.secretKey, password),
      });
      if (r?.error === 'public_key_exists') return false;
      storeLocal(keys);
      return true;
    } catch (e) {
      console.warn('[e2e] setup failed:', e);
      return loadLocal();
    }
  }

  // Re-wrap the private key when the user changes their password.
  async function rewrap(newPassword, api) {
    if (!myKeys) return;
    try {
      // Re-wrap only: keep the published public key, refresh the private blob.
      await api('/keys/rewrap', 'POST', {
        encPriv: makeEncPrivBlob(myKeys.secretKey, newPassword),
      });
    } catch {}
  }

  async function getPeerKey(userId, api) {
    if (userId in peerKeys) return peerKeys[userId];
    try {
      const res = await api('/keys/' + userId);
      peerKeys[userId] = res?.publicKey ? b64.dec(res.publicKey) : null;
    } catch { peerKeys[userId] = null; }
    return peerKeys[userId];
  }

  // The Diffie-Hellman step in nacl.box dominates the cost of every call.
  // Compute it once per peer (box.before) and reuse the shared key so
  // encrypting/decrypting a long DM history doesn't freeze the page.
  //
  // Once per PEER, not once in total. This used to hold a single entry, so
  // opening a different chat threw it away — and switching back and forth
  // between two conversations redid the most expensive operation in the file
  // on every switch, which is a large part of what "it decrypts again every
  // time I open a chat" felt like.
  const SHARED_MAX = 20;
  const sharedCache = new Map();   // peer public key (base64) -> shared key
  let sharedFor = null;            // whose secret key those were derived with
  function sharedKey(peerPk, tag) {
    tag = tag || b64.enc(peerPk);
    if (sharedFor !== myKeys.secretKey) { sharedCache.clear(); sharedFor = myKeys.secretKey; }
    let key = sharedCache.get(tag);
    if (!key) {
      key = nacl.box.before(peerPk, myKeys.secretKey);
      sharedCache.set(tag, key);
      while (sharedCache.size > SHARED_MAX) sharedCache.delete(sharedCache.keys().next().value);
    }
    return key;
  }

  // ── Decrypting the same message over and over ──────────────────────────────
  //
  // Reported as: every time a chat is opened, it decrypts everything again.
  //
  // It did, and worse: decryption ran while rendering, so re-rendering the
  // list — a new message, a reaction, a read receipt — decrypted the visible
  // history again too. tweetnacl is pure JavaScript on the same thread that
  // draws the page, so all of it is felt.
  //
  // A message's plaintext cannot change, so decrypt it once and remember it.
  // Keyed by peer AND ciphertext, so a message can never be handed plaintext
  // that was produced under a different identity. Bounded, or a long chat
  // would hold every message it has ever shown.
  const PLAIN_CACHE_MAX = 3000;
  const plainCache = new Map();
  function rememberPlain(key, value) {
    plainCache.set(key, value);
    // Map iterates in insertion order, so the front is the oldest.
    while (plainCache.size > PLAIN_CACHE_MAX) plainCache.delete(plainCache.keys().next().value);
    return value;
  }
  /** Plaintext must not outlive the keys that produced it. */
  function forgetPlaintext() { plainCache.clear(); }

  function encrypt(text, peerPk) {
    if (!myKeys || !peerPk) return null;
    const nonce = nacl.randomBytes(24);
    const ct = nacl.box.after(new TextEncoder().encode(text), nonce, sharedKey(peerPk));
    const packed = new Uint8Array(24 + ct.length);
    packed.set(nonce, 0); packed.set(ct, 24);
    return 'e2e:' + b64.enc(packed);
  }

  function decrypt(content, peerPk) {
    if (!content || !content.startsWith('e2e:')) return content;
    // Not a failed decryption — one that has not been attempted, because the
    // keys are not loaded yet. Deliberately NOT remembered: caching it would
    // leave a perfectly readable message showing the padlock for the rest of
    // the session, moments after the keys arrived.
    if (!myKeys || !peerPk) return null;
    const tag = b64.enc(peerPk);
    const cacheKey = tag + '|' + content;
    const hit = plainCache.get(cacheKey);
    // `undefined` is "not tried"; a stored null is "tried, and failed" — which
    // with these keys it will fail again, so that is worth remembering too.
    if (hit !== undefined) return hit;
    try {
      const packed = b64.dec(content.slice(4));
      const opened = nacl.box.open.after(packed.subarray(24), packed.subarray(0, 24), sharedKey(peerPk, tag));
      return rememberPlain(cacheKey, opened ? new TextDecoder().decode(opened) : null);
    } catch { return rememberPlain(cacheKey, null); }
  }

  const isEncrypted = (content) => !!content && String(content).startsWith('e2e:');
  const clear = () => {
    myKeys = null;
    sharedCache.clear();
    sharedFor = null;
    forgetPlaintext();
    localStorage.removeItem('e2e_pk');
    localStorage.removeItem('e2e_sk');
  };
  const ready = () => !!myKeys || loadLocal();

  return {
    setup, rewrap, getPeerKey, encrypt, decrypt, isEncrypted, clear, ready,
    forgetPlaintext, decodeKey: b64.dec,
    /** Tests only; see test/webE2eCache.test.js. */
    _setKeysForTest(keys) { myKeys = keys; sharedCache.clear(); sharedFor = null; },
  };
})();

// `const` does not land on window, and the scripts loaded beside this one read
// it from there. Without this line encrypted search throws the moment it tries
// to decrypt anything.
window.E2E = E2E;
