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
  // Bumped by Retry to force a fresh request for the same url.
  const [attempt, setAttempt] = useState(0);
  const opacity = useRef(new Animated.Value(0)).current;

  // A new url (recycled row) starts over.
  useEffect(() => {
    setLoaded(false);
    setFailed(false);
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
          setLoaded(true);
          Animated.timing(opacity, { toValue: 1, duration: 200, useNativeDriver: true }).start();
        }}
        onError={() => setFailed(true)}
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
