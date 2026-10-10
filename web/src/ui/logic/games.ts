/**
 * 作品表 —— 纯逻辑，零依赖、不碰 DOM（可被 Node 直接 import 测试）。
 *
 * 依据（**只放有依据的东西，绝不编造**）：
 *   · `docs\01-项目理解\04-记忆卡与存档处理.md` §六「游戏码总表」 —— 盘序列号逐个列出；
 *     同节还实测确认了保存目录名的前缀规则：**美版 `BA`、日版 `BI`**，
 *     欧版 `[未观测]`（文档明说"没有证据，不要照抄上游 README 的猜测"）。
 *   · `SPEC.md` §七「支持的作品（第一版七个全上）」 —— 哪些标 ✅（有实机证据）、
 *     哪些标 ⚠「未验证」。
 *   · `src/core/emblem.ts::KNOWN_HEADER_TAIL` —— 只有 SL(日/美) 与 Nexus(日) 有值，
 *     所以"非 LR 新建槽"能不能填对那 9 字节作品常量，是**按作品**分档的。
 *
 * ⚠ 本文件里**没有一个**是推测出来的盘序列号。`verified` 的语义严格是
 *   "本项目手上有真实存档样本 / 实机验证过"，不是"这个游戏存在"。
 */

import { t } from './i18n.ts';

/** 存档目录名的布局：LR 是单个 `…EMB` 目录包 8 个 `dataN`；其余是每槽一个 `…E##` 目录。 */
export type WorksForm = 'per-slot' | 'lr-archive';

export interface GameEntry {
  /** 稳定 id（UI 的 `<select>` 用它做 value；不要改，会被测试钉住）。 */
  id: string;
  /** 界面显示名（中文）。★ 0.28：英文见 `en`，渲染时用 `t(label, en)`。 */
  label: string;
  /** 界面显示名（英文，0.28）。 */
  en: string;
  /** 本项目手上**有**盘序列号能填吗（自定义项 = false，它由用户手填）。 */
  hasSerial: boolean;
  /** 建议的盘序列号（无依据时是 `''`，不是猜的）。 */
  serial: string;
  /** 存档形态。 */
  form: WorksForm;
  /**
   * true = 本项目有**真实样本 / 实机验证**（SPEC.md §七 的 ✅）；
   * false = 规则相同但**无真实样本** ⇒ UI 必须显示「未验证」（SPEC.md §七 的 ⚠）。
   */
  verified: boolean;
  /** 给用户的一句话说明（为什么是未验证 / 有什么限制）。 */
  note: string;
  /** 那句话的英文（0.28）。 */
  noteEn: string;
  /** ★ 0.47：日语（作品名保留英文，只翻地区后缀）。 */
  ja: string;
  /** ★ 0.47：韩语。 */
  ko: string;
  /** ★ 0.47：日语的 `note`。 */
  noteJa: string;
  /** ★ 0.47：韩语的 `note`。 */
  noteKo: string;
}

/** 允许出现在自定义序列号里的系列码（Redump / PCSX2 wiki 口径，见文档 §六）。 */
export const SERIAL_KINDS: readonly string[] = [
  'SLUS', 'SLES', 'SLPS', 'SLPM', 'SCUS', 'SCES', 'SCPS', 'SCCS', 'SLKA', 'SLED', 'SCAJ',
];

