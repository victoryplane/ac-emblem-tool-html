/**
 * AC PS2 徽章存档格式 —— TypeScript 核心（零依赖、纯 ESM、可被浏览器直接 import）。
 *
 * 本文件是 `tools/acet_format.py`（Python 参考实现）里**格式读写**部分的忠实移植。
 * 上游 C++ 出处：`src/ac-emblem-tool/acet/acet.cpp` + `acet/acet.h`。
 *
 * 移植纪律（与 Python 版逐条对齐，不是"重写一个更好的版本"）：
 *   · 语义 / 边界 / 字节序 / 错误行为 必须一模一样；
 *   · 凡是"上游看起来像 bug、但为了字节级兼容仍照做"的地方，都在注释里用 ⚠ 标出；
 *   · 凡是 Python 参考实现里踩过的坑，都在这里注明原因（尤其是"为什么"）。
 *
 * 环境约束（Node 原生类型擦除 / 浏览器直跑）：
 *   · 只能用可擦除语法 ⇒ 不用 `enum` / `namespace` / 构造函数参数属性 / 装饰器；
 *   · 相对 import 必须写全扩展名（见 test/core.test.ts）。
 *
 * --------------------------------------------------------------------------
 * 格式总览（PS2 世代 AC 的徽章存档）
 * --------------------------------------------------------------------------
 * 非 LR（AC2 / AC2AA / AC3 / SL / NX / NB）：
 *
 *     文件大小        0x4440 = 17472 字节
 *     0x00..0x23     36 字节存档头（前 12 字节 = 魔数 EMBLEM_HEADER）
 *     0x24..         图像索引数据 128×128 每像素 1 字节 = 0x4000（**逻辑** 0..0x3FFF）
 *     接着           调色板 256 项 × 4 通道 = 0x400（**逻辑** 0x4000..0x43FF）
 *     每 0x400 逻辑字节插入 1 个校验字节，把上面 0x4400 逻辑字节切成 17 段
 *     ★ 末段（第 18 段）= [53 字节数据 0x4400..0x4434][1 字节校验 @0x4435][10 字节 01 00*9]
 *       其中 0x4434 是 palette[255].alpha（游戏固定写 0x80），**不是**校验位
 *
 * Last Raven（LR）：
 *
 *     文件大小        0x4420 = 17440 字节
 *     0x00..0x03     4 字节头（无 36 字节存档头）
 *     0x04..         图像索引数据 0x4000（**逻辑** 0..0x3FFF）
 *     接着           调色板 0x400（**逻辑** 0x4000..0x43FF）
 *     同样 17 段 + 末段；颜色索引**不做**乱序重排
 *     ★ 末段 = [21 字节数据 0x4400..0x4414][1 字节校验 @0x4415][10 字节 01 00*9]
 *
 * ⚠ 上面这些偏移是**逻辑**偏移（数据流里的位置），**不是**文件里逐字节的物理偏移 ——
 *   物理偏移一律走 `offsetIndex()`（见下）。两者的差别不小，实测（Python 现算）：
 *
 *     非 LR：图像 0x24..0x4033，调色板 0x4034..0x4434，末段数据 0x4411..0x4434
 *           （"图像从 0x24 开始、调色板逻辑起点 0x4000" —— 物理上两者都**不是**
 *            0x24+长度：调色板逻辑起点 0x4000 的物理位置是 0x4034）
 *     LR  ：图像 0x04..0x4013，调色板 0x4014..0x4414，末段数据 0x4411..0x4414
 *           （★ 注意 0x4414 既是"调色板最后一字节"又是"末段 alpha 字节"——同一格）
 *
 *     ⚠ 末段那 53 / 21 个逻辑字节里，**只有前面一部分对应文件里的真实字节**：
 *       末尾 10 个逻辑字节（`01 00*9` 那段）落在 `offsetIndex()` 算出来的物理位置
 *       ≥ 文件长度处 ⇒ **游戏永远不会去读它们**，纯粹是数据流尾部的填充。
 *       校验只吃逻辑 0x4400..0x4434（非 LR），所以这一段在物理上止于 0x4434。
 *
 *   ★ 所以别写"调色板在 0x4024..0x4423"这种连续切片 —— 0x43FF 处插着第 17 个校验字节，
 *     调色板项与 0x400 块边界根本不对齐（palette[255].alpha 一直跑到 0x4434 去了）。
 *
 * 逻辑下标 ↔ 物理偏移：物理 = emblem_offset + 逻辑 + Math.floor(逻辑 / 0x3FF)
 * （即每读完 0x3FF = 1023 个数据字节就跳过 1 个校验字节）
 *
 * 校验算法：每个数据段 checksum = (-(段内数据字节之和 + 段内数据字节数)) & 0xFF
 *     常规段 = 0x3FF 个数据字节；末段的数据长度是 53（非 LR）/ 21（LR）。
 *
 * ⚠ 上游 `acet` 把末段校验写在 `0x43FF + dangling`（= 数据**内部**），比真实位置早一个
 *   字节。它平时能用是因为总在已有存档上原地注入（尾部被保留）；从空白块造就会让游戏
 *   判 `破損ファイル`。本实现按真实位置写，详见 applyChecksums / verifyChecksums。
 */

// --------------------------------------------------------------------------
// 常量（对应上游 acet/acet.h）
// --------------------------------------------------------------------------
export const SAVE_SIZE = 0x4440; // kSaveSize   非 LR 徽章存档大小
export const LR_SAVE_SIZE = 0x4420; // kLRSaveSize Last Raven 徽章存档大小
export const IMAGE_OFFSET = 0x24; // kImageOffset    非 LR：图像数据相对徽章块起点的偏移
export const LR_IMAGE_OFFSET = 0x4; // kLRImageOffset  LR  ：同上
export const IMAGE_WIDTH = 128; // kImageWidth
export const IMAGE_HEIGHT = 128; // kImageHeight
export const NUM_PIXELS = 0x4000; // kNumPixels   128*128
export const PALETTE_SIZE = 0x400; // kPaletteSize 256 色 * 4 通道

export const BLOCK = 0x400; // 含校验字节的物理块大小
export const BLOCK_DATA = 0x3ff; // 每个物理块里的数据字节数

/**
 * kEmblemHeader：非 LR 存档头前 12 字节。
 *   0x4420 0x4420 0x4000 三个 u32LE —— 前两个是「徽章块长度」(= LR 存档大小)，
 *   第三个是图像数据长度 (0x4000)。上游用它做"在容器里找徽章块"的锚点。
 */
export const EMBLEM_HEADER = Uint8Array.from([
  0x20, 0x44, 0x00, 0x00, 0x20, 0x44, 0x00, 0x00, 0x00, 0x40, 0x00, 0x00,
]);

// ---------------------------------------------------------------------------
// ★★ LR 的块头 —— 4 字节 `00 44 00 00`（实机定案 2026-10-04）
// ---------------------------------------------------------------------------
// LR 没有非 LR 那 36 字节头（图像从 0x04 就开始），但**头 4 字节不是随便的**：
// 两份真实 LR 存档都是 `00 44 00 00`（u32LE = 0x4400 = 索引 0x4000 + 调色板 0x400
// = 逻辑载荷长度）。
//
// ⚠ Python 版曾经漏掉它：`make_blank_save()` 里写的是 `if with_header and not is_lr:`，
//   **LR 分支根本不写头** ⇒ 从零造出来的 LR 块前 4 字节是 `00 00 00 00`。
//   后果：把这种块写进 LR 卡 ⇒ **游戏直接卡死**（`Mcd001_final2.ps2` 实测，2026-10-04）。
//   之前一直没暴露，是因为 LR 只测过"在真实块上原地注入"（头被原样保留）。
//   ⇒ 本移植里 `makeBlankSave()` **两种布局都写块头**，别重犯。
export const LR_EMBLEM_HEADER = Uint8Array.from([0x00, 0x44, 0x00, 0x00]);

/** 末段校验字节之后还剩 11 字节（非 LR 与 LR 都是 11 字节）。 */
export const TRAILING = 11;

