/**
 * A/B harness — measure whether each setting actually CHANGES anything.
 *
 * "The setting exists" and "the setting is visible" are different claims. This
 * renders the same page under several configs, then `tools/abdiff.py` diffs the
 * pixels cell by cell. A control whose cells are near-identical is a control
 * that does nothing perceptible, no matter how correct its CSS is.
 *
 *   node tools/ab.mjs && python tools/abdiff.py
 *
 * All variants live in iframes inside one composite page, so the whole matrix
 * costs a single browser launch instead of eight.
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
  shoot,
  dumpDom,
  readPre
} from './harness.mjs';

const DIR = path.join(OUT, 'ab');
const FRAMES = path.join(DIR, 'frames');
fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(FRAMES, { recursive: true });

// Grid geometry — abdiff.py crops using exactly these numbers.
const CELL_W = 320;
const CELL_H = 240;
const GAP = 8;
const COLS = 4;
export const GRID = { w: CELL_W, h: CELL_H, gap: GAP, cols: COLS };

/** Each variant = one setting knocked away from the default. */
export const VARIANTS = [
  { id: 'baseline', label: 'baseline', config: {} },
  { id: 'off', label: 'enabled OFF', config: { enabled: false } },
  { id: 'nosurface', label: 'surface OFF', config: { surface: false } },
  { id: 'nocursor', label: 'cursor OFF', config: { cursor: false } },
  { id: 'noripple', label: 'ripple OFF', config: { ripple: false } },
  { id: 'intlow', label: 'intensity 0.2', config: { intensity: 0.2 } },
  { id: 'inthigh', label: 'intensity 2', config: { intensity: 2 } },
  // `aurora` is a preset id from an earlier version: the client maps it to
  // `slate` through TINT_ALIASES. It is worth a cell for exactly that reason —
  // a saved config from before the rename has to keep working — but the label
  // has to say so, or the grid reads as if there were four tints called
  // ice / aurora / dusk / mono and this one silently measured nothing.
  { id: 'aurora', label: 'tint aurora→slate', config: { tint: 'aurora' } }
];

const FRAME_CSS = `
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; overflow: hidden; }
body { font: 12px/1.6 var(--dsw-font-family, system-ui, sans-serif); color: var(--dsw-alias-label-primary); }
#root { height: 100vh; background: var(--dsw-alias-bg-base); position: relative; }
.topbar {
  height: 34px; padding: 9px 14px; font-size: 11px; color: var(--dsw-alias-label-tertiary);
  background: var(--dsw-alias-bg-layer-2); border-bottom: 0.5px solid var(--dsw-alias-border-l2);
}
.side {
  position: absolute; left: 0; top: 34px; bottom: 0; width: 96px; padding: 10px 8px;
  background: var(--dsw-alias-bg-layer-1); border-right: 0.5px solid var(--dsw-alias-border-l3);
  display: flex; flex-direction: column; gap: 5px;
}
.item { padding: 5px 8px; border-radius: var(--dsw-radius-sm); font-size: 11px; color: var(--dsw-alias-label-secondary); }
.item.on { background: var(--dsw-alias-interactive-bg-active); }
.dlg {
  position: absolute; left: 112px; top: 52px; width: 180px; padding: 12px 14px;
  border-radius: var(--dsw-radius-lg);
  background: var(--dsw-alias-bg-layer-3);
  border: 0.5px solid var(--dsw-alias-border-l4);
  font-size: 11.5px; line-height: 1.55;
}
.dlg b { display: block; font-size: 11.5px; margin-bottom: 4px; }
.ft {
  position: absolute; right: 12px; bottom: 14px; width: 118px; height: 74px; padding: 9px 11px;
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-layer-2);
  border: 0.5px solid var(--dsw-alias-border-l3);
  font-size: 10.5px; color: var(--dsw-alias-label-secondary);
}
/* Freeze the glint in its held state so a static screenshot can actually see
   it. Without this it is mid-dissolve or already gone by capture time.

   The transform pin that used to be here is gone, and the reason is worth
   keeping: it was pinning the disc's SIZE, because the size was carried by a
   transform. When the disc started growing by layout instead (see rippleCss in
   client.js), that declaration became a no-op — so the freeze silently stopped
   freezing, the frame started catching the forced release at 900ms, and this row
   went from 3.5% to 9.3% for a reason that had nothing to do with how a press
   looks. A measuring instrument that keeps its old shape after the thing it
   measures changes shape reports the difference as a finding.
   The pin is the capture budget now (below), and the attribute the client sets
   is the only thing that decides the geometry. */
.dsl-ripple-glint {
  transition: none !important;
  opacity: 1 !important;
}
`;

