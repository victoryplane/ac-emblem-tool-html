# -*- coding: utf-8 -*-
r"""生成 TS 记忆卡层的**期望值夹具**（`web\test\fixtures\card-manifest.json`）。

用法（在项目根目录 `emblem-tool\` 下执行）：
    python web\test\make_card_fixtures.py

产出两大部分：

一、**只读普查**（对 `out\evidence\*.ps2` 四张卡，全程只读，绝不写入）
    · 每张卡：整卡 SHA-256、超块字段、根目录条目（index/mode/length/cluster/name）
    · 每张卡：徽章存档清单（目录名 / 文件名 / 长度 / 簇号 / 内容 SHA-256）
    · 几个固定的 ECC 参考值（页字节 ⇒ 16 B 备用区）

二、**一次写入实验的预期结果**（在**系统临时目录**里的副本上做）
    · 源卡：`out\evidence\Mcd001_embdata2.ps2`
    · 动作：在 `BISLPS-25462EMB` 目录里新建 `data7`，内容 = `bytes(range(256))` 重复到 17,440 B
    · 记录：写入前后**发生变化的页号集合**、每页 512 B 的 SHA-256、写入后整卡 SHA-256

写入链路**逐行对齐两份已验证的 Python 参考实现**：
    · `AC3_CN\tools\30-存档\61_mc_survey.py::Card`（只读结构）
    · `AC3_CN\tools\30-存档\65_us2jp.py::Writable`（写页 + 重算 ECC + 改 FAT）
    · `_selftest\write_data2_inverted.py`（"新建一个文件槽"的 5 步，实机通过）
唯一的结构性差异：本脚本把整卡读进 `bytearray` 内存镜像后只在镜像上读写
（= 参考实现里"读-改-写必须走同一个句柄"那条坑的**结构性解法**），
所以**没有任何跨句柄回退的可能**，且过程完全确定性、可重复运行。

本脚本幂等：临时文件写在系统临时目录、结束时删除；除 `fixtures\card-manifest.json`
外不在项目里留任何东西。`out\evidence` 全程**只读**（末尾会用 SHA-256 自证）。
"""
from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import shutil
import struct
import sys
import tempfile

# ─────────────────────────── 路径 ───────────────────────────

HERE = os.path.dirname(os.path.abspath(__file__))          # emblem-tool\web\test
WEB = os.path.dirname(HERE)                                 # emblem-tool\web
PROJ = os.path.dirname(WEB)                                 # emblem-tool
EVIDENCE = os.path.join(PROJ, 'out', 'evidence')
FIXTURES = os.path.join(HERE, 'fixtures')
OUT_JSON = os.path.join(FIXTURES, 'card-manifest.json')

SURVEY_PY = os.environ.get('AC_MC_SURVEY_PY', '')   # 见下面注释
MC_PY = os.environ.get('AC_MC_PY', '')
# ★ 0.26（发布整理）：上面两个是**本工作区的记忆卡工具**（`AC3_CN\tools\30-存档\` 里的
#   `61_mc_survey.py` / `60_mc.py`），原先是写死的本机绝对路径 —— 那既泄漏本地目录结构，
#   在别人机器上也必然不对。现在改成读环境变量：
#
#       set AC_MC_SURVEY_PY=D:\你的\61_mc_survey.py
#       set AC_MC_PY=D:\你的\60_mc.py
#
#   （只影响这个**夹具生成器**；生成的夹具 `fixtures\card-manifest.json` 已经在仓库里，
#     跑测试不需要它 —— 只有"重新生成夹具"时才要这两个脚本。）

PAGE, ECC, STRIDE = 512, 16, 528
MASK = 0x7FFFFFFF
LAST = 0x7FFFFFFF
FAT_END = (0x80000000 | LAST) & 0xFFFFFFFF

