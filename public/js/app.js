let token = localStorage.getItem('token');
let username = localStorage.getItem('username');
let currentRoomId = null;
let currentRoomIsDM = false;
let maxOtherReadMsgId = 0; // highest message id any other room member has read (for seen checkmarks)
let currentDMPeerPk = null; // the DM partner's public key (E2E) or null
let allChatImages = []; // every image of the current chat (from /room-media)
let e2eUnlockAsked = false;

// Sessions started before E2E existed never ran key setup at login — unlock
// (or create) the identity with the password when a DM is first opened.
async function ensureE2EUnlocked() {
  if (E2E.ready()) return true;
  if (e2eUnlockAsked) return false;
  e2eUnlockAsked = true;
  const pw = prompt('🔒 Enter your account password to unlock end-to-end encryption on this device:');
  if (!pw) return false;
  const ok = await E2E.setup(pw, api);
  if (!ok) alert('Could not unlock encryption with that password.');
  return ok;
}

// Per-brand APK release info, picked by the domain serving this page.
const IS_BISTBARG = location.hostname.includes('bistbarg');
const APK_RELEASE_TAG = IS_BISTBARG ? 'latest-apk-bistbarg' : 'latest-apk';
const APK_FILE_NAME = IS_BISTBARG ? 'BistbargChat-latest.apk' : 'ChatRoom-latest.apk';
const APK_DOWNLOAD_URL = `https://github.com/akoSalman/room-releases/releases/download/${APK_RELEASE_TAG}/${APK_FILE_NAME}`;
const APK_RELEASE_API = `https://api.github.com/repos/akoSalman/room-releases/releases/tags/${APK_RELEASE_TAG}`;
const pendingUploads = {}; // clientId -> { wrapper, previewUrl, file, type, fileName, roomId, replyToId }
const revealedOneTime = new Set(); // one-time message ids this client has revealed
const oneTimeExpiry = {}; // messageId -> ms timestamp when it will self-destruct
setInterval(() => {
  document.querySelectorAll('.one-time-countdown').forEach(el => {
    const exp = Number(el.dataset.expire || 0);
    if (!exp) return;
    el.textContent = ` 🔥${Math.max(0, Math.ceil((exp - Date.now()) / 1000))}s`;
  });
}, 1000);
let pendingOneTimeSeconds = null; // set via the 🔥 composer button, applies to the next message sent
let oldestLoadedMsgId = null;
let hasMoreOlderMsgs = true;
let loadingOlderMsgs = false;
let socket = null;
let socketReady = false;
let mediaRecorder = null;
let audioChunks = [];
let isRecording = false;
let recTimerInterval = null;
let recSeconds = 0;
let recAnalyser = null;
let recAnimFrame = null;
let recAudioCtx = null;
let previewAudio = null;
let previewWaveformPeaks = [];
let recordedBlob = null;
let recordedMime = '';
let pickerTarget = null;
let editingMsgId = null;
let ctxTarget = null;
let editingRoomId = null;

let typingTimer = null;
let isTyping = false;
const typingUsers = new Set();
const recordingUsers = new Set();
let replyTo = null; // { id, username, content, type }

let onlineUsers = [];
const unreadCounts = {};
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
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

function requestNotifPermission() {
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }
}
function showNotif(msg) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  // Notifications are only for when the user is away from the app; while it's
  // open, unread badges/dots do the signalling.
  if (document.visibilityState === 'visible') return;
  // Never preview content — only the kind of message received
  const body = msg.type === 'text' ? '💬 New message'
    : msg.type === 'audio' ? '🎙 Voice message'
    : msg.type === 'image' ? '🖼 Photo'
    : msg.type === 'gallery' ? '🖼 Photos'
    : msg.type === 'video' ? '🎥 Video'
    : msg.type === 'music' ? '🎵 Audio file' : '📄 File';
  new Notification(msg.username, { body, icon: '/icons/icon-192.png', tag: 'chatroom-' + msg.room_id, silent: true });
  try { new Audio('/notify.wav').play().catch(() => {}); } catch {}
}

window.addEventListener('DOMContentLoaded', () => {
  buildEmojiPicker();
  initQuickEmoji();

  // Keep the layout inside the visual viewport so the composer isn't hidden
  // behind the on-screen keyboard (iOS Safari doesn't resize the layout
  // viewport when the keyboard opens).
  if (window.visualViewport) {
    const syncViewport = () => {
      document.documentElement.style.height = window.visualViewport.height + 'px';
      document.body.style.height = window.visualViewport.height + 'px';
      window.scrollTo(0, 0);
    };
    window.visualViewport.addEventListener('resize', syncViewport);
    window.visualViewport.addEventListener('scroll', syncViewport);
  }

  // Point the APK download links at this domain's own branded build
  document.querySelectorAll('#apk-banner, #update-download-btn').forEach(a => { a.href = APK_DOWNLOAD_URL; });

  // Show the latest Android build number on the login banner
  fetch(APK_RELEASE_API)
    .then(r => r.json())
    .then(res => {
      const match = /version:(\d+)/.exec(res.body || '') || /v(\d+)/.exec(res.name || '');
      const sub = document.getElementById('apk-banner-sub');
      if (match && sub) sub.textContent = `Latest build: version ${match[1]} (APK)`;
    })
    .catch(() => {});
  document.addEventListener('click', handleGlobalClick);
  document.addEventListener('contextmenu', e => e.preventDefault());
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeLightbox(); });
  // Prevent document-level scroll from touch gestures on mobile
  document.addEventListener('touchmove', e => {
    if (e.target.closest('#messages, #room-list, .modal-overlay, #online-panel')) return;
    e.preventDefault();
  }, { passive: false });
  if (token && username) { enterApp(); requestNotifPermission(); }

  // Shared room link: /?join=<roomId>
  const joinParam = new URLSearchParams(location.search).get('join');
  if (joinParam && token) {
    setTimeout(() => joinRoomById(joinParam), 800);
    history.replaceState(null, '', '/');
  }

  document.getElementById('messages').addEventListener('scroll', () => {
    updateScrollFab();
    if (document.getElementById('messages').scrollTop < 80) loadOlderMessages();
  });
});

// ─── Auth ─────────────────────────────────────────────────────────────────────
async function signin() {
  const user = document.getElementById('auth-user').value.trim();
  const pass = document.getElementById('auth-pass').value;
  if (!user || !pass) return showAuthError('Please enter username and password');
  const btn = document.getElementById('auth-btn');
  btn.disabled = true; btn.textContent = 'Please wait…';
  document.getElementById('auth-error').textContent = '';
  try {
    let res = await api('/auth/signin', 'POST', { username: user, password: pass });
    if (res.error && res.canRegister) {
      if (!confirm(`No account named "${user}" exists. The username is available — create a new account?`)) {
        return showAuthError('');
      }
      res = await api('/auth/signin', 'POST', { username: user, password: pass, register: true });
    }
    if (res.error) return showAuthError(res.error);
    saveSession(res.token, res.username, res.avatar);
    E2E.setup(pass, api).catch(() => {});
    enterApp();
  } catch { showAuthError('Connection error — is the server running?'); }
  finally { btn.disabled = false; btn.textContent = 'Continue →'; }
}

function saveSession(t, u, avatar) {
  token = t; username = u;
  localStorage.setItem('token', t);
  localStorage.setItem('username', u);
  if (avatar !== undefined) {
    if (avatar) localStorage.setItem('avatar', avatar);
    else localStorage.removeItem('avatar');
  }
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
  requestNotifPermission();
  await connectSocket();
  await loadRooms();
  await loadDMRooms();
  // Restore unread badges from the server-side read positions
  const counts = await api('/unread-counts');
  if (counts && !counts.error) {
    Object.entries(counts).forEach(([roomId, cnt]) => {
      unreadCounts[roomId] = cnt;
      updateUnreadBadge(roomId);
    });
  }
}

function setAvatarInitials(name) {
  const avatar = localStorage.getItem('avatar');
  const display = avatar || (name || '?').slice(0, 2).toUpperCase();
  const sa = document.getElementById('sidebar-avatar');
  const pb = document.getElementById('profile-avatar-big');
  if (sa) { sa.textContent = display; sa.classList.toggle('emoji-avatar', !!avatar); }
  if (pb) { pb.textContent = display; pb.classList.toggle('emoji-avatar', !!avatar); }
  const pd = document.getElementById('profile-name-display');
  if (pd) pd.textContent = name;
}

const AVATAR_EMOJIS = ['🦄','🐉','🧙‍♂️','🧚‍♀️','🧛‍♂️','🧞‍♂️','🦊','🐺','🦁','🐯','🐼','🐸','🦉','🐙','🦋','🤖','👽','🐲','🦅','🐬','🔥','⚡','🌙','⭐'];

function buildAvatarPicker() {
  const grid = document.getElementById('avatar-emoji-grid');
  if (!grid || grid.childElementCount) return;
  const current = localStorage.getItem('avatar');
  const FIRST_ROW = 7;
  AVATAR_EMOJIS.forEach((e, i) => {
    const cell = document.createElement('button');
    cell.className = 'avatar-emoji-cell' + (current === e ? ' active' : '') + (i >= FIRST_ROW ? ' extra hidden' : '');
    cell.textContent = e;
    cell.onclick = () => setAvatarEmoji(e);
    grid.appendChild(cell);
  });
  const more = document.createElement('button');
  more.className = 'avatar-emoji-cell more-toggle';
  more.textContent = '⋯';
  more.onclick = () => {
    const expanded = more.classList.toggle('expanded');
    grid.querySelectorAll('.avatar-emoji-cell.extra').forEach(c => c.classList.toggle('hidden', !expanded));
    more.textContent = expanded ? '×' : '⋯';
  };
  grid.appendChild(more);
}

async function setAvatarEmoji(emoji) {
  const res = await api('/profile', 'PUT', { avatar: emoji });
  if (res.error) return alert(res.error);
  saveSession(res.token, res.username, res.avatar);
  setAvatarInitials(username);
  document.querySelectorAll('.avatar-emoji-cell').forEach(c => c.classList.toggle('active', c.textContent === emoji));
  document.getElementById('remove-avatar-btn').classList.toggle('hidden', !emoji);
}

