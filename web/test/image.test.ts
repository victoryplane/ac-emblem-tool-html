/**
 * 图像管线（`src/core/image.ts`）的测试 —— **零依赖**，Node 原生跑 `.ts`。
 *
 * 跑法（在项目根目录 `emblem-tool\` 下）：
 *
 *     python web\test\make_image_fixtures.py      # 先生成输入夹具（本例已随仓库提交）
 *     node   web\test\image.test.ts
 *
 * ==========================================================================
 * 判据来源（为什么这样测）
 * ==========================================================================
 * 本文件**不**与 Pillow 逐像素对齐 —— `docs\01-项目理解\03-图片处理管线.md` §六
 * 已定案：Pillow 的 LANCZOS 与 MEDIANCUT 属于**实现细节**，各库之间差几个 LSB、
 * 不保证逐像素一致（Pillow 文档只写 "a high-quality downsampling filter"，没有承诺可复刻）。
 * 硬对齐只会得到一份"看起来严谨、其实在比实现细节"的测试。改用 SPEC.md §九 M2 给的**自洽判据**：
 *
 *   (a) 几何正确性   —— 单像素 / 3×3 / 非方图在四种取景下的边界断言
 *   (b) ★ 无损性     —— "已是目标尺寸 + ≤255 色 + 无半透明"必须逐像素等价（最重要）
 *   (c) 合规性       —— 全部夹具：128×128 / 实色 ≤255 / 半透明 0 / 索引 0 只在透明像素上
 *   (d) 确定性       —— 同输入两次，palette / indices / rgba 的 SHA-256 相同
 *   (e) 感知合理性   —— 下采样后分块平均色 vs 源图对应区域（阈值理由见 PERCEPTUAL_*）
 *   (f) 对接         —— 输出喂给 emblem.ts 的 encodeEmblem：18/18 校验 + 读回来逐像素相同
 *   (g) 面积平均的支撑区 —— 与**本文件独立写的**教科书 box 逐像素对拍（缩小 / 放大 /
 *       非方形目标都覆盖），外加"全不透明的图放大后不许出现透明像素"这条回归。
 *
 * 另外附带一条**跨语言口径**检查：`prepare_image.py` 的合规统计（它用 Pillow）
 * 与 TS 侧的统计**必须相等** —— 这不是"逐像素对齐"，而是"两边对
 * '不透明色数 / 半透明像素数'的定义必须一致"，是能硬比、也应该硬比的那一档。
 *
 * 失败即非零退出，并逐条打印"哪一项、期望、实到"。
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MAX_OPAQUE_COLORS,
  PALETTE_ALPHA_OPAQUE,
  TARGET_SIZE,
  binarizeAlpha,
  checkCompliance,
  distinctOpaqueColors,
  fitToTarget,
  imageStats,
  isAlphaBinary,
  mapTargetToSource,
  opaqueCount,
  prepareEmblem,
  quantizeOpaque,
  selectScaleKernel,
  semiTransparentCount,
  type RgbaImage,
  type ScaleKernel,
} from '../src/core/image.ts';

import {
  MAX_COLORS,
  encodeEmblem,
  extractImage,
  verifyChecksums,
} from '../src/core/emblem.ts';

// --------------------------------------------------------------------------
// 极简测试框架（与 core.test.ts / card.test.ts 同风格：累计 pass / failures）
// --------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJ = resolve(HERE, '..', '..'); // web/test → emblem-tool
const IMGDIR = join(HERE, 'fixtures', 'images');

let pass = 0;
const failures: string[] = [];
const warnings: string[] = [];
/**
 * `--verbose`：把**每一条**通过的断言也打出来（默认只打失败）。
 * 用途：给人工复核"某一格到底测了什么"时用，例如
 *     node web\test\image.test.ts --verbose | Select-String "规则"
 * 默认安静（与 core.test.ts / card.test.ts 的观感一致）。
 */
const VERBOSE = process.argv.includes('--verbose');

function ok(cond: boolean, what: string, detail = ''): void {
  if (cond) {
    pass += 1;
    if (VERBOSE) console.log(`  ✓ ${what}${detail ? ` （${detail}）` : ''}`);
  } else {
    failures.push(detail ? `${what} — ${detail}` : what);
    if (VERBOSE) console.log(`  ✗ ${what}${detail ? ` — ${detail}` : ''}`);
  }
}

function eq(actual: unknown, expected: unknown, what: string): void {
  const a = String(actual);
  const e = String(expected);
  ok(a === e, what, `期望 ${e}，实到 ${a}`);
}

function section(title: string): void {
  console.log(`\n--- ${title} ---`);
}

/**
 * 测试专用便利版（**本地重写**，不是生产 API）：按 **`contain` 等比取景**的倍率判核。
 *
 * 它原来叫 `image.ts::chooseKernel()`，0.20 从核心层删掉了 —— 生产路径一个调用点都没有
 * （`fitToTarget` 直接调 `selectScaleKernel`），而它只对等比取景成立，留着容易被误用。
 * 这里保留**同一公式**（`scale = min(目标宽/源宽, 目标高/源高)`，两轴同一个 scale，
 * 色数口径 `distinctOpaqueColors`）⇒ 下面所有断言的含义与条数一个字不变。
 */
function containKernel(
  rgba: RgbaImage,
  targetWidth = TARGET_SIZE,
  targetHeight = targetWidth,
  colorLimit = 256,
): ScaleKernel {
  const scale = Math.min(targetWidth / rgba.width, targetHeight / rgba.height);
  return selectScaleKernel(scale, scale, distinctOpaqueColors(rgba), colorLimit);
}

function warn(msg: string): void {
  warnings.push(msg);
  console.log(`  ⚠ ${msg}`);
}

const sha256 = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex');

// --------------------------------------------------------------------------
// 夹具装载
// --------------------------------------------------------------------------

type FixtureRef = {
  ok?: boolean;
  size?: string;
  opaqueColors?: number;
  opaquePixels?: number;
  semiTransparentPixels?: number;
  rgbaSha256?: string;
  notes?: string[];
};

type FixtureEntry = {
  name: string;
  file: string;
  width: number;
  height: number;
  bytes: number;
  sha256: string;
  why: string;
  judge: string;
  sourceStats: {
    pixels: number; opaquePixels: number; transparentPixels: number;
    semiTransparentPixels: number; opaqueColors: number;
  };
  reference: FixtureRef;
};

type Fixture = RgbaImage & { entry: FixtureEntry; name: string };

const manifest = JSON.parse(readFileSync(join(IMGDIR, 'image-manifest.json'), 'utf8')) as {
  alphaThreshold: number;
  maxColors: number;
  targetSize: number;
  images: FixtureEntry[];
};

const fixtures: Fixture[] = manifest.images.map((entry) => {
  const raw = new Uint8Array(readFileSync(join(PROJ, entry.file)));
  return { data: raw, width: entry.width, height: entry.height, entry, name: entry.name };
});
const byName = new Map(fixtures.map((f) => [f.name, f]));
const get = (name: string): Fixture => {
  const f = byName.get(name);
  if (!f) throw new Error(`夹具里没有 ${name}`);
  return f;
};

/** 造一张合成图（不依赖夹具，用于边界断言）。 */
function makeImage(width: number, height: number, fn: (x: number, y: number) => number[]): RgbaImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const c = fn(x, y);
      const o = (y * width + x) * 4;
      data[o] = c[0]; data[o + 1] = c[1]; data[o + 2] = c[2]; data[o + 3] = c[3];
    }
  }
  return { data, width, height };
}

const px = (img: RgbaImage, x: number, y: number): number[] => {
  const o = (y * img.width + x) * 4;
  return [img.data[o], img.data[o + 1], img.data[o + 2], img.data[o + 3]];
};

const pxEq = (a: ArrayLike<number>, b: ArrayLike<number>): boolean => {
  for (let i = 0; i < 4; i++) if (a[i] !== b[i]) return false;
  return true;
};

const BG_TRANSPARENT = [0, 0, 0, 0];

/** 逐像素比较两张同尺寸图，返回第一处差异的说明（相同返回 null）。 */
function firstPixelDiff(a: RgbaImage, b: RgbaImage, note = ''): string | null {
  if (a.width !== b.width || a.height !== b.height) {
    return `${note}尺寸不同 ${a.width}×${a.height} vs ${b.width}×${b.height}`;
  }
  for (let i = 0; i < a.width * a.height; i++) {
    const o = i * 4;
    for (let k = 0; k < 4; k++) {
      if (a.data[o + k] !== b.data[o + k]) {
        const x = i % a.width;
        const y = Math.floor(i / a.width);
        return `${note}像素 (${x},${y}) 第 ${k} 通道：${a.data[o + k]} vs ${b.data[o + k]}`;
      }
    }
  }
  return null;
}

// --------------------------------------------------------------------------
// 感知比较工具（判据 e）
// --------------------------------------------------------------------------

/**
 * 区域 alpha 加权平均色。
 *
 * 口径：权重 = alpha/255（全透明像素权重 0、半透明按比例）。为什么按 alpha 加权
 * 而不是简单平均：徽章图**大部分可以是透明背景**，把透明像素的 RGB（本实现一律
 * 清零）算进去会让"平均色"变成背景色，测不出任何东西。
 *
 * ★ 在**同一个 alpha 口径**下做面积平均缩放，区域的加权平均是**不变式**：
 *   缩放不改变任何区域的 alpha 加权平均色（面积平均 = 区域内所有像素的加权和）。
 *   所以"输出区域均值 vs 源图对应区域均值"这个判据的**理论误差应该是 0**，
 *   实测残差只来自两处：`Math.round` 到 8 bit（单个像素的取整噪声 ≈ 0.5/覆盖面积）
 *   和缩放后 alpha 二值化在边缘处的覆盖变化。见 PERCEPTUAL_* 的阈值说明。
 */
function regionMean(img: RgbaImage, x0: number, y0: number, x1: number, y1: number):
{ r: number; g: number; b: number; w: number } {
  const cx0 = Math.max(0, Math.floor(x0));
  const cy0 = Math.max(0, Math.floor(y0));
  const cx1 = Math.min(img.width, Math.ceil(x1));
  const cy1 = Math.min(img.height, Math.ceil(y1));
  let r = 0; let g = 0; let b = 0; let w = 0;
  for (let y = cy0; y < cy1; y++) {
    for (let x = cx0; x < cx1; x++) {
      const o = (y * img.width + x) * 4;
      const wa = img.data[o + 3] / 255;
      r += img.data[o] * wa;
      g += img.data[o + 1] * wa;
      b += img.data[o + 2] * wa;
      w += wa;
    }
  }
  return { r: w ? r / w : 0, g: w ? g / w : 0, b: w ? b / w : 0, w };
}

function meanDiff(a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }): number {
  return Math.max(Math.abs(a.r - b.r), Math.abs(a.g - b.g), Math.abs(a.b - b.b));
}

/**
 * ★ 阈值理由（判据 e）：实测值写在这里，阈值 = 实测值 + 余量，不是随手定的数。
 *
 *   · 整幅区域均值差：实测 `photo-noise-300` = **0.004**、`soft-edge-140` = **0.76**、
 *     `banner-logo` contain/cover = **1.51 / 4.82**、其余全部 = **0.00**（见探针记录）。
 *     理论上这个量是**缩放不变式**（面积平均保区域加权和），残差只剩 8 bit 取整
 *     ⇒ 取 **2.0** 是它的 4 倍余量，
 *     而"整体错位一格"或"通道串位"在这个量级上会造成 **>20** 的差异
 *     （照片图相邻块基色差就有 100 左右），所以这个阈值既紧又不脆。
 *   · 逐 8×8 块均值差：实测 `photo-noise-300` max = **0.93**。
 *     块越小、取整噪声越大（块内像素少、覆盖权重不等），且它比整幅均值更能
 *     暴露"局部错位"。⇒ 取 **8.0**（约 4 倍余量）。
 *   · 不用 `soft-edge-140` / `banner-logo` 做逐块断言：它们**有半透明边或硬边**，
 *     二值化会把"亚像素级的边缘覆盖"量化成 0/1，块均值天然会有 10~25 的差异 ——
 *     那不是缩放错位，是二值化的固有代价（格式只有 1 bit 透明度，见文档 §二 ①）。
 *     这类图只用整幅均值断言。
 */
const PERCEPTUAL_WHOLE_MAX = 2.0;
const PERCEPTUAL_BLOCK_MAX = 8.0;
const PERCEPTUAL_BLOCK = 8;

/**
 * 整幅均值的阈值分两档，理由（都是实测值）：
 *   · **没有缩放**（`scale == 1`）：输出与源图是同一批像素，理论差 = 只有 8 bit 取整
 *     ⇒ 实测 0.00；取 **0.5**（既紧又不会因为取整翻车）。
 *   · **有缩放**：硬边/半透明图经二值化 + 面积平均后，区域均值会偏离源区域
 *     最多 ~5（实测 `banner-logo` 1.51 / 4.82、`soft-edge-140` 0.76）——
 *     这是"1 bit 透明度 + 4 px 周期图案降采样"的固有代价，不是错位
 *     （错位会到 20~100 量级）。⇒ 取 **8.0**。
 */
const PERCEPTUAL_WHOLE_MAX_NO_SCALE = 0.5;
const PERCEPTUAL_WHOLE_MAX_SCALED = 8.0;
const wholeLimit = (noScale: boolean): number =>
  (noScale ? PERCEPTUAL_WHOLE_MAX_NO_SCALE : PERCEPTUAL_WHOLE_MAX_SCALED);

/** nearest 逐块忠实性：只比"被实际抽到的源像素子集"，阈值 = 实测 + 余量。 */
const NEAREST_BLOCK_MAX = 4.0;

/**
 * 最近邻下采样的逐块忠实性：
 * 对每个输出 8×8 块，用 `mapTargetToSource` 的整数映射取出"应该被抽到的源像素"
 * （同一套 floor/round 规则），比它们的均值与输出块均值。
 * ★ 为什么这个比法比"整区域均值"更强：它把"输出块的抖动"归因到**具体的采样点**上，
 *   所以既能抓住错位（采样点与输出不对应），又不受"棋盘图案相位抖动"影响。
 */
function compareNearestBlocks(
  src: RgbaImage,
  out: RgbaImage,
  transform: { scale: number; offsetX: number; offsetY: number },
): { maxDiff: number; blocks: number; samples: number; worst: string } {
  let maxDiff = 0; let blocks = 0; let samples = 0; let worst = '';
  const B = PERCEPTUAL_BLOCK;
  for (let by = 0; by < out.height; by += B) {
    for (let bx = 0; bx < out.width; bx += B) {
      // 输出块均值
      const oa = regionMean(out, bx, by, bx + B, by + B);
      if (oa.w < B * B * 0.95) continue;
      // 被抽到的源像素（与 nearestFit 同一套整数映射：Math.round(源中心 - 0.5)）
      let r = 0; let g = 0; let b = 0; let n = 0;
      for (let y = by; y < by + B; y++) {
        for (let x = bx; x < bx + B; x++) {
          const p = mapTargetToSource(transform, x, y);
          const sx = Math.round(p.sx);
          const sy = Math.round(p.sy);
          if (sx < 0 || sy < 0 || sx >= src.width || sy >= src.height) { n = -1; break; }
          const o = (sy * src.width + sx) * 4;
          r += src.data[o]; g += src.data[o + 1]; b += src.data[o + 2];
          n += 1;
        }
        if (n < 0) break;
      }
      if (n <= 0) continue;
      const d = Math.max(Math.abs(oa.r - r / n), Math.abs(oa.g - g / n), Math.abs(oa.b - b / n));
      if (d > maxDiff) { maxDiff = d; worst = `(${bx},${by})`; }
      blocks += 1;
      samples += n;
    }
  }
  return { maxDiff, blocks, samples, worst };
}

