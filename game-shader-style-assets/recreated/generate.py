#!/usr/bin/env python3
"""Regenerate the effect masks described in ../../game-shader-style.md.

These are original, procedural textures built from profiles *measured* on the
reference masks (see ../README.md). They are free to use in your own projects.

    python3 generate.py            # writes the PNGs next to this file
    python3 generate.py --size 1024

Needs only Pillow (pip install pillow).
"""
import argparse
import math
import os

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))


def clamp(x, a=0.0, b=1.0):
    return a if x < a else b if x > b else x


def smoothstep(e0, e1, x):
    t = clamp((x - e0) / (e1 - e0))
    return t * t * (3 - 2 * t)


def interp(x, pts):
    """Piecewise-linear lookup in a sorted [(x, y), ...] table."""
    if x <= pts[0][0]:
        return pts[0][1]
    for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
        if x <= x1:
            return y0 + (y1 - y0) * (x - x0) / (x1 - x0)
    return pts[-1][1]


def render(w, h, fn, mode="RGBA"):
    """fn(u, v) -> tuple of 0..1 floats, u/v in 0..1 with v = 0 at the top row."""
    im = Image.new(mode, (w, h))
    px = im.load()
    for y in range(h):
        v = (y + 0.5) / h
        for x in range(w):
            u = (x + 0.5) / w
            px[x, y] = tuple(int(round(clamp(c) * 255)) for c in fn(u, v))
    return im


RIPPLE = [(0, 0), (0.27, 0), (0.3, 16), (0.4, 44), (0.5, 79), (0.6, 123), (0.7, 161), (0.8, 202), (0.9, 232), (1.0, 255)]


def ripple(u, v):
    # Hollow shockwave ring: transparent eye to r = 0.27, ramps up (slightly convex) to a
    # fully opaque hard rim at r = 1.
    r = math.hypot(u - 0.5, v - 0.5) * 2
    return (1, 1, 1, interp(r, RIPPLE) / 255 if r <= 1.0 else 0)


def glow(u, v):
    # Light shaft: fades linearly along its length (0 at top, 0.39 at bottom) and falls off across.
    across = interp(abs(u - 0.5) * 2, [(0, 1.0), (0.2, 0.96), (0.4, 0.84), (0.6, 0.69), (0.8, 0.51), (1.0, 0.33)])
    return (1, 1, 1, 0.39 * v * across)


def soft(u, v):
    # Flat disc with a feathered edge from 0.68 R to 1.0 R.
    r = math.hypot(u - 0.5, v - 0.5) * 2
    return (1, 1, 1, 1 - smoothstep(0.68, 1.0, r))


VIGNETTE = [(0, 0), (0.35, 0), (0.4, 14), (0.5, 47), (0.6, 98), (0.7, 131), (0.8, 136), (0.9, 167), (1.0, 194), (1.414, 251)]


def vignette(u, v):
    # Lomo-style vignette, black with alpha: clear centre, ~0.76 at the edges, ~1 in the corners.
    r = math.hypot(u - 0.5, v - 0.5) * 2
    return (0, 0, 0, interp(r, VIGNETTE) / 255)


def grading(u, v):
    # Darkening ramp: black, alpha 0 at the top -> 1 at the bottom.
    return (0, 0, 0, v)


def ring_wipe(u, v):
    # Radial-progress ring. Alpha ramps 0 -> 1 clockwise from 12 o'clock; drive it with an
    # alpha cutoff (alphaTest / discard) to wipe the ring in or out.
    dx, dy = u - 0.5, v - 0.5
    r = math.hypot(dx, dy) * 2
    band = smoothstep(0.84, 0.86, r) * (1 - smoothstep(0.98, 1.0, r))
    ang = (math.atan2(dx, -dy) / (2 * math.pi)) % 1.0
    return (1, 1, 1, band * max(ang, 1 / 255) if band > 0 else 0)


def swirl_cookie(u, v):
    # Distortion map for the grab-pass math: offset = (RG * 2 - 1) * intensity, B = mask.
    # A three-armed tangential swirl in a donut, neutral (0.5, 0.5) at the eye and outside.
    dx, dy = u - 0.5, v - 0.5
    r = math.hypot(dx, dy) * 2
    if r < 1e-5:
        return (0.5, 0.5, 0, 1)
    ring = smoothstep(0.0, 0.35, r) * (1 - smoothstep(0.55, 1.0, r))
    dirx, diry = dx / (r / 2), dy / (r / 2)
    tx, ty = -diry, dirx
    lobes = math.sin(math.atan2(dy, dx) * 3 - r * 9)
    ox = (tx * (0.8 + 0.4 * lobes) + dirx * 0.35 * lobes) * ring
    oy = (ty * (0.8 + 0.4 * lobes) + diry * 0.35 * lobes) * ring
    return (0.5 + 0.5 * ox / 1.6, 0.5 + 0.5 * oy / 1.6, ring, 1)


def shards(u, v):
    # 2x2 sheet of debris shapes (square, diamond, triangle, sliver) for the landing burst.
    cu, cv = int(u * 2), int(v * 2)
    x, y = (u * 2 % 1) - 0.5, (v * 2 % 1) - 0.5
    aa = 0.02
    if (cu, cv) == (0, 0):
        d = max(abs(x), abs(y)) - 0.36
    elif (cu, cv) == (1, 0):
        d = (abs(x) + abs(y)) - 0.42
    elif (cu, cv) == (0, 1):
        d = max(-y - 0.3, (abs(x) * 1.6 + y * 0.92) - 0.33)
    else:
        rx, ry = x * 0.8 - y * 0.6, x * 0.6 + y * 0.8
        d = max(abs(rx) - 0.08, abs(ry) - 0.4)
    return (1, 1, 1, 1 - smoothstep(-aa, aa, d))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--size", type=int, default=512)
    ap.add_argument("--out", default=HERE)
    n = ap.parse_args().size
    out = ap.parse_args().out
    jobs = {
        "ripple.png": (n, n, ripple),
        "glow.png": (n // 4, n // 2, glow),
        "soft.png": (n // 4, n // 4, soft),
        "vignette.png": (n, n, vignette),
        "grading.png": (4, n // 2, grading),
        "ring-wipe.png": (n // 2, n // 2, ring_wipe),
        "swirl-cookie.png": (n // 2, n // 2, swirl_cookie),
        "shards.png": (n // 2, n // 2, shards),
    }
    for name, (w, h, fn) in jobs.items():
        render(w, h, fn).save(os.path.join(out, name))
        print(f"{name:18s} {w}x{h}")


if __name__ == "__main__":
    main()
