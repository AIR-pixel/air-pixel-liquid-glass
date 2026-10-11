"""
SUPERSEDED by tools/ladder.mjs — kept only for the labelled-grid helper.

The renders this composes are `cascade/{off,low,mid,high}.png`, which show the
*backdrop* and almost nothing else: cascade.mjs deliberately uses a minimal body
because its job is to prove the wallpaper survives the official stylesheet.
Stitching four of those into a "what the slider does" graphic was a claim the
artifact could not support, and air called it: "和你的演示图效果完全不一致".
Use `node tools/ladder.mjs` instead — same app shell as preview.mjs.

The single most useful picture for this theme is the slider's whole range side
by side, because the complaint it answers is "效果强度基本没区别". The captions
carry the two numbers that decide whether the ranges actually differ, both
measured by `cascade.mjs` on the real official stylesheet rather than asserted
here:

  * 面板不透明度 — computed alpha of `--dsw-alias-bg-base`. 1.0 means the shell
    is stock-opaque, 0.08 means the wallpaper carries the window.
  * 区域对比 — the max per-channel delta between the means of a 3x3 grid of
    regions. This is the number that says "the wallpaper is on screen": it is 0
    for the opaque control, because every region is then the same colour.

    python tools/mkladder.py            # uses the numbers from the last run
"""
import argparse
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent
SRC = ROOT / "_preview" / "cascade"
OUT = SRC / "intensity-ladder.png"

BG = (13, 17, 23)
CARD = (22, 27, 34)
LINE = (48, 54, 61)
FG = (230, 237, 243)
MUTED = (139, 148, 158)
ACCENT = (88, 166, 255)

# caption, file, bg-base alpha, --dsl-glass, region-mean spread
DEFAULT_ROWS = [
    ("强度 0.2  ·  最小档", "low", "0.836", "0.18", 1),
    ("强度 1.0  ·  默认档", "mid", "0.453", "0.60", 8),
    ("强度 2.0  ·  全玻璃态", "high", "0.080", "1.00", 30),
    ("表面关闭  ·  对照组", "off", "1.000", "0.00", 0),
]


def load_font(size, bold=False):
    for name in (
        "msyhbd.ttc" if bold else "msyh.ttc",
        "segoeui.ttf",
        "arial.ttf",
    ):
        p = Path("C:/Windows/Fonts") / name
        if p.exists():
            try:
                return ImageFont.truetype(str(p), size)
            except OSError:
                continue
    return ImageFont.load_default()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(OUT))
    ap.add_argument("--cell-w", type=int, default=560)
    args = ap.parse_args()

    cells = []
    for caption, slug, alpha, glass, spread in DEFAULT_ROWS:
        p = SRC / f"{slug}.png"
        if not p.exists():
            print(f"missing render: {p}", file=sys.stderr)
            return 1
        im = Image.open(p).convert("RGB")
        h = round(im.height * args.cell_w / im.width)
        cells.append((caption, im.resize((args.cell_w, h), Image.LANCZOS), alpha, glass, spread))

    cw, ch = args.cell_w, cells[0][1].height
    pad, cap_h, head_h = 26, 78, 96
    cols = 2
    rows = (len(cells) + cols - 1) // cols
    W = pad + cols * (cw + pad)
    H = head_h + pad + rows * (ch + cap_h) + (rows - 1) * pad

    canvas = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(canvas)
    f_title = load_font(30, bold=True)
    f_sub = load_font(16)
    f_cap = load_font(19, bold=True)
    f_metric = load_font(16)

    d.text((pad, pad), "液态玻璃主题 · 效果强度阶梯", font=f_title, fill=FG)
    d.text(
        (pad, pad + 44),
        "官方样式表 + 真实 Chromium 渲染（headless Edge），非模拟页 · 数值由 cascade.mjs 实测",
        font=f_sub,
        fill=MUTED,
    )
    d.line([(pad, head_h - 8), (W - pad, head_h - 8)], fill=LINE, width=1)

    for i, (caption, im, alpha, glass, spread) in enumerate(cells):
        c, r = i % cols, i // cols
        x = pad + c * (cw + pad)
        y = head_h + pad + r * (ch + cap_h + pad)

        canvas.paste(im, (x, y))
        d.rectangle([x, y, x + cw - 1, y + ch - 1], outline=LINE, width=1)

        cy = y + ch + 10
        d.text((x, cy), caption, font=f_cap, fill=FG if spread else MUTED)
        d.text(
            (x, cy + 28),
            f"面板不透明度 {alpha}     玻璃度 {glass}     区域对比 {spread}",
            font=f_metric,
            fill=ACCENT if spread else MUTED,
        )

    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    canvas.save(args.out)
    print(f"wrote {args.out} ({W}x{H})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
