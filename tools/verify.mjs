/**
 * Headless smoke test for the Liquid Glass plugin.
 *
 * Runs both halves against stubs so the whole thing can be proven without
 * launching DSH:
 *   - client.js is executed in a vm against a minimal DOM/React stub
 *   - index.js is imported for real and its route handler is driven directly
 *
 * Usage: node tools/verify.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import Module from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENT = path.join(HERE, '..', 'client.js');
const HOST = path.join(HERE, '..', 'index.js');

let failures = 0;
function check(label, condition, detail) {
  const tag = condition ? 'ok  ' : 'FAIL';
  if (!condition) failures += 1;
  console.log(`  [${tag}] ${label}${detail === undefined ? '' : `  -> ${detail}`}`);
}

// ---------------------------------------------------------------------------
// Minimal DOM
// ---------------------------------------------------------------------------

class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentElement = null;
    this.dataset = {};
    this.attributes = {};
    this.listeners = new Map();
    this.textContent = '';
    this.isConnected = false;
    this.style = { setProperty() {}, removeProperty() {} };
    this._id = '';
  }
  set id(value) {
    this._id = value;
  }
  get id() {
    return this._id;
  }
  get className() {
    return this.attributes.class ?? '';
  }
  set className(value) {
    this.attributes.class = value;
  }
  appendChild(child) {
    child.parentElement = this;
    child.isConnected = true;
    this.children.push(child);
    return child;
  }
  insertBefore(child, ref) {
    const at = ref === null || ref === undefined ? this.children.length : this.children.indexOf(ref);
    const i = at === -1 ? this.children.length : at;
    child.parentElement = this;
    child.isConnected = true;
    this.children.splice(i, 0, child);
    return child;
  }
  get firstChild() {
    return this.children.length === 0 ? null : this.children[0];
  }
  hasAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attributes, name);
  }
  removeAttribute(name) {
    delete this.attributes[name];
  }
  remove() {
    if (this.parentElement !== null) {
      const i = this.parentElement.children.indexOf(this);
      if (i >= 0) this.parentElement.children.splice(i, 1);
    }
    this.parentElement = null;
    this.isConnected = false;
  }
  setAttribute(name, value) {
    this.attributes[name] = value;
    // Real DOM reflects the id attribute onto the property, and `findById`
    // reads the property. Without this mirror the SVG filter injected through
    // createElementNS is invisible to every lookup in this file.
    if (name === 'id') this._id = String(value);
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  removeEventListener(type, fn) {
    const list = this.listeners.get(type);
    if (list === undefined) return;
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  }
  dispatch(type, event) {
    for (const fn of this.listeners.get(type) ?? []) fn(event);
  }
  get lastElementChild() {
    return this.children.length === 0 ? null : this.children[this.children.length - 1];
  }
}

function walk(root, visit) {
  for (const child of root.children) {
    visit(child);
    walk(child, visit);
  }
}

function countByClass(root, cls) {
  if (root === null) return 0;
  let n = 0;
  walk(root, (el) => {
    if (String(el.attributes.class ?? '').split(/\s+/).includes(cls)) n += 1;
  });
  return n;
}

function findById(root, id) {
  let hit = null;
  walk(root, (el) => {
    if (hit === null && el._id === id) hit = el;
  });
  return hit;
}

function findByClass(root, cls) {
  let hit = null;
  walk(root, (el) => {
    if (hit === null && String(el.attributes.class ?? '').split(/\s+/).includes(cls)) hit = el;
  });
  return hit;
}

const head = new El('head');
const body = new El('body');
head.isConnected = true;
body.isConnected = true;

// ---------------------------------------------------------------------------
// Stylesheet stub, shaped like the real one
// ---------------------------------------------------------------------------
//
// The palette harvest reads CSSStyleRules, so the stub has to behave like one:
// an indexed list of property names plus getPropertyValue. Values are the real
// ones from the shipped design_platform.css, including the `var()` chains —
// resolving those is the part most likely to break silently.

function cssRule(selectorText, declarations) {
  const names = Object.keys(declarations);
  const style = {
    length: names.length,
    getPropertyValue: (name) => declarations[name] ?? ''
  };
  names.forEach((name, i) => { style[i] = name; });
  return { selectorText, style };
}

const OFFICIAL_LIGHT = {
  '--dsw-static-neutral-bluish-00': '#ffffff',
  '--dsw-static-neutral-bluish-50': '#f9fafb',
  // Already carries alpha. Must survive untouched: translucency would destroy
  // the intent of a mask, and glassing a hover wash turns it invisible.
  '--dsw-alias-bg-skeleton': '#ffffff14',
  '--dsw-alias-bg-base': 'var(--dsw-static-neutral-bluish-00)',
  '--dsw-alias-bg-layer-1': 'var(--dsw-static-neutral-bluish-50)',
  '--dsw-specific-sidebar-fill': 'var(--dsw-static-neutral-bluish-50)',
  '--dsw-menu-surface-fill': '#ffffffc7',
  '--dsw-alias-tooltip-bg': '#ffffffe0'
};

const OFFICIAL_DARK = {
  '--dsw-static-neutral-bluish-950': '#151517',
  '--dsw-static-neutral-bluish-900': '#1b1b1c',
  '--dsw-static-neutral-bluish-875': '#232324',
  '--dsw-static-neutral-bluish-850': '#2c2c2e',
  '--dsw-static-neutral-bluish-800': '#353638',
  '--dsw-static-neutral-bluish-750': '#43454a',
  '--dsw-static-neutral-bluish-700': '#61666b',
  '--dsw-alias-bg-base': 'var(--dsw-static-neutral-bluish-950)',
  '--dsw-alias-bg-layer-1': 'var(--dsw-static-neutral-bluish-875)',
  '--dsw-alias-bg-layer-2': 'var(--dsw-static-neutral-bluish-850)',
  '--dsw-alias-bg-layer-3': 'var(--dsw-static-neutral-bluish-800)',
  '--dsw-alias-bg-overlay': 'var(--dsw-static-neutral-bluish-700)',
  '--dsw-specific-sidebar-fill': 'var(--dsw-static-neutral-bluish-900)',
  '--dsw-alias-tooltip-bg': 'var(--dsw-static-neutral-bluish-750)',
  '--dsw-alias-toast-bg': 'var(--dsw-static-neutral-bluish-750)',
  '--dsw-menu-surface-fill': '#43454a73'
};

/** The plugin's own sheet, which the harvest must refuse to read. */
const OWN_SHEET_MARKER = '#010203';
const ownSheetEl = new El('style');
ownSheetEl.dataset.plugin = 'air-pixel-liquid-glass';

const STYLE_SHEETS = [
  { ownerNode: null, cssRules: [cssRule('body', OFFICIAL_LIGHT), cssRule('body[data-ds-dark-theme]', OFFICIAL_DARK)] },
  { ownerNode: ownSheetEl, cssRules: [cssRule('body', { '--dsw-alias-bg-base': `rgba(1,2,3,0.5) /* ${OWN_SHEET_MARKER} */` })] }
];

/**
 * A canvas faithful enough that the real displacement-map code runs.
 *
 * This stub exists because of a specific near-miss: the refraction layer builds
 * its map on a canvas and injects an SVG filter through `createElementNS`. With
 * neither stubbed, `ensureLiquidDefs` bails out, every refraction rule drops out
 * of the sheet, and every test still passes — a green suite covering a feature
 * that is not in the document. That is precisely the state the previous round
 * shipped, so the stubs are load-bearing rather than convenient.
 *
 * Every instance is also recorded in `CANVASES`, which is what lets the suite
 * assert on the *geometry* of the maps rather than only on the fact that a
 * `data:` URI made it into the document. The droplet's profile was wrong twice —
 * centre-peaked, then centre-heavy — and both times the CSS was identical and
 * the only place the error existed was in these pixels.
 */
const CANVASES = [];

class Canvas extends El {
  constructor() {
    super('canvas');
    this.width = 0;
    this.height = 0;
    this._patch = null;
    CANVASES.push(this);
  }
  getContext(kind) {
    if (kind !== '2d') return null;
    const self = this;
    return {
      createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
      putImageData: (patch) => { self._patch = patch; },
      getImageData: () => self._patch
    };
  }
  /**
   * Unique per distinct pixel content, derived from the data rather than the
   * size. `ensureLiquidDefs` caches on a prefix of this string, so a stub that
   * returned a constant would make a *changed* map look cached — and the checks
   * below could not tell a correct map from a stale one.
   */
  toDataURL() {
    const d = this._patch === null ? new Uint8ClampedArray(0) : this._patch.data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 89) sum = (sum * 31 + d[i]) >>> 0;
    return `data:image/png;base64,TEST${sum.toString(36)}_${this.width}`;
  }
}

const documentStub = {
  head,
  body,
  documentElement: new El('html'),
  styleSheets: STYLE_SHEETS,
  createElement: (tag) =>
    String(tag).toLowerCase() === 'canvas' ? new Canvas() : new El(tag),
  createElementNS: (_ns, tag) => new El(tag),
  getElementById: (id) => findById(head, id) ?? findById(body, id),
  addEventListener: (type, fn) => documentStub._el.addEventListener(type, fn),
  removeEventListener: (type, fn) => documentStub._el.removeEventListener(type, fn),
  dispatch: (type, event) => documentStub._el.dispatch(type, event),
  _el: new El('document')
};

const storage = new Map();
const windowStub = {
  localStorage: {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: (k) => storage.delete(k)
  },
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
  // The glint grows on the next frame, and the ripple listeners live on window.
  requestAnimationFrame: (fn) => setTimeout(fn, 0),
  addEventListener: () => {},
  removeEventListener: () => {}
};

class MutationObserverStub {
  observe() {}
  disconnect() {}
}

const React = {
  Fragment: Symbol('Fragment'),
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useReducer: (_reducer, initial) => [initial, () => {}],
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn
};

const mockRequire = (name) => {
  if (name === 'react') return React;
  if (name === 'react/jsx-runtime') {
    const jsx = (type, props) => React.createElement(type, props);
    return { jsx, jsxs: jsx, Fragment: React.Fragment };
  }
  throw new Error(`unexpected require("${name}")`);
};

// ---------------------------------------------------------------------------
// Load the browser bundle
// ---------------------------------------------------------------------------

