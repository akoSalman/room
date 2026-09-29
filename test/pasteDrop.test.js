// Pasting and dropping images and files.
//
// Asked for as: let the app and the web accept pasted and dropped images and
// files.
//
// The failure modes worth pinning down are not "does a file arrive" — they are
// the ones that quietly do the wrong thing:
//
//   - a plain text paste being swallowed, so typing breaks;
//   - the text half of a rich copy being taken instead of the image, so
//     pasting a screenshot from a document inserts a filename and drops the
//     picture;
//   - a dropped file the browser opens instead of the page, losing the chat
//     and whatever was typed;
//   - a dropped FOLDER becoming an upload that hangs forever;
//   - three pasted screenshots all called "image.png".
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const NAT = path.join(__dirname, '..', 'native-app');
const TSC = path.join(NAT, 'node_modules', '.bin', 'tsc');
if (!fs.existsSync(TSC)) {
  console.log('  ! skipping paste/drop tests (native-app deps not installed)');
  process.exit(0);
}
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'pastedrop-'));
execFileSync(TSC, [path.join(NAT, 'src', 'pasteDrop.ts'),
  '--outDir', OUT, '--module', 'commonjs', '--target', 'es2019', '--skipLibCheck'], { stdio: 'pipe' });
const N = require(path.join(OUT, 'pasteDrop.js'));

global.window = global;
require(path.join(__dirname, '..', 'public', 'js', 'pasteDrop.js'));
const W = global.window.PasteDrop;

const tests = [];
const test = (n, f) => tests.push({ n, f });

// ── What a paste is carrying ────────────────────────────────────────────────

test('THE BUG: a screenshot on the clipboard is recognised as a file', () => {
  assert.strictEqual(W.pasteCarriesFiles([{ kind: 'file', type: 'image/png' }]), true);
});

test('an ordinary text paste is left completely alone', () => {
  // If this ever returns true, pasting into the message box stops working.
  assert.strictEqual(W.pasteCarriesFiles([{ kind: 'string', type: 'text/plain' }]), false);
  assert.strictEqual(W.pasteCarriesFiles([]), false);
  assert.strictEqual(W.pasteCarriesFiles(null), false);
});

test('copying a picture out of a document takes the picture, not the caption', () => {
  // A rich copy puts several things on the clipboard at once. Taking the text
  // would paste a stray filename and silently drop the image.
  const rich = [
    { kind: 'string', type: 'text/plain' },
    { kind: 'string', type: 'text/html' },
    { kind: 'file', type: 'image/png' },
  ];
  assert.strictEqual(W.pasteCarriesFiles(rich), true);
});

test('an entry with no type at all is not treated as a file', () => {
  // Chrome reports a phantom `kind: 'file'` with an empty type for some
  // in-page drags; acting on it produces a paste of nothing.
  assert.strictEqual(W.pasteCarriesFiles([{ kind: 'file', type: '' }]), false);
});

// ── What a drag is carrying ─────────────────────────────────────────────────

test('THE BUG: a file drag is intercepted so the browser cannot open it', () => {
  // Left alone, dropping a photo on the page navigates away from the chat to
  // display a JPEG, taking the half-written message with it.
  assert.strictEqual(W.dragCarriesFiles(['Files']), true);
  assert.strictEqual(W.dragCarriesFiles(['text/plain', 'Files']), true);
});

test('dragging text or a link within the page is none of our business', () => {
  assert.strictEqual(W.dragCarriesFiles(['text/plain']), false);
  assert.strictEqual(W.dragCarriesFiles(['text/uri-list', 'text/plain']), false);
  assert.strictEqual(W.dragCarriesFiles([]), false);
});

// ── Naming ──────────────────────────────────────────────────────────────────

const AT = Date.parse('2026-08-22T19:03:45Z') + new Date().getTimezoneOffset() * 0;

