let token = localStorage.getItem('token');
let username = localStorage.getItem('username');
let currentRoomId = null;
let socket = null;
let socketReady = false;
let mediaRecorder = null;
let audioChunks = [];
let pickerTarget = null;
let editingMsgId = null;   // currently being edited
let ctxTarget = null;      // { messageId, type }

const EMOJIS = ['👍','❤️','😂','😮','😢','🔥','👏','🎉','🤔','😍','👎','😡'];

// ─── Boot ─────────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  buildEmojiPicker();
  document.addEventListener('click', handleGlobalClick);
  document.addEventListener('contextmenu', e => e.preventDefault()); // block native ctx on mobile
  if (token && username) enterApp();
});

// ─── Auth ─────────────────────────────────────────────────────────────────────
function switchTab(tab) {
  document.getElementById('login-form').classList.toggle('hidden', tab !== 'login');
  document.getElementById('register-form').classList.toggle('hidden', tab !== 'register');
  document.querySelectorAll('.tab-btn').forEach((b, i) => b.classList.toggle('active', (i === 0) === (tab === 'login')));
  document.getElementById('auth-error').textContent = '';
}

async function login() {
  const user = document.getElementById('login-user').value.trim();
  const pass = document.getElementById('login-pass').value;
  if (!user || !pass) return showAuthError('Please enter username and password');
  setAuthLoading(true);
  try {
    const res = await api('/auth/login', 'POST', { username: user, password: pass });
    if (res.error) { showAuthError(res.error); return; }
    saveSession(res.token, res.username);
    enterApp();
  } catch { showAuthError('Connection error — is the server running?'); }
  finally { setAuthLoading(false); }
}

async function register() {
  const user = document.getElementById('reg-user').value.trim();
  const pass = document.getElementById('reg-pass').value;
  if (!user || !pass) return showAuthError('Please enter username and password');
  setAuthLoading(true);
  try {
    const res = await api('/auth/register', 'POST', { username: user, password: pass });
    if (res.error) { showAuthError(res.error); return; }
    saveSession(res.token, res.username);
    enterApp();
  } catch { showAuthError('Connection error — is the server running?'); }
  finally { setAuthLoading(false); }
}

function setAuthLoading(on) {
  const lb = document.getElementById('login-btn');
  const rb = document.getElementById('register-btn');
  if (lb) { lb.disabled = on; lb.textContent = on ? 'Please wait...' : 'Login'; }
  if (rb) { rb.disabled = on; rb.textContent = on ? 'Please wait...' : 'Register'; }
}

function saveSession(t, u) { token = t; username = u; localStorage.setItem('token', t); localStorage.setItem('username', u); }
function showAuthError(msg) { document.getElementById('auth-error').textContent = msg; }

function logout() {
  localStorage.clear(); token = null; username = null; currentRoomId = null; socketReady = false;
  if (socket) { socket.disconnect(); socket = null; }
  show('auth-screen'); hide('app-screen');
}

// ─── App ──────────────────────────────────────────────────────────────────────
async function enterApp() {
  show('app-screen'); hide('auth-screen');
  document.getElementById('current-user-display').textContent = username;
  await connectSocket();
  await loadRooms();
}

function connectSocket() {
  return new Promise((resolve) => {
    if (socket) socket.disconnect();
    socket = io({ auth: { token }, reconnectionAttempts: 5 });
    socket.once('connect', () => { socketReady = true; resolve(); });
    socket.on('connect_error', (err) => { if (err.message === 'Unauthorized') logout(); });
    socket.on('message_received', appendMessage);
    socket.on('message_edited', ({ messageId, content }) => applyEdit(messageId, content));
    socket.on('message_deleted', ({ messageId }) => applyDelete(messageId));
    socket.on('reactions_updated', ({ messageId, reactions }) => renderReactions(messageId, reactions));
    socket.on('room_online', ({ users }) => updateOnlineIndicator(users));
    socket.on('room_created', (room) => addRoomToList(room));
  });
}

