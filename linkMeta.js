// ── Fetching what a link is about, on the client's behalf ────────────────────
//
// Asked for as: previews (cover and title) for links sent in chats and rooms.
//
// The server does the fetching, for the same reason it proxies map tiles: most
// foreign hosts are unreachable or throttled for these users, and every device
// can already reach the chat server. It also means nobody's phone is made to
// announce itself to whatever site a stranger sent them a link to.
//
// That convenience is also the danger. An endpoint that fetches a URL somebody
// hands it is a request forgery machine unless it is fenced in, and it sits
// inside whatever network the server is on. The fence here:
//
//   • http and https only — no file:, no gopher:, no data:;
//   • the host must resolve, and EVERY address it resolves to must be public.
//     Loopback, link-local, the RFC1918 ranges, carrier-grade NAT, IPv6 unique
//     locals and v4-mapped v6 addresses are all refused;
//   • redirects are followed by hand, three at most, and each hop is checked
//     again — a public host that 302s to 169.254.169.254 is the classic way in;
//   • the response must say it is HTML, and only the first 512 KB is read;
//   • six seconds, total.
//
// One honest gap: the DNS answer we validate and the one the connection uses
// are two separate lookups, so a name that changes its answer between them
// (DNS rebinding) is not stopped by this. Closing it properly means pinning
// the socket to the address we checked, which undici does not make available
// here. The exposure is a GET with no credentials whose body is discarded
// unless it parses as HTML meta tags, and the result is cached per URL.
const dns = require('dns').promises;
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const net = require('net');

const MAX_HTML = 512 * 1024;
const MAX_IMAGE = 2 * 1024 * 1024;
const TIMEOUT_MS = 6000;
const MAX_REDIRECTS = 3;
const CACHE_DIR = path.join('uploads', '.link');
// A page's title changes rarely; a failure may be a site that was down.
const TTL_OK = 7 * 24 * 3600 * 1000;
const TTL_FAIL = 30 * 60 * 1000;

const UA = 'ChatRoom/1.0 (+link preview; self-hosted chat)';

// ── Addresses we will not talk to ───────────────────────────────────────────

/** Is this literal IP one that must never be fetched on a user's say-so? */
function isPrivateIp(ip) {
  const v = net.isIP(ip);
  if (!v) return true;                      // not an address at all — refuse
  if (v === 4) return isPrivateV4(ip);
  const lower = ip.toLowerCase();
  // ::ffff:10.0.0.1 is a v4 address wearing a v6 hat.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped) return isPrivateV4(mapped[1]);
  if (lower === '::' || lower === '::1') return true;
  if (/^f[cd]/.test(lower)) return true;    // fc00::/7 unique local
  if (/^fe[89ab]/.test(lower)) return true; // fe80::/10 link local
  return false;
}

function isPrivateV4(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = p;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;          // link local / metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  if (a === 192 && b === 0) return true;
  if (a >= 224) return true;                        // multicast and reserved
  return false;
}

/** Names that never point anywhere we want to go, whatever DNS says. */
function isBlockedHost(host) {
  const h = String(host || '').toLowerCase().replace(/\.$/, '');
  if (!h || !h.includes('.')) return true;          // "localhost", bare names
  return /\.(?:local|internal|localdomain|home|lan|test|example|invalid|onion)$/.test(h);
}

/**
 * A URL this server is willing to fetch, or null.
 *
 * Textual checks only — the DNS answer is checked separately, because it has
 * to be re-checked on every redirect too.
 */
function safeUrl(raw) {
  let u;
  try { u = new URL(String(raw || '')); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password) return null;
  if (net.isIP(u.hostname)) return null;   // an IP literal is never a page we preview
  if (isBlockedHost(u.hostname)) return null;
  u.hash = '';
  return u.toString();
}

/** Does this host resolve, and does everything it resolves to live on the public internet? */
async function hostIsPublic(host) {
  let addrs;
  try { addrs = await dns.lookup(host, { all: true, verbatim: true }); }
  catch { return false; }
  if (!addrs.length) return false;
  // EVERY answer, not the first: a name with one public and one loopback
  // address would otherwise be waved through and then connect to either.
  return addrs.every(a => !isPrivateIp(a.address));
}

// ── Reading the page ────────────────────────────────────────────────────────