// ---------------------------------------------------------------------------
// ★★★ 末段（第 18 段）的真实布局 —— 实机定案 2026-10-04
// ---------------------------------------------------------------------------
// 上游把 `dangling`（0x35 = 53 / 0x15 = 21）当成"从上一个校验字节起的偏移"，
// 于是把末段校验写在 `0x43FF + dangling`。**这是差一个字节的**：
// `dangling` 其实是**末段的数据长度**，而数据是从上一个校验字节的**下一个字节**开始的。
//
// 真实布局（10 份真实存档 + 实机写入实验一致）：
//
//   非 LR： [53 字节数据 0x4400..0x4434] [1 字节校验 @0x4435] [10 字节 01 00*9]
//   LR   ： [21 字节数据 0x4400..0x4414] [1 字节校验 @0x4415] [10 字节 01 00*9]
//
//   · 0x4400..0x4433 = 调色板最后 14 项（槽 242..255 一带）的字节
//     （这段里 0x43FF 处跳过一个校验字节，槽边界不再与 4 字节对齐 —— 定位一律走
//      `offsetIndex()`，别用连续切片）
//   · **0x4434 不是校验位，而是 `palette[255].alpha`**（游戏固定写 0x80）
//   · 校验之后那 10 字节 `01 00 00 00 00 00 00 00 00 00` 不参与任何校验
//
// 为什么上游"看起来也能用"：它在**已有存档上原地注入**，那 11 字节尾巴被原样保留。
// 尾部形如 `X 01 00*9` 时 `sum(尾部) = X + 1`，于是上游的旧公式
//   b[0x4434] = -(sum(0x4400..0x4433) + sum(0x4435..0x443F) + 52)
// 与真实公式
//   b[0x4435] = -(sum(0x4400..0x4434) + 53)
// **恒等**（两者是同一个方程）。从空白块造时尾部为 0，恒等关系不成立 ⇒ 游戏判
// `破損ファイル`。所以本实现按真实公式写，并保证那 10 字节尾巴要么是游戏写下的真值、
// 要么（空白块）补成 `01 00*9`。
//
// ⚠ FINAL_CHECK_OFF / DANGLING 这两个名字保留，但语义是**上游的（错的）**写法。
//   ⚠ 0.20 更正（原先这段注释说"只给 `verifyChecksumsUpstream()` 做逐行对照用"，与实现不符）：
//     · `verifyChecksumsUpstream()` **用的不是 `DANGLING`**，而是 `FINAL_ALPHA_POS`
//       （上游把末段校验写在 alpha 那一格；`prevCheck + dangling` 只是**代数上等于**它，
//        见 `core.test.ts` 里那条 `prevCheck + dangling === FINAL_ALPHA_POS` 的断言）；
//     · `DANGLING` / `DANGLING_LR` 现在**只有测试在用**（两条常量值与上述恒等式），
//       生产路径的末段长度一律走 `FINAL_DATA_LEN`。
//   保留它们是因为"上游那个 53/21"是文档与 `_selftest` 报告的对照点 —— 别删（测试依赖）。
export const FINAL_CHECK_OFF = SAVE_SIZE - TRAILING - 1; // 0x4434（= palette[255].alpha）
export const FINAL_CHECK_OFF_LR = LR_SAVE_SIZE - TRAILING - 1; // 0x4414（= palette[255].alpha）

export const DANGLING = FINAL_CHECK_OFF - (17 * BLOCK - 1); // 0x35 = 53
export const DANGLING_LR = FINAL_CHECK_OFF_LR - (17 * BLOCK - 1); // 0x15 = 21

// ---- 修正后的末段常量 ----
/** 0x4400 末段数据起点（两种布局相同）。 */
export const FINAL_SEG_OFF = 17 * BLOCK;
/** 末段数据长度（含 palette[255].alpha）；= 上游的 dangling。key: LR? */
export const FINAL_DATA_LEN = { false: 53, true: 21 } as const;
/** 末段校验字节位置：0x4435 / 0x4415。 */
export const FINAL_CHECK_POS = {
  false: FINAL_SEG_OFF + FINAL_DATA_LEN.false,
  true: FINAL_SEG_OFF + FINAL_DATA_LEN.true,
} as const;
/** palette[255].alpha 位置：0x4434 / 0x4414。 */
export const FINAL_ALPHA_POS = {
  false: FINAL_CHECK_OFF,
  true: FINAL_CHECK_OFF_LR,
} as const;
/** 校验字节之后的 10 字节：游戏写成 `01` + 9 个 0（不参与校验）。 */
export const FINAL_TRAILER = Uint8Array.from([0x01, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
/** 游戏把每个调色板项的 alpha 都写成 0x80（"完全不透明"），索引 0 那项写 0x00。 */
export const PALETTE_ALPHA_OPAQUE = 0x80;

/** 第一段校验的"魔数"种子 —— 上游注释：the first one has a magic number added to sum。 */
export const SEED = 0x98;
export const SEED_LR = 0xb8;

// ---------------------------------------------------------------------------
// 非 LR 的「作品常量」字段 0x14..0x1C（9 字节）
// ---------------------------------------------------------------------------
// 非 LR 的块头布局（实测 10 份真实样本，逐字节一致）：
//   0x00..0x0B  魔数（= 载荷长度 0x4420、0x4420、图像长度 0x4000）
//   0x0C..0x13  8 字节全 0（所有样本一致）
//   0x14..0x1C  ★ 9 字节「作品常量」—— 一个字都不能猜
//   0x1D..0x23  7 字节全 0（所有样本一致）
//
// ★ 为什么必须填它（**这条理由与"游戏是否校验"无关，是硬的**）：
//   它是**作品级常量、与徽章内容无关**（SL 美版的玫瑰 —— 别的玩家、完全不同的图 ——
//   与 SL 日版的 MIRAGE 这 9 字节**完全相同**；NX 则是另一个值），
//   空白块里它是 0，与游戏自己的产物**逐字节不同**。
//   而本目录的正确性判据是"写入器作用在真实存档上要**逐字节复原**"
//   （`_selftest/validate_writer.py`）—— 要让这个判据成立，就必须把它填对。
//   ⚠ **不要用"游戏会判 `破損ファイル`"来论证它**：唯一的正面证据（`bisect` 卡 E02：
//   把真实块的这 9 字节清零 → 报 `破損ファイル`）有两个混淆因素 ——
//   ① 那轮用的还是**旧写入器**（末段校验差一字节，见文件顶部的说明）；
//   ② 那张卡的 NX 槽 `icon.sys@0xDF` 全是 0（重复槽号，会卡死）。
//   ⇒ "游戏是否真的校验这 9 字节"记为 **[待复测]**，但**照抄真实存档的做法不变**。
//
// ⚠ 目前只掌握 SL / NX / NB 的部分值。**其它作品（AC2 / AC2AA / AC3）必须先从一个
//   真实存档里读出这个字段**，不要猜。`headerTailFromSave()` 就是干这个的。
export const HEADER_TAIL_OFF = 0x14;
export const HEADER_TAIL_LEN = 9;

/** 已知的作品常量（hex）。缺的必须从真实存档读，不要猜。 */
export const KNOWN_HEADER_TAIL: Record<string, string | null> = {
  'SLPS-25169': '00a130dd85ab078060', // Silent Line 日版
  'SLUS-20644': '00a130dd85ab078060', // Silent Line 美版（同值）
  'SLPS-25338': '80b230dd85ab078060', // Nexus 日版
  'SLUS-20986': null, // Nexus 美版：未知，待读
};

/** 上游 README 明文要求：最多 255 色（+ 透明）。 */
export const MAX_COLORS = 255;

// --------------------------------------------------------------------------
// 类型与错误
// --------------------------------------------------------------------------

/** extractImage 的三种 alpha 口径。 */
export type AlphaMode = 'acet' | 'gs' | 'index0';

/** saveKind 的四档结果。 */
export type SaveKind = 'emblem-raw' | 'emblem-lr' | 'container' | 'unknown';

/** 一段校验的布局：(段起点, 数据字节数, 校验字节位置, 种子)。 */
export type Segment = {
  start: number;
  dataLen: number;
  checkPos: number;
  seed: number;
};

/** 一条不通过的校验记录：(段名, 校验字节绝对偏移, 文件里的值, 期望值)。 */
export type BadSegment = {
  name: string;
  offset: number;
  got: number;
  expect: number;
};

export type VerifyResult = { ok: boolean; badSegments: BadSegment[] };

/**
 * 格式错误。Python 版抛 `ValueError` / `RuntimeError`，这里统一成一个类，
 * 但**消息文本与 Python 版逐字对应**（便于排错时两边对得上）。
 */
export class EmblemFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmblemFormatError';
  }
}

/** encodeEmblem 的选项。 */
export type EncodeEmblemOptions = {
  isLr?: boolean;
  /** 非 LR 的 9 字节作品常量（0x14..0x1C）。不给就用 0（与游戏产物不同）。 */
  headerTail?: Uint8Array | null;
  /** 是否把未用调色板项填成 `00 00 00 80`（游戏惯例）。默认 true。 */
  fillUnused?: boolean;
  /** LR 的 4 字节块头，不给就用实测常量 `00 44 00 00`。 */
  lrHeader?: Uint8Array | null;
};

