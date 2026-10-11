/**
 * Settings-panel specimen — the one surface with no picture.
 *
 *   node tools/panellab.mjs
 *
 * Why this exists. The ripple, the wallpaper, the cursor and the desktop
 * material all have a tool that renders them and a number that judges them.
 * The settings panel had neither, and it is where both reported problems
 * actually happened:
 *
 *   · "我这边只有鼠标指针生效了" — the switches were on and one of them worked.
 *   · "为何客户端的完全透明不生效" — the switch was on, the config said so, the
 *     theme correctly refused, and the only feedback was an 11px badge.
 *
 * `verify.mjs` now renders the panel through a stub React and asserts what it
 * says, which catches a wrong dictionary key. It cannot see layout: a hint that
 * wraps to five lines, a notice that overlaps the next row, a badge that pushes
 * the toggle off the card. Those need pixels.
 *
 * Each state is its own frame inside one composite page, so the whole set costs
 * two browser launches — one to measure how tall each panel actually is, one to
 * shoot at that height. Height is measured rather than guessed for the reason
 * `ladder.mjs` learned the hard way: a short screenshot looks exactly like a
 * short page, and nobody notices the missing half.
 */
import fs from 'node:fs';
import path from 'node:path';

import {
  OUT,
  DEFAULT_CONFIG,
  browser,
  pageHead,
  clientSrc,
  shoot,
  dumpDom,
  readPre
} from './harness.mjs';

const DIR = path.join(OUT, 'panel');
const FRAMES = path.join(DIR, 'frames');
fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(FRAMES, { recursive: true });

const CELL_W = 660;
const COLS = 3;
const GAP = 10;

/**
 * The eight states a user can be looking at.
 *
 * `material` rides in the host payload, which is how the real plugin learns it:
 * `index.js` scans `app.asar` for the patch marker and returns the answer
 * alongside the config. So driving it here is driving the real path, not a
 * special case added for the picture.
 */
export const STATES = [
  {
    id: 'off',
    label: '① 主题总开关关闭',
    material: 'stock',
    config: { enabled: false },
    expect: 'no notice',
    expectBlur: 'patchMissing',
    expectBlurOn: false
  },
  {
    id: 'quiet',
    label: '② 正常状态（未动透出桌面）',
    material: 'stock',
    config: {},
    expect: 'no notice',
    expectBlur: 'patchMissing',
    expectBlurOn: false
  },
  {
    id: 'patched',
    label: '③ 透出桌面开 + 已打补丁',
    material: 'patched',
    config: { desktop: true, intensity: 2 },
    expect: 'no notice',
    expectBlur: 'blurIdle',
    expectBlurOn: false
  },
  {
    id: 'stock',
    label: '④ 透出桌面开 + 未打补丁（air 遇到的那个）',
    material: 'stock',
    config: { desktop: true, intensity: 2 },
    expect: 'notice / stock wording',
    expectBlur: 'patchMissing',
    expectBlurOn: false
  },
  {
    id: 'unknown',
    label: '⑤ 透出桌面开 + 无法检测客户端（候选全落空）',
    material: 'unknown',
    materialWhy: 'no-candidate-found',
    materialPath: null,
    materialScanError: null,
    config: { desktop: true, intensity: 2 },
    expect: 'notice / unknown wording + host diagnosis',
    expectBlur: 'patchUnknown',
    expectBlurOn: false
  },
  {
    id: 'unreadable',
    label: '⑥ 透出桌面开 + 归档在但打不开（air 第二轮遇到的那个）',
    material: 'unknown',
    materialWhy: 'scan-failed',
    materialPath: 'C:\\Users\\air\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\app.asar',
    // The shape that has no obvious cause from outside: the path is right and
    // the file is there, and the open refuses anyway. Rendered from the same
    // fields the host fills, so the picture answers "does the diagnosis fit in
    // the card" instead of only "does the notice exist".
    materialScanError: [{ via: 'noAsar', code: 'ENOENT', syscall: 'open' }],
    config: { desktop: true, intensity: 2 },
    expect: 'notice / unknown wording + host diagnosis',
    expectBlur: 'patchUnknown',
    expectBlurOn: false
  },
  {
    id: 'tuned',
    label: '⑦ 拉满 + 模糊固定在 18px + 内容底板开 + 窗口模糊生效',
    material: 'patched',
    // Every control this theme owns, all in their non-default form at once: the
    // shell is as open as it goes, the frost has been taken off the slider and
    // pinned, the per-message plate is in force, and the compositor is blurring
    // the desktop behind the window. It is the only state in this grid where the
    // new rows are anything other than inert, and inert is exactly what a panel
    // looks like when a control has been wired to nothing.
    config: { desktop: true, intensity: 2, frost: 18, plate: true, plateLevel: 0.5, windowBlur: true },
    windowBlurReport: { active: true, why: null, material: 'acrylic' },
    expect: 'no notice / 窗口模糊 已生效',
    expectBlur: 'blurOn',
    expectBlurOn: true
  },
  {
    id: 'blurinert',
    label: '⑧ 窗口模糊开着但没生效（宿主说不上去）',
    material: 'patched',
    // The one state whose *notice* is new this round, and the reason it needs a
    // frame: it is the only failure that has no visible cause from inside the
    // renderer, so the paragraph below the row is the entire diagnosis. Whether
    // that paragraph fits the card, and whether the badge above it stops the
    // user from having to read it to know something is wrong, are both layout
    // questions — a stub tree cannot answer either.
    config: { desktop: true, intensity: 2, windowBlur: true },
    windowBlurReport: { active: false, why: 'material-not-applied', material: 'none' },
    expect: 'notice / 窗口模糊 未生效 + 宿主自报',
    expectBlur: 'blurOff',
    expectBlurOn: true
  }
];

