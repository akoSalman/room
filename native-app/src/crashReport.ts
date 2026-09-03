// ── Turning a crash into something somebody can send me ──────────────────────
//
// Reported as: tapping the comment button and tapping the call button both
// crash the app.
//
// I could not find either fault by reading the code, and this is the third
// time in this project I have been asked to fix a crash I cannot reproduce, on
// a device I cannot reach, in a place where no crash-reporting service is
// reachable either. Twice I have guessed at the cause, shipped the guess, and
// been told it still crashes. Guessing has a worse record here than admitting
// I do not know.
//
// So: a crash stops being a disappearance. A JavaScript error anywhere in the
// app now draws a screen with what went wrong, where, and a Copy button — one
// screenshot, or one paste, and the cause stops being a mystery.
//
// What this CANNOT catch, said plainly so the next report is not misread: a
// native crash. If Android itself kills the process — a SecurityException from
// a foreground service, a bad JNI call, an out-of-memory — no JavaScript runs
// afterwards and the app still vanishes with nothing on screen. So the two
// outcomes now mean different things, and that is the point:
//
//   • an error screen  → a JavaScript fault, and the screen names it
//   • still vanishes   → a native fault, and the JavaScript is innocent
//
// Either answer is worth more than another guess.

export type CrashInfo = {
  message?: string | null;
  stack?: string | null;
  /** React's own trace of which components were mounting. */
  componentStack?: string | null;
  /** What the user was doing, when the caller knows. */
  where?: string | null;
  isFatal?: boolean;
};

/** How many lines of stack are worth showing on a phone screen. */
export const STACK_LINES = 6;

/**
 * The error as one readable block.
 *
 * Written to be legible to somebody who is not a programmer and is going to
 * photograph it: the message first and unabbreviated, then where, then as much
 * stack as fits. Nothing is truncated in the middle — a report cut off at the
 * useful part is the same as no report.
 */
export function describeCrash(info: CrashInfo | null | undefined): string {
  const i = info || {};
  const lines: string[] = [];
  lines.push(String(i.message || 'Unknown error').trim() || 'Unknown error');
  if (i.where) lines.push(`While: ${i.where}`);
  const stack = topFrames(i.stack, STACK_LINES);
  if (stack.length) lines.push('', ...stack);
  const comp = topFrames(i.componentStack, 4);
  if (comp.length) lines.push('', 'In:', ...comp);
  return lines.join('\n');
}

/**
 * The first few frames, tidied.
 *
 * The frames that matter are at the top; below them are dozens from React and
 * the bundler that say nothing about this app. Bundle paths are stripped
 * because on a release build every one of them is the same long path and it
 * pushes the useful part off the screen.
 */
export function topFrames(stack: string | null | undefined, limit: number): string[] {
  return String(stack || '')
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .filter(l => !/^(?:Error|TypeError|ReferenceError):/.test(l))
    .slice(0, Math.max(0, limit))
    .map(l => l.replace(/https?:\/\/\S*?\/([^/\s]+\.(?:js|bundle))/g, '$1')
      .replace(/\/(?:data|storage)\/\S+\//g, ''));
}

/**
 * Is this the same crash we are already showing?
 *
 * An error thrown while the error screen itself is rendering, or one that
 * repeats every frame, would otherwise replace the report with itself forever
 * and the user would never get to read it — a crash loop wearing a nicer coat.
 */
export function isSameCrash(a: CrashInfo | null, b: CrashInfo | null): boolean {
  if (!a || !b) return false;
  return String(a.message || '') === String(b.message || '')
    && topFrames(a.stack, 2).join('|') === topFrames(b.stack, 2).join('|');
}

/**
 * What the screen offers to do next.
 *
 * A fatal error has left the JavaScript in an unknown state, so the only
 * honest option is to start again. A non-fatal one — a render that failed
 * inside one screen — can usually be backed out of, and losing a half-written
 * message to a restart nobody needed would be its own small disaster.
 */
export function canContinue(info: CrashInfo | null | undefined): boolean {
  return !(info && info.isFatal);
}

/** The line under the message, in plain words. */
export const CRASH_HINT =
  'Something in the app went wrong. This is not your fault and nothing has '
  + 'been lost. Copy this and send it, and it can be fixed properly.';
