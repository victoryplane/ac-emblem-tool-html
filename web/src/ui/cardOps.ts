/**
 * 记忆卡操作 —— 打开 / 建模型 / 读缩略图 / ★ 写入（含自检与落盘）。
 *
 * 本文件是"核心层 ↔ 浏览器文件系统"的唯一接缝，每一处都对应一条硬规矩：
 *
 *   · `readCardFromBuffer(bytes)` **默认先复制**（`copy = true`）⇒ 写坏只坏内存副本，
 *     源文件一个字节都不动（`card.ts::readCardFromBuffer` 的注释）。
 *   · 读徽章块一律先 `saveKind()` 判档，再 `findOffset()` 切块，最后才 `verifyChecksums()`
 *     —— **不能**直接对容器调 `verifyChecksums()`（PORT-NOTES.md §二 6：它只比对 18 个
 *     校验位置、不检查文件长度，对容器会返回"true 但没意义"）。
 *   · 缩略图用 `extractImage(block, 'index0')` —— **游戏口径**（SPEC.md §五 ★）。
 *   · 写入顺序：先算块 → 在同一份内存副本上写 → **回读自检**（`logic/writeGuard.ts`）
 *     → 全过才落盘；任一项不过**拒绝写盘**（SPEC.md §八 2/3）。
 *   · 落盘前必弹确认框，文案里必须有"请先完全退出 PCSX2"（SPEC.md §三）。
 */

import {
  readCardFromBuffer,
  FAT_FREE,
} from '../core/card.ts';
import {
  KNOWN_HEADER_TAIL,
  LR_SAVE_SIZE,
  SAVE_SIZE,
  encodeEmblem,
  extractImage,
  findOffset,
  saveKind,
  verifyChecksums,
} from '../core/emblem.ts';
import type { GameContext } from './logic/games.ts';
import { resolveHeaderTail, serialFromDirName } from './logic/games.ts';
import type { SlotDirLike, SlotModel } from './logic/slots.ts';
import { buildGameSlotModel } from './logic/slots.ts';
import { planWriteTargetIn, type WritePlan, type WriteTarget } from './logic/planWrite.ts';
import { staleFileRefusal, staleHandleHint, stampChanged } from './logic/staleness.ts';
import { t } from './logic/i18n.ts';
import { confirmWriteMessage, verifyWrite } from './logic/writeGuard.ts';
import { resetThumbs, state, type SlotThumb } from './state.ts';
import { toast } from './dom.ts';
import { hex, humanBytes } from './logic/format.ts';

// --------------------------------------------------------------------------
// 打开卡
// --------------------------------------------------------------------------

export interface OpenCardResult {
  ok: boolean;
  error?: string;
}

/** 从字节建卡（`bytes` 会被复制一份，源字节不受影响）。 */
export async function openCardFromBytes(
  name: string,
  bytes: Uint8Array,
  handle: FileSystemFileHandle | null,
  /** ★ 0.25：选卡那一刻的文件状态（句柄路径才有）。写前会拿它比对，见 `logic/staleness.ts`。 */
  lastSeen: { mtime: number; size: number } | null = null,
): Promise<OpenCardResult> {
  try {
    // ★ copy = true（默认）：写坏只坏内存副本，源文件一个字节都不动
    const card = readCardFromBuffer(bytes, true);
    state.card = {
      fileName: name,
      sourceBytes: bytes,
      card,
      handle,
      lastSeen,
    };
    resetThumbs();
    toast(
      'ok',
      handle
        ? t('已打开记忆卡（保存时可直接覆盖原文件）', 'Memory card opened (saving can overwrite the original file)')
        : t('已打开记忆卡（只读：保存时只能下载）', 'Memory card opened (read-only: saving offers download only)'),
      t(
        `${name} · ${humanBytes(bytes.length)} · ${card.npages} 页 · 簇 ${card.clusters}`,
        `${name} · ${humanBytes(bytes.length)} · ${card.npages} pages · ${card.clusters} clusters`,
      ),
    );
    return { ok: true };
  } catch (e) {
    state.card = null;
    const msg = e instanceof Error ? e.message : String(e);
    toast('error', t('这个文件不是 PS2 记忆卡', 'This file is not a PS2 memory card'), msg);
    return { ok: false, error: msg };
  }
}

// --------------------------------------------------------------------------
// 模型
// --------------------------------------------------------------------------

/**
 * 卡上**所有**徽章目录名（`E##` / `EMB`，**不过滤作品**）。
 *
 * 唯一调用者 `planWriteTarget()` 拿它区分"卡上真没有这个目录"与"有、但不属于当前作品"。
 * ★ 0.27（用户删了顶栏那段整卡目录清单）：原先叫 `scanCard()`，还返回 count / chain /
 *   isLrArchive / rootNames；删掉显示之后只剩名字有人用 ⇒ 收成 `string[]`（顺带去掉
 *   "对每个目录跟一遍 FAT 链"的开销）。
 *   ⚠ 别把那句被删的 UI 文案写进注释：注释会进产物，分节 (o) 拿"产物里不该有它"当判据。
 */
export function cardEmblemDirNames(): string[] {
  const lc = state.card;
  if (!lc) return [];
  const out: string[] = [];
  for (const e of lc.card.listRoot()) {
    if (e.isDot || !e.isDir || !e.isEmblemDir) continue;
    out.push(e.name);
  }
  return out;
}

/**
 * 重建槽位模型：把卡上**属于当前作品**的徽章目录解析出来，再交给 `buildGameSlotModel()`。
 *
 * ★★ 2026-10-04 用户实测修正：**8 个槽 = 当前所选作品的 8 个槽**。
 *   第一版把卡上**所有**徽章目录（LR 的 `*EMB` + 每个 `E##`）混成同一个网格，
 *   理由是"槽位布局是整张卡的属性"。结论是**错的**：切作品时槽内容一模一样，
 *   用户看到的现象就是"我换左上的作品，下面的 8 个槽不会跟着变"。
 *   ⇒ 现在按**盘序列号**过滤（`logic/slots.ts::filterDirsForGame`，区域前缀不参与比较）。
 *   被过滤掉的目录会记在 `model.excludedDirNames` 里，界面**必须**显示出来。
 *
 * `ctx` 为 null（作品还没解析出来 / 用户手填的序列号非法）时**不过滤**，
 * 保守地把整卡目录都算作"本作品" —— 宁可多显示，也不要因为一个输入框还没填完
 * 就让整张卡看起来是空的。
 */
