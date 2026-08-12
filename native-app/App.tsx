import React, { useEffect, useState } from 'react';
import {
  StatusBar, View, Text, I18nManager, BackHandler, AppState,
  Modal, TouchableOpacity, FlatList, StyleSheet, Linking, Alert, ActivityIndicator,
} from 'react-native';
import { useShareIntent } from 'expo-share-intent';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import * as Notifications from 'expo-notifications';
import AuthScreen from './src/screens/AuthScreen';
import RoomsScreen from './src/screens/RoomsScreen';
import CallOverlay from './src/components/CallOverlay';
import ConnectionStatus from './src/components/ConnectionStatus';
import { callManager } from './src/callManager';
import ChatScreen from './src/screens/ChatScreen';
import MiniPlayer from './src/components/MiniPlayer';
import Toast from './src/components/Toast';
import { disconnectSocket, getSocket, getUsername, apiFetch, ensureSocketAlive, setSessionExpiredHandler, resetSessionExpiry } from './src/api';
import { audioManager } from './src/audioManager';
import * as outbox from './src/outbox';
import * as mediaNotification from './src/mediaNotification';
import { C } from './src/theme';

// Keep the app layout LTR even on RTL locales (Persian/Arabic): mirroring the
// whole UI made screens look broken; message text itself still renders RTL.
I18nManager.allowRTL(false);
I18nManager.forceRTL(false);

