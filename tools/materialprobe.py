"""
Measure what each Windows window recipe actually shows behind the window.

    python tools/materialprobe.py                 # the whole matrix
    python tools/materialprobe.py --only none     # one recipe
    python tools/materialprobe.py --list          # names only, launches nothing

WHY THIS EXISTS

air reported, twice, that at maximum 效果强度 the window "还是算是高斯模糊级别"
and asked for "几乎完全透明". The CSS half is provably at zero — deskcheck.mjs
reads `--dsl-blur` as `blur(0px)` straight off his machine — so the blur has to
come from `backgroundMaterial: "acrylic"`, the one layer CSS cannot reach.

Turning that material off is the obvious fix and it is not obviously safe.
Electron's docs list `none` as a legal value and say nothing about whether the
window keeps showing the desktop afterwards; the rival reading is that the
material *is* what makes the window see-through, in which case `none` gives an
opaque or black window instead. `transparent: true` is the documented
transparency path, but it is documented as needing a frameless window, which
changes the window shell. None of that can be settled by reading, because it
depends on this Electron build and this machine's DWM.

WHY A CHECKERBOARD

A real screen capture can see the desktop through the window, but only if
something with known edge energy is behind it — a wallpaper is whatever air
happens to be running, and a flat one makes the question unanswerable. So the
probe builds its own target: a frameless opaque window painted with an 8 px
checkerboard, with the recipe under test covering its middle and leaving a 40 px
ring exposed. The ring is the pattern's true edge energy; the covered middle is
whatever the recipe lets through. The ratio between them is the answer, and it
holds regardless of wallpaper, theme or app.

AND THE SAME WINDOW, THE OTHER WAY

Every run also captures the recipe window through `appshot.py`'s PrintWindow
while it is still on screen — same window, same instant, two instruments — and
the `pw` columns are that second reading. This started as a way to confirm a
suspicion and instead demolished it, which is why it is still here.

The suspicion was that the older tool was blind to the backdrop: it renders a
window's own surface, and a backdrop is drawn by the compositor behind it.
Measured, all six recipes:

    recipe                     screen         PrintWindow
    stock                 0.025 / 251.7      0.030 / 228.5     agree
    acrylic               0.011 / 100.0      0.012 /  99.5     agree
    none                  0.875 / 129.0      0.002 /   0.2     DISAGREE
    bg-only               0.005 /  32.1      0.005 /  32.0     agree
    none+transparent      0.886 / 129.0      0.005 /   0.3     DISAGREE
    acrylic+transparent   0.014 / 100.1      0.015 /  99.5     agree

PrintWindow sees the acrylic backdrop perfectly well — with a material present
the compositor's layer is part of what the window renders, and the two readings
agree to a decimal. What it cannot see is TRANSPARENCY. A see-through window has
premultiplied pixels, RGB zeroed wherever alpha is zero, and `appshot.py`
converts BGRA to RGB without ever looking at that alpha, so a fully see-through
window comes back as a black rectangle.

That is the worse blind spot of the two, not the smaller one: black is also
exactly what the tool reports for "the window is opaque and painted black". The
two states air cares about most — 桌面透出来了, and 什么都没有 — are the same
picture to it. Measuring the fault was easy all along; confirming the fix was
impossible, because the fix is precisely the case it cannot represent.

Reading the table:

    hf ratio  ≈ 1        the desktop comes through SHARP — what air asked for
    hf ratio  << 1       it comes through, but smoothed — the acrylic look
    hf ratio  ≈ 0 and
      mean luma ≈ 129    the pattern is there under a heavy blur
      mean luma ≈ 0/255  nothing came through at all (opaque window)

The luma split matters: a heavily blurred checkerboard still averages to its own
mid-grey, while an opaque window shows a flat fill. Low edge energy alone cannot
tell those two apart, which is exactly the mistake this tool exists to avoid.
"""
import argparse
import ctypes
import json
import os
import subprocess
import sys
import time
from pathlib import Path

