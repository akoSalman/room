import React, { useEffect, useState } from 'react';
import {
  StatusBar, View, Text, I18nManager, BackHandler, AppState,
  Modal, TouchableOpacity, FlatList, StyleSheet, Linking, Alert, ActivityIndicator, Platform,
} from 'react-native';
import { useShareIntent } from 'expo-share-intent';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import * as Notifications from 'expo-notifications';
import notifee, { EventType, AndroidImportance } from '@notifee/react-native';
import { registerCallPush } from './src/callPush';
import { CALL_CHANNEL } from './src/incomingCall';
import { registerCallService, onEndFromShade, handleNotifeeEvent } from './src/ongoingCall';
import CrashBoundary from './src/components/CrashScreen';
import { installGlobalCrashHandler } from './src/globalCrash';
import * as mediaCache from './src/mediaCache';
import * as offlineStore from './src/offlineStore';
import {
  roomIdFromPush, roomFromPush, resolveRoom, screenFor, commentTargetFromPush,
  shouldKeepTrying, retryDelay, intentStillWanted, RoomRef, PushData,
} from './src/openIntent';
import AuthScreen from './src/screens/AuthScreen';
import RoomsScreen from './src/screens/RoomsScreen';
import CallOverlay from './src/components/CallOverlay';
import ConnectionStatus from './src/components/ConnectionStatus';
import { callManager } from './src/callManager';
import ChatScreen from './src/screens/ChatScreen';
import MiniPlayer from './src/components/MiniPlayer';
import Toast, { toast } from './src/components/Toast';
import { disconnectSocket, getSocket, getUsername, apiFetch, ensureSocketAlive, setSessionExpiredHandler, resetSessionExpiry } from './src/api';
import { audioManager } from './src/audioManager';
import * as outbox from './src/outbox';
import * as pushReg from './src/pushRegistration';
import * as notifyDiag from './src/notifyDiag';
import * as keepAlive from './src/keepAlive';
import * as socketNotifier from './src/socketNotifier';
import { C } from './src/theme';

// Keep the app layout LTR even on RTL locales (Persian/Arabic): mirroring the
// whole UI made screens look broken; message text itself still renders RTL.
I18nManager.allowRTL(false);
I18nManager.forceRTL(false);

// Notifications are for when the user is OUT of the app.
//
// THIS RETURNED false UNCONDITIONALLY, on the belief written above it for
// months: "this handler only runs while the app is foregrounded, so background
// pushes are shown by the system tray as usual."
//
// server.js says the opposite, and says it from a production failure — a call
// that would not ring with the app CLOSED:
//
//   "expo-notifications intercepts every FCM message and builds the
//    notification ITSELF rather than letting Firebase present it"
//
// Both cannot be true, and the one learned from a phone that did not ring is
// the one to believe. If expo builds the notification, it asks this handler
// whether to show it — and the answer was no, for every message, whether or
// not anybody was looking at the app.
//
// Which matches the report exactly: nothing at all, and then sometimes one
// arrives twenty minutes later. A message that lands while the process is
// ALIVE but backgrounded goes through expo, through here, and is suppressed.
// One that lands after Android has killed the process entirely has no expo
// running to intercept it, so the system tray draws it — late, but drawn.
//
// So it now answers the question it was actually asked: is the user looking at
// this app right now? Silence in the foreground, where in-app badges do the
// signalling and a popup over the conversation you are already reading is
// noise; a notification everywhere else.
//
// Safe in either direction. If expo really does not consult this in the
// background, nothing changes — the system tray was already drawing them.
Notifications.setNotificationHandler({
  // Playback controls are no longer a notification we draw — the media session
  // owns that now — so nothing here needs an exception.
  handleNotification: async () => {
    const inApp = AppState.currentState === 'active';
    // Recorded so the diagnostics screen can say whether messages are arriving
    // and being refused, rather than not arriving at all. Those two look
    // identical from outside and need opposite fixes.
    notifyDiag.record('handler', !inApp);
    return {
      shouldShowAlert: !inApp,
      shouldPlaySound: !inApp,
      shouldSetBadge: false,
    };
  },
});
// 'messages-v2': Android caches channel settings forever, so shipping the new
// custom sound requires a fresh channel id.
/**
 * The channel the server names in every push, so the app's own notifications
 * must name it too. Written once: a second spelling is how one of them ends up
 * on Android's default channel, silent.
 */
export const MESSAGES_CHANNEL = 'messages-v3';

