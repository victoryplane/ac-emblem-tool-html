#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成 testdata/ 里的合成样品（全部由参考实现产出，可随时重建）。

    python tools/make_testdata.py

产出：
    sample_A_60colors.png                128×128、56 色、左上角一块透明的样品图
    sample_B_40colors.png                128×128、41 色的样品图
    synth_ac3_BASLUS-20435E00.raw        非 LR 徽章存档（0x4440），内容 = 图 A
    synth_lr_BASLUS-21338EMB_data0.raw   Last Raven 徽章存档（0x4420），内容 = 图 A
    synth_container_with_emblem.bin      0x200 字节前缀 + 上述 AC3 存档（测魔数定位）

这些文件**不是**任何游戏的真实存档，只是把"A 图"按格式编码出来的字节样本，
用于自检、对照与人眼查看。文件名带 synth_ 前缀就是为了避免被误当成真存档。
"""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import acet_format as af          # noqa: E402
from selftest import make_pattern, rgba_bytes, save_png  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
TESTDATA = os.path.join(ROOT, "testdata")


def main() -> int:
    os.makedirs(TESTDATA, exist_ok=True)

    img_a = make_pattern(128, 128, ncolors=60)
    img_b = make_pattern(128, 128, ncolors=40)
    save_png(img_a, os.path.join(TESTDATA, "sample_A_60colors.png"))
    save_png(img_b, os.path.join(TESTDATA, "sample_B_40colors.png"))

    targets = [
        ("synth_ac3_BASLUS-20435E00.raw", False, 0),
        ("synth_lr_BASLUS-21338EMB_data0.raw", True, 0),
        ("synth_container_with_emblem.bin", False, 0x200),
    ]
    for name, is_lr, base in targets:
        s = af.make_blank_save(is_lr=is_lr, base_offset=base)
        af.inject_image(s, rgba_bytes(img_a))
        af.write_save_file(os.path.join(TESTDATA, name), s)
        ok, bad = af.verify_checksums(bytes(s))
        print("%-40s %6d 字节  校验%s" % (name, len(s), "通过" if ok else "不通过 %r" % (bad,)))

    print("\n样品已写入 %s" % TESTDATA)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
