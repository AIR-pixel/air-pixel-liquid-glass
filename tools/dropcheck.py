"""
Attribute the difference between a pressed ripple and an unpressed control.

    python tools/dropcheck.py tools/_preview/ripple.png tools/_preview/ripple-control.png

Three buckets, and the contract each one enforces. This tool has now been
through two opposite regimes, so both halves of the current rule are recorded
here rather than in a commit message:

  core     `d < 0.8R` — over a uniform region this must stay ~unchanged.
           Nothing may FILL the disc. A uniform value shift clipped to a
           `border-radius: 50%` disc IS that disc: wherever the backdrop is
           darker than the shift, the edge becomes visible as a ring. That is
           how the old `brightness()` lift announced itself, and it is the
           artefact both previous rewrites existed to remove.

  rim      `0.84R ≤ d ≤ 1.06R` — over the same uniform region this must
           CHANGE. This is the newer half, and it is a reversal of a rule that
           used to say the opposite. The pure lens is invisible on flat
           content (measured Δ ≤ 5 per channel), the app's large surfaces are
           near-uniform tokens, so the press was invisible where it was most
           used. The fix is the specular rim — the *edge* of the glass wall,
           which is what Apple's own documentation says carries the cue: "glass
           has no solid fill, so the bright rim is often the strongest cue for
           where a control begins and ends". So: no fill, but a rim.

           Two things are measured here and the second is the one that decides
           whether the design survives:

             · coverage — the annulus has to register at all.
             · `angular_contrast` — the rim is split into 12 sectors of 30° and
               the ratio of the brightest sector's mean delta to the dimmest
               one is reported. A rim of EVEN alpha is a drawn circle, and that
               is the exact failure three previous designs died for ("依旧像是
               手绘"). A lit edge is bright where the light is and nearly gone
               on the far side, so the ratio is the difference between the two.
               A uniform ring lands near 1.0; a lit one should be several times
               higher. `brightest_deg` then says whether the light comes from
               where the theme's own light pools are (upper left ≈ 225° in
               screen coordinates, y growing downward).

  outside  `1.1R < d < 1.3R` — must stay bit-identical, as before. The rim
           belongs to the disc the lens already has; anything showing up out
           here means a second, larger shape got drawn.

Prints one JSON object.
"""
import argparse
import json
import math
import sys

from PIL import Image

# The disc radius at intensity 2.0, which is what the specimen renders:
# `size = 64 + 76 * glassOf(intensity)`, and the visible disc is `size` wide.
R_AT_FULL_GLASS = 70

# 12 sectors of 30°: fine enough to resolve a lobe, coarse enough that every
# sector holds hundreds of pixels in the annulus and the means are stable.
SECTORS = 12
# Screen coordinates, y growing downward: 0° is right, 90° is down, 180° is
# left, 270° is up — so the upper-left lobe the theme's light pools point at
# sits at 225°.
LIGHT_FROM_DEG = 225.0


def empty_bucket():
    return {
        "n": 0,
        "changed": 0,
        "max": 0,
        "sum": 0,
        "sector_sum": [0.0] * SECTORS,
        "sector_n": [0] * SECTORS,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("pressed")
    ap.add_argument("control")
    ap.add_argument(
        "--press",
        action="append",
        default=None,
        help=f"x,y[,R] — repeatable; R defaults to {R_AT_FULL_GLASS} (the disc "
        "radius at intensity 2.0, which is what ripplelab.mjs renders)",
    )
    args = ap.parse_args()

    a = Image.open(args.pressed).convert("RGB")
    b = Image.open(args.control).convert("RGB")
    if a.size != b.size:
        print(json.dumps({"error": f"size mismatch {a.size} vs {b.size}"}))
        return 2
    pa, pb = a.load(), b.load()
    w, h = a.size

    spots = []
    for spec in args.press or ["180,120", "500,250", "810,370"]:
        parts = [int(v) for v in spec.split(",")]
        spots.append((parts[0], parts[1], parts[2] if len(parts) > 2 else R_AT_FULL_GLASS))

    out = {"size": [w, h], "presses": []}
    for cx, cy, rad in spots:
        buckets = {
            "core": empty_bucket(),
            "rim": empty_bucket(),
            "outside": empty_bucket(),
        }
        # Bounds generous enough to complete every annulus even near an edge.
        for y in range(max(0, cy - int(rad * 1.5)), min(h, cy + int(rad * 1.5) + 1)):
            for x in range(max(0, cx - int(rad * 1.5)), min(w, cx + int(rad * 1.5) + 1)):
                d = math.hypot(x - cx, y - cy)
                if d < rad * 0.8:
                    key = "core"
                elif rad * 0.84 <= d <= rad * 1.06:
                    key = "rim"
                elif rad * 1.1 < d < rad * 1.3:
                    key = "outside"
                else:
                    continue
                bucket = buckets[key]
                ca, cb = pa[x, y], pb[x, y]
                delta = max(abs(ca[i] - cb[i]) for i in range(3))
                bucket["n"] += 1
                bucket["sum"] += delta
                bucket["max"] = max(bucket["max"], delta)
                if key == "rim":
                    angle = math.degrees(math.atan2(y - cy, x - cx)) % 360.0
                    sector = int(angle // (360.0 / SECTORS)) % SECTORS
                    bucket["sector_sum"][sector] += delta
                    bucket["sector_n"][sector] += 1
                # > 2 rather than > 0: an unmodified pixel can still differ by a
                # step or two where the backdrop itself is a gradient and the
                # lens resamples it.
                if delta > 2:
                    bucket["changed"] += 1

        def summary(bucket):
            if not bucket["n"]:
                return None
            return {
                "changed_pct": round(100.0 * bucket["changed"] / bucket["n"], 2),
                "mean_delta": round(bucket["sum"] / bucket["n"], 2),
                "max_delta": bucket["max"],
            }

        rim = buckets["rim"]
        contrast = None
        if rim["n"]:
            means = [
                rim["sector_sum"][i] / rim["sector_n"][i]
                for i in range(SECTORS)
                if rim["sector_n"][i]
            ]
            if len(means) == SECTORS:
                lo = min(means)
                hi = max(means)
                brightest = means.index(hi)
                contrast = {
                    "sector_means": [round(m, 2) for m in means],
                    "min_sector": round(lo, 2),
                    "max_sector": round(hi, 2),
                    # The headline number: 1.0 is a drawn circle, higher is a lit
                    # edge. `None` when the dimmest sector is flat, which would
                    # mean the rim is a one-sided mark rather than an edge.
                    "ratio": round(hi / lo, 2) if lo > 0 else None,
                    "brightest_deg": round(brightest * (360.0 / SECTORS) + 180.0 / SECTORS, 1),
                    "off_axis_deg": round(
                        abs(((brightest * (360.0 / SECTORS) + 180.0 / SECTORS) - LIGHT_FROM_DEG + 180.0) % 360.0 - 180.0),
                        1,
                    ),
                }

        out["presses"].append(
            {
                "at": [cx, cy],
                "radius": rad,
                "core": summary(buckets["core"]),
                "rim": summary(rim),
                "angular_contrast": contrast,
                "outside": summary(buckets["outside"]),
            }
        )

    print(json.dumps(out, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
