const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { recipientsFor, tokenIsDead, notificationTag } = require('./notify');
const credentials = require('./credentials');
const cors = require('cors');
const db = require('./db');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Fail closed: the server must NOT run on a missing or default signing secret.
// A blank/default JWT_SECRET means anyone can forge a token for any account —
// exactly the hole that was live on one server. Refuse to start instead of
// silently falling back. (Set ALLOW_INSECURE_JWT=1 only for throwaway local
// experiments where token forgery doesn't matter.)
const DEFAULT_JWT = 'chat_secret_key_change_in_prod';
const JWT_SECRET = process.env.JWT_SECRET;
if ((!JWT_SECRET || JWT_SECRET === DEFAULT_JWT) && process.env.ALLOW_INSECURE_JWT !== '1') {
  console.error('FATAL: JWT_SECRET is not set (or is the known default). Refusing to start — '
    + 'set a strong random JWT_SECRET in the environment. Anyone could forge login tokens otherwise.');
  process.exit(1);
}
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// A fingerprint of the shipped front-end, recomputed at boot. Clients compare
// it against the value they loaded with and reload when it changes, so a deploy
// reaches people who have had the tab (or PWA) open for days.
const APP_VERSION = (() => {
  try {
    const files = ['public/js/app.js', 'public/js/calls.js', 'public/js/e2e.js',
                   'public/js/credentials.js', 'public/css/style.css', 'public/index.html'];
    const h = require('crypto').createHash('sha1');
    for (const f of files) {
      const p = path.join(__dirname, f);
      if (fs.existsSync(p)) h.update(fs.readFileSync(p));
    }
    return h.digest('hex').slice(0, 12);
  } catch {
    return String(Date.now());
  }
})();
console.log('[web] app version', APP_VERSION);
app.get('/version', (req, res) => res.json({ version: APP_VERSION }));

// The front-end files must be REVALIDATED on every load, or a browser happily
// serves a months-old app.js from disk cache and never sees a deploy. ETags
// make that revalidation cheap (304, no body). Hashed/immutable assets like
// uploads keep their long cache.
app.use(express.static('public', {
  etag: true,
  setHeaders(res, filePath) {
    if (/\.(html|js|css|json)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    }
  },
}));
// Uploads are USER-CONTROLLED content served from our own origin. Without
// these headers, someone could upload an .html/.svg with JavaScript, send the
// link, and have it run on our origin when opened — stealing the victim's token
// from localStorage. `nosniff` stops content-type guessing, and forcing
// `attachment` means a direct navigation downloads the file instead of
// rendering it. Embedding still works: <img>/<video>/<audio> ignore
// Content-Disposition, so media in the chat displays normally.
// ── The app's own updates, served from this server ───────────────────────────
//
// Asked for as: upload the newest version to each brand's server and get the
// update from there instead of from GitHub.
//
// The reason it matters is not tidiness. The app asked api.github.com whether
// a newer build existed and downloaded the APK from a GitHub release — and for
// the people this app is for, GitHub is unreliable at best and unreachable at
// worst. When that check failed the app could not tell "you are up to date"
// from "I could not ask", which is how the update button ended up offered in
// one place and not in another.
//
// This server is the one host every user of this brand can definitely reach:
// they are talking to it right now. So the build is copied here (over SSH by
// the release workflow — no upload endpoint, no shared secret, nothing new
// exposed) and served as two files:
//
//   GET /app/latest.json  — what the newest build is
//   GET /app/download     — the APK itself
//
// GitHub stays as a fallback in the app, because a server that has not been
// given a build yet must not mean no updates at all.
const APK_DIR = process.env.APK_DIR || path.join('uploads', '.app');
const APK_FILE = path.join(APK_DIR, 'latest.apk');
const APK_META = path.join(APK_DIR, 'latest.json');

/** What the release workflow left here, or null if it has not run yet. */
function apkManifest() {
  try {
    const meta = JSON.parse(fs.readFileSync(APK_META, 'utf8'));
    const stat = fs.statSync(APK_FILE);
    if (!stat.isFile() || stat.size <= 0) return null;
    const version = parseInt(meta.version, 10);
    if (!Number.isInteger(version) || version <= 0) return null;
    return {
      version,
      size: stat.size,
      sha256: typeof meta.sha256 === 'string' ? meta.sha256 : null,
      builtAt: meta.builtAt || null,
      notes: typeof meta.notes === 'string' ? meta.notes : '',
      fileName: typeof meta.fileName === 'string' ? meta.fileName : 'app-latest.apk',
    };
  } catch {
    return null;
  }
}

app.get('/app/latest.json', (req, res) => {
  const m = apkManifest();
  // No build here yet is a fact, not an error: the app falls back to GitHub,
  // and a 500 would look like a server fault to whoever is reading the logs.
  if (!m) return res.status(404).json({ error: 'no-build', message: 'No build has been published to this server yet.' });
  res.set('Cache-Control', 'no-cache, must-revalidate');
  // THE VERSION IS IN THE URL, and it has to be. Every build was served from
  // the constant path /app/download, which meant a half-finished download of
  // the PREVIOUS build matched the new one by url and was resumed — the app
  // appends to a stale partial, installs it, and the user is still on the old
  // version with the update badge still showing. Reported exactly that way.
  // It also stops an intermediary cache handing back a 40 MB body it kept for
  // this path, which on these connections is not hypothetical.
  res.json({ ...m, url: `/app/download?v=${m.version}` });
});

app.get('/app/download', (req, res) => {
  const m = apkManifest();
  if (!m) return res.status(404).json({ error: 'no-build' });
  // sendFile, so Range requests work: the app resumes a partly-finished
  // download rather than starting a forty-megabyte file again.
  res.set('Content-Type', 'application/vnd.android.package-archive');
  // One file, one constant path, replaced in place on every build: nothing
  // between here and the phone may keep a copy of it.
  res.set('Cache-Control', 'no-store');
  res.set('Content-Disposition', `attachment; filename="${m.fileName.replace(/[^A-Za-z0-9._-]/g, '')}"`);
  // dotfiles: 'allow' is NOT optional here. The directory is `.app` — hidden,
  // like `.tiles` next door, so it stays out of any listing — and sendFile
  // refuses a path containing a dot-segment by default, answering 404 for a
  // file that is plainly there. The path is a constant, not user input, so
  // there is nothing to traverse into.
  res.sendFile(path.resolve(APK_FILE), { dotfiles: 'allow' }, (err) => {
    if (err && !res.headersSent) res.status(404).end();
  });
});

// ── Signed media URLs ────────────────────────────────────────────────────────
// /uploads was served with NO authentication: anyone holding a URL could
// download any voice message, photo or file, forever, without an account —
// including someone who had since been removed from the private room it came
// from. The only protection was that filenames are hard to guess.
//
// Image/video/audio tags cannot send an Authorization header, so per-request
// identity is not available here. Instead every media path handed to a client
// is signed with a short expiry (the same approach as S3 presigned URLs), and
// the static route refuses anything without a valid, unexpired signature.
// Access is therefore decided when the message is DELIVERED — which already
// only happens for rooms the user can see — and the link stops working soon
// after, rather than never.
const MEDIA_URL_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function mediaSig(name, exp) {
  return crypto.createHmac('sha256', JWT_SECRET)
    .update(`${name}:${exp}`).digest('base64url').slice(0, 32);
}

// The expiry is rounded UP to a day boundary, which makes the signed URL for a
// given file STABLE for a day at a time instead of different on every request.
//
// This is not cosmetic. `Date.now() + TTL` produced a brand-new URL each time a
// chat was opened, so every cache that keys on the URL — the phone's image
// cache, the browser's, our own on-disk copies — missed every single time, and
// the same thumbnails, photos and audio were downloaded again on every visit.
// Rounding gives every client a key that stays put, at the cost of a link
// living up to a day longer than the nominal window.
const MEDIA_URL_BUCKET_MS = 24 * 60 * 60 * 1000;

// '/uploads/x.jpg' -> '/uploads/x.jpg?e=...&s=...'   (anything else untouched)
function signPath(p) {
  if (typeof p !== 'string' || !p.startsWith('/uploads/')) return p;
  const name = p.slice('/uploads/'.length).split('?')[0];
  if (!name) return p;
  const exp = Math.ceil((Date.now() + MEDIA_URL_TTL_MS) / MEDIA_URL_BUCKET_MS) * MEDIA_URL_BUCKET_MS;
  return `/uploads/${name}?e=${exp}&s=${mediaSig(name, exp)}`;
}

// Sign a message's media in place. file_path is either one path or, for a
// gallery, a JSON array of them.
function signMessage(msg) {
  if (!msg || typeof msg.file_path !== 'string') return msg;
  if (msg.file_path.startsWith('[')) {
    try {
      const arr = JSON.parse(msg.file_path);
      if (Array.isArray(arr)) return { ...msg, file_path: JSON.stringify(arr.map(signPath)) };
    } catch {}
    return msg;
  }
  return { ...msg, file_path: signPath(msg.file_path) };
}

// Store raw paths, never signed ones: a signature baked into the database
// would expire and strand the file. Gallery paths arrive as a JSON array.
function stripSig(p) {
  if (typeof p !== 'string' || !p) return p || null;
  const bare = (x) => (typeof x === 'string' ? x.split('?')[0] : x);
  if (p.startsWith('[')) {
    try {
      const arr = JSON.parse(p);
      if (Array.isArray(arr)) return JSON.stringify(arr.map(bare));
    } catch {}
    return p;
  }
  return bare(p);
}

// Takes exp/sig explicitly rather than reading req.query: Express re-parses
// that getter, so values written onto it (as the legacy /thumb path needs to
// do) do not survive to the next read.
function validMediaSig(name, exp, sig) {
  exp = parseInt(exp, 10);
  sig = String(sig || '');
  if (!exp || !sig || Date.now() > exp) return false;
  const expected = mediaSig(name, exp);
  // Constant-time compare so the signature can't be probed byte by byte.
  const a = Buffer.from(sig), b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

app.use('/uploads', (req, res, next) => {
  const name = path.basename(decodeURIComponent(req.path));
  if (!validMediaSig(name, req.query.e, req.query.s)) return res.status(403).end();
  next();
});

app.use('/uploads', express.static('uploads', {
  maxAge: '30d', immutable: true,
  setHeaders(res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', 'attachment');
  },
}));

// ── Map tiles, proxied ───────────────────────────────────────────────────────
//
// The app drew its maps straight from tile.openstreetmap.org, which is
// unreachable for users in Iran — so location messages showed an empty grey
// grid. Every device can already reach THIS server (it is where the chat
// lives), so tiles are fetched here and passed on.
//
// Tiles are also cached on disk: the same few are requested over and over as
// people pan, and OpenStreetMap's usage policy expects a proxy to cache rather
// than forward every request.
//
// TILE_UPSTREAM can point somewhere else entirely (an Iranian provider, a
// mirror) without touching the app: {z}/{x}/{y} are substituted.
const TILE_UPSTREAM = process.env.TILE_UPSTREAM
  || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const TILE_DIR = path.join('uploads', '.tiles');
const TILE_MAX_ZOOM = 19;

app.get('/tiles/:z/:x/:y.png', async (req, res) => {
  const z = parseInt(req.params.z, 10);
  const x = parseInt(req.params.x, 10);
  const y = parseInt(req.params.y, 10);
  // Strictly bounded: this endpoint must never become an open proxy that will
  // fetch an arbitrary URL on request.
  if (!Number.isInteger(z) || !Number.isInteger(x) || !Number.isInteger(y)) return res.status(400).end();
  if (z < 0 || z > TILE_MAX_ZOOM) return res.status(400).end();
  const n = Math.pow(2, z);
  if (x < 0 || x >= n || y < 0 || y >= n) return res.status(400).end();

  const file = path.join(TILE_DIR, `${z}_${x}_${y}.png`);
  const serve = () => {
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'public, max-age=2592000');
    fs.createReadStream(file).pipe(res);
  };
  if (fs.existsSync(file)) return serve();

  try {
    const url = TILE_UPSTREAM.replace('{z}', z).replace('{x}', x).replace('{y}', y);
    // OSM refuses requests without a real User-Agent identifying the app.
    const upstream = await fetch(url, { headers: { 'User-Agent': 'ChatRoom/1.0 (self-hosted chat)' } });
    if (!upstream.ok) return res.status(502).end();
    const buf = Buffer.from(await upstream.arrayBuffer());
    fs.mkdirSync(TILE_DIR, { recursive: true });
    // Written via a temp name so a half-downloaded tile is never cached: a
    // truncated PNG would be served from disk forever afterwards.
    const tmp = `${file}.${Date.now()}.part`;
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, file);
    serve();
  } catch {
    res.status(502).end();
  }
});

// ── Link previews ────────────────────────────────────────────────────────────
// Asked for as: a cover and a title for links sent in chats and rooms.
//
// Fetched here rather than on the phone for the same two reasons as the tiles
// above — most foreign hosts are unreachable or throttled for these users, and
// nobody's device should have to announce itself to whatever site a stranger
// sent them a link to. The fence that keeps this from being an open proxy is
// in linkMeta.js, and it is the whole of that file's first comment.
//
// Rooms may be end-to-end encrypted, so the server cannot find the links
// itself: the client that can read the message asks about the one link it
// found. Which is also why this is authenticated — an anonymous fetch-anything
// endpoint is worth more to a passer-by than to a user.
const linkMeta = require('./linkMeta');

// Two requests for the same link arrive together constantly: a room of thirty
// people all open the same message. One fetch serves them all.
const linkInFlight = new Map();
const LINK_MAX_INFLIGHT = 8;

app.get('/link-preview', authMiddleware, async (req, res) => {
  const url = String(req.query.url || '');
  if (url.length > 2048 || !linkMeta.safeUrl(url)) return res.status(204).end();
  try {
    let job = linkInFlight.get(url);
    if (!job) {
      // A burst of distinct links must not turn into a burst of outbound
      // connections from this host; the client redraws without a card.
      if (linkInFlight.size >= LINK_MAX_INFLIGHT) return res.status(503).end();
      job = linkMeta.preview(url).finally(() => linkInFlight.delete(url));
      linkInFlight.set(url, job);
    }
    const meta = await job;
    if (!meta.ok) return res.status(204).end();
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.json(meta);
  } catch {
    res.status(204).end();
  }
});

app.get('/link-image/:key', (req, res) => {
  // Not authenticated on purpose: an <img> tag cannot carry the token, and the
  // key is a hash of a URL somebody already has. The bytes are ours — fetched,
  // size-capped and type-checked before they were written.
  const found = linkMeta.imagePath(req.params.key);
  if (!found) return res.status(404).end();
  res.setHeader('Content-Type', found.type);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.setHeader('Cache-Control', 'public, max-age=604800');
  fs.createReadStream(found.file).pipe(res);
});

// ── Thumbnails ───────────────────────────────────────────────────────────────
// The media gallery rendered its grid from the ORIGINAL uploads: opening a
// chat's photos meant downloading every full-size image just to draw 100px
// cells, which is why a gallery page took so long to fill in. This serves a
// small re-encoded JPEG instead, generated once and cached on disk.
//
// Re-encoding through sharp also means the bytes we return are ours, not the
// uploader's, so unlike /uploads these can safely be served inline as images.
// Loaded LAZILY, and deliberately so. sharp is a native module: a prebuilt
// binary for the wrong Node ABI or libc throws ERR_DLOPEN_FAILED at require()
// time. Required at module scope, that single failure took down the entire
// chat server — every message, every call — over an optional thumbnail. Now a
// broken sharp costs thumbnails and nothing else; clients already fall back to
// the original image when /thumb fails.
let sharpMod;
let sharpBroken = false;
function getSharp() {
  if (sharpBroken) return null;
  if (!sharpMod) {
    try {
      sharpMod = require('sharp');
    } catch (e) {
      sharpBroken = true;
      console.error('sharp failed to load — thumbnails are disabled, '
        + 'originals will be served instead:', e.message);
      return null;
    }
  }
  return sharpMod;
}
const THUMB_DIR = path.join('uploads', '.thumbs');
const THUMB_WIDTHS = [96, 200, 400];   // fixed set: an attacker can't ask for 10000 renders

app.get('/thumb/:name', async (req, res) => {
  // Already-installed clients build this url by stripping "/uploads/" from the
  // message path — which now carries the signature — so the whole
  // "file.jpg?e=..&s=.." ends up URL-ENCODED as the name. Signing the media
  // paths therefore 403'd every thumbnail on builds that shipped before it.
  // Pull the query back out of the name so those clients keep working; the
  // signature is still verified either way.
  let raw = String(req.params.name || '');
  let exp = req.query.e;
  let sig = req.query.s;
  if (raw.includes('?')) {
    const [namePart, embedded] = raw.split('?');
    raw = namePart;
    const inner = new URLSearchParams(embedded);
    exp = exp || inner.get('e');
    sig = sig || inner.get('s');
  }
  // Only ever a bare filename inside uploads/ — no traversal, no subpaths.
  const name = path.basename(raw);
  if (!name || name.startsWith('.') || name !== raw) {
    return res.status(400).end();
  }
  // Same signature gate as /uploads — otherwise /thumb would be an
  // unauthenticated way to read every image on the server.
  if (!validMediaSig(name, exp, sig)) return res.status(403).end();
  const src = path.join('uploads', name);
  if (!fs.existsSync(src)) return res.status(404).end();

  const asked = parseInt(req.query.w, 10) || 200;
  const width = THUMB_WIDTHS.includes(asked) ? asked : 200;
  const out = path.join(THUMB_DIR, `${name}_${width}.jpg`);

  // No thumbnailer on this machine: hand back the ORIGINAL image instead.
  //
  // This used to answer 415 "so the client can fall back to the original" —
  // but no client does that; <Image> just fails and the gallery renders as a
  // blank white grid. That is exactly what happened on a server where sharp
  // could not load. A redirect to the signed original keeps every existing
  // protection (the signature check, nosniff, attachment) and costs only
  // bandwidth, which is far better than showing nothing.
  // signPath expects a full /uploads/ path, not a bare filename — handed the
  // latter it returns it untouched, producing a useless relative redirect.
  const original = () => res.redirect(302, signPath('/uploads/' + name));

  try {
    if (!fs.existsSync(out)) {
      const sharp = getSharp();
      if (!sharp) return original();
      fs.mkdirSync(THUMB_DIR, { recursive: true });
      await sharp(src)
        .rotate()                       // honour EXIF orientation
        .resize(width, width, { fit: 'cover', position: 'centre' })
        .jpeg({ quality: 72 })
        .toFile(out);
    }
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'public, max-age=2592000, immutable');
    fs.createReadStream(out).pipe(res);
  } catch {
    // A format sharp cannot read. It may still be something the device can
    // display, so let it try the original rather than guaranteeing a blank.
    original();
  }
});

const storage = multer.diskStorage({
  destination: 'uploads/',
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, unique + path.extname(file.originalname));
  }
});
const upload = multer({ storage, limits: { fileSize: 80 * 1024 * 1024 } });

function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

// Simple in-memory rate limiter, keyed by IP+username, sized for one server
// process. Not a substitute for a WAF, but it turns unlimited credential
// stuffing against a known username into a few tries per minute.
const MIN_PASSWORD_LEN = 8;
const authAttempts = new Map(); // key -> { count, resetAt }
const AUTH_WINDOW_MS = 60 * 1000;
const AUTH_MAX = 10;
function authRateLimited(key) {
  const now = Date.now();
  let e = authAttempts.get(key);
  if (!e || now > e.resetAt) { e = { count: 0, resetAt: now + AUTH_WINDOW_MS }; authAttempts.set(key, e); }
  e.count++;
  return e.count > AUTH_MAX;
}
// Occasional cleanup so the map can't grow unbounded.
setInterval(() => {
  const now = Date.now();
  for (const [k, e] of authAttempts) if (now > e.resetAt) authAttempts.delete(k);
}, 5 * 60 * 1000).unref?.();

