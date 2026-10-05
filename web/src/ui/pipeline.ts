/**
 * 图片管线接线 —— 解码 / 重算 / 三个视图 / 手动取景交互。
 *
 * 分工（SPEC.md §五 + PORT-NOTES.md §五）：
 *   · **canvas 只负责解码**（`createImageBitmap` → 画到 canvas → `getImageData`）；
 *   · 缩放 / alpha 二值化 / 减色 / 合规检查全部是 `src/core/image.ts` 里的**纯 TS 函数**；
 *   · 本文件只做"把参数搬进 `prepareEmblem()`、把结果画到 canvas 上"这一层。
 *
 * ★ 三个视图的口径：
 *   · 原图        = 解码后的像素（1:1 采样显示，带透明棋盘）
 *   · 游戏预览    = `prepared.rgba`，**索引 0 口径**（`extractImage(..., 'index0')` 同口径）——
 *                   这是实机验证过的游戏行为（SPEC.md §五 ★、问题 20）
 *   · 128×128 画布 = 编辑器的挂载点（本里程碑只留占位）
 *
 * ⚠ 手动取景的语义（`image.ts::FitOptions`）：
 *   `scale` 是**相对"回到原始尺寸"的倍率**，`offsetX/offsetY` 是**目标图左上角对应的源图像素坐标**，
 *   二者相互独立（改缩放不重置平移）。拖拽 1 个屏幕像素 = 1/zoom 个源图像素。
 */

import { checkCompliance, prepareEmblem, type PrepareResult } from '../core/image.ts';
import { state, setPrepared } from './state.ts';
import { fillOffsetFor, fillScaleFor, toPrepareOptions } from './logic/defaults.ts';
import { $, el, clear } from './dom.ts';

// --------------------------------------------------------------------------
// 小工具
// --------------------------------------------------------------------------

/**
 * 画一版"游戏口径"的预览。
 *
 * ★ 为什么这里**什么都不做**（只创建 canvas）：`prepareEmblem()` 返回的 `rgba` 已经就是
 *   游戏口径 —— 透明像素 `(0,0,0,0)`、其余 `alpha = 255`，而且**索引 0 只出现在透明像素上**
 *   （它的注释与 `checkCompliance` 都钉住了这两条）。所以预览只要 `putImageData` 即可。
 *   ⚠ 曾经这里按用户阈值再"归一化"一次 alpha；那是**错的**：用户把阈值从 128 调到 200 时，
 *     颜色其实没变，预览却会凭空多出"透掉的像素"，与真正写入卡里的东西不一致。
 *     预览的唯一职责是"把 prepared.rgba 原样画出来"。
 */
function bufferToCanvas(data: Uint8ClampedArray, w: number, h: number): HTMLCanvasElement {
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext('2d') as CanvasRenderingContext2D;
  ctx.putImageData(new ImageData(data, w, h), 0, 0);
  return cv;
}
/** 解码任意图片文件 → RGBA。★ 唯一"canvas 干活"的地方。 */
export async function decodeImageFile(file: Blob, name: string): Promise<{ data: Uint8ClampedArray; width: number; height: number; name: string }> {
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch (e) {
    // 明确不支持的类型给明确的提示（SPEC.md §五：不吃 PSD/TIFF/多页 RAW，且**不做格式猜测**）
    throw new Error(
      `解不开这张图（${name}）：${e instanceof Error ? e.message : String(e)}\n` +
        '支持的：PNG / JPEG / WebP / GIF（首帧）/ BMP / ICO / AVIF / SVG。' +
        'PSD / TIFF / 多页 RAW 请先导出 PNG。',
    );
  }
  const w = bmp.width;
  const h = bmp.height;
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(bmp, 0, 0);
  const img = ctx.getImageData(0, 0, w, h);
  bmp.close?.();
  return { data: img.data, width: w, height: h, name };
}

// --------------------------------------------------------------------------
// 重算
// --------------------------------------------------------------------------

/**
 * ★ 性能哨兵（2026-10-05，0.7 那一版加的）：`prepareEmblem()` / `refreshImage()` 各被调了多少次。
 *
 * 用户报"取景时拖动/滚轮有点卡"，实测卡在"每挪一个像素就把整条管线重跑一遍"
 * （1000×800 的源图：`prepareEmblem()` 298 ms + 统计面板里的 `imageStats()` 99 ms ≈ 397 ms / 次）。
 * 现在取景期间**一次都不跑**，只在〔确定取景〕时跑一次 —— 这两个计数就是它的**可观测判据**：
 * `ui.test.ts` 分节 (l9) 与 `build.mjs` 的取景冒烟都断言
 * "拖动 + 滚轮 N 次 ⇒ 0 / 0；〔确定取景〕之后 ⇒ 1 / 1"。
 * 只在内存里加一、对外只读，不影响任何行为。
 */
