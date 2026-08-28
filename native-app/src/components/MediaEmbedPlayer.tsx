// ── The platform's own player, opened inside the chat ────────────────────────
//
// Asked for as: music from SoundCloud and other platforms should be playable
// in the app if it is possible.
//
// This is the "possible" half — a web view holding the embedded player the
// platform publishes for exactly this purpose (see mediaEmbed.ts for what is
// deliberately not done, and why). The audio and video come from the platform,
// which is the only arrangement that is theirs to give.
//
// Two things it must do that a bare WebView does not:
//
//   • say what happened when nothing loads. A blank black rectangle after
//     tapping play is how somebody decides the app is broken; where these
//     users are, the reason is almost always that the platform cannot be
//     reached, and that has an answer — the browser, which may be going
//     through something the app is not.
//   • stay OUT of the way of the rest of the page. The web view is pointed at
//     one player URL and is not a browser: a tap that would navigate somewhere
//     else opens in the real browser instead, so nobody ends up signing in to
//     an account inside a chat app's window.
import React, { useState } from 'react';
import {
  Modal, View, Text, Pressable, StyleSheet, ActivityIndicator, Linking, useWindowDimensions,
} from 'react-native';
import { WebView } from 'react-native-webview';
import Ionicons from '@expo/vector-icons/Ionicons';
import { C } from '../theme';
import { Media, PLATFORM_NAMES, failureMessage, playerHeight } from '../mediaEmbed';

export default function MediaEmbedPlayer({ media, title, onClose }: {
  media: Media;
  title?: string | null;
  onClose: () => void;
}) {
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const { width } = useWindowDimensions();
  const playerW = Math.min(width, 720);
  const h = playerHeight(media.kind, playerW);

  const openOutside = () => { Linking.openURL(media.original).catch(() => {}); };

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={s.backdrop}>
        {/* Tapping the darkness closes it, the way every other overlay here does. */}
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
        <View style={[s.sheet, { width: playerW }]}>
          <View style={s.bar}>
            <Text style={s.title} numberOfLines={1}>
              {title || PLATFORM_NAMES[media.platform]}
            </Text>
            <Pressable onPress={openOutside} hitSlop={10} style={s.barBtn}>
              <Ionicons name="open-outline" size={20} color={C.muted} />
            </Pressable>
            <Pressable onPress={onClose} hitSlop={10} style={s.barBtn}>
              <Ionicons name="close" size={22} color={C.muted} />
            </Pressable>
          </View>

          {failed ? (
            <View style={[s.failed, { height: h }]}>
              <Text style={s.failedText}>{failureMessage(media)}</Text>
              <Pressable style={s.failedBtn} onPress={openOutside}>
                <Text style={s.failedBtnText}>Open in browser</Text>
              </Pressable>
            </View>
          ) : (
            <View style={{ width: playerW, height: h }}>
              <WebView
                source={{ uri: media.embed }}
                style={{ backgroundColor: '#000' }}
                javaScriptEnabled
                domStorageEnabled
                // Otherwise Android refuses to start the media without a tap
                // the user has already given, one screen further out.
                mediaPlaybackRequiresUserAction={false}
                allowsInlineMediaPlayback
                allowsFullscreenVideo
                onLoadEnd={() => setLoading(false)}
                onError={() => { setLoading(false); setFailed(true); }}
                onHttpError={() => { setLoading(false); setFailed(true); }}
                // Not a browser: only the player itself may load in here.
                onShouldStartLoadWithRequest={(req) => {
                  if (req.url === media.embed || req.navigationType !== 'click') return true;
                  Linking.openURL(req.url).catch(() => {});
                  return false;
                }}
              />
              {loading && (
                <View style={s.loading} pointerEvents="none">
                  <ActivityIndicator color={C.accent} />
                </View>
              )}
            </View>
          )}
        </View>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.85)', alignItems: 'center', justifyContent: 'center' },
  sheet: { borderRadius: 12, overflow: 'hidden', backgroundColor: '#101418' },
  bar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 10, gap: 12 },
  title: { flex: 1, color: '#fff', fontSize: 14, fontWeight: '600' },
  barBtn: { padding: 2 },
  loading: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  failed: { alignItems: 'center', justifyContent: 'center', padding: 24, gap: 14 },
  failedText: { color: 'rgba(255,255,255,0.8)', textAlign: 'center', fontSize: 13, lineHeight: 19 },
  failedBtn: { backgroundColor: C.accent, borderRadius: 8, paddingHorizontal: 16, paddingVertical: 9 },
  failedBtnText: { color: '#fff', fontWeight: '600' },
});
