/**
 * 入口 —— 把核心层（格式/图像/记忆卡）、纯逻辑（作品表/槽位/参数/自检决策/PCSX2 自检）
 * 和三个视图接起来。
 *
 * 界面布局严格按 `SPEC.md` §四：
 *   顶栏：记忆卡 [选择/拖入] · 作品 [下拉] · ⚠ 自检条（可折叠）
 *   上  ：原图 | 游戏预览（索引 0 口径，1:1 与 4×）| 编辑器挂载点 + 右侧参数面板
 *   下  ：8 个槽位（2×4）+ 按钮
 *
 * ★ 三条最容易忘的规矩，在这里各有一处显式实现：
 *   1. `showOpenFilePicker({ mode: 'readwrite' })` 优先，失败/不支持退化到 `<input type=file>`；
 *      **AbortError = 用户取消，不报错**。
 *   2. 落盘前必有确认框，文案里含"请先完全退出 PCSX2"（`logic/writeGuard.ts`）。
 *   3. 非 LR 的 9 字节作品常量必须从真实存档取/查登记表，没有就**拒绝写入**。
 */

import type { ScaleKernelChoice } from '../core/image.ts';

import { DEFAULT_PARAMS, KERNEL_LABELS, PARAM_LIMITS } from './logic/defaults.ts';
import { GAMES, DEFAULT_GAME_ID, findGame, resolveGame, type GameContext } from './logic/games.ts';
import { MCD_SLOT_OF, analyzePcsx2, type IniFileLike } from './logic/pcsx2.ts';
import {
  DEFAULT_PCSX2_DIR,
  PCSX2_MAX_TEXT_BYTES,
  classifyPcsx2Input,
  describeFoundFiles,
  isPcsx2TextFile,
} from './logic/pcsx2Paths.ts';

import {
  deleteSlotAndSave,
  direntDebug,
  exportPng,
  openCardFromBytes,
  planWriteTarget,
  reloadModel,
  reloadThumbs,
  sameGameBlocks,
  saveCardAs,
  scanCard,
  writeSlot,
} from './cardOps.ts';
import { cardCore, emblemCore } from './cardOps.ts';
import { noDirForGameText, slotSummaryText } from './logic/slots.ts';
import { APP_VERSION, APP_VERSION_LABEL, UI_BUILD_TAG } from './logic/version.ts';
import { decodeImageFile, fillManualToTarget, pipelineStats, recheckFinal, recompute, refreshImage, renderImageViews } from './pipeline.ts';
import { applyDrag, applyZoom, cancelCrop, closeCropView, confirmCrop, cropInfo, flushCropLayout, initCropView, isCropActive, layoutCropView, openCropView, setCropView, toggleCropView } from './cropView.ts';
import { fillGameSelect, renderGameNote, renderLog, renderSlots, renderStatus } from './slotsView.ts';
import { setStatus, state, type SourceImage } from './state.ts';
import { $, clear, el, guard, installGlobalErrorHandlers, showModal, toast } from './dom.ts';
import { humanBytes } from './logic/format.ts';

// --------------------------------------------------------------------------
// 小工具
// --------------------------------------------------------------------------

/** `AbortError` = 用户按了取消 —— **不是错误**（SPEC.md §三 的 try/catch 要求）。 */
function isAbort(e: unknown): boolean {
  return !!e && typeof e === 'object' && (e as { name?: string }).name === 'AbortError';
}

function setBusy(on: boolean, note?: string): void {
  state.busy = on;
  if (note) setStatus(note);
  renderStatus();
  // ★ 0.19（D8）：`btn-image-open` / `btn-crop` 也必须在名单里 —— 写入是**异步**的
  //   （`createWritable()`/`write()`/`close()`/`getFile()` 每一步都在 await），
  //   期间换一张图会让预览显示新图、而日志/提示报告"旧图写成功"。
  //   ★ 0.21：名单里的 `btn-write-all` 随〔批量写 8 槽〕一起删掉。
  for (const id of ['btn-write', 'btn-delete', 'btn-card-open', 'btn-save-as', 'btn-image-open', 'btn-crop']) {
    const b = document.getElementById(id) as HTMLButtonElement | null;
    if (b) b.disabled = on;
  }
}

const IMG_EXT_RE = /\.(png|jpe?g|webp|gif|bmp|ico|avif|svg)$/i;

// --------------------------------------------------------------------------
// 打开记忆卡
// --------------------------------------------------------------------------

/**
 * 界面刷新总入口（0.19 收口，B2）。
 *
 * 原先"重建模型 + 读缩略图 + 重画槽位 + 卡片信息 + 写卡提示"这一串在 5 处各抄了一遍，
 * 而且**已经开始漂**：切作品的失败分支漏了 `reloadThumbs()`/`renderCardInfo()`
 * ⇒ 模型是"不过滤"的、缩略图却还是上一次过滤的（槽名与缩略图可能来自不同目录，D3）。
 * 现在只有这一处，漏一步在结构上不可能发生。
 *
 * @param ctx 当前作品上下文（null = 不过滤，把整卡目录都当本作品）
 */
function refreshCardViews(ctx: GameContext | null): void {
  if (!state.card) {
    state.model = null;
    renderSlots(null, ctx, { onSelect: selectSlot });
    renderCardInfo();
    updateWriteHints();
    return;
  }
  reloadModel(ctx);
  reloadThumbs();
  renderSlots(state.model, ctx, { onSelect: selectSlot });
  renderCardInfo();
  updateWriteHints();
}

async function openCardViaPicker(): Promise<void> {
  const w = window as unknown as {
    showOpenFilePicker?: (o: unknown) => Promise<FileSystemFileHandle[]>;
  };
  if (typeof w.showOpenFilePicker !== 'function') {
    toast('info', '这个浏览器没有 showOpenFilePicker', '改用文件选择框（**只读**：保存时会改成"下载一份改好的卡"）。');
    ($('card-input') as HTMLInputElement).click();
    return;
  }
  await guard('选择记忆卡', async () => {
    let handles: FileSystemFileHandle[];
    try {
      handles = await w.showOpenFilePicker!({
        id: 'emblemCard',
        multiple: false,
        mode: 'readwrite',
        types: [
          {
            description: 'PS2 记忆卡 / 存档',
            accept: { 'application/octet-stream': ['.ps2', '.mcr', '.mc2', '.bin', '.psv'] },
          },
        ],
      });
    } catch (e) {
      if (isAbort(e)) {
        setStatus('已取消选择记忆卡。');
        return;
      }
      // 权限/类型过滤等失败 ⇒ 退化到只读路径，而不是让用户看到"没反应"
      toast('warn', '打不开文件选择器，退化到只读方式', e instanceof Error ? `${e.name}: ${e.message}` : String(e));
      ($('card-input') as HTMLInputElement).click();
      return;
    }
    const handle = handles[0];
    const file = await handle.getFile();
    const bytes = new Uint8Array(await file.arrayBuffer());
    // ★ 0.25：把选卡那一刻的文件状态一起记下来 —— 落盘前会拿它比对，
    //   变了就说明"这张卡在工具读过之后又被别的进程改过"（最常见是 PCSX2），
    //   那时 Chrome 的 createWritable() 会抛 InvalidStateError；我们改成**先拒绝**并说清怎么做。
    const r = await openCardFromBytes(file.name || handle.name, bytes, handle, {
      mtime: file.lastModified,
      size: file.size,
    });
    if (r.ok) afterCardLoaded();
    else refreshCardViews(null); // ★ 0.19（D2）：失败了也要把界面从"上一张卡"改回来
  });
}

