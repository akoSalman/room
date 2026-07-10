import React, { useEffect, useState } from 'react';
import { StatusBar, View, I18nManager, BackHandler } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import * as Notifications from 'expo-notifications';
import AuthScreen from './src/screens/AuthScreen';
import RoomsScreen from './src/screens/RoomsScreen';
import ChatScreen from './src/screens/ChatScreen';
import MiniPlayer from './src/components/MiniPlayer';
import { disconnectSocket, getSocket, getUsername, apiFetch } from './src/api';
import { audioManager } from './src/audioManager';
import { C } from './src/theme';

// Keep the app layout LTR even on RTL locales (Persian/Arabic): mirroring the
// whole UI made screens look broken; message text itself still renders RTL.
I18nManager.allowRTL(false);
I18nManager.forceRTL(false);

// Android needs a notification channel or notifications never show at all
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true, shouldPlaySound: true, shouldSetBadge: false,
  }),
});
Notifications.setNotificationChannelAsync('messages', {
  name: 'Messages',
  importance: Notifications.AndroidImportance.MAX,
  sound: 'default',
  vibrationPattern: [0, 250, 250, 250],
}).catch(() => {});

type Room = { id: number; name: string; is_dm: number; other_username?: string };
type Screen = 'auth' | 'rooms' | 'chat';

export default function App() {
  const [screen, setScreen] = useState<Screen>('auth');
  const [room, setRoom] = useState<Room | null>(null);
  const [openProfileOnRooms, setOpenProfileOnRooms] = useState(false);
  const [pendingJumpMsgId, setPendingJumpMsgId] = useState<number | null>(null);

  const pushRegisteredRef = React.useRef(false);

  useEffect(() => {
    AsyncStorage.getItem('token').then(t => {
      if (t) setScreen('rooms');
    });
    Notifications.requestPermissionsAsync().catch(() => {});
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
        if (screen === 'chat' && room && msg.room_id === room.id) return;
        const body = (msg.content && String(msg.content).startsWith('e2e:')) ? '🔒 Message'
          : msg.type === 'text' ? (msg.content || '')
          : msg.type === 'audio' ? '🎙 Voice message'
          : msg.type === 'image' ? '🖼 Image'
          : msg.type === 'video' ? '🎥 Video'
          : msg.type === 'music' ? '🎵 Audio file'
          : msg.type === 'invite' ? '🔒 Room invitation' : '📄 File';
        Notifications.scheduleNotificationAsync({
          content: { title: msg.username, body, sound: 'default' },
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
            />
          )}
        </SafeAreaView>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
