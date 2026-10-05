#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把任意图片加工成"acet 能安全吃下"的 128×128 PNG。

这是上游 GUI 里那段图像预处理逻辑（`acet-gui.cpp::InjectHelper`）的独立重写，
你可以直接拿它当自己 GUI 的图像前置步骤，或者拿来检查别人的图为什么注入后花掉。

上游 GUI 的流程（`acet-gui.cpp:190-243`）：
    ① 若有 alpha 且无 mask → `ConvertAlphaToMask()`   （阈值 128，把 alpha 压成 1 bit）
    ② 若 宽>128 或 高>128   → `Rescale(128,128)`
    ③ 若颜色数 > 上限       → `wxQuantize::Quantize(...)`
    ④ 逐像素输出 RGBA：透明 → (0,0,0,0)，否则 (r,g,b,0xFF)

本脚本做同样的事，但把顺序与判据都写成显式的、可断言的：

    ① alpha 二值化（阈值可调，默认 128，与 wxWidgets 默认一致）
    ② 缩放到 128×128（缩放后**再**二值化一次，避免插值造出半透明边）
    ③ 只对**不透明像素**减色到 ≤N 色（默认 255），透明像素不占调色板槽位
    ④ 输出 RGBA PNG，并**独立复核**：不透明像素的不同 RGB 数 ≤ N

用法：
    python tools/prepare_image.py 任意图.jpg -o ready.png
    python tools/prepare_image.py 图.png --colors 200 --alpha-threshold 64
    python tools/prepare_image.py 图.png --check-only        # 只检查合规性
