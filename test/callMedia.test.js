// Asking for the microphone (public/js/callMedia.js).
//
// Reported from an iPhone: tapping call says permission is needed, and no
// prompt ever appears, so the call cannot be made.
//
// The cause was ordering — getUserMedia was called after `await loadIce()`,
// and Safari discards the user gesture the moment the task handling the tap
// yields, then rejects with NotAllowedError and shows nothing. That fix lives
// in calls.js, where it is a matter of what comes before what.
//
// What is testable here is the other half: what the person is TOLD. Every one
// of these failures has a different remedy, and "Microphone/camera access is
// required" — the message this replaces — is the remedy for none of them. On
// Safari especially it is actively misleading: a refusal is remembered, so no
// amount of tapping call will ever produce a prompt again.
const assert = require('assert');
const path = require('path');
const M = require(path.join(__dirname, '..', 'public', 'js', 'callMedia.js'));

const tests = [];
const test = (n, f) => tests.push({ n, f });
const err = (name) => ({ name });
const on = (over = {}) => ({ secure: true, isApple: false, ...over });

test('an insecure page says so, rather than blaming permission', () => {
  // getUserMedia does not exist at all over plain http or with a broken
  // certificate. There is nothing to permit, so asking the user to grant
  // permission sends them looking for a setting that will not help.
  const msg = M.mediaErrorMessage(err('NotAllowedError'), on({ secure: false }));
  assert.ok(/https|secure/i.test(msg), msg);
  assert.ok(!/blocked for this site/i.test(msg), `blamed permission instead: ${msg}`);
});

test('a browser with no getUserMedia at all is the same story', () => {
  const msg = M.mediaErrorMessage(new Error('no-media-devices'), on());
  assert.ok(/https|secure/i.test(msg), msg);
});

test('THE ONE THAT STRANDS PEOPLE: a refusal on Safari says how to undo it', () => {
  // Safari remembers a refusal and will not ask again. Without directions the
  // call is simply impossible from then on, with no way to find out why.
  const msg = M.mediaErrorMessage(err('NotAllowedError'), on({ isApple: true }));
  assert.ok(/aA|Website Settings/i.test(msg), `no way back offered: ${msg}`);
  assert.ok(/microphone/i.test(msg), msg);
});

test('and on other browsers it points at the padlock instead', () => {
  const msg = M.mediaErrorMessage(err('NotAllowedError'), on({ isApple: false }));
  assert.ok(/padlock|address bar/i.test(msg), msg);
  assert.ok(!/aA/.test(msg), `gave Safari's directions to a non-Safari browser: ${msg}`);
});

test('the older spelling of a refusal is handled too', () => {
  // Some browsers still report the pre-standard names.
  for (const name of ['PermissionDeniedError', 'SecurityError']) {
    const msg = M.mediaErrorMessage(err(name), on({ isApple: true }));
    assert.ok(/Website Settings/i.test(msg), `${name} was not recognised as a refusal`);
  }
});

test('no microphone is not the same as a blocked one', () => {
  const msg = M.mediaErrorMessage(err('NotFoundError'), on());
  assert.ok(/No microphone/i.test(msg), msg);
  assert.ok(!/blocked|Settings/i.test(msg), `told them to change a setting that will not help: ${msg}`);
});

test('a microphone another app is holding says to close that app', () => {
  const msg = M.mediaErrorMessage(err('NotReadableError'), on());
  assert.ok(/in use|another app/i.test(msg), msg);
});

test('THE VOICE RECORDER: an insecure page is told the truth, not "not supported"', () => {
  // Reported from an iPhone: tapping Voice said "Audio recording not
  // supported." Recording is supported; the page was not allowed to ask,
  // because without https there is no navigator.mediaDevices at all. The old
  // message sent people looking for a browser problem that does not exist.
  const msg = M.mediaErrorMessage(new Error('no-media-devices'), { secure: false, what: 'recording' });
  assert.ok(/voice messages/i.test(msg), `does not say what failed: ${msg}`);
  assert.ok(/https/i.test(msg), msg);
  assert.ok(/certificate/i.test(msg), 'does not mention the other way https can fail');
  assert.ok(!/not supported/i.test(msg), 'still claims the browser cannot record');
});

test('and the same failure in a call still talks about calls', () => {
  const msg = M.mediaErrorMessage(new Error('no-media-devices'), { secure: false });
  assert.ok(/^Calls/.test(msg), msg);
  assert.ok(!/voice message/i.test(msg), msg);
});

test('a recorder refusal on Safari gets Safari\'s directions too', () => {
  const msg = M.mediaErrorMessage({ name: 'NotAllowedError' },
    { secure: true, isApple: true, what: 'recording' });
  assert.ok(/Website Settings/i.test(msg), msg);
});

test('an unrecognised failure still says something true', () => {
  const msg = M.mediaErrorMessage(err('WeirdNewError'), on());
  assert.ok(msg.length > 20, msg);
  // It must not invent a remedy it cannot know applies.
  assert.ok(!/Settings|padlock/i.test(msg), `guessed at a remedy: ${msg}`);
});

