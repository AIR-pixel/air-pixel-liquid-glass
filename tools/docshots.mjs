/**
 * Storefront shots: the images the README and the plugin market show.
 *
 *   node tools/docshots.mjs            # every shot
 *   node tools/docshots.mjs hero       # just one
 *
 * Output goes to `assets/`, which is deliberately OUTSIDE the package's `files`
 * whitelist: the market and the catalog read these from the repository, not
 * from the npm tarball, so shipping them inside the package would be dead
 * weight. `screenshots.json` next to `package.json` is what the market reads.
 *
 * WHY RENDERS RATHER THAN A SCREEN GRAB. `tools/appshot.py` photographs the real
 * window, and for an opaque window it does it perfectly — but PrintWindow hands
 * back BGRA and the read-back drops alpha, so a see-through window arrives as a
 * black rectangle. Its own note measures this: for a `none` material the screen
 * says luma 129.0 and PrintWindow says 0.2. The one thing this theme is for is
 * the one thing that capture cannot show. A screen-region grab would work, but
 * it would carry whatever else is on the desktop into a public repository,
 * which is not a trade worth making.
 *
 * So these are renders of the real `client.js` in the stand-in shell, over a
 * drawn desktop, and the README says so. Two things are forced, and both are
 * forced because the alternative is a picture of a control rather than of what
 * it does:
 *
 *   · the stubbed host response reports `material: 'patched'` — `revealOf()`
 *     returns 0 without it, so every 透出桌面 frame would come back with the
 *     window still shut;
 *   · the mock thread is given the app's own `[data-chat-flow]` contract, which
 *     每段对话底板 rides on and which harness.mjs's stand-in shell predates.
 */
import fs from 'node:fs';
import path from 'node:path';

import {
  HERE,
  ROOT,
  OUT,
  DEFAULT_CONFIG,
  MOCK_CTX,
  APP_SHELL,
  APP_SHELL_CSS,
  SCRAPE_CURSORS,
  browser,
  BOOT,
  pageHead,
  clientSrc,
  shoot
} from './harness.mjs';

const DIR = path.join(ROOT, 'assets');
const STAGE = path.join(OUT, 'docshots');
fs.mkdirSync(DIR, { recursive: true });
fs.mkdirSync(STAGE, { recursive: true });

const W = 1600;
const H = 1000;

// ---------------------------------------------------------------------------
// The stand-in host, plus the one field the real host adds
// ---------------------------------------------------------------------------

/**
 * `harness.mjs`'s `loader()` answers the config GET with the config document
 * alone, which leaves `windowMaterial` at `unknown` — so every 透出桌面 frame
 * would come back with the window still closed. This adds `material` and
 * `windowBlurReport` to the same response rather than inventing a second host
 * surface; everything else about the stub is identical.
 */
function storeLoader(config) {
  return `
window.__ModuleLoader__ = { load: (def) => { window.__dshPlugin = def; } };
window.__reactStub = {
  Fragment: 'fragment',
  createElement: () => null,
  useReducer: (_r, i) => [i, () => {}],
  useState: (i) => [i, () => {}],
  useEffect: () => {},
  useCallback: (f) => f
};
(function () {
  var CFG = ${JSON.stringify(config)};
  var real = typeof window.fetch === 'function' ? window.fetch.bind(window) : null;
  window.fetch = function (url, init) {
    if (String(url).indexOf('/api/theme-liquid-glass/config') !== -1) {
      var body = Object.assign({}, CFG, {
        material: 'patched',
        materialWhy: null,
        saved: true,
        windowBlurReport: { active: true, why: null, material: 'patched' }
      });
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: function () { return 'application/json'; } },
        json: function () { return Promise.resolve(body); },
        text: function () { return Promise.resolve(JSON.stringify(body)); }
      });
    }
    if (real !== null) return real(url, init);
    return Promise.reject(new Error('offline'));
  };
})();
`;
}

// ---------------------------------------------------------------------------
// The desktop stand-in
// ---------------------------------------------------------------------------

