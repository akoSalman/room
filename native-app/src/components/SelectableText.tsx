// Message text that can drop its own selection.
//
// React Native offers no way to clear a native text selection, so the only
// method is to remount the <Text>. That was done by putting the id of the
// message being cleared into the list's `extraData`, which re-rendered EVERY
// mounted row to remount one of them.
//
// That is what kept double-tap unreliable. Touching a message clears the
// selection left on the previous one, so the clear happens BETWEEN the first
// and second taps of the double-tap — and the re-render it caused reached the
// message being tapped, disturbing the tap tracking the OS was in the middle
// of. The double-tap failed, and tapping a different message first "fixed" it,
// because that got the clearing out of the way beforehand.
//
// Here each message subscribes to clears aimed at itself. Clearing one message
// remounts that message and touches nothing else.
import React, { useEffect, useState } from 'react';
import { Text, TextProps } from 'react-native';

type Listener = (id: number | string) => void;
const listeners = new Set<Listener>();

/** Drop the on-screen selection of one message. */
export function clearSelectionOf(id: number | string) {
  listeners.forEach(fn => { try { fn(id); } catch {} });
}

export default function SelectableText({
  msgId, children, ...rest
}: TextProps & { msgId: number | string; children: React.ReactNode }) {
  // Changing the key remounts the Text, which is what actually drops the
  // selection. The counter only ever has to differ from its previous value.
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    const fn: Listener = (id) => {
      if (String(id) === String(msgId)) setGeneration(n => n + 1);
    };
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  }, [msgId]);

  return <Text key={`sel${generation}`} {...rest}>{children}</Text>;
}