// ---------------------------------------------------------------------------
// The browser half
// ---------------------------------------------------------------------------

/**
 * A React small enough to render a static panel, and honest about it.
 *
 * `harness.mjs` ships `__reactStub` with `createElement: () => null`, which is
 * right for tools that only want the stylesheet and useless for this one. This
 * is not a React reimplementation and does not pretend to be: hooks return their
 * initial value and effects never run, which is exactly the panel's situation
 * when `useConfig` reads the module-scope config during render.
 *
 * `React.createElement` must be reachable as the plugin's `h`, `React.Fragment`
 * must be a non-function sentinel so the renderer treats it as a fragment, and
 * `useReducer`/`useEffect`/`useCallback` must exist because `client.js`
 * destructures them.
 */
const REACT = `
window.__react = (function () {
  var FRAGMENT = { fragment: true };
  return {
    Fragment: FRAGMENT,
    createElement: function (type, props) {
      var children = Array.prototype.slice.call(arguments, 2);
      return { type: type, props: props || {}, children: children };
    },
    useReducer: function (_reducer, initial) { return [initial, function () {}]; },
    useState: function (initial) { return [initial, function () {}]; },
    useEffect: function () {},
    useCallback: function (fn) { return fn; }
  };
})();
`;

/**
 * A context that KEEPS the component, unlike the harness one.
 *
 * `harness.mjs`'s `slots.register` pushes `def.name` and drops the component,
 * because every other tool only wants `apply()`'s side effects on the
 * stylesheet. A panel picture needs the function itself.
 */
const PANEL_CTX = `
window.__panelCtx = (function () {
  var state = { effects: [], registered: [], components: [], injected: [], dicts: null };
  return {
    state: state,
    effect: function (fn) {
      var dispose = fn();
      state.effects.push({ dispose: dispose });
      return function () { if (typeof dispose === 'function') dispose(); };
    },
    locale: {
      register: function (ns, dicts) { state.dicts = dicts; return function () {}; },
      bind: function () { return function (k) { return k; }; }
    },
    slots: {
      inject: function (name, cb) { state.injected.push(name); cb(); },
      register: function (def, component) {
        state.registered.push(def);
        state.components.push(component);
        return function () {};
      }
    }
  };
})();
`;

