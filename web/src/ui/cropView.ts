/**
 * 取景视图（"按需"手动取景）—— 2026-10-05 用户第二、三次改版后的实现（0.7 那一版）。
 *
 * ## 用户定的交互（只有一个动体：图片）
 *
 *   · **白框不动**：屏幕正中一个固定边长的**白色方框** = "取景区"；
 *   · **拖动图片**（在哪儿拖都一样）= 平移源图，把要用的部分**拖进白框**；
 *   · **滚轮** = 以**白框中心**为锚点缩放 —— ★ 往里滚到"白框 = 目标边长（128 源像素）"就**停**
 *     （0.11 起**不允许把源图放大**：再小就是把几个像素吹成 128×128，出来是一堆马赛克）；
 *   · ★ 0.38（用户）：白框边长还可以**精确调** —— 取景动作行最左边是**滑条 + 输入框**
 *     （单位 = 源像素，`step=1`），锚点与滚轮**同一条规则**（白框中心不动）。
 *     来由：「现在的取景框只能用鼠标缩放，精度不够高」。入口是 `setCropWindowSize()`。
 *   · 〔确定取景〕= 把**白框里那一块**烘焙成 128×128（有自检，见 `confirmCrop`）；
 *   · 〔取消〕= 回滚到进入取景视图之前的参数。
 *
 * ★ 2026-10-05（0.9）：用户删掉了〔↺ 复位 / 适应〕（"我认为这个按钮没用，删了吧"），
 *   并要求**打开图片时默认就顶住白框** ⇒ 默认取景改成"填满"（`logic/defaults.ts::fillScaleFor()`，
 *   窗口边长 = 源图短边）。上一版默认是"整张图缩进框里"（两边留透明），
 *   所以那个按钮按一下反而"图变小"，这正是他说没用的原因。
 *
 * 用户原话：「为什么按了确定取景以后图片会消失」+「我希望这个部分的框就是一个矩形的、
 * 然后是有**一个白色方块作为取景的示意区域**，用户**手动拖动图片**，把要取的部分**拖到方块里**」。
 *
 * ## ★★ "图片消失"的根因（两个，都在这一版修掉）
 *
 * **① 参数的量纲错位（真正让人看见"图没了"的那个）** —— `logic/defaults.ts::toPrepareOptions`。
 *   界面的 `manualOffsetX/Y` 是**源像素**（"目标图左上角对应源图的哪一点"），
 *   而 `image.ts` 的 `offsetX/offsetY` 是**目标像素**（`tx = sx·scale + offset`）。
 *   旧代码原样传过去 ⇒ 对非正方形图就是一次巨大的错误位移：
 *   1000×800 只剩 384/16384 个不透明像素（一条缝），**1024×600 直接 0/16384（全空）**；
 *   正方形图两套口径都是 0，所以"有时候是好的"。取景视图里画的是**源图本身**（永远看得见），
 *   一〔确定取景〕就切回 `#stage-final` 的 128×128 预览 —— 而那份预览是空的。
 *
 * **② 白框的位置/大小算错了** —— 见 `logic/cropGeometry.ts` 的文件头。
 *   旧版把"框"当参数的投影来画：符号反了 + 多乘一个 scale ⇒ 框又小又偏，
 *   **框里看到的根本不是被裁下来的那块**。本版改成"框是原始状态、参数是派生结果"，
 *   所见即所得是**构造性**成立的（`ui.test.ts` 分节 (l) 拿真实 `prepareEmblem` 逐点比对）。
 *
 * ## ★★★ 0.7 那一版：拖动为什么卡（用户："取景时拖动/滚轮有点卡"）
 *
 * 实测（口径见汇报；1000×800 = 0.8 M 像素的源图）：
 *
 *   | 一次 `pointermove` 旧代码跑的东西 | 照片类源图 | logo 类源图（64 色） |
 *   |---|---|---|
 *   | `prepareEmblem()`（缩放 + 二值化 + **中位切分量化**） | **298 ms** | **53 ms** |
 *   | `imageStats()`（`renderOriginalBadge()` 里整张图扫一遍 + Set 去重） | **99 ms** | 10 ms |
 *   | 合计（60fps 的预算是 16.7 ms/帧） | **≈397 ms** | ≈63 ms |
 *
 * 也就是说：**旧代码每挪一个像素就把整条管线重跑一遍、还顺带重建统计面板**，
 * 一次拖动就是整帧预算的 4~24 倍 ⇒ 必然卡成幻灯片。
 * 而拖动真正需要的几何运算（`panWindow` + `imagePlacement` + `windowToManual`）实测只有 **0.001 ms**。
 *
 * 所以本版的分工是（照用户意见「确定取景以后再更新面板」）：
 *
 *   · **取景期间只动视觉**：`applyDrag()` / `applyZoom()` 只改窗口状态，
 *     用 `requestAnimationFrame` **合帧**（一帧最多写一次样式），
 *     **完全不碰 `state.params`、不调 `onChanged`（= 不跑管线、不重建任何面板）**；
 *   · **〔确定取景〕时才提交一次**：`commitWindow()` 写参数 → 调 `onChanged()`（整条管线跑 **1 次**）
 *     → 跑烘焙自检 → 关视图；
 *   · **〔取消〕连管线都不用跑**（参数从头到尾没被改过，只需把预览重新量一次尺寸）；
 *   · 离开取景视图时的"重新量尺寸"走单独的轻量回调 `onRelayout`（只重画 128×128 预览画布，
 *     不重算、不重建统计面板）。
 *
 * `ui.test.ts` 分节 (l9) 与 `build.mjs` 的取景冒烟都用**调用计数**钉住这条：
 * 连续拖动 + 滚轮 ⇒ `prepareEmblem` 调用 **0** 次、面板刷新 **0** 次；〔确定取景〕之后 ⇒ **各 1 次**。
 *
 * ## 与 `pipeline.ts` 的分工
 *
 * · 取景的**数学**全在 `logic/cropGeometry.ts`（纯函数）；本模块只做
 *   "进/出取景视图 + 把源图画到画布 + 摆白框 + 把指针动作翻成窗口状态"。
 * · 参数提交才要 `recompute()` + 重画 —— 那是 `main.ts` 注入的 `onChange`，本模块不 import 管线（避免环）。
 */