/** 逐 8×8 块比"输出块均值"与"源图对应区域均值"，返回最差的一个。 */
function compareBlocksPerceptual(src: RgbaImage, out: RgbaImage, transform: {
  scale: number; offsetX: number; offsetY: number;
}): { maxDiff: number; blocks: number; worst: string } {
  let maxDiff = 0; let blocks = 0; let worst = '';
  for (let by = 0; by < out.height; by += PERCEPTUAL_BLOCK) {
    for (let bx = 0; bx < out.width; bx += PERCEPTUAL_BLOCK) {
      const oa = regionMean(out, bx, by, bx + PERCEPTUAL_BLOCK, by + PERCEPTUAL_BLOCK);
      // 只比"输出块完全在实色区内"的块：块里只要有背景/半透明边，
      // 均值就被覆盖比例主导（那不是缩放误差）
      if (oa.w < PERCEPTUAL_BLOCK * PERCEPTUAL_BLOCK * 0.95) continue;
      const p0 = mapTargetToSource(transform, bx, by);
      const p1 = mapTargetToSource(transform, bx + PERCEPTUAL_BLOCK - 1, by + PERCEPTUAL_BLOCK - 1);
      const sa = regionMean(src, p0.sx, p0.sy, p1.sx + 1, p1.sy + 1);
      if (sa.w < 1) continue;
      const d = meanDiff(oa, sa);
      if (d > maxDiff) { maxDiff = d; worst = `(${bx},${by})`; }
      blocks += 1;
    }
  }
  return { maxDiff, blocks, worst };
}

// --------------------------------------------------------------------------
// ① 夹具自检（先确认输入没坏，否则后面全是假通过）
// --------------------------------------------------------------------------

function section1Fixtures(): void {
  section('① 夹具自检（裸 RGBA 尺寸/哈希 + 与 prepare_image.py 的**口径**一致性）');

  eq(manifest.alphaThreshold, 128, '夹具清单里的二值化阈值 = 128（与 prepare_image.py 默认一致）');
  eq(manifest.targetSize, TARGET_SIZE, '夹具清单里的目标尺寸 = image.ts 的 TARGET_SIZE');
  eq(manifest.maxColors, MAX_COLORS, '夹具清单里的色数上限 = emblem.ts 的 MAX_COLORS');
  eq(MAX_OPAQUE_COLORS, MAX_COLORS, 'image.ts 的 MAX_OPAQUE_COLORS = emblem.ts 的 MAX_COLORS');
  ok(fixtures.length >= 7, `夹具张数 ≥ 7（实到 ${fixtures.length}）`);

  for (const f of fixtures) {
    const e = f.entry;
    eq(f.data.length, e.width * e.height * 4, `${f.name}: 裸 RGBA 长度 = 宽×高×4`);
    if (f.data.length !== e.bytes) {
      warn(`${f.name}: 文件实际 ${f.data.length} 字节，清单记 ${e.bytes} 字节（清单疑似过期）`);
    }
    if (sha256(f.data) !== e.sha256) {
      warn(`${f.name}: 文件 SHA-256 与清单不符（清单疑似过期）`);
    }
    // ★ 跨语言**口径**一致性：TS 的统计 vs Python（Pillow）对**源图**的统计。
    //   这一档可以硬比 —— 它比的是"不透明色数 / 半透明像素数"的**定义**，
    //   不是像素值。`image.ts` 与 `prepare_image.py` 必须对同一张图数出同样的数。
    const st = imageStats(f);
    eq(st.opaqueColors, e.sourceStats.opaqueColors, `${f.name}: TS 数出的实色数 = Python 数出的（源图）`);
    eq(st.semiTransparent, e.sourceStats.semiTransparentPixels, `${f.name}: TS 数出的半透明数 = Python 数出的（源图）`);
    eq(st.opaquePixels, e.sourceStats.opaquePixels, `${f.name}: TS 数出的不透明像素数 = Python 数出的（源图）`);
    // 参考结论（prepare_image.py 跑完 128×128 之后）自检
    ok(e.reference.ok === true, `${f.name}: prepare_image.py 的结论是"合规"`, JSON.stringify(e.reference.notes ?? []));
    ok((e.reference.opaqueColors ?? 999) <= MAX_OPAQUE_COLORS,
      `${f.name}: prepare_image.py 减色后 ≤255 色`, `实到 ${e.reference.opaqueColors}`);
    eq(e.reference.semiTransparentPixels, 0, `${f.name}: prepare_image.py 减色后半透明 = 0`);
    // ★ 最强的跨语言断言：**源图尺寸已等于目标尺寸**时两边都没有缩放、没有减色
    //   （色数本来就 ≤255）⇒ 两边的"最终实色数"必须**恰好相等**
    //   （M2 判据 ② 的那一档；这里用统计量交叉验证，像素对齐由判据 (b) 的往返测试负责）
    if (f.width === TARGET_SIZE && f.height === TARGET_SIZE
      && st.semiTransparent === 0 && st.opaqueColors <= MAX_OPAQUE_COLORS) {
      eq(e.reference.opaqueColors, st.opaqueColors,
        `${f.name}: 已是 128×128 且 ≤255 色 ⇒ TS 与 prepare_image.py 的最终色数**必须相等**`);
    }
  }

  // 夹具里"smooth 核"与"nearest 核"两条路都必须有样本，否则 (e)/(a) 会形同虚设。
  // ⚠ 这里按 `selectScaleKernel` 的三条规则重新对口径（规则见 `image.ts::selectScaleKernel`）：
  //   下面的 `containKernel()` 是本文件按 `contain` 倍率重写的小包装（见其注释）。
  //   · photo-noise-300（300×300，非整数倍缩小）⇒ 规则 2 ⇒ smooth ✓
  //   · pixel-art-128（128×128 == 目标）        ⇒ 规则 1 ⇒ nearest ✓
  //   · tiny-3x3 / one-pixel（放大）            ⇒ 规则 3 ⇒ 色数少 ⇒ nearest ✓
  //   · banner-logo-502x202（502×202 非整数倍缩小）⇒ 规则 2 ⇒ smooth（**不再是** nearest）
  ok(get('photo-noise-300').entry.sourceStats.opaqueColors > 256,
    "夹具含 >256 色的图（photo-noise-300）⇒ 规则 2/3 都会判 smooth");
  ok(get('pixel-art-128').entry.sourceStats.opaqueColors === 40,
    '夹具的像素风图恰好 40 色（且尺寸 == 目标 ⇒ 规则 1 的 nearest 档）');
  ok(get('banner-logo-502x202').width > TARGET_SIZE || get('banner-logo-502x202').height > TARGET_SIZE,
    '夹具含需要缩小的非方图（banner-logo ⇒ 规则 2 的非整数倍档）');
  ok(get('soft-edge-140').entry.sourceStats.semiTransparentPixels > 0,
    '夹具含半透明像素（soft-edge-140 ⇒ 验证二值化）');
  ok(get('tiny-3x3').width === 3 && get('tiny-3x3').height === 3, '夹具含 3×3 极小图');
  ok(get('one-pixel').width === 1 && get('one-pixel').height === 1, '夹具含 1×1 单像素图');
  ok(get('banner-logo-502x202').width !== get('banner-logo-502x202').height, '夹具含非方图');
}

// --------------------------------------------------------------------------
// (a) 几何正确性
// --------------------------------------------------------------------------

