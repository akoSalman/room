// ── Voice & video calls (WebRTC) ──────────────────────────────────────────────
// Mirrors public/js/calls.js: DMs get 1:1 voice/video, rooms get voice-only
// mesh. A singleton so the call survives screen changes; CallOverlay renders
// its state app-wide.
import { PermissionsAndroid, Platform } from 'react-native';
import { Audio } from 'expo-av';
import { mediaDevices, RTCPeerConnection, MediaStream } from 'react-native-webrtc';
import { apiFetch, getSocket } from './api';
import { audioManager } from './audioManager';

// react-native-incall-manager routes call audio (earpiece/speaker/proximity)
// like a real phone. Loaded defensively so a missing native module never
// crashes the app in dev/Expo Go.
let InCallManager: any = null;
try { InCallManager = require('react-native-incall-manager').default; } catch {}

type Listener = () => void;
type Incoming = { fromUserId: number; fromUsername: string; kind: 'voice' | 'video'; sdp: any } | null;

class CallManager {
  mode: 'dm-voice' | 'dm-video' | 'room-voice' | null = null;
  title = '';
  status = '';
  incoming: Incoming = null;
  localStream: MediaStream | null = null;
  remoteStream: MediaStream | null = null; // dm-video only
  muted = false;
  cameraOff = false;
  speakerOn = false;    // voice calls: earpiece by default, toggle to speaker
  frontCamera = true;   // video calls: front/back camera
  connectedAt: number | null = null; // for the in-call timer

  // Details needed to write the call into chat history when it ends.
  private peerId: number | null = null;
  private peerName = '';
  private outgoing = false; // did we initiate?
  private logged = false;

  private ringSound: Audio.Sound | null = null;
  private async startRing() {
    this.stopRing();
    try {
      const { sound } = await Audio.Sound.createAsync(
        require('../assets/ring.wav'), { isLooping: true, shouldPlay: true, volume: 0.8 },
      );
      this.ringSound = sound;
    } catch {}
  }
  private stopRing() {
    const snd = this.ringSound;
    this.ringSound = null;
    if (snd) snd.unloadAsync().catch(() => {});
  }
  // Room voice chat connected its first peer. This does NOT go through
  // markConnected(): that one owns the DM call's "Connected" status, its
  // duration timer and its call-log entry, none of which apply to a room mesh
  // whose status line is "Voice chat · N in". What a room call DOES need is the
  // audio session — without InCallManager.start() the WebRTC audio route is
  // never set up, so a room call connected but nobody could hear anything.
  private markRoomAudioStarted() {
    if (this.roomAudioStarted) return;
    this.roomAudioStarted = true;
    try {
      InCallManager?.start({ media: 'audio' });
      // Group calls are hands-free by nature — default to speaker, like every
      // other app's group voice chat.
      this.speakerOn = true;
      InCallManager?.setForceSpeakerphoneOn(true);
    } catch {}
    this.emit();
  }
  private roomAudioStarted = false;

  private markConnected() {
    clearTimeout(this.noAnswerTimer);
    this.stopRing();
    // Stop every ring source: the expo-av loop AND InCallManager's ringback/
    // ringtone — otherwise ringing keeps playing over a connected call.
    try { InCallManager?.stopRingback?.(); InCallManager?.stopRingtone?.(); } catch {}
    if (!this.connectedAt) {
      this.connectedAt = Date.now();
      // Hand audio to InCallManager for proper phone-call routing. Video calls
      // default to speaker; voice calls to the earpiece (like a real call).
      try {
        InCallManager?.start({ media: this.mode === 'dm-video' ? 'video' : 'audio' });
        this.speakerOn = this.mode === 'dm-video';
        InCallManager?.setForceSpeakerphoneOn(this.speakerOn);
      } catch {}
    }
    this.status = 'Connected';
    this.emit();
  }

  toggleSpeaker() {
    this.speakerOn = !this.speakerOn;
    try { InCallManager?.setForceSpeakerphoneOn(this.speakerOn); } catch {}
    this.emit();
  }

  // Flip between front and back camera on a video call.
  async switchCamera() {
    if (this.mode !== 'dm-video' || !this.localStream) return;
    const track: any = this.localStream.getVideoTracks()[0];
    try {
      if (track?._switchCamera) track._switchCamera();
      this.frontCamera = !this.frontCamera;
      this.emit();
    } catch {}
  }

  // Record the finished call in the DM's chat history (server inserts a
  // 'call' message both users receive). Outcome: 'completed' | 'missed' |
  // 'failed' | 'declined'.
  private logCall(outcome: string) {
    if (this.logged || !this.peerId) return;
    this.logged = true;
    const duration = this.connectedAt ? Math.round((Date.now() - this.connectedAt) / 1000) : 0;
    try {
      this.sock?.emit('call_log', {
        peerId: this.peerId,
        kind: this.mode === 'dm-video' ? 'video' : 'voice',
        outcome, duration, outgoing: this.outgoing,
      });
    } catch {}
  }

