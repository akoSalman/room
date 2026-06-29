let token = localStorage.getItem('token');
let username = localStorage.getItem('username');
let currentRoomId = null;
let socket = null;
let socketReady = false;
let mediaRecorder = null;
let audioChunks = [];
let isRecording = false;
let pickerTarget = null;
let editingMsgId = null;
let ctxTarget = null;
let editingRoomId = null;

// Typing state
let typingTimer = null;
let isTyping = false;
const typingUsers = new Set();

// Online users
let onlineUsers = [];

// Unread counts per roomId
const unreadCounts = {};

// Whether DM divider has been inserted
let dmDividerInserted = false;

function getSupportedMimeType() {
  const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'];
  for (const t of types) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(t)) return t;
  }
  return '';
}

const EMOJIS = ['👍','❤️','😂','😮','😢','🔥','👏','🎉','🤔','😍','👎','😡'];

// ─── Boot ─────────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  buildEmojiPicker();
  document.addEventListener('click', handleGlobalClick);
  document.addEventListener('contextmenu', e => e.preventDefault());
  if (token && username) enterApp();
});

// ─── Auth ─────────────────────────────────────────────────────────────────────
function switchTab(tab) {
  document.getElementById('login-form').classList.toggle('hidden', tab !== 'login');
  document.getElementById('register-form').classList.toggle('hidden', tab !== 'register');
  document.getElementById('tab-login').classList.toggle('active', tab === 'login');
  document.getElementById('tab-reg').classList.toggle('active', tab === 'register');
  document.getElementById('auth-error').textContent = '';
}

async function login() {
  const user = document.getElementById('login-user').value.trim();
  const pass = document.getElementById('login-pass').value;
  if (!user || !pass) return showAuthError('Please enter username and password');
  setAuthLoading(true, 'login');
  try {
    const res = await api('/auth/login', 'POST', { username: user, password: pass });
    if (res.error) return showAuthError(res.error);
    saveSession(res.token, res.username);
    enterApp();
  } catch { showAuthError('Connection error — is the server running?'); }
  finally { setAuthLoading(false, 'login'); }
}

async function register() {
  const user = document.getElementById('reg-user').value.trim();
  const pass = document.getElementById('reg-pass').value;
  if (!user || !pass) return showAuthError('Please enter username and password');
  setAuthLoading(true, 'register');
  try {
    const res = await api('/auth/register', 'POST', { username: user, password: pass });
    if (res.error) return showAuthError(res.error);
    saveSession(res.token, res.username);
    enterApp();
  } catch { showAuthError('Connection error — is the server running?'); }
  finally { setAuthLoading(false, 'register'); }
}

function setAuthLoading(on, which) {
  const btn = document.getElementById(which === 'login' ? 'login-btn' : 'register-btn');
  if (!btn) return;
  btn.disabled = on;
  btn.textContent = on ? 'Please wait…' : (which === 'login' ? 'Sign In' : 'Create Account');
}

function saveSession(t, u) {
  token = t; username = u;
  localStorage.setItem('token', t);
  localStorage.setItem('username', u);
}
function showAuthError(msg) { document.getElementById('auth-error').textContent = msg; }

function logout() {
  localStorage.clear(); token = null; username = null; currentRoomId = null; socketReady = false;
  if (socket) { socket.disconnect(); socket = null; }
  closeProfile();
  document.body.classList.remove('in-app');
  show('auth-screen'); hide('app-screen');
}

// ─── App ──────────────────────────────────────────────────────────────────────
async function enterApp() {
  show('app-screen'); hide('auth-screen');
  document.body.classList.add('in-app');
  dmDividerInserted = false;
  setAvatarInitials(username);
  document.getElementById('current-user-display').textContent = username;
  await connectSocket();
  await loadRooms();
  await loadDMRooms();
}

function setAvatarInitials(name) {
  const initials = (name || '?').slice(0, 2).toUpperCase();
  const sa = document.getElementById('sidebar-avatar');
  const pb = document.getElementById('profile-avatar-big');
  if (sa) sa.textContent = initials;
  if (pb) pb.textContent = initials;
  if (document.getElementById('profile-name-display'))
    document.getElementById('profile-name-display').textContent = name;
}

