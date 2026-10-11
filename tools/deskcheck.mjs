/**
 * 「透出桌面」comparison plate.
 *
 * Why this artifact has to exist, and why it is built differently from every
 * other render in this directory:
 *
 * The feature is "stop painting over the OS-composited material behind the
 * window". Its whole effect therefore happens in a region the theme does not
 * own — behind the window — and a page cannot show that region by simply not
 * painting, because there is nothing behind a headless page. Rendered naively,
 * the desktop case comes out as a flat white rectangle, which is an honest
 * measurement (cascade.mjs asserts exactly that, at composite luminance 213
 * versus 31 for the wallpaper) and a useless illustration.
 *
 * So the OS is stood in for, explicitly, in two parts:
 *
 *   #mock-desktop    a synthetic desktop — hard-edged shapes, a taskbar, a fine
 *                    grid — because a filter is only visible against structure.
 *   #mock-backdrop   whatever the patched window reveals. Its filter follows
 *                    STAND_IN_MATERIAL below, which mirrors the material
 *                    `tools/asarpatch.py` installed: `none` is the default and
 *                    is deliberately an identity layer, because the desktop now
 *                    arrives unfiltered. The acrylic filter is kept beside it so
 *                    the plate can still draw the other recipe.
 *
 * Both sit below `#dsl-wallpaper` in the stacking order, which is what makes the
 * comparison exact: at reveal 0 the theme's own opaque backdrop covers them and
 * they are invisible, and the plate is showing the same thing every other render
 * in this directory shows. At reveal 1 the backdrop is gone and what is left is
 * the desktop — the actual, intended result.
 *
 * The captions carry the resolved numbers read out of each frame's own engine,
 * for the same reason ladder.mjs does: a plate whose claim is "these four look
 * different" must not leave the reason to the reader's eye.
 *
 *   node tools/deskcheck.mjs
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
  APP_SHELL,
  APP_SHELL_CSS,
  clientSrc,
  shoot,
  dumpDom
} from './harness.mjs';

const DIR = path.join(OUT, 'desk');
const FRAMES = path.join(DIR, 'frames');
const PAGE = path.join(DIR, 'desk.html');
const SHOT = path.join(OUT, 'deskcheck.png');

const CELL = { w: 640, h: 420 };
const GAP = 12;
const PAD = { x: 20, bottom: 22 };

/**
 * The synthetic desktop.
 *
 * Deliberately full of hard edges and a 26px grid. DWM's acrylic is a blur plus
 * a saturation lift, and neither is visible against a soft gradient — a plate
 * built on one would have shown four identical cells and been believed.
 */
const DESKTOP_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="840">
<defs>
  <linearGradient id="sky" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#12224f"/><stop offset=".42" stop-color="#6d3a86"/>
    <stop offset=".7" stop-color="#c95a44"/><stop offset="1" stop-color="#f0c05a"/>
  </linearGradient>
  <pattern id="grid" width="26" height="26" patternUnits="userSpaceOnUse">
    <path d="M26 0H0v26" fill="none" stroke="#ffffff" stroke-opacity=".10" stroke-width="1"/>
  </pattern>
</defs>
<rect width="1280" height="840" fill="url(#sky)"/>
<rect width="1280" height="840" fill="url(#grid)"/>
<circle cx="905" cy="243" r="96" fill="#ffeaa6" fill-opacity=".92"/>
<circle cx="905" cy="243" r="132" fill="#ffd97a" fill-opacity=".18"/>
<g fill="#ffffff">
  <rect x="118" y="86" width="372" height="248" rx="12" fill-opacity=".15"/>
  <rect x="146" y="116" width="206" height="15" rx="4" fill-opacity=".52"/>
  <rect x="146" y="150" width="298" height="9" rx="3" fill-opacity=".28"/>
  <rect x="146" y="172" width="262" height="9" rx="3" fill-opacity=".28"/>
  <rect x="146" y="194" width="312" height="9" rx="3" fill-opacity=".28"/>
  <rect x="146" y="216" width="180" height="9" rx="3" fill-opacity=".28"/>
  <rect x="640" y="404" width="500" height="300" rx="12" fill-opacity=".13"/>
  <rect x="670" y="436" width="180" height="13" rx="4" fill-opacity=".46"/>
  <rect x="670" y="470" width="360" height="8" rx="3" fill-opacity=".26"/>
  <rect x="670" y="490" width="320" height="8" rx="3" fill-opacity=".26"/>
  <rect x="670" y="510" width="392" height="8" rx="3" fill-opacity=".26"/>