import { imageStats } from '../core/image.ts';
import { effectiveManualScale, type UiParams } from './logic/defaults.ts';
import {
  ZOOM_STEP,
  checkBakeResult,
  clampWindow,
  frameRectFor,
  imagePlacement,
  manualToWindow,
  panWindow,
  resizeWindowTo,
  windowBoundsFor,
  windowSourceRect,
  windowToManual,
  zoomWindowAtCenter,
  type CropWindow,
  type WindowBounds,
} from './logic/cropGeometry.ts';
import { t } from './logic/i18n.ts';
import { state, setStatus } from './state.ts';
import type { SourceImage } from './state.ts';
import { $, toast } from './dom.ts';

interface CropRefs {
  /** `#stage-crop`：取景层（hidden 切换）。 */
  layer: HTMLElement;
  /** `#crop-stage`：真正接指针的那块（白框与源图都相对它定位）。 */
  cropStage: HTMLElement;
  /** `#crop-frame`：**固定的白色方框**。 */
  frame: HTMLElement;
  /** `#stage-final`：平时显示"当前图片"的层。 */
  finalLayer: HTMLElement;
  /** `#crop-actions`：取景动作行（提示 + 两个按钮）。 */
  actions: HTMLElement;
  /** 工具条上的〔取景〕（进出取景视图）。 */
  cropBtn: HTMLButtonElement;
  /** `#preview-zoom-note`：取景时**藏起来**（那是"当前图片"的说明，取景时没有意义）。 */
  zoomNote: HTMLElement | null;
  /** 源图画布：自然尺寸 + `transform: translate/scale`。 */
  canvas: HTMLCanvasElement;
  /** ★ 0.38：白框边长的滑条（`#crop-size-range`，源像素）。 */
  sizeRange: HTMLInputElement | null;
  /** ★ 0.38：白框边长的输入框（`#crop-size-num`，源像素，可手输）。 */
  sizeNum: HTMLInputElement | null;
}

let refs: CropRefs | null = null;
/** 是否处在取景视图里。 */
let active = false;
/** ★ 取景的**唯一原始状态**：白框框住的那块源图（源像素的正方形窗口）。 */
let win: CropWindow | null = null;
/** 进入取景前的参数快照（取消时回滚）。 */
let snapshot: Pick<UiParams, 'manualFitScale' | 'manualZoom' | 'manualScale' | 'manualOffsetX' | 'manualOffsetY' | 'fitMode'> | null = null;
/** 画布里画的是哪一张源图（源图没换就不重画 —— 大图 putImageData 很贵）。 */
let painted: SourceImage | null = null;
/** 最近一次排版算出来的白框边长（指针换算要用；省掉每次 pointermove 都读一次布局）。 */
let frameSide = 0;
/** 舞台尺寸缓存：拖动时**一次布局读都不做**，只写样式（避免 layout thrash）。 */
let cachedBox: { w: number; h: number } | null = null;

/** 待合帧的取景动作（一帧最多应用一次；见文件头那段）。 */
let pending: { dx: number; dy: number; zoom: number } | null = null;
/** 已排队的 rAF id（0 = 没有排）。 */
let rafId = 0;

/** 由 `main.ts` 注入：**提交**取景参数后跑一次完整管线 + 刷新面板（避免本模块 import pipeline 造成环）。 */
let onChanged: (() => void) | null = null;
/**
 * 由 `main.ts` 注入：只把"当前图片"重新量一次尺寸再画一遍（**不重算、不重建统计面板**）。
 * 进出取景视图时那两层切换 ⇒ 预览容器从"没布局"变回"有布局"，需要这一下；
 * 但它不该顺带跑 `prepareEmblem()`（那是上一版卡顿的一部分）。
 */
let onRelayout: (() => void) | null = null;

/** 数字读数：小于 100 保留 1 位小数，否则取整（`describeWindow`/`confirmCrop` 共用一份）。 */
function fmt(v: number): string {
  return Math.abs(v) < 100 ? v.toFixed(1) : String(Math.round(v));
}

function collect(): CropRefs {
  if (refs) return refs;
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  canvas.className = 'crop-canvas';
  $('view-source').appendChild(canvas);
  refs = {
    layer: $('stage-crop'),
    cropStage: $('crop-stage'),
    frame: $('crop-frame'),
    finalLayer: $('stage-final'),
    actions: $('crop-actions'),
    cropBtn: document.getElementById('btn-crop') as HTMLButtonElement,
    zoomNote: document.getElementById('preview-zoom-note'),
    canvas,
    sizeRange: document.getElementById('crop-size-range') as HTMLInputElement | null,
    sizeNum: document.getElementById('crop-size-num') as HTMLInputElement | null,
  };
  installPointer(refs);
  return refs;
}

/**
 * 写状态行。
 *
 * ★ 0.40：原来这里自己又写了一遍 `#status`（`setStatus()` 已经写了）⇒ 拖动期间每帧写两遍同一个
 *   节点，纯浪费。现在就是 `setStatus()` 的薄包装，只负责把 `redo` 一起带上（切语言时重说）。
 */
function setStatusText(text: string, redo?: () => string): void {
  setStatus(text, redo ?? null);
}

/**
 * 舞台内部可用尺寸（`.crop-stage` 的盒子 = 白框与源图的共同坐标系）。
 *
 * ⚠ 读 `getBoundingClientRect()` 会**强制布局**。拖动时一帧读一次本身还行，但"读→写→读→写"
 *   交替就是 layout thrash；所以这里的结果**缓存**起来，由 `layoutCropView()` 刷新、
 *   窗口尺寸变化时（`resize`）作废 —— 拖动过程中一次读都不做。
 */
function stageBox(): { w: number; h: number } {
  if (cachedBox) return cachedBox;
  const r = collect();
  const rect = r.cropStage.getBoundingClientRect();
  cachedBox = { w: Math.max(16, Math.floor(rect.width)), h: Math.max(16, Math.floor(rect.height)) };
  return cachedBox;
}

