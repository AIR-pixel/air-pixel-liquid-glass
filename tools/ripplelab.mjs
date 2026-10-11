/**
 * Ripple lab — what a press actually looks like.
 *
 * The ripple has been rejected three times on sight ("依旧像是手绘", "涟漪的画面
 * 做得更差了", then "有点感觉了，可是现在似乎有点不太明显，因为背景基本都是纯
 * 色"). Each rejection was about a rendered mark, and the third one is the reason
 * this specimen changed shape:
 *
 * The design that answered the first two drew nothing at all — a pure
 * `backdrop-filter` lens. That cannot be invisible on content, but it IS
 * invisible on flat content (measured Δ ≤ 5 per channel), and the app's large
 * surfaces are near-uniform design tokens. So the specimen was, until now,
 * quietly measuring the one case the effect never had a problem with: it put
 * dense text and a hard colour edge under two of its three pointers.
 *
 * This version puts the flat case first. Two of the four presses land on opaque
 * uniform surfaces — one of them painted with the same `--dsw-alias-bg-layer-2`
 * token the real app uses for its panels — because that is where a press used to
 * do nothing and where the specular rim now has to carry it alone.
 *
 * The other two presses stay, and for the opposite reason: they are the control.
 * If the rim ever starts being drawn over text as a visible circle, these are the
 * cells that show it.
 *
 *   node tools/ripplelab.mjs
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
  OFFICIAL_CSS,
  clientSrc,
  shoot
} from './harness.mjs';

const DIR = path.join(OUT, 'ripple');
const PAGE = path.join(DIR, 'ripple.html');
const SHOT = path.join(OUT, 'ripple.png');
const CONTROL = path.join(OUT, 'ripple-control.png');

const W = 1280;
const H = 470;
const LEGEND_H = 46;

/**
 * Press positions, and the disc radius the diff is measured against.
 *
 * `R = 70` is the visible disc radius at intensity 2.0 — `size = 64 + 76 *
 * glassOf(intensity)`, halved — which is what this page renders. Passing it
 * explicitly is what lets dropcheck.py separate "the rim moved" from "something
 * spilled outside the disc"; the old default of 76 was a guess that happened to
 * land between the two buckets and would have hidden the whole effect.
 *
 * This specimen renders the default `rippleSize` of 1, so `R` is 70 here and on
 * the ladder's middle rung; the other two rungs carry their own radius.
 */
const R = 70;
const PRESSES = [
  { x: 150, y: 132, label: '文字上', note: '镜头有东西可弯，高光同时加一道壁' },
  { x: 430, y: 252, label: '硬边上', note: '位移最显眼的地方：白边被弯成弧' },
  { x: 815, y: 148, label: '纯色面板上', note: '镜头无事可做 —— 只剩镜面高光' },
  { x: 1095, y: 362, label: '完全平坦块', note: '同上：这一格修的就是它' }
];

/**
 * The size ladder, and why it is here rather than in verify.mjs.
 *
 * `verify.mjs` reads the CSS the renderer emits, so it can prove that
 * `rippleSize` reaches the three numbers it is supposed to reach — and it does,
 * at 70px / 140px / 280px for the rest / held / released diameters. What a
 * string cannot prove is that the disc on screen is the size that string says.
 * A later `width: …` rule, an override, or a `min-width` would leave every
 * assertion green and the slider visibly dead, which is the failure air would
 * report back as "滑杆没反应".
 *
 * So each rung is rendered and then measured radially by `dropcheck.py` — with
 * the radius MATCHING the rung, which is what makes it a test: at 50% the rim
 * has to land in the 29–37px annulus, and the 59–74px annulus has to be *flat*,
 * because nothing is painted out there. Measuring only the matching radius
 * would pass on a disc of any size that happened to have a rim; the quiet
 * annulus at the next rung up is the half that says the ring MOVED.
 *
 * The press sits on the hard luminance edge, where the lens has something to
 * bend, so the interior reading is not vacuous either.
 */
const SINGLE_PRESS = { x: 430, y: 252 };
const SIZES = [
  { pct: '50', ripple: 0.5, R: 35 },
  { pct: '100', ripple: 1, R: 70 },
  { pct: '200', ripple: 2, R: 140 }
];

/**
 * Dense text, one hard luminance edge, and TWO opaque uniform surfaces.
 *
 * The uniform ones must be opaque. `rgba(255,255,255,0.06)` over the body
 * gradient looks flat and is not: the gradient underneath still varies, so a
 * lens finds a little structure and the specimen flatters the effect. An opaque
 * fill is the only way to reproduce "背景基本都是纯色".
 */
const BACKDROP = `
<div class="text">${Array.from({ length: 40 }, (_, i) => {
  const row = [
    'function lensMapDataUrl(size) { return canvas.toDataURL(); }',
    'the quick brown fox jumps over the lazy dog 0110 1011 1100',
    '中文测试文本用于检验折射后的可读性 · 0123456789 · §¶†‡',
    '<b>const</b> scale = 29; <b>const</b> bezel = 0.10; <b>return</b> filter;',
    'iiiiiiiiiiii lllllllllllll 111111111111 aaaaaaaaaaaa'
  ];
  return `<div>${row[i % row.length]}</div>`;
}).join('')}</div>
<div class="edge"></div>
<div class="panel"></div>
<div class="flat"></div>`;

