// ── "updated 4 min ago", still saying so four minutes later ─────────────────
//
// Reported as: on a live location, the last-update status never changes.
//
// It never did. The text is `formatUpdated(p.updatedAt, Date.now())`, re-read
// on every render of the row — and the row had stopped re-rendering. Rows are
// a React.memo keyed on the message object and one extraData object, and
// ChatScreen's clockTick, which exists for exactly this and ticks every 30s,
// is deliberately NOT in that extraData. Its comment says so:
//
//     clockTick was in this list for a few minutes because a sloppier scan of
//     mine said rows used it — they do not
//
// The row's own comment says the opposite, that clockTick is "what keeps
// '4 min ago' from freezing". Both cannot be true, and the row's was the
// wrong one: a row does not MENTION clockTick, because what it reads is
// Date.now(). Searching for the name found nothing. The dependency is real
// and invisible to a search — the row needs a render every thirty seconds and
// has no way of asking for one.
//
// Putting clockTick back in extraData would work and would redraw every row
// in the chat twice a minute, which is what that comment was right to refuse.
// So the ticking lives here instead, in the one piece of text that needs it:
// this re-renders itself, nothing else, and only while a live share is on
// screen to mount it.
import React, { useEffect, useState } from 'react';
import { Text, StyleSheet } from 'react-native';
import { formatUpdated } from '../locationPick';

/** How often the wording can change: "just now" → "1 min ago" → … */
export const AGE_TICK_MS = 30_000;

export default function LiveAge({ updatedAt, style }: {
  updatedAt: unknown;
  style?: any;
}) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick(n => n + 1), AGE_TICK_MS);
    return () => clearInterval(t);
  }, []);
  // Date.now() is read during the render, so each tick re-reads the clock.
  return (
    <Text style={style} numberOfLines={1}>
      {formatUpdated(updatedAt, Date.now())}
    </Text>
  );
}

// Kept so a stylesheet-less caller still renders something readable.
export const liveAgeFallback = StyleSheet.create({ t: { fontSize: 11.5 } }).t;
