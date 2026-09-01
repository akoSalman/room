// ── Changing your own name, and what you are told before you do ──────────────
//
// Asked for as: the profile section on the web is still the old one — bring
// the app's changes across.
//
// The web's profile predates two decisions the app made, and both of them are
// about the same thing: a username is an identity other people rely on to find
// and address you, so the server allows it to be changed twice and no more.
//
//   • THE PASSWORD. The web asks for the current password to change a name.
//     The server does not — it asks for one only to set a NEW password — so
//     the web was demanding a credential for an operation that does not need
//     it, which is both friction and a bad habit to teach.
//   • THE COUNT. The web never mentioned the limit. Somebody could spend one
//     of their two changes without being told there was a limit at all, and
//     discover it from a bare error when the second one ran out. The app says
//     how many are left BEFORE the change is committed to.
//
// The wording lives here so the two clients cannot say different things about
// a rule neither of them enforces.

/** How many changes the server allows. Mirrored, not authoritative. */
export const USERNAME_CHANGE_LIMIT = 2;

/**
 * What to tell somebody about to rename themselves.
 *
 * `null` means the answer has not come back yet, and that is its own state:
 * guessing a number at somebody about to spend one of two irreversible changes
 * is worse than making them wait a moment for it.
 */
export function changesLeftText(left: number | null | undefined): string {
  if (left === null || left === undefined) return 'Checking how many changes you have left…';
  if (left <= 0) return 'You have used all your username changes. This name can no longer be changed.';
  return `Your username can only be changed ${left} more ${left === 1 ? 'time' : 'times'}. `
    + 'People who know your old @name will no longer find you by it.';
}

/** May the change be attempted at all? */
export function canRename(left: number | null | undefined): boolean {
  return typeof left === 'number' && left > 0;
}

/**
 * Is there anything to save?
 *
 * The same name back is not a change — spending one of two on a no-op would be
 * the worst possible outcome of this dialog.
 */
export function renameWorthDoing(current: string, next: string): boolean {
  const a = String(current || '').trim();
  const b = String(next || '').trim();
  return !!b && a.toLowerCase() !== b.toLowerCase();
}

/** What the confirmation says afterwards. */
export function renamedText(left: number | null | undefined): string {
  if (typeof left !== 'number') return 'Username updated';
  return left > 0
    ? `Username updated — ${left} ${left === 1 ? 'change' : 'changes'} left`
    : 'Username updated — that was your last change';
}

// ── Changing a password ─────────────────────────────────────────────────────

/**
 * Why a password change cannot be sent yet, or null when it can.
 *
 * The current password IS required here, and this is the only place either
 * client offers to change one, so the check is worth stating rather than
 * leaving to the server's error message.
 */
export function passwordProblem(o: {
  currentPassword: string; newPassword: string; confirmPassword?: string;
}): string | null {
  if (!o.newPassword) return 'Enter the new password';
  if (!o.currentPassword) return 'Your current password is required to set a new one';
  if (o.confirmPassword !== undefined && o.newPassword !== o.confirmPassword) {
    return 'The two new passwords are not the same';
  }
  return null;
}
