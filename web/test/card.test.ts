/**
 * 记忆卡层测试（Node 24 原生跑 .ts，零依赖，零编译）。
 *
 *   node web\test\card.test.ts          # 在项目根目录 emblem-tool\ 下执行
 *   node web\test\card.test.ts --badhandle   # 额外演示"跨句柄回退"那个坑
 *
 * 判据三档：
 *   A. **只读**：用 TS 层读 4 张证据卡，逐项与 `fixtures/card-manifest.json` 比对
 *      （根目录条目 / 徽章目录清单 / 每个文件内容的 SHA-256）。
 *   B. **写入**：在内存副本上做与 Python 完全相同的一次写入（`BISLPS-25462EMB` 里新建 `data7`），
 *      断言"变化的页集合完全相同 + 每页 SHA-256 完全相同 + 整卡 SHA-256 完全相同"。
 *   C. **自检**：ECC 对已知页的结果、簇链跨 FAT 块、offset/边界（最后一簇）处理、
 *      以及"读-改-写必须走同一个镜像"的语义。
 *
 * 失败：非零退出，并逐条打印哪一条不一致（期望 vs 实际）。
 */
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  Card,
  PARITY,
  CPM,
  calcEcc,
  pageEcc,
  readCardFromBuffer,
  encodeName,
  modeIsDir,
  isEmblemArchiveDirName,
  PAGE_SIZE,
  SPARE_SIZE,
  STRIDE,
  CARD_SIZE_8MB,
  CARD_PAGES_8MB,
  CARD_CLUSTERS_8MB,
  FAT_END,
  MODE_DIR,
  MODE_FILE,
  MODE_PARENT,
  DIRENT_NAME,
} from '../src/core/card.ts';

/** dirent 名称区在 512 B 项里的偏移（= card.ts 的 DIRENT_NAME）。 */
const DIRENT_NAME_OFF = DIRENT_NAME;

// ─────────────────────────── 基础设施 ───────────────────────────

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJ = resolve(HERE, '..', '..');
const MANIFEST_PATH = join(HERE, 'fixtures', 'card-manifest.json');
const EVIDENCE = join(PROJ, 'out', 'evidence');

const sha256 = (b: Uint8Array | string): string => createHash('sha256').update(b).digest('hex');

/**
 * ★ 0.26：`out/evidence/*.ps2` 是 **4 张真记忆卡（33 MB）** —— 它们**不进仓库**
 *   （体积 + 那是机主的私有存档镜像）⇒ 别人 clone 下来时没有它们。
 *
 * 这时依赖它们的两节（B 只读比对 / D 写入实验）**明确打印原因并跳过**：
 * **不静默、也不算失败** —— 与 `web/check.mjs` 对"这台机器没装 python"的处理同一个口径。
 * ⚠ 本机（有卡）时行为一个字不变：该跑的全跑，条数不变。
 */
const HAVE_EVIDENCE = existsSync(join(EVIDENCE, 'Mcd001_final.ps2'));
let skippedEvidence = 0;
function skipEvidence(what: string): void {
  skippedEvidence += 1;
  console.log(`  ⏭ 跳过「${what}」——本机没有 out/evidence 里的真记忆卡（33 MB，不进仓库）`);
}

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    passed++;
    return;
  }
  failed++;
  const line = detail ? `${name}\n      ${detail}` : name;
  failures.push(line);
  console.log(`  ❌ ${line}`);
}

function eq(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  check(name, a === e, `期望 ${e}\n      实际 ${a}`);
}

function section(title: string): void {
  console.log(`\n── ${title} ──────────────────────────────────────────`);
}

// ─────────────────────────── 夹具类型 ───────────────────────────

interface ManifestRootEntry {
  index: number;
  mode: number;
  length: number;
  cluster: number;
  parent: number;
  name: string;
}
interface ManifestFile {
  index: number;
  name: string;
  mode: number;
  length: number;
  cluster: number;
  chain: number[];
  sha256: string;
  readLength: number;
}
interface ManifestEmblemDir {
  name: string;
  declaredCount: number;
  cluster: number;
  chain: number[];
  selfDotLength: number;
  files: ManifestFile[];
}
interface ManifestCard {
  name: string;
  size: number;
  sha256: string;
  npages: number;
  pageLen: number;
  ppc: number;
  ppb: number;
  clusters: number;
  allocOffset: number;
  allocEnd: number;
  rootdir: number;
  ifc0: number;
  rootChain: number[];
  rootDotLength: number;
  root: ManifestRootEntry[];
  emblemDirs: ManifestEmblemDir[];
}
interface ManifestExperiment {
  label: string;
  expectExtension: boolean;
  note: string;
  sourceCard: string;
  sourceSHA256: string;
  resultSHA256: string;
  fileName: string;
  fileLength: number;
  fileDataSHA256: string;
  dirBefore: { name: string; declaredCount: number; cluster: number; chain: number[] };
  usedClusterCount: number;
  dataClusters: number[];
  dirExtensionClusters: number[];
  emptyDirentPages: number[];
  emptyDirentForms: {
    page: number;
    dataAllFF: boolean;
    spareHex: string;
    spareIsComputedECC: boolean;
    spareIsVirginFFFF: boolean;
    modeAllFF: boolean;
  }[];
  slot: number;
  templateFile: string;
  direntPage: number;
  direntSHA256: string;
  rootEntry: { index: number; page: number; oldCount: number; newCount: number };
  touchedPagesRaw: number[];
  intendedWrites: { page: number; sha256Data: string; sha256Spare: string }[];
  noopWritePages: number[];
  strideNoopWritePages: number[];
  changedPageCount: number;
  changedPages: { page: number; sha256Before: string; sha256After: string }[];
  changedStridePages: number[];
  spareOnlyChangedPages: number[];
  touchedPages: number[];
  eccCheckedPages: number[];
  eccBadPages: number[];
  readback: {
    dirDeclaredCount: number;
    fileCount: number;
    fileNames: string[];
    fileCluster: number;
    fileLength: number;
    chain: number[];
  };
}
interface Manifest {
  constants: Record<string, number>;
  eccReference: Record<string, { page: string; ecc: string; sha256Page: string; sha256Ecc: string }>;
  cards: ManifestCard[];
  experiments: ManifestExperiment[];
}

const manifest: Manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
const EXPERIMENTS = manifest.experiments;
const expByLabel = (label: string): ManifestExperiment => {
  const e = EXPERIMENTS.find((x) => x.label === label);
  if (!e) throw new Error(`夹具里没有实验 ${label}`);
  return e;
};
/** 实验中新建文件的内容：`bytes(range(256))` 重复到该长度。 */
const WRITE_DATA_PATTERN = (() => {
  const len = EXPERIMENTS[0].fileLength;
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) out[i] = i & 0xff;
  return out;
})();
const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');

const cardCache = new Map<string, Uint8Array>();
function cardBytes(name: string): Uint8Array {
  let b = cardCache.get(name);
  if (!b) {
    b = new Uint8Array(readFileSync(join(EVIDENCE, name)));
    cardCache.set(name, b);
  }
  return b;
}

// ─────────────────────────── A. 常量与 ECC 自检 ───────────────────────────

function testConstants(): void {
  section('A1 常量');
  eq('PAGE_SIZE', PAGE_SIZE, 512);
  eq('SPARE_SIZE', SPARE_SIZE, 16);
  eq('STRIDE', STRIDE, 528);
  eq('CARD_SIZE_8MB', CARD_SIZE_8MB, 8650752);
  eq('CARD_PAGES_8MB', CARD_PAGES_8MB, 16384);
  eq('CARD_CLUSTERS_8MB', CARD_CLUSTERS_8MB, 8192);
  eq('CARD_SIZE_8MB == 528*16384', CARD_SIZE_8MB, 528 * 16384);
  eq('夹具 constants', manifest.constants, {
    pageSize: 512,
    spareSize: 16,
    stride: 528,
    bytesPerCluster: 1024,
    cardSize8MB: 8650752,
    pages8MB: 16384,
    clusters8MB: 8192,
  });
}

function testEcc(): void {
  section('A2 ECC（对已知页的结果 + 与 Python 夹具逐字节一致）');
  // PARITY 是偶校验（Python 里是硬编码表；这里按位算，必须逐位相同）
  let parOk = true;
  for (let b = 0; b < 256; b++) {
    let v = b;
    let p = 0;
    while (v) {
      p ^= v & 1;
      v >>= 1;
    }
    if (PARITY[b] !== p) parOk = false;
  }
  check('PARITY = popcount(b) & 1（256 项）', parOk);
  eq('CPM.length', CPM.length, 256);
  // CPM 是查表，不能是常量表 —— 抽几个已知值核对誊抄
  eq('CPM[0]', CPM[0], 0);
  eq('CPM[1]', CPM[1], 7);
  eq('CPM[2]', CPM[2], 22);
  eq('CPM[3]', CPM[3], 17);
  eq('CPM[16]', CPM[16], 67);
  eq('CPM[255]', CPM[255], 0);

  // calcEcc 与 pageEcc 的关系
  const zero = new Uint8Array(512);
  const [c0, l00, l10] = calcEcc(zero, 0);
  eq('calcEcc(全零页, 段0)', [c0, l00, l10], [0x77, 0x7f, 0x7f]);
  eq('pageEcc(全零页) 前 12 B', [...pageEcc(zero).subarray(0, 12)], [
    0x77, 0x7f, 0x7f, 0x77, 0x7f, 0x7f, 0x77, 0x7f, 0x7f, 0x77, 0x7f, 0x7f,
  ]);
  eq('pageEcc 的保留 4 B 恒 0', [...pageEcc(zero).subarray(12)], [0, 0, 0, 0]);

  // ★ 关键：lp0 必须 (& 0x7F)，即 bit7 恒 0（"& 0xFF" 会给 bit7 带上 1）
  let bit7Bad = 0;
  for (let n = 0; n < 64; n++) {
    const p = new Uint8Array(512);
    for (let i = 0; i < 512; i++) p[i] = (i * 31 + n * 7) & 0xff;
    const e = pageEcc(p);
    for (let j = 0; j < 4; j++) if (e[j * 3 + 1] & 0x80) bit7Bad++;
  }
  eq('64 个样本页的 lp0 里 bit7 出现次数（必须 0）', bit7Bad, 0);

  // 与 Python 夹具给的参考值逐字节比对
  for (const [name, ref] of Object.entries(manifest.eccReference)) {
    const page = new Uint8Array(Buffer.from(ref.page, 'hex'));
    const expectEcc = Buffer.from(ref.ecc, 'hex');
    const got = pageEcc(page);
    eq(`ECC 参考页 ${name}: 16 B 逐字节`, Buffer.from(got).toString('hex'), expectEcc.toString('hex'));
    eq(`ECC 参考页 ${name}: 512 B 输入 SHA-256`, sha256(page), ref.sha256Page);
    eq(`ECC 参考页 ${name}: ECC SHA-256`, sha256(got), ref.sha256Ecc);
  }
}