function connectSocket() {
  return new Promise((resolve) => {
    if (socket) socket.disconnect();
    socket = io({ auth: { token }, reconnectionAttempts: 5 });
    socket.once('connect', () => { socketReady = true; resolve(); });
    socket.on('connect_error', (err) => { if (err.message === 'Unauthorized') logout(); });
    socket.on('message_received', (msg) => {
      appendMessage(msg);
      // Increment unread if this isn't the active room
      if (String(msg.room_id) !== String(currentRoomId)) {
        unreadCounts[msg.room_id] = (unreadCounts[msg.room_id] || 0) + 1;
        updateUnreadBadge(msg.room_id);
      }
    });
    socket.on('message_edited', ({ messageId, content }) => applyEdit(messageId, content));
    socket.on('message_deleted', ({ messageId }) => applyDelete(messageId));
    socket.on('reactions_updated', ({ messageId, reactions }) => renderReactions(messageId, reactions));
    socket.on('room_online', ({ users }) => updateOnlineUsers(users));
    socket.on('room_created', (room) => addRoomToList(room));
    socket.on('room_deleted', ({ roomId }) => removeRoomFromList(roomId));
    socket.on('room_updated', (room) => updateRoomInList(room));
    socket.on('user_typing', ({ username: u }) => showTyping(u));
    socket.on('user_stopped_typing', ({ username: u }) => hideTyping(u));
    socket.on('dm_activity', ({ room }) => ensureDMInSidebar(room));
  });
}

// ─── Unread badges ────────────────────────────────────────────────────────────
function updateUnreadBadge(roomId) {
  const li = document.querySelector(`[data-room-id="${roomId}"]`);
  if (!li) return;
  let badge = li.querySelector('.unread-badge');
  const count = unreadCounts[roomId] || 0;
  if (count === 0) {
    badge?.remove();
    return;
  }
  if (!badge) {
    badge = document.createElement('span');
    badge.className = 'unread-badge';
    li.appendChild(badge);
  }
  badge.textContent = count > 99 ? '99+' : count;
}

function clearUnread(roomId) {
  delete unreadCounts[roomId];
  updateUnreadBadge(roomId);
}

// ─── Typing ───────────────────────────────────────────────────────────────────
function onTypingInput() {
  if (!currentRoomId || !socketReady) return;
  if (!isTyping) {
    isTyping = true;
    socket.emit('typing_start', { roomId: currentRoomId });
  }
  clearTimeout(typingTimer);
  typingTimer = setTimeout(() => {
    isTyping = false;
    socket.emit('typing_stop', { roomId: currentRoomId });
  }, 1500);
}

function showTyping(user) {
  typingUsers.add(user);
  renderTypingOverlay();
}
function hideTyping(user) {
  typingUsers.delete(user);
  renderTypingOverlay();
}
function renderTypingOverlay() {
  const overlay = document.getElementById('typing-overlay');
  if (typingUsers.size === 0) { overlay.classList.add('hidden'); return; }
  const names = [...typingUsers];
  const text = names.length === 1
    ? `${names[0]} is typing`
    : names.length === 2
      ? `${names[0]} and ${names[1]} are typing`
      : `${names[0]} and ${names.length - 1} others are typing`;
  overlay.innerHTML = `<span>${text}</span><span class="typing-dots"><span></span><span></span><span></span></span>`;
  overlay.classList.remove('hidden');
}

// ─── Sidebar ──────────────────────────────────────────────────────────────────
function openSidebar() {
  document.getElementById('sidebar').classList.add('open');
  document.getElementById('sidebar').classList.remove('collapsed');
  document.getElementById('sidebar-overlay').classList.add('open');
}
function closeSidebar() {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebar-overlay').classList.remove('open');
}
function collapseSidebar() {
  document.getElementById('sidebar').classList.add('collapsed');
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebar-overlay').classList.remove('open');
  document.getElementById('collapse-btn').textContent = '›';
}
function expandSidebar() {
  document.getElementById('sidebar').classList.remove('collapsed');
  document.getElementById('collapse-btn').textContent = '‹';
}
function toggleSidebar() {
  document.getElementById('sidebar').classList.contains('collapsed') ? expandSidebar() : collapseSidebar();
}
function isMobile() { return window.innerWidth <= 640; }