function connectSocket() {
  return new Promise((resolve) => {
    if (socket) socket.disconnect();
    socket = io({ auth: { token }, reconnectionAttempts: 10 });

    socket.once('connect', () => { socketReady = true; hideConnectionBanner(); resolve(); });

    socket.on('connect', () => { socketReady = true; hideConnectionBanner(); });
    if (typeof Calls !== 'undefined') Calls.bindSocket(socket);
    socket.on('disconnect', () => { socketReady = false; showConnectionBanner(); });
    socket.on('reconnecting', () => showConnectionBanner());
    socket.on('reconnect', () => { socketReady = true; hideConnectionBanner(); });
    socket.on('connect_error', (err) => {
      showConnectionBanner();
      if (err.message === 'Unauthorized') logout();
    });

    socket.on('message_received', (msg) => {
      if (msg.client_id && pendingUploads[msg.client_id]) {
        const pending = pendingUploads[msg.client_id];
        if (pending.previewUrl) URL.revokeObjectURL(pending.previewUrl);
        pending.wrapper.replaceWith(buildMessageElement(msg));
        delete pendingUploads[msg.client_id];
        socket.emit('mark_read', { roomId: msg.room_id, lastMsgId: msg.id });
        return;
      }
      showNotif(msg);
      if (String(msg.room_id) !== String(currentRoomId)) {
        if (msg.username !== username) { // own messages are never "unread"
          unreadCounts[msg.room_id] = (unreadCounts[msg.room_id] || 0) + 1;
          updateUnreadBadge(msg.room_id);
        }
      } else {
        appendMessage(msg);
        socket.emit('mark_read', { roomId: msg.room_id, lastMsgId: msg.id });
        if (msg.type === 'text' && msg.username !== username) {
          let c = msg.content;
          if (E2E.isEncrypted(c)) c = E2E.decrypt(c, currentDMPeerPk);
          if (c && HEART_RE.test(String(c).trim())) triggerHeartBurst();
        }
      }
    });
    socket.on('voice_played', ({ messageId }) => {
      document.querySelectorAll(`.voice-played-dot[data-msg-id="${messageId}"]`)
        .forEach(d => d.classList.add('played'));
    });
    socket.on('message_edited', ({ messageId, content }) => {
      if (E2E.isEncrypted(content)) {
        const dec = E2E.decrypt(content, currentDMPeerPk);
        content = dec !== null ? dec : '🔒 Encrypted message';
      }
      applyEdit(messageId, content);
    });
    socket.on('message_deleted', ({ messageId }) => applyDelete(messageId));
    socket.on('reactions_updated', ({ messageId, reactions }) => renderReactions(messageId, reactions));
    socket.on('room_online', ({ users }) => updateOnlineUsers(users));
    socket.on('room_created', (room) => addRoomToList(room));
    socket.on('room_deleted', ({ roomId }) => removeRoomFromList(roomId));
    socket.on('room_updated', (room) => updateRoomInList(room));
    socket.on('user_typing', ({ username: u }) => showTyping(u));
    socket.on('user_stopped_typing', ({ username: u }) => hideTyping(u));
    socket.on('user_recording', ({ username: u }) => showRecordingUser(u));
    socket.on('user_stopped_recording', ({ username: u }) => hideRecordingUser(u));
    socket.on('dm_activity', ({ room }) => ensureDMInSidebar(room));
    socket.on('one_time_viewed', ({ messageId, seconds }) => {
      oneTimeExpiry[messageId] = Date.now() + seconds * 1000;
      const tag = document.querySelector(`.one-time-countdown[data-msg-id="${messageId}"]`);
      if (tag) tag.dataset.expire = oneTimeExpiry[messageId];
    });
    socket.on('messages_read', ({ roomId, lastReadMsgId }) => {
      if (String(roomId) !== String(currentRoomId)) return;
      if (lastReadMsgId > maxOtherReadMsgId) { maxOtherReadMsgId = lastReadMsgId; updateSeenCheckmarks(); }
    });
  });
}

// ─── Connection banner ────────────────────────────────────────────────────────
function showConnectionBanner() { show('connection-banner'); }
function hideConnectionBanner() { hide('connection-banner'); }

// ─── Unread badges ────────────────────────────────────────────────────────────
function updateUnreadBadge(roomId) {
  const li = document.querySelector(`[data-room-id="${roomId}"]`);
  if (!li) return;
  let badge = li.querySelector('.unread-badge');
  const count = unreadCounts[roomId] || 0;
  if (count === 0) { badge?.remove(); return; }
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
  updateComposerButtons();
  if (!currentRoomId || !socketReady) return;
  if (!isTyping) { isTyping = true; socket.emit('typing_start', { roomId: currentRoomId }); }
  clearTimeout(typingTimer);
  typingTimer = setTimeout(() => { isTyping = false; socket.emit('typing_stop', { roomId: currentRoomId }); }, 1500);
}

// The options strip stays pinned above the input bar at all times.
function updateComposerButtons() {}