const HTML = (rippleSize, presses) => `<!doctype html>
<html data-platform="win32">
${pageHead()}
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; overflow: hidden; }
  body {
    background: linear-gradient(115deg, #0a0c10 0%, #232a32 40%, #4a545f 64%, #0d1014 100%);
    color: rgba(255,255,255,0.92);
    font: 11px/1.32 ui-monospace, monospace;
  }
  .legend { position: absolute; left: 0; right: 0; top: 0; height: ${LEGEND_H}px;
            padding: 6px 12px; background: #05070b; border-bottom: 1px solid #1d232c;
            display: flex; gap: 26px; align-items: center; font-size: 11.5px; }
  .legend i { font-style: normal; display: inline-block; width: 16px; height: 16px;
              border-radius: 50%; background: #2f6df0; color: #fff; text-align: center;
              line-height: 16px; font-size: 10px; margin-right: 6px; vertical-align: 1px; }
  .legend span { color: #93a1b5; }
  .text { position: absolute; left: 0; right: 0; top: ${LEGEND_H}px; bottom: 0;
          padding: 6px 10px; letter-spacing: .01em; }
  .text b { color: #7fd4ff; font-weight: 400; }
  .edge { position: absolute; left: 0; right: 0; top: 250px; height: 3px; background: #fff; }
  /* The app's real case: an opaque uniform surface painted with a token. Values
     copied from what --dsw-alias-bg-layer-2 resolves to at intensity 2.0. */
  .panel { position: absolute; left: 690px; top: 74px; width: 250px; height: 148px;
           border-radius: 12px; background: #232a33; }
  .flat { position: absolute; left: 960px; top: 282px; width: 270px; height: 160px;
          border-radius: 12px; background: #151920; }
  /* Transitions are suppressed IN THE SPECIMEN ONLY, and the reason is worth
     recording because it cost two wrong conclusions.

     A capture with --virtual-time-budget produces no compositor frames, and a
     CSS transition without frames never advances: the computed style stays
     pinned at the transition's 0% keyframe. So the page reported
     data-held="true" while also reporting opacity=0, and the screenshot
     showed the ripple as if it did not exist. Both readings were accurate and
     together they were misleading.

     This file is about how the press LOOKS, not how it animates — the timing is
     asserted in verify.mjs against the 300ms interaction budget. So the
     transition is switched off here and the held state lands immediately. */
  .dsl-ripple-glint, .dsl-ripple-glint::after { transition: none !important; }
</style>
</head>
<!-- data-ds-dark-theme is load-bearing, not decoration: the plugin paints its
     own backdrop over body, so without it this page gets the near-white LIGHT
     wallpaper and every specimen is judged against the wrong ground. -->
<body data-ds-dark-theme="">
<div class="legend">
${PRESSES.map((p, i) => `<div><i>${i + 1}</i>${p.label}<span> · ${p.note}</span></div>`).join('')}
</div>
${BACKDROP}
<script>${loader({ ...DEFAULT_CONFIG, intensity: 2, rippleSize })}</script>
<script>${MOCK_CTX}</script>
<script src="${clientSrc(DIR)}"></script>
<script>${BOOT}</script>
<script>
  // Press and hold, exactly as a user would: pointerdown with the primary
  // button, then no pointerup, so the glint stays in its held state.
  //
  // The #control hash skips the presses and renders the identical page without
  // them. That pairing is what turns "the press reads" into a measured claim
  // instead of a look, and it is the only way to attribute a change to the
  // ripple rather than to the page.
  if (location.hash !== '#control') {
    ${JSON.stringify(presses)}.forEach(function (p) {
      var ev = new PointerEvent('pointerdown', {
        bubbles: true, cancelable: true, button: 0, buttons: 1,
        pointerType: 'mouse', clientX: p.x, clientY: p.y
      });
      document.dispatchEvent(ev);
    });
  }
  // Report the runtime state INTO the image. A specimen that shows nothing is
  // ambiguous between "the effect is too subtle" and "nothing was ever
  // spawned", and those need opposite fixes — so the page states which.
  window.setTimeout(function () {
    var g = document.querySelectorAll('.dsl-ripple-glint');
    var first = g.length === 0 ? null : getComputedStyle(g[0]);
    var rim = first === null ? null : getComputedStyle(g[0], '::after');
    var bar = document.createElement('div');
    bar.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:2147483647;' +
      'background:#000;color:#0f0;font:12px/1.5 ui-monospace,monospace;padding:3px 8px';
    bar.textContent = 'glints=' + g.length +
      ' size=' + Math.round(${rippleSize} * 100) + '%' +
      ' root=' + (document.querySelector('.dsl-ripple-root') === null ? 'none' : 'ok') +
      (first === null ? '' :
        ' | opacity=' + first.opacity +
        // Two readings, and both earn their place. w/h are what grows now: the
        // disc expands by layout, so the box's own width is the size slider's
        // one visible output. t is the guard on the other side — it must read
        // "none", because a transform coming back is a compositor handoff coming
        // back, and that handoff is the one thing air's screen had that thirteen
        // local captures could not reproduce. A bar that printed only the width
        // would go quiet at exactly the moment it mattered.
        ' w=' + first.width + '/' + first.height +
        ' t=' + first.transform +
        // Labelled "backdrop=" and not "filter=": the two properties are one
        // keystroke apart in meaning and nothing alike in effect, and reading
        // this bar as the element's own filter sends you looking for a paint
        // that is not there.
        ' backdrop=' + (first.backdropFilter || first.webkitBackdropFilter || 'none') +
        // The rim, read from the pseudo-element. maskImage is the half that
        // can silently disappear — a conic gradient is well supported but an
        // engine that drops it leaves an evenly-lit ring, which looks like a
        // stroke rather than a wall and is exactly the failure this bar pre-empts.
        (rim === null ? '' : ' | rim=' + rim.backgroundImage.slice(0, 46) +
          ' mask=' + (rim.maskImage || rim.webkitMaskImage || 'none').slice(0, 30)));
    document.body.appendChild(bar);
  }, 260);
</script>
</body>
</html>`;

