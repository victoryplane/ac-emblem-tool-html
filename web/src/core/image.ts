/**
 * AC PS2 徽章 —— 图像处理管线（TypeScript，零依赖，纯函数，确定性）。
 *
 * ==========================================================================
 * 职责边界（SPEC.md §五 / 本文件的设计前提）
 * ==========================================================================
 * 浏览器里 **canvas 只负责"解码"**（任意格式 → RGBA 像素）；本文件里的
 * 取景 / 缩放 / alpha 二值化 / 减色 **全部是纯 TS**，不碰任何 DOM/canvas API。
 *
 * 理由（为什么这样切）：
 *   · 这些步骤是**最容易出错**的部分（缩放核、二值化阈值、中位切分），
 *     放在纯函数里就能在 Node 里被夹具测试（`node web\test\image.test.ts`），
 *     不必开浏览器、不必装 canvas/node-canvas；
 *   · 同一个函数将来直接给 UI 预览与写卡两条路径共用，不会出现"预览好看、
 *     写进去变样"的两套实现。
 *
 * ==========================================================================
 * 与参考实现的对应关系（`tools/prepare_image.py` + `docs/01-项目理解/03-图片处理管线.md`）
 * ==========================================================================
 * 文档 §九 给的推荐顺序（照抄，每步都留独立判据）：
 *
 *     1. 解码任意格式            → RGBA 缓冲        （本文件之外：canvas）
 *     2. alpha 二值化（默认 128）                    → binarizeAlpha()
 *     3. 缩放（一律缩到目标尺寸，不要只缩大图）      → fitToTarget()
 *     4. 再二值化一次 alpha      ← 缩放会造出新的半透明像素
 *     5. 减色到 ≤255 色                              → quantizeOpaque()
 *     6. ★ 独立复核：不透明色数 ≤ 255 且 半透明 == 0  → checkCompliance()
 *     7. 预览按"游戏会看到的样子"（索引 0 = 透明）
 *        ⇒ 本文件输出的 `indices` / `palette` 就是索引口径的（见下"索引 0 约定"）
 *
 * ★ 与 `prepare_image.py` 的**刻意差异**（都不是"改进"，是判据不同）：
 *   1. `prepare_image.py` 只支持"缩放一步到位 + 只缩 >128 的"上游路线；
 *      本实现把**取景**独立出来（contain / cover / stretch / manual），
 *      因为 UI 默认直接进"手动"（SPEC.md §五 表 ②）。
 *   2. 缩放核不复刻 Pillow 的 LANCZOS（文档明说不可复刻）。本实现自己写两个核：
 *      `nearest` 与 `smooth`（面积平均，见 smoothFit 注释）。
 *   3. 中位切分不复刻 Pillow 的 MEDIANCUT 细节（同文档结论），但**算法族相同**
 *      （最长轴 + 中位切分），且保留了"只对不透明像素减色、透明像素不占槽位"
 *      这条**判据性**的规则（文档 §六 表格里那条）。
 *   4. `prepare_image.py` 保证"不透明色数 ≤ N"；本实现额外保证
 *      **"≤ N 时无损"**（见 quantizeOpaque 的 exact 路径）—— 这是 M2 的核心判据。
 *
 * ==========================================================================
 * 索引 0 约定（游戏口径，PORT-NOTES.md / 03-图片处理管线.md §四 ①）
 * ==========================================================================
 * ★ 实机定案：**游戏看的是"调色板索引 0"，不是 alpha 字节**。索引 0 = 背景/透明，
 *   它的 RGB 与 alpha 都不当颜色画。所以：
 *   · `quantizeOpaque()` 的 `palette[0..3]` 恒为 `00 00 00 00`，实色占索引 1..255；
 *   · 本文件输出的 `rgba` 也统一成"透明像素 alpha=0、其余 alpha=255"，
 *     这样既能被 `checkCompliance()` 判合规，也能直接喂
 *     `emblem.ts::encodeEmblem(rgba, …)`（`injectImage` 只把 alpha===0xFF 当实色）。
 * ⚠ 注意两者口径的差别：`rgba` 用 **alpha** 表达透明（给 encodeEmblem 吃），
 *   `indices`/`palette` 用 **索引 0** 表达透明（给游戏吃）；`prepareEmblem` 两个都给，
 *   并且保证 `indices[i] === 0 ⟺ rgba[i*4+3] === 0`（测试断言）。
 *
 * ==========================================================================
 * 环境约束（PORT-NOTES.md §一）
 * ==========================================================================
 * Node 24 原生跑 `.ts`（类型擦除）⇒ 只用**可擦除语法**（不要 enum / namespace /
 * 构造函数参数属性 / 装饰器）；相对 import 必须写全 `.ts` 扩展名。
 * 本文件**不 import 任何东西**（零依赖），所以也就没有扩展名问题。
 *
 * 纯函数 / 确定性：所有函数不修改入参，同输入必得同输出（无随机、无时间、
 * 无浮点累积依赖顺序以外的任何状态 —— 见 quantizeOpaque 里的"排序键为整数"说明）。
 * 性能：输出恒为 128×128 = 16,384 像素，逐像素 Math.round 只在输出侧发生。
 */

// --------------------------------------------------------------------------
// 常量与类型
// --------------------------------------------------------------------------

/** 目标宽度（PS2 = 128；PS1 将来 64 —— SPEC.md §五 "参数化尺寸"）。 */
export const TARGET_SIZE = 128;

/**
 * 实色上限。palette 恒为 256 项，其中索引 0 留给透明 ⇒ 实色最多 255。
 * 与 `emblem.ts::MAX_COLORS` / `acet_format.py::MAX_COLORS` 同值（不 import，
 * 避免核心之间互相耦合；测试里会断言三者一致）。
 */
export const MAX_OPAQUE_COLORS = 255;

/** alpha 二值化默认阈值。与 wxWidgets `ConvertAlphaToMask()` 默认一致（文档 §二 ①）。 */
export const DEFAULT_ALPHA_THRESHOLD = 128;

/** 不透明像素在调色板里的 alpha（游戏惯例 `xx xx xx 80`，PORT-NOTES.md §二 1）。 */
export const PALETTE_ALPHA_OPAQUE = 0x80;

/** 输入/输出的 RGBA 像素缓冲（每像素 4 字节，行优先，sRGB 非线性域直接算）。 */
export type RgbaImage = {
  data: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
};

/** RGBA 颜色（0..255）。 */
export type Rgba = { r: number; g: number; b: number; a: number };

export type FitMode = 'contain' | 'cover' | 'stretch' | 'manual';
export type ScaleKernel = 'nearest' | 'smooth';
/** 用户可选的核；`'auto'` 由 `chooseKernel()` 决定（判据见该函数）。 */
export type ScaleKernelChoice = ScaleKernel | 'auto';

export type FitOptions = {
  /** 目标宽度，默认 128。 */
  targetWidth?: number;
  /** 目标高度，默认 = targetWidth（方形）。 */
  targetHeight?: number;
  /** 取景模式，默认 `'contain'`（UI 默认给 `'manual'`，见 SPEC.md §五 ②）。 */
  mode?: FitMode;
  /** 缩放核，默认 `'auto'`。 */
  kernel?: ScaleKernelChoice;
  /**
   * `'manual'` 专用：相对"回到原始尺寸"的倍率。1 = 原始大小，>1 放大，<1 缩小。
   * ⚠ 与 UI 的滚轮缩放一致：**改了缩放不重置平移**（用户先平移再微调缩放是常见动作），
   *   所以 offset 与 scale 相互独立，不自动夹取（越界处补背景，这是"手动"的语义）。
   */
  scale?: number;
  /** `'manual'` 专用：目标图左上角对应源图的**像素坐标**（可为负/越界）。 */
  offsetX?: number;
  offsetY?: number;
  /** 背景色，默认全透明 `{0,0,0,0}`。 */
  background?: Rgba;
  /** `'auto'` 判据里的阈值：源图不透明色数 ≤ 它就用最近邻。 */
  autoNearestColorLimit?: number;
};

/** `fitToTarget` 的返回值。 */
export type FitResult = {
  data: Uint8ClampedArray; // 目标尺寸 × 4
  width: number;
  height: number;
  /** 实际使用的核（`'auto'` 已被解析）。 */
  kernel: ScaleKernel;
  mode: FitMode;
  /** 源像素 → 目标像素的仿射变换（`tx = sx * scale + offset`），测试与 UI 都用得上。 */
  transform: { scale: number; offsetX: number; offsetY: number };
  /** 目标图里完全等于背景色（逐通道）的像素数 —— "补了多少背景"。 */
  backgroundPixels: number;
};

