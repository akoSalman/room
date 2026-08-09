import React, { useEffect, useRef, useState } from 'react';
import { Animated, StyleSheet, Text, Easing } from 'react-native';
import { C } from '../theme';

// A tiny non-blocking confirmation ("Copied"), shown instead of an Alert —
// copying is a trivial action and shouldn't need dismissing.
let show: ((msg: string) => void) | null = null;
export function toast(message: string) { show?.(message); }

export default function Toast() {
  const [msg, setMsg] = useState<string | null>(null);
  const anim = useRef(new Animated.Value(0)).current;
  const hideTimer = useRef<any>(null);

  useEffect(() => {
    show = (m: string) => {
      clearTimeout(hideTimer.current);
      setMsg(m);
      Animated.timing(anim, { toValue: 1, duration: 160, easing: Easing.out(Easing.quad), useNativeDriver: true }).start();
      hideTimer.current = setTimeout(() => {
        Animated.timing(anim, { toValue: 0, duration: 220, easing: Easing.in(Easing.quad), useNativeDriver: true })
          .start(() => setMsg(null));
      }, 1500);
    };
    return () => { show = null; clearTimeout(hideTimer.current); };
  }, []);

  if (!msg) return null;
  return (
    <Animated.View
      pointerEvents="none"
      style={[s.wrap, {
        opacity: anim,
        transform: [{ translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [16, 0] }) }],
      }]}
    >
      <Text style={s.text} numberOfLines={2}>{msg}</Text>
    </Animated.View>
  );
}

const s = StyleSheet.create({
  wrap: {
    position: 'absolute', bottom: 96, alignSelf: 'center', zIndex: 200,
    maxWidth: '86%', backgroundColor: 'rgba(17,24,39,0.94)',
    borderRadius: 22, paddingHorizontal: 18, paddingVertical: 11,
    borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.15)',
  },
  text: { color: '#fff', fontSize: 14, fontWeight: '600', textAlign: 'center' },
});
