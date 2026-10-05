#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""AC PS2 徽章存档格式 —— Python 参考实现（零第三方依赖）。

本文件是 mparley/ac-emblem-tool（"acet"，MIT）所实现的存档格式的独立重写，
用于：① 把上游 C++ 源码里散落的格式知识固化成可读、可断言的一份；
     ② 在不需要编译 C++ 的环境里读写/校验徽章存档；
     ③ 作为"独立判据"核对上游实现（见 verify_checksums / selftest.py）。

上游对应文件：`src/ac-emblem-tool/acet/acet.cpp` + `acet/acet.h`。
本文件**逐行对齐**上游语义（包括上游的边界行为），凡是"上游看起来像 bug、
但为了字节级兼容仍然照做"的地方，都在注释里用 ⚠ 标出。

--------------------------------------------------------------------------
格式总览（PS2 世代 AC 的徽章存档）
--------------------------------------------------------------------------
非 LR（AC2 / AC2AA / AC3 / SL / NX / NB；12544 行 × … 见下）：

    文件大小        0x4440 = 17472 字节
    0x00..0x23     36 字节存档头（前 12 字节 = 魔数 kEmblemHeader）
    0x24..0x4023   图像索引数据 128×128 每像素 1 字节 = 0x4000
    0x4024..0x4423 调色板 256 项 × 4 通道 = 0x400
    每 0x400 字节插入 1 个校验字节，把上面 0x4400 逻辑字节切成 17 段
    ★ 末段（第 18 段）= [53 字节数据 0x4400..0x4434][1 字节校验 @0x4435][10 字节 01 00*9]
      其中 0x4434 是 palette[255].alpha（游戏固定写 0x80），**不是**校验位

Last Raven（LR）：

    文件大小        0x4420 = 17440 字节
    0x00..0x03     4 字节头（无 36 字节存档头）
    0x04..0x4003   图像索引数据 0x4000
    0x4004..0x4403 调色板 0x400
    同样 17 段 + 末段；颜色索引**不做**乱序重排
    ★ 末段 = [21 字节数据 0x4400..0x4414][1 字节校验 @0x4415][10 字节 01 00*9]

逻辑下标 ↔ 物理偏移：物理 = emblem_offset + 逻辑 + 逻辑 // 0x3FF
（即每读完 0x3FF = 1023 个数据字节就跳过 1 个校验字节）

校验算法：每个数据段 checksum = (-(段内数据字节之和 + 段内数据字节数)) & 0xFF
    常规段 = 0x3FF 个数据字节；末段的数据长度是 53（非 LR）/ 21（LR）。

⚠ 上游 `acet` 把末段校验写在 `0x43FF + dangling`（= 数据**内部**），比真实位置早一个
  字节。它平时能用是因为总在已有存档上原地注入（尾部被保留）；从空白块造就会让游戏
  判 `破損ファイル`。本实现按真实位置写，详见 `apply_checksums` / `verify_checksums`。
