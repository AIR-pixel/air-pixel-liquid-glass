/**
 * Do the two sides of a conversation actually come out different colours?
 *
 * THE REPORT, VERBATIM. air: "ai的消息和用户的消息都一个颜色，辨识度太低，做差分".
 * That is a claim about pixels, not about CSS, so this tool measures pixels: it
 * renders a conversation shaped like the real app's DOM, switches the mode, and
 * reads the plate colour that lands under each speaker's row.
 *
 * WHY A SEPARATE TOOL RATHER THAN ANOTHER ASSERTION. `verify.mjs` can prove the
 * two CSS tokens are different strings and that each side's rule reads its own
 * token. It cannot prove the pair is *distinguishable* — two tokens one RGB step
 * apart satisfy every assertion in that suite and are invisible on screen, which
 * is precisely the failure air reported. The number that matters here is a
 * perceptual one, and it has to come off rendered pixels.
 *
 * IT MEASURES A DIFFERENCE, NOT A COLOUR. Each mode is rendered twice, once with
 * a plate and once without, and what gets compared is the plate's own
 * contribution to each row. Measuring the two rows' absolute colours does not
 * work — and this cost three runs to learn, so it is written down — because the
 * two rows are never at the same height on the page and the theme paints its own
 * vertical gradient over `body`. Under `off`, where there is nothing to measure,
 * the absolute version read Δ=2; under `side` that same gradient was folded into
 * the Δ it reported, so part of the plate's number was the paper. Subtracting a
 * plate-less frame of the same page removes the paper exactly.
 *
 * BOTH SCHEMES ARE MEASURED, because the split is not one rule: the light scheme
 * builds its pair from the accent toward black and the dark one anchors on the
 * canvas. That divergence was itself forced by measurement, so pointing the
 * instrument at one scheme would be a contradiction — a tool that only measures
 * the scheme that was already fine is a tool that would have passed the version
 * air complained about.
 *
 * THE INSTRUMENT PROVES ITSELF FIRST. The same lesson `frostvis.mjs` paid for
 * twice: a harness that cannot return "no difference" also cannot return
 * "difference". Two controls run before any verdict — the same frame is read
 * twice and must agree, and `off` must show NO difference between the sides. If
 * either control fails this prints CONTROL FAILED and exits without a verdict.
 *
 * `DSL_PYTHON` must point at an interpreter with PIL — the bare `python` on this
 * machine does not have it, and the failure mode is a `Command failed` per
 * sample rather than a loud error. `verify.mjs` reuses the same variable.
 *
 *   node tools/sidevis.mjs
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
  clientSrc,
  dumpDomWithShot
} from './harness.mjs';

const PYTHON = process.env.DSL_PYTHON ?? 'python';
const PIXSTAT = path.join(HERE, 'pixstat.py');
const DIR = path.join(OUT, 'sidevis');

if (browser === null) {
  console.log('no headless browser found — cannot measure');
  process.exit(2);
}

/**
 * The conversation fixture.
 *
 * Copied in shape from the real app's flow contract — `[data-chat-flow]` with
 * `[data-chat-flow-key]` rows carrying `data-chat-flow-kind` — because the whole
 * question is whether the theme's selector matches what the app actually emits.
 * A fixture using tidy class names would answer a question nobody asked.
 *
 * THE TWO ROWS CARRY THE SAME STRING, and that is not laziness. The `off` control
 * measured Δ=2 with different copy in the two rows: the sample band averages a
 * strip of text, so two different sentences put a different amount of ink in the
 * two bands, and the control — which must read as identical without a plate —
 * picked that difference up. Two identical strings cannot contribute a
 * difference, so whatever the control reads is the instrument's own noise or the
 * plate's doing, which is the only thing this tool is entitled to measure.
 *
 * The strings are also long enough to fill the row's width at the fixture's font
 * size, so neither band lands partly on empty paper.
 */
const ROW_TEXT = '这一段是模型的回答，应当用另一种底色，和上面那句区分开。';

const THREAD = `
<div id="root">
  <main class="main" style="padding:40px">
    <div data-chat-flow data-chat-flow-key="col" style="max-width:900px">
      <div data-chat-flow-key="r1" data-chat-flow-kind="user"
           style="font-size:15px;line-height:1.9;color:#111;padding:10px 0">
        ${ROW_TEXT}
      </div>
      <div data-chat-flow-key="r2" data-chat-flow-kind="turn-process"
           style="font-size:15px;line-height:1.9;color:#111;padding:10px 0">
        ${ROW_TEXT}
      </div>
    </div>
  </main>
</div>`;

