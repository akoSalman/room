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
  AppKilledPlaybackBehavior, Capability, Event, RepeatMode, State,
} from 'react-native-track-player';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { orderFor, nextRepeat, Repeat } from './playlist';
import * as mediaCache from './mediaCache';
import { playbackFlags, TrackState } from './playbackState';

type Listener = () => void;
type FinishHandler = (finishedId: number | string) => void;
export type Track = {
  id: number | string; uri: string; title: string;
  /** False for audio the listener may not keep on their device. */
  cacheable?: boolean;
};

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
  // `queue` is the PLAY order — what the player actually holds, so it changes
  // when shuffle is toggled. `baseQueue` is the chat's own order, kept so that
  // turning shuffle off can restore it.
  queue: Track[] = [];
  baseQueue: Track[] = [];
  queueIndex = -1;
  shuffle = false;
  repeat: Repeat = 'off';

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
      // Restore the user's shuffle/repeat choice from the last session — a
      // player that forgets these every launch is irritating.
      try {
        const saved = await AsyncStorage.getItem('playerModes');
        if (saved) {
          const m = JSON.parse(saved);
          if (typeof m.shuffle === 'boolean') this.shuffle = m.shuffle;
          if (m.repeat === 'off' || m.repeat === 'all' || m.repeat === 'one') this.repeat = m.repeat;
        }
      } catch {}
      await this.applyRepeat();
    })();
    return this.setupPromise;
  }

  /**
   * How many start-up sequences are in flight.
   *
   * A counter, not a boolean: a second tap while the first track is still
   * being loaded would otherwise have the inner sequence clear the flag while
   * the outer one is still running.
   */
  private starting = 0;

  private static stateName(state: any): TrackState {
    switch (state) {
      case State.Playing: return 'playing';
      case State.Paused: return 'paused';
      case State.Stopped: return 'stopped';
      case State.Buffering: return 'buffering';
      case State.Loading: return 'loading';
      case State.Ready: return 'ready';
      case State.Ended: return 'ended';
      case State.Error: return 'error';
      case State.Connecting: return 'connecting';
      default: return 'none';
    }
  }

  /** Apply a reported player state to our own flags. */
  private applyState(state: any) {
    const f = playbackFlags(AudioManager.stateName(state), this.starting > 0);
    this.loading = f.loading;
    this.playing = f.playing;
    if (f.clearCurrent) {
      // A real stop — pressed in the shade or on the lock screen. The in-app
      // player has to go too, or it sits there claiming to be playing
      // something that no longer exists.
      this.currentId = null;
      this.roomId = null;
      this.roomMeta = null;
      this.queue = [];
      this.baseQueue = [];
      this.queueIndex = -1;
      this.progress = 0;
    }
    this.emit();
  }

  /** Clears a paused voice message out of the shade — see bindEvents(). */
  private pausedSweep: any = null;
  private bound = false;
  private bindEvents() {
    if (this.bound) return;
    this.bound = true;

    TrackPlayer.addEventListener(Event.PlaybackState, ({ state }) => {
      this.applyState(state);
      // A PAUSED voice message is not music: nobody comes back to it from the
      // lock screen, and leaving it loaded keeps a media session — and its
      // notification — in the shade with no way to get rid of it from inside
      // the app. A playlist is different and keeps its session.
      const paused = AudioManager.stateName(state) === 'paused';
      if (paused && !this.queue.length && this.currentId != null) {
        const tokenBefore = this.playToken;
        clearTimeout(this.pausedSweep);
        // A moment's grace: pause-then-resume is one tap, and stopping in
        // between would throw the position away.
        this.pausedSweep = setTimeout(() => {
          if (this.playToken !== tokenBefore || this.playing) return;
          this.stop().catch(() => {});
        }, 20000);
      } else {
        clearTimeout(this.pausedSweep);
      }
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

  /**
   * The same track, played from disk when we already have the file.
   *
   * A voice message re-listened to, or a song replayed, used to be streamed
   * from the server every time. The first play caches it; every one after is
   * local, which also means it still plays with no connection.
   */
  private async toCachedTrack(t: Track) {
    // Content the listener may not keep is streamed and never written down.
    if (t.cacheable === false) return this.toRNTrack(t);
    const uri = await mediaCache.resolve(t.uri).catch(() => t.uri);
    return this.toRNTrack({ ...t, uri });
  }

  async play(
    id: number | string, uri: string, label: string,
    roomId: number | null = null, roomMeta: any = null, keepQueue = false,
    cacheable = true,
  ) {
    const token = ++this.playToken;
    // A one-off play (a voice message) leaves any music playlist behind.
    if (!keepQueue) { this.queue = []; this.baseQueue = []; this.queueIndex = -1; }

    this.currentId = id;
    this.roomId = roomId;
    this.roomMeta = roomMeta;
    this.label = label;
    this.playing = true;
    this.loading = true;
    this.progress = 0;
    this.duration = 0;
    this.emit();

    // Everything from here to play() taking effect is start-up: the states the
    // player reports in between describe the transition, not the result.
    this.starting++;
    try {
      await this.ensureSetup();
      if (token !== this.playToken) return;   // superseded while setting up

      await TrackPlayer.reset();
      if (token !== this.playToken) return;

      if (keepQueue && this.queue.length) {
        await TrackPlayer.add(await Promise.all(this.queue.map(t => this.toCachedTrack(t))));
        if (token !== this.playToken) return;
        if (this.queueIndex > 0) await TrackPlayer.skip(this.queueIndex);
      } else {
        await TrackPlayer.add(await this.toCachedTrack({ id, uri, title: label, cacheable }));
      }
      if (token !== this.playToken) return;

      await TrackPlayer.setRate(this.rate);
      await TrackPlayer.play();

      // Reconcile with the player's real state. The UI is driven by
      // PlaybackState events, and if one is missed or coalesced the bubble is
      // left showing the wrong icon while audio comes out of the speaker.
      //
      // Still inside start-up on purpose: right after play() the player
      // normally reports Ready or Buffering, and writing that in as "not
      // playing" is what used to leave a playing message showing ▶ with no
      // further event coming to correct it.
      if (token !== this.playToken) return;
      const st = await TrackPlayer.getPlaybackState();
      this.applyState(st.state);
    } catch {
      if (token !== this.playToken) return;
      this.currentId = null;
      this.playing = false;
      this.loading = false;
      this.emit();
    } finally {
      this.starting = Math.max(0, this.starting - 1);
      // One settled re-read shortly after start-up finishes. If the player was
      // still Ready when we last looked, nothing else would arrive to move the
      // UI off its spinner; this closes that hole without polling.
      const settle = token;
      setTimeout(() => {
        if (settle !== this.playToken) return;
        TrackPlayer.getPlaybackState()
          .then(x => this.applyState(x.state))
          .catch(() => {});
      }, 500);
    }
  }

  // Start a playlist at `index`. Single voice messages keep using play(),
  // which clears the queue so the two never interfere.
  async playQueue(tracks: Track[], index: number, roomId: number | null = null, roomMeta: any = null) {
    if (!tracks.length) return;
    const i = Math.max(0, Math.min(index, tracks.length - 1));
    const picked = tracks[i];

    // The chat's own order is remembered so shuffle can be undone later.
    this.baseQueue = tracks;
    // Starting a shuffled playlist shuffles it around whatever was tapped —
    // that track still plays first, which is what tapping it meant.
    const { order, index: at } = orderFor(tracks, picked.id, this.shuffle);
    this.queue = order;
    this.queueIndex = at;

    await this.play(picked.id, picked.uri, picked.title, roomId, roomMeta, true, picked.cacheable !== false);
  }

  hasNext() {
    if (this.queueIndex < 0) return false;
    // Repeating the whole list means Next always has somewhere to go.
    if (this.repeat === 'all' && this.queue.length > 1) return true;
    return this.queueIndex < this.queue.length - 1;
  }
  hasPrev() {
    if (this.queueIndex < 0) return false;
    if (this.repeat === 'all' && this.queue.length > 1) return true;
    return this.queueIndex > 0;
  }

  async next() {
    if (!this.hasNext()) return;
    try {
      // Repeat-one still means "give me the next track" when Next is pressed
      // deliberately — it only repeats when a track ends on its own. The
      // player's own repeat mode would swallow the skip, so step around it.
      if (this.repeat === 'one') {
        const to = (this.queueIndex + 1) % this.queue.length;
        await TrackPlayer.skip(to);
        await TrackPlayer.play();
        return;
      }
      await TrackPlayer.skipToNext();
    } catch {}
  }

  // ── Shuffle and repeat ──────────────────────────────────────────────────────

  private async persistModes() {
    try {
      await AsyncStorage.setItem('playerModes',
        JSON.stringify({ shuffle: this.shuffle, repeat: this.repeat }));
    } catch {}
  }

  private async applyRepeat() {
    try {
      await TrackPlayer.setRepeatMode(
        this.repeat === 'one' ? RepeatMode.Track
          : this.repeat === 'all' ? RepeatMode.Queue
          : RepeatMode.Off,
      );
    } catch {}
  }

  async toggleRepeat() {
    this.repeat = nextRepeat(this.repeat);
    this.emit();
    await this.applyRepeat();
    this.persistModes();
  }

  async toggleShuffle() {
    this.shuffle = !this.shuffle;
    this.emit();
    this.persistModes();
    if (!this.queue.length) return;

    const base = this.baseQueue.length ? this.baseQueue : this.queue;
    const { order, index } = orderFor(base, this.currentId, this.shuffle);
    this.queue = order;
    this.queueIndex = index;
    this.emit();

    // Re-order the player WITHOUT touching the playing track: remove every
    // other track, then add them back around it. Rebuilding the queue from
    // scratch would stop the music, which is not what pressing shuffle means.
    try {
      if (!this.ready) return;
      const rnQueue = await TrackPlayer.getQueue();
      const active = await TrackPlayer.getActiveTrackIndex();
      if (typeof active !== 'number' || active < 0) return;

      const others = rnQueue.map((_, i) => i).filter(i => i !== active);
      if (others.length) await TrackPlayer.remove(others);
      // The playing track is now the only one left, at position 0.
      const before = await Promise.all(order.slice(0, index).map(t => this.toCachedTrack(t)));
      const after = await Promise.all(order.slice(index + 1).map(t => this.toCachedTrack(t)));
      if (after.length) await TrackPlayer.add(after);
      if (before.length) await TrackPlayer.add(before, 0);
    } catch {}
  }

  async prev() {
    // Standard behaviour: restart the track if we're past the first seconds.
    if (this.progress * this.duration > 3) return this.seek(0);
    if (!this.hasPrev()) return this.seek(0);
    try {
      // At the top of a repeating list, Previous wraps to the end rather than
      // doing nothing.
      if (this.queueIndex <= 0 && this.repeat === 'all' && this.queue.length > 1) {
        await TrackPlayer.skip(this.queue.length - 1);
        await TrackPlayer.play();
        return;
      }
      await TrackPlayer.skipToPrevious();
    } catch {}
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
    // The reset below reports Stopped/None; stop() clears everything itself
    // just after, so the event handler must not race it.
    this.starting++;
    // NOT gated on `this.ready`. Reported with a photo: the voice message's
    // notification is still in the shade after the player has been closed.
    // `ready` is set when setup SUCCEEDS, and a player that was set up by an
    // earlier launch — or whose setup call failed after the service had
    // already started — still owns a media session and its notification.
    // Refusing to reset it because a flag in this process says "not ready" is
    // how a notification outlives the thing it belongs to.
    try { await TrackPlayer.stop(); } catch {}
    try { await TrackPlayer.reset(); } catch {}
    this.starting = Math.max(0, this.starting - 1);
    this.currentId = null;
    this.roomId = null;
    this.roomMeta = null;
    this.queue = [];
    this.baseQueue = [];
    this.queueIndex = -1;
    this.playing = false;
    this.loading = false;
    this.progress = 0;
    this.emit();
  }

  /**
   * A message's id changed under us.
   *
   * Your own voice message plays from an optimistic bubble with a temporary
   * `tmp-…` id, and the server's echo then replaces it with the real one. The
   * player kept pointing at the old id, so the bubble showed "ready to play"
   * while its audio was already playing.
   */
  retarget(oldId: number | string, newId: number | string) {
    if (String(oldId) === String(newId)) return;
    let touched = false;
    if (String(this.currentId) === String(oldId)) { this.currentId = newId; touched = true; }
    this.queue = this.queue.map(t => {
      if (String(t.id) !== String(oldId)) return t;
      touched = true;
      return { ...t, id: newId };
    });
    this.baseQueue = this.baseQueue.map(t =>
      String(t.id) === String(oldId) ? { ...t, id: newId } : t);
    if (touched) this.emit();
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
