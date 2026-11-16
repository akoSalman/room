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
import { I18nManager } from 'react-native';
import TrackPlayer from 'react-native-track-player';

import { registerCallPush } from './src/callPush';

// ── The layout stays LTR, even on a Persian phone ───────────────────────────
//
// Reported with a photograph: on a device set to Persian the whole screen is
// mirrored — the back arrow on the right, the microphone on the left, every
// name and timestamp on the wrong side.
//
// App.tsx already called these two, under a comment saying they "keep the app
// layout LTR even on RTL locales". They do not. React Native's own source
// says why:
//
//     const i18nConstants = getI18nManagerConstants();   // read ONCE, at load
//     allowRTL: (shouldAllow) => { NativeI18nManager.allowRTL(shouldAllow); }
//
// isRTL is a constant captured when the module loads, and allowRTL only writes
// a flag the NATIVE side reads at startup. So neither call can change the
// session it runs in: the first launch after installing on a Persian phone is
// mirrored no matter where they are called from, and stays mirrored until the
// app is next started from cold. Which, for an app with a keep-alive service
// holding it in memory, can be a very long time.
//
// Moved here so the flag is written before anything else in the app runs, and
// paired with the only thing that can act on it in the same session: a
// reload.
I18nManager.allowRTL(false);
I18nManager.forceRTL(false);

registerCallPush();

// The reload that applies it NOW lives in App.tsx, not here.
//
// index.js also runs on a HEADLESS start — Android waking the app for an
// incoming call push, with no UI at all. Reloading there would restart the
// process in the middle of answering a call, to fix the look of a screen
// nobody is on. App.tsx mounts only when there is something to look at.

// Imported after the registration above on purpose — see the note.
const App = require('./App').default;

registerRootComponent(App);
TrackPlayer.registerPlaybackService(() => require('./src/playbackService'));
