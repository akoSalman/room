// The one place the app tells you about its connection.
//
// There used to be two of these: this floating pill, driven by socket events,
// and a full-width bar driven by `connection`. Both were mounted at once, so
// an offline phone showed "No internet connection" twice, once above the
// other. The pill is the one that survives — it is smaller and it sits above
// the screen rather than pushing it down.
//
// It reads `connection` now rather than the socket directly. That module is
// fed by BOTH the socket and the result of every request, so it notices the
// case where the socket believes it is fine but nothing actually gets
// through — which for these users, on networks that block rather than drop,
// is the normal failure. Reading the socket alone missed it.
//
// Two jobs, which is why the state is not just a boolean:
//
//  • While there is no connection, say so and keep saying it. Saved chats look
//    exactly like live ones, and someone reading old messages with no warning
//    will assume they are current.
//  • When the connection comes back, say THAT too, and then get out of the
//    way. Without it the warning vanishes at some unnoticed moment and the
//    user is left unsure whether it is safe to send.
import React, { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, Animated, AppState } from 'react-native';
import { ensureSocketAlive } from '../api';
import * as connection from '../connection';
import { bannerFor, BannerState, RESTORED_MS } from '../connectionBanner';

export default function ConnectionStatus() {
  const [state, setState] = useState<BannerState>(
    connection.isOnline() ? 'hidden' : 'offline',
  );
  // "Back online" is only news if we were actually offline. Without this the
  // app congratulates the user on having a connection every time it starts.
  const wasOffline = useRef(!connection.isOnline());
  const opacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    let timer: any;
    const apply = () =>
      setState(bannerFor(connection.current(), Date.now() - connection.since(), wasOffline.current));

    const off = connection.subscribe(s => {
      if (s === 'offline') wasOffline.current = true;
      apply();
      clearTimeout(timer);
      // Take the "back online" note down again once it has been read.
      if (s === 'online') timer = setTimeout(apply, RESTORED_MS + 50);
    });
    apply();

    // Coming back to the app is the moment a stale socket is most likely, and
    // the user is looking right at the screen.
    const appSub = AppState.addEventListener('change', st => {
      if (st === 'active') ensureSocketAlive();
    });

    return () => { off(); clearTimeout(timer); appSub.remove(); };
  }, []);

  useEffect(() => {
    Animated.timing(opacity, {
      toValue: state === 'hidden' ? 0 : 1,
      duration: 200,
      useNativeDriver: true,
    }).start();
  }, [state]);

  if (state === 'hidden') return null;
  const restored = state === 'restored';
  const color = restored ? '#4ade80' : '#fbbf24';

  return (
    // A compact pill centered at the very top — just enough box to hold the
    // text, no full-width background bar.
    <View pointerEvents="none" style={s.wrap}>
      <Animated.View style={[s.pill, { opacity }]}>
        <View style={[s.dot, { backgroundColor: color }]} />
        <Text style={[s.text, { color }]}>
          {restored ? 'Back online' : 'No internet connection'}
        </Text>
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