function showTyping(user) { typingUsers.add(user); renderTypingBar(); }
function hideTyping(user) { typingUsers.delete(user); renderTypingBar(); }
function showRecordingUser(user) { recordingUsers.add(user); renderTypingBar(); }
function hideRecordingUser(user) { recordingUsers.delete(user); renderTypingBar(); }
function renderTypingBar() {
  const bar = document.getElementById('typing-bar');
  if (typingUsers.size === 0 && recordingUsers.size === 0) { bar.classList.add('hidden'); return; }
  // Recording takes priority over typing in the indicator
  let text;
  if (recordingUsers.size > 0) {
    const names = [...recordingUsers];
    text = names.length === 1 ? `🎙 ${names[0]} is recording`
      : `🎙 ${names[0]} and ${names.length - 1} others are recording`;
  } else {
    const names = [...typingUsers];
    text = names.length === 1 ? `${names[0]} is typing`
      : names.length === 2 ? `${names[0]} and ${names[1]} are typing`
      : `${names[0]} and ${names.length - 1} others are typing`;
  }
  bar.innerHTML = `<span>${text}</span><span class="typing-dots"><span></span><span></span><span></span></span>`;
  bar.classList.remove('hidden');
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

// ─── Profile ──────────────────────────────────────────────────────────────────
function openProfile() {
  if (document.getElementById('sidebar').classList.contains('collapsed')) return;
  document.getElementById('prof-username').value = '';
  document.getElementById('prof-cur-pass').value = '';
  document.getElementById('prof-new-pass').value = '';
  document.getElementById('profile-error').textContent = '';
  document.getElementById('profile-success').textContent = '';
  setAvatarInitials(username);
  buildAvatarPicker();
  document.getElementById('remove-avatar-btn').classList.toggle('hidden', !localStorage.getItem('avatar'));
  loadMyRooms();
  loadLatestAppVersion();
  show('profile-modal');
}

function copyRoomLink() {
  if (!currentRoomId || currentRoomIsDM) return;
  const link = location.origin + '/join/' + currentRoomId;
  (navigator.clipboard?.writeText(link) || Promise.reject()).then(
    () => alert('Room link copied:\n' + link),
    () => prompt('Room link (copy it):', link)
  );
}

// ─── Room dashboard ───────────────────────────────────────────────────────────
async function openRoomInfo() {
  if (!currentRoomId || currentRoomIsDM) return;
  const info = await api('/room-info/' + currentRoomId);
  if (info.error) return alert(info.error);

  document.getElementById('room-info-name').textContent = (info.is_private ? '🔒 ' : '# ') + info.name;
  document.getElementById('room-info-owner').textContent =
    (info.owner_avatar ? info.owner_avatar + ' ' : '') + (info.owner_username || 'unknown');
  const created = info.created_at
    ? new Date(info.created_at.includes('T') ? info.created_at : info.created_at.replace(' ', 'T') + 'Z')
        .toLocaleDateString([], { year: 'numeric', month: 'long', day: 'numeric' })
    : '—';
  document.getElementById('room-info-created').textContent = created;
  document.getElementById('room-info-type').textContent = info.is_private ? 'Private room' : 'Public room';

  // Link (public rooms only)
  const linkSection = document.getElementById('room-info-link-section');
  if (info.is_private) linkSection.classList.add('hidden');
  else {
    linkSection.classList.remove('hidden');
    document.getElementById('room-info-link').textContent = location.origin + '/join/' + info.id;
  }

  // Members (private rooms only)
  const membersSection = document.getElementById('room-info-members-section');
  const list = document.getElementById('room-info-members');
  list.innerHTML = '';
  if (info.is_private && Array.isArray(info.members)) {
    membersSection.classList.remove('hidden');
    document.getElementById('room-info-members-count').textContent = `(${info.members.length})`;
    info.members.forEach(m => {
      const li = document.createElement('li');
      li.textContent = (m.avatar ? m.avatar + ' ' : '') + m.username
        + (m.username === info.owner_username ? '  ·  owner' : '');
      list.appendChild(li);
    });
  } else {
    membersSection.classList.add('hidden');
  }

  // Invite (private room owner only)
  const inviteSection = document.getElementById('room-info-invite-section');
  inviteSection.classList.toggle('hidden', !(info.is_private && info.is_owner));
  document.getElementById('room-invite-input').value = '';

  show('room-info-modal');
}
function closeRoomInfo() { hide('room-info-modal'); }

function sendRoomInvite() {
  const name = document.getElementById('room-invite-input').value.trim();
  if (!name || !currentRoomId) return;
  socket.emit('invite_to_room', { roomId: currentRoomId, username: name }, (res) => {
    if (res?.error) return alert(res.error);
    alert(`Invitation sent — ${name} received an invite in their DMs.`);
    document.getElementById('room-invite-input').value = '';
  });
}

// ─── Sidebar search ───────────────────────────────────────────────────────────
let sidebarSearchTimer = null;
function onSidebarSearch() {
  const q = document.getElementById('sidebar-search').value.trim();
  clearTimeout(sidebarSearchTimer);
  const box = document.getElementById('search-results');
  if (!q) { box.classList.add('hidden'); box.innerHTML = ''; return; }
  sidebarSearchTimer = setTimeout(async () => {
    const res = await api('/search?q=' + encodeURIComponent(q));
    if (!res || res.error) return;
    box.innerHTML = '';
    if (!res.users.length && !res.rooms.length) {
      const d = document.createElement('div'); d.className = 'search-empty'; d.textContent = 'No results';
      box.appendChild(d);
    }
    res.users.forEach(u => {
      const d = document.createElement('div');
      d.className = 'search-result';
      d.innerHTML = `<span>${u.avatar || '👤'}</span><b></b><em>Message</em>`;
      d.querySelector('b').textContent = u.username;
      d.onclick = () => { clearSidebarSearch(); openDM(u.username); };
      box.appendChild(d);
    });
    res.rooms.forEach(r => {
      const d = document.createElement('div');
      d.className = 'search-result';
      d.innerHTML = `<span>#</span><b></b><em>Join</em>`;
      d.querySelector('b').textContent = r.name;
      d.onclick = () => { clearSidebarSearch(); joinRoomById(r.id); };
      box.appendChild(d);
    });
    box.classList.remove('hidden');
  }, 300);
}
function clearSidebarSearch() {
  document.getElementById('sidebar-search').value = '';
  const box = document.getElementById('search-results');
  box.classList.add('hidden'); box.innerHTML = '';
}

function openCreateRoomModal() { show('create-room-modal'); document.getElementById('create-room-name').focus(); }
function closeCreateRoomModal() { hide('create-room-modal'); }
async function submitCreateRoom() {
  const name = document.getElementById('create-room-name').value.trim();
  const isPrivate = document.getElementById('create-room-private').checked;
  if (!name) return;
  const res = await api('/rooms', 'POST', { name, isPrivate });
  if (res.error) return alert(res.error);
  document.getElementById('create-room-name').value = '';
  document.getElementById('create-room-private').checked = false;
  closeCreateRoomModal();
  if (!document.querySelector(`[data-room-id="${res.id}"]`)) addRoomToList(res);
  const li = document.querySelector(`[data-room-id="${res.id}"]`);
  if (li) joinRoom(res.id, res.name, li, false);
}

async function loadLatestAppVersion() {
  const hint = document.getElementById('update-hint');
  try {
    const res = await fetch(APK_RELEASE_API).then(r => r.json());
    const match = /version:(\d+)/.exec(res.body || '') || /v(\d+)/.exec(res.name || '');
    if (match) hint.textContent = `Latest Android build: version ${match[1]} (mobile only).`;
  } catch { /* keep default hint */ }
}

async function loadMyRooms() {
  const rooms = await api('/rooms');
  const list = document.getElementById('my-rooms-list');
  list.innerHTML = '';
  const myId = getUserId();
  const mine = Array.isArray(rooms) ? rooms.filter(r => String(r.created_by) === String(myId)) : [];
  if (!mine.length) {
    const li = document.createElement('li');
    li.className = 'my-room-empty';
    li.textContent = 'No rooms created yet';
    list.appendChild(li);
    return;
  }
  mine.forEach(r => {
    const li = document.createElement('li');
    li.className = 'my-room-item';
    const name = document.createElement('span');
    name.className = 'my-room-name';
    name.textContent = '# ' + r.name;
    const editBtn = document.createElement('button');
    editBtn.className = 'room-action-btn';
    editBtn.textContent = '✏️';
    editBtn.title = 'Rename';
    editBtn.onclick = () => { closeProfile(); openRoomEdit(r.id, r.name); };
    const delBtn = document.createElement('button');
    delBtn.className = 'room-action-btn del';
    delBtn.textContent = '🗑';
    delBtn.title = 'Delete';
    delBtn.onclick = () => { closeProfile(); confirmDeleteRoom(r.id, r.name); };
    li.appendChild(name);
    li.appendChild(editBtn);
    li.appendChild(delBtn);
    list.appendChild(li);
  });
}
function closeProfile() { hide('profile-modal'); }

async function saveProfile() {
  const newUsername = document.getElementById('prof-username').value.trim();
  const currentPassword = document.getElementById('prof-cur-pass').value;
  const newPassword = document.getElementById('prof-new-pass').value;
  document.getElementById('profile-error').textContent = '';
  document.getElementById('profile-success').textContent = '';
  if (!newUsername && !newPassword)
    return document.getElementById('profile-error').textContent = 'Nothing to update';
  if (!currentPassword)
    return document.getElementById('profile-error').textContent = 'Current password is required';
  const res = await api('/profile', 'PUT', { newUsername: newUsername || undefined, currentPassword, newPassword: newPassword || undefined });
  if (!res.error && newPassword) E2E.rewrap(newPassword, api).catch(() => {});
  if (res.error) { document.getElementById('profile-error').textContent = res.error; return; }
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
  icon.className = 'room-icon'; icon.textContent = room.is_private ? '🔒' : '#';

  const label = document.createElement('span');
  label.className = 'room-label'; label.textContent = room.name;

  li.appendChild(icon);
  li.appendChild(label);

  li.onclick = () => { joinRoom(room.id, room.name, li); isMobile() ? closeSidebar() : collapseSidebar(); };
  document.getElementById('room-list').appendChild(li);
}

function isRoomOwner(room) {
  return room.created_by && String(room.created_by) === String(getUserId());
}
function getUserId() {
  if (!token) return null;
  try { return JSON.parse(atob(token.split('.')[1])).id; } catch { return null; }
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
  if (currentRoomId === room.id) document.getElementById('room-title').textContent = '# ' + room.name;
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
function closeRoomEdit() { editingRoomId = null; hide('room-edit-modal'); }
function saveRoomEdit() {
  const name = document.getElementById('room-edit-name').value.trim();
  if (!name || !editingRoomId) return;
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
  const d = document.createElement('li');
  d.className = 'dm-divider'; d.id = 'dm-divider'; d.textContent = 'Direct Messages';
  document.getElementById('room-list').appendChild(d);
}

function addDMToSidebar(room, otherUsername) {
  if (!otherUsername || document.querySelector(`[data-room-id="${room.id}"]`)) return;
  ensureDMDivider();
  const li = document.createElement('li');
  li.dataset.roomId = room.id; li.dataset.isDm = '1'; li.title = otherUsername;
  const icon = document.createElement('span'); icon.className = 'room-icon'; icon.textContent = '👤';
  const label = document.createElement('span'); label.className = 'room-label'; label.textContent = otherUsername;
  li.appendChild(icon); li.appendChild(label);
  li.onclick = () => { joinRoom(room.id, otherUsername, li, true); isMobile() ? closeSidebar() : collapseSidebar(); };
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
  if (li) { joinRoom(res.id, res.otherUsername || otherUsername, li, true); isMobile() ? closeSidebar() : collapseSidebar(); }
}

async function joinRoom(roomId, roomName, li, isDM = false) {
  if (currentRoomId === roomId) return;
  cancelEdit(); stopTypingSignal();
  if (isRecording) stopRecording();
  typingUsers.clear(); recordingUsers.clear(); renderTypingBar();
  currentRoomId = roomId;
  currentRoomIsDM = isDM;
  clearUnread(roomId);
  document.querySelectorAll('#room-list li').forEach(el => el.classList.remove('active'));
  li.classList.add('active');
  document.getElementById('room-title').textContent = (isDM ? '💬 ' : '# ') + roomName;
  document.getElementById('messages').innerHTML = '';
  document.getElementById('online-indicator').classList.add('hidden');
  document.getElementById('room-link-btn').classList.toggle('hidden', isDM);
  jumpBackStack = [];
  document.getElementById('scroll-fab').classList.add('hidden');
  oldestLoadedMsgId = null;
  hasMoreOlderMsgs = true;
  loadingOlderMsgs = false;
  maxOtherReadMsgId = 0;
  currentDMPeerPk = null;
  allChatImages = [];
  api('/room-media/' + roomId).then(m => {
    if (m && !m.error && String(roomId) === String(currentRoomId)) {
      allChatImages = m.images.slice().reverse().map(u => location.origin + u);
    }
  }).catch(() => {});
  document.getElementById('call-voice-btn').classList.toggle('hidden', !isDM);
  document.getElementById('call-video-btn').classList.toggle('hidden', !isDM);
  document.getElementById('room-voice-btn').classList.toggle('hidden', isDM);
  document.getElementById('room-voice-btn').textContent = '📞';
  Calls.setDMPeer(null, null);
  if (isDM) {
    try {
      await ensureE2EUnlocked();
      const pk = await api('/dm-peer-key/' + roomId);
      Calls.setDMPeer(pk?.userId || null, roomName);
      if (E2E.ready() && pk?.publicKey) {
        currentDMPeerPk = E2E.decodeKey(pk.publicKey);
        document.getElementById('room-title').textContent = '🔒 ' + roomName;
      }
    } catch {}
  }
  socket.emit('join_room', roomId);
  const msgs = await api('/messages/' + roomId);
  try {
    const receipts = await api('/read-receipts/' + roomId);
    if (receipts && typeof receipts === 'object' && !receipts.error) {
      maxOtherReadMsgId = Math.max(0, ...Object.values(receipts));
    }
  } catch {}
  if (Array.isArray(msgs)) {
    msgs.forEach(appendMessage);
    if (msgs.length) {
      oldestLoadedMsgId = msgs[0].id;
      socket.emit('mark_read', { roomId, lastMsgId: msgs[msgs.length - 1].id });
    }
    hasMoreOlderMsgs = msgs.length >= MESSAGES_PAGE_SIZE;
  }
  updateSeenCheckmarks();
  scrollBottom();
}

const MESSAGES_PAGE_SIZE = 20;

async function loadOlderMessages() {
  if (loadingOlderMsgs || !hasMoreOlderMsgs || !currentRoomId || !oldestLoadedMsgId) return;
  loadingOlderMsgs = true;
  const older = await api(`/messages/${currentRoomId}?before=${oldestLoadedMsgId}`);
  loadingOlderMsgs = false;
  if (!Array.isArray(older) || !older.length) { hasMoreOlderMsgs = false; return; }
  oldestLoadedMsgId = older[0].id;
  hasMoreOlderMsgs = older.length >= MESSAGES_PAGE_SIZE;
  prependMessages(older);
}

// ─── Online users ─────────────────────────────────────────────────────────────
function updateOnlineUsers(users) {
  onlineUsers = users;
  const badge = document.getElementById('online-indicator');
  if (currentRoomIsDM) {
    // DMs: just show whether the peer is online — no member list
    const peer = (document.getElementById('room-title').textContent || '').replace('💬', '').trim();
    const peerOnline = users.includes(peer);
    closeOnlinePanel();
    if (peerOnline) { badge.textContent = '● online'; badge.classList.remove('hidden'); }
    else badge.classList.add('hidden');
    return;
  }
  if (!users.length) { badge.classList.add('hidden'); return; }
  badge.classList.remove('hidden');
  badge.textContent = `● ${users.length} online ›`;
  if (!document.getElementById('online-panel').classList.contains('hidden')) renderOnlinePanel();
}
function toggleOnlinePanel() {
  if (currentRoomIsDM) return; // DM badge is informational only
  document.getElementById('online-panel').classList.contains('hidden') ? openOnlinePanel() : closeOnlinePanel();
}
function openOnlinePanel() { renderOnlinePanel(); show('online-panel'); }
function closeOnlinePanel() { hide('online-panel'); }
function renderOnlinePanel() {
  const ul = document.getElementById('online-list');
  ul.innerHTML = '';
  onlineUsers.forEach(u => {
    const li = document.createElement('li');
    li.textContent = u;
    if (u !== username) { li.title = `Message ${u}`; li.onclick = () => openDM(u); }
    ul.appendChild(li);
  });
}

// ─── Messaging ────────────────────────────────────────────────────────────────
function handleInputKey(e) { if (e.key === 'Enter') sendOrSave(); }
function sendOrSave() {
  if (editingMsgId) return saveEdit();
  if (pendingFiles.length) return sendPendingFiles();
  sendText();
}

// ─── Reply ────────────────────────────────────────────────────────────────────
function setReply(msg) {
  replyTo = { id: msg.id, username: msg.username, content: msg.content, type: msg.type };
  document.getElementById('reply-bar-user').textContent = msg.username;
  const preview = msg.type === 'text' ? (msg.content || '').slice(0, 60) : msg.type === 'audio' ? '🎙 Voice message' : msg.type === 'image' ? '🖼 Image' : msg.type === 'gallery' ? '🖼 Photos' : msg.type === 'video' ? '🎥 Video' : msg.type === 'music' ? '🎵 Audio file' : '📄 File';
  document.getElementById('reply-bar-text').textContent = preview;
  show('reply-bar');
  document.getElementById('msg-input').focus();
}
function cancelReply() { replyTo = null; hide('reply-bar'); }

function sendText() {
  const input = document.getElementById('msg-input');
  const plain = input.value.trim();
  if (!plain || !currentRoomId || !socket) return;
  stopTypingSignal();
  const roomId = currentRoomId;
  const replyToId = replyTo?.id || null;
  const oneTimeSeconds = pendingOneTimeSeconds || undefined;
  clearOneTime();
  input.value = '';
  updateComposerButtons();
  cancelReply();
  dispatchText(plain, roomId, replyToId, oneTimeSeconds);
}

// Appears in the chat instantly; a failed/timed-out send shows tap-to-retry.
function dispatchText(plain, roomId, replyToId, oneTimeSeconds) {
  const clientId = 'tmp-' + Date.now() + '-' + Math.random().toString(36).slice(2);
  const tempMsg = {
    id: clientId, username, avatar: localStorage.getItem('avatar') || '',
    type: 'text', content: plain, file_path: null, file_name: null,
    created_at: new Date().toISOString(),
    reply_to_id: replyToId, reply_username: replyTo?.username || null,
    one_time_seconds: oneTimeSeconds || null,
  };
  const wrapper = buildMessageElement(tempMsg);
  if (String(roomId) === String(currentRoomId)) {
    document.getElementById('messages').appendChild(wrapper);
    scrollBottom();
  }
  pendingUploads[clientId] = { wrapper, previewUrl: null };
  if (HEART_RE.test(plain.trim())) triggerHeartBurst();
  // Encrypt + emit after the bubble has painted, so the send button feels
  // instant even when E2E key work makes the wire format slow to build.
  setTimeout(() => {
    let wire = plain;
    if (currentRoomIsDM && currentDMPeerPk && String(roomId) === String(currentRoomId)) {
      wire = E2E.encrypt(plain, currentDMPeerPk) || plain;
    }
    socket.timeout(8000).emit('send_message', {
      roomId, type: 'text', content: wire, replyToId, clientId, oneTimeSeconds,
    }, (err, res) => {
      if ((err || !res?.ok) && pendingUploads[clientId]) {
        markUploadFailed(wrapper, clientId, () => dispatchText(plain, roomId, replyToId, oneTimeSeconds));
      }
    });
  }, 0);
}

// ── Heart burst: a short full-screen love effect on heart-only messages ──────
const HEART_RE = /^(?:\u2764\uFE0F|\u2764|\uD83D\uDC96|\uD83D\uDC97|\uD83D\uDC95|\uD83D\uDC93|\uD83D\uDC98|\uD83D\uDC9D|\uD83E\uDE77|\s)+$/;
let heartBurstTimer = null;
function triggerHeartBurst() {
  const el = document.getElementById('heart-burst');
  if (!el) return;
  if (!el.dataset.filled) {
    el.dataset.filled = '1';
    ['\u{1F496}','\u2764\uFE0F','\u{1F497}','\u{1F498}','\u2764\uFE0F','\u{1F496}','\u{1F495}','\u2764\uFE0F'].forEach((h, i) => {
      const sp = document.createElement('span');
      sp.textContent = h;
      sp.style.left = (6 + (i * 12) % 84) + '%';
      sp.style.animationDelay = (i * 0.12) + 's';
      sp.style.fontSize = (26 + (i % 4) * 12) + 'px';
      el.appendChild(sp);
    });
  }
  el.classList.remove('hidden');
  clearTimeout(heartBurstTimer);
  heartBurstTimer = setTimeout(() => el.classList.add('hidden'), 2500);
}

// ── Quick emoji bar ───────────────────────────────────────────────────────────
const QUICK_EMOJIS = ['😂', '❤️', '👍', '🙏', '😍', '🔥', '🎉', '😢', '😮', '👌'];
function initQuickEmoji() {
  const list = document.getElementById('quick-emoji-list');
  list.innerHTML = '';
  QUICK_EMOJIS.forEach(em => {
    const b = document.createElement('button');
    b.textContent = em;
    b.onclick = () => {
      const input = document.getElementById('msg-input');
      input.value += em;
      input.focus();
      updateComposerButtons();
    };
    list.appendChild(b);
  });
  if (localStorage.getItem('quickEmojiClosed') === '1') closeQuickEmoji();
  else openQuickEmoji();
}
function openQuickEmoji() {
  localStorage.removeItem('quickEmojiClosed');
  show('quick-emoji-bar');
  document.getElementById('composer-emoji').classList.add('hidden');
}
function closeQuickEmoji() {
  localStorage.setItem('quickEmojiClosed', '1');
  hide('quick-emoji-bar');
  document.getElementById('composer-emoji').classList.remove('hidden');
}

// ── Composer ＋ menu ──────────────────────────────────────────────────────────
function composerAttach() {
  document.getElementById('file-input').click();
}
function composerRecord() {
  startRecording();
}
function composerOneTime() {
  toggleOneTime();
}

// ── One-time (self-destructing) messages ──────────────────────────────────────
function toggleOneTime() {
  if (pendingOneTimeSeconds) return clearOneTime();
  const raw = prompt('One-time message: seconds visible after being opened (1–3600)?', '10');
  if (raw === null) return;
  const secs = parseInt(raw, 10);
  if (!Number.isInteger(secs) || secs < 1 || secs > 3600) return alert('Enter a number of seconds between 1 and 3600.');
  pendingOneTimeSeconds = secs;
  const otBtn = document.getElementById('composer-one-time');
  otBtn.textContent = `🔥 One-time: ${secs}s (turn off)`;
  otBtn.classList.add('one-time-armed');
}

function clearOneTime() {
  pendingOneTimeSeconds = null;
  const otBtn = document.getElementById('composer-one-time');
  otBtn.textContent = '🔥 One-time';
  otBtn.classList.remove('one-time-armed');
}

function stopTypingSignal() {
  if (isTyping) {
    isTyping = false; clearTimeout(typingTimer);
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
  updateComposerButtons();
  input.focus(); show('edit-banner');
}
function saveEdit() {
  let content = document.getElementById('msg-input').value.trim();
  if (!content || !editingMsgId) return;
  if (currentRoomIsDM && currentDMPeerPk) {
    content = E2E.encrypt(content, currentDMPeerPk) || content;
  }
  socket.emit('edit_message', { messageId: editingMsgId, content });
  cancelEdit();
}
function cancelEdit() {
  editingMsgId = null;
  document.getElementById('msg-input').value = '';
  updateComposerButtons();
  hide('edit-banner');
}
function applyEdit(messageId, content) {
  const wrapper = document.querySelector(`[data-msg-id="${messageId}"]`);
  if (!wrapper) return;
  const bubble = wrapper.querySelector('.msg-bubble');
  bubble.dataset.text = content;
  const quote = bubble.querySelector('.reply-quote');
  const tag = bubble.querySelector('.edited-tag');
  bubble.innerHTML = '';
  if (quote) bubble.appendChild(quote);
  const textSpan = document.createElement('span');
  textSpan.textContent = content;
  bubble.appendChild(textSpan);
  if (tag) bubble.appendChild(tag);
  else { const t = document.createElement('span'); t.className = 'edited-tag'; t.textContent = '(edited)'; bubble.appendChild(t); }
}

// ─── Delete ───────────────────────────────────────────────────────────────────
function applyDelete(messageId) { document.querySelector(`[data-msg-id="${messageId}"]`)?.remove(); }
function confirmDelete(messageId) {
  if (!confirm('Delete this message?')) return;
  socket.emit('delete_message', { messageId });
}

// ─── File / Audio ─────────────────────────────────────────────────────────────

// Upload with real progress events (fetch has none for uploads).
function xhrUpload(file, filename, onProgress) {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append('file', file, filename || undefined);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/upload');
    xhr.setRequestHeader('Authorization', 'Bearer ' + token);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100)); };
    xhr.onload = () => {
      try { resolve(JSON.parse(xhr.responseText)); }
      catch { reject(new Error('Upload failed')); }
    };
    xhr.onerror = () => reject(new Error('Upload failed — check your connection'));
    xhr.send(form);
  });
}