// Auth — usernames are unique identifiers. Login only signs in existing users;
// creating an account requires an explicit register flag (clients confirm with
// the user first), so a renamed account's old username is never silently
// re-created by a stale login.
app.post('/auth/signin', async (req, res) => {
  const { username, password, register } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  const uname = String(username).trim();
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim();
  if (authRateLimited(ip + '|' + uname.toLowerCase())) {
    return res.status(429).json({ error: 'Too many attempts — please wait a minute and try again.' });
  }
  // Look up exactly first, then case-insensitively. Usernames are conceptually
  // case-insensitive, but older accounts were stored as typed and two of them
  // could differ only by case — so a fuzzy match is only trusted when it is
  // unambiguous, rather than picking one of them arbitrarily.
  let user = db.prepare('SELECT * FROM users WHERE username = ?').get(uname);
  if (!user) {
    const near = db.prepare('SELECT * FROM users WHERE lower(username) = ?').all(uname.toLowerCase());
    if (near.length === 1) user = near[0];
  }
  if (user) {
    if (register) return res.status(409).json({ error: 'Username already taken' });
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Wrong password' });
    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET);
    return res.json({ token, username: user.username, avatar: user.avatar || null, isNew: false });
  }
  if (!register) {
    return res.status(404).json({ error: 'No account with this username', canRegister: true });
  }
  // New account: the same rules the clients show, enforced here too — a client
  // is only a convenience, it is never the check that counts.
  const normalized = credentials.normalizeUsername(uname);
  const badName = credentials.validateUsername(normalized);
  if (badName) return res.status(400).json({ error: badName.en, field: 'username', code: badName.code });
  const badPass = credentials.validatePassword(password, normalized);
  if (badPass) return res.status(400).json({ error: badPass.en, field: 'password', code: badPass.code });
  // Case-insensitive uniqueness: "Ako" must not become a second account
  // alongside "ako". That kind of near-duplicate gets reported as a forgotten
  // password when the user is really signing in to the wrong account.
  const clash = db.prepare('SELECT 1 FROM users WHERE lower(username) = ?').get(normalized);
  if (clash) return res.status(409).json({ error: 'Username already taken' });
  try {
    const hash = await bcrypt.hash(password, 10);
    const result = db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(normalized, hash);
    // Rooms are joined explicitly now, so a brand-new account would otherwise
    // land on an empty list. Put them in the default room to start.
    const general = db.prepare('SELECT id FROM rooms WHERE name = ?').get('General');
    if (general) {
      db.prepare('INSERT OR IGNORE INTO room_members (room_id, user_id) VALUES (?, ?)')
        .run(general.id, result.lastInsertRowid);
    }
    const token = jwt.sign({ id: result.lastInsertRowid, username: normalized }, JWT_SECRET);
    res.json({ token, username: normalized, avatar: null, isNew: true });
  } catch {
    res.status(409).json({ error: 'Something went wrong, try again' });
  }
});

// Profile update
// Two changes, then the name is fixed. Exposed so the client can say how many
// are left BEFORE the user commits to one.
const USERNAME_CHANGE_LIMIT = 2;

app.put('/profile', authMiddleware, async (req, res) => {
  const { newUsername, currentPassword, newPassword, avatar } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  if (currentPassword) {
    const valid = await bcrypt.compare(currentPassword, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });
  }

  if (newUsername && newUsername !== user.username) {
    // A username is an identity other people rely on to find and address you,
    // so it can only be changed a couple of times — not churned.
    const used = user.username_changes || 0;
    if (used >= USERNAME_CHANGE_LIMIT) {
      return res.status(403).json({
        error: `You have already changed your username ${used} times. It cannot be changed again.`,
      });
    }
    const check = credentials.validateUsername(newUsername);
    if (check) return res.status(400).json({ error: check.en, errorFa: check.fa, code: check.code });
    const normalized = credentials.normalizeUsername(newUsername);
    // Case-insensitive: "Ako" must not become a second account beside "ako".
    const taken = db.prepare('SELECT id FROM users WHERE lower(username) = ? AND id != ?')
      .get(normalized, req.user.id);
    if (taken) return res.status(409).json({ error: 'Username already taken' });
    db.prepare('UPDATE users SET username = ?, username_changes = ? WHERE id = ?')
      .run(normalized, used + 1, req.user.id);
  }

  if (newPassword) {
    if (!currentPassword) return res.status(400).json({ error: 'Current password required to set new password' });
    const hash = await bcrypt.hash(newPassword, 10);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, req.user.id);
  }

  if (avatar !== undefined) {
    // avatar is a single emoji (or null to remove) — no password required
    db.prepare('UPDATE users SET avatar = ? WHERE id = ?')
      .run(avatar ? String(avatar).slice(0, 8) : null, req.user.id);
  }

  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  const token = jwt.sign({ id: updated.id, username: updated.username }, JWT_SECRET);
  res.json({
    token, username: updated.username, avatar: updated.avatar || null,
    usernameChangesLeft: Math.max(0, USERNAME_CHANGE_LIMIT - (updated.username_changes || 0)),
  });
});

app.get('/me', authMiddleware, (req, res) => {
  const u = db.prepare('SELECT username, avatar, username_changes FROM users WHERE id = ?').get(req.user.id);
  if (!u) return res.status(404).json({ error: 'User not found' });
  res.json({
    username: u.username,
    avatar: u.avatar || null,
    usernameChangesLeft: Math.max(0, USERNAME_CHANGE_LIMIT - (u.username_changes || 0)),
    usernameChangeLimit: USERNAME_CHANGE_LIMIT,
  });
});

// Who can be @mentioned in this chat, for the composer's suggestions.
app.get('/room-usernames/:roomId', authMiddleware, (req, res) => {
  const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(req.params.roomId);
  if (!canAccessRoom(req.user.id, room)) return res.status(403).json({ error: 'No access' });
  const ids = getRoomMemberIds(room).filter(id => id !== req.user.id);
  if (!ids.length) return res.json({ users: [] });
  const users = db.prepare(
    `SELECT id, username, avatar FROM users WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY username`
  ).all(...ids);
  res.json({ users });
});

// Unread @mentions of me in this chat, so the client can offer a jump button.
app.get('/mentions/:roomId', authMiddleware, (req, res) => {
  const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(req.params.roomId);
  if (!canAccessRoom(req.user.id, room)) return res.status(403).json({ error: 'No access' });
  const me = db.prepare('SELECT username FROM users WHERE id = ?').get(req.user.id);
  if (!me) return res.json({ mentions: [] });
  const read = db.prepare('SELECT last_read_msg_id FROM room_reads WHERE room_id = ? AND user_id = ?')
    .get(room.id, req.user.id);
  // A mention inside cleared history, or from somebody blocked, is not a
  // mention that is still waiting.
  const vis = visibleMessagesSql(req.user.id, room.id, 'messages');
  const rows = db.prepare(`
    SELECT id FROM messages
    WHERE room_id = ? AND user_id != ? AND id > ? ${vis}
      AND content LIKE ? ESCAPE '#'
    ORDER BY id ASC LIMIT 100
  `).all(room.id, req.user.id, read?.last_read_msg_id || 0,
    '%@' + me.username.replace(/[#%_]/g, c => '#' + c) + '%');
  res.json({ mentions: rows.map(r => r.id) });
});

// Rooms the user actually belongs to — ones they created or joined. Public
// rooms used to be listed for everybody, which turned the sidebar into a
// directory of every room on the server; they are now *found* by name search
// or by link, and only appear here once joined.
// Ordered by most recent activity (newest message first) so the busiest chats
// float to the top; rooms with no messages yet fall back to their creation time.
app.get('/rooms', authMiddleware, (req, res) => {
  const rooms = db.prepare(`
    SELECT rooms.*,
      (SELECT MAX(m.id) FROM messages m WHERE m.room_id = rooms.id) AS last_msg_id
    FROM rooms
    WHERE is_dm = 0 AND (
      created_by = ?
      OR EXISTS (SELECT 1 FROM room_members rm WHERE rm.room_id = rooms.id AND rm.user_id = ?)
    )
    ORDER BY last_msg_id IS NULL, last_msg_id DESC, rooms.id DESC
  `).all(req.user.id, req.user.id);
  res.json(rooms);
});

app.post('/rooms', authMiddleware, (req, res) => {
  const { name, isPrivate } = req.body;
  if (!name) return res.status(400).json({ error: 'Room name required' });
  try {
    const result = db.prepare('INSERT INTO rooms (name, created_by, is_private) VALUES (?, ?, ?)')
      .run(name.trim(), req.user.id, isPrivate ? 1 : 0);
    const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(result.lastInsertRowid);
    db.prepare('INSERT OR IGNORE INTO room_members (room_id, user_id) VALUES (?, ?)').run(room.id, req.user.id);
    // Only the creator gets it in their sidebar — a new public room is not
    // pushed at every user on the server any more.
    io.to('user:' + req.user.id).emit('room_created', room);
    res.json(room);
  } catch {
    res.status(409).json({ error: 'Room already exists' });
  }
});

// ── Push notifications via Firebase Cloud Messaging (HTTP v1) ─────────────────
// Activates automatically when a Firebase service-account JSON is present
// (FIREBASE_SERVICE_ACCOUNT env var or ./firebase-service-account.json).
let fcmCreds = null;
try {
  const svcPath = process.env.FIREBASE_SERVICE_ACCOUNT || path.join(__dirname, 'firebase-service-account.json');
  if (fs.existsSync(svcPath)) {
    fcmCreds = JSON.parse(fs.readFileSync(svcPath, 'utf8'));
    console.log(`[FCM] Loaded service account for project "${fcmCreds.project_id}" from ${svcPath}`);
  } else {
    console.warn(`[FCM] No service account found at ${svcPath} — push notifications disabled`);
  }
} catch (err) {
  console.error('[FCM] Failed to load/parse service account:', err.message);
}
let fcmToken = null;
let fcmTokenExp = 0;

async function getFcmAccessToken() {
  if (!fcmCreds) return null;
  if (fcmToken && Date.now() < fcmTokenExp) return fcmToken;
  const now = Math.floor(Date.now() / 1000);
  const assertion = jwt.sign({
    iss: fcmCreds.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: fcmCreds.token_uri,
    iat: now,
    exp: now + 3600,
  }, fcmCreds.private_key, { algorithm: 'RS256' });
  const res = await fetch(fcmCreds.token_uri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${encodeURIComponent(assertion)}`,
  }).then(r => r.json());
  if (!res.access_token) {
    console.error('[FCM] Failed to obtain access token:', JSON.stringify(res));
    return null;
  }
  fcmToken = res.access_token;
  fcmTokenExp = Date.now() + 50 * 60 * 1000;
  return fcmToken;
}

/**
 * `android.dataOnly` sends a message with NO notification block.
 *
 * That distinction decides whether the app's own code gets to run. A payload
 * carrying a `notification` is drawn by the OS and the app's JS never starts
 * while it is backgrounded or closed — fine for a message, useless for a call,
 * which needs to ring continuously rather than chime once. A data-only,
 * high-priority message wakes the app so it can raise a real ringing call
 * notification itself.
 */
/**
 * `android.fromUserId`, when given, is who this notification is ABOUT.
 *
 * Anyone who has muted that person is dropped here rather than at each of the
 * five call sites. Muting is about not being interrupted, so it stops the
 * notification and nothing else: the message still arrives, the chat still
 * shows it, and the unread count still counts it.
 */
/**
 * Will a push actually reach this person?
 *
 * Not "was one sent" — this is asked BEFORE sending, so the caller's screen
 * can say "Ringing…" rather than "Connecting…" while the callee's phone is
 * alerting them. Reported as: the other user is looking at an incoming call
 * notification and the caller is still told the call is connecting.
 *
 * Answers the same two questions the sender does, in the same order: has this
 * person muted the caller, and is there any route to their device at all —
 * a Firebase token for the app, or a Web Push subscription for a home-screen
 * PWA. "Connecting…" then means what it should: nothing can reach them.
 */
function hasPushRoute(userId, fromUserId) {
  try {
    if (!recipientsFor([userId], fromUserId, hasMuted).length) return false;
    const fcm = db.prepare('SELECT 1 FROM push_tokens WHERE user_id = ? LIMIT 1').get(userId);
    if (fcm) return true;
    return !!db.prepare('SELECT 1 FROM web_push_subs WHERE user_id = ? LIMIT 1').get(userId);
  } catch { return false; }
}

async function sendPushToUsers(userIds, title, body, data = {}, android = {}) {
  if (!userIds.length) return;
  // The rule lives in notify.js so it can be tested: the rest of this function
  // is behind credential checks a test environment has no way to satisfy.
  userIds = recipientsFor(userIds, android.fromUserId, hasMuted);
  if (!userIds.length) return;
  // Browsers first, and independently of Firebase: an iPhone can only have
  // this app as a home-screen PWA, and that PWA is pushed through Web Push,
  // which needs no Google credentials at all. A server with no FCM key must
  // still be able to notify them.
  sendWebPushToUsers(userIds, title, body, data);
  if (!fcmCreds) return;
  try {
    const placeholders = userIds.map(() => '?').join(',');
    const tokens = db.prepare(`SELECT token FROM push_tokens WHERE user_id IN (${placeholders})`)
      .all(...userIds).map(r => r.token);
    // A recipient with no device token cannot be pushed to at all. The
    // notification they eventually see is the app raising it itself when its
    // socket reconnects — late by however long Android takes to let the app
    // run, which is the other way a notification arrives minutes afterwards.
    if (!tokens.length) {
      console.log(`[push] ${userIds.length} recipient(s) [${userIds.join(',')}] have no device token`);
      return;
    }
    const tAuth = Date.now();
    const access = await getFcmAccessToken();
    const authMs = Date.now() - tAuth;
    if (!access) return;
    const tSend = Date.now();
    await Promise.all(tokens.map(t =>
      fetch(`https://fcm.googleapis.com/v1/projects/${fcmCreds.project_id}/messages:send`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: {
            token: t,
            notification: { title, body },
            // channelId is in the DATA as well as in android.notification.
            //
            // Reported as: with the app closed a call still does not ring.
            // expo-notifications intercepts every FCM message and builds the
            // notification ITSELF rather than letting Firebase present it, and
            // the channel it builds on comes from the data payload — the
            // android.notification.channel_id below is only used on the paths
            // where the system draws the notification directly. Naming the
            // channel in one place and not the other meant the call was drawn
            // on the default channel: one short default chime, no ring.
            data: Object.fromEntries(
              Object.entries({
                ...data, title, body,
                channelId: android.channelId || 'messages-v3',
                // THE TAG BELONGS HERE TOO, for the same reason channelId does
                // — and this is not inference, it is what the library reads.
                // expo-notifications, FirebaseMessagingDelegate.kt:
                //
                //   return remoteMessage.data["tag"]
                //       ?: remoteMessage.messageId
                //       ?: UUID.randomUUID().toString()
                //
                // That string becomes the Android notification TAG, and the
                // numeric id beside it is a constant for every notification
                // expo draws (getNotifyId in ExpoPresentationDelegate.kt), so
                // the tag is the ONLY thing distinguishing one notification
                // from another on this path.
                //
                // android.notification.tag below never reaches it: that field
                // is read only when the system draws the notification itself,
                // which is not what happens while the app's process exists.
                // So every push fell back to messageId — a value the app's own
                // socket notification cannot possibly match. The two paths
                // could never be recognised as the same notification, which is
                // what the shared msg-<id> tag was introduced to guarantee,
                // and a delete could not pull a pushed notification from the
                // tray because it was not tagged with the message id at all.
                ...(data.msgId ? { tag: notificationTag(data.msgId) } : {}),
                ...(android.tag ? { tag: android.tag } : {}),
              }).map(([k, v]) => [k, String(v)]),
            ),
            android: {
              priority: 'high',
              notification: {
                channel_id: android.channelId || 'messages-v3',
                sound: android.sound || 'notify',
                // NOT click_action. That names an intent action the app must
                // declare an intent-filter for, and this one declares none —
                // so setting it means tapping the notification does nothing
                // at all. Left off, Android opens the launcher activity,
                // which is what tapping a call should do.
                ...(android.priorityMax ? { notification_priority: 'PRIORITY_MAX' } : {}),
                // Tag the tray notification with the message id so a later
                // delete can replace/collapse it on the recipient's device.
                ...(data.msgId ? { tag: notificationTag(data.msgId) } : {}),
                ...(android.tag ? { tag: android.tag } : {}),
              },
              // Calls must not be held back by Doze or app-standby buckets.
              ...(android.ttl ? { ttl: android.ttl, direct_boot_ok: true } : {}),
            },
          },
        }),
      }).then(async r => {
        if (r.ok) return;
        const body = await r.text().catch(() => '');
        // Only when Firebase has actually said the token is gone. Deleting it
        // means this device gets nothing until the app is next opened, so a
        // malformed payload — which is what a bare 400 usually is — must not
        // cost a phone its notifications. See tokenIsDead in notify.js.
        if (tokenIsDead(r.status, body)) {
          db.prepare('DELETE FROM push_tokens WHERE token = ?').run(t);
          console.warn(`[FCM] Removed a token Firebase no longer knows (status ${r.status})`);
          return;
        }
        console.error(`[FCM] Send failed (status ${r.status}):`, body);
      }).catch(err => console.error('[FCM] Send request error:', err.message))
    ));
    // The one line that says whether the server is the slow part. Everything
    // after this is Google's to deliver, and nothing here can see that — so if
    // this reads 150ms and the phone buzzes two minutes later, the delay is on
    // the path from Google to the handset, and no amount of work in this file
    // will shorten it.
    console.log(`[push] ${tokens.length} device(s) for ${userIds.length} user(s) `
      + `[${userIds.join(',')}] — auth ${authMs}ms, send ${Date.now() - tSend}ms`);
  } catch (err) {
    console.error('[FCM] sendPushToUsers error:', err.message);
  }
}

// ── Web push ─────────────────────────────────────────────────────────────────
// How a browser is notified — and the only way an iPhone can be, since iOS
// installs nothing that Apple has not signed and a home-screen PWA is
// therefore the whole of the iOS story here. See webPush.js.
const webPush = require('./webPush');

// Generated once and kept, because a VAPID public key is an identity: every
// subscription ever made is bound to it, so a new pair on restart would
// silently orphan every device that had subscribed.
const vapidKeys = webPush.ensureKeys(process.env, {
  get: (k) => (db.prepare('SELECT value FROM meta WHERE key = ?').get(k) || {}).value || '',
  set: (k, v) => db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, v),
});
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || `https://${process.env.PUBLIC_HOST || 'localhost'}`;
if (!webPush.available(vapidKeys)) {
  console.warn('[web-push] disabled — no keys (is the web-push package installed?)');
}

/** The key a browser needs before it can subscribe. Public by definition. */
app.get('/push/public-key', (req, res) => {
  if (!webPush.available(vapidKeys)) return res.status(503).json({ error: 'Web push is not configured' });
  res.json({ key: vapidKeys.publicKey });
});

app.post('/web-push', authMiddleware, (req, res) => {
  const sub = req.body && req.body.subscription;
  if (!webPush.validSubscription(sub)) return res.status(400).json({ error: 'Bad subscription' });
  db.prepare(`INSERT INTO web_push_subs (user_id, endpoint, p256dh, auth, created_at)
              VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id`)
    .run(req.user.id, String(sub.endpoint), String(sub.keys.p256dh), String(sub.keys.auth), Date.now());
  res.json({ ok: true });
});

app.delete('/web-push', authMiddleware, (req, res) => {
  const endpoint = req.body && req.body.endpoint;
  if (endpoint) db.prepare('DELETE FROM web_push_subs WHERE endpoint = ? AND user_id = ?')
    .run(String(endpoint), req.user.id);
  res.json({ ok: true });
});

/**
 * Notify every browser these people have subscribed from.
 *
 * The recipients are already filtered for mutes by the caller. Failures are
 * per-subscription and never thrown: one dead endpoint must not stop the rest,
 * and one that the push service says is GONE is deleted rather than retried
 * forever.
 */
async function sendWebPushToUsers(userIds, title, body, data = {}) {
  if (!webPush.available(vapidKeys) || !userIds.length) return;
  let subs;
  try {
    const places = userIds.map(() => '?').join(',');
    subs = db.prepare(`SELECT endpoint, p256dh, auth FROM web_push_subs WHERE user_id IN (${places})`)
      .all(...userIds);
  } catch (err) {
    console.error('[web-push] could not read subscriptions:', err.message);
    return;
  }
  if (!subs.length) return;
  const payload = webPush.payloadFor(title, body, data);
  await Promise.all(subs.map(async (s) => {
    const r = await webPush.sendOne(s, payload, vapidKeys, VAPID_SUBJECT);
    if (r.gone) {
      try { db.prepare('DELETE FROM web_push_subs WHERE endpoint = ?').run(s.endpoint); } catch {}
    }
  }));
}

