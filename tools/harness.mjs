/**
 * Shared preview harness.
 *
 * Everything the offline preview tools need to boot the REAL client.js in a
 * stand-in shell. Deliberately not a mock of the plugin — only of the cordis
 * host surface it talks to.
 *
 * The load-bearing detail: `factory()` alone is not enough. `apply(ctx)` is what
 * registers the locale, the theme effect, the ripple listener, the settings
 * slots, and — at its very end — `loadFromHost()`. A harness that only calls
 * `factory()` silently tests the module-scope default and never exercises host
 * config loading at all. That mistake produced a preview that looked right
 * while every preset resolved to the same palette.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.join(HERE, '..');
export const OUT = path.join(HERE, '_preview');

export const BASE_CSS = fs.readFileSync(path.join(HERE, 'fixtures', 'dsh-base.css'), 'utf8');
export const TOKENS_CSS = fs.readFileSync(path.join(HERE, 'fixtures', 'dsh-tokens.css'), 'utf8');

/**
 * The Harness' own bundled stylesheet — the real thing, extracted from
 * `@deepseek-ai/dsh-web-frontend/dist/assets/index-BPHePDI_.css`
 * (76,338 bytes, sha256 44a24dd9a31c4e74).
 *
 * Loading it is not optional. Every generated page used to be built only from
 * `dsh-base.css` + `dsh-tokens.css`, which contain the token definitions but
 * none of the application rules that CONSUME them. That is precisely how a
 * wallpaper shipped for a whole round while never painting: the real sheet has
 *
 *     body { background: var(--dsw-alias-bg-base, #fff) }
 *
 * and a background shorthand resets background-image. The bug was invisible to
 * every mock page because the mock had no `body` rule at all. A fixture that
 * omits the sheet you are fighting is not a test, it is a rehearsal.
 */
export const OFFICIAL_CSS = fs.readFileSync(path.join(HERE, 'fixtures', 'dsh-official.css'), 'utf8');

export const DEFAULT_CONFIG = {
  enabled: true,
  surface: true,
  cursor: true,
  desktop: false,
  ripple: true,
  intensity: 1,
  rippleSize: 1,
  tint: 'ice'
};

export const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
];

export const browser = BROWSERS.find((p) => fs.existsSync(p)) ?? null;

/**
 * Cordis host stand-in.
 *
 * `effect` runs the callback immediately and keeps the disposer, mirroring the
 * real contract (registering an effect applies it straight away).
 */
export const MOCK_CTX = `
window.__mockCtx = (function () {
  var effects = [];
  return {
    effects: effects,
    effect: function (fn, label) {
      var dispose = fn();
      effects.push({ label: label, dispose: dispose });
      return function () {
        if (typeof dispose === 'function') dispose();
      };
    },
    locale: {
      register: function () { return function (k) { return k; }; },
      bind: function () { return function (k) { return k; }; }
    },
    slots: {
      injected: [],
      registered: [],
      inject: function (name, cb) { this.injected.push(name); try { cb(); } catch (e) { /* no host */ } },
      register: function (def) { this.registered.push(def.name || def.id); return function () {}; }
    }
  };
})();
`;

/** Module loader + host-config `fetch` stub, injected before client.js runs. */
export function loader(config) {
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
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: function () { return 'application/json'; } },
        json: function () { return Promise.resolve(CFG); },
        text: function () { return Promise.resolve(JSON.stringify(CFG)); }
      });
    }
    if (real !== null) return real(url, init);
    return Promise.reject(new Error('offline'));
  };
})();
`;
}

/**
 * Boot the plugin the way the real host does: resolve the factory, then apply
 * it against the mock context. Returns nothing; side effects land in the DOM.
 */
export const BOOT = `
(function () {
  var mod = window.__dshPlugin.factory(function (name) {
    if (name === 'react') return window.__reactStub;
    if (name === 'react/jsx-runtime') {
      return { jsx: function () { return null; }, jsxs: function () { return null; }, Fragment: 'fragment' };
    }
    throw new Error('unexpected require: ' + name);
  });
  // Calling apply() is not optional: loadFromHost() lives at the bottom of it.
  mod.apply(window.__mockCtx);
  window.__pluginModule = mod;
  document.body.setAttribute('data-applied', String(mod.inject ? mod.inject.join(',') : 'none'));
})();
`;

/** Pull every encoded pointer out of the live sheet, in source order. */
export const SCRAPE_CURSORS = `
(function () {
  var MARK = 'cursor: url("data:image/svg+xml;charset=utf-8,';
  var sheet = document.getElementById('dsl-theme-style');
  var css = sheet ? sheet.textContent : '';
  var svgs = [];
  var at = css.indexOf(MARK);
  while (at !== -1) {
    var start = at + MARK.length;
    var end = css.indexOf('")', start);
    if (end === -1) break;
    svgs.push(decodeURIComponent(css.slice(start, end)));
    at = css.indexOf(MARK, end);
  }
  window.__cursors = svgs;
  document.body.setAttribute('data-cursors', String(svgs.length));
  document.body.setAttribute('data-sheet', sheet === null ? 'missing' : 'mounted');
})();
`;

// ---------------------------------------------------------------------------
// The stand-in app shell
// ---------------------------------------------------------------------------
//
// Moved here from preview.mjs so more than one tool can render the SAME shell.
// It has to be one shared definition, not a copy per tool: a preview that draws
// a nicer mock than the thing under test is a rehearsal, not a test — and the
// earlier intensity ladder was built from the bare cascade renders, which show
// the wallpaper and almost nothing else. Air's response to those was exactly
// right: "和你的演示图效果完全不一致".

/**
 * The mock app shell. `#root` deliberately paints `--dsw-alias-bg-base` over the
 * whole viewport — that opaque layer is what defeated the old
 * `body::before { z-index: -1 }` wallpaper.
 */