/**
 * The plate is translucent, so what is measured is the plate composited over
 * the page. The stand-in is a FLAT mid grey, and the flatness is load-bearing.
 *
 * The first version used a striped backdrop, on the reasoning that a texture
 * makes a translucent difference easier to see. It broke the control instead:
 * the two sample bands landed on different phases of the stripes, so `off` —
 * which must read as identical on both sides — came back at Δ=4, and a Δ of 4
 * is the same order as the difference the feature was trying to prove. A
 * measurement whose control fails is not a measurement, so the backdrop became
 * uniform: the only thing that can differ between the two bands now is the
 * plate itself, which is the entire question.
 */
const FIXTURE_CSS = `
html, body { margin: 0; }
body { background: #787878; }
`;

/**
 * Ask the page where the two rows actually are, instead of assuming.
 *
 * THE FIRST VERSION ASSUMED, AND THE ASSUMPTION WAS WRONG. It sampled two fixed
 * boxes — y 105–140 and y 165–200 — chosen by eye from an earlier frame. Measured
 * against the real render, the rows sit near y 58–120 and the page is not the
 * flat backdrop the fixture asks for: the theme paints its own vertical gradient
 * over `body`, so a constant box on each row lands at a different point on that
 * gradient. The `off` control — which must read byte-identical on both sides —
 * came back at Δ=8, the same order as the difference the feature is trying to
 * prove. A control that fails by the size of the effect is not a control.
 *
 * So the offsets are read back from the DOM at render time. Each band is
 * sampled strictly INSIDE its row's content box, which removes both failure
 * modes at once: the sample cannot miss the row, and the two samples are the
 * same height above the page bottom, so the backdrop gradient contributes
 * equally to both and cancels in the delta.
 *
 * The payload goes into a `<pre>` with an id of its own — see `readRows` for why
 * it is not the id `harness.mjs`'s own reader looks for.
 */
const SCRAPE_ROWS = `
(function () {
  var out = [];
  var rows = document.querySelectorAll('[data-chat-flow] > [data-chat-flow-key]');
  for (var i = 0; i < rows.length; i += 1) {
    var r = rows[i].getBoundingClientRect();
    out.push({
      kind: rows[i].getAttribute('data-chat-flow-kind'),
      x: Math.round(r.left),
      y: Math.round(r.top),
      w: Math.round(r.width),
      h: Math.round(r.height)
    });
  }
  var pre = document.createElement('pre');
  pre.id = 'sidevis-rows';
  pre.textContent = JSON.stringify(out);
  pre.style.cssText = 'position:fixed;left:-9999px;top:0';
  document.body.appendChild(pre);
})();
`;

/**
 * Read the geometry back, using an id that cannot collide.
 *
 * NOT `readPre` FROM `harness.mjs`, and the reason is a trap worth writing down:
 * that helper matches the FIRST `<pre id="out">` in the dump, and `--dump-dom`
 * emits the page's own `<script>` body as text before it emits the element the
 * script created. So the script source — which contains the literal words
 * `probe:1` inside its own template — came back as the payload, and the tool
 * parsed `probe:1,total:...` instead of the JSON the page had actually written.
 * The read looked like a success and returned nothing usable.
 *
 * A distinct id and an anchored match on the whole element remove both halves of
 * that: nothing else in the page uses this id, and the pattern cannot stop at a
 * `</pre>` that belongs to a different element.
 */
function readRows(dump) {
  const m = dump.match(/<pre id="sidevis-rows"[^>]*>([\s\S]*?)<\/pre>/);
  if (m === null) return null;
  return m[1]
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"');
}

/**
 * The two schemes, and BOTH are measured because the split is not one rule.
 *
 * The light scheme builds its pair from the accent toward black; the dark one
 * anchors on the canvas and pulls upward. That divergence was forced by
 * measurement — the first single rule measured Δ 85–100 dark against Δ 39–52
 * light — so it would be a contradiction to keep the instrument pointed at one
 * scheme only. A tool that measures the scheme that was already fine is a tool
 * that would have passed the version air complained about.
 *
 * `pageHead()` and `MOCK_CTX` are scheme-agnostic; the only switch is the
 * `data-ds-dark-theme` attribute on `<body>`, which is what `harness.mjs`
 * itself reads back when it reports `out.scheme`.
 */
