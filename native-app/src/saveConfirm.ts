// ── Asking before saving a whole album ─────────────────────────────────────
//
// Mirrored by public/js/saveConfirm.js, compared function by function in
// test/saveConfirm.test.js.
//
// Asked for: tapping Download on a message holding several photos should save
// all of them, and should ask first.
//
// Saving all of them is what both clients already did — a gallery message
// keeps its paths in one column and both loop over them. What neither did was
// SAY so. One tap on a menu item called "Download" quietly wrote eleven files
// to somebody's phone, on a connection paid for by the megabyte, and the only
// way to find out how many was to watch them arrive.
//
// One photo is not asked about. A confirmation whose answer is always yes
// teaches people to dismiss confirmations, and "Download" on a single picture
// is not ambiguous.

/** How many files this message would save. Nonsense counts as none. */
export function fileCount(paths: unknown): number {
  if (!Array.isArray(paths)) return 0;
  let n = 0;
  for (const p of paths) {
    if (typeof p === 'string' && p) n++;
  }
  return n;
}

/**
 * Should the save be confirmed first?
 *
 * Only when it is more than one file: that is the whole surprise being
 * prevented.
 */
export function needsConfirm(count: unknown): boolean {
  const n = Number(count);
  return Number.isFinite(n) && n > 1;
}

export type ConfirmText = {
  title: string; body: string; confirm: string; cancel: string;
};

/**
 * What the confirmation says.
 *
 * The COUNT is the point of the sentence — it is the fact the person does not
 * have and the reason they are being asked — so it leads.
 */
export function confirmText(count: unknown): ConfirmText {
  let n = Number(count);
  if (!Number.isFinite(n) || n < 2) n = 2;
  return {
    title: `Save ${n} photos?`,
    body: `This will download all ${n} photos in this message to your device.`,
    confirm: 'Save all',
    cancel: 'Cancel',
  };
}