export function reloadModel(ctx: GameContext | null = null): SlotModel | null {
  const lc = state.card;
  if (!lc) {
    state.model = null;
    return null;
  }
  const card = lc.card;
  const dirEntries: SlotDirLike[] = [];
  for (const e of card.listRoot()) {
    if (e.isDot || !e.isDir || !e.isEmblemDir) continue;
    const entries = card.listDir(e.name).map((d) => ({
      name: d.name,
      length: d.length,
      cluster: d.cluster,
      isDir: d.isDir,
    }));
    dirEntries.push({ name: e.name, entries });
  }
  const model = buildGameSlotModel(dirEntries, { serial: ctx ? ctx.serial : null });
  state.model = model;
  return model;
}

/**
 * 卡上**同作品**的真实徽章块（去掉容器头之后的裸块）。
 *
 * 用途：非 LR 的 9 字节「作品常量」必须从同作品的真实存档里读（`emblem.ts` 的
 * `headerTailFromSave` 语义），**不许猜**。
 */
export function sameGameBlocks(ctx: GameContext): Array<{ dir: string; file: string; block: Uint8Array }> {
  const lc = state.card;
  if (!lc || !state.model) return [];
  const card = lc.card;
  const wantSerial = ctx.serial.toUpperCase();
  const out: Array<{ dir: string; file: string; block: Uint8Array }> = [];
  for (const dirName of state.model.dirNames) {
    const serial = serialFromDirName(dirName);
    if (!serial || serial.toUpperCase() !== wantSerial) continue;
    const isEmb = dirName.toUpperCase().endsWith('EMB');
    if (isEmb !== (ctx.entry.form === 'lr-archive')) continue;
    for (const e of card.listDir(dirName)) {
      if (e.isDot || e.isDir) continue;
      if (e.length !== SAVE_SIZE && e.length !== LR_SAVE_SIZE) continue;
      try {
        const bytes = new Uint8Array(card.readFile(e.cluster, e.length));
        const kind = saveKind(bytes);
        if (kind !== 'emblem-raw' && kind !== 'emblem-lr') continue;
        out.push({ dir: dirName, file: e.name, block: bytes });
      } catch {
        /* 读不出来的跳过（不猜） */
      }
    }
  }
  return out;
}

// --------------------------------------------------------------------------
// 读取徽章块
// --------------------------------------------------------------------------

export interface BlockCheck {
  ok: boolean;
  checksumsOk: boolean;
  detail: string;
  offset: number;
}

/**
 * 判一块字节是不是**游戏口径**的徽章块。
 * ★ 顺序不能换：`saveKind` → `findOffset` → `verifyChecksums`（PORT-NOTES.md §二 6）。
 */
export function checkBlock(bytes: Uint8Array): BlockCheck {
  const kind = saveKind(bytes);
  const isLr = kind === 'emblem-lr';
  if (kind !== 'emblem-raw' && kind !== 'emblem-lr') {
    return {
      ok: false,
      checksumsOk: false,
      detail: t(`saveKind=${kind}（不是徽章块）`, `saveKind=${kind} (not an emblem block)`),
      offset: -1,
    };
  }
  let offset = 0;
  try {
    offset = findOffset(bytes);
  } catch (e) {
    return {
      ok: false,
      checksumsOk: false,
      detail: e instanceof Error ? e.message : String(e),
      offset: -1,
    };
  }
  const block = bytes.subarray(offset, offset + (isLr ? LR_SAVE_SIZE : SAVE_SIZE));
  const v = verifyChecksums(block);
  const detail = v.ok
    ? '18/18'
    : v.badSegments
        .slice(0, 3)
        .map((s) => `${s.name}@${hex(s.offset, 4)}`)
        .join(' ')
        .concat(v.badSegments.length > 3 ? t(` …共 ${v.badSegments.length} 段`, ` …${v.badSegments.length} segments in total`) : '');
  return { ok: v.ok, checksumsOk: v.ok, detail, offset };
}

/** 一个槽的缩略图（游戏口径 index0）。 */
export function buildThumb(cluster: number, length: number): SlotThumb | null {
  const lc = state.card;
  if (!lc) return null;
  let raw: Uint8Array;
  try {
    raw = new Uint8Array(lc.card.readFile(cluster, length));
  } catch {
    return null;
  }
  const chk = checkBlock(raw);
  let rgba: Uint8Array;
  try {
    // ★ 'index0' = 游戏里看到的样子（SPEC.md §五 ★ 实机口径）
    rgba = extractImage(chk.offset > 0 ? raw.subarray(chk.offset) : raw, 'index0');
  } catch (e) {
    return {
      data: new Uint8ClampedArray(128 * 128 * 4),
      width: 128,
      height: 128,
      checksumsOk18: false,
      checksumDetail: t(
        `提取失败：${e instanceof Error ? e.message : String(e)}`,
        `extract failed: ${e instanceof Error ? e.message : String(e)}`,
      ),
    };
  }
  return {
    data: new Uint8ClampedArray(rgba),
    width: 128,
    height: 128,
    checksumsOk18: chk.ok,
    checksumDetail: chk.detail,
  };
}

/** 重读全部槽的缩略图。 */
export function reloadThumbs(): void {
  resetThumbs();
  const model = state.model;
  if (!model) return;
  for (const s of model.slots) {
    if (!s.occupied) continue;
    try {
      state.thumbs[s.index] = buildThumb(s.cluster, s.length);
    } catch {
      state.thumbs[s.index] = null;
    }
  }
}

// --------------------------------------------------------------------------
// 删除槽里已有的徽章
// --------------------------------------------------------------------------

