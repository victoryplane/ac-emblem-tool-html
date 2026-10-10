/**
 * 全局状态 —— 这个工具的全部可变状态都在这里（没有框架，所以显式一点）。
 *
 * ★ 设计约束（来自 `PORT-NOTES.md` §五 的最后一条）：
 *   **二次处理同一张图时 `rgba` 不变，但 `palette`/`indices` 的编号顺序会变**
 *   ⇒ `prepareResult` **绝不跨次复用**：每次参数改动都整份替换。
 *   下面的 `setPrepared()` 是唯一的写入点，就是为了让这条规矩看得见。
 *
 * ★ 0.19 清理：删掉了三个"只写不读"的字段（`game` / `mode` / `sourceSha`）与 `slotThumbAt()`。
 *   尤其 `sourceSha`：它每次开卡都要为整张 8 MB 卡算一遍 SHA-256，而结果从来没被读过
 *   （注释里承诺的"写卡后自证源文件没被就地改过"从未实现）。要看"源卡有没有被动过"，
 *   判据是**源文件本身**（工具永远只改内存副本，见 `card.ts` 的说明）。
 */

import type { Card } from '../core/card.ts';
import type { PrepareResult } from '../core/image.ts';
import type { SlotModel } from './logic/slots.ts';
import { cloneDefaultParams, type UiParams } from './logic/defaults.ts';
import { t } from './logic/i18n.ts';
import type { WritePermResult } from './logic/writePermission.ts';

/** 已打开的记忆卡。 */
export interface LoadedCard {
  /** 文件名（用于"已覆盖 <文件名>"提示与下载名）。 */
  fileName: string;
  /** 原始字节（**只读**，永不就地改；所有写入走 `card.buf` 的内存副本）。 */
  sourceBytes: Uint8Array;
  /** 可写的内存副本（`readCardFromBuffer` 默认已复制）。 */
  card: Card;
  /** 有写权限的句柄（`showOpenFilePicker` 拿到的）；null = 只能下载。 */
  handle: FileSystemFileHandle | null;
  /**
   * ★ 0.25：**上次看到的磁盘状态**（打开卡时记，每次成功落盘后再记）。
   *
   * 用途：落盘**之前**比一次 —— 不一样就说明"这张卡在工具读过之后又被别的进程改过"
   * （最常见就是 PCSX2），此时 `createWritable()` 会抛 `InvalidStateError`。
   * 与其写到一半炸掉、给用户一句看不懂的英文错，不如**先拒绝**并说清怎么办
   * （文案见 `logic/staleness.ts::staleFileRefusal()`）。
   * `handle` 为 null（只读打开）时这里也是 null —— 那条路只会下载，不检查。
   */
  lastSeen: { mtime: number; size: number } | null;
  /**
   * ★ 0.42：**写权限的结论**（在点击那一刻问过之后记在这里）。
   *
   * 为什么记下来：请求写权限需要 **transient user activation**，而落盘那一步是在
   * 整条管线 + 落盘确认框之后 —— 那时再问必然抛 `SecurityError`（用户实测："内存写 + 回读全过，
   * 最后报一句 SecurityError"）。所以：**点击那一刻问一次**，
   * 结果存这儿；落盘只读它。
   * `null` = 还没问过（打开卡时 / 没句柄时）。
   */
  writePerm: WritePermResult | null;
}

/** 一张缩略图（游戏口径 index0）。 */
export interface SlotThumb {
  data: Uint8ClampedArray;
  width: number;
  height: number;
  /** `verifyChecksums()` 是否 18/18。 */
  checksumsOk18: boolean;
  /** 校验失败时的明细（最多一行）。 */
  checksumDetail: string;
}

/** 已加载的原图（解码后的 RGBA）。 */
export interface SourceImage {
  data: Uint8ClampedArray;
  width: number;
  height: number;
  /**
   * 来源描述：**原文件名**（拖入 / 选择文件）或剪贴板里那张文件的名字。
   * ⚠ **不许存翻译好的文字**（0.40 的教训）：剪贴板那个前缀由 `renderOriginalBadge()` 按当前语言加，
   *   存进来的字符串一旦是中文/英文，切语言后那行就再也换不过来了。
   */
  name: string;
  /**
   * ★ 0.40：这张图是从剪贴板来的（`Ctrl+V` / 粘贴事件）。
   * 渲染时才把"剪贴板 · "这个前缀按当前语言拼上去（`pipeline.ts::renderOriginalBadge()`）。
   */
  clipboard?: boolean;
}

