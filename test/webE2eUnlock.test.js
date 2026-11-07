// Unlocking E2E on the web, and saying which thing failed
// (public/js/e2e.js, public/js/app.js, server.js).
//
// Reported: on the web version, after a long time away, login is accepted but
// opening a chat asks for the account password — and the password is never
// accepted, so the same prompt comes back again and again.
//
// WHAT THE CODE DID. E2E.setup returned a bare true/false, and the caller
// turned every false into "Could not unlock encryption with that password.
// Please try again." Five different things produce that false:
//
//   wrong-password  the blob genuinely does not open with it
//   offline         /keys/me never completed — the password was NOT checked
//   server-error    /keys/me answered with an error body — likewise
//   no-blob         a public key with no private blob: no password can work
//   key-exists      the server refused a replacement keypair, 409
//
// Only the first is about the password. For the other four the message was
// untrue, and the retry it invited could not ever succeed — and the caller
// then cleared e2eUnlockAsked, so the next chat asked again. That is the
// loop.
//
// server-error deserves its own note, because it is the one that hides: the
// web api() helper returns res.json() and does NOT throw on a non-2xx. A 500
// from /keys/me therefore arrived as an ordinary object with no encPriv,
// which read as "this account has no identity yet" — so the client published
// a brand-new keypair, the server refused it 409 because public keys are
// write-once, and a server fault was presented as a wrong password.
//
// WHAT WAS RULED OUT FIRST, by measuring rather than reading:
//   • every one of the 17 accounts has both a public key and a well-formed
//     blob, so the no-blob dead end is not what anybody is in;
//   • the web and native KDFs produce identical keys, checked by running
//     both, including on Persian text — so a blob written by the phone does
//     open on the web;
//   • neither client has a password-change screen, so the uncalled rewrap()
//     cannot have stranded these accounts either.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const e2eSrc = fs.readFileSync(path.join(ROOT, 'public', 'js', 'e2e.js'), 'utf8');
const appSrc = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');
const srvSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

// This file explains the bug at length; a regex that reads its own prose
// proves nothing.
const code = src => src
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/^\s*\/\/.*$/gm, ' ');
const e2eCode = code(e2eSrc);
const appCode = code(appSrc);
const srvCode = code(srvSrc);

const tests = [];
const test = (n, f) => tests.push({ n, f });

// ── setup() RUN FOR REAL ────────────────────────────────────────────────────
//
// Loaded in a sandbox with a stub nacl and localStorage, so every branch can
// be driven with a fake /keys/me instead of asserted about by regex.
function loadE2E() {
  const vm = require('vm');
  const store = new Map();
  // A stand-in for TweetNaCl: enough shape for setup() to run. secretbox.open
  // succeeds only when the derived key matches the one that sealed it, which
  // is the single property these tests turn on.
  const nacl = {
    hash: (u8) => {
      // Any deterministic 64-byte digest of the input will do here.
      const out = new Uint8Array(64);
      let a = 7;
      for (let i = 0; i < u8.length; i++) a = (a * 31 + u8[i]) >>> 0;
      for (let i = 0; i < 64; i++) { a = (a * 1103515245 + 12345) >>> 0; out[i] = a & 0xff; }
      return out;
    },
    randomBytes: (n) => new Uint8Array(n).map((_, i) => (i * 7 + 3) & 0xff),
    secretbox: Object.assign(
      (msg, nonce, key) => {
        const out = new Uint8Array(msg.length + 1);
        out[0] = key[0]; out.set(msg, 1);        // remember which key sealed it
        return out;
      },
      { open: (ct, nonce, key) => (ct[0] === key[0] ? ct.slice(1) : null) },
    ),
    box: { keyPair: () => ({ publicKey: new Uint8Array(32).fill(9), secretKey: new Uint8Array(32).fill(8) }) },
  };
  const ctx = {
    nacl,
    TextEncoder,
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    console: { warn() {}, log() {} },
    localStorage: {
      getItem: k => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: k => store.delete(k),
    },
    window: {},
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(e2eSrc, ctx);
  return { E2E: ctx.window.E2E || ctx.E2E, store };
}

test('a blob that opens gives ok with reason "unlocked"', async () => {
  const { E2E } = loadE2E();
  // Seal with the same password the caller will give.
  const api = async (p) => {
    if (p === '/keys/me') {
      return { publicKey: 'AAAA', encPriv: sealFor('right') };
    }
    throw new Error('unexpected ' + p);
  };
  const r = await E2E.setup('right', api);
  assert.strictEqual(r.ok, true, `expected ok, got ${JSON.stringify(r)}`);
  assert.strictEqual(r.reason, 'unlocked');
});

test('THE ONE REASON THAT IS ABOUT THE PASSWORD', async () => {
  const { E2E } = loadE2E();
  const api = async () => ({ publicKey: 'AAAA', encPriv: sealFor('right') });
  const r = await E2E.setup('wrong', api);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'wrong-password',
    'the only failure a person can fix by typing must say so');
});