export type BinarizeOptions = {
  /**
   * 去"半透明杂边"：把**孤立的**不透明像素（3×3 邻域内不透明邻居少于 minNeighbors）
   * 改成全透明。默认关闭 ⇒ 默认调用是**只读 alpha、逐像素独立**的幂等操作；
   * 打开后**不再幂等**（阈值化是幂等的，但去杂点是形态学操作）。
   * 为什么默认关：M2 判据 (b) 要求"≤255 色的合规图逐像素不变"，
   *   一个会自由删像素的默认值会让这条判据失去意义（UI 里是勾选项）。
   */
  despeckle?: boolean;
  /**
   * 判"孤立"的邻居下限（含自身，0..9）。默认 3 ⇒ 只删真正的孤立点 / 2 点连线端点。
   * 调大会更狠地啃掉细笔画（1 px 宽的发丝线会被整条吃掉），所以要用户显式选。
   */
  minNeighbors?: number;
};

export type QuantizeResult = {
  /** 1024 = 256×4；`palette[0..3]` 恒为 `00 00 00 00`（索引 0 = 透明/背景）。 */
  palette: Uint8Array;
  /** 16384 = 128×128 的**索引**（不是 RGBA）；透明像素 = 0。 */
  indices: Uint8Array;
  /** 用掉几个实色槽位（不含索引 0），≤ maxColors。 */
  usedColors: number;
  /** true ⇒ 输出与输入的每个不透明像素颜色**完全相同**（颜色数本来就没超限）。 */
  exact: boolean;
  /** 源图不透明像素用到几种不同 RGB（= prepare_image.py 的 count_opaque_colors）。 */
  sourceColors: number;
};

export type ComplianceResult = {
  ok: boolean;
  issues: string[];
  width: number;
  height: number;
  opaqueColors: number;
  semiTransparent: number;
  opaquePixels: number;
  transparentPixels: number;
};

export type PrepareOptions = FitOptions & {
  /**
   * 减色上限（默认 255）。UI 里可暴露给用户（SPEC.md §五 ⑤ 只做中位切分）。
   * ⚠ 传给 `emblem.ts::injectImage` 的**必须是 ≤255**：256 会让第 257 项溢出 1 字节
   *   索引、静默串成"透明洞"（03-图片处理管线.md §五）。
   */
  maxColors?: number;
  /** alpha 二值化阈值，默认 128。 */
  alphaThreshold?: number;
  /** 缩放后是否**再**二值化一次（默认 true；关掉只在"已是目标尺寸"时安全）。 */
  reBinarizeAfterFit?: boolean;
  /**
   * 二值化阶段是否去杂边（默认 false，理由见 BinarizeOptions.despeckle）。
   * 打开后不透明像素会变少 ⇒ 与源图不再逐像素等价（`report.lossless` 会随之变 false）。
   */
  despeckle?: boolean;
  despeckleMinNeighbors?: number;
};

export type PrepareReport = {
  /** 源图尺寸。 */
  sourceWidth: number;
  sourceHeight: number;
  mode: FitMode;
  /** 实际使用的缩放核（`'auto'` 已解析；`'contain'` 下尺寸恰好相等时也是它）。 */
  kernel: ScaleKernel;
  /** `'auto'` 的参考输入：**源图（未二值化）**不透明像素的不同 RGB 数。
   *  ⚠ 判核实际用的是**二值化之后**的色数（见 `fitToTarget`/`distinctOpaqueColors`）——
   *   这个字段只是"原图有多少实色"的参考值（0.19 修正了原来那句与代码不符的文档）。 */
  sourceOpaqueColors: number;
  /** 取景后补了多少个背景像素（= "图没铺满"的量）。 */
  backgroundPixels: number;

  /** ① 二值化（缩放前）改动了多少个像素的 alpha。 */
  binarizeChanged: number;
  /** ① 其中原来是半透明的像素数（= prepare_image.py 打印的"半透明像素 N 个已归一"）。 */
  semiTransparentBefore: number;
  /** ④ 缩放后再二值化改动了多少像素（插值造出来的新半透明边）。 */
  reBinarizeChanged: number;
  /** 去杂边删掉了多少像素（未开启 = 0）。 */
  despeckleRemoved: number;

  /** ⑤ 减色前的不透明色数。 */
  colorsBefore: number;
  /** ⑥ 减色后的不透明色数（独立复核过，与 palette/indices 一致）。 */
  colorsAfter: number;
  /** true ⇒ 与"二值化 + 取景后的图"逐像素等价（颜色数没超限，没走减色）。 */
  lossless: boolean;
  /** 是否真的跑过中位切分。 */
  quantized: boolean;

  /** ⑦ 合规结论（= `checkCompliance()` 的结果）。 */
  compliance: ComplianceResult;
};

export type PrepareResult = {
  /**
   * 目标尺寸 × 4，**游戏口径**：透明像素 alpha = 0（RGB 也清成 0），
   * 其余 alpha = 255。★ 这就是 `encodeEmblem(rgba, …)` 要吃的东西。
   */
  rgba: Uint8ClampedArray;
  palette: Uint8Array;
  indices: Uint8Array;
  width: number;
  height: number;
  report: PrepareReport;
};

// --------------------------------------------------------------------------
// 小工具
// --------------------------------------------------------------------------

function clamp8(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}

function assertImage(rgba: RgbaImage): void {
  if (!Number.isInteger(rgba.width) || !Number.isInteger(rgba.height)
    || rgba.width <= 0 || rgba.height <= 0) {
    throw new Error(`image: 尺寸非法（${rgba.width}×${rgba.height}）`);
  }
  if (rgba.data.length !== rgba.width * rgba.height * 4) {
    throw new Error(
      `image: 缓冲长度 ${rgba.data.length} 与尺寸 ${rgba.width}×${rgba.height} 不符（应为 ${rgba.width * rgba.height * 4}）`,
    );
  }
}

/** 三个通道 + alpha 全等才算同一个像素（测试与"补背景计数"用）。 */
function sameRgba(data: ArrayLike<number>, i: number, c: Rgba): boolean {
  const o = i * 4;
  return data[o] === c.r && data[o + 1] === c.g && data[o + 2] === c.b && data[o + 3] === c.a;
}

/**
 * 统计"逐通道等于背景色"的像素数 —— `backgroundPixels` 的**唯一**实现（0.19 抽出）。
 * 原先 `stretch` 的两条分支直接写死 0，与字段文档（"补了多少背景"）不符。
 */
function countBgPixels(data: Uint8ClampedArray, w: number, h: number, bg: Rgba): number {
  let n = 0;
  for (let i = 0; i < w * h; i++) if (sameRgba(data, i, bg)) n += 1;
  return n;
}

/**
 * 不透明像素（alpha === 255）用到几种不同 RGB。
 *
 * 口径与 `tools/prepare_image.py::count_opaque_colors()` **完全一致**：
 * 只有 `alpha === 0xFF` 才计入，半透明像素**既不算实色也不算背景**（它属于
 * 二值化该处理掉的东西）。这是"treat 257 色"判据的统一口径，别自己发明第二套。
 */
export function distinctOpaqueColors(rgba: RgbaImage): number {
  assertImage(rgba);
  const d = rgba.data;
  const seen = new Set<number>();
  for (let i = 0; i < rgba.width * rgba.height; i++) {
    const o = i * 4;
    if (d[o + 3] !== 0xff) continue;
    // 打包成 24 位整数：Set<number> 比 Set<string> 省得多（16k 像素逐点调用）
    seen.add((d[o] << 16) | (d[o + 1] << 8) | d[o + 2]);
  }
  return seen.size;
}

/** 半透明像素数（0 < alpha < 255）。合规判据之一是它必须为 0。 */
export function semiTransparentCount(rgba: RgbaImage): number {
  assertImage(rgba);
  const d = rgba.data;
  let n = 0;
  for (let i = 0; i < rgba.width * rgba.height; i++) {
    const a = d[i * 4 + 3];
    if (a > 0 && a < 255) n += 1;
  }
  return n;
}

/** 完全不透明像素数（alpha === 255）。 */
export function opaqueCount(rgba: RgbaImage): number {
  assertImage(rgba);
  const d = rgba.data;
  let n = 0;
  for (let i = 0; i < rgba.width * rgba.height; i++) if (d[i * 4 + 3] === 0xff) n += 1;
  return n;
}

/** 完全不透明像素的个数、色数与半透明个数 —— 一次遍历，UI 状态栏用。 */
export function imageStats(rgba: RgbaImage): {
  pixels: number;
  opaquePixels: number;
  transparentPixels: number;
  semiTransparent: number;
  opaqueColors: number;
} {
  assertImage(rgba);
  const d = rgba.data;
  const seen = new Set<number>();
  let opaque = 0;
  let semi = 0;
  const n = rgba.width * rgba.height;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const a = d[o + 3];
    if (a === 0xff) {
      opaque += 1;
      seen.add((d[o] << 16) | (d[o + 1] << 8) | d[o + 2]);
    } else if (a > 0) {
      semi += 1;
    }
  }
  return {
    pixels: n,
    opaquePixels: opaque,
    transparentPixels: n - opaque - semi,
    semiTransparent: semi,
    opaqueColors: seen.size,
  };
}