function updateUploadProgress(wrapper, pct) {
  const bar = wrapper.querySelector('.upload-progress-bar');
  if (bar) bar.style.width = pct + '%';
}

function markUploadFailed(wrapper, clientId, retryFn) {
  delete pendingUploads[clientId];
  wrapper.classList.remove('msg-uploading');
  wrapper.classList.add('msg-upload-failed');
  const overlay = wrapper.querySelector('.upload-overlay');
  if (overlay) overlay.remove();
  const bubble = wrapper.querySelector('.msg-bubble');
  const retry = document.createElement('div');
  retry.className = 'upload-retry';
  retry.textContent = '⚠️ Failed to send — tap to retry';
  retry.onclick = (e) => { e.stopPropagation(); wrapper.remove(); retryFn(); };
  bubble.appendChild(retry);
}

// uploadFilename: name given to the multipart upload (needs a real extension).
// messageFileName: what's stored/shown as the message's fileName (voice notes
// stash their waveform peaks here instead of a real filename).
async function uploadAndSendMedia(file, type, uploadFilename, messageFileName, roomId, replyToId, caption = null, oneTimeSeconds = undefined) {
  const clientId = 'tmp-' + Date.now() + '-' + Math.random().toString(36).slice(2);
  const previewUrl = (type === 'image' || type === 'video' || type === 'audio') ? URL.createObjectURL(file) : null;
  const tempMsg = {
    id: clientId, username, avatar: localStorage.getItem('avatar') || '',
    type, content: caption, file_path: previewUrl, file_name: messageFileName,
    created_at: new Date().toISOString(),
    reply_to_id: replyTo?.id || null, reply_username: replyTo?.username || null,
    _uploading: true, _progress: 0,
  };
  const wrapper = buildMessageElement(tempMsg);
  document.getElementById('messages').appendChild(wrapper);
  scrollBottom();
  pendingUploads[clientId] = { wrapper, previewUrl };

  try {
    const res = await xhrUpload(file, uploadFilename, pct => updateUploadProgress(wrapper, pct));
    if (res.error) throw new Error(res.error);
    if (!pendingUploads[clientId]) return; // user already dismissed/retried
    socket.emit('send_message', {
      roomId, type, content: caption, filePath: res.url,
      fileName: messageFileName, replyToId, clientId, oneTimeSeconds,
    });
  } catch (err) {
    if (pendingUploads[clientId]) {
      markUploadFailed(wrapper, clientId, () => uploadAndSendMedia(file, type, uploadFilename, messageFileName, roomId, replyToId, caption, oneTimeSeconds));
    }
  }
}

// Selecting media only STAGES it; everything staged is sent when the user
// hits send (with any typed text as the first item's caption). Multiple
// selection supported; staged images can be previewed and removed.
let pendingFiles = [];
function stageFile() {
  const files = [...document.getElementById('file-input').files];
  if (!files.length || !currentRoomId) return;
  files.forEach(f => pendingFiles.push({ file: f, url: URL.createObjectURL(f) }));
  document.getElementById('file-input').value = '';
  renderPendingFiles();
  document.getElementById('msg-input').focus();
}

function renderPendingFiles() {
  const bar = document.getElementById('media-preview-bar');
  bar.innerHTML = '';
  if (!pendingFiles.length) { bar.classList.add('hidden'); return; }
  bar.classList.remove('hidden');
  pendingFiles.forEach((p, i) => {
    const item = document.createElement('div');
    item.className = 'pending-item';
    if (p.file.type.startsWith('image/')) {
      const img = document.createElement('img');
      img.src = p.url;
      img.onclick = () => openLightbox(p.url); // preview before sending
      item.appendChild(img);
    } else {
      const box = document.createElement('div');
      box.className = 'pending-file-box';
      box.textContent = p.file.type.startsWith('video/') ? '🎥' : '📄';
      box.title = p.file.name;
      item.appendChild(box);
    }
    const x = document.createElement('button');
    x.className = 'pending-remove';
    x.textContent = '✕';
    x.onclick = () => { URL.revokeObjectURL(p.url); pendingFiles.splice(i, 1); renderPendingFiles(); };
    item.appendChild(x);
    bar.appendChild(item);
  });
  const add = document.createElement('button');
  add.className = 'pending-add';
  add.textContent = '＋';
  add.title = 'Add more';
  add.onclick = () => document.getElementById('file-input').click();
  bar.appendChild(add);
}