export interface DeleteResult {
  ok: boolean;
  message: string;
}

/**
 * 把一个文件 dirent 变成"空槽"，并释放它的簇链。
 *
 * 依据（`card.ts` 的注释与真卡实测）：
 *   · 空槽 = **整页 `0xFF`**，且备用区是**算好的 ECC**（`writePageRaw` 会一并重算）；
 *   · 释放簇 = 把每个簇的 FAT 项写回 `0x7FFFFFFF`（= `FAT_FREE` 的值）；
 *   · 若删掉的是**目录里序号最大的项**，把目录项数改成"剩下的最大项号 + 1"
 *     （项数记在**根目录里那个 dirent** 的 length 上）。
 *
 * ⚠ 这是**没有 Python 参考实现**的一段（和"目录满时新建槽"一样），所以既有测试覆盖不到它；
 *   写完仍会走 `verifyWrite()` 的 ECC 自检 —— 而它按定义是"没有坏页"，所以**不能**当作正确性证明。
 *   这一点在回报的"需要人工复核"里明说了。
 */
export function deleteSlotFile(dirName: string, fileName: string): DeleteResult {
  const lc = state.card;
  if (!lc) return { ok: false, message: t('还没有打开记忆卡', 'No memory card loaded yet') };
  const card = lc.card;
  const dirEnt = card.findInRoot(dirName);
  if (!dirEnt) return { ok: false, message: t(`卡上没有目录 ${dirName}`, `The card has no folder ${dirName}`) };
  const dirCount = dirEnt.length > 0 ? dirEnt.length : card.dirCount(dirEnt.cluster);
  const entries = card.dirents(dirEnt.cluster, Math.max(dirCount, 1));
  const target = entries.find((e) => !e.isDot && e.name === fileName);
  if (!target) return { ok: false, message: t(`${dirName} 里没有 ${fileName}`, `No ${fileName} in ${dirName}`) };

  const chain = target.cluster > 0 ? card.chain(target.cluster, 4096) : [];

  // ★ 0.19（D9）：**先做越界检查、再动 FAT**。原先顺序反了：一旦槽号越界就 `return {ok:false}`，
  //   可 FAT 已经被释放过了 ⇒ 调用方看到"失败"，内存里的卡却已经被改了一半。
  const dirChain = card.chain(dirEnt.cluster, 4096);
  const ci = Math.floor(target.index / card.ppc);
  const k = target.index % card.ppc;
  if (ci >= dirChain.length) {
    return { ok: false, message: t(`槽 ${target.index} 超出目录链`, `Slot ${target.index} is outside the folder chain`) };
  }

  for (const cl of chain) card.writeFat(cl, FAT_FREE >>> 0);

  // 把 dirent 清成空槽（整页 FF + 正确 ECC）
  const page = card.dataPage(dirChain[ci], k);
  card.writePageRaw(page, card.emptyDirent());

  let countNote = '';
  const maxOther = entries.reduce((a, e) => (e.index !== target.index && e.index > a ? e.index : a), 0);
  if (target.index + 1 === dirCount && dirCount > maxOther + 1) {
    const newCount = maxOther + 1;
    card.setDirentLength(card.rootdir, dirEnt.index, newCount);
    countNote = t(`，项数 ${dirCount} → ${newCount}`, `, entry count ${dirCount} -> ${newCount}`);
  }
  return {
    ok: true,
    message: t(
      `已删除 ${dirName}\\${fileName}：释放簇 ${chain.length ? chain.join(',') : '（无）'}${countNote}`,
      `Deleted ${dirName}\\${fileName}: released clusters ${chain.length ? chain.join(',') : '(none)'}${countNote}`,
    ),
  };
}

// --------------------------------------------------------------------------
// 写入
// --------------------------------------------------------------------------

export type { WriteTarget };

/** ★ 0.25：读一次句柄所指文件的当前状态（读不到就返回 null —— **不因为读不到就拦写入**）。 */
async function readStamp(handle: FileSystemFileHandle): Promise<{ mtime: number; size: number } | null> {
  try {
    const f = await handle.getFile();
    return { mtime: f.lastModified, size: f.size };
  } catch {
    return null;
  }
}

/**
 * ★ 0.25：**动手前**先查一次"这张卡在磁盘上是不是被别的进程改过了"（写入与删除共用）。
 *
 * ⚠ 位置很重要：它必须在**任何内存副本的修改之前**调用 —— 不然一旦拒绝，内存副本已经被改过，
 *   模型却还是旧的 ⇒ 再点一次就会撞 `card.ts::createFileInDir()` 的"已经有 dataN，拒绝覆盖"
 *   （用户实测到的第二条错就是这么来的）。放在最前面 ⇒ 拒绝 = **什么都没发生**，重试照样是"新建"。
 *
 * 返回 null = 可以继续；返回字符串 = 拒绝理由（已经是给人看的完整说明）。
 */
async function preflightStale(lc: NonNullable<typeof state.card>): Promise<string | null> {
  if (!lc.handle || !lc.lastSeen) return null; // 只读打开（没句柄）⇒ 只会下载，没什么可拦的
  const now = await readStamp(lc.handle);
  if (!now || !stampChanged(lc.lastSeen, now)) return null;
  const text = staleFileRefusal({ fileName: lc.fileName, seen: lc.lastSeen, now });
  toast('error', t('这张卡在磁盘上又被改过了 ⇒ 拒绝操作', 'The card on disk was changed again - operation refused'), text, 30_000);
  return text;
}

/** 目录里那个"与目录同名"的文件（非 LR 的徽章本体）。 */
function emblemFileInDir(dirName: string): string | null {
  const lc = state.card;
  if (!lc) return null;
  const want = dirName.toUpperCase();
  for (const e of lc.card.listDir(dirName)) {
    if (e.isDot || e.isDir) continue;
    if (e.name.toUpperCase() === want) return e.name;
  }
  return null;
}

