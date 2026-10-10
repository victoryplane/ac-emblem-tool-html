/**
 * 界面层**非 DOM 部分**的测试 —— 零依赖，Node 原生跑 `.ts`。
 *
 *     node web\test\ui.test.ts
 *     node web\build.mjs        # 建议先跑一次（最后一个分节要读 dist 产物）
 *
 * ==========================================================================
 * 判据来源（为什么测这些）
 * ==========================================================================
 * 界面本身（布局、拖拽、canvas）只能人眼验；但**决定"写不写卡"的那些逻辑**必须能自动跑，
 * 否则 SPEC.md §八 那几条硬规矩就只是"我读过代码"。所以本文件只测能 import 的纯逻辑：
 *
 *   (a) 作品表      —— `E##` / `EMB` → 作品的识别、以及"未验证"标注（SPEC.md §七）
 *   (b) 自定义序列号 —— 解析与**拒绝非法输入**（不编造盘序列号）
 *   (c) 作品常量决策 —— 非 LR 那 9 字节"有依据才写、没依据就拒绝"
 *   (d) 槽位模型    —— LR 用 `data0..7`、非 LR 用 `E00..E07`、空槽标记（SPEC.md §四）
 *   (e) 参数默认值  —— 取景=手动 / 缩放核=自动 / alpha=128 / 收边=关（SPEC.md §五）
 *   (f) ★ 写入前自检决策 —— "回读不一致 / 校验不过 / ECC 坏页"三种情形必须**拒绝写盘**
 *   (g) 构建产物自检 —— `dist\emblem-tool.html` 是单文件自包含（无 module / 无 import/export / 无外链）
 *
 * 最后一条依赖 `web\dist\emblem-tool.html` 已存在；不存在就**明确报错**而不是静默跳过
 * （"静默跳过"会让这个判据形同虚设）。
 *
 * 失败即非零退出，并逐条打印"哪一项、期望、实到"。
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ── 被侧的逻辑（纯模块，不碰 DOM）──────────────────────────────────────────
import {
  DEFAULT_GAME_ID,
  GAMES,
  SERIAL_KINDS,
  dirNameFor,
  findGame,
  parseSerial,
  prefixForSerial,
  resolveGame,
  resolveHeaderTail,
  serialFromDirName,
  slotDirSuffix,
} from '../src/ui/logic/games.ts';
import {
  LR_FILE_NAMES,
  SLOT_COUNT,
  buildGameSlotModel,
  filterDirsForGame,
  noDirForGameText,
  type SlotDirLike,
} from '../src/ui/logic/slots.ts';
import { planWriteTargetIn } from '../src/ui/logic/planWrite.ts';
import { auditSource, auditTree } from '../tools/i18n-audit.mjs';
import {
  DATA_LANGS,
  DEFAULT_LANG,
  HTML_LANG,
  LANGS,
  LANG_STORAGE_KEY,
  applyStaticI18n,
  currentLang,
  detectLang,
  isLang,
  langFromNavigator,
  langFromSaved,
  setLang,
  t,
} from '../src/ui/logic/i18n.ts';
import {
  DEFAULT_PARAMS,
  KERNEL_LABELS,
  PARAM_LIMITS,
  cloneDefaultParams,
  effectiveManualScale,
  fillOffsetFor,
  fillScaleFor,
  manualOffsetToTarget,
  toPrepareOptions,
} from '../src/ui/logic/defaults.ts';
import {
  checkBakeResult,
  clampWindow,
  frameRectFor,
  imagePlacement,
  manualToWindow,
  panWindow,
  windowBoundsFor,
  windowSourceRect,
  windowToManual,
  zoomWindowAtCenter,
} from '../src/ui/logic/cropGeometry.ts';
import { APP_VERSION, APP_VERSION_LABEL, UI_BUILD_TAG } from '../src/ui/logic/version.ts';
import {
  DEFAULT_PCSX2_DIR,
  classifyPcsx2Input,
  describeFoundFiles,
  isPcsx2TextFile,
  normalizeRelPath,
} from '../src/ui/logic/pcsx2Paths.ts';
import { QUIT_PCSX2_WARNING, confirmWriteMessage, verifyWrite } from '../src/ui/logic/writeGuard.ts';
import {
  STALE_HANDLE_HINT,
  describeStamp,
  staleFileRefusal,
  stampChanged,
} from '../src/ui/logic/staleness.ts';
import { humanBytes } from '../src/ui/logic/format.ts';
// ★ 0.39：直接把渲染函数拿进来测（`renderGameNote()` 只碰两个挂载点，用假 DOM 就能跑真函数）
import { renderGameNote } from '../src/ui/slotsView.ts';
// ★ 0.42：写权限的纯逻辑（用假句柄就能测"问的时候抛 SecurityError 会怎样"）
import { ensureWritePermission, writePermHintKey } from '../src/ui/logic/writePermission.ts';
import { analyzePcsx2, memoryCardSlots, parseEmulog, pickGameIni } from '../src/ui/logic/pcsx2.ts';

// ── 打包器（它只在被直接执行时才跑 main()）─────────────────────────────────
import { checkHtml, extractScripts, maskSource, readAppVersion, smokeBoot } from '../build.mjs';

// ── 核心层：用来交叉核对"界面默认值"与"核心默认值" ─────────────────────────
import { DEFAULT_ALPHA_THRESHOLD, MAX_OPAQUE_COLORS, TARGET_SIZE, imageStats, prepareEmblem } from '../src/core/image.ts';
import { KNOWN_HEADER_TAIL } from '../src/core/emblem.ts';

// --------------------------------------------------------------------------
// 极简测试框架（与 core.test.ts / card.test.ts / image.test.ts 同风格）
// --------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = dirname(HERE); // web/test → web
const DIST = join(WEB, 'dist', 'emblem-tool.html');

/**
 * 读一个**相对 `web/` 的**文件；不存在就返回空串（各分节用它读源码/产物片段做正则断言）。
 *
 * ★ 0.45：这一行原来在 15 个分节里**逐字重复**了 15 份（每份都带自己的 `existsSync` 兜底）
 *   ⇒ 提到顶层一份（分节里不再重复声明；行为不变，缺文件仍然是空串）。
 */
function read(p: string): string {
  return existsSync(join(WEB, p)) ? readFileSync(join(WEB, p), 'utf8') : '';
}

let pass = 0;
const failures: string[] = [];

function ok(cond: boolean, what: string, detail = ''): void {
  if (cond) pass += 1;
  else failures.push(detail ? `${what} — ${detail}` : what);
}

function eq(actual: unknown, expected: unknown, what: string): void {
  const a = String(actual);
  const e = String(expected);
  ok(a === e, what, `期望 ${e}，实到 ${a}`);
}

function section(title: string): void {
  console.log(`\n--- ${title} ---`);
}

// ── 取景几何的"屏幕 ↔ 源图"换算（测试自备）──────────────────────────────────
// ★ 0.19：生产代码里原本有 `screenToSource()` / `sourceToScreen()`，但**一个调用点都没有**
//   （拖动 = 平移图片，不需要把屏幕坐标反算成源坐标；只有这套几何判据在用）⇒ 从 src 删掉，
//   公式挪到测试里。判据一条没少：下面 (l4) 那组逐点比对仍然跑同样的换算。
type TestBox = { w: number; h: number };
type TestWin = { size: number; x: number; y: number };

/** 屏幕坐标（相对 `.crop-stage` 左上角）→ 源图像素坐标。 */
function s2sSource(box: TestBox, win: TestWin, px: number, py: number): { x: number; y: number } {
  const f = frameRectFor(box);
  const k = win.size > 0 && f.size > 0 ? f.size / win.size : 1;
  return { x: win.x + (px - f.left) / k, y: win.y + (py - f.top) / k };
}

/** 源图像素坐标 → 屏幕坐标（`s2sSource` 的逆）。 */
function s2sScreen(box: TestBox, win: TestWin, sx: number, sy: number): { x: number; y: number } {
  const f = frameRectFor(box);
  const k = win.size > 0 && f.size > 0 ? f.size / win.size : 1;
  return { x: f.left + (sx - win.x) * k, y: f.top + (sy - win.y) * k };
}

function throws(fn: () => unknown, what: string): void {
  let threw = false;
  let msg = '';
  try {
    fn();
  } catch (e) {
    threw = true;
    msg = e instanceof Error ? e.message : String(e);
  }
  ok(threw, what, `期望抛错，但没有（返回了 ${msg || '正常值'}）`);
}

const sha256 = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex');

// ==========================================================================
// (a) 作品表
// ==========================================================================

section('(a) 作品表：七个作品 + 自定义');

eq(GAMES.length, 9, '作品表项数（7 个作品 + AC2AA + 自定义，SPEC.md §七 的七部作品：AC2 / AC2AA / AC3 / SL / NX / NB / LR）');
ok(GAMES[GAMES.length - 1].id === 'custom', '最后一项必须是「自定义」');
eq(GAMES.filter((g) => g.id !== 'custom').length, 8, '固定作品项数');

// SPEC.md §七：SL（美/日）/ NX / LR 有实机证据 ✅，其余 ⚠ 未验证
const verifiedIds = GAMES.filter((g) => g.verified).map((g) => g.id).sort();
eq(verifiedIds.join(','), 'lr-jp,nx-jp,sl-jp,sl-us', '有实机证据的作品（SPEC.md §七 的 ✅ 那一档）');
for (const id of ['ac3', 'ac2', 'ac2aa', 'nb']) {
  const g = findGame(id);
  ok(!!g, `作品 ${id} 存在`);
  if (g) {
    ok(!g.verified, `${id} 必须标「未验证」（SPEC.md §七：规则相同但无真实样本）`);
    ok(g.note.includes('未验证'), `${id} 的说明里要写明"未验证"`, g.note);
  }
}
// 盘序列号必须与 docs\01-项目理解\04-记忆卡与存档处理.md §六 的总表逐个对上
const serialTable: Array<[string, string]> = [
  ['sl-us', 'SLUS-20644'],
  ['sl-jp', 'SLPS-25169'],
  ['nx-jp', 'SLPS-25338'],
  ['lr-jp', 'SLPS-25462'],
  ['ac3', 'SLUS-20435'],
  ['ac2', 'SLUS-20014'],
  ['ac2aa', 'SLUS-20249'],
  ['nb', 'SLUS-21200'],
];
for (const [id, serial] of serialTable) {
  eq(findGame(id)?.serial, serial, `${id} 的盘序列号（文档 §六 总表）`);
}
ok(!/https?:/.test(JSON.stringify(GAMES)), '作品表里不许出现任何 URL（离线 + 不编造来源）');

section('(a2) 目录名 ↔ 作品');
eq(serialFromDirName('BISLPS-25169E01'), 'SLPS-25169', 'SL 日版：BISLPS-25169E01 → SLPS-25169');
eq(serialFromDirName('BASLUS-20644E02'), 'SLUS-20644', 'SL 美版：BASLUS-20644E02 → SLUS-20644');
eq(serialFromDirName('BISLPS-25462EMB'), 'SLPS-25462', 'LR：BISLPS-25462EMB → SLPS-25462');
eq(serialFromDirName('BISLPS-25338E04'), 'SLPS-25338', 'NX：BISLPS-25338E04 → SLPS-25338');
eq(serialFromDirName('BISLPS-25462GAME'), null, '非 E##/EMB 结尾 → null（不猜）');
eq(serialFromDirName('icon.sys'), null, '普通文件名 → null');

// ★ 0.19：原来这里还有 gameForDirName()/slotIndexFromDirName() 两组断言 —— 那两个函数
//   生产代码一处都没用（唯一的"按目录名找作品"路径是 `filterDirsForGame` 按序列号比对，
//   它自己的断言就在上面几行）⇒ 函数与断言一起删掉。
eq(slotDirSuffix(0), 'E00', '槽 0 → E00');
eq(slotDirSuffix(7), 'E07', '槽 7 → E07');

// ==========================================================================
// (b) 自定义盘序列号：解析与拒绝
// ==========================================================================

section('(b) 自定义盘序列号');

const customOk: Array<[string, string]> = [
  ['SLUS-20435', 'SLUS-20435'],
  ['slus20435', 'SLUS-20435'],
  ['  SLPS-25169  ', 'SLPS-25169'],
  ['BISLPS-25169', 'SLPS-25169'],
  ['BA SLUS-20435', 'SLUS-20435'],
  ['SLES-51399', 'SLES-51399'],
  ['SLPM-67524', 'SLPM-67524'],
];
for (const [input, expected] of customOk) {
  const r = parseSerial(input);
  ok(!('error' in r), `parseSerial("${input}") 应接受`, 'error' in r ? r.error : '');
  if (!('error' in r)) eq(r.serial, expected, `parseSerial("${input}").serial`);
}
// 前缀：日版 BI、美版 BA（文档 §六 实测；欧版 BE 未见证据，但用户手填时接受）
eq(prefixForSerial('SLPS-25169'), 'BI', 'SLPS-* → 日版前缀 BI');
eq(prefixForSerial('SLUS-20644'), 'BA', 'SLUS-* → 美版前缀 BA');
eq(prefixForSerial('SLES-51399'), 'BA', 'SLES-* 不是日版码 ⇒ 退回 BA（未观测，界面上属未验证用法）');

const customBad = ['', '   ', 'ABC', 'SLUS', 'SLUS-', 'SLUS-12', 'XX-12345', 'SLUS-1234567', 'FOO-12345'];
for (const input of customBad) {
  const r = parseSerial(input);
  ok('error' in r, `parseSerial("${input}") 必须被拒`, 'error' in r ? '' : `实到 ${JSON.stringify(r)}`);
}
ok(SERIAL_KINDS.includes('SLUS') && SERIAL_KINDS.includes('SLPS'), '系列码白名单含 SLUS/SLPS');

// resolveGame：非自定义项不许手填覆盖；自定义项必须校验
const rg1 = resolveGame('lr-jp', 'GARBAGE');
ok(!('error' in rg1) && rg1.serial === 'SLPS-25462', '固定作品忽略手填序列号');
const rg2 = resolveGame('custom', '');
ok('error' in rg2, '自定义项留空 ⇒ 报错');
const rg3 = resolveGame('custom', 'SLES-51399');
ok(!('error' in rg3) && rg3.serial === 'SLES-51399' && rg3.prefix === 'BA', '自定义项解析');
const rg4 = resolveGame('nope', '');
ok('error' in rg4, '未知作品 id ⇒ 报错');

eq(dirNameFor({ entry: findGame('lr-jp')!, serial: 'SLPS-25462', prefix: 'BI', customSerial: false }, 3), 'BISLPS-25462EMB', 'LR 目录名与槽号无关');
eq(dirNameFor({ entry: findGame('sl-jp')!, serial: 'SLPS-25169', prefix: 'BI', customSerial: false }, 3), 'BISLPS-25169E03', 'SL 目录名带 E##');
eq(DEFAULT_GAME_ID, 'lr-jp', '默认作品 = LR 日版');

// ==========================================================================
// (b2) 非 LR 的 9 字节「作品常量」决策
// ==========================================================================

section('(b2) 作品常量（非 LR 块头 0x14..0x1C）');

// 卡上没有同作品存档 ⇒ 只能查登记表
const t1 = resolveHeaderTail('SLPS-25169', [], KNOWN_HEADER_TAIL);
ok(!('error' in t1) && t1.source === 'known', 'SL 日版：登记表里有 ⇒ 用登记表');
if (!('error' in t1)) {
  eq(
    Array.from(t1.tail).map((b) => b.toString(16).padStart(2, '0')).join(''),
    '00a130dd85ab078060',
    'SL 日版作品常量（emblem.ts::KNOWN_HEADER_TAIL）',
  );
}
const t2 = resolveHeaderTail('SLES-51399', [], KNOWN_HEADER_TAIL);
ok('error' in t2, 'AC3 欧版：表里没有、卡上也没有 ⇒ **必须拒绝写入**（不许猜）');
if ('error' in t2) ok(t2.error.includes('拒绝写入'), '拒绝理由里要说明为什么');
const t3 = resolveHeaderTail('SLES-51399', [new Uint8Array(0x4440).fill(0xab)], KNOWN_HEADER_TAIL);
ok(!('error' in t3) && t3.source === 'card', '卡上有同作品真实存档 ⇒ 从卡上取（优先级最高）');
if (!('error' in t3)) eq(t3.tail[0], 0xab, '取的是 0x14..0x1C 那 9 字节');
const t4 = resolveHeaderTail('SLUS-20986', [], KNOWN_HEADER_TAIL);
ok('error' in t4, 'NX 美版在登记表里是 null ⇒ 也拒绝（文档明说"未知，待读"）');
// ★ 0.19：headerTailFromHex() 删掉了（0 调用点）—— "登记表里的 hex → 9 字节"这条路
//   已经在 resolveHeaderTail() 内部走过（上面 t1 那几条断言就是它）。

// ==========================================================================
// (c) 槽位模型
// ==========================================================================

section('(c) 槽位模型');

eq(SLOT_COUNT, 8, '每题 8 个槽');
eq(LR_FILE_NAMES.join(','), 'data0,data1,data2,data3,data4,data5,data6,data7', 'LR 的 8 个文件名');
// ★ 0.20：这里原有 eq(ICON_SYS_SLOT_OFFSET, 0xdf) —— 界面不再显示 `icon.sys@0xDF`
//   （用户在 8 格上看不懂那行小字 ⇒「直接删掉」），常量与显示一起删。
//   事实本身没变，记在这里与 `logic/slots.ts` 注释：槽位号写在 `icon.sys@0xDF`，
//   而它落在**标题字段内部**（`0xC0..0x103` 的第 31 字节）⇒ 改标题时必须**最后**写它，
//   否则多个槽同 ID、NX 进徽章画面直接卡死（`out/_archive/cards/Mcd001_nxfix.ps2` 只改这一字节即修好）。
//   ★ 2026-10-06 逐卡实读复核：非 LR 与槽号一致（SL `E00`=0/`E01`=1、NX `E00..E04`=0..4）；
//   **LR 的 `…EMB` 目录只有一份 icon.sys、`0xDF` 恒为 0**（LR 的槽号看 `dataN` 文件名）。

// LR：一个 EMB 目录里 data0..data2（data3..data7 空）
const lrModel = buildGameSlotModel([
  {
    name: 'BISLPS-25462EMB',
    entries: [
      { name: '.', length: 0, cluster: 0, isDir: true },
      { name: '..', length: 0, cluster: 0, isDir: true },
      { name: 'BISLPS-25462EMB', length: 32, cluster: 100, isDir: false },
      { name: 'icon.sys', length: 964, cluster: 101, isDir: false },
      { name: 'data0', length: 17440, cluster: 102, isDir: false },
      { name: 'data1', length: 17440, cluster: 103, isDir: false },
      { name: 'data2', length: 17440, cluster: 104, isDir: false },
    ],
  },
  { name: 'Mcd001', entries: [] }, // 非徽章目录，必须被忽略
]);
ok(lrModel.hasLrArchive, '识别出 LR 形态');
eq(lrModel.dirNames.join(','), 'BISLPS-25462EMB', '只把 EMB 目录算进来（Mcd001 被忽略）');
eq(lrModel.slots[0].occupied, true, 'data0 占用');
eq(lrModel.slots[2].occupied, true, 'data2 占用');
eq(lrModel.slots[3].occupied, false, 'data3 空');
eq(lrModel.slots[7].occupied, false, 'data7 空');
eq(lrModel.slots[7].expectedFileName, 'data7', '空槽的计划文件名 = data7');
eq(lrModel.slots[0].fileName, 'data0', '占用槽的文件名');
eq(lrModel.slots[0].isLrArchive, true, '槽知道自己是 LR 形态');
eq(lrModel.slots[0].dirSlotIndex, null, 'LR 目录没有 E## 槽号');
eq(lrModel.slots.filter((s) => s.occupied).length, 3, '占用数 3');
eq(lrModel.slots.filter((s) => !s.occupied).length, 5, '空槽数 5');

// 非 LR：三个独立 E## 目录，其中一个在别的位置（E05）
const perSlot = buildGameSlotModel([
  {
    name: 'BISLPS-25169E00',
    entries: [
      { name: '.', length: 0, cluster: 0, isDir: true },
      { name: 'BISLPS-25169E00', length: 17472, cluster: 200, isDir: false },
      { name: 'icon.sys', length: 964, cluster: 201, isDir: false },
    ],
  },
  {
    name: 'BISLPS-25169E05',
    entries: [
      { name: '.', length: 0, cluster: 0, isDir: true },
      { name: 'BISLPS-25169E05', length: 17472, cluster: 300, isDir: false },
    ],
  },
  {
    // 目录里没有"与目录同名"的文件 ⇒ 兜底取最长的非 dot 文件
    name: 'BISLPS-25338E01',
    entries: [
      { name: '.', length: 0, cluster: 0, isDir: true },
      { name: 'something.bin', length: 17472, cluster: 400, isDir: false },
      { name: 'tiny', length: 8, cluster: 401, isDir: false },
    ],
  },
]);
eq(perSlot.hasLrArchive, false, '非 LR 卡没有 LR 形态');
eq(perSlot.slots[0].occupied, true, 'E00 → 槽 0 占用');
eq(perSlot.slots[0].fileName, 'BISLPS-25169E00', '槽 0 的文件名 = 与目录同名那个');
eq(perSlot.slots[0].dirSlotIndex, 0, '槽 0 的 E## 号 = 0');
eq(perSlot.slots[5].occupied, true, 'E05 → 槽 5 占用');
eq(perSlot.slots[5].fileName, 'BISLPS-25169E05', '槽 5 的文件名');
eq(perSlot.slots[1].fileName, 'something.bin', '没有同名文件时取最长的那个（兜底）');
eq(perSlot.slots[1].cluster, 400, '兜底文件的簇');
eq(perSlot.slots[2].occupied, false, '槽 2 空');
eq(perSlot.perSlotDirIndices.join(','), '0,1,5', '出现的 E## 槽号');
eq(perSlot.slots[7].occupied, false, '槽 7 空');
eq(perSlot.slots.filter((s) => s.occupied).length, 3, '非 LR 占用数 3');

// 空卡
const empty = buildGameSlotModel([]);
eq(empty.slots.length, 8, '空卡也必须有 8 个槽（空槽显示一个大「＋」）');
ok(empty.slots.every((s) => !s.occupied), '空卡全部未占用');
eq(empty.slots.filter((s) => !s.occupied).length, 8, '空卡 8 个空槽');

// ==========================================================================
// (c2) ★★ 8 个槽 = **当前所选作品的**槽（2026-10-04 用户实测修正）
// ==========================================================================

section('(c2) ★ 按作品过滤：切作品 = 换一套槽');

/** 一张"多作品"的卡：LR 的 EMB（data0/1/2/7）+ NX 的 E00..E04 + SL 的 E00/E01。 */
const raData = (name: string, cluster: number): SlotDirLike['entries'][number] => ({
  name,
  length: 0x4420,
  cluster,
  isDir: false,
});
const perSlotEntries = (dirName: string, cluster: number): SlotDirLike['entries'] => [
  { name: '.', length: 0, cluster: 0, isDir: true },
  { name: '..', length: 0, cluster: 0, isDir: true },
  { name: dirName, length: 0x4440, cluster, isDir: false },
  { name: 'icon.sys', length: 964, cluster: cluster + 1, isDir: false },
];
const multiCard: SlotDirLike[] = [
  {
    name: 'BISLPS-25462EMB',
    entries: [
      { name: '.', length: 0, cluster: 0, isDir: true },
      { name: '..', length: 0, cluster: 0, isDir: true },
      { name: 'BISLPS-25462EMB', length: 32, cluster: 90, isDir: false },
      { name: 'icon.sys', length: 964, cluster: 91, isDir: false },
      raData('data0', 100),
      raData('data1', 101),
      raData('data2', 102),
      raData('data7', 107),
    ],
  },
  ...['E00', 'E01', 'E02', 'E03', 'E04'].map((s, k) => ({
    name: `BISLPS-25338${s}`,
    entries: perSlotEntries(`BISLPS-25338${s}`, 200 + k * 2),
  })),
  ...['E00', 'E01'].map((s, k) => ({
    name: `BISLPS-25169${s}`,
    entries: perSlotEntries(`BISLPS-25169${s}`, 300 + k * 2),
  })),
  { name: 'Mcd001', entries: [] }, // 非徽章目录
];

const occupiedIdx = (m: ReturnType<typeof buildGameSlotModel>): string =>
  m.slots.filter((s) => s.occupied).map((s) => s.index).join(',');

// —— LR 日版（默认）——
const lrView = buildGameSlotModel(multiCard, { serial: 'SLPS-25462' });
eq(occupiedIdx(lrView), '0,1,2,7', 'LR：只有 data0/1/2/7 占用（槽 1/2/3/8）');
eq(lrView.dirNames.join(','), 'BISLPS-25462EMB', 'LR：dirNames 只含 EMB 目录');
ok(lrView.hasLrArchive, 'LR：识别出 LR 形态');
eq(lrView.slots[7].fileName, 'data7', 'LR：槽 8 是 data7');
eq(lrView.slots[3].occupied, false, 'LR：data3 是空的');
eq(
  lrView.excludedDirNames.slice().sort().join(','),
  ['BISLPS-25169E00', 'BISLPS-25169E01', 'BISLPS-25338E00', 'BISLPS-25338E01', 'BISLPS-25338E02', 'BISLPS-25338E03', 'BISLPS-25338E04'].join(','),
  '★ LR：被过滤掉的 7 个**徽章**目录必须被记下来（不许静默隐藏）',
);
ok(!lrView.excludedDirNames.includes('Mcd001'), '非徽章目录（Mcd001）不算"卡上还有其它作品"');

// —— NX 日版 ——
const nxView = buildGameSlotModel(multiCard, { serial: 'SLPS-25338' });
eq(occupiedIdx(nxView), '0,1,2,3,4', 'NX：E00..E04 ⇒ 槽 1..5 占用');
eq(nxView.dirNames.length, 5, 'NX：dirNames 只含那 5 个目录');
ok(!nxView.hasLrArchive, 'NX：没有 LR 形态');
eq(nxView.slots[5].occupied, false, 'NX：槽 6 空');
eq(nxView.excludedDirNames.length, 3, 'NX：被过滤掉 3 个目录（LR 的 EMB + SL 的 2 个）');
ok(nxView.excludedDirNames.includes('BISLPS-25462EMB'), 'NX：LR 的 EMB 在"被隐藏"列表里');

// —— SL 日版 ——
const slView = buildGameSlotModel(multiCard, { serial: 'SLPS-25169' });
eq(occupiedIdx(slView), '0,1', 'SL：E00/E01 ⇒ 槽 1/2 占用');
eq(slView.dirNames.join(','), 'BISLPS-25169E00,BISLPS-25169E01', 'SL：dirNames 只含那 2 个');
eq(slView.excludedDirNames.length, 6, 'SL：被过滤掉 6 个目录');

// —— 卡上没有的作品（AC3 美版）——
const ac3View = buildGameSlotModel(multiCard, { serial: 'SLUS-20435' });
eq(occupiedIdx(ac3View), '', '★ AC3：卡上没有它的目录 ⇒ 8 槽全空');
eq(ac3View.dirNames.length, 0, 'AC3：本作品目录 0 个');
eq(ac3View.excludedDirNames.length, 8, 'AC3：其它作品的 8 个目录全部记入"被隐藏"');
eq(ac3View.slots.filter((s) => !s.occupied).length, 8, 'AC3：8 个空槽');

// —— 自定义序列号：匹配 / 不匹配 ——
const customHit = buildGameSlotModel(multiCard, { serial: 'SLPS-25169' });
eq(occupiedIdx(customHit), '0,1', '自定义序列号 = SLPS-25169 ⇒ 与 SL 相同结果');
const customMiss = buildGameSlotModel(multiCard, { serial: 'SLUS-21200' });
eq(occupiedIdx(customMiss), '', '自定义序列号 = Nine Breaker ⇒ 卡上没有 ⇒ 全空');
eq(customMiss.excludedDirNames.length, 8, '自定义序列号不匹配 ⇒ 8 个徽章目录被隐藏');

// —— 大小写 / 前缀无关 ——
eq(filterDirsForGame(multiCard, { serial: 'slps-25462' }).included.length, 1, '序列号比较大小写无关');
eq(filterDirsForGame(multiCard, { serial: 'SLPS-25462' }).included.length, 1, '区域前缀不参与比较');
eq(filterDirsForGame(multiCard, { serial: null }).included.length, 8, '序列号为空 ⇒ 不过滤（保守，别把卡显示成空的）');
eq(filterDirsForGame(multiCard, { serial: '' }).included.length, 8, '序列号空串 ⇒ 不过滤');
eq(
  filterDirsForGame(multiCard, { serial: null }).included.some((d) => d.name === 'Mcd001'),
  false,
  '非徽章目录从不进入 8 槽（Mcd001 被剔掉）',
);

// —— 被隐藏的目录仍然"记在模型里"（`excludedDirNames`）——
//   ★ 0.37：那句把它们列出来的**摘要文案已按用户要求整句删除**（`slotSummaryText()` 也没了），
//   但**模型字段不能丢** —— "本作品在卡上还没目录"那条警告要用它的条数。
{
  eq(ac3View.excludedDirNames.length, 8, '★ AC3：被隐藏的 8 个目录仍然记在模型里（警告文案要用）');
  ok(ac3View.excludedDirNames.includes('BISLPS-25462EMB'), '★ 被隐藏的 LR 目录也在模型里');
  eq(lrView.excludedDirNames.length, 7, '★ LR 视图：别的作品的 7 个目录仍记在模型里');
}
// —— 无目录时的提示文案 ——
ok(noDirForGameText('SLUS-20435', 8).includes('SLUS-20435'), '无目录提示要带上序列号');
ok(noDirForGameText('SLUS-20435', 8).includes('别的作品'), '无目录提示要说明"卡上有别的作品"');
ok(noDirForGameText('SLUS-20435', 8).includes('存一个徽章'), '无目录提示要给出路："先在游戏里存一个徽章"');
ok(noDirForGameText(null, 0).includes('没有任何徽章目录'), '卡上确实什么都没用时说另一句');

// ==========================================================================
// (c3) ★ 过滤之后"写入被拒"的结论必须是对的（同一个 bug 的另一面）
// ==========================================================================

section('(c3) ★ 过滤后 planWriteTargetIn 的结论：非当前作品的槽一律拒绝');

const lrCtx = { entry: findGame('lr-jp')!, serial: 'SLPS-25462', prefix: 'BI', customSerial: false };
const nxCtx = { entry: findGame('nx-jp')!, serial: 'SLPS-25338', prefix: 'BI', customSerial: false };
const ac3Ctx = { entry: findGame('ac3')!, serial: 'SLUS-20435', prefix: 'BA', customSerial: false };
const cardDirNames = multiCard.map((d) => d.name);
/** ★ 0.21：写入路径收成单槽之后，"8 个槽都要怎样"这类判据改成**在测试里循环 8 个槽**。 */
const allSlots = <T>(f: (i: number) => T): T[] => [0, 1, 2, 3, 4, 5, 6, 7].map(f);

// LR：空槽（data3）要能新建
{
  const p = planWriteTargetIn({ model: lrView, cardDirNames, ctx: lrCtx, slotIndex: 3 });
  eq(p.error, null, 'LR 空槽 data3：可以新建（目录在）');
  eq(p.target!.dirName, 'BISLPS-25462EMB', 'LR 空槽的目标目录');
  eq(p.target!.fileName, 'data3', 'LR 空槽的目标文件名');
  eq(p.target!.isNew, true, 'LR 空槽是"新建文件"');
}
// LR：已有槽（data0）走覆盖
{
  const p = planWriteTargetIn({ model: lrView, cardDirNames, ctx: lrCtx, slotIndex: 0 });
  eq(p.error, null, 'LR 已有槽：可以覆盖');
  eq(p.target!.isNew, false, 'LR 已有槽不是新建');
  eq(p.target!.cluster, 100, 'LR 已有槽带回首簇');
}
// NX：E05 目录不在卡上 ⇒ 拒绝
{
  const p = planWriteTargetIn({ model: nxView, cardDirNames, ctx: nxCtx, slotIndex: 5 });
  ok(p.error !== null, '★ NX 槽 6（E05 目录不在卡上）⇒ 拒绝写入');
  ok(p.error!.includes('先在游戏里'), '拒绝理由要给出路："先在游戏里存一个徽章"');
  ok(p.error!.includes('BISLPS-25338E05'), '拒绝理由要点名缺哪个目录');
  eq(p.target, null, '拒绝时不产生任何写入目标');
}
// AC3：模型是空的 ⇒ 8 个槽逐个查都得拒
{
  const ps = allSlots((i) => planWriteTargetIn({ model: ac3View, cardDirNames, ctx: ac3Ctx, slotIndex: i }));
  eq(ps.filter((p) => p.target === null).length, 8, '★ AC3（卡上没有它的目录）⇒ 8 个槽都没有目标');
  eq(ps.filter((p) => p.error !== null).length, 8, '★ AC3：8 个槽各给一条拒绝理由');
  ok(
    ps.every((p) => p.error!.includes('先在游戏里')),
    '★ 每条拒绝理由都要说"先在游戏里为这个作品存一个徽章"',
  );
  ok(
    !ps.some((p) => p.error!.includes('不属于当前作品')),
    'AC3 的目录在卡上确实没有 ⇒ 不该说"不属于当前作品"',
  );
}
// 关键回归：用 LR 的模型 + LR 的 ctx ⇒ 8 个槽的目标**全都**落在 LR 的目录里
{
  const ps = allSlots((i) => planWriteTargetIn({ model: lrView, cardDirNames, ctx: lrCtx, slotIndex: i }));
  eq(
    ps.filter((p) => p.target!.dirName === 'BISLPS-25462EMB').length,
    8,
    '★★ LR 视图下的 8 个写入目标都落在 LR 的目录里（绝不写到别的作品）',
  );
}
// 非 LR 已经有"同名文件"的文件名选择
{
  const p = planWriteTargetIn({
    model: nxView,
    cardDirNames,
    ctx: nxCtx,
    slotIndex: 0,
    emblemFileInDir: (d) => (d === 'BISLPS-25338E00' ? 'BISLPS-25338E00' : null),
  });
  eq(p.error, null, 'NX 槽 1：目录在 ⇒ 不报错');
  eq(p.target!.fileName, 'BISLPS-25338E00', '非 LR：用"与目录同名"的那个文件');
  eq(p.target!.isNew, false, '非 LR：同名文件存在 ⇒ 视为覆盖');
}
// planWrite 的"卡上有但属于别的作品"分支
//   构造：把 LR 的 EMB 目录从模型里拿掉，但**卡目录清单里仍然有它**
//   ⇒ 这正是"卡上确实有这个名字、只是不属于本作品"的情形，话术要分开。
{
  const noEmb = buildGameSlotModel(
    multiCard.filter((d) => d.name !== 'BISLPS-25462EMB'),
    { serial: 'SLPS-25462' },
  );
  ok(noEmb.dirNames.length === 0, '前提：把 EMB 从模型里拿掉之后，本作品一个目录都不剩');
  const p = planWriteTargetIn({ model: noEmb, cardDirNames, ctx: lrCtx, slotIndex: 0 });
  ok(p.error !== null, '模型里没有这个目录 ⇒ 拒绝');
  ok(
    p.error!.includes('不属于当前作品'),
    `卡上有这个名字时要说"不属于当前作品"（实到：${p.error}）`,
  );
}
// ★ 0.21：〔批量写 8 槽〕已删 —— 上面这些"8 个槽"的判据改由测试自己循环，
//   写入路径上再没有 `slotIndices: number[]` 那套多目标数组。