/** Render an element tree with the minimal React above. */
const RENDERER = `
window.__render = (function () {
  function walk(node, into) {
    if (node === null || node === undefined || node === false || node === true) return;
    if (Array.isArray(node)) { for (var i = 0; i < node.length; i++) walk(node[i], into); return; }
    if (typeof node !== 'object') { into.appendChild(document.createTextNode(String(node))); return; }
    var type = node.type;
    if (type !== null && typeof type === 'object' && type.fragment) {
      for (var j = 0; j < (node.children || []).length; j++) walk(node.children[j], into);
      return;
    }
    if (typeof type === 'function') {
      var props = {};
      for (var k in node.props) props[k] = node.props[k];
      props.children = node.children;
      walk(type(props), into);
      return;
    }
    var el = document.createElement(type);
    var p = node.props || {};
    for (var a in p) {
      if (a === 'children' || a === 'key') continue;
      var val = p[a];
      if (a === 'className') { el.className = val; continue; }
      if (a === 'style' && val !== null && typeof val === 'object') {
        for (var s in val) el.style[s] = val[s];
        continue;
      }
      if (a.slice(0, 2) === 'on' && typeof val === 'function') {
        el.addEventListener(a.slice(2).toLowerCase(), val);
        continue;
      }
      if (val === false || val === null || val === undefined) continue;
      if (val === true) { el.setAttribute(a, ''); continue; }
      el.setAttribute(a, String(val));
    }
    for (var c = 0; c < (node.children || []).length; c++) walk(node.children[c], el);
    into.appendChild(el);
  }
  return walk;
})();
`;

