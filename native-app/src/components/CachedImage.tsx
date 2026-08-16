// An <Image> that keeps what it downloads.
//
// A drop-in for `<Image source={{ uri }}>`. The first time a picture is seen
// it is fetched from the server and written to the media cache; every time
// after that it is read off the phone, with no network involved — which is
// what makes reopening a chat full of photos instant instead of a reload.
//
// The remote URL is used for THIS render even when the file is being cached,
// so nothing waits on the cache being populated.
import React, { useEffect, useState } from 'react';
import { Image, ImageProps } from 'react-native';
import * as mediaCache from '../mediaCache';

type Props = Omit<ImageProps, 'source'> & {
  uri: string;
  /**
   * False for content the viewer is not allowed to keep — a disappearing
   * message, or someone else's photo in a private room. Such an image is
   * shown from the network and never written to disk.
   */
  cache?: boolean;
};

export default function CachedImage({ uri, cache = true, ...rest }: Props) {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setSrc(null);
    if (!cache) { setSrc(uri); return; }
    (async () => {
      const local = await mediaCache.peek(uri);
      if (!alive) return;
      setSrc(local || uri);
      // Not awaited: the picture is already on its way from the network, and
      // this only decides whether the NEXT time costs anything.
      if (!local) mediaCache.fetchAndKeep(uri).catch(() => {});
    })();
    return () => { alive = false; };
  }, [uri, cache]);

  // A single frame with nothing in it, while the disk is checked. Rendering
  // the remote URL first and swapping to the local file would load the same
  // image twice and flicker.
  if (!src) return null;
  return <Image {...rest} source={{ uri: src }} />;
}
