// Applying the brightness to a photo.
//
// The numbers live in cameraTune.ts and are tested there; this is the part
// that touches Skia and the filesystem.
//
// Everything is wrapped and every failure returns the ORIGINAL file. A photo
// that comes back unretouched is a disappointment; a photo that comes back as
// `undefined` because a decoder failed is a lost moment, and the user has
// already put the phone down by the time anyone finds out.
import * as FileSystem from 'expo-file-system';
import { Skia, ImageFormat } from '@shopify/react-native-skia';
import { exposureMatrix, needsProcessing } from './cameraTune';

export type TuneOptions = { ev: number; quality?: number };

/**
 * Return a corrected copy of `uri`, or `uri` itself when there is nothing to do.
 *
 * The caller can treat the answer as "the file to send" without checking which
 * of the two it got.
 */
export async function tunePhoto(uri: string, o: TuneOptions): Promise<string> {
  if (!uri || !needsProcessing(o)) return uri;
  try {
    const data = await readSkiaData(uri);
    if (!data) return uri;
    const image = Skia.Image.MakeImageFromEncoded(data);
    if (!image) return uri;

    const w = image.width();
    const h = image.height();
    if (!(w > 0 && h > 0)) return uri;

    const surface = Skia.Surface.MakeOffscreen(w, h);
    if (!surface) return uri;
    const canvas = surface.getCanvas();
    const rect = Skia.XYWHRect(0, 0, w, h);

    // The picture, with the exposure correction the preview promised.
    const base = Skia.Paint();
    base.setColorFilter(Skia.ColorFilter.MakeMatrix(exposureMatrix(o.ev)));
    canvas.drawImageRect(image, rect, rect, base);

    const out = surface.makeImageSnapshot();
    const b64 = out.encodeToBase64(ImageFormat.JPEG, Math.round((o.quality ?? 0.9) * 100));
    if (!b64) return uri;

    const dest = `${FileSystem.cacheDirectory}tuned-${Date.now()}.jpg`;
    await FileSystem.writeAsStringAsync(dest, b64, { encoding: FileSystem.EncodingType.Base64 });
    return dest;
  } catch {
    return uri;
  }
}

/** Read a local file (or a remote one) into something Skia can decode. */
async function readSkiaData(uri: string) {
  try {
    if (/^https?:/.test(uri)) return await Skia.Data.fromURI(uri);
    const b64 = await FileSystem.readAsStringAsync(uri, {
      encoding: FileSystem.EncodingType.Base64,
    });
    return Skia.Data.fromBase64(b64);
  } catch {
    return null;
  }
}
