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
  writeSlot,
} from './cardOps.ts';
import { cardCore, emblemCore } from './cardOps.ts';
import { noDirForGameText } from './logic/slots.ts';
// ★ 0.42：写权限（请求权限需要用户手势 —— 必须在点击那一刻问）
import { ensureWritePermission, writePermHintKey } from './logic/writePermission.ts';
import { APP_VERSION, APP_VERSION_LABEL, UI_BUILD_TAG } from './logic/version.ts';
import { LANGS, currentLang, detectLang, isLang, onLangChange, setLang, t, type Lang } from './logic/i18n.ts';
import { decodeImageFile, fillManualToTarget, pipelineStats, recheckFinal, recompute, refreshImage, renderImageViews, renderOriginalBadge } from './pipeline.ts';
import { applyDrag, applyZoom, cancelCrop, closeCropView, confirmCrop, cropInfo, flushCropLayout, initCropView, isCropActive, layoutCropView, openCropView, refreshCropText, setCropView, setCropWindowSize, toggleCropView } from './cropView.ts';
import { fillGameSelect, markSelectedSlot, renderGameNote, renderLog, renderSlots, renderStatus } from './slotsView.ts';
import { relayoutStatus, setStatus, setStatusPair, state, type SourceImage } from './state.ts';
import { $, clear, dismissToasts, el, guard, installGlobalErrorHandlers, relayoutModalForLang, showModal, toast } from './dom.ts';
import { humanBytes } from './logic/format.ts';

// --------------------------------------------------------------------------
// 小工具
// --------------------------------------------------------------------------

/** `AbortError` = 用户按了取消 —— **不是错误**（SPEC.md §三 的 try/catch 要求）。 */
function isAbort(e: unknown): boolean {
  return !!e && typeof e === 'object' && (e as { name?: string }).name === 'AbortError';
}

/**
 * ★ 0.37（用户）：〔看目录项（调试）〕**再点一下要能收回去**。
 *
 * 原来它每次点击都 `renderLog(目录项)` ⇒ 第二次点只是把同一份内容又画一遍（看不出任何变化），
 * 用户看到的就是"点开以后收不回去"。所以现在记住"日志框里这份是不是目录项"：
 *   · 是 ⇒ 再点一次 = 清空日志（`renderLog([])` ⇒ `renderLog()` 会把整个框 `hidden`）＝ 收起；
 *   · 不是（被写入 / 删除 / 导出的结果顶掉了）⇒ 重新列一遍目录项。
 * ⚠ 所以**别的地方写日志一律走 `showLog()`**：它顺手把这个记录清掉，
 *   否则"先写卡、再点〔看目录项〕"会被当成"收起"，得点两下才看得到。
 */
let dirDebugLines: readonly string[] | null = null;

function showLog(lines: readonly string[]): void {
  dirDebugLines = null;
  renderLog(lines);
}

function setBusy(on: boolean, note?: string): void {
  state.busy = on;
  if (note) setStatus(note);
  renderStatus();
  // ★ 0.19（D8）：`btn-image-open` / `btn-crop` 也必须在名单里 —— 写入是**异步**的
  //   （`createWritable()`/`write()`/`close()`/`getFile()` 每一步都在 await），
  //   期间换一张图会让预览显示新图、而日志/提示报告"旧图写成功"。
  //   ★ 0.21：名单里的 `btn-write-all` 随〔批量写 8 槽〕一起删掉。
  //   ⚠⚠ 0.41（审查抓到）：光禁用按钮**不够** —— 拖入 / Ctrl+V / 兜底文件框 / 语言下拉都不看
  //   `state.busy`。最坏的一条：写入进行中拖入一张新卡 ⇒ `writeSlot()` 计划用的是**新卡**的模型，
  //   落盘写的却是**旧卡**的缓冲（`state.card` 在中途被换掉了）。所以那四条入口各自要挡（见
  //   `blockedWhileBusy()`），别只改这里。
  for (const id of ['btn-write', 'btn-delete', 'btn-card-open', 'btn-save-as', 'btn-image-open', 'btn-crop']) {
    const b = document.getElementById(id) as HTMLButtonElement | null;
    if (b) b.disabled = on;
  }
}

/**
 * ★ 0.41：**写入进行中**要挡住的非按钮入口（拖入 / 粘贴 / 兜底文件框 / 语言下拉）统一问这里。
 *
 * 返回 true = 已经拒绝了（并且给了一句人话），调用方直接 return。
 */
function blockedWhileBusy(what: string): boolean {
  if (!state.busy) return false;
  toast('warn', t('正在忙，先等这一步结束', 'Busy - wait for this step to finish', '処理中です。このステップが終わるまでお待ちください', '작업 중입니다. 이 단계가 끝날 때까지 기다려 주세요'), what, 6000);
  return true;
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
    renderSlots(null, { onSelect: selectSlot });
    renderCardInfo();
    updateWriteHints();
    return;
  }
  reloadModel(ctx);
  reloadThumbs();
  renderSlots(state.model, { onSelect: selectSlot });
  renderCardInfo();
  updateWriteHints();
}

/**
 * ★ 0.30：让"选择记忆卡"的选择框**尽量开在 `Documents\PCSX2\memcards`**（用户要求）。
 *
 * ⚠ 先说清楚浏览器允许什么：`startIn` 只收两种东西 ——
 *   ① 一个**已知文件夹枚举**（`'documents'` / `'downloads'` / `'desktop'` …）；
 *   ② 一个**目录句柄**。
 *   **不许写路径字符串**（写 `'C:\\…\\memcards'` 没用，会被忽略/报错）—— 这是浏览器的硬规定，不是取舍。
 *   ⇒ 所以"自动到 memcards"只有两条腿：
 *     · 有腿的那条：自检面板里选过 PCSX2 目录、授权还在 ⇒ 从它取出 `memcards` 子目录当 `startIn`，
 *       选择框**直接开在 memcards 里**；
 *     · 兜底：`'documents'` ⇒ 开在"文档"（`C:\Users\M\Documents`，memcards 就在它下面两层）。
 *
 * ★★ 为什么这里是"缓存的句柄"而**不是**点击时现算：`showOpenFilePicker` 要的是 **transient activation**
 *   （点击起 5 秒内）。若在"点击 → 弹框"之间夹一个 `await`（打开 IndexedDB / 查权限），
 *   一旦 IDB 被别的标签页卡住，这几百毫秒会变成"手势过期" ⇒ 弹框反而被拒、静默掉进只读兜底。
 *   ⇒ 句柄在**启动时**与**选完 PCSX2 目录后**各刷新一次，点击那一下是**同步**取用（没有再 await）。
 */
let memcardsHandle: FileSystemDirectoryHandle | null = null;

/** 刷新 `memcardsHandle`（拿不到就置 null —— "开在文档"那一档）。`dir` 给了就不必再去读 IndexedDB。 */
async function refreshMemcardsHandle(dir?: FileSystemDirectoryHandle | null): Promise<void> {
  try {
    const base = dir ?? (await recallPcsx2Handle());
    if (!base || (await base.queryPermission({ mode: 'read' })) !== 'granted') {
      memcardsHandle = null;
      return;
    }
    memcardsHandle = await base.getDirectoryHandle('memcards');
  } catch {
    /* 句柄失效 / 权限掉了 / 里面没有 memcards ⇒ 开在文档 */
    memcardsHandle = null;
  }
}

