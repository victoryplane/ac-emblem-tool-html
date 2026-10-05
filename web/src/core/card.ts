/**
 * PS2 记忆卡层（TypeScript · 零依赖 · ESM）—— 逐字节忠实移植自 Python 参考实现
 *
 * 移植来源（本文件每一处算法都对着它们写，没有自行发挥）：
 *   · 只读层 `Card`      ：`AC3_CN\tools\30-存档\61_mc_survey.py`
 *   · 写入层 `Writable`  ：`AC3_CN\tools\30-存档\65_us2jp.py`
 *   · ECC 原语           ：`AC3_CN\tools\30-存档\60_mc.py`
 *   · 参考用法（读）     ：`_selftest\dump_card_emblems.py`
 *   · 参考用法（写）     ：`_selftest\write_data2_inverted.py`（实机已验证）
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 【物理布局】
 *   每页 = 512 B 数据 + 16 B 备用区（其中前 12 B 是 ECC、后 4 B 恒 0）= 528 B（stride）。
 *   第 N 页在文件偏移 `N * 528`。8 MB 卡 = 8,650,752 B = 16,384 页。
 *
 *   每簇 = 2 页 = 1024 B 数据 + 32 B 备用区。卡容量 8192 簇（= 8,388,608 B 数据）。
 *
 *   ★★ 簇号有两套约定（本项目最大的坑，`61_mc_survey.py` 类 docstring）：
 *       · 系统区（超块里的 ifc_list、各 FAT 块所在簇）= **绝对**簇号
 *         ⇒ page = cluster * ppc
 *       · 文件/目录（dirent 里的 cluster 字段）= **相对 alloc_offset** 的簇号
 *         ⇒ page = (cluster + alloc_offset) * ppc
 *     两者不可混用。本文件里：`sysPage()` 走绝对，`dataPage()` 走相对。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 【★ 读-改-写必须走"同一个句柄/同一份镜像" —— 移植自 `65_us2jp.py::Writable` 的血泪注释】
 *
 *   Python 原版 `Writable` 里有一次真实事故：基类 `Card` 的 `self.c` 指向**源卡**只读句柄，
 *   而 `self.f` 才指向**副本**。于是 `set_fat()` 里"读一页 → 改 4 字节 → 写回"的**读**是从
 *   源卡读的，**写**是往副本写的 ⇒ 每一次写 FAT 都把上一次的修改**回退**成源卡的旧值。
 *   症状：FAT 写入被**静默丢弃**、簇链断裂、目录里只剩 `.` 和 `..`，**全程零报错**。
 *
 *   本移植在结构上消灭这类错误：`Card` 内部**只有一个 `Uint8Array` 镜像**，
 *   `readDataPage` / `writeDataPage` / `readFat` / `writeFat` 全部作用于**同一个**
 *   `this.buf`。因此只要调用方传进来的是一份"卡副本"的字节，读-改-写天然自洽。
 *
 *   ⚠️ 反过来说：**如果你把一个只读的源卡 buffer 交给 `new Card(buf)` 然后又去调写入 API，
 *      你就是在复现上面那个坑**（写进的是源卡的镜像，而你以为写的是副本）。
 *      正确用法永远是：`const copy = new Uint8Array(await file.arrayBuffer());`
 *      然后**只对 `copy` 建 Card**（见 `web/test/card.test.ts` 的 `--badhandle` 自检）。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 【★ dirent（512 B 目录项）字段布局 —— 以真卡实测为准，不照抄 PCSX2 头文件】
 *   +0x00 u32 mode          低 16 位有效：目录 `0x8427`、普通文件 `0x8497`、
 *                           父目录项 `0xA426`。详见下面 `modeIsDir()` 的长注释。
 *   +0x04 u32 length        文件 = 字节数；**目录 = **项数**（不是字节数！）
 *   +0x08 8 B  creation time（BCD，未复刻；本层原样保留透传）
 *   +0x10 u32 cluster       首簇（**相对 alloc_offset**）
 *   +0x14 u32 parent        父目录里的项号（4 项/簇 ⇒ index = cluster*4 + pos）
 *   +0x18 8 B  modification time
 *   +0x20 4 B  unknown
 *   +0x24 4 B  unknown
 *   +0x40 32 B name          ASCII，NUL 结尾/填充
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 【★ 空槽判据】`mode === 0xFFFFFFFF`（未使用项写满 FF）。注意区分：
 *   · `0xFFFFFFFF` = 单簇文件的**链尾**标记（`0x80000000 | 0x7FFFFFFF`）**也**是空槽标记；
 *     但二者所在位置不同（FAT 表 vs 目录项），不会撞车。
 *   · `0x7FFFFFFF` = FAT 里**从未分配**的簇（bit31 = 0）。
 *     ⚠️ 分配新簇时**不能**只信 FAT 值：真卡上 `0xFFFFFFFF` 既表示"单簇文件的链尾"，
 *       也是空槽值，光看 FAT 分不清。参考实现用的是"**可达集合 + 系统区**"扫描法
 *       （见 `collectUsedClusters`），本移植照搬。
 */

// ─────────────────────────── 常量 ───────────────────────────

/** 页数据区大小（字节）。 */
export const PAGE_SIZE = 512;
/** 页备用区大小（字节）：前 12 B = ECC（4 段 × 3 B），后 4 B 恒 0。 */
export const SPARE_SIZE = 16;
/** 一页在整卡镜像里的步长 = 512 + 16 = 528。 */
export const STRIDE = 528;
/** 每簇页数在真卡上恒为 2（本层从超块读 `ppc`，不写死）。 */
/** 8 MB 卡整卡字节数 = 16,384 页 × 528。 */
export const CARD_SIZE_8MB = 8650752;
/** 8 MB 卡页数。 */
export const CARD_PAGES_8MB = CARD_SIZE_8MB / STRIDE; // 16384
/** 8 MB 卡簇数（超块 `clusters` 字段实测值）。 */
export const CARD_CLUSTERS_8MB = 8192;

/** FAT / 簇链相关魔数。 */
export const FAT_END = 0x7fffffff; // 链尾低位；真链尾 = 0x80000000 | FAT_END
export const FAT_FREE = 0x7fffffff; // 从未分配的簇（bit31 = 0）
export const FAT_MASK = 0x7fffffff; // 取低位 30/31 位做"下一簇"
export const INVALID_CLUSTER = 0xffffffff; // 不存在的项（FAT 块 / 簇号两处都表示"无"）

/** 空目录项的 mode（整项 0xFF）。 */
export const DIRENT_EMPTY_MODE = 0xffffffff;

/** dirent 里各字段的字节偏移。 */
export const DIRENT_MODE = 0x00;
export const DIRENT_LENGTH = 0x04;
export const DIRENT_CLUSTER = 0x10;
export const DIRENT_PARENT = 0x14;
export const DIRENT_NAME = 0x40;
export const DIRENT_NAME_MAX = 0x20;

/** 真卡实测的 mode 常量（16 位有意义的形态）。 */
export const MODE_DIR = 0x8427;
export const MODE_FILE = 0x8497;
export const MODE_PARENT = 0xa426;

// ─────────────────────────── ECC ───────────────────────────

/**
 * 偶校验表（`PARITY[b]` = popcount(b) & 1）。
 *
 * Python 原版把 256 B 的表**硬编码**在 `60_mc.py` 里。这里改成**按位算**：
 * 结果逐位相同（它就是偶校验），但省掉 256 个字节的人工誊抄 —— 誊抄才是出错源。
 * 自检见 `web/test/card.test.ts` 的 `PARITY_VS_PYTHON_FIXTURE`。
 */
export const PARITY: Uint8Array = (() => {
  const t = new Uint8Array(256);
  for (let b = 0; b < 256; b++) {
    let v = b;
    let p = 0;
    while (v) {
      p ^= v & 1;
      v >>= 1;
    }
    t[b] = p;
  }
  return t;
})();

/**
 * 列校验模式表（PCSX2 源码原文，源自 mymc，public domain）—— 256 B，**逐字节誊抄**。
 * 这是唯一的查表；`calcEcc` 里 `col ^= CPM[b]`。
 */