# 写入实验参数
WRITE_DIR_EMB = 'BISLPS-25462EMB'   # 链 4 簇 = 8 槽，声明 8 项 ⇒ 全满
WRITE_DIR_GAME = 'BISLPS-25462GAME'  # 链 5 簇 = 10 槽，声明 9 项 ⇒ 第 10 槽是空槽
#
# 两个实验，正好覆盖"目录还有空槽"与"目录已满须扩簇"两条路径：
#   ① GAME 复用空槽：真卡实测 cl=737 / k=1 / 绝对页 1557，整页 FF 且备用区 = page_ecc(FF页)
#   ② EMB 扩目录簇：全满，必须扩 1 簇
WRITE_LEN = 17440
WRITE_DATA = (bytes(range(256)) * ((WRITE_LEN + 255) // 256))[:WRITE_LEN]
assert len(WRITE_DATA) == WRITE_LEN

EXPERIMENTS = [
    dict(label='reuse-free-slot',
         sourceCard='Mcd001_embdata2.ps2',
         dir=WRITE_DIR_GAME,
         file='data4',
         expectExtension=False,
         note='目录链内已有空槽 ⇒ 复用该槽，不扩簇'),
    dict(label='extend-directory',
         sourceCard='Mcd001_embdata2.ps2',
         dir=WRITE_DIR_EMB,
         file='data7',
         expectExtension=True,
         note='目录链全满 ⇒ 扩 1 簇，且新簇两页都初始化为「整页 FF 空 dirent + 正确 ECC」'),
]


def load_mod(name: str, path: str):
    spec = importlib.util.spec_from_file_location(name, path)
    m = importlib.util.module_from_spec(spec)
    sys.modules[name] = m
    spec.loader.exec_module(m)
    return m


def sha(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


# `60_mc.py`：ECC 原语（`page_ecc`）+ 整卡读取。本脚本只借它算 ECC 参考值。
MC = load_mod('mc', MC_PY)


# ─────────────────── 只读层（逐行对齐 61_mc_survey.py::Card） ───────────────────

class ReadCard:
    """`61_mc_survey.py::Card` 的内存镜像版（只读部分逐行对齐）。"""

    def __init__(self, buf: bytes, path: str = '<memory>'):
        self.buf = bytearray(buf)
        self.path = path
        self.size = len(self.buf)
        assert self.size % STRIDE == 0, '大小不是 528 的整数倍'
        self.npages = self.size // STRIDE
        sb = self._page(0)
        if sb[:4] != b'Sony':
            raise ValueError('不是 PS2 记忆卡（超块魔数不符）: %r' % sb[:4])
        self.page_len = struct.unpack_from('<H', sb, 0x28)[0]
        self.ppc = struct.unpack_from('<H', sb, 0x2A)[0]
        self.ppb = struct.unpack_from('<H', sb, 0x2C)[0]
        self.clusters = struct.unpack_from('<I', sb, 0x30)[0]
        self.aoff = struct.unpack_from('<I', sb, 0x34)[0]
        self.aend = struct.unpack_from('<I', sb, 0x38)[0]
        self.rootdir = struct.unpack_from('<I', sb, 0x3C)[0]
        self.ifc = [struct.unpack_from('<I', sb, 0x50 + i * 4)[0] for i in range(32)]
        ind = self.sys_read(self.ifc[0], 1024)
        self.ind = [struct.unpack_from('<I', ind, i * 4)[0] for i in range(256)]

    # ---- 页 ----
    def _page(self, n: int) -> bytes:
        return bytes(self.buf[n * STRIDE:n * STRIDE + PAGE])

    def _spare(self, n: int) -> bytes:
        return bytes(self.buf[n * STRIDE + PAGE:n * STRIDE + STRIDE])

    # ---- 系统区（绝对簇） ----
    def sys_page(self, cl: int, k: int = 0) -> int:
        return cl * self.ppc + k

    def sys_read(self, cl: int, n: int) -> bytes:
        out = bytearray()
        i = 0
        while len(out) < n and i < 512:
            for k in range(self.ppc):
                p = self.sys_page(cl, k)
                if p >= self.npages:
                    return bytes(out)
                out += self._page(p)
            cl += 1
            i += 1
        return bytes(out[:n])

    # ---- 数据区（相对） ----
    def data_page(self, rel: int, k: int = 0) -> int:
        return (rel + self.aoff) * self.ppc + k

    def read_data_page(self, rel: int, k: int = 0) -> bytes:
        return self._page(self.data_page(rel, k))

    def fat(self, rel: int) -> int:
        if rel >= self.clusters:
            return 0xFFFFFFFF
        blk, off = rel // 256, (rel % 256) * 4
        fc = self.ind[blk]
        if fc == 0xFFFFFFFF:
            return 0xFFFFFFFF
        return struct.unpack_from('<I', self.sys_read(fc, 1024), off)[0]

    def chain(self, first: int, maxn: int = 8192):
        out, cl = [], first
        while cl not in (LAST, 0xFFFFFFFF) and cl < self.clusters and len(out) < maxn:
            out.append(cl)
            nxt = self.fat(cl) & MASK
            if nxt in out:
                break
            cl = nxt
        return out

    def read_file(self, first: int, n: int) -> bytes:
        if n <= 0:
            return b''
        out = bytearray()
        for cl in self.chain(first, n // 1024 + 16):
            for k in range(self.ppc):
                out += self._page(self.data_page(cl, k))
            if len(out) >= n:
                break
        return bytes(out[:n])

    # ---- 目录 ----
    def dirents(self, first: int, count: int):
        out = []
        need = count * PAGE
        raw = bytearray()
        for cl in self.chain(first, need // 1024 + 16):
            for k in range(self.ppc):
                raw += self._page(self.data_page(cl, k))
            if len(raw) >= need:
                break
        for i in range(count):
            e = bytes(raw[i * PAGE:i * PAGE + PAGE])
            if len(e) < PAGE:
                break
            mode, length = struct.unpack_from('<II', e, 0)
            if mode == 0xFFFFFFFF:
                continue
            # ★ "已用" = bit15（0x8000），不是 bit31；括号不能省（Python 优先级坑）
            if (mode & 0x8000) == 0:
                continue
            name = e[0x40:0x60].split(b'\x00')[0]
            try:
                nm = name.decode('ascii')
            except Exception:
                nm = repr(name)
            out.append(dict(index=i, mode=mode, length=length,
                            is_dir=bool(mode & 0x2000),
                            cluster=struct.unpack_from('<I', e, 0x10)[0],
                            parent=struct.unpack_from('<I', e, 0x14)[0],
                            name=nm))
        return out

    def dir_count(self, first: int) -> int:
        raw = bytearray()
        for cl in self.chain(first, 4):
            for k in range(self.ppc):
                raw += self._page(self.data_page(cl, k))
            if len(raw) >= PAGE:
                break
        return struct.unpack_from('<I', raw, 4)[0]


# ─────────────────── 写入层（逐行对齐 65_us2jp.py::Writable） ───────────────────

class WriteCard(ReadCard):
    """带写入能力的卡。

    ★★ 参考实现 `65_us2jp.py::Writable` 的类注释记着本项目最大的一个坑：
       `self.c`（基类只读句柄）指向**源卡**、`self.f` 才指向**副本**，
       于是"读一页 → 改 4 字节 → 写回"的**读**来自源卡 ⇒ 每写一次 FAT
       都会把上一次的修改**回退**成源卡旧值（FAT 写入被静默丢弃、链断、零报错）。

       本类的结构性解法：读写都走**同一个** `self.buf` 内存镜像，
       不存在第二个句柄，因此不可能回退。
    """

    def _wr_page(self, n: int, page512: bytes) -> None:
        assert len(page512) == PAGE
        off = n * STRIDE
        self.buf[off:off + PAGE] = page512
        self.buf[off + PAGE:off + STRIDE] = MC.page_ecc(page512)
        self.touched.add(n)
        # 记录"这一页最终应该长什么样"（最后一次为准）—— 用来区分"真变化"与"无效写入"，
        # 并且验证写入后的镜像确实等于这个意图（见 main() 里的断言）。
        self.intended[n] = (page512, MC.page_ecc(page512))

    def __init__(self, buf: bytes, path: str = '<memory>'):
        super().__init__(buf, path)
        self.touched = set()
        self.intended = {}

    def write_cluster_bytes(self, rel: int, data: bytes) -> None:
        assert len(data) <= self.ppc * PAGE
        data = data + b'\x00' * (self.ppc * PAGE - len(data))
        for k in range(self.ppc):
            self._wr_page(self.data_page(rel, k), data[k * PAGE:(k + 1) * PAGE])

    def write_page_raw(self, n: int, page512: bytes) -> None:
        self._wr_page(n, page512)

    def set_fat(self, rel: int, value: int) -> None:
        """改一个 FAT 项（**从同一个镜像读、往同一个镜像写**）。"""
        blk, off = rel // 256, (rel % 256) * 4
        fc = self.ind[blk]
        p0 = self.sys_page(fc, 0)
        raw = bytearray(self._page(p0) + self._page(p0 + 1))
        struct.pack_into('<I', raw, off, value)
        self._wr_page(p0, bytes(raw[:PAGE]))
        self._wr_page(p0 + 1, bytes(raw[PAGE:]))


# ─────────────────── 写入实验（= write_data2_inverted.py 的 5 步） ───────────────────

def write_experiment(src_bytes: bytes, spec: dict, report: dict):
    """在**内存副本**上新建一个文件（= `write_data2_inverted.py` 的 5 步 + 扩目录分支）。

    返回 (写入后的整卡字节, 新数据簇链, 目录扩出来的簇, 新 dirent 页号, 空 dirent 页号列表)。
    """
    dir_name, file_name = spec['dir'], spec['file']
    c = WriteCard(src_bytes)
    c.touched.clear()

    def find_dir(name):
        for e in c.dirents(c.rootdir, c.dir_count(c.rootdir)):
            if e['name'] == name:
                return e
        return None

    emb = find_dir(dir_name)
    assert emb is not None, '找不到目录 %s' % dir_name
    dir_first = emb['cluster']
    dir_count = emb['length']
    report['label'] = spec['label']
    report['note'] = spec['note']
    report['dirBefore'] = dict(name=dir_name, declaredCount=dir_count,
                               cluster=dir_first, chain=c.chain(dir_first, 64))
    subs_before = c.dirents(dir_first, dir_count)
    assert file_name not in [s['name'] for s in subs_before], '%s 已存在' % file_name

    # ---- 1) 分配簇（占用集合必须含：系统区 + 目录链 + 文件链）----
    used = set()
    used.add(c.ifc[0])                                    # 间接 FAT（绝对簇）
    for fc in c.ind:
        if fc != 0xFFFFFFFF:
            used.add(fc)                                  # 各 FAT 块（绝对簇）
    root_chain = c.chain(c.rootdir, 4096)
    for cl in root_chain:
        used.add(cl)                                      # ★ 根目录自己
    roots = c.dirents(c.rootdir, c.dir_count(c.rootdir))
    for e in roots:
        if e['name'] in ('.', '..'):
            continue
        for cl in c.chain(e['cluster'], 4096):
            used.add(cl)                                  # 子目录自己
        for s in c.dirents(e['cluster'], e['length']):
            if s['name'] in ('.', '..') or not s['length']:
                continue
            for cl in c.chain(s['cluster'], 4096):
                used.add(cl)                              # 文件链
    report['usedClusterCount'] = len(used)

    def alloc(n):
        got = []
        cur = c.aoff + 2
        while len(got) < n:
            if cur >= c.aend - 4:
                raise SystemExit('卡上空间不足')
            if cur in used:
                cur += 1
                continue
            got.append(cur)
            used.add(cur)
            cur += 1
        return got

    ncl = (WRITE_LEN + 1023) // 1024
    clusters = alloc(ncl)
    report['dataClusters'] = clusters

    # ---- 2) 写数据 + 每页重算 ECC ----
    for i, cl in enumerate(clusters):
        c.write_cluster_bytes(cl, WRITE_DATA[i * 1024:(i + 1) * 1024])

    # ---- 3) 写 FAT 链 ----
    for i, cl in enumerate(clusters):
        last = (i == len(clusters) - 1)
        c.set_fat(cl, FAT_END if last else ((0x80000000 | clusters[i + 1]) & 0xFFFFFFFF))

    # ---- 4) 找空槽；没有就扩目录 ----
    dir_chain = list(c.chain(dir_first, 4096))
    slots = len(dir_chain) * c.ppc
    raw_dir = bytearray()
    for cl in dir_chain:
        for k in range(c.ppc):
            raw_dir += c._page(c.data_page(cl, k))
    free = None
    for i in range(slots):
        if struct.unpack_from('<I', raw_dir, i * PAGE)[0] == 0xFFFFFFFF:
            free = i
            break
    ext = []
    empty_pages = []
    if free is None:
        # ★ 扩目录：新簇的**两页**都要初始化成"空槽"形态（整页 FF + 正确 ECC）
        #   真卡依据：BISLPS-25462GAME 的空槽（绝对页 1557）备用区 = page_ecc(FF×512)
        new_cl = alloc(1)[0]
        ext = [new_cl]
        tail = dir_chain[-1]
        c.set_fat(tail, (0x80000000 | new_cl) & 0xFFFFFFFF)
        c.set_fat(new_cl, FAT_END)
        for k in range(c.ppc):
            c.write_page_raw(c.data_page(new_cl, k), b'\xFF' * PAGE)   # 数据 + 备用区一起写
            empty_pages.append(c.data_page(new_cl, k))
        dir_chain = dir_chain + [new_cl]
        slots = len(dir_chain) * c.ppc
        raw_dir += bytes([0xFF]) * (c.ppc * PAGE)
        free = slots - c.ppc
    else:
        # 复用空槽时，同一簇的另一页如果也是空槽，也按真卡形态铺好（本实验里不是）
        ci, k = free // c.ppc, free % c.ppc
        other = c.data_page(dir_chain[ci], 1 - k)
        if struct.unpack_from('<I', c._page(other), 0)[0] == 0xFFFFFFFF:
            c.write_page_raw(other, b'\xFF' * PAGE)
            empty_pages.append(other)
    report['dirExtensionClusters'] = ext
    report['emptyDirentPages'] = empty_pages
    report['slot'] = free

    # 克隆同目录下一条有内容的文件 dirent（= write_data2_inverted.py 第 6 步）
    template = None
    for s in subs_before:
        if s['name'] not in ('.', '..') and s['length'] and s['cluster']:
            template = s
            break
    assert template is not None, '目录里没有可克隆的文件项'
    report['templateFile'] = template['name']
    new = bytearray(raw_dir[template['index'] * PAGE:(template['index'] + 1) * PAGE])
    struct.pack_into('<I', new, 0x10, clusters[0])         # 首簇
    struct.pack_into('<I', new, 0x04, WRITE_LEN)           # 长度
    new[0x40:0x60] = b'\x00' * 0x20                        # 清名（真卡：名字区 = 名 + 00…）
    new[0x40:0x40 + len(file_name)] = file_name.encode('ascii')
    page = c.data_page(dir_chain[free // c.ppc], free % c.ppc)
    c.write_page_raw(page, bytes(new))
    report['direntPage'] = page
    report['direntSHA256'] = sha(bytes(new))

    # ---- 5) 更新项数（真卡口径：记在**根目录里那个目录条目**的 length 上）----
    re_idx = [i for i, e in enumerate(roots) if e['name'] == dir_name][0]
    rpg = c.data_page(root_chain[re_idx // c.ppc], re_idx % c.ppc)
    page_before = c._page(rpg)
    old_len = struct.unpack_from('<I', page_before, 0x04)[0]
    assert old_len == dir_count, '根条目 length(%d) != %s 声明项数(%d)' % (old_len, dir_name, dir_count)
    new_root_page = bytearray(page_before)
    struct.pack_into('<I', new_root_page, 0x04, old_len + 1)
    c.write_page_raw(rpg, bytes(new_root_page))
    report['rootEntry'] = dict(index=re_idx, page=rpg, oldCount=old_len, newCount=old_len + 1)

    report['touchedPagesRaw'] = sorted(c.touched)
    # 每一页"最终意图"（512 B 数据 + 16 B 备用区）—— 只留 SHA-256，够比对也够小
    report['intendedWrites'] = [
        dict(page=p, sha256Data=sha(v[0]), sha256Spare=sha(v[1]))
        for p, v in sorted(c.intended.items())
    ]
    return bytes(c.buf), clusters, ext, page, empty_pages


# ─────────────────── 采集 ───────────────────

def card_report(name: str, buf: bytes) -> dict:
    card = ReadCard(buf, name)
    n_root = card.dir_count(card.rootdir)
    roots = card.dirents(card.rootdir, n_root)
    rep = dict(
        name=name,
        size=len(buf),
        sha256=sha(buf),
        npages=card.npages,
        pageLen=card.page_len,
        ppc=card.ppc,
        ppb=card.ppb,
        clusters=card.clusters,
        allocOffset=card.aoff,
        allocEnd=card.aend,
        rootdir=card.rootdir,
        ifc0=card.ifc[0],
        rootChain=card.chain(card.rootdir, 64),
        rootDotLength=n_root,
        root=[dict(index=e['index'], mode=e['mode'], length=e['length'],
                   cluster=e['cluster'], parent=e['parent'], name=e['name'])
              for e in roots],
        emblemDirs=[],
    )
    for e in roots:
        nm = e['name']
        if nm in ('.', '..') or not nm.startswith('B'):
            continue
        is_emb = bool(nm.endswith('EMB')) or (len(nm) >= 3 and nm[-3] == 'E' and nm[-2:].isdigit())
        if not is_emb:
            continue
        files = []
        for s in card.dirents(e['cluster'], e['length']):
            if s['name'] in ('.', '..'):
                continue
            data = card.read_file(s['cluster'], s['length']) if s['length'] else b''
            files.append(dict(index=s['index'], name=s['name'], mode=s['mode'],
                              length=s['length'], cluster=s['cluster'],
                              chain=card.chain(s['cluster'], 4096) if s['length'] else [],
                              sha256=sha(data),
                              readLength=len(data)))
        rep['emblemDirs'].append(dict(name=nm, declaredCount=e['length'],
                                      cluster=e['cluster'],
                                      chain=card.chain(e['cluster'], 64),
                                      selfDotLength=card.dir_count(e['cluster']),
                                      files=files))
    return rep


def ecc_report() -> dict:
    """几个固定的 ECC 参考值（页字节 ⇒ 16 B 备用区），给 TS 侧做算法自检。"""
    pages = {
        'zero': bytes(PAGE),
        'ones': bytes([0xFF] * PAGE),
        'ramp': bytes((i * 7 + 3) & 0xFF for i in range(PAGE)),
    }
    # 真卡超块那一页（第 0 页）—— 最真实的一个样本
    with open(os.path.join(EVIDENCE, EXPERIMENTS[0]['sourceCard']), 'rb') as f:
        pages['card0_page0'] = f.read(PAGE)
    out = {}
    for k, v in pages.items():
        out[k] = dict(page=v.hex(), ecc=MC.page_ecc(v).hex(),
                      sha256Page=sha(v), sha256Ecc=sha(MC.page_ecc(v)))
    return out


def main() -> int:
    if not os.path.isdir(EVIDENCE):
        print('❌ 找不到 %s' % EVIDENCE)
        return 1
    os.makedirs(FIXTURES, exist_ok=True)

    cards = sorted(f for f in os.listdir(EVIDENCE) if f.lower().endswith('.ps2'))
    if len(cards) != 4:
        print('⚠️ out\\evidence 里有 %d 张 .ps2（预期 4 张）：%s' % (len(cards), cards))

    # 源卡 SHA-256（写前），结束时再核一次 —— 证明只读
    src_hashes_before = {}
    for nm in cards:
        with open(os.path.join(EVIDENCE, nm), 'rb') as f:
            src_hashes_before[nm] = sha(f.read())

    print('=== 1) 只读普查 out\\evidence\\*.ps2 ===')
    card_reps = []
    for nm in cards:
        with open(os.path.join(EVIDENCE, nm), 'rb') as f:
            buf = f.read()
        rep = card_report(nm, buf)
        card_reps.append(rep)
        n_files = sum(len(d['files']) for d in rep['emblemDirs'])
        print('   %-24s %d 根项 / %d 徽章目录 / %d 文件' %
              (nm, len(rep['root']), len(rep['emblemDirs']), n_files))
        for d in rep['emblemDirs']:
            print('        [%-20s] 声明项数=%-2d 目录链=%s' %
                  (d['name'], d['declaredCount'], d['chain']))
            for s in d['files']:
                print('             %-14s len=%-6d cl=%-5d chain=%-3d sha256=%s'
                      % (s['name'], s['length'], s['cluster'], len(s['chain']), s['sha256'][:16]))

    print()
    print('=== 2) ECC 参考值 ===')
    ecc = ecc_report()
    for k, v in ecc.items():
        print('   %-16s page=%s…  ecc=%s' % (k, v['sha256Page'][:12], v['ecc']))

    print()
    print('=== 3) 写入实验（副本在系统临时目录，源卡只读）===')
    tmpdir = tempfile.mkdtemp(prefix='emb_card_fixture_')
    write_reps = []
    try:
        for spec in EXPERIMENTS:
            src_path = os.path.join(EVIDENCE, spec['sourceCard'])
            dst_path = os.path.join(tmpdir, 'copy_%s.ps2' % spec['label'])
            shutil.copyfile(src_path, dst_path)
            with open(dst_path, 'rb') as f:
                src_bytes = f.read()
            rep = {}
            after, clusters, ext, dirent_page, empty_pages = write_experiment(src_bytes, spec, rep)
            with open(os.path.join(tmpdir, 'after_%s.ps2' % spec['label']), 'wb') as f:
                f.write(after)

            # 变化的页（逐页 512 B 比对）
            changed = []
            for p in range(len(src_bytes) // STRIDE):
                a = src_bytes[p * STRIDE:p * STRIDE + PAGE]
                b = after[p * STRIDE:p * STRIDE + PAGE]
                if a != b:
                    changed.append(dict(page=p, sha256Before=sha(a), sha256After=sha(b)))
            touched = rep['touchedPagesRaw']
            changed_pages = [c['page'] for c in changed]
            # ① 绝不能有"变了但没报告"的页（漏报 = 静默写入，最危险）
            assert set(changed_pages) <= set(touched), \
                '[%s] 有变化页没被报告：%s' % (spec['label'], sorted(set(changed_pages) - set(touched)))
            # "报告了但字节恰好没变"的**无效写入**（no-op）。真卡上确实会有，两种来源：
            #   · FAT：单簇文件的链尾 `0x80000000|0x7FFFFFFF` == 空闲标记 `0x7FFFFFFF`
            #     ⇒ 该 FAT 页字节不变（如本文件的页 28）；
            #   · 数据页：源卡上那一页本来就是"整页 FF + 正确 ECC"（如扩簇时铺的页 2935）。
            # 关键判据不是"有没有 no-op"，而是下面的"写后字节 == 写入意图"。
            noop = sorted(set(touched) - set(changed_pages))
            rep['noopWritePages'] = noop
            # 但**写入后的镜像必须逐字节等于写入意图**（意图取自 WriteCard.intended，
            # 即每一次 _wr_page 的最终内容）—— 这才真正证明"写进去的就是想写的"。
            for w in rep['intendedWrites']:
                p = w['page']
                d = after[p * STRIDE:p * STRIDE + PAGE]
                sp = after[p * STRIDE + PAGE:p * STRIDE + STRIDE]
                assert sha(d) == w['sha256Data'] and sha(sp) == w['sha256Spare'], \
                    '[%s] 页 %d 的实际字节 != 写入意图' % (spec['label'], p)
            # 变化页必须都在"意图写入"集合里，且每个变化页的"写后"哈希与意图一致
            intended_map = {w['page']: w for w in rep['intendedWrites']}
            for ch in changed:
                assert ch['page'] in intended_map, \
                    '[%s] 页 %d 变了但不在写入意图里' % (spec['label'], ch['page'])
                assert ch['sha256After'] == intended_map[ch['page']]['sha256Data'], \
                    '[%s] 页 %d 的写后哈希 != 意图' % (spec['label'], ch['page'])

            # 整页（512 数据 + 16 备用区）级的变化页集合：
            #   = 512 B 级变化页 ∪ "只有备用区变了"的页
            # 比 512 B 级多出来的那些页，正是扩簇时铺的空槽页（数据本来就是 FF，
            # 只把备用区从 FF×16 改成算好的 ECC）。
            changed_strides = [p for p in range(len(src_bytes) // STRIDE)
                               if src_bytes[p * STRIDE:(p + 1) * STRIDE]
                               != after[p * STRIDE:(p + 1) * STRIDE]]
            spare_only = sorted(set(changed_strides) - set(changed_pages))
            # ① 只有备用区变了 ⇒ 数据区必须逐字节相同（否则就是数据被动了却没被发现）
            for p in spare_only:
                assert src_bytes[p * STRIDE:p * STRIDE + PAGE] \
                    == after[p * STRIDE:p * STRIDE + PAGE], \
                    '[%s] 页 %d 声称"只有备用区变"，但数据区也变了' % (spec['label'], p)
            # ② 整页级变化 ⊆ 触碰集合；剩下"整页都没变"的触碰页 = **真 no-op**
            assert set(changed_strides) <= set(touched), \
                '[%s] 有整页变化没被报告：%s' % (
                    spec['label'], sorted(set(changed_strides) - set(touched)))
            stride_noop = sorted(set(touched) - set(changed_strides))
            rep['strideNoopWritePages'] = stride_noop
            # ③ 真 no-op 页在源卡与产物里必须逐字节（含备用区）相同
            for p in stride_noop:
                assert src_bytes[p * STRIDE:(p + 1) * STRIDE] \
                    == after[p * STRIDE:(p + 1) * STRIDE], \
                    '[%s] 页 %d 被当成 no-op，但它其实变了' % (spec['label'], p)
            # ④ `noop` 是更严的定义：**512 B 数据**没变（备用区可能变了）
            assert set(noop) <= set(stride_noop) | set(spare_only), \
                '[%s] noop 定义不一致：%s' % (spec['label'], noop)
            rep['changedStridePages'] = changed_strides
            rep['spareOnlyChangedPages'] = spare_only

            # "复用空槽 vs 扩簇"两条路径必须各自成立
            if spec['expectExtension']:
                assert ext, '[%s] 预期扩目录，但没扩' % spec['label']
                assert len(empty_pages) == 2, \
                    '[%s] 扩簇必须把新簇两页都铺成空槽形态，实际 %s' % (spec['label'], empty_pages)
            else:
                assert not ext, '[%s] 预期复用空槽（不扩目录），实际扩了 %s' % (spec['label'], ext)
                assert not empty_pages, \
                    '[%s] 复用空槽、不扩簇 ⇒ 不该有"新铺的空 dirent 页"，实际 %s' % (
                        spec['label'], empty_pages)

            # 回读校验（用只读层重新解析写入后的镜像）
            v = ReadCard(after, '<after>')
            emb = [e for e in v.dirents(v.rootdir, v.dir_count(v.rootdir))
                   if e['name'] == spec['dir']][0]
            subs = v.dirents(emb['cluster'], emb['length'])
            tgt = [s for s in subs if s['name'] == spec['file']]
            assert tgt, '[%s] 回读找不到 %s' % (spec['label'], spec['file'])
            tgt = tgt[0]
            got = v.read_file(tgt['cluster'], tgt['length'])
            assert got == WRITE_DATA, '[%s] 回读内容不符' % spec['label']

            # 逐页 ECC：新数据簇的两页 + 新 dirent 页 + 空 dirent 页 + 根条目页
            ecc_report_pages = []
            for cl in clusters:
                for k in range(v.ppc):
                    ecc_report_pages.append(v.data_page(cl, k))
            ecc_report_pages += empty_pages + [dirent_page, rep['rootEntry']['page']]
            bad_ecc = [pg for pg in ecc_report_pages
                       if v._spare(pg) != MC.page_ecc(v._page(pg))]

            # 空 dirent 页的形态：数据 = FF×512、备用区 != FF×16
            empty_forms = []
            for pg in empty_pages:
                d = v._page(pg)
                sp = v._spare(pg)
                empty_forms.append(dict(
                    page=pg,
                    dataAllFF=(d == b'\xFF' * PAGE),
                    spareHex=sp.hex(),
                    # ★ 0.46：这里原来还有 `spareHexSpaced`（带空格的人眼版）与下面 rep 里的
                    #   `fileDataPattern`（一句散文说明）—— 两者在 TS 侧**一个读者都没有**
                    #   （前者只在接口里声明过、后者连接口条目都没有）⇒ 删掉（证据链不靠它们）。
                    spareIsComputedECC=(sp == MC.page_ecc(d)),
                    spareIsVirginFFFF=(sp == b'\xFF' * ECC),
                    modeAllFF=(d[:4] == b'\xFF' * 4),
                ))

            rep.update(dict(
                label=spec['label'],
                expectExtension=bool(spec['expectExtension']),
                sourceCard=spec['sourceCard'],
                sourceSHA256=sha(src_bytes),
                resultSHA256=sha(after),
                fileName=spec['file'],
                fileLength=WRITE_LEN,
                fileDataSHA256=sha(WRITE_DATA),
                changedPageCount=len(changed),
                changedPages=changed,
                touchedPages=sorted(touched),
                eccCheckedPages=ecc_report_pages,
                eccBadPages=bad_ecc,
                emptyDirentPages=empty_pages,
                emptyDirentForms=empty_forms,
                readback=dict(dirDeclaredCount=emb['length'], fileCount=len(subs),
                              fileNames=[s['name'] for s in subs],
                              fileCluster=tgt['cluster'], fileLength=tgt['length'],
                              chain=v.chain(tgt['cluster'], 4096)),
            ))
            write_reps.append(rep)

            print()
            print('   ── 实验 [%s] %s' % (spec['label'], spec['note']))
            print('   源卡        : %s  sha256=%s' % (spec['sourceCard'], rep['sourceSHA256'][:16]))
            print('   目标目录    : %s  写前声明项数=%d 链=%s（%d 槽）'
                  % (spec['dir'], rep['dirBefore']['declaredCount'], rep['dirBefore']['chain'],
                     len(rep['dirBefore']['chain']) * 2))
            print('   分配数据簇  : %d 个 %s…%s' % (len(clusters), clusters[:3], clusters[-2:]))
            print('   扩目录簇    : %s' % (ext or '（链内有空槽 ⇒ 复用，不扩）'))
            print('   新项槽号    : %d（绝对页 %d）' % (rep['slot'], dirent_page))
            if spec['label'] == 'reuse-free-slot':
                # 复用路径的铁证：源卡这一页本来就是"整页 FF 空 dirent + 正确 ECC"
                sp_before = src_bytes[dirent_page * STRIDE + PAGE:dirent_page * STRIDE + STRIDE]
                d_before = src_bytes[dirent_page * STRIDE:dirent_page * STRIDE + PAGE]
                print('   该槽写前形态: 数据=%s  mode=0x%08X  备用区=%s  =page_ecc(FF页)=%s  =FF×16=%s'
                      % ('全 FF' if d_before == b'\xFF' * PAGE else '非全 FF',
                         struct.unpack_from('<I', d_before, 0)[0], sp_before.hex(' '),
                         sp_before == MC.page_ecc(d_before), sp_before == b'\xFF' * ECC))
            print('   项数更新    : 根目录 slot %d 的 length %d → %d（页 %d）'
                  % (rep['rootEntry']['index'], rep['rootEntry']['oldCount'],
                     rep['rootEntry']['newCount'], rep['rootEntry']['page']))
            for f_ in empty_forms:
                print('   新簇铺页    : %d  数据全FF=%s（全 FF = 保留为空槽；否则 = 被新 dirent 占用）'
                      '  备用区=%s  =page_ecc(该页数据)=%s  =FF×16=%s'
                      % (f_['page'], f_['dataAllFF'], ' '.join(f_['spareHex'][i:i + 2] for i in range(0, len(f_['spareHex']), 2)),
                         f_['spareIsComputedECC'], f_['spareIsVirginFFFF']))
            print('   变化页      : %d 页 %s' % (len(changed), changed_pages))
            if noop:
                print('   无效写入页  : %s（512 B 数据没变；写后内容仍 100%% 等于写入意图）' % noop)
                print('   整页无效写入: %s（连备用区都没变 ⇒ 真的是"写了个一样的值"）' % stride_noop)
            print('   写入后整卡  : sha256=%s' % rep['resultSHA256'])
            print('   回读        : %s 链长=%d 长度=%d  ECC 坏页=%d %s'
                  % (spec['file'], len(rep['readback']['chain']),
                     rep['readback']['fileLength'], len(bad_ecc), bad_ecc or ''))
            assert not bad_ecc, '[%s] 有 ECC 坏页：%s' % (spec['label'], bad_ecc)
            assert got == WRITE_DATA
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)

    # ---- 源卡未被修改 ----
    print()
    print('=== 4) 源卡只读自证 ===')
    for nm in cards:
        with open(os.path.join(EVIDENCE, nm), 'rb') as f:
            now = sha(f.read())
        ok = now == src_hashes_before[nm]
        print('   %-24s %s' % (nm, '未变 ✅' if ok else '❌ 变了！'))
        assert ok, '源卡 %s 被修改了！' % nm

    manifest = dict(
        generatedBy='web/test/make_card_fixtures.py',
        note='由 Python 参考实现生成的期望值；TS 层必须逐字节复现。',
        constants=dict(pageSize=PAGE, spareSize=ECC, stride=STRIDE, bytesPerCluster=1024,
                       cardSize8MB=8650752, pages8MB=16384, clusters8MB=8192),
        eccReference=ecc,
        cards=card_reps,
        experiments=write_reps,
    )
    with open(OUT_JSON, 'w', encoding='utf-8', newline='\n') as f:
        json.dump(manifest, f, ensure_ascii=False, indent=1, sort_keys=False)
        f.write('\n')
    print()
    print('✅ 夹具已写出：%s（%d B）' % (OUT_JSON, os.path.getsize(OUT_JSON)))
    return 0


if __name__ == '__main__':
    sys.exit(main())