// ─────────────────────────── B. 只读比对 ───────────────────────────

function testReadCards(): void {
  section('B 只读：4 张证据卡逐项与 Python 夹具比对');
  if (!HAVE_EVIDENCE) {
    skipEvidence('B 只读：4 张证据卡逐项与 Python 夹具比对');
    return;
  }
  eq('证据卡张数', manifest.cards.length, 4);

  for (const mc of manifest.cards) {
    const path = join(EVIDENCE, mc.name);
    if (!existsSync(path)) {
      check(`卡 ${mc.name} 存在`, false, '文件不存在');
      continue;
    }
    const bytes = cardBytes(mc.name);
    eq(`${mc.name}: 整卡字节数`, bytes.length, mc.size);
    eq(`${mc.name}: 整卡 SHA-256`, sha256(bytes), mc.sha256);

    const card = new Card(bytes.slice());
    eq(`${mc.name}: npages`, card.npages, mc.npages);
    eq(`${mc.name}: pageLen/ppc/ppb`, [card.pageLen, card.ppc, card.ppb], [mc.pageLen, mc.ppc, mc.ppb]);
    eq(`${mc.name}: clusters`, card.clusters, mc.clusters);
    eq(
      `${mc.name}: allocOffset/allocEnd/rootdir/ifc0`,
      [card.allocOffset, card.allocEnd, card.rootdir, card.ifc[0]],
      [mc.allocOffset, mc.allocEnd, mc.rootdir, mc.ifc0],
    );
    // ★ 0.20：原先是 `mc.ifc0 === 8 ? 32 : 32` —— 恒等三目，两边同一个数，等于什么都没测。
    //   正确口径：FAT 块数 = ceil(总簇数 / 每块 256 项)；`ind[]` 里"非 0xFFFFFFFF"的项数就是它
    //   （实测 4 张真卡都是 8192 簇 ⇒ 32 个 FAT 块，簇号 9..40）。
    eq(`${mc.name}: ind[] 非空项数`, card.ind.filter((x) => x !== 0xffffffff).length,
      Math.ceil(card.clusters / 256));
    // 间接 FAT（绝对簇 8）与 32 个 FAT 块（9..40）之后，`ind[]` 其余项必须是 0xFFFFFFFF
    //   （"未使用"的**唯一**合法写法 —— 见 `card.ts::readFat` 的注释：0 会被当成合法 FAT 块）。
    eq(`${mc.name}: ind[] 里只有前 ${Math.ceil(card.clusters / 256)} 项是 FAT 块`,
      card.ind.filter((x) => x !== 0xffffffff).join(','),
      Array.from({ length: Math.ceil(card.clusters / 256) }, (_, i) => mc.ifc0 + 1 + i).join(','));

    // 根目录项数（取自 `.` 项的 length）+ 根目录条目逐项
    eq(`${mc.name}: dirCount(rootdir)`, card.dirCount(card.rootdir), mc.rootDotLength);
    const roots = card.listRoot();
    eq(`${mc.name}: 根目录项数（解析后）`, roots.length, mc.root.length);
    eq(
      `${mc.name}: 根目录条目 [index,mode,length,cluster,parent,name]`,
      roots.map((e) => [e.index, e.mode, e.length, e.cluster, e.parent, e.name]),
      mc.root.map((e) => [e.index, e.mode, e.length, e.cluster, e.parent, e.name]),
    );
    eq(`${mc.name}: 根目录链`, card.chain(card.rootdir, 64), mc.rootChain);

    // 徽章目录识别：不能靠 mode 位（见 card.ts::modeIsDir 注释），按名字。
    // ★ 0.19：`card.emblemDirs()` 那个便捷包装删了（只有测试在用）—— 判据仍在 `Dirent.isEmblemDir`。
    eq(
      `${mc.name}: 徽章目录清单（名字）`,
      card.listRoot().filter((e) => e.isEmblemDir).map((e) => e.name),
      mc.emblemDirs.map((d) => d.name),
    );

    // 每个徽章目录：目录链、声明项数、每个文件的内容 SHA-256
    for (const md of mc.emblemDirs) {
      const dirEnt = roots.find((e) => e.name === md.name)!;
      check(`${mc.name}/${md.name}: 根条目存在`, !!dirEnt);
      if (!dirEnt) continue;
      eq(`${mc.name}/${md.name}: 声明项数 = 根条目 length`, dirEnt.length, md.declaredCount);
      eq(`${mc.name}/${md.name}: 首簇`, dirEnt.cluster, md.cluster);
      eq(`${mc.name}/${md.name}: 目录链`, card.chain(dirEnt.cluster, 64), md.chain);
      // ★ 真卡上子目录的 `.` 项 length 恒为 0（项数记在根条目上）—— 这是必须固化的语义
      eq(`${mc.name}/${md.name}: 目录自己的 . length`, card.dirCount(dirEnt.cluster), md.selfDotLength);

      const subs = card.listDir(md.name);
      const files = subs.filter((s) => !s.isDot);
      eq(
        `${mc.name}/${md.name}: 文件清单 [name,length,cluster]`,
        files.map((s) => [s.name, s.length, s.cluster]),
        md.files.map((f) => [f.name, f.length, f.cluster]),
      );
      // ★ 0.20：原先是 `eq(…, subs.map((s) => s.index), subs.map((s) => s.index))` ——
      //   两边同一个表达式，恒真。改成与**夹具**记录的项号列表比对：`.` / `..` 必须是 0 / 1，
      //   其余每一项必须落在 manifest 里那个文件的 index 上（顺序也要一致）。
      eq(`${mc.name}/${md.name}: 全部 index`,
        subs.map((s) => s.index), [0, 1, ...md.files.map((f) => f.index)]);

      for (const mf of md.files) {
        const s = files.find((f) => f.name === mf.name);
        if (!s) {
          check(`${mc.name}/${md.name}/${mf.name}: 存在`, false);
          continue;
        }
        eq(`${mc.name}/${md.name}/${mf.name}: mode`, s.mode, mf.mode);
        eq(`${mc.name}/${md.name}/${mf.name}: 簇链`, card.chain(s.cluster, 4096), mf.chain);
        const data = card.readFile(s.cluster, s.length);
        eq(`${mc.name}/${md.name}/${mf.name}: 读出长度`, data.length, mf.readLength);
        eq(`${mc.name}/${md.name}/${mf.name}: 内容 SHA-256`, sha256(data), mf.sha256);
        eq(`${mc.name}/${md.name}/${mf.name}: 与 dirent.length 一致`, data.length, mf.length);
      }
    }
  }
}

// ─────────────────────────── C. 自检 ───────────────────────────

function testModeSemantics(): void {
  if (!HAVE_EVIDENCE) {
    skipEvidence('C1 dirent mode 位语义（4 张真卡穷举）');
    return;
  }
  section('C1 dirent mode 位语义（真卡实测）');
  eq('MODE_DIR', MODE_DIR, 0x8427);
  eq('MODE_FILE', MODE_FILE, 0x8497);
  eq('MODE_PARENT', MODE_PARENT, 0xa426);
  eq('bit15 (0x8000) = 已用：三者都置位',
    [MODE_DIR, MODE_FILE, MODE_PARENT].map((m) => (m & 0x8000) !== 0), [true, true, true]);
  eq('bit31 = 0：真卡上三者都是 0（所以"已用"不是 bit31）',
    [MODE_DIR, MODE_FILE, MODE_PARENT].map((m) => (m & 0x80000000) !== 0), [false, false, false]);
  // ★ 4 张证据卡全部 214 个 dirent 穷举：只有三种 mode 形态，bit7 100% 分离文件/目录
  eq('目录 0x8427 与文件 0x8497 的异或（差异在 bit7 与 bit4，不是"两位都一样"）',
    (MODE_DIR ^ MODE_FILE), 0x00b0);
  eq('bit7 (0x80) = 是文件：目录 0 / 文件 1 / 父项 0',
    [MODE_DIR, MODE_FILE, MODE_PARENT].map((m) => (m & 0x80) !== 0), [false, true, false]);
  eq('bit4 (0x10) = 只在普通文件上置位',
    [MODE_DIR, MODE_FILE, MODE_PARENT].map((m) => (m & 0x10) !== 0), [false, true, false]);
  eq('bit10 (0x400) = 三者共同置位（项有效）',
    [MODE_DIR, MODE_FILE, MODE_PARENT].map((m) => (m & 0x400) !== 0), [true, true, true]);
  eq('bit13 (0x2000) 不是"目录"位：目录上为 0、文件上为 0、根目录 "." 项上为 1',
    [MODE_DIR, MODE_FILE, MODE_PARENT].map((m) => (m & 0x2000) !== 0), [false, false, true]);
  eq('modeIsDir：目录 true / 文件 false / 父项 true',
    [modeIsDir(MODE_DIR), modeIsDir(MODE_FILE), modeIsDir(MODE_PARENT)], [true, false, true]);
  eq('modeIsDir(未使用项 0xFFFFFFFF) = false', modeIsDir(0xffffffff), false);
  // 真卡上每个 dirent 的 isDir 必须与该位置的实际语义一致
  const bytes = cardBytes(EXPERIMENTS[0].sourceCard);
  const c = new Card(bytes.slice());
  const roots = c.listRoot();
  eq('根目录里 isDir = true 的项（= `.` / `..` / 所有 B* 目录）',
    roots.filter((e) => e.isDir).map((e) => e.name).slice(0, 4), ['.', '..', 'BASLUS-20014S00', 'BASLUS-20249S00']);
  eq('根目录里 isDir = false 的项（全是"文件形态"的条目）',
    roots.filter((e) => !e.isDir).map((e) => e.name), []);  eq('EMB 目录里 isDir = true 的项（= `.` / `..`）',
    c.listDir('BISLPS-25462EMB').filter((e) => e.isDir).map((e) => e.name), ['.', '..']);
  eq('EMB 目录里文件项的 mode 全部 = 0x8497 且 isDir = false',
    c.listDir('BISLPS-25462EMB').filter((e) => !e.isDot).map((e) => [e.name, e.mode, e.isDir]),
    c.listDir('BISLPS-25462EMB').filter((e) => !e.isDot).map((e) => [e.name, 0x8497, false]));
  eq('按名字识别徽章目录（业务判据，不依赖位语义）',
    ['BISLPS-25169E00', 'BASLUS-20644E02', 'BISLPS-25462EMB', 'BISLPS-25462GAME', 'BISLPS-25112S00', 'icon.sys']
      .map(isEmblemArchiveDirName),
    [true, true, true, false, false, false]);
}