/** Boot the plugin, then mount the registered panel. */
function renderScript() {
  return `
(function () {
  var mod = window.__dshPlugin.factory(function (name) {
    if (name === 'react') return window.__react;
    if (name === 'react/jsx-runtime') {
      return {
        jsx: function (t, p) { return window.__react.createElement(t, p); },
        jsxs: function (t, p) { return window.__react.createElement(t, p); },
        Fragment: window.__react.Fragment
      };
    }
    throw new Error('unexpected require: ' + name);
  });
  // apply() is not optional: loadFromHost() lives at the bottom of it, and
  // without it the material stays whatever the (absent) localStorage mirror said.
  mod.apply(window.__panelCtx);

  window.addEventListener('load', function () {
    // Deferred: loadFromHost() is a promise, so the module-scope config is not
    // the host's answer yet at the moment apply() returns.
    setTimeout(function () {
      var st = window.__panelCtx.state;
      var index = -1;
      for (var i = 0; i < st.registered.length; i++) {
        if (st.registered[i].name === 'dsh.liquid-glass.item') index = i;
      }
      var report = {
        registered: st.registered.map(function (d) { return d.name; }),
        panelFound: index >= 0,
        notice: 0,
        badge: '',
        blurBadge: '',
        words: null,
        blurToggleOn: null,
        title: '',
        remedy: '',
        blurWhyLines: 0,
        // Structural probes. A flat tree still contains every element and still
        // produces a picture of something — it just is not the panel. The first
        // version of this renderer appended each child to its GRANDPARENT, so
        // the notice title became a sibling of the notice and every
        // querySelector behind it returned null while the shot looked fine.
        // These two numbers are what make that impossible to miss.
        cardRows: 0,
        noticeInCard: false,
        whyLines: -1,
        whyDetails: 0,
        whyText: '',
        height: 0
      };
      if (index >= 0) {
        var dicts = st.dicts || {};
        var dict = dicts.zh || {};
        var t = function (key) { return dict[key] === undefined ? key : dict[key]; };
        var host = document.getElementById('host');
        window.__render(st.components[index]({ t: t }), host);
        report.notice = host.querySelectorAll('.dsl-notice').length;
        report.cardRows = host.querySelectorAll('.dsl-card > .dsl-row').length;
        var card = host.querySelector('.dsl-card');
        // Two notices can exist now and they carry different shapes: the 透出桌面
        // one has the command that fixes it, the 窗口模糊 one has the host's
        // reason code. Classified by title rather than by order, so the counters
        // below cannot quietly start measuring the wrong one — a why-line count
        // taken from whichever notice happened to be first would go on passing
        // while reporting the other notice's diagnosis.
        var desktopNotice = null;
        var blurNotice = null;
        var allNotices = host.querySelectorAll('.dsl-notice');
        for (var q = 0; q < allNotices.length; q++) {
          var ti0 = allNotices[q].querySelector('.dsl-notice-title');
          var ti0Text = ti0 === null ? '' : ti0.textContent;
          if (ti0Text === dict.patchNoticeTitle) desktopNotice = allNotices[q];
          else if (ti0Text === dict.windowBlurNoticeTitle) blurNotice = allNotices[q];
        }
        var noticeEl = desktopNotice !== null ? desktopNotice : blurNotice;
        report.noticeInCard =
          card !== null && noticeEl !== null && noticeEl.parentElement === card;
        // Reached by the row's own label rather than by index. Index 1 used to
        // be the 透出桌面 badge because that row carried the only badge in the
        // panel; 窗口模糊 now sits above it and took that slot, so an index
        // probe would have gone on passing while quietly reporting a different
        // row's words — which is worse than failing, because the report still
        // looks right.
        var rowBadge = function (label) {
          var rows = host.querySelectorAll('.dsl-card > .dsl-row');
          for (var r = 0; r < rows.length; r++) {
            var title = rows[r].querySelector('.dsl-row-title');
            if (title !== null && title.textContent === label) {
              var badge = rows[r].querySelector('.dsl-status');
              return badge === null ? '(MISSING)' : badge.textContent;
            }
          }
          return '(NOROW)';
        };
        report.badge = rowBadge(dict.desktopLabel);
        report.blurBadge = rowBadge(dict.windowBlurLabel);
        // The words themselves, sent back so the Node half can compare against
        // them instead of spelling Chinese copy out a second time. Copy that is
        // duplicated in a test is copy that drifts, and the drift is invisible:
        // the check keeps passing against the old string while the panel says
        // something else.
        report.words = {
          patchReady: dict.patchReady,
          patchMissing: dict.patchMissing,
          patchUnknown: dict.patchUnknown,
          blurIdle: dict.windowBlurIdle,
          blurOn: dict.windowBlurOn,
          blurOff: dict.windowBlurOff,
          blurNeedsDesktop: dict.windowBlurNeedsDesktop
        };
        report.blurToggleOn = (function () {
          var sw = host.querySelectorAll('.dsl-switch');
          for (var j = 0; j < sw.length; j++) {
            if (sw[j].getAttribute('aria-label') === dict.windowBlurLabel) {
              return sw[j].getAttribute('aria-checked') === 'true';
            }
          }
          return null;
        })();
        report.desktopToggleDisabled = (function () {
          var sw = host.querySelectorAll('.dsl-switch');
          for (var j = 0; j < sw.length; j++) {
            if (sw[j].getAttribute('aria-label') === dict.desktopLabel) {
              return sw[j].disabled === true;
            }
          }
          return null;
        })();
        if (noticeEl !== null) {
          var ti = noticeEl.querySelector('.dsl-notice-title');
          var ho = noticeEl.querySelector('.dsl-notice-how');
          report.title = ti === null ? '(MISSING)' : ti.textContent;
          report.remedy = ho === null ? '(MISSING)' : ho.textContent;
        }
        // How many diagnosis lines each notice chose to show, counted per notice
        // rather than per card. The thing worth checking is the *decision*: a
        // patched or stock panel must show none, an unknown one must show the
        // reason the host actually gave, and the blur one must show its code. A
        // missing line is invisible in a screenshot at a glance but obvious
        // here. Zero is the correct reading for an absent notice, not an
        // unknown — left at the -1 sentinel the states without a notice all
        // reported a mismatch, which is how this probe first showed up as three
        // failures instead of zero.
        var countCodes = function (el) {
          return el === null ? 0 : el.querySelectorAll('.dsl-notice-why-code').length;
        };
        var whyTextOf = function (el) {
          if (el === null) return '';
          return Array.prototype.map
            .call(el.querySelectorAll('.dsl-notice-why'), function (n) { return n.textContent; })
            .join(' | ');
        };
        report.whyLines = countCodes(desktopNotice);
        report.whyDetails = desktopNotice === null
          ? 0
          : desktopNotice.querySelectorAll('.dsl-notice-why-detail').length;
        report.blurWhyLines = countCodes(blurNotice);
        report.whyText = [whyTextOf(desktopNotice), whyTextOf(blurNotice)]
          .filter(function (x) { return x !== ''; })
          .join(' | ');
        report.height = Math.ceil(host.getBoundingClientRect().height);
      }
      var pre = document.createElement('pre');
      pre.id = 'out';
      pre.style.display = 'none';
      pre.textContent = JSON.stringify(report);
      document.body.appendChild(pre);
      document.body.setAttribute('data-ready', 'true');
      document.body.setAttribute('data-height', String(report.height));
    }, 700);
  });
})();
`;
}

