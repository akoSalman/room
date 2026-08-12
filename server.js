const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
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
                   'public/css/style.css', 'public/index.html'];
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
app.use('/uploads', express.static('uploads', {
  maxAge: '30d', immutable: true,
  setHeaders(res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', 'attachment');
  },
}));

// ── Thumbnails ───────────────────────────────────────────────────────────────
// The media gallery rendered its grid from the ORIGINAL uploads: opening a
// chat's photos meant downloading every full-size image just to draw 100px
// cells, which is why a gallery page took so long to fill in. This serves a
// small re-encoded JPEG instead, generated once and cached on disk.
//
// Re-encoding through sharp also means the bytes we return are ours, not the
// uploader's, so unlike /uploads these can safely be served inline as images.
const sharp = require('sharp');
const THUMB_DIR = path.join('uploads', '.thumbs');
const THUMB_WIDTHS = [96, 200, 400];   // fixed set: an attacker can't ask for 10000 renders

app.get('/thumb/:name', async (req, res) => {
  // Only ever a bare filename inside uploads/ — no traversal, no subpaths.
  const name = path.basename(String(req.params.name || ''));
  if (!name || name.startsWith('.') || name !== req.params.name) {
    return res.status(400).end();
  }
  const src = path.join('uploads', name);
  if (!fs.existsSync(src)) return res.status(404).end();

  const asked = parseInt(req.query.w, 10) || 200;
  const width = THUMB_WIDTHS.includes(asked) ? asked : 200;
  const out = path.join(THUMB_DIR, `${name}_${width}.jpg`);

  try {
    if (!fs.existsSync(out)) {
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
    // Not an image, or a format sharp can't read — say so rather than
    // pretending, so the client can fall back to the original.
    res.status(415).end();
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
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(uname);
  if (user) {
    if (register) return res.status(409).json({ error: 'Username already taken' });
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Wrong password' });
    const token = jwt.sign({ id: user.id, username: uname }, JWT_SECRET);
    return res.json({ token, username: uname, avatar: user.avatar || null, isNew: false });
  }
  if (!register) {
    return res.status(404).json({ error: 'No account with this username', canRegister: true });
  }
  // New account: enforce a minimum password length.
  if (String(password).length < MIN_PASSWORD_LEN) {
    return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LEN} characters` });
  }
  try {
    const hash = await bcrypt.hash(password, 10);
    const result = db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(uname, hash);
    // Rooms are joined explicitly now, so a brand-new account would otherwise
    // land on an empty list. Put them in the default room to start.
    const general = db.prepare('SELECT id FROM rooms WHERE name = ?').get('General');
    if (general) {
      db.prepare('INSERT OR IGNORE INTO room_members (room_id, user_id) VALUES (?, ?)')
        .run(general.id, result.lastInsertRowid);
    }
    const token = jwt.sign({ id: result.lastInsertRowid, username: uname }, JWT_SECRET);
    res.json({ token, username: uname, avatar: null, isNew: true });
  } catch {
    res.status(409).json({ error: 'Something went wrong, try again' });
  }
});

// Profile update
app.put('/profile', authMiddleware, async (req, res) => {
  const { newUsername, currentPassword, newPassword, avatar } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  if (currentPassword) {
    const valid = await bcrypt.compare(currentPassword, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });
  }

  if (newUsername && newUsername !== user.username) {
    const taken = db.prepare('SELECT id FROM users WHERE username = ? AND id != ?').get(newUsername, req.user.id);
    if (taken) return res.status(409).json({ error: 'Username already taken' });
    db.prepare('UPDATE users SET username = ? WHERE id = ?').run(newUsername, req.user.id);
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
  res.json({ token, username: updated.username, avatar: updated.avatar || null });
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

async function sendPushToUsers(userIds, title, body, data = {}, android = {}) {
  if (!fcmCreds || !userIds.length) return;
  try {
    const placeholders = userIds.map(() => '?').join(',');
    const tokens = db.prepare(`SELECT token FROM push_tokens WHERE user_id IN (${placeholders})`)
      .all(...userIds).map(r => r.token);
    if (!tokens.length) return;
    const access = await getFcmAccessToken();
    if (!access) return;
    await Promise.all(tokens.map(t =>
      fetch(`https://fcm.googleapis.com/v1/projects/${fcmCreds.project_id}/messages:send`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: {
            token: t,
            notification: { title, body },
            data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])),
            android: {
              priority: 'high',
              // Tag the tray notification with the message id so a later
              // delete can replace/collapse it on the recipient's device.
              notification: {
                channel_id: android.channelId || 'messages-v3',
                sound: android.sound || 'notify',
                ...(android.categoryId ? { click_action: android.categoryId, notification_priority: 'PRIORITY_MAX' } : {}),
                ...(data.msgId ? { tag: `msg-${data.msgId}` } : {}),
              },
            },
          },
        }),
      }).then(async r => {
        if (r.status === 404 || r.status === 400) {
          db.prepare('DELETE FROM push_tokens WHERE token = ?').run(t);
          console.warn(`[FCM] Removed invalid token (status ${r.status})`);
        } else if (!r.ok) {
          console.error(`[FCM] Send failed (status ${r.status}):`, await r.text());
        }
      }).catch(err => console.error('[FCM] Send request error:', err.message))
    ));
  } catch (err) {
    console.error('[FCM] sendPushToUsers error:', err.message);
  }
}