// ─── Profile modal ────────────────────────────────────────────────────────────
function openProfile() {
  if (document.getElementById('sidebar').classList.contains('collapsed')) return;
  document.getElementById('prof-username').value = '';
  document.getElementById('prof-cur-pass').value = '';
  document.getElementById('prof-new-pass').value = '';
  document.getElementById('profile-error').textContent = '';
  document.getElementById('profile-success').textContent = '';
  setAvatarInitials(username);
  show('profile-modal');
}
function closeProfile() { hide('profile-modal'); }

async function saveProfile() {
  const newUsername = document.getElementById('prof-username').value.trim();
  const currentPassword = document.getElementById('prof-cur-pass').value;
  const newPassword = document.getElementById('prof-new-pass').value;

  document.getElementById('profile-error').textContent = '';
  document.getElementById('profile-success').textContent = '';

  if (!newUsername && !newPassword) {
    return document.getElementById('profile-error').textContent = 'Nothing to update';
  }
  if (!currentPassword) {
    return document.getElementById('profile-error').textContent = 'Current password is required';
  }

  const res = await api('/profile', 'PUT', { newUsername: newUsername || undefined, currentPassword, newPassword: newPassword || undefined });
  if (res.error) {
    document.getElementById('profile-error').textContent = res.error;
    return;
  }
  saveSession(res.token, res.username);
  username = res.username;
  setAvatarInitials(res.username);
  document.getElementById('current-user-display').textContent = res.username;
  document.getElementById('prof-cur-pass').value = '';
  document.getElementById('prof-new-pass').value = '';
  document.getElementById('prof-username').value = '';
  document.getElementById('profile-success').textContent = 'Profile updated successfully';
}

// ─── Rooms ────────────────────────────────────────────────────────────────────
async function loadRooms() {
  const rooms = await api('/rooms');
  if (!Array.isArray(rooms)) return;
  document.getElementById('room-list').innerHTML = '';
  dmDividerInserted = false;
  rooms.forEach(addRoomToList);
  const general = rooms.find(r => r.name === 'General') || rooms[0];
  if (general) {
    const li = document.querySelector(`[data-room-id="${general.id}"]`);
    if (li) { await joinRoom(general.id, general.name, li); collapseSidebar(); }
  }
}

function addRoomToList(room) {
  if (document.querySelector(`[data-room-id="${room.id}"]`)) return;
  const li = document.createElement('li');
  li.dataset.roomId = room.id;
  li.title = room.name;

  const icon = document.createElement('span');
  icon.className = 'room-icon'; icon.textContent = '#';

  const label = document.createElement('span');
  label.className = 'room-label'; label.textContent = room.name;

  li.appendChild(icon);
  li.appendChild(label);

  if (room.created_by) {
    const actions = document.createElement('div');
    actions.className = 'room-actions';

    const editBtn = document.createElement('button');
    editBtn.className = 'room-action-btn';
    editBtn.title = 'Rename room';
    editBtn.textContent = '✏️';
    editBtn.onclick = (e) => { e.stopPropagation(); openRoomEdit(room.id, room.name); };

    const delBtn = document.createElement('button');
    delBtn.className = 'room-action-btn del';
    delBtn.title = 'Delete room';
    delBtn.textContent = '🗑';
    delBtn.onclick = (e) => { e.stopPropagation(); confirmDeleteRoom(room.id, room.name); };

    actions.appendChild(editBtn);
    actions.appendChild(delBtn);
    li.appendChild(actions);

    li.dataset.createdBy = room.created_by;
    if (!isRoomOwner(room)) {
      actions.style.display = 'none';
      actions.classList.add('not-owner');
    }
  }

  li.onclick = () => { joinRoom(room.id, room.name, li); isMobile() ? closeSidebar() : collapseSidebar(); };
  document.getElementById('room-list').appendChild(li);
}

function isRoomOwner(room) {
  return room.created_by && String(room.created_by) === String(getUserId());
}