export const APP_SHELL_CSS = `
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; }
body { font-family: var(--dsw-font-family, system-ui, sans-serif); color: var(--dsw-alias-label-primary); }
#root { display: flex; height: 100vh; background: var(--dsw-alias-bg-base); }
.side {
  width: 240px; flex: none; padding: 16px 12px;
  background: var(--dsw-alias-bg-layer-1);
  border-right: 0.5px solid var(--dsw-alias-border-l3);
  display: flex; flex-direction: column; gap: 6px;
}
.brand { font-weight: 500; font-size: 14px; padding: 6px 8px 14px; }
.nav-item { padding: 8px 10px; border-radius: var(--dsw-radius-md); font-size: 13px; color: var(--dsw-alias-label-secondary); }
.nav-item.active { background: var(--dsw-alias-interactive-bg-active); color: var(--dsw-alias-label-primary); }
.main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
.topbar {
  padding: 14px 20px; font-size: 13px; color: var(--dsw-alias-label-tertiary);
  border-bottom: 0.5px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-2);
}
.thread { flex: 1; padding: 24px; display: flex; flex-direction: column; gap: 14px; overflow: hidden; }
.turn { max-width: 620px; padding: 12px 16px; border-radius: var(--dsw-radius-lg); font-size: 13px; line-height: 1.7; }
.turn.user { align-self: flex-end; background: var(--dsw-alias-bg-layer-2); }
.turn.bot { background: var(--dsw-alias-bg-layer-3); border: 0.5px solid var(--dsw-alias-border-l3); }
code { background: var(--dsw-alias-markdown-inline-code); padding: 1px 5px; border-radius: var(--dsw-radius-xs); font-size: 12px; }
.code {
  margin-top: 10px; padding: 10px 12px; border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-markdown-code-block);
  font-family: var(--dsw-font-markdown-code-block, monospace); font-size: 12px;
}
.composer {
  margin: 0 24px 24px; padding: 14px 16px;
  border-radius: var(--dsw-radius-xl);
  background: var(--dsw-alias-bg-layer-3);
  border: 0.5px solid var(--dsw-alias-border-l4);
  color: var(--dsw-alias-label-tertiary); font-size: 13px;
}
.cursor-strip {
  position: fixed; left: 0; right: 0; bottom: 0; z-index: 5;
  display: flex; gap: 28px; align-items: flex-end; justify-content: center;
  padding: 14px; background: rgba(127,127,127,0.16);
}
.cursor-strip figure { margin: 0; display: flex; flex-direction: column; align-items: center; gap: 5px; }
.cursor-strip svg { width: 48px; height: 48px; }
.cursor-strip figcaption { font-size: 11px; color: var(--dsw-alias-label-tertiary); }

/* Surfaces that the frosted list is supposed to hit. Without these the preview
   would never exercise the glass at all. */
.stage { position: relative; flex: 1; min-height: 0; display: flex; }
.dlg {
  position: absolute; left: 60px; top: 46px; width: 330px;
  padding: 16px 18px; border-radius: var(--dsw-radius-panel);
  background: var(--dsw-alias-bg-layer-3);
  border: 0.5px solid var(--dsw-alias-border-l4);
  font-size: 13px; line-height: 1.7;
}
.dlg h5 { margin: 0 0 8px; font-size: 13px; font-weight: 600; }
.dd {
  position: absolute; left: 420px; top: 120px; width: 190px; padding: 6px;
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-menu-surface-fill);
  border: 0.5px solid var(--dsw-alias-border-l4);
  font-size: 12.5px;
}
.dd div { padding: 7px 10px; border-radius: var(--dsw-radius-sm); }
.dd div:hover { background: var(--dsw-alias-interactive-bg-hover); }
.ft {
  position: absolute; right: 34px; top: 40px; width: 250px; height: 132px;
  padding: 12px 14px; border-radius: var(--dsw-radius-lg);
  background: var(--dsw-alias-bg-layer-2);
  border: 0.5px solid var(--dsw-alias-border-l3);
  font-size: 12px; color: var(--dsw-alias-label-secondary);
}`;

