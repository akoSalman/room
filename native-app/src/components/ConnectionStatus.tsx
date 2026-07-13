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

  const color = online ? '#4ade80' : '#fbbf24';
  return (
    // A compact pill centered at the very top — just enough box to hold the
    // text, no full-width background bar.
    <View pointerEvents="none" style={s.wrap}>
      <Animated.View style={[s.pill, { opacity }]}>
        <View style={[s.dot, { backgroundColor: color }]} />
        <Text style={[s.text, { color }]}>{label}</Text>
      </Animated.View>
    </View>
  );
}

const s = StyleSheet.create({
  wrap: {
    position: 'absolute', top: 4, left: 0, right: 0, zIndex: 1000, alignItems: 'center',
  },
  pill: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 11, paddingVertical: 4, borderRadius: 20,
    backgroundColor: 'rgba(20,24,33,0.9)',
    borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.12)',
  },
  dot: { width: 7, height: 7, borderRadius: 4 },
  text: { fontSize: 12, fontWeight: '700' },
});
