// ── The emoji that flies up when somebody reacts ───────────────────────────
//
// Asked for: on a reaction, show that emoji animated on the message for three
// seconds. The decision of WHETHER to show one is in src/reactionBurst.ts;
// this is only the motion.
//
// Two things it must not do, both of which would be worse than no animation:
//
//   * catch a touch. It sits over the message, so without pointerEvents="none"
//     it would swallow taps on the bubble underneath for three seconds — long
//     enough to feel like the app had frozen.
//
//   * keep running once it is gone. Every timer and every animation is stopped
//     on unmount, because a chat scrolls and these are mounted and thrown away
//     constantly.
//
// The motion itself is deliberately gentle: a spring up to full size, a slow
// drift upward, and a fade over the last second. Something that jumps and
// spins is fun once and tiresome by the fourth message.
import React, { useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet, Text } from 'react-native';
import { BURST_MS } from '../reactionBurst';

export default function ReactionBurst({ emoji, onDone }: {
  emoji: string;
  /** Called when the three seconds are up, so the caller can drop it. */
  onDone: () => void;
}) {
  const scale = useRef(new Animated.Value(0)).current;
  const lift = useRef(new Animated.Value(0)).current;
  const fade = useRef(new Animated.Value(0)).current;
  const doneRef = useRef(onDone);
  doneRef.current = onDone;

  useEffect(() => {
    const anim = Animated.parallel([
      // In quickly, with a little overshoot: the arrival is the part that
      // should be noticed.
      Animated.spring(scale, {
        toValue: 1, friction: 5, tension: 120, useNativeDriver: true,
      }),
      Animated.timing(fade, {
        toValue: 1, duration: 160, useNativeDriver: true,
      }),
      // Then a slow drift for the rest of the three seconds.
      Animated.timing(lift, {
        toValue: 1, duration: BURST_MS, easing: Easing.out(Easing.quad), useNativeDriver: true,
      }),
      // Fading only over the last second, so it is legible for most of its life.
      Animated.sequence([
        Animated.delay(BURST_MS - 900),
        Animated.timing(fade, { toValue: 0, duration: 900, useNativeDriver: true }),
      ]),
    ]);
    anim.start();
    const t = setTimeout(() => doneRef.current(), BURST_MS);
    return () => {
      clearTimeout(t);
      // Stopped rather than left to finish: this component is unmounted every
      // time the message scrolls out of the window, and an animation running
      // against a dead view is wasted work on a phone that has little to spare.
      anim.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [emoji]);

  return (
    <Animated.View
      // NEVER takes a touch. It covers the bubble, and swallowing taps for
      // three seconds would read as the app having hung.
      pointerEvents="none"
      style={[
        s.wrap,
        {
          opacity: fade,
          transform: [
            { scale },
            { translateY: lift.interpolate({ inputRange: [0, 1], outputRange: [0, -46] }) },
          ],
        },
      ]}
    >
      <Text style={s.emoji}>{emoji}</Text>
    </Animated.View>
  );
}

const s = StyleSheet.create({
  wrap: {
    position: 'absolute',
    right: 8,
    // Just above the bubble's own reaction chips, so the one flying up and
    // the one that settles are read as the same thing.
    bottom: 6,
    zIndex: 20,
  },
  emoji: {
    fontSize: 30,
    // A shadow so it stays visible over a photo as well as over a bubble.
    textShadowColor: 'rgba(0,0,0,0.35)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },
});
