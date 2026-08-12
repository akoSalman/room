// The playback service runs OUTSIDE the React tree, in the foreground service
// that react-native-track-player owns. It is what makes the shade/lock-screen
// controls actually work: the buttons the user taps there are delivered here,
// not to any mounted component, and they keep arriving after the UI is gone.
//
// This is the piece the previous notification-based attempts could never have:
// expo-notifications could draw buttons, but nothing kept the process alive or
// wired those buttons into the OS media session.
import TrackPlayer, { Event } from 'react-native-track-player';

module.exports = async function playbackService() {
  TrackPlayer.addEventListener(Event.RemotePlay, () => TrackPlayer.play());
  TrackPlayer.addEventListener(Event.RemotePause, () => TrackPlayer.pause());
  TrackPlayer.addEventListener(Event.RemoteNext, () => TrackPlayer.skipToNext().catch(() => {}));
  TrackPlayer.addEventListener(Event.RemotePrevious, () => TrackPlayer.skipToPrevious().catch(() => {}));
  TrackPlayer.addEventListener(Event.RemoteSeek, ({ position }) => TrackPlayer.seekTo(position));
  TrackPlayer.addEventListener(Event.RemoteStop, () => TrackPlayer.reset());
  // Headset unplugged / Bluetooth disconnected: stop blaring out of the phone
  // speaker, which is what every other media app does.
  TrackPlayer.addEventListener(Event.RemoteDuck, async ({ paused, permanent }) => {
    if (permanent) return TrackPlayer.pause();
    if (paused) return TrackPlayer.pause();
  });
};
