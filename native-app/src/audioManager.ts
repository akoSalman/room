// Global playback owner: only one thing plays at a time, playback survives
// screen changes so the mini player can control it from anywhere, and — the
// point of this rewrite — it keeps playing with real transport controls in the
// notification shade and on the lock screen when the app is not in front.
//
// The engine is react-native-track-player, which runs an Android foreground
// service with a MediaSession. The three previous attempts at this drew a
// notification from JS with expo-notifications; that could never work properly,
// because nothing kept the process alive or connected those buttons to the OS
// media session. This does both.
//
// The PUBLIC API below is unchanged from the expo-av implementation on purpose:
// MiniPlayer, FullMusicPlayer, MusicPlayer, VoicePlayer, ChatScreen, callManager
// and App all talk to this singleton, and none of them needed to change.
import TrackPlayer, {
  AppKilledPlaybackBehavior, Capability, Event, State,
} from 'react-native-track-player';

type Listener = () => void;
type FinishHandler = (finishedId: number | string) => void;
export type Track = { id: number | string; uri: string; title: string };

class AudioManager {
  currentId: number | string | null = null;
  roomId: number | null = null;
  roomMeta: any = null; // full room object, for navigating back to the chat
  label = '';
  playing = false;
  loading = false;
  progress = 0; // 0..1
  duration = 0; // seconds
  rate = 1;

  // Bumped on every play() so an overlapping call (rapid re-taps while a load
  // is still in flight) can tell it has been superseded and bail out.
  private playToken = 0;

  // ── Playlist ────────────────────────────────────────────────────────────────
  queue: Track[] = [];
  queueIndex = -1;

  private listeners = new Set<Listener>();
  private finishHandler: FinishHandler | null = null;
  private setupPromise: Promise<void> | null = null;
  private ready = false;

  subscribe(fn: Listener) {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }
  private emit() { this.listeners.forEach(f => f()); }

  setFinishHandler(cb: FinishHandler | null) { this.finishHandler = cb; }

  // Idempotent: every entry point awaits this, and setupPlayer() must run
  // exactly once for the lifetime of the process.
  private ensureSetup(): Promise<void> {
    if (this.setupPromise) return this.setupPromise;
    this.setupPromise = (async () => {
      try {
        await TrackPlayer.setupPlayer({ autoHandleInterruptions: true });
      } catch (e: any) {
        // "player already initialized" is fine — a hot reload or a second
        // caller racing us. Anything else leaves us un-ready.
        const msg = String(e?.message || e || '');
        if (!/already been initialized|already initialized/i.test(msg)) {
          this.setupPromise = null;
          throw e;
        }
      }
      await TrackPlayer.updateOptions({
        android: {
          // Playback ends when the app is swiped away, and the notification
          // goes with it — a stranded, dead player in the shade is worse than
          // no player.
          appKilledPlaybackBehavior: AppKilledPlaybackBehavior.StopPlaybackAndRemoveNotification,
        },
        capabilities: [
          Capability.Play, Capability.Pause, Capability.Stop,
          Capability.SeekTo, Capability.SkipToNext, Capability.SkipToPrevious,
        ],
        // What fits in the collapsed shade row.
        compactCapabilities: [Capability.Play, Capability.Pause, Capability.SkipToNext],
        notificationCapabilities: [
          Capability.Play, Capability.Pause, Capability.Stop,
          Capability.SeekTo, Capability.SkipToNext, Capability.SkipToPrevious,
        ],
        progressUpdateEventInterval: 0.5,
      });
      this.bindEvents();
      this.ready = true;
    })();
    return this.setupPromise;
  }