// --------------------------------------------------------------------------
// 基础工具
// --------------------------------------------------------------------------

/**
 * 逻辑下标 → 物理偏移。等价上游 OffsetIndex()。
 *
 * 每 0x3FF 个数据字节后有一个校验字节，所以物理位置要加上"已经跳过的校验字节数"。
 *
 * ★ 必须用这个函数定位，**绝不能用连续切片**（例如"调色板第 k 项的前 4 字节"）——
 *   0x400 块的边界与 4 字节调色板项的边界不对齐（0x43FF 处有一个校验字节插进来）。
 */
export function offsetIndex(i: number, emblemOffset = 0): number {
  return emblemOffset + i + Math.floor(i / BLOCK_DATA);
}

/** RGBA → u32，等价上游 PackColor()（r 在高位）。 */
export function packColor(r: number, g: number, b: number, a: number): number {
  return (((r & 0xff) << 24) | ((g & 0xff) << 16) | ((b & 0xff) << 8) | (a & 0xff)) >>> 0;
}

/** u32 → RGBA（packColor 的逆运算）。 */
export function unpackColor(c: number): [number, number, number, number] {
  return [(c >>> 24) & 0xff, (c >>> 16) & 0xff, (c >>> 8) & 0xff, c & 0xff];
}

/**
 * 调色板索引乱序重排，等价上游 UnscramblePalette()。
 *
 * 以 32 项为一组，交换中间两组 8 项：
 *     [0..7][8..15][16..23][24..31]  →  [0..7][16..23][8..15][24..31]
 * LR 不做这一步。
 *
 * ★★ 这个置换**自逆**（两次调用回到原值）—— 上游只有一个函数名，Python 版也只有一个
 *    `unscramble_palette()`；两个用途共用它：
 *     · 提取：[像素字节] → 调色板槽号（`UNSCRAMBLE_LUT`）
 *     · 注入：新建的调色板槽号 → [写进像素字节的值]
 *   ⚠ 别"想当然"写成"一个正向 + 一个反向"：那会让非 LR 的索引整体错位
 *     （本移植第一版就是这么错的：lut[8] 算成 0，结果 usedPaletteSlots 只有 64 个）。
 *   ⚠ 0.20：原先那个"方向性别名" `scramblePalette()`（与它逐字相同）已删 ——
 *     它是同一个置换、生产路径零调用点，留着只会让人再问一次"到底哪个是逆"。
 */
export function unscramblePalette(index: number): number {
  const group = Math.floor((index % 32) / 8);
  if (group === 1) return index + 8;
  if (group === 2) return index - 8;
  return index;
}

/**
 * 由置换表求**真正的**逆表（仅用于自检：证明上面那个置换确实自逆）。
 * 与上游/Python 无关，不要拿它去替换 UNSCRAMBLE_LUT。
 */
export function invertPalettePermutation(lut: Uint8Array): Uint8Array {
  const inv = new Uint8Array(256);
  for (let i = 0; i < 256; i++) inv[lut[i]] = i;
  return inv;
}

/**
 * 256 项置换表（上游/Python 只有这一张表）。
 *
 * ★★ 0.20 合并：原先还有一份"逐字相同"的 `scramblePalette()` 与 `SCRAMBLE_LUT`，
 *   注释说"为了读起来有方向感" —— 但两者是**同一个自逆置换**
 *   （`scramble(x) === unscramble(x)`，见 `invertPalettePermutation` 的断言），
 *   而且 `scramblePalette` / `SCRAMBLE_LUT` **在生产路径一个调用点都没有**
 *   （只有测试在用，测试里也顺手断言了"两者逐项相同"）⇒ 收成这一份。
 *   想表达"注入方向"的调用点，直接写 `UNSCRAMBLE_LUT[slot]` 并看本行的说明即可 ——
 *   换成一个只有方向感、没有语义差别的别名，只会让"它到底是不是逆置换"再被问一次。
 */
export const UNSCRAMBLE_LUT: Uint8Array = (() => {
  const t = new Uint8Array(256);
  for (let i = 0; i < 256; i++) t[i] = unscramblePalette(i);
  return t;
})();

/**
 * 是否按 Last Raven 布局解析（上游只看文件大小）。
 *
 * ⚠ 判据是**恰好等于** `LR_SAVE_SIZE`（0x4420），比它短/长都不算 —— 这是公开口径，
 *   别改成"≤"：`container`（比 0x4420 长）与各种畸形缓冲都靠它区分。
 */
export function isLrSave(bytes: Uint8Array): boolean {
  return bytes.length === LR_SAVE_SIZE;
}

/**
 * `applyChecksums` 用的**布局判据**（仅在"写校验"这条路上替代 `isLrSave`）。
 *
 * 为什么需要它：`isLrSave()` 是**恰好相等**，于是一份 `LR_SAVE_SIZE - 1` 的缓冲会被
 * 当成"非 LR 的短缓冲" ⇒ 末段 alpha 位置取 0x4434 ⇒ 立刻抛 `缓冲区太短`
 * （实测：`applyChecksums(new Uint8Array(0x441F))` 抛在 `writeByteInPlace`）。
 * 但 Python 参考实现在这里**不会抛**：它按 `is_lr = len(save) == LR_SAVE_SIZE` 判，
 * 用的却是**切片赋值**（`z[alpha:] = bytes(size - alpha)`）⇒ 17439 字节的缓冲会被
 * 一路补成 17440 且 18/18。也就是说这条路上真正该用的判据是
 * "**差最后那几个字节**（< `FINAL_DATA_LEN.true` = 21）⇒ 意图显然是 LR 块"，
 * 而不是"必须已经完整"。
 *
 * 边界：`len >= LR_SAVE_SIZE - 1` 才算 —— 与 `LR_SAVE_SIZE - 2` 的行为对照见
 * `core.test.ts`（前者必须补成 0x4420 且 18/18，后者必须抛）。
 * `len > LR_SAVE_SIZE`（容器）**不受影响**，仍按非 LR 处理。
 */
function layoutIsLr(bytes: Uint8Array): boolean {
  if (isLrSave(bytes)) return true;
  return bytes.length < LR_SAVE_SIZE && bytes.length >= LR_SAVE_SIZE - 1;
}

// --------------------------------------------------------------------------
// 定位
// --------------------------------------------------------------------------

/**
 * 徽章块在文件里的起点。等价上游 FindOffset()。
 *
 * 语义（含上游的怪癖，务必照做）：
 *   * len === 0x4440 → 直接返回 0（不搜索）
 *   * len === 0x4420 → 直接返回 0（不搜索）
 *   * len  > 0x4440 → 在文件里"找" EMBLEM_HEADER
 *   * len  < 0x4440 且 !== 0x4420 → 抛异常（文件太小）
 *
 * ⚠ 上游的"找"是**子序列**匹配而不是子串匹配：它按顺序匹配 header 的 12 个字节，
 *   中途失配就把计数清零，但**不要求 12 个字节相邻**。文件里若散落着这些字节，
 *   定位就可能落在错误的位置。本函数忠实复刻该行为；
 *   `findOffsetContiguous()` 给出"正确"的连续搜索版本，selftest 会比对两者。
 *
 * ⚠ 循环顶部的判断意味着：找到匹配时返回的是"**最后一个匹配字节之后** j 个字节处
 *   再往前退 j"的位置，即 `i - j`（i 是循环当前下标）——与 Python 版逐行一致。
 */
export function findOffset(bytes: Uint8Array): number {
  const n = bytes.length;
  if (n > SAVE_SIZE) {
    let j = 0;
    for (let i = 0; i < n; i++) {
      if (j === EMBLEM_HEADER.length) return i - j;
      if (bytes[i] === EMBLEM_HEADER[j]) j++;
      else j = 0;
    }
    // 循环结束前最后一次匹配也可能刚好凑满
    if (j === EMBLEM_HEADER.length) return n - j;
    throw new EmblemFormatError('findOffset: 在文件里找不到徽章数据（缺少 12 字节魔数）');
  }
  if (n < SAVE_SIZE && n !== LR_SAVE_SIZE) {
    throw new EmblemFormatError(
      `findOffset: 文件太小，不可能是徽章存档（${n} 字节；应为 0x${LR_SAVE_SIZE.toString(16).toUpperCase()} 或 0x${SAVE_SIZE.toString(16).toUpperCase()}）`,
    );
  }
  return 0;
}

