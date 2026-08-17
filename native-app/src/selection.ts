// ── Which messages are ticked, without re-rendering the whole list ───────────
//
// Multi-select was slow, and the reason was structural rather than a matter of
// tuning. The set of selected ids lived in React state and was handed to the
// FlatList as `extraData`, so every tick produced a brand new Set, and a new
// Set means every mounted row re-renders — twenty-odd bubbles with their
// images, video thumbnails and voice players — to change a tint on ONE of
// them.
//
// So selection is kept here instead, outside React, and interested parties
// subscribe. Ticking a message notifies the listeners; the one row that cares
// about that id updates itself, and nothing else in the list is touched.
//
// The one thing that still belongs in React state is whether select mode is on
// at all, because that genuinely changes the whole screen — the toolbar
// appears and taps start meaning "tick" instead of "open".

export type Id = number | string;

const ids = new Set<Id>();
const listeners = new Set<() => void>();

function notify() {
  listeners.forEach(fn => { try { fn(); } catch {} });
}

export function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function has(id: Id) { return ids.has(id); }
export function size() { return ids.size; }
export function all(): Id[] { return Array.from(ids); }

export function toggle(id: Id) {
  if (ids.has(id)) ids.delete(id); else ids.add(id);
  notify();
  return ids.size;
}

export function begin(id: Id) {
  ids.clear();
  ids.add(id);
  notify();
}

export function clear() {
  if (!ids.size) return;
  ids.clear();
  notify();
}

/**
 * Drop anything no longer in the list, and report whether that emptied it.
 *
 * Selected messages can be deleted by whoever sent them, or simply scroll out
 * of a chat that has been switched away and back. Ids left behind would be
 * forwarded or deleted by a later action even though the user can no longer see
 * what they refer to.
 */
export function retain(present: Iterable<Id>): boolean {
  const keep = new Set<string>();
  for (const id of present) keep.add(String(id));
  let changed = false;
  for (const id of Array.from(ids)) {
    if (!keep.has(String(id))) { ids.delete(id); changed = true; }
  }
  if (changed) notify();
  return ids.size === 0;
}