export const APP_SHELL = `
<div id="root">
  <aside class="side">
    <div class="brand">DeepSeek Harness</div>
    <div class="nav-item active">会话</div>
    <div class="nav-item">工作区</div>
    <div class="nav-item">插件</div>
    <div class="nav-item">设置</div>
  </aside>
  <main class="main">
    <div class="topbar">liquid-glass · 预览</div>
    <div class="stage">
      <div class="thread">
        <div class="turn user">把主题的对比度再调一调</div>
        <div class="turn bot">
          已调整 <code>--dsw-alias-bg-base</code> 与壁纸透明度，现在底层色调可以透出来了。
          <div class="code">html:has(body[data-ds-dark-theme]) { background-color: #0b1220; }</div>
        </div>
      </div>

      <!-- role=dialog: must pick up backdrop-filter + the sheen shadow -->
      <div class="dlg" role="dialog" aria-label="设置">
        <h5>设置 · Liquid Glass</h5>
        玻璃弹窗应当透出背后的壁纸，并在顶边出现一道高光。
      </div>

      <!-- role=menu: lighter shadow treatment -->
      <div class="dd" role="menu">
        <div role="menuitem">复制</div>
        <div role="menuitem">重命名</div>
        <div role="menuitem">删除</div>
      </div>

      <!-- data-dockkit-float: the real floating-window hook -->
      <div class="ft" data-dockkit-float>
        浮动面板（data-dockkit-float）<br>也应当吃到同一层玻璃。
      </div>
    </div>
    <div class="composer">输入消息…</div>
  </main>
</div>
<div class="cursor-strip" id="cursor-strip"></div>
`;

/**
 * Screenshot a page.
 *
 * Two details are load-bearing:
 *  - `--screenshot` gets an ABSOLUTE, forward-slashed path. A relative one is
 *    resolved against the browser's own cwd, not ours, and it refuses to write
 *    outside it ("拒绝访问").
 *  - `stdio` must not be 'pipe'. Under this shell a piped spawn makes the exe
 *    path get re-translated ("C://Program Files...") and Node fails with EBUSY
 *    before the browser ever starts. 'ignore' is the safe variant.
 * A fresh profile per shot avoids racing the previous instance's file locks.
 */
export function shoot(
  pagePath,
  pngPath,
  { width, height, scale = 1, allowFileAccess = false, budget = 0, gpu = false, extraArgs = [] } = {}
) {
  if (browser === null) return false;
  if (fs.existsSync(pngPath)) fs.rmSync(pngPath);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dsl-shot-'));
  try {
    execFileSync(
      browser,
      [
        '--headless=new',
        // Software rasterisation by default, and that default is a caveat rather
        // than a preference: every capture this suite has ever taken went through
        // SwiftShader, so any artifact that lives in the GPU compositor — and
        // `backdrop-filter` clipping is one — was structurally invisible to it.
        // `gpu: true` flips the one flag so a suspicion can at least be tested.
        ...(gpu ? ['--use-angle=d3d11', '--enable-unsafe-swiftshader'] : ['--disable-gpu']),
        '--no-first-run',
        '--no-default-browser-check',
        '--hide-scrollbars',
        ...(allowFileAccess ? ['--allow-file-access-from-files'] : []),
        // Optional, but deciding: without a budget the capture happens right
        // after load, before any setTimeout in the page has run — which silently
        // hid the ripple during A/B testing. With it, capture waits for timers.
        ...(budget > 0 ? [`--virtual-time-budget=${budget}`] : []),
        ...extraArgs,
        `--force-device-scale-factor=${scale}`,
        `--user-data-dir=${profile}`,
        `--window-size=${width},${height}`,
        `--screenshot=${pngPath.replace(/\\/g, '/')}`,
        `file:///${pagePath.replace(/\\/g, '/')}`
      ],
      { stdio: 'ignore', timeout: 120000 }
    );
    return fs.existsSync(pngPath) && fs.statSync(pngPath).size > 0;
  } catch (error) {
    console.log(`  shoot failed: ${String(error.message).split('\n')[0]}`);
    return false;
  } finally {
    fs.rmSync(profile, { recursive: true, force: true });
  }
}