/** 作品列表。`custom` 恒在最后。 */
export const GAMES: readonly GameEntry[] = [
  {
    id: 'sl-us',
    label: 'Silent Line 美版',
    en: 'Silent Line (US)',
  ja: 'Silent Line 北米版',
  ko: 'Silent Line 북미판',
    hasSerial: true,
    serial: 'SLUS-20644',
    form: 'per-slot',
    verified: true,
    note: '真实样本 BASLUS-20644E02（公开存档库）+ 实机验证；作品常量已在 KNOWN_HEADER_TAIL 里。',
    noteEn: 'Real sample BASLUS-20644E02 (public save archive) + verified on hardware; the game constant is in KNOWN_HEADER_TAIL.',
  noteJa: '実サンプル BASLUS-20644E02（公開セーブアーカイブ）+ 実機で確認済み。作品定数は KNOWN_HEADER_TAIL にあります。',
  noteKo: '실제 샘플 BASLUS-20644E02 (공개 세이브 아카이브) + 실기에서 확인됨. 작품 상수는 KNOWN_HEADER_TAIL 에 있습니다.',
  },
  {
    id: 'sl-jp',
    label: 'Silent Line 日版',
    en: 'Silent Line (JP)',
  ja: 'Silent Line 日本版',
  ko: 'Silent Line 일본판',
    hasSerial: true,
    serial: 'SLPS-25169',
    form: 'per-slot',
    verified: true,
    note: 'BISLPS-25169E## 有实机验证样本；作品常量已在 KNOWN_HEADER_TAIL 里。',
    noteEn: 'BISLPS-25169E## samples verified on hardware; the game constant is in KNOWN_HEADER_TAIL.',
  noteJa: 'BISLPS-25169E## に実機で確認済みのサンプルがあります。作品定数は KNOWN_HEADER_TAIL にあります。',
  noteKo: 'BISLPS-25169E## 에 실기에서 확인된 샘플이 있습니다. 작품 상수는 KNOWN_HEADER_TAIL 에 있습니다.',
  },
  {
    id: 'nx-jp',
    label: 'Nexus 日版',
    en: 'Nexus (JP)',
  ja: 'Nexus 日本版',
  ko: 'Nexus 일본판',
    hasSerial: true,
    serial: 'SLPS-25338',
    form: 'per-slot',
    verified: true,
    note: 'BISLPS-25338E## 有实机验证样本（E00..E04）。',
    noteEn: 'BISLPS-25338E## samples verified on hardware (E00..E04).',
  noteJa: 'BISLPS-25338E## に実機で確認済みのサンプルがあります（E00..E04）。',
  noteKo: 'BISLPS-25338E## 에 실기에서 확인된 샘플이 있습니다 (E00..E04).',
  },
  {
    id: 'lr-jp',
    label: 'Last Raven 日版',
    en: 'Last Raven (JP)',
  ja: 'Last Raven 日本版',
  ko: 'Last Raven 일본판',
    hasSerial: true,
    serial: 'SLPS-25462',
    form: 'lr-archive',
    verified: true,
    note: 'BISLPS-25462EMB\\data0..7，含"新建槽"实机验证。',
    noteEn: 'BISLPS-25462EMB\\data0..7, including a hardware-verified "create new slot".',
  noteJa: 'BISLPS-25462EMB\\data0..7、「新規スロット作成」の実機確認を含みます。',
  noteKo: 'BISLPS-25462EMB\\data0..7, "새 슬롯 만들기" 실기 확인 포함.',
  },
  {
    id: 'ac3',
    label: 'AC3',
    en: 'AC3',
  ja: 'AC3',
  ko: 'AC3',
    hasSerial: true,
    serial: 'SLUS-20435',
    form: 'per-slot',
    verified: false,
    note: '⚠ 未验证：目录名规则相同，但本项目手上没有 AC3 的 E## 真实样本。',
    noteEn: '⚠ Unverified: same naming rules, but this project has no real AC3 E## sample.',
  noteJa: '⚠ 未検証：ディレクトリ名の規則は同じですが、本プロジェクトには AC3 の E## 実サンプルがありません。',
  noteKo: '⚠ 미검증: 디렉터리 이름 규칙은 같지만, 이 프로젝트에는 AC3 의 E## 실제 샘플이 없습니다.',
  },
  {
    id: 'ac2',
    label: 'AC2',
    en: 'AC2',
  ja: 'AC2',
  ko: 'AC2',
    hasSerial: true,
    serial: 'SLUS-20014',
    form: 'per-slot',
    verified: false,
    note: '⚠ 未验证：没有真实徽章样本。',
    noteEn: '⚠ Unverified: no real emblem sample.',
  noteJa: '⚠ 未検証：実サンプルのエンブレムがありません。',
  noteKo: '⚠ 미검증: 실제 엠블럼 샘플이 없습니다.',
  noteJa: '⚠ 未検証：実サンプルのエンブレムがありません。',
  noteKo: '⚠ 미검증: 실제 엠블럼 샘플이 없습니다.',
  noteJa: '⚠ 未検証：実サンプルのエンブレムがありません。',
  noteKo: '⚠ 미검증: 실제 엠블럼 샘플이 없습니다.',
  },
  {
    id: 'ac2aa',
    label: 'AC2: Another Age',
    en: 'AC2: Another Age',
  ja: 'AC2: Another Age',
  ko: 'AC2: Another Age',
    hasSerial: true,
    serial: 'SLUS-20249',
    form: 'per-slot',
    verified: false,
    note: '⚠ 未验证：没有真实徽章样本。',
    noteEn: '⚠ Unverified: no real emblem sample.',
  },
  {
    id: 'nb',
    label: 'Nine Breaker',
    en: 'Nine Breaker',
  ja: 'Nine Breaker',
  ko: 'Nine Breaker',
    hasSerial: true,
    serial: 'SLUS-21200',
    form: 'per-slot',
    verified: false,
    note: '⚠ 未验证：没有真实徽章样本。',
    noteEn: '⚠ Unverified: no real emblem sample.',
  },
  {
    id: 'custom',
    label: '自定义（手填盘序列号）',
    en: 'Custom (type disc serial)',
  ja: 'カスタム（ディスクのシリアルを入力）',
  ko: '사용자 지정 (디스크 시리얼 입력)',
    hasSerial: false,
    serial: '',
    form: 'per-slot',
    verified: false,
    note: '给上面没有的作品兜底：手填盘序列号（如 SLES-51399）。⚠ 前缀与规则照抄不一定对，属未验证用法。',
    noteEn: 'Fallback for titles not listed above: type the disc serial (e.g. SLES-51399). ⚠ The prefix and rules are copied, not verified.',
  noteJa: '上にない作品向けのフォールバック：ディスクのシリアルを手入力します（例：SLES-51399）。⚠ プレフィックスと規則は流用したもので、正しいとは限らず未検証の使い方です。',
  noteKo: '위에 없는 작품을 위한 대체: 디스크 시리얼을 직접 입력합니다 (예: SLES-51399). ⚠ 접두사와 규칙은 그대로 옮겨 온 것이라 반드시 맞지는 않으며 미검증 사용법입니다.',
  },
];