/** Fetch with redirects followed by hand, so each hop can be re-checked. */
async function guardedFetch(url, { accept, maxBytes }) {
  let current = safeUrl(url);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!current) return null;
    const u = new URL(current);
    if (!(await hostIsPublic(u.hostname))) return null;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    let res;
    try {
      res = await fetch(current, {
        redirect: 'manual',
        signal: ctrl.signal,
        headers: { 'User-Agent': UA, Accept: accept, 'Accept-Language': 'en,fa;q=0.8,ar;q=0.6' },
      });
    } catch { clearTimeout(timer); return null; }
    clearTimeout(timer);

    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      // Resolved against the CURRENT url, so a relative Location works, and
      // then put through the same textual fence as the original.
      current = safeUrl(new URL(res.headers.get('location'), current).toString());
      // The body of a redirect is of no interest, and holding it open leaks a socket.
      try { await res.body?.cancel(); } catch {}
      continue;
    }
    if (!res.ok) return null;

    const declared = Number(res.headers.get('content-length') || 0);
    if (declared && declared > maxBytes) return null;
    const buf = await readCapped(res, maxBytes);
    if (!buf) return null;
    return { url: current, type: (res.headers.get('content-type') || '').toLowerCase(), buf };
  }
  return null;
}

/**
 * Read at most `max` bytes, then stop.
 *
 * Not `arrayBuffer()`: a Content-Length can lie, and a server that streams
 * forever would otherwise be allowed to fill this process's memory.
 */
async function readCapped(res, max) {
  const chunks = [];
  let total = 0;
  try {
    for await (const chunk of res.body) {
      chunks.push(Buffer.from(chunk));
      total += chunk.length;
      if (total > max) break;
    }
  } catch { return null; }
  return Buffer.concat(chunks).slice(0, max);
}

// ── Pulling the title and cover out of the HTML ─────────────────────────────

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", '#x27': "'",
};

function decodeEntities(s) {
  return String(s || '').replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, name) => {
    const key = name.toLowerCase();
    if (ENTITIES[key] !== undefined) return ENTITIES[key];
    if (key[0] === '#') {
      const code = key[1] === 'x' ? parseInt(key.slice(2), 16) : parseInt(key.slice(1), 10);
      if (Number.isFinite(code) && code > 0 && code < 0x110000) {
        try { return String.fromCodePoint(code); } catch { return m; }
      }
    }
    return m;
  });
}

/**
 * The Open Graph tags, or what stands in for them.
 *
 * Written as a scan over `<meta>` rather than a parse of the document because
 * an HTML parser is a dependency these two servers do not have, and because
 * the half of a page that matters here is a handful of self-closing tags in
 * the head. Attribute order varies wildly in the wild, so each tag is read as
 * a bag of attributes rather than matched as a shape.
 */
function parseMeta(html, baseUrl) {
  const src = String(html || '');
  // Only the head, when there is one: og tags after it are not og tags, and
  // this keeps a megabyte of body out of the regex.
  const headEnd = src.search(/<\/head|<body/i);
  const head = headEnd > 0 ? src.slice(0, headEnd) : src;

  const props = {};
  for (const tag of head.match(/<meta\b[^>]*>/gi) || []) {
    const attrs = {};
    for (const m of tag.matchAll(/([a-zA-Z:_-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
      attrs[m[1].toLowerCase()] = m[3] ?? m[4] ?? m[5] ?? '';
    }
    const key = (attrs.property || attrs.name || attrs.itemprop || '').toLowerCase();
    const val = attrs.content;
    // First one wins: pages repeat og:image for every image on the page, and
    // the first is the one they mean as the cover.
    if (key && val && props[key] === undefined) props[key] = decodeEntities(val).trim();
  }

  const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head);
  const pick = (...keys) => {
    for (const k of keys) if (props[k]) return props[k];
    return '';
  };

  const image = pick('og:image:secure_url', 'og:image:url', 'og:image', 'twitter:image', 'twitter:image:src');
  return {
    title: pick('og:title', 'twitter:title') || decodeEntities((titleTag ? titleTag[1] : '')).replace(/\s+/g, ' ').trim(),
    description: pick('og:description', 'twitter:description', 'description'),
    siteName: pick('og:site_name', 'application-name'),
    image: image ? absolutise(image, baseUrl) : '',
  };
}

/** A cover given as `/img/x.jpg` is only useful with the page's own origin on it. */
function absolutise(src, baseUrl) {
  try { return new URL(String(src).trim(), baseUrl).toString(); } catch { return ''; }
}

// ── The cover, re-served from here ──────────────────────────────────────────

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

function keyFor(url) {
  return crypto.createHash('sha256').update(String(url)).digest('hex').slice(0, 32);
}

/**
 * Fetch a cover and keep it here.
 *
 * Kept rather than linked because a foreign image URL in a chat bubble is a
 * broken picture for exactly the users this is for, and because loading it
 * would tell that host who is reading the message and when.
 */
async function cacheImage(url, dir = CACHE_DIR) {
  const key = keyFor(url);
  const file = path.join(dir, `${key}.img`);
  const meta = path.join(dir, `${key}.type`);
  if (fs.existsSync(file) && fs.existsSync(meta)) return key;

  const got = await guardedFetch(url, { accept: 'image/*', maxBytes: MAX_IMAGE });
  if (!got) return null;
  const type = got.type.split(';')[0].trim();
  if (!IMAGE_TYPES.includes(type)) return null;
  if (!got.buf.length) return null;

  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${Date.now()}.part`;
  fs.writeFileSync(tmp, got.buf);
  fs.renameSync(tmp, file);
  fs.writeFileSync(meta, type);
  return key;
}

/** Where a cached cover lives, if it is still there. */
function imagePath(key, dir = CACHE_DIR) {
  if (!/^[a-f0-9]{32}$/.test(String(key || ''))) return null;   // never a path from the client
  const file = path.join(dir, `${key}.img`);
  if (!fs.existsSync(file)) return null;
  let type = 'application/octet-stream';
  try { type = fs.readFileSync(path.join(dir, `${key}.type`), 'utf8').trim(); } catch {}
  if (!IMAGE_TYPES.includes(type)) return null;
  return { file, type };
}

// ── The whole job, with its cache ───────────────────────────────────────────

function cacheRead(url, dir, now = Date.now()) {
  const file = path.join(dir, `${keyFor(url)}.json`);
  try {
    const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
    const ttl = rec.ok ? TTL_OK : TTL_FAIL;
    if (now - rec.at < ttl) return rec;
  } catch {}
  return null;
}

function cacheWrite(url, rec, dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${keyFor(url)}.json`);
    const tmp = `${file}.${Date.now()}.part`;
    fs.writeFileSync(tmp, JSON.stringify(rec));
    fs.renameSync(tmp, file);
  } catch {}
}