function sendPendingFiles() {
  if (!pendingFiles.length || !currentRoomId) return;
  const items = pendingFiles;
  pendingFiles = [];
  renderPendingFiles();
  const oneTimeSeconds = pendingOneTimeSeconds || undefined;
  clearOneTime();
  const inputEl = document.getElementById('msg-input');
  let caption = inputEl.value.trim() || null;
  if (caption) { inputEl.value = ''; updateComposerButtons(); stopTypingSignal(); }
  if (caption && currentRoomIsDM && currentDMPeerPk) {
    caption = E2E.encrypt(caption, currentDMPeerPk) || caption;
  }
  const roomId = currentRoomId, replyToId = replyTo?.id || null;

  const images = items.filter(p => p.file.type.startsWith('image/'));
  const others = items.filter(p => !p.file.type.startsWith('image/'));
  if (images.length > 1) {
    // Multiple images travel as ONE gallery message with the caption below.
    sendGallery(images, caption, oneTimeSeconds, roomId, replyToId);
    others.forEach(p => stagedSendOne(p, null, oneTimeSeconds, roomId, replyToId));
  } else {
    items.forEach((p, i) => stagedSendOne(p, i === 0 ? caption : null, oneTimeSeconds, roomId, replyToId));
  }
  cancelReply();
}

function stagedSendOne(p, caption, oneTimeSeconds, roomId, replyToId) {
  URL.revokeObjectURL(p.url);
  const file = p.file;
  const type = file.type.startsWith('image/') ? 'image'
    : file.type.startsWith('video/') ? 'video'
    : file.type.startsWith('audio/') ? 'music' : 'file';
  uploadAndSendMedia(file, type, file.name, file.name, roomId, replyToId, caption, oneTimeSeconds);
}

// Uploads several images and sends them as ONE gallery message.
async function sendGallery(images, caption, oneTimeSeconds, roomId, replyToId) {
  const clientId = 'tmp-' + Date.now() + '-' + Math.random().toString(36).slice(2);
  const tempMsg = {
    id: clientId, username, avatar: localStorage.getItem('avatar') || '',
    type: 'gallery', content: caption,
    file_path: JSON.stringify(images.map(p => p.url)), file_name: null,
    created_at: new Date().toISOString(),
    reply_to_id: replyTo?.id || null, reply_username: replyTo?.username || null,
    _uploading: true, _progress: 0,
  };
  const wrapper = buildMessageElement(tempMsg);
  document.getElementById('messages').appendChild(wrapper);
  scrollBottom();
  pendingUploads[clientId] = { wrapper, previewUrl: null };

  try {
    const progress = images.map(() => 0);
    const urls = [];
    for (let i = 0; i < images.length; i++) {
      const res = await xhrUpload(images[i].file, images[i].file.name, pct => {
        progress[i] = pct;
        updateUploadProgress(wrapper, Math.round(progress.reduce((a, b) => a + b, 0) / images.length));
      });
      if (res.error) throw new Error(res.error);
      urls.push(res.url);
    }
    if (!pendingUploads[clientId]) return;
    images.forEach(p => URL.revokeObjectURL(p.url));
    socket.emit('send_message', {
      roomId, type: 'gallery', content: caption, filePath: JSON.stringify(urls),
      fileName: null, replyToId, clientId, oneTimeSeconds,
    });
  } catch {
    if (pendingUploads[clientId]) {
      markUploadFailed(wrapper, clientId, () => sendGallery(images, caption, oneTimeSeconds, roomId, replyToId));
    }
  }
}

// ─── Recording ────────────────────────────────────────────────────────────────

async function startRecording() {
  if (!currentRoomId) return;
  if (!navigator.mediaDevices?.getUserMedia) return alert('Audio recording not supported.');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    recordedMime = getSupportedMimeType() || 'audio/webm';
    audioChunks = [];
    previewWaveformPeaks = [];
    mediaRecorder = new MediaRecorder(stream, recordedMime ? { mimeType: recordedMime } : {});
    mediaRecorder.ondataavailable = e => { if (e.data?.size > 0) audioChunks.push(e.data); };
    mediaRecorder.onstop = () => {
      stream.getTracks().forEach(t => t.stop());
      recordedBlob = new Blob(audioChunks, { type: recordedMime });
      if (recordedBlob.size < 500) { resetRecordingUI(); return; }
      showPreviewBar();
    };
    mediaRecorder.start(100);
    isRecording = true;
    socket?.emit('recording_start', { roomId: currentRoomId });

    // Web Audio analyser for live waveform
    recAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const source = recAudioCtx.createMediaStreamSource(stream);
    recAnalyser = recAudioCtx.createAnalyser();
    recAnalyser.fftSize = 64;
    source.connect(recAnalyser);

    recSeconds = 0;
    updateRecTimer();
    recTimerInterval = setInterval(() => { recSeconds++; updateRecTimer(); }, 1000);

    show('recording-bar'); hide('input-bar');
    buildRecWaveformBars();
    animateRecWaveform();
  } catch { alert('Microphone access denied.'); }
}

function buildRecWaveformBars() {
  const el = document.getElementById('rec-waveform');
  el.innerHTML = '';
  for (let i = 0; i < 40; i++) {
    const b = document.createElement('div');
    b.className = 'bar';
    b.style.height = '4px';
    el.appendChild(b);
  }
}

function animateRecWaveform() {
  if (!recAnalyser) return;
  const bars = document.querySelectorAll('#rec-waveform .bar');
  const data = new Uint8Array(recAnalyser.frequencyBinCount);
  function frame() {
    recAnalyser.getByteFrequencyData(data);
    const peak = data.reduce((s, v) => s + v, 0) / data.length / 255;
    previewWaveformPeaks.push(peak);
    // Shift bars left, append new
    const heights = Array.from(bars).map(b => parseInt(b.style.height));
    heights.shift();
    heights.push(Math.max(4, Math.round(peak * 30)));
    bars.forEach((b, i) => b.style.height = heights[i] + 'px');
    recAnimFrame = requestAnimationFrame(frame);
  }
  recAnimFrame = requestAnimationFrame(frame);
}

function togglePauseRecording() {
  if (!mediaRecorder) return;
  const btn = document.getElementById('rec-pause-btn');
  if (mediaRecorder.state === 'recording') {
    mediaRecorder.pause();
    clearInterval(recTimerInterval);
    cancelAnimationFrame(recAnimFrame);
    btn.textContent = '▶';
  } else if (mediaRecorder.state === 'paused') {
    mediaRecorder.resume();
    recTimerInterval = setInterval(() => { recSeconds++; updateRecTimer(); }, 1000);
    animateRecWaveform();
    btn.textContent = '⏸';
  }
}

function stopRecording() {
  clearInterval(recTimerInterval);
  cancelAnimationFrame(recAnimFrame);
  if (recAudioCtx) { recAudioCtx.close(); recAudioCtx = null; recAnalyser = null; }
  if (mediaRecorder?.state !== 'inactive') mediaRecorder.stop();
  isRecording = false;
  socket?.emit('recording_stop', { roomId: currentRoomId });
}

function cancelRecording() {
  clearInterval(recTimerInterval);
  cancelAnimationFrame(recAnimFrame);
  if (recAudioCtx) { recAudioCtx.close(); recAudioCtx = null; recAnalyser = null; }
  if (mediaRecorder?.state !== 'inactive') {
    mediaRecorder.onstop = null;
    mediaRecorder.stop();
    mediaRecorder.stream?.getTracks().forEach(t => t.stop());
  }
  isRecording = false;
  socket?.emit('recording_stop', { roomId: currentRoomId });
  resetRecordingUI();
}

function resetRecordingUI() {
  hide('recording-bar'); hide('preview-bar'); show('input-bar');
  document.getElementById('rec-pause-btn').textContent = '⏸';
  if (previewAudio) { previewAudio.pause(); previewAudio = null; }
  recordedBlob = null;
}

function updateRecTimer() {
  const m = Math.floor(recSeconds / 60);
  const s = String(recSeconds % 60).padStart(2, '0');
  document.getElementById('rec-timer').textContent = `${m}:${s}`;
}

// ─── Preview bar ──────────────────────────────────────────────────────────────

function showPreviewBar() {
  hide('recording-bar'); show('preview-bar');
  // Build waveform bars from collected peaks
  const bars = document.getElementById('preview-bars');
  bars.innerHTML = '';
  const peaks = normalizePeaks(previewWaveformPeaks, 50);
  peaks.forEach(h => {
    const b = document.createElement('div');
    b.className = 'bar';
    b.style.height = Math.max(3, Math.round(h * 30)) + 'px';
    bars.appendChild(b);
  });
  // Set up preview audio
  const url = URL.createObjectURL(recordedBlob);
  previewAudio = new Audio(url);
  previewAudio.onended = () => {
    document.getElementById('preview-play-btn').textContent = '▶';
    previewAudio.currentTime = 0;
    updatePreviewBars(1);
  };
  previewAudio.ontimeupdate = () => {
    const pct = previewAudio.duration ? previewAudio.currentTime / previewAudio.duration : 0;
    updatePreviewBars(pct);
    document.getElementById('preview-duration').textContent = fmtTime(previewAudio.currentTime);
  };
  previewAudio.onloadedmetadata = () => {
    document.getElementById('preview-duration').textContent = fmtTime(previewAudio.duration);
  };
}

function normalizePeaks(raw, count) {
  if (!raw.length) return Array(count).fill(0.2);
  const step = raw.length / count;
  return Array.from({ length: count }, (_, i) => {
    const slice = raw.slice(Math.floor(i * step), Math.floor((i + 1) * step));
    return slice.length ? Math.max(...slice) : 0;
  });
}

function updatePreviewBars(pct) {
  const bars = document.querySelectorAll('#preview-bars .bar');
  bars.forEach((b, i) => b.classList.toggle('played', i / bars.length < pct));
}

function togglePreviewPlay() {
  if (!previewAudio) return;
  const btn = document.getElementById('preview-play-btn');
  if (previewAudio.paused) {
    if (previewAudio.ended || previewAudio.currentTime >= previewAudio.duration) previewAudio.currentTime = 0;
    previewAudio.play(); btn.textContent = '⏸';
  } else { previewAudio.pause(); btn.textContent = '▶'; }
}

function cancelPreview() {
  if (previewAudio) { previewAudio.pause(); previewAudio = null; }
  resetRecordingUI();
}

function sendRecording() {
  if (!recordedBlob || recordedBlob.size < 500) return;
  if (previewAudio) { previewAudio.pause(); previewAudio = null; }
  const ext = recordedMime.includes('mp4') ? 'mp4' : recordedMime.includes('ogg') ? 'ogg' : 'webm';
  // Store normalized peaks in the filename slot for waveform rendering
  const peaks = normalizePeaks(previewWaveformPeaks, 50).map(v => Math.round(v * 100)).join(',');
  const roomId = currentRoomId, replyToId = replyTo?.id || null;
  const oneTimeSeconds = pendingOneTimeSeconds || undefined;
  clearOneTime();
  uploadAndSendMedia(recordedBlob, 'audio', `voice-${Date.now()}.${ext}`, peaks, roomId, replyToId, null, oneTimeSeconds);
  resetRecordingUI();
  cancelReply();
}

// ─── Links in messages ────────────────────────────────────────────────────────
// URLs (with or without protocol), card numbers, and phone numbers each get a
// small copy icon.
const COPYABLE_RE = /(https?:\/\/[^\s]+|(?:[a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}(?:\/[^\s]*)?|(?:\d{4}[ -]?){3}\d{4}|\+?\d[\d ()-]{8,14}\d)/g;
const URLISH_RE = /^(https?:\/\/|(?:[a-zA-Z0-9-]+\.)+[a-zA-Z]{2,})/;

function copyToClipboard(text, iconEl) {
  const done = () => {
    if (!iconEl) return;
    const orig = iconEl.textContent;
    iconEl.textContent = '✅';
    setTimeout(() => { iconEl.textContent = orig; }, 1200);
  };
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(done, done);
  } else {
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch {}
    ta.remove(); done();
  }
}

