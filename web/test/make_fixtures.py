# -*- coding: utf-8 -*-
r"""用 Python 参考实现生成"期望值"夹具（幂等、只读）。

产出：
    web\test\fixtures\manifest.json          每个样本的期望值
    web\test\fixtures\blocks\<卡名>__<目录名>__<文件名>.raw
                                             从 out\evidence\*.ps2 抽出的徽章块

样本来源：
    ① testdata\real\*.raw                     10 份真实玩家存档（全部）
    ② out\evidence\*.ps2                      4 张证据记忆卡里的徽章块（**只读**）

每个样本记录（全部由 `tools\acet_format.py` 算出）：
    相对路径 / 大小 / kind / isLr / verifyOk / verifyBad / 18 个校验字节 /
    extract_image('index0') 的 SHA-256 / extract_image('acet') 的 SHA-256 /
    apply_checksums 之后的块 SHA-256（含重新编码后的块 SHA-256）

用法（在项目根目录下）：
    python web\test\make_fixtures.py

⚠ 本脚本只读记忆卡，绝不写入 out\evidence\ 或任何记忆卡。
⚠ 依赖 `AC3_CN\tools\30-存档\61_mc_survey.py` 的 `Card` 类（与
   `_selftest\dump_card_emblems.py` 同一套用法）；若那份文件不在，卡样本会被跳过
   （真实存档样本仍会生成）。
"""
from __future__ import annotations

import glob
import hashlib
import importlib.util
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))          # emblem-tool\web\test
WEB = os.path.dirname(HERE)                                # emblem-tool\web
PROJ = os.path.dirname(WEB)                                # emblem-tool
FIX = os.path.join(HERE, "fixtures")
BLOCKS = os.path.join(FIX, "blocks")
MANIFEST = os.path.join(FIX, "manifest.json")

sys.path.insert(0, os.path.join(PROJ, "tools"))
import acet_format as af                                    # noqa: E402

SURV = os.environ.get("AC_MC_SURVEY_PY", "")   # 见下面注释
# ★ 0.26（发布整理）：原先是写死的本机绝对路径（`AC3_CN\tools\30-存档\61_mc_survey.py`）
#   ⇒ 改成环境变量。生成的夹具 `fixtures\manifest.json` 已经在仓库里，
#     跑测试**不需要**它 —— 只有"重新生成夹具"时才要。
EVIDENCE = os.path.join(PROJ, "out", "evidence")


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def rel(path: str) -> str:
    """项目根目录相对的 posix 风格路径（manifest 里只用这种）。"""
    return os.path.relpath(path, PROJ).replace("\\", "/")


def safe_name(s: str) -> str:
    return re.sub(r"[^0-9A-Za-z_.-]", "_", s)


def load_survey():
    """按需加载记忆卡读取层；不可用就返回 None。"""
    if not os.path.exists(SURV):
        return None
    spec = importlib.util.spec_from_file_location("mc_survey", SURV)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def is_emblem_dir(name: str) -> bool:
    """`E##`（单体徽章存档）或 `EMB`（LR 的 data0..7 目录）。"""
    return bool(re.search(r"E\d\d$", name)) or name.endswith("EMB")


