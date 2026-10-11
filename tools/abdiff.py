"""
A/B pixel differ for tools/ab.mjs.

Crops each variant cell out of the composite screenshot and diffs the pairs that
matter. The point is not "does the CSS exist" but "how many pixels moved", which
is the only honest answer to "this setting does nothing".

    python tools/abdiff.py
"""
import json
import sys
from pathlib import Path

from PIL import Image, ImageChops

HERE = Path(__file__).resolve().parent
AB = HERE / "_preview" / "ab"

grid = json.loads((AB / "grid.json").read_text(encoding="utf-8"))
CW, CH, GAP, COLS = grid["w"], grid["h"], grid["gap"], grid["cols"]
ORDER, LABELS = grid["order"], grid["labels"]
LABEL = dict(zip(ORDER, LABELS))

# Pairs worth measuring. Anything below ~1% of pixels moved is not something a
# human will notice on a live desktop.
PAIRS = [
    ("baseline", "off", "主题总开关"),
    ("baseline", "nosurface", "毛玻璃开关"),
    ("baseline", "nocursor", "指针开关"),
    ("baseline", "noripple", "点击特效开关"),
    ("intlow", "inthigh", "强度 0.2 -> 2"),
    ("baseline", "aurora", "色调 ice -> aurora(=slate)"),
]


def crop(img, idx):
    r, c = divmod(idx, COLS)
    x = GAP + c * (CW + GAP)
    y = GAP + r * (CH + GAP)
    return img.crop((x, y, x + CW, y + CH))


def pixels(img):
    """Every pixel as colour tuples. `getdata` is deprecated in Pillow 12 and
    removed in 14; `get_flattened_data` replaces it and returns the same thing."""
    return list((getattr(img, "get_flattened_data", None) or img.getdata)())


def diff(a, b):
    d = ImageChops.difference(a.convert("RGB"), b.convert("RGB"))
    px = pixels(d)
    n = len(px)
    moved = sum(1 for p in px if max(p) > 2)
    moved_any = sum(1 for p in px if max(p) > 0)
    mean = sum(sum(p) for p in px) / (n * 3)
    worst = max(max(p) for p in px)
    return {
        "pct": 100.0 * moved / n,
        "pct_any": 100.0 * moved_any / n,
        "mean": mean,
        "worst": worst,
    }


def verdict(d):
    if d["pct"] < 0.5:
        return "看不出（基本没变化）"
    if d["pct"] < 3.0:
        return "很弱"
    if d["pct"] < 15.0:
        return "可见"
    return "明显"


def run(scheme):
    path = AB / f"ab-{scheme}.png"
    if not path.exists():
        print(f"  missing {path}")
        return
    img = Image.open(path)
    cells = {vid: crop(img, i) for i, vid in enumerate(ORDER)}

    print(f"\n===== {scheme} =====  ({img.size[0]}x{img.size[1]})")
    print(f"{'对比':<22}{'变化像素%':>10}{'任意差异%':>10}{'平均Δ':>8}{'最大Δ':>7}   判定")
    for left, right, name in PAIRS:
        if left not in cells or right not in cells:
            print(f"{name:<22}  (cell missing)")
            continue
        d = diff(cells[left], cells[right])
        print(
            f"{name:<22}{d['pct']:>9.2f}%{d['pct_any']:>9.2f}%"
            f"{d['mean']:>8.2f}{d['worst']:>7}   {verdict(d)}"
        )
    print(f"  ({LABEL.get('baseline', 'baseline')} 作为基准；'变化像素%' = RGB 任一通道差 >2 的像素占比)")


if __name__ == "__main__":
    if not AB.exists():
        print("run `node tools/ab.mjs` first")
        sys.exit(1)
    for s in ("light", "dark"):
        run(s)