from PIL import ImageFilter, ImageGrab, ImageStat

HERE = Path(__file__).resolve().parent
PROBE = HERE / "_probe"
EXE = PROBE / "DeepSeek Harness.exe"
REPORT = PROBE / "_report.json"
USERDATA = PROBE / "_userdata"
OUT = HERE / "_preview" / "material"

# PrintWindow lives in appshot.py and is imported rather than re-copied: 30 lines
# of GDI ctypes here would be a second implementation of the very instrument this
# tool is auditing, and the audit is only believable if it is the SAME code path
# every other capture in tools/ uses. `tools/` is sys.path[0] whenever these run
# as scripts, but the insert makes it true however they are launched.
sys.path.insert(0, str(HERE))
from appshot import grab as printwindow_grab, windows as find_windows  # noqa: E402

# The checkerboard's two tones, and therefore the average a blurred copy of it
# still has to show. Keep in sync with ref.html.
CHECKER_LIGHT, CHECKER_DARK = 0xD8, 0x2A
CHECKER_MEAN = (CHECKER_LIGHT + CHECKER_DARK) / 2

# Physical pixels for every rect, so a scaled display and a DPI-unaware process
# cannot quietly disagree about where the window is. Same approach as appshot.py.
# shcore is the modern API; the fallback covers an older Windows.
try:
    ctypes.WinDLL("shcore").SetProcessDpiAwareness(2)
except Exception:
    try:
        ctypes.WinDLL("user32").SetProcessDPIAware()
    except Exception:
        pass


def edge_energy(img):
    """Mean Laplacian response. The one number that says "sharp" or "not"."""
    grey = img.convert("L")
    return ImageStat.Stat(grey.filter(ImageFilter.FIND_EDGES)).mean[0]


def mean_luma(img):
    return ImageStat.Stat(img.convert("L")).mean[0]