/**
 * A drawn desktop, not a photograph of one.
 *
 * Two jobs. Structurally it has to be busier than a gradient: a see-through
 * window is only legible against *content*, and the icons plus the taskbar are
 * what make "the desktop is coming through" readable without a caption.
 * Legally it has to be ours — a Windows wallpaper or a grab of air's own screen
 * would both be somebody else's pixels in a public repository.
 *
 * Two tones, because the theme's light and dark schemes need opposite grounds
 * to be legible at all: a dark desktop under light glass composites body copy
 * to roughly 1:1, which is the failure 每段对话底板 exists to fix, and a
 * storefront shot is not the place to reproduce it by accident.
 */
const DESK_TONES = {
  dark: `
  background:
    radial-gradient(58% 46% at 84% 96%, rgba(255,196,120,0.72) 0%, rgba(255,196,120,0) 62%),
    radial-gradient(46% 40% at 76% 10%, rgba(120,198,255,0.5) 0%, rgba(120,198,255,0) 64%),
    radial-gradient(80% 70% at 6% 116%, rgba(176,120,255,0.78) 0%, rgba(176,120,255,0) 68%),
    linear-gradient(148deg, #0c1530 0%, #16244f 28%, #33215f 54%, #6f2f68 76%, #b8543f 100%);
`,
  light: `
  background:
    radial-gradient(60% 48% at 86% 92%, rgba(255,206,168,0.9) 0%, rgba(255,206,168,0) 62%),
    radial-gradient(48% 42% at 72% 6%, rgba(150,206,255,0.85) 0%, rgba(150,206,255,0) 66%),
    radial-gradient(76% 66% at 4% 112%, rgba(186,166,255,0.8) 0%, rgba(186,166,255,0) 70%),
    linear-gradient(146deg, #f2f6fd 0%, #e4ecfa 30%, #f6e9f2 58%, #fbe6d8 80%, #e8f1f7 100%);
`
};

const DESK_CSS = (tone) => `
#desk { position: fixed; inset: 0; z-index: -3; overflow: hidden; pointer-events: none;
  ${DESK_TONES[tone]}}
#desk .mesh { position: absolute; inset: 0; opacity: 0.5;
  background-image:
    linear-gradient(${tone === 'dark' ? 'rgba(255,255,255,0.05)' : 'rgba(20,40,90,0.05)'} 1px, transparent 1px),
    linear-gradient(90deg, ${tone === 'dark' ? 'rgba(255,255,255,0.05)' : 'rgba(20,40,90,0.05)'} 1px, transparent 1px);
  background-size: 48px 48px;
  mask-image: radial-gradient(120% 90% at 50% 40%, #000 20%, transparent 78%); }
.dicons { position: absolute; display: grid;
  grid-auto-flow: row; grid-template-rows: repeat(5, 86px); width: 68px; }
/* Outside the frame on the left, so the desk reads as a desk; inside it on the
   right, where the panel is empty, so the icons are visibly *behind* the glass.
   One column does each job and neither has to be inferred. */
.dicons.left { left: 7px; top: 34px; }
.dicons.right { right: 168px; top: 496px; grid-template-rows: repeat(3, 86px); }
.dicon { display: flex; flex-direction: column; align-items: center; gap: 5px;
  font-family: var(--dsw-font-family, system-ui, sans-serif); }
.dicon .tile { width: 42px; height: 42px; border-radius: 12px;
  box-shadow: 0 6px 14px -4px rgba(3,8,24,0.5), inset 0 1px 0 rgba(255,255,255,0.4); }
.dicon span { font-size: 10.5px; line-height: 1.2; text-align: center;
  color: ${tone === 'dark' ? '#fff' : '#12203c'};
  text-shadow: ${tone === 'dark' ? '0 1px 3px rgba(0,0,0,0.85), 0 0 8px rgba(0,0,0,0.6)' : '0 1px 2px rgba(255,255,255,0.95), 0 0 6px rgba(255,255,255,0.9)'}; }
.dtask { position: absolute; left: 0; right: 0; bottom: 0; height: 48px;
  display: flex; align-items: center; justify-content: center; gap: 10px;
  background: ${tone === 'dark' ? 'rgba(10,14,30,0.46)' : 'rgba(255,255,255,0.42)'};
  backdrop-filter: blur(24px) saturate(1.3); -webkit-backdrop-filter: blur(24px) saturate(1.3);
  border-top: 1px solid ${tone === 'dark' ? 'rgba(255,255,255,0.16)' : 'rgba(255,255,255,0.75)'}; }
.dtask i { display: block; width: 34px; height: 34px; border-radius: 10px; }
.dtask i.wide { width: 168px; background: ${tone === 'dark' ? 'rgba(255,255,255,0.16)' : 'rgba(255,255,255,0.55)'};
  box-shadow: inset 0 0 0 1px ${tone === 'dark' ? 'rgba(255,255,255,0.18)' : 'rgba(16,36,72,0.12)'}; }
`;

