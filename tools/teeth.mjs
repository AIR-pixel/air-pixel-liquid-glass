/**
 * Temporarily neuter one guard, run the suite, report the failures, restore.
 *
 * A guard that cannot fail is documentation, not a test. Every claim made about
 * 透出桌面 in the README is backed by an assertion here only if deleting the
 * code that makes the claim true actually turns the suite red.
 *
 * Find strings are written as regexes with `\r?\n` because client.js and
 * index.js are CRLF. `asarpatch.py` is LF, so `\r?\n` matches there too and its
 * replacements must be written with a bare `\n`.
 *
 * RESTORING IS THE HARD PART. This tool edits the real `client.js` in place, so
 * a `finally` is the only thing standing between a mutation and a shipped source
 * file — and `finally` does not run when the process is killed. That is not
 * hypothetical: a run that hit the 120s foreground timeout was terminated
 * mid-loop and left `client.js` at `const live = false`, after which the next
 * run reported "pattern not present, cannot test" for that very guard and the
 * suite stayed green. So the pristine copy is also written to disk first, and
 * SIGINT/SIGTERM/`exit` all restore from it. If a `_<name>.backup` is ever found
 * next to this file, the previous run died and the source may be dirty.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const NODE = process.execPath;
const TARGETS = {
  'client.js': path.join(import.meta.dirname, '..', 'client.js'),
  'index.js': path.join(import.meta.dirname, '..', 'index.js'),
  // The watcher is a third source now, and it is the one that runs inside the
  // client: it is grafted into app.asar by asarpatch.py and executed by
  // Electron's main process, so nothing imports it and until now the only thing
  // that could be said about it was that it parses. verify.mjs executes it
  // against a fake Electron, which makes it mutable — and therefore testable —
  // like any other source here.
  'asarpatch.py': path.join(import.meta.dirname, 'asarpatch.py')
};
const KEEP = {};
const BACKUP = {};
for (const [name, file] of Object.entries(TARGETS)) {
  KEEP[name] = fs.readFileSync(file, 'utf8');
  BACKUP[name] = path.join(import.meta.dirname, `_${name}.backup`);
}

// The audit runs first, and it asks a different question from everything below:
// not "can this guard fail" but "is a guard already broken". A mutation baked
// into a source file passes the pattern check below (`find` still matches, the
// mutation rewrote something else) and passes the byte-compare in `restore()`
// (that compares against the same dirty file it read at start-up). This is the
// third door, and it is the one that was open when `client.js` shipped with
// `const end = band[1];` — the app canvas no longer reached 0 at full strength,
// so the material sat behind a grey film and 透出桌面 did nothing at the top of
// the slider. Remove this call and that failure goes back to being invisible.
const audit = await import('./mutationaudit.mjs');
{
  const { ok, dirty, reason } = audit.auditMutations();
  if (reason) {
    console.log(`\nREFUSING TO RUN: ${reason}`);
    process.exit(1);
  }
  if (!ok) {
    console.log('\nREFUSING TO RUN: a mutation is baked into a source file.');
    for (const hit of dirty) console.log(`  ${hit.file}  <- ${hit.label}\n    ${hit.replace}`);
    console.log(
      '\nOne of these is a real bug, not a test artifact: the code is in the state the\n' +
        'mutation wanted it in. Restore the source (see tools/mutationaudit.mjs for the\n' +
        'pristine line, or the README section on this failure), then run again.'
    );
    process.exit(1);
  }
}


let restored = false;
// Set when the run is refused because a previous run left its backups behind.
// `restore()` must not run in that case: its whole job is to consume those
// files, and consuming them is what the refusal exists to prevent — it would
// delete the pristine copy and then "restore" the possibly-mutated source to
// it. The refusal path leaves everything exactly as it found it.
let refusing = false;
function restore() {
  if (restored || refusing) return;
  restored = true;
  for (const [name, file] of Object.entries(TARGETS)) {
    if (fs.existsSync(BACKUP[name])) {
      fs.copyFileSync(BACKUP[name], file);
      fs.rmSync(BACKUP[name], { force: true });
    }
    // The on-disk backup covers SIGKILL; the in-memory copy covers everything
    // else. Both, because `finally` is the only thing standing between a
    // mutation and a shipped source file and it does not run when the process
    // is killed.
    if (fs.readFileSync(file, 'utf8') !== KEEP[name]) fs.writeFileSync(file, KEEP[name]);
  }
}
process.on('exit', restore);
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    restore();
    process.exit(signal === 'SIGINT' ? 130 : 143);
  });
}
// Refuse to start on top of a run that was killed before its cleanup.
//
// This has to be the FIRST thing that touches the disk, before line ~68 writes
// its own backups: run after that, it sees the backups it just created and
// refuses every time. (That mistake was made and caught here — the check lived
// next to the pattern loop below and reported `tools/_client.js.backup exists`
// on a clean tree, because it had written it a few lines earlier.)
//
// A leftover `tools/_*.backup` is the exact fingerprint of a run that died
// mid-mutation (SIGTERM outside the handler, a timeout kill, a crashed shell):
// `restore()` deletes those files, so their presence at start means the
// previous run never reached it, or died before it finished. The sources on
// disk may or may not carry a mutation — the backup is authoritative and is
// what should be put back. Proceeding would overwrite it with the possibly-dirty
// current contents at `fs.writeFileSync(BACKUP[name], KEEP[name])`, destroying
// the only clean copy and baking the mutation in permanently.
//
// The pattern check below does not cover this: a mutation that rewrites a line
// leaves the surrounding `find` text intact, so the pattern still matches and
// the run goes ahead against a dirty file.
for (const [name] of Object.entries(TARGETS)) {
  if (fs.existsSync(BACKUP[name])) {
    refusing = true;
    console.log(
      `\nREFUSING TO RUN: tools/_${name}.backup exists, so a previous run was killed while a\n` +
        'mutation was applied and never cleaned up. That backup is the pristine copy.\n' +
        '\n' +
        `   diff tools/_${name}.backup ${name}\n` +
        `   cp tools/_${name}.backup ${name}     # if the diff shows a mutation\n` +
        `   rm tools/_${name}.backup\n` +
        '\n' +
        'Running now would overwrite that backup with the current, possibly-mutated file.'
    );
    process.exit(1);
  }
}

for (const [name, file] of Object.entries(TARGETS)) {
  fs.writeFileSync(BACKUP[name], KEEP[name]);
}

const MUTATIONS = [
  ['material gate — an unpatched client must stay inert', / {6}if \(windowMaterial !== 'patched'\) return 0;\r?\n/, ''],
  ['surface gate — no glass means nothing to fade', /config\.desktop !== true \|\| config\.surface !== true\) return 0;/, 'config.desktop !== true) return 0;'],
  ['back tier — the window base has to reach 0', /const end = tier === 'back' \? band\[1\] \* \(1 - reveal\) : band\[1\];/, 'const end = band[1];'],
  ['wallpaper fade — the layer itself has to carry it', / {6}el\.style\.opacity = reveal >= 1 \? '0' : String\(Number\(\(1 - reveal\)\.toFixed\(3\)\)\);\r?\n/, ''],
  ['html base — the switch that makes the acrylic reachable', /parts\.push\(reveal > 0/, 'parts.push(false'],

  // The specular rim. Each of these deletes one thing a rim assertion claims is
  // load-bearing, so a green suite after a mutation means the assertion was
  // decoration.
  ['rim placement — the mask has to live one selector over', /\.dsl-ripple-glint::after \{/, '.dsl-ripple-glint {'],
  // The mask mutation has to name the plain declaration together with its
  // prefixed twin, otherwise `mask-image:` also matches inside
  // `-webkit-mask-image:` and the mutation lands on the wrong line.
  ['rim mask — a uniform ring must not pass as a lit edge', /-webkit-mask-image: \$\{lobeMask\};\r?\n {2}mask-image: \$\{lobeMask\};/, '-webkit-mask-image: ${lobeMask};\r\n  mask-image: none;'],
  ['rim far side — a ring that lights evenly is a drawn circle', /const far = 0\.13;/, 'const far = 0.6;'],
  ['rim webkit mask — the prefix must not be an afterthought', /-webkit-mask-image: \$\{lobeMask\};\r?\n/, ''],
  ['rim two-tone — a transparent stop must not stand in for the shade', /rgba\(12,18,34,\$\{shade\}\)/, 'rgba(255,255,255,${shade})'],
  // Deliberately not pinned to the literal constants. Re-tuning the rim is a
  // normal thing to do, and a pattern that spells out `0.10 + 0.20` turns into
  // "pattern not present, cannot test" the moment the numbers move — reporting a
  // coverage hole where there is none, and hiding the real one.
  ['rim intensity — the highlight has to follow the slider', /const rim = Number\(\([\d.]+ \+ [\d.]+ \* glass\)\.toFixed\(3\)\);/, 'const rim = 0.3;'],
  ['rim feather — the annulus has to stay on the edge', /const feather = Number\(\([\d.]+ \+ [\d.]+ \* glass\)\.toFixed\(2\)\);/, 'const feather = 30;'],
  ['rim shape — a border is the one primitive that reads as drawn', / {2}border-radius: 50%;\r?\n {2}pointer-events: none;\r?\n {2}background: radial-gradient\(closest-side,/, '  border-radius: 50%;\r\n  pointer-events: none;\r\n  border: 2px solid #fff;\r\n  background: radial-gradient(closest-side,'],

  // The settings panel. The complaint these answer ("为何客户端的完全透明不生效")
  // was a UX defect, not a rendering one, so each assertion about what the panel
  // SAYS has to be proven able to fail.
  ['notice — the gate that keeps it from being a permanent banner', /current\.desktop && !live/, '!live'],
  ['notice — it has to exist at all when the switch cannot work', /current\.desktop && !live/, 'false'],
  ['notice — a working switch has nothing to explain', /const live = material === 'patched';/, 'const live = false;'],
  ['notice — "could not check" is not the same fact as "not patched"', /material === 'stock' \? t\('patchNoticeStock'\) : t\('patchNoticeUnknown'\)/, "t('patchNoticeStock')"],
  ['notice — the remedy has to be in it, not implied by it', /t\('patchNoticeHow'\)/, "''"],
  ['switch — refusing the click is the second malfunction', /disabled: off \|\| !current\.surface,/, 'disabled: true,'],
  ['notice — a palette-derived warning can vanish', /rgba\(245, 158, 11, 0\.10\)/, 'rgba(255, 255, 255, 0.06)'],
  ['hint — one fact belongs in one place', /(desktopHint: ')([^']*)',/, "$1$2（客户端未打补丁）',"],

  // The material diagnosis, in index.js and in the panel that renders it.
  //
  // These exist because `unknown` was a dead end: the panel said "cannot detect"
  // and there was no way to learn whether the archive was misplaced or
  // unreadable. Every mutation here removes one piece of the answer, and the
  // matching assertion is worthless if it stays green without it.
  [
    'diagnosis — the reason has to reach the response',
    'index.js',
    /materialWhy: scan\.found === null \? 'scan-failed' : scan\.found \? 'marker-found' : 'marker-absent',/,
    "materialWhy: 'unknown-reason',"
  ],
  [
    'diagnosis — the path has to reach the response',
    'index.js',
    /materialPath: file,/,
    'materialPath: null,'
  ],
  [
    'diagnosis — the tried list has to reach the response',
    'index.js',
    /materialTried: tried\r?\n {4}\};/,
    'materialTried: []\n    };'
  ],
  [
    'diagnosis — the fallback candidates must actually be walked',
    'index.js',
    /for \(const root of roots\) \{/,
    'for (const root of []) {'
  ],
  [
    'diagnosis — $DSH_ASAR has to win over the derived paths',
    'index.js',
    /if \(consider\(override\)\) return \{ file: override, tried \};/,
    'if (consider(override) === false) return { file: override, tried };'
  ],
  [
    'diagnosis — the panel must not swallow the reason',
    'client.js',
    /const why = typeof data\?\.materialWhy === 'string' \? data\.materialWhy : null;/,
    'const why = null;'
  ],
  [
    'diagnosis — the panel must not swallow the path',
    'client.js',
    /path: typeof data\?\.materialPath === 'string' \? data\.materialPath : null,/,
    'path: null,'
  ],
  [
    'diagnosis — the pointer file must be consulted',
    'index.js',
    /const pointer = readAsarPointer\(\);\r?\n {2}if \(consider\(pointer\)\) return \{ file: pointer, tried \};/,
    'const pointer = \'\';'
  ],
  [
    'diagnosis — the pointer has to outrank the walk-up, not just join it',
    'index.js',
    / {2}const pointer = readAsarPointer\(\);\r?\n {2}if \(consider\(pointer\)\) return \{ file: pointer, tried \};\r?\n/,
    '  const pointer = \'\';\r\n'
  ],

  // Reaching the archive on an asar-patched host. Each of these removes one of
  // the ways the scan can succeed, so a green suite afterwards would mean the
  // simulation in verify.mjs is not actually exercising the failure.
  [
    'reader — the noAsar door must stay open',
    'index.js',
    / {2}readers\.push\(\{\r?\n {4}label: 'noAsar',/,
    "  readers.push({\n    label: 'noAsar-disabled',"
  ],
  [
    'reader — the switch has to actually be flipped',
    'index.js',
    / {6}process\.noAsar = true;\r?\n/,
    ''
  ],
  [
    'reader — the switch has to be put back afterwards',
    'index.js',
    /if \(had\) process\.noAsar = before;/,
    'if (false) process.noAsar = before;'
  ],
  [
    'reader — a refused door must not end the search',
    'index.js',
    / {2}for \(const reader of archiveReaders\(\)\) \{/,
    '  for (const reader of archiveReaders().slice(0, 1)) {'
  ],
  [
    'reader — every failure has to be reported, not just the last',
    'index.js',
    / {6}attempts\.push\(\{ via: reader\.label, code: result\.error\.code, syscall: result\.error\.syscall \}\);/,
    '    attempts.length = 0; attempts.push({ via: reader.label, code: "?", syscall: "?" });'
  ],
  [
    'reader — hostFacts has to ask the archive path, not something else',
    'index.js',
    /listsAsDirectory = Array\.isArray\(fs\.readdirSync\(file\)\);/,
    'listsAsDirectory = Array.isArray(fs.readdirSync(path.dirname(file)));'
  ],
  [
    'reader — the errno has to survive into the scan result',
    'index.js',
    / {6}error: \{\r?\n {8}code: typeof error\?\.code === 'string' \? error\.code : \(error\?\.name \?\? 'ERROR'\),/,
    '      error: {\n        code: \'ERROR\','
  ],
  [
    'panel — the errno the host reported must reach the notice',
    'client.js',
    /: h\('span', \{ className: 'dsl-notice-why-detail', key: 'errors' \}, materialWhy\.errors\)/,
    ': null'
  ],
  [
    'panel — a scan-failed state must not be flattened to the generic wording',
    'client.js',
    /const why = typeof data\?\.materialWhy === 'string' \? data\.materialWhy : null;/,
    'const why = data?.materialWhy === \'no-candidate-found\' ? \'no-candidate-found\' : \'no-candidate-found\';'
  ],
  // The log lines. Everything else in this file checks that the diagnosis
  // reaches the *response*; on the machine that has the problem, the response
  // is not what gets read. A diagnosis nothing prints is still a diagnosis
  // nobody can act on, and it is the easiest thing to lose in a refactor —
  // delete one `if` and the fields stay perfect while the evidence vanishes.
  [
    'log — the verdict line must name the state it settled on',
    'index.js',
    /`\[liquid-glass\] window material: \$\{detail\.material\}`/,
    '`[liquid-glass] window material`'
  ],
  [
    'log — a missing archive must log the candidates it tried',
    'index.js',
    /if \(detail\.materialPath === null\) \{/,
    'if (false) {'
  ],
  [
    'log — a failed scan must name each reader and its errno',
    'index.js',
    /if \(detail\.materialScanError !== null\) \{/,
    'if (false) {'
  ],
  [
    'log — a failed scan must report what kind of host it is',
    'index.js',
    /if \(detail\.materialHost !== null\) \{/,
    'if (false) {'
  ],

  // ---------------------------------------------------------------------
  // The two things air asked for, and the one thing that had to change so
  // they could happen. Everything above defends the desktop material or the
  // diagnosis; nothing above would notice if either of these two regressed.
  // ---------------------------------------------------------------------

  // "强度拉满……更像是高斯模糊效果" — the fix was for the top of the slider to
  // reach zero frost, not to reach less. Mutating it back to the curve that
  // was in place when he reported it is the exact regression to defend, so
  // that is the mutation rather than a generic "break the formula".
  //
  // The curve has since moved into `autoFrostOf`, and the move made this
  // mutation worth more rather than less: the panel now reads the same function
  // to display the number, so breaking it here turns up in the settings row as
  // well as in the window.
  [
    'frost — the top of the slider has to reach no blur at all, not less blur',
    /return Math\.round\(24 \* \(1 - Math\.pow\(glass, 2\.2\)\)\);/,
    'return Math.round(24 - 14 * glass);'
  ],
  // The split itself. With the override gone, 磨砂模糊 becomes a second readout
  // of the transparency slider — which is precisely the state the theme shipped
  // in before this round, and the reason "拉满" could never mean "still frosted".
  [
    'frost — an explicit value has to override the curve',
    /if \(typeof frost !== 'number' \|\| !Number\.isFinite\(frost\)\) return autoFrostOf\(intensity\);/,
    'return autoFrostOf(intensity);'
  ],
  // The renderer's input normalizer must clamp values restored from storage.
  // Mutate that boundary rather than `blurOf`'s defensive clamp: every real
  // caller reaches `blurOf` through this normalizer, so mutating the private
  // helper was unreachable and did not test a user-visible path.
  [
    'frost — the renderer clamps values restored from storage',
    /next\.frost = Math\.min\(FROST_MAX, Math\.max\(0, Math\.round\(raw\.frost\)\)\);/,
    'next.frost = Math.round(raw.frost);'
  ],
  [
    'frost — control changes pass through the same normalizer',
    /config = normalizeDocument\(\{ \.\.\.config, \.\.\.patch \}\);/,
    'config = { ...config, ...patch };'
  ],
  [
    'frost — and so does the host',
    'index.js',
    /next\.frost = Math\.min\(40, Math\.max\(0, Math\.round\(raw\.frost\)\)\);/,
    'next.frost = Math.round(raw.frost);'
  ],
  // Follow mode has no number to read, so a row that displays the stored value
  // displays nothing at all. This is the mutation that keeps the panel and the
  // window showing the same number.
  [
    'frost — the row has to display the value actually in force',
    /const shownFrost = followFrost \? autoFrost : current\.frost;/,
    'const shownFrost = current.frost;'
  ],

  // 每段对话底板 used to be a legibility floor applied through `alphaOf`, which
  // is why these three mutations existed and why they no longer describe
  // anything: a floor under every text tier is arithmetically the same as
  // lowering the intensity, which is the complaint that made the control useless
  // ("你这俩选项效果和降低效果强度基本没区别"). It is a rule on one selector now,
  // so what can silently break is different — that the rule is emitted at all
  // while the switch is off, that it reaches further than one conversation row,
  // and that it moves the text it is supposed to sit behind.
  [
    'plate — the rule must not be emitted while the switch is off',
    /else if \(surface && plate > 0 && plateSide === 'side'\) parts\.push\(plateCss\('side'\)\);/,
    "else if (surface && plateSide === 'side') parts.push(plateCss('side'));"
  ],
  [
    'plate — and not while the glass itself is off either',
    /else if \(surface && plate > 0 && plateSide === 'side'\) parts\.push\(plateCss\('side'\)\);/,
    "else if (plate > 0 && plateSide === 'side') parts.push(plateCss('side'));"
  ],
  [
    'plate — one plate per conversation row, not a descendant sweep',
    /const PLATE_SELECTOR = '\[data-chat-flow\] > \[data-chat-flow-key\]';/,
    "const PLATE_SELECTOR = '[data-chat-flow] [data-chat-flow-key]';"
  ],
  [
    'plate — it has to take its room without moving the text',
    / {2}padding-block: 6px;\r?\n {2}margin-block: -6px;/,
    '  padding-block: 6px;\r\n  margin-block: 0;'
  ],
  [
    'plate — the colour has to come from the token, not from a literal',
    /background-color: rgba\(var\(--dsl-plate-human-rgb\), var\(--dsl-plate\)\);/,
    'background-color: rgba(255, 255, 255, var(--dsl-plate));'
  ],
  [
    'plate — the two sides must not collapse to one colour',
    /: mixRgb\(accent, \[0, 0, 0\], 0\.72\)\.join\(', '\)\);/,
    ": mixRgb(accent, [0, 0, 0], 0.28).join(', '));"
  ],
  [
    'plate — the human side has to be the further of the two from the canvas',
    /: mixRgb\(accent, \[0, 0, 0\], 0\.28\)\.join\(', '\)\);/,
    ": mixRgb(accent, [0, 0, 0], 0.72).join(', '));"
  ],
  [
    'plate — `side` must place the human kinds, not the model ones',
    /const HUMAN_KINDS = \['user', 'steering', 'turn-trigger'\];/,
    "const HUMAN_KINDS = ['turn-process', 'turn-error'];"
  ],
  [
    'plate — the mode has to gate the plate, not the other way round',
    /if \(surface && plateSide === 'halo'\) parts\.push\(plateCss\('halo'\)\);/,
    "if (surface && plateSide === 'halo') parts.push(plateCss('side'));"
  ],
  [
    'plate — `halo` must not be gated on the plate switch',
    /if \(surface && plateSide === 'halo'\) parts\.push\(plateCss\('halo'\)\);/,
    "if (surface && plateSide === 'halo' && plate > 0) parts.push(plateCss('halo'));"
  ],
  [
    'plate — the halo has to be two shadows, not one',
    /0 -?\$\{HALO_RIM\}px \$\{HALO_RIM\}px var\(--dsl-halo-light\),/,
    '0 0 0 0 var(--dsl-halo-light),'
  ],
  [
    'plate — an unknown mode has to fall back, not be carried through',
    /if \(PLATE_SIDES\.includes\(raw\.plateSide\)\) next\.plateSide = raw\.plateSide;/,
    'next.plateSide = raw.plateSide;'
  ],
  [
    'plate — the switch has to gate the level',
    /if \(config\.plate !== true\) return 0;/,
    'if (false) return 0;'
  ],
  [
    'plate — the published token has to be the value in force',
    /put\('--dsl-plate', Number\(plate\.toFixed\(3\)\)\);/,
    "put('--dsl-plate', 0);"
  ],

  // 窗口模糊 is the only control whose truth lives in another process, so it
  // gets a mutation for each half of that: the renderer reading the report out
  // of the wrong key (which is the bug that was actually in the tree — the
  // response is the config spread with the host's fields on top, so a report
  // named `windowBlur` overwrote the boolean and the setting reverted to off at
  // every launch), and the host reporting what it asked for instead of what it
  // got.
  [
    'window blur — the renderer must not read the report from the config key',
    /windowBlurReport = normalizeWindowBlur\(data\?\.windowBlurReport\);\r?\n {8}\/\/ Kept only for the failure state/,
    'windowBlurReport = normalizeWindowBlur(data?.windowBlur);\r\n        // Kept only for the failure state'
  ],
  [
    'window blur — and the host must not file it there either',
    'index.js',
    / {4}windowBlurReport: await applyWindowBlur\(currentConfig\.windowBlur\)/,
    '    windowBlur: await applyWindowBlur(currentConfig.windowBlur)'
  ],
  [
    'window blur — the badge has to follow the readback, not the preference',
    /const blurLive = current\.windowBlur && windowBlur\.active;/,
    'const blurLive = windowBlur.active;'
  ],
  // 窗口模糊's third outcome. A build with no getter applied the request and
  // cannot prove it; that is neither 已生效 nor 未生效, and it was folded into
  // the failure branch before. The two mutations below remove one half each:
  // dropping the predicate sends it back to "did not take", and dropping the
  // notice branch leaves the badge right while the paragraph under it hands the
  // user the patch command for a client that is already patched.
  [
    'window blur — "requested but unprovable" must not collapse into failed',
    /const blurUnverified = windowBlur\.why === 'no-getter';/,
    'const blurUnverified = false;'
  ],
  [
    // The white-noise guard. `no-getter` describes a build that never has a
    // getter, so any code path that alerts on it alerts forever. This mutation
    // is the version of the notice condition that air actually lived with —
    // no `blurUnverified` term — and verify must reject it.
    'window blur — a permanent build limitation must not raise a permanent alarm',
    /current\.windowBlur && blurReady && !windowBlur\.active && !blurUnverified/,
    'current.windowBlur && blurReady && !windowBlur.active'
  ],
  [
    'window blur — the prerequisite has to gate the notice',
    /const blurReady = live && current\.surface && current\.desktop;/,
    'const blurReady = live;'
  ],
  [
    'window blur — a readback it cannot make must not be claimed either',
    'index.js',
    /if \(report === null\) return failed\('no-report'\);/,
    "return { active: true, why: null, material: 'acrylic' };"
  ],
  [
    'window blur — "on" has to mean the material that was measured as blurred',
    'index.js',
    /const WINDOW_MATERIALS = \{ on: 'acrylic', off: 'auto' \};/,
    "const WINDOW_MATERIALS = { on: 'mica', off: 'auto' };"
  ],
  [
    // The white-screen bug, in mutation form. `none` is the value that looks
    // right — it is what the archive uses — and it is the one that wedges a
    // live window opaque. If this ever stops turning verify red, the check
    // that guards it has been weakened.
    'window blur — "off" has to be the value that undoes the material at runtime',
    'index.js',
    /const WINDOW_MATERIALS = \{ on: 'acrylic', off: 'auto' \};/,
    "const WINDOW_MATERIALS = { on: 'acrylic', off: 'none' };"
  ],
  [
    'window blur — a report answering a different request must be refused',
    'index.js',
    /if \(parsed\.seq !== windowBlurState\.seq\) return null;/,
    'if (false) return null;'
  ],
  [
    'window blur — an unchanged request must not be rewritten',
    'index.js',
    /if \(windowBlurState\.writtenMaterial !== material\) \{/,
    'if (true) {'
  ],
  [
    'window blur — an unresolvable install must be named as such',
    'index.js',
    /if \(dir === null\) return failed\('no-archive'\);/,
    "if (dir === null) return failed('no-report');"
  ],
  [
    'window blur — one unanswered wait must be remembered, not re-paid',
    'index.js',
    / && !windowBlurState\.gaveUp\) \{/,
    ') {'
  ],

  // The watcher — the half that actually runs in the client. Each of these is a
  // one-line edit to the code asarpatch.py grafts into lib/main.js, and each
  // one is caught by verify.mjs executing that source against a fake Electron.
  // Without them "it parses" was the only thing standing between a typo in
  // there and a switch that is on and does nothing.
  [
    'watcher — the whitelist must not become a pass-through',
    'asarpatch.py',
    // The two lines of the whitelist, as they appear in the PYTHON source:
    // adjacent string literals, each ending in an escaped `\n`. Matching the
    // generated JavaScript is not possible here, because what is being mutated
    // is the emitter.
    /const material = wanted\?\.material === lgMaterials\.on \? lgMaterials\.on\\n"\r?\n {8}" {6}: wanted\?\.material === lgMaterials\.off \? lgMaterials\.off : null;\\n"/,
    'const material = wanted?.material ?? null;\\n"'
  ],
  [
    // The other half of the white-screen guard, and the one that actually runs
    // on air's machine: this constant is what the watcher hands to
    // `setBackgroundMaterial`. Setting it back to `none` reproduces the report
    // exactly — a window that goes opaque white the moment the switch is turned
    // off — and verify has to catch it here, in the emitter, before it reaches
    // a real window.
    'watcher — "off" must be the value that undoes the material, not the one that wedges it',
    'asarpatch.py',
    /^RUNTIME_OFF = "auto"$/m,
    'RUNTIME_OFF = "none"'
  ],
  [
    // And the trap itself: if `none` is allowed through to the compositor
    // again, the value that wrecks the window is reachable by editing one
    // hand-writable JSON file. This mutates the whitelist into accepting it
    // while `lgMaterials` still says otherwise, which is the "hand-editable
    // file is trusted" mistake rather than the "wrong constant" one above.
    'watcher — `none` must stay refused even though the archive uses it',
    'asarpatch.py',
    /"      : wanted\?\.material === lgMaterials\.off \? lgMaterials\.off : null;\\n"/,
    '"      : wanted?.material === \\"none\\" ? \\"none\\" : null;\\n"'
  ],
  [
    'watcher — an unmeasured material must be named, not silently dropped',
    'asarpatch.py',
    // Quotes are escaped in the emitter, so they are escaped here too.
    /why: \\"unknown-material\\"/,
    'why: null'
  ],
  [
    'watcher — the material has to land on the largest window, not the smallest',
    'asarpatch.py',
    /return a\.width \* a\.height > b\.width \* b\.height \? w : best;/,
    'return a.width * a.height < b.width * b.height ? w : best;'
  ],
  [
    'watcher — no visible window must be reported, not assumed away',
    'asarpatch.py',
    /if \(wins\.length === 0\) return \{ win: null, why: \\"no-window\\" \};/,
    'if (wins.length === 0) return { win: null, why: null };'
  ],
  [
    'watcher — a window already at the material must be left alone',
    'asarpatch.py',
    /if \(current === null \? lgLast !== material : current !== material\) win\.setBackgroundMaterial\(material\);/,
    'win.setBackgroundMaterial(material);'
  ],
  [
    // The getter does not exist on the build this ships to (Electron 44.0.0 /
    // win32: `setBackgroundMaterial` yes, `getBackgroundMaterial` no), so the
    // read-then-set guard has nothing to read and the remembered last request
    // is the only thing keeping it from setting on every window creation.
    'watcher — with no getter, the remembered last request is what makes it idempotent',
    'asarpatch.py',
    /lgLast = material;/,
    ''
  ],
  [
    // The primary window is built with `show: false`, so creation is the one
    // moment there is no visible window. Drop the `show` hook and the material
    // never lands at all — which is exactly what it did before this hook.
    'watcher — the re-assert on `show` is what makes it land on a window built hidden',
    'asarpatch.py',
    /win\.on\(\\"show\\", \(\) => setImmediate\(\(\) => lgApply\(\\"shown\\"\)\)\);/,
    ''
  ],
  [
    'watcher — the readback must be a read, not an echo of the request',
    'asarpatch.py',
    /return typeof v === \\"string\\" \? v : null;/,
    'return material;'
  ],
  [
    'watcher — a window that kept the old material must not be called blurred',
    'asarpatch.py',
    /active: material === lgMaterials\.on && after === lgMaterials\.on,/,
    'active: true,'
  ],
  // Depth used to be carried by a legibility floor per tier. It is carried by
  // the ordering of the four now that the numbers are small, so the mutation
  // collapses two adjacent tiers: nothing about the tokens changes, nothing
  // about which surfaces get which tier changes, and the only thing lost is
  // that two of the four depths are the same depth.
  ['depth — the four tiers must stay four tiers', /panel: \[1\.0, 0\.04\],/, 'panel: [1.0, 0.07],'],

  // "现在的形状怎么是一个圆形外套一个方圆型". Thirteen rendered variants could not
  // reproduce it, so there is no pixel assertion to mutate — the fix was
  // structural, and the guard is the absence of the compositor handoff. This
  // puts a transform back on the element that carries the lens, which is the
  // arrangement that could produce a clip resolved in one space and a filter
  // rasterised in another. It is also the smallest edit that reddens it, which
  // is the point: if a one-line insert does not turn the suite red, the
  // assertion is documentation.
  [
    'shape — a transform back on the lens is a compositor handoff back',
    / {2}will-change: opacity;\r?\n/,
    '  will-change: opacity;\r\n  transform: scale(1);\r\n'
  ],

  // The size control, in both directions. The renderer's clamp is reachable
  // from verify.mjs through the localStorage mirror and the host's is reachable
  // through a POST; they are separate implementations in separate processes,
  // which is exactly why both need a mutation rather than one shared assertion.
  [
    'size — the renderer has to clamp the multiplier it receives',
    /next\.rippleSize = Math\.min\(2, Math\.max\(0\.5, Math\.round\(raw\.rippleSize \* 10\) \/ 10\)\);/,
    'next.rippleSize = raw.rippleSize;'
  ],
  [
    'size — the host has to clamp it too, independently',
    'index.js',
    /next\.rippleSize = Math\.min\(2, Math\.max\(0\.5, Math\.round\(raw\.rippleSize \* 10\) \/ 10\)\);/,
    'next.rippleSize = raw.rippleSize;'
  ]
];

// Refuse to start against a source that already carries a mutation.
//
// This is the failure that already happened once. A run hit its timeout and was
// terminated, the SIGTERM handler restored from the in-memory copy — but the
// NEXT run read that file as pristine, "restored intact" to it at the end, and
// the suite went on passing while `client.js` shipped with a mutation baked in.
// `restore()` compares against `KEEP`, so it cannot detect this: `KEEP` IS the
// dirty copy. Only a check against the patterns themselves can.
for (const mutation of MUTATIONS) {
  const [label, fileName, find] =
    mutation.length === 4 ? mutation : [mutation[0], 'client.js', mutation[1]];
  const pristine = KEEP[fileName];
  if (!find.test(pristine)) {
    console.log(
      `\nREFUSING TO RUN: ${fileName} does not contain the pattern for "${label}".\n` +
        'Either the code moved (update the mutation) or a previous run was killed while a\n' +
        'mutation was applied. Fix the file first — running now would bake that state in as pristine.'
    );
    process.exit(1);
  }
}

let uncovered = 0;
try {
  for (const mutation of MUTATIONS) {
    // Four-element form names the file to mutate; three-element form means
    // client.js, which is what every entry above this section uses.
    const [label, fileName, find, replace] =
      mutation.length === 4 ? mutation : [mutation[0], 'client.js', mutation[1], mutation[2]];
    const target = TARGETS[fileName];
    const pristine = KEEP[fileName];
    if (!find.test(pristine)) {
      console.log(`\n  [??] pattern not present, cannot test: ${label}`);
      console.log(`       either the code moved, or ${fileName} is dirty from a run that was killed —`);
      console.log('       check `git diff` / the line itself before trusting this report');
      uncovered += 1;
      continue;
    }
    // EVERY file back to pristine first, not just the one this mutation names.
    //
    // The bug this fixes was in the tool for its whole life and it was silent:
    // each iteration only rewrote its own target, so whatever the previous
    // iteration had mutated into a DIFFERENT file was still there when the next
    // suite ran. The suite then failed for the residue, and the report credited
    // the failure to the mutation being tested — which is the exact lie this
    // tool exists to prevent. It was caught because the collateral failures
    // made no sense (a client.js-only mutation reddening host-side and
    // watcher-side assertions), and because the pattern was positional: every
    // mutation ran against "its own edit plus the last edit to each other file".
    //
    // Concretely: 窗口模糊 ran with the previous 透出桌面 notice mutation still
    // in client.js, and the watcher mutations ran with the previous "forget the
    // gave-up memo" mutation still in index.js.
    for (const [name, file] of Object.entries(TARGETS)) {
      if (fs.readFileSync(file, 'utf8') !== KEEP[name]) fs.writeFileSync(file, KEEP[name]);
    }
    fs.writeFileSync(target, pristine.replace(find, replace));
    let out = '';
    try {
      out = execFileSync(NODE, [path.join(import.meta.dirname, 'verify.mjs')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (error) {
      out = String(error.stdout ?? '');
    }
    const fails = out.split('\n').filter((l) => l.includes('[FAIL]'));
    console.log(`\n${label}`);
    if (fails.length === 0) {
      console.log('  NO FAILURES — this guard is not covered by any assertion');
      uncovered += 1;
    } else {
      for (const line of fails) console.log(`  ${line.trim()}`);
    }
  }
} finally {
  restore();
}
// Proof, not a promise. A restore that silently wrote the wrong bytes would leave
// the suite green and the source wrong, which is precisely how this tool was
// caught in the first place.
console.log('');
for (const [name, source, after] of Object.entries(TARGETS).map(([n, file]) => [
  n,
  KEEP[n],
  fs.readFileSync(file, 'utf8')
])) {
  console.log(
    after === source
      ? `${name} restored intact (${Buffer.byteLength(after)} bytes)`
      : `${name} DOES NOT MATCH the pre-run copy (${Buffer.byteLength(after)} vs ${Buffer.byteLength(source)} bytes)`
  );
  if (after !== source) uncovered += 1;
}
console.log(uncovered === 0 ? 'every guard above is covered' : `${uncovered} guard(s) uncovered`);
process.exitCode = uncovered === 0 ? 0 : 1;