def launch(recipe, settle, on_top=True):
    """Start one probe window and return (process handle, its report payload)."""
    report = PROBE / f"_report-{recipe}.json"
    if report.exists():
        report.unlink()

    # `ELECTRON_RUN_AS_NODE` has to go.
    #
    # This tool is normally run from inside another Electron app's agent shell,
    # and that shell exports ELECTRON_RUN_AS_NODE=1 for its own node children.
    # Inherited by the probe, the flag makes Electron skip app loading entirely
    # and behave as plain Node, which then rejects every switch the probe needs:
    # the run dies with `bad option: --recipe=stock` and exit code 9 — Node's
    # "bad option" code, not Electron's. Measured, not guessed: the same argv
    # works the moment this one variable is dropped. `NODE_OPTIONS` comes from
    # the same place and only earns a warning line from Electron, but it is
    # stripped for the same reason: none of this shell's node configuration has
    # any business inside a window probe.
    env = {
        k: v
        for k, v in os.environ.items()
        if k not in ("ELECTRON_RUN_AS_NODE", "NODE_OPTIONS")
    }

    proc = subprocess.Popen(
        [
            str(EXE),
            # Chromium's GPU process dies with 0xC0000005 under this agent shell
            # and takes the whole app down with "GPU process isn't usable.
            # Goodbye." — measured here, not assumed, and it happens whether or
            # not NODE_OPTIONS is stripped. `--no-sandbox` is what makes it
            # survive. It costs nothing for this measurement: the backdrop is
            # composited by DWM behind the window, which is independent of how
            # Chromium renders the page inside it.
            "--no-sandbox",
            f"--recipe={recipe}",
            f"--report={report}",
            f"--settle={settle}",
            f"--top={1 if on_top else 0}",
            f"--user-data-dir={USERDATA}",
        ],
        cwd=str(PROBE),
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    deadline = time.monotonic() + 30
    payload = None
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            raise SystemExit(
                f"probe exited early with code {proc.returncode}"
                + (f" (last stage: {payload['stage']})" if payload else "")
            )
        if report.exists():
            try:
                payload = json.loads(report.read_text("utf-8"))
            except json.JSONDecodeError:
                payload = None
            if payload and payload.get("stage") == "ready":
                break
        time.sleep(0.15)
    if payload is None or payload.get("stage") != "ready":
        kill(proc)
        stage = payload["stage"] if payload else "no report at all"
        raise SystemExit(f"probe never reached ready for {recipe!r} (stopped at: {stage})")
    return proc, payload


def kill(proc):
    """Whole tree: Electron's GPU and renderer children outlive a bare kill()."""
    subprocess.run(
        ["taskkill", "/F", "/T", "/PID", str(proc.pid)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
    )


def printwindow_frame(recipe):
    """The recipe window as `appshot.py` would capture it.

    The probe names its windows `probe-<recipe>`, so the window is found by title
    rather than by a handle passed back from the child process. Returns None if
    it is not on screen, because a missing window must degrade to "not measured"
    and never to a zero that reads like "nothing came through".
    """
    wins = find_windows(f"probe-{recipe}", min_w=200, min_h=150, include_tool_windows=True)
    if not wins:
        return None
    win = max(wins, key=lambda w: w["w"] * w["h"])
    img, _ok = printwindow_grab(win)
    return img


def measure(recipe, settle, keep_png, on_top=True):
    proc, payload = launch(recipe, settle, on_top)
    try:
        # A moment past READY, so the compositor has actually presented the
        # window rather than the first frame after show().
        time.sleep(0.7)
        scale = payload["scale"]
        ref = payload["ref"]
        test = payload["test"]
        # bbox is (left, top, right, bottom). Building it as
        # (x, y, width, height) — which is what the first version did — silently
        # truncates the capture to `height * scale` pixels tall and then trips
        # every rect computed below it. `ref` bounds come straight from
        # getBounds() and are DIP; the multiplier turns them into the physical
        # pixels ImageGrab works in.
        box = (
            int(round(ref["x"] * scale)),
            int(round(ref["y"] * scale)),
            int(round((ref["x"] + ref["width"]) * scale)),
            int(round((ref["y"] + ref["height"]) * scale)),
        )
        shot = ImageGrab.grab(bbox=box, all_screens=True)
        # Second reading, other instrument, same window, same instant. Before
        # the kill: PrintWindow needs the window to still exist.
        pw = printwindow_frame(recipe)
    finally:
        kill(proc)

    # Every sub-rect in physical pixels, relative to the captured image. The
    # 8 px inset keeps window borders, rounded-corner antialiasing and the drop
    # shadow out of the measurement.
    inset = max(2, int(round(8 * scale)))
    tx = int(round((test["x"] - ref["x"]) * scale))
    ty = int(round((test["y"] - ref["y"]) * scale))
    tw = int(round(test["width"] * scale))
    th = int(round(test["height"] * scale))

    W, H = shot.size
    if tx + tw + inset > W or ty + th + inset > H or tx - inset <= inset or ty - inset <= inset:
        raise SystemExit(
            f"the test window does not sit inside the reference in the capture "
            f"(shot {W}x{H}, test at {tx},{ty} {tw}x{th}, inset {inset})"
        )

    ring_top = shot.crop((inset, inset, W - inset, max(inset + 1, ty - inset)))
    ring_bottom = shot.crop((inset, ty + th + inset, W - inset, H - inset))
    ring_left = shot.crop((inset, ty + inset, max(inset + 1, tx - inset), ty + th - inset))
    ring_right = shot.crop((tx + tw + inset, ty + inset, W - inset, ty + th - inset))

    # The caption strip is excluded: with `titleBarOverlay` the top 40 px are
    # drawn by the OS and say nothing about the recipe's backdrop.
    caption = int(round(48 * scale))
    inner = shot.crop(
        (tx + inset, ty + caption, tx + tw - inset, ty + th - inset)
    )

    ring_hf = max(
        edge_energy(r) for r in (ring_top, ring_bottom, ring_left, ring_right)
        if r.width > 4 and r.height > 4
    )
    inner_hf = edge_energy(inner)
    ratio = inner_hf / ring_hf if ring_hf > 0 else 0.0
    luma = mean_luma(inner)

    # What the ring is matters as much as how busy it is.
    #
    # The first version gated on edge energy alone, and that gate is not enough:
    # any window sitting on top of the probe has edges too. Measured, not
    # imagined — a run that landed while air had a chat client over the probe's
    # corner of the desktop produced ring_hf 42 (well over the threshold), six
    # near-identical rows, and a clean-looking table that was in fact a
    # photograph of his chat window measured six times.
    #
    # The fix is to check the ring's CONTENT, which is knowable exactly: it is
    # the checkerboard, so it must average to CHECKER_MEAN whatever the recipe
    # does to the middle. Nothing else on a desktop is guaranteed to.
    ring_luma = max(
        mean_luma(r) for r in (ring_top, ring_bottom, ring_left, ring_right)
        if r.width > 4 and r.height > 4
    )

    if ring_hf < 12:
        verdict = "UNREADABLE — the reference itself is not visible on screen"
    elif abs(ring_luma - CHECKER_MEAN) > 12:
        verdict = (
            f"UNREADABLE — the ring is not the checkerboard (mean {ring_luma:.0f}, "
            f"expected {CHECKER_MEAN:.0f}); something was covering the probe windows"
        )
    elif ratio >= 0.55:
        verdict = "SHARP — the desktop comes through unfiltered"
    elif ratio < 0.12 and abs(luma - CHECKER_MEAN) > 45:
        verdict = "HIDDEN — nothing came through; the window is opaque"
    elif ratio < 0.12:
        verdict = "BLURRED — the pattern is there, smoothed to nothing"
    else:
        verdict = "PARTLY BLURRED — some edge energy survives"

    if keep_png:
        OUT.mkdir(parents=True, exist_ok=True)
        shot.save(OUT / f"{recipe}.png")
        if pw is not None:
            pw.save(OUT / f"{recipe}-printwindow.png")

    # The PrintWindow reading is normalised against the same ring, so the two
    # ratios are directly comparable: both answer "how much of the checkerboard's
    # edge energy survived", just measured through different instruments.
    pw_hf = edge_energy(pw) if pw is not None else None
    pw_luma = mean_luma(pw) if pw is not None else None

    return {
        "recipe": recipe,
        "ring_hf": round(ring_hf, 2),
        "ring_luma": round(ring_luma, 1),
        "inner_hf": round(inner_hf, 2),
        "ratio": round(ratio, 3),
        "inner_luma": round(luma, 1),
        "inner_size": f"{inner.width}x{inner.height}",
        "verdict": verdict,
        "valid": not verdict.startswith("UNREADABLE"),
        "pw_ratio": None if pw_hf is None else round(pw_hf / ring_hf, 3) if ring_hf > 0 else 0.0,
        "pw_luma": None if pw_luma is None else round(pw_luma, 1),
        "pw_size": None if pw is None else f"{pw.width}x{pw.height}",
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", action="append", default=[], help="recipe name, repeatable")
    ap.add_argument("--settle", type=float, default=900, help="ms the probe waits before reporting")
    ap.add_argument("--list", action="store_true", help="print the recipe names and exit")
    ap.add_argument("--no-png", action="store_true", help="skip writing the captured frames")
    ap.add_argument(
        "--no-top",
        action="store_true",
        help="let the probe windows fall behind other windows, to fire the "
             "occlusion check on purpose (see README, 材质探针)",
    )
    args = ap.parse_args()

    names = [
        "stock",
        "acrylic",
        "none",
        "bg-only",
        "none+transparent",
        "acrylic+transparent",
        "switch",
        # The demotion pair. `switch` only ever went upward (none -> acrylic);
        # the settings toggle spends half its life going the other way, and air
        # reported a white screen on exactly that path. `unswitch` is the mirror
        # image, and the two `+glass` recipes repeat both directions with the
        # theme's own translucent field painted over the window, because that is
        # the configuration he is actually running.
        "unswitch",
        "none+glass",
        "unswitch+glass",
        # The two candidates for getting back out of the material once it is
        # on. If `none` wedges the window (measured: it does — luma 254.9,
        # opaque white), the fix is either to send no material at all or to
        # hand the choice back to DWM, and which of those works is not
        # something Electron's docs say.
        "unset",
        "auto",
    ]
    if args.list:
        for n in names:
            print(n)
        return 0

    if not EXE.exists():
        print(f"probe runtime missing: {EXE}")
        print("rebuild it by hard-linking the install (see README, 材质探针)")
        return 2

    todo = args.only or names
    unknown = [n for n in todo if n not in names]
    if unknown:
        print(f"unknown recipe(s): {', '.join(unknown)}; known: {', '.join(names)}")
        return 2

    print(f"{'recipe':<20} {'ring':>7} {'ringL':>7} {'inner':>7} {'ratio':>7} {'luma':>7}  "
          f"{'pw_ratio':>8} {'pw_luma':>7}  verdict")
    rows = []
    for recipe in todo:
        row = measure(recipe, args.settle, not args.no_png, not args.no_top)
        rows.append(row)
        pw_ratio = "n/a" if row["pw_ratio"] is None else f"{row['pw_ratio']:.3f}"
        pw_luma = "n/a" if row["pw_luma"] is None else f"{row['pw_luma']:.1f}"
        print(
            f"{row['recipe']:<20} {row['ring_hf']:>7} {row['ring_luma']:>7} "
            f"{row['inner_hf']:>7} {row['ratio']:>7} {row['inner_luma']:>7} "
            f"{pw_ratio:>8} {pw_luma:>7}  {row['verdict']}"
        )

    # The two instruments have to be read against each other, so the gap gets
    # said out loud rather than left for the reader to eyeball across columns.
    blind = [r for r in rows if r["pw_ratio"] is not None and abs(r["ratio"] - r["pw_ratio"]) > 0.2]
    if blind:
        names = ", ".join(r["recipe"] for r in blind)
        print(
            f"\nPrintWindow disagrees with the screen for: {names}.\n"
            "  Those are exactly the recipes whose look comes from window transparency.\n"
            "  PrintWindow returns premultiplied pixels with the alpha channel dropped, so\n"
            "  a see-through window reaches it as a black rectangle — indistinguishable\n"
            "  from an opaque black one. It is not blind to the blur; it is blind to the\n"
            "  fix, which is worse: the rows above are what air's question was about."
        )

    (OUT / "results.json").parent.mkdir(parents=True, exist_ok=True)
    (OUT / "results.json").write_text(json.dumps(rows, indent=2) + "\n", "utf-8")
    # The per-run report files are scratch, and they are written inside the
    # linked runtime tree rather than in _preview. Left behind they accumulate
    # one file per recipe per invocation, which is clutter that looks like state.
    for stale in PROBE.glob("_report*.json"):
        stale.unlink()
    print(f"\nframes -> {OUT}")

    bad = [r for r in rows if not r["valid"]]
    if bad:
        # A table of unreadable rows is not a result, and `results.json` has just
        # been written from it — say so, and fail, rather than let a reader take
        # the numbers at face value.
        print(
            f"\n{len(bad)} of {len(rows)} row(s) are not usable: "
            + ", ".join(r["recipe"] for r in bad)
            + "\n  Nothing here is a measurement of a window material. Re-run when the\n"
            "  desktop is not busy — the probe raises its windows, but a window that\n"
            "  is not on screen cannot be photographed."
        )
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
