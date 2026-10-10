/**
 * ★ 实机验证卡生成器：用 **TypeScript 卡层**往 LR 目录里新建两个槽（`data3` / `data7`）。
 *
 * ## 为什么要这张卡
 *
 * `card.test.ts` 已经证明 TS 与 Python 在"新建 `data7`"上**逐字节一致**，但那条路径里有一段
 * **没有 Python 参考实现**：4 张证据卡的 `BISLPS-25462EMB` 目录都是 **8/8 满**，
 * 所以新建槽必须**扩目录**（再分配 1 簇 → 接进目录 FAT 链尾 → 新 dirent 写进新簇第 0 页 →
 * 根条目 length +1）。"TS 与 Python 一致"只证明移植忠实，**不证明这个布局游戏认**。
 * 这张卡就是拿去游戏里验这一条的。
 *
 * 顺带验证两件事：
 *   · LR 徽章目录**允许中间有空缺**吗？（写入 `data0/1/2` 与 `data7`，缺 `data3..6`）
 *   · 新建的槽，游戏认不认它的 `icon.sys` 关联（`dataN` 与目录共用一份 `icon.sys`）。
 *
 * ## 写入内容（故意选一眼能认出来的）
 *
 *   `data3` ← CREST（红黑）   来自 `Mcd001_LRtest2.ps2` 的 `data2`
 *   `data7` ← MIRAGE（蓝白）  来自 `Mcd001_LRtest2.ps2` 的 `data1`
 *
 * 跑法（项目根目录）：
 *
 *     node web\tools\make_data7_test.ts
 *
 * 输出：`out\Mcd001_data7test.ps2`（**只写仓库里的 out\**，不碰你的 PCSX2）。
 *
 * ★★ 要顺便拷进 PCSX2 记忆卡目录，必须**显式**加开关：
 *
 *     node web\tools\make_data7_test.ts --to-memcards
 *     node web\tools\make_data7_test.ts --to-memcards --force      # 覆盖已存在的同名卡
 *     node web\tools\make_data7_test.ts --to-memcards --memcards "D:\PCSX2\memcards"
 *
 * ⚠ 为什么默认不写记忆卡目录（0.41 改的）：那个目录是**机主真正的 PCSX2 记忆卡目录**，
 *   里面每一张卡都可能是玩家自己的存档；脚本一进来就 `copyFileSync` 覆盖同名文件
 *   属于"跑一次判据顺手毁一份存档"。现在：
 *     · 默认只写 `out\`；
 *     · `--to-memcards` 才写，而且目标**已存在时默认拒绝**（要 `--force` 才覆盖）；
 *     · 写之前会打印醒目警告（必须先完全退出 PCSX2）。
 * ⚠ 源卡 `out\evidence\Mcd001_embdata2.ps2` **只读**：本脚本用 `readCardFromBuffer`（默认先复制），
 *   并在末尾用 SHA-256 自证源卡未变。
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readCardFromBuffer, type Card } from '../src/core/card.ts';
import { verifyChecksums, isLrSave, saveKind } from '../src/core/emblem.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJ = dirname(dirname(HERE));                        // …\emblem-tool
const SRC = join(PROJ, 'out', 'evidence', 'Mcd001_embdata2.ps2');
const BLOCKS = join(PROJ, 'web', 'test', 'fixtures', 'blocks');
const OUT_CARD = join(PROJ, 'out', 'Mcd001_data7test.ps2');
/** 默认的 PCSX2 记忆卡目录（只有 `--to-memcards` 时才会碰）。 */
const DEFAULT_MC_DIR = 'C:\\Users\\M\\Documents\\PCSX2\\memcards';
const LR_DIR = 'BISLPS-25462EMB';

// ── 命令行 ─────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);

/** 取 `--name value`；没有就返回 null。 */
function argValue(name: string): string | null {
  const i = argv.indexOf(name);
  if (i < 0) return null;
  const v = argv[i + 1];
  if (!v || v.startsWith('--')) return null;
  return v;
}

const knownFlags = ['--to-memcards', '--force', '--memcards'];
const unknown = argv.filter((a, i) => a.startsWith('--') && !knownFlags.includes(a));
if (unknown.length) {
  console.error(`✗ 不认识的参数：${unknown.join(' ')}（只支持 --to-memcards / --force / --memcards <目录>）`);
  process.exit(2);
}
/** ★ 只有显式开关才会碰 PCSX2 记忆卡目录。 */
const toMemcards = argv.includes('--to-memcards');
/** ★ 目标卡已存在时必须再加 `--force` 才覆盖。 */
const force = argv.includes('--force');
const MC_DIR = argValue('--memcards') ?? DEFAULT_MC_DIR;
const MC_CARD = join(MC_DIR, basename(OUT_CARD));


const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex').toUpperCase();
const hex = (n: number) => '0x' + n.toString(16).toUpperCase();

