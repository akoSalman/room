// App-wide call UI: full-screen incoming-call screen and full-screen active
// call, in the spirit of Telegram/WhatsApp — big avatar, name, live timer,
// round controls at the bottom.
import React, { useEffect, useReducer } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Dimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { RTCView } from 'react-native-webrtc';
import { C } from '../theme';
import { callManager } from '../callManager';

function fmtElapsed(ms: number) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const two = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${two(m % 60)}:${two(s % 60)}` : `${m}:${two(s % 60)}`;
}

function initialsOf(title: string) {
  const name = title.replace(/^[^A-Za-z0-9؀-ۿ]+/, '').trim();
  return (name || '?').slice(0, 2).toUpperCase();
}

export default function CallOverlay() {
  const [, forceUpdate] = useReducer(x => x + 1, 0);
  useEffect(() => callManager.subscribe(forceUpdate), []);

  const cm = callManager;

  // Tick the timer once a second while connected
  useEffect(() => {
    if (!cm.connectedAt) return;
    const t = setInterval(forceUpdate, 1000);
    return () => clearInterval(t);
  }, [cm.connectedAt]);

  if (!cm.mode && !cm.incoming) return null;

  const { height: H } = Dimensions.get('window');

  // ── Incoming call: full-screen like a real phone call ──
  if (cm.incoming) {
    const inc = cm.incoming;
    return (
      <View style={s.fullscreen}>
        <View style={s.incomingKindRow}>
          <Ionicons name={inc.kind === 'video' ? 'videocam' : 'call'} size={16} color="rgba(255,255,255,0.75)" />
          <Text style={s.incomingKind}>{inc.kind === 'video' ? 'Incoming video call' : 'Incoming voice call'}</Text>
        </View>
        <View style={[s.bigAvatar, { marginTop: H * 0.12 }]}>
          <Text style={s.bigAvatarText}>{initialsOf(inc.fromUsername)}</Text>
        </View>
        <Text style={s.callerName}>{inc.fromUsername}</Text>
        <Text style={s.callState}>is calling you…</Text>
        <View style={s.incomingActions}>
          <View style={s.actionCol}>
            <TouchableOpacity style={[s.roundBtn, s.declineBtn]} onPress={() => cm.decline()}>
              <Ionicons name="call" size={30} color="#fff" style={s.endIcon} />
            </TouchableOpacity>
            <Text style={s.actionLabel}>Decline</Text>
          </View>
          <View style={s.actionCol}>
            <TouchableOpacity style={[s.roundBtn, s.acceptBtn]} onPress={() => cm.accept()}>
              <Ionicons name="call" size={30} color="#fff" />
            </TouchableOpacity>
            <Text style={s.actionLabel}>Accept</Text>
          </View>
        </View>
      </View>
    );
  }

  // ── Active call: full-screen ──
  const isVideo = cm.mode === 'dm-video';
  const elapsed = cm.connectedAt ? fmtElapsed(Date.now() - cm.connectedAt) : null;
  return (
    <View style={s.fullscreen}>
      {isVideo && cm.remoteStream && (
        <RTCView streamURL={cm.remoteStream.toURL()} style={StyleSheet.absoluteFill as any} objectFit="cover" />
      )}
      {isVideo && cm.localStream && !cm.cameraOff && (
        // Mirror the self-view only for the front camera, like every phone.
        <RTCView
          streamURL={cm.localStream.toURL()}
          style={s.localVideo}
          objectFit="cover"
          zOrder={1}
          mirror={cm.frontCamera}
        />
      )}

      {!(isVideo && cm.remoteStream) && (
        <View style={[s.bigAvatar, { marginTop: H * 0.16 }]}>
          <Text style={s.bigAvatarText}>{initialsOf(cm.title)}</Text>
        </View>
      )}
      <View style={isVideo && cm.remoteStream ? s.infoOnVideo : s.info}>
        <Text style={s.callerName} numberOfLines={1}>{cm.title.replace(/^[^ ]+ /, '')}</Text>
        <Text style={s.callState}>{elapsed ?? cm.status}</Text>
      </View>

      <View style={s.controls}>
        <View style={s.actionCol}>
          <TouchableOpacity style={[s.roundBtn, s.ctrlBtn, cm.muted && s.ctrlActive]} onPress={() => cm.toggleMute()}>
            <Ionicons name={cm.muted ? 'mic-off' : 'mic'} size={26} color="#fff" />
          </TouchableOpacity>
          <Text style={s.actionLabel}>{cm.muted ? 'Unmute' : 'Mute'}</Text>
        </View>
        {/* Voice: speaker/earpiece toggle like a real phone call */}
        {!isVideo && (
          <View style={s.actionCol}>
            <TouchableOpacity style={[s.roundBtn, s.ctrlBtn, cm.speakerOn && s.ctrlActive]} onPress={() => cm.toggleSpeaker()}>
              <Ionicons name={cm.speakerOn ? 'volume-high' : 'ear'} size={26} color="#fff" />
            </TouchableOpacity>
            <Text style={s.actionLabel}>{cm.speakerOn ? 'Speaker' : 'Earpiece'}</Text>
          </View>
        )}
        {isVideo && (
          <View style={s.actionCol}>
            <TouchableOpacity style={[s.roundBtn, s.ctrlBtn, cm.cameraOff && s.ctrlActive]} onPress={() => cm.toggleCamera()}>
              <Ionicons name={cm.cameraOff ? 'videocam-off' : 'videocam'} size={26} color="#fff" />
            </TouchableOpacity>
            <Text style={s.actionLabel}>Camera</Text>
          </View>
        )}
        {/* Video: flip front/back camera */}
        {isVideo && (
          <View style={s.actionCol}>
            <TouchableOpacity style={[s.roundBtn, s.ctrlBtn]} onPress={() => cm.switchCamera()}>
              <Ionicons name="camera-reverse" size={26} color="#fff" />
            </TouchableOpacity>
            <Text style={s.actionLabel}>Flip</Text>
          </View>
        )}
        <View style={s.actionCol}>
          <TouchableOpacity style={[s.roundBtn, s.declineBtn]} onPress={() => cm.end()}>
            <Ionicons name="call" size={28} color="#fff" style={s.endIcon} />
          </TouchableOpacity>
          <Text style={s.actionLabel}>End</Text>
        </View>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  fullscreen: {
    ...StyleSheet.absoluteFillObject, zIndex: 400,
    backgroundColor: '#0c1220', alignItems: 'center',
  },
  incomingKindRow: { flexDirection: 'row', alignItems: 'center', gap: 7, marginTop: 64 },
  incomingKind: { color: 'rgba(255,255,255,0.75)', fontSize: 14, fontWeight: '600' },
  endIcon: { transform: [{ rotate: '135deg' }] },
  bigAvatar: {
    width: 128, height: 128, borderRadius: 64, backgroundColor: C.accent,
    alignItems: 'center', justifyContent: 'center',
    shadowColor: C.accent, shadowOpacity: 0.5, shadowRadius: 30, shadowOffset: { width: 0, height: 0 },
    elevation: 12,
  },
  bigAvatarText: { color: '#fff', fontSize: 44, fontWeight: '800' },
  callerName: { color: '#fff', fontSize: 26, fontWeight: '800', marginTop: 22, paddingHorizontal: 24, textAlign: 'center' },
  callState: { color: 'rgba(255,255,255,0.65)', fontSize: 16, marginTop: 8, fontVariant: ['tabular-nums'] },
  info: { alignItems: 'center' },
  infoOnVideo: {
    position: 'absolute', top: 54, left: 0, right: 0, alignItems: 'center',
  },
  localVideo: {
    position: 'absolute', top: 48, right: 16, width: 104, height: 148,
    borderRadius: 12, backgroundColor: '#000', zIndex: 5,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.3)',
  },
  incomingActions: {
    position: 'absolute', bottom: 70, left: 0, right: 0,
    flexDirection: 'row', justifyContent: 'space-evenly',
  },
  controls: {
    position: 'absolute', bottom: 60, left: 0, right: 0,
    flexDirection: 'row', justifyContent: 'space-evenly',
  },
  actionCol: { alignItems: 'center', gap: 8 },
  roundBtn: {
    width: 68, height: 68, borderRadius: 34,
    alignItems: 'center', justifyContent: 'center',
    elevation: 8, shadowColor: '#000', shadowOpacity: 0.35, shadowRadius: 10, shadowOffset: { width: 0, height: 4 },
  },
  roundBtnIcon: { fontSize: 26, color: '#fff' },
  acceptBtn: { backgroundColor: '#22c55e' },
  declineBtn: { backgroundColor: '#ef4444' },
  ctrlBtn: { backgroundColor: 'rgba(255,255,255,0.16)' },
  ctrlActive: { backgroundColor: 'rgba(255,255,255,0.45)' },
  actionLabel: { color: 'rgba(255,255,255,0.7)', fontSize: 13, fontWeight: '600' },
});