test('no error object at all does not crash', () => {
  assert.ok(M.mediaErrorMessage(null, on()).length > 0);
  assert.ok(M.mediaErrorMessage(undefined, on()).length > 0);
  assert.ok(M.mediaErrorMessage({}, on()).length > 0);
});

test('every message names the microphone, so it is clear what is being asked for', () => {
  for (const name of ['NotAllowedError', 'NotFoundError', 'NotReadableError', 'Whatever']) {
    for (const apple of [true, false]) {
      const msg = M.mediaErrorMessage(err(name), on({ isApple: apple }));
      assert.ok(/microphone/i.test(msg), `${name}: ${msg}`);
    }
  }
});

test('requestMedia refuses cleanly when the browser has no getUserMedia', async () => {
  // Rather than throwing a TypeError from deep inside, which the caller would
  // report as an unknown failure.
  const saved = global.navigator;
  global.navigator = {};
  try {
    await M.requestMedia(false);
    assert.fail('resolved on a browser with no media devices');
  } catch (e) {
    assert.strictEqual(e.message, 'no-media-devices');
  } finally {
    if (saved === undefined) delete global.navigator; else global.navigator = saved;
  }
});

// ── The ordering, which is the actual bug ───────────────────────────────────
//
// getUserMedia has to be reached before the tap's user activation is gone, and
// on Safari that means before the first `await`. This cannot be exercised
// without a browser, so it is checked by reading calls.js: in each function
// that starts a call, the media request must come BEFORE any await.
//
// A comment saying "do not await above this" would be advice. This fails.

const fs = require('fs');
const CALLS = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'calls.js'), 'utf8');

/** The body of a named function, up to its closing brace at the same indent. */
function bodyOf(name) {
  const start = CALLS.indexOf(`async function ${name}(`);
  assert.notStrictEqual(start, -1, `calls.js no longer has ${name}()`);
  const end = CALLS.indexOf('\n  }', start);
  assert.notStrictEqual(end, -1, `could not find the end of ${name}()`);
  return CALLS.slice(start, end);
}

for (const fn of ['startDM', 'accept', 'toggleRoomVoice']) {
  test(`THE BUG: ${fn}() asks for the microphone before it awaits anything`, () => {
    const body = bodyOf(fn);
    const media = body.indexOf('getMedia(');
    const firstAwait = body.indexOf('await ');
    assert.notStrictEqual(media, -1, `${fn}() no longer requests media`);
    assert.notStrictEqual(firstAwait, -1, `${fn}() awaits nothing — has it been rewritten?`);
    assert.ok(media < firstAwait,
      `${fn}() awaits something before asking for the microphone. On Safari the `
      + 'user gesture is gone by then, so the request is refused with no prompt '
      + 'and the call cannot be made at all.');
  });
}

test('the media request itself is not an async function', () => {
  // An `async` wrapper still begins synchronously, so this is not strictly
  // required — but it is the shape that invites somebody to add an `await`
  // above the request later, which is exactly how this broke.
  const media = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'callMedia.js'), 'utf8');
  assert.ok(/\n  function requestMedia\(/.test(media),
    'requestMedia is async again — the one shape that invites the bug back');
});

test('no call path reports failure without saying what to do', () => {
  // The message this replaced was "Microphone/camera access is required",
  // which is the remedy for none of the things that actually go wrong.
  assert.ok(!/access is required/.test(CALLS),
    'calls.js still shows the old message that tells nobody anything');
  assert.ok(/mediaFailed\(/.test(CALLS), 'calls.js no longer routes failures through mediaFailed');
});

// ── The wiring ──────────────────────────────────────────────────────────────

test('the voice recorder uses this diagnosis rather than its own two lines', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
  const fn = app.slice(app.indexOf('async function startRecording()'),
    app.indexOf('function buildRecWaveformBars'));
  assert.ok(fn.length > 0, 'startRecording is gone — this check would be vacuous');
  assert.ok(/CallMedia\.mediaErrorMessage\(err, \{/.test(fn), 'the recorder writes its own message again');
  assert.ok(/what: 'recording'/.test(fn), 'it would tell somebody recording about calls');
  assert.ok(fn.includes('CallMedia.isSecure()'), 'nothing checks whether the page is on https');
  // The literals, not the words: both are quoted in comments now, explaining
  // what they used to say and why they were wrong.
  assert.ok(!/alert\('Audio recording not supported/.test(app), 'the untrue message is still shown');
  assert.ok(!/alert\('Microphone access denied/.test(app), 'the catch-all refusal message is still shown');
  // Both failure paths, not just the one that was screenshotted.
  assert.ok(/if \(!navigator\.mediaDevices\?\.getUserMedia\) return explain\(/.test(fn),
    'a missing mediaDevices is still reported as "not supported"');
  assert.ok(/\} catch \(err\) \{[\s\S]*explain\(err\);/.test(fn),
    'a refused microphone is still reported with a guess');
});

let passed = 0, failed = 0;
(async () => {
  for (const { n, f } of tests) {
    try { await f(); console.log(`  ✓ ${n}`); passed++; }
    catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
