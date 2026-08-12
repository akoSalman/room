// Custom entry point (package.json "main" used to be expo/AppEntry).
//
// react-native-track-player's playback service MUST be registered at the very
// top level, outside the React tree — Android starts it in a headless context
// when the user taps a control in the notification shade or on the lock screen,
// with no UI mounted at all.
import { registerRootComponent } from 'expo';
import TrackPlayer from 'react-native-track-player';

import App from './App';

registerRootComponent(App);
TrackPlayer.registerPlaybackService(() => require('./src/playbackService'));