export function findGame(id: string): GameEntry | undefined {
  return GAMES.find((g) => g.id === id);
}

/** 默认选中的作品：LR 日版（唯一"新建槽"走过实机的形态）。 */
export const DEFAULT_GAME_ID = 'lr-jp';

// --------------------------------------------------------------------------
// 自定义盘序列号
// --------------------------------------------------------------------------

export interface ParsedSerial {
  /** 归一化后的序号部分，例如 `SLPS-25169`。 */
  serial: string;
  /** 2 字母前缀（区域码），例如 `BI`。 */
  prefix: string;
}

/**
 * 解析用户手填的盘序列号。
 *
 * 接受：`SLUS-20644` / `slus20644` / `BI SLPS-25169` / `BISLPS-25169` / `BASLUS-20435`。
 * 拒绝：空、缺序号、系列码不在白名单、前缀不是 BA/BI/BE。
 *
 * ★ 为什么前缀必须校验：`docs\01-项目理解\04-记忆卡与存档处理.md` §六 实测日版是 `BI`，
 *   而且文档专门记了"早先凭空推成 BASCPS-… 是错的" —— 所以这里宁可报错让人手改，
 *   也不替用户猜区域前缀。
 */
export function parseSerial(input: string): ParsedSerial | { error: string } {
  let s = String(input == null ? '' : input).trim().toUpperCase();
  if (!s) return { error: t('盘序列号不能为空', 'The disc serial cannot be empty', 'ディスクのシリアルは空にできません', '디스크 시리얼은 비워 둘 수 없습니다') };
  s = s.replace(/\s+/g, '');

  let prefix = '';
  // 先剥掉可能已经带上的 2 字母区域前缀
  const m0 = /^(BA|BI|BE)([A-Z]{4}-?\d{3,5})$/.exec(s);
  if (m0) {
    prefix = m0[1];
    s = m0[2];
  }
  // 再剥掉一个多余的分隔符
  s = s.replace(/^-/, '');

  const kind = s.slice(0, 4);
  if (!SERIAL_KINDS.includes(kind)) {
    return {
      error: t(
        `系列码 "${kind || s}" 不认识（应为 ${SERIAL_KINDS.join(' / ')} 之一）`,
        `Unknown publisher code "${kind || s}" (expected one of ${SERIAL_KINDS.join(' / ')})`, `出版社コード "${kind || s}" を認識できません（${SERIAL_KINDS.join(' / ')} のいずれかである必要があります）`, `퍼블리셔 코드 "${kind || s}" 를 알 수 없습니다 (${SERIAL_KINDS.join(' / ')} 중 하나여야 합니다)`,
      ),
    };
  }
  const rest = s.slice(4);
  const digits = rest.startsWith('-') ? rest.slice(1) : rest;
  if (!/^\d{3,5}$/.test(digits)) {
    return {
      error: t(
        `序号部分 "${rest}" 不合法（应为 3~5 位数字，如 SLPS-25169）`,
        `Invalid number part "${rest}" (expected 3-5 digits, e.g. SLPS-25169)`, `番号部分 "${rest}" が不正です（3〜5 桁の数字、例：SLPS-25169）`, `번호 부분 "${rest}" 이(가) 올바르지 않습니다 (3~5 자리 숫자, 예: SLPS-25169)`,
      ),
    };
  }
  return { serial: `${kind}-${digits}`, prefix };
}