/**
 * 算出"这一槽该写到哪里"（**界面层入口**：把卡上的真实信息喂给纯逻辑规划器）。
 *
 * 规划本身在 `logic/planWrite.ts::planWriteTargetIn()`（零 I/O、可测）；
 * 这里只负责补两样"只有真卡才知道"的东西：
 *   · 卡上**全部**徽章目录名（用来区分"卡上真没有"与"卡上有、但不属于本作品"）；
 *   · 非 LR 已有文件的**首簇/长度**（写覆盖要用，纯逻辑层不看字节）。
 *
 * ★ 0.19：删掉了 `opts` 注入点（`model` / `cardDirNames`）—— 3 个调用点一个都不传、
 *   也没有任何测试调这个函数，注释却写着"只为测试留"。
 * ★ 0.21：`slotIndices: number[]` → `slotIndex: number`（〔批量写 8 槽〕已删）。
 */
export function planWriteTarget(ctx: GameContext, slotIndex: number): WritePlan {
  const cardDirNames = cardEmblemDirNames();
  const plan = planWriteTargetIn({
    model: state.model,
    cardDirNames,
    ctx,
    slotIndex,
    emblemFileInDir,
  });
  // 非 LR 的"已有文件"要补回真实簇/长度（模型里只有"占用的槽"，用户填的作品可能不同）
  const tgt = plan.target;
  if (tgt && !tgt.isNew && tgt.cluster === 0) {
    const e = state.card?.card.listDir(tgt.dirName).find((d) => d.name === tgt.fileName);
    if (e) {
      tgt.cluster = e.cluster;
      tgt.length = e.length;
    }
  }
  return plan;
}

function writeBlockToTarget(
  target: WriteTarget,
  block: Uint8Array,
): { touched: number[]; cluster: number } {
  const lc = state.card;
  if (!lc) throw new Error(t('还没有打开记忆卡', 'No memory card loaded yet'));
  const card = lc.card;
  if (!target.isNew && target.cluster > 0) {
    const chain = card.chain(target.cluster, 4096);
    const pageBytes = card.ppc * 512;
    const need = Math.ceil(block.length / pageBytes);
    if (chain.length < need) {
      throw new Error(
        t(
          `目标文件 ${target.fileName} 的簇链只有 ${chain.length} 簇，装不下 ${block.length} 字节（需要 ${need} 簇）。` +
            '本版本不做"原地扩链"：请先删掉这个槽（删除槽按钮）再重新写。',
          `The cluster chain of ${target.fileName} has only ${chain.length} clusters and cannot hold ${block.length} bytes (${need} clusters needed). ` +
            'This version does not extend a chain in place: delete this slot first (Delete slot), then write again.',
        ),
      );
    }
    // 只写前 need 簇；多余的簇留在链上（保守：宁可有空闲簇，也不要写坏链）
    const touched = card.writeFileIntoClusters(chain.slice(0, need), block);
    card.writeFatChain(chain.slice(0, need));
    // ★ 0.19（D16）：覆盖已有文件时**顺带把 dirent 的 length 对齐**。原先从不更新它 ——
    //   新块比旧文件短时，目录里记的长度会偏大（当前两种布局都是定长 ⇒ 正常路径撞不上，
    //   但它是个"看起来能跑"的隐患）。只有长度确实不同才写，免得平白多改一页。
    if (target.length !== block.length) {
      const de = card.findInRoot(target.dirName);
      if (de) {
        const ent = card.dirents(de.cluster, Math.max(de.length, 1)).find((e) => e.name === target.fileName);
        if (ent) card.setDirentLength(de.cluster, ent.index, block.length);
      }
    }
    return { touched, cluster: chain[0] };
  }
  const r = card.createFileInDir(target.dirName, target.fileName, block);
  return { touched: r.touchedPages, cluster: r.firstCluster };
}

/**
 * 给定**页号**列表，返回其中 ECC 不自洽的页。
 *
 * ★ 0.19（D4）：入参从"簇列表"改成"**页列表**"。原先调用方只传了目标文件的**首簇**
 *   ⇒ 一个 17,440 字节的块要占 18 簇 / 36 页，自检实际只验了 2 页。现在直接把
 *   `createFileInDir`/`writeFileIntoClusters` 报出来的**全部改动页**丢进来。
 */
function badEccPages(pages: readonly number[]): number[] {
  const lc = state.card;
  if (!lc) return [];
  const bad: number[] = [];
  for (const p of pages) {
    if (!lc.card.eccOk(p)) bad.push(p);
  }
  return bad;
}

export interface WriteOutcome {
  ok: boolean;
  lines: string[];
  persisted: string | null;
}

/**
 * ★ 写入主流程（**一个槽**）。
 *
 * 顺序（SPEC.md §八，一条都不许换）：
 *   ① 合规复核（调用方给的 `finalCheck`）→ 不合规立刻拒绝；
 *   ② 算新块 `encodeEmblem(rgba, { isLr, headerTail })`（非 LR 的 9 字节从真实存档取，**不猜**）；
 *   ③ 在**同一份内存副本**上写入；
 *   ④ 回读：逐字节 + 18/18 + ECC → `verifyWrite()` 决策，**任一不过拒绝落盘**；
 *   ⑤ 弹确认框（含"请先完全退出 PCSX2"）→ 有句柄就覆盖、否则下载。
 *
 * ★ 0.21：`writeSlots(ctx, slotIndices[], …)` → `writeSlot(ctx, slotIndex, …)` ——〔批量写 8 槽〕
 *   按用户要求删除（"这个没什么实际作用"），于是"逐槽循环"整段消失（本来也只编码一次块）。
 */