async function openCardViaPicker(): Promise<void> {
  const w = window as unknown as {
    showOpenFilePicker?: (o: unknown) => Promise<FileSystemFileHandle[]>;
  };
  if (typeof w.showOpenFilePicker !== 'function') {
    toast(
      'info',
      t('这个浏览器没有 showOpenFilePicker', 'This browser has no showOpenFilePicker', 'このブラウザーには showOpenFilePicker がありません', '이 브라우저에는 showOpenFilePicker가 없습니다'),
      t('改用文件选择框（只读：保存时会改成"下载一份改好的卡"）。', 'Falling back to the file picker (read-only: saving will download a modified copy of the card).', 'ファイル選択ダイアログに切り替えます（読み取り専用：保存時は「修正済みのカードをダウンロード」になります）。', '파일 선택 대화상자로 전환합니다 (읽기 전용: 저장 시 "수정된 카드 다운로드"로 바뀝니다).'),
    );
    ($('card-input') as HTMLInputElement).click();
    return;
  }
  if (!memcardsHandle) void refreshMemcardsHandle(); // 没缓存就顺手刷一次（下一次点就能开在 memcards）
  await guard(t('选择记忆卡', 'Choose memory card', 'メモリーカードを選択', '메모리 카드 선택'), async () => {
    /** 选择框的选项（`types` 与 0.29 一致；`startIn` 由候选表决定）。 */
    const options = (startIn: unknown): unknown => ({
      id: 'emblemCard',
      multiple: false,
      mode: 'readwrite',
      startIn,
      types: [
        {
          description: t('PS2 记忆卡 / 存档', 'PS2 memory card / save', 'PS2 メモリーカード / セーブデータ', 'PS2 메모리 카드 / 세이브 데이터'),
          accept: { 'application/octet-stream': ['.ps2', '.mcr', '.mc2', '.bin', '.psv'] },
        },
      ],
    });
    // ★ 0.30：候选顺序 = 缓存住的 `memcards` 目录句柄 → `'documents'`。
    //   ⚠ 这一段里**不许出现任何异步等待**（理由见上面那段 ★★；`ui.test.ts` 分节 (r) 拿掩码源码钉住）；
    //   只对"**不是**用户取消"的错误往下试。
    const tries: Array<FileSystemDirectoryHandle | 'documents'> = memcardsHandle ? [memcardsHandle, 'documents'] : ['documents'];
    let handles: FileSystemFileHandle[] | null = null;
    let lastError: unknown = null;
    for (const startIn of tries) {
      try {
        handles = await w.showOpenFilePicker!(options(startIn));
        break;
      } catch (e) {
        if (isAbort(e)) {
          setStatusPair('已取消选择记忆卡。', 'Cancelled choosing a memory card.', 'メモリーカードの選択をキャンセルしました。', '메모리 카드 선택을 취소했습니다.');
          return;
        }
        lastError = e;
      }
    }
    if (!handles) {
      // 权限/类型过滤等失败 ⇒ 退化到只读路径，而不是让用户看到"没反应"
      toast('warn', t('打不开文件选择器，退化到只读方式', "Can't open the file picker — falling back to read-only", 'ファイル選択ダイアログを開けないため、読み取り専用に切り替えます', '파일 선택기를 열 수 없어 읽기 전용으로 전환합니다'), lastError instanceof Error ? `${lastError.name}: ${lastError.message}` : String(lastError));
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
    toast('info', t('这是只读方式打开的', 'Opened in read-only mode', '読み取り専用で開きました', '읽기 전용으로 열었습니다'), t('保存时会改成"下载一份改好的卡"（这个环境没给写句柄）。', 'Saving will download a modified copy of the card instead (this environment gave no write handle).', '保存時は代わりに「修正済みのカードをダウンロード」になります（この環境では書き込みハンドルが得られませんでした）。', '저장 시 대신 "수정된 카드 다운로드"로 처리됩니다 (이 환경에서는 쓰기 핸들을 받지 못했습니다).'));
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
    // ★ 0.40：这句话要能被**重说**（切语言时按新语言再说一遍）⇒ 走 `redo`
    const redo = (): string => noDirForGameText(state.model?.serial ?? null, state.model?.excludedDirNames.length ?? 0);
    setStatus(redo(), redo);
    // ★ 0.43（用户："提示过于重复了"）：这里原来还会**再弹一条 20 秒的 info toast**，说的正是
    //   状态行刚说过的那句话 ⇒ 屏幕上一度同时有 5 处在讲"这个作品在卡上没有目录"。
    //   现在删掉：状态行 + 8 槽上方那条常驻提示已经够了（toast 只留给"真发生了动作"）。
    return;
  }
  // ★ 0.37（用户）：开卡成功时**不再往状态行写那句摘要**（占用与空槽数、当前作品的目录名、
  //   卡上其它作品的清单 —— 这句已按用户要求整句删除）。
  //   ⇒ 顺手把启动时那句"先选一张记忆卡…"**清掉**：卡都打开了，那句话只会误导。
  //   打开卡本身由顶栏 `#card-info` 报（文件名 + 锁状态 + 大小），状态行留给"真发生了什么"。
  // ★ 0.40：只有"本来就没有别的消息"时才清 —— 原来这里无条件 `setStatus('')`，会把上面那句
  //   缺目录提示**当场抹掉**（用户只看到 toast，状态行是空的）。
  setStatus('');
}

/**
 * 顶栏那一行"卡信息"：锁状态（能不能覆盖保存）+ 文件名 + 卡文件大小。
 *
 * ★ 0.27（用户）：原来还有第三段"整卡徽章目录清单"，用户说"没有显示价值的" ⇒ 删了。
 *   ⚠ 别把那句 UI 文案写进注释：注释会进产物，`ui.test.ts` 分节 (o) 的判据正是
 *   "产物里不该再出现它"。
 */
function renderCardInfo(): void {
  const host = $('card-info');
  clear(host);
  const lc = state.card;
  if (!lc) {
    host.appendChild(el('span', { class: 'dim', text: t('未选择记忆卡', 'No memory card selected', 'メモリーカードが選択されていません', '메모리 카드가 선택되지 않았습니다') }));
    return;
  }
  host.appendChild(
    el('span', {
      class: lc.handle ? 'ok' : 'warn',
      // ★ 0.30（用户）：锁状态里**不再写那个后缀**（那几个字嫌多余；原话见 ui.test.ts 分节 (r)）——
      //   ⚠ 那是一条"产物里一个都不许有"的判据 ⇒ 别把原文抄进注释（注释会进产物）。
      //   🔓 就是"能直接覆盖保存"（含义写在 SPEC/README 的"两段"那条里），🔒 那条自带说明。
      text: lc.handle ? t(`🔓 ${lc.fileName}`, `🔓 ${lc.fileName}`, `🔓 ${lc.fileName}`, `🔓 ${lc.fileName}`) : t(`🔒 ${lc.fileName}（只读 · 保存=下载）`, `🔒 ${lc.fileName} (read-only · save = download)`, `🔒 ${lc.fileName}（読み取り専用 · 保存＝ダウンロード）`, `🔒 ${lc.fileName} (읽기 전용 · 저장=다운로드)`),
    }),
  );
  host.appendChild(el('span', { class: 'dim', text: `　${humanBytes(lc.sourceBytes.length)}` }));
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

/**
 * 顶栏「作品」那一段的**文字**：下拉右边的"⚠ 未验证…"警告 + 解析失败的红字。
 * 返回值 = 解析结果，调用方接着用它决定要不要重建槽位模型。
 *
 * ★ 0.39：抽成单独一份 —— **切语言时必须重画它**。原来 `relayoutForLang()` 只重画了下拉框，
 *   把这两块忘了，于是出现"下拉已经是中文、右边那句警告还是英文"的错位（用户实测截图抓到的）。
 *   ⚠ 以后往这一段加文字，它会被 `onGameChanged()`、`boot()`、`relayoutForLang()` **三条路**走到。
 */
function renderGameBlock(): GameCtxResult {
  const r = currentGameContext();
  const entry = findGame((document.getElementById('game-select') as HTMLSelectElement | null)?.value ?? '');
  renderGameNote(entry ?? null);
  const err = $('game-error');
  clear(err);
  if (!r.ok) {
    err.appendChild(el('span', { class: 'bad', text: r.error ?? t('作品无法解析', 'Cannot resolve the game', 'タイトルを特定できません', '타이틀을 확인할 수 없습니다') }));
  }
  return r;
}

function onGameChanged(): void {
  const r = renderGameBlock();
  if (!r.ok) {
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
      // ★ 0.40：带上 `redo`（切语言时按新语言再说一遍，而不是被清掉）
      const redo = (): string => noDirForGameText(state.model?.serial ?? null, state.model?.excludedDirNames.length ?? 0);
      setStatus(redo(), redo);
    } else {
      // ★ 0.37：切作品只报"切到了哪个作品"（原来后面还挂一句槽位摘要，那句已按用户要求整句删除）。
      setStatusPair(`已切到「${entry?.label ?? ''}」`, `Switched to "${entry?.en ?? ''}"`, `「${entry?.ja ?? ''}」に切り替えました`, `"${entry?.ko ?? ''}"(으)로 전환했습니다`);
    }
  }
}

/** 把"这一槽写下去会怎样"提前算给用户看（尤其是不合规/缺目录时）。 */
function updateWriteHints(): void {
  const host = $('write-hint');
  clear(host);
  const r = currentGameContext();
  if (!r.ok || !state.model) {
    host.appendChild(el('span', { class: 'dim', text: state.card ? t('（先选作品）', '(pick a game first)', '（先にタイトルを選択）', '(먼저 타이틀을 선택)') : t('（先打开记忆卡）', '(open a memory card first)', '（先にメモリーカードを開く）', '(먼저 메모리 카드를 열기)') }));
    return;
  }
  const ctx = r.ctx;
  const isLr = ctx.entry.form === 'lr-archive';
  // ★ 0.21：单槽（〔批量写 8 槽〕已删）⇒ 一个目标、一条提醒、一条拒绝理由。
  const plan = planWriteTarget(ctx, state.selectedSlot);
  if (plan.error) {
    // ★ 0.43（用户："我觉得这部分的提示过于重复了"）：**一个事实只在主位讲一遍**。
    //   拒绝理由的正文（为什么写不了 + 怎么办）**只在这里出现这一次**；
    //   机制解释（"卡层为什么不建目录"）挪进 `title`（鼠标停一下才看，不占正文）；
    //   状态行与右下角 toast 只留一句标签（`plan.errorShort`）。
    //   ⚠ 主位既然已经讲了"这一槽写不了"，下面那两行（缺目录整句 / 作品常量）就是**同一条**事实的
    //     复述 ⇒ 这里直接 return，不再追加任何一行。
    host.appendChild(el('div', { class: 'bad', text: plan.error, title: plan.errorDetail ?? null }));
    return;
  }
  // ★ 0.32（用户）：原来这里还有一行把**目标文件**提前念一遍 —— 「槽 N → 目录\文件」后面再挂一个
  //   "这是新文件、还是盖掉已有文件"的括号标注；用户原话「我认为这两行的内容也没有作用，直接删除」。
  //   ⚠ 0.37 起**槽卡片上也不再写目标文件**（用户把卡片上的文字整段删掉了）⇒ "会盖掉哪个文件 /
  //   是不是盖掉"现在只在**落盘确认框**里说一遍（`logic/writeGuard.ts::confirmWriteMessage()`
  //   = 即将直接覆盖 + 改动摘要 + 那句硬提示），那才是安全提示该在的地方（SPEC.md §三 / §八 4）。
  //   ⚠ 上面那条 `plan.error` **不能删**：它是唯一说清"这一槽为什么写不了"的地方。
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
          ? t(
              `作品常量可从卡上同作品的真实存档里取（找到 ${same.length} 个：${same.map((s) => `${s.dir}\\${s.file}`).join('、')}）`,
              `Game constants can be taken from real saves of this game on the card (found ${same.length}: ${same.map((s) => `${s.dir}\\${s.file}`).join(', ')})`, `タイトル定数はカード上の同じタイトルの実セーブデータから取得できます（${same.length} 件：${same.map((s) => `${s.dir}\\${s.file}`).join('、')}）`, `타이틀 상수는 카드에 있는 같은 타이틀의 실제 세이브 데이터에서 가져올 수 있습니다 (${same.length}개 발견: ${same.map((s) => `${s.dir}\\${s.file}`).join(', ')})`,
            )
          : t(
              '⚠ 卡上没有同作品的真实存档，作品常量只能查核心层登记表（只有 SL / NX 有）；都没有时会拒绝写入。',
              '⚠ The card has no real save for this game, so the game constants can only come from the core registry (only SL / NX have one). If neither is available, the write is refused.', '⚠ カード上に同じタイトルの実セーブデータがないため、タイトル定数はコア層の登録テーブルからのみ取得できます（登録があるのは SL / NX のみ）。どちらもない場合は書き込みを拒否します。', '⚠ 카드에 같은 타이틀의 실제 세이브 데이터가 없어 타이틀 상수는 코어 계층 등록표에서만 가져올 수 있습니다 (SL / NX만 등록되어 있음). 둘 다 없으면 쓰기를 거부합니다.',
            ),
      }),
    );
  }
}