function makeCopyBtn(text) {
  const btn = document.createElement('button');
  btn.className = 'copy-chip-btn';
  btn.title = 'Copy';
  btn.textContent = '📋';
  btn.onclick = (e) => { e.stopPropagation(); e.preventDefault(); copyToClipboard(text.trim(), btn); };
  return btn;
}

function appendLinkifiedText(container, content) {
  const parts = content.split(COPYABLE_RE);
  let hasCopyable = false;
  parts.forEach(part => {
    if (!part) return;
    if (URLISH_RE.test(part)) {
      hasCopyable = true;
      const href = /^https?:\/\//.test(part) ? part : 'https://' + part;
      const a = document.createElement('a');
      a.href = href; a.textContent = part; a.className = 'msg-link';
      const joinMatch = /\/join\/(\d+)/.exec(href);
      if (joinMatch && href.startsWith(location.origin)) {
        a.onclick = (e) => { e.preventDefault(); joinRoomById(joinMatch[1]); };
      } else {
        a.target = '_blank'; a.rel = 'noopener';
      }
      container.appendChild(a);
      container.appendChild(makeCopyBtn(part));
    } else if (COPYABLE_RE.test(part) && /\d/.test(part)) {
      hasCopyable = true;
      const span = document.createElement('span');
      span.className = 'copyable-number';
      span.textContent = part;
      container.appendChild(span);
      container.appendChild(makeCopyBtn(part));
    } else {
      container.appendChild(document.createTextNode(part));
    }
    COPYABLE_RE.lastIndex = 0; // reset global-regex state between .test() calls
  });
  return hasCopyable;
}

async function joinRoomById(roomId) {
  const info = await api('/room-info/' + roomId);
  if (info.error) return alert(info.error);
  let li = document.querySelector(`[data-room-id="${info.id}"]`);
  if (!li) { addRoomToList(info); li = document.querySelector(`[data-room-id="${info.id}"]`); }
  if (li) joinRoom(info.id, info.name, li, false);
}

function acceptInvite(roomId) {
  socket.emit('accept_invite', { roomId }, (res) => {
    if (res?.error) return alert(res.error);
    addRoomToList(res.room);
    const li = document.querySelector(`[data-room-id="${res.room.id}"]`);
    if (li) joinRoom(res.room.id, res.room.name, li, false);
  });
}

// ─── Global audio coordination ───────────────────────────────────────────────
// Only one piece of media plays at a time across the whole app.
let currentMedia = null; // { el, stop } — el is an Audio/video element
function claimPlayback(el, stopFn) {
  if (currentMedia && currentMedia.el !== el) {
    try { currentMedia.stop(); } catch {}
  }
  currentMedia = { el, stop: stopFn };
}

// Auto-play the next voice message in the chat after one finishes
function playNextVoiceAfter(wrapperEl) {
  let el = wrapperEl.nextElementSibling;
  while (el) {
    const btn = el.querySelector('.voice-play-btn');
    if (btn) { btn.click(); return; }
    el = el.nextElementSibling;
  }
}

// Starts a one-time message's destruction clock only once its content is
// actually available to the viewer: immediately for text/files, when loaded
// for images/videos, on first play for voice/music.
const oneTimeClockStarted = new Set();
function armOneTimeClock(msg, wrapperEl) {
  const start = () => {
    if (oneTimeClockStarted.has(msg.id)) return;
    oneTimeClockStarted.add(msg.id);
    socket.emit('view_one_time', { messageId: msg.id });
  };
  if (msg.type === 'image' || msg.type === 'gallery') {
    // Only a successful, complete load starts the clock — a failed download
    // must not consume the viewing window.
    const img = wrapperEl.querySelector('img');
    if (!img) return;
    if (img.complete && img.naturalWidth > 0) return start();
    img.addEventListener('load', start, { once: true });
  } else if (msg.type === 'video') {
    const video = wrapperEl.querySelector('video');
    if (!video) return;
    if (video.readyState >= 2) return start();
    video.addEventListener('loadeddata', start, { once: true });
  } else if (msg.type === 'audio') {
    const playBtn = wrapperEl.querySelector('.voice-play-btn');
    if (!playBtn) return start();
    playBtn.addEventListener('click', start, { once: true });
  } else if (msg.type === 'music') {
    const audio = wrapperEl.querySelector('audio');
    if (!audio) return start();
    audio.addEventListener('play', start, { once: true });
  } else {
    start();
  }
}

// Shows a spinner over an image/video bubble until the media finishes loading.
function attachDownloadSpinner(bubble, type) {
  const el = type === 'image' ? bubble.querySelector('img') : type === 'video' ? bubble.querySelector('video') : null;
  if (!el) return;
  const spinner = document.createElement('div');
  spinner.className = 'download-spinner';
  bubble.appendChild(spinner);
  const done = () => spinner.remove();
  if (type === 'image') {
    if (el.complete) return done();
    el.addEventListener('load', done, { once: true });
    el.addEventListener('error', done, { once: true });
  } else {
    if (el.readyState >= 2) return done();
    el.addEventListener('loadeddata', done, { once: true });
    el.addEventListener('error', done, { once: true });
  }
}

// ─── Render messages ──────────────────────────────────────────────────────────
const SENT_TICKS = '<svg viewBox="0 0 16 10" class="ticks"><path d="M1 5.5L4.5 9L10 1.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const SEEN_TICKS = '<svg viewBox="0 0 16 10" class="ticks"><path d="M1 5.5L4.5 9L10 1.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M6 5.5L9.5 9L15 1.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function updateSeenCheckmarks() {
  document.querySelectorAll('.msg-status').forEach(el => {
    const seen = Number(el.dataset.msgId) <= maxOtherReadMsgId;
    el.innerHTML = seen ? SEEN_TICKS : SENT_TICKS;
    el.classList.toggle('seen', seen);
  });
}

