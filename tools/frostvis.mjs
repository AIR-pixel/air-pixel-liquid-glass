/**
 * Does the 磨砂模糊 slider do anything to the MAIN PANE, or only to floats?
 *
 * THE REPORT, VERBATIM. air: "在设置界面拉到最高和拉到最低，背景会有变化，但是
 * 回到主界面时啥变化都没有". That is not "the slider is broken" — it is a claim
 * that the same control behaves differently on two surfaces, and it points at a
 * specific mechanism: the settings panel is a FLOAT (`role="dialog"`), which
 * sits above the main pane with the app's own content behind it. The main pane
 * is a pane, and pane-level `backdrop-filter` blurs whatever the theme painted
 * behind it — which at low intensity is its own gradient, and a smooth gradient
 * blurred is the same gradient. No structure behind, no visible blur.
 *
 * WHY THE PREVIOUS VERSION OF THIS FILE MEASURED NOTHING. It had no structure
 * behind the pane at all. It rendered the theme over an empty body, so the
 * pane's backdrop was flat, and flat blurred is flat: both readings came back
 * byte-identical and the instrument could not have come back negative. This
 * version puts a real desktop stand-in under everything, borrowed wholesale from
 * deskcheck.mjs, whose whole design is "a filter is only visible against
 * structure".
 *
 * THE CLAIM, AND BOTH WAYS IT CAN DIE.
 *   · the pane DOES respond to frost  → the slider works, and air's report is
 *     about the backdrop being featureless rather than about the control;
 *   · the pane does NOT respond        → the slider is genuinely inert on
 *     panes, and something in the pane path (selector, cascade, or the
 *     `backdrop-filter` being lost to a later rule) is at fault.
 * Both are refutations of a different suspicion, so the tool reports which one
 * it found instead of a pass/fail.
 *
 *   node tools/frostvis.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  HERE,
  OUT,
  DEFAULT_CONFIG,
  MOCK_CTX,
  browser,
  loader,
  BOOT,
  pageHead,
  APP_SHELL,
  APP_SHELL_CSS,
  clientSrc,
  dumpDomWithShot
} from './harness.mjs';

const PYTHON = process.env.DSL_PYTHON ?? 'python';
const PIXSTAT = path.join(HERE, 'pixstat.py');
const DIR = path.join(OUT, 'frostvis');

// The desktop stand-in is lifted out of deskcheck.mjs rather than re-invented:
// its shapes and fine grid are the only thing in this directory built to answer
// "is a filter visible against this?", and the answer for a flat field is always
// no — which is exactly the mistake this file made in its first two versions.
const DESK = fs.readFileSync(path.join(HERE, 'deskcheck.mjs'), 'utf8');
const DESKTOP_SVG = (() => {
  const m = DESK.match(/^const DESKTOP_SVG = `([\s\S]*?)`;$/m);
  return m === null ? null : m[1];
})();
if (DESKTOP_SVG === null) {
  console.log('could not lift the desktop stand-in out of deskcheck.mjs');
  process.exit(2);
}
const DESKTOP_URL = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(DESKTOP_SVG)}`;

/**
 * The stand-in desktop, and nothing else.
 *
 * `z-index: -3` puts it below the theme's own backdrop layer, which is what
 * makes the measurement about the theme rather than about this element. It has
 * to be carefully ordered: above html's canvas, below the wallpaper, below the
 * shell. deskcheck already worked this ordering out and it is copied, not
 * re-derived.
 */
const STAND_IN_CSS = `
#mock-desktop {
  position: fixed; inset: 0; z-index: -3; pointer-events: none;
  background-image: url("${DESKTOP_URL}");
  background-size: cover; background-position: center;
}
`;

function writePage(name, config) {
  const dir = path.join(DIR, name);
  fs.mkdirSync(dir, { recursive: true });
  const page = path.join(dir, 'index.html');
  const cfg = { ...DEFAULT_CONFIG, ...config, material: 'patched' };
  const html = `<!DOCTYPE html>
<html data-platform="win32">
${pageHead()}
<style>${APP_SHELL_CSS}${STAND_IN_CSS}</style>
</head>
<body data-ds-dark-theme="">
<div id="mock-desktop" aria-hidden="true"></div>
${APP_SHELL}
<script>${loader(cfg)}</script>
<script>${MOCK_CTX}</script>
<script src="${clientSrc(dir)}"></script>
<script>${BOOT}</script>
</body>
</html>`;
  fs.writeFileSync(page, html, 'utf8');
  return page;
}