// --------------------------------------------------------------------------
// 槽位选择
// --------------------------------------------------------------------------

function selectSlot(i: number): void {
  state.selectedSlot = i;
  // ★ 0.41（审查抓到）：这里原来整批 `renderSlots()`（重建 8 格）⇒ 键盘焦点掉回 body
  //   （选一格就没法接着 Tab 了），而且白重画 8 张缩略图。现在只切高亮。
  markSelectedSlot(i);
  updateWriteHints();
  // ★ 0.32（用户）：这里原来还会往状态行写一行 —— "选中的是哪个槽" + 它的文件名 / 长度 / 簇号
  //   （空槽则是另一句，说它写下去的时候会自动建文件）；用户原话「我认为这两行的内容也没有作用，
  //   直接删除」。删掉的理由：这些字段要么在**落盘确认框**里说（会覆盖哪个文件 / 是不是覆盖），
  //   要么在写入日志里逐条列，而且选中与否卡片自己会高亮（`.slot-selected`）⇒ 状态行不必复述。
  //   ⇒ 于是状态行只报"真发生了变化"的事（切作品 / 写卡结果 / 出错），不再复述槽内容。
  //   ⚠ 所以这里**故意不调** `renderStatus()`：状态行一个字都没改。
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
 *      所以这里最后一步直接 `openCropView()`，省掉"导入完还要再点一次〔取景〕"；
 *   2. 能在桩 DOM 冒烟 / 无头截图探针里**走真路**（`window.EmblemToolCore.ui.imageImport.applyImportedImage`），
 *      而不是在测试里手抄一遍"导入应该做什么"。
 */
function applyImportedImage(img: SourceImage, name: string, opts: { clipboard?: boolean } = {}): void {
  // 换图时先离开取景视图（取景框是按**旧图标尺**算的，留着会错位）
  closeCropView();
  // ★ 0.40：`name` 只存**原文件名**（语言无关）；"剪贴板"那个前缀由 `renderOriginalBadge()`
  //   按当前语言现拼 —— 原来在这里就把 `t()` 的结果存进 state，切语言后那行永远是旧语言。
  state.source = { ...img, name, clipboard: opts.clipboard === true };
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
    r.ok ? t(`已导入 ${name}`, `Imported ${name}`, `${name} を読み込みました`, `${name}을(를) 불러왔습니다`) : t(`已导入 ${name}，但还不合规`, `Imported ${name}, but it is not compliant yet`, `${name} を読み込みましたが、まだ適合していません`, `${name}을(를) 불러왔지만 아직 적합하지 않습니다`),
    r.ok
      ? t(
          `${img.width}×${img.height} → ${state.params.targetSize}×${state.params.targetSize}，实色 ${state.prepared?.report.colorsAfter ?? '?'}；` +
            `已按「填满白框」给好初始取景（倍率 ${state.params.manualFitScale.toFixed(3)}）。` +
            '★ 已进入取景模式：拖动图片 / 滚轮缩放，白框下面那行是实时读数，满意就按〔确定取景〕。',
          `${img.width}×${img.height} → ${state.params.targetSize}×${state.params.targetSize}, solid colors ${state.prepared?.report.colorsAfter ?? '?'}; ` +
            `initial crop set by "fill the white box" (scale ${state.params.manualFitScale.toFixed(3)}). ` +
            '★ Crop mode is on: drag the image / scroll to zoom; the line under the white box is a live readout — press "Apply crop" when happy.', `${img.width}×${img.height} → ${state.params.targetSize}×${state.params.targetSize}、実色 ${state.prepared?.report.colorsAfter ?? '?'}；「白枠を埋める」で初期トリミングを設定しました（倍率 ${state.params.manualFitScale.toFixed(3)}）。★ トリミングモードに入りました：画像をドラッグ / スクロールでズーム、白枠の下の行がリアルタイムの値です。よければ〔トリミングを確定〕を押してください。`, `${img.width}×${img.height} → ${state.params.targetSize}×${state.params.targetSize}, 실색 ${state.prepared?.report.colorsAfter ?? '?'}; "흰색 상자 채우기"로 초기 자르기를 설정했습니다(배율 ${state.params.manualFitScale.toFixed(3)}). ★ 자르기 모드입니다: 이미지를 드래그 / 스크롤로 확대·축소하고, 흰색 상자 아래 줄이 실시간 값입니다. 만족하면 〔자르기 적용〕을 누르세요.`,
        )
      : r.error ?? '',
  );
  // ★ 0.16：直接进取景模式（这一步会顺手把状态行写成取景读数，所以上面不再另写"图片就绪…"）
  openCropView();
  if (!r.ok) {
    // 不合规时把原因也写进状态行 —— 取景读数会盖掉它，所以放在 openCropView() 之后**再刷一次**
    setStatusPair(`图片不合规，拒绝写入：${r.error}`, `Image is not compliant, write refused: ${r.error}`, `画像が要件を満たしていないため、書き込みを拒否：${r.error}`, `이미지가 규격에 맞지 않아 쓰기를 거부합니다: ${r.error}`);
    renderStatus();
  }
}

