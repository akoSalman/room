// Floating connection-status pill shown at the top center whenever the socket
// is not connected (offline / reconnecting), plus a brief "Back online" flash.
import React, { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, Animated, AppState } from 'react-native';
import { getSocket, ensureSocketAlive } from '../api';

type State = 'online' | 'reconnecting' | 'offline' | null;

export default function ConnectionStatus() {
  const [state, setState] = useState<State>(null);
  const opacity = useRef(new Animated.Value(0)).current;
  const hideTimer = useRef<any>(null);
  const hasConnected = useRef(false);

  useEffect(() => {
    let sock: any;
    let mounted = true;
    // Only becomes "offline" (vs "reconnecting") after several failed attempts,
    // which in practice means the network is down rather than a blip.
    let attempts = 0;

    const apply = (next: State) => { if (mounted) setState(next); };

    const onConnect = () => { hasConnected.current = true; attempts = 0; apply('online'); };
    const onDisconnect = () => apply('reconnecting');
    const onAttempt = () => { attempts += 1; apply(attempts >= 3 ? 'offline' : 'reconnecting'); };

    (async () => {
      sock = await getSocket();
      if (sock.connected) apply(null);
      sock.on('connect', onConnect);
      sock.on('disconnect', onDisconnect);
      sock.io?.on('reconnect_attempt', onAttempt);
      sock.io?.on('error', onAttempt);
    })();

    const appSub = AppState.addEventListener('change', st => {
      if (st !== 'active') return;
      ensureSocketAlive();
      if (sock && !sock.connected) apply('reconnecting');
    });

    return () => {
      mounted = false;
      if (sock) {
        sock.off('connect', onConnect);
        sock.off('disconnect', onDisconnect);
        sock.io?.off('reconnect_attempt', onAttempt);
        sock.io?.off('error', onAttempt);
      }
      appSub.remove();
    };
  }, []);

  // Show/hide + auto-dismiss the "online" flash
  useEffect(() => {
    clearTimeout(hideTimer.current);
    if (state === null) {
      Animated.timing(opacity, { toValue: 0, duration: 200, useNativeDriver: true }).start();
      return;
    }
    Animated.timing(opacity, { toValue: 1, duration: 200, useNativeDriver: true }).start();
    if (state === 'online') {
      hideTimer.current = setTimeout(() => setState(null), 1500);
    }
  }, [state]);

  if (state === null) return null;
  const online = state === 'online';
  const label = online ? 'Back online' : state === 'offline' ? 'No internet connection' : 'Reconnecting…';

  return (
    // Full-width bar pinned above every screen (including the chat header) so
    // it reads as an app-level status, never overlapping a chat's title.
    <Animated.View pointerEvents="none" style={[s.bar, online ? s.barOnline : s.barDown, { opacity }]}>
      <View style={[s.dot, { backgroundColor: online ? '#86efac' : '#fbbf24' }]} />
      <Text style={[s.text, { color: online ? '#86efac' : '#fbbf24' }]}>{label}</Text>
    </Animated.View>
  );
}

const s = StyleSheet.create({
  bar: {
    position: 'absolute', top: 0, left: 0, right: 0, zIndex: 1000,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7,
    paddingVertical: 5,
    elevation: 8, shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 6, shadowOffset: { width: 0, height: 2 },
  },
  barDown: { backgroundColor: '#7c3a00' },
  barOnline: { backgroundColor: '#14532d' },
  dot: { width: 8, height: 8, borderRadius: 4 },
  text: { fontSize: 12.5, fontWeight: '700' },
});
