import { Audio, InterruptionModeAndroid, InterruptionModeIOS } from 'expo-av';

type Listener = () => void;
type FinishHandler = (finishedId: number | string) => void;
export type Track = { id: number | string; uri: string; title: string };

// Global playback owner: only one sound plays at a time (in the app AND on the
// device — audio focus is requested with DoNotMix), and playback survives
// screen changes so a mini player can control it from anywhere.
class AudioManager {
  sound: Audio.Sound | null = null;
  currentId: number | string | null = null;
  roomId: number | null = null;
  roomMeta: any = null; // full room object, for navigating back to the chat
  label = '';
  playing = false;
  loading = false; // true from play() request until the sound finishes buffering enough to report status
  progress = 0; // 0..1
  duration = 0; // seconds
  rate = 1;

  // Bumped on every play() call so overlapping calls (e.g. rapid re-taps
  // while a previous load is still in flight) can detect they've been
  // superseded and unload themselves instead of playing alongside the winner.
  private playToken = 0;

  // ── Playlist ────────────────────────────────────────────────────────────────
  // The music player plays through every audio file in a chat, so a track that
  // ends advances to the next one and the UI can offer next/previous.
  queue: Track[] = [];
  queueIndex = -1;

  private listeners = new Set<Listener>();
  private finishHandler: FinishHandler | null = null;

  subscribe(fn: Listener) {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }
  private emit() { this.listeners.forEach(f => f()); }

  setFinishHandler(cb: FinishHandler | null) { this.finishHandler = cb; }

  async play(id: number | string, uri: string, label: string, roomId: number | null = null, roomMeta: any = null, keepQueue = false) {
    // Claim this play request immediately so any call already in flight
    // (e.g. from a prior tap) knows it's been superseded once it resolves.
    const token = ++this.playToken;
    // A one-off play (e.g. a voice message) leaves any music playlist behind.
    if (!keepQueue) { this.queue = []; this.queueIndex = -1; }

    try {
      await Audio.setAudioModeAsync({
        staysActiveInBackground: true,
        playsInSilentModeIOS: true,
        // DoNotMix means we take audio focus from other apps when we start.
        // NOTE: the reverse (pausing US when another app starts playing) is not
        // reliable here — staysActiveInBackground keeps the sound alive and
        // expo-av does not surface Android's AUDIOFOCUS_LOSS to JS, so there is
        // nothing to react to. Handling that properly needs a native media
        // session, which is also what would give us lock-screen/notification
        // transport controls. Tracked as a follow-up; do not assume this config
        // alone yields "pause when another app plays".
        interruptionModeAndroid: InterruptionModeAndroid.DoNotMix,
        interruptionModeIOS: InterruptionModeIOS.DoNotMix,
        shouldDuckAndroid: false,
        allowsRecordingIOS: false,
      });
    } catch {}
    if (token !== this.playToken) return; // superseded while awaiting audio mode

    if (this.sound) {
      try { await this.sound.unloadAsync(); } catch {}
      this.sound = null;
    }
    if (token !== this.playToken) return; // superseded while unloading previous sound

    this.currentId = id;
    this.roomId = roomId;
    this.roomMeta = roomMeta;
    this.label = label;
    this.playing = true;
    this.loading = true;
    this.progress = 0;
    this.duration = 0;
    this.emit();

    try {
      const { sound } = await Audio.Sound.createAsync(
        { uri },
        { shouldPlay: true, rate: this.rate, shouldCorrectPitch: true },
        status => {
          if (token !== this.playToken) return; // stale sound's status updates — ignore
          if (!status.isLoaded) return;
          this.loading = false;
          this.progress = status.positionMillis / (status.durationMillis || 1);
          this.duration = (status.durationMillis || 0) / 1000;
          if (status.didJustFinish) {
            this.playing = false;
            this.progress = 0;
            sound.stopAsync().catch(() => {});
            const finishedId = this.currentId;
            this.emit();
            // Playlist: roll straight into the next track. Otherwise hand off
            // to the finish handler (voice-message auto-advance).
            if (this.hasNext()) { this.next(); return; }
            if (this.finishHandler && finishedId != null) this.finishHandler(finishedId);
            return;
          }
          this.playing = status.isPlaying;
          this.emit();
        }
      );
      if (token !== this.playToken) {
        // A newer play() call won the race while this one was loading —
        // don't let this sound become (or keep playing as) an orphan.
        try { await sound.unloadAsync(); } catch {}
        return;
      }
      this.sound = sound;
      this.emit();
    } catch {
      if (token !== this.playToken) return;
      this.currentId = null;
      this.playing = false;
      this.loading = false;
      this.emit();
    }
  }

  // Start a playlist at `index`. Everything else (single voice messages) keeps
  // using play() directly, which clears the queue so the two never interfere.
  async playQueue(tracks: Track[], index: number, roomId: number | null = null, roomMeta: any = null) {
    if (!tracks.length) return;
    const i = Math.max(0, Math.min(index, tracks.length - 1));
    this.queue = tracks;
    this.queueIndex = i;
    const t = tracks[i];
    await this.play(t.id, t.uri, t.title, roomId, roomMeta, true);
  }

  hasNext() { return this.queueIndex >= 0 && this.queueIndex < this.queue.length - 1; }
  hasPrev() { return this.queueIndex > 0; }

  async next() {
    if (!this.hasNext()) return;
    await this.playQueue(this.queue, this.queueIndex + 1, this.roomId, this.roomMeta);
  }
  async prev() {
    // Standard behaviour: restart the track if we're past the first seconds.
    if (this.progress * this.duration > 3) return this.seek(0);
    if (!this.hasPrev()) return this.seek(0);
    await this.playQueue(this.queue, this.queueIndex - 1, this.roomId, this.roomMeta);
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
    ++this.playToken; // invalidate any in-flight play() so it unloads itself instead of taking over
    if (this.sound) {
      try { await this.sound.unloadAsync(); } catch {}
      this.sound = null;
    }
    this.currentId = null;
    this.roomId = null;
    this.roomMeta = null;
    this.queue = [];
    this.queueIndex = -1;
    this.playing = false;
    this.loading = false;
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

  // Seek to a fraction (0..1) of the current sound — lets the user scrub a
  // voice message by dragging across its waveform.
  async seek(fraction: number) {
    if (!this.sound || !this.duration) return;
    const f = Math.max(0, Math.min(1, fraction));
    try {
      await this.sound.setPositionAsync(Math.round(f * this.duration * 1000));
      this.progress = f;
      this.emit();
    } catch {}
  }
}

export const audioManager = new AudioManager();