function buildMessageElement(msg) {
  if (E2E.isEncrypted(msg.content) || E2E.isEncrypted(msg.reply_content)) {
    msg = { ...msg };
    if (E2E.isEncrypted(msg.content)) {
      const dec = E2E.decrypt(msg.content, currentDMPeerPk);
      msg.content = dec !== null ? dec : '🔒 Encrypted message (cannot decrypt on this device)';
    }
    if (E2E.isEncrypted(msg.reply_content)) {
      const decR = E2E.decrypt(msg.reply_content, currentDMPeerPk);
      msg.reply_content = decR !== null ? decR : '🔒 Encrypted';
    }
  }
  const isMine = msg.username === username;

  const wrapper = document.createElement('div');
  wrapper.className = 'msg-wrapper ' + (isMine ? 'mine' : 'theirs');
  wrapper.dataset.msgId = msg.id;
  if (!msg._uploading) addLongPress(wrapper, () => openCtxMenu(msg.id, msg.type, isMine, wrapper, msg));

  if (!isMine) {
    const sender = document.createElement('div');
    sender.className = 'msg-sender';
    const senderAvatar = document.createElement('span');
    senderAvatar.className = 'msg-sender-avatar';
    senderAvatar.textContent = msg.avatar || '🙂';
    const senderName = document.createElement('span');
    senderName.textContent = msg.username;
    sender.appendChild(senderAvatar);
    sender.appendChild(senderName);
    if (!currentRoomIsDM) {
      sender.classList.add('clickable');
      sender.title = `Message ${msg.username}`;
      sender.onclick = (e) => { e.stopPropagation(); openDM(msg.username); };
    }
    wrapper.appendChild(sender);
  }

  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';

  if (msg.reply_to_id && msg.reply_username) {
    const quote = document.createElement('div');
    quote.className = 'reply-quote';
    quote.onclick = (e) => { e.stopPropagation(); jumpToMessage(msg.reply_to_id); };
    const quoteUser = document.createElement('span');
    quoteUser.className = 'reply-quote-user';
    quoteUser.textContent = msg.reply_username;
    const quoteText = document.createElement('span');
    quoteText.className = 'reply-quote-text';
    quoteText.textContent = msg.reply_type === 'text' ? (msg.reply_content || '').slice(0, 80)
      : msg.reply_type === 'audio' ? '🎙 Voice message'
      : msg.reply_type === 'image' ? '🖼 Image'
      : msg.reply_type === 'video' ? '🎥 Video'
      : msg.reply_type === 'music' ? '🎵 Audio file'
      : msg.reply_type === 'gallery' ? '🖼 Photos' : '📄 File';
    quote.appendChild(quoteUser);
    quote.appendChild(quoteText);
    bubble.appendChild(quote);
  }

  if (msg.forwarded_from) {
    const fwd = document.createElement('div');
    fwd.className = 'forwarded-label';
    fwd.textContent = '↪ Forwarded from ' + msg.forwarded_from;
    bubble.appendChild(fwd);
  }

  const oneTimeHidden = msg.one_time_seconds && !revealedOneTime.has(msg.id);
  if (oneTimeHidden) {
    bubble.classList.add('one-time-bubble');
    const btn = document.createElement('button');
    btn.className = 'one-time-reveal';
    btn.textContent = `🔥 One-time message — tap to view (${msg.one_time_seconds}s)`;
    btn.onclick = (e) => {
      e.stopPropagation();
      revealedOneTime.add(msg.id);
      const revealed = buildMessageElement(msg);
      wrapper.replaceWith(revealed);
      if (!isMine) armOneTimeClock(msg, revealed); // own views never start the clock
    };
    bubble.appendChild(btn);
  } else if (msg.type === 'text') {
    bubble.dataset.text = msg.content;
    const textSpan = document.createElement('span');
    if (appendLinkifiedText(textSpan, msg.content || '')) bubble.classList.add('has-copyable');
    bubble.appendChild(textSpan);
    if (msg.edited) { const tag = document.createElement('span'); tag.className = 'edited-tag'; tag.textContent = '(edited)'; bubble.appendChild(tag); }
    if (msg.one_time_seconds) { const ot = document.createElement('span'); ot.className = 'one-time-tag'; ot.textContent = ` 🔥${msg.one_time_seconds}s`; bubble.appendChild(ot); }
  } else if (msg.type === 'invite') {
    let inv = null;
    try { inv = JSON.parse(msg.content || ''); } catch {}
    const card = document.createElement('div');
    card.className = 'invite-card';
    const title = document.createElement('div');
    title.className = 'invite-title'; title.textContent = '🔒 Room invitation';
    const text = document.createElement('div');
    text.className = 'invite-text';
    text.textContent = (msg.username === username ? 'You invited someone to' : `${msg.username} invited you to`) + ` “${inv?.roomName || 'a room'}”`;
    card.appendChild(title); card.appendChild(text);
    if (msg.username !== username && inv?.roomId) {
      const btn = document.createElement('button');
      btn.className = 'invite-join-btn'; btn.textContent = 'Join room';
      btn.onclick = (e) => { e.stopPropagation(); acceptInvite(inv.roomId); };
      card.appendChild(btn);
    }
    bubble.appendChild(card);
  } else if (msg.type === 'image') {
    const img = document.createElement('img');
    img.src = msg.file_path; img.onclick = () => openLightbox(msg.file_path);
    if (msg.one_time_seconds) { oneTimeMediaUrls.add(img.src); img.draggable = false; }
    bubble.appendChild(img);
  } else if (msg.type === 'gallery') {
    let urls = [];
    try { urls = JSON.parse(msg.file_path || '[]'); } catch {}
    const grid = document.createElement('div');
    grid.className = 'gallery-grid';
    urls.forEach(u => {
      const src = msg._uploading ? u : u; // object URLs while uploading, server paths after
      const img = document.createElement('img');
      img.src = src;
      img.onclick = () => openLightbox(src);
      if (msg.one_time_seconds) { oneTimeMediaUrls.add(img.src); img.draggable = false; }
      grid.appendChild(img);
    });
    bubble.appendChild(grid);
  } else if (msg.type === 'audio') {
    bubble.appendChild(buildVoicePlayer(msg));
  } else if (msg.type === 'video') {
    const video = document.createElement('video');
    video.src = msg.file_path; video.controls = true; video.className = 'msg-video';
    video.preload = 'metadata';
    video.onplay = () => claimPlayback(video, () => video.pause());
    bubble.appendChild(video);
  } else if (msg.type === 'music') {
    const wrap = document.createElement('div');
    wrap.className = 'music-player';
    const label = document.createElement('div');
    label.className = 'music-label'; label.textContent = '🎵 ' + (msg.file_name || 'Audio');
    const audio = document.createElement('audio');
    audio.src = msg.file_path; audio.controls = true; audio.className = 'music-audio';
    audio.onplay = () => claimPlayback(audio, () => audio.pause());
    wrap.appendChild(label); wrap.appendChild(audio);
    bubble.appendChild(wrap);
  } else {
    const a = document.createElement('a');
    a.className = 'file-link';
    if (msg.file_path) { a.href = msg.file_path; a.target = '_blank'; }
    else a.onclick = (e) => e.preventDefault();
    a.download = msg.file_name || 'file';
    a.innerHTML = '📄 ' + (msg.file_name || 'Download file');
    bubble.appendChild(a);
  }

  if (!oneTimeHidden && msg.type !== 'text' && msg.type !== 'invite' && msg.content) {
    const cap = document.createElement('div');
    cap.className = 'msg-caption';
    appendLinkifiedText(cap, msg.content);
    bubble.appendChild(cap);
  }

  if (msg.one_time_seconds && !oneTimeHidden) {
    const hideBtn = document.createElement('button');
    hideBtn.className = 'one-time-hide';
    hideBtn.textContent = '🙈 Hide';
    hideBtn.onclick = (e) => {
      e.stopPropagation();
      revealedOneTime.delete(msg.id);
      wrapper.replaceWith(buildMessageElement(msg));
    };
    bubble.appendChild(hideBtn);
  }

  if (msg._uploading) {
    wrapper.classList.add('msg-uploading');
    const overlay = document.createElement('div');
    overlay.className = 'upload-overlay';
    const bar = document.createElement('div');
    bar.className = 'upload-progress-bar';
    bar.style.width = (msg._progress || 0) + '%';
    overlay.appendChild(bar);
    bubble.appendChild(overlay);
  }
  if (['image', 'video', 'audio', 'music'].includes(msg.type) && !msg._uploading) {
    attachDownloadSpinner(bubble, msg.type);
  }
  // Bubble sits in a row with the ⋮ actions button BESIDE it, not under it
  const bubbleRow = document.createElement('div');
  bubbleRow.className = 'bubble-row';
  bubbleRow.appendChild(bubble);
  if (!msg._uploading) {
    const menuBtn = document.createElement('button');
    menuBtn.className = 'msg-menu-btn'; menuBtn.textContent = '⋮'; menuBtn.title = 'Message actions';
    menuBtn.onclick = (e) => {
      e.stopPropagation();
      const menuEl = document.getElementById('ctx-menu');
      if (!menuEl.classList.contains('hidden')) { closeCtxMenu(); return; }
      openCtxMenu(msg.id, msg.type, isMine, menuBtn, msg);
    };
    bubbleRow.appendChild(menuBtn);
  }
  wrapper.appendChild(bubbleRow);

  const footer = document.createElement('div');
  footer.className = 'msg-footer';
  const time = document.createElement('span');
  time.className = 'msg-time';
  const created = msg.created_at.includes('T') ? msg.created_at : msg.created_at.replace(' ', 'T') + 'Z';
  time.textContent = new Date(created).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  footer.appendChild(time);

  if (msg.one_time_seconds) {
    const ot = document.createElement('span');
    ot.className = 'one-time-tag one-time-countdown';
    ot.dataset.msgId = msg.id;
    const exp = oneTimeExpiry[msg.id] || (msg.viewed_at ? msg.viewed_at + msg.one_time_seconds * 1000 : 0);
    if (exp) { ot.dataset.expire = exp; ot.textContent = ` 🔥${Math.max(0, Math.ceil((exp - Date.now()) / 1000))}s`; }
    else ot.textContent = ` 🔥${msg.one_time_seconds}s`;
    footer.appendChild(ot);
  }

  if (isMine && !msg._uploading) {
    const status = document.createElement('span');
    status.className = 'msg-status';
    status.dataset.msgId = msg.id;
    status.innerHTML = msg.id <= maxOtherReadMsgId ? SEEN_TICKS : SENT_TICKS;
    if (msg.id <= maxOtherReadMsgId) status.classList.add('seen');
    footer.appendChild(status);
  }

  if (!msg._uploading) {
    const reactBtn = document.createElement('button');
    reactBtn.className = 'react-btn'; reactBtn.textContent = '😊'; reactBtn.title = 'React';
    reactBtn.onclick = (e) => { e.stopPropagation(); showEmojiPicker(msg.id, reactBtn, wrapper); };
    footer.appendChild(reactBtn);
  }

  wrapper.appendChild(footer);
  const reactionsRow = document.createElement('div');
  reactionsRow.className = 'reactions-row'; reactionsRow.id = 'reactions-' + msg.id;
  wrapper.appendChild(reactionsRow);
  return wrapper;
}

function appendMessage(msg) {
  const container = document.getElementById('messages');
  container.appendChild(buildMessageElement(msg));
  scrollBottom();
}

// Prepend a page of older messages (already in ascending/chronological order)
// while preserving the user's current scroll position.
function prependMessages(msgs) {
  if (!msgs.length) return;
  const container = document.getElementById('messages');
  const prevScrollHeight = container.scrollHeight;
  const prevScrollTop = container.scrollTop;
  const frag = document.createDocumentFragment();
  msgs.forEach(m => frag.appendChild(buildMessageElement(m)));
  container.insertBefore(frag, container.firstChild);
  container.scrollTop = prevScrollTop + (container.scrollHeight - prevScrollHeight);
}