async function openCardViaInput(file: File): Promise<void> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const r = await openCardFromBytes(file.name, bytes, null);
  if (r.ok) {
    toast('info', '这是只读方式打开的', '保存时会改成"下载一份改好的卡"（这个环境没给写句柄）。');
    afterCardLoaded();
  } else {
    // ★ 0.19（D2）：**开卡失败也要刷新界面**。`openCardFromBytes` 已经把 `state.card` 置空，
    //   而三个调用方原先只在成功时刷新 ⇒ 顶栏、8 个槽、写卡提示还停在**上一张卡**的样子，
    //   可点任何按钮都回你"还没有打开记忆卡"。
    refreshCardViews(null);
  }
}

export function afterCardLoaded(): void {
  const ctx = currentGameContext();
  // ★ 打开卡时就按**当前下拉框的作品**过滤（默认 LR 日版），不再用"整卡并集"
  refreshCardViews(ctx.ok ? ctx.ctx : null);
  if (state.model && state.model.dirNames.length === 0) {
    // 别让用户以为"卡打不开"——明确说清"卡没问题，是这个作品在卡上还没有目录"
    setStatus(noDirForGameText(state.model.serial, state.model.excludedDirNames.length));
    toast('info', '这张卡上没有当前作品的徽章目录', noDirForGameText(state.model.serial, state.model.excludedDirNames.length), 20_000);
  } else {
    setStatus(`${state.card?.fileName ?? ''}：${slotSummaryText(state.model)}`);
  }
}

/** 卡上**所有**徽章目录（不过滤）——只给顶栏的"卡一览"用，不进 8 槽。 */
function describeCardDirs(): string {
  const scan = scanCard();
  if (!scan) return '（未打开卡）';
  if (!scan.dirs.length) return '这张卡上没有任何徽章目录（E## / EMB）';
  return scan.dirs.map((d) => `${d.name}(${d.count} 项${d.isLrArchive ? ' · LR' : ''})`).join('  ');
}

function renderCardInfo(): void {
  const host = $('card-info');
  clear(host);
  const lc = state.card;
  if (!lc) {
    host.appendChild(el('span', { class: 'dim', text: '未选择记忆卡' }));
    return;
  }
  host.appendChild(
    el('span', {
      class: lc.handle ? 'ok' : 'warn',
      text: lc.handle ? `🔓 ${lc.fileName}（可覆盖保存）` : `🔒 ${lc.fileName}（只读 · 保存=下载）`,
    }),
  );
  host.appendChild(el('span', { class: 'dim', text: `　${humanBytes(lc.sourceBytes.length)}` }));
  host.appendChild(
    el('span', {
      class: 'dim',
      title: '这张卡上所有的徽章目录（不过滤作品）',
      text: `　卡上一共有：${describeCardDirs()}`,
    }),
  );
}

// --------------------------------------------------------------------------
// 作品
// --------------------------------------------------------------------------

interface GameCtxResult {
  ok: boolean;
  ctx: GameContext | null;
  error?: string;
}

function currentGameContext(): GameCtxResult {
  const sel = document.getElementById('game-select') as HTMLSelectElement | null;
  const id = sel ? sel.value : DEFAULT_GAME_ID;
  const custom = (document.getElementById('custom-serial') as HTMLInputElement | null)?.value ?? '';
  const r = resolveGame(id, custom);
  if ('error' in r) return { ok: false, ctx: null, error: r.error };
  return { ok: true, ctx: r };
}

function onGameChanged(): void {
  const r = currentGameContext();
  const entry = findGame((document.getElementById('game-select') as HTMLSelectElement | null)?.value ?? '');
  renderGameNote(entry ?? null);
  const err = $('game-error');
  clear(err);
  if (!r.ok) {
    err.appendChild(el('span', { class: 'bad', text: r.error ?? '作品无法解析' }));
    // 作品没法解析（例如自定义序列号还没填对）⇒ 退回"不过滤"，而不是把卡显示成空的。
    // ★ 0.19（D3）：这里也必须走 `refreshCardViews()` —— 原先手抄的版本漏了缩略图与卡片信息，
    //   于是"模型不过滤、缩略图还是上一次过滤的" ⇒ 槽名与缩略图可能来自不同目录。
    refreshCardViews(null);
    return;
  }

  // ★ 切作品 = 换一套槽：重建模型（按新作品过滤）+ 重读缩略图 + 重画 + 刷新提示。
  //   `state.selectedSlot` **保留**：槽号不变，该槽在新作品里可能是空槽，那是正常状态。
  refreshCardViews(r.ctx);
  if (state.card) {
    if (state.model && state.model.dirNames.length === 0) {
      setStatus(noDirForGameText(state.model.serial, state.model.excludedDirNames.length));
    } else {
      setStatus(`已切到「${entry?.label ?? ''}」：${slotSummaryText(state.model)}`);
    }
  }
}

/** 把"这一槽写下去会怎样"提前算给用户看（尤其是不合规/缺目录时）。 */
function updateWriteHints(): void {
  const host = $('write-hint');
  clear(host);
  const r = currentGameContext();
  if (!r.ok || !state.model) {
    host.appendChild(el('span', { class: 'dim', text: state.card ? '（先选作品）' : '（先打开记忆卡）' }));
    return;
  }
  const ctx = r.ctx;
  const isLr = ctx.entry.form === 'lr-archive';
  // ★ 0.21：单槽（〔批量写 8 槽〕已删）⇒ 一个目标、一条提醒、一条拒绝理由。
  const plan = planWriteTarget(ctx, state.selectedSlot);
  if (plan.error) {
    host.appendChild(el('div', { class: 'bad', text: plan.error }));
  } else if (plan.target) {
    const t = plan.target;
    host.appendChild(
      el('div', { text: `槽 ${t.slotIndex + 1} → ${t.dirName}\\${t.fileName}${t.isNew ? '（新建文件）' : '（覆盖）'}` }),
    );
  }
  if (plan.warning) host.appendChild(el('div', { class: 'warn', text: '⚠ ' + plan.warning }));
  if (state.model.dirNames.length === 0) {
    host.appendChild(el('div', { class: 'warn', text: '⚠ ' + noDirForGameText(state.model.serial, state.model.excludedDirNames.length) }));
  }
  if (!isLr) {
    const same = sameGameBlocks(ctx);
    host.appendChild(
      el('div', {
        class: same.length ? 'dim' : 'warn',
        text: same.length
          ? `作品常量可从卡上同作品的真实存档里取（找到 ${same.length} 个：${same.map((s) => `${s.dir}\\${s.file}`).join('、')}）`
          : '⚠ 卡上没有同作品的真实存档，作品常量只能查核心层登记表（只有 SL / NX 有）；都没有时会拒绝写入。',
      }),
    );
  }
}

// --------------------------------------------------------------------------
// 槽位选择
// --------------------------------------------------------------------------

function selectSlot(i: number): void {
  state.selectedSlot = i;
  const r = currentGameContext();
  renderSlots(state.model, r.ok ? r.ctx : null, { onSelect: selectSlot });
  updateWriteHints();
  const s = state.model?.slots[i];
  setStatus(
    s?.occupied
      ? `已选槽 ${i + 1}：${s.dirName}\\${s.fileName}（${s.length} 字节，首簇 ${s.cluster}）`
      : `已选槽 ${i + 1}：空（写入时会新建文件）`,
  );
  renderStatus();
}