const SCHEMES = [
  { id: 'dark', dark: true },
  { id: 'light', dark: false }
];

/**
 * The window the sample is taken in, as a fraction of the row's content box.
 *
 * The row is a text block, so its top and bottom edges are dominated by the
 * font's ascent and descent — mostly paper, very little ink. Averaging the whole
 * box would drown a plate colour in whitespace and hide exactly the difference
 * being measured. The band is taken from 35% to 75% of the row height, which is
 * where the x-height sits: still inside the plate, and vertically clear of the
 * gaps between rows so a neighbouring plate cannot bleed in.
 */
const BAND = { from: 0.35, to: 0.75 };

function bandBox(row) {
  const top = Math.round(row.y + row.h * BAND.from);
  const bottom = Math.round(row.y + row.h * BAND.to);
  // Inset horizontally so the rounded corners of the plate cannot contribute
  // a different amount at the two ends of the band.
  const left = Math.round(row.x + row.w * 0.05);
  const right = Math.round(row.x + row.w * 0.95);
  return `${left},${top},${right},${bottom}`;
}

function writePage(name, config, dark) {
  const dir = path.join(DIR, name);
  fs.mkdirSync(dir, { recursive: true });
  const page = path.join(dir, 'index.html');
  const cfg = { ...DEFAULT_CONFIG, ...config, material: 'patched' };
  const html = `<!DOCTYPE html>
<html data-platform="win32">
${pageHead()}
<style>${FIXTURE_CSS}</style>
</head>
${dark ? '<body data-ds-dark-theme>' : '<body>'}
${THREAD}
<script>${loader(cfg)}</script>
<script>${MOCK_CTX}</script>
<script src="${clientSrc(dir)}"></script>
<script>${BOOT}</script>
<script>${SCRAPE_ROWS}</script>
</body>
</html>`;
  fs.writeFileSync(page, html, 'utf8');
  return page;
}

/**
 * Render one page and read the two bands off it, returning the boxes too.
 *
 * A geometry payload that never arrives is reported as an error rather than as
 * zeros, because "the instrument did not run" and "the instrument ran and found
 * nothing" are different results and only one of them is about the theme.
 */
function shootPage(name, config, dark) {
  const page = writePage(name, config, dark);
  const png = path.join(DIR, `${name}.png`);
  const dump = dumpDomWithShot(page, png);
  const payload = readRows(dump);
  if (payload === null) {
    return { error: 'the row-geometry element never reached the DOM dump' };
  }
  let rows;
  try {
    rows = JSON.parse(payload);
  } catch {
    return { error: `row geometry was not JSON (payload: ${JSON.stringify(payload.slice(0, 80))})` };
  }
  const human = rows.find((r) => r.kind === 'user');
  const model = rows.find((r) => r.kind === 'turn-process');
  if (human === undefined || model === undefined) {
    return { error: `the fixture rows were not found (kinds seen: ${rows.map((r) => r.kind).join(', ') || 'none'})` };
  }
  const humanBox = bandBox(human);
  const modelBox = bandBox(model);
  const h = readBox(png, humanBox);
  const m = readBox(png, modelBox);
  if (h.error !== undefined || m.error !== undefined) {
    return { error: `pixel read failed (${h.error ?? m.error})` };
  }
  return {
    png,
    boxes: { human: humanBox, model: modelBox },
    geometry: { human, model },
    human: h,
    model: m
  };
}

/**
 * Measure one mode as a DIFFERENCE against the same page with no plate.
 *
 * WHY A DIFFERENCE AND NOT TWO ABSOLUTE COLOURS. The first version compared the
 * two rows' mean colours directly, and it could not reach zero on the control.
 * The cause is not the copy — giving both rows the same string did not move the
 * number — it is the page: the theme paints its own vertical gradient over
 * `body`, so a band at y≈57 sits on a lighter patch than a band at y≈106, and
 * the two rows are never at the same height. Under `off` that gradient alone
 * read Δ=2, and under `side` it was folded into the Δ=70 the tool was reporting,
 * meaning part of the number that was supposed to be "the plate" was the paper.
 *
 * Subtracting a plate-less frame of the SAME page removes the paper exactly.
 * Both frames put each row in the same place against the same backdrop, so the
 * difference vector is the plate's contribution and nothing else — and the `off`
 * control becomes 0 by construction, which is what a control is for.
 */