// Permanently remove a message (used by user deletes and one-time expiry).
// One-time media also has its uploaded file removed from disk.
function destroyMessage(msg) {
  db.prepare('DELETE FROM reactions WHERE message_id = ?').run(msg.id);
  db.prepare('DELETE FROM messages WHERE id = ?').run(msg.id);
  if ((msg.one_time_seconds || msg.disappear_seconds) && msg.file_path) {
    // Gallery messages store a JSON array of upload paths
    let paths = [];
    if (msg.file_path.startsWith('[')) {
      try { paths = JSON.parse(msg.file_path); } catch {}
    } else {
      paths = [msg.file_path];
    }
    paths.filter(p => typeof p === 'string' && p.startsWith('/uploads/')).forEach(p => {
      const shared = db.prepare("SELECT 1 FROM messages WHERE file_path LIKE '%' || ? || '%' LIMIT 1").get(p);
      if (!shared) fs.unlink(path.join(__dirname, p), () => {});
    });
  }
  // Deliver to every member's personal channel as well as the presence room.
  // Sockets drop out of the presence channel whenever the app is backgrounded
  // (leave_room), so a sender who stepped away never learned their one-time
  // message had been opened and destroyed — it was still sitting in their chat
  // when they came back.
  const payload = { messageId: msg.id, roomId: msg.room_id };
  io.to(String(msg.room_id)).emit('message_deleted', payload);
  const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(msg.room_id);
  if (room) getRoomMemberIds(room).forEach(id => io.to('user:' + id).emit('message_deleted', payload));
}

// Sweep for one-time messages whose timer elapsed while the server was down
// (setTimeout timers don't survive restarts).
setInterval(() => {
  try {
    const now = Date.now();
    db.prepare('SELECT * FROM messages WHERE one_time_seconds IS NOT NULL AND viewed_at IS NOT NULL')
      .all()
      .filter(m => now >= m.viewed_at + m.one_time_seconds * 1000)
      .forEach(destroyMessage);
    // Disappearing messages. Swept the same way, so a timer that elapsed while
    // the server was down is still honoured on the next tick rather than
    // leaving the message sitting there forever.
    sweepExpired(now);
  } catch (err) {
    console.error('[one-time] sweep error:', err.message);
  }
}, 30 * 1000);

// ── Disappearing messages go at the moment they are due ──────────────────────
//
// Reported as: they do not disappear exactly after the time they were set to.
//
// The sweep above runs every thirty seconds, so a message with a thirty-second
// timer could sit there for a full minute — twice as long as the setting says,
// and the shorter the timer the worse the proportion. A sweep is the right
// safety net (a timer that elapsed while the server was down is still honoured
// on the next tick) but it is the wrong primary mechanism.
//
// So the next deadline is also scheduled EXACTLY. One timer at a time, for the
// earliest expiry there is, re-armed whenever that changes: a new countdown
// starting, or a sweep finishing.
let expiryTimer = null;

function sweepExpired(now = Date.now()) {
  // BOTH clocks. A disappearing message is due at `expires_at`; a one-time
  // message is due `one_time_seconds` after it was opened. The exact timer for
  // a one-time message is a setTimeout created when it is viewed, which does
  // not survive a restart — so it is swept here as well, or a message whose
  // minute ran out while the server was down sits in the chat until somebody
  // happens to reload.
  const due = db.prepare(`
    SELECT * FROM messages
     WHERE (expires_at IS NOT NULL AND expires_at <= ?)
        OR (one_time_seconds IS NOT NULL AND viewed_at IS NOT NULL
            AND viewed_at + one_time_seconds * 1000 <= ?)
  `).all(now, now);
  due.forEach(destroyMessage);
  return due.length;
}

function scheduleNextExpiry() {
  clearTimeout(expiryTimer);
  let next;
  try {
    next = db.prepare(`
      SELECT MIN(at) AS at FROM (
        SELECT expires_at AS at FROM messages WHERE expires_at IS NOT NULL
        UNION ALL
        SELECT viewed_at + one_time_seconds * 1000 AS at FROM messages
         WHERE one_time_seconds IS NOT NULL AND viewed_at IS NOT NULL
      )
    `).get();
  } catch { return; }
  if (!next || next.at == null) return;   // nothing is counting down
  // Capped, so a week-long timer does not sit in a single setTimeout for a
  // week — Node's timers drift over that kind of span, and the process is
  // restarted by deploys long before it would fire. The periodic sweep covers
  // anything the cap defers.
  const delay = Math.min(Math.max(0, next.at - Date.now()), 60 * 1000);
  expiryTimer = setTimeout(() => {
    try { sweepExpired(); } catch (err) { console.error('[expiry] sweep:', err.message); }
    scheduleNextExpiry();
  }, delay);
  expiryTimer.unref?.();
}

// At startup, and after every sweep, so a deadline that passed while the
// process was down is dealt with immediately rather than up to thirty seconds
// later.
try { sweepExpired(); } catch {}
scheduleNextExpiry();

// Notifications never preview message content — only the kind of message.
function messagePreview(msg) {
  return msg.type === 'text' ? '💬 New message'
    : msg.type === 'audio' ? '🎙 Voice message'
    : msg.type === 'image' ? '🖼 Photo'
    : msg.type === 'gallery' ? '🖼 Photos'
    : msg.type === 'video' ? '🎥 Video'
    : msg.type === 'music' ? '🎵 Audio file'
    : msg.type === 'invite' ? '🔒 Room invitation'
    : msg.type === 'call' ? '📞 Call'
    : msg.type === 'location' ? '📍 Location'
    : msg.type === 'system' ? 'ℹ️ Room update' : '📄 File';
}

// Register/unregister device push tokens
app.post('/push-token', authMiddleware, (req, res) => {
  const { token, platform } = req.body;
  if (!token) return res.status(400).json({ error: 'Token required' });
  db.prepare('INSERT INTO push_tokens (user_id, token, platform) VALUES (?, ?, ?) ON CONFLICT(token) DO UPDATE SET user_id = excluded.user_id')
    .run(req.user.id, String(token), platform || null);
  res.json({ ok: true });
});
app.delete('/push-token', authMiddleware, (req, res) => {
  const { token } = req.body || {};
  if (token) db.prepare('DELETE FROM push_tokens WHERE token = ? AND user_id = ?').run(String(token), req.user.id);
  res.json({ ok: true });
});

/**
 * One room's unread count, by the same rule the list uses.
 *
 * Deliberately a second query rather than a shared string with /unread-counts:
 * that one is scoped to every room the user belongs to and this one is not,
 * and pretending they are the same query is how the two drift into disagreeing
 * about what a badge means.
 */
function unreadCountFor(userId, roomId) {
  try {
    const row = db.prepare(`
      SELECT COUNT(*) AS cnt
      FROM messages m
      LEFT JOIN room_reads rr ON rr.room_id = m.room_id AND rr.user_id = ?
      LEFT JOIN comment_reads cr ON cr.parent_id = m.parent_id AND cr.user_id = ?
      WHERE m.room_id = ? AND m.user_id != ?
        AND m.blocked_delivery = 0
        AND (
          CASE WHEN m.parent_id IS NULL
            THEN m.id > COALESCE(rr.last_read_msg_id, 0)
            ELSE m.id > COALESCE(cr.last_read_msg_id, 0)
          END
        )
        AND m.id > COALESCE(
          (SELECT rc.cleared_upto_id FROM room_clears rc
            WHERE rc.room_id = m.room_id AND rc.user_id = ?), 0)
        -- A message deleted for me is not an unread message, or the badge
        -- counts something the user cannot open.
        ${notHiddenSql(userId)}
    `).get(userId, userId, roomId, userId, userId);
    return row ? row.cnt : 0;
  } catch { return 0; }
}

/**
 * Which threads in this room have comments the user has not seen.
 *
 * The clients badge the message itself and offer a jump to it, and both were
 * held in memory only — so a reload lost them and the feature existed for
 * exactly as long as the tab stayed open.
 */
app.get('/comment-unread/:roomId', authMiddleware, (req, res) => {
  const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(req.params.roomId);
  if (!canAccessRoom(req.user.id, room)) return res.status(403).json({ error: 'No access' });
  const rows = db.prepare(`
    SELECT m.parent_id AS parentId, COUNT(*) AS cnt
    FROM messages m
    LEFT JOIN comment_reads cr ON cr.parent_id = m.parent_id AND cr.user_id = ?
    WHERE m.room_id = ? AND m.parent_id IS NOT NULL AND m.user_id != ?
      AND m.blocked_delivery = 0
      AND m.id > COALESCE(cr.last_read_msg_id, 0)
      AND m.id > COALESCE(
        (SELECT rc.cleared_upto_id FROM room_clears rc
          WHERE rc.room_id = m.room_id AND rc.user_id = ?), 0)
      ${notHiddenSql(req.user.id)}
    GROUP BY m.parent_id
  `).all(req.user.id, room.id, req.user.id, req.user.id);
  const out = {};
  rows.forEach(r => { out[String(r.parentId)] = r.cnt; });
  res.json(out);
});

// Per-room unread counts based on server-side read positions
app.get('/unread-counts', authMiddleware, (req, res) => {
  // Scoped to rooms the user is actually in. It used to count EVERY room in
  // the database, so a room they had left still showed an unread badge — and
  // it quietly reported how busy rooms they had never been near were.
  const rows = db.prepare(`
    SELECT m.room_id, COUNT(*) AS cnt
    FROM messages m
    LEFT JOIN room_reads rr ON rr.room_id = m.room_id AND rr.user_id = ?
    -- A COMMENT is read by opening its thread, not by opening the chat. Its
    -- id is never in the chat's own message list, so measuring it against the
    -- room's read position left it unread for ever — reported as: the badge on
    -- the chat list does not go away.
    LEFT JOIN comment_reads cr ON cr.parent_id = m.parent_id AND cr.user_id = ?
    JOIN rooms r ON r.id = m.room_id
    WHERE m.user_id != ?
      -- Undelivered messages are not unread messages. A message written while
      -- the recipient had the sender blocked is never shown to them by ANY
      -- list in this file — but it was still counted here, so the badge could
      -- not be cleared by opening the chat: the message it was counting is not
      -- in the chat and never will be. Reported as: I see unread messages and
      -- opening the chat does not mark them read.
      AND m.blocked_delivery = 0
      AND (
        CASE WHEN m.parent_id IS NULL
          THEN m.id > COALESCE(rr.last_read_msg_id, 0)
          ELSE m.id > COALESCE(cr.last_read_msg_id, 0)
        END
      )
      -- Cleared messages are not unread messages. Without this a chat the
      -- user has just emptied comes straight back with a badge on it.
      AND m.id > COALESCE(
        (SELECT rc.cleared_upto_id FROM room_clears rc
          WHERE rc.room_id = m.room_id AND rc.user_id = ?), 0)
      ${notHiddenSql(req.user.id)}
      AND (
        EXISTS (SELECT 1 FROM room_members rm WHERE rm.room_id = m.room_id AND rm.user_id = ?)
        -- DMs carry no membership rows; they are identified by their name,
        -- '__dm__<a>__<b>__'. The underscores MUST be escaped: '_' is a
        -- single-character wildcard in LIKE, so an unescaped '__12__' also
        -- matches '__1x2__' — which would hand user 12 the unread counts of a
        -- conversation between two other people.
        --
        -- '#' is the escape character rather than the usual backslash purely
        -- so this survives being written inside a JS template literal, where a
        -- backslash is itself an escape and silently disappears.
        OR (r.is_dm = 1 AND (
             r.name LIKE '#_#_dm#_#_' || ? || '#_#_%' ESCAPE '#'
             OR r.name LIKE '%#_#_' || ? || '#_#_' ESCAPE '#'
        ))
      )
    GROUP BY m.room_id
    -- The two LIKE ids are bound as STRINGS on purpose. A JS number binds as
    -- a REAL, and SQLite's || then renders it '2.0', so the pattern became
    -- '%__2.0__' and matched no DM at all.
  `)
  // Bound in the order the placeholders appear: the read-position join, the
  // THREAD read-position join, the author test, the clear mark, the membership
  // test, then the two DM name patterns. Every addition shifts the ones after
  // it along, which is why they are listed here rather than counted by eye.
  .all(req.user.id, req.user.id, req.user.id, req.user.id, req.user.id,
       String(req.user.id), String(req.user.id));
  const counts = {};
  rows.forEach(r => { counts[r.room_id] = r.cnt; });
  res.json(counts);
});

// ── WebRTC calls: ICE server config ──────────────────────────────────────────
// STUN is always available; add a TURN server via env for reliability on
// restrictive networks: TURN_URL, TURN_USERNAME, TURN_PASSWORD.
app.get('/ice-config', authMiddleware, (req, res) => {
  const ice = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
  if (process.env.TURN_URL && process.env.TURN_USERNAME && process.env.TURN_PASSWORD) {
    ice.push({
      // UDP first; TCP fallback rescues networks that block/throttle UDP
      // (a common cause of 'connection failed' on video calls).
      urls: [process.env.TURN_URL, process.env.TURN_URL + '?transport=tcp'],
      username: process.env.TURN_USERNAME,
      credential: process.env.TURN_PASSWORD,
    });
  }
  res.json({ iceServers: ice });
});

// ── End-to-end encryption key storage ────────────────────────────────────────
// The private key blob is encrypted client-side with a password-derived key;
// the server only ever stores/relays opaque strings.
app.post('/keys', authMiddleware, (req, res) => {
  const { publicKey, encPriv, force } = req.body;
  if (!publicKey || !encPriv) return res.status(400).json({ error: 'publicKey and encPriv required' });
  const existing = db.prepare('SELECT public_key FROM users WHERE id = ?').get(req.user.id);
  // The public key is WRITE-ONCE. A reinstalled/new device that generates a
  // different keypair must never clobber the published one, or every message
  // peers encrypted to the original key becomes permanently undecryptable.
  // Once a key exists we only ever update the password-wrapped private blob
  // (re-wrap). A genuine reset requires an explicit force flag AND the same
  // public key — anything else is rejected.
  if (existing?.public_key && existing.public_key !== String(publicKey) && !force) {
    // Keep the original public key; still allow the encPriv to be refreshed
    // only if it belongs to the SAME key (can't verify here, so ignore it).
    return res.status(409).json({ error: 'public_key_exists', publicKey: existing.public_key });
  }
  db.prepare('UPDATE users SET public_key = ?, enc_priv = ? WHERE id = ?')
    .run(String(publicKey), JSON.stringify(encPriv), req.user.id);
  res.json({ ok: true });
});
// Re-wrap only: update the password-encrypted private blob without touching
// the published public key (used on password change).
app.post('/keys/rewrap', authMiddleware, (req, res) => {
  const { encPriv } = req.body;
  if (!encPriv) return res.status(400).json({ error: 'encPriv required' });
  db.prepare('UPDATE users SET enc_priv = ? WHERE id = ?')
    .run(JSON.stringify(encPriv), req.user.id);
  res.json({ ok: true });
});
app.get('/keys/me', authMiddleware, (req, res) => {
  const u = db.prepare('SELECT public_key, enc_priv FROM users WHERE id = ?').get(req.user.id);
  res.json({ publicKey: u?.public_key || null, encPriv: u?.enc_priv ? JSON.parse(u.enc_priv) : null });
});
// Public key of the OTHER participant of a DM room (for E2E encryption)
app.get('/dm-peer-key/:roomId', authMiddleware, (req, res) => {
  const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(req.params.roomId);
  if (!room || !room.is_dm || !canAccessRoom(req.user.id, room)) {
    return res.status(404).json({ error: 'Not found' });
  }
  const otherId = getRoomMemberIds(room).find(id => id !== req.user.id);
  const u = otherId ? db.prepare('SELECT public_key FROM users WHERE id = ?').get(otherId) : null;
  res.json({ userId: otherId || null, publicKey: u?.public_key || null });
});
app.get('/keys/:userId', authMiddleware, (req, res) => {
  const u = db.prepare('SELECT public_key FROM users WHERE id = ?').get(req.params.userId);
  res.json({ publicKey: u?.public_key || null });
});

/**
 * May this viewer keep a copy of this message's media on their device?
 *
 * The same two rules the app applies to copying, downloading and sharing —
 * stated here as well so the media browser gets an authoritative answer for
 * history it has not loaded as messages:
 *
 *  • A DISAPPEARING message must not be kept. A cached photo that outlives
 *    the message it came from defeats the entire feature.
 *  • In a PRIVATE room, only the author may keep their own content.
 */
function mayKeepContent(msg, room, viewerId) {
  if (msg.disappear_seconds) return false;
  if (room.is_private && msg.user_id !== viewerId) return false;
  return true;
}

// How many photos one page of the gallery grid holds. Enough to fill a few
// screens of a 3-column grid without the first paint waiting on the last one.
const MEDIA_PAGE = 90;