  private sock: any = null;
  private pcs = new Map<number, RTCPeerConnection>();
  private pendingIce = new Map<number, any[]>(); // candidates that arrived before the pc was ready
  private iceServers: any[] = [{ urls: ['stun:stun.l.google.com:19302'] }];
  private roomVoiceId: number | null = null;
  private listeners = new Set<Listener>();
  private initPromise: Promise<void> | null = null;
  private noAnswerTimer: any = null;

  subscribe(fn: Listener) {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }
  private emit() { this.listeners.forEach(f => f()); }

  // Fetch TURN/STUN servers fresh — stale or missing TURN credentials are
  // the #1 reason calls never connect across mobile networks.
  private async refreshIce() {
    try {
      const cfg = await apiFetch('/ice-config');
      if (cfg?.iceServers?.length) this.iceServers = cfg.iceServers;
    } catch {}
  }

  async init() {
    // A single shared promise: concurrent callers WAIT for the socket to be
    // bound instead of racing ahead with this.sock still null (which made
    // the call window flash and immediately die).
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.doInit();
    return this.initPromise;
  }

  private async doInit() {
    await this.refreshIce();
    const s = await getSocket();
    this.sock = s;
    s.on('call_offer', (offer: any) => this.onOffer(offer));
    s.on('call_answer', async ({ fromUserId, sdp }: any) => {
      const pc = this.pcs.get(fromUserId);
      if (pc) await pc.setRemoteDescription(sdp).catch(() => {});
      this.flushIce(fromUserId);
      // Answer received = signaling done; real "Connected" comes from ICE
      if (this.mode !== 'room-voice') {
        this.stopRing();
        try { InCallManager?.stopRingback?.(); } catch {}
        this.status = 'Connecting…'; this.emit();
      }
    });
    s.on('call_ice', ({ fromUserId, candidate }: any) => {
      const pc = this.pcs.get(fromUserId);
      // Candidates often arrive before the callee accepts (no pc yet) or
      // before setRemoteDescription — buffer them or the call dies mid-setup.
      if (!pc || !(pc as any).remoteDescription) {
        if (!this.pendingIce.has(fromUserId)) this.pendingIce.set(fromUserId, []);
        this.pendingIce.get(fromUserId)!.push(candidate);
        return;
      }
      pc.addIceCandidate(candidate).catch(() => {});
    });
    s.on('call_end', ({ fromUserId }: any) => {
      this.dropPeer(fromUserId);
      if (this.mode?.startsWith('dm')) this.teardown();
    });
    s.on('voice_peer_joined', async ({ roomId, userId }: any) => {
      if (this.mode === 'room-voice' && String(roomId) === String(this.roomVoiceId)) {
        try { await this.makeOffer(userId, { roomId }); } catch { this.dropPeer(userId); }
      }
    });
    s.on('voice_peer_left', ({ roomId, userId }: any) => {
      if (this.mode === 'room-voice' && String(roomId) === String(this.roomVoiceId)) this.dropPeer(userId);
    });
    s.on('voice_count', ({ roomId, count }: any) => {
      if (this.mode === 'room-voice' && String(roomId) === String(this.roomVoiceId)) {
        this.status = `Voice chat · ${count} in`;
        this.emit();
      }
    });
  }

  // getUserMedia without granted runtime permissions hard-crashes the app on
  // some Android builds instead of rejecting — ask explicitly first, and stop
  // any expo-av playback/recording that holds the audio session.
  private async ensurePermissions(video: boolean): Promise<boolean> {
    if (Platform.OS !== 'android') return true;
    try {
      const wanted = [
        PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
        ...(video ? [PermissionsAndroid.PERMISSIONS.CAMERA] : []),
      ];
      const res = await PermissionsAndroid.requestMultiple(wanted);
      return wanted.every(w => res[w] === PermissionsAndroid.RESULTS.GRANTED);
    } catch {
      return true; // fall through and let getUserMedia decide
    }
  }

  private async getMedia(video: boolean): Promise<MediaStream | null> {
    try { audioManager.stop(); } catch {}
    if (!(await this.ensurePermissions(video))) return null;
    try {
      return await (mediaDevices.getUserMedia({
        audio: true,
        video: video ? { facingMode: 'user', width: 640, height: 480 } : false,
      }) as Promise<MediaStream>);
    } catch {
      return null;
    }
  }

