// ── The line above the composer: typing, recording, and now sending ──────────
//
// Asked for: just like "is typing", sending an image or a file should be
// reported.
//
// Typing and recording already had this, and the two clients each wrote their
// own sentence for it — the web says "is recording", the app says "is
// recording…" and joins names with commas, and neither knew what the other
// did. Adding a third activity to that would have meant writing it twice and
// watching them drift, so the wording moves here first.
//
// Mirrored by public/js/activityBar.js, compared function by function in
// test/activityBar.test.js.

/** What somebody is putting on the wire. */
export type SendKind = 'photo' | 'photos' | 'video' | 'voice' | 'audio' | 'file';

export type Sender = { username: string; kind: SendKind };

export type Activity = {
  typing?: string[] | null;
  recording?: string[] | null;
  sending?: Sender[] | null;
  /** Never announce the reader to themselves. */
  me?: string | null;
};

/** Which line wins, or null when there is nothing to say. */
export type Bar = { kind: 'recording' | 'sending' | 'typing'; icon: string; text: string } | null;

/**
 * The message type a file will be sent as, turned into a word for the line.
 *
 * Takes the same type strings the rest of the app uses, so a new message type
 * that nobody thought about here says "file" rather than "undefined".
 */
export function sendKindFor(messageType: string | null | undefined): SendKind {
  switch (String(messageType || '')) {
    case 'image': return 'photo';
    case 'gallery': return 'photos';
    case 'video': return 'video';
    case 'audio': return 'voice';
    case 'music': return 'audio';
    default: return 'file';
  }
}

/**
 * The same answer from a mime type, for the callers that have a File rather
 * than a message type.
 *
 * Here rather than inline at the call site because the web derived it in one
 * place and the app in another, and a third copy for this feature is how the
 * wording drifts.
 */
export function sendKindForMime(mime: string | null | undefined): SendKind {
  const m = String(mime || '');
  if (m.startsWith('image/')) return 'photo';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  return 'file';
}

/** "a photo", "photos", "a video" — the object of "is sending …". */
export function sendNoun(kind: SendKind): string {
  switch (kind) {
    case 'photo': return 'a photo';
    case 'photos': return 'photos';
    case 'video': return 'a video';
    case 'voice': return 'a voice message';
    case 'audio': return 'an audio file';
    default: return 'a file';
  }
}

function others(names: readonly string[] | null | undefined, me: string | null | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const n of names || []) {
    const name = String(n || '');
    // Yourself, an empty name, and the same person twice — a user with two
    // devices typing on both would otherwise be announced as two people.
    if (!name || (me && name === me) || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/**
 * How several names read.
 *
 * Two are both worth naming; beyond that the names stop being information and
 * start being a wall of text in a one-line bar.
 */
function nameList(names: string[]): string {
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names[0]} and ${names.length - 1} others`;
}

const isPlural = (names: string[]) => names.length > 1;

/**
 * What the bar should say.
 *
 * Recording keeps the priority it already had over typing, and sending slots
 * between them: it is the more informative of the two — a slow upload is why
 * nothing has arrived yet — but somebody holding the microphone down is about
 * to stop, and a line that flickers away from it would be worse.
 *
 * Returns null when there is nothing to report, so the caller has one thing to
 * check rather than three.
 */
export function activityBar(a: Activity): Bar {
  const me = a?.me ?? null;
  const recording = others(a?.recording, me);
  if (recording.length) {
    return {
      kind: 'recording', icon: '🎙',
      text: `${nameList(recording)} ${isPlural(recording) ? 'are' : 'is'} recording`,
    };
  }

  const sendingAll = (a?.sending || []).filter(s => s && s.username);
  const senders = others(sendingAll.map(s => s.username), me);
  if (senders.length) {
    // One sender gets their own noun; several get the general one, because
    // "Ali is sending a photo and Sara is sending a video" does not fit on a
    // line and listing two nouns for three people is worse than not trying.
    const only = senders.length === 1
      ? sendingAll.find(s => s.username === senders[0])
      : null;
    const what = only ? sendNoun(only.kind) : 'files';
    return {
      kind: 'sending', icon: '📎',
      text: `${nameList(senders)} ${isPlural(senders) ? 'are' : 'is'} sending ${what}`,
    };
  }

  const typing = others(a?.typing, me);
  if (typing.length) {
    return {
      kind: 'typing', icon: '',
      text: `${nameList(typing)} ${isPlural(typing) ? 'are' : 'is'} typing`,
    };
  }
  return null;
}

// ── Announcing your own uploads ─────────────────────────────────────────────

/**
 * Whether a change in how many uploads are running is worth telling anyone.
 *
 * This exists because the obvious version is wrong. Emitting "sending" when an
 * upload starts and "stopped" when it finishes breaks the moment there are
 * two: the first to finish clears the indicator while the second is still
 * going, and the other side sees the line vanish with a file still on the way.
 *
 * So the announcement follows the count crossing zero, not each upload.
 */
export function announceOnChange(before: number, after: number): 'start' | 'stop' | null {
  const b = Math.max(0, Number(before) || 0);
  const a = Math.max(0, Number(after) || 0);
  if (b === 0 && a > 0) return 'start';
  if (b > 0 && a === 0) return 'stop';
  return null;
}

/** The count after one upload starts or ends, never going below zero. */
export function nextInFlight(count: number, delta: number): number {
  return Math.max(0, (Number(count) || 0) + (Number(delta) || 0));
}