let prepareCallCount = 0;
let refreshCallCount = 0;

/** 读性能哨兵（`main.ts` 会挂到 `window.EmblemToolCore.ui.pipeline` 上，供 F12 / 冒烟用）。 */
export function pipelineStats(): { prepareCalls: number; refreshCalls: number } {
  return { prepareCalls: prepareCallCount, refreshCalls: refreshCallCount };
}

/** 把当前参数重新算一遍（128×128 很快，参数一变就调）。 */
export function recompute(): { ok: boolean; error: string | null } {
  const src = state.source;
  if (!src) {
    setPrepared(null, null);
    return { ok: false, error: null };
  }
  let result: PrepareResult;
  try {
    prepareCallCount += 1; // ★ 计数放在真正的重活前面（抛错也算跑过）
    result = prepareEmblem(
      { data: src.data, width: src.width, height: src.height },
      toPrepareOptions(state.params),
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    setPrepared(null, msg);
    return { ok: false, error: msg };
  }
  // ★ 整份替换，绝不跨次复用 palette/indices
  setPrepared(result, null);

  if (!result.report.compliance.ok) {
    return { ok: false, error: result.report.compliance.issues.join('；') };
  }
  return { ok: true, error: null };
}

// --------------------------------------------------------------------------
// 统计面板 —— ★ 0.17 起**整块删除**
// --------------------------------------------------------------------------
//
// 用户："我认为实时统计这个部分，整个就没什么作用" → 讨论后他选"整个删掉"。
// 这里原来有 `renderStats()`（9 行：原图尺寸/色数/半透明、取景·缩放核、补的背景、二值化改动、
// 缩放后再二值化、收边删掉的像素、减色前后色数、是否无损、★ 合规结论）—— 那是我移植管线时给自己看的。
//
// ⚠ 核心**一个字段都没少**：`prepareEmblem()` 返回的 `report` 还在，要查就 F12：
//     `EmblemToolCore.ui.state.prepared.report`
//   **合规**仍然挡在写卡那一步（`writeGuard.ts` 拒绝写入并说明原因；写完后日志里也有
//   "图像合规（128×128 / 实色 ≤255 / 半透明 0）"这一行）。

/**
 * 单独复核一次"最终 rgba"（不依赖 report），用来在写入前再挡一道。
 *
 * ★ 0.19：去掉两个恒定的入参（`maxColors` 恒为 255、宽高取自身）—— 判据不变，调用面更小。
 *   ⚠ 这次重算**是刻意的**（SPEC §八 2："写入后必须回读 + 不合规就拒绝写入"）——
 *     不是"忘了复用 `prepareEmblem().report.compliance`"。
 */
export function recheckFinal(): { ok: boolean; issues: string[] } {
  const p = state.prepared;
  if (!p) return { ok: false, issues: ['还没有可写入的图像'] };
  const c = checkCompliance({ data: p.rgba, width: p.width, height: p.height }, { indices: p.indices });
  return { ok: c.ok, issues: c.issues };
}

// --------------------------------------------------------------------------
// 视图
// --------------------------------------------------------------------------

interface ViewRefs {
  /** "当前图片"那一块画布：既是预览、也是 M4b 的编辑画布（索引 0 口径）。 */
  preview: HTMLCanvasElement;
}

let views: ViewRefs | null = null;

/** 建/取"当前图片"画布（只在容器里还没有时建一次）。 */
export function ensureViews(): ViewRefs {
  if (views && views.preview.isConnected) return views;
  const host = $('view-preview');
  clear(host);
  const cv = el('canvas', { width: 128, height: 128 });
  cv.style.imageRendering = 'pixelated';
  host.appendChild(cv);
  views = { preview: cv };
  return views;
}

/**
 * ★ 把"期望显示倍数"换算成**实际能装进容器的像素尺寸**（2026-10-05 用户要求去掉滚动条）。
 *
 * 语义：`previewZoom` 是**期望**倍数（4× ⇒ 512 px），但三块视图的容器**不再滚动**
 *   （`overflow: hidden`）⇒ 装不下时**自动缩到刚好装下**，即倍率变成"上限"。
 *   缩了就在那一块的说明行里淡淡标一句"已按容器缩放显示"，免得人以为开关坏了。
 *
 * 为什么在 JS 里算而不是靠 CSS：`max-width:100%` 只能量化"容器宽度"，
 *   而 4×/8× 撑高时真正的限制是**容器高度**；用 `max-height` 让浏览器缩又会丢掉
 *   "实际显示了多少倍"这个信息，没法告诉用户"已被缩小"。
 *   ⚠ 容器尺寸由 CSS 定（`.stage` 的 min-height + 栅格高度），所以每次重画读一次即可；
 *     `overflow: hidden` 也保证永远不会因为量不准而溢出。
 */
function fitDisplaySize(cv: HTMLCanvasElement, targetPx: number): { size: number; shrunk: boolean } {
  // ⚠ 量**舞台本身**（`.stage`），不要量 `#view-preview`：后者的尺寸曾经由"里面的 canvas"决定
  //   （content 收缩），与 canvas 互相决定 ⇒ **量一次缩一次**（128→116→104…，最后 68px）。
  //   舞台的尺寸由 CSS（`flex: 1 1 auto` + `min-height` + 列宽）定死，量它才是"可用空间"。
  //   （`#view-preview` 同时也在 CSS 里补了 `width/height: 100%`，两道都在。）
  const box = cv.closest('.stage') ?? cv.parentElement;
  const rect = box ? box.getBoundingClientRect() : null;
  let availW: number;
  let availH: number;
  if (rect && rect.width > 1 && rect.height > 1) {
    // 扣掉 padding 与 1px 边框；再留 2px 富余，避免"刚好卡在边界上"时被裁掉一条边
    const padX = 8 + 2;
    const padY = 8 + 2 + 2;
    availW = Math.max(16, rect.width - padX);
    availH = Math.max(16, rect.height - padY);
  } else {
    // 量不到（还没布局 / 隐藏）⇒ 退回容器高度减去内边距的保守值
    availW = 240;
    availH = 240;
  }
  const cap = Math.min(targetPx, availW, availH);
  return { size: Math.max(16, Math.floor(cap)), shrunk: cap < targetPx - 0.5 };
}

/** 更新"已按容器缩放显示"的提示行（淡色小字；没缩小就清空）。 */
function updateZoomNote(id: string, requested: number, actualPx: number, shrunk: boolean, hasImage: boolean): void {
  const host = document.getElementById(id);
  if (!host) return;
  clear(host);
  if (!hasImage || !shrunk) return;
  const actual = Math.round((actualPx / 128) * 100) / 100;
  host.appendChild(
    el('span', {
      class: 'zoom-note',
      text: `已按容器缩放显示：期望 ${requested}×（${requested * 128}px）→ 实际约 ${actual}×（${actualPx}px）`,
    }),
  );
}

/**
 * 重画"当前图片"那一块画布（= 预览 = 将来的编辑画布）。
 *
 * 2026-10-05 用户改版后：上区只有**一格**图，原图面板与独立的编辑器面板都删掉了，
 * 所以这里只画一块；取景视图（源图 + 取景框）由 `cropView.ts` 自己画。
 * 口径仍是**索引 0**（游戏所见）：`prepared.rgba` 本身就是游戏口径，原样画。
 */
export function renderImageViews(): void {
  const v = ensureViews();
  const p = state.prepared;
  const requested = state.params.previewZoom;

  const cv = v.preview;
  const fit = fitDisplaySize(cv, 128 * requested);
  cv.width = 128;
  cv.height = 128;
  cv.style.width = `${fit.size}px`;
  cv.style.height = `${fit.size}px`;
  const ctx = cv.getContext('2d') as CanvasRenderingContext2D;
  ctx.clearRect(0, 0, 128, 128);
  if (p) {
    const tmp = bufferToCanvas(p.rgba, p.width, p.height);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(tmp, 0, 0, 128, 128);
  }
  updateZoomNote('preview-zoom-note', requested, fit.size, fit.shrunk, !!p);
}

/**
 * 参数变了之后的重画总入口（各面板都调它）。
 *
 * ⚠ 它 = "把图片那两块重画一遍"（预览画布 + 顶部那条"文件名 · 尺寸"）。
 *   取景拖动时**绝不能**调它 —— 只重画预览画布请用 `renderImageViews()`
 *   （`cropView` 离开视图时走的就是这条）。
 *
 * ★ 0.17：以前这里还要 `renderStats()`（重建"实时统计"那 9 行，且会把**整张源图扫一遍**算
 *   `imageStats()` —— 0.8 M 像素实测 ~99 ms）。那块面板已删，所以这条路径现在只剩两次轻量 DOM 写。
 */
export function refreshImage(): void {
  refreshCallCount += 1; // ★ 性能哨兵：面板刷新次数
  renderImageViews();
  renderOriginalBadge();
}

function renderOriginalBadge(): void {
  const host = $('original-badge');
  clear(host);
  const src = state.source;
  if (!src) {
    host.appendChild(el('span', { class: 'dim', text: '支持拖入 / 点击选择 / Ctrl+V 粘贴（PNG / JPEG / WebP / GIF / BMP / ICO / AVIF / SVG）' }));
    return;
  }
  // ★ 2026-10-05（0.9）：用户要求删掉后面的"实色 N · 半透明 N"（"没用"）。
  //   这里只留"文件名 · 尺寸"。（0.17 起连"实时统计"那块也删了 ⇒ 原图色数/半透明像素数
  //   在界面上不再显示；要看就 F12：`EmblemToolCore.ui.state.prepared.report`。）
  host.appendChild(el('span', { text: `${src.name} · ${src.width}×${src.height}` }));
}

// --------------------------------------------------------------------------
// 手动取景：初值计算
// --------------------------------------------------------------------------
//
// ★ 2026-10-05：**拖拽/滚轮那套交互搬到了 `cropView.ts`**（用户要"取景按需"：
//   点工具条上的〔取景…〕才在**同一格**里切成取景视图）。
//   这里只剩下一件不依赖视图的事：`fillManualToTarget()` —— 导入图片时按"**填满** 128×128 框"算初值。
//
// ★ 2026-10-05（0.9）：用户删掉了〔↺ 恢复到适应〕/〔↺ 复位 / 适应〕两个按钮
//   （他的原话："我认为这个按钮没用，删了吧"）—— 于是 `resetManual()` 也一起删了。
//   默认取景本身已经改成"填满白框"，所以那个按钮确实只剩"把图缩回整张"这一个作用，
//   而用户要的恰恰是相反的（填满）。想回到默认取景：重新导入图片。
//
// ★ 2026-10-05（0.15）：参数行那三格（收边 / 减色上限 / 取景数值）按用户要求整块删除 ⇒
//   `syncManualReadout()`（把数值写回三个输入框）没有输入框可写了，一起删掉。
//   ⚠ `state.params.manualScale / manualOffsetX / manualOffsetY` 仍然在、仍然是真值来源 ——
//     它们由**取景视图**（拖拽/滚轮 → `commitWindow()`）写入，不是由输入框写入。

/**
 * 把"手动取景"设成**刚好填满目标框**（导入新图时调）。
 *
 * 与 `image.ts::fitToTarget(..., { mode: 'cover' })` 同口径（`max(目标/宽, 目标/高)`），
 * 但走的是 manual 参数，这样用户接着就能进取景视图拖/滚轮微调，而不会被"确定"那一步打断。
 *
 * ★ 用户 2026-10-05 的原话：「每次打开图片，图片默认就顶住这个方框部分，图片的一边顶住就行，
 *   顶住就停，不缩放」。所以这里是**短边贴框**（白框里没有透明边）。
 */
export function fillManualToTarget(): void {
  const src = state.source;
  if (!src) return;
  const target = state.params.targetSize;
  const s = fillScaleFor(src.width, src.height, target);
  const off = fillOffsetFor(src.width, src.height, target);
  // ★ 0.13：界面只有手动这一档，这里再钉一次 —— 换图 = 回到手动，
  //   免得某个残留的自动档（'contain'/'cover'/'stretch'）把刚算好的取景整个无视掉。
  state.params.fitMode = 'manual';
  state.params.manualFitScale = s;
  state.params.manualZoom = 1;
  state.params.manualScale = s;
  state.params.manualOffsetX = off.x;
  state.params.manualOffsetY = off.y;
}

// （0.15：`syncManualReadout()` 已删 —— 参数行那三个输入框没了，没有东西要同步。
//   当前取景的读数由 `cropView.ts::describeWindow()` 写进取景动作行的 `#crop-readout`。）