export const CPM: Uint8Array = new Uint8Array([
  0, 7, 22, 17, 37, 34, 51, 52, 52, 51, 34, 37, 17, 22, 7, 0, 67, 68, 85, 82, 102, 97, 112, 119,
  119, 112, 97, 102, 82, 85, 68, 67, 82, 85, 68, 67, 119, 112, 97, 102, 102, 97, 112, 119, 67,
  68, 85, 82, 17, 22, 7, 0, 52, 51, 34, 37, 37, 34, 51, 52, 0, 7, 22, 17, 97, 102, 119, 112, 68,
  67, 82, 85, 85, 82, 67, 68, 112, 119, 102, 97, 34, 37, 52, 51, 7, 0, 17, 22, 22, 17, 0, 7, 51,
  52, 37, 34, 51, 52, 37, 34, 22, 17, 0, 7, 7, 0, 17, 22, 34, 37, 52, 51, 112, 119, 102, 97, 85,
  82, 67, 68, 68, 67, 82, 85, 97, 102, 119, 112, 112, 119, 102, 97, 85, 82, 67, 68, 68, 67, 82,
  85, 97, 102, 119, 112, 51, 52, 37, 34, 22, 17, 0, 7, 7, 0, 17, 22, 34, 37, 52, 51, 34, 37, 52,
  51, 7, 0, 17, 22, 22, 17, 0, 7, 51, 52, 37, 34, 97, 102, 119, 112, 68, 67, 82, 85, 85, 82, 67,
  68, 112, 119, 102, 97, 17, 22, 7, 0, 52, 51, 34, 37, 37, 34, 51, 52, 0, 7, 22, 17, 82, 85, 68,
  67, 119, 112, 97, 102, 102, 97, 112, 119, 67, 68, 85, 82, 67, 68, 85, 82, 102, 97, 112, 119,
  119, 112, 97, 102, 82, 85, 68, 67, 0, 7, 22, 17, 37, 34, 51, 52, 52, 51, 34, 37, 17, 22, 7, 0,
]);

/**
 * 对 128 B 数据算 3 B ECC（列校验 1 B + 行校验 0 1 B + 行校验 1 1 B）。
 *
 * 逐行对应 `60_mc.py::calc_ecc`：
 *   col = 0x77, lp0 = 0x7F, lp1 = 0x7F
 *   for i in range(128):
 *       b = buf[i]
 *       col ^= CPM[b]
 *       if PARITY[b]:
 *           lp0 ^= (~i) & 0x7F     // ★ 不是 & 0xFF
 *           lp1 ^= i
 *
 * ★★ `(~i) & 0x7F` 是**真卡反解定案**（`78_ecc_solve.py`）：
 *   `& 0xFF` 会让 `i ∈ [0,128)` 恒带 bit7 ⇒ 算出的 lp0 多一个 bit7，
 *   而真卡里 lp0 的 **bit7 恒为 0**。旧写法 5 张真卡只匹配 3,800/17,188；
 *   新写法匹配 13,137/13,138（唯一例外是每张真卡都有的第 1 页 —— 那页的 ECC 从没被维护过）。
 *   ⇒ 本层一律用 `& 0x7F`；写在注释里防止被"顺手改回去"。
 */
export function calcEcc(buf128: Uint8Array, offset = 0): [number, number, number] {
  // ★ 0.19：短缓冲必须**显式报错**。原先越界读出来是 `undefined`，`col ^= undefined` 是静默无效
  //   （等于"对隐式零尾算 ECC"），会把一个坏缓冲算成一个看似正常的 ECC。
  if (buf128.length < offset + 128) {
    throw new Error(`calcEcc: 需要 ${offset + 128} 字节（offset=${offset}），实到 ${buf128.length}`);
  }
  let col = 0x77;
  let lp0 = 0x7f;
  let lp1 = 0x7f;
  for (let i = 0; i < 128; i++) {
    const b = buf128[offset + i];
    col ^= CPM[b];
    if (PARITY[b]) {
      lp0 ^= ~i & 0x7f; // ★ 必须 & 0x7F
      lp1 ^= i;
    }
  }
  return [col, lp0, lp1];
}

/**
 * 一页 512 B ⇒ 16 B 备用区 = ECC(4 段 × 3 B) + 4 B 保留（恒 0）。
 * `page512[0:128] / [128:256] / [256:384] / [384:512]` 各算一次 3 B。
 */
export function pageEcc(page512: Uint8Array): Uint8Array {
  const out = new Uint8Array(SPARE_SIZE);
  for (let j = 0; j < 4; j++) {
    const [c, l0, l1] = calcEcc(page512, j * 128);
    out[j * 3] = c;
    out[j * 3 + 1] = l0;
    out[j * 3 + 2] = l1;
  }
  // out[12..16) 保持 0（保留字段）
  return out;
}

// ─────────────────────────── 小工具 ───────────────────────────

function u32le(buf: Uint8Array, off: number): number {
  // ★ 0.19：越界**报错**（原先读出来是 `undefined`，被 `|` 静默变成 0 —— 那是"坏卡被当成
  //   一堆 0"的总源头：超块 ifc[] 坏掉 ⇒ ind[] 全 0 ⇒ writeFat 拿簇 0（超块自己）当 FAT 块）。
  if (off < 0 || off + 4 > buf.length) {
    throw new Error(`u32le: 越界读（偏移 ${off}，缓冲 ${buf.length} 字节）`);
  }
  return (
    (buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24)) >>> 0
  );
}

function setU32le(buf: Uint8Array, off: number, v: number): void {
  buf[off] = v & 0xff;
  buf[off + 1] = (v >>> 8) & 0xff;
  buf[off + 2] = (v >>> 16) & 0xff;
  buf[off + 3] = (v >>> 24) & 0xff;
}

function u16le(buf: Uint8Array, off: number): number {
  if (off < 0 || off + 2 > buf.length) {
    throw new Error(`u16le: 越界读（偏移 ${off}，缓冲 ${buf.length} 字节）`);
  }
  return buf[off] | (buf[off + 1] << 8);
}

function bytesEqual(a: Uint8Array, b: Uint8Array, aOff = 0, bOff = 0, n = a.length): boolean {
  for (let i = 0; i < n; i++) if (a[aOff + i] !== b[bOff + i]) return false;
  return true;
}

/** 名称字段（32 B）按 NUL 截断后做 ASCII 解码；非 ASCII 时退回 `\xNN` 转义形式。 */
function decodeName(raw: Uint8Array): { name: string; nameRaw: Uint8Array } {
  let end = raw.length;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === 0) {
      end = i;
      break;
    }
  }
  const nameRaw = raw.slice(0, end);
  let ascii = true;
  let s = '';
  for (let i = 0; i < nameRaw.length; i++) {
    const c = nameRaw[i];
    if (c < 0x20 || c > 0x7e) {
      ascii = false;
      break;
    }
    s += String.fromCharCode(c);
  }
  if (ascii) return { name: s, nameRaw };
  // Python 版退回 repr()；这里用等价的确定性转义（非字节精确，仅显示用）
  let esc = '';
  for (let i = 0; i < nameRaw.length; i++) esc += '\\x' + nameRaw[i].toString(16).padStart(2, '0');
  return { name: esc, nameRaw };
}

/**
 * 32 B 名称字段的**确切写法**（真卡实测，见 `Mcd001_embdata2.ps2` 的 EMB 目录逐项 dump）：
 *
 *     `name` 的 ASCII + `00` + 一路 `00` 到第 32 字节。
 *     例：`data0` ⇒ `64 61 74 61 30 00 00 00 … 00`（不是 FF！）
 *
 * 名字在 NUL 处结束；若名字占满 31 B，第 32 字节固定为 `00`（保证有终止符）。
 */
export function encodeName(name: string): Uint8Array {
  const out = new Uint8Array(DIRENT_NAME_MAX); // 默认全 0
  // ★ 0.19：非 ASCII 名必须**报错**。原先 `charCodeAt(i) & 0xff` 会把中文名悄悄截成乱字节
  //   （写上卡之后再也认不出来），而 Python 参考实现在这里抛（`name.encode('ascii')`）。
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i);
    if (c > 0x7e || c < 0x20) {
      throw new Error(`encodeName: 记忆卡文件名只允许可打印 ASCII（第 ${i} 个字符是 U+${c.toString(16).toUpperCase()}）`);
    }
  }
  const n = Math.min(name.length, DIRENT_NAME_MAX - 1);
  for (let i = 0; i < n; i++) out[i] = name.charCodeAt(i) & 0xff;
  out[n] = 0;
  return out;
}

// ─────────────────────────── 类型 ───────────────────────────

