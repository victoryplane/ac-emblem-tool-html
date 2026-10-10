/**
 * ★ 写入目标规划（纯函数，零依赖 DOM）—— 决定"这一槽要写进哪个目录的哪个文件"。
 *
 * 抽出来的理由：这段逻辑曾经在 `cardOps.ts` 里、并且**隐式依赖一张真卡**
 * （整卡目录名 + `state.card`），于是"过滤之后写入结论对不对"这件事**没法自动测**。
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
import { t } from './i18n.ts';
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
  /**
   * 拒绝理由（**一行**，写给用户看：为什么写不了 + 怎么办）。
   * ★ 0.43（用户："这部分提示过于重复了"）：原来是两三行的长句，而同一件事还会出现在日志、toast、
   *   状态行里 ⇒ 现在只留**一句能照做的**；机制解释挪到 `errorDetail`（界面上做 hover 提示）。
   */
  error: string | null;
  /**
   * ★ 0.43：拒绝理由的**机制解释**（"为什么卡层不能直接建目录"这种）。
   * 它不帮用户"怎么办"，所以不占正文位置 —— 界面把它放进 `title`（鼠标停一下才看）。
   */
  errorDetail?: string | null;
  /**
   * ★ 0.43：拒绝理由的**一句话标签**（形如 `缺作品目录`）。
   * 状态行与 toast 用它（"写入被拒绝：缺作品目录（见上方提示行）"），不再复述正文。
   */
  errorShort?: string | null;
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

/**
 * 只有拒绝理由、没有目标的返回（四个分支共用）。
 *
 * @param error 一行正文（为什么写不了 + 怎么办）
 * @param short 一句话标签（`errorShort`，给状态行 / toast 用）
 * @param detail 机制解释（`errorDetail`，界面做 hover）
 */