/** 盘序列号的区域前缀：日版 `BI`（`SLPS`/`SLPM`/`SCPS`…），美版 `BA`（`SLUS`/`SCUS`…）。 */
export function prefixForSerial(rawSerial: string): string {
  const kind = String(rawSerial).trim().toUpperCase().slice(0, 4);
  if (kind.startsWith('SLP') || kind.startsWith('SCP') || kind.startsWith('SLK') || kind === 'SCAJ') return 'BI';
  return 'BA';
}

/** 把「作品 + 手填序列号」解析成一个**可写入的作品上下文**。 */
export interface GameContext {
  entry: GameEntry;
  /** 归一化序列号（自定义项来自用户输入，其余来自作品表）。 */
  serial: string;
  /** 2 字母前缀。 */
  prefix: string;
  /** true = 用了用户手填的序列号（自定义项）。 */
  customSerial: boolean;
}

export function resolveGame(id: string, customSerial = ''): GameContext | { error: string } {
  const entry = findGame(id);
  if (!entry) return { error: t(`未知作品 id: ${id}`, `Unknown game id: ${id}`, `不明な作品 id：${id}`, `알 수 없는 작품 id: ${id}`) };

  if (entry.id === 'custom') {
    const p = parseSerial(customSerial);
    if ('error' in p) return { error: p.error };
    return { entry, serial: p.serial, prefix: p.prefix || prefixForSerial(p.serial), customSerial: true };
  }
  if (!entry.serial) {
    return {
      error: t(
        `作品 ${entry.label} 没有盘序列号依据，请改用「自定义」并手填`,
        `No disc serial is known for ${entry.en} - switch to "Custom" and type it in`, `${entry.en} にはディスクのシリアルの情報がありません。「カスタム」に切り替えて手入力してください`, `${entry.en} 에는 디스크 시리얼 정보가 없습니다. "사용자 지정"으로 바꿔 직접 입력하세요`,
      ),
    };
  }
  return {
    entry,
    serial: entry.serial,
    prefix: prefixForSerial(entry.serial),
    customSerial: false,
  };
}

// --------------------------------------------------------------------------
// 目录名 / 文件名
// --------------------------------------------------------------------------

/** `E00`..`E07`（每槽一个独立存档目录的形态）。 */
export function slotDirSuffix(slotIndex: number): string {
  if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex > 99) {
    throw new Error(t(`槽位下标非法：${slotIndex}（应为 0..99）`, `Invalid slot index: ${slotIndex} (expected 0..99)`, `スロット番号が不正です：${slotIndex}（0..99 である必要があります）`, `슬롯 인덱스가 올바르지 않습니다: ${slotIndex} (0..99 여야 합니다)`));
  }
  return `E${String(slotIndex).padStart(2, '0')}`;
}

/** 非 LR：`E##` 目录名；LR：`…EMB` 目录名。 */
export function dirNameFor(ctx: GameContext, slotIndex: number): string {
  if (ctx.entry.form === 'lr-archive') return `${ctx.prefix}${ctx.serial}EMB`;
  return `${ctx.prefix}${ctx.serial}${slotDirSuffix(slotIndex)}`;
}