// Notifications are for when the user is OUT of the app. This handler only
// runs while the app is foregrounded, so suppress the popup entirely there —
// in-app unread badges do the signalling. Background pushes are shown by the
// system tray as usual.
Notifications.setNotificationHandler({
  handleNotification: async (notification) => {
    // The playback-controls notification MUST be shown — it is the media
    // player in the shade, not an alert. Everything else stays suppressed
    // while the app is foregrounded (in-app badges do the signalling).
    const data: any = notification?.request?.content?.data || {};
    if (data.mediaControls) {
      return { shouldShowAlert: true, shouldPlaySound: false, shouldSetBadge: false };
    }
    return { shouldShowAlert: false, shouldPlaySound: false, shouldSetBadge: false };
  },
});
// 'messages-v2': Android caches channel settings forever, so shipping the new
// custom sound requires a fresh channel id.
Notifications.setNotificationChannelAsync('messages-v3', {
  name: 'Messages',
  importance: Notifications.AndroidImportance.MAX,
  sound: 'notify.wav',
  vibrationPattern: [0, 250, 250, 250],
}).catch(() => {});
// Incoming calls get their own channel that RINGS (looping-feel ring sound,
// long vibration) so it behaves like a real phone call notification.
Notifications.setNotificationChannelAsync('calls-v1', {
  name: 'Calls',
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
  const [pendingJoinRoomId, setPendingJoinRoomId] = useState<number | null>(null);

  const pushRegisteredRef = React.useRef(false);

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
  const sharePickerBuiltRef = React.useRef(false);
  useEffect(() => {
    if (!hasShareIntent) { sharePickerBuiltRef.current = false; return; } // armed for the next share
    if (screen === 'auth' || sharePickerBuiltRef.current) return;
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
  }, [hasShareIntent, screen]);

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
        fileName: f.fileName || f.name || null,
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
      if (t) setScreen('rooms');
    });
    // App-wide ack listener: clears pending-send copies even when the chat
    // that created them is closed.
    outbox.init().catch(() => {});
    // Playback controls in the notification shade while the app is backgrounded.
    mediaNotification.setup().catch(() => {});
    Notifications.requestPermissionsAsync().catch(() => {});
    // Old notifications lingering in the tray are stale the moment the app
    // is opened — clear them on launch and every return to the foreground.
    Notifications.dismissAllNotificationsAsync().catch(() => {});
    const sub = AppState.addEventListener('change', st => {
      if (st === 'active') {
        Notifications.dismissAllNotificationsAsync().catch(() => {});
        ensureSocketAlive(); // recover fast after SIM calls / network switches
      }
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
      if (data.roomId) openRoomById(parseInt(String(data.roomId), 10));
    });
    // Cold start from a tapped notification
    Notifications.getLastNotificationResponseAsync().then(resp => {
      const data: any = resp?.notification?.request?.content?.data || {};
      if (data.roomId && data.type !== 'call') openRoomById(parseInt(String(data.roomId), 10));
    }).catch(() => {});
    return () => { sub.remove(); respSub.remove(); };
  }, []);

  // Find a room/DM by id and open its chat screen.
  async function openRoomById(roomId: number) {
    if (!roomId) return;
    try {
      const [rooms, dms] = await Promise.all([apiFetch('/rooms'), apiFetch('/dm-rooms')]);
      const all = [...(Array.isArray(dms) ? dms : []), ...(Array.isArray(rooms) ? rooms : [])];
      const r = all.find((x: any) => x.id === roomId);
      if (r) {
        setRoom({ id: r.id, name: r.name, is_dm: r.is_dm, other_username: r.other_username });
        setScreen('chat');
      }
    } catch {}
  }

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
  useEffect(() => {
    if (screen === 'auth') return;
    (async () => {
      try {
        const perm = await Notifications.getPermissionsAsync();
        if (!perm.granted) return;
        const tok = await Notifications.getDevicePushTokenAsync();
        if (tok?.data) {
          const res = await apiFetch('/push-token', 'POST', { token: String(tok.data), platform: 'android' });
          if (res?.ok) pushRegisteredRef.current = true;
        }
      } catch {}
    })();
  }, [screen === 'auth']);

  // Global notifications: any message from someone else, in any room except
  // the one currently open, raises a local notification.
  useEffect(() => {
    if (screen === 'auth') return;
    let sock: any = null;
    let handler: any = null;
    let delHandler: any = null;
    (async () => {
      const uname = await getUsername();
      sock = await getSocket();
      handler = (msg: any) => {
        if (pushRegisteredRef.current) return; // FCM push covers notifications
        if (msg.username === uname) return;
        if (AppState.currentState === 'active') return; // in-app badges cover it
        if (screen === 'chat' && room && msg.room_id === room.id) return;
        // Never preview content — only the kind of message received
        const body = msg.type === 'text' ? '💬 New message'
          : msg.type === 'audio' ? '🎙 Voice message'
          : msg.type === 'image' ? '🖼 Photo'
          : msg.type === 'gallery' ? '🖼 Photos'
          : msg.type === 'video' ? '🎥 Video'
          : msg.type === 'music' ? '🎵 Audio file'
          : msg.type === 'invite' ? '🔒 Room invitation' : '📄 File';
        // Tie the notification to the message id so it can be pulled from the
        // tray if the sender deletes the message.
        Notifications.scheduleNotificationAsync({
          identifier: `msg-${msg.id}`,
          content: { title: msg.username, body, sound: 'notify.wav' },
          trigger: null,
        }).catch(() => {});
      };
      // When a message is deleted, dismiss its notification on this device too.
      delHandler = ({ messageId }: any) => {
        Notifications.dismissNotificationAsync(`msg-${messageId}`).catch(() => {});
      };
      sock.on('message_received', handler);
      sock.on('message_deleted', delHandler);
    })();
    return () => {
      if (sock && handler) sock.off('message_received', handler);
      if (sock && delHandler) sock.off('message_deleted', delHandler);
    };
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
    await AsyncStorage.multiRemove(['token', 'username', 'avatar']);
    audioManager.stop();
    disconnectSocket();
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
      <SafeAreaProvider>
        <StatusBar barStyle="dark-content" backgroundColor={C.header} />
        <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }} edges={['top']}>
          {screen !== 'auth' && (
            <MiniPlayer
              hideForRoomId={screen === 'chat' && room ? room.id : null}
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
              onBack={() => { setScreen('rooms'); setPendingJumpMsgId(null); }}
              onOpenDM={r => { setRoom(r); setPendingJumpMsgId(null); }}
              onOpenProfile={() => { setOpenProfileOnRooms(true); setScreen('rooms'); setPendingJumpMsgId(null); }}
              initialJumpMsgId={pendingJumpMsgId}
              initialShare={pendingShare}
              onShareConsumed={() => setPendingShare(null)}
            />
          )}

          {/* Share-target chat picker */}
          {/* A share has arrived but the chat picker isn't ready yet (the room
              list is still loading, and a heavy file is still being copied out
              of the sending app). Without this the app just sat there looking
              frozen after "Share to ChatRoom". */}
          <Modal visible={hasShareIntent && !shareRooms && screen !== 'auth'} transparent animationType="fade">
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
    </GestureHandlerRootView>
  );
}
