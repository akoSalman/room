import React, { useEffect, useReducer } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { C } from '../theme';
import { audioManager } from '../audioManager';

// Persistent playback bar shown at the top of the app while audio plays
// outside the chat it belongs to.
export default function MiniPlayer({ hideForRoomId, onNavigate }: {
  hideForRoomId?: number | null;
  onNavigate?: (room: any, msgId: number) => void;
}) {
  const [, forceUpdate] = useReducer(x => x + 1, 0);
  useEffect(() => audioManager.subscribe(forceUpdate), []);

  if (audioManager.currentId === null) return null;
  if (hideForRoomId != null && audioManager.roomId === hideForRoomId) return null;

  return (
    <View style={s.bar}>
      <TouchableOpacity style={s.playBtn} onPress={() => audioManager.toggle()}>
        <Text style={s.playIcon}>{audioManager.playing ? '⏸' : '▶'}</Text>
      </TouchableOpacity>
      <TouchableOpacity
        style={s.info}
        activeOpacity={0.7}
        onPress={() => {
          if (onNavigate && audioManager.roomMeta && audioManager.currentId != null) {
            onNavigate(audioManager.roomMeta, audioManager.currentId);
          }
        }}
      >
        <Text style={s.label} numberOfLines={1}>{audioManager.label || 'Voice message'}</Text>
        <View style={s.track}>
          <View style={[s.fill, { width: `${Math.min(100, audioManager.progress * 100)}%` }]} />
        </View>
      </TouchableOpacity>
      <TouchableOpacity style={s.closeBtn} onPress={() => audioManager.stop()}>
        <Text style={s.closeIcon}>✕</Text>
      </TouchableOpacity>
    </View>
  );
}

const s = StyleSheet.create({
  bar: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: C.sidebar, borderBottomWidth: 1, borderBottomColor: C.border,
    paddingHorizontal: 12, paddingVertical: 8,
  },
  playBtn: { width: 32, height: 32, borderRadius: 16, backgroundColor: C.accent, alignItems: 'center', justifyContent: 'center' },
  playIcon: { color: '#fff', fontSize: 13 },
  info: { flex: 1, gap: 4 },
  label: { color: C.text, fontSize: 12.5, fontWeight: '600' },
  track: { height: 3, borderRadius: 2, backgroundColor: C.inputBg, overflow: 'hidden' },
  fill: { height: '100%', backgroundColor: C.accent },
  closeBtn: { padding: 6 },
  closeIcon: { color: C.muted, fontSize: 16 },
});