// --------------------------------------------------------------------------
// （0.22：原「工具侧栏」整块删除）
// --------------------------------------------------------------------------
//
// ★ 2026-10-06（0.22）用户定：**不做内置像素编辑器**。
//   他的原话："我突然觉得我们是不是没有必要做工具这一栏，毕竟其他优秀的图像处理工具有很多"。
//   判断依据（写在这里，免得以后又想起来做）：
//     · 这个工具真正难、真正值钱的是**格式与写卡**（18 段校验 / 末段校验的真实位置 / ECC /
//       FAT 簇链 / 目录项 / icon.sys / LR 与非 LR 两套布局）—— 那部分已经做完了；
//     · "能画图"不是它的核心价值，而内置编辑器会**明显不如** Aseprite / Piskel / Photoshop /
//       画图（笔压、图层组、滤镜、成熟撤销），却要吃掉"判据最难写、最容易埋 bug"的一整块；
//     · **闭环已经存在**：〔导出 PNG〕导出的就是游戏口径（索引 0 = 透明），
//       外部改完拖回来即可，而且**无损**（128×128 → 取景倍率 1 → 核心走恒等短路；
//       ≤255 色 ⇒ `quantizeOpaque()` 返回 exact；`image.test.ts` 分节 (b)/(b2) 钉住）。
//   ⇒ 右栏空出来给了**参数**（原来参数在 `</main>` 之后独立一整行）。
//   ⚠ 这里原来有 `fillPalettePlaceholder()`（32 个装饰色块 + 1 个"洞"色块）与整块
//     `.pane-tools` / `.tool-chip` / `#palette-grid` 的占位结构，已随编辑器一起删除；
//     `ui.test.ts` 有闸门钉住"它们不许长回来"。

// --------------------------------------------------------------------------
// 图片导入
// --------------------------------------------------------------------------

/**
 * ★ 导入一张**已解码**的图之后要做的事（= `loadImageFromBlob` 的后半段）。
 *
 * 抽成独立函数有两个理由：
 *   1. **0.16 用户要求**："加载图片后默认启动取景模式" —— 导入图片的目的就是"圈出要用的那块"，
 *      所以这里最后一步直接 `openCropView()`，省掉"导入完还要再点一次〔取景…〕"；
 *   2. 能在桩 DOM 冒烟 / 无头截图探针里**走真路**（`window.EmblemToolCore.ui.imageImport.applyImportedImage`），
 *      而不是在测试里手抄一遍"导入应该做什么"。
 */
function applyImportedImage(img: SourceImage, name: string): void {
  // 换图时先离开取景视图（取景框是按**旧图标尺**算的，留着会错位）
  closeCropView();
  state.source = img;
  // ★ 导入新图 ⇒ 手动取景按"**填满** 128×128 框"重新算初始值（不是 1:1）。
  //   用户 2026-10-05 的原话：「每次打开图片，图片默认就顶住这个方框部分，图片的一边顶住就行，
  //   顶住就停，不缩放」⇒ 短边贴框、白框里没有透明边。
  //   也不能沿用上一张图的平移/缩放（那看起来像"图不见了"）。
  //   SPEC §五 ② 的"默认进手动"没变，变的只是初始值。
  fillManualToTarget();
  const r = recompute();
  refreshImage();
  toast(
    r.ok ? 'ok' : 'warn',
    r.ok ? `已导入 ${name}` : `已导入 ${name}，但还不合规`,
    r.ok
      ? `${img.width}×${img.height} → ${state.params.targetSize}×${state.params.targetSize}，实色 ${state.prepared?.report.colorsAfter ?? '?'}；` +
        `已按「填满白框」给好初始取景（倍率 ${state.params.manualFitScale.toFixed(3)}）。` +
        '★ 已进入取景模式：拖动图片 / 滚轮缩放，白框下面那行是实时读数，满意就按〔确定取景〕。'
      : r.error ?? '',
  );
  // ★ 0.16：直接进取景模式（这一步会顺手把状态行写成取景读数，所以上面不再另写"图片就绪…"）
  openCropView();
  if (!r.ok) {
    // 不合规时把原因也写进状态行 —— 取景读数会盖掉它，所以放在 openCropView() 之后**再刷一次**
    setStatus(`图片不合规，拒绝写入：${r.error}`);
    renderStatus();
  }
}

async function loadImageFromBlob(blob: Blob, name: string): Promise<void> {
  await guard('导入图片', async () => {
    applyImportedImage(await decodeImageFile(blob, name), name);
  });
}

async function pickImageFile(): Promise<void> {
  const inp = $('image-input') as HTMLInputElement;
  inp.value = '';
  inp.click();
  // 真机上 change 事件会带着 files 回来；这里不 await 事件（用 addEventListener 处理）
}

// --------------------------------------------------------------------------
// 参数面板
// --------------------------------------------------------------------------

function bindParams(): void {
  // ★ 2026-10-05（0.13）：原来这里绑的是「取景」四档下拉（`#fit-mode`），**已删** ——
  //   界面现在**永远**是 'manual'（`DEFAULT_PARAMS.fitMode`），理由写在 index.html 那段注释里：
  //   那三档自动模式会无视手动取景、自己重算一套，等于"偷偷丢掉你调好的取景"。
  //   核心 `image.ts` 的四个模式没动，`UiParams.fitMode` 字段也留着（`prepareEmblem()` 需要它）。
  const kSel = $('kernel') as HTMLSelectElement;
  clear(kSel);
  for (const o of KERNEL_LABELS) kSel.appendChild(el('option', { value: o.value, selected: o.value === DEFAULT_PARAMS.kernel }, o.label));

  kSel.value = state.params.kernel;

  kSel.addEventListener('change', () => {
    state.params.kernel = kSel.value as ScaleKernelChoice;
    commitParams();
  });

  const th = $('alpha-threshold') as HTMLInputElement;
  const thNum = $('alpha-threshold-num') as HTMLInputElement;
  th.min = String(PARAM_LIMITS.alphaThreshold.min);
  th.max = String(PARAM_LIMITS.alphaThreshold.max);
  th.value = String(state.params.alphaThreshold);
  thNum.min = th.min;
  thNum.max = th.max;
  thNum.value = th.value;
  const applyThreshold = (v: number): void => {
    const clamped = Math.min(PARAM_LIMITS.alphaThreshold.max, Math.max(PARAM_LIMITS.alphaThreshold.min, Math.round(v || 128)));
    state.params.alphaThreshold = clamped;
    th.value = String(clamped);
    thNum.value = String(clamped);
    commitParams();
  };
  th.addEventListener('input', () => applyThreshold(Number(th.value)));
  thNum.addEventListener('change', () => applyThreshold(Number(thNum.value)));

  // ★ 2026-10-05（0.15）：原来这里还绑着「收边（去杂点）」「减色上限」「取景数值（倍率/X/Y）」三格，
  //   **按用户要求整块删除**（"我感觉这三个选项都没什么用啊" → 讨论后选"三样全删"）。
  //   ⚠ 删 UI 不等于删能力：`state.params.despeckle / maxColors / manualScale...` 都还在，
  //     默认值也还是"收边关 / 减色 255"（`DEFAULT_PARAMS`），核心 `image.ts` 一个字没动 ⇒ 行为不变。
  //     要看当前取景的几个数：点左上的〔取景…〕，白框下面那行实时读数一直在写。

  const zoom = $('preview-zoom') as HTMLSelectElement;
  clear(zoom);
  for (const z of [1, 2, 4, 8]) {
    zoom.appendChild(el('option', { value: String(z), selected: z === state.params.previewZoom }, z === 1 ? '1:1' : `${z}×`));
  }
  zoom.value = String(state.params.previewZoom);
  zoom.addEventListener('change', () => {
    state.params.previewZoom = Number(zoom.value) || 4;
    // ★ 只影响"当前图片"那一块画布 ⇒ 用轻量的 renderImageViews()，别顺带重建统计面板
    //   （`refreshImage()` 里的 `renderOriginalBadge()` 会把整张源图扫一遍，0.8 M 像素实测 ~99 ms）
    renderImageViews();
  });
}

