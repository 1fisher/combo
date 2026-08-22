#!/usr/bin/env python3
"""从 public/combo-icon.png 生成 Android 全套启动器图标(mipmap 各密度)。

产物:
  mipmap-<dpi>/ic_launcher.png           方形(深色底)
  mipmap-<dpi>/ic_launcher_round.png     圆形裁切
  mipmap-<dpi>/ic_launcher_foreground.png 自适应图标前景(API 26+,内容落在 safe zone)

依赖:Pillow(python3 -m pip install pillow)。更换 App 图标后重跑:
  python3 scripts/gen-android-icons.py
"""
from PIL import Image, ImageDraw
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'public', 'combo-icon.png')
RES = os.path.join(ROOT, 'android', 'app', 'src', 'main', 'res')

BG = (16, 17, 22, 255)  # 对齐前端 background(dark) ≈ #101116

LEGACY = {'mdpi': 48, 'hdpi': 72, 'xhdpi': 96, 'xxhdpi': 144, 'xxxhdpi': 192}
# 自适应图标画布 108dp,内容缩至 ~62% 以落入 safe zone
FOREGROUND = {'mdpi': 108, 'hdpi': 162, 'xhdpi': 216, 'xxhdpi': 324, 'xxxhdpi': 432}


def with_bg(icon: Image.Image, size: int) -> Image.Image:
    canvas = Image.new('RGBA', (size, size), BG)
    ic = icon.copy()
    ic.thumbnail((size, size), Image.LANCZOS)
    canvas.paste(ic, ((size - ic.width) // 2, (size - ic.height) // 2), ic)
    return canvas


def circle(img: Image.Image) -> Image.Image:
    mask = Image.new('L', img.size, 0)
    ImageDraw.Draw(mask).ellipse((0, 0, img.size[0] - 1, img.size[1] - 1), fill=255)
    out = Image.new('RGBA', img.size, (0, 0, 0, 0))
    out.paste(img, (0, 0), mask)
    return out


def main() -> None:
    src = Image.open(SRC).convert('RGBA')
    for dpi, size in LEGACY.items():
        d = os.path.join(RES, f'mipmap-{dpi}')
        os.makedirs(d, exist_ok=True)
        with_bg(src, size).save(os.path.join(d, 'ic_launcher.png'))
        circle(with_bg(src, size)).save(os.path.join(d, 'ic_launcher_round.png'))
    for dpi, size in FOREGROUND.items():
        canvas = Image.new('RGBA', (size, size), (0, 0, 0, 0))
        ic = src.copy()
        target = int(size * 0.62)
        ic.thumbnail((target, target), Image.LANCZOS)
        canvas.paste(ic, ((size - ic.width) // 2, (size - ic.height) // 2), ic)
        canvas.save(os.path.join(RES, f'mipmap-{dpi}', 'ic_launcher_foreground.png'))
    print('Android 启动器图标已生成(mipmap-mdpi..xxxhdpi)')


if __name__ == '__main__':
    main()
