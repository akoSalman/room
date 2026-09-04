// The profile, and the two things the web's copy of it had never been told.
//
// Asked for as: the profile section on the web is still the old one — bring
// the app's changes across.
//
// The web's profile predated two decisions, both about the same rule: a
// username is an identity other people rely on to find and address you, so the
// server allows it to be changed twice and no more.
//
//   • THE PASSWORD. The web asked for the current password to change a name.
//     The server does not — it asks for one only to set a NEW password — so
//     the web demanded a credential for an operation that never needed it.
//   • THE COUNT. The web never mentioned the limit, so somebody could spend
//     one of two changes without knowing there was a limit at all, and meet it
//     as a bare error when the second ran out.
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const NAT = path.join(ROOT, 'native-app');
const TSC = path.join(NAT, 'node_modules', '.bin', 'tsc');

global.window = global;
require(path.join(ROOT, 'public', 'js', 'profileEdit.js'));
const W = global.window.ProfileEdit;

let A = null;
if (fs.existsSync(TSC)) {
  const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'profedit-'));
  execFileSync(TSC, [path.join(NAT, 'src', 'profileEdit.ts'),
    '--outDir', OUT, '--module', 'commonjs', '--target', 'es2019', '--skipLibCheck'], { stdio: 'pipe' });
  A = require(path.join(OUT, 'profileEdit.js'));
  process.on('exit', () => fs.rmSync(OUT, { recursive: true, force: true }));
} else {
  console.log('  ! app-side rules skipped (native-app deps not installed); web copy still checked');
}

const tests = [];
const test = (n, f) => tests.push({ n, f });

// ── What somebody is told before renaming ───────────────────────────────────

test('THE COUNT: how many changes are left is said BEFORE one is spent', () => {
  assert.ok(/2 more times/.test(W.changesLeftText(2)), W.changesLeftText(2));
  assert.ok(/1 more time\b/.test(W.changesLeftText(1)), 'the singular reads as "1 more times"');
  assert.ok(/no longer find you/.test(W.changesLeftText(1)), 'it does not say what a rename costs');
});

test('"not known yet" is its own state, not a guess', () => {
  // Guessing a number at somebody about to spend one of two irreversible
  // changes is worse than making them wait a moment for the real one.
  const t = W.changesLeftText(null);
  assert.ok(/checking/i.test(t), t);
  assert.strictEqual(W.changesLeftText(undefined), t);
  assert.strictEqual(W.canRename(null), false, 'a rename was allowed before the limit was known');
  assert.strictEqual(W.canRename(undefined), false);
});

test('and when they are used up, it says so plainly', () => {
  assert.ok(/no longer be changed/.test(W.changesLeftText(0)));
  assert.strictEqual(W.canRename(0), false);
  assert.strictEqual(W.canRename(1), true);
  assert.strictEqual(W.canRename(2), true);
});

test('the same name back is not a change', () => {
  // Spending one of two on a no-op would be the worst outcome of this dialog.
  assert.strictEqual(W.renameWorthDoing('ako', 'ako'), false);
  assert.strictEqual(W.renameWorthDoing('ako', ' ako '), false);
  assert.strictEqual(W.renameWorthDoing('ako', 'AKO'), false, 'a case-only change spends one');
  assert.strictEqual(W.renameWorthDoing('ako', ''), false);
  assert.strictEqual(W.renameWorthDoing('ako', '   '), false);
  assert.strictEqual(W.renameWorthDoing('ako', 'soran'), true);
});

test('afterwards it says what is left', () => {
  assert.ok(/1 change left/.test(W.renamedText(1)), W.renamedText(1));
  assert.ok(/2 changes left/.test(W.renamedText(2)));
  assert.ok(/last change/.test(W.renamedText(0)), W.renamedText(0));
  assert.strictEqual(W.renamedText(null), 'Username updated');
});

// ── Changing a password ─────────────────────────────────────────────────────

test('a password change DOES need the current one', () => {
  // This is the one place either client offers to change a password, and the
  // server requires it here — unlike a rename.
  assert.ok(/current password/i.test(W.passwordProblem({ currentPassword: '', newPassword: 'x'.repeat(9) })));
  assert.strictEqual(W.passwordProblem({ currentPassword: 'old', newPassword: 'newpassword' }), null);
});

test('and something to change it to', () => {
  assert.ok(/new password/i.test(W.passwordProblem({ currentPassword: 'old', newPassword: '' })));
});