export async function writeSlot(
  ctx: GameContext,
  slotIndex: number,
  opts: { isLr: boolean; finalCheck: () => { ok: boolean; issues: string[] } },
): Promise<WriteOutcome> {
  const lc = state.card;
  const prepared = state.prepared;
  const lines: string[] = [];
  const fail = (msg: string): WriteOutcome => {
    toast('error', t('拒绝写入', 'Write refused'), msg);
    lines.push('❌ ' + msg);
    return { ok: false, lines, persisted: null };
  };

  if (!lc) return fail(t('还没有打开记忆卡', 'No memory card loaded yet'));
  if (!state.model) return fail(t('记忆卡模型还没建起来', 'The memory card model has not been built yet'));
  if (!prepared) {
    return fail(
      state.prepareError
        ? t(`图像还不合规：${state.prepareError}`, `The image is not compliant yet: ${state.prepareError}`)
        : t('还没有可写入的图像', 'No image ready to write'),
    );
  }

  // ①′ ★ 0.25：**动手前**先查"磁盘上的卡是不是被改过了" —— 必须在任何内存改动之前，
  //   这样"拒绝"就等于"什么都没发生"（重试时规划仍然是干净的"新建"，不会撞"已经有 dataN"）。
  const stale = await preflightStale(lc);
  if (stale) return { ok: false, lines: ['❌ ' + stale], persisted: null };

  // ① 合规复核（**再查一次**，不只信之前的 report）
  const rc = opts.finalCheck();
  if (!rc.ok) {
    return fail(
      t(
        `图像不合规，拒绝写入：\n· ${rc.issues.join('\n· ')}`,
        `Image not compliant, write refused:\n- ${rc.issues.join('\n- ')}`,
      ),
    );
  }

  // ② 非 LR 的 9 字节作品常量
  let headerTail: Uint8Array | null = null;
  if (!opts.isLr) {
    const same = sameGameBlocks(ctx);
    const res = resolveHeaderTail(ctx.serial, same.map((s) => s.block), KNOWN_HEADER_TAIL);
    if ('error' in res) return fail(res.error);
    headerTail = res.tail;
    lines.push(
      t(
        `作品常量（9 字节）= ${Array.from(headerTail)
          .map((b) => b.toString(16).padStart(2, '0'))
          .join('')}　来源：${
          res.source === 'card' ? '卡上同作品的真实存档' : '核心层登记表 KNOWN_HEADER_TAIL'
        }`,
        `game constant (9 bytes) = ${Array.from(headerTail)
          .map((b) => b.toString(16).padStart(2, '0'))
          .join('')}  source: ${
          res.source === 'card' ? 'a real save of the same game on the card' : 'core-layer table KNOWN_HEADER_TAIL'
        }`,
      ),
    );
  }

  // ③ 计划（★ 0.21：只有一个目标）
  const plan = planWriteTarget(ctx, slotIndex);
  const target = plan.target;
  // ★ 防呆：目标必须落在**当前作品**的目录里。
  //   模型是按作品过滤的，所以这条恒成立；不成立说明"模型与 ctx 不同步"
  //   （例如切了作品却没重建模型）—— 那就**拒绝写盘**，绝不能写到别的作品上。
  const model = state.model;
  if (
    target &&
    model &&
    !model.dirNames.some((d) => d.toUpperCase() === target.dirName.toUpperCase())
  ) {
    return fail(
      t(
        `内部自检不过：目标目录 ${target.dirName} 不属于当前作品（${ctx.serial}）—— ` +
          '模型与作品选择不同步，拒绝写入。请重新选一次作品或重新打开卡。',
        `Internal check failed: target folder ${target.dirName} does not belong to the current game (${ctx.serial}) - ` +
          'the model and the game selection are out of sync, so the write is refused. Pick the game again or reopen the card.',
      ),
    );
  }
  if (plan.warning) lines.push('⚠ ' + plan.warning);
  if (plan.error) return fail(plan.error);
  if (!target) return fail(t('没有任何可写的目标槽', 'There is no target slot to write to'));

  // ④ 写进内存副本 + 立刻回读自检
  let block: Uint8Array;
  try {
    block = encodeEmblem(prepared.rgba, { isLr: opts.isLr, headerTail });
  } catch (e) {
    return fail(
      t(
        `生成徽章块失败：${e instanceof Error ? e.message : String(e)}`,
        `Failed to build the emblem block: ${e instanceof Error ? e.message : String(e)}`,
      ),
    );
  }
  const expectLen = opts.isLr ? LR_SAVE_SIZE : SAVE_SIZE;
  if (block.length !== expectLen) {
    return fail(
      t(
        `生成出来的块长度 ${block.length} ≠ 期望 ${expectLen}（内部错误，拒绝写入）`,
        `The generated block is ${block.length} bytes, expected ${expectLen} (internal error, write refused)`,
      ),
    );
  }

  let written: { touched: number[]; cluster: number };
  try {
    written = writeBlockToTarget(target, block);
  } catch (e) {
    return fail(
      t(
        `写内存副本失败（${target.dirName}\\${target.fileName}）：${e instanceof Error ? e.message : String(e)}`,
        `Failed to write the in-memory copy (${target.dirName}\\${target.fileName}): ${e instanceof Error ? e.message : String(e)}`,
      ),
    );
  }

  // ---- 回读自检 ----
  const back = lc.card.listDir(target.dirName).find((e) => !e.isDot && e.name === target.fileName);
  if (!back) {
    return fail(
      t(
        `回读失败：${target.dirName} 里找不到刚写的 ${target.fileName}`,
        `Read back failed: the ${target.fileName} just written is not in ${target.dirName}`,
      ),
    );
  }
  const readback = new Uint8Array(lc.card.readFile(back.cluster, back.length));
  const chkBlock = readback.subarray(0, Math.min(readback.length, expectLen));
  const decision = verifyWrite({
    readback,
    expected: block,
    checksums: verifyChecksums(chkBlock),
    // ★ 0.19（D4）：验**全部改动页**（原先只验首簇 ⇒ 18 簇的块只查了 2 页）。
    badEccPages: badEccPages(written.touched),
    compliance: prepared.report.compliance,
  });
  const head = t(
    `${target.dirName}\\${target.fileName}（槽 ${target.slotIndex + 1}${target.isNew ? '，新建' : '，覆盖'}）`,
    `${target.dirName}\\${target.fileName} (slot ${target.slotIndex + 1}${target.isNew ? ', new' : ', overwrite'})`,
  );
  if (!decision.proceed) {
    lines.push(`❌ ${head}`);
    for (const r of decision.reasons) lines.push('   · ' + r);
    lines.push(t('★ **已拒绝落盘**：改动只在内存里，磁盘上的文件一个字节都没动。', '★ **Not written to disk**: the change exists only in memory; the file on disk is untouched.'));
    const out: WriteOutcome = { ok: false, lines, persisted: null };
    toast('error', t('自检不过 ⇒ 拒绝写盘', 'Self-check failed - write refused'), `${head}\n${decision.reasons.join('\n')}`);
    return out;
  }
  lines.push(
    t(`✅ ${head}：${humanBytes(block.length)} · ${decision.passed.join(' · ')}`, `✅ ${head}: ${humanBytes(block.length)} · ${decision.passed.join(' · ')}`),
  );

  // ⑤⑥ 落盘（★ 0.25：抽成 `persistCardChange()` —— 删除槽也要走同一条路）
  // ⚠ 这两个前缀是**标记**（不是给人读的句子）：中文与英文两种语言下都照旧用同一对符号
  const changeLines = lines.filter((l) => l.startsWith('✅') || l.startsWith('⚠'));
  const saved = await persistCardChange({ lc, changes: changeLines });
  lines.push(...saved.lines);
  return { ok: saved.ok, lines, persisted: saved.persisted };
}