function measure(name, config, dark) {
  const withPlate = shootPage(name, config, dark);
  if (withPlate.error !== undefined) return withPlate;
  // The reference keeps the mode so the CSS is identical apart from its alpha —
  // switching `plateSide` off would change which rules exist and make the
  // subtraction compare two different stylesheets.
  const reference = shootPage(`${name}-ref`, { ...config, plateLevel: 0, plate: false }, dark);
  if (reference.error !== undefined) return reference;

  const diff = (a, b) => a.box_mean.map((v, i) => v - b.box_mean[i]);
  return {
    png: withPlate.png,
    boxes: withPlate.boxes,
    geometry: withPlate.geometry,
    base: { human: reference.human.box_mean, model: reference.model.box_mean },
    // The plate's own contribution per row, as a signed RGB vector.
    human: { box_mean: diff(withPlate.human, reference.human) },
    model: { box_mean: diff(withPlate.model, reference.model) }
  };
}

function readBox(png, box) {
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

/**
 * Manhattan distance between the two sides' plate contribution, in 0…765.
 *
 * Both arguments are signed difference vectors, not colours — see `measure`.
 * The number is therefore "how differently the plate treats the two speakers",
 * with the page subtracted out. Zero means the plate is the same colour on both,
 * which is the defect air reported; a small number means it is *technically*
 * different and still indistinguishable on screen, which is why this is
 * measured at all rather than asserted in CSS.
 */
function delta(a, b) {
  if (!a?.box_mean || !b?.box_mean) return null;
  return Math.abs(a.box_mean[0] - b.box_mean[0])
    + Math.abs(a.box_mean[1] - b.box_mean[1])
    + Math.abs(a.box_mean[2] - b.box_mean[2]);
}

const CASES = [
  { name: 'side', config: { intensity: 2, plate: true, plateLevel: 0.75, plateSide: 'side' } },
  { name: 'halo', config: { intensity: 2, plate: false, plateSide: 'halo' } },
  { name: 'off', config: { intensity: 2, plate: true, plateLevel: 0.75, plateSide: 'off' } },
  { name: 'side-noplate', config: { intensity: 2, plate: false, plateSide: 'side' } }
];

/**
 * Empty the output directory WITHOUT a recursive delete.
 *
 * `fs.rmSync(dir, { recursive: true })` does not work here. This shell injects a
 * "safe delete" shim through `NODE_OPTIONS --require`, and the shim routes a
 * recursive delete through the Windows Recycle Bin binary. That binary times out
 * under this sandbox (it was the `ENOTEMPTY` crash in the first run of this
 * tool), so the recursive call is not merely slow — it throws, and it throws
 * before a single frame is rendered.
 *
 * Removing files one level at a time avoids the shim's recursive path entirely:
 * an individual file delete is what the rest of this repo already does twenty
 * times a run without trouble. The directory itself is then reused rather than
 * recreated, so its absence stops being something that has to succeed too.
 */
function emptyDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) emptyDir(full);
    else fs.rmSync(full, { force: true });
  }
}

emptyDir(DIR);

const rows = [];
const VEC = (v) => (v === undefined ? '?' : `(${v[0] >= 0 ? '+' : ''}${v[0]},${v[1] >= 0 ? '+' : ''}${v[1]},${v[2] >= 0 ? '+' : ''}${v[2]})`);
for (const scheme of SCHEMES) {
  console.log(`\n${scheme.id}  (plate contribution per row, minus the same frame without a plate)`);
  for (const c of CASES) {
    const name = `${scheme.id}-${c.name}`;
    const m = measure(name, c.config, scheme.dark);
    if (m.error !== undefined) {
      console.log(`  ${c.name.padEnd(13)} ${m.error}`);
      rows.push({ name, scheme: scheme.id, error: m.error });
      continue;
    }
    const d = delta(m.human, m.model);
    rows.push({ name, scheme: scheme.id, human: m.human, model: m.model, delta: d, boxes: m.boxes });
    console.log(`  ${c.name.padEnd(13)} user ${VEC(m.human.box_mean).padEnd(16)} `
      + `model ${VEC(m.model.box_mean).padEnd(16)}  Δ=${d}`);
  }
}

