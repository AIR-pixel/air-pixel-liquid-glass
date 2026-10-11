// Is any mutation's replacement sitting in a shipped source file?
//
// This is the one failure teeth.mjs cannot see about itself. A mutation that
// rewrites a line usually leaves the surrounding text intact, so the `find`
// pattern still matches and the start-up check waves it through; and if the run
// that applied it died before its cleanup, the NEXT run reads the dirty file as
// pristine and "restores" it — byte-compare against its own start-up copy
// cannot tell. Both doors are shut, which is how `client.js` came to ship with
//
//     const end = band[1];
//
// instead of the reveal-aware endpoint, for an unknown number of runs: the app
// canvas stopped reaching 0 at full strength, so the material sat behind a grey
// film and 透出桌面 quietly did nothing at the top of the slider.
//
// It was found by chasing a red assertion (`the window base tier closes
// completely, and only it`) whose failure message said `0.03 vs 0.03` — which
// read like a typo in the test, and was in fact a real bug in the source. Both
// were true; the assertion had a second typo of its own, and the source had
// this. Run this tool before trusting either.
//
//   node tools/mutationaudit.mjs
//
// Exit 0 = clean, 1 = at least one file carries a mutation.
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');

function mutationsFrom(teethSource) {
  const start = teethSource.indexOf('const MUTATIONS = [');
  if (start === -1) return null;
  // Walk to the bracket that closes the array literal.
  let depth = 0;
  for (let i = teethSource.indexOf('[', start); i < teethSource.length; i += 1) {
    if (teethSource[i] === '[') depth += 1;
    else if (teethSource[i] === ']') {
      depth -= 1;
      if (depth === 0) return new Function(`return ${teethSource.slice(teethSource.indexOf('[', start), i + 1)};`)();
    }
  }
  return null;
}

/**
 * @returns {{ok: boolean, dirty: Array<{file: string, label: string, replace: string}>, reason?: string}}
 */
export function auditMutations() {
  const teeth = fs.readFileSync(path.join(ROOT, 'tools', 'teeth.mjs'), 'utf8');
  const MUTATIONS = mutationsFrom(teeth);
  if (MUTATIONS === null) return { ok: false, dirty: [], reason: 'could not parse MUTATIONS out of teeth.mjs' };

  const files = {
    'client.js': path.join(ROOT, 'client.js'),
    'index.js': path.join(ROOT, 'index.js'),
    'asarpatch.py': path.join(ROOT, 'tools', 'asarpatch.py')
  };
  const sources = {};
  for (const [name, file] of Object.entries(files)) sources[name] = fs.readFileSync(file, 'utf8');

  const dirty = [];
  for (const mutation of MUTATIONS) {
    const [label, fileName, find, replace] =
      mutation.length === 4 ? mutation : [mutation[0], 'client.js', mutation[1], mutation[2]];
    const src = sources[fileName];
    if (src === undefined) continue;
    // The test is deliberately NOT "does the replace string appear" — that
    // question has no good answer for the many replacements that are short
    // (`const end = band[1];` is 21 characters) or that are a suffix of the
    // find pattern (the correct code ends with the replaced text). Both of
    // those rules were tried, and both let the real bug through: this tool
    // reported "clean" against a client.js with the mutation re-planted.
    //
    // The question that does have a good answer is about the FIND pattern,
    // which is the thing the mutation destroys. If `find` no longer matches but
    // `replace` does, the file is in the mutated state. That is the same
    // predicate teeth.mjs uses at start-up — the difference being that teeth
    // tests the file it just read as pristine and accepts "no match" as "the
    // code moved", while here "no match" is the finding.
    if (replace === '') continue;
    if (!(find instanceof RegExp)) continue;
    const stillPristine = find.test(src);
    const looksMutated = src.includes(replace);
    if (!stillPristine && looksMutated) {
      dirty.push({ file: fileName, label, replace });
    }
  }
  return { ok: dirty.length === 0, dirty };
}

if (import.meta.filename === process.argv[1]) {
  const { ok, dirty, reason } = auditMutations();
  if (reason) {
    console.log(reason);
    process.exit(1);
  }
  for (const hit of dirty) {
    console.log(`DIRTY  ${hit.file}  <- ${hit.label}`);
    console.log(`       present in the source: ${JSON.stringify(hit.replace.slice(0, 90))}`);
  }
  console.log(
    ok
      ? 'clean — no mutation is baked into a source file'
      : `\n${dirty.length} file location(s) carry a mutation. Restore the source, then re-run teeth.`
  );
  process.exit(ok ? 0 : 1);
}
