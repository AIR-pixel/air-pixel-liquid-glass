/**
 * Cascade + paint proof, in a real browser, against the REAL official sheet.
 *
 * This is the test that would have caught the wallpaper bug, and it is worth
 * being explicit about why nothing else did.
 *
 * The offline suite (verify.mjs) inspects the CSS *text* the plugin generates.
 * The text said `background-image: <four radial gradients>` and it was right.
 * What the text could not say is that the Harness' own stylesheet contains
 *
 *     body { background: var(--dsw-alias-bg-base, #fff) }
 *
 * and that a background shorthand resets background-image. The generated text
 * was correct and the rendered result had no wallpaper at all, for an entire
 * round, while every mock page agreed the theme was fine — because no mock page
 * loaded the sheet the plugin is actually competing with.
 *
 * So this tool does the two things the mock could not:
 *   1. loads the real 76KB bundled stylesheet from the shipped frontend, and
 *   2. measures PIXELS, not declarations.
 *
 * Pixel measurement is the part that matters. A declaration can be present,
 * correct, and lose the cascade; only looking at the composited output proves
 * the wallpaper reaches the screen. Run with:
 *
 *     node tools/cascade.mjs            # assert + print a table
 *     node tools/cascade.mjs --keep     # keep the PNGs for eyeballing
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  HERE,
  OUT,
  DEFAULT_CONFIG,
  MOCK_CTX,
  browser,
  loader,
  BOOT,
  SCRAPE_THEME,
  pageHead,
  bodyTag,
  clientSrc,
  dumpDomWithShot,
  readPre
} from './harness.mjs';

const PYTHON = 'C:\\Users\\air\\.workbuddy\\binaries\\python\\envs\\default\\Scripts\\python.exe';
const PIXSTAT = path.join(HERE, 'pixstat.py');
const DIR = path.join(OUT, 'cascade');

let failures = 0;
function check(label, condition, detail) {
  const tag = condition ? 'ok  ' : 'FAIL';
  if (!condition) failures += 1;
  console.log(`  [${tag}] ${label}${detail === undefined ? '' : `  -> ${detail}`}`);
}

function rmrf(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * A stand-in shell that consumes the same tokens the real one does.
 *
 * Every surface here is painted with a token rather than with a literal, which
 * is the whole point: if the plugin fails to override one of them, that region
 * shows up as an opaque block and the pixel spread collapses.
 */
const SHELL = `
<div id="shell" style="position:relative;width:100vw;height:100vh;background:var(--dsw-alias-bg-base)">
  <div style="position:absolute;left:0;top:0;bottom:0;width:260px;background:var(--dsw-specific-sidebar-fill)"></div>
  <div style="position:absolute;left:260px;right:0;top:0;height:64px;background:var(--dsw-alias-bg-layer-1)"></div>
  <div style="position:absolute;left:260px;right:0;top:64px;bottom:0;background:var(--dsw-alias-bg-layer-2)"></div>
</div>`;

function writePage(name, config) {
  const dir = path.join(DIR, name);
  fs.mkdirSync(dir, { recursive: true });
  const page = path.join(dir, 'index.html');
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const html = `<!doctype html>
<html><head><meta charset="utf-8">
${pageHead().replace(/^<head>/, '')}
<style>html,body{margin:0;padding:0;height:100%}</style>
</head>
${bodyTag({ dark: true })}
${SHELL}
<script>${loader(cfg)}</script>
<script>${MOCK_CTX}</script>
<script src="${clientSrc(dir)}"></script>
<script>${BOOT}</script>
<script>${SCRAPE_THEME}</script>
</body></html>`;
  fs.writeFileSync(page, html, 'utf8');
  return page;
}

/**
 * One browser launch for both artefacts.
 *
 * Chromium accepts `--screenshot` and `--dump-dom` together, which matters more
 * than it looks: this tool used to launch the browser twice per variant, eight
 * launches, four minutes. Halving that is the difference between a check that
 * runs on every change and one that gets skipped.
 */
function render(page, png) {
  if (browser === null) return { px: null, style: null, sha: null };
  const dom = dumpDomWithShot(page, png);
  const raw = readPre(dom);
  let style = null;
  try {
    style = raw === '' ? null : JSON.parse(raw);
  } catch {
    style = null;
  }
  let px = null;
  try {
    const out = execFileSync(PYTHON, [PIXSTAT, png, '--box', '320,80,880,580'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    });
    px = JSON.parse(out.trim().split('\n').pop());
  } catch (error) {
    console.log(`  pixstat failed: ${String(error.message).split('\n')[0]}`);
  }
  // The bytes, not the statistics. There is one claim in this file that is
  // properly stated as "nothing changed at all" — that a client without the
  // patch renders the 透出桌面 config exactly as if the switch were absent —
  // and a hash says it without a tolerance to argue about.
  let sha = null;
  try {
    sha = createHash('sha256').update(fs.readFileSync(png)).digest('hex');
  } catch {
    /* no screenshot; the caller treats null as unusable */
  }
  return { px, style, sha };
}

