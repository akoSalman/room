// Errors that never reach a React error boundary.
//
// A boundary only sees a throw during render. The faults that actually kill
// this app in the field happen somewhere else entirely: in a socket handler,
// in a promise nobody awaited, in a timer. Those go to React Native's global
// handler, which in a release build does exactly one thing — end the process,
// with nothing on screen.
//
// So they are routed to the same screen. See crashReport.ts for why any of
// this exists: two crashes reported that I could not reproduce, and no
// crash-reporting service reachable from where this app is used.
import { CrashInfo } from './crashReport';

type Listener = (info: CrashInfo) => void;
let listener: Listener | null = null;
let installed = false;

/** Where a global error should be shown. Set by the boundary when it mounts. */
export function onGlobalCrash(fn: Listener | null) { listener = fn; }

export function installGlobalCrashHandler(): void {
  if (installed) return;
  installed = true;
  const g: any = global as any;
  const prev = g.ErrorUtils?.getGlobalHandler?.();
  try {
    g.ErrorUtils?.setGlobalHandler?.((err: any, isFatal?: boolean) => {
      try {
        listener?.({
          message: String(err?.message || err),
          stack: String(err?.stack || ''),
          isFatal: !!isFatal,
        });
      } catch {}
      // The original handler still runs. In development that is the red box,
      // which is more useful than this screen; in release it is what ends the
      // process, and it must still do so for a fatal error — carrying on
      // inside a broken runtime produces worse, stranger failures than
      // stopping does.
      if (isFatal && typeof prev === 'function') {
        // …but only AFTER the screen has had a frame to paint, or the report
        // is destroyed by the very crash it describes.
        setTimeout(() => { try { prev(err, isFatal); } catch {} }, 8000);
        return;
      }
      if (typeof prev === 'function') { try { prev(err, isFatal); } catch {} }
    });
  } catch {}
}