function getUserId() {
  if (!token) return null;
  try {
    const payload = JSON.parse(atob(token.split('.')[1]));
    return payload.id;
  } catch { return null; }
}

function removeRoomFromList(roomId) {
  document.querySelector(`[data-room-id="${roomId}"]`)?.remove();
  if (currentRoomId === roomId) {
    currentRoomId = null;
    document.getElementById('room-title').textContent = 'Select a room';
    document.getElementById('messages').innerHTML = '';
  }
}

function updateRoomInList(room) {
  const li = document.querySelector(`[data-room-id="${room.id}"]`);
  if (!li) return;
  const label = li.querySelector('.room-label');
  if (label) label.textContent = room.name;
  li.title = room.name;
  if (currentRoomId === room.id) {
    document.getElementById('room-title').textContent = '# ' + room.name;
  }
}

async function createRoom() {
  const input = document.getElementById('new-room-name');
  const name = input.value.trim();
  if (!name) return;
  const res = await api('/rooms', 'POST', { name });
  if (res.error) return alert(res.error);
  input.value = '';
}

// ─── Room edit/delete ────────────────────────────────────────────────────────
function openRoomEdit(roomId, currentName) {
  editingRoomId = roomId;
  document.getElementById('room-edit-name').value = currentName;
  document.getElementById('room-edit-error').textContent = '';
  show('room-edit-modal');
}
function closeRoomEdit() {
  editingRoomId = null;
  hide('room-edit-modal');
}
function saveRoomEdit() {
  const name = document.getElementById('room-edit-name').value.trim();
  if (!name) return;
  if (!editingRoomId) return;
  socket.emit('edit_room', { roomId: editingRoomId, name });
  closeRoomEdit();
}
function confirmDeleteRoom(roomId, roomName) {
  if (!confirm(`Delete room "${roomName}"? All messages will be lost.`)) return;
  socket.emit('delete_room', { roomId });
}

// ─── DM rooms ────────────────────────────────────────────────────────────────
async function loadDMRooms() {
  const rooms = await api('/dm-rooms');
  if (!Array.isArray(rooms)) return;
  rooms.forEach(r => addDMToSidebar(r, r.other_username));
}

function ensureDMDivider() {
  if (dmDividerInserted) return;
  dmDividerInserted = true;
  const divider = document.createElement('li');
  divider.className = 'dm-divider';
  divider.textContent = 'Direct Messages';
  divider.id = 'dm-divider';
  document.getElementById('room-list').appendChild(divider);
}

function addDMToSidebar(room, otherUsername) {
  if (!otherUsername) return;
  if (document.querySelector(`[data-room-id="${room.id}"]`)) return;

  ensureDMDivider();

  const li = document.createElement('li');
  li.dataset.roomId = room.id;
  li.dataset.isDm = '1';
  li.title = otherUsername;

  const icon = document.createElement('span');
  icon.className = 'room-icon'; icon.textContent = '👤';

  const label = document.createElement('span');
  label.className = 'room-label'; label.textContent = otherUsername;

  li.appendChild(icon);
  li.appendChild(label);
  li.onclick = () => {
    joinRoom(room.id, otherUsername, li, true);
    isMobile() ? closeSidebar() : collapseSidebar();
  };
  document.getElementById('room-list').appendChild(li);
}

function ensureDMInSidebar(room) {
  if (document.querySelector(`[data-room-id="${room.id}"]`)) return;
  api('/dm-rooms').then(rooms => {
    if (!Array.isArray(rooms)) return;
    const found = rooms.find(r => r.id === room.id);
    if (found) addDMToSidebar(found, found.other_username);
  });
}

async function openDM(otherUsername) {
  closeOnlinePanel();
  const users = await api('/users');
  if (!Array.isArray(users)) return;
  const other = users.find(u => u.username === otherUsername);
  if (!other) return;

  const res = await api('/dm/' + other.id, 'POST');
  if (res.error) return alert(res.error);

  addDMToSidebar(res, res.otherUsername || otherUsername);

  const li = document.querySelector(`[data-room-id="${res.id}"]`);
  if (li) {
    joinRoom(res.id, res.otherUsername || otherUsername, li, true);
    isMobile() ? closeSidebar() : collapseSidebar();
  }
}

