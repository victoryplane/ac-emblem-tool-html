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
 * 输出：`out\Mcd001_data7test.ps2` + 拷一份到 PCSX2 记忆卡目录。
 * ⚠ 源卡 `out\evidence\Mcd001_embdata2.ps2` **只读**：本脚本用 `readCardFromBuffer`（默认先复制），
 *   并在末尾用 SHA-256 自证源卡未变。写卡前请**完全退出 PCSX2**。
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readCardFromBuffer, type Card } from '../src/core/card.ts';
import { verifyChecksums, isLrSave, saveKind } from '../src/core/emblem.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJ = dirname(dirname(HERE));                        // …\emblem-tool
const SRC = join(PROJ, 'out', 'evidence', 'Mcd001_embdata2.ps2');
const BLOCKS = join(PROJ, 'web', 'test', 'fixtures', 'blocks');
const OUT_CARD = join(PROJ, 'out', 'Mcd001_data7test.ps2');
const MC_DIR = 'C:\\Users\\M\\Documents\\PCSX2\\memcards';
const MC_CARD = join(MC_DIR, 'Mcd001_data7test.ps2');
const LR_DIR = 'BISLPS-25462EMB';

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
if (existsSync(MC_DIR)) {
  copyFileSync(OUT_CARD, MC_CARD);
  console.log(`已拷到      : ${MC_CARD}`);
} else {
  console.log(`（未找到记忆卡目录 ${MC_DIR}，只写了 out\\）`);
}

const same = sha(new Uint8Array(readFileSync(SRC))) === srcSha;
console.log(`\n源卡写前=写后 : ${same ? '是 ✅（一个字节都没动）' : '否 ❌'}`);
console.log(`产物整卡 SHA256: ${sha(outBytes).slice(0, 32)}…`);

console.log(`
================================================================================
接下来怎么测（约 2 分钟）

1. ★ 先**完全退出 PCSX2**（关窗口，不是 reset）；刚才它是关着的，别又开着。
2. 打开 PCSX2 → 设置 → 记忆卡插槽：把 **Slot 2** 指到 \`Mcd001_data7test.ps2\`
   （先跑一遍 \`python tools\\check_pcsx2_slots.py\` 确认"没有任何每游戏覆盖"，
     否则 LR 会读别的卡 —— 这个坑我们今天刚踩过一轮）。
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