function sectionGeometry(): void {
  section('(a) 几何正确性：contain / cover / stretch / manual');

  const one = get('one-pixel');
  const N = TARGET_SIZE;

  // ── 1×1：contain 时整张目标图恒等于那一个像素（四角**不是**背景）──
  {
    const f = fitToTarget(one, { mode: 'contain' });
    eq(f.width, N, '1×1 contain: 输出宽 = 128');
    eq(f.height, N, '1×1 contain: 输出高 = 128');
    const want = px(one, 0, 0);
    let allSame = true;
    for (let y = 0; y < N && allSame; y++) {
      for (let x = 0; x < N && allSame; x++) if (!pxEq(px(f, x, y), want)) allSame = false;
    }
    ok(allSame, '1×1 contain: 全图 16,384 像素都等于那一个源像素', `源 = ${want.join(',')}`);
    eq(f.backgroundPixels, 0, '1×1 contain: 没有背景像素（1×1 放大后铺满整张目标图）');
    ok(pxEq(px(f, 0, 0), want), '1×1 contain: 左上角 = 源色（这条特意区分"四角=背景"的常规断言）');
    ok(pxEq(px(f, N - 1, N - 1), want), '1×1 contain: 右下角 = 源色');
  }

  // ── 3×3：contain 放大 128/3 倍，中心像素 = 原色、四角 = 该角源像素 ──
  const tiny = get('tiny-3x3');
  {
    const f = fitToTarget(tiny, { mode: 'contain' });
    eq(f.kernel, 'nearest', '3×3（9 色）auto 核判 nearest');
    eq(f.backgroundPixels, 0, '3×3 contain: 3×3 是方的 ⇒ 铺满、无背景');
    ok(pxEq(px(f, 64, 64), px(tiny, 1, 1)), '3×3 contain: 中心像素 = 源中心像素');
    ok(pxEq(px(f, 0, 0), px(tiny, 0, 0)), '3×3 contain: 左上角 = 源左上像素');
    ok(pxEq(px(f, N - 1, N - 1), px(tiny, 2, 2)), '3×3 contain: 右下角 = 源右下像素');
    ok(pxEq(px(f, 0, N - 1), px(tiny, 0, 2)), '3×3 contain: 左下角 = 源左下像素');
    // 每个源像素必须**都**出现在输出里（浮点边界 bug 会吃掉最左一列/最上一行）
    const seen = new Set<string>();
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) seen.add(px(f, x, y).join(','));
    let allSeen = true;
    for (let sy = 0; sy < 3; sy++) {
      for (let sx = 0; sx < 3; sx++) if (!seen.has(px(tiny, sx, sy).join(','))) allSeen = false;
    }
    ok(allSeen, '3×3 contain: 9 个源像素的颜色**全部**出现在输出里（防浮点边界丢一列）',
      `实到 ${seen.size} 种`);
    eq(seen.size, 9, '3×3 contain: 输出恰好 9 种颜色（nearest 不许发明中间色）');
  }

  // ── 非方长条：contain 必补背景 / cover 必无背景 / stretch 必无背景 ──
  const banner = get('banner-logo-502x202');
  {
    const contain = fitToTarget(banner, { mode: 'contain' });
    eq(contain.width, N, '长条 contain: 输出 128 宽');
    eq(contain.height, N, '长条 contain: 输出 128 高');
    // ⚠ 这个长条的**限制边是高**（502×202 ⇒ 202/128 = 1.58 > 502/128 = 3.92），
    //   所以内容缩到 128 宽 × 51.5 高，背景补在**上下**（不是左右）。
    //   断言要按算出来的几何写，别凭"长条"两个字想当然。
    const scale = Math.min(N / banner.width, N / banner.height);
    const contentW = banner.width * scale;
    const contentH = banner.height * scale;
    const offX = (N - contentW) / 2;
    const offY = (N - contentH) / 2;
    eq(contain.transform.scale.toFixed(6), scale.toFixed(6), '长条 contain: 缩放 = min(128/宽, 128/高)（等比）');
    ok(contentW >= N - 1e-9, `长条 contain: 内容宽度吃满（${contentW.toFixed(2)}）`);
    ok(contentH < N, `长条 contain: 内容高度没吃满（${contentH.toFixed(2)} < 128）⇒ 背景在上下`);
    ok(contain.backgroundPixels > 0, '长条 contain: **必须**补背景', `实到 ${contain.backgroundPixels}`);
    eq(contain.backgroundPixels, N * N - Math.round(contentW) * Math.round(contentH),
      '长条 contain: 背景像素数 = 128² - 内容矩形（上下的横条）');
    // 背景在上下：顶行与底行是背景、中间行有内容
    ok(pxEq(px(contain, 0, 0), BG_TRANSPARENT), '长条 contain: 左上角 = 透明背景（顶行整行是背景）');
    ok(pxEq(px(contain, N - 1, 0), BG_TRANSPARENT), '长条 contain: 右上角 = 透明背景');
    ok(pxEq(px(contain, 0, N - 1), BG_TRANSPARENT), '长条 contain: 左下角 = 透明背景');
    ok(pxEq(px(contain, N - 1, N - 1), BG_TRANSPARENT), '长条 contain: 右下角 = 透明背景');
    ok(!pxEq(px(contain, Math.floor(N / 2), Math.floor(N / 2)), BG_TRANSPARENT),
      '长条 contain: 中心不是背景（内容确实在中间）');
    ok(!pxEq(px(contain, 0, Math.round(offY) + 2), BG_TRANSPARENT),
      '长条 contain: 内容的第一行（offY+2）已经有颜色了');

    const cover = fitToTarget(banner, { mode: 'cover' });
    eq(cover.backgroundPixels, 0, '长条 cover: **没有**背景像素（裁掉超出部分）');
    eq(cover.transform.scale.toFixed(6), Math.max(N / banner.width, N / banner.height).toFixed(6),
      '长条 cover: 缩放 = max(128/宽, 128/高)（等比铺满）');
    // cover 时内容高 = 202 × (128/202) = 128 吃满，宽超出 ⇒ 裁掉左右
    ok(pxEq(px(cover, 0, 0), BG_TRANSPARENT) === false, '长条 cover: 左上角是内容（没有背景）');

    const stretch = fitToTarget(banner, { mode: 'stretch' });
    eq(stretch.backgroundPixels, 0, '长条 stretch: 没有背景像素（直接拉伸铺满）');

    // contain 与 cover 的**内容**必须不同（否则两个模式其实一样，测试没测到东西）
    let same = true;
    for (let i = 0; i < N * N && same; i++) {
      for (let k = 0; k < 4; k++) if (contain.data[i * 4 + k] !== cover.data[i * 4 + k]) same = false;
    }
    ok(!same, '长条 contain 与 cover 的输出**不同**（两个模式确实走了不同分支）');
  }

  // ── 非方目标：contain 补上下、cover 裁上下（换一个长宽比，覆盖另一条轴）──
  {
    const square = get('photo-noise-300');
    const contain = fitToTarget(square, { mode: 'contain', targetWidth: 64, targetHeight: 128 });
    eq(contain.backgroundPixels, 64 * (128 - 64), '300×300 放进 64×128：contain 补上下共 64×64 个背景像素');
    ok(pxEq(px(contain, 0, 0), BG_TRANSPARENT), '300×300 → 64×128 contain: 左上角 = 背景');
    ok(pxEq(px(contain, 32, 64), BG_TRANSPARENT) === false, '300×300 → 64×128 contain: 中心是内容');
    const cover = fitToTarget(square, { mode: 'cover', targetWidth: 64, targetHeight: 128 });
    eq(cover.backgroundPixels, 0, '300×300 → 64×128 cover: 没有背景');
  }

  // ── manual：平移越界处 = 背景；scale=1 且 offset=0 是恒等映射 ──
  {
    const f = fitToTarget(tiny, { mode: 'manual', scale: 1, offsetX: 0, offsetY: 0 });
    eq(f.backgroundPixels, N * N - 9, 'manual scale=1/offset=0: 3×3 贴在左上角，其余 16,375 个是背景');
    ok(pxEq(px(f, 0, 0), px(tiny, 0, 0)), 'manual: (0,0) = 源 (0,0)（offset 是"源图左上角落在哪"）');
    ok(pxEq(px(f, 2, 2), px(tiny, 2, 2)), 'manual: (2,2) = 源 (2,2)');
    ok(pxEq(px(f, 3, 0), BG_TRANSPARENT), 'manual: (3,0) 越界 = 背景');
    ok(pxEq(px(f, 0, 3), BG_TRANSPARENT), 'manual: (0,3) 越界 = 背景');

    const shifted = fitToTarget(tiny, { mode: 'manual', scale: 4, offsetX: -4, offsetY: 0 });
    // 几何（按采样中心算出来的真值，不是凭直觉）：
    //   scale = 4 ⇒ 每个源像素占 4 格；offsetX = -4 / offsetY = 0
    //   ⇒ 目标 x=0..3 是源 x=0、x=4..7 是源 x=1、x=8 之后越界；
    //     目标 y=0..3 是源 y=0、4..7 是 y=1、8..11 是 y=2、y=12 之后越界。
    //   ⇒ 可见 **8 列 × 12 行 = 96 像素**，背景 = 16,384 - 96 = 16,288。
    //   ⚠ 这里踩过：一开始凭"左移 4 就该把左边的源像素推出边界"想当然 ——
    //     但 offset 是"源图左上角落在目标的哪一格"，负值等于**把内容整体往左推**、
    //     在**右下**露出越界区。断言一律按算出来的真值写。
    eq(shifted.backgroundPixels, N * N - 8 * 12,
      'manual scale=4/offsetX=-4: 可见 8 列 × 12 行 = 96 像素，其余全是背景');
    ok(pxEq(px(shifted, 0, 0), px(tiny, 1, 0)),
      'manual 平移: offsetX=-4 ⇒ 源图左上角落在目标 (-4,0) ⇒ 目标 (0,0) = 源 (1,0)');
    ok(pxEq(px(shifted, 3, 3), px(tiny, 1, 0)), 'manual 平移: (3,3) 仍 = 源 (1,0)（4× 放大的第一格）');
    ok(pxEq(px(shifted, 4, 0), px(tiny, 2, 0)), 'manual 平移: 第二格起点 x=4 → 源 (2,0)');
    ok(pxEq(px(shifted, 7, 3), px(tiny, 2, 0)), 'manual 平移: 第二格末列 x=7 → 源 (2,0)');
    ok(pxEq(px(shifted, 0, 4), px(tiny, 1, 1)), 'manual 平移: y=4 → 源 y=1');
    ok(pxEq(px(shifted, 0, 11), px(tiny, 1, 2)), 'manual 平移: y=11 → 源 y=2（最后一行）');
    ok(pxEq(px(shifted, 8, 0), BG_TRANSPARENT), 'manual 平移: 源 x=2 那一格越界 ⇒ x=8 是背景');
    ok(pxEq(px(shifted, 0, 12), BG_TRANSPARENT), 'manual 平移: 源 y=3 越界 ⇒ y=12 是背景');
    ok(pxEq(px(shifted, N - 1, N - 1), BG_TRANSPARENT), 'manual 平移: 右下越界 = 背景');

    const zoom = fitToTarget(tiny, { mode: 'manual', scale: 2, offsetX: 0, offsetY: 0 });
    ok(pxEq(px(zoom, 0, 0), px(tiny, 0, 0)), 'manual scale=2: (0,0) = 源 (0,0)');
    ok(pxEq(px(zoom, 1, 1), px(tiny, 0, 0)), 'manual scale=2: (1,1) 仍 = 源 (0,0)（2× 放大）');
    ok(pxEq(px(zoom, 2, 2), px(tiny, 1, 1)), 'manual scale=2: (2,2) = 源 (1,1)');
    let throws = false;
    try { fitToTarget(tiny, { mode: 'manual', scale: 0 }); } catch { throws = true; }
    ok(throws, 'manual scale=0 必须报错（而不是静默产出空图）');
  }

  // ── 背景色可以指定（不是只能透明）──
  {
    const f = fitToTarget(tiny, { mode: 'manual', scale: 1, background: { r: 255, g: 0, b: 255, a: 255 } });
    ok(pxEq(px(f, N - 1, N - 1), [255, 0, 255, 255]), 'manual: 自定义背景色生效（右下角 = 洋红）');
    eq(f.backgroundPixels, N * N - 9, 'manual: 自定义背景色的"背景像素"计数仍然正确');
  }

  // ── smooth 核的基本性质：整幅均值不变（面积平均的定义）──
  {
    const src = get('photo-noise-300');
    const f = fitToTarget(src, { mode: 'cover', kernel: 'smooth' });
    eq(f.kernel, 'smooth', 'photo-noise-300 强制 smooth 后 kernel = smooth');
    const whole = meanDiff(regionMean(src, 0, 0, src.width, src.height),
      regionMean({ data: f.data, width: f.width, height: f.height }, 0, 0, f.width, f.height));
    ok(whole <= PERCEPTUAL_WHOLE_MAX_SCALED, 'smooth 面积平均：整幅 alpha 加权均值不变（缩放不变式）',
      `差 ${whole.toFixed(3)} > ${PERCEPTUAL_WHOLE_MAX_SCALED}`);
  }

  // ── auto 核判据 ──
  //
  // ★ 判据原文（`image.ts::selectScaleKernel`，顺序即优先级）：
  //     1) 尺寸相同（scale == 1）        → 'nearest'（逐像素复制，不采样）
  //     2) 正在缩小（scale < 1）         → 'smooth'，除非**两轴都是整数倍**
  //                                        （scale 的倒数是整数）时才用 'nearest'
  //     3) 放大或等比（scale >= 1）      → 色数 ≤ 256 ? 'nearest' : 'smooth'
  //
  // ⚠ 两条容易读岔的地方，本文件按下面的口径测（都写进断言）：
  //   · "正在缩小"按**实际缩放倍率**判，而不是"轴尺寸是否超过目标"。理由：等比取景
  //     两轴共用同一个 scale = min(目标/源)，128×100 → 128×128 的倍率是
  //     min(1, 1.28) = **1**（横向 1:1、纵向放大）—— 一列都不丢，落规则③才对。
  //     若按"源宽 > 目标宽"判，这里会变成 smooth（更糊），两种口径都会在下面钉住。
  //   · 规则 ② 的"整数倍"判定用"倒数是整数"（`1/scale` 与四舍五入值在 1e-9 内相等），
  //     而不是"源尺寸 % 目标尺寸"：后者在等比取景下会判错（见 100×256 那条）。
  //
  // ⚠ `containKernel()` 的目标尺寸**默认 128×128**（`TARGET_SIZE`），下面显式写出来。
  {
    const T = TARGET_SIZE; // 128

    /**
     * `img(w,h,colors)`：**整图不透明**、色数 = `min(colors, w*h)`（按 5/5/4 位打包
     * 后 `% colors` 轮转铺满）。
     *
     * ★ 颜色打包是**单射**的（这是关键，前后踩过三次）：
     *   `v < 16384 = 2^14` 按 5/5/4 位切成 R/G/B ⇒ 不同的 v 必定得到不同的三元组。
     *   为了不让输出全是规律色，先做 `(v*977 + 12345) % 16384` 双射打散
     *   （977 是奇数 ⇒ 与 2^14 互素 ⇒ 双射）。
     * ★ 为什么必须"铺满"而不是"只给前 colors 个像素上色、其余透明"：
     *   稀疏图的实色像素太少（150×150 里只有 300 个），缩小到 128×128 后每个输出
     *   像素的支撑区里几乎没有实色 ⇒ alpha 平均后被二值化判成透明，输出变成一堆
     *   孤立点。拿它做缩放类断言只会得到荒唐数字（实测 300 色 → 输出 128 色，
     *   那是**透明**的后果，不是插值的后果）。真实照片/像素画是铺满的。
     */
    const packColorIndex = (v: number): number[] => {
      const p = (v * 977 + 12345) % 16384;
      return [((p >> 9) & 0x1f) << 3, ((p >> 4) & 0x1f) << 3, (p & 0xf) << 4, 255];
    };
    const img = (w: number, h: number, colors: number): RgbaImage => {
      if (colors > w * h) throw new Error(`img(${w}×${h}, ${colors} 色)：像素不够放这么多颜色`);
      return makeImage(w, h, (x, y) => packColorIndex((y * w + x) % colors));
    };

    // ── 规则 1：尺寸相同 ⇒ 复制（不做任何采样）──
    eq(containKernel(img(128, 128, 40), T, T), 'nearest',
      '规则1（尺寸相同）: 128×128 / 40 色 → nearest（逐像素复制）');
    eq(containKernel(img(128, 128, 300), T, T), 'nearest',
      '规则1（尺寸相同）: 128×128 / 300 色 → nearest（色数多也一样，因为根本不采样）');
    // 真实夹具（128×128）走的就是这一条
    eq(containKernel(get('pixel-art-128'), T, T), 'nearest',
      '规则1: 夹具 pixel-art-128（128×128 / 40 色）→ nearest');
    eq(containKernel(get('gradient-128'), T, T), 'nearest',
      '规则1: 夹具 gradient-128（128×128 / 16,384 色）→ nearest（尺寸相同 ⇒ 复制，与色数无关）');

    // ── 规则 2 ★ 本次修的核心：缩小时只有"两轴整数倍"才准用最近邻 ──
    eq(containKernel(img(256, 256, 40), T, T), 'nearest',
      '规则2（2× 整数倍缩小）: 256×256 / 40 色 → nearest（整数倍 nearest 完美保真像素画）');
    eq(containKernel(img(384, 384, 40), T, T), 'nearest',
      '规则2（3× 整数倍缩小）: 384×384 / 40 色 → nearest');
    eq(containKernel(img(300, 300, 40), T, T), 'smooth',
      '★ 规则2（非整数倍缩小）: 300×300 / 40 色 → smooth（nearest 会抽样丢行丢列 ⇒ 不均匀边缘）');
    eq(containKernel(img(255, 255, 40), T, T), 'smooth',
      '规则2（差一格就不是整数倍）: 255×255 / 40 色 → smooth');
    eq(containKernel(img(300, 300, 300), T, T), 'smooth',
      '规则2（非整数倍缩小 + 多色）: 300×300 / 300 色 → smooth');
    eq(containKernel(img(128, 256, 40), T, T), 'nearest',
      '★ 规则2（纵向 2× 整数倍缩小、横向 1:1）: 128×256 → 128×128 → nearest'
      + '（1:1 的那一轴根本不采样 ⇒ 不存在丢列；只有被缩的那一轴需要判整数倍）');
    eq(containKernel(img(300, 128, 40), T, T), 'smooth',
      '★ 规则2（一轴缩放、另一轴 1:1，但缩放的那一轴非整数倍）: 300×128 → 128×128'
      + '（contain 倍率 = min(128/300, 128/128) = 0.4267）→ smooth（会丢列）');
    eq(containKernel(img(100, 256, 40), T, T), 'nearest',
      '★★ 规则2 的关键分歧点（第一版会判错的那一格）: 100×256 → 128×128'
      + '（contain 倍率 = min(1.28, 0.5) = 0.5）→ nearest'
      + '（横向其实是 1.28× **放大**、纵向是 2× 整数倍缩小 ⇒ 两轴都保真；'
      + '  第一版按"源尺寸 % 目标尺寸"判，100 % 128 ≠ 0 会误判成 smooth）');
    eq(containKernel(img(256, 260, 40), T, T), 'smooth',
      '规则2（一轴整数倍 + 一轴非整数倍）: 256×260 → 128×128 → smooth（必须两轴都整数倍）');
    // 真实夹具：502×202（两轴都非整数倍）现在必须走 smooth
    eq(containKernel(get('banner-logo-502x202'), T, T), 'smooth',
      '规则2: 夹具 banner-logo（502×202 / 9 色）→ smooth（缩小且非整数倍）');
    eq(containKernel(get('photo-noise-300'), T, T), 'smooth',
      '规则2: 夹具 photo-noise-300（300×300 / 18,741 色）→ smooth');

    // ── 规则 3：放大或等比时才看色数 ──
    eq(containKernel(img(100, 100, 300), T, T), 'smooth',
      '规则3（放大 + 多色）: 100×100 / 300 色 → smooth');
    eq(containKernel(img(100, 100, 40), T, T), 'nearest',
      '规则3（放大 + 少色）: 100×100 / 40 色 → nearest');
    eq(containKernel(img(64, 64, 32), T, T), 'nearest',
      '规则3（放大 + 少色）: 64×64 / 32 色 → nearest');
    eq(containKernel(img(64, 64, 300), T, T), 'smooth',
      '规则3（放大 + 多色）: 64×64 / 300 色 → smooth');
    // ⚠ 关于"等比"样本的一句话（踩过两次，别再重复）：
    //   `contain` 的倍率是 min(...)，所以**只要任一轴大于目标，就是缩小档**（规则②），
    //   根本轮不到规则③。256×64 / 64×256 看着像"横向 1:1、纵向放大"，实际
    //   min(0.5, 2) = 0.5 ⇒ 是 2× 整数倍缩小 ⇒ `nearest`（合规）。真正落到规则③
    //   的只有"两轴都不超过目标"的图（例如下面的 100×100），此时 min ≥ 1。
    eq(containKernel(img(128, 100, 40), T, T), 'nearest',
      '规则3（等比：横向恰好 1:1、纵向放大 + 少色）: 128×100 → nearest'
      + '（contain 倍率 = min(1, 1.28) = 1 ⇒ 不缩小，落到规则③看色数）');
    eq(containKernel(img(128, 100, 300), T, T), 'nearest',
      '★ 规则 2/3 的边界（字面歧义，见本文件注释）: 128×100 / 300 色 → nearest'
      + '（"正在缩小"按**实际倍率**判：min(1, 1.28) = 1 ⇒ 没有缩小 ⇒ 走规则③；'
      + '  若按"轴尺寸是否超过目标"判，这里会变成 smooth）');
    // 真实夹具：3×3 / 1×1 都是放大档
    eq(containKernel(get('tiny-3x3'), T, T), 'nearest', '规则3: 夹具 tiny-3x3（3×3 / 9 色）→ nearest');
    eq(containKernel(get('one-pixel'), T, T), 'nearest', '规则3: 夹具 one-pixel（1×1）→ nearest');
    eq(containKernel(get('small-64-with-transparent'), T, T), 'nearest',
      '规则3: 夹具 small-64（64×64 / 32 色，放大）→ nearest');
    // ★ 半透明像素**不算**实色数：40 个不透明色 + 200 个各不相同的半透明像素
    //   ⇒ 色数仍是 40（放大档）⇒ nearest。若把半透明算进去会变成 240，仍是 nearest，
    //   所以再加一条 300 个半透明像素的对照，让"算不算"这件事**真的**可分辨。
    {
      const semi40 = makeImage(100, 100, (x, y) => {
        const v = y * 100 + x;
        if (v < 40) return packColorIndex(v);
        if (v < 240) return [(v * 7) & 0xff, (v * 11) & 0xff, (v * 13) & 0xff, 200]; // 半透明
        return [0, 0, 0, 0];
      });
      eq(distinctOpaqueColors(semi40), 40, '半透明像素不计入不透明色数（40 个不透明 + 200 个半透明）');
      eq(semiTransparentCount(semi40), 200, '半透明像素计数 = 200');
      eq(containKernel(semi40, T, T), 'nearest',
        '规则3: 半透明像素不参与色数判据（40 色 ⇒ nearest，与 prepare_image.py 口径一致）');
    }

    // ── 色数判据的边界（规则 3 内部）：正好 256 ⇒ nearest；257 ⇒ smooth ──
    //   尺寸取 100×100（**放大档**，避免被规则 2 抢先命中）。
    eq(distinctOpaqueColors(img(100, 100, 256)), 256, '合成图：正好 256 种不透明色');
    eq(distinctOpaqueColors(img(100, 100, 257)), 257, '合成图：正好 257 种不透明色');
    eq(containKernel(img(100, 100, 256), T, T), 'nearest',
      "色数边界（放大档）: 256 色 ⇒ 'nearest'（判据是 ≤ 256）");
    eq(containKernel(img(100, 100, 257), T, T), 'smooth',
      "色数边界（放大档）: 257 色 ⇒ 'smooth'");
    // ★ 同一个 300 色图：缩小档必须 smooth（规则 2 优先于色数），放大档才是规则 3
    eq(containKernel(img(300, 300, 300), T, T), 'smooth',
      '优先级：300×300 / 300 色缩小 → smooth（规则 2 先命中，色数根本没被看）');
    eq(containKernel(img(100, 100, 300), T, T), 'smooth',
      '优先级：100×100 / 300 色放大 → smooth（走到规则 3 才看色数）');

    // ── 目标尺寸参数化（PS1 的 64×64 那一档）：规则 1/2 必须跟着目标走 ──
    eq(containKernel(img(64, 64, 300), 64, 64), 'nearest',
      '目标 64×64: 源 64×64 ⇒ 规则 1（尺寸相同 ⇒ 复制，即使 300 色）');
    eq(containKernel(img(128, 128, 40), 64, 64), 'nearest',
      '目标 64×64: 源 128×128 ⇒ 规则 2 的整数倍（2×）⇒ nearest');
    eq(containKernel(img(100, 100, 40), 64, 64), 'smooth',
      '目标 64×64: 源 100×100 ⇒ 非整数倍缩小 ⇒ smooth');

    // ── 半透明像素不计入色数（口径与 prepare_image.py 一致）──
    const semi = makeImage(4, 1, (x) => (x === 0 ? [10, 20, 30, 200] : [0, 0, 0, 0]));
    eq(distinctOpaqueColors(semi), 0, '半透明像素不计入"不透明色数"');
    eq(semiTransparentCount(semi), 1, '半透明像素计数 = 1');

    // ── 规则 1 的行为面：128×128 源图**任意核**都不许改变像素 ──
    //    ⚠ 报告的核名会跟着**手动选项**走（`kernel:'smooth'` 就报 smooth）——
    //      因为"报告的核"必须忠实反映调用方要什么，而**像素**由规则 1 的复制保证。
    //      所以这里分两句断言：报什么名 & 像素一样不一样。
    for (const k of ['auto', 'nearest', 'smooth'] as const) {
      const src = get('pixel-art-128');
      const f = fitToTarget(src, { kernel: k });
      const expectKernel = k === 'smooth' ? 'smooth' : 'nearest';
      eq(f.kernel, expectKernel,
        `128×128 源图 + kernel='${k}' ⇒ 报告的核是 ${expectKernel}（手动优先 / auto 走规则1）`);
      const d = firstPixelDiff(src, { data: f.data, width: f.width, height: f.height },
        `128×128 kernel=${k}:`);
      ok(d === null, `★ 规则 1: 128×128 源图 kernel='${k}' ⇒ 输出与输入逐像素相同`, d ?? '');
      eq(f.backgroundPixels, 0, `规则 1: kernel='${k}' 时没有背景像素`);
    }
    // 阈值边界图（16,384 色、含透明）也要走复制而不是采样
    {
      const src = get('gradient-128');
      for (const k of ['auto', 'smooth'] as const) {
        const f = fitToTarget(src, { kernel: k });
        const d = firstPixelDiff(src, { data: f.data, width: f.width, height: f.height },
          `gradient kernel=${k}:`);
        ok(d === null,
          `★ 规则 1: 16,384 色的 128×128 源图 kernel='${k}' 也逐像素相同（复制优先于采样）`,
          d ?? '');
        eq(f.backgroundPixels, 0, `规则 1: gradient-128 没有背景像素（kernel=${k}）`);
      }
    }

    // ── 手动 kernel 的优先级**永远高于** 'auto' ──
    {
      const shrinkNonInteger = img(300, 300, 40); // 规则 2 本来判 smooth
      eq(containKernel(shrinkNonInteger, T, T), 'smooth', '优先级前置：300×300/40 色 auto ⇒ smooth');
      eq(fitToTarget(shrinkNonInteger, { kernel: 'nearest' }).kernel, 'nearest',
        "手动 kernel='nearest' 不被 'auto' 覆盖（即使 auto 会判 smooth）");

      const shrinkInteger = img(256, 256, 40); // 规则 2 本来判 nearest
      eq(containKernel(shrinkInteger, T, T), 'nearest', '优先级前置：256×256/40 色 auto ⇒ nearest');
      eq(fitToTarget(shrinkInteger, { kernel: 'smooth' }).kernel, 'smooth',
        "手动 kernel='smooth' 不被 'auto' 覆盖（即使 auto 会判 nearest、即使是整数倍）");
      // ⚠ 三条踩过的坑，都写在这里：
      //   ① 别用整数倍 2:1 验：支撑区只覆盖 1 个像素 ⇒ 面积平均**等价于**最近邻，
      //      根本不会造新色（期望 >40 实到 40）；
      //   ② 别用稀疏图验：150×150 里只有 300 个实色点，缩小后 alpha 平均把支撑区
      //      里的覆盖度压到阈值以下 ⇒ 输出大片透明（期望 >300 实到 128）；
      //   ③ 所以合成图必须是**铺满**的（现在的 `img()` 就是铺满的）。
      const shrinkMix = img(150, 150, 300);
      eq(distinctOpaqueColors(shrinkMix), 300, 'shrinkMix 合成图：恰好 300 色且整图不透明');
      eq(containKernel(shrinkMix, T, T), 'smooth', '优先级前置：150×150/300 色 auto ⇒ smooth');
      const fSmooth = fitToTarget(shrinkMix, { kernel: 'smooth' });
      const smoothColors = distinctOpaqueColors(
        { data: fSmooth.data, width: fSmooth.width, height: fSmooth.height });
      ok(smoothColors > 300, "手动 kernel='smooth' 真的生效：非整数倍缩小时混合出了新颜色",
        `源 300 色 → smooth 实到 ${smoothColors} 色`);
      // 手动 nearest 的对照：**缩小**时它会丢点（不是 bug，是规则 ② 要避免的现象），
      // 所以这里的断言是"色数 ≤ 源色数"而不是"相等"。
      const fNearestShrink = fitToTarget(shrinkMix, { kernel: 'nearest' });
      const nearestShrinkColors = distinctOpaqueColors(
        { data: fNearestShrink.data, width: fNearestShrink.width, height: fNearestShrink.height });
      ok(nearestShrinkColors <= 300, '手动 nearest（缩小档）：输出色数 ≤ 源色数（只抽样、不混色）',
        `实到 ${nearestShrinkColors}`);

      const upscaleMany = img(100, 100, 300); // 规则 3 本来判 smooth
      eq(containKernel(upscaleMany, T, T), 'smooth', '优先级前置：100×100/300 色 auto ⇒ smooth');
      eq(fitToTarget(upscaleMany, { kernel: 'nearest' }).kernel, 'nearest',
        "手动 kernel='nearest' 不被 'auto' 覆盖（放大档 + 多色）");
      // 手动 nearest 在**放大档**真的生效：输出色数 = 源图色数（不许发明中间色）。
      // ⚠ 放大时 smooth 的支撑区 ≤ 1 个源像素 ⇒ 它**也**不造新色（面积平均的性质，
      //   不是 bug）⇒ "smooth 造新色"只能在缩小档验（上面那条）。
      const fManual = fitToTarget(upscaleMany, { kernel: 'nearest' });
      const manualColors = distinctOpaqueColors(
        { data: fManual.data, width: fManual.width, height: fManual.height });
      eq(manualColors, 300, '手动 nearest 生效：放大后输出色数恰好 = 源图色数（一个中间色都没发明）');
      const fAuto = fitToTarget(upscaleMany, { kernel: 'auto' });
      eq(fAuto.kernel, 'smooth', 'auto 在放大 + 多色时选 smooth');
      const dAutoVsManual = firstPixelDiff(
        { data: fAuto.data, width: fAuto.width, height: fAuto.height },
        { data: fManual.data, width: fManual.width, height: fManual.height },
        'auto(smooth) vs 手动 nearest（放大档）：');
      ok(dAutoVsManual !== null,
        '放大档：auto(smooth) 与手动 nearest 的输出确实不同（核选择真的改变了像素）');

      // prepareEmblem 要尊重手动核（它自己算过一遍 auto）
      const rManual = prepareEmblem(shrinkMix, { kernel: 'nearest' });
      eq(rManual.report.kernel, 'nearest', "prepareEmblem: 手动 kernel='nearest' 不被 auto 覆盖");
      const rAuto = prepareEmblem(shrinkMix, {});
      eq(rAuto.report.kernel, 'smooth', 'prepareEmblem: auto 在非整数倍缩小时判 smooth');
    }

    // ── 规则 2 的**动机自检**：非整数倍缩小时 nearest 真的会"抽样丢行丢列" ──
    //    判据不是"平均色偏了"（面积平均保比例，所以 smooth 的均值必然准），
    //    而是**直接数"有多少源行从未被采样到"** —— 这就是"丢行丢列"的字面含义。
    {
      const src = img(300, 300, 40);            // 300 → 128（2.34×，非整数倍）
      const fN = fitToTarget(src, { mode: 'cover', kernel: 'nearest' });
      const fS = fitToTarget(src, { mode: 'cover', kernel: 'smooth' });

      /** nearest 实际命中哪些源行：按 `nearestFit` 的整数映射（round(中心-0.5)）复算。 */
      const nearestHitRows = (
        t: { scale: number; offsetX: number; offsetY: number }, dstH: number,
      ): Set<number> => {
        const hit = new Set<number>();
        for (let ty = 0; ty < dstH; ty++) hit.add(Math.round(mapTargetToSource(t, 0, ty).sy));
        return hit;
      };
      /**
       * smooth 的**面积平均窗口**覆盖哪些源行：目标行 ty 的支撑区是
       * `中心 ± 0.5/scale` ⇒ 覆盖 `[中心-半宽, 中心+半宽]` 里的源行。
       * ⚠ 必须**独立算**，不能拿 mapTargetToSource 套 nearest 的取整规则 ——
       *   第一版就是这么算的，于是 smooth 也被报成"漏 172 行"（假失败）。
       */
      const smoothCoverRows = (
        t: { scale: number; offsetX: number; offsetY: number }, dstH: number,
      ): Set<number> => {
        const covered = new Set<number>();
        const inv = 1 / t.scale;
        const half = 0.5 * inv;
        for (let ty = 0; ty < dstH; ty++) {
          const c = (ty + 0.5 - t.offsetY) * inv;
          const s0 = Math.max(0, Math.ceil(c - half));
          const s1 = Math.min(src.height - 1, Math.floor(c + half));
          for (let s = s0; s <= s1; s++) {
            covered.add(s);
            if (covered.size === src.height) return covered;
          }
        }
        return covered;
      };

      const hitN = nearestHitRows(fN.transform, fN.height);
      const missN = src.height - hitN.size;
      const covS = smoothCoverRows(fS.transform, fS.height);
      const missS = src.height - covS.size;
      console.log(`      rule2 动机：nearest 漏掉 ${missN}/${src.height} 个源行；`
        + `smooth 的采样窗口覆盖 ${covS.size}/${src.height} 个源行`);
      ok(missN > 100, '★ 规则 2 的动机：300→128 的 nearest 会漏掉上百个源行（= 抽样丢行）',
        `漏 ${missN} / ${src.height}`);
      eq(missS, 0, '规则 2 的动机：同一缩放倍率下 smooth 的面积平均窗口覆盖每一个源行（不丢行）');
    }
  }
}

