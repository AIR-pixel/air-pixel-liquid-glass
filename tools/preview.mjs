/**
 * Visual preview + screenshot.
 *
 * Boots the real client.js in a stand-in DSH shell (so the cascade order is
 * genuine — the plugin sheet lands after the official tokens) and screenshots
 * the result with headless Edge.
 *
 *   node tools/preview.mjs
 *
 * Output, all under tools/_preview/:
 *   light.png / dark.png   full shell, default preset, with the pointer strip
 *   tints.png              all 4 presets x light/dark, side by side
 *   cursors.png            shipped pointers on light / dark / mid grounds
 *
 * All shared boot plumbing lives in harness.mjs — in particular it calls
 * `apply(ctx)`, without which `loadFromHost()` never runs.
 */
import fs from 'node:fs';
import path from 'node:path';

import {
  OUT,
  DEFAULT_CONFIG,
  APP_SHELL,
  APP_SHELL_CSS,
  browser,
  loader,
  BOOT,
  MOCK_CTX,
  SCRAPE_CURSORS,
  pageHead,
  clientSrc,
  shoot,
  dumpDom
} from './harness.mjs';

fs.mkdirSync(OUT, { recursive: true });

const TINTS = ['ice', 'slate', 'dusk', 'mono'];


const CURSOR_STRIP_FILL = `
(function () {
  var labels = { default: '默认', pointer: '手型', text: '文本', grab: '拖拽', forbidden: '禁用' };
  var names = ['default', 'pointer', 'text', 'grab', 'forbidden'];
  var strip = document.getElementById('cursor-strip');
  (window.__cursors || []).forEach(function (svg, i) {
    var fig = document.createElement('figure');
    fig.innerHTML = svg + '<figcaption>' + (labels[names[i]] || '?') + '</figcaption>';
    strip.appendChild(fig);
  });
})();
`;

/** Full shell render, with the pointer strip pinned along the bottom. */
function shellPage(scheme, config) {
  return `<!DOCTYPE html>
<html data-platform="win32">
${pageHead()}
<style>${APP_SHELL_CSS}</style>
</head>
<body${scheme === 'dark' ? ' data-ds-dark-theme=""' : ''}>
${APP_SHELL}
<script>${loader(config)}</script>
<script>${MOCK_CTX}</script>
<script src="${clientSrc(OUT)}"></script>
<script>${BOOT}${SCRAPE_CURSORS}${CURSOR_STRIP_FILL}</script>
</body>
</html>`;
}

/** Compact swatch: wallpaper + a frosted card, for the preset matrix. */
function swatchPage(scheme, tint) {
  const dir = path.join(OUT, 'frames');
  const css = `
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; }
body { font-family: var(--dsw-font-family, system-ui, sans-serif); color: var(--dsw-alias-label-primary); }
.wrap { height: 100%; padding: 12px; }
.card {
  height: 100%; border-radius: var(--dsw-radius-xl);
  background: var(--dsw-alias-bg-layer-3);
  border: 0.5px solid var(--dsw-alias-border-l4);
  backdrop-filter: var(--dsl-blur);
  -webkit-backdrop-filter: var(--dsl-blur);
  box-shadow: inset 0 1px 0 var(--dsl-sheen-top), 0 18px 45px -20px rgba(6,16,36,0.5);
  padding: 12px 14px; display: flex; flex-direction: column; gap: 8px;
}
h4 { margin: 0; font-size: 13px; font-weight: 600; }
p { margin: 0; font-size: 11.5px; line-height: 1.6; color: var(--dsw-alias-label-secondary); }
.pill { padding: 3px 9px; border-radius: 999px; background: var(--dsw-alias-button-primary-fill); color: #fff; font-size: 10.5px; align-self: flex-start; }
.sw { margin-top: auto; display: flex; gap: 6px; align-items: center; font-size: 10.5px; color: var(--dsw-alias-label-tertiary); }
.dot { width: 16px; height: 16px; border-radius: 50%; background: var(--dsw-alias-brand-primary); border: 0.5px solid var(--dsw-alias-border-l4); }
`;
  return `<!DOCTYPE html>
<html data-platform="win32">
${pageHead()}
<style>${css}</style>
</head>
<body${scheme === 'dark' ? ' data-ds-dark-theme=""' : ''}>
<div class="wrap"><div class="card">
  <h4>${tint} · ${scheme}</h4>
  <p>玻璃表层与壁纸的对照色块。文字应当保持可读，底部色调应当透得出来。</p>
  <span class="pill">主要按钮</span>
  <div class="sw"><span class="dot"></span><span>accent · 底层色调</span></div>
</div></div>
<script>${loader({ ...DEFAULT_CONFIG, tint })}</script>
<script>${MOCK_CTX}</script>
<script src="${clientSrc(dir)}"></script>
<script>${BOOT}</script>
</body>
</html>`;
}

