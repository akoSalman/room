// ── End-to-end encryption (DMs) ────────────────────────────────────────────────
// Mirrors public/js/e2e.js exactly (same KDF, same envelope format) so blobs
// and messages are interchangeable between web and mobile.
import 'react-native-get-random-values';
import nacl from 'tweetnacl';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { apiFetch } from './api';

// Pure-JS base64 (Hermes has no btoa/atob).
const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function b64enc(u8: Uint8Array): string {
  let out = '';
  for (let i = 0; i < u8.length; i += 3) {
    const b0 = u8[i], b1 = i + 1 < u8.length ? u8[i + 1] : 0, b2 = i + 2 < u8.length ? u8[i + 2] : 0;
    out += B64_CHARS[b0 >> 2] + B64_CHARS[((b0 & 3) << 4) | (b1 >> 4)];
    out += i + 1 < u8.length ? B64_CHARS[((b1 & 15) << 2) | (b2 >> 6)] : '=';
    out += i + 2 < u8.length ? B64_CHARS[b2 & 63] : '=';
  }
  return out;
}
function b64dec(str: string): Uint8Array {
  const clean = str.replace(/=+$/, '');
  const out = new Uint8Array(Math.floor(clean.length * 3 / 4));
  let o = 0, buf = 0, bits = 0;
  for (let i = 0; i < clean.length; i++) {
    buf = (buf << 6) | B64_CHARS.indexOf(clean[i]);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (buf >> bits) & 0xff;
    }
  }
  return out;
}

const te = { encode: (s: string) => Uint8Array.from(unescape(encodeURIComponent(s)), c => c.charCodeAt(0)) };
const td = { decode: (u8: Uint8Array) => decodeURIComponent(escape(String.fromCharCode(...u8))) };

// Password → 32-byte key: salted, iterated SHA-512 (identical to the web KDF).
function deriveKey(password: string, salt: Uint8Array): Uint8Array {
  const pw = te.encode(password);
  const input = new Uint8Array(salt.length + pw.length);
  input.set(salt, 0); input.set(pw, salt.length);
  let digest = nacl.hash(input);
  for (let i = 0; i < 10000; i++) digest = nacl.hash(digest);
  return digest.subarray(0, 32);
}

let myKeys: nacl.BoxKeyPair | null = null;
const peerKeys: Record<string, Uint8Array | null> = {};

async function loadLocal(): Promise<boolean> {
  if (myKeys) return true;
  const [pk, sk] = await Promise.all([AsyncStorage.getItem('e2e_pk'), AsyncStorage.getItem('e2e_sk')]);
  if (pk && sk) myKeys = { publicKey: b64dec(pk), secretKey: b64dec(sk) };
  return !!myKeys;
}

async function storeLocal(keys: nacl.BoxKeyPair) {
  myKeys = keys;
  await AsyncStorage.setItem('e2e_pk', b64enc(keys.publicKey));
  await AsyncStorage.setItem('e2e_sk', b64enc(keys.secretKey));
}

function makeEncPrivBlob(secretKey: Uint8Array, password: string) {
  const salt = nacl.randomBytes(16);
  const key = deriveKey(password, salt);
  const nonce = nacl.randomBytes(24);
  const ct = nacl.secretbox(secretKey, nonce, key);
  return { salt: b64enc(salt), nonce: b64enc(nonce), ct: b64enc(ct) };
}

export async function e2eSetup(password: string): Promise<boolean> {
  try {
    const mine = await apiFetch('/keys/me');
    if (mine?.encPriv) {
      // An identity already exists — the ONLY correct action is to unlock it
      // with the password. Never generate a replacement keypair here, or the
      // published public key would diverge from what peers encrypt to.
      const key = deriveKey(password, b64dec(mine.encPriv.salt));
      const sk = nacl.secretbox.open(b64dec(mine.encPriv.ct), b64dec(mine.encPriv.nonce), key);
      if (sk) {
        await storeLocal({ publicKey: b64dec(mine.publicKey), secretKey: new Uint8Array(sk) });
        return true;
      }
      return false; // wrong password — stay locked, do NOT overwrite keys
    }
    // First-ever identity for this account.
    const keys = nacl.box.keyPair();
    const r = await apiFetch('/keys', 'POST', {
      publicKey: b64enc(keys.publicKey),
      encPriv: makeEncPrivBlob(keys.secretKey, password),
    });
    if (r?.error === 'public_key_exists') return false; // raced with another device
    await storeLocal(keys);
    return true;
  } catch {
    return loadLocal();
  }
}