// --------------------------------------------------------------------------
// (b) ★ 无损性
// --------------------------------------------------------------------------

function sectionLossless(): void {
  section('(b) ★ 无损性：已是 128×128 + ≤255 色 + 无半透明 ⇒ 逐像素等价');

  // 夹具 ①：128×128 / 40 色 / 无半透明 —— M2 最重要的一条判据
  {
    const src = get('pixel-art-128');
    const r = prepareEmblem(src, {});
    eq(r.width, TARGET_SIZE, 'pixel-art: 输出 128×128');
    eq(r.report.lossless, true, 'pixel-art: report.lossless = true');
    eq(r.report.quantized, false, 'pixel-art: report.quantized = false（没走减色）');
    eq(r.report.colorsBefore, 40, 'pixel-art: 减色前 40 色');
    eq(r.report.colorsAfter, 40, 'pixel-art: 减色后仍是 40 色');
    eq(r.report.kernel, 'nearest', 'pixel-art: 走 nearest（auto 判据）');
    eq(r.report.backgroundPixels, 0, 'pixel-art: 没有补背景');
    eq(r.report.semiTransparentBefore, 0, 'pixel-art: 源图没有半透明像素');
    eq(r.report.binarizeChanged, 0, 'pixel-art: 二值化没有改动任何像素');
    eq(r.report.reBinarizeChanged, 0, 'pixel-art: 缩放后再二值化也没有改动');

    const out: RgbaImage = { data: r.rgba, width: r.width, height: r.height };
    const diff = firstPixelDiff(src, out, 'pixel-art 逐像素：');
    ok(diff === null, '★ pixel-art: 输出与输入**逐像素等价**', diff ?? '');
    eq(distinctOpaqueColors(out), 40, 'pixel-art: 输出实色数仍是 40');
    eq(opaqueCount(out), opaqueCount(src), 'pixel-art: 不透明像素个数不变（没被吃掉）');
  }

  // 判据 (b) 的合成版：对**已经处理过**的输出再跑一次，**最终 rgba 必须完全不变**。
  // ⚠ 注意这里只能断言 rgba（以及无损档的 palette），**不能**断言"indices 两次相同"：
  //   对减色过的图，第二次运行的输入颜色是新调色板的代表色，中位切分会在这些代表色上
  //   重新建桶 ⇒ 颜色值不变（所以 rgba 不变），但**索引编号与调色板顺序会变**。
  //   第一版就错误地断言了 indices 不变 —— 那是"要求实现细节稳定"，不是"要求图像稳定"。
  //   （这也是 `report.colorsAfter` 相对 `sourceColors` 的差别所在。）
  {
    for (const f of fixtures) {
      const once = prepareEmblem(f, {});
      const out1: RgbaImage = { data: once.rgba, width: once.width, height: once.height };
      const twice = prepareEmblem(out1, {});
      const diff = firstPixelDiff(out1, { data: twice.rgba, width: twice.width, height: twice.height },
        `${f.name} 幂等：`);
      ok(diff === null, `${f.name}: prepareEmblem 幂等（对已合规的输出再跑一次 rgba 完全不变）`, diff ?? '');
      eq(sha256(once.rgba), sha256(twice.rgba), `${f.name}: 二次运行的 rgba SHA-256 相同`);
      eq(twice.report.lossless, true, `${f.name}: 已合规输出再跑一次必定 lossless（这是判据 (b) 的另一面）`);
      eq(twice.report.quantized, false, `${f.name}: 二次运行不再减色`);
      eq(twice.report.colorsAfter, once.report.colorsAfter, `${f.name}: 二次运行色数不变`);
    }
  }

  // 合成无损样本：**正好 255 色** ⇒ 仍然无损（上限的边界，顺便钉住"≤255 必须无损"）
  {
    // v = 1..255 ⇒ 255 种颜色（每个像素一种）；透明像素的 RGB 不计入口径
    const img = makeImage(128, 128, (x, y) => {
      const v = y * 128 + x;
      if (v === 0 || v > 255) return [0, 0, 0, 0]; // 透明
      return [v, (v * 3) & 0xff, (v * 7) & 0xff, 255];
    });
    const n = distinctOpaqueColors(img);
    eq(n, 255, '合成边界图：恰好 255 种不透明色');
    const r = prepareEmblem(img, {});
    eq(r.report.lossless, true, `合成图（${n} 色 / 128×128 / 无半透明）：必须无损`);
    eq(r.report.colorsAfter, 255, '合成边界图：减色后仍 255 色（一个都没少）');
    const diff = firstPixelDiff(img, { data: r.rgba, width: r.width, height: r.height }, '合成图逐像素：');
    ok(diff === null, '合成边界图：输出与输入逐像素等价', diff ?? '');
    eq(semiTransparentCount({ data: r.rgba, width: r.width, height: r.height }), 0, '合成图：输出没有半透明像素');
  }

  // 再上一格：256 色 ⇒ 必须**不再**无损（证明"无损"不是无条件成立的）
  {
    // 同样要求颜色互不相同（R = v 是单射 ⇒ v=1..256 恰好 256 色）
    const img = makeImage(128, 128, (x, y) => {
      const v = y * 128 + x;
      if (v === 0 || v > 256) return [0, 0, 0, 0];
      return [v, (v * 3) & 0xff, (v * 7) & 0xff, 255];
    });
    const n = distinctOpaqueColors(img);
    ok(n > 255, `合成图：${n} 色 > 255 ⇒ 必须减色`);
    const r = prepareEmblem(img, {});
    eq(r.report.lossless, false, '合成 256 色图：report.lossless 必须为 false');
    eq(r.report.quantized, true, '合成 256 色图：确实走了减色');
    ok(r.report.colorsAfter <= MAX_OPAQUE_COLORS, '合成 256 色图：减色后 ≤255',
      `实到 ${r.report.colorsAfter}`);
  }

  // 判据 (b) 的**失败侧**：色数超限必须不再无损（否则"无损"这个词没有意义）
  {
    const src = get('gradient-128');
    const r = prepareEmblem(src, {});
    eq(r.report.lossless, false, 'gradient-128（16,384 色）：report.lossless 必须为 false');
    eq(r.report.quantized, true, 'gradient-128：确实走了减色');
    ok(r.report.colorsAfter <= MAX_OPAQUE_COLORS, 'gradient-128：减色后 ≤255 色');
  }

  // 阈值两侧 + despeckle 的语义（都写在注释里，这里钉住行为）
  {
    const mk = (a: number): RgbaImage => makeImage(2, 1, (x) => (x === 0 ? [10, 20, 30, a] : [0, 0, 0, 0]));
    eq(px({ data: binarizeAlpha(mk(127)), width: 2, height: 1 }, 0, 0)[3], 0, '二值化：alpha 127 < 128 ⇒ 全透明');
    eq(px({ data: binarizeAlpha(mk(128)), width: 2, height: 1 }, 0, 0)[3], 255, '二值化：alpha 128 **≥** 128 ⇒ 全不透明（与 wxWidgets 一致）');
    eq(px({ data: binarizeAlpha(mk(129)), width: 2, height: 1 }, 0, 0)[3], 255, '二值化：alpha 129 ⇒ 全不透明');
    eq(px({ data: binarizeAlpha(mk(1)), width: 2, height: 1 }, 0, 0)[3], 0, '二值化：alpha 1 ⇒ 全透明');
    eq(px({ data: binarizeAlpha(mk(254)), width: 2, height: 1 }, 0, 0)[3], 255, '二值化：alpha 254 ⇒ 全不透明');
    // 变透明的像素 RGB 必须清零（prepare_image.py 第 ④ 步的口径）
    const t = { data: binarizeAlpha(mk(1)), width: 2, height: 1 };
    ok(pxEq(px(t, 0, 0), BG_TRANSPARENT), '二值化：变透明的像素 RGB 也清零（= prepare_image.py 的 (0,0,0,0)）');
    ok(isAlphaBinary(t), '二值化输出：alpha 只有 0/255');

    // despeckle：孤立点被删、实心区完好
    const soft = get('soft-edge-140');
    const noSpeckle = binarizeAlpha(soft, 128);
    const speckled = binarizeAlpha(soft, 128, { despeckle: true, minNeighbors: 3 });
    const beforeImg: RgbaImage = { data: noSpeckle, width: soft.width, height: soft.height };
    const afterImg: RgbaImage = { data: speckled, width: soft.width, height: soft.height };
    const before = opaqueCount(beforeImg);
    const after = opaqueCount(afterImg);
    ok(after < before, 'despeckle：删掉了孤立的不透明像素', `前 ${before} → 后 ${after}`);
    // ⚠ 实测只删掉 12 个，而不是"24 个孤立点全删"：
    //   离图边 ≤2 px 的那几个点，在 140→128 缩小时会和图外（透明）做面积平均，
    //   alpha 被拉到 128 以下 ⇒ 在**二值化**那一步就已经透明了，轮不到 despeckle。
    //   剩下的 12 个都在"离边 ≥3 px 且周围全透明"的位置，会被完整删掉。
    ok(before - after >= 10, 'despeckle：删掉 ≥10 个孤立点（实测 12；靠边的点在二值化时就没了）',
      `删了 ${before - after} 个`);
    // ★ 关键：被删掉的**只**是孤立点，实心圆盘必须一个像素都不少。
    //   判据：凡是被删的像素，它的 3×3 邻域里原本必须"没有一堆同伴"。
    let removedNotIsolated = 0;
    let removedTotal = 0;
    for (let y = 0; y < soft.height; y++) {
      for (let x = 0; x < soft.width; x++) {
        const o = (y * soft.width + x) * 4;
        if (noSpeckle[o + 3] === 0xff && speckled[o + 3] === 0) {
          removedTotal += 1;
          let cnt = 0;
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              const xx = x + dx; const yy = y + dy;
              if (xx < 0 || yy < 0 || xx >= soft.width || yy >= soft.height) continue;
              if (noSpeckle[(yy * soft.width + xx) * 4 + 3] === 0xff) cnt += 1;
            }
          }
          if (cnt >= 3) removedNotIsolated += 1;
        }
      }
    }
    eq(removedNotIsolated, 0, 'despeckle：被删的像素全都是"邻域同伴 < 3"的孤立点（圆盘/细线没被啃掉）',
      `删了 ${removedTotal} 个`);
    ok(after > 0, 'despeckle：实心圆盘没有被整片吃掉（不是"删光"）');
    // 圆盘核心（中心 20×20）一个都不能少
    let coreLost = 0;
    for (let y = 60; y < 80; y++) {
      for (let x = 60; x < 80; x++) {
        const o = (y * soft.width + x) * 4;
        if (noSpeckle[o + 3] === 0xff && speckled[o + 3] === 0) coreLost += 1;
      }
    }
    eq(coreLost, 0, 'despeckle：圆盘核心区（中心 20×20）没有损失任何像素');
    eq(after, opaqueCount({ data: binarizeAlpha(soft, 128, { despeckle: true, minNeighbors: 3 }), width: soft.width, height: soft.height }),
      'despeckle：同一输入两次结果相同（读写分离 ⇒ 顺序无关）');
    // 默认关闭：不传 despeckle 时与"只做阈值"完全一致
    eq(sha256(binarizeAlpha(soft, 128)), sha256(binarizeAlpha(soft, 128, {})),
      'despeckle 默认关闭（不传选项与传空选项结果一致）');
    ok(!isAlphaBinary(soft), 'soft-edge-140 源图确实含半透明像素（否则上面几条测的是空气）');
    ok(isAlphaBinary(afterImg), '二值化输出：alpha 只有 0/255');
  }
}