test('the app and the web say the same things', () => {
  if (!A) return;
  let checked = 0;
  for (const left of [null, undefined, 0, 1, 2, 5]) {
    assert.strictEqual(W.changesLeftText(left), A.changesLeftText(left), `changesLeftText(${left})`);
    assert.strictEqual(W.canRename(left), A.canRename(left));
    assert.strictEqual(W.renamedText(left), A.renamedText(left));
    checked++;
  }
  for (const [a, b] of [['ako', 'ako'], ['ako', 'AKO'], ['ako', 'soran'], ['', 'x'], ['x', '']]) {
    assert.strictEqual(W.renameWorthDoing(a, b), A.renameWorthDoing(a, b), `${a} → ${b}`);
    checked++;
  }
  for (const o of [{ currentPassword: '', newPassword: '' }, { currentPassword: 'a', newPassword: '' },
    { currentPassword: '', newPassword: 'b' }, { currentPassword: 'a', newPassword: 'b' }]) {
    assert.strictEqual(W.passwordProblem(o), A.passwordProblem(o));
    checked++;
  }
  assert.strictEqual(checked, 15, 'the drift check did not actually run');
  assert.strictEqual(W.USERNAME_CHANGE_LIMIT, A.USERNAME_CHANGE_LIMIT);
});

test('the limit here is the limit the server enforces', () => {
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const m = /const USERNAME_CHANGE_LIMIT = (\d+);/.exec(server);
  assert.ok(m, 'the server no longer has a limit — this check would be vacuous');
  assert.strictEqual(W.USERNAME_CHANGE_LIMIT, parseInt(m[1], 10),
    'the clients promise a different number of changes than the server allows');
});

// ── The web's profile ───────────────────────────────────────────────────────

const app = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

test('THE PASSWORD: renaming on the web no longer asks for one', () => {
  const fn = app.slice(app.indexOf('async function saveUsername()'), app.indexOf('// ─── Changing your password'));
  assert.ok(fn.length > 0, 'saveUsername is gone — this check would be vacuous');
  assert.ok(/api\('\/profile', 'PUT', \{ newUsername: next \}\)/.test(fn),
    'the rename still sends a password the server never wanted');
  assert.ok(fn.includes('ProfileEdit.renameWorthDoing('), 'the web decides for itself what counts as a change');
  assert.ok(fn.includes('ProfileEdit.canRename('), 'it can rename past the limit');
});

test('the pencil, the warning and the count are all on the page', () => {
  assert.ok(/id="prof-rename-btn"/.test(html), 'there is no way to start a rename');
  assert.ok(/id="username-warn"/.test(html), 'nothing says how many changes are left');
  assert.ok(app.includes('ProfileEdit.changesLeftText('), 'the web writes its own warning');
  assert.ok(/const me = await api\('\/me'\)/.test(app), 'the count is guessed rather than asked for');
});

test('a password change still re-wraps the encryption key', () => {
  // The private key is wrapped with the password; without this every
  // encrypted chat becomes unreadable at the next sign-in.
  const fn = app.slice(app.indexOf('async function savePassword()'), app.indexOf('async function savePassword()') + 1600);
  assert.ok(/E2E\.rewrap\(newPassword, api\)/.test(fn), 'the encryption key is left wrapped with the old password');
  assert.ok(fn.includes('ProfileEdit.passwordProblem('), 'the checks are written out again by hand');
});

test('the avatar picker is six and a "more", like the app', () => {
  assert.ok(/AVATAR_EMOJIS\.slice\(0, 6\)/.test(app), 'the whole grid is dumped into the sheet again');
  assert.ok(app.includes('function openAllAvatars('), 'the "⋯" leads nowhere');
  assert.ok(/id="avatar-all-modal"/.test(html), 'there is no picker to open');
});

test('the APK comes from THIS server, not from GitHub', () => {
  // GitHub is unreachable for most of the people using this. The old profile
  // linked straight there and only swapped the link if a fetch happened to
  // succeed — exactly the wrong way round.
  const btn = /<a[^>]*id="update-download-btn"[^>]*>/.exec(html);
  assert.ok(btn, 'the download button is gone');
  assert.ok(/href="\/app\/download"/.test(btn[0]), `still points at ${btn[0]}`);
  assert.ok(!/github\.com/.test(btn[0]), 'the hard-coded GitHub link is back');
  // The banner on the sign-in screen is the same download and had the same
  // problem; it is checked here so the pair cannot drift apart.
  const banner = /<a[^>]*id="apk-banner"[^>]*>/.exec(html);
  assert.ok(banner && /href="\/app\/download"/.test(banner[0]),
    `the sign-in banner does not download from this server: ${banner && banner[0]}`);
});