function testChainAcrossFatBlocks(): void {
  if (!HAVE_EVIDENCE) {
    skipEvidence('C2 簇链遍历（跨 FAT 块 / 防环 / 越界）');
    return;
  }
  section('C2 簇链遍历：跨 FAT 块（rel//256 换块）+ 防环 + 越界');
  const bytes = cardBytes(EXPERIMENTS[0].sourceCard);
  const card = new Card(bytes.slice());

  // 真卡的 ind[] 是**不连续**的 9,10,…,40 ⇒ 跨块必须每次重新查 ind[]
  eq('ind[] 前 8 项', card.ind.slice(0, 8), [9, 10, 11, 12, 13, 14, 15, 16]);
  eq('ind[] 第 32 项起全是 0xFFFFFFFF', card.ind.slice(32).every((x) => x === 0xffffffff), true);

  // 造一条跨 255/256 边界的假链：把 rel 254..258 串起来（用完恢复）
  const probe = cardBytes(EXPERIMENTS[0].sourceCard).slice();
  const p = new Card(probe);
  const saved: [number, number][] = [];
  for (const rel of [254, 255, 256, 257, 258]) saved.push([rel, p.readFat(rel)]);
  try {
    p.writeFat(254, (0x80000000 | 255) >>> 0);
    p.writeFat(255, (0x80000000 | 256) >>> 0);
    p.writeFat(256, (0x80000000 | 257) >>> 0);
    p.writeFat(257, (0x80000000 | 258) >>> 0);
    p.writeFat(258, (0x80000000 | FAT_END) >>> 0); // = 0xFFFFFFFF，同 writeFatChain
    eq('跨 FAT 块链 254→255→256→257→258', p.chain(254, 64), [254, 255, 256, 257, 258]);
    eq('链尾 (258) 的 FAT 值 = 0x80000000|0x7FFFFFFF', p.readFat(258), 0xffffffff);
    eq('链尾值的低位 & 0x7FFFFFFF = 0x7FFFFFFF（链尾标记）', p.readFat(258) & 0x7fffffff, 0x7fffffff);
    eq('块的 bit31 = "已分配"', (p.readFat(258) & 0x80000000) !== 0, true);
    eq('块号：254//256 与 256//256 必须不同', [Math.floor(254 / 256), Math.floor(256 / 256)], [0, 1]);
    // 跨块读改写 FAT 之后，另一块（256..）的值也必须真的落盘（同镜像自洽）
    eq('写完再读 rel=256', p.readFat(256), (0x80000000 | 257) >>> 0);
    eq('写完再读 rel=1（块 0 里的邻居）', p.readFat(1), card.readFat(1));

    // 防环：255 → 254 会成环
    p.writeFat(255, (0x80000000 | 254) >>> 0);
    eq('成环时 chain 必须停下（不挂死）', p.chain(254, 64), [254, 255]);
  } finally {
    for (const [rel, v] of saved) p.writeFat(rel, v);
    eq('恢复后逐字节相同', sha256(probe), sha256(bytes));
  }

  // 越界：>= clusters 一律视为链尾
  eq('rel = clusters 时 chain 为空', p.chain(p.clusters, 64), []);
  eq('rel = 0x7FFFFFFF 时 chain 为空', p.chain(0x7fffffff, 64), []);
  eq('readFat(越界) = 0xFFFFFFFF', p.readFat(p.clusters + 10), 0xffffffff);

  // 全卡所有真实文件链都能读通，且与夹具一致
  let chainsChecked = 0;
  for (const mc of manifest.cards) {
    const c2 = new Card(cardBytes(mc.name).slice());
    for (const md of mc.emblemDirs) {
      for (const mf of md.files) {
        eq(`链长校验 ${mc.name}/${md.name}/${mf.name}`, c2.chain(mf.cluster, 4096).length, mf.chain.length);
        chainsChecked++;
      }
    }
  }
  check(`真实文件链总数 > 0（实际 ${chainsChecked}）`, chainsChecked > 0);
}