async function joinRoom(roomId, roomName, li, isDM = false) {
  if (currentRoomId === roomId) return;
  cancelEdit();
  stopTypingSignal();
  if (isRecording) stopRecording();
  typingUsers.clear(); renderTypingOverlay();
  currentRoomId = roomId;
  clearUnread(roomId);
  document.querySelectorAll('#room-list li').forEach(el => el.classList.remove('active'));
  li.classList.add('active');
  document.getElementById('room-title').textContent = (isDM ? '💬 ' : '# ') + roomName;
  document.getElementById('messages').innerHTML = '';
  document.getElementById('online-indicator').classList.add('hidden');
  socket.emit('join_room', roomId);
  const msgs = await api('/messages/' + roomId);
  if (Array.isArray(msgs)) msgs.forEach(appendMessage);
  scrollBottom();
}

// ─── Online users ─────────────────────────────────────────────────────────────
function updateOnlineUsers(users) {
  onlineUsers = users;
  const badge = document.getElementById('online-indicator');
  if (!users.length) { badge.classList.add('hidden'); return; }
  badge.classList.remove('hidden');
  badge.textContent = `● ${users.length} online`;
  if (!document.getElementById('online-panel').classList.contains('hidden')) renderOnlinePanel();
}

function toggleOnlinePanel() {
  const panel = document.getElementById('online-panel');
  panel.classList.contains('hidden') ? openOnlinePanel() : closeOnlinePanel();
}
function openOnlinePanel() {
  renderOnlinePanel();
  document.getElementById('online-panel').classList.remove('hidden');
}
function closeOnlinePanel() { document.getElementById('online-panel').classList.add('hidden'); }
function renderOnlinePanel() {
  const ul = document.getElementById('online-list');
  ul.innerHTML = '';
  onlineUsers.forEach(u => {
    const li = document.createElement('li');
    li.textContent = u;
    if (u !== username) {
      li.title = `Message ${u}`;
      li.onclick = () => openDM(u);
    }
    ul.appendChild(li);
  });
}

// ─── Messaging ────────────────────────────────────────────────────────────────
function handleInputKey(e) { if (e.key === 'Enter') sendOrSave(); }
function sendOrSave() { editingMsgId ? saveEdit() : sendText(); }

function sendText() {
  const input = document.getElementById('msg-input');
  const content = input.value.trim();
  if (!content || !currentRoomId || !socketReady) return;
  stopTypingSignal();
  socket.emit('send_message', { roomId: currentRoomId, type: 'text', content });
  input.value = '';
}

function stopTypingSignal() {
  if (isTyping) {
    isTyping = false;
    clearTimeout(typingTimer);
    if (currentRoomId) socket.emit('typing_stop', { roomId: currentRoomId });
  }
}

// ─── Edit ─────────────────────────────────────────────────────────────────────
function startEdit(messageId) {
  const bubble = document.querySelector(`[data-msg-id="${messageId}"] .msg-bubble`);
  if (!bubble) return;
  editingMsgId = messageId;
  const input = document.getElementById('msg-input');
  input.value = bubble.dataset.text || bubble.textContent.replace('(edited)', '').trim();
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
  const tag = bubble.querySelector('.edited-tag');
  bubble.textContent = content;
  if (tag) bubble.appendChild(tag);
  else {
    const t = document.createElement('span');
    t.className = 'edited-tag'; t.textContent = '(edited)';
    bubble.appendChild(t);
  }
}