// Permanently remove a message (used by user deletes and one-time expiry).
// One-time media also has its uploaded file removed from disk.
function destroyMessage(msg) {
  db.prepare('DELETE FROM reactions WHERE message_id = ?').run(msg.id);
  db.prepare('DELETE FROM messages WHERE id = ?').run(msg.id);
  if (msg.one_time_seconds && msg.file_path) {
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
  } catch (err) {
    console.error('[one-time] sweep error:', err.message);
  }
}, 30 * 1000);

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

// Per-room unread counts based on server-side read positions
app.get('/unread-counts', authMiddleware, (req, res) => {
  const rows = db.prepare(`
    SELECT m.room_id, COUNT(*) AS cnt
    FROM messages m
    LEFT JOIN room_reads rr ON rr.room_id = m.room_id AND rr.user_id = ?
    WHERE m.user_id != ? AND m.id > COALESCE(rr.last_read_msg_id, 0)
    GROUP BY m.room_id
  `).all(req.user.id, req.user.id);
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

// Shared media of a room, categorized for the media browser tabs.
app.get('/room-media/:roomId', authMiddleware, (req, res) => {
  const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(req.params.roomId);
  if (!room || !canAccessRoom(req.user.id, room)) return res.status(404).json({ error: 'Not found' });
  const rows = db.prepare(`
    SELECT id, type, content, file_path, file_name, created_at FROM messages
    WHERE room_id = ? AND one_time_seconds IS NULL
    ORDER BY id DESC LIMIT 5000
  `).all(room.id);
  const media = { images: [], files: [], music: [], links: [] };
  const LINK_RE = /(https?:\/\/[^\s]+|(?:[a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}(?:\/[^\s]*)?)/g;
  rows.forEach(m => {
    if (m.type === 'image' && m.file_path) media.images.push(m.file_path);
    else if (m.type === 'gallery' && m.file_path) {
      try { JSON.parse(m.file_path).forEach(u => media.images.push(u)); } catch {}
    } else if (m.type === 'video' && m.file_path) media.files.push({ url: m.file_path, name: m.file_name || 'Video' });
    else if (m.type === 'file' && m.file_path) media.files.push({ url: m.file_path, name: m.file_name || 'File' });
    else if (m.type === 'music' && m.file_path) media.music.push({ url: m.file_path, name: m.file_name || 'Audio' });
    if (m.type === 'text' && m.content && !m.content.startsWith('e2e:')) {
      (m.content.match(LINK_RE) || []).forEach(l => {
        if (media.links.length < 200 && !media.links.includes(l)) media.links.push(l);
      });
    }
  });
  media.images = media.images.slice(0, 2000);
  media.files = media.files.slice(0, 200);
  media.music = media.music.slice(0, 200);
  res.json(media);
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
app.get('/room-info/:roomId', authMiddleware, (req, res) => {
  const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(req.params.roomId);
  if (!room || room.is_dm) return res.status(404).json({ error: 'Room not found' });
  if (room.is_private && !canAccessRoom(req.user.id, room)) {
    return res.status(403).json({ error: 'This room is private' });
  }
  const owner = room.created_by
    ? db.prepare('SELECT id, username, avatar FROM users WHERE id = ?').get(room.created_by)
    : null;
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
    const other = db.prepare('SELECT username FROM users WHERE id = ?').get(otherId);
    if (!other) continue;
    const last = db.prepare('SELECT MAX(id) AS id FROM messages WHERE room_id = ?').get(room.id);
    rooms.push({ ...room, other_username: other.username, last_msg_id: last?.id || 0 });
  }
  // Most recently active DM first (was: newest-created, which never reordered
  // as conversations went back and forth).
  rooms.sort((x, y) => (y.last_msg_id || 0) - (x.last_msg_id || 0));
  res.json(rooms);
});

// Messages (paginated: most recent page by default, or the page before
// `before` (a message id) for infinite-scroll-up loading of older history)
const MESSAGES_PAGE_SIZE = 20;
app.get('/messages/:roomId', authMiddleware, (req, res) => {
  const roomRow = db.prepare('SELECT * FROM rooms WHERE id = ?').get(req.params.roomId);
  if (!canAccessRoom(req.user.id, roomRow)) return res.status(403).json({ error: 'Not a member of this room' });
  const before = parseInt(req.query.before);
  const messages = before
    ? db.prepare(`
        SELECT m.*, u.username, u.avatar,
          rm.content AS reply_content, rm.type AS reply_type, rm.file_name AS reply_file_name,
          ru.username AS reply_username
        FROM messages m
        JOIN users u ON m.user_id = u.id
        LEFT JOIN messages rm ON m.reply_to_id = rm.id
        LEFT JOIN users ru ON rm.user_id = ru.id
        WHERE m.room_id = ? AND m.id < ?
        ORDER BY m.created_at DESC LIMIT ?
      `).all(req.params.roomId, before, MESSAGES_PAGE_SIZE)
    : db.prepare(`
        SELECT m.*, u.username, u.avatar,
          rm.content AS reply_content, rm.type AS reply_type, rm.file_name AS reply_file_name,
          ru.username AS reply_username
        FROM messages m
        JOIN users u ON m.user_id = u.id
        LEFT JOIN messages rm ON m.reply_to_id = rm.id
        LEFT JOIN users ru ON rm.user_id = ru.id
        WHERE m.room_id = ?
        ORDER BY m.created_at DESC LIMIT ?
      `).all(req.params.roomId, MESSAGES_PAGE_SIZE);
  res.json(messages.reverse());
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

// Shareable room links: /join/<roomId> opens the web app on that room
app.get('/join/:roomId', (req, res) => {
  res.redirect('/?join=' + encodeURIComponent(req.params.roomId));
});

// Socket.IO
const onlineUsers = new Map(); // socketId -> { userId, username, roomId }
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
  const ids = getRoomMemberIds(room);
  ids.forEach(id => io.to('user:' + id).emit('message_received', msg));
  previewerIds(room, ids).forEach(id => io.to('user:' + id).emit('message_received', msg));
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
      const oldOnline = [...onlineUsers.values()]
        .filter(u => u.roomId === prev.roomId && u.username !== socket.user.username)
        .map(u => u.username);
      io.to(prev.roomId).emit('room_online', { users: oldOnline });
    }
    onlineUsers.set(socket.id, { userId: socket.user.id, username: socket.user.username, roomId: String(roomId) });
    socket.join(String(roomId)); // presence room (active room only)
    const roomOnline = [...onlineUsers.values()]
      .filter(u => u.roomId === String(roomId))
      .map(u => u.username);
    io.to(String(roomId)).emit('room_online', { users: roomOnline });
  });

  // The client emits this when the chat screen backgrounds or unmounts, so a
  // device that isn't actively looking at the room stops counting as "viewing"
  // (and thus starts receiving push again). Presence is updated to roomId null.
  socket.on('leave_room', () => {
    const prev = onlineUsers.get(socket.id);
    if (!prev?.roomId) return;
    socket.leave(prev.roomId);
    onlineUsers.set(socket.id, { userId: socket.user.id, username: socket.user.username, roomId: null });
    const oldOnline = [...onlineUsers.values()]
      .filter(u => u.roomId === prev.roomId && u.username !== socket.user.username)
      .map(u => u.username);
    io.to(prev.roomId).emit('room_online', { users: oldOnline });
  });

  // Message types a CLIENT is allowed to send. 'system'/'call'/'invite' are
  // produced by the server only — letting clients set them would forge join
  // notices, call logs and invitations.
  const CLIENT_MSG_TYPES = new Set(['text', 'image', 'gallery', 'video', 'audio', 'music', 'file']);

  socket.on('send_message', (data, ack) => {
    const { roomId, type, content, filePath, fileName, replyToId, clientId, oneTimeSeconds } = data;
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
    const msgType = CLIENT_MSG_TYPES.has(type) ? type : 'text';
    const oneTime = Number.isInteger(oneTimeSeconds) && oneTimeSeconds >= 1 && oneTimeSeconds <= 3600
      ? oneTimeSeconds : null;
    const result = db.prepare(`
      INSERT INTO messages (room_id, user_id, type, content, file_path, file_name, reply_to_id, one_time_seconds)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(roomId, socket.user.id, msgType, content || null, filePath || null, fileName || null, replyToId || null, oneTime);

    const msg = db.prepare(`
      SELECT m.*, u.username, u.avatar,
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
    memberIds.forEach(id => io.to('user:' + id).emit('message_received', msg));
    // …plus anyone reading this public room without having joined it yet.
    previewerIds(room, memberIds).forEach(id => io.to('user:' + id).emit('message_received', msg));

    // Users who have ANY socket actively viewing this room right now. Push is
    // suppressed for them entirely (on all their devices) so a user reading the
    // chat on one device doesn't get notification buzzes on their other devices.
    const viewingUserIds = new Set(
      [...onlineUsers.values()]
        .filter(u => u.roomId === String(roomId))
        .map(u => u.userId)
    );

    // Push notification for everyone but the sender (reaches closed apps)
    const roomLabel = room && !room.is_dm ? ` · ${room.name}` : '';
    sendPushToUsers(
      memberIds.filter(id => id !== socket.user.id && !viewingUserIds.has(id)),
      (msg.avatar ? msg.avatar + ' ' : '') + msg.username + roomLabel,
      messagePreview(msg),
      { roomId: String(roomId), msgId: String(msg.id) }
    );

    // Notify the other DM participant so they can add the DM room to sidebar
    if (room && room.is_dm) {
      io.emit('dm_activity', { room });
    }
    if (typeof ack === 'function') ack({ ok: true });
  });

  // ── WebRTC signaling ────────────────────────────────────────────────────────
  // The server only relays SDP/ICE blobs between users; media flows P2P.
  socket.on('call_offer', ({ toUserId, roomId, kind, sdp }) => {
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
      sendPushToUsers(
        [toUserId],
        (socket.user.avatar ? socket.user.avatar + ' ' : '') + socket.user.username,
        k === 'video' ? '🎥 Incoming video call' : '📞 Incoming voice call',
        { type: 'call', kind: k, fromUserId: socket.user.id },
        { channelId: 'calls-v1', sound: 'ring', categoryId: 'incoming_call' },
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
    [socket.user.id, peer].forEach(id => io.to('user:' + id).emit('message_received', msg));
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
  socket.on('call_end', ({ toUserId }) => {
    clearPendingCallsBetween(socket.user.id, parseInt(toUserId, 10));
    io.to('user:' + toUserId).emit('call_end', { fromUserId: socket.user.id });
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

  socket.on('typing_start', ({ roomId }) => {
    socket.to(String(roomId)).emit('user_typing', { username: socket.user.username });
  });

  socket.on('typing_stop', ({ roomId }) => {
    socket.to(String(roomId)).emit('user_stopped_typing', { username: socket.user.username });
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

  socket.on('recording_start', ({ roomId }) => {
    socket.to(String(roomId)).emit('user_recording', { username: socket.user.username });
  });

  socket.on('recording_stop', ({ roomId }) => {
    socket.to(String(roomId)).emit('user_stopped_recording', { username: socket.user.username });
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
    [socket.user.id, target.id].forEach(id => io.to('user:' + id).emit('message_received', msg));
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
        { roomId: String(dm.id), msgId: String(msg.id) },
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
      SELECT m.*, u.username, u.avatar,
        rm.content AS reply_content, rm.type AS reply_type, rm.file_name AS reply_file_name,
        ru.username AS reply_username
      FROM messages m
      JOIN users u ON m.user_id = u.id
      LEFT JOIN messages rm ON m.reply_to_id = rm.id
      LEFT JOIN users ru ON rm.user_id = ru.id
      WHERE m.id = ?
    `).get(result.lastInsertRowid);
    const dstMembers = getRoomMemberIds(dstRoom);
    dstMembers.forEach(id => io.to('user:' + id).emit('message_received', msg));
    sendPushToUsers(
      dstMembers.filter(id => id !== socket.user.id),
      (msg.avatar ? msg.avatar + ' ' : '') + msg.username + (dstRoom.is_dm ? '' : ` · ${dstRoom.name}`),
      messagePreview(msg),
      { roomId: String(dstRoom.id), msgId: String(msg.id) }
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
      io.to(info.roomId).emit('user_stopped_typing', { username: socket.user.username });
      io.to(info.roomId).emit('user_stopped_recording', { username: socket.user.username });
      const roomOnline = [...onlineUsers.values()]
        .filter(u => u.roomId === info.roomId)
        .map(u => u.username);
      io.to(info.roomId).emit('room_online', { users: roomOnline });
    }
  });
});

server.listen(PORT, () => console.log(`Chat server running on http://localhost:${server.address().port}`));

// Exported so the integration tests can boot the real server on an ephemeral
// port and drive it over HTTP + Socket.IO. Has no effect in production.
module.exports = { app, server, io };
