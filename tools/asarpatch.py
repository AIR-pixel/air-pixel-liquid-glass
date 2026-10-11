"""
Give the DSH main window a desktop backdrop on Windows.

    python tools/asarpatch.py --check              # is it patched, and with what
    python tools/asarpatch.py                      # back up, then patch (material: none)
    python tools/asarpatch.py --material acrylic    # the old, blurred recipe
    python tools/asarpatch.py --revert              # restore the backup

WHY THIS EXISTS

air wants "效果强度调到最高时整个窗口透明", and then reported — correctly — that
what he had was "还是算是高斯模糊级别". The theme cannot deliver that on its own,
and the reason is not a missing CSS trick: the window has no transparent channel
at all. From app.asar -> lib/main.js, createWindow() @11074, the win32 branch
sets only `titleBarStyle` and `titleBarOverlay`; only the darwin branch gets
`vibrancy` + `backgroundColor: "#00000000"`.

The app is not averse to the idea: welcomeWindowOptions() @7775 already sets
`backgroundColor: "#00000000"` + `backgroundMaterial: "acrylic"` on win32, and
OverlayHost.create() @10679 already uses `transparent: true`. So this patch makes
the main window do what two of its three siblings already do.

WHY THE MATERIAL IS `none`, NOT `acrylic`

The first version of this patch copied the welcome window's recipe verbatim. It
worked — the desktop became visible — and it was wrong, because acrylic *is*
DWM's blurred material: the desktop arrived smeared, and no amount of CSS work
could undo it, because the blur happens in the compositor behind the window
rather than in the page.

That is worth stating plainly, because it cost two rounds. `--dsl-blur` had
already been driven to `blur(0px)` at the top of the intensity slider, read
straight out of the running renderer by tools/deskcheck.mjs, so every CSS-side
measurement agreed there was no blur left while air's window was still visibly
frosted. The blur was never in the page.

Which value to ask for instead was measured rather than argued, using
tools/materialprobe.py: the same Electron 44 build, a checkerboard of known edge
energy hidden behind the window, a real screen capture, six window recipes. The
number is how much of the reference's edge energy survives through the window —
1.0 would be pixel-identical, and the mean luma tells a smoothed pattern (which
still averages to its own mid-grey) apart from no pattern at all.

    recipe                   edge energy   luma    verdict
    stock (no patch)          0.025        252     opaque white
    acrylic                   0.011        100     the blur air is complaining about
    none                      0.875        129     sharp — the desktop itself
    backgroundColor only      0.005         32     opaque
    none + transparent        0.886        129     sharp
    acrylic + transparent     0.014        100     still blurred

Three things fall out of that table:

  · `none` is the whole fix. 0.875 of the reference edge energy means the
    checkerboard comes through essentially untouched, and a luma of exactly
    129.0 — the checkerboard's own average — is what an unblurred pattern reads.
  · `transparent: true` adds nothing on top (0.886 against 0.875), so the window
    shell does not have to change. That matters, because `transparent` is
    documented as requiring a frameless window and this patch does not need to
    go there.
  · The alpha alone is not enough: with no material key at all the window goes
    opaque. `backgroundColor: "#00000000"` is inert on a window that is not
    transparent — which is what the Electron docs say, and why this patch cannot
    be replaced by a colour.

The patch is deliberately still not `transparent`-based: Windows transparency has
a long history of losing rounded corners, shadows and resize smoothness, and the
measurement above says there is nothing to gain by taking that risk.

WHY THE CAPTION COLOUR IS LEFT ALONE

`titleBarOverlay.color` stays as `chromeFallbackFill()`, deliberately. From
lib/preload-app.cjs @585-636: a hidden probe whose background-color is
`var(--dsw-specific-sidebar-fill)` is appended, its computed colour is read
through a canvas, and it is sent over `dsh-desktop:windows-appearance`; main.js
@12008 then calls `setTitleBarOverlay({ color })` with whatever arrives. The
MutationObserver is wired to document.head (childList + subtree + characterData)
and to document.body's style attribute, and `send()` also runs once at install —
so the theme's stylesheet injection re-sends it.

The caption colour is therefore a design token the theme already owns, and it
updates live. Hard-coding transparency into the constructor would be a second,
worse copy of a mechanism that exists, and it would freeze the caption for a
window whose shell may well be opaque.

There is a runtime trap worth recording: main.js @11126 calls
`window.setBackgroundColor(chromeFallbackFill())`, which would undo
`backgroundColor: "#00000000"` — but it sits inside
`if (process.platform === "darwin")`, so it never runs here. It is why the
substitution is anchored to the whole win32 block instead of to the function
name, which appears three times.

WHAT IS NOT COVERED

The renderer must also stop painting over the material, or the material stays
invisible: the theme's `#dsl-wallpaper` is a full-viewport gradient. That half
lives in client.js behind the `desktop` option. The two halves only work
together.

UPDATE FRAGILITY

`resources/app.asar` is replaced wholesale by the auto-updater, so this must be
re-applied after every update. Both fuses permit it — measured on the shipped
binary: EnableEmbeddedAsarIntegrityValidation = 0, OnlyLoadAppFromAsar = 0.

Re-running is safe in both directions: an archive already patched with the
requested material is detected and skipped, and one patched with the *other*
material is refused with the two commands that change it, rather than being
silently left alone.
"""
import argparse
import datetime
import hashlib
import json
import os
import shutil
import struct
import sys
from pathlib import Path