/**
 * Dump the DOM (after timers have run) so a silent no-op cannot pass.
 *
 * `width`/`height` matter for the same reason they matter for a screenshot:
 * anything that wraps — a paragraph with a `max-width`, a caption — changes its
 * height with the viewport, so a dump taken at the browser's default 800px
 * cannot be used to predict how tall the page will be when shot at 2558px.
 * Pass the shot width to get a height that matches it.
 */
export function dumpDom(
  pagePath,
  { budget = 4000, allowFileAccess = true, width = null, height = null } = {}
) {
  return dumpDomWithShot(pagePath, null, { budget, allowFileAccess, width, height });
}

/**
 * One launch producing both a DOM dump and (optionally) a screenshot.
 *
 * Chromium honours `--dump-dom` and `--screenshot` in the same run, which halves
 * the cost of any check that wants both the resolved styles and the resolved
 * pixels. This tool used to launch the browser twice per variant — eight
 * launches, four minutes — which is the difference between a check that runs on
 * every change and one that gets skipped.
 */
export function dumpDomWithShot(
  pagePath,
  pngPath,
  { budget = 4000, allowFileAccess = true, width = null, height = null } = {}
) {
  if (browser === null) return '';
  if (pngPath !== null && fs.existsSync(pngPath)) fs.rmSync(pngPath);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dsl-dom-'));
  // A screenshot needs a window size; a bare dump only needs one when the
  // caller asked for a specific viewport. Emitting the flag unconditionally
  // would move existing dump-only callers off the browser default, which would
  // be a silent behaviour change.
  const viewport =
    pngPath === null && width === null && height === null
      ? null
      : [width ?? 900, height ?? 600];
  try {
    return execFileSync(
      browser,
      [
        '--headless=new',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        '--hide-scrollbars',
        ...(allowFileAccess ? ['--allow-file-access-from-files'] : []),
        `--user-data-dir=${profile}`,
        `--virtual-time-budget=${budget}`,
        '--dump-dom',
        ...(viewport === null ? [] : [`--window-size=${viewport[0]},${viewport[1]}`]),
        ...(pngPath === null ? [] : [`--screenshot=${pngPath.replace(/\\/g, '/')}`]),
        `file:///${pagePath.replace(/\\/g, '/')}`
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 150000 }
    );
  } catch (error) {
    return `DUMP_FAILED ${String(error.message).split('\n')[0]}`;
  } finally {
    fs.rmSync(profile, { recursive: true, force: true });
  }
}

/** Literal `<pre id="out">` payload out of a dumped DOM. */
export function readPre(dump) {
  const m = dump.match(/<pre id="out">([\s\S]*?)<\/pre>/);
  if (m === null) return '';
  return m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
}

/** `<body>` open tag, optionally already in the dark scheme. */
export function bodyTag({ dark = false } = {}) {
  return dark ? '<body data-ds-dark-theme>' : '<body>';
}

/**
 * Read the RESOLVED theme back out of the page.
 *
 * Every previous assertion in the suite inspected the generated CSS text, which
 * cannot see two whole classes of failure: a declaration losing the cascade, and
 * a value that resolves to something other than what was written. The wallpaper
 * bug was both — the text said `background-image: <four gradients>` and the
 * computed value was `none`. Reading computed styles is the only way to catch
 * that, so both the parchment and the resolved body background are reported.
 */