  private newPc(userId: number): RTCPeerConnection {
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    (pc as any).onicecandidate = (e: any) => {
      if (e.candidate) this.sock.emit('call_ice', { toUserId: userId, candidate: e.candidate });
    };
    (pc as any).ontrack = (e: any) => {
      if (this.mode === 'dm-video') {
        this.remoteStream = e.streams[0];
      }
      // Voice: react-native-webrtc routes received audio to the speaker
      // automatically once the track is added to a connection.
      this.emit();
    };
    (pc as any).onconnectionstatechange = () => {
      const st = (pc as any).connectionState;
      if (st === 'failed') {
        if (this.mode?.startsWith('dm')) {
          this.status = 'Connection failed';
          this.emit();
          setTimeout(() => this.end(), 2500);
          return;
        }
        this.dropPeer(userId);
      }
      if (st === 'closed') this.dropPeer(userId);
      if (st === 'connected') {
        if (this.mode === 'room-voice') this.markRoomAudioStarted();
        else this.markConnected();
      }
    };
    (pc as any).oniceconnectionstatechange = () => {
      const st = (pc as any).iceConnectionState;
      if (this.mode?.startsWith('dm') && !this.connectedAt) {
        if (st === 'checking') { this.status = 'Connecting…'; this.emit(); }
      }
      if (st === 'disconnected' && this.mode?.startsWith('dm') && this.connectedAt) {
        this.status = 'Reconnecting…'; this.emit();
      }
      if (st === 'connected' || st === 'completed') {
        if (this.mode === 'room-voice') this.markRoomAudioStarted();
        else this.markConnected();
      }
    };
    this.localStream?.getTracks().forEach(t => (pc as any).addTrack(t, this.localStream));
    this.pcs.set(userId, pc);
    return pc;
  }

  private async makeOffer(userId: number, extra: any = {}) {
    const pc = this.newPc(userId);
    const offer = await pc.createOffer({});
    await pc.setLocalDescription(offer);
    this.sock.emit('call_offer', {
      toUserId: userId, kind: this.mode === 'dm-video' ? 'video' : 'voice',
      sdp: (pc as any).localDescription, ...extra,
    });
  }

  private flushIce(userId: number) {
    const pc = this.pcs.get(userId);
    const queued = this.pendingIce.get(userId) || [];
    this.pendingIce.delete(userId);
    if (pc) queued.forEach(c => pc.addIceCandidate(c).catch(() => {}));
  }

  private dropPeer(userId: number) {
    this.pcs.get(userId)?.close();
    this.pcs.delete(userId);
    this.pendingIce.delete(userId);
    if (this.mode === 'room-voice' && !this.pcs.size) {
      this.status = 'Voice chat · waiting for others…';
    }
    this.emit();
  }

  private teardown() {
    // Log the DM call outcome before clearing state (rooms aren't logged).
    if (this.mode?.startsWith('dm')) {
      this.logCall(this.connectedAt ? 'completed' : 'missed');
    }
    this.pcs.forEach(pc => pc.close());
    this.pcs.clear();
    this.pendingIce.clear();
    this.localStream?.getTracks().forEach(t => t.stop());
    if (this.mode === 'room-voice' && this.roomVoiceId != null) {
      this.sock?.emit('voice_leave', { roomId: this.roomVoiceId });
    }
    try { InCallManager?.stop(); InCallManager?.stopRingback?.(); } catch {}
    this.localStream = null;
    this.remoteStream = null;
    this.mode = null;
    this.roomVoiceId = null;
    this.incoming = null;
    this.muted = false;
    this.cameraOff = false;
    this.speakerOn = false;
    this.frontCamera = true;
    this.roomAudioStarted = false;
    this.connectedAt = null;
    this.peerId = null;
    clearTimeout(this.noAnswerTimer);
    this.stopRing();
    this.emit();
  }

  private async onOffer(offer: any) {
    if (offer.roomId != null) {
      if (this.mode === 'room-voice' && String(offer.roomId) === String(this.roomVoiceId)) {
        try {
          const pc = this.newPc(offer.fromUserId);
          await pc.setRemoteDescription(offer.sdp);
          this.flushIce(offer.fromUserId);
          const ans = await pc.createAnswer();
          await pc.setLocalDescription(ans);
          this.sock.emit('call_answer', { toUserId: offer.fromUserId, sdp: (pc as any).localDescription });
        } catch {
          this.dropPeer(offer.fromUserId);
        }
      }
      return;
    }
    if (this.mode) { this.sock.emit('call_end', { toUserId: offer.fromUserId }); return; } // busy
    this.incoming = offer;
    // Auto-accept if the user already tapped "Accept" on the notification.
    if (this.autoAcceptFrom && this.autoAcceptFrom === offer.fromUserId) {
      this.autoAcceptFrom = null;
      this.emit();
      this.accept();
      return;
    }
    this.startRing();
    this.emit();
  }

  // ── Answering from the notification shade ──
  private autoAcceptFrom: number | null = null;