/**
 * 从目录名里剥出盘序列号（用于把卡上的槽对上作品表）。
 *
 * `BISLPS-25169E01` → `SLPS-25169`；`BASLUS-25462EMB` → `SLUS-25462`。
 * ⚠ 前缀必须是 2 个字母，且后面紧跟系列码 —— 认不出就返回 `null`，**不猜**。
 */
export function serialFromDirName(name: string): string | null {
  const m = /^(BA|BI|BE)([A-Z]{4}-?\d{3,5})(?:E\d\d|EMB)$/.exec(name.toUpperCase());
  if (!m) return null;
  const digits = m[2];
  const dash = digits.indexOf('-');
  return dash < 0 ? `${digits.slice(0, 4)}-${digits.slice(4)}` : digits;
}

// --------------------------------------------------------------------------
// 非 LR 的 9 字节「作品常量」（`emblem.ts::headerTailFromSave` 读的就是它）
// --------------------------------------------------------------------------

/**
 * ★ 这一小段是 UI 侧**唯一**允许"替用户猜"的地方，所以它必须能被自动测。
 *
 * 依据（`src/core/emblem.ts` 的 `HEADER_TAIL_OFF/LEN` 与 `KNOWN_HEADER_TAIL`）：
 *
 *   · 非 LR 的块头 `0x14..0x1C` 是 **9 字节作品常量，与徽章内容无关**；
 *     游戏从零造一个徽章时写的就是它。空白块里是 0 ⇒ 与游戏产物**逐字节不同**。
 *   · 核心层已登记的值只有三种：SL 日版 / SL 美版（同值）与 NX 日版。
 *   · ⇒ 其余作品（AC2 / AC2AA / AC3 / NB，以及任何自定义序列号）
 *     **必须从同作品的一份真实存档里读**，否则只能**拒绝写入**（宁可少写，不写怪块）。
 *
 * 取值优先级（顺序即优先级）：
 *   ① 卡上**同作品目录**里已有的任一可解析存档（最可靠：它就是这台机器上真实存在的块）
 *   ② 核心层登记的作品常量（只有 SL/NX 有）
 *   ③ 都没有 ⇒ 返回 `null`，调用方**拒绝写入**并给出人话原因
 *
 * @param serial 归一化盘序列号（如 `SLPS-25169`），用于查登记表
 * @param cardBlocks 卡上同作品目录里读到的原始字节（可含无法解析的，本函数会跳过）
 */
export function resolveHeaderTail(
  serial: string,
  cardBlocks: readonly Uint8Array[],
  known: Readonly<Record<string, string | null>>,
): { tail: Uint8Array; source: 'card' | 'known' } | { error: string } {
  for (const b of cardBlocks) {
    if (b && b.length >= 0x14 + 9) {
      return { tail: b.slice(0x14, 0x14 + 9), source: 'card' };
    }
  }
  const hex = known[serial];
  if (typeof hex === 'string' && hex.length === 18) {
    const out = new Uint8Array(9);
    for (let i = 0; i < 9; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return { tail: out, source: 'known' };
  }
  return {
    error:
      `作品常量（非 LR 块头 0x14..0x1C 那 9 字节）没有依据：` +
        `盘序列号 ${serial} 不在已知表里，卡上也没有同作品的真实存档可以照抄。\n` +
        '★ 这 9 字节是作品级常量，猜错会让写出来的块与游戏产物逐字节不同 —— 所以这里拒绝写入。\n' +
        '解决办法：先往这个作品里存一个徽章（让卡上出现一个同作品的真实存档），再回来写。' +
        '\n---\n' +
        `No basis for the game constant (those 9 bytes at 0x14..0x1C in non-LR blocks): ` +
        `disc serial ${serial} is not in the known table, and there is no real save of this game on the card to copy from.\n` +
        '★ Those 9 bytes are a per-game constant; guessing wrong makes the written block differ byte-for-byte from what the game writes - so this refuses to write.\n' +
        'Workaround: save one emblem in that game first (so a real save of this game appears on the card), then come back.',
  };
}
