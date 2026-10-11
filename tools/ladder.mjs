/**
 * Intensity ladder — the real app shell, rendered once per slider position.
 *
 * This replaces a ladder that was composed from `cascade.mjs`'s renders, and the
 * replacement is the whole point. Those renders show the wallpaper and nothing
 * else: the cascade harness deliberately uses a minimal body, because its job is
 * to prove the *backdrop* survives the official stylesheet. Stitching four of
 * them into a "here is what the slider does" graphic was therefore a claim the
 * artifact could not support — and air called it exactly: "和你的演示图效果完全
 * 不一致".
 *
 * So this tool renders the SAME shell `preview.mjs` renders (imported from
 * harness.mjs, not copied), at four intensities, side by side in one frame. What
 * you see is what the plugin does to a shell, at each end of the control.
 *
 * Two things this version fixes, both of which were defects rather than taste:
 *
 * 1. **The dark row was cropped.** The height was a magic 860 while the content
 *    needed ~1000, so the bottom ~100px of every dark cell — including the
 *    caption — was simply missing. Nothing warned, because a short screenshot
 *    looks like a short page. The height is now measured from the laid-out
 *    document and the image is cut to fit, so adding a row cannot crop again.
 *
 * 2. **The captions state the resolved values.** Reading a blur radius out of a
 *    downscaled screenshot is guessing, and a graphic whose whole job is "show
 *    the difference between the four positions" must not leave its central claim
 *    to the reader's eye. Each cell now carries the computed `backdrop-filter`
 *    of its floating layer, read out of the engine in that cell's own frame.
 *
 *   node tools/ladder.mjs
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
  SCRAPE_CURSORS,
  pageHead,
  APP_SHELL,
  APP_SHELL_CSS,
  clientSrc,
  shoot,
  dumpDom
} from './harness.mjs';

const DIR = path.join(OUT, 'ladder');
const FRAMES = path.join(DIR, 'frames');
const PAGE = path.join(DIR, 'ladder.html');
const SHOT = path.join(OUT, 'ladder.png');

/** Cell size. Matched to the shell's own proportions so nothing is cropped. */
const CELL = { w: 620, h: 400 };
const GAP = 12;
const PAD = { x: 20, bottom: 22 };

const STEPS = [
  { v: 0.2, note: '接近原生' },
  { v: 1.0, note: '中途' },
  { v: 1.6, note: '强' },
  { v: 2.0, note: '全玻璃态' }
];

/**
 * Publish, from inside the frame, (a) what the engine resolved for the floating
 * layer and (b) how tall the outer page is.
 *
 * Base64 rather than the raw string: a computed `backdrop-filter` contains
 * double quotes (`url("#dsl-refract")`), and `--dump-dom` re-serializes
 * attributes with `&quot;`, which turns a one-line regex into an escaping
 * exercise. Base64 is attribute-safe by construction.
 */
const MEASURE = `
<script>
(function () {
  // The pane probe is built rather than queried. The shell ships a real
  // [data-dockkit-float], but panes are matched by an attribute the theme owns
  // and no static node in this fixture carries it — so a querySelector would
  // have reported "pane=absent" for a layer that is very much in the sheet, and
  // the caption would have been quietly wrong about the scoping rule that is
  // the whole point of the design.
  function probe(attrs, label) {
    var el = document.createElement('div');
    Object.keys(attrs).forEach(function (k) { el.setAttribute(k, attrs[k]); });
    el.style.cssText = 'position:fixed;left:-9999px;top:0;width:240px;height:160px';
    document.body.appendChild(el);
    var cs = getComputedStyle(el);
    var v = cs.backdropFilter || cs.webkitBackdropFilter || 'none';
    el.remove();
    return label + '=' + v;
  }
  var parts = [probe({ 'data-dockkit-float': '' }, 'float'), probe({ 'data-dockkit-pane': '' }, 'pane')];
  document.documentElement.dataset.measured =
    btoa(unescape(encodeURIComponent(parts.join(' | '))));
  document.documentElement.dataset.contentHeight = String(Math.ceil(document.body.scrollHeight));
})();
</script>`;

function framePage(intensity, dark) {
  const config = { ...DEFAULT_CONFIG, intensity };
  return `<!DOCTYPE html>
<html data-platform="win32">
${pageHead()}
<style>${APP_SHELL_CSS}
/* The cursor strip is pinned to the bottom of the viewport and would eat a
   third of a 400px-tall cell while telling us nothing about intensity. */
.cursor-strip { display: none !important; }
</style>
</head>
<body${dark ? ' data-ds-dark-theme=""' : ''}>
${APP_SHELL}
<script>${loader(config)}</script>
<script>${MOCK_CTX}</script>
<script src="${clientSrc(FRAMES)}"></script>
<script>${BOOT}${SCRAPE_CURSORS}</script>
${MEASURE}
</body>
</html>`;
}