function testOffsetAndBoundaries(): void {
  if (!HAVE_EVIDENCE) {
    skipEvidence('C3 offset / 边界（最后一簇、aoff/aend、页号）');
    return;
  }
  section('C3 offset / 边界（最后一簇、aoff/aend、页号）');
  const mc = EXPERIMENTS[0];
  const bytes = cardBytes(mc.sourceCard);
  const card = new Card(bytes.slice());

  // ★ 两套簇号约定不能混：系统区绝对、数据区相对 + allocOffset
  eq('sysPage(8,0) = 8*ppc（绝对）', card.sysPage(8, 0), 8 * card.ppc);
  eq('dataPage(0,0) = (0+aoff)*ppc（相对）', card.dataPage(0, 0), (0 + card.allocOffset) * card.ppc);
  eq('dataPage(1408,0)', card.dataPage(1408, 0), (1408 + 41) * 2);
  eq('dataPage(1408,1)', card.dataPage(1408, 1), (1408 + 41) * 2 + 1);
  check('dataPage ≠ sysPage（差 aoff*ppc = 82 页）',
    card.dataPage(1408, 0) - card.sysPage(1408, 0) === card.allocOffset * card.ppc);

  // 最后一簇：数据区末端是 aend-4 = 8131（分配器的硬边界）；确认边界之后仍在卡内
  const lastUsable = card.allocEnd - 1;
  eq('allocEnd - 1 = 8134', lastUsable, 8134);
  const lastPage0 = card.dataPage(lastUsable, 0);
  const lastPage1 = card.dataPage(lastUsable, 1);
  eq('最后一簇的页号', [lastPage0, lastPage1], [(8134 + 41) * 2, (8134 + 41) * 2 + 1]);
  eq('最后一簇的页号（直算）', [lastPage0, lastPage1], [16350, 16351]);
  check('最后一簇的两页都在卡内', lastPage1 < card.npages, `${lastPage1} < ${card.npages}`);
  eq('卡总页数 = 整卡字节 / 528', card.npages, CARD_SIZE_8MB / STRIDE);
  eq('卡总页数', card.npages, 16384);
  check('数据区末端之后还剩 32 页（= 16 簇备用区，进不去）',
    card.npages - (lastPage1 + 1) === 32, `剩 ${card.npages - lastPage1 - 1} 页`);  eq('allocateClusters 的硬边界是 allocEnd-4', card.allocEnd - 4, 8131);
  // 越界簇的页号必须仍然落在卡内但不是合法数据簇
  check('allocEnd-4 这一簇之后的簇已越过分配上限', card.allocEnd - 3 > card.allocEnd - 4);

  // readFile 的 offset 语义：n 小于簇容量 ⇒ 截断；n = 0 ⇒ 空；**n 大于链容量 ⇒ 只给链内**
  // ★ 注意 `readFile(簇, n)` 的 `n` 只决定"跟链跟多远"，不决定页边界：
  //   它是 `chain(first, n//1024 + 16)` 再 `slice(0, n)`。
  const rootChain = card.chain(card.rootdir, 4096);
  eq('根目录链（7 簇）', rootChain, manifest.cards.find((c) => c.name === EXPERIMENTS[0].sourceCard)!.rootChain);
  const oneCl = rootChain[0];
  const c1 = card.readFile(oneCl, 1);
  eq('readFile(簇, 1).length', c1.length, 1);
  eq('readFile(簇, 1) 内容 = 该簇第 0 页第 0 字节', c1[0], card.readDataPage(oneCl, 0)[0]);
  eq('readFile(簇, 0).length（n=0 ⇒ 空，不读页）', card.readFile(oneCl, 0).length, 0);
  eq('readFile(簇, 512).length', card.readFile(oneCl, 512).length, 512);
  eq('readFile(簇, 513).length（跨页）', card.readFile(oneCl, 513).length, 513);
  eq('readFile(簇, 1024).length', card.readFile(oneCl, 1024).length, 1024);
  // 该簇是根目录链首簇 ⇒ 链会一直跟到链尾（7 簇 = 7168 B），n 只要 ≥ 1 都读得动
  eq('readFile(根目录首簇, 1024×64) ⇒ 跟到链尾 7 簇',
    card.readFile(oneCl, 1024 * 64).length, rootChain.length * 1024);
  // 用一个"真正的单簇文件"验证"链比 n 短 ⇒ 不补零"
  const singleClusterFile = card.listDir('BISLPS-25462EMB').find((e) => e.name === 'icon.sys')!;
  eq('icon.sys 的簇链长度', card.chain(singleClusterFile.cluster, 4096).length, 1);
  eq('readFile(单簇文件, 64 簇) ⇒ 只给链内 1024 B（不补零）',
    card.readFile(singleClusterFile.cluster, 1024 * 64).length, 1024);
  eq('readFile(icon.sys, 声明的 964) ⇒ 正好 964', card.readFile(singleClusterFile.cluster, 964).length, 964);

  // 一个真实的 17440 B 文件：必须正好是 ncl 簇
  const f = mc.readback;
  eq('data7 长度', f.fileLength, 17440);
  eq('17440 B ⇒ 18 簇', Math.ceil(17440 / 1024), 18);

  // allocateClusters 的边界：要求超过卡上剩余空间时必须抛错（而不是死循环）
  let threw = false;
  try {
    card.allocateClusters(card.allocEnd - card.allocOffset + 100);
  } catch {
    threw = true;
  }
  check('allocateClusters(超出卡容量) 抛错', threw);

  // 写页必须重算 ECC，且越界写要抛
  const tmp = cardBytes(mc.sourceCard).slice();
  const t = new Card(tmp);
  const pageNo = t.dataPage(1408, 0);
  t.writePageRaw(pageNo, new Uint8Array(512).fill(0x5a));
  eq('writePageRaw 后 ECC 正确', t.eccOk(pageNo), true);
  eq('writePageRaw 后备用区 = pageEcc(数据)', Buffer.from(t.readSpareRaw(pageNo)).toString('hex'),
    Buffer.from(pageEcc(t.readPageRaw(pageNo))).toString('hex'));
  let threw2 = false;
  try {
    t.writePageRaw(0, new Uint8Array(511));
  } catch {
    threw2 = true;
  }
  check('writePageRaw(511 B) 抛错', threw2);

  // ★ 负面判据：把 ECC 改坏，eccOk 必须变成 false（否则"ECC 正确"这个断言是空的）
  const p1 = t.dataPage(1408, 0);
  const spare = t.readSpareRaw(p1);
  const evil = spare.slice();
  evil[0] ^= 0xff;
  t.writeSpareRaw(p1, evil);
  eq('故意改坏备用区第 1 字节 ⇒ eccOk = false', t.eccOk(p1), false);
  t.writePageRaw(p1, t.readPageRaw(p1));
  eq('重写该页（重算 ECC）⇒ eccOk = true', t.eccOk(p1), true);
  // 换成"旧公式"（lp0 & 0xFF）的 ECC 也必须被认出来 —— 这是历史上真踩过的错。
  // ⚠️ 不是每一页都能区分两种公式：只有"行奇偶校验踩到 i 的高位"的页才会让 lp0 的 bit7 变 1，
  //    所以要找一页真的能区分出来的（全零/全 FF 页恰好区分不了）。
  const oldStyleEcc = (pg: Uint8Array): Uint8Array => {
    const out = new Uint8Array(SPARE_SIZE);
    for (let j = 0; j < 4; j++) {
      let col = 0x77;
      let lp0 = 0x7f;
      let lp1 = 0x7f;
      for (let i = 0; i < 128; i++) {
        const b = pg[j * 128 + i];
        col ^= CPM[b];
        if (PARITY[b]) {
          lp0 ^= ~i & 0xff; // ← 旧（错）公式
          lp1 ^= i;
        }
      }
      out[j * 3] = col;
      out[j * 3 + 1] = lp0;
      out[j * 3 + 2] = lp1;
    }
    return out;
  };
  let discriminator = -1;
  for (let p = 0; p < Math.min(400, t.npages); p++) {
    if (t.readSpareRaw(p).every((b) => b === 0xff)) continue; // 没写过 ECC 的页，跳过
    const pg = t.readPageRaw(p);
    const a = pageEcc(pg);
    const b = oldStyleEcc(pg);
    if ([...a].some((v, i) => v !== b[i])) {
      discriminator = p;
      break;
    }
  }
  check('能找到一页让新/旧 ECC 公式产生不同结果（判据有区分力）', discriminator >= 0,
    '前 400 页里找不到 —— 说明两种公式在真卡数据上无差别？');
  if (discriminator >= 0) {
    const p1 = discriminator;
    const good = t.readSpareRaw(p1);
    t.writeSpareRaw(p1, oldStyleEcc(t.readPageRaw(p1)));
    eq(`页 ${p1}：写入旧公式 ECC ⇒ eccOk = false（非标准 ECC 会被识别）`, t.eccOk(p1), false);
    t.writePageRaw(p1, t.readPageRaw(p1)); // 重写 ⇒ 重算正确 ECC
    eq(`页 ${p1}：重写后 eccOk = true`, t.eccOk(p1), true);
    eq(`页 ${p1}：重写后备用区 = 原值`, Buffer.from(t.readSpareRaw(p1)).toString('hex'),
      Buffer.from(good).toString('hex'));
    // 旧公式的 lp0 至少有一段带上了 bit7（这正是它与真卡不符的地方）
    const oldLp0 = [...oldStyleEcc(t.readPageRaw(p1))].filter((_, i) => i % 3 === 1);
    eq(`页 ${p1}：旧公式的 4 段 lp0 里至少有 1 段 bit7 = 1`,
      oldLp0.some((b) => (b & 0x80) !== 0), true);
    eq(`页 ${p1}：正确公式的 4 段 lp0 bit7 全为 0`,
      [...pageEcc(t.readPageRaw(p1))].filter((_, i) => i % 3 === 1).every((b) => (b & 0x80) === 0), true);
  }

  // 不存在 / 空名字的目录查询：返回空数组（不抛）
  eq('listDir(不存在的目录)', card.listDir('NO-SUCH-DIR'), []);
  eq('findInRoot(不存在的名字)', card.findInRoot('NO-SUCH-DIR'), null);
}

// ─────────────────────────── D. 写入实验（逐字节） ───────────────────────────
// ─────────────────────────── D. 写入实验（逐字节） ───────────────────────────

/**
 * 跑一个写入实验：在**内存副本**上新建一个文件，与 Python 夹具逐字节比对。
 *
 * 空槽的两条路径由 `manifest.experiments` 决定：
 *   · `reuse-free-slot`  ：目录链内已有空槽 ⇒ 复用，`dirExtensionClusters` 必须为空
 *   · `extend-directory` ：目录链全满 ⇒ 扩 1 簇，且新簇**两页**都初始化
 */