/** 是否所有像素的 alpha 都只有 0 / 255（"已经二值化过了"）。 */
export function isAlphaBinary(rgba: RgbaImage): boolean {
  assertImage(rgba);
  const d = rgba.data;
  for (let i = 0; i < rgba.width * rgba.height; i++) {
    const a = d[i * 4 + 3];
    if (a !== 0 && a !== 0xff) return false;
  }
  return true;
}

/** 拷贝一个 RGBA 缓冲（所有变换函数的输出都是新缓冲，绝不改入参）。 */
// --------------------------------------------------------------------------
// ② alpha 二值化
// --------------------------------------------------------------------------

/**
 * alpha 二值化：半透明 → 全透明 / 全不透明。
 *
 * 语义与两处参考实现严格一致：
 *   · 上游 `wxImage::ConvertAlphaToMask()`：`alpha >= 128` 变不透明，`< 128` 变全透明
 *     （03-图片处理管线.md §二 ①）；
 *   · `prepare_image.py`：`a.point(lambda v: 255 if v >= alpha_threshold else 0)`。
 * ⇒ 判据是 **`alpha >= threshold` 即不透明**（不是 `>`）。threshold=128 时
 *   128 算不透明 —— 这条别改，改了会和 Python 参考实现的计数对不上。
 *
 * ★ 变透明的像素**同时把 RGB 清成 0**（= prepare_image.py 第 ④ 步的口径：
 *   "透明像素统一成 (0,0,0,0)"）。为什么宁可丢 RGB：
 *   游戏只看索引 0，透明处底下的颜色永远不会显示；留着一个不一致的 RGB 会让
 *   "逐像素等价"这种断言变得没法写（同图两处透明像素 RGB 不同就算不等）。
 *
 * 返回**新缓冲**，不改入参（纯函数）。
 */
export function binarizeAlpha(
  rgba: RgbaImage,
  threshold = DEFAULT_ALPHA_THRESHOLD,
  opts: BinarizeOptions = {},
): Uint8ClampedArray {
  assertImage(rgba);
  const { width, height } = rgba;
  const src = rgba.data;
  const out = new Uint8ClampedArray(width * height * 4);
  const n = width * height;

  for (let i = 0; i < n; i++) {
    const o = i * 4;
    if (src[o + 3] >= threshold) {
      out[o] = src[o];
      out[o + 1] = src[o + 1];
      out[o + 2] = src[o + 2];
      out[o + 3] = 0xff;
    }
    // else 保持全 0（透明 + RGB 清零）
  }

  if (opts.despeckle) {
    return despeckleOpaque(out, width, height, opts.minNeighbors ?? 3);
  }
  return out;
}

/**
 * 去"半透明杂边"（形态学：先腐蚀后膨胀，只在这里用 3×3 结构元）。
 *
 * 判据：不透明像素的 3×3 邻域里（含自身）不透明邻居数 < `minNeighbors` ⇒ 改成透明。
 *   · 效果：删掉孤立点、单个像素宽的毛刺、以及二值化后整片只剩几个点的碎边；
 *   · 为什么用"邻域计数"而不是"面积过滤"：徽章是 128×128 的小图 + 硬边，
 *     3×3 邻域就是"这个点有没有同伴"的直观定义，且**开销恒定 O(n)**；
 *   · ⚠ 它**会吃掉 1 像素宽的细线**（发丝线、细边框）—— 所以默认关闭、由 UI 勾选。
 *
 * ★ 不是幂等操作：删掉一层后又会出现新的"孤立点"，重复调用会继续啃。
 *   实现里**读写分离**（判定全部基于入参副本），所以"跑一次"的结果是确定的，
 *   不会因为遍历顺序不同而不同。
 */
function despeckleOpaque(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  minNeighbors: number,
): Uint8ClampedArray {
  const src = new Uint8ClampedArray(data); // 判定只看向量化的输入快照 ⇒ 顺序无关
  const out = new Uint8ClampedArray(data);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (src[i * 4 + 3] !== 0xff) continue;
      let cnt = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= width) continue;
          if (src[(yy * width + xx) * 4 + 3] === 0xff) cnt += 1;
        }
      }
      if (cnt < minNeighbors) {
        const o = i * 4;
        out[o] = 0;
        out[o + 1] = 0;
        out[o + 2] = 0;
        out[o + 3] = 0;
      }
    }
  }
  return out;
}

// --------------------------------------------------------------------------
// ③ 取景 + 缩放
// --------------------------------------------------------------------------

/**
 * `'auto'` 缩放核的判据（★ SPEC.md §五 ③ "色数少/尺寸小（像素风）→ 最近邻"）。
 *
 * 三条规则，**顺序即优先级**（第一条命中就不再往下看）：
 *
 * ```
 * 1) 尺寸相同（scale == 1）        → 'nearest'（逐像素直接复制，不做任何采样）
 * 2) 正在缩小（scale < 1）         → 'smooth'
 *                                    ★ 例外：**整数倍缩小**（scale 的倒数是整数，
 *                                      例如 0.5 = 1/2、1/3、1/4）时用 'nearest'
 * 3) 放大或等比（scale >= 1）      → 色数 ≤ 256 ? 'nearest' : 'smooth'
 * ```
 *
 * ★★ **判据必须落在"实际缩放倍率"上，而不是"源尺寸 vs 目标尺寸"上。**
 *   这是本函数最要紧的一点，也是第一版写错、后来被测试逼着改掉的地方。
 *   两者在等比取景下的分歧点长这样（都实测过）：
 *
 *   | 源 → 128×128     | contain 倍率           | 第一版（比"尺寸是否整除"） | 现在（比实际倍率） |
 *   |---|---|---|---|
 *   | 128×256          | min(1, 0.5) = **0.5**  | nearest（凑巧对）  | nearest ✓ |
 *   | 100×256          | min(1.28, 0.5) = **0.5** | **smooth ✗**    | nearest ✓ |
 *   | 256×260          | min(0.5, 0.49) = 0.49  | smooth            | smooth ✓ |
 *
 *   原理：`contain` / `cover` 是**等比**取景，倍率由**限制边**决定，两轴**共用**
 *   同一个 scale；被缩的只有限制边那一轴，另一轴可能就是 1:1（**根本不采样**，
 *   谈不上"丢行丢列"）。所以正确的是"按两轴各自的 scale 判"：
 *   · 100×256 → 128×128：横向是 **1.28× 放大**（不丢列）、纵向是 2× 整数倍缩小
 *     ⇒ 两轴都保真 ⇒ `nearest`（第一版因为 100 % 128 ≠ 0 误判成 smooth）；
 *   · 300×300 → 128×128：两轴都是 0.4267 倍 ⇒ 非整数倍 ⇒ `smooth`；
 *   · `stretch` 是两轴独立倍率，直接分别代入。
 *
 *   所以唯一真值来源是 `fitToTarget` 算出来的 `scaleX` / `scaleY`，
 *   `fitToTarget` 与下面这个 `chooseKernel()` 共用同一个 `selectScaleKernel()`。
 *
 * 为什么是这个顺序（每一条都是踩出来的）：
 *
 * ① **尺寸相同必须走"复制"而不是"重采样"。**
 *    128×128 的图再"缩放到 128×128"在数学上是恒等映射，但走采样器就要经过
 *    浮点反算 + 取整，一旦边界上有 1e-15 的误差就会丢一列/丢一行（本文件的
 *    `nearestFit` 注释里记着这个坑）。这条规则把它变成"不可能出错"，
 *    也是判据 (b)（无损）的第一层保障。
 *
 * ② **缩小时默认平滑，只有"整数倍"才允许最近邻。**
 *    · 非整数倍缩放（300→128、502→128）用最近邻 = **不均匀抽样**：某些源行/列
 *      被整条跳过、另一些被取两次 ⇒ 像素画的线条粗细一段一段地变、边缘齿忽粗忽细。
 *      实测：300→128 的最近邻会**整行漏掉 172/300 个源行**（测试里有这条断言）。
 *    · 整数倍（256→128 = 1/2、384→128 = 1/3）用最近邻**能完美保真**：被抽到的
 *      源像素等距出现、网格对齐 ⇒ 像素画一点不糊、也不丢结构。
 *    · 判定用"倒数是不是整数"（`1/scale` 与它的四舍五入值在 1e-9 内相等），
 *      这样对浮点算出来的 scale 稳健（`1/0.5` 精确是 2，`1/(128/300)` 是 2.34…）。
 *
 * ③ **放大或等比时才看色数**（原来的判据，保留）：
 *    · 放大时最近邻**不会**抽样抖动（每个源像素被完整放大成方块），像素风图
 *      放大就该用最近邻保住硬边；
 *    · 照片 / 渐变图色数必然 > 256，放大也要平滑；
 *    · 阈值取 **256** 而不是 255：与"能不能塞进调色板"同量级，同时把
 *      "灰度渐变 200 色"这种像素风图正确归到 nearest；
 *    · 口径与 `distinctOpaqueColors()` 一致（只数 `alpha === 0xFF`）。
 *
 * ★ 与"手动开关"的关系：本函数**只在** `kernel: 'auto'`（默认值）时被调用。
 *   调用方显式传 `'nearest'` / `'smooth'` 时永远不会走到这里 —— 手动指定的
 *   优先级**永远高于** `'auto'`（SPEC.md §五 ③ "两种都留手动开关"）。
 *
 * ★ 已知边界（记录在案，不是 bug）：
 *   · 一张 1024×1024 的 40 色像素画缩到 128×128 是 **1/8 整数倍** ⇒ 走 `'nearest'`，
 *     完美保真（这正是规则 ② 想要的效果）；
 *   · 但 1000×1000 的同一张图（1/7.8125，**非**整数倍）会走 `'smooth'` ⇒ 硬边被糊
 *     一点。想保硬的用户手动切 `'nearest'` 即可（代价是接受抽样丢点）——
 *     这正是手动开关存在的意义。
 */
