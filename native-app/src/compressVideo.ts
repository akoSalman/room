// Native video work: trimming and re-encoding. The decisions (target size,
// estimates) live in videoQuality.ts and are tested there; this is the thin
// layer that talks to the native modules.
//
// Both modules are NATIVE, so nothing here works in Expo Go — the app has to
// be built. Every entry point degrades to "send the original" rather than
// throwing, so a device where a module is missing still sends video.
import { NativeEventEmitter, NativeModules } from 'react-native';
import { Video as VideoCompressor } from 'react-native-compressor';
import { showEditor } from 'react-native-video-trim';
import { VideoQuality, presetFor, videoTarget, shouldTranscode } from './videoQuality';

export type TrimRange = { startSec: number; endSec: number } | null;

/**
 * Open the native trimmer and resolve with the trimmed file.
 *
 * Resolves with null when the user cancels, or if anything fails — the caller
 * then sends the untrimmed clip rather than nothing.
 */
export function trimVideo(uri: string): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: string | null) => {
      if (settled) return;
      settled = true;
      try { sub.remove(); } catch {}
      resolve(v);
    };

    let sub: { remove: () => void };
    try {
      const emitter = new NativeEventEmitter(NativeModules.VideoTrim);
      sub = emitter.addListener('VideoTrim', (e: any) => {
        switch (e?.name) {
          case 'onFinishTrimming': return done(e.outputPath || null);
          // The editor closing without a result is a cancel, however it was
          // dismissed — back button included, which fires only onHide.
          case 'onCancelTrimming':
          case 'onCancel':
          case 'onHide':
          case 'onError':
            return done(null);
        }
      });
    } catch {
      resolve(null);
      return;
    }

    try {
      showEditor(uri, { saveToPhoto: false, enableCancelDialog: false, enableSaveDialog: false });
    } catch {
      done(null);
    }
  });
}

/**
 * Re-encode to the chosen quality. Returns the original uri when the video is
 * already small enough, when 'original' is chosen, or on any failure.
 *
 * `onProgress` receives 0..1 — transcoding a long clip is slow enough that the
 * user needs to see it happening.
 */
export async function compressVideo(
  uri: string,
  quality: VideoQuality,
  size: { width: number; height: number } | null,
  onProgress?: (p: number) => void,
  originalBytes = 0,
  seconds = 0,
): Promise<string> {
  if (quality === 'original') return uri;
  const preset = presetFor(quality);

  // Skip work that would not pay for itself. Transcoding takes tens of seconds
  // on a phone, and for a clip that is already small it produces a file no
  // smaller — slower to send AND worse quality. Sending the original then wins
  // on both counts.
  if (!shouldTranscode(quality, originalBytes, seconds, size)) return uri;

  try {
    const out = await VideoCompressor.compress(
      uri,
      {
        compressionMethod: 'manual',
        maxSize: preset.maxEdge,
        bitrate: preset.bitrate,
        minimumFileSizeForCompress: 0,
      },
      (p) => onProgress?.(typeof p === 'number' ? p : 0),
    );
    return out || uri;
  } catch {
    return uri;
  }
}