const ICON_TINT = [
  ['#6aa9ff', '#3d6ff2'],
  ['#ffd166', '#f0932b'],
  ['#7ee0c0', '#25a184'],
  ['#ff9aa8', '#e2456b'],
  ['#c39bff', '#7d4bf0'],
  ['#a8f0a0', '#3fa35a'],
  ['#ffb27a', '#e2713a'],
  ['#8fd8ff', '#2f86c9']
];

/**
 * The icons live in columns at the two outer edges, outside the frame on
 * purpose. Behind the window they would sit under the sidebar's own labels,
 * which reads as a rendering fault rather than as transparency; on the desk
 * beside it they do the job they exist for — they say "desktop" — and the
 * wallpaper still does the work of showing what comes through the glass.
 */
function deskMarkup() {
  const chips = [
    ['left', ['此电脑', '回收站', '文档', '项目', '下载']],
    ['right', ['图片', '音乐', '视频']]
  ];
  const columns = chips
    .map(([side, labels]) =>
      `<div class="dicons ${side}">` +
      labels
        .map((text, i) => {
          const [a, b] = ICON_TINT[(side === 'left' ? i : i + 5) % ICON_TINT.length];
          return `<div class="dicon"><div class="tile" style="background:linear-gradient(150deg,${a},${b})"></div><span>${text}</span></div>`;
        })
        .join('') +
      '</div>'
    )
    .join('\n  ');
  const tiles = ICON_TINT.slice(0, 5)
    .map(([a, b]) => `<i style="background:linear-gradient(150deg,${a},${b})"></i>`)
    .join('');
  return `<div id="desk" aria-hidden="true">
  <div class="mesh"></div>
  ${columns}
  <div class="dtask"><i class="wide"></i>${tiles}<i class="wide"></i></div>
</div>`;
}

/**
 * The window. `translateZ(0)` is not decoration: without a containing block the
 * theme's fixed layers resolve against the viewport and escape the radius, and
 * the frame comes back with the desktop painted across its corners.
 */
const FRAME_CSS = `
.win { position: fixed; inset: 42px 84px 58px 84px; border-radius: 16px; overflow: hidden;
  transform: translateZ(0);
  box-shadow: 0 46px 92px -34px rgba(3,8,24,0.88), 0 0 0 1px rgba(255,255,255,0.13); }
.win #root { height: 100%; }
`;

// ---------------------------------------------------------------------------
// Doc-time DOM enrichment
// ---------------------------------------------------------------------------

/**
 * Give the stand-in thread the app's own conversation contract, and enough
 * content for a full-transparency frame to be about something.
 *
 * `PLATE_SELECTOR` is `[data-chat-flow] > [data-chat-flow-key]`, and
 * `data-chat-flow-kind` decides which side a row belongs to. The shell in
 * harness.mjs predates that feature, so without this the 每段对话底板 frame
 * would document the feature with a picture of nothing. Only attributes the
 * app itself sets are added here — no rule of the theme is restated, and the
 * panel chooses every colour.
 *
 * The extra rows are demo content, in the same spirit as the two the shell
 * already carries. They are here because a see-through window with an empty
 * shell in it reads as a broken render rather than as a transparent one.
 */
