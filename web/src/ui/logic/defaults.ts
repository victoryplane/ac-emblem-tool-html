/**
 * 界面参数默认值 —— 纯逻辑，零依赖、不碰 DOM。
 *
 * ★ 这里的每一个默认值都在 `SPEC.md` §五 的"已定默认值"列里写着，**不许自己发明**：
 *
 *   | 步 | 默认值 | 出处 |
 *   |---|---|---|
 *   | ② 取景 | ★ **手动**（拖拽平移 + 滚轮缩放，确认后生效） | SPEC.md §五 ② |
 *   | ③ 缩放核 | ★ **自动判断** | SPEC.md §五 ③ |
 *   | ④ alpha 阈值 | **128**（可调）+ **收边默认关闭** | SPEC.md §五 ④ |
 *   | ⑤ 减色上限 | **255**（只做中位切分） | SPEC.md §五 ⑤ / `image.ts::MAX_OPAQUE_COLORS` |
 *   | 目标尺寸 | **128×128** | SPEC.md §五 ⑦（PS1 将来只换参数） |
 *   | 编辑器放大 | 4×（1:1 与 4× 的游戏预览见 §四） | SPEC.md §四 |
 *
 * ⚠ `image.ts` 自己给的默认是 `contain` / `auto` / `128` / `despeckle:false`；
 *   本模块是**界面层**的默认，取景那一项**故意与核心不同**（SPEC.md 要求默认进"手动"）。
 *   `ui.test.ts` 会断言"界面默认 = SPEC 默认"，并断言**只有取景这一项**与核心默认不同。
 */

import { TARGET_SIZE, DEFAULT_ALPHA_THRESHOLD, MAX_OPAQUE_COLORS } from '../../core/image.ts';
import type { FitMode, ScaleKernelChoice } from '../../core/image.ts';

export interface UiParams {
  /** 目标尺寸（PS2 = 128；PS1 将来 64，只换这里的数）。 */
  targetSize: number;
  /**
   * ② 取景 —— ★ 界面**永远**是 `'manual'`（0.13 起删掉了四档下拉；`fillManualToTarget()` 导入时也会
   * 再钉一次）。字段本身留着：`prepareEmblem()` 的 `FitOptions.mode` 必须给一个值，
   * 而且将来要放开自动档只差一个控件。
   */
  fitMode: FitMode;
  /** ③ 缩放核。 */
  kernel: ScaleKernelChoice;
  /** ④ alpha 二值化阈值。 */
  alphaThreshold: number;
  /** ④ 收边（去杂点）—— ⚠ 界面入口 0.15 已删，但字段留着：默认仍是 `false`，核心实现与测试一个字没动。 */
  despeckle: boolean;
  /** 收边界邻居下限。 */
  despeckleMinNeighbors: number;
  /** ⑤ 减色上限 —— ⚠ 界面入口 0.15 已删（默认 255 = 格式上限 = 不额外减色），字段与核心能力都留着。 */
  maxColors: number;
  /**
   * 'manual' 专用：实际用的倍率 = `manualFitScale` × `manualZoom`。
   *
   * ★ 2026-10-05 的体验修正（**不改 SPEC §五 ② 的"默认进手动"，只改初始值**）：
   *   刚拖进一张图时，`manualFitScale` 会被算成"**刚好填满** 128×128 框"的倍率
   *   （例如 1707×1067 的图 ⇒ 128/1067 = 0.12），而不是 1:1。否则用户第一眼只看到图的中心一小块，
   *   以为"图没进去/变形了"。之后用户拖拽平移、滚轮缩放都在这个基础上做。
   *   ⚠ 默认**不是**"整张图缩进框里"（那会留透明边、图看着小；用户明确否掉了）。
   */
  manualScale: number;
  /** 'manual' 专用：导入图片时算出的"填满 128×128 框"倍率（换图会重算）。 */
  manualFitScale: number;
  /** 'manual' 专用：用户自己滚轮缩放的倍率（相对 fillScale；没缩过 = 1）。 */
  manualZoom: number;
  /**
   * 'manual' 专用：目标图左上角**对应源图的像素坐标**（= 界面的「取景数值 X/Y」，可为负）。
   * ⚠ 源像素口径，与 `image.ts` 的 `offsetX/offsetY`（目标像素）**差一个取反 ×scale**，
   *   换算只在 `manualOffsetToTarget()` 里做一遍。
   */
  manualOffsetX: number;
  manualOffsetY: number;
  /** 编辑器/预览放大倍数（§四 的 1:1 与 4×）。 */
  previewZoom: number;
}