function windowBounds(): WindowBounds | null {
  const s = state.source;
  // ★ 下限跟**目标边长**走（PS2 = 128）：窗口到 128 源像素就是 1:1，再小就是"吹像素"（见 cropGeometry 的长注释）
  return s ? windowBoundsFor(s.width, s.height, state.params.targetSize) : null;
}

/** 取当前窗口（没有就从参数推；永远夹在合法区间里）。 */
function resolveWindow(): CropWindow | null {
  const s = state.source;
  if (!s) return null;
  const b = windowBounds();
  if (!win) win = manualToWindow(state.params, s.width, s.height, state.params.targetSize);
  win = b ? clampWindow(win, s.width, s.height, b) : win;
  return win;
}

/**
 * 把源图画进画布（**只在换图时**重画一次）。
 *
 * ⚠ 画布按**源图自然尺寸**做 CSS 像素，再整体 `scale(k)`：
 *   这样"源像素 → 屏幕像素"只有一个因子 `k`，与 `cropGeometry` 的推导完全一致，
 *   **不能**用 `max-width:100%` 之类让浏览器二次缩放（那会让指针换算悄悄算歪）。
 */
function paintSourceIfNeeded(s: SourceImage): void {
  const r = collect();
  if (painted === s && r.canvas.width === s.width && r.canvas.height === s.height) return;
  r.canvas.width = s.width;
  r.canvas.height = s.height;
  r.canvas.style.width = `${s.width}px`;
  r.canvas.style.height = `${s.height}px`;
  const ctx = r.canvas.getContext('2d') as CanvasRenderingContext2D;
  ctx.clearRect(0, 0, s.width, s.height);
  const tmp = document.createElement('canvas');
  tmp.width = s.width;
  tmp.height = s.height;
  const tctx = tmp.getContext('2d') as CanvasRenderingContext2D;
  tctx.putImageData(new ImageData(s.data, s.width, s.height), 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(tmp, 0, 0);
  painted = s;
}

/**
 * 重排取景视图：摆白框（只看舞台尺寸）+ 按窗口把源图缩放/平移到正确位置。
 *
 * 白框的位置/边长来自 `frameRectFor(box)`；源图的位置来自 `imagePlacement(box, win)`
 * —— 后者保证"**窗口左上角正好落在白框左上角**"，也就是用户看到的那句话：
 * 白框里框住的那块源图，就是确定以后要被裁下来的那块。
 *
 * ★ 这个函数**只写样式**（+ 一帧一次的状态行文本），不读布局（盒子走缓存）、
 *   不碰参数、不跑管线、不重建任何面板 —— 所以可以每帧调一次。
 */
export function layoutCropView(): void {
  if (!active) return;
  const r = collect();
  const s = state.source;
  if (!s) return;
  const box = stageBox();
  const f = frameRectFor(box);
  frameSide = f.size;
  // ★ 0.41：角标文字（`styles.css` 的 `.crop-frame::after { content: attr(data-label) }`）按
  //   **唯一真值** `params.targetSize` 写 —— 原来 CSS 里写死 '128×128'，换目标边长就会撒谎。
  {
    const label = `${state.params.targetSize}×${state.params.targetSize}`;
    if (r.frame.getAttribute('data-label') !== label) r.frame.setAttribute('data-label', label);
  }
  r.frame.style.left = `${f.left}px`;
  r.frame.style.top = `${f.top}px`;
  r.frame.style.width = `${f.size}px`;
  r.frame.style.height = `${f.size}px`;

  const w = resolveWindow();
  if (!w) return;
  paintSourceIfNeeded(s);
  const pl = imagePlacement(box, w);
  r.canvas.style.transformOrigin = '0 0';
  r.canvas.style.transform = `translate(${pl.left}px, ${pl.top}px) scale(${pl.k})`;
  // 放大（或整数倍缩小）用最近邻，其余缩小用浏览器平滑 —— 与核心选核的口径一致
  // （口径在 `core/image.ts::selectScaleKernel()`；0.41 审查顺手删掉了没人调用的旧包装 `chooseKernel()`）
  const inv = pl.k > 0 ? 1 / pl.k : 1;
  const crisp = pl.k >= 1 - 1e-9 || Math.abs(inv - Math.round(inv)) < 1e-9;
  r.canvas.style.imageRendering = crisp ? 'pixelated' : 'auto';
}

/**
 * ★ 0.40：切语言时重画取景那几行**文字**（`#crop-readout` + 状态行里那句"取景：白框 = …"）。
 *
 * 为什么需要单独一个入口：`layoutCropView()` **只写样式**，文字全在 `describeWindow()` 里，
 * 而切语言那条路原来只调了 `layoutCropView()` ⇒ 白框下面那行读数停在旧语言
 * （审查抓到的：中文进取景 → 切 English，读数还是"左上角 (320, 0) · 倍率 0.120 · ★ 已到最小…"）。
 * ⚠ 顺带把舞台尺寸缓存作废：两种语言的读数长短不同 ⇒ 动作行高度可能变 ⇒ 白框要重新摆一次。
 */
export function refreshCropText(): void {
  if (!active) return;
  describeWindow();
  cachedBox = null;
  layoutCropView();
}

/**
 * ★ 0.12：取景动作行里那格**实时读数**（白框 = 源图哪一块 / 倍率 / 是否已到最小）。
 *
 * ⚠ 为什么要有它：这些数字原来只写进 `#status`，而状态行在**页面最下面**（8 槽那一块），
 *   取景时看不见（用户："ok了，然后状态行在哪"）。这里就在白框正下方，跟着拖动/滚轮一起变。
 * 每帧只写一次 `textContent`（不读布局、不建 DOM），性能契约不受影响。
 */
function setReadout(text: string, atMin = false): void {
  const host = document.getElementById('crop-readout');
  if (!host) return;
  host.textContent = text;
  host.className = atMin ? 'crop-readout at-min' : 'crop-readout';
}

/**
 * ★ 0.38（用户）：把白框边长**一步设成** `size` 源像素 —— 滑条与输入框共用的**唯一**入口。
 *
 * 用户原话：「在图中红方块位置放一个缩放条，用于控制白框取景的大小，边上再加一个输入框，
 * 可以实时看到目前取景框的大小，也可以修改大小」「现在的取景框只能用鼠标缩放，精度不够高」。
 *
 * ⚠ 与拖动/滚轮一样**只动视觉**：不碰 `state.params`、不跑管线（性能契约不变，见文件头）。
 * 锚点是**白框中心**（`resizeWindowTo()`），与滚轮同一条规则 ⇒ 两种操作手感一致。
 */
export function setCropWindowSize(size: number): void {
  const s = state.source;
  if (!active || !s || !win) return;
  win = resizeWindowTo(win, size, s.width, s.height, windowBounds() ?? undefined);
  layoutCropView();
  describeWindow(); // 顺手把滑条 / 输入框同步成夹取之后的真值
}

/**
 * 把滑条与输入框同步成**当前窗口**的边长（滚轮/拖动改过之后也要跟上）。
 *
 * ⚠ 两条纪律：
 *   ① **输入框正在被编辑时不回写** —— 否则用户敲"1"（想输 180）就先被夹成 128 再写回框里，
 *      字直接被吃掉。`force = true`（敲完那一下：`change` / `blur`）才写：那一刻用户已经
 *      "交卷"了，把夹取之后的真值显示给他才是对的（输 `9999` 就该看到 `604`，不能留一个假读数）。
 *   ② 值没变就**不写** —— 这个函数每帧（拖动/滚轮期间）都会被 `describeWindow()` 叫一次，
 *      无谓的赋值会让浏览器白干活。
 */
function syncSizeControls(force = false): void {
  const b = windowBounds();
  if (!b || !win) return;
  const r = collect();
  const v = Math.round(win.size);
  const lo = Math.ceil(b.min);
  const hi = Math.floor(b.max);
  for (const el of [r.sizeRange, r.sizeNum]) {
    if (!el) continue;
    if (el.min !== String(lo)) el.min = String(lo);
    if (el.max !== String(hi)) el.max = String(hi);
    if (el.step !== '1') el.step = '1';
  }
  if (r.sizeRange && r.sizeRange.value !== String(v)) r.sizeRange.value = String(v);
  if (r.sizeNum && (force || document.activeElement !== r.sizeNum) && r.sizeNum.value !== String(v)) {
    r.sizeNum.value = String(v);
  }
}

/** 输入框里那串字 ⇒ 边长；不是数字（空串 / 半截负号）⇒ `null`（这一下什么都不做）。 */
function sizeFromInput(raw: string): number | null {
  const v = Number(raw.trim());
  return Number.isFinite(v) && v > 0 ? Math.round(v) : null;
}

/**
 * 绑定滑条与输入框。
 *
 *   · 滑条：`input` 事件实时生效（`step=1` ⇒ 精确到一个源像素）；
 *   · 输入框：`input` 事件里**只认合法数字**（边打边生效），敲完（`change`/`blur`）再校正一次
 *     —— 手输 `99999` 会被夹到上限、清空则回到当前值，两种都不会留下一个假读数。
 */
function bindSizeControls(r: CropRefs): void {
  r.sizeRange?.addEventListener('input', () => {
    const v = sizeFromInput(r.sizeRange?.value ?? '');
    if (v !== null) setCropWindowSize(v);
  });
  r.sizeNum?.addEventListener('input', () => {
    const v = sizeFromInput(r.sizeNum?.value ?? '');
    if (v !== null) setCropWindowSize(v);
  });
  const tidy = (): void => {
    const v = sizeFromInput(r.sizeNum?.value ?? '');
    if (v !== null) setCropWindowSize(v);
    syncSizeControls(true); // 敲完了 ⇒ 强制把框里的字改成夹取之后的真值（输 9999 要看到 604）
  };
  r.sizeNum?.addEventListener('change', tidy);
  r.sizeNum?.addEventListener('blur', tidy);
}

/** 状态行上的取景读数（白框 = 源图上的哪一块）—— 顺手把当前倍率也报出来。 */
function describeWindow(): void {
  const s = state.source;
  if (!s || !win) return;
  const scale = state.params.targetSize / win.size;
  // ★ 0.11：窗口有**下限**（= 目标边长，1:1）⇒ 到底了就明确说一句，别让人以为滚轮坏了
  const b = windowBounds();
  const atMin = !!b && win.size <= b.min + 1e-6;
  // ★ 0.38：读数里**不再重复"白框 N×N 源像素"** —— 它就写在同一个动作行的输入框里
  //   （那一格既可看又可改）；这一行挤了会把〔取消〕顶到第二行去。留下的是"位置 + 倍率 + 到没到最小"。
  // ① 白框下面那行（取景时唯一看得见的地方）
  setReadout(
    t(
      `左上角 (${fmt(win.x)}, ${fmt(win.y)}) · 倍率 ${scale.toFixed(3)}`,
      `top-left (${fmt(win.x)}, ${fmt(win.y)}) · zoom ${scale.toFixed(3)}`, `左上 (${fmt(win.x)}, ${fmt(win.y)}) · 倍率 ${scale.toFixed(3)}`, `왼쪽 위 (${fmt(win.x)}, ${fmt(win.y)}) · 배율 ${scale.toFixed(3)}`,
    ) + (atMin ? t(' · ★ 已到最小（1:1，不能再放大）', ' · ★ At minimum (1:1, cannot zoom in further)', ' · ★ 最小です（1:1、これ以上拡大できません）', ' · ★ 최소입니다(1:1, 더 이상 확대할 수 없음)') : ''),
    atMin,
  );
  // ② 页面最下面的状态行（也在写入日志旁边，留着方便回溯）
  //   ★ 0.40：写成**一个可重算的函数**并交给 `setStatus()` 当 `redo` —— 切语言时它会按新语言
  //   再说一遍（读的是**当前**窗口，所以拖动之后再切语言也不会说到旧数字）。
  const statusLine = (): string => {
    if (!win) return '';
    const sc = state.params.targetSize / win.size;
    const min = !!b && win.size <= b.min + 1e-6;
    return (
      t(
        `取景：白框 = 源图 ${fmt(win.size)}×${fmt(win.size)}，左上角 (${fmt(win.x)}, ${fmt(win.y)})，倍率 ${sc.toFixed(3)}`,
        `Crop: box = ${fmt(win.size)}×${fmt(win.size)} of the source image, top-left (${fmt(win.x)}, ${fmt(win.y)}), zoom ${sc.toFixed(3)}`, `トリミング：白枠 = 元画像の ${fmt(win.size)}×${fmt(win.size)}、左上 (${fmt(win.x)}, ${fmt(win.y)})、倍率 ${sc.toFixed(3)}`, `자르기: 흰색 상자 = 원본 이미지 ${fmt(win.size)}×${fmt(win.size)}, 왼쪽 위 (${fmt(win.x)}, ${fmt(win.y)}), 배율 ${sc.toFixed(3)}`,
      ) +
      (min
        ? t(
            `　——　★ 已经到最小（1:1，再往里滚不会更小：不允许把源图放大）`,
            '  —  ★ Already at minimum (1:1; scrolling further will not shrink it: upscaling the source is not allowed)', '　——　★ すでに最小です（1:1。これ以上スクロールしても小さくなりません：元画像の拡大はできません）', '　——　★ 이미 최소입니다(1:1, 더 스크롤해도 더 작아지지 않습니다: 원본 이미지 확대는 허용되지 않습니다)',
          )
        : '') +
      t(
        `　——　拖图片移动 · 滚轮缩放（缩小可看到整张图）；参数面板等〔确定取景〕时一次更新。`,
        '  —  Drag to move · scroll to zoom (zoom out to see the whole image); the parameter panel updates once you press Apply crop.', '　——　ドラッグで画像を移動 · ホイールで拡大縮小（縮小すると画像全体が見えます）。パラメータパネルは〔トリミングを確定〕で一度に更新されます。', '　——　드래그로 이미지 이동 · 휠로 확대·축소(축소하면 이미지 전체가 보입니다). 매개변수 패널은〔자르기 적용〕을 누를 때 한 번에 갱신됩니다.',
      )
    );
  };
  setStatusText(statusLine(), statusLine);
  // ★ 0.38：滑条 / 输入框跟着一起同步（滚轮、拖动、进视图都从这里过）
  syncSizeControls();
}

// --------------------------------------------------------------------------
// 拖动/滚轮：只动视觉，rAF 合帧（**不跑管线**）
// --------------------------------------------------------------------------

/**
 * 把 `pending` 里的位移/缩放应用到窗口上，然后重排一次（**一帧只会跑一次**）。
 * 没有待处理动作时也重排一下（那是"窗口尺寸变了/手动强制刷新"的情形）。
 */
function applyPending(): void {
  const s = state.source;
  if (!s || !win || !pending) {
    if (active) layoutCropView();
    return;
  }
  const { dx, dy, zoom } = pending;
  pending = null;
  let next = win;
  // ★ 0.19（D15）：**先平移、后缩放**。累积的拖动量是"用户看到的那一屏"上量出来的，
  //   而 `panWindow` 要用屏幕倍率换算；先缩放就会拿**新**倍率去换算旧位移（一帧内偏差）。
  if (dx !== 0 || dy !== 0) {
    // `frameSide` 由 `layoutCropView()` 在每次进入/重排时写好；本函数只在取景视图里跑，
    // 所以它一定 > 0（不再需要"取不到就现算一次"的第二个真值来源）。
    next = panWindow(next, dx, dy, frameSide, s.width, s.height, windowBounds() ?? undefined);
  }
  if (zoom !== 1) next = zoomWindowAtCenter(next, zoom, s.width, s.height, windowBounds() ?? undefined);
  win = next;
  layoutCropView();
  describeWindow();
}

/**
 * ★ 把待处理的动作**立刻**应用 + 重排（并撤掉已排队的 rAF）。
 *
 * 浏览器里由 `scheduleFlush()` 的 rAF 每帧调一次；抬手时、以及测试/冒烟里
 * （桩环境没有真实帧循环）由本函数直接调 —— 两条路走的是同一段代码。
 */
export function flushCropLayout(): void {
  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = 0;
  }
  applyPending();
}

