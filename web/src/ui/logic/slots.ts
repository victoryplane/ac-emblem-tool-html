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
import { t } from './i18n.ts';

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
function isEmblemDirName(name: string): boolean {
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
    // 既不算本作品、也不算"别的作品"—— 混进来只会把统计与警告说错。
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
 *   4. 空槽（`occupied: false`）也要出现在结果里 —— 界面上就是一个大「＋」（SPEC.md §四）。
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
 * 过滤后"本作品一个目录都没有"时给用户的那句话（打开卡与切作品都要说）。
 *
 * ★ 0.37（用户）：原来这句话里还带一句"见 8 槽摘要行" —— 那行摘要（占用与空槽数、当前作品的
 *   目录名、卡上其它作品的清单）已按用户要求**整句删除**（`slotsView.ts` 里现在只剩一条条件警告），
 *   所以这里改成直接说"卡上有 N 个别的作品的徽章目录（切作品就能看到）"。
 *
 * ★ 0.43（用户："我觉得这部分的提示过于重复了"）：压成**一句能照做的**（"⇒ 先在游戏里存一个
 *   徽章"），后面只挂一个短尾巴（卡上还有几个别的作品的目录 / 或"这张卡上什么都没有"）。
 *   原来它是"没有目录 —— 卡上有 N 个别的作品的目录 —— 想存就先存一个徽章"的三段式，
 *   而同一件事还会在 8 槽上方那条常驻警告、打开卡时的 toast、切作品的状态行各说一遍。
 *   ⚠ 这个函数必须能**按当前语言重算**（切语言时 `setStatus(text, redo)` 会再调一次），
 *     所以它不收语言参数、也不缓存字符串。
 */
export function noDirForGameText(serial: string | null, excludedCount: number): string {
  const what = serial ? t(`这个作品（${serial}）`, `this game (${serial})`, `この作品（${serial}）`, `이 작품(${serial})`) : t('当前作品', 'the selected game', '現在の作品', '현재 작품');
  const tail = excludedCount
    ? t(
        // ⚠ 状态行是**纯文本** ⇒ 这里不许写 `**别的作品**`（会原样显示成星号）
        `　卡上还有 ${excludedCount} 个别的作品的徽章目录（切作品查看）。`,
        ` The card also holds emblem folders for ${excludedCount} other games (switch game to view them).`, `　カード上にはまだ ${excludedCount} 個の別タイトルのエンブレムフォルダがあります（タイトルを切り替えて表示）。`, `　카드에는 아직 ${excludedCount}개 다른 타이틀의 엠블럼 폴더가 있습니다(타이틀을 전환해 확인).`,
      )
    : t('　这张卡上没有任何徽章目录。', ' This card has no emblem folders at all.', '　このカードにはエンブレムフォルダが 1 つもありません。', '　이 카드에는 엠블럼 폴더가 하나도 없습니다.');
  return t(
    `${what}在卡上还没有徽章目录 ⇒ 先在游戏里存一个徽章（让游戏把目录建出来），再回来写。${tail}`,
    `${what} has no emblem folder on the card yet, so save one emblem in the game first (that is what creates the folder), then come back.${tail}`, `${what}のエンブレムフォルダはまだカード上にありません ⇒ まずゲーム内でエンブレムを 1 つ保存して（それでフォルダが作られます）、それから戻って書き込んでください。${tail}`, `${what}의 엠블럼 폴더가 아직 카드에 없습니다 ⇒ 먼저 게임에서 엠블럼을 하나 저장해 (그래야 폴더가 만들어집니다) 다시 돌아와서 쓰세요.${tail}`,
  );
}