/**
 * ★ 界面**没有入口**的那几项（0.19 收口，回答"哪些字段是用户可以动的、哪些是我们钉死的"）。
 *
 *   · `targetSize`  ：128（PS1 将来 64 —— 换这里 + 换一个控件）
 *   · `fitMode`     ：永远 `'manual'`（0.13 删掉四档下拉；见 `UiParams.fitMode` 的说明）
 *   · `despeckle`   ：永远关（0.15 删掉入口；它删像素，会破坏"≤255 色必须无损"那条判据）
 *   · `maxColors`   ：255 = 格式上限 = 不额外减色（0.15 删掉入口）
 *
 * ⇒ `DEFAULT_PARAMS` 里这几项**从这里取**，改行为只改这一处；界面能改的仍是那 5 项
 *   （`kernel` / `alphaThreshold` / `previewZoom` / `manual*`）。
 */
export const CORE_DEFAULTS = Object.freeze({
  targetSize: TARGET_SIZE, // 128
  fitMode: 'manual' as FitMode,
  despeckle: false,
  despeckleMinNeighbors: 3,
  maxColors: MAX_OPAQUE_COLORS, // 255
});

/** ★ SPEC.md §五 的默认值，唯一权威来源。 */
export const DEFAULT_PARAMS: Readonly<UiParams> = Object.freeze({
  targetSize: CORE_DEFAULTS.targetSize,
  fitMode: CORE_DEFAULTS.fitMode,
  kernel: 'auto', // ★ SPEC.md §五 ③：自动判断
  alphaThreshold: DEFAULT_ALPHA_THRESHOLD, // 128
  despeckle: CORE_DEFAULTS.despeckle,
  despeckleMinNeighbors: CORE_DEFAULTS.despeckleMinNeighbors,
  maxColors: CORE_DEFAULTS.maxColors,
  manualScale: 1, // 导入图片时会按"填满框"重算（见字段注释）
  manualFitScale: 1,
  manualZoom: 1,
  manualOffsetX: 0,
  manualOffsetY: 0,
  previewZoom: 4,
});

export function cloneDefaultParams(): UiParams {
  return { ...DEFAULT_PARAMS };
}

// ★ 2026-10-05（0.13）：原来这里有一张「取景四档」的界面文案表（`FIT_MODE_LABELS`），
//   跟着那个下拉一起**删掉了** —— 界面只有手动这一档（用户："这四个下拉选项有什么意义呢，
//   我感觉只需要一个就行了"）。核心 `core/image.ts` 的 `FitMode` 四档**一个都没动**：
//   将来要放开自动档，加回一张四行的文案表 + 一个 `<select>` 就行。

/** 缩放核的界面文案。 */
export const KERNEL_LABELS: ReadonlyArray<{ value: ScaleKernelChoice; label: string }> = [
  { value: 'auto', label: '自动判断' },
  { value: 'nearest', label: '最近邻（像素画）' },
  { value: 'smooth', label: '面积平均（照片）' },
];

/**
 * ★★ 取景偏移的**量纲转换**（源像素 → 目标像素）—— 2026-10-05 抓到并修掉的真 bug。
 *
 * ## 两套口径（**不一样**，混了就"图不见了"）
 *
 *   · 界面的 `manualOffsetX/Y` = **源像素**：目标图左上角**对应源图的哪一点**
 *     （`index.html` 的「取景数值 X/Y」就是这句文案；`fillOffsetFor()` 也按这个口径算，
 *      例：1000×800 填满框后 X = 100 = "框的左上都落到源图 x=100 上了"、Y = 0）。
 *   · `image.ts::FitOptions.offsetX/Y` = **目标像素**：仿射变换 `tx = sx·scale + offset`
 *     （见 `image.ts` 的 `transform` 注释与 `'contain'` 分支的 `(dstW − sw·s)/2`），
 *     也就是"**源图左上角落在目标图的哪个位置**"。
 *
 * 两者互为**相反数再乘 scale**：源图整体往下 100 个源像素 ⇔ 目标空间里 −100·scale。
 *
 * ## 上一版错在哪（可复现，`ui.test.ts` 分节 (l) 钉住）
 *
 * 旧代码把界面值**原样**塞进 `offsetX/offsetY`（少了取反与 ×scale）。对**正方形**图两套
 * 口径恰好都是 0 ⇒ 看不出来；一旦图不是正方形就成了大位移：
 *
 *   | 源图 | 旧代码输出不透明像素 | 修好后 |
 *   |---|---|---|
 *   | 1000×800 | 384 / 16384（2.3%，只剩一条缝） | 13312（81.3%） |
 *   | 1024×600 | **0 / 16384（全空）** | 9600（58.6%） |
 *
 * 用户的症状就是"按〔确定取景〕以后图片消失"：取景视图里画的是**源图本身**（永远看得见），
 * 一确定就切回 `#stage-final` 的 128×128 预览，而那份预览因为上面这条**全空**。
 * 换算只此一处，别再在别的地方乘一遍。
 */