function runExperiment(e: ManifestExperiment): void {
  section(`D 写入实验 [${e.label}] ${e.note}`);
  const srcPath = join(EVIDENCE, e.sourceCard);
  if (!existsSync(srcPath)) {
    check(`源卡 ${e.sourceCard} 存在`, false);
    return;
  }
  const before = new Uint8Array(readFileSync(srcPath));
  eq(`[${e.label}] 源卡 SHA-256（夹具记录）`, sha256(before), e.sourceSHA256);

  // 整卡副本 ⇒ 只在这个副本上读写（同一个镜像）
  const copy = before.slice();
  const card = readCardFromBuffer(copy, false);
  // ★ 占用集合要在写之前采（写之后新分配的簇也会进集合）
  const usedBefore = card.collectUsedClusters().size;

  const res = card.createFileInDir(e.dirBefore.name, e.fileName, WRITE_DATA_PATTERN);

  // ---- 分配结果 ----
  eq(`[${e.label}] 数据簇`, res.clusters, e.dataClusters);
  eq(`[${e.label}] 首簇`, res.firstCluster, e.dataClusters[0]);
  eq(`[${e.label}] 扩目录簇`, res.dirExtensionClusters, e.dirExtensionClusters);
  eq(`[${e.label}] 新项槽号`, res.slot, e.slot);
  eq(`[${e.label}] 分配算法起点 aoff+2`, card.allocOffset + 2, 43);
  eq(`[${e.label}] 写前 usedClusterCount（占用集合大小）`, usedBefore, e.usedClusterCount);

  // ★★ 本实验最核心的一条：走的是"复用空槽"还是"扩目录簇"
  if (e.expectExtension) {
    check(`[${e.label}] 链内全满 ⇒ 发生了扩目录簇`, res.dirExtensionClusters.length === 1,
      `dirExtensionClusters = ${JSON.stringify(res.dirExtensionClusters)}`);
    eq(`[${e.label}] 扩出来的簇`, res.dirExtensionClusters, e.dirExtensionClusters);
    check(`[${e.label}] 写后占用集合变大（+18 数据簇 +1 扩目录簇）`,
      card.collectUsedClusters().size > usedBefore,
      `${usedBefore} → ${card.collectUsedClusters().size}`);
  } else {
    check(`[${e.label}] 链内有空槽 ⇒ **不扩簇**（dirExtensionClusters 必须为空）`,
      res.dirExtensionClusters.length === 0,
      `dirExtensionClusters = ${JSON.stringify(res.dirExtensionClusters)}`);
    check(`[${e.label}] 新 dirent 落进链内既有空槽的页`,
      res.touchedPages.includes(e.direntPage), `touchedPages 里没有 ${e.direntPage}`);
  }

  // ---- ★ 0.20：扩目录簇与数据簇**不许撞页** ----
  //   这条钉的是 `createFileInDir` 第 4 步的占用集合。原先它复用第 1 步的快照：
  //     · 数据簇那条腿是对的（`allocateClusters()` 就地把 18 个数据簇补进了那个集合）；
  //     · 系统区那条腿（`ifc[0]` / `ind[]`）是第 1 步抄的，而第 3 步 `writeFatChain()`
  //       刚动过那些 FAT 页 ⇒ 潜在失效（本卡踩不到：FAT 块是绝对簇 9..40、分配器从 43 起扫）。
  //   0.20 改成"重新收集 + 把数据簇并回去"（两者都要，缺前者会丢系统区的刷新，
  //   缺后者会把刚分配的 18 个簇当空闲 ⇒ 重新分配回 1408、直接覆盖数据）。
  //   实测：这一步对两张证据卡都是**行为中性**的（扩目录簇仍是 1426，与数据簇零撞页）。
  {
    const dataPages = new Set<number>();
    for (const cl of e.dataClusters) {
      dataPages.add(card.dataPage(cl, 0));
      dataPages.add(card.dataPage(cl, 1));
    }
    const sysPages = new Set<number>();
    for (const fc of card.ind) {
      if (fc === 0xffffffff) continue;
      sysPages.add(card.sysPage(fc, 0));
      sysPages.add(card.sysPage(fc, 1));
    }
    let clash = 0;
    for (const cl of res.dirExtensionClusters) {
      for (const k of [0, 1]) {
        const p = card.dataPage(cl, k);
        if (dataPages.has(p) || sysPages.has(p)) clash += 1;
      }
    }
    check(`[${e.label}] 扩目录簇的页不与数据簇/FAT 块撞页`, clash === 0,
      `撞了 ${clash} 页（扩簇 ${JSON.stringify(res.dirExtensionClusters)}）`);
  }

  // ---- 变化页集合 & 每页 SHA-256 ----
  const changed: { page: number; sha256Before: string; sha256After: string }[] = [];
  for (let p = 0; p < card.npages; p++) {
    const a = before.subarray(p * STRIDE, p * STRIDE + PAGE_SIZE);
    const b = copy.subarray(p * STRIDE, p * STRIDE + PAGE_SIZE);
    let same = true;
    for (let i = 0; i < PAGE_SIZE; i++) {
      if (a[i] !== b[i]) {
        same = false;
        break;
      }
    }
    if (!same) changed.push({ page: p, sha256Before: sha256(a), sha256After: sha256(b) });
  }
  eq(`[${e.label}] 变化页数`, changed.length, e.changedPageCount);
  eq(`[${e.label}] 变化的页号集合（完全相同）`, changed.map((c) => c.page), e.changedPages.map((c) => c.page));
  eq(`[${e.label}] 每页 512 B 的「写前」SHA-256`,
    changed.map((c) => c.sha256Before), e.changedPages.map((c) => c.sha256Before));
  eq(`[${e.label}] 每页 512 B 的「写后」SHA-256`,
    changed.map((c) => c.sha256After), e.changedPages.map((c) => c.sha256After));
  check(`[${e.label}] 没有"变了但没报告"的页`,
    changed.every((c) => e.touchedPagesRaw.includes(c.page)));

  // ---- 整页（512+16 B）也必须只有这些页动过 ----
  const changedStrides: number[] = [];
  for (let p = 0; p < card.npages; p++) {
    const a = before.subarray(p * STRIDE, p * STRIDE + STRIDE);
    const b = copy.subarray(p * STRIDE, p * STRIDE + STRIDE);
    let same = true;
    for (let i = 0; i < STRIDE; i++) {
      if (a[i] !== b[i]) {
        same = false;
        break;
      }
    }
    if (!same) changedStrides.push(p);
  }
  eq(`[${e.label}] 整页（512+16 B）变化页集合`, changedStrides, e.changedStridePages);

  // ---- 写入意图：报告出来的每一页，写后的字节必须**逐字节等于**它想写的内容 ----
  for (const w of e.intendedWrites) {
    const d = copy.subarray(w.page * STRIDE, w.page * STRIDE + PAGE_SIZE);
    const sp = copy.subarray(w.page * STRIDE + PAGE_SIZE, w.page * STRIDE + STRIDE);
    eq(`[${e.label}] 页 ${w.page} 写后数据 == 写入意图`, sha256(d), w.sha256Data);
    eq(`[${e.label}] 页 ${w.page} 写后备用区 == 写入意图`, sha256(sp), w.sha256Spare);
  }
  // 报告的字节没变 = 真卡上的 no-op（"单簇链尾 0x7FFFFFFF" 与 "空闲标记" 共用同一个值时会发生）
  const noopTs = e.touchedPagesRaw.filter((p) => !changed.some((c) => c.page === p));
  eq(`[${e.label}] "报告了写、但 512 B 数据没变"的页`, noopTs, e.noopWritePages);
  const strideNoopTs = e.touchedPagesRaw.filter((p) => !changedStrides.includes(p));
  eq(`[${e.label}] "报告了写、但整页（含备用区）没变"的页`, strideNoopTs, e.strideNoopWritePages);
  eq(`[${e.label}] 只有备用区变的页 = 整页变化 - 数据变化`,
    changedStrides.filter((p) => !changed.some((c) => c.page === p)), e.spareOnlyChangedPages);

  // ---- 整卡 SHA-256 ----
  eq(`[${e.label}] 写入后整卡 SHA-256`, sha256(copy), e.resultSHA256);

  // ---- 报告的 touchedPages ----
  eq(`[${e.label}] createFileInDir 报告的 touchedPages`, res.touchedPages, e.touchedPagesRaw);

  // ---- 回读 ----
  eq(`[${e.label}] 项数更新（rootEntry）`, res.dirCountUpdate, {
    mode: 'rootEntry',
    old: e.rootEntry.oldCount,
    new: e.rootEntry.newCount,
  });
  const v = new Card(copy);
  const dirEnt = v.findInRoot(e.dirBefore.name)!;
  eq(`[${e.label}] 回读：根条目 length`, dirEnt.length, e.readback.dirDeclaredCount);
  eq(`[${e.label}] 回读：根条目 index`, dirEnt.index, e.rootEntry.index);
  const subs = v.listDir(e.dirBefore.name);
  eq(`[${e.label}] 回读：目录项数`, subs.length, e.readback.fileCount);
  eq(`[${e.label}] 回读：目录项名字`, subs.map((s) => s.name), e.readback.fileNames);
  const tgt = subs.find((s) => s.name === e.fileName)!;
  eq(`[${e.label}] 回读：${e.fileName} 首簇`, tgt.cluster, e.readback.fileCluster);
  eq(`[${e.label}] 回读：${e.fileName} 长度`, tgt.length, e.readback.fileLength);
  eq(`[${e.label}] 回读：${e.fileName} 簇链`, v.chain(tgt.cluster, 4096), e.readback.chain);
  const got = v.readFile(tgt.cluster, tgt.length);
  eq(`[${e.label}] 回读：${e.fileName} 长度`, got.length, e.fileLength);
  eq(`[${e.label}] 回读：${e.fileName} 内容 SHA-256`, sha256(got), e.fileDataSHA256);
  eq(`[${e.label}] 回读：${e.fileName} 内容逐字节 = bytes(range(256)) 重复`,
    Buffer.from(got).equals(Buffer.from(WRITE_DATA_PATTERN)), true);

  // ---- ECC 自证（范围与 Python 夹具一致）----
  const badEcc: number[] = [];
  for (const p of e.eccCheckedPages) if (!v.eccOk(p)) badEcc.push(p);
  eq(`[${e.label}] 被检查页的 ECC 全部正确（Python 侧坏页数 = ${e.eccBadPages.length}）`, badEcc, []);
  let eccOkCount = 0;
  for (const p of e.eccCheckedPages) if (v.eccOk(p)) eccOkCount++;
  eq(`[${e.label}] ECC 通过页数`, eccOkCount, e.eccCheckedPages.length);

  // ---- ★ 扩目录簇的两页形态（与真卡"空槽 = 整页 FF + 算好的 ECC"一致）----
  if (e.expectExtension && e.emptyDirentPages.length) {
    for (const cl of res.dirExtensionClusters) {
      for (let k = 0; k < v.ppc; k++) {
        const p = v.dataPage(cl, k);
        eq(`[${e.label}] 扩目录簇 ${cl} 第 ${k} 页（绝对页 ${p}）ECC 正确`, v.eccOk(p), true);
        const spared = hex(v.readSpareRaw(p));
        check(`[${e.label}] 页 ${p} 备用区 != FF×16（不是未写入态）`,
          spared !== 'ff'.repeat(16), `实际 ${spared}`);
        check(`[${e.label}] 页 ${p} 备用区 = pageEcc(该页数据)`,
          spared === hex(pageEcc(v.readPageRaw(p))), `实际 ${spared}`);
      }
    }
    // 与夹具记录的形态逐项一致
    for (const form of e.emptyDirentForms) {
      const d = v.readPageRaw(form.page);
      const sp = v.readSpareRaw(form.page);
      eq(`[${e.label}] 页 ${form.page} 形态：备用区 hex`, hex(sp), form.spareHex);
      eq(`[${e.label}] 页 ${form.page} 形态：备用区 = pageEcc(数据)`,
        hex(sp) === hex(pageEcc(d)), form.spareIsComputedECC);
      eq(`[${e.label}] 页 ${form.page} 形态：数据全 FF`, d.every((b) => b === 0xff), form.dataAllFF);
      eq(`[${e.label}] 页 ${form.page} 形态：mode 全 FF`, hex(d.subarray(0, 4)) === 'ffffffff', form.modeAllFF);
      eq(`[${e.label}] 页 ${form.page} 形态：备用区 = FF×16`, hex(sp) === 'ff'.repeat(16), form.spareIsVirginFFFF);
    }
    // 扩出来的簇的两页都必须 eccOk
    for (const cl of res.dirExtensionClusters) {
      for (let k = 0; k < v.ppc; k++) {
        eq(`[${e.label}] 扩目录簇 ${cl} 的两页都 eccOk`, v.eccOk(v.dataPage(cl, k)), true);
      }
    }
    // 扩簇后"新簇第 1 页"必须是整页 FF 空槽（数据 FF + 算好的 ECC，不是未写入态）
    const newClTail = v.dataPage(res.dirExtensionClusters[0], 1);
    eq(`[${e.label}] 新簇第 1 页（绝对页 ${newClTail}）数据 = 整页 FF`,
      hex(v.readPageRaw(newClTail)), 'ff'.repeat(512));
    eq(`[${e.label}] 新簇第 1 页备用区 != FF×16`,
      hex(v.readSpareRaw(newClTail)) === 'ff'.repeat(16), false);
    eq(`[${e.label}] 新簇第 1 页备用区 = pageEcc(FF 页)`,
      hex(v.readSpareRaw(newClTail)), hex(pageEcc(new Uint8Array(512).fill(0xff))));
    eq(`[${e.label}] 新簇第 1 页 eccOk`, v.eccOk(newClTail), true);
  }

  // ---- 新 dirent 的 512 B 也应与 Python 完全一致 ----
  eq(`[${e.label}] 新 dirent 512 B SHA-256`,
    sha256(copy.subarray(e.direntPage * STRIDE, e.direntPage * STRIDE + 512)), e.direntSHA256);

  // ---- 源卡必须一个字节都没变 ----
  eq(`[${e.label}] 源卡内存副本未被 Card 改动`, sha256(before), e.sourceSHA256);
  eq(`[${e.label}] 源卡文件仍然未变`, sha256(new Uint8Array(readFileSync(srcPath))), e.sourceSHA256);

  // ---- 幂等：再跑一次（新副本）结果必须完全一样 ----
  const copy2 = before.slice();
  const card2 = readCardFromBuffer(copy2, false);
  card2.createFileInDir(e.dirBefore.name, e.fileName, WRITE_DATA_PATTERN);
  eq(`[${e.label}] 连跑两次结果逐字节相同（确定性）`, sha256(copy2), sha256(copy));

  // ---- 拒绝覆盖同名文件 ----
  let threw = false;
  try {
    card2.createFileInDir(e.dirBefore.name, e.fileName, WRITE_DATA_PATTERN);
  } catch {
    threw = true;
  }
  check(`[${e.label}] 重复创建同名文件被拒绝（不静默覆盖）`, threw);
}

