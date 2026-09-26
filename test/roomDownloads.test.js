// ── The room owner decides whether media can be saved ──────────────────────
//
// Asked for: "add control of downloading media in private rooms to room admin
// in room info page; if download is allowed then add download to both message
// menu and opened image 3 dot menu".
//
// Worth being plain about what this is, because the tests below encode it.
// To show somebody a photo you must send them the photo, and once their phone
// has the bytes a screenshot remains possible. This removes the BUTTON, which
// stops the casual case — the tap that puts a picture in a camera roll without
// a thought. It is a sign on a door, not a lock, and there is deliberately no
// server-side enforcement because there is nothing honest to build: a photo is
// fetched from the same signed URL whether it is being displayed or saved, so
// a server that refused the save would refuse the view with it.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const R = require(path.join(ROOT, 'roomDownloads.js'));

const tests = [];
const test = (n, f) => tests.push({ n, f });

test('A ROOM WITH NO SETTING IS OPEN', () => {
  // Every room on the server predates this column. Reading "unknown" as
  // forbidden would have taken the download button away from every chat the
  // moment it shipped — a silent, server-wide change nobody asked for.
  assert.strictEqual(R.downloadsAllowed({}), true);
  assert.strictEqual(R.downloadsAllowed({ downloads_allowed: null }), true);
  assert.strictEqual(R.downloadsAllowed({ downloads_allowed: undefined }), true);
  assert.strictEqual(R.downloadsAllowed(null), true);
  assert.strictEqual(R.downloadsAllowed(), true);
});

test('…and every way of saying "no" means no', () => {
  // SQLite returns 0 and 1, JSON returns true and false, an older client may
  // send the string. All three reach this function.
  for (const v of [0, '0', false]) {
    assert.strictEqual(R.downloadsAllowed({ downloads_allowed: v }), false, JSON.stringify(v));
  }
  for (const v of [1, '1', true]) {
    assert.strictEqual(R.downloadsAllowed({ downloads_allowed: v }), true, JSON.stringify(v));
  }
});

test('ONLY THE OWNER MAY CHANGE IT', () => {
  const room = { id: 5, created_by: 7 };
  assert.strictEqual(R.canChangeDownloads({ room, userId: 7 }), true);
  assert.strictEqual(R.canChangeDownloads({ room, userId: 8 }), false);
  // Strings, because ids arrive from JSON as often as from SQLite.
  assert.strictEqual(R.canChangeDownloads({ room, userId: '7' }), true);
});

test('…unlike the settings beside it, and on purpose', () => {
  // Disappearing and one-time may be changed by EITHER side, because they
  // protect the person receiving the messages. This one restricts what
  // members may do with somebody else's pictures, which is the owner's call
  // about their own room.
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const i = server.indexOf("socket.on('set_downloads_allowed'");
  assert.ok(i > 0, 'nothing serves the setting');
  const body = server.slice(i, server.indexOf('\n  });', i));
  assert.ok(/canChangeDownloads/.test(body), 'anybody in the room can change the owner\'s rule');
  assert.ok(/isRoomMember/.test(body) === false,
    'the membership check has replaced the owner check');
});

test('A DM HAS NO OWNER, so it is not offered there', () => {
  // Two people and neither is in charge. Offering one of them a switch over
  // the other's saving would be a small piece of nonsense.
  assert.strictEqual(R.canChangeDownloads({ room: { is_dm: 1, created_by: 7 }, userId: 7 }), false);
});

test('nonsense never grants the power to change it', () => {
  for (const o of [{}, undefined, { room: {} }, { room: { created_by: null }, userId: 7 },
                   { room: { created_by: 7 } }, { room: { created_by: 'x' }, userId: 'x' }]) {
    assert.strictEqual(R.canChangeDownloads(o), false, JSON.stringify(o));
  }
});

test('THE BUTTON FOLLOWS THE SETTING', () => {
  const open = { id: 1 };
  const shut = { id: 1, downloads_allowed: 0 };
  assert.strictEqual(R.showDownload({ room: open, hasFile: true }), true);
  assert.strictEqual(R.showDownload({ room: shut, hasFile: true }), false);
  // Nothing to download is nothing to offer.
  assert.strictEqual(R.showDownload({ room: open, hasFile: false }), false);
});