/** 从夹具里取一个真实 LR 徽章块（已经 18/18 校验通过的那种）。 */
function loadBlock(name: string): Uint8Array {
  const p = join(BLOCKS, name);
  const b = new Uint8Array(readFileSync(p));
  if (!isLrSave(b)) throw new Error(`${name} 不是 LR 块`);
  const { ok } = verifyChecksums(b);
  if (!ok) throw new Error(`${name} 校验不过`);
  return b;
}

/** 逐个"被改动的簇"验 ECC（页备用区与数据是否自洽）。 */
function badEccPages(card: Card, clusters: number[]): number[] {
  const bad: number[] = [];
  for (const cl of clusters) {
    for (const k of [0, 1]) {
      const n = card.dataPage(cl, k);
      if (!card.eccOk(n)) bad.push(n);
    }
  }
  return bad;
}

console.log('=== 生成实机验证卡：在 LR 目录里新建 data3 / data7 ===');
if (!existsSync(SRC)) throw new Error('找不到源卡：' + SRC);
const srcBytes = new Uint8Array(readFileSync(SRC));
const srcSha = sha(srcBytes);
console.log(`源卡        : ${SRC}`);
console.log(`源卡 SHA256 : ${srcSha.slice(0, 32)}…`);
console.log(`源卡判定    : ${saveKind(srcBytes)}（${srcBytes.length} 字节）`);

const mirage = loadBlock('Mcd001_LRtest2__BISLPS-25462EMB__data1.raw');   // 蓝白
const crest = loadBlock('Mcd001_LRtest2__BISLPS-25462EMB__data2.raw');    // 红黑
console.log(`\ndata3 ← CREST   ${crest.length} 字节  sha256=${sha(crest).slice(0, 16)}…`);
console.log(`data7 ← MIRAGE  ${mirage.length} 字节  sha256=${sha(mirage).slice(0, 16)}…`);

// ★ 默认 copy=true ⇒ 只改内存副本，源文件一个字节都不碰
const card = readCardFromBuffer(srcBytes, true);

console.log('\n--- 写前：目录现状 ---');
const dirEnt = card.findInRoot(LR_DIR);
if (!dirEnt) throw new Error(`根目录里没有 ${LR_DIR}`);
console.log(`根条目       : ${LR_DIR}  cluster=${dirEnt.cluster} 声明项数=${dirEnt.length} 链=${card.chain(dirEnt.cluster).join(',')}`);
const before = card.listDir(LR_DIR).filter((e) => e.name !== '.' && e.name !== '..');
console.log(`目录内文件   : ${before.map((e) => `${e.name}(${e.length}B)`).join(' ')}`);

const results = [];
for (const [name, data] of [['data3', crest], ['data7', mirage]] as [string, Uint8Array][]) {
  console.log(`\n--- 新建 ${name} ---`);
  const r = card.createFileInDir(LR_DIR, name, data);
  console.log(`  分配数据簇 : ${r.clusters.length} 个  [${r.clusters[0]}..${r.clusters[r.clusters.length - 1]}]`);
  console.log(`  扩目录簇   : ${r.dirExtensionClusters.length ? r.dirExtensionClusters.join(',') : '（无需，目录有空槽）'}`);
  console.log(`  写进槽号   : ${r.slot}   首簇=${r.firstCluster}`);
  console.log(`  项数更新   : ${r.dirCountUpdate ? `${r.dirCountUpdate.mode} ${r.dirCountUpdate.old} → ${r.dirCountUpdate.new}` : '（无）'}`);
  console.log(`  改动页     : ${r.touchedPages.length} 页  [${r.touchedPages.slice(0, 6).join(', ')}${r.touchedPages.length > 6 ? ' …' : ''}]`);
  const bad = badEccPages(card, r.clusters.concat(r.dirExtensionClusters));
  console.log(`  ECC 坏页   : ${bad.length === 0 ? '0 ✅' : bad.join(', ') + ' ❌'}`);
  if (bad.length) throw new Error('ECC 校验失败');
  results.push(r);
}

console.log('\n--- 回读校验 ---');
let allOk = true;
for (const [name, data] of [['data3', crest], ['data7', mirage]] as [string, Uint8Array][]) {
  const e = card.listDir(LR_DIR).find((d) => d.name === name);
  if (!e) { console.log(`  ${name}: ❌ 目录里找不到`); allOk = false; continue; }
  const back = new Uint8Array(card.readFile(e.cluster, e.length));
  const same = back.length === data.length && back.every((v, i) => v === data[i]);
  const { ok } = verifyChecksums(back);
  console.log(`  ${name}: 长度=${e.length} 首簇=${e.cluster} 逐字节一致=${same ? '✅' : '❌'} 18段校验=${ok ? '18/18 ✅' : '❌'}`);
  allOk = allOk && same && ok;
}
const after = card.listDir(LR_DIR).filter((e) => e.name !== '.' && e.name !== '..');
console.log(`  目录内文件 : ${after.map((e) => e.name).join(' ')}`);

