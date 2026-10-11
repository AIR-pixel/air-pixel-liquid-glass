/**
 * Token resolution probe.
 *
 * Reads back the COMPUTED value of the tokens the theme claims to drive, for
 * every preset, in both schemes. A downscaled screenshot is not evidence that
 * four presets differ — this prints the numbers.
 *
 *   node tools/tokens.mjs
 *
 * Two traps this had to clear, both found the hard way:
 *  - The theme lands twice. `client.js` applies the cached/default config at
 *    module scope, then `loadFromHost()` resolves on a later microtask and
 *    re-applies the real one. Reading styles synchronously after the script tag
 *    observes the DEFAULT preset, not the requested one. The read is deferred.
 *  - Boot must call `apply(ctx)`, not just `factory()`. `loadFromHost()` lives
 *    at the bottom of `apply`, so a factory-only harness never loads host
 *    config at all — which made every preset resolve identically while still
 *    looking correct. See harness.mjs.
 *
 * Four frames live in iframes and are read in ONE dump; that needs
 * `--allow-file-access-from-files` so the parent may touch frame styles.
 */
import fs from 'node:fs';
import path from 'node:path';

import {
  OUT,
  DEFAULT_CONFIG,
  browser,
  loader,
  BOOT,
  MOCK_CTX,
  pageHead,
  clientSrc,
  dumpDom,
  readPre
} from './harness.mjs';

const DIR = path.join(OUT, 'probe');
fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(DIR, { recursive: true });

if (browser === null) {
  console.log('no browser found');
  process.exit(0);
}

const TINTS = ['ice', 'aurora', 'dusk', 'mono'];
const TOKENS = [
  '--dsw-alias-brand-primary',
  '--dsw-alias-button-primary-fill',
  '--dsw-alias-link',
  '--dsw-alias-bg-base',
  '--dsw-alias-bg-layer-1',
  '--dsw-alias-bg-layer-3',
  '--dsl-blur',
  '--dsl-tint-accent'
];

/** One preset, one scheme. Mounts the real theme through the real lifecycle. */
function frame(tint, scheme) {
  return `<!DOCTYPE html>
<html data-platform="win32">
${pageHead()}
</head>
<body${scheme === 'dark' ? ' data-ds-dark-theme=""' : ''}>
<div class="probe-card" style="background:var(--dsw-alias-bg-layer-3);height:40px">x</div>
<div class="probe-dialog" role="dialog" style="height:40px">d</div>
<div class="probe-float" data-dockkit-float style="height:40px">f</div>
<script>${loader({ ...DEFAULT_CONFIG, tint })}</script>
<script>${MOCK_CTX}</script>
<script src="${clientSrc(DIR)}"></script>
<script>${BOOT}</script>
</body></html>`;
}