const ENRICH_ROWS = [
  ['user', '把主题的对比度再调一调'],
  ['bot', '已调整 <code>--dsw-alias-bg-base</code> 与壁纸透明度，现在底层色调可以透出来了。',
    'html:has(body[data-ds-dark-theme]) { background-color: #0b1220; }'],
  ['user', '玻璃拉满以后正文也得看得清，别糊成一片'],
  ['bot', '给每段对话加了一层底板：<code>plateLevel 0.85</code>，问与答各用各的色，正文不再跟着窗口一起变透。',
    '[data-chat-flow] &gt; [data-chat-flow-key] { background: var(--dsl-plate); }'],
  ['user', '窗口模糊开了吗？'],
  ['bot', '已经交给系统合成器了。这个构建只提供设置接口、没有读取接口，屏幕上就是结果。'],
  ['user', '指针和涟漪也一起打开'],
  ['bot', '都在设置里：五个指针一次替换；涟漪按下亮起镜面反光，松开向外扩散，尺寸和强度各是一个滑杆。']
];

/** The thread, at the row count the frame can actually hold. */
function enrichThread(turns) {
  return `
(function () {
  var thread = document.querySelector('.thread');
  if (thread === null) return;
  var rows = ${JSON.stringify(ENRICH_ROWS.slice(0, turns))};
  thread.innerHTML = rows
    .map(function (r) {
      var cls = r[0] === 'user' ? 'turn user' : 'turn bot';
      var code = r[2] ? '<div class="code">' + r[2] + '</div>' : '';
      return '<div class="' + cls + '">' + r[1] + code + '</div>';
    })
    .join('');
  thread.setAttribute('data-chat-flow', '');
  Array.prototype.forEach.call(thread.querySelectorAll('.turn'), function (el, i) {
    el.setAttribute('data-chat-flow-key', 'shot-' + i);
    el.setAttribute('data-chat-flow-kind', el.classList.contains('user') ? 'user' : 'turn-process');
    el.setAttribute('data-chat-turn', String(1 + (i >> 1)));
  });
})();`;
}

/**
 * A populated sidebar, and the floats moved where a full-size window has room
 * for them.
 *
 * The shell's own coordinates put the dialog straight across the sidebar, and
 * its two extra conversation rows are not enough to fill a 1600x1000 frame —
 * the middle of the window comes back as empty desktop, which reads as a
 * missing render rather than as transparency. Both are layout facts about this
 * window size, which is why they are applied only where this window size is
 * what was asked for.
 */
const ENRICH_CHROME = `
(function () {
  var side = document.querySelector('.side');
  if (side !== null) {
    ['搜索', '最近', 'default-workspace', '有没有什么能提高 agent 审美的', 'npm 是啥'].forEach(function (text, i) {
      var row = document.createElement('div');
      row.className = 'nav-item';
      if (i >= 2) { row.style.opacity = '0.74'; row.style.fontSize = '12px'; }
      row.textContent = text;
      side.append(row);
    });
  }
  var dlg = document.querySelector('#root .dlg');
  if (dlg !== null) { dlg.style.left = '212px'; dlg.style.top = '352px'; dlg.style.width = '352px'; }
  var menu = document.querySelector('#root .dd');
  if (menu !== null) { menu.style.left = '612px'; menu.style.top = '392px'; }
  var float = document.querySelector('#root .ft');
  if (float !== null) { float.style.left = '212px'; float.style.bottom = '86px'; float.style.top = 'auto'; float.style.right = 'auto'; }
})();`;

// ---------------------------------------------------------------------------
// Page builders
// ---------------------------------------------------------------------------

function appPage({
  name,
  scheme = 'light',
  tone = 'light',
  config = {},
  css = '',
  script = '',
  framed = false,
  desk = true,
  turns = 0,
  chrome = false
}) {
  const dir = path.join(STAGE, name);
  fs.mkdirSync(dir, { recursive: true });
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const html = `<!DOCTYPE html>
<html data-platform="win32">
${pageHead()}
<style>${APP_SHELL_CSS}${desk ? DESK_CSS(tone) : ''}${framed ? FRAME_CSS : ''}${css}</style>
</head>
<body${scheme === 'dark' ? ' data-ds-dark-theme=""' : ''}>
${desk ? deskMarkup() : ''}
${framed ? `<div class="win">${APP_SHELL}</div>` : APP_SHELL}
<script>${storeLoader(cfg)}</script>
<script>${MOCK_CTX}</script>
<script src="${clientSrc(dir)}"></script>
<script>${BOOT}${turns > 0 ? enrichThread(turns) : ''}${chrome ? ENRICH_CHROME : ''}${script}</script>
</body>
</html>`;
  const file = path.join(dir, 'index.html');
  fs.writeFileSync(file, html, 'utf8');
  return file;
}

