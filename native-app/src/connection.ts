// ── Are we actually reachable? ───────────────────────────────────────────────
//
// Deliberately NOT "does the phone have a network interface". A Wi-Fi that
// cannot reach our server is worth nothing to this app, and for these users
// that is the normal failure — the phone says it is connected while the
// connection to the server is being blocked or throttled. So the question this
// answers is only ever: did we last succeed in talking to the server?
//
// Two sources feed it:
//
//  • the socket, which is a live connection and therefore notices a drop or a
//    recovery on its own, with no request needed. This is what lets the app
//    say something while the user is just sitting there reading.
//  • the result of any request, which catches the case where the socket thinks
//    it is fine but nothing actually gets through.
//
// State is module-scope because the answer belongs to the app, not to whatever
// screen happens to be mounted.

export type ConnectionState = 'online' | 'offline';

// Optimistic to begin with: the app opens, tries, and corrects itself within a
// moment. Starting at "offline" would flash a warning at every launch.
let state: ConnectionState = 'online';
let changedAt = Date.now();

const listeners = new Set<(s: ConnectionState) => void>();

export function isOnline() { return state === 'online'; }
export function current(): ConnectionState { return state; }
/** When the state last actually changed — used to time the "back online" note. */
export function since() { return changedAt; }

export function subscribe(fn: (s: ConnectionState) => void) {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function report(up: boolean) {
  const next: ConnectionState = up ? 'online' : 'offline';
  if (state === next) return;
  state = next;
  changedAt = Date.now();
  listeners.forEach(f => { try { f(next); } catch {} });
}
