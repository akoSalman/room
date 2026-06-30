import React, { useEffect, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Alert, Platform } from 'react-native';
import { Audio } from 'expo-av';
import { C } from '../theme';

function fmtTime(s: number) {
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export default function VoiceRecorder({ onCancel, onSend }: {
  onCancel: () => void;
  onSend: (uri: string, peaks: number[]) => void;
}) {
  const [phase, setPhase] = useState<'recording' | 'preview'>('recording');
  const [seconds, setSeconds] = useState(0);
  const [paused, setPaused] = useState(false);
  const [previewPlaying, setPreviewPlaying] = useState(false);
  const [previewProgress, setPreviewProgress] = useState(0);
  const recordingRef = useRef<Audio.Recording | null>(null);
  const previewSoundRef = useRef<Audio.Sound | null>(null);
  const timerRef = useRef<any>(null);
  const peaksRef = useRef<number[]>([]);
  const peakTimerRef = useRef<any>(null);
  const [uri, setUri] = useState('');
  const peaks = peaksRef.current;

  useEffect(() => {
    startRecording();
    return () => {
      stopTimers();
      recordingRef.current?.stopAndUnloadAsync().catch(() => {});
      previewSoundRef.current?.unloadAsync().catch(() => {});
    };
  }, []);

  function stopTimers() {
    clearInterval(timerRef.current);
    clearInterval(peakTimerRef.current);
  }

  async function startRecording() {
    try {
      const { status } = await Audio.requestPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert(
          'Microphone Permission Required',
          Platform.OS === 'android'
            ? 'Please go to Settings → Apps → ChatRoom → Permissions and enable Microphone.'
            : 'Please go to Settings → ChatRoom and enable Microphone.',
          [{ text: 'OK', onPress: onCancel }]
        );
        return;
      }
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
        staysActiveInBackground: false,
      });
      const { recording } = await Audio.Recording.createAsync(
        { ...Audio.RecordingOptionsPresets.HIGH_QUALITY, isMeteringEnabled: true }
      );
      recordingRef.current = recording;
      timerRef.current = setInterval(() => setSeconds(s => s + 1), 1000);
      peakTimerRef.current = setInterval(async () => {
        try {
          const st = await recording.getStatusAsync();
          if (st.isRecording) {
            const level = st.metering !== undefined ? Math.max(0, (st.metering + 60) / 60) : Math.random() * 0.5 + 0.1;
            peaksRef.current.push(Math.min(1, level));
          }
        } catch {}
      }, 100);
    } catch (err) {
      Alert.alert('Recording Error', 'Could not start recording. Please check microphone permissions in Settings.');
      onCancel();
    }
  }

  async function togglePause() {
    if (!recordingRef.current) return;
    if (paused) {
      await recordingRef.current.startAsync();
      timerRef.current = setInterval(() => setSeconds(s => s + 1), 1000);
    } else {
      await recordingRef.current.pauseAsync();
      clearInterval(timerRef.current);
    }
    setPaused(p => !p);
  }

  async function stopForPreview() {
    stopTimers();
    if (!recordingRef.current) return;
    await recordingRef.current.stopAndUnloadAsync();
    const recordedUri = recordingRef.current.getURI() || '';
    setUri(recordedUri);
    setPhase('preview');
  }

  async function togglePreview() {
    if (!previewSoundRef.current) {
      const { sound } = await Audio.Sound.createAsync(
        { uri },
        { shouldPlay: true },
        status => {
          if (!status.isLoaded) return;
          setPreviewProgress(status.positionMillis / (status.durationMillis || 1));
          if (status.didJustFinish) { setPreviewPlaying(false); setPreviewProgress(0); }
        }
      );
      previewSoundRef.current = sound;
      setPreviewPlaying(true);
    } else {
      const st = await previewSoundRef.current.getStatusAsync();
      if (!st.isLoaded) return;
      if (st.isPlaying) { await previewSoundRef.current.pauseAsync(); setPreviewPlaying(false); }
      else { await previewSoundRef.current.playAsync(); setPreviewPlaying(true); }
    }
  }

  function handleSend() {
    previewSoundRef.current?.unloadAsync();
    onSend(uri, peaksRef.current);
  }

  // Sample peaks for display
  const barCount = 40;
  const step = peaks.length / barCount;
  const displayPeaks = peaks.length > 5
    ? Array.from({ length: barCount }, (_, i) => {
        const slice = peaks.slice(Math.floor(i * step), Math.floor((i + 1) * step));
        return slice.length ? Math.max(...slice) : 0;
      })
    : Array(barCount).fill(0.3);

  if (phase === 'recording') return (
    <View style={s.bar}>
      <TouchableOpacity onPress={onCancel} style={s.iconBtn}>
        <Text style={s.icon}>🗑</Text>
      </TouchableOpacity>
      <View style={s.dot} />
      <View style={s.waveform}>
        {displayPeaks.map((h, i) => (
          <View key={i} style={[s.waveBar, { height: Math.max(3, h * 28), opacity: paused ? 0.4 : 0.8 }]} />
        ))}
      </View>
      <Text style={s.timer}>{fmtTime(seconds)}</Text>
      <TouchableOpacity onPress={togglePause} style={s.iconBtn}>
        <Text style={s.icon}>{paused ? '▶' : '⏸'}</Text>
      </TouchableOpacity>
      <TouchableOpacity onPress={stopForPreview} style={s.iconBtn}>
        <Text style={[s.icon, { color: C.danger }]}>⏹</Text>
      </TouchableOpacity>
    </View>
  );

  return (
    <View style={s.bar}>
      <TouchableOpacity onPress={onCancel} style={s.iconBtn}>
        <Text style={s.icon}>🗑</Text>
      </TouchableOpacity>
      <TouchableOpacity onPress={togglePreview} style={s.iconBtn}>
        <Text style={s.icon}>{previewPlaying ? '⏸' : '▶'}</Text>
      </TouchableOpacity>
      <View style={s.waveform}>
        {displayPeaks.map((h, i) => (
          <View key={i} style={[s.waveBar, {
            height: Math.max(3, h * 28),
            backgroundColor: i / barCount < previewProgress ? C.accent : 'rgba(82,136,193,0.35)',
          }]} />
        ))}
      </View>
      <Text style={s.timer}>{fmtTime(seconds)}</Text>
      <TouchableOpacity style={s.sendBtn} onPress={handleSend}>
        <Text style={s.sendIcon}>➤</Text>
      </TouchableOpacity>
    </View>
  );
}

const s = StyleSheet.create({
  bar: { flexDirection: 'row', alignItems: 'center', padding: 10, backgroundColor: C.header, borderTopWidth: 1, borderTopColor: C.border, gap: 6 },
  iconBtn: { padding: 6 },
  icon: { fontSize: 20 },
  dot: { width: 10, height: 10, borderRadius: 5, backgroundColor: C.danger },
  waveform: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 2, height: 32 },
  waveBar: { width: 3, borderRadius: 2, backgroundColor: C.danger },
  timer: { color: C.danger, fontSize: 14, fontWeight: '600', minWidth: 38 },
  sendBtn: { width: 38, height: 38, borderRadius: 19, backgroundColor: C.accent, alignItems: 'center', justifyContent: 'center' },
  sendIcon: { color: '#fff', fontSize: 16 },
});