function rejected(error: string, short: string | null = null, detail: string | null = null): WritePlan {
  return { target: null, warning: null, error, errorShort: short, errorDetail: detail };
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
  if (!model) return rejected(t('还没有打开记忆卡', 'No memory card loaded yet', 'まだメモリーカードを開いていません', '아직 메모리 카드를 열지 않았습니다'));

  const slot = model.slots[slotIndex];
  if (!slot) {
    return rejected(
      t(`槽位 ${slotIndex + 1} 不存在`, `Slot ${slotIndex + 1} does not exist`, `スロット ${slotIndex + 1} は存在しません`, `슬롯 ${slotIndex + 1}이(가) 존재하지 않습니다`),
      t('槽位不存在', 'no such slot', 'スロットが存在しません', '슬롯이 존재하지 않습니다'),
    );
  }

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
    // ★ 0.43：正文压成**一行**（"为什么写不了 + 怎么办"），机制解释进 `errorDetail`（hover 才看）。
    //   ⚠ 正文与 hover 都是**纯文本**（`textContent` / `title`）⇒ 不许写 `**强调**`
    //     （那会原样显示成星号，用户看到的是一堆 `**`）。
    return rejected(
      t(
        `槽位 ${slotIndex + 1}：卡上没有目录 ${dirName} —— ` +
          (onCardButOtherGame
            ? '卡上有这个目录名，但它不属于当前作品（或序列号不对），请确认下拉框选的作品对不对。'
            : '先在游戏里为这个作品存一个徽章（进一次徽章画面，让它把目录建出来），再回来写。'),
        `Slot ${slotIndex + 1}: the card has no folder ${dirName} - ` +
          (onCardButOtherGame
            ? 'the card does have a folder with this name, but it does not belong to the selected game (or the serial does not match); check the game dropdown.'
            : 'save one emblem in that game first (open the emblem screen once so the game creates the folder), then come back.'), `スロット ${slotIndex + 1}：カード上にフォルダ ${dirName} がありません —— ${onCardButOtherGame ? 'カード上にこのフォルダ名はありますが、現在のタイトルのものではありません（またはシリアルが違います）。タイトルの選択を確認してください。' : '先にそのタイトルでエンブレムを 1 つ保存し（エンブレム画面を一度開いてフォルダを作らせます）、それから戻って書き込んでください。'}`, `슬롯 ${slotIndex + 1}: 카드에 폴더 ${dirName} 이(가) 없습니다 —— ${onCardButOtherGame ? '카드에 이 폴더 이름은 있지만 현재 타이틀의 것이 아닙니다(또는 시리얼이 다릅니다). 타이틀 선택을 확인하세요.' : '먼저 그 타이틀에서 엠블럼을 하나 저장하고(엠블럼 화면을 한 번 열어 폴더를 만들게 합니다), 돌아와서 쓰세요.'}`,
      ),
      t('缺作品目录', "this game's folder is missing", 'タイトルのフォルダがありません', '타이틀 폴더가 없습니다'),
      isLr
        ? t(
            '卡层只会在已有目录里新建文件，不会新建目录；LR 的 EMB 目录是游戏在第一次存徽章时建出来的。',
            'The card layer only creates files inside existing folders - it never creates a folder; the LR EMB folder is created by the game the first time you save an emblem.', 'カード層は既存のフォルダの中にファイルを作るだけで、フォルダは新規作成しません。LR の EMB フォルダは、初めてエンブレムを保存したときにゲームが作成したものです。', '카드 계층은 기존 폴더 안에 파일만 만들 뿐, 폴더를 새로 만들지는 않습니다. LR의 EMB 폴더는 처음 엠블럼을 저장할 때 게임이 만든 것입니다.',
          )
        : t(
            '卡层只会在已有目录里新建文件，不会新建目录；非 LR 的每个槽是一个完整存档目录' +
              '（除徽章还有 icon.sys 与图标文件），只建目录会写出游戏不认的半成品。',
            'The card layer only creates files inside existing folders - it never creates a folder; each non-LR slot is a complete save folder ' +
              '(it also holds icon.sys and icon files), so creating only the folder would produce something the game will not accept.', `カード層は既存のフォルダの中にしかファイルを作りません（フォルダは作りません）。非 LR の各スロットは完全なセーブフォルダで（エンブレムのほかに icon.sys とアイコンファイルも入ります）、フォルダだけ作るとゲームが受け付けない半端なものができます。`, `카드 계층은 기존 폴더 안에만 파일을 만들고 폴더는 만들지 않습니다. 비 LR의 각 슬롯은 완전한 세이브 폴더이며(엠블럼 외에 icon.sys 와 아이콘 파일도 들어 있습니다), 폴더만 만들면 게임이 인식하지 못하는 반쪽짜리가 됩니다.`,
          ),
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
      warning: t(
        `槽位 ${slotIndex + 1}：目录 ${dirName} 里已有 ${existing}，但模型判定该槽为空 —— 将以覆盖方式写它。`,
        `Slot ${slotIndex + 1}: folder ${dirName} already contains ${existing}, but the model says this slot is empty - it will be overwritten.`, `スロット ${slotIndex + 1}：フォルダ ${dirName} にはすでに ${existing} がありますが、モデルはこのスロットを空と判定しています —— 上書きとして書き込みます。`, `슬롯 ${slotIndex + 1}: 폴더 ${dirName}에 이미 ${existing}이(가) 있지만, 모델은 이 슬롯을 비어 있다고 판정했습니다 —— 덮어쓰기 방식으로 씁니다.`,
      ),
      error: null,
    };
  }
  const fileName = `${ctx.prefix}${ctx.serial}${dirName.slice(-3)}`;
  return {
    target: { slotIndex, dirName, fileName, isNew: true, cluster: 0, length: 0 },
    warning: t(
      `槽位 ${slotIndex + 1}：目录 ${dirName} 里没有"与目录同名"的徽章文件，将新建 ${fileName}。` +
        '游戏可能还需要同目录里的 icon.sys / 图标文件才会显示这个槽。',
      `Slot ${slotIndex + 1}: folder ${dirName} has no emblem file named after the folder; ${fileName} will be created. ` +
        'The game may also need icon.sys / icon files in that folder before it shows the slot.', `スロット ${slotIndex + 1}：フォルダ ${dirName} に「フォルダと同名」のエンブレムファイルがないため、${fileName} を新規作成します。ゲームがこのスロットを表示するには、同じフォルダ内の icon.sys / アイコンファイルも必要かもしれません。`, `슬롯 ${slotIndex + 1}: 폴더 ${dirName} 에 "폴더와 같은 이름"의 엠블럼 파일이 없어 ${fileName} 을(를) 새로 만듭니다. 게임이 이 슬롯을 표시하려면 같은 폴더의 icon.sys / 아이콘 파일도 필요할 수 있습니다.`,
    ),
    error: null,
  };
}