const FRAME_CSS = `
* { box-sizing: border-box; }
html, body { margin: 0; background: var(--dsw-alias-bg-base); }
body {
  font: 13px/1.5 var(--dsw-font-family, system-ui, sans-serif);
  color: var(--dsw-alias-label-primary);
  padding: 18px 18px 22px;
}
.cap {
  font-size: 11px; line-height: 1.5; color: var(--dsw-alias-label-tertiary);
  padding-bottom: 12px;
}
#host { max-width: 760px; }
`;

const GENERATED_CSS = `
html, body { margin: 0; padding: 0; background: #2b313c; }
.wrap { display: grid; gap: ${GAP}px; padding: ${GAP}px; }
.cell { background: #2b313c; }
.tag {
  font: 11px/1.6 system-ui, sans-serif; color: #aab;
  padding: 0 0 5px 2px;
}
iframe { display: block; border: 1px solid #3a4150; background: #fff; }
#out { display: none; }
`;

function frame(state) {
  return `<!DOCTYPE html>
<html data-platform="win32">
${pageHead()}
<style>${FRAME_CSS}</style>
</head>
<body>
<div class="cap">${state.label}　·　期望：${state.expect}</div>
<div id="host"></div>
<script>window.__ModuleLoader__ = { load: function (def) { window.__dshPlugin = def; } };</script>
<script>${REACT}</script>
<script>${PANEL_CTX}</script>
<script>${RENDERER}</script>
<script>
(function () {
  var CFG = ${JSON.stringify({
    ...DEFAULT_CONFIG,
    ...state.config,
    material: state.material,
    // Passed through verbatim, including when undefined: the real host omits
    // them for the states that are already self-explanatory, and the panel must
    // not render a diagnosis line in those cases.
    ...(state.materialWhy === undefined ? {} : { materialWhy: state.materialWhy }),
    ...(state.materialPath === undefined ? {} : { materialPath: state.materialPath }),
    ...(state.materialScanError === undefined ? {} : { materialScanError: state.materialScanError }),
    // The blur readback rides on the same response under its own key. The frame
    // goes through `loadFromHost`, so this is the real path — and the key name
    // matters: the response is the config spread with these fields on top, so a
    // report filed under `windowBlur` would overwrite the boolean and the switch
    // would come up off in every one of these frames.
    ...(state.windowBlurReport === undefined ? {} : { windowBlurReport: state.windowBlurReport })
  })};
  window.fetch = function () {
    return Promise.resolve({
      ok: true,
      status: 200,
      headers: { get: function () { return 'application/json'; } },
      json: function () { return Promise.resolve(CFG); },
      text: function () { return Promise.resolve(JSON.stringify(CFG)); }
    });
  };
})();
</script>
<script src="${clientSrc(FRAMES)}"></script>
<script>${renderScript()}</script>
</body></html>`;
}

