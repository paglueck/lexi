#!/usr/bin/env python3
# Copyright (c) 2026 Patrick Glück
# SPDX-License-Identifier: GPL-3.0-or-later
"""
Derive every app icon from the one master artwork, apps/desktop/build/icon-source.png
(square, full-bleed, at least 1024 px).

    python3 -m venv /tmp/lexi-icons && /tmp/lexi-icons/bin/pip install Pillow
    /tmp/lexi-icons/bin/python scripts/generate-icons.py

The outputs are committed, so this only runs when the artwork changes. It needs macOS
for `iconutil` (the .icns step).

Why the platforms get different shapes:

- macOS draws no mask of its own. An icon is expected to bring its own rounded tile
  with transparent padding around it (Apple's grid: an 824 px tile on a 1024 px canvas).
  A full-bleed square would sit in the Dock visibly larger and boxier than every
  other app.
- Windows and the browser tab show the image as is. There the tile fills the canvas,
  with only slightly rounded corners, so the 16 px favicon keeps as many pixels as it can.
- iOS's apple-touch-icon is masked by the OS, so it stays full-bleed.
"""
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
BUILD = ROOT / 'apps' / 'desktop' / 'build'
WEB_PUBLIC = ROOT / 'apps' / 'web' / 'public'
SOURCE = BUILD / 'icon-source.png'

# Supersampling factor for the masks, so that the rounded corners come out antialiased.
SS = 4


def rounded_mask(size: int, radius: int) -> Image.Image:
    big = Image.new('L', (size * SS, size * SS), 0)
    ImageDraw.Draw(big).rounded_rectangle(
        (0, 0, size * SS - 1, size * SS - 1), radius=radius * SS, fill=255
    )
    return big.resize((size, size), Image.LANCZOS)


def tile(art: Image.Image, size: int, radius_ratio: float) -> Image.Image:
    """The artwork at `size`, with its corners rounded off."""
    out = art.resize((size, size), Image.LANCZOS).convert('RGBA')
    mask = rounded_mask(size, round(size * radius_ratio))
    out.putalpha(ImageChops.multiply(out.getchannel('A'), mask))
    return out


def macos_icon(art: Image.Image) -> Image.Image:
    """1024 canvas, 824 tile, Apple's corner radius, with a soft drop shadow."""
    canvas_size, tile_size = 1024, 824
    offset = (canvas_size - tile_size) // 2
    radius_ratio = 185.4 / 824

    canvas = Image.new('RGBA', (canvas_size, canvas_size), (0, 0, 0, 0))

    shadow_alpha = Image.new('L', (canvas_size, canvas_size), 0)
    shadow_alpha.paste(rounded_mask(tile_size, round(tile_size * radius_ratio)), (offset, offset + 10))
    shadow_alpha = shadow_alpha.filter(ImageFilter.GaussianBlur(14)).point(lambda a: a * 0.35)
    shadow = Image.new('RGBA', (canvas_size, canvas_size), (0, 0, 0, 255))
    shadow.putalpha(shadow_alpha)
    canvas.alpha_composite(shadow)

    canvas.alpha_composite(tile(art, tile_size, radius_ratio), (offset, offset))
    return canvas


def write_icns(icon_1024: Image.Image, target: Path) -> None:
    with tempfile.TemporaryDirectory() as tmp:
        iconset = Path(tmp) / 'icon.iconset'
        iconset.mkdir()
        for base in (16, 32, 128, 256, 512):
            for scale in (1, 2):
                px = base * scale
                name = f'icon_{base}x{base}' + ('@2x' if scale == 2 else '') + '.png'
                icon_1024.resize((px, px), Image.LANCZOS).save(iconset / name)
        subprocess.run(['iconutil', '-c', 'icns', str(iconset), '-o', str(target)], check=True)


def main() -> None:
    if not SOURCE.exists():
        sys.exit(f'Missing {SOURCE.relative_to(ROOT)}')
    if shutil.which('iconutil') is None:
        sys.exit('iconutil not found: the .icns step needs macOS.')

    art = Image.open(SOURCE).convert('RGBA')
    if art.width != art.height or art.width < 1024:
        sys.exit('The source icon must be square and at least 1024 px.')

    # macOS: the .icns electron-builder packages, plus a PNG of the same artwork for
    # the Dock in `npm run desktop:dev`, where no .icns is involved.
    mac = macos_icon(art)
    mac.save(BUILD / 'icon.png')
    write_icns(mac, BUILD / 'icon.icns')

    # Windows: the installer and Lexi.exe icon, and the window/taskbar icon.
    flat = tile(art, 1024, 0.12)
    flat.save(BUILD / 'icon.ico', sizes=[(s, s) for s in (16, 24, 32, 48, 64, 128, 256)])
    flat.resize((512, 512), Image.LANCZOS).save(BUILD / 'icon-window.png')

    # Browser tab and home-screen icons for the SPA.
    flat.save(WEB_PUBLIC / 'favicon.ico', sizes=[(16, 16), (32, 32), (48, 48)])
    flat.resize((192, 192), Image.LANCZOS).save(WEB_PUBLIC / 'icon.png')
    art.convert('RGB').resize((180, 180), Image.LANCZOS).save(WEB_PUBLIC / 'apple-touch-icon.png')

    for path in sorted([*BUILD.glob('icon*'), *WEB_PUBLIC.glob('*icon*')]):
        print(f'  {path.relative_to(ROOT)}  ({path.stat().st_size // 1024} KB)')


if __name__ == '__main__':
    main()
