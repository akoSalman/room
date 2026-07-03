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

const JWT_SECRET = process.env.JWT_SECRET || 'chat_secret_key_change_in_prod';
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

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

// Auth — usernames are unique identifiers. Login only signs in existing users;
// creating an account requires an explicit register flag (clients confirm with
// the user first), so a renamed account's old username is never silently
// re-created by a stale login.
app.post('/auth/signin', async (req, res) => {
  const { username, password, register } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  const uname = String(username).trim();
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
  try {
    const hash = await bcrypt.hash(password, 10);
    const result = db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(uname, hash);
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

// Rooms: public ones + private ones the user owns or is a member of
app.get('/rooms', authMiddleware, (req, res) => {
  const rooms = db.prepare(`
    SELECT * FROM rooms
    WHERE is_dm = 0 AND (
      is_private = 0
      OR created_by = ?
      OR EXISTS (SELECT 1 FROM room_members rm WHERE rm.room_id = rooms.id AND rm.user_id = ?)
    )
    ORDER BY name
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
    if (!room.is_private) io.emit('room_created', room);
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

async function sendPushToUsers(userIds, title, body, data = {}) {
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
            android: { priority: 'high', notification: { channel_id: 'messages' } },
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

function messagePreview(msg) {
  return msg.type === 'text' ? (msg.content || '').slice(0, 100)
    : msg.type === 'audio' ? '🎙 Voice message'
    : msg.type === 'image' ? '🖼 Image'
    : msg.type === 'video' ? '🎥 Video'
    : msg.type === 'music' ? '🎵 Audio file'
    : msg.type === 'invite' ? '🔒 Room invitation' : '📄 File';
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
    ? db.prepare('SELECT username, avatar FROM users WHERE id = ?').get(room.created_by)
    : null;
  // Private rooms: explicit member list. Public rooms: everyone who has posted.
  let members = [];
  if (room.is_private) {
    members = db.prepare(`
      SELECT u.username, u.avatar FROM room_members rm
      JOIN users u ON u.id = rm.user_id
      WHERE rm.room_id = ? ORDER BY u.username
    `).all(room.id);
  } else {
    members = db.prepare(`
      SELECT DISTINCT u.username, u.avatar FROM messages m
      JOIN users u ON u.id = m.user_id
      WHERE m.room_id = ? ORDER BY u.username
    `).all(room.id);
  }
  if (owner && !members.some(m => m.username === owner.username)) {
    members.unshift({ username: owner.username, avatar: owner.avatar });
  }
  res.json({
    id: room.id, name: room.name, is_private: room.is_private, is_dm: room.is_dm,
    created_by: room.created_by, created_at: room.created_at,
    owner_username: owner ? owner.username : null,
    owner_avatar: owner ? owner.avatar : null,
    is_owner: room.created_by === req.user.id,
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
    rooms.push({ ...room, other_username: other.username });
  }
  rooms.sort((x, y) => new Date(y.created_at) - new Date(x.created_at));
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

io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  try {
    socket.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    next(new Error('Unauthorized'));
  }
});

function getRoomMemberIds(room) {
  if (room.is_dm) {
    const parts = room.name.split('__').filter(Boolean);
    if (parts.length !== 3) return [];
    return [parseInt(parts[1]), parseInt(parts[2])];
  }
  if (room.is_private) {
    const ids = db.prepare('SELECT user_id FROM room_members WHERE room_id = ?').all(room.id).map(r => r.user_id);
    if (room.created_by && !ids.includes(room.created_by)) ids.push(room.created_by);
    return ids;
  }
  return db.prepare('SELECT id FROM users').all().map(u => u.id);
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

  socket.on('send_message', (data) => {
    const { roomId, type, content, filePath, fileName, replyToId, clientId } = data;
    const result = db.prepare(`
      INSERT INTO messages (room_id, user_id, type, content, file_path, file_name, reply_to_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(roomId, socket.user.id, type || 'text', content || null, filePath || null, fileName || null, replyToId || null);

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

    const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(roomId);
    const memberIds = room ? getRoomMemberIds(room) : [];
    memberIds.forEach(id => io.to('user:' + id).emit('message_received', msg));

    // Push notification for everyone but the sender (reaches closed apps)
    const roomLabel = room && !room.is_dm ? ` · ${room.name}` : '';
    sendPushToUsers(
      memberIds.filter(id => id !== socket.user.id),
      (msg.avatar ? msg.avatar + ' ' : '') + msg.username + roomLabel,
      messagePreview(msg),
      { roomId: String(roomId), msgId: String(msg.id) }
    );

    // Notify the other DM participant so they can add the DM room to sidebar
    if (room && room.is_dm) {
      io.emit('dm_activity', { room });
    }
  });

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
    if (typeof ack === 'function') ack({ ok: true });
  });

  socket.on('accept_invite', ({ roomId }, ack) => {
    const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(roomId);
    if (!room || room.is_dm) return typeof ack === 'function' && ack({ error: 'Room no longer exists' });
    // verify a matching invite message exists in one of the user's DMs
    const invite = db.prepare(`
      SELECT m.id FROM messages m
      JOIN rooms r ON m.room_id = r.id
      WHERE m.type = 'invite' AND r.is_dm = 1
        AND r.name LIKE '%\_\_' || ? || '\_\_%' ESCAPE '\'
        AND m.content LIKE ?
      LIMIT 1
    `).get(String(socket.user.id), '%"roomId":' + room.id + '%');
    if (room.is_private && !invite) return typeof ack === 'function' && ack({ error: 'No invitation found' });
    db.prepare('INSERT OR IGNORE INTO room_members (room_id, user_id) VALUES (?, ?)').run(room.id, socket.user.id);
    io.to('user:' + socket.user.id).emit('room_created', room); // adds it to their sidebar
    if (typeof ack === 'function') ack({ ok: true, room });
  });

  // Forward a message to another room/DM. Messages that live in private rooms
  // must stay there.
  socket.on('forward_message', ({ messageId, toRoomId }, ack) => {
    const src = db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId);
    if (!src) return typeof ack === 'function' && ack({ error: 'Message not found' });
    const srcRoom = db.prepare('SELECT * FROM rooms WHERE id = ?').get(src.room_id);
    const dstRoom = db.prepare('SELECT * FROM rooms WHERE id = ?').get(toRoomId);
    if (!canAccessRoom(socket.user.id, srcRoom) || !canAccessRoom(socket.user.id, dstRoom)) {
      return typeof ack === 'function' && ack({ error: 'Not allowed' });
    }
    if (srcRoom && !srcRoom.is_dm && srcRoom.is_private && srcRoom.id !== dstRoom.id) {
      return typeof ack === 'function' && ack({ error: 'Messages from a private room cannot be forwarded' });
    }
    if (src.type === 'invite') return typeof ack === 'function' && ack({ error: 'Invitations cannot be forwarded' });
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
    db.prepare('DELETE FROM reactions WHERE message_id = ?').run(messageId);
    db.prepare('DELETE FROM messages WHERE id = ?').run(messageId);
    io.to(String(msg.room_id)).emit('message_deleted', { messageId });
  });

  socket.on('toggle_reaction', ({ messageId, emoji }) => {
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

    const msg = db.prepare('SELECT room_id FROM messages WHERE id = ?').get(messageId);
    if (msg) io.to(String(msg.room_id)).emit('reactions_updated', { messageId, reactions });
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

server.listen(PORT, () => console.log(`Chat server running on http://localhost:${PORT}`));