ASAR = Path(r"C:\Users\air\AppData\Local\Programs\DeepSeek Harness\resources\app.asar")
MEMBER = "lib/main.js"

# Where the plugin host half looks for this path.
#
# The host cannot reliably work the install path out for itself: it runs inside
# the harness' node process, where `process.resourcesPath` does not exist and
# `process.execPath` points into the runtime's bundled node, so both of the
# obvious candidates miss and the panel is stuck on "cannot detect". Measured,
# not assumed — the plugin does read this directory for config.json, so this is
# the one path that is known to be readable from that process.
#
# The file is a *pointer*, not a claim. It names a candidate; the host still
# scans that file for MARKER and reports what it actually finds. So a stale
# pointer after an auto-update degrades to `stock` (the honest answer) instead of
# lying, and $DSH_ASAR still overrides it.
def store_dir() -> Path:
    home = os.environ.get("DSH_HOME", "").strip()
    base = Path(home) if home else Path.home() / ".dsh"
    return base / "plugins" / "air-pixel-liquid-glass"


def write_pointer(asar: Path, state: str, material=None) -> None:
    """Record the archive path next to the plugin's config. Never fatal."""
    target = store_dir() / "asar-pointer.json"
    payload = {
        "asar": str(asar),
        "state": state,
        "marker": marker_for(material) if material in MATERIALS else MARKER_PREFIX,
        # Named separately from `marker` so a reader does not have to parse the
        # comment text to learn which material is installed. Nothing reads it
        # yet; it is here because "patched" and "patched such that the desktop
        # is not blurred" are the two different facts this file now describes.
        "material": material,
        "writtenAt": datetime.datetime.now().isoformat(timespec="seconds"),
    }
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        temp = target.with_name(target.name + ".tmp")
        temp.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
        temp.replace(target)
        print(f"pointer   -> {target}")
    except OSError as error:
        # A missing pointer only costs the host its fallback candidate, which is
        # the thing this whole mechanism exists to provide. Loud, not fatal.
        print(f"could not write {target}: {error}")
        print("the host will have to find app.asar on its own; if the panel says")
        print("'cannot detect', set DSH_ASAR or check the log line it logs")


def asar_env_hint() -> None:
    """Print the $DSH_ASAR form for a manual override, for the README."""
    print(f"  $env:DSH_ASAR = '{ASAR}'")

# The win32 branch of createWindow(), and its replacement.
#
# Anchored to the whole block rather than to `chromeFallbackFill()`, which
# appears three times — see the darwin note in the module docstring.
OLD = (
    '\t\t...process.platform === "win32" && primary ? {\n'
    '\t\t\ttitleBarStyle: "hidden",\n'
    '\t\t\ttitleBarOverlay: {\n'
    '\t\t\t\theight: 40,\n'
    '\t\t\t\tcolor: chromeFallbackFill(),\n'
    '\t\t\t\tsymbolColor: nativeTheme.shouldUseDarkColors ? "#f9fafb" : "#0f1115"\n'
    '\t\t\t}\n'
    '\t\t} : {},'
)

# The materials this patch knows how to ask for.
#
# `none` is the default here, and for a window CREATED with it, it is the whole
# fix: it is the only value that lets the desktop through without DWM smoothing
# it first (see the measurement table in the module docstring).
#
# `acrylic` is kept because the two earlier versions of this patch installed it,
# and going back to the blurred look should cost a word rather than a
# re-derivation.
#
# `auto` is the value the WATCHER uses for "off", and it is not the same choice
# as the archive's `none`. They are the two halves of the same control and they
# are reached differently:
#
#   · the archive's material is chosen ONCE, at window creation, through the
#     `backgroundMaterial:` option — and there `none` is correct and measured
#     (desktop through, edge ratio 0.875);
#   · the watcher's is chosen AT RUNTIME, on a window that already exists and
#     already carries a material — and there `none` is a trap. Measured on this
#     Electron 44 / win32 build: demoting a live window from `acrylic` to
#     `none` does not restore it, it turns the window into an OPAQUE WHITE
#     surface (edge ratio 0.025, luma 254.9, and the PrintWindow frame reads
#     246.3 — it is white on both instruments, not a capture artifact). `auto`
#     is what actually undoes it: the same runtime call with `auto` lands on
#     edge ratio 0.875 / luma 129.0, byte-for-byte the reading a window created
#     with `none` gives.
#
# So the two names answer two different questions — "what should a new window
# be" and "how do I take the material back off a window that has one" — and
# collapsing them to one string is what produced the white screen air reported.
# `tools/materialprobe.py`'s `unswitch` recipe is the measurement; the
# `switch` recipe next to it only ever tested the other direction, which is why
# this went unnoticed.
MATERIALS = ("none", "acrylic", "auto")

# The watcher's runtime OFF, spelled once so the emitter and this file's own
# messages cannot drift apart. It is `auto`, not `none` — see above. verify.mjs
# reads this line out of the source to check it against index.js's
# `WINDOW_MATERIALS.off`, so its format is load-bearing: keep it the same shape
# as the JavaScript it mirrors.
RUNTIME_OFF = "auto"
RUNTIME_ON = "acrylic"