function scheduleFlush(): void {
  if (rafId) return;
  // 浏览器里一帧最多刷一次；桩环境（node:vm）把 rAF 实现成 setTimeout，同样只是"稍后一次"
  rafId = requestAnimationFrame(() => {
    rafId = 0;
    applyPending();
  });
}

/**
 * 拖动图片 `dx/dy` 屏幕像素（**指针处理与测试/冒烟共用这一个入口**）。
 * 只累加待处理量 + 排一次 rAF，**不**碰参数、**不**跑管线。
 */
export function applyDrag(dx: number, dy: number): void {
  if (!active || !win || !state.source) return;
  if (dx === 0 && dy === 0) return;
  pending = { dx: (pending?.dx ?? 0) + dx, dy: (pending?.dy ?? 0) + dy, zoom: pending?.zoom ?? 1 };
  scheduleFlush();
}

/** 缩放一格（`factor > 1` = 放大；同样只动视觉）。 */
export function applyZoom(factor: number): void {
  if (!active || !win || !state.source) return;
  if (!(factor > 0) || factor === 1) return;
  pending = { dx: pending?.dx ?? 0, dy: pending?.dy ?? 0, zoom: (pending?.zoom ?? 1) * factor };
  scheduleFlush();
}

/** 丢掉还没应用的动作（离开取景视图时用）。 */
function cancelPending(): void {
  pending = null;
  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = 0;
  }
}

