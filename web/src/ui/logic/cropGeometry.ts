/**
 * 取景视图的**几何与代数**（纯函数、零 DOM）—— 2026-10-05 的第二次重做（0.6 那一版）。
 *
 * ## 为什么推倒重来（两次都错在"框 ≠ 框里的东西"）
 *
 * 第一版（0.5 那一版）把"框"当成"手动取景参数在屏幕上的投影"来画，结果**框的位置和大小都算错了**
 * （见下），用户看到的是"框小得只剩几个像素、还跑到画布外面"，按〔确定取景〕后图就"没了"。
 * 第二版（本文件上一轮）把屏幕映射的方向修对了，但仍然是"先有参数、再推框" ——
 * 只要参数的**量纲**或**符号**有半点偏差，框与真正被裁的那块源图就会不一致，
 * 而这类错误**冒烟测试抓不到**（图层可见、画布尺寸对、18 段校验也过 —— 因为**空图**是合法输入）。
 *
 * 本版换了**因果方向**：以"白框在屏幕上框住的那块源图"为**唯一原始状态**，
 * 参数是它的**派生结果**。于是"所见即所得"是**构造性**成立的，不再依赖任何换算正确：
 *
 * ```
 *   状态 = 取景窗口（CropWindow：白框框住的源图区间，源像素 <正方形>）
 *   ├─ 屏幕：白框固定在舞台里（frameRectFor），源图按 k = 框边长 / 窗口边长 缩放/平移 —— 用来画
 *   └─ 参数：scale = 目标边长 / 窗口边长，offset(源像素) = 窗口左上角 —— 用来裁（← 直接就是界面口径）
 * ```
 *
 * ★★ 上一版错在哪（根因，两处，逐条记下来免得再犯）
 *
 *   ① **符号**：`image.ts::nearestFit` 的取样是 `源 = (目标 + 0.5 − offset)/scale`，
 *      于是"目标左上角对应的源坐标"= `−offset/scale`；我写成了 `+offset/scale` ⇒ 框反向跑。
 *   ② **多乘一个 scale**：源图在屏幕上的放大率**只有** `k`（`scale` 只决定裁多大一块，
 *      不改变源图在屏幕上的显示倍率）⇒ 框的屏幕边长 = `(目标边长/scale)·k`；
 *      我写成了 `(目标边长/scale)·k·scale` ⇒ 框小了一个 `scale` 倍（1000×800 那张：6.6px vs 400px）。
 *
 * 两处叠加 ⇒ 框又小又偏、框里只剩补的背景 ⇒ "确定之后图片消失"。
 * 现在这两个量都不再需要人手推：框的屏幕矩形由 `frameRectFor()` 定，参数由 `windowToManual()` 定。
 *
 * ## 坐标空间（每个量都标清，混一次就出错）
 *
 * | 量 | 空间 | 说明 |
 * |---|---|---|
 * | `CropWindow.size/x/y` | **源**像素 | 白框框住的源图正方形：`x/y` 是左上角在源图上的坐标 |
 * | `k` | 源像素 → **屏幕**像素 | `k = 框边长 / 窗口边长`（`imagePlacement()` 给出） |
 * | `manualScale` | 源像素 → **目标**像素 | `= 目标边长 / 窗口边长`（`windowToManual()`） |
 * | `manualOffsetX/Y` | **源**像素 | ★ 界面「取景数值 X/Y」的口径 = 窗口左上角（见 `defaults.ts::manualOffsetToTarget`） |
 *
 * ## 交互（用户 2026-10-05 定，只有一个动体；2026-10-05 晚 又删掉了"复位"）
 *
 *   · **白框固定不动**（正方形，位置只看舞台大小）；· **拖图片**（哪儿都能拖）= 平移源图；
 *   · **滚轮** = 以白框中心缩放；
 *   · 〔确定取景〕= 烘焙框内内容为 128×128；· 〔取消〕= 回滚。
 *
 * ## ★ 默认取景 = "填满白框"（`defaults.ts::fillScaleFor/fillOffsetFor`，0.9 定的）
 *
 * 用户原话：「每次打开图片，图片默认就顶住这个方框部分，图片的一边顶住就行，顶住就停，不缩放」。
 * 即：**窗口边长 = 源图短边、居中** ⇒ 白框里全是图、一个透明像素都不补。
 * 上一版是反的（窗口 = 长边 = 整张图缩进框里、两边留透明），用户看到的是"图变小了"，
 * 于是把那个〔↺ 复位 / 适应〕当成没用的按钮 —— 按钮已按他的要求删掉。
 */

