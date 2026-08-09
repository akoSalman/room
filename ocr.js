// ── Image text recognition (OCR) ─────────────────────────────────────────────
//
// Runs server-side rather than on the device, because Persian support is a hard
// requirement: Google's on-device ML Kit text recogniser covers only Latin,
// Chinese, Devanagari, Japanese and Korean — no Arabic script. Tesseract does
// support Persian, and tesseract.js is pure WASM (no native build step), so it
// installs cleanly on the app servers.
//
// Two things learned from measuring this before shipping:
//   • Recognising Persian with the language set ['fas','eng'] CORRUPTS it —
//     English competes for glyphs and "دنیا" came back as "Ls". Running each
//     language as its own pass and keeping the higher-confidence result reads
//     both Persian and English correctly.
//   • The traineddata is vendored as npm deps instead of being pulled from
//     jsDelivr at request time, so recognition never depends on a CDN.
const path = require('path');
const fs = require('fs');

const LANGS = ['fas', 'eng'];

// Where the *.traineddata.gz files live. Populated from the
// @tesseract.js-data/* packages at install time (see ensureLangPath).
const LANG_DIR = process.env.OCR_LANG_PATH || path.join(__dirname, 'ocr-lang');

let workersPromise = null;   // lazily created, then reused for the process
let queue = Promise.resolve(); // serialises jobs: OCR is memory hungry

function ensureLangPath() {
  fs.mkdirSync(LANG_DIR, { recursive: true });
  for (const lang of LANGS) {
    const dest = path.join(LANG_DIR, `${lang}.traineddata.gz`);
    if (fs.existsSync(dest)) continue;
    // Copy out of the installed data package.
    for (const variant of ['4.0.0_best_int', '4.0.0']) {
      const src = path.join(__dirname, 'node_modules', '@tesseract.js-data', lang, variant, `${lang}.traineddata.gz`);
      if (fs.existsSync(src)) { fs.copyFileSync(src, dest); break; }
    }
  }
}

async function getWorkers() {
  if (workersPromise) return workersPromise;
  workersPromise = (async () => {
    ensureLangPath();
    const { createWorker } = require('tesseract.js');
    // One worker per language — see the note above about mixed language sets.
    return Promise.all(LANGS.map(lang =>
      createWorker([lang], 1, { langPath: LANG_DIR, gzip: true, cacheMethod: 'none' })
    ));
  })().catch(err => {
    workersPromise = null; // let a later request retry
    throw err;
  });
  return workersPromise;
}

// Recognise `imagePath`, returning the best-scoring language pass.
// Jobs are queued so concurrent requests can't exhaust memory.
function recognise(imagePath) {
  const job = queue.then(async () => {
    const workers = await getWorkers();
    const results = await Promise.all(workers.map(async (w, i) => {
      try {
        const { data } = await w.recognize(imagePath);
        return { lang: LANGS[i], text: (data.text || '').trim(), confidence: data.confidence || 0 };
      } catch {
        return { lang: LANGS[i], text: '', confidence: -1 };
      }
    }));
    // Highest confidence wins; an empty result never beats a non-empty one.
    results.sort((a, b) => (b.text ? b.confidence : -1) - (a.text ? a.confidence : -1));
    return results[0] || { lang: null, text: '', confidence: 0 };
  });
  // Keep the chain alive even if this job rejects.
  queue = job.then(() => {}, () => {});
  return job;
}

async function shutdown() {
  if (!workersPromise) return;
  try {
    const workers = await workersPromise;
    await Promise.all(workers.map(w => w.terminate()));
  } catch {}
  workersPromise = null;
}

module.exports = { recognise, shutdown, LANGS, LANG_DIR };
