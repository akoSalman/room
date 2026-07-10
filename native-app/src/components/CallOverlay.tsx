// App-wide call UI: incoming-call banner and the active-call floating panel.
import React, { useEffect, useReducer } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { RTCView } from 'react-native-webrtc';
import { C } from '../theme';
import { callManager } from '../callManager';

export default function CallOverlay() {
  const [, forceUpdate] = useReducer(x => x + 1, 0);
  useEffect(() => callManager.subscribe(forceUpdate), []);

  const cm = callManager;
  if (!cm.mode && !cm.incoming) return null;

  return (
    <>
      {cm.incoming && (
        <View style={s.incoming}>
          <Text style={s.incomingText}>
            {cm.incoming.kind === 'video' ? '🎥' : '📞'} {cm.incoming.fromUsername} is calling…
          </Text>
          <View style={s.incomingBtns}>
            <TouchableOpacity style={[s.incomingBtn, s.accept]} onPress={() => cm.accept()}>
              <Text style={s.incomingBtnText}>✔ Accept</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[s.incomingBtn, s.decline]} onPress={() => cm.decline()}>
              <Text style={s.incomingBtnText}>✕ Decline</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {cm.mode && (
        <View style={s.panel}>
          {cm.mode === 'dm-video' && cm.remoteStream && (
            <RTCView streamURL={cm.remoteStream.toURL()} style={s.remote} objectFit="cover" />
          )}
          {cm.mode === 'dm-video' && cm.localStream && !cm.cameraOff && (
            <RTCView streamURL={cm.localStream.toURL()} style={s.local} objectFit="cover" zOrder={1} />
          )}
          <Text style={s.title}>{cm.title}</Text>
          <Text style={s.status}>{cm.status}</Text>
          <View style={s.controls}>
            <TouchableOpacity style={s.ctrl} onPress={() => cm.toggleMute()}>
              <Text style={s.ctrlText}>{cm.muted ? '🔇' : '🎙'}</Text>
            </TouchableOpacity>
            {cm.mode === 'dm-video' && (
              <TouchableOpacity style={s.ctrl} onPress={() => cm.toggleCamera()}>
                <Text style={s.ctrlText}>{cm.cameraOff ? '🚫' : '🎥'}</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity style={[s.ctrl, s.endBtn]} onPress={() => cm.end()}>
              <Text style={s.ctrlText}>📵</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}
    </>
  );
}

const s = StyleSheet.create({
  incoming: {
    position: 'absolute', top: 54, left: 16, right: 16, zIndex: 300,
    backgroundColor: C.msgBg, borderRadius: 14, padding: 14,
    borderWidth: 1, borderColor: C.accent, elevation: 8,
    shadowColor: '#000', shadowOpacity: 0.3, shadowRadius: 12, shadowOffset: { width: 0, height: 4 },
  },
  incomingText: { color: C.text, fontSize: 15, fontWeight: '700', textAlign: 'center' },
  incomingBtns: { flexDirection: 'row', justifyContent: 'center', gap: 12, marginTop: 10 },
  incomingBtn: { borderRadius: 10, paddingHorizontal: 18, paddingVertical: 9 },
  accept: { backgroundColor: '#22c55e' },
  decline: { backgroundColor: '#ef4444' },
  incomingBtnText: { color: '#fff', fontWeight: '700' },

  panel: {
    position: 'absolute', bottom: 96, right: 12, zIndex: 290, width: 230,
    backgroundColor: C.msgBg, borderRadius: 16, padding: 12,
    elevation: 8, shadowColor: '#000', shadowOpacity: 0.3, shadowRadius: 12, shadowOffset: { width: 0, height: 4 },
  },
  remote: { width: '100%', height: 160, borderRadius: 10, backgroundColor: '#000' },
  local: {
    position: 'absolute', top: 18, right: 18, width: 64, height: 88,
    borderRadius: 8, backgroundColor: '#000',
  },
  title: { color: C.text, fontWeight: '700', fontSize: 14, textAlign: 'center', marginTop: 8 },
  status: { color: C.muted, fontSize: 12, textAlign: 'center', marginTop: 2 },
  controls: { flexDirection: 'row', justifyContent: 'center', gap: 14, marginTop: 10 },
  ctrl: {
    width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(59,125,216,0.18)',
  },
  endBtn: { backgroundColor: '#ef4444' },
  ctrlText: { fontSize: 17 },
});
