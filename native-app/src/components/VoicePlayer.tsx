import React, { useEffect, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Audio } from 'expo-av';
import { C } from '../theme';

const SPEEDS = [1, 1.5, 2];

function fmtTime(s: number) {
  if (!isFinite(s)) return '0:00';
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

function parsePeaks(raw: string, count = 40): number[] {
  const nums = raw.split(',').map(Number).filter(n => !isNaN(n) && n >= 0);
  if (nums.length < 5) return Array.from({ length: count }, () => 0.2 + Math.random() * 0.6);
  const step = nums.length / count;
  return Array.from({ length: count }, (_, i) => {
    const slice = nums.slice(Math.floor(i * step), Math.floor((i + 1) * step));
    return (slice.length ? Math.max(...slice) : 0) / 100;
  });
}

export default function VoicePlayer({ url, peaks: rawPeaks, mine }: {
  url: string; peaks: string; mine: boolean;
}) {
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const [speedIdx, setSpeedIdx] = useState(0);
  const soundRef = useRef<Audio.Sound | null>(null);
  const peaks = parsePeaks(rawPeaks);

  useEffect(() => {
    return () => { soundRef.current?.unloadAsync(); };
  }, []);

  async function toggle() {
    if (!soundRef.current) {
      const { sound } = await Audio.Sound.createAsync(
        { uri: url },
        { shouldPlay: true, rate: SPEEDS[speedIdx], shouldCorrectPitch: true },
        status => {
          if (!status.isLoaded) return;
          setProgress(status.positionMillis / (status.durationMillis || 1));
          setDuration((status.durationMillis || 0) / 1000);
          if (status.didJustFinish) {
            setPlaying(false);
            setProgress(0);
            sound.setPositionAsync(0);
          }
        }
      );
      soundRef.current = sound;
      setPlaying(true);
    } else {
      const status = await soundRef.current.getStatusAsync();
      if (!status.isLoaded) return;
      if (status.isPlaying) {
        await soundRef.current.pauseAsync();
        setPlaying(false);
      } else {
        if (status.didJustFinish || status.positionMillis >= (status.durationMillis || 0)) {
          await soundRef.current.setPositionAsync(0);
        }
        await soundRef.current.playAsync();
        setPlaying(true);
      }
    }
  }

  async function cycleSpeed() {
    const next = (speedIdx + 1) % SPEEDS.length;
    setSpeedIdx(next);
    await soundRef.current?.setRateAsync(SPEEDS[next], true);
  }

  const barColor = C.accent;
  const barUnplayed = mine ? 'rgba(59,125,216,0.3)' : 'rgba(31,41,55,0.25)';

  return (
    <View style={s.container}>
      <TouchableOpacity style={s.playBtn} onPress={toggle}>
        <Text style={s.playIcon}>{playing ? '⏸' : '▶'}</Text>
      </TouchableOpacity>

      <View style={s.waveform}>
        {peaks.map((h, i) => (
          <View key={i} style={[s.bar, {
            height: Math.max(3, h * 28),
            backgroundColor: i / peaks.length < progress ? barColor : barUnplayed,
          }]} />
        ))}
      </View>

      <View style={s.meta}>
        <Text style={s.duration}>{fmtTime(duration * progress || 0)}</Text>
        <TouchableOpacity onPress={cycleSpeed} style={s.speedBtn}>
          <Text style={s.speedText}>{SPEEDS[speedIdx]}×</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  container: { flexDirection: 'row', alignItems: 'center', gap: 8, width: 200, maxWidth: '100%', paddingVertical: 2 },
  playBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: C.accent, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  playIcon: { color: '#fff', fontSize: 14 },
  waveform: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 1, height: 32, overflow: 'hidden' },
  bar: { flex: 1, minWidth: 1, maxWidth: 3, borderRadius: 2 },
  meta: { alignItems: 'flex-end', gap: 3, flexShrink: 0 },
  duration: { color: C.muted, fontSize: 11, fontVariant: ['tabular-nums'] },
  speedBtn: { backgroundColor: 'rgba(82,136,193,0.2)', borderWidth: 1, borderColor: C.accent, borderRadius: 4, paddingHorizontal: 4, paddingVertical: 1 },
  speedText: { color: C.accent, fontSize: 10, fontWeight: '700' },
});