export interface State {
  card: LoadedCard | null;
  /** 显示器上那张"游戏预览"当前正在展示的卡（#2 或者刚改完的内存副本预览）。 */
  model: SlotModel | null;
  /** 参数（SPEC.md §五 默认值）。 */
  params: UiParams;
  /** 原图。 */
  source: SourceImage | null;
  /** 上一次的管线结果。★ 绝不缓存跨次使用（见文件头）。 */
  prepared: PrepareResult | null;
  /** 准备过程中的错误（不合规等）。 */
  prepareError: string | null;
  /** 当前选中的槽位（0..7）。 */
  selectedSlot: number;
  /** 每个槽的缩略图（下标 = 就地槽号）。 */
  thumbs: Array<SlotThumb | null>;
  /** 状态行的文本（右下角）。 */
  status: string;
  /**
   * ★ 0.40：状态行那句话的**重算办法**（切语言时用它按新语言再说一遍）。
   * `null` = 这条消息没有重算办法（切语言时会被清空，见 `setStatus()` / `relayoutStatus()`）。
   */
  statusRedo: (() => string) | null;
  /** 是否正在忙（防重入）。 */
  busy: boolean;
}

export const state: State = {
  card: null,
  model: null,
  params: cloneDefaultParams(),
  source: null,
  prepared: null,
  prepareError: null,
  selectedSlot: 0,
  thumbs: new Array(8).fill(null),
  status: '',
  statusRedo: null,
  busy: false,
};

/**
 * ★ 唯一的"写入 prepared"入口。任何地方要更新管线结果都走这里，
 *   以保证 `rgba` / `palette` / `indices` **三件套永远是同一次计算出来的**。
 */
export function setPrepared(r: PrepareResult | null, errorText: string | null): void {
  state.prepared = r;
  state.prepareError = errorText;
}

/**
 * ★ 状态行**唯一的写入点**（0.19 起连 DOM 一起写）。
 *
 * 为什么收口在这里：状态行原来要靠调用方自己再配一次 `renderStatus()`，
 * 9 处 `setStatus()` 里有 2 处忘了配（"已取消选择记忆卡/目录"）⇒ 状态行永远停在上一条文字。
 * 现在 `state.status` 与 `#status` 在同一步里更新，"忘了刷"这件事在结构上不可能发生。
 * （`renderStatus()` 仍然保留：它只负责 `#busy` 那个转圈提示与"整批重画"时的兜底。）
 *
 * ★ 0.40（审查抓到的同一类问题）：`state.status` 存的是**已经渲染好的字符串** ⇒ 切语言时
 *   它要么留在旧语言、要么只能被清掉。所以这里多收一个 `redo`：**把"这句话怎么再说一遍"
 *   一起存下来**（`() => t('中文','English')` 或 `() => 重新算一遍`），切语言时用它重说。
 *   ⚠ 传不出 `redo` 的消息（例如数据来自核心层、只有中文）切语言时会被**清空** ——
 *   宁可空着，也不要留一句旧语言的话（`relayoutStatus()`）。
 */
export function setStatus(text: string, redo?: (() => string) | null): void {
  state.status = text;
  state.statusRedo = redo ?? null;
  const node = document.getElementById('status');
  if (node) node.textContent = text;
}

/**
 * ★ 0.40：**成对文案**的状态行写法；★ 0.47 起是**四语**（`setStatusPair(zh, en, ja, ko)`）。
 *
 * 它把"四种语言的原文"都留着（`redo` 里再 `t()` 一次）⇒ 切语言时这句话能自动按新语言重说。
 * 推荐状态行一律用它（而不是 `setStatus(t(a, b, c, d))`）：后者只留下**当时那种语言**的字符串。
 * ⚠ 四个参数都要传**同一句话的四种语言**（不是"四个片段"）。
 */
export function setStatusPair(zh: string, en: string, ja: string, ko: string): void {
  setStatus(t(zh, en, ja, ko), () => t(zh, en, ja, ko));
}

/**
 * ★ 0.40：切语言时把状态行**按新语言再说一遍**。
 * 返回 `false` = 这条消息没有"重算办法"（调用方自己决定是清空还是换成"就绪"那句）。
 */
export function relayoutStatus(): boolean {
  const redo = state.statusRedo;
  if (!redo) return false;
  setStatus(redo(), redo);
  return true;
}

export function resetThumbs(): void {
  state.thumbs = new Array(8).fill(null);
}
