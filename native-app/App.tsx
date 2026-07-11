import React, { useEffect, useState } from 'react';
import {
  StatusBar, View, Text, I18nManager, BackHandler, AppState,
  Modal, TouchableOpacity, FlatList, StyleSheet,
} from 'react-native';
import { useShareIntent } from 'expo-share-intent';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import * as Notifications from 'expo-notifications';
import AuthScreen from './src/screens/AuthScreen';
import RoomsScreen from './src/screens/RoomsScreen';
import CallOverlay from './src/components/CallOverlay';
import { callManager } from './src/callManager';
import ChatScreen from './src/screens/ChatScreen';
import MiniPlayer from './src/components/MiniPlayer';
import { disconnectSocket, getSocket, getUsername, apiFetch } from './src/api';
import { audioManager } from './src/audioManager';
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
  handleNotification: async () => ({
    shouldShowAlert: false, shouldPlaySound: false, shouldSetBadge: false,
  }),
});
// 'messages-v2': Android caches channel settings forever, so shipping the new
// custom sound requires a fresh channel id.
Notifications.setNotificationChannelAsync('messages-v3', {
  name: 'Messages',
  importance: Notifications.AndroidImportance.MAX,
  sound: 'notify.wav',
  vibrationPattern: [0, 250, 250, 250],
}).catch(() => {});

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
});
type Screen = 'auth' | 'rooms' | 'chat';

export default function App() {
  const [screen, setScreen] = useState<Screen>('auth');
  const [room, setRoom] = useState<Room | null>(null);
  const [openProfileOnRooms, setOpenProfileOnRooms] = useState(false);
  const [pendingJumpMsgId, setPendingJumpMsgId] = useState<number | null>(null);

  const pushRegisteredRef = React.useRef(false);

  // "Share to ChatRoom" from other apps: pick a chat, then the shared
  // files/text land staged in that chat's composer.
  const { hasShareIntent, shareIntent, resetShareIntent } = useShareIntent();
  const [shareRooms, setShareRooms] = useState<any[] | null>(null);
  const [pendingShare, setPendingShare] = useState<any>(null);

  useEffect(() => {
    if (!hasShareIntent || screen === 'auth') return;
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
    setPendingShare({
      files: (shareIntent?.files || []).map((f: any) => ({
        path: f.path || f.contentUri || '',
        mimeType: f.mimeType,
        fileName: f.fileName,
      })),
      text: shareIntent?.text || null,
    });
    resetShareIntent();
    setShareRooms(null);
    setRoom({ id: r.id, name: r.name, is_dm: r.is_dm, other_username: r.other_username });
    setScreen('chat');
  }

  function cancelShare() {
    resetShareIntent();
    setShareRooms(null);
  }

  useEffect(() => {
    AsyncStorage.getItem('token').then(t => {
      if (t) setScreen('rooms');
    });
    Notifications.requestPermissionsAsync().catch(() => {});
    // Old notifications lingering in the tray are stale the moment the app
    // is opened — clear them on launch and every return to the foreground.
    Notifications.dismissAllNotificationsAsync().catch(() => {});
    const sub = AppState.addEventListener('change', st => {
      if (st === 'active') Notifications.dismissAllNotificationsAsync().catch(() => {});
    });
    return () => sub.remove();
  }, []);

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
        Notifications.scheduleNotificationAsync({
          content: { title: msg.username, body, sound: 'notify.wav' },
          trigger: null,
        }).catch(() => {});
      };
      sock.on('message_received', handler);
    })();
    return () => { if (sock && handler) sock.off('message_received', handler); };
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
            <AuthScreen onLogin={() => setScreen('rooms')} />
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
          {screen !== 'auth' && <CallOverlay />}
        </SafeAreaView>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
