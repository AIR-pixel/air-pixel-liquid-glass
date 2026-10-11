"""
Colour statistics for a PNG, built for one job: telling a wallpaper that paints
from a surface that merely looks tinted.

Counting distinct colours does not work. The live DSH window measured 163
distinct colours across its whole main pane while showing no wallpaper at all —
the count was coming from text antialiasing, not from a gradient. What separates
the two cases is spatial: a gradient makes the mean colour differ from one part
of the pane to another, while a flat composite keeps every region identical.

So the headline number is `spread` — the largest per-channel difference between
the means of a 3x3 grid of cells.

    python tools/pixstat.py shot.png [--box x0,y0,x1,y1]

Prints one JSON object.
"""
import argparse
import json
import sys

from PIL import Image


def pixels(img):
    """Every pixel of `img` as a flat sequence of colour tuples.

    `Image.getdata()` started warning in Pillow 12 and is scheduled to go away
    in Pillow 14 (2027-10-15); `get_flattened_data` is the replacement and
    returns the identical sequence (verified on this Pillow, 12.3.0). The
    fallback is here because a tool that only needs `pip install pillow` must
    not break on whichever version the reader happens to have — a measurement
    tool that refuses to run is worse than one that prints a warning.
    """
    getter = getattr(img, "get_flattened_data", None) or img.getdata
    return list(getter())


def cell_means(img, box, cols=3, rows=3):
    if box is not None:
        img = img.crop(box)
    w, h = img.size
    out = []
    for r in range(rows):
        for c in range(cols):
            x0, x1 = c * w // cols, (c + 1) * w // cols
            y0, y1 = r * h // rows, (r + 1) * h // rows
            cell = img.crop((x0, y0, x1, y1))
            px = pixels(cell.convert("RGB"))
            if not px:
                continue
            n = len(px)
            out.append(tuple(sum(p[i] for p in px) // n for i in range(3)))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("image")
    ap.add_argument("--box", help="x0,y0,x1,y1")
    args = ap.parse_args()

    box = None
    if args.box:
        box = tuple(int(v) for v in args.box.split(","))

    img = Image.open(args.image).convert("RGB")
    whole = pixels(img)
    uniq = len(set(whole))
    means = cell_means(img, box)
    spread = 0
    for i, a in enumerate(means):
        for b in means[i + 1:]:
            spread = max(spread, max(abs(a[k] - b[k]) for k in range(3)))

    # `overall` and `unique` are whole-image on purpose: they answer "does this
    # screenshot show a gradient anywhere", and cropping them would quietly
    # change what they mean.
    #
    # `box_mean` is the one the README's 透出桌面 table needs, and it exists
    # because that table was quoting a number nobody could re-derive: the mean
    # of the region, which the 9 cells imply but do not print. A figure that
    # cannot be reproduced with one command is a figure that will be wrong the
    # next time somebody edits the page above it and does not notice.
    box_mean = None
    if box is not None:
        crop = img.crop(box)
        px = pixels(crop)
        if px:
            box_mean = [sum(p[i] for p in px) // len(px) for i in range(3)]

    print(json.dumps({
        "size": list(img.size),
        "unique": uniq,
        "cells": [list(m) for m in means],
        "spread": spread,
        "overall": [sum(p[i] for p in whole) // len(whole) for i in range(3)],
        "box_mean": box_mean,
        "box_luma": None if box_mean is None else round(
            box_mean[0] * 0.299 + box_mean[1] * 0.587 + box_mean[2] * 0.114
        ),
    }))
    return 0


if __name__ == "__main__":
    sys.exit(main())
