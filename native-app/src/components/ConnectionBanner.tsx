// The one place the app tells you about its connection.
//
// Two different jobs, which is why it is not just a boolean:
//
//  • While there is no connection, say so and keep saying it. Saved chats look
//    exactly like live ones, and someone reading old messages with no warning
//    will assume they are current.
//  • When the connection comes back, say THAT too, and then get out of the
//    way. Without it the warning simply vanishes at some unnoticed moment and
//    the user is left unsure whether it is safe to send.
import React, { useEffect, useState } from 'react';
import { Text, StyleSheet, Animated } from 'react-native';
import * as connection from '../connection';
import { bannerFor, BannerState, RESTORED_MS } from '../connectionBanner';

export default function ConnectionBanner() {
  const [state, setState] = useState<BannerState>(
    connection.isOnline() ? 'hidden' : 'offline',
  );
  // "Back online" is only news if we were actually offline. Without this the
  // app would congratulate the user on having a connection every time it
  // starts.
  const [wasOffline, setWasOffline] = useState(!connection.isOnline());

  useEffect(() => {
    let timer: any;
    const apply = () => {
      const held = Date.now() - connection.since();
      setState(bannerFor(connection.current(), held, wasOffline || !connection.isOnline()));
    };
    const off = connection.subscribe(s => {
      if (s === 'offline') setWasOffline(true);
      apply();
      clearTimeout(timer);
      // Take the "back online" note down again once it has been read.
      if (s === 'online') timer = setTimeout(apply, RESTORED_MS + 50);
    });
    apply();
    return () => { off(); clearTimeout(timer); };
  }, [wasOffline]);

  const fade = React.useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(fade, {
      toValue: state === 'hidden' ? 0 : 1,
      duration: 180,
      useNativeDriver: true,
    }).start();
  }, [state]);

  if (state === 'hidden') return null;
  const restored = state === 'restored';
  return (
    <Animated.View style={[s.bar, restored ? s.barOnline : s.barOffline, { opacity: fade }]}>
      <Text style={[s.text, restored ? s.textOnline : s.textOffline]}>
        {restored ? '✓  Back online' : '⚠  No internet connection'}
      </Text>
    </Animated.View>
  );
}

const s = StyleSheet.create({
  bar: { paddingVertical: 6, paddingHorizontal: 14, borderBottomWidth: 1 },
  barOffline: { backgroundColor: 'rgba(217,119,6,0.16)', borderBottomColor: 'rgba(217,119,6,0.45)' },
  barOnline: { backgroundColor: 'rgba(34,197,94,0.16)', borderBottomColor: 'rgba(34,197,94,0.45)' },
  text: { fontSize: 12.5, fontWeight: '700', textAlign: 'center' },
  textOffline: { color: '#d97706' },
  textOnline: { color: '#16a34a' },
});