const PAGE_CSS = `
body { margin: 0; background: #eef1f6; color: #16203a;
  font-family: "Segoe UI", "Microsoft YaHei", system-ui, sans-serif; }
h3 { margin: 0 0 14px; font-size: 14px; font-weight: 600; }
figure { margin: 0; }
iframe { display: block; border: 0; border-radius: 12px; background: #fff;
  box-shadow: 0 18px 40px -18px rgba(14,26,54,.5), 0 2px 6px rgba(14,26,54,.1); }
figcaption { display: flex; flex-direction: column; gap: 2px; padding: 10px 2px 0; font-size: 12.5px; }
figcaption b { font-size: 13px; }
figcaption span { color: #5b6584; }
`;

/** A row of local pages fanned into one labelled image. */
function sheetPage(name, heading, cells, { pad = 22 } = {}) {
  const rows = cells
    .map(
      (c) => `<figure>
  <iframe src="${c.src}" width="${c.w}" height="${c.h}" scrolling="no"></iframe>
  <figcaption><b>${c.label}</b>${c.note ? `<span>${c.note}</span>` : ''}</figcaption>
</figure>`
    )
    .join('\n');
  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>${PAGE_CSS}
body { padding: ${pad}px; }
.row { display: flex; gap: 20px; }
figure { flex: none; }
</style></head>
<body><h3>${heading}</h3><div class="row">${rows}</div></body></html>`;
  const file = path.join(STAGE, `${name}.html`);
  fs.writeFileSync(file, html, 'utf8');
  return file;
}

function sheetPng(name, page, png, width, height, opts = {}) {
  const ok = shoot(page, png, { width, height, allowFileAccess: true, ...opts });
  console.log(`${name.padEnd(12)} -> ${path.relative(ROOT, png).replace(/\\/g, '/')} ` + (ok ? `(${(fs.statSync(png).size / 1024).toFixed(0)} KB)` : 'FAILED'));
  return ok;
}

function single(name, page, png, opts = {}) {
  const ok = shoot(page, png, { width: W, height: H, ...opts });
  console.log(`${name.padEnd(12)} -> ${path.relative(ROOT, png).replace(/\\/g, '/')} ` + (ok ? `(${(fs.statSync(png).size / 1024).toFixed(0)} KB)` : 'FAILED'));
  return ok;
}

// ---------------------------------------------------------------------------
// Shots
// ---------------------------------------------------------------------------

const only = process.argv[2] ?? null;
const want = (name) => only === null || only === name;
const results = {};

// 1. The hero: 强度 2.0 with 透出桌面 on, so the desk reaches the eye
//    unfiltered — that is the whole claim, and at this end of the slider there
//    is deliberately no frost left between the desktop and the panel to argue
//    about. 每段对话底板 carries the copy, which is the only reason a fully
//    open shell is readable at all.
if (want('hero')) {
  const page = appPage({
    name: 'hero',
    scheme: 'dark',
    tone: 'dark',
    framed: true,
    turns: 8,
    chrome: true,
    config: { intensity: 2, desktop: true, plate: true, plateSide: 'side', plateLevel: 0.85, tint: 'ice' },
    css: `.cursor-strip { display: none; }`
  });
  results.hero = single('hero', page, path.join(DIR, 'preview-transparent.png'));
}

// 2. The same screen twice: the stock shell, then the theme with the desktop
//    exposed. One image, because the claim is a difference and a difference
//    needs both terms on the same desk. Dark, because a see-through window over
//    a light desktop composites to roughly nothing — the reveal is only legible
//    against a ground with range in it.
if (want('compare')) {
  const shared = {
    scheme: 'dark',
    tone: 'dark',
    turns: 4,
    css: `#root .dd, #root .ft, #root .dlg { display: none; } .cursor-strip { display: none; }`
  };
  const stock = appPage({ name: 'compare-stock', ...shared, config: { enabled: false } });
  const glass = appPage({
    name: 'compare-glass',
    ...shared,
    config: { intensity: 2, desktop: true, plate: true, plateSide: 'side', plateLevel: 0.85, tint: 'ice' }
  });
  const page = sheetPage(
    'compare',
    '透出桌面：同一屏内容，左边是原生外壳，右边是玻璃外壳',
    [
      { src: 'compare-stock/index.html', w: 760, h: 520, label: '默认外观', note: 'Harness 原生外壳，窗口底板不透明' },
      { src: 'compare-glass/index.html', w: 760, h: 520, label: '液态玻璃 · 强度 2.0', note: '桌面原样透出，磨砂跟随强度降到 0' }
    ]
  );
  results.compare = sheetPng('compare', page, path.join(DIR, 'preview-vs-stock.png'), 1618, 646);
}