/**
 * ★ 0.25 新增：**落盘**（写入与删除共用）。
 *
 * 顺序（SPEC.md §八）：
 *   ① ★ **写前查"这张卡在磁盘上是不是被别人改过了"** —— 变了就**拒绝**，并把
 *      "哪个文件、什么时候变的、接下来三步"一次说清（`logic/staleness.ts::staleFileRefusal()`）。
 *      来由：用户实测写槽 3 时 `createWritable()` 抛 `InvalidStateError`（PCSX2 一直开着、
 *      在工具读过卡之后又写过一次文件）；原来一路写到这一步才炸，用户拿到的只有一句英文错，
 *      而且"重试"必然再失败（句柄还是过期的）。
 *   ② 确认框（含"请先完全退出 PCSX2"）；
 *   ③ 有句柄就覆盖（拿不到写权限则降级成下载），没句柄就下载；
 *   ④ 覆盖后**回读文件**逐字节比对；成功时把文件新的状态记回 `lc.lastSeen`。
 *
 * `changes` 是给确认框看的改动摘要（一行一条）。
 */
async function persistCardChange(opts: {
  lc: NonNullable<typeof state.card>;
  changes: readonly string[];
  /** 调用方**已经问过**了（删除槽那条路就是先问再删再落盘）⇒ 这里不再弹第二次。 */
  confirmedAlready?: boolean;
}): Promise<{ ok: boolean; persisted: string | null; lines: string[] }> {
  const { lc, changes } = opts;
  const lines: string[] = [];
  const overwrite = !!lc.handle;

  // ① 写前拦截：磁盘上的卡在我们读过之后被改过 ⇒ 拒绝（Chrome 也会拒，但那句英文没法照做）
  if (lc.handle && lc.lastSeen) {
    const now = await readStamp(lc.handle);
    if (now && stampChanged(lc.lastSeen, now)) {
      const text = staleFileRefusal({ fileName: lc.fileName, seen: lc.lastSeen, now });
      toast('error', t('这张卡在磁盘上又被改过了 ⇒ 拒绝写入', 'The card on disk was changed again - write refused'), text, 30_000);
      lines.push('❌ ' + text);
      return { ok: false, persisted: null, lines };
    }
  }

  // ② 确认框
  if (!opts.confirmedAlready) {
    const go = window.confirm(confirmWriteMessage({ fileName: lc.fileName, overwrite, changes }));
    if (!go) {
      toast('warn', t('已取消落盘', 'Writing to disk cancelled'), t('内存里的改动没有保存；磁盘上的文件没动。', 'The in-memory change was not saved; the file on disk is untouched.'));
      return {
        ok: false,
        persisted: null,
        lines: [t('（用户在确认框里按了取消 ⇒ 未落盘）', '(the user cancelled in the confirmation box - nothing was written)')],
      };
    }
  }

  // ③④ 落盘 + 回读
  if (overwrite && lc.handle) {
    try {
      const perm = await lc.handle.queryPermission({ mode: 'readwrite' });
      let granted = perm === 'granted';
      if (!granted) granted = (await lc.handle.requestPermission({ mode: 'readwrite' })) === 'granted';
      if (!granted) {
        downloadCard(lc.card.buf, lc.fileName);
        return {
          ok: true,
          persisted: t(
            `没有拿到写权限 ⇒ 已改为下载 ${lc.fileName}（先完全退出 PCSX2，再拷回 memcards\\）`,
            `No write permission -> downloaded ${lc.fileName} instead (fully exit PCSX2 first, then copy it back to memcards\\)`,
          ),
          lines,
        };
      }
      const w = await lc.handle.createWritable();
      await w.write(lc.card.buf);
      await w.close();
      // ★ 回读**文件**（不是内存），确认真的落盘了；顺手把新的文件状态记住
      const after = await lc.handle.getFile();
      lc.lastSeen = { mtime: after.lastModified, size: after.size };
      const afterBytes = new Uint8Array(await after.arrayBuffer());
      const same =
        afterBytes.length === lc.card.buf.length && afterBytes.every((v, i) => v === lc.card.buf[i]);
      if (!same) {
        toast(
          'error',
          t('覆盖后回读不一致', 'Read back after overwrite does not match'),
          t('文件内容与内存里的卡不同 —— 检查磁盘/杀毒软件，并把原卡备份找回来（源卡字节我们一直保有副本）。', 'The file content differs from the in-memory card - check the disk and your antivirus, and recover the original card backup (we always keep a copy of the source bytes).'),
        );
        return { ok: false, persisted: null, lines };
      }
      toast(
        'ok',
        t(`已覆盖 ${lc.fileName}`, `Overwrote ${lc.fileName}`),
        t(`写入 ${humanBytes(lc.card.buf.length)}，覆盖后回读逐字节一致 ✅`, `Wrote ${humanBytes(lc.card.buf.length)}; read back byte-for-byte identical ✅`),
      );
      return { ok: true, persisted: t(`已覆盖 ${lc.fileName}`, `Overwrote ${lc.fileName}`), lines };
    } catch (e) {
      // ★ 0.25：`InvalidStateError` = 句柄过期（"检查"与"落盘"之间又被改了）⇒ 换成能照做的说明
      if (e instanceof Error && e.name === 'InvalidStateError') {
        toast('error', t('这张卡在磁盘上又被改过了 ⇒ 拒绝覆盖', 'The card on disk was changed again - overwrite refused'), staleHandleHint(), 30_000);
        lines.push('❌ ' + t('落盘失败：', 'Failed to write to disk: ') + staleHandleHint());
        return { ok: false, persisted: null, lines };
      }
      const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      toast(
        'error',
        t('覆盖保存失败', 'Overwrite failed'),
        msg + '\n' + t('（内存里的改动还在，可以重试；也可以改用〔另存为〕存一份出来）', '(the in-memory change is still there, you can retry; or use Save card as to save a copy)'),
      );
      lines.push('❌ ' + t('覆盖保存失败：', 'Overwrite failed: ') + msg);
      return { ok: false, persisted: null, lines };
    }
  }

  downloadCard(lc.card.buf, lc.fileName);
  return {
    ok: true,
    persisted: t(
      `已触发下载 ${lc.fileName}（这个浏览器没给写句柄 ⇒ 只能下载）。下载后请先完全退出 PCSX2，再拷回 memcards\\`,
      `Download of ${lc.fileName} started (this browser gave no write handle, so download is the only option). Fully exit PCSX2 first, then copy it back to memcards\\`,
    ),
    lines,
  };
}