const LINK_RE = /(https?:\/\/[^\s]+|(?:[a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}(?:\/[^\s]*)?)/g;

/**
 * Files, audio and links — the three small tabs, sent whole.
 *
 * They are capped at 200 each and read from the rows that can actually hold
 * them, so unlike the photo list there is nothing here worth paging.
 */
function collectOther(room, viewerId) {
  const vis = visibleMessagesSql(viewerId, room.id, 'messages');
  const rows = db.prepare(`
    SELECT id, type, content, file_path, file_name, user_id, disappear_seconds
    FROM messages
    WHERE room_id = ? ${vis} AND one_time_seconds IS NULL
      AND (type IN ('video','file','music') OR type = 'text')
    ORDER BY id DESC LIMIT 5000
  `).all(room.id);
  const files = [], music = [], links = [];
  rows.forEach(m => {
    const keep = mayKeepContent(m, room, viewerId);
    if (m.type === 'video' && m.file_path) {
      files.push({ url: signPath(m.file_path), name: m.file_name || 'Video', msgId: m.id, kind: 'video', cacheable: keep });
    } else if (m.type === 'file' && m.file_path) {
      files.push({ url: signPath(m.file_path), name: m.file_name || 'File', msgId: m.id, kind: 'file', cacheable: keep });
    } else if (m.type === 'music' && m.file_path) {
      music.push({ url: signPath(m.file_path), name: m.file_name || 'Audio', msgId: m.id, kind: 'music', cacheable: keep });
    } else if (m.type === 'text' && m.content && !m.content.startsWith('e2e:')) {
      (m.content.match(LINK_RE) || []).forEach(l => {
        if (links.length < 200 && !links.some(x => x.url === l)) links.push({ url: l, msgId: m.id });
      });
    }
  });
  return { files: files.slice(0, 200), music: music.slice(0, 200), links };
}

/** Every image a message contributes, appended to `out`. */
function collectImages(out, m, room, viewerId) {
  const keep = mayKeepContent(m, room, viewerId);
  if (m.type === 'image' && m.file_path) {
    out.push({ url: signPath(m.file_path), msgId: m.id, name: m.file_name || 'Photo', cacheable: keep });
  } else if (m.type === 'gallery' && m.file_path) {
    // One message, several photos: they all belong to the same message, so
    // "Show in chat" from any of them lands on it.
    try {
      JSON.parse(m.file_path).forEach(u =>
        out.push({ url: signPath(u), msgId: m.id, name: m.file_name || 'Photo', cacheable: keep }));
    } catch {}
  }
}

// Shared media of a room, categorized for the media browser tabs.
//
// Two shapes, chosen by the caller:
//
//  • `?v=2` — photos come one page at a time. Opening the gallery used to mean
//    scanning five thousand messages and sending back up to two thousand photo
//    entries before anything could be drawn, every single time. A page is a
//    page: the grid draws immediately and asks for more as it is scrolled.
//  • no `v` — the whole lot, as before. Versions of the app that are already
//    installed ask this way and must keep getting what they expect.
//
// `?before=<messageId>` (with v=2) asks only for the next page of photos.
app.get('/room-media/:roomId', authMiddleware, (req, res) => {
  const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(req.params.roomId);
  if (!room || !canAccessRoom(req.user.id, room)) return res.status(404).json({ error: 'Not found' });

  if (req.query.v === '2') {
    const before = parseInt(req.query.before, 10) || 0;
    const vis = visibleMessagesSql(req.user.id, room.id, 'messages');
    const imgRows = db.prepare(`
      SELECT id, type, file_path, file_name, user_id, disappear_seconds
      FROM messages
      WHERE room_id = ? ${vis} AND one_time_seconds IS NULL
        AND type IN ('image','gallery') AND file_path IS NOT NULL
        ${before ? 'AND id < ?' : ''}
      ORDER BY id DESC LIMIT ?
    `).all(...(before ? [room.id, before, MEDIA_PAGE] : [room.id, MEDIA_PAGE]));
    const images = [];
    imgRows.forEach(m => collectImages(images, m, room, req.user.id));
    // Paged by MESSAGE, so a gallery message is never split across a page
    // boundary — the cursor is a message id and every photo of that message is
    // already on this side of it.
    const page = {
      images,
      imagesCursor: imgRows.length ? imgRows[imgRows.length - 1].id : null,
      imagesHasMore: imgRows.length === MEDIA_PAGE,
    };
    // A follow-on page is photos only; the other tabs were sent with the first.
    if (before) return res.json(page);

    const rest = collectOther(room, req.user.id);
    return res.json({ ...page, ...rest });
  }

  // The unpaged shape, for app versions already in people's hands. Every item
  // carries the id of the message it came from, so the browser can offer
  // "Show in chat" and jump straight to it.
  const legacyVis = visibleMessagesSql(req.user.id, room.id, 'messages');
  const imgRows = db.prepare(`
    SELECT id, type, file_path, file_name, user_id, disappear_seconds
    FROM messages
    WHERE room_id = ? ${legacyVis} AND one_time_seconds IS NULL
      AND type IN ('image','gallery') AND file_path IS NOT NULL
    ORDER BY id DESC LIMIT 5000
  `).all(room.id);
  const images = [];
  imgRows.forEach(m => collectImages(images, m, room, req.user.id));
  res.json({ images: images.slice(0, 2000), ...collectOther(room, req.user.id) });
});

// Read positions of every member of a room, so the client can render
// seen/delivered checkmarks immediately on opening a room.
app.get('/read-receipts/:roomId', authMiddleware, (req, res) => {
  const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(req.params.roomId);
  if (!room || !canAccessRoom(req.user.id, room)) return res.status(404).json({ error: 'Room not found' });
  const rows = db.prepare('SELECT user_id, last_read_msg_id FROM room_reads WHERE room_id = ? AND user_id != ?')
    .all(room.id, req.user.id);
  res.json(rows.reduce((acc, r) => { acc[r.user_id] = r.last_read_msg_id; return acc; }, {}));
});

/**
 * Where this user had read up to in this room.
 *
 * Asked for as: take me to where those unread messages are. A chat that opens
 * at the bottom and quietly marks everything read is fine when one message
 * arrived and useless when thirty did — the reader has to find the seam by
 * scrolling and guessing. The clients read this BEFORE marking the room read,
 * so the position survives being consumed.
 */
app.get('/read-position/:roomId', authMiddleware, (req, res) => {
  const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(req.params.roomId);
  if (!room || !canAccessRoom(req.user.id, room)) return res.status(404).json({ error: 'Room not found' });
  const row = db.prepare('SELECT last_read_msg_id FROM room_reads WHERE room_id = ? AND user_id = ?')
    .get(room.id, req.user.id);
  res.json({ lastReadId: row ? (row.last_read_msg_id || 0) : 0 });
});

// ── Blocking, muting, and clearing ───────────────────────────────────────────

/** The two user ids in a DM room, or null for anything else. */
function dmParticipants(room) {
  if (!room || !room.is_dm) return null;
  const parts = String(room.name).split('__').filter(Boolean);
  if (parts.length !== 3) return null;
  const a = parseInt(parts[1], 10), b = parseInt(parts[2], 10);
  return isFinite(a) && isFinite(b) ? [a, b] : null;
}

/** The other person in a DM, from one participant's point of view. */
function dmPeerId(room, userId) {
  const p = dmParticipants(room);
  if (!p) return null;
  if (p[0] === userId) return p[1];
  if (p[1] === userId) return p[0];
  return null;
}

/** Has `targetId` blocked `senderId` from reaching them? */
function hasBlocked(targetId, senderId) {
  if (!targetId || !senderId) return false;
  return !!db.prepare('SELECT 1 FROM user_blocks WHERE blocker_id = ? AND blocked_id = ?')
    .get(targetId, senderId);
}

function hasMuted(userId, otherId) {
  if (!userId || !otherId) return false;
  return !!db.prepare('SELECT 1 FROM user_mutes WHERE user_id = ? AND muted_id = ?')
    .get(userId, otherId);
}

/**
 * The last message this user has cleared away in this room.
 *
 * Everything at or below it is hidden from them. Returns 0 when they have
 * never cleared anything, which makes `m.id > 0` a no-op filter — so every
 * read path can apply it unconditionally rather than remembering to.
 */
/**
 * The SQL every read of a room's messages has to carry.
 *
 * Two rules, one fragment, because they are forgotten in the same way: a query
 * that misses this shows somebody history they cleared, or a message from
 * somebody they blocked. Returned as text rather than parameters so it can be
 * dropped into queries whose placeholder order is already load-bearing.
 *
 * Both numbers come from our own database as integers, never from the client.
 */
function visibleMessagesSql(userId, roomId, alias = 'm', opts = {}) {
  const floor = Number(clearedUpto(userId, roomId)) || 0;
  const me = Number(userId) || 0;
  // Comments are messages, and every list of messages in this file goes
  // through here — so this ONE line is what keeps them out of the chat, the
  // search results, the media tabs and the unread counts. Doing it per query
  // would mean remembering it in nine places and forgetting it in one.
  const own = opts.includeComments ? '' : ` AND ${alias}.parent_id IS NULL`;
  // "Delete for me", applied in the same one place and for the same reason.
  //
  // A message somebody else sent can be removed from THIS user's copy of the
  // chat without touching anybody else's — see the hidden_messages table. It
  // has to disappear from every list, not just the message list: leaving it in
  // the media tab, the search results or the unread count would be a message
  // the user deleted still telling them about itself.
  const hidden =
    ` AND ${alias}.id NOT IN (SELECT message_id FROM hidden_messages WHERE user_id = ${me})`;
  return `AND ${alias}.id > ${floor} AND (${alias}.blocked_delivery = 0 OR ${alias}.user_id = ${me})${own}${hidden}`;
}

/**
 * The same rule as a bare condition, for the three unread counts that build
 * their SQL by hand rather than going through visibleMessagesSql.
 *
 * `alias` is the messages table's alias in the query it is pasted into.
 */
function notHiddenSql(userId, alias = 'm') {
  const me = Number(userId) || 0;
  return `AND ${alias}.id NOT IN (SELECT message_id FROM hidden_messages WHERE user_id = ${me})`;
}

/**
 * How many comments a message has, as a column.
 *
 * A correlated subquery rather than a join: a join would multiply the message
 * rows and every list here would need a GROUP BY it does not currently have.
 * `idx_messages_parent` makes it a lookup.
 */
const COMMENT_COUNT_SQL =
  '(SELECT COUNT(*) FROM messages c WHERE c.parent_id = m.id) AS comment_count';

function clearedUpto(userId, roomId) {
  const row = db.prepare('SELECT cleared_upto_id FROM room_clears WHERE user_id = ? AND room_id = ?')
    .get(userId, roomId);
  return row ? (row.cleared_upto_id || 0) : 0;
}

function canAccessRoom(userId, room) {
  if (!room) return false;
  if (room.is_dm) {
    const parts = room.name.split('__').filter(Boolean);
    return parts.length === 3 && (parseInt(parts[1]) === userId || parseInt(parts[2]) === userId);
  }
  if (!room.is_private) return true;
  if (room.created_by === userId) return true;
  return !!db.prepare('SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?').get(room.id, userId);
}

// Reading a public room is open to everyone; WRITING to it is not. Posting,
// reacting and inviting all require membership, so a passer-by reading a room
// they found by search or link cannot contribute to it until they join.
function isRoomMember(userId, room) {
  if (!room) return false;
  if (room.is_dm) return canAccessRoom(userId, room);
  if (room.created_by === userId) return true;
  return !!db.prepare('SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?').get(room.id, userId);
}

// Search users and public rooms by name
app.get('/search', authMiddleware, (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.json({ users: [], rooms: [] });
  const like = '%' + q.replace(/[%_]/g, '') + '%';
  const users = db.prepare(
    'SELECT id, username, avatar FROM users WHERE username LIKE ? AND id != ? ORDER BY username LIMIT 10'
  ).all(like, req.user.id);
  const rooms = db.prepare(
    'SELECT id, name, is_private FROM rooms WHERE is_dm = 0 AND is_private = 0 AND name LIKE ? ORDER BY name LIMIT 10'
  ).all(like);
  res.json({ users, rooms });
});

// Room info (for link joining + room profile)
// The disappearing-messages setting for any chat, DMs included. /room-info is
// rooms-only, and a DM needs this just as much.
app.get('/room-settings/:roomId', authMiddleware, (req, res) => {
  const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(req.params.roomId);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (!canAccessRoom(req.user.id, room)) return res.status(403).json({ error: 'No access' });
  res.json({
    disappearingSeconds: room.disappearing_seconds || 0,
    oneTimeAllowed: !room.one_time_off,
  });
});

app.get('/room-info/:roomId', authMiddleware, (req, res) => {
  const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(req.params.roomId);
  if (!room || room.is_dm) return res.status(404).json({ error: 'Room not found' });
  if (room.is_private && !canAccessRoom(req.user.id, room)) {
    return res.status(403).json({ error: 'This room is private' });
  }
  const owner = room.created_by
    ? db.prepare('SELECT id, username, avatar FROM users WHERE id = ?').get(room.created_by)
    : null;
  const disappearingSeconds = room.disappearing_seconds || 0;
  // Private rooms: explicit member list. Public rooms: everyone who has posted.
  let members = [];
  if (room.is_private) {
    members = db.prepare(`
      SELECT u.id, u.username, u.avatar FROM room_members rm
      JOIN users u ON u.id = rm.user_id
      WHERE rm.room_id = ? ORDER BY u.username
    `).all(room.id);
  } else {
    members = db.prepare(`
      SELECT DISTINCT u.id, u.username, u.avatar FROM messages m
      JOIN users u ON u.id = m.user_id
      WHERE m.room_id = ? ORDER BY u.username
    `).all(room.id);
  }
  if (owner && !members.some(m => m.username === owner.username)) {
    members.unshift({ id: owner.id, username: owner.username, avatar: owner.avatar });
  }
  res.json({
    id: room.id, name: room.name, is_private: room.is_private, is_dm: room.is_dm,
    created_by: room.created_by, created_at: room.created_at,
    owner_username: owner ? owner.username : null,
    owner_avatar: owner ? owner.avatar : null,
    is_owner: room.created_by === req.user.id,
    // Public rooms are readable by anyone, but membership is still explicit —
    // the client shows a Join button while this is false.
    is_member: room.created_by === req.user.id || !!db.prepare(
      'SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?'
    ).get(room.id, req.user.id),
    disappearingSeconds,
    members,
  });
});

// Users list (for DMs)
app.get('/users', authMiddleware, (req, res) => {
  const users = db.prepare('SELECT id, username, avatar FROM users WHERE id != ? ORDER BY username').all(req.user.id);
  res.json(users);
});

// DM rooms
app.post('/dm/:userId', authMiddleware, (req, res) => {
  const myId = req.user.id;
  const otherId = parseInt(req.params.userId);
  if (!otherId || otherId === myId) return res.status(400).json({ error: 'Invalid user' });

  const other = db.prepare('SELECT id, username FROM users WHERE id = ?').get(otherId);
  if (!other) return res.status(404).json({ error: 'User not found' });

  const a = Math.min(myId, otherId);
  const b = Math.max(myId, otherId);
  const dmName = `__dm__${a}__${b}__`;

  let room = db.prepare('SELECT * FROM rooms WHERE name = ?').get(dmName);
  if (!room) {
    const result = db.prepare('INSERT INTO rooms (name, created_by, is_dm) VALUES (?, ?, 1)').run(dmName, myId);
    room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(result.lastInsertRowid);
  }

  res.json({ ...room, otherUsername: other.username });
});

// ── One person's view of another ─────────────────────────────────────────────

app.get('/user-profile/:username', authMiddleware, (req, res) => {
  const other = db.prepare('SELECT id, username, avatar, created_at FROM users WHERE username = ?')
    .get(String(req.params.username || ''));
  if (!other) return res.status(404).json({ error: 'User not found' });
  const dmName = `__dm__${Math.min(req.user.id, other.id)}__${Math.max(req.user.id, other.id)}__`;
  const dm = db.prepare('SELECT id FROM rooms WHERE name = ?').get(dmName);
  res.json({
    id: other.id,
    username: other.username,
    avatar: other.avatar || null,
    created_at: other.created_at,
    isSelf: other.id === req.user.id,
    // Both are MY settings about them, never theirs about me: whether someone
    // has blocked you is not something you get to ask the server.
    muted: hasMuted(req.user.id, other.id),
    blocked: hasBlocked(req.user.id, other.id),
    dmRoomId: dm ? dm.id : null,
  });
});

/** Block or unblock, mute or unmute. `on` decides which. */
function setPeerFlag(table, cols) {
  return (req, res) => {
    const otherId = parseInt(req.params.userId, 10);
    if (!otherId || otherId === req.user.id) return res.status(400).json({ error: 'Invalid user' });
    if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(otherId)) {
      return res.status(404).json({ error: 'User not found' });
    }
    const on = req.method === 'POST';
    if (on) {
      db.prepare(`INSERT OR IGNORE INTO ${table} (${cols[0]}, ${cols[1]}) VALUES (?, ?)`)
        .run(req.user.id, otherId);
    } else {
      db.prepare(`DELETE FROM ${table} WHERE ${cols[0]} = ? AND ${cols[1]} = ?`)
        .run(req.user.id, otherId);
    }
    res.json({ ok: true, on });
  };
}

app.post('/block/:userId', authMiddleware, setPeerFlag('user_blocks', ['blocker_id', 'blocked_id']));
app.delete('/block/:userId', authMiddleware, setPeerFlag('user_blocks', ['blocker_id', 'blocked_id']));
app.post('/mute/:userId', authMiddleware, setPeerFlag('user_mutes', ['user_id', 'muted_id']));
app.delete('/mute/:userId', authMiddleware, setPeerFlag('user_mutes', ['user_id', 'muted_id']));

/**
 * Clear a conversation.
 *
 * `scope: 'me'` records a high-water mark and deletes nothing. The other
 * person's copy is theirs; a chat app that let one side reach into the other's
 * history by default would be worth nobody's trust.
 *
 * `scope: 'both'` really does delete, and is therefore only offered in a DM —
 * between two people it is a decision they can undo by talking again, whereas
 * in a group it would be one member destroying everyone else's record of a
 * conversation they were all part of.
 */
app.post('/clear-history/:roomId', authMiddleware, (req, res) => {
  const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(req.params.roomId);
  if (!room || !canAccessRoom(req.user.id, room)) return res.status(404).json({ error: 'Not found' });
  const scope = req.body?.scope === 'both' ? 'both' : 'me';

  const top = db.prepare('SELECT MAX(id) AS id FROM messages WHERE room_id = ?').get(room.id);
  const upto = top?.id || 0;

  if (scope === 'both') {
    if (!room.is_dm) return res.status(400).json({ error: 'Only a direct chat can be cleared for both' });
    const rows = db.prepare('SELECT id, file_path FROM messages WHERE room_id = ? AND id <= ?')
      .all(room.id, upto);
    db.prepare('DELETE FROM messages WHERE room_id = ? AND id <= ?').run(room.id, upto);
    db.prepare('DELETE FROM reactions WHERE message_id IN (SELECT id FROM messages WHERE room_id = ?)')
      .run(room.id);
    // The other side is told so their screen empties too, rather than showing
    // messages that no longer exist until they next reload.
    io.to('room:' + room.id).emit('history_cleared', { roomId: room.id, uptoId: upto, scope: 'both' });
    const peer = dmPeerId(room, req.user.id);
    if (peer) io.to('user:' + peer).emit('history_cleared', { roomId: room.id, uptoId: upto, scope: 'both' });
    io.to('user:' + req.user.id).emit('history_cleared', { roomId: room.id, uptoId: upto, scope: 'both' });
    return res.json({ ok: true, scope, uptoId: upto, removed: rows.length });
  }

  db.prepare(`
    INSERT INTO room_clears (user_id, room_id, cleared_upto_id) VALUES (?, ?, ?)
    ON CONFLICT(user_id, room_id) DO UPDATE SET cleared_upto_id = MAX(cleared_upto_id, excluded.cleared_upto_id)
  `).run(req.user.id, room.id, upto);
  io.to('user:' + req.user.id).emit('history_cleared', { roomId: room.id, uptoId: upto, scope: 'me' });
  res.json({ ok: true, scope, uptoId: upto });
});

app.get('/dm-rooms', authMiddleware, (req, res) => {
  // Return DM rooms the current user is part of (name format: __dm__{a}__{b}__)
  const myId = req.user.id;
  const dmRooms = db.prepare(`
    SELECT * FROM rooms
    WHERE is_dm = 1
      AND EXISTS (SELECT 1 FROM messages m WHERE m.room_id = rooms.id)
  `).all();

  const rooms = [];
  for (const room of dmRooms) {
    const parts = room.name.split('__').filter(Boolean); // ['dm', 'a', 'b']
    if (parts.length !== 3) continue;
    const a = parseInt(parts[1]);
    const b = parseInt(parts[2]);
    if (a !== myId && b !== myId) continue;
    const otherId = a === myId ? b : a;
    const other = db.prepare('SELECT username, avatar FROM users WHERE id = ?').get(otherId);
    if (!other) continue;
    // Clearing a chat takes it off the list, not just out of the chat. It
    // comes back on its own the moment either side says something new, since
    // that message has a higher id than the mark — which is the behaviour
    // people expect from a chat list and the reason this is a mark rather
    // than a hidden flag anyone would have to remember to unset.
    const vis = visibleMessagesSql(myId, room.id, 'messages');
    // The chat's PLACE in the list is about activity, and a comment is
    // activity — asked for as: a chat should move up when a comment is added
    // to it. `vis` alone hides comments (that is its job everywhere else), so
    // a chat whose only new thing was a comment sank as if nothing had
    // happened. The list's existence test stays on visible messages: a chat
    // has to have a conversation before it can have a thread.
    const order = visibleMessagesSql(myId, room.id, 'messages', { includeComments: true });
    const last = db.prepare(`SELECT MAX(id) AS id FROM messages WHERE room_id = ? ${vis}`)
      .get(room.id);
    const active = db.prepare(`SELECT MAX(id) AS id FROM messages WHERE room_id = ? ${order}`)
      .get(room.id);
    if (!last || !last.id) continue;
    rooms.push({
      ...room,
      other_username: other.username,
      other_avatar: other.avatar || null,
      last_msg_id: last.id,
      // What the list is SORTED by: the newest thing that happened here,
      // comments included.
      last_activity_id: (active && active.id) || last.id,
    });
  }
  // Most recently active DM first (was: newest-created, which never reordered
  // as conversations went back and forth).
  rooms.sort((x, y) => (y.last_activity_id || 0) - (x.last_activity_id || 0));
  res.json(rooms);
});

// Messages (paginated: most recent page by default, or the page before
// `before` (a message id) for infinite-scroll-up loading of older history)
const MESSAGES_PAGE_SIZE = 20;
// Text search within one chat.
//
// Server-side so it covers the WHOLE history, not just what a client happens
// to have loaded — searching only the last 50 messages would be worse than no
// search at all.
//
// End-to-end encrypted DM messages are stored as ciphertext, so they cannot be
// matched here and are excluded rather than silently returning nothing useful;
// the client says so instead of pretending the chat has no matches.
app.get('/search-messages/:roomId', authMiddleware, (req, res) => {
  const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(req.params.roomId);
  if (!canAccessRoom(req.user.id, room)) return res.status(403).json({ error: 'No access' });
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json({ results: [], encryptedSkipped: 0 });

  // LIKE with the wildcards escaped, so a search for "100%" or "a_b" looks for
  // those characters rather than matching everything.
  const pattern = '%' + q.replace(/[#%_]/g, c => '#' + c) + '%';
  // Cleared history is not searchable history. A message the user has cleared
  // away must not come back through a search box.
  const vis = visibleMessagesSql(req.user.id, room.id);
  const rows = db.prepare(`
    SELECT m.id, m.content, m.created_at, m.user_id, u.username, u.avatar
    FROM messages m
    JOIN users u ON m.user_id = u.id
    WHERE m.room_id = ?
      ${vis}
      AND m.type = 'text'
      AND m.content IS NOT NULL
      AND m.content NOT LIKE 'e2e:%'
      AND m.content LIKE ? ESCAPE '#'
    ORDER BY m.id DESC
    LIMIT 500
  `).all(room.id, pattern);

  // How much of this chat could not be searched, so the client can say so.
  const encryptedSkipped = db.prepare(
    `SELECT COUNT(*) c FROM messages m WHERE room_id = ? ${vis} AND type = 'text' AND content LIKE 'e2e:%'`
  ).get(room.id).c;

  res.json({ results: rows, encryptedSkipped });
});

// The encrypted messages of a chat, so the DEVICE can search them.
//
// The server cannot search these and never will: it holds ciphertext and no
// key. But it can hand them over — the caller is already entitled to read this
// room, and this is the same ciphertext /messages returns. The device decrypts
// in memory and matches locally, so no plaintext and no search term ever
// reaches the server.
//
// This is the same division of labour Telegram uses for Secret Chats and Signal
// uses for everything: either the server can read the text and can therefore
// index it, or the device does the work. There is no third option.
app.get('/encrypted-messages/:roomId', authMiddleware, (req, res) => {
  const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(req.params.roomId);
  if (!canAccessRoom(req.user.id, room)) return res.status(403).json({ error: 'No access' });

  // Capped. Handing over an unbounded history would turn a search into a
  // multi-megabyte download on a connection that cannot afford it.
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 2000, 1), 5000);
  const vis = visibleMessagesSql(req.user.id, room.id);
  const rows = db.prepare(`
    SELECT m.id, m.content, m.created_at, m.user_id, u.username, u.avatar
    FROM messages m
    JOIN users u ON m.user_id = u.id
    WHERE m.room_id = ?
      ${vis}
      AND m.type = 'text'
      AND m.content LIKE 'e2e:%'
    ORDER BY m.id DESC
    LIMIT ?
  `).all(room.id, limit);

  // The total, so the client can say when it is searching only part of a very
  // long history rather than quietly searching less than the user thinks.
  const total = db.prepare(
    `SELECT COUNT(*) c FROM messages m WHERE room_id = ? ${vis} AND type = 'text' AND content LIKE 'e2e:%'`
  ).get(room.id).c;

  res.json({ messages: rows, total });
});

