"""
Capture the REAL DeepSeek Harness window, and drive its UI.

Everything else in tools/ renders a stand-in shell, which is exactly why the
previews kept disagreeing with what air actually sees. This talks to the live
window over Win32 through ctypes — no .NET compilation, so it works under the
locked-down execution policy that blocks Add-Type.

    python tools/appshot.py list
    python tools/appshot.py shot  --out shot.png
    python tools/appshot.py click --at 120,430            # absolute screen px
    python tools/appshot.py click --in 120,430            # window-relative px
    python tools/appshot.py key   --text "hello"
    python tools/appshot.py focus

Coordinates are always PHYSICAL pixels: the process is made DPI-aware first, so
window rects, clicks and captures all share one coordinate space.
"""
import argparse
import ctypes
import json
import sys
import time
from ctypes import wintypes
from pathlib import Path

from PIL import Image

user32 = ctypes.WinDLL("user32", use_last_error=True)
gdi32 = ctypes.WinDLL("gdi32", use_last_error=True)

# Physical pixels, no DPI virtualisation.
try:
    ctypes.WinDLL("shcore").SetProcessDpiAwareness(2)
except Exception:
    user32.SetProcessDPIAware()

DEFAULT_MATCH = "DeepSeek Harness"

EnumWindowsProc = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

user32.EnumWindows.argtypes = [EnumWindowsProc, wintypes.LPARAM]
user32.GetWindowTextLengthW.argtypes = [wintypes.HWND]
user32.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
user32.IsWindowVisible.argtypes = [wintypes.HWND]
user32.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
user32.PrintWindow.argtypes = [wintypes.HWND, wintypes.HDC, wintypes.UINT]
user32.GetWindowLongW.argtypes = [wintypes.HWND, ctypes.c_int]
user32.GetWindowDC.argtypes = [wintypes.HWND]
user32.ReleaseDC.argtypes = [wintypes.HWND, wintypes.HDC]
user32.SetForegroundWindow.argtypes = [wintypes.HWND]
user32.ShowWindow.argtypes = [wintypes.HWND, ctypes.c_int]
user32.SetCursorPos.argtypes = [ctypes.c_int, ctypes.c_int]
# dwExtraInfo is an opaque ULONG_PTR. Declaring it as POINTER(ULONG) makes ctypes
# reject the plain `0` every call site passes (ArgumentError: expected
# LP_c_ulong), which silently kept both hotkey() and click() from ever running.
# c_void_p accepts 0/None and marshals identically.
user32.keybd_event.argtypes = [wintypes.BYTE, wintypes.BYTE, wintypes.DWORD, ctypes.c_void_p]
user32.keybd_event.restype = None
user32.mouse_event.argtypes = [wintypes.DWORD, wintypes.DWORD, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p]
user32.mouse_event.restype = None
user32.SendMessageW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]

gdi32.CreateCompatibleDC.argtypes = [wintypes.HDC]
gdi32.CreateCompatibleBitmap.argtypes = [wintypes.HDC, ctypes.c_int, ctypes.c_int]
gdi32.SelectObject.argtypes = [wintypes.HDC, wintypes.HGDIOBJ]
gdi32.DeleteObject.argtypes = [wintypes.HGDIOBJ]
gdi32.DeleteDC.argtypes = [wintypes.HDC]

GWL_EXSTYLE = -20
WS_EX_TOOLWINDOW = 0x00000080
PW_RENDERFULLCONTENT = 2
SRCCOPY = 0x00CC0020
DIB_RGB_COLORS = 0
SW_RESTORE = 9


class BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [
        ("biSize", wintypes.DWORD),
        ("biWidth", wintypes.LONG),
        ("biHeight", wintypes.LONG),
        ("biPlanes", wintypes.WORD),
        ("biBitCount", wintypes.WORD),
        ("biCompression", wintypes.DWORD),
        ("biSizeImage", wintypes.DWORD),
        ("biXPelsPerMeter", wintypes.LONG),
        ("biYPelsPerMeter", wintypes.LONG),
        ("biClrUsed", wintypes.DWORD),
        ("biClrImportant", wintypes.DWORD),
    ]


class BITMAPINFO(ctypes.Structure):
    _fields_ = [("bmiHeader", BITMAPINFOHEADER), ("bmiColors", wintypes.DWORD * 3)]


def title_of(hwnd):
    n = user32.GetWindowTextLengthW(hwnd)
    if n <= 0:
        return ""
    buf = ctypes.create_unicode_buffer(n + 2)
    user32.GetWindowTextW(hwnd, buf, n + 2)
    return buf.value