// ─── Context menu ─────────────────────────────────────────────────────────────
function openCtxMenu(messageId, type, isMine, wrapperEl, msg) {
  ctxTarget = { messageId, type, isMine, username: msg?.username, content: msg?.content, filePath: msg?.file_path, fileName: msg?.file_name };
  const menu = document.getElementById('ctx-menu');
  document.getElementById('ctx-edit-btn').style.display = (isMine && type === 'text') ? '' : 'none';
  document.getElementById('ctx-forward-btn').style.display = (type !== 'invite' && !msg?.one_time_seconds) ? '' : 'none';
  document.getElementById('ctx-download-btn').style.display = (msg?.file_path && !msg?.one_time_seconds) ? '' : 'none';
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
function ctxReply() {
  if (!ctxTarget) return;
  const t = ctxTarget;
  closeCtxMenu();
  setReply({ id: t.messageId, username: t.username, content: t.content, type: t.type });
}

function ctxDownload() {
  if (!ctxTarget?.filePath) return;
  let paths = [ctxTarget.filePath];
  if (ctxTarget.type === 'gallery') {
    try { paths = JSON.parse(ctxTarget.filePath); } catch {}
  }
  paths.forEach((pth, i) => {
    setTimeout(() => {
      const a = document.createElement('a');
      a.href = pth;
      a.download = (ctxTarget?.fileName && !ctxTarget.fileName.includes(',')) ? ctxTarget.fileName : '';
      document.body.appendChild(a);
      a.click();
      a.remove();
    }, i * 300);
  });
  closeCtxMenu();
}

function ctxCopy() {
  if (!ctxTarget) return;
  const t = ctxTarget;
  closeCtxMenu();
  const text = t.type === 'text' ? (t.content || '') : t.filePath ? location.origin + t.filePath : '';
  if (text) copyToClipboard(text, null);
}

function ctxForward() {
  if (!ctxTarget) return;
  const id = ctxTarget.messageId;
  closeCtxMenu();
  openForwardModal(id);
}

let forwardMsgId = null;
async function openForwardModal(messageId) {
  forwardMsgId = messageId;
  const list = document.getElementById('forward-list');
  list.innerHTML = '';
  const [rooms, dms] = await Promise.all([api('/rooms'), api('/dm-rooms')]);
  const targets = [
    ...(Array.isArray(rooms) ? rooms.map(r => ({ id: r.id, label: (r.is_private ? '🔒 ' : '# ') + r.name })) : []),
    ...(Array.isArray(dms) ? dms.map(d => ({ id: d.id, label: '💬 ' + d.other_username })) : []),
  ];
  targets.forEach(t => {
    const li = document.createElement('li');
    li.textContent = t.label;
    li.onclick = () => {
      socket.emit('forward_message', { messageId: forwardMsgId, toRoomId: t.id }, (res) => {
        if (res?.error) alert(res.error);
      });
      closeForwardModal();
    };
    list.appendChild(li);
  });
  show('forward-modal');
}
function closeForwardModal() { forwardMsgId = null; hide('forward-modal'); }
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
    span.textContent = emoji; span.onclick = () => pickEmoji(emoji);
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
  picker.style.left = left + 'px'; picker.style.top = top + 'px';
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
    groups[r.emoji].count++; groups[r.emoji].users.push(r.username);
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

// ─── Voice player builder ─────────────────────────────────────────────────────

function fmtTime(s) {
  if (!isFinite(s)) return '0:00';
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

function buildVoicePlayer(msg) {
  const peaks = (msg.file_name || '').split(',').map(Number).filter(n => !isNaN(n));
  const normalizedPeaks = peaks.length >= 10 ? peaks.map(v => v / 100) : Array(50).fill(null).map(() => 0.2 + Math.random() * 0.6);

  const player = document.createElement('div');
  player.className = 'voice-player';

  // Opened indicator: bright dot until the receiving side has played it
  const dot = document.createElement('span');
  dot.className = 'voice-played-dot' + (msg.played ? ' played' : '');
  dot.dataset.msgId = msg.id;
  player.appendChild(dot);

  const playBtn = document.createElement('button');
  playBtn.className = 'voice-play-btn';
  playBtn.innerHTML = '▶';

  // Waveform
  const waveWrap = document.createElement('div');
  waveWrap.className = 'voice-waveform';
  waveWrap.style.cursor = 'pointer';

  const barsEl = document.createElement('div');
  barsEl.className = 'voice-bars';
  const barCount = 50;
  const peaksSampled = normalizePeaks(normalizedPeaks, barCount);
  peaksSampled.forEach(h => {
    const b = document.createElement('div');
    b.className = 'bar';
    b.style.height = Math.max(3, Math.round(h * 28)) + 'px';
    barsEl.appendChild(b);
  });
  waveWrap.appendChild(barsEl);

  // Meta: duration + speed
  const meta = document.createElement('div');
  meta.className = 'voice-meta';
  const durEl = document.createElement('span');
  durEl.className = 'voice-duration';
  durEl.textContent = '0:00';
  const speedBtn = document.createElement('button');
  speedBtn.className = 'voice-speed-btn';
  const speeds = [1, 1.5, 2];
  let speedIdx = 0;
  speedBtn.textContent = '1×';
  meta.appendChild(durEl);
  meta.appendChild(speedBtn);

  player.appendChild(playBtn);
  player.appendChild(waveWrap);
  player.appendChild(meta);

  // Audio element (hidden)
  const audio = new Audio(msg.file_path);
  let playing = false;
  let rafId = null;

  function updateBars() {
    if (!audio.duration) return;
    const pct = audio.currentTime / audio.duration;
    const bars = barsEl.querySelectorAll('.bar');
    bars.forEach((b, i) => b.classList.toggle('played', i / bars.length < pct));
    durEl.textContent = fmtTime(audio.currentTime);
  }

  function startRAF() {
    function tick() { updateBars(); if (!audio.paused) rafId = requestAnimationFrame(tick); }
    rafId = requestAnimationFrame(tick);
  }

  audio.onloadedmetadata = () => { durEl.textContent = fmtTime(audio.duration); };
  function stopThis() {
    audio.pause(); playing = false; playBtn.innerHTML = '▶';
    cancelAnimationFrame(rafId);
  }

  audio.onended = () => {
    playing = false; playBtn.innerHTML = '▶';
    cancelAnimationFrame(rafId);
    audio.currentTime = 0;
    updateBars();
    durEl.textContent = fmtTime(audio.duration);
    // Auto-play the next voice message in the chat
    const wrapper = player.closest('.msg-wrapper');
    if (wrapper) playNextVoiceAfter(wrapper);
  };

  let playedSent = false;
  function reallyPlay() {
    if (!playedSent && msg.username !== username) {
      playedSent = true;
      socket?.emit('voice_played', { messageId: msg.id });
    }
    claimPlayback(audio, stopThis); // pause whatever else is playing
    if (audio.ended || audio.currentTime >= audio.duration) audio.currentTime = 0;
    audio.play(); playBtn.innerHTML = '⏸'; playBtn.classList.remove('loading'); playing = true; startRAF();
  }

  playBtn.onclick = () => {
    if (playing) { stopThis(); return; }
    if (audio.readyState < 3) {
      // Still downloading — show a loading state and start as soon as enough is buffered.
      playBtn.innerHTML = ''; playBtn.classList.add('loading');
      const onReady = () => { audio.removeEventListener('canplay', onReady); if (!playing) reallyPlay(); };
      audio.addEventListener('canplay', onReady);
    } else {
      reallyPlay();
    }
  };

  // Seek on waveform click
  waveWrap.onclick = e => {
    if (!audio.duration) return;
    const rect = waveWrap.getBoundingClientRect();
    audio.currentTime = ((e.clientX - rect.left) / rect.width) * audio.duration;
    updateBars();
  };

  // Speed control
  speedBtn.onclick = () => {
    speedIdx = (speedIdx + 1) % speeds.length;
    audio.playbackRate = speeds[speedIdx];
    speedBtn.textContent = speeds[speedIdx] + '×';
  };

  return player;
}

// ─── Jump to replied message (multi-level back stack) ──────────────────────────
let jumpBackStack = [];

function currentVisibleMsgMarker() {
  const container = document.getElementById('messages');
  const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 60;
  if (nearBottom) return 'bottom';
  const visible = [...container.querySelectorAll('.msg-wrapper')].find(el => {
    const r = el.getBoundingClientRect();
    const cr = container.getBoundingClientRect();
    return r.top >= cr.top && r.top <= cr.bottom;
  });
  return visible ? visible.dataset.msgId : 'bottom';
}

async function jumpToMessage(messageId) {
  let target = document.querySelector(`[data-msg-id="${messageId}"]`);

  // Target is older than what's loaded — page backwards until we find it
  while (!target && hasMoreOlderMsgs) {
    await loadOlderMessages();
    target = document.querySelector(`[data-msg-id="${messageId}"]`);
  }
  if (!target) return;

  // Push where we came from so the FAB can walk back through each reply level
  jumpBackStack.push(currentVisibleMsgMarker());
  updateScrollFab();

  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  target.classList.add('msg-highlight');
  setTimeout(() => target.classList.remove('msg-highlight'), 1500);
}

function handleScrollFabClick() {
  if (jumpBackStack.length > 0) {
    const marker = jumpBackStack.pop();
    if (marker && marker !== 'bottom') {
      const el = document.querySelector(`[data-msg-id="${marker}"]`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.classList.add('msg-highlight');
        setTimeout(() => el.classList.remove('msg-highlight'), 1500);
        updateScrollFab();
        return;
      }
    }
    scrollBottom();
    updateScrollFab();
    return;
  }
  scrollBottom();
  updateScrollFab();
}

function updateScrollFab() {
  const container = document.getElementById('messages');
  const fab = document.getElementById('scroll-fab');
  if (!container || !fab) return;
  const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 60;

  if (jumpBackStack.length > 0) {
    fab.textContent = '↩';
    fab.title = `Back (${jumpBackStack.length})`;
    fab.classList.remove('hidden');
    return;
  }
  fab.textContent = '↓';
  fab.title = 'Scroll to latest';
  if (nearBottom) fab.classList.add('hidden');
  else fab.classList.remove('hidden');
}

// ─── Lightbox ─────────────────────────────────────────────────────────────────
let lightboxScale = 1, lightboxX = 0, lightboxY = 0;
let lightboxSrc = '';

let lightboxList = [];
let lightboxIdx = 0;

// Absolute URLs of one-time media — never downloadable from the lightbox
const oneTimeMediaUrls = new Set();

function openLightbox(src) {
  // Prefer the full chat history's images (server-side list); fall back to
  // what is currently rendered.
  const absolute = src.startsWith('http') ? src : location.origin + src;
  if (allChatImages.includes(absolute)) {
    lightboxList = allChatImages;
    lightboxIdx = allChatImages.indexOf(absolute);
  } else {
    lightboxList = [...document.querySelectorAll('#messages .msg-bubble img')].map(i => i.src);
    lightboxIdx = Math.max(0, lightboxList.indexOf(absolute));
    if (!lightboxList.length) lightboxList = [absolute];
  }
  showLightboxAt(lightboxIdx);
  show('lightbox');
}

// ── (3) swipe left/right in the gallery ──
let lightboxSwipedAt = 0; // suppresses the tap-to-close click a swipe generates
(() => {
  let sx = null, sy = null;
  const lb = () => document.getElementById('lightbox');
  // Capture phase: no child handler (image pan/zoom) can swallow the swipe
  document.addEventListener('touchstart', (e) => {
    if (!lb().classList.contains('hidden')) { sx = e.touches[0].clientX; sy = e.touches[0].clientY; }
  }, { passive: true, capture: true });
  document.addEventListener('touchend', (e) => {
    if (sx === null || lb().classList.contains('hidden')) { sx = null; return; }
    const dx = e.changedTouches[0].clientX - sx;
    const dy = e.changedTouches[0].clientY - sy;
    sx = null; sy = null;
    if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) && lightboxScale <= 1.05) {
      lightboxSwipedAt = Date.now();
      lightboxNav(dx < 0 ? 1 : -1);
    }
  }, { passive: true, capture: true });
})();

function showLightboxAt(idx) {
  lightboxIdx = Math.max(0, Math.min(idx, lightboxList.length - 1));
  // Preload neighbours so swiping is instant
  [lightboxIdx - 1, lightboxIdx + 1].forEach(i => {
    const u = lightboxList[i];
    if (u) { const im = new Image(); im.src = u; }
  });
  lightboxSrc = lightboxList[lightboxIdx];
  lightboxScale = 1; lightboxX = 0; lightboxY = 0;
  document.getElementById('lightbox-img').src = lightboxSrc;
  const dlBtn = document.querySelector('.lightbox-download');
  if (dlBtn) dlBtn.classList.toggle('hidden', oneTimeMediaUrls.has(lightboxSrc));
  applyLightboxTransform();
  document.getElementById('lightbox-counter').textContent =
    lightboxList.length > 1 ? `${lightboxIdx + 1} / ${lightboxList.length}` : '';
  document.getElementById('lightbox-prev').classList.toggle('hidden', lightboxIdx === 0);
  document.getElementById('lightbox-next').classList.toggle('hidden', lightboxIdx >= lightboxList.length - 1);
}

function lightboxNav(dir) { showLightboxAt(lightboxIdx + dir); }

function closeLightbox() {
  // A horizontal swipe fires a synthetic click on the backdrop right after
  // touchend — don't let that click close the gallery the user is browsing.
  if (Date.now() - lightboxSwipedAt < 500) return;
  hide('lightbox');
}
document.addEventListener('keydown', (e) => {
  if (document.getElementById('lightbox').classList.contains('hidden')) return;
  if (e.key === 'ArrowLeft') lightboxNav(-1);
  if (e.key === 'ArrowRight') lightboxNav(1);
});

function applyLightboxTransform() {
  const img = document.getElementById('lightbox-img');
  img.style.transform = `translate(${lightboxX}px, ${lightboxY}px) scale(${lightboxScale})`;
}

function lightboxZoom(delta, clientX, clientY) {
  const prevScale = lightboxScale;
  lightboxScale = Math.min(5, Math.max(1, lightboxScale + delta));
  if (lightboxScale === 1) { lightboxX = 0; lightboxY = 0; }
  applyLightboxTransform();
}

function downloadLightboxImage() {
  if (oneTimeMediaUrls.has(lightboxSrc)) return; // one-time media is view-only
  const a = document.createElement('a');
  a.href = lightboxSrc;
  a.download = lightboxSrc.split('/').pop() || 'image.jpg';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

(function setupLightboxGestures() {
  function init() {
    const img = document.getElementById('lightbox-img');
    if (!img) return;
    img.addEventListener('wheel', e => {
      e.preventDefault();
      lightboxZoom(e.deltaY < 0 ? 0.2 : -0.2);
    });
    let dragging = false, startX = 0, startY = 0;
    img.addEventListener('mousedown', e => {
      if (lightboxScale <= 1) return;
      dragging = true; startX = e.clientX - lightboxX; startY = e.clientY - lightboxY;
    });
    window.addEventListener('mousemove', e => {
      if (!dragging) return;
      lightboxX = e.clientX - startX; lightboxY = e.clientY - startY;
      applyLightboxTransform();
    });
    window.addEventListener('mouseup', () => dragging = false);

    let lastDist = null, lastMidX = 0, lastMidY = 0;
    img.addEventListener('touchstart', e => {
      if (e.touches.length === 2) {
        lastDist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
      } else if (e.touches.length === 1 && lightboxScale > 1) {
        lastMidX = e.touches[0].clientX - lightboxX; lastMidY = e.touches[0].clientY - lightboxY;
      }
    });
    img.addEventListener('touchmove', e => {
      if (e.touches.length === 2 && lastDist) {
        const dist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
        lightboxZoom((dist - lastDist) * 0.01);
        lastDist = dist;
      } else if (e.touches.length === 1 && lightboxScale > 1) {
        lightboxX = e.touches[0].clientX - lastMidX; lightboxY = e.touches[0].clientY - lastMidY;
        applyLightboxTransform();
      }
    }, { passive: false });
    img.addEventListener('touchend', e => { if (e.touches.length < 2) lastDist = null; });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();

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