import { effectiveManualScale, fillScaleFor, type UiParams } from './defaults.ts';

export interface StageBox {
  /** 舞台（`.crop-stage`）内部可用宽。 */
  w: number;
  /** 舞台内部可用高。 */
  h: number;
}

/** 取景框在舞台坐标里的位置与边长（**只由舞台尺寸决定** —— "框固定"的形式化保证）。 */
export interface FrameRect {
  left: number;
  top: number;
  size: number;
}

/** 取景窗口：白框在**源图**上框住的那块正方形（源像素）。 */
export interface CropWindow {
  /** 窗口边长（源像素）。 */
  size: number;
  /** 窗口左上角在源图上的 x（源像素，可为负 = 图上边被切掉一块）。 */
  x: number;
  /** 窗口左上角在源图上的 y。 */
  y: number;
}

/** 窗口边长的合法区间（源像素）。 */
export interface WindowBounds {
  min: number;
  max: number;
}

/** 滚轮一格的比例（`deltaY < 0` 乘它 = 放大窗口里那块 = 取更小的一块源图）。 */
export const ZOOM_STEP = 1.15;
/** 窗口边长的**绝对**下限（源像素）—— 只给退化的 0 尺寸输入兜底，别产生 0/NaN。 */
export const MIN_WINDOW_PX = 2;