// ==========================================================================
// (d) 参数默认值（SPEC.md §五）
// ==========================================================================

section('(d) 参数默认值（SPEC.md §五 已定默认值）');

eq(DEFAULT_PARAMS.fitMode, 'manual', '② 取景默认 = 手动（SPEC.md §五 ★）');
eq(DEFAULT_PARAMS.kernel, 'auto', '③ 缩放核默认 = 自动判断');
eq(DEFAULT_PARAMS.alphaThreshold, 128, '④ alpha 阈值默认 = 128');
eq(DEFAULT_PARAMS.despeckle, false, '④ 收边默认 = 关（它删像素，会破坏无损判据）');
eq(DEFAULT_PARAMS.maxColors, 255, '⑤ 减色上限默认 = 255');
eq(DEFAULT_PARAMS.targetSize, 128, '目标尺寸默认 = 128');
eq(DEFAULT_PARAMS.previewZoom, 4, '编辑器/预览放大默认 = 4×');

// 与核心层的常量**交叉核对**（不是自己写死一遍）
eq(DEFAULT_PARAMS.alphaThreshold, DEFAULT_ALPHA_THRESHOLD, '与 image.ts::DEFAULT_ALPHA_THRESHOLD 一致');
eq(DEFAULT_PARAMS.maxColors, MAX_OPAQUE_COLORS, '与 image.ts::MAX_OPAQUE_COLORS 一致');
eq(DEFAULT_PARAMS.targetSize, TARGET_SIZE, '与 image.ts::TARGET_SIZE 一致');

// 界面默认与核心默认：**只允许取景这一项不同**（SPEC.md 要求默认进"手动"）
//   核心 fitToTarget 的默认是 'contain'；界面必须覆盖成 'manual'。
ok(DEFAULT_PARAMS.fitMode !== 'contain', '界面取景默认刻意不同于核心的 contain');
// ★ 0.13：取景四档下拉删了（界面永远手动）⇒ 文案表 `FIT_MODE_LABELS` 也一起删了。
//   核心 `image.ts::FitMode` 的四档**没动**（`prepareEmblem` 仍然收 mode），下面这条断言是"别再长回来"的闸门。
eq(KERNEL_LABELS.map((k) => k.value).join(','), 'auto,nearest,smooth', '缩放核就这三档（顺序即下拉顺序）');
ok(KERNEL_LABELS.some((k) => k.value === 'auto' && k.label.includes('自动')), '缩放核文案含"自动"');

// 默认值不可被外部改坏（Object.freeze）
throws(() => {
  (DEFAULT_PARAMS as unknown as Record<string, unknown>).fitMode = 'contain';
  if (DEFAULT_PARAMS.fitMode !== 'manual') throw new Error('被改了');
}, 'DEFAULT_PARAMS 是冻结的');
eq(cloneDefaultParams().fitMode, 'manual', 'cloneDefaultParams 返回同一套默认');

// toPrepareOptions 字段口径
const o = toPrepareOptions(cloneDefaultParams());
eq(o.mode, 'manual', 'toPrepareOptions.mode');
eq(o.alphaThreshold, 128, 'toPrepareOptions.alphaThreshold');
eq(o.despeckle, false, 'toPrepareOptions.despeckle');
eq(o.targetWidth, 128, 'toPrepareOptions.targetWidth');
eq(o.targetHeight, 128, 'toPrepareOptions.targetHeight');
eq(o.scale, 1, 'toPrepareOptions.scale（手动取景起始倍率）');
ok(PARAM_LIMITS.maxColors.max === 255, '减色上限的滑杆上限 = 255');
ok(PARAM_LIMITS.alphaThreshold.min > 0 && PARAM_LIMITS.alphaThreshold.max < 255, 'alpha 阈值区间不含 0/255');

// ==========================================================================
// (e) ★ 写入前自检决策（SPEC.md §八 2/3）
// ==========================================================================

section('(e) ★ 写入前自检决策：三种失败情形都必须拒绝写盘');

const block = new Uint8Array(0x4420);
for (let i = 0; i < block.length; i++) block[i] = (i * 7 + 3) & 0xff;
const goodChecksums = { ok: true, badSegments: [] };

// ① 全好 ⇒ 放行
{
  const d = verifyWrite({
    readback: block.slice(),
    expected: block.slice(),
    checksums: goodChecksums,
    badEccPages: [],
    compliance: { ok: true, issues: [] },
  });
  ok(d.proceed, '全好 ⇒ 允许落盘');
  ok(d.byteIdentical, '全好 ⇒ 逐字节一致');
  eq(d.firstDiffOffset, -1, '全好 ⇒ 没有差异偏移');
  eq(d.reasons.length, 0, '全好 ⇒ 没有拒绝原因');
  ok(d.passed.length >= 3, '通过项要列出来（逐字节/校验/ECC）');
}

// ② 回读不一致 ⇒ 拒绝
{
  const bad = block.slice();
  bad[0x1234] = bad[0x1234] ^ 0xff;
  const d = verifyWrite({
    readback: bad,
    expected: block.slice(),
    checksums: goodChecksums,
    badEccPages: [],
    compliance: { ok: true, issues: [] },
  });
  ok(!d.proceed, '★ 回读不一致 ⇒ **拒绝写盘**');
  ok(!d.byteIdentical, '回读不一致 ⇒ byteIdentical = false');
  eq(d.firstDiffOffset, 0x1234, '报出第一个差异偏移');
  eq(d.diffCount, 1, '差异计数');
  ok(d.reasons.some((r) => r.includes('不一致')), '拒绝原因里写明"不一致"');
}

// ③ 18 段校验不过 ⇒ 拒绝（即使逐字节"看起来"一致）
{
  const d = verifyWrite({
    readback: block.slice(),
    expected: block.slice(),
    checksums: { ok: false, badSegments: [{ name: 'seg3', offset: 0xc00, got: 0x11, expect: 0x22 }] },
    badEccPages: [],
    compliance: { ok: true, issues: [] },
  });
  ok(!d.proceed, '★ 校验不过 ⇒ **拒绝写盘**');
  ok(d.reasons.some((r) => r.includes('18 段校验')), '拒绝原因里点名 18 段校验');
  ok(d.reasons.some((r) => r.includes('seg3')), '拒绝原因里带出错段与偏移');
}

// ④ ECC 坏页 ⇒ 拒绝
{
  const d = verifyWrite({
    readback: block.slice(),
    expected: block.slice(),
    checksums: goodChecksums,
    badEccPages: [1557, 1558],
    compliance: { ok: true, issues: [] },
  });
  ok(!d.proceed, '★ ECC 坏页 ⇒ **拒绝写盘**');
  ok(d.reasons.some((r) => r.includes('ECC') && r.includes('1557')), '拒绝原因里列坏页号');
}

// ⑤ 长度不符 ⇒ 拒绝
{
  const d = verifyWrite({
    readback: block.slice(0, 10),
    expected: block.slice(),
    checksums: goodChecksums,
    badEccPages: [],
    compliance: { ok: true, issues: [] },
  });
  ok(!d.proceed, '回读长度不符 ⇒ 拒绝');
  ok(d.reasons.some((r) => r.includes('长度')), '拒绝原因里写明长度不符');
}

// ⑥ 图像不合规 ⇒ 拒绝（SPEC.md §八 3）
{
  const d = verifyWrite({
    readback: block.slice(),
    expected: block.slice(),
    checksums: goodChecksums,
    badEccPages: [],
    compliance: { ok: false, issues: ['不透明色数 256 > 255'] },
  });
  ok(!d.proceed, '图像不合规 ⇒ 拒绝');
  ok(d.reasons.some((r) => r.includes('256 > 255')), '拒绝原因里带图像问题原文');
}

// ⑦ 多条同时不过 ⇒ 原因要**全列出来**，不能只报第一条
{
  const d = verifyWrite({
    readback: block.slice(0, 5),
    expected: block.slice(),
    checksums: { ok: false, badSegments: [] },
    badEccPages: [7],
    compliance: { ok: false, issues: ['x'] },
  });
  ok(!d.proceed, '多条不过 ⇒ 拒绝');
  ok(d.reasons.length >= 4, `四类问题都要列出来（实到 ${d.reasons.length} 条）`);
}

section('(e2) 落盘确认文案（SPEC.md §三 / §八 1）');
ok(QUIT_PCSX2_WARNING.includes('完全退出 PCSX2'), '硬提示文案含"完全退出 PCSX2"');
{
  const msg = confirmWriteMessage({ fileName: 'Mcd001.ps2', overwrite: true, changes: ['✅ 槽 1 写入'] });
  ok(msg.includes('请先完全退出 PCSX2'), '覆盖模式的确认框里必须有那句硬提示');
  ok(msg.includes('Mcd001.ps2'), '确认框里要写清**在写哪个文件**（SPEC.md §八 4）');
  ok(msg.includes('覆盖'), '覆盖模式要说"覆盖"');
  ok(msg.includes('✅ 槽 1 写入'), '改动摘要要带进去');
}
{
  const msg = confirmWriteMessage({ fileName: 'Mcd001.ps2', overwrite: false, changes: [] });
  ok(msg.includes('下载'), '无句柄时要说"下载"');
  ok(msg.includes('请先完全退出 PCSX2'), '下载模式同样要有硬提示');
  ok(msg.includes('memcards'), '下载模式要告诉用户拷回哪里');
}

// ==========================================================================
// (f) PCSX2 自检逻辑
// ==========================================================================

section('(f) PCSX2 自检条（照 tools\\check_pcsx2_slots.py 的结论）');

const globalIni = ['[MemoryCards]', 'Slot1_Enable=true', 'Slot1_Filename=Mcd001.ps2', 'Slot2_Enable=true', 'Slot2_Filename=Mcd001_TEST.ps2', ''].join('\r\n');
const gameIni = ['[MemoryCards]', 'Slot1_Filename=Mcd001.ps2', 'Slot2_Filename=Mcd001_embdata2.ps2', ''].join('\n');
const emulog = [
  'PCSX2 2.0.0',
  'isoFile open ok: E:\\ACLR.iso',
  'Serial: SLPS-25462',
  '[  0.1234] McdSlot 0 [File]: Mcd001.ps2 [512 MB]',
  '[  0.1235] McdSlot 1 [File]: Mcd001_embdata2.ps2 [512 MB]',
  'ELF changed, active CRC FEBEC38B',
  '',
].join('\n');

{
  const mc = memoryCardSlots(globalIni);
  eq(mc[1].fileName, 'Mcd001.ps2', '全局 Slot1');
  eq(mc[2].fileName, 'Mcd001_TEST.ps2', '全局 Slot2');
  eq(mc[1].enabled, true, '全局 Slot1 启用');
}
{
  const boots = parseEmulog(emulog);
  eq(boots.length, 1, 'emulog 切出 1 次启动');
  eq(boots[0].crc, 'FEBEC38B', 'CRC');
  eq(boots[0].serial, 'SLPS-25462', 'Serial');
  eq(boots[0].mcd.length, 2, '两次插卡记录');
  eq(boots[0].mcd[1].fileName, 'Mcd001_embdata2.ps2', 'McdSlot 1 的卡');
}
{
  const r = analyzePcsx2({
    files: [
      { name: 'inis\\PCSX2.ini', text: globalIni },
      { name: 'gamesettings\\SLPS-25462_FEBEC38B.ini', text: gameIni },
      { name: 'logs\\emulog.txt', text: emulog },
    ],
  });
  eq(r.conflicts.length, 1, '★ 每游戏覆盖 vs 全局冲突 = 1 处');
  eq(r.conflicts[0].slot, 2, '冲突在 Slot 2');
  eq(r.conflicts[0].gameValue, 'Mcd001_embdata2.ps2', '每游戏钉死的卡');
  eq(r.conflicts[0].globalValue, 'Mcd001_TEST.ps2', '全局设置里的卡');
  ok(r.warnings.some((w) => w.includes('游戏读到的是')), '警告里要写清"游戏读到的是哪张"');
  eq(r.effective.find((e) => e.slot === 2)?.source, 'game', '生效来源 = 每游戏覆盖');
  eq(r.effective.find((e) => e.slot === 2)?.fileName, 'Mcd001_embdata2.ps2', '生效的卡');
  // ★ 0.19：summarizePcsx2()（顶栏摘要行）已随函数一起删 —— 它 0.10 就不在界面上了，只有测试在用。
  ok(pickGameIni(r.overrides, r.lastBoot) === 'SLPS-25462_FEBEC38B.ini', '生效的每游戏 ini 文件名');
}
{
  // 没有覆盖 ⇒ 无冲突、生效来源 = 全局
  const r = analyzePcsx2({ files: [{ name: 'PCSX2.ini', text: globalIni }] });
  eq(r.conflicts.length, 0, '没有每游戏覆盖 ⇒ 无冲突');
  eq(r.effective.find((e) => e.slot === 1)?.source, 'global', '生效来源 = 全局');
  ok(r.notes.some((n) => n.includes('没有任何游戏覆盖')), '要给出"无覆盖"的正向结论');
}
{
  // 认不出的文件要明确说"忽略"，不能静默
  const r = analyzePcsx2({ files: [{ name: '随便.txt', text: 'hello' }] });
  ok(r.recognized.some((x) => x.includes('不认识')), '不认识的输入要显式说明');
  eq(r.conflicts.length, 0, '没有冲突');
}

// ==========================================================================
// (g) 构建产物自检
// ==========================================================================

section('(g) 构建产物自检：dist\\emblem-tool.html 是单文件自包含');

