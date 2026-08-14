// Re-encode a picture for sending. The sizing rules live in imageQuality.ts
// (and are tested there); this is the thin part that talks to the native
// image library.
import * as ImageManipulator from 'expo-image-manipulator';
import { Image } from 'react-native';
import {
  Quality, resizeTarget, shouldCompress, STANDARD_JPEG_QUALITY,
} from './imageQuality';

function measure(uri: string): Promise<{ width: number; height: number } | null> {
  return new Promise(resolve => {
    Image.getSize(uri, (width, height) => resolve({ width, height }), () => resolve(null));
  });
}

/**
 * Returns a URI to send. On HD, or anything not worth re-encoding, that is the
 * ORIGINAL uri — untouched, so nothing is lost.
 *
 * Never throws: if anything goes wrong the original is sent. A failed
 * compression must not become a failed send.
 */
export async function compressForSend(
  uri: string, name: string, mime: string, quality: Quality,
): Promise<{ uri: string; name: string; mime: string }> {
  const original = { uri, name, mime };
  if (!shouldCompress(mime, quality)) return original;
  try {
    const size = await measure(uri);
    if (!size) return original;
    const target = resizeTarget(size.width, size.height, quality);

    const actions = target
      ? [{ resize: { width: target.width, height: target.height } }]
      : [];

    const out = await ImageManipulator.manipulateAsync(uri, actions, {
      compress: STANDARD_JPEG_QUALITY,
      format: ImageManipulator.SaveFormat.JPEG,
    });
    if (!out.uri) return original;
    // The bytes are JPEG now, whatever they were before. The name has to say
    // so: the server and the app both decide how to treat a file from its
    // extension, so leaving a .png name on JPEG bytes mislabels it everywhere.
    return {
      uri: out.uri,
      name: name.replace(/\.[^.]+$/, '') + '.jpg',
      mime: 'image/jpeg',
    };
  } catch {
    return original;
  }
}
