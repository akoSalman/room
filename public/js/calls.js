// ── Voice & video calls (WebRTC) ──────────────────────────────────────────────
// DMs: 1:1 voice or video. Rooms: voice-only mesh (each participant holds a
// peer connection to every other). The server only relays signaling.

const Calls = (() => {
  let sock = null;
  let iceServers = [{ urls: ['stun:stun.l.google.com:19302'] }];
  const pcs = new Map(); // userId -> RTCPeerConnection
  let localStream = null;
  let mode = null; // 'dm-voice' | 'dm-video' | 'room-voice'
  let dmPeer = null; // { userId, username }
  let roomVoiceId = null;
  let incoming = null; // pending DM offer
  let muted = false;

  const $ = (id) => document.getElementById(id);

  async function loadIce() {
    try {
      const cfg = await api('/ice-config');
      if (cfg?.iceServers) iceServers = cfg.iceServers;
    } catch {}
  }

  function bindSocket(s) {
    sock = s;
    loadIce();
    s.on('call_offer', onOffer);
    s.on('call_answer', async ({ fromUserId, sdp }) => {
      const pc = pcs.get(fromUserId);
      if (pc) await pc.setRemoteDescription(sdp).catch(() => {});
      setStatus('Connected');
    });
    s.on('call_ice', ({ fromUserId, candidate }) => {
      pcs.get(fromUserId)?.addIceCandidate(candidate).catch(() => {});
    });
    s.on('call_end', ({ fromUserId }) => {
      dropPeer(fromUserId);
      if (mode?.startsWith('dm')) teardown();
    });
    s.on('voice_peer_joined', async ({ roomId, userId }) => {
      // I'm already in this room's voice chat: send the newcomer an offer
      if (mode === 'room-voice' && String(roomId) === String(roomVoiceId)) {
        await makeOffer(userId, { roomId });
      }
    });
    s.on('voice_peer_left', ({ roomId, userId }) => {
      if (mode === 'room-voice' && String(roomId) === String(roomVoiceId)) dropPeer(userId);
    });
    s.on('voice_count', ({ roomId, count }) => {
      const btn = $('room-voice-btn');
      if (btn && String(roomId) === String(currentRoomId)) {
        btn.textContent = count > 0 ? `📞 ${count}` : '📞';
      }
      if (mode === 'room-voice' && String(roomId) === String(roomVoiceId)) {
        setStatus(`Voice chat · ${count} in`);
      }
    });
  }

  function setDMPeer(userId, name) { dmPeer = userId ? { userId, username: name } : null; }

  async function getMedia(video) {
    return navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
      video: video ? { facingMode: 'user', width: { ideal: 640 } } : false,
    });
  }

  function newPc(userId) {
    const pc = new RTCPeerConnection({ iceServers });
    pc.onicecandidate = (e) => {
      if (e.candidate) sock.emit('call_ice', { toUserId: userId, candidate: e.candidate });
    };
    pc.ontrack = (e) => attachRemote(userId, e.streams[0]);
    pc.onconnectionstatechange = () => {
      if (['failed', 'closed'].includes(pc.connectionState)) dropPeer(userId);
      if (pc.connectionState === 'connected') setStatus(mode === 'room-voice' ? 'Voice chat' : 'Connected');
    };
    localStream?.getTracks().forEach(t => pc.addTrack(t, localStream));
    pcs.set(userId, pc);
    return pc;
  }

  async function makeOffer(userId, extra = {}) {
    const pc = newPc(userId);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    sock.emit('call_offer', {
      toUserId: userId, kind: mode === 'dm-video' ? 'video' : 'voice',
      sdp: pc.localDescription, ...extra,
    });
  }

  function attachRemote(userId, stream) {
    if (mode === 'dm-video') {
      const v = $('call-remote-video');
      v.srcObject = stream;
      v.classList.remove('hidden');
    } else {
      let a = $('call-audio-' + userId);
      if (!a) {
        a = document.createElement('audio');
        a.id = 'call-audio-' + userId;
        a.autoplay = true;
        $('call-audios').appendChild(a);
      }
      a.srcObject = stream;
    }
  }

  function dropPeer(userId) {
    pcs.get(userId)?.close();
    pcs.delete(userId);
    $('call-audio-' + userId)?.remove();
    if (mode === 'room-voice' && !pcs.size) setStatus('Voice chat · waiting for others…');
  }

  function showOverlay(title, video) {
    $('call-overlay').classList.remove('hidden');
    $('call-title').textContent = title;
    $('call-remote-video').classList.toggle('hidden', !video);
    $('call-local-video').classList.toggle('hidden', !video);
    $('call-cam-btn').classList.toggle('hidden', !video);
    muted = false;
    $('call-mute-btn').textContent = '🎙';
  }

  function setStatus(text) { const el = $('call-status'); if (el) el.textContent = text; }

  function teardown() {
    pcs.forEach(pc => pc.close());
    pcs.clear();
    localStream?.getTracks().forEach(t => t.stop());
    localStream = null;
    $('call-audios').innerHTML = '';
    $('call-remote-video').srcObject = null;
    $('call-local-video').srcObject = null;
    $('call-overlay').classList.add('hidden');
    $('incoming-call').classList.add('hidden');
    if (mode === 'room-voice' && roomVoiceId) sock.emit('voice_leave', { roomId: roomVoiceId });
    mode = null;
    roomVoiceId = null;
    incoming = null;
  }

  // ── DM calls ────────────────────────────────────────────────────────────────
  async function startDM(kind) {
    if (mode) return alert('You are already in a call.');
    if (!dmPeer) return;
    try {
      localStream = await getMedia(kind === 'video');
    } catch { return alert('Microphone/camera access is required.'); }
    mode = kind === 'video' ? 'dm-video' : 'dm-voice';
    showOverlay((kind === 'video' ? '🎥 ' : '📞 ') + dmPeer.username, kind === 'video');
    setStatus('Calling…');
    if (kind === 'video') { $('call-local-video').srcObject = localStream; $('call-local-video').muted = true; }
    await makeOffer(dmPeer.userId);
  }

  async function onOffer(offer) {
    // Room-voice mesh offers are auto-accepted while in that room's voice chat
    if (offer.roomId != null) {
      if (mode === 'room-voice' && String(offer.roomId) === String(roomVoiceId)) {
        const pc = newPc(offer.fromUserId);
        await pc.setRemoteDescription(offer.sdp);
        const ans = await pc.createAnswer();
        await pc.setLocalDescription(ans);
        sock.emit('call_answer', { toUserId: offer.fromUserId, sdp: pc.localDescription });
      }
      return;
    }
    if (mode) { sock.emit('call_end', { toUserId: offer.fromUserId }); return; } // busy
    incoming = offer;
    $('incoming-call-text').textContent =
      `${offer.kind === 'video' ? '🎥' : '📞'} ${offer.fromUsername} is calling…`;
    $('incoming-call').classList.remove('hidden');
  }

  async function accept() {
    const offer = incoming;
    incoming = null;
    $('incoming-call').classList.add('hidden');
    if (!offer) return;
    try {
      localStream = await getMedia(offer.kind === 'video');
    } catch { sock.emit('call_end', { toUserId: offer.fromUserId }); return alert('Microphone/camera access is required.'); }
    mode = offer.kind === 'video' ? 'dm-video' : 'dm-voice';
    showOverlay((offer.kind === 'video' ? '🎥 ' : '📞 ') + offer.fromUsername, offer.kind === 'video');
    setStatus('Connecting…');
    if (offer.kind === 'video') { $('call-local-video').srcObject = localStream; $('call-local-video').muted = true; }
    const pc = newPc(offer.fromUserId);
    await pc.setRemoteDescription(offer.sdp);
    const ans = await pc.createAnswer();
    await pc.setLocalDescription(ans);
    sock.emit('call_answer', { toUserId: offer.fromUserId, sdp: pc.localDescription });
  }

  function decline() {
    if (incoming) sock.emit('call_end', { toUserId: incoming.fromUserId });
    incoming = null;
    $('incoming-call').classList.add('hidden');
  }

  function end() {
    pcs.forEach((_pc, userId) => sock.emit('call_end', { toUserId: userId }));
    teardown();
  }

  // ── Room voice chat ─────────────────────────────────────────────────────────
  async function toggleRoomVoice() {
    if (mode === 'room-voice') return end();
    if (mode) return alert('You are already in a call.');
    try {
      localStream = await getMedia(false);
    } catch { return alert('Microphone access is required.'); }
    mode = 'room-voice';
    roomVoiceId = currentRoomId;
    showOverlay('📞 ' + document.getElementById('room-title').textContent.replace(/^[#💬🔒 ]+/, ''), false);
    setStatus('Voice chat · joining…');
    sock.emit('voice_join', { roomId: roomVoiceId });
  }

  function toggleMute() {
    if (!localStream) return;
    muted = !muted;
    localStream.getAudioTracks().forEach(t => { t.enabled = !muted; });
    $('call-mute-btn').textContent = muted ? '🔇' : '🎙';
  }

  function toggleCam() {
    if (!localStream) return;
    const on = localStream.getVideoTracks().some(t => t.enabled);
    localStream.getVideoTracks().forEach(t => { t.enabled = !on; });
    $('call-cam-btn').textContent = on ? '🚫🎥' : '🎥';
  }

  return { bindSocket, setDMPeer, startDM, toggleRoomVoice, accept, decline, end, toggleMute, toggleCam };
})();
