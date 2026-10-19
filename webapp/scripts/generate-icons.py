#!/usr/bin/env python3
"""Generate PNG app icons from the SVG source (public/icon.svg).

The icon is simple enough to rasterize by hand with Pillow: a violet rounded
rectangle, a white ring, and a white dot. Outputs the sizes referenced by the
PWA manifest and apple-touch-icon.
"""

from PIL import Image, ImageDraw
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, "public")

# Matches the SVG gradient: #a78bfa -> #7c3aed
START = (0xA7, 0x8B, 0xFA)
END = (0x7C, 0x3A, 0xED)


def gradient(size: int) -> Image.Image:
    img = Image.new("RGB", (size, size))
    pixels = img.load()
    for y in range(size):
        t = y / (size - 1) if size > 1 else 0
        r = int(START[0] + (END[0] - START[0]) * t)
        g = int(START[1] + (END[1] - START[1]) * t)
        b = int(START[2] + (END[2] - START[2]) * t)
        for x in range(size):
            pixels[x, y] = (r, g, b)
    return img


def rounded_rect_mask(size: int, radius: int) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    draw = ImageDraw.Draw(mask)
    draw.rounded_rectangle((0, 0, size, size), radius=radius, fill=255)
    return mask


def draw_icon(size: int) -> Image.Image:
    img = gradient(size)
    # Rounded corners: source SVG uses rx=112 on a 512 canvas.
    radius = int(round(112 * size / 512))
    mask = rounded_rect_mask(size, radius)
    icon = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    icon.paste(img, (0, 0), mask)

    draw = ImageDraw.Draw(icon)
    center = size // 2
    # Outer white ring: r=120, stroke=28
    outer_r = int(round(120 * size / 512))
    stroke = max(1, int(round(28 * size / 512)))
    draw.ellipse(
        (center - outer_r, center - outer_r, center + outer_r, center + outer_r),
        outline=(255, 255, 255, 255),
        width=stroke,
    )
    # Inner white dot: r=42
    inner_r = int(round(42 * size / 512))
    draw.ellipse(
        (center - inner_r, center - inner_r, center + inner_r, center + inner_r),
        fill=(255, 255, 255, 255),
    )
    return icon


def main():
    sizes = {
        "icon-180.png": 180,
        "icon-192.png": 192,
        "icon-512.png": 512,
    }
    for name, size in sizes.items():
        icon = draw_icon(size)
        out = os.path.join(OUT_DIR, name)
        icon.save(out, "PNG")
        print(f"Generated {out}")


if __name__ == "__main__":
    main()