/** 解析后的目录项。 */
export interface Dirent {
  /** 在该目录里的项号（0 起）。 */
  index: number;
  /** 原始 u32 mode（真卡上高位为 0，只有低 16 位有意义）。 */
  mode: number;
  /** 文件 = 字节数；**目录 = 项数**。 */
  length: number;
  /** 首簇（相对 alloc_offset）。 */
  cluster: number;
  /** 父目录项号。 */
  parent: number;
  /** ASCII 名（非 ASCII 时是 `\xNN` 转义形式）。 */
  name: string;
  /** 名称原始字节（NUL 截断后）。 */
  nameRaw: Uint8Array;
  /** 该 dirent 在目录项 512 B 里的原始字节（副本）。 */
  raw: Uint8Array;
  /** mode 的 bit15（0x8000）= "已用"。 */
  used: boolean;
  /** 本层的目录判据（见 `modeIsDir` 的长注释）。 */
  isDir: boolean;
  /** 名字是 `.` 或 `..`。 */
  isDot: boolean;
  /** 是否徽章存档目录（`E##` 结尾 或 `EMB` 结尾）。 */
  isEmblemDir: boolean;
}

/** 一次"在目录里新建文件"的结果。 */
export interface CreateFileResult {
  /** 目录名。 */
  dirName: string;
  /** 新文件名。 */
  fileName: string;
  /** 文件字节数（= data.length）。 */
  length: number;
  /** 首簇（相对 alloc_offset）。 */
  firstCluster: number;
  /** 分配到的簇链。 */
  clusters: number[];
  /** 写进哪个槽（项号）。 */
  slot: number;
  /** 为了放下新项而给目录**新增**的簇（空数组 = 目录原本就有空槽）。 */
  dirExtensionClusters: number[];
  /** 改动过的**绝对页号**（用于与 Python 夹具逐页比对）。 */
  touchedPages: number[];
  /** 目录项数是否更新过，以及新旧值。 */
  dirCountUpdate: { mode: 'rootEntry' | 'dotEntry'; old: number; new: number } | null;
}

export interface CreateFileOptions {
  /**
   * 目录自述项数写在哪：
   *   · `'rootEntry'`（默认）= 写在**根目录里该子目录 dirent 的 length** 字段。
   *     ★ 真卡实测：LR 的 `BISLPS-25462EMB` / `BISLPS-25462GAME` 走这条，
   *       其目录自己的 `.` 项 length 恒为 **0**。
   *   · `'dotEntry'` = 写在目录第 0 项（`.`）的 length 字段。
   *   · `'none'` = 不更新（调用方自己管）。
   */
  countLocation?: 'rootEntry' | 'dotEntry' | 'none';
  /** 目录链放不下新项时，允许再分配一个簇（默认 true）。 */
  extendDir?: boolean;
}

// ─────────────────────────── Card ───────────────────────────

/**
 * PS2 记忆卡。**内部只有一个 `Uint8Array` 镜像** —— 读和写都作用于它。
 *
 * 用法（Node / 浏览器都一样）：
 * ```ts
 * const buf = new Uint8Array(await file.arrayBuffer());  // ← 已是一份副本
 * const card = new Card(buf);
 * card.dirents(card.rootdir, card.dirCount(card.rootdir));
 * ```
 */
export class Card {
  /** 整卡镜像（唯一读写来源）。 */
  readonly buf: Uint8Array;
  /** 超块 `page_len`（真卡 512）。 */
  readonly pageLen: number;
  /** 每簇页数（真卡 2）。 */
  readonly ppc: number;
  /** 每块页数（真卡 16）。 */
  readonly ppb: number;
  /** 簇总数（真卡 8192）。 */
  readonly clusters: number;
  /** 数据区相对簇号的起点（alloc_offset，真卡 41）。 */
  readonly allocOffset: number;
  /** 数据区末端（alloc_end，真卡 8135）。 */
  readonly allocEnd: number;
  /** 根目录首簇（相对簇号，真卡 0）。 */
  readonly rootdir: number;
  /** 超块里的 32 个 ifc 项（其中 [0] = 间接 FAT 所在簇，绝对簇号）。 */
  readonly ifc: number[];
  /** 间接 FAT：256 个 FAT 块簇号（绝对簇号），`0xFFFFFFFF` = 无。 */
  readonly ind: number[];
  /** 页数 = size / 528。 */
  readonly npages: number;
  /** 整卡字节数。 */
  readonly size: number;

  constructor(buf: Uint8Array) {
    this.buf = buf;
    this.size = buf.length;
    if (this.size % STRIDE !== 0) {
      throw new Error(`不是 PS2 记忆卡：大小 ${this.size} 不是 ${STRIDE} 的整数倍`);
    }
    this.npages = this.size / STRIDE;

    const sb = this.readPageRaw(0);
    const magic = String.fromCharCode(sb[0], sb[1], sb[2], sb[3]);
    if (magic !== 'Sony') {
      throw new Error(`不是 PS2 记忆卡（超块魔数不符）: ${JSON.stringify(magic)}`);
    }
    this.pageLen = u16le(sb, 0x28);
    this.ppc = u16le(sb, 0x2a);
    this.ppb = u16le(sb, 0x2c);
    this.clusters = u32le(sb, 0x30);
    this.allocOffset = u32le(sb, 0x34);
    this.allocEnd = u32le(sb, 0x38);
    this.rootdir = u32le(sb, 0x3c);
    // ★ 0.19：超块字段必须**自洽**，否则后面每一个"用 0 兜底"的读取都会静默算错。
    //   ⚠ 这是 D18 那一类事故的源头：Python 版在这里会抛（struct.error），JS 版以前只是继续跑。
    if (this.pageLen !== PAGE_SIZE) {
      throw new Error(`不是 PS2 记忆卡（超块 page_len=${this.pageLen}，应为 ${PAGE_SIZE}）`);
    }
    if (!(this.ppc >= 1) || !(this.clusters > 0)) {
      throw new Error(`不是 PS2 记忆卡（超块 ppc=${this.ppc} clusters=${this.clusters}）`);
    }
    if (!(this.allocEnd > this.allocOffset) || this.allocEnd > this.clusters) {
      throw new Error(
        `不是 PS2 记忆卡（超块 alloc_offset=${this.allocOffset} alloc_end=${this.allocEnd} clusters=${this.clusters} 不自洽）`,
      );
    }
    this.ifc = [];
    for (let i = 0; i < 32; i++) this.ifc.push(u32le(sb, 0x50 + i * 4));

    // 间接 FAT：1024 B = 256 × u32（跨 2 页，从绝对簇 ifc[0] 起）
    // ★ 0.19：`sysRead()` 现在读不满就抛（见它自己的注释）⇒ ifc[0] 无效的卡**在构造时就报错**，
    //   而不是把 ind[] 全填 0、之后被 `writeFat` 拿去当"第 0 簇"用（那会把超块写坏）。
    const indRaw = this.sysRead(this.ifc[0], 1024);
    this.ind = [];
    for (let i = 0; i < 256; i++) this.ind.push(u32le(indRaw, i * 4));
  }

  // ── 页级原语（唯一真正碰 `this.buf` 的地方） ──

  /**
   * 读第 `n` 页的 512 B 数据区（**副本**）。
   *
   * ★ 0.19 两处修正（都是"静默出错"）：
   *   ① **越界要抛**，不再返回空数组 —— 原先 `readFile()` 会把空读当成"读到了"，
   *      继续 `got += PAGE_SIZE`，于是给调用方一段**全 0** 的数据（看着像"这张徽章是空的"）；
   *   ② **必须真的是副本**：`this.buf` 若是 Node `Buffer`，`Buffer.prototype.slice`
   *      返回的是**视图**（与 `Uint8Array.prototype.slice` 相反）⇒ 调用方改返回值会改到卡。
   *      这里走 `new Uint8Array(view)` 显式复制，与底层是 Buffer 还是 Uint8Array 无关。
   */
  readPageRaw(n: number): Uint8Array {
    if (!Number.isInteger(n) || n < 0 || n >= this.npages) {
      throw new Error(`读页越界：第 ${n} 页（本卡 0..${this.npages - 1}）`);
    }
    const off = n * STRIDE;
    return new Uint8Array(this.buf.subarray(off, off + PAGE_SIZE));
  }

  /** 读第 `n` 页的 16 B 备用区（**副本** —— 理由同 `readPageRaw`）。 */
  readSpareRaw(n: number): Uint8Array {
    if (!Number.isInteger(n) || n < 0 || n >= this.npages) {
      throw new Error(`读备用区越界：第 ${n} 页（本卡 0..${this.npages - 1}）`);
    }
    const off = n * STRIDE + PAGE_SIZE;
    return new Uint8Array(this.buf.subarray(off, off + SPARE_SIZE));
  }

  /** 写第 `n` 页的 512 B 数据区 + **重算 ECC**（写 16 B 备用区）。 */
  writePageRaw(n: number, page512: Uint8Array): void {
    if (page512.length !== PAGE_SIZE) {
      throw new Error(`页必须正好 ${PAGE_SIZE} B，实为 ${page512.length}`);
    }
    if (!Number.isInteger(n) || n < 0 || n >= this.npages) {
      throw new Error(`页号越界：${n}（本卡 0..${this.npages - 1}）`);
    }
    const off = n * STRIDE;
    this.buf.set(page512, off);
    this.buf.set(pageEcc(page512), off + PAGE_SIZE);
  }