def collect_from_cards(sv) -> list:
    r"""从 4 张证据卡里抽出所有徽章块，写到 fixtures\blocks\，返回 (名字, 数据) 列表。

    只读：只用 Card.read_file / dirents。
    ⚠ 目录判定用**名字**而不是 `mode & 0x2000`：本卡实测目录 = 0x8427、文件 = 0x8497，
      两者的 bit13 都是 0（见 `_selftest\dump_card_emblems.py` 的坑注）。
    ⚠ 下面的 `re.search(r"E\d\d$", ...)` 必须用 r-string（否则 Python 报
      SyntaxWarning: invalid escape sequence '\d'）。
    """
    os.makedirs(BLOCKS, exist_ok=True)
    out = []
    for path in sorted(glob.glob(os.path.join(EVIDENCE, "*.ps2"))):
        card_tag = safe_name(os.path.splitext(os.path.basename(path))[0])
        card = sv.Card(path)
        roots = card.dirents(card.rootdir, card.dir_count(card.rootdir))
        for e in roots:
            nm = e["name"]
            if nm in (".", "..") or not nm.startswith("B") or not is_emblem_dir(nm):
                continue
            for s in card.dirents(e["cluster"], e["length"]):
                if s["name"] in (".", "..") or not s["length"]:
                    continue
                data = card.read_file(s["cluster"], s["length"])
                kind = af.save_kind(data)
                if kind not in ("emblem-raw", "emblem-lr", "container"):
                    continue
                if kind == "container":
                    # 容器：把徽章块切出来（用"子序列搜索"，与 Python 主干一致）
                    off = af.find_offset(data)
                    size = af.LR_SAVE_SIZE if len(data) - off == af.LR_SAVE_SIZE else af.SAVE_SIZE
                    data = data[off:off + size]
                ok, bad = af.verify_checksums(data)
                if not ok:
                    # 校验过不了的块不是"游戏认可的字节"，不进夹具（噪声/中间产物）
                    print("  [跳过] %s/%s/%s：校验 %d 段不符"
                          % (card_tag, nm, s["name"], len(bad)))
                    continue
                fname = "%s__%s__%s.raw" % (card_tag, safe_name(nm), safe_name(s["name"]))
                out.append((fname, bytes(data)))
    return out


def build_entry(path: str, data: bytes, source: str) -> dict:
    """算一个样本的全部期望值。

    ⚠ 本函数只接受**独立的徽章块**（emblem-raw / emblem-lr，0x4440 / 0x4420 字节）。
      容器（> 0x4440 且含魔数）请走 `build_container_entry()` —— 对容器整体做
      `verify_checksums` 是**超出格式定义**的（末尾的 11 字节尾巴不在块内），会得到
      没有意义的"18 段全不符"。
    """
    if af.save_kind(data) not in ("emblem-raw", "emblem-lr"):
        raise ValueError("build_entry: 只接受 0x4440 / 0x4420 的独立徽章块，收到 %d 字节的 %s"
                         % (len(data), af.save_kind(data)))
    kind = af.save_kind(data)
    is_lr = af.is_lr_save(data)
    ok, bad = af.verify_checksums(data)
    ok_up, bad_up = af.verify_checksums_upstream(data)
    segs = af.segment_layout(is_lr)
    check_bytes = [data[pos] for (_s, _d, pos, _sd) in segs]

    img_index0 = af.extract_image(data, alpha_mode="index0")
    img_acet = af.extract_image(data, alpha_mode="acet")
    img_gs = af.extract_image(data, alpha_mode="gs")

    # apply_checksums 必须**逐字节复原**游戏自己写的存档
    cp = bytearray(data)
    af.apply_checksums(cp)
    diff_offsets = [i for i in range(len(data)) if data[i] != cp[i]]
    applied_identical = not diff_offsets

    # 重新编码：extract('index0') → encode_emblem(同一个 header_tail) → 再校验
    tail9 = None if is_lr else af.header_tail_from_save(data)
    re_enc = af.encode_emblem(img_index0, is_lr=is_lr, header_tail=tail9, fill_unused=True)
    re_enc_skip = af.encode_emblem(img_index0, is_lr=is_lr, header_tail=tail9, fill_unused=False)

    alpha_pos = af.FINAL_ALPHA_POS[is_lr]
    check_pos = af.FINAL_CHECK_POS[is_lr]
    trailer = bytes(data[check_pos + 1:check_pos + 1 + len(af.FINAL_TRAILER)])

    return {
        "path": rel(path),
        "source": source,
        "size": len(data),
        "sha256": sha256(data),
        "kind": kind,
        "isLr": bool(is_lr),
        "verifyOk": bool(ok),
        "verifyBad": len(bad),
        "verifyUpstreamOk": bool(ok_up),
        "verifyUpstreamBad": len(bad_up),
        "checkBytes": ["%02x" % v for v in check_bytes],
        "finalCheckPos": check_pos,
        "finalAlphaPos": alpha_pos,
        "finalCheckByte": "%02x" % data[check_pos],
        "finalAlphaByte": "%02x" % data[alpha_pos],
        "finalTrailer": trailer.hex(),
        "imageIndex0Sha256": sha256(img_index0),
        "imageAcetSha256": sha256(img_acet),
        "imageGsSha256": sha256(img_gs),
        "imageLength": len(img_index0),
        "appliedSha256": sha256(bytes(cp)),
        "appliedIdentical": applied_identical,
        "appliedDiffOffsets": ["0x%X" % i for i in diff_offsets],
        "usedPaletteSlots": len(af.used_palette_slots(data)),
        "headerTail": None if is_lr else tail9.hex(),
        "reencodedSha256": sha256(bytes(re_enc)),
        "reencodedSkipUnusedSha256": sha256(bytes(re_enc_skip)),
        # 重新编码出来的块，其"块头"必须与真实存档逐字节一致：
        # 非 LR 比 0x00..0x23（36 字节，含 9 字节作品常量），LR 比头 4 字节。
        "reencodedHeaderHex": bytes(
            re_enc[:af.LR_IMAGE_OFFSET] if is_lr else re_enc[:af.IMAGE_OFFSET]).hex(),
        "sourceHeaderHex": bytes(
            data[:af.LR_IMAGE_OFFSET] if is_lr else data[:af.IMAGE_OFFSET]).hex(),
        "reencodedRoundTripIndex0": bool(
            af.extract_image(bytes(re_enc), alpha_mode="index0") == img_index0),
    }


