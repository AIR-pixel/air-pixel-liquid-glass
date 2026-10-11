/**
 * Lens lab — pick the displacement map's two constants by looking at them.
 *
 * `feDisplacementMap` is governed by exactly two numbers that matter:
 *
 *   · `bezel` — how far in from the rim the map ramps. This decides whether the
 *     pane reads as *glass with thickness* or as a funhouse mirror. Too wide and
 *     the warp reaches the interior, which distorts the content the pane is
 *     supposed to be showing; too narrow and there is no rim at all.
 *   · `scale` — peak displacement in CSS px. This is the perceived thickness.
 *
 * Neither can be chosen from first principles: the right value is a function of
 * the backdrop's own spatial frequency, which is not knowable in the abstract.
 * So render the matrix and look.
 *
 * Two mistakes this file exists to avoid, both of which produced a blank sheet
 * the first time it was run:
 *
 *   1. The backdrop is covered in fine 11px text *across its whole area*, not
 *      just the top. A panel over a smooth gradient is visually identical to no
 *      panel at all — the previous version placed every panel exactly there and
 *      therefore showed nothing to judge.
 *   2. Every row carries an unfiltered control panel in the same column, so the
 *      displacement has a reference. Without it, "the blur looks fine" and "the
 *      map is working" are indistinguishable.
 */
import fs from 'node:fs';
import path from 'node:path';
import { shoot, OUT, browser } from './harness.mjs';

const PAGE = path.join(OUT, 'lenslab.html');
const SHOT = path.join(OUT, 'lenslab.png');

const SCALES = [8, 18, 30, 44];
const BEZELS = [0.08, 0.14, 0.22];

// Column 0 is the control — blur only, no displacement.
const COLS = ['ctrl', ...SCALES.map(String)];
const P = { w: 300, h: 168, gx: 22, gy: 24, top: 46 };

const colX = (c) => P.gx + c * (P.w + P.gx);
const rowY = (r) => P.top + r * (P.h + P.gy);

const panelCss = BEZELS.map((_b, r) =>
  COLS.map((_c, c) => `
  #p${r}_${c} { left: ${colX(c)}px; top: ${rowY(r)}px; }`).join('')
).join('');

const panelHtml = BEZELS.map((_b, r) => COLS.map((_c, c) =>
  `<div class="panel" id="p${r}_${c}" data-row="${r}" data-col="${c}"></div>`).join('')
).join('');

const MAP_FN = `
function lensMap(size, bezelFrac) {
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  const g = canvas.getContext('2d');
  const img = g.createImageData(size, size);
  const d = img.data;
  const bezel = size * bezelFrac;
  const ramp = (dist) => {
    if (dist >= bezel) return 0;
    const t = 1 - dist / bezel;
    return t * t * (3 - 2 * t);
  };
  for (let y = 0; y < size; y += 1) {
    const dy = Math.round(127 * (ramp(y) - ramp(size - 1 - y)));
    for (let x = 0; x < size; x += 1) {
      const dx = Math.round(127 * (ramp(x) - ramp(size - 1 - x)));
      const i = (y * size + x) * 4;
      d[i] = 128 + dx; d[i + 1] = 128 + dy; d[i + 2] = 128; d[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return canvas.toDataURL('image/png');
}
`;

/** Dense fine text across the whole viewport: the honest adversarial backdrop. */
const LINES = Array.from({ length: 128 }, (_, i) => {
  const words = [
    'function lensMapDataUrl(size) { return canvas.toDataURL(); }',
    'the quick brown fox jumps over the lazy dog 0110 1011 1100 0101',
    '中文测试文本用于检验折射后的可读性 · 0123456789 · §¶†‡',
    '<b>const</b> scale = 32; <b>const</b> bezel = 0.16; <b>return</b> filter;',
    'http://127.0.0.1:19387/api/theme-liquid-glass/config',
    'abcdefghijklmnopqrstuvwxyz ABCDEFGHIJKLMNOPQRSTUVWXYZ 0123456789',
    'iiiiiiiiiiiiiiiiiiii llllllllllllllllll 11111111111111111111'
  ];
  return `<div>${words[i % words.length]}</div>`;
}).join('');