// ─── Mobile sidebar ───────────────────────────────────────────────────────────
function openSidebar() {
  document.getElementById('sidebar').classList.add('open');
  document.getElementById('sidebar-overlay').classList.add('open');
}
function closeSidebar() {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebar-overlay').classList.remove('open');
}

// ─── Rooms ────────────────────────────────────────────────────────────────────
async function loadRooms() {
  const rooms = await api('/rooms');
  if (!Array.isArray(rooms)) return;
  document.getElementById('room-list').innerHTML = '';
  rooms.forEach(addRoomToList);
  const general = rooms.find(r => r.name === 'General') || rooms[0];
  if (general) {
    const li = document.querySelector(`[data-room-id="${general.id}"]`);
    if (li) joinRoom(general.id, general.name, li);
  }
}

function addRoomToList(room) {
  if (document.querySelector(`[data-room-id="${room.id}"]`)) return;
  const li = document.createElement('li');
  li.textContent = '# ' + room.name;
  li.dataset.roomId = room.id;
  li.onclick = () => { joinRoom(room.id, room.name, li); closeSidebar(); };
  document.getElementById('room-list').appendChild(li);
}

async function createRoom() {
  const input = document.getElementById('new-room-name');
  const name = input.value.trim();
  if (!name) return;
  const res = await api('/rooms', 'POST', { name });
  if (res.error) return alert(res.error);
  input.value = '';
}

async function joinRoom(roomId, roomName, li) {
  if (currentRoomId === roomId) return;
  cancelEdit();
  currentRoomId = roomId;
  document.querySelectorAll('#room-list li').forEach(el => el.classList.remove('active'));
  li.classList.add('active');
  document.getElementById('room-title').textContent = '# ' + roomName;
  document.getElementById('messages').innerHTML = '';
  updateOnlineIndicator([]);
  socket.emit('join_room', roomId);
  const msgs = await api('/messages/' + roomId);
  if (Array.isArray(msgs)) msgs.forEach(appendMessage);
  scrollBottom();
}

function updateOnlineIndicator(users) {
  const el = document.getElementById('online-indicator');
  el.textContent = users.length ? `● ${users.length} online` : '';
  el.title = users.join(', ');
}

// ─── Send / Edit ──────────────────────────────────────────────────────────────
function handleInputKey(e) {
  if (e.key === 'Enter') sendOrSave();
}

function sendOrSave() {
  if (editingMsgId) saveEdit();
  else sendText();
}

function sendText() {
  const input = document.getElementById('msg-input');
  const content = input.value.trim();
  if (!content || !currentRoomId || !socketReady) return;
  socket.emit('send_message', { roomId: currentRoomId, type: 'text', content });
  input.value = '';
}

// ─── Edit ─────────────────────────────────────────────────────────────────────
function startEdit(messageId) {
  const bubble = document.querySelector(`[data-msg-id="${messageId}"] .msg-bubble`);
  if (!bubble) return;
  editingMsgId = messageId;
  const input = document.getElementById('msg-input');
  input.value = bubble.dataset.text || bubble.textContent;
  input.focus();
  show('edit-banner');
}

function saveEdit() {
  const content = document.getElementById('msg-input').value.trim();
  if (!content || !editingMsgId) return;
  socket.emit('edit_message', { messageId: editingMsgId, content });
  cancelEdit();
}

function cancelEdit() {
  editingMsgId = null;
  document.getElementById('msg-input').value = '';
  hide('edit-banner');
}

function applyEdit(messageId, content) {
  const wrapper = document.querySelector(`[data-msg-id="${messageId}"]`);
  if (!wrapper) return;
  const bubble = wrapper.querySelector('.msg-bubble');
  bubble.dataset.text = content;
  // re-render text keeping the edited tag
  const tag = bubble.querySelector('.edited-tag');
  bubble.textContent = content;
  if (tag) bubble.appendChild(tag);
  else {
    const t = document.createElement('span');
    t.className = 'edited-tag';
    t.textContent = '(edited)';
    bubble.appendChild(t);
  }
}

