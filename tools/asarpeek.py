"""Read the DSH app.asar header and extract named members.

The asar format is: an 8-byte pickle header, then a JSON directory, then the
raw file bodies in the order the directory lists them. There is no compression,
so a member is a byte slice — no unpacking tool needed.

Usage:
    python tools/asarpeek.py list  <pattern>
    python tools/asarpeek.py grep  <pattern> [--context N]
    python tools/asarpeek.py write <member-path> <out-file>
"""
import json
import struct
import sys
from pathlib import Path

ASAR = Path(r"C:\Users\air\AppData\Local\Programs\DeepSeek Harness\resources\app.asar")


def load():
    raw = ASAR.read_bytes()
    # header_size is a uint32 at offset 4; the JSON directory is not aligned.
    # Two nested pickle payloads precede it, hence the 16-byte skip.
    header_size = struct.unpack_from("<I", raw, 4)[0]
    json_size = struct.unpack_from("<I", raw, 12)[0]
    header = json.loads(raw[16:16 + json_size].decode("utf-8"))
    base = 8 + header_size
    return raw, header, base


def walk(node, prefix=""):
    for name, entry in node.get("files", {}).items():
        path = f"{prefix}{name}"
        if "files" in entry:
            yield from walk(entry, path + "/")
        else:
            yield path, entry


def body_of(raw, base, entry):
    """Bytes for one member. `unpacked` members have no offset in the archive —
    they live in app.asar.unpacked on disk instead, and pretend to be entries."""
    if "offset" not in entry:
        return None
    at = base + int(entry["offset"])
    return raw[at:at + int(entry["size"])]


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "list"
    pat = sys.argv[2] if len(sys.argv) > 2 else ""
    raw, header, base = load()

    if cmd == "list":
        for path, entry in walk(header):
            if pat.lower() in path.lower():
                print(f"{entry.get('size', 0):>10}  {'unpacked  ' if 'offset' not in entry else ''}{path}")
        return

    if cmd == "grep":
        context = 90
        if "--context" in sys.argv:
            context = int(sys.argv[sys.argv.index("--context") + 1])
        needle = pat.encode()
        for path, entry in walk(header):
            if not path.endswith((".js", ".mjs", ".cjs", ".json")):
                continue
            body = body_of(raw, base, entry)
            if body is None:
                continue
            at = body.find(needle)
            hits = 0
            while at != -1 and hits < 6:
                lo = max(0, at - context)
                hi = min(len(body), at + len(needle) + context)
                print(f"--- {path} @{at} ---")
                print(body[lo:hi].decode("utf-8", "replace").replace("\n", "\\n"))
                hits += 1
                at = body.find(needle, at + 1)
            if hits:
                print()
        return

    if cmd == "write":
        out = Path(sys.argv[3])
        for path, entry in walk(header):
            if path == pat:
                body = body_of(raw, base, entry)
                if body is None:
                    print("unpacked, lives in app.asar.unpacked: " + pat)
                    return
                out.write_bytes(body)
                print(f"wrote {len(body)} bytes -> {out}")
                return
        print("not found: " + pat)


main()