def windows(match=DEFAULT_MATCH, min_w=400, min_h=300, include_tool_windows=False):
    """Visible, non-tool top-level windows whose title contains `match`.

    Tool windows are skipped by default because the app's own transient panels
    are not what "capture the app" means. `include_tool_windows=True` exists for
    the one caller that is not talking about DSH at all: materialprobe.py, whose
    probe windows are Electron windows with `skipTaskbar: true` — and Electron
    implements skipTaskbar by setting WS_EX_TOOLWINDOW, so this filter hid every
    window the probe was trying to photograph. Measured: with this flag off the
    capture came back empty for all six recipes, with no error anywhere.
    """
    found = []

    def cb(hwnd, _lparam):
        if not user32.IsWindowVisible(hwnd):
            return True
        if not include_tool_windows and user32.GetWindowLongW(hwnd, GWL_EXSTYLE) & WS_EX_TOOLWINDOW:
            return True
        r = wintypes.RECT()
        if not user32.GetWindowRect(hwnd, ctypes.byref(r)):
            return True
        w, h = r.right - r.left, r.bottom - r.top
        if w < min_w or h < min_h:
            return True
        t = title_of(hwnd)
        if match.lower() in t.lower():
            found.append({"hwnd": hwnd, "title": t, "x": r.left, "y": r.top, "w": w, "h": h})
        return True

    user32.EnumWindows(EnumWindowsProc(cb), 0)
    return found


def primary(match=DEFAULT_MATCH):
    """The main shell — the widest match, not a dialog."""
    wins = windows(match)
    if not wins:
        return None
    return max(wins, key=lambda w: w["w"] * w["h"])


def focus(win):
    user32.ShowWindow(win["hwnd"], SW_RESTORE)
    user32.SetForegroundWindow(win["hwnd"])
    time.sleep(0.35)


def grab(win):
    """PrintWindow into an offscreen bitmap, read back through GetDIBits.

    PW_RENDERFULLCONTENT (2) is required for Chromium/Electron surfaces; flag 0
    returns a blank or stale frame. This works even when the window is occluded.

    ONE THING THIS CANNOT SHOW: a transparent window. The bitmap comes back BGRA
    and is converted to RGB below, which drops the alpha channel — and a
    see-through window is premultiplied, RGB zeroed wherever alpha is zero. So
    every transparent pixel arrives as black, and a fully see-through window
    reads as a black rectangle. Measured against materialprobe.py's recipes:
    for an `acrylic` window this agrees with a real screen capture to a decimal
    (0.012 vs 0.011 edge-energy ratio, luma 99.5 vs 100.0), while for a `none`
    window the screen says 0.875 / 129.0 and this says 0.002 / 0.2.

    Nothing here is a bug to fix — the window really is transparent there, and a
    bitmap has nowhere to put "and you can see the desktop through it". It is a
    property to know before using this to answer "is the desktop showing
    through", because an opaque black window produces the identical picture.
    """
    w, h = win["w"], win["h"]
    hwnd_dc = user32.GetWindowDC(win["hwnd"])
    mem_dc = gdi32.CreateCompatibleDC(hwnd_dc)
    bmp = gdi32.CreateCompatibleBitmap(hwnd_dc, w, h)
    old = gdi32.SelectObject(mem_dc, bmp)
    try:
        ok = user32.PrintWindow(win["hwnd"], mem_dc, PW_RENDERFULLCONTENT)
        info = BITMAPINFO()
        info.bmiHeader.biSize = ctypes.sizeof(BITMAPINFOHEADER)
        info.bmiHeader.biWidth = w
        info.bmiHeader.biHeight = -h  # negative = top-down rows
        info.bmiHeader.biPlanes = 1
        info.bmiHeader.biBitCount = 32
        info.bmiHeader.biCompression = 0  # BI_RGB
        buf = ctypes.create_string_buffer(w * h * 4)
        n = gdi32.GetDIBits(mem_dc, bmp, 0, h, buf, ctypes.byref(info), DIB_RGB_COLORS)
        if n == 0:
            return None, False
        img = Image.frombuffer("RGBA", (w, h), buf, "raw", "BGRA", 0, 1).convert("RGB")
        return img, bool(ok)
    finally:
        gdi32.SelectObject(mem_dc, old)
        gdi32.DeleteObject(bmp)
        gdi32.DeleteDC(mem_dc)
        user32.ReleaseDC(win["hwnd"], hwnd_dc)


def click(x, y):
    """Absolute physical-pixel click."""
    user32.SetCursorPos(int(x), int(y))
    time.sleep(0.12)
    user32.mouse_event(0x0002, 0, 0, 0, 0)  # LEFTDOWN
    time.sleep(0.06)
    user32.mouse_event(0x0004, 0, 0, 0, 0)  # LEFTUP
    time.sleep(0.28)


def send_text(text):
    """Unicode text via keybd_event-free SendInput is fiddly; use WM_CHAR."""
    for ch in text:
        user32.SendMessageW(user32.GetForegroundWindow(), 0x0102, ord(ch), 0)
        time.sleep(0.02)