/**
 * ★ 0.25 新增（用户要求）：**删完立刻写回记忆卡**。
 *
 * 在这之前删除只改内存副本，然后提示"用〔导出整卡〕或〔写入选中槽〕时才会落盘" ——
 * 用户的操作直觉是"删了就是删了"，所以现在一次做完：
 *
 *   ① 先问一次 —— 确认框里直接写明"**会立刻写回卡文件**"（外加那句 PCSX2 硬提示）；
 *   ② 在内存副本上删（`deleteSlotFile()`）；
 *   ③ 走**同一条** `persistCardChange()`：写前查句柄有没有过期 → 覆盖 → 回读文件逐字节比对。
 *      没有写句柄（只读打开）时，③ 会降级成"下载一份改好的卡"。
 *
 * ⚠ 落盘失败时**内存里已经是删掉的状态** —— 返回值的 `deleted` 与 `ok` 分开报，
 *   调用方必须如实告诉用户"内存里删了，但磁盘上没动"（别让人以为卡上已经删了）。
 *
 * ★ 0.28：返回值多了 `cancelled` —— 用户在确认框里按取消时是 `true`。
 *   以前调用方靠"日志文本里有没有『取消』"来判断，那是**用界面文案驱动控制流**，
 *   英文界面下必然失效（`main.ts` 已改用它）。
 */
export async function deleteSlotAndSave(
  dirName: string,
  fileName: string,
): Promise<{ ok: boolean; deleted: boolean; cancelled: boolean; persisted: string | null; lines: string[] }> {
  const lc = state.card;
  if (!lc) {
    return {
      ok: false,
      deleted: false,
      cancelled: false,
      persisted: null,
      lines: ['❌ ' + t('还没有打开记忆卡', 'No memory card loaded yet')],
    };
  }

  // ★ 0.25：**删之前**先查一次（同一个理由：拒绝 = 什么都没发生，别把内存副本改脏）
  const stale = await preflightStale(lc);
  if (stale) return { ok: false, deleted: false, cancelled: false, persisted: null, lines: ['❌ ' + stale] };

  const go = window.confirm(
    confirmWriteMessage({
      fileName: lc.fileName,
      overwrite: !!lc.handle,
      changes: [
        t(`🗑 删除 ${dirName}\\${fileName}（它占的簇会被释放）`, `🗑 Delete ${dirName}\\${fileName} (the clusters it occupies will be released)`),
        t('★ 删除后会**立刻写回卡文件**（不再只是内存里的改动）。', '★ The card file is **written back immediately** after the delete (it is no longer just an in-memory change).'),
      ],
    }),
  );
  if (!go) {
    toast('warn', t('已取消删除', 'Delete cancelled'), t('磁盘与内存都没动。', 'Nothing on disk or in memory was changed.'));
    return {
      ok: false,
      deleted: false,
      // ★ 0.28：**结构化**地告诉调用方"用户按了取消"。
      //   以前调用方是拿日志文本 `lines.some((l) => l.includes('取消'))` 去猜的 ——
      //   那是"用界面文案驱动控制流"，双语化之后必然出错（英文界面里那行不含"取消"）。
      cancelled: true,
      persisted: null,
      lines: [t('（用户在确认框里按了取消 ⇒ 什么都没做）', '(the user cancelled in the confirmation box - nothing was done)')],
    };
  }

  const r = deleteSlotFile(dirName, fileName);
  if (!r.ok) return { ok: false, deleted: false, cancelled: false, persisted: null, lines: ['❌ ' + r.message] };

  const lines = ['✅ ' + r.message];
  // 已经问过了（上面那个确认框把"会写回卡"一起问了）⇒ 这里不再弹第二次
  const saved = await persistCardChange({ lc, changes: [r.message], confirmedAlready: true });
  lines.push(...saved.lines);
  return { ok: saved.ok, deleted: true, cancelled: false, persisted: saved.persisted, lines };
}


/** Blob → URL → 一个隐藏的 `<a download>`（SPEC.md §三 降级流程）—— 导出整卡与导出 PNG 共用。 */
function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** 下载一份卡（降级路径：拿不到"保存"对话框时用）。 */
export function downloadCard(bytes: Uint8Array, fileName: string): void {
  downloadBlob(new Blob([bytes], { type: 'application/octet-stream' }), fileName);
}