  /** 只写备用区（不重算 ECC）—— 给"故意造坏 ECC"的探针用。 */
  writeSpareRaw(n: number, spare16: Uint8Array): void {
    if (spare16.length !== SPARE_SIZE) {
      throw new Error(`备用区必须正好 ${SPARE_SIZE} B`);
    }
    if (!Number.isInteger(n) || n < 0 || n >= this.npages) {
      throw new Error(`页号越界：${n}（本卡 0..${this.npages - 1}）`);
    }
    this.buf.set(spare16, n * STRIDE + PAGE_SIZE);
  }

  /** 按 ECC 算法校验第 `n` 页，返回是否一致。 */
  eccOk(n: number): boolean {
    return bytesEqual(this.readSpareRaw(n), pageEcc(this.readPageRaw(n)));
  }

  // ── 系统区（绝对簇号） ──

  /** 系统区：绝对簇 `cl` 的第 `k` 页号。 */
  sysPage(cl: number, k = 0): number {
    return cl * this.ppc + k;
  }

  /**
   * 从系统区绝对簇 `cl` 起连续读 `n` 字节（沿簇递增，最多 512 簇）。
   *
   * ★ 0.19：**读不满就抛**。原先它会 `return out.slice(0, got)` 静默返回短缓冲，
   *   而 `u32le()` 越界读又是 0 ⇒ "读不到"被悄悄变成"读到 0"（D18 的根因）。
   *   Python 参考实现在同一处也是抛（`struct.unpack_from` 越界）⇒ 现在两边一致。
   * ⚠ 512 簇是**硬上限**（原先没写在注释里）：正常调用（间接 FAT 1024 B、FAT 块 1024 B）远小于它。
   */
  sysRead(cl: number, n: number): Uint8Array {
    if (!Number.isInteger(cl) || cl < 0) {
      throw new Error(`sysRead: 绝对簇号非法（${cl}）`);
    }
    const out = new Uint8Array(n);
    let got = 0;
    for (let i = 0; i < 512 && got < n; i++) {
      for (let k = 0; k < this.ppc; k++) {
        const p = this.sysPage(cl, k);
        if (p >= this.npages) {
          throw new Error(
            `sysRead: 读不到 —— 绝对簇 ${cl} 的第 ${k} 页 = ${p} 超出本卡 ${this.npages} 页（超块字段可能坏了）`,
          );
        }
        const chunk = this.readPageRaw(p);
        const take = Math.min(PAGE_SIZE, n - got);
        out.set(chunk.subarray(0, take), got);
        got += take;
      }
      cl += 1;
    }
    if (got < n) throw new Error(`sysRead: 只读到 ${got}/${n} 字节（绝对簇 ${cl} 起、512 簇上限）`);
    return out;
  }

  // ── 数据区（相对 alloc_offset） ──

  /** 数据区：相对簇 `rel` 的第 `k` 页号（绝对页号）。 */
  dataPage(rel: number, k = 0): number {
    return (rel + this.allocOffset) * this.ppc + k;
  }

  /**
   * 相对簇 `rel` 是否**整簇**都落在卡镜像里。
   *
   * ★ 0.19 新增（D19）：`clusters`（超块里的簇总数）与"镜像真实存在的页数"并不总是同一件事 ——
   *   真卡上数据区末尾之后还有一段"簇号合法但页不存在"的区间。原先 `readFile()` 对这段
   *   照写不误（`readPageRaw` 返回空数组、`got` 却继续加）⇒ 调用方拿到一段**全 0**。
   *   现在读取路径一律先问这个方法，读不到就停在链上（= Python 的"短缓冲"行为）。
   */
  clusterInImage(rel: number): boolean {
    if (!Number.isInteger(rel) || rel < 0) return false;
    return this.dataPage(rel, this.ppc - 1) < this.npages;
  }

  /** 读数据页（512 B）。 */
  readDataPage(rel: number, k = 0): Uint8Array {
    return this.readPageRaw(this.dataPage(rel, k));
  }

  /** 写数据页（512 B，**重算 ECC**）。 */
  writeDataPage(rel: number, k: number, page512: Uint8Array): void {
    this.writePageRaw(this.dataPage(rel, k), page512);
  }

  // ── FAT ──

  /**
   * FAT 块所在簇号的自检。
   *
   * ★ 0.19 新增（D18）：`ind[]` 里除 `0xFFFFFFFF`（= 该块不存在，合法）以外的值
   *   都必须是**真实存在的簇**。原先只查"是不是 undefined/0xFFFFFFFF"，
   *   于是 `fc = 0`（例如超块 ifc[0] 坏掉、`ind[]` 被填成 0）会被当成合法 FAT 块
   *   ⇒ `sysPage(0,0) = 0` = **超块自己**，`writeFat()` 一写就把 "Sony" 魔数毁掉。
   *   `fc >= 1` 排除簇 0（它是超块/保留区，从不是 FAT 块）。
   */
  private checkFatCluster(fc: number, blk: number): void {
    if (fc === INVALID_CLUSTER) return; // 该 FAT 块不存在（合法）
    if (!Number.isInteger(fc) || fc < 1) {
      throw new Error(`FAT 块 ${blk} 的簇号非法：${fc}（0 是超块/保留区，不可能是 FAT 块）—— 超块可能损坏`);
    }
    if (this.sysPage(fc, this.ppc - 1) >= this.npages) {
      throw new Error(`FAT 块 ${blk} 的簇 ${fc} 超出本卡（${this.npages} 页）—— 超块可能损坏`);
    }
  }

  /**
   * 读一个 FAT 项（相对簇号 `rel`）。
   *
   * 布局：每 256 个簇一个 FAT 块（1024 B），块号 `rel // 256`，
   *       块内字节偏移 `(rel % 256) * 4`；块所在簇号从 `ind[]` 查。
   * 越界（`rel >= clusters`）或该块不存在 ⇒ `0xFFFFFFFF`。
   */
  readFat(rel: number): number {
    if (!Number.isInteger(rel) || rel < 0) {
      throw new Error(`readFat: 相对簇号非法（${rel}）`);
    }
    if (rel >= this.clusters) return INVALID_CLUSTER;
    const blk = Math.floor(rel / 256);
    const off = (rel % 256) * 4;
    const fc = this.ind[blk];
    if (fc === undefined || fc === INVALID_CLUSTER) return INVALID_CLUSTER;
    this.checkFatCluster(fc, blk);
    return u32le(this.sysRead(fc, 1024), off);
  }

  /**
   * 写一个 FAT 项。**读和写都走 `this.buf`（同一个镜像）** —— 见文件头那个坑。
   *
   * 逐行对应 `65_us2jp.py::Writable.set_fat`：
   *   blk, off = rel // 256, (rel % 256) * 4
   *   fc = self.ind[blk]
   *   p0 = sys_page(fc, 0)
   *   raw = _rd_page(p0) + _rd_page(p0+1)     # ← 从**同一个**镜像读
   *   pack_into('<I', raw, off, value)
   *   _wr_page(p0, raw[:512]); _wr_page(p0+1, raw[512:])
   */
  writeFat(rel: number, value: number): void {
    if (!Number.isInteger(rel) || rel < 0) {
      throw new Error(`writeFat: 相对簇号非法（${rel}）`);
    }
    if (rel >= this.clusters) {
      throw new Error(`FAT 项越界：rel=${rel} >= clusters=${this.clusters}`);
    }
    const blk = Math.floor(rel / 256);
    const off = (rel % 256) * 4;
    const fc = this.ind[blk];
    if (fc === undefined || fc === INVALID_CLUSTER) {
      throw new Error(`FAT 块 ${blk} 不存在（ind[${blk}] = ${fc}）`);
    }
    this.checkFatCluster(fc, blk);
    const p0 = this.sysPage(fc, 0);
    if (p0 + 1 >= this.npages) {
      throw new Error(`FAT 块 ${blk} 的页号越界：${p0}..${p0 + 1}（本卡 ${this.npages} 页）`);
    }
    const raw = new Uint8Array(1024);
    raw.set(this.readPageRaw(p0), 0);
    raw.set(this.readPageRaw(p0 + 1), 512);
    setU32le(raw, off, value >>> 0);
    this.writePageRaw(p0, raw.subarray(0, 512));
    this.writePageRaw(p0 + 1, raw.subarray(512, 1024));
  }

