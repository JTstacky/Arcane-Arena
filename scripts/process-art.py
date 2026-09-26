"""Turns the generated PNGs in client/public/art/raw/ into the WebP files the
game loads from client/public/art/ (and art/icons/).

  python scripts/process-art.py

- Effect sprites (fx_*) are drawn additively on black, so near-black is
  clamped to pure black (no grey haze around sprites) and edges are faded to
  black so no sprite shows a hard square border.
- Terrain (tex_*) is made seamless by cross-fading each edge with the
  opposite one.
- Icons are resized to 128 px for the command card and shop.
Raw PNGs are not shipped: .gitignore excludes art/raw/.
"""
import os
import sys
import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ART = os.path.join(HERE, '..', 'client', 'public', 'art')
RAW = os.path.join(ART, 'raw')
ICONS = os.path.join(ART, 'icons')

# name -> output size (w, h)
FX = {
    'fx_fire_sheet': (1024, 1024), 'fx_flame': (256, 256), 'fx_smoke': (256, 256),
    'fx_flare': (256, 256), 'fx_spark': (128, 128), 'fx_ring': (512, 512),
    'fx_orb': (256, 256), 'fx_lightning': (1024, 160), 'fx_wisp': (256, 256), 'fx_shield': (512, 512),
}
# Coloured sprites that also get a white copy for tinting.
GRAY = {'fx_ring': 'fx_ring', 'fx_lightning': 'fx_lightning_white', 'fx_shield': 'fx_shield_white'}
# Sprites whose subject fills only the middle of the frame: keep this share.
CROP = {'fx_flare': 0.6, 'fx_spark': 0.7}
# Strips whose subject fills only a band: keep this share of the height.
CROP_Y = {'fx_lightning': 0.6}
TEX = {'tex_marble': (1024, 1024), 'tex_lava': (1024, 1024), 'tex_rock': (512, 512), 'tex_rim': (1024, 256)}


def black_levels(a, lo=10):
    """Clamps near-black to black and re-stretches the rest."""
    a = a.astype(np.float32)
    a = np.clip((a - lo) / (255 - lo), 0, 1) * 255
    return a


def edge_fade(a, frac=0.06, sheet=1):
    """Fades each cell's border to black."""
    h, w = a.shape[:2]
    ch, cw = h // sheet, w // sheet
    ys = np.arange(ch)
    xs = np.arange(cw)
    fy = np.clip(np.minimum(ys, ch - 1 - ys) / (ch * frac), 0, 1)
    fx = np.clip(np.minimum(xs, cw - 1 - xs) / (cw * frac), 0, 1)
    m = np.outer(fy, fx)
    m = np.tile(m, (sheet, sheet))
    return a * m[:, :, None]


def seamless(a, frac=0.12, horizontal_only=False):
    """Cross-fades the borders with the opposite side so the image tiles."""
    a = a.astype(np.float32)
    h, w = a.shape[:2]
    # Roll a copy by half, so its seams sit in the middle, and show it only
    # near the borders.
    rolled = np.roll(a, (h // 2 if not horizontal_only else 0, w // 2), axis=(0, 1))
    yy = np.abs(np.linspace(-1, 1, h))[:, None]
    xx = np.abs(np.linspace(-1, 1, w))[None, :]
    # Weight of the original: 1 in the middle, 0 at the edges (where the
    # rolled copy is seamless because its own seam sits in the middle).
    edge = xx if horizontal_only else np.maximum(xx, yy)
    wgt = np.clip((1 - edge) / frac, 0, 1)
    wgt = wgt * wgt * (3 - 2 * wgt)
    return a * wgt[:, :, None] + rolled * (1 - wgt[:, :, None])


def save(arr, path, size, quality=88):
    img = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8), 'RGB')
    if img.size != size:
        img = img.resize(size, Image.LANCZOS)
    img.save(path, 'WEBP', quality=quality, method=6)


def main():
    os.makedirs(ICONS, exist_ok=True)
    done = []
    for f in sorted(os.listdir(RAW)):
        if not f.endswith('.png'):
            continue
        name = f[:-4]
        src = Image.open(os.path.join(RAW, f)).convert('RGB')
        if name in CROP:
            w, h = src.size
            k = CROP[name]
            src = src.crop((int(w * (1 - k) / 2), int(h * (1 - k) / 2), int(w * (1 + k) / 2), int(h * (1 + k) / 2)))
        if name in CROP_Y:
            w, h = src.size
            k = CROP_Y[name]
            src = src.crop((0, int(h * (1 - k) / 2), w, int(h * (1 + k) / 2)))
        a = np.asarray(src).astype(np.float32)
        if name in FX:
            a = black_levels(a)
            a = edge_fade(a, 0.08 if name != 'fx_lightning' else 0.0001, 4 if name == 'fx_fire_sheet' else 1)
            if name == 'fx_lightning':
                # Only fade top and bottom; the strip repeats left to right.
                h = a.shape[0]
                ys = np.arange(h)
                a = a * np.clip(np.minimum(ys, h - 1 - ys) / (h * 0.15), 0, 1)[:, None, None]
            save(a, os.path.join(ART, name + '.webp'), FX[name])
        elif name in TEX:
            a = seamless(a, 0.2, horizontal_only=(name == 'tex_rim'))
            save(a, os.path.join(ART, name + '.webp'), TEX[name], 85)
            if name in GRAY:
                # A white copy for tinting in code (luminance, lifted a little).
                g = a.max(axis=2, keepdims=True) * 0.5 + a.mean(axis=2, keepdims=True) * 0.5
                save(np.repeat(np.clip(g * 1.25, 0, 255), 3, axis=2), os.path.join(ART, GRAY[name] + '.webp'), FX[name])
        elif name.startswith('icon_'):
            save(a, os.path.join(ICONS, name[5:] + '.webp'), (128, 128), 90)
        elif name.startswith('portrait_'):
            save(a, os.path.join(ICONS, name + '.webp'), (128, 128), 90)
        else:
            continue
        done.append(name)
    print(len(done), 'processed:', ' '.join(done))


if __name__ == '__main__':
    sys.exit(main())
