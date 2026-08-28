// ── What the ＋ button opens, and what sits around the shutter ────────────────
//
// Asked for as: tapping the media button next to the composer should open the
// camera straight away, with a menu to the left and right of the shutter for
// files, the gallery, voice and contacts — and photo/video switching, the way
// WhatsApp does it.
//
// The old flow put a sheet in the way. Every attachment began with a list, and
// the most common thing anyone attaches — a photo of what is in front of them —
// took two taps and a modal before the camera even started warming up. Opening
// the camera first inverts that: the common case is immediate, and the other
// four are one tap from where you already are.
//
// The layout is a rule rather than a hand-built row because the shutter has to
// stay in the middle, the actions have to be reachable by a thumb on both
// sides, and an action that is unavailable must not leave a gap where people
// have learnt to press.

export type AttachAction = 'gallery' | 'file' | 'voice' | 'contact' | 'paste';

export type ActionSpec = {
  id: AttachAction;
  /** Ionicons name. */
  icon: string;
  label: string;
  /** Which side of the shutter it sits on. */
  side: 'left' | 'right';
};

/**
 * The four actions, in the order they appear outwards from the shutter.
 *
 * Gallery is nearest the thumb on the left because it is the one people reach
 * for when the camera is not what they wanted; contacts is furthest away on
 * the right because it is the rarest.
 */
export const ACTIONS: ActionSpec[] = [
  { id: 'gallery', icon: 'images-outline', label: 'Gallery', side: 'left' },
  { id: 'file', icon: 'document-outline', label: 'File', side: 'left' },
  { id: 'voice', icon: 'mic-outline', label: 'Voice', side: 'right' },
  { id: 'contact', icon: 'person-outline', label: 'Contact', side: 'right' },
];

/**
 * What to show around the shutter right now.
 *
 * `paste` only appears when the clipboard actually holds something — an action
 * that does nothing is worse than one that is absent, and it is the fifth item
 * in a row that is already full.
 */
export function actionsFor(o: {
  side: 'left' | 'right';
  clipboard?: 'image' | 'file' | null;
}): ActionSpec[] {
  const base = ACTIONS.filter(a => a.side === o.side);
  if (o.side === 'right' && o.clipboard) {
    return [...base, { id: 'paste', icon: 'clipboard-outline', label: 'Paste', side: 'right' }];
  }
  return base;
}

/**
 * Can the camera itself do this, or does it have to be closed first?
 *
 * Recording a voice message and picking a contact both take over the screen,
 * and the gallery and file pickers are system UI on top of it. Leaving the
 * camera open underneath would keep the preview — and the phone's camera — busy
 * while somebody scrolls through a picker they may spend a minute in.
 */
export function closesCamera(action: AttachAction): boolean {
  return true;
}

/** Which mode the camera opens in when the ＋ is tapped. */
export const OPENS_IN: 'photo' | 'video' = 'photo';

/**
 * Should the camera open straight away, or is something in the way?
 *
 * Only one thing is: a chat the user cannot post to. Opening a camera for
 * somebody who cannot send the picture is a small cruelty, and the composer
 * already says why.
 */
export function opensCamera(o: { canPost: boolean }): boolean {
  return !!o.canPost;
}

// ── Sending a contact ────────────────────────────────────────────────────────

export type PickedContact = {
  name?: string | null;
  phoneNumbers?: { number?: string | null; label?: string | null }[] | null;
};

/**
 * A contact as a message.
 *
 * Sent as ordinary text on purpose. A dedicated contact type would mean a
 * server change, a new bubble, and a card that the web client would not
 * understand — for something whose whole content is a name and a number that
 * every phone already knows how to act on. The numbers are on their own lines
 * so they are tappable, which is what the recipient actually wants to do.
 */
export function contactMessage(c: PickedContact | null | undefined): string {
  if (!c) return '';
  const name = (c.name || '').trim();
  const numbers = (c.phoneNumbers || [])
    .map(p => (p?.number || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  // Duplicates are common: the same number stored as mobile and as WhatsApp.
  const unique = numbers.filter((n, i) => numbers.indexOf(n) === i);
  if (!name && !unique.length) return '';
  const lines = [name ? `👤 ${name}` : '👤 Contact', ...unique];
  return lines.join('\n');
}

/** Is there anything worth sending in what was picked? */
export function contactWorthSending(c: PickedContact | null | undefined): boolean {
  return contactMessage(c).length > 0 && (c?.phoneNumbers || []).length > 0;
}