Notifications.setNotificationChannelAsync(MESSAGES_CHANNEL, {
  name: 'Messages',
  importance: Notifications.AndroidImportance.MAX,
  sound: 'notify.wav',
  vibrationPattern: [0, 250, 250, 250],
}).catch(() => {});
// The same channel again, through notifee, because notifee is what posts on
// it and displayNotification REJECTS if the channel does not exist. Creating a
// channel twice is a no-op in Android; creating it in only one of the two
// libraries is a silent nothing-appears the first time the other one fails.
notifee.createChannel({
  id: MESSAGES_CHANNEL,
  name: 'Messages',
  // HIGH, and this is the ceiling despite the name.
  //
  // The diagnostics screen reads 6 on a fresh install where older builds read
  // 7, because these two calls race and Android keeps whichever creates the
  // channel FOREVER — importance cannot be changed afterwards. That looks
  // like a downgrade I introduced and it is not:
  //
  //   notifee HIGH = 4 = NotificationManager.IMPORTANCE_HIGH
  //   expo    MAX  = 7 = NotificationManager.IMPORTANCE_MAX = 5
  //
  // and IMPORTANCE_MAX is documented by Android as unused — IMPORTANCE_HIGH
  // is the highest level the system acts on, and is what makes a sound and a
  // heads-up. notifee exposes no MAX at all, for this reason. So 7 and 6 are
  // the same channel behaviour written on two different scales, and chasing
  // the 7 back would be changing a number on a screen and nothing else.
  importance: AndroidImportance.HIGH,
  sound: 'notify',
  vibration: true,
  vibrationPattern: [250, 250],
}).catch(() => {});
// ── Incoming calls, with the app closed ─────────────────────────────────────
//
// The background half — the push task, the notifee background handler and the
// ringing channel — now lives in src/callPush.ts and is registered from
// index.js BEFORE this file is imported.
//
// It was here, at module scope, on the reasoning that a background start
// evaluates this file. It does — but only after the whole import graph above
// has been evaluated first, and if any of it fails in a headless context the
// registration never runs and the call never rings, with nothing to show for
// it. Registering it ahead of this file removes that dependency.
//
// Called again here as a no-op safety net: if some future entry point forgets,
// a foregrounded app still rings.
registerCallPush();

// The ongoing-call foreground service. Registering the task must happen at
// import time: notifee requires it to exist before any foreground-service
// notification is displayed, and a registration done when a call starts is
// already too late — Android kills the service on the spot.
registerCallService();

// A JavaScript error outside React's render — in a promise, a socket handler,
// a timer — never reaches the boundary below. This puts those on screen too.
installGlobalCrashHandler();
onEndFromShade(() => { try { callManager.end(); } catch {} });

// Actions pressed while the app IS running — onBackgroundEvent is not called
// then, so both paths have to exist.
notifee.onForegroundEvent(async ({ type, detail }) => {
  // "End call" in the shade, and the press that brings the app back.
  if (handleNotifeeEvent(type, detail as any)) return;
  if (type !== EventType.ACTION_PRESS) return;
  if (detail.pressAction?.id === 'stop-location') {
    try {
      const { stopSharing } = require('./src/locationManager');
      await stopSharing();
    } catch {}
  }
});
// The SAME channel notifee creates in incomingCall.ts, created again here.
//
// Not belt and braces for its own sake: the server's call push names this
// channel, and if notifee is unavailable — an old build, a headless start that
// failed — ensureCallChannel swallows the error and the channel never exists.
// Android then draws the call on a default channel with a default chime, which
// is exactly the "it does not ring" that was reported. Creating a channel that
// already exists is a no-op, so whichever library gets there first wins and
// the ring survives either one failing.
//
// The id MUST match CALL_CHANNEL; the sound is the same res/raw/ring.
Notifications.setNotificationChannelAsync(CALL_CHANNEL, {
  name: 'Incoming calls',
  importance: Notifications.AndroidImportance.MAX,
  sound: 'ring.wav',
  vibrationPattern: [0, 800, 400, 800, 400, 800],
  bypassDnd: false,
}).catch(() => {});
// Accept / Decline buttons ON the incoming-call notification, so the user can
// answer straight from the notification shade without opening the app first.
Notifications.setNotificationCategoryAsync('incoming_call', [
  { identifier: 'accept', buttonTitle: '✅ Accept', options: { opensAppToForeground: true } },
  { identifier: 'decline', buttonTitle: '❌ Decline', options: { opensAppToForeground: false, isDestructive: true } },
]).catch(() => {});