"""

from __future__ import annotations

import os
import struct
from typing import List, Optional, Sequence, Tuple

# --------------------------------------------------------------------------
# 常量（对应上游 acet/acet.h）
# --------------------------------------------------------------------------
SAVE_SIZE = 0x4440          # kSaveSize   非 LR 徽章存档大小
LR_SAVE_SIZE = 0x4420       # kLRSaveSize Last Raven 徽章存档大小
IMAGE_OFFSET = 0x24         # kImageOffset    非 LR：图像数据相对徽章块起点的偏移
LR_IMAGE_OFFSET = 0x4       # kLRImageOffset  LR  ：同上
IMAGE_WIDTH = 128           # kImageWidth
IMAGE_HEIGHT = 128          # kImageHeight
NUM_PIXELS = 0x4000         # kNumPixels   128*128
PALETTE_SIZE = 0x400        # kPaletteSize 256 色 * 4 通道

BLOCK = 0x400               # 含校验字节的物理块大小
BLOCK_DATA = 0x3FF          # 每个物理块里的数据字节数

# kEmblemHeader：非 LR 存档头前 12 字节。
#   0x4420 0x4420 0x4000 三个 u32LE —— 前两个是「徽章块长度」(= LR 存档大小)，
#   第三个是图像数据长度 (0x4000)。上游用它做"在容器里找徽章块"的锚点。
EMBLEM_HEADER = bytes([0x20, 0x44, 0x00, 0x00,
                       0x20, 0x44, 0x00, 0x00,
                       0x00, 0x40, 0x00, 0x00])

# ---------------------------------------------------------------------------
# ★★ LR 的块头 —— 4 字节 `00 44 00 00`（实机定案 2026-10-04）
# ---------------------------------------------------------------------------
# LR 没有非 LR 那 36 字节头（图像从 0x04 就开始），但**头 4 字节不是随便的**：
# 两份真实 LR 存档都是 `00 44 00 00`（u32LE = 0x4400 = 索引 0x4000 + 调色板 0x400
# = 逻辑载荷长度）。
#
# ⚠ 本目录曾经漏掉它：`make_blank_save()` 里写的是 `if with_header and not is_lr:`，
#   **LR 分支根本不写头** ⇒ 从零造出来的 LR 块前 4 字节是 `00 00 00 00`。
#   后果：把这种块写进 LR 卡 ⇒ **游戏直接卡死**（`Mcd001_final2.ps2` 实测，2026-10-04）。
#   之前一直没暴露，是因为 LR 只测过"在真实块上原地注入"（头被原样保留）。
LR_EMBLEM_HEADER = bytes([0x00, 0x44, 0x00, 0x00])

# 末段校验字节之后还剩 11 字节（非 LR 与 LR 都是 11 字节）
TRAILING = 11

# ---------------------------------------------------------------------------
# ★★★ 末段（第 18 段）的真实布局 —— 实机定案 2026-10-04
# ---------------------------------------------------------------------------
# 上游把 `dangling`（0x35 = 53 / 0x15 = 21）当成"从上一个校验字节起的偏移"，
# 于是把末段校验写在 `0x43FF + dangling`。**这是差一个字节的**：
# `dangling` 其实是**末段的数据长度**，而数据是从上一个校验字节的**下一个字节**开始的。
#
# 真实布局（10 份真实存档 + 实机写入实验一致）：
#
#   非 LR： [53 字节数据 0x4400..0x4434] [1 字节校验 @0x4435] [10 字节 01 00*9]
#   LR   ： [21 字节数据 0x4400..0x4414] [1 字节校验 @0x4415] [10 字节 01 00*9]
#
#   · 0x4400..0x4433 = 调色板最后 14 项（槽 242..255 一带）的字节
#     （这段里 0x43FF 处跳过一个校验字节，槽边界不再与 4 字节对齐 —— 定位一律走
#      `offset_index()`，别用连续切片）
#   · **0x4434 不是校验位，而是 `palette[255].alpha`**（游戏固定写 0x80）
#   · 校验之后那 10 字节 `01 00 00 00 00 00 00 00 00 00` 不参与任何校验
#
# 为什么上游"看起来也能用"：它在**已有存档上原地注入**，那 11 字节尾巴被原样保留。
# 尾部形如 `X 01 00*9` 时 `sum(尾部) = X + 1`，于是上游的旧公式
#   b[0x4434] = -(sum(0x4400..0x4433) + sum(0x4435..0x443F) + 52)
# 与真实公式
#   b[0x4435] = -(sum(0x4400..0x4434) + 53)
# **恒等**（两者是同一个方程）。从空白块造时尾部为 0，恒等关系不成立 ⇒ 游戏判
# `破損ファイル`。所以本实现按真实公式写，并保证那 10 字节尾巴要么是游戏写下的真值、
# 要么（空白块）补成 `01 00*9`。
#
# ⚠ `FINAL_CHECK_OFF` / `DANGLING` 这两个名字保留，但语义是**上游的（错的）**写法，
#    只给 `apply_checksums_upstream()` 做逐行对照用。
FINAL_CHECK_OFF = SAVE_SIZE - TRAILING - 1        # 0x4434（= palette[255].alpha）
FINAL_CHECK_OFF_LR = LR_SAVE_SIZE - TRAILING - 1  # 0x4414（= palette[255].alpha）

DANGLING = FINAL_CHECK_OFF - (17 * BLOCK - 1)        # 0x35 = 53
DANGLING_LR = FINAL_CHECK_OFF_LR - (17 * BLOCK - 1)  # 0x15 = 21

# ---- 修正后的末段常量 ----
FINAL_SEG_OFF = 17 * BLOCK                        # 0x4400 末段数据起点（两种布局相同）
FINAL_DATA_LEN = {False: 53, True: 21}            # 含 palette[255].alpha；= 上游的 dangling
FINAL_CHECK_POS = {False: FINAL_SEG_OFF + FINAL_DATA_LEN[False],
                   True: FINAL_SEG_OFF + FINAL_DATA_LEN[True]}   # 0x4435 / 0x4415
FINAL_ALPHA_POS = {False: FINAL_CHECK_OFF, True: FINAL_CHECK_OFF_LR}      # 0x4434 / 0x4414
# 校验字节之后的 10 字节：游戏写成 `01` + 9 个 0（不参与校验）
FINAL_TRAILER = bytes([0x01]) + bytes(9)
# 游戏把每个调色板项的 alpha 都写成 0x80（"完全不透明"），索引 0 那项写 0x00
PALETTE_ALPHA_OPAQUE = 0x80

# 第一段校验的"魔数"种子 —— 上游注释：the first one has a magic number added to sum
SEED = 0x98
SEED_LR = 0xB8

# ---------------------------------------------------------------------------
# 非 LR 的「作品常量」字段 0x14..0x1C（9 字节）
# ---------------------------------------------------------------------------
# 非 LR 的块头布局（实测 10 份真实样本，逐字节一致）：
#   0x00..0x0B  魔数（= 载荷长度 0x4420、0x4420、图像长度 0x4000）
#   0x0C..0x13  8 字节全 0（所有样本一致）
#   0x14..0x1C  ★ 9 字节「作品常量」—— 一个字都不能猜
#   0x1D..0x23  7 字节全 0（所有样本一致）
#
# ★ 为什么必须填它（**这条理由与"游戏是否校验"无关，是硬的**）：
#   它是**作品级常量、与徽章内容无关**（SL 美版的玫瑰 —— 别的玩家、完全不同的图 ——
#   与 SL 日版的 MIRAGE 这 9 字节**完全相同**；NX 则是另一个值），
#   空白块里它是 0，与游戏自己的产物**逐字节不同**。
#   而本目录的正确性判据是"写入器作用在真实存档上要**逐字节复原**"
#   （`_selftest/validate_writer.py`）—— 要让这个判据成立，就必须把它填对。
#   ⚠ **不要用"游戏会判 `破損ファイル`"来论证它**：唯一的正面证据（`bisect` 卡 E02：
#   把真实块的这 9 字节清零 → 报 `破損ファイル`）有两个混淆因素 ——
#   ① 那轮用的还是**旧写入器**（末段校验差一字节，见文件顶部的说明）；
#   ② 那张卡的 NX 槽 `icon.sys@0xDF` 全是 0（重复槽号，会卡死）。
#   ⇒ "游戏是否真的校验这 9 字节"记为 **[待复测]**，但**照抄真实存档的做法不变**。
#
# ⚠ 目前只掌握 SL / NX / NB 的部分值。**其它作品（AC2 / AC2AA / AC3 / NB）必须先从一个
#   真实存档里读出这个字段**，不要猜。`header_tail_from_save()` 就是干这个的。
HEADER_TAIL_OFF = 0x14
HEADER_TAIL_LEN = 9

KNOWN_HEADER_TAIL = {
    "SLPS-25169": bytes.fromhex("00a130dd85ab078060"),   # Silent Line 日版
    "SLUS-20644": bytes.fromhex("00a130dd85ab078060"),   # Silent Line 美版（同值）
    "SLPS-25338": bytes.fromhex("80b230dd85ab078060"),   # Nexus 日版
    "SLUS-20986": None,                                   # Nexus 美版：未知，待读
}


def header_tail_from_save(save: bytes) -> bytes:
    """从一份**真实的非 LR 徽章存档**里取出那 9 字节作品常量（0x14..0x1C）。

    创建新徽章时**必须**用它（或查 `KNOWN_HEADER_TAIL`）填进空白块 —— 否则写出来的块
    与游戏自己的产物不是逐字节相同。**不要猜值**：它是作品级常量。
    （"游戏是否真的校验这 9 字节"记为 [待复测]，见上方注释；照抄真实存档的做法不变。）
    """
    base = find_offset(save) if len(save) > SAVE_SIZE else 0
    return bytes(save[base + HEADER_TAIL_OFF: base + HEADER_TAIL_OFF + HEADER_TAIL_LEN])

PALETTE_COLORS = 256
MAX_COLORS = 255            # 上游 README 明文要求：最多 255 色（+ 透明）


# --------------------------------------------------------------------------
# 基础工具
# --------------------------------------------------------------------------
def offset_index(i: int, emblem_offset: int = 0) -> int:
    """逻辑下标 → 物理偏移。等价上游 OffsetIndex()。

    每 0x3FF 个数据字节后有一个校验字节，所以物理位置要加上"已经跳过的校验字节数"。
    """
    return emblem_offset + i + i // BLOCK_DATA


def pack_color(r: int, g: int, b: int, a: int) -> int:
    """RGBA → u32，等价上游 PackColor()（r 在高位）。"""
    return ((r & 0xFF) << 24) | ((g & 0xFF) << 16) | ((b & 0xFF) << 8) | (a & 0xFF)


def unpack_color(c: int) -> Tuple[int, int, int, int]:
    """u32 → RGBA（pack_color 的逆运算）。"""
    return ((c >> 24) & 0xFF, (c >> 16) & 0xFF, (c >> 8) & 0xFF, c & 0xFF)


def unscramble_palette(index: int) -> int:
    """调色板索引乱序重排，等价上游 UnscramblePalette()。

    以 32 项为一组，交换中间两组 8 项：
        [0..7][8..15][16..23][24..31]  →  [0..7][16..23][8..15][24..31]
    LR 不做这一步。
    """
    group = (index % 32) // 8
    if group == 1:
        return index + 8
    if group == 2:
        return index - 8
    return index


UNSCRAMBLE_LUT = [unscramble_palette(i) for i in range(256)]


def is_lr_save(save: Sequence[int]) -> bool:
    """是否按 Last Raven 布局解析（上游只看文件大小）。"""
    return len(save) == LR_SAVE_SIZE


# --------------------------------------------------------------------------
# 定位
# --------------------------------------------------------------------------
def find_offset(save: bytes) -> int:
    """徽章块在文件里的起点。等价上游 FindOffset()。

    语义（含上游的怪癖，务必照做）：
      * len == 0x4440 → 直接返回 0（不搜索）
      * len == 0x4420 → 直接返回 0（不搜索）
      * len  > 0x4440 → 在文件里"找" kEmblemHeader
      * len  < 0x4440 且 != 0x4420 → 抛异常（文件太小）

    ⚠ 上游的"找"是**子序列**匹配而不是子串匹配：它按顺序匹配 header 的 12 个字节，
      中途失配就把计数清零，但**不要求 12 个字节相邻**。文件里若散落着这些字节，
      定位就可能落在错误的位置。本函数忠实复刻该行为；
      find_offset_contiguous() 给出"正确"的连续搜索版本，selftest 会比对两者。
    """
    n = len(save)
    if n > SAVE_SIZE:
        j = 0
        for i in range(n):
            if j == len(EMBLEM_HEADER):
                return i - j
            if save[i] == EMBLEM_HEADER[j]:
                j += 1
            else:
                j = 0
        # 循环结束前最后一次匹配也可能刚好凑满
        if j == len(EMBLEM_HEADER):
            return n - j
        raise ValueError("find_offset: 在文件里找不到徽章数据（缺少 12 字节魔数）")
    if n < SAVE_SIZE and n != LR_SAVE_SIZE:
        raise ValueError(
            "find_offset: 文件太小，不可能是徽章存档（%d 字节；应为 0x%X 或 0x%X）"
            % (n, LR_SAVE_SIZE, SAVE_SIZE))
    return 0


def find_offset_contiguous(save: bytes) -> int:
    """正确的连续子串搜索（用于对照上游的子序列搜索）。"""
    pos = save.find(EMBLEM_HEADER)
    if pos < 0:
        raise ValueError("find_offset_contiguous: 找不到 12 字节魔数")
    return pos


def find_palette_offset(data: bytes, stop: int = 0xFFFF) -> Optional[int]:
    """上游 FindPaletteOffset() 的复刻 —— 判定"拖进来的文件像不像存档"的启发式。

    逐字节扫描 [0, stop)，对每个位置取 13 字节，要求：
        buf[0..3] 全为 0x00；buf[7] == 0x80；buf[11] == 0x80
    中间 6 个字节不检查。

    ⚠ 上游这一函数有两处缺陷，本函数照做以求行为一致：
      ① 原式 `curr+i % 0x400 == 0x3FF` 因运算符优先级实际等于 `curr + i == 0x3FF`，
         只在文件开头附近生效；② 这个判据本身和 kEmblemHeader 对不上
         （header[0] = 0x20 ≠ 0），所以它并不能真正认出徽章存档。
      返回命中的偏移，找不到返回 None。
    """
    n = min(len(data), stop)
    pos = 0
    while pos < n:
        buf = data[pos:pos + 13]
        if len(buf) < 13:
            break
        found = True
        for i in range(12):
            off = 1 if (pos + i == 0x3FF) else 0   # 见上面 ①
            if i + off >= len(buf):
                found = False
                break
            if i < 4 and buf[i + off] != 0x00:
                found = False
                break
            if i in (7, 11) and buf[i + off] != 0x80:
                found = False
                break
        if found:
            return pos
        pos += 1
    return None


# --------------------------------------------------------------------------
# 校验和
# --------------------------------------------------------------------------
def segment_layout(is_lr: bool) -> List[Tuple[int, int, int, int]]:
    """(段起点, 数据字节数, 校验字节位置, 种子) 列表 —— 共 18 段（17 常规 + 1 末段）。

    这是从格式本身推出的布局，不照抄上游循环，因此可用作独立判据。
    只有第 0 段带魔数种子（0x98 / 0xB8），其余段的累加器都从 0 开始。

    ★ 末段按**修正后的真实布局**：数据 0x4400..(0x4434 / 0x4414)，校验字节紧随其后
      （0x4435 / 0x4415）。上游把校验写在数据内部（0x4434 / 0x4414）是差一个字节的，
      见文件顶部的常量说明；`apply_checksums_upstream()` 保留上游写法做对照。
    """
    size = LR_SAVE_SIZE if is_lr else SAVE_SIZE
    seed0 = SEED_LR if is_lr else SEED
    segs: List[Tuple[int, int, int, int]] = []
    for k in range(17):
        start = k * BLOCK
        segs.append((start, BLOCK_DATA, start + BLOCK_DATA, seed0 if k == 0 else 0))
    segs.append((FINAL_SEG_OFF, FINAL_DATA_LEN[is_lr], FINAL_CHECK_POS[is_lr], 0))
    assert segs[-1][2] < size
    return segs


def compute_checksum(data_region: bytes, data_len: int, seed: int = 0) -> int:
    """checksum = (-(种子 + 数据字节之和 + 数据字节数)) & 0xFF。"""
    return (-(seed + sum(data_region) + data_len)) & 0xFF


def verify_checksums(save: bytes) -> Tuple[bool, List[Tuple[str, int, int, int]]]:
    """独立复核一个徽章存档的全部 18 段校验字节（按**修正后的真实布局**）。

    返回 (是否全部通过, [(段名, 偏移, 文件里的值, 期望值), ...])，只列不通过的段。
    这是**独立判据**：它按格式定义重算，而不是把写入器的循环再跑一遍。

    ★ 末段用的是真实位置（0x4435 / 0x4415）。真实存档全部通过；
      上游 `acet` 从空白块造出来的存档会在末段**不通过**（差 0xFF），这正是
      非 LR 写入被游戏判 `破損ファイル` 的原因。要看上游写法是否自洽，
      用 `verify_checksums_upstream()`。
    """
    is_lr = is_lr_save(save)
    base = find_offset(save) if len(save) > SAVE_SIZE else 0
    segs = segment_layout(is_lr)
    bad: List[Tuple[str, int, int, int]] = []

    for idx, (start, dlen, cpos, seed) in enumerate(segs):
        abs_start = base + start
        abs_check = base + cpos
        data = save[abs_start:abs_check]
        if len(data) != dlen:
            bad.append(("seg%02d(截断)" % idx, abs_check, -1, -1))
            continue
        expect = compute_checksum(data, dlen, seed)
        got = save[abs_check]
        if got != expect:
            bad.append(("seg%02d" % idx, abs_check, got, expect))
    return (not bad), bad


def verify_checksums_upstream(save: bytes) -> Tuple[bool, List[Tuple[str, int, int, int]]]:
    """按**上游 `acet` 的（差一个字节的）末段写法**复核，仅供对照。

    上游：末段校验在 0x4434 / 0x4414，输入是 0x4400..0x4433 加上校验之后的尾巴。
    真实存档同时满足两套写法（见文件顶部说明），所以这个函数对真实存档也返回通过。
    """
    is_lr = is_lr_save(save)
    base = find_offset(save) if len(save) > SAVE_SIZE else 0
    size = LR_SAVE_SIZE if is_lr else SAVE_SIZE
    end = base + size
    segs = segment_layout(is_lr)
    bad: List[Tuple[str, int, int, int]] = []
    final_pos = FINAL_ALPHA_POS[is_lr]

    for idx, (start, dlen, cpos, seed) in enumerate(segs):
        if idx == len(segs) - 1:
            abs_start = base + FINAL_SEG_OFF
            abs_check = base + final_pos
            data = bytes(save[abs_start:abs_check]) + bytes(save[abs_check + 1:end])
            expect = compute_checksum(data, dlen - 1, seed)
        else:
            abs_start = base + start
            abs_check = base + cpos
            data = save[abs_start:abs_check]
            expect = compute_checksum(data, dlen, seed)
        got = save[abs_check]
        if got != expect:
            bad.append(("seg%02d" % idx, abs_check, got, expect))
    return (not bad), bad


def apply_checksums(save: bytearray) -> None:
    """就地重算全部 18 段校验字节（按**修正后的真实布局**）。

    流程：
      1. 把末段的 `palette[255].alpha`（0x4434 / 0x4414）写成游戏约定值 `0x80`；
      2. 它之后那 10 字节：**已有非零值就原样保留**（那是游戏写下的字段），
         只有从空白块造（全零）时才补上游戏那种 `01 00 00 00 00 00 00 00 00 00`；
      3. 逐段算校验：17 个 0x400 块的校验 @0x3FF..0x43FF；
         末段 = -(sum(0x4400..0x4434 / 0x4414) + 53 / 21) & 0xFF，写在紧随其后的那一格。

    ★ 这样写出来的文件**同时满足**上游写法与真实写法（尾部 `X 01 00*9` 使两式恒等），
      所以官方 exe 也仍然能正确读回。
    ★ 本函数作用在**游戏自己写的存档**上时是**逐字节复原**的（`_selftest/validate_writer.py`
      对 10 份真实存档断言了这一点）—— 这是判断写入器是否正确的硬判据。
    """
    is_lr = is_lr_save(save)
    base = find_offset(bytes(save)) if len(save) > SAVE_SIZE else 0
    segs = segment_layout(is_lr)

    # 1) + 2) 先把末段里的「非校验字节」安置好，再统一算校验
    alpha_pos = base + FINAL_ALPHA_POS[is_lr]
    save[alpha_pos] = PALETTE_ALPHA_OPAQUE
    trail_pos = alpha_pos + 2                       # 校验字节之后的 10 字节
    trail_end = trail_pos + len(FINAL_TRAILER)
    # ★ 那 10 字节是**游戏写下的字段**（上游最初的手工逆向里就是从源存档原样抄的），
    #   所以「有真值就保留」；只有从空白块造（全零）时才补上游戏那种 `01 00*9`。
    if not any(save[trail_pos:trail_end]):
        save[trail_pos:trail_end] = FINAL_TRAILER

    # 3) 逐段写校验（末段的数据区间包含刚写好的 alpha）
    for start, dlen, cpos, seed in segs:
        abs_start = base + start
        abs_check = base + cpos
        data = bytes(save[abs_start:abs_check])
        save[abs_check] = compute_checksum(data, dlen, seed)


def apply_checksums_upstream(save: bytearray) -> None:
    """上游 InjectImage() 校验循环的**逐行直译**，仅用于对照验证。"""
    is_lr = is_lr_save(save)
    base = find_offset(bytes(save)) if len(save) > SAVE_SIZE else 0
    size = LR_SAVE_SIZE if is_lr else SAVE_SIZE
    dangling = DANGLING_LR if is_lr else DANGLING

    s = SEED_LR if is_lr else SEED       # 首段种子
    prev_check = 0
    for i in range(size):
        if (i + 1) % BLOCK == 0:
            s = (~(s + BLOCK_DATA) + 1) & 0xFF
            prev_check = i + base
            save[prev_check] = s
            s = 0
        else:
            s = (s + save[i + base]) & 0xFF
    s = (s - (save[prev_check + dangling] + 0x01)) & 0xFF
    save[prev_check + dangling] = (~(s + dangling) + 1) & 0xFF


# --------------------------------------------------------------------------
# 提取 / 注入
# --------------------------------------------------------------------------
def extract_image(save: bytes, alpha_mode: str = "acet") -> bytes:
    """从徽章存档里取出 128×128 RGBA8888 图像。等价上游 ExtractImage()。

    返回 NUM_PIXELS * 4 字节。

    `alpha_mode` 控制 alpha 怎么归一：

      * `"acet"`（默认，上游行为）：**任何非零 alpha 一律变成 0xFF**。
        用于与官方 exe 逐像素对齐（交叉验证）。
      * `"index0"`（★ **最接近游戏实际显示**）：**调色板索引 0 = 透明，其余不透明**，
        **完全忽略 alpha 字节**。依据是实机观测（见下）。
      * `"gs"`：按 PS2 GS 的 alpha 语义 0..0x80 线性映射。
        ⚠ **这个档位看着"更忠实"，但实机证明它不是游戏的行为** —— 保留只作分析用。

    ★★ 三个档位的由来（2026-10-04，实机定案）：
      把 `data0` 的调色板 RGB 全部取反（`palette[0]` 从 `00 00 00 40` 变成 `FF FF FF 40`）
      后写进卡上的 `data2`，游戏里那一格显示出来：
        · 背景**仍是黑的**（并**没有**变成白、也没有变成 50% 灰）
        · 全格找不到成片的纯白（>250）或中性灰（100..190 只有散点）
      ⇒ **游戏不把索引 0 的 RGB/alpha 当颜色画**；索引 0 就是"背景/透明色"。
      ⇒ 所以 `"index0"` 才是对得上眼睛的那一档；`"gs"` 只是把 alpha 字节当真了。
      （未定：索引 0 到底是"透明（露出黑色底板）"还是"被强制画成黑"——
        两种解释在实机上都表现为黑，对使用没有区别。）
    """
    if alpha_mode not in ("acet", "gs", "index0"):
        raise ValueError("extract_image: alpha_mode 只能是 'acet' / 'gs' / 'index0'")

    is_lr = is_lr_save(save)
    base = find_offset(save) if len(save) > SAVE_SIZE else 0
    image_offset = LR_IMAGE_OFFSET if is_lr else IMAGE_OFFSET

    pixels = [save[offset_index(image_offset + i, base)] for i in range(NUM_PIXELS)]

    colors = bytearray(PALETTE_SIZE)
    for i in range(PALETTE_SIZE):
        c = save[offset_index(image_offset + NUM_PIXELS + i, base)]
        # 徽章只有"有/无"两种透明度；完全不透明被编码成 0x80，不是 0xFF
        if i % 4 == 3:
            if alpha_mode == "gs":
                c = min(255, (c * 255) // 128)   # GS 0..0x80 → PNG 0..255
            elif c != 0:
                c = 0xFF
        colors[i] = c
    if alpha_mode == "index0":
        # 索引 0 = 背景/透明；其余一律不透明（忽略存下来的 alpha 字节）
        for k in range(256):
            colors[k * 4 + 3] = 0 if k == 0 else 0xFF

    out = bytearray(NUM_PIXELS * 4)
    if is_lr:
        for i in range(NUM_PIXELS):
            ci = pixels[i] * 4
            out[i * 4:i * 4 + 4] = colors[ci:ci + 4]
    else:
        for i in range(NUM_PIXELS):
            ci = UNSCRAMBLE_LUT[pixels[i]] * 4
            out[i * 4:i * 4 + 4] = colors[ci:ci + 4]
    return bytes(out)


def inject_image(save: bytearray, image: bytes, *, strict: bool = True) -> None:
    """把 128×128 RGBA8888 图像写进徽章存档（就地修改）。等价上游 InjectImage()。

    规则：
      * alpha != 0xFF 的像素一律当作全透明（写调色板 0 号项 = 全 0）；
      * 调色板按"首次出现顺序"分配，所以颜色数 > 255 就会溢出；
      * 非 LR 的最后要按 UnscramblePalette 重排索引。
    """
    n_px = len(image) // 4
    if n_px != NUM_PIXELS:
        raise ValueError("inject_image: 图像必须恰好 %d 像素（%d×%d），收到 %d"
                         % (NUM_PIXELS, IMAGE_WIDTH, IMAGE_HEIGHT, n_px))

    is_lr = is_lr_save(save)
    base = find_offset(bytes(save)) if len(save) > SAVE_SIZE else 0
    image_offset = LR_IMAGE_OFFSET if is_lr else IMAGE_OFFSET

    palette_map = {pack_color(0, 0, 0, 0): 0}

    for i in range(n_px):
        c = 0
        if image[i * 4 + 3] == 0xFF:
            c = pack_color(image[i * 4], image[i * 4 + 1], image[i * 4 + 2], 0x80)

        if c not in palette_map:
            # ⚠ 上游判据是 `size() > 256`，所以第 257 项会被放进来，
            #   而其索引 256 写进 1 字节字段时截断成 0 ⇒ 静默串色。
            #   这里保持同样的阈值，但用 strict 把越界明确报出来。
            if palette_map.__len__() > 256:
                raise ValueError("inject_image: 颜色数超过 255（+透明）上限")
            if strict and len(palette_map) >= 256:
                raise ValueError(
                    "inject_image: 第 257 个颜色项会溢出 1 字节索引"
                    "（上游此处静默截断 ⇒ 串色）；strict=False 可复刻该行为")
            palette_map[c] = len(palette_map)
            val = palette_map[c]
            for ch in range(4):
                pos = offset_index(image_offset + NUM_PIXELS + val * 4 + ch, base)
                save[pos] = (c >> (24 - ch * 8)) & 0xFF

        p = palette_map[c] if is_lr else UNSCRAMBLE_LUT[palette_map[c] & 0xFF]
        # ⚠ 复刻 C++ 的 `uint8_t` 隐式截断：`strict=False` 时索引可能是 256，
        #    写进 1 字节字段就变成 0（= 透明项）—— 这正是上游 257 色的失败方式。
        save[offset_index(i + image_offset, base)] = p & 0xFF

    apply_checksums(save)


def inject_pixels_to_indices(image: bytes) -> Tuple[bytes, List[int]]:
    """辅助：按上游规则把 RGBA 图像量化成 (索引缓冲, 调色板 u32 列表)。

    便于检查"这张图会被压成几个颜色 / 索引怎么排"。
    """
    palette_map = {pack_color(0, 0, 0, 0): 0}
    indices = bytearray(NUM_PIXELS)
    for i in range(NUM_PIXELS):
        c = 0
        if image[i * 4 + 3] == 0xFF:
            c = pack_color(image[i * 4], image[i * 4 + 1], image[i * 4 + 2], 0x80)
        if c not in palette_map:
            palette_map[c] = len(palette_map)
        indices[i] = palette_map[c]
    inv = {v: k for k, v in palette_map.items()}
    return bytes(indices), [inv[i] for i in range(len(inv))]


# --------------------------------------------------------------------------
# 文件 I/O + 存档识别
# --------------------------------------------------------------------------
def read_save_file(path: str) -> bytes:
    with open(path, "rb") as f:
        return f.read()


def write_save_file(path: str, save: bytes | bytearray) -> None:
    with open(path, "wb") as f:
        f.write(bytes(save))


def make_blank_save(is_lr: bool = False, base_offset: int = 0,
                    with_header: bool = True, header_tail: bytes | None = None,
                    lr_header: bytes | None = None) -> bytearray:
    """造一个空白徽章存档（全部透明）。

    base_offset > 0 时在前面塞 base_offset 个 0x00 字节（模拟容器/记忆卡文件），
    并把 12 字节魔数写在徽章块起点上——这样 find_offset() 才找得到。

    ★ `header_tail`：非 LR 的 0x14..0x1C 那 9 字节**作品常量**。
      **不给就填 0，而 0 与游戏自己的产物逐字节不同** —— 要造一份真的能给游戏用的
      非 LR 徽章，必须传它（用 `header_tail_from_save()` 从同作品的真实存档取，或查
      `KNOWN_HEADER_TAIL`）。LR 没有这个字段，传了也会被忽略。
      （"游戏是否真的校验它"记为 [待复测]；一条硬理由是空白块必须能逐字节复原游戏产物。）

    ★ `lr_header`：**LR 的 4 字节块头**（`00 44 00 00`，见 `LR_EMBLEM_HEADER`）。
      不传就用那个实测常量。⚠ 写成 0 会让游戏**直接卡死**，别关掉 `with_header`。

    ★ 末段（第 18 段）校验由 `apply_checksums()` 按**真实位置**写好，并会一并保证
      校验之后那 10 字节要么是游戏写下的真值、要么补成 `01 00*9`。要"从零造一份能用的
      徽章"，推荐直接用 `encode_emblem()`（它还会把未用调色板项填成游戏惯例的
      `00 00 00 80`）。
    """
    size = LR_SAVE_SIZE if is_lr else SAVE_SIZE
    save = bytearray(base_offset + size)
    if with_header:
        if is_lr:
            hdr = LR_EMBLEM_HEADER if lr_header is None else lr_header
            if len(hdr) != len(LR_EMBLEM_HEADER):
                raise ValueError("make_blank_save: lr_header 必须是 %d 字节"
                                 % len(LR_EMBLEM_HEADER))
            save[base_offset:base_offset + len(hdr)] = hdr
        else:
            save[base_offset:base_offset + 12] = EMBLEM_HEADER
            if header_tail is not None:
                if len(header_tail) != HEADER_TAIL_LEN:
                    raise ValueError("make_blank_save: header_tail 必须是 %d 字节"
                                     % HEADER_TAIL_LEN)
                o = base_offset + HEADER_TAIL_OFF
                save[o:o + HEADER_TAIL_LEN] = header_tail
    apply_checksums(save)
    return save


def lr_header_from_save(save: bytes) -> bytes:
    """从一份**真实的 LR 徽章存档**里取出那 4 字节块头（实测都是 `00 44 00 00`）。"""
    base = find_offset(save) if len(save) > SAVE_SIZE else 0
    return bytes(save[base:base + len(LR_EMBLEM_HEADER)])


def used_palette_slots(save: bytes) -> List[int]:
    """这份存档里**被像素引用过**的调色板槽号（已还原乱序映射），升序。"""
    is_lr = is_lr_save(save)
    base = find_offset(save) if len(save) > SAVE_SIZE else 0
    image_offset = LR_IMAGE_OFFSET if is_lr else IMAGE_OFFSET
    px = [save[offset_index(image_offset + i, base)] for i in range(NUM_PIXELS)]
    if is_lr:
        return sorted(set(px))
    return sorted({UNSCRAMBLE_LUT[p] for p in px})


def fill_unused_palette(save: bytearray, rgba: Tuple[int, int, int, int] = (0, 0, 0, PALETTE_ALPHA_OPAQUE)) -> int:
    """把**没有被任何像素引用**的调色板项填成 `rgba`（默认 `00 00 00 80`），返回填了几项。

    为什么要填：游戏自己写的每一份非 LR 存档，**256 项里一个全零项都没有**
    （槽 0 除外）；未用项的 alpha 一律是 `0x80`。`inject_image` 只写用到的项，
    其余留 0，与游戏产物不同。

    ⚠ 只影响"未用项"，因此**不改变图像**；但会改变末段校验的取值（这是正常的）。
      槽 0（背景/透明）永远保持 `00 00 00 00`，不动。
    """
    is_lr = is_lr_save(save)
    base = find_offset(bytes(save)) if len(save) > SAVE_SIZE else 0
    image_offset = LR_IMAGE_OFFSET if is_lr else IMAGE_OFFSET
    used = set(used_palette_slots(bytes(save)))
    n = 0
    for k in range(1, 256):
        if k in used:
            continue
        # 两种布局下，调色板项都按槽号顺序存放（非 LR 的"乱序"只体现在像素索引上）
        for ch in range(4):
            save[offset_index(image_offset + NUM_PIXELS + k * 4 + ch, base)] = rgba[ch]
        n += 1
    return n


def encode_emblem(image: bytes, is_lr: bool = False, header_tail: bytes | None = None,
                  fill_unused: bool = True, lr_header: bytes | None = None) -> bytearray:
    """★ 推荐入口：把 128×128 RGBA8888 图像编成一份**能被游戏接受**的徽章存档。

    比"`make_blank_save` + `inject_image`"多做了三件必需的事：
      · 填上块头里的作品字段（非 LR 是 9 字节 `header_tail`；LR 是 4 字节 `00 44 00 00`）；
      · 末段校验按真实位置写（见 `apply_checksums`）；
      · 未用调色板项按游戏惯例填成 `00 00 00 80`（`fill_unused=True`）。
        ★ 实机已确认**不是硬性必需**（不填也正常读取），填它只是让输出与游戏产物同形）。

    `header_tail` 从同作品的真实存档里读（`header_tail_from_save()`），**不要猜**。
    """
    save = make_blank_save(is_lr=is_lr, with_header=True, header_tail=header_tail,
                           lr_header=lr_header)
    inject_image(save, image)
    if fill_unused:
        fill_unused_palette(save)
    apply_checksums(save)
    return save


def save_kind(save: bytes) -> str:
    """尽力判断这是什么。返回 'emblem-raw' / 'emblem-lr' / 'container' / 'unknown'。"""
    n = len(save)
    if n == LR_SAVE_SIZE:
        return "emblem-lr"
    if n == SAVE_SIZE:
        return "emblem-raw"
    if n > SAVE_SIZE:
        try:
            find_offset(save)
            return "container"
        except ValueError:
            return "unknown"
    return "unknown"


# --------------------------------------------------------------------------
# 自检：模块被直接运行时跑一遍内部一致性断言
# --------------------------------------------------------------------------
def _selfcheck() -> int:
    import random

    random.seed(20251004)
    failures = 0

    # 0) 推导出来的常量必须与上游源码里的字面量一致
    derived = {
        "DANGLING": (DANGLING, 0x35),
        "DANGLING_LR": (DANGLING_LR, 0x15),
        "FINAL_CHECK_OFF": (FINAL_CHECK_OFF, 0x4434),
        "FINAL_CHECK_OFF_LR": (FINAL_CHECK_OFF_LR, 0x4414),
        "SEED": (SEED, 0x98),
        "SEED_LR": (SEED_LR, 0xB8),
    }
    for name, (got, want) in derived.items():
        okc = got == want
        print("[常量] %-18s = 0x%X (上游 0x%X) %s"
              % (name, got, want, "OK" if okc else "FAIL"))
        failures += 0 if okc else 1

    for is_lr in (False, True):
        tag = "LR" if is_lr else "AC3"
        size = LR_SAVE_SIZE if is_lr else SAVE_SIZE
        save = make_blank_save(is_lr=is_lr)
        assert len(save) == size

        # 0) 块头：LR 的 4 字节 `00 44 00 00` 绝不能是 0（否则游戏直接卡死）
        if is_lr:
            hdr_ok = bytes(save[:len(LR_EMBLEM_HEADER)]) == LR_EMBLEM_HEADER
            print("[%s] 空白块头 = %s（应为 %s）: %s"
                  % (tag, bytes(save[:4]).hex(' '), LR_EMBLEM_HEADER.hex(' '),
                     "OK" if hdr_ok else "FAIL"))
            failures += 0 if hdr_ok else 1

        # 1) 空白存档的校验必须自洽
        ok, bad = verify_checksums(bytes(save))
        print("[%s] 空白存档校验: %s" % (tag, "OK" if ok else "FAIL %r" % (bad,)))
        failures += 0 if ok else 1

        # 2) 修正版 vs 上游直译：前 17 段必须逐字节相同；
        #    末段**故意不同**（上游差一个字节），且修正版必须让两套写法都自洽
        a = bytearray(save)
        b = bytearray(save)
        apply_checksums(a)
        apply_checksums_upstream(b)
        head_same = bytes(a[:17 * BLOCK]) == bytes(b[:17 * BLOCK])
        print("[%s] 前 17 段与上游直译一致: %s" % (tag, head_same))
        failures += 0 if head_same else 1
        print("[%s] 末段：上游写在 0x%X、修正版写在 0x%X（上游=%02X 修正=%02X）"
              % (tag, FINAL_ALPHA_POS[is_lr], FINAL_CHECK_POS[is_lr],
                 b[FINAL_ALPHA_POS[is_lr]], a[FINAL_CHECK_POS[is_lr]]))
        okA, badA = verify_checksums_upstream(bytes(a))
        print("[%s] 修正版写出的存档也满足上游写法: %s"
              % (tag, "OK" if okA else "FAIL %r" % (badA,)))
        failures += 0 if okA else 1
        okC, badC = verify_checksums(bytes(a))
        print("[%s] 修正版写出的存档满足真实写法: %s"
              % (tag, "OK" if okC else "FAIL %r" % (badC,)))
        failures += 0 if okC else 1
        # 上游从「尾部全零的空白块」造 → 真实写法下必须不通过（这就是被游戏拒的原因）
        z = bytearray(save)
        z[FINAL_ALPHA_POS[is_lr]:] = bytes(size - FINAL_ALPHA_POS[is_lr])
        apply_checksums_upstream(z)
        okZ, _ = verify_checksums(bytes(z))
        print("[%s] 上游从尾部全零的块造 → 真实写法下不通过（预期的差一字节）: %s"
              % (tag, "OK" if not okZ else "FAIL（不该通过）"))
        failures += 0 if not okZ else 1

        # 3) 随机图像注入 → 提取 往返必须一致（alpha 只有 0/255 时可逆）
        #    颜色数刻意压在 255 以内，避免撞上游的 256 项边界
        palette = [bytes([random.randrange(256), random.randrange(256),
                          random.randrange(256), 0xFF]) for _ in range(120)]
        img = bytearray(NUM_PIXELS * 4)
        for i in range(NUM_PIXELS):
            if random.random() < 0.15:
                continue                     # 保持全透明
            img[i * 4:i * 4 + 4] = palette[random.randrange(len(palette))]
        s2 = bytearray(save)
        inject_image(s2, bytes(img))
        back = extract_image(bytes(s2))
        rt = back == bytes(img)
        print("[%s] 注入→提取 往返一致: %s" % (tag, rt))
        if not rt:
            diff = sum(1 for x, y in zip(back, bytes(img)) if x != y)
            print("      不一致字节数 = %d" % diff)
            failures += 1

        # 4) 注入后校验仍自洽，且写校验是幂等的
        ok2, bad2 = verify_checksums(bytes(s2))
        print("[%s] 注入后校验: %s" % (tag, "OK" if ok2 else "FAIL %r" % (bad2,)))
        failures += 0 if ok2 else 1
        s3 = bytearray(s2)
        apply_checksums(s3)
        idem = bytes(s3) == bytes(s2)
        print("[%s] 写校验幂等: %s" % (tag, idem))
        failures += 0 if idem else 1

        # 5) 上游直译写的校验，必须能被独立判据 verify_checksums 接受
        s4 = bytearray(save)
        inject_image(s4, bytes(img))
        apply_checksums_upstream(s4)
        ok3, bad3 = verify_checksums(bytes(s4))
        print("[%s] 独立判据接受上游校验: %s" % (tag, "OK" if ok3 else "FAIL %r" % (bad3,)))
        failures += 0 if ok3 else 1

    # 6) 容器定位：子序列搜索 vs 连续搜索
    inner = make_blank_save(with_header=True)
    container = bytearray(b"\x00" * 0x120) + inner + bytearray(b"\xAB" * 0x40)
    off = find_offset(bytes(container))
    offc = find_offset_contiguous(bytes(container))
    print("[容器] 子序列定位 = 0x%X, 连续定位 = 0x%X, 一致 = %s"
          % (off, offc, off == offc))
    failures += 0 if off == offc else 1

    img = bytes([0x11, 0x22, 0x33, 0xFF]) * NUM_PIXELS
    inject_image(container, img)
    back = extract_image(bytes(container))
    print("[容器] 注入→提取 往返一致: %s" % (back == img))
    failures += 0 if back == img else 1

    ok4, bad4 = verify_checksums(bytes(container))
    print("[容器] 校验自洽: %s" % ("OK" if ok4 else "FAIL %r" % (bad4,)))
    failures += 0 if ok4 else 1

    print("\n%s（%d 项失败）" % ("全部通过" if failures == 0 else "存在失败", failures))
    return failures


if __name__ == "__main__":
    raise SystemExit(_selfcheck())