export function selectScaleKernel(
  scaleX: number,
  scaleY: number,
  colorCount: number,
  colorLimit = 256,
): ScaleKernel {
  const same = Math.abs(scaleX - 1) < 1e-9 && Math.abs(scaleY - 1) < 1e-9;
  if (same) return 'nearest'; // ① 尺寸相同 ⇒ 复制
  const shrinking = scaleX < 1 - 1e-9 || scaleY < 1 - 1e-9;
  if (shrinking) {
    // ② 缩小：两轴都必须"倒数恰好是整数"才准用最近邻
    const integerX = isIntegerReciprocal(scaleX);
    const integerY = isIntegerReciprocal(scaleY);
    return integerX && integerY ? 'nearest' : 'smooth';
  }
  // ③ 放大或等比 ⇒ 看色数
  return colorCount <= colorLimit ? 'nearest' : 'smooth';
}

/** `1 / scale` 是否（在 1e-9 内）是正整数。scale ≥ 1（放大/等比）时返回 true。 */
function isIntegerReciprocal(scale: number): boolean {
  if (!(scale > 0)) return false;
  if (scale >= 1 - 1e-9) return true; // 不缩小 ⇒ 这一轴"保真"
  const inv = 1 / scale;
  const r = Math.round(inv);
  return r >= 1 && Math.abs(inv - r) < 1e-9;
}

/**
 * 便捷版：只给"源尺寸 + 目标尺寸"时，按 **`contain` 等比取景**的倍率判核
 * （= `fitToTarget` 默认模式所算出来的那个 scale）。
 *
 * ⚠ 这个便利函数**只适用于等比取景**。`'stretch'` 是两轴独立倍率，必须直接调
 *   `selectScaleKernel(scaleX, scaleY, …)`；`fitToTarget` 内部就是这么做的。
 *   别拿这个函数去模拟 `cover`（`cover` 的倍率是 `max` 而不是 `min`）。
 *   （本函数曾经是"只看源/目标尺寸是否整除"的错误版本：`100×256 → 128×128`
 *     会被误判成 `smooth`，正确结果是 `nearest` —— 因为横向其实是 1.28× 放大。）
 */
export function chooseKernel(
  rgba: RgbaImage,
  targetWidth = TARGET_SIZE,
  targetHeight = targetWidth,
  colorLimit = 256,
): ScaleKernel {
  assertImage(rgba);
  // contain：等比缩到放得下 ⇒ scale = min(...)，与 fitToTarget 的 'contain' 分支同一式
  const scale = Math.min(targetWidth / rgba.width, targetHeight / rgba.height);
  return selectScaleKernel(scale, scale, distinctOpaqueColors(rgba), colorLimit);
}

/**
 * 面积平均（box / area-average）缩放 —— 本实现的 `'smooth'` 核。
 *
 * 为什么选它，而不是 Catmull-Rom / bicubic 这类"锐"的重采样核：
 *   ① **下采样不会混叠**：每个目标像素对源图的**支撑区**（footprint）内所有像素
 *      按覆盖面积加权平均，这正是"面积平均"的定义 ⇒ 没有摩尔纹/齿纹。
 *      bicubic 在缩小 >2× 时若不做预滤波反而会振铃、产生源图里没有的颜色；
 *   ② **不产生越界色**：权重非负、和为 1 ⇒ 输出色永远落在支撑区颜色的凸包内，
 *      不会出现 bicubic 的过冲（负 lobe）导致的新颜色 —— 减色前的色数不会虚增；
 *   ③ **放大时可退化**：放大时支撑区 ≤ 1 个源像素，结果就是最近邻/双线性的
 *      特例（覆盖面积权重），边缘不会被"无中生有"地锐化；
 *   ④ 实现简短、纯整数权重可复算 ⇒ 确定性好写。
 * ⚠ 代价：放大时**不如** bicubic 锐（会略微平一点）。徽章的目标尺寸是 128×128，
 *   实际场景绝大多数是"下采样"（照片/大图），所以这个代价换 ①② 是划算的。
 *
 * 数学：`scale = 目标长 / 源长`（fitToTarget 已经保证 > 0）。
 *   目标像素中心 `tx+0.5` 反算回源坐标 `sx = (tx + 0.5 - offsetX) / scale`，
 *   该像素的支撑区 = `sx ± 0.5/scale`（半宽 = 半个源像素在目标域的宽度）。
 *   权重 = 源像素与支撑区的重叠长度。
 */
function smoothFit(
  src: ArrayLike<number>,
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
  scale: number,
  offsetX: number,
  offsetY: number,
  bg: Rgba,
): { data: Uint8ClampedArray; backgroundPixels: number } {
  const out = new Uint8ClampedArray(dstW * dstH * 4);
  const inv = 1 / scale; // 支撑区半宽（源像素单位）
  const halfW = 0.5 * inv;

  // X 方向权重表：所有行共用（源图是行优先的，这样能少算一半）
  const xStart = new Int32Array(dstW);
  const xEnd = new Int32Array(dstW);
  const xWeights: Float64Array[] = new Array(dstW);
  for (let tx = 0; tx < dstW; tx++) {
    const center = (tx + 0.5 - offsetX) * inv;
    let s0 = Math.ceil(center - halfW);
    let s1 = Math.floor(center + halfW);
    if (s0 < 0) s0 = 0;
    if (s1 > srcW - 1) s1 = srcW - 1;
    const w = new Float64Array(Math.max(0, s1 - s0 + 1));
    for (let s = s0; s <= s1; s++) {
      let ww = Math.min(center + halfW, s + 1) - Math.max(center - halfW, s);
      if (!(ww > 0)) ww = 0;
      w[s - s0] = ww;
    }
    xStart[tx] = s0;
    xEnd[tx] = s1;
    xWeights[tx] = w;
  }

  for (let ty = 0; ty < dstH; ty++) {
    const centerY = (ty + 0.5 - offsetY) * inv;
    let s0 = Math.ceil(centerY - halfW);
    let s1 = Math.floor(centerY + halfW);
    if (s0 < 0) s0 = 0;
    if (s1 > srcH - 1) s1 = srcH - 1;
    if (s1 < s0) {
      // 目标像素完全落在源图外 ⇒ 整行背景
      for (let tx = 0; tx < dstW; tx++) {
        const o = (ty * dstW + tx) * 4;
        out[o] = bg.r;
        out[o + 1] = bg.g;
        out[o + 2] = bg.b;
        out[o + 3] = bg.a;
      }
      continue;
    }
    for (let tx = 0; tx < dstW; tx++) {
      const o = (ty * dstW + tx) * 4;
      const xa = xStart[tx];
      const xb = xEnd[tx];
      if (xb < xa) {
        out[o] = bg.r;
        out[o + 1] = bg.g;
        out[o + 2] = bg.b;
        out[o + 3] = bg.a;
        continue;
      }
      const xw = xWeights[tx];
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let wsum = 0;
      for (let sy = s0; sy <= s1; sy++) {
        const wy = Math.min(centerY + halfW, sy + 1) - Math.max(centerY - halfW, sy);
        if (!(wy > 0)) continue;
        const row = sy * srcW;
        for (let sx = xa; sx <= xb; sx++) {
          const wx = xw[sx - xa];
          if (!(wx > 0)) continue;
          const w = wx * wy;
          const so = (row + sx) * 4;
          r += src[so] * w;
          g += src[so + 1] * w;
          b += src[so + 2] * w;
          a += src[so + 3] * w;
          wsum += w;
        }
      }
      if (wsum > 0) {
        out[o] = clamp8(r / wsum);
        out[o + 1] = clamp8(g / wsum);
        out[o + 2] = clamp8(b / wsum);
        out[o + 3] = clamp8(a / wsum);
      } else {
        // 理论到不了这里（支撑区至少覆盖 1 个源像素）；兜底补背景而不是留黑
        out[o] = bg.r;
        out[o + 1] = bg.g;
        out[o + 2] = bg.b;
        out[o + 3] = bg.a;
      }
    }
  }
  let bgCount = 0;
  for (let i = 0; i < dstW * dstH; i++) if (sameRgba(out, i, bg)) bgCount += 1;
  return { data: out, backgroundPixels: bgCount };
}