const alphaOf = (value) => {
  if (typeof value !== 'string') return null;
  const m = /rgba?\([^)]*?,\s*([\d.]+)\s*\)$/.exec(value.trim());
  if (m !== null) return Number(m[1]);
  return /^#[0-9a-f]{6}$/i.test(value.trim()) ? 1 : null;
};

if (browser === null) {
  console.log('no Edge/Chrome found — cascade proof skipped, and that is a failure');
  process.exitCode = 1;
} else {
  rmrf(DIR);
  const runs = {
    off: { surface: false, intensity: 1 },
    low: { intensity: 0.2 },
    mid: { intensity: 1 },
    high: { intensity: 2 },
    // 透出桌面 at full strength on a client that reports the patch. The two
    // things worth proving are both invisible in the stylesheet text: that the
    // wallpaper genuinely stops reaching the screen, and that the *only* thing
    // that changed is the reveal — `deskStock` below renders the same config on
    // a client that reports no patch, and must come out byte-identical to
    // `high` or the fail-safe is not one.
    desk: { intensity: 2, desktop: true, material: 'patched' },
    deskStock: { intensity: 2, desktop: true, material: 'stock' }
  };

  console.log('cascade + paint proof (real official stylesheet, headless Edge)');
  const results = {};
  for (const [name, cfg] of Object.entries(runs)) {
    const page = writePage(name, cfg);
    const png = path.join(DIR, `${name}.png`);
    results[name] = render(page, png);
  }

  const mid = results.mid.style;
  const off = results.off.style;
  const high = results.high.style;
  const low = results.low.style;

  // ---- the cascade itself ------------------------------------------------
  console.log('  cascade');
  check('the page actually booted the plugin', mid !== null && mid.sheetMounted === true);
  check('both schemes harvested', mid !== null && mid.scheme === 'dark');
  check(
    'body background is transparent on the real sheet',
    mid !== null && /rgba\(0,\s*0,\s*0,\s*0\)|transparent/.test(mid.bodyBgColor),
    `computed ${mid?.bodyBgColor} — the official shorthand must not paint the canvas`
  );
  check(
    'body background-image stays reset',
    mid !== null && (mid.bodyBgImage === 'none' || mid.bodyBgImage === ''),
    `computed ${mid?.bodyBgImage}`
  );

  // ---- the wallpaper element --------------------------------------------
  console.log('  wallpaper layer');
  check('wallpaper layer exists', mid !== null && mid.wallpaper !== null);
  check(
    'wallpaper survives the official shorthand',
    mid !== null && mid.wallpaper !== null && /radial-gradient/.test(mid.wallpaper.image),
    'an inline gradient on a real element: the shorthand cannot reach it'
  );
  check(
    'wallpaper is behind the shell',
    mid !== null && mid.wallpaper !== null && mid.wallpaper.position === 'fixed' && mid.wallpaper.zIndex === '-1',
    `position ${mid?.wallpaper?.position}, z-index ${mid?.wallpaper?.zIndex}`
  );
  check(
    'wallpaper layers: a vignette over two light pools over the wash',
    mid !== null &&
      (mid.wallpaper?.image.match(/radial-gradient/g) ?? []).length === 3 &&
      /linear-gradient/.test(mid.wallpaper?.image ?? ''),
    `${(mid?.wallpaper?.image.match(/radial-gradient/g) ?? []).length} radial + ` +
      `${/linear-gradient/.test(mid?.wallpaper?.image ?? '') ? 'a wash' : 'NO WASH'} — ` +
      'two unequal pools, not four: the eye counts equally-weighted things, and a ' +
      'countable number of circles is what turns a backdrop into a wallpaper'
  );

  // ---- refraction, measured in the engine --------------------------------
  console.log('  refraction');
  check(
    'this engine honours url() inside backdrop-filter',
    mid?.refract?.supportsUrl === true && mid?.refract?.supportsBlurUrl === true,
    'probed via CSS.supports, not assumed — an engine without it computes the ' +
      'whole declaration to none and says nothing'
  );
  check(
    'both displacement filters are in the document',
    mid?.refract?.edgePresent === true && mid?.refract?.dropPresent === true,
    'a url() naming a filter that is not there also computes to none, which is ' +
      'indistinguishable from "unsupported" except by looking'
  );
  check(
    'the maps are inlined as data URIs',
    /^data:image\/png/.test(mid?.refract?.mapHref ?? ''),
    `href starts "${mid?.refract?.mapHref}" — feImage pointed at a URL silently fails from a zero-sized SVG`
  );
  check(
    'a float receives the lens in its computed style',
    /url\(["']?#dsl-refract["']?\)/.test(mid?.refract?.computed ?? ''),
    `computed backdrop-filter: ${mid?.refract?.computed || '(none)'} — this is the only check ` +
      'that proves the reference survives all the way to the element rather than ' +
      'dying quietly in the cascade'
  );
  check(
    'the lens is scoped to floats, not to panes',
    /url\(["']?#dsl-refract["']?\)/.test(mid?.refract?.computed ?? '') &&
      !/url\(/.test(mid?.refract?.paneComputed ?? '') &&
      /blur/.test(mid?.refract?.paneComputed ?? ''),
    `float: ${mid?.refract?.computed || '(none)'} | pane: ${mid?.refract?.paneComputed || '(none)'} — ` +
      'panes keep the blur only: on a full-height pane the bezel would be hundreds of px wide, ' +
      'which reads as a warp rather than as thickness'
  );

  // ---- token coverage ---------------------------------------------------
  console.log('  token coverage');
  const baseMid = alphaOf(mid?.tokens['--dsw-alias-bg-base']);
  const baseHigh = alphaOf(high?.tokens['--dsw-alias-bg-base']);
  const baseLow = alphaOf(low?.tokens['--dsw-alias-bg-base']);
  const side = alphaOf(mid?.tokens['--dsw-specific-sidebar-fill']);
  check(
    'the shell backdrop is translucent',
    baseMid !== null && baseMid < 0.7 && baseMid > 0.3,
    `--dsw-alias-bg-base alpha ${baseMid}`
  );
  check(
    'the sidebar token resolves to a translucent value',
    side !== null && side < 1,
    `--dsw-specific-sidebar-fill alpha ${side} (stock is #1b1b1c, fully opaque)`
  );
  check(
    'intensity 2 opens the shell completely',
    baseHigh !== null && baseHigh <= 0.12,
    `alpha ${baseHigh}`
  );
  check(
    'intensity 0.2 is nearly the stock surface',
    baseLow !== null && baseLow >= 0.8,
    `alpha ${baseLow} — and the pixel check below is what decides whether that is close enough`
  );
  check(
    'surface off leaves the tokens untouched',
    off !== null && alphaOf(off.tokens['--dsw-alias-bg-base']) === 1,
    `alpha ${alphaOf(off?.tokens['--dsw-alias-bg-base'])} — the official #151517 shows through unchanged`
  );

  // ---- the part that actually matters: pixels ---------------------------
  console.log('  composited pixels');
  const pxOff = results.off.px;
  const pxLow = results.low.px;
  const pxMid = results.mid.px;
  const pxHigh = results.high.px;
  check('every variant rendered', pxOff !== null && pxMid !== null && pxHigh !== null);

  if (pxOff !== null && pxMid !== null && pxHigh !== null) {
    console.log(
      `        spread (max per-channel delta between region means): ` +
        `off ${pxOff.spread}, 0.2x ${pxLow.spread}, 1x ${pxMid.spread}, 2x ${pxHigh.spread}`
    );
    // The control. With no glass the shell is opaque, so the wallpaper is
    // covered and every region of the pane is the same colour.
    check(
      'control: an opaque shell really does hide the wallpaper',
      pxOff.spread <= 3,
      `spread ${pxOff.spread} — if this is not flat the control is not a control`
    );
    check(
      'the wallpaper reaches the screen',
      // Stated against the actual failure mode rather than against a number
      // that happened to hold once.
      //
      // The bug this guards against is a declaration losing the cascade, and
      // that bug is *intensity-independent*: with no wallpaper on screen every
      // variant collapses to the control's value (0 or 1). So the assertion is
      // two-part — full intensity must show real structure, and mid intensity
      // must sit strictly above the control. Both halves fail together on that
      // bug and neither fires on an honest retune.
      //
      // The absolute numbers are much smaller than they used to be, and that is
      // the point of this round: region-mean spread was previously carried
      // largely by *hue* differences between the four coloured blobs. The
      // backdrop is achromatic now, so only luminance structure is left to
      // measure. A future change that pushes this back up by re-introducing
      // colour would be a regression, not an improvement.
      pxHigh.spread >= 8 && pxMid.spread > pxOff.spread + 1,
      `spread 2x ${pxHigh.spread}, 1x ${pxMid.spread} vs control ${pxOff.spread} — a wallpaper ` +
        'that loses the cascade reads 0 or 1 at every intensity'
    );
    check(
      'max intensity paints the strongest wallpaper',
      pxHigh.spread > pxMid.spread,
      `${pxMid.spread} -> ${pxHigh.spread}`
    );
    check(
      'low intensity is close to the control',
      pxLow.spread < pxMid.spread,
      `${pxOff.spread} (off) <= ${pxLow.spread} (0.2x) < ${pxMid.spread} (1x)`
    );
  }

  // ---- 透出桌面, measured --------------------------------------------------
  //
  // Everything above asserts the theme paints something. This section asserts
  // the one thing that is supposed to *stop* painting, which is why the control
  // for it is not the flat `off` run but the full-intensity `high` run: `off` is
  // opaque because nothing was overridden, `desk` is bare because everything
  // that covered the window base was faded to nothing. Both are flat and they
  // are not the same fact, so the measurement here is the composite's own
  // luminance rather than its spread.
  //
  // The stand-in for the window backdrop is the browser's bare canvas: there is
  // no compositor behind a headless page, so "the window base is clear" shows up
  // as the page showing through instead of the theme. On air's machine that same
  // region is the desktop itself, which is the whole point of the patch asking
  // for `backgroundMaterial: "none"` rather than acrylic — the blurred material
  // is what he rejected twice. This render cannot tell the two apart, and does
  // not try to; that comparison lives in tools/materialprobe.py, which can put a
  // real window in front of a real screen.
  console.log('  desktop bleed-through');
  const desk = results.desk.style;
  const deskStock = results.deskStock.style;
  const pxDesk = results.desk.px;
  const luma = (stats) =>
    stats === null || stats?.overall === undefined
      ? null
      : Math.round(stats.overall[0] * 0.299 + stats.overall[1] * 0.587 + stats.overall[2] * 0.114);

  check(
    'an unpatched client renders it exactly as if the switch were absent',
    results.deskStock.sha !== null && results.deskStock.sha === results.high.sha,
    results.deskStock.sha === results.high.sha
      ? 'byte-identical screenshots — the fail-safe costs literally nothing on screen'
      : `sha ${results.deskStock.sha?.slice(0, 12)} vs ${results.high.sha?.slice(0, 12)} — the ` +
        'switch is doing something on a client with no material behind it, which is the case ' +
        'that would paint onto a blank window instead of onto the desktop'
  );
  check(
    'the window base really is clear in the engine',
    /rgba\(0,\s*0,\s*0,\s*0\)|transparent/.test(desk?.htmlBgColor ?? '') &&
      !/rgba\(0,\s*0,\s*0,\s*0\)|transparent/.test(high?.htmlBgColor ?? ''),
    `html background ${high?.htmlBgColor} -> ${desk?.htmlBgColor}`
  );
  check(
    'the backdrop layer is faded out, not merely dimmed',
    desk?.wallpaper?.opacity === '0' && high?.wallpaper?.opacity === '1',
    `wallpaper opacity ${high?.wallpaper?.opacity} -> ${desk?.wallpaper?.opacity}`
  );
  check(
    'the window base token lands on zero',
    alphaOf(desk?.tokens['--dsw-alias-bg-base']) === 0 &&
      (alphaOf(high?.tokens['--dsw-alias-bg-base']) ?? 0) > 0.02,
    `bg-base alpha ${alphaOf(high?.tokens['--dsw-alias-bg-base'])} -> ${alphaOf(
      desk?.tokens['--dsw-alias-bg-base']
    )} — what is left at full glass when this is off is what stands between the desktop and the UI. ` +
      'It was 0.08 and the threshold was 0.05; the open half of this round took the endpoint to ' +
      '0.03, so the threshold would have been sitting above the value it is testing for. It is ' +
      '0.02 now — still a real "non-zero" claim, still not a number that survives the endpoint ' +
      'being deleted.'
  );
  if (pxDesk !== null && pxHigh !== null && pxOff !== null) {
    const lDesk = luma(pxDesk);
    const lHigh = luma(pxHigh);
    const lOff = luma(pxOff);
    console.log(
      `        composite luminance: off ${lOff}, 2x ${lHigh}, 2x+desktop ${lDesk} ` +
        `(spread ${pxOff.spread} / ${pxHigh.spread} / ${pxDesk.spread})`
    );
    check(
      'the composited window is neither the opaque shell nor the dark wallpaper',
      lDesk - lHigh > 60 && lDesk - lOff > 60,
      `desktop ${lDesk} vs wallpaper ${lHigh} and surface-off shell ${lOff} — both of those sit in ` +
        'the dark range, so a desktop case that lands anywhere near them means something is still ' +
        'painting over the window base'
    );
  }

  if (process.argv.includes('--keep')) {
    console.log(`  kept renders in ${DIR}`);
  }
  console.log('');
  if (failures === 0) {
    console.log('cascade proof passed');
  } else {
    console.log(`${failures} check(s) failed`);
    process.exitCode = 1;
  }
}
