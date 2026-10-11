// ── The web's own notification, on a phone ─────────────────────────────────
//
// Reported as: the notification sound does not work on the web version on
// mobile.
//
// Two things were wrong in the same four lines, and either alone is enough to
// produce silence:
//
//   1. `new Notification(...)` THROWS on Android Chrome — "Illegal
//      constructor. Use ServiceWorkerRegistration.showNotification()
//      instead." It was the first statement, so on a phone the whole path
//      died there and neither the notification nor the sound after it
//      happened at all.
//
//   2. The notification asked for `silent: true` and then played notify.wav
//      by hand. This function only runs when the page is HIDDEN, and a
//      hidden page's audio is suspended by every mobile browser — so the
//      only sound a phone could have made was the one the system plays for
//      the notification, and that is exactly the one being switched off.
//
// The functions are lifted out of app.js and run, rather than grepped: a page
// cannot be required, and a test that only looks for a function name passes
// whatever that function does.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const APP = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');

const tests = [];
const test = (n, f) => tests.push({ n, f });

/**
 * The notification helpers, cut out of app.js and executed.
 *
 * `navigator` and `Notification` are injected, so one test can be a phone
 * with a service worker and the next a desktop browser without one.
 */
function build(env) {
  const from = APP.indexOf('/** The tag a message\'s notification carries');
  const to = APP.indexOf('window.addEventListener(\'DOMContentLoaded\'');
  assert.ok(from > 0 && to > from, 'could not find the notification helpers in app.js');
  const src = APP.slice(from, to);
  const make = new Function('navigator', 'Notification', src + `
    return { notifTag, raiseNotif, closeNotif };
  `);
  return make(env.navigator, env.Notification);
}

/** A browser with a service worker registered — every phone, and most desktops. */
function withWorker() {
  const shown = [];
  const closed = [];
  const notifications = [];
  const reg = {
    showNotification: async (title, opts) => {
      const n = { title, opts, close: () => closed.push(n) };
      shown.push(n);
      notifications.push(n);
    },
    getNotifications: async ({ tag }) => notifications.filter(n => n.opts.tag === tag),
  };
  const ctorCalls = [];
  return {
    shown, closed, ctorCalls,
    env: {
      navigator: { serviceWorker: { getRegistration: async () => reg } },
      // An Android Chrome constructor: it exists, and calling it throws.
      Notification: function () {
        ctorCalls.push(1);
        throw new TypeError('Illegal constructor. Use ServiceWorkerRegistration.showNotification() instead.');
      },
    },
  };
}

/** A browser with no service worker at all. */
function withoutWorker() {
  const made = [];
  return {
    made,
    env: {
      navigator: {},
      Notification: function (title, opts) { made.push({ title, opts }); },
    },
  };
}

test('THE BUG: a phone draws it through the service worker', () => {
  // `new Notification()` throws on Android Chrome. It was the first thing
  // this path did, so nothing after it ran.
  const w = withWorker();
  const api = build(w.env);
  return api.raiseNotif('ali', { body: '💬 New message', tag: 'chatroom-msg-7' }).then(() => {
    assert.strictEqual(w.shown.length, 1, 'nothing was drawn on a phone');
    assert.strictEqual(w.shown[0].title, 'ali');
    assert.strictEqual(w.ctorCalls.length, 0,
      'it still calls the constructor that throws on Android');
  });
});

test('…and a browser with no service worker still gets one', () => {
  const w = withoutWorker();
  const api = build(w.env);
  return api.raiseNotif('ali', { body: 'x' }).then(() => {
    assert.strictEqual(w.made.length, 1, 'a desktop browser lost its notification');
    assert.strictEqual(w.made[0].title, 'ali');
  });
});

test('A CONSTRUCTOR THAT THROWS DOES NOT TAKE THE PAGE WITH IT', () => {
  // The fallback is tried on a browser that has no worker AND a constructor
  // that refuses. Nothing is drawn, and nothing above it breaks.
  const api = build({
    navigator: {},
    Notification: function () { throw new TypeError('Illegal constructor'); },
  });
  return api.raiseNotif('ali', {});
});

test('THE NOTIFICATION IS NOT SILENT, and nothing plays a sound by hand', () => {
  // The system's sound is the only one a phone can make here: this path runs
  // only while the page is hidden, and a hidden page's audio is suspended.
  // Comments stripped first: this file explains the bug by quoting the very
  // thing it is asserting is gone, and the first version of this check
  // failed against correct code because of its own commentary.
  const bare = APP.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const fn = /function showNotif\(msg\) \{([\s\S]*?)\n\}/.exec(bare);
  assert.ok(fn, 'could not find showNotif');
  assert.ok(!/silent:\s*true/.test(fn[1]),
    'the notification asks for silence, which is the whole bug');
  assert.ok(!/new Audio\(/.test(fn[1]),
    'a sound is played by hand, which a hidden page cannot do');
  assert.ok(!/new Notification\(/.test(fn[1]),
    'it constructs a Notification directly, which throws on Android');
  assert.ok(/raiseNotif\(/.test(fn[1]), 'nothing draws the notification');
});

test('A DELETED MESSAGE TAKES ITS NOTIFICATION WITH IT', () => {
  const w = withWorker();
  const api = build(w.env);
  return api.raiseNotif('ali', { tag: api.notifTag(7) })
    .then(() => api.raiseNotif('sara', { tag: api.notifTag(8) }))
    .then(() => api.closeNotif(7))
    .then(() => {
      assert.strictEqual(w.closed.length, 1, 'the notification stayed on screen');
      assert.strictEqual(w.closed[0].opts.tag, api.notifTag(7),
        'it closed the wrong message\'s notification');
    });
});

test('…and the two sides agree on the tag', () => {
  // Raising with one spelling and closing with another is a notification
  // that can never be taken down, and nothing would say so.
  const api = build(withWorker().env);
  assert.strictEqual(api.notifTag(7), 'chatroom-msg-7');
  const bare = APP.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const show = /function showNotif\(msg\) \{([\s\S]*?)\n\}/.exec(bare);
  assert.ok(/tag: notifTag\(msg\.id\)/.test(show[1]),
    'the notification is tagged with a literal rather than the shared name');
  assert.ok(/closeNotif\(messageId\)/.test(APP), 'nothing closes a notification on delete');
});

test('CLOSING WITHOUT A SERVICE WORKER DOES NOT THROW', () => {
  const api = build(withoutWorker().env);
  return api.closeNotif(7);
});

(async () => {
  let passed = 0, failed = 0;
  for (const { n, f } of tests) {
    try { await f(); console.log(`  ✓ ${n}`); passed++; }
    catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
