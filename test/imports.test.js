// Every name imported from our own modules actually exists there.
//
// Reported as a crash, on a real phone, in a shipped build:
//
//     undefined is not a function
//       at renderMessage (index.android.bundle:1:1630548)
//       at MemoRow …
//
// ChatScreen imported `formatUpdated` from '../geo'. formatUpdated is in
// locationPick. geo has never had it. So the import was `undefined`, and the
// live-location card called it while drawing a message — every render of that
// card threw, and the row took the list down with it.
//
// It was wrong in the commit that introduced it, which wrote the function into
// one module and imported it from the other, and it stayed wrong through every
// build after. Three things that should have caught it did not:
//
//   • there is no tsconfig.json in native-app, so nothing typechecks the app.
//     tsc is in node_modules and the tests use it, but only on single files;
//   • the tests compile the modules they exercise ONE AT A TIME, with
//     --skipLibCheck, so a module is only ever asked whether it is internally
//     consistent, never whether its callers agree with it;
//   • the test written for that very feature asserted the CALL was present in
//     ChatScreen's text — /formatUpdated\(p\.updatedAt/ — which it was. Text
//     being present says nothing about the name resolving. That assertion
//     passed for four weeks over a function that could not be called.
//
// So this reads every import in the app and checks it against what the module
// it names actually exports. It is the cheap half of a typechecker, aimed at
// the one mistake that cannot be seen by reading either file on its own.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'native-app', 'src');
const APP = path.join(__dirname, '..', 'native-app');
let parser, traverse;
try {
  parser = require(path.join(APP, 'node_modules', '@babel', 'parser'));
  traverse = require(path.join(APP, 'node_modules', '@babel', 'traverse'));
  traverse = traverse.default || traverse;
} catch {
  console.log('  ! skipping import checks (native-app deps not installed)');
  process.exit(0);
}

const tests = [];
const test = (n, f) => tests.push({ n, f });

/** Every .ts/.tsx under native-app/src, plus the app's own entry points. */
function sources(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) sources(p, out);
    else if (/\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}
const FILES = [...sources(SRC), path.join(APP, 'App.tsx')].filter(f => fs.existsSync(f));

const astCache = new Map();
function ast(file) {
  if (!astCache.has(file)) {
    astCache.set(file, parser.parse(fs.readFileSync(file, 'utf8'), {
      sourceType: 'module', plugins: ['typescript', 'jsx'],
    }));
  }
  return astCache.get(file);
}

