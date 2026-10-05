/**
 * ★ 写入目标规划（纯函数，零依赖 DOM）—— 决定"这一槽要写进哪个目录的哪个文件"。
 *
 * 抽出来的理由：这段逻辑曾经在 `cardOps.ts` 里、并且**隐式依赖一张真卡**
 * （`scanCard()` + `state.card`），于是"过滤之后写入结论对不对"这件事**没法自动测**。
 * 2026-10-04 修的那个 bug（切作品时 8 槽不变）的另一面正好落在这里：
 * 模型变成"按当前作品过滤"之后，"目录不存在"就有两种含义 ——
 *   ① 卡上真没有这个目录；
 *   ② 卡上有这个目录，但它不属于当前作品。
 * 两种都必须**拒绝写入**，但话术必须分开（否则用户会白跑一趟游戏）。
 *
 * 本模块不做任何 I/O；`cardDirNames` 由调用方扫描后传进来。
 *
 * ★ 0.21：入参从"要写哪几个槽"（`slotIndices: number[]`）收成**一个槽**，返回值也从
 *   `targets[]/warnings[]/errors[]` 收成 `target/warning/error` ——〔批量写 8 槽〕已按用户要求删除，
 *   写入路径上再没有"一次多个目标"这回事。
 */

import { dirNameFor, type GameContext } from './games.ts';
import type { SlotModel } from './slots.ts';

export interface WriteTarget {
  slotIndex: number;
  dirName: string;
  fileName: string;
  isNew: boolean;
  cluster: number;
  length: number;
}

export interface WritePlan {
  /** 唯一的目标；被拒绝时为 null。 */
  target: WriteTarget | null;
  /** 一条提醒（不是拒绝理由），没有则 null。 */
  warning: string | null;
  /** 拒绝理由；可以写时是 null。 */
  error: string | null;
}

export interface PlanInput {
  /** 当前作品的 8 槽模型（`state.model`，**已经按作品过滤过**）。 */
  model: SlotModel | null;
  /** 卡上**全部**徽章目录名（不过滤）——用来区分上面说的 ①/②。 */
  cardDirNames: readonly string[];
  /** 当前作品上下文。 */
  ctx: GameContext;
  /** 要写哪一个就地槽号（0..7）。 */
  slotIndex: number;
  /** 某个 `E##` 目录里"与目录同名"的徽章文件名（没有则 null）；非 LR 用。 */
  emblemFileInDir?: (dirName: string) => string | null;
}

/** 只有拒绝理由、没有目标的返回（四个分支共用）。 */
function rejected(error: string): WritePlan {
  return { target: null, warning: null, error };
}

/**
 * 规划**一个槽**的写入目标。
 *
 * LR：目录恒为 `…EMB`，文件名恒为 `dataN`（N = 就地槽号）；目录**必须已存在**
 *   —— 卡层不会新建目录（`card.ts::CreateFileResult` 只讲"在目录里新建文件"）。
 * 非 LR：该槽的 `E##` 目录必须已存在；里面的文件名优先用"与目录同名"的那个。
 *
 * ★ 为什么"目录不存在"是**拒绝**而不是"顺手建一个"：
 *   非 LR 的每个槽是一个完整存档目录，里面除了徽章还有 `icon.sys` 与图标文件
 *   （`docs\01-项目理解\04-记忆卡与存档处理.md` §四）。只建目录 + 一个徽章文件
 *   写出来的是**游戏不认的半成品**，比"让用户先进一次游戏"糟得多。
 */
export function planWriteTargetIn(input: PlanInput): WritePlan {
  const { model, ctx, slotIndex } = input;
  if (!model) return rejected('还没有打开记忆卡');

  const slot = model.slots[slotIndex];
  if (!slot) return rejected(`槽位 ${slotIndex + 1} 不存在`);

  // ① 槽里已经有东西 ⇒ 覆盖它（原地覆盖就是"写进它那条簇链"）
  if (slot.occupied && slot.fileName) {
    return {
      target: {
        slotIndex,
        dirName: slot.dirName,
        fileName: slot.fileName,
        isNew: false,
        cluster: slot.cluster,
        length: slot.length,
      },
      warning: null,
      error: null,
    };
  }

  const dirName = dirNameFor(ctx, slotIndex);
  if (!model.dirNames.some((d) => d.toUpperCase() === dirName.toUpperCase())) {
    const onCardButOtherGame = input.cardDirNames.map((n) => n.toUpperCase()).includes(dirName.toUpperCase());
    const isLr = ctx.entry.form === 'lr-archive';
    return rejected(
      `槽位 ${slotIndex + 1}：卡上没有目录 ${dirName}，而卡层**只会在已有目录里新建文件**、不会新建目录。\n` +
        (onCardButOtherGame
          ? '  ⇒ 卡上**有**这个目录名，但它不属于当前作品（或不是当前作品的序列号）—— 请确认下拉框选的作品对不对。'
          : isLr
            ? '  ⇒ 请先在游戏里为这个作品**存一个徽章**（进一次徽章画面，让 LR 自己把 EMB 目录建出来），再回来写。'
            : '  ⇒ 非 LR 的每个槽是一个**完整存档目录**（除徽章还有 icon.sys 与图标文件），' +
              '只建目录会写出游戏不认的半成品。请先在游戏里为这个作品**存一个徽章**。'),
    );
  }

  if (ctx.entry.form === 'lr-archive') {
    // LR 目录里允许中间有空缺（实机验证过 data0/1/2/7 同时存在）
    return {
      target: { slotIndex, dirName, fileName: `data${slotIndex}`, isNew: true, cluster: 0, length: 0 },
      warning: null,
      error: null,
    };
  }

  const existing = input.emblemFileInDir ? input.emblemFileInDir(dirName) : null;
  if (existing) {
    return {
      target: { slotIndex, dirName, fileName: existing, isNew: false, cluster: 0, length: 0 },
      warning: `槽位 ${slotIndex + 1}：目录 ${dirName} 里已有 ${existing}，但模型判定该槽为空 —— 将以**覆盖**方式写它。`,
      error: null,
    };
  }
  const fileName = `${ctx.prefix}${ctx.serial}${dirName.slice(-3)}`;
  return {
    target: { slotIndex, dirName, fileName, isNew: true, cluster: 0, length: 0 },
    warning:
      `槽位 ${slotIndex + 1}：目录 ${dirName} 里没有"与目录同名"的徽章文件，将新建 ${fileName}。` +
      '游戏可能还需要同目录里的 icon.sys / 图标文件才会显示这个槽。',
    error: null,
  };
}