// --------------------------------------------------------------------------
// (c) 合规性
// --------------------------------------------------------------------------

function sectionCompliance(): void {
  section('(c) 合规性：全部夹具 → 128×128 / 实色 ≤255 / 半透明 0 / 索引 0 只在透明像素上');

  for (const f of fixtures) {
    for (const mode of ['contain', 'cover', 'stretch'] as const) {
      const r = prepareEmblem(f, { mode });
      const label = `${f.name}/${mode}`;
      eq(r.width, TARGET_SIZE, `${label}: 输出宽 128`);
      eq(r.height, TARGET_SIZE, `${label}: 输出高 128`);
      eq(r.rgba.length, TARGET_SIZE * TARGET_SIZE * 4, `${label}: rgba 长度 65,536`);

      const out: RgbaImage = { data: r.rgba, width: r.width, height: r.height };
      const st = imageStats(out);
      ok(st.opaqueColors <= MAX_OPAQUE_COLORS, `${label}: 不透明色数 ≤ 255`, `实到 ${st.opaqueColors}`);
      eq(st.semiTransparent, 0, `${label}: 半透明像素 = 0`);
      ok(st.opaquePixels > 0, `${label}: 有实色像素（不是全透明空图）`);
      eq(st.opaqueColors, r.report.colorsAfter, `${label}: report.colorsAfter 与独立复核一致`);

      // ★ 索引 0 只能出现在透明像素上
      let bad = 0;
      let zeroOnTransparent = 0;
      let nonZeroOnOpaque = 0;
      for (let i = 0; i < TARGET_SIZE * TARGET_SIZE; i++) {
        const isOpaque = r.rgba[i * 4 + 3] === 0xff;
        if (r.indices[i] === 0) {
          if (isOpaque) bad += 1;
          else zeroOnTransparent += 1;
        } else if (isOpaque) {
          nonZeroOnOpaque += 1;
        }
      }
      eq(bad, 0, `${label}: 索引 0 只出现在透明像素上（实色拿索引 0 会在游戏里变成透明洞）`);
      eq(nonZeroOnOpaque, st.opaquePixels, `${label}: 每个不透明像素的索引都 ≠ 0`);
      ok(zeroOnTransparent === st.transparentPixels, `${label}: 每个透明像素的索引都是 0`);

      // palette 的形状：索引 0 = 00 00 00 00；实色 alpha = 0x80（游戏惯例）
      eq(r.palette.length, 1024, `${label}: palette 长度 1024（256×4）`);
      eq(r.indices.length, 16384, `${label}: indices 长度 16,384（128×128）`);
      eq(r.palette.byteLength, 1024, `${label}: palette.byteLength = 1024`);
      eq(r.indices.byteLength, 16384, `${label}: indices.byteLength = 16,384`);
      eq(Array.from(r.palette.slice(0, 4)).join(','), '0,0,0,0', `${label}: palette[0] = 00 00 00 00（透明项）`);
      let alphaBad = 0;
      for (let k = 1; k <= r.report.colorsAfter; k++) {
        if (r.palette[k * 4 + 3] !== PALETTE_ALPHA_OPAQUE) alphaBad += 1;
      }
      eq(alphaBad, 0, `${label}: 实色槽位 alpha = 0x80（PORT-NOTES §二 1 的游戏惯例）`);
      // 声明的"输出色数"必须与**实际引用到的槽位颜色**一致（不许虚报）。
      // ⚠ 别写成"最大索引 == colorsAfter"：中位切分**允许**两个桶四舍五入后落成同一个 RGB
      //   ⇒ 槽位号会大于"不同颜色数"（实测 banner-logo/stretch：255 个槽位全被引用、252 种颜色）。
      //   那不是虚报（不违法格式），只是调色板有点浪费；所以这里钉的是真正的不变式。
      let maxIdx = 0;
      for (let i = 0; i < r.indices.length; i++) if (r.indices[i] > maxIdx) maxIdx = r.indices[i];
      ok(maxIdx <= MAX_OPAQUE_COLORS, `${label}: 最大索引 ${maxIdx} ≤ ${MAX_OPAQUE_COLORS}（调色板边界）`);
      const usedSlots = new Set<number>();
      for (let i = 0; i < r.indices.length; i++) if (r.indices[i] !== 0) usedSlots.add(r.indices[i]);
      const slotColors = new Set<number>();
      for (const s of usedSlots) {
        slotColors.add((r.palette[s * 4] << 16) | (r.palette[s * 4 + 1] << 8) | r.palette[s * 4 + 2]);
      }
      eq(
        slotColors.size,
        r.report.colorsAfter,
        `${label}: 引用到的 ${usedSlots.size} 个槽位里恰好 ${r.report.colorsAfter} 种不同颜色（不虚报、不重复计）`,
      );
      ok(
        r.report.colorsAfter <= maxIdx,
        `${label}: colorsAfter ${r.report.colorsAfter} ≤ 最大索引 ${maxIdx}（不同颜色数不可能超过用到的槽位数）`,
      );

      // checkCompliance 必须与手算一致
      const cc = checkCompliance(out, { indices: r.indices });
      eq(cc.ok, true, `${label}: checkCompliance().ok = true`);
      eq(cc.issues.length, 0, `${label}: checkCompliance() 无 issue`);
      eq(cc.opaqueColors, st.opaqueColors, `${label}: checkCompliance 的色数与独立复核一致`);
      eq(cc.semiTransparent, 0, `${label}: checkCompliance 的半透明数 = 0`);
      eq(r.report.compliance.ok, true, `${label}: report.compliance.ok = true`);

      // 与 Python 参考实现的**口径**对齐（它自己也复核过一次）
      if (f.entry.reference.ok) {
        ok(st.opaqueColors <= MAX_OPAQUE_COLORS,
          `${label}: 与 prepare_image.py 的结论一致（它报 ${f.entry.reference.opaqueColors} 色 / ${f.entry.reference.semiTransparentPixels} 半透明）`);
      }
    }
  }

  // ⚠ 边界：256 色必须被拒（不是"勉强能过"）—— 这是上游那个差一 bug 的安全网
  {
    const img = makeImage(32, 32, (x, y) => {
      const v = y * 32 + x;
      if (v === 0) return [0, 0, 0, 0];
      return [v & 0xff, (v * 3) & 0xff, (v * 7) & 0xff, 255];
    });
    const n = distinctOpaqueColors(img);
    ok(n > 255, `合成图（${n} 色）用于测上限裁剪`);
    const r = prepareEmblem(img, {});
    ok(r.report.colorsAfter <= MAX_OPAQUE_COLORS, `超限图：减色后 ≤255`, `实到 ${r.report.colorsAfter}`);
    eq(checkCompliance({ data: r.rgba, width: 128, height: 128 }).ok, true, '超限图减色后合规');
    // maxColors 参数化（PS1 将来 15 色）
    const r15 = prepareEmblem(img, { maxColors: 15 });
    ok(r15.report.colorsAfter <= 15, `maxColors=15（PS1 那一档）也成立`, `实到 ${r15.report.colorsAfter}`);
    eq(checkCompliance({ data: r15.rgba, width: 128, height: 128 }, { maxColors: 15 }).ok, true,
      'maxColors=15 的输出按 15 色判据也合规');
    let throws = false;
    try { quantizeOpaque(img, 256); } catch { throws = true; }
    ok(throws, 'quantizeOpaque(maxColors=256) 必须报错（索引 0 固定留给透明 ⇒ 实色最多 255）');
  }

  // ⚠ 失败路径：不合规的输入必须被 checkCompliance 明确报出来（而不是沉默）
  {
    const bad = makeImage(64, 64, () => [1, 2, 3, 255]);
    const cc = checkCompliance(bad);
    eq(cc.ok, false, 'checkCompliance: 64×64 的图必须判不合规');
    ok(cc.issues.some((s) => s.includes('64×64')), 'checkCompliance: 报出尺寸问题', cc.issues.join(' | '));

    const semi = makeImage(128, 128, (x) => (x === 0 ? [5, 5, 5, 128] : [0, 0, 0, 0]));
    const cc2 = checkCompliance(semi);
    ok(cc2.issues.some((s) => s.includes('半透明')), 'checkCompliance: 报出半透明像素', cc2.issues.join(' | '));

    const many = makeImage(128, 128, (x, y) => [x, y, (x ^ y) & 0xff, 255]);
    const cc3 = checkCompliance(many);
    ok(cc3.issues.some((s) => s.includes('不透明色数')), 'checkCompliance: 报出色数超限', cc3.issues.join(' | '));

    // 索引口径：实色拿索引 0 必须被抓出来
    const idx = new Uint8Array(128 * 128);
    const img = makeImage(128, 128, () => [9, 9, 9, 255]);
    const cc4 = checkCompliance(img, { indices: idx });
    ok(cc4.issues.some((s) => s.includes('索引 0')), 'checkCompliance: 报出"索引 0 用在实色像素上"', cc4.issues.join(' | '));
  }
}

