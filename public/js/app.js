let token = localStorage.getItem('token');
let username = localStorage.getItem('username');
let currentRoomId = null;
let socket = null;
let mediaRecorder = null;
let audioChunks = [];

// ─── Boot ───────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  if (token && username) enterApp();
});

// ─── Auth ────────────────────────────────────────────────────────────────────
function switchTab(tab) {
  document.getElementById('login-form').classList.toggle('hidden', tab !== 'login');
  document.getElementById('register-form').classList.toggle('hidden', tab !== 'register');
  document.querySelectorAll('.tab-btn').forEach((b, i) => b.classList.toggle('active', (i === 0) === (tab === 'login')));
  document.getElementById('auth-error').textContent = '';
}

async function login() {
  const user = document.getElementById('login-user').value.trim();
  const pass = document.getElementById('login-pass').value;
  const res = await api('/auth/login', 'POST', { username: user, password: pass });
  if (res.error) return showAuthError(res.error);
  saveSession(res.token, res.username);
  enterApp();
}

async function register() {
  const user = document.getElementById('reg-user').value.trim();
  const pass = document.getElementById('reg-pass').value;
  const res = await api('/auth/register', 'POST', { username: user, password: pass });
  if (res.error) return showAuthError(res.error);
  saveSession(res.token, res.username);
  enterApp();
}

function saveSession(t, u) { token = t; username = u; localStorage.setItem('token', t); localStorage.setItem('username', u); }
function showAuthError(msg) { document.getElementById('auth-error').textContent = msg; }

function logout() {
  localStorage.clear(); token = null; username = null; currentRoomId = null;
  if (socket) { socket.disconnect(); socket = null; }
  show('auth-screen'); hide('app-screen');
}

// ─── App Init ─────────────────────────────────────────────────────────────────
async function enterApp() {
  show('app-screen'); hide('auth-screen');
  document.getElementById('current-user-display').textContent = username;
  connectSocket();
  await loadRooms();
}

function connectSocket() {
  socket = io({ auth: { token } });
  socket.on('connect_error', () => logout());
  socket.on('message_received', appendMessage);
  socket.on('user_online', ({ username: u }) => appendSystem(`${u} joined`));
  socket.on('user_offline', ({ username: u }) => appendSystem(`${u} left`));
  socket.on('room_created', (room) => addRoomToList(room));
}

// ─── Rooms ────────────────────────────────────────────────────────────────────
async function loadRooms() {
  const rooms = await api('/rooms');
  document.getElementById('room-list').innerHTML = '';
  rooms.forEach(addRoomToList);
}

function addRoomToList(room) {
  const existing = document.querySelector(`[data-room-id="${room.id}"]`);
  if (existing) return;
  const li = document.createElement('li');
  li.textContent = '# ' + room.name;
  li.dataset.roomId = room.id;
  li.onclick = () => joinRoom(room.id, room.name, li);
  document.getElementById('room-list').appendChild(li);
}

async function createRoom() {
  const name = document.getElementById('new-room-name').value.trim();
  if (!name) return;
  const res = await api('/rooms', 'POST', { name });
  if (res.error) return alert(res.error);
  document.getElementById('new-room-name').value = '';
}

async function joinRoom(roomId, roomName, li) {
  if (currentRoomId === roomId) return;
  currentRoomId = roomId;
  document.querySelectorAll('#room-list li').forEach(el => el.classList.remove('active'));
  li.classList.add('active');
  document.getElementById('room-title').textContent = '# ' + roomName;
  document.getElementById('messages').innerHTML = '';
  socket.emit('join_room', roomId);
  const msgs = await api('/messages/' + roomId);
  msgs.forEach(appendMessage);
  scrollBottom();
}

// ─── Messaging ────────────────────────────────────────────────────────────────
function sendText() {
  const input = document.getElementById('msg-input');
  const content = input.value.trim();
  if (!content || !currentRoomId) return;
  socket.emit('send_message', { roomId: currentRoomId, type: 'text', content });
  input.value = '';
}

async function sendFile() {
  const file = document.getElementById('file-input').files[0];
  if (!file || !currentRoomId) return;
  const form = new FormData();
  form.append('file', file);
  const res = await fetch('/upload', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: form }).then(r => r.json());
  if (res.error) return alert(res.error);
  const type = file.type.startsWith('audio/') ? 'audio' : file.type.startsWith('image/') ? 'image' : 'file';
  socket.emit('send_message', { roomId: currentRoomId, type, content: null, filePath: res.url, fileName: res.name || file.name });
  document.getElementById('file-input').value = '';
}

// ─── Audio Recording ──────────────────────────────────────────────────────────
async function startRecording() {
  if (!currentRoomId) return;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioChunks = [];
    mediaRecorder = new MediaRecorder(stream);
    mediaRecorder.ondataavailable = e => audioChunks.push(e.data);
    mediaRecorder.onstop = uploadAudio;
    mediaRecorder.start();
    document.getElementById('record-btn').classList.add('recording');
  } catch { alert('Microphone access denied'); }
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
    mediaRecorder.stream.getTracks().forEach(t => t.stop());
    document.getElementById('record-btn').classList.remove('recording');
  }
}

async function uploadAudio() {
  const blob = new Blob(audioChunks, { type: 'audio/webm' });
  const form = new FormData();
  form.append('file', blob, 'voice-' + Date.now() + '.webm');
  const res = await fetch('/upload', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: form }).then(r => r.json());
  if (res.error) return alert(res.error);
  socket.emit('send_message', { roomId: currentRoomId, type: 'audio', filePath: res.url, fileName: 'Voice message' });
}

// ─── Render Messages ──────────────────────────────────────────────────────────
function appendMessage(msg) {
  const container = document.getElementById('messages');
  const isMine = msg.username === username;
  const wrapper = document.createElement('div');
  wrapper.className = 'msg-wrapper ' + (isMine ? 'mine' : 'theirs');

  if (!isMine) {
    const sender = document.createElement('div');
    sender.className = 'msg-sender';
    sender.textContent = msg.username;
    wrapper.appendChild(sender);
  }

  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';

  if (msg.type === 'text') {
    bubble.textContent = msg.content;
  } else if (msg.type === 'image') {
    const img = document.createElement('img');
    img.src = msg.file_path;
    img.onclick = () => window.open(msg.file_path, '_blank');
    bubble.appendChild(img);
  } else if (msg.type === 'audio') {
    const audio = document.createElement('audio');
    audio.controls = true;
    audio.src = msg.file_path;
    bubble.appendChild(audio);
  } else {
    const a = document.createElement('a');
    a.className = 'file-link';
    a.href = msg.file_path;
    a.download = msg.file_name || 'file';
    a.target = '_blank';
    a.innerHTML = '📄 ' + (msg.file_name || 'Download file');
    bubble.appendChild(a);
  }

  wrapper.appendChild(bubble);

  const time = document.createElement('div');
  time.className = 'msg-time';
  time.textContent = new Date(msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  wrapper.appendChild(time);

  container.appendChild(wrapper);
  scrollBottom();
}

function appendSystem(text) {
  const el = document.createElement('div');
  el.className = 'system-msg';
  el.textContent = text;
  document.getElementById('messages').appendChild(el);
  scrollBottom();
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function scrollBottom() {
  const m = document.getElementById('messages');
  m.scrollTop = m.scrollHeight;
}

function show(id) { document.getElementById(id).classList.remove('hidden'); }
function hide(id) { document.getElementById(id).classList.add('hidden'); }

async function api(path, method = 'GET', body = null) {
  const opts = { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(path, opts);
  return res.json();
}
