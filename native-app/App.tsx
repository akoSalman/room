import React, { useEffect, useState } from 'react';
import { StatusBar, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import AuthScreen from './src/screens/AuthScreen';
import RoomsScreen from './src/screens/RoomsScreen';
import ChatScreen from './src/screens/ChatScreen';
import { disconnectSocket } from './src/api';
import { C } from './src/theme';

type Room = { id: number; name: string; is_dm: number; other_username?: string };
type Screen = 'auth' | 'rooms' | 'chat';

export default function App() {
  const [screen, setScreen] = useState<Screen>('auth');
  const [room, setRoom] = useState<Room | null>(null);

  useEffect(() => {
    AsyncStorage.getItem('token').then(t => {
      if (t) setScreen('rooms');
    });
  }, []);

  async function logout() {
    await AsyncStorage.multiRemove(['token', 'username']);
    disconnectSocket();
    setScreen('auth');
    setRoom(null);
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <StatusBar barStyle="dark-content" backgroundColor={C.header} />
        <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }} edges={['top']}>
          {screen === 'auth' && (
            <AuthScreen onLogin={() => setScreen('rooms')} />
          )}
          {screen === 'rooms' && (
            <RoomsScreen
              onSelectRoom={r => { setRoom(r); setScreen('chat'); }}
              onLogout={logout}
            />
          )}
          {screen === 'chat' && room && (
            <ChatScreen
              key={room.id}
              room={room}
              onBack={() => setScreen('rooms')}
              onOpenDM={r => setRoom(r)}
            />
          )}
        </SafeAreaView>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