const source = fs.readFileSync(CLIENT, 'utf8');
const sandbox = {
  window: windowStub,
  document: documentStub,
  console,
  setTimeout,
  clearTimeout,
  fetch: async () => ({ ok: false, status: 503, json: async () => ({}) }),
  encodeURIComponent,
  Math,
  Number,
  JSON,
  Object,
  Array,
  String,
  Boolean,
  Error,
  Symbol,
  Promise,
  Date,
  Set,
  Map,
  MutationObserver: MutationObserverStub
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

let registration = null;
sandbox.window.__ModuleLoader__ = {
  load: (def) => {
    registration = def;
  }
};

console.log('load bundle');
vm.runInContext(source, sandbox, { filename: 'client.js' });
check('module registered', registration !== null);
check('id matches package name', registration?.id === 'air-pixel-liquid-glass', registration?.id);
check('bundle id matches package name', (() => {
  const pkg = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8'));
  const bundle = fs.readFileSync(path.join(HERE, '..', 'cordis.patch.yml'), 'utf8');
  return bundle.includes(`id: ${pkg.name}`) && bundle.includes(`name: ${pkg.name}`);
})());
check('legacy recipe marker remains upgradeable', (() => {
  const sourceText = fs.readFileSync(path.join(HERE, 'asarpatch.py'), 'utf8');
  return sourceText.includes('LEGACY_MARKER_PREFIXES = ("dsh-theme-liquid-glass: the recipe",)') &&
    sourceText.includes('if any(f"{prefix} (material: {material})" in text for prefix in LEGACY_MARKER_PREFIXES):');
})());

const bundle = registration.factory(mockRequire);
check('exports.apply is a function', typeof bundle.apply === 'function');
check('exports.inject = [slots, locale]', JSON.stringify(bundle.inject) === '["slots","locale"]');

// ---------------------------------------------------------------------------
// Stylesheet built at module scope (before any ctx exists)
// ---------------------------------------------------------------------------

function styleText() {
  const tag = findById(head, 'dsl-theme-style');
  return tag === null ? '' : tag.textContent;
}

console.log('stylesheet at module scope');
const bootCss = styleText();
check('style tag mounted without ctx', bootCss.length > 500, `${bootCss.length} chars`);

// ---------------------------------------------------------------------------
// Wallpaper regression suite
//
// The run of bugs here, in order, is the reason these assertions are worded the
// way they are:
//   1. `body::before { z-index: -1 }` lost to the app shell's opaque layer and
//      the desktop fell through to the window colour (reported as flat black).
//   2. Painting it as the body's own `background-image` then did nothing at all,
//      because the official sheet paints the canvas with a SHORTHAND —
//      `body { background: var(--dsw-alias-bg-base, #fff) }` — and a shorthand
//      resets background-image. Not being !important, it lost for
//      background-color but won for background-image, so the shell rendered as
//      a flat tint over the desktop with no gradient anywhere. Every mock page
//      missed it because none of them loaded the real sheet.
//   3. Even with !important everywhere, body paints its background in the same
//      step as its children, so a positioned child at z-index -1 is covered by
//      it. Hence body's background is killed outright and a real element owns
//      the wallpaper.
// ---------------------------------------------------------------------------
check('html keeps an opaque canvas colour', /html\s*\{[^}]*background-color:\s*#[0-9a-f]{6}\s*!important/.test(bootCss));
check(
  'body background is reset, not painted',
  /body\s*\{\s*background:\s*transparent\s*!important/.test(bootCss),
  'defeats the official `background:` shorthand so nothing covers the wallpaper'
);
check('light shell handled at html level', bootCss.includes('html:has(body[data-ds-dark-theme])'));
check('no fragile z-index wallpaper left', !bootCss.includes('body::before'));
check(
  'wallpaper layer is full-viewport and behind the shell',
  /#dsl-wallpaper\s*\{[^}]*position:\s*fixed/.test(bootCss) &&
    /#dsl-wallpaper\s*\{[^}]*z-index:\s*-1/.test(bootCss),
  'above the canvas, below every in-flow box — the layer glass needs behind it'
);
check('dark variant present', bootCss.includes('body[data-ds-dark-theme]'));
check('radius tokens enlarged', bootCss.includes('--dsw-radius-panel: 34px'));
check('cursors injected', bootCss.includes('cursor: url("data:image/svg+xml'));
check('cursors are data URIs, not paths', !/url\("(?!data:)/.test(bootCss));

// Decode every cursor and assert the geometry rules that keep them legible.
const cursorSvgs = [];
{
  const MARK = 'cursor: url("data:image/svg+xml;charset=utf-8,';
  let at = bootCss.indexOf(MARK);
  while (at !== -1) {
    const start = at + MARK.length;
    const end = bootCss.indexOf('")', start);
    if (end === -1) break;
    cursorSvgs.push(decodeURIComponent(bootCss.slice(start, end)));
    at = bootCss.indexOf(MARK, end);
  }
}
check('five cursor declarations emitted', cursorSvgs.length === 5, `${cursorSvgs.length} found`);
check(
  'every cursor is a 20x20 canvas',
  cursorSvgs.length > 0 && cursorSvgs.every((s) => s.includes('width="20" height="20" viewBox="0 0 20 20"')),
  'cursors stay small, per the reported "too large" feedback'
);
check(
  'grab is one closed silhouette, not stacked rects',
  cursorSvgs.some((s) => s.includes('H6.6z')) && !cursorSvgs.some((s) => s.includes('<g fill="rgba(255,255,255,0.32)"')),
  'separately-stroked fingers bleed together below 24px'
);
check(
  'no cursor hotspot is hardcoded out of range',
  !/cursor: url\("data:[^"]*"\) 16 16/.test(bootCss),
  'the forbidden pointer used to carry stale 32x32 coordinates'
);
// ---------------------------------------------------------------------------
// The standard render fixture. Declared up here, before the first section that
// cold-boots the plugin, because a `const` sits in its temporal dead zone until
// its own line runs — the ripple section below is the first consumer, and the
// helper it calls is hoisted while this is not.
// ---------------------------------------------------------------------------
const BASE_CFG = { enabled: true, surface: true, cursor: false, ripple: false, intensity: 1, tint: 'slate' };

// ---------------------------------------------------------------------------
// Ripple
//
// Five designs died before this one, each for a reason worth pinning:
//   1. `contain: strict` on a 0x0 root implies PAINT containment, which clipped
//      every descendant — created, animated, removed with 0.00% changed pixels.
//   2. A stroked 1.5px accent ring around a white disc: read as hand-drawn.
//   3. A gradient *annulus* — still a ring, just a soft-edged one.
//   4. A single off-centre specular bloom. Better, but still a *mark*.
//   5. The lens: no background, no border, no shadow, no gradient — just a
//      `backdrop-filter` bending what is underneath it. That is the only version
//      whose failure mode ("looks hand-drawn") is unreachable rather than merely
//      unlikely, and the checks below are mostly *absence* checks. They are the
//      design.
//
// The live revision is 5 plus a specular rim, which looks like a return to 3 and
// is not. Three was a uniform ring: the same alpha all the way round, so it read
// as a circle someone drew. The rim is a *lit* edge — its alpha is masked by a
// conic gradient, bright toward the upper-left where the theme's own light pools
// are and dim on the far side, which is the cue Apple documents for fill-less
// glass ("Glass has no solid fill, so the bright rim is often the strongest cue
// for where a control begins and ends"). It exists because air reported the lens
// is too subtle to see against flat fills, which is true and measurable: a
// refraction needs structure underneath and a solid panel has none. The rim is
// the one cue that does not require any.
// ---------------------------------------------------------------------------
/** The declaration body of the first rule whose selector matches exactly. */
function ruleBody(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(bootCss);
  return m === null ? '' : m[1];
}

/** Every declaration body for a selector, in source order. */
function ruleBodies(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 'g');
  return [...bootCss.matchAll(re)].map((m) => m[1]);
}

const glintBlock = ruleBody('.dsl-ripple-glint');
const rimBlock = ruleBody('.dsl-ripple-glint::after');
const rippleBlocks = [
  '.dsl-ripple-glint',
  '.dsl-ripple-glint[data-held="true"]',
  '.dsl-ripple-glint[data-releasing="true"]'
]
  .map(ruleBody)
  .join('\n');

// The two assertions that have to cold-boot the plugin — the rim's response to
// the slider, and its agreement with the attribution tool's sampling geometry —
// live further down, in the render section. `renderWith` disposes the instance
// it boots, and the module-scope boot is what installed `#dsl-liquid-defs`, so
// calling it from here would rip the SVG filters out from under the refraction
// probes below. This is not a style preference; it is the reason.
check('ripple glint is injected', bootCss.includes('.dsl-ripple-glint'));
check('ripple root is full-viewport', /\.dsl-ripple-root\s*\{[^}]*inset:\s*0/.test(bootCss));
check('ripple root does not paint-clip', !/\.dsl-ripple-root\s*\{[^}]*contain:\s*(strict|paint)/.test(bootCss));
check(
  'ripple has no stroked outline',
  !/\.dsl-ripple-glint\s*\{[^}]*border:\s*[\d.]+px/.test(bootCss),
  'a hard border is what made it look drawn rather than lit'
);
check(
  'the glint disc still paints no fill of its own',
  !/background|box-shadow|border\s*:|outline/.test(glintBlock),
  'the fourth design is the only one where "looks hand-drawn" is impossible: there is no mark on screen to read as drawn — and the third revision adds the rim WITHOUT putting a fill back on the disc, which is the whole reason it lives one selector over'
);
check(
  'the specular rim is drawn on a pseudo-element',
  rimBlock !== '',
  'not a stylistic choice: mask-image clips everything its element paints, so a mask on .dsl-ripple-glint would clip the backdrop-filter lens away along with the rim'
);
check(
  'the rim is lit by a conic mask, not applied uniformly',
  // Anchored at a line start: `mask-image:` is a substring of
  // `-webkit-mask-image:`, so an unanchored pattern passes even when the plain
  // declaration has been replaced by `none` and only the prefixed one survives.
  /\n\s*mask-image:\s*conic-gradient\(from 315deg/.test(rimBlock) && !rimBlock.includes('url('),
  'a ring of even alpha is a drawn circle; the conic lobe makes one side bright and the far side dim, which is the only thing that separates a lit edge from a stroke'
);
check(
  'the rim mask goes dark on the far side instead of all the way round',
  (() => {
    const far = Number((rimBlock.match(/rgba\(0,0,0,([\d.]+)\)\s*180deg/) ?? [])[1]);
    const near = Number((rimBlock.match(/rgba\(0,0,0,([\d.]+)\)\s*90deg/) ?? [])[1]);
    return Number.isFinite(far) && Number.isFinite(near) && far <= 0.2 && far < near * 0.6;
  })(),
  'light does not wrap. The first version masked the far side at 0.42, which left a closed ring of near-even brightness — angular contrast measured at only 2.2x, and at 4x zoom it was visibly a drawn circle, the failure three earlier designs died for'
);
check(
  'the rim mask is mirrored for the -webkit- prefix',
  /-webkit-mask-image:\s*conic-gradient/.test(rimBlock),
  'the same two-declaration rule as the blur and the lens: this shell is Chromium-only today, and a prefix that is only added after a report of "nothing happened" is a prefix that was missing'
);
check(
  'the rim is two-tone so it reads on both colour schemes',
  (() => {
    // Not a presence test on the literals: the annulus ends with a transparent
    // stop in the shade colour, so `rgba(12,18,34,` survives the shade being
    // deleted. Alpha is the thing that has to be there.
    const lights = [...rimBlock.matchAll(/rgba\(255,255,255,\s*([\d.]+)\)/g)].map((m) => Number(m[1]));
    const shades = [...rimBlock.matchAll(/rgba\(12,18,34,\s*([\d.]+)\)/g)].map((m) => Number(m[1]));
    return lights.some((a) => a > 0.05) && shades.some((a) => a > 0.02);
  })(),
  'white inside the wall, a faint shade where it turns away: on dark the white line reads, on light the dark line reads, and neither needs a scheme query it could not get anyway'
);
check(
  'the rim is a gradient annulus, never a stroked border',
  !/(?:^|[\s;])border:\s*[\d.]+px/.test(rimBlock) && rimBlock.includes('radial-gradient(closest-side'),
  'a border is the one primitive that always reads as "someone drew a circle"'
);
// The rim's response to the slider is asserted in the render section below,
// under "Specular rim".
check(
  'ripple applies no uniform value shift to its disc',
  !rippleBlocks.includes('brightness('),
  'a uniform lift clipped to a 50%-radius disc IS that disc wherever the backdrop is darker than the lift — the circle comes back through the value channel instead of the colour channel, and it renders as a foggy spot with an edge'
);
check(
  'ripple is a lens, not a lift',
  ruleBodies('.dsl-ripple-glint').some((b) => /backdrop-filter:[^;]*url\(#dsl-drop\)/.test(b)),
  'the press is a bent backdrop, not a brightened one'
);
check(
  'ripple keeps a url()-free fallback in its own earlier rule',
  ruleBodies('.dsl-ripple-glint').some((b) => b.includes('backdrop-filter') && !b.includes('url(')),
  'an engine that cannot parse url() inside backdrop-filter drops the whole declaration, so bundling both values into one rule leaves those engines with no ripple at all'
);
check(
  'ripple holds while pressed and dissolves on release',
  bootCss.includes('.dsl-ripple-glint[data-held="true"]') &&
    bootCss.includes('.dsl-ripple-glint[data-releasing="true"]'),
  'fire-and-forget on pointerdown is what made it feel mechanical'
);
check(
  'ripple motion stays inside the 300ms interaction budget',
  (() => {
    const times = [...rippleBlocks.matchAll(/(\d+)ms/g)].map((m) => Number(m[1]));
    return times.length >= 4 && times.every((n) => n <= 300);
  })(),
  'a transition long enough to be watched is a transition that feels sluggish'
);
// The shape fix, asserted on the thing that fixed it rather than on the shape.
//
// air: "现在的形状怎么是一个圆形外套一个方圆型" — and thirteen rendered variants
// plus a GPU-flavoured re-run could not reproduce it, so there was no pixel
// assertion to add: the artifact lives in a compositor this machine never
// reaches. What was reproducible is the *arrangement that could produce it* —
// the disc growing by `transform: scale()`, which lets Blink rasterise the
// filtered backdrop once in the element's local space and hand the layer to the
// compositor to be scaled. A clip resolved on one side of that handoff and not
// the other is a circle drawn inside something that is not a circle.
//
// So this pins the handoff's absence, and pairs it with the presence of the
// replacement. Absence alone would pass on a disc that never grows at all, and
// that version is worse than the bug: a ripple that does not move. Both halves
// fail together on any real regression, and neither fires on a retune of the
// sizes, the easing or the rim — which is what makes it worth keeping.
check(
  'the ripple disc grows by layout, not by a compositor handoff',
  !/transform\s*:/.test(rippleBlocks) &&
    /\.dsl-ripple-glint\[data-held="true"\]\s*\{[^}]*width:\s*\d+px/.test(bootCss) &&
    /\.dsl-ripple-glint\[data-held="true"\]\s*\{[^}]*height:\s*\d+px/.test(bootCss),
  'the held and released states have to declare the box that grows, and no rule in the ' +
    'chain may carry a transform: a transformed layer is rasterised in its own space and ' +
    'then scaled by the compositor, and that handoff is the one thing air\'s screen had that ' +
    'no local capture can reproduce. Removing the transform removed the handoff — this is ' +
    'the only assertion that notices if it comes back (tools/_preview/lensregion.mjs, 13 ' +
    'variants, all discs: the artifact itself was never reproducible here)'
);
check('frosted blur wired to a variable', bootCss.includes('backdrop-filter: var(--dsl-blur)'));

// ---------------------------------------------------------------------------
// Refraction
//
// The part that makes this glass rather than tinted plastic, and the part that
// spent a whole round defined-but-never-called. Three things can silently kill
// it and all three leave the CSS looking correct:
//
//   · the filter is never injected, so `url()` resolves to `none` and takes the
//     blur down with it;
//   · `color-interpolation-filters` is left at its linearRGB default, in which
//     the map's 128-neutral does not decode back to neutral and the whole
//     backdrop shifts sideways;
//   · the map's ramp is too wide, so instead of a rim you get a funhouse mirror.
//
// The channel selectors are checked because swapping R and G produces a
// plausible warp rotated 90°, which reads as "the map is odd" rather than as the
// bug it is.
// ---------------------------------------------------------------------------
const defs = findById(body, 'dsl-liquid-defs');
const refract = findById(body, 'dsl-refract');
const drop = findById(body, 'dsl-drop');
const kids = (el) => (el === null ? [] : el.children ?? []);
const byTag = (el, tag) => kids(el).filter((c) => c.tagName === tag.toUpperCase())[0] ?? null;

check('refraction defs are injected', defs !== null);
check('edge lens filter exists', refract !== null);
check('droplet filter exists', drop !== null);
check(
  'lens is declared in sRGB',
  refract !== null && refract.attributes['color-interpolation-filters'] === 'sRGB',
  'linearRGB does not decode the map\'s 128-neutral back to neutral — the entire backdrop visibly shifts'
);
check(
  'lens region is grown past the element box',
  refract !== null &&
    refract.attributes.x === '-20%' &&
    refract.attributes.width === '140%',
  'displaced pixels are clipped at the element bounds otherwise'
);
check(
  'lens reads X from R and Y from G',
  (() => {
    const fd = byTag(refract, 'feDisplacementMap');
    return fd !== null && fd.attributes.xChannelSelector === 'R' && fd.attributes.yChannelSelector === 'G';
  })(),
  'swapping the channels yields a plausible warp rotated 90°, which reads as a bad map rather than a bug'
);
check(
  'the lens map is inlined, not linked',
  (() => {
    const img = byTag(refract, 'feImage');
    return img !== null && String(img.attributes.href ?? '').startsWith('data:image/png');
  })(),
  'feImage pointed at a URL silently fails from a zero-sized SVG, which looks exactly like "refraction unsupported"'
);
check(
  'the droplet map is inlined too',
  (() => {
    const img = byTag(drop, 'feImage');
    return img !== null && String(img.attributes.href ?? '').startsWith('data:image/png');
  })()
);

// ---------------------------------------------------------------------------
// Displacement-map geometry
//
// Read out of the recorded canvas pixels, because neither of the map bugs this
// suite has seen could be caught from the stylesheet. Both times the CSS was
// correct and the shape of the ramp was wrong, and the shape of the ramp is the
// whole difference between glass and a smear.
//
// The two maps are told apart by a property rather than by creation order: the
// edge lens drives X from a function of x only and Y from a function of y only,
// so it is separable, while the radial droplet couples the two.
// ---------------------------------------------------------------------------
const maps = CANVASES.filter((c) => c._patch !== null && c.width > 0).map((c) => ({
  size: c.width,
  data: c._patch.data
}));
const separable = (m) => {
  if (m.size < 16) return false;
  const at = (x, y) => {
    const i = (y * m.size + x) * 4;
    return [m.data[i], m.data[i + 1]];
  };
  // The edge lens writes X from a function of x alone and Y from a function of
  // y alone, so R must be constant down any column and G constant across any
  // row. (Getting this backwards is easy and the failure is silent: it just
  // swaps which map the checks below are measuring, and they then report the
  // edge lens as a broken droplet.)
  const colR = at(8, 0)[0];
  const rowG = at(0, 8)[1];
  for (let y = 0; y < m.size; y += 1) if (at(8, y)[0] !== colR) return false;
  for (let x = 0; x < m.size; x += 1) if (at(x, 8)[1] !== rowG) return false;
  return true;
};
// Magnitude as a fraction of full displacement: the channels encode a signed
// offset around 128, and the peak the generator normalizes to is 127.
const geom = (m) => {
  const half = (m.size - 1) / 2;
  const sample = (rn, angle) => {
    const x = Math.round(half + rn * half * Math.cos(angle));
    const y = Math.round(half + rn * half * Math.sin(angle));
    if (x < 0 || y < 0 || x >= m.size || y >= m.size) return null;
    const i = (y * m.size + x) * 4;
    const dx = m.data[i] - 128;
    const dy = m.data[i + 1] - 128;
    return { mag: Math.hypot(dx, dy) / 127, radial: (dx * Math.cos(angle) + dy * Math.sin(angle)) / 127 };
  };
  const ring = (rn, lo, hi) => {
    const vals = [];
    for (let i = 0; i < 72; i += 1) {
      const s = sample(rn, (i / 72) * Math.PI * 2);
      if (s !== null) vals.push(s);
    }
    return vals;
  };
  const mean = (vals, pick) => vals.reduce((a, v) => a + pick(v), 0) / Math.max(1, vals.length);
  const band = (lo, hi) => {
    const vals = [];
    for (let rn = lo; rn <= hi; rn += 0.02) vals.push(...ring(rn, lo, hi));
    return vals;
  };
  return { sample, ring, mean, band };
};

const dropMap = maps.find((m) => !separable(m)) ?? null;
const edgeMap = maps.find(separable) ?? null;

check('both displacement maps were built', maps.length >= 2 && dropMap !== null, `found ${maps.length} canvas(es)`);
check(
  'the edge lens map is separable, the droplet is not',
  edgeMap !== null && dropMap !== null,
  'the edge lens drives X from x alone and Y from y alone; a radial lens cannot be factored that way'
);

if (dropMap !== null) {
  const g = geom(dropMap);
  const peak = Math.max(...g.band(0.02, 0.98).map((v) => v.mag));
  const centre = g.mean(g.band(0, 0.12), (v) => v.mag);
  const inner = g.mean(g.band(0.24, 0.36), (v) => v.mag);
  const rim = g.mean(g.band(0.72, 0.86), (v) => v.mag);
  const outerEdge = g.mean(g.band(0.96, 1), (v) => v.mag);
  const outward = g.mean(g.band(0.4, 0.9), (v) => v.radial);

  check(
    'the droplet has no singular point at the centre',
    g.mean(g.band(0, 0.02), (v) => v.mag) < 0.03,
    `measured ${g.mean(g.band(0, 0.02), (v) => v.mag).toFixed(3)} right at r=0 — the very first profile used 1 - r², which is MAXIMAL here, and at r=0 the encoded direction is 0/0, so maximum magnitude times an arbitrary unit vector flipped between neighbouring pixels and rendered as a pinwheel`
  );
  check(
    'the droplet grows outward from a quiet centre',
    centre < 0.12 && inner > centre && rim > inner,
    `centre ${centre.toFixed(3)} → inner ${inner.toFixed(3)} → rim ${rim.toFixed(3)} of full displacement. A dimple is flat in the middle and steep at its wall, so deflection has to rise with radius; the 4r(1-r) profile this replaced was centre-heavy (inner ≈ 0.84), which put full displacement across the whole interior and rendered as fog`
  );
  check(
    'the droplet bends at its rim, not across its middle',
    rim > 0.6 && inner < 0.45 && rim > inner * 1.8,
    `inner band ${inner.toFixed(3)} of full, rim band ${rim.toFixed(3)}, peak ${peak.toFixed(3)} — a profile that peaks at half radius (the previous 4r(1-r)) puts full displacement over the whole interior, which renders as fog rather than as a press`
  );
  check(
    'the droplet fades out at its edge',
    outerEdge < 0.08,
    `measured ${outerEdge.toFixed(3)} at r≈0.98 — a ramp that stops abruptly draws a circle even with no colour in it, because the eye reads the discontinuity in the warp as an edge`
  );
  check(
    'the droplet minifies — it samples outward',
    outward > 0.2,
    `mean radial component ${outward.toFixed(3)}; a dimple is thin in the middle, so it diverges and what is behind it shrinks. Negative here would mean the press magnifies, which reads as a bubble, not a press`
  );
}

check(
  'each filter scale matches its published token',
  (() => {
    const published = (name) => Number((bootCss.match(new RegExp(`--${name}:\\s*(\\d+)`)) ?? [])[1] ?? -1);
    const edge = byTag(refract, 'feDisplacementMap');
    const drip = byTag(drop, 'feDisplacementMap');
    return (
      edge !== null &&
      drip !== null &&
      Number(edge.attributes.scale) === published('dsl-lens-scale') &&
      Number(drip.attributes.scale) === published('dsl-drop-scale')
    );
  })(),
  `edge ${(() => {
    const fd = byTag(refract, 'feDisplacementMap');
    return fd === null ? 'n/a' : fd.attributes.scale;
  })()} vs --dsl-lens-scale ${(bootCss.match(/--dsl-lens-scale:\s*(\d+)/) ?? [])[1]} · ` +
    `drop ${(() => {
      const fd = byTag(drop, 'feDisplacementMap');
      return fd === null ? 'n/a' : fd.attributes.scale;
    })()} vs --dsl-drop-scale ${(bootCss.match(/--dsl-drop-scale:\s*(\d+)/) ?? [])[1]} — ` +
    'both pairs come from one function each, precisely so the published numbers cannot ' +
    'drift away from the filters they describe'
);
check(
  'refraction is opt-in on floating surfaces only',
  // A full-height pane would get a bezel hundreds of px wide, which reads as a
  // warp rather than as thickness — Apple's own guidance points the same way:
  // controls float above content, content does not float.
  //
  // Matched on `var(--dsl-refract)` rather than on the literal url(): the token
  // is declared once in the variant block and referenced by the rule, so the
  // rule text never contains the url at all.
  /\[role="dialog"\][^{]*\{[^}]*var\(--dsl-refract\)/.test(bootCss) &&
    !/\[data-dockkit-pane\][^{]*\{[^}]*var\(--dsl-refract\)/.test(bootCss),
  'panes get the blur only; only floats get the lens'
);

// Dead selectors are worse than missing ones: they look like coverage. Each
// clause below was counted in the shipped app.asar before being trusted.
check('frosted surfaces target real panes', bootCss.includes('[data-dockkit-pane]'));
check('frosted surfaces target real floats', bootCss.includes('[data-dockkit-float]'));
check(
  'no selector clause that matches nothing',
  !bootCss.includes('md-text'),
  '`[data-conversation-scroll] .md-text` had 0 occurrences in the shipped bundle'
);

// ---------------------------------------------------------------------------
// Surface coverage — the harvest
//
// The reason the real window did not match the previews: the surface list was
// hand-written and incomplete, so `--dsw-specific-sidebar-fill` (measured
// carrying BOTH the sidebar and the top bar at #1b1b1c) was never overridden
// and those areas stayed stock grey while the main frame went translucent.
// These assert the harvest reaches the tokens that actually paint the shell.
// ---------------------------------------------------------------------------

function tokenBlock(css, selector) {
  const start = css.indexOf(`${selector} {`);
  if (start === -1) return '';
  return css.slice(start, css.indexOf('}', start));
}

const darkTokens = tokenBlock(bootCss, 'body[data-ds-dark-theme]');
const lightTokens = tokenBlock(bootCss, 'body');
const valueIn = (block, name) => {
  const m = new RegExp(`${name.replace(/[-]/g, '\\-')}:\\s*([^;]+);`).exec(block);
  return m === null ? null : m[1].trim();
};
const alphaIn = (block, name) => {
  const v = valueIn(block, name);
  const m = v === null ? null : /rgba\([^)]*?,\s*([\d.]+)\)$/.exec(v);
  return m === null ? null : Number(m[1]);
};

console.log('surface coverage');
check('dark block carries glassed surfaces', darkTokens.includes('--dsw-alias-bg-base'));
check(
  'the sidebar/top-bar token is covered, not missed',
  valueIn(darkTokens, '--dsw-specific-sidebar-fill') !== null &&
    valueIn(darkTokens, '--dsw-specific-sidebar-fill') !== '#1b1b1c',
  'this token was the whole reason the sidebar and top bar stayed stock grey'
);
check(
  'harvest resolves var() chains',
  alphaIn(darkTokens, '--dsw-specific-sidebar-fill') !== null,
  '--dsw-specific-sidebar-fill is written as var(--dsw-static-neutral-bluish-900)'
);
check(
  'every listed surface token is emitted',
  // 26 tokens in GLASS_TOKENS, minus the one the fixture legitimately omits.
  (darkTokens.match(/--dsw-(alias|specific|menu)-/g) ?? []).length >= 20,
  `${(darkTokens.match(/--dsw-(alias|specific|menu)-/g) ?? []).length} tokens`
);
check(
  'the plugin never harvests its own overrides',
  !bootCss.includes(OWN_SHEET_MARKER) && !valueIn(darkTokens, '--dsw-alias-bg-base').includes('1,2,3'),
  're-reading our own sheet would fold glassed values back in as if official'
);
check(
  'surfaces are translucent at default intensity',
  alphaIn(darkTokens, '--dsw-alias-bg-base') < 0.7 && alphaIn(darkTokens, '--dsw-alias-bg-base') > 0.3,
  `bg-base alpha ${alphaIn(darkTokens, '--dsw-alias-bg-base')}`
);
check(
  'floating chrome keeps some body at the default position',
  alphaIn(darkTokens, '--dsw-menu-surface-fill') > 0.2,
  `menu surface alpha ${alphaIn(darkTokens, '--dsw-menu-surface-fill')} — this used to be a 0.35 ` +
    'floor, and the floor was the wrong kind of claim. It encoded a decision (how transparent a ' +
    'menu may be) rather than the invariant it was protecting (depth still reads as depth), so it ' +
    'had to move the moment the decision changed. The invariant now lives in its own check at ' +
    '2.0x, where the tier endpoints and not the harvested official alphas decide the answer.'
);
check(
  'already-translucent official values survive as the low end',
  valueIn(lightTokens, '--dsw-menu-surface-fill') !== '#ffffffc7',
  'the official alpha becomes the bottom of the range, never a reason to skip'
);

const open = (bootCss.match(/\{/g) ?? []).length;
const close = (bootCss.match(/\}/g) ?? []).length;
check('braces balanced', open === close, `${open} open / ${close} close`);

// ---------------------------------------------------------------------------
// apply(ctx)
// ---------------------------------------------------------------------------

function makeCtx() {
  const state = { effects: [], disposes: [], injected: [], registered: [], components: [], dicts: null };
  const ctx = {
    state,
    effect: (fn) => {
      state.effects.push(fn);
      const dispose = fn();
      state.disposes.push(typeof dispose === 'function' ? dispose : () => {});
    },
    // Both halves are kept. `registered` is the declaration (what the earlier
    // assertions read), `components` is the thing that actually renders — and a
    // panel that renders is the only way to assert what it says to the user.
    locale: {
      register: (_ns, dicts) => {
        state.dicts = dicts;
        return () => {};
      },
      bind: () => (key) => key
    },
    slots: {
      inject(slot, factory) {
        state.injected.push(slot);
        factory();
      },
      register(def, component) {
        state.registered.push(def);
        state.components.push(component);
        return () => {};
      }
    }
  };
  return ctx;
}

console.log('apply(ctx)');
const ctx = makeCtx();
bundle.apply(ctx);

check('one effect per concern', ctx.state.effects.length === 3, `${ctx.state.effects.length}`);
check('settings.section injected', ctx.state.injected.includes('settings.section'));
check('section registered at order 42', ctx.state.registered.some((d) => d.id === 'liquid-glass' && d.order === 42));
check('section declares its child slot', ctx.state.registered.some((d) => d.children !== undefined));
check('section chrome styles mounted', findById(head, 'dsl-section-style') !== null);
check('panel component registered', ctx.state.registered.some((d) => d.name === 'dsh.liquid-glass.item'));
check('style tag kept last in head', head.lastElementChild === findById(head, 'dsl-theme-style'));

// ---------------------------------------------------------------------------
// Click ripples
// ---------------------------------------------------------------------------

console.log('click ripples');
const root = () => findByClass(body, 'dsl-ripple-root');
const glints = () => countByClass(root(), 'dsl-ripple-glint');
check('no ripple root before first click', root() === null);

documentStub.dispatch('pointerdown', { button: 0, buttons: 1, pointerType: 'mouse', clientX: 120, clientY: 240 });
check('one glint spawns per press', glints() === 1, `${glints()} found`);
check('the old disc+ring pair is gone', countByClass(root(), 'dsl-ripple-disc') === 0);
check(
  'glint is anchored at the pointer',
  (() => {
    const holder = root().children[0];
    return holder.style.left === '120px' && holder.style.top === '240px';
  })()
);

documentStub.dispatch('pointerdown', { button: 2, buttons: 2, pointerType: 'mouse', clientX: 10, clientY: 10 });
check('right click ignored', glints() === 1);

// Release must mark the glint for dissolution. Without this the effect would be
// a permanent blob under the cursor rather than a light that expands and fades.
documentStub.dispatch('pointerup', { button: 0 });
const held = findByClass(root(), 'dsl-ripple-glint');
check(
  'release starts the dissolve',
  held !== null && held.dataset.releasing === 'true' && held.dataset.held === 'false',
  'data-releasing drives the expand-and-fade transition'
);

for (let i = 0; i < 30; i += 1) {
  documentStub.dispatch('pointerdown', { button: 0, buttons: 1, pointerType: 'mouse', clientX: i, clientY: i });
}
const burst = glints();
check('concurrency capped at 6', burst <= 6, `${burst} glints`);

// ---------------------------------------------------------------------------
// Disposing the first instance. The real host activates the plugin once, so
// tearing down before loading a second copy keeps the assertions honest.
// ---------------------------------------------------------------------------

console.log('dispose first instance');
for (const dispose of ctx.state.disposes) dispose();
check('ripple root removed on dispose', findById(body, 'dsl-ripple-root') === null);
check('pointerdown listener removed on dispose', (documentStub._el.listeners.get('pointerdown') ?? []).length === 0);
check('pointerup listener removed on dispose', (documentStub._el.listeners.get('pointerup') ?? []).length === 0);

// ---------------------------------------------------------------------------
// Config mutations (cold boot with a different mirror)
// ---------------------------------------------------------------------------

console.log('config mutations');
storage.set(
  'dsh_liquid_glass_config',
  JSON.stringify({ enabled: true, surface: false, cursor: false, ripple: false, intensity: 1.6, tint: 'slate' })
);
const bundle2 = registration.factory(mockRequire);
const ctx2 = makeCtx();
bundle2.apply(ctx2);
const after = styleText();

check('tint switch rewrites the sheet', after !== bootCss);
check('slate accent applied', after.includes('--dsw-alias-brand-primary: #0f9d76'), 'slate light accent');
check('cursor rules dropped when off', !after.includes('cursor: url("data:image/svg+xml'));
check('ripple rules dropped when off', !after.includes('.dsl-ripple-glint'));
check('surface rules dropped when off', !after.includes('backdrop-filter: var(--dsl-blur)'));
check(
  'surface off leaves the tokens alone',
  !tokenBlock(after, 'body').includes('--dsw-alias-bg-base'),
  'no glass at all: every surface renders exactly as the Harness wrote it'
);
check(
  'surface off drops the wallpaper too',
  findById(body, 'dsl-wallpaper') === null,
  'an opaque shell would hide it anyway - compositing a hidden layer is waste'
);

// Intensity has to move more than the blur radius. When it only drove blur, the
// slider changed ~5% of pixels by an average of 0.21 per channel — invisible.
// These assert the SEMANTICS, not a hardcoded number, so re-tuning the
// constants later cannot break them.
// (`BASE_CFG` is declared at the top of the file — see the note there.)

/**
 * Cold-boot the plugin from a localStorage mirror and read the result back.
 *
 * @param {object} cfg the mirrored config document
 * @param {'patched'|'stock'|'unknown'} [material] what the mirror says about
 *   the client archive. Defaults to `'stock'` — the state of a machine that has
 *   not run the patch, which is also the case every existing assertion was
 *   written against.
 */
function renderWith(cfg, material = 'stock') {
  storage.set('dsh_liquid_glass_config', JSON.stringify(cfg));
  storage.set('dsh_liquid_glass_material', JSON.stringify(material));
  const b = registration.factory(mockRequire);
  const c = makeCtx();
  b.apply(c);
  const css = styleText();
  const el = findById(body, 'dsl-wallpaper');
  const wallpaper = el === null ? '' : String(el.style.backgroundImage);
  const opacity = el === null ? null : String(el.style.opacity);
  const reveal = el === null ? null : String(el.dataset?.reveal);
  for (const dispose of c.state.disposes) dispose();
  return { css, wallpaper, opacity, reveal };
}

function alphaOf(text, rgb) {
  const m = text.match(new RegExp(`rgba\\(\\s*${rgb.replace(/,/g, ',\\s*')}\\s*,\\s*([\\d.]+)\\)`));
  return m === null ? null : Number(m[1]);
}

/**
 * Split on a separator that sits at bracket depth 0.
 *
 * A naive `split(',')` shreds `color-mix(in srgb, var(--x, #fff) 24%, transparent) 46%`
 * into four pieces and `radial-gradient(circle at 44% 40%, …)` into two — which
 * makes a stop list and a background layer list both unreadable. Every CSS
 * value in this theme nests at least one comma inside parentheses.
 */
function splitTopLevel(text, sep = ',') {
  const out = [];
  let buf = '';
  let depth = 0;
  for (const ch of String(text)) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === sep && depth === 0) {
      out.push(buf);
      buf = '';
      continue;
    }
    buf += ch;
  }
  out.push(buf);
  return out;
}

/** Alpha of the radial vignette's outer stop, or null if the layer is absent. */
function vignetteAlpha(wallpaper) {
  const layer = splitTopLevel(wallpaper)[0];
  if (layer === undefined) return null;
  const m = /rgba\([^)]*?,\s*([\d.]+)\)\s*100%/.exec(layer);
  return m === null ? null : Number(m[1]);
}

const lowRun = renderWith({ ...BASE_CFG, intensity: 0.2 });
const highRun = renderWith({ ...BASE_CFG, intensity: 2 });
const midRun = renderWith({ ...BASE_CFG, intensity: 1 });
const cssLow = lowRun.css;
const cssHigh = highRun.css;
const cssMid = midRun.css;

// ---------------------------------------------------------------------------
// Specular rim, the half that needs a cold boot
//
// These are here rather than beside the rest of the rim checks because
// `renderWith` disposes the instance it boots, and the module-scope boot is
// what installed the SVG filter defs the refraction probes above depend on.
// ---------------------------------------------------------------------------

/** The rim's peak highlight alpha, as rendered. */
function rimAlphaAt(intensity) {
  const css = renderWith({ ...BASE_CFG, ripple: true, intensity }).css;
  const m = /\.dsl-ripple-glint::after\s*\{([^}]*)\}/.exec(css);
  if (m === null) return null;
  const alphas = [...m[1].matchAll(/rgba\(\s*255\s*,\s*255\s*,\s*255\s*,\s*([\d.]+)\s*\)/g)].map((n) => Number(n[1]));
  return alphas.length === 0 ? null : Math.max(...alphas);
}

const rimLow = rimAlphaAt(0.2);
const rimHigh = rimAlphaAt(2);
check(
  'the rim brightens with the effect and never disappears',
  rimLow !== null && rimHigh !== null && rimLow > 0.02 && rimHigh > rimLow + 0.05,
  `rim alpha ${rimLow} at 0.2x -> ${rimHigh} at 2.0x — it is the only cue for where the disc begins and ends, so it may fade but must not vanish, and a rim that ignored the slider would be the same "strength does nothing" bug as before`
);
check(
  'the rim lands inside the bucket the attribution tool measures',
  (() => {
    const css = renderWith({ ...BASE_CFG, ripple: true, intensity: 2 }).css;
    const body = /\.dsl-ripple-glint::after\s*\{([^}]*)\}/.exec(css);
    // Read the HELD size, not the first `width:` in the file. The disc now has
    // three sizes — rest, held and released — and taking whichever one appeared
    // first silently switched this check to measuring the invisible pre-hold
    // state, where the geometry is a third of the size the tool samples at.
    const heldBlock = /\.dsl-ripple-glint\[data-held="true"\]\s*\{([^}]*)\}/.exec(css);
    const size = Number(/width:\s*(\d+)px/.exec(heldBlock?.[1] ?? '')?.[1]);
    if (body === null || !Number.isFinite(size)) return false;
    const radius = size / 2;
    const widths = [...body[1].matchAll(/calc\(100% - ([\d.]+)px\)/g)].map((n) => Number(n[1]));
    if (widths.length === 0) return false;
    // dropcheck.py reports three buckets: core d < 0.8R, rim 0.84R <= d <= 1.06R,
    // outside 1.1R < d < 1.3R. The annulus has to fall inside the middle one or
    // the tool prints 0.00% changed and the feature looks absent in the only
    // instrument pointed at it.
    const inner = radius - Math.max(...widths);
    return inner >= 0.84 * radius && radius <= 1.06 * radius;
  })(),
  'the geometry the CSS draws and the geometry dropcheck.py samples have to agree, and nothing else in the suite would notice if they drifted apart'
);

/** The ripple disc's held diameter, read out of the generated sheet. */
function heldWidth(css) {
  const held = /\.dsl-ripple-glint\[data-held="true"\]\s*\{([^}]*)\}/.exec(css);
  return Number(/width:\s*(\d+)px/.exec(held?.[1] ?? '')?.[1]);
}

check(
  'the ripple size control scales the disc, and the mirror clamps it',
  (() => {
    // `renderWith` boots through the localStorage mirror, so this exercises the
    // renderer's own clamp as well as the arithmetic — the two live in separate
    // functions and only one of them is reachable from the host-side tests.
    const sizeAt = (rippleSize) =>
      heldWidth(renderWith({ ...BASE_CFG, ripple: true, intensity: 2, rippleSize }).css);
    return (
      sizeAt(0.5) === 70 &&
      sizeAt(1) === 140 &&
      sizeAt(2) === 280 &&
      // Out of range is clamped rather than rejected, in both directions.
      sizeAt(9) === 280 &&
      sizeAt(0.01) === 70
    );
  })(),
  '140px at 100% — the size every previous round was tuned against, so the control has to be a ' +
    'no-op at its default — plus 70px at 50% and 280px at 200%, with both ends clamped in the ' +
    'mirror. A slider that drifted out of range must not be able to wedge the ripple into a size ' +
    'nothing was ever measured at.'
);
check(
  'the ripple lens scales with the disc, so size is not a second strength control',
  (() => {
    const dropScaleAt = (rippleSize) =>
      Number(
        (renderWith({ ...BASE_CFG, ripple: true, intensity: 2, rippleSize }).css.match(
          /--dsl-drop-scale:\s*(\d+)/
        ) ?? [])[1] ?? -1
      );
    return dropScaleAt(0.5) === 13 && dropScaleAt(1) === 26 && dropScaleAt(2) === 52;
  })(),
  '26px at the default, and half or double with the diameter — the displacement map is stretched ' +
    'over the element box, so a bigger disc with an unchanged peak is the same lens seen through a ' +
    'magnifier: doubling the size would read as "bigger and flatter" rather than as the same press ' +
    'at twice the scale'
);

// slate light accent is #0f9d76 and lives in the wallpaper layer header.
const wallAlphas = (text) =>
  [...text.matchAll(/rgba\([\d,\s]+,\s*([\d.]+)\)/g)].map((m) => Number(m[1])).filter((n) => n > 0);
const wallPeak = (text) => (wallAlphas(text).length === 0 ? null : Math.max(...wallAlphas(text)));

check('intensity rewrites the sheet', cssLow !== cssHigh && cssMid !== cssLow);
check(
  'the wallpaper lives on the wallpaper element, not in the sheet',
  lowRun.wallpaper.includes('radial-gradient') && !cssLow.includes('radial-gradient'),
  'a real element cannot be reset by the official background shorthand'
);
check(
  'higher intensity deepens the wallpaper',
  wallPeak(lowRun.wallpaper) !== null &&
    wallPeak(highRun.wallpaper) !== null &&
    wallPeak(highRun.wallpaper) > wallPeak(lowRun.wallpaper) * 1.5,
  `peak layer alpha ${wallPeak(lowRun.wallpaper)} -> ${wallPeak(highRun.wallpaper)}`
);
// ---------------------------------------------------------------------------
// The backdrop carries no hue. This is the invariant behind air's "你现在只不过
// 是加了个彩虹壁纸", and it is the one thing about the backdrop that must never
// drift: a coloured field behind a neutral material puts the most saturation
// exactly where the material is least visible. Every preset is a grey ramp that
// differs only in temperature, and the accent is the only saturated colour in
// the theme. Checked on the *wash*, which is the opaque layer and therefore the
// one that decides whether the window reads as a picture.
// ---------------------------------------------------------------------------
check(
  'the backdrop wash is grey, not a colour',
  (() => {
    const m = /linear-gradient\([^,]+,\s*(#[0-9a-f]{6})[^,]*,\s*(#[0-9a-f]{6})[^,]*,\s*(#[0-9a-f]{6})/i.exec(
      highRun.wallpaper
    );
    if (m === null) return false;
    const chroma = (hex) => {
      const n = parseInt(hex.slice(1), 16);
      const r = (n >> 16) & 255;
      const g = (n >> 8) & 255;
      const b = n & 255;
      return Math.max(r, g, b) - Math.min(r, g, b);
    };
    // 20/255 is generous for "grey with a temperature" — a saturated preset
    // would sit at 60–120 here (the old teal was 100).
    return m.slice(1).every((hex) => chroma(hex) <= 20);
  })(),
  'a hue in the wash is what made the window read as a rainbow wallpaper rather than as glass'
);
// The vignette is what stops the four blobs reading as four circles: each
// blob's own falloff still ends in an arc, but those arcs land in the outer
// band, and darkening that band hides them. It is also the depth cue — the
// middle of the window, where the content is, ends up the brightest region.
check(
  'the wallpaper carries a vignette above the blobs',
  (() => {
    const layers = splitTopLevel(highRun.wallpaper);
    // background-image is written top-first, so layer 0 is the vignette and the
    // opaque wash is the last layer.
    return (
      layers.length >= 3 &&
      /radial-gradient/.test(layers[0]) &&
      /rgba\([\d,\s]+,0\)/.test(layers[0]) &&
      /100%\)/.test(layers[0])
    );
  })(),
  'without it every blob ends in a visible arc and the eye counts circles'
);
check(
  'the vignette deepens with intensity',
  vignetteAlpha(lowRun.wallpaper) !== null &&
    vignetteAlpha(lowRun.wallpaper) < vignetteAlpha(highRun.wallpaper),
  `vignette alpha ${vignetteAlpha(lowRun.wallpaper)} -> ${vignetteAlpha(highRun.wallpaper)}`
);
check(
  'the wallpaper carries fine grain',
  /#dsl-wallpaper::after\s*\{[^}]*feTurbulence/.test(bootCss),
  'large smooth gradients band on 8-bit panels, and visible banding is the fastest way a gradient looks cheap'
);
// The 0.62 alpha ceiling in `scaleAlpha` is a legibility limit, not a taste
// one: an rgba(96,165,250) blob at the old 0.92 composited to a luminance of
// ~0.33, putting light body text on it near 2.3:1. This pins the ceiling.
check(
  'no wallpaper blob exceeds the legibility ceiling',
  (() => {
    const alphas = [...highRun.wallpaper.matchAll(/rgba\([\d,\s]+,\s*([\d.]+)\)/g)]
      .map((m) => Number(m[1]))
      // 0 is the vignette's inner stop; anything else is a blob or the wash.
      .filter((n) => n > 0);
    return alphas.length > 0 && alphas.every((n) => n <= 0.62);
  })(),
  'past this the composited luminance makes light text on it unreadable'
);
check(
  'higher intensity thins the glass',
  alphaIn(cssHigh, '--dsw-alias-bg-base') !== null &&
    alphaIn(cssHigh, '--dsw-alias-bg-base') < alphaIn(cssLow, '--dsw-alias-bg-base'),
  `bg-base alpha ${alphaIn(cssLow, '--dsw-alias-bg-base')} -> ${alphaIn(cssHigh, '--dsw-alias-bg-base')}`
);
// The user's ask, in one assertion: at the top of the slider the window is a
// full glass shell, not merely a bit more tinted.
check(
  'max intensity turns the whole window into glass',
  alphaIn(cssHigh, '--dsw-alias-bg-base') <= 0.12,
  `bg-base alpha ${alphaIn(cssHigh, '--dsw-alias-bg-base')} at intensity 2`
);
check(
  'min intensity is close to the stock look',
  alphaIn(cssLow, '--dsw-alias-bg-base') >= 0.8,
  `bg-base alpha ${alphaIn(cssLow, '--dsw-alias-bg-base')} at intensity 0.2 — cascade.mjs owns the ` +
    'pixel-level claim, and measures a region-mean spread of 1, i.e. flat next to the opaque control'
);
// Depth ordering has to hold at the extreme, not just on average: if the menus
// dissolved as far as the shell behind them the text would sit on wallpaper.
check(
  'menus stay readable even at full glass',
  alphaIn(cssHigh, '--dsw-menu-surface-fill') > alphaIn(cssHigh, '--dsw-alias-bg-base'),
  `menu ${alphaIn(cssHigh, '--dsw-menu-surface-fill')} vs backdrop ${alphaIn(
    cssHigh,
    '--dsw-alias-bg-base'
  )}`
);

// ---------------------------------------------------------------------------
// 透出桌面 — the desktop bleed-through switch
//
// Half of this feature is not in this plugin at all: the material behind the
// window is a main-process window option, applied by patching `app.asar`. What
// the plugin owns is the decision to stop painting over it, and the failure
// mode of getting that wrong is asymmetric in a way worth pinning down —
// painting over a material that IS there merely wastes it, while clearing the
// shell on a window that has no material reveals Electron's default white,
// which is worse than the shell it replaced. Hence the first three checks.
// ---------------------------------------------------------------------------
console.log('desktop bleed-through');

const desktopOn = (material, extra = {}) =>
  renderWith({ ...BASE_CFG, intensity: 2, desktop: true, ...extra }, material);

const noPatch = desktopOn('stock');
const unknownPatch = desktopOn('unknown');
const patched = desktopOn('patched');
const patchedOff = renderWith({ ...BASE_CFG, intensity: 2, desktop: false }, 'patched');
const noSurface = desktopOn('patched', { surface: false });

const revealOfRun = (run) => Number(run.reveal);
const htmlIsOpaque = (css) => /html\s*\{\s*background-color:\s*#[0-9a-f]{6}\s*!important/.test(css);

check(
  'an unpatched client ignores the switch entirely',
  revealOfRun(noPatch) === 0 && htmlIsOpaque(noPatch.css) && noPatch.opacity === '1',
  `reveal ${noPatch.reveal}, wallpaper opacity ${noPatch.opacity} — clearing the shell here would ` +
    'paint onto the window surface instead of onto a material, which is the one outcome worse ' +
    'than the shell it replaced'
);
check(
  'an undetectable client is treated as unpatched',
  revealOfRun(unknownPatch) === 0 && htmlIsOpaque(unknownPatch.css),
  `reveal ${unknownPatch.reveal} — unknown must fail in the safe direction, not in the optimistic one`
);
check(
  'a patched client with the switch off is untouched',
  revealOfRun(patchedOff) === 0 && htmlIsOpaque(patchedOff.css) && patchedOff.opacity === '1',
  `reveal ${patchedOff.reveal}`
);
check(
  'surface off refuses it too',
  noSurface.reveal === null && valueIn(noSurface.css, '--dsl-reveal') === '0',
  'no glass means no backdrop layer to fade, so the slider would jump from opaque to wide open ' +
    'instead of fading — the switch is gated on the material it belongs to'
);
check(
  'a patched client at full strength clears the window base',
  revealOfRun(patched) === 1 && !htmlIsOpaque(patched.css) && patched.opacity === '0',
  `reveal ${patched.reveal}, html ${htmlIsOpaque(patched.css) ? 'still opaque' : 'clear'}, ` +
    `wallpaper opacity ${patched.opacity} — the stated requirement, "强度最高时整个窗口透明", ` +
    'as three separate facts rather than one'
);

// Monotone AND exactly 1 at the top: the curve is allowed to be convex, the
// endpoint is not allowed to be almost-1.
const revealLadder = [0.2, 0.6, 1, 1.4, 2].map((intensity) => {
  const run = desktopOn('patched', { intensity });
  return { intensity, reveal: Number(run.reveal), opacity: Number(run.opacity) };
});
check(
  'reveal rises with the slider and lands on 1',
  revealLadder.every((step, i) => i === 0 || step.reveal > revealLadder[i - 1].reveal) &&
    revealLadder[revealLadder.length - 1].reveal === 1,
  revealLadder.map((s) => `${s.intensity}x=${s.reveal}`).join('  ')
);
check(
  'the wallpaper fades by exactly the reveal',
  revealLadder.every((s) => Math.abs(1 - s.opacity - s.reveal) < 0.002),
  revealLadder.map((s) => `${s.intensity}x: reveal ${s.reveal} + opacity ${s.opacity}`).join('  ') +
    ' — one number applied to one layer; a second curve here would be a fade that does not line up'
);
check(
  'the bottom of the slider is left alone',
  revealLadder[0].reveal < 0.05,
  `reveal ${revealLadder[0].reveal} at 0.2x — the low end has to stay indistinguishable from ` +
    'stock, and glassOf() alone already reads 0.178 there'
);

// The off-run is the reference for "what only the reveal changed". Computing it
// once also means the three comparisons below cannot disagree with each other.
//
// It has to be `patchedOff` (desktop: false), not a second `renderWith` of the
// same desktop-on config: the two would be the same string, the comparison
// below would read `0.03 vs 0.03`, and the check would be asserting that a
// value equals itself. That is exactly what it did until 2026-10-11 — it sat
// red while `patched` (desktop on) already closed the tier to 0, so the check
// was measuring nothing and failing on its own typo rather than on the code.
const patchedNoDesktop = patchedOff.css;
check(
  'the window base tier closes completely, and only it',
  alphaIn(patched.css, '--dsw-alias-bg-base') === 0 &&
    alphaIn(patchedNoDesktop, '--dsw-alias-bg-base') > 0 &&
    alphaIn(patchedNoDesktop, '--dsw-alias-bg-base') < 0.08 &&
    alphaIn(patched.css, '--dsw-alias-bg-layer-2') === alphaIn(patchedNoDesktop, '--dsw-alias-bg-layer-2'),
  `back ${alphaIn(patched.css, '--dsw-alias-bg-base')} vs ` +
    `${alphaIn(patchedNoDesktop, '--dsw-alias-bg-base')} when off; layer-2 unchanged — with the ` +
    'desktop shown the base has to reach exactly 0, or the material sits behind a grey film; with ' +
    'it hidden the base is still a thin wash, because a base of 0 over the theme\'s own wallpaper ' +
    'is a different look rather than a clearer one. The band was `> 0.05` when the tier ended at ' +
    '0.08, which was the old value plus slack; the value is 0.03 now and the band follows it.'
);
check(
  'the reveal is published for the engine-level suite',
  /--dsl-reveal:\s*1;/.test(patched.css) && /--dsl-reveal:\s*0;/.test(bootCss),
  'cascade.mjs asserts the composited result; this token is what lets it say WHY when it fails'
);
check(
  'intensity is monotonic across the range',
  alphaIn(cssLow, '--dsw-alias-bg-base') > alphaIn(cssMid, '--dsw-alias-bg-base') &&
    alphaIn(cssMid, '--dsw-alias-bg-base') > alphaIn(cssHigh, '--dsw-alias-bg-base')
);
const blurOf = (css) => Number((css.match(/--dsl-blur: blur\((\d+)px\)/) ?? [])[1] ?? -1);
check(
  'max intensity removes the frost entirely',
  blurOf(cssHigh) === 0 && blurOf(cssMid) > 0 && blurOf(cssLow) > blurOf(cssMid),
  `frost ${blurOf(cssLow)}px -> ${blurOf(cssMid)}px -> ${blurOf(cssHigh)}px. The requirement here ` +
    'changed from "less blur at the top" to "no blur at the top", and it changed because air ' +
    'measured it for us: "强度拉满……更像是高斯模糊效果，我希望拉满后应当是几乎完全透明的". ' +
    'The old curve ran 24px -> 10px, which fixed the inversion (the range once ran 8px -> 34px, ' +
    'i.e. the top hid the backdrop most) without fixing the reading — 10px of blur across the ' +
    'whole app is a Gaussian blur, and it was the loudest thing left between the desktop and the ' +
    'eye. Two further things this pins down that a bare `=== 0` would not: the middle of the ' +
    'slider must still be genuinely frosted, and the curve must stay monotone, so the endpoint ' +
    'cannot be reached by simply deleting the blur everywhere.'
);
// The other half of "nothing is left in front of the desktop", and the half the
// blur check cannot see: with the frost gone the window was still wearing a dark
// film on every surface. At 2.0x the tier endpoints — not the harvested official
// alphas — decide these four numbers, which is why this can assert exact
// ordering where the default-position check above deliberately cannot.
check(
  'depth survives at full glass, and no surface dissolves to nothing',
  (() => {
    const back = alphaIn(cssHigh, '--dsw-alias-bg-base');
    const panel = alphaIn(cssHigh, '--dsw-alias-bg-layer-1');
    const raised = alphaIn(cssHigh, '--dsw-alias-bg-layer-2');
    const menu = alphaIn(cssHigh, '--dsw-menu-surface-fill');
    const vals = [back, panel, raised, menu];
    return vals.every((v) => v !== null && v > 0) && menu > raised && raised > panel && panel > back;
  })(),
  `back ${alphaIn(cssHigh, '--dsw-alias-bg-base')} < panel ${alphaIn(cssHigh, '--dsw-alias-bg-layer-1')} ` +
    `< raised ${alphaIn(cssHigh, '--dsw-alias-bg-layer-2')} < menu ${alphaIn(cssHigh, '--dsw-menu-surface-fill')} ` +
    '— "拉满后几乎完全透明" and "the four depths are still four depths" pull in opposite directions, and ' +
    'this is where the second one is defended. The numbers moved a long way down (the menu endpoint ' +
    'went 0.40 -> 0.16) so the *ordering* is now the only thing keeping the hierarchy legible; if a ' +
    'future retune flattens these four into one value, depth stops reading as depth.'
);
check(
  'the edge lens grows with intensity',
  (() => {
    // `renderWith` disposes each run, so the filter that survives on `body`
    // belongs to the last render at that intensity. Both ends are rebuilt here.
    const low = renderWith({ ...BASE_CFG, intensity: 0.2 });
    const lowScale = Number((low.css.match(/--dsl-lens-scale:\s*(\d+)/) ?? [])[1] ?? -1);
    const highScale = Number((cssHigh.match(/--dsl-lens-scale:\s*(\d+)/) ?? [])[1] ?? -1);
    return lowScale > 0 && highScale > lowScale * 3;
  })(),
  'peak displacement has to rise with the slider or "more glass" is only "more transparent"'
);
check(
  'the ripple lens grows with intensity too',
  (() => {
    const low = renderWith({ ...BASE_CFG, intensity: 0.2, ripple: true });
    const lowScale = Number((low.css.match(/--dsl-drop-scale:\s*(\d+)/) ?? [])[1] ?? -1);
    const highScale = Number((cssHigh.match(/--dsl-drop-scale:\s*(\d+)/) ?? [])[1] ?? -1);
    return lowScale > 0 && highScale > lowScale * 2;
  })(),
  'the ripple used to scale only in SIZE, so a click at intensity 0.2 warped as violently as one at 2.0'
);
const glassLevel = (css) => Number((css.match(/--dsl-glass:\s*([\d.]+)/) ?? [])[1] ?? -1);
check(
  'the glass level is exposed to CSS',
  glassLevel(cssHigh) === 1 && glassLevel(cssMid) > 0.5 && glassLevel(cssLow) < 0.25,
  `${glassLevel(cssLow)} / ${glassLevel(cssMid)} / ${glassLevel(cssHigh)} — deliberately convex, so the ` +
    'middle of the slider is already a real glass shell rather than only half way there'
);

// ---------------------------------------------------------------------------
// The frost axis
//
// Until this round the frost was a function of the transparency slider and
// nothing else, which meant "拉满" could only ever mean "no frost" — a single
// control answering two different questions ("how much gets through" and "how
// sharp is it when it arrives") and therefore answering one of them wrong. These
// assertions are what make the split real rather than a second name for the same
// curve: every one of them fails if the control is wired back to the slider.
// ---------------------------------------------------------------------------
const frostIn = (cfg) => blurOf(renderWith({ ...BASE_CFG, ...cfg }).css);
function frostEventIn(value) {
  storage.set('dsh_liquid_glass_config', JSON.stringify({ ...BASE_CFG, frost: 10 }));
  storage.set('dsh_liquid_glass_material', JSON.stringify('patched'));
  const originalSetTimeout = windowStub.setTimeout;
  windowStub.setTimeout = () => 1; // keep this synchronous probe from saving to the host
  const b = registration.factory(mockRequire);
  const c = makeCtx();
  try {
    b.apply(c);
    const dict = (c.state.dicts ?? {}).zh ?? {};
    const index = c.state.registered.findIndex((d) => d.name === 'dsh.liquid-glass.item');
    if (index === -1) return null;
    const nodes = [];
    walkTree(c.state.components[index]({ t: (key) => dict[key] ?? key }), (node) => nodes.push(node));
    const slider = nodes.find(
      (node) => node?.props?.type === 'range' && node.props['aria-label'] === dict.frostLabel
    );
    if (slider?.props?.onChange === undefined) return null;
    slider.props.onChange({ target: { value: String(value) } });
    return blurOf(styleText());
  } finally {
    for (const dispose of c.state.disposes) dispose();
    windowStub.setTimeout = originalSetTimeout;
  }
}

check(
  'follow mode reproduces the old curve to the pixel',
  frostIn({ intensity: 0.2 }) === 23 && frostIn({ intensity: 1 }) === 16 && frostIn({ intensity: 2 }) === 0,
  `${frostIn({ intensity: 0.2 })} / ${frostIn({ intensity: 1 })} / ${frostIn({ intensity: 2 })}px — the `
    + 'whole reason `frost: null` is a value and not a missing one. If these numbers move, the default '
    + 'look moved with them, and nobody asked for that.'
);
check(
  'an explicit frost holds still while the transparency moves',
  frostIn({ intensity: 0.2, frost: 30 }) === 30 && frostIn({ intensity: 2, frost: 30 }) === 30,
  'this state is the point of the control — a fully open shell that is still frosted. On one axis it '
    + 'was unreachable: the frost was forced to 0 exactly where the surfaces stopped protecting the '
    + 'text, so "transparent" and "readable" could not both be asked for.'
);
check(
  'and it can go the other way as well',
  frostIn({ intensity: 0.2, frost: 0 }) === 0,
  'sharp glass at the opaque end. It is also what proves the override is not secretly a floor: the '
    + 'curve would have given 23px here.'
);
check(
  'follow mode ignores whatever value is in storage',
  frostIn({ intensity: 1, frost: null }) === 16 && frostIn({ intensity: 1, frost: 33 }) === 33,
  'null has to win outright. A `??`-style fallback that treated null as "absent" would let a number '
    + 'stored by an earlier drag leak back in the moment follow was switched on again.'
);
check(
  'the frost is clamped on this side too',
  frostIn({ intensity: 1, frost: 999 }) === 40 && frostIn({ intensity: 1, frost: -12 }) === 0,
  `${frostIn({ intensity: 1, frost: 999 })} / ${frostIn({ intensity: 1, frost: -12 })} — the host clamps `
    + 'as well, and the two are separate implementations by design, so each needs its own proof'
);
const frostEventHigh = frostEventIn(999);
const frostEventLow = frostEventIn(-12);
check(
  'frost slider changes are normalized before the next render',
  frostEventHigh === 40 && frostEventLow === 0,
  `${frostEventHigh} / ${frostEventLow} — user changes and restored settings must pass through ` +
    'the same normalizer before rendering or writing the local cache'
);

// ---------------------------------------------------------------------------
// 每段对话底板
//
// Third implementation of this control, and the first two died of the same
// disease, so these assertions are aimed squarely at it.
//
//   · v1 was `alpha = Math.max(tierAlpha, plate)` on the text-carrying glass
//     tokens — arithmetically the same operation as lowering 效果强度, on the
//     same tiers, along the same axis, and global for the same reason. air's
//     report was "这俩选项效果和降低效果强度基本没区别".
//   · v2 is a background on the conversation rows, and it may not touch a single
//     design token. That is not a stylistic preference, it is the property that
//     makes it a different control instead of a relabelled one — so the first
//     two checks below compare the *whole* token set with the plate on and off
//     and require them to be identical to the byte.
//
// The rest is geometry. A plate needs padding, padding moves things, and the
// theme's standing rule is that glass must not change what it is sitting on, so
// the padding has to be cancelled exactly. "Exactly" is checkable, which is why
// it is checked rather than eyeballed.
// ---------------------------------------------------------------------------
/** The plate rule's own text, or null when it was not emitted at all. */
const PLATE_SELECTOR_TEXT = '[data-chat-flow] > [data-chat-flow-key]';
const plateRule = (css) => {
  const at = css.indexOf(PLATE_SELECTOR_TEXT);
  if (at === -1) return null;
  const open = css.indexOf('{', at);
  const close = css.indexOf('}', open);
  return open === -1 || close === -1 ? null : css.slice(at, close + 1);
};
const plateOn = { ...BASE_CFG, intensity: 2, plate: true, plateLevel: 0.5 };
const plateCss = renderWith(plateOn).css;
const plateToken = (css) => Number((css.match(/--dsl-plate:\s*([\d.]+)/) ?? [])[1] ?? -1);
// Every tier a glyph can land on, plus the two that air named as "全局变白":
// the window base and the sidebar. A floor could not leave these alone; a plate
// on the conversation rows cannot reach them.
const PLATE_UNTOUCHED = [
  '--dsw-alias-bg-base',
  '--dsw-alias-bg-layer-1',
  '--dsw-alias-bg-layer-2',
  '--dsw-alias-bg-layer-3',
  '--dsw-specific-sidebar-fill',
  '--dsw-specific-input-major',
  '--dsw-menu-surface-fill',
  '--dsw-alias-interactive-bg-hover'
];
check(
  'the plate is emitted only when it is switched on',
  plateRule(cssHigh) === null && plateRule(plateCss) !== null,
  'the rule carries padding, so emitting it unconditionally would move the layout of every conversation '
    + 'block while the switch is off — the one thing this theme is not allowed to do'
);
check(
  'and it is one rule per side on the conversation rows and nothing else',
  (() => {
    // 对话辨识 split 每段对话底板 into one rule per speaker. The old version of
    // this assertion demanded exactly ONE occurrence of the row selector earlier
    // in the sheet, which was true while there was one colour; it is now two, and
    // the thing worth asserting is not the count but that every selector which
    // paints a plate is still anchored to the same row contract — so a leak into
    // the token blocks or onto a non-row element would still fail.
    //
    // Scoped to the mode's own block (it opens with the 对话辨识 comment) rather
    // than to the whole sheet: `plateCss` is the entire stylesheet, and scanning
    // its other 15kb for the row selector would pick up unrelated rules.
    const start = plateCss.indexOf('/* 对话辨识 · 双侧');
    if (start === -1) return false;
    const block = plateCss.slice(start, plateCss.indexOf('/* 每段对话', start) === -1
      ? undefined
      : plateCss.indexOf('/* 每段对话', start));
    const selectors = [];
    for (const chunk of block.split('}')) {
      const open = chunk.indexOf('{');
      if (open === -1) continue;
      const sel = chunk.slice(0, open);
      if (sel.includes(PLATE_SELECTOR_TEXT)) selectors.push(sel);
    }
    if (selectors.length !== 3) return false;
    // Every line of every comma-joined list must restate the full row contract —
    // a bare `[data-chat-flow-kind="user"]` on its own line would reach every
    // element in the app carrying that attribute, including the app's own
    // wrappers outside the conversation column.
    //
    // Comment lines are stripped by removing whole `/* … */` spans first: splitting
    // on `}` leaves the previous rule's trailing comment glued to the front of the
    // next selector, and a line-by-line filter cannot catch a comment's *middle*
    // line, which starts with neither `/*` nor `*` but is prose either way.
    //
    // Selector lines are then required to be non-empty and to start with the row
    // contract, so a stray word surviving the strip still fails.
    return selectors.every((sel) => {
      const code = sel.replace(/\/\*[\s\S]*?\*\//g, '');
      const lines = code
        .split('\n')
        .map((l) => l.trim().replace(/,$/, ''))
        .filter((l) => l !== '');
      return lines.length > 0 && lines.every((line) => line.startsWith(PLATE_SELECTOR_TEXT));
    });
  })(),
  'local by construction rather than by tuning. `data-chat-flow` is the conversation column and '
    + '`data-chat-flow-key` is one flow row inside it, both read out of the shipped archive; the child '
    + 'combinator is load-bearing because grouped seats carry the row attribute too and contain further '
    + 'rows, so a descendant selector would paint a plate inside a plate. Both sides carry it, and so does '
    + 'every line of the comma-joined selector list'
);
check(
  'the plate changes no design token at all',
  PLATE_UNTOUCHED.every((name) => alphaIn(cssHigh, name) === alphaIn(plateCss, name)) &&
    !/--dsw-/.test(plateRule(plateCss) ?? ''),
  `${PLATE_UNTOUCHED.map((n) => alphaIn(plateCss, n)).join(' / ')} — identical with the plate on and off. `
    + 'This is the assertion air was actually asking for: the previous version raised these same numbers, '
    + 'which is why the two controls were indistinguishable, and why its own hint could not be honest. '
    + 'A plate that cannot name a token cannot whiten the sidebar or act as a second intensity slider'
);
check(
  'the plate gets its room without moving anything',
  (() => {
    // The geometry moved onto the shared rule when the colour split in two —
    // duplicating padding per hue is how the two sides drift a pixel apart the
    // first time one is retuned. So this reads the padding from wherever it is,
    // which also means it notices if someone moves it back onto a coloured rule
    // with a different number.
    const pad = Number((plateCss.match(/padding-block:\s*(-?[\d.]+)px/) ?? [])[1]);
    const mar = Number((plateCss.match(/margin-block:\s*(-?[\d.]+)px/) ?? [])[1]);
    return Number.isFinite(pad) && Number.isFinite(mar) && pad > 0 && pad + mar === 0;
  })(),
  'padding and an equal negative margin: the border box grows by 6px top and bottom and the margin box '
    + 'does not grow at all, so every glyph stays exactly where the app put it. The app lays the flow '
    + 'rows out as a flex column with a gap, which is what keeps negative margins from collapsing two '
    + 'plates into each other'
);
check(
  'each side reads its own published colour, and both read the one level',
  (() => {
    const human = plateCss.match(
      /\[data-chat-flow-kind="user"\][^{]*\{[^}]*background-color:\s*rgba\(var\((--dsl-plate-human-rgb)\),\s*var\((--dsl-plate)\)\)/
    );
    const model = plateCss.match(
      /\[data-chat-flow-kind="turn-process"\][^{]*\{[^}]*background-color:\s*rgba\(var\((--dsl-plate-model-rgb)\),\s*var\((--dsl-plate)\)\)/
    );
    return human !== null && model !== null;
  })(),
  'a literal rgba() in either rule would be a second copy of the level, free to drift from the number '
    + 'the panel shows. The two RGB tokens are distinct on purpose — one colour for both sides is the '
    + 'bug this feature exists to fix — while the alpha token is deliberately shared, because "how solid '
    + 'is the plate" is one control and must not become two'
);
check(
  'the two sides are actually different colours',
  (() => {
    const human = plateCss.match(/--dsl-plate-human-rgb:\s*([\d, ]+)/);
    const model = plateCss.match(/--dsl-plate-model-rgb:\s*([\d, ]+)/);
    if (human === null || model === null) return false;
    return human[1].trim() !== model[1].trim();
  })(),
  'if these ever resolve to the same triple the feature is silently gone while every other assertion '
    + 'still passes, which is exactly how the single-colour plate shipped in the first place'
);
check(
  'a level of zero is the same thing as switching it off',
  plateRule(renderWith({ ...BASE_CFG, plate: true, plateLevel: 0 }).css) === null &&
    plateRule(cssHigh) === null,
  'the switch and the level have to agree, or one of them is lying. Zero also has to mean "no rule" '
    + 'rather than "an invisible rule", because the rule carries layout'
);
check(
  'the plate is off whenever the glass itself is off',
  plateRule(renderWith({ ...plateOn, surface: false }).css) === null,
  '毛玻璃面板 off means no glass anywhere, and a plate is a piece of glass. Gating on `surface` as well '
    + 'is what keeps that switch a single answer instead of a partial one'
);
check(
  'the plate is published so the suite can tell "off" from "never applied"',
  plateToken(cssHigh) === 0 && plateToken(plateCss) === 0.5,
  `${plateToken(cssHigh)} / ${plateToken(plateCss)} — without it, "switch off" and "the rule silently `
    + 'stopped being emitted" resolve to the same pixels'
);

// ---------------------------------------------------------------------------
// 对话辨识 — the mode that tells the two speakers apart.
//
// Three modes, and the assertions below exist because each one has a way of
// failing that looks exactly like the state it replaces:
//   · `side`  both colours silently resolving to the same triple (the original bug);
//   · `halo`  emitting a plate — the mode is DEFINED by not having one;
//   · `off`   emitting anything at all.
// ---------------------------------------------------------------------------
const haloOn = renderWith({ ...BASE_CFG, intensity: 2, plate: false, plateSide: 'halo' });
const offOn = renderWith({ ...BASE_CFG, intensity: 2, plate: true, plateLevel: 0.5, plateSide: 'off' });
const haloBlocks = (css) => css.split('/* 对话辨识 · 描边').length - 1;

check(
  'the halo mode is reachable with the plate switched off',
  haloBlocks(haloOn.css) === 1 && haloOn.css.includes('text-shadow:'),
  'this is the whole point of the mode: "no plate, and still readable". Tying it to the plate switch '
    + 'would make it unreachable for the one user who wants it, which is the failure mode a gate added '
    + '"for safety" always has'
);
check(
  'and the halo emits no plate at all',
  !haloOn.css.includes('--dsl-plate-human-rgb)') &&
    !haloOn.css.includes('--dsl-plate-model-rgb)') &&
    plateToken(haloOn.css) === 0,
  'the mode is defined by having no plate. A halo over a plate is two contrast devices on one glyph, '
    + 'which reads as a smudge rather than as either effect'
);
check(
  'the halo is two shadows, not one',
  (() => {
    const at = haloOn.css.indexOf('/* 对话辨识 · 描边');
    if (at === -1) return false;
    const rule = haloOn.css.slice(at, haloOn.css.indexOf('}', at));
    // The test is on the SHADOWS' DIRECTIONS, not on the token names. An earlier
    // version of this assertion only asked whether both custom properties
    // appeared somewhere in the rule, and that is satisfied by
    // `0 0 0 0 var(--dsl-halo-light)` just as well — the mutation zeroed the
    // offset, kept the name, and the guard stayed green. A name is not a shape.
    //
    // What has to hold: exactly one shadow has a NEGATIVE vertical offset and it
    // is the light one, and the rest are dark and travel downward or sideways.
    // That is the whole reason the second shadow exists — a rim that only goes
    // down is invisible above the glyph, and the scheme it fails on is the one
    // where the glow is the only thing that works.
    const shadows = (rule.match(/text-shadow:([^;]*);/) || ['', ''])[1]
      .split(/,(?![^(]*\))/)
      .map((part) => part.trim())
      .filter(Boolean);
    if (shadows.length !== 4) return false;
    const light = shadows.filter((s) => s.includes('var(--dsl-halo-light)'));
    const dark = shadows.filter((s) => s.includes('var(--dsl-halo-dark)'));
    if (light.length !== 1 || dark.length !== 3) return false;
    // A shadow is `<x> <y> <blur> <colour>`, and the offsets are unitless pixels
    // when they are zero — `0 1px 1px ...` — so the number pattern has to allow
    // a bare `0` as well as a `1px`.
    const OFF = /^\s*(-?(?:\d+(?:\.\d+)?(?:px)?))\s+(-?(?:\d+(?:\.\d+)?(?:px)?))\s/;
    const offY = (shadow) => {
      const m = shadow.match(OFF);
      return m === null ? null : m[2].replace(/px$/, '');
    };
    // The light one carries the upward offset, so its y is negative.
    const lightY = offY(light[0]);
    if (lightY === null || !lightY.startsWith('-')) return false;
    // And no dark shadow may also point up, or the two would cancel.
    return dark.every((s) => {
      const y = offY(s);
      return y !== null && !y.startsWith('-');
    });
  })(),
  'a dark rim alone fixes the light desktop and does nothing on a dark one, and a light bloom alone is '
    + 'the reverse. One shadow would look correct on the machine it was tuned on and broken on the next '
    + 'person\'s, which is the least debuggable kind of wrong'
);
check(
  'the halo leaves inline code and links alone',
  (() => {
    const at = haloOn.css.indexOf('/* The blurred rim must not bleed');
    if (at === -1) return false;
    const rule = haloOn.css.slice(at, haloOn.css.indexOf('}', at));
    return rule.includes('text-shadow: none') && rule.includes('code') && rule.includes('pre');
  })(),
  'those already carry a background of their own, and a shadow under a filled chip reads as dirt. This '
    + 'is the same reason the plate is a background rather than an outline'
);
check(
  'the halo is scoped to the conversation rows, not to the page',
  (() => {
    const at = haloOn.css.indexOf('/* 对话辨识 · 描边');
    if (at === -1) return false;
    const rule = haloOn.css.slice(at, haloOn.css.indexOf('{', at));
    return rule.includes(PLATE_SELECTOR_TEXT) && !/\bbody\b|\bhtml\b/.test(rule);
  })(),
  'a halo on the sidebar, the toolbar and the settings panel would be a contrast device applied where '
    + 'nobody asked for one, and it would fight the plate geometry on the same rows'
);
check(
  'the off mode emits no distinction at all',
  plateRule(offOn.css) === null && haloBlocks(offOn.css) === 0,
  'this is the escape hatch, and an escape hatch that still emits something is not one'
);
check(
  'the mode is normalized, so an unknown value falls back instead of emitting nothing',
  (() => {
    // A mode string that reaches `buildCss` unrecognised matches neither branch
    // and produces no CSS — a control that reads as enabled and does nothing,
    // which is the exact failure the 透出桌面 row exists to document.
    const bogus = renderWith({ ...BASE_CFG, intensity: 2, plate: true, plateLevel: 0.5, plateSide: 'sideways' });
    return plateRule(bogus.css) !== null;
  })(),
  '`plateSide` is a closed set and `normalizeDocument` has to enforce it. A numeric field that goes bad '
    + 'still renders something; a mode that goes bad renders nothing at all'
);

documentStub.dispatch('pointerdown', { button: 0, buttons: 1, pointerType: 'mouse', clientX: 5, clientY: 5 });
check('ripples stay off when disabled', glints() === 0);

// Whole-theme off
storage.set('dsh_liquid_glass_config', JSON.stringify({ enabled: false }));
const bundle3 = registration.factory(mockRequire);
const ctx3 = makeCtx();
bundle3.apply(ctx3);
check('disabled theme empties the sheet', styleText() === '');
check('disabled theme removes the wallpaper', findById(body, 'dsl-wallpaper') === null);

// ---------------------------------------------------------------------------
// Settings panel
//
// The panel was registered and never rendered by this suite, which is the only
// reason a switch that turns on and changes nothing could pass a green run while
// being the exact thing the user then reported. "为何客户端的完全透明不生效"
// was answered by the config saying `desktop: true` and the stylesheet correctly
// refusing — and the only feedback for that mismatch was an 11px badge.
//
// These assertions are about what the panel SAYS, so they read the real
// dictionary through the captured `locale.register` rather than a key echo.
// ---------------------------------------------------------------------------

/**
 * Depth-first walk over the stub React tree. Strings are visited as well.
 *
 * Function components are EVALUATED rather than skipped. A static walk only
 * sees `h(Toggle, { disabled })` — the props the panel passed in — and never the
 * `<button class="dsl-switch" disabled>` that reaches the DOM. Asserting on the
 * former would be asserting on the input to the thing under test; the panel's
 * first version of these assertions found zero switches for exactly this reason.
 * `React.Fragment` is a Symbol, so it falls through to its children.
 */
function walkTree(node, visit) {
  if (node === null || node === undefined || node === false || node === true) return;
  if (Array.isArray(node)) {
    for (const child of node) walkTree(child, visit);
    return;
  }
  if (typeof node !== 'object') {
    visit(node);
    return;
  }
  if (typeof node.type === 'function') {
    walkTree(node.type({ ...node.props, children: node.children }), visit);
    return;
  }
  visit(node);
  for (const child of node.children ?? []) walkTree(child, visit);
}

/**
 * The panel rendered from a mirrored config, plus what it says.
 *
 * `blur` is the host's window-blur readback, and it is written on every call
 * rather than only when supplied. The panel reads it from the mirror at module
 * scope, so a value left behind by the previous case would be live in the next
 * one — which for a three-state badge is the difference between a test and a
 * coin flip.
 */
function panelFor(cfg, material, lang = 'zh', blur = null) {
  storage.set('dsh_liquid_glass_config', JSON.stringify(cfg));
  storage.set('dsh_liquid_glass_material', JSON.stringify(material));
  storage.set('dsh_liquid_glass_window_blur', JSON.stringify(blur));
  const b = registration.factory(mockRequire);
  const c = makeCtx();
  b.apply(c);
  const index = c.state.registered.findIndex((d) => d.name === 'dsh.liquid-glass.item');
  if (index === -1) return { nodes: [], notices: [], texts: [], dict: {} };
  const dict = (c.state.dicts ?? {})[lang] ?? {};
  const tree = c.state.components[index]({ t: (key) => dict[key] ?? key });
  const nodes = [];
  walkTree(tree, (node) => nodes.push(node));
  const notices = nodes.filter((n) => typeof n === 'object' && n !== null && n.props?.className === 'dsl-notice');
  const texts = notices.map((notice) => {
    const parts = [];
    walkTree(notice, (node) => {
      if (typeof node === 'string') parts.push(node);
    });
    return parts.join(' ');
  });
  for (const dispose of c.state.disposes) dispose();
  return { nodes, notices, texts, dict };
}

const noticeOff = panelFor({ ...BASE_CFG, desktop: false }, 'stock');
check(
  'no patch notice while the switch is off',
  noticeOff.notices.length === 0,
  'the notice answers a question the user has asked by flipping the switch; raising it before that is nagging about a feature nobody requested'
);
check(
  'no patch notice on a patched client',
  panelFor({ ...BASE_CFG, desktop: true }, 'patched').notices.length === 0,
  'when the switch works there is nothing to explain'
);

const noticeStock = panelFor({ ...BASE_CFG, desktop: true }, 'stock');
check(
  'switching it on against an unpatched client raises exactly one notice',
  noticeStock.notices.length === 1,
  'one full-width notice, not a badge plus a tooltip plus a paragraph'
);
check(
  'the notice names both the cause and the remedy',
  noticeStock.texts.length === 1 &&
    noticeStock.texts[0].includes('app.asar') &&
    noticeStock.texts[0].includes('--apply-staged'),
  'a notice that only says "not patched" moves the problem rather than solving it. Carrying the file it is about and the exact command that fixes it is the whole point of it existing'
);
check(
  'the undetectable case gets its own wording',
  (() => {
    const unknown = panelFor({ ...BASE_CFG, desktop: true }, 'unknown');
    return unknown.texts.length === 1 && unknown.texts[0] !== noticeStock.texts[0] && unknown.texts[0].includes('app.asar');
  })(),
  '"definitely not patched" and "could not be checked" are different facts needing different sentences: the first says what to run, the second says why nothing was opened'
);
check(
  'the switch stays operable while unpatched',
  (() => {
    const toggles = noticeStock.nodes.filter(
      (n) => typeof n === 'object' && n !== null && n.props?.className === 'dsl-switch' &&
        n.props['aria-label'] === noticeStock.dict.desktopLabel
    );
    return toggles.length === 1 && toggles[0].props.disabled !== true && toggles[0].props['aria-checked'] === 'true';
  })(),
  'refusing the click would read as a second, different malfunction — and the preference has to survive until the patch is applied, since that is when it starts working'
);
check(
  'every slider is a real slider with its own label and range',
  (() => {
    const p = panelFor({ ...BASE_CFG, ripple: true }, 'patched');
    const sliders = p.nodes.filter(
      (n) => typeof n === 'object' && n !== null && n.props?.type === 'range'
    );
    const labelled = sliders.map((n) => n.props['aria-label']);
    const D = p.dict;
    // The count was 2 until the frost and the plate each split off a control of
    // their own. It moving up is the point of the change rather than an
    // incidental side effect to be absorbed by loosening the assertion: four
    // sliders now share one class, sit within four rows of each other, and two
    // of them are multipliers — so an unlabelled one here is how the wrong
    // control gets written to by a screen reader or a test.
    //
    // It stays 4 for 窗口模糊, and that is a fact about the control rather than
    // about this assertion: a blur radius the compositor owns has nothing to
    // slide. The row is asserted by the toggle checks further down instead.
    return (
      sliders.length === 4 &&
      labelled.includes(D.intensityLabel) &&
      labelled.includes(D.rippleSizeLabel) &&
      labelled.includes(D.frostLabel) &&
      labelled.includes(D.plateLevelLabel) &&
      // A key echo means the dictionary is missing the entry, which renders the
      // literal key at the user. The stub's `t` falls back to the key itself, so
      // "not undefined" is not enough — it has to differ from the key.
      D.rippleSizeLabel !== 'rippleSizeLabel' &&
      D.rippleSizeHint !== 'rippleSizeHint' &&
      D.frostLabel !== 'frostLabel' &&
      D.frostHint !== 'frostHint' &&
      D.frostFollowLabel !== 'frostFollowLabel' &&
      D.frostFollowHint !== 'frostFollowHint' &&
      D.plateLabel !== 'plateLabel' &&
      D.plateHint !== 'plateHint' &&
      D.plateLevelLabel !== 'plateLevelLabel' &&
      D.plateLevelHint !== 'plateLevelHint' &&
      // The window-blur row is the one control here with no slider, but its
      // badge has five distinct wordings and every one of them is reachable —
      // so the dictionary is checked with the same strictness as the sliders'.
      D.windowBlurLabel !== 'windowBlurLabel' &&
      D.windowBlurHint !== 'windowBlurHint' &&
      D.windowBlurIdle !== 'windowBlurIdle' &&
      D.windowBlurOn !== 'windowBlurOn' &&
      D.windowBlurOff !== 'windowBlurOff' &&
      D.windowBlurNeedsDesktop !== 'windowBlurNeedsDesktop' &&
      D.windowBlurNoticeTitle !== 'windowBlurNoticeTitle' &&
      D.windowBlurNoticeBody !== 'windowBlurNoticeBody' &&
      D.windowBlurNoticeWhyLabel !== 'windowBlurNoticeWhyLabel' &&
      // Ranges, because nothing else tells the four apart.
      sliders.some((n) => n.props.min === '0.5' && n.props.max === '2') &&
      sliders.some((n) => n.props.min === '0' && n.props.max === '40') &&
      // The plate's maximum is asserted here too, because it is the number air
      // reported as too low: 0.6 read as "still a wash" at the top of the
      // slider. A ceiling that the slider cannot reach is not a ceiling.
      sliders.some((n) => n.props.min === '0' && n.props.max === '0.85')
    );
  })(),
  'a control that renders but announces nothing is a control a screen reader cannot use — and ' +
    'four sliders with the same class and no distinct label is how the wrong one gets written to'
);

/** The `.dsl-row` whose title is `title`, or null. */
function rowByTitle(p, title) {
  return p.nodes.find(
    (n) => n?.props?.className === 'dsl-row' && textsOf(n).includes(title)
  ) ?? null;
}

/** Every string a subtree renders, in order. */
function textsOf(node) {
  const out = [];
  walkTree(node, (n) => {
    if (typeof n === 'string') out.push(n);
  });
  return out;
}

/**
 * The rendered text of a row's value slot.
 *
 * Deliberately reached by walking the row rather than by grabbing the first
 * `.dsl-value` in the tree: the assertions below are about which number the row
 * shows next to which label, and a test that took the value span out of
 * document order could not tell two rows apart.
 */
function valueTextOf(p, title) {
  const row = rowByTitle(p, title);
  if (row === null) return null;
  const slots = [];
  walkTree(row, (n) => {
    if (typeof n === 'object' && n !== null && n?.props?.className === 'dsl-value') slots.push(n);
  });
  if (slots.length !== 1) return null;
  return textsOf(slots[0]).join('');
}

check(
  'the frost row generates its number and marks it as automatic',
  (() => {
    const auto = (intensity) => {
      const p = panelFor({ ...BASE_CFG, intensity, frost: null }, 'patched');
      return valueTextOf(p, p.dict.frostLabel);
    };
    const p = panelFor({ ...BASE_CFG, intensity: 1, frost: null }, 'patched');
    return auto(1) === `16px ${p.dict.frostAuto}` && auto(2) === `0px ${p.dict.frostAuto}`;
  })(),
  'follow mode stores `null`, so a row that printed the stored value would print "nullpx" — the number '
    + 'has to be produced, not read. The marker is a separate job: at 2.0x the honest reading is 0px, '
    + 'which is also exactly what a slider that had snapped to its minimum would show, so the 自动 label '
    + 'is the only thing telling those two apart.'
);
check(
  'and it agrees with the stylesheet, at the same slider position',
  (() => {
    const p = panelFor({ ...BASE_CFG, intensity: 0.2, frost: null }, 'patched');
    const text = valueTextOf(p, p.dict.frostLabel) ?? '';
    const shown = Number((text.match(/^(\d+)px/) ?? [])[1] ?? -1);
    // Non-zero on purpose: at the top of the slider both sides are 0 and the
    // comparison would pass without comparing anything.
    return shown === frostIn({ intensity: 0.2, frost: null }) && shown > 0;
  })(),
  'the panel and the window are two renderings of one decision, and this is the only place they are '
    + 'ever held against each other'
);
check(
  'the slider becomes editable the moment follow is switched off',
  (() => {
    const following = panelFor({ ...BASE_CFG, intensity: 1, frost: null }, 'patched');
    const pinned = panelFor({ ...BASE_CFG, intensity: 1, frost: 8 }, 'patched');
    const sliderOf = (p) => p.nodes.find(
      (n) => n?.props?.type === 'range' && n.props['aria-label'] === p.dict.frostLabel
    );
    const a = sliderOf(following);
    const b = sliderOf(pinned);
    return a !== undefined && b !== undefined &&
      a.props.disabled === true && !b.props.disabled &&
      valueTextOf(pinned, pinned.dict.frostLabel) === '8px';
  })(),
  'while following, the slider is disabled but still *shows* the auto number — the thumb riding the '
    + 'intensity slider is the clearest possible statement of what 跟随强度 means. Once pinned the 自动 '
    + 'marker has to go with it, or the row claims two contradictory things at once.'
);
check(
  'the follow switch reflects `frost: null` rather than a second boolean',
  (() => {
    const switchOf = (p) => p.nodes.find(
      (n) => n?.props?.className === 'dsl-switch' && n.props['aria-label'] === p.dict.frostFollowLabel
    );
    const following = switchOf(panelFor({ ...BASE_CFG, frost: null }, 'patched'));
    const pinned = switchOf(panelFor({ ...BASE_CFG, frost: 0 }, 'patched'));
    return following?.props['aria-checked'] === 'true' && pinned?.props['aria-checked'] === 'false';
  })(),
  'one source of truth. A separate boolean alongside `frost` would be two fields describing one fact, '
    + 'and they would disagree the first time one of them was written without the other — `frost: 0` at '
    + 'intensity 2 looks exactly like follow mode on screen, and is a different promise'
);
check(
  'the hint does not repeat the badge',
  (() => {
    const dict = panelFor({ ...BASE_CFG, desktop: true }, 'stock').dict;
    if (dict.desktopHint === undefined) return false;
    return !dict.desktopHint.includes(dict.patchMissing) &&
      !dict.desktopHint.includes(dict.patchUnknown) &&
      !dict.desktopHint.includes(dict.patchReady);
  })(),
  'one fact, one place: the hint states what the control does, the badge states whether it is working, the notice explains the mismatch. The first version said "not patched" in all three, which grew the row to three lines with the badge stranded in the middle of a paragraph — visible only in tools/panellab.mjs'
);
check(
  'the notice is painted in a literal warning colour',
  (() => {
    const css = findById(head, 'dsl-section-style')?.textContent ?? '';
    const body = (selector) => {
      const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return (new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(css) ?? [])[1] ?? '';
    };
    const notice = body('.dsl-notice');
    const mark = body('.dsl-notice-mark');
    // A literal, not a token: it has to read as a warning under all four tints
    // and both schemes, and it must not be reachable from the tint variables or
    // a notice could be mistaken for a selected preset.
    return notice.includes('rgba(245, 158, 11') && mark.includes('#f59e0b') && !/--dsl-tint/.test(notice + mark);
  })(),
  'a notice styled from the palette is a notice that can vanish when a token is missing, which is precisely the failure mode it exists to prevent'
);

// ---------------------------------------------------------------------------
// 窗口模糊 — the row whose effect is decided outside this process
// ---------------------------------------------------------------------------
//
// This is the only control in the panel whose truth is a *readback* from the
// main process, so the interesting assertions are not "does a switch exist" but
// "does the badge say the right thing in all five states, and does the notice
// appear in exactly the one state the badge cannot explain". A badge that
// collapsed any two of those would send a user to fix the wrong thing: unknown
// vs stock is "we could not check" vs "we checked and it is not patched", and
// ready-but-inert vs not-ready are two different repairs.

/** The 窗口模糊 row's badge text, or null when the row is missing. */
function blurBadgeOf(p) {
  const row = rowByTitle(p, p.dict.windowBlurLabel);
  if (row === null) return null;
  const slot = [];
  walkTree(row, (n) => {
    if (typeof n === 'object' && n !== null && n?.props?.className === 'dsl-status') slot.push(n);
  });
  if (slot.length !== 1) return null;
  return textsOf(slot[0]).join('');
}

/** The 窗口模糊 row's switch, or undefined. */
function blurSwitchOf(p) {
  return p.nodes.find(
    (n) => n?.props?.className === 'dsl-switch' && n.props['aria-label'] === p.dict.windowBlurLabel
  );
}

check(
  'the 窗口模糊 row is a switch, not a slider',
  (() => {
    const p = panelFor({ ...BASE_CFG, desktop: true }, 'patched');
    const sw = blurSwitchOf(p);
    const slidersInRow = (() => {
      const row = rowByTitle(p, p.dict.windowBlurLabel);
      if (row === null) return -1;
      let n = 0;
      walkTree(row, (node) => {
        if (typeof node === 'object' && node !== null && node?.props?.type === 'range') n += 1;
      });
      return n;
    })();
    return sw !== undefined && slidersInRow === 0;
  })(),
  'a blur radius the compositor owns has nothing to slide — the whole effect is one of two materials, ' +
    'and offering a 0-40px slider here would be offering a number that gets rounded to those two values'
);

check(
  'the badge names all six states, and no two of them the same way',
  (() => {
    const off = panelFor({ ...BASE_CFG, windowBlur: false, desktop: true }, 'patched');
    const on = panelFor({ ...BASE_CFG, windowBlur: true, desktop: true }, 'patched', 'zh', { active: true, why: null, material: 'acrylic' });
    const inert = panelFor({ ...BASE_CFG, windowBlur: true, desktop: true }, 'patched', 'zh', { active: false, why: 'no-window', material: null });
    const noDesktop = panelFor({ ...BASE_CFG, windowBlur: true, desktop: false }, 'patched');
    const stock = panelFor({ ...BASE_CFG, windowBlur: true, desktop: true }, 'stock');
    // The sixth state, and the reason this test was renamed from "five": a
    // build with no readback applied the request but cannot prove it, which is
    // neither 已生效 nor 未生效. It was folded into `windowBlurOff` before —
    // the badge said "did not take" about a window that did take it.
    const unverifiable = panelFor({ ...BASE_CFG, windowBlur: true, desktop: true }, 'patched', 'zh', { active: false, why: 'no-getter', applied: true, material: null });
    const seen = [off, on, inert, noDesktop, stock, unverifiable].map(blurBadgeOf);
    if (seen.some((s) => s === null)) return false;
    const D = off.dict;
    return (
      seen[0] === D.windowBlurIdle &&
      seen[1] === D.windowBlurOn &&
      seen[2] === D.windowBlurOff &&
      seen[3] === D.windowBlurNeedsDesktop &&
      seen[4] === D.patchMissing &&
      seen[5] === D.windowBlurUnverified &&
      new Set(seen).size === 6
    );
  })(),
  'on-but-inert and off are both "not blurred on screen", and they need opposite sentences: one is a ' +
    'failure to report, the other is a preference. Folding them is how the row becomes a switch that is ' +
    'on and says nothing. And "requested, unverifiable" is a third thing again: the request went through, ' +
    'the readback does not exist, and calling that 未生效 is the panel reporting a failure it cannot see'
);

check(
  'the badge reports the readback rather than the stored preference',
  (() => {
    // Same stored config, opposite reports: only the host's answer may move the
    // badge. A badge computed from `config.windowBlur` would pass a naive
    // "is it on" test and be wrong in exactly the case this row exists for.
    const yes = panelFor({ ...BASE_CFG, windowBlur: true, desktop: true }, 'patched', 'zh', { active: true, why: null, material: 'acrylic' });
    const no = panelFor({ ...BASE_CFG, windowBlur: true, desktop: true }, 'patched', 'zh', { active: false, why: 'set-failed', material: null });
    return blurBadgeOf(yes) !== blurBadgeOf(no);
  })(),
  'the switch is a request; the badge is a result. An echo of the request is a control that always claims ' +
    'success, which is the failure the whole host round trip exists to avoid'
);

check(
  'no-getter reads as requested-but-unproven, which is not the same as failed',
  (() => {
    // `applied: true, verified: false` is the honest description of this build.
    // The panel must not flatten it into either neighbour: 已生效 would claim a
    // readback that does not exist, and 未生效 would deny a call that really
    // reached the compositor. The two reports differ by one field (`applied`),
    // so a badge keyed on `why` alone would pass this and keying on `active`
    // would also pass it — the assertion needs both halves.
    const unproven = panelFor({ ...BASE_CFG, windowBlur: true, desktop: true }, 'patched', 'zh', { active: false, applied: true, verified: false, why: 'no-getter', material: null });
    const failed = panelFor({ ...BASE_CFG, windowBlur: true, desktop: true }, 'patched', 'zh', { active: false, applied: false, verified: false, why: 'set-failed', material: null });
    const live = panelFor({ ...BASE_CFG, windowBlur: true, desktop: true }, 'patched', 'zh', { active: true, applied: true, verified: true, why: null, material: 'acrylic' });
    const D = unproven.dict;
    const badge = blurBadgeOf(unproven);
    if (badge === null) return false;
    return (
      badge === D.windowBlurUnverified &&
      badge !== blurBadgeOf(failed) &&
      badge !== blurBadgeOf(live)
    );
  })(),
  'a build with no getter applied the request and cannot prove it. That is a third outcome, not a ' +
    'softer version of failure: the compositor was asked, and the panel has no way to say whether it ' +
    'listened. Reporting 未生效 here sends the user hunting for a bug in a call that did reach the window'
);

check(
  'and that third state raises no alarm, because a permanent property of the build is not a fault',
  (() => {
    // This check used to assert the opposite — that `no-getter` prints its own
    // notice under the badge, explaining the missing getter rather than
    // offering the patch command. The intent was right and the outcome was a
    // permanent yellow warning over a working feature: this build NEVER has a
    // getter, so the condition is true on every frame, and air ended up looking
    // at an alarm he could do nothing about. A warning that cannot be cleared
    // is indistinguishable from a decoration, and it trains the reader to
    // ignore the warnings that do matter.
    //
    // So the assertion is inverted: the unverifiable state must NOT produce a
    // notice, while a genuine failure still must. Both halves are needed — the
    // first alone would also pass if the whole notice block were deleted.
    const unproven = panelFor({ ...BASE_CFG, windowBlur: true, desktop: true }, 'patched', 'zh', { active: false, applied: true, verified: false, why: 'no-getter', material: null });
    const failed = panelFor({ ...BASE_CFG, windowBlur: true, desktop: true }, 'patched', 'zh', { active: false, applied: false, verified: false, why: 'set-failed', material: null });
    const D = unproven.dict;
    return (
      !unproven.texts.some((s) => s.includes(D.windowBlurUnverifiedTitle)) &&
      !unproven.texts.some((s) => s.includes(D.windowBlurNoticeTitle)) &&
      failed.texts.some((s) => s.includes(D.windowBlurNoticeTitle)) &&
      // and the fact is not deleted, only moved: the badge still carries it.
      blurBadgeOf(unproven) === D.windowBlurUnverified
    );
  })(),
  'measuring "cannot read it back" on a build that never can read it back is not an alarm, it is a ' +
    'description. The badge keeps the fact; the notice is kept for the case where something actually ' +
    'failed and the user can act on it'
);

check(
  'the unpatched badge outranks the Show-the-desktop badge',
  (() => {
    // Both reasons are true at once here, and only one of them is actionable:
    // telling a user on a stock client to switch 透出桌面 on would send them to
    // flip a switch that still would not help.
    const both = panelFor({ ...BASE_CFG, windowBlur: true, desktop: false }, 'stock');
    return blurBadgeOf(both) === both.dict.patchMissing &&
      blurBadgeOf(both) !== both.dict.windowBlurNeedsDesktop;
  })(),
  'two blockers, one sentence, and it has to be the one that actually unblocks'
);

check(
  'the notice appears in exactly the one state the badge cannot explain',
  (() => {
    const inert = panelFor({ ...BASE_CFG, windowBlur: true, desktop: true }, 'patched', 'zh', { active: false, why: 'no-window', material: null });
    const ok = panelFor({ ...BASE_CFG, windowBlur: true, desktop: true }, 'patched', 'zh', { active: true, why: null, material: 'acrylic' });
    const off = panelFor({ ...BASE_CFG, windowBlur: false, desktop: true }, 'patched');
    const stock = panelFor({ ...BASE_CFG, windowBlur: true, desktop: true }, 'stock');
    const noDesktop = panelFor({ ...BASE_CFG, windowBlur: true, desktop: false }, 'patched');
    // Counted by their own wording rather than by notice count: 透出桌面 raises
    // one of its own on the stock case, and a total is what the earlier checks
    // already assert.
    const hasBlurNotice = (p) => p.texts.some((x) => x.includes(p.dict.windowBlurNoticeTitle));
    return (
      hasBlurNotice(inert) &&
      !hasBlurNotice(ok) &&
      !hasBlurNotice(off) &&
      !hasBlurNotice(stock) &&
      !hasBlurNotice(noDesktop)
    );
  })(),
  'the other four states are already named by the badge, and re-explaining them below would be the same ' +
    'fact printed twice — the exact mistake the 透出桌面 row grew to three lines for'
);

check(
  'and that notice carries the host\'s own reason code',
  (() => {
    const p = panelFor({ ...BASE_CFG, windowBlur: true, desktop: true }, 'patched', 'zh', { active: false, why: 'material-not-applied', material: 'none' });
    const notice = p.texts.find((x) => x.includes(p.dict.windowBlurNoticeTitle)) ?? '';
    return notice.includes('material-not-applied') && notice.includes(p.dict.windowBlurNoticeWhyLabel);
  })(),
  'the badge says "it did not take", which is not a lead. The code is what turns the sentence into ' +
    'something that can be reported or googled, and it is the only place the host\'s own words survive'
);

check(
  'the badge reports the first thing in the way, not the last',
  (() => {
    // Three blockers can be true at once and only the first is worth a
    // sentence, because it is the one that has to be cleared first.
    const D = panelFor({ ...BASE_CFG }, 'patched').dict;
    const worst = panelFor({ ...BASE_CFG, windowBlur: true, desktop: false }, 'stock');
    const mid = panelFor({ ...BASE_CFG, windowBlur: false, desktop: false }, 'patched');
    const least = panelFor({ ...BASE_CFG, windowBlur: false, desktop: true }, 'patched');
    return (
      blurBadgeOf(worst) === D.patchMissing &&
      blurBadgeOf(mid) === D.windowBlurNeedsDesktop &&
      blurBadgeOf(least) === D.windowBlurIdle
    );
  })(),
  'a dormant control still has to name its precondition: "off, and it would do nothing anyway" is more ' +
    'useful than "off". Ordered the other way round, the prerequisite only appears after the switch has ' +
    'been flipped and failed — which is the moment the user is least able to tell it apart from a bug'
);

// ---------------------------------------------------------------------------
// Hydration — the one round trip with no other witness
// ---------------------------------------------------------------------------
//
// The renderer stores the preference and the host owns the effect, so a saved
// 窗口模糊 survives only if the response can be read back into the config. The
// response is `{ ...config, ...report }`, which makes the key names load-bearing:
// filed under the config's own key, a report *object* overwrites the boolean it
// is reporting on — and `coerceBooleans` skips anything that is not a boolean
// rather than complaining, so the key would silently fall back to `false` at
// every launch. The switch would work all session and forget itself at every
// restart, with nothing anywhere reporting an error.
//
// The mirror cannot catch this: `panelFor` seeds localStorage directly and never
// runs the response through `normalizeFromHost`. So this drives the real path —
// a real response body, the real `loadFromHost`, the real panel — which is the
// only way the shape of that body is ever held to account.

/**
 * Boot a fresh instance against a host response body and read the panel back.
 *
 * The body is released on demand rather than through a plain resolved promise:
 * a stale instance's pending `loadFromHost` would otherwise re-apply the theme
 * mid-test and leave a style tag behind that nothing removes, which the teardown
 * assertions at the bottom would then read as a leak.
 *
 * @param {object} payload the GET body
 * @returns {Promise<{ switchOn: boolean, badge: string|null, noticeTexts: string[], dict: object }>}
 */
async function hydrateWith(payload) {
  let release = null;
  const realFetch = sandbox.fetch;
  sandbox.fetch = () => new Promise((resolve) => {
    release = () => resolve({ ok: true, status: 200, json: async () => payload });
  });
  storage.clear();
  const b = registration.factory(mockRequire);
  const c = makeCtx();
  // `loadFromHost()` is called synchronously by `apply()` and reaches `fetch`
  // before its first `await`, so the stub is already holding the resolver by the
  // time `apply` returns.
  b.apply(c);
  release?.();
  // Three macrotask boundaries: the fetch promise, `response.json()`, and the
  // body of `loadFromHost` itself. Reading the panel before the last one would
  // be reading the pre-hydration state and calling it a pass.
  for (let i = 0; i < 3; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  const out = (() => {
    const dict = (c.state.dicts ?? {}).zh ?? {};
    const index = c.state.registered.findIndex((d) => d.name === 'dsh.liquid-glass.item');
    if (index === -1) return { switchOn: false, badge: null, dict };
    const nodes = [];
    walkTree(c.state.components[index]({ t: (key) => dict[key] ?? key }), (node) => nodes.push(node));
    const sw = nodes.find(
      (n) => n?.props?.className === 'dsl-switch' && n.props['aria-label'] === dict.windowBlurLabel
    );
    // The badge is reached through the row rather than by label alone, for the
    // same reason `blurBadgeOf` does it: the panel has more than one switch.
    const row = nodes.find(
      (n) => n?.props?.className === 'dsl-row' && textsOf(n).includes(dict.windowBlurLabel)
    );
    const slot = [];
    walkTree(row, (n) => {
      if (typeof n === 'object' && n !== null && n?.props?.className === 'dsl-status') slot.push(n);
    });
    const notices = nodes.filter(
      (n) => typeof n === 'object' && n !== null && n.props?.className === 'dsl-notice'
    );
    return {
      switchOn: sw?.props['aria-checked'] === 'true',
      badge: slot.length === 1 ? textsOf(slot[0]).join('') : null,
      noticeTexts: notices.map((notice) => textsOf(notice).join(' ')),
      dict
    };
  })();
  for (const dispose of c.state.disposes) dispose();
  sandbox.fetch = realFetch;
  return out;
}

const RESTART_BODY = {
  enabled: true,
  surface: true,
  cursor: false,
  desktop: true,
  ripple: false,
  intensity: 1,
  tint: 'slate',
  plate: false,
  plateLevel: 0.5,
  // What the JSON file holds. The whole point of the round trip.
  windowBlur: true,
  // What the host is saying about it right now. Different fact, different name.
  material: 'patched',
  materialWhy: 'marker-found',
  materialPath: null,
  materialTried: [],
  materialScanError: null,
  materialHost: null,
  windowBlurReport: { active: true, why: null, material: 'acrylic' }
};

const hydratedOn = await hydrateWith(RESTART_BODY);
check(
  'a saved window blur survives the launch after it was set',
  hydratedOn.switchOn === true,
  'the config key and the report key have to be two names. Sharing one is not a crash — it is a switch ' +
    'that works until you restart, which reads as the setting not being saved at all'
);
check(
  'and the panel knows it took, without waiting for a second round trip',
  hydratedOn.badge === hydratedOn.dict.windowBlurOn,
  `${hydratedOn.badge} — the report rides on the same response as the config, so a badge that needed ` +
    'its own request would show the switch on and "not applied" at the same time for one frame'
);

// The symmetric half. A report is a fact about the window, not a setting, so an
// active report must not be able to switch the preference on by itself — the
// other direction of the same collision.
const hydratedOff = await hydrateWith({
  ...RESTART_BODY,
  windowBlur: false,
  windowBlurReport: { active: true, why: null, material: 'acrylic' }
});
check(
  'a report cannot switch the setting on by itself',
  hydratedOff.switchOn === false && hydratedOff.badge === hydratedOff.dict.windowBlurIdle,
  `${hydratedOff.badge} — the host applies what the config says, so a renderer that let the report drive ` +
    'the badge as well as the toggle would show 已生效 above a switch that is off. That is the report ' +
    'reading as a setting, which is the same collision from the other side'
);

const diagnosisPath = 'C:\\test-install\\resources\\app.asar';
const hydratedDiagnosis = await hydrateWith({
  ...RESTART_BODY,
  desktop: true,
  material: 'unknown',
  materialWhy: 'scan-failed',
  materialPath: diagnosisPath,
  materialScanError: [{ via: 'noAsar', code: 'EACCES', syscall: 'open' }]
});
const diagnosisText = hydratedDiagnosis.noticeTexts.find(
  (text) => text.includes(hydratedDiagnosis.dict.patchNoticeTitle)
) ?? '';
check(
  'scan diagnosis, archive path and reader error reach the settings notice',
  diagnosisText.includes('scan-failed') &&
    diagnosisText.includes(diagnosisPath) &&
    diagnosisText.includes('noAsar=EACCES(open)'),
  diagnosisText || '(no diagnosis notice)'
);

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

console.log('teardown');
for (const dispose of ctx3.state.disposes) dispose();
for (const dispose of ctx2.state.disposes) dispose();
check('ripple root gone', findById(body, 'dsl-ripple-root') === null);
check('pointerdown listener gone', (documentStub._el.listeners.get('pointerdown') ?? []).length === 0);
check('theme sheet gone', findById(head, 'dsl-theme-style') === null);
check('wallpaper gone', findById(body, 'dsl-wallpaper') === null);

// ---------------------------------------------------------------------------
// Host half
// ---------------------------------------------------------------------------

console.log('host half (index.js)');

// index.js resolves its store directory at module scope, so DSH_HOME has to be
// redirected *before* the import. Without this the test would write a real
// config into the user's ~/.dsh/plugins directory.
const sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsl-verify-'));
process.env.DSH_HOME = sandboxHome;

const host = await import(pathToFileURL(HOST).href);
check('store redirected to a sandbox', host.CONFIG_FILE.startsWith(sandboxHome), host.CONFIG_FILE);
check('exports plugin name', host.name === 'air-pixel-liquid-glass', host.name);
check('injects webServer', JSON.stringify(host.inject) === '["webServer"]');

// The two halves name the marker independently — the patch tool writes it into
// main.js, this half scans for it — so a rename applied to one and not the
// other reports `stock` against an archive that is patched, and the switch
// silently refuses to work. Nothing else in this file can catch that: every
// fake archive here is built from `host.PATCH_MARKER`, which makes the scan
// self-consistent by construction. So compare against the tool's own source.
check('host accepts every marker prefix the patch tool writes', (() => {
  const toolText = fs.readFileSync(path.join(HERE, 'asarpatch.py'), 'utf8');
  const current = toolText.match(/^MARKER_PREFIX = "([^"]+)"/m)?.[1];
  const legacyBlock = toolText.match(/^LEGACY_MARKER_PREFIXES = \(([^)]*)\)/m)?.[1] ?? '';
  const legacy = [...legacyBlock.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  // A pattern that stops matching would leave `missing` empty and pass this
  // check without comparing anything — the failure mode a consistency test is
  // most likely to die of, so the parse has to succeed on its own terms first.
  if (typeof current !== 'string' || current === '') return false;
  const accepted = host.PATCH_MARKERS ?? [host.PATCH_MARKER];
  const missing = [current, ...legacy].filter((p) => !accepted.includes(p));
  return missing.length === 0 && accepted.length >= 1 + legacy.length;
})());

let route = null;
// Captured rather than discarded: the log is where this diagnosis is actually
// read on the machine that has the problem, so it gets asserted further down.
const hostLogs = [];
host.apply({
  webServer: { register: (r) => { route = r; } },
  logger: { info: (message) => hostLogs.push(String(message)) }
});
check('route registered', route?.path === '/api/theme-liquid-glass/config', route?.path);
check('route is an exact match', route?.kind === 'exact');
check('handler is a function', typeof route?.handler === 'function');

function drive(method, payload, target = route) {
  const headers = {};
  let body = '';
  return new Promise((resolve) => {
    const res = {
      statusCode: 0,
      setHeader: (k, v) => { headers[k] = v; },
      end: (chunk) => resolve({ statusCode: res.statusCode, headers, body: chunk ?? '' })
    };
    const req = {
      method,
      on(event, fn) {
        if (event === 'data' && payload !== undefined) fn(JSON.stringify(payload));
        if (event === 'end') fn();
        if (event === 'error') { /* not exercised */ }
      },
      destroy() {}
    };
    void target.handler(req, res);
    body = '';
  });
}

const get1 = await drive('GET');
check('GET returns 200', get1.statusCode === 200, String(get1.statusCode));
check('GET sends no-store', get1.headers['Cache-Control'] === 'no-store');
const cfg = JSON.parse(get1.body);
check('defaults: enabled', cfg.enabled === true);
check('defaults: tint ice', cfg.tint === 'ice');
check('defaults: intensity 1', cfg.intensity === 1);
check(
  'defaults: frost follows, the plate is off and window blur is off',
  cfg.frost === null && cfg.plate === false && cfg.plateLevel === 0.5 && cfg.windowBlur === false,
  'all three new controls have to arrive inert. The frost follows the curve it always did, the plate — ' +
    'the one control whose whole job is to take transparency away — is not allowed to switch itself on ' +
    'and silently undo "拉满后几乎完全透明", and window blur is the only key here that reaches outside ' +
    'the window entirely, so it must not be the thing a first launch does without being asked'
);

const post = await drive('POST', { intensity: 99, rippleSize: 99, tint: 'nope', bogus: 1 });
check('POST returns 200', post.statusCode === 200, String(post.statusCode));
const saved = JSON.parse(post.body);
check('intensity clamped to 2', saved.intensity === 2, String(saved.intensity));
check('rippleSize clamped to 2', saved.rippleSize === 2, String(saved.rippleSize));
// Both directions, and through the host's own clamp rather than the renderer's.
const postLow = await drive('POST', { rippleSize: 0.05 });
check(
  'rippleSize clamped up to 0.5',
  JSON.parse(postLow.body).rippleSize === 0.5,
  JSON.parse(postLow.body).rippleSize + ' — the host normalizes independently of the renderer, so a ' +
    'clamp that only exists on one side is a value that flickers on launch'
);

// The host is the durable copy, and these three keys are the ones where "what
// does a missing value mean" is a real question. `frost: null` IS a value
// (follow the curve) rather than an absence, so every branch below has to keep
// that distinction intact — a host that folded null into 0 would silently pin
// the frost for good the first time the user restarted.
const frostAfter = async (body) => JSON.parse((await drive('POST', body)).body).frost;
check(
  'frost clamped to 40 and rounded to whole pixels',
  (await frostAfter({ frost: 99.6 })) === 40,
  'same shape as the two clamps above: the renderer rounds to integers too, and a fractional value ' +
    'stored here would be re-rounded there — the panel would show one number and the window another'
);
check('frost clamped up to 0', (await frostAfter({ frost: -3 })) === 0);
check(
  'frost: null survives the round trip as null',
  (await frostAfter({ frost: null })) === null,
  '`null` means "follow the curve". If the host normalized it to 0, follow mode would be permanently ' +
    'un-restorable — every restart would pin the frost and the slider would stop tracking the intensity ' +
    'that the row still claims it follows'
);
check(
  'a junk frost falls back to follow rather than to a number',
  (await frostAfter({ frost: 'lots' })) === null,
  'the fail-safe direction is the one that reproduces the shipped look, not the one that freezes the ' +
    'window at whatever the last drag happened to be'
);
const plateAfter = async (body) => JSON.parse((await drive('POST', body)).body);
check(
  'plateLevel clamped to 0.85',
  (await plateAfter({ plate: true, plateLevel: 2 })).plateLevel === 0.85,
  'the ceiling is what air asked for after 0.6: at the top the plate is meant to read as a panel, not ' +
    'as a wash. 4.5:1 is what the DEFAULT level (0.5) measures at over a white desktop, so everything ' +
    'above it buys solidity and no legibility — and 1.0 is still refused, because a fully opaque plate ' +
    'is the shipped look with extra steps'
);
check(
  'a non-boolean plate cannot switch the floor on',
  (await plateAfter({ plate: 'yes' })).plate === false &&
    (await plateAfter({ plate: 1 })).plate === false,
  'the renderer tests `config.plate !== true`, so a truthy string stored here would read as "on" on one ' +
    'side and "not true" on the other — the two halves of one control disagreeing about whether a floor ' +
    'is in force. A POST is a whole-document replace and carries every key, so resolving a non-boolean ' +
    'to the default (off) is the same answer all six booleans already give'
);
check('plate can be switched on, and off again', (await plateAfter({ plate: true })).plate === true &&
  (await plateAfter({ plate: false })).plate === false);
check('plateLevel clamped up to 0', (await plateAfter({ plateLevel: -1 })).plateLevel === 0);

// 窗口模糊 is the only config key whose *effect* is a field on the response
// rather than a property of the config, so it needs both halves asserted: the
// boolean has to behave like the other six, and the readback has to be a report
// rather than an echo. Under plain node there is no Electron, which is the one
// failure this suite can produce honestly — and the honest answer there is a
// named reason, not a silent `false` that the panel would render as "not
// applied" with no cause.
const blurAfter = async (body) => JSON.parse((await drive('POST', body)).body);
check(
  'windowBlur defaults to off and stays off through an unrelated POST',
  // Deliberately not `intensity`: the host's config is one shared object, and a
  // probe that changes a neighbour would move the ground under the assertions
  // further down. This is the same reason the plate checks above echo back a key
  // they do not care about.
  (await blurAfter({ plate: false })).windowBlur === false,
  'the fail-safe direction matters more here than for any other key: this one can take transparency ' +
    'away from the whole window by handing it to the compositor, so a config that lost the key must ' +
    'resolve to the shipped look rather than to the blur'
);
check(
  'a non-boolean windowBlur cannot switch the compositor on',
  (await blurAfter({ windowBlur: 'yes' })).windowBlur === false &&
    (await blurAfter({ windowBlur: 1 })).windowBlur === false,
  'same rule as `plate`, and stricter in consequence: `desired === true` is the only path that reaches ' +
    'setBackgroundMaterial, so a truthy string stored here would be off on the host and "on" in the ' +
    'panel — a switch that reports a blur the window does not have'
);
check(
  'windowBlur can be switched on, and off again',
  (await blurAfter({ windowBlur: true })).windowBlur === true &&
    (await blurAfter({ windowBlur: false })).windowBlur === false
);
check(
  'the GET carries a readback, not an echo',
  cfg.windowBlurReport !== null &&
    typeof cfg.windowBlurReport === 'object' &&
    cfg.windowBlurReport.active === false &&
    typeof cfg.windowBlurReport.why === 'string' &&
    cfg.windowBlurReport.why !== '',
  JSON.stringify(cfg.windowBlurReport)
);
check(
  'and without a resolvable archive it names that as the reason',
  cfg.windowBlurReport.why === 'no-archive',
  `${cfg.windowBlurReport.why} — the watcher's files live next to the archive, so "where is the ` +
    'install" and "did the main process answer" are two different failures and the report has to say ' +
    'which one it hit'
);
check(
  'the readback does not overwrite the setting it reports on',
  (() => {
    const body = JSON.parse(get1.body);
    // The response is `{ ...currentConfig, ...materialFields() }`. One key for
    // both facts means the object lands on top of the boolean, `coerceBooleans`
    // skips it for not being a boolean, and the setting silently reverts to the
    // default on every launch — a bug with no error message, no failed request
    // and no visible symptom until the next restart.
    return typeof body.windowBlur === 'boolean' &&
      body.windowBlurReport !== null &&
      typeof body.windowBlurReport === 'object';
  })(),
  'the config key stays a boolean and the report gets its own name. Two facts, two keys — the ' +
    'alternative is a setting that survives everything except a restart'
);
// ---------------------------------------------------------------------------
// The window-blur ladder
// ---------------------------------------------------------------------------
//
// Every other assertion about `applyWindowBlur` only ever sees its first branch,
// because there is no Electron and no install directory under plain node and the
// honest answer there is `no-archive`. That makes the protocol itself untested:
// whether the host writes a well-formed request, whether it believes a report
// that names the right `seq` and refuses one that does not, and how long it is
// willing to wait are all claims with no witness.
//
// So the protocol is driven for real. The "main process" of these cases is a
// helper that reads the request file and writes a report exactly the way the
// patched watcher does — same directory, same field names — which is possible
// because the wait between polls is an `await`, and the event loop is free while
// the handler holds. A synchronous wait would have made this untestable without
// a second process; that alone justifies the async shape.

check(
  'window blur — an unresolvable install is named, not guessed',
  (await host.applyWindowBlur(true)).why === 'no-archive',
  'the watcher files live beside the archive; without the archive there is nowhere to put the request, and that is a different fact from "the main process did not answer"'
);

// A fake install: the resolver's DSH_ASAR override wins, so the resources
// directory is a sandbox directory and the protocol's two files are written
// where the test can see them.
const blurDir = path.join(sandboxHome, 'blur-install', 'resources');
fs.mkdirSync(blurDir, { recursive: true });
fs.writeFileSync(path.join(blurDir, 'app.asar'), `// ${host.PATCH_MARKER}\n`, 'utf-8');
// The resolver reads the override at CALL time, not at import time, so it has to
// stay set for as long as the ladder is driving the protocol — it is deleted
// below, once the last case has been answered.
process.env.DSH_ASAR = blurDir + path.sep + 'app.asar';
const blurHost = await import(`${pathToFileURL(HOST).href}?blur=${Date.now()}`);

const WANTED_FILE = path.join(blurDir, host.WINDOW_BLUR_FILES.wanted);
const REPORT_FILE = path.join(blurDir, host.WINDOW_BLUR_FILES.report);

/**
 * The patched main process, shrunk to what a case needs.
 *
 * `answer` receives the parsed request and returns the report body; the shape
 * it produces is the shape the real watcher produces, and a case that wants a
 * stubborn window or a missing window answers through the same fields rather
 * than through a special channel.
 */
function watcherAnswer(answer) {
  const wanted = JSON.parse(fs.readFileSync(WANTED_FILE, 'utf8'));
  fs.writeFileSync(REPORT_FILE, `${JSON.stringify({ seq: wanted.seq, ...answer(wanted) })}\n`);
}

// `applyWindowBlur` is async but runs synchronously up to its first `await`, so
// the request file is on disk before the call's promise is even returned. That
// is what lets one process be both halves: the case reads the request, answers
// it, and the handler picks the answer up on its next poll. A synchronous wait
// would have made this untestable without a second process, which is the whole
// reason the wait is an `await` and not a sleep.

const MATERIALS = blurHost.WINDOW_MATERIALS;

// The archive half's material list, read out of its source rather than copied.
// The point of the check below is that the two halves are in step, and a copy
// would let this file drift with the thing it is supposed to be checking —
// which is the same mistake, one level up.
const ARCHIVE_MATERIALS = (() => {
  const src = fs.readFileSync(path.join(HERE, 'asarpatch.py'), 'utf8');
  const m = src.match(/^MATERIALS = \(([^)]*)\)/m);
  if (m === null) return [];
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
})();

// The watcher's own `off`, read out of the patcher's source. This is the value
// that actually reaches `setBackgroundMaterial` on air's machine, and it has to
// be the measured one.
//
// Read from the EMITTER rather than by running `--print-watcher`, and that is
// deliberate: the generated line is built from `RUNTIME_ON`/`RUNTIME_OFF`, so a
// check against the generated text would agree with whatever those constants
// say and prove nothing about the archive half's source. What has to hold is
// that the patcher's own constant is the measured value.
//
// `null` on no match is load-bearing: a guard that read `null` as "fine" would
// pass on a source where the watcher had been deleted, which is the one state
// this must never wave through.
const WATCHER_OFF = (() => {
  const src = fs.readFileSync(path.join(HERE, 'asarpatch.py'), 'utf8');
  const on = src.match(/^RUNTIME_ON = "([^"]+)"/m);
  const off = src.match(/^RUNTIME_OFF = "([^"]+)"/m);
  return on === null || off === null ? null : { on: on[1], off: off[1] };
})();

check(
  'window blur — each half names a material that was measured on this window, and names it in its own terms',
  // Not "the two materials are X and Y" any more, because the two halves no
  // longer ask for the same pair. The archive picks a material once at
  // creation, where `none` is right; this half changes it at runtime, where
  // `none` wedges the window white and `auto` is the value that actually takes
  // the material away. Both facts are asserted, because the bug this replaces
  // was exactly the two halves being assumed interchangeable.
  MATERIALS.on === 'acrylic' &&
    MATERIALS.off === 'auto' &&
    ARCHIVE_MATERIALS.includes('none') &&
    ARCHIVE_MATERIALS.includes('acrylic'),
  JSON.stringify(MATERIALS) +
    ' at runtime, archive ' +
    JSON.stringify(ARCHIVE_MATERIALS) +
    ' — `acrylic` is DWM\'s blurred copy of the desktop and the only name that means "blurred". ' +
    'OFF differs by half on purpose: `auto` hands the window back to DWM and restores the desktop ' +
    '(0.875 / 129, measured), while `none` — correct for a window CREATED with it — paints a live ' +
    'window opaque white when set at runtime (0.025 / 254.9). Every other name is a look nobody ' +
    'has measured on this window'
);

check(
  'window blur — the two halves agree on what OFF means, and OFF is the measured value',
  // This is the check the white screen would have failed. The host writes the
  // request; the watcher reads it and applies it. Nothing forced those two to
  // name the same string until now, and when they disagreed the symptom was a
  // window that went opaque — a failure three layers away from the mismatch.
  WATCHER_OFF !== null && WATCHER_OFF.off === MATERIALS.off && WATCHER_OFF.on === MATERIALS.on,
  `host ${JSON.stringify(MATERIALS)} vs watcher ${JSON.stringify(WATCHER_OFF)} — ` +
    'the host decides what to ask for and the watcher decides what to apply, so a disagreement ' +
    'between them is a request that is answered with something else. `off` is `auto` on both ' +
    'because that is the value measured to restore the desktop at runtime; the archive\'s `none` ' +
    'is a different question and is not interchangeable with it'
);

fs.rmSync(REPORT_FILE, { force: true });
const firstCall = blurHost.applyWindowBlur(true);
const request1 = JSON.parse(fs.readFileSync(WANTED_FILE, 'utf8'));
watcherAnswer(() => ({ active: true, why: null, material: MATERIALS.on }));
const firstResult = await firstCall;

check(
  'window blur — the request is a sequence number plus one material, and nothing else',
  request1.seq === 1 &&
    request1.material === MATERIALS.on &&
    Object.keys(request1).sort().join(',') === 'material,seq',
  JSON.stringify(request1)
);
check(
  'window blur — a report naming this request is believed, and it is the answer the panel shows',
  firstResult.active === true && firstResult.why === null && firstResult.material === 'acrylic',
  JSON.stringify(firstResult)
);

// The write is lazy. This runs on every config read, so rewriting an unchanged
// request would make the watcher re-apply on every panel poll — and a redundant
// `setBackgroundMaterial` re-triggers the DWM transition, which reads as a
// flicker on a window nobody touched.
fs.rmSync(WANTED_FILE, { force: true });
const lazyResult = await blurHost.applyWindowBlur(true);
check(
  'window blur — an unchanged material is not rewritten, so the panel cannot flicker the window',
  fs.existsSync(WANTED_FILE) === false && lazyResult.active === true,
  `wanted re-created: ${fs.existsSync(WANTED_FILE)}; result ${JSON.stringify(lazyResult)}`
);

const offCall = blurHost.applyWindowBlur(false);
const request2 = JSON.parse(fs.readFileSync(WANTED_FILE, 'utf8'));
watcherAnswer(() => ({ active: false, why: null, material: MATERIALS.off }));
const offResult = await offCall;
check(
  'window blur — switching off advances the sequence and asks for the sharp material',
  request2.seq === 2 &&
    request2.material === MATERIALS.off &&
    offResult.active === false &&
    offResult.why === null,
  `${JSON.stringify(request2)} -> ${JSON.stringify(offResult)}`
);

// `no-window` is transient: the watcher reports it for requests that land before
// the main window exists, and re-reports the same `seq` the moment one is
// created. Believing it would pin the panel to "失败" for the rest of the
// session over a race that resolves in milliseconds.
const transientCall = blurHost.applyWindowBlur(true);
setTimeout(() => watcherAnswer(() => ({ active: false, why: 'no-window', material: null })), 0);
setTimeout(() => watcherAnswer(() => ({ active: true, why: null, material: MATERIALS.on })), 150);
const transient = await transientCall;
// Both timers have to be drained before the next case. `watcherAnswer` stamps
// the report with whatever `seq` the request file carries at the moment it
// fires, so a timer that wakes up late does not answer an old request — it
// answers the NEW one, and the next case reads it as its own receipt. Under
// load that is exactly what happened: a leftover `no-window` landed inside the
// following case and was read as a settled answer that had not been given.
await new Promise((resolve) => setTimeout(resolve, 200));
check(
  'window blur — "no-window" is retried rather than believed, and the settled report wins',
  transient.active === true && transient.why === null && transient.material === 'acrylic',
  JSON.stringify(transient)
);

// A report that does not name this request is indistinguishable from one left
// over from a previous session: the report file survives restarts. Believing it
// would show 已生效 for a window this session never touched.
const staleCall = blurHost.applyWindowBlur(false);
const staleSeq = JSON.parse(fs.readFileSync(WANTED_FILE, 'utf8')).seq;
fs.writeFileSync(
  REPORT_FILE,
  `${JSON.stringify({ seq: staleSeq - 1, active: true, why: null, material: 'acrylic' })}\n`
);
const staleStart = Date.now();
const stale = await staleCall;
const staleMs = Date.now() - staleStart;
check(
  'window blur — a report answering a different request is refused',
  stale.active === false && stale.why === 'no-report',
  JSON.stringify(stale)
);
check(
  'window blur — refusing it costs one bounded wait, not a hang',
  staleMs >= 700 && staleMs < 4000,
  `${staleMs}ms — long enough for a patched main process to answer, short enough that a panel read never blocks on it`
);

// The one event that makes reports stale is also the one that restarts the
// count: a new session numbers from 1, and 1 is what the last session's report
// is carrying. Without seeding, the guard above is defeated by exactly the
// restart it exists to survive.
fs.writeFileSync(
  REPORT_FILE,
  `${JSON.stringify({ seq: 41, active: true, why: null, material: 'acrylic' })}\n`
);
const replayHost = await import(`${pathToFileURL(HOST).href}?blur-replay=${Date.now()}`);
const replayCall = replayHost.applyWindowBlur(true);
const replaySeq = JSON.parse(fs.readFileSync(WANTED_FILE, 'utf8')).seq;
const replayResult = await replayCall;
check(
  'window blur — a new session numbers its first request above the report the previous one left',
  replaySeq === 42,
  `wanted seq ${replaySeq}, carried report seq 41 — counting from 1 every session makes the ` +
    'first request of this session and the last report of the last one the same number'
);
check(
  'window blur — and so the carried report is refused rather than read as this session\'s answer',
  replayResult.active === false && replayResult.why === 'no-report',
  JSON.stringify(replayResult)
);

const memoStart = Date.now();
const memo = await blurHost.applyWindowBlur(false);
const memoMs = Date.now() - memoStart;
check(
  'window blur — one unanswered wait is remembered, so every later poll does not pay it again',
  memo.why === 'no-report' && memoMs < 250,
  `${memoMs}ms / ${JSON.stringify(memo)} — the memo is what keeps an unpatched client from turning every config read into a 900ms stall`
);

const resetCall = blurHost.applyWindowBlur(true);
watcherAnswer(() => ({ active: true, why: null, material: MATERIALS.on }));
const reset = await resetCall;
check(
  'window blur — a new material clears the memory, because that is when a working watcher has something new to say',
  reset.active === true && reset.material === 'acrylic',
  JSON.stringify(reset)
);

// The window took the call and kept the old material: DWM refusing acrylic is
// the one outcome air would actually see (switch on, nothing happens), so it has
// to arrive as a reason and not as a silent `false`.
const stubbornCall = blurHost.applyWindowBlur(false);
watcherAnswer(() => ({ active: false, why: 'material-not-applied', material: MATERIALS.on }));
const stubborn = await stubbornCall;
check(
  'window blur — a window that kept the old material says so, and names the material it kept',
  stubborn.active === false &&
    stubborn.why === 'material-not-applied' &&
    stubborn.material === 'acrylic',
  JSON.stringify(stubborn)
);

// A request that cannot be written — the resources directory is where the
// installer put it, and a locked-down install is a real state.
fs.rmSync(WANTED_FILE, { force: true });
fs.mkdirSync(WANTED_FILE);
const writeFailed = await blurHost.applyWindowBlur(true);
const writeFailedAgain = await blurHost.applyWindowBlur(true);
fs.rmSync(WANTED_FILE, { recursive: true, force: true });
check(
  'window blur — a request that cannot be written is named, and not remembered as settled',
  writeFailed.why === 'write-failed' &&
    writeFailed.active === false &&
    writeFailedAgain.why === 'write-failed',
  `${JSON.stringify(writeFailed)} then ${JSON.stringify(writeFailedAgain)}`
);

delete process.env.DSH_ASAR;

// ---------------------------------------------------------------------------
// The watcher itself
// ---------------------------------------------------------------------------
// Everything above tests the host's half of the protocol against a stand-in for
// the main process. The stand-in is not the thing that will run in air's
// client: that is the watcher `tools/asarpatch.py` grafts into `lib/main.js`,
// and until now the only thing proved about it was that it parses. It is
// executed here against a fake Electron instead — same source text, same
// directory protocol — so the part that actually touches the window is covered
// by more than a syntax check.

const ASARPATCH = path.join(HERE, 'asarpatch.py');
const PYTHON_CANDIDATES = process.env.DSL_PYTHON
  ? [[process.env.DSL_PYTHON, []]]
  : process.platform === 'win32'
    ? [['python', []], ['py', ['-3']]]
    : [['python3', []], ['python', []]];

function execPython(args, options) {
  let missing;
  for (const [executable, prefix] of PYTHON_CANDIDATES) {
    try {
      return execFileSync(executable, [...prefix, ...args], options);
    } catch (error) {
      if (error?.code !== 'ENOENT' || process.env.DSL_PYTHON) throw error;
      missing = error;
    }
  }
  throw missing ?? new Error('No Python interpreter found');
}

let WATCHER_SRC = null;
let watcherError = null;
try {
  WATCHER_SRC = execPython([ASARPATCH, '--print-watcher'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore']
  });
} catch (error) {
  watcherError = error?.message ?? String(error);
}
check(
  'the watcher source can be read out of the patcher',
  typeof WATCHER_SRC === 'string' && WATCHER_SRC.includes('setBackgroundMaterial'),
  watcherError ?? `${WATCHER_SRC?.length ?? 0} chars`
);

/** A window the fake Electron can hand the watcher. */
function fakeWin(opts = {}) {
  const {
    width = 800,
    height = 600,
    visible = true,
    destroyed = false,
    material = 'none',
    applies = true,
    throwsOnSet = false,
    getter = true
  } = opts;
  const listeners = {};
  let shown = visible;
  const win = {
    calls: [],
    isDestroyed: () => destroyed,
    isVisible: () => shown,
    getBounds: () => ({ width, height }),
    getBackgroundMaterial: () => (getter ? win.material : undefined),
    setBackgroundMaterial(value) {
      win.calls.push(value);
      if (throwsOnSet) throw new Error('DWM refused');
      if (applies) win.material = value;
    },
    // Only the hooks the watcher actually uses. `becomeVisible` is how a case
    // plays out the one sequence that matters on the real client: the primary
    // window is built with `show: false` and only shown afterwards.
    on: (name, fn) => {
      (listeners[name] = listeners[name] || []).push(fn);
    },
    becomeVisible: () => {
      shown = true;
      (listeners.show ?? []).slice().forEach((fn) => fn());
    },
    material
  };
  return win;
}

/**
 * Run the real watcher source against a fake Electron.
 *
 * `createRequire(import.meta.url)` is the one line that cannot run outside an
 * ES module, so it is replaced by a require the case controls; everything else
 * — the whitelist, the window pick, the read-then-set, the report shape — is
 * the code that ships. `fs.watch` is stubbed to a no-op handle so a case does
 * not leave a watcher on a temp directory, and `app.on` is captured rather than
 * fired so a case can decide when a window appears.
 */
async function runWatcher({ windows = [], wanted = null, failRequire = false }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsl-watcher-'));
  const wantedFile = path.join(dir, host.WINDOW_BLUR_FILES.wanted);
  const reportFile = path.join(dir, host.WINDOW_BLUR_FILES.report);
  if (wanted !== null) fs.writeFileSync(wantedFile, `${JSON.stringify(wanted)}\n`, 'utf8');

  const created = [];
  const electron = {
    BrowserWindow: { getAllWindows: () => windows },
    app: { on: (name, fn) => created.push({ name, fn }) }
  };
  const lgFs = {
    readFileSync: fs.readFileSync,
    writeFileSync: fs.writeFileSync,
    watch: () => ({ close() {} })
  };
  const requireOf = (id) => {
    if (failRequire && id === 'electron') throw new Error("Cannot find module 'electron'");
    if (id === 'node:fs') return lgFs;
    if (id === 'node:path') return path;
    if (id === 'electron') return electron;
    throw new Error(`unexpected require: ${id}`);
  };
  const tick = () => new Promise((resolve) => setImmediate(resolve));

  let threw = null;
  try {
    vm.runInNewContext(
      WATCHER_SRC.replace('createRequire(import.meta.url)', '__lgRequire'),
      vm.createContext({ __lgRequire: requireOf, process: { resourcesPath: dir }, setImmediate, console })
    );
  } catch (error) {
    threw = error;
  }
  await tick();
  await tick();

  const readReport = () => {
    try {
      return JSON.parse(fs.readFileSync(reportFile, 'utf8'));
    } catch {
      return null;
    }
  };
  // The window list is reachable after the run so a case can add a window and
  // fire the creation hook, which is the ordinary reason a material is missing.
  return { dir, report: readReport(), created, threw, readReport, tick, wins: windows };
}

if (WATCHER_SRC !== null) {
  const micaWin = fakeWin();
  const mica = await runWatcher({ windows: [micaWin], wanted: { seq: 1, material: 'mica' } });
  check(
    'watcher — the whitelist is not a pass-through: an unmeasured material is refused',
    mica.report?.why === 'unknown-material' && mica.report?.wanted === 'mica',
    JSON.stringify(mica.report)
  );
  check(
    'watcher — and a refused material is never handed to the window',
    mica.report?.material === null && micaWin.calls.length === 0,
    `calls ${JSON.stringify(micaWin.calls)} — the file is a hand-editable request to the ` +
      'compositor; an arbitrary name is a window that renders in a way nobody measured'
  );

  const applied = await runWatcher({ windows: [fakeWin()], wanted: { seq: 7, material: 'acrylic' } });
  check(
    'watcher — a wanted material is applied, and the report echoes the sequence it answered',
    applied.report?.seq === 7 &&
      applied.report?.active === true &&
      applied.report?.material === 'acrylic' &&
      applied.report?.why === null,
    JSON.stringify(applied.report)
  );

  const big = fakeWin({ width: 1920, height: 1080 });
  const small = fakeWin({ width: 800, height: 600 });
  const picked = await runWatcher({ windows: [small, big], wanted: { seq: 2, material: 'acrylic' } });
  check(
    'watcher — the largest visible window is the one that gets the material',
    big.calls.join(',') === 'acrylic' && small.calls.length === 0 && picked.report?.active === true,
    `big ${JSON.stringify(big.calls)} / small ${JSON.stringify(small.calls)} — a material is a ` +
      'per-window property and the main window is not always the first one created'
  );

  const none = await runWatcher({ windows: [], wanted: { seq: 3, material: 'acrylic' } });
  const hidden = await runWatcher({
    windows: [fakeWin({ visible: false })],
    wanted: { seq: 3, material: 'acrylic' }
  });
  check(
    'watcher — no window, and no VISIBLE window, are both reported as "no-window" rather than success',
    none.report?.why === 'no-window' &&
      none.report?.active === false &&
      hidden.report?.why === 'no-window',
    `${JSON.stringify(none.report)} / ${JSON.stringify(hidden.report)}`
  );

  const already = fakeWin({ material: 'acrylic' });
  const idempotent = await runWatcher({ windows: [already], wanted: { seq: 4, material: 'acrylic' } });
  check(
    'watcher — a window already at the material is left alone',
    already.calls.length === 0 && idempotent.report?.active === true,
    `calls ${JSON.stringify(already.calls)} — this runs on every window creation; a redundant set ` +
      're-triggers the DWM transition and reads as a flicker'
  );

  const refused = fakeWin({ throwsOnSet: true });
  const setFailed = await runWatcher({ windows: [refused], wanted: { seq: 5, material: 'acrylic' } });
  check(
    'watcher — a window that refuses the call says set-failed, not "applied"',
    setFailed.report?.why === 'set-failed' && setFailed.report?.active === false,
    JSON.stringify(setFailed.report)
  );
  check(
    'watcher — a setter that throws does not take the client down with it',
    setFailed.threw === null,
    String(setFailed.threw)
  );

  const blind = fakeWin({ getter: false });
  const noGetter = await runWatcher({ windows: [blind], wanted: { seq: 6, material: 'acrylic' } });
  check(
    'watcher — a build with no getter reports no-getter instead of guessing from the request',
    noGetter.report?.why === 'no-getter' &&
      noGetter.report?.active === false &&
      noGetter.report?.applied === true &&
      noGetter.report?.verified === false,
    JSON.stringify(noGetter.report) +
      ' — without a readback the report would be an echo of what was asked for, which is the one ' +
      'thing it exists not to be. `applied` is the part that is true here: the request did reach ' +
      'the compositor, nobody can read it back'
  );

  // Measured on Electron 44.0.0 / win32: `getBackgroundMaterial` does not exist
  // on any window, `setBackgroundMaterial` does. So on the build this ships to,
  // "is it already this material?" is unanswerable — and a read-then-set guard
  // that trusts the read would set on EVERY window creation, which is the
  // flicker the guard exists to prevent, on the one build that cannot report
  // it. Remembering the last request is what keeps it idempotent.
  const blindReassert = await runWatcher({
    windows: [fakeWin({ getter: false })],
    wanted: { seq: 6, material: 'acrylic' }
  });
  const onCreateBlind = blindReassert.created.find((entry) => entry.name === 'browser-window-created');
  if (onCreateBlind) onCreateBlind.fn();
  await blindReassert.tick();
  if (onCreateBlind) onCreateBlind.fn();
  await blindReassert.tick();
  check(
    'watcher — with no getter, a second window creation does not set the material again',
    blindReassert.wins[0].calls.length === 1,
    `calls ${JSON.stringify(blindReassert.wins[0].calls)} — the remember-last stand-in is the only ` +
      'thing standing between this build and a DWM transition on every window'
  );

  const stubbornWin = fakeWin({ applies: false });
  const notApplied = await runWatcher({ windows: [stubbornWin], wanted: { seq: 8, material: 'acrylic' } });
  check(
    'watcher — a window that took the call and kept the old material is reported as such',
    notApplied.report?.why === 'material-not-applied' &&
      notApplied.report?.material === 'none' &&
      notApplied.report?.active === false,
    JSON.stringify(notApplied.report)
  );

  const turningOff = fakeWin({ material: 'acrylic' });
  const off = await runWatcher({ windows: [turningOff], wanted: { seq: 9, material: 'auto' } });
  check(
    'watcher — turning it off is a real set, and "off" is a success rather than a failure',
    turningOff.calls.join(',') === 'auto' && off.report?.active === false && off.report?.why === null,
    `${JSON.stringify(turningOff.calls)} / ${JSON.stringify(off.report)} — ` +
      '`active` means "blurred", so a sharp window must not be reported as an error'
  );

  // The trap, closed. `none` is a legal material for a window CREATED with it —
  // the archive uses it — but setting it on a live window turns that window
  // opaque white on this build (probe `unswitch`: 0.025 / 254.9). The request
  // file is hand-editable and this watcher is the last gate before the
  // compositor, so the value that wedges the window has to be refused HERE
  // rather than trusted not to arrive.
  const trap = fakeWin({ material: 'acrylic' });
  const trapped = await runWatcher({ windows: [trap], wanted: { seq: 11, material: 'none' } });
  check(
    'watcher — `none` is refused at runtime, because that is the value that wedges the window',
    trap.calls.length === 0 &&
      trapped.report?.why === 'unknown-material' &&
      trapped.report?.applied === false,
    `${JSON.stringify(trap.calls)} / ${JSON.stringify(trapped.report)} — ` +
      'measured: `setBackgroundMaterial("none")` on a live acrylic window does not remove the ' +
      'material, it paints the window opaque white and no CSS can undo it. `auto` is the runtime ' +
      'OFF; `none` stays legal only as the archive\'s create-time material'
  );

  check(
    'watcher — with no request on disk it stays silent instead of inventing one',
    (await runWatcher({ windows: [fakeWin()], wanted: null })).report === null,
    'the file does not exist until the host writes it, and the watcher also runs at boot'
  );

  // A new window is the ordinary reason a material is missing: the main window
  // is often not the first one created, so the watcher re-asserts on creation.
  const late = fakeWin({ material: 'none' });
  const reassert = await runWatcher({ windows: [], wanted: { seq: 10, material: 'acrylic' } });
  check(
    'watcher — before that window exists it reported no-window',
    reassert.report?.why === 'no-window',
    JSON.stringify(reassert.report)
  );
  reassert.wins.push(late);
  const onCreate = reassert.created.find((entry) => entry.name === 'browser-window-created');
  if (onCreate) onCreate.fn();
  await reassert.tick();
  check(
    'watcher — a window created after the request is materialised too',
    onCreate !== undefined && late.calls.join(',') === 'acrylic' && reassert.readReport()?.active === true,
    `registered: ${onCreate !== undefined}; calls ${JSON.stringify(late.calls)}; ` +
      `report ${JSON.stringify(reassert.readReport())}`
  );

  // The sequence that actually happens on the client, and the reason the
  // material used to never land: `createWindow(appPreload, false, true)` builds
  // the primary window with `show: false`, so `browser-window-created` fires at
  // the one moment there is no VISIBLE window, and nothing fires later when it
  // appears. The re-assert has to hang off `show` as well.
  const lateShow = fakeWin({ visible: false });
  const shownCase = await runWatcher({ windows: [], wanted: { seq: 12, material: 'acrylic' } });
  shownCase.wins.push(lateShow);
  const onCreateShow = shownCase.created.find((entry) => entry.name === 'browser-window-created');
  if (onCreateShow) onCreateShow.fn({}, lateShow);
  await shownCase.tick();
  check(
    'watcher — the creation hook lands while the window is still invisible, and says so',
    shownCase.readReport()?.why === 'no-window' &&
      shownCase.readReport()?.via === 'created' &&
      lateShow.calls.length === 0,
    `calls ${JSON.stringify(lateShow.calls)}; report ${JSON.stringify(shownCase.readReport())} — ` +
      'this is the ordinary case on the client, not an error case'
  );
  lateShow.becomeVisible();
  await shownCase.tick();
  check(
    'watcher — when that window is finally shown, the material lands after all',
    lateShow.calls.join(',') === 'acrylic' &&
      shownCase.readReport()?.via === 'shown' &&
      shownCase.readReport()?.applied === true,
    `calls ${JSON.stringify(lateShow.calls)}; report ${JSON.stringify(shownCase.readReport())} — ` +
      'without a hook on `show`, the switch is on and the desktop never changes'
  );

  const noElectron = await runWatcher({
    windows: [fakeWin()],
    wanted: { seq: 11, material: 'acrylic' },
    failRequire: true
  });
  check(
    'watcher — without Electron it says nothing and breaks nothing',
    noElectron.threw === null && noElectron.report === null,
    `threw ${String(noElectron.threw)} — the worst case of not running is the window staying sharp, ` +
      'which is the status quo, not a new failure'
  );
} else {
  check('the watcher could be executed against a fake Electron', false, watcherError ?? 'no source');
}

check('unknown tint rejected', saved.tint === 'ice', saved.tint);
check('unknown key dropped', saved.bogus === undefined);
check('sanitized config landed in memory', JSON.parse((await drive('GET')).body).intensity === 2);

const put = await drive('PUT');
check('PUT rejected with 405', put.statusCode === 405, String(put.statusCode));

const options = await drive('OPTIONS');
check('OPTIONS preflight answered 204', options.statusCode === 204, String(options.statusCode));

check('config file path under plugins/', host.CONFIG_FILE.includes(`${path.sep}plugins${path.sep}`), host.CONFIG_FILE);

// ---------------------------------------------------------------------------
// Window-material diagnosis
// ---------------------------------------------------------------------------
//
// `material: "unknown"` is what the panel showed while the archive was sitting
// at a perfectly findable path, and it carried no information at all: the two
// original candidates both missed, and there was no way to tell "wrong path"
// from "found it but could not read it". Those need unrelated fixes, so the
// response now has to carry the reason and the paths that were tried.

const REASONS = new Set([
  'no-candidate-found',
  'scan-failed',
  'marker-absent',
  'marker-found'
]);

check(
  'material is one of the three known states',
  ['patched', 'stock', 'unknown'].includes(cfg.material),
  cfg.material
);
check(
  'materialWhy is a known reason code',
  REASONS.has(cfg.materialWhy),
  cfg.materialWhy
);
check(
  'materialTried is a non-empty array',
  Array.isArray(cfg.materialTried) && cfg.materialTried.length > 0,
  `${cfg.materialTried?.length} entries`
);
check(
  'every tried entry carries a path and a verdict',
  cfg.materialTried.every(
    (entry) =>
      typeof entry?.path === 'string' &&
      entry.path !== '' &&
      (entry.why === 'exists' || entry.why === 'missing' || entry.why.startsWith('unreadable:'))
  ),
  JSON.stringify(cfg.materialTried.slice(0, 2))
);
// The diagnosis has to be *self-consistent*, not merely present: the whole
// failure was a report that could not be believed.
check(
  'marker-found agrees with material patched',
  (cfg.material === 'patched') === (cfg.materialWhy === 'marker-found'),
  `${cfg.material} / ${cfg.materialWhy}`
);
check(
  'marker-absent agrees with material stock',
  (cfg.material === 'stock') === (cfg.materialWhy === 'marker-absent'),
  `${cfg.material} / ${cfg.materialWhy}`
);
check(
  'a settled path implies it was probed, and vice versa',
  (cfg.materialPath === null) === (cfg.materialWhy === 'no-candidate-found'),
  `${cfg.materialPath} / ${cfg.materialWhy}`
);
check(
  'a non-null path appears in the tried list as existing',
  cfg.materialPath === null ||
    cfg.materialTried.some((entry) => entry.path === cfg.materialPath && entry.why === 'exists'),
  String(cfg.materialPath)
);

// Resolver behaviour, exercised directly rather than through the memoised
// cache: the cache would hide a broken fallback behind whatever the first call
// happened to find.
const emptyResolver = host.resolveAsarPathDetailed();
check(
  'resolver reports its own failure rather than throwing',
  emptyResolver.file === null || typeof emptyResolver.file === 'string',
  String(emptyResolver.file)
);
check(
  'resolver never returns the same path twice',
  new Set(emptyResolver.tried.map((entry) => entry.path)).size === emptyResolver.tried.length,
  `${emptyResolver.tried.length} entries`
);

// $DSH_ASAR is the documented escape hatch for a relocated install, and it has
// to win over every derived candidate — otherwise the "just set the variable"
// advice in the README is a lie on exactly the machines that need it.
const overrideDir = path.join(sandboxHome, 'fake-install', 'resources');
fs.mkdirSync(overrideDir, { recursive: true });
const fakeAsar = path.join(overrideDir, 'app.asar');
fs.writeFileSync(fakeAsar, `// ${host.PATCH_MARKER}\n`, 'utf-8');
process.env.DSH_ASAR = fakeAsar;
const overridden = host.resolveAsarPathDetailed();
delete process.env.DSH_ASAR;
check(
  'DSH_ASAR override wins',
  overridden.file === fakeAsar,
  `${overridden.file} (expected ${fakeAsar})`
);

// The resolver returning a path is not enough: the API response is what the
// client receives, so it must carry the same path through materialFields().
// Use a fresh module instance to avoid the first instance's memoised result.
const pathProofAsar = path.join(overrideDir, 'path-proof.asar');
fs.writeFileSync(pathProofAsar, 'test archive without the plugin marker', 'utf8');
const previousAsar = process.env.DSH_ASAR;
process.env.DSH_ASAR = pathProofAsar;
const pathProofHost = await import(`${pathToFileURL(HOST).href}?path-proof=${Date.now()}`);
let pathProofRoute = null;
pathProofHost.apply({
  webServer: { register: (r) => { pathProofRoute = r; } },
  logger: { info: () => {} }
});
const pathProofResponse = await drive('GET', undefined, pathProofRoute);
if (previousAsar === undefined) delete process.env.DSH_ASAR;
else process.env.DSH_ASAR = previousAsar;
const pathProofConfig = JSON.parse(pathProofResponse.body);
check(
  'the detected archive path reaches the config response',
  pathProofResponse.statusCode === 200 && pathProofConfig.materialPath === pathProofAsar,
  `${pathProofConfig.materialPath} (expected ${pathProofAsar})`
);

// ---------------------------------------------------------------------------
// Reading the archive on an asar-patched host
// ---------------------------------------------------------------------------
//
// This is the failure air actually hit: the path resolved, `existsSync` said the
// file was there, and the open still threw — which is unguessable from inside
// unless you know the runtime rewrites `fs.openSync` for `.asar` paths. It is
// simulated here rather than described, because the whole fix is a claim about
// what happens when `fs.openSync` throws, and a claim like that is worth exactly
// as much as the test that produces the throw.
//
// The patch below mirrors the documented behaviour: with asar support on, an
// archive path is a *virtual directory*, so opening it as a file fails; with it
// off (or through `original-fs`), it is an ordinary file.

const realOpenSync = fs.openSync;
const realReaddirSync = fs.readdirSync;
const asarish = (p) => typeof p === 'string' && p.toLowerCase().endsWith('.asar');

function patchAsarRuntime() {
  fs.openSync = function patchedOpenSync(p, ...rest) {
    if (asarish(p) && process.noAsar !== true) {
      const error = new Error(`ENOENT: no such file or directory, open '${p}'`);
      error.code = 'ENOENT';
      error.syscall = 'open';
      throw error;
    }
    return realOpenSync.call(this, p, ...rest);
  };
  fs.readdirSync = function patchedReaddirSync(p, ...rest) {
    if (asarish(p)) return ['lib', 'package.json'];
    return realReaddirSync.call(this, p, ...rest);
  };
}

function unpatchAsarRuntime() {
  fs.openSync = realOpenSync;
  fs.readdirSync = realReaddirSync;
}

const simAsar = path.join(sandboxHome, 'sim', 'resources', 'app.asar');
fs.mkdirSync(path.dirname(simAsar), { recursive: true });
fs.writeFileSync(simAsar, `body\n${host.PATCH_MARKER}\nbody\n`, 'utf-8');

patchAsarRuntime();
const readers = host.archiveReaders();
check(
  'a plain-node host is offered the noAsar reader',
  readers.some((reader) => reader.label === 'noAsar'),
  readers.map((reader) => reader.label).join(',')
);
check(
  'the archive is unreachable through the patched fs directly',
  (() => {
    try {
      fs.openSync(simAsar, 'r');
      return false;
    } catch (error) {
      return error.code === 'ENOENT';
    }
  })()
);
const rescued = host.scanForMarkerDetailed(simAsar, host.PATCH_MARKER);
check(
  'the noAsar reader rescues a scan the patched fs refuses',
  rescued.found === true,
  `found=${rescued.found} via=${rescued.via}`
);
check(
  'the reader used is reported',
  typeof rescued.via === 'string' && rescued.via !== '',
  String(rescued.via)
);
check(
  'process.noAsar is left exactly as it was found',
  Object.prototype.hasOwnProperty.call(process, 'noAsar') === false,
  JSON.stringify(process.noAsar)
);

// The switch has to be restored even when it was already set by somebody else —
// this half does not own the process it runs in.
process.noAsar = false;
host.scanForMarkerDetailed(simAsar, host.PATCH_MARKER);
check(
  'a pre-existing noAsar value is restored, not deleted',
  process.noAsar === false,
  JSON.stringify(process.noAsar)
);
delete process.noAsar;

// Every door shut: the failure has to name each one, or it is the same dead end
// as before with more words.
fs.openSync = function alwaysFails(p, ...rest) {
  if (asarish(p)) {
    const error = new Error(`EACCES: permission denied, open '${p}'`);
    error.code = 'EACCES';
    error.syscall = 'open';
    throw error;
  }
  return realOpenSync.call(this, p, ...rest);
};
const dead = host.scanForMarkerDetailed(simAsar, host.PATCH_MARKER);
check('every reader failing yields null, not a guess', dead.found === null, String(dead.found));
check(
  'each failed reader is named with its errno',
  dead.attempts.length > 0 &&
    dead.attempts.every((entry) => typeof entry.via === 'string' && typeof entry.code === 'string'),
  JSON.stringify(dead.attempts)
);
check(
  'the failure names a real errno rather than a placeholder',
  dead.attempts.some((entry) => entry.code === 'EACCES'),
  JSON.stringify(dead.attempts.map((entry) => entry.code))
);

const facts = host.hostFacts(simAsar);
check(
  'hostFacts reports whether the archive reads as a directory',
  facts.listsAsDirectory === true,
  JSON.stringify(facts)
);
check(
  'hostFacts reports the noAsar switch only when the runtime defines it',
  facts.noAsar === false,
  JSON.stringify(facts)
);
unpatchAsarRuntime();

const restoredFacts = host.hostFacts(simAsar);
check(
  'hostFacts on an unpatched host says the path is not a directory',
  restoredFacts.listsAsDirectory === false,
  JSON.stringify(restoredFacts)
);
check(
  'and after unpatching, the plain scan works again',
  host.scanForMarker(simAsar, host.PATCH_MARKER) === true
);

// ---------------------------------------------------------------------------
// The log lines — the only place any of this is ever read
// ---------------------------------------------------------------------------
//
// Every check above proves the diagnosis reaches the *response*. On the machine
// that has the problem the response is not what gets read: the console output
// is. A diagnosis that nothing prints is still a dead end, and losing it is the
// easiest kind of regression here — delete one `if` and every field stays
// perfect while the evidence that makes them actionable disappears. So the
// lines get asserted the same way the fields do.
//
// `detectWindowMaterialDetailed` memoises, so `apply()` can only be observed
// once per module instance. The forced failure below therefore imports a second
// instance instead of calling `apply()` twice — through the cache the first
// state would be handed back and the failure would never be reached.

check(
  'the verdict line carries the state, the reason and the path',
  hostLogs.some(
    (line) =>
      line.startsWith('[liquid-glass] window material: ') &&
      line.includes(cfg.material) &&
      line.includes(cfg.materialWhy)
  ),
  hostLogs.join(' | ')
);
check(
  'a missing path logs the whole candidate list, not a summary',
  cfg.materialPath !== null ||
    hostLogs.some((line) => line.startsWith('[liquid-glass] app.asar candidates tried:')),
  hostLogs.filter((line) => line.includes('candidates tried')).join(' | ') || '(absent)'
);

// The shape air actually hit: a path that resolves, that `existsSync` agrees
// is there, and that refuses to open. Both doors are shut here (the simulated
// asar patch refuses the archive even with `noAsar` set, and `original-fs` does
// not exist under plain node), so this is the one state where the failure has
// to be explained rather than merely reported.
patchAsarRuntime();
fs.openSync = function refusedArchive(p, ...rest) {
  if (asarish(p)) {
    const error = new Error(`ENOENT: no such file or directory, open '${p}'`);
    error.code = 'ENOENT';
    error.syscall = 'open';
    throw error;
  }
  return realOpenSync.call(this, p, ...rest);
};
process.env.DSH_ASAR = simAsar;
const failingLogs = [];
const failingHost = await import(`${pathToFileURL(HOST).href}?failing=${Date.now()}`);
failingHost.apply({
  webServer: { register: () => {} },
  logger: { info: (message) => failingLogs.push(String(message)) }
});
delete process.env.DSH_ASAR;
unpatchAsarRuntime();

check(
  'the forced case really is a failed scan',
  failingLogs.some((line) => line.includes('scan-failed')),
  failingLogs.join(' | ')
);
check(
  'a failed scan names each reader and the errno it came back with',
  failingLogs.some((line) => line.startsWith('[liquid-glass] readers tried:')),
  failingLogs.filter((line) => line.includes('readers tried')).join(' | ') || '(absent)'
);
check(
  'a failed scan reports the host facts, which is where the cause is',
  failingLogs.some((line) => line.includes('listsAsDirectory=true')),
  failingLogs.filter((line) => line.includes('host:')).join(' | ') || '(absent)'
);

// A host that offers BOTH doors is the normal case under Electron, because
// `original-fs` is there. Under plain node it is not, so this suite would only
// ever see one reader — and then "try the next door after one fails" is
// invisible: dropping every reader but the first changes nothing when there is
// only one. `original-fs` is therefore stubbed into the module cache and a
// fresh instance is imported to observe the two-door path for real.
//
// The stub's `openSync` refuses the archive unconditionally, so it is a first
// door that always fails; the rescued second door is the whole point.
const stubOriginalFs = {
  openSync(p, ...rest) {
    if (asarish(p)) {
      const error = new Error(`ENOENT: no such file or directory, open '${p}'`);
      error.code = 'ENOENT';
      error.syscall = 'open';
      throw error;
    }
    return realOpenSync.call(fs, p, ...rest);
  },
  closeSync: (fd) => fs.closeSync(fd)
};

function installOriginalFsStub() {
  const resolve = Module._resolveFilename;
  Module._resolveFilename = function (request, ...rest) {
    if (request === 'original-fs') return 'original-fs';
    return resolve.call(this, request, ...rest);
  };
  Module._cache['original-fs'] = {
    id: 'original-fs',
    filename: 'original-fs',
    loaded: true,
    exports: stubOriginalFs
  };
  return () => {
    Module._resolveFilename = resolve;
    delete Module._cache['original-fs'];
  };
}

patchAsarRuntime();
const removeStub = installOriginalFsStub();
process.env.DSH_ASAR = simAsar;
const bothHost = await import(`${pathToFileURL(HOST).href}?twodoor=${Date.now()}`);
const bothReaders = bothHost.archiveReaders().map((reader) => reader.label);
const both = bothHost.scanForMarkerDetailed(simAsar, bothHost.PATCH_MARKER);
delete process.env.DSH_ASAR;
removeStub();
unpatchAsarRuntime();

// Without this the rest of the block can pass while the stub silently failed to
// take, which would leave the mutation it exists to catch uncovered again.
check(
  'the stub really does add a second door',
  bothReaders.length === 2 && bothReaders.includes('original-fs'),
  bothReaders.join(',') || '(none)'
);
check(
  'a host with two doors keeps going after the first one is refused',
  both.found === true && both.via === 'noAsar',
  `found=${both.found} via=${both.via}`
);
check(
  'the refused door is still named in the report',
  both.attempts.some((entry) => entry.via === 'original-fs'),
  JSON.stringify(both.attempts)
);

check(
  'DSH_ASAR override is probed as existing',
  overridden.tried.length === 1 && overridden.tried[0].why === 'exists',
  JSON.stringify(overridden.tried)
);

// A path that exists but does not carry the marker is `stock`, not `unknown`.
// Collapsing these two is what made the original panel unreadable.
const bareAsar = path.join(overrideDir, 'bare.asar');
fs.writeFileSync(bareAsar, '// no marker here\n', 'utf-8');
process.env.DSH_ASAR = bareAsar;
const bareScan = host.scanForMarker(bareAsar, host.PATCH_MARKER);
delete process.env.DSH_ASAR;
check('a readable archive without the marker reports false, not null', bareScan === false, String(bareScan));

// The pointer file. On this machine it is the candidate that actually resolves:
// the plugin host runs in a node-side process where neither process.resourcesPath
// nor a derived walk-up names the install directory, and the archive is fully
// patched the whole time. So a regression here is silent — the suite would stay
// green on a machine whose fallback happened to work, and only air's would break.
check('pointer file lives beside the config', host.POINTER_FILE.startsWith(host.STORE_DIR), host.POINTER_FILE);
check(
  'a missing pointer file reads as empty, not as an error',
  typeof host.readAsarPointer() === 'string',
  JSON.stringify(host.readAsarPointer())
);

// A pointer written by tools/asarpatch.py must be picked up ahead of the walk,
// and it must be picked up *as a candidate* — a pointer to an archive without
// the marker reports stock, which is the honest answer after an auto-update.
fs.mkdirSync(host.STORE_DIR, { recursive: true });
const pointed = path.join(sandboxHome, 'pointed-install', 'resources', 'app.asar');
fs.mkdirSync(path.dirname(pointed), { recursive: true });
fs.writeFileSync(pointed, `// ${host.PATCH_MARKER}\n`, 'utf-8');
fs.writeFileSync(
  host.POINTER_FILE,
  `${JSON.stringify({ asar: pointed, state: 'patched' }, null, 2)}\n`,
  'utf-8'
);
check('pointer read returns the recorded path', host.readAsarPointer() === pointed, host.readAsarPointer());
const viaPointer = host.resolveAsarPathDetailed();
check('the pointer resolves the archive', viaPointer.file === pointed, String(viaPointer.file));
check(
  'the pointer is probed as existing',
  viaPointer.tried.some((entry) => entry.path === pointed && entry.why === 'exists'),
  JSON.stringify(viaPointer.tried)
);
// The override outranks the pointer: it is the manual escape hatch and has to
// work even when a pointer from an earlier patch is still lying around.
process.env.DSH_ASAR = fakeAsar;
const overrideBeatsPointer = host.resolveAsarPathDetailed();
delete process.env.DSH_ASAR;
check(
  'DSH_ASAR outranks the pointer file',
  overrideBeatsPointer.file === fakeAsar,
  `${overrideBeatsPointer.file} (expected ${fakeAsar})`
);
// A corrupt pointer must not take the walk down with it.
fs.writeFileSync(host.POINTER_FILE, '{ this is not json', 'utf-8');
check('a corrupt pointer reads as empty', host.readAsarPointer() === '', JSON.stringify(host.readAsarPointer()));
const afterCorrupt = host.resolveAsarPathDetailed();
check(
  'a corrupt pointer still leaves the derived walk working',
  afterCorrupt.file !== null || afterCorrupt.tried.length > 0,
  `${afterCorrupt.file} (${afterCorrupt.tried.length} tried)`
);

// Ordering: the pointer has to be consulted BEFORE the walk-up, or it is just a
// third guess in a list. This is only observable if something the walk can also
// find exists — otherwise both orders return the same pointer and the assertion
// passes either way, which is exactly the kind of decoration this file exists to
// catch. So the sandbox gets a decoy the walk can reach, planted by moving the
// process into the sandbox rather than by writing into the repository: a decoy
// left behind in the working tree by a crashed run would be worse than the bug
// it is meant to detect.
const restoreCwd = process.cwd();
const decoyDir = path.join(sandboxHome, 'decoy-root');
const decoy = path.join(decoyDir, 'resources', 'app.asar');
fs.mkdirSync(path.dirname(decoy), { recursive: true });
fs.writeFileSync(decoy, '// decoy, not the patched archive\n', 'utf-8');
process.chdir(decoyDir);
const decoySeen = host.resolveAsarPathDetailed();
check('the walk finds a decoy below cwd when nothing better exists', decoySeen.file === decoy, String(decoySeen.file));
fs.writeFileSync(host.POINTER_FILE, `${JSON.stringify({ asar: pointed }, null, 2)}\n`, 'utf-8');
const pointerBeatsWalk = host.resolveAsarPathDetailed();
check(
  'the pointer outranks the walk-up',
  pointerBeatsWalk.file === pointed,
  `${pointerBeatsWalk.file} (pointer said ${pointed})`
);
process.chdir(restoreCwd);

fs.rmSync(sandboxHome, { recursive: true, force: true });

console.log('');
if (failures === 0) {
  console.log('all checks passed');
} else {
  console.log(`${failures} check(s) failed`);
  process.exitCode = 1;
}