/**
 * 参数变了：重算 + 重画。
 *
 * ★ 0.17：原来这里还要把"✅ 合规：… / ❌ 原因"写进参数行的 `#compliance-inline`
 *   （用户要求把"实时统计"整块删掉，那行也在其中）。现在**不在界面上常驻合规结论**：
 *   不合规时**写卡那一步会拒绝**并说明原因（`writeGuard` / 右下日志红字），
 *   写完之后日志里也有一行"图像合规（128×128 / 实色 ≤255 / 半透明 0）"。
 *   想看详细 report：F12 → `EmblemToolCore.ui.state.prepared.report`。
 */
function commitParams(): void {
  recompute();
  refreshImage();
}

// --------------------------------------------------------------------------
// 写入
// --------------------------------------------------------------------------

async function doWrite(slotIndex: number, what: string): Promise<void> {
  if (state.busy) return;
  // ★ 0.26（用户要求）：**取景模式里不许写入** —— 取景没〔确定〕之前，参数行还是上一次确定的值，
  //   这时候写下去的是"上一次的取景"，跟你在白框里看到的不一样。弹窗说清，然后中止。
  if (isCropActive()) {
    showModal({
      title: '先在取景视图里点〔确定取景〕',
      body:
        '你现在还在取景模式：白框里的取景还没有生效，这时候写入用的是上一次确定的取景，' +
        '和你在屏幕上看到的不一样。\n\n' +
        '请点左边那行里的〔确定取景〕（想放弃这次调整就点〔取消〕），然后再点〔写入选中槽〕。',
      ok: '知道了',
    });
    return;
  }
  const r = currentGameContext();
  if (!r.ok || !r.ctx) {
    toast('error', '作品没选对', r.error ?? '请在下拉框里选一个作品');
    return;
  }
  if (!state.prepared) {
    toast('error', '还没有可写入的图像', state.prepareError ?? '先导入一张图（拖入 / 点击选择 / Ctrl+V 粘贴）。');
    return;
  }
  setBusy(true, `${what}中：生成徽章块 → 在内存副本上写 → 回读自检 …`);
  try {
    const isLr = r.ctx.entry.form === 'lr-archive';
    const outcome = await writeSlot(r.ctx, slotIndex, { isLr, finalCheck: recheckFinal });
    renderLog(outcome.lines);
    if (outcome.ok) {
      // ★ 写入后按**当前作品**重建模型（新写的槽要出现在这 8 格里）
      refreshCardViews(r.ctx);
      setStatus(`${outcome.persisted ?? '写入完成'}　｜　${slotSummaryText(state.model)}`);
      toast('ok', `${what}成功`, outcome.persisted ?? '');
    } else {
      setStatus(`${what}被拒绝（见右侧日志）`);
    }
  } finally {
    setBusy(false);
    renderStatus();
  }
}

// --------------------------------------------------------------------------
// PCSX2 自检（面板常驻在**页面最下面**，默认展开、无折叠按钮）
// --------------------------------------------------------------------------
//
// ★ 关于"默认能找到 C:\Users\M\Documents\PCSX2"（很重要，写在代码里免得以后再纠结）：
//   `file://` 页面**不能凭路径读本地文件** —— 这是浏览器的规定，不是我们的选择。
//   所以"默认找到"只能做成 **一次点击到位 + 记住上次的位置**：
//     · 主路径：`showDirectoryPicker({ id: 'pcsx2', startIn: 'documents' })`
//       —— `id` 让 Chrome 记住上次选的目录；`startIn:'documents'` 让第一次直接开在"文档"。
//     · 句柄再存进 IndexedDB；下次打开若权限还在（`queryPermission === 'granted'`）就**自动读一遍**。
//     · 兜底：`<input type="file" webkitdirectory multiple>`（不依赖 File System Access API）。
//     · 再兜底：把文件/文件夹拖进来。
//   三条路都会在界面上写明**这次走的是哪条**（用来判断 file:// 下到底能不能用 showDirectoryPicker）。

const PCSX2_DB_NAME = 'emblem-tool';
const PCSX2_DB_STORE = 'handles';
const PCSX2_HANDLE_KEY = 'pcsx2-dir';

/** 这一次自检的文件是从哪来的（显示给用户，也用来判断 API 可用性）。 */
type Pcsx2Route = '未提供' | '目录选择框' | '目录输入框' | '拖入文件' | '自动（记住的目录）';

let pcsx2Files: IniFileLike[] = [];
let pcsx2Route: Pcsx2Route = '未提供';

/**
 * ★ 0.23：PCSX2 自检面板**默认折叠**（用户："自检改成默认折叠起来"）。
 *
 * 折叠的是"三条入口 + 结论 + 说明"整块（`#pcsx2-panel`），**头一行常驻**（标题 + 说明 + 〔展开/收起〕）。
 * 但**读进文件之后会自动展开一次** `setPcsx2Open(true)` —— 否则用户点了〔选择 PCSX2 目录〕
 * 却看不到结论，会以为没反应。清空（`btn-pcsx2-clear`）时收回默认的折叠态。
 *
 * ⚠ 折叠靠 `hidden` 属性（`styles.css` 有 `[hidden] { display: none !important }`），
 *   不写 inline `style.display` —— 那样会被 `.row { display: flex }` 盖掉（0.9 踩过的坑）。
 *   `aria-expanded` 跟着一起改，给读屏软件用（`ui.test.ts` 分节 k2 钉住"默认折叠 + 可展开"）。
 */
let pcsx2Open = false;

function setPcsx2Open(open: boolean): void {
  pcsx2Open = open;
  const panel = document.getElementById('pcsx2-panel');
  if (panel) panel.hidden = !open;
  const btn = document.getElementById('btn-pcsx2-toggle') as HTMLButtonElement | null;
  if (btn) {
    btn.textContent = open ? '收起' : '展开';
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  }
}

/** 把一批文本文件塞进自检并立刻重画（**读进来就立刻出结论**，不需要用户再点一次）。 */
async function setPcsx2Files(files: Iterable<File>, route: Pcsx2Route): Promise<number> {
  const list = Array.from(files);
  const cls = classifyPcsx2Input(list);
  const out: IniFileLike[] = [];
  for (const f of cls.read) {
    try {
      // 名字用 webkitRelativePath（有就带上，界面上一眼能看出是哪个目录的）
      out.push({ name: f.webkitRelativePath || f.name, text: await f.text() });
    } catch (e) {
      toast('warn', `读不了 ${f.name}`, e instanceof Error ? e.message : String(e));
    }
  }
  // ★ 0.19（D12）：无论读到几个都更新 —— "本次来源"与结论面板必须说同一件事
  //   （原先 0 个文件时不赋值 ⇒ 面板留着上一次的结论表，来源行也是旧的）。
  pcsx2Files = out;
  pcsx2Route = route;
  // ★ 0.23：有文件进来了就展开（默认是折叠的）—— 否则用户点了目录却看不到结论。
  if (out.length > 0) setPcsx2Open(true);
  renderPcsx2();
  if (out.length === 0) {
    toast(
      'warn',
      '这个目录里没有找到 PCSX2 的自检文件',
      describeFoundFiles(list.map((f) => f.webkitRelativePath || f.name)),
    );
    return 0;
  }
  toast(
    'ok',
    `读到 ${out.length} 个文件（${route}）`,
    describeFoundFiles(out.map((f) => f.name)) +
      (cls.skippedTooBig.length ? `；跳过 ${cls.skippedTooBig.length} 个超过 4 MiB 的文件（memcards 那些用不到）` : ''),
  );
  return out.length;
}

// ── 主路径：showDirectoryPicker ────────────────────────────────────────────