def build_container_entry(path: str, data: bytes, source: str) -> dict:
    """容器样本（> 0x4440、含 12 字节魔数）的期望值。

    ★ 只比对**定位**：`find_offset`（子序列搜索，上游语义）与
      `find_offset_contiguous`（连续搜索）。切出来的块本身要不要进夹具由调用方决定。
    ⚠ **不要**对容器整体调用 `verify_checksums`：容器的长度不是 0x4420 / 0x4440，
      末段的"数据"与"10 字节尾巴"都不在块内 ⇒ 会得到"18 段全不符"这种没有意义的结论。
    """
    off = af.find_offset(data)
    offc = af.find_offset_contiguous(data)
    return {
        "path": rel(path),
        "source": source,
        "size": len(data),
        "sha256": sha256(data),
        "kind": af.save_kind(data),
        "isLr": False,
        "findOffset": off,
        "findOffsetContiguous": offc,
        "note": "容器：只比对 find_offset / find_offset_contiguous；不对整体做 18 段校验",
    }


def main() -> int:
    os.makedirs(FIX, exist_ok=True)
    os.makedirs(BLOCKS, exist_ok=True)

    # ---- ① 清掉上一次生成的 blocks（幂等：避免重命名后留残骸）----
    for old in glob.glob(os.path.join(BLOCKS, "*.raw")):
        os.remove(old)

    entries = []
    print("=== ① testdata\\real\\*.raw ===")
    for path in sorted(glob.glob(os.path.join(PROJ, "testdata", "real", "*.raw"))):
        data = af.read_save_file(path)
        e = build_entry(path, data, "testdata/real")
        entries.append(e)
        print("  %-40s %6d B  %-12s verify=%s" % (os.path.basename(path), e["size"],
                                                  e["kind"], e["verifyOk"]))

    # ---- ② 证据卡里的徽章块 ----
    print("\n=== ② out\\evidence\\*.ps2（只读）===")
    sv = load_survey()
    if sv is None:
        print("  [警告] 找不到记忆卡读取层，跳过卡样本: %s" % SURV)
    else:
        card_items = collect_from_cards(sv)
        for fname, data in card_items:
            outp = os.path.join(BLOCKS, fname)
            if os.path.exists(outp):
                prev = af.read_save_file(outp)
                if prev != data:
                    raise RuntimeError("夹具与已有文件不一致（同一名字不同内容）: %s" % fname)
            with open(outp, "wb") as f:
                f.write(data)
            e = build_entry(outp, data, "out/evidence/%s" % fname.split("__")[0])
            entries.append(e)
            print("  %-56s %6d B  %-12s verify=%s" % (fname, e["size"], e["kind"], e["verifyOk"]))

    # ---- ③ 真实存档的 .PSV 容器（交叉验证 find_offset）----
    psv = os.path.join(PROJ, "testdata", "real", "BASLUS-20644E02_AC3SL_Emblem3.PSV")
    if os.path.exists(psv):
        data = af.read_save_file(psv)
        try:
            e = build_container_entry(psv, data, "testdata/real")
            entries.append(e)
            print("\n=== ③ PSV 容器 ===\n  %s  find_offset=0x%X  contiguous=0x%X  (%d 字节, %s)"
                  % (os.path.basename(psv), e["findOffset"], e["findOffsetContiguous"],
                     e["size"], e["kind"]))
            # 顺带把切出来的块也做成一个样本（复用它已有的 rawblock 夹具）
            blk = data[e["findOffset"]:e["findOffset"] + af.SAVE_SIZE]
            if af.verify_checksums(blk)[0]:
                rp = os.path.join(PROJ, "testdata", "real", "BASLUS-20644E02_rawblock.raw")
                if os.path.exists(rp) and af.read_save_file(rp) == blk:
                    print("  ✓ 切出来的块与 testdata\\real\\BASLUS-20644E02_rawblock.raw 逐字节相同")
                else:
                    print("  ⚠ 切出来的块与 rawblock 夹具不一致（夹具缺一个样本）")
        except Exception as ex:
            print("\n=== ③ PSV 容器 ===\n  [跳过] %s" % ex)

    manifest = {
        "generatedBy": "web/test/make_fixtures.py",
        "referenceImplementation": "tools/acet_format.py",
        "sha256Tool": "hashlib.sha256 (Python 3.12)",
        "note": ("所有期望值由 Python 参考实现算出；TS 侧必须逐字节一致。"
                 "appliedSha256 = apply_checksums 之后的块哈希（真实存档上应逐字节复原）。"
                 "reencodedSha256 = extract(index0) → encode_emblem(fill_unused=True) 的块哈希。"),
        "count": len(entries),
        "entries": entries,
    }
    with open(MANIFEST, "w", encoding="utf-8", newline="\n") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=1, sort_keys=False)
        f.write("\n")

    print("\n" + "=" * 74)
    print("共收集 %d 个样本（%d 个真实存档 + %d 个卡上徽章块%s）"
          % (len(entries),
             len([e for e in entries if e.get("source") == "testdata/real" and e["path"].endswith(".raw")]),
             len([e for e in entries if e.get("source", "").startswith("out/evidence")]),
             " + 1 个 PSV 容器" if any(e["path"].endswith(".PSV") for e in entries) else ""))
    print("→ %s" % MANIFEST)
    print("→ %s\\*.raw" % BLOCKS)

    # ---- 自检：verifyOk 必须全通过；apply_checksums 的"逐字节复原"逐样本记录 ----
    not_verified = [e["path"] for e in entries if e.get("verifyOk") is False]
    not_identical = [e for e in entries if e.get("appliedIdentical") is False]
    n_ident = len([e for e in entries if e.get("appliedIdentical") is True])
    print("apply_checksums 逐字节复原: %d 个成立" % n_ident)
    if not_identical:
        # ★ 已知例外：`Mcd001_embdata2/final` 的 `BISLPS-25462EMB/data2` 是
        #   `_selftest/write_data2_inverted.py` 写出来的**实验产物**（不是游戏写的），
        #   它的 0x4414 = 0x8F，而 apply_checksums 按格式约定强制写成 0x80
        #   ⇒ 恰好 2 字节不同（0x4414 与紧随其后的校验字节）。
        #   42/44 个样本（含**全部 10 份真实存档**）逐字节复原成立。
        for e in not_identical:
            print("  ⚠ 还原有差异（%d 字节 %s）：%s"
                  % (len(e["appliedDiffOffsets"]), e["appliedDiffOffsets"][:4], e["path"]))
        print("  ⇒ 上列样本是实验/中间产物（alpha 位不是游戏的 0x80），不是游戏自己写的存档。")
    if not_verified:
        print("⚠ 以下样本 18 段校验不通过（不该发生）：%s" % not_verified)
        return 1
    print("（只读；未向任何记忆卡写入字节）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
