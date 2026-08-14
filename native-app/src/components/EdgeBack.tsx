// Wraps a screen so a swipe near either side edge goes back, the way the
// device's own back button does. The thresholds live in src/edgeBack.ts and
// are unit tested — see the comments there for why it is edge-only.
import React, { useRef, useState } from 'react';
import {
  View, Animated, PanResponder, StyleSheet, Dimensions,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { C } from '../theme';
import {
  EdgeSide, edgeFor, shouldComplete, backProgress, COMPLETE_DISTANCE,
} from '../edgeBack';

export default function EdgeBack({ onBack, enabled = true, children }: {
  onBack: () => void;
  /** Suspended while something is on top (a fullscreen player, a map). */
  enabled?: boolean;
  children: React.ReactNode;
}) {
  const width = Dimensions.get('window').width;
  const drag = useRef(new Animated.Value(0)).current;
  const [side, setSide] = useState<EdgeSide>(null);
  // Read inside the responder callbacks, which are created once.
  const sideRef = useRef<EdgeSide>(null);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  const pan = useRef(
    PanResponder.create({
      // Never claim a plain tap — buttons and message taps must still work.
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponder: (_e, g) => {
        if (!enabledRef.current) return false;
        const s = edgeFor(g.x0, g.dx, g.dy, width);
        if (!s) return false;
        sideRef.current = s;
        return true;
      },
      onPanResponderGrant: () => setSide(sideRef.current),
      onPanResponderMove: (_e, g) => {
        // The screen follows the finger, damped, so the gesture feels attached
        // to something rather than being an invisible trigger.
        const travel = sideRef.current === 'left' ? g.dx : -g.dx;
        drag.setValue(Math.max(0, Math.min(travel, COMPLETE_DISTANCE * 1.6)) * 0.5);
      },
      onPanResponderRelease: (_e, g) => {
        const s = sideRef.current;
        const go = shouldComplete(s, g.dx, g.vx);
        sideRef.current = null;
        setSide(null);
        if (go) {
          drag.setValue(0);
          onBack();
          return;
        }
        Animated.spring(drag, { toValue: 0, useNativeDriver: true, bounciness: 4 }).start();
      },
      onPanResponderTerminate: () => {
        sideRef.current = null;
        setSide(null);
        Animated.spring(drag, { toValue: 0, useNativeDriver: true }).start();
      },
    }),
  ).current;

  // Left edge pushes the screen right; the right edge pushes it left.
  const shift = side === 'right' ? Animated.multiply(drag, -1) : drag;

  return (
    <View style={{ flex: 1 }} {...pan.panHandlers}>
      <Animated.View style={{ flex: 1, transform: [{ translateX: shift }] }}>
        {children}
      </Animated.View>

      {/* A chevron that fades in as the drag passes the point of no return, so
          it is clear what is about to happen and that letting go now cancels. */}
      {!!side && (
        <Animated.View
          pointerEvents="none"
          style={[
            s.hint,
            side === 'left' ? { left: 8 } : { right: 8 },
            {
              opacity: drag.interpolate({
                inputRange: [0, COMPLETE_DISTANCE * 0.5],
                outputRange: [0, 1],
                extrapolate: 'clamp',
              }),
            },
          ]}
        >
          <Ionicons
            name={side === 'left' ? 'chevron-back' : 'chevron-forward'}
            size={24}
            color="#fff"
          />
        </Animated.View>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  hint: {
    position: 'absolute', top: '46%',
    width: 42, height: 42, borderRadius: 21,
    backgroundColor: C.accent,
    alignItems: 'center', justifyContent: 'center',
  },
});