# The idempotency marker has to be a string that only this patch introduces.
# It cannot be `backgroundMaterial: "acrylic"`, which already appears in the file
# on the welcome window's branch (@7803) — that version reported "already
# patched" against a pristine archive and would have silently done nothing.
#
# It now also names the material, because "is the archive patched?" stopped being
# the only question. An archive patched with `acrylic` answers yes to it and
# still has the bug air reported, so a bare marker would have let this tool
# print "already patched" and change nothing — the exact failure mode the warning
# above is about. The prefix stays byte-identical so the host half's scan
# (`PATCH_MARKER` in index.js) keeps matching every variant without changing.
MARKER_PREFIX = "air-pixel-liquid-glass: the recipe"


def marker_for(material):
    """The comment line identifying this patch, material included."""
    return f"{MARKER_PREFIX} (material: {material})"


# Second marker, for the watcher appended at the end of the same file. It is
# separate so `--check` can say WHICH half is present: an archive patched by an
# earlier version of this tool has the recipe but no watcher, and that is
# exactly the state in which the panel's 窗口模糊 switch reports a request the
# main process never answers.
WATCHER_MARKER = "air-pixel-liquid-glass: window material watcher"


def build_watcher():
    """
    The window-material watcher, grafted at the end of lib/main.js.

    WHY A FILE, AND NOT SOMETHING DIRECT. The plugin host that serves
    /api/theme-liquid-glass/config runs in the harness' plain node process:
    `require("electron")` fails there, which the panel reported honestly as
    `no-electron` — a switch that was on and did nothing, with the cause
    unreachable from inside it. The main process is the only place
    `setBackgroundMaterial` exists, and the only channel to it that this
    project already owns is a patched `lib/main.js`. So: the host writes the
    request to `<resources>/liquid-glass-window-material.json`, this watcher
    applies it to the largest visible window, and writes a report the host
    reads back. Both markers name the same directory the archive lives in, so
    neither side has to guess a path.

    Everything is wrapped, and the wrapper swallows: a watcher that throws at
    import time would take the whole client down with it, and the worst case
    of NOT running is the window staying sharp — which is the status quo this
    code exists to change, not a new failure.
    """
    return (
        "\n// " + WATCHER_MARKER + " (added by tools/asarpatch.py)\n"
        "try {\n"
        "  const lg = createRequire(import.meta.url);\n"
        "  const lgFs = lg(\"node:fs\");\n"
        "  const lgPath = lg(\"node:path\");\n"
        "  const lgElectron = lg(\"electron\");\n"
        "  // `off` is NOT `none`, and the difference is the whole reason air saw a\n"
        "  // white window. This watcher only ever runs on a window that ALREADY\n"
        "  // EXISTS, and on this Electron build demoting a live window from\n"
        "  // `acrylic` to `none` does not take the material away — it paints the\n"
        "  // window opaque white (measured: tools/materialprobe.py `unswitch`,\n"
        "  // edge ratio 0.025 / luma 254.9, against 0.875 / 129.0 for `auto`).\n"
        "  // `auto` is what restores it. Keep in step with WINDOW_MATERIALS in\n"
        "  // index.js; the two halves have to agree on what OFF means, and\n"
        "  // verify.mjs asserts exactly that.\n"
        f"  const lgMaterials = {{ on: \"{RUNTIME_ON}\", off: \"{RUNTIME_OFF}\" }};\n"
        "  const lgWantedFile = lgPath.join(process.resourcesPath, \"liquid-glass-window-material.json\");\n"
        "  const lgReportFile = lgPath.join(process.resourcesPath, \"liquid-glass-window-report.json\");\n"
        "  const lgPick = () => {\n"
        "    try {\n"
        "      const wins = (lgElectron.BrowserWindow.getAllWindows() || []).filter((w) => {\n"
        "        try {\n"
        "          return !w.isDestroyed() && w.isVisible();\n"
        "        } catch {\n"
        "          return false;\n"
        "        }\n"
        "      });\n"
        "      if (wins.length === 0) return { win: null, why: \"no-window\" };\n"
        "      return {\n"
        "        win: wins.reduce((best, w) => {\n"
        "          const a = w.getBounds();\n"
        "          const b = best.getBounds();\n"
        "          return a.width * a.height > b.width * b.height ? w : best;\n"
        "        }),\n"
        "        why: null\n"
        "      };\n"
        "    } catch {\n"
        "      return { win: null, why: \"no-window\" };\n"
        "    }\n"
        "  };\n"
        "  const lgReport = (entry) => {\n"
        "    try {\n"
        "      lgFs.writeFileSync(lgReportFile, JSON.stringify(entry) + \"\\n\");\n"
        "    } catch {}\n"
        "  };\n"
        # What this process last asked the compositor for. It is the only
        # substitute for a readback on a build that has no getter, and it is
        # only ever consulted when there is nothing to read.
        "  let lgLast = null;\n"
        "  const lgApply = (via) => {\n"
        "    let wanted;\n"
        "    try {\n"
        "      wanted = JSON.parse(lgFs.readFileSync(lgWantedFile, \"utf8\"));\n"
        "    } catch {\n"
        "      return;\n"
        "    }\n"
        "    const seq = typeof wanted?.seq === \"number\" ? wanted.seq : null;\n"
        "    // Whitelist, not pass-through: this file is a hand-editable request\n"
        "    // to the compositor, and an arbitrary material name is a window that\n"
        "    // renders in a way nobody measured.\n"
        "    const material = wanted?.material === lgMaterials.on ? lgMaterials.on\n"
        "      : wanted?.material === lgMaterials.off ? lgMaterials.off : null;\n"
        "    if (material === null) {\n"
        "      lgReport({ seq, wanted: wanted?.material ?? null, material: null, applied: false, verified: false, active: false, why: \"unknown-material\", via, ts: Date.now() });\n"
        "      return;\n"
        "    }\n"
        "    const { win, why: pickWhy } = lgPick();\n"
        "    if (win === null) {\n"
        "      lgReport({ seq, wanted: material, material: null, applied: false, verified: false, active: false, why: pickWhy, via, ts: Date.now() });\n"
        "      return;\n"
        "    }\n"
        "    const lgRead = () => {\n"
        "      try {\n"
        "        const v = win.getBackgroundMaterial();\n"
        "        return typeof v === \"string\" ? v : null;\n"
        "      } catch {\n"
        "        return null;\n"
        "      }\n"
        "    };\n"
        "    const current = lgRead();\n"
        "    try {\n"
        "      // Read-then-set: a redundant setBackgroundMaterial re-triggers the\n"
        "      // DWM transition, which reads as a flicker on a window nobody\n"
        "      // touched. This runs on every window creation.\n"
        "      //\n"
        "      // A build with no getter answers `current === null` FOREVER, and a\n"
        "      // naive guard would then call set on every window creation — the\n"
        "      // flicker this guard exists to prevent, on the one build that\n"
        "      // cannot tell us it is happening. So when there is nothing to\n"
        "      // read, what was asked for last stands in for the readback.\n"
        "      if (current === null ? lgLast !== material : current !== material) win.setBackgroundMaterial(material);\n"
        "    } catch {\n"
        "      lgReport({ seq, wanted: material, material: null, applied: false, verified: false, active: false, why: \"set-failed\", via, ts: Date.now() });\n"
        "      return;\n"
        "    }\n"
        "    lgLast = material;\n"
        "    const after = lgRead();\n"
        "    if (after === null) {\n"
        # Applied and UNVERIFIABLE, which is a third state and not a failure.
        # Measured on this machine: Electron 44.0.0 / win32 has
        # `setBackgroundMaterial` but NO `getBackgroundMaterial`, on any window
        # and however it was created. So `active` stays false — it means "known
        # to be blurred", and here that cannot be known — while `applied` says
        # the request reached DWM and `verified: false` says nobody could read
        # it back. Calling that "did not take" is the same lie as calling it
        # "in effect", in the other direction.
        "      lgReport({ seq, wanted: material, material: null, applied: true, verified: false, active: false, why: \"no-getter\", via, ts: Date.now() });\n"
        "      return;\n"
        "    }\n"
        "    lgReport({\n"
        "      seq,\n"
        "      wanted: material,\n"
        "      material: after,\n"
        "      applied: true,\n"
        "      verified: after === material,\n"
        "      active: material === lgMaterials.on && after === lgMaterials.on,\n"
        "      why: after === material ? null : \"material-not-applied\",\n"
        "      via,\n"
        "      ts: Date.now()\n"
        "    });\n"
        "  };\n"
        "  try {\n"
        "    // The directory is watched rather than the file: the file does not\n"
        "    // exist until the host's first write, and a watch on a missing path\n"
        "    // throws on Windows. One directory watch also survives atomic\n"
        "    // replaces, and the filename filter keeps the app's own churn in\n"
        "    // this directory from re-triggering the apply.\n"
        "    lgFs.watch(process.resourcesPath, { persistent: false }, (event, filename) => {\n"
        "      if (filename === null || filename === \"liquid-glass-window-material.json\") setImmediate(() => lgApply(\"watch\"));\n"
        "    });\n"
        "  } catch {}\n"
        "  // Re-assert on every window: a material is a per-window property, and\n"
        "  // the main window is often not the first one created.\n"
        "  //\n"
        "  // And re-assert when a window is SHOWN, not only when it is created.\n"
        "  // Measured on this client: the primary window is constructed with\n"
        "  // `show: false` — `createWindow(appPreload, false, true)` — and only\n"
        "  // becomes visible afterwards, so the creation hook lands at exactly\n"
        "  // the moment there is no visible window to set. The boot report said\n"
        "  // `no-window` and nothing ever followed it: no window is created\n"
        "  // later, and nothing fires when one becomes visible. `via` in the\n"
        "  // report is what makes these two triggers separable after the fact.\n"
        "  lgElectron.app.on(\"browser-window-created\", (event, win) => {\n"
        "    try {\n"
        "      win.on(\"show\", () => setImmediate(() => lgApply(\"shown\")));\n"
        "    } catch {}\n"
        "    setImmediate(() => lgApply(\"created\"));\n"
        "  });\n"
        "  setImmediate(() => lgApply(\"boot\"));\n"
        "} catch {}\n"
    )