// ─── Delete ───────────────────────────────────────────────────────────────────
function applyDelete(messageId) {
  document.querySelector(`[data-msg-id="${messageId}"]`)?.remove();
}
function confirmDelete(messageId) {
  if (!confirm('Delete this message?')) return;
  socket.emit('delete_message', { messageId });
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

async function toggleRecording() {
  if (isRecording) {
    stopRecording();
  } else {
    await startRecording();
  }
}

async function startRecording() {
  if (!currentRoomId) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    return alert('Audio recording is not supported in this browser.');
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mimeType = getSupportedMimeType();
    const options = mimeType ? { mimeType } : {};
    audioChunks = [];
    mediaRecorder = new MediaRecorder(stream, options);
    mediaRecorder.ondataavailable = e => { if (e.data && e.data.size > 0) audioChunks.push(e.data); };
    mediaRecorder.onstop = uploadAudio;
    mediaRecorder.start(100);
    isRecording = true;
    document.getElementById('record-btn').classList.add('recording');
    document.getElementById('record-btn').title = 'Tap to stop recording';
  } catch (err) {
    alert('Microphone access denied. Please allow microphone in browser settings.');
  }
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
    mediaRecorder.stream.getTracks().forEach(t => t.stop());
  }
  isRecording = false;
  document.getElementById('record-btn').classList.remove('recording');
  document.getElementById('record-btn').title = 'Record voice message';
}

async function uploadAudio() {
  if (audioChunks.length === 0) return;
  const mimeType = getSupportedMimeType() || 'audio/webm';
  const ext = mimeType.includes('mp4') ? 'mp4' : mimeType.includes('ogg') ? 'ogg' : 'webm';
  const blob = new Blob(audioChunks, { type: mimeType });
  if (blob.size < 1000) return;
  const form = new FormData();
  form.append('file', blob, `voice-${Date.now()}.${ext}`);
  const res = await fetch('/upload', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: form }).then(r => r.json());
  if (res.error) return alert(res.error);
  socket.emit('send_message', { roomId: currentRoomId, type: 'audio', filePath: res.url, fileName: 'Voice message' });
}

