/**
 * 槽位模型 —— 纯逻辑，零依赖、不碰 DOM。
 *
 * ## 槽位语义（依据）
 *
 * `SPEC.md` §四/§七 + `docs\01-项目理解\04-记忆卡与存档处理.md`：
 *
 *   · **LR**（Last Raven）= 一个 `…EMB` 目录，里面 `data0`..`data7` 共 8 个徽章文件。
 *     目录里**允许中间有空缺**（实机验证过 `data0/1/2/7` 同时存在）。
 *   · **非 LR**（SL / NX / AC3 / AC2 / AC2AA / NB）= 每个徽章**一个独立目录**
 *     `<2 字母前缀><盘序列号>E<两位槽号>`，目录里的文件与目录同名。
 *   · 槽位号写在 `icon.sys@0xDF`（非 LR 与槽号一致；**LR 的 `…EMB` 只有一份 icon.sys、
 *     `0xDF` 恒为 0**，槽号看 `dataN`）。它落在标题字段内部 ⇒ 改标题时**最后**写它
 *     （SPEC.md §七 ★，否则被抹成 0、NX 卡死）。0.20 起 8 格上不再显示这个偏移量。
 *
 * ## ★★ 下面这 8 个槽 = **当前所选作品的** 8 个槽（2026-10-04 用户实测修正）
 *
 * 第一版把卡上**所有**徽章目录混成同一个 8 槽网格，理由是"槽位布局是整张卡的属性"。
 * 那个结论是**错的**：用户要的是"切作品 = 换一套槽"。实测现象是
 * "我换左上的作品，下面的 8 个槽不会跟着变"——因为切作品只改了空槽的提示文字。
 * ⇒ 现在的规则是**按盘序列号过滤**（区域无关，不看 `BA`/`BI` 前缀）：
 *   只有"目录名里的序列号 == 当前作品的序列号"的目录才进入这 8 个槽；
 *   被过滤掉的目录记在 `excludedDirNames` 里，界面必须把它们显示出来
 *   （**不许静默隐藏** —— 否则用户会以为卡里没东西）。
 *
 * 本模块只做"目录项 → 8 个槽"的映射，**不碰字节**：读块、校验、缩略图都在调用方做。
 */

import { serialFromDirName } from './games.ts';

/** 一个目录项的最小信息（`card.ts::Dirent` 的子集，避免逻辑层 import 核心层）。 */
export interface DirEntryLike {
  name: string;
  /** 文件 = 字节数；目录 = 项数。 */
  length: number;
  /** 首簇。 */
  cluster: number;
  /** 是否目录（`card.ts::Dirent.isDir`）。 */
  isDir: boolean;
}

/** 一个"存档目录"（`E##` 目录，或 LR 的 `…EMB` 目录）。 */
export interface SlotDirLike {
  name: string;
  entries: DirEntryLike[];
}

export const SLOT_COUNT = 8;

/** LR 的 8 个文件名。 */
export const LR_FILE_NAMES: readonly string[] = ['data0', 'data1', 'data2', 'data3', 'data4', 'data5', 'data6', 'data7'];

export interface SlotInfo {
  /** 游戏内的槽位下标 0..7（**就地**，`data0`/`E00` 都是 0）。 */
  index: number;
  /** 游戏显示用的 1..8。 */
  displayNumber: number;
  /** 所属存档目录名（`BISLPS-25462EMB` 或 `BISLPS-25169E01`）。 */
  dirName: string;
  /** 目录名里那个 `E##` 的槽号（LR 目录没有 → null）。 */
  dirSlotIndex: number | null;
  /** true = 该目录是 LR 形态（一目录包 8 槽）。 */
  isLrArchive: boolean;
  /** 槽里有徽章吗。 */
  occupied: boolean;
  /** 徽章文件名（占用时）。 */
  fileName: string | null;
  /** 徽章字节数（占用时）。 */
  length: number;
  /** 首簇（占用时）。 */
  cluster: number;
  /** 计划新建时该用的文件名。 */
  expectedFileName: string;
}