/**
 * 最近邻 + 背景填充：直接按变换逐目标像素取样（越界补背景）。
 * 像素风图专用 —— 它保证输出里出现的颜色**全部来自源图**（不发明中间色）。
 *
 * ★ 取样规则是"目标像素中心落在源图哪个像素的方块内"，写出来就是
 *   `s = round(源坐标中心 - 0.5)`（四舍五入），**不是** `floor(源坐标中心)`。
 *   为什么强调：两者在数学上等价，但浮点误差会咬人 ——
 *   3×3 放大到 128×128 时，源像素 0 的中心的浮点结果可能算成
 *   `0.49999999999999645`，`floor` 会把它变成 **-1**（越界 ⇒ 内容最左一列
 *   凭空少一像素），四舍五入则稳稳落在 0。夹具里就有 3×3 / 1×1 这两种
 *   "刚好卡在边界"的图，这条是它们逼出来的。
 */
function nearestFit(
  src: ArrayLike<number>,
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
  scale: number,
  offsetX: number,
  offsetY: number,
  bg: Rgba,
): { data: Uint8ClampedArray; backgroundPixels: number } {
  const out = new Uint8ClampedArray(dstW * dstH * 4);
  const inv = 1 / scale;
  let bgCount = 0;
  for (let ty = 0; ty < dstH; ty++) {
    const cy = (ty + 0.5 - offsetY) * inv;
    const sy = Math.round(cy - 0.5);
    for (let tx = 0; tx < dstW; tx++) {
      const o = (ty * dstW + tx) * 4;
      if (sy < 0 || sy >= srcH) {
        out[o] = bg.r; out[o + 1] = bg.g; out[o + 2] = bg.b; out[o + 3] = bg.a;
        bgCount += 1;
        continue;
      }
      const cx = (tx + 0.5 - offsetX) * inv;
      const sx = Math.round(cx - 0.5);
      if (sx < 0 || sx >= srcW) {
        out[o] = bg.r; out[o + 1] = bg.g; out[o + 2] = bg.b; out[o + 3] = bg.a;
        bgCount += 1;
        continue;
      }
      const so = (sy * srcW + sx) * 4;
      out[o] = src[so];
      out[o + 1] = src[so + 1];
      out[o + 2] = src[so + 2];
      out[o + 3] = src[so + 3];
      if (sameRgba(out, ty * dstW + tx, bg)) bgCount += 1;
    }
  }
  return { data: out, backgroundPixels: bgCount };
}

/**
 * 取景 + 缩放：把任意尺寸的 RGBA 图放到目标尺寸的画布上。
 *
 * | 模式 | 缩放 | 位置 | 越界 |
 * |---|---|---|---|
 * | `contain` | 等比缩到**放得下**（`scale = min`） | 居中 | 四周补背景 |
 * | `cover` | 等比缩到**铺满**（`scale = max`） | 居中 | 裁掉，无背景 |
 * | `stretch` | 非等比拉满（x/y 各自缩放） | 铺满 | 无 |
 * | `manual` | 调用方给 `scale` | 调用方给 `offsetX/offsetY` | 补背景 |
 *
 * ★ 与上游 GUI 的关键差异（03-图片处理管线.md §二 ② "上游这里有个坑"）：
 *   上游 `if (宽>128 || 高>128) Rescale(128,128)` —— **只缩大图**，小图直接越界读。
 *   本实现**一律** 缩放/取景到目标尺寸，`contain` 下小图会被**放大**（补满可用区域）。
 *
 * ★ `contain` 的"补背景"是**逐像素等于背景色**的（不是"alpha=0"就算）：
 *   固定输出 4 个通道，测试才能断言"四角 == 背景"。
 *
 * 返回新缓冲。`transform` 给出源→目标的仿射变换，测试的"块平均色对比"
 * （判据 e）靠它把输出块映射回源图对应区域。
 */
export function fitToTarget(src: RgbaImage, opts: FitOptions = {}): FitResult {
  assertImage(src);
  const dstW = opts.targetWidth ?? TARGET_SIZE;
  const dstH = opts.targetHeight ?? dstW;
  if (!Number.isInteger(dstW) || !Number.isInteger(dstH) || dstW <= 0 || dstH <= 0) {
    throw new Error(`fitToTarget: 目标尺寸非法（${dstW}×${dstH}）`);
  }
  const mode: FitMode = opts.mode ?? 'contain';
  const bg: Rgba = opts.background ?? { r: 0, g: 0, b: 0, a: 0 };

  const sw = src.width;
  const sh = src.height;
  let scaleX: number;
  let scaleY: number;
  let offsetX = 0;
  let offsetY = 0;

  switch (mode) {
    case 'contain': {
      const s = Math.min(dstW / sw, dstH / sh);
      scaleX = s;
      scaleY = s;
      offsetX = (dstW - sw * s) / 2;
      offsetY = (dstH - sh * s) / 2;
      break;
    }
    case 'cover': {
      const s = Math.max(dstW / sw, dstH / sh);
      scaleX = s;
      scaleY = s;
      offsetX = (dstW - sw * s) / 2;
      offsetY = (dstH - sh * s) / 2;
      break;
    }
    case 'stretch': {
      scaleX = dstW / sw;
      scaleY = dstH / sh;
      break;
    }
    case 'manual': {
      const s = opts.scale ?? 1;
      if (!(s > 0)) throw new Error(`fitToTarget: manual 的 scale 必须 > 0（收到 ${s}）`);
      scaleX = s;
      scaleY = s;
      offsetX = opts.offsetX ?? 0;
      offsetY = opts.offsetY ?? 0;
      break;
    }
    default:
      throw new Error(`fitToTarget: 未知取景模式 '${String(mode)}'`);
  }

  // ⚠ stretch 是唯一允许 x/y 不同比例的模式。nearest 与 smooth 都按单一 scale 取样，
  //   所以这里用几何平均给它们一个"共同倍率"，而精确的像素映射走下面的
  //   perAxisScale 分支 —— 否则 stretch 会被算歪。
  const uniform = mode === 'stretch' ? Math.sqrt(scaleX * scaleY) : scaleX;

  // ★ `'auto'` 的判据必须用**算出来的真实倍率**（scaleX / scaleY），不能用"源尺寸
  //   是否被目标整除"—— 两者在等比取景下会给出不同答案（理由见 selectScaleKernel）。
  //   手动的 'nearest' / 'smooth' 在这里直接胜出，优先级永远高于 'auto'。
  const kernelChoice = opts.kernel ?? 'auto';
  const kernel: ScaleKernel = kernelChoice === 'auto'
    ? selectScaleKernel(scaleX, scaleY, distinctOpaqueColors(src), opts.autoNearestColorLimit ?? 256)
    : kernelChoice;

  let data: Uint8ClampedArray;
  let backgroundPixels: number;
  // ★★ 0.19（D20）：短路条件必须**真的是恒等映射**。原来只判 `sw === dstW && sh === dstH`，
  //   注释声称"尺寸相同 ⇒ scale = 1、没有越界，所以各种取景模式在这里都等价" ——
  //   对 `manual` 是**错的**（scale/offset 由调用方给）：128×128 的源图配 scale=4/offset=-192
  //   会原样返回输入、`backgroundPixels = 0`，而返回的 `transform` 却写着 scale:4
  //   ⇒ 像素与 `mapTargetToSource()` 的自述互相矛盾（拖了白框却什么都没发生）。
  //   现在只有"两轴倍率都是 1 且没有偏移"才走复制（`contain`/`cover`/`stretch` 在尺寸相同时
  //   天然满足；`manual` 必须自己满足）。
  const identity =
    sw === dstW && sh === dstH &&
    Math.abs(scaleX - 1) < 1e-9 && Math.abs(scaleY - 1) < 1e-9 &&
    Math.abs(offsetX) < 1e-9 && Math.abs(offsetY) < 1e-9;
  if (identity) {
    data = new Uint8ClampedArray(src.data);
    backgroundPixels = countBgPixels(data, dstW, dstH, bg);
  } else if (mode === 'stretch' && kernel === 'smooth') {
    data = smoothStretch(src.data, sw, sh, dstW, dstH, bg);
    // ★ 0.19（D23）：原先这里写死 0，与字段文档（"补了多少背景"）不符。
    backgroundPixels = countBgPixels(data, dstW, dstH, bg);
  } else if (mode === 'stretch') {
    data = nearestStretch(src.data, sw, sh, dstW, dstH);
    backgroundPixels = countBgPixels(data, dstW, dstH, bg);
  } else if (kernel === 'smooth') {
    const r = smoothFit(src.data, sw, sh, dstW, dstH, uniform, offsetX, offsetY, bg);
    data = r.data;
    backgroundPixels = r.backgroundPixels;
  } else {
    const r = nearestFit(src.data, sw, sh, dstW, dstH, uniform, offsetX, offsetY, bg);
    data = r.data;
    backgroundPixels = r.backgroundPixels;
  }

  return {
    data,
    width: dstW,
    height: dstH,
    kernel,
    mode,
    transform: { scale: uniform, offsetX, offsetY },
    backgroundPixels,
  };
}