/**
 * One message's comments, and the message itself.
 *
 * The parent comes back with them because the screen is headed by it: a
 * comments view that opened on a bare list, with no sight of what was being
 * commented on, would be unreadable — and fetching it separately would be a
 * second round trip for a screen that is already one tap deep.
 *
 * `includeComments` is the opt-out from the rule that keeps comments out of
 * every other list. This is the one place they ARE the list.
 */
app.get('/comments/:roomId/:msgId', authMiddleware, (req, res) => {
  const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(req.params.roomId);
  if (!canAccessRoom(req.user.id, room)) return res.status(403).json({ error: 'No access' });

  const vis = visibleMessagesSql(req.user.id, room.id, 'm', { includeComments: true });
  const parent = db.prepare(`
    SELECT m.*, u.username, u.avatar, ${COMMENT_COUNT_SQL}
    FROM messages m JOIN users u ON m.user_id = u.id
    WHERE m.id = ? AND m.room_id = ? ${vis}
  `).get(req.params.msgId, room.id);
  // Gone, or cleared away by this user: the thread goes with it rather than
  // being shown headless.
  if (!parent) return res.status(404).json({ error: 'That message is no longer here' });

  const comments = db.prepare(`
    SELECT m.*, u.username, u.avatar,
      rm.content AS reply_content, rm.type AS reply_type, rm.file_name AS reply_file_name,
      ru.username AS reply_username
    FROM messages m
    JOIN users u ON m.user_id = u.id
    LEFT JOIN messages rm ON m.reply_to_id = rm.id
    LEFT JOIN users ru ON rm.user_id = ru.id
    WHERE m.parent_id = ? ${vis}
    ORDER BY m.id ASC
  `).all(req.params.msgId);

  res.json({ parent: signMessage(parent), comments: comments.map(signMessage) });
});

// Messages AROUND one particular message.
//
// "Show in chat" used to work by paging backwards from the newest message
// until the target turned up. For a photo from months ago that is dozens of
// round trips, and it appeared to do nothing at all — which is exactly what a
// long silent loop looks like. This fetches the target and its neighbours in
// ONE request, so jumping to an old message costs the same as jumping to a
// recent one.
app.get('/message-context/:roomId/:msgId', authMiddleware, (req, res) => {
  const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(req.params.roomId);
  if (!canAccessRoom(req.user.id, room)) return res.status(403).json({ error: 'No access' });
  const msgId = parseInt(req.params.msgId, 10);
  if (!Number.isInteger(msgId)) return res.status(400).json({ error: 'Bad message id' });

  const vis = visibleMessagesSql(req.user.id, room.id);
  const target = db.prepare(`SELECT id FROM messages m WHERE id = ? AND room_id = ? ${vis}`)
    .get(msgId, room.id);
  // Gone (deleted, expired, or never in this room) — say so rather than
  // returning an empty window the client cannot tell apart from a slow load.
  if (!target) return res.status(404).json({ error: 'That message is no longer here' });

  const HALF = Math.floor(MESSAGES_PAGE_SIZE / 2);
  const sql = (cmp, order) => `
    SELECT m.*, u.username, u.avatar,
      rm.content AS reply_content, rm.type AS reply_type, rm.file_name AS reply_file_name,
      ru.username AS reply_username
    FROM messages m
    JOIN users u ON m.user_id = u.id
    LEFT JOIN messages rm ON m.reply_to_id = rm.id
    LEFT JOIN users ru ON rm.user_id = ru.id
    WHERE m.room_id = ? AND m.id ${cmp} ? ${vis}
    ORDER BY m.id ${order} LIMIT ?`;

  const older = db.prepare(sql('<=', 'DESC')).all(room.id, msgId, HALF + 1);
  const newer = db.prepare(sql('>', 'ASC')).all(room.id, msgId, HALF + 1);
  // One row past the window in each direction, purely to answer "is there
  // more?", then dropped. Without hasNewer the client cannot tell a jump into
  // the middle of a chat from a jump that happens to land near the end, and it
  // treated both as "everything after this is already loaded".
  const hasOlder = older.length > HALF;
  const hasNewer = newer.length > HALF;
  const messages = [
    ...older.slice(0, HALF + 1).reverse(),
    ...newer.slice(0, HALF),
  ].map(signMessage);
  res.json({ messages, targetId: msgId, hasOlder, hasNewer });
});

app.get('/messages/:roomId', authMiddleware, (req, res) => {
  const roomRow = db.prepare('SELECT * FROM rooms WHERE id = ?').get(req.params.roomId);
  if (!canAccessRoom(req.user.id, roomRow)) return res.status(403).json({ error: 'Not a member of this room' });
  const before = parseInt(req.query.before);
  const after = parseInt(req.query.after);
  // Everything this user has cleared away in this room stays away, on every
  // one of the three paths below. 0 when nothing was cleared, which makes
  // `m.id > 0` a filter that costs nothing and can be applied unconditionally
  // — far safer than remembering which branch needs it.
  const vis = visibleMessagesSql(req.user.id, roomRow.id);

  // Paged by id, not by created_at.
  //
  // created_at has one-second resolution, so a burst of messages — forwarding
  // several at once, or any busy moment — all carry the same timestamp and
  // SQLite is free to order them however it likes. The page boundary then falls
  // in an arbitrary place inside that burst, and "the newest 50" can genuinely
  // omit the newest message while including older ones. Caught by a test that
  // sent 90 messages in one go and found the chat's last message was not its
  // last message.
  //
  // Ids are assigned in order and never tie, so paging on them is stable, and
  // it matches what /message-context and the forward page below already use.

  // Forwards, for a client that jumped into the middle of a chat and is now
  // scrolling back towards the present. Without this the only way to get from
  // an old message to a recent one was to load the whole history between them.
  //
  // Ordered by id ASC — the oldest of the messages that follow, so each page
  // joins directly onto what is already loaded. ORDER BY created_at would put
  // two messages sent in the same second in an order the client cannot predict,
  // and a page boundary in the middle of that pair loses one of them.
  if (after) {
    const rows = db.prepare(`
      SELECT m.*, u.username, u.avatar, ${COMMENT_COUNT_SQL},
        rm.content AS reply_content, rm.type AS reply_type, rm.file_name AS reply_file_name,
        ru.username AS reply_username
      FROM messages m
      JOIN users u ON m.user_id = u.id
      LEFT JOIN messages rm ON m.reply_to_id = rm.id
      LEFT JOIN users ru ON rm.user_id = ru.id
      WHERE m.room_id = ? AND m.id > ? ${vis}
      ORDER BY m.id ASC LIMIT ?
    `).all(req.params.roomId, after, MESSAGES_PAGE_SIZE);
    return res.json(rows.map(signMessage));
  }

  const messages = before
    ? db.prepare(`
        SELECT m.*, u.username, u.avatar, ${COMMENT_COUNT_SQL},
          rm.content AS reply_content, rm.type AS reply_type, rm.file_name AS reply_file_name,
          ru.username AS reply_username
        FROM messages m
        JOIN users u ON m.user_id = u.id
        LEFT JOIN messages rm ON m.reply_to_id = rm.id
        LEFT JOIN users ru ON rm.user_id = ru.id
        WHERE m.room_id = ? AND m.id < ? ${vis}
        ORDER BY m.id DESC LIMIT ?
      `).all(req.params.roomId, before, MESSAGES_PAGE_SIZE)
    : db.prepare(`
        SELECT m.*, u.username, u.avatar, ${COMMENT_COUNT_SQL},
          rm.content AS reply_content, rm.type AS reply_type, rm.file_name AS reply_file_name,
          ru.username AS reply_username
        FROM messages m
        JOIN users u ON m.user_id = u.id
        LEFT JOIN messages rm ON m.reply_to_id = rm.id
        LEFT JOIN users ru ON rm.user_id = ru.id
        WHERE m.room_id = ? ${vis}
        ORDER BY m.id DESC LIMIT ?
      `).all(req.params.roomId, MESSAGES_PAGE_SIZE);
  res.json(messages.reverse().map(signMessage));
});

// Every reaction in a room, keyed by message id. The client had no way to load
// existing reactions when opening a chat — they only arrived via live
// `reactions_updated` events — so every reaction vanished from the UI on
// restart even though it was still in the database.
app.get('/room-reactions/:roomId', authMiddleware, (req, res) => {
  const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(req.params.roomId);
  if (!room || !canAccessRoom(req.user.id, room)) return res.status(404).json({ error: 'Not found' });
  const rows = db.prepare(`
    SELECT r.message_id, r.emoji, r.user_id, u.username
    FROM reactions r
    JOIN users u ON u.id = r.user_id
    JOIN messages m ON m.id = r.message_id
    WHERE m.room_id = ?
  `).all(room.id);
  const byMessage = {};
  rows.forEach(r => {
    (byMessage[r.message_id] = byMessage[r.message_id] || [])
      .push({ emoji: r.emoji, username: r.username, user_id: r.user_id });
  });
  res.json(byMessage);
});

// Reactions
app.get('/reactions/:messageId', authMiddleware, (req, res) => {
  const rows = db.prepare(`
    SELECT r.emoji, u.username, r.user_id FROM reactions r
    JOIN users u ON r.user_id = u.id
    WHERE r.message_id = ?
  `).all(req.params.messageId);
  res.json(rows);
});

// Upload
app.post('/upload', authMiddleware, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  res.json({
    url: '/uploads/' + req.file.filename,
    name: req.file.originalname,
    mimetype: req.file.mimetype
  });
});

// ── Resumable uploads ────────────────────────────────────────────────────────
//
// A whole-file POST cannot be paused and cannot be resumed: a connection that
// drops at 90% of a 60 MB video costs all 60 MB again, and there is no honest
// way to offer a pause button for it. So a file can instead be sent in pieces
// against a SESSION that remembers how many bytes it already holds.
//
// The offset is the size of the partial file on disk, never a number kept in
// memory. That is what makes it survive a server restart, and it is also what
// makes a resumed upload safe: the client is told where the server actually
// got to rather than being trusted about where it thinks it got to.
// Room for a 512 KB chunk plus base64's 33% overhead and a little slack.
const CHUNK_LIMIT_BYTES = 1024 * 1024;
// Inside uploads/ because that is the directory deployments actually keep and
// make writable. It is under the static handler, but everything there needs a
// signature computed from the secret, so a half-finished file is no more
// reachable than a finished one.
const PARTIAL_DIR = path.join('uploads', '.partial');
const PARTIAL_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_UPLOAD_BYTES = 80 * 1024 * 1024;   // same limit as the one-shot POST
try { fs.mkdirSync(PARTIAL_DIR, { recursive: true }); } catch {}

const partPath = id => path.join(PARTIAL_DIR, `${id}.part`);
const metaPath = id => path.join(PARTIAL_DIR, `${id}.json`);
/**
 * What a finished session turned into, kept so that finishing is IDEMPOTENT.
 *
 * Reported as: the upload sometimes hangs at the final stage and the app has
 * to be closed and the file sent again. The clients now time the finish
 * request out and retry it — which is only safe if a second finish for a
 * session that already completed gives the same answer instead of "no such
 * upload". Without this, an upload whose reply was lost on the way back would
 * be reported as failed after the file had actually arrived.
 */
const donePath = id => path.join(PARTIAL_DIR, `${id}.done`);

/**
 * Look up a session, or answer the request with why not.
 *
 * The id is checked against a strict pattern before it is ever joined onto a
 * path: it comes from the client, and "../../etc/something" would otherwise be
 * a perfectly good session id.
 */
function openSession(req, res) {
  const id = String(req.params.id || '');
  if (!/^[a-f0-9]{32}$/.test(id)) { res.status(400).json({ error: 'Bad session' }); return null; }
  let meta;
  try { meta = JSON.parse(fs.readFileSync(metaPath(id), 'utf8')); }
  catch { res.status(404).json({ error: 'No such upload' }); return null; }
  // Sessions belong to the account that opened them. Without this, knowing an
  // id would be enough to append to someone else's upload.
  if (meta.userId !== req.user.id) { res.status(404).json({ error: 'No such upload' }); return null; }
  let offset = 0;
  try { offset = fs.statSync(partPath(id)).size; } catch {}
  return { id, meta, offset };
}

app.post('/upload/session', authMiddleware, (req, res) => {
  const size = parseInt(req.body?.size, 10);
  if (!isFinite(size) || size <= 0) return res.status(400).json({ error: 'Bad size' });
  if (size > MAX_UPLOAD_BYTES) return res.status(413).json({ error: 'File too large' });
  const name = String(req.body?.name || 'file').slice(0, 200);
  const id = crypto.randomBytes(16).toString('hex');
  const meta = {
    userId: req.user.id, name, size,
    mime: String(req.body?.mime || 'application/octet-stream').slice(0, 100),
    createdAt: Date.now(),
  };
  try {
    fs.writeFileSync(metaPath(id), JSON.stringify(meta));
    fs.writeFileSync(partPath(id), '');
  } catch {
    return res.status(500).json({ error: 'Could not start upload' });
  }
  res.json({ id, offset: 0 });
});

// Where the server actually got to. Asked before every resume.
app.get('/upload/session/:id', authMiddleware, (req, res) => {
  const s = openSession(req, res);
  if (!s) return;
  res.json({ id: s.id, offset: s.offset, size: s.meta.size });
});

// One chunk. Raw bytes, or base64 text on devices where handing a binary body
// to the network stack is not available — the server accepts either so the app
// never has to fall back to sending the whole file again.
//
// POST *and* PATCH. POST is what the clients use: there is no semantic need
// for PATCH here, and PATCH with a body is the least well-trodden path through
// a reverse proxy, a WAF or a corporate middlebox — whereas a POST with a body
// is the most ordinary request on the web. PATCH stays because app versions
// already installed use it, and they must keep working.
app.route('/upload/session/:id').post(chunkHandler()).patch(chunkHandler());

function chunkHandler() {
  return [
    authMiddleware,
    express.raw({ type: () => true, limit: CHUNK_LIMIT_BYTES }),
    (req, res) => {
      const s = openSession(req, res);
      if (!s) return;
    const at = parseInt(req.get('x-offset'), 10);
    if (!isFinite(at) || at < 0) return res.status(400).json({ error: 'Bad offset' });
    // Not an error worth failing on: a chunk that was already received, then
    // re-sent because the acknowledgement was lost, is the normal shape of a
    // resume. Tell the client where things actually stand and let it continue.
    if (at !== s.offset) return res.status(409).json({ error: 'Offset mismatch', offset: s.offset });

    let buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (req.get('x-encoding') === 'base64') {
      try { buf = Buffer.from(buf.toString('utf8'), 'base64'); }
      catch { return res.status(400).json({ error: 'Bad chunk' }); }
    }
    if (!buf.length) return res.status(400).json({ error: 'Empty chunk' });
    // A client that keeps sending past the size it declared would otherwise be
    // able to fill the disk one chunk at a time.
    if (s.offset + buf.length > s.meta.size) return res.status(413).json({ error: 'Past end of file' });

      try { fs.appendFileSync(partPath(s.id), buf); }
      catch { return res.status(500).json({ error: 'Write failed' }); }
      res.json({ offset: s.offset + buf.length, size: s.meta.size });
    },
  ];
}

// All bytes in: turn the partial into a real upload.
app.post('/upload/session/:id/finish', authMiddleware, (req, res) => {
  // Already finished, and this is a retry of a reply that never arrived.
  // Answered before openSession, which would say "no such upload" — the meta
  // is gone precisely BECAUSE this worked.
  const rawId = String(req.params.id || '');
  if (/^[a-f0-9]{32}$/.test(rawId)) {
    try {
      const done = JSON.parse(fs.readFileSync(donePath(rawId), 'utf8'));
      if (done && done.userId === req.user.id && done.url) {
        return res.json({ url: done.url, name: done.name, mimetype: done.mimetype });
      }
    } catch {}
  }
  const s = openSession(req, res);
  if (!s) return;
  if (s.offset !== s.meta.size) {
    return res.status(409).json({ error: 'Incomplete', offset: s.offset, size: s.meta.size });
  }
  const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
  const filename = unique + path.extname(s.meta.name);
  try {
    fs.renameSync(partPath(s.id), path.join('uploads', filename));
    fs.unlinkSync(metaPath(s.id));
  } catch {
    return res.status(500).json({ error: 'Could not finish upload' });
  }
  // Written AFTER the rename and before replying, so a retry that overtakes a
  // lost reply finds the same answer. Swept by the reaper with the partials.
  try {
    fs.writeFileSync(donePath(s.id), JSON.stringify({
      userId: req.user.id,
      url: '/uploads/' + filename,
      name: s.meta.name,
      mimetype: s.meta.mime,
      at: Date.now(),
    }));
  } catch {}
  // Deliberately the same shape as POST /upload, so the two paths are
  // interchangeable to everything downstream.
  res.json({ url: '/uploads/' + filename, name: s.meta.name, mimetype: s.meta.mime });
});

// Given up on. Dropping the bytes now rather than waiting for the reaper.
app.delete('/upload/session/:id', authMiddleware, (req, res) => {
  const s = openSession(req, res);
  if (!s) return;
  try { fs.unlinkSync(partPath(s.id)); } catch {}
  try { fs.unlinkSync(metaPath(s.id)); } catch {}
  res.json({ ok: true });
});

/**
 * Sweep away partials nobody came back for.
 *
 * An upload abandoned by an app that was force-quit leaves bytes on disk with
 * nothing pointing at them. Without this they accumulate forever, and a chat
 * server's disk filling up takes the whole thing down.
 */
function reapPartials() {
  let names;
  try { names = fs.readdirSync(PARTIAL_DIR); } catch { return; }
  const cutoff = Date.now() - PARTIAL_TTL_MS;
  for (const n of names) {
    const f = path.join(PARTIAL_DIR, n);
    try { if (fs.statSync(f).mtimeMs < cutoff) fs.unlinkSync(f); } catch {}
  }
}
reapPartials();
setInterval(reapPartials, 60 * 60 * 1000).unref?.();

// Same reasoning for link previews: every link anybody sends leaves a cover on
// disk, and only the ones still being looked at are worth keeping.
linkMeta.sweep();
setInterval(() => linkMeta.sweep(), 6 * 60 * 60 * 1000).unref?.();

// Shareable room links: /join/<roomId> opens the web app on that room
app.get('/join/:roomId', (req, res) => {
  res.redirect('/?join=' + encodeURIComponent(req.params.roomId));
});

// Socket.IO
const onlineUsers = new Map(); // socketId -> { userId, username, roomId, focused }

/**
 * Tell a room who is in it — a DIFFERENT list per viewer.
 *
 * It used to be one list broadcast to everybody, which is fine until blocking
 * exists. Somebody who has blocked you must not appear online to you: being
 * able to watch when a person is at their phone is exactly the kind of contact
 * blocking is for, and it is the one that leaves no trace.
 *
 * `excludeSocket` is the connection that is leaving, whose own entry has not
 * been updated yet.
 */
/**
 * Emit to everyone in a room EXCEPT people the sender has blocked.
 *
 * Typing and recording indicators are presence by another name: "she is typing
 * right now" says the same thing as a green dot. Hiding one and not the other
 * would leave the blocked person watching the blocker live through a different
 * hole.
 */
/**
 * A live activity — typing, recording, sending — to everyone else in the room.
 *
 * BOTH directions of a block are checked, and only one of them used to be.
 * `hasBlocked(a, b)` reads "a has blocked b", and this tested
 * `hasBlocked(fromUserId, u.userId)` alone: the sender having blocked the
 * viewer. The far more common case — the VIEWER having blocked the sender —
 * fell straight through, so blocking somebody stopped their messages and left
 * you watching them type. Found by a test for "is sending", which inherits
 * this routing; typing and recording have had it the whole time.
 */