/**
 * Two boxes, because the whole question is whether the two surfaces differ.
 *
 * The coordinates come from deskcheck's own shell layout: the sidebar strip on
 * the left, the main pane filling the rest. Reading both means a run can say
 * "the pane moved and the sidebar did not" — which is a different finding from
 * "neither moved" and from "both moved", and all three are possible.
 */
const BOXES = {
  pane: '420,140,1180,700',
  sidebar: '40,140,240,700'
};

function measure(page, png, box) {
  dumpDomWithShot(page, png);
  try {
    const out = execFileSync(PYTHON, [PIXSTAT, png, '--box', box], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    });
    return JSON.parse(out.trim().split('\n').pop());
  } catch (error) {
    return { error: String(error.message).split('\n')[0] };
  }
}

const CASES = [];
for (const intensity of [0.8, 2]) {
  for (const frost of [0, 40]) {
    CASES.push({ name: `i${intensity}-frost${frost}`, config: { intensity, frost, desktop: true, surface: true } });
  }
}

fs.rmSync(DIR, { recursive: true, force: true });
if (browser === null) {
  console.log('no headless browser found — cannot measure');
  process.exit(2);
}

const rows = [];
for (const c of CASES) {
  const page = writePage(c.name, c.config);
  const entry = { name: c.name, intensity: c.config.intensity, frost: c.config.frost };
  for (const [surface, box] of Object.entries(BOXES)) {
    const png = path.join(DIR, `${c.name}-${surface}.png`);
    entry[surface] = measure(page, png, box);
  }
  rows.push(entry);
  const fmt = (px) => (typeof px.unique === 'number' ? `unique=${px.unique} spread=${px.spread}` : px.error);
  console.log(
    `${c.name.padEnd(14)} pane: ${fmt(entry.pane).padEnd(30)} sidebar: ${fmt(entry.sidebar)}`
  );
}

const at = (intensity, frost, surface) =>
  rows.find((r) => r.intensity === intensity && r.frost === frost)?.[surface] ?? null;

/**
 * "Moved" means the blur took effect, and `unique` is the reading that shows it:
 * a blur averages neighbours, so distinct colours collapse toward each other and
 * the count falls. The threshold is a 10% drop — well above render noise, which
 * was measured at zero across byte-identical frames in the earlier runs.
 */
function moved(a, b) {
  if (!a || !b || typeof a.unique !== 'number' || typeof b.unique !== 'number') return null;
  return b.unique < a.unique * 0.9;
}

console.log('');
let anyFindings = false;
for (const intensity of [0.8, 2]) {
  const paneMoved = moved(at(intensity, 0, 'pane'), at(intensity, 40, 'pane'));
  const sideMoved = moved(at(intensity, 0, 'sidebar'), at(intensity, 40, 'sidebar'));
  const label = `intensity ${intensity}`;
  if (paneMoved === null || sideMoved === null) {
    console.log(`${label}: UNREADABLE — one of the frames did not yield a colour count`);
    continue;
  }
  if (paneMoved) {
    anyFindings = true;
    console.log(`${label}: the PANE responds to frost. The slider is not inert here.`);
  } else if (sideMoved) {
    console.log(`${label}: only the sidebar moved — panes and sidebars differ.`);
  } else {
    console.log(`${label}: neither surface responds to frost.`);
  }
}

console.log('');
if (!anyFindings) {
  console.log('NO SURFACE MOVED — the slider is inert on the app shell at both');
  console.log('  intensities, against a desktop stand-in built to make a blur');
  console.log('  visible. That is a defect in the pane path, not a featureless');
  console.log('  backdrop: fix the CSS, not the copy.');
} else {
  console.log('THE SLIDER WORKS on the shell. Where it looks dead, the question');
  console.log('  is what is behind the surface — a smooth gradient blurred is the');
  console.log('  same gradient. See the frames to check which case each row is.');
}
console.log(`\nframes -> ${DIR}`);
