// ── A photo in a chat, covered until it is asked for ───────────────────────
//
// Asked for: a picture arrives blurred; one tap clears it, a second opens it;
// once cleared that exact picture never asks again; and a button blurs it back
// whenever the person wants.
//
// The decisions are in src/imageBlur.ts and the memory is in src/blurStore.ts.
// This is the part that draws it.
//
// The blur is the Image's own `blurRadius`, not a view laid over the top. An
// overlay is a thing that can fail to cover: it draws a frame late, it misses
// the corners of a rounded bubble, and a screenshot taken at the wrong moment
// has the picture in it. Blurring the image itself means there is never a
// moment when the sharp picture is on screen.
import React, { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import ImageWithSpinner from './ImageWithSpinner';
import CachedImage from './CachedImage';
import * as blurStore from '../blurStore';
import { photoKey } from '../viewerList';
import {
  BLUR_RADIUS, BLUR_BUTTON, tapAction, startsBlurred, buttonCorner, showsButton,
} from '../imageBlur';

export default function BlurredImage({
  uri, mine, uploading, hiddenOneTime, cache, style, onLoaded, onOpen, onLongPress,
}: {
  uri: string;
  mine: boolean;
  uploading: boolean;
  hiddenOneTime: boolean;
  cache?: boolean;
  style: any;
  onLoaded?: () => void;
  onOpen: () => void;
  onLongPress: () => void;
}) {
  const key = photoKey(uri);
  const [, force] = useState(0);
  useEffect(() => {
    blurStore.load().catch(() => {});
    return blurStore.subscribe(() => force(n => n + 1));
  }, []);

  const blurred = startsBlurred({
    hiddenOneTime,
    revealed: blurStore.isRevealed(key),
    hidden: blurStore.isHidden(key),
  });

  return (
    <View>
      <TouchableOpacity
        onPress={() => {
          // Blurred: the tap clears it and NOTHING else. Opening in the same
          // motion would put the picture full screen before anybody could
          // decide they did not want it there.
          if (tapAction({ blurred }) === 'reveal') { blurStore.reveal(key); return; }
          onOpen();
        }}
        onLongPress={onLongPress}
        delayLongPress={350}
        disabled={uploading}>
        {uploading
          // Covered while it is still going up, too. On these connections an
          // upload takes a while, and a photo sitting in the open for the
          // length of it is exactly the exposure this exists to prevent —
          // and it would also mean the picture changing appearance the
          // moment the upload finished.
          ? (
            <CachedImage
              uri={uri} cache={false} style={style} resizeMode="cover" fadeDuration={0}
              blurRadius={blurred ? BLUR_RADIUS : 0}
            />
          )
          : (
            <ImageWithSpinner
              uri={uri}
              cache={cache}
              style={style}
              resizeMode="cover"
              onLoaded={onLoaded}
              blurRadius={blurred ? BLUR_RADIUS : 0}
            />
          )}
      </TouchableOpacity>

      {/* Inside the picture, in the bottom corner on the bubble's outer edge:
          left for your own, right for theirs. Outside the tap target above,
          so blurring never also opens or clears. */}
      {showsButton({ uploading, hiddenOneTime }) && (
        <TouchableOpacity
          style={[s.btn, buttonCorner(mine) === 'left' ? s.left : s.right]}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          accessibilityRole="button"
          accessibilityLabel={blurred ? 'Show this photo' : 'Blur this photo'}
          onPress={() => {
            if (blurred) blurStore.reveal(key);
            else blurStore.hide(key);
          }}>
          <Text style={s.btnText}>{BLUR_BUTTON}</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  // A disc dark enough for the emoji to read over any picture.
  btn: {
    position: 'absolute', bottom: 8,
    width: 32, height: 32, borderRadius: 16,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  left: { left: 8 },
  right: { right: 8 },
  btnText: { fontSize: 16, lineHeight: 20 },
});