def build_new(material):
    """
    The win32 primary block, rewritten to ask for `material`.

    Both added lines earn their place, and the measurement says how: without
    `backgroundColor` the client area simply is not see-through at all (with no
    material key present the window reads 0.005 of the reference edge energy —
    an opaque surface), and `backgroundMaterial` is what decides whether what
    shows through is the desktop itself or DWM's blurred copy of it (0.875
    against 0.011).
    """
    return (
        '\t\t...process.platform === "win32" && primary ? {\n'
        '\t\t\ttitleBarStyle: "hidden",\n'
        '\t\t\ttitleBarOverlay: {\n'
        '\t\t\t\theight: 40,\n'
        '\t\t\t\tcolor: chromeFallbackFill(),\n'
        '\t\t\t\tsymbolColor: nativeTheme.shouldUseDarkColors ? "#f9fafb" : "#0f1115"\n'
        '\t\t\t},\n'
        f'\t\t\t// {marker_for(material)}\n'
        '\t\t\t// The caption colour is left alone because the renderer\n'
        '\t\t\t// overrides it with --dsw-specific-sidebar-fill.\n'
        '\t\t\tbackgroundColor: "#00000000",\n'
        f'\t\t\tbackgroundMaterial: "{material}"\n'
        '\t\t} : {},'
    )


