// Custom entry point (package.json "main" used to be expo/AppEntry).
//
// Everything Android can start WITHOUT a UI is registered here, at the top
// level, before the app itself is imported. Two such things exist:
//
//  • the track-player playback service, which Android starts in a headless
//    context when a control is tapped in the notification shade or on the
//    lock screen;
//  • the incoming-call handlers, which have to run when a call push arrives
//    and the app is closed.
//
// The call handlers used to sit at module scope inside App.tsx. That does run
// on a background start — but only after App.tsx's whole import graph has been
// evaluated: chat screen, socket, WebRTC, media cache, player. One of those
// failing in a headless context takes the module down and the call never
// rings, silently. Registering first, from a file that imports almost nothing,
// removes that dependency entirely.
import { registerRootComponent } from 'expo';
import TrackPlayer from 'react-native-track-player';

import { registerCallPush } from './src/callPush';

registerCallPush();

// Imported after the registration above on purpose — see the note.
const App = require('./App').default;

registerRootComponent(App);
TrackPlayer.registerPlaybackService(() => require('./src/playbackService'));