function emitToRoomUnblocked(roomId, fromUserId, event, payload) {
  const key = String(roomId);
  for (const [sid, u] of onlineUsers.entries()) {
    if (u.roomId !== key || u.userId === fromUserId) continue;
    if (hasBlocked(fromUserId, u.userId)) continue;   // sender blocked them
    if (hasBlocked(u.userId, fromUserId)) continue;   // they blocked the sender
    io.to(sid).emit(event, payload);
  }
}

function emitRoomOnline(roomId, excludeSocket) {
  const key = String(roomId);
  const present = [...onlineUsers.entries()]
    .filter(([sid, u]) => u.roomId === key && sid !== excludeSocket);
  for (const [sid, viewer] of present) {
    const users = present
      // Yourself always; anyone else only if they have not blocked you.
      .filter(([, u]) => u.userId === viewer.userId || !hasBlocked(u.userId, viewer.userId))
      .map(([, u]) => u.username);
    io.to(sid).emit('room_online', { users });
  }
}
const voiceRooms = new Map(); // roomId -> Map(socketId -> { userId, username })

// Pending 1:1 call offers, so a callee whose app was closed can still receive
// the call when they open it from the push notification. Entries expire.
const pendingCalls = new Map(); // toUserId -> { fromUserId, fromUsername, kind, sdp, candidates: [], ts }
const PENDING_CALL_TTL = 60 * 1000;
function clearPendingCallsBetween(a, b) {
  for (const [to, pc] of pendingCalls) {
    if ((to === a && pc.fromUserId === b) || (to === b && pc.fromUserId === a)) pendingCalls.delete(to);
  }
}

io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  try {
    socket.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    next(new Error('Unauthorized'));
  }
});

// Insert a system message (a join announcement, a member removal, …) into a
// room. `kind` goes in the message content alongside its data so clients can
// render it as a centered notice rather than a normal bubble.
function insertSystemMessage(roomId, userId, kind, data) {
  try {
    const content = JSON.stringify({ kind, ...data });
    const r = db.prepare(
      'INSERT INTO messages (room_id, user_id, type, content) VALUES (?, ?, ?, ?)'
    ).run(roomId, userId, 'system', content);
    return db.prepare(`
      SELECT m.*, u.username, u.avatar FROM messages m
      JOIN users u ON m.user_id = u.id WHERE m.id = ?
    `).get(r.lastInsertRowid);
  } catch (err) {
    console.error('[insertSystemMessage]', err.message);
    return null;
  }
}

// Deliver a message to every member of a room over their personal channels.
function broadcastRoomMessage(room, msg) {
  const out = signMessage(msg);
  const ids = getRoomMemberIds(room);
  ids.forEach(id => io.to('user:' + id).emit('message_received', out));
  previewerIds(room, ids).forEach(id => io.to('user:' + id).emit('message_received', out));
}

// Public rooms can be read before joining, so someone may have the room open
// without being a member. They are in the presence channel but not the member
// list, and would otherwise see a frozen chat until they joined. Returns the
// user ids actively viewing the room that `memberIds` does not already cover.
function previewerIds(room, memberIds) {
  if (room.is_dm || room.is_private) return [];
  const covered = new Set(memberIds);
  const out = new Set();
  onlineUsers.forEach(u => {
    if (u.roomId === String(room.id) && !covered.has(u.userId)) out.add(u.userId);
  });
  return [...out];
}

function getRoomMemberIds(room) {
  if (room.is_dm) {
    const parts = room.name.split('__').filter(Boolean);
    if (parts.length !== 3) return [];
    return [parseInt(parts[1]), parseInt(parts[2])];
  }
  // Public rooms have explicit membership too now, so a room's messages go to
  // the people who joined it — not to every account on the server.
  const ids = db.prepare('SELECT user_id FROM room_members WHERE room_id = ?').all(room.id).map(r => r.user_id);
  if (room.created_by && !ids.includes(room.created_by)) ids.push(room.created_by);
  return ids;
}

