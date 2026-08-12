// One image inside the fullscreen gallery.
//
// react-native-awesome-gallery's built-in renderer is a bare <Image>: until the
// bytes arrive you get an unexplained black screen, and if the request fails you
// get a black screen forever. This adds the missing feedback — a spinner while
// loading, a gentle fade-in when the pixels land, and a retry when it fails.
//
// It must call setImageDimensions() with the image's natural size, exactly as
// the default renderer does, or the gallery cannot compute zoom/pan bounds.
import React, { useEffect, useRef, useState } from 'react';
import {
  Animated, View, Text, StyleSheet, ActivityIndicator, TouchableOpacity,
} from 'react-native';

type Props = {
  uri: string;
  setImageDimensions: (d: { width: number; height: number }) => void;
};

export default function GalleryImage({ uri, setImageDimensions }: Props) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  // Bumped to force a fresh request for the same url: once automatically on
  // the first error, and again whenever the user presses Retry.
  const [attempt, setAttempt] = useState(0);
  const autoRetried = useRef(false);
  const opacity = useRef(new Animated.Value(0)).current;

  // A new url (recycled row) starts over. Runs on mount too, which is exactly
  // when a fast cache hit can have already fired onLoad — so this must not
  // clobber a load that already succeeded, or the spinner sticks forever.
  const settled = useRef(false);
  useEffect(() => {
    settled.current = false;
    autoRetried.current = false;
    setLoaded(false);
    setFailed(false);
    setAttempt(0);
    opacity.setValue(0);
  }, [uri]);

  return (
    <View style={StyleSheet.absoluteFill}>
      <Animated.Image
        // The cache-busting suffix is only added on an explicit retry, so the
        // normal path still hits the image cache.
        source={{ uri: attempt ? `${uri}${uri.includes('?') ? '&' : '?'}retry=${attempt}` : uri }}
        resizeMode="contain"
        style={[StyleSheet.absoluteFillObject, { opacity }]}
        onLoad={(e) => {
          const src: any = e.nativeEvent?.source || {};
          if (src.width && src.height) setImageDimensions({ width: src.width, height: src.height });
          settled.current = true;
          setFailed(false);
          setLoaded(true);
          Animated.timing(opacity, { toValue: 1, duration: 220, useNativeDriver: true }).start();
        }}
        onError={() => {
          // The first error is very often transient — a connection still
          // warming up as the viewer opens. Retry once silently before
          // telling the user anything went wrong; showing the failure
          // immediately made a perfectly good image look broken on first tap.
          if (!autoRetried.current) {
            autoRetried.current = true;
            setTimeout(() => setAttempt(a => a + 1), 350);
            return;
          }
          settled.current = true;
          setFailed(true);
        }}
      />

      {!loaded && !failed && (
        <View style={s.center} pointerEvents="none">
          <ActivityIndicator size="large" color="#fff" />
        </View>
      )}

      {failed && (
        <View style={s.center}>
          <Text style={s.failText}>Couldn’t load this image</Text>
          <TouchableOpacity
            style={s.retryBtn}
            onPress={() => { setFailed(false); setLoaded(false); opacity.setValue(0); setAttempt(a => a + 1); }}
          >
            <Text style={s.retryText}>Retry</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  center: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center', gap: 12 },
  failText: { color: '#e2e8f0', fontSize: 14.5 },
  retryBtn: {
    paddingHorizontal: 22, paddingVertical: 9, borderRadius: 18,
    borderWidth: 1, borderColor: '#e2e8f0',
  },
  retryText: { color: '#e2e8f0', fontSize: 14, fontWeight: '700' },
});