test('A SERVER ERROR IS NOT A WRONG PASSWORD', async () => {
  // The one that hid. api() returns res.json() and does not throw on a
  // non-2xx, so a 500 arrived as an object with no encPriv — which read as
  // "no identity yet", published a new keypair, and got a 409 back. A server
  // fault, reported to the user as their password being wrong.
  const { E2E } = loadE2E();
  let posted = false;
  const api = async (p, m) => {
    if (m === 'POST') { posted = true; return { ok: true }; }
    return { error: 'Server error' };
  };
  const r = await E2E.setup('right', api);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'server-error');
  assert.strictEqual(posted, false,
    'an error response still published a replacement keypair');
});

test('a request that never completes says so, and does not blame the password', async () => {
  const { E2E } = loadE2E();
  const api = async () => { throw new Error('network down'); };
  const r = await E2E.setup('right', api);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'offline');
});

test('local keys are an answer, and are reported as such', async () => {
  // A browser that still holds the keys needs no server at all. That is a
  // success, but not an unlock, and the two should not be confused.
  const { E2E, store } = loadE2E();
  store.set('e2e_pk', Buffer.from(new Uint8Array(32).fill(1)).toString('base64'));
  store.set('e2e_sk', Buffer.from(new Uint8Array(32).fill(2)).toString('base64'));
  const r = await E2E.setup('anything', async () => { throw new Error('offline'); });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.reason, 'local');
});

test('A PUBLIC KEY WITH NO BLOB IS NAMED, not retried for ever', async () => {
  // Measured as zero accounts today, and defended anyway: it is the state in
  // which NO password can work, because setup would try to create a new
  // identity and the server refuses that 409 — for ever, without once
  // checking what was typed.
  const { E2E } = loadE2E();
  let posted = false;
  const api = async (p, m) => {
    if (m === 'POST') { posted = true; return { error: 'public_key_exists' }; }
    return { publicKey: 'AAAA', encPriv: null };
  };
  const r = await E2E.setup('anything', api);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'no-blob');
  assert.strictEqual(posted, false,
    'it still tried to publish a replacement key the server cannot accept');
});

test('a brand-new account still creates an identity', async () => {
  const { E2E } = loadE2E();
  let body = null;
  const api = async (p, m, b) => {
    if (p === '/password/verify') return { ok: true };
    if (m === 'POST') { body = b; return { ok: true }; }
    return { publicKey: null, encPriv: null };
  };
  const r = await E2E.setup('newpw', api);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.reason, 'created');
  assert.ok(body && body.publicKey && body.encPriv, 'nothing was published');
});

test('a refused keypair is reported as that, not as a password', async () => {
  const { E2E } = loadE2E();
  const api = async (p, m) => {
    if (p === '/password/verify') return { ok: true };
    return m === 'POST' ? { error: 'public_key_exists' } : { publicKey: null, encPriv: null };
  };
  const r = await E2E.setup('pw', api);
  // Field by field, not deepStrictEqual: the object is built inside the VM
  // context, so its prototype is that realm's Object and a deep-strict
  // compare fails on identity while reporting "same structure".
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'key-exists');
});

