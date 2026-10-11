"""
One image that answers "is it still blurry": the two frames `materialprobe.py`
captures, stacked and labelled, with each one's measured ratio printed on it.

The probe's numbers are the evidence, but a number can be argued with. The
checkerboard cannot: `none` lets an 8px pattern through pixel-for-pixel, and
`acrylic` smears it into a flat grey field, which is exactly what "拉满还是高斯
模糊" describes. This script exists so that comparison is one file to look at
instead of two to hold in your head.

    python tools/materialab.py [recipe-a recipe-b]

Defaults to `acrylic none` — the order is deliberate, the wrong one first, so
the eye reads it as a before/after rather than two unrelated pictures.
"""
import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
FRAMES = ROOT / "tools" / "_preview" / "material"
OUT = ROOT / "tools" / "_preview" / "material-ab.png"

PAD = 24
LABEL = 46
GAP = PAD
INK = (240, 240, 244)
SUB = (150, 156, 168)
BG = (24, 26, 31)


def load_font(size, bold=False):
    for name in ("msyhbd.ttc" if bold else "msyh.ttc", "segoeui.ttf", "arial.ttf"):
        p = Path("C:/Windows/Fonts") / name
        if p.exists():
            try:
                return ImageFont.truetype(str(p), size)
            except OSError:
                continue
    return ImageFont.load_default()


def readings():
    """The probe's own verdicts, keyed by recipe, so the picture cannot drift
    away from the table it is standing in for."""
    path = FRAMES / "results.json"
    if not path.exists():
        return {}
    return {r["recipe"]: r for r in json.loads(path.read_text("utf-8"))}


def main():
    recipes = sys.argv[1:] or ["acrylic", "none"]
    if len(recipes) != 2:
        print("give zero or two recipe names, e.g. `materialab.py acrylic none`")
        return 2

    rows = readings()
    missing = [r for r in recipes if not (FRAMES / f"{r}.png").exists()]
    if missing:
        print(f"no frame for {', '.join(missing)}; run tools/materialprobe.py first")
        return 2

    tiles = []
    for recipe in recipes:
        img = Image.open(FRAMES / f"{recipe}.png").convert("RGB")
        tiles.append((recipe, img))

    w = max(img.width for _, img in tiles)
    body = sum(img.height + LABEL for _, img in tiles) + GAP * (len(tiles) - 1)
    canvas = Image.new("RGB", (w + PAD * 2, body + PAD * 2 + LABEL), BG)
    draw = ImageDraw.Draw(canvas)
    f_title = load_font(26, bold=True)
    f_label = load_font(22, bold=True)
    f_sub = load_font(18)

    draw.text((PAD, PAD), "窗口材质 · 真截屏 · 同一个 8px 棋盘在后面", font=f_title, fill=INK)

    y = PAD + LABEL
    for recipe, img in tiles:
        row = rows.get(recipe, {})
        ratio = row.get("ratio")
        luma = row.get("inner_luma")
        verdict = row.get("verdict", "")

        draw.text((PAD, y + 8), recipe, font=f_label, fill=INK)
        if ratio is not None:
            note = f"真截屏 {ratio:.3f} / {luma:.1f}   {verdict}"
            if row.get("pw_ratio") is not None:
                # Both instruments in the picture, because the whole point of the
                # pair is that they do not always agree — and the recipes where
                # they disagree are the see-through ones.
                note += f"   ·   PrintWindow {row['pw_ratio']:.3f} / {row['pw_luma']:.1f}"
            draw.text((PAD + f_label.getlength(recipe) + 16, y + 12), note,
                      font=f_sub, fill=SUB)
        y += LABEL
        canvas.paste(img, (PAD, y))
        y += img.height + GAP

    canvas.save(OUT)
    print(f"{OUT.relative_to(ROOT)}  {canvas.width}x{canvas.height}")
    for recipe, _ in tiles:
        row = rows.get(recipe, {})
        if row:
            print(f"  {recipe:<12} ratio {row['ratio']:.3f}  luma {row['inner_luma']:.1f}  {row['verdict']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