function clampNum(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * 取景框边长规则。
 *
 * 取舞台可用边的 **70%**，夹在 `[120, 420]`，并且**一定留在舞台里**（上一版没做这个夹取，
 * 窄屏时框会顶出舞台）：
 *   · 70% 是观感折中（够大、四周又留得下"框外压暗"的余量）；
 *   · 下界 120 保证窄屏上也点得到、看得清；上界 420 避免超大窗口下框大得离谱。
 */
export function frameSizeFor(box: StageBox, ratio = 0.7, min = 120, max = 420): number {
  const side = Math.floor(Math.min(box.w, box.h));
  if (!(side > 0)) return 24;
  const cap = Math.max(24, side - 8); // 框必须留在舞台里
  const wanted = Math.max(min, Math.min(max, Math.floor(side * ratio)));
  return Math.max(24, Math.min(wanted, cap));
}

/** 框居中（位置只由舞台尺寸与框边长决定，**与窗口/参数无关**）。 */
export function frameRectFor(box: StageBox): FrameRect {
  const size = frameSizeFor(box);
  return { left: Math.floor((box.w - size) / 2), top: Math.floor((box.h - size) / 2), size };
}

/**
 * 窗口边长的合法区间（源像素）。
 *
 *   · `max` = 源图长边 ⇒ 最多缩到"整张图都看得见"（那时白框里会留透明边，允许 —— 徽章本来就常带透明边）；
 *   · ★★ `min` = **目标边长**（默认 128）⇒ **到 1:1 为止，不允许把源图放大**。
 *
 * ## 为什么下限是 128（而不是"1 个源像素铺满 128×128"）
 *
 * 用户 2026-10-05 的反馈（附截图）：选了一小片区域之后，出来的 128×128 是**一堆孤立的方块/麻点** ——
 * 因为那一小片本来就是暗底上稀疏的像素，把它放大成 128×128 只会得到"马赛克"，没有意义。
 * 他的要求：「要不我们限制白框最小取到 128*128」。所以：
 *
 *   · 窗口 = 128 源像素 ⇒ 烘焙 **1:1**（一个源像素对一个目标像素，不重采样）；
 *   · 再想小 → 夹住不动（滚轮会"到底"，状态行会写明）。
 *
 * ⚠ 源图本身比 128 小（例如 64×64 的 PNG 徽章）时下限退化成**短边**（= 整张图）：
 *   否则窗口比图还大、四周补透明边，徽章反而填不满 128×128。
 * ⚠ 真的需要"把小图放大成 128×128"的人（源图里那枚徽章本来就只有几十像素）得自己在外部先放大 ——
 *   这是**故意**的取舍：宁可挡住"吹像素"，也不出一个看着像坏掉的徽章。将来要放开就加一个显式的开关。
 *
 * ⚠ 默认取景（`defaults.ts::fillScaleFor/fillOffsetFor`）取的是**短边**，永远落在区间内部。
 */
export function windowBoundsFor(srcW: number, srcH: number, target = 128): WindowBounds {
  if (!(srcW > 0) || !(srcH > 0)) return { min: MIN_WINDOW_PX, max: MIN_WINDOW_PX };
  const max = Math.max(srcW, srcH);
  const short = Math.min(srcW, srcH);
  const min = Math.max(MIN_WINDOW_PX, Math.min(target > 0 ? target : 128, short));
  return { min: Math.min(min, max), max };
}

/**
 * 把窗口的一条轴的起点夹进合法范围，**保证白框里永远有图**。
 *
 *   · 窗口比图小（`size ≤ extent`）⇒ 窗口只能落在图内：`[0, extent − size]`（一个透明像素都不补）；
 *   · 窗口比图大（`size > extent`）⇒ 图只能落在窗口内：`[extent − size, 0]`（补最少的背景）。
 *
 * 两条合起来就是"框里总有内容"，而且**不会**像上一版那样能把图整张拖出框外
 * （上一版拖过头 ⇒ 输出全透明 ⇒ 看着就像"图没了"）。
 */
export function clampOriginFor(origin: number, size: number, extent: number): number {
  if (!(extent > 0)) return 0;
  if (size <= extent) return clampNum(origin, 0, extent - size);
  return clampNum(origin, extent - size, 0);
}

/** 夹取整个窗口（边长先夹进 `bounds`，再按上面的规则夹起点）。 */
export function clampWindow(win: CropWindow, srcW: number, srcH: number, bounds?: WindowBounds): CropWindow {
  const b = bounds ?? windowBoundsFor(srcW, srcH);
  const size = clampNum(win.size, b.min, b.max);
  return {
    size,
    x: clampOriginFor(win.x, size, srcW > 0 ? srcW : 1),
    y: clampOriginFor(win.y, size, srcH > 0 ? srcH : 1),
  };
}

/**
 * 滚轮缩放：以**白框中心**为锚点（框中心对应的源图点保持不动）。
 *
 * `factor > 1` = 放大（窗口变小）。锚点在源图上：`c = x + size/2`；缩放后让它仍落在框中心。
 * ⚠ 夹取之后锚点可能在边界上被挪一点 —— 这是**故意的**（优先保证"框里不空"）。
 */
export function zoomWindowAtCenter(
  win: CropWindow,
  factor: number,
  srcW: number,
  srcH: number,
  bounds?: WindowBounds,
): CropWindow {
  const b = bounds ?? windowBoundsFor(srcW, srcH);
  const size = clampNum(win.size / (factor > 0 ? factor : 1), b.min, b.max);
  const cx = win.x + win.size / 2;
  const cy = win.y + win.size / 2;
  return {
    size,
    x: clampOriginFor(cx - size / 2, size, srcW > 0 ? srcW : 1),
    y: clampOriginFor(cy - size / 2, size, srcH > 0 ? srcH : 1),
  };
}

/**
 * 拖动 = 平移图片（用户在**任何位置**拖都一样，不再分"框内/框外"）。
 *
 * 把图往右拖 `dScreenX` 屏幕像素 ⇒ 窗口在源图上整体**左移** `dScreenX / k`。
 * 而 `k = 框边长 / 窗口边长` ⇒ `窗口位移 = −dScreenX · 窗口边长 / 框边长`（**与 scale 无关**）。
 */
export function panWindow(
  win: CropWindow,
  dScreenX: number,
  dScreenY: number,
  frameSize: number,
  srcW: number,
  srcH: number,
  bounds?: WindowBounds,
): CropWindow {
  const perScreen = win.size / (frameSize > 0 ? frameSize : 1); // 屏幕 1px = 多少个源像素
  return clampWindow(
    { size: win.size, x: win.x - dScreenX * perScreen, y: win.y - dScreenY * perScreen },
    srcW,
    srcH,
    bounds,
  );
}

/** 白框框住的源图区间。 */
export function windowSourceRect(win: CropWindow): { x0: number; y0: number; x1: number; y1: number } {
  return { x0: win.x, y0: win.y, x1: win.x + win.size, y1: win.y + win.size };
}

/** 源像素 → 屏幕像素的倍率（`= 框边长 / 窗口边长`）。 */
export function displayScaleFor(win: CropWindow, frameSize: number): number {
  return win.size > 0 && frameSize > 0 ? frameSize / win.size : 1;
}

/**
 * 源图在舞台里的摆放：CSS 画布用 `transform: translate(left, top) scale(k)`（原点在左上角）。
 * 由"窗口左上角必须落在框左上角"直接推出：`left = 框.left − 窗口.x · k`。
 */
export function imagePlacement(box: StageBox, win: CropWindow): { left: number; top: number; k: number } {
  const f = frameRectFor(box);
  const k = displayScaleFor(win, f.size);
  return { left: f.left - win.x * k, top: f.top - win.y * k, k };
}

/**
 * ★★ 窗口 → 界面参数（**唯一**转换点，源像素口径）。
 *
 *   · `manualScale = 目标边长 / 窗口边长`；
 *   · `manualOffsetX/Y = 窗口左上角`（界面「取景数值 X/Y」就是这个意思，见 `defaults.ts`）；
 *   · `manualFitScale` = "**填满白框**"（默认取景）的倍率、`manualZoom` = 相对它的倍数
 *     （≥1 = 放大、<1 = 缩小到看得见整张图），这样参数行里的两个读数仍然是
 *     "默认取景 / 在它基础上放大多少倍"的意思。
 *
 * 送进 `prepareEmblem()` 之前还要过一道 `defaults.ts::manualOffsetToTarget()`（源像素 → 目标像素），
 * 那是**另一处**、且只有那一处换算。
 */
export function windowToManual(
  win: CropWindow,
  srcW: number,
  srcH: number,
  targetSize = 128,
): Pick<UiParams, 'manualScale' | 'manualFitScale' | 'manualZoom' | 'manualOffsetX' | 'manualOffsetY'> {
  const scale = win.size > 0 ? targetSize / win.size : 1;
  const fill = fillScaleFor(srcW, srcH, targetSize);
  return {
    manualScale: scale,
    manualFitScale: fill > 0 ? fill : 1,
    manualZoom: scale / (fill > 0 ? fill : 1),
    manualOffsetX: win.x,
    manualOffsetY: win.y,
  };
}

/** 界面参数 → 窗口（`windowToManual` 的逆；进取景视图时用它把"当前图片"接着显示下去）。 */
export function manualToWindow(params: UiParams, srcW: number, srcH: number, targetSize = 128): CropWindow {
  const scale = effectiveManualScale(params);
  const size = scale > 0 ? targetSize / scale : targetSize;
  return clampWindow({ size, x: params.manualOffsetX, y: params.manualOffsetY }, srcW, srcH);
}

// ────────────────────────── 烘焙结果的自检 ──────────────────────────

export interface BakeCheckInput {
  /** 烘焙结果的像素数（应为 targetSize²）。 */
  pixelCount: number;
  /** 不透明像素数（`alpha === 255`）。 */
  opaquePixels: number;
  /** 半透明像素数（存档只认 0x00/0x80，这里应为 0）。 */
  semiTransparent: number;
  /**
   * **白框覆盖的那块源图**里有没有不透明像素。
   * 它决定"输出全空"是**报错**（映射坏了）还是**警告**（用户自己选到了空白处）。
   */
  sourceRegionHasOpaque: boolean;
  targetSize?: number;
}

export interface BakeCheck {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * ★ 烘焙结果自检：**宁可报错，也不要静默显示空白**（用户上一版就是这么被坑的）。
 *
 * 三种"看起来就是图片消失了"的情形：尺寸不对 / 一个不透明像素都没有 / 还有半透明残留。
 * ⚠ "全空"分两种：源图那块**本来就有**不透明像素 ⇒ **错误**（取景映射坏了，必须修）；
 *   源图那块本来就是透的 ⇒ 只是**提醒**（用户确实选了空白处，导出会是全透明徽章）。
 */
export function checkBakeResult(input: BakeCheckInput): BakeCheck {
  const target = input.targetSize ?? 128;
  const errors: string[] = [];
  const warnings: string[] = [];
  if (input.pixelCount !== target * target) {
    errors.push(`烘焙结果 ${input.pixelCount} 像素 ≠ ${target}×${target}（${target * target}）`);
  }
  if (input.opaquePixels === 0) {
    if (input.sourceRegionHasOpaque) {
      errors.push(
        '白框里一个不透明像素都没有，可是白框盖住的源图是有内容的 —— 取景映射坏了（这是 bug，不是你的操作问题）。',
      );
    } else {
      warnings.push('白框里没有不透明像素（选到空白处了）：现在导出会是一张全透明的徽章。');
    }
  }
  if (input.semiTransparent > 0) {
    errors.push(`还有 ${input.semiTransparent} 个半透明像素（存档里 alpha 只有 0x00/0x80）`);
  }
  return { ok: errors.length === 0, errors, warnings };
}
