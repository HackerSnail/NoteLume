# -*- coding: utf-8 -*-
"""生成 NoteLume 的主程序图标（桌面快捷方式 / 任务栏 / exe 内嵌那枚）。

产物：
  tmp/app-icon-source.png    1024 方图、透明底，交给 `tauri icon` 当输入
  tmp/app-icon-preview.png   深浅两种底色的尺寸预览（tmp/ 不入库）

用法（两步，改设计只改本脚本再跑一遍，不要手改 src-tauri/icons 下的二进制）：
  python scripts/gen-app-icon.py
  node src\\node_modules\\@tauri-apps\\cli\\tauri.js icon tmp/app-icon-source.png

依赖 Pillow 与 numpy（pip install pillow numpy）。图标全部几何绘制，不依赖字体或外部素材。
轮廓、折角、配色与 scripts/gen-file-icons.py 的 .md / .canvas 图标同源，三个图标放一起是一族，
主图标靠字标区分：纸页上是白色「N」（NoteLume 首字母），文件图标是「M↓」和三点连线。
"""
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "tmp" / "app-icon-source.png"
PREVIEW = ROOT / "tmp" / "app-icon-preview.png"

S = 1024                    # 设计画布
SS = 4                      # 超采样倍数
BLUE = (61, 111, 227)       # #3D6FE3
PURPLE = (131, 56, 236)     # #8338EC

# 纸张轮廓：左上 / 右下，右上角切一刀做折角（与 gen-file-icons.py 同一组常量）
X0, Y0, X1, Y1 = 168, 104, 856, 920
RADIUS = 96
FOLD = 196


def gradient(size):
    """左上蓝、右下紫的对角渐变。"""
    import numpy as np
    y, x = np.mgrid[0:size, 0:size]
    t = ((x + y) / (2 * (size - 1))).astype(np.float32)[..., None]
    a = np.array(BLUE, dtype=np.float32)
    b = np.array(PURPLE, dtype=np.float32)
    return Image.fromarray((a + (b - a) * t).astype("uint8"), "RGB")


def page_mask(size):
    """圆角纸页 + 右上切角，4x 超采样后缩回。"""
    m = Image.new("L", (size * SS, size * SS), 0)
    d = ImageDraw.Draw(m)
    k = SS
    # 外扩几个超采样像素，避免切角边缘被圆角矩形包出细线
    d.rounded_rectangle([X0 * k, Y0 * k, X1 * k, Y1 * k], radius=RADIUS * k, fill=255)
    d.polygon([(X1 - FOLD - k) * k, (Y0 - k) * k,
               (X1 + k) * k, (Y0 - k) * k,
               (X1 + k) * k, (Y0 + FOLD + k) * k], fill=0)
    return m.resize((size, size), Image.Resampling.LANCZOS)


def inner_mask(size):
    """沿纸张轮廓内缩 10px 的一圈内高光。"""
    m = Image.new("L", (size * SS, size * SS), 0)
    d = ImageDraw.Draw(m)
    k = SS
    pad = 10
    d.rounded_rectangle([(X0 + pad) * k, (Y0 + pad) * k, (X1 - pad) * k, (Y1 - pad) * k],
                        radius=(RADIUS - pad) * k, fill=255)
    d.polygon([(X1 - FOLD - pad - k) * k, (Y0 - pad - k) * k,
               (X1 - pad + k) * k, (Y0 - pad - k) * k,
               (X1 - pad + k) * k, (Y0 + FOLD - pad + k) * k], fill=0)
    return m.resize((size, size), Image.Resampling.LANCZOS)


def stroke(draw, points, width, fill):
    draw.line(points, fill=fill, width=width, joint="curve")
    r = width // 2
    # 圆头：两端各补一个圆点，joint="curve" 只负责拐点
    for x, y in (points[0], points[-1]):
        draw.ellipse([x - r, y - r, x + r, y + r], fill=fill)


def draw_glyph(d):
    """白色「N」：左竖、左上到右下斜、右竖。

    单字母比 .md 图标那组「M↓」（线宽 68）加粗到 84，缩到 16px 时笔画不至于和渐变底混在一起。
    横向 342..682、纵向 347..677，中心 (512, 512) 与纸页中心 (168+856)/2 重合。
    """
    stroke(d, [(342, 677), (342, 347), (682, 677), (682, 347)], 84, (255, 255, 255, 255))


def render():
    size = S
    mask = page_mask(size)
    page = Image.new("RGBA", (size, size))
    page.paste(gradient(size), (0, 0), mask)

    # 一圈很淡的内高光，给纸页一点厚度
    ring = ImageChops.subtract(mask, inner_mask(size))
    shine = Image.new("RGBA", (size, size), (255, 255, 255, 0))
    shine.putalpha(ring.point(lambda v: int(v * 0.16)))
    page = Image.alpha_composite(page, shine)

    # 折角：半透明白，压在切角内侧
    fold = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(fold).polygon(
        [(X1 - FOLD, Y0), (X1, Y0 + FOLD), (X1 - FOLD, Y0 + FOLD)],
        fill=(255, 255, 255, 56))
    page = Image.alpha_composite(page, fold)

    glyph = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw_glyph(ImageDraw.Draw(glyph))

    # 白色图形下面垫一层淡阴影，缩到 16px 时不至于糊成一片
    shadow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    shadow.putalpha(glyph.getchannel("A").point(lambda v: int(v * 0.35)))
    shadow = shadow.filter(ImageFilter.GaussianBlur(10))
    page = Image.alpha_composite(page, shadow)
    page = Image.alpha_composite(page, glyph)

    # 底部投影，让图标在浅色壁纸上也有轮廓
    sm = Image.new("L", (size, size), 0)
    sm.paste(mask, (0, 12))
    sh = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    sh.putalpha(sm.filter(ImageFilter.GaussianBlur(22)).point(lambda v: int(v * 0.28)))
    return Image.alpha_composite(sh, page)


def write_preview(img):
    from PIL import ImageFont
    pad, gap = 28, 26
    cols = [256, 128, 64, 48, 32, 24, 16]
    col_w = [max(s, 60) + gap for s in cols]
    w = pad * 2 + sum(col_w)
    h = pad * 2 + (256 + 68) + 30
    canvas = Image.new("RGB", (w, h), (247, 248, 250))
    d = ImageDraw.Draw(canvas)
    try:
        font = ImageFont.truetype("C:/Windows/Fonts/msyh.ttc", 18)
    except OSError:
        font = ImageFont.load_default()

    # 上半浅色、下半深色，一次看完桌面与深色壁纸两种底色
    d.rectangle([0, 0, w, h // 2], fill=(247, 248, 250))
    d.rectangle([0, h // 2, w, h], fill=(35, 37, 43))
    d.text((pad, pad), "App  桌面快捷方式 / 任务栏 / exe", fill=(45, 48, 55), font=font)
    x = pad
    y = pad + 28
    for s, cw in zip(cols, col_w):
        tile = Image.new("RGBA", (cw, 256), (0, 0, 0, 0))
        im = img.resize((s, s), Image.Resampling.LANCZOS)
        tile.alpha_composite(im, ((cw - s) // 2, (256 - s) // 2))
        canvas.paste(tile, (x, y), tile)
        x += cw
    PREVIEW.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(PREVIEW)


def main():
    img = render()
    SOURCE.parent.mkdir(parents=True, exist_ok=True)
    img.save(SOURCE)
    print(f"source -> {SOURCE}")
    write_preview(img)
    print(f"preview -> {PREVIEW}")


if __name__ == "__main__":
    main()