interface Pcsx2PickerWindow {
  showDirectoryPicker?: (o: {
    id?: string;
    mode?: 'read' | 'readwrite';
    startIn?: string;
  }) => Promise<FileSystemDirectoryHandle>;
}

const pickerWindow = (): Pcsx2PickerWindow => window as unknown as Pcsx2PickerWindow;

/** 递归读一个目录句柄下的**文本文件**（有上限，别把 8 MB 的记忆卡也读进内存）。 */
async function readTextFilesFromHandle(
  dir: FileSystemDirectoryHandle,
  prefix = '',
  out: Array<{ name: string; file: File }> = [],
  depth = 0,
): Promise<Array<{ name: string; file: File }>> {
  if (depth > 4) return out;
  for await (const [name, handle] of dir as unknown as AsyncIterable<[string, FileSystemHandle]>) {
    const rel = prefix ? `${prefix}/${name}` : name;
    if (handle.kind === 'directory') {
      // 只往我们关心的目录里钻（inis / gamesettings / logs），别把 memcards 也走一遍
      if (depth === 0 && !['inis', 'gamesettings', 'logs'].includes(name.toLowerCase())) continue;
      await readTextFilesFromHandle(handle as FileSystemDirectoryHandle, rel, out, depth + 1);
      continue;
    }
    if (!isPcsx2TextFile(rel)) continue;
    const file = await (handle as FileSystemFileHandle).getFile();
    if (file.size > PCSX2_MAX_TEXT_BYTES) continue;
    out.push({ name: rel, file });
  }
  return out;
}

/** 用句柄读一次并出结论；返回读到几个文件。 */
async function readFromDirectoryHandle(dir: FileSystemDirectoryHandle, route: Pcsx2Route): Promise<number> {
  const found = await readTextFilesFromHandle(dir);
  const out: IniFileLike[] = [];
  for (const it of found) out.push({ name: it.name, text: await it.file.text() });
  if (out.length) {
    pcsx2Files = out;
    pcsx2Route = route;
  } else {
    pcsx2Files = []; // ★ 0.19（D12）：理由同 setPcsx2Files —— 状态与面板不许打架
    pcsx2Route = route;
  }
  renderPcsx2();
  return out.length;
}

/** 打开句柄库 —— `rememberPcsx2Handle` / `recallPcsx2Handle` 共用（0.19 去重，A29）。 */
async function openHandleDb(): Promise<IDBDatabase> {
  return await new Promise<IDBDatabase>((res, rej) => {
    const req = indexedDB.open(PCSX2_DB_NAME, 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains(PCSX2_DB_STORE)) d.createObjectStore(PCSX2_DB_STORE);
    };
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error ?? new Error('indexedDB.open 失败'));
  });
}

/** 把句柄存进 IndexedDB（失败就静默放弃 —— 这只是"锦上添花"）。 */
async function rememberPcsx2Handle(dir: FileSystemDirectoryHandle): Promise<void> {
  try {
    const db = await openHandleDb();
    await new Promise<void>((res, rej) => {
      const tx = db.transaction(PCSX2_DB_STORE, 'readwrite');
      tx.objectStore(PCSX2_DB_STORE).put(dir, PCSX2_HANDLE_KEY);
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error ?? new Error('写入 IndexedDB 失败'));
    });
    db.close();
  } catch {
    /* 静默放弃：记不住只是"下次要多点一下"，不影响功能 */
  }
}

/** 取回上次记住的句柄（取不到返回 null）。 */
async function recallPcsx2Handle(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const db = await openHandleDb();
    const handle = await new Promise<FileSystemDirectoryHandle | null>((res, rej) => {
      const tx = db.transaction(PCSX2_DB_STORE, 'readonly');
      const req = tx.objectStore(PCSX2_DB_STORE).get(PCSX2_HANDLE_KEY);
      req.onsuccess = () => res((req.result as FileSystemDirectoryHandle) ?? null);
      req.onerror = () => rej(req.error ?? new Error('读取 IndexedDB 失败'));
    });
    db.close();
    return handle;
  } catch {
    return null;
  }
}

/**
 * 启动时尝试"自动读一遍"：只在**上次授权还在**的情况下做（`queryPermission === 'granted'`）。
 * 权限没了就**静默不读**（绝不弹权限框打扰用户 —— 那必须由一次点击触发）。
 */
async function autoReadPcsx2IfRemembered(): Promise<void> {
  if (typeof pickerWindow().showDirectoryPicker !== 'function') return;
  const handle = await recallPcsx2Handle();
  if (!handle) return;
  let perm = 'prompt';
  try {
    perm = await handle.queryPermission({ mode: 'read' });
  } catch {
    return;
  }
  if (perm !== 'granted') return;
  try {
    const n = await readFromDirectoryHandle(handle, '自动（记住的目录）');
    if (n > 0) {
      toast('info', `已自动读取记住的 PCSX2 目录（${handle.name}，${n} 个文件）`, '结论见页面最下面那块；想换目录就点「选择 PCSX2 目录」。');
    }
  } catch {
    /* 句柄失效（目录被删/改名）⇒ 静默放弃，用户点一次就好 */
  }
}

/** 主路径：点一次目录选择框（`id` 让 Chrome 记住上次位置）。 */
async function pickPcsx2Dir(): Promise<void> {
  const w = pickerWindow();
  if (typeof w.showDirectoryPicker !== 'function') {
    toast('info', '这个浏览器没有「目录选择框」，已切到兜底方式', '请在弹出的目录输入框里选 C:\\Users\\M\\Documents\\PCSX2。');
    openPcsx2DirInput();
    return;
  }
  await guard('读取 PCSX2 目录', async () => {
    let dir: FileSystemDirectoryHandle;
    try {
      dir = await w.showDirectoryPicker!({ id: 'pcsx2', mode: 'read', startIn: 'documents' });
    } catch (e) {
      if (isAbort(e)) {
        setStatus('已取消选择 PCSX2 目录。');
        return;
      }
      // ★ SecurityError / NotAllowedError 等 ⇒ **自动**切兜底，不报错卡住
      toast(
        'warn',
        '「目录选择框」在这个环境里不可用，已自动切到兜底方式',
        `${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}\n请在弹出的目录输入框里选 C:\\Users\\M\\Documents\\PCSX2。`,
      );
      openPcsx2DirInput();
      return;
    }
    const n = await readFromDirectoryHandle(dir, '目录选择框');
    if (n === 0) {
      toast('warn', '这个目录里没找到 PCSX2 的自检文件', '期望含 inis\\PCSX2.ini、gamesettings\\*.ini、logs\\emulog.txt。');
      return;
    }
    await rememberPcsx2Handle(dir);
    toast('ok', `读了 ${n} 个文件（目录选择框）`, describeFoundFiles(pcsx2Files.map((f) => f.name)));
  });
}

/** 兜底路径：`<input webkitdirectory>`（不依赖 File System Access API）。 */
function openPcsx2DirInput(): void {
  const inp = document.getElementById('pcsx2-dir-input') as HTMLInputElement | null;
  if (!inp) return;
  inp.value = '';
  inp.click();
}

/** 收下"拖进来的东西"：可能是三个文件，也可能是一个目录（能拿到 entry 就递归走）。 */
async function handlePcsx2Drop(dt: DataTransfer): Promise<void> {
  // ① 优先用 FileSystemEntry 递归（拖目录时 dt.files 不含子文件——那是浏览器的行为）
  const entries: FileSystemEntry[] = [];
  for (const item of Array.from(dt.items ?? [])) {
    if (item.kind !== 'file') continue;
    const anyItem = item as unknown as { webkitGetAsEntry?: () => FileSystemEntry | null };
    const entry = anyItem.webkitGetAsEntry ? anyItem.webkitGetAsEntry() : null;
    if (entry) entries.push(entry);
  }
  if (entries.length) {
    const collected: File[] = [];
    for (const e of entries) await collectEntryFiles(e, collected);
    if (collected.length) {
      await setPcsx2Files(collected, '拖入文件');
      return;
    }
  }
  // ② 拿不到 entry（旧浏览器）⇒ 就用 dt.files（拖三个文件时是够的）
  const files = Array.from(dt.files ?? []);
  if (files.length) {
    await setPcsx2Files(files, '拖入文件');
    return;
  }
  toast('warn', '没收到任何文件', '请拖 inis\\PCSX2.ini、gamesettings\\*.ini、logs\\emulog.txt，或整个 PCSX2 目录。');
}

