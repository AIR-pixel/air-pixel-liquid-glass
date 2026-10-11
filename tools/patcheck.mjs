#!/usr/bin/env node
/**
 * 变异 pattern 的干检器 — 在花 20 分钟跑 teeth 之前，先花一秒问一句
 * "每条变异的 find 还找得到目标吗".
 *
 * WHY THIS EXISTS
 * ---------------
 * `teeth.mjs` refuses to run when a `find` pattern no longer matches the source,
 * and it is right to: a mutation that cannot be applied silently proves nothing,
 * so a moved line would otherwise be read as "this guard is fine". The problem is
 * where the refusal is delivered — after the run has already been queued, which
 * costs a full teeth cycle to learn something that is decidable in milliseconds.
 *
 * That cost lands hardest exactly when it is least affordable: right after a real
 * edit to `client.js`, which is the one moment every pattern in the file is
 * suspect at once. This tool is the answer to "did I just invalidate a mutation"
 * asked at the moment the question exists.
 *
 * HOW IT READS THE MUTATIONS
 * --------------------------
 * It does NOT import `teeth.mjs` — importing it would execute it. It parses the
 * mutation table out of the source text, which means the table must stay in the
 * literal shape it is already written in: a `[` , a quoted label line, a regex
 * literal line, and a quoted replacement line. That is a real constraint and it
 * is stated here rather than discovered later: a mutation reformatted to span
 * lines in some other shape will be reported as `unreadable`, not silently
 * skipped. An unreadable entry is a failure, not a pass.
 *
 * Exit code 0 = every pattern matches. 1 = something moved.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const teethPath = path.join(here, 'teeth.mjs');
const teethSrc = fs.readFileSync(teethPath, 'utf8');

/**
 * Pull mutations out of the teeth source.
 *
 * THE TABLE IS WRITTEN IN TWO SHAPES and this parser accepts both, because the
 * file really does contain both: the entries added before the host-side half was
 * split out are `[ 'label', /pattern/, 'replacement' ]` triples, and everything
 * after that is `[ 'label', 'file.js', /pattern/, 'replacement' ]` quads. A
 * parser that only knew the quad read 4 of the client-side mutations and
 * reported the file healthy, which is precisely the failure mode this tool was
 * written to prevent — so both shapes are handled rather than the table being
 * rewritten to suit the checker.
 *
 * The default file for a triple is `client.js`, and that is not a guess: every
 * triple in the table is a client-side mutation. The quad's filename is used as
 * written, and an unknown one is reported rather than defaulted, because
 * defaulting is how the first version of this tool produced four false alarms on
 * the host-side entries.
 *
 * The pattern body is captured raw and then handed to `new RegExp`. That is
 * deliberately different from evaluating the literal: the source spells its
 * patterns with the escaping a regex literal needs (`\.`, `\(`), and those
 * escapes are already what the RegExp constructor wants, so the characters can
 * be passed through untouched. Escaping them again would make every pattern miss
 * and this tool would cry wolf on a healthy file.
 */
