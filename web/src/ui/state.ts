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
  /** 来源描述（文件名 / "剪贴板" / "拖入"）。 */
  name: string;
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
 */
export function setStatus(text: string): void {
  state.status = text;
  const node = document.getElementById('status');
  if (node) node.textContent = text;
}

export function resetThumbs(): void {
  state.thumbs = new Array(8).fill(null);
}