test('the version boxes say what they know, and admit what they do not', () => {
  const fn = app.slice(app.indexOf('async function loadLatestAppVersion()'), app.indexOf('async function loadMyRooms()'));
  assert.ok(fn.includes("apkBox.textContent = '—'"), 'an unknown version is drawn as a number anyway');
  assert.ok(/err\.classList\.remove\('hidden'\)/.test(fn), 'a failed check says nothing at all');
  assert.ok(/id="apk-version"/.test(html) && /id="web-version"/.test(html), 'the boxes are not on the page');
});

test('the app uses the same wording it just gave the web', () => {
  const rooms = fs.readFileSync(path.join(NAT, 'src', 'screens', 'RoomsScreen.tsx'), 'utf8');
  assert.ok(rooms.includes("from '../profileEdit'"), 'the app kept its own copy of the wording');
  assert.ok(/changesLeftText\(changesLeft\)/.test(rooms), 'the app writes the warning inline again');
  assert.ok(/renameWorthDoing\(me, name\)/.test(rooms), 'the app spends a change on renaming to the same name');
});

// ── The shape of it ─────────────────────────────────────────────────────────
//
// Reported as: the web profile is not like the app's. On a phone the app draws
// it as a SHEET — up from the bottom edge, full width, rounded only at the top,
// with a grip. The web drew a floating card with all four corners rounded and a
// hard 400px width: the same information in a shape from a different app.

test('THE SHAPE: on a phone the web profile is the app\'s sheet', () => {
  const css = fs.readFileSync(path.join(ROOT, 'public', 'css', 'style.css'), 'utf8');
  const phone = css.slice(css.indexOf('@media (max-width: 600px) {',
    css.indexOf('.sheet-grip { display: none; }')));
  const block = phone.slice(0, phone.indexOf('\n}\n') + 3);
  assert.ok(/#profile-modal\.modal-overlay/.test(block), 'the profile is not laid out as a sheet');
  assert.ok(/align-items:\s*flex-end/.test(block), 'it still floats in the middle of the screen');
  assert.ok(/border-radius:\s*20px 20px 0 0/.test(block),
    'all four corners are still rounded, so it reads as a card and not a sheet');
  assert.ok(/max-width:\s*none/.test(block), 'it is still pinned to a card width');
  assert.ok(/max-height:\s*88vh/.test(block),
    'it covers the whole screen, which reads as a new page rather than an overlay');
  assert.ok(/var\(--sab\)/.test(block), 'the last row sits under the home indicator');
  assert.ok(/#profile-modal \.sheet-grip/.test(block), 'the grip never appears');
  // …and the grip has to exist to be shown.
  assert.ok(/class="sheet-grip"/.test(html), 'there is no grip in the profile at all');
});

test('and a desktop still gets a card', () => {
  // Nothing slides up from the bottom of a laptop screen; a full-width sheet
  // there is a phone layout on the wrong device.
  const css = fs.readFileSync(path.join(ROOT, 'public', 'css', 'style.css'), 'utf8');
  const base = /\.sheet-grip \{([^}]*)\}/.exec(css);
  assert.ok(base && /display:\s*none/.test(base[1]), 'the grip shows on a desktop too');
  const card = /\.modal-card \{([^}]*)\}/.exec(css);
  assert.ok(/max-width:\s*400px/.test(card[1]), 'every modal is now full width everywhere');
});

test('the sections are spaced like the app\'s', () => {
  // 20 across, 14 down — the app's `section` style. The web had 20 all round,
  // which is a visibly looser column of the same rows.
  const css = fs.readFileSync(path.join(ROOT, 'public', 'css', 'style.css'), 'utf8');
  const sec = /\.modal-section \{([^}]*)\}/.exec(css);
  assert.ok(sec, '.modal-section is gone — this check would be vacuous');
  assert.ok(/padding:\s*14px 20px/.test(sec[1]), sec[1]);
  const rooms = fs.readFileSync(path.join(NAT, 'src', 'screens', 'RoomsScreen.tsx'), 'utf8');
  assert.ok(/section: \{ paddingHorizontal: 20, paddingVertical: 14/.test(rooms),
    'the app changed its own spacing, so this is now the drift it was meant to close');
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