/** 递归把 entry 展开成文件（目录深度上限 4，只看我们关心的三个目录）。 */
async function collectEntryFiles(entry: FileSystemEntry, out: File[], depth = 0): Promise<void> {
  if (depth > 4) return;
  if (entry.isFile) {
    const file = await new Promise<File | null>((res) => {
      (entry as FileSystemFileEntry).file(
        (f) => res(f),
        () => res(null),
      );
    });
    if (file && isPcsx2TextFile(entry.fullPath || file.name) && file.size <= PCSX2_MAX_TEXT_BYTES) out.push(file);
    return;
  }
  if (!entry.isDirectory) return;
  // ★ 0.19（A4）：删掉了一段**永假**的死分支
  //   （`if (depth === 0 && …) { if (depth > 0) return; }` —— `depth` 在外层已经是 0）。
  //   ⚠ 它原来"看起来"是想着过滤目录名，其实什么都没做；而且**拖入**这条路本来就不按目录名过滤
  //     （`readTextFilesFromHandle()` 那条"目录选择框"的路才会只进 inis/gamesettings/logs）。
  //     两条路都靠 `isPcsx2TextFile()` 按"后缀 + 目录段"判，行为一致，别再加名字过滤。
  const reader = (entry as FileSystemDirectoryEntry).createReader();
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((res) => {
      reader.readEntries(
        (list) => res(list),
        () => res([]),
      );
    });
    if (!batch.length) break;
    for (const child of batch) await collectEntryFiles(child, out, depth + 1);
  }
}

/**
 * 自检面板的内容。
 *
 * ★ 文案要**自解释**（用户反馈"我有点没懂"）。空状态时不是只说"把文件拖进来"，
 *   而是先说清四件事：它解决什么问题 / 什么时候该看 / 怎么用 / 结论怎么读。
 */
function renderPcsx2(): void {
  const host = $('pcsx2-body');
  clear(host);

  // 默认目录提示（**只是提示文案**：浏览器不允许网页凭路径读文件）
  // ★ 0.18：后面那句"（浏览器不允许网页自己按路径读文件，所以需要你点一次授权；Chrome 会记住…）"
  //   按用户要求删掉 —— 按钮文案与 `#pcsx2-route`（本次来源）已经把这件事说清了。
  const dirHint = $('pcsx2-default-dir');
  clear(dirHint);
  dirHint.appendChild(
    el('span', null,
      el('b', { text: 'PCSX2 默认目录：' }),
      el('code', { text: DEFAULT_PCSX2_DIR })),
  );

  const route = $('pcsx2-route');
  clear(route);
  route.textContent = `本次来源：${pcsx2Route}`;

  const report = analyzePcsx2({ files: pcsx2Files });
  // ★ 2026-10-05（0.10）：顶栏那行"PCSX2 自检：<摘要>"已按用户要求删除 ⇒ 这里不再写摘要。
  //   结论仍然完整地出现在**本面板**里（下面的结论表 + 冲突红字）。

  if (report.recognized.length === 0) {
    host.appendChild(
      el('div', { class: 'pcsx2-help' },
        el('div', { class: 'pcsx2-help-title', text: '这块面板是干什么的？' }),
        el('div', {
          class: 'pcsx2-help-body',
          text:
            '你在 PCSX2「设置 → 记忆卡插槽」里选的那张卡，**不一定**是游戏真正读的那张 —— ' +
            'PCSX2 还有一层「每游戏设置」（文件在 gamesettings\\<序列号>_<CRC>.ini），' +
            '它会**盖掉**全局设置。我们就因为这个白排查过一轮：对话框里写着 A，游戏实际读的是 B。',
        }),
        el('div', { class: 'pcsx2-help-body' },
          el('b', { text: '什么时候该看它：' }),
          el('span', { text: '写卡前 / 进游戏前 —— 确认你要写的那张卡，就是游戏会读的那张。' }),
        ),
        el('div', { class: 'pcsx2-help-body' },
          el('b', { text: '怎么用（三种，任选一种）：' }),
          el('span', {
            text:
              '① 点上面的「选择 PCSX2 目录」选一次 ' + DEFAULT_PCSX2_DIR + '（一次就够，之后 Chrome 会记住）；' +
              '② 这个浏览器没有目录选择框时，用「用目录输入框选」；' +
              '③ 或者把 inis\\PCSX2.ini、gamesettings\\*.ini、logs\\emulog.txt（也可以整个目录）拖到上面那条虚线上。' +
              '**全程只读，不写任何文件。**',
          }),
        ),
        el('div', { class: 'pcsx2-help-body' },
          el('b', { text: '结论怎么读：' }),
          el('span', {
            text:
              '下面会列一张小表：Slot 1 / Slot 2 **实际会读哪张卡**，以及这个结论的**来源**' +
              '（「全局设置」还是「★每游戏覆盖」）。' +
              '如果对话框里的卡和实际会读的卡不一样，会用**红字**告诉你"游戏读到的是 X，不是你选的那张"。',
          }),
        ),
      ),
    );
    return;
  }

  host.appendChild(el('div', { class: 'dim', text: '认出来的文件：' + report.recognized.join('　') }));
  for (const w of report.warnings) host.appendChild(el('div', { class: 'bad', text: w }));
  for (const n of report.notes) host.appendChild(el('div', { class: 'dim', text: n }));

  const table = el('table', { class: 'pcsx2-table' });
  table.appendChild(
    el('tr', null,
      el('th', { text: '界面槽' }),
      el('th', { text: '日志里叫' }),
      el('th', { text: '实际会读的卡' }),
      el('th', { text: '结论来源' }),
      el('th', { text: '上次实际挂载' })),
  );
  for (const e of report.effective) {
    const slot = e.slot;
    const mcd = MCD_SLOT_OF[slot];
    const actual = report.actualMounts.find((m) => m.slot === slot);
    table.appendChild(
      el('tr', { class: e.source === 'game' ? 'row-warn' : '' },
        el('td', { text: `Slot ${slot}` }),
        el('td', { text: `McdSlot ${mcd}` }),
        el('td', { text: e.fileName || '(空)' }),
        el('td', { text: e.source === 'game' ? `★每游戏覆盖（${e.sourceFile} 盖掉了全局设置）` : e.source === 'global' ? '全局设置（inis\\PCSX2.ini）' : '未设置' }),
        el('td', {
          class: actual && actual.differs ? 'bad' : 'ok',
          text: actual ? `${actual.fileName}${actual.differs ? '（与上面的推断不同）' : ''}` : '（日志里没有）',
        })),
    );
  }
  host.appendChild(table);
  if (report.conflicts.length === 0) {
    host.appendChild(el('div', { class: 'ok', text: '✅ 没有「每游戏覆盖 vs 全局」冲突 —— 对话框里选的那张就是游戏会读的那张。' }));
  }
  // ★ 0.18：原来这里还有一句"判读方法：拿「实际会读的卡」这一列去和你对话框里选的卡对一下…"，
  //   按用户要求删掉。
}

// --------------------------------------------------------------------------
// 拖放 / 粘贴
// --------------------------------------------------------------------------