// 3. The default look: 强度 1、透出桌面 off, so the ground is the theme's own
//    wallpaper rather than the desktop — which is what a user who never touches
//    the sliders sees. Light scheme, because this is the half of the theme the
//    dark frames above do not show, and every float surface it reaches is
//    visible at once: sidebar, pane, dialog, menu, floating panel.
if (want('surfaces')) {
  const page = appPage({
    name: 'surfaces',
    scheme: 'light',
    desk: false,
    turns: 6,
    chrome: true,
    config: { intensity: 1, desktop: false, plate: false, tint: 'ice' },
    css: `.cursor-strip { display: none; }`
  });
  results.surfaces = single('surfaces', page, path.join(DIR, 'preview-surfaces.png'));
}

// 4. The shipped pointers, scraped out of the live sheet rather than retyped —
//    a retyped pointer is a drawing of the cursor, not the cursor.
if (want('cursors')) {
  const page = appPage({
    name: 'cursors',
    scheme: 'light',
    tone: 'light',
    config: { intensity: 1.4, surface: true, cursor: true, plate: false, tint: 'ice' },
    css: `
    #root, .cursor-strip { display: none; }
    .shop { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; }
    .card { width: 940px; padding: 34px 40px 30px; border-radius: 26px;
      background: rgba(255,255,255,0.34);
      backdrop-filter: blur(18px) saturate(1.4);
      -webkit-backdrop-filter: blur(18px) saturate(1.4);
      border: 1px solid rgba(255,255,255,0.5);
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.8), 0 30px 60px -26px rgba(8,18,44,.55);
      color: #10203f; font-family: var(--dsw-font-family, system-ui, sans-serif); }
    .card h3 { margin: 0 0 4px; font-size: 17px; font-weight: 600; }
    .card p { margin: 0 0 24px; font-size: 12.5px; color: #36466b; }
    .row { display: flex; justify-content: space-between; gap: 8px; }
    .cell { display: flex; flex-direction: column; align-items: center; gap: 9px; flex: 1; }
    .cell .box { width: 46px; height: 46px; display: flex; align-items: center; justify-content: center; }
    .cell svg { width: 42px; height: 42px; }
    .cell b { font-size: 12px; font-weight: 500; }
    .cell span { font-size: 11px; color: #43527a; }
    `,
    script: `
    ${SCRAPE_CURSORS}
    (function () {
      var meta = [['默认', 'default'], ['手型', 'pointer'], ['文本', 'text'], ['拖拽', 'grab'], ['禁用', 'disabled']];
      var wrap = document.createElement('div');
      wrap.className = 'shop';
      var card = document.createElement('div');
      card.className = 'card';
      card.innerHTML = '<h3>自定义指针</h3><p>默认箭头、手型、文本与拖拽指针一起替换，深色浅色都留着描边。</p>';
      var row = document.createElement('div');
      row.className = 'row';
      (window.__cursors || []).forEach(function (svg, i) {
        var cell = document.createElement('div');
        cell.className = 'cell';
        cell.innerHTML = '<div class="box">' + svg + '</div><b>' + meta[i][0] + '</b><span>' + meta[i][1] + '</span>';
        row.append(cell);
      });
      card.append(row);
      wrap.append(card);
      document.body.append(wrap);
    })();
    `
  });
  results.cursors = single('cursors', page, path.join(DIR, 'preview-cursors.png'));
}