// --------------------------------------------------------------------------
// (d) 确定性
// --------------------------------------------------------------------------

function sectionDeterminism(): void {
  section('(d) 确定性：同输入两次，palette / indices / rgba 的 SHA-256 完全相同');

  for (const f of fixtures) {
    const a = prepareEmblem(f, {});
    const b = prepareEmblem(f, {});
    eq(sha256(a.rgba), sha256(b.rgba), `${f.name}: rgba SHA-256 两次相同`);
    eq(sha256(a.palette), sha256(b.palette), `${f.name}: palette SHA-256 两次相同`);
    eq(sha256(a.indices), sha256(b.indices), `${f.name}: indices SHA-256 两次相同`);
    eq(a.report.colorsAfter, b.report.colorsAfter, `${f.name}: report.colorsAfter 两次相同`);
    eq(a.report.lossless, b.report.lossless, `${f.name}: report.lossless 两次相同`);
    // palette / indices / rgba 三者必须自洽（反查一遍，防止"报告与数据不一致"）
    let mismatch = -1;
    for (let i = 0; i < a.indices.length && mismatch < 0; i++) {
      const slot = a.indices[i];
      const o = i * 4;
      if (slot === 0) {
        if (a.rgba[o + 3] !== 0) mismatch = i;
      } else if (a.rgba[o] !== a.palette[slot * 4] || a.rgba[o + 1] !== a.palette[slot * 4 + 1]
        || a.rgba[o + 2] !== a.palette[slot * 4 + 2] || a.rgba[o + 3] !== 0xff) {
        mismatch = i;
      }
    }
    ok(mismatch < 0, `${f.name}: rgba 与 palette+indices 自洽`, `第 ${mismatch} 个像素对不上`);
  }

  // 纯函数：不能改入参
  {
    const f = get('gradient-128');
    const before = sha256(f.data);
    prepareEmblem(f, {});
    fitToTarget(f, { mode: 'cover' });
    binarizeAlpha(f, 128, { despeckle: true });
    quantizeOpaque(f, 32);
    eq(sha256(f.data), before, '纯函数：上述调用都没有修改入参缓冲');
  }

  // 同输入不同"无关参数"必须给同一个结果（例如 lr 与否不影响图像本身）
  {
    const f = get('soft-edge-140');
    const a = prepareEmblem(f, {});
    const b = prepareEmblem(f, { alphaThreshold: 128 });
    eq(sha256(a.rgba), sha256(b.rgba), '显式传默认阈值 = 不传（默认值真的是 128）');
  }
}

// ==========================================================================
// ★ 0.19 回归：修掉的三个字段 / 短路语义（D20 / D21 / D23）
// ==========================================================================

function testFixedSemantics(): void {
  section('★ 0.19 回归：manual 短路 / despeckleRemoved / stretch 背景计数');

  // ── D20：源尺寸 == 目标尺寸**不再**无条件短路成"逐像素复制" ──
  {
    // 128×128 的源图（= 徽章导出尺寸，最容易撞上这条）
    const n128 = 128 * 128;
    const srcData = new Uint8ClampedArray(n128 * 4);
    for (let i = 0; i < n128; i++) {
      const k = i % 40;
      srcData[i * 4] = (k * 6) & 0xff; srcData[i * 4 + 1] = (k * 11) & 0xff;
      srcData[i * 4 + 2] = (k * 17) & 0xff; srcData[i * 4 + 3] = 255;
    }
    const src = { data: srcData, width: 128, height: 128 };
    const ident = fitToTarget(src, { targetWidth: 128, targetHeight: 128, mode: 'manual', scale: 1, offsetX: 0, offsetY: 0 });
    eq(firstPixelDiff({ data: ident.data, width: ident.width, height: ident.height }, src, 'identity: '), null,
      '[D20] manual scale=1 / offset=0 ⇒ 确实是逐像素复制');

    const moved = fitToTarget(src, { targetWidth: 128, targetHeight: 128, mode: 'manual', scale: 2, offsetX: -32, offsetY: -32 });
    ok(firstPixelDiff({ data: moved.data, width: moved.width, height: moved.height }, src, 'moved: ') !== null,
      '[D20] manual scale=2 / offset=-32 ⇒ **不再是复制**（偏移真的生效了）');
    // scale < 1 + 正偏移 ⇒ 目标四边一定落在源图外 ⇒ 必须有背景像素（短路时这里恒为 0）
    const shrunk = fitToTarget(src, { targetWidth: 128, targetHeight: 128, mode: 'manual', scale: 0.5, offsetX: 32, offsetY: 32 });
    ok(shrunk.backgroundPixels > 0,
      '[D20] manual scale=0.5 / offset=+32 ⇒ 越界处补背景（报 0 就说明短路又回来了）',
      `实到 backgroundPixels=${shrunk.backgroundPixels}`);
  }

  // ── D21：despeckleRemoved 只算"去杂边真的删掉的像素" ──
  {
    const n = 128 * 128;
    const soft = new Uint8ClampedArray(n * 4);
    for (let i = 0; i < n; i++) {
      soft[i * 4] = 200; soft[i * 4 + 1] = 100; soft[i * 4 + 2] = 50; soft[i * 4 + 3] = 100;
    }
    const rSoft = prepareEmblem({ data: soft, width: 128, height: 128 }, { despeckle: true });
    eq(rSoft.report.despeckleRemoved, 0,
      '[D21] 整幅半透明（阈值 128 判为透明）+ 开收边 ⇒ despeckleRemoved = 0（去杂边什么都没删）');

    // 对照组：真的放一个孤立不透明点 ⇒ 必须被数进去
    const dot = new Uint8ClampedArray(n * 4);
    dot[(64 * 128 + 64) * 4] = 255; dot[(64 * 128 + 64) * 4 + 1] = 0;
    dot[(64 * 128 + 64) * 4 + 2] = 0; dot[(64 * 128 + 64) * 4 + 3] = 255;
    const rDot = prepareEmblem({ data: dot, width: 128, height: 128 }, { despeckle: true, despeckleMinNeighbors: 3 });
    eq(rDot.report.despeckleRemoved, 1,
      '[D21] 单个孤立不透明点 + 开收边 ⇒ despeckleRemoved = 1（这条才是"删掉了"）');
  }

  // ── D23：`backgroundPixels` 的口径 = "输出里逐通道等于背景色的像素数" ──
  //
  // ★ 这条口径 0.20 才彻底钉住（原来字段文档写"补了多少背景"，而 stretch 根本不补背景
  //   ⇒ 文档与实现差一半）。三条断言一起把它锁死：
  //   ① 与背景同色的**源**像素会被数进来（所以它不是"补了几个背景"的因果计数）；
  //   ② `contain` / `stretch` 两条分支对同一张图给**同一个数**（口径统一，没有分支特例）；
  //   ③ stretch + nearest 走的是真采样（源 4×4 → 目标 8×8，不是恒等短路），
  //      并且与**独立写的**参考实现逐像素一致（下面 §stretch 那一节）。
  {
    const bgOnly = { data: new Uint8ClampedArray(2 * 2 * 4), width: 2, height: 2 }; // 全 0 = 默认背景色
    const st = fitToTarget(bgOnly, { targetWidth: 4, targetHeight: 4, mode: 'stretch' });
    eq(st.backgroundPixels, 16, '[D23] stretch：整幅等于背景色 ⇒ backgroundPixels = 16（口径是"像背景色的输出像素数"）');
    const ct = fitToTarget(bgOnly, { targetWidth: 4, targetHeight: 4, mode: 'contain' });
    eq(ct.backgroundPixels, 16, '[D23] contain 同一张图也报 16（两条路口径一致）');
  }

  // ── 0.20：stretch 这支**真的跑到了** `nearestStretch`（原先那条用例源/目标同尺寸，
  //    命中"恒等短路"，看起来在测其实什么都没测）──
  //
  // 源 4×4 全不透明 + 洋红、目标 8×8、`mode:'stretch'`、**非默认** background：
  //   · `backgroundPixels` 必须是 0（源里一个背景色像素都没有，stretch 也不补背景）；
  //   · 输出里不许出现背景色像素（铺满、无越界 ⇒ 一个都不该补）；
  //   · 逐像素与下面**独立写的**参考实现一致（参考实现按 `Math.round((t+0.5)*s/d-0.5)`
  //     重写一遍，**不调用被测代码** —— 这是"取样式与 `mapTargetToSource` 同一条"的见证）。
  {
    const SRC = 4;
    const DST = 8;
    const MAGENTA = [255, 0, 255, 255];
    const BG = { r: 0, g: 255, b: 0, a: 255 }; // 非默认背景（绿），与源色逐通道都不同
    const src = makeImage(SRC, SRC, () => MAGENTA);
    const f = fitToTarget(src, {
      targetWidth: DST, targetHeight: DST, mode: 'stretch', background: BG,
    });
    eq(f.width, DST, '[0.20] stretch 4×4 → 8×8：输出宽 8');
    eq(f.height, DST, '[0.20] stretch 4×4 → 8×8：输出高 8');
    ok(!(SRC === DST), '[0.20] 这条用例的源/目标尺寸**必须不同**（同尺寸会命中恒等短路，测不到 nearestStretch）');
    eq(f.backgroundPixels, 0, '[0.20] stretch + 洋红源 + 绿背景 ⇒ backgroundPixels = 0（一个背景像素都没补）');
    let bgSeen = 0;
    for (let y = 0; y < DST; y++) {
      for (let x = 0; x < DST; x++) if (pxEq(px(f, x, y), [BG.r, BG.g, BG.b, BG.a])) bgSeen += 1;
    }
    eq(bgSeen, 0, '[0.20] stretch 的输出里**没有**背景色像素（独立逐像素复核）');

    // ★★ 独立参考实现：只按公式重写，不 import / 不调用 image.ts 的任何取样函数
    const refIndex = (t: number, s: number, d: number): number => {
      // 目标像素中心 (t+0.5)/d 映回源图 ⇒ 源坐标中心 (t+0.5)*s/d，取最近源像素 = round(中心-0.5)
      const c = Math.round(((t + 0.5) * s) / d - 0.5);
      return Math.min(s - 1, Math.max(0, c));
    };
    const ref = new Uint8ClampedArray(DST * DST * 4);
    for (let ty = 0; ty < DST; ty++) {
      const sy = refIndex(ty, SRC, DST);
      for (let tx = 0; tx < DST; tx++) {
        const sx = refIndex(tx, SRC, DST);
        const so = (sy * SRC + sx) * 4;
        const o = (ty * DST + tx) * 4;
        for (let k = 0; k < 4; k++) ref[o + k] = src.data[so + k];
      }
    }
    eq(firstPixelDiff({ data: f.data, width: f.width, height: f.height }, { data: ref, width: DST, height: DST },
      '[0.20] stretch+nearest 与独立参考实现：'), null,
    '[0.20] stretch+nearest 逐像素等于参考实现 `round((t+0.5)*s/d-0.5)`');

    // 参考实现自己也要自证"它真的在采样、而且取的是哪一个"：4→8 ⇒ 每相邻两列取同一个源像素
    // （0,0,1,1,2,2,3,3）；把序列钉住，免得公式被悄悄换成别的取样式。
    // ⚠ 4→8 这组尺寸下 `round(中心-0.5)` 与 `floor(中心)` 恰好给出**同一个**序列 ——
    //   所以这条断言**不能**单独证明用的是 round；真正的见证是"它 != 恒等映射"
    //   （源 4×4 → 目标 8×8，恒等短路在这种尺寸下不可能发生），以及 `nearestStretch`
    //   的注释 + `mapTargetToSource` 用的那条公式（两者在源码层面同式）。
    const refRow = [];
    for (let tx = 0; tx < DST; tx++) refRow.push(refIndex(tx, SRC, DST));
    eq(refRow.join(','), '0,0,1,1,2,2,3,3',
      '[0.20] 参考实现的取样式：4→8 ⇒ 源下标 0,0,1,1,2,2,3,3（相邻两列取同一个源像素）');

    // ── 对照：**与背景同色**的源像素会被数进来（证明这不是"补了几个背景"的因果计数）──
    //   源换成"整幅 = 背景色"，stretch 到 8×8：一个背景都没补，但计数 = 64。
    //   这就是字段文档 0.20 改成"输出里像背景色的像素数"的原因；别改成"stretch 恒为 0"，
    //   否则这条与上一条 contain 的断言会互相打架（同一张图两条分支给出不同的数）。
    const bgSrc = makeImage(SRC, SRC, () => [BG.r, BG.g, BG.b, BG.a]);
    const fBg = fitToTarget(bgSrc, {
      targetWidth: DST, targetHeight: DST, mode: 'stretch', background: BG,
    });
    eq(fBg.backgroundPixels, DST * DST,
      '[0.20] 源整幅等于背景色 ⇒ 计数 = 64（源像素被数进来；stretch 本身不补背景）');
  }
}

