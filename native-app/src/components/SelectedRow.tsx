// A message row that knows whether it is ticked, without the list being told.
//
// This is what makes multi-select quick. Selection used to live in React state
// and be handed to the FlatList as `extraData`, so ticking one message
// re-rendered every mounted row — every image, video thumbnail and voice
// player on screen — to change one tint.
//
// Here each row subscribes to the selection itself. A tick notifies the
// listeners, this row re-renders, and `children` is the very same element tree
// it was given before, so React walks straight past it. Nothing else in the
// list does any work at all.
import React, { useEffect, useState } from 'react';
import { View, StyleProp, ViewStyle } from 'react-native';
import * as selection from '../selection';

export default function SelectedRow({
  id, base, picked, children,
}: {
  id: number | string;
  /** Style for the row as it normally looks. */
  base: StyleProp<ViewStyle>;
  /** Extra style applied while the row is ticked. */
  picked: StyleProp<ViewStyle>;
  children: React.ReactNode;
}) {
  const [on, setOn] = useState(() => selection.has(id));

  useEffect(() => {
    // Read once on mount as well as on change: a row scrolled back into view
    // is a fresh mount, and it has to arrive already showing its tick.
    setOn(selection.has(id));
    return selection.subscribe(() => setOn(selection.has(id)));
  }, [id]);

  return <View style={[base, on && picked]}>{children}</View>;
}

/**
 * How many are ticked, WITHOUT re-rendering whoever wanted to know.
 *
 * The hook below does the counting, and calling it from a screen re-renders
 * that whole screen on every tick. In ChatScreen that meant a new `renderItem`
 * identity on every tap, which makes VirtualizedList re-render every mounted
 * cell — every photo, video and map on screen — precisely the work SelectedRow
 * exists to avoid. Wrapping the count in its own component keeps the re-render
 * inside these few characters of text.
 */
export function SelectionCount({ children }: { children: (n: number) => React.ReactNode }) {
  const n = useSelectionCount();
  return <>{children(n)}</>;
}

/** Anything that just needs to be redrawn when the selection changes. */
export function useSelectionCount(): number {
  const [n, setN] = useState(() => selection.size());
  useEffect(() => {
    setN(selection.size());
    return selection.subscribe(() => setN(selection.size()));
  }, []);
  return n;
}