  /**
   * 簇链遍历：从 `first` 起，沿 FAT 走到链尾。
   *
   * 逐行对应 `61_mc_survey.py::Card.chain`：
   *   while cl not in (LAST, 0xFFFFFFFF) and cl < clusters and len(out) < maxn:
   *       out.append(cl)
   *       nxt = fat(cl) & 0x7FFFFFFF
   *       if nxt in out: break          // ★ 防环
   *       cl = nxt
   *
   * ★ 两条边界语义（测试里专门覆盖）：
   *   1. **跨 FAT 块**：`fat()` 按 `rel // 256` 选块，链跨过 256 的倍数时块号会变
   *      （真卡上 `ind[]` 是**不连续**的 9,10,…,40 ⇒ 必须每次重新查 `ind[]`，不能假定连续）。
   *   2. **最后一簇**：`rel < clusters` 是硬边界；`clusters` 之后一律视为不可达，
   *      即使 FAT 里写着别的值。
   */
  chain(first: number, maxn = 8192): number[] {
    if (!Number.isInteger(first) || first < 0) {
      // ★ 0.19：负数/小数簇号原先会被走成 `[-1]`（`dataPage(-1)` 还能落到一张**真实无关的页**上）。
      throw new Error(`chain: 起始簇号非法（${first}）`);
    }
    const out: number[] = [];
    const seen = new Set<number>();
    let cl = first;
    while (
      cl !== FAT_END &&
      cl !== INVALID_CLUSTER &&
      cl < this.clusters &&
      out.length < maxn
    ) {
      out.push(cl);
      seen.add(cl);
      const nxt = this.readFat(cl) & FAT_MASK;
      if (seen.has(nxt)) break; // 防环
      cl = nxt;
    }
    return out;
  }

  /**
   * 按 dirent 声明的首簇 + 长度读文件。
   *
   * ★ 偏移语义（与 Python 完全一致）：数据是**簇对齐**的，`n` 只是最终截断长度，
   *   即"读满整条链、最后 `slice(0, n)`"。`n === 0` ⇒ 空数组（不读任何页）。
   *   链比 `n` 短时返回的就是实际能读到的长度（**不补零**）—— 保持原版行为。
   */
  readFile(first: number, n: number): Uint8Array {
    if (n <= 0) return new Uint8Array(0);
    const chain = this.chain(first, Math.floor(n / 1024) + 16);
    const total = chain.length * this.ppc * PAGE_SIZE;
    const raw = new Uint8Array(total);
    let got = 0;
    for (const cl of chain) {
      if (!this.clusterInImage(cl)) break; // ★ 图外簇：停在这里（返回短缓冲，不补零）
      for (let k = 0; k < this.ppc; k++) {
        raw.set(this.readDataPage(cl, k), got);
        got += PAGE_SIZE;
      }
    }
    return raw.slice(0, Math.min(n, got));
  }

  /** 把一个文件写进给定的簇链（簇不够时按数据长度补零），返回实际写了的页号。 */
  writeFileIntoClusters(clusters: number[], data: Uint8Array): number[] {
    const clen = this.ppc * PAGE_SIZE;
    if (data.length > clusters.length * clen) {
      // ★ 0.19：原先**静默截断**（文档只提了"不够时补零"）。写卡路径宁可报错也不要写半个文件。
      throw new Error(
        `writeFileIntoClusters: ${data.length} 字节装不进 ${clusters.length} 簇（${clusters.length * clen} 字节）`,
      );
    }
    const pages: number[] = [];
    for (let i = 0; i < clusters.length; i++) {
      const chunk = new Uint8Array(clen);
      const src = data.subarray(i * clen, Math.min((i + 1) * clen, data.length));
      chunk.set(src, 0);
      for (let k = 0; k < this.ppc; k++) {
        const rel = clusters[i];
        this.writeDataPage(rel, k, chunk.subarray(k * PAGE_SIZE, (k + 1) * PAGE_SIZE));
        pages.push(this.dataPage(rel, k));
      }
    }
    return pages;
  }

  /** 写一条簇链的 FAT：中间 `0x80000000 | next`，末簇 `0x80000000 | 0x7FFFFFFF`。 */
  writeFatChain(clusters: number[]): void {
    for (let i = 0; i < clusters.length; i++) {
      const last = i === clusters.length - 1;
      // 0x80000000 | x 在 JS 里会变成负 int32 ⇒ 用 >>> 0 归一到无符号
      this.writeFat(clusters[i], (0x80000000 | (last ? FAT_END : clusters[i + 1])) >>> 0);
    }
  }

  // ── 目录项 ──

  /**
   * 读 `count` 个目录项。
   *
   * 逐行对应 `61_mc_survey.py::Card.dirents`：
   *   · 目录 = count 个 512 B 项，**沿 FAT 链跨簇连续排布** ⇒ 必须按 `count*512` 读完整条链，
   *     不能只读一簇（真卡根目录 11 项 = 3 个簇）。
   *   · 空槽（mode == 0xFFFFFFFF）跳过，**但 `index` 保留原位号**（调用方靠 index 定位槽）。
   *   · "已用" = **bit15 (0x8000)**，不是 bit31。⚠️ Python 里 `mode & 0x8000 == 0` 有优先级坑，
   *     原版靠加括号绕过；TS 里 `&` 优先级低于 `===`，同样必须加括号。
   */
  dirents(first: number, count: number): Dirent[] {
    const need = count * PAGE_SIZE;
    if (need <= 0) return [];
    const chain = this.chain(first, Math.floor(need / 1024) + 16);
    const raw = new Uint8Array(chain.length * this.ppc * PAGE_SIZE);
    let got = 0;
    for (const cl of chain) {
      if (!this.clusterInImage(cl)) break; // ★ 图外簇 ⇒ 停（下面 `(i+1)*PAGE_SIZE > raw.length` 会收尾）
      for (let k = 0; k < this.ppc; k++) {
        raw.set(this.readDataPage(cl, k), got);
        got += PAGE_SIZE;
      }
    }
    const out: Dirent[] = [];
    for (let i = 0; i < count; i++) {
      if ((i + 1) * PAGE_SIZE > raw.length) break; // 链不够长
      const e = raw.slice(i * PAGE_SIZE, (i + 1) * PAGE_SIZE);
      const mode = u32le(e, DIRENT_MODE);
      if (mode === DIRENT_EMPTY_MODE) continue; // 空槽
      if ((mode & 0x8000) === 0) continue; // ★ 括号不能省
      const { name, nameRaw } = decodeName(e.subarray(DIRENT_NAME, DIRENT_NAME + DIRENT_NAME_MAX));
      const isDot = name === '.' || name === '..';
      out.push({
        index: i,
        mode,
        length: u32le(e, DIRENT_LENGTH),
        cluster: u32le(e, DIRENT_CLUSTER),
        parent: u32le(e, DIRENT_PARENT),
        name,
        nameRaw,
        raw: e,
        used: true,
        isDir: modeIsDir(mode),
        isDot,
        isEmblemDir: !isDot && isEmblemArchiveDirName(name),
      });
    }
    return out;
  }

  /**
   * 目录的"自述项数"：读它第 0 项（`.`）的 length。
   *
   * ⚠️ 真卡上**子目录**的 `.` 项 length 恒为 **0**，项数实际记在**根目录里那个 dirent** 的
   *    length 上（见文档 `01-项目理解\04-记忆卡与存档处理.md` 坑 #3）。
   *    所以 `dirCount()` 只对**根目录**可信；子目录请用其父目录条目的 `length`。
   */
  dirCount(first: number): number {
    const cl = this.chain(first, 4);
    if (cl.length === 0) return 0;
    const raw = this.readDataPage(cl[0], 0);
    return u32le(raw, 4);
  }

  /** 根目录项列表（项数取自根目录 `.` 项）。 */
  listRoot(): Dirent[] {
    return this.dirents(this.rootdir, this.dirCount(this.rootdir));
  }

  /** 在根目录里按名字找一项（不含 `.` / `..`）。 */
  findInRoot(name: string): Dirent | null {
    for (const e of this.listRoot()) {
      if (e.isDot) continue;
      if (e.name === name) return e;
    }
    return null;
  }

  /**
   * 按目录名列出其内容。
   * 项数优先用**根目录条目声明的 length**（真卡口径）；取不到时退回 `.` 项的 length。
   */
  listDir(name: string): Dirent[] {
    const e = this.findInRoot(name);
    if (!e) return [];
    const count = e.length > 0 ? e.length : this.dirCount(e.cluster);
    return this.dirents(e.cluster, count);
  }