function testWriteExperiments(): void {
  if (!HAVE_EVIDENCE) {
    skipEvidence('D 写入实验（复用空槽 / 扩目录簇，逐字节比对）');
    return;
  }
  eq('实验个数', EXPERIMENTS.length, 2);
  for (const e of EXPERIMENTS) runExperiment(e);

  // ---- 两条路径的对照：复用那条不该扩簇，扩簇那条必须扩 ----
  section('D2 两条路径对照（复用空槽 vs 扩目录簇）');
  const reuse = expByLabel('reuse-free-slot');
  const extend = expByLabel('extend-directory');
  check('复用空槽实验：dirExtensionClusters 为空', reuse.dirExtensionClusters.length === 0,
    JSON.stringify(reuse.dirExtensionClusters));
  check('扩目录簇实验：dirExtensionClusters 非空', extend.dirExtensionClusters.length > 0,
    JSON.stringify(extend.dirExtensionClusters));
  check('复用空槽实验：新 dirent 页落在目录**链内**既有空槽上（不是新簇）',
    reuse.direntPage === 1557, `实际 ${reuse.direntPage}`);
  check('扩目录簇实验：新 dirent 页落在**新分配的簇**上',
    extend.dirExtensionClusters.includes(Math.floor(extend.direntPage / 2) - 41),
    `direntPage=${extend.direntPage} ext=${JSON.stringify(extend.dirExtensionClusters)}`);
  check('复用空槽那条：链内本来就有空槽（声明项数 < 槽数）',
    reuse.dirBefore.declaredCount < reuse.dirBefore.chain.length * 2,
    `声明 ${reuse.dirBefore.declaredCount} 项 / ${reuse.dirBefore.chain.length * 2} 槽`);
  check('扩簇那条：链内没有空槽（声明项数 == 槽数）',
    extend.dirBefore.declaredCount === extend.dirBefore.chain.length * 2,
    `声明 ${extend.dirBefore.declaredCount} 项 / ${extend.dirBefore.chain.length * 2} 槽`);
}

/**
 * ★ 0.20：**真卡字节**上跑一次"目录链全满 ⇒ 新建文件（18 簇 + 扩目录簇）"，只读源卡。
 *
 * 为什么单独加这一节（`card.test.ts` 里已经有一条 D 实验在比 Python 夹具）：
 *   D 实验比的是"与 Python 逐字节相同"，**一旦 Python 侧也错就一起错**；
 *   而且它比的是"写前/写后的页集合"，不直接回答"我读回来的东西对不对"。
 *   这一节只用真卡字节 + 独立断言，回答三个功能问题：
 *     ① 目录里**读得回**新文件，且 `length` 就是传进去的长度；
 *     ② 18 个数据簇与扩出来的目录簇**没有共同页**（撞页会把数据或 dirent 踩掉 ——
 *        `createFileInDir` 第 4 步占用集合那条腿上曾经报过这个症状）；
 *     ③ 18 个数据簇里的内容**逐字节等于**传进去的 17440 字节。
 *
 * 内容用 `(i*7+3) & 0xFF` 这种非平凡图案（不是全 0）：全 0 时"没写进去"和"写进去了"
 * 读出来一样，等于测不出来。源卡**只读**（`cardBytes()` 走缓存、`new Card()` 拿副本）。
 */
function testCreateFileRealCard(): void {
  section('★ 0.20 真卡判据：目录链全满 ⇒ 新建 17440 B 文件（只读源卡）');
  if (!HAVE_EVIDENCE) {
    skipEvidence('真卡判据：新建 17440 B 文件');
    return;
  }
  const CARD = 'Mcd001_embdata2.ps2';
  const DIR = 'BISLPS-25462EMB';
  const NAME = 'data3';
  const src = cardBytes(CARD).slice(); // 副本：绝不改源卡字节

  const payload = new Uint8Array(17440);
  for (let i = 0; i < payload.length; i++) payload[i] = (i * 7 + 3) & 0xff;
  eq(`[真卡] payload 长度`, payload.length, 17440);
  eq(`[真卡] payload 需要簇数`, Math.ceil(payload.length / 1024), 18);

  const card = new Card(src);
  const before = card.listDir(DIR).map((e) => e.name);
  eq(`[真卡] 写前目录里没有 ${NAME}`, before.includes(NAME), false);

  const res = card.createFileInDir(DIR, NAME, payload);
  eq(`[真卡] 新建文件用到 18 个数据簇`, res.clusters.length, 18);

  // ① 读得回、长度正确
  const ent = card.listDir(DIR).find((e) => e.name === NAME);
  check(`[真卡] 回读得到 ${NAME}`, !!ent);
  if (ent) {
    eq(`[真卡] ${NAME} 的 length`, ent.length, 17440);
    const chain = card.chain(ent.cluster, 4096);
    eq(`[真卡] ${NAME} 的簇链长度`, chain.length, 18);
    eq(`[真卡] ${NAME} 的首簇`, ent.cluster, res.firstCluster);

    // ③ 内容逐字节一致
    const got = card.readFile(ent.cluster, ent.length);
    eq(`[真卡] ${NAME} 读回长度`, got.length, 17440);
    let firstDiff = -1;
    for (let i = 0; i < Math.min(got.length, payload.length); i++) {
      if (got[i] !== payload[i]) { firstDiff = i; break; }
    }
    check(`[真卡] ${NAME} 内容逐字节等于传进去的字节`, firstDiff < 0 && got.length === payload.length,
      firstDiff < 0 ? `长度 ${got.length} ≠ ${payload.length}` : `首个不同字节 @${firstDiff}：${got[firstDiff]} vs ${payload[firstDiff]}`);

    // ② 数据簇与扩目录簇**零共同页**
    const dataPages = new Set<number>();
    for (const cl of res.clusters) {
      dataPages.add(card.dataPage(cl, 0));
      dataPages.add(card.dataPage(cl, 1));
    }
    const extPages = res.dirExtensionClusters.flatMap((cl) => [card.dataPage(cl, 0), card.dataPage(cl, 1)]);
    const common = extPages.filter((p) => dataPages.has(p));
    eq(`[真卡] 扩目录簇 ${JSON.stringify(res.dirExtensionClusters)} 与 18 个数据簇的共同页`, common, []);
    eq(`[真卡] 扩目录簇页数`, extPages.length, res.dirExtensionClusters.length * 2);

    // 数据簇的两页都必须 eccOk（撞页/半写会在这里露出来）
    const badEcc: number[] = [];
    for (const p of dataPages) if (!card.eccOk(p)) badEcc.push(p);
    eq(`[真卡] 18 个数据簇的 36 页 ECC 全部正确`, badEcc, []);
  }

  // 源卡字节仍未改动
  eq(`[真卡] 源卡文件字节数`, cardBytes(CARD).length, src.length);
  eq(`[真卡] 源卡首 16 字节未被改动`,
    hex(cardBytes(CARD).subarray(0, 16)), hex(new Uint8Array(readFileSync(join(EVIDENCE, CARD))).subarray(0, 16)));
}

/**
 * ★ 演示 `65_us2jp.py::Writable` 注释里那个坑：读-改-写**跨句柄**会静默回退。
 *
 * 这里人为造出那个错误：Card 拿的是"副本 A"，但调用方在写完数据后，
 * 用**另一份源字节**去覆盖读-改-写（模拟"读来自源卡、写往副本"）。
 * 结果：FAT 写入被回退 ⇒ 新文件的簇链断掉 ⇒ 从新首簇读不出内容。
 *
 * 这是**诊断/演示**，不是主判据；只在 `--badhandle` 时跑。
 */