const FRAME_BODY = `
<div id="root">
  <div class="topbar">liquid-glass · A/B</div>
  <div class="side">
    <div class="item on">会话</div>
    <div class="item">工作区</div>
    <div class="item">插件</div>
  </div>
  <div class="dlg" role="dialog"><b>设置弹窗</b>玻璃应当透出壁纸。</div>
  <div class="ft" data-dockkit-float>浮动面板</div>
</div>
`;

function frame(variant, scheme) {
  return `<!DOCTYPE html>
<html data-platform="win32">
${pageHead()}
<style>${FRAME_CSS}</style>
</head>
<body${scheme === 'dark' ? ' data-ds-dark-theme=""' : ''}>
${FRAME_BODY}
<script>${loader({ ...DEFAULT_CONFIG, ...variant.config })}</script>
<script>${MOCK_CTX}</script>
<script src="${clientSrc(FRAMES)}"></script>
<script>
${BOOT}
// Fire one ripple at a fixed point and leave it frozen, so the screenshot shows
// what a click actually produces instead of an empty page.
// Must be dispatched on document, not window: the listener is registered on
// document, and a window-targeted event never reaches document listeners.
(function () {
  window.addEventListener('load', function () {
    setTimeout(function () {
      document.dispatchEvent(new PointerEvent('pointerdown', {
        clientX: 210, clientY: 150, button: 0, buttons: 1,
        pointerType: 'mouse', bubbles: true
      }));
    }, 300);
  });
})();
</script>
</body></html>`;
}

