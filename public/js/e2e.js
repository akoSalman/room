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

  // ── Unlock the identity, and SAY WHICH THING FAILED ───────────────────────
  //
  // Reported: on the web, after a long time away, login is accepted but
  // opening a chat asks for the account password and never takes it — the
  // same prompt, over and over.
  //
  // This returned a bare true/false, and the caller turned every false into
  // "Could not unlock encryption with that password." At least five different
  // things produce that false and only ONE of them is about the password:
  //
  //   • the blob does not open with it            — the password really is wrong
  //   • /keys/me could not be reached             — the password was never tried
  //   • /keys/me answered with an error body      — likewise, and api() does not
  //                                                 throw on a non-2xx, it hands
  //                                                 back the parsed error, whose
  //                                                 missing encPriv then looked
  //                                                 like "no identity yet"
  //   • a public key with no private blob         — unlockable by nobody
  //   • the server refused a replacement keypair  — 409, password never tried
  //
  // The last four cannot be fixed by typing a password, so telling somebody to
  // try again is sending them round a loop that has no exit. The reason now
  // comes back with the answer.
  //
  // Returns { ok, reason }. An object, so a caller that forgets `.ok` fails
  // loudly on the next line rather than silently treating every outcome as
  // success — a bare string would have been truthy for every failure.
  async function setup(password, api) {
    let mine;
    try {
      mine = await api('/keys/me');
    } catch (e) {
      // The request itself did not complete. Local keys, if the browser still
      // has them, are a perfectly good answer — but say that is what happened.
      return { ok: loadLocal(), reason: ready() ? 'local' : 'offline' };
    }
    // api() returns res.json() and throws only on a malformed body, so an
    // error RESPONSE arrives here as an ordinary object. Without this, a 500
    // from /keys/me has no encPriv, falls through to the branch below, and
    // publishes a brand-new keypair — which the server then refuses 409. A
    // server fault presented as a password problem.
    if (!mine || mine.error) {
      return { ok: loadLocal(), reason: ready() ? 'local' : 'server-error' };
    }
    if (mine.encPriv) {
      // Identity exists — unlock only. Never publish a replacement keypair,
      // or peers' messages (encrypted to the original key) become unreadable.
      let sk = null;
      try {
        const key = deriveKey(password, b64.dec(mine.encPriv.salt));
        sk = nacl.secretbox.open(b64.dec(mine.encPriv.ct), b64.dec(mine.encPriv.nonce), key);
      } catch (e) {
        // A blob that is not base64, or is missing a field. Not the password.
        return { ok: false, reason: 'bad-blob' };
      }
      if (sk) {
        storeLocal({ publicKey: b64.dec(mine.publicKey), secretKey: new Uint8Array(sk) });
        return { ok: true, reason: 'unlocked' };
      }
      return { ok: false, reason: 'wrong-password' };
    }
    if (mine.publicKey) {
      // A published key with nothing behind it. Creating a new identity below
      // would be refused (the public key is write-once), so this would loop
      // for ever asking for a password it never checks.
      return { ok: false, reason: 'no-blob' };
    }
    // ── AN IDENTITY IS NEVER SEALED WITH AN UNVERIFIED PASSWORD ────────────
    //
    // This is how an account ends up permanently locked out, and it is
    // reachable today: the unlock prompt calls this same function, and its
    // own comment says "unlock (or create)". So somebody with no identity
    // yet opens a DM, is asked for "your account password", types something
    // that is not it — an old one, a typo, another site's — and an identity
    // is created SEALED WITH THAT STRING. From then on the real account
    // password never opens it, and no message ever says why.
    //
    // The server is asked first. It costs one request, once per account,
    // because this branch runs only when no identity exists; and it makes
    // the rule unconditional rather than depending on which screen called.
    try {
      const v = await api('/password/verify', 'POST', { password });
      if (!v || v.ok !== true) return { ok: false, reason: 'password-typo' };
    } catch (e) {
      // Unverified means not created. A key sealed with the wrong password
      // cannot be undone; waiting for a working connection can.
      return { ok: false, reason: 'offline' };
    }
    try {
      const keys = nacl.box.keyPair();
      const r = await api('/keys', 'POST', {
        publicKey: b64.enc(keys.publicKey),
        encPriv: makeEncPrivBlob(keys.secretKey, password),
      });
      if (r?.error === 'public_key_exists') return { ok: false, reason: 'key-exists' };
      if (r?.error) return { ok: false, reason: 'create-failed' };
      storeLocal(keys);
      return { ok: true, reason: 'created' };
    } catch (e) {
      return { ok: false, reason: 'offline' };
    }
  }

  /**
   * Throw the old identity away and publish a new one. DESTRUCTIVE.
   *
   * Only for the case the server has confirmed: the account password is
   * correct and the stored key is sealed with a different one, so nothing
   * anybody types will ever open it.
   *
   * WHAT IS LOST. Every message in every encrypted DM was sealed to the old
   * key pair, in both directions. Replacing it does not re-encrypt them —
   * they become permanently unreadable on every device this account uses.
   * Peers keep their own copies; this account does not.
   *
   * The caller must have asked, plainly and twice. This function does not
   * confirm anything; it carries out a decision already made.
   */
  async function resetIdentity(password, api) {
    const keys = nacl.box.keyPair();
    let r;
    try {
      r = await api('/keys', 'POST', {
        publicKey: b64.enc(keys.publicKey),
        encPriv: makeEncPrivBlob(keys.secretKey, password),
        force: true,
        // The server re-checks this itself; a token alone must not be enough
        // to destroy an account's history.
        currentPassword: password,
      });
    } catch (e) {
      return { ok: false, reason: 'offline' };
    }
    if (r?.error === 'password_required') return { ok: false, reason: 'password-typo' };
    if (r?.error) return { ok: false, reason: 'reset-failed' };
    // Only once the server has accepted it: storing first would leave this
    // device holding a key the server has never heard of.
    storeLocal(keys);
    return { ok: true, reason: 'reset' };
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
    setup, rewrap, resetIdentity, getPeerKey, encrypt, decrypt, isEncrypted, clear, ready,
    forgetPlaintext, decodeKey: b64.dec,
    /** Tests only; see test/webE2eCache.test.js. */
    _setKeysForTest(keys) { myKeys = keys; sharedCache.clear(); sharedFor = null; },
  };
})();

// `const` does not land on window, and the scripts loaded beside this one read
// it from there. Without this line encrypted search throws the moment it tries
// to decrypt anything.
window.E2E = E2E;