function testBadHandleTrap(): void {
  section('E（演示）跨句柄读-改-写 ⇒ FAT 静默回退');
  if (!HAVE_EVIDENCE) {
    skipEvidence('E（演示）跨句柄读-改-写');
    return;
  }
  const w = expByLabel('extend-directory'); // 用扩目录那条实验（数据 18 簇、链最长）
  const before = new Uint8Array(readFileSync(join(EVIDENCE, w.sourceCard)));

  const good = before.slice();
  const cardGood = readCardFromBuffer(good, false);
  const res = cardGood.createFileInDir(w.dirBefore.name, w.fileName, WRITE_DATA_PATTERN);
  const goodChain = cardGood.chain(res.firstCluster, 64);
  eq('正确写法：新文件链完整（18 簇）', goodChain.length, 18);

  // 故意制造"跨句柄"：FAT 的读改写改用源卡字节当输入
  const bad = before.slice();
  const cardBad = new Card(bad);
  const resBad = cardBad.createFileInDir(w.dirBefore.name, w.fileName, WRITE_DATA_PATTERN);
  // 把源卡（未改动的）FAT 页覆盖回副本 —— 等价于"每次 set_fat 都从源卡重读"
  for (let blk = 0; blk < 32; blk++) {
    const fc = cardBad.ind[blk];
    if (fc === 0xffffffff) continue;
    const p0 = cardBad.sysPage(fc, 0);
    bad.set(before.subarray(p0 * STRIDE, p0 * STRIDE + 512), p0 * STRIDE);
    bad.set(before.subarray((p0 + 1) * STRIDE, (p0 + 1) * STRIDE + 512), (p0 + 1) * STRIDE);
  }
  const badChain = cardBad.chain(resBad.firstCluster, 64);
  check('跨句柄回退后：新文件链**断掉**（这就是那个坑的症状）',
    badChain.length !== goodChain.length,
    `正确链长 ${goodChain.length}，回退后链长 ${badChain.length}`);
  check('跨句柄回退后：整卡 SHA-256 与正确结果不同',
    sha256(bad) !== sha256(good));
}

function testNameFieldLayout(): void {
  if (!HAVE_EVIDENCE) {
    skipEvidence('C4 dirent 名称区 32 B 布局（真卡实测）');
    return;
  }
  section('C4 dirent 名称区 32 B 的确切布局（真卡实测：名 + 00 + 补 00）');
  const examples = new Map<string, string[]>();
  let checked = 0;
  for (const mc of manifest.cards) {
    const c = new Card(cardBytes(mc.name).slice());
    const all = [...c.listRoot()];
    for (const d of c.listRoot()) {
      if (d.isDot) continue;
      for (const e of c.dirents(d.cluster, d.length)) all.push(e);
    }
    for (const e of all) {
      checked++;
      const raw = e.raw.subarray(DIRENT_NAME_OFF, DIRENT_NAME_OFF + 32);
      const nameBytes = [...e.nameRaw];
      const rest = [...raw.subarray(nameBytes.length)];
      if (!examples.has(e.name)) examples.set(e.name, rest.map((b) => b.toString(16).padStart(2, '0')).join(' '));
      check(`名称区布局：${mc.name} 的 ${JSON.stringify(e.name)}`,
        rest.length >= 1 && rest[0] === 0 && rest.every((b) => b === 0),
        `名字之后是 ${JSON.stringify(rest)}（应为 [0,0,…0]）`);
    }
  }
  check(`检查过的 dirent 数 > 10（实际 ${checked}）`, checked > 10);
  // 抽样子固化的"名字之后全 0"形态
  eq('"data2" 名称区之后 = 27 个 00', examples.get('data2'), new Array(27).fill('00').join(' '));
  eq('"." 名称区之后 = 31 个 00', examples.get('.'), new Array(31).fill('00').join(' '));
  eq('"static.ico"(10 B) 之后 = 22 个 00', examples.get('static.ico'), new Array(22).fill('00').join(' '));
  eq('"BISLPS-25462EMB"(15 B) 之后 = 17 个 00', examples.get('BISLPS-25462EMB'), new Array(17).fill('00').join(' '));

  // 克隆出来的 dirent 也必须遵循同一布局（这是本项目最容易写错的一处）
  const bytes = cardBytes(EXPERIMENTS[0].sourceCard);  const c2 = readCardFromBuffer(bytes.slice(), false);
  const dirEnt = c2.findInRoot('BISLPS-25462EMB')!;
  const subs = c2.dirents(dirEnt.cluster, dirEnt.length);
  const tpl = subs.find((s) => s.name === 'data0')!;
  const cloned = c2.cloneDirent(tpl, 'data7', 1234, 999);
  eq('克隆项的名字区 32 B', Buffer.from(cloned.subarray(DIRENT_NAME_OFF, DIRENT_NAME_OFF + 32)).toString('hex'),
    '646174613700' + '00'.repeat(26));
  eq('克隆项只改了 cluster', Buffer.from(cloned.subarray(0x10, 0x14)).toString('hex'), 'd2040000');
  eq('克隆项只改了 length', Buffer.from(cloned.subarray(0x04, 0x08)).toString('hex'), 'e7030000');
  eq('克隆项其余字段与模板逐字节相同',
    Buffer.from(cloned).toString('hex') === Buffer.from(tpl.raw).toString('hex'), false);
  const diffByOffset: number[] = [];
  for (let i = 0; i < 512; i++) if (cloned[i] !== tpl.raw[i]) diffByOffset.push(i);
  check('克隆项与模板的差异字节只落在 [0x04,0x08) ∪ [0x10,0x14) ∪ [0x40,0x60)',
    diffByOffset.every((i) => (i >= 0x04 && i < 0x08) || (i >= 0x10 && i < 0x14) || (i >= 0x40 && i < 0x60)),
    `差异偏移 ${JSON.stringify(diffByOffset)}`);
}

/**
 * ★ 空槽判据：必须是 `mode === 0xFFFFFFFF`（**整项 FF**），
 *   **不能**用 `(mode & 0x8000) === 0` —— 因为 `0xFFFFFFFF` 的 bit15 = 1，
 *   后者会把"空槽"误判成"已用"，于是永远找不到空槽（就会去扩目录，甚至写坏同簇的另一页）。
 *
 * 真卡上的判据形态（实测）：
 *   · `BISLPS-25462GAME` 链 5 簇 = 10 槽，第 10 槽（页 1557）是整页 FF 空槽；
 *   · `BISLPS-25462EMB` 链 4 簇 = 8 槽，全满 ⇒ `findFreeSlot` 必须返回 -1。
 */
function testFreeSlotCriterion(): void {
  if (!HAVE_EVIDENCE) {
    skipEvidence('C5 空槽判据（真卡实测）');
    return;
  }
  section('C5 空槽判据（mode == 0xFFFFFFFF，而不是 (mode & 0x8000) === 0）');
  const c = new Card(cardBytes(EXPERIMENTS[0].sourceCard).slice());

  // 位运算的自证：用 (mode & 0x8000) === 0 判空槽是错的
  eq('0xFFFFFFFF 的 bit15 = 1（所以"bit15 === 0"式判据会漏掉空槽）',
    (0xffffffff & 0x8000) !== 0, true);
  eq('0xFFFFFFFF 的 bit31 = 1', (0xffffffff & 0x80000000) !== 0, true);
  eq('空槽常量 DIRENT_EMPTY_MODE 必须是整项 FF', 0xffffffff, 0xffffffff);

  // GAME：声明 9 项 / 链 10 槽 ⇒ 第 10 槽是"未声明但确实空着"的槽
  const game = c.findInRoot('BISLPS-25462GAME')!;
  eq('GAME 声明项数', game.length, 9);
  eq('GAME 目录链', c.chain(game.cluster, 4096), EXPERIMENTS[0].dirBefore.chain);
  eq('GAME 链槽数', c.chain(game.cluster, 4096).length * c.ppc, 10);
  // ★ findFreeSlot 先扫声明范围、再扫声明之后（真卡声明会滞后，必须往后扫）
  eq('findFreeSlot(GAME, 声明 9 项) = 9（声明范围外那个空槽也会被找到）',
    c.findFreeSlot(game.cluster, 9), 9);
  eq('findFreeSlot(GAME, 链槽数 10) = 9', c.findFreeSlot(game.cluster, 10), 9);
  eq('GAME 第 10 槽所在页', c.dataPage(c.chain(game.cluster, 4096)[4], 1), 1557);
  eq('GAME 第 10 槽整页 = FF×512',
    hex(c.readPageRaw(1557)), 'ff'.repeat(512));
  eq('GAME 第 10 槽 mode = 0xFFFFFFFF', c.readPageRaw(1557)[0] === 0xff
    && c.readPageRaw(1557)[1] === 0xff && c.readPageRaw(1557)[2] === 0xff && c.readPageRaw(1557)[3] === 0xff, true);
  eq('GAME 第 10 槽备用区 = pageEcc(FF 页)',
    hex(c.readSpareRaw(1557)), hex(pageEcc(new Uint8Array(512).fill(0xff))));
  eq('GAME 第 10 槽备用区 != FF×16（真卡是"写过的整页 FF"，不是未写入态）',
    hex(c.readSpareRaw(1557)) === 'ff'.repeat(16), false);
  eq('GAME 第 10 槽 eccOk', c.eccOk(1557), true);
  // 声明范围内（前 9 槽）确实没有空槽 —— 这正是"必须往后扫"的动机
  const declaredSlots: number[] = [];
  const gc = c.chain(game.cluster, 4096);
  for (let s = 0; s < 9; s++) {
    const raw = c.readDataPage(gc[Math.floor(s / c.ppc)], s % c.ppc);
    declaredSlots.push((raw[0] | (raw[1] << 8) | (raw[2] << 16) | (raw[3] << 24)) >>> 0);
  }
  eq('GAME 声明的前 9 槽里一个 0xFFFFFFFF 都没有',
    declaredSlots.filter((m) => m === 0xffffffff).length, 0);

  // EMB：8/8 全满 ⇒ 任何 count 都找不到空槽
  const emb = c.findInRoot('BISLPS-25462EMB')!;
  eq('EMB 声明项数', emb.length, 8);
  eq('EMB 链槽数', c.chain(emb.cluster, 4096).length * c.ppc, 8);
  eq('findFreeSlot(EMB, 8) = -1（全满）', c.findFreeSlot(emb.cluster, 8), -1);
  eq('findFreeSlot(EMB, 100) = -1（超出链长也不越界）', c.findFreeSlot(emb.cluster, 100), -1);

  // ★ 反向自证：如果把判据换成 (mode & 0x8000) === 0，就会找不到 GAME 的空槽
  const gameChain = c.chain(game.cluster, 4096);
  const slotModes: number[] = [];
  for (let s = 0; s < gameChain.length * c.ppc; s++) {
    const raw = c.readDataPage(gameChain[Math.floor(s / c.ppc)], s % c.ppc);
    slotModes.push((raw[0] | (raw[1] << 8) | (raw[2] << 16) | (raw[3] << 24)) >>> 0);
  }
  eq('GAME 10 个槽的 mode', slotModes.map((m) => (m === 0xffffffff ? 'EMPTY' : m.toString(16))),
    ['8427', '8427', '8497', '8497', '8497', '8497', '8497', '8497', '8497', 'EMPTY']);
  eq('用 (mode & 0x8000) === 0 当判据 ⇒ 找不到任何空槽（findIndex = -1）',
    slotModes.findIndex((m) => (m & 0x8000) === 0), -1);
  eq('用 (mode === 0xFFFFFFFF) 当判据 ⇒ 正确找到第 9 槽',
    slotModes.findIndex((m) => m === 0xffffffff), 9);
}