if (!allOk) throw new Error('回读校验失败，不写出卡片');

// 写出
const outBytes = card.buf;
mkdirSync(dirname(OUT_CARD), { recursive: true });
writeFileSync(OUT_CARD, outBytes);
console.log(`\n写出        : ${OUT_CARD}`);
if (!toMemcards) {
  console.log('（默认**不碰** PCSX2 记忆卡目录。要拷进去请显式加开关：');
  console.log(`   node web\\tools\\make_data7_test.ts --to-memcards        # 目标目录：${MC_DIR}`);
  console.log('   ⚠ 跑之前先**完全退出 PCSX2** —— 它退出时会用手里的旧卡写回文件。）');
} else if (!existsSync(MC_DIR)) {
  console.log(`（--to-memcards 给了，但没找到记忆卡目录 ${MC_DIR}，只写了 out\\；`);
  console.log('   用 --memcards <目录> 指定你自己的 PCSX2 memcards 路径。）');
} else if (existsSync(MC_CARD) && !force) {
  console.log('');
  console.log('  ⚠⚠ 目标卡已存在，**默认拒绝覆盖**：');
  console.log(`      ${MC_CARD}`);
  console.log('      · 想覆盖：加 --force（先确认那张卡不是你要留的存档！）');
  console.log('      · 想换个目录：--memcards <目录>');
  console.log('      · 只想留在仓库里：不加 --to-memcards 就行。');
} else {
  console.log('');
  console.log('  ⚠⚠ 即将写入 PCSX2 记忆卡目录（**覆盖同名文件**）：');
  console.log(`      ${MC_CARD}`);
  console.log('      · 必须先**完全退出 PCSX2**（关窗口，不是 reset），否则它会把旧卡写回去；');
  console.log('      · 这一步只做"拷一份"；下面第 2 步再去 PCSX2 里把 Slot 2 指到它。');
  copyFileSync(OUT_CARD, MC_CARD);
  console.log(`已拷到      : ${MC_CARD}`);
}

const same = sha(new Uint8Array(readFileSync(SRC))) === srcSha;
console.log(`\n源卡写前=写后 : ${same ? '是 ✅（一个字节都没动）' : '否 ❌'}`);
console.log(`产物整卡 SHA256: ${sha(outBytes).slice(0, 32)}…`);

console.log(`
================================================================================
接下来怎么测（约 2 分钟）

1. ★ 先**完全退出 PCSX2**（关窗口，不是 reset）；刚才它是关着的，别又开着。
2. 打开 PCSX2 → 设置 → 记忆卡插槽：把 **Slot 2** 指到 \`Mcd001_data7test.ps2\`
   （先把 \`inis\\PCSX2.ini\` + \`gamesettings\\*.ini\` 拖进产物的「PCSX2 自检」那一栏，
     确认"没有任何每游戏覆盖"，否则 LR 会读别的卡 —— 这个坑我们今天刚踩过一轮；
     ⚠ 原来这里让你跑 \`python tools\\check_pcsx2_slots.py\`，那个脚本 0.19 已归档，
     结论现值由 \`web/src/ui/logic/pcsx2.ts\` 承接、就在网页那一栏里）。
   ⚠ 若你**没**加 \`--to-memcards\`：请自己把 \`out\\Mcd001_data7test.ps2\` 拷进 memcards。
3. 启动 LR（用你那张 CN 测试 ISO）→ 进**徽章画面** → 选 \`MEMORY CARD slot 2\`。

期望看到 **5 格**（顺序按槽号）：

    data0 紫恶魔（深蓝紫）  ← 原有
    data1 红树（黑红）      ← 原有
    data2 反色恶魔（反白）  ← 原有
    data3 ★ CREST（红黑）   ← 本次新建（目录满 → 扩目录）
    data7 ★ MIRAGE（蓝白）  ← 本次新建（且中间缺 data4..6）

对照图：out\\preview\\lrtest2_BISLPS-25462EMB_data2.png（CREST）
        out\\preview\\lrtest2_BISLPS-25462EMB_data1.png（MIRAGE）

判读
  · 5 格都出来、且 CREST/MIRAGE 正确 ⇒ ★ **TS 卡层的"目录满时新建槽"实机通过**
  · 只出来 3 格（data3/data7 不显示） ⇒ 游戏可能要求槽号连续，或扩目录簇的写法游戏不认（要查）
  · 出来但显示"破損ファイル"/花屏          ⇒ 数据块或 FAT 链有问题（把现象告我，卡别删）
  · 游戏卡死                                ⇒ 立刻回报；这张卡是副本，源卡没事
================================================================================`);