</g>
<g>
  <rect x="150" y="470" width="86" height="86" rx="16" fill="#4ea1ff" fill-opacity=".9"/>
  <rect x="262" y="470" width="86" height="86" rx="16" fill="#39d0a0" fill-opacity=".9"/>
  <rect x="374" y="470" width="86" height="86" rx="16" fill="#ff9f43" fill-opacity=".9"/>
  <rect x="486" y="470" width="86" height="86" rx="16" fill="#ff6b81" fill-opacity=".9"/>
</g>
<rect x="0" y="778" width="1280" height="62" fill="#05070d" fill-opacity=".58"/>
<g fill="#ffffff">
  <rect x="26" y="792" width="34" height="34" rx="9" fill-opacity=".85"/>
  <rect x="74" y="792" width="34" height="34" rx="9" fill-opacity=".55"/>
  <rect x="122" y="792" width="34" height="34" rx="9" fill-opacity=".35"/>
  <rect x="170" y="792" width="34" height="34" rx="9" fill-opacity=".35"/>
  <rect x="1180" y="798" width="72" height="22" rx="6" fill-opacity=".28"/>
</g>
</svg>`;

const DESKTOP_URL = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(DESKTOP_SVG)}`;

/**
 * Which material this plate models.
 *
 * It has to name the one the archive actually carries, because the plate's whole
 * job is to draw the *result* of that patch rather than a generic "transparent
 * window" — and the two recipes look nothing alike. Measured with
 * tools/materialprobe.py against a checkerboard of known edge energy hidden
 * behind the window: `none` keeps 0.875 of it (the desktop arrives as it is),
 * `acrylic` keeps 0.011 (which is the "高斯模糊" air rejected twice). When the
 * patch is switched with `--material`, this is the one line that follows it.
 */
const STAND_IN_MATERIAL = 'none';

const MATERIAL_CSS = {
  none: '',
  acrylic: `
  backdrop-filter: blur(30px) saturate(1.25);
  -webkit-backdrop-filter: blur(30px) saturate(1.25);
  background: rgba(255, 255, 255, 0.05);`
};

/** The two layers standing in for the OS, plus the plate's own page chrome. */
const STAND_IN_CSS = `
/* Stand-in for the desktop. z-index -3 so it paints above html's canvas and
   below the theme's backdrop (-1) — the ordering is what makes the comparison
   honest rather than staged. */
#mock-desktop {
  position: fixed; inset: 0; z-index: -3; pointer-events: none;
  background-image: url("${DESKTOP_URL}");
  background-size: cover; background-position: center;
}
/* Whatever the patched window reveals, minus the window. With
   STAND_IN_MATERIAL = 'none' this element paints nothing and filters nothing —
   on purpose: the desktop is supposed to arrive untouched, so an identity layer
   is the correct stand-in, and it is left in place (rather than deleted) so the
   plate can be switched to the acrylic recipe without touching the DOM. */
#mock-backdrop {
  position: fixed; inset: 0; z-index: -2; pointer-events: none;${MATERIAL_CSS[STAND_IN_MATERIAL]}
}
/* The fixture's cursor strip would eat a third of a 420px cell and says nothing
   about window transparency. */
.cursor-strip { display: none !important; }
`;

/**
 * Publish the resolved state of the three things the plate is claiming, from
 * inside each frame.
 *
 * The height goes out FIRST, before anything that can throw. This script also
 * runs in the outer page, where `#dsl-wallpaper` and `#mock-acrylic` live inside
 * iframes and are therefore absent — and a `getComputedStyle(null)` made the
 * whole IIFE die before the height was reported, which the tool correctly
 * refused to shoot without. Reporting the one measurement the shot depends on
 * before the ones it merely annotates makes that class of failure impossible.
 *
 * Base64 for the same reason ladder.mjs uses it: the computed `backdrop-filter`
 * contains double quotes and `--dump-dom` re-serializes attributes with
 * `&quot;`, which turns a one-line regex into an escaping exercise.
 */