/** 供测试/冒烟：当前取景视图的可观测状态（窗口 + 视觉）。 */
export function cropInfo(): {
  active: boolean;
  size: number;
  x: number;
  y: number;
  frameSide: number;
  transform: string;
} {
  return {
    active,
    size: win ? win.size : 0,
    x: win ? win.x : 0,
    y: win ? win.y : 0,
    frameSide,
    transform: refs ? String(refs.canvas.style.transform ?? '') : '',
  };
}

// --------------------------------------------------------------------------
// 指针：拖动 = 平移图片；滚轮 = 以白框中心缩放
// --------------------------------------------------------------------------

function installPointer(r: CropRefs): void {
  let dragging = false;
  let lastX = 0;
  let lastY = 0;

  const pointOf = (ev: PointerEvent): { x: number; y: number } => {
    const rect = r.cropStage.getBoundingClientRect();
    return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
  };

  r.cropStage.addEventListener('pointerdown', (ev) => {
    if (!active || !state.source || ev.button !== 0) return;
    const p = pointOf(ev);
    dragging = true;
    lastX = p.x;
    lastY = p.y;
    r.cropStage.classList.add('dragging');
    r.cropStage.setPointerCapture?.(ev.pointerId);
    ev.preventDefault();
  });

  r.cropStage.addEventListener('pointermove', (ev) => {
    if (!active || !dragging) return;
    const p = pointOf(ev);
    const dx = p.x - lastX;
    const dy = p.y - lastY;
    lastX = p.x;
    lastY = p.y;
    // ★ 在哪儿拖都一样：拖的是**图片**。只记下位移（一帧后合并应用），不在这里改样式、不跑管线。
    applyDrag(dx, dy);
  });

  const stop = (ev: PointerEvent): void => {
    if (!dragging) return;
    dragging = false;
    r.cropStage.classList.remove('dragging');
    r.cropStage.releasePointerCapture?.(ev.pointerId);
    flushCropLayout(); // 抬手时把还没上屏的那点位移立刻补上
  };
  r.cropStage.addEventListener('pointerup', stop);
  r.cropStage.addEventListener('pointercancel', stop);

  r.cropStage.addEventListener(
    'wheel',
    (ev) => {
      if (!active || !state.source) return;
      // `passive: false` + preventDefault：不让滚轮带着页面一起滚（那也算"卡"的一部分）
      ev.preventDefault();
      applyZoom(ev.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP);
    },
    { passive: false },
  );
}