// 5. The click ripple, held — and the same press with nothing pressed beside
//    it, because a ripple is a difference and at full-window scale a single
//    frame of one is a thin ring nobody can find. Both frames are shot at 2x
//    from a smaller viewport, which is a zoom without upscaling anything.
//
//    Transitions are switched off in this specimen only, and that is a capture
//    requirement rather than a styling choice: under `--virtual-time-budget`
//    there are no compositor frames, so a CSS transition never advances and the
//    glint sits at opacity 0 — present in the DOM, invisible in the image.
//    ripplelab.mjs hit this first; its note is why this line exists.
if (want('ripple')) {
  const shared = {
    scheme: 'dark',
    tone: 'dark',
    turns: 2,
    config: { intensity: 2, desktop: true, ripple: true, rippleSize: 2, cursor: false, plate: false, tint: 'dusk' },
    css: `
    .cursor-strip { display: none; }
    #root .dd, #root .ft, #root .dlg { display: none; }
    .dsl-ripple-glint, .dsl-ripple-glint::after { transition: none !important; }
    `
  };
  const press = `
    [ { x: 300, y: 196 } ].forEach(function (p) {
      document.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true, cancelable: true, button: 0, buttons: 1,
        pointerType: 'mouse', clientX: p.x, clientY: p.y
      }));
    });`;
  const control = appPage({ name: 'ripple-control', ...shared });
  const held = appPage({ name: 'ripple-held', ...shared, script: press });
  const page = sheetPage(
    'ripple',
    '点击涟漪：按下时在光点处亮起镜面反光，松开向外扩散（图为按住不放的定格）',
    [
      { src: 'ripple-control/index.html', w: 620, h: 400, label: '未按下' },
      { src: 'ripple-held/index.html', w: 620, h: 400, label: '按住' }
    ]
  );
  results.ripple = sheetPng('ripple', page, path.join(DIR, 'preview-ripple.png'), 1320, 510, { budget: 700 });
}

// 6. The four tint presets, light and dark. Each tile is a small render of the
//    same shell, on the desk tone its scheme needs.
if (want('tints')) {
  const tints = ['ice', 'slate', 'dusk', 'mono'];
  const cells = [];
  for (const scheme of ['dark', 'light']) {
    for (const tint of tints) {
      const name = `tint-${tint}-${scheme}`;
      appPage({
        name,
        scheme,
        tone: scheme,
        framed: false,
        config: { intensity: 1.3, desktop: true, plate: true, plateSide: 'side', plateLevel: 0.5, tint, cursor: false, ripple: false },
        css: `
        #root .side { width: 150px; padding: 12px 8px; }
        #root .brand { font-size: 12px; padding: 4px 6px 8px; }
        #root .nav-item { font-size: 11.5px; padding: 6px 8px; }
        #root .topbar { padding: 10px 14px; font-size: 11.5px; }
        #root .thread { padding: 14px; gap: 10px; }
        #root .turn { max-width: 330px; font-size: 11.5px; padding: 9px 12px; border-radius: 12px; }
        #root .turn .code { font-size: 10px; padding: 7px 9px; }
        #root .composer { margin: 0 14px 14px; padding: 10px 12px; font-size: 11.5px; }
        #root .dlg { left: 24px; top: 24px; width: 214px; padding: 10px 12px; font-size: 11px; }
        #root .dd { left: 252px; top: 66px; width: 132px; font-size: 11px; }
        #root .ft { right: 14px; top: 20px; width: 172px; height: 92px; font-size: 10.5px; }
        .cursor-strip { display: none; }
        `
      });
      cells.push({ src: `${name}/index.html`, w: 368, h: 230, label: `${tint} · ${scheme}` });
    }
  }
  const page = sheetPage('tints', '四套色调预设 · 深色 / 浅色', cells, { pad: 20 });
  const html = fs.readFileSync(page, 'utf8').replace(
    '.row { display: flex; gap: 20px; }',
    '.row { display: grid; grid-template-columns: repeat(4, 368px); gap: 16px; }'
  );
  fs.writeFileSync(page, html, 'utf8');
  results.tints = sheetPng('tints', page, path.join(DIR, 'preview-tints.png'), 1572, 600);
}

if (browser === null) {
  console.log('\nno headless browser found — nothing could be captured.');
  process.exit(2);
}
const failed = Object.entries(results).filter(([, ok]) => !ok).map(([n]) => n);
console.log(`\nimages -> ${DIR}`);
if (failed.length > 0) console.log(`FAILED: ${failed.join(', ')}`);