export function manualOffsetToTarget(p: UiParams): { x: number; y: number } {
  const s = effectiveManualScale(p);
  return { x: -p.manualOffsetX * s, y: -p.manualOffsetY * s };
}

/** 把界面参数压成 `prepareEmblem()` 的选项（字段名/口径的**唯一**转换点）。 */
export function toPrepareOptions(p: UiParams): {
  targetWidth: number;
  targetHeight: number;
  mode: FitMode;
  kernel: ScaleKernelChoice;
  alphaThreshold: number;
  despeckle: boolean;
  despeckleMinNeighbors: number;
  maxColors: number;
  scale: number;
  offsetX: number;
  offsetY: number;
} {
  return {
    targetWidth: p.targetSize,
    targetHeight: p.targetSize,
    mode: p.fitMode,
    kernel: p.kernel,
    alphaThreshold: p.alphaThreshold,
    despeckle: p.despeckle,
    despeckleMinNeighbors: p.despeckleMinNeighbors,
    maxColors: p.maxColors,
    // 'manual' 的实际倍率 = "适应框"倍率 × 用户滚轮倍率（见 manualScale 的注释）
    scale: effectiveManualScale(p),
    // ⚠ 量纲转换在这里做，**只做这一遍**（见 manualOffsetToTarget 的长注释）
    offsetX: manualOffsetToTarget(p).x,
    offsetY: manualOffsetToTarget(p).y,
  };
}

/** `'manual'` 实际使用的倍率 = `manualFitScale × manualZoom`（单一计算点，别在别处再乘一遍）。 */
export function effectiveManualScale(p: UiParams): number {
  const s = (p.manualFitScale || 1) * (p.manualZoom || 1);
  return s > 0 ? s : 1;
}

/**
 * 算"把 `srcW×srcH` 的图**填满** `target×target` 框"所需的倍率 = `target / 短边`。
 *
 * 这就是**打开图片时的默认取景**（= 用户原话「图片默认就顶住这个方框部分，图片的一边顶住就行，
 * 顶住就停，不缩放」）：白框里**全是图、没有透明边**，图片长边方向多出来的部分落在框外等着被拖。
 *
 * ⚠ 与 0.8 及以前相反：那时用的是 `min(target/w, target/h)`（= 整张图缩进框里、两边留透明），
 *   于是用户看到的默认画面是"图变小了"，并且把〔↺ 复位/适应〕当成没用的按钮（按钮已删）。
 *   想看整张图仍然可以：进取景视图后**滚轮缩小**（上限 = 长边，那时会留透明边）。
 *
 * ⚠ 它**不是** `'manual'` 之外的第 5 种取景模式 —— SPEC §五 ② 的"默认进手动"没变，
 *   变的只是"刚进来时那个倍率/窗口是多少"。
 */
export function fillScaleFor(srcW: number, srcH: number, target = 128): number {
  if (!(srcW > 0) || !(srcH > 0) || !(target > 0)) return 1;
  return target / Math.min(srcW, srcH);
}

/**
 * "填满白框"时目标图左上角对应的源图像素坐标 = 源图**中央那个正方块**的左上角。
 *
 * 例：1707×1067 ⇒ 短边 1067 ⇒ 窗口 1067×1067、x = (1707−1067)/2 = 320、y = 0
 * （即白框里是"左右各裁掉 320 像素后的整幅高度"）。
 */
export function fillOffsetFor(srcW: number, srcH: number, target = 128): { x: number; y: number } {
  if (!(srcW > 0) || !(srcH > 0)) return { x: 0, y: 0 };
  const side = target / fillScaleFor(srcW, srcH, target);
  return { x: (srcW - side) / 2, y: (srcH - side) / 2 };
}

/**
 * 参数合法区间。
 *
 * ⚠ 2026-10-05（0.15）：参数行那三格（收边 / 减色上限 / 取景数值）按用户要求删掉之后，
 *   界面**只用到** `alphaThreshold`（那个滑杆 + 数字框）。
 * ★ 0.19：把没人读的三项（`previewZoom` / `manualScale` / `despeckleMinNeighbors`）也删了 ——
 *   "合法区间"如果需要，应该跟着界面控件一起长出来，而不是先囤在这里。
 *   剩两项：`alphaThreshold`（界面在用）与 `maxColors`（核心/测试用，PS1 的 15 色档就靠它）。
 */
export const PARAM_LIMITS = Object.freeze({
  alphaThreshold: { min: 1, max: 254, step: 1 },
  maxColors: { min: 2, max: 255, step: 1 },
});