/** 正确的连续子串搜索（用于对照上游的子序列搜索）。 */
export function findOffsetContiguous(bytes: Uint8Array): number {
  outer: for (let i = 0; i + EMBLEM_HEADER.length <= bytes.length; i++) {
    for (let k = 0; k < EMBLEM_HEADER.length; k++) {
      if (bytes[i + k] !== EMBLEM_HEADER[k]) continue outer;
    }
    return i;
  }
  throw new EmblemFormatError('findOffsetContiguous: 找不到 12 字节魔数');
}

/**
 * 上游 FindPaletteOffset() 的复刻 —— 判定"拖进来的文件像不像存档"的启发式。
 *
 * 逐字节扫描 [0, stop)，对每个位置取 13 字节，要求：
 *     buf[0..3] 全为 0x00；buf[7] === 0x80；buf[11] === 0x80
 * 中间 6 个字节不检查。
 *
 * ⚠ 上游这一函数有两处缺陷，本函数照做以求行为一致：
 *   ① C++ 里 `curr+i % 0x400 == 0x3FF` 因运算符优先级实际等于 `curr + i == 0x3FF`
 *      （`%` 先算），只在文件开头附近生效；
 *   ② 这个判据本身和 kEmblemHeader 对不上（header[0] = 0x20 ≠ 0），
 *      所以它并不能真正认出徽章存档。
 * 返回命中的偏移，找不到返回 null。
 */
export function findPaletteOffset(data: Uint8Array, stop = 0xffff): number | null {
  const n = Math.min(data.length, stop);
  let pos = 0;
  while (pos < n) {
    const buf = data.subarray(pos, pos + 13);
    if (buf.length < 13) break;
    let found = true;
    for (let i = 0; i < 12; i++) {
      const off = pos + i === 0x3ff ? 1 : 0; // 见上面 ①
      if (i + off >= buf.length) {
        found = false;
        break;
      }
      if (i < 4 && buf[i + off] !== 0x00) {
        found = false;
        break;
      }
      if ((i === 7 || i === 11) && buf[i + off] !== 0x80) {
        found = false;
        break;
      }
    }
    if (found) return pos;
    pos += 1;
  }
  return null;
}

// --------------------------------------------------------------------------
// 校验和
// --------------------------------------------------------------------------

const LR_KEY = (isLr: boolean) => (isLr ? 'true' : 'false') as 'true' | 'false';

/**
 * (段起点, 数据字节数, 校验字节位置, 种子) 列表 —— 共 18 段（17 常规 + 1 末段）。
 *
 * 这是从格式本身推出的布局，不照抄上游循环，因此可用作独立判据。
 * 只有第 0 段带魔数种子（0x98 / 0xB8），其余段的累加器都从 0 开始。
 *
 * ★ 末段按**修正后的真实布局**：数据 0x4400..(0x4434 / 0x4414)，校验字节紧随其后
 *   （0x4435 / 0x4415）。上游把校验写在数据内部（0x4434 / 0x4414）是差一个字节的，
 *   见文件顶部的常量说明；`verifyChecksumsUpstream()` 保留上游写法做对照。
 */
export function segmentLayout(isLr: boolean): Segment[] {
  const size = isLr ? LR_SAVE_SIZE : SAVE_SIZE;
  const seed0 = isLr ? SEED_LR : SEED;
  const segs: Segment[] = [];
  for (let k = 0; k < 17; k++) {
    const start = k * BLOCK;
    segs.push({
      start,
      dataLen: BLOCK_DATA,
      checkPos: start + BLOCK_DATA,
      seed: k === 0 ? seed0 : 0,
    });
  }
  const key = LR_KEY(isLr);
  segs.push({
    start: FINAL_SEG_OFF,
    dataLen: FINAL_DATA_LEN[key],
    checkPos: FINAL_CHECK_POS[key],
    seed: 0,
  });
  // 对应 Python 的 assert segs[-1][2] < size
  if (!(segs[segs.length - 1].checkPos < size)) {
    throw new EmblemFormatError('segmentLayout: 末段校验位置越界（内部错误）');
  }
  return segs;
}

/** checksum = (-(种子 + 数据字节之和 + 数据字节数)) & 0xFF。 */
export function computeChecksum(dataRegion: Uint8Array, dataLen: number, seed = 0): number {
  let sum = seed + dataLen;
  for (let i = 0; i < dataRegion.length; i++) sum += dataRegion[i];
  return (-sum) & 0xff;
}

/** copy(b, base + start, base + checkPos)，越界时截断（= Python 的列表切片语义）。 */
function sliceClamped(b: Uint8Array, from: number, to: number): Uint8Array {
  const lo = Math.max(0, Math.min(from, b.length));
  const hi = Math.max(lo, Math.min(to, b.length));
  return b.subarray(lo, hi);
}

/** 读取一个字节；越界时返回 -1（Python 会抛 IndexError ⇒ 这里显式转成可判定的错）。 */
function byteAt(b: Uint8Array, i: number): number {
  if (i < 0 || i >= b.length) {
    throw new EmblemFormatError(`字节越界：偏移 0x${i.toString(16)}，文件长度 ${b.length}（对不上任何布局）`);
  }
  return b[i];
}

/**
 * 复刻 Python `bytearray` 的**切片赋值**扩容：保证下标 `index` 可写。
 * 返回**可能换过底层的数组**（调用方必须接收返回值）。
 *
 * ⚠ 只对"切片赋值"语义使用它（本文件里唯一一处是"校验之后那 10 字节"）。
 *   Python 的**单下标**越界赋值会抛 `IndexError`，那种语义用 `writeByteInPlace()`。
 */
function ensureWritable(b: Uint8Array, index: number): Uint8Array {
  if (index < 0) throw new EmblemFormatError(`ensureWritable: 负下标 ${index}`);
  if (index < b.length) return b;
  const grown = new Uint8Array(index + 1);
  grown.set(b, 0);
  return grown;
}

/** 块起点：长度 > SAVE_SIZE 才搜索，否则 0（与 Python 版各处的 `find_offset(...) if len > SAVE_SIZE else 0` 一致）。 */
function blockBase(bytes: Uint8Array): number {
  return bytes.length > SAVE_SIZE ? findOffset(bytes) : 0;
}

/**
 * 独立复核一个徽章存档的全部 18 段校验字节（按**修正后的真实布局**）。
 *
 * 返回 `{ ok, badSegments }`，只列不通过的段。
 * 这是**独立判据**：它按格式定义重算，而不是把写入器的循环再跑一遍。
 *
 * ★ 末段用的是真实位置（0x4435 / 0x4415）。真实存档全部通过；
 *   上游 `acet` 从空白块造出来的存档会在末段**不通过**（差 0xFF），这正是
 *   非 LR 写入被游戏判 `破損ファイル` 的原因。要看上游写法是否自洽，
 *   用 `verifyChecksumsUpstream()`。
 */
export function verifyChecksums(bytes: Uint8Array): VerifyResult {
  const isLr = isLrSave(bytes);
  const base = blockBase(bytes);
  const segs = segmentLayout(isLr);
  const badSegments: BadSegment[] = [];

  segs.forEach((seg, idx) => {
    const absStart = base + seg.start;
    const absCheck = base + seg.checkPos;
    const data = sliceClamped(bytes, absStart, absCheck);
    if (data.length !== seg.dataLen) {
      badSegments.push({ name: `seg${String(idx).padStart(2, '0')}(截断)`, offset: absCheck, got: -1, expect: -1 });
      return;
    }
    const expect = computeChecksum(data, seg.dataLen, seg.seed);
    const got = absCheck < bytes.length ? bytes[absCheck] : -1;
    if (got !== expect) {
      badSegments.push({ name: `seg${String(idx).padStart(2, '0')}`, offset: absCheck, got, expect });
    }
  });
  return { ok: badSegments.length === 0, badSegments };
}

/**
 * 按**上游 `acet` 的（差一个字节的）末段写法**复核，仅供对照。
 *
 * 上游：末段校验在 0x4434 / 0x4414，输入是 0x4400..0x4433 加上校验之后的尾巴。
 * 真实存档同时满足两套写法（见文件顶部说明），所以这个函数对真实存档也返回通过。
 */