io.on('connection', (socket) => {
  // Personal channel so the user receives message events for unread badges
  // even when not actively viewing that room (or before a new DM room exists).
  socket.join('user:' + socket.user.id);

  socket.on('join_room', (roomId) => {
    const prev = onlineUsers.get(socket.id);
    if (prev?.roomId) {
      socket.leave(prev.roomId);
      emitRoomOnline(prev.roomId, socket.id);
    }
    onlineUsers.set(socket.id, {
      userId: socket.user.id, username: socket.user.username, roomId: String(roomId),
      focused: prev ? prev.focused !== false : true,
    });
    socket.join(String(roomId)); // presence room (active room only)
    emitRoomOnline(roomId);
  });

  // Whether this particular connection is in front of the user right now: a
  // hidden browser tab or a backgrounded app reports false. A device that is
  // merely *sitting* on a room is not "reading" it, so without this a laptop
  // with the tab left open would suppress notifications forever.
  socket.on('app_focus', (focused) => {
    const cur = onlineUsers.get(socket.id);
    if (!cur) return;
    onlineUsers.set(socket.id, { ...cur, focused: !!focused });
  });

  // The client emits this when the chat screen backgrounds or unmounts, so a
  // device that isn't actively looking at the room stops counting as "viewing"
  // (and thus starts receiving push again). Presence is updated to roomId null.
  socket.on('leave_room', () => {
    const prev = onlineUsers.get(socket.id);
    if (!prev?.roomId) return;
    socket.leave(prev.roomId);
    onlineUsers.set(socket.id, {
      userId: socket.user.id, username: socket.user.username, roomId: null,
      focused: prev.focused !== false,
    });
    emitRoomOnline(prev.roomId);
  });

  // Message types a CLIENT is allowed to send. 'system'/'call'/'invite' are
  // produced by the server only — letting clients set them would forge join
  // notices, call logs and invitations.
  const CLIENT_MSG_TYPES = new Set(['text', 'image', 'gallery', 'video', 'audio', 'music', 'file', 'location']);

  socket.on('send_message', (data, ack) => {
    const { roomId, type, content, filePath, fileName, replyToId, clientId, oneTimeSeconds, parentId } = data;
    const reply = (r) => { if (typeof ack === 'function') ack(r); };

    // Authorization: you may only post to a room you are a MEMBER of. Without
    // this, any user could inject messages into a private room they're not in
    // — or into a DM between two other people. Membership (not mere access) is
    // the bar, so someone reading a public room they found by search or link
    // has to join before they can post to it.
    const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(roomId);
    if (!room || !canAccessRoom(socket.user.id, room)) {
      return reply({ error: 'Not allowed' });
    }
    if (!isRoomMember(socket.user.id, room)) {
      return reply({ error: 'Join this room to post in it' });
    }
    // Blocked: the person on the other end of this DM has said they do not
    // want to hear from this one.
    //
    // The send is ACCEPTED, and the message stored — but it is never delivered
    // to them, and never notified. Refusing outright announced the block to
    // the sender, which turns a quiet decision into a confrontation. The
    // sender sees their own message go up in a faded, never-arriving style;
    // enough to feel that something is wrong, without being told what.
    //
    // Direct chats only. Blocking is one person's decision about another, and
    // in a group it would silently remove somebody from a conversation the
    // rest of the room is still having.
    const peer = dmPeerId(room, socket.user.id);

    // Blocking runs BOTH ways, and the two directions are handled differently
    // on purpose.
    //
    // I blocked THEM: refuse, and say so. I made this decision and can undo it
    // in two taps, so a message that silently went nowhere would just be
    // baffling — and carrying on a conversation with somebody I have blocked
    // is not a thing to support quietly.
    if (peer && hasBlocked(socket.user.id, peer)) {
      return reply({ error: 'blocked-by-me', message: 'You blocked this person. Unblock them to send messages.' });
    }
    // THEY blocked me: the case above stays silent. Telling the sender would
    // turn one person's quiet decision into a confrontation with them.
    const blockedDelivery = peer && hasBlocked(peer, socket.user.id) ? 1 : 0;
    // ── Commenting on a message ──
    //
    // A comment is an ordinary message with a parent, so everything below —
    // the type check, one-time, disappearing, blocking, the signing, the
    // delivery — applies to it unchanged. Only two things are decided here.
    let parent = null;
    if (parentId != null) {
      parent = db.prepare('SELECT id, room_id, parent_id FROM messages WHERE id = ?').get(parentId);
      // The parent must exist and be in THIS room: without the room check a
      // member of one room could hang a comment off a message in another,
      // where it would be read by people who cannot see its parent.
      if (!parent || String(parent.room_id) !== String(room.id)) {
        return reply({ error: 'That message is no longer here' });
      }
      // One level, enforced at the only place a comment can be created. A
      // client that offers the button on a comment is wrong, and this is what
      // makes it harmless rather than the start of a tree.
      if (parent.parent_id != null) {
        return reply({ error: 'A comment cannot have comments' });
      }
    }

    const msgType = CLIENT_MSG_TYPES.has(type) ? type : 'text';
    // Refused here rather than only hidden in the composer: the switch is a
    // promise made to the OTHER person, and a promise that only a cooperating
    // client keeps is not one.
    if (oneTimeSeconds && room && room.one_time_off) {
      return reply({ error: 'One-time messages are turned off in this chat' });
    }
    const oneTime = Number.isInteger(oneTimeSeconds) && oneTimeSeconds >= 1 && oneTimeSeconds <= 3600
      ? oneTimeSeconds : null;
    // Disappearing mode: record the LIFETIME now, but do not start the clock.
    // The countdown begins when someone actually sees the message (see
    // 'messages_seen'), because a message destroyed while its recipient was
    // offline was never delivered — it was just lost.
    const disappearing = room && room.disappearing_seconds > 0 ? room.disappearing_seconds : 0;

    const result = db.prepare(`
      INSERT INTO messages (room_id, user_id, type, content, file_path, file_name, reply_to_id, one_time_seconds, disappear_seconds, blocked_delivery, parent_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(roomId, socket.user.id, msgType, content || null, stripSig(filePath), fileName || null, replyToId || null, oneTime, disappearing || null, blockedDelivery, parent ? parent.id : null);

    const msg = db.prepare(`
      SELECT m.*, u.username, u.avatar, ${COMMENT_COUNT_SQL},
        rm.content AS reply_content, rm.type AS reply_type, rm.file_name AS reply_file_name,
        ru.username AS reply_username
      FROM messages m
      JOIN users u ON m.user_id = u.id
      LEFT JOIN messages rm ON m.reply_to_id = rm.id
      LEFT JOIN users ru ON rm.user_id = ru.id
      WHERE m.id = ?
    `).get(result.lastInsertRowid);
    if (clientId) msg.client_id = clientId; // lets the sender reconcile its optimistic local bubble

    const memberIds = getRoomMemberIds(room);
    const outMsg = signMessage(msg);

    // Users who have ANY socket actively viewing this room right now. Push is
    // suppressed for them entirely (on all their devices) so a user reading the
    // chat on one device doesn't get notification buzzes on their other devices.
    const viewingUserIds = new Set(
      [...onlineUsers.values()]
        .filter(u => u.roomId === String(roomId) && u.focused !== false)
        .map(u => u.userId)
    );

    // `seenElsewhere` tells each recipient that another of THEIR devices is
    // looking at this room right now. Push was already suppressed for them
    // server-side, but the web build raises its own browser notification from
    // this event, which no server-side check could reach — so a laptop kept
    // buzzing for messages the user was reading on their phone.
    // A comment goes to the same people, under its own name.
    //
    // It must NOT arrive as `message_received`: every client appends that to
    // the open chat, and a comment appearing in the room it was written about
    // is the one thing this feature must not do. `comment_added` carries the
    // comment for anyone with that thread open, and the parent's new count for
    // everyone else's badge — so the badge moves without a reload, which is
    // the only way anybody discovers there is a thread at all.
    const commentCount = parent
      ? db.prepare('SELECT COUNT(*) c FROM messages WHERE parent_id = ?').get(parent.id).c
      : 0;
    const deliver = parent
      ? (id) => io.to('user:' + id).emit('comment_added', {
        parentId: parent.id, roomId: room.id, count: commentCount, comment: outMsg,
      })
      : (id) => io.to('user:' + id).emit('message_received',
        viewingUserIds.has(id) ? { ...outMsg, seenElsewhere: true } : outMsg);
    // Undelivered by design: it goes back to its author and nowhere else.
    if (blockedDelivery) {
      deliver(socket.user.id);
      if (typeof ack === 'function') ack({ ok: true });
      return;
    }
    memberIds.forEach(deliver);
    // …plus anyone reading this public room without having joined it yet.
    previewerIds(room, memberIds).forEach(deliver);

    // Push notification for everyone but the sender (reaches closed apps)
    const roomLabel = room && !room.is_dm ? ` · ${room.name}` : '';
    // Everything the app needs to OPEN this chat, carried in the notification
    // itself. Reported as: tapping a notification sometimes leaves the app on
    // the chat list — one cause was that the push named only a room id, so the
    // app had to fetch the room list before it could open anything, over a
    // connection that has only just woken up. A push that names the chat opens
    // it with no request at all. For a DM the name the recipient sees is the
    // sender's, which is who `peer` is.
    const openData = {
      roomName: room && !room.is_dm ? String(room.name || '') : String(socket.user.username),
      isDm: room && room.is_dm ? '1' : '0',
      peer: room && room.is_dm ? String(socket.user.username) : '',
    };
    // ── @mentions ───────────────────────────────────────────────────────────
    // Being named is different from a message arriving: it is addressed to
    // you. Mentioned people get told even when they are not looking at the
    // chat, and their client badges the room and offers a jump to the message.
    const mentioned = new Set();
    if (msgType === 'text' && content && !String(content).startsWith('e2e:')) {
      const names = String(content).match(/@([a-z0-9._]{3,20})/gi) || [];
      if (names.length) {
        const wanted = [...new Set(names.map(n => n.slice(1).toLowerCase()))];
        const rows = db.prepare(
          `SELECT id, username FROM users WHERE lower(username) IN (${wanted.map(() => '?').join(',')})`
        ).all(...wanted);
        const inChat = new Set(memberIds);
        rows.forEach(r => {
          // Only people who are actually in this chat, so a stray @name cannot
          // notify a stranger.
          if (r.id !== socket.user.id && inChat.has(r.id)) mentioned.add(r.id);
        });
      }
    }
    if (mentioned.size) {
      const evt = { roomId: room.id, messageId: msg.id, byUsername: socket.user.username };
      mentioned.forEach(id => io.to('user:' + id).emit('mentioned', evt));
      // Mentions are pushed even to someone reading a DIFFERENT chat — that is
      // the point of being named — but not to someone already looking at this
      // one, who can see it.
      sendPushToUsers(
        [...mentioned].filter(id => !viewingUserIds.has(id)),
        (msg.avatar ? msg.avatar + ' ' : '') + msg.username + roomLabel,
        `mentioned you`,
        { roomId: String(roomId), msgId: String(msg.id), mention: '1', ...openData },
        { fromUserId: socket.user.id },
      );
    }

    // ── Why a notification was late, in one line ────────────────────────────
    //
    // Reported as: the message appears instantly, the notification arrives a
    // couple of minutes later. Nothing in this file could answer that, because
    // nothing recorded what it did — so every explanation was a theory.
    //
    // Two facts settle it between them, and neither was being written down:
    // who was left out of the push and why (a recipient the server believes is
    // reading the chat gets no push at all, which is not a late notification
    // but a missing one), and how long the send itself took. Compare the
    // timestamp here with the moment the notification appeared on the phone
    // and the answer is no longer a matter of opinion.
    const suppressed = memberIds.filter(id => id !== socket.user.id && viewingUserIds.has(id));
    if (suppressed.length) {
      console.log(`[push] msg ${msg.id} room ${roomId}: suppressed for `
        + `${suppressed.length} viewer(s) [${suppressed.join(',')}]`);
    }
    sendPushToUsers(
      memberIds.filter(id => id !== socket.user.id && !viewingUserIds.has(id)),
      (msg.avatar ? msg.avatar + ' ' : '') + msg.username + roomLabel,
      messagePreview(msg),
      // A comment names the message it hangs off, so tapping the notification
      // can open the THREAD at that comment. Without it the app could only
      // open the chat, where a comment deliberately never appears — the user
      // was sent to a conversation with nothing new in it.
      {
        roomId: String(roomId), msgId: String(msg.id), ...openData,
        ...(parent ? { parentId: String(parent.id), comment: '1' } : {}),
      },
      { fromUserId: socket.user.id },
    );

    // Notify the other DM participant so they can add the DM room to sidebar
    if (room && room.is_dm) {
      io.emit('dm_activity', { room });
    }
    if (typeof ack === 'function') ack({ ok: true });
  });

  // ── WebRTC signaling ────────────────────────────────────────────────────────
  // The server only relays SDP/ICE blobs between users; media flows P2P.
  socket.on('call_offer', ({ toUserId, roomId, kind, sdp }, ack) => {
    // Whether anyone is actually there to hear it. The caller's screen used to
    // say "Ringing…" the instant this was emitted, which is a claim about the
    // OTHER phone made without hearing from it — and simply untrue when the
    // callee was offline and being woken by a push.
    const live = io.sockets.adapter.rooms.get('user:' + toUserId);
    const delivered = !!(live && live.size > 0);
    // Whether their phone will be alerted even with the app closed. The caller
    // is told "Ringing…" for this, and "Connecting…" only when NEITHER route
    // exists — which is the honest meaning of the word.
    const pushed = !roomId && hasPushRoute(parseInt(toUserId, 10), socket.user.id);
    if (typeof ack === 'function') ack({ delivered, pushed });
    io.to('user:' + toUserId).emit('call_offer', {
      fromUserId: socket.user.id, fromUsername: socket.user.username,
      roomId: roomId || null, kind: kind === 'video' ? 'video' : 'voice', sdp,
    });
    // Ring the callee even when their app is closed (1:1 DM calls only).
    if (!roomId) {
      const k = kind === 'video' ? 'video' : 'voice';
      // Keep the offer around so a callee opening the app from the push
      // notification still receives the call (offer re-delivered on connect).
      pendingCalls.set(parseInt(toUserId, 10), {
        fromUserId: socket.user.id, fromUsername: socket.user.username,
        kind: k, sdp, candidates: [], ts: Date.now(),
      });
      // ── Why this is a NOTIFICATION message and not data-only ────────────
      //
      // Reported, repeatedly: the phone does not ring when the app is closed.
      //
      // It was sent data-only so the app would wake and raise its own looping,
      // full-screen ring. The app cannot. expo-notifications delivers a data
      // message to JavaScript through Android's JobScheduler
      // (BackgroundRemoteNotificationTaskConsumer.scheduleJob), and a
      // JobScheduler job is DEFERRABLE — the system runs it when it feels like
      // it, which under Doze is minutes later or not at all. A ringing phone
      // cannot wait for a job queue. Sending data-only therefore traded "a
      // notification that chimes once" for silence, which is what the last
      // three attempts at this were fixing the wrong end of.
      //
      // The other half of onMessageReceived is immediate and needs no
      // JavaScript at all: expo-notifications presents the message itself, on
      // whatever channel it names. So the call now arrives as a real
      // notification on the calls channel — high importance, and a thirty
      // second ringtone — and it rings the moment it lands, with the app
      // closed, force-stopped, or missing entirely from memory.
      //
      // The data payload is still carried, so that when JavaScript IS alive
      // notifee can take over and add what a plain notification cannot do:
      // looping, a full-screen intent, and Accept/Decline in the shade.
      sendPushToUsers(
        [toUserId],
        (socket.user.avatar ? socket.user.avatar + ' ' : '') + socket.user.username,
        k === 'video' ? '🎥 Incoming video call' : '📞 Incoming voice call',
        {
          type: 'call', kind: k,
          fromUserId: socket.user.id,
          fromUsername: socket.user.username,
        },
        {
          // MUST match CALL_CHANNEL in native-app/src/incomingCall.ts — the
          // app creates the channel, this names it, and a name Android has
          // never heard of falls back to the default channel with the default
          // sound. A test compares the two.
          channelId: 'calls-v3',
          sound: 'ring',
          priorityMax: true,
          // One tag, so a second offer replaces the first rather than stacking.
          tag: 'incoming-call',
          // A call is worthless once it has been missed; do not deliver it
          // late from a queue.
          ttl: '45s',
          fromUserId: socket.user.id,
        },
      );
    }
  });

  // Record a finished 1:1 call in the DM's chat history (both users see it).
  socket.on('call_log', ({ peerId, kind, outcome, duration, outgoing }) => {
    const peer = parseInt(peerId, 10);
    if (!peer || peer === socket.user.id) return;
    const a = Math.min(socket.user.id, peer);
    const b = Math.max(socket.user.id, peer);
    const dmName = `__dm__${a}__${b}__`;
    let dm = db.prepare('SELECT * FROM rooms WHERE name = ?').get(dmName);
    if (!dm) {
      const r = db.prepare('INSERT INTO rooms (name, created_by, is_dm) VALUES (?, ?, 1)').run(dmName, socket.user.id);
      dm = db.prepare('SELECT * FROM rooms WHERE id = ?').get(r.lastInsertRowid);
    }
    const content = JSON.stringify({
      kind: kind === 'video' ? 'video' : 'voice',
      outcome: ['completed', 'missed', 'declined', 'failed'].includes(outcome) ? outcome : 'missed',
      duration: Math.max(0, parseInt(duration, 10) || 0),
      by: socket.user.id, // who logged it (the one who ended/declined)
    });
    const result = db.prepare(
      'INSERT INTO messages (room_id, user_id, type, content) VALUES (?, ?, ?, ?)'
    ).run(dm.id, socket.user.id, 'call', content);
    const msg = db.prepare(`
      SELECT m.*, u.username, u.avatar FROM messages m JOIN users u ON m.user_id = u.id WHERE m.id = ?
    `).get(result.lastInsertRowid);
    [socket.user.id, peer].forEach(id => io.to('user:' + id).emit('message_received', signMessage(msg)));
    io.emit('dm_activity', { room: dm });
  });
  socket.on('call_answer', ({ toUserId, sdp }) => {
    clearPendingCallsBetween(socket.user.id, parseInt(toUserId, 10));
    io.to('user:' + toUserId).emit('call_answer', { fromUserId: socket.user.id, sdp });
  });
  socket.on('call_ice', ({ toUserId, candidate }) => {
    // Also stash candidates with a pending offer so a late-connecting callee
    // gets the caller's early candidates (they'd otherwise be lost).
    const pc = pendingCalls.get(parseInt(toUserId, 10));
    if (pc && pc.fromUserId === socket.user.id && pc.candidates.length < 60) pc.candidates.push(candidate);
    io.to('user:' + toUserId).emit('call_ice', { fromUserId: socket.user.id, candidate });
  });
  // The callee's app reporting that it is alerting — the only thing that
  // entitles the caller's screen to say "Ringing…".
  socket.on('call_ringing', ({ toUserId }) => {
    io.to('user:' + toUserId).emit('call_ringing', { fromUserId: socket.user.id });
  });
  socket.on('call_end', ({ toUserId }) => {
    clearPendingCallsBetween(socket.user.id, parseInt(toUserId, 10));
    const live = io.sockets.adapter.rooms.get('user:' + toUserId);
    io.to('user:' + toUserId).emit('call_end', { fromUserId: socket.user.id });
    // A callee whose app is CLOSED never sees that event — they are being rung
    // by a notification, and hanging up left it ringing on their phone with
    // nobody on the other end. Reported exactly that way.
    //
    // There is no way to cancel a notification that has already been
    // delivered, but there IS a way to replace it: the same tag. So the ring
    // is overwritten by a silent "Missed call" on the ordinary channel, which
    // stops the sound and leaves a true record of what happened.
    if (!(live && live.size > 0)) {
      sendPushToUsers(
        [toUserId],
        (socket.user.avatar ? socket.user.avatar + ' ' : '') + socket.user.username,
        '📞 Missed call',
        { type: 'call_missed', fromUserId: socket.user.id },
        { tag: 'incoming-call', fromUserId: socket.user.id },
      );
    }
  });

  // Lightweight liveness probe: clients verify the socket isn't a zombie
  // (e.g. after a SIM call or network switch) and force-reconnect if this
  // ack never arrives.
  socket.on('ping_check', (ack) => { if (typeof ack === 'function') ack({ ok: true }); });

  // Re-deliver a still-fresh pending call to a callee who just connected
  // (opened the app from the incoming-call notification).
  {
    const pc = pendingCalls.get(socket.user.id);
    if (pc) {
      if (Date.now() - pc.ts > PENDING_CALL_TTL) {
        pendingCalls.delete(socket.user.id);
      } else {
        setTimeout(() => {
          socket.emit('call_offer', {
            fromUserId: pc.fromUserId, fromUsername: pc.fromUsername,
            roomId: null, kind: pc.kind, sdp: pc.sdp,
          });
          pc.candidates.forEach(c => socket.emit('call_ice', { fromUserId: pc.fromUserId, candidate: c }));
        }, 600);
      }
    }
  }

  // Room voice chat: mesh membership. Existing participants send offers to
  // each newcomer; the server just tracks who is in the voice chat.
  socket.on('voice_join', ({ roomId }) => {
    const key = String(roomId);
    if (!voiceRooms.has(key)) voiceRooms.set(key, new Map());
    const members = voiceRooms.get(key);
    // Tell the joiner who is already in (they will RECEIVE offers from them)
    socket.emit('voice_peers', {
      roomId: key,
      peers: [...members.values()].map(m => ({ userId: m.userId, username: m.username })),
    });
    // Tell existing members to initiate an offer to the newcomer
    members.forEach(m => {
      io.to('user:' + m.userId).emit('voice_peer_joined', {
        roomId: key, userId: socket.user.id, username: socket.user.username,
      });
    });
    members.set(socket.id, { userId: socket.user.id, username: socket.user.username });
    io.to(key).emit('voice_count', { roomId: key, count: members.size });
  });
  const leaveVoice = () => {
    voiceRooms.forEach((members, key) => {
      if (members.delete(socket.id)) {
        members.forEach(m => {
          io.to('user:' + m.userId).emit('voice_peer_left', { roomId: key, userId: socket.user.id });
        });
        io.to(key).emit('voice_count', { roomId: key, count: members.size });
        if (!members.size) voiceRooms.delete(key);
      }
    });
  };
  socket.on('voice_leave', leaveVoice);
  socket.on('disconnect', leaveVoice);

  // The room travels WITH the event. Reported as: a stranger's "is typing"
  // appearing under somebody else's conversation on the web. These are routed
  // by the room each socket is currently looking at, and "currently" is
  // something the server is told — so a client that says it late, or a
  // reconnect, leaves a window where this is delivered to the wrong screen.
  // Naming the room lets the client refuse what is not about the chat it is
  // showing, whatever the routing did.
  socket.on('typing_start', ({ roomId }) => {
    emitToRoomUnblocked(roomId, socket.user.id, 'user_typing',
      { username: socket.user.username, roomId: String(roomId) });
  });

  // Stopped by the same rule that started it. This used to go to the socket.io
  // room instead, which is a different set of people — so a "stop" could reach
  // somebody who never got the "start", and the indicator it was meant to
  // clear was somewhere else entirely.
  socket.on('typing_stop', ({ roomId }) => {
    emitToRoomUnblocked(roomId, socket.user.id, 'user_stopped_typing',
      { username: socket.user.username, roomId: String(roomId) });
  });

  socket.on('mark_read', ({ roomId, lastMsgId }) => {
    if (!roomId || !lastMsgId) return;
    db.prepare(`
      INSERT INTO room_reads (user_id, room_id, last_read_msg_id) VALUES (?, ?, ?)
      ON CONFLICT(user_id, room_id) DO UPDATE SET
        last_read_msg_id = MAX(last_read_msg_id, excluded.last_read_msg_id)
    `).run(socket.user.id, roomId, lastMsgId);
    const row = db.prepare('SELECT last_read_msg_id FROM room_reads WHERE user_id = ? AND room_id = ?')
      .get(socket.user.id, roomId);
    socket.to(String(roomId)).emit('messages_read', {
      roomId: String(roomId), userId: socket.user.id, lastReadMsgId: row.last_read_msg_id,
    });
  });

  /**
   * A thread has been read up to this comment.
   *
   * Its own mark, because a thread is read by opening it — the chat's read
   * position is advanced from the conversation's message list, which never
   * contains a comment, so without this a comment stayed unread for ever and
   * the chat list kept its badge.
   *
   * The room's new unread count is acknowledged back, so the badge that was
   * wrong is corrected from the server rather than guessed at by subtracting.
   */
  socket.on('mark_comments_read', ({ parentId, lastMsgId }, ack) => {
    const parent = parseInt(parentId, 10);
    const upto = parseInt(lastMsgId, 10);
    if (!parent || !upto) { if (typeof ack === 'function') ack({ ok: false }); return; }
    const msg = db.prepare('SELECT room_id FROM messages WHERE id = ?').get(parent);
    const room = msg && db.prepare('SELECT * FROM rooms WHERE id = ?').get(msg.room_id);
    if (!room || !canAccessRoom(socket.user.id, room)) {
      if (typeof ack === 'function') ack({ ok: false });
      return;
    }
    db.prepare(`
      INSERT INTO comment_reads (user_id, parent_id, last_read_msg_id) VALUES (?, ?, ?)
      ON CONFLICT(user_id, parent_id) DO UPDATE SET
        last_read_msg_id = MAX(last_read_msg_id, excluded.last_read_msg_id)
    `).run(socket.user.id, parent, upto);
    if (typeof ack === 'function') {
      ack({ ok: true, roomId: room.id, unread: unreadCountFor(socket.user.id, room.id) });
    }
  });

  /**
   * Mark a whole chat read, from the list, without opening it.
   *
   * Asked for as a long-press action. It is not "pretend the newest message id
   * is the mark": a chat with unread COMMENTS would keep its badge, which is
   * precisely the confusion this is meant to end. So it moves the room's own
   * position to the newest message in the room and marks every thread in it
   * read as well — the badge means "there is something here for you", so
   * clearing it has to clear all of it.
   */
  socket.on('mark_room_read', ({ roomId }, ack) => {
    const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(roomId);
    if (!room || !canAccessRoom(socket.user.id, room)) {
      if (typeof ack === 'function') ack({ ok: false });
      return;
    }
    try {
      const newest = db.prepare('SELECT MAX(id) AS id FROM messages WHERE room_id = ?').get(room.id);
      const upto = newest && newest.id ? newest.id : 0;
      if (upto) {
        db.prepare(`
          INSERT INTO room_reads (user_id, room_id, last_read_msg_id) VALUES (?, ?, ?)
          ON CONFLICT(user_id, room_id) DO UPDATE SET
            last_read_msg_id = MAX(last_read_msg_id, excluded.last_read_msg_id)
        `).run(socket.user.id, room.id, upto);
        // Every thread in the room, in one statement: doing it per parent from
        // the client would need the client to know which parents exist.
        db.prepare(`
          INSERT INTO comment_reads (user_id, parent_id, last_read_msg_id)
          SELECT ?, m.parent_id, MAX(m.id)
          FROM messages m
          WHERE m.room_id = ? AND m.parent_id IS NOT NULL
          GROUP BY m.parent_id
          ON CONFLICT(user_id, parent_id) DO UPDATE SET
            last_read_msg_id = MAX(last_read_msg_id, excluded.last_read_msg_id)
        `).run(socket.user.id, room.id);
        socket.to(String(room.id)).emit('messages_read', {
          roomId: String(room.id), userId: socket.user.id, lastReadMsgId: upto,
        });
      }
      if (typeof ack === 'function') {
        ack({ ok: true, roomId: room.id, unread: unreadCountFor(socket.user.id, room.id) });
      }
    } catch (err) {
      console.error('[mark_room_read]', err.message);
      if (typeof ack === 'function') ack({ ok: false });
    }
  });

  // Voice message opened/played indicator: only a listener other than the
  // sender marks it, and everyone in the room (sender included) is told.
  socket.on('voice_played', ({ messageId }) => {
    const msg = db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId);
    if (!msg || msg.type !== 'audio' || msg.user_id === socket.user.id) return;
    const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(msg.room_id);
    if (!canAccessRoom(socket.user.id, room)) return;
    if (!msg.played) {
      db.prepare('UPDATE messages SET played = 1 WHERE id = ?').run(msg.id);
      io.to(String(msg.room_id)).emit('voice_played', { messageId: msg.id, roomId: msg.room_id });
      getRoomMemberIds(room).forEach(id => io.to('user:' + id).emit('voice_played', { messageId: msg.id, roomId: msg.room_id }));
    }
  });

  // The kinds a client may announce. Anything else becomes 'file': this word
  // is chosen by a client and ends up in a sentence on everybody else's
  // screen, so it is whitelisted rather than relayed.
  const SEND_KINDS = new Set(['photo', 'photos', 'video', 'voice', 'audio', 'file']);

  socket.on('recording_start', ({ roomId }) => {
    emitToRoomUnblocked(roomId, socket.user.id, 'user_recording',
      { username: socket.user.username, roomId: String(roomId) });
  });

  socket.on('recording_stop', ({ roomId }) => {
    emitToRoomUnblocked(roomId, socket.user.id, 'user_stopped_recording',
      { username: socket.user.username, roomId: String(roomId) });
  });

  // Asked for: just like "is typing", sending an image or a file should be
  // reported. Routed exactly like typing and recording — through
  // emitToRoomUnblocked, so somebody who blocked this user is not told what
  // they are uploading, and so a "stopped" reaches the same people the "start"
  // did. Sending them to the socket.io room instead is a bug this file has
  // already had: a stop could land on somebody who never got the start, and
  // the indicator it was meant to clear was somewhere else entirely.
  socket.on('sending_start', ({ roomId, kind }) => {
    emitToRoomUnblocked(roomId, socket.user.id, 'user_sending', {
      username: socket.user.username,
      roomId: String(roomId),
      // Whitelisted rather than passed through: this string is chosen by a
      // client and ends up in a sentence on everybody else's screen.
      kind: SEND_KINDS.has(String(kind)) ? String(kind) : 'file',
    });
  });

  socket.on('sending_stop', ({ roomId }) => {
    emitToRoomUnblocked(roomId, socket.user.id, 'user_stopped_sending',
      { username: socket.user.username, roomId: String(roomId) });
  });

  // Private-room invitation: owner invites a user; an invite message lands in
  // the invitee's DM with the owner, and joining happens on acceptance.
  socket.on('invite_to_room', ({ roomId, username }, ack) => {
    const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(roomId);
    if (!room || room.is_dm || room.created_by !== socket.user.id) {
      return typeof ack === 'function' && ack({ error: 'Only the room owner can invite' });
    }
    const target = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username || '').trim());
    if (!target) return typeof ack === 'function' && ack({ error: 'User not found' });
    if (target.id === socket.user.id) return typeof ack === 'function' && ack({ error: 'That is you' });
    const already = db.prepare('SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?').get(room.id, target.id);
    if (already) return typeof ack === 'function' && ack({ error: 'Already a member' });

    // find/create the DM room between owner and invitee
    const a = Math.min(socket.user.id, target.id);
    const b = Math.max(socket.user.id, target.id);
    const dmName = `__dm__${a}__${b}__`;
    let dm = db.prepare('SELECT * FROM rooms WHERE name = ?').get(dmName);
    if (!dm) {
      const r = db.prepare('INSERT INTO rooms (name, created_by, is_dm) VALUES (?, ?, 1)').run(dmName, socket.user.id);
      dm = db.prepare('SELECT * FROM rooms WHERE id = ?').get(r.lastInsertRowid);
    }
    const content = JSON.stringify({ roomId: room.id, roomName: room.name });
    const result = db.prepare(
      'INSERT INTO messages (room_id, user_id, type, content) VALUES (?, ?, ?, ?)'
    ).run(dm.id, socket.user.id, 'invite', content);
    const msg = db.prepare(`
      SELECT m.*, u.username, u.avatar FROM messages m JOIN users u ON m.user_id = u.id WHERE m.id = ?
    `).get(result.lastInsertRowid);
    [socket.user.id, target.id].forEach(id => io.to('user:' + id).emit('message_received', signMessage(msg)));
    io.emit('dm_activity', { room: dm });

    // An invitation is a real message, so it gets a real push — previously it
    // landed silently in the invitee's DMs and was only noticed by accident.
    // Suppressed if they already have the DM open on some device.
    const viewingDm = [...onlineUsers.values()].some(u => u.userId === target.id && u.roomId === String(dm.id));
    if (!viewingDm) {
      sendPushToUsers(
        [target.id],
        (socket.user.avatar ? socket.user.avatar + ' ' : '') + socket.user.username,
        `🔒 Invited you to "${room.name}"`,
        {
          roomId: String(dm.id), msgId: String(msg.id),
          roomName: String(socket.user.username), isDm: '1', peer: String(socket.user.username),
        },
        { fromUserId: socket.user.id },
      );
    }
    if (typeof ack === 'function') ack({ ok: true });
  });

  // Room owner removes a member. The member loses access immediately and the
  // removal is announced in the room.
  socket.on('remove_member', ({ roomId, userId }, ack) => {
    const reply = (r) => { if (typeof ack === 'function') ack(r); };
    try {
      const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(roomId);
      if (!room || room.is_dm) return reply({ error: 'Room not found' });
      if (room.created_by !== socket.user.id) return reply({ error: 'Only the room owner can remove members' });
      const target = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
      if (!target) return reply({ error: 'User not found' });
      if (target.id === socket.user.id) return reply({ error: 'You cannot remove yourself' });

      const del = db.prepare('DELETE FROM room_members WHERE room_id = ? AND user_id = ?').run(room.id, target.id);
      if (!del.changes) return reply({ error: 'That user is not a member' });

      // Any socket of theirs sitting in the room is pushed out of the channel.
      io.to('user:' + target.id).emit('removed_from_room', { roomId: room.id, roomName: room.name });

      const msg = insertSystemMessage(room.id, target.id, 'removed', {
        userId: target.id, username: target.username, avatar: target.avatar || null,
        byUserId: socket.user.id, byUsername: socket.user.username,
      });
      if (msg) broadcastRoomMessage(room, msg);
      reply({ ok: true });
    } catch (err) {
      console.error('[remove_member]', err.message);
      reply({ error: 'Could not remove that member' });
    }
  });

  // The counterpart to joining: a member leaves a room under their own steam.
  // (Distinct from 'leave_room', which only clears the presence channel.)
  socket.on('leave_room_membership', ({ roomId }, ack) => {
    const reply = (r) => { if (typeof ack === 'function') ack(r); };
    try {
      const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(roomId);
      if (!room || room.is_dm) return reply({ error: 'Room not found' });
      if (room.created_by === socket.user.id) {
        return reply({ error: 'You created this room, so you cannot leave it' });
      }
      const del = db.prepare('DELETE FROM room_members WHERE room_id = ? AND user_id = ?')
        .run(room.id, socket.user.id);
      if (!del.changes) return reply({ error: 'You are not a member of this room' });

      // The leaver is already off the member list, so broadcastRoomMessage
      // would skip them — send it to them explicitly as well.
      const msg = insertSystemMessage(room.id, socket.user.id, 'left', {
        userId: socket.user.id, username: socket.user.username, avatar: socket.user.avatar || null,
      });
      if (msg) {
        broadcastRoomMessage(room, msg);
        io.to('user:' + socket.user.id).emit('message_received', msg);
      }
      io.to('user:' + socket.user.id).emit('left_room', { roomId: room.id, roomName: room.name });
      reply({ ok: true });
    } catch (err) {
      console.error('[leave_room_membership]', err.message);
      reply({ error: 'Could not leave the room' });
    }
  });

  // A recipient has actually SEEN these messages — start their countdowns.
  //
  // "Seen" means the message was on screen, not merely that the chat was open:
  // sitting scrolled up in a long chat is not reading the bottom of it. The
  // client reports only rows the list says are visible.
  //
  // The clock starts once, on the first non-sender to see it, and the resulting
  // deadline is shared with everyone — so both sides watch the same countdown
  // and the message dies from both at the same moment.
  socket.on('messages_seen', ({ roomId, messageIds }, ack) => {
    const reply = (r) => { if (typeof ack === 'function') ack(r); };
    try {
      if (!Array.isArray(messageIds) || !messageIds.length) return reply({ ok: true, started: [] });
      const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(roomId);
      if (!room || !canAccessRoom(socket.user.id, room)) return reply({ error: 'No access' });

      // Cap the batch: a client must not be able to ask about the whole table.
      const ids = messageIds.slice(0, 200).map(x => parseInt(x, 10)).filter(Number.isInteger);
      if (!ids.length) return reply({ ok: true, started: [] });

      const started = [];
      const now = Date.now();
      const rows = db.prepare(
        `SELECT id, user_id, disappear_seconds FROM messages
         WHERE room_id = ? AND expires_at IS NULL AND disappear_seconds > 0
           AND id IN (${ids.map(() => '?').join(',')})`
      ).all(room.id, ...ids);

      for (const m of rows) {
        // The sender seeing their own message proves nothing about delivery.
        if (m.user_id === socket.user.id) continue;
        const expiresAt = now + m.disappear_seconds * 1000;
        db.prepare('UPDATE messages SET expires_at = ? WHERE id = ? AND expires_at IS NULL')
          .run(expiresAt, m.id);
        started.push({ messageId: m.id, expiresAt, seconds: m.disappear_seconds });
      }
      // A new countdown may now be the earliest one there is.
      if (started.length) scheduleNextExpiry();

      if (started.length) {
        const payload = { roomId: room.id, started };
        io.to(String(room.id)).emit('expiry_started', payload);
        getRoomMemberIds(room).forEach(id => io.to('user:' + id).emit('expiry_started', payload));
      }
      reply({ ok: true, started });
    } catch (err) {
      console.error('[messages_seen]', err.message);
      reply({ error: 'Could not start timers' });
    }
  });

  // ── Disappearing messages ─────────────────────────────────────────────────
  //
  // A chat-wide setting, not a per-message one: once it is on, everything
  // EITHER side sends is destroyed a fixed time after it was sent. Stored on
  // the room so it applies to both people regardless of which of them is
  // online, and announced in the chat so nobody is unaware their words are
  // being deleted.
  const DISAPPEARING_CHOICES = [0, 30, 300, 3600, 86400, 604800];

  socket.on('set_disappearing', ({ roomId, seconds }, ack) => {
    const reply = (r) => { if (typeof ack === 'function') ack(r); };
    try {
      const secs = parseInt(seconds, 10) || 0;
      if (!DISAPPEARING_CHOICES.includes(secs)) return reply({ error: 'Unsupported duration' });

      const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(roomId);
      if (!room) return reply({ error: 'Room not found' });
      // Only people in the chat may change it — otherwise anyone reading a
      // public room could switch it on for its members.
      if (!isRoomMember(socket.user.id, room)) return reply({ error: 'Join the room first' });
      if ((room.disappearing_seconds || 0) === secs) return reply({ ok: true, seconds: secs });

      db.prepare('UPDATE rooms SET disappearing_seconds = ? WHERE id = ?').run(secs || null, room.id);

      const msg = insertSystemMessage(room.id, socket.user.id,
        secs ? 'disappearing_on' : 'disappearing_off', {
          userId: socket.user.id,
          username: socket.user.username,
          avatar: socket.user.avatar || null,
          seconds: secs,
        });
      if (msg) broadcastRoomMessage(room, msg);

      const evt = { roomId: room.id, seconds: secs, byUsername: socket.user.username };
      io.to(String(room.id)).emit('disappearing_changed', evt);
      getRoomMemberIds(room).forEach(id => io.to('user:' + id).emit('disappearing_changed', evt));
      reply({ ok: true, seconds: secs });
    } catch (err) {
      console.error('[set_disappearing]', err.message);
      reply({ error: 'Could not change the setting' });
    }
  });

  // Turning one-time messages off for a whole chat.
  //
  // Asked for: either side can turn one-time and disappearing messages off for
  // both sides. Disappearing already worked that way — 'set_disappearing' is
  // open to any member and 0 turns it off — so this is the half that was
  // missing, one-time being a per-message choice by the SENDER until now.
  //
  // Deliberately symmetrical and not an owner privilege: the person harmed by
  // messages that destroy themselves is the one receiving them.
  socket.on('set_one_time_allowed', ({ roomId, allowed }, ack) => {
    const reply = (r) => { if (typeof ack === 'function') ack(r); };
    try {
      const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(roomId);
      if (!room) return reply({ error: 'Room not found' });
      if (!isRoomMember(socket.user.id, room)) return reply({ error: 'Join the room first' });

      const on = !!allowed;
      const off = on ? 0 : 1;
      if ((room.one_time_off ? 1 : 0) === off) return reply({ ok: true, allowed: on });
      db.prepare('UPDATE rooms SET one_time_off = ? WHERE id = ?').run(off, room.id);

      // A system message, like every other change to how a chat behaves: this
      // is not a private preference, it changes what the other person may send.
      const msg = insertSystemMessage(room.id, socket.user.id,
        on ? 'one_time_on' : 'one_time_off', {
          userId: socket.user.id,
          username: socket.user.username,
          avatar: socket.user.avatar || null,
        });
      if (msg) broadcastRoomMessage(room, msg);

      const evt = { roomId: room.id, allowed: on, byUsername: socket.user.username };
      io.to(String(room.id)).emit('one_time_allowed_changed', evt);
      getRoomMemberIds(room).forEach(id => io.to('user:' + id).emit('one_time_allowed_changed', evt));
      reply({ ok: true, allowed: on });
    } catch (err) {
      console.error('[set_one_time_allowed]', err.message);
      reply({ error: 'Could not change the setting' });
    }
  });

  // ── Live location ─────────────────────────────────────────────────────────
  // A live share is one 'location' message whose coordinates keep changing.
  // Updating the row (rather than posting a message per fix) is what keeps a
  // 30-minute share from burying the chat under hundreds of pins.
  socket.on('location_update', ({ messageId, lat, lng, accuracy }, ack) => {
    const reply = (r) => { if (typeof ack === 'function') ack(r); };
    try {
      if (typeof lat !== 'number' || typeof lng !== 'number'
        || !isFinite(lat) || !isFinite(lng)
        || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
        return reply({ error: 'Bad coordinates' });
      }
      const msg = db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId);
      if (!msg || msg.type !== 'location') return reply({ error: 'Not a location message' });
      // Only the person sharing can move the pin.
      if (msg.user_id !== socket.user.id) return reply({ error: 'Not allowed' });

      let payload;
      try { payload = JSON.parse(msg.content || '{}'); } catch { payload = {}; }
      // Expired shares stop accepting updates server-side, so a client that
      // fails to stop its watcher cannot keep broadcasting a position.
      if (!payload.liveUntil || payload.liveUntil <= Date.now()) {
        return reply({ error: 'This live share has ended', ended: true });
      }

      const next = { ...payload, lat, lng, accuracy: accuracy ?? null, updatedAt: Date.now() };
      db.prepare('UPDATE messages SET content = ? WHERE id = ?').run(JSON.stringify(next), msg.id);

      const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(msg.room_id);
      if (room) {
        const out = { messageId: msg.id, roomId: msg.room_id, content: JSON.stringify(next) };
        const ids = getRoomMemberIds(room);
        ids.forEach(id => io.to('user:' + id).emit('location_updated', out));
        previewerIds(room, ids).forEach(id => io.to('user:' + id).emit('location_updated', out));
      }
      reply({ ok: true });
    } catch (err) {
      console.error('[location_update]', err.message);
      reply({ error: 'Could not update location' });
    }
  });

  // Ending a share early. Everyone sees it stop immediately.
  socket.on('location_stop', ({ messageId }, ack) => {
    const reply = (r) => { if (typeof ack === 'function') ack(r); };
    try {
      const msg = db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId);
      if (!msg || msg.type !== 'location') return reply({ error: 'Not a location message' });
      if (msg.user_id !== socket.user.id) return reply({ error: 'Not allowed' });

      let payload;
      try { payload = JSON.parse(msg.content || '{}'); } catch { payload = {}; }
      const next = { ...payload, liveUntil: Date.now() };
      db.prepare('UPDATE messages SET content = ? WHERE id = ?').run(JSON.stringify(next), msg.id);

      const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(msg.room_id);
      if (room) {
        const out = { messageId: msg.id, roomId: msg.room_id, content: JSON.stringify(next) };
        const ids = getRoomMemberIds(room);
        ids.forEach(id => io.to('user:' + id).emit('location_updated', out));
        previewerIds(room, ids).forEach(id => io.to('user:' + id).emit('location_updated', out));
      }
      reply({ ok: true });
    } catch (err) {
      console.error('[location_stop]', err.message);
      reply({ error: 'Could not stop sharing' });
    }
  });

  socket.on('accept_invite', ({ roomId }, ack) => {
    const reply = (r) => { if (typeof ack === 'function') ack(r); };
    try {
      const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(roomId);
      if (!room || room.is_dm) return reply({ error: 'Room no longer exists' });

      if (room.is_private && room.created_by !== socket.user.id) {
        // Verify an invitation for THIS room exists in a DM this user belongs
        // to. DM rooms are named __dm__<a>__<b>__, so rather than pattern-match
        // that name in SQL (which needs escaped underscores — a previous
        // version built an invalid `ESCAPE ''` clause that threw on every call,
        // silently breaking every join), match the user's id against the parsed
        // participants.
        const invites = db.prepare(`
          SELECT r.name FROM messages m
          JOIN rooms r ON m.room_id = r.id
          WHERE m.type = 'invite' AND r.is_dm = 1 AND m.content LIKE ?
        `).all('%"roomId":' + room.id + '%');
        const invited = invites.some(row => {
          const parts = String(row.name).split('__').filter(Boolean); // ['dm','a','b']
          return parts.length === 3
            && (parseInt(parts[1], 10) === socket.user.id || parseInt(parts[2], 10) === socket.user.id);
        });
        if (!invited) return reply({ error: 'No invitation found' });
      }

      const ins = db.prepare('INSERT OR IGNORE INTO room_members (room_id, user_id) VALUES (?, ?)')
        .run(room.id, socket.user.id);
      io.to('user:' + socket.user.id).emit('room_created', room); // adds it to their sidebar

      // Announce the new member in the room itself (only on a genuinely new
      // join, so re-opening an invite link doesn't spam the room). The content
      // carries the user id so the client can make the name tappable.
      if (ins.changes > 0) {
        const sysMsg = insertSystemMessage(room.id, socket.user.id, 'joined', {
          userId: socket.user.id, username: socket.user.username, avatar: socket.user.avatar || null,
        });
        if (sysMsg) broadcastRoomMessage(room, sysMsg);
      }
      reply({ ok: true, room });
    } catch (err) {
      console.error('[accept_invite]', err.message);
      reply({ error: 'Could not join the room' });
    }
  });

  // Forward a message to another room/DM. Messages that live in private rooms
  // must stay there.
  socket.on('forward_message', ({ messageId, toRoomId }, ack) => {
    const src = db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId);
    if (!src) return typeof ack === 'function' && ack({ error: 'Message not found' });
    const srcRoom = db.prepare('SELECT * FROM rooms WHERE id = ?').get(src.room_id);
    const dstRoom = db.prepare('SELECT * FROM rooms WHERE id = ?').get(toRoomId);
    // Forwarding writes into the destination, so that end needs membership.
    if (dstRoom && !isRoomMember(socket.user.id, dstRoom)) {
      return typeof ack === 'function' && ack({ error: 'Join that room to forward into it' });
    }
    if (!canAccessRoom(socket.user.id, srcRoom) || !canAccessRoom(socket.user.id, dstRoom)) {
      return typeof ack === 'function' && ack({ error: 'Not allowed' });
    }
    if (srcRoom && !srcRoom.is_dm && srcRoom.is_private && srcRoom.id !== dstRoom.id) {
      return typeof ack === 'function' && ack({ error: 'Messages from a private room cannot be forwarded' });
    }
    if (src.type === 'invite') return typeof ack === 'function' && ack({ error: 'Invitations cannot be forwarded' });
    if (src.one_time_seconds) return typeof ack === 'function' && ack({ error: 'One-time messages cannot be forwarded' });
    if (src.content && String(src.content).startsWith('e2e:')) {
      return typeof ack === 'function' && ack({ error: 'Encrypted messages cannot be forwarded' });
    }
    const origSender = db.prepare('SELECT username FROM users WHERE id = ?').get(src.user_id);
    const result = db.prepare(`
      INSERT INTO messages (room_id, user_id, type, content, file_path, file_name, forwarded_from)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(dstRoom.id, socket.user.id, src.type, src.content, src.file_path, src.file_name,
           src.forwarded_from || (origSender ? origSender.username : null));
    const msg = db.prepare(`
      SELECT m.*, u.username, u.avatar, ${COMMENT_COUNT_SQL},
        rm.content AS reply_content, rm.type AS reply_type, rm.file_name AS reply_file_name,
        ru.username AS reply_username
      FROM messages m
      JOIN users u ON m.user_id = u.id
      LEFT JOIN messages rm ON m.reply_to_id = rm.id
      LEFT JOIN users ru ON rm.user_id = ru.id
      WHERE m.id = ?
    `).get(result.lastInsertRowid);
    const dstMembers = getRoomMemberIds(dstRoom);
    dstMembers.forEach(id => io.to('user:' + id).emit('message_received', signMessage(msg)));
    sendPushToUsers(
      dstMembers.filter(id => id !== socket.user.id),
      (msg.avatar ? msg.avatar + ' ' : '') + msg.username + (dstRoom.is_dm ? '' : ` · ${dstRoom.name}`),
      messagePreview(msg),
      {
        roomId: String(dstRoom.id), msgId: String(msg.id),
        roomName: dstRoom.is_dm ? String(socket.user.username) : String(dstRoom.name || ''),
        isDm: dstRoom.is_dm ? '1' : '0',
        peer: dstRoom.is_dm ? String(socket.user.username) : '',
      },
      { fromUserId: socket.user.id },
    );
    if (dstRoom.is_dm) io.emit('dm_activity', { room: dstRoom });
    if (typeof ack === 'function') ack({ ok: true });
  });

  socket.on('edit_message', ({ messageId, content }) => {
    if (!content || !content.trim()) return;
    const msg = db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId);
    if (!msg || msg.type !== 'text') return;
    if (msg.user_id !== socket.user.id) return; // ownership check
    db.prepare('UPDATE messages SET content = ?, edited = 1 WHERE id = ?').run(content.trim(), messageId);
    io.to(String(msg.room_id)).emit('message_edited', { messageId, content: content.trim() });
  });

  socket.on('delete_message', ({ messageId }) => {
    const msg = db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId);
    if (!msg) return;
    if (msg.user_id !== socket.user.id) return; // ownership check
    destroyMessage(msg);
  });

  /**
   * "Delete for me": hide one message from this user, and nobody else.
   *
   * Asked for as a Delete on the other side's message that is just for the
   * person doing it. Deliberately NOT a variant of delete_message, which
   * removes the message from the conversation — that one keeps its ownership
   * check, and this one is what the other side's messages get instead.
   *
   * Access is checked but ownership is not, because hiding somebody else's
   * message is the entire point. Hiding your own is allowed too and means what
   * it says: it disappears from your copy and the people you sent it to keep
   * it.
   *
   * Acknowledged, so the client can remove the message once it is actually
   * stored rather than optimistically and then have it reappear on reload.
   */
  socket.on('hide_message', ({ messageId }, ack) => {
    const done = typeof ack === 'function' ? ack : () => {};
    const msg = db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId);
    if (!msg) { done({ ok: true }); return; } // already gone: the goal is met
    const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(msg.room_id);
    if (!canAccessRoom(socket.user.id, room)) { done({ error: 'No access' }); return; }
    try {
      db.prepare('INSERT OR IGNORE INTO hidden_messages (user_id, message_id) VALUES (?, ?)')
        .run(socket.user.id, msg.id);
    } catch (e) {
      done({ error: 'Could not delete' });
      return;
    }
    // Every device this user is signed in on, so the message does not linger
    // on the tablet after being deleted on the phone. Nobody else is told:
    // for them nothing has happened.
    io.to('user:' + socket.user.id).emit('message_hidden', {
      messageId: msg.id, roomId: msg.room_id,
    });
    done({ ok: true });
  });

  // A recipient opened a one-time message: start its self-destruct timer.
  socket.on('view_one_time', ({ messageId }) => {
    const msg = db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId);
    if (!msg || !msg.one_time_seconds) return;
    if (msg.user_id === socket.user.id) return; // sender's own view doesn't start the clock
    const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(msg.room_id);
    if (!canAccessRoom(socket.user.id, room)) return;
    if (!msg.viewed_at) {
      const now = Date.now();
      db.prepare('UPDATE messages SET viewed_at = ? WHERE id = ?').run(now, msg.id);
      msg.viewed_at = now;
      // Let everyone (including the sender) see the countdown has started
      const viewed = { messageId: msg.id, roomId: msg.room_id, viewedAt: now, seconds: msg.one_time_seconds };
      io.to(String(msg.room_id)).emit('one_time_viewed', viewed);
      // …and to every member directly, so a backgrounded sender still sees the
      // countdown start (and the destruction that follows).
      getRoomMemberIds(room).forEach(id => io.to('user:' + id).emit('one_time_viewed', viewed));
      setTimeout(() => {
        const still = db.prepare('SELECT * FROM messages WHERE id = ?').get(msg.id);
        if (still) destroyMessage(still);
      }, msg.one_time_seconds * 1000);
      // And through the shared scheduler as well, so a restart before that
      // timer fires does not leave the message waiting for the next sweep.
      scheduleNextExpiry();
    }
  });

  socket.on('toggle_reaction', ({ messageId, emoji }) => {
    if (!emoji || typeof emoji !== 'string' || emoji.length > 16) return;
    // Authorization: reacting is contributing, so it takes membership — the
    // same bar as posting, not merely being able to read the room.
    const target = db.prepare('SELECT room_id FROM messages WHERE id = ?').get(messageId);
    if (!target) return;
    const rRoom = db.prepare('SELECT * FROM rooms WHERE id = ?').get(target.room_id);
    if (!canAccessRoom(socket.user.id, rRoom)) return;
    if (!isRoomMember(socket.user.id, rRoom)) return;

    const existing = db.prepare(
      'SELECT id FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?'
    ).get(messageId, socket.user.id, emoji);

    if (existing) {
      db.prepare('DELETE FROM reactions WHERE id = ?').run(existing.id);
    } else {
      db.prepare(
        'INSERT OR IGNORE INTO reactions (message_id, user_id, emoji) VALUES (?, ?, ?)'
      ).run(messageId, socket.user.id, emoji);
    }

    const reactions = db.prepare(`
      SELECT r.emoji, u.username, r.user_id FROM reactions r
      JOIN users u ON r.user_id = u.id WHERE r.message_id = ?
    `).all(messageId);

    // Deliver to every member's personal channel, not just the presence room.
    // Sockets drop out of the presence channel whenever the app is backgrounded
    // (leave_room) or after a reconnect that hasn't re-joined yet, which is why
    // reactions sometimes silently failed to arrive.
    const msg = db.prepare('SELECT room_id FROM messages WHERE id = ?').get(messageId);
    if (msg) {
      const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(msg.room_id);
      const payload = { messageId, roomId: msg.room_id, reactions };
      io.to(String(msg.room_id)).emit('reactions_updated', payload);
      if (room) {
        getRoomMemberIds(room).forEach(id => io.to('user:' + id).emit('reactions_updated', payload));
      }
    }
  });

  socket.on('delete_room', ({ roomId }) => {
    const room = db.prepare('SELECT * FROM rooms WHERE id = ? AND is_dm = 0').get(roomId);
    if (!room) return;
    if (room.created_by !== socket.user.id) return; // ownership check
    db.prepare('DELETE FROM reactions WHERE message_id IN (SELECT id FROM messages WHERE room_id = ?)').run(roomId);
    db.prepare('DELETE FROM messages WHERE room_id = ?').run(roomId);
    db.prepare('DELETE FROM rooms WHERE id = ?').run(roomId);
    io.emit('room_deleted', { roomId });
  });

  socket.on('edit_room', ({ roomId, name }) => {
    if (!name || !name.trim()) return;
    const room = db.prepare('SELECT * FROM rooms WHERE id = ? AND is_dm = 0').get(roomId);
    if (!room) return;
    if (room.created_by !== socket.user.id) return; // ownership check
    const existing = db.prepare('SELECT id FROM rooms WHERE name = ? AND id != ?').get(name.trim(), roomId);
    if (existing) return;
    db.prepare('UPDATE rooms SET name = ? WHERE id = ?').run(name.trim(), roomId);
    const updated = db.prepare('SELECT * FROM rooms WHERE id = ?').get(roomId);
    io.emit('room_updated', updated);
  });

  socket.on('disconnect', () => {
    const info = onlineUsers.get(socket.id);
    onlineUsers.delete(socket.id);
    if (info?.roomId) {
      // Named here too: a client that filters by room would otherwise ignore
      // the one event that clears an indicator left behind by a disconnect.
      io.to(info.roomId).emit('user_stopped_typing',
        { username: socket.user.username, roomId: String(info.roomId) });
      io.to(info.roomId).emit('user_stopped_recording',
        { username: socket.user.username, roomId: String(info.roomId) });
      emitRoomOnline(info.roomId);
    }
  });
});

server.listen(PORT, () => console.log(`Chat server running on http://localhost:${server.address().port}`));

// Exported so the integration tests can boot the real server on an ephemeral
// port and drive it over HTTP + Socket.IO. Has no effect in production.
// scheduleNextExpiry is exported so the test suite can drive the exact-timer
// path with a deadline a second away instead of the thirty seconds the
// shortest real setting allows. It is the SAME function the server calls after
// every countdown starts — a seam, not a second implementation.
module.exports = { app, server, io, scheduleNextExpiry, sweepExpired };