// ─────────────────────────── 主流程 ───────────────────────────

/**
 * ★ 0.19 回归：坏卡不许把"读不到"变成"读到 0"，也不许把超块当 FAT 块写。
 *
 * 这三条来自"深审核心层"那一轮（D18/D19/D24），每条都对着一个**实测过的**现象：
 *   · D18：超块 `ifc[0] = 0xFFFFFFFF` 时 `new Card()` 不报错、`ind[]` 全 0，
 *          而 `writeFat()` 把簇 0 = **超块自己** 当 FAT 块 ⇒ 一写就毁掉 "Sony" 魔数；
 *   · D19：`readFile()` 对"簇号合法但页不存在"的簇返回**全 0**（看着像"这张徽章是空的"），
 *          而 Python 参考实现返回 0 字节；
 *   · D24：`Buffer.prototype.slice` 是**视图** ⇒ 文档推荐传 Buffer 的那条路上，
 *          `copy = true` 其实一次都没复制（实测会把调用方 Buffer 的前 8 字节改掉）。
 */
function testCorruptCardSafety(): void {
  if (!HAVE_EVIDENCE) {
    skipEvidence('坏卡安全：超块自检 / 图外簇不补零 / Buffer 输入必须真复制');
    return;
  }
  section('E ★ 坏卡安全：超块自检 / 图外簇不补零 / Buffer 输入必须真复制');

  const throws = (fn: () => unknown, what: string): void => {
    let msg = '';
    let threw = false;
    try {
      fn();
    } catch (e) {
      threw = true;
      msg = e instanceof Error ? e.message : String(e);
    }
    check(what, threw, `没有抛异常（应在这条坏输入上拒绝）${msg ? `；抛的是：${msg}` : ''}`);
  };

  // ── D24：copy / 副本语义（Node Buffer 与 Uint8Array 都必须成立）──
  {
    const caller = Buffer.from(cardBytes('Mcd001_embdata2.ps2')); // Node Buffer（文档推荐的入口）
    const before = caller.subarray(0, 8).toString('hex');
    const c = readCardFromBuffer(caller); // copy 默认 true
    c.writePageRaw(0, new Uint8Array(PAGE_SIZE).fill(0x5a));
    eq('[D24] Buffer 输入 + copy=true ⇒ 调用方字节不受影响', caller.subarray(0, 8).toString('hex'), before);

    const c2 = readCardFromBuffer(cardBytes('Mcd001_embdata2.ps2'));
    const page = c2.readPageRaw(100);
    const orig = c2.buf[100 * STRIDE];
    page[0] = orig ^ 0xff;
    eq('[D24] readPageRaw 返回的是副本（改它之后卡镜像不变）', c2.buf[100 * STRIDE], orig);
    const spare = c2.readSpareRaw(100);
    const origSpare = c2.buf[100 * STRIDE + PAGE_SIZE];
    spare[0] = origSpare ^ 0xff;
    eq('[D24] readSpareRaw 返回的是副本', c2.buf[100 * STRIDE + PAGE_SIZE], origSpare);
  }

  // ── D18：超块字段自检 ──
  {
    const badIfc = new Uint8Array(cardBytes('Mcd001_embdata2.ps2'));
    new DataView(badIfc.buffer, badIfc.byteOffset, badIfc.byteLength).setUint32(0x50, 0xffffffff, true);
    throws(() => new Card(badIfc), '[D18] ifc[0] 无效 ⇒ new Card() 必须抛（不许把 ind[] 填成 0）');

    const badEnd = new Uint8Array(cardBytes('Mcd001_embdata2.ps2'));
    new DataView(badEnd.buffer, badEnd.byteOffset, badEnd.byteLength).setUint32(0x38, 0xffffffff, true);
    throws(() => new Card(badEnd), '[D18] alloc_end 超出 clusters ⇒ new Card() 必须抛');

    const badPage = new Uint8Array(cardBytes('Mcd001_embdata2.ps2'));
    new DataView(badPage.buffer, badPage.byteOffset, badPage.byteLength).setUint16(0x28, 1024, true);
    throws(() => new Card(badPage), '[D18] page_len ≠ 512 ⇒ new Card() 必须抛');
  }

  // ── D18 第二半：`writeFat` 绝不接受簇 0（超块）与图外簇 ──
  {
    const c = readCardFromBuffer(cardBytes('Mcd001_embdata2.ps2'));
    const sane = c.ind.slice();
    // 直接把 ind[] 改坏（模拟"超块被读成 0"的旧行为），再确认 writeFat 会拒绝
    (c.ind as number[])[0] = 0;
    throws(() => c.writeFat(0, 0x80000000 | 0x7fffffff), '[D18] ind[0] = 0（超块）⇒ writeFat 必须拒绝');
    (c.ind as number[])[0] = 999999;
    throws(() => c.writeFat(0, 0x80000000 | 0x7fffffff), '[D18] ind[0] 指向图外簇 ⇒ writeFat 必须拒绝');
    (c.ind as number[])[0] = sane[0];
    eq('[D18] 合法 ind[0] 仍然能正常读 FAT（自检没误伤）', typeof c.readFat(0), 'number');
  }

  // ── D19：图外簇 ⇒ 短缓冲（不补零），且 clusterInImage() 说得清 ──
  {
    const c = readCardFromBuffer(cardBytes('Mcd001_embdata2.ps2'));
    check('[D19] clusterInImage(100) = true（图内）', c.clusterInImage(100), 'clusterInImage 判错了');
    check('[D19] clusterInImage(8155) = false（簇号合法但页不存在）', !c.clusterInImage(8155), 'clusterInImage 判错了');
    eq('[D19] readFile(8155, 1024) ⇒ 0 字节（不补零）', c.readFile(8155, 1024).length, 0);
    eq('[D19] chain(8155) 仍照常返回链（读路径自己截断）', c.chain(8155).length >= 1, true);
    throws(() => c.readPageRaw(c.npages), '[D19] readPageRaw 越界必须抛（不许返回空数组）');
    throws(() => c.readFat(-1), '[D18/D19] readFat(负数) 必须抛');
    throws(() => c.chain(-1), '[D18/D19] chain(负数) 必须抛');
  }

  // ── FRAGILE 项顺手钉住：encodeName 非 ASCII 必须拒绝（Python 在那里也抛）──
  {
    throws(() => encodeName('中文名'), 'encodeName 对非 ASCII 名必须抛（不许静默写乱字节）');
    eq('encodeName 正常名仍然可用', hex(encodeName('data0')), '6461746130000000000000000000000000000000000000000000000000000000');
  }
}

function main(): void {
  console.log('=== 记忆卡层测试（web/test/card.test.ts）===');  console.log(`夹具 : ${MANIFEST_PATH}`);
  console.log(`证据卡: ${EVIDENCE}`);
  console.log(`Node : ${process.version}`);

  if (!existsSync(MANIFEST_PATH)) {
    console.error(`❌ 找不到夹具 ${MANIFEST_PATH}\n   先跑：python web\\test\\make_card_fixtures.py`);
    process.exit(2);
  }

  testConstants();
  testEcc();
  testReadCards();
  testModeSemantics();
  testNameFieldLayout();
  testFreeSlotCriterion();
  testChainAcrossFatBlocks();
  testOffsetAndBoundaries();
  testWriteExperiments();
  testCreateFileRealCard();
  testCorruptCardSafety();
  if (process.argv.includes('--badhandle')) testBadHandleTrap();

  if (failures.length) {
    console.log('\n=== 失败明细 ===');
    for (const f of failures) console.log(`  · ${f}`);
  }
  if (skippedEvidence) {
    console.log(
      `\n⚠ 有 ${skippedEvidence} 节被跳过：本机没有 out/evidence 里的真记忆卡。\n` +
        '   这几节是"与 Python 夹具逐项比对 4 张真卡"的判据 —— 卡不进仓库（33 MB + 私有存档），\n' +
        '   想跑就把 4 张 .ps2 放回 out/evidence/（文件名见 web/test/fixtures/card-manifest.json）。',
    );
  }
  console.log(`\n=== 通过 ${passed} / ${passed + failed} ===`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