function composite(cellHeight) {
  const cells = STATES.map(
    (s) => `<div class="cell"><div class="tag">${s.id}</div>` +
      `<iframe src="frames/${s.id}.html" width="${CELL_W}" height="${cellHeight}"></iframe></div>`
  ).join('\n');
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>${GENERATED_CSS}
.wrap { grid-template-columns: repeat(${COLS}, ${CELL_W}px); }
</style></head><body>
<div class="wrap">${cells}</div>
<pre id="out">pending</pre>
<script>
window.addEventListener('load', function () {
  setTimeout(function () {
    var rows = [];
    var frames = document.querySelectorAll('iframe');
    for (var i = 0; i < frames.length; i++) {
      try {
        var d = frames[i].contentDocument;
        var pre = d.getElementById('out');
        rows.push(pre === null ? 'PENDING' : pre.textContent);
      } catch (e) {
        rows.push('READ_ERROR:' + e.message);
      }
    }
    var pre2 = document.createElement('pre');
    pre2.id = 'out';
    pre2.textContent = rows.join('\\n');
    document.getElementById('out').replaceWith(pre2);
  }, 2500);
});
</script>
</body></html>`;
}

// ---------------------------------------------------------------------------
// Node half
// ---------------------------------------------------------------------------

if (browser === null) {
  console.log('no browser found');
  process.exit(0);
}

for (const state of STATES) {
  fs.writeFileSync(path.join(FRAMES, `${state.id}.html`), frame(state), 'utf8');
}

// Pass 1: measure. The panels have different heights — the notice is three
// lines of text — and a fixed height would silently crop whichever one is
// tallest, which is the bug ladder.mjs already paid for once.
const probe = path.join(DIR, 'index.html');
fs.writeFileSync(probe, composite(600), 'utf8');
const raw = readPre(dumpDom(probe, { width: 2020, height: 900, budget: 12000 }));

console.log('panel states');
let tallest = 0;
let wrong = 0;
const reports = [];
for (const line of raw.split('\n')) {
  if (!line.trim().startsWith('{')) continue;
  try {
    reports.push(JSON.parse(line));
  } catch (error) {
    /* a frame that printed something else; handled as missing below */
  }
}
// The panel has exactly these rows. A renderer that hoists children one level
// still draws something; it just stops being this panel.
// Was 7 until 涟漪大小 was split out of 效果强度, then 8, and 12 once 磨砂模糊
// and 内容底板 arrived — each pair of rows is a control that used to be a
// consequence of another control rather than a question of its own. The count
// moving up is the point of those changes, not an incidental side effect to be
// absorbed by loosening the assertion.
//
// 13 is 窗口模糊, the third control in this card that acts on something outside
// the window. It carries a switch and no slider, so the row count is the only
// probe here that would notice it rendered empty — the slider assertions in
// verify.mjs count 4 and stay at 4 through this change.
const EXPECTED_ROWS = 13;

for (let i = 0; i < STATES.length; i += 1) {
  const state = STATES[i];
  const report = reports[i];
  const problems = [];
  if (report === undefined) {
    problems.push('frame never reported — the page did not finish booting');
  } else if (!report.panelFound) {
    problems.push(`panel not registered (saw: ${report.registered.join(', ') || 'none'})`);
  } else {
    if (report.cardRows !== EXPECTED_ROWS) {
      problems.push(`cardRows=${report.cardRows}, expected ${EXPECTED_ROWS} — the element tree is not the panel's`);
    }
    if (report.badge === '(MISSING)') problems.push('the 透出桌面 badge is missing');
    const wantNotice = state.expect.startsWith('notice') ? 1 : 0;
    if (report.notice !== wantNotice) problems.push(`notice=${report.notice}, expected ${wantNotice}`);
    if (wantNotice === 1) {
      if (report.noticeInCard !== true) problems.push('the notice is not a child of the card');
      if (report.title === '' || report.title === '(MISSING)') problems.push('the notice has no title');
      // Two notices live in this panel now and each is complete in its own way:
      // the 透出桌面 one carries the command that fixes it, and the 窗口模糊 one
      // carries the host's own reason code, because there is no command to give
      // for a compositor that said no. What neither may be is a title with
      // nothing under it — "something went wrong" and no further word is the
      // dead end both of them exist to replace.
      if (report.remedy === '' || report.remedy === '(MISSING)') {
        if (!(report.whyLines >= 1 || report.blurWhyLines >= 1)) {
          problems.push('the notice has neither a remedy nor a host reason');
        }
      }
    }
    // 窗口模糊 is read back, so its row has to agree with what the host said in
    // the same response the config came in on. The badge is what tells a user
    // whether the switch they just flipped did anything, and the switch's own
    // state is the request — comparing them here is the only place a panel that
    // drew the wrong one can be caught without a screenshot.
    const wantBlur = (report.words ?? {})[state.expectBlur];
    if (wantBlur === undefined) {
      problems.push(`the blur badge dictionary is missing ${state.expectBlur}`);
    } else if (report.blurBadge !== wantBlur) {
      problems.push(`blurBadge=${JSON.stringify(report.blurBadge)}, expected ${JSON.stringify(wantBlur)}`);
    }
    if (report.blurToggleOn !== state.expectBlurOn) {
      problems.push(`blurToggleOn=${report.blurToggleOn}, expected ${state.expectBlurOn}`);
    }
    // The blur notice carries the host's reason code or nothing at all, and
    // which one it is has to follow the response rather than the state's mood:
    // a code that got dropped on the way to the card is invisible in a
    // screenshot and is the entire reason that notice is worth rendering.
    const wantBlurWhy =
      state.windowBlurReport === undefined || state.windowBlurReport.why === null ? 0 : 1;
    if (report.blurWhyLines !== wantBlurWhy) {
      problems.push(`blurWhyLines=${report.blurWhyLines}, expected ${wantBlurWhy}`);
    }
    // The diagnosis is shown only when the host had something to say, and the
    // host says nothing for the states that explain themselves. So a stock panel
    // must be silent, and an unknown one must not be — a notice that quietly
    // dropped the reason is the exact defect this whole mechanism exists to fix.
    const wantWhyLines = state.materialWhy === undefined ? 0 : 1;
    if (report.whyLines !== wantWhyLines) {
      problems.push(`whyLines=${report.whyLines}, expected ${wantWhyLines}`);
    }
    // …and each fact the host supplied has to reach the panel. Counting them
    // here is what stops a rendering branch from silently dropping the errno
    // while still printing the reason code.
    const wantDetails =
      (state.materialPath === null || state.materialPath === undefined ? 0 : 1) +
      (state.materialScanError === null || state.materialScanError === undefined ? 0 : 1);
    if (report.whyDetails !== wantDetails) {
      problems.push(`whyDetails=${report.whyDetails}, expected ${wantDetails}`);
    }
    if (state.materialScanError !== undefined && /ENOENT/.test(JSON.stringify(state.materialScanError))) {
      if (!report.whyText.includes('ENOENT')) {
        problems.push('the errno the host reported is not on screen');
      }
    }
    if (state.id === 'off' && report.desktopToggleDisabled !== true) {
      problems.push('the desktop switch should be disabled while the theme is off');
    }
    if (state.id === 'stock' || state.id === 'unknown' || state.id === 'unreadable') {
      if (report.desktopToggleDisabled === true) problems.push('the switch must stay operable while unpatched');
    }
  }

  if (problems.length > 0) {
    wrong += 1;
    console.log(`  [??] ${state.id.padEnd(9)} ${problems.join('; ')}`);
    continue;
  }
  tallest = Math.max(tallest, report.height);
  console.log(
    `  [ok] ${state.id.padEnd(9)} notice=${report.notice} rows=${report.cardRows} ` +
      `badge=${JSON.stringify(report.badge)} blur=${JSON.stringify(report.blurBadge)} ` +
      `blurOn=${report.blurToggleOn} desktopDisabled=${report.desktopToggleDisabled} height=${report.height}`
  );
  if (report.title !== '') console.log(`       title:  ${report.title}`);
  if (report.remedy !== '') console.log(`       remedy: ${report.remedy}`);
}

if (wrong > 0) console.log(`\n${wrong} state(s) did not render as the panel`);

if (tallest === 0) {
  console.log('\nthe panels never reported a height; refusing to shoot blind');
  process.exitCode = 1;
} else {
  // +26 for the caption above each frame and the 1px frame border.
  const cellHeight = tallest + 26;
  const rows = Math.ceil(STATES.length / COLS);
  const width = GAP * 2 + COLS * CELL_W + (COLS - 1) * GAP;
  const height = GAP * 2 + rows * (cellHeight + 22) + (rows - 1) * GAP;

  fs.writeFileSync(probe, composite(cellHeight), 'utf8');
  const png = path.join(OUT, 'panel.png');
  const ok = shoot(probe, png, { width, height, scale: 2, budget: 12000 });
  console.log('');
  console.log(ok ? `panel: ${png}  (${width}x${height} css, x2)` : 'shoot failed');
  process.exitCode = ok && wrong === 0 ? 0 : 1;
}
