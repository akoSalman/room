import { Audio, InterruptionModeAndroid, InterruptionModeIOS } from 'expo-av';

type Listener = () => void;
type FinishHandler = (finishedId: number) => void;

// Global playback owner: only one sound plays at a time (in the app AND on the
// device — audio focus is requested with DoNotMix), and playback survives
// screen changes so a mini player can control it from anywhere.
class AudioManager {
  sound: Audio.Sound | null = null;
  currentId: number | null = null;
  roomId: number | null = null;
  roomMeta: any = null; // full room object, for navigating back to the chat
  label = '';
  playing = false;
  progress = 0; // 0..1
  duration = 0; // seconds
  rate = 1;

  private listeners = new Set<Listener>();
  private finishHandler: FinishHandler | null = null;

  subscribe(fn: Listener) {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }
  private emit() { this.listeners.forEach(f => f()); }

  setFinishHandler(cb: FinishHandler | null) { this.finishHandler = cb; }

  async play(id: number, uri: string, label: string, roomId: number | null = null, roomMeta: any = null) {
    try {
      await Audio.setAudioModeAsync({
        staysActiveInBackground: true,
        playsInSilentModeIOS: true,
        interruptionModeAndroid: InterruptionModeAndroid.DoNotMix,
        interruptionModeIOS: InterruptionModeIOS.DoNotMix,
        shouldDuckAndroid: false,
        allowsRecordingIOS: false,
      });
    } catch {}

    if (this.sound) {
      try { await this.sound.unloadAsync(); } catch {}
      this.sound = null;
    }
    this.currentId = id;
    this.roomId = roomId;
    this.roomMeta = roomMeta;
    this.label = label;
    this.playing = true;
    this.progress = 0;
    this.duration = 0;
    this.emit();

    try {
      const { sound } = await Audio.Sound.createAsync(
        { uri },
        { shouldPlay: true, rate: this.rate, shouldCorrectPitch: true },
        status => {
          if (!status.isLoaded) return;
          this.progress = status.positionMillis / (status.durationMillis || 1);
          this.duration = (status.durationMillis || 0) / 1000;
          if (status.didJustFinish) {
            this.playing = false;
            this.progress = 0;
            sound.stopAsync().catch(() => {});
            const finishedId = this.currentId;
            this.emit();
            if (this.finishHandler && finishedId != null) this.finishHandler(finishedId);
            return;
          }
          this.playing = status.isPlaying;
          this.emit();
        }
      );
      this.sound = sound;
      this.emit();
    } catch {
      this.currentId = null;
      this.playing = false;
      this.emit();
    }
  }

  async toggle() {
    if (!this.sound) return;
    const st = await this.sound.getStatusAsync();
    if (!st.isLoaded) return;
    if (st.isPlaying) {
      await this.sound.pauseAsync();
      this.playing = false;
    } else {
      if (st.positionMillis >= (st.durationMillis || 0)) {
        await this.sound.setPositionAsync(0);
      }
      await this.sound.playAsync();
      this.playing = true;
    }
    this.emit();
  }

  async stop() {
    if (this.sound) {
      try { await this.sound.unloadAsync(); } catch {}
      this.sound = null;
    }
    this.currentId = null;
    this.roomId = null;
    this.roomMeta = null;
    this.playing = false;
    this.progress = 0;
    this.emit();
  }

  async setRate(rate: number) {
    this.rate = rate;
    if (this.sound) {
      try { await this.sound.setRateAsync(rate, true); } catch {}
    }
    this.emit();
  }
}

export const audioManager = new AudioManager();
