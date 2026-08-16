import React, { useState } from 'react';
import { View, ActivityIndicator } from 'react-native';
import CachedImage from './CachedImage';

// An image that shows a spinner overlay until it finishes loading. Backed by
// CachedImage, so a thumbnail is fetched once and read off disk afterwards.
export default function ImageWithSpinner({ uri, style, resizeMode, onLoaded, cache }: {
  uri: string; style: any; resizeMode: 'cover' | 'contain'; onLoaded?: () => void;
  /** False for content that must not be kept on the device. */
  cache?: boolean;
}) {
  const [loaded, setLoaded] = useState(false);
  return (
    <View>
      <CachedImage
        uri={uri} cache={cache} style={style} resizeMode={resizeMode} fadeDuration={0}
        onLoad={() => { setLoaded(true); onLoaded?.(); }}
        onError={() => setLoaded(true)}
      />
      {!loaded && (
        <View style={[style, { position: 'absolute', top: 0, left: 0, alignItems: 'center', justifyContent: 'center' }]}>
          <ActivityIndicator size="small" color="#fff" />
        </View>
      )}
    </View>
  );
}