const MEASURE = `
<script>
(function () {
  document.documentElement.dataset.contentHeight = String(Math.ceil(document.body.scrollHeight));
  var out;
  try {
    var body = getComputedStyle(document.body);
    var wall = document.getElementById('dsl-wallpaper');
    var acrylic = document.getElementById('mock-backdrop');
    out = {
      reveal: body.getPropertyValue('--dsl-reveal').trim() || '(none)',
      opacity: wall === null ? '(no layer)' : String(getComputedStyle(wall).opacity),
      base: body.getPropertyValue('--dsw-alias-bg-base').trim() || '(none)',
      html: getComputedStyle(document.documentElement).backgroundColor,
      backdrop: acrylic === null ? '(none)' : String(getComputedStyle(acrylic).backdropFilter || '(none)'),
      material: '${STAND_IN_MATERIAL}',
      // The other two things that stand between the desktop and the eye, and
      // the two that the reveal number alone cannot speak for: the frosted
      // panes' own blur, and the fill every content tier paints over it. At
      // 2.0x the reveal is already exactly 1 and --dsw-alias-bg-base is
      // already alpha 0 — so if the window still does not read as clear, it is
      // one of these, and a caption that reported only the first two would
      // point at the wrong one.
      blur: body.getPropertyValue('--dsl-blur').trim() || '(none)',
      layer1: body.getPropertyValue('--dsw-alias-bg-layer-1').trim() || '(none)',
      layer2: body.getPropertyValue('--dsw-alias-bg-layer-2').trim() || '(none)',
      sidebar: body.getPropertyValue('--dsw-specific-sidebar-fill').trim() || '(none)',
      menu: body.getPropertyValue('--dsw-menu-surface-fill').trim() || '(none)',
      // The per-message plate, read as a token rather than as pixels. It is the
      // only one of the three new controls that leaves no trace in any other
      // number on this page — it does not touch a tier, a blur or the backdrop —
      // so a caption that did not name it would show a plate switched on and
      // render exactly like a plate switched off.
      plate: body.getPropertyValue('--dsl-plate').trim() || '(none)'
    };
  } catch (error) {
    out = { error: String(error) };
  }
  document.documentElement.dataset.measured =
    btoa(unescape(encodeURIComponent(JSON.stringify(out))));
})();
</script>`;

const CASES = [
  { id: 'off', label: '2.0x · 透出桌面 关', note: '只在主题自己的背板上做玻璃', config: { intensity: 2 } },
  { id: 'on2', label: '2.0x · 透出桌面 开', note: '窗口底板全开，材质是背后的桌面', config: { intensity: 2, desktop: true } },
  { id: 'on1', label: '1.0x · 透出桌面 开', note: '默认位：约三分之一透出', config: { intensity: 1, desktop: true } },
  { id: 'on02', label: '0.2x · 透出桌面 开', note: '底端：与原生几乎无差别', config: { intensity: 0.2, desktop: true } },
  // The two new axes, both off their defaults at once. This is the state the
  // round was added for: the shell is as open as it goes, the frost has been
  // taken off the slider and pinned, and the floor is in force on the tiers that
  // carry text. Measured here rather than argued about, because "fully open" and
  // "still frosted" used to be mutually exclusive on one slider.
  {
    id: 'tuned',
    label: '2.0x · 透出桌面 开 · 磨砂 18px · 每段对话底板 50%',
    // The four tiers the caption prints underneath have to come back the SAME as
    // the second cell: the plate is a rule on the conversation rows now, not a
    // floor under every text-carrying tier. That is the whole difference between
    // this control and merely turning the intensity down, and it is why this cell
    // exists — the previous version of it printed 0.5 in all four slots.
    note: '外壳全开，四档 alpha 与第 2 格逐位相同',
    config: { intensity: 2, desktop: true, frost: 18, plate: true, plateLevel: 0.5 }
  }
];