test('THE BUG: pasted screenshots do not all end up called "image.png"', () => {
  const a = W.pastedName('image/png', AT, 'image.png');
  assert.ok(/^photo-\d{8}-\d{6}\.png$/.test(a), `unhelpful name: ${a}`);
  const b = W.pastedName('image/png', AT + 61_000, 'image.png');
  assert.notStrictEqual(a, b, 'two pastes a minute apart got the same name');
});

test('a real filename is kept, because it is better than one we invent', () => {
  assert.strictEqual(W.pastedName('application/pdf', AT, 'contract-final.pdf'), 'contract-final.pdf');
  assert.strictEqual(W.pastedName('image/jpeg', AT, 'IMG_2043.JPG'), 'IMG_2043.JPG');
});

test('a name with no extension is not trusted as a name', () => {
  const n = W.pastedName('image/png', AT, 'blob');
  assert.ok(n.endsWith('.png'), n);
  assert.ok(W.pastedName('video/mp4', AT, '').startsWith('video-'));
  assert.ok(W.pastedName('audio/mpeg', AT, undefined).startsWith('audio-'));
  assert.ok(W.pastedName('application/pdf', AT, '').startsWith('file-'));
});

test('a type that is not an extension does not become one', () => {
  // Otherwise a pasted Word document arrives called
  // "file-….vnd.openxmlformats-officedocument.wordprocessingml.document".
  assert.strictEqual(W.extensionFor(
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'), 'bin');
  assert.strictEqual(W.extensionFor('image/svg+xml'), 'svg');
  assert.strictEqual(W.extensionFor('image/png;charset=binary'), 'png');
  assert.strictEqual(W.extensionFor(''), 'bin');
  assert.strictEqual(W.extensionFor('video/quicktime'), 'mov');
});

// ── What gets refused ───────────────────────────────────────────────────────

test('THE BUG: a dropped folder is refused rather than uploaded forever', () => {
  // A directory arrives as a zero-byte entry with no type. Sent as a file it
  // produces an upload that never progresses and never fails.
  const r = W.partitionDropped([{ name: 'Holiday', type: '', size: 0 }]);
  assert.strictEqual(r.folders.length, 1);
  assert.strictEqual(r.accepted.length, 0);
  assert.ok(/folder/.test(W.rejectionMessage(r)), W.rejectionMessage(r));
});

test('an empty FILE with a real type is still a file', () => {
  // A zero-byte .txt is a legitimate thing to send, and the difference from a
  // folder is the type.
  const r = W.partitionDropped([{ name: 'notes.txt', type: 'text/plain', size: 0 }]);
  assert.strictEqual(r.accepted.length, 1, 'an empty text file was mistaken for a folder');
});

test('anything over the limit is refused here, by name', () => {
  const r = W.partitionDropped([
    { name: 'small.jpg', type: 'image/jpeg', size: 1000 },
    { name: 'film.mkv', type: 'video/x-matroska', size: 90 * 1024 * 1024 },
  ]);
  assert.deepStrictEqual(r.accepted.map(f => f.name), ['small.jpg']);
  assert.deepStrictEqual(r.tooLarge.map(f => f.name), ['film.mkv']);
  const msg = W.rejectionMessage(r);
  assert.ok(msg.includes('film.mkv'), `the message does not say which file: ${msg}`);
  assert.ok(msg.includes('80 MB'), msg);
});

test('a file exactly at the limit is accepted', () => {
  const r = W.partitionDropped([{ name: 'edge.bin', type: 'application/octet-stream', size: W.MAX_BYTES }]);
  assert.strictEqual(r.accepted.length, 1, 'the limit is off by one');
});

test('nothing to complain about produces no complaint', () => {
  const r = W.partitionDropped([{ name: 'a.png', type: 'image/png', size: 10 }]);
  assert.strictEqual(W.rejectionMessage(r), '');
});

// ── Reading the clipboard/drop itself ───────────────────────────────────────

/** The shape a browser hands over, near enough for what filesFrom touches. */
function fakeFile(name, type, size) {
  return { name, type, size: size || 4, lastModified: AT };
}

test('a pasted blob is renamed, and the SAME bytes are used', () => {
  const original = fakeFile('image.png', 'image/png');
  let constructed = null;
  const RealFile = global.File;
  global.File = function (parts, name, opts) {
    constructed = { parts, name, opts };
    return { name, type: opts.type, size: original.size };
  };
  try {
    const out = W.filesFrom({
      items: [{ kind: 'file', type: 'image/png', getAsFile: () => original }],
    }, AT);
    assert.strictEqual(out.length, 1);
    assert.ok(/^photo-/.test(out[0].name), out[0].name);
    assert.strictEqual(constructed.parts.length, 1, 'the blob was split or padded');
    assert.strictEqual(constructed.parts[0], original,
      'the file was copied rather than wrapped — a 60 MB paste would be read into memory twice');
    assert.strictEqual(constructed.opts.type, 'image/png', 'the renamed file lost its type');
  } finally { global.File = RealFile; }
});

test('a dropped file that already has a good name is passed through untouched', () => {
  const f = fakeFile('report.pdf', 'application/pdf');
  const out = W.filesFrom({ files: [f] }, AT);
  assert.strictEqual(out[0], f, 'a perfectly good file was needlessly rebuilt');
});

test('items win over files, because only items carry a pasted screenshot', () => {
  // A real paste populates BOTH: the same image appears under items and under
  // files. Reading both would stage every pasted photo twice.
  const viaItems = fakeFile('image.png', 'image/png');
  const out = W.filesFrom({
    items: [{ kind: 'file', type: 'image/png', getAsFile: () => viaItems },
            { kind: 'string', type: 'text/plain', getAsFile: () => null }],
    files: [viaItems],
  }, AT);
  assert.strictEqual(out.length, 1,
    `one pasted image produced ${out.length} attachments`);
});

test('a drop with no items still yields its files', () => {
  // Older browsers, and some file managers, populate only `files`.
  const out = W.filesFrom({ items: [], files: [fakeFile('a.txt', 'text/plain')] }, AT);
  assert.strictEqual(out.length, 1);
});

// ── The phone's half ────────────────────────────────────────────────────────

test('THE BUG: a clipboard image comes back as bytes that can be written', () => {
  const p = N.parseDataUri('data:image/png;base64,iVBORw0KGgo=');
  assert.deepStrictEqual(p, { mime: 'image/png', base64: 'iVBORw0KGgo=' });
});

test('a non-base64 data URI is refused rather than written as garbage', () => {
  // Decoding percent-encoded text as base64 writes a corrupt file that fails
  // silently on the way up.
  assert.strictEqual(N.parseDataUri('data:text/plain,hello%20there'), null);
  assert.strictEqual(N.parseDataUri('file:///tmp/a.png'), null);
  assert.strictEqual(N.parseDataUri(''), null);
  assert.strictEqual(N.parseDataUri('data:image/png;base64,'), null);
});

test('a charset in the middle does not defeat the parse', () => {
  const p = N.parseDataUri('data:image/png;charset=utf-8;base64,AAAA');
  assert.deepStrictEqual(p, { mime: 'image/png', base64: 'AAAA' });
});

test('a file URI copied as text is sent as a file, not as a line of text', () => {
  assert.strictEqual(N.fileUriFromText('content://media/external/images/1'),
    'content://media/external/images/1');
  assert.strictEqual(N.fileUriFromText('  file:///storage/emulated/0/a.pdf  '),
    'file:///storage/emulated/0/a.pdf');
});

test('a sentence that merely mentions a path stays a sentence', () => {
  assert.strictEqual(N.fileUriFromText('look at file:///tmp/a.pdf'), null);
  assert.strictEqual(N.fileUriFromText('https://example.com/a.pdf'), null);
  assert.strictEqual(N.fileUriFromText('file:///tmp/my holiday.pdf'), null);
  // Nothing that merely CONTAINS the scheme: only something that is one.
  assert.strictEqual(N.fileUriFromText('notfile:///tmp/a.pdf'), null);
  assert.strictEqual(N.fileUriFromText('x-content://media/1'), null);
  assert.strictEqual(N.fileUriFromText(''), null);
});

// ── The two platforms must agree ────────────────────────────────────────────

test('the web and the app answer identically, over every input that matters', () => {
  let checked = 0;
  const mimes = ['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp', 'image/heic',
    'image/svg+xml', 'video/mp4', 'video/quicktime', 'video/webm', 'audio/mpeg', 'audio/mp4',
    'audio/ogg', 'audio/wav', 'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'text/plain', '', 'image/png;charset=binary', 'weird', 'x/y', 'application/octet-stream'];
  const names = ['image.png', 'blob', '', 'report.pdf', 'IMG_1.JPG', 'noext', 'a.b.c.zip'];
  for (const m of mimes) {
    assert.strictEqual(W.extensionFor(m), N.extensionFor(m), `extensionFor drifted on "${m}"`);
    for (const n of names) {
      for (const at of [AT, 0, AT + 86_400_000]) {
        assert.strictEqual(W.pastedName(m, at, n), N.pastedName(m, at, n),
          `pastedName drifted on ("${m}", ${at}, "${n}")`);
        checked++;
      }
    }
  }
  assert.ok(checked > 200, `the drift check only ran ${checked} times`);

  const drops = [
    [], [{ name: 'a', type: '', size: 0 }], [{ name: 'b', type: 'image/png', size: 0 }],
    [{ name: 'c', type: 'image/png', size: W.MAX_BYTES + 1 }],
    [{ name: 'd', type: 'image/png', size: W.MAX_BYTES }],
    [{ name: 'e', type: 'image/png' }],
    [{ name: 'f', type: '', size: 0 }, { name: 'g', type: 'x/y', size: 999 }],
  ];
  for (const d of drops) {
    assert.deepStrictEqual(W.partitionDropped(d), N.partitionDropped(d),
      `partitionDropped drifted on ${JSON.stringify(d)}`);
    assert.strictEqual(W.rejectionMessage(W.partitionDropped(d)),
      N.rejectionMessage(N.partitionDropped(d)),
      `rejectionMessage drifted on ${JSON.stringify(d)}`);
  }
  for (const t of [['Files'], [], ['text/plain'], ['text/plain', 'Files']]) {
    assert.strictEqual(W.dragCarriesFiles(t), N.dragCarriesFiles(t));
  }
  for (const k of [[{ kind: 'file', type: 'image/png' }], [{ kind: 'string', type: 'text/plain' }],
    [{ kind: 'file', type: '' }], []]) {
    assert.strictEqual(W.pasteCarriesFiles(k), N.pasteCarriesFiles(k));
  }
  assert.strictEqual(W.MAX_BYTES, N.MAX_BYTES, 'the two platforms disagree about the size limit');
});

// ── Pasting from a button, which is the only way on a phone ─────────────────

test('THE GAP: an image is picked out of a clipboard entry that also holds text', () => {
  // Copying an image from a page puts the image, some HTML and a scrap of text
  // on the clipboard together. Taking the text would drop the photo.
  assert.strictEqual(W.pickType(['text/plain', 'text/html', 'image/png']), 'image/png');
  assert.strictEqual(W.pickType(['image/png', 'image/jpeg']), 'image/png');
  // The image wins even when something else file-shaped is offered FIRST —
  // copying out of a document viewer offers the PDF ahead of the picture, and
  // the picture is what was on screen. (Written this way because a check with
  // the image already first passed with the preference deleted entirely.)
  assert.strictEqual(W.pickType(['application/pdf', 'image/png']), 'image/png');
  assert.strictEqual(W.pickType(['application/octet-stream', 'image/jpeg']), 'image/jpeg');
});

test('a non-image file still beats the text beside it', () => {
  assert.strictEqual(W.pickType(['text/plain', 'application/pdf']), 'application/pdf');
});

test('a clipboard holding only text is not a file, and says so', () => {
  // The caller puts it in the message box. Refusing a copied link would be a
  // worse answer than pasting it.
  assert.strictEqual(W.pickType(['text/plain', 'text/html']), null);
  assert.strictEqual(W.pickType([]), null);
  assert.strictEqual(W.pickType(null), null);
});

test('the button is offered only where the clipboard can be read', () => {
  // Firefox has no clipboard.read(). A button that always fails is worse than
  // no button.
  assert.strictEqual(W.clipboardReadable({ clipboard: { read: () => {} } }), true);
  assert.strictEqual(W.clipboardReadable({ clipboard: { readText: () => {} } }), false);
  assert.strictEqual(W.clipboardReadable({ clipboard: {} }), false);
  assert.strictEqual(W.clipboardReadable({}), false);
  assert.strictEqual(W.clipboardReadable(null), false);
});

test('being refused the clipboard is not reported as a failure', () => {
  // The user just made that choice in Safari's own prompt; "paste failed"
  // would teach them the button is broken.
  const denied = W.clipboardProblem({ items: 0, error: { name: 'NotAllowedError' } });
  assert.ok(/allow/i.test(denied), denied);
  assert.ok(!/error|fail/i.test(denied), denied);
});

test('…and neither is an empty clipboard', () => {
  assert.ok(/empty/i.test(W.clipboardProblem({ items: 0 })));
  assert.strictEqual(W.clipboardProblem({ items: 1 }), null, 'a paste that worked still complains');
  const broke = W.clipboardProblem({ items: 0, error: { name: 'DataError' } });
  assert.ok(broke && !/allow/i.test(broke), broke);
});

test('THE PASTE BUTTON IS GONE, and pasting still works without it', () => {
  // Asked for: remove the Paste button. It was only ever offered where the
  // clipboard could be read on demand — never on a phone — and it duplicated
  // Ctrl+V, which works everywhere and needed no button.
  //
  // What this test guards is that removing the BUTTON did not remove the
  // FEATURE with it. The handlers below are what actually do the work.
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.ok(!/composer-paste/.test(html), 'the Paste button is back');
  assert.ok(!/composerPaste/.test(src), 'its handler is still here, unreachable');
  // Ctrl+V does the work now, through a different pair of rules — the button
  // read the clipboard on demand (pickType/pastedName), the handler is HANDED
  // it by the browser (pasteCarriesFiles/filesFrom). Removing the button
  // therefore left pickType and pastedName with no caller in the web, and
  // that is fine: they are pure, tested above, and the app still uses them.
  assert.ok(/PasteDrop\.pasteCarriesFiles\(/.test(src), 'Ctrl+V no longer recognises a file');
  assert.ok(/PasteDrop\.filesFrom\(/.test(src), 'Ctrl+V no longer extracts the file');
  assert.ok(/stageFiles\(/.test(src), 'a pasted or dropped file is never staged');
});

// ── The wiring, which no unit test can reach ────────────────────────────────

test('the web actually listens for paste and drop', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
  for (const ev of ['paste', 'dragover', 'dragenter', 'drop']) {
    assert.ok(new RegExp(`addEventListener\\('${ev}'`).test(src), `nothing listens for ${ev}`);
  }
  assert.ok(/window\.addEventListener\('drop'/.test(src),
    'a file dropped outside the chat is still opened by the browser, losing the conversation');
  assert.ok(src.includes('setupPasteAndDrop()'), 'the handlers are never installed');
});

test('the paste handler cannot swallow an ordinary text paste', () => {
  // preventDefault() before the check would break typing in every text box on
  // the page — the worst possible regression from this feature.
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
  const start = src.indexOf("document.addEventListener('paste'");
  assert.ok(start > 0, 'the paste handler is gone — this check is vacuous');
  const body = src.slice(start, src.indexOf('const zone =', start));
  assert.ok(body.indexOf('pasteCarriesFiles') < body.indexOf('preventDefault'),
    'preventDefault runs before the paste is known to carry files');
});

// ── The same button, on the app ─────────────────────────────────────────────

test('THE ASK: the app offers paste for what a text field cannot take', () => {
  // A screenshot, or a file copied in a file manager. Not plain text: the
  // message box already pastes that by long-press, and a button that lit up
  // for every copied word would bury the one case it exists for.
  assert.strictEqual(N.clipboardOffer({ hasImage: true }), 'image');
  assert.strictEqual(N.clipboardOffer({ hasImage: false, text: 'content://x/y/1' }), 'file');
  assert.strictEqual(N.clipboardOffer({ hasImage: false, text: 'file:///a/b.pdf' }), 'file');
  assert.strictEqual(N.clipboardOffer({ hasImage: false, text: 'hello there' }), null);
  assert.strictEqual(N.clipboardOffer({ hasImage: false, text: '' }), null);
  assert.strictEqual(N.clipboardOffer({ hasImage: false }), null);
  // An image outranks whatever text came with it.
  assert.strictEqual(N.clipboardOffer({ hasImage: true, text: 'a caption' }), 'image');
});

test('the clipboard TEXT is not read unless it has to be', () => {
  // Reading it raises a system "pasted from" notice on newer Androids, and
  // this now runs whenever the chat opens rather than once per attach menu.
  assert.strictEqual(N.shouldReadText({ hasImage: false, hasString: true }), true);
  assert.strictEqual(N.shouldReadText({ hasImage: true, hasString: true }), false,
    'the text is read even though the image already settled it');
  assert.strictEqual(N.shouldReadText({ hasImage: false, hasString: false }), false,
    'an empty clipboard is read anyway, accusing the app of snooping for nothing');
});

test('the button names what would actually happen', () => {
  assert.strictEqual(N.pasteLabel('image'), 'Paste image');
  assert.strictEqual(N.pasteLabel('file'), 'Paste file');
  assert.strictEqual(N.pasteLabel(null), 'Paste');
});

test('the app has the button on the composer, not only in the attach menu', () => {
  const comp = fs.readFileSync(path.join(NAT, 'src', 'components', 'Composer.tsx'), 'utf8');
  const src = fs.readFileSync(path.join(NAT, 'src', 'screens', 'ChatScreen.tsx'), 'utf8');
  assert.ok(/\{!!clipboard && \(/.test(comp),
    'the paste button is shown even when the clipboard holds nothing to paste');
  assert.ok(/onPress=\{onPaste\}/.test(comp), 'the button does nothing');
  assert.ok(/clipboard=\{clipboardHas\}/.test(src) && /onPaste=\{pasteFromClipboard\}/.test(src),
    'the composer is never told what is on the clipboard');
});

test('the clipboard is re-checked on coming back from another app', () => {
  // Which is exactly when somebody has just copied the thing they want to
  // send. Checking only when the attach menu opened made the strip button
  // impossible.
  const src = fs.readFileSync(path.join(NAT, 'src', 'screens', 'ChatScreen.tsx'), 'utf8');
  const fn = src.slice(src.indexOf('async function checkClipboard()'), src.indexOf('async function pasteFromClipboard()'));
  assert.ok(fn.length > 0, 'checkClipboard is gone — this check would be vacuous');
  assert.ok(/AppState\.addEventListener\('change', st => \{ if \(st === 'active'\) checkClipboard\(\)/.test(fn),
    'the clipboard is never re-checked, so the button reflects a stale answer');
  assert.ok(/sub\.remove\(\)/.test(fn), 'the listener outlives the screen');
  assert.ok(fn.includes('shouldReadText({'), 'the clipboard text is read on every glance at the chat');
  assert.ok(fn.includes('clipboardOffer({'), 'the screen decides for itself what counts as pasteable');
});

test('the app offers paste only when there is something to paste', () => {
  const src = fs.readFileSync(path.join(NAT, 'src', 'screens', 'ChatScreen.tsx'), 'utf8');
  assert.ok(src.includes('Clipboard.hasImageAsync'), 'the app never checks the clipboard');
  assert.ok(src.includes('pasteFromClipboard'), 'the app has no paste action');
  assert.ok(/\{clipboardHas && \(/.test(src),
    'the paste option is shown even when the clipboard is empty');
  assert.ok(src.includes('onShow={checkClipboard}'),
    'the clipboard is never re-checked, so the option reflects a stale answer');
});

// ── Pasting an image from the KEYBOARD ──────────────────────────────────────
//
// Reported with a photo of Gboard refusing outright: "BistbargChat does not
// support image pasting here". The clipboard button in the attach menu already
// worked; what did not was the way people actually paste — the keyboard's own
// image key, which every keyboard greys out unless the text field says it can
// take images. A React Native TextInput never says so and has no prop for it,
// which is why the field itself is patched.

const PATCH = path.join(NAT, 'patches', 'react-native+0.74.5.patch');

test('THE BUG: the text field tells the keyboard it accepts images', () => {
  assert.ok(fs.existsSync(PATCH), 'the patch is gone, so keyboards refuse images again');
  const patch = fs.readFileSync(PATCH, 'utf8');
  assert.ok(patch.includes('ReactEditText.java'), 'the patch is not against the text field');
  assert.ok(/setContentMimeTypes\(outAttrs, new String\[\] \{"image\/\*"\}\)/.test(patch),
    'nothing advertises image support, which is the whole of the bug');
  assert.ok(/createWrapper\(inputConnection, outAttrs, listener\)/.test(patch),
    'the keyboard is told images are accepted and then has nowhere to deliver them');
  assert.ok(/emit\("onPasteImage"/.test(patch), 'the committed image never reaches JS');
});

test('the pasted image is copied before the permission is given back', () => {
  // The read grant on the keyboard's content:// URI ends when the callback
  // returns. Staging that URI and uploading it a moment later would find
  // nothing there — the paste would look accepted and send an empty file.
  const patch = fs.readFileSync(PATCH, 'utf8');
  const commit = patch.slice(patch.indexOf('onCommitContent'), patch.indexOf('createWrapper('));
  assert.ok(commit.includes('requestPermission()'), 'the file is read without permission');
  const copied = commit.indexOf('new java.io.FileOutputStream');
  const released = commit.indexOf('releasePermission()');
  assert.ok(copied > -1, 'the image is never copied out of the keyboard\'s temporary URI');
  assert.ok(released > copied, 'the permission is handed back before the file has been copied');
  assert.ok(commit.includes('getCacheDir()'), 'the copy is not somewhere this app can read later');
});

test('a field that cannot do it still types', () => {
  // A text input that throws while being focused would be a far worse bug
  // than one that cannot take a pasted image.
  const patch = fs.readFileSync(PATCH, 'utf8');
  assert.ok(/catch \(Throwable t\)/.test(patch), 'a failure here breaks every text field in the app');
});

test('the app stages what the keyboard hands over', () => {
  const src = fs.readFileSync(path.join(NAT, 'src', 'screens', 'ChatScreen.tsx'), 'utf8');
  const at = src.indexOf("DeviceEventEmitter.addListener('onPasteImage'");
  assert.ok(at > -1, 'the pasted image is emitted into nothing');
  const fn = src.slice(at, at + 700);
  assert.ok(/setPendingMedia\(/.test(fn), 'the image never reaches the composer');
  assert.ok(/pastedName\(mime, Date\.now\(\)\)/.test(fn),
    'two pasted screenshots are both called image.png and cannot be told apart');
  assert.ok(/sub\.remove\(\)/.test(fn), 'the listener outlives the screen');
  assert.ok(/DeviceEventEmitter,?\s*\n?\} from 'react-native'|DeviceEventEmitter/.test(src.slice(0, 2000)),
    'DeviceEventEmitter is never imported');
});

test('sharing a file out is just called "Share"', () => {
  // Asked for: rename "Share to another app". Everywhere else in the app
  // already says Share — the row was the odd one out.
  const src = fs.readFileSync(path.join(NAT, 'src', 'screens', 'ChatScreen.tsx'), 'utf8');
  assert.ok(!/Share to another app/.test(src), 'the long label is still there');
  assert.ok(/label="Share" onPress=\{\(\) => \{ close\(\); shareOut\(m\); \}\}/.test(src),
    'the share row lost its action along with its label');
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
fs.rmSync(OUT, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
