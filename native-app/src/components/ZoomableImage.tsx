import React, { useRef } from 'react';
import { Animated, StyleSheet } from 'react-native';
import { PinchGestureHandler, PanGestureHandler, State } from 'react-native-gesture-handler';

export default function ZoomableImage({ uri }: { uri: string }) {
  const scale = useRef(new Animated.Value(1)).current;
  const lastScale = useRef(1);
  const translateX = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(0)).current;
  const lastTranslate = useRef({ x: 0, y: 0 });

  const onPinchEvent = Animated.event(
    [{ nativeEvent: { scale: scale } }],
    { useNativeDriver: true }
  );

  function onPinchStateChange(e: any) {
    if (e.nativeEvent.oldState === State.ACTIVE) {
      lastScale.current *= e.nativeEvent.scale;
      lastScale.current = Math.max(1, Math.min(lastScale.current, 5));
      scale.setOffset(0);
      scale.setValue(lastScale.current);
      if (lastScale.current === 1) {
        lastTranslate.current = { x: 0, y: 0 };
        translateX.setValue(0);
        translateY.setValue(0);
      }
    }
  }

  const onPanEvent = Animated.event(
    [{ nativeEvent: { translationX: translateX, translationY: translateY } }],
    { useNativeDriver: true }
  );

  function onPanStateChange(e: any) {
    if (e.nativeEvent.oldState === State.ACTIVE) {
      lastTranslate.current.x += e.nativeEvent.translationX;
      lastTranslate.current.y += e.nativeEvent.translationY;
      translateX.setOffset(lastTranslate.current.x);
      translateY.setOffset(lastTranslate.current.y);
      translateX.setValue(0);
      translateY.setValue(0);
    }
  }

  return (
    <PanGestureHandler onGestureEvent={onPanEvent} onHandlerStateChange={onPanStateChange} minPointers={1} maxPointers={2}>
      <Animated.View style={s.container}>
        <PinchGestureHandler onGestureEvent={onPinchEvent} onHandlerStateChange={onPinchStateChange}>
          <Animated.Image
            source={{ uri }}
            style={[s.image, {
              transform: [{ translateX }, { translateY }, { scale }],
            }]}
            resizeMode="contain"
          />
        </PinchGestureHandler>
      </Animated.View>
    </PanGestureHandler>
  );
}

const s = StyleSheet.create({
  container: { width: '100%', height: '85%', alignItems: 'center', justifyContent: 'center' },
  image: { width: '100%', height: '100%' },
});
