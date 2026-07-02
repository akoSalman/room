import React, { useEffect, useState } from 'react';
import { StatusBar, View, I18nManager, BackHandler } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import AuthScreen from './src/screens/AuthScreen';
import RoomsScreen from './src/screens/RoomsScreen';
import ChatScreen from './src/screens/ChatScreen';
import MiniPlayer from './src/components/MiniPlayer';
import { disconnectSocket } from './src/api';
import { audioManager } from './src/audioManager';
import { C } from './src/theme';

// Let the OS mirror layout automatically on RTL locales (e.g. Persian, Arabic)
I18nManager.allowRTL(true);

type Room = { id: number; name: string; is_dm: number; other_username?: string };
type Screen = 'auth' | 'rooms' | 'chat';

export default function App() {
  const [screen, setScreen] = useState<Screen>('auth');
  const [room, setRoom] = useState<Room | null>(null);
  const [openProfileOnRooms, setOpenProfileOnRooms] = useState(false);

  useEffect(() => {
    AsyncStorage.getItem('token').then(t => {
      if (t) setScreen('rooms');
    });
  }, []);

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
            <MiniPlayer hideForRoomId={screen === 'chat' && room ? room.id : null} />
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
              onBack={() => setScreen('rooms')}
              onOpenDM={r => setRoom(r)}
              onOpenProfile={() => { setOpenProfileOnRooms(true); setScreen('rooms'); }}
            />
          )}
        </SafeAreaView>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
