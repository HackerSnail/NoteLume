# -*- coding: utf-8 -*-
"""生成 NoteLume 的关联文件图标（.md / .markdown / .canvas）。

产物：
  src-tauri/icons/file-markdown.ico    Windows，16-256 全尺寸
  src-tauri/icons/file-canvas.ico
  src-tauri/icons/file-markdown.icns   macOS 文档类型图标
  src-tauri/icons/file-canvas.icns
  tmp/file-icon-preview.png            预览图（tmp/ 不入库）

用法：python scripts/gen-file-icons.py
依赖 Pillow 与 numpy（pip install pillow numpy）。图标全部几何绘制，不依赖字体或外部素材。
"""
from io import BytesIO
from pathlib import Path
import struct

from PIL import Image, ImageChops, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "src-tauri" / "icons"
PREVIEW = ROOT / "tmp" / "file-icon-preview.png"

S = 1024                    # 设计画布
SS = 4                      # 超采样倍数
BLUE = (61, 111, 227)       # #3D6FE3
PURPLE = (131, 56, 236)     # #8338EC

# 纸张轮廓：左上 / 右下，右上角切一刀做折角
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


def draw_markdown(d):
    w = 68
    shift = -22
    white = (255, 255, 255, 255)
    # M
    stroke(d, [(330 + shift, 660), (330 + shift, 370), (450 + shift, 530),
               (570 + shift, 370), (570 + shift, 660)], w, white)
    # 向下箭头
    stroke(d, [(680 + shift, 370), (680 + shift, 620)], w, white)
    stroke(d, [(615 + shift, 555), (680 + shift, 620), (745 + shift, 555)], w, white)


def draw_canvas(d):
    w = 54
    white = (255, 255, 255, 255)
    pts = [(382, 512), (642, 392), (566, 690)]
    r = 74
    for a, b in ((0, 1), (1, 2), (0, 2)):
        d.line([pts[a], pts[b]], fill=white, width=w)
    for x, y in pts:
        d.ellipse([x - r, y - r, x + r, y + r], fill=white)


def render(kind):
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
    gd = ImageDraw.Draw(glyph)
    draw_markdown(gd) if kind == "markdown" else draw_canvas(gd)

    # 白色图形下面垫一层淡阴影，缩到 16px 时不至于糊成一片
    shadow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    shadow.putalpha(glyph.getchannel("A").point(lambda v: int(v * 0.35)))
    shadow = shadow.filter(ImageFilter.GaussianBlur(10))
    page = Image.alpha_composite(page, shadow)
    page = Image.alpha_composite(page, glyph)

    # 底部投影，让图标在浅色背景上也有轮廓
    sm = Image.new("L", (size, size), 0)
    sm.paste(mask, (0, 12))
    sh = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    sh.putalpha(sm.filter(ImageFilter.GaussianBlur(22)).point(lambda v: int(v * 0.28)))
    return Image.alpha_composite(sh, page)


def dib(frame):
    """32bpp DIB，供 ICO 内嵌（高度按 ICO 约定翻倍）。"""
    buf = BytesIO()
    frame.save(buf, "dib")
    data = buf.getvalue()
    return data[:8] + struct.pack("<I", frame.height * 2) + data[12:]


def png(frame):
    buf = BytesIO()
    frame.save(buf, "PNG", optimize=True)
    return buf.getvalue()


def write_ico(img, path):
    sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256]
    frames = []
    for s in sizes:
        small = img.resize((s, s), Image.Resampling.LANCZOS)
        # 64 及以下用 DIB（老外壳组件也能读），128 起用 PNG（256 的 DIB 要 256KB）
        frames.append((s, png(small) if s >= 128 else dib(small)))

    head = struct.pack("<HHH", 0, 1, len(frames))
    offset = 6 + 16 * len(frames)
    entries, blobs = [], []
    for s, data in frames:
        entries.append(struct.pack("<BBBBHHII", s if s < 256 else 0,
                                   s if s < 256 else 0, 0, 0, 1, 32,
                                   len(data), offset))
        blobs.append(data)
        offset += len(data)
    path.write_bytes(head + b"".join(entries) + b"".join(blobs))


def write_icns(img, path):
    # PNG 型 icns：16/32/64/128/256/512/1024 与 @2x 槽位
    slots = [(b"icp4", 16), (b"icp5", 32), (b"icp6", 64),
             (b"ic07", 128), (b"ic08", 256), (b"ic09", 512), (b"ic10", 1024),
             (b"ic11", 32), (b"ic12", 64), (b"ic13", 256), (b"ic14", 512)]
    body = b""
    for tag, s in slots:
        data = png(img.resize((s, s), Image.Resampling.LANCZOS))
        body += tag + struct.pack(">I", len(data) + 8) + data
    path.write_bytes(b"icns" + struct.pack(">I", len(body) + 8) + body)


def write_preview(icons):
    from PIL import ImageFont
    pad, gap = 28, 26
    cols = [256, 128, 64, 48, 32, 24, 16]
    col_w = [max(s, 60) + gap for s in cols]
    w = pad * 2 + sum(col_w)
    block = 256 + 68
    h = pad * 2 + block * len(icons) + 30
    canvas = Image.new("RGB", (w, h), (247, 248, 250))
    d = ImageDraw.Draw(canvas)
    try:
        font = ImageFont.truetype("C:/Windows/Fonts/msyh.ttc", 18)
    except OSError:
        font = ImageFont.load_default()

    # 上半浅色、下半深色，一次看完两种资源管理器底色
    d.rectangle([0, 0, w, h // 2], fill=(247, 248, 250))
    d.rectangle([0, h // 2, w, h], fill=(35, 37, 43))
    for i, (name, img) in enumerate(icons.items()):
        y = pad + i * block + 10
        d.text((pad, y), name, fill=(45, 48, 55) if i == 0 else (225, 228, 235), font=font)
        x = pad
        for j, s in enumerate(cols):
            tile = Image.new("RGBA", (col_w[j], 256), (0, 0, 0, 0))
            im = img.resize((s, s), Image.Resampling.LANCZOS)
            tile.alpha_composite(im, ((col_w[j] - s) // 2, (256 - s) // 2))
            canvas.paste(tile, (x, y + 28), tile)
            x += col_w[j]
    PREVIEW.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(PREVIEW)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    icons = {}
    for kind, stem, label in (("markdown", "file-markdown", "Markdown  .md / .markdown"),
                              ("canvas", "file-canvas", "Canvas  .canvas")):
        img = render(kind)
        write_ico(img, OUT / f"{stem}.ico")
        write_icns(img, OUT / f"{stem}.icns")
        icons[label] = img
        print(f"{stem}.ico / {stem}.icns")
    write_preview(icons)
    print(f"preview -> {PREVIEW}")


if __name__ == "__main__":
    main()