def installed_material(text):
    """
    Which material `text` carries, or None when it is unpatched.

    An archive patched by an earlier version of this tool carries a marker that
    did not name a material; it reports `acrylic`, because that is what those
    versions installed — and it is also the value that `--material acrylic`
    would reproduce, so re-running at the default is enough to move it off.
    """
    for material in MATERIALS:
        if marker_for(material) in text:
            return material
    if MARKER_PREFIX in text:
        return "acrylic"
    return None


def parse(raw):
    """
    Header framing, derived from the observed file rather than assumed.

    [0:4] = 4, [4:8] = json_size + 8, [8:12] = json_size + 4, [12:16] =
    json_size, JSON at 16 with no padding, bodies at 16 + json_size. Offsets in
    the directory are relative to that body start. All four of these were read
    off the shipped archive (json_size 3392048, header_size 3392056) and are
    re-checked rather than trusted, because a wrong framing assumption would
    produce an archive that loads and then reads garbage.
    """
    word0, header_size, word8 = struct.unpack_from("<III", raw, 0)
    json_size = struct.unpack_from("<I", raw, 12)[0]
    base = 8 + header_size
    for label, ok in (
        ("word 0 is 4", word0 == 4),
        ("word 8 is json_size + 4", word8 == json_size + 4),
        ("header_size is json_size + 8", header_size == json_size + 8),
        ("body region starts at 16 + json_size", base == 16 + json_size),
    ):
        if not ok:
            raise SystemExit(
                f"unexpected asar framing ({label} failed): "
                f"word0={word0} header={header_size} word8={word8} json={json_size}"
            )
    header = json.loads(raw[16 : 16 + json_size].decode("utf-8"))
    return header, base, json_size


def walk(node, prefix=""):
    """Depth-first over file entries, in the order bodies are laid out."""
    for name, entry in node.get("files", {}).items():
        path = f"{prefix}{name}"
        if "files" in entry:
            yield from walk(entry, path + "/")
        else:
            yield path, entry


def has_body(entry):
    # `unpacked` members live in app.asar.unpacked and carry no offset; `link`
    # entries are symlinks and have neither offset nor size.
    return not entry.get("unpacked") and "link" not in entry


def integrity_for(data, block_size):
    """
    Recompute an asar integrity record: SHA256 of the whole file, plus one
    SHA256 per block.

    Every one of the 12967 members in the shipped archive carries one of these,
    so a patched member with a stale hash would be the only lie in an otherwise
    self-consistent file. `EnableEmbeddedAsarIntegrityValidation` is currently
    off, so nothing reads it today — which is exactly why it is worth fixing
    now rather than leaving a landmine for whoever flips that fuse.

    The formula is confirmed against the original archive before use (see
    `verify_integrity_against`), not assumed from memory.
    """
    digest = hashlib.sha256(data).hexdigest()
    blocks = [
        hashlib.sha256(data[start : start + block_size]).hexdigest()
        for start in range(0, len(data), block_size)
    ]
    return {"algorithm": "SHA256", "hash": digest, "blockSize": block_size, "blocks": blocks}


def verify_integrity_against(header, base, raw, sample=None):
    """
    Prove the integrity formula reproduces the hashes already in the archive.

    Run over the whole archive by default: 121 MB of SHA256 costs about a
    second and settles both questions at once — whether the formula is right,
    and whether the archive we are about to repack is itself intact.
    """
    bad = []
    checked = 0
    for path, entry in walk(header):
        rec = entry.get("integrity")
        if rec is None or not has_body(entry):
            continue
        if sample is not None and checked >= sample:
            break
        off = int(entry["offset"])
        data = raw[base + off : base + off + int(entry["size"])]
        want = integrity_for(data, int(rec.get("blockSize", 4194304)))
        if want["hash"] != rec.get("hash") or want["blocks"] != list(rec.get("blocks", [])):
            bad.append(path)
        checked += 1
    return checked, bad