export function verifyChecksumsUpstream(bytes: Uint8Array): VerifyResult {
  const isLr = isLrSave(bytes);
  const base = blockBase(bytes);
  const size = isLr ? LR_SAVE_SIZE : SAVE_SIZE;
  const end = base + size;
  const segs = segmentLayout(isLr);
  const finalPos = FINAL_ALPHA_POS[LR_KEY(isLr)];
  const badSegments: BadSegment[] = [];

  segs.forEach((seg, idx) => {
    let absCheck: number;
    let expect: number;
    if (idx === segs.length - 1) {
      const absStart = base + FINAL_SEG_OFF;
      absCheck = base + finalPos;
      // Python: bytes(save[abs_start:abs_check]) + bytes(save[abs_check+1:end])
      // （末段校验之前的 53/21 字节数据 + 校验字节之后到文件末尾的全部尾巴）
      const head = sliceClamped(bytes, absStart, absCheck);
      const tail = sliceClamped(bytes, absCheck + 1, end);
      const data = new Uint8Array(head.length + tail.length);
      data.set(head, 0);
      data.set(tail, head.length);
      expect = computeChecksum(data, seg.dataLen - 1, seg.seed);
    } else {
      const absStart = base + seg.start;
      absCheck = base + seg.checkPos;
      const data = sliceClamped(bytes, absStart, absCheck);
      expect = computeChecksum(data, seg.dataLen, seg.seed);
    }
    const got = absCheck < bytes.length ? bytes[absCheck] : -1;
    if (got !== expect) {
      badSegments.push({ name: `seg${String(idx).padStart(2, '0')}`, offset: absCheck, got, expect });
    }
  });
  return { ok: badSegments.length === 0, badSegments };
}

/**
 * 就地重算全部 18 段校验字节（按**修正后的真实布局**）。
 *
 * 流程：
 *   1. 把末段的 `palette[255].alpha`（0x4434 / 0x4414）写成游戏约定值 `0x80`；
 *   2. 它之后那 10 字节：**已有非零值就原样保留**（那是游戏写下的字段），
 *      只有从空白块造（全零）时才补上游戏那种 `01 00 00 00 00 00 00 00 00 00`；
 *   3. 逐段算校验：17 个 0x400 块的校验 @0x3FF..0x43FF；
 *      末段 = -(sum(0x4400..0x4434 / 0x4414) + 53 / 21) & 0xFF，写在紧随其后的那一格。
 *
 * ★ 这样写出来的文件**同时满足**上游写法与真实写法（尾部 `X 01 00*9` 使两式恒等），
 *   所以官方 exe 也仍然能正确读回。
 * ★ 本函数作用在**游戏自己写的存档**上时是**逐字节复原**的（`_selftest/validate_writer.py`
 *   对 10 份真实存档断言了这一点）—— 这是判断写入器是否正确的硬判据。
 *
 * ★★ 0.19 修正（D22）：**"Python 会静默扩容 bytearray"这个前提是错的** ——
 *   Python 只有**切片赋值**才扩容，**单下标越界赋值抛 `IndexError`**
 *   （实测 Python 3.12：`bytearray(4)[0x4434]=1` → IndexError；`b[0x4432:0x4434]=…` → 扩容）。
 *   所以这里的语义改成与它逐条对齐：
 *     · `palette[255].alpha` 与 18 个校验字节都是**单下标写** ⇒ 缓冲区不够就**抛**；
 *     · 只有"校验之后那 10 字节"走**切片赋值**（`set`）⇒ 那一段允许扩容（与 Python 一致）。
 *   于是 `0x443F`（差 1 字节）能像 Python 一样补成 17472 且 18/18。
 *   ⚠ 下面 0.20 把 LR 那侧的边界也补齐了：`0x441F`（= LR 差 1 字节）**不再抛**，而是补成
 *     0x4420 且 18/18（Python 同结果）；真正该抛的边界下移到 `0x441E`。
 *
 * ★★ 0.20 修正（两处，都与"短缓冲"有关）：
 *   ① **布局判据**从 `isLrSave()`（"必须恰好 0x4420"）改成 `layoutIsLr()`（"差最后 1 字节也算 LR"）。
 *      原先 `LR_SAVE_SIZE - 1` 的缓冲会被当成"非 LR 的短缓冲" ⇒ 末段 alpha 位置取 0x4434
 *      ⇒ `writeByteInPlace()` 直接抛。Python 参考实现在这里**不会**抛（它按 `len == 0x4420`
 *      判，但用的是**切片赋值**，17439 字节会被补成 17440 且 18/18）。
 *   ② **扩容目标**从"尾巴最后一格"（`trailEnd - 1`）改成
 *      `max(trailEnd - 1, base + 末段校验位)`，并在扩容后**重新算一遍 `base`**。
 *      现状下这两句都是"把不变式写清楚"（`ensureWritable` 是同下标扩长、所有校验位本来就
 *      ≤ `trailEnd - 1`），但它们把"18 个校验位都装得下"这件事从**推断**变成了**保证** ——
 *      以后谁动了 `ensureWritable` 的语义（例如把块搬到 0），这里不会静默写坏数据。
 *
 * ⚠ 返回值：扩容时数组会换底层（`ensureWritable`），**调用方必须接收返回值**。
 */
export function applyChecksums(save: Uint8Array): Uint8Array {
  const isLr = layoutIsLr(save);
  let base = blockBase(save);
  const segs = segmentLayout(isLr);

  // 1) + 2) 先把末段里的「非校验字节」安置好，再统一算校验
  const alphaPos = base + FINAL_ALPHA_POS[LR_KEY(isLr)];
  save = writeByteInPlace(save, alphaPos, PALETTE_ALPHA_OPAQUE);
  const trailPos = alphaPos + 2; // 校验字节之后的 10 字节
  const trailEnd = trailPos + FINAL_TRAILER.length;
  // 扩容目标见函数注释：尾巴最后一格 **与** 最后一个校验位（末段的 checkPos）里取大者。
  // ⚠ 这里**必须**用 `segs[segs.length - 1].checkPos`，不能用常量拼 —— 布局变动时要跟着变。
  const lastCheckAbs = base + segs[segs.length - 1].checkPos;
  const grown = ensureWritable(save, Math.max(trailEnd - 1, lastCheckAbs)); // ← Python 里是切片赋值 ⇒ 允许扩容
  if (grown !== save) {
    // ★ 扩容过（返回的是新数组）⇒ 把 `base` 重新算一遍再往下用。
    //   `ensureWritable()` 是"**同下标**扩长"（`grown.set(b, 0)`，块的位置不变），所以重算出来的
    //   `base` 与扩容前**必然相同**（`base > 0` 的容器也照旧）；这里重算纯粹是为了不让
    //   "扩容前算的偏移"跨过扩容那道坎继续用 —— 一旦 `ensureWritable` 将来改成"把块搬到 0"，
    //   这一段会自己跟上，而不是继续用过期偏移写坏数据。
    save = grown;
    base = blockBase(save);
    if (base + segs[segs.length - 1].checkPos >= save.length) {
      throw new EmblemFormatError(
        `applyChecksums: 扩容后仍装不下最后一个校验位（块起点 0x${base.toString(16)}、` +
          `长度 ${save.length}）—— 内部错误`,
      );
    }
  }
  // ★ 那 10 字节是**游戏写下的字段**（上游最初的手工逆向里就是从源存档原样抄的），
  //   所以「有真值就保留」；只有从空白块造（全零）时才补上游戏那种 `01 00*9`。
  let anyNonZero = false;
  for (let i = trailPos; i < trailEnd; i++) {
    if (save[i] !== 0) {
      anyNonZero = true;
      break;
    }
  }
  if (!anyNonZero) save.set(FINAL_TRAILER, trailPos);

  // 3) 逐段写校验（末段的数据区间包含刚写好的 alpha）。
  //   ⚠ `absStart` / `absCheck` 在循环**内部**按当前 `base` 算（别提到循环外）——
  //     上面那次扩容会改 `base`，提出来就又会用错偏移。
  for (const seg of segs) {
    const absStart = base + seg.start;
    const absCheck = base + seg.checkPos;
    const data = sliceClamped(save, absStart, absCheck);
    if (data.length !== seg.dataLen) {
      throw new EmblemFormatError(`applyChecksums: 第 ${seg.start / BLOCK} 段数据长度不足`);
    }
    save = writeByteInPlace(save, absCheck, computeChecksum(data, seg.dataLen, seg.seed));
  }
  return save;
}

/**
 * **单下标写**（Python 的 `b[i] = v` 语义）：越界**抛错**，绝不扩容。
 * 与下面的 `ensureWritable()`（切片赋值语义）配对使用 —— 见 `applyChecksums` 的说明。
 */
function writeByteInPlace(b: Uint8Array, index: number, value: number): Uint8Array {
  if (index < 0) throw new EmblemFormatError(`writeByteInPlace: 负下标 ${index}`);
  if (index >= b.length) {
    throw new EmblemFormatError(
      `applyChecksums: 缓冲区太短（要写第 0x${index.toString(16)} 字节，只有 ${b.length} 字节）——` +
        'Python 参考实现在这里抛 IndexError，本实现同样拒绝"凭空造出一个块"',
    );
  }
  b[index] = value;
  return b;
}