/** 非等比面积平均（stretch 专用）：x/y 各自独立算支撑区。 */
function smoothStretch(
  src: ArrayLike<number>,
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
  bg: Rgba,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(dstW * dstH * 4);
  const sxScale = dstW / srcW;
  const syScale = dstH / srcH;
  const halfX = 0.5 / sxScale;
  const halfY = 0.5 / syScale;
  for (let ty = 0; ty < dstH; ty++) {
    const cy = (ty + 0.5) / syScale;
    const ys0 = Math.max(0, Math.ceil(cy - halfY));
    const ys1 = Math.min(srcH - 1, Math.floor(cy + halfY));
    for (let tx = 0; tx < dstW; tx++) {
      const o = (ty * dstW + tx) * 4;
      const cx = (tx + 0.5) / sxScale;
      const xs0 = Math.max(0, Math.ceil(cx - halfX));
      const xs1 = Math.min(srcW - 1, Math.floor(cx + halfX));
      if (ys1 < ys0 || xs1 < xs0) {
        out[o] = bg.r; out[o + 1] = bg.g; out[o + 2] = bg.b; out[o + 3] = bg.a;
        continue;
      }
      let r = 0; let g = 0; let b = 0; let a = 0; let wsum = 0;
      for (let sy = ys0; sy <= ys1; sy++) {
        const wy = Math.min(cy + halfY, sy + 1) - Math.max(cy - halfY, sy);
        if (!(wy > 0)) continue;
        for (let sx = xs0; sx <= xs1; sx++) {
          const wx = Math.min(cx + halfX, sx + 1) - Math.max(cx - halfX, sx);
          if (!(wx > 0)) continue;
          const w = wx * wy;
          const so = (sy * srcW + sx) * 4;
          r += src[so] * w; g += src[so + 1] * w; b += src[so + 2] * w; a += src[so + 3] * w;
          wsum += w;
        }
      }
      if (wsum > 0) {
        out[o] = clamp8(r / wsum); out[o + 1] = clamp8(g / wsum);
        out[o + 2] = clamp8(b / wsum); out[o + 3] = clamp8(a / wsum);
      } else {
        out[o] = bg.r; out[o + 1] = bg.g; out[o + 2] = bg.b; out[o + 3] = bg.a;
      }
    }
  }
  return out;
}

/** 非等比最近邻（stretch 专用）：铺满、无背景。 */
function nearestStretch(
  src: ArrayLike<number>,
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(dstW * dstH * 4);
  for (let ty = 0; ty < dstH; ty++) {
    const sy = Math.min(srcH - 1, Math.floor(((ty + 0.5) * srcH) / dstH));
    for (let tx = 0; tx < dstW; tx++) {
      const sx = Math.min(srcW - 1, Math.floor(((tx + 0.5) * srcW) / dstW));
      const so = (sy * srcW + sx) * 4;
      const o = (ty * dstW + tx) * 4;
      out[o] = src[so]; out[o + 1] = src[so + 1];
      out[o + 2] = src[so + 2]; out[o + 3] = src[so + 3];
    }
  }
  return out;
}

/**
 * 输出像素 → 源图坐标的映射（判据 e 用它把"输出块"映射回"源图区域"）。
 *
 * `fitToTarget` 返回的 `transform` 是"源 → 目标"；本函数求逆：
 *     源坐标 = (目标坐标 + 0.5 - offset) / scale - 0.5
 * 减 0.5 是因为我们返回的是**像素中心**（整数表示像素中心），不是像素边界。
 * 对 `nearest` 而言 `Math.round(结果)` 就是被采样的源像素下标
 * （与 `nearestFit` 里的 `Math.round(cx - 0.5)` 完全一致 —— 别写成 `floor`，
 *   浮点误差会在 3×3 放大这种"刚好卡边界"的情况下多丢一列，理由见 nearestFit）。
 */
export function mapTargetToSource(
  transform: { scale: number; offsetX: number; offsetY: number },
  tx: number,
  ty: number,
): { sx: number; sy: number } {
  const inv = 1 / transform.scale;
  return {
    sx: (tx + 0.5 - transform.offsetX) * inv - 0.5,
    sy: (ty + 0.5 - transform.offsetY) * inv - 0.5,
  };
}

// --------------------------------------------------------------------------
// ⑤ 减色（中位切分 / median cut）
// --------------------------------------------------------------------------

type Bucket = { colors: Uint32Array; counts: Uint32Array };

/**
 * 只对**不透明像素**做中位切分减色（median cut）。
 *
 * 这是文档 §六 表格里那条判据性规则的实现：
 *   > 中位切分，**只对不透明像素**，透明像素不占槽位
 *   （`prepare_image.py` 为了实现这一点，先把透明像素的 RGB 换成"第一个不透明像素的颜色"
 *     再量化 —— 那是 Pillow 的 API 限制导致的绕路；本实现直接只拿不透明像素建桶，
 *     不需要那个 hack，结果等价且更直白。）
 *
 * 算法（经典 median cut，与 Pillow 的 MEDIANCUT 同族，但**不追求逐像素一致**）：
 *   1. 统计每种不透明 RGB 的出现次数；
 *   2. 放进一个桶，重复直到桶数 == maxColors：
 *      a. 选**颜色数最多**的桶切（不是"像素最多"）—— 目标是把颜色空间切细，
 *         而不是把大色块切细；
 *      b. 沿该桶**范围最大**的通道（R/G/B）排序，在**中位**处切成两半
 *         （按颜色种类数的中位，不是像素数的中位）；
 *      c. 两边都非空才切；若所有桶都切不动（颜色数 ≤ maxColors）就提前结束；
 *   3. 每个桶的代表色 = 桶内各颜色**按像素数加权平均**（round）。
 *
 * ★ 无损保证（判据 b）：若源图不透明色数 ≤ maxColors，第 2 步一个桶都不切
 *   ⇒ 每个桶只有一种颜色 ⇒ 加权平均 == 那个颜色本身 ⇒ 输出逐像素等于输入，
 *   `exact = true`。这是**算法结构**保证的，不靠"事后检查"。
 *
 * ★ 索引 0 约定：`palette[0..3] = 00 00 00 00`，实色占 1..usedColors。
 *   实色的 alpha 写 `0x80`（游戏惯例，见 PALETTE_ALPHA_OPAQUE）；反正提取时
 *   "索引 ≠ 0 即不透明"（03-图片处理管线.md §四 ①）。
 *
 * 确定性：桶内排序键是整数（R<<16|G<<8|B），`Array.prototype.sort` 对整数比较
 * 的结果确定；桶的选择规则用"第一个最大者"，不依赖 Map/Set 的迭代顺序
 * （总桶数 ≤ 255，遍历开销可忽略）。
 */