  private bound = false;
  private bindEvents() {
    if (this.bound) return;
    this.bound = true;

    TrackPlayer.addEventListener(Event.PlaybackState, ({ state }) => {
      this.loading = state === State.Loading || state === State.Buffering;
      this.playing = state === State.Playing;
      // Stop pressed in the shade or on the lock screen: the service clears
      // itself, so the in-app mini player has to go too, or it sits there
      // claiming to be playing something that no longer exists.
      if (state === State.Stopped || state === State.None) {
        this.currentId = null;
        this.roomId = null;
        this.roomMeta = null;
        this.queue = [];
        this.queueIndex = -1;
        this.progress = 0;
      }
      this.emit();
    });

    TrackPlayer.addEventListener(Event.PlaybackProgressUpdated, ({ position, duration }) => {
      this.duration = duration || 0;
      this.progress = duration ? position / duration : 0;
      this.emit();
    });

    // Advancing through a playlist: keep our mirrored index and label in step
    // with whatever the player (or the shade's Next button) actually did.
    TrackPlayer.addEventListener(Event.PlaybackActiveTrackChanged, ({ index, track }) => {
      if (typeof index === 'number' && index >= 0) {
        this.queueIndex = this.queue.length ? index : -1;
        const q = this.queue[index];
        if (q) { this.currentId = q.id; this.label = q.title; }
        else if (track?.title) this.label = track.title;
      }
      this.progress = 0;
      this.emit();
    });

    // Nothing left to play. For a single item (a voice message) this is where
    // the auto-advance-to-the-next-voice-message handler runs.
    TrackPlayer.addEventListener(Event.PlaybackQueueEnded, () => {
      const finishedId = this.currentId;
      this.playing = false;
      this.progress = 0;
      this.emit();
      if (this.queue.length) return;   // playlists advance on their own

      const tokenBefore = this.playToken;
      if (this.finishHandler && finishedId != null) this.finishHandler(finishedId);

      // Nothing followed it. Clear the player out rather than leaving a
      // finished track loaded: a loaded track keeps the media session alive,
      // so its notification reappears every time the app is reopened — even
      // after the user has swiped it away. Deferred a tick so an auto-advance
      // started by the handler above wins.
      setTimeout(() => {
        if (this.playToken !== tokenBefore || this.playing) return;
        this.stop().catch(() => {});
      }, 300);
    });
  }

  private toRNTrack(t: Track) {
    return { id: String(t.id), url: t.uri, title: t.title, artist: 'ChatRoom' };
  }

  async play(
    id: number | string, uri: string, label: string,
    roomId: number | null = null, roomMeta: any = null, keepQueue = false,
  ) {
    const token = ++this.playToken;
    // A one-off play (a voice message) leaves any music playlist behind.
    if (!keepQueue) { this.queue = []; this.queueIndex = -1; }

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
      await this.ensureSetup();
      if (token !== this.playToken) return;   // superseded while setting up

      await TrackPlayer.reset();
      if (token !== this.playToken) return;

      if (keepQueue && this.queue.length) {
        await TrackPlayer.add(this.queue.map(t => this.toRNTrack(t)));
        if (token !== this.playToken) return;
        if (this.queueIndex > 0) await TrackPlayer.skip(this.queueIndex);
      } else {
        await TrackPlayer.add(this.toRNTrack({ id, uri, title: label }));
      }
      if (token !== this.playToken) return;

      await TrackPlayer.setRate(this.rate);
      await TrackPlayer.play();
    } catch {
      if (token !== this.playToken) return;
      this.currentId = null;
      this.playing = false;
      this.loading = false;
      this.emit();
    }
  }

  // Start a playlist at `index`. Single voice messages keep using play(),
  // which clears the queue so the two never interfere.
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
    try { await TrackPlayer.skipToNext(); } catch {}
  }

  async prev() {
    // Standard behaviour: restart the track if we're past the first seconds.
    if (this.progress * this.duration > 3) return this.seek(0);
    if (!this.hasPrev()) return this.seek(0);
    try { await TrackPlayer.skipToPrevious(); } catch {}
  }

  async toggle() {
    if (this.currentId == null) return;
    try {
      await this.ensureSetup();
      const state = await TrackPlayer.getPlaybackState();
      if (state.state === State.Playing) {
        await TrackPlayer.pause();
        this.playing = false;
      } else {
        // Finished tracks restart rather than sitting at the end doing nothing.
        if (state.state === State.Ended) await TrackPlayer.seekTo(0);
        await TrackPlayer.play();
        this.playing = true;
      }
      this.emit();
    } catch {}
  }

  async stop() {
    ++this.playToken; // invalidate any in-flight play()
    try { if (this.ready) await TrackPlayer.reset(); } catch {}
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
    try { if (this.ready) await TrackPlayer.setRate(rate); } catch {}
    this.emit();
  }

  // Seek to a fraction (0..1) of the current track — lets the user scrub a
  // voice message by dragging across its waveform.
  async seek(fraction: number) {
    if (!this.duration) return;
    const f = Math.max(0, Math.min(1, fraction));
    try {
      await TrackPlayer.seekTo(f * this.duration);
      this.progress = f;
      this.emit();
    } catch {}
  }
}

export const audioManager = new AudioManager();