// --------------------------------------------------------------------------
// 进 / 出 / 确定 / 取消
// --------------------------------------------------------------------------

/** 取景视图是否开着。 */
export function isCropActive(): boolean {
  return active;
}

/**
 * 把取景窗口**提交**成参数，并跑**一次**完整管线 + 刷新面板。
 *
 * ★ 全模块只有这里会写 `state.params` / 调 `onChanged`：拖动与滚轮一律不动面板（见文件头那段）。
 * 参数派生走 `windowToManual()`（源像素口径），`manualScale` 再用 `effectiveManualScale()` 复核一次 ——
 * 界面上显示的倍率与真正送进 `prepareEmblem()` 的一定是同一个数。
 */
function commitWindow(): void {
  const s = state.source;
  if (!s || !win) return;
  const p = windowToManual(win, s.width, s.height, state.params.targetSize);
  state.params.fitMode = 'manual';
  state.params.manualFitScale = p.manualFitScale;
  state.params.manualZoom = p.manualZoom;
  state.params.manualOffsetX = p.manualOffsetX;
  state.params.manualOffsetY = p.manualOffsetY;
  state.params.manualScale = effectiveManualScale(state.params);
  onChanged?.();
}

/** 关掉取景层（不动参数、不跑管线）；"当前图片"重新量尺寸交给轻量回调。 */
function teardown(): void {
  const r = collect();
  cancelPending();
  active = false;
  win = null;
  r.layer.hidden = true;
  r.finalLayer.hidden = false;
  r.actions.hidden = true;
  setReadout(''); // 动作行收起来了，把那行读数也清掉（下次进来由 describeWindow() 重填）
  r.cropBtn.classList.remove('primary');
  if (r.zoomNote) r.zoomNote.hidden = false;
  // 预览那层刚变回可见 ⇒ 它的容器这一帧还没有布局，量不到正确尺寸。
  // 下一帧**只**重画 128×128 预览（不重算、不重建统计面板）—— 这正是"面板刷新"被摘掉的那部分。
  onRelayout?.();
  window.setTimeout(() => onRelayout?.(), 0);
}

/** 进/出取景视图（同一格里切换；不动布局结构）。 */
export function setCropView(on: boolean): void {
  const r = collect();
  if (on === active) {
    if (on) layoutCropView();
    return;
  }
  if (on) {
    const s = state.source;
    if (!s) {
      // ★ 0.40：这句话也要能"重说"（切语言时按新语言再说一遍），所以带上 redo
      const line = (): string =>
        t(
          '还没有导入图片 —— 先「选择 / 粘贴图片」。（取景是"按需"的：点这里才进取景视图）',
          'No image imported yet - press "Choose / paste image" first. (Cropping is on demand: this button switches into the crop view.)', '画像がまだ読み込まれていません——先に「画像を選択／貼り付け」を押してください。（トリミングは"オンデマンド"です：ここを押すとトリミングビューに入ります）', '아직 이미지를 불러오지 않았습니다 —— 먼저 「이미지 선택 / 붙여넣기」를 누르세요. (자르기는 "필요할 때만" 합니다: 이 버튼을 눌러야 자르기 보기로 들어갑니다)',
        );
      setStatusText(line(), line);
      return;
    }
    snapshot = {
      manualFitScale: state.params.manualFitScale,
      manualZoom: state.params.manualZoom,
      manualScale: state.params.manualScale,
      manualOffsetX: state.params.manualOffsetX,
      manualOffsetY: state.params.manualOffsetY,
      fitMode: state.params.fitMode,
    };
    active = true;
    // 接着**当前参数**显示（"当前图片"里那块是啥，白框里就是啥），进出都不改参数
    win = manualToWindow(state.params, s.width, s.height, state.params.targetSize);
    cancelPending();
    // ★ 进视图时 `.crop-actions` 那行会从隐藏变可见 ⇒ 舞台高度会变一点点，缓存作废重测一次
    cachedBox = null;
    r.layer.hidden = false;
    r.finalLayer.hidden = true;
    r.actions.hidden = false;
    r.cropBtn.classList.add('primary');
    if (r.zoomNote) r.zoomNote.hidden = true; // ★ 取景时不显示"按容器缩放"那行说明（它讲的是旁边那块预览）
    layoutCropView();
    describeWindow();
    setStatusText(
      t(
        '取景中：拖动图片，把要用的部分放进白框里（滚轮缩放）。' +
          '参数面板要等〔确定取景〕才更新一次（这样拖动才不卡）；〔取消〕原样返回。',
        'Cropping: drag the image so the part you want sits inside the white box (scroll to zoom). ' +
          'The parameter panel updates only when you press Apply crop (that is what keeps dragging smooth); Cancel returns unchanged.', `トリミング中：画像をドラッグして、使う部分を白枠に入れてください（スクロールでズーム）。パラメータパネルは〔トリミングを確定〕を押したときに一度だけ更新されます（そのほうがドラッグが滑らかです）。〔キャンセル〕は元のまま戻ります。`, `자르기 중: 이미지를 드래그해 사용할 부분을 흰색 상자 안에 넣으세요(스크롤로 확대·축소). 매개변수 패널은 〔자르기 적용〕을 눌렀을 때 한 번만 갱신됩니다(그래야 드래그가 끊기지 않습니다). 〔취소〕는 그대로 되돌립니다.`,
      ),
    );
  } else {
    teardown();
  }
}

