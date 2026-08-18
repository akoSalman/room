import React, { useRef } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';
import { PanGestureHandler, State } from 'react-native-gesture-handler';
import { C } from '../theme';

const SWIPE_THRESHOLD = 64;
const MAX_SWIPE = 90;

export default function SwipeableMessage({
  children, onSwipeRight, onSwipeLeft, onSwipeStart, enabled = true,
}: {
  children: React.ReactNode;
  onSwipeRight?: () => void;
  onSwipeLeft?: () => void;
  /**
   * The swipe has taken the gesture over.
   *
   * Fired as it ACTIVATES, not when it finishes, because the thing that has to
   * be undone by then has already happened: the finger started on the text, the
   * OS ran its long-press timer, and a word is selected behind the swipe.
   */
  onSwipeStart?: () => void;
  /** Suspended in multi-select, where a sideways drag means something else. */
  enabled?: boolean;
}) {
  const translateX = useRef(new Animated.Value(0)).current;
  const replyOpacity = translateX.interpolate({
    inputRange: [0, SWIPE_THRESHOLD],
    outputRange: [0, 1],
    extrapolate: 'clamp',
  });
  const deleteOpacity = translateX.interpolate({
    inputRange: [-SWIPE_THRESHOLD, 0],
    outputRange: [1, 0],
    extrapolate: 'clamp',
  });

  const onGestureEvent = Animated.event(
    [{ nativeEvent: { translationX: translateX } }],
    { useNativeDriver: true }
  );

  function onHandlerStateChange(e: any) {
    if (e.nativeEvent.state === State.ACTIVE && e.nativeEvent.oldState !== State.ACTIVE) {
      onSwipeStart?.();
    }
    if (e.nativeEvent.oldState === State.ACTIVE) {
      const dx = e.nativeEvent.translationX;
      if (dx > SWIPE_THRESHOLD && onSwipeRight) onSwipeRight();
      else if (dx < -SWIPE_THRESHOLD && onSwipeLeft) onSwipeLeft();
      Animated.spring(translateX, { toValue: 0, useNativeDriver: true }).start();
    }
  }

  const clampedTranslate = translateX.interpolate({
    inputRange: [-MAX_SWIPE, 0, MAX_SWIPE],
    outputRange: [-MAX_SWIPE, 0, MAX_SWIPE],
    extrapolate: 'clamp',
  });

  return (
    <View>
      <View style={[s.iconLayer, { justifyContent: 'flex-start' }]}>
        <Animated.View style={[s.replyIcon, { opacity: replyOpacity }]}>
          <Text style={s.iconText}>↩</Text>
        </Animated.View>
      </View>
      {onSwipeLeft && (
        <View style={[s.iconLayer, { justifyContent: 'flex-end' }]}>
          <Animated.View style={[s.deleteIcon, { opacity: deleteOpacity }]}>
            <Text style={s.iconText}>🗑</Text>
          </Animated.View>
        </View>
      )}
      <PanGestureHandler
        enabled={enabled}
        onGestureEvent={onGestureEvent}
        onHandlerStateChange={onHandlerStateChange}
        // Eight rather than ten: every pixel of travel before the swipe claims
        // the gesture is time in which the OS's long-press timer can fire and
        // start selecting the text under the finger. It cannot go much lower
        // without a vertical scroll occasionally reading as a swipe.
        activeOffsetX={[-8, 8]}
        failOffsetY={[-8, 8]}
        hitSlop={{ left: 80, right: 80, top: 6, bottom: 6 }}
      >
        <Animated.View style={{ transform: [{ translateX: clampedTranslate }] }}>
          {children}
        </Animated.View>
      </PanGestureHandler>
    </View>
  );
}

const s = StyleSheet.create({
  iconLayer: { position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16 },
  replyIcon: { width: 32, height: 32, borderRadius: 16, backgroundColor: C.accent, alignItems: 'center', justifyContent: 'center' },
  deleteIcon: { width: 32, height: 32, borderRadius: 16, backgroundColor: C.danger, alignItems: 'center', justifyContent: 'center' },
  iconText: { color: '#fff', fontSize: 16 },
});
