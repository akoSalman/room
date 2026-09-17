// ── Not depending on Google to be told about a message ───────────────────────
//
// Reported, repeatedly: the message appears instantly and the notification
// arrives a couple of minutes later.
//
// Everything on this side has now been measured rather than guessed at, on
// BOTH servers, because they are not alike and an average of the two would
// have hidden it:
//
//                            akosalman        bistbarg
//   ipinfo.io                Frankfurt, DE    unreachable
//   TLS to Google            33ms             270ms
//   real FCM send (median)   —                138ms
//   active users with a token —               3 of 3
//
// bistbarg sits on the more restricted network of the two: it cannot reach
// ipinfo.io at all and is eight times further from Google. It still hands each
// push to FCM in 138ms, with every one returning 200 and every active user
// holding a valid device token. The Android channel is MAX importance and
// every message is sent `priority: high`. The registration bug that could have
// explained the delay is fixed and installed, and the notifications are still
// late.
//
// So the server is not slow on either brand — and on the brand where the
// report came from, it was measured directly rather than inferred from the
// other one.
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
// ── What this does about it ─────────────────────────────────────────────────
//
// Two halves, and the second one exists because the first is not enough.
//
// 1. RAISE THE NOTIFICATION OFF THE SOCKET. When a message arrives on the
//    app's own connection while it is in the background, show the notification
//    at once instead of waiting for FCM. The app already had this code; it was
//    gated on "only while no push token is registered", which is why fixing
//    registration in build 256 silenced it. FCM stays as the backstop, and the
//    two carry the same tag so one message still shows one notification.
//
// 2. KEEP THAT SOCKET ALIVE. Half one is worthless if the connection is dead,
//    and in the background it is: Doze suspends network access for any app
//    Android is restricting. Exempting the app from battery optimisation fixes
//    that — but it is four taps through a settings list, and asking every user
//    to find their way there is not a fix, it is a workaround with a drop-out
//    rate. So the app holds the connection open itself, with a foreground
//    service, and the exemption becomes a bonus rather than the mechanism.
//
// ── The foreground service, and why this one is allowed to exist ────────────
//
// ongoingCall.ts turned foreground services off after one crashed the app at
// the first ring, twice, and wrote beside it:
//
//   "it cannot be caught here: the service starts natively after
//    displayNotification() returns, so the try/catch around it is decoration.
//    Nothing in JavaScript can turn that into a handled error."
//
// That is true, and it is only true WITHIN one run of the app. The process
// dies; the phone does not. So the crash is catchable across launches, and the
// canary further down this file is how — see CANARY_KEY. A device this fails
// on disables it permanently after exactly one bad launch, instead of crashing
// at every ring for ever, which is what forced the wholesale switch-off.
//
// It also asks for none of the service types that were implicated: no
// PHONE_CALL, no MICROPHONE, no CAMERA, and so none of the runtime permission
// checks Android makes when those start.
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
 * The first is a single yes/no dialog for THIS app — one tap, and the only
 * version somebody who is not technical will finish. Reported as: the
 * power-saving setting is not straightforward and some users will not manage
 * it, which is exactly what the second option asks of them.
 *
 * It needs `package:<this app's id>` as its data, and I had written that off
 * as unknowable because CI rewrites the id per brand. It is not: CI rewrites
 * app.json BEFORE the bundle is built, so the app.json the app ships with
 * already says com.bistbarg.chatroom or com.akosalman.chatroom, whichever this
 * build is. See APP_PACKAGE in App.tsx.
 *
 * The second is the full battery list — no permission, no data, always
 * present — for the OEM ROMs that refuse the first.
 */
export const EXEMPTION_INTENTS = [
  'android.settings.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS',
  'android.settings.IGNORE_BATTERY_OPTIMIZATION_SETTINGS',
] as const;

/**
 * The `data` an exemption intent needs, or null when it takes none.
 *
 * Getting this wrong on the first intent opens a dialog about a different app,
 * so it is derived from the package rather than typed out.
 */
export function intentData(intent: string, packageName: string): string | null {
  if (intent !== 'android.settings.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS') return null;
  const pkg = String(packageName || '').trim();
  // No package, no dialog: falling through to the list is far better than
  // asking Android to exempt "package:".
  return pkg ? `package:${pkg}` : null;
}

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
  return 'Android pauses this app in the background, which can delay '
    + 'notifications. Allowing it to keep running makes them arrive '
    + 'immediately.\n\n'
    + `On the next screen, tap "Allow".\n\n`
    + `(If a list of apps opens instead, find ${appName} and set it to `
    + '"Don\'t optimise".)';
}

// ── Holding the socket open, without betting the app on it ──────────────────
//
// Asked for as: setting the power-saving option is not straightforward, and
// some users will not manage it.
//
// That is correct, and it rules the manual route out as THE answer. The only
// thing that keeps the socket alive without asking anything of the user is a
// foreground service — the mechanism ongoingCall.ts turned off after it
// crashed the app at the first ring, twice, with this written beside it:
//
//   "it cannot be caught here: the service starts natively after
//    displayNotification() returns, so the try/catch around it is decoration.
//    Nothing in JavaScript can turn that into a handled error."
//
// That is true, and it is only true WITHIN one run of the app. The process
// dies; the phone does not. So the crash is catchable ACROSS launches, which
// is what the canary below is:
//
//   1. write "about to start the service" to storage;
//   2. start it;
//   3. clear the flag once it is up.
//
// A process killed at step 2 never reaches step 3, so the flag is still there
// at the next launch — and that is not a guess, it is a fact about this
// handset. The service is then disabled on this device and never tried again.
//
// The worst case for somebody it does not work on is one app death, once, on
// the way into the background. The call version had no such limit: it fired at
// every ring for ever, which is why it had to be turned off wholesale.
//
// This is deliberately NOT a re-enabling of CALL_FOREGROUND_SERVICE. That one
// asks for the PHONE_CALL, MICROPHONE and CAMERA service types, whose
// permissions Android checks at the moment the service starts. This asks for
// none of them.

/** Set while a service start is in flight; still set at launch means it died. */
export const CANARY_KEY = 'keep-alive-canary';

/** Set once the canary has fired, so this device never tries again. */
export const DISABLED_KEY = 'keep-alive-disabled';

/**
 * May this device start the background service at all?
 *
 * `canaryPending` is the flag from a previous launch: the app was starting the
 * service and did not live to clear it.
 */
export function serviceAllowed(o: {
  canaryPending: boolean; previouslyDisabled: boolean; platform: string;
}): boolean {
  if (!o || o.platform !== 'android') return false;
  return !o.canaryPending && !o.previouslyDisabled;
}

/**
 * Should the service be running right now?
 *
 * Only while the app is AWAY and signed in. On screen the socket is already
 * alive and the process will not be frozen, so the service would buy nothing
 * and put a permanent notification in the shade of somebody who is looking at
 * the app it refers to.
 */
export function shouldRunService(o: {
  allowed: boolean; signedIn: boolean; appState: string | null | undefined;
}): boolean {
  if (!o || !o.allowed || !o.signedIn) return false;
  return String(o.appState || '') !== 'active';
}

/** The quietest notification Android will accept in exchange for a service. */
export const SERVICE_CHANNEL = 'background-connection';
export const SERVICE_ID = 'keep-alive';
export const SERVICE_TITLE = 'Connected';
export const SERVICE_BODY = 'Ready to receive messages';