export function openCropView(): void {
  setCropView(true);
}

export function closeCropView(): void {
  setCropView(false);
}

/** 当前窗口与**已提交的参数**是否不一致（= 有还没确定的调整）。 */
function hasUncommittedWindow(): boolean {
  const s = state.source;
  if (!s || !win) return false;
  const p = windowToManual(win, s.width, s.height, state.params.targetSize);
  return (
    Math.abs(p.manualScale - state.params.manualScale) > 1e-9 ||
    Math.abs(p.manualOffsetX - state.params.manualOffsetX) > 1e-9 ||
    Math.abs(p.manualOffsetY - state.params.manualOffsetY) > 1e-9
  );
}

/**
 * 工具条上那个〔取景〕按钮：进/出取景视图。
 *
 * ★ 出去时**不能静默丢掉**用户刚拖好的取景（这一版的参数只在这一刻才写回去）：
 *   有未提交的调整 ⇒ 走〔确定取景〕那条路（写参数 + 跑一次管线 + 过烘焙自检 + 弹提示）；
 *   没有任何调整 ⇒ 直接收起（连管线都不跑）。
 *   想**放弃**调整请按〔取消〕。
 */
export function toggleCropView(): void {
  if (!active) {
    setCropView(true);
    return;
  }
  if (hasUncommittedWindow()) confirmCrop();
  else setCropView(false);
}

/**
 * ★ 白框里那块源图里有没有不透明像素（决定"烘出全空"是报错还是用户自己选到了空白处）。
 * 找到第一个就返回，所以正常情况是 O(1)。
 */
function windowRegionHasOpaque(s: SourceImage, w: CropWindow): boolean {
  const r = windowSourceRect(w);
  const x0 = Math.max(0, Math.floor(r.x0));
  const y0 = Math.max(0, Math.floor(r.y0));
  const x1 = Math.min(s.width, Math.ceil(r.x1));
  const y1 = Math.min(s.height, Math.ceil(r.y1));
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (s.data[(y * s.width + x) * 4 + 3] === 255) return true;
    }
  }
  return false;
}

/**
 * 〔确定取景〕：先跑**烘焙自检**，再关掉取景视图。
 *
 * ★ 自检不过就**不关**：用户上一版被"静默的空白"坑过，所以这里宁可弹错误、让他继续调，
 *   也不接受"确定之后图就没了"。三种情形：尺寸不对 / 源图那块有内容却烘出全空 / 还有半透明残留。
 */