/** Composite host: arranges the variants, then reports their resolved tokens. */
function composite(scheme) {
  const cells = VARIANTS.map(
    (v) => `<iframe src="frames/${v.id}-${scheme}.html" width="${CELL_W}" height="${CELL_H}"></iframe>`
  ).join('\n');
  const ids = VARIANTS.map((v) => v.id);
  const labels = VARIANTS.map((v) => v.label);
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
html, body { margin: 0; padding: ${GAP}px; background: #2b313c; font: 11px system-ui, sans-serif; }
.grid { display: grid; grid-template-columns: repeat(${COLS}, ${CELL_W}px); gap: ${GAP}px; }
iframe { display: block; border: 0; }
</style></head><body>
<div class="grid">${cells}</div>
<pre id="out">pending</pre>
<script>
var IDS = ${JSON.stringify(ids)};
var LABELS = ${JSON.stringify(labels)};
window.addEventListener('load', function () {
  // Deferred: loadFromHost() resolves after this event is queued.
  setTimeout(function () {
    var rows = [];
    IDS.forEach(function (id, i) {
      try {
        var fr = document.querySelectorAll('iframe')[i];
        var d = fr.contentDocument;
        var sheet = d.getElementById('dsl-theme-style');
        if (sheet === null) { rows.push(id + '|SHEET_MISSING'); return; }
        var cs = d.defaultView.getComputedStyle(d.body);
        var dlg = d.defaultView.getComputedStyle(d.querySelector('.dlg'));
        var ft = d.defaultView.getComputedStyle(d.querySelector('.ft'));
        var side = d.defaultView.getComputedStyle(d.querySelector('.side'));
        var root = d.defaultView.getComputedStyle(d.getElementById('root'));
        var els = [];
        [['dialog', dlg], ['float', ft], ['side', side], ['root', root]].forEach(function (p) {
          els.push(p[0] + '.bg=' + p[1].backgroundColor);
          els.push(p[0] + '.blur=' + (p[1].backdropFilter || 'none'));
        });
        var wall = d.getElementById('dsl-wallpaper');
        els.push('wall=' + (wall === null ? 'none' : (wall.style.backgroundImage || 'none').slice(0, 44)));
        els.push('cursor=' + (d.defaultView.getComputedStyle(d.querySelector('.item')).cursor || '').slice(0, 40));
        els.push('ripples=' + d.querySelectorAll('.dsl-ripple-glint').length);
        els.push('sheetBytes=' + sheet.textContent.length);
        rows.push(id + '|' + els.join('; '));
      } catch (e) {
        rows.push(id + '|READ_ERROR:' + e.message);
      }
    });
    document.getElementById('out').textContent = rows.join('\\n');
  }, 1500);
});
</script>
</body></html>`;
}

const COMPOSITE_W = GAP * 2 + COLS * CELL_W + (COLS - 1) * GAP;
const ROWS = Math.ceil(VARIANTS.length / COLS);
const COMPOSITE_H = GAP * 2 + ROWS * CELL_H + (ROWS - 1) * GAP;

if (browser === null) {
  console.log('no browser found');
  process.exit(0);
}

for (const scheme of ['light', 'dark']) {
  for (const v of VARIANTS) {
    fs.writeFileSync(path.join(FRAMES, `${v.id}-${scheme}.html`), frame(v, scheme), 'utf8');
  }
  const hostFile = path.join(DIR, `index-${scheme}.html`);
  fs.writeFileSync(hostFile, composite(scheme), 'utf8');

  const out = readPre(dumpDom(hostFile, { budget: 9000 }));
  console.log(`\n===== ${scheme} : resolved values =====`);
  if (!out.includes('|')) {
    console.log(`  nothing readable: ${out.slice(0, 160)}`);
  } else {
    for (const line of out.split('\n')) {
      const [id, rest] = line.split('|');
      if (rest === undefined) continue;
      const label = (VARIANTS.find((v) => v.id === id) ?? { label: id }).label;
      console.log(`  ${label.padEnd(15)} ${rest}`);
    }
  }

  const png = path.join(DIR, `ab-${scheme}.png`);
  // The real timeline of one synthetic press, read out of client.js rather than
  // guessed: `pointerdown` at 300ms → held → at **900ms** the stuck-press safety
  // fires and sets `data-releasing` → the element is reclaimed at 1240ms.
  //
  // So there are two windows and only one of them is the one this row is about.
  // [300, 900] is the pressed disc; [900, 1240] is a dissolve that has already
  // started fading. The old budget of 1200 sat in the second one and only looked
  // right because the freeze CSS was pinning the size with a transform; see the
  // note on that CSS above. 700 lands 400ms into the held window, which is the
  // whole width of `ripple`'s purpose.
  const ok = shoot(hostFile, png, {
    width: COMPOSITE_W + 20,
    height: COMPOSITE_H + 220,
    allowFileAccess: true,
    budget: 700
  });
  console.log(
    `  composite ${scheme} -> ` +
      (ok ? `ab-${scheme}.png (${fs.statSync(png).size} bytes) grid ${COMPOSITE_W}x${COMPOSITE_H}` : 'FAILED')
  );
}

// Geometry for the cropper, so it never has to guess.
fs.writeFileSync(
  path.join(DIR, 'grid.json'),
  JSON.stringify({ ...GRID, order: VARIANTS.map((v) => v.id), labels: VARIANTS.map((v) => v.label) }, null, 2),
  'utf8'
);