/**
 * What a link is about: `{ ok, url, title, description, image, siteName }`.
 *
 * `image` is a path on this server, never the foreign URL. A failure is cached
 * too — briefly — because a blocked host fails for every message that carries
 * the link, and re-trying it per render is a loop against a host that is not
 * answering.
 */
async function preview(rawUrl, opts = {}) {
  const dir = opts.dir || CACHE_DIR;
  const url = safeUrl(rawUrl);
  if (!url) return { ok: false, reason: 'refused' };

  const cached = cacheRead(url, dir, opts.now);
  // A cached hit whose cover has since been swept off disk is refetched, so a
  // cleanup does not leave every card with a broken picture for a week.
  if (cached && (!cached.imageKey || imagePath(cached.imageKey, dir))) {
    return cached.ok ? { ...cached.data, ok: true } : { ok: false, reason: cached.reason };
  }

  const got = await guardedFetch(url, { accept: 'text/html,application/xhtml+xml', maxBytes: MAX_HTML });
  if (!got || !/text\/html|application\/xhtml/.test(got.type)) {
    cacheWrite(url, { at: Date.now(), ok: false, reason: 'unreadable' }, dir);
    return { ok: false, reason: 'unreadable' };
  }

  const meta = parseMeta(got.buf.toString('utf8'), got.url);
  const imageKey = meta.image ? await cacheImage(meta.image, dir) : null;
  if (!meta.title && !imageKey) {
    cacheWrite(url, { at: Date.now(), ok: false, reason: 'nothing' }, dir);
    return { ok: false, reason: 'nothing' };
  }

  const data = {
    // The URL AS ASKED, so the client can match the answer to the message it
    // asked about; the redirect chain is our business, not the bubble's.
    url: rawUrl,
    title: meta.title || '',
    description: meta.description || '',
    siteName: meta.siteName || '',
    image: imageKey ? `/link-image/${imageKey}` : '',
  };
  cacheWrite(url, { at: Date.now(), ok: true, imageKey, data }, dir);
  return { ...data, ok: true };
}

/**
 * Throw away previews and covers nobody has asked for in a month.
 *
 * Every link anybody ever sends leaves a cover on disk otherwise, and a chat
 * server whose disk fills up takes the whole thing down. Nothing is lost that
 * cannot be fetched again the next time somebody opens the message.
 */
function sweep(maxAgeMs = 30 * 24 * 3600 * 1000, dir = CACHE_DIR) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return 0; }
  const cutoff = Date.now() - maxAgeMs;
  let removed = 0;
  for (const n of names) {
    const f = path.join(dir, n);
    try {
      if (fs.statSync(f).mtimeMs < cutoff) { fs.unlinkSync(f); removed++; }
    } catch {}
  }
  return removed;
}

module.exports = {
  preview, sweep, parseMeta, safeUrl, isPrivateIp, isBlockedHost, hostIsPublic,
  cacheImage, imagePath, absolutise, decodeEntities, keyFor,
  CACHE_DIR, MAX_HTML, MAX_IMAGE, TIMEOUT_MS,
};