function matrixPage() {
  const cells = [];
  for (const scheme of ['light', 'dark']) {
    for (const tint of TINTS) {
      cells.push(`<figure><iframe src="frames/${tint}-${scheme}.html" width="330" height="215"></iframe></figure>`);
    }
    cells.push('<div class="brk"></div>');
  }
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
body { margin: 0; padding: 14px; background: #dfe5ee; font: 12px "Segoe UI", system-ui, sans-serif; }
.grid { display: grid; grid-template-columns: repeat(4, 330px); gap: 12px; justify-content: start; }
.brk { grid-column: 1 / -1; height: 0; }
figure { margin: 0; border-radius: 10px; overflow: hidden; box-shadow: 0 6px 18px -8px rgba(0,0,0,.35); background: #fff; }
iframe { display: block; border: 0; }
</style></head><body><div class="grid">${cells.join('\n')}</div></body></html>`;
}

/** Pointers at 20px (the real size) plus 2x/4x zooms, on three grounds. */
function stripPage() {
  return `<!DOCTYPE html>
<html data-platform="win32">
${pageHead()}
<style>
body { margin: 0; padding: 14px 18px 20px; font: 12px "Segoe UI", system-ui, sans-serif; background: #eef2f8; color: #1b2334; }
h3 { font-size: 12px; margin: 0 0 10px; font-weight: 600; }
.row { display: flex; gap: 24px; align-items: flex-end; flex-wrap: wrap; }
.cell { display: flex; flex-direction: column; align-items: center; gap: 4px; }
.tag { font-size: 10px; color: #5b6478; }
.real { width: 20px; height: 20px; }
.x2 { width: 40px; height: 40px; }
.x4 { width: 80px; height: 80px; }
.dark { margin-top: 10px; padding: 10px 18px; border-radius: 12px; background: #0e1729; }
.dark .tag { color: #8f9dba; }
.mid { margin-top: 10px; padding: 10px 18px; border-radius: 12px; background: #6b7a92; }
.mid .tag { color: #e8edf6; }
svg { display: block; }
</style>
</head>
<body>
<h3>出货指针 · 浅色底 / 深色底 / 中间灰底（第一列是真实出货尺寸）</h3>
<div class="row" id="onLight"></div>
<div class="dark"><div class="row" id="onDark"></div></div>
<div class="mid"><div class="row" id="onMid"></div></div>
<script>${loader(DEFAULT_CONFIG)}</script>
<script>${MOCK_CTX}</script>
<script src="${clientSrc(OUT)}"></script>
<script>
${BOOT}${SCRAPE_CURSORS}
(function () {
  var labels = { default: 'default', pointer: 'pointer', text: 'text', grab: 'grab', forbidden: 'disabled' };
  var names = ['default', 'pointer', 'text', 'grab', 'forbidden'];
  ['onLight', 'onDark', 'onMid'].forEach(function (hostId) {
    var host = document.getElementById(hostId);
    (window.__cursors || []).forEach(function (svg, i) {
      [['real', '20px'], ['x2', '2x'], ['x4', '4x']].forEach(function (pair) {
        var cell = document.createElement('div');
        cell.className = 'cell';
        var box = document.createElement('div');
        box.className = pair[0];
        box.innerHTML = svg;
        var s = box.querySelector('svg');
        s.setAttribute('width', '100%');
        s.setAttribute('height', '100%');
        var cap = document.createElement('div');
        cap.className = 'tag';
        cap.textContent = (labels[names[i]] || '?') + ' ' + pair[1];
        cell.append(box, cap);
        host.append(cell);
      });
    });
  });
})();
</script>
</body></html>`;
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

if (browser === null) {
  console.log('no browser found - writing pages only');
}

/** Optional filter: `node tools/preview.mjs cursors` runs only that step. */
const only = process.argv[2] ?? null;
const want = (step) => only === null || only === step;

// 1. Full shell, both schemes, default preset + the pointer strip.
if (want('shell')) {
  for (const scheme of ['light', 'dark']) {
    const html = path.join(OUT, `${scheme}.html`);
    fs.writeFileSync(html, shellPage(scheme, DEFAULT_CONFIG), 'utf8');
    const png = path.join(OUT, `${scheme}.png`);
    const ok = shoot(html, png, { width: 1180, height: 760 });
    console.log(
      `${scheme}.html -> ` + (ok ? `${scheme}.png (${fs.statSync(png).size} bytes)` : 'screenshot FAILED')
    );
    const dom = dumpDom(html);
    const sheet = dom.includes('id="dsl-theme-style"');
    const applied = (dom.match(/data-applied="([^"]*)"/) ?? [])[1] ?? 'MISSING';
    const count = (dom.match(/data-cursors="(\d+)"/) ?? [])[1];
    console.log(`  dom: sheet=${sheet ? 'ok' : 'MISSING'} apply=[${applied}] cursors=${count ?? '?'}`);
  }
}

// 2. Preset matrix — one swatch per tint per scheme, fanned into one image.
if (want('tints')) {
  const framesDir = path.join(OUT, 'frames');
  fs.mkdirSync(framesDir, { recursive: true });
  for (const scheme of ['light', 'dark']) {
    for (const tint of TINTS) {
      fs.writeFileSync(path.join(framesDir, `${tint}-${scheme}.html`), swatchPage(scheme, tint), 'utf8');
    }
  }
  const matrixHtml = path.join(OUT, 'tints.html');
  fs.writeFileSync(matrixHtml, matrixPage(), 'utf8');
  const matrixPng = path.join(OUT, 'tints.png');
  const matrixOk = shoot(matrixHtml, matrixPng, { width: 1392, height: 500, allowFileAccess: true });
  console.log(`tints.html -> ` + (matrixOk ? `tints.png (${fs.statSync(matrixPng).size} bytes)` : 'screenshot FAILED'));
}

// 3. Pointer strip. Shapes are scraped from the live sheet, never retyped here,
//    so this cannot drift away from what actually ships.
if (want('cursors')) {
  const stripHtml = path.join(OUT, 'cursors.html');
  fs.writeFileSync(stripHtml, stripPage(), 'utf8');
  const stripPng = path.join(OUT, 'cursors.png');
  const stripOk = shoot(stripHtml, stripPng, { width: 1120, height: 400, scale: 2 });
  console.log(
    `cursors.html -> ` + (stripOk ? `cursors.png (${fs.statSync(stripPng).size} bytes)` : 'screenshot FAILED')
  );
}
