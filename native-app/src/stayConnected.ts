// ── Not depending on Google to be told about a message ───────────────────────
//
// Reported, repeatedly: the message appears instantly and the notification
// arrives a couple of minutes later.
//
// Everything on this side has now been measured rather than guessed at. The
// chat server is in Frankfurt; it reaches Google in 33ms of TLS; it hands each
// push to FCM in about 139ms; every active user holds a valid device token;
// the Android channel is MAX importance and every message is sent
// `priority: high`. The registration bug that could have explained it is fixed
// and installed, and the notifications are still late.
//
// That leaves one link: Google to the handset. An Android phone receives push
// over a persistent connection to mtalk.google.com — a foreign Google service,
// which is the exact category of thing this project exists to work around. The
// chat server is reachable because it is an ordinary host in Germany. Google's
// push infrastructure is not reliably reachable from Iran, so the push waits
// in Google's queue until the phone's connection to it next gets through.
//
// Nothing on the server can shorten that: its part is over in a seventh of a
// second.
//
// ── Why this is not a foreground service ────────────────────────────────────
//
// The obvious answer is to hold the app's own socket open in the background
// behind a foreground service. This app cannot: see CALL_FOREGROUND_SERVICE in
// ongoingCall.ts, which is `false` because starting one crashed the app at the
// first ring, twice — the second time on a build carrying a fix for it — and
// the crash happens natively after displayNotification() returns, where no
// JavaScript can catch it. That file asks, in writing, that it not be turned
// back on without a crash log saying what Android objected to. Turning it on
// to fix this would be the same guess that already cost a release.
//
// ── What this does instead ──────────────────────────────────────────────────
//
// The reason the socket dies in the background is Doze: Android suspends
// network access for apps it is restricting. An app the user has exempted from
// battery optimisation keeps its connection — no foreground service, no
// permanent notification, nothing for Android to refuse.
//
// So: ask for that exemption once, and when a message arrives over the socket
// while the app is in the background, raise the notification immediately
// instead of waiting for FCM. FCM stays exactly as it is and remains the
// backstop for when the process really has been killed; the two carry the same
// tag, so whichever arrives second replaces the first rather than showing
// twice.
//
// This does not make delivery certain — nothing short of a foreground service
// does — but it moves the common case, a phone that is merely idle, from
// minutes to immediate.
//
// App-side only: the web keeps its socket for as long as the tab is open.

/**
 * The tag both notifications carry, so one message can only ever show once.
 *
 * The server puts `msg-<id>` on its FCM notification and the app uses the same
 * string as the identifier of the one it raises itself. Android replaces a
 * notification sharing a tag, so whichever arrives second silently takes the
 * place of the first instead of stacking a duplicate.
 *
 * This is the whole of the de-duplication, and it is why raising notifications
 * locally can be turned on without anyone seeing double.
 */
export function dedupeTag(messageId: number | string): string {
  return `msg-${messageId}`;
}

/**
 * Should the app raise this notification itself?
 *
 * This replaces the old rule, which was "only when push has not been
 * registered". That was written when the socket was standing in for a push
 * that had not arrived. It is now the FAST path — the whole point of this file
 * — and waiting for FCM to be absent before using it would give back the delay
 * being fixed. Both may now fire; the tag above makes that harmless.
 *
 * The exclusions are the ones that always applied: never your own message,
 * never while the app is on screen (the unread badges say it better, and a
 * notification for a chat being looked at is noise), and never for the chat
 * that is currently open.
 */
export function shouldRaiseLocally(o: {
  fromMe: boolean;
  appState: string | null | undefined;
  openRoomId?: number | string | null;
  msgRoomId?: number | string | null;
}): boolean {
  if (!o || o.fromMe) return false;
  if (String(o.appState || '') === 'active') return false;
  // Compared as strings: a room id arrives as a number over the socket and as
  // a string in a notification payload, and `1 !== '1'` would notify somebody
  // about the chat they are standing in.
  if (o.openRoomId != null && o.msgRoomId != null
      && String(o.openRoomId) === String(o.msgRoomId)) return false;
  return true;
}

// ── Asking to be left running ───────────────────────────────────────────────

/** That the exemption has been asked for once. Not that it was granted. */
export const ASKED_KEY = 'battery-exempt-asked';

/**
 * Should the user be asked to exempt this app from battery optimisation?
 *
 * Asked ONCE, and only after signing in — there is nothing to be notified
 * about before that, and a dialog about background behaviour on the login
 * screen is inexplicable.
 *
 * Whether it was granted cannot be read back without native code, so this
 * deliberately records only that the question was put. Asking again every
 * launch would be nagging, and a user who said no meant it; the switch in
 * settings is there for anyone who changes their mind.
 */
export function shouldAskExemption(o: {
  signedIn: boolean; alreadyAsked: boolean; platform: string;
}): boolean {
  if (!o || o.platform !== 'android') return false;
  return !!o.signedIn && !o.alreadyAsked;
}

/**
 * Where to send the user, in order of preference.
 *
 * Deliberately NOT android.settings.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, the
 * one-tap yes/no dialog. That one needs the matching permission declared AND
 * `package:<this app's id>` as its data — and the id is rewritten per brand by
 * CI, so it is not a constant this file can know. Guessing it wrong opens a
 * dialog about somebody else's app or throws.
 *
 * Both of these need no permission and take no data, so neither can fail in
 * the way the foreground service did. The first goes straight to the battery
 * list; the second is this app's own settings page, which every Android build
 * has, for OEM ROMs that have removed the first.
 */
export const EXEMPTION_INTENTS = [
  'android.settings.IGNORE_BATTERY_OPTIMIZATION_SETTINGS',
] as const;

/**
 * What to tell the user before the settings screen appears.
 *
 * Android's own screen says nothing about notifications and everything about
 * battery, so arriving there cold it reads like something to back out of. It
 * needs one sentence of why first, in the terms of the problem they actually
 * have — and it has to name what to look for, because this opens a list rather
 * than a single switch.
 */
export const EXEMPTION_TITLE = 'Get messages the moment they arrive';
export function exemptionBody(appName = 'this app'): string {
  return 'Android pauses this app in the background, which is why '
    + 'notifications can arrive minutes late. Letting it keep running fixes '
    + 'that.\n\n'
    + `On the next screen choose "All apps", find ${appName}, and set it to `
    + '"Don\'t optimise".';
}