test('a damaged blob is not a wrong password either', async () => {
  const { E2E } = loadE2E();
  const api = async () => ({ publicKey: 'AAAA', encPriv: { salt: '!!not base64!!' } });
  const r = await E2E.setup('pw', api);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'bad-blob');
});

/** A blob the stub secretbox will open only for this password. */
function sealFor(password) {
  // deriveKey's first byte is what the stub compares, and it is a pure
  // function of (salt, password) — so sealing with the same salt and password
  // the code will derive from is enough.
  const { E2E } = sealFor._e2e || (sealFor._e2e = loadE2E());
  return sealFor._make(password);
}

// ── THE MESSAGES, AND WHETHER A RETRY CAN HELP ──────────────────────────────

test('EVERY REASON HAS A MESSAGE, and only the fixable ones invite a retry', () => {
  const m = /const E2E_FAILURES = \{([\s\S]*?)\n\};/.exec(appCode);
  assert.ok(m, 'the failure table is gone');
  const table = m[1];
  // Every reason setup can return must appear, or it falls through to a
  // generic message and the loop returns.
  for (const reason of ['wrong-password', 'offline', 'server-error',
                        'no-blob', 'bad-blob', 'key-exists', 'create-failed']) {
    assert.ok(table.includes(`'${reason}'`), `no message for ${reason}`);
  }
  // The four that no password can fix must NOT re-arm the prompt.
  for (const reason of ['no-blob', 'bad-blob', 'key-exists']) {
    const entry = table.slice(table.indexOf(`'${reason}'`));
    const body = entry.slice(0, entry.indexOf('},'));
    assert.match(body, /retry:\s*false/,
      `${reason} invites a retry that cannot possibly work`);
  }
  // …and the ones that can must.
  for (const reason of ['wrong-password', 'offline', 'server-error']) {
    const entry = table.slice(table.indexOf(`'${reason}'`));
    const body = entry.slice(0, entry.indexOf('},'));
    assert.match(body, /retry:\s*true/, `${reason} should allow another attempt`);
  }
});

test('ONLY the password failure mentions the password', () => {
  // The whole complaint: being told the password is wrong when it was never
  // tried is what kept somebody typing it in again.
  const m = /const E2E_FAILURES = \{([\s\S]*?)\n\};/.exec(appCode);
  const table = m[1];
  for (const reason of ['offline', 'server-error']) {
    const entry = table.slice(table.indexOf(`'${reason}'`));
    const body = entry.slice(0, entry.indexOf('},'));
    assert.match(body, /not checked/i,
      `${reason} should say the password was not checked`);
  }
  const wrong = table.slice(table.indexOf("'wrong-password'"));
  const wbody = wrong.slice(0, wrong.indexOf('},'));
  // And it points at the thing that actually explains it: a key wrapped with
  // a password the account no longer uses.
  assert.match(wbody, /OLD/,
    'the wrong-password message should suggest the previous password');
});

