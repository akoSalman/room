// ── The preview under a message that contains a link ─────────────────────────
//
// Asked for as: a cover and a title for links sent in chats and rooms.
//
// What it draws is decided in src/linkPreview.ts; what it fetches is fetched by
// the server (/link-preview), because most of these hosts are unreachable from
// the devices this runs on.
//
// The two things this file is actually responsible for:
//
//   • asking ONCE. A chat is a list that re-renders constantly and recycles
//     rows as it scrolls; a preview fetched per render would be a request
//     every time a message came back on screen. The answers are kept in a
//     module-level map, so a row that scrolls away and back is free.
//   • never making the bubble jump. The card is only added once there is
//     something to draw — no skeleton, no placeholder box. A card that appears
//     under a message a second after you started reading it is fine; one that
//     appears and then resizes twice is what makes a list unreadable.
import React, { useEffect, useState } from 'react';
import { View, Text, Image, Pressable, StyleSheet, Linking } from 'react-native';
import { apiFetch, BASE_URL } from '../api';
import { tokenize } from '../textTokens';
import {
  pickUrl, worthShowing, trimTitle, trimDescription, displayHost, LinkMeta,
} from '../linkPreview';
import { C } from '../theme';

// url → what came back, or null for "asked, nothing to show".
const cache = new Map<string, LinkMeta | null>();
const failedAt = new Map<string, number>();
const inFlight = new Map<string, Promise<LinkMeta | null>>();

async function load(url: string): Promise<LinkMeta | null> {
  if (cache.has(url)) return cache.get(url) ?? null;
  let job = inFlight.get(url);
  if (!job) {
    job = (async () => {
      const res: any = await apiFetch(`/link-preview?url=${encodeURIComponent(url)}`);
      // A 204 (nothing worth showing) and a failed request both arrive here as
      // an object with an `error`; only a real answer is cached, so a link
      // that failed because the phone was offline is asked about again later.
      const meta: LinkMeta | null = res && !res.error && worthShowing(res) ? res : null;
      if (meta || (res && !res.offline)) cache.set(url, meta);
      if (!meta) failedAt.set(url, Date.now());
      return meta;
    })().finally(() => inFlight.delete(url));
    inFlight.set(url, job);
  }
  return job;
}

export default function LinkCard({ content, onPress }: {
  content: string;
  /** Wraps the tap, so it does not also open the message menu. */
  onPress?: (run: () => void) => void;
}) {
  const url = React.useMemo(() => pickUrl(tokenize(String(content || ''))), [content]);
  const [meta, setMeta] = useState<LinkMeta | null>(() => (url ? cache.get(url) ?? null : null));

  useEffect(() => {
    let alive = true;
    if (!url) { setMeta(null); return; }
    if (cache.has(url)) { setMeta(cache.get(url) ?? null); return; }
    load(url).then(m => { if (alive) setMeta(m); }).catch(() => {});
    return () => { alive = false; };
  }, [url]);

  if (!url || !worthShowing(meta)) return null;
  const title = trimTitle(meta!.title);
  const desc = trimDescription(meta!.description);
  const host = displayHost({ ...meta, url });
  const open = () => { Linking.openURL(url).catch(() => {}); };

  return (
    <Pressable
      style={s.card}
      onPress={() => (onPress ? onPress(open) : open())}
      // The bubble's own long-press must still reach the message menu: a
      // preview you cannot reply to or delete is a trap.
      android_ripple={{ color: 'rgba(255,255,255,0.06)' }}
    >
      {!!meta!.image && (
        <Image
          source={{ uri: `${BASE_URL}${meta!.image}` }}
          style={s.cover}
          resizeMode="cover"
        />
      )}
      <View style={s.body}>
        {!!host && <Text style={s.host} numberOfLines={1}>{host}</Text>}
        {!!title && <Text style={s.title} numberOfLines={2}>{title}</Text>}
        {!!desc && <Text style={s.desc} numberOfLines={2}>{desc}</Text>}
      </View>
    </Pressable>
  );
}

const s = StyleSheet.create({
  card: {
    marginTop: 6,
    borderRadius: 10,
    overflow: 'hidden',
    backgroundColor: 'rgba(0,0,0,0.18)',
    // The stripe down the leading edge is what says "this belongs to the
    // message above" rather than being a second message.
    borderLeftWidth: 3,
    borderLeftColor: C.accent,
    maxWidth: 280,
  },
  cover: { width: '100%', height: 140, backgroundColor: 'rgba(0,0,0,0.25)' },
  body: { paddingHorizontal: 8, paddingVertical: 6 },
  host: { color: C.accent, fontSize: 11, marginBottom: 2 },
  title: { color: '#fff', fontSize: 13, fontWeight: '600' },
  desc: { color: 'rgba(255,255,255,0.7)', fontSize: 12, marginTop: 2 },
});