test('ONE-TIME MEDIA OUTRANKS THE ROOM', () => {
  // That is the message's own promise to its sender, and a room setting must
  // not be able to override it in either direction.
  assert.strictEqual(R.showDownload({ room: { id: 1 }, hasFile: true, oneTime: true }), false);
});

test('SENDING IT IS NOT AN EXCEPTION', () => {
  // Somebody who sent a photo already has it; offering them a download in a
  // room where nobody else gets one only makes the rule look arbitrary from
  // the other side. There is no `mine` parameter, and that is the point.
  assert.strictEqual(R.showDownload({ room: { downloads_allowed: 0 }, hasFile: true, mine: true }), false);
});

// ── The wiring ──────────────────────────────────────────────────────────────

const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const chat = fs.readFileSync(path.join(ROOT, 'native-app', 'src', 'screens', 'ChatScreen.tsx'), 'utf8');
const chatCode = chat.split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');

test('THE COLUMN EXISTS, and is added to rooms that predate it', () => {
  const db = fs.readFileSync(path.join(ROOT, 'db.js'), 'utf8');
  assert.ok(/ALTER TABLE rooms ADD COLUMN downloads_allowed/.test(db),
    'existing rooms have nowhere to record the setting');
});

test('THE ROOM INFO PAGE CARRIES IT, both the value and the right to change it', () => {
  assert.ok(/downloads_allowed: roomDownloads\.downloadsAllowed\(room\)/.test(server));
  assert.ok(/can_change_downloads: roomDownloads\.canChangeDownloads/.test(server),
    'the client is left to decide for itself who the owner is');
});

test('EVERY MEMBER IS TOLD WHEN IT CHANGES', () => {
  // Not just those with the chat open: the menu entry has to appear and
  // disappear on every member's phone, not at their next open.
  const i = server.indexOf("socket.on('set_downloads_allowed'");
  const body = server.slice(i, server.indexOf('\n  });', i));
  assert.ok(/getRoomMemberIds\(room\)\.forEach/.test(body), 'only the open chats are told');
  assert.ok(/downloads_changed/.test(body));
  assert.ok(/insertSystemMessage/.test(body),
    'the rule changes with no trace in the chat, so nobody knows who changed it');
});

test('BOTH MENUS ARE GATED — the message one and the opened photo', () => {
  // Named in the request, and the second is the one that would have been
  // forgotten: it is a different menu built from a different array.
  const i = chatCode.indexOf('label="Download"');
  assert.ok(i > 0, 'the message menu no longer offers a download');
  const line = chatCode.slice(chatCode.lastIndexOf('{', i), i);
  assert.ok(/downloadsAllowed/.test(line), 'the message menu ignores the room setting');

  const j = chatCode.indexOf("'download-outline', 'Download'");
  assert.ok(j > 0, 'the opened photo no longer offers a download');
  const around = chatCode.slice(j - 300, j);
  assert.ok(/downloadsAllowed/.test(around), 'the opened photo ignores the room setting');
  // Share too: handing the file to another app is the same act by a different
  // route, and leaving it would make the setting a formality.
  const k = chatCode.indexOf("'share-outline', 'Share'");
  assert.ok(/downloadsAllowed/.test(chatCode.slice(k - 300, k)),
    'Share is still offered, which saves the photo by another name');
});

test('THE SCREEN KEEPS UP, without being reopened', () => {
  assert.ok(/sock\.on\('downloads_changed'/.test(chatCode), 'the setting is read once and never again');
  assert.ok(/sock\.off\('downloads_changed'/.test(chatCode),
    'the listener is never removed, which is how one screen ends up with five');
  assert.ok(/setCanChangeDownloads\(!!info\.can_change_downloads\)/.test(chatCode));
});

test('THE TOGGLE IS THERE, and says what it cannot do', () => {
  // An admin told "members cannot save media" will believe exactly that
  // unless the screen says otherwise, and then be angry at the wrong thing.
  assert.ok(/SAVING MEDIA/.test(chatCode), 'there is no control on the room info page');
  assert.ok(/chooseDownloadsAllowed/.test(chatCode), 'the control changes nothing');
  assert.ok(/does not stop screenshots/i.test(chat),
    'the setting promises more than it can deliver');
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
