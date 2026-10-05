#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""acet 参考实现 ↔ 官方二进制 的交叉验证。

思路：拿本目录 `dist/` 里**官方发布的 acet.exe**当"权威实现"，让两套实现互相读写同一批
存档，逐像素比对。任何一方理解错了格式，比对就会炸。

四个方向都要过：
  A. 本实现写存档 → 官方读出来      （证明本实现写出的字节符合官方格式）
  B. 官 方写存档 → 本实现读出来      （证明本实现能读懂官方产物）
  C. 本实现写 → 官方读 → 官方再写 → 本实现读（两轮往返）
  D. 官方写 → 本实现写 → 官方读      （交替改写，最能暴露"隐式状态"）

覆盖三种载体：AC3 原始存档 (0x4440)、LR 原始存档 (0x4420)、带前缀的容器（走魔数搜索）。

用法：
    python tools/selftest.py                 # 跑全部，打印报告
    python tools/selftest.py --exe <path>    # 指定官方 exe（默认 dist/v1.0.2/acet.exe）
    python tools/selftest.py --keep          # 保留中间产物（默认保留，便于人工复核）
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import acet_format as af  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
TESTDATA = os.path.join(ROOT, "testdata")
WORK = os.path.join(ROOT, "testdata", "_work")

DEFAULT_EXE = os.path.join(ROOT, "dist", "v1.0.2", "acet.exe")

RESULTS: list[tuple[str, bool, str]] = []


def record(name: str, ok: bool, detail: str = "") -> None:
    RESULTS.append((name, ok, detail))
    print("  %s %s%s" % ("PASS" if ok else "FAIL", name,
                         ("  — " + detail) if detail else ""))