export function confirmCrop(): void {
  if (!active) return;
  flushCropLayout(); // 把还没上屏的那点拖动补上（抬手与按钮点击之间可能差一帧）
  const s = state.source;
  const w = resolveWindow();
  if (!s || !w) {
    setCropView(false);
    return;
  }
  // ★★ 整条管线在这里跑**唯一的一次**（用户："确定取景以后再更新面板"）
  commitWindow();
  const p = state.prepared;
  if (!p) {
    const why = state.prepareError ?? t('prepareEmblem 没有产出结果。', 'prepareEmblem produced no result.', 'prepareEmblem が結果を返しませんでした。', 'prepareEmblem 이 결과를 내지 못했습니다.');
    const line = (): string =>
      t(
        `〔确定取景〕没通过：${why}（视图先不关，你可以继续拖/缩放，或按〔取消〕）`,
        `Apply crop failed: ${why} (the view stays open - keep dragging/zooming, or press Cancel)`, `〔トリミングを確定〕に失敗しました：${why}（ビューは開いたままです —— ドラッグ／拡大縮小を続けるか、〔キャンセル〕を押してください）`, `〔자르기 적용〕실패: ${why} (보기는 닫지 않습니다 - 계속 드래그/확대·축소하거나〔취소〕를 누르세요)`,
      );
    setStatusText(line(), line);
    toast('error', t('取景没法确定：这一步没算出 128×128', 'Cannot apply the crop: this step did not produce a 128×128 image', 'トリミングを確定できません：この手順で 128×128 が生成されませんでした', '자르기를 적용할 수 없습니다: 이 단계에서 128×128이 만들어지지 않았습니다'), why);
    return;
  }
  const st = imageStats({ data: p.rgba, width: p.width, height: p.height });
  const check = checkBakeResult({
    pixelCount: p.width * p.height,
    opaquePixels: st.opaquePixels,
    semiTransparent: st.semiTransparent,
    sourceRegionHasOpaque: windowRegionHasOpaque(s, w),
    targetSize: state.params.targetSize,
  });
  if (!check.ok) {
    // ★ 0.19（D13）：这句话原来写死"白框里看不到任何内容"，可失败也可能是"还有半透明像素"
    //   或尺寸不符 ⇒ 文案与真实原因打架。现在开头只陈述事实，原因交给 `check.errors`。
    const how = t(
      '〔确定取景〕没通过自检，所以先不关这个视图（你可以继续拖 / 缩放，或按〔取消〕）。',
      'Apply crop did not pass the self-check, so this view stays open (keep dragging/zooming, or press Cancel).', '〔トリミングを確定〕がセルフチェックを通らなかったため、このビューは開いたままにします（ドラッグ／拡大縮小を続けるか、〔キャンセル〕を押してください）。', '〔자르기 적용〕이 자체 점검을 통과하지 못해 이 보기를 닫지 않습니다 —— 계속 드래그/확대·축소하거나〔취소〕를 누르세요.',
    );
    setStatusText(`${how} ${check.errors[0]}`, () => `${how} ${check.errors[0]}`);
    toast('error', how, check.errors.join('\n'));
    return;
  }
  // ★ 这里**不再**调 onChanged：commitWindow() 已经刷过一次了（一次确定 = 一次管线）
  teardown();
  const okLine = (): string =>
    t(
      `取景已确定：白框 = 源图 ${fmt(w.size)}×${fmt(w.size)} @(${fmt(w.x)}, ${fmt(w.y)})，倍率 ${state.params.manualScale.toFixed(3)}。` +
        `想改就再点〔取景〕。`,
      `Crop applied: box = ${fmt(w.size)}×${fmt(w.size)} of the source image @(${fmt(w.x)}, ${fmt(w.y)}), zoom ${state.params.manualScale.toFixed(3)}. ` +
        `Press Crop again to change it.`, `トリミングを確定しました：白枠 = 元画像 ${fmt(w.size)}×${fmt(w.size)} @(${fmt(w.x)}, ${fmt(w.y)})、倍率 ${state.params.manualScale.toFixed(3)}。変更するにはもう一度〔トリミング〕を押してください。`, `자르기를 적용했습니다: 흰색 상자 = 원본 이미지 ${fmt(w.size)}×${fmt(w.size)} @(${fmt(w.x)}, ${fmt(w.y)}), 배율 ${state.params.manualScale.toFixed(3)}. 바꾸려면 〔자르기〕를 다시 누르세요.`,
    );
  setStatusText(okLine(), okLine);
  if (check.warnings.length > 0) {
    toast('warn', t('取景已确定，但有一点要注意', 'Crop applied, but note this', 'トリミングを確定しましたが、1 点注意があります', '자르기를 적용했습니다. 다만 한 가지 주의할 점이 있습니다'), check.warnings.join('\n'));
  } else {
    toast(
      'ok',
      t('取景已确定', 'Crop applied', 'トリミングを確定しました', '자르기를 적용했습니다'),
      t(
        `${p.width}×${p.height} · 实色 ${p.report.colorsAfter} · 不透明像素 ${st.opaquePixels}`,
        `${p.width}×${p.height} · ${p.report.colorsAfter} colors · ${st.opaquePixels} opaque pixels`, `${p.width}×${p.height} · 実色 ${p.report.colorsAfter} · 不透明ピクセル ${st.opaquePixels}`, `${p.width}×${p.height} · 실제 색 ${p.report.colorsAfter} · 불투명 픽셀 ${st.opaquePixels}`,
      ),
    );
  }
}

/**
 * 〔取消〕：回滚到进入取景前的参数，再关闭。
 *
 * ★ 参数在取景期间**从来没被改过**，所以这里通常只是把快照再写回去（幂等），
 *   **不需要跑管线** —— 直接把视图关掉、"当前图片"重新量一次尺寸就行。
 */
export function cancelCrop(): void {
  if (!active) {
    setCropView(false);
    return;
  }
  if (snapshot) {
    state.params.manualFitScale = snapshot.manualFitScale;
    state.params.manualZoom = snapshot.manualZoom;
    state.params.manualScale = snapshot.manualScale;
    state.params.manualOffsetX = snapshot.manualOffsetX;
    state.params.manualOffsetY = snapshot.manualOffsetY;
    state.params.fitMode = snapshot.fitMode;
    snapshot = null;
  }
  teardown();
  setStatusText(
    t('已取消取景（参数回到进入前的状态）。', 'Crop cancelled (the parameters are back to what they were).', 'トリミングをキャンセルしました（パラメータは元の状態に戻りました）。', '자르기를 취소했습니다 (매개변수가 들어오기 전 상태로 돌아갔습니다).'),
    () => t('已取消取景（参数回到进入前的状态）。', 'Crop cancelled (the parameters are back to what they were).', 'トリミングをキャンセルしました（パラメータは元の状態に戻りました）。', '자르기를 취소했습니다 (매개변수가 들어오기 전 상태로 돌아갔습니다).'),
  );
}

/** 由 `main.ts` 在启动时调用一次：注入回调（提交 / 轻量重排）+ 绑按钮。 */
export function initCropView(opts: { onChange: () => void; onRelayout?: () => void }): void {
  onChanged = opts.onChange;
  // ★ 0.45（简化普查复核）：这个 `?? opts.onChange` 的**回落点是完整管线**（`recompute()` + 重画图片）。
  //   哪天调用方忘传 `onRelayout`，一进/一出取景视图就会跑它 —— 正是 0.7 花一整版修掉的卡顿
  //   （文件头那张 397 ms 的表），而且**不会有任何测试变红**（`main.ts` 现在两样都传）。
  //   ⇒ 新增调用方时 `onRelayout` 必须传；要更稳就把回落点改成空实现，别指向 `onChange`。
  onRelayout = opts.onRelayout ?? opts.onChange ?? null;
  const r = collect();
  r.cropBtn.addEventListener('click', () => toggleCropView());
  $('btn-crop-ok').addEventListener('click', () => confirmCrop());
  $('btn-crop-cancel').addEventListener('click', () => cancelCrop());
  // ★ 0.38：白框边长的滑条 / 输入框（用户："精度不够高"）
  bindSizeControls(r);
  // 窗口尺寸变了：白框（只看舞台）与源图显示倍率都要重排；窗口本身（源像素）不变。
  // 这里必须**强制重新量一次**舞台（缓存作废），然后只做视觉重排。
  window.addEventListener('resize', () => {
    cachedBox = null;
    if (active) flushCropLayout();
  });
}

// （0.11：原来这里导出的 `CROP_MAX_ZOOM` 跟着 `MAX_ZOOM` 一起删掉了 —— 缩放区间不再是"长边/64"，
//   而是"下限 = 目标边长（不放大）／上限 = 长边"，见 `logic/cropGeometry.ts::windowBoundsFor`。）