type Room = { id: number; name: string; is_dm: number; other_username?: string };

const sh = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: C.header, borderTopLeftRadius: 18, borderTopRightRadius: 18,
    padding: 16, paddingBottom: 28,
  },
  title: { color: C.text, fontSize: 17, fontWeight: '800', marginBottom: 10, textAlign: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 12, paddingHorizontal: 6, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.border },
  rowIcon: { fontSize: 18, width: 26, textAlign: 'center' },
  rowText: { color: C.text, fontSize: 15.5, fontWeight: '600', flex: 1 },
  cancel: { marginTop: 12, alignSelf: 'center', paddingHorizontal: 22, paddingVertical: 10, borderRadius: 12, backgroundColor: 'rgba(239,68,68,0.15)' },
  cancelText: { color: '#ef4444', fontWeight: '700' },
  busyOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', alignItems: 'center', justifyContent: 'center' },
  busyCard: {
    backgroundColor: C.header, borderRadius: 16, paddingHorizontal: 30, paddingVertical: 26,
    alignItems: 'center', gap: 14,
  },
  busyText: { color: C.text, fontSize: 14.5, fontWeight: '600' },
});
type Screen = 'auth' | 'rooms' | 'chat';

export default function App() {
  const [screen, setScreen] = useState<Screen>('auth');
  const [room, setRoom] = useState<Room | null>(null);
  const [openProfileOnRooms, setOpenProfileOnRooms] = useState(false);
  const [pendingJumpMsgId, setPendingJumpMsgId] = useState<number | null>(null);
  /** A tapped comment notification, carried through to the chat that opens. */
  const [pendingComment, setPendingComment] =
    useState<{ parentId: number; commentId: number | null } | null>(null);
  const [pendingJoinRoomId, setPendingJoinRoomId] = useState<number | null>(null);

  const pushRegisteredRef = React.useRef(false);
  // True until this launch has sent its token once. Not state: nothing renders
  // from it, and it must not reset when the effect re-runs.
  const coldStartRef = React.useRef(true);

  // "Share to ChatRoom" from other apps: pick a chat, then the shared
  // files/text land staged in that chat's composer.
  const { hasShareIntent, shareIntent, resetShareIntent } = useShareIntent();
  const [shareRooms, setShareRooms] = useState<any[] | null>(null);
  const [pendingShare, setPendingShare] = useState<any>(null);

  // The chat picker must be built exactly ONCE per incoming share. This effect
  // also depends on `screen` (it has to wait for sign-in before it can load the
  // room list), and without this guard every later screen change — including
  // the setScreen('chat') that share targeting itself performs — re-ran it and
  // popped another copy of the picker on top of the previous one.
  // Cached media is kept, but not without limit — trim it back at startup so
  // a heavy chat history cannot quietly fill the phone.
  useEffect(() => { mediaCache.prune().catch(() => {}); }, []);

  const sharePickerBuiltRef = React.useRef(false);
  useEffect(() => {
    if (!hasShareIntent) { sharePickerBuiltRef.current = false; return; } // armed for the next share
    if (screen === 'auth' || sharePickerBuiltRef.current) return;
    // A picker is already on screen — never build a second one on top of it.
    if (shareRooms) return;
    sharePickerBuiltRef.current = true;
    (async () => {
      try {
        const [rooms, dms] = await Promise.all([apiFetch('/rooms'), apiFetch('/dm-rooms')]);
        const list = [
          ...(Array.isArray(dms) ? dms : []),
          ...(Array.isArray(rooms) ? rooms : []),
        ];
        setShareRooms(list);
      } catch { setShareRooms([]); }
    })();
  }, [hasShareIntent, screen, shareRooms]);

  // Only used when the sending app gave us no display name at all.
  function readableShareName(f: any) {
    const path = String(f?.path || f?.contentUri || '');
    const ext = (path.match(/\.([a-zA-Z0-9]{1,5})(?:\?|$)/) || [])[1] || '';
    const mime = String(f?.mimeType || '');
    const kind = mime.startsWith('image/') ? 'Photo'
      : mime.startsWith('video/') ? 'Video'
      : mime.startsWith('audio/') ? 'Audio'
      : 'File';
    const d = new Date();
    const p2 = (n: number) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}.${p2(d.getMinutes())}.${p2(d.getSeconds())}`;
    return `${kind} ${stamp}${ext ? '.' + ext.toLowerCase() : ''}`;
  }

  function chooseShareTarget(r: any) {
    const si: any = shareIntent || {};
    // Carry across everything the sender gave us: the real filename (so the
    // chat shows "Report.pdf", not "shared-1739…"), any per-file mime type, and
    // the accompanying text/subject/link, which becomes the caption.
    const caption = [si.text, si.webUrl, si.meta?.title]
      .filter((v: any) => typeof v === 'string' && v.trim())
      .filter((v: string, i: number, a: string[]) => a.indexOf(v) === i) // de-dupe
      .join('\n')
      .trim();
    setPendingShare({
      files: (si.files || []).map((f: any) => ({
        path: f.path || f.contentUri || '',
        mimeType: f.mimeType,
        // Keep the sender's display name. When there isn't one, the path is a
        // cache copy called something like "1739283746123.jpg" — a raw number
        // is a terrible thing to show, so synthesise a readable name from the
        // kind of file and the date instead.
        fileName: f.fileName || readableShareName(f),
      })),
      text: caption || null,
    });
    resetShareIntent();
    sharePickerBuiltRef.current = false;
    setShareRooms(null);
    setRoom({ id: r.id, name: r.name, is_dm: r.is_dm, other_username: r.other_username });
    setScreen('chat');
  }

  function cancelShare() {
    resetShareIntent();
    sharePickerBuiltRef.current = false;
    setShareRooms(null);
  }

  useEffect(() => {
    AsyncStorage.getItem('token').then(t => {
      // Never with a bare setScreen('rooms'): a notification tapped on a cold
      // start may already have opened its chat by the time this resolves, and
      // putting the list back over it is exactly the reported bug.
      setScreen(prev => screenFor({ hasToken: !!t, current: prev }));
    });
    // App-wide ack listener: clears pending-send copies even when the chat
    // that created them is closed.
    outbox.init().catch(() => {});
    // The socket is what actually delivers notifications on these networks —
    // measured 11 to Firebase's 2 — and Android freezes it with the process.
    // init() reads the crash canary first, so a handset the service killed
    // last time never tries again. Only then may a start be attempted, and
    // only from the foreground, which is the one place Android permits it.
    keepAlive.init()
      .then(() => keepAlive.start(AppState.currentState))
      .catch(() => {});
    Notifications.requestPermissionsAsync().catch(() => {});
    // Old notifications lingering in the tray are stale the moment the app
    // is opened — clear them on launch and every return to the foreground.
    Notifications.dismissAllNotificationsAsync().catch(() => {});
    const sub = AppState.addEventListener('change', st => {
      // TELL THE SERVER whether this device is actually in front of the user.
      //
      // The server suppresses push for anyone it believes is looking at the
      // room — "a device sitting on a room is not reading it" — and it has two
      // ways to learn otherwise: leave_room, which the chat screen sends, and
      // app_focus, which nothing in this app has ever sent. The web has sent
      // it since it was added.
      //
      // leave_room alone is not enough, because it needs this app's JavaScript
      // to run at the moment the screen goes off. When it does not — Doze, a
      // process frozen mid-transition, the app swiped away — the server goes
      // on believing the phone is reading the chat and sends NO PUSH AT ALL
      // for it. Silence, not lateness, and nothing on either side says why.
      //
      // Cheap enough to send on every transition, so the two never disagree
      // for longer than one event.
      getSocket().then(sk => sk?.emit('app_focus', st === 'active')).catch(() => {});
      if (st === 'active') {
        Notifications.dismissAllNotificationsAsync().catch(() => {});
        ensureSocketAlive(); // recover fast after SIM calls / network switches
        // Only here. A start from 'background' is what Android refuses, by
        // killing the process — which is how this crashed the media picker
        // the first time. keepAlive.mayStart enforces it too; this is the
        // call site agreeing with it rather than relying on it alone.
        keepAlive.start('active').catch(() => {});
        return;
      }
      // Leaving the app with a voice message loaded but NOT playing leaves its
      // media notification in the shade — reported with a photo of exactly
      // that. Music keeps its session, because coming back to a paused album
      // from the lock screen is the point of one.
      if (st === 'background' && !audioManager.playing && !audioManager.queue?.length) {
        audioManager.stop().catch(() => {});
      }
    });
    // THE ONE FACT THAT SPLITS THE PROBLEM IN HALF: did a push message reach
    // this app at all? If they arrive and nothing is drawn, the fault is here.
    // If none ever arrives, they are being lost between Google and the phone,
    // and no change in this repository can reach that. Those two look
    // identical from the outside — "no notification" — and need opposite
    // fixes, which is why six diagnoses in a row picked the wrong one.
    const recvSub = Notifications.addNotificationReceivedListener(() => {
      notifyDiag.record('received');
    });

    // Tapping a message notification opens its chat; tapping a call
    // notification just needs the app open — the server re-delivers the
    // still-ringing call over the fresh socket.
    const respSub = Notifications.addNotificationResponseReceivedListener(resp => {
      const data: any = resp?.notification?.request?.content?.data || {};
      const action = resp?.actionIdentifier;
      if (data.type === 'call') {
        // Reconnect the socket so the server re-delivers the ringing offer,
        // then accept/decline once the incoming call is present.
        ensureSocketAlive();
        if (action === 'decline') {
          callManager.declineIncomingFrom(parseInt(String(data.fromUserId), 10));
        } else {
          // 'accept' (or tapping the body) — auto-accept as soon as the
          // re-delivered offer arrives.
          callManager.armAutoAccept(parseInt(String(data.fromUserId), 10));
        }
        return;
      }
      openChatFromPush(data);
    });
    // Cold start from a tapped notification
    Notifications.getLastNotificationResponseAsync().then(resp => {
      openChatFromPush(resp?.notification?.request?.content?.data);
    }).catch(() => {});
    return () => { sub.remove(); respSub.remove(); recvSub.remove(); };
  }, []);

  /**
   * Open the chat a tapped notification was about.
   *
   * Reported as: sometimes the app opens and stays on the chat list. It did,
   * for four different reasons, all of which ended in the same silence — see
   * src/openIntent.ts. The intent is now something that survives until it is
   * satisfied rather than one attempt that gives up without a word.
   */
  const openIntent = React.useRef<{ roomId: number; at: number; from: RoomRef | null } | null>(null);
  const resolving = React.useRef(false);

  function openChatFromPush(data: PushData | null | undefined) {
    const roomId = roomIdFromPush(data);
    if (!roomId) return;
    // Set before the chat opens, so the thread is part of opening it rather
    // than a second jump the user watches happen.
    setPendingComment(commentTargetFromPush(data));
    openIntent.current = { roomId, at: Date.now(), from: roomFromPush(data) };
    resolveOpenIntent();
  }

  async function resolveOpenIntent() {
    if (resolving.current) return;
    const intent = openIntent.current;
    if (!intent) return;
    if (!(await AsyncStorage.getItem('token'))) return;  // the intent waits for the sign-in
    resolving.current = true;
    try {
      // 1. What the notification itself said. Newer servers name the room, and
      //    then this costs nothing and cannot fail.
      let r: RoomRef | null = intent.from;
      // 2. What the phone already knows. A push lands exactly when the
      //    connection is least dependable, and the room list is on disk.
      if (!r) {
        const cached = await offlineStore.loadRooms();
        r = resolveRoom(cached ? { rooms: cached.rooms, dms: cached.dms } : null, intent.roomId);
      }
      // 3. The server — and if it does not answer, again, rather than
      //    abandoning the chat the user asked for.
      for (let attempt = 0; !r && shouldKeepTrying(attempt); attempt++) {
        const [rooms, dms] = await Promise.all([apiFetch('/rooms'), apiFetch('/dm-rooms')]);
        r = resolveRoom({ rooms, dms }, intent.roomId);
        if (r || !shouldKeepTrying(attempt + 1)) break;
        await new Promise(res => setTimeout(res, retryDelay(attempt)));
        // The user got tired of waiting and went somewhere themselves.
        if (openIntent.current !== intent) return;
      }
      if (!intentStillWanted({ at: intent.at, now: Date.now() })) return;
      if (openIntent.current !== intent) return;
      openIntent.current = null;
      if (!r) {
        // Never silently: this is the difference between "the app ignored me"
        // and "it could not reach the server just now".
        toast('Could not open that chat — no connection');
        return;
      }
      setRoom({ id: r.id, name: r.name, is_dm: r.is_dm, other_username: r.other_username });
      setScreen('chat');
    } finally {
      resolving.current = false;
    }
  }

  // A tap that arrived while signed out, or while the network was down, is
  // picked up again when either changes.
  useEffect(() => {
    if (screen !== 'auth' && openIntent.current) resolveOpenIntent();
  }, [screen]);

  // Invitation links (https://<host>/join/<roomId>, or chatroom://join/<roomId>).
  // Tapping one joins the room — for a private room this only succeeds if the
  // user actually holds an invitation — and then opens it.
  async function handleJoinLink(url: string | null) {
    const m = url && /\/join\/(\d+)/.exec(url);
    if (!m) return;
    const roomId = parseInt(m[1], 10);
    const token = await AsyncStorage.getItem('token');
    if (!token) { setPendingJoinRoomId(roomId); return; } // finish after sign-in
    try {
      const sock = await getSocket();
      sock.emit('accept_invite', { roomId }, (res: any) => {
        if (res?.error) { Alert.alert('Cannot join', res.error); return; }
        const r = res.room;
        setRoom({ id: r.id, name: r.name, is_dm: 0 });
        setScreen('chat');
      });
    } catch {
      Alert.alert('Cannot join', 'You appear to be offline. Try again once connected.');
    }
  }

  useEffect(() => {
    // Cold start (app was closed when the link was tapped) …
    Linking.getInitialURL().then(handleJoinLink).catch(() => {});
    // … and while the app is already running.
    const sub = Linking.addEventListener('url', e => handleJoinLink(e.url));
    return () => sub.remove();
  }, []);

  // A link tapped while signed out is replayed once the user signs in.
  useEffect(() => {
    if (screen === 'rooms' && pendingJoinRoomId) {
      const id = pendingJoinRoomId;
      setPendingJoinRoomId(null);
      handleJoinLink(`/join/${id}`);
    }
  }, [screen, pendingJoinRoomId]);

  // Register the device FCM token so the server can push notifications that
  // arrive even when the app is closed. Silently no-ops until the build
  // includes google-services.json (Firebase config).
  //
  // Reported as: in the latest APK, push notifications are not received at the
  // time — they turn up when the app is opened, which means the socket is
  // delivering them and the push never happened.
  //
  // This used to be one attempt, made the moment the sign-in screen went away,
  // and it asked `getPermissionsAsync()` first. On a fresh install the system
  // permission dialog is still on screen at that point and the honest answer is
  // "not granted", so it returned — and because its dependency was
  // `[screen === 'auth']`, which never changes again, it never ran a second
  // time. The user granted permission a second later to an app that had
  // already given up, and the server was never told this device's token.
  //
  // It is now a state rather than an event: while the server has not been told
  // the CURRENT token, keep trying — on a backoff, on every return to the
  // foreground, and whenever Firebase reissues the token. See
  // src/pushRegistration.ts.
  useEffect(() => {
    if (screen === 'auth') return;
    let alive = true;
    let timer: any = null;
    let attempt = 0;

    const attemptRegister = async (): Promise<void> => {
      if (!alive) return;
      // Any pending retry is superseded by this attempt. Without this, coming
      // back to the app while one is scheduled leaves both running and the
      // backoff stops meaning anything.
      clearTimeout(timer);
      try {
        const perm = await Notifications.getPermissionsAsync();
        // Not answered yet, or refused. Either way there is nothing to send —
        // but this is the case that used to end registration for good, so it
        // falls through to the retry rather than returning.
        if (perm.granted) {
          const tok = await Notifications.getDevicePushTokenAsync();
          const token = tok?.data ? String(tok.data) : '';
          const sent = await AsyncStorage.getItem(pushReg.SENT_TOKEN_KEY).catch(() => null);
          const sentAt = Number(await AsyncStorage.getItem(pushReg.SENT_AT_KEY).catch(() => null)) || 0;
          // coldStart is what build 255 did implicitly and what build 256
          // stopped doing: send the token once per launch whatever the app
          // remembers, because the SERVER's copy can be gone without the token
          // having changed. See needsSend.
          if (!pushReg.needsSend({
            granted: true, token, sentToken: sent, sentAt, coldStart: coldStartRef.current,
          })) {
            // Already registered with this exact token, recently enough to
            // trust: nothing to do, and nothing to retry.
            if (token) pushRegisteredRef.current = true;
            return;
          }
          const res = await apiFetch('/push-token', 'POST', { token, platform: 'android' });
          if (res?.ok) {
            pushRegisteredRef.current = true;
            // The launch has now had its unconditional send.
            coldStartRef.current = false;
            // Remembered only AFTER the server accepted it, so a failed POST
            // is retried rather than recorded as done.
            AsyncStorage.setItem(pushReg.SENT_TOKEN_KEY, token).catch(() => {});
            AsyncStorage.setItem(pushReg.SENT_AT_KEY, String(Date.now())).catch(() => {});
            notifyDiag.record('token-accepted');
            return;
          }
        }
      } catch {}
      if (!alive) return;
      attempt += 1;
      if (!pushReg.shouldRetry({ attempt, registered: pushRegisteredRef.current })) return;
      timer = setTimeout(attemptRegister, pushReg.retryDelay(attempt));
    };

    attemptRegister();

    // Coming back to the app is a second chance, and the one that catches the
    // user who granted permission from Settings after refusing the dialog.
    const appSub = AppState.addEventListener('change', st => {
      if (st !== 'active' || pushRegisteredRef.current) return;
      attempt = 0;
      attemptRegister();
    });
    // Firebase reissues tokens — on reinstall, on restore to a new device,
    // after a long idle. Without this the server keeps pushing to a token that
    // has stopped existing, and the phone stays quiet with nothing to show for
    // it on either side.
    let tokSub: any = null;
    try {
      tokSub = Notifications.addPushTokenListener(() => {
        pushRegisteredRef.current = false;
        attempt = 0;
        attemptRegister();
      });
    } catch {}

    return () => {
      alive = false;
      clearTimeout(timer);
      appSub.remove();
      try { tokSub?.remove?.(); } catch {}
    };
  }, [screen === 'auth']);

  // Global notifications: any message from someone else, in any room except
  // the one currently open, raises a local notification.
  //
  // THE LISTENER IS NOT OWNED BY THIS COMPONENT ANY MORE, and that is the
  // whole point of the change. It used to be registered here with the
  // ordinary cleanup — sock.off('message_received', handler) — which meant
  // the socket's lifetime and the listener's lifetime belonged to different
  // things: the socket to the keep-alive foreground service, the listener to
  // a mounted React tree. Closing the app tore the listener off a socket that
  // was still connected and still receiving, so nothing was drawn; reopening
  // re-attached it, which is exactly why this read as "works when open, not
  // when closed" instead of as a bug.
  //
  // socketNotifier.attach() is idempotent and is never undone here. All this
  // effect does now is tell it where the user is, as a value — a closure over
  // React state would be the same lifetime mistake in a different shape.
  useEffect(() => {
    if (screen === 'auth') return;
    let cancelled = false;
    (async () => {
      const uname = await getUsername();
      const sock = await getSocket();
      if (cancelled) return;
      socketNotifier.setMe(uname);
      socketNotifier.attach(sock, { pushRegistered: () => pushRegisteredRef.current });
    })();
    return () => { cancelled = true; };
  }, [screen === 'auth']);

  // Where the user is, pushed to the notifier so it can stay silent about the
  // conversation already on screen. Not a dependency of the attach above.
  useEffect(() => {
    socketNotifier.setViewing(screen === 'chat' && room ? room.id : null);
  }, [screen, room?.id]);

  // Hardware back: step back through screens instead of closing the app.
  // (Modals handle their own back via onRequestClose.)
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (screen === 'chat') {
        setScreen('rooms');
        setRoom(null);
        return true;
      }
      return false; // rooms/auth: default behavior (exit)
    });
    return () => sub.remove();
  }, [screen]);

  async function logout() {
    // SENT_TOKEN_KEY goes with the account, not with the device.
    //
    // It records "the server has been told this token", and the server stores
    // that token against whoever was signed in at the time. Left behind, the
    // next person to sign in on this phone has the same device token, so
    // registration would decide there is nothing to send — and they would get
    // no push notifications at all, with everything appearing to work.
    await keepAlive.stop().catch(() => {});
    await AsyncStorage.multiRemove(['token', 'username', 'avatar', pushReg.SENT_TOKEN_KEY, pushReg.SENT_AT_KEY]);
    pushRegisteredRef.current = false;
    // Signing out must not leave the previous account's chats readable on the
    // device — the offline copy is real message content.
    await offlineStore.clearAll();
    audioManager.stop();
    disconnectSocket();
    socketNotifier.detach();
    setScreen('auth');
    setRoom(null);
  }

  useEffect(() => {
    if (screen !== 'auth') callManager.init().catch(() => {});
  }, [screen]);

  // A token the server no longer accepts (secret rotated, account removed)
  // used to leave the app in a half-dead state the user had to escape by
  // signing out by hand. Detect it once and do the sign-out for them.
  useEffect(() => {
    setSessionExpiredHandler(() => {
      logout().catch(() => {});
      Alert.alert('Signed out', 'Your session expired. Please sign in again.');
    });
    return () => setSessionExpiredHandler(null);
  }, []);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      {/* Inside the providers so the crash screen can be drawn even when the
          fault is in a screen; outside every screen so it catches all of
          them. See crashReport.ts for why this exists. */}
      <CrashBoundary onRestart={() => { setScreen('auth'); setRoom(null); setScreen('rooms'); }}>
      <SafeAreaProvider>
        <StatusBar barStyle="dark-content" backgroundColor={C.header} />
        <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }} edges={['top']}>
          {screen !== 'auth' && (
            <MiniPlayer
              // Always shown, even in the chat the track came from. It used to
              // be suppressed there, so starting a track gave no visible player
              // at all and there was nothing to hint that tapping it opens the
              // full player and the chat's playlist.
              hideForRoomId={null}
              onNavigate={(r, msgId) => { setRoom(r); setPendingJumpMsgId(msgId); setScreen('chat'); }}
            />
          )}
          {screen === 'auth' && (
            <AuthScreen onLogin={() => { resetSessionExpiry(); setScreen('rooms'); }} />
          )}
          {screen === 'rooms' && (
            <RoomsScreen
              onSelectRoom={r => { setRoom(r); setScreen('chat'); }}
              onLogout={logout}
              openProfileOnMount={openProfileOnRooms}
              onProfileOpened={() => setOpenProfileOnRooms(false)}
            />
          )}
          {screen === 'chat' && room && (
            <ChatScreen
              key={room.id}
              room={room}
              onBack={() => { setScreen('rooms'); setPendingJumpMsgId(null); setPendingComment(null); }}
              onOpenDM={r => { setRoom(r); setPendingJumpMsgId(null); }}
              // The live-location bar, tapped from a different chat: switch to
              // the one the share is in and land on the message itself.
              onOpenRoom={(r, msgId) => { setRoom(r); setPendingJumpMsgId(msgId); setScreen('chat'); }}
              onOpenProfile={() => { setOpenProfileOnRooms(true); setScreen('rooms'); setPendingJumpMsgId(null); }}
              initialJumpMsgId={pendingJumpMsgId}
              initialCommentTarget={pendingComment}
              initialShare={pendingShare}
              onShareConsumed={() => setPendingShare(null)}
            />
          )}

          {/* Share-target chat picker */}
          {/* Feedback for the whole share hand-off, with no gap in the middle:
              from the intent arriving, through the chat picker loading, and on
              until the chat has actually staged the file in its composer
              (pendingShare is cleared by onShareConsumed). Previously it
              stopped at the picker, so after choosing a chat the user watched
              an empty composer with no idea anything was still happening. */}
          <Modal visible={(hasShareIntent && !shareRooms && screen !== 'auth') || !!pendingShare} transparent animationType="fade">
            <View style={sh.busyOverlay}>
              <View style={sh.busyCard}>
                <ActivityIndicator size="large" color={C.accent} />
                <Text style={sh.busyText}>Preparing shared content…</Text>
              </View>
            </View>
          </Modal>

          <Modal visible={hasShareIntent && !!shareRooms && screen !== 'auth'} transparent animationType="slide" onRequestClose={cancelShare}>
            <View style={sh.overlay}>
              <View style={sh.sheet}>
                <Text style={sh.title}>Share to…</Text>
                <FlatList
                  data={shareRooms || []}
                  keyExtractor={(item: any) => String(item.id)}
                  style={{ maxHeight: 420 }}
                  renderItem={({ item }: any) => (
                    <TouchableOpacity style={sh.row} onPress={() => chooseShareTarget(item)}>
                      <Text style={sh.rowIcon}>{item.is_dm ? '💬' : item.is_private ? '🔒' : '#'}</Text>
                      <Text style={sh.rowText} numberOfLines={1}>{item.is_dm ? (item.other_username || item.name) : item.name}</Text>
                    </TouchableOpacity>
                  )}
                />
                <TouchableOpacity style={sh.cancel} onPress={cancelShare}>
                  <Text style={sh.cancelText}>Cancel</Text>
                </TouchableOpacity>
              </View>
            </View>
          </Modal>
          {/* Rendered last so the full-screen call UI sits above every screen */}
          {/* App-wide copy confirmations */}
          <Toast />
          {screen !== 'auth' && <CallOverlay />}
          {screen !== 'auth' && <ConnectionStatus />}
        </SafeAreaView>
      </SafeAreaProvider>
      </CrashBoundary>
    </GestureHandlerRootView>
  );
}