  /**
   * 识别"徽章存档目录"。
   *
   * ★★ **不能**用 `mode & 0x2000` 判目录（`dump_card_emblems.py` 的实测注释）：
   *    本卡目录 = `0x8427`、文件 = `0x8497` —— 判据是名字最稳。
   *    `E##` 结尾（SL / NX / NB 的 `BISLPS-25169E00` 之类）
   *    或 `EMB` 结尾（LR 的单个 `BISLPS-25462EMB`，内含 `data0..7`）。
   *
   * ★ 0.19：`emblemDirs()` 那个便捷包装删掉了（只有测试在用）——
   *   调用方直接 `listRoot().filter((e) => e.isEmblemDir)`，判据仍在 `Dirent.isEmblemDir` 上。
   */

  // ── 分配 ──

  /**
   * 收集"已占用"的相对簇集合。
   *
   * ★★ 必须包含三类（`65_us2jp.py` 第一步踩过的坑：只标"文件链"会把**目录自己的簇**
   *    当空闲 ⇒ 写数据时**覆盖根目录**）：
   *      1. 根目录自己的簇链
   *      2. 每个子目录自己的簇链 + 其下每个文件的簇链
   *      3. **系统区**：间接 FAT 所在簇 `ifc[0]` + 每个 FAT 块所在簇 `ind[]`
   *    （3 是绝对簇号，但真卡上 `alloc_offset` 之后的相对号与绝对号有固定偏移，
   *      而分配器扫的是相对号区间 `[aoff+2, aend-4)` ⇒ 把绝对号也塞进同一个集合，
   *      与 Python 原版**逐字节等价**，且只会让分配更保守。）
   */
  collectUsedClusters(): Set<number> {
    const used = new Set<number>();
    const mark = (first: number): void => {
      for (const cl of this.chain(first, 4096)) used.add(cl);
    };
    used.add(this.ifc[0]); // 间接 FAT（绝对簇号）
    for (const fc of this.ind) {
      if (fc !== INVALID_CLUSTER) used.add(fc); // 各 FAT 块（绝对簇号）
    }
    mark(this.rootdir); // ★ 根目录自己
    for (const e of this.listRoot()) {
      if (e.isDot) continue;
      mark(e.cluster); // 子目录自己
      const count = e.length > 0 ? e.length : 0;
      if (count <= 0) continue;
      for (const s of this.dirents(e.cluster, count)) {
        if (s.isDot || !s.length || !s.cluster) continue;
        mark(s.cluster); // 文件链
      }
    }
    return used;
  }

  /**
   * 分配 `n` 个空闲簇（返回**连续**的相对簇号）。
   *
   * 逐行对应 `write_data2_inverted.py` / `65_us2jp.py` 的分配循环：
   *   cur = aoff + 2
   *   while len(got) < n:
   *       if cur >= aend - 4: 空间不足
   *       if cur in used: cur += 1; continue
   *       got.append(cur); used.add(cur); cur += 1
   *
   * ★ `aoff + 2` 的起点是**参考实现的选择**（真卡上 `aoff+0` / `aoff+1` 属保留区），
   *   本移植**原样保留**——换成"找最小空闲簇"会让结果与已验证的实机卡不一致。
   */
  allocateClusters(n: number, used?: Set<number>): number[] {
    if (!Number.isInteger(n) || n < 1) {
      // ★ 0.19：`n` 原先只受 `cur >= allocEnd - 4` 约束 ⇒ 直接调这个 API 传个天文数字
      //   会真的去 push 那么多个元素（OOM/卡死）。卡容量在这里就是硬上限。
      throw new Error(`allocateClusters: 簇数必须是正整数（收到 ${n}）`);
    }
    if (n > this.clusters) {
      throw new Error(`allocateClusters: 要 ${n} 簇，超过本卡总簇数 ${this.clusters}`);
    }
    const u = used ?? this.collectUsedClusters();
    const got: number[] = [];
    let cur = this.allocOffset + 2;
    while (got.length < n) {
      if (cur >= this.allocEnd - 4) {
        throw new Error(`卡上空间不足：已分配 ${got.length} / 需要 ${n} 簇`);
      }
      if (u.has(cur)) {
        cur += 1;
        continue;
      }
      got.push(cur);
      u.add(cur);
      cur += 1;
    }
    return got;
  }

  /**
   * 在目录链里找第一个空槽，返回项号；没有则 `-1`。
   *
   * ★ **空槽判据 = `mode === 0xFFFFFFFF`（整项 FF）** ——
   *   **绝不能**写成 `(mode & 0x8000) === 0`：`0xFFFFFFFF` 的 **bit15 = 1**，
   *   那个式子会把"空槽"判成"已用"，于是永远找不到空槽（然后去扩目录、
   *   甚至覆盖同簇的另一页）。真卡依据：`BISLPS-25462GAME` 第 10 槽
   *   （绝对页 1557）整页 FF、mode=0xFFFFFFFF；而 `.` / `..` / `data0` 等
   *   有效项的 mode 都带 bit15。
   *
   * ★ 扫描顺序：**先扫 `[0, count)`（声明项数范围内），再扫 `[count, 槽数)`**。
   *   后一段是有意为之 —— 真卡的声明项数会**滞后**（实测 `BISLPS-25462EMB`
   *   曾"声明 6 项、里面已有 7 项"），不扫的话会把已存在的项覆盖掉。
   *   副作用：对 `BISLPS-25462GAME`（声明 9 项 / 链 10 槽）调 `findFreeSlot(chain, 9)`
   *   返回的是 **9（未声明的那个空槽）**，不是 -1 —— 复用它是安全且正确的。
   */
  findFreeSlot(first: number, count: number): number {
    const chain = this.chain(first, 4096);
    const slots = chain.length * this.ppc;
    const raw = new Uint8Array(slots * PAGE_SIZE);
    let got = 0;
    for (const cl of chain) {
      if (!this.clusterInImage(cl)) break; // ★ 图外簇 ⇒ 停
      for (let k = 0; k < this.ppc; k++) {
        raw.set(this.readDataPage(cl, k), got);
        got += PAGE_SIZE;
      }
    }
    const limit = Math.min(slots, Math.max(count, 0));
    for (let i = 0; i < limit; i++) {
      if (u32le(raw, i * PAGE_SIZE) === DIRENT_EMPTY_MODE) return i;
    }
    // 声明项数之后可能还有未声明的空槽（真卡会滞后）——继续往后找
    for (let i = limit; i < slots; i++) {
      if (u32le(raw, i * PAGE_SIZE) === DIRENT_EMPTY_MODE) return i;
    }
    return -1;
  }

  /** 把一条 512 B dirent 写进目录的某个槽（**数据 + 备用区一起写，重算 ECC**）。 */
  writeDirent(dirFirst: number, slot: number, entry512: Uint8Array): number {
    if (entry512.length !== PAGE_SIZE) throw new Error('dirent 必须 512 B');
    const chain = this.chain(dirFirst, 4096);
    const ci = Math.floor(slot / this.ppc);
    if (ci >= chain.length) throw new Error(`槽 ${slot} 超出目录链（${chain.length} 簇）`);
    const k = slot % this.ppc;
    const page = this.dataPage(chain[ci], k);
    this.writePageRaw(page, entry512);
    return page;
  }

  /**
   * 一条"空 dirent"的 512 B = **整页 `0xFF`**（mode / length / cluster / parent / 名字全 FF）。
   *
   * ★ 真卡实测（`out\evidence\Mcd001_embdata2.ps2` 的 `BISLPS-25462GAME` 第 10 槽，
   *   链 `[465,466,516,680,737]` 的 cl=737 / k=1，绝对页 **1557**）：
   *   空槽**不是**"从没写过的原始页"，而是**被显式写过的整页 FF** ——
   *   它的 16 B 备用区是**算好的 ECC**（`77 7f 7f 77 7f 7f 77 7f 7f 77 7f 7f 00 00 00 00`
   *   = `pageEcc(FF×512)`），而**不是**未写入态的 `FF × 16`。
   *   ⇒ 铺一个新槽/扩目录簇时，必须连备用区一起写（走 `writePageRaw` 会自动重算 ECC）。
   *   只写 512 B 数据区（例如 `buf.set(data, off)`）会留下 `FF×16` 的备用区，
   *   `eccOk()` 就会报坏页 —— 这正是本层第一版扩目录时的缺陷。
   */
  emptyDirent(): Uint8Array {
    return new Uint8Array(PAGE_SIZE).fill(0xff);
  }