/** 导出 PNG。 */
export async function exportPng(bytes: Uint8ClampedArray, w: number, h: number, name: string): Promise<void> {
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext('2d') as CanvasRenderingContext2D;
  ctx.putImageData(new ImageData(bytes, w, h), 0, 0);
  const blob: Blob | null = await new Promise((res) => cv.toBlob((b) => res(b), 'image/png'));
  if (!blob) throw new Error(t('canvas.toBlob() 返回 null（内存不足？）', 'canvas.toBlob() returned null (out of memory?)'));
  downloadBlob(blob, name);
}

/**
 * ★ 0.26（用户要求）：〔另存为…〕—— **把内存里的这张卡另存成一份记忆卡文件**。
 *
 * 原来这个按钮叫〔导出整卡〕，只会触发一次下载（文件名固定 `<原名>_export.ps2`）。
 * 现在先走 **`showSaveFilePicker()`**：弹出真正的"另存为"对话框，**位置和文件名都由你选**
 * —— 这才是"另存一张记忆卡"该有的样子。
 *
 * 兜底（项目既有策略，见 SPEC.md §三）：拿不到那个对话框（老浏览器 / 被拒）时**退化成下载**；
 * 你在对话框里按取消 ⇒ 什么都不做，也不下载（`AbortError` 不是错误）。
 *
 * ★ 存完**照例回读文件逐字节比对** —— 与写卡那条路同一个规矩（SPEC.md §八 2）：
 *   宁可报"存出来的不是同一张卡"，也不要让你以为备份好了、其实没有。
 */
export async function saveCardAs(): Promise<boolean> {
  const lc = state.card;
  if (!lc) {
    toast('warn', t('还没有打开记忆卡', 'No memory card loaded yet'), t('先在顶栏选一张 .ps2 卡。', 'Pick a .ps2 card in the top bar first.'));
    return false;
  }
  const suggested = lc.fileName.replace(/\.ps2$/i, '') + '_copy.ps2';
  const picker = (window as unknown as {
    showSaveFilePicker?: (o?: unknown) => Promise<FileSystemFileHandle>;
  }).showSaveFilePicker;

  if (typeof picker === 'function') {
    let handle: FileSystemFileHandle;
    try {
      handle = await picker({
        suggestedName: suggested,
        types: [{ description: t('PS2 记忆卡镜像', 'PS2 memory card image'), accept: { 'application/octet-stream': ['.ps2', '.mcr', '.mc2', '.bin'] } }],
      });
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') {
        toast('info', t('已取消另存为', 'Save card as cancelled'), t('没有写任何文件；内存里的改动还在。', 'No file was written; the in-memory change is still there.'));
        return false;
      }
      // 其它情况（没有这个对话框 / 被策略拒）⇒ 退化成下载，不让用户卡住
      toast(
        'warn',
        t('这个环境没有"另存为"对话框，改成下载', 'This environment has no Save-as dialog, falling back to download'),
        e instanceof Error ? `${e.name}: ${e.message}` : String(e),
      );
      downloadCard(lc.card.buf, suggested);
      return true;
    }
    try {
      const w = await handle.createWritable();
      await w.write(lc.card.buf);
      await w.close();
      const back = new Uint8Array(await (await handle.getFile()).arrayBuffer());
      const same = back.length === lc.card.buf.length && back.every((v, i) => v === lc.card.buf[i]);
      if (!same) {
        toast('error', t('另存出来的文件与内存里的卡不一致', 'The saved file does not match the in-memory card'), t('别拿它当备份 —— 检查磁盘后重试。', 'Do not use it as a backup - check the disk and try again.'));
        return false;
      }
      toast(
        'ok',
        t(`已另存为 ${handle.name}`, `Saved as ${handle.name}`),
        t(`写入 ${humanBytes(lc.card.buf.length)}，回读逐字节一致 ✅`, `Wrote ${humanBytes(lc.card.buf.length)}; read back byte-for-byte identical ✅`),
      );
      return true;
    } catch (e) {
      const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      toast(
        'error',
        t('另存为失败', 'Save card as failed'),
        `${msg}\n` + t('（内存里的卡还在，可以重试。）', '(the in-memory card is still there, you can retry.)'),
      );
      return false;
    }
  }

  downloadCard(lc.card.buf, suggested);
  toast(
    'info',
    t(`已下载一份卡的副本（${suggested}）`, `Downloaded a copy of the card (${suggested})`),
    t('这个环境没有"另存为"对话框，所以按下载处理。', 'This environment has no Save-as dialog, so it was handled as a download.'),
  );
  return true;
}

// --------------------------------------------------------------------------
// 调试出口
// --------------------------------------------------------------------------
/**
 * window.EmblemToolCore 的两个命名空间对象，方便用户按 F12 手查
 * （离线工具：不联网、不外传，纯粹是"给会看控制台的人一扇窗"）。
 *
 * ⚠ 下面两行是**全项目唯一**一处 re-export（export + 星号 + as）——
 *   也是 build.mjs 支持的唯一一种 re-export（实现是 "var ns = require(id)"）。
 *   ★ 别在注释里写反引号：打包器的静态掩码会把注释里的反引号当成模板字面量，
 *     从而把后面几百行"吃掉"（本构建器踩过这个坑，所以这里用普通引号写例子）。
 */
export * as emblemCore from '../core/emblem.ts';
export * as cardCore from '../core/card.ts';

/** 调试：把一个目录的 dirent 打成文本。 */
export function direntDebug(dirName: string): string {
  const lc = state.card;
  if (!lc) return t('（未打开卡）', '(no card loaded)');
  const ent = lc.card.findInRoot(dirName);
  if (!ent) return t(`（没有目录 ${dirName}）`, `(no folder ${dirName})`);
  const count = ent.length > 0 ? ent.length : lc.card.dirCount(ent.cluster);
  return lc.card
    .dirents(ent.cluster, Math.max(count, 1))
    .map((e) => `#${e.index} ${e.name} mode=${hex(e.mode, 4)} len=${e.length} cl=${e.cluster}`)
    .join('\n');
}