export function quantizeOpaque(rgba: RgbaImage, maxColors = MAX_OPAQUE_COLORS): QuantizeResult {
  assertImage(rgba);
  if (!Number.isInteger(maxColors) || maxColors < 1 || maxColors > 255) {
    throw new Error(`quantizeOpaque: maxColors 必须在 1..255（收到 ${maxColors}）—— 索引 0 固定留给透明`);
  }
  const { width, height } = rgba;
  const d = rgba.data;
  const n = width * height;

  // ① 统计不透明颜色
  const countMap = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    if (d[o + 3] !== 0xff) continue;
    const key = (d[o] << 16) | (d[o + 1] << 8) | d[o + 2];
    countMap.set(key, (countMap.get(key) ?? 0) + 1);
  }
  const sourceColors = countMap.size;

  const palette = new Uint8Array(256 * 4);
  const indices = new Uint8Array(n);
  // palette[0] 恒为 00 00 00 00 ⇒ 索引 0 = 透明/背景（游戏口径）

  if (sourceColors === 0) {
    // 全透明图：这是"合法但没意义"的输入（prepare_image.py 会直接 SystemExit）。
    // 本实现不抛异常，交给 checkCompliance() 报"没有不透明像素"，
    // 因为 UI 需要能显示"当前是空白画布"而不是崩掉。
    return { palette, indices, usedColors: 0, exact: true, sourceColors: 0 };
  }

  const keys = new Uint32Array(sourceColors);
  const counts = new Uint32Array(sourceColors);
  {
    let k = 0;
    for (const [key, cnt] of countMap) {
      keys[k] = key;
      counts[k] = cnt;
      k += 1;
    }
  }

  // ② 建桶（每桶是一段"颜色 + 权重"）
  const buckets: Bucket[] = [{ colors: keys, counts }];
  const target = Math.min(maxColors, sourceColors);
  while (buckets.length < target) {
    // a. 选颜色数最多的桶
    let bi = -1;
    let best = 1; // 只有 1 种颜色的桶切不动
    for (let i = 0; i < buckets.length; i++) {
      if (buckets[i].colors.length > best) {
        best = buckets[i].colors.length;
        bi = i;
      }
    }
    if (bi < 0) break; // 所有桶都只有 1 色 ⇒ 已经无损，提前停

    const b = buckets[bi];
    // b. 找范围最大的通道
    let rmin = 255; let rmax = 0; let gmin = 255; let gmax = 0; let bmin = 255; let bmax = 0;
    for (let i = 0; i < b.colors.length; i++) {
      const c = b.colors[i];
      const r = (c >>> 16) & 0xff;
      const g = (c >>> 8) & 0xff;
      const bl = c & 0xff;
      if (r < rmin) rmin = r;
      if (r > rmax) rmax = r;
      if (g < gmin) gmin = g;
      if (g > gmax) gmax = g;
      if (bl < bmin) bmin = bl;
      if (bl > bmax) bmax = bl;
    }
    const rr = rmax - rmin;
    const gr = gmax - gmin;
    const br = bmax - bmin;
    // 排序键：主键 = 通道值；次键 = 打包值（保证同通道值的颜色顺序确定）
    const shift = rr >= gr && rr >= br ? 16 : gr >= br ? 8 : 0;
    const order = new Uint32Array(b.colors.length);
    for (let i = 0; i < order.length; i++) order[i] = i;
    const sorted = Array.from(order).sort((x, y) => {
      const cx = (b.colors[x] >>> shift) & 0xff;
      const cy = (b.colors[y] >>> shift) & 0xff;
      if (cx !== cy) return cx - cy;
      return b.colors[x] - b.colors[y];
    });

    const cut = sorted.length >> 1;
    if (cut <= 0 || cut >= sorted.length) break; // 理论到不了（长度 ≥ 2）
    const mk = (part: number[]): Bucket => {
      const ck = new Uint32Array(part.length);
      const cc = new Uint32Array(part.length);
      for (let i = 0; i < part.length; i++) {
        ck[i] = b.colors[part[i]];
        cc[i] = b.counts[part[i]];
      }
      return { colors: ck, counts: cc };
    };
    const left = mk(sorted.slice(0, cut));
    const right = mk(sorted.slice(cut));
    buckets[bi] = left;
    buckets.push(right);
  }

  // ③ 桶代表色 + 颜色 → 槽位
  const slotOf = new Map<number, number>();
  for (let i = 0; i < buckets.length; i++) {
    const bk = buckets[i];
    let sr = 0; let sg = 0; let sb = 0; let wsum = 0;
    for (let j = 0; j < bk.colors.length; j++) {
      const c = bk.colors[j];
      const w = bk.counts[j];
      sr += ((c >>> 16) & 0xff) * w;
      sg += ((c >>> 8) & 0xff) * w;
      sb += (c & 0xff) * w;
      wsum += w;
      slotOf.set(c, i + 1); // 索引 0 留给透明
    }
    const slot = i + 1;
    const off = slot * 4;
    palette[off] = wsum > 0 ? clamp8(sr / wsum) : 0;
    palette[off + 1] = wsum > 0 ? clamp8(sg / wsum) : 0;
    palette[off + 2] = wsum > 0 ? clamp8(sb / wsum) : 0;
    palette[off + 3] = PALETTE_ALPHA_OPAQUE;
  }

  // ④ 写索引
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    if (d[o + 3] !== 0xff) continue; // 透明（含半透明）一律索引 0
    const key = (d[o] << 16) | (d[o + 1] << 8) | d[o + 2];
    indices[i] = slotOf.get(key) as number;
  }

  return {
    palette,
    indices,
    usedColors: buckets.length,
    exact: buckets.length === sourceColors,
    sourceColors,
  };
}

// --------------------------------------------------------------------------
// ⑦ 合规检查
// --------------------------------------------------------------------------

/**
 * 合规检查（SPEC.md §五 ⑦ / 文档 §九 第 6 步）：
 *   · 尺寸必须是 `targetWidth × targetHeight`（默认 128×128）；
 *   · 不透明色数 ≤ 255；
 *   · 半透明像素 == 0；
 *   · ★ 附加一条本工具的**索引口径**断言（传了 `indices` 才查）：
 *     索引 0 只能出现在透明像素上，实色像素不许拿到索引 0
 *     —— 后者会在游戏里变成"透明洞"（03-图片处理管线.md §八 症状表）。
 *
 * 返回 `issues[]` 而不是抛异常：UI 要把这些原因**显示给人看**并拒绝写入
 * （SPEC.md §八 3 "不合规就拒绝写入"）。
 */
export function checkCompliance(
  rgba: RgbaImage,
  opts: { targetWidth?: number; targetHeight?: number; maxColors?: number; indices?: Uint8Array } = {},
): ComplianceResult {
  assertImage(rgba);
  const tw = opts.targetWidth ?? TARGET_SIZE;
  const th = opts.targetHeight ?? tw;
  const maxColors = opts.maxColors ?? MAX_OPAQUE_COLORS;
  const issues: string[] = [];

  const st = imageStats(rgba);
  if (rgba.width !== tw || rgba.height !== th) {
    issues.push(`尺寸 ${rgba.width}×${rgba.height} ≠ ${tw}×${th}`);
  }
  if (st.opaqueColors > maxColors) {
    issues.push(`不透明色数 ${st.opaqueColors} > ${maxColors}（第 ${maxColors + 1} 项起会把索引截断成 0 ⇒ 游戏里出现透明洞）`);
  }
  if (st.semiTransparent > 0) {
    issues.push(`半透明像素 ${st.semiTransparent} 个（存档里 alpha 只有 0x00/0x80 两种值，半透明会被整体当成透明）`);
  }
  if (st.opaquePixels === 0) {
    issues.push('没有任何不透明像素（全透明徽章能写但没意义）');
  }

  const indices = opts.indices;
  if (indices) {
    if (indices.length !== st.pixels) {
      issues.push(`indices 长度 ${indices.length} ≠ 像素数 ${st.pixels}`);
    } else {
      let idx0OnOpaque = 0;
      let opaqueNonZero = 0;
      for (let i = 0; i < st.pixels; i++) {
        const isOpaque = rgba.data[i * 4 + 3] === 0xff;
        if (indices[i] === 0) {
          if (isOpaque) idx0OnOpaque += 1;
        } else if (isOpaque) {
          opaqueNonZero += 1;
        }
      }
      if (idx0OnOpaque > 0) {
        issues.push(`索引 0 出现在 ${idx0OnOpaque} 个不透明像素上（索引 0 = 背景/透明，实色必须是 1..255）`);
      }
      if (opaqueNonZero !== st.opaquePixels) {
        issues.push(`有 ${st.opaquePixels - opaqueNonZero} 个不透明像素的索引是 0`);
      }
    }
  }

  return {
    ok: issues.length === 0,
    issues,
    width: rgba.width,
    height: rgba.height,
    opaqueColors: st.opaqueColors,
    semiTransparent: st.semiTransparent,
    opaquePixels: st.opaquePixels,
    transparentPixels: st.transparentPixels,
  };
}

// --------------------------------------------------------------------------
// 一站式入口
// --------------------------------------------------------------------------