// ─── Render messages ──────────────────────────────────────────────────────────
function appendMessage(msg) {
  // Don't render messages that don't belong to the current room
  if (String(msg.room_id) !== String(currentRoomId)) return;

  const container = document.getElementById('messages');
  const isMine = msg.username === username;

  const wrapper = document.createElement('div');
  wrapper.className = 'msg-wrapper ' + (isMine ? 'mine' : 'theirs');
  wrapper.dataset.msgId = msg.id;
  addLongPress(wrapper, () => openCtxMenu(msg.id, msg.type, isMine, wrapper));

  if (!isMine) {
    const sender = document.createElement('div');
    sender.className = 'msg-sender'; sender.textContent = msg.username;
    wrapper.appendChild(sender);
  }

  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';

  if (msg.type === 'text') {
    bubble.dataset.text = msg.content;
    bubble.textContent = msg.content;
    if (msg.edited) {
      const tag = document.createElement('span');
      tag.className = 'edited-tag'; tag.textContent = '(edited)';
      bubble.appendChild(tag);
    }
  } else if (msg.type === 'image') {
    const img = document.createElement('img');
    img.src = msg.file_path;
    img.onclick = () => window.open(msg.file_path, '_blank');
    bubble.appendChild(img);
  } else if (msg.type === 'audio') {
    const audio = document.createElement('audio');
    audio.controls = true; audio.src = msg.file_path;
    bubble.appendChild(audio);
  } else {
    const a = document.createElement('a');
    a.className = 'file-link'; a.href = msg.file_path;
    a.download = msg.file_name || 'file'; a.target = '_blank';
    a.innerHTML = '📄 ' + (msg.file_name || 'Download file');
    bubble.appendChild(a);
  }
  wrapper.appendChild(bubble);

  const footer = document.createElement('div');
  footer.className = 'msg-footer';

  const time = document.createElement('span');
  time.className = 'msg-time';
  time.textContent = new Date(msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  footer.appendChild(time);

  const reactBtn = document.createElement('button');
  reactBtn.className = 'react-btn'; reactBtn.textContent = '😊'; reactBtn.title = 'React';
  reactBtn.onclick = (e) => { e.stopPropagation(); showEmojiPicker(msg.id, reactBtn, wrapper); };
  footer.appendChild(reactBtn);

  if (isMine) {
    if (msg.type === 'text') {
      const editBtn = document.createElement('button');
      editBtn.className = 'msg-action-btn'; editBtn.title = 'Edit'; editBtn.textContent = '✏️';
      editBtn.onclick = (e) => { e.stopPropagation(); startEdit(msg.id); };
      footer.appendChild(editBtn);
    }

    const delBtn = document.createElement('button');
    delBtn.className = 'msg-action-btn delete'; delBtn.title = 'Delete'; delBtn.textContent = '🗑';
    delBtn.onclick = (e) => { e.stopPropagation(); confirmDelete(msg.id); };
    footer.appendChild(delBtn);
  }

  wrapper.appendChild(footer);

  const reactionsRow = document.createElement('div');
  reactionsRow.className = 'reactions-row';
  reactionsRow.id = 'reactions-' + msg.id;
  wrapper.appendChild(reactionsRow);

  container.appendChild(wrapper);
  scrollBottom();
}

// ─── Context menu ─────────────────────────────────────────────────────────────
function openCtxMenu(messageId, type, isMine, wrapperEl) {
  ctxTarget = { messageId, type, isMine };
  const menu = document.getElementById('ctx-menu');
  const buttons = menu.querySelectorAll('button');
  buttons[1].style.display = (isMine && type === 'text') ? '' : 'none';
  menu.querySelector('button.danger').style.display = isMine ? '' : 'none';
  menu.querySelector('hr').style.display = isMine ? '' : 'none';
  menu.classList.remove('hidden');
  const rect = wrapperEl.getBoundingClientRect();
  const mw = 160, mh = 120;
  let left = rect.left, top = rect.bottom + 4;
  if (left + mw > window.innerWidth) left = window.innerWidth - mw - 8;
  if (top + mh > window.innerHeight) top = rect.top - mh - 4;
  menu.style.left = Math.max(4, left) + 'px';
  menu.style.top = Math.max(4, top) + 'px';
}
function closeCtxMenu() { document.getElementById('ctx-menu').classList.add('hidden'); ctxTarget = null; }
function ctxReact() {
  if (!ctxTarget) return;
  const wrapper = document.querySelector(`[data-msg-id="${ctxTarget.messageId}"]`);
  const btn = wrapper?.querySelector('.react-btn');
  closeCtxMenu();
  if (btn && wrapper) showEmojiPicker(ctxTarget.messageId, btn, wrapper);
}
function ctxEdit() { if (!ctxTarget) return; const id = ctxTarget.messageId; closeCtxMenu(); startEdit(id); }
function ctxDelete() { if (!ctxTarget) return; const id = ctxTarget.messageId; closeCtxMenu(); confirmDelete(id); }

function addLongPress(el, cb) {
  let t;
  el.addEventListener('touchstart', () => { t = setTimeout(cb, 500); }, { passive: true });
  el.addEventListener('touchend', () => clearTimeout(t));
  el.addEventListener('touchmove', () => clearTimeout(t));
}

// ─── Emoji reactions ──────────────────────────────────────────────────────────
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
  if (pickerTarget?.messageId === messageId && !picker.classList.contains('hidden')) { hideEmojiPicker(); return; }
  document.querySelectorAll('.msg-wrapper.show-react').forEach(el => el.classList.remove('show-react'));
  wrapper.classList.add('show-react');
  pickerTarget = { messageId };
  picker.classList.remove('hidden');
  const rect = btn.getBoundingClientRect();
  const pw = 240, ph = 90;
  let left = rect.left, top = rect.top - ph - 8;
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

// ─── Global click ─────────────────────────────────────────────────────────────
function handleGlobalClick(e) {
  const picker = document.getElementById('emoji-picker');
  const menu = document.getElementById('ctx-menu');
  const panel = document.getElementById('online-panel');
  const badge = document.getElementById('online-indicator');

  if (!picker.classList.contains('hidden') && !picker.contains(e.target) && !e.target.classList.contains('react-btn'))
    hideEmojiPicker();
  if (!menu.classList.contains('hidden') && !menu.contains(e.target))
    closeCtxMenu();
  if (!panel.classList.contains('hidden') && !panel.contains(e.target) && e.target !== badge)
    closeOnlinePanel();
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function scrollBottom() { const m = document.getElementById('messages'); m.scrollTop = m.scrollHeight; }
function show(id) { document.getElementById(id).classList.remove('hidden'); }
function hide(id) { document.getElementById(id).classList.add('hidden'); }

async function api(path, method = 'GET', body = null) {
  const opts = { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(path, opts);
  return res.json();
}