# --- virtual key codes: only the ones actually needed -----------------------
VK = {
    "ctrl": 0x11, "shift": 0x10, "alt": 0x12, "win": 0x5B,
    "esc": 0x1B, "enter": 0x0D, "tab": 0x09, "space": 0x20,
    "f5": 0x74, "f12": 0x7B,
    "r": 0x52, "i": 0x49, "j": 0x4A, "c": 0x43, "a": 0x41, "v": 0x56,
}
KEYEVENTF_KEYUP = 0x0002


def hotkey(spec):
    """Press a chord, e.g. 'ctrl+shift+i'.

    Uses keybd_event rather than PostMessage: Chromium routes real keyboard
    input through its own message pipeline and quietly ignores synthesised
    WM_KEYDOWN messages posted straight at the top-level HWND, so a reload
    triggered by PostMessage looks like it works but never fires.
    """
    parts = [p.strip().lower() for p in spec.split("+") if p.strip()]
    if not parts:
        raise ValueError("empty hotkey")
    codes = []
    for p in parts:
        if p not in VK:
            raise ValueError(f"unknown key {p!r}; known: {sorted(VK)}")
        codes.append(VK[p])
    # Modifiers stay down for the whole chord, the final key is the trigger.
    for c in codes[:-1]:
        user32.keybd_event(c, 0, 0, 0)
        time.sleep(0.04)
    last = codes[-1]
    user32.keybd_event(last, 0, 0, 0)
    time.sleep(0.06)
    user32.keybd_event(last, 0, KEYEVENTF_KEYUP, 0)
    for c in reversed(codes[:-1]):
        user32.keybd_event(c, 0, KEYEVENTF_KEYUP, 0)
        time.sleep(0.04)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["list", "shot", "click", "focus", "drag", "hotkey", "type"])
    ap.add_argument("--match", default=DEFAULT_MATCH)
    ap.add_argument("--out", default="app.png")
    ap.add_argument("--at", help="absolute screen x,y")
    ap.add_argument("--in", dest="rel", help="window-relative x,y")
    ap.add_argument("--from", dest="frm", help="drag start, window-relative x,y")
    ap.add_argument("--to", dest="to", help="drag end, window-relative x,y")
    ap.add_argument("--keys", help="hotkey chord, e.g. ctrl+r")
    ap.add_argument("--text", help="text to type")
    ap.add_argument("--wait", type=float, default=0.0, help="seconds to settle after the action")
    args = ap.parse_args()

    win = primary(args.match)

    if args.cmd == "list":
        for w in windows(args.match):
            print(json.dumps(w, default=str))
        if win is None:
            print("NO_MATCH")
        return 0

    if win is None:
        print("NO_WINDOW")
        return 1

    if args.cmd == "focus":
        focus(win)
        print(f"focused hwnd={win['hwnd']} {win['w']}x{win['h']} at {win['x']},{win['y']}")
        return 0

    if args.cmd == "shot":
        img, ok = grab(win)
        if img is None:
            print("GRAB_FAILED")
            return 1
        Path(args.out).parent.mkdir(parents=True, exist_ok=True)
        img.save(args.out)
        print(f"captured {img.size[0]}x{img.size[1]} printwindow={ok} -> {args.out}")
        print(f"window origin {win['x']},{win['y']}")
        return 0

    if args.cmd == "click":
        if args.at:
            x, y = (int(v) for v in args.at.split(","))
        elif args.rel:
            rx, ry = (int(v) for v in args.rel.split(","))
            x, y = win["x"] + rx, win["y"] + ry
        else:
            print("need --at or --in")
            return 1
        focus(win)
        click(x, y)
        print(f"clicked {x},{y}")
        if args.wait:
            time.sleep(args.wait)
        return 0

    if args.cmd == "hotkey":
        if not args.keys:
            print("need --keys")
            return 1
        focus(win)
        hotkey(args.keys)
        print(f"sent {args.keys}")
        if args.wait:
            time.sleep(args.wait)
        return 0

    if args.cmd == "type":
        if args.text is None:
            print("need --text")
            return 1
        focus(win)
        send_text(args.text)
        print(f"typed {len(args.text)} chars")
        if args.wait:
            time.sleep(args.wait)
        return 0

    if args.cmd == "drag":
        rx, ry = (int(v) for v in args.frm.split(","))
        tx, ty = (int(v) for v in args.to.split(","))
        focus(win)
        user32.SetCursorPos(win["x"] + rx, win["y"] + ry)
        time.sleep(0.12)
        user32.mouse_event(0x0002, 0, 0, 0, 0)
        steps = 24
        for i in range(1, steps + 1):
            user32.SetCursorPos(
                win["x"] + rx + (tx - rx) * i // steps,
                win["y"] + ry + (ty - ry) * i // steps,
            )
            time.sleep(0.02)
        user32.mouse_event(0x0004, 0, 0, 0, 0)
        time.sleep(0.2)
        print(f"dragged {rx},{ry} -> {tx},{ty}")
        return 0

    return 0


if __name__ == "__main__":
    sys.exit(main())