// --------------------------------------------------------------------------
// 提取 / 注入
// --------------------------------------------------------------------------

/**
 * 从徽章存档里取出 128×128 RGBA8888 图像。等价上游 ExtractImage()。
 *
 * 返回 NUM_PIXELS * 4 = 65536 字节。
 *
 * `alphaMode` 控制 alpha 怎么归一：
 *
 *   * `'acet'`（上游行为）：**任何非零 alpha 一律变成 0xFF**。
 *     用于与官方 exe 逐像素对齐（交叉验证）。
 *   * `'index0'`（★ **最接近游戏实际显示**）：**调色板索引 0 = 透明，其余不透明**，
 *     **完全忽略 alpha 字节**。依据是实机观测（见下）。
 *   * `'gs'`：按 PS2 GS 的 alpha 语义 0..0x80 线性映射。
 *     ⚠ **这个档位看着"更忠实"，但实机证明它不是游戏的行为** —— 保留只作分析用。
 *
 * ★★ 三个档位的由来（2026-10-04，实机定案）：
 *   把 `data0` 的调色板 RGB 全部取反（`palette[0]` 从 `00 00 00 40` 变成 `FF FF FF 40`）
 *   后写进卡上的 `data2`，游戏里那一格显示出来：
 *     · 背景**仍是黑的**（并**没有**变成白、也没有变成 50% 灰）
 *     · 全格找不到成片的纯白（>250）或中性灰（100..190 只有散点）
 *   ⇒ **游戏不把索引 0 的 RGB/alpha 当颜色画**；索引 0 就是"背景/透明色"。
 *   ⇒ 所以 `'index0'` 才是对得上眼睛的那一档；`'gs'` 只是把 alpha 字节当真了。
 *   （未定：索引 0 到底是"透明（露出黑色底板）"还是"被强制画成黑"——
 *     两种解释在实机上都表现为黑，对使用没有区别。）
 */
export function extractImage(save: Uint8Array, alphaMode: AlphaMode = 'acet'): Uint8Array {
  if (alphaMode !== 'acet' && alphaMode !== 'gs' && alphaMode !== 'index0') {
    throw new EmblemFormatError("extractImage: alphaMode 只能是 'acet' / 'gs' / 'index0'");
  }

  const isLr = isLrSave(save);
  const base = blockBase(save);
  const imageOffset = isLr ? LR_IMAGE_OFFSET : IMAGE_OFFSET;

  const pixels = new Uint8Array(NUM_PIXELS);
  for (let i = 0; i < NUM_PIXELS; i++) {
    const p = offsetIndex(imageOffset + i, base);
    if (p < 0 || p >= save.length) {
      throw new EmblemFormatError(`extractImage: 像素数据越界（i=${i}, 偏移 0x${p.toString(16)}）`);
    }
    pixels[i] = save[p];
  }

  const colors = new Uint8Array(PALETTE_SIZE);
  for (let i = 0; i < PALETTE_SIZE; i++) {
    const p = offsetIndex(imageOffset + NUM_PIXELS + i, base);
    if (p < 0 || p >= save.length) {
      throw new EmblemFormatError(`extractImage: 调色板数据越界（i=${i}, 偏移 0x${p.toString(16)}）`);
    }
    let c = save[p];
    // 徽章只有"有/无"两种透明度；完全不透明被编码成 0x80，不是 0xFF
    if (i % 4 === 3) {
      if (alphaMode === 'gs') {
        c = Math.min(255, Math.floor((c * 255) / 128)); // GS 0..0x80 → PNG 0..255
      } else if (c !== 0) {
        c = 0xff;
      }
    }
    colors[i] = c;
  }
  if (alphaMode === 'index0') {
    // 索引 0 = 背景/透明；其余一律不透明（忽略存下来的 alpha 字节）
    for (let k = 0; k < 256; k++) colors[k * 4 + 3] = k === 0 ? 0 : 0xff;
  }

  const out = new Uint8Array(NUM_PIXELS * 4);
  if (isLr) {
    for (let i = 0; i < NUM_PIXELS; i++) {
      const ci = pixels[i] * 4;
      out[i * 4] = colors[ci];
      out[i * 4 + 1] = colors[ci + 1];
      out[i * 4 + 2] = colors[ci + 2];
      out[i * 4 + 3] = colors[ci + 3];
    }
  } else {
    for (let i = 0; i < NUM_PIXELS; i++) {
      const ci = UNSCRAMBLE_LUT[pixels[i]] * 4;
      out[i * 4] = colors[ci];
      out[i * 4 + 1] = colors[ci + 1];
      out[i * 4 + 2] = colors[ci + 2];
      out[i * 4 + 3] = colors[ci + 3];
    }
  }
  return out;
}

/**
 * 把 128×128 RGBA8888 图像写进徽章存档（就地修改）。等价上游 InjectImage()。
 *
 * 规则：
 *   * alpha !== 0xFF 的像素一律当作全透明（写调色板 0 号项 = 全 0）；
 *   * 调色板按"首次出现顺序"分配，所以颜色数 > 255 就会溢出；
 *   * 非 LR 的最后要按 `UNSCRAMBLE_LUT` 重排索引（该置换自逆，与"取出方向"共用一张表）。
 *
 * `strict=true`（默认）时颜色数超限**报错**；`strict=false` 复刻上游的**静默截断**。
 */
export function injectImage(save: Uint8Array, image: Uint8Array, strict = true): Uint8Array {
  const nPx = Math.floor(image.length / 4);
  if (nPx !== NUM_PIXELS) {
    throw new EmblemFormatError(
      `injectImage: 图像必须恰好 ${NUM_PIXELS} 像素（${IMAGE_WIDTH}×${IMAGE_HEIGHT}），收到 ${nPx}`,
    );
  }

  const isLr = isLrSave(save);
  const base = blockBase(save);
  const imageOffset = isLr ? LR_IMAGE_OFFSET : IMAGE_OFFSET;

  const paletteMap = new Map<number, number>();
  paletteMap.set(packColor(0, 0, 0, 0), 0);

  const writePalette = (slot: number, c: number): void => {
    for (let ch = 0; ch < 4; ch++) {
      const pos = offsetIndex(imageOffset + NUM_PIXELS + slot * 4 + ch, base);
      // ★ 0.19（D22 附带）：这段注释原来写的是"Python 对越界赋值会静默扩容 bytearray" ——
      //   **那是错的**：Python 只有**切片赋值**才扩容，单下标越界赋值抛 `IndexError`。
      //   所以这里显式报错是与 Python 一致的（不是"刻意的差异"）。
      //   对合法尺寸的存档（0x4420 / 0x4440）两边行为本来就一致。
      // ⚠ 注意 `strict=false` 时 slot 可能是 256，它占 4 个字节：
      //     非 LR = 物理 0x4435..0x4438（**0x4435 正好是末段校验字节那一格**），
      //     LR   = 物理 0x4415..0x4418（0x4415 也正是末段校验字节）。
      //   ⇒ 都在文件长度之内，这个越界检查拦不住上游那条静默路径；
      //     而且写进去的第一格随后会被 `applyChecksums()` 重算覆盖 ⇒ 串色完全被掩盖。
      byteAt(save, pos);
      save[pos] = (c >>> (24 - ch * 8)) & 0xff;
    }
  };

  for (let i = 0; i < nPx; i++) {
    let c = 0;
    if (image[i * 4 + 3] === 0xff) {
      c = packColor(image[i * 4], image[i * 4 + 1], image[i * 4 + 2], 0x80);
    }

    if (!paletteMap.has(c)) {
      // ⚠ 上游判据是 `size() > 256`，所以第 257 项会被放进来，
      //   而其索引 256 写进 1 字节字段时截断成 0 ⇒ 静默串色。
      //   这里保持同样的阈值，但用 strict 把越界明确报出来。
      //
      // ⚠⚠ **判定顺序很要紧**（上游是"先判上限、后插入"）：
      //     · `size > 256` 在**插入前**判 ⇒ size 达到 257 时下一次插入才抛
      //       ⇒ 第 256 个"新颜色"（槽号 256）**已经写进调色板了**，只是它的像素
      //         索引会被截断成 0。这就是上游 257 色的失败方式。
      //     · `strict` 判在 `size >= 256` ⇒ 第 256 个新颜色（= 第 257 项）先抛。
      //   ⚠ 别把 `size += 1` 提前到判断之前 —— 那样连 strict=false 的第 256 项都会抛，
      //     与 Python 版行为不一致。
      if (paletteMap.size > 256) {
        throw new EmblemFormatError('injectImage: 颜色数超过 255（+透明）上限');
      }
      if (strict && paletteMap.size >= 256) {
        throw new EmblemFormatError(
          'injectImage: 第 257 个颜色项会溢出 1 字节索引（上游此处静默截断 ⇒ 串色）；strict=false 可复刻该行为',
        );
      }
      paletteMap.set(c, paletteMap.size);
      writePalette(paletteMap.get(c) as number, c);
    }

    const slot = paletteMap.get(c) as number;
    const p = isLr ? slot : UNSCRAMBLE_LUT[slot & 0xff];
    // ⚠ 复刻 C++ 的 `uint8_t` 隐式截断：`strict=false` 时索引可能是 256，
    //    写进 1 字节字段就变成 0（= 透明项）—— 这正是上游 257 色的失败方式。
    const pos = offsetIndex(i + imageOffset, base);
    byteAt(save, pos);
    save[pos] = p & 0xff;
  }

  // ★★ 0.19（D22）：**必须把 `applyChecksums()` 的返回值交回调用方**。
  //   缓冲区偏短时它会换底层数组（"校验之后那 10 字节"是切片赋值 ⇒ Python 也在这里扩容），
  //   原先这里丢掉了返回值 ⇒ 尾字节与 18 段校验全写进了被丢弃的那一份，**不报错、静默无效**
  //   （实测 `injectImage(0x443F 的缓冲)` 之后 `verifyChecksums` 18 段全不过）。
  return applyChecksums(save);
}