function installDropZones(): void {
  const stop = (ev: DragEvent): void => {
    ev.preventDefault();
    ev.stopPropagation();
  };
  // 拖入的目标：顶栏的记忆卡、中间那格的舞台、自检条
  // （`editor` / `view-original` 两个挂载点随面板一起删掉了）
  for (const id of ['card-drop', 'image-drop', 'pcsx2-drop']) {
    const zone = document.getElementById(id);
    if (!zone) continue;
    zone.addEventListener('dragover', (ev) => {
      stop(ev);
      zone.classList.add('drop-hot');
    });
    zone.addEventListener('dragleave', () => zone.classList.remove('drop-hot'));
    zone.addEventListener('drop', (ev) => {
      stop(ev);
      zone.classList.remove('drop-hot');
      void handleDrop(id, ev as DragEvent & { dataTransfer: DataTransfer });
    });
  }
}

async function handleDrop(zoneId: string, ev: DragEvent & { dataTransfer: DataTransfer }): Promise<void> {
  const dt = ev.dataTransfer;
  // 未来能拿到句柄就优先用（⇒ 保存时可直接覆盖原文件）
  const items = (dt.items ? Array.from(dt.items) : []).filter((i) => i.kind === 'file');
  if (zoneId === 'card-drop') {
    const files = Array.from(dt.files);
    if (!files.length) return;
    const f = files[0];
    let handle: FileSystemFileHandle | null = null;
    try {
      const anyItem = items[0] as unknown as { getAsFileSystemHandle?: () => Promise<FileSystemHandle | null> };
      const h = anyItem && anyItem.getAsFileSystemHandle ? await anyItem.getAsFileSystemHandle() : null;
      if (h && h.kind === 'file') handle = h as FileSystemFileHandle;
    } catch {
      handle = null; // 拿不到句柄不是错误，退化到只读
    }
    const bytes = new Uint8Array(await f.arrayBuffer());
    const consumed = await openCardFromBytes(f.name, bytes, handle);
    if (consumed.ok) afterCardLoaded();
    else refreshCardViews(null); // ★ 0.19（D2）
    return;
  }
  if (zoneId === 'pcsx2-drop') {
    // ★ 拖进来的可能是"三个文件"，也可能是**整个 PCSX2 目录**
    //   （拖目录时 `dt.files` 不含子文件 —— 那是浏览器行为，所以要走 FileSystemEntry 递归）
    await handlePcsx2Drop(dt);
    return;
  }
  // 图片区
  const files = Array.from(dt.files).filter((f) => /^image\//.test(f.type) || IMG_EXT_RE.test(f.name));
  const rejected = Array.from(dt.files).filter((f) => !files.includes(f));
  for (const f of rejected) {
    toast('warn', `不接受 ${f.name}`, 'PSD / TIFF / 多页 RAW 请先导出 PNG（SPEC.md §五：不做格式猜测）。');
  }
  if (files.length) await loadImageFromBlob(files[0], files[0].name);
}

function installPaste(): void {
  window.addEventListener('paste', (ev) => {
    const dt = (ev as ClipboardEvent).clipboardData;
    if (!dt) return;
    const files = Array.from(dt.files ?? []);
    const img = files.find((f) => /^image\//.test(f.type));
    if (img) {
      void loadImageFromBlob(img, `剪贴板 · ${img.name || 'image'}`);
      ev.preventDefault();
      return;
    }
    const items = Array.from(dt.items ?? []);
    const it = items.find((i) => i.type.startsWith('image/'));
    if (it) {
      const f = it.getAsFile();
      if (f) {
        void loadImageFromBlob(f, '剪贴板图片');
        ev.preventDefault();
      }
    }
  });
}

// --------------------------------------------------------------------------
// 按钮接线
// --------------------------------------------------------------------------

function bindButtons(): void {
  $('btn-card-open').addEventListener('click', () => void openCardViaPicker());
  // ★ 2026-10-05（0.10）：〔拖入 / 只读选择〕按钮已按用户要求删除 ⇒ 不再有它的 click 绑定。
  //   ⚠ `#card-input` 这个隐藏文件框**必须留着**：`openCardViaPicker()` 在没有
  //     `showOpenFilePicker`（或被拒）时会自动点它 ⇒ 只读兜底路径还在（保存时改成下载）。

  ($('card-input') as HTMLInputElement).addEventListener('change', (ev) => {
    const f = (ev.target as HTMLInputElement).files?.[0];
    if (f) void guard('读记忆卡', () => openCardViaInput(f));
  });

  $('btn-image-open').addEventListener('click', () => void pickImageFile());
  ($('image-input') as HTMLInputElement).addEventListener('change', (ev) => {
    const f = (ev.target as HTMLInputElement).files?.[0];
    if (f) void loadImageFromBlob(f, f.name);
  });

  $('game-select').addEventListener('change', () => onGameChanged());
  ($('custom-serial') as HTMLInputElement).addEventListener('change', () => onGameChanged());

  $('btn-write').addEventListener('click', () => void doWrite(state.selectedSlot, '写入选中槽'));

  $('btn-export-png').addEventListener('click', () => {
    void guard('导出 PNG', async () => {
      const p = state.prepared;
      if (!p) {
        toast('warn', '还没有可导出的图', '先导入一张图。');
        return;
      }
      await exportPng(p.rgba, p.width, p.height, `emblem_${Date.now()}.png`);
      toast('ok', '已导出 PNG', '导出的是**游戏口径**（索引 0 = 透明）。');
    });
  });

  // ★ 0.25（用户要求）：**删除 = 删完立刻写回卡文件**。
  //   以前删除只改内存副本，然后提示"导出整卡或写入选中槽时才会落盘" ——
  //   用户的操作直觉是"删了就是删了"。现在一次做完：确认框（写明会立刻写回）→
  //   内存副本上删 → 走同一条落盘路径（含"写前查句柄有没有过期" + 覆盖后回读比对）。
  $('btn-delete').addEventListener('click', () => {
    void guard('删除槽', async () => {
      const s = state.model?.slots[state.selectedSlot];
      if (!s || !s.occupied || !s.fileName) {
        toast('warn', `槽 ${state.selectedSlot + 1} 本来就是空的`, '没有可删的东西。');
        return;
      }
      setBusy(true, '删除槽：在内存副本上删 → 立刻写回卡文件 …');
      try {
        const out = await deleteSlotAndSave(s.dirName, s.fileName);
        renderLog(out.lines);
        // ⚠ 只要 `deleted` 为真，内存副本**一定**已经变了 ⇒ 无论如何都要重建视图，
        //   让 8 格显示内存里的真相（哪怕磁盘上还没落盘）。
        const g = currentGameContext();
        refreshCardViews(g.ok ? g.ctx : null);
        if (out.deleted && out.ok) {
          setStatus(`已删除并写回：${out.persisted ?? ''}`);
          toast('ok', '已删除，并已写回卡文件', out.persisted ?? '');
        } else if (out.deleted) {
          setStatus('⚠ 内存里已删除，但**没有落盘**（磁盘上还是原样）—— 见右侧日志');
          toast('error', '删除没落盘', '内存里已经删了；磁盘上的卡一个字节都没动。按日志里的步骤重做一次。', 20_000);
        } else if (out.lines.some((l) => l.includes('取消'))) {
          setStatus('已取消删除：磁盘与内存都没动。');
        } else {
          setStatus('删除失败（见右侧日志）');
        }
      } finally {
        setBusy(false);
        renderStatus();
      }
    });
  });

  // ★ 0.26：〔另存为…〕—— 把内存里这张卡另存成一份记忆卡文件（`showSaveFilePicker` 选位置/名字，
  //   拿不到那个对话框时退化成下载）。原名〔导出整卡〕。
  //   ⚠ 0.21 修过的坑：这里**只许挂一个**监听（当时重复挂过两段 ⇒ 点一次下载两次）。
  $('btn-save-as').addEventListener('click', () => void guard('另存为', () => saveCardAs()));

  $('btn-debug').addEventListener('click', () => {
    const model = state.model;
    if (!model) {
      toast('warn', '还没有打开记忆卡', '');
      return;
    }
    const dir = model.dirNames[0];
    const txt = dir ? direntDebug(dir) : '（卡上没有徽章目录）';
    renderLog([`── ${dir ?? '(无)'} 的目录项 ──`, ...txt.split('\n')]);
  });

  $('btn-pcsx2-dir').addEventListener('click', () => void pickPcsx2Dir());
  $('btn-pcsx2-input').addEventListener('click', () => openPcsx2DirInput());
  $('pcsx2-dir-input').addEventListener('change', (ev) => {
    const files = Array.from((ev.target as HTMLInputElement).files ?? []);
    if (!files.length) return;
    void guard('读 PCSX2 目录', () => setPcsx2Files(files, '目录输入框'));
  });
  $('btn-pcsx2-clear').addEventListener('click', () => {
    pcsx2Files = [];
    pcsx2Route = '未提供';
    // ★ 0.23：清空 = 回到初始状态 ⇒ 连同折叠一起复位（默认就是折叠的）
    setPcsx2Open(false);
    renderPcsx2();
  });
  // ★ 0.23：折叠开关（默认折叠；读进文件时会自动展开一次，见 setPcsx2Files）
  $('btn-pcsx2-toggle').addEventListener('click', () => setPcsx2Open(!pcsx2Open));
}

// --------------------------------------------------------------------------
// 启动
// --------------------------------------------------------------------------

function boot(): void {
  if ((window as unknown as Record<string, unknown>)['__EMBLEM_TOOL_BOOTED__']) return;
  (window as unknown as Record<string, unknown>)['__EMBLEM_TOOL_BOOTED__'] = true;

  installGlobalErrorHandlers();

  // 顶栏的版本号：**从 logic/version.ts 来**，HTML 里只留一个占位符 `v?`
  {
    const badge = document.getElementById('app-version');
    if (badge) badge.textContent = APP_VERSION_LABEL;
  }

  fillGameSelect(GAMES, DEFAULT_GAME_ID);
  bindParams();
  bindButtons();
  installDropZones();
  installPaste();
  // ★ 0.23：PCSX2 自检**默认折叠**（HTML 里已经是 hidden，这里再把 JS 状态与按钮文案对齐一次；
  //   之后自动读"记住的目录"成功时会自己展开 —— 见 setPcsx2Files）。
  setPcsx2Open(false);

  // ★ 0.26（用户要求）：**打开页面就先弹一次告知** —— 本项目没经过完整实机验证，
  //   请用户自己先备份记忆卡。顺便把那条硬规矩（写卡前完全退出 PCSX2）也放在这里，
  //   因为它正是"写了看不见"那类问题的最常见原因。
  //   ⚠ 必须点掉才能操作下面的界面（`.modal-host` 盖住整页）。
  showModal({
    title: '⚠ 本项目未经过完整测试',
    body:
      '这个徽章工具还在开发中：没有经过完整的实机验证，写卡 / 删除 / 新建槽这几条路都只验证过一部分，' +
      '任何一次写入都有可能把你的记忆卡改坏。\n\n' +
      '请先自己备份记忆卡：把 memcards\\ 里的 .ps2 复制一份到别处，再开始操作。\n\n' +
      '另一条硬规矩：写卡前先完全退出 PCSX2。它手里有一份卡，退出时会把那份写回文件，' +
      '你在工具里写进去的东西会被它覆盖掉。',
    ok: '我已知晓，并会自行备份记忆卡',
  });

  // ★ 取景视图（按需）：入口在左格工具条上；这里注入两个回调（放在 commitParams 之前，避免注入前就被别处调用）
  //   · onRelayout = **轻量**：只把 128×128 预览按容器重新量一次尺寸再画一遍（进出取景视图时用）。
  //     ⚠ 它**故意不调 recompute()/refreshImage()** —— 那两样（`prepareEmblem()` 实测 53~298 ms、
  //       统计面板里整张源图的 `imageStats()` 10~99 ms）以前是**每次 pointermove** 都跑，就是用户说的"卡"。
  //   · onChange   = **完整**：重算 + 刷新全部面板。现在只在〔确定取景〕那一下调一次。
  initCropView({
    onChange: () => {
      recompute();
      refreshImage();
    },
    onRelayout: () => {
      renderImageViews();
    },
  });

  const r = currentGameContext();
  renderGameNote(findGame(DEFAULT_GAME_ID) ?? null);
  renderSlots(null, r.ok ? r.ctx : null, { onSelect: selectSlot });
  renderCardInfo();
  renderPcsx2();
  // ★ 0.18：这里原来会往写入日志里灌 8 行"欢迎 + ①②③④ + ★ 各种说明"，
  //   **整块按用户要求删除**（"这几句话也删掉"）。日志现在**从第一操作开始才有内容**：
  //   写入 / 导出 / 看目录项的结果都照旧写在这里（`renderLog()` 会在空的时候把整个框隐藏）。
  //   ⚠ 安全提示"改卡前先完全退出 PCSX2"不在这里，它在**写卡确认框**里（`writeGuard.ts`），那条不能删。
  updateWriteHints();
  // ★ 0.19（A20）：这里原来还跟着 `recompute(); refreshImage();` —— 而 `commitParams()` 内部
  //   做的正是这两件事 ⇒ 开机白跑一遍（管线 + 面板各两次）。
  commitParams();
  setStatus('就绪：先选一张记忆卡（顶栏），或把 .ps2 卡拖进顶栏。');
  renderStatus();

  // ★ 上次记住的 PCSX2 目录若权限还在，就**静默自动读一遍**（不弹权限框；弹框必须由用户点击触发）
  void autoReadPcsx2IfRemembered();

  // 把核心层挂到 window（供 F12 手查；离线工具，不联网、不外传）
  // ★ 2026-10-05：把取景视图的入口也挂上 —— ① 用户 F12 里可以手查/手测取景；
  //   ② `build.mjs::smokeBoot()` 会在桩 DOM 里**真的走一遍**"进视图 → 拖动 → 确定取景"，
  //      钉住"确定以后 128×128 不能是空的"，也钉住"拖动期间一次管线都不跑"（调用计数）。
  (window as unknown as Record<string, unknown>)['EmblemToolCore'] = {
    emblem: emblemCore,
    card: cardCore,
    ui: {
      state,
      version: APP_VERSION,
      buildTag: UI_BUILD_TAG,
      cropView: {
        setCropView,
        openCropView,
        closeCropView,
        toggleCropView,
        isCropActive,
        layoutCropView,
        confirmCrop,
        cancelCrop,
        applyDrag,
        applyZoom,
        flushCropLayout,
        cropInfo,
      },
      // ★ F12 自测用：`pipelineStats()` 看性能契约；下面四个让"没有真图也能把界面推到某个状态"
      //   （`web/tools/screenshot.mjs --preview` 就是这么凭空造一张图来核对版式的）。
      pipeline: { pipelineStats, recompute, refreshImage, fillManualToTarget },
      // ★ 0.16：导入那张图之后要做的事（**不含解码**）—— 桩 DOM 冒烟与无头截图探针都走这条真路，
      //   这样"导入 ⇒ 自动进取景模式"就是被**真代码**验证的，而不是测试里手抄一遍。
      imageImport: { applyImportedImage },
    },
  };
}

boot();
