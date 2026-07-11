import React, { useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet, Dimensions } from 'react-native';

const HEARTS = ['💖', '❤️', '💗', '💘', '❤️', '💖', '💕', '❤️'];

// A one-shot, fully animated love splash: soft pink wash fades in/out while
// hearts float up with a gentle sway. Native-driver only, so it stays smooth
// even when the JS thread is busy.
export default function HeartBurst({ onDone }: { onDone: () => void }) {
  const bg = useRef(new Animated.Value(0)).current;
  const anims = useRef(HEARTS.map(() => new Animated.Value(0))).current;
  const done = useRef(onDone);
  done.current = onDone;

  useEffect(() => {
    const run = Animated.parallel([
      Animated.sequence([
        Animated.timing(bg, { toValue: 1, duration: 400, easing: Easing.out(Easing.quad), useNativeDriver: true }),
        Animated.delay(1300),
        Animated.timing(bg, { toValue: 0, duration: 700, easing: Easing.in(Easing.quad), useNativeDriver: true }),
      ]),
      ...anims.map((a, i) => Animated.sequence([
        Animated.delay(i * 130),
        Animated.timing(a, { toValue: 1, duration: 2100, easing: Easing.bezier(0.25, 0.1, 0.25, 1), useNativeDriver: true }),
      ])),
    ]);
    run.start(() => done.current());
    return () => run.stop();
  }, []);

  const H = Dimensions.get('window').height;
  return (
    <Animated.View pointerEvents="none" style={[s.overlay, { opacity: bg }]}>
      {HEARTS.map((h, i) => {
        const a = anims[i];
        const sway = (i % 2 ? 1 : -1) * (14 + (i % 3) * 6);
        return (
          <Animated.Text
            key={i}
            style={{
              position: 'absolute',
              left: `${6 + (i * 12) % 82}%`,
              bottom: -50,
              fontSize: 24 + (i % 4) * 11,
              opacity: a.interpolate({ inputRange: [0, 0.1, 0.7, 1], outputRange: [0, 0.9, 0.75, 0] }),
              transform: [
                { translateY: a.interpolate({ inputRange: [0, 1], outputRange: [0, -H * 0.85] }) },
                { translateX: a.interpolate({ inputRange: [0, 0.3, 0.6, 1], outputRange: [0, sway, -sway * 0.7, sway * 0.4] }) },
                { scale: a.interpolate({ inputRange: [0, 0.25, 1], outputRange: [0.4, 1, 1.15] }) },
                { rotate: a.interpolate({ inputRange: [0, 0.5, 1], outputRange: ['-8deg', '6deg', '-4deg'] }) },
              ],
            }}
          >{h}</Animated.Text>
        );
      })}
    </Animated.View>
  );
}

const s = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject, zIndex: 60,
    backgroundColor: 'rgba(244,114,182,0.10)',
  },
});