test('the prompt is NOT re-armed for a hopeless reason', () => {
  const fn = appCode.slice(appCode.indexOf('async function ensureE2EUnlocked'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /if \(!f \|\| f\.retry\) e2eUnlockAsked = false;/,
    'every failure still re-arms the prompt, which is the reported loop');
  assert.doesNotMatch(body, /Could not unlock encryption with that password\. Please try again\./,
    'the old one-size-fits-all message is still there');
});

test('login no longer throws the answer away', () => {
  // The prompt should never appear for someone who just signed in: setup runs
  // at login with the password in hand. That it appears at all means the
  // login-time attempt already failed — silently, into .catch(() => {}).
  assert.doesNotMatch(appCode, /E2E\.setup\(pass, api\)\.catch\(\(\) => \{\}\)/,
    'the login-time failure is still discarded');
  const at = appCode.indexOf('E2E.setup(pass, api)');
  assert.ok(at > 0);
  const after = appCode.slice(at, at + 400);
  assert.match(after, /reportE2E\('login-'/,
    'a login-time failure should reach the server log');
});

// ── WHAT THE SERVER RECORDS ─────────────────────────────────────────────────

test('the reason reaches the server log', () => {
  assert.match(srvCode, /\[e2e\] user=/, 'server.js does not log the e2e reason');
  const h = srvCode.slice(srvCode.indexOf("String(d.what) === 'e2e'"));
  const line = h.slice(0, h.indexOf('return;'));
  assert.match(line, /word\(d\.reason\)/, 'the reason is logged unsanitised');
});

test('the channel name is compared exactly, because word() eats the digit', () => {
  // word() keeps letters and hyphens only, so word('e2e') is 'ee'. Matching
  // on word(d.what) would never fire — the branch would be dead and the
  // symptom would be silence, which is indistinguishable from "nobody hit it".
  const word = v => String(v || 'unknown').replace(/[^a-z-]/gi, '').slice(0, 20) || 'unknown';
  assert.strictEqual(word('e2e'), 'ee');
  const h = srvCode.slice(srvCode.indexOf("=== 'e2e'") - 40, srvCode.indexOf("=== 'e2e'") + 10);
  assert.match(h, /String\(d\.what\)/,
    'the channel must be compared with String(), not word()');
});

test('the [e2e] line carries no username, password or key', () => {
  // These logs are read into a repository that has been public, and this one
  // is about an encryption key.
  const h = srvCode.slice(srvCode.indexOf("String(d.what) === 'e2e'"));
  const line = h.slice(0, h.indexOf('return;'));
  for (const bad of [/username/, /password/i, /encPriv/, /publicKey/, /salt/, /\bkey\b/]) {
    assert.doesNotMatch(line, bad, `the e2e log line contains ${bad}`);
  }
  const word = v => String(v || 'unknown').replace(/[^a-z-]/gi, '').slice(0, 20) || 'unknown';
  // Every reason survives word() intact, or the log cannot be read back to a
  // rule — which is the only reason it exists.
  for (const r of ['unlocked', 'created', 'local', 'wrong-password', 'offline',
                   'server-error', 'no-blob', 'bad-blob', 'key-exists',
                   'create-failed', 'login-wrong-password', 'login-offline']) {
    assert.strictEqual(word(r), r, `reason "${r}" is mangled to "${word(r)}"`);
  }
});

test('AN IDENTITY IS NEVER SEALED WITH AN UNVERIFIED PASSWORD', async () => {
  // How an account becomes permanently unreadable, and it is reachable
  // today: the unlock prompt calls this same setup(), whose own comment says
  // "unlock (or create)". Somebody with no identity opens a DM, is asked for
  // "your account password", types something that is not it, and an identity
  // is CREATED SEALED WITH THAT STRING. The real password never opens it
  // afterwards and nothing ever says why.
  const { E2E } = loadE2E();
  let posted = false;
  const api = async (p, m, b) => {
    if (p === '/password/verify') return { ok: false };     // not the account password
    if (m === 'POST') { posted = true; return { ok: true }; }
    return { publicKey: null, encPriv: null };              // no identity yet
  };
  const r = await E2E.setup('a-typo', api);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'password-typo');
  assert.strictEqual(posted, false,
    'an identity was published sealed with a password the server rejected');
});

test('…and an unreachable server creates nothing either', async () => {
  // Unverified means not created. A key sealed with the wrong password
  // cannot be undone; waiting for a connection can.
  const { E2E } = loadE2E();
  let posted = false;
  const api = async (p, m) => {
    if (p === '/password/verify') throw new Error('network down');
    if (m === 'POST') { posted = true; return { ok: true }; }
    return { publicKey: null, encPriv: null };
  };
  const r = await E2E.setup('pw', api);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'offline');
  assert.strictEqual(posted, false, 'it published a key it could not verify');
});

test('the native client has the same guard', () => {
  // Most people are on the phone, so the hole that creates these accounts
  // matters more there than on the web.
  const nat = code(fs.readFileSync(
    path.join(ROOT, 'native-app', 'src', 'e2e.ts'), 'utf8'));
  const fn = nat.slice(nat.indexOf('export async function e2eSetup'));
  const body = fn.slice(0, fn.indexOf('\nexport '));
  assert.match(body, /\/password\/verify/,
    'the native app can still seal an identity with an unverified password');
  const verify = body.indexOf('/password/verify');
  const post = body.indexOf("apiFetch('/keys', 'POST'");
  assert.ok(verify > 0 && post > verify,
    'the native app publishes the key before verifying the password');
});