export interface SlotModel {
  /** 恒为 8 项，下标 = 就地槽号。 */
  slots: SlotInfo[];
  /** **属于当前作品**的存档目录名（按出现顺序）。 */
  dirNames: string[];
  /** true = 属于当前作品的目录里至少有一个 LR 形态。 */
  hasLrArchive: boolean;
  /** **属于当前作品**的 `E##` 槽号（升序去重）。 */
  perSlotDirIndices: number[];
  /** ★ 卡上有、但**不属于当前作品**因此没显示出来的徽章目录名（界面必须列出来）。 */
  excludedDirNames: string[];
  /** 过滤时用的盘序列号（null = 没能从作品上下文里拿到序列号，此时不过滤）。 */
  serial: string | null;
}

/** 过滤依据：只认"盘序列号"，区域前缀（`BA`/`BI`）不参与比较。 */
export interface SlotFilter {
  /** 归一化盘序列号，如 `SLPS-25462`。null / '' = 不过滤（全部算作本作品）。 */
  serial: string | null;
}

function isDotName(name: string): boolean {
  return name === '.' || name === '..';
}

/** 目录名像不像"徽章存档目录"：`E##` 结尾（SL/NX/… 每槽一个目录）或 `EMB` 结尾（LR）。 */
export function isEmblemDirName(name: string): boolean {
  const upper = name.toUpperCase();
  return /E\d\d$/.test(upper) || upper.endsWith('EMB');
}

function localIndexFromFileName(name: string): number | null {
  const m = /^data(\d+)$/.exec(name);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 0 && n < SLOT_COUNT ? n : null;
}

/**
 * ★ 按作品过滤目录。
 *
 * 判据**只看盘序列号**（大小写无关）：`serialFromDirName()` 剥出目录名里的序号部分
 * （`BISLPS-25338E00` → `SLPS-25338`），与当前作品的序列号逐个字符比较。
 * 为什么不比前缀：同一部作品的日版/美版（`BI` / `BA`）在卡上可能是两个不同目录，
 * 而用户在下拉框里选的是"作品"，不是"区域"；把序列号配平就够了。
 *
 * `filter.serial` 为空（作品上下文还没解析出来）时**不过滤** —— 保守，
 * 宁可多显示也不能因为"还没选作品"就把卡显示成空的。
 */
export function filterDirsForGame(
  dirs: readonly SlotDirLike[],
  filter: SlotFilter | null | undefined,
): { included: SlotDirLike[]; excluded: SlotDirLike[]; serial: string | null } {
  const want = (filter && filter.serial ? filter.serial : '').trim().toUpperCase();
  const included: SlotDirLike[] = [];
  const excluded: SlotDirLike[] = [];
  for (const d of dirs) {
    // 只考虑"像徽章目录的"（`E##` / `EMB`）。其它目录（`Mcd001`、`icon.sys` 之类）
    // 既不算本作品、也不算"卡上还有其它作品"—— 把它们列进摘要行只会误导用户。
    if (!isEmblemDirName(d.name)) continue;
    if (!want) {
      included.push(d);
      continue;
    }
    const serial = serialFromDirName(d.name);
    if (serial && serial.toUpperCase() === want) included.push(d);
    else excluded.push(d);
  }
  return { included, excluded, serial: want || null };
}

/**
 * 给定卡上的若干存档目录，生成 8 个槽。
 *
 * 规则（保守，不猜）：
 *   1. 目录名以 `EMB` 结尾 ⇒ LR 形态：只有 `data0..data7` 算徽章槽，其余文件（`icon.sys`
 *      之类的副本、同名的 32 B 头文件）忽略。
 *   2. 目录名以 `E##` 结尾 ⇒ 每个目录就是**一个**槽；槽号取自目录名的 `E##`。
 *      目录里那个"与目录同名"的文件才是徽章；找不到就用目录里最长的非 dot 文件兜底。
 *   3. 其它目录**不**参与（不按名字猜）。
 *   4. 空槽（`occupied: false`）也要出现在结果里 —— SPEC.md §四"空的显示 ＋新建"。
 *
 * ⚠ 判据与 `card.ts::isEmblemArchiveDirName()` 一致（按名字：`E\d\d$` / `EMB$`）；这里再判一次，
 *   因为调用方可能把根目录**全部**条目都传进来。
 *
 * ★ 0.19：不再 `export`（外部只用 `buildGameSlotModel()`；测试也改走它），
 *   免得"忘了过滤"这种事从旁路绕回来。
 */