  /** 把一条 dirent 写进目录的某个槽，并用它**铺满它所在簇的另一页**（真卡口径：空槽 = FF+ECC）。 */
  writeDirentIntoSlot(dirFirst: number, slot: number, entry512: Uint8Array): number {
    const page = this.writeDirent(dirFirst, slot, entry512);
    const otherK = 1 - (slot % this.ppc);
    const other = this.dataPage(
      this.chain(dirFirst, 4096)[Math.floor(slot / this.ppc)],
      otherK,
    );
    // 只在"另一页确实是空槽"时才铺 —— 否则会覆盖同簇的另一个有效项
    if (u32le(this.readPageRaw(other), 0) === DIRENT_EMPTY_MODE) {
      this.writePageRaw(other, this.emptyDirent());
    }
    return page;
  }

  /** 只改 dirent 的 length 字段（保持其余字节不动），返回页号。 */
  setDirentLength(dirFirst: number, slot: number, length: number): number {
    const chain = this.chain(dirFirst, 4096);
    const ci = Math.floor(slot / this.ppc);
    if (ci >= chain.length) throw new Error(`槽 ${slot} 超出目录链`);
    const k = slot % this.ppc;
    const page = this.dataPage(chain[ci], k);
    const raw = this.readPageRaw(page);
    setU32le(raw, DIRENT_LENGTH, length >>> 0);
    this.writePageRaw(page, raw);
    return page;
  }

  /**
   * 构造一条新 dirent 的 512 B 字节。
   *
   * 与真卡 layout 的关系：
   *   · mode / length / cluster / parent 写死为给定值；
   *   · 名称区 32 B 完全由 `encodeName()` 决定（名 + `00` + 补 `00`）—— 与真卡一致；
   *   · **其余字节（含 8 B 创建/修改时间）保持 `0xFF`** —— 这是"空槽 + 只填必需字段"的
   *     保守写法（真卡上是合法 BCD 时间）。`createFileInDir` 默认走 `cloneDirent()`，
   *     所以时间戳会**继承自模板文件**；本函数只作为没有模板时的兜底。
   */
  makeDirent(opts: {
    name: string;
    cluster: number;
    length: number;
    mode?: number;
    parent?: number;
  }): Uint8Array {
    const e = new Uint8Array(PAGE_SIZE).fill(0xff);
    setU32le(e, DIRENT_MODE, (opts.mode ?? MODE_FILE) >>> 0);
    setU32le(e, DIRENT_LENGTH, opts.length >>> 0);
    setU32le(e, DIRENT_CLUSTER, opts.cluster >>> 0);
    setU32le(e, DIRENT_PARENT, (opts.parent ?? 1) >>> 0);
    e.set(encodeName(opts.name), DIRENT_NAME);
    return e;
  }

  /**
   * 克隆一条已存在的 dirent，只改首簇 + 长度 + 名字。
   *
   * ★ 这是 `write_data2_inverted.py` 第 6 步的做法（实机验证过）：
   *   直接拷 `data0` 的整项、改 `cluster` / `name`，**时间戳等字段原样继承**。
   *   好处是"创建时间 / 修改时间"这种我们不打算复刻的字段自动合法。
   *
   * ★ 名称字段的**确切写法**来自真卡实测（`Mcd001_embdata2.ps2` 的 EMB 目录逐项 dump）：
   *   名称区 32 B = ASCII 名 + `00` + 一串 `00`（**不是 FF**）。
   *   例：`data0` ⇒ `64 61 74 61 30 00 00 …00`。
   *   所以克隆时把整块 32 B 名称区**覆盖成 `encodeName()` 的 32 B**（其余字段整项继承）。
   *   ⚠️ 这里**不能**先 `fill(0xff)` 再只覆盖 `name.length+1` 个字节 ——
   *      那会把"名字之后的填充"留成 FF，与真卡不符（第一版就踩了这个）。
   */
  cloneDirent(src: Dirent, newName: string, newCluster: number, newLength?: number): Uint8Array {
    const e = src.raw.slice();
    setU32le(e, DIRENT_CLUSTER, newCluster >>> 0);
    if (newLength !== undefined) setU32le(e, DIRENT_LENGTH, newLength >>> 0);
    e.set(encodeName(newName), DIRENT_NAME);
    return e;
  }

  // ── 高层：在目录里新建一个文件 ──

  /**
   * ★ 在 `dirName` 目录里新建 `fileName`，内容 `data`。**五步**，逐条对应
   *   `write_data2_inverted.py`（那张卡实机验证通过）：
   *
   *   1. **分配簇**：`allocateClusters(ncl)`（占用集合含系统区 + 目录链 + 文件链）
   *   2. **写数据**：逐簇写、每页**重算 ECC**（`writeFileIntoClusters`）
   *   3. **写 FAT 链**：`0x80000000 | next`，末簇 `0x80000000 | 0x7FFFFFFF`（`writeFatChain`）
   *   4. **写 dirent**：克隆同目录下的一条已有文件 dirent（改名 + 改首簇 + 改长度），
   *      写进目录的**空槽**（`writeDirentIntoSlot`：数据 + 备用区一起写、重算 ECC）
   *   5. **更新项数**：`BISLPS-25462EMB` / `BISLPS-25462GAME` 这类目录的项数记在
   *      **根目录里那个 dirent 的 length** 上（目录自己的 `.` 项 length 恒为 0）
   *      ⇒ 默认写 `rootEntry`（见 `CreateFileOptions.countLocation`）。
   *
   *   ★ 空槽怎么找 —— 两条路径，两条都在真卡上有实测依据：
   *
   *   | 情形 | 真卡例子 | 处理 |
   *   |---|---|---|
   *   | **链内有空槽** | `BISLPS-25462GAME`：声明 9 项 / 链 5 簇 = **10 槽** / 第 10 槽是 FF | **复用**该槽（本次实测：绝对页 1557）；`dirExtensionClusters` 为空 |
   *   | **链内全满** | `BISLPS-25462EMB`：声明 8 项 / 链 4 簇 = **8 槽** / 全满 | **扩 1 簇**接进链尾；该簇**两页都初始化**（第 0 页 = 新 dirent，第 1 页 = 整页 FF 空 dirent + 正确 ECC） |
   *
   *   ⚠️ 扩簇时**不能只写第 0 页**：真卡上空槽的形态是"整页 FF **且备用区是算好的 ECC**"
   *      （`pageEcc(FF×512)`），不是"从没写过的 `FF×16` 未写入态"。
   *      只写数据不写备用区 ⇒ `eccOk()` 报坏页，与真卡不符。
   *
   *   返回：改了哪些页、分配了哪些簇、项数改成了什么。
   */
  createFileInDir(
    dirName: string,
    fileName: string,
    data: Uint8Array,
    opts: CreateFileOptions = {},
  ): CreateFileResult {
    const countLocation = opts.countLocation ?? 'rootEntry';
    const extendDir = opts.extendDir ?? true;

    const dirEnt = this.findInRoot(dirName);
    if (!dirEnt) throw new Error(`根目录里没有目录 ${dirName}`);
    const dirFirst = dirEnt.cluster;
    let dirCount = dirEnt.length;
    if (dirCount <= 0) dirCount = this.dirCount(dirFirst);

    // 重名保护
    for (const s of this.dirents(dirFirst, Math.max(dirCount, 1))) {
      if (!s.isDot && s.name === fileName) {
        throw new Error(`${dirName} 里已经有 ${fileName}，拒绝覆盖`);
      }
    }

    const touched: number[] = [];

    // ---- 1) 分配数据簇 ----
    const used = this.collectUsedClusters();
    const ncl = Math.max(1, Math.ceil(data.length / (this.ppc * PAGE_SIZE)));
    const clusters = this.allocateClusters(ncl, used);

    // ---- 2) 写数据（每页重算 ECC） ----
    touched.push(...this.writeFileIntoClusters(clusters, data));

    // ---- 3) 写 FAT 链 ----
    for (const cl of clusters) touched.push(...this.fatPages(cl));
    this.writeFatChain(clusters);

    // ---- 4) 找空槽；没有就扩目录 ----
    //
    // ★ 两条路径（都在真卡上有依据）：
    //   ① **链内有空槽**（真卡 `BISLPS-25462GAME`：声明 9 项 / 链 10 槽 / 第 10 槽是 FF 空槽）
    //      ⇒ 直接复用那个槽，`dirExtensionClusters` 保持空 —— **不扩簇**。
    //   ② **链内全满**（真卡 `BISLPS-25462EMB`：声明 8 项 / 链 8 槽）
    //      ⇒ 再分配 1 簇、接进目录 FAT 链尾，并**把这个新簇的两页都初始化**：
    //         第 0 页 = 新 dirent；第 1 页 = **整页 FF 空 dirent + 算好的 ECC**。
    //      ⚠️ 第一版只写了第 0 页，留下"原始未写入态"的第 1 页（数据 FF… + 备用 FF×16）
    //         ⇒ `eccOk()` 报坏页，与真卡"空槽 = 整页 FF + 正确 ECC"的形态不符。
    //         真卡依据：`Mcd001_embdata2.ps2` 的 `BISLPS-25462GAME` 空槽（绝对页 1557）
    //         备用区 = `77 7f 7f 77 7f 7f 77 7f 7f 77 7f 7f 00 00 00 00` = `pageEcc(FF×512)`。
    const dirExtensionClusters: number[] = [];
    let slot = this.findFreeSlot(dirFirst, dirCount);
    if (slot < 0) {
      if (!extendDir) throw new Error(`${dirName} 没有空槽（需要扩目录）`);
      const newCl = this.allocateClusters(1, used)[0];
      dirExtensionClusters.push(newCl);
      // 目录链尾 → 新簇；新簇 = 链尾
      const dirChain = this.chain(dirFirst, 4096);
      const tail = dirChain[dirChain.length - 1];
      touched.push(...this.fatPages(tail));
      touched.push(...this.fatPages(newCl));
      this.writeFat(tail, (0x80000000 | newCl) >>> 0);
      this.writeFat(newCl, (0x80000000 | FAT_END) >>> 0);
      // 新簇的第 0 页稍后放新 dirent；先把**两页都**写成"空槽"形态（整页 FF + 正确 ECC）
      touched.push(this.dataPage(newCl, 0), this.dataPage(newCl, 1));
      this.writePageRaw(this.dataPage(newCl, 0), this.emptyDirent());
      this.writePageRaw(this.dataPage(newCl, 1), this.emptyDirent());
      slot = dirChain.length * this.ppc; // 新簇的第 0 页
    }

    // 克隆一条同目录下、有内容的文件 dirent（时间戳等字段随之合法）
    let template: Dirent | null = null;
    for (const s of this.dirents(dirFirst, Math.max(dirCount, 1))) {
      if (!s.isDot && s.length > 0 && s.cluster > 0) {
        template = s;
        break;
      }
    }
    const entry = template
      ? this.cloneDirent(template, fileName, clusters[0], data.length)
      : this.makeDirent({ name: fileName, cluster: clusters[0], length: data.length });
    // 写入新 dirent 所在页（数据 + 备用区一起写，重算 ECC）；若同簇另一页是空槽，顺手铺好
    touched.push(this.writeDirentIntoSlot(dirFirst, slot, entry));

    // ---- 5) 更新项数 ----
    let dirCountUpdate: CreateFileResult['dirCountUpdate'] = null;
    if (countLocation === 'rootEntry') {
      const newCount = Math.max(dirCount, slot + 1);
      const page = this.setDirentLength(this.rootdir, dirEnt.index, newCount);
      touched.push(page);
      dirCountUpdate = { mode: 'rootEntry', old: dirCount, new: newCount };
    } else if (countLocation === 'dotEntry') {
      const newCount = Math.max(dirCount, slot + 1);
      const page = this.setDirentLength(dirFirst, 0, newCount);
      touched.push(page);
      dirCountUpdate = { mode: 'dotEntry', old: dirCount, new: newCount };
    }

    return {
      dirName,
      fileName,
      length: data.length,
      firstCluster: clusters[0],
      clusters,
      slot,
      dirExtensionClusters,
      touchedPages: [...new Set(touched)].sort((a, b) => a - b),
      dirCountUpdate,
    };
  }