// ── TELLING A TYPO FROM A KEY THAT WILL NEVER OPEN ─────────────────────────

test('a confirmed-correct password turns wrong-password into stale-key', () => {
  // The log said reason=wrong-password twice, which has two causes that look
  // identical and need opposite advice: a typo (try again) and a key sealed
  // with a different password (trying again is futile). Only the server can
  // tell them apart, because only the server holds the hash.
  const fn = appCode.slice(appCode.indexOf('async function ensureE2EUnlocked'));
  const body = fn.slice(0, fn.indexOf('\nfunction '));
  assert.match(body, /\/password\/verify/, 'the password is never verified');
  assert.match(body, /v\.ok === true\)\s*reason = 'stale-key'/,
    'a confirmed password should stop being reported as the wrong one');
  assert.match(body, /v\.ok === false\)\s*reason = 'password-typo'/);
  // Only after an unlock has already failed, so the ordinary case costs
  // nothing and no password is sent when it was not needed.
  assert.ok(body.indexOf('E2E.setup(') < body.indexOf('/password/verify'),
    'the password is sent to the server before the key is even tried');
  // If the check itself fails we must not invent an answer.
  assert.match(body, /catch \{[^}]*\}/, 'a failed verify is not tolerated');
});

test('stale-key does not blame the password, and password-typo does', () => {
  const m = /const E2E_FAILURES = \{([\s\S]*?)\n\};/.exec(appCode);
  const table = m[1];
  const stale = table.slice(table.indexOf("'stale-key'"));
  const sbody = stale.slice(0, stale.indexOf('},'));
  assert.match(sbody, /retry:\s*false/, 'a key that cannot open invites a retry');
  assert.match(sbody, /IS your account password/,
    'it should say plainly that the password was right');
  assert.match(sbody, /offerReset:\s*true/, 'there is no way out offered');
  const typo = table.slice(table.indexOf("'password-typo'"));
  const tbody = typo.slice(0, typo.indexOf('},'));
  assert.match(tbody, /retry:\s*true/);
  // The autofill trap: the sign-in form filled by the browser, the prompt
  // typed by hand.
  assert.match(tbody, /browser/i);
});

// ── THE RESET, WHICH DESTROYS THINGS ───────────────────────────────────────

test('the reset is offered ONLY when nothing else can work', () => {
  const m = /const E2E_FAILURES = \{([\s\S]*?)\n\};/.exec(appCode);
  // Exactly one reason may offer it: the one the server has confirmed.
  const offers = (m[1].match(/offerReset:\s*true/g) || []).length;
  assert.strictEqual(offers, 1, `${offers} reasons offer a destructive reset`);
  const stale = m[1].slice(m[1].indexOf("'stale-key'"));
  assert.match(stale.slice(0, stale.indexOf('},')), /offerReset:\s*true/,
    'the one that offers it is not the confirmed-stale one');
});

test('IT ASKS TWICE, and the second cannot be dismissed by reflex', () => {
  // It cannot be undone and what it destroys is somebody's conversations.
  const fn = appCode.slice(appCode.indexOf('async function offerIdentityReset'));
  const body = fn.slice(0, fn.indexOf('\nfunction '));
  assert.match(body, /confirm\(/, 'no confirmation at all');
  assert.match(body, /RESET/, 'the second step does not ask for a typed word');
  assert.ok(body.indexOf('confirm(') < body.indexOf("prompt('To confirm"),
    'the typed confirmation comes before the explanation');
  // The warning must say what is lost, in those words.
  assert.match(body, /never be readable again/i,
    'the warning does not say the old messages are lost for good');
  assert.match(body, /cannot be undone/i);
  // And nothing happens unless the word matches.
  assert.match(body, /!==\s*'RESET'\)\s*return;/);
});