/**
 * 辅助：按上游规则把 RGBA 图像量化成 (索引缓冲, 调色板 u32 列表)。
 *
 * 便于检查"这张图会被压成几个颜色 / 索引怎么排"。
 * ⚠ 这里**不做**乱序重排（与 Python 版一致：它是给分析用的，不是给写入用的）。
 */
export function injectPixelsToIndices(image: Uint8Array): { indices: Uint8Array; palette: number[] } {
  const paletteMap = new Map<number, number>();
  paletteMap.set(packColor(0, 0, 0, 0), 0);
  const indices = new Uint8Array(NUM_PIXELS);
  for (let i = 0; i < NUM_PIXELS; i++) {
    let c = 0;
    if (image[i * 4 + 3] === 0xff) {
      c = packColor(image[i * 4], image[i * 4 + 1], image[i * 4 + 2], 0x80);
    }
    if (!paletteMap.has(c)) {
      // ★ 0.19（D25）：256 个不透明色 + 透明 = 需要 257 个槽位 ⇒ 索引 256 写进 `Uint8Array`
      //   会**回绕成 0**（把实色像素静默变成"透明洞"）。Python 参考实现在这里抛 `ValueError`。
      if (paletteMap.size >= 256) {
        throw new EmblemFormatError(
          'injectPixelsToIndices: 颜色数超过 256（含透明）—— 1 字节索引装不下（Python 版此处抛 ValueError）',
        );
      }
      paletteMap.set(c, paletteMap.size);
    }
    indices[i] = paletteMap.get(c) as number;
  }
  const inv = new Map<number, number>();
  for (const [k, v] of paletteMap) inv.set(v, k);
  const palette: number[] = [];
  for (let i = 0; i < inv.size; i++) palette.push(inv.get(i) as number);
  return { indices, palette };
}

// --------------------------------------------------------------------------
// 空白块 / 编码 / 存档识别
// --------------------------------------------------------------------------

/**
 * 造一个空白徽章存档（全部透明）。
 *
 * `baseOffset > 0` 时在前面塞 baseOffset 个 0x00 字节（模拟容器/记忆卡文件），
 * 并把 12 字节魔数写在徽章块起点上——这样 `findOffset()` 才找得到。
 *
 * ★ `headerTail`：非 LR 的 0x14..0x1C 那 9 字节**作品常量**。
 *   **不给就填 0，而 0 与游戏自己的产物逐字节不同** —— 要造一份真的能给游戏用的
 *   非 LR 徽章，必须传它（用 `headerTailFromSave()` 从同作品的真实存档取，或查
 *   `KNOWN_HEADER_TAIL`）。LR 没有这个字段，传了也会被忽略。
 *   （"游戏是否真的校验它"记为 [待复测]；一条硬理由是空白块必须能逐字节复原游戏产物。）
 *
 * ★ `lrHeader`：**LR 的 4 字节块头**（`00 44 00 00`，见 `LR_EMBLEM_HEADER`）。
 *   不传就用那个实测常量。⚠ 写成 0 会让游戏**直接卡死**，别关掉 `withHeader`。
 *
 * ★ 末段（第 18 段）校验由 `applyChecksums()` 按**真实位置**写好，并会一并保证
 *   校验之后那 10 字节要么是游戏写下的真值、要么补成 `01 00*9`。要"从零造一份能用的
 *   徽章"，推荐直接用 `encodeEmblem()`（它还会把未用调色板项填成游戏惯例的
 *   `00 00 00 80`）。
 */
export function makeBlankSave(
  isLr = false,
  baseOffset = 0,
  withHeader = true,
  headerTail: Uint8Array | null = null,
  lrHeader: Uint8Array | null = null,
): Uint8Array {
  return blankSaveWithBackend(isLr, baseOffset, withHeader, headerTail, lrHeader, true);
}

/**
 * `makeBlankSave()` 的实现体；`applyChecksumsAtEnd=false` 时**不**算校验（只给 `encodeEmblem` 用）。
 *
 * ★ 为什么需要这个开关：`makeBlankSave()` 公开语义是"给我一份**自洽**的空白块"
 *   （测试直接断言 `verifyChecksums(save).ok === true` / 尾巴 `01 00*9` / 也满足上游写法
 *   —— 那些断言都依赖这一步），所以它必须继续算。
 *   但 `encodeEmblem()` 的流程是 `makeBlankSave → injectImage → fillUnusedPalette → applyChecksums`：
 *   最后那次会把 18 段**全部**重算 ⇒ 中间这一次的产物**立刻作废**（白跑一遍 17472 字节）。
 *   `encodeEmblem` 改调这个开关为 false 的版本即可省掉它 ——
 *   **最终字节一个都不变**（`core.test.ts` 里 20+ 个真实样本的 `reencodedSha256` 与 Python
 *   参考实现逐字节相同，就是这次改动的硬判据）。
 *   ⚠ 被跳过的只有"算校验"这一件事：alpha（0x4434）与那 10 字节尾巴都由最后的
 *     `applyChecksums()` 统一写好（`injectImage` / `fillUnusedPalette` 都不会写尾巴那一段）。
 */
function blankSaveWithBackend(
  isLr: boolean,
  baseOffset: number,
  withHeader: boolean,
  headerTail: Uint8Array | null,
  lrHeader: Uint8Array | null,
  applyChecksumsAtEnd: boolean,
): Uint8Array {
  // ★ 0.19（D25）：`baseOffset` 必须是整数。原先 `new Uint8Array(17473.5)` 会被静默截断成 17473
  //   ⇒ 造出一个长度"多 1 字节"的块，`saveKind()` 于是判成 `container`（Python 在这里抛 TypeError）。
  if (!Number.isInteger(baseOffset) || baseOffset < 0) {
    throw new EmblemFormatError(`makeBlankSave: baseOffset 必须是 >= 0 的整数（收到 ${baseOffset}）`);
  }
  // ⚠ LR + baseOffset > 0 是不可用的组合（`isLrSave()` 只看总长度；总长 ≤ 0x4440 时会被当成非 LR）
  //   —— 原先只在 `baseOffset` 的参数说明里写反了，这里补一条显式警告。
  if (isLr && baseOffset > 0) {
    throw new EmblemFormatError(
      'makeBlankSave: LR 布局不支持 baseOffset（isLrSave() 只按总长度判定，带偏移后必然判错档）',
    );
  }
  const size = isLr ? LR_SAVE_SIZE : SAVE_SIZE;
  const save = new Uint8Array(baseOffset + size);
  if (withHeader) {
    if (isLr) {
      // ★ LR 也要写块头（Python 版曾在这里漏掉 ⇒ 游戏直接卡死）
      const hdr = lrHeader ?? LR_EMBLEM_HEADER;
      if (hdr.length !== LR_EMBLEM_HEADER.length) {
        throw new EmblemFormatError(`makeBlankSave: lrHeader 必须是 ${LR_EMBLEM_HEADER.length} 字节`);
      }
      save.set(hdr, baseOffset);
    } else {
      save.set(EMBLEM_HEADER, baseOffset);
      if (headerTail !== null) {
        if (headerTail.length !== HEADER_TAIL_LEN) {
          throw new EmblemFormatError(`makeBlankSave: headerTail 必须是 ${HEADER_TAIL_LEN} 字节`);
        }
        save.set(headerTail, baseOffset + HEADER_TAIL_OFF);
      }
    }
  }
  if (applyChecksumsAtEnd) applyChecksums(save);
  return save;
}