/** Where a relative import points, trying the extensions Metro would. */
function resolve(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const c of [
    base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.jsx`, `${base}.json`,
    path.join(base, 'index.ts'), path.join(base, 'index.tsx'), path.join(base, 'index.js'),
  ]) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  return null;
}

/**
 * The names a module exports, following `export * from` into other modules of
 * ours. Types count: they are erased, so importing one is not a runtime
 * mistake, and telling a type from a value is the part this is not trying to
 * do.
 */
function exportsOf(file, seen = new Set()) {
  if (seen.has(file)) return new Set();
  seen.add(file);
  const names = new Set();
  if (!/\.tsx?$/.test(file)) return names;          // .json and friends: assume fine
  for (const n of ast(file).program.body) {
    if (n.type === 'ExportDefaultDeclaration') names.add('default');
    else if (n.type === 'ExportAllDeclaration') {
      if (n.exported) names.add(n.exported.name);   // export * as ns from …
      else if (n.source.value.startsWith('.')) {
        const t = resolve(file, n.source.value);
        if (t) for (const x of exportsOf(t, seen)) names.add(x);
      } else names.add('*');                        // re-exports a package: unknowable
    } else if (n.type === 'ExportNamedDeclaration') {
      for (const sp of n.specifiers || []) {
        names.add(sp.exported.name || sp.exported.value);
      }
      const d = n.declaration;
      if (!d) continue;
      if (d.type === 'VariableDeclaration') {
        for (const decl of d.declarations) {
          if (decl.id.type === 'Identifier') names.add(decl.id.name);
          else if (decl.id.type === 'ObjectPattern') {
            for (const p of decl.id.properties) {
              if (p.type === 'ObjectProperty' && p.value.type === 'Identifier') {
                names.add(p.value.name);
              }
            }
          }
        }
      } else if (d.id && d.id.name) names.add(d.id.name);
    }
  }
  return names;
}

/**
 * Namespace imports of our own modules, and every `ns.member` read off them.
 *
 * `import * as pick from '../locationPick'` then `pick.formatUpdated(…)` fails
 * in precisely the same way as a bad named import — undefined, then a crash on
 * the call — and this app reaches for namespaces for its rule modules, so the
 * named-import check alone would leave most of those uses unexamined.
 */
function namespaceUses(file) {
  // Scope analysis, not a regex over the text. The regex version of this
  // reported twenty-three faults and every one was false: it read `pick.id`
  // off a local named `pick`, `win.width` off a local named `win`, and
  // `connection.ts` out of a COMMENT mentioning a filename. A check that
  // cries wolf twenty-three times is worse than no check, because the next
  // person turns it off — which is the same mechanism that let the real bug
  // live for weeks. So each name is resolved to the binding it actually
  // refers to, and only the ones that really are the import are examined.
  const out = [];
  const nsByName = new Map();
  for (const n of ast(file).program.body) {
    if (n.type !== 'ImportDeclaration' || !n.source.value.startsWith('.')) continue;
    if (n.importKind === 'type') continue;
    for (const sp of n.specifiers) {
      if (sp.type === 'ImportNamespaceSpecifier') nsByName.set(sp.local.name, n.source.value);
    }
  }
  if (!nsByName.size) return out;
  traverse(ast(file), {
    MemberExpression(p) {
      const { object, property, computed } = p.node;
      if (computed || object.type !== 'Identifier' || property.type !== 'Identifier') return;
      const spec = nsByName.get(object.name);
      if (!spec) return;
      // Does this `pick` mean the import, or a local that shadows it?
      const binding = p.scope.getBinding(object.name);
      if (!binding || binding.kind !== 'module') return;
      // A type position (pick.Fix in an annotation) is erased, like a type
      // import, so it is not a call waiting to fail.
      if (p.findParent(q => q.isTSTypeReference() || q.isTSTypeAnnotation())) return;
      out.push({ spec, ns: object.name, name: property.name, line: p.node.loc.start.line });
    },
  });
  return out;
}

/** Every name this file imports from one of our own modules. */
function localImports(file) {
  const out = [];
  for (const n of ast(file).program.body) {
    if (n.type !== 'ImportDeclaration') continue;
    if (!n.source.value.startsWith('.')) continue;
    if (n.importKind === 'type') continue;          // `import type {…}` is erased
    for (const sp of n.specifiers) {
      if (sp.type === 'ImportSpecifier') {
        if (sp.importKind === 'type') continue;     // `import { type X }`
        out.push({ spec: n.source.value, name: sp.imported.name || sp.imported.value, line: sp.loc.start.line });
      } else if (sp.type === 'ImportDefaultSpecifier') {
        out.push({ spec: n.source.value, name: 'default', line: sp.loc.start.line });
      }
      // A namespace import takes whatever is there; nothing to check.
    }
  }
  return out;
}

const rel = f => path.relative(path.join(__dirname, '..'), f);

// ── The check ───────────────────────────────────────────────────────────────

test('THE BUG: every name imported from our own code is exported by it', () => {
  const broken = [];
  for (const file of FILES) {
    for (const imp of localImports(file)) {
      const target = resolve(file, imp.spec);
      if (!target) continue;                        // reported by the next test
      const names = exportsOf(target);
      if (names.has('*')) continue;                 // re-exports a package wholesale
      if (!names.has(imp.name)) {
        broken.push(`${rel(file)}:${imp.line} imports { ${imp.name} } `
          + `from '${imp.spec}', which does not export it`);
      }
    }
  }
  assert.deepStrictEqual(broken, [],
    `\n      ${broken.join('\n      ')}\n      `
    + '\n      Each of these is `undefined` at runtime, and a crash the moment it is called.');
});

test('…including the ones read off a namespace import', () => {
  const broken = [];
  for (const file of FILES) {
    for (const use of namespaceUses(file)) {
      const target = resolve(file, use.spec);
      if (!target) continue;
      const names = exportsOf(target);
      if (names.has('*')) continue;
      if (!names.has(use.name)) {
        broken.push(`${rel(file)}:${use.line} reads ${use.ns}.${use.name}, `
          + `but '${use.spec}' does not export ${use.name}`);
      }
    }
  }
  assert.deepStrictEqual(broken, [],
    `\n      ${broken.join('\n      ')}\n      `
    + '\n      Either the name is wrong, or a local of the same name is shadowing the'
    + '\n      module — and a reader cannot tell which, which is the other half of the bug.');
});

test('…and every module they import from is actually there', () => {
  const missing = [];
  for (const file of FILES) {
    for (const n of ast(file).program.body) {
      const src = (n.type === 'ImportDeclaration' || n.type === 'ExportAllDeclaration'
        || (n.type === 'ExportNamedDeclaration' && n.source)) ? n.source : null;
      if (!src || !src.value.startsWith('.')) continue;
      if (!resolve(file, src.value)) {
        missing.push(`${rel(file)}:${src.loc.start.line} imports from '${src.value}', which is not a file`);
      }
    }
  }
  assert.deepStrictEqual(missing, [], `\n      ${missing.join('\n      ')}\n      `);
});

// ── The instrument, checked before its answer is used ───────────────────────
//
// A checker that cannot fail is worth nothing, and this one reports a clean
// bill of health by doing nothing at all if its file walk or its parse is
// wrong. So it is made to find a fault that is definitely there.

test('the checker finds a bad import when there is one', () => {
  const planted = path.join(SRC, '__import_check_probe__.ts');
  fs.writeFileSync(planted, "import { thisIsNotExported } from './geo';\nexport const x = thisIsNotExported;\n");
  try {
    astCache.delete(planted);
    const imports = localImports(planted);
    assert.strictEqual(imports.length, 1, 'the probe\'s import was not even read');
    const names = exportsOf(resolve(planted, './geo'));
    assert.ok(!names.has('thisIsNotExported'), 'the checker thinks a made-up name is exported');
    // And the real thing is found, so the walk above is reading geo properly.
    assert.ok(names.has('tilesForViewport'), 'the checker cannot see exports that ARE there');
  } finally {
    fs.rmSync(planted, { force: true });
  }
});

test('the checker is looking at the whole app, not at nothing', () => {
  // A walk that silently found no files would pass every assertion above.
  assert.ok(FILES.length > 40, `only ${FILES.length} source files found — the walk is wrong`);
  assert.ok(FILES.some(f => /ChatScreen\.tsx$/.test(f)), 'the biggest screen is not being read');
  const all = FILES.flatMap(localImports);
  assert.ok(all.length > 100, `only ${all.length} local imports found — the parse is wrong`);
  assert.ok(all.some(i => i.name === 'default'), 'default imports are not being checked');
  // The namespace half passes with nothing to report, which is also what a
  // filter that throws everything away looks like. So: it has to still be
  // seeing real uses, including the one this whole file is about.
  const ns = FILES.flatMap(namespaceUses);
  assert.ok(ns.length > 30, `only ${ns.length} namespace uses found — the scope walk is dropping them`);
  assert.ok(ns.some(u => u.ns === 'pick' && u.name === 'formatUpdated'),
    'the call that crashed the app is not among the names being checked');
  assert.ok(ns.some(u => u.ns === 'pick' && u.name === 'locationPayload'),
    'namespace calls in general are not being checked');
});

test('the namespace checker catches a member that is not there', () => {
  const probe = path.join(SRC, '__ns_check_probe__.ts');
  fs.writeFileSync(probe,
    "import * as g from './geo';\n"
    + 'export const a = g.tilesForViewport;\n'
    + 'export const b = g.noSuchExport;\n'
    // The two things the regex version got wrong, which must stay quiet: a
    // local that shadows the namespace, and a filename inside a comment.
    + 'export function f() { const g = { shadowed: 1 }; return g.shadowed; }\n'
    + '// see geo.ts and g.somethingInAComment for details\n');
  try {
    astCache.delete(probe);
    const found = namespaceUses(probe).map(u => u.name);
    assert.ok(found.includes('noSuchExport'), 'a bad namespace member is not even seen');
    assert.ok(found.includes('tilesForViewport'), 'good namespace members are not seen either');
    assert.ok(!found.includes('shadowed'), 'a local shadowing the namespace is being misread');
    assert.ok(!found.includes('somethingInAComment'), 'comments are being read as code');
    const names = exportsOf(resolve(probe, './geo'));
    assert.ok(!names.has('noSuchExport'), 'the export list is wrong');
  } finally {
    fs.rmSync(probe, { force: true });
  }
});

test('a type-only import is not reported, because it is erased', () => {
  // `import { type LatLng } from '../geo'` and `import type {…}` never exist
  // at runtime, so they are not crashes waiting to happen — and treating them
  // as such would bury the real findings in noise.
  const probe = path.join(SRC, '__import_check_probe2__.ts');
  fs.writeFileSync(probe,
    "import type { Whatever } from './geo';\nimport { type AlsoNot } from './geo';\n"
    + 'export type A = Whatever; export type B = AlsoNot;\n');
  try {
    astCache.delete(probe);
    assert.deepStrictEqual(localImports(probe), [],
      'type-only imports are being treated as runtime names');
  } finally {
    fs.rmSync(probe, { force: true });
  }
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