function framePage(entry) {
  const config = { ...DEFAULT_CONFIG, ...entry.config, material: 'patched' };
  return `<!DOCTYPE html>
<html data-platform="win32">
${pageHead()}
<style>${APP_SHELL_CSS}${STAND_IN_CSS}</style>
</head>
<body data-ds-dark-theme="">
<div id="mock-desktop" aria-hidden="true"></div>
<div id="mock-backdrop" aria-hidden="true"></div>
${APP_SHELL}
<script>${loader(config)}</script>
<script>${MOCK_CTX}</script>
<script src="${clientSrc(FRAMES)}"></script>
<script>${BOOT}</script>
${MEASURE}
</body>
</html>`;
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Read one `data-*` attribute out of a dumped DOM.
 *
 * The escaped quote is undone first: `--dump-dom` writes `&quot;` inside
 * attribute values, so a JSON payload containing `url("#dsl-refract")` comes
 * back with the quotes mangled and `JSON.parse` throws on it.
 */
function readAttr(dump, name) {
  const m = new RegExp(`data-${name}="([A-Za-z0-9+/=]*)"`).exec(dump);
  if (m === null || m[1] === '') return null;
  return Buffer.from(m[1], 'base64').toString('utf8');
}

fs.mkdirSync(FRAMES, { recursive: true });

const measured = new Map();
for (const entry of CASES) {
  const name = `${entry.id}.html`;
  fs.writeFileSync(path.join(FRAMES, name), framePage(entry), 'utf8');
  const dump = dumpDom(path.join(FRAMES, name), {
    budget: 1200,
    allowFileAccess: true,
    width: CELL.w,
    height: CELL.h
  });
  const raw = readAttr(dump, 'measured');
  let parsed = null;
  try {
    parsed = raw === null ? null : JSON.parse(raw);
  } catch {
    parsed = null;
  }
  measured.set(name, parsed);
}

const cells = CASES.map((entry) => {
  const name = `${entry.id}.html`;
  const m = measured.get(name);
  const detail =
    m === null
      ? '未取到实测值'
      : `reveal ${m.reveal} · 背板 opacity ${m.opacity} · bg-base ${m.base}`;
  const extra = m === null ? '' : `html ${m.html} · 材质 ${m.material} / ${esc(m.backdrop)}`;
  // The two levers the reveal number cannot speak for. At 2.0x `reveal` is
  // already exactly 1 and `bg-base` is already alpha 0, so a plate that captioned
  // only those would say "fully open" over a window that is still frosted — which
  // is precisely the reading air's "拉满还是像高斯模糊" was made from. Named
  // separately so the caption cannot make that claim again.
  const glass =
    m === null ? '' : `模糊 ${m.blur} · 侧栏 ${m.sidebar} · 内容层 ${m.layer2} · 菜单 ${m.menu}`;
  const plateLine = m === null ? '' : `每段对话底板 --dsl-plate ${m.plate}`;
  return `<figure${entry.config.desktop ? ' class="on"' : ''}>
  <div class="shot"><iframe src="frames/${name}" width="${CELL.w}" height="${CELL.h}" scrolling="no"></iframe></div>
  <figcaption><b>${entry.label}</b><span class="note">${entry.note}</span>
    <code>${esc(detail)}</code>
    <code class="dim">${esc(glass)}</code>
    <code class="dim">${esc(plateLine)}</code>
    <code class="dim">${extra}</code></figcaption>
</figure>`;
}).join('\n');

const PAGE_HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  body { margin: 0; padding: 18px ${PAD.x}px ${PAD.bottom}px; background: #e7ebf1;
         font: 12px/1.5 "Segoe UI", system-ui, sans-serif; color: #16202e; }
  h1 { font-size: 15px; margin: 0 0 2px; }
  .lede { margin: 0 0 8px; color: #55627a; max-width: 2500px; }
  .lede.warn { color: #7a3c1e; background: #fdf1e6; border-left: 3px solid #e08b46;
               padding: 7px 10px; border-radius: 0 8px 8px 0; }
  .lede.dimmed { color: #6f7b8d; margin-bottom: 16px; }
  .row { display: flex; gap: ${GAP}px; align-items: flex-start; }
  figure { margin: 0; }
  .shot { border-radius: 12px; overflow: hidden; box-shadow: 0 8px 22px -12px rgba(8,18,40,.55);
          background: #0b0c0f; line-height: 0; }
  figure.on .shot { box-shadow: 0 8px 22px -10px rgba(8,18,40,.55), 0 0 0 2px #2f6df0; }
  iframe { display: block; border: 0; }
  figcaption { padding: 7px 2px 0; color: #46536a; }
  figcaption b { color: #16202e; display: block; }
  figcaption .note { display: block; color: #6b7789; }
  figcaption code { display: block; margin-top: 3px; font: 10px/1.45 ui-monospace, Menlo, Consolas, monospace;
                    color: #2f4a72; word-break: break-all; }
  figcaption code.dim { color: #7b8698; }
</style></head><body>
<h1>透出桌面 · DeepSeek Harness Liquid Glass</h1>
<p class="lede">
  深色模式。最底下那层是<b>合成的桌面</b>（硬边形状 + 26px 网格 —— 滤镜只在有结构的地方
  看得出来），再上面才是应用外壳，中间那层 <code>#mock-backdrop</code> 代表「补丁后的窗口
  会露出什么」。本轮补丁把材质换成了 <code>backgroundMaterial: "none"</code>，
  所以这一层现在是<b>恒等层</b>：不模糊、不染色，桌面原样到达眼睛。
  两层的 z-index 都在主题背板之下，所以「关」那一格被完全盖住、「开」到 2.0 时才露出来 ——
  这正是补丁后真窗上发生的事，只不过这里的桌面是画的，DWM 那边是真的。
  每格下方的数字是从该帧自己的引擎里读出来的实测值，不是从这张缩过的图里看出来的。
</p>
<p class="lede warn">
  <b>两件要说清的事。</b>一、第 2 格（2.0x · 开）里桌面是真的压过了 UI，正文对比度下降，
  这是把高饱和照片放到正文底下必然的结果 —— 也正是「整个窗口全透明」的代价。
  这一轮已经把四样挡在桌面和眼睛之间的东西全部推到零（窗口底板 <code>0</code>、
  主题背板 <code>opacity 0</code>、<code>blur(0px)</code>、以及窗口背面的
  <code>backgroundMaterial: "acrylic"</code>），剩下来的是四个
  <code>0.04 / 0.04 / 0.07 / 0.16</code> 的薄层 —— 菜单仍然是最实的那个，因为它是承载
  文字的浮起面。
  <b>可读性这一条现在有控件了</b>（最后一格就是它打开的样子）：<code>磨砂模糊</code> 可以把
  背景细节压掉、<code>内容底板</code> 可以只给承载正文的几档加一个不透明度下限，两者都不必
  牺牲外壳的透明度。在那之前这是个纯取舍 —— 拉满就是 0.04，正文对比度约
  <code>1.04:1</code>（按正文 <code>#0f1115</code>、底色 <code>#fff</code> 合成算），
  远低于 4.5:1。
  <b>第四样（材质）值得单独记一笔</b>：它不在页面里，CSS 侧再怎么量也量不到它，
  所以前三样归零之后窗口还是糊的 —— 那是 <code>tools/materialprobe.py</code>
  以前面这层棋盘为参照量出来的，不是从这张图里看出来的。
  二、<b>第 3 格（1.0x · 开）看起来几乎等于第 1 格，这是设计而不是没生效</b>：
  淡出走 <code>reveal = glass²</code>，所以默认位只放开 35%，整条滑块的前半段基本不动，
  能看出桌面集中在最上面三分之一。若你希望它更早开始透，改一行曲线即可。
</p>
<p class="lede dimmed">
  读法：<code>reveal</code> 是「桌面被放开的比例」，<code>背板 opacity</code> 是主题自己那层
  灰底还剩多少，<code>bg-base</code> 是整窗底板的 alpha，<code>html</code> 是窗口画布本身的颜色
  —— <code>rgba(0, 0, 0, 0)</code> 就是「底板全开」，往后就是桌面本身。
  每格的合成亮度可以自己复核：<code>python tools/pixstat.py tools/_preview/deskcheck.png --box x,200,x+640,560</code>
  （x 依次为 20 / 672 / 1324 / 1976，读 <code>box_mean</code> / <code>box_luma</code>）。
  最后一行 <code>模糊 / 侧栏 / 内容层 / 菜单</code> 是这一轮新加的，因为前面的数说不了它们：
  2.0x 时 <code>reveal</code> 已经是 1、<code>bg-base</code> 已经是 0，如果窗口还是不透，
  剩下的嫌疑人只有这几个 —— 只报前两个的图会把手指指向错的那一个。
</p>
<div class="row">
${cells}
</div>
${MEASURE}
</body></html>`;

fs.mkdirSync(DIR, { recursive: true });
fs.writeFileSync(PAGE, PAGE_HTML, 'utf8');

console.log('browser:', browser);
const width = PAD.x * 2 + CASES.length * CELL.w + (CASES.length - 1) * GAP;

// Measure at the width it will actually be shot at: the lede has a max-width and
// wraps differently at any other size. A fixed height is what cropped the dark
// row of the old intensity ladder, silently.
const probe = dumpDom(PAGE, { budget: 1200, allowFileAccess: true, width, height: 400 });
const heightMatch = /data-content-height="(\d+)"/.exec(probe);
if (heightMatch === null) {
  console.error('deskcheck: the page never reported its content height; refusing to shoot blind');
  process.exit(1);
}
const height = Number(heightMatch[1]);
console.log(`deskcheck: ${width}x${height} (measured, not guessed)`);

for (const [name, value] of measured) {
  console.log(`  ${name}: ${value === null ? 'unmeasured' : JSON.stringify(value)}`);
}

const ok = shoot(PAGE, SHOT, { width, height, allowFileAccess: true, budget: 2500 });
console.log('deskcheck:', ok, SHOT);
if (!ok) process.exitCode = 1;
