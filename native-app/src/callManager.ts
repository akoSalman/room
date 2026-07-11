// ── Voice & video calls (WebRTC) ──────────────────────────────────────────────
// Mirrors public/js/calls.js: DMs get 1:1 voice/video, rooms get voice-only
// mesh. A singleton so the call survives screen changes; CallOverlay renders
// its state app-wide.
import { PermissionsAndroid, Platform } from 'react-native';
import { mediaDevices, RTCPeerConnection, MediaStream } from 'react-native-webrtc';
import { apiFetch, getSocket } from './api';
import { audioManager } from './audioManager';

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

  private sock: any = null;
  private pcs = new Map<number, RTCPeerConnection>();
  private pendingIce = new Map<number, any[]>(); // candidates that arrived before the pc was ready
  private iceServers: any[] = [{ urls: ['stun:stun.l.google.com:19302'] }];
  private roomVoiceId: number | null = null;
  private listeners = new Set<Listener>();
  private inited = false;

  subscribe(fn: Listener) {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }
  private emit() { this.listeners.forEach(f => f()); }

  async init() {
    if (this.inited) return;
    this.inited = true;
    try {
      const cfg = await apiFetch('/ice-config');
      if (cfg?.iceServers) this.iceServers = cfg.iceServers;
    } catch {}
    const s = await getSocket();
    this.sock = s;
    s.on('call_offer', (offer: any) => this.onOffer(offer));
    s.on('call_answer', async ({ fromUserId, sdp }: any) => {
      const pc = this.pcs.get(fromUserId);
      if (pc) await pc.setRemoteDescription(sdp).catch(() => {});
      this.flushIce(fromUserId);
      this.status = 'Connected';
      this.emit();
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
      if (['failed', 'closed'].includes(st)) this.dropPeer(userId);
      if (st === 'connected' && this.mode !== 'room-voice') { this.status = 'Connected'; this.emit(); }
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
    this.pcs.forEach(pc => pc.close());
    this.pcs.clear();
    this.pendingIce.clear();
    this.localStream?.getTracks().forEach(t => t.stop());
    if (this.mode === 'room-voice' && this.roomVoiceId != null) {
      this.sock?.emit('voice_leave', { roomId: this.roomVoiceId });
    }
    this.localStream = null;
    this.remoteStream = null;
    this.mode = null;
    this.roomVoiceId = null;
    this.incoming = null;
    this.muted = false;
    this.cameraOff = false;
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
    this.emit();
  }

  async startDM(peerId: number | null, peerName: string, kind: 'voice' | 'video') {
    if (this.mode || !peerId) return;
    await this.init();
    const stream = await this.getMedia(kind === 'video');
    if (!stream) return;
    this.localStream = stream;
    this.mode = kind === 'video' ? 'dm-video' : 'dm-voice';
    this.title = (kind === 'video' ? '🎥 ' : '📞 ') + peerName;
    this.status = 'Calling…';
    this.emit();
    try { await this.makeOffer(peerId); } catch { this.end(); }
  }

  async accept() {
    const offer = this.incoming;
    this.incoming = null;
    if (!offer) return;
    const stream = await this.getMedia(offer.kind === 'video');
    if (!stream) {
      this.sock.emit('call_end', { toUserId: offer.fromUserId });
      this.emit();
      return;
    }
    this.localStream = stream;
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
    if (this.incoming) this.sock.emit('call_end', { toUserId: this.incoming.fromUserId });
    this.incoming = null;
    this.emit();
  }

  async toggleRoomVoice(roomId: number, roomName: string) {
    if (this.mode === 'room-voice') return this.end();
    if (this.mode) return;
    await this.init();
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