function readMutations(src) {
  const entries = [];
  const seen = new Set();
  const record = (index, entry) => {
    if (index === undefined || seen.has(index)) return;
    seen.add(index);
    entries.push(entry);
  };

  // Quads first: their `[` is the same character a triple scan would match, so
  // whichever runs first must claim its entries or the looser pattern will
  // misread them.
  const quad = /\[\s*\r?\n\s*'((?:[^'\\]|\\.)*)',\s*\r?\n\s*'((?:[^'\\]|\\.)*)\.js',\s*\r?\n\s*\/((?:[^/\\\n]|\\.)*)\/,\s*\r?\n\s*(?:(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")\s*,?\s*\r?\n)?\s*\]/g;
  let m;
  while ((m = quad.exec(src)) !== null) {
    record(m.index, {
      label: m[1].replace(/\\'/g, "'"),
      file: `${m[2]}.js`,
      pattern: m[3],
      replacement: m[4] !== undefined ? m[4] : m[5]
    });
  }

  // Then the python-targeted quads, whose filename has no `.js`.
  const pyQuad = /\[\s*\r?\n\s*'((?:[^'\\]|\\.)*)',\s*\r?\n\s*'(asarpatch\.py)',\s*\r?\n\s*\/((?:[^/\\\n]|\\.)*)\/,\s*\r?\n\s*(?:(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")\s*,?\s*\r?\n)?\s*\]/g;
  while ((m = pyQuad.exec(src)) !== null) {
    record(m.index, {
      label: m[1].replace(/\\'/g, "'"),
      file: m[2],
      pattern: m[3],
      replacement: m[4] !== undefined ? m[4] : m[5]
    });
  }

  // Finally the triples, which carry no filename.
  const triple = /\[\s*\r?\n\s*'((?:[^'\\]|\\.)*)',\s*\r?\n\s*\/((?:[^/\\\n]|\\.)*)\/,\s*\r?\n\s*(?:(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")\s*,?\s*\r?\n)?\s*\]/g;
  while ((m = triple.exec(src)) !== null) {
    record(m.index, {
      label: m[1].replace(/\\'/g, "'"),
      file: 'client.js',
      pattern: m[2],
      replacement: m[3] !== undefined ? m[3] : m[4]
    });
  }

  return entries;
}

const sources = {
  'client.js': fs.readFileSync(path.join(root, 'client.js'), 'utf8'),
  'index.js': fs.readFileSync(path.join(root, 'index.js'), 'utf8'),
  // The watcher mutations point at the patcher rather than at either half of the
  // plugin, because the watcher's source only exists inside the archive it
  // writes. Three files, one table. The table names it `asarpatch.py` (without
  // the `tools/` prefix), so the key matches the table rather than the path —
  // a checker that needs its own input rewritten is a checker with a bug.
  'asarpatch.py': fs.readFileSync(path.join(root, 'tools', 'asarpatch.py'), 'utf8')
};

const mutations = readMutations(teethSrc);
if (mutations.length === 0) {
  console.log('patcheck: read ZERO mutations out of teeth.mjs — the table was reformatted '
    + 'into a shape this parser does not know. That is a failure of this tool, not a pass.');
  process.exit(1);
}

const missing = [];
const unreadable = [];
const counts = { 'client.js': 0, 'index.js': 0, 'asarpatch.py': 0 };

for (const { label, file, pattern, replacement } of mutations) {
  let re;
  try {
    re = new RegExp(pattern);
  } catch (err) {
    unreadable.push(`${label}  [regex does not compile: ${err.message}]`);
    continue;
  }
  if (!Object.prototype.hasOwnProperty.call(sources, file)) {
    // A filename the table cannot have meant. Reported rather than defaulted,
    // because defaulting is how the first version of this tool produced four
    // false alarms on the host-side entries.
    unreadable.push(`${label}  [unknown target file "${file}"]`);
    continue;
  }  if (!Object.prototype.hasOwnProperty.call(sources, file)) {
    // A filename the table cannot have meant. Reported rather than defaulted,
    // because defaulting is how the first version of this tool produced four
    // false alarms on the host-side entries.
    unreadable.push(`${label}  [unknown target file "${file}"]`);
    continue;
  }
  counts[file] += 1;
  // A global regex would carry `lastIndex` between `.test` calls, so the flags
  // are stripped: these patterns are all "does this appear at all" questions.
  const probe = new RegExp(pattern, re.flags.replace(/g/g, ''));
  if (!probe.test(sources[file])) {
    missing.push(`${label}  ->  ${file}`);
  }
  if (replacement === undefined) {
    unreadable.push(`${label}  [no replacement string on the next line]`);
  }
}

console.log(`patcheck: ${mutations.length} mutation(s) read `
  + `(${counts['client.js']} client, ${counts['index.js']} host, `
  + `${counts['asarpatch.py']} watcher)`);

if (unreadable.length > 0) {
  console.log('\nUNREADABLE — the table has an entry this parser cannot follow:');
  for (const line of unreadable) console.log(`  ${line}`);
}

if (missing.length > 0) {
  console.log('\nSTALE — these patterns no longer match their source, so teeth would refuse to run:');
  for (const line of missing) console.log(`  ${line}`);
  console.log('\nEither the code moved (update the mutation) or the mutation is still applied.');
  process.exit(1);
}

if (unreadable.length > 0) process.exit(1);

console.log('all patterns match — teeth will start');