// ==========================================================================
// ★ 0.22：「导出 PNG → 外部编辑器改 → 重新导入」这条闭环必须**无损**
// ==========================================================================
//
// 背景：0.22 用户决定**不做内置像素编辑器**（"其他优秀的图像处理工具有很多"）⇒ 编辑这件事
//   交给外部工具，本工具只负责"格式 + 合规 + 写卡"。这个分工成立的前提是**闭环无损** ——
//   否则"导出改一下再导入"会毁掉像素，"删掉编辑器"就变成了"丢掉能力"。
//
// 闭环的两半在这里被钉住：
//   ① **导入侧**：128×128 的图，取景默认值（"填满白框"）恰好是**恒等映射**（倍率 1、偏移 0）
//      ⇒ `fitToTarget` 走恒等短路（D20 那条判据保证它只在**真恒等**时短路）；
//   ② **减色侧**：≤255 色的图，`quantizeOpaque()` 返回 `exact: true` ⇒ 一个像素都不换色。
//   PNG 编解码本身无损（浏览器里那一段由无头探针另外走一遍真路）。
//
// ⚠ 这条判据是**替代**被删掉的内置编辑器的那份"能力见证"：删功能 ≠ 丢能力，要有见证。

/** 造一张"像徽章"的 128×128 图：圆形主体 + 12 色 + 中心一个**真透明洞** + 四角透明。 */
function emblemLikeSource(): RgbaImage {
  const n = TARGET_SIZE * TARGET_SIZE;
  const data = new Uint8ClampedArray(n * 4);
  const pal: ReadonlyArray<readonly [number, number, number]> = [
    [255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0], [0, 255, 255], [255, 0, 255],
    [128, 128, 128], [20, 40, 60], [200, 180, 160], [10, 10, 10], [240, 240, 240], [90, 140, 90],
  ];
  for (let y = 0; y < TARGET_SIZE; y++) {
    for (let x = 0; x < TARGET_SIZE; x++) {
      const o = (y * TARGET_SIZE + x) * 4;
      const dx = x - 64;
      const dy = y - 64;
      const inBody = dx * dx + dy * dy <= 56 * 56;
      const inHole = dx * dx + dy * dy <= 8 * 8; // ★ 中心一个"洞"（游戏里就是透过去的）
      if (!inBody || inHole) continue; // alpha 保持 0 = 透明
      const c = pal[(((x >> 3) ^ (y >> 3)) % pal.length + pal.length) % pal.length];
      data[o] = c[0]; data[o + 1] = c[1]; data[o + 2] = c[2]; data[o + 3] = 255;
    }
  }
  return { data, width: TARGET_SIZE, height: TARGET_SIZE };
}

/** 「填满白框」在 128×128 源图上的取值 —— 与 `logic/defaults.ts::fillScaleFor/fillOffsetFor` 同口径。 */
const IDENTITY_FIT = {
  mode: 'manual' as const,
  scale: 1,
  offsetX: 0,
  offsetY: 0,
  alphaThreshold: 128,
  maxColors: MAX_OPAQUE_COLORS,
};

function testExternalEditorRoundTrip(): void {
  section('★ 0.22 闭环：导出 PNG → 外部改 → 重新导入 ⇒ 逐像素 diff = 0（不做内置编辑器的前提）');

  const src = emblemLikeSource();
  const n = TARGET_SIZE * TARGET_SIZE;
  const transparent = (img: RgbaImage): number => n - opaqueCount(img);

  ok(transparent(src) > 0, `夹具自检：含透明像素（"洞"语义要被覆盖），实到 ${transparent(src)} 个`);

  // ① 导入：128×128 的图 + "填满白框"的默认取景 ⇒ 恒等
  const p1 = prepareEmblem(src, IDENTITY_FIT);
  const d1 = firstPixelDiff(src, { data: p1.rgba, width: p1.width, height: p1.height }, '导入：');
  ok(d1 === null, '① 导入 128×128 的合规图 ⇒ 逐像素不变（取景倍率 1 = 恒等映射）', d1 ?? '');

  // ② 导出 → （外部编辑器保存成 PNG，不改像素）→ 重新导入
  const p2 = prepareEmblem(
    { data: p1.rgba, width: p1.width, height: p1.height },
    IDENTITY_FIT,
  );
  const d2 = firstPixelDiff(
    { data: p1.rgba, width: p1.width, height: p1.height },
    { data: p2.rgba, width: p2.width, height: p2.height },
    '往返：',
  );
  ok(d2 === null, '② ★ 往返一圈 ⇒ 逐像素 diff = 0（这条就是"删掉编辑器 ≠ 丢能力"的见证）', d2 ?? '');

  // ③ "洞"必须还在（透明像素数一个不差）
  eq(transparent({ data: p2.rgba, width: p2.width, height: p2.height }), transparent(src),
    '③ 透明像素数不变（中心的"洞"与四角没有被填实）');

  // ④ 实色数不变（quantizeOpaque 在这类输入上必须是 exact）
  eq(distinctOpaqueColors({ data: p2.rgba, width: p2.width, height: p2.height }),
    distinctOpaqueColors(src), '④ 不透明色数不变（≤255 色 ⇒ exact，不换色）');

  // ⑤ 格式硬口径：索引 0 只能落在透明像素上（实色拿到索引 0 会在游戏里变成"透明洞"）
  let idx0OnOpaque = 0;
  for (let i = 0; i < n; i++) {
    if (p2.indices[i] === 0 && p2.rgba[i * 4 + 3] === 0xff) idx0OnOpaque += 1;
  }
  eq(idx0OnOpaque, 0, '⑤ 往返后"索引 0 落在不透明像素上"的个数仍是 0（格式硬口径没被破坏）');

  // ⑥ 合规结论仍然通过（写卡那一步会再查一次）
  const comp = checkCompliance({ data: p2.rgba, width: p2.width, height: p2.height }, { indices: p2.indices });
  ok(comp.ok, `⑥ 往返后仍然合规（实到 issues=${JSON.stringify(comp.issues)}）`);

  // ⑦ 不再漂移：再来一轮还是同一张图（防止"每转一圈掉一点颜色"）
  const p3 = prepareEmblem({ data: p2.rgba, width: p2.width, height: p2.height }, IDENTITY_FIT);
  const d3 = firstPixelDiff(
    { data: p2.rgba, width: p2.width, height: p2.height },
    { data: p3.rgba, width: p3.width, height: p3.height },
    '第三圈：',
  );
  ok(d3 === null, '⑦ 再转一圈仍然逐像素相同（不会逐次漂移）', d3 ?? '');

  // ⑧ 报告也必须是"没动过"的样子：没跑中位切分、也没丢像素
  ok(p2.report.lossless === true, '⑧ 往返后 report.lossless = true（与"取景+二值化后的图"逐像素等价）');
  ok(p2.report.quantized === false, '⑧ 往返后 report.quantized = false（≤255 色 ⇒ 根本没跑中位切分）');
  eq(p2.report.colorsBefore, p2.report.colorsAfter, '⑧ 减色前 / 后的色数相同（没换过色）');
}

// --------------------------------------------------------------------------
// (e) 感知合理性
// --------------------------------------------------------------------------

function sectionPerceptual(): void {
  section('(e) 感知合理性：分块平均色 vs 源图对应区域（阈值理由见 PERCEPTUAL_* 注释）');

  // 主力：照片感噪声图（300×300 → 128×128 是 2.34× 下采样，走 smooth 核）
  {
    const src = get('photo-noise-300');
    const fit = fitToTarget(src, { mode: 'cover', kernel: 'smooth' });
    const out: RgbaImage = { data: fit.data, width: fit.width, height: fit.height };

    const whole = meanDiff(regionMean(src, 0, 0, src.width, src.height),
      regionMean(out, 0, 0, out.width, out.height));
    ok(whole <= PERCEPTUAL_WHOLE_MAX_SCALED,
      `photo-noise: 整幅区域均值差 ≤ ${PERCEPTUAL_WHOLE_MAX_SCALED}（缩放不变式；错位/串色会造成 >20）`,
      `实到 ${whole.toFixed(3)}`);

    const cmp = compareBlocksPerceptual(src, out, fit.transform);
    ok(cmp.blocks > 200, `photo-noise: 参与比较的 8×8 块足够多（实到 ${cmp.blocks}，共 256）`);
    ok(cmp.maxDiff <= PERCEPTUAL_BLOCK_MAX,
      `★ photo-noise: 逐 8×8 块均值差 ≤ ${PERCEPTUAL_BLOCK_MAX}`,
      `实到 max ${cmp.maxDiff.toFixed(2)} @ ${cmp.worst}`);

    // 逐块都不能"整体偏一个色"：把最差块的细节打出来便于排查
    console.log(`      整幅差 ${whole.toFixed(3)}；块差 max ${cmp.maxDiff.toFixed(2)} @ ${cmp.worst}（${cmp.blocks} 块）`);

    // 通道串位的直接检查：把 R/B 换过来以后，块差必须**明显变大**
    // （证明这条判据真的能抓到串色，而不是"怎么算都能过"）
    const swapped = new Uint8ClampedArray(out.data.length);
    for (let i = 0; i < out.width * out.height; i++) {
      swapped[i * 4] = out.data[i * 4 + 2];
      swapped[i * 4 + 1] = out.data[i * 4 + 1];
      swapped[i * 4 + 2] = out.data[i * 4];
      swapped[i * 4 + 3] = out.data[i * 4 + 3];
    }
    const cmpSwapped = compareBlocksPerceptual(src,
      { data: swapped, width: out.width, height: out.height }, fit.transform);
    ok(cmpSwapped.maxDiff > PERCEPTUAL_BLOCK_MAX * 2,
      '判据有效性自检：故意把 R/B 串位后，块差必须远超阈值（否则这条判据是空的）',
      `串位后 max ${cmpSwapped.maxDiff.toFixed(2)}`);

    // 整体错位一格也必须被抓到
    const shifted = new Uint8ClampedArray(out.data.length);
    for (let y = 0; y < out.height; y++) {
      for (let x = 0; x < out.width; x++) {
        const sx = Math.min(out.width - 1, x + 8);
        const so = (y * out.width + sx) * 4;
        const o = (y * out.width + x) * 4;
        shifted[o] = out.data[so]; shifted[o + 1] = out.data[so + 1];
        shifted[o + 2] = out.data[so + 2]; shifted[o + 3] = out.data[so + 3];
      }
    }
    const cmpShifted = compareBlocksPerceptual(src,
      { data: shifted, width: out.width, height: out.height }, fit.transform);
    ok(cmpShifted.maxDiff > PERCEPTUAL_BLOCK_MAX,
      '判据有效性自检：故意横向错位 8 px 后，块差必须超阈值',
      `错位后 max ${cmpShifted.maxDiff.toFixed(2)}`);
  }

  // 其余图：整幅均值分两档
  //   ① **没有缩放**（源尺寸 == 目标尺寸）⇒ 理论误差只有 8 bit 取整，用严格阈值
  //   ② 有缩放且是硬边/半透明图 ⇒ 二值化 + 最近邻抽样的固有差异，用宽松阈值
  for (const name of ['soft-edge-140', 'banner-logo-502x202', 'gradient-128', 'pixel-art-128',
    'small-64-with-transparent']) {
    const src = get(name);
    for (const mode of ['contain', 'cover'] as const) {
      const fit = fitToTarget(src, { mode, kernel: 'smooth' });
      const out: RgbaImage = { data: fit.data, width: fit.width, height: fit.height };
      const whole = meanDiff(regionMean(src, 0, 0, src.width, src.height),
        regionMean(out, 0, 0, out.width, out.height));
      const limit = wholeLimit(Math.abs(fit.transform.scale - 1) < 1e-9);
      ok(whole <= limit, `${name}/${mode}: 整幅区域均值差 ≤ ${limit}（缩放倍率 ${fit.transform.scale.toFixed(3)}）`,
        `实到 ${whole.toFixed(3)}`);
    }
  }

  // 最近邻下采样的**逐块忠实性**：把输出块按"目标 → 源"整数映射还原成"被抽到的源像素
  // 子集"，两者的块均值必须几乎相同（差别只来自 8 bit 取整）。
  // 这条是"nearest 没有整体错位/串色"的强判据 —— 它不受"棋盘抖动"影响，
  // 因为比的是"同一批采样点"，不是"整个区域"。
  {
    const src = get('photo-noise-300');
    const fit = fitToTarget(src, { mode: 'cover', kernel: 'smooth' });
    const out: RgbaImage = { data: fit.data, width: fit.width, height: fit.height };
    const plain = compareBlocksPerceptual(src, out, fit.transform);
    console.log(`      photo-noise 整幅差 ${meanDiff(regionMean(src, 0, 0, src.width, src.height),
      regionMean(out, 0, 0, out.width, out.height)).toFixed(3)}；`
      + `块差 max ${plain.maxDiff.toFixed(2)} @ ${plain.worst}（${plain.blocks} 块）`);

    const nearest = fitToTarget(src, { mode: 'cover', kernel: 'nearest' });
    const nOut: RgbaImage = { data: nearest.data, width: nearest.width, height: nearest.height };
    const cmpNearest = compareNearestBlocks(src, nOut, nearest.transform);
    ok(cmpNearest.blocks > 200, `nearest 逐块忠实性：参与比较的块足够多（${cmpNearest.blocks}）`);
    ok(cmpNearest.maxDiff <= NEAREST_BLOCK_MAX,
      `★ nearest 下采样：输出块均值 = 被抽到的源像素子集均值（≤ ${NEAREST_BLOCK_MAX}）`,
      `实到 max ${cmpNearest.maxDiff.toFixed(2)} @ ${cmpNearest.worst}`);
    ok(cmpNearest.samples > 10000, `nearest 逐块忠实性：比较了足够多的采样点（${cmpNearest.samples}）`);

    // 判据有效性自检：故意把 R/B 换过来、或整体错位 8 px，两种手段都必须被抓住
    const swapped = new Uint8ClampedArray(out.data.length);
    for (let i = 0; i < out.width * out.height; i++) {
      swapped[i * 4] = out.data[i * 4 + 2];
      swapped[i * 4 + 1] = out.data[i * 4 + 1];
      swapped[i * 4 + 2] = out.data[i * 4];
      swapped[i * 4 + 3] = out.data[i * 4 + 3];
    }
    const cmpSwapped = compareBlocksPerceptual(src,
      { data: swapped, width: out.width, height: out.height }, fit.transform);
    ok(cmpSwapped.maxDiff > PERCEPTUAL_BLOCK_MAX * 2,
      '判据有效性自检：故意把 R/B 串位后，块差必须远超阈值（否则这条判据是空的）',
      `串位后 max ${cmpSwapped.maxDiff.toFixed(2)}`);

    const shifted = new Uint8ClampedArray(out.data.length);
    for (let y = 0; y < out.height; y++) {
      for (let x = 0; x < out.width; x++) {
        const sx = Math.min(out.width - 1, x + PERCEPTUAL_BLOCK);
        const so = (y * out.width + sx) * 4;
        const o = (y * out.width + x) * 4;
        shifted[o] = out.data[so]; shifted[o + 1] = out.data[so + 1];
        shifted[o + 2] = out.data[so + 2]; shifted[o + 3] = out.data[so + 3];
      }
    }
    const cmpShifted = compareBlocksPerceptual(src,
      { data: shifted, width: out.width, height: out.height }, fit.transform);
    ok(cmpShifted.maxDiff > PERCEPTUAL_BLOCK_MAX,
      '判据有效性自检：故意横向错位 8 px 后，块差必须超阈值',
      `错位后 max ${cmpShifted.maxDiff.toFixed(2)}`);
  }

  // 减色不能把画面整体拉偏：减色后的整幅均值也要贴近源图
  for (const name of ['gradient-128', 'photo-noise-300']) {
    const src = get(name);
    const r = prepareEmblem(src, {});
    const whole = meanDiff(regionMean(src, 0, 0, src.width, src.height),
      regionMean({ data: r.rgba, width: r.width, height: r.height }, 0, 0, r.width, r.height));
    ok(whole <= PERCEPTUAL_WHOLE_MAX_SCALED, `${name}: 减色+缩放后整幅均值仍贴近源图`, `实到 ${whole.toFixed(3)}`);
  }

  // 减色不该"吃掉"像素：不透明像素数必须与"取景 + 二值化后"的一致
  {
    const src = get('gradient-128');
    const r = prepareEmblem(src, {});
    eq(opaqueCount({ data: r.rgba, width: r.width, height: r.height }), fitOpaqueCount(src),
      'gradient-128: 减色不改变"哪些像素不透明"');
  }
}