/** Parent: hosts all four presets, then reports their resolved tokens. */
function host(scheme) {
  const frames = TINTS.map((t) => `<iframe id="f-${t}" src="${t}-${scheme}.html"></iframe>`).join('\n');
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
body { margin: 0; } iframe { width: 200px; height: 90px; border: 0; }
</style></head><body>
${frames}
<pre id="out">pending</pre>
<script>
var TOKENS = ${JSON.stringify(TOKENS)};
var TINTS = ${JSON.stringify(TINTS)};
window.addEventListener('load', function () {
  // Deferred on purpose: loadFromHost() resolves after the load event is queued,
  // and it is what installs the requested preset.
  setTimeout(function () {
    var rows = [];
    TINTS.forEach(function (t) {
      try {
        var f = document.getElementById('f-' + t).contentDocument;
        if (f.getElementById('dsl-theme-style') === null) { rows.push(t + '|SHEET_MISSING'); return; }
        var cs = f.defaultView.getComputedStyle(f.body);
        var dlg = f.defaultView.getComputedStyle(f.querySelector('.probe-dialog'));
        var flt = f.defaultView.getComputedStyle(f.querySelector('.probe-float'));
        var vals = TOKENS.map(function (k) { return k + '=' + cs.getPropertyValue(k).trim(); });
        vals.push('body.background-image=' + (cs.backgroundImage || 'NONE').slice(0, 70));
        vals.push('dialog.backdrop-filter=' + (dlg.backdropFilter || 'NONE'));
        vals.push('float.backdrop-filter=' + (flt.backdropFilter || 'NONE'));
        vals.push('dialog.box-shadow=' + (dlg.boxShadow || 'NONE').slice(0, 40));
        vals.push('applied=' + (f.body.getAttribute('data-applied') || 'none'));
        rows.push(t + '|' + vals.join('; '));
      } catch (e) {
        rows.push(t + '|READ_ERROR:' + e.message);
      }
    });
    document.getElementById('out').textContent = rows.join('\\n');
  }, 1200);
});
</script>
</body></html>`;
}

let failures = 0;
const accents = { light: [], dark: [] };

for (const scheme of ['light', 'dark']) {
  for (const tint of TINTS) {
    fs.writeFileSync(path.join(DIR, `${tint}-${scheme}.html`), frame(tint, scheme), 'utf8');
  }
  const hostFile = path.join(DIR, `index-${scheme}.html`);
  fs.writeFileSync(hostFile, host(scheme), 'utf8');

  console.log(`\n===== ${scheme} =====`);
  const out = readPre(dumpDom(hostFile, { budget: 7000 }));
  if (!out.includes('|')) {
    console.log(`  probe returned nothing usable: ${out.slice(0, 200)}`);
    failures += 1;
    continue;
  }

  for (const line of out.split('\n')) {
    const [tint, rest] = line.split('|');
    if (rest === undefined) continue;
    if (rest === 'SHEET_MISSING') {
      console.log(`  ${tint.padEnd(7)} !! theme sheet not mounted - client.js never ran`);
      failures += 1;
      continue;
    }
    if (rest.startsWith('READ_ERROR')) {
      console.log(`  ${tint.padEnd(7)} !! ${rest}`);
      failures += 1;
      continue;
    }
    const get = (k) => {
      const escaped = k.replace(/[-[\]{}()*+?.\\^$|]/g, '\\$&');
      return (rest.match(new RegExp(`${escaped}=([^;]*)`)) ?? [])[1] ?? '?';
    };
    const accent = get('--dsw-alias-brand-primary').trim();
    const base = get('--dsw-alias-bg-base').trim();
    const blur = get('--dsl-blur').trim();
    const bg = get('body.background-image').trim();
    const dlgBd = get('dialog.backdrop-filter').trim();
    const fltBd = get('float.backdrop-filter').trim();
    const dlgShadow = get('dialog.box-shadow').trim();
    const applied = get('applied').trim();
    console.log(`  ${tint.padEnd(7)} accent=${accent.padEnd(24)} base=${base}`);
    console.log(`  ${''.padEnd(7)} blur=${blur.padEnd(28)} inject=[${applied}]`);
    console.log(`  ${''.padEnd(7)} dialog.glass=${dlgBd} | float.glass=${fltBd}`);
    console.log(`  ${''.padEnd(7)} dialog.shadow=${dlgShadow}`);
    console.log(`  ${''.padEnd(7)} bg=${bg.slice(0, 52)}`);
    accents[scheme].push(accent);

    if (!bg.includes('gradient')) {
      console.log(`  ${''.padEnd(7)} !! wallpaper missing on body`);
      failures += 1;
    }
    if (!blur.includes('blur(')) {
      console.log(`  ${''.padEnd(7)} !! frosted blur token unresolved`);
      failures += 1;
    }
    if (!dlgBd.includes('blur(')) {
      console.log(`  ${''.padEnd(7)} !! [role=dialog] did not pick up the glass`);
      failures += 1;
    }
    if (!fltBd.includes('blur(')) {
      console.log(`  ${''.padEnd(7)} !! [data-dockkit-float] did not pick up the glass`);
      failures += 1;
    }
    if (!dlgShadow.includes('rgba')) {
      console.log(`  ${''.padEnd(7)} !! dialog sheen shadow missing`);
      failures += 1;
    }
    if (!applied.includes('locale')) {
      console.log(`  ${''.padEnd(7)} !! apply() did not report its inject list`);
      failures += 1;
    }
  }
}

console.log('\n===== accent distinctness =====');
for (const scheme of ['light', 'dark']) {
  const vals = accents[scheme];
  const unique = new Set(vals).size;
  console.log(`  ${scheme.padEnd(6)}: ${unique}/${vals.length} distinct -> ${vals.join(' | ')}`);
  if (vals.length > 0 && unique < vals.length) {
    console.log('          !! presets share an accent — the tint override is not landing');
    failures += 1;
  }
}

console.log(failures === 0 ? '\ntoken probe: all good' : `\ntoken probe: ${failures} problem(s)`);