const esc = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Read one `data-*` attribute out of a dumped DOM, base64-decoded. */
function readMeasured(dump) {
  const m = /data-measured="([A-Za-z0-9+/=]*)"/.exec(dump);
  if (m === null || m[1] === '') return 'unmeasured — the dump had no attribute';
  return Buffer.from(m[1], 'base64').toString('utf8');
}

fs.mkdirSync(FRAMES, { recursive: true });

const measured = new Map();
for (const dark of [false, true]) {
  for (const step of STEPS) {
    const name = `${dark ? 'dark' : 'light'}-${step.v}.html`;
    fs.writeFileSync(path.join(FRAMES, name), framePage(step.v, dark), 'utf8');
    const dump = dumpDom(path.join(FRAMES, name), {
      budget: 900,
      allowFileAccess: true,
      width: CELL.w,
      height: CELL.h
    });
    measured.set(name, readMeasured(dump));
  }
}

const rows = [];
for (const dark of [false, true]) {
  const cells = STEPS.map((step) => {
    const name = `${dark ? 'dark' : 'light'}-${step.v}.html`;
    const value = measured.get(name);
    return `<figure>
  <div class="shot"><iframe src="frames/${name}" width="${CELL.w}" height="${CELL.h}" scrolling="no"></iframe></div>
  <figcaption><b>${step.v.toFixed(1)}x</b> · ${step.note}
    <code>${esc(value)}</code></figcaption>
</figure>`;
  }).join('\n');
  rows.push(
    `<h3>${dark ? '深色 · data-ds-dark-theme' : '浅色'}</h3><div class="row">${cells}</div>`
  );
}

const PAGE_HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  body { margin: 0; padding: 18px ${PAD.x}px ${PAD.bottom}px; background: #e7ebf1;
         font: 12px/1.5 "Segoe UI", system-ui, sans-serif; color: #16202e; }
  h1 { font-size: 15px; margin: 0 0 2px; }
  .lede { margin: 0 0 14px; color: #55627a; max-width: 1180px; }
  h3 { font-size: 12px; margin: 14px 0 8px; color: #3d4a60;
       text-transform: uppercase; letter-spacing: .07em; }
  .row { display: flex; gap: ${GAP}px; align-items: flex-start; }
  figure { margin: 0; }
  .shot { border-radius: 12px; overflow: hidden; box-shadow: 0 8px 22px -12px rgba(8,18,40,.55);
          background: #0b0c0f; line-height: 0; }
  iframe { display: block; border: 0; }
  figcaption { padding: 6px 2px 0; color: #46536a; }
  figcaption b { color: #16202e; }
  figcaption code { display: block; margin-top: 2px; font: 10px/1.45 ui-monospace, Menlo, Consolas, monospace;
                    color: #3b4a63; word-break: break-all; }
</style></head><body>
<h1>强度阶梯 · DeepSeek Harness Liquid Glass</h1>
<p class="lede">
  同一套外壳（与 preview.mjs 共用的定义，不是副本），只改效果强度。上排浅色、下排深色。
  每格下方是该帧里 <code>[data-dockkit-float]</code> 的**实测** computed <code>backdrop-filter</code>
  —— 从真实引擎读出来的，不是从这张缩过的图里看出来的。
</p>
${rows.join('\n')}
${MEASURE}
</body></html>`;

fs.mkdirSync(DIR, { recursive: true });
fs.writeFileSync(PAGE, PAGE_HTML, 'utf8');

console.log('browser:', browser);
const width = PAD.x + STEPS.length * CELL.w + (STEPS.length - 1) * GAP + PAD.x;

// Measure at the width it will be shot at: the lede has a max-width and will
// wrap differently at any other size, which is what a fixed height got wrong.
const probe = dumpDom(PAGE, { budget: 900, allowFileAccess: true, width, height: 400 });
const heightMatch = /data-content-height="(\d+)"/.exec(probe);
if (heightMatch === null) {
  console.error('ladder: the page never reported its content height; refusing to shoot blind');
  process.exit(1);
}
const height = Number(heightMatch[1]);
console.log(`ladder: ${width}x${height} (measured, not guessed)`);

for (const [name, value] of measured) console.log(`  ${name}: ${value}`);

const ok = shoot(PAGE, SHOT, { width, height, allowFileAccess: true, budget: 2500 });
console.log('ladder:', ok, SHOT);