export const SCRAPE_THEME = `
(function () {
  var names = [
    '--dsw-alias-bg-base', '--dsw-alias-bg-layer-1', '--dsw-alias-bg-layer-2',
    '--dsw-alias-bg-layer-3', '--dsw-alias-bg-overlay', '--dsw-alias-bg-module-platform',
    '--dsw-specific-sidebar-fill', '--dsw-specific-menu', '--dsw-menu-surface-fill',
    '--dsw-alias-tooltip-bg', '--dsw-alias-toast-bg', '--dsw-alias-border-l3',
    '--dsl-tint-accent', '--dsl-blur', '--dsl-glass', '--dsw-radius-lg',
    '--dsl-refract', '--dsl-lens-scale', '--dsl-reveal'
  ];
  var body = getComputedStyle(document.body);
  var out = {
    tokens: {},
    bodyBgImage: body.backgroundImage,
    bodyBgColor: body.backgroundColor,
    // The window base. On a patched client with 透出桌面 on this is the exact
    // pixel region where the OS material shows, so it is the only place
    // "the desktop comes through" can be asserted rather than inferred from the
    // presence of a declaration.
    htmlBgColor: getComputedStyle(document.documentElement).backgroundColor
  };
  for (var i = 0; i < names.length; i += 1) {
    out.tokens[names[i]] = body.getPropertyValue(names[i]).trim();
  }
  var wall = document.getElementById('dsl-wallpaper');
  out.wallpaper = wall === null ? null : {
    image: wall.style.backgroundImage,
    color: wall.style.backgroundColor,
    position: getComputedStyle(wall).position,
    zIndex: getComputedStyle(wall).zIndex,
    // The fade itself. Read as a computed OPACITY rather than as the inline
    // value, because an opacity that resolved to something else would be
    // indistinguishable from the intended one in the inline string.
    opacity: String(getComputedStyle(wall).opacity),
    reveal: wall.dataset.reveal
  };
  /**
   * Refraction, probed in the engine rather than asserted on CSS text.
   *
   * This is the only place the feature can actually be proven, because both of
   * its failure modes are silent: an engine that will not honour url() inside
   * backdrop-filter simply computes the whole declaration to none, and a filter
   * reference that points at a missing filter does the same. Neither logs
   * anything. So the probe (a) asks CSS.supports, and (b) attaches two real
   * elements — one in the float group, one in the pane group — and reads back
   * their COMPUTED values, which is the end state that decides whether pixels
   * move.
   */
  out.refract = (function () {
    function probeAttrs(attrs) {
      var probe = document.createElement('div');
      for (var k in attrs) probe.setAttribute(k, attrs[k]);
      probe.style.position = 'fixed';
      probe.style.left = '-9999px';
      probe.style.top = '0';
      probe.style.width = '240px';
      probe.style.height = '160px';
      document.body.appendChild(probe);
      var cs = getComputedStyle(probe);
      var value = cs.backdropFilter || cs.webkitBackdropFilter || '';
      probe.remove();
      return String(value);
    }
    // A float and a pane, because the scoping is the design: the lens is an edge
    // effect whose width is a fraction of the box, so on a full-height pane the
    // bezel would be hundreds of px and read as a warp rather than as thickness.
    var floatValue = probeAttrs({ role: 'menu' });
    var paneValue = probeAttrs({ 'data-dockkit-pane': '' });
    // The SVG filter really has to be in the document, not merely referenced.
    var edge = document.getElementById('dsl-refract');
    var drop = document.getElementById('dsl-drop');
    var mapHref = '';
    if (edge !== null) {
      var img = edge.querySelector('feImage');
      mapHref = img === null ? '' : String(img.getAttribute('href') || '').slice(0, 22);
    }
    return {
      supportsUrl: CSS.supports('backdrop-filter', 'url(#dsl-refract)'),
      supportsBlurUrl: CSS.supports('backdrop-filter', 'blur(4px) url(#dsl-refract)'),
      computed: floatValue,
      paneComputed: paneValue,
      edgePresent: edge !== null,
      dropPresent: drop !== null,
      mapHref: mapHref
    };
  })();
  out.sheetMounted = document.getElementById('dsl-theme-style') !== null;
  out.scheme = document.body.hasAttribute('data-ds-dark-theme') ? 'dark' : 'light';
  var pre = document.createElement('pre');
  pre.id = 'out';
  pre.textContent = JSON.stringify(out);
  document.body.appendChild(pre);
  document.body.setAttribute('data-theme', 'scraped');
})();
`;

export function pageHead() {
  return `<head><meta charset="utf-8">
<style>${BASE_CSS}</style>
<style>${TOKENS_CSS}</style>
<style>${OFFICIAL_CSS}</style>`;
}

/**
 * Relative path from a generated page's directory to the real client.js.
 *
 * Computed, never hardcoded. Hand-written `../../client.js` was wrong twice —
 * once for `_preview/` and once for `_preview/frames/` — and both times the
 * page rendered perfectly while the plugin silently never loaded.
 */
export function clientSrc(fromDir) {
  return path.relative(fromDir, path.join(ROOT, 'client.js')).replace(/\\/g, '/');
}
