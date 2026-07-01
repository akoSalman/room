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

// Auth — single endpoint: login if user exists, register if not
app.post('/auth/signin', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (user) {
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Wrong password' });
    const token = jwt.sign({ id: user.id, username }, JWT_SECRET);
    return res.json({ token, username, isNew: false });
  }
  try {
    const hash = await bcrypt.hash(password, 10);
    const result = db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(username, hash);
    const token = jwt.sign({ id: result.lastInsertRowid, username }, JWT_SECRET);
    res.json({ token, username, isNew: true });
  } catch {
    res.status(409).json({ error: 'Something went wrong, try again' });
  }
});

// Profile update
app.put('/profile', authMiddleware, async (req, res) => {
  const { newUsername, currentPassword, newPassword } = req.body;
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

  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  const token = jwt.sign({ id: updated.id, username: updated.username }, JWT_SECRET);
  res.json({ token, username: updated.username });
});

// Rooms
app.get('/rooms', authMiddleware, (req, res) => {
  const rooms = db.prepare('SELECT * FROM rooms WHERE is_dm = 0 ORDER BY name').all();
  res.json(rooms);
});

app.post('/rooms', authMiddleware, (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Room name required' });
  try {
    const result = db.prepare('INSERT INTO rooms (name, created_by) VALUES (?, ?)').run(name.trim(), req.user.id);
    const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(result.lastInsertRowid);
    io.emit('room_created', room);
    res.json(room);
  } catch {
    res.status(409).json({ error: 'Room already exists' });
  }
});

// Users list (for DMs)
app.get('/users', authMiddleware, (req, res) => {
  const users = db.prepare('SELECT id, username FROM users WHERE id != ? ORDER BY username').all(req.user.id);
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
const MESSAGES_PAGE_SIZE = 30;
app.get('/messages/:roomId', authMiddleware, (req, res) => {
  const before = parseInt(req.query.before);
  const messages = before
    ? db.prepare(`
        SELECT m.*, u.username,
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
        SELECT m.*, u.username,
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
  if (!room.is_dm) return db.prepare('SELECT id FROM users').all().map(u => u.id);
  const parts = room.name.split('__').filter(Boolean);
  if (parts.length !== 3) return [];
  return [parseInt(parts[1]), parseInt(parts[2])];
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
    const { roomId, type, content, filePath, fileName, replyToId } = data;
    const result = db.prepare(`
      INSERT INTO messages (room_id, user_id, type, content, file_path, file_name, reply_to_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(roomId, socket.user.id, type || 'text', content || null, filePath || null, fileName || null, replyToId || null);

    const msg = db.prepare(`
      SELECT m.*, u.username,
        rm.content AS reply_content, rm.type AS reply_type, rm.file_name AS reply_file_name,
        ru.username AS reply_username
      FROM messages m
      JOIN users u ON m.user_id = u.id
      LEFT JOIN messages rm ON m.reply_to_id = rm.id
      LEFT JOIN users ru ON rm.user_id = ru.id
      WHERE m.id = ?
    `).get(result.lastInsertRowid);

    const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(roomId);
    const memberIds = room ? getRoomMemberIds(room) : [];
    memberIds.forEach(id => io.to('user:' + id).emit('message_received', msg));

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
      const roomOnline = [...onlineUsers.values()]
        .filter(u => u.roomId === info.roomId)
        .map(u => u.username);
      io.to(info.roomId).emit('room_online', { users: roomOnline });
    }
  });
});

server.listen(PORT, () => console.log(`Chat server running on http://localhost:${PORT}`));
