# -*- coding: utf-8 -*-
r"""生成图像管线的**测试输入**夹具（`web\test\fixtures\images\`）。

用法（在项目根目录 `emblem-tool\` 下执行）：

    python web\test\make_image_fixtures.py

产出：

    web\test\fixtures\images\<名字>.rgba        裸 RGBA（行优先，每像素 4 字节）
    web\test\fixtures\images\image-manifest.json
                                                每张图的 width / height / 用途 /
                                                源图统计（不透明色数、半透明像素数）/
                                                `tools\prepare_image.py` 处理后的
                                                **参考结论**（不是逐像素判据）

--------------------------------------------------------------------------------
为什么是"裸 RGBA"而不是 PNG
--------------------------------------------------------------------------------
TS 侧的解码由 canvas 负责（SPEC.md §五 ①），Node 测试里没有 canvas。所以夹具必须
是**已解码**的形式：裸 RGBA 正好就是 `createImageBitmap` 之后
`getImageData().data` 的模样，`node:fs` 一读就能直接喂给 `src/core/image.ts`，
两边都不需要解码器。等价的 PNG 仍会写到临时目录，只用于跑 `prepare_image.py`
取参考结论（跑完删除）。

--------------------------------------------------------------------------------
为什么参考结论只记"色数 / 半透明数"
--------------------------------------------------------------------------------
`docs\01-项目理解\03-图片处理管线.md` §六 已定案：Pillow 的 LANCZOS 与
MEDIANCUT 细节**不可复刻**，所以逐像素对齐那一档只留给
"已是 128×128 且 ≤255 色且无半透明"的图（那些图不缩放、不减色，两边都必须无损）。
其余图只把 **prepare_image.py 的合规统计**记下来当参考值 ——
它和 TS 侧的 `distinctOpaqueColors()` / `semiTransparentCount()` 是**同一个口径**
（`alpha == 0xFF` 才算实色），所以这几个数字**可以硬比**，而像素**不硬比**。

--------------------------------------------------------------------------------
确定性
--------------------------------------------------------------------------------
每张图的像素全部由固定随机种子（`random.Random(<常数>)`）生成，并且：
调色板、几何、阈值常数都写死在本文件里。重复运行 ⇒ 逐字节相同的 `.rgba`。
（`prepare_image.py` 的参考结论也必须是确定性的，否则说明上游用了随机量化 ——
 脚本末尾会**重跑一次**并比对，不确定就报错。）

本脚本只写 `web\test\fixtures\images\`，不碰任何既有文件、不联网。
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import math
import os
import random
import shutil
import sys
import tempfile

# ★ 不要写 __pycache__：本脚本会 import `tools\prepare_image.py`，默认行为会在
#   `tools\` 下留一个 `__pycache__\prepare_image.cpython-312.pyc`。本项目规矩是
#   "不动 tools\ / docs\ 等既有目录" —— 少生成一个文件就少一次争议。
sys.dont_write_bytecode = True

# ─────────────────────────── 路径 ───────────────────────────

HERE = os.path.dirname(os.path.abspath(__file__))          # emblem-tool\web\test
WEB = os.path.dirname(HERE)                                 # emblem-tool\web
PROJ = os.path.dirname(WEB)                                 # emblem-tool
TOOLS = os.path.join(PROJ, 'tools')
OUT_DIR = os.path.join(HERE, 'fixtures', 'images')
OUT_JSON = os.path.join(OUT_DIR, 'image-manifest.json')

sys.path.insert(0, TOOLS)

try:
    from PIL import Image
except ImportError:                                          # pragma: no cover
    sys.exit('需要 Pillow：pip install Pillow（本项目 3.12 + Pillow 12.1.1 已验证）')

# `tools\prepare_image.py` 作为**参考实现**引进：只用来取合规统计。
_pi_spec = importlib.util.spec_from_file_location('prepare_image',
                                                  os.path.join(TOOLS, 'prepare_image.py'))
prepare_image = importlib.util.module_from_spec(_pi_spec)    # type: ignore[arg-type]
_pi_spec.loader.exec_module(prepare_image)                   # type: ignore[union-attr]


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def rel(path: str) -> str:
    """项目根目录相对的 posix 风格路径（manifest 里只用这种）。"""
    return os.path.relpath(path, PROJ).replace('\\', '/')


def stats(rgba: bytes) -> dict:
    """与 `image.ts::distinctOpaqueColors/semiTransparentCount` 同口径的统计。

    口径（三处必须一致）：**只有 `alpha == 0xFF` 才算实色**；
    `0 < alpha < 255` 算半透明；`alpha == 0` 算背景。
    """
    colors = set()
    opaque = 0
    semi = 0
    px = len(rgba) // 4
    for i in range(0, len(rgba), 4):
        a = rgba[i + 3]
        if a == 0xFF:
            opaque += 1
            colors.add((rgba[i], rgba[i + 1], rgba[i + 2]))
        elif a != 0:
            semi += 1
    return {
        'width': None,                        # 由调用方填
        'height': None,
        'pixels': px,
        'opaquePixels': opaque,
        'transparentPixels': px - opaque - semi,
        'semiTransparentPixels': semi,
        'opaqueColors': len(colors),
    }


# ─────────────────────────── 八张输入图 ───────────────────────────
#
# 每张图都对应一条**具体的判据**（见文件头的映射表），不是随手凑数：
#   ① 像素风 40 色 128×128  → 判据 (b) 无损（M2 最重要的一条）
#   ② 渐变 >255 色 128×128   → 判据 (b) 不适用（要减色）/ (c) 合规 / 与 Python 参考色数比对
#   ③ 300×300 照片感噪声    → 判据 (e) 感知合理（下采样 + smooth 核）
#   ④ 502×202 长条 logo     → 判据 (a) 取景差异（contain 补背景 / cover 裁切）/ (c) 非方图
#   ⑤ 140×140 半透明边缘    → 判据 (a) 二值化 / (c) 半透明必须归零
#   ⑥ 3×3 极小图            → 判据 (a) 几何（刚好卡边界的浮点坑）+ (c) 放大后无背景
#   ⑦ 1×1 单像素图          → 判据 (a) 几何（contain 铺满整张目标图）
#   ⑧ 64×64 少量透明        → 判据 (b) 变体（有透明像素的无损）+ 放大路径

PIXEL_ART_PALETTE = [
    (0x0B, 0x0B, 0x0B), (0x1A, 0x1A, 0x1A),                       # 背景底 / 网格线
    (0x33, 0x33, 0x33), (0x44, 0x44, 0x44),
    (0xE8, 0x3A, 0x3A), (0xC2, 0x2F, 0x2F), (0x9C, 0x24, 0x24), (0x76, 0x19, 0x19),
    (0x3A, 0x7A, 0xE8), (0x2F, 0x62, 0xC2), (0x24, 0x4A, 0x9C), (0x19, 0x32, 0x76),
    (0x3A, 0xE8, 0x7A), (0x2F, 0xC2, 0x62), (0x24, 0x9C, 0x4A), (0x19, 0x76, 0x32),
    (0xE8, 0xE8, 0x3A), (0xC2, 0xC2, 0x2F), (0x9C, 0x9C, 0x24), (0x76, 0x76, 0x19),
    (0xE8, 0x3A, 0xE8), (0xC2, 0x2F, 0xC2), (0x9C, 0x24, 0x9C), (0x76, 0x19, 0x76),
    (0x3A, 0xE8, 0xE8), (0x2F, 0xC2, 0xC2), (0x24, 0x9C, 0x9C), (0x19, 0x76, 0x76),
    (0xF2, 0xF2, 0xF2), (0xDD, 0xDD, 0xDD), (0xAA, 0xAA, 0xAA), (0x66, 0x66, 0x66),
    (0x5A, 0x3C, 0x1E), (0x46, 0x2F, 0x17), (0xFF, 0xD8, 0xA8), (0xD8, 0xB0, 0x80),
    (0x00, 0x40, 0x80), (0x00, 0x60, 0xC0), (0x80, 0x40, 0x00), (0xC0, 0x60, 0x00),
]


def build_pixel_art() -> 'Image.Image':
    r"""① 128×128 像素风：**恰好 40 种颜色**（全部不透明）。

    构造上有"色数 = 40"的**结构性保证**，不靠运气：
      · 背景只用 2 种颜色（`0B0B0B` 底 + `1A1A1A` 每 40 px 网格线）—— 这两种
        也**在 `PIXEL_ART_PALETTE` 里**（前两项），否则它们会变成第 41/42 色
        （第一版就是这么数出 42 的）；
      · 30 个随机矩形只从调色板前 10 种里取色；
      · **最后**用 40 个 3×3 方块把调色板里的每一种颜色逐个点上去
        （分两行 20+20；画在矩形之上，所以不会被盖掉）。
      ⇒ 总实色数恒为 **40**，`distinctOpaqueColors()` 必须正好报 40。
    为什么这么造：它同时是判据 (b) 的输入（128×128 / 40 ≤ 255 / 无半透明）
    和 `'auto'` 核判据的边界样本（40 ≤ 256 ⇒ 必须走 nearest，不许糊边）。
    """
    rng = random.Random(0xA1B2C3)
    W = H = 128
    pal = PIXEL_ART_PALETTE
    assert len(pal) == 40
    img = Image.new('RGBA', (W, H))
    px = img.load()
    # 底色 + 每 40 px 一条网格线（两种颜色）
    for y in range(H):
        for x in range(W):
            px[x, y] = (0x1A, 0x1A, 0x1A, 0xFF) if (x % 40 == 0 or y % 40 == 0) \
                else (0x0B, 0x0B, 0x0B, 0xFF)
    # 30 个矩形：颜色从调色板前 10 种里取
    for i in range(30):
        c = pal[rng.randrange(10)]
        x0 = rng.randrange(0, 108)
        y0 = rng.randrange(0, 108)
        w = rng.randrange(4, 40)
        h = rng.randrange(4, 40)
        for y in range(y0, min(H, y0 + h)):
            for x in range(x0, min(W, x0 + w)):
                px[x, y] = (c[0], c[1], c[2], 0xFF)
    # 调色板里的**每一种**颜色各点一个 3×3 方块 ⇒ 40 色满额。
    # ⚠ 必须**最后**画（画在矩形之上），否则会被随机矩形盖掉；
    #   而且一行放不下 40 格（128 / 3 = 42，但格子要留间隙）⇒ 分两行。
    #   这两条都是踩过的：第一版一行 4×4、步长 24，只画得下 6 格 ⇒ 色数悄悄变 12。
    for k, c in enumerate(pal):
        col = k % 20
        row = k // 20
        x0 = 2 + col * 6
        y0 = 2 + row * 5
        for y in range(y0, y0 + 3):
            for x in range(x0, x0 + 3):
                px[x, y] = (c[0], c[1], c[2], 0xFF)
    colors = {(px[x, y][0], px[x, y][1], px[x, y][2])
              for y in range(H) for x in range(W) if px[x, y][3] == 0xFF}
    assert len(colors) == 40, len(colors)                 # 结构性保证，写死在这里
    return img


def build_gradient() -> 'Image.Image':
    r"""② 128×128 渐变：色数 > 255（必然是 16,384 种），α 恒 255。

    R = x*2 / G = y*2 / B = (x+y) ⇒ 所有通道都随坐标单调变化，
    "下采样后块平均色偏了"会立刻在判据 (e) 的对应坐标上暴露出来。
    它是"必须减色"那一档：判据 (b) 对它不适用，但 `prepareEmblem` 必须仍然合规
    （且不透明色数被压到 ≤255）。
    """
    W = H = 128
    img = Image.new('RGBA', (W, H))
    px = img.load()
    for y in range(H):
        for x in range(W):
            px[x, y] = (x * 2, y * 2, (x + y) & 0xFF, 0xFF)
    return img


def build_photo_noise() -> 'Image.Image':
    r"""③ 300×300 照片感噪声：大色块 + 逐像素噪声 + 柔和光斑，全部不透明。

    这是判据 (e)（感知合理性）的**主力输入**：300 → 128 是 2.34× 下采样，
    走 `'smooth'` 核（色数远超 256）⇒ 正好检验"面积平均没有整体错位/串色"。
    为什么加"柔和光斑"：纯噪声的块平均会互相抵消，把整体错位掩盖掉；
    低频的大色块才是"错位就必然超阈值"的那种结构。
    """
    rng = random.Random(0x5EED01)
    W = H = 300
    img = Image.new('RGBA', (W, H))
    px = img.load()
    # 四象限基色 + 中间一条渐变带（低频、可预测）
    quads = [(200, 60, 40), (40, 120, 200), (60, 190, 90), (210, 180, 50)]
    for y in range(H):
        for x in range(W):
            qi = (1 if x >= W // 2 else 0) + (2 if y >= H // 2 else 0)
            r, g, b = quads[qi]
            # 垂直条纹（低频，14 px 周期）
            if (x // 14) % 2 == 0:
                r = min(255, r + 18)
                b = max(0, b - 12)
            # 逐像素噪声
            n = rng.randrange(-26, 27)
            r = max(0, min(255, r + n))
            g = max(0, min(255, g + n))
            b = max(0, min(255, b + n))
            px[x, y] = (r, g, b, 0xFF)
    # 两个柔和光斑（径向渐变，故意跨越象限边界 ⇒ 错位必露）
    for (cx, cy, rad, tint) in ((110, 90, 85, (255, 240, 200)), (215, 205, 70, (20, 20, 60))):
        for y in range(max(0, cy - rad), min(H, cy + rad)):
            for x in range(max(0, cx - rad), min(W, cx + rad)):
                d = math.hypot(x - cx, y - cy) / rad
                if d >= 1.0:
                    continue
                k = (1.0 - d) ** 2
                r, g, b, _ = px[x, y]
                px[x, y] = (
                    int(r + (tint[0] - r) * k),
                    int(g + (tint[1] - g) * k),
                    int(b + (tint[2] - b) * k),
                    0xFF,
                )
    return img


def build_banner_logo() -> 'Image.Image':
    r"""④ 502×202 非方长条 logo：不透明、**恰好 9 种颜色**（硬边色块）⇒ 自动判 nearest。

    构造（色数结构性保证）：
      · 整高色带区：4 条 26 px 横带用 4 种颜色；
      · 中间区：白色边框（第 5 色）+ 斜条纹。条纹用 `((x±y)//2)%2` 的四个组合，
        实测四种组合**都会出现**（各约 16.2k 像素）⇒ 红 / 青 / 绿 / 深灰 4 色；
      · 3 个方块标记复用青色（不增加色数）。
      ⇒ 4 + 1 + 4 = **9 色**。
    ⚠ 别把"看似 3 种组合"当真：`(u,v)` 的四种组合是等量出现的（本文件曾按
      "最多 3 种"写下断言，结果实测 9 色 —— 断言就是这么把它挡下来的）。
    为什么用"2×2 棋盘"而不是 16 px 竖条纹：502/128 ≈ 3.92 倍下采样，
    16 px 周期接近 4 倍频 ⇒ **会**和最近邻采样产生明显摩尔纹（这本身是个真实现象，
    但会污染"色数固定"这条断言）。4 px 周期的相位关系稳定得多。

    判据 (a) 的"取景差异"样本：同一张图在 contain 下**必须补背景**、
    在 cover 下**必须没有背景像素**（裁掉左右）、在 stretch 下不补背景但会横向压扁。
    """
    W, H = 502, 202
    img = Image.new('RGBA', (W, H))
    px = img.load()
    band = [(0x10, 0x18, 0x2E), (0x1E, 0x2C, 0x52), (0x2E, 0x46, 0x7A), (0x46, 0x6A, 0xA8)]
    for y in range(H):
        for x in range(W):
            px[x, y] = band[(y // 26) % len(band)] + (0xFF,)
    # 白色边框（第 5 色）
    for y in range(H):
        for x in range(W):
            if x < 6 or x >= W - 6 or y < 6 or y >= H - 6:
                px[x, y] = (0xF0, 0xF0, 0xF0, 0xFF)
    # 斜条纹：`((x±y)//2)%2` 的四种组合 ⇒ 红 / 青 / 绿 / 深灰（四色都会出现）
    for y in range(24, H - 24):
        for x in range(40, W - 40):
            u = ((x + y) // 2) % 2
            v = ((x - y) // 2) % 2
            if u == 0 and v == 0:
                px[x, y] = (0xE0, 0x30, 0x30, 0xFF)
            elif u == 1 and v == 0:
                px[x, y] = (0x20, 0xC0, 0xE0, 0xFF)
            elif u == 0 and v == 1:
                px[x, y] = (0x20, 0xE0, 0x60, 0xFF)
            else:
                px[x, y] = (0x20, 0x20, 0x20, 0xFF)
    # 三个方块标记（复用青色 ⇒ 不增加色数；打破斜条纹周期性，使位置可辨）
    for (bx, by) in ((150, 60), (250, 100), (350, 140)):
        for y in range(by, by + 26):
            for x in range(bx, bx + 26):
                px[x, y] = (0x20, 0xC0, 0xE0, 0xFF)
    colors = {(px[x, y][0], px[x, y][1], px[x, y][2])
              for y in range(H) for x in range(W) if px[x, y][3] == 0xFF}
    assert len(colors) == 9, len(colors)                # 结构性保证（实测 9，不是 8）
    return img


def build_soft_edge() -> 'Image.Image':
    r"""⑤ 140×140 带半透明边缘的圆盘（含孤立半透明点）。

    alpha 分三段：内部 255（不透明）/ 环带 60..240（半透明）/ 外部 0（透明）。
    用来验证二值化的**两个方向**：
      · 阈值 128 之下，环带里 ≥128 的会被判成不透明（RGB 是 `90 E0 B0`）、
        <128 的判成透明；
      · 二值化后 140→128（contain，只缩一点点）会插值出**新的**半透明像素
        ⇒ 缩放后必须**再**二值化一次（文档 §九 第 4 步），否则合规检查会不过。
    另外撒 24 个**孤立**的半透明点（alpha 200 ≥ 阈值 ⇒ 二值化后是不透明的孤立点），
    用来验证 `despeckle` 选项（它删"没有同伴"的不透明像素）。
    """
    W = H = 140
    img = Image.new('RGBA', (W, H))
    px = img.load()
    cx = cy = 70.0
    for y in range(H):
        for x in range(W):
            d = math.hypot(x - cx, y - cy)
            if d <= 44.0:
                px[x, y] = (0x20, 0xC0, 0x60, 0xFF)      # 实心核心
            elif d <= 52.0:
                t = (52.0 - d) / 8.0                     # 0..1 的软边
                a = int(60 + t * 180)                    # 60..240
                px[x, y] = (0x90, 0xE0, 0xB0, a)
            else:
                px[x, y] = (0, 0, 0, 0)
    rng = random.Random(0x0FF1CE)
    for _ in range(24):
        x = rng.randrange(2, W - 2)
        y = rng.randrange(2, H - 2)
        if math.hypot(x - cx, y - cy) <= 56.0:
            continue                                     # 别撒到圆盘里
        # ★ alpha 必须 ≥ 阈值（128）：alpha < 阈值的点在**二值化**那一步就变全透明了，
        #   `despeckle` 根本无从下手（它只处理"已判定为不透明"的像素）。
        #   第一版用了 96，结果 despeckle 的前后不透明数完全一样 —— 测试当场抓到了。
        px[x, y] = (0xFF, 0xFF, 0xFF, 200)
    return img


def build_tiny3() -> 'Image.Image':
    r"""⑥ 3×3、9 种颜色、全部不透明。

    判据 (a) 的主力：`contain` 放大到 128×128 时 9 个源像素各占 42~43 像素宽的方块，
    中心像素与四个角都能精确断言。它同时是"浮点边界"样本 ——
    3×3 放大时源像素 0 的中心算出来是 0.49999999999999645，用 `floor` 会多丢一列
    （image.ts 的 nearestFit 注释里记了这件事）。
    """
    W = H = 3
    img = Image.new('RGBA', (W, H))
    px = img.load()
    for y in range(H):
        for x in range(W):
            px[x, y] = (x * 60, y * 60, (x + y) * 20, 0xFF)
    return img


def build_one_pixel() -> 'Image.Image':
    r"""⑦ 1×1 单像素图（不透明）。

    `contain` 时缩放倍率 = 128 ⇒ **整张目标图都是同一个颜色**（四角也是），
    这是"四角 == 背景"那条断言唯一不适用的特例，必须在测试里显式区分。
    """
    img = Image.new('RGBA', (1, 1))
    img.putpixel((0, 0), (0xC8, 0x64, 0x32, 0xFF))
    return img


def build_small_transparent() -> 'Image.Image':
    r"""⑧ 64×64：**恰好 32 种颜色**（8 色调色板 + 24 个孤立随机色）+ 大量全透明像素。

    构造（色数结构性保证）：
      · 左上三角（`x + y < 78`）从 8 色板随机取色 ⇒ 8 色；
      · 右下透明区用 `rng.sample` **不重复**地取 24 个位置，各点一个随机 RGB ⇒ 24 色。
      ⇒ 8 + 24 = **32 色**（随机色与 8 色板撞色的概率极低，撞了断言会报出来）。
    为什么用 `sample` 而不是循环抽：避免"同一个位置被抽中两次"导致色数少 1，
    那会让"恰好 32 色"这条断言变成偶尔失败 —— 夹具必须是确定的。

    判据 (b) 的变体：它是"非目标尺寸的小图"，所以含放大路径，
    但含"透明像素必须保持透明"这一半。放大 2× 走 nearest
    ⇒ 输出里出现的颜色必须**全部**来自源图（不许发明中间色）。
    """
    W = H = 64
    pal = [(0xE8, 0x3A, 0x3A, 0xFF), (0x3A, 0x7A, 0xE8, 0xFF), (0x3A, 0xE8, 0x7A, 0xFF),
           (0xE8, 0xE8, 0x3A, 0xFF), (0xE8, 0x3A, 0xE8, 0xFF), (0x3A, 0xE8, 0xE8, 0xFF),
           (0xFF, 0xFF, 0xFF, 0xFF), (0x00, 0x00, 0x00, 0xFF)]
    rng = random.Random(0xBEEF77)
    img = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    px = img.load()
    # 只画左上一半多一点 ⇒ 右下半是透明（保证"透明像素保持透明"这条有样本）
    for y in range(H):
        for x in range(W):
            if x + y < 78:
                px[x, y] = pal[rng.randrange(len(pal))]
    # 透明区点 24 个**互不相同位置**的孤立实色像素
    placed = 0
    for flat in rng.sample(range(W * H), 400):          # 确定性洗牌后取前若干个空位
        if placed >= 24:
            break
        xx, yy = divmod(flat, W)
        if px[xx, yy][3] == 0:
            px[xx, yy] = (rng.randrange(256), rng.randrange(256), rng.randrange(256), 0xFF)
            placed += 1
    assert placed == 24, placed
    colors = {(px[x, y][0], px[x, y][1], px[x, y][2])
              for y in range(H) for x in range(W) if px[x, y][3] == 0xFF}
    assert len(colors) == 32, len(colors)               # 结构性保证
    return img


FIXTURES = [
    dict(name='pixel-art-128', build=build_pixel_art,
         why='已是 128×128 且只有 40 色的像素风图',
         judge='(b) ★ 无损：输入即输出（逐像素等价）；(a) auto 核必须判 nearest（40 ≤ 256）'),
    dict(name='gradient-128', build=build_gradient,
         why='已是 128×128 的渐变图（16,384 色，远超 255）',
         judge='(c) 合规：必须减色到 ≤255 且不透明像素全保留；(e) 色阶不失真'),
    dict(name='photo-noise-300', build=build_photo_noise,
         why='300×300 照片感噪声图（色数很多，含低频色块与光斑）',
         judge='(a) 缩放路径；(c) 合规；(e) ★ 感知合理：输出块平均色 vs 源图对应区域平均色'),
    dict(name='banner-logo-502x202', build=build_banner_logo,
         why='502×202 非方长条 logo（不透明，色数少 ⇒ nearest）',
         judge='(a) ★ 取景：contain 必补背景 / cover 必无背景 / stretch 无背景；'
              '(c) 非方图也必须产出 128×128'),
    dict(name='soft-edge-140', build=build_soft_edge,
         why='140×140 带半透明边缘的圆盘（+24 个 alpha=200 的孤立点）',
         judge='(a) 二值化阈值两侧都有效；(c) 半透明必须归零；despeckle 选项的样本'),
    dict(name='tiny-3x3', build=build_tiny3,
         why='3×3 极小图（9 色，全部不透明）',
         judge='(a) ★ 几何：contain 放大后中心/四角可精确断言；浮点边界样本'),
    dict(name='one-pixel', build=build_one_pixel,
         why='1×1 单像素图',
         judge='(a) 几何特例：contain 时 128×128 全图恒等于该像素（四角不是背景）'),
    dict(name='small-64-with-transparent', build=build_small_transparent,
         why='64×64 小图，32 色 + 大量全透明像素（无半透明）',
         judge='(b) 变体：有透明的无损（透明保持透明、实色逐像素相同）；'
              '(a) 放大 2× 走 nearest，不许发明中间色'),
]


# ─────────────────────────── 主流程 ───────────────────────────

def alpha_threshold() -> int:
    """二值化阈值：取参考实现的默认值（`--alpha-threshold` 默认 128）。

    不写死 128，而是从 `prepare_image` 的默认参数里读 —— 这样"两边同阈值"
    是**结构性**保证的，将来上游改默认值这里会跟着变（测试会立刻发现差异）。
    """
    import inspect
    return inspect.signature(prepare_image.prepare).parameters['alpha_threshold'].default


def reference_notes(img: 'Image.Image', tmpdir: str, name: str) -> dict:
    """把这张图存成 PNG 交给 `tools\\prepare_image.py`，记下它的**结论**。

    ⚠ 只记统计结论（尺寸 / 实色数 / 半透明数 / 复核是否通过），
      **不记像素** —— Pillow 的 LANCZOS / MEDIANCUT 细节不可复刻
      （`03-图片处理管线.md` §六）。
    """
    src_png = os.path.join(tmpdir, name + '.src.png')
    out_png = os.path.join(tmpdir, name + '.ready.png')
    img.save(src_png)
    try:
        rgba, notes = prepare_image.prepare(src_png, colors=255,
                                            alpha_threshold=alpha_threshold(),
                                            size=128, verbose=False)
    except SystemExit as exc:
        return {'ok': False, 'error': str(exc), 'notes': []}
    Image.frombytes('RGBA', (128, 128), rgba).save(out_png)
    st = stats(rgba)
    st['width'] = 128
    st['height'] = 128
    return {
        'ok': st['opaqueColors'] <= 255 and st['semiTransparentPixels'] == 0,
        'size': '128x128',
        'opaqueColors': st['opaqueColors'],
        'opaquePixels': st['opaquePixels'],
        'semiTransparentPixels': st['semiTransparentPixels'],
        'rgbaSha256': sha256(rgba),
        'notes': notes,
    }


def main() -> int:
    os.makedirs(OUT_DIR, exist_ok=True)
    tmpdir = tempfile.mkdtemp(prefix='ac-emblem-imgfix-')
    manifest = {
        'generator': 'web/test/make_image_fixtures.py',
        'note': ('图像管线的测试**输入**夹具（裸 RGBA）。参考结论来自 '
                 'tools/prepare_image.py（Pillow），只作合规统计参考，'
                 '**不作为逐像素判据**（LANCZOS/MEDIANCUT 不可复刻，见 '
                 'docs/01-项目理解/03-图片处理管线.md §六）。'),
        'format': {
            'file': '裸 RGBA，行优先，每像素 4 字节（R,G,B,A），无文件头',
            'bytesFormula': 'width * height * 4',
            'colorSpace': 'sRGB（与 canvas getImageData 一致，非线性域直接处理）',
        },
        'alphaThreshold': alpha_threshold(),
        'maxColors': 255,
        'targetSize': 128,
        'images': [],
    }

    try:
        for spec in FIXTURES:
            img = spec['build']()
            W, H = img.size
            rgba_img = img.convert('RGBA')
            rgba = rgba_img.tobytes()
            assert len(rgba) == W * H * 4, (spec['name'], len(rgba), W, H)

            st = stats(rgba)
            st['width'] = W
            st['height'] = H

            # 参考实现（Pillow）的结论 —— 在**等价 PNG** 上跑，与裸 RGBA 同源
            ref = reference_notes(rgba_img, tmpdir, spec['name'])

            out_path = os.path.join(OUT_DIR, spec['name'] + '.rgba')
            with open(out_path, 'wb') as fh:
                fh.write(rgba)

            entry = {
                'name': spec['name'],
                'file': rel(out_path),
                'width': W,
                'height': H,
                'bytes': len(rgba),
                'sha256': sha256(rgba),
                'why': spec['why'],
                'judge': spec['judge'],
                'sourceStats': st,
                'reference': ref,
            }
            manifest['images'].append(entry)
            print('%-28s %4dx%-4d %7d B  实色 %5d  半透明 %5d  → 参考: %s'
                  % (spec['name'], W, H, len(rgba), st['opaqueColors'],
                     st['semiTransparentPixels'],
                     ('%d 色 / %d 半透明 / %s' % (ref['opaqueColors'],
                                                  ref['semiTransparentPixels'],
                                                  'OK' if ref['ok'] else '⚠'))
                     if ref.get('ok') is not None else ('跳过：%s' % ref.get('error'))))

        # ── 确定性自证：同种子再生成一遍，必须逐字节相同 ──
        for spec in FIXTURES:
            again = spec['build']().convert('RGBA').tobytes()
            first = open(os.path.join(OUT_DIR, spec['name'] + '.rgba'), 'rb').read()
            if again != first:
                sys.exit('✗ 非确定性：%s 两次生成结果不同' % spec['name'])

        # ── 参考实现确定性自证：prepare 是纯函数，不许有随机量化 ──
        for spec in FIXTURES:
            entry = next(e for e in manifest['images'] if e['name'] == spec['name'])
            if entry['reference'].get('ok') is None and 'opaqueColors' not in entry['reference']:
                continue
            img = spec['build']().convert('RGBA')
            ref2 = reference_notes(img, tmpdir, spec['name'] + '.again')
            if ref2.get('rgbaSha256') != entry['reference'].get('rgbaSha256'):
                sys.exit('✗ 参考实现不确定：%s（prepare_image.py 两次结果不同）' % spec['name'])

        with open(OUT_JSON, 'w', encoding='utf-8', newline='\n') as fh:
            json.dump(manifest, fh, ensure_ascii=False, indent=2, sort_keys=True)
            fh.write('\n')
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)

    print('\n已写出 %d 张输入图 + %s'
          % (len(manifest['images']), rel(OUT_JSON)))
    print('阈值 %d / 上限 255 色 / 目标 128×128（与 prepare_image.py 同口径）'
          % manifest['alphaThreshold'])
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
