import React, { useEffect, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Alert, Platform, Animated } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Audio } from 'expo-av';
import { C } from '../theme';
import { audioManager } from '../audioManager';

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
  const pulse = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    startRecording();
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(pulse, { toValue: 0.3, duration: 600, useNativeDriver: true }),
      Animated.timing(pulse, { toValue: 1, duration: 600, useNativeDriver: true }),
    ]));
    loop.start();
    return () => {
      loop.stop();
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
      // Use the cached permission if we already have it — asking again adds a
      // round-trip that delayed the actual capture (first words were lost).
      let status = (await Audio.getPermissionsAsync()).status;
      if (status !== 'granted') status = (await Audio.requestPermissionsAsync()).status;
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
      // Prepare then start explicitly, and only begin the timer AFTER the
      // recorder reports it is actually running — so the elapsed time matches
      // the captured audio and the opening words aren't clipped.
      const recording = new Audio.Recording();
      await recording.prepareToRecordAsync({ ...Audio.RecordingOptionsPresets.HIGH_QUALITY, isMeteringEnabled: true });
      await recording.startAsync();
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
    audioManager.stop(); // one audio source at a time
    if (!previewSoundRef.current) {
      const { sound } = await Audio.Sound.createAsync(
        { uri },
        { shouldPlay: true },
        status => {
          if (!status.isLoaded) return;
          setPreviewProgress(status.positionMillis / (status.durationMillis || 1));
          if (status.didJustFinish) { setPreviewPlaying(false); setPreviewProgress(0); sound.stopAsync(); }
        }
      );
      previewSoundRef.current = sound;
      setPreviewPlaying(true);
    } else {
      const st = await previewSoundRef.current.getStatusAsync();
      if (!st.isLoaded) return;
      if (st.isPlaying) { await previewSoundRef.current.pauseAsync(); setPreviewPlaying(false); }
      else {
        if (st.didJustFinish || st.positionMillis >= (st.durationMillis || 0)) {
          await previewSoundRef.current.setPositionAsync(0);
        }
        await previewSoundRef.current.playAsync(); setPreviewPlaying(true);
      }
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
      <TouchableOpacity onPress={onCancel} style={s.trashBtn} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
        <Ionicons name="trash-outline" size={20} color={C.danger} />
      </TouchableOpacity>
      <View style={s.pill}>
        <Animated.View style={[s.recDot, { opacity: paused ? 0.4 : pulse }]} />
        <Text style={s.timer}>{fmtTime(seconds)}</Text>
        <View style={s.waveform}>
          {displayPeaks.map((h, i) => (
            <View key={i} style={[s.waveBar, { height: Math.max(3, h * 26), opacity: paused ? 0.4 : 0.9 }]} />
          ))}
        </View>
        <TouchableOpacity onPress={togglePause} hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}>
          <Ionicons name={paused ? 'play' : 'pause'} size={20} color={C.accent} />
        </TouchableOpacity>
      </View>
      <TouchableOpacity style={s.sendBtn} onPress={stopForPreview} accessibilityLabel="Stop and preview">
        <Ionicons name="checkmark" size={22} color="#fff" />
      </TouchableOpacity>
    </View>
  );

  return (
    <View style={s.bar}>
      <TouchableOpacity onPress={onCancel} style={s.trashBtn} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
        <Ionicons name="trash-outline" size={20} color={C.danger} />
      </TouchableOpacity>
      <View style={s.pill}>
        <TouchableOpacity onPress={togglePreview} style={s.playBtn}>
          <Ionicons name={previewPlaying ? 'pause' : 'play'} size={18} color="#fff" />
        </TouchableOpacity>
        <View style={s.waveform}>
          {displayPeaks.map((h, i) => (
            <View key={i} style={[s.waveBar, {
              height: Math.max(3, h * 26),
              backgroundColor: i / barCount < previewProgress ? C.accent : 'rgba(130,136,153,0.4)',
            }]} />
          ))}
        </View>
        <Text style={s.timer}>{fmtTime(seconds)}</Text>
      </View>
      <TouchableOpacity style={s.sendBtn} onPress={handleSend} accessibilityLabel="Send voice message">
        <Ionicons name="send" size={18} color="#fff" style={{ marginLeft: -1 }} />
      </TouchableOpacity>
    </View>
  );
}

const s = StyleSheet.create({
  bar: { flexDirection: 'row', alignItems: 'center', padding: 10, backgroundColor: C.header, borderTopWidth: 1, borderTopColor: C.border, gap: 8 },
  trashBtn: { padding: 4 },
  pill: {
    flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: C.inputBg, borderRadius: 22, paddingHorizontal: 12, height: 44,
    borderWidth: 1, borderColor: C.border,
  },
  recDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: C.danger },
  playBtn: { width: 30, height: 30, borderRadius: 15, backgroundColor: C.accent, alignItems: 'center', justifyContent: 'center' },
  waveform: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 2, height: 30, overflow: 'hidden' },
  waveBar: { flex: 1, minWidth: 2, maxWidth: 3, borderRadius: 2, backgroundColor: C.danger },
  timer: { color: C.text, fontSize: 13, fontWeight: '700', minWidth: 38, fontVariant: ['tabular-nums'] },
  sendBtn: { width: 44, height: 44, borderRadius: 22, backgroundColor: C.accent, alignItems: 'center', justifyContent: 'center' },
});