if (!existsSync(DIST)) {
  ok(false, '产物存在', `${DIST} 不存在 —— 先跑一次 node web\\build.mjs（本测试**故意**不自动构建，以免掩盖构建失败）`);
} else {
  const html = readFileSync(DIST, 'utf8');
  const res = checkHtml(html);
  if (!res.ok) for (const f of res.failures) ok(false, '产物自检', f);
  else pass += 1;

  // 判据要用"脚本标签本身有没有 type 属性"，不能全文找 `type="module"` 这几个字：
  //   产物里那句硬提示（"构建时替换成经典脚本块（**不是** type="module"）"）是**说明文字**，
  //   全文搜索会把它当成真属性 —— build.mjs::checkHtml 用同样的判据（先抹 HTML 注释再找）。
  ok(!/<script[^>]*\btype\s*=/i.test(html), '产物里没有 type="module"（file:// 下会被 CORS 拦死）');
  ok(!/<script[^>]*\bmodule\b/i.test(html), '<script> 标签上没有任何 module 相关属性');
  const scripts = extractScripts(html);
  eq(scripts.length, 1, '恰好 1 个经典脚本块');
  const script = scripts.join('\n');
  // ★ 静态扫描必须打在**掩码**上（注释/字符串已抹成空白）：
  //   否则产物里 `exports.GAMES = GAMES;` 这种我们的模块胶水、以及注释里提到的示例写法
  //   都会被当成"残留 export"误报。这与 build.mjs::checkHtml 用的是同一套掩码。
  const masked = maskSource(script);
  ok(!/\bimport\b/.test(masked), '脚本里没有 import（掩码口径）');
  ok(!/\bexport\b/.test(masked), '脚本里没有 export（掩码口径）');
  ok(!script.includes('</script'), '脚本里没有误嵌套的 </script');
  for (const bad of ['http://', 'https://', 'src="./', 'href="./', 'fetch(', 'XMLHttpRequest', 'importScripts']) {
    ok(!html.includes(bad), `产物里没有 ${bad}`);
  }
  ok(html.startsWith('<!DOCTYPE html>'), '产物以 <!DOCTYPE html> 开头');
  ok(/<meta\s+charset=["']utf-8["']/i.test(html), '有 <meta charset="utf-8">（中文界面）');
  ok(html.includes('<style>'), 'CSS 已内联');
  ok(html.includes('id="slot-grid"'), '有 8 槽的挂载点 #slot-grid');
  ok(html.includes('class="card pane-params"'), '有参数侧栏 .pane-params（0.22 起在 .upper 的右栏）');
  ok(!/class="card pane-tools"/.test(html), '★ 产物里没有「工具侧栏」元素（内置像素编辑器不做 ⇒ 整块删除）');
  ok(html.includes('id="stage-final"') && html.includes('id="view-preview"'), '有"当前图片"那一块（预览 = 将来的编辑画布）');
  // ★ 0.45：原来是 `A || B` 而 `B` 是 `A` 的**子串** ⇒ 那个 OR 恒等于 A（永远轮不到 B）。
  ok(html.includes('请先完全退出 PCSX2'), '页脚/文案里有"请先完全退出 PCSX2"');
  eq(html.match(/<!DOCTYPE html>/g)?.length, 1, '★ 全文只有 1 个 DOCTYPE（防"替换字符串 $ 模式"把整篇 HTML 塞进脚本）');
  ok(!html.includes('src=""'), '没有空的 src');
  // 体积要合理（太小 = 大概率没打进去；太大 = 大概率把 HTML 卷进了脚本）
  const bytes = Buffer.byteLength(html, 'utf8');
  ok(bytes > 150_000, `体积 ${bytes} 应大于 150 KB（核心 + 界面都打进去了）`);
  ok(bytes < 900_000, `体积 ${bytes} 应小于 900 KB（不该把 HTML 卷进脚本）`);
  // 产物哈希（打印出来方便人工对照/留痕）
  console.log(`   产物 SHA-256 : ${sha256(Buffer.from(html, 'utf8')).slice(0, 32)}…`);

  // ★★ 端到端冒烟：在桩 DOM 里**真的**走一遍
  //    "进视图 → 拖动 30 次 + 滚轮 10 次 → 确定取景 → 再进 → 取消"。
  //    这条比"能引导"强得多：
  //      · 它拿 1024×600 的源图跑真实核心，钉住"〔确定取景〕以后 128×128 不是空的"
  //        （旧代码在这里烘出 0 个不透明像素，也就是用户报的"图片消失"）；
  //      · 它用**调用计数**钉住 v0.7 的性能契约："取景期间一次管线都不跑、不重建 DOM"。
  const smoke = smokeBoot(html);
  ok(smoke.ok, '★ 冒烟：产物能在桩 DOM 里引导，并且取景流程跑通', smoke.detail);
  if (smoke.crop) {
    const c = smoke.crop;
    ok(c.ran, '冒烟：进取景视图 + 拖动/滚轮 + 确定取景 + 再进 + 取消 都跑了');
    // ★ 0.16：冒烟第一步走**真路导入** ⇒ 必须自动进取景模式、参数按"填满白框"算好
    eq(c.importAutoCrop, true, '★★ 冒烟：导入图片之后**自动**进取景模式（用户 0.16 的要求）');
    eq(c.importWindowSize, 600, '★★ 冒烟：导入后的取景窗口 = 源图短边 600（"填满白框"，1024×600 的图）');
    // ★ v0.9：没有"复位"那一步了，所以期望值从**提交前的窗口**推出来 —— 这正是要钉的契约
    eq(
      Number(c.manualScale.toFixed(9)),
      Number(c.expectScale.toFixed(9)),
      `★ 冒烟：窗口 → 参数 = 倍率 128/窗口边长（窗口 ${c.windowSize} ⇒ ${Number(c.expectScale.toFixed(4))}；实到 ${c.manualScale}）`,
    );
    ok(
      Math.abs(c.offsetX - c.expectX) < 1e-9 && Math.abs(c.offsetY - c.expectY) < 1e-9,
      `★ 冒烟：偏移就是窗口左上角（期望 ${c.expectX},${c.expectY}；实到 ${c.offsetX},${c.offsetY}）`,
    );
    ok(
      c.opaquePixels > 0,
      `★★ 冒烟：取景之后 128×128 里有内容（不透明 ${c.opaquePixels}/16384）—— 旧代码这里是 0`,
    );
    ok(c.closed, '★ 冒烟：〔确定取景〕之后视图关闭（没被烘焙自检拦下）');
    // ── v0.7 的性能契约（实测旧代码一次 pointermove = 63~397 ms）──
    // ★ 0.45：这里原来有一条把 `crop.drags` 与 40 比的断言 —— 它断言的是 `build.mjs` 刚赋进去的
    //   常量，**恒真**（手势次数不是可观测量）⇒ 删掉。真正立契约的是下面三条调用计数，以及
    //   `movedVisually`（40 次手势之后源图的 transform 确实变了）。
    eq(
      c.prepareDuringDrag,
      0,
      `★★ 冒烟：取景的 40 次拖动/滚轮里 prepareEmblem 调用 **0** 次（实到 ${c.prepareDuringDrag}）`,
    );
    eq(
      c.refreshDuringDrag,
      0,
      `★★ 冒烟：取景期间面板一次都没刷新（实到 ${c.refreshDuringDrag} 次 refreshImage()）`,
    );
    eq(
      c.canvasesDuringDrag,
      0,
      `★★ 冒烟：取景期间没有新建 canvas（实到 ${c.canvasesDuringDrag} 个）—— DOM 没有被重建`,
    );
    ok(c.movedVisually, '★ 冒烟：40 次手势之后拖动确实改了源图的 transform（视觉动了，但只动了视觉）');
    ok(c.frameStable, '★ 冒烟：整个取景过程里白框尺寸没变（"白框固定"）');
    eq(c.prepareOnConfirm, 1, `★★ 冒烟：〔确定取景〕跑了 **1** 次 prepareEmblem（实到 ${c.prepareOnConfirm}）`);
    eq(c.refreshOnConfirm, 1, `★★ 冒烟：〔确定取景〕刷新 **1** 次面板（实到 ${c.refreshOnConfirm}）`);
    eq(c.prepareOnCancel, 0, `★★ 冒烟：〔取消〕连管线都不用跑（实到 ${c.prepareOnCancel} 次）`);
    // 工具条那个按钮收起来：没调整 ⇒ 0；有未提交的调整 ⇒ 必须提交（不能静默丢掉）
    eq(c.prepareOnToggleClean, 0, `★ 冒烟：没调整时收起取景视图不跑管线（实到 ${c.prepareOnToggleClean} 次）`);
    eq(c.prepareOnToggleDirty, 1, `★ 冒烟：有未提交的调整时收起取景视图会提交（实到 ${c.prepareOnToggleDirty} 次，应为 1）`);
  } else {
    ok(false, '冒烟结果里带 crop 明细（证明取景流程真的跑了）');
  }
}

// ==========================================================================
// (h) ★ 版本号（用户要求：顶栏显示版本号，规则钉死）
// ==========================================================================

section('(h) ★ 版本号：顶栏显示 v0.47，规则从 0.1 起每次交付 +0.01');

// 规则（用户 2026-10-05 定）：从 0.1 起、每次交付 +0.01；只有用户明确说"可以发布了"才进 1.x
ok(/^0\.\d+$/.test(APP_VERSION), `APP_VERSION 必须是 0.x 形式（实到 "${APP_VERSION}"）`);
eq(APP_VERSION, '0.47', '当前交付版本 = 0.47（本轮：加日语 / 韩语 —— 四语内联，受众中日欧美韩 ⇒ +0.01）');
eq(APP_VERSION_LABEL, 'v0.47', '带 v 前缀的显示形式 = v0.47');
ok(!/^1\./.test(APP_VERSION), '★ 还没到 1.x（只有用户明确说"可以发布了"才允许进 1.x）');
ok(/^M4-UI-\d+$/.test(UI_BUILD_TAG), `开发标记形如 M4-UI-N（实到 "${UI_BUILD_TAG}"）`);
eq(UI_BUILD_TAG, 'M4-UI-48', '界面改动（四语）⇒ 开发标记递增到 M4-UI-48');
eq(readAppVersion(), APP_VERSION, 'build.mjs::readAppVersion() 读出来的与源码常量一致（不写死两份）');

{
  const dist = existsSync(DIST) ? readFileSync(DIST, 'utf8') : '';
  ok(dist.includes('v0.47'), '★ 产物里印着 v0.47');
  ok(!dist.includes('单文件离线版'), '★ 产物里**不再有**"单文件离线版"那句占位文字');
  ok(dist.includes('id="app-version"'), '顶栏有版本号挂载点 #app-version');
  ok(dist.includes('data-app-version="v0.47"'), '产物 HTML 里 #app-version 的标记值已是 v0.47（构建时替换，不是 JS 填的）');
  // ⚠ 必须用 indexOf（纯字符串），不能写正则 `/>v?</span>/` —— 那里的 `?` 是正则量词，
  //   会匹配到 `>v</span>`（本测试第一版就因此误报过一次）。
  ok(!dist.includes('>v?</span>'), '产物里没有残留的 `>v?<` 占位文本（JS 没跑起来也不会显示 v?）');
  eq((dist.match(/id="app-version"/g) ?? []).length, 1, '顶栏只有 1 个版本号挂载点');
  eq((dist.match(/data-app-version/g) ?? []).length, 1, '版本号标记只出现 1 次（没有第二份写死的）');
  ok(dist.includes('id="app-version"') && /id="app-version"[^>]*>v0\.47</.test(dist), '#app-version 的可见文本就是 v0.47');
  // 欢迎日志：产物里看到的是模板字面量本身（运行时才插值），所以断言它的两个组成部分都在
  // ★ 0.18：那 8 行"欢迎 + ①②③④ + ★ 说明"**整块按用户要求删除**（"这几句话也删掉"）⇒
  //   版本号不再从日志里看，改看**顶栏** `#app-version`（构建时替换 + JS 兜底）。
  {
    const mainSrc = existsSync(join(WEB, 'src', 'ui', 'main.ts')) ? readFileSync(join(WEB, 'src', 'ui', 'main.ts'), 'utf8') : '';
    ok(!dist.includes('欢迎使用 PS2《装甲核心》徽章工具'), '★★ 产物里不再有"欢迎使用…"那 8 行说明日志');
    ok(
      /getElementById\('app-version'\)/.test(mainSrc) && /badge\.textContent = APP_VERSION_LABEL/.test(mainSrc),
      '★ 顶栏 #app-version 仍然由 APP_VERSION_LABEL 兜底赋值（版本号显示没跟着日志一起消失）',
    );
    ok(/buildTag: UI_BUILD_TAG/.test(mainSrc), '★ 开发标记仍然挂在 F12（`EmblemToolCore.ui.buildTag`），只是不再写在日志里');
  }
  // 版本号只该有一个来源：产物里 `v0.47` 之外不该再出现别的 0.x 字面量
  //  ⚠ 注释里也别写出带 `v` 的旧版本号 —— 注释会被打进产物，这条断言就会被自己的注释弄红。
  const labels = new Set(dist.match(/v0\.\d+/g) ?? []);
  eq([...labels].join(','), 'v0.47', '产物里只出现一个 0.x 版本号（没有第二份写死的）');
}

// ==========================================================================
// (h2) ★ 页脚两行已删；"先完全退出 PCSX2"这条安全提示必须还在（在写入确认框里）
// ==========================================================================

section('(h2) ★ 页脚两行已删，安全提示改由写入确认框承担');

{
  const dist = existsSync(DIST) ? readFileSync(DIST, 'utf8') : '';
  const idx = existsSync(join(WEB, 'index.html')) ? readFileSync(join(WEB, 'index.html'), 'utf8') : '';
  const css = existsSync(join(WEB, 'styles.css')) ? readFileSync(join(WEB, 'styles.css'), 'utf8') : '';

  // ★ 用户要求：页脚那两行**整块删掉**，不留空白占位
  ok(!dist.includes('离线单文件工具'), '★ 产物里没有"离线单文件工具"那行');
  // ⚠ 判据要**成串**搜（含箭头与"全过才落盘"），否则会命中 cardOps.ts 注释里的
  //   "· 写入顺序：先算块 → 在同一份内存副本上写 → …" 那句话（它讲的是代码流程，不是页脚）。
  ok(!dist.includes('写入顺序：生成块 → 内存副本写入'), '★ 产物里没有页脚那行"写入顺序：生成块 → …"');
  ok(!dist.includes('全过才落盘。'), '★ 产物里没有页脚那行的收尾');
  ok(!/class="foot"/.test(idx), '★ 外壳里 <footer class="foot"> 整块已删除');
  ok(!/<footer\b/.test(idx), '外壳里没有任何 <footer> 元素（连容器一起删）');
  ok(!/\.foot\s*\{/.test(css), 'styles.css 里也不再留 .foot 的死样式');

  // ★ 但安全提示不能丢：它现在只在写入确认框里
  ok(QUIT_PCSX2_WARNING.includes('请先完全退出 PCSX2'), '常量 QUIT_PCSX2_WARNING 里有那句硬提示');
  for (const overwrite of [true, false]) {
    const msg = confirmWriteMessage({
      fileName: 'Mcd001.ps2',
      overwrite,
      changes: ['✅ 槽 1 写入'],
    });
    ok(msg.includes('请先完全退出 PCSX2'), `确认框（overwrite=${overwrite}）里仍然有"请先完全退出 PCSX2"`);
    ok(msg.includes('旧卡'), `确认框（overwrite=${overwrite}）里仍然解释了为什么（PCSX2 退出时会写回旧卡）`);
  }
  ok(dist.includes('请先完全退出 PCSX2'), '★ 产物里仍然含"请先完全退出 PCSX2"（删页脚没让这条保护消失）');
}

// ==========================================================================
// (i) ★ 手动取景的初始倍率 = "**填满** 128×128 框"（v0.9 用户改的口径）
// ==========================================================================

section('(i) ★ 手动取景初始倍率：按"填满白框"（短边贴框）算，不再只有 1:1 的中心');

// ★ 2026-10-05（v0.9）：用户原话「每次打开图片，图片默认就顶住这个方框部分，图片的一边顶住就行，
//   顶住就停，不缩放」⇒ 默认 = 填满（短边贴框、框里没有透明边），不是"整张图缩进框里"。
//   口径 = max(target/w, target/h) 的倒数形式：target / min(w, h)。
eq(fillScaleFor(128, 128, 128), 1, '128×128 的图 ⇒ 倍率 1');
eq(fillScaleFor(256, 256, 128), 0.5, '256×256 ⇒ 0.5');
eq(fillScaleFor(1000, 800, 128), 0.16, '1000×800 ⇒ 0.16（按**短边**贴框 = 填满）');
eq(Number(fillScaleFor(1707, 1067, 128).toFixed(6)), Number((128 / 1067).toFixed(6)), '★ 1707×1067（用户那张截图）⇒ 128/1067 ≈ 0.12');
eq(fillScaleFor(50, 50, 128), 2.56, '50×50 的小图 ⇒ 放大到 2.56（也走"填满"，不硬撑 1:1）');
eq(fillScaleFor(0, 100, 128), 1, '非法尺寸兜底成 1（不产生 NaN/Infinity）');
{
  const off = fillOffsetFor(1000, 800, 128);
  // 短边 800 ⇒ 窗口 800×800 居中 ⇒ 左右各裁 (1000−800)/2 = 100、上下正好贴边
  eq(Number(off.x.toFixed(6)), 100, '★ 1000×800 填满后左右各裁 100：offsetX = 100（正 = 框左落在源图 x=100 上）');
  eq(Number(off.y.toFixed(6)), 0, '★ 1000×800 填满后上下贴边：offsetY = 0（白框里没有透明边）');
  eq(Math.round(128 / fillScaleFor(1000, 800, 128)), 800, '★ 窗口边长 = 短边 800（= 目标 128 / 倍率 0.16）');
  const off2 = fillOffsetFor(50, 50, 128);
  eq(Number(off2.x.toFixed(6)), 0, '50×50 放大到 2.56 后 x 居中 ⇒ 0');
  eq(Number(off2.y.toFixed(6)), 0, '50×50 放大到 2.56 后 y 居中 ⇒ 0');
  const off3 = fillOffsetFor(0, 100, 128);
  eq(`${off3.x},${off3.y}`, '0,0', '非法尺寸 ⇒ 偏移兜底成 0（不产生 NaN）');

  // ★ 0.22：**128×128 的图 ⇒ 默认取景就是恒等映射**（倍率 1 + 偏移 0）。
  //   这条是"〔导出 PNG〕→ 外部编辑器改 → 拖回来"这条闭环**无损**的那一半：
  //   导入时不会因为取景再采样一次（另一半"≤255 色 ⇒ exact 不换色"在 `image.test.ts`
  //   的「★ 0.22 闭环」一节里，两端合起来 = 逐像素 diff = 0）。
  const offId = fillOffsetFor(128, 128, 128);
  eq(
    `${fillScaleFor(128, 128, 128)},${offId.x},${offId.y}`,
    '1,0,0',
    '★★ 128×128 的图：默认取景 = 倍率 1 / 偏移 0（恒等 ⇒ 导出再导入无损）',
  );
}

eq(DEFAULT_PARAMS.manualFitScale, 1, '默认 manualFitScale = 1（还没导入图片）');
eq(DEFAULT_PARAMS.manualZoom, 1, '默认 manualZoom = 1');
eq(DEFAULT_PARAMS.manualScale, 1, '默认 manualScale = 1（导入图片时会被重算成"填满框"倍率）');
eq(DEFAULT_PARAMS.fitMode, 'manual', '★ SPEC §五 ②"默认进手动"没变（改的只是初始倍率）');
{
  // 实际送给 prepareEmblem 的 scale 必须是 fillScale × zoom
  const p = cloneDefaultParams();
  p.manualFitScale = 0.16;
  p.manualZoom = 1;
  p.manualScale = 0.16;
  eq(Number(effectiveManualScale(p).toFixed(6)), 0.16, 'effectiveManualScale = fillScale × zoom');
  eq(Number(toPrepareOptions(p).scale.toFixed(6)), 0.16, 'toPrepareOptions 用的就是这个乘积（不是裸的 manualScale）');
  p.manualZoom = 2;
  eq(Number(effectiveManualScale(p).toFixed(6)), 0.32, '滚轮 2× ⇒ 实际倍率翻倍（0.16 × 2）');
  p.manualFitScale = 0;
  eq(effectiveManualScale(p), 2, 'fitScale 为 0 时兜底用 zoom（不产生 0 倍/NaN）');
}

// ==========================================================================
// (j) ★ 布局：三块视图等宽 + 原图 contain（用户截图反馈的挤压 bug）
// ==========================================================================

section('(j) ★ 上区布局：1 格当前图片 + 右侧参数侧栏 + 无滚动条');

{
  const css = existsSync(join(WEB, 'styles.css')) ? readFileSync(join(WEB, 'styles.css'), 'utf8') : '';
  const idx = existsSync(join(WEB, 'index.html')) ? readFileSync(join(WEB, 'index.html'), 'utf8') : '';
  ok(css.length > 0, '读到了 styles.css');

  // ── ① .upper = 2 列（图片格 2fr + 工具格 1fr），没有第 3/4 列 ──
  const upperBlock = /\.upper\s*\{[^}]*\}/.exec(css)?.[0] ?? '';
  ok(
    !/auto\s+auto/.test(upperBlock),
    `★ .upper 的列定义里没有连续两个 auto（第一版"原图被挤成一条缝"就是这么来的）；实到：${upperBlock.replace(/\s+/g, ' ')}`,
  );
  ok(
    /\.upper\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s*minmax\(190px,\s*220px\)/.test(css),
    '★ .upper 是 2 列：左 minmax(0, 1fr)（当前图片）+ 右 minmax(190px, 220px)（参数侧栏，0.23 收窄）',
  );
  ok(!/\.upper\s*\{[^}]*repeat\(3,/.test(css), '★ .upper 里不再有 3 列（原图那一列已经删掉）');
  ok(!/\.upper\s*\{[^}]*minmax\(260px,\s*320px\)/.test(css), '★ 也没有旧的参数列 minmax(260px,320px)');

  // ── ② 断点：≤1100 上下堆叠；旧的 1400/900/760 全部作废 ──
  ok(
    /@media\s*\(max-width:\s*1100px\)\s*\{\s*\.upper\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/.test(css),
    '≤1100px 时 .upper 改成上下堆叠（图片格在上、工具在下，都整行）',
  );
  ok(!/\.pane-tools/.test(css), '★ styles.css 里不再有 .pane-tools（连 ≤760px 那条规则一起删了）');
  ok(!/@media\s*\(max-width:\s*1400px\)\s*\{\s*\.upper/.test(css), '旧的 1400px 折行规则已删除（语义换了）');
  ok(!/@media\s*\(max-width:\s*900px\)\s*\{\s*\.upper/.test(css), '旧的 900px 折行规则已删除（改成 1100/760）');
  // 别的断点不能动
  ok(/@media\s*\(max-width:\s*1100px\)\s*\{\s*\.slot-grid\s*\{/.test(css), '★ .slot-grid 的 1100px 断点原样保留');
  ok(/@media\s*\(max-width:\s*1100px\)\s*\{\s*\.lower-bottom\s*\{/.test(css), '★ .lower-bottom 的 1100px 断点原样保留');

  // ── ③ ★ 「原图」面板必须**彻底**删掉（DOM + CSS + 挂载点）──
  ok(!/pane-original/.test(idx), '★ index.html 里没有 pane-original');
  ok(!/pane-original/.test(css), '★ styles.css 里没有 pane-original（不留死样式）');
  ok(!/id="view-original"/.test(idx), '★ 没有 #view-original 挂载点');
  ok(!/class="drop-zone"/.test(idx), '★ 没有 .drop-zone 挂载点（容器已改成 .stage）');
  ok(!/\.drop-zone\s*\{/.test(css), '★ styles.css 里没有 .drop-zone 的样式');
  ok(
    !/\.slot-offset|\.slot-head/.test(css),
    '★ 8 格上的 `icon.sys@0xDF` 小字与它那行 .slot-head 都删掉了（0.20，不留死样式）',
  );
  ok(!/id="view-editor"/.test(idx), '独立的编辑器画布挂载点 #view-editor 也删掉了（合并成一块）');
  ok(!/pane-preview|pane-editor/.test(css), '两块旧面板的样式都清掉了');

  // ── ④ 左格：细工具条 + 一块舞台（预览/取景共用）──
  ok(/class="card pane-image"/.test(idx), '左格是 .pane-image');
  ok(/class="image-toolbar"/.test(idx), '左格顶部有细工具条 .image-toolbar');
  ok(/id="btn-image-open"/.test(idx), '★「选择 / 粘贴图片」按钮在细工具条里（只换了位置）');
  ok(/id="image-input"/.test(idx), '文件选择框还在');
  ok(/id="preview-zoom"/.test(idx), '「预览倍率」下拉在细工具条里');
  ok(/id="image-drop"/.test(idx) && /class="stage"/.test(idx), '★ 舞台（拖入 + 显示）是 #image-drop.stage');
  ok(/id="stage-final"/.test(idx) && /id="view-preview"/.test(idx), '★ 平时显示"当前图片"：#stage-final > #view-preview');
  ok(/id="preview-zoom-note"/.test(idx), '有"已按容器缩放显示"的挂载点');
  ok(/\.stage\s*\{[^}]*position:\s*relative/.test(css), '.stage 是 relative（两层叠加）');
  ok(/\.stage\s*\{[^}]*overflow:\s*hidden/.test(css), '★ .stage 是 overflow: hidden（不滚）');
  ok(!/\.stage\s*\{[^}]*overflow:\s*(auto|scroll)/.test(css), '★ .stage 里没有 overflow: auto/scroll');
  ok(/\.stage-layer\s*\{[^}]*position:\s*absolute/.test(css), '两层都是绝对定位（同一格叠加）');
  ok(/\.stage-layer\[hidden\]\s*\{\s*display:\s*none/.test(css), '用 [hidden] 切层（不会两层同时可见）');

  // ── ⑤ 取景视图的 DOM 与逻辑（v0.6：白框固定 + 拖图片 + 滚轮绕框心 + 复位/适应）──
  ok(/id="stage-crop"/.test(idx) && /hidden/.test(idx), '★ 取景层 #stage-crop 默认隐藏');
  ok(/id="crop-stage"/.test(idx) && /id="crop-frame"/.test(idx) && /id="view-source"/.test(idx),
    '★ 取景视图有：舞台 + 取景框 + 源图画布');
  ok(/id="btn-crop"/.test(idx), '★ 有〔取景〕按钮（进/出取景视图）');
  ok(/id="btn-crop-ok"/.test(idx) && /id="btn-crop-cancel"/.test(idx), '★ 有〔确定取景〕〔取消〕');
  // ★ 2026-10-05（v0.9）：用户删掉了这两个"复位/适应"按钮（"我认为这个按钮没用，删了吧"）
  ok(!/btn-crop-fit/.test(idx), '★★ 取景动作行里**没有**〔↺ 复位 / 适应〕按钮了（用户要求删掉）');
  ok(!/btn-manual-reset/.test(idx), '★★ 细工具条里**没有**〔↺ 恢复到适应〕按钮了（同上）');
  ok(!/恢复到适应/.test(idx) && !/复位 \/ 适应/.test(idx), '★★ 界面文案里也不再提"恢复到适应 / 复位 / 适应"');
  ok(/id="crop-actions"/.test(idx), '取景动作行有挂载点');
  // ★ 0.12：取景时"白框 = 源图哪一块 / 倍率 / 有没有到最小"必须**在白框下面就能看到** ——
  //   原来只写进页面最下面的状态行，用户问"状态行在哪"（他取景时根本看不到）。
  ok(/id="crop-readout"/.test(idx), '★★ 取景动作行里有实时读数 #crop-readout（就在白框正下方）');
  ok(/class="crop-hint"[^>]*>拖动图片，把要用的部分放进白框里（滚轮缩放）</.test(idx), '★ 用户要的那句提示没被读数挤掉');
  ok(/\.crop-readout\s*\{/.test(css), '★ 有 .crop-readout 的样式');
  ok(/\.crop-readout\.at-min\s*\{/.test(css), '★ "已到最小"时换警示色（滚轮到底了一眼看得出）');
  {
    // ⚠ 这个块里的 `const crop = …` 在后面才声明 ⇒ 这里自己读一次，避免 TDZ
    const cropSrc = existsSync(join(WEB, 'src', 'ui', 'cropView.ts')) ? readFileSync(join(WEB, 'src', 'ui', 'cropView.ts'), 'utf8') : '';
    ok(
      /function setReadout/.test(cropSrc) && /crop-readout/.test(cropSrc),
      '★ cropView.ts 通过 setReadout() 写这行读数（一帧只写一次 textContent，不读布局）',
    );
    ok(/setReadout\(''\)/.test(cropSrc), '★ 收起取景视图时把读数清掉');
  }
  ok(/id="crop-actions"[^>]*\shidden/.test(idx), '★ 取景动作行默认带 `hidden`（没进取景视图时不该出现）');
  // ★★ 2026-10-05 用无头 Chrome 给产物截图时抓到的真 bug：`hidden` 属性被 `.row { display: flex }` 盖掉了
  //    （浏览器默认的 `[hidden] { display: none }` 优先级低于作者写的 class 规则）⇒ 没取景也会显示
  //    "拖动图片…〔确定取景〕〔取消〕"那一行。修法就是下面这条规则，**别删**。
  ok(
    /\[hidden\]\s*\{\s*display:\s*none\s*!important/.test(css),
    '★★ styles.css 里有 `[hidden] { display: none !important }` —— 否则带 `hidden` 的取景动作行照样会渲染出来',
  );
  // ★ 那一行提示必须**正好**是用户说的那句（不再解释"框内/框外"两种拖法）
  ok(/class="crop-hint"[^>]*>拖动图片，把要用的部分放进白框里（滚轮缩放）</.test(idx), '★ 取景提示是用户要的那一行');
  ok(!/在框内拖动/.test(idx), '★ 旧的"框内拖动 = 移动取景框"那套说明已经删掉（交互只有一个动体）');
  ok(/\.crop-frame\s*\{[^}]*border:\s*2px\s+solid\s+#fff/i.test(css), '★ 取景框是**白色**方框（用户要的"白色方块作为取景示意区域"）');
  ok(/\.crop-frame\s*\{[^}]*box-shadow/.test(css), '取景框用 box-shadow 把框外压暗');
  ok(/\.crop-frame\s*\{[^}]*pointer-events:\s*none/.test(css), '★ 白框不接指针（在哪儿拖都是拖图片）');
  // ★ 0.41：角标文字**不再写死** 128×128 —— CSS 读 `data-label`，由 cropView 按 targetSize 写
  ok(/\.crop-frame::after\s*\{[^}]*content:\s*attr\(data-label\)/.test(css), '★★ 取景框角标读 `attr(data-label)`（不再写死目标边长）');
  ok(
    // ⚠ 这个块里的 `const crop = …` 在后面才声明 ⇒ 这里自己读一次，避免 TDZ
    /state\.params\.targetSize\}×\$\{state\.params\.targetSize\}/.test(
      existsSync(join(WEB, 'src', 'ui', 'cropView.ts')) ? readFileSync(join(WEB, 'src', 'ui', 'cropView.ts'), 'utf8') : '',
    ),
    '★★ 角标文字由 `cropView.ts` 按 `state.params.targetSize` 写进去（唯一真值来源）',
  );
  ok(/\.crop-layer[\s\S]{0,200}overflow:\s*hidden/.test(css) || /\.crop-stage\s*\{[^}]*overflow:\s*hidden/.test(css),
    '★ 取景视图也不滚（overflow: hidden）');
  ok(!/\.crop-stage\s*\{[^}]*overflow:\s*(auto|scroll)/.test(css), '★ 取景区里没有 overflow: auto/scroll');
  {
    const layerBlock = /\.crop-layer\s*\{[^}]*\}/.exec(css)?.[0] ?? '';
    ok(/background:\s*#0b0e12/.test(layerBlock), `★ 取景区换成中性深色底（实到：${layerBlock.replace(/\s+/g, ' ')}）`);
    ok(!/linear-gradient/.test(layerBlock), '★ .crop-layer 里没有棋盘格渐变（用户："会让人以为在看透明度"）');
  }
  // ⚠ 画布必须按**自然尺寸**做 CSS 像素再 transform —— 有 max-width:100% 就会二次缩放、指针换算算歪
  ok(/\.view-source canvas\s*\{[^}]*max-width:\s*none/.test(css), '★ 源图画布没有 max-width 二次缩放（换算只有一个因子 k）');
  ok(/\.view-source canvas\s*\{[^}]*transform-origin:\s*0 0/.test(css), '★ 源图画布以左上角为变换原点');
  ok(/\.crop-stage\s*\{[^}]*cursor:\s*grab/.test(css), '★ 取景区光标是"抓手"（拖的是图片）');

  const crop = existsSync(join(WEB, 'src', 'ui', 'cropView.ts')) ? readFileSync(join(WEB, 'src', 'ui', 'cropView.ts'), 'utf8') : '';
  ok(crop.length > 0, '读到了 cropView.ts');
  ok(/export function setCropView/.test(crop), '★ cropView.ts 有 setCropView（进/出取景视图）');
  ok(/export function confirmCrop/.test(crop) && /export function cancelCrop/.test(crop), '★ 有确定/取消两个动作');
  ok(/snapshot/.test(crop) && /manualOffsetX = snapshot\.manualOffsetX/.test(crop), '★ 取消会回滚到进入前的参数（快照）');
  ok(/'wheel'/.test(crop), '★ 取景视图里滚轮缩放源图');
  ok(/zoomWindowAtCenter/.test(crop), '★ 滚轮以**白框中心**为锚点缩放');
  ok(/pointerdown/.test(crop) && /pointermove/.test(crop), '★ 取景视图里能拖动（**拖的是图片**：任何位置都一样）');
  ok(!/inFrame|mode === 'frame'/.test(crop), '★ 没有"框内拖=移框 / 框外拖=平移"的分支了（用户说没看懂）');
  ok(/effectiveManualScale/.test(crop), '★ 取景复用既有的手动取景数学（fitScale × zoom，不另起一套）');
  ok(/checkBakeResult/.test(crop), '★ 〔确定取景〕前会跑烘焙自检（宁可报错，不静默空白）');
  ok(/zoomNote\.hidden = true|zoomNote\) r\.zoomNote\.hidden = true/.test(crop), '★ 取景时把"已按容器缩放显示"那行藏起来');
  ok(/fillScaleFor|fillOffsetFor/.test(
    existsSync(join(WEB, 'src', 'ui', 'pipeline.ts')) ? readFileSync(join(WEB, 'src', 'ui', 'pipeline.ts'), 'utf8') : '',
  ), '「填满白框」的倍率/偏移计算仍在 pipeline.ts');
  ok(!/resetManual|btn-manual-reset/.test(maskSource(
    existsSync(join(WEB, 'src', 'ui', 'pipeline.ts')) ? readFileSync(join(WEB, 'src', 'ui', 'pipeline.ts'), 'utf8') : '',
  )), '★★ pipeline.ts 的**真代码**里 resetManual() 已经删掉（跟着按钮一起；注释里留个历史说明不算）');

  // ── ⑥ 右格：参数侧栏（0.22：原「工具侧栏」整块删除）──
  //    ★ 用户 2026-10-06："我突然觉得我们是不是没有必要做工具这一栏，毕竟其他优秀的图像处理工具有很多"
  //      ⇒ 内置像素编辑器（M4b）**明确不做**；那一栏删掉、位置给了参数（见 ⑦）。
  //      ⚠ 删的是**编辑器**，不是能力：〔导出 PNG〕导出的就是游戏口径，外部改完拖回来即可，
  //        而且无损（128×128 → 取景倍率 1 → 核心恒等短路；≤255 色 ⇒ exact。见 SPEC.md §六 + `image.test.ts`）。
  ok(!/pane-tools/.test(idx), '★★ 没有「工具侧栏」了（.pane-tools 整块删除）');
  ok(!/id="palette-grid"/.test(idx) && !/palette-swatch/.test(idx), '★★ 调色板占位（#palette-grid / .palette-swatch）也没了');
  {
    // ⚠ 判据在**去注释**的正文上做 —— 我们的注释里会引用这些工具名（说明"为什么不做"）。
    const markup = idx.replace(/<!--[\s\S]*?-->/g, '');
    // 工具清单整批"不许长回来"（逐条钉住）
    for (const tool of ['画笔', '橡皮', '直线', '矩形', '椭圆', '油漆桶', '取色', '选区', '对称', '图层', '撤销']) {
      ok(!markup.includes(tool), `★ 界面上不再出现工具名「${tool}」`);
    }
    ok(!/M4b/.test(markup), '★ 界面上不再出现 M4b（那条"将在下一步填充"的说明整块删了）');
    ok(!/还没有接线|像素编辑器/.test(markup), '★ 界面上不再有"占位 / 还没接线"这类说明性长句');
  }
  // 不许假装实现了编辑器：画布工具逻辑与占位填充都必须在**真代码**里消失
  const main = existsSync(join(WEB, 'src', 'ui', 'main.ts')) ? readFileSync(join(WEB, 'src', 'ui', 'main.ts'), 'utf8') : '';
  ok(!/fillPalettePlaceholder/.test(maskSource(main)), '★★ main.ts 里 fillPalettePlaceholder() 也删了（函数 + 调用）');
  ok(!/beginPath\(\)[\s\S]{0,200}lineTo\(/.test(main), '★ main.ts 里没有画笔/直线的绘制逻辑（不做编辑器）');
  ok(
    !/palette-grid|palette-swatch|tool-chip/.test(maskSource(main)),
    '★ main.ts 里不再引用工具/调色板占位的任何 id 或 class',
  );
  ok(!/pane-tools|tool-chip|palette-swatch|tools-note|tools-grid/.test(css), '★ styles.css 里不留任何工具/调色板死样式');

  // ── ⑦ 参数：**右栏侧栏**（0.22 起；原来是"独立整行 + 横向成对排"）──
  const upperOpen = idx.indexOf('<main class="upper"');
  const upperClose = idx.indexOf('</main>', upperOpen);
  const paramsAt = idx.indexOf('class="card pane-params"');
  ok(
    paramsAt > upperOpen && paramsAt < upperClose,
    '★★ .pane-params 在 .upper 的栅格**内部**（0.22 用户定：右栏放参数）',
  );
  ok(/class="card pane-params"/.test(idx), '参数块用 .pane-params 定位（0.19 起不再额外挂 id）');
  ok(!/\.pane-params\s*\{[^}]*width:\s*100%/.test(css), '★ .pane-params 不再是 width: 100% 的整行块（跟着栅格列宽走）');
  ok(/\.params-grid\s*\{[^}]*flex-direction:\s*column/.test(css), '★ 参数在侧栏里**竖排**（flex-direction: column）');
  ok(!/\.params-grid\s+\.field\s*\{[^}]*flex:\s*1\s+1\s+260px/.test(css), '★ 字段不再"1 1 260px 成对横排"');
  ok(!/max-width:\s*900px\)\s*\{\s*\.params-grid/.test(css), '★ 旧那条 ≤900px 参数折行规则也删了（现在跟 .upper 的 1100 断点走）');
  ok(/\.params-grid\s+\.field\s*>\s*label\s*\{[^}]*display:\s*block/.test(css), '★ 标签改成块级（竖排布局）');
  // ★ 0.18：用户点名删掉的那几句（他一次粘了一串）—— 逐条钉住"不许长回来"。
  //   ⚠ 判据一律在**去注释**的正文 / JS 上做（我们的注释里会引用这些原话）。
  {
    const markup = idx.replace(/<!--[\s\S]*?-->/g, '');
    const js = maskSource(existsSync(join(WEB, 'src', 'ui', 'main.ts')) ? readFileSync(join(WEB, 'src', 'ui', 'main.ts'), 'utf8') : '');
    const htmlGone = ['默认「自动判断」', 'LR = data0..7', '（面板常驻在页面最下面）'];
    const jsGone = [
      '欢迎使用 PS2《装甲核心》徽章工具',
      '① 顶栏选记忆卡',
      '★ 上区只有',
      '★ 右边的工具侧栏是像素编辑器',
      '★ 下面的 8 个槽是',
      '★ 改卡之前请先完全退出 PCSX2',
      '★ 页面最下面常驻',
      '★ 出问题先看 F12',
      '浏览器不允许网页自己按路径读文件',
      '判读方法：',
    ];
    for (const s of htmlGone) ok(!markup.includes(s), `★★ 界面上不再有「${s}…」（用户 0.18 点名删掉）`);
    for (const s of jsGone) {
      ok(!js.includes(s) && !markup.includes(s), `★★ 界面上不再有「${s}…」（用户 0.18 点名删掉）`);
    }
    // ⚠ 安全提示不能跟着一起没：它本来就在**写卡确认框**里（不是日志里那行）
    const distHtml = existsSync(DIST) ? readFileSync(DIST, 'utf8') : '';
    ok(/请先完全退出 PCSX2/.test(distHtml), '★★ "请先完全退出 PCSX2"仍然在（在写卡确认框里，别跟着日志一起删了）');
    ok(/id="write-log"[^>]*hidden/.test(idx), '★ 写入日志默认隐藏（0.18 起没内容时不该出现一个空框）');
    ok(/host\.hidden = lines\.length === 0/.test(
      existsSync(join(WEB, 'src', 'ui', 'slotsView.ts')) ? readFileSync(join(WEB, 'src', 'ui', 'slotsView.ts'), 'utf8') : '',
    ), '★ renderLog() 会在有内容时才把日志框显示出来');
  }
  // ★ 0.14：界面上不许出现 markdown 的 `**`（HTML 不认，用户会看到一串星号 —— 他截图问过）
  ok(
    !/\*\*/.test(idx.replace(/<!--[\s\S]*?-->/g, '')),
    '★★ 可见的界面文案里没有 markdown 的 `**`（要加粗请用 <b>；注释里随便写）',
  );
  // 参数行的既有控件一个都不能少（0.17 起只剩 缩放核 / alpha 阈值 —— "实时统计"整块删了）
  for (const id of ['kernel', 'alpha-threshold', 'alpha-threshold-num']) {
    ok(new RegExp(`id="${id}"`).test(idx), `参数行里仍然有 #${id}`);
  }
  // ★ 0.17：★实时统计（`#stats` + `#compliance-inline`）与 `renderStats()` **整块删除**，不许长回来
  {
    const markup = idx.replace(/<!--[\s\S]*?-->/g, '');
    ok(!/id="stats"/.test(markup), '★★ 参数行里**没有**「实时统计」#stats 了（用户："整个就没什么作用"→ 整个删掉）');
    ok(!/id="compliance-inline"/.test(markup), '★★ 也没有 #compliance-inline（合规结论不再常驻界面）');
    ok(!/renderStats/.test(main), '★★ main.ts 里不再引用 renderStats');
    const pipe = existsSync(join(WEB, 'src', 'ui', 'pipeline.ts')) ? readFileSync(join(WEB, 'src', 'ui', 'pipeline.ts'), 'utf8') : '';
    ok(!/export function renderStats/.test(pipe), '★★ pipeline.ts 里的 renderStats() 已删');
    ok(
      !/imageStats/.test(pipe) || /imageStats\(/.test(pipe),
      '★ pipeline.ts 里 `imageStats` 的 import 与实际使用一致（删了 renderStats 之后不该留孤儿 import）',
    );
    // ⚠ 合规这件事仍然挡在写卡那一步（不能因为删了面板就把闸门也删了）
    ok(
      /图像合规/.test(existsSync(join(WEB, 'src', 'ui', 'logic', 'writeGuard.ts')) ? readFileSync(join(WEB, 'src', 'ui', 'logic', 'writeGuard.ts'), 'utf8') : ''),
      '★★ `writeGuard` 里仍然写着"图像合规（128×128 / 实色 ≤255 / 半透明 0）"这条判据',
    );
  }
  // ★ 0.15：收边 / 减色上限 / 取景数值（倍率·X·Y）三格**按用户要求整块删除**，而且不许长回来。
  //   ⚠ 判据必须在**去掉 HTML 注释**的正文上做 —— 我们习惯把"为什么删掉"写在注释里，
  //     注释里当然会出现这些 id（不然会被自己那句说明弄红）。
  {
    const markup = idx.replace(/<!--[\s\S]*?-->/g, '');
    for (const id of ['despeckle', 'max-colors', 'manual-scale', 'manual-x', 'manual-y']) {
      ok(!new RegExp(`id="${id}"`).test(markup), `★★ 参数行里**没有** #${id}（用户："这三个选项都没什么用"，讨论后三样全删）`);
    }
    ok(!/syncManualReadout/.test(main), '★★ main.ts 里不再有 syncManualReadout（没有输入框要同步了）');
    const pipe = existsSync(join(WEB, 'src', 'ui', 'pipeline.ts')) ? readFileSync(join(WEB, 'src', 'ui', 'pipeline.ts'), 'utf8') : '';
    ok(!/export function syncManualReadout/.test(pipe), '★★ pipeline.ts 里的 syncManualReadout() 也删了');
    // ⚠ 删 UI ≠ 删能力：参数模型与核心默认值必须原样保留（行为不变）
    ok(
      /despeckle: false/.test(existsSync(join(WEB, 'src', 'ui', 'logic', 'defaults.ts')) ? readFileSync(join(WEB, 'src', 'ui', 'logic', 'defaults.ts'), 'utf8') : ''),
      '★★ `DEFAULT_PARAMS.despeckle` 仍然是 false（收边默认关，核心能力没动）',
    );
    eq(DEFAULT_PARAMS.maxColors, 255, '★★ 减色上限仍然是 255（格式上限 = 不额外减色）');
  }
  // ★ 0.13：取景四档下拉**删掉**了（界面永远手动），而且不许悄悄长回来
  ok(!/id="fit-mode"/.test(idx), '★★ 参数行里**没有**「取景」四档下拉了（用户："感觉只需要一个就行了"）');
  ok(!/id="fit-mode"/.test(main), '★★ main.ts 里也不再绑 `#fit-mode`');
  ok(!/FIT_MODE_LABELS/.test(main), '★★ 连那张界面文案表也不再被引用（跟着下拉一起删）');
  // 0.15：手输取景数值那条路随三格一起删了 ⇒ 现在把 fitMode 钉在 manual 的是**别的两处**
  ok(
    /state\.params\.fitMode = 'manual'/.test(
      existsSync(join(WEB, 'src', 'ui', 'pipeline.ts')) ? readFileSync(join(WEB, 'src', 'ui', 'pipeline.ts'), 'utf8') : '',
    ) || /state\.params\.fitMode = 'manual'/.test(
      existsSync(join(WEB, 'src', 'ui', 'cropView.ts')) ? readFileSync(join(WEB, 'src', 'ui', 'cropView.ts'), 'utf8') : '',
    ),
    '★ 仍然有地方把 fitMode 钉在 manual（`fillManualToTarget()` / `commitWindow()`）',
  );
  {
    // ★ 换图 = 回到手动：否则残留的自动档会**无视**刚算好的取景（0.13 顺手堵掉的坑）
    const pipe = existsSync(join(WEB, 'src', 'ui', 'pipeline.ts')) ? readFileSync(join(WEB, 'src', 'ui', 'pipeline.ts'), 'utf8') : '';
    ok(
      /export function fillManualToTarget[\s\S]{0,600}?fitMode = 'manual'/.test(pipe),
      '★★ fillManualToTarget() 里把 fitMode 钉回 manual（导入图片 = 回到手动取景）',
    );
  }

  // ── ⑧ 当前图片那一块：方形 + 硬边 + 等比自适应 + 无滚动条 ──
  const finalCanvas = /#stage-final\s+#view-preview\s+canvas\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
  ok(/#stage-final #view-preview canvas/.test(css), '当前图片画布有专门的选择器');
  ok(/aspect-ratio:\s*1\s*\/\s*1/.test(finalCanvas), '★ 当前图片是 128×128 的方画布（aspect-ratio: 1/1）');
  ok(/image-rendering:\s*pixelated/.test(finalCanvas), '★ 画布仍然 pixelated（硬边）');
  ok(/max-width:\s*100%/.test(finalCanvas) && /max-height:\s*100%/.test(finalCanvas), '★ 画布等比自适应装进舞台');
  // 源图（取景时）不一样了：v0.6 起它**按自然尺寸 + transform** 摆放（白框固定、动的是图片），
  // 所以这里**不能**有 max-width/max-height 的二次缩放 —— 换了判据，但意图相同："源图别变形、别被浏览器偷偷缩放"。
  ok(/\.view-source\s+canvas\s*\{[^}]*max-width:\s*none[^}]*max-height:\s*none/.test(css), '★ 取景时的源图由 JS 按自然尺寸摆放（没有 max-width:100% 的二次缩放）');
  ok(/\.view-source\s+canvas\s*\{[^}]*transform-origin:\s*0 0/.test(css), '★ 源图以左上角为变换原点（换算只有一个因子 k）');
  {
    const crop = existsSync(join(WEB, 'src', 'ui', 'cropView.ts')) ? readFileSync(join(WEB, 'src', 'ui', 'cropView.ts'), 'utf8') : '';
    ok(/imageRendering = crisp \? 'pixelated' : 'auto'/.test(crop), '★ 源图的硬边/平滑按显示倍率切换（放大或整数倍缩小 ⇒ pixelated）');
  }

  // ── ⑨ 倍率语义：JS 把"期望倍率"夹到"装得下" ──
  const pipe = existsSync(join(WEB, 'src', 'ui', 'pipeline.ts')) ? readFileSync(join(WEB, 'src', 'ui', 'pipeline.ts'), 'utf8') : '';
  ok(/fitDisplaySize/.test(pipe), '★ pipeline.ts 里有 fitDisplaySize()：把期望倍率夹到容器能装下的尺寸');
  ok(/已按容器缩放显示/.test(pipe), '★ 自动缩小时会提示"已按容器缩放显示"（不是静默改倍率）');
  ok(/updateZoomNote\('preview-zoom-note'/.test(pipe), '当前图片会给出缩放提示');
  ok(/id="preview-zoom-note"/.test(idx), '外壳里有这个提示的挂载点');
  ok(/\.zoom-note\s*\{/.test(css), '提示有淡色小字样式 .zoom-note');
  ok(/zoom-note-host/.test(css), '提示行有容器样式（不参与拉伸）');
  ok(!/editor-zoom-note/.test(pipe) && !/installManualPanZoom/.test(pipe), '旧的两块画布/常驻拖拽逻辑已经清掉');

  // ── ⑫ ★ 方角矩形（v0.7 用户追加）：**只改图片那块大面板**，别的面板保持圆角卡片 ──
  //    用户原话是"这一整个框也改成矩形的"，随后确认指的是**外面那块大面板**（不是白框）。
  {
    const paneBlock = /\.pane-image\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    ok(paneBlock.length > 0, '读到了 .pane-image 的样式块');
    ok(/border-radius:\s*0/.test(paneBlock), `★ .pane-image 是方角（border-radius: 0）；实到：${paneBlock.replace(/\s+/g, ' ')}`);
    ok(!/border-radius:\s*[1-9]/.test(paneBlock), '★ .pane-image 里没有残留的圆角值');
    ok(/border:\s*1px\s+solid/.test(paneBlock), '★ .pane-image 保留 1px 细边框（方角 + 细边 = 一块画布面板）');

    const stageBlock = /\.stage\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    ok(stageBlock.length > 0, '读到了 .stage 的样式块');
    ok(/border-radius:\s*0/.test(stageBlock), `★ .stage 也是方角（实到：${stageBlock.replace(/\s+/g, ' ')}）`);
    ok(!/border-radius:\s*[1-9]/.test(stageBlock), '★ .stage 里没有残留的圆角值');
    ok(/border:\s*1px\s+solid/.test(stageBlock), '★ .stage 保留 1px 细边框');
    ok(/background:\s*#0f1216/.test(stageBlock), '★ .stage 仍是深色底（铺满）');

    // 面板内部跟着方角：工具栏 / 舞台 / 取景图层 / 取景舞台
    for (const sel of ['.pane-image .image-toolbar', '.pane-image .stage', '.pane-image .crop-layer', '.pane-image .crop-stage']) {
      const escaped = sel.replace(/\./g, '\\.').replace(/\s+/g, '\\s+');
      ok(new RegExp(`${escaped}[^{]*\\{[^}]*border-radius:\\s*0`).test(css), `★ ${sel} 也是方角`);
    }

    // ★ 只有这一块改了：别的面板仍是圆角卡片，没有被顺手改成方角
    ok(/\.card\s*\{[^}]*border-radius:\s*8px/.test(css), '★ .card 的默认圆角 8px 没动（其余面板外观不变）');
    for (const other of ['.pane-params', '.lower', '.pcsx2-bar', '.slot-grid', '.write-log']) {
      const escaped = other.replace(/\./g, '\\.');
      const block = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? '';
      ok(!/border-radius:\s*0/.test(block), `★ ${other} 没有被改成方角（用户只提了图片那一块）`);
    }

    // ★ 白框：形状与尺寸语义**一点都不许动**（它本来就是正方形）
    const frameBlock = /\.crop-frame\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    ok(!/border-radius/.test(frameBlock), '★ .crop-frame 没有 border-radius（白框是正方形，别被"矩形"那条误伤）');
    ok(!/aspect-ratio/.test(frameBlock), '★ .crop-frame 不靠 aspect-ratio 撑形状（宽高都由 JS 写同一个 size）');
    ok(/border:\s*2px\s+solid\s+#fff/i.test(frameBlock), '★ 白框仍是白色方框');
    ok(/box-shadow/.test(frameBlock), '★ 白框仍然把框外压暗');
    const cropSrc = existsSync(join(WEB, 'src', 'ui', 'cropView.ts')) ? readFileSync(join(WEB, 'src', 'ui', 'cropView.ts'), 'utf8') : '';
    ok(
      /r\.frame\.style\.width = `\$\{f\.size\}px`/.test(cropSrc) && /r\.frame\.style\.height = `\$\{f\.size\}px`/.test(cropSrc),
      '★ 白框的宽与高写的是**同一个** f.size（正方形），尺寸只由舞台决定',
    );
  }

  // ── ⑬ ★ 工作区**自动填满左格**（v0.9）：`.stage` 不再是固定边长的方块 ──
  //    用户："我截图中红圈部分，能不能改成自动填满或者说适应这一个长方形区域"。
  //    ⚠ 上一版（0.8）是 `aspect-ratio: 1/1 + max-width: 560px` 的正方形；这一版必须把两者都去掉，
  //      但同时**必须有 min-height 兜底** —— 里面两层都是绝对定位，窄屏堆叠时没有它会塌成 0。
  {
    const stageBlock = /\.stage\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    ok(stageBlock.length > 0, '读到了 .stage 的样式块');
    ok(
      /flex:\s*1\s+1\s+auto/.test(stageBlock),
      `★ .stage 用 flex: 1 1 auto 填满左格剩下的高度；实到：${stageBlock.replace(/\s+/g, ' ')}`,
    );
    ok(/width:\s*100%/.test(stageBlock), '★ .stage 宽度 100%（跟着列宽走）');
    ok(!/aspect-ratio/.test(stageBlock), '★★ .stage 里**没有** aspect-ratio（不再是固定正方形工作区）');
    ok(!/max-width/.test(stageBlock), '★★ .stage 里**没有** max-width 上限（不再封顶 560px）');
    ok(
      /min-height:\s*clamp\(/.test(stageBlock),
      '★★ .stage 有 min-height: clamp(...) 兜底 —— 窄屏堆叠时这一格不会塌成 0（里面两层都是绝对定位）',
    );
    // 既有的"不滚 / 叠加"约定不能因为改形状而丢
    ok(/position:\s*relative/.test(stageBlock), '★ .stage 仍然是 relative（两层叠加）');
    ok(/overflow:\s*hidden/.test(stageBlock), '★ .stage 仍然 overflow: hidden（不滚）');

    // ★ 只改了左格这一块：右栏参数侧栏 / 8 槽 / 自检区都没动
    for (const other of ['.pane-params', '.lower', '.pcsx2-bar', '.slot-grid']) {
      const block = new RegExp(`${other.replace(/\./g, '\\.')}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? '';
      ok(!/aspect-ratio/.test(block), `★ ${other} 没有被改成方形/填满（用户只提了左格工作区）`);
    }
    ok(
      /\.upper\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s*minmax\(190px,\s*220px\)/.test(css),
      '★ .upper 的列定义与分节 (j) 一致（0.23：右栏收窄到 220px 上限）',
    );

    // ★ 白框规则不变：仍是"工作区短边 × 70%，夹在 [120, 420]"，框外压暗
    ok(/ratio\s*=\s*0\.7/.test(
      existsSync(join(WEB, 'src', 'ui', 'logic', 'cropGeometry.ts')) ? readFileSync(join(WEB, 'src', 'ui', 'logic', 'cropGeometry.ts'), 'utf8') : '',
    ), '★ 白框仍是工作区短边的 70% 派生（cropGeometry.frameSizeFor 的默认 ratio）');
    eq(frameRectFor({ w: 700, h: 430 }).size, 301, '★ 700×430 的工作区（本版典型形状）⇒ 白框 301px = 短边 430 的 70%');
    eq(frameRectFor({ w: 300, h: 300 }).size, 210, '窄窗口（300×300）⇒ 白框 210px（按比例缩小）');
    eq(frameRectFor({ w: 640, h: 640 }).size, 420, '工作区再大 ⇒ 白框顶到 420 的上限');
  }

  // ── ⑭ ★ "当前图片"必须真的铺开（v0.10 修的那个"载入以后默认这么小"）──
  //    用户报的现象：1707×1067 的图载入后预览只有 68px，还写着
  //    "已按容器缩放显示：期望 4×（512px）→ 实际约 0.53×（68px）"。
  //    根因：`#view-preview` 没有尺寸规则 ⇒ 它的盒子由**里面的 canvas** 撑出来，
  //    而 canvas 的尺寸又是"量了 `#view-preview` 之后"算的 ⇒ 量一次缩一次（128→116→104…→68）。
  {
    const pipeSrc = existsSync(join(WEB, 'src', 'ui', 'pipeline.ts')) ? readFileSync(join(WEB, 'src', 'ui', 'pipeline.ts'), 'utf8') : '';
    const pv = /#stage-final\s+#view-preview\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    ok(pv.length > 0, '★★ 有 `#stage-final #view-preview` 的样式块（少了它就会与 canvas 互相决定尺寸）');
    ok(/width:\s*100%/.test(pv), `★★ #view-preview 宽度铺满舞台（实到：${pv.replace(/\s+/g, ' ')}）`);
    ok(/height:\s*100%/.test(pv), '★★ #view-preview 高度铺满舞台（否则它是"按内容收缩"的盒子）');
    ok(/display:\s*flex/.test(pv), '★ #view-preview 自己负责把画布居中（原来是靠 .stage-layer 的 flex）');
    ok(
      /cv\.closest\('\.stage'\)/.test(pipeSrc),
      '★★ fitDisplaySize() 量的是**舞台**（`.stage`）而不是会被 canvas 撑大的 `#view-preview`',
    );
    ok(
      /closest\('\.stage'\)\s*\?\?\s*cv\.parentElement/.test(pipeSrc),
      '★★ `cv.parentElement` 只作为**量不到舞台时的兜底**出现（首选永远是 `.stage`）',
    );
  }

  // ── ⑮ ★ 顶栏三处删除（v0.10 用户："拖入/只读的按钮删了吧，没用" + "这两段也删了"）──
  {
    const slotsViewSrc = existsSync(join(WEB, 'src', 'ui', 'slotsView.ts')) ? readFileSync(join(WEB, 'src', 'ui', 'slotsView.ts'), 'utf8') : '';
    // ⚠ 断言"界面上不再有某段文案"时必须**先去掉 HTML 注释** —— 我们习惯把"为什么删掉它"写在注释里，
    //   否则会被自己那句说明弄红（这个坑第一版就踩了）。
    const idxMarkup = idx.replace(/<!--[\s\S]*?-->/g, '');
    ok(!/btn-card-input/.test(idxMarkup), '★★ 顶栏**没有**〔拖入 / 只读选择〕按钮了（用户要求删掉）');
    ok(!/拖入 \/ 只读选择/.test(idxMarkup), '★★ 界面上也不再出现"拖入 / 只读选择"这句文案');
    // ⚠ 但兜底入口必须还在：`showOpenFilePicker` 不可用时 openCardViaPicker() 会自动点它
    ok(/id="card-input"/.test(idx), '★★ 隐藏的文件框 `#card-input` **仍然在**（只读兜底路径：不可写浏览器自动走它）');
    ok(/card-input'\)[\s\S]{0,200}addEventListener|addEventListener[\s\S]{0,200}card-input/.test(main), '★ `#card-input` 的 change 事件仍然绑定');
    ok(/拖入|drag/i.test(idx), '★ 拖入仍然可用（`#card-drop` 还是拖放目标，只是不再有那个按钮）');

    ok(!/pcsx2-summary/.test(idxMarkup), '★★ 顶栏的"PCSX2 自检：<摘要>"整块删除（不再重复面板的结论）');
    ok(!/pcsx2-summary/.test(main), '★★ main.ts 里也不再往那个挂载点写摘要了');
    ok(/class="card pcsx2-bar"/.test(idx), '★★ 但**页面最下面那块 PCSX2 自检面板还在**（删的只是顶栏摘要，功能一个没少）');
    ok(!/^\s*\.pcsx2-summary\s*\{/m.test(css), '★ 那条 `.pcsx2-summary` 样式也一起删了');

    // 已验证的作品不再显示"✅ 有实机证据 …"，但**未验证作品的 ⚠ 警告必须保留**
    ok(!/有实机证据/.test(idxMarkup), '★★ 顶栏不再有"✅ 有实机证据"那句（用户要求删掉）');
    ok(!/有实机证据/.test(maskSource(slotsViewSrc)), '★★ 渲染代码（去掉注释）里也不再输出"有实机证据"');
    ok(/!entry\.verified/.test(slotsViewSrc), '★★ 只对**未验证**的作品显示提醒（安全标注不能一起删掉）');
    ok(/class: 'warn'/.test(slotsViewSrc), '★ 未验证提醒仍然用 warn 样式');
  }

  // ── ⑯ 8 槽那排按钮（v0.21）──
  {
    // ⚠ `maskSource()` 把**注释与字符串字面量一起抹掉**，所以"界面上不再有某段文案"这类断言
    //   不能拿它当证据（文案本来就活在字符串里）。这里只用它查**真代码标识符**，
    //   文案则查 `index.html` 原文。
    const mainCode = maskSource(main);
    // 〔批量写 8 槽〕按用户要求删除（"这个没什么实际作用"）：
    //   按钮、handler、busy 名单、以及写入路径上"多目标"那套数组一起收掉。
    ok(!/btn-write-all/.test(idx), '★★ 没有〔批量写 8 槽〕按钮了（0.21 用户要求删掉）');
    ok(/id="btn-write"/.test(idx), '★〔写入选中槽〕还在（单槽写入是唯一入口）');
    ok(!/doWrite\(\s*\[/.test(mainCode), '★★ `doWrite()` 不再收数组（批量写那条路没了）');
    ok(/doWrite\(state\.selectedSlot,/.test(mainCode), '★ `doWrite()` 现在收一个就地槽号');
    ok(
      !/slotIndices/.test(mainCode) && !/plan\.(targets|errors|warnings)/.test(mainCode),
      '★★ main.ts 里再没有多目标那套 `slotIndices` / `plan.targets[]` —— 写入路径收成单槽',
    );
    ok(
      /planWriteTargetIn\b/.test(maskSource(
        existsSync(join(WEB, 'src', 'ui', 'logic', 'planWrite.ts'))
          ? readFileSync(join(WEB, 'src', 'ui', 'logic', 'planWrite.ts'), 'utf8')
          : '',
      )),
      '★ 纯逻辑层叫 `planWriteTargetIn()`（单数）—— 与"一次只写一个槽"这条契约同名',
    );
    ok(
      /export async function writeSlot\b/.test(maskSource(
        existsSync(join(WEB, 'src', 'ui', 'cardOps.ts')) ? readFileSync(join(WEB, 'src', 'ui', 'cardOps.ts'), 'utf8') : '',
      )),
      '★ 写入主流程叫 `writeSlot()`（单数，逐槽循环整段消失）',
    );

    // ★★ 〔另存为〕（0.26 从〔导出整卡〕改名）依然只许挂**一个**监听
    //    （0.21 实测过：重复挂两段 ⇒ 点一次下载两次）。
    eq(
      (main.match(/btn-save-as'\)\.addEventListener/g) ?? []).length,
      1,
      '★★ 〔另存为〕只挂**一个** click 监听',
    );
    ok(/saveCardAs\(\)/.test(main), '★〔另存为〕调 `saveCardAs()`');
    // ⚠ 这两条拿**原文**比：`maskSource()` 会把字符串字面量抹掉（`$('btn-export-card')` 会变成空串），
    //   用掩码版查 old id 等于"永远通过"。我们的注释里只写中文〔导出整卡〕，不写这两个 ASCII 名字。
    ok(!/btn-export-card/.test(main) && !/btn-export-card/.test(idx), '★★ 老的 id `btn-export-card` 不许长回来');
    ok(!/exportWholeCard/.test(main) && !/exportWholeCard/.test(
      existsSync(join(WEB, 'src', 'ui', 'cardOps.ts')) ? readFileSync(join(WEB, 'src', 'ui', 'cardOps.ts'), 'utf8') : '',
    ), '★★ 老的函数名 `exportWholeCard` 不许长回来');
  }

  // ── ⑩ 导入图片的入口一个都不能少（Ctrl+V / 拖入 / 点选）──
  ok(/addEventListener\('paste'/.test(main), '★ Ctrl+V 粘贴图片仍然绑定');
  ok(/image-drop/.test(main), '★ 舞台仍然是拖入目标');
  ok(/loadImageFromBlob/.test(main), '★ 导入流程仍然是 loadImageFromBlob');
  ok(/decodeImageFile\(blob, name\)/.test(main), '导入仍然走 decodeImageFile');
  // ★ 0.16（用户："加载图片后默认启动取景模式"）：导入那张图之后必须**自动**进取景视图
  ok(
    // ★ 0.40：多了一个 `opts`（剪贴板标记）—— 真路仍然只有这一条
    /applyImportedImage\(await decodeImageFile\(blob, name\), name, opts\)/.test(main),
    '★★ loadImageFromBlob 把"解码后的图"交给 applyImportedImage()（真路只有一条）',
  );
  ok(
    // ★ 0.28：窗口从 1800 放宽到 3200 —— 双语化之后这段里多了英文文案，
    //   0.28 时实测距离已 1431（离 1800 只剩 ~370 余量）⇒ 再往里加字就会**假失败**。
    /function applyImportedImage[\s\S]{0,3200}?openCropView\(\)/.test(main),
    '★★ applyImportedImage() 最后会 openCropView() —— 导入图片 = 直接进取景模式',
  );
  ok(
    /function applyImportedImage[\s\S]{0,1200}?fillManualToTarget\(\)/.test(main),
    '★ 进取景之前先按"填满白框"算好初值（不然白框里是上一张图的取景）',
  );
  ok(/imageImport:\s*\{\s*applyImportedImage\s*\}/.test(main), '★ 真路挂到 F12 / 冒烟上（`ui.imageImport.applyImportedImage`）');
}

// ==========================================================================
// (k) ★ PCSX2 自检：页面最下面、★ 默认折叠（0.23）、一次点击 + 记住目录、兜底路径
// ==========================================================================

section('(k) ★ PCSX2 自检：位置 / 无折叠 / 默认目录提示 / 兜底路径');

// ── k1：纯逻辑 —— 路径与文件匹配（这部分是"点一次到底读到哪几个文件"的判据）──
eq(DEFAULT_PCSX2_DIR, 'C:\\Users\\M\\Documents\\PCSX2', '默认 PCSX2 目录常量（用户机器上就是这个）');
ok(isPcsx2TextFile('inis/PCSX2.ini'), '认 inis/PCSX2.ini');
ok(isPcsx2TextFile('PCSX2/inis/PCSX2.ini'), '带上层目录也认（webkitRelativePath 会带根目录名）');
ok(isPcsx2TextFile('inis\\PCSX2.ini'), '反斜杠路径也认');
ok(isPcsx2TextFile('gamesettings/SLPS-25462_FEBEC38B.ini'), '认 gamesettings/*.ini');
ok(isPcsx2TextFile('logs/emulog.txt'), '认 logs/emulog.txt');
ok(isPcsx2TextFile('logs/emulog.log'), '认 logs/emulog.log（备用后缀）');
ok(!isPcsx2TextFile('memcards/Mcd001.ps2'), '不认 memcards 里的记忆卡');
ok(!isPcsx2TextFile('inis/PCSX2_backup.txt'), 'inis 目录里别的 .txt 不认（只认 PCSX2.ini）');
ok(!isPcsx2TextFile('inis2/PCSX2.ini'), '★ 目录段必须整段相等：inis2 不算 inis');
ok(!isPcsx2TextFile('gamesettings/readme.md'), 'gamesettings 里非 .ini 不认');
ok(!isPcsx2TextFile('logs/other.txt'), 'logs 目录里别的 .txt 不认（只认 emulog）');
eq(normalizeRelPath('.\\inis\\PCSX2.ini'), 'inis/PCSX2.ini', 'normalizeRelPath 把反斜杠与 ./ 归一');
eq(normalizeRelPath('a//b\\c'), 'a/b/c', 'normalizeRelPath 压掉重复分隔符');

{
  // 兜底路径：<input webkitdirectory> 给的一堆文件 → 只挑三个
  const fake = [
    { name: 'PCSX2.ini', size: 4096, webkitRelativePath: 'PCSX2/inis/PCSX2.ini' },
    { name: 'SLPS-25462_FEBEC38B.ini', size: 2048, webkitRelativePath: 'PCSX2/gamesettings/SLPS-25462_FEBEC38B.ini' },
    { name: 'emulog.txt', size: 1024 * 1024, webkitRelativePath: 'PCSX2/logs/emulog.txt' },
    { name: 'Mcd001.ps2', size: 8 * 1024 * 1024, webkitRelativePath: 'PCSX2/memcards/Mcd001.ps2' },
    { name: 'huge.ini', size: 9 * 1024 * 1024, webkitRelativePath: 'PCSX2/gamesettings/huge.ini' },
  ];
  const cls = classifyPcsx2Input(fake);
  eq(cls.read.length, 3, '★ 兜底路径：5 个文件里挑出 3 个要读的');
  eq(cls.read.map((f) => f.name).join(','), 'PCSX2.ini,SLPS-25462_FEBEC38B.ini,emulog.txt', '挑出来的正是那三个');
  eq(cls.skippedTooBig.length, 1, '跳过 1 个超大文件（>4 MiB 的 .ini）');
  eq(cls.skippedOther.length, 1, '跳过 1 个无关文件（memcards 里的 .ps2）');
  // ★ 0.19：selectPcsx2Files()（与 classifyPcsx2Input 同义的第二份实现）已删。
  eq(classifyPcsx2Input(fake).read.length, 3, '三个文件都该被读（分类结果与期望一致）');
}
{
  const msg = describeFoundFiles([
    'PCSX2/inis/PCSX2.ini',
    'PCSX2/gamesettings/A.ini',
    'PCSX2/logs/emulog.txt',
  ]);
  ok(msg.includes('三项齐全'), `三项都有时要说"齐全"：${msg}`);
  const msg2 = describeFoundFiles(['PCSX2/inis/PCSX2.ini']);
  ok(msg2.includes('没找到'), '缺项时要明说缺什么');
  ok(msg2.includes('gamesettings'), '缺项明细里要点名 gamesettings');
  const msg3 = describeFoundFiles(['PCSX2/memcards/Mcd001.ps2']);
  ok(msg3.includes('没有找到'), '一个都对不上时要说"没找到"');
  ok(msg3.includes('用户目录'), '并提示"选的是不是 PCSX2 的用户目录"');
}

// ── k2：DOM 结构 —— 位置、★ 默认折叠、按钮与提示文案 ──
{
  const html = existsSync(DIST) ? readFileSync(DIST, 'utf8') : '';
  ok(html.length > 0, '读到了产物 HTML');

  // ★ 位置：自检 section 必须是 DOM 里**最后一个** section，且在 8 槽与日志之后
  const secStarts = [...html.matchAll(/<section\b/g)].map((m) => m.index);
  const lastSec = secStarts.length ? secStarts[secStarts.length - 1] : -1;
  ok(secStarts.length >= 3, `产物里有多个 section（实到 ${secStarts.length} 个：图片格 + 8 槽 + 自检）`);
  ok(html.slice(lastSec, lastSec + 60).includes('pcsx2-bar'), '★ 最后一个 <section> 就是 PCSX2 自检区');
  const iBar = html.indexOf('class="card pcsx2-bar"');
  const iUpper = html.indexOf('class="upper"');
  const iSlots = html.indexOf('id="slot-grid"');
  const iLog = html.indexOf('id="write-log"');
  ok(iUpper >= 0 && iSlots > iUpper && iLog > iSlots && iBar > iLog, '★ DOM 顺序：上区 → 8 槽 → 日志 → PCSX2 自检');
  // 页脚那两行已按用户要求整块删除 ⇒ 外壳里不该再有 <footer>（offset 断言随之作废）
  ok(html.indexOf('<footer') < 0, '页脚已删除（自检区就是最后一块内容）');
  ok(html.indexOf('id="pcsx2-body"') > iBar, '#pcsx2-body 在自检 section 内部');

  // ★ 0.23 用户："自检改成默认折叠起来" ⇒ 头一行常驻 + 其余整块 `hidden` + 〔展开/收起〕按钮。
  //   （0.8 那一版是"默认展开、无折叠按钮"；这条是**用户后来的新要求**，判据跟着翻面。）
  //   ⚠ 判据只拿**外壳 markup** 比：① 先切掉末尾那个内联 <script>（产物里只有 1 个），
  //     ② 再去掉 HTML 注释 —— 我们的注释里会引用这些 id 与旧按钮的说明。
  //     ⚠⚠ **不能**用 `maskSource(html)`：它是给 **JS** 写的掩码器（认 `//` 与 `/*`），
  //        套在 HTML 上会把大半篇 markup 一起抹掉 ⇒ 断言"永远通过"（0.22 之前那几条负向断言
  //        就是这么假通过的；改成正向断言后立刻暴露）。
  const markup = html.slice(0, html.indexOf('<script')).replace(/<!--[\s\S]*?-->/g, '');
  ok(markup.length > 0, '取到了外壳 markup（切掉内联脚本、去掉 HTML 注释）');
  ok(/id="btn-pcsx2-toggle"/.test(markup), '★ 有折叠按钮 #btn-pcsx2-toggle（0.23 新增）');
  ok(/<button[^>]*btn-pcsx2-toggle/.test(markup), '★ 它确实是 <button>（能点、能聚焦）');
  ok(
    /<button[^>]*btn-pcsx2-toggle[^>]*>展开</.test(markup),
    '★★ 默认文案是「展开」⇒ 打开页面时自检面板是**折叠**的（用户 0.23 要求）',
  );
  ok(
    /id="btn-pcsx2-toggle"[^>]*aria-expanded="false"/.test(markup),
    '★ 初始 aria-expanded="false"（读屏软件也知道它是收起的）',
  );
  ok(/aria-controls="pcsx2-panel"/.test(markup), '★ aria-controls 指向被折叠的那块 #pcsx2-panel');
  // ★ 0.24：按钮必须用**蓝色**（`button.primary`）—— 用户："不然不够显眼"。
  //   原来挂的是 `quiet`（透明底 + 暗色字），在面板头一行里几乎看不见。
  ok(
    /<button[^>]*btn-pcsx2-toggle[^>]*class="primary"/.test(markup),
    '★★ 折叠按钮用 `class="primary"`（与其他主按钮同一个蓝底，用户 0.24 要求）',
  );
  ok(!/<button[^>]*btn-pcsx2-toggle[^>]*class="quiet"/.test(markup), '★ 不再是低调的 `quiet`（透明底）');
  // 被折叠的整块（三条入口 + 结论 + 说明）必须真的带 hidden（靠 `[hidden]{display:none!important}` 生效）
  const panelOpen = markup.indexOf('id="pcsx2-panel"');
  ok(panelOpen > 0, '有 #pcsx2-panel（被折叠的那一块）');
  ok(/id="pcsx2-panel"\s+hidden/.test(markup), '★★ #pcsx2-panel 初始带 hidden ⇒ 默认折叠（不是靠 inline style）');
  // 三条入口与结论挂载点都在**面板内部**（折叠时一起藏起来）
  const panelEnd = markup.indexOf('</section>', panelOpen);
  for (const inner of ['id="btn-pcsx2-dir"', 'id="btn-pcsx2-input"', 'id="pcsx2-default-dir"', 'id="pcsx2-route"']) {
    const at = markup.indexOf(inner);
    ok(at > panelOpen && at < panelEnd, `★ ${inner} 在 #pcsx2-panel 内部（折叠时一起收起来）`);
  }
  // 文案：用户 0.23 指定的新副标题（说明"这是因为全局设置与每游戏独立设置可能不一致"）
  ok(
    /确认游戏实际会读哪张卡，避免全局设置与独立设置不同导致的记忆卡读取问题/.test(markup),
    '★★ 副标题 = 用户 0.23 给的那句（点名"全局设置 vs 独立设置"这个坑）',
  );

  // ★ 目录选择按钮 + 默认路径提示文案
  ok(html.includes('id="btn-pcsx2-dir"'), '有「选择 PCSX2 目录」按钮');
  ok(html.includes('id="pcsx2-default-dir"'), '有默认目录提示的挂载点 #pcsx2-default-dir');
  ok(html.includes('id="btn-pcsx2-input"'), '有兜底方式的目录输入框按钮');
  ok(html.includes('id="pcsx2-dir-input"') && html.includes('webkitdirectory'), '★ 兜底路径：webkitdirectory 目录输入框存在');
  ok(html.includes('id="pcsx2-drop"'), '保留拖入的方式');
  ok(html.includes('id="pcsx2-route"'), '有"本次来源"的显示位（用来判断走的是哪条路）');
}

// ── k3：源码里钉住 API 用法（startIn / id / 记忆 / 递归读 / 自动切兜底）──
{
  const main = existsSync(join(WEB, 'src', 'ui', 'main.ts')) ? readFileSync(join(WEB, 'src', 'ui', 'main.ts'), 'utf8') : '';
  ok(main.length > 0, '读到了 main.ts');
  ok(/startIn:\s*'documents'/.test(main), "★ main.ts 里 showDirectoryPicker 带 startIn: 'documents'");
  ok(/id:\s*'pcsx2'/.test(main), "★ main.ts 里 showDirectoryPicker 带 id: 'pcsx2'（Chrome 靠它记住上次选的目录）");
  ok(/queryPermission\s*\(\s*\{\s*mode:\s*'read'\s*\}\s*\)/.test(main), '启动时用 queryPermission 判断"记住的目录"权限还在不在');
  ok(/indexedDB\.open/.test(main), '句柄存进 IndexedDB（try/catch 包住的锦上添花）');
  ok(/recallPcsx2Handle|rememberPcsx2Handle/.test(main), '有"记住 / 取回句柄"两个函数');
  ok(
    // ★ 0.28：这条原来是 `/SecurityError|isAbort\(e\)[\s\S]{0,400}openPcsx2DirInput\(\)/` ——
    //   而那个 400 窗口实际上是被**注释里**的裸词 `SecurityError` 命中的（`isAbort(e)` 那条早就 >400 了）
    //   ⇒ 判据看着过、其实没在查该查的东西。现在改成"pickPcsx2Dir() 的 catch 之后 1500 字符内出现兜底调用"，
    //   意图一致，且不靠巧合。
    /function pickPcsx2Dir[\s\S]*?catch[\s\S]{0,1500}?openPcsx2DirInput\(\)/.test(main),
    '★ 目录选择框失败/取消时能自动切到兜底（不报错卡住）',
  );
  ok(/webkitGetAsEntry/.test(main), '拖入目录时走 FileSystemEntry 递归（拖目录拿到子文件）');
  ok(/readTextFilesFromHandle/.test(main), '用句柄时是递归读（inis / gamesettings / logs）');
  ok(/'目录选择框'/.test(main), "三条路都会记下来源：'目录选择框'");
  // 下面三条：来源字符串也可能通过 setPcsx2Files(files, '目录输入框') 这种形参传入，
  // 所以只断言"这三个字面量确实出现在源码里"，不限定赋值形式。
  ok(/'目录输入框'/.test(main), "三条路都会记下来源：'目录输入框'");
  ok(/'拖入文件'/.test(main), "三条路都会记下来源：'拖入文件'");
  ok(/'自动（记住的目录）'/.test(main), "自动读时记下来源：'自动（记住的目录）'");
  ok(/'未提供'/.test(main), "初始来源：'未提供'");
  ok(/DEFAULT_PCSX2_DIR/.test(main), '默认目录只用常量 DEFAULT_PCSX2_DIR（没有第二份字面量）');

  const css = existsSync(join(WEB, 'styles.css')) ? readFileSync(join(WEB, 'styles.css'), 'utf8') : '';
  ok(/\.pcsx2-bar\s*\{[^}]*\}/.test(css), '自检区有自己的样式块');
  ok(!/\.upper\s*\{[^}]*pcsx2/.test(css), '自检区不在 .upper 栅格里（不会留下空列）');
  // 自检区是普通块级元素 ⇒ 跟着 body 一起折行，不受 .upper 的断点影响。
  // 断点本身在分节 (j) 里断言（≤1100 上下堆叠）。
  // ★ 0.22：原来还有一条 `@media (max-width: 760px) { .pane-tools { min-height: 0 } }` ——
  //   它只为「工具侧栏」（`.pane-tools { min-height: 300px }`）让步而存在；那一栏删掉之后，
  //   参数侧栏自己是 `min-height: 0`，窄屏不需要任何额外规则 ⇒ **≤760 那条整条删除**（不是漏了）。
  ok(
    /@media\s*\(max-width:\s*1100px\)/.test(css) && !/@media\s*\(max-width:\s*760px\)/.test(css),
    '上区断点只有 ≤1100 上下堆叠（≤760 那条随工具侧栏一起删了），自检区不受影响',
  );
}

// ==========================================================================
// (l) ★ 取景：白框里看到的就是被裁下来的那块 —— 以及"图片消失"的根因回归
// ==========================================================================
//
// 用户报的 bug：「为什么按了确定取景以后图片会消失」+「我希望这个部分的框就是矩形的、
// 有一个白色方块作为取景的示意区域，用户手动拖动图片，把要的部分拖到方块里」。
//
// 根因有**两个**，都在本节里钉死：
//   ① 取景偏移的**量纲**错位：界面的 `manualOffsetX/Y` 是**源像素**，
//      而 `image.ts` 的 `offsetX/offsetY` 是**目标像素**（`tx = sx·scale + offset`）。
//      旧代码原样传过去 ⇒ 非正方形图被整体挪走 ⇒ 输出几乎全空（1024×600 实测 **0/16384**）。
//   ② 取景框几何算错（少一个 scale、符号反）⇒ 框里看到的根本不是被裁下来的那块。
//
// 本节的做法：拿**真实** `prepareEmblem()` 与"屏幕几何"两条独立路径逐点比对 ——
// 只要"框里看到的"与"裁下来的"有任何偏差就会被抓住；光看 DOM/产物是抓不到的
// （图层可见、画布尺寸对、18 段校验也过，因为**空图**同样是合法输入）。

section('(l) ★ 取景：白框里看到的就是被裁下来的那块（+ "图片消失"根因回归）');

/** 单色图（验"非空 / 不透明像素数"用）。 */
function solidRgba(w: number, h: number, rgba: [number, number, number, number] = [200, 100, 50, 255]): Uint8ClampedArray {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    d[i * 4] = rgba[0];
    d[i * 4 + 1] = rgba[1];
    d[i * 4 + 2] = rgba[2];
    d[i * 4 + 3] = rgba[3];
  }
  return d;
}

/** 四象限图：颜色只由"左上 / 右上 / 左下 / 右下"决定 —— 用来判断"取到的是哪一块"。 */
function quadRgba(w: number, h: number): Uint8ClampedArray {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      d[o] = x < w / 2 ? 255 : 0;
      d[o + 1] = y < h / 2 ? 200 : 20;
      d[o + 2] = x < w / 2 ? 10 : 240;
      d[o + 3] = 255;
    }
  }
  return d;
}

/** 四象限图在 (sx, sy) 处的颜色（越界 = 透明）。 */
function quadAt(w: number, h: number, sx: number, sy: number): number[] {
  if (sx < 0 || sy < 0 || sx >= w || sy >= h) return [0, 0, 0, 0];
  return [sx < w / 2 ? 255 : 0, sy < h / 2 ? 200 : 20, sx < w / 2 ? 10 : 240, 255];
}

/** "填满白框"那一套参数（= 导入图片时 `fillManualToTarget()` 写的值）。 */
function fitParamsFor(w: number, h: number): ReturnType<typeof cloneDefaultParams> {
  const p = cloneDefaultParams();
  const s = fillScaleFor(w, h, TARGET_SIZE);
  const off = fillOffsetFor(w, h, TARGET_SIZE);
  p.fitMode = 'manual';
  p.manualFitScale = s;
  p.manualZoom = 1;
  p.manualScale = s;
  p.manualOffsetX = off.x;
  p.manualOffsetY = off.y;
  return p;
}

function bakeWith(w: number, h: number, data: Uint8ClampedArray, p: ReturnType<typeof cloneDefaultParams>): { rgba: Uint8ClampedArray; opaque: number; semi: number } {
  const out = prepareEmblem({ data, width: w, height: h }, toPrepareOptions(p));
  const st = imageStats({ data: out.rgba, width: out.width, height: out.height });
  ok(out.width === TARGET_SIZE && out.height === TARGET_SIZE, `烘焙尺寸 ${out.width}×${out.height} = ${TARGET_SIZE}×${TARGET_SIZE}`);
  return { rgba: out.rgba, opaque: st.opaquePixels, semi: st.semiTransparent };
}

// ── l1：★ 量纲转换（源像素 → 目标像素）= 取反 × scale ──
{
  const p = cloneDefaultParams();
  p.fitMode = 'manual';
  p.manualScale = 0.5;
  p.manualFitScale = 0.5;
  p.manualZoom = 1;
  p.manualOffsetX = 100;
  p.manualOffsetY = -50;
  const t = manualOffsetToTarget(p);
  eq(Number(t.x.toFixed(6)), -50, '★ 界面 offsetX=100（源像素）⇒ 目标像素 −50（取反 ×scale）');
  eq(Number(t.y.toFixed(6)), 25, '★ 界面 offsetY=−50 ⇒ 目标像素 +25');
  const o = toPrepareOptions(p);
  eq(Number(o.offsetX.toFixed(6)), -50, 'toPrepareOptions() 送出去的 offsetX 就是这个换算结果（唯一转换点）');
  eq(Number(o.offsetY.toFixed(6)), 25, 'toPrepareOptions() 送出去的 offsetY 同理');
  eq(Number(o.scale.toFixed(6)), 0.5, 'scale 原样（fitScale × zoom）');
  // 换算的物理含义：源图整体往下 100 个源像素 ⇔ 目标空间里 −100·scale
  const q = { ...p, manualOffsetY: 0 };
  eq(Number(manualOffsetToTarget(q).y.toFixed(6)), 0, 'offset=0（图左上角贴目标左上角）⇒ 目标像素也是 0');
}

// ── l2：★★ 根因回归 —— 非正方形图"填满"后必须有内容，而且**整框都是图** ──
{
  // 旧代码（offset 原样传）的实际后果：先钉住这个数字，免得以后又退回去
  const oldP = fitParamsFor(1024, 600);
  const oldOut = prepareEmblem(
    { data: solidRgba(1024, 600), width: 1024, height: 600 },
    { ...toPrepareOptions(oldP), offsetX: oldP.manualOffsetX, offsetY: oldP.manualOffsetY },
  );
  eq(
    imageStats({ data: oldOut.rgba, width: oldOut.width, height: oldOut.height }).opaquePixels,
    0,
    '★★ 旧写法（offset 原样传）在 1024×600 上烘出 **0** 个不透明像素 —— 这就是用户看到的"图片消失"',
  );
}
for (const [w, h] of [[1000, 800], [1024, 600], [800, 1000], [2048, 512], [256, 256], [50, 50], [1707, 1067]] as Array<[number, number]>) {
  const p = fitParamsFor(w, h);
  const r = bakeWith(w, h, solidRgba(w, h), p);
  eq(r.semi, 0, `${w}×${h} 填满后没有半透明像素`);
  // ★ v0.9："填满白框"= 窗口边长 = 源图**短边**（居中）⇒ 整张源图覆盖整个 128×128 框
  //   ⇒ 对纯不透明的源图，输出应当是**满的 16384 个不透明像素**（一个透明边都没有）。
  //   ⚠ 这就是用户要的效果（"图片默认就顶住这个方框部分"）；旧口径（整张图缩进框里）
  //     在 2048×512 这种极端比例上只占 128×32，看着就是"图变小了"。
  eq(
    r.opaque,
    TARGET_SIZE * TARGET_SIZE,
    `★★ ${w}×${h} 填满白框后整个 128×128 都是图（不透明 ${r.opaque} = 16384，没有留边）`,
  );
  // 窗口边长 = 短边 双确认（用参数反推，口径与 fillWindow() 一致）
  const win = manualToWindow(p, w, h, TARGET_SIZE);
  eq(Number(win.size.toFixed(6)), Math.min(w, h), `★ ${w}×${h} 的默认窗口边长 = 短边 ${Math.min(w, h)}`);
}

// ── l3：白框固定；窗口 ↔ 参数 往返恒等 ──
{
  const box = { w: 700, h: 320 };
  const r1 = frameRectFor(box);
  const r2 = frameRectFor(box);
  eq(`${r1.left},${r1.top},${r1.size}`, `${r2.left},${r2.top},${r2.size}`, '★ 白框的几何只由舞台尺寸决定（"框固定"）');
  ok(r1.size > 0 && r1.left >= 0 && r1.top >= 0 && r1.left + r1.size <= box.w && r1.top + r1.size <= box.h, '★ 白框完全落在舞台里');
  // 舞台变得很小时，框也不能顶出去
  const tiny = frameRectFor({ w: 100, h: 90 });
  ok(tiny.left >= 0 && tiny.top >= 0 && tiny.left + tiny.size <= 100 && tiny.top + tiny.size <= 90, '★ 窄舞台下白框仍然在舞台里（不会顶出去）');
  eq(frameRectFor({ w: 700, h: 320 }).size, 224, '700×320 的舞台 ⇒ 白框 224px（可用短边的 70%）');

  for (const [w, h] of [[1000, 800], [1024, 600], [300, 1000], [128, 128]]) {
    const p = fitParamsFor(w, h);
    const win = manualToWindow(p, w, h, TARGET_SIZE);
    const back = windowToManual(win, w, h, TARGET_SIZE);
    eq(
      `${back.manualOffsetX.toFixed(6)},${back.manualOffsetY.toFixed(6)},${back.manualScale.toFixed(6)}`,
      `${p.manualOffsetX.toFixed(6)},${p.manualOffsetY.toFixed(6)},${p.manualScale.toFixed(6)}`,
      `★ ${w}×${h}：参数 → 窗口 → 参数 往返恒等（进取景视图时"当前图片"接着显示，不跳）`,
    );
    // 默认取景 = "填满白框"：窗口边长 = 源图短边、居中（口径同 fillScaleFor/fillOffsetFor）
    const side = Math.min(w, h);
    const f = { size: side, x: (w - side) / 2, y: (h - side) / 2 };
    eq(
      `${win.size.toFixed(6)},${win.x.toFixed(6)},${win.y.toFixed(6)}`,
      `${f.size.toFixed(6)},${f.x.toFixed(6)},${f.y.toFixed(6)}`,
      `★ ${w}×${h} 的"填满白框"默认参数 ⟺ 窗口边长 = 短边、居中`,
    );
    eq(Number(win.size.toFixed(6)), Math.min(w, h), `★ ${w}×${h}：默认窗口边长就是短边（"一边顶住就停，不缩放"）`);
    eq(Number(effectiveManualScale({ ...p, ...windowToManual(win, w, h, TARGET_SIZE) }).toFixed(6)), Number(back.manualScale.toFixed(6)), '窗口派生出的 manualScale 与 effectiveManualScale() 一致（界面读数 = 真正用的倍率）');
  }
}

// ── l4：★★ 逐点比对 —— "白框里看到的" == "烘焙出来的" ──
{
  const box = { w: 700, h: 320 };
  const f = frameRectFor(box);
  let compared = 0;
  let mismatch = 0;
  for (const [w, h] of [[1000, 800], [1024, 600], [300, 1000], [256, 256], [50, 50]] as Array<[number, number]>) {
    const data = quadRgba(w, h);
    const side = Math.min(w, h) / 2; // 窗口比图小 ⇒ 全在图内，纯"取哪一块"的问题
    for (const [ox, oy] of [[0.5, 0.5], [0.35, 0.7], [0.7, 0.3]]) {
      const win = clampWindow({ size: side, x: (w - side) * ox, y: (h - side) * oy }, w, h);
      const p = { ...fitParamsFor(w, h), ...windowToManual(win, w, h, TARGET_SIZE) };
      const r = bakeWith(w, h, data, p);
      const k = f.size / win.size;
      for (let i = 0; i < 9; i++) {
        for (let j = 0; j < 9; j++) {
          const tx = Math.round((i * (TARGET_SIZE - 1)) / 8);
          const ty = Math.round((j * (TARGET_SIZE - 1)) / 8);
          // A 路径：目标像素中心 → 屏幕 → 源（只用"白框矩形 + 显示倍率"，与参数派生无关）
          const s = s2sSource(box, win, f.left + ((tx + 0.5) * f.size) / TARGET_SIZE, f.top + ((ty + 0.5) * f.size) / TARGET_SIZE);
          const sx = Math.floor(s.x);
          const sy = Math.floor(s.y);
          // 离"四象限分界线"太近的点会被面积平均混色（也离图边太近）⇒ 跳过，不参与精确比对
          if (Math.abs(sx - w / 2) < 2 || Math.abs(sy - h / 2) < 2) continue;
          if (sx < 2 || sy < 2 || sx >= w - 2 || sy >= h - 2) continue;
          compared += 1;
          const o = (ty * TARGET_SIZE + tx) * 4;
          const got = [r.rgba[o], r.rgba[o + 1], r.rgba[o + 2], r.rgba[o + 3]];
          const want = quadAt(w, h, sx, sy);
          if (got.join() !== want.join()) {
            if (mismatch < 3) {
              failures.push(`   白框里看到的与裁下来的不一致：${w}×${h} 目标(${tx},${ty}) 源(${sx},${sy}) 期望[${want}] 实到[${got}]`);
            }
            mismatch += 1;
          }
        }
      }
    }
  }
  ok(compared >= 200, `逐点比对覆盖了足够多的采样点（实到 ${compared} 个）`);
  eq(mismatch, 0, '★★ 白框里看到的像素 == 烘焙出来的像素（屏幕几何与真实 prepareEmblem 逐点一致）');

  // 显示倍率的定义：k = 框边长 / 窗口边长；窗口左上角必须正好落在白框左上角
  {
    const win = clampWindow({ size: 200, x: 130, y: 90 }, 1000, 800);
    const pl = imagePlacement(box, win);
    eq(Number(pl.k.toFixed(9)), Number((f.size / win.size).toFixed(9)), '★ 显示倍率 k = 白框边长 / 窗口边长');
    const tl = s2sScreen(box, win, win.x, win.y);
    eq(`${tl.x.toFixed(6)},${tl.y.toFixed(6)}`, `${f.left.toFixed(6)},${f.top.toFixed(6)}`, '★ 窗口左上角正好落在白框左上角');
    const br = s2sScreen(box, win, win.x + win.size, win.y + win.size);
    eq(`${br.x.toFixed(6)},${br.y.toFixed(6)}`, `${(f.left + f.size).toFixed(6)},${(f.top + f.size).toFixed(6)}`, '★ 窗口右下角正好落在白框右下角');
    eq(`${pl.left.toFixed(6)},${pl.top.toFixed(6)}`, `${(f.left - win.x * pl.k).toFixed(6)},${(f.top - win.y * pl.k).toFixed(6)}`, '★ 源图摆放 = 框位置 − 窗口左上角 × k');
    // 往返
    const back = s2sScreen(box, win, s2sSource(box, win, 137, 219).x, s2sSource(box, win, 137, 219).y);
    ok(Math.abs(back.x - 137) < 1e-9 && Math.abs(back.y - 219) < 1e-9, '★ 屏幕 ↔ 源 往返恒等');
  }
}

// ── l5：拖动 = 平移图片；滚轮 = 以白框中心缩放；拖到哪儿都不许空 ──
{
  const box = { w: 700, h: 320 };
  const f = frameRectFor(box);
  const w0 = clampWindow({ size: 200, x: 400, y: 300 }, 1000, 800);

  // 拖动：图往右拖 d 屏幕像素 ⇒ 白框里的内容正好右移 d 屏幕像素（= 窗口在源图上左移 d/k）
  for (const [dx, dy] of [[10, 0], [-40, 25], [120, -90]]) {
    const moved = panWindow(w0, dx, dy, f.size, 1000, 800);
    eq(
      `${moved.x.toFixed(6)},${moved.y.toFixed(6)}`,
      `${(w0.x - dx * (w0.size / f.size)).toFixed(6)},${(w0.y - dy * (w0.size / f.size)).toFixed(6)}`,
      `★ 拖 (${dx},${dy})：窗口位移 = −拖动距离 × 窗口边长/框边长（与 scale 无关）`,
    );
    const a = s2sSource(box, w0, f.left + f.size / 2, f.top + f.size / 2);
    const b = s2sSource(box, moved, f.left + f.size / 2 + dx, f.top + f.size / 2 + dy);
    ok(Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9, `★ 拖 (${dx},${dy}) 后"框中心那一块图"没变（手感：拖的是图片）`);
  }

  // 滚轮：框中心锚点不动
  {
    const side = 200;
    const c = clampWindow({ size: side, x: (1000 - side) / 2, y: (800 - side) / 2 }, 1000, 800);
    const before = s2sSource(box, c, f.left + f.size / 2, f.top + f.size / 2);
    const z = zoomWindowAtCenter(c, 1.5, 1000, 800);
    const after = s2sSource(box, z, f.left + f.size / 2, f.top + f.size / 2);
    eq(Number(z.size.toFixed(6)), Number((side / 1.5).toFixed(6)), '★ 滚轮放大 1.5× ⇒ 窗口边长 ÷1.5');
    ok(Math.abs(after.x - before.x) < 1e-9 && Math.abs(after.y - before.y) < 1e-9, '★ 以白框中心为锚点：缩放后中心那块图不动');
    const back = zoomWindowAtCenter(z, 1 / 1.5, 1000, 800);
    eq(Number(back.size.toFixed(6)), Number(c.size.toFixed(6)), '★ 反向滚一格 ⇒ 边长回到原值');
  }

  // 缩放上下限（= 白框里永远是"图"而不是"空白"；★ 0.11 起下限 = 目标边长，不允许放大）
  {
    const bounds = windowBoundsFor(1000, 800);
    eq(Number(bounds.max.toFixed(6)), 1000, '★ 窗口边长上限 = 源图长边（再缩只会多出空白）');
    eq(Number(bounds.min.toFixed(6)), TARGET_SIZE, '★★ 窗口边长下限 = 目标边长 128（到 1:1 为止，**不允许放大**）');
    let wIn = clampWindow({ size: 200, x: 0, y: 0 }, 1000, 800);
    let wOut = wIn;
    for (let i = 0; i < 100; i++) {
      wIn = zoomWindowAtCenter(wIn, 1.2, 1000, 800);
      wOut = zoomWindowAtCenter(wOut, 1 / 1.2, 1000, 800);
    }
    eq(Number(wIn.size.toFixed(6)), Number(bounds.min.toFixed(6)), '★ 一直往里滚 ⇒ 停在 128，不会再小');
    eq(Number(wOut.size.toFixed(6)), Number(bounds.max.toFixed(6)), '★ 一直缩小 ⇒ 停在上限（整张图的长边贴住白框）');
    // 用户原话："如果我选了一片非常小的区域，图片就会这样，要不我们限制白框最小取到 128*128"
    for (const [w, h] of [[1707, 1067], [1024, 600], [300, 1000], [128, 128], [200, 90]] as Array<[number, number]>) {
      const b = windowBoundsFor(w, h);
      const short = Math.min(w, h);
      eq(Number(b.min.toFixed(6)), Math.min(TARGET_SIZE, short), `★★ ${w}×${h}：最小窗口 = min(128, 短边 ${short}) ⇒ 绝不放大`);
      ok(b.min >= 128 - 1e-9 || b.min === short, `★ ${w}×${h}：只有"源图本身比 128 小"时才退化成短边`);
      const clamped = clampWindow({ size: 8, x: 0, y: 0 }, w, h);
      ok(clamped.size >= Math.min(TARGET_SIZE, short) - 1e-9, `★★ ${w}×${h}：硬塞一个 8 像素的窗口也会被夹回 ${b.min}（放大路径被堵住）`);
    }
    // 小图（64×64 的 PNG 徽章）仍然能"整张取用"，不会因为下限反而补出透明边
    const tiny = windowBoundsFor(64, 64);
    eq(Number(tiny.min.toFixed(6)), 64, '★ 64×64 的源图 ⇒ 下限退化成 64（= 整张图），不会强行 128');
    eq(Number(Math.min(64, 64).toFixed(6)), 64, '★ 64×64 的默认取景仍是"整张图"（1:1 以内夹得住）');
  }

  // 拖着不放（六个方向 × 40 次）都不许把图拖成空白
  {
    let worstVisible = Infinity;
    for (const [ux, uy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1]]) {
      let cur = clampWindow({ size: 500, x: 250, y: 150 }, 1000, 800);
      for (let i = 0; i < 40; i++) {
        cur = panWindow(cur, ux * 400, uy * 400, f.size, 1000, 800);
        const r = windowSourceRect(cur);
        const vis =
          Math.max(0, Math.min(r.x1, 1000) - Math.max(r.x0, 0)) * Math.max(0, Math.min(r.y1, 800) - Math.max(r.y0, 0));
        worstVisible = Math.min(worstVisible, vis);
      }
    }
    ok(worstVisible > 0, `★ 往六个方向各拖 40 次，白框里始终有图（最少可见 ${worstVisible.toFixed(0)} 源像素²）`);

    // 而且**烘焙出来**也必须非空（旧版拖过头 ⇒ 输出全透明 ⇒ 看着像"图没了"）
    let cur = clampWindow({ size: 500, x: 250, y: 150 }, 1000, 800);
    for (let i = 0; i < 40; i++) cur = panWindow(cur, 400, 400, f.size, 1000, 800);
    const p = { ...fitParamsFor(1000, 800), ...windowToManual(cur, 1000, 800, TARGET_SIZE) };
    ok(bakeWith(1000, 800, solidRgba(1000, 800), p).opaque > 0, '★ 拖到极限后烘焙仍然非空');
  }
}

// ── l6：烘焙自检 —— 宁可报错，也不静默显示空白 ──
{
  const good = checkBakeResult({ pixelCount: 16384, opaquePixels: 16384, semiTransparent: 0, sourceRegionHasOpaque: true });
  ok(good.ok && good.errors.length === 0 && good.warnings.length === 0, '正常烘焙 ⇒ 自检通过、无话可说');
  const size = checkBakeResult({ pixelCount: 100, opaquePixels: 100, semiTransparent: 0, sourceRegionHasOpaque: true });
  ok(!size.ok && /128×128/.test(size.errors.join()), '尺寸不对 ⇒ 报错（说清应该是 128×128）');
  const empty = checkBakeResult({ pixelCount: 16384, opaquePixels: 0, semiTransparent: 0, sourceRegionHasOpaque: true });
  ok(!empty.ok && /映射坏了/.test(empty.errors.join()), '★ 源图那块有内容却烘出全空 ⇒ **报错**（不再静默显示空白）');
  const blank = checkBakeResult({ pixelCount: 16384, opaquePixels: 0, semiTransparent: 0, sourceRegionHasOpaque: false });
  ok(blank.ok && blank.warnings.length === 1, '源图那块本来就是空的 ⇒ 只是**提醒**，不算错（用户确实选了空白处）');
  const semi = checkBakeResult({ pixelCount: 16384, opaquePixels: 100, semiTransparent: 3, sourceRegionHasOpaque: true });
  ok(!semi.ok && /半透明/.test(semi.errors.join()), '还有半透明像素 ⇒ 报错（存档只认 0x00/0x80）');
}

// ── l7：取景视图不再把"已按容器缩放显示"那行留在眼前（用户要求）──
{
  const crop = existsSync(join(WEB, 'src', 'ui', 'cropView.ts')) ? readFileSync(join(WEB, 'src', 'ui', 'cropView.ts'), 'utf8') : '';
  ok(/r\.zoomNote\.hidden = true/.test(crop), '★ 进取景视图时把 #preview-zoom-note 藏起来');
  ok(/r\.zoomNote\.hidden = false/.test(crop), '★ 离开取景视图时恢复');
  ok(!/已按容器缩放显示/.test(crop), '★ cropView.ts 里没有那句放缩说明（它归 pipeline.ts 管）');
  const idx = existsSync(join(WEB, 'index.html')) ? readFileSync(join(WEB, 'index.html'), 'utf8') : '';
  ok(/class="crop-hint"[^>]*>拖动图片，把要用的部分放进白框里（滚轮缩放）</.test(idx), '★ 取景提示就是那一行，且只有一行');
}

// ── l8：所有"挂载点 id"都必须真的在 index.html 里（免得改版时两边不同步，一进取景就抛错）──
{
  const idx = existsSync(join(WEB, 'index.html')) ? readFileSync(join(WEB, 'index.html'), 'utf8') : '';
  const files = ['cropView.ts', 'main.ts', 'pipeline.ts', 'slotsView.ts', 'cardOps.ts', 'dom.ts'];
  // `toasts` 是 dom.ts 自己按需创建的（不在外壳里），是唯一的例外
  const dynamicIds = new Set(['toasts']);
  const missing: string[] = [];
  let checked = 0;
  for (const f of files) {
    const p = join(WEB, 'src', 'ui', f);
    if (!existsSync(p)) continue;
    const src = readFileSync(p, 'utf8');
    for (const m of src.matchAll(/(?:need|getElementById|\$)\(\s*'([A-Za-z0-9_-]+)'/g)) {
      const id = m[1];
      if (dynamicIds.has(id)) continue;
      checked += 1;
      if (!new RegExp(`id="${id}"`).test(idx)) missing.push(`${f}: #${id}`);
    }
  }
  ok(checked > 20, `挂载点交叉核对覆盖了 ${checked} 处引用`);
  eq(missing.join('、'), '', '★ 代码里引用的每个挂载点 id 都在 index.html 里（cropView 的 need() 不会在运行时抛"缺少挂载点"）');
}

// ── l9：★ 取景拖动为什么不卡（v0.7）：取景期间只动视觉，不跑管线、不刷面板 ──
//
// 实测（1000×800 = 0.8 M 像素的源图，旧写法每次 pointermove）：
//   prepareEmblem() 53~298 ms（含中位切分量化） + 统计面板里整张源图的 imageStats() 10~99 ms
//   ⇒ **63~397 ms / 次**，而 60fps 的预算是 16.7 ms/帧。
// 这段是**源码级**判据（运行时判据在打包冒烟里：拖动 40 次 ⇒ prepareEmblem 0 次 / 面板刷新 0 次 / 新画布 0 个）。
{
  const crop = existsSync(join(WEB, 'src', 'ui', 'cropView.ts')) ? readFileSync(join(WEB, 'src', 'ui', 'cropView.ts'), 'utf8') : '';
  ok(crop.length > 0, '读到了 cropView.ts');
  // ⚠ "有没有调某个函数"必须在**掩掉注释与字符串**之后的源码上判 —— 否则文档里提到
  //   "我们故意不调 recompute()" 这种话会被当成"真的调了"（本条断言第一版就栽在这上面）。
  const cropCode = maskSource(crop);

  // ① 取景模块**不许**碰管线：它只调 main.ts 注入的回调
  for (const banned of ['recompute', 'prepareEmblem', 'encodeEmblem', 'refreshImage', 'renderStats', 'renderOriginalBadge']) {
    ok(!new RegExp(`\\b${banned}\\b`).test(cropCode), `★ cropView.ts 的真代码里不出现 ${banned}（取景期间不跑管线 / 不刷面板）`);
  }
  // ② "完整刷新"只允许出现在**一个**地方：提交参数那一下
  eq((cropCode.match(/onChanged\?\.\(\)/g) ?? []).length, 1, '★ 全模块只有 1 处调 onChanged（= commitWindow 里提交参数那一次）');
  ok(/function commitWindow/.test(cropCode), '★ 有 commitWindow()：写参数 + 跑一次完整管线（唯一的提交点）');
  ok(/export function confirmCrop[\s\S]{0,600}commitWindow\(\)/.test(crop), '★ 〔确定取景〕里才调 commitWindow()');
  // ★ 2026-10-05（v0.9）：〔↺ 复位 / 适应〕按钮连函数一起删掉了（用户："这个按钮没用，删了吧"）
  ok(
    !/fitCropToImage/.test(cropCode) && !/btn-crop-fit/.test(cropCode),
    '★★ cropView.ts 里不再有 fitCropToImage() / btn-crop-fit（复位按钮已按用户要求删除）',
  );
  ok(
    !/resetManual/.test(cropCode) && !/复位/.test(cropCode),
    '★★ cropView.ts 的真代码里也不再提"复位"（连注释里的旧交互说明都清掉了）',
  );
  ok(/onRelayout/.test(cropCode), '★ 有独立的轻量回调 onRelayout（离开取景视图时只重画预览画布）');
  // 工具条那个按钮：进去/收起；收起时若还有未提交的调整，必须提交（不许静默丢掉用户刚拖好的取景）
  ok(/export function toggleCropView/.test(cropCode), '★ 工具条按钮走 toggleCropView()');
  ok(/function hasUncommittedWindow/.test(cropCode), '★ 有 hasUncommittedWindow()：判断窗口与已提交参数是否不一致');
  ok(
    /export function toggleCropView[\s\S]{0,400}?hasUncommittedWindow\(\)[\s\S]{0,120}?confirmCrop\(\)/.test(cropCode),
    '★ 收起时若窗口没提交过 ⇒ 走 confirmCrop()（写参数 + 自检），不静默丢弃',
  );

  // ③ rAF 合帧：指针处理只记位移，样式由 rAF 里的 flush 写
  ok(/requestAnimationFrame/.test(cropCode), '★ 用 requestAnimationFrame 合帧（一帧最多写一次样式）');
  ok(/export function applyDrag/.test(cropCode) && /export function applyZoom/.test(cropCode), '★ 拖动/缩放各有一个共用入口（指针与冒烟走同一段代码）');
  ok(/export function flushCropLayout/.test(cropCode), '★ 有 flushCropLayout()：把待处理动作立刻应用（rAF 回调与抬手共用）');
  ok(/addEventListener\('pointermove'[\s\S]{0,400}?applyDrag\(/.test(crop), '★ pointermove 里只调 applyDrag()（不在这里改样式）');
  ok(!/addEventListener\('pointermove'[\s\S]{0,400}?style\./.test(crop), '★ pointermove 处理里没有任何 style.* 写入');
  ok(/'wheel'[\s\S]{0,400}?applyZoom\(/.test(crop), '★ wheel 里只调 applyZoom()');
  ok(/function applyPending[\s\S]{0,900}?layoutCropView\(\)/.test(cropCode), '★ 待处理动作在 applyPending() 里统一应用 + 重排');
  ok(/pending\?\.dx \?\? 0\) \+ dx/.test(cropCode), '★ 一帧内的多次拖动会**累加**（合帧，不是每次都重排）');

  // ④ 滚轮不能带着页面滚；布局读只在进视图/改窗口尺寸时做
  ok(/\{ passive: false \}/.test(cropCode), '★ wheel 监听是 passive: false');
  ok(/'wheel'[\s\S]{0,300}?preventDefault\(\)/.test(crop), '★ wheel 里先 preventDefault()（否则页面跟着滚，也是"卡"的来源）');
  ok(/setPointerCapture/.test(cropCode) && /releasePointerCapture/.test(cropCode), '★ 拖动用 setPointerCapture，抬手释放');
  ok(/cachedBox/.test(cropCode), '★ 舞台尺寸走缓存（拖动时一次布局读都不做 —— 避免 layout thrash）');
  ok(/function stageBox[\s\S]{0,300}?getBoundingClientRect/.test(cropCode), '★ 只有 stageBox() 读 getBoundingClientRect()');
  eq(
    (cropCode.match(/getBoundingClientRect\(\)/g) ?? []).length,
    2,
    '取景视图的真代码里只有 2 处布局读（舞台盒子 + 指针坐标换算），都不是每帧的样式写读交替',
  );

  // ⑤ 光标的 none/抓手指令保持（别为了让滚动复位把交互弄坏）
  const css = existsSync(join(WEB, 'styles.css')) ? readFileSync(join(WEB, 'styles.css'), 'utf8') : '';
  ok(/\.crop-stage\s*\{[^}]*touch-action:\s*none/.test(css), '★ .crop-stage 仍然是 touch-action: none');
  ok(/\.crop-stage\s*\{[^}]*cursor:\s*grab/.test(css), '★ 取景区光标仍是"抓手"');

  // ⑥ 性能哨兵本身：pipeline.ts 里两个计数器 + 只读入口
  const pipe = existsSync(join(WEB, 'src', 'ui', 'pipeline.ts')) ? readFileSync(join(WEB, 'src', 'ui', 'pipeline.ts'), 'utf8') : '';
  ok(/export function pipelineStats/.test(pipe), '★ pipeline.ts 暴露 pipelineStats()（prepareCalls / refreshCalls）');
  ok(/prepareCallCount \+= 1/.test(pipe), '★ prepareEmblem 的调用点有计数');
  ok(/refreshCallCount \+= 1/.test(pipe), '★ refreshImage()（面板刷新）有计数');
  ok(/pipelineStats/.test(
    existsSync(join(WEB, 'src', 'ui', 'main.ts')) ? readFileSync(join(WEB, 'src', 'ui', 'main.ts'), 'utf8') : '',
  ), '★ main.ts 把 pipelineStats 挂到 window.EmblemToolCore.ui.pipeline（F12 / 冒烟可读）');
}

// ==========================================================================
// (m) ★ 0.25：写前"这张卡在磁盘上被改过吗"的拦截 + 删除立刻写回
// ==========================================================================
//
// 来由（用户 2026-10-06 实测）：写槽 3 时 `createWritable()` 抛
//   `InvalidStateError: ...the state had changed since it was read from disk.`
// 用户确认的情形：**PCSX2 一直开着**、这次会话一次都没成功写过、只有一个标签页、卡在本地目录
// ⇒ 是 PCSX2 在"工具选卡"之后又写了那个文件。原来一路写到落盘才炸，用户只拿到一句英文错，
// 而"重试"必然再失败。现在把判断提到写之前。

section('(m) ★ 0.25：写前时间戳拦截 +〔删除槽〕立刻写回卡文件');

{
  const t0 = { mtime: 1_700_000_000_000, size: 8_650_752 };

  // ── ① 时间戳比较：**只看 mtime 不够，只看 size 更不够** ──
  ok(!stampChanged(t0, { mtime: t0.mtime, size: t0.size }), '同一状态 ⇒ 不算变过');
  ok(
    stampChanged(t0, { mtime: t0.mtime + 1, size: t0.size }),
    '★ 只有 mtime 变（大小不变）也算变过 —— 记忆卡是**定长 8 MB**，光比 size 会漏掉 PCSX2 的写回',
  );
  ok(stampChanged(t0, { mtime: t0.mtime, size: t0.size + 1 }), '只有 size 变也算变过');

  // ── ② 时间戳渲染 ──
  eq(describeStamp(null), '未知', '没记到时间戳时说"未知"（不编一个假时间）');
  ok(
    /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(describeStamp(t0)),
    `时间戳渲染成人读的本地时间（实到 "${describeStamp(t0)}"）`,
  );

  // ── ③ 拒绝写入的说明必须"能照着做"（用户实测反馈：只写"失败了"没用）──
  const t1 = { mtime: t0.mtime + 28 * 60 * 1000, size: t0.size };
  const refusal = staleFileRefusal({ fileName: 'Mcd001.ps2', seen: t0, now: t1 });
  ok(refusal.includes('Mcd001.ps2'), '说明里点名**哪个文件**');
  ok(refusal.includes(describeStamp(t0)) && refusal.includes(describeStamp(t1)), '★ 两个时间都写出来（打开时 / 现在）');
  ok(refusal.includes(humanBytes(t0.size)), '顺带写出文件大小（便于判断是不是被换成别的卡）');
  ok(refusal.includes('PCSX2'), '说出最可能的元凶（PCSX2）');
  ok(refusal.includes('没有写盘'), '★ 明确告诉用户"这次没有写盘"（磁盘一个字节没动）');
  ok(/①[^\n]*完全退出 PCSX2/.test(refusal), '★ 第①步：完全退出 PCSX2');
  ok(/②[^\n]*重新选一次/.test(refusal), '★ 第②步：重新选一次这张卡（拿到新鲜句柄）');
  ok(/③[^\n]*再操作一次/.test(refusal), '★ 第③步：再操作一次');
  ok(/另存为/.test(refusal) && /抹掉|别用/.test(refusal), '★ 警告"别用〔另存为〕存出来的副本盖回去"（内存副本是旧的）');

  // ── ④ 兜底提示（真抛 InvalidStateError 时用）──
  ok(STALE_HANDLE_HINT.includes('完全退出 PCSX2'), '兜底提示同样给出"完全退出 PCSX2"');
  ok(STALE_HANDLE_HINT.includes('重新选一次'), '兜底提示同样给出"重新选一次这张卡"');
  ok(STALE_HANDLE_HINT.includes('另存为'), '兜底提示同样带那条"别用另存为的副本盖回去"');
}

{
  // ── ⑤ 接线判据（源码层面：这几步必须是**结构上**存在的，不是"我记得写过"）──
  const cardOpsSrc = existsSync(join(WEB, 'src', 'ui', 'cardOps.ts'))
    ? readFileSync(join(WEB, 'src', 'ui', 'cardOps.ts'), 'utf8')
    : '';
  const mainSrc = existsSync(join(WEB, 'src', 'ui', 'main.ts')) ? readFileSync(join(WEB, 'src', 'ui', 'main.ts'), 'utf8') : '';
  const cardOpsCode = maskSource(cardOpsSrc);
  const mainCode = maskSource(mainSrc);

  ok(/async function persistCardChange/.test(cardOpsCode), '★ 落盘抽成了 `persistCardChange()`（写入与删除共用同一条路）');
  ok(
    /stampChanged\(lc\.lastSeen, now\)/.test(cardOpsCode) && /staleFileRefusal\(/.test(cardOpsCode),
    '★★ 落盘**之前**先比时间戳；变了就用 `staleFileRefusal()` 说明并拒绝',
  );
  ok(/async function preflightStale/.test(cardOpsCode), '★ 写前拦截抽成 `preflightStale()`（写入与删除共用）');
  // ★★ 位置判据：拦截必须在**任何内存改动之前** —— 否则"拒绝"会留下一个改过的内存副本，
  //    而模型还是旧的 ⇒ 再点一次就撞"已经有 dataN，拒绝覆盖"（用户实测到的第二条错就是这么来的）。
  {
    const inWrite = cardOpsSrc.indexOf('const stale = await preflightStale(lc);');
    const firstMutate = cardOpsSrc.indexOf('written = writeBlockToTarget(target, block);');
    ok(inWrite > 0 && firstMutate > inWrite, '★★ 写入路径里 preflightStale() 在 writeBlockToTarget() **之前**');
    const inDelete = cardOpsSrc.indexOf('const stale = await preflightStale(lc);', inWrite + 1);
    const firstDeleteMutate = cardOpsSrc.indexOf('const r = deleteSlotFile(dirName, fileName);');
    ok(inDelete > 0 && firstDeleteMutate > inDelete, '★★ 删除路径里 preflightStale() 在 deleteSlotFile() **之前**');
  }
  ok(
    /lc\.lastSeen = \{ mtime: after\.lastModified, size: after\.size \}/.test(cardOpsCode),
    '★ 覆盖成功后用**回读到的那个 File** 更新 lastSeen（否则下一次写入会误判成"被改过"）',
  );
  ok(
    // ⚠ 这两句要拿**原文**比：`maskSource()` 会把字符串字面量的内容抹成空格
    //   （`'InvalidStateError'` 只剩一对引号）⇒ 用掩码版会永远匹配不上。
    // ★ 0.28：原来断言的是常量 `STALE_HANDLE_HINT`；双语化之后界面必须走**按语言取文案**的
    //   `staleHandleHint()`（常量只留中文原文，给下面 (m2) 那三条断言用）⇒ 这里改成断言函数调用。
    /e\.name === 'InvalidStateError'/.test(cardOpsSrc) && /staleHandleHint\(\)/.test(cardOpsSrc),
    '★ `InvalidStateError`（检查与落盘之间又被改了）单独处理，换成能照做的说明',
  );
  ok(
    /export async function deleteSlotAndSave/.test(cardOpsCode) &&
      /deleteSlotFile\(dirName, fileName\)/.test(cardOpsCode),
    '★ 新增 `deleteSlotAndSave()`：内存副本上删（`deleteSlotFile`）',
  );
  ok(
    /persistCardChange\(\{ lc, changes: \[r\.message\], confirmedAlready: true \}\)/.test(cardOpsCode),
    '★★ 删除后**立刻走同一条落盘**（且不弹第二次确认框 —— 上面那个已经问过"会写回卡"）',
  );
  ok(
    /deleteSlotAndSave\(s\.dirName, s\.fileName\)/.test(mainCode),
    '★〔删除槽〕按钮接的是 `deleteSlotAndSave()`（不再只改内存）',
  );
  ok(
    !/还没落盘 —— 用"导出整卡"/.test(mainSrc),
    '★★ 那句"还没落盘，用导出整卡或写入选中槽时会走确认框"已经删掉（删除现在自己落盘）',
  );
  ok(
    /mtime: file\.lastModified,\s*size: file\.size/.test(mainSrc),
    '★ 选卡时把 `lastModified` / `size` 一起交给 `openCardFromBytes()`',
  );
  ok(
    /out\.deleted && out\.ok/.test(mainCode) && /内存里已删除，但没有落盘/.test(mainSrc),
    '★ 落盘失败时如实说"内存里已删、磁盘没动"（`deleted` 与 `ok` 分开报；0.44 起不再写 `**没有落盘**`）',
  );
}

// ==========================================================================
// (n) ★ 0.26：开机告知弹窗 + 取景模式不许写入 +〔另存为〕
// ==========================================================================
section('(n) ★ 0.26：开机告知（自行备份）/ 取景模式拦截 /〔另存为〕');

{
  const mainSrc = read('src/ui/main.ts');
  const opsSrc = read('src/ui/cardOps.ts');
  const domSrc = read('src/ui/dom.ts');
  const staleSrc = read('src/ui/logic/staleness.ts');
  const idx = read('index.html');
  const css = read('styles.css');
  const mainCode = maskSource(mainSrc);
  const opsCode = maskSource(opsSrc);

  // ── ① 打开页面就弹一次"未经测试 / 自行备份" ──
  ok(/export function showModal/.test(domSrc), '★ dom.ts 提供 `showModal()`（必须点掉才能继续的弹窗）');
  ok(
    /modal-host/.test(domSrc) && /\.modal-host\s*\{[^}]*position:\s*fixed/.test(css),
    '★ 弹窗是整页遮罩（`position: fixed` ⇒ 点掉之前下面的界面点不到）',
  );
  ok(/\.modal-host\[hidden\]\s*\{\s*display:\s*none/.test(css), '★ 收起靠 `hidden` 属性（不写 inline display）');
  // ★ 0.40：`showModal()` 的入参改成**渲染函数**（`() => ({…})`），这样切语言能重放一遍
  ok(/showModal\(\(\) => \(\{[\s\S]{0,900}?本项目未经过完整测试/.test(mainSrc), '★★ boot() 里弹的是"本项目未经过完整测试"');
  ok(/没有经过完整的实机验证/.test(mainSrc), '★ 文案点明"没有经过完整的实机验证"');
  ok(/请先自己备份记忆卡/.test(mainSrc) && /复制一份到别处/.test(mainSrc), '★★ 文案要求用户**自己先备份记忆卡**');
  ok(/我已知晓，并会自行备份记忆卡/.test(mainSrc), '★ 按钮措辞就是"我已知晓，并会自行备份记忆卡"');
  ok(/完全退出 PCSX2/.test(mainSrc), '★ 开机告知里顺带把那条硬规矩也说清（PCSX2 会把手里的卡写回文件）');
  // ★ 0.14 的教训：可见文案里**不许**出现 markdown 的 `**`（HTML 不认，会原样显示两个星号）。
  {
    const modalTexts = [...mainSrc.matchAll(/showModal\(\(\) => \(\{([\s\S]{0,3000}?)\n\s*\}\)\)/g)].map((m) => m[1]);
    eq(modalTexts.length, 2, '源码里正好两处 showModal（开机告知 + 取景拦截）');
    ok(
      modalTexts.every((t) => !/\*\*/.test(t)),
      '★★ 两处弹窗的可见文案里都没有 markdown 的 `**`（0.14 踩过：界面上会原样显示两个星号）',
    );
  }

  // ── ② 写入前拦"还在取景模式" ──
  ok(/isCropActive\(\)/.test(mainCode), '★★ doWrite() 里先查 `isCropActive()`');
  {
    // ★ 0.28：`if (isCropActive())` 现在有两处（`relayoutForLang()` 里也有一处）⇒ 必须**从 doWrite() 往后找**，
    //   否则量到的是语言切换那一行，下面两条断言会假失败（本轮就踩了）。
    const doWriteAt = mainSrc.indexOf('async function doWrite');
    const at = mainSrc.indexOf('if (isCropActive())', doWriteAt);
    const writeAt = mainSrc.indexOf('await writeSlot(');
    ok(at > 0 && writeAt > at, '★★ 这个检查排在 `writeSlot()`（真正写入）**之前**');
    const seg = mainSrc.slice(at, at + 700);
    ok(/确定取景/.test(seg), '★★ 弹窗明确告诉用户"点〔确定取景〕才能继续"');
    ok(!/confirmCrop\(\)/.test(seg), '★★ 不替用户自动确定取景 —— 必须他手动点（用户原话："需要弹窗告诉用户手动确认取景才能继续"）');
  }

  // ── ③〔导出整卡〕→〔另存为〕──
  ok(/id="btn-save-as"/.test(idx) && /另存为/.test(idx), '★★ 按钮是〔另存为〕（id `btn-save-as`）');
  ok(/export async function saveCardAs/.test(opsCode), '★ cardOps 导出 `saveCardAs()`');
  ok(/showSaveFilePicker/.test(opsCode), '★★ 走 `showSaveFilePicker()`：位置与文件名由用户选（真正的"另存为"）');
  ok(/suggestedName/.test(opsCode) && /_copy\.ps2/.test(opsSrc), '★ 建议文件名 `<原名>_copy.ps2`');
  ok(/e\.name === 'AbortError'/.test(opsSrc) && /已取消另存为/.test(opsSrc), '★ 用户按取消 ⇒ 什么都不做（不偷偷改成下载）');
  ok(
    /另存出来的文件与内存里的卡不一致/.test(opsSrc) && /回读逐字节一致/.test(opsSrc),
    '★ 另存完照例回读比对（与写卡同一条规矩），不一致就报错',
  );
  ok(/downloadCard\(lc\.card\.buf, suggested\)/.test(opsCode), '★ 拿不到那个对话框时**退化成下载**（SPEC §三 的降级策略）');
  // 老名字与老提示文案都不许留
  // ⚠ 判据在**去注释**的 markup 上做：注释里保留"以前叫〔导出整卡〕"这类历史说明是允许的（项目惯例），
  //   而"id / 函数名不许长回来"那两条在分节 ⑯ 里用 ASCII 名字钉住了（注释里不写 ASCII 名）。
  ok(!/导出整卡/.test(idx.replace(/<!--[\s\S]*?-->/g, '')), '★★ 界面上不再出现"导出整卡"这个旧叫法（按钮已改名〔另存为〕）');
}

// ==========================================================================
// (o) ★ 0.27：顶栏不再列"整卡徽章目录"；按钮文字里的省略号全部去掉
// ==========================================================================

section('(o) ★ 0.27：删掉顶栏整卡目录清单 / 按钮文字不带省略号');

{
  const idx = read('index.html');
  // ⚠ 判据在**去注释**的 markup 上做：注释里保留"以前这里有什么"这类历史说明是本项目惯例。
  const idxMarkup = idx.replace(/<!--[\s\S]*?-->/g, '');
  const mainSrc = read('src/ui/main.ts');
  const opsSrc = read('src/ui/cardOps.ts');
  const mainCode = maskSource(mainSrc); // 注释/字符串抹掉：只查真代码
  const opsCode = maskSource(opsSrc);
  const dist = existsSync(DIST) ? readFileSync(DIST, 'utf8') : '';

  /**
   * 取一个顶层函数的函数体。
   * ⚠ 工作区是 **CRLF**（`.gitattributes` 只是声明"提交时用 LF"）⇒ 边界必须用 `\r?\n`，
   *   否则 `indexOf('\n}\n')` 永远找不到、函数体变成"从这里到文件末尾"（本节第一版就踩了：
   *   数出来 15 处 `host.appendChild(` 而不是 3 处）。
   */
  const fnBody = (src: string, name: string): string => {
    const at = src.indexOf(`function ${name}(`);
    if (at < 0) return '';
    const m = /\r?\n\}\r?\n/.exec(src.slice(at));
    return m ? src.slice(at, at + m.index + m[0].length) : src.slice(at);
  };

  // ── ① 顶栏那一段"整卡徽章目录清单"删掉（用户："我认为这一段内容没有显示价值的，删了吧"）──
  ok(!/describeCardDirs/.test(mainCode), '★★ main.ts 里那个清单函数已删（不再有 describeCardDirs）');
  // ⚠ 这条能在**产物**上做，是因为那段文案在源码注释里也**故意没有逐字写出**（否则注释进产物 = 判据自红）
  ok(!dist.includes('卡上一共有'), '★★ 产物里不再出现那句 UI 文案（是删掉，不是藏起来）');
  {
    const body = fnBody(mainCode, 'renderCardInfo');
    ok(body.length > 0, '★ 找得到 renderCardInfo() 的函数体');
    eq(
      (body.match(/host\.appendChild\(/g) ?? []).length,
      3,
      '★ renderCardInfo() 只剩 3 处 appendChild（空态 1 + 有卡 2：锁状态 / 文件大小）',
    );
    ok(/humanBytes\(lc\.sourceBytes\.length\)/.test(body), '★ 卡文件大小那段还在（删的是第三段，不是整行）');
  }
  ok(/lc\.handle \? 'ok' : 'warn'/.test(mainSrc), '★ 锁状态那段的判据还在（🔓 能直接覆盖 / 🔒 只读）');
  // 只服务它的扫描函数**不是简单删掉**：`planWriteTarget()` 还要用它区分两种"目录不存在"
  ok(/export function cardEmblemDirNames\(\): string\[\]/.test(opsCode), '★ cardOps 改成导出 `cardEmblemDirNames(): string[]`');
  ok(
    !/scanCard/.test(opsCode) && !/CardDirInfo/.test(opsCode) && !/rootNames/.test(opsCode),
    '★★ `scanCard()` / `CardDirInfo` / `rootNames` 一并删掉（只剩名字，不再对每个目录跟一遍 FAT 链）',
  );
  ok(/const cardDirNames = cardEmblemDirNames\(\);/.test(opsCode), '★ `planWriteTarget()` 改用新函数（写入规划的判据没变）');
  ok(/cardDirNames,/.test(opsCode), '★ 规划器照旧拿到整卡目录名（"卡上没有"与"不属于本作品"仍分得开）');

  // ── ② 按钮文字里不许再有省略号（用户选的是"省略号一个都不留"）──
  // ⚠ 两条纪律，否则这个判据会自己骗自己：
  //   ① 先把 HTML 注释整段去掉 —— 注释里会写"以前叫〔取景…〕"，那是历史说明，不是按钮文字；
  //   ② 标签必须写成 `<button` **后面跟空白**（真按钮都带属性）——
  //      注释里若出现光秃秃的尖括号写法，`[^>]*>` 会把它当成标签开始、一路吃到真按钮的 `</button>`。
  const buttonTexts = (html: string): string[] =>
    [
      ...html
        .replace(/<!--[\s\S]*?-->/g, '')
        .matchAll(/<button\s[^>]*>([\s\S]*?)<\/button>/g),
    ].map((m) => m[1].trim());
  {
    const labels = buttonTexts(idxMarkup);
    ok(labels.length >= 10, `★ 认得清所有按钮（实到 ${labels.length} 个）`);
    eq(labels.filter((t) => t.includes('…')).join(','), '', '★★ 界面按钮文字里一个省略号都没有');
    ok(labels.includes('取景'), '★★ 〔取景〕不带省略号了（原来是"取景…"）');
    ok(labels.includes('另存为'), '★★ 〔另存为〕不带省略号了（0.26 刚改名，0.27 去掉 `…`）');
  }
  {
    const labels = buttonTexts(dist); // 产物里是同一份 HTML 内联进去的，再查一遍
    eq(labels.filter((t) => t.includes('…')).join(','), '', '★★ 产物里的按钮文字同样没有省略号');
    ok(labels.includes('取景') && labels.includes('另存为'), '★ 产物里就是〔取景〕〔另存为〕');
  }
  // ⚠ 只查**按钮文字**：`⏳ 正在处理…` 的 `…` 是"进行中"的意思，不是"还要再开一层"，保留
  ok(/正在处理…/.test(idxMarkup), '★ 〔⏳ 正在处理…〕的省略号没被误删（进度语义，与按钮命令无关）');
  // 〔选择记忆卡〕〔选择 / 粘贴图片〕按界面惯例本可以带 `…`，用户选了"一个都不留" ⇒ 同样不带
  ok(
    buttonTexts(idxMarkup).includes('选择记忆卡') && buttonTexts(idxMarkup).includes('选择 / 粘贴图片'),
    '★ 真正会弹系统对话框的那两个按钮也没有 `…`（"一个都不留"是**统一**的，不是只改了两个）',
  );
}

// ==========================================================================
// (p) ★ 0.28：中英双语（顶栏语言选择器 + t() 原文配对 + 静态 [data-en]）
// ==========================================================================

section('(p) ★ 0.28：中英双语（默认中文 / 英文浏览器自动 English / 手动切过听用户的）＋ 0.36：语言标签常显双语');

{
  const idx = read('index.html');
  const idxMarkup = idx.replace(/<!--[\s\S]*?-->/g, '');
  const css = read('styles.css');
  const mainSrc = read('src/ui/main.ts');
  const i18nSrc = read('src/ui/logic/i18n.ts');
  const dist = existsSync(DIST) ? readFileSync(DIST, 'utf8') : '';

  // ── ① 默认语言与选项（用户："默认中文，然后支持英文"；0.47 加日/韩）──
  eq(DEFAULT_LANG, 'zh', '★ 默认语言 = 中文');
  eq(LANGS.map((l) => l.value).join(','), 'zh,en,ja,ko', '★ 四个选项：中文 → English → 日本語 → 한국어');
  eq(LANGS.map((l) => l.label).join(','), '中文,English,日本語,한국어', '★ 语言名各自用自己的语言写（不翻译）');
  eq(LANG_STORAGE_KEY, 'ac-emblem-tool:lang', '★ localStorage 的键固定（改它 = 老用户的选择会丢）');

  // ── ② 首次打开怎么定语言（用户选的是"英文浏览器自动给英文"）──
  eq(langFromNavigator('zh-CN'), 'zh', '浏览器 zh-CN ⇒ 中文');
  eq(langFromNavigator('zh-Hant'), 'zh', '浏览器 zh-Hant ⇒ 中文');
  eq(langFromNavigator('en-US'), 'en', '★ 浏览器 en-US ⇒ English');
  eq(langFromNavigator('en'), 'en', '★ 浏览器 en ⇒ English');
  eq(langFromNavigator('ja-JP'), 'ja', '★ 浏览器 ja-JP ⇒ 日本語（0.47 起）');
  eq(langFromNavigator('ko-KR'), 'ko', '★ 浏览器 ko-KR ⇒ 한국어（0.47 起）');
  eq(langFromNavigator('fr-FR'), 'zh', '★ 其它语言（fr）⇒ **默认中文**，不瞎给英文');
  eq(langFromNavigator(''), 'zh', '拿不到 navigator.language ⇒ 默认中文');
  eq(langFromSaved('en'), 'en', '存过 en ⇒ en（手动优先）');
  eq(langFromSaved('zh'), 'zh', '存过 zh ⇒ zh');
  eq(langFromSaved('ja'), 'ja', '存过 ja ⇒ ja');
  eq(langFromSaved('ko'), 'ko', '存过 ko ⇒ ko');
  eq(langFromSaved(null), null, '没存过 ⇒ null');
  eq(langFromSaved('de'), null, '存了个垃圾值 ⇒ 当作没存过（不崩、不瞎认）');
  ok(/detectLang\(\)/.test(maskSource(i18nSrc)), '★ detectLang() 仍然存在（启动时唯一的判定入口）');
  // ★ 0.47：`<html lang>` 按语言给（CSS 的 `:lang(ja)` / `:lang(ko)` 字体栈靠它）
  eq(HTML_LANG.zh, 'zh-CN', 'html lang：中文 = zh-CN');
  eq(HTML_LANG.en, 'en', 'html lang：英文 = en');
  eq(HTML_LANG.ja, 'ja', 'html lang：日文 = ja');
  eq(HTML_LANG.ko, 'ko', 'html lang：韩文 = ko');
  eq(DATA_LANGS.join(','), 'en,ja,ko', '★ 静态属性承载的语言顺序 = en,ja,ko（中文 = DOM 原文）');

  // ── ③ t()：**四种语言**必须都给，且支持 {name} 占位 ──
  const T4: [string, string, string, string] = ['槽位 {n}', 'Slot {n}', 'スロット {n}', '슬롯 {n}'];
  setLang('zh', { persist: false });
  eq(t(...T4, { n: 3 }), '槽位 3', 't() 中文 + 占位替换');
  setLang('en', { persist: false });
  eq(currentLang(), 'en', 'setLang(en) 之后 currentLang() = en');
  eq(t(...T4, { n: 3 }), 'Slot 3', '★ t() 英文 + 占位替换');
  setLang('ja', { persist: false });
  eq(t(...T4, { n: 3 }), 'スロット 3', '★ t() 日文 + 占位替换');
  setLang('ko', { persist: false });
  eq(t(...T4, { n: 3 }), '슬롯 3', '★ t() 韩文 + 占位替换');
  eq(t('只有中文', 'English only', '日本語のみ', '한국어만'), '한국어만', '韩文分支生效');
  eq(t('没有占位', 'no placeholder', 'プレースホルダーなし', '자리 표시자 없음'), '자리 표시자 없음', '没有 vars 时原样返回（不做替换）');
  eq(t('{a}-{b}', '{a}-{b}', '{a}-{b}', '{a}-{b}', { a: 'x' }), 'x-{b}', '缺的占位保持原样（不变成 undefined）');
  setLang('zh', { persist: false });
  eq(t(...T4, { n: 3 }), '槽位 3', '切回中文之后又变回中文');
  // ★★ 0.47：每个 sink 调用必须有**四个字符串字面量实参**（少给一个 = 那种语言显示 undefined）
  //   判据打在**掩码后**的源码上（注释里的示例不算），实参按第 1 层逗号切。
  {
    /** 返回 [第 1 层每个实参是否为"整段就是一个字符串字面量"]。 */
    const argKinds = (raw: string, masked: string, openIdx: number): boolean[] => {
      const kinds: boolean[] = [];
      let depth = 0;
      let start = openIdx + 1;
      const flush = (end: number): void => {
        const seg = raw.slice(start, end).trim();
        if (seg === '') return;
        kinds.push(/^(['"`])[\s\S]*\1$/.test(seg) && seg.length >= 2);
      };
      for (let k = openIdx; k < masked.length; k++) {
        const c = masked[k];
        if (c === '(') depth += 1;
        else if (c === ')') {
          depth -= 1;
          if (depth === 0) {
            flush(k);
            return kinds;
          }
        } else if (c === ',' && depth === 1) {
          flush(k);
          start = k + 1;
        }
      }
      return kinds;
    };
    const files = [
      'src/ui/main.ts',
      'src/ui/cardOps.ts',
      'src/ui/cropView.ts',
      'src/ui/pipeline.ts',
      'src/ui/slotsView.ts',
      'src/ui/dom.ts',
      'src/ui/state.ts',
      'src/ui/logic/planWrite.ts',
      'src/ui/logic/writeGuard.ts',
      'src/ui/logic/staleness.ts',
      'src/ui/logic/pcsx2.ts',
      'src/ui/logic/pcsx2Paths.ts',
      'src/ui/logic/slots.ts',
      'src/ui/logic/games.ts',
      'src/ui/logic/cropGeometry.ts',
      'src/ui/logic/writePermission.ts',
    ];
    const bad: string[] = [];
    let checked = 0;
    for (const f of files) {
      const raw = read(f);
      const masked = maskSource(raw);
      for (const m of masked.matchAll(/(?<![.\w$])(t|setStatusPair|refusedNote)\(/g)) {
        const kinds = argKinds(raw, masked, m.index + m[0].length - 1);
        // 变量形式的实参（`t(g.label, g.en, g.ja, g.ko)` / `t(...T4, {…})`）也算"给了"——
        // 这里只要求**至少 4 个实参**，并且前 4 个里不含"半个字面量"这种写法错误。
        checked += 1;
        if (kinds.length < 4) bad.push(`${f}: ${m[0]}${kinds.length} 个实参 @${raw.slice(0, m.index).split('\n').length}`);
      }
    }
    ok(checked >= 250, `★ 扫到了 ${checked} 个 i18n 调用点（空扫会假过）`);
    eq(bad.join(' | '), '', '★★★ 每个 t()/setStatusPair()/refusedNote() 都有 ≥4 个实参（四种语言）');
  }

  // ── ④ 静态外壳：`[data-en]` 覆盖 + 不许空 / 不许抄中文 ──
  {
    const withEn = [...idxMarkup.matchAll(/<([a-zA-Z][\w-]*)\b[^>]*\sdata-en="([^"]*)"[^>]*>([\s\S]*?)<\/\1>/g)];
    ok(withEn.length >= 25, `★ 静态外壳里带 data-en 的元素 ≥ 25（实到 ${withEn.length}）`);
    eq(withEn.filter((m) => !m[2].trim()).length, 0, '★ 没有空的 data-en');
    // 中文原文里含中日韩字符的元素，其 data-en **不许**也是中文（防"复制粘贴忘翻译"）
    const cjk = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/;
    const copyPaste = withEn.filter((m) => cjk.test(m[3]) && cjk.test(m[2]));
    eq(copyPaste.map((m) => m[2]).join(' | '), '', '★★ 没有"data-en 直接抄了中文"的元素');
    // 还没被 JS 覆盖的静态文字也必须覆盖到（几个关键的）
    for (const key of ['Memory card', 'Game', 'Crop', 'Parameters', 'Write to selected slot', 'Delete slot', 'PCSX2 check']) {
      ok(idxMarkup.includes(`data-en="${key}"`), `★ 静态外壳覆盖到了「${key}」`);
    }
    // ★★ 0.47：每个带 data-en 的元素都必须同时带 data-ja / data-ko、都不许空、
    //   而且**不许跟中文原文一模一样**（防"复制粘贴忘翻译"）；日文里必须出现假名或汉字之外的痕迹。
    {
      const els = [...idxMarkup.matchAll(/<([a-zA-Z][\w-]*)\b([^>]*\sdata-en="([^"]*)"[^>]*)>([\s\S]*?)<\/\1>/g)];
      const missJa: string[] = [];
      const missKo: string[] = [];
      const emptyJa: string[] = [];
      const emptyKo: string[] = [];
      const sameAsZh: string[] = [];
      for (const [, , attrs, en, zhText] of els) {
        const ja = /\bdata-ja="([^"]*)"/.exec(attrs);
        const ko = /\bdata-ko="([^"]*)"/.exec(attrs);
        if (!ja) missJa.push(en);
        else if (!ja[1].trim()) emptyJa.push(en);
        else if (ja[1] === zhText.trim() && cjk.test(zhText)) sameAsZh.push(`ja=${en}`);
        if (!ko) missKo.push(en);
        else if (!ko[1].trim()) emptyKo.push(en);
        else if (ko[1] === zhText.trim() && cjk.test(zhText)) sameAsZh.push(`ko=${en}`);
      }
      eq(missJa.join(' | '), '', `★★ 每个 data-en 元素都带 data-ja（缺 ${missJa.length} 个）`);
      eq(missKo.join(' | '), '', `★★ 每个 data-en 元素都带 data-ko（缺 ${missKo.length} 个）`);
      eq([...emptyJa, ...emptyKo].join(' | '), '', '★ data-ja / data-ko 都不许空');
      eq(sameAsZh.join(' | '), '', '★★ data-ja / data-ko 不许直接抄中文原文');
      // 日文文本必须含假名（纯汉字无法与中文区分）；韩文必须含谚文
      const jaVals = els.map((m) => /\bdata-ja="([^"]*)"/.exec(m[2])?.[1] ?? '');
      const koVals = els.map((m) => /\bdata-ko="([^"]*)"/.exec(m[2])?.[1] ?? '');
      ok(jaVals.some((v) => /[\u3040-\u30ff]/.test(v)), '★ data-ja 里确实有假名（不是把中文抄过去）');
      ok(koVals.every((v) => !cjk.test(v) || /[\uac00-\ud7af]/.test(v)), '★★ data-ko 里没有"纯汉字"的条目（要么是韩文，要么是专名）');
    }
  }
  {
    // ★ 0.47：三种属性对都要有 ja/ko 版本
    const attrPairs = ['title', 'placeholder', 'aria-label'];
    for (const a of attrPairs) {
      for (const l of ['en', 'ja', 'ko']) {
        const ms = [...idxMarkup.matchAll(new RegExp(`data-${l}-${a}="([^"]*)"`, 'g'))];
        if (l === 'en' && ms.length === 0) continue; // 某个属性对可能全站没用到
        ok(ms.length >= 1, `★ 用到了 data-${l}-${a}（对应属性 ${a}）`);
        eq(ms.filter((m) => !m[1].trim()).length, 0, `★ 没有空的 data-${l}-${a}`);
      }
    }
  }

  // ── ⑤ 语言下拉的位置与样式（用户："在最上面一栏的右侧"）──
  ok(/id="lang-select"/.test(idxMarkup), '★★ 顶栏有 #lang-select');
  ok(idxMarkup.indexOf('id="lang-select"') > idxMarkup.indexOf('id="game-select"'), '★ 它在作品下拉**之后**（= 顶栏右侧）');
  ok(!/<\/header>[\s\S]*id="lang-select"/.test(idxMarkup), '★ 它在 <header> 内部（不是掉到下面去了）');
  ok(/\.lang-pick\s*\{[^}]*margin-left:\s*auto/.test(css), '★★ `.lang-pick { margin-left: auto }` —— 把它顶到最右（窄屏靠 topbar 的 wrap 折行）');
  ok(/fillLangSelect/.test(maskSource(mainSrc)), '★ main.ts 里有 fillLangSelect()（选项由 JS 填，语言名不翻译）');
  ok(/setLang\(detectLang\(\), \{ persist: false \}\)/.test(maskSource(mainSrc)), '★★ 启动时按 detectLang() 定语言，且**不写** localStorage（自动判定不算"用户选择"）');
  ok(/onLangChange\(relayoutForLang\)/.test(maskSource(mainSrc)), '★★ 注册了 relayoutForLang（切语言要把 JS 生成的那部分文字重画）');
  // ⚠ 这条要拿**原文**比：`maskSource()` 会把字符串字面量抹掉（`setLang(v ===    ?     :    )`）
  ok(
    /setLang\(isLang\(v\) \? v : 'zh'\)/.test(mainSrc),
    '★★ 下拉的 change 用 `isLang(v)` 收口（★ 0.47：原来写死 `v === \'en\' ? \'en\' : \'zh\'` ⇒ 选日本語/한국어 会被打成中文）',
  );

  // ── ⑤b ★ 0.36：语言标签**常显多语** + 纯白（0.47 起是四语）──
  //   ⚠ 判据的核心是"**四种语言下都是同一句**" ⇒ 只能靠"它不参与翻译"来保证：
  //     静态文字参与翻译的唯一入口就是 `data-*`，所以这里钉住"它一个都没有"，
  //     再钉住"没有别的地方（JS / CSS content）会重写它"。
  //   ⚠ 高亮**只许用"字本身"的属性**（颜色 / 字重 / 字距）⇒ 这里反过来钉"text-shadow / box-shadow / filter / 动画一条都不许有"。
  {
    const m = /<span\b([^>]*\bid="lang-label"[^>]*)>([^<]*)<\/span>/.exec(idxMarkup);
    ok(m !== null, '★ index.html 里有 #lang-label（语言标签本体）');
    eq(m?.[2], '语言/Language/言語/언어', '★★ 语言标签写死四语「语言/Language/言語/언어」（不分语言，永远是这一句）');
    ok(!/\bdata-(en|ja|ko)\b/.test(m?.[1] ?? ''), '★★ 这个标签**不带** data-en/ja/ko（带了就会被换成单语，正是要避免的）');
    ok(!/lang-label/.test(mainSrc), '★ main.ts 不碰它（切语言不会重写这段文字）');
    // 顶栏其它标签仍然是"中文原文 + data-*"那套（只有这一个是有意的例外）
    ok(/<span class="lbl" data-en="Memory card"/.test(idxMarkup) && /<span class="lbl" data-en="Game"/.test(idxMarkup),
      '★ 同一行的其它 .lbl 仍然老老实实带 data-en（例外只有语言标签一个）');
    ok(dist.includes('语言/Language/言語/언어'), '★ 产物里就是这句写死的四语标签（四种语言共用一份文字）');

    const rule = /\.lang-pick\s+\.lbl\s*\{([^}]*)\}/.exec(css);
    ok(rule !== null, '★★ `.lang-pick .lbl` 有独立规则（纯白高亮）');
    const body = rule?.[1] ?? '';
    ok(/color:\s*#fff\s*;/.test(body), '★★ 语言标签 = 纯白 #fff（顶栏其它 .lbl 是 --dim 灰）');
    ok(/font-weight:\s*600\s*;/.test(body), '★ 字重 600 —— 高亮只靠"字本身"的属性');
    eq(
      (body.match(/text-shadow|box-shadow|filter|animation|transition/g) ?? []).length,
      0,
      '★★ text-shadow / box-shadow / filter / 动画一条都没有（高亮只用"字本身"的属性）',
    );
    eq(/(font-size|padding|margin)\s*:/.test(body), false, '★ 不碰 font-size / padding / margin（折行只由文字长度决定）');
  }

  // ── ⑥ applyStaticI18n 的快照/回滚：用假 DOM 跑真函数（★ 0.47 起是四语）──
  {
    const mk = (zh: string, ja: string | null, ko: string | null, en: string | null) => {
      const attrs = new Map<string, string>();
      if (en !== null) attrs.set('data-en', en);
      if (ja !== null) attrs.set('data-ja', ja);
      if (ko !== null) attrs.set('data-ko', ko);
      return {
        textContent: zh,
        getAttribute: (k: string) => attrs.get(k) ?? null,
        setAttribute: (k: string, v: string) => void attrs.set(k, v),
      };
    };
    const a = mk('取景', 'トリミング', '자르기', 'Crop');
    const b = mk('记忆卡', 'メモリーカード', '메모리 카드', 'Memory card');
    const root = { querySelectorAll: (sel: string) => (sel === '[data-en],[data-ja],[data-ko]' ? [a, b] : []) };
    setLang('en', { persist: false });
    applyStaticI18n(root as unknown as ParentNode);
    eq(`${a.textContent}/${b.textContent}`, 'Crop/Memory card', '★★ data-en 生效（英文写进去）');
    setLang('ja', { persist: false });
    applyStaticI18n(root as unknown as ParentNode);
    eq(`${a.textContent}/${b.textContent}`, 'トリミング/メモリーカード', '★★ data-ja 生效（日文写进去）');
    setLang('ko', { persist: false });
    applyStaticI18n(root as unknown as ParentNode);
    eq(`${a.textContent}/${b.textContent}`, '자르기/메모리 카드', '★★ data-ko 生效（韩文写进去）');
    setLang('zh', { persist: false });
    applyStaticI18n(root as unknown as ParentNode);
    eq(`${a.textContent}/${b.textContent}`, '取景/记忆卡', '★★ 切回中文能**还原原文**（靠第一次调用时的快照）');
    // 缺 data-ja 的元素在日文态下回落到中文原文（不是 undefined、也不是英文）
    const c = mk('只有中文和英文', null, null, 'English only');
    const root2 = { querySelectorAll: (sel: string) => (sel === '[data-en],[data-ja],[data-ko]' ? [c] : []) };
    setLang('ja', { persist: false });
    applyStaticI18n(root2 as unknown as ParentNode);
    eq(c.textContent, '只有中文和英文', '★ 缺 data-ja 时回落中文原文（不显示 undefined）');
    setLang('en', { persist: false });
    applyStaticI18n(root as unknown as ParentNode);
    eq(`${a.textContent}/${b.textContent}`, 'Crop/Memory card', '★ 来回切多次结果一致（快照不会被覆盖）');
    setLang('zh', { persist: false });
  }

  // ── ⑦ 产物里两种语言都在（不然英文版是"看起来支持"）──
  eq(currentLang(), 'zh', '测试结束时语言复原成中文（默认）');
  for (const s of ['Write to selected slot', 'Memory card', 'PCSX2 check', 'Got it']) {
    ok(dist.includes(s), `★ 产物里有英文「${s}」`);
  }
  for (const s of ['写入选中槽', 'PCSX2 自检', '知道了']) {
    ok(dist.includes(s), `★ 产物里中文原文也还在（「${s}」）—— 中文是 DOM 原文，没有被词表取代`);
  }
  // ★ 0.47：日/韩语两套也必须进产物（四种语言都在同一个文件里，file:// 不能按需取语言文件）
  for (const s of ['選択したスロットに書き込み', 'メモリーカード', 'PCSX2 チェック']) {
    ok(dist.includes(s), `★ 产物里有日文「${s}」`);
  }
  for (const s of ['선택한 슬롯에 쓰기', '메모리 카드', 'PCSX2 점검']) {
    ok(dist.includes(s), `★ 产物里有韩文「${s}」`);
  }
  ok(/data-en="Crop"/.test(dist), '★ 产物里带着 data-en 属性（切语言不需要重新打包）');
  ok(/data-ja="トリミング"/.test(dist) && /data-ko="자르기"/.test(dist), '★★ 产物里带着 data-ja / data-ko 属性');
  ok(/id="lang-select"/.test(dist), '★ 产物里有语言下拉');
  ok(/i18n|LANG_STORAGE_KEY/.test(i18nSrc) && /ac-emblem-tool:lang/.test(dist), '★ 键名进了产物（切完能在 localStorage 里查到）');
  // ★ 0.47：日/韩语各自的字体栈（否则日文汉字会被画成中文字形）
  ok(/html:lang\(ja\)\s+body\s*\{[^}]*Yu Gothic/.test(css), '★★ CSS 有 `html:lang(ja) body` 的日文字体栈（Yu Gothic / Meiryo）');
  ok(/html:lang\(ko\)\s+body\s*\{[^}]*Malgun Gothic/.test(css), '★★ CSS 有 `html:lang(ko) body` 的韩文字体栈（Malgun Gothic）');

  // ── ⑧ ★★★ 漏翻审计：本任务的**主判据**，也是长期闸门 ──
  //   规则：`src/ui/**` 里凡是含中日韩字符的**字符串字面量**，都必须落在某个 `t(...)` 的参数里。
  //   扫描器在 `web/tools/i18n-audit.mjs`（懂注释 / 三种引号 / 模板插值 / 括号配对；白名单带理由）。
  //   ⚠ 有它才敢说"英文界面里不会突然冒出一句中文"—— 300+ 处靠眼看是查不干净的。
  {
    const { total, hits, skipped } = auditTree();
    eq(
      hits.map((h) => `${h.file}:${h.bad.length}`).join(' | '),
      '',
      '★★★ src/ui/** 里没有"漏翻"的中文字面量（每一句都必须包在 t() 里）',
    );
    eq(total, 0, '★★★ 漏翻计数 = 0');
    ok(skipped.length >= 3, `★ 白名单里那几处"数据字段 / 语言名"仍被显式放过（实到 ${skipped.length} 个文件）`);
  }
}

// ==========================================================================
// (q) ★ 0.29：删掉图片工具条那句格式说明
// ==========================================================================

section('(q) ★ 0.29：删掉图片区那句"支持拖入 / 点击选择 / Ctrl+V 粘贴（…）"');

{
  const pipe = read('src/ui/pipeline.ts');
  const main = read('src/ui/main.ts');
  const idx = read('index.html');
  const dist = existsSync(DIST) ? readFileSync(DIST, 'utf8') : '';
  const pipeCode = maskSource(pipe);

  // ── ① 那句说明删干净（产物里也不许有；注释里也**故意没有**逐字抄它，同 0.27 的做法）──
  ok(!dist.includes('支持拖入'), '★★ 产物里不再有那句"支持拖入 / 点击选择 / Ctrl+V 粘贴（…）"');
  ok(!dist.includes('Drop / click to choose'), '★★ 英文那句也一起删了（不是只删中文）');
  ok(
    /function renderOriginalBadge[\s\S]{0,900}?if \(!src\) return;/.test(pipeCode),
    '★ 没图时**直接 return**（不再写那句说明）',
  );
  ok(/\$\{label\} · \$\{src\.width\}×\$\{src\.height\}/.test(pipe), '★★ "文件名 · 尺寸"那段**没**被一起删掉（它还要用）');
  ok(
    /const label = src\.clipboard \? t\(/.test(pipe),
    '★★ 0.40：剪贴板前缀在**渲染时**才 t()（不许把翻译好的名字存进 state）',
  );

  // ── ② 三条入口一个都没少（删的是说明，不是功能）──
  ok(
    /installDropZones/.test(maskSource(main)) && /installPaste/.test(maskSource(main)),
    '★★ 拖入 / Ctrl+V 两条路仍在（`installDropZones` / `installPaste`）',
  );
  ok(/id="btn-image-open"/.test(idx), '★ 工具条上的〔选择 / 粘贴图片〕按钮仍在');
  ok(/id="image-drop"/.test(idx), '★ 拖放目标 #image-drop 仍在');
  ok(/id="original-badge"/.test(idx), '★ #original-badge 这个挂载点保留（它还要显示"文件名 · 尺寸"）');
}

// ==========================================================================
// (r) ★ 0.30：〔选择记忆卡〕去掉"（可覆盖保存）"+ 选择框开在文档 / memcards
// ==========================================================================

section('(r) ★ 0.30：选卡按钮去掉"（可覆盖保存）"；选择框尽量开在 Documents\\PCSX2\\memcards');

{
  const idx = read('index.html');
  const idxMarkup = idx.replace(/<!--[\s\S]*?-->/g, '');
  const main = read('src/ui/main.ts');
  const dist = existsSync(DIST) ? readFileSync(DIST, 'utf8') : '';
  /** 抓一个函数的函数体（收尾大括号必须**顶格**；⚠ `\r?\n`：main.ts 在 Windows 上是 CRLF）。 */
  const bodyOf = (name: string): string => (main.match(new RegExp(`${name}[\\s\\S]*?\\r?\\n\\}\\r?\\n`)) ?? [''])[0];

  // ── ① 用户："把'（可覆盖保存）'这几个字删了"（中英都要改）──
  ok(/>\s*选择记忆卡\s*<\/button>/.test(idxMarkup), '★★ 按钮文字就是〔选择记忆卡〕（没有后缀）');
  ok(/data-en="Choose memory card"/.test(idxMarkup), '★★ 英文那半也改了（不是只删中文）');
  ok(!idx.includes('可覆盖保存'), '★★ index.html 里没有"可覆盖保存"了');
  ok(!dist.includes('可覆盖保存'), '★★ 产物里也一个都没有（按钮 + 顶栏卡信息两处都清了）');
  ok(!dist.includes('can overwrite in place'), '★★ 顶栏 🔓 那句的英文后缀也一起删了');
  // 🔓 那条只剩"🔓 文件名"（含义写进文档）；🔒 那条自带说明，照旧
  ok(/🔓 \$\{lc\.fileName\}\`, \`🔓 \$\{lc\.fileName\}\`/.test(main), '★ 🔓 那半只剩文件名（可覆盖保存 = 🔓 的默认含义）');
  ok(/🔒 \$\{lc\.fileName\}（只读 · 保存=下载）/.test(main), '★ 🔒 那半没被误删（"只读 · 保存=下载"要留）');

  // ── ② 选择框开在哪：只许用"已知文件夹"或**目录句柄**，不许写路径 ──
  const pick = bodyOf('async function openCardViaPicker');
  const refresh = bodyOf('async function refreshMemcardsHandle');
  ok(pick.length > 500 && refresh.length > 200, `抓到两个函数体（${pick.length} / ${refresh.length} 字符）`);
  ok(/startIn,/.test(pick), '★★ 选择框收到 startIn（不再是"让浏览器自己决定"）');
  ok(!/startIn:\s*['"`]/.test(pick) && !/startIn:\s*['"`]/.test(refresh), '★★ startIn 只收变量值 —— **没有**硬编码的路径/枚举字面量');
  ok(/recallPcsx2Handle\(\)/.test(refresh), '★ 目录句柄来自"记住的 PCSX2 目录"（复用自检那一次授权）');
  ok(/queryPermission\(\s*\{\s*mode:\s*'read'\s*\}\s*\)/.test(refresh), '★★ 先用只读权限问一次（没授权就不敢拿它当 startIn）');
  ok(/getDirectoryHandle\('memcards'\)/.test(refresh), "★★ 从 PCSX2 目录里取出 `memcards` 子目录当 startIn（这一步才叫\"自动到 memcards\"）");
  ok(/memcardsHandle = null/.test(refresh), '★ 拿不到（没授权/没这个子目录/句柄失效）就置 null ⇒ 退到"文档"那一档');
  ok(
    /const tries: Array<FileSystemDirectoryHandle \| 'documents'> = memcardsHandle \? \[memcardsHandle, 'documents'\] : \['documents'\]/.test(pick),
    '★★ 候选表：缓存住的目录句柄 → 文档',
  );
  // ★★ 手势纪律：`showOpenFilePicker` 要 transient activation（点击起 5 秒）⇒ 中间不许夹 await
  //    （IDB 被别的标签页卡住时，那几百毫秒会变成"手势过期" ⇒ 弹框被拒、静默掉进只读兜底）
  {
    // ⚠ 查的是 `maskSource()` 之后的源码（注释里出现"await"这个词不算犯规），
    //   范围 = 「算候选表」到「进循环调选择框」之间 —— 那一段必须是同步的。
    const seg = maskSource(pick.slice(pick.indexOf('const options ='), pick.indexOf('for (const startIn of tries)')));
    ok(seg.length > 100 && !/await/.test(seg), `★★ 点击到弹框之间**没有 await**（掩码后查了 ${seg.length} 字符）`);
    ok(/if \(!memcardsHandle\) void refreshMemcardsHandle\(\);[\s\S]{0,200}?await guard\(/.test(pick), '★ 没缓存时顺手刷一次（下一次点就能开在 memcards），但**不等**它');
  }
  ok(/void refreshMemcardsHandle\(\);/.test(main), '★ 启动时备好句柄（不弹权限框：先 queryPermission）');
  ok(/refreshMemcardsHandle\(dir\)/.test(bodyOf('async function pickPcsx2Dir')), '★ 选完 PCSX2 目录**当场**把 memcards 句柄备好（用户最常用的顺序：先自检、再选卡）');
  eq((pick.match(/isAbort\(/g) ?? []).length, 1, '★★ 整条候选阶梯只有**一处**取消判断 ⇒ 用户按取消不会再弹第二次');
  ok(/lastError = e;/.test(pick) && /打不开文件选择器，退化到只读方式/.test(pick), '★ 两个候选都炸 ⇒ 退回只读兜底（老行为不变）');

  // ── ③ 双语（这句提示是鼠标停在按钮上才看到的，最容易漏翻）──
  for (const s of ['选择框开在「文档」', 'The picker opens in Documents']) {
    ok(dist.includes(s), `★ 产物里有「${s}」`);
  }
  ok(/data-en-title="The picker opens in Documents/.test(idx), '★ title / data-en-title 成对给（悬停提示也有英文）');

  // ── ④ 作废的标识符不许再出现在产物里（这串名字是已经撤掉的方案，别再引进来）──
  //   ⚠ 判据只挑**方案独有**的词：`记住上次` 这种通用说法在 PCSX2 目录那段注释里本来就有（"记住上次的位置"）。
  for (const bad of ['lastCard', 'LAST_CARD_KEY', 'decideAutoOpen', 'continueLastCard', '继续上次', '记住上次那张卡', '自动打开']) {
    ok(!main.includes(bad) && !idx.includes(bad) && !dist.includes(bad), `★★ 产物里没有作废标识符 \`${bad}\``);
  }
  ok(!/记住句柄/.test(read('probe.html')), '★ `probe.html` 里没有那段"句柄跨刷新"的体检（也没留下半截 DOM/JS）');
  ok(!existsSync(join(WEB, 'src', 'ui', 'logic', 'lastCard.ts')), '★ `logic/lastCard.ts` 已删除');
  ok(
    /recallPcsx2Handle|rememberPcsx2Handle/.test(main) && /indexedDB\.open/.test(main),
    '★ 句柄库回到 0.29 的形态（只有 PCSX2 目录那两个函数，没留下通用三件套）',
  );
}

// ==========================================================================
// (s) ★ 0.37：8 格 = 上面槽号、下面缩略图（卡片上除了槽号没有文字）
// ==========================================================================

section('(s) ★ 0.37：8 格 = 槽号在上、图在下（卡片上没有别的文字）');

{
  const slots = read('src/ui/slotsView.ts');
  const css = read('styles.css');
  const dist = existsSync(DIST) ? readFileSync(DIST, 'utf8') : '';

  // ── ① DOM：卡片两个孩子 = 「槽 N」 + 缩略图（顺序就是版式）──
  //   ⚠ 这一节用**原文**做 indexOf：`maskSource()` 会把 `class: 'slot-no'` 这种字符串抹掉。
  ok(/function thumbNode\(thumb: SlotThumb \| null\)/.test(slots), '★ thumbNode() 不收尺寸参数（尺寸交给 CSS）');
  ok(!/cv\.style\.width|cv\.style\.height/.test(slots), '★★ 缩略图**不写 inline 宽高**（inline 会盖掉 CSS ⇒ 图片大不了）');
  ok(/el\('canvas', \{ class: 'thumb-cv', width: 128, height: 128 \}\)/.test(slots), '★ 画布后备像素仍是 128×128（放大交给 pixelated + CSS）');
  {
    const cardIdx = slots.indexOf('class: cls');
    const noIdx = slots.indexOf("class: 'slot-no'", cardIdx);
    const thumbIdx = slots.indexOf('thumbNode(thumb)', cardIdx);
    ok(cardIdx > 0 && noIdx > cardIdx, '★★ 卡片第一个孩子是「槽 N」（版式要求：上面是槽号）');
    ok(thumbIdx > noIdx, '★★ 缩略图在槽号**之后**（下面才是图）');
    ok(!/slot-text|slot-name|slot-meta|slot-check|checkLine/.test(slots), '★★ 卡片上**没有**第三个孩子（文字列 / 目录名 / 大小 / 校验状态全都删了）');
  }
  // 被删掉的那几个"卡片文案"函数/字段不许回来
  ok(!/emptySlotHint|plannedDirName/.test(slots), '★★ 空槽提示函数已删除（空槽只有一个「＋」）');
  ok(!/slotSummaryText/.test(slots), '★★ 8 槽摘要那行已从界面删除');
  ok(/el\('div', \{ class: 'thumb-empty', text: t\('＋', '\+', '＋', '＋'\) \}\)/.test(slots), '★ 空槽 = 一个大「＋」（没有文字）');

  // ── ② CSS：卡片竖排（槽号 + 图占满整格）──
  const slotBlock = /\.slot\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
  ok(/display:\s*flex/.test(slotBlock) && /flex-direction:\s*column/.test(slotBlock), '★★ .slot 是竖排 flex（槽号在上、图在下）');
  ok(!/grid-template-columns/.test(slotBlock), '★ .slot 不再是两列 grid（0.31 的"左图右文"已废）');
  for (const sel of ['thumb-cv', 'thumb-empty']) {
    const b = new RegExp(`\\.${sel}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? '';
    ok(/width:\s*100%/.test(b), `★★ .${sel} 占满整格宽度（width: 100%）`);
    ok(/aspect-ratio:\s*1\s*\/\s*1/.test(b), `★★ .${sel} 正方形靠 aspect-ratio`);
    ok(!/max-width/.test(b), `★★ .${sel} **去掉了 max-width 封顶**（卡片多宽图就多大）`);
  }
  ok(!/\.slot-text\s*\{/.test(css), '★★ `.slot-text` 那条规则已删除');
  for (const dead of ['.slot-name', '.slot-meta', '.slot-check', '.slot-summary']) {
    ok(!css.includes(dead + ' {'), `★ ${dead} 那条规则也删了（不留死样式）`);
  }
  ok(/\.slot-note\s*\{/.test(css), '★ 取而代之的是 `.slot-note`（只放那条条件警告）');
  ok(
    /grid-template-columns:\s*repeat\(4,\s*minmax\(200px,\s*1fr\)\)/.test(css),
    '★ .slot-grid 仍是 4 列（列宽决定图片多大：1500px 视口下每格 345px ⇒ 图 327px）',
  );
  ok(/@media\s*\(max-width:\s*1100px\)\s*\{\s*\.slot-grid\s*\{/.test(css), '★ .slot-grid 的 1100px 断点仍在（窄屏 2 列）');

  // ── ③ 产物里也带着这套（CSS 是**原样内联**进去的）──
  ok(dist.includes('.slot-note {'), '★ 产物里带着 .slot-note 的样式');
  ok(dist.includes('.thumb-cv {') && !dist.includes('.slot-text {'), '★ 产物里 .thumb-cv 在、`.slot-text` 不在');
  ok(dist.includes('aspect-ratio: 1 / 1;'), '★ 产物里带着 aspect-ratio（图片自适应靠它）');
  ok(dist.includes('repeat(4, minmax(200px, 1fr))'), '★ 产物里的 8 格最小列宽也是 200px');
}

// ==========================================================================
// (t) ★ 0.32：删掉"槽 N → …"与"选中的槽是…"这两行（信息在槽卡片 / 落盘确认框里）
// ==========================================================================

section('(t) ★ 0.32：写卡提示与状态行不再复述槽内容（那两行整行删掉）');

{
  const mainSrc = read('src/ui/main.ts');
  const idx = read('index.html');
  const css = read('styles.css');
  const dist = existsSync(DIST) ? readFileSync(DIST, 'utf8') : '';

  // ── ① 产物里真的一个字都不剩 ──
  //   ⚠ 文案活在**字符串字面量**里 ⇒ 只能查产物原文（`maskSource()` 会把它们一并抹掉，
  //     拿掩码版查等于"永远通过"）。所以本文件的注释里也**不许**写出这些整串。
  for (const gone of [
    '已选槽', // 状态行：选中了哪个槽（+ 文件名 / 长度 / 首簇）
    '字节，首簇', // 同上，中文那半
    'bytes, first cluster', // 同上，英文那半（槽卡片写的是 `B · first cluster`，不冲突）
    '(a new file is created when writing)', // 空槽那句的英文
    '（覆盖）', // 写卡提示里的"盖掉已有文件"标注
    '（新建文件）', // 同上的另一半
    ' (overwrite)', // 上面两条的英文
    ' (new file)', // 同上
  ]) {
    ok(!dist.includes(gone), `★★ 产物里没有「${gone}」`);
  }

  // ── ② 那行的数据源（`plan.target`）也一起收掉 ──
  //   ⚠ `plan.target` 是**真代码标识符**（不是字符串）⇒ 拿掩码版查才有意义。
  ok(!/plan\.target\b/.test(maskSource(mainSrc)), '★★ main.ts 不再读 `plan.target`（那行没了，数据源也不留）');

  // ── ③ `selectSlot()` 彻底不碰状态行；选中这件事本身没变 ──
  const bodyOf = (src: string, name: string): string => {
    const i = src.indexOf(`function ${name}(`);
    if (i < 0) return '';
    const m = /\r?\n\}\r?\n/.exec(src.slice(i));
    return m ? src.slice(i, i + m.index) : src.slice(i);
  };
  const selSrc = bodyOf(mainSrc, 'selectSlot');
  ok(selSrc.length > 0, '找得到 `selectSlot()` 的函数体（下面几条断言才有意义）');
  ok(
    !/setStatus|renderStatus/.test(maskSource(selSrc)),
    '★★ `selectSlot()` 既不 `setStatus()` 也不 `renderStatus()`（状态行不再被槽选择改写）',
  );
  // ⚠ 0.45：这条原来还要求 `renderSlots(` 出现在 `selSrc` 里 —— 那是**假通过**：
  //   `bodyOf()` 取的是**原文**，而这个字面只出现在 `main.ts:428` 的注释里（"这里原来整批
  //   `renderSlots()` … 现在只切高亮"）⇒ 断言"有"的那半靠注释通过，而下面 (y) 分节里
  //   打在**掩码版**上的断言说"没有"。同一条事实两个方向，所以这里只留真代码里的两件事。
  ok(
    /state\.selectedSlot = i/.test(maskSource(selSrc)) &&
      /markSelectedSlot\(i\)/.test(maskSource(selSrc)) &&
      /updateWriteHints\(\)/.test(maskSource(selSrc)),
    '★ 选中槽这件事一个没少：改 state + 只切高亮（`markSelectedSlot`）+ 重算写卡提示',
  );

  // ── ④ 但"为什么写不了 / 有什么要注意"必须一个字不少（删的是复述，不是提示）──
  const hintSrc = maskSource(bodyOf(mainSrc, 'updateWriteHints'));
  ok(/plan\.error/.test(hintSrc), '★★ 拒绝理由仍然显示（`plan.error` 那条不能跟着删）');
  ok(/plan\.warning/.test(hintSrc), '★ `plan.warning` 提醒仍然显示');
  ok(/noDirForGameText/.test(hintSrc), '★ "这个作品在卡上还没有目录"那条警告仍在');
  ok(/sameGameBlocks/.test(hintSrc), '★ "作品常量可以从卡上同作品的存档取"那条提示仍在');
  ok(!/slotIndex \+ 1/.test(hintSrc), '★★ 那行「槽 N → 目录\\文件」的模板（`slotIndex + 1`）已经没了');

  // ── ⑤ 两个挂载点都还在：删的是内容，不是那块地方 ──
  ok(/id="write-hint"/.test(idx), '★ `#write-hint` 挂载点还在（写不了的原因要有地方说）');
  ok(/id="status"/.test(idx), '★ `#status` 状态行还在（开卡 / 切作品 / 写卡结果仍然报）');
  ok(
    /\.write-hint\s*\{/.test(css) && /\.write-hint \.bad/.test(css) && /\.write-hint \.warn/.test(css),
    '★ `.write-hint` 的样式没跟着删（`.bad` / `.warn` 两种仍然在用）',
  );
  // `updateWriteHints()` 的重算点一个都不能少（开卡 / 切作品 / 选槽 / 关卡 都要重算）
  eq((mainSrc.match(/updateWriteHints\(\)/g) ?? []).length, 5, '★ `updateWriteHints()` 仍是 5 处（4 个调用点 + 1 个定义）');
}

// ==========================================================================
// (u) ★ 0.34：面积平均的支撑区口径（+ 缩放核就是两档，别再加第三档）
// ==========================================================================

section('(u) ★ 0.34：缩放核就两档；面积平均的支撑区必须覆盖"被部分覆盖"的像素');

{
  const imgSrc = read('src/core/image.ts');
  const idxSrc = read('index.html');
  const dist = existsSync(DIST) ? readFileSync(DIST, 'utf8') : '';

  // ── ① 核心层：类型就两个成员；`selectScaleKernel()` 只在这两个里选 ──
  ok(
    /export type ScaleKernel = 'nearest' \| 'smooth'/.test(imgSrc),
    '★★ `ScaleKernel` 就是 nearest / smooth 两个成员（没有第三个核）',
  );
  {
    const fn = imgSrc.slice(imgSrc.indexOf('export function selectScaleKernel('));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    ok(body.length > 0, '找得到 `selectScaleKernel()` 的函数体');
    eq((body.match(/return [^;]+;/g) ?? []).length, 3, '★ 三条规则、三个 return（顺序即优先级）');
    ok(
      !/mode/i.test(body.replace(/\/\/.*$/gm, '')),
      '★★ `selectScaleKernel()` 只在 nearest / smooth 里选（没有第三个核）',
    );
  }
  // 支撑区下限：必须是 floor（ceil 会丢掉被部分覆盖的像素 ⇒ 放大时整片补背景）
  ok(
    /const s0 = Math\.max\(0, Math\.floor\(c - half\)\)/.test(imgSrc),
    '★★ `supportRange()` 的下限是 `floor(a)`（这是面积平均在放大档下能出图的前提）',
  );
  ok(
    /const s1 = Math\.min\(n - 1, Math\.ceil\(c \+ half\) - 1\)/.test(imgSrc),
    '★ 上界是 `ceil(b) - 1`（排掉零面积擦边）',
  );
  eq((imgSrc.match(/supportRange\(/g) ?? []).length, 5, '★ 面积平均的四个采样点都走同一个 `supportRange()`（1 处定义 + 4 处调用）');

  // ── ② 界面：下拉就三项，且仍然由 `KERNEL_LABELS` 填（没有第二份列表）──
  ok(/id="kernel"/.test(idxSrc), '参数栏里 `#kernel` 挂载点还在');
  ok(/KERNEL_LABELS/.test(maskSource(read('src/ui/main.ts'))), '★ 下拉选项仍然由 `KERNEL_LABELS` 填（没有第二份列表）');

  // ── ③ 作废的标识符不许再出现在产物里（这串名字是撤掉的方案，别再引进来）──
  for (const bad of ['众数', 'modeFit', 'Mode vote', 'majority']) {
    ok(!imgSrc.includes(bad) && !dist.includes(bad), `★★ 源码与产物里都没有作废标识符 \`${bad}\``);
  }
}

// ==========================================================================
// (v) ★ 0.37：8 格上的文字与那句摘要全删；〔看目录项（调试）〕能开也能收
// ==========================================================================

section('(v) ★ 0.37：卡片文字 / 8 槽摘要整句删除；调试开关点第二下要收回去');

{
  const slotsSrc = read('src/ui/slotsView.ts');
  const mainSrc = read('src/ui/main.ts');
  const slotsLogic = read('src/ui/logic/slots.ts');
  const idx = read('index.html');
  const css = read('styles.css');
  const dist = existsSync(DIST) ? readFileSync(DIST, 'utf8') : '';

  // ── ① 用户圈掉的那几串文案：源码 / 产物里一个都不许再有 ──
  //   ⚠ 注释也会被打进产物 ⇒ 连注释里都不许留（这几串正是"要删掉的东西"）。
  const GONE = [
    '18 段校验 18/18 ✅', // 卡片上那行"校验状态"
    '空 · 可新建', // 空槽第一行
    '＋新建', // 空槽第二行
    '本作品目录', // 摘要句
    '卡上还有其它作品', // 摘要句
    '· 首簇', // 卡片第二行的格式
  ];
  for (const s of GONE) {
    ok(
      !slotsSrc.includes(s) && !mainSrc.includes(s) && !slotsLogic.includes(s) && !idx.includes(s) && !dist.includes(s),
      `★★ 产物与源码里都不再出现「${s}」`,
    );
  }
  // 摘要文案的产出函数整块没了（不是只"不显示"）
  ok(!/slotSummaryText|slotSummary\(|compressDirNames/.test(slotsLogic), '★★ 摘要文案函数已从 logic/slots.ts 删除（不是只藏起来）');
  ok(!/slotSummaryText/.test(mainSrc), '★★ 状态行也不再打印那句摘要（开卡 / 切作品 / 写卡完成都没有）');
  // 但"被隐藏了别的作品"这件事不许静默 —— 条件警告里仍然写着"切作品查看"
  ok(/切作品查看/.test(slotsSrc), '★★ 那条条件警告仍然告诉用户"切作品查看"（被隐藏的东西不许静默）');
  ok(
    /dirNames\.length === 0 && n > 0/.test(slotsSrc) &&
      /const n = model\?\.excludedDirNames\.length \?\? 0;/.test(slotsSrc),
    '★★ 警告只在"本作品没目录 且 卡上有别的作品的目录"时出现（别的都不显示）',
  );

  // ── ② 状态行：开卡成功不再说话，且把启动那句清掉 ──
  ok(/setStatus\(''\)/.test(mainSrc), "★ 开卡成功时把启动那句提示清掉（否则卡都开了它还挂着）");
  ok(!/已切到「\$\{entry\?\.label ?? ''\}」：/.test(mainSrc), '★ 切作品也只报"切到了哪个作品"，不再挂摘要');

  // ── ③ 〔看目录项（调试）〕开关：第二下必须收回去 ──
  //   判据（无头浏览器实测）：点击前 `#write-log.hidden=true` ⇒ 第 1 下 false（9 行）⇒ 第 2 下 true（0 行）
  //   ⇒ 第 3 下又 false。这里钉住实现里那两条分支与"别的日志会清掉这份记录"。
  ok(/if \(dirDebugLines\) \{/.test(mainSrc), '★★ 点击时先判断"框里是不是目录项"（是 ⇒ 收起）');
  ok(/dirDebugLines = null;\s*renderLog\(\[\]\);/.test(mainSrc), '★★ 收起就是 `renderLog([])`（`renderLog()` 会把整个框 hidden）');
  ok(/renderLog\(dirDebugLines\)/.test(mainSrc), '★ 展开时才把目录项写进日志');
  ok(
    /function showLog\(lines: readonly string\[\]\): void \{\s*dirDebugLines = null;/.test(mainSrc),
    '★★ 写入 / 删除的日志走 `showLog()` ⇒ 顺手清掉那份记录（否则"先写卡再点看目录项"会变成收起）',
  );
  eq(
    (mainSrc.match(/renderLog\(outcome\.lines\)|renderLog\(out\.lines\)/g) ?? []).length,
    0,
    '★★ 那两处旧的直接 `renderLog(结果)` 已经改成 `showLog(结果)`',
  );
  ok(/id="btn-debug"/.test(idx) && /data-en="Inspect directory \(debug\)"/.test(idx), '★ 按钮还在（中英都还在）');

  // ── ④ `#slot-note` 取代了 `#slot-summary` ──
  ok(/id="slot-note"/.test(idx) && !/id="slot-summary"/.test(idx), '★★ index.html 里摘要位换成了 `#slot-note`');
  ok(/<div id="slot-note" class="slot-note" hidden>/.test(idx), '★★ `#slot-note` 默认 hidden（没情况时不留空行）');
  ok(/getElementById\('slot-note'\)/.test(slotsSrc), '★ `renderSlots()` 会按条件显示它');
  ok(/\.slot-note\s*\{/.test(css) && !/\.slot-summary\s*\{/.test(css), '★ 样式也跟着改名了（`.slot-note` 在、`.slot-summary` 没了）');

  // ── ⑤ 卡片上"没有可写的东西"在源码层面也成立 ──
  ok(!/slot\.fileName|slot\.length|slot\.cluster|thumb\.checksumsOk18/.test(slotsSrc), '★★ 卡片不再读文件名 / 字节数 / 簇号 / 校验状态');
}

// ==========================================================================
// (w) ★ 0.38：取景动作行里的白框边长滑条 + 输入框
// ==========================================================================

section('(w) ★ 0.38：白框边长可以用滑条 / 输入框精确调（源像素，整数）');

{
  const idx = read('index.html');
  const css = read('styles.css');
  const crop = read('src/ui/cropView.ts');
  const geo = read('src/ui/logic/cropGeometry.ts');
  const main = read('src/ui/main.ts');
  const dist = existsSync(DIST) ? readFileSync(DIST, 'utf8') : '';

  // ── ① DOM：滑条 + 输入框，都在取景动作行里、且排在提示文字**前面**（= 用户圈的"红方块"那一段）──
  ok(/<input type="range" id="crop-size-range"/.test(idx), '★★ 有滑条 #crop-size-range');
  ok(/<input type="number" id="crop-size-num"/.test(idx), '★★ 有输入框 #crop-size-num');
  for (const id of ['crop-size-range', 'crop-size-num']) {
    const m = new RegExp(`<input[^>]*id="${id}"[^>]*>`).exec(idx)?.[0] ?? '';
    ok(/step="1"/.test(m), `★★ #${id} 的步长是 1 源像素（"精度不够高"要解决的就是这一条）`);
    ok(/min="/.test(m) && /max="/.test(m), `★ #${id} 带 min/max（进取景视图后由 cropView 按源图尺寸改写）`);
    ok(/data-en-aria-label="/.test(m), `★ #${id} 的无障碍名字也给了英文（data-en-aria-label）`);
  }
  {
    const actionsIdx = idx.indexOf('id="crop-actions"');
    const rangeIdx = idx.indexOf('id="crop-size-range"');
    const numIdx = idx.indexOf('id="crop-size-num"');
    const hintIdx = idx.indexOf('class="crop-hint"');
    const readIdx = idx.indexOf('id="crop-readout"');
    const okIdx = idx.indexOf('id="btn-crop-ok"');
    ok(actionsIdx > 0 && rangeIdx > actionsIdx && numIdx > rangeIdx, '★★ 两个控件都在 #crop-actions 行里、滑条在前');
    ok(hintIdx > numIdx && readIdx > hintIdx && okIdx > readIdx, '★★ 顺序 = 控件 → 提示 → 读数 → 按钮（控件占的就是原来提示的位置）');
  }
  ok(/data-en="Box size"[^>]*>白框边长</.test(idx), '★ 有"白框边长"这个标签（四语成对）');
  ok(/data-en="src px"[^>]*>源像素</.test(idx), '★ 单位"源像素"也写明了（四语成对）');
  ok(/class="crop-hint"/.test(idx), '★ 那句提示**没被挤掉**（只是挪到控件右边去了）');

  // ── ② CSS：定宽控件（别随窗口伸缩），滑条用主题强调色 ──
  {
    // ⚠ 这两条**必须**是 id 选择器：浏览器内置样式表里的 `input[type="range"] { width: 130px }`
    //   优先级（0,1,1）比类选择器（0,1,0）高 ⇒ 用类写宽度会被压成 130px（实测翻过车）。
    const r = /#crop-size-range\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    const n = /#crop-size-num\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    ok(r.length > 0 && n.length > 0, '★★ 样式用的是 `#crop-size-range` / `#crop-size-num`（id 选择器）');
    ok(/flex:\s*0 0 auto/.test(r) && /flex:\s*0 0 auto/.test(n), '★★ 两个控件都是 `flex: 0 0 auto`（定宽，不参与行内伸缩）');
    ok(/width:\s*clamp\(200px,\s*30vw,\s*420px\)/.test(r), '★★ 滑条够长（clamp(200px, 30vw, 420px)，用户："把滑条做长一点"）');
    ok(/accent-color:\s*var\(--accent\)/.test(r), '★ 滑条用主题强调色（不必手搓轨道样式）');
    ok(/width:\s*68px/.test(n) && /tabular-nums/.test(n), '★ 输入框固定 68px + 等宽数字（数字跳动不抖）');
    // ★ 用户："确定取景和取消右对齐" —— 靠挂在**第一个**按钮上的 `margin-left: auto`
    const okBtn = /#btn-crop-ok\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    ok(/margin-left:\s*auto/.test(okBtn), '★★ 〔确定取景〕带 `margin-left: auto`（它和〔取消〕一起被推到行尾）');
    ok(!/justify-content:\s*space-between/.test(/\.crop-actions\s*\{([^}]*)\}/.exec(css)?.[1] ?? ''),
      '★ 没给 `.crop-actions` 加 `justify-content: space-between`（那会把提示与读数拆开，不是"按钮贴右"）');
  }

  // ── ③ 源码：唯一入口 setCropWindowSize()，锚点与滚轮同一条规则 ──
  ok(/export function setCropWindowSize/.test(crop), '★★ cropView.ts 导出 setCropWindowSize()（滑条与输入框共用）');
  ok(/export function resizeWindowTo/.test(geo), '★★ 几何层有 resizeWindowTo()（一步设成目标边长）');
  ok(/resizeWindowTo\(/.test(crop), '★ cropView 用的是几何层那个纯函数（不在界面层另写一遍夹取）');
  ok(/clampNum\(size,\s*b\.min,\s*b\.max\)/.test(geo), '★★ 边长夹进 windowBoundsFor() 的区间（下限 = 128 不放大，上限 = 源图长边）');
  ok(/const cx = win\.x \+ win\.size \/ 2/.test(geo), '★★ 锚点是**白框中心**（与滚轮 zoomWindowAtCenter 同一条规则）');
  {
    const seg = crop.slice(crop.indexOf('export function setCropWindowSize'), crop.indexOf('function syncSizeControls'));
    ok(!/prepareEmblem|onChanged\?\.\(\)/.test(seg), '★★ 改白框大小**不跑管线**（和拖动/滚轮一样只动视觉）');
  }
  ok(/setCropWindowSize,/.test(main), '★ F12 的 EmblemToolCore.ui.cropView 上也挂了它（无头 E2E 与冒烟能用）');
  ok(/setCropWindowSize\(want\)/.test(read('build.mjs')), '★ build.mjs 的取景冒烟里也走一遍它（值 / 下限 / 上限 / 不跑管线）');

  // ── ④ 同步：滚轮改过之后滑条要跟上；输入框**聚焦期间不回写** ──
  ok(/function syncSizeControls/.test(crop), '★★ 有 syncSizeControls()（把两个控件同步成当前窗口边长）');
  ok(/syncSizeControls\(\);\n}/.test(crop), '★★ 它在 describeWindow() 末尾被调用（滚轮 / 拖动 / 进视图都会过这里）');
  ok(
    /document\.activeElement !== r\.sizeNum/.test(crop),
    '★★ 输入框正在被编辑时**不回写** —— 否则敲"1"（想输 180）会先被夹成 128 把字吃掉',
  );
  ok(
    /addEventListener\('input'/.test(crop) && /addEventListener\('change', tidy\)/.test(crop) && /addEventListener\('blur', tidy\)/.test(crop),
    '★★ 边打边生效（input）+ 敲完校正一次（change / blur）',
  );
  ok(/function sizeFromInput/.test(crop) && /Number\.isFinite\(v\) && v > 0/.test(crop),
    '★ 空串 / 半截数字 ⇒ 这一下什么都不做（不会把窗口设成 NaN）');
  ok(/el\.min !== String\(lo\)/.test(crop) && /el\.max !== String\(hi\)/.test(crop), '★ min/max 按当前源图改写，且值没变就不写');

  // ── ⑤ 产物里也在（HTML / CSS 原样内联，JS 也在）──
  ok(dist.includes('id="crop-size-range"') && dist.includes('id="crop-size-num"'), '★★ 产物里有这两个控件');
  ok(dist.includes('白框边长') && dist.includes('Box size'), '★ 产物里中英标签都在');
  ok(dist.includes('.crop-size-range {') === false, '★ 产物里不再有旧的类选择器写法（已改成 id）');
  ok(dist.includes('#crop-size-range {') && dist.includes('#crop-size-num {'), '★★ 产物里带着这两条 id 样式');
  ok(dist.includes('#btn-crop-ok {') && /#btn-crop-ok\s*\{[^}]*margin-left:\s*auto/.test(dist), '★ 产物里也有按钮右对齐那条');

  // ── ⑥ 它不是 v0.15 删掉的那三格（参数面板里的手输倍率 / X / Y）──
  {
    const markup = idx.replace(/<!--[\s\S]*?-->/g, '');
    for (const id of ['manual-scale', 'manual-x', 'manual-y']) {
      ok(!new RegExp(`id="${id}"`).test(markup), `★★ 仍然没有 #${id}（那三格与这条控件不是一回事）`);
    }
  }
}



// ==========================================================================
// (x) ★ 0.39：切语言时「作品」那一段的文字必须跟着换（用户截图抓到的"半中半英"）
// ==========================================================================

section('(x) ★ 0.39：切换语言 = 作品警告 / 报错红字跟着换（不许出现半中半英）');

{
  const main = read('src/ui/main.ts');
  const dist = existsSync(DIST) ? readFileSync(DIST, 'utf8') : '';

  // ── ① 同一个块里的文字必须由**同一个函数**产出（这样"重画名单"才漏不了）──
  eq((main.match(/renderGameNote\(/g) ?? []).length, 1, '★★ main.ts 里只有 1 处调 renderGameNote（在 renderGameBlock() 里面）');
  ok(/function renderGameBlock\(\): GameCtxResult/.test(main), '★★ 有 renderGameBlock()：作品那段文字的**唯一**产出点');
  eq(
    (main.match(/renderGameBlock\(\);/g) ?? []).length,
    3,
    '★★ 三条路都走它：切作品（onGameChanged）· 开机（boot）· **切语言（relayoutForLang）**',
  );
  ok(
    /function relayoutForLang[\s\S]{0,600}?renderGameBlock\(\);/.test(main),
    '★★ 切语言的重画名单里有它 —— 0.39 修的就是这里漏了它（下拉换成英文、右边警告还是中文）',
  );
  ok(!/renderGameNote\(findGame\(DEFAULT_GAME_ID\)/.test(main), '★ 开机那条老写法（自己传 entry）已经不在了');

  // ── ② 用假 DOM 跑真函数：同一句警告在两语言下必须都出自 t() ──
  {
    const mkEl = (): Record<string, unknown> => {
      const e: Record<string, unknown> = {
        children: [] as unknown[],
        firstChild: null as unknown,
        style: {},
        textContent: '',
        appendChild(c: unknown) {
          (this.children as unknown[]).push(c);
          this.firstChild = (this.children as unknown[])[0] ?? null;
          return c;
        },
        removeChild(c: unknown) {
          this.children = (this.children as unknown[]).filter((x) => x !== c);
          this.firstChild = (this.children as unknown[])[0] ?? null;
          return c;
        },
      };
      return e;
    };
    const note = mkEl();
    const customRow = mkEl();
    const g = globalThis as unknown as { document?: unknown };
    const prevDoc = g.document;
    g.document = {
      getElementById: (id: string) => (id === 'game-note' ? note : id === 'custom-serial-row' ? customRow : null),
      createElement: () => mkEl(),
      createTextNode: (s: string) => ({ textContent: s }),
      // ⚠ `setLang()` 会顺手调 `applyStaticI18n()`（它扫 `[data-en]`）—— 假 DOM 给个空表就够，
      //   否则这里会炸在 `document.querySelectorAll is not a function`。
      querySelectorAll: () => [],
    };
    try {
      const ac2 = findGame('ac2') ?? null;
      const textOf = (): string => (note.children as Array<{ textContent?: string }>).map((c) => String(c.textContent ?? '')).join('');
      setLang('zh', { persist: false });
      renderGameNote(ac2);
      const zh = textOf();
      setLang('en', { persist: false });
      renderGameNote(ac2);
      const en = textOf();
      ok(zh.length > 0 && zh.includes('未验证'), `★ 中文态：未验证警告是中文（${zh}）`);
      ok(en.length > 0 && en.includes('Unverified') && !en.includes('未验证'), `★★ 英文态：同一句换成英文（${en}）`);
      setLang('zh', { persist: false });
      renderGameNote(ac2);
      ok(textOf() === zh, '★ 切回中文又是原来那句（往返一致）');
      // 已验证的作品**不显示**警告（0.10 起的行为不能因为这次改动丢了）
      setLang('zh', { persist: false });
      renderGameNote(findGame('lr-jp') ?? null);
      eq(textOf(), '', '★ 已验证的作品这里不显示任何东西（冒烟不能只测"有字"）');
    } finally {
      if (prevDoc === undefined) delete g.document;
      else g.document = prevDoc;
    }
  }

  // ── ③ 产物里两种语言都在（不然英文用户看到的还是中文）──
  // ★ 0.45：原来是 `A || B` 而 `B`（"未验证"）是 `A` 的**子串** ⇒ 恒真，删掉那个分支。
  ok(dist.includes('未验证：没有真实徽章样本'), '★ 产物里有未验证警告的中文原文');
  ok(dist.includes('Unverified: no real emblem sample.'), '★★ 产物里有它的英文那句');
  ok(dist.includes('The disc serial cannot be empty') && dist.includes('盘序列号不能为空'), '★ 解析失败的红字也是中英成对');
}


// ==========================================================================
// (y) ★ 0.40：把"切语言不同步"这一类**一次清干净** + 写卡失败/取消也要重建视图
// ==========================================================================

section('(y) ★ 0.40：状态行 / 取景读数 / 顶部文件名 / 弹窗 / 提示条都跟着语言走；写卡失败不再卡死');

{
  const main = read('src/ui/main.ts');
  const dom = read('src/ui/dom.ts');
  const st = read('src/ui/state.ts');
  const pipe = read('src/ui/pipeline.ts');
  const crop = read('src/ui/cropView.ts');
  const cardOps = read('src/ui/cardOps.ts');
  const dist = existsSync(DIST) ? readFileSync(DIST, 'utf8') : '';

  // ── ① 状态行：能"按新语言重说"──
  ok(/export function setStatus\(text: string, redo\?: \(\(\) => string\) \| null\)/.test(st), '★★ setStatus() 多收一个 `redo`（这句话怎么再说一遍）');
  ok(
    /export function setStatusPair\(zh: string, en: string, ja: string, ko: string\)/.test(st),
    '★★ 有 setStatusPair(zh, en, ja, ko)：四种语言的原文都留着 ⇒ 切语言能重说',
  );
  ok(/export function relayoutStatus\(\): boolean/.test(st), '★ 有 relayoutStatus()（拿不到 redo 时返回 false，由调用方决定清空还是"就绪"）');
  ok(
    (main.match(/setStatusPair\(/g) ?? []).length >= 8,
    `★ 状态行的成对文案都走 setStatusPair（实到 ${(main.match(/setStatusPair\(/g) ?? []).length} 处）`,
  );
  ok(/if \(!relayoutStatus\(\)\) setStatus\(state\.card \? '' : READY_TEXT\(\)\)/.test(main), '★★ 切语言时状态行按新语言重说（没有重算办法才退化成"空 / 就绪"）');
  ok(/setStatusText\(statusLine\(\), statusLine\)/.test(crop), '★★ 取景那句状态行带 redo（而且读的是**当前**窗口，不会说到旧数字）');
  ok(/noDirForGameText\(state\.model\?\.serial \?\? null/.test(main), '★ "本作品没目录"那句也带了 redo');

  // ── ② 取景读数（白框下面那行）──
  ok(/export function refreshCropText\(\)/.test(crop), '★★ refreshCropText()：`layoutCropView()` 只写样式，文字在 `describeWindow()` 里');
  ok(/if \(isCropActive\(\)\) refreshCropText\(\);/.test(main), '★★ 切语言名单里调它（原来只调 layoutCropView ⇒ 读数停在旧语言）');
  ok(/cachedBox = null;\s*layoutCropView\(\);/.test(crop), '★ 重说之后把舞台尺寸缓存作废（两种语言读数长短不同 ⇒ 动作行高度可能变）');

  // ── ③ 顶部"文件名 · 尺寸"──
  ok(/export function renderOriginalBadge\(\): void/.test(pipe), '★★ renderOriginalBadge 导出（它以前从不重画：切语言走的是更轻的 renderImageViews）');
  ok(/renderOriginalBadge\(\);/.test(main), '★ 切语言名单里调它');
  ok(/const label = src\.clipboard \? t\(/.test(pipe), '★★ 剪贴板前缀在**渲染时**才 t()（state 里只许存原文件名）');
  ok(/clipboard\?: boolean/.test(st), '★ SourceImage 有 `clipboard` 标记');
  ok(/loadImageFromBlob\(img, img\.name, \{ clipboard: true \}\)/.test(main), '★ 粘贴事件传原文件名 + clipboard 标记');
  ok(!/t\(`剪贴板 · \$\{img\.name/.test(main), '★★ 不再把翻译好的"剪贴板 · x"存进 state（那是根源）');

  // ── ④ 弹窗：开着时切语言要整块换 ──
  ok(/export function showModal\(render: \(\) => ModalContent\)/.test(dom), '★★ showModal() 收**渲染函数**（收字符串的话语言在调用那一刻就被定死了）');
  ok(/export function relayoutModalForLang\(\)/.test(dom), '★★ relayoutModalForLang()：把还开着的弹窗重放一遍');
  ok(/relayoutModalForLang\(\);/.test(main), '★ 切语言名单里调它');
  ok((main.match(/showModal\(\(\) => \(\{/g) ?? []).length === 2, '★ 两处 showModal（开机告知 / 取景中写入拦截）都改成渲染函数');

  // ── ⑤ 提示条：切语言**收掉**（渲染好的字符串没法重说）──
  ok(/export function dismissToasts\(\)/.test(dom), '★★ dismissToasts()');
  ok(/dismissToasts\(\);\s*\/\/ ★ 0\.40/.test(main), '★★ 切语言时把屏上还没消失的提示条收掉');
  ok(/liveToasts\.add\(node\)/.test(dom) && /liveToasts\.delete\(node\)/.test(dom), '★ toast() 把节点登记/注销（关闭与到期都要注销）');

  // ── ⑥ ★★ 写卡失败 / 取消之后**也要**重建视图（审查抓到的"用户被卡死"）──
  ok(
    /showLog\(outcome\.lines\);\s*\/\/ ★★ 0\.40[\s\S]{0,700}?refreshCardViews\(r\.ctx\);\s*if \(outcome\.ok\)/.test(main),
    '★★ `writeSlot()` 之后**无论成败**都重建视图（内存副本在确认框之前就改过了）',
  );
  ok(/cancelled\?: boolean/.test(cardOps), '★★ WriteOutcome 有 `cancelled` 标记（取消 ≠ 失败）');
  ok(
    /return \{ ok: saved\.ok, cancelled: saved\.cancelled, lines, persisted: saved\.persisted \};/.test(cardOps),
    '★★ `writeSlot()` **原样透传** `cancelled`（原来重建对象时把它丢了 ⇒ 取消被报成"被拒绝"）',
  );
  ok(/outcome\.cancelled/.test(main), '★ 界面上"取消"与"被拒绝"分开说');

  // ── ⑦ 漏翻闸门认识新的"成对文案"包装 ──
  ok(
    /const SINKS = new Set\(\['t', 'setStatusPair', 'refusedNote'\]\)/.test(read('tools/i18n-audit.mjs')),
    '★★ i18n 审计把 `setStatusPair` / `refusedNote` 也算"已翻译"（否则它会把成对文案误报成漏翻）',
  );

  // ── ⑧ 产物里也带着这套 ──
  ok(dist.includes('relayoutModalForLang') && dist.includes('dismissToasts'), '★ 产物里有弹窗重放与提示条收口');
  ok(dist.includes('refreshCropText'), '★ 产物里有取景读数的重画入口');

  // ── ⑨ ★★ 0.41（审查抓到）：`state.busy` 不能只靠"禁用一串按钮" ──
  ok(/function blockedWhileBusy\(what: string\): boolean/.test(main), '★★ 有 blockedWhileBusy()：写入进行中挡住**非按钮**入口');
  for (const [what, re] of [
    ['拖入记忆卡', /blockedWhileBusy\(t\('拖入记忆卡/],
    ['拖入图片', /blockedWhileBusy\(t\('拖入图片/],
    ['粘贴图片', /blockedWhileBusy\(t\('粘贴图片/],
    ['兜底文件框换卡', /blockedWhileBusy\(t\('换记忆卡/],
    ['兜底文件框换图', /blockedWhileBusy\(t\('换图片/],
    ['切语言', /blockedWhileBusy\(t\('切换语言/],
  ] as Array<[string, RegExp]>) {
    ok(re.test(main), `★★ ${what} 这条入口也挡（原来拖入一个字节都不看 state.busy）`);
  }
  ok(/fillLangSelect\(\); \/\/ 把下拉拨回当前语言/.test(main), '★ 切语言被挡住时把下拉拨回去（视觉上不骗人）');

  // ── ⑩ ★ 0.41：点选槽位不再重建 8 格（键盘焦点 / 8 张缩略图都留着）──
  ok(/export function markSelectedSlot\(index: number\): void/.test(read('src/ui/slotsView.ts')), '★★ 有 markSelectedSlot()：只切高亮 class');
  ok(
    /state\.selectedSlot = i;[\s\S]{0,300}?markSelectedSlot\(i\);[\s\S]{0,120}?updateWriteHints\(\);/.test(main),
    '★★ selectSlot() 只调 markSelectedSlot（原来整批 renderSlots ⇒ 焦点掉回 body、白重画 8 张图）',
  );
  // ⚠ 这条要打在**掩码后**的源码上：`selectSlot()` 的注释里正好提到那个被删掉的调用（注释会被抹掉）
  ok(!/function selectSlot[\s\S]{0,400}?renderSlots\(/.test(maskSource(main)), '★★ selectSlot() 里不再调 renderSlots()');

  // ── ⑪ ★ 0.41：拖入开卡也把 `lastSeen` 传下去（否则首次写入跳过"磁盘被改过"那道闸门）──
  ok(
    /openCardFromBytes\(f\.name, bytes, handle, \{ mtime: f\.lastModified, size: f\.size \}\)/.test(main),
    '★★ 拖入开卡传 `lastSeen`（与〔选择记忆卡〕那条路口径一致）',
  );

  // ── ⑫ ★ 0.41：英文文案里不许混中文全角标点（审查抓到的 `（…px）`）──
  {
    const zoomNote = /`Scaled to fit the container:[^`]*`/.exec(pipe)?.[0] ?? '';
    ok(zoomNote.length > 0 && !/[（）：，。]/.test(zoomNote), `★★ 英文那半用半角标点（实到：${zoomNote.slice(0, 60)}…）`);
  }

  // ── ⑬ ★★ 0.41：`src/ui/**` 里**不许用"没导入的导出符号"** ──
  //   来由（这条闸门就是被自己的 bug 逼出来的）：v0.40 我在 main.ts 里写了 8 处 `setStatusPair(...)`，
  //   却**忘了加 import** ⇒ 每次点到那几条路都抛 `ReferenceError`（界面只是"什么都没发生"）。
  //   而当时所有判据都是"源码 grep"，一个都抓不到 —— 打包器只擦类型、不做类型检查，跑了这么久才被
  //   无头 E2E 抓到（写卡取消那条路）。这条扫描器补上这个缺口：
  //     ① 收齐 `src/ui/**` 里所有 `export` 出来的名字；
  //     ② 逐个文件看：某个导出名在**调用位置**出现（`名字(`，且前面不是 `.`），却既不在 import 表里、
  //        也不是本文件自己声明的 ⇒ 报出来。
  //   ⚠ 打在**掩码后**的源码上（注释里提到某个名字不算用）；`.foo(`（方法调用）排除。
  {
    const uiFiles: string[] = [];
    const walk = (rel: string): void => {
      const abs = join(WEB, rel);
      if (!existsSync(abs)) return;
      for (const e of readdirSync(abs, { withFileTypes: true })) {
        const child = `${rel}/${e.name}`;
        if (e.isDirectory()) walk(child);
        else if (e.name.endsWith('.ts')) uiFiles.push(child);
      }
    };
    walk('src');
    const exported = new Set<string>();
    for (const f of uiFiles) {
      const src = maskSource(read(f));
      for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g)) exported.add(m[1]);
    }
    const missing: string[] = [];
    for (const f of uiFiles) {
      const src = maskSource(read(f));
      const imported = new Set<string>();
      for (const m of src.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s*from/g)) {
        for (const part of m[1].split(',')) {
          const name = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/).pop()?.trim() ?? '';
          if (name) imported.add(name);
        }
      }
      const local = new Set<string>();
      for (const m of src.matchAll(/(?:^|\n)\s*(?:export\s+)?(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g)) local.add(m[1]);
      for (const name of exported) {
        if (imported.has(name) || local.has(name)) continue;
        if (new RegExp(`(^|[^.\\w$])${name}\\s*\\(`).test(src)) missing.push(`${f}: ${name}`);
      }
    }
    eq(missing.join(' | '), '', `★★ src/ui/** 里没有"用了却没导入"的导出符号（实到：${missing.length} 处）`);
  }
}


// ==========================================================================
// (z) ★ 0.42：写权限必须在**点击那一刻**问（`requestPermission` 需要用户手势）
// ==========================================================================

section('(z) ★ 0.42：写权限在点击那一刻问；落盘那一步绝不再问（用户实测的 SecurityError）');

{
  const main = read('src/ui/main.ts');
  const cardOps = read('src/ui/cardOps.ts');
  const stateSrc = read('src/ui/state.ts');
  const dist = existsSync(DIST) ? readFileSync(DIST, 'utf8') : '';

  const throwNamed = (name: string, message: string): never => {
    const e = new Error(message);
    e.name = name;
    throw e;
  };

  // ── ① 纯逻辑：查 / 问 / 抛，都不能把异常漏给调用方 ──
  {
    const handle = (
      query: PermissionState | 'throw' | null,
      request: PermissionState | 'throw' | null,
    ): { queryPermission?: unknown; requestPermission?: unknown; calls: { request: number } } => {
      const calls = { request: 0 };
      const h: Record<string, unknown> = { calls };
      if (query !== null) h.queryPermission = async () => (query === 'throw' ? throwNamed('SecurityError', 'query failed') : query);
      if (request !== null) {
        h.requestPermission = async () => {
          calls.request += 1;
          return request === 'throw'
            ? throwNamed('SecurityError', 'User activation is required to request permissions.')
            : request;
        };
      }
      return h as { queryPermission?: unknown; requestPermission?: unknown; calls: { request: number } };
    };

    const granted = await ensureWritePermission(handle('granted', null));
    eq(`${granted.ok}/${granted.reason}`, 'true/granted', '★ 查出来就是 granted ⇒ 直接放行（不问）');

    const asked = handle('prompt', 'granted');
    const askedRes = await ensureWritePermission(asked);
    eq(`${askedRes.ok}/${askedRes.reason}`, 'true/granted', '★ prompt ⇒ 问一次，用户同意 ⇒ 放行');
    eq(asked.calls.request, 1, '★ 只问一次');

    const denied = await ensureWritePermission(handle('prompt', 'denied'));
    eq(`${denied.ok}/${denied.reason}`, 'false/prompt-denied', '★ 用户在权限框里点了不允许 ⇒ ok:false / prompt-denied');

    // ★★ 这一条就是用户实测那个 bug：必须**翻成 ok:false**，不能把 SecurityError 抛出去
    const noGesture = await ensureWritePermission(handle('prompt', 'throw'));
    eq(`${noGesture.ok}/${noGesture.reason}`, 'false/needs-gesture', '★★ 问的时候抛 SecurityError（没有用户手势）⇒ 翻成 needs-gesture，不冒泡');
    ok(/SecurityError/.test(noGesture.detail ?? ''), '★ 原始错误名留在 detail 里（给开发看，不吓用户）');

    // ★★ "落盘那一步只查不问"：allowRequest:false 时**一次都不能问**
    const queryOnly = handle('prompt', 'throw');
    const qo = await ensureWritePermission(queryOnly, { allowRequest: false });
    eq(`${qo.ok}/${qo.reason}`, 'false/read-only', '★★ allowRequest:false ⇒ 只查不问，拿不到就是 ok:false');
    eq(queryOnly.calls.request, 0, '★★ 而且 requestPermission **一次都没被调用**（那一步问了必抛）');

    // ★ 0.45：`'ok'` 那一档已从联合类型里删掉 —— 唯一调用点在调它**之前**就 `if (r.ok) return`
    //   （`main.ts::requestWritePermissionIfNeeded()`），所以"已授权"根本到不了这里。
    //   ⚠ 别再加回 `eq(writePermHintKey({ok:true,…}), 'ok')`：那是在测一个生产不可达的值。
    eq(writePermHintKey({ ok: false, reason: 'needs-gesture' }), 'gesture', '★ 提示键：gesture（"请再点一次"）');
    eq(writePermHintKey({ ok: false, reason: 'prompt-denied' }), 'denied', '★ 提示键：denied');
    eq(writePermHintKey({ ok: false, reason: 'read-only' }), 'readonly', '★ 提示键：readonly（也是兜底档）');
    eq(writePermHintKey({ ok: false, reason: 'granted' }), 'readonly', '★ 兜底：没写到的理由归 readonly，不会返回 undefined');

    const oldBrowser = await ensureWritePermission({} as never);
    eq(`${oldBrowser.ok}`, 'true', '★ 连 queryPermission 都没有（老浏览器 / 桩）⇒ 当作能写，让 createWritable 去报它自己的错');
    const queryThrows = await ensureWritePermission(handle('throw', null));
    eq(`${queryThrows.ok}/${queryThrows.reason}`, 'false/needs-gesture', '★ 连 queryPermission 都抛（句柄失效）⇒ 也是 ok:false，不冒泡');
  }

  // ── ② 源码规矩：问的位置对、落盘那一步不问 ──
  ok(/export async function ensureWritePermission\(/.test(read('src/ui/logic/writePermission.ts')), '★ 有可测的纯逻辑 `ensureWritePermission()`');
  ok(/writePerm: WritePermResult \| null/.test(stateSrc), '★★ `LoadedCard.writePerm` 记着"这次会话问到的结论"');
  ok(/async function requestWritePermissionIfNeeded\(\)/.test(main), '★★ main.ts 有 `requestWritePermissionIfNeeded()`');
  ok(
    /async function doWrite\(slotIndex: number, what: string\): Promise<void> \{\s*\n\s*if \(state\.busy\) return;\s*\n\s*\/\/ ★ 0\.42[\s\S]{0,160}?await requestWritePermissionIfNeeded\(\);/.test(main),
    '★★ `doWrite()` **一进来**就问（在任何 await / confirm 之前）',
  );
  ok(
    /btn-delete'\)\.addEventListener\('click'[\s\S]{0,260}?await requestWritePermissionIfNeeded\(\);/.test(main),
    '★★ 〔删除槽〕那条路也问（它同样要落盘）',
  );
  ok(!/requestPermission\(/.test(cardOps), '★★★ `cardOps.ts` 里**一个 `requestPermission(` 都没有**（那就是用户实测 SecurityError 的根源）');
  ok(
    /ensureWritePermission\(lc\.handle, \{ allowRequest: false \}\)/.test(cardOps),
    '★★ 落盘那一步只**查**（`allowRequest: false`），拿不到就优雅退化成下载',
  );
  ok(/e\.name === 'SecurityError'/.test(cardOps), '★ `SecurityError` 也有专属人话（"再点一次 / 或用〔另存为〕"），不再甩英文异常');
  ok(dist.includes('requestWritePermissionIfNeeded'), '★ 产物里带着点击那一刻的权限请求');
  ok(!/User activation is required/.test(dist), '★ 产物里不会出现那句英文异常文本');
}


// ==========================================================================
// (aa) ★ 0.43：提示去重 —— 一个事实只在**一个主位**讲全文
// ==========================================================================

section('(aa) ★ 0.43：同一条事实只在一个主位讲全文（其余渠道只留指针 / 一句话标签）');

{
  const main = read('src/ui/main.ts');
  const cardOps = read('src/ui/cardOps.ts');
  const planSrc = read('src/ui/logic/planWrite.ts');
  const slotsLogic = read('src/ui/logic/slots.ts');
  const slotsSrc = read('src/ui/slotsView.ts');
  const dist = existsSync(DIST) ? readFileSync(DIST, 'utf8') : '';

  // ── ① 拒绝理由收成"一行正文 + hover 机制 + 一句话标签" ──
  ok(
    /errorDetail\?: string \| null;/.test(planSrc) && /errorShort\?: string \| null;/.test(planSrc),
    '★★ WritePlan 多了 errorDetail（hover 用的机制解释）与 errorShort（状态行/toast 用的一句话标签）',
  );
  {
    const p = planWriteTargetIn({ model: nxView, cardDirNames, ctx: nxCtx, slotIndex: 5 });
    ok(!p.error!.includes('\n'), '★★ 拒绝**正文**是一行（原来是"没有目录 + 卡上有别的作品 + 想存就先存一个徽章"的三段长句）');
    eq(p.errorShort, '缺作品目录', '★ 一句话标签 = 「缺作品目录」');
    ok(
      (p.errorDetail ?? '').includes('不会新建目录') && p.errorDetail !== p.error,
      '★★ 机制解释（"卡层不会新建目录"）挪进 errorDetail ⇒ 只占 hover，不占正文',
    );
    eq(
      (`${p.error}${p.errorDetail}`.match(/\*\*/g) ?? []).length,
      0,
      '★★ 正文与 hover 都是纯文本（`textContent` / `title`）⇒ 里面不许有 `**强调**`（会原样显示成星号）',
    );
  }

  // ── ② 提示行：有拒绝理由时**只显示它**（早退；不再追加"缺目录整句"与作品常量那两行）──
  ok(
    /if \(plan\.error\) \{[\s\S]{0,1400}?text: plan\.error, title: plan\.errorDetail \?\? null[\s\S]{0,400}?return;\s*\n\s*\}/.test(
      main,
    ),
    '★★ `updateWriteHints()` 见到 plan.error 就**把机制挂到 title 上、然后 return**（同一件事不再往下写第二遍）',
  );
  ok(
    !/el\('div', \{ class: 'bad', text: plan\.error \}\)/.test(main),
    '★★ 原来那一行（正文 + 下面再挂缺目录整句 + 作品常量）已经不存在',
  );

  // ── ③ 预检被拒 ⇒ **不进写入日志**（日志框因此保持隐藏）──
  ok(/refused\?: \{ note: \(\) => string \};/.test(cardOps), '★★ WriteOutcome 有 `refused` 标记（预检被拒）');
  eq(
    (cardOps.match(/lines\.push\('❌ ' \+ msg\)/g) ?? []).length,
    1,
    '★★ 全文件只有 `fail()` 往日志里追加行 ⇒ `reject()` 一行都不记（"预检被拒 = 没发生任何事"）',
  );
  ok(
    /const reject = \(note: \{ note: \(\) => string \}\): WriteOutcome => \{[\s\S]{0,300}?refused: note/.test(cardOps),
    '★ `reject()` 只弹一句标签 + 带 refused 标记',
  );
  ok(
    !/if \(plan\.error\) return fail\(plan\.error\)/.test(cardOps),
    '★★ `plan.error` 走 `reject()`（原来走 `fail()` ⇒ 日志里把提示行那两三行**又抄一遍**）',
  );
  ok(
    /return reject\(refusedRedo\(\(\) => planWriteTarget\(ctx, slotIndex\)\.errorShort/.test(cardOps),
    '★★ 拒绝时只把「一句话标签」交给状态行/toast；标签**重算**（切语言跟着换）',
  );
  ok(
    (cardOps.match(/return reject\(/g) ?? []).length >= 6,
    '★★ 预检的每一条拒绝都走 `reject()`（没开卡 / 没模型 / 图像没准备好 / 作品常量没依据 / plan.error / 没有目标槽）',
  );
  ok(
    /refusedNote\('还没有打开记忆卡', 'No memory card loaded yet', .*?\)/.test(cardOps) &&
      /refusedNote\('还没有可写入的图像', 'No image ready to write', .*?, false\)/.test(cardOps),
    '★ `refusedNote()` 收"四语原文 + 要不要挂指针"（hintLine=false 的那两条提示行上没有对应正文，不许瞎指）',
  );
  ok(
    /const SINKS = new Set\(\['t', 'setStatusPair', 'refusedNote'\]\)/.test(read('tools/i18n-audit.mjs')),
    '★ 漏翻闸门认识 `refusedNote(zh, en, ja, ko)`（它和 `t` 同形：前四个参数就是四语原文）',
  );

  // ── ④ 状态行：说"被拒绝：<标签>"，不再把人指去日志（日志这次是空的）──
  ok(/outcome\.refused/.test(main), '★ 状态行认得 `refused`');
  ok(
    /t\(`\$\{what\}被拒绝：\$\{outcome\.refused!\.note\(\)\}`/.test(main),
    '★★ 状态行 = 「写入被拒绝：<一句话标签>」（原来 = "被拒绝（见右侧日志）"，可日志里这次**什么都没有**）',
  );
  ok(
    /setStatusPair\(`\$\{what\}被拒绝（见右侧日志）`/.test(main),
    '★ 但**动作之后**的失败（内存写入 / 回读自检）仍然指向日志 —— 那条路日志里必须有证据',
  );

  // ── ⑤ 打开卡 / 切作品时不再弹那条 20 秒 info toast（状态行 + 8 槽上方已经说了）──
  ok(
    !main.includes('这张卡上没有当前作品的徽章目录') && !dist.includes('这张卡上没有当前作品的徽章目录'),
    '★★ 那条 20 秒 toast 的文案已整句删除（源码与产物里都没有了）',
  );
  ok(
    /const redo = \(\): string => noDirForGameText\(state\.model\?\.serial \?\? null[\s\S]{0,600}?setStatus\(redo\(\), redo\);[\s\S]{0,600}?return;/.test(
      main,
    ),
    '★★ `afterCardLoaded()` 里只剩"状态行说一遍"（toast 那句删了，同一件事不再说两遍）',
  );

  // ── ⑥ "本作品在卡上还没目录"那句话：一句能照做的 + 一个短尾巴（中英各自成句）──
  {
    const zh = noDirForGameText('SLUS-20435', 8);
    ok(zh.startsWith('这个作品（SLUS-20435）在卡上还没有徽章目录 ⇒ 先在游戏里存一个徽章'), `★ 中文主句能照做（实到：${zh}）`);
    ok(zh.includes('卡上还有 8 个别的作品的徽章目录（切作品查看）'), '★ 尾巴带**条数** + "切作品查看"');
    eq((zh.match(/\*\*/g) ?? []).length, 0, '★★ 状态行是纯文本 ⇒ 不许出现 `**强调**`（那会原样显示成星号）');
    eq((zh.match(/⇒/g) ?? []).length, 1, '★ 只有一处"⇒"（不是三段式）');
    ok(zh.length < 90, `★ 整句压到 90 字以内（实到 ${zh.length} 字）`);
    setLang('en', { persist: false });
    const en = noDirForGameText('SLUS-20435', 8);
    ok(en.includes('save one emblem in the game first') && en.includes('8 other games'), `★ 英文版是同一件事的英文句（实到：${en}）`);
    ok(!/[\u4e00-\u9fff]/.test(en), '★★ 英文版里一个汉字都没有（切到英文不会冒出中文）');
    setLang('zh', { persist: false });
    ok(noDirForGameText(null, 0).includes('没有任何徽章目录'), '★ 卡上确实空着时说另一句（原判据保留）');
  }

  // ── ⑦ 8 槽上方那条常驻警告 = "被隐藏了什么"的主位（它自己说全）──
  ok(
    /卡上还有 \$\{n\} 个别的作品的目录 · 切作品查看/.test(slotsSrc),
    '★★ 主位那条警告自己给出条数（原来只说"被隐藏了"，条数要去状态行看）',
  );

  // ── ⑧ 产物里带着这套（单文件自包含，行为必须在产物里而不只在源码里）──
  for (const s of ['refused', 'errorDetail', '见上方提示行']) {
    ok(dist.includes(s), `★ 产物里有「${s}」`);
  }
  ok(
    // ⚠ 产物是**剥掉类型之后**的 JS：`outcome.refused!.note()` 会留下一个空格（`refused .note()`）⇒ 用正则容忍
    /被拒绝：\$\{outcome\.refused ?\.note\(\)\}/.test(dist),
    '★★ 产物里状态行走的是"被拒绝：<标签>"那条模板（不是只改了源码）',
  );
  ok(
    dist.includes('（见右侧日志）') ,
    '★ 产物里"见右侧日志"还在 —— 它现在只属于**动作之后**的失败那一条分支',
  );
}


// ==========================================================================
// (ab) ★ 0.44：文案里的 `**强调**` 一律清掉（这个项目是纯文本，不是 markdown）
// ==========================================================================

section('(ab) ★ 0.44：用户可见的文字里没有 `**强调**`（`textContent` / `title` 会原样显示成星号）');

{
  const dist = existsSync(DIST) ? readFileSync(DIST, 'utf8') : '';

  // ── ① 扫描器自证：注释里的 `**` 不算，字符串里的都算（含模板串的插值）──
  //   判据必须"能失败"：所以这里喂一份**故意的**样例，逐项对上才算数。
  {
    const sample = [
      "const a = 'x ** y';",
      'const b = "中文 ** 也算";',
      '// 行注释里的 ** 不算',
      '/* 块注释里的 ** 也不算 */',
      'const c = `模板 ** 里也算`;',
      'const d = `插值 ${f("内层 ** 也算")} 尾`;',
    ].join('\n');
    eq(
      auditSource(sample, { collect: true })
        .map((h) => h.text)
        .join(' | '),
      // ⚠ 最后一个是那条模板串**自己**的静态部分（插值被折叠成一个空格 ⇒ `插值 尾`）：
      //   它不含 `**`，但 `collect` 就是"一个不落"，所以照样出现 —— 这正好证明扫全了。
      //   它排在插值内层那一条**之后**：递归扫 `\${…}` 是在闭合反引号之前做的。
      'x ** y | 中文 ** 也算 | 模板 ** 里也算 | 内层 ** 也算 | 插值 尾',
      '★★ `collect` 模式：单引号 / 双引号 / 模板串 / 插值里层的 `**` 都收，注释里的不收',
    );
  }

  // ── ② 真实源码：`src/**`（界面层 + 核心层）的字符串字面量里一个都没有 ──
  {
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(join(WEB, dir), { withFileTypes: true })) {
        const rel = `${dir}/${e.name}`;
        if (e.isDirectory()) walk(rel);
        else if (e.name.endsWith('.ts')) files.push(rel);
      }
    };
    walk('src');
    const bad: string[] = [];
    for (const f of files) {
      for (const hit of auditSource(read(f), { collect: true })) {
        if (hit.text.includes('**')) bad.push(`${f}:${hit.line}`);
      }
    }
    eq(bad.join(' | '), '', `★★ src/** 的字符串字面量里没有 \`**\`（实到 ${bad.length} 处）`);
    ok(files.length >= 20, `★ 扫到了 ${files.length} 个 .ts（不是空扫：空跑会假过）`);
  }

  // ── ③ 产物里那几句也已经清掉（文案会进产物，注释里的 `**` 留下无妨）──
  for (const s of ['**已拒绝落盘**', '即将**直接覆盖**', '**全程只读', '导出的是**游戏口径**', '校验**不通过**']) {
    ok(!dist.includes(s), `★★ 产物里不再有「${s}」`);
  }
}


// ==========================================================================
// (ac) ★ 0.45：只读"可简化点"普查第一批 —— 删掉无人读的字段/导出，修掉假覆盖的断言
// ==========================================================================

section('(ac) ★ 0.45：简化普查第一批（零读者字段 / 死 export / 三条假覆盖断言）');

{
  const main = read('src/ui/main.ts');
  const image = read('src/core/image.ts');
  const card = read('src/core/card.ts');
  const defaults = read('src/ui/logic/defaults.ts');
  const geom = read('src/ui/logic/cropGeometry.ts');
  const perm = read('src/ui/logic/writePermission.ts');
  const dist = existsSync(DIST) ? readFileSync(DIST, 'utf8') : '';

  // ── ① 核心层：4 个"生产者存在、消费者不存在"的字段（`sourceOpaqueColors` 例外，见 ②）──
  //   判据要打在**掩码后**的源码上：这几个词在注释里被提到是允许的（说明为什么删）。
  const imageCode = maskSource(image);
  for (const [name, why] of [
    ['usedColors', 'QuantizeResult.usedColors：写了 2 处、零读者（`colorsAfter` 才是那个数）'],
    ['autoNearestColorLimit', 'FitOptions.autoNearestColorLimit：唯一的用法是 `?? 256`，而 256 就是被调函数的默认值'],
    ['reBinarizeAfterFit', 'PrepareOptions.reBinarizeAfterFit：UI 不产、测试不传 ⇒ `!== false` 永真'],
  ]) {
    ok(!new RegExp(`\\b${name}\\b`).test(imageCode), `★★ image.ts 里不再有 ${why}`);
  }
  ok(!/\bused\b\s*:\s*true/.test(maskSource(card)), '★★ card.ts 的 `Dirent.used` 已删（恒 true 且零读者）');
  ok(
    /if \(fit\.data\[i \* 4 \+ 3\] !== preFinal\[i \* 4 \+ 3\]\)/.test(imageCode),
    '★ 缩放的"再二值化一次"仍在（删的是开关，不是那一步）',
  );

  // ── ② `sourceOpaqueColors` **故意保留**（它是 report 这个"有意的调试面"里唯一的原图色数）──
  ok(
    /sourceOpaqueColors: srcStats\.opaqueColors/.test(imageCode) && /★ 0\.45/.test(image),
    '★ `sourceOpaqueColors` 保留 + 注释写明理由（与 `colorsBefore` 不是同一件事）',
  );

  // ── ③ 导出面：没人 import 的 `export` 去掉（8 个"只在定义文件内用"的 + CORE_DEFAULTS）──
  for (const [file, src, name] of [
    ['src/ui/logic/cropGeometry.ts', geom, 'clampOriginFor'],
    ['src/ui/logic/cropGeometry.ts', geom, 'displayScaleFor'],
    ['src/ui/logic/pcsx2.ts', read('src/ui/logic/pcsx2.ts'), 'parseIni'],
    ['src/ui/logic/slots.ts', read('src/ui/logic/slots.ts'), 'isEmblemDirName'],
  ]) {
    ok(!new RegExp(`export (function|const) ${name}\\b`).test(src), `★ ${file}：\`${name}\` 不再 export（只在同文件内用）`);
  }
  ok(!/export const MIN_WINDOW_PX/.test(geom), '★ cropGeometry.ts：MIN_WINDOW_PX 不再 export');
  ok(!/export const PCSX2_SLOTS/.test(read('src/ui/logic/pcsx2.ts')), '★ pcsx2.ts：PCSX2_SLOTS 不再 export');
  ok(!/export const CORE_DEFAULTS/.test(defaults), '★★ defaults.ts：CORE_DEFAULTS 不再 export（全树没人 import 过）');
  ok(/const CORE_DEFAULTS = Object\.freeze\(/.test(defaults), '★ 常量本身还在（DEFAULT_PARAMS 继续用它）');

  // ── ④ `writePermHintKey()` 的 `'ok'` 档删掉：它在唯一调用点**不可达** ──
  ok(
    /writePermHintKey\(r: WritePermResult\): 'gesture' \| 'denied' \| 'readonly'/.test(perm),
    '★★ 联合类型只剩三档（原来还有 `\'ok\'`，而调用点在调它之前已经 `if (r.ok) return`）',
  );
  ok(
    /if \(r\.ok\) return;[\s\S]{0,120}?writePermHintKey\(r\)/.test(main),
    '★★ 这条不可达性有源码依据：`main.ts` 里 `if (r.ok) return` 就在调用点前面',
  );

  // ── ⑤ 三条"测试在说谎 / 恒真"的断言已修（判据反过来钉在**本文件**上）──
  //   ⚠ 只查**断言表达式**那种写法：注释里提到这些名字是允许的（说明为什么删）。
  const self = readFileSync(join(HERE, 'ui.test.ts'), 'utf8');
  ok(
    !/\/renderSlots\\\(/.test(self),
    '★★ (t) 分节不再要求 `selectSlot()` 原文里出现那个调用（它只出现在注释里 ⇒ 断言假通过）',
  );
  ok(!/eq\(c\.drags/.test(self), '★★ 不再断言 `c.drags`（`build.mjs` 里那是个写死的常量 ⇒ 恒真）');
  ok(
    (self.match(/\|\|\s*(dist|html|idx)\.includes/g) ?? []).length === 0,
    '★★ 没有"右操作数是左操作算子串"的恒真 OR（`A || A的子串`）',
  );
  ok(
    (self.match(/const read = \(p: string\): string =>/g) ?? []).length === 0,
    '★ 15 份重复的 `read` helper 已收敛成顶层一份',
  );
  ok(/^function read\(p: string\): string \{/m.test(self), '★ 顶层那份 `read()` 在（各分节共用）');

  // ── ⑥ 产物侧 / 文档侧 ──
  ok(
    existsSync(join(WEB, 'SIMPLIFY-REVIEW.md')) === false,
    '★★ 过期的 SIMPLIFY-REVIEW.md 已删（行号全错的历史快照，比没有更坏）',
  );
  ok(!dist.includes('SIMPLIFY-REVIEW'), '★ 产物里不再引用那份快照（源码注释里也没有它了）');
  ok(
    !/^├── SIMPLIFY-REVIEW\.md/m.test(read('SPEC.md')),
    '★ SPEC 的目录树里不再把那份快照当成现存文件（`★ v0.45` 那条里提到它是**讲历史**，允许）',
  );
}


console.log('\n' + '='.repeat(78));
if (failures.length === 0) {
  console.log(`✅ ui.test.ts：通过 ${pass} / ${pass}`);
  console.log('='.repeat(78));
  process.exitCode = 0;
} else {
  console.log(`❌ ui.test.ts：通过 ${pass} / ${pass + failures.length}，失败 ${failures.length} 条：`);
  for (const f of failures) console.log('   · ' + f);
  console.log('='.repeat(78));
  process.exitCode = 1;
}
