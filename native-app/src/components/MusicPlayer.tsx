import React, { useEffect, useReducer } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { C } from '../theme';
import { audioManager } from '../audioManager';

function fmtTime(s: number) {
  if (!isFinite(s)) return '0:00';
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

export default function MusicPlayer({ url, fileName, mine, msgId, roomId, roomMeta }: {
  url: string; fileName: string; mine: boolean; msgId: number; roomId: number; roomMeta?: any;
}) {
  const [, forceUpdate] = useReducer(x => x + 1, 0);
  useEffect(() => audioManager.subscribe(forceUpdate), []);

  const isCurrent = audioManager.currentId === msgId;
  const playing = isCurrent && audioManager.playing;
  const progress = isCurrent ? audioManager.progress : 0;
  const duration = isCurrent ? audioManager.duration : 0;

  function toggle() {
    if (isCurrent) audioManager.toggle();
    else audioManager.play(msgId, url, `🎵 ${fileName}`, roomId, roomMeta);
  }

  return (
    <View style={s.container}>
      <TouchableOpacity style={s.playBtn} onPress={toggle}>
        <Text style={s.playIcon}>{playing ? '⏸' : '▶'}</Text>
      </TouchableOpacity>
      <View style={s.info}>
        <Text style={s.fileName} numberOfLines={1}>🎵 {fileName}</Text>
        <View style={s.progressTrack}>
          <View style={[s.progressFill, { width: `${Math.min(100, progress * 100)}%` }]} />
        </View>
        <Text style={s.duration}>{fmtTime(duration * progress || 0)} / {fmtTime(duration)}</Text>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  container: { flexDirection: 'row', alignItems: 'center', gap: 10, width: 220, maxWidth: '100%', paddingVertical: 2 },
  playBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: C.accent, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  playIcon: { color: '#fff', fontSize: 14 },
  info: { flex: 1, gap: 4 },
  fileName: { color: C.text, fontSize: 13, fontWeight: '600' },
  progressTrack: { height: 4, borderRadius: 2, backgroundColor: 'rgba(31,41,55,0.15)', overflow: 'hidden' },
  progressFill: { height: 4, backgroundColor: C.accent },
  duration: { color: C.muted, fontSize: 11, fontVariant: ['tabular-nums'] },
});