export async function e2eRewrap(newPassword: string) {
  if (!(await loadLocal()) || !myKeys) return;
  try {
    // Re-wrap only: keep the same public key, just re-encrypt the private blob.
    await apiFetch('/keys/rewrap', 'POST', {
      encPriv: makeEncPrivBlob(myKeys.secretKey, newPassword),
    });
  } catch {}
}

export async function e2eReady(): Promise<boolean> {
  return loadLocal();
}

// Guards against a divergent identity: if the public key we hold locally does
// NOT match the one published on the server for this account, then peers (e.g.
// the web client) are encrypting to a key whose private half we don't have, so
// every incoming message fails to decrypt. In that case we wipe the stale local
// identity and report it, so the app can prompt for the password and rebuild
// the correct keypair from the server's encrypted-private blob via e2eSetup().
// Returns 'ok' | 'mismatch' | 'none' | 'offline'.
export async function e2eVerifyIdentity(): Promise<'ok' | 'mismatch' | 'none' | 'offline'> {
  if (!(await loadLocal()) || !myKeys) return 'none';
  let mine: any;
  try {
    mine = await apiFetch('/keys/me');
  } catch {
    return 'offline'; // can't verify right now — don't touch a working identity
  }
  if (!mine?.publicKey) return 'ok'; // server has nothing published yet
  if (mine.publicKey === b64enc(myKeys.publicKey)) return 'ok';
  // Stale/wrong local identity — drop it so the user can unlock the real one.
  await e2eClear();
  return 'mismatch';
}

export async function e2eDMPeerKey(roomId: number): Promise<Uint8Array | null> {
  const cacheKey = `dm-${roomId}`;
  if (cacheKey in peerKeys) return peerKeys[cacheKey];
  try {
    const res = await apiFetch(`/dm-peer-key/${roomId}`);
    peerKeys[cacheKey] = res?.publicKey ? b64dec(res.publicKey) : null;
  } catch { peerKeys[cacheKey] = null; }
  return peerKeys[cacheKey];
}

// The Diffie-Hellman scalar multiplication in nacl.box is by far the most
// expensive step (hundreds of ms per call in pure JS on slow phones). Do it
// ONCE per peer with box.before and reuse the shared key for every message —
// otherwise a DM with history freezes the whole app while it decrypts.
let sharedCache: { pk: string; sk: Uint8Array; key: Uint8Array } | null = null;
function sharedKey(peerPk: Uint8Array): Uint8Array {
  const tag = b64enc(peerPk);
  if (!sharedCache || sharedCache.pk !== tag || sharedCache.sk !== myKeys!.secretKey) {
    sharedCache = { pk: tag, sk: myKeys!.secretKey, key: nacl.box.before(peerPk, myKeys!.secretKey) };
  }
  return sharedCache.key;
}

export function e2eEncrypt(text: string, peerPk: Uint8Array | null): string | null {
  if (!myKeys || !peerPk) return null;
  const nonce = nacl.randomBytes(24);
  const ct = nacl.box.after(te.encode(text), nonce, sharedKey(peerPk));
  const packed = new Uint8Array(24 + ct.length);
  packed.set(nonce, 0); packed.set(ct, 24);
  return 'e2e:' + b64enc(packed);
}

export function e2eDecrypt(content: string | null, peerPk: Uint8Array | null): string | null {
  if (!content || !content.startsWith('e2e:')) return content;
  if (!myKeys || !peerPk) return null;
  try {
    const packed = b64dec(content.slice(4));
    const opened = nacl.box.open.after(packed.subarray(24), packed.subarray(0, 24), sharedKey(peerPk));
    return opened ? td.decode(new Uint8Array(opened)) : null;
  } catch { return null; }
}

export const e2eIsEncrypted = (content: string | null | undefined) =>
  !!content && String(content).startsWith('e2e:');

export async function e2eClear() {
  myKeys = null;
  sharedCache = null;
  await AsyncStorage.multiRemove(['e2e_pk', 'e2e_sk']);
}