  /** 某个 FAT 项可能落在哪几页（2 页 = 一个 1024 B FAT 块）。 */
  private fatPages(rel: number): number[] {
    const blk = Math.floor(rel / 256);
    const fc = this.ind[blk];
    if (fc === undefined || fc === INVALID_CLUSTER) return [];
    const p0 = this.sysPage(fc, 0);
    const out = [p0];
    if (p0 + 1 < this.npages) out.push(p0 + 1);
    return out;
  }
}

// ─────────────────────────── 判据辅助 ───────────────────────────

/**
 * ★★ mode 的位语义 —— 本层最需要写清楚的一处，因为**上游两处自相矛盾**：
 *
 * | 来源 | 说法 |
 * |---|---|
 * | `61_mc_survey.py::dirents` | `is_dir = bool(mode & 0x2000)` |
 * | `_selftest\dump_card_emblems.py` 注释 | "**不能**用 `mode & 0x2000` 判目录 —— 目录 `0x8427`、文件 `0x8497`，**两位都一样**" |
 *
 * 拿 4 张证据卡里**全部 214 个 dirent** 逐个 dump 穷举，真卡上只有**三种** mode 形态：
 *
 * ```
 *   0x8427  123 个  目录   (' . ' / ' .. ' / 全部 B* 存档目录)
 *   0x8497   87 个  普通文件 (data0 / icon.sys / *.ICO / 32B 同名头)
 *   0xA426    4 个  **只出现在根目录里的 "." 项**（每张卡恰好 1 个）
 * ```
 *
 * 位掩码：
 * ```
 *   0x8427 = 0x0001 | 0x0002 | 0x0004 | 0x0020 | 0x0400 | 0x8000
 *   0x8497 = 0x0001 | 0x0002 | 0x0004 | 0x0010 | 0x0080 | 0x0400 | 0x8000
 *   0xA426 = 0x0002 | 0x0004 | 0x0020 | 0x0400 | 0x2000 | 0x8000
 * ```
 *
 * 由此得到三条**穷举无例外**的判据：
 * 1. **bit15（0x8000）= "已用"** —— 214/214 全为 1。⚠️ **不是 bit31**（真卡上 bit31 恒为 0）。
 * 2. **bit7（0x80）= "是文件"** —— 87 个文件全置位、127 个目录项全不置位 ⇒ **100% 分离**。
 *    这是真卡上唯一的"文件 / 目录"判据位。
 * 3. **bit13（0x2000）不是"目录"位** —— 123 个目录项里只有那 **4 个根目录的 `.` 项** 置位，
 *    普通目录项（`BISLPS-25462EMB` 自己的 dirent）bit13 = 0。
 *    ⇒ `61_mc_survey.py` 的 `mode & 0x2000` 只是**恰好**对"根目录的 '.' 项"为真，
 *      既不是"目录"判据，也不是"父目录"判据（`..` 项 0xA426 也置位，但它不是文件）。
 *
 * `dump_card_emblems.py` 那句"两位都一样"是**说反了**：0x8427 ^ 0x8497 = **0x00B0**，
 * 差异其实有两处（bit7 与 bit4），而不是零处。
 *
 * 本层的处理（安全优先）：
 *   · `modeIsDir(mode)` 用 **bit7 的反** —— 真卡上 100% 分得开；
 *   · 但"找徽章目录"这类**业务判据一律走名字**（`isEmblemArchiveDirName`，`E##` / `EMB`），
 *     不依赖任何位语义 —— 这也是上游文档"按名字选最稳"的结论。
 */
export function modeIsDir(mode: number): boolean {
  if ((mode & 0x8000) === 0) return false; // 未使用项
  return (mode & 0x80) === 0; // bit7 = "是文件" ⇒ 取反就是目录
}

/** `E##` 结尾（SL / NX / NB 的徽章槽目录）或 `EMB` 结尾（LR 的徽章目录）。 */
export function isEmblemArchiveDirName(name: string): boolean {
  if (/E\d\d$/.test(name)) return true;
  return name.endsWith('EMB');
}

// ─────────────────────────── 入口 ───────────────────────────

/**
 * 从整卡字节建 `Card`。
 *
 * ★ **核心层不依赖 `node:fs`**：Node 里调用方自己 `fs.readFileSync(path)` 取 `Buffer`，
 *   浏览器里用 `<input type=file>` / 拖拽拿 `File` ⇒ `new Uint8Array(await f.arrayBuffer())`。
 *
 * `copy = true`（默认）会先复制一份 —— **写卡时务必保持默认**，
 * 这样写坏也只坏在内存副本上，源文件/源字节不受影响。
 *
 * ★★ 0.19 修掉的坑（D24）：复制必须用 `Uint8Array.from(buf)`，**不能**用 `buf.slice()` ——
 *   Node 的 `Buffer.prototype.slice` 返回的是**视图**（与 `Uint8Array.prototype.slice` 相反），
 *   于是"文档推荐传 Buffer"这条路上，`copy = true` 其实一次都没复制：
 *   实测 `writePageRaw(0, …)` 会把调用方 Buffer 的前 8 字节（"Sony PS2" 魔数）改掉。
 *   `Uint8Array.from()` 对 Buffer / Uint8Array / 数组都是**逐元素复制**，与具体类型无关。
 */
export function readCardFromBuffer(buf: Uint8Array, copy = true): Card {
  const b = copy ? Uint8Array.from(buf) : buf;
  return new Card(b);
}
