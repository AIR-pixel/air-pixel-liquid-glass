/**
 * Parse every source with Node's own parser, before anything renders.
 *
 * This exists because one specific mistake has now cost three separate
 * render cycles: writing a backtick inside a comment that itself lives inside a
 * template literal. The parser closes the template at that backtick and reports
 * the next word as an unexpected identifier, tens of lines away from the comment
 * that caused it — and if the file is `client.js` or a browser-side tool, the
 * only way to notice is to boot a browser and watch it fail, which is minutes
 * per attempt.
 *
 * A syntax check is free. Run it first.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const NODE = process.execPath;

// `_client.backup.js` is teeth.mjs's pristine copy, written for the duration of
// a run and deleted by its restore. Including it made this tool's file count
// depend on whether a mutation run happened to be in flight — 18 or 19 — and a
// count that moves on its own is a count nobody reads. Excluded by exact name
// rather than by the leading underscore, because `_peek_main.js` is a real
// target and shares that prefix.
const TRANSIENT = new Set(['_client.backup.js']);

const targets = [
  'client.js',
  'index.js',
  ...fs
    .readdirSync(path.join(ROOT, 'tools'))
    .filter((name) => (name.endsWith('.js') || name.endsWith('.mjs')) && !TRANSIENT.has(name))
    .map((name) => path.join('tools', name))
];

// The material probe's app is the one source in this tree that does not sit
// directly in tools/, and it is the one that most needs this check: it is
// launched as a black box by materialprobe.py, so a syntax error inside it
// surfaces as "probe never reached ready" with no file, no line and no
// message — the same shape of dead end this tool was written to remove.
const PROBE_APP = path.join('tools', '_probe', 'resources', 'app');
const probeAppDir = path.join(ROOT, PROBE_APP);
if (fs.existsSync(probeAppDir)) {
  for (const name of fs.readdirSync(probeAppDir).filter((n) => n.endsWith('.js'))) {
    targets.push(path.join(PROBE_APP, name));
  }
}

let bad = 0;
for (const rel of targets) {
  const file = path.join(ROOT, rel);
  try {
    execFileSync(NODE, ['--check', file], { stdio: ['ignore', 'pipe', 'pipe'] });
    console.log(`  [ok  ] ${rel}`);
  } catch (error) {
    bad += 1;
    const text = String(error.stderr ?? '');
    // Node prints the offending source line, a caret and the message. Keep the
    // message and the line that carries the caret — the rest is stack noise.
    const message = (text.match(/^[A-Za-z]*Error: .*$/m) ?? ['(no message)'])[0];
    const where = (text.match(/^(.+?):(\d+)$/m) ?? [])[0] ?? '(no line reported)';
    console.log(`  [FAIL] ${rel}`);
    console.log(`         ${message}`);
    console.log(`         near ${where}`);
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i].includes('^^^^')) {
        console.log(`         ${lines[i - 1]?.slice(0, 110) ?? ''}`);
        console.log(`         ${lines[i].slice(0, 110)}`);
        break;
      }
    }
    if (/Unexpected identifier|Invalid or unexpected token|Unterminated/.test(message)) {
      console.log('         hint: a backtick or ${ inside a comment that lives in a template literal');
    }
  }
}

console.log('');
console.log(bad === 0 ? `${targets.length} file(s) parse` : `${bad} file(s) do not parse`);
process.exitCode = bad === 0 ? 0 : 1;