fs.mkdirSync(DIR, { recursive: true });
fs.writeFileSync(PAGE, HTML(1, PRESSES), 'utf8');
console.log('browser:', browser);
console.log('official sheet bytes:', OFFICIAL_CSS.length);
// Budget: has to clear the 170ms hold transition AND stay under the runtime's
// own 900ms stuck-press safety release, which fires whether or not a real
// pointer released. Capturing after that shows the dissolving state, not the
// pressed one — which is what made the first two attempts at this image look
// like the effect did nothing.
console.log('ripple:', shoot(PAGE, SHOT, { width: W, height: H, budget: 700 }), SHOT);
console.log('control:', shoot(`${PAGE}#control`, CONTROL, { width: W, height: H, budget: 700 }), CONTROL);
const spec = PRESSES.map((p) => `${p.x},${p.y},${R}`).join(' ');
console.log('diff both with:');
console.log(`  python tools/dropcheck.py tools/_preview/ripple.png tools/_preview/ripple-control.png \\`);
console.log(`    ${PRESSES.map((p) => `--press ${p.x},${p.y},${R}`).join(' ')}`);
console.log(`  (spec: ${spec})`);

// ---------------------------------------------------------------------------
// The size ladder. Same page, same press, same backdrop — three rungs.
// ---------------------------------------------------------------------------
//
// Same dimensions as the specimen on purpose: the three rungs have to differ in
// exactly one variable, and the backdrop under the press is part of the
// measurement.
const LADDER = [];
for (const rung of SIZES) {
  const p = path.join(DIR, `size-${rung.pct}.html`);
  const shot = path.join(OUT, `ripple-size-${rung.pct}.png`);
  const control = path.join(OUT, `ripple-size-${rung.pct}-control.png`);
  fs.writeFileSync(p, HTML(rung.ripple, [SINGLE_PRESS]), 'utf8');
  shoot(p, shot, { width: W, height: H, budget: 700 });
  shoot(`${p}#control`, control, { width: W, height: H, budget: 700 });
  LADDER.push({ ...rung, p, shot, control });
}

console.log('');
console.log('size ladder — press at', `${SINGLE_PRESS.x},${SINGLE_PRESS.y}`, `on the hard edge`);
for (const rung of LADDER) {
  const rel = (f) => 'tools/_preview/' + path.basename(f);
  console.log('');
  console.log(`  ${rung.pct}% — expect the rim in ${(rung.R * 0.84).toFixed(0)}–${(rung.R * 1.06).toFixed(0)}px`);
  console.log(`    python tools/dropcheck.py ${rel(rung.shot)} ${rel(rung.control)} --press ${SINGLE_PRESS.x},${SINGLE_PRESS.y},${rung.R}`);
}
// The falsifier. Printed last and named for what it refutes, because a ladder
// that only ever measures the radius it expects is a ladder that passes on a
// disc of any size with a rim anywhere: at 50% the 59–74px annulus is the one
// place nothing is painted, and it is only quiet if the disc really did shrink.
console.log('');
console.log('  and the half that makes it a test — at 50%, the 100% ring has to be EMPTY:');
console.log(`    python tools/dropcheck.py tools/_preview/ripple-size-50.png tools/_preview/ripple-size-50-control.png --press ${SINGLE_PRESS.x},${SINGLE_PRESS.y},70`);
console.log('    (rim.changed_pct there is the falsifier: it must be ~0. If the slider is dead');
console.log('     the disc stays 140px wide and that annulus sits on the lit wall instead.)');