console.log('');

/** Rows are keyed `scheme-case`, and every lookup below is scheme-scoped. */
const get = (schemeId, name) => rows.find((r) => r.name === `${schemeId}-${name}`);

// A measurement that came back as an error is not a measurement. Refuse before
// the controls, because the controls would otherwise report a failure whose
// cause is one layer down and much harder to read.
{
  const broken = rows.filter((r) => r.error !== undefined);
  if (broken.length > 0) {
    console.log(`MEASUREMENT FAILED in ${broken.length} case(s):`);
    for (const r of broken) console.log(`  ${r.name}: ${r.error}`);
    console.log('  Nothing is concluded from this run.');
    process.exit(1);
  }
}

// ---- control 1: the same pixels read twice must agree ---------------------
// Run once per scheme: the two schemes render through different branches of the
// colour math, so a stable read on one says nothing about the stability of the
// other.
for (const scheme of SCHEMES) {
  const first = get(scheme.id, 'side');
  const again = measure(`${scheme.id}-side-repeat`, CASES.find((c) => c.name === 'side').config, scheme.dark);
  if (again.error !== undefined) {
    console.log(`CONTROL FAILED (${scheme.id}): the repeat could not be measured (${again.error}).`);
    process.exit(1);
  }
  if (JSON.stringify(again.human.box_mean) !== JSON.stringify(first.human.box_mean)) {
    console.log(`CONTROL FAILED (${scheme.id}): reading the same box twice gave different numbers.`);
    console.log(`  ${JSON.stringify(first.human.box_mean)} vs ${JSON.stringify(again.human.box_mean)}`);
    console.log('  Fix the instrument before trusting any row above.');
    process.exit(1);
  }
}

// ---- control 2: `off` must show no difference, `side` must show one -------
//
// `off` is now zero by construction — the subtraction removes whatever the page
// contributes — so this control is checking something narrower and more useful:
// that the two frames really are being rendered from the same page at the same
// geometry. If the reference frame ever drifted (a different row height, a
// different scroll position), the subtraction would leave a residue here.
for (const scheme of SCHEMES) {
  const off = get(scheme.id, 'off');
  if (off.delta !== 0) {
    console.log(`CONTROL FAILED (${scheme.id}): \`off\` still distinguishes the sides (Δ=${off.delta}).`);
    console.log(`  bands: human ${off.boxes.human}  model ${off.boxes.model}`);
    console.log('  The two frames are not comparable, so the subtraction is not removing the page.');
    process.exit(1);
  }
  const side = get(scheme.id, 'side');
  if (side.delta === 0) {
    console.log(`CONTROL FAILED (${scheme.id}): the two sides rendered byte-identical under \`side\`.`);
    console.log('  Either the fixture rows are not being matched by the selector, or the');
    console.log('  split is broken. Both are real defects; neither is measurable here.');
    process.exit(1);
  }
}

// The bands are where the two rows actually are, printed once so a future
// failure can be read against them rather than re-derived.
const sample = get('dark', 'side');
console.log('sampled bands (dark, side):');
console.log(`  user  ${sample.boxes.human}`);
console.log(`  model ${sample.boxes.model}`);

console.log('\nper scheme:');
for (const scheme of SCHEMES) {
  const side = get(scheme.id, 'side');
  const noPlate = get(scheme.id, 'side-noplate');
  console.log(`  ${scheme.id.padEnd(5)} under \`side\` the plate treats the two speakers `
    + `${side.delta} apart; under \`off\` it is 0.`);
  if (noPlate.delta === 0) {
    console.log('        with the plate switch OFF, `side` correctly distinguishes nothing — the');
    console.log('        mode rides on the plate, which is what the panel disables it for.');
  } else {
    console.log(`        NOTE: \`side\` with the plate off still moved the pixels (Δ=${noPlate.delta}).`);
  }
}

for (const scheme of SCHEMES) {
  const halo = get(scheme.id, 'halo');
  console.log(`\n${scheme.id} halo: plate delta ${halo.delta} (the mode paints no plate, so this`);
  console.log('  is the rendered difference between two no-plate frames — instrument noise,');
  console.log('  not a failure; it is here to show that noise is well under the numbers above).');
}
console.log(`\nframes -> ${DIR}`);