"""

from __future__ import annotations

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import acet_format as af  # noqa: E402

W = af.IMAGE_WIDTH
H = af.IMAGE_HEIGHT
MAX_COLORS = af.MAX_COLORS          # 255


def _need_pillow():
    try:
        from PIL import Image  # noqa: F401
    except ImportError:
        sys.exit("需要 Pillow：pip install Pillow")


def count_opaque_colors(rgba: bytes) -> int:
    """独立数一遍"不透明像素用到几种不同 RGB" —— 就是 acet 调色板会占几项。"""
    s = set()
    for i in range(0, len(rgba), 4):
        if rgba[i + 3] == 0xFF:
            s.add((rgba[i], rgba[i + 1], rgba[i + 2]))
    return len(s)


def prepare(src: str, colors: int = MAX_COLORS, alpha_threshold: int = 128,
            size: int = W, verbose: bool = True):
    """返回 (RGBA bytes, 说明文本列表)。"""
    _need_pillow()
    from PIL import Image

    im = Image.open(src)
    orig_mode, orig_size = im.mode, im.size
    notes = ["源: %s  %s %dx%d" % (os.path.basename(src), orig_mode,
                                  orig_size[0], orig_size[1])]
    im = im.convert("RGBA")

    # ① alpha 二值化：徽章只有"全透明/全不透明"
    r, g, b, a = im.split()
    hist = a.histogram()                       # 先数，再改，否则统计不到
    n_half = sum(hist[1:255])
    a = a.point(lambda v: 255 if v >= alpha_threshold else 0)
    im = Image.merge("RGBA", (r, g, b, a))
    notes.append("① alpha 二值化(阈值 %d)：半透明像素 %d 个已归一" % (alpha_threshold, n_half))

    # ② 缩放
    if im.size != (size, size):
        im = im.resize((size, size), Image.LANCZOS)
        # 缩放会插值出新的 alpha 与新的颜色 → 重新二值化
        r, g, b, a = im.split()
        a = a.point(lambda v: 255 if v >= alpha_threshold else 0)
        im = Image.merge("RGBA", (r, g, b, a))
        notes.append("② 缩放 %dx%d → %dx%d (LANCZOS)，alpha 重新二值化"
                     % (orig_size[0], orig_size[1], size, size))
    else:
        notes.append("② 尺寸已是 %dx%d，未缩放" % (size, size))

    # ③ 减色：只对不透明像素做，透明像素不占槽位
    img = im.load()
    opaque = [img[x, y][:3] for y in range(size) for x in range(size)
              if img[x, y][3] == 0xFF]
    n_before = len(set(opaque))
    if not opaque:
        raise SystemExit("图中没有任何不透明像素 —— 全透明的徽章没有意义")

    if n_before > colors:
        # 把所有透明像素的 RGB 换成"第一个不透明像素的颜色"，
        # 这样中位切分不会为它们分配额外槽位
        filler = opaque[0]
        px = im.load()
        for y in range(size):
            for x in range(size):
                if px[x, y][3] == 0:
                    px[x, y] = (filler[0], filler[1], filler[2], 0)

        rgb = im.convert("RGB")
        pal = rgb.quantize(colors=colors, method=Image.MEDIANCUT)
        rgb = pal.convert("RGB")
        out = Image.merge("RGBA", (*rgb.split(),
                                   im.split()[3]))
        notes.append("③ 减色：%d 色 → %d 色 (中位切分，仅对不透明像素)"
                     % (n_before, len(set(
                         out.load()[x, y][:3]
                         for y in range(size) for x in range(size)
                         if out.load()[x, y][3] == 0xFF))))
        im = out
    else:
        notes.append("③ 颜色数 %d ≤ 上限 %d，未减色" % (n_before, colors))

    # ④ 透明像素统一成 (0,0,0,0)
    px = im.load()
    for y in range(size):
        for x in range(size):
            if px[x, y][3] == 0:
                px[x, y] = (0, 0, 0, 0)

    rgba = im.tobytes()
    n_final = count_opaque_colors(rgba)
    notes.append("④ 最终：%d 个不透明像素用 %d 种颜色（acet 调色板占 %d 项，含透明项 1）"
                 % (sum(1 for i in range(3, len(rgba), 4) if rgba[i] == 0xFF),
                    n_final, n_final + 1))
    if n_final > colors:
        notes.append("   ⚠ 仍然超过上限 %d，注入会被上游静默截断" % colors)
    return rgba, notes


def check(path: str) -> int:
    """只检查一张图是否合规（不修改）。"""
    _need_pillow()
    from PIL import Image
    im = Image.open(path).convert("RGBA")
    rgba = im.tobytes()
    n = count_opaque_colors(rgba)
    half = sum(1 for i in range(3, len(rgba), 4) if 0 < rgba[i] < 255)
    ok = True
    print("文件      : %s" % path)
    print("尺寸      : %dx%d  %s" % (im.size[0], im.size[1],
                                   "OK" if im.size == (W, H) else "✗ 必须是 %dx%d" % (W, H)))
    ok &= im.size == (W, H)
    print("不透明色数: %d  %s" % (n, "OK (≤%d)" % MAX_COLORS if n <= MAX_COLORS
                                else "✗ 超过 %d，第 257 项起会被截断成索引 0（透明洞）" % MAX_COLORS))
    ok &= n <= MAX_COLORS
    print("半透明像素: %d  %s" % (half, "OK" if half == 0
                                else "✗ 会被全部当成透明（徽章只有 1 bit 透明度）"))
    ok &= half == 0
    print("结论      : %s" % ("可以安全注入" if ok else "不合规，先跑 prepare_image.py"))
    return 0 if ok else 1


def main(argv) -> int:
    ap = argparse.ArgumentParser(description="把图片加工成合规的 128x128 徽章 PNG")
    ap.add_argument("src")
    ap.add_argument("-o", "--out", help="输出 PNG 路径（默认 <src>.ready.png）")
    ap.add_argument("--colors", type=int, default=MAX_COLORS,
                    help="不透明颜色上限，默认 %d" % MAX_COLORS)
    ap.add_argument("--alpha-threshold", type=int, default=128,
                    help="alpha 二值化阈值，默认 128（与 wxWidgets ConvertAlphaToMask 一致）")
    ap.add_argument("--check-only", action="store_true", help="只检查，不输出")
    args = ap.parse_args(argv)

    if args.check_only:
        return check(args.src)
    if not os.path.exists(args.src):
        sys.exit("找不到文件：%s" % args.src)

    rgba, notes = prepare(args.src, args.colors, args.alpha_threshold)
    for n in notes:
        print(n)

    out = args.out or (args.src + ".ready.png")
    _need_pillow()
    from PIL import Image
    Image.frombytes("RGBA", (W, H), rgba).save(out)
    print("已写出    : %s" % out)

    # 用与 acet 相同的计数口径独立复核一次
    n = count_opaque_colors(rgba)
    if n > args.colors:
        print("⚠ 复核不通过：%d 色 > %d" % (n, args.colors))
        return 1
    print("复核通过  : %d 色 ≤ %d" % (n, args.colors))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