  // Called when the user taps "Accept" on the call notification: accept the
  // incoming offer as soon as it's (re)delivered over the reconnected socket.
  armAutoAccept(fromUserId: number) {
    if (!fromUserId) return;
    this.autoAcceptFrom = fromUserId;
    // Already ringing? accept right now.
    if (this.incoming && this.incoming.fromUserId === fromUserId) {
      this.autoAcceptFrom = null;
      this.accept();
    } else {
      // Give the server a moment to re-deliver, then give up arming.
      setTimeout(() => { this.autoAcceptFrom = null; }, 15000);
    }
  }

  // Called when the user taps "Decline" on the call notification.
  declineIncomingFrom(fromUserId: number) {
    getSocket().then(s => {
      if (this.incoming && this.incoming.fromUserId === fromUserId) {
        this.decline();
      } else if (fromUserId) {
        s.emit('call_end', { toUserId: fromUserId });
      }
    }).catch(() => {});
  }

  async startDM(peerId: number | null, peerName: string, kind: 'voice' | 'video') {
    if (this.mode || !peerId) return;
    await this.init();
    await this.refreshIce();
    const stream = await this.getMedia(kind === 'video');
    if (!stream) return;
    this.localStream = stream;
    this.peerId = peerId; this.peerName = peerName; this.outgoing = true; this.logged = false;
    try { InCallManager?.startRingback?.('_DTMF_'); } catch {}
    this.mode = kind === 'video' ? 'dm-video' : 'dm-voice';
    this.title = (kind === 'video' ? '🎥 ' : '📞 ') + peerName;
    this.status = 'Ringing…';
    this.startRing();
    this.emit();
    // Give up after 45s of no answer (logged as a missed call)
    clearTimeout(this.noAnswerTimer);
    this.noAnswerTimer = setTimeout(() => {
      if (this.mode?.startsWith('dm') && !this.connectedAt) {
        this.status = 'No answer';
        this.emit();
        setTimeout(() => this.end(), 1200);
      }
    }, 45000);
    try { await this.makeOffer(peerId); } catch { this.end(); }
  }

  async accept() {
    const offer = this.incoming;
    this.incoming = null;
    this.stopRing();
    if (!offer) return;
    await this.refreshIce();
    const stream = await this.getMedia(offer.kind === 'video');
    if (!stream) {
      this.sock.emit('call_end', { toUserId: offer.fromUserId });
      this.emit();
      return;
    }
    this.localStream = stream;
    this.peerId = offer.fromUserId; this.peerName = offer.fromUsername; this.outgoing = false; this.logged = false;
    try { InCallManager?.stopRingtone?.(); } catch {}
    this.mode = offer.kind === 'video' ? 'dm-video' : 'dm-voice';
    this.title = (offer.kind === 'video' ? '🎥 ' : '📞 ') + offer.fromUsername;
    this.status = 'Connecting…';
    this.emit();
    try {
      const pc = this.newPc(offer.fromUserId);
      await pc.setRemoteDescription(offer.sdp);
      this.flushIce(offer.fromUserId);
      const ans = await pc.createAnswer();
      await pc.setLocalDescription(ans);
      this.sock.emit('call_answer', { toUserId: offer.fromUserId, sdp: (pc as any).localDescription });
    } catch {
      this.end();
    }
  }

  decline() {
    if (this.incoming) {
      this.sock.emit('call_end', { toUserId: this.incoming.fromUserId });
      // Log the declined incoming call so it shows in history for both sides.
      this.peerId = this.incoming.fromUserId; this.peerName = this.incoming.fromUsername;
      this.outgoing = false; this.mode = this.incoming.kind === 'video' ? 'dm-video' : 'dm-voice';
      this.logCall('declined');
      this.mode = null;
    }
    this.incoming = null;
    this.stopRing();
    this.emit();
  }

  async toggleRoomVoice(roomId: number, roomName: string) {
    if (this.mode === 'room-voice') return this.end();
    if (this.mode) return;
    await this.init();
    await this.refreshIce();
    const stream = await this.getMedia(false);
    if (!stream) return;
    this.localStream = stream;
    this.mode = 'room-voice';
    this.roomVoiceId = roomId;
    this.title = '📞 ' + roomName;
    this.status = 'Voice chat · joining…';
    this.emit();
    this.sock.emit('voice_join', { roomId });
  }

  end() {
    this.pcs.forEach((_pc, userId) => this.sock?.emit('call_end', { toUserId: userId }));
    this.teardown();
  }

  toggleMute() {
    if (!this.localStream) return;
    this.muted = !this.muted;
    this.localStream.getAudioTracks().forEach(t => { t.enabled = !this.muted; });
    this.emit();
  }

  toggleCamera() {
    if (!this.localStream) return;
    this.cameraOff = !this.cameraOff;
    this.localStream.getVideoTracks().forEach(t => { t.enabled = !this.cameraOff; });
    this.emit();
  }
}

export const callManager = new CallManager();