/**
 * ★ 一站式入口：任意 RGBA 图 → 游戏能用的徽章图（+ 调色板 + 索引 + 报告）。
 *
 * 流程严格照文档 §九 的推荐顺序，并在每一步留下**可复算的数字**（report）：
 *
 *     ① binarizeAlpha（阈值 128）           → report.binarizeChanged / semiTransparentBefore
 *     ② fitToTarget（contain/cover/stretch/manual + auto 核）
 *     ③ binarizeAlpha 再来一次             → report.reBinarizeChanged
 *        （★ 缩放会插值出新的半透明像素；`prepare_image.py` 第 ② 步之后也重做了一遍）
 *     ④ quantizeOpaque（只碰不透明像素）    → palette / indices / report.colorsBefore/After
 *     ⑤ checkCompliance                     → report.compliance
 *
 * ★ 返回的 `rgba` 是**游戏口径**：透明像素 `(0,0,0,0)`，其余 `alpha = 255`。
 *   这正好是 `emblem.ts::encodeEmblem(rgba, { isLr, headerTail })` 的入参
 *   （`injectImage` 只把 `alpha === 0xFF` 当实色 ⇒ 两边口径天然对齐）。
 *
 * ★ 无损性（判据 b）：源图若"已是目标尺寸 + 不透明色数 ≤ maxColors + 无半透明像素"，
 *   则 ①②③ 都是恒等变换、④ 走 `exact` 路径 ⇒ 输出与输入逐像素等价。
 *   任何会破坏它的选项（`despeckle` / `kernel` 强制 smooth / 缩放）都会在 report 里
 *   留下痕迹（`lossless` / `despeckleRemoved` / `backgroundPixels`）。
 */
export function prepareEmblem(
  src: RgbaImage,
  options: PrepareOptions = {},
): PrepareResult {
  assertImage(src);
  const { width, height } = src;
  const threshold = options.alphaThreshold ?? DEFAULT_ALPHA_THRESHOLD;
  const maxColors = options.maxColors ?? MAX_OPAQUE_COLORS;
  const srcStats = imageStats(src);

  // ① 先二值化：与上游/参考实现一致（"若有 alpha → ConvertAlphaToMask"），
  //    这样送到缩放的是硬边图，最近邻路径也不会把半透明原样抄过去。
  // ★ 0.19（D21）：拆成"二值化"与"去杂边"两步，好让 `despeckleRemoved` 数**真的是去杂边删掉的**。
  //   原先它是 `(非全透明像素数) - (去杂后不透明像素数)`，把"被阈值判成透明"的半透明像素
  //   也算进了去杂边的账上（实测：整幅 alpha=100、开去杂边 ⇒ 报删了 16384 个，而这张图
  //   一个不透明像素都没有，去杂边什么都没删）。
  const binarizedOnly = binarizeAlpha(src, threshold);
  const binarized = options.despeckle === true
    ? despeckleOpaque(binarizedOnly, width, height, options.despeckleMinNeighbors ?? 3)
    : binarizedOnly;
  let binarizeChanged = 0;
  {
    const d = src.data;
    for (let i = 0; i < width * height; i++) {
      if (d[i * 4 + 3] !== binarized[i * 4 + 3]) binarizeChanged += 1;
    }
  }
  // 去杂边删掉了多少 = "二值化后是不透明、去杂边之后变成全透明"的那些像素（逐像素比）。
  let despeckleRemoved = 0;
  if (options.despeckle === true) {
    for (let i = 0; i < width * height; i++) {
      if (binarizedOnly[i * 4 + 3] === 0xff && binarized[i * 4 + 3] === 0) despeckleRemoved += 1;
    }
  }

  // ②③ 取景 + 缩放。
  //   ★ 这里**先探一次**取景（只为拿到"实际倍率"与 `'auto'` 选出的核），再用那个核
  //     正式取景。为什么值得多跑一次：
  //     · `'auto'` 的判据必须落在**实际缩放倍率**上（见 `selectScaleKernel` 的说明），
  //       而倍率只有 `fitToTarget` 知道（`contain` 的倍率由限制边决定，不是"源/目标"）。
  //       探针返回的 `transform.scale` 就是权威值 ⇒ 判核与取景**不可能不一致**；
  //     · 探针自己也用同一个 `'auto'` 判据选核，所以第二次取景可以锁定同一个核。
  //     代价 = 多一遍采样（128×128 的输出，微秒级），换掉的是"两处各算一套倍率、
  //     算歪一处就静默选错核"的风险 —— 值得。
  // ⚠ auto 核的色数口径：用**二值化之后**的图算，因为"不透明色数"的定义依赖
  //   alpha === 0xFF，半透明像素不算数。
  const fitKernelChoice = options.kernel ?? 'auto';
  const probe = fitToTarget({ data: binarized, width, height }, options); // kernel 默认 'auto'
  const kernel: ScaleKernel = fitKernelChoice === 'auto' ? probe.kernel : fitKernelChoice;
  const fit = fitKernelChoice === 'auto'
    ? probe // 探针已经是用 auto 选出的核做的取景 ⇒ 直接复用，省掉第二次采样
    : fitToTarget({ data: binarized, width, height }, { ...options, kernel });

  // ④ 缩放后**再**二值化一次
  const reBinarize = options.reBinarizeAfterFit !== false;
  const preFinal: Uint8ClampedArray = reBinarize
    ? binarizeAlpha({ data: fit.data, width: fit.width, height: fit.height }, threshold)
    : fit.data;
  let reBinarizeChanged = 0;
  if (reBinarize) {
    for (let i = 0; i < fit.width * fit.height; i++) {
      if (fit.data[i * 4 + 3] !== preFinal[i * 4 + 3]) reBinarizeChanged += 1;
    }
  }

  // ⑤ 减色
  const q = quantizeOpaque({ data: preFinal, width: fit.width, height: fit.height }, maxColors);

  // ⑥ 从 palette + indices 反推出**最终 RGBA**（游戏口径）。
  //    为什么要反推而不是直接用 preFinal：
  //      · preFinal 的颜色是量化的输入，量化后颜色可能被替换（有损时）；
  //      · 反推保证 `rgba` 与 `indices`/`palette` **永远自洽**
  //        （判据 f 要拿 rgba 去 encodeEmblem 再读回来逐像素比）。
  const n = fit.width * fit.height;
  const rgba = new Uint8ClampedArray(n * 4);
  const seenColors = new Set<number>();
  for (let i = 0; i < n; i++) {
    const slot = q.indices[i];
    const o = i * 4;
    if (slot === 0) continue; // 透明：留 0
    const p = slot * 4;
    const r = q.palette[p];
    const g = q.palette[p + 1];
    const b = q.palette[p + 2];
    rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b; rgba[o + 3] = 0xff;
    seenColors.add((r << 16) | (g << 8) | b);
  }

  const compliance = checkCompliance(
    { data: rgba, width: fit.width, height: fit.height },
    { targetWidth: options.targetWidth ?? TARGET_SIZE, targetHeight: options.targetHeight ?? (options.targetWidth ?? TARGET_SIZE), maxColors, indices: q.indices },
  );

  // ★ "无损"的判据：把最终 rgba 与**二值化后的源图**逐像素比一遍（不是靠推断）。
  //   为什么不用"q.exact && 尺寸相同 && …"这种条件式推断：那种写法要枚举所有
  //   可能改变像素的原因（背景填充、半透明改写、去杂边、复核），漏一条就变成
  //   "报告说无损、其实不等"。直接比一遍是**不可能骗人的**判据，
  //   而且成本只有 16k 次比较（≈ 一次 prepareEmblem 的一个零头）。
  let lossless = q.exact && binarized.length === rgba.length;
  if (lossless) {
    for (let i = 0; i < n && lossless; i++) {
      const o = i * 4;
      const aIn = binarized[o + 3];
      const aOut = rgba[o + 3];
      // 口径差异是允许的：源图"非全不透明"的像素在输出里必须是全透明
      if (aIn !== 0xff && aOut === 0) continue;
      if (aIn !== aOut) { lossless = false; break; }
      if (binarized[o] !== rgba[o] || binarized[o + 1] !== rgba[o + 1] || binarized[o + 2] !== rgba[o + 2]) {
        lossless = false;
      }
    }
  }

  return {
    rgba,
    palette: q.palette,
    indices: q.indices,
    width: fit.width,
    height: fit.height,
    report: {
      sourceWidth: width,
      sourceHeight: height,
      mode: fit.mode,
      kernel: fit.kernel,
      sourceOpaqueColors: srcStats.opaqueColors,
      backgroundPixels: fit.backgroundPixels,
      binarizeChanged,
      semiTransparentBefore: srcStats.semiTransparent,
      reBinarizeChanged,
      despeckleRemoved,
      colorsBefore: q.sourceColors,
      colorsAfter: seenColors.size,
      lossless,
      quantized: !q.exact,
      compliance,
    },
  };
}

