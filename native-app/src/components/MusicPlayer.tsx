import React, { useEffect, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Audio } from 'expo-av';
import { C } from '../theme';

function fmtTime(s: number) {
  if (!isFinite(s)) return '0:00';
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

export default function MusicPlayer({ url, fileName, mine }: {
  url: string; fileName: string; mine: boolean;
}) {
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const soundRef = useRef<Audio.Sound | null>(null);

  useEffect(() => {
    return () => { soundRef.current?.unloadAsync(); };
  }, []);

  async function toggle() {
    if (!soundRef.current) {
      const { sound } = await Audio.Sound.createAsync(
        { uri: url },
        { shouldPlay: true },
        status => {
          if (!status.isLoaded) return;
          setProgress(status.positionMillis / (status.durationMillis || 1));
          setDuration((status.durationMillis || 0) / 1000);
          if (status.didJustFinish) { setPlaying(false); setProgress(0); }
        }
      );
      soundRef.current = sound;
      setPlaying(true);
    } else {
      const status = await soundRef.current.getStatusAsync();
      if (!status.isLoaded) return;
      if (status.isPlaying) { await soundRef.current.pauseAsync(); setPlaying(false); }
      else { await soundRef.current.playAsync(); setPlaying(true); }
    }
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