function buildSlotModel(dirs: readonly SlotDirLike[]): SlotModel {
  const slots: SlotInfo[] = [];
  for (let i = 0; i < SLOT_COUNT; i++) {
    slots.push({
      index: i,
      displayNumber: i + 1,
      dirName: '',
      dirSlotIndex: null,
      isLrArchive: false,
      occupied: false,
      fileName: null,
      length: 0,
      cluster: 0,
      expectedFileName: LR_FILE_NAMES[i],
    });
  }

  const dirNames: string[] = [];
  const perSlotDirIndices: number[] = [];
  let hasLrArchive = false;

  for (const dir of dirs) {
    const upper = dir.name.toUpperCase();
    const isLrArchive = upper.endsWith('EMB');
    const eMatch = /E(\d\d)$/.exec(upper);
    if (!isLrArchive && !eMatch) continue; // 不认这个目录
    dirNames.push(dir.name);

    if (isLrArchive) {
      hasLrArchive = true;
      for (const e of dir.entries) {
        if (isDotName(e.name) || e.isDir) continue;
        const li = localIndexFromFileName(e.name);
        if (li === null) continue;
        const slot = slots[li];
        // 同名重复时保留**先出现的**（与 `listDir` 的顺序一致），并留痕给调用方
        if (slot.occupied) continue;
        slot.dirName = dir.name;
        slot.isLrArchive = true;
        slot.occupied = e.length > 0;
        slot.fileName = e.name;
        slot.length = e.length;
        slot.cluster = e.cluster;
      }
      continue;
    }

    const dirIndex = Number(eMatch![1]);
    if (!perSlotDirIndices.includes(dirIndex)) perSlotDirIndices.push(dirIndex);
    // 一个 `E##` 目录只占**一个**槽：优先就地槽号 = dirIndex
    const li = dirIndex < SLOT_COUNT ? dirIndex : dirIndex % SLOT_COUNT;
    const slot = slots[li];
    if (slot.occupied || slot.dirName) continue;

    const named = dir.entries.find((e) => !isDotName(e.name) && !e.isDir && e.name.toUpperCase() === upper);
    let pick = named;
    if (!pick) {
      // 兜底：目录里最长的非 dot 文件（真卡上就是徽章本体）
      for (const e of dir.entries) {
        if (isDotName(e.name) || e.isDir) continue;
        if (!pick || e.length > pick.length) pick = e;
      }
    }
    slot.dirName = dir.name;
    slot.dirSlotIndex = dirIndex;
    slot.isLrArchive = false;
    slot.occupied = !!pick && pick.length > 0;
    slot.fileName = pick ? pick.name : null;
    slot.length = pick ? pick.length : 0;
    slot.cluster = pick ? pick.cluster : 0;
  }

  perSlotDirIndices.sort((a, b) => a - b);
  return { slots, dirNames, hasLrArchive, perSlotDirIndices, excludedDirNames: [], serial: null };
}

/**
 * ★ 一站式：卡上的全部徽章目录 + 当前作品 ⇒ 该作品的 8 槽模型。
 *
 * 这是 `cardOps.ts::reloadModel()` 唯一该调的函数；把"过滤"与"建模型"绑在一起，
 * 是为了让"忘了过滤"这件事在类型上就不可能发生。
 */
export function buildGameSlotModel(
  dirs: readonly SlotDirLike[],
  filter: SlotFilter | null | undefined,
): SlotModel {
  const f = filterDirsForGame(dirs, filter);
  const model = buildSlotModel(f.included);
  model.excludedDirNames = f.excluded.map((d) => d.name);
  model.serial = f.serial;
  return model;
}

