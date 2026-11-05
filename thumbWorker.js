// The thumbnail job itself, run on a worker thread and never on the main one.
//
// This is pure JavaScript doing what a native library would do, and on the
// machine it is for that measured 3.6 seconds for a 4000x3000 photo. Three
// and a half seconds on the event loop would stall every socket on the
// server: no messages delivered, no calls signalled, no presence, for the
// whole of it. A chat server cannot spend that in a request handler, which is
// why this file exists separately rather than being a function in the route.
//
// Nothing here talks to the database, the socket or the request. It is given
// a path in and writes a file out.
const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const path = require('path');
const jpeg = require('jpeg-js');
const thumbScale = require('./thumbScale');

function run({ src, out, size, quality }) {
  const raw = fs.readFileSync(src);
  // maxMemoryUsageInMB caps what a malformed or hostile JPEG can make the
  // decoder allocate. Without it a crafted header can ask for gigabytes, and
  // this runs on whatever anybody uploads.
  const img = jpeg.decode(raw, { useTArray: true, maxMemoryUsageInMB: 256 });
  const scaled = thumbScale.squareThumb(img.data, img.width, img.height, size);
  if (!scaled) throw new Error('could not scale');
  const encoded = jpeg.encode({ data: scaled, width: size, height: size }, quality);
  // Written beside the target and renamed, so a reader never opens a file
  // that is still being written. Two workers racing on one name is survivable
  // because rename is atomic and both produce identical bytes.
  const tmp = out + '.' + process.pid + '.tmp';
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(tmp, encoded.data);
  fs.renameSync(tmp, out);
  return encoded.data.length;
}

try {
  const bytes = run(workerData);
  parentPort.postMessage({ ok: true, bytes });
} catch (err) {
  parentPort.postMessage({ ok: false, error: String((err && err.message) || err) });
}
