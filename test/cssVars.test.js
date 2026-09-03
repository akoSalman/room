// Colours that were never defined.
//
// Reported with two screenshots: the comments screen on iPhone web, "totally
// broken and mixed" — a band of dark navy stitched into a light app, so the
// thread looked like a different program showing through the page.
//
// The cause is the quietest failure CSS has. I wrote
//
//     background: var(--chat-bg, #0f172a);
//
// and `--chat-bg` does not exist in this stylesheet. It never has. So every
// one of those rules silently took its fallback — and the fallbacks I had
// chosen were dark, because I wrote them from the shape of the code rather
// than from the palette at the top of the file, which is light.
//
// Nothing warns about this. Not the browser, not a linter, not a test that
// reads the rule and finds the property present. The declaration is valid, the
// page renders, and the only symptom is a colour nobody chose.
//
// It was not only mine: `--sidebar`, `--panel` and `--header` were being used
// in the same way, each one a near-miss for a variable that does exist
// (`--sidebar-bg`, `--header-bg`), each falling back to a dark value in a
// light app. This test would have caught all of them the day they were
// written.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const css = fs.readFileSync(path.join(ROOT, 'public', 'css', 'style.css'), 'utf8');
const app = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');

/**
 * Variables the stylesheet cannot define because JavaScript sets them at
 * runtime. Each one is checked below against the code that sets it, so this
 * list cannot become a place to hide a typo.
 */
const SET_BY_SCRIPT = ['--vv-top', '--vv-h'];

const tests = [];
const test = (n, f) => tests.push({ n, f });

const defined = new Set([...css.matchAll(/(--[a-z0-9-]+)\s*:/gi)].map(m => m[1]));
const used = [...new Set([...css.matchAll(/var\((--[a-z0-9-]+)/gi)].map(m => m[1]))];

test('the stylesheet actually parses into something to check', () => {
  // Without this the two checks below pass gloriously against empty sets.
  assert.ok(defined.size > 15, `only ${defined.size} variables defined`);
  assert.ok(used.length > 15, `only ${used.length} variables used`);
  assert.ok(defined.has('--accent') && defined.has('--bg'), 'the palette was not found');
});

test('THE BUG: every colour used is a colour that exists', () => {
  // A `var(--typo, #0f172a)` is not an error anywhere — it just quietly paints
  // the fallback. The fallback is then the real value, chosen by whoever was
  // least paying attention.
  const missing = used.filter(v => !defined.has(v) && !SET_BY_SCRIPT.includes(v));
  assert.deepStrictEqual(missing, [],
    `used but never defined — these silently take their fallback:\n  ${missing.join('\n  ')}`);
});

test('and the ones only JavaScript can define really are set there', () => {
  // Otherwise this list becomes the place typos go to be forgiven.
  for (const v of SET_BY_SCRIPT) {
    assert.ok(app.includes(`setProperty('${v}'`),
      `${v} is exempted as script-set, but nothing sets it`);
  }
});

test('no rule paints the comments panel a colour of its own', () => {
  // The chat area paints nothing — it shows the page. Giving the thread a
  // ground of its own is what made it look like a different app stitched in,
  // and it is the specific thing that was reported.
  const rule = /#comments-panel \{([^}]*)\}/.exec(css);
  assert.ok(rule, '#comments-panel has no rule — this check would be vacuous');
  assert.ok(/background:\s*var\(--bg\)/.test(rule[1]),
    'the panel paints itself something other than the page background');
  assert.ok(!/#0f172a/.test(rule[1]), 'the hard-coded dark navy is still there');
});

test('a defined variable has no fallback left to lie about its value', () => {
  // The fallbacks in this file were written from a dark palette; the file's
  // own palette is light. None of them applied — the variables ARE defined —
  // so they were dead code that misstated the intended colour, and the next
  // rename would have made one of them real. A var() whose name exists needs
  // no second answer.
  const dead = [...css.matchAll(/var\((--[a-z0-9-]+),[^()]*\)/g)]
    .map(m => m[1])
    .filter(v => defined.has(v));
  assert.deepStrictEqual(dead, [],
    `these carry a fallback that can never apply, and states the wrong colour:\n  ${dead.join('\n  ')}`);
});

test('…and the only fallbacks left belong to the two script-set ones', () => {
  const withFallback = [...css.matchAll(/var\((--[a-z0-9-]+),[^()]*\)/g)].map(m => m[1]);
  for (const v of withFallback) {
    assert.ok(SET_BY_SCRIPT.includes(v),
      `${v} has a fallback but is not one of the variables JavaScript sets`);
  }
  // Those two MUST keep theirs: a browser without visualViewport never gets a
  // value, and a page with no height is not a page.
  assert.ok(/var\(--vv-h,\s*100%\)/.test(css),
    'the app has no height on a browser that never sets --vv-h');
});

test('the pinned message cannot eat the screen when the keyboard is up', () => {
  // 40% of a full screen is context; 40% of what is left with a keyboard open
  // is the whole thread, and with a photo at the top there was nowhere for the
  // comments to be. That is the other half of what the screenshots showed.
  const rule = /\.comments-parent \{([^}]*)\}/.exec(css);
  assert.ok(rule, '.comments-parent has no rule — this check would be vacuous');
  assert.ok(/max-height:\s*min\(38%, 190px\)/.test(rule[1]),
    'the pinned message is capped only as a fraction, so a short screen is all header');
  assert.ok(/overflow-y:\s*auto/.test(rule[1]), 'a long pinned message cannot be read at all');
});

test('the redesign did not leave two rules for the same thing', () => {
  // A duplicate `.comments-parent` survived the rewrite and silently won on
  // padding, which is its own small way of making a screen unpredictable.
  for (const sel of ['.comments-parent', '#comments-panel', '.comments-list', '.comment-bar-btn']) {
    const n = (css.match(new RegExp(sel.replace('.', '\\.') + '\\s*\\{', 'g')) || []).length;
    assert.strictEqual(n, 1, `${sel} is defined ${n} times`);
  }
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