def emit(header, body):
    text = json.dumps(header, separators=(",", ":"), ensure_ascii=False)
    # Keep the body region 4-byte aligned. On the shipped archive json_size was
    # already aligned, so this is a guard rather than a transformation. Padded
    # with spaces, which JSON.parse and json.loads both tolerate — NUL is not
    # valid JSON and both parsers reject it.
    text += " " * ((-len(text)) % 4)
    blob = text.encode("utf-8")
    framing = struct.pack("<IIII", 4, len(blob) + 8, len(blob) + 4, len(blob))
    return framing + blob + body


def apply_staged(asar, staged, backup, material):
    """
    Install a previously built and verified `app.asar.new`.

    This exists because of an ordering that Windows forces. A repack is a
    121 MB write and takes a few seconds; replacing the live archive does not
    work while the client is running, because Windows returns ERROR_ACCESS_
    DENIED when the target is held open — measured, not assumed: the backup
    copy into the same directory succeeds, which rules out a directory
    permission problem, and the file carries no read-only attribute.

    So the expensive, verifiable half is done while the app is up, and the
    cheap half (a rename) is left for after it closes. The staged archive is
    re-validated here rather than trusted, so a stale or hand-edited .new
    cannot be installed by accident.
    """
    if not staged.exists():
        print(f"nothing staged: {staged.name} does not exist")
        print("run `python tools/asarpatch.py` first")
        return 2

    raw = staged.read_bytes()
    try:
        header, base, _ = parse(raw)
    except SystemExit as error:
        print(f"staged archive does not parse: {error}")
        return 3

    members = dict(walk(header))
    if MEMBER not in members or not has_body(members[MEMBER]):
        print(f"staged archive has no readable {MEMBER}")
        return 3
    entry = members[MEMBER]
    off = int(entry["offset"])
    body = raw[base + off : base + off + int(entry["size"])]
    staged_material = installed_material(body.decode("utf-8", "replace"))
    if staged_material is None:
        print("staged archive does not contain the patch")
        return 3
    # Refusing a mismatch rather than installing it: a `--staging` archive built
    # with one material and installed under another would leave the pointer
    # claiming something the archive does not do.
    if staged_material != material:
        print(f"staged archive carries material: {staged_material}, asked for {material}")
        print("rebuild it with `python tools/asarpatch.py --material "
              f"{material} --staging <path>`")
        return 3
    if "integrity" in entry:
        want = integrity_for(body, int(entry["integrity"].get("blockSize", 4194304)))
        if want["hash"] != entry["integrity"].get("hash"):
            print("staged archive's integrity hash does not match its own bytes")
            return 3
    print(f"staged archive validated ({len(raw)} bytes, {MEMBER} patched "
          f"with material: {staged_material}, hash consistent)")

    if not backup.exists():
        shutil.copy2(asar, backup)
        print(f"backup    -> {backup.name}")

    try:
        staged.replace(asar)
    except (PermissionError, OSError) as error:
        print(f"could not replace the archive: {error}")
        print("DeepSeek Harness is still running. Quit it completely (check the")
        print("tray), then run: python tools/asarpatch.py --apply-staged")
        return 4

    print(f"patched   -> {asar.name}")
    write_pointer(asar, "patched", staged_material)
    print(f"start DeepSeek Harness; the window now requests "
          f"backgroundMaterial: {staged_material}.")
    return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="report state and exit")
    ap.add_argument("--revert", action="store_true", help="restore the backup")
    ap.add_argument(
        "--material",
        choices=MATERIALS,
        default="none",
        help="what the window should show behind itself: none = the desktop "
        "itself, sharp (default); acrylic = DWM's blurred copy of it",
    )
    ap.add_argument("--staging", metavar="PATH", help="write here instead of installing")
    ap.add_argument(
        "--apply-staged",
        action="store_true",
        help="install an already-verified app.asar.new without repacking",
    )
    ap.add_argument(
        "--print-watcher",
        action="store_true",
        help="write the window-material watcher to stdout and exit",
    )
    args = ap.parse_args()

    # The watcher is the half that runs INSIDE the client, and it is the one
    # half nothing can reach by importing: it is grafted into app.asar and only
    # ever executed by Electron's main process. Printing it lets
    # tools/verify.mjs run it against a fake Electron instead of settling for
    # "it parses", which is what a syntax check proves and all it proves.
    # Printing needs no archive, so it is answered before the install is looked
    # for — a machine that has not installed the client yet can still test.
    if args.print_watcher:
        sys.stdout.write(build_watcher())
        return 0

    if not ASAR.exists():
        print(f"not found: {ASAR}")
        return 2

    backup = ASAR.with_name(
        ASAR.name + ".bak-" + datetime.date.today().strftime("%Y%m%d")
    )
    staged = ASAR.parent / (ASAR.name + ".new")

    if args.revert:
        if not backup.exists():
            print(f"nothing to revert: {backup.name} does not exist")
            return 2
        shutil.copy2(backup, ASAR)
        write_pointer(ASAR, "stock")
        print(f"reverted {backup.name} -> {ASAR.name}")
        return 0

    if args.apply_staged:
        return apply_staged(ASAR, staged, backup, args.material)

    raw = ASAR.read_bytes()
    header, base, _ = parse(raw)

    members = dict(walk(header))
    if MEMBER not in members:
        print(f"member {MEMBER} is not in the archive")
        return 2
    target = members[MEMBER]

    # Snapshot every body BEFORE the header is touched, so verification never
    # has to reason about the offset arithmetic it is checking.
    before = {}
    for path, entry in members.items():
        if has_body(entry):
            off = int(entry["offset"])
            before[path] = raw[base + off : base + off + int(entry["size"])]

    text = before[MEMBER].decode("utf-8")
    present = installed_material(text)
    has_watcher = WATCHER_MARKER in text
    if present is not None:
        # `--check` reports whichever material is installed, including one that
        # is not the default: a command whose name promises a report must not
        # depend on a flag it was not given.
        if args.check:
            print(f"patched (material: {present}, watcher: {'yes' if has_watcher else 'NO'})")
            if not has_watcher:
                print("  this archive predates the window-material watcher, so the")
                print("  窗口模糊 switch cannot take effect on it. Re-run this tool to add it.")
            asar_env_hint()
            return 0
        if present != args.material:
            # Not done automatically. The patch is one substitution, so changing
            # the material means undoing it first, and the honest way to undo it
            # is the backup that `--revert` restores — a second in-place rewrite
            # would have to find the previous marker and be right about it.
            print(f"already patched with material: {present}; asked for {args.material}")
            print("changing the material starts by undoing the current patch:")
            print("  python tools/asarpatch.py --revert")
            print(f"  python tools/asarpatch.py --material {args.material}")
            return 2
        if has_watcher:
            print(f"already patched (material: {present}, backup present: {backup.exists()})")
            # Re-establish the host's fallback path even though there is nothing to
            # patch: this is the branch a user lands on after an auto-update wiped
            # the marker from a fresh archive, and it is exactly when the host's
            # fallback is worth re-asserting.
            write_pointer(ASAR, "patched", present)
            return 0
        # Same material, but from a version of this tool that did not install
        # the watcher. Falling through would leave 窗口模糊 reporting a request
        # nothing answers, so the watcher is appended to the already-patched
        # text and the archive is rebuilt. The win32 block is left untouched —
        # its marker is how `installed_material` recognised it just now.
        print(f"already patched (material: {present}) but the watcher is missing; adding it")
        watcher_only = True
    else:
        watcher_only = False
    if args.check:
        print("not patched")
        return 1

    if not watcher_only:
        hits = text.count(OLD)
        if hits != 1:
            print(f"the win32 primary block matched {hits} times, expected exactly 1")
            print("the archive is from a different DSH build; the patch needs re-deriving")
            return 2

    # Before mutating anything: confirm the integrity formula reproduces the
    # hashes already in the archive. This has to happen against the untouched
    # header, because it resolves each member through its stored offset.
    #
    # The gate is a MATCH RATE, not "zero mismatches". Measured on the shipped
    # archive: 9 of 11470 records are already stale, so requiring a clean sheet
    # would refuse a patch the app itself is perfectly happy to run. A wrong
    # formula would fail nearly all of them, so 95% separates the two cases
    # with a lot of room. The stale ones are reported rather than hidden — they
    # are pre-existing, not introduced here.
    #
    # A raw byte-count check is deliberately NOT used as the structural test:
    # re-serialising the header can legitimately change its length when an
    # offset crosses a power of ten, and asserting otherwise would flag a
    # correct repack. The read-back below is the real test.
    checked, bad = verify_integrity_against(header, base, raw)
    rate = (checked - len(bad)) / checked if checked else 0.0
    if rate < 0.95:
        print("REFUSING TO PATCH — the integrity formula does not describe this archive:")
        print(f"  only {rate:.1%} of {checked} records reproduced ({len(bad)} mismatched)")
        print(f"  first mismatch: {bad[0]}")
        return 3
    print(f"integrity formula confirmed on {checked} records ({rate:.2%} reproduced)")
    if bad:
        print(f"  {len(bad)} record(s) were already stale in the shipped archive:")
        for path in bad[:9]:
            print(f"    · {path}")

    if watcher_only:
        new_text = text + build_watcher()
    else:
        new_text = text.replace(OLD, build_new(args.material)) + build_watcher()
    new_bytes = new_text.encode("utf-8")
    old_off = int(target["offset"])
    delta = len(new_bytes) - len(before[MEMBER])

    # Rebuild the body region as: everything before main.js, the patched
    # main.js, everything after. Members before main.js keep their offsets;
    # every member after it moves right by exactly the growth.
    prefix_len = old_off
    prefix = raw[base : base + prefix_len]
    suffix = raw[base + prefix_len + len(before[MEMBER]) :]
    body = prefix + new_bytes + suffix

    for path, entry in members.items():
        if not has_body(entry):
            continue
        raw_off = entry["offset"]
        off = int(raw_off)
        if off > old_off:
            moved = off + delta
            # Offsets are stored as STRINGS in this archive. `off + delta`
            # silently produced an int, which quietly cost two bytes per member
            # (the quotes) — 26 members, 52 bytes, and the only reason it was
            # noticed is the read-back verification. Preserve the original type
            # rather than trusting that a reader will coerce it.
            entry["offset"] = str(moved) if isinstance(raw_off, str) else moved
    target["size"] = len(new_bytes)
    # The patched member's own hash, recomputed. Its blocks are unchanged in
    # count: main.js is 490 KB against a 4 MB blockSize, so one block.
    if "integrity" in target:
        block_size = int(target["integrity"].get("blockSize", 4194304))
        target["integrity"] = integrity_for(new_bytes, block_size)

    out = emit(header, body)

    # --- verification -----------------------------------------------------
    # The only thing that makes a repack trustworthy is reading it back and
    # comparing every untouched byte against the snapshot. A repacked archive
    # that loads but silently truncates a module would be far worse than no
    # patch at all, and nothing about it would be visible until something
    # obscure broke weeks later.
    problems = []

    try:
        o_header, o_base, _ = parse(out)
    except SystemExit as error:
        print(f"REPACK FAILED — the result does not parse: {error}")
        return 3

    o_members = dict(walk(o_header))
    if set(o_members) != set(members):
        problems.append("member set changed")

    for path, entry in o_members.items():
        if not has_body(entry):
            continue
        off = int(entry["offset"])
        size = int(entry["size"])
        if o_base + off + size > len(out):
            problems.append(f"{path}: runs past the end of the archive")
            continue
        got = out[o_base + off : o_base + off + size]
        want = new_bytes if path == MEMBER else before.get(path)
        if want is None:
            problems.append(f"{path}: has no original body to compare against")
        elif got != want:
            problems.append(f"{path}: body differs from the original")
        # Types matter: the shipped archive stores offsets as strings, and a
        # reader that coerces is not a guarantee that every reader does.
        if type(entry["offset"]) is not type(members[path]["offset"]):
            problems.append(f"{path}: offset type changed to {type(entry['offset']).__name__}")

    # The patched member's hash must describe the bytes that are actually there.
    main_rec = o_members[MEMBER].get("integrity")
    if main_rec is not None:
        want_rec = integrity_for(new_bytes, int(main_rec.get("blockSize", 4194304)))
        if want_rec["hash"] != main_rec.get("hash"):
            problems.append("lib/main.js: integrity hash does not match the patched bytes")
        if want_rec["blocks"] != list(main_rec.get("blocks", [])):
            problems.append("lib/main.js: integrity blocks do not match the patched bytes")

    # Walk order must cover the body region exactly once: no gaps, no overlaps.
    cursor = 0
    for path, entry in walk(o_header):
        if not has_body(entry):
            continue
        if int(entry["offset"]) != cursor:
            problems.append(
                f"gap or overlap before {path}: offset {entry['offset']} but cursor {cursor}"
            )
            break
        cursor = int(entry["offset"]) + int(entry["size"])
    if cursor != len(out) - o_base:
        problems.append(
            f"body region ends at {cursor}, archive has {len(out) - o_base} bytes of body"
        )

    if problems:
        print("REPACK FAILED — nothing written:")
        for p in problems[:20]:
            print("  ·", p)
        return 3

    print(f"verified  {len(o_members)} members read back, every untouched body byte-identical")
    print(f"          lib/main.js {len(before[MEMBER])} -> {len(new_bytes)} bytes ({delta:+d}), hash rewritten")
    print(f"          archive     {len(raw)} -> {len(out)} bytes")

    if args.staging:
        Path(args.staging).write_bytes(out)
        print(f"staged    -> {args.staging}")
        return 0

    if not backup.exists():
        shutil.copy2(ASAR, backup)
        print(f"backup    -> {backup.name}")

    tmp = ASAR.parent / (ASAR.name + ".new")
    try:
        tmp.write_bytes(out)
        tmp.replace(ASAR)
        print(f"patched   -> {ASAR.name}")
    except (PermissionError, OSError) as error:
        # Keep the repacked archive on disk: it is already verified, so once
        # DSH is closed the whole job is a rename rather than a re-run.
        print(f"could not replace the archive: {error}")
        print(f"DSH is holding it open. Close it, then either run this again or")
        print(f"rename {tmp} over {ASAR.name} yourself.")
        return 4

    # The pointer is the host's only reliable route to this archive, and this
    # run is the one that knows what is in it now. Leaving it alone keeps
    # whatever the PREVIOUS run wrote — measured here: a `--revert` (which
    # records `stock`) followed by a patch left the pointer saying `stock`
    # while the archive carried `none`, which is the one file whose job is to
    # describe the archive. The host rescanning the marker is what kept that
    # survivable, not an argument for leaving a stale record behind.
    write_pointer(ASAR, "patched", present if watcher_only else args.material)

    print("restart DeepSeek Harness for it to take effect.")
    # Two different materials, and the message has to keep them apart or it
    # reads as a contradiction: the archive's recipe is what a window is BORN
    # with, while the watcher's OFF is what the settings switch asks for at
    # runtime. They are deliberately not the same string — see MATERIALS.
    print(f"the window will be created with backgroundMaterial: {args.material}"
          + (" — the desktop itself, unblurred." if args.material == "none"
             else " — DWM's blurred copy of the desktop."))
    print('the 窗口模糊 switch applies "acrylic" / "auto" at runtime'
          + (f" (watcher installed, OFF = {RUNTIME_OFF})." if WATCHER_MARKER in new_text
             else " (no watcher — the switch will do nothing)."))
    return 0


if __name__ == "__main__":
    sys.exit(main())