test('A STOLEN TOKEN CANNOT DESTROY AN IDENTITY', () => {
  // force replaces the published key and discards the old one, making every
  // message a peer ever encrypted to it unreadable for good. It was reachable
  // with a valid token and nothing else, and no client had ever sent it —
  // making it reachable from a button is what makes that matter.
  const h = srvCode.slice(srvCode.indexOf("app.post('/keys', authMiddleware"));
  const body = h.slice(0, h.indexOf('\napp.'));
  assert.match(body, /if \(force && existing\?\.public_key\)/,
    'a forced reset is not gated at all');
  assert.match(body, /bcrypt\.compare\(String\(currentPassword/,
    'the password is not checked on a forced reset');
  assert.match(body, /password_required/);
  assert.match(body, /authRateLimited\('reset\|/,
    'a forced reset is not rate-limited');
  // Checked here, not taken from the client's own verify call, which proves
  // nothing to this endpoint.
  assert.doesNotMatch(body, /verified|trustClient/i);
});

test('the reset publishes before it stores, never the other way round', () => {
  // Storing first would leave the device holding a key the server has never
  // heard of — unreadable to every peer, and no way back.
  const c = code(e2eSrc);
  const fn = c.slice(c.indexOf('async function resetIdentity'));
  const body = fn.slice(0, fn.indexOf('\n  }') + 4);
  const post = body.indexOf("api('/keys', 'POST'");
  const store = body.indexOf('storeLocal(keys)');
  assert.ok(post > 0 && store > post,
    'the new key is stored locally before the server has accepted it');
  // A refusal must leave this device exactly as it was.
  assert.match(body, /if \(r\?\.error\) return \{ ok: false/);
});

test('the password-verify endpoint gives away nothing but yes or no', () => {
  const h = srvCode.slice(srvCode.indexOf("app.post('/password/verify'"));
  const body = h.slice(0, h.indexOf('\napp.'));
  assert.match(body, /authRateLimited\('verify\|/,
    'a password oracle with no rate limit');
  assert.match(body, /res\.json\(\{ ok \}\)/,
    'it returns more than the verdict');
  // No hint about length, shape, or how close the guess was.
  assert.doesNotMatch(body, /length|hint|close|partial/i);
});

// Build a sealing helper against the loaded module's own deriveKey, by
// observing what it produces for a known password.
sealFor._make = (password) => {
  // deriveKey is private, so the blob is built the way makeEncPrivBlob does:
  // the stub secretbox records key[0], and the stub hash is deterministic, so
  // re-deriving here with the same salt gives the same first byte.
  const salt = new Uint8Array(16).map((_, i) => (i * 7 + 3) & 0xff);
  const te = new TextEncoder();
  const hash = (u8) => {
    const out = new Uint8Array(64);
    let a = 7;
    for (let i = 0; i < u8.length; i++) a = (a * 31 + u8[i]) >>> 0;
    for (let i = 0; i < 64; i++) { a = (a * 1103515245 + 12345) >>> 0; out[i] = a & 0xff; }
    return out;
  };
  const pw = te.encode(password);
  const h = new Uint8Array(salt.length + pw.length);
  h.set(salt, 0); h.set(pw, salt.length);
  let digest = hash(h);
  for (let i = 0; i < 10000; i++) digest = hash(digest);
  const keyByte = digest[0];
  const ct = new Uint8Array(33);
  ct[0] = keyByte;
  const b64 = u => Buffer.from(u).toString('base64');
  return { salt: b64(salt), nonce: b64(new Uint8Array(24)), ct: b64(ct) };
};

(async () => {
  let failed = 0;
  for (const { n, f } of tests) {
    try { await f(); console.log(`  ok  ${n}`); }
    catch (e) { failed++; console.log(`  FAIL ${n}\n       ${e.message}`); }
  }
  if (failed) { console.log(`\n  ${failed} web-e2e-unlock test(s) failed`); process.exit(1); }
  console.log(`  ${tests.length} web-e2e-unlock tests passed`);
})();