/**
 * 从一份**真实的非 LR 徽章存档**里取出那 9 字节作品常量（0x14..0x1C）。
 *
 * 创建新徽章时**必须**用它（或查 `KNOWN_HEADER_TAIL`）填进空白块 —— 否则写出来的块
 * 与游戏自己的产物不是逐字节相同。**不要猜值**：它是作品级常量。
 * （"游戏是否真的校验这 9 字节"记为 [待复测]，见上方注释；照抄真实存档的做法不变。）
 *
 * ★★ 0.20 修正（形态校验）：本函数只管**非 LR** 的 9 字节作品常量 —— LR 块头是另外 4 字节
 *   （`lrHeaderFromSave()`），偏移与长度都不一样。原先它对任何输入都直接
 *   `subarray(base + 0x14, base + 0x14 + 9)`：
 *     · 喂 LR 存档（0x4420）⇒ `base = 0`、**静默返回图像里的 9 个字节**（看着像"作品常量"，
 *       其实完全是别的数据）—— 与全模块"越界/形态不符就抛 `EmblemFormatError`"的纪律不符；
 *     · 喂 0 字节缓冲 ⇒ 返回**空数组**（`subarray` 越界会自己夹取），同样静默。
 *   现在这两种都显式抛错，错误信息里点名"**这是非 LR 的东西**"。
 */
export function headerTailFromSave(save: Uint8Array): Uint8Array {
  if (isLrSave(save)) {
    throw new EmblemFormatError(
      `headerTailFromSave: 这是 LR 存档（${save.length} 字节），没有非 LR 的 ${HEADER_TAIL_LEN} 字节作品常量` +
        '（0x14..0x1C）—— LR 的块头是 4 字节 `00 44 00 00`，请用 lrHeaderFromSave()',
    );
  }
  const base = blockBase(save);
  const o = base + HEADER_TAIL_OFF;
  if (o < 0 || o + HEADER_TAIL_LEN > save.length) {
    throw new EmblemFormatError(
      `headerTailFromSave: 缓冲区装不下 0x${HEADER_TAIL_OFF.toString(16)}..0x${
        (HEADER_TAIL_OFF + HEADER_TAIL_LEN - 1).toString(16)} 这 ${HEADER_TAIL_LEN} 字节` +
        `（块起点 0x${base.toString(16)}、长度 ${save.length}）—— 这不是一份非 LR 的徽章存档`,
    );
  }
  // ★ 0.19（D24）：**必须显式复制**。`save.slice()` 在 `save` 是 Node `Buffer` 时返回的是
  //   **视图**（`Buffer.prototype.slice` 与 `Uint8Array.prototype.slice` 语义相反）⇒
  //   调用方改返回值会改到"源存档"。`new Uint8Array(subarray)` 对两种类型都是逐元素复制。
  return new Uint8Array(save.subarray(o, o + HEADER_TAIL_LEN));
}

/** 从一份**真实的 LR 徽章存档**里取出那 4 字节块头（实测都是 `00 44 00 00`）。 */
export function lrHeaderFromSave(save: Uint8Array): Uint8Array {
  const base = blockBase(save);
  return new Uint8Array(save.subarray(base, base + LR_EMBLEM_HEADER.length));
}

/** 这份存档里**被像素引用过**的调色板槽号（已还原乱序映射），升序。 */
export function usedPaletteSlots(save: Uint8Array): number[] {
  const isLr = isLrSave(save);
  const base = blockBase(save);
  const imageOffset = isLr ? LR_IMAGE_OFFSET : IMAGE_OFFSET;
  const set = new Set<number>();
  for (let i = 0; i < NUM_PIXELS; i++) {
    const p = offsetIndex(imageOffset + i, base);
    if (p < 0 || p >= save.length) {
      throw new EmblemFormatError(`usedPaletteSlots: 像素数据越界（i=${i}, 偏移 0x${p.toString(16)}）`);
    }
    set.add(isLr ? save[p] : UNSCRAMBLE_LUT[save[p]]);
  }
  return Array.from(set).sort((a, b) => a - b);
}

/**
 * 把**没有被任何像素引用**的调色板项填成 `rgba`（默认 `00 00 00 80`），返回填了几项。
 *
 * 为什么要填：游戏自己写的每一份非 LR 存档，**256 项里一个全零项都没有**
 * （槽 0 除外）；未用项的 alpha 一律是 `0x80`。`injectImage` 只写用到的项，
 * 其余留 0，与游戏产物不同。
 *
 * ⚠ 只影响"未用项"，因此**不改变图像**；但会改变末段校验的取值（这是正常的）。
 *   槽 0（背景/透明）永远保持 `00 00 00 00`，不动。
 */
export function fillUnusedPalette(
  save: Uint8Array,
  rgba: [number, number, number, number] = [0, 0, 0, PALETTE_ALPHA_OPAQUE],
): number {
  const isLr = isLrSave(save);
  const base = blockBase(save);
  const imageOffset = isLr ? LR_IMAGE_OFFSET : IMAGE_OFFSET;
  const used = new Set<number>(usedPaletteSlots(save));
  let n = 0;
  for (let k = 1; k < 256; k++) {
    if (used.has(k)) continue;
    // 两种布局下，调色板项都按槽号顺序存放（非 LR 的"乱序"只体现在像素索引上）
    for (let ch = 0; ch < 4; ch++) {
      const pos = offsetIndex(imageOffset + NUM_PIXELS + k * 4 + ch, base);
      byteAt(save, pos);
      save[pos] = rgba[ch];
    }
    n += 1;
  }
  return n;
}

/**
 * ★ 推荐入口：把 128×128 RGBA8888 图像编成一份**能被游戏接受**的徽章存档。
 *
 * 比"`makeBlankSave` + `injectImage`"多做了三件必需的事：
 *   · 填上块头里的作品字段（非 LR 是 9 字节 `headerTail`；LR 是 4 字节 `00 44 00 00`）；
 *   · 末段校验按真实位置写（见 `applyChecksums`）；
 *   · 未用调色板项按游戏惯例填成 `00 00 00 80`（`fillUnused=true`）。
 *     ★ 实机已确认**不是硬性必需**（不填也正常读取），填它只是让输出与游戏产物同形）。
 *
 * `headerTail` 从同作品的真实存档里读（`headerTailFromSave()`），**不要猜**。
 *
 * ★ 0.20：`makeBlankSave()` 那一步**不算校验**（`blankSaveWithBackend(…, false)`）。
 *   理由：`makeBlankSave()` 内部会 `applyChecksums()`，而这里紧接着的 `injectImage()` /
 *   `fillUnusedPalette()` 必然把 18 段里的 17 段都改掉 ⇒ 那一次校验**立刻作废**，
 *   最后 `applyChecksums()` 还要把 18 段全部重算一遍。省掉它的**最终字节完全不变**
 *   （`core.test.ts` 用 20+ 个真实样本的 `reencodedSha256` 与 Python 参考实现逐字节对拍）。
 */
export function encodeEmblem(image: Uint8Array, options: EncodeEmblemOptions = {}): Uint8Array {
  const isLr = options.isLr ?? false;
  const headerTail = options.headerTail ?? null;
  const fillUnused = options.fillUnused ?? true;
  const lrHeader = options.lrHeader ?? null;

  // ⚠ 最后一个 `false` = "先别算校验"（见上面那段说明）；最终校验在 return 那一行统一写。
  let save = blankSaveWithBackend(isLr, 0, true, headerTail, lrHeader, false);
  save = injectImage(save, image);
  if (fillUnused) fillUnusedPalette(save);
  return applyChecksums(save);
}

/** 尽力判断这是什么。返回 'emblem-raw' / 'emblem-lr' / 'container' / 'unknown'。 */
export function saveKind(save: Uint8Array): SaveKind {
  const n = save.length;
  if (n === LR_SAVE_SIZE) return 'emblem-lr';
  if (n === SAVE_SIZE) return 'emblem-raw';
  if (n > SAVE_SIZE) {
    try {
      findOffset(save);
      return 'container';
    } catch {
      return 'unknown';
    }
  }
  return 'unknown';
}