const HTML = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html, body { margin: 0; height: 100%; overflow: hidden; }
  body {
    background: linear-gradient(115deg, #0a0c10 0%, #22282f 38%, #4b5560 62%, #0d1014 100%);
    font: 11px/1.35 ui-monospace, monospace;
  }
  #backdrop {
    position: absolute; inset: 0; padding: 4px 8px;
    color: rgba(255,255,255,0.90); letter-spacing: 0.01em;
  }
  #backdrop b { color: #7fd4ff; font-weight: 400; }
  .panel {
    position: absolute; width: ${P.w}px; height: ${P.h}px;
    border-radius: 18px;
    /* The rim is part of the specimen: a lens with no lit edge is not a
       finished material, and the two have to be judged together. */
    box-shadow:
      inset 0 1px 1px rgba(255,255,255,0.72),
      inset 0 -1px 1px rgba(0,0,0,0.28),
      inset 1px 0 1px rgba(255,255,255,0.34),
      inset -1px 0 1px rgba(255,255,255,0.34);
    backdrop-filter: blur(9px) saturate(150%);
  }
  .cap { position: absolute; color: #dcebff; font: 12px/1 ui-monospace, monospace; }
${panelCss}
</style></head><body>
  <div id="backdrop">${LINES}</div>
${panelHtml}
${COLS.map((c, i) => `<div class="cap" style="left:${colX(i) + 4}px;top:${P.top - 20}px">${c === 'ctrl' ? 'CONTROL (blur only)' : 'scale ' + c}</div>`).join('')}
${BEZELS.map((b, r) => `<div class="cap" style="left:4px;top:${rowY(r) + 6}px">b ${b}</div>`).join('')}
  <script>
${MAP_FN}
const NS = 'http://www.w3.org/2000/svg';
const defs = document.createElementNS(NS, 'svg');
defs.setAttribute('width', '0'); defs.setAttribute('height', '0');
defs.style.position = 'absolute';
const SCALES = ${JSON.stringify(SCALES)};
const BEZELS = ${JSON.stringify(BEZELS)};
const maps = BEZELS.map((b) => lensMap(192, b));
BEZELS.forEach((bezel, r) => {
  SCALES.forEach((scale, i) => {
    const c = i + 1;
    const id = 'lens-' + r + '_' + c;
    const filter = document.createElementNS(NS, 'filter');
    filter.setAttribute('id', id);
    filter.setAttribute('filterUnits', 'objectBoundingBox');
    filter.setAttribute('x', '-20%'); filter.setAttribute('y', '-20%');
    filter.setAttribute('width', '140%'); filter.setAttribute('height', '140%');
    filter.setAttribute('color-interpolation-filters', 'sRGB');
    const feImage = document.createElementNS(NS, 'feImage');
    feImage.setAttribute('href', maps[r]);
    feImage.setAttribute('preserveAspectRatio', 'none');
    feImage.setAttribute('result', 'map');
    const fd = document.createElementNS(NS, 'feDisplacementMap');
    fd.setAttribute('in', 'SourceGraphic');
    fd.setAttribute('in2', 'map');
    fd.setAttribute('scale', String(scale));
    fd.setAttribute('xChannelSelector', 'R');
    fd.setAttribute('yChannelSelector', 'G');
    filter.appendChild(feImage); filter.appendChild(fd);
    defs.appendChild(filter);
    if (c > 0) {
      document.getElementById('p' + r + '_' + c).style.backdropFilter =
        'blur(9px) saturate(150%) url(#' + id + ')';
    }
  });
});
document.body.appendChild(defs);
  </script>
</body></html>`;

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(PAGE, HTML);
console.log('browser:', browser);
console.log('shot:', shoot(PAGE, SHOT, { width: 1400, height: 660, budget: 1500 }), SHOT);