async function loadImageFromBlob(blob: Blob, name: string, opts: { clipboard?: boolean } = {}): Promise<void> {
  await guard(t('导入图片', 'Import image', '画像を読み込む', '이미지 불러오기'), async () => {
    applyImportedImage(await decodeImageFile(blob, name), name, opts);
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

  // ★ 0.28：填充抽成 `fillKernelSelect()` —— 语言切换时选项文案要跟着换（值不变）
  fillKernelSelect();
  const kSel = $('kernel') as HTMLSelectElement;
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
  //     要看当前取景的几个数：点左上的〔取景〕，白框下面那行实时读数一直在写。

  const zoom = $('preview-zoom') as HTMLSelectElement;
  clear(zoom);
  for (const z of [1, 2, 4, 8]) {
    zoom.appendChild(el('option', { value: String(z), selected: z === state.params.previewZoom }, z === 1 ? '1:1' : `${z}×`));
  }
  zoom.value = String(state.params.previewZoom);
  zoom.addEventListener('change', () => {
    state.params.previewZoom = Number(zoom.value) || 4;
    // ★ 只影响"当前图片"那一块画布 ⇒ 用轻量的 renderImageViews()，别顺带重建统计面板。
    //   ⚠ 0.41（审查抓到）：原来这里的理由写的是"`refreshImage()` 里的 `renderOriginalBadge()`
    //   会把整张源图扫一遍、0.8 M 像素实测 ~99 ms" —— 那个 `imageStats()` 在 0.9 就删了，
    //   现在 `renderOriginalBadge()` 只写一行"名字 · 尺寸"。结论仍然对（预览倍率不需要重算管线、
    //   也不需要重画那行字），只是理由过时了。
    renderImageViews();
  });
}

/** 填 `#kernel` 的选项（语言切换时要重跑一次 —— 值是同一个，只有文案换）。 */
function fillKernelSelect(): void {
  const kSel = $('kernel') as HTMLSelectElement;
  clear(kSel);
  for (const o of KERNEL_LABELS) {
    kSel.appendChild(el('option', { value: o.value, selected: o.value === state.params.kernel }, t(o.label, o.en, o.ja, o.ko)));
  }
  kSel.value = state.params.kernel;
}

// --------------------------------------------------------------------------
// 语言（0.28）
// --------------------------------------------------------------------------

/** 开机那句"就绪…"（语言切换后要按新语言重写一次状态行）。 */
const READY_TEXT = (): string =>
  t(
    '就绪：先选一张记忆卡（顶栏），或把 .ps2 卡拖进顶栏。',
    'Ready — pick a memory card in the top bar, or drop a .ps2 card onto it.', '準備完了：上部バーでメモリーカードを選ぶか、.ps2 のカードを上部バーにドラッグ＆ドロップしてください。', '준비됨: 상단 표시줄에서 메모리 카드를 선택하거나 .ps2 카드를 상단 표시줄로 드래그 앤 드롭하세요.',
  );

/** 填顶栏那个语言下拉。⚠ 选项文字**不翻译**：语言名各自用自己的语言写。 */
function fillLangSelect(): void {
  const sel = $('lang-select') as HTMLSelectElement;
  clear(sel);
  for (const l of LANGS) {
    sel.appendChild(el('option', { value: l.value, selected: l.value === currentLang() }, l.label));
  }
  sel.value = currentLang();
}

/**
 * 切语言之后把 **JS 生成的那部分文字**重画一遍（静态外壳由 `applyStaticI18n()` 管，不用这里操心）。
 *
 * 重画：作品下拉 **＋ 它右边那句未验证警告 / 报错红字（`renderGameBlock()`）** · 缩放核下拉 ·
 * 语言下拉自己 · PCSX2 面板 · 顶栏卡信息 · 8 槽与警告位 · 写卡提示 · 状态行 · 图片区小字 ·
 * 取景读数 · 〔展开/收起〕按钮文案。
 * **有意不重画**：
 *   · 写入日志 —— 那是**历史记录**（当时的操作结果），不该因为切语言就被改写；
 *   · 已经弹过的 toast —— 它是瞬时提示，切语言时早就该消失了；
 *   · 弹窗正文 —— `.modal-host` 是整页遮罩（`position: fixed`）⇒ 它开着的时候**点不到**语言下拉，
 *     所以不存在"弹窗开着切语言"这个情形。
 *
 * ★★ 0.39 修的那个错位：作品那一段的文字原来**没在名单里** —— 下拉框被重画成新语言了，
 *   紧挨着它的"⚠ 未验证…"还是旧语言（用户截图：下拉是"AC2 ⚠ 未验证"、右边却是
 *   "⚠ Unverified: no real emblem sample."）。现在统一走 `renderGameBlock()`。
 *   ⚠ 教训：**同一个块里的文字要由同一个函数产出**，否则"重画名单"一定会漏。
 */
function relayoutForLang(): void {
  const gSel = document.getElementById('game-select') as HTMLSelectElement | null;
  fillGameSelect(GAMES, gSel?.value || DEFAULT_GAME_ID);
  renderGameBlock(); // ★ 0.39：未验证警告 / 报错红字跟着下拉一起换语言
  fillKernelSelect();
  fillLangSelect(); // 同步下拉的选中项（F12 里 `lang.set('en')` 也要让它跟着变）
  setPcsx2Open(pcsx2Open); // 重写〔展开/收起〕那个按钮的文案（面板的展开状态不动）
  renderPcsx2();
  // ★ 0.40：**只重画挂载点，不复用 `afterCardLoaded()`** —— 那条路是"开卡成功"的事件语义
  //   （会清状态行、可能弹一条 20 s 的 toast、把 8 张缩略图重读一遍）。切语言不该产生"事件"。
  const ctx = currentGameContext();
  refreshCardViews(ctx.ok ? ctx.ctx : null);
  relayoutModalForLang(); // 弹窗开着时（Tab / F12 也能切语言）把标题正文按钮一起换
  dismissToasts(); // ★ 0.40：屏上还没消失的提示条**收掉**（它们是渲染好的字符串，没法重说）
  renderOriginalBadge(); // ★ 0.40：顶部"文件名 · 尺寸"（剪贴板那张图的名字要跟着换语言）
  // 状态行：能"重说"的按新语言重说；否则开卡后空着、没开卡回到"就绪"那句
  if (!relayoutStatus()) setStatus(state.card ? '' : READY_TEXT());
  renderImageViews();
  // ★ 0.40：取景读数（`#crop-readout`）与取景时那句状态行也要按新语言重画 ——
  //   `layoutCropView()` 只写样式，文字在 `describeWindow()` 里（原来漏的就是它）。
  if (isCropActive()) refreshCropText();
  renderStatus();
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

/**
 * ★ 0.42：**在点击那一刻**把写权限问好（用户实测的真 bug 的修法）。
 *
 * 请求写权限（`requestPermission`）需要 **transient user activation**：只有用户手势起 ~5 秒内、
 * 且中间没经过 `confirm()` 这种模态框才允许调。旧代码是在"整条管线 + 落盘确认框"之后才问 ⇒ 必然抛
 * 浏览器抛 `SecurityError`（"要用户手势才能请求权限"）—— 界面表现为
 * "内存写 + 回读自检全过，最后一句英文错"，用户根本没法照做。
 *
 * ⇒ 现在：`doWrite()` / 〔删除槽〕**一进来**（任何 `await` 之前）就问一次，结论记在
 * `state.card.writePerm` 上；`cardOps.ts::persistCardChange()` 只读那个结论，**永不**再问。
 *
 * ⚠ 拿不到权限**不是错误**：产品一直承诺"没写句柄/没权限 ⇒ 改成下载一份改好的卡"。这里只提前
 * 告诉用户一声（免得等到最后才发现），流程照走。
 */
async function requestWritePermissionIfNeeded(): Promise<void> {
  const lc = state.card;
  if (!lc || !lc.handle) return; // 没句柄 ⇒ 本来就走下载那条路
  if (lc.writePerm?.ok) return; // 这个会话里已经拿到了
  const r = await ensureWritePermission(lc.handle);
  lc.writePerm = r;
  if (r.ok) return;
  const hint = writePermHintKey(r);
  toast(
    'warn',
    t('这次拿不到写权限 ⇒ 会改为下载一份改好的卡', 'No write permission this time - a modified copy will be downloaded instead', '今回は書き込み権限が取得できないため ⇒ 代わりに修正済みのカードをダウンロードします', '이번에는 쓰기 권한을 받지 못함 ⇒ 대신 수정된 카드를 다운로드합니다'),
    hint === 'gesture'
      ? t(
          '浏览器要求"请求写权限"必须由点击触发 —— 请再点一次〔写入选中槽〕。',
          'The browser requires the permission request to come from a click - press the button again.', 'ブラウザーの仕様により「書き込み権限の要求」はクリックで行う必要があります —— 〔選択スロットに書き込み〕をもう一度押してください。', '브라우저는 "쓰기 권한 요청"이 클릭으로 시작되어야 합니다 —— 〔선택한 슬롯에 쓰기〕를 다시 눌러 주세요.',
        )
      : hint === 'denied'
        ? t('你在权限框里点了"不允许"。想直接覆盖原卡的话，再点一次并选择允许。', 'You chose "don\'t allow" in the permission prompt. To overwrite the card directly, press again and allow it.', '権限ダイアログで「許可しない」を選びました。元のカードに直接上書きするには、もう一度押して許可を選んでください。', '권한 대화상자에서 "허용 안 함"을 선택했습니다. 원본 카드에 직접 덮어쓰려면 다시 누르고 허용을 선택하세요.')
        : t('这个文件句柄只有读权限（例如拖进来的卡）。', 'This file handle is read-only (a dropped card, for example).', 'このファイルハンドルは読み取り専用です（ドラッグ＆ドロップしたカードなど）。', '이 파일 핸들은 읽기 전용입니다 (드래그 앤 드롭한 카드 등).'),
    12_000,
  );
}

async function doWrite(slotIndex: number, what: string): Promise<void> {
  if (state.busy) return;
  // ★ 0.42：**第一件事**就是问写权限（手势还在）—— 别夹在别的 await 后面
  await requestWritePermissionIfNeeded();
  // ★ 0.26（用户要求）：**取景模式里不许写入** —— 取景没〔确定〕之前，参数行还是上一次确定的值，
  //   这时候写下去的是"上一次的取景"，跟你在白框里看到的不一样。弹窗说清，然后中止。
  if (isCropActive()) {
    // ★ 0.40：`showModal()` 收**渲染函数**（切语言时它会被重放 ⇒ 标题正文按钮一起换语言）
    showModal(() => ({
      title: t('先在取景视图里点〔确定取景〕', 'First press "Apply crop" in the crop view', '先にトリミングビューで〔トリミングを確定〕を押してください', '먼저 자르기 보기에서 〔자르기 적용〕을 누르세요'),
      body: t(
        '你现在还在取景模式：白框里的取景还没有生效，这时候写入用的是上一次确定的取景，' +
          '和你在屏幕上看到的不一样。\n\n' +
          '请点左边那行里的〔确定取景〕（想放弃这次调整就点〔取消〕），然后再点〔写入选中槽〕。',
        'You are still in crop mode: the crop inside the white box has not taken effect yet, so writing now would use the previous confirmed crop, ' +
          'which is not what you see on screen.\n\n' +
          'Press "Apply crop" on the line at the left (press "Cancel" to drop this adjustment), then press "Write to selected slot".', `まだトリミングモードです：白枠の中のトリミングがまだ反映されていないため、このまま書き込むと前回確定したトリミングが使われ、画面で見ているものと違います。\\n\\n左の行の〔トリミングを確定〕を押し（この調整をやめるなら〔キャンセル〕）、それから〔選択したスロットに書き込み〕を押してください。`, `아직 자르기 모드입니다: 흰색 상자 안의 자르기가 아직 반영되지 않아, 지금 쓰면 이전에 적용한 자르기가 사용되어 화면에서 보는 것과 다릅니다.\\n\\n왼쪽 줄의 〔자르기 적용〕을 누르고(이번 조정을 버리려면 〔취소〕), 그다음 〔선택한 슬롯에 쓰기〕를 누르세요.`,
      ),
    }));
    return;
  }
  const r = currentGameContext();
  if (!r.ok || !r.ctx) {
    toast('error', t('作品没选对', 'Wrong game selected', 'タイトルの選択が正しくありません', '타이틀 선택이 올바르지 않습니다'), r.error ?? t('请在下拉框里选一个作品', 'Pick a game in the dropdown', 'ドロップダウンでタイトルを選んでください', '드롭다운에서 타이틀을 선택하세요'));
    return;
  }
  if (!state.prepared) {
    toast('error', t('还没有可写入的图像', 'No image ready to write', '書き込みできる画像がまだありません', '쓰기 가능한 이미지가 아직 없습니다'), state.prepareError ?? t('先导入一张图（拖入 / 点击选择 / Ctrl+V 粘贴）。', 'Import an image first (drop / click to choose / Ctrl+V paste).', '先に画像を読み込んでください（ドラッグ＆ドロップ / クリックして選択 / Ctrl+V で貼り付け）。', '먼저 이미지를 불러오세요 (드래그 앤 드롭 / 클릭하여 선택 / Ctrl+V 붙여넣기).'));
    return;
  }
  setBusy(true, t(`${what}中：生成徽章块 → 在内存副本上写 → 回读自检 …`, `${what} in progress: build the emblem block → write to the in-memory copy → read back to verify …`, `${what}中：エンブレムブロックを生成 → メモリー上のコピーに書き込み → 読み戻して自己検証 …`, `${what} 중: 엠블럼 블록 생성 → 메모리 사본에 쓰기 → 다시 읽어 자체 검증 …`));
  try {
    const isLr = r.ctx.entry.form === 'lr-archive';
    const outcome = await writeSlot(r.ctx, slotIndex, { isLr, finalCheck: recheckFinal });
    showLog(outcome.lines);
    // ★★ 0.40（审查抓到的真 bug）：**无论成败都要重建视图** —— `writeSlot()` 的顺序是
    //   "先在内存副本上写 → 弹落盘确认框 → 回读自检"，所以用户在确认框里按**取消**、或回读自检
    //   不过时，**内存副本已经变了**（`cardOps.ts` 里 `writeBlockToTarget()` 在 `persistCardChange()`
    //   之前）。原来这里只在 `outcome.ok` 时重建 ⇒ 模型还说这一槽是空的，用户第二次点写入会撞
    //   "已经有 dataN，拒绝覆盖"，〔删除槽〕也说"本来就是空的" ⇒ **卡死**，只能重开卡/切作品。
    //   〔删除槽〕那条路一直是这么做的（见 `btn-delete`：无论成败都 refreshCardViews）。
    refreshCardViews(r.ctx);
    if (outcome.ok) {
      setStatus(outcome.persisted ?? t('写入完成', 'write complete', '書き込み完了', '쓰기 완료'), () => t('写入完成', 'write complete', '書き込み完了', '쓰기 완료'));
      toast('ok', t(`${what}成功`, `${what} succeeded`, `${what}に成功`, `${what} 성공`), outcome.persisted ?? '');
    } else if (outcome.cancelled) {
      // ★ 0.40：取消不是失败 —— 别报"被拒绝"（`cardOps.ts::WriteOutcome.cancelled`）
      setStatusPair(`${what}已取消（内存里的改动没落盘）`, `${what} cancelled (the in-memory change was not written to disk)`, `${what}をキャンセルしました（メモリ上の変更はディスクに書かれていません）`, `${what} 취소됨 (메모리의 변경 사항은 디스크에 기록되지 않았습니다)`);
    } else if (outcome.refused) {
      // ★ 0.43：**预检就被拒**时，正文已经在提示行（`#write-hint`）讲过了 ⇒ 状态行只说一句标签 +
      //   指针；日志里**没有**任何行（"预检被拒 = 没发生任何事"），所以不能说"见右侧日志"。
      //   `note()` 每次重算 ⇒ 切语言时这句话跟着一起换（`setStatus(…, redo)`）。
      const refused = (): string => t(`${what}被拒绝：${outcome.refused!.note()}`, `${what} was refused: ${outcome.refused!.note()}`, `${what}が拒否されました：${outcome.refused!.note()}`, `${what}이(가) 거부되었습니다: ${outcome.refused!.note()}`);
      setStatus(refused(), refused);
    } else {
      setStatusPair(`${what}被拒绝（见右侧日志）`, `${what} was refused (see the log on the right)`, `${what}を拒否しました（右のログを参照）`, `${what} 거부됨 (오른쪽 로그를 보세요)`);
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
type Pcsx2Route = 'none' | 'picker' | 'input' | 'drop' | 'auto';

/**
 * `Pcsx2Route` ⇒ 界面那一行「本次来源：…」的文案（**中文原文 + 英文紧跟**）。
 *
 * ★ 值本身是**语言无关的代号**：切语言时 `relayoutForLang()` 会重跑 `renderPcsx2()`，
 *   由这里按当前语言重新取一次文案 —— 否则那一行会停在切语言之前的语言。
 *   ⚠ `'目录选择框'` / `'未提供'` 这些中文原文必须留在这里的 `t()` 第一参数里
 *   （`ui.test.ts` 分节 k3 直接拿源码断言它们在）。
 */
function pcsx2RouteText(route: Pcsx2Route): string {
  if (route === 'picker') return t('目录选择框', 'folder picker', 'フォルダ選択ダイアログ', '폴더 선택기');
  if (route === 'input') return t('目录输入框', 'the folder input box', 'フォルダの入力欄', '폴더 입력란');
  if (route === 'drop') return t('拖入文件', 'dropped files', 'ドラッグ＆ドロップされたファイル', '드래그 앤 드롭한 파일');
  if (route === 'auto') return t('自动（记住的目录）', 'the remembered folder (automatic)', '自動（記憶されたフォルダ）', '자동 (기억된 폴더)');
  return t('未提供', 'not provided', '未指定', '제공되지 않음');
}

let pcsx2Files: IniFileLike[] = [];
let pcsx2Route: Pcsx2Route = 'none';

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
    btn.textContent = open ? t('收起', 'Collapse', '折りたたむ', '접기') : t('展开', 'Expand', '展開', '펼치기');
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
      toast('warn', t(`读不了 ${f.name}`, `Cannot read ${f.name}`, `${f.name} を読み込めません`, `${f.name}을(를) 읽을 수 없습니다`), e instanceof Error ? e.message : String(e));
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
      t('这个目录里没有找到 PCSX2 的自检文件', 'No PCSX2 check files found in this folder', 'このフォルダには PCSX2 のチェック用ファイルが見つかりません', '이 폴더에서 PCSX2 점검 파일을 찾지 못했습니다'),
      describeFoundFiles(list.map((f) => f.webkitRelativePath || f.name)),
    );
    return 0;
  }
  toast(
    'ok',
    t(`读到 ${out.length} 个文件（${pcsx2RouteText(route)}）`, `Read ${out.length} files (${pcsx2RouteText(route)})`, `${out.length} 個のファイルを読み込みました（${pcsx2RouteText(route)}）`, `${out.length}개 파일을 읽었습니다 (${pcsx2RouteText(route)})`),
    describeFoundFiles(out.map((f) => f.name)) +
      (cls.skippedTooBig.length ? t(`；跳过 ${cls.skippedTooBig.length} 个超过 4 MiB 的文件（memcards 那些用不到）`, `; skipped ${cls.skippedTooBig.length} files over 4 MiB (the memcards ones are not needed)`, `；4 MiB を超える ${cls.skippedTooBig.length} 個のファイルをスキップしました（memcards 内のものは不要）`, `; 4 MiB를 초과하는 ${cls.skippedTooBig.length}개 파일을 건너뛰었습니다 (memcards 안의 파일은 필요 없음)`) : ''),
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
    req.onerror = () => rej(req.error ?? new Error(t('indexedDB.open 失败', 'indexedDB.open failed', 'indexedDB.open に失敗', 'indexedDB.open 실패')));
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
      tx.onerror = () => rej(tx.error ?? new Error(t('写入 IndexedDB 失败', 'Failed to write to IndexedDB', 'IndexedDB への書き込みに失敗', 'IndexedDB 쓰기 실패')));
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
      req.onerror = () => rej(req.error ?? new Error(t('读取 IndexedDB 失败', 'Failed to read from IndexedDB', 'IndexedDB からの読み取りに失敗', 'IndexedDB 읽기 실패')));
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
    const n = await readFromDirectoryHandle(handle, 'auto');
    if (n > 0) {
      toast(
        'info',
        t(`已自动读取记住的 PCSX2 目录（${handle.name}，${n} 个文件）`, `Automatically read the remembered PCSX2 folder (${handle.name}, ${n} files)`, `記憶された PCSX2 フォルダを自動で読み込みました（${handle.name}、${n} 個のファイル）`, `기억된 PCSX2 폴더를 자동으로 읽었습니다 (${handle.name}, ${n}개 파일)`),
        t('结论见页面最下面那块；想换目录就点「选择 PCSX2 目录」。', 'The result is in the panel at the bottom of the page; to change the folder, click "Choose PCSX2 folder".', '結論はページ最下部のパネルにあります。フォルダを変える場合は「PCSX2 フォルダを選択」をクリックしてください。', '결론은 페이지 맨 아래 패널에 있습니다. 폴더를 바꾸려면 "PCSX2 폴더 선택"을 클릭하세요.'),
      );
    }
  } catch {
    /* 句柄失效（目录被删/改名）⇒ 静默放弃，用户点一次就好 */
  }
}

/** 主路径：点一次目录选择框（`id` 让 Chrome 记住上次位置）。 */
async function pickPcsx2Dir(): Promise<void> {
  const w = pickerWindow();
  if (typeof w.showDirectoryPicker !== 'function') {
    toast(
      'info',
      t('这个浏览器没有「目录选择框」，已切到兜底方式', 'This browser has no folder picker — switched to the fallback', 'このブラウザーにはフォルダ選択ダイアログがないため、代替方式に切り替えました', '이 브라우저에는 폴더 선택기가 없어 대체 방식으로 전환했습니다'),
      t('请在弹出的目录输入框里选 C:\\Users\\M\\Documents\\PCSX2。', 'Pick C:\\Users\\M\\Documents\\PCSX2 in the folder input box that just opened.', '開いたフォルダ入力欄で C:\\Users\\M\\Documents\\PCSX2 を選んでください。', '열린 폴더 입력란에서 C:\\Users\\M\\Documents\\PCSX2를 선택하세요.'),
    );
    openPcsx2DirInput();
    return;
  }
  await guard(t('读取 PCSX2 目录', 'Read PCSX2 folder', 'PCSX2 フォルダを読み込む', 'PCSX2 폴더 읽기'), async () => {
    let dir: FileSystemDirectoryHandle;
    try {
      dir = await w.showDirectoryPicker!({ id: 'pcsx2', mode: 'read', startIn: 'documents' });
    } catch (e) {
      if (isAbort(e)) {
        setStatusPair('已取消选择 PCSX2 目录。', 'Cancelled PCSX2 folder selection.', 'PCSX2 フォルダの選択をキャンセルしました。', 'PCSX2 폴더 선택을 취소했습니다.');
        return;
      }
      // ★ SecurityError / NotAllowedError 等 ⇒ **自动**切兜底，不报错卡住
      toast(
        'warn',
        t('「目录选择框」在这个环境里不可用，已自动切到兜底方式', 'The folder picker is not available in this environment — switched to the fallback automatically', 'この環境ではフォルダ選択ダイアログが使えないため、自動で代替方式に切り替えました', '이 환경에서는 폴더 선택기를 사용할 수 없어 자동으로 대체 방식으로 전환했습니다'),
        t(
          `${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}\n请在弹出的目录输入框里选 C:\\Users\\M\\Documents\\PCSX2。`,
          `${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}\nPick C:\\Users\\M\\Documents\\PCSX2 in the folder input box that just opened.`, `${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}n開いたフォルダ入力欄で C:\\Users\\M\\Documents\\PCSX2 を選んでください。`, `${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}n열린 폴더 입력란에서 C:\\Users\\M\\Documents\\PCSX2를 선택하세요.`,
        ),
      );
      openPcsx2DirInput();
      return;
    }
    const n = await readFromDirectoryHandle(dir, 'picker');
    if (n === 0) {
      toast(
        'warn',
        t('这个目录里没找到 PCSX2 的自检文件', 'No PCSX2 check files found in this folder', 'このフォルダには PCSX2 のチェック用ファイルが見つかりません', '이 폴더에서 PCSX2 점검 파일을 찾지 못했습니다'),
        t('期望含 inis\\PCSX2.ini、gamesettings\\*.ini、logs\\emulog.txt。', 'Expected inis\\PCSX2.ini, gamesettings\\*.ini, logs\\emulog.txt.', 'inis\\PCSX2.ini、gamesettings\\*.ini、logs\\emulog.txt が必要です。', 'inis\\PCSX2.ini, gamesettings\\*.ini, logs\\emulog.txt가 필요합니다.'),
      );
      return;
    }
    await rememberPcsx2Handle(dir);
    // ★ 0.30：记住了这个目录 ⇒ 顺手把 `memcards` 子目录的句柄也备好（下次〔选择记忆卡〕直接开在那儿）
    void refreshMemcardsHandle(dir);
    toast('ok', t(`读了 ${n} 个文件（目录选择框）`, `Read ${n} files (folder picker)`, `${n} 個のファイルを読み込みました（フォルダ選択ダイアログ）`, `${n}개 파일을 읽었습니다 (폴더 선택기)`), describeFoundFiles(pcsx2Files.map((f) => f.name)));
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
      await setPcsx2Files(collected, 'drop');
      return;
    }
  }
  // ② 拿不到 entry（旧浏览器）⇒ 就用 dt.files（拖三个文件时是够的）
  const files = Array.from(dt.files ?? []);
  if (files.length) {
    await setPcsx2Files(files, 'drop');
    return;
  }
  toast(
    'warn',
    t('没收到任何文件', 'No files received', 'ファイルを受け取れませんでした', '받은 파일이 없습니다'),
    t('请拖 inis\\PCSX2.ini、gamesettings\\*.ini、logs\\emulog.txt，或整个 PCSX2 目录。', 'Drop inis\\PCSX2.ini, gamesettings\\*.ini, logs\\emulog.txt, or the whole PCSX2 folder.', 'inis\\PCSX2.ini、gamesettings\\*.ini、logs\\emulog.txt、または PCSX2 フォルダ全体をドラッグ＆ドロップしてください。', 'inis\\PCSX2.ini, gamesettings\\*.ini, logs\\emulog.txt 또는 PCSX2 폴더 전체를 드래그 앤 드롭하세요.'),
  );
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
      el('b', { text: t('PCSX2 默认目录：', 'Default PCSX2 folder:', 'PCSX2 のデフォルトフォルダ：', 'PCSX2 기본 폴더:') }),
      el('code', { text: DEFAULT_PCSX2_DIR })),
  );

  const route = $('pcsx2-route');
  clear(route);
  route.textContent = t('本次来源：', 'Source: ', '今回の取得元：', '이번 출처: ') + pcsx2RouteText(pcsx2Route);

  const report = analyzePcsx2({ files: pcsx2Files });
  // ★ 2026-10-05（0.10）：顶栏那行"PCSX2 自检：<摘要>"已按用户要求删除 ⇒ 这里不再写摘要。
  //   结论仍然完整地出现在**本面板**里（下面的结论表 + 冲突红字）。

  if (report.recognized.length === 0) {
    host.appendChild(
      el('div', { class: 'pcsx2-help' },
        el('div', { class: 'pcsx2-help-title', text: t('这块面板是干什么的？', 'What is this panel for?', 'このパネルは何のため？', '이 패널은 무엇을 위한 것인가요?') }),
        el('div', {
          class: 'pcsx2-help-body',
          text: t(
            '你在 PCSX2「设置 → 记忆卡插槽」里选的那张卡，不一定是游戏真正读的那张 —— ' +
              'PCSX2 还有一层「每游戏设置」（文件在 gamesettings\\<序列号>_<CRC>.ini），' +
              '它会盖掉全局设置。我们就因为这个白排查过一轮：对话框里写着 A，游戏实际读的是 B。',
            'The card you picked in PCSX2 "Settings → Memory card slots" is not necessarily the card the game actually reads — ' +
              'PCSX2 has one more layer, the per-game settings (the file is gamesettings\\<serial>_<CRC>.ini), ' +
              'which overrides the global settings. That is exactly what cost us a round of blind debugging: the dialog said A, but the game actually read B.', `PCSX2 の「設定 → メモリーカードスロット」で選んだカードが、ゲームが実際に読むカードとは限りません —— PCSX2 にはもう一層「ゲームごとの設定」（ファイルは gamesettings\\\\<シリアル>_<CRC>.ini）があり、それがグローバル設定を上書きします。これで一度空振りしたことがあります：ダイアログには A と書いてあるのに、ゲームが実際に読んでいたのは B でした。`, `PCSX2의 "설정 → 메모리 카드 슬롯"에서 고른 카드가 게임이 실제로 읽는 카드가 아닐 수 있습니다 —— PCSX2에는 "게임별 설정"이라는 층이 하나 더 있고(파일은 gamesettings\\\\<시리얼>_<CRC>.ini), 이것이 전역 설정을 덮어씁니다. 그래서 한 번 헛짚었습니다: 대화상자에는 A라고 되어 있는데 게임이 실제로 읽은 것은 B였습니다.`,
          ),
        }),
        el('div', { class: 'pcsx2-help-body' },
          el('b', { text: t('什么时候该看它：', 'When to look at it:', 'いつ見るべきか：', '언제 확인해야 하나:') }),
          el('span', { text: t('写卡前 / 进游戏前 —— 确认你要写的那张卡，就是游戏会读的那张。', 'Before writing / before starting the game — confirm that the card you are about to write is the one the game will read.', '書き込み前 / ゲーム起動前 —— 書き込もうとしているカードが、ゲームが読み込むカードであることを確認してください。', '쓰기 전 / 게임 실행 전 —— 쓰려는 카드가 게임이 읽을 카드인지 확인하세요.') }),
        ),
        el('div', { class: 'pcsx2-help-body' },
          el('b', { text: t('怎么用（三种，任选一种）：', 'How to use it (three ways, pick any one):', '使い方（3 通り、どれか 1 つ）：', '사용 방법 (3가지 중 하나):') }),
          el('span', {
            text: t(
              '① 点上面的「选择 PCSX2 目录」选一次 ' + DEFAULT_PCSX2_DIR + '（一次就够，之后 Chrome 会记住）；' +
                '② 这个浏览器没有目录选择框时，用「用目录输入框选」；' +
                '③ 或者把 inis\\PCSX2.ini、gamesettings\\*.ini、logs\\emulog.txt（也可以整个目录）拖到上面那条虚线上。' +
                '全程只读，不写任何文件。',
              '① Click "Choose PCSX2 folder" above and pick ' + DEFAULT_PCSX2_DIR + ' once (once is enough, Chrome remembers it); ' +
                '② if this browser has no folder picker, use "Pick folder via input"; ' +
                '③ or drag inis\\PCSX2.ini, gamesettings\\*.ini, logs\\emulog.txt (or the whole folder) onto the dashed line above. ' +
                'Read-only throughout: no file is ever written.', `① 上の「PCSX2 フォルダを選択」を一度押して ${DEFAULT_PCSX2_DIR} を選びます（一度で十分、以後は Chrome が覚えます）；② このブラウザにフォルダ選択ダイアログがない場合は「フォルダ入力欄で選ぶ」を使います；③ または inis\\\\PCSX2.ini、gamesettings\\\\*.ini、logs\\\\emulog.txt（フォルダごとでも可）を上の点線にドラッグします。全体を通して読み取り専用で、ファイルは書き換えません。`, `① 위의 "PCSX2 폴더 선택"을 눌러 ${DEFAULT_PCSX2_DIR} 를 한 번 고릅니다(한 번이면 충분하고, 이후에는 Chrome이 기억합니다); ② 이 브라우저에 폴더 선택기가 없으면 "폴더 입력란으로 선택"을 사용합니다; ③ 또는 inis\\\\PCSX2.ini, gamesettings\\\\*.ini, logs\\\\emulog.txt(폴더 전체도 가능)를 위 점선 위로 끌어다 놓습니다. 처음부터 끝까지 읽기 전용이며 파일을 쓰지 않습니다.`,
            ),
          }),
        ),
        el('div', { class: 'pcsx2-help-body' },
          el('b', { text: t('结论怎么读：', 'How to read the result:', '結論の読み方：', '결론 읽는 법:') }),
          el('span', {
            text: t(
              '下面会列一张小表：Slot 1 / Slot 2 实际会读哪张卡，以及这个结论的来源' +
                '（「全局设置」还是「★每游戏覆盖」）。' +
                '如果对话框里的卡和实际会读的卡不一样，会用红字告诉你"游戏读到的是 X，不是你选的那张"。',
              'The small table below lists which card Slot 1 / Slot 2 actually reads, and where that conclusion comes from ' +
                '(the global settings, or the ★ per-game override). ' +
                'If the card in the dialog differs from the card actually read, the line tells you in red: "the game reads X, not the card you picked".', `下の小さな表に、Slot 1 / Slot 2 が実際にどのカードを読むか、そしてその結論の出どころ（「グローバル設定」か「★ゲームごとの上書き」）を出します。ダイアログのカードと実際に読むカードが違う場合は、赤字で「ゲームが読むのは X で、選んだカードではない」と伝えます。`, `아래 작은 표에 Slot 1 / Slot 2 가 실제로 어느 카드를 읽는지, 그리고 그 결론의 출처("전역 설정"인지 "★게임별 덮어쓰기"인지)를 보여 줍니다. 대화상자의 카드와 실제로 읽는 카드가 다르면 빨간 글씨로 "게임이 읽는 것은 X이며, 고른 카드가 아닙니다"라고 알려 줍니다.`,
            ),
          }),
        ),
      ),
    );
    return;
  }

  host.appendChild(el('div', { class: 'dim', text: t('认出来的文件：', 'Recognized files: ', '認識されたファイル：', '인식된 파일: ') + report.recognized.join('　') }));
  for (const w of report.warnings) host.appendChild(el('div', { class: 'bad', text: w }));
  for (const n of report.notes) host.appendChild(el('div', { class: 'dim', text: n }));

  const table = el('table', { class: 'pcsx2-table' });
  table.appendChild(
    el('tr', null,
      el('th', { text: t('界面槽', 'UI slot', 'UI スロット', 'UI 슬롯') }),
      el('th', { text: t('日志里叫', 'Called in the log', 'ログ上の名称', '로그에서의 이름') }),
      el('th', { text: t('实际会读的卡', 'Card actually read', '実際に読み込まれるカード', '실제로 읽는 카드') }),
      el('th', { text: t('结论来源', 'Where the conclusion comes from', '結論の根拠', '결론의 근거') }),
      el('th', { text: t('上次实际挂载', 'Last actual mount', '前回の実際のマウント', '지난번 실제 마운트') })),
  );
  for (const e of report.effective) {
    const slot = e.slot;
    const mcd = MCD_SLOT_OF[slot];
    const actual = report.actualMounts.find((m) => m.slot === slot);
    table.appendChild(
      el('tr', { class: e.source === 'game' ? 'row-warn' : '' },
        el('td', { text: `Slot ${slot}` }),
        el('td', { text: `McdSlot ${mcd}` }),
        el('td', { text: e.fileName || t('(空)', '(empty)', '（空）', '(없음)') }),
        el('td', {
          text: e.source === 'game'
            ? t(`★每游戏覆盖（${e.sourceFile} 盖掉了全局设置）`, `★ per-game override (${e.sourceFile} overrides the global settings)`, `★ ゲームごとの上書き（${e.sourceFile} がグローバル設定を上書き）`, `★ 게임별 덮어쓰기 (${e.sourceFile}이(가) 전역 설정을 덮어씀)`)
            : e.source === 'global'
              ? t('全局设置（inis\\PCSX2.ini）', 'Global settings (inis\\PCSX2.ini)', 'グローバル設定（inis\\PCSX2.ini）', '전역 설정 (inis\\PCSX2.ini)')
              : t('未设置', 'not set', '未設定', '설정 안 됨'),
        }),
        el('td', {
          class: actual && actual.differs ? 'bad' : 'ok',
          text: actual
            ? t(`${actual.fileName}${actual.differs ? '（与上面的推断不同）' : ''}`, `${actual.fileName}${actual.differs ? ' (differs from the inference above)' : ''}`, `${actual.fileName}${actual.differs ? '（上記の推定と異なります）' : ''}`, `${actual.fileName}${actual.differs ? ' (위의 추정과 다름)' : ''}`)
            : t('（日志里没有）', '(not in the log)', '（ログにありません）', '(로그에 없음)'),
        })),
    );
  }
  host.appendChild(table);
  if (report.conflicts.length === 0) {
    host.appendChild(el('div', { class: 'ok', text: t('✅ 没有「每游戏覆盖 vs 全局」冲突 —— 对话框里选的那张就是游戏会读的那张。', '✅ No per-game-vs-global conflict — the card picked in the dialog is the one the game reads.', '✅ 「ゲームごとの上書き vs グローバル」の競合はありません —— ダイアログで選んだカードが、ゲームが読み込むカードです。', '✅ "게임별 덮어쓰기 vs 전역" 충돌이 없습니다 —— 대화상자에서 선택한 카드가 게임이 읽는 카드입니다.') }));
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
    // ★ 0.41：写入进行中不许换卡（否则计划与落盘可能不是同一张卡）
    if (blockedWhileBusy(t('拖入记忆卡：等这一步写完再来。', 'Dropping a memory card: wait until this write finishes.', 'メモリーカードのドラッグ＆ドロップ：この書き込みが終わってからにしてください。', '메모리 카드 드래그 앤 드롭: 이 쓰기가 끝난 뒤에 하세요.'))) return;
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
    // ★ 0.41（审查抓到）：这一路原来**不传 `lastSeen`** ⇒ 首次写入跳过"写前查磁盘被改过"那道闸门
    //   （只能等 `createWritable()` 抛 InvalidStateError 兜）。既然手里有 File，就把它一起传下去
    //   —— 与〔选择记忆卡〕那条路（`openCardViaPicker()`）口径一致。
    const consumed = await openCardFromBytes(f.name, bytes, handle, { mtime: f.lastModified, size: f.size });
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
  // ★ 0.41：写入进行中不许换图（否则预览是新图、日志报告"旧图写成功"—— 0.19 D8 就是为这个禁的按钮）
  if (files.length && blockedWhileBusy(t('拖入图片：等这一步写完再来。', 'Dropping an image: wait until this write finishes.', '画像のドラッグ＆ドロップ：この書き込みが終わってからにしてください。', '이미지 드래그 앤 드롭: 이 쓰기가 끝난 뒤에 하세요.'))) return;
  const rejected = Array.from(dt.files).filter((f) => !files.includes(f));
  for (const f of rejected) {
    toast(
      'warn',
      t(`不接受 ${f.name}`, `Rejected ${f.name}`, `${f.name} は受け付けません`, `${f.name}은(는) 지원하지 않습니다`),
      t('PSD / TIFF / 多页 RAW 请先导出 PNG（SPEC.md §五：不做格式猜测）。', 'Export PSD / TIFF / multi-page RAW to PNG first (SPEC.md §5: no format guessing).', 'PSD / TIFF / 複数ページ RAW は先に PNG に書き出してください（SPEC.md §5：形式の推測は行いません）。', 'PSD / TIFF / 다중 페이지 RAW는 먼저 PNG로 내보내세요 (SPEC.md §5: 형식을 추측하지 않음).'),
    );
  }
  if (files.length) await loadImageFromBlob(files[0], files[0].name);
}

function installPaste(): void {
  window.addEventListener('paste', (ev) => {
    const dt = (ev as ClipboardEvent).clipboardData;
    if (!dt) return;
    // ★ 0.41：写入进行中不许粘贴换图（与拖入同一条规矩）
    if (blockedWhileBusy(t('粘贴图片：等这一步写完再来。', 'Pasting an image: wait until this write finishes.', '画像の貼り付け：この書き込みが終わってからにしてください。', '이미지 붙여넣기: 이 쓰기가 끝난 뒤에 하세요.'))) return;
    const files = Array.from(dt.files ?? []);
    const img = files.find((f) => /^image\//.test(f.type));
    if (img) {
      // ★ 0.40：只传**原文件名** + `clipboard: true`（前缀在渲染时按语言拼，别在这里 t()）
      void loadImageFromBlob(img, img.name, { clipboard: true });
      ev.preventDefault();
      return;
    }
    const items = Array.from(dt.items ?? []);
    const it = items.find((i) => i.type.startsWith('image/'));
    if (it) {
      const f = it.getAsFile();
      if (f) {
        // ★ 0.40：这条路的图**没有文件名**（截图直接粘的就是一个匿名 blob）⇒ 名字留空，
        //   由 `renderOriginalBadge()` 拼成"剪贴板 · image"（按当前语言）
        void loadImageFromBlob(f, '', { clipboard: true });
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
    // ★ 0.41：写入进行中不许换卡（这条是只读兜底入口，同样会换掉 `state.card`）
    if (f && !blockedWhileBusy(t('换记忆卡：等这一步写完再来。', 'Switching memory cards: wait until this write finishes.', 'メモリーカードの切り替え：この書き込みが終わってからにしてください。', '메모리 카드 교체: 이 쓰기가 끝난 뒤에 하세요.'))) {
      void guard(t('读记忆卡', 'Read memory card', 'メモリーカードを読み込む', '메모리 카드 읽기'), () => openCardViaInput(f));
    }
  });

  $('btn-image-open').addEventListener('click', () => void pickImageFile());
  ($('image-input') as HTMLInputElement).addEventListener('change', (ev) => {
    const f = (ev.target as HTMLInputElement).files?.[0];
    if (f && !blockedWhileBusy(t('换图片：等这一步写完再来。', 'Switching images: wait until this write finishes.', '画像の切り替え：この書き込みが終わってからにしてください。', '이미지 교체: 이 쓰기가 끝난 뒤에 하세요.'))) {
      void loadImageFromBlob(f, f.name);
    }
  });

  $('game-select').addEventListener('change', () => onGameChanged());
  ($('custom-serial') as HTMLInputElement).addEventListener('change', () => onGameChanged());

  $('btn-write').addEventListener('click', () => void doWrite(state.selectedSlot, t('写入选中槽', 'Write to selected slot', '選択スロットに書き込み', '선택한 슬롯에 쓰기')));

  $('btn-export-png').addEventListener('click', () => {
    void guard(t('导出 PNG', 'Export PNG', 'PNG 書き出し', 'PNG 내보내기'), async () => {
      const p = state.prepared;
      if (!p) {
        toast('warn', t('还没有可导出的图', 'No image to export yet', '書き出せる画像がまだありません', '내보낼 이미지가 아직 없습니다'), t('先导入一张图。', 'Import an image first.', '先に画像を読み込んでください。', '먼저 이미지를 불러오세요.'));
        return;
      }
      await exportPng(p.rgba, p.width, p.height, `emblem_${Date.now()}.png`);
      toast('ok', t('已导出 PNG', 'PNG exported', 'PNG を書き出しました', 'PNG를 내보냈습니다'), t('导出的是游戏口径（索引 0 = 透明）。', 'The export uses the game palette (index 0 = transparent).', '書き出しはゲーム側の仕様です（インデックス 0 = 透明）。', '내보내기는 게임 기준입니다 (인덱스 0 = 투명).'));
    });
  });

  // ★ 0.25（用户要求）：**删除 = 删完立刻写回卡文件**。
  //   以前删除只改内存副本，然后提示"导出整卡或写入选中槽时才会落盘" ——
  //   用户的操作直觉是"删了就是删了"。现在一次做完：确认框（写明会立刻写回）→
  //   内存副本上删 → 走同一条落盘路径（含"写前查句柄有没有过期" + 覆盖后回读比对）。
  $('btn-delete').addEventListener('click', () => {
    void guard(t('删除槽', 'Delete slot', 'スロットを削除', '슬롯 삭제'), async () => {
      // ★ 0.42：删除也要落盘 ⇒ 同样在**点击那一刻**问写权限（理由见 `requestWritePermissionIfNeeded()`）
      await requestWritePermissionIfNeeded();
      const s = state.model?.slots[state.selectedSlot];
      if (!s || !s.occupied || !s.fileName) {
        toast('warn', t(`槽 ${state.selectedSlot + 1} 本来就是空的`, `Slot ${state.selectedSlot + 1} is already empty`, `スロット ${state.selectedSlot + 1} はもともと空です`, `슬롯 ${state.selectedSlot + 1}은(는) 원래 비어 있습니다`), t('没有可删的东西。', 'There is nothing to delete.', '削除するものがありません。', '삭제할 것이 없습니다.'));
        return;
      }
      setBusy(true, t('删除槽：在内存副本上删 → 立刻写回卡文件 …', 'Delete slot: delete from the in-memory copy → write back to the card file right away …', 'スロットを削除：メモリー上のコピーから削除 → すぐにカードファイルへ書き戻し …', '슬롯 삭제: 메모리 사본에서 삭제 → 즉시 카드 파일에 다시 쓰기 …'));
      try {
        const out = await deleteSlotAndSave(s.dirName, s.fileName);
        showLog(out.lines);
        // ⚠ 只要 `deleted` 为真，内存副本**一定**已经变了 ⇒ 无论如何都要重建视图，
        //   让 8 格显示内存里的真相（哪怕磁盘上还没落盘）。
        const g = currentGameContext();
        refreshCardViews(g.ok ? g.ctx : null);
        if (out.deleted && out.ok) {
          setStatusPair(`已删除并写回：${out.persisted ?? ''}`, `Deleted and written back: ${out.persisted ?? ''}`, `削除して書き戻しました：${out.persisted ?? ''}`, `삭제하고 다시 기록했습니다: ${out.persisted ?? ''}`);
          toast('ok', t('已删除，并已写回卡文件', 'Deleted, and written back to the card file', '削除し、カードファイルに書き戻しました', '삭제하고 카드 파일에 다시 썼습니다'), out.persisted ?? '');
        } else if (out.deleted) {
          setStatusPair('⚠ 内存里已删除，但没有落盘（磁盘上还是原样）—— 见右侧日志', '⚠ Deleted in memory, but it was NOT written to disk (the file on disk is unchanged) — see the log on the right', '⚠ メモリ上では削除しましたが、ディスクには書かれていません（ファイルは元のまま）—— 右のログを参照', '⚠ 메모리에서는 삭제했지만 디스크에 기록되지 않았습니다 (파일은 그대로) — 오른쪽 로그를 보세요');
          toast(
            'error',
            t('删除没落盘', 'Delete did not reach the disk', '削除がディスクに書き込まれていません', '삭제가 디스크에 반영되지 않았습니다'),
            t('内存里已经删了；磁盘上的卡一个字节都没动。按日志里的步骤重做一次。', 'It is deleted in memory; not a single byte of the card on disk changed. Redo it following the steps in the log.', 'メモリー上では削除済みですが、ディスク上のカードは 1 バイトも変わっていません。ログの手順に従ってやり直してください。', '메모리에서는 삭제되었지만 디스크의 카드는 1바이트도 바뀌지 않았습니다. 로그의 절차대로 다시 실행하세요.'),
            20_000,
          );
        } else if (out.cancelled) {
          setStatusPair('已取消删除：磁盘与内存都没动。', 'Delete cancelled: neither the disk nor memory was touched.', '削除をキャンセルしました：ディスクもメモリも変更されていません。', '삭제를 취소했습니다: 디스크와 메모리 모두 변경되지 않았습니다.');
        } else {
          setStatusPair('删除失败（见右侧日志）', 'Delete failed (see the log on the right)', '削除に失敗しました（右のログを参照）', '삭제 실패 (오른쪽 로그를 보세요)');
        }
      } finally {
        setBusy(false);
        renderStatus();
      }
    });
  });

  // ★ 0.26：〔另存为〕—— 把内存里这张卡另存成一份记忆卡文件（`showSaveFilePicker` 选位置/名字，
  //   拿不到那个对话框时退化成下载）。原名〔导出整卡〕。
  //   ⚠ 0.21 修过的坑：这里**只许挂一个**监听（当时重复挂过两段 ⇒ 点一次下载两次）。
  $('btn-save-as').addEventListener('click', () => void guard(t('另存为', 'Save card as', '名前を付けて保存', '다른 이름으로 저장'), () => saveCardAs()));

  // ★ 0.37（用户）：〔看目录项（调试）〕**开关化** —— "点开以后再点一下没法收回去，这一点要修复"。
  //   判据：第二次点必须把日志框收起来（`#write-log` 的 `hidden` 变 true），而不是重画同一份内容。
  $('btn-debug').addEventListener('click', () => {
    if (dirDebugLines) {
      // 框里就是目录项 ⇒ 再点 = 收起（`renderLog([])` 会隐藏整个框）
      dirDebugLines = null;
      renderLog([]);
      return;
    }
    const model = state.model;
    if (!model) {
      toast('warn', t('还没有打开记忆卡', 'No memory card loaded yet', 'まだメモリーカードを開いていません', '아직 메모리 카드를 열지 않았습니다'), '');
      return;
    }
    const dir = model.dirNames[0];
    const txt = dir ? direntDebug(dir) : t('（卡上没有徽章目录）', '(no emblem folder on the card)', '（カードにエンブレムフォルダがありません）', '(카드에 엠블럼 폴더가 없음)');
    dirDebugLines = [t(`── ${dir ?? '(无)'} 的目录项 ──`, `── directory entries of ${dir ?? '(none)'} ──`, `── ${dir ?? '(なし)'} のディレクトリエントリ ──`, `── ${dir ?? '(없음)'}의 디렉터리 엔트리 ──`), ...txt.split('\n')];
    renderLog(dirDebugLines);
  });

  $('btn-pcsx2-dir').addEventListener('click', () => void pickPcsx2Dir());
  $('btn-pcsx2-input').addEventListener('click', () => openPcsx2DirInput());
  $('pcsx2-dir-input').addEventListener('change', (ev) => {
    const files = Array.from((ev.target as HTMLInputElement).files ?? []);
    if (!files.length) return;
    void guard(t('读 PCSX2 目录', 'Read PCSX2 folder', 'PCSX2 フォルダを読み込む', 'PCSX2 폴더 읽기'), () => setPcsx2Files(files, 'input'));
  });
  $('btn-pcsx2-clear').addEventListener('click', () => {
    pcsx2Files = [];
    pcsx2Route = 'none';
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

  // ★ 0.28：**语言必须最先定** —— 它决定后面每一次渲染用哪套文案（静态外壳由
  //   `applyStaticI18n()` 按 `[data-en]` 刷，JS 生成的那部分读 `t()`）。
  //   `persist: false`：自动判定**不写** localStorage，只有用户手动切才记（见 logic/i18n.ts 文件头）。
  setLang(detectLang(), { persist: false });
  onLangChange(relayoutForLang);
  fillLangSelect();
  $('lang-select').addEventListener('change', () => {
    const v = ($('lang-select') as HTMLSelectElement).value;
    // ★ 0.41：写入进行中不许切语言 —— `relayoutForLang()` 会重读 8 张缩略图、重画一堆面板，
    //   和正在跑的写入抢同一份状态（而且它会把状态行那条"写入中…"改掉）。
    if (blockedWhileBusy(t('切换语言：等这一步写完再来。', 'Switching language: wait until this write finishes.', '言語の切り替え：この書き込みが終わってからにしてください。', '언어 전환: 이 쓰기가 끝난 뒤에 하세요.'))) {
      fillLangSelect(); // 把下拉拨回当前语言（视觉上别骗人）
      return;
    }
    // ★ 0.47：四语之后不能再用 `v === 'en' ? 'en' : 'zh'`（选日本語/한국어 会被打成中文）
    //   ⇒ 用 `isLang()` 收口，非四值之一就退回中文。
    setLang(isLang(v) ? v : 'zh');
  });

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
  showModal(() => ({
    title: t('⚠ 本项目未经过完整测试', '⚠ This project has not been fully tested', '⚠ このプロジェクトは十分なテストを行っていません', '⚠ 이 프로젝트는 충분히 테스트되지 않았습니다'),
    body: t(
      '这个徽章工具还在开发中：没有经过完整的实机验证，写卡 / 删除 / 新建槽这几条路都只验证过一部分，' +
        '任何一次写入都有可能把你的记忆卡改坏。\n\n' +
        '请先自己备份记忆卡：把 memcards\\ 里的 .ps2 复制一份到别处，再开始操作。\n\n' +
        '另一条硬规矩：写卡前先完全退出 PCSX2。它手里有一份卡，退出时会把那份写回文件，' +
        '你在工具里写进去的东西会被它覆盖掉。',
      'This emblem tool is still in development. It has not been fully verified on real hardware: ' +
        'writing, deleting and creating slots have only been partly tested, and any write can corrupt your memory card.\n\n' +
        'Please back up your memory card first: copy the .ps2 in memcards\\ somewhere else before you start.\n\n' +
        'One more hard rule: fully exit PCSX2 before writing. It keeps its own copy of the card and writes it back on exit, ' +
        'which would overwrite whatever you wrote here.', `このエンブレムツールはまだ開発中です：実機での完全な検証は済んでおらず、書き込み / 削除 / 新規スロットの各経路は一部しか検証していません。どの書き込みでもメモリーカードを壊す可能性があります。\\n\\nまず自分でメモリーカードをバックアップしてください：memcards\\\\ にある .ps2 を別の場所にコピーしてから操作を始めてください。\\n\\nもう一つの固い決まり：書き込みの前に PCSX2 を完全に終了してください。PCSX2 はカードのコピーを保持していて、終了時にそれをファイルに書き戻すため、ここで書いた内容が上書きされます。`, `이 엠블럼 도구는 아직 개발 중입니다: 실기에서 완전히 검증되지 않았고, 쓰기 / 삭제 / 새 슬롯 경로는 일부만 검증했습니다. 어떤 쓰기든 메모리 카드를 망가뜨릴 수 있습니다.\\n\\n먼저 직접 메모리 카드를 백업하세요: memcards\\\\ 안의 .ps2 를 다른 곳에 복사한 뒤 작업을 시작하세요.\\n\\n또 하나의 단단한 규칙: 쓰기 전에 PCSX2를 완전히 종료하세요. PCSX2는 카드 사본을 들고 있다가 종료할 때 파일로 되쓰기 때문에, 여기서 쓴 내용이 덮어써집니다.`,
    ),
    ok: t('我已知晓，并会自行备份记忆卡', 'I understand, and will back up my memory card myself', '理解しました。メモリーカードは自分でバックアップします', '이해했으며, 메모리 카드는 직접 백업하겠습니다'),
  }));

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

  // ★ 0.39：作品那一段的文字统一由 `renderGameBlock()` 产出（它与切作品、切语言走同一条路）
  renderGameBlock();
  renderSlots(null, { onSelect: selectSlot });
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
  setStatus(READY_TEXT());
  renderStatus();

  // ★ 上次记住的 PCSX2 目录若权限还在，就**静默自动读一遍**（不弹权限框；弹框必须由用户点击触发）
  void autoReadPcsx2IfRemembered();
  // ★ 0.30：备好 `memcards` 的目录句柄（给〔选择记忆卡〕当 `startIn` 用；拿不到就开在"文档"）。
  //   ⚠ 这里**不会**弹任何权限框：先 `queryPermission`，不是 granted 就直接放弃。
  void refreshMemcardsHandle();

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
      // ★ 0.28：F12 里可以直接切语言核对（`EmblemToolCore.ui.lang.set('en')`）
      lang: { current: currentLang, set: (l: Lang) => setLang(l) },
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
        setCropWindowSize,
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