// ─── Delete ───────────────────────────────────────────────────────────────────
function applyDelete(messageId) {
  const el = document.querySelector(`[data-msg-id="${messageId}"]`);
  if (el) el.remove();
}

// ─── File / Audio ─────────────────────────────────────────────────────────────
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

async function startRecording(e) {
  if (e) e.preventDefault();
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

// ─── Render messages ──────────────────────────────────────────────────────────
function appendMessage(msg) {
  const container = document.getElementById('messages');
  const isMine = msg.username === username;

  const wrapper = document.createElement('div');
  wrapper.className = 'msg-wrapper ' + (isMine ? 'mine' : 'theirs');
  wrapper.dataset.msgId = msg.id;

  // Long-press on mobile to open context menu
  addLongPress(wrapper, () => openCtxMenu(msg.id, msg.type, wrapper));

  if (!isMine) {
    const sender = document.createElement('div');
    sender.className = 'msg-sender';
    sender.textContent = msg.username;
    wrapper.appendChild(sender);
  }

  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';

  if (msg.type === 'text') {
    bubble.dataset.text = msg.content;
    bubble.textContent = msg.content;
    if (msg.edited) {
      const tag = document.createElement('span');
      tag.className = 'edited-tag';
      tag.textContent = '(edited)';
      bubble.appendChild(tag);
    }
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

  // Footer row: time + action buttons
  const footer = document.createElement('div');
  footer.className = 'msg-footer';

  const time = document.createElement('span');
  time.className = 'msg-time';
  time.textContent = new Date(msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  footer.appendChild(time);

  // React button
  const reactBtn = document.createElement('button');
  reactBtn.className = 'react-btn';
  reactBtn.textContent = '😊';
  reactBtn.title = 'React';
  reactBtn.onclick = (e) => { e.stopPropagation(); showEmojiPicker(msg.id, reactBtn, wrapper); };
  footer.appendChild(reactBtn);

  // Edit button (text only)
  if (msg.type === 'text') {
    const editBtn = document.createElement('button');
    editBtn.className = 'msg-action-btn';
    editBtn.title = 'Edit';
    editBtn.textContent = '✏️';
    editBtn.onclick = (e) => { e.stopPropagation(); startEdit(msg.id); };
    footer.appendChild(editBtn);
  }

  // Delete button
  const delBtn = document.createElement('button');
  delBtn.className = 'msg-action-btn delete';
  delBtn.title = 'Delete';
  delBtn.textContent = '🗑';
  delBtn.onclick = (e) => { e.stopPropagation(); confirmDelete(msg.id); };
  footer.appendChild(delBtn);

  wrapper.appendChild(footer);

  const reactionsRow = document.createElement('div');
  reactionsRow.className = 'reactions-row';
  reactionsRow.id = 'reactions-' + msg.id;
  wrapper.appendChild(reactionsRow);

  container.appendChild(wrapper);
  scrollBottom();
}

function confirmDelete(messageId) {
  if (!confirm('Delete this message?')) return;
  socket.emit('delete_message', { messageId });
}

// ─── Context menu (long-press on mobile) ──────────────────────────────────────
function openCtxMenu(messageId, type, wrapperEl) {
  ctxTarget = { messageId, type };
  const menu = document.getElementById('ctx-menu');
  // Show/hide edit option based on type
  menu.querySelectorAll('button')[1].style.display = type === 'text' ? '' : 'none';
  menu.classList.remove('hidden');

  // Position near the wrapper
  const rect = wrapperEl.getBoundingClientRect();
  const mw = 160, mh = 120;
  let left = rect.left;
  let top = rect.bottom + 4;
  if (left + mw > window.innerWidth) left = window.innerWidth - mw - 8;
  if (top + mh > window.innerHeight) top = rect.top - mh - 4;
  menu.style.left = Math.max(4, left) + 'px';
  menu.style.top = Math.max(4, top) + 'px';
}

function closeCtxMenu() {
  document.getElementById('ctx-menu').classList.add('hidden');
  ctxTarget = null;
}

function ctxReact() {
  if (!ctxTarget) return;
  const wrapper = document.querySelector(`[data-msg-id="${ctxTarget.messageId}"]`);
  const btn = wrapper?.querySelector('.react-btn');
  closeCtxMenu();
  if (btn && wrapper) showEmojiPicker(ctxTarget.messageId, btn, wrapper);
}

function ctxEdit() {
  if (!ctxTarget) return;
  const id = ctxTarget.messageId;
  closeCtxMenu();
  startEdit(id);
}

function ctxDelete() {
  if (!ctxTarget) return;
  const id = ctxTarget.messageId;
  closeCtxMenu();
  confirmDelete(id);
}

// Long-press helper (mobile)
function addLongPress(el, cb) {
  let timer;
  el.addEventListener('touchstart', () => { timer = setTimeout(cb, 500); }, { passive: true });
  el.addEventListener('touchend', () => clearTimeout(timer));
  el.addEventListener('touchmove', () => clearTimeout(timer));
}

// ─── Emoji Reactions ──────────────────────────────────────────────────────────
function buildEmojiPicker() {
  const list = document.getElementById('emoji-list');
  EMOJIS.forEach(emoji => {
    const span = document.createElement('span');
    span.textContent = emoji;
    span.onclick = () => pickEmoji(emoji);
    list.appendChild(span);
  });
}

function showEmojiPicker(messageId, btn, wrapper) {
  const picker = document.getElementById('emoji-picker');
  if (pickerTarget?.messageId === messageId && !picker.classList.contains('hidden')) {
    hideEmojiPicker(); return;
  }
  document.querySelectorAll('.msg-wrapper.show-react').forEach(el => el.classList.remove('show-react'));
  wrapper.classList.add('show-react');
  pickerTarget = { messageId };
  picker.classList.remove('hidden');

  const rect = btn.getBoundingClientRect();
  const pw = 240, ph = 90;
  let left = rect.left;
  let top = rect.top - ph - 8;
  if (left + pw > window.innerWidth) left = window.innerWidth - pw - 8;
  if (top < 8) top = rect.bottom + 8;
  picker.style.left = left + 'px';
  picker.style.top = top + 'px';
}

function hideEmojiPicker() {
  document.getElementById('emoji-picker').classList.add('hidden');
  document.querySelectorAll('.msg-wrapper.show-react').forEach(el => el.classList.remove('show-react'));
  pickerTarget = null;
}

function pickEmoji(emoji) {
  if (!pickerTarget) return;
  socket.emit('toggle_reaction', { messageId: pickerTarget.messageId, emoji });
  hideEmojiPicker();
}

function renderReactions(messageId, reactions) {
  const row = document.getElementById('reactions-' + messageId);
  if (!row) return;
  row.innerHTML = '';
  const groups = {};
  reactions.forEach(r => {
    if (!groups[r.emoji]) groups[r.emoji] = { count: 0, users: [], mine: false };
    groups[r.emoji].count++;
    groups[r.emoji].users.push(r.username);
    if (r.username === username) groups[r.emoji].mine = true;
  });
  Object.entries(groups).forEach(([emoji, data]) => {
    const chip = document.createElement('div');
    chip.className = 'reaction-chip' + (data.mine ? ' mine' : '');
    chip.title = data.users.join(', ');
    chip.innerHTML = `${emoji}<span class="count">${data.count}</span>`;
    chip.onclick = () => socket.emit('toggle_reaction', { messageId, emoji });
    row.appendChild(chip);
  });
}

// ─── Global click handler ─────────────────────────────────────────────────────
function handleGlobalClick(e) {
  const picker = document.getElementById('emoji-picker');
  const menu = document.getElementById('ctx-menu');

  if (!picker.classList.contains('hidden') && !picker.contains(e.target) && !e.target.classList.contains('react-btn')) {
    hideEmojiPicker();
  }
  if (!menu.classList.contains('hidden') && !menu.contains(e.target)) {
    closeCtxMenu();
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function appendSystem(text) {
  const el = document.createElement('div');
  el.className = 'system-msg';
  el.textContent = text;
  document.getElementById('messages').appendChild(el);
  scrollBottom();
}

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
