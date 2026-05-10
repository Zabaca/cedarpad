#!/usr/bin/env python3
"""
Generate the cedarpad source icon as a 1024x1024 PNG using only the
Python stdlib (zlib + struct). The image is a rounded-square cedar-green
background with a stylized white "C" wordmark — simple, recognisable
at every size Tauri's icon pipeline produces.

Output: src-tauri/icons/icon-source.png

Re-run this script any time the brand changes. The generated PNG is
checked in; the per-size derivatives are produced by `tauri icon`
(see scripts/build-macos.sh).
"""
import math
import os
import struct
import sys
import zlib

SIZE = 1024
# Cedar-ish dark green
BG = (32, 84, 60, 255)
# Soft off-white wordmark
FG = (245, 240, 224, 255)
# Rounded-corner radius (macOS-ish proportions; tauri-icon won't re-mask)
RADIUS = 192


def in_rounded_square(x: int, y: int, size: int, radius: int) -> bool:
    if x < radius and y < radius:
        return (radius - x) ** 2 + (radius - y) ** 2 <= radius ** 2
    if x >= size - radius and y < radius:
        return (x - (size - radius - 1)) ** 2 + (radius - y) ** 2 <= radius ** 2
    if x < radius and y >= size - radius:
        return (radius - x) ** 2 + (y - (size - radius - 1)) ** 2 <= radius ** 2
    if x >= size - radius and y >= size - radius:
        return (x - (size - radius - 1)) ** 2 + (y - (size - radius - 1)) ** 2 <= radius ** 2
    return True


def in_c_glyph(x: int, y: int, size: int) -> bool:
    """An open-right ring: outer disk minus inner disk minus a right-side bite."""
    cx = size / 2
    cy = size / 2
    outer = size * 0.34  # outer radius
    inner = size * 0.22  # inner radius (ring thickness ~12% of size)
    dx = x - cx
    dy = y - cy
    d2 = dx * dx + dy * dy
    if d2 > outer * outer:
        return False
    if d2 < inner * inner:
        return False
    # Cut a wedge on the right (the opening of the C). Wedge half-angle ~28deg.
    angle = math.atan2(dy, dx)  # -pi..pi; 0 == east
    if abs(angle) < math.radians(28):
        return False
    return True


def main() -> int:
    # Row-major RGBA buffer, with a leading filter byte per row (PNG spec).
    bg_bytes = bytes(BG)
    fg_bytes = bytes(FG)
    transparent = bytes((0, 0, 0, 0))

    rows = []
    for y in range(SIZE):
        row = bytearray()
        row.append(0)  # filter type: None
        for x in range(SIZE):
            if not in_rounded_square(x, y, SIZE, RADIUS):
                row.extend(transparent)
            elif in_c_glyph(x, y, SIZE):
                row.extend(fg_bytes)
            else:
                row.extend(bg_bytes)
        rows.append(bytes(row))
    raw = b"".join(rows)

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", SIZE, SIZE, 8, 6, 0, 0, 0)  # 8-bit RGBA
    idat = zlib.compress(raw, 9)
    png = sig + chunk(b"IHDR", ihdr) + chunk(b"IDAT", idat) + chunk(b"IEND", b"")

    out_dir = os.path.join(os.path.dirname(__file__), "..", "src-tauri", "icons")
    out_dir = os.path.abspath(out_dir)
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, "icon-source.png")
    with open(out_path, "wb") as f:
        f.write(png)
    print(f"wrote {out_path} ({len(png):,} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