/**
 * "取景 + 二值化后"的不透明像素数 —— 即 `prepareEmblem` 送进减色器的那张图有多少实色点。
 * 减色只换颜色、不动 alpha ⇒ 这个数在减色前后必须完全一致。
 */
function fitOpaqueCount(src: RgbaImage): number {
  const fit = fitToTarget(src, { mode: 'contain' });
  const bin = binarizeAlpha({ data: fit.data, width: fit.width, height: fit.height }, 128);
  let n = 0;
  for (let i = 0; i < fit.width * fit.height; i++) if (bin[i * 4 + 3] === 0xff) n += 1;
  return n;
}

// --------------------------------------------------------------------------
// (f) 对接 emblem.ts
// --------------------------------------------------------------------------

function sectionBridge(): void {
  section('(f) 对接：prepareEmblem → encodeEmblem（18/18 校验 + extractImage 读回逐像素相同）');

  for (const f of fixtures) {
    const r = prepareEmblem(f, {});
    for (const isLr of [false, true]) {
      const label = `${f.name}/${isLr ? 'LR' : '非LR'}`;
      // headerTail：非 LR 的 9 字节作品常量必须来自真实存档，不能猜
      const headerTail = isLr ? null : realHeaderTail();
      const block = encodeEmblem(r.rgba, { isLr, headerTail });

      const v = verifyChecksums(block);
      eq(v.ok, true, `${label}: encodeEmblem 的输出 18 段校验全过`);
      eq(v.badSegments.length, 0, `${label}: 坏校验段 = 0`);

      const back = extractImage(block, 'index0');
      eq(back.length, r.rgba.length, `${label}: extractImage 读回的字节数一致`);
      const diff = firstPixelDiff(
        { data: r.rgba, width: r.width, height: r.height },
        { data: back, width: r.width, height: r.height },
        `${label} 读回：`);
      ok(diff === null, `★ ${label}: extractImage(block,'index0') **逐像素等于** prepareEmblem 的 rgba`, diff ?? '');

      // 'acet' 档也要一致：prepareEmblem 输出的实色 alpha 都是 255、透明都是 0，
      // 而 injectImage 只把 0xFF 当实色 ⇒ 两种口径在这份输入上应当等价
      const backAcet = extractImage(block, 'acet');
      const diff2 = firstPixelDiff(
        { data: r.rgba, width: r.width, height: r.height },
        { data: backAcet, width: r.width, height: r.height },
        `${label} acet 读回：`);
      ok(diff2 === null, `${label}: extractImage(block,'acet') 也逐像素相同（两条口径在合规输入上一致）`, diff2 ?? '');
    }
  }

  // 端到端：真实存档里的 headerTail + prepareEmblem + encodeEmblem ⇒ 拿来写卡就该长这样
  {
    const f = get('pixel-art-128');
    const r = prepareEmblem(f, {});
    const block = encodeEmblem(r.rgba, { isLr: false, headerTail: realHeaderTail() });
    eq(block.length, 0x4440, '非 LR 块长度 = 0x4440（17,472 字节）');
    // ⚠ 块头的字节值**逐字节对照真实存档**取，不背常量：
    //   非 LR 的前 12 字节是魔数（内容见 emblem.ts 的 EMBLEM_HEADER），
    //   而 0x14..0x1C 那 9 字节是**作品常量**（headerTail）。
    const real = realBlock();
    eq(Array.from(block.slice(0, 0x14)).join(','), Array.from(real.slice(0, 0x14)).join(','),
      '非 LR：从零造的块，前 0x14 字节与真实存档**逐字节相同**');
    eq(Array.from(block.slice(0x14, 0x14 + 9)).join(','), Array.from(realHeaderTail()).join(','),
      '非 LR：headerTail（0x14..0x1C）与真实存档相同');
    const back = extractImage(block, 'index0');
    let same = true;
    for (let i = 0; i < back.length && same; i++) if (back[i] !== r.rgba[i]) same = false;
    ok(same, '端到端：从零造的块读回来与准备结果一致（这就是"写卡"要用的那份数据）');
  }
}

/**
 * 非 LR 的 9 字节作品常量（0x14..0x1C）：从**真实存档夹具**里读，绝不猜。
 * 直接读 `fixtures\blocks\` 里的真实徽章块（与 core.test.ts 用的是同一批）。
 */
const REAL_BLOCK = 'Mcd001_final__BISLPS-25338E00__BISLPS-25338E00.raw';
let cachedBlock: Uint8Array | null = null;
function realBlock(): Uint8Array {
  if (!cachedBlock) {
    cachedBlock = new Uint8Array(readFileSync(join(HERE, 'fixtures', 'blocks', REAL_BLOCK)));
  }
  return cachedBlock;
}

let cachedHeaderTail: Uint8Array | null = null;
function realHeaderTail(): Uint8Array {
  if (!cachedHeaderTail) cachedHeaderTail = realBlock().slice(0x14, 0x14 + 9);
  return cachedHeaderTail;
}

// --------------------------------------------------------------------------
// 面积平均（smooth）的支撑区：独立参考实现对拍 + 放大档不许出透明像素
// --------------------------------------------------------------------------

function transparentCount(img: RgbaImage): number {
  let n = 0;
  for (let i = 0; i < img.width * img.height; i++) if (img.data[i * 4 + 3] === 0) n += 1;
  return n;
}

/**
 * **独立的**面积平均参考实现（教科书 box）—— 只用来对拍，不抄被测代码：
 *   · 支撑区 = `[c - half, c + half]`；
 *   · 与它有**正面积**交集的源像素 = `floor(a) … ceil(b) - 1`；
 *   · 权重 = 交集长度；源图外的部分**不补背景色**（只在支撑区完全落在图外时才是背景）。
 */
function refBox(
  src: ArrayLike<number>, sw: number, sh: number, dw: number, dh: number,
  scale: number, offsetX: number, offsetY: number,
): Uint8ClampedArray {
  const inv = 1 / scale;
  const half = 0.5 * inv;
  const out = new Uint8ClampedArray(dw * dh * 4);
  const span = (c: number, n: number): [number, number] => {
    const s0 = Math.max(0, Math.floor(c - half));
    const s1 = Math.min(n - 1, Math.ceil(c + half) - 1);
    return [s0, s1];
  };
  for (let ty = 0; ty < dh; ty++) {
    const cy = (ty + 0.5 - offsetY) * inv;
    const [y0, y1] = span(cy, sh);
    for (let tx = 0; tx < dw; tx++) {
      const o = (ty * dw + tx) * 4;
      const cx = (tx + 0.5 - offsetX) * inv;
      const [x0, x1] = span(cx, sw);
      if (y1 < y0 || x1 < x0) continue; // 全透明（背景）
      let r = 0; let g = 0; let b = 0; let a = 0; let ws = 0;
      for (let sy = y0; sy <= y1; sy++) {
        const wy = Math.min(cy + half, sy + 1) - Math.max(cy - half, sy);
        if (!(wy > 0)) continue;
        for (let sx = x0; sx <= x1; sx++) {
          const wx = Math.min(cx + half, sx + 1) - Math.max(cx - half, sx);
          if (!(wx > 0)) continue;
          const w = wx * wy;
          const so = (sy * sw + sx) * 4;
          r += src[so] * w; g += src[so + 1] * w; b += src[so + 2] * w; a += src[so + 3] * w;
          ws += w;
        }
      }
      if (!(ws > 0)) continue;
      out[o] = Math.round(r / ws); out[o + 1] = Math.round(g / ws);
      out[o + 2] = Math.round(b / ws); out[o + 3] = Math.round(a / ws);
    }
  }
  return out;
}

/** 造一张合成图（`makeImage` 的简写版：只给一个"取色"函数）。 */
const synth = (w: number, h: number, fn: (x: number, y: number) => [number, number, number]): RgbaImage =>
  makeImage(w, h, (x, y) => { const c = fn(x, y); return [c[0], c[1], c[2], 255]; });

function testAreaAverageSupport(): void {
  section('★ 面积平均的支撑区：与独立写的教科书 box 逐像素对拍 + 放大档不许出透明像素');

  // ── ① 支撑区必须覆盖"被部分覆盖"的像素：全不透明的图放大后**不许**出现透明像素 ──
  //   来由：下限写成 `ceil(a)` 会把那个像素整块丢掉，而放大时它是支撑区里唯一的一个
  //   ⇒ 支撑区算成空 ⇒ 整片走"补背景"（全不透明的输入会变成大片透明）。
  {
    const opaque64 = synth(64, 64, (x, y) => [(x * 4) % 256, (y * 4) % 256, 128]);
    const up2 = fitToTarget(opaque64, { mode: 'contain', kernel: 'smooth' });
    eq(transparentCount({ data: up2.data, width: 128, height: 128 }), 0,
      '★★ 64×64 全不透明 → 128×128（2× 放大）用面积平均：**一个透明像素都不许有**');

    const opaque3 = synth(3, 3, (x, y) => [x * 90, y * 90, 40]);
    const up43 = fitToTarget(opaque3, { mode: 'contain', kernel: 'smooth' });
    eq(transparentCount({ data: up43.data, width: 128, height: 128 }), 0,
      '★★ 3×3 全不透明 → 128×128（42.7× 放大）用面积平均：同样不许出现透明像素');
  }
  // ── ② 对拍：与**本文件独立写的**教科书 box 逐像素相同（面积平均的定义）──
  for (const name of ['photo-noise-300', 'soft-edge-140', 'small-64-with-transparent', 'banner-logo-502x202']) {
    const f = get(name);
    const fit = fitToTarget(f, { mode: 'contain', kernel: 'smooth' });
    const ref = refBox(f.data, f.width, f.height, 128, 128, fit.transform.scale, fit.transform.offsetX, fit.transform.offsetY);
    const diff = firstPixelDiff(
      { data: fit.data, width: 128, height: 128 },
      { data: ref, width: 128, height: 128 },
      `${name} smooth vs 教科书 box：`,
    );
    ok(diff === null, `★★ ${name}：面积平均与独立参考实现**逐像素相同**`, diff ?? '');
  }
  // ── ③ 缩小档同样对拍（倍率 < 1：支撑区更宽，权重表更复杂）──
  for (const [name, tw, th] of [['photo-noise-300', 32, 32], ['banner-logo-502x202', 64, 48]] as const) {
    const f = get(name);
    const fit = fitToTarget(f, { mode: 'contain', kernel: 'smooth', targetWidth: tw, targetHeight: th });
    const ref = refBox(f.data, f.width, f.height, tw, th, fit.transform.scale, fit.transform.offsetX, fit.transform.offsetY);
    const diff = firstPixelDiff(
      { data: fit.data, width: tw, height: th },
      { data: ref, width: tw, height: th },
      `${name} ${tw}×${th} smooth vs 教科书 box：`,
    );
    ok(diff === null, `★★ ${name} → ${tw}×${th}：非方形目标也逐像素相同`, diff ?? '');
  }
}

// --------------------------------------------------------------------------
// 主流程
// --------------------------------------------------------------------------

function main(): number {
  console.log('图像管线测试（web/src/core/image.ts）—— 零依赖，Node 原生跑 .ts');
  console.log(`夹具目录: ${IMGDIR}`);
  console.log(`夹具张数: ${fixtures.length}；目标尺寸 ${TARGET_SIZE}×${TARGET_SIZE}；色数上限 ${MAX_OPAQUE_COLORS}`);

  section1Fixtures();
  sectionGeometry();
  sectionLossless();
  sectionCompliance();
  sectionDeterminism();
  sectionPerceptual();
  sectionBridge();
  testFixedSemantics();
  testExternalEditorRoundTrip();
  testAreaAverageSupport();

  if (warnings.length > 0) {
    console.log(`\n⚠ ${warnings.length} 条警告（不影响通过/失败，但值得看一眼）：`);
    for (const w of warnings) console.log(`   · ${w}`);
  }

  if (failures.length > 0) {
    console.log(`\n✗ ${failures.length} 条不一致：`);
    for (const f of failures) console.log(`   · ${f}`);
  }

  const total = pass + failures.length;
  console.log(`\n=== 通过 ${pass} / ${total} ===`);
  return failures.length === 0 ? 0 : 1;
}

process.exitCode = main();
