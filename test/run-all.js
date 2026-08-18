// Runs every test/*.test.js.
//
// The npm script used to list the files by hand, and eight of them had fallen
// off it — scroll-fab, message-window, selection, local-search, camera-zoom,
// app-update, call-registration and room-media all existed, passed, and were
// never run by `npm test`. A test nobody runs is not a test.
//
// Each file is a separate process on purpose: they set their own environment
// (the server suite points DB_PATH at a scratch database before requiring the
// server) and they end with process.exit.
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const dir = __dirname;
// The server suite first: it is the slowest and the one most likely to fail,
// and there is no point waiting through everything else to find out.
const files = fs.readdirSync(dir).filter(f => f.endsWith('.test.js')).sort(
  (a, b) => (a === 'server.test.js' ? -1 : b === 'server.test.js' ? 1 : a.localeCompare(b)));

const failed = [];
for (const f of files) {
  console.log(`\n── ${f} ${'─'.repeat(Math.max(0, 60 - f.length))}`);
  const r = spawnSync(process.execPath, [path.join(dir, f)], { stdio: 'inherit' });
  if (r.status !== 0) failed.push(f);
}

console.log(`\n${files.length - failed.length}/${files.length} suites passed`);
if (failed.length) {
  console.error(`FAILED: ${failed.join(', ')}`);
  process.exit(1);
}