/**
 * 把一串目录名压成一行好读的文字：连续的同前缀 `E##` 目录会合并。
 *
 *   `['BISLPS-25338E00','BISLPS-25338E01','BISLPS-25338E02','BISLPS-25169E00','BISLPS-25169E01']`
 *   → `` `BISLPS-25338E00…E02、BISLPS-25169E00、BISLPS-25169E01` ``
 *
 * ★ 为什么要"压缩"而不是直接 `join('、')`：这张卡上可能有 8+8+8+8 个 `E##` 目录，
 *   不压的话摘要行会变成几百字的一坨，用户根本读不出来"卡上还有哪些作品"。
 *   压缩只在**同前缀且槽号连续**时发生，绝不合并不同作品 —— 每个作品的目录名一定出现一次。
 */
export function compressDirNames(names: readonly string[]): string {
  /** 前缀（大写）→ { 原始大小写前缀, { 槽号 → 原始目录名 } }，并记住前缀出现顺序。 */
  const groups = new Map<string, { base: string; members: Map<number, string> }>();
  const order: string[] = [];
  const others: string[] = [];
  for (const n of names) {
    const m = /^(.*)E(\d\d)$/.exec(n.toUpperCase());
    if (!m) {
      others.push(n);
      continue;
    }
    const key = m[1];
    if (!groups.has(key)) {
      groups.set(key, { base: n.slice(0, n.length - 3), members: new Map() });
      order.push(key);
    }
    groups.get(key)!.members.set(Number(m[2]), n);
  }
  const parts: string[] = [];
  for (const key of order) {
    const g = groups.get(key)!;
    const idx = [...g.members.keys()].sort((a, b) => a - b);
    // 连续的槽号合并成 `起始…末尾`；不连续就一个个列（绝不合并不同作品）
    const runs: Array<[number, number]> = [];
    for (const i of idx) {
      const last = runs[runs.length - 1];
      if (last && i === last[1] + 1) last[1] = i;
      else runs.push([i, i]);
    }
    for (const [a, b] of runs) {
      const pad = (v: number): string => String(v).padStart(2, '0');
      parts.push(a === b ? g.members.get(a)! : `${g.base}E${pad(a)}…E${pad(b)}`);
    }
  }
  return [...parts, ...others].join('、');
}

/** 空槽统计（界面状态行用）。 */
export function slotSummary(model: SlotModel): { occupied: number; empty: number; total: number } {
  let occupied = 0;
  for (const s of model.slots) if (s.occupied) occupied += 1;
  return { occupied, empty: SLOT_COUNT - occupied, total: SLOT_COUNT };
}

/**
 * ★ 8 槽摘要行的**唯一**文案来源（界面直接用它，测试直接断言它）。
 *
 * 形如：
 * ```
 * 占用 5 / 8　空 3　（本作品目录：BISLPS-25462EMB）　卡上还有其它作品：BISLPS-25338E00…E04、BISLPS-25169E00、BISLPS-25169E01（切作品查看）
 * ```
 *
 * ★ "卡上还有其它作品"这一句是**硬要求**：过滤之后必须让用户看见"被隐藏了什么"，
 *   否则他会以为卡里没东西（这正是这次修的那个问题的另一半）。
 */
export function slotSummaryText(model: SlotModel | null): string {
  if (!model) return '还没有打开记忆卡';
  const s = slotSummary(model);
  const mine = model.dirNames.length ? model.dirNames.join('、') : '（卡上没有这个作品的目录 ⇒ 8 个槽都是空的）';
  let text = `占用 ${s.occupied} / ${s.total}　空 ${s.empty}　（本作品目录：${mine}）`;
  if (model.excludedDirNames.length) {
    text += `　卡上还有其它作品：${compressDirNames(model.excludedDirNames)}（切作品查看）`;
  }
  return text;
}

/** 过滤后"本作品一个目录都没有"时给用户的那句话（打开卡与切作品都要说）。 */
export function noDirForGameText(serial: string | null, excludedCount: number): string {
  const what = serial ? `这个作品（${serial}）` : '当前作品';
  const tail = excludedCount
    ? `卡上有 ${excludedCount} 个**别的作品**的徽章目录（见 8 槽摘要行，切作品就能看到）。`
    : '这张卡上没有任何徽章目录（E## / EMB）。';
  return `卡上没有${what}的徽章目录 —— ${tail}想往这个作品里存，请先在游戏里存一个徽章（让游戏把目录建出来）。`;
}
