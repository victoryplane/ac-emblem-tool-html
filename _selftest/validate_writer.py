# -*- coding: utf-8 -*-
r"""★ 新写入器的正确性判据。

最强的判据不是"我们能读回来"，而是：
  **把新写入器作用在游戏自己写的存档上，必须逐字节复原原文件。**
（因为游戏的产物按定义就是"游戏认可的字节"。）

再验证紧凑编码的产物在**两套末段写法**下都自洽，且尾部字节与游戏一致。
"""
from __future__ import annotations

import os
import sys

PROJ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(PROJ, "tools"))
import acet_format as af                                    # noqa: E402

REAL = os.path.join(PROJ, "testdata", "real")
FILES = ["BASLUS-20644E02_rawblock.raw", "BISLPS-25169E00.raw", "BISLPS-25169E01.raw",
         "BISLPS-25338E00.raw", "BISLPS-25338E01.raw", "BISLPS-25338E02.raw",
         "BISLPS-25338E03.raw", "BISLPS-25338E04.raw",
         "BISLPS-25462EMB_data0.raw", "BISLPS-25462EMB_data1.raw"]

fail = 0
print("=" * 96)
print("一、把新写入器作用在真实存档上 ⇒ 必须逐字节复原")
print("=" * 96)
for nm in FILES:
    p = os.path.join(REAL, nm)
    if not os.path.exists(p):
        continue
    orig = af.read_save_file(p)
    s = bytearray(orig)
    af.apply_checksums(s)
    same = bytes(s) == orig
    okC, badC = af.verify_checksums(orig)
    okA, _ = af.verify_checksums_upstream(orig)
    is_lr = af.is_lr_save(orig)
    tail = orig[af.FINAL_CHECK_POS[is_lr]:]
    print("%-30s 逐字节复原 %-5s | 真实写法 %-5s | 上游写法 %-5s | 尾部 %s"
          % (nm, "✅" if same else "❌", "✅" if okC else "❌ " + repr(badC[:1]),
             "✅" if okA else "❌", tail[:2].hex(' ')))
    if not (same and okC and okA):
        fail += 1
        if not same:
            d = [i for i in range(len(orig)) if orig[i] != s[i]]
            print("      差异 %d 字节，前几个：%s"
                  % (len(d), ["0x%04X %02X→%02X" % (i, orig[i], s[i]) for i in d[:8]]))

print("\n" + "=" * 96)
print("二、紧凑编码：自造的徽章在两套写法下都自洽，尾部与游戏一致")
print("=" * 96)
rose = af.read_save_file(os.path.join(REAL, "BASLUS-20644E02_rawblock.raw"))
mir = af.read_save_file(os.path.join(REAL, "BISLPS-25169E00.raw"))
img_rose = af.extract_image(rose, alpha_mode="index0")
img_mir = af.extract_image(mir, alpha_mode="index0")

for tag, img, tail_const, is_lr in (
        ("SL/NX 常量 + 玫瑰", img_rose, af.header_tail_from_save(mir), False),
):
    blk = af.encode_emblem(img, is_lr=is_lr, header_tail=tail_const)
    okC, badC = af.verify_checksums(bytes(blk))
    okA, badA = af.verify_checksums_upstream(bytes(blk))
    io = af.IMAGE_OFFSET
    n_used = len(af.used_palette_slots(bytes(blk)))
    nz = sum(1 for k in range(256)
             if any(blk[af.offset_index(io + af.NUM_PIXELS + k*4+ch, 0)] for ch in range(4)))
    alpha_set = sorted({blk[af.offset_index(io + af.NUM_PIXELS + k*4+3, 0)] for k in range(256)})
    print("%s" % tag)
    print("  长度 %d  引用槽 %d  非零调色板项 %d/256  alpha 取值 %s"
          % (len(blk), n_used, nz, ["0x%02X" % a for a in alpha_set]))
    print("  头部 0x14..0x1C = %s   （真实 = %s）"
          % (blk[0x14:0x1D].hex(' '), af.header_tail_from_save(mir).hex(' ')))
    print("  末段：0x4434(alpha)=%02X  0x4435(校验)=%02X  之后 10 字节 = %s"
          % (blk[0x4434], blk[0x4435], blk[0x4436:0x4440].hex(' ')))
    print("  真实写法 %s | 上游写法 %s" % ("✅" if okC else "❌ %r" % (badC,),
                                          "✅" if okA else "❌ %r" % (badA,)))
    print("  像素往返一致 %s" % (af.extract_image(bytes(blk), alpha_mode="index0") == img))
    if not (okC and okA):
        fail += 1

print("\n" + "=" * 96)
print("三、对比：旧写法（尾部留 0）在新判据下的表现")
print("=" * 96)
old = af.make_blank_save(is_lr=False, with_header=True, header_tail=af.header_tail_from_save(mir))
af.inject_image(old, img_rose)
old = bytearray(old)
old[0x4435:0x4440] = bytes(11)                    # 把尾巴清成 0（模拟"从空白块造"）
af.apply_checksums_upstream(old)                  # ★ 旧写法（上游）：只算末段校验，不管尾巴
okC, badC = af.verify_checksums(bytes(old))
okA, _ = af.verify_checksums_upstream(bytes(old))
print("  旧式（尾部全零 + 上游写法）: 真实写法 %s | 上游写法 %s"
      % ("✅" if okC else "❌ %s" % badC, "✅" if okA else "❌"))
print("  末段字节：0x4434=%02X 0x4435=%02X 之后 = %s"
      % (old[0x4434], old[0x4435], old[0x4436:0x4440].hex(' ')))
print("\n" + "=" * 96)
print("四、★ 从零造：块头里的作品字段必须与真实存档**逐字节一致**")
print("=" * 96)
print("  （非 LR 比 0x00..0x23；LR 比头 4 字节。对不上 ⇒ 游戏判破損、甚至直接卡死。）")
for nm in FILES:
    p = os.path.join(REAL, nm)
    if not os.path.exists(p):
        continue
    orig = af.read_save_file(p)
    is_lr = af.is_lr_save(orig)
    tail9 = None if is_lr else af.header_tail_from_save(orig)
    blk = af.encode_emblem(af.extract_image(orig, alpha_mode="index0"),
                           is_lr=is_lr, header_tail=tail9)
    n = len(af.LR_EMBLEM_HEADER) if is_lr else af.IMAGE_OFFSET
    same = bytes(blk[:n]) == orig[:n]
    print("  %-30s 头 %2d 字节一致 %-5s  真实=%s  我们=%s"
          % (nm, n, "✅" if same else "❌", orig[:n].hex(' ')[:23], bytes(blk[:n]).hex(' ')[:23]))
    if not same:
        fail += 1
        d = [i for i in range(n) if blk[i] != orig[i]]
        print("      差异偏移：%s" % ["0x%02X:%02X→%02X" % (i, orig[i], blk[i]) for i in d])

print("\n%s（%d 项失败）" % ("全部通过" if fail == 0 else "存在失败", fail))
raise SystemExit(1 if fail else 0)