# --------------------------------------------------------------------------
# 图像工具（用 Pillow，仅测试脚本依赖）
# --------------------------------------------------------------------------
def make_pattern(w: int, h: int, ncolors: int = 60, transparent: bool = True):
    """造一张 ≤ncolors 色的 RGBA 图，带一块全透明区域。返回 PIL.Image。"""
    from PIL import Image

    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    px = img.load()
    pal = []
    step = max(1, 256 // max(1, int(ncolors ** (1 / 3.0))))
    for r in range(0, 256, step):
        for g in range(0, 256, step):
            for b in range(0, 256, step):
                pal.append((r, g, b))
                if len(pal) >= ncolors:
                    break
            if len(pal) >= ncolors:
                break
        if len(pal) >= ncolors:
            break
    for y in range(h):
        for x in range(w):
            # 左上角一块透明；其余棋盘 + 渐变，保证颜色数受控
            if transparent and x < w // 4 and y < h // 4:
                continue
            idx = (x // 4 + y // 4) % len(pal)
            r, g, b = pal[idx]
            px[x, y] = (r, g, b, 255)
    return img


def rgba_bytes(img) -> bytes:
    return img.convert("RGBA").tobytes()


def load_rgba(path: str, w: int, h: int) -> bytes:
    from PIL import Image
    im = Image.open(path).convert("RGBA")
    if im.size != (w, h):
        raise ValueError("尺寸不是 %dx%d：%s" % (w, h, path))
    return im.tobytes()


def save_png(img, path: str) -> None:
    img.save(path, "PNG")


def normalize_alpha(data: bytes) -> bytes:
    """acet 只有"有/无"透明度：alpha != 0xFF 都会变成 0。把期望值同样归一下。"""
    out = bytearray(data)
    for i in range(3, len(out), 4):
        out[i] = 0xFF if out[i] == 0xFF else 0x00
    return bytes(out)


# --------------------------------------------------------------------------
# 跑官方 exe
# --------------------------------------------------------------------------
def run_official(exe: str, args: list[str]) -> tuple[int, str]:
    """跑官方 CLI。注意：出错时它会 `cin.get()` 等回车 ⇒ stdin 必须接 DEVNULL。"""
    p = subprocess.run([exe] + args, stdin=subprocess.DEVNULL,
                       stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                       timeout=120)
    return p.returncode, p.stdout.decode("utf-8", "replace")


def official_extract(exe: str, save: str) -> str:
    """官方提取：产出 <save>.png，返回其路径。"""
    if os.path.exists(save + ".png"):
        os.remove(save + ".png")
    rc, out = run_official(exe, [save])
    if rc != 0 or not os.path.exists(save + ".png"):
        raise RuntimeError("官方提取失败 rc=%d out=%r" % (rc, out[:400]))
    return save + ".png"


def official_inject(exe: str, save: str, png: str) -> None:
    rc, out = run_official(exe, [save, png])
    if rc != 0:
        raise RuntimeError("官方注入失败 rc=%d out=%r" % (rc, out[:400]))


# --------------------------------------------------------------------------
# 三种载体
# --------------------------------------------------------------------------
def case_ac3():
    return dict(tag="AC3", is_lr=False, w=128, h=128,
                save="BASLUS-20435E00.raw", base=0)


def case_lr():
    return dict(tag="LR", is_lr=False, w=128, h=128,
                save="BASLUS-21338EMB_data0.raw", base=0, lr=True)


def case_container():
    return dict(tag="容器", is_lr=False, w=128, h=128,
                save="container_with_emblem.bin", base=0x200)


def build_save(spec, image_rgba: bytes) -> bytearray:
    is_lr = spec.get("lr", False)
    s = af.make_blank_save(is_lr=is_lr, base_offset=spec["base"])
    af.inject_image(s, image_rgba)
    return s


def run_case(exe: str, spec, img_a, img_b) -> None:
    tag = spec["tag"]
    w, h = spec["w"], spec["h"]
    print("\n=== [%s] %s ===" % (tag, spec["save"]))
    d = os.path.join(WORK, tag)
    os.makedirs(d, exist_ok=True)

    png_a = os.path.join(d, "A.png")
    png_b = os.path.join(d, "B.png")
    save_png(img_a, png_a)
    save_png(img_b, png_b)
    a_bytes = rgba_bytes(img_a)
    b_bytes = normalize_alpha(rgba_bytes(img_b))

    # --- 本实现写存档 ---
    s_mine = build_save(spec, rgba_bytes(img_a))
    mine_path = os.path.join(d, spec["save"])
    af.write_save_file(mine_path, s_mine)

    # 本实现自洽：校验字节必须独立通过
    ok, bad = af.verify_checksums(bytes(s_mine))
    record("%s 本实现写出的存档校验自洽" % tag, ok, "" if ok else repr(bad[:3]))

    # 本实现自读
    record("%s 本实现 自读自写 往返一致" % tag,
           af.extract_image(bytes(s_mine)) == rgba_bytes(img_a))

    # --- A. 本实现写 → 官方读 ---
    try:
        p = official_extract(exe, mine_path)
        got = load_rgba(p, w, h)
        record("%s [A] 本实现写 → 官方读 逐像素一致" % tag,
               got == rgba_bytes(img_a),
               "" if got == rgba_bytes(img_a)
               else "%d/%d 字节不同" % (sum(1 for x, y in zip(got, rgba_bytes(img_a)) if x != y),
                                      len(got)))
    except Exception as e:
        record("%s [A] 本实现写 → 官方读" % tag, False, str(e))

    # --- B. 官方写 → 本实现读 ---
    b_path = os.path.join(d, "official_" + spec["save"])
    shutil.copyfile(mine_path, b_path)
    try:
        official_inject(exe, b_path, png_b)
        got = af.extract_image(af.read_save_file(b_path))
        record("%s [B] 官方写 → 本实现读 逐像素一致" % tag,
               got == b_bytes,
               "" if got == b_bytes
               else "%d/%d 字节不同" % (sum(1 for x, y in zip(got, b_bytes) if x != y), len(got)))
        ok, bad = af.verify_checksums(af.read_save_file(b_path))
        record("%s [B] 官方写出的存档校验自洽" % tag, ok, "" if ok else repr(bad[:3]))
    except Exception as e:
        record("%s [B] 官方写 → 本实现读" % tag, False, str(e))

    # --- C. 本实现写 → 官方读 → 官方写 → 本实现读 ---
    try:
        c_path = os.path.join(d, "roundtrip_" + spec["save"])
        shutil.copyfile(mine_path, c_path)
        official_extract(exe, c_path)                 # 官方读一遍
        official_inject(exe, c_path, png_b)           # 官方再写
        got = af.extract_image(af.read_save_file(c_path))
        record("%s [C] 写→读→写→读 交替往返一致" % tag, got == b_bytes)
    except Exception as e:
        record("%s [C] 交替往返" % tag, False, str(e))

    # --- D. 官方产物 → 本实现改写 → 官方读 ---
    try:
        d_path = os.path.join(d, "alt_" + spec["save"])
        shutil.copyfile(mine_path, d_path)
        official_inject(exe, d_path, png_b)           # 先让官方写
        s2 = bytearray(af.read_save_file(d_path))
        af.inject_image(s2, rgba_bytes(img_a))        # 本实现覆盖
        af.write_save_file(d_path, s2)
        p = official_extract(exe, d_path)
        got = load_rgba(p, w, h)
        record("%s [D] 官方→本实现→官方 逐像素一致" % tag, got == rgba_bytes(img_a))
    except Exception as e:
        record("%s [D] 官方→本实现→官方" % tag, False, str(e))

    # 存档大小不应被任何一方改变
    try:
        n1 = os.path.getsize(mine_path)
        n2 = os.path.getsize(b_path)
        record("%s 存档大小不被改写" % tag, n1 == n2,
               "%d vs %d" % (n1, n2))
    except Exception as e:
        record("%s 存档大小" % tag, False, str(e))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--exe", default=DEFAULT_EXE)
    ap.add_argument("--keep", action="store_true", default=True)
    args = ap.parse_args()

    exe = args.exe
    print("官方二进制：%s" % exe)
    if not os.path.exists(exe):
        print("找不到官方 exe，无法交叉验证。")
        return 2
    print("大小 %d 字节" % os.path.getsize(exe))

    os.makedirs(TESTDATA, exist_ok=True)
    if os.path.isdir(WORK):
        shutil.rmtree(WORK)
    os.makedirs(WORK, exist_ok=True)

    img_a = make_pattern(128, 128, ncolors=60)
    img_b = make_pattern(128, 128, ncolors=40)
    print("测试图：A = %d 色，B = %d 色" % (len(img_a.getcolors(1 << 16) or []),
                                          len(img_b.getcolors(1 << 16) or [])))

    # 基础自检（纯本实现）
    print("\n=== [基础] 本实现内部一致性 ===")
    r = subprocess.run([sys.executable, os.path.join(HERE, "acet_format.py")],
                       stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    record("acet_format.py 自检全通过", r.returncode == 0,
           r.stdout.decode("utf-8", "replace").strip().splitlines()[-1])

    for spec in (case_ac3(), case_lr(), case_container()):
        run_case(exe, spec, img_a, img_b)

    # 把 A/B 图留在 testdata 里当样品
    save_png(img_a, os.path.join(TESTDATA, "sample_A_60colors.png"))
    save_png(img_b, os.path.join(TESTDATA, "sample_B_40colors.png"))

    total = len(RESULTS)
    bad = [r for r in RESULTS if not r[1]]
    print("\n" + "=" * 66)
    print("总计 %d 项，通过 %d，失败 %d" % (total, total - len(bad), len(bad)))
    for name, _, detail in bad:
        print("  FAIL %s  %s" % (name, detail))
    print("=" * 66)
    return 1 if bad else 0


if __name__ == "__main__":
    raise SystemExit(main())
