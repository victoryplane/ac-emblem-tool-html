/**
 * 徽章格式核心的**移植一致性测试**（零依赖，Node 原生跑 .ts）。
 *
 * 跑法（在项目根目录下）：
 *     node web\test\core.test.ts
 *
 * 它做两件事：
 *   ① 对 `web/test/fixtures/manifest.json` 里的每个样本，逐项比对
 *      TypeScript 实现与 **Python 参考实现**（`tools/acet_format.py`）算出来的期望值；
 *   ② 一组纯自检（不依赖夹具）：常量推导、offsetIndex 跨 0x3FF、调色板置换互逆、
 *      encodeEmblem 往返、makeBlankSave 的块头与真实存档一致、尾巴规则……
 *
 * 任何一条不一致都会打印 样本名 / 项目 / 期望 / 实到，并以非零退出码结束。
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BLOCK,
  BLOCK_DATA,
  DANGLING,
  DANGLING_LR,
  EMBLEM_HEADER,
  FINAL_ALPHA_POS,
  FINAL_CHECK_OFF,
  FINAL_CHECK_OFF_LR,
  FINAL_CHECK_POS,
  FINAL_DATA_LEN,
  FINAL_SEG_OFF,
  FINAL_TRAILER,
  HEADER_TAIL_LEN,
  HEADER_TAIL_OFF,
  IMAGE_OFFSET,
  LR_EMBLEM_HEADER,
  LR_IMAGE_OFFSET,
  LR_SAVE_SIZE,
  NUM_PIXELS,
  PALETTE_ALPHA_OPAQUE,
  PALETTE_SIZE,
  SAVE_SIZE,
  SCRAMBLE_LUT,
  SEED,
  SEED_LR,
  UNSCRAMBLE_LUT,
  applyChecksums,
  computeChecksum,
  encodeEmblem,
  extractImage,
  fillUnusedPalette,
  findOffset,
  findOffsetContiguous,
  findPaletteOffset,
  headerTailFromSave,
  injectImage,
  injectPixelsToIndices,
  invertPalettePermutation,
  isLrSave,
  lrHeaderFromSave,
  makeBlankSave,
  offsetIndex,
  packColor,
  saveKind,
  scramblePalette,
  segmentLayout,
  unpackColor,
  unscramblePalette,
  usedPaletteSlots,
  verifyChecksums,
  verifyChecksumsUpstream,
  type AlphaMode,
} from '../src/core/emblem.ts';

// --------------------------------------------------------------------------
// 极简测试框架
// --------------------------------------------------------------------------
const HERE = dirname(fileURLToPath(import.meta.url));
const PROJ = resolve(HERE, '..', '..'); // web/test → emblem-tool
const FIXTURES = join(HERE, 'fixtures');

let pass = 0;
const failures: string[] = [];

/** 断言。ok=true 记一次通过，否则记录失败明细。 */
function ok(cond: boolean, what: string, detail = ''): void {
  if (cond) {
    pass += 1;
  } else {
    failures.push(detail ? `${what} — ${detail}` : what);
  }
}

function eq(actual: unknown, expected: unknown, what: string): void {
  const a = String(actual);
  const e = String(expected);
  ok(a === e, what, `期望 ${e}，实到 ${a}`);
}

function section(title: string): void {
  console.log(`\n--- ${title} ---`);
}

function readFile(p: string): Uint8Array {
  return new Uint8Array(readFileSync(p));
}

function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function hex(data: Uint8Array): string {
  return Buffer.from(data).toString('hex');
}

function toHex(arr: ArrayLike<number>): string {
  return Array.from(arr, (b) => (b & 0xff).toString(16).padStart(2, '0')).join('');
}

// --------------------------------------------------------------------------
// ① 用夹具逐样本比对 Python 期望值
// --------------------------------------------------------------------------
type Entry = {
  path: string;
  source?: string;
  size: number;
  sha256: string;
  kind: string;
  isLr: boolean;
  verifyOk: boolean;
  verifyBad: number;
  verifyUpstreamOk: boolean;
  verifyUpstreamBad: number;
  checkBytes: string[];
  finalCheckPos: number;
  finalAlphaPos: number;
  finalCheckByte: string;
  finalAlphaByte: string;
  finalTrailer: string;
  imageIndex0Sha256: string;
  imageAcetSha256: string;
  imageGsSha256: string;
  imageLength: number;
  appliedSha256: string;
  appliedIdentical: boolean;
  appliedDiffOffsets: string[];
  usedPaletteSlots: number;
  headerTail: string | null;
  reencodedSha256: string;
  reencodedSkipUnusedSha256: string;
  reencodedHeaderHex: string;
  sourceHeaderHex: string;
  reencodedRoundTripIndex0: boolean;
  findOffset?: number;
  findOffsetContiguous?: number;
};

function testSample(entry: Entry): void {
  const tag = entry.path;
  const abs = join(PROJ, entry.path.split('/').join('\\'));
  const bytes = readFile(abs);

  // 夹具文件本身
  eq(bytes.length, entry.size, `${tag}: 文件大小`);
  eq(sha256(bytes), entry.sha256, `${tag}: 夹具文件 SHA-256`);

  // 识别
  eq(saveKind(bytes), entry.kind, `${tag}: saveKind`);
  eq(isLrSave(bytes), entry.isLr, `${tag}: isLr`);

  // 18 段校验（真实位置）
  const v = verifyChecksums(bytes);
  eq(v.ok, entry.verifyOk, `${tag}: verifyChecksums().ok`);
  eq(v.badSegments.length, entry.verifyBad, `${tag}: verifyChecksums() 坏段数`);
  if (v.badSegments.length > 0) {
    console.log(`     坏段明细: ${JSON.stringify(v.badSegments)}`);
  }
  // 上游那种"早一个字节"的写法（对照）
  const vu = verifyChecksumsUpstream(bytes);
  eq(vu.ok, entry.verifyUpstreamOk, `${tag}: verifyChecksumsUpstream().ok`);
  eq(vu.badSegments.length, entry.verifyUpstreamBad, `${tag}: verifyChecksumsUpstream() 坏段数`);

  // 18 个校验字节本身
  const segs = segmentLayout(entry.isLr);
  eq(segs.length, 18, `${tag}: 段数`);
  const gotChecks = segs.map((s) => bytes[s.checkPos]);
  const wantChecks = entry.checkBytes.map((h) => parseInt(h, 16));
  eq(toHex(gotChecks), toHex(wantChecks), `${tag}: 18 个校验字节`);

  // 末段的真实位置 / 尾巴
  eq(FINAL_CHECK_POS[entry.isLr ? 'true' : 'false'], entry.finalCheckPos, `${tag}: 末段校验位置`);
  eq(FINAL_ALPHA_POS[entry.isLr ? 'true' : 'false'], entry.finalAlphaPos, `${tag}: 末段 alpha 位置`);
  eq(toHex([bytes[entry.finalCheckPos]]), entry.finalCheckByte, `${tag}: 末段校验字节`);
  eq(toHex([bytes[entry.finalAlphaPos]]), entry.finalAlphaByte, `${tag}: 末段 alpha 字节`);
  const trailerStart = entry.finalCheckPos + 1;
  eq(toHex(bytes.slice(trailerStart, trailerStart + FINAL_TRAILER.length)), entry.finalTrailer, `${tag}: 10 字节尾巴`);

  // 三种 alpha 口径的提取结果
  const modes: Array<[AlphaMode, string]> = [
    ['index0', entry.imageIndex0Sha256],
    ['acet', entry.imageAcetSha256],
    ['gs', entry.imageGsSha256],
  ];
  for (const [mode, want] of modes) {
    const img = extractImage(bytes, mode);
    eq(img.length, entry.imageLength, `${tag}: extractImage('${mode}') 长度`);
    eq(img.length, NUM_PIXELS * 4, `${tag}: extractImage('${mode}') 应为 65536 字节`);
    eq(sha256(img), want, `${tag}: extractImage('${mode}') SHA-256`);
  }

  // applyChecksums
  const applied = Uint8Array.from(bytes);
  applyChecksums(applied);
  eq(sha256(applied), entry.appliedSha256, `${tag}: applyChecksums 之后块 SHA-256`);
  eq(sha256(applied) === entry.sha256, entry.appliedIdentical, `${tag}: applyChecksums 逐字节复原`);
  if (!entry.appliedIdentical) {
    const diffs: string[] = [];
    for (let i = 0; i < bytes.length; i++) {
      if (bytes[i] !== applied[i]) diffs.push(`0x${i.toString(16).toUpperCase()}`);
    }
    eq(diffs.join(','), entry.appliedDiffOffsets.join(','), `${tag}: 差异偏移`);
  }

  // 幂等：再算一次必须一模一样
  const applied2 = Uint8Array.from(applied);
  applyChecksums(applied2);
  eq(sha256(applied2), entry.appliedSha256, `${tag}: applyChecksums 幂等`);

  // 未用调色板槽数
  eq(usedPaletteSlots(bytes).length, entry.usedPaletteSlots, `${tag}: usedPaletteSlots`);

  // 作品常量 / LR 块头
  if (!entry.isLr) {
    eq(toHex(headerTailFromSave(bytes)), entry.headerTail, `${tag}: headerTailFromSave`);
    eq(toHex(bytes.slice(0, 12)), toHex(EMBLEM_HEADER), `${tag}: 非 LR 12 字节魔数`);
  } else {
    eq(toHex(lrHeaderFromSave(bytes)), toHex(LR_EMBLEM_HEADER), `${tag}: LR 块头 = 00 44 00 00`);
    eq(toHex(bytes.slice(0, 4)), toHex(LR_EMBLEM_HEADER), `${tag}: LR 头 4 字节`);
  }

  // 重新编码（extract('index0') → encodeEmblem）
  const img0 = extractImage(bytes, 'index0');
  const tail9 = entry.isLr ? null : headerTailFromSave(bytes);
  const re = encodeEmblem(img0, { isLr: entry.isLr, headerTail: tail9, fillUnused: true });
  eq(sha256(re), entry.reencodedSha256, `${tag}: encodeEmblem(fillUnused=true) SHA-256`);
  eq(verifyChecksums(re).ok, true, `${tag}: 重新编码后 18 段校验`);
  eq(toHex(re.slice(0, entry.reencodedHeaderHex.length / 2)), entry.reencodedHeaderHex,
    `${tag}: 重新编码的块头`);
  eq(entry.reencodedHeaderHex, entry.sourceHeaderHex, `${tag}: 块头与真实存档一致`);
  eq(sha256(extractImage(re, 'index0')) === entry.imageIndex0Sha256, entry.reencodedRoundTripIndex0,
    `${tag}: 重新编码后提取逐像素一致`);

  const reSkip = encodeEmblem(img0, { isLr: entry.isLr, headerTail: tail9, fillUnused: false });
  eq(sha256(reSkip), entry.reencodedSkipUnusedSha256, `${tag}: encodeEmblem(fillUnused=false) SHA-256`);
}

// --------------------------------------------------------------------------
// ② 纯自检
// --------------------------------------------------------------------------
function testConstants(): void {
  section('常量与推导');
  eq(SAVE_SIZE, 0x4440, 'SAVE_SIZE');
  eq(LR_SAVE_SIZE, 0x4420, 'LR_SAVE_SIZE');
  eq(IMAGE_OFFSET, 0x24, 'IMAGE_OFFSET');
  eq(LR_IMAGE_OFFSET, 0x04, 'LR_IMAGE_OFFSET');
  eq(SEED, 0x98, 'SEED');
  eq(SEED_LR, 0xb8, 'SEED_LR');
  eq(BLOCK, 0x400, 'BLOCK');
  eq(BLOCK_DATA, 0x3ff, 'BLOCK_DATA');
  eq(PALETTE_SIZE, 0x400, 'PALETTE_SIZE');
  eq(EMBLEM_HEADER.length, 12, 'EMBLEM_HEADER 长度');
  eq(toHex(EMBLEM_HEADER), '204400002044000000400000', 'EMBLEM_HEADER 字节');
  eq(toHex(LR_EMBLEM_HEADER), '00440000', 'LR_EMBLEM_HEADER 字节');
  eq(FINAL_CHECK_OFF, 0x4434, 'FINAL_CHECK_OFF');
  eq(FINAL_CHECK_OFF_LR, 0x4414, 'FINAL_CHECK_OFF_LR');
  eq(DANGLING, 0x35, 'DANGLING = 53');
  eq(DANGLING_LR, 0x15, 'DANGLING_LR = 21');
  eq(FINAL_SEG_OFF, 0x4400, 'FINAL_SEG_OFF');
  eq(FINAL_DATA_LEN.false, 53, 'FINAL_DATA_LEN 非 LR');
  eq(FINAL_DATA_LEN.true, 21, 'FINAL_DATA_LEN LR');
  eq(FINAL_CHECK_POS.false, 0x4435, '★ 非 LR 末段校验位置 = 0x4435');
  eq(FINAL_CHECK_POS.true, 0x4415, '★ LR 末段校验位置 = 0x4415');
  eq(FINAL_ALPHA_POS.false, 0x4434, '★ 非 LR alpha 位置 = 0x4434');
  eq(FINAL_ALPHA_POS.true, 0x4414, '★ LR alpha 位置 = 0x4414');
  eq(toHex(FINAL_TRAILER), '01000000000000000000', 'FINAL_TRAILER = 01 00*9');
  eq(PALETTE_ALPHA_OPAQUE, 0x80, 'PALETTE_ALPHA_OPAQUE');
  eq(HEADER_TAIL_OFF, 0x14, 'HEADER_TAIL_OFF');
  eq(HEADER_TAIL_LEN, 9, 'HEADER_TAIL_LEN');

  // 末段校验位置必须"紧跟在数据之后"，而不是在数据内部（上游差一个字节）
  eq(FINAL_CHECK_POS.false, FINAL_SEG_OFF + FINAL_DATA_LEN.false, '非 LR 末段：校验紧随数据');
  eq(FINAL_CHECK_POS.true, FINAL_SEG_OFF + FINAL_DATA_LEN.true, 'LR 末段：校验紧随数据');
  ok(FINAL_ALPHA_POS.false === FINAL_CHECK_POS.false - 1,
    '非 LR：alpha 就在校验字节前一个字节（= 上游写错的那一格）');
  ok(FINAL_ALPHA_POS.true === FINAL_CHECK_POS.true - 1, 'LR：alpha 就在校验字节前一个字节');
  ok(DANGLING === FINAL_DATA_LEN.false && DANGLING_LR === FINAL_DATA_LEN.true,
    'dangling 的真实语义 = 末段数据长度');

  // 字节序：魔数就是三个 u32LE（0x4420 / 0x4420 / 0x4000）—— 别把它当字符串
  const u32 = (b: Uint8Array, o: number) =>
    (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
  eq(u32(EMBLEM_HEADER, 0), LR_SAVE_SIZE, '★ 魔数[0..3] = u32LE 0x4420（= LR 存档大小）');
  eq(u32(EMBLEM_HEADER, 4), LR_SAVE_SIZE, '★ 魔数[4..7] = u32LE 0x4420');
  eq(u32(EMBLEM_HEADER, 8), NUM_PIXELS, '★ 魔数[8..11] = u32LE 0x4000（= 图像数据长度）');
  eq(u32(LR_EMBLEM_HEADER, 0), 0x4400, '★ LR 块头 = u32LE 0x4400（= 索引 0x4000 + 调色板 0x400）');
}

function testSegmentLayout(): void {
  section('segmentLayout / computeChecksum');
  for (const isLr of [false, true]) {
    const tag = isLr ? 'LR' : '非LR';
    const segs = segmentLayout(isLr);
    eq(segs.length, 18, `${tag}: 段数 = 18（17 常规 + 1 末段）`);
    for (let k = 0; k < 17; k++) {
      eq(segs[k].start, k * BLOCK, `${tag}: 第 ${k} 段起点`);
      eq(segs[k].dataLen, BLOCK_DATA, `${tag}: 第 ${k} 段数据长度`);
      eq(segs[k].checkPos, k * BLOCK + BLOCK_DATA, `${tag}: 第 ${k} 段校验位置`);
      eq(segs[k].seed, k === 0 ? (isLr ? SEED_LR : SEED) : 0, `${tag}: 第 ${k} 段种子`);
    }
    eq(segs[17].start, FINAL_SEG_OFF, `${tag}: 末段起点 0x4400`);
    // 校验位置不得互相重叠、必须严格递增、必须落在文件内
    const size = isLr ? LR_SAVE_SIZE : SAVE_SIZE;
    const positions = segs.map((s) => s.checkPos);
    for (let k = 1; k < positions.length; k++) {
      ok(positions[k] > positions[k - 1], `${tag}: 校验位置严格递增（第 ${k} 段）`);
    }
    ok(positions[positions.length - 1] < size, `${tag}: 末段校验位置在文件内`);
    // 每段的 (起点 .. 校验位置) 必须恰好覆盖数据长度
    for (const [k, s] of segs.entries()) {
      eq(s.checkPos - s.start, s.dataLen, `${tag}: 第 ${k} 段"数据长度 = 校验位置 - 起点"`);
    }
    // 校验公式自证：computeChecksum([...], len) === -(sum + len) & 0xFF
    const probe = Uint8Array.from([0x01, 0x02, 0x03, 0xff]);
    eq(computeChecksum(probe, 4, 0), (-(0x105 + 4) - 0) & 0xff, `${tag}: computeChecksum 基础式`);
    eq(computeChecksum(probe, 4, SEED), (-(0x105 + 4 + SEED)) & 0xff, `${tag}: computeChecksum 带种子`);
  }
}

function testOffsetIndex(): void {
  section('offsetIndex（跨 0x3FF 边界，绝不能连续切片）');
  // 物理 = base + i + floor(i / 0x3FF)。下面的期望值全部由 Python 的 offset_index() 现算核对。
  eq(offsetIndex(0), 0, 'offsetIndex(0)');
  eq(offsetIndex(1), 1, 'offsetIndex(1)');
  eq(offsetIndex(1022), 0x3fe, 'offsetIndex(1022) = 0x3FE');
  eq(offsetIndex(1023), 0x400, '★ offsetIndex(1023) = 0x400（0x3FF 自己就被跳过）');
  eq(offsetIndex(1024), 0x401, 'offsetIndex(1024) = 0x401');
  eq(offsetIndex(0x3ff), 0x400, 'offsetIndex(0x3FF) = 0x400');
  eq(offsetIndex(0x400), 0x401, 'offsetIndex(0x400) = 0x401');
  eq(offsetIndex(0x401), 0x402, 'offsetIndex(0x401) = 0x402');
  eq(offsetIndex(0x7fd), 0x7fe, 'offsetIndex(0x7FD) = 0x7FE');
  eq(offsetIndex(0x7fe), 0x800, 'offsetIndex(0x7FE) = 0x800');
  eq(offsetIndex(0x7ff), 0x801, 'offsetIndex(0x7FF) = 0x801');
  eq(offsetIndex(0x43ff), 0x4410, '★ 逻辑 0x43FF → 物理 0x4410');
  eq(offsetIndex(0x43fe), 0x440f, 'offsetIndex(0x43FE) = 0x440F');
  eq(offsetIndex(0, 0x120), 0x120, 'offsetIndex(0, base)');
  eq(offsetIndex(0x400, 0x120), 0x521, 'offsetIndex(0x400, base) = base + 0x401');

  // ⚠ 最容易错的地方：**那 0x24 字节头不参与跳字节**（跳字节只按逻辑下标算），
  //   所以"图像/调色板的物理区间的边界"不等于 `0x24 + 逻辑长度`。
  //   （Python 版文件头的说明写的是**逻辑**布局，别把它当物理区间。）
  eq(offsetIndex(IMAGE_OFFSET + NUM_PIXELS - 1), 0x4033,
    '★ 图像最后一个像素（逻辑 0x401E）+ 0x24 头 → 物理 0x4033');
  eq(offsetIndex(IMAGE_OFFSET + NUM_PIXELS), 0x4034, '★ 调色板第一字节（逻辑 0x401F）→ 物理 0x4034');
  eq(offsetIndex(IMAGE_OFFSET + NUM_PIXELS + PALETTE_SIZE - 1), 0x4434,
    '★ 调色板最后一字节（逻辑 0x43FF）→ 物理 0x4434 = 末段的 palette[255].alpha');
  eq(offsetIndex(IMAGE_OFFSET + NUM_PIXELS + 255 * 4 + 3), 0x4434,
    '★ palette[255].alpha 就是末段那个 alpha 字节 0x4434');
  eq(offsetIndex(FINAL_SEG_OFF), 0x4411, '★ 末段数据起点（逻辑 0x4400）→ 物理 0x4411');

  // 不变量：0x4000 个像素位置 + 0x400 个调色板位置**两两不重复、都不撞 17 个校验字节**
  const checkPositions = new Set(segmentLayout(false).map((s) => s.checkPos));
  const all = new Set<number>();
  for (let i = 0; i < NUM_PIXELS; i++) all.add(offsetIndex(IMAGE_OFFSET + i, 0));
  for (let i = 0; i < PALETTE_SIZE; i++) all.add(offsetIndex(IMAGE_OFFSET + NUM_PIXELS + i, 0));
  eq(all.size, NUM_PIXELS + PALETTE_SIZE, '★ 图像 + 调色板 的物理位置集合无重复');
  let min = Infinity;
  let max = -Infinity;
  for (const v of all) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  eq(min, IMAGE_OFFSET, '★ 数据区最小物理位置 = 0x24（就是图像第一个像素）');
  eq(max, 0x4434, '★ 数据区最大物理位置 = 0x4434（palette[255].alpha）');
  const collide = Array.from(all).filter((p) => checkPositions.has(p));
  eq(collide.length, 0, `★ 没有任何数据位置撞上校验字节（实到 ${collide.map((p) => p.toString(16))}）`);
  // 17 个常规校验字节的位置（物理）
  eq(Array.from({ length: 17 }, (_, k) => k * BLOCK + BLOCK_DATA).join(','),
    segmentLayout(false).slice(0, 17).map((s) => s.checkPos).join(','),
    '★ 17 个常规校验字节位置 = 0x3FF, 0x7FF, …, 0x43FF');
  ok(checkPositions.has(0x43ff), '★ 0x43FF 是第 17 个校验字节（它把调色板最后 4 项切成两半）');
}

function testPalettePermutation(): void {
  section('调色板乱序置换及其逆');
  // 32 项为一组：交换中间两组 8 项 [0..7][8..15][16..23][24..31] → [0..7][16..23][8..15][24..31]
  eq(scramblePalette(0), 0, 'scramble(0)');
  eq(scramblePalette(7), 7, 'scramble(7)');
  eq(scramblePalette(8), 16, '★ scramble(8) = 16（槽 8 → 物理 16）');
  eq(scramblePalette(15), 23, 'scramble(15) = 23');
  eq(scramblePalette(16), 8, '★ scramble(16) = 8');
  eq(scramblePalette(23), 15, 'scramble(23) = 15');
  eq(scramblePalette(24), 24, 'scramble(24)');
  eq(scramblePalette(31), 31, 'scramble(31)');
  eq(scramblePalette(32), 32, 'scramble(32)（下一组）');
  eq(scramblePalette(255), 255, 'scramble(255)');

  // ★★ 关键：这个置换**自逆**（上游只有一个函数名，两个方向共用）
  for (let i = 0; i < 256; i++) {
    ok(unscramblePalette(scramblePalette(i)) === i, `置换自逆：p(p(${i})) === ${i}`);
    ok(scramblePalette(i) === unscramblePalette(i), `scramble(${i}) === unscramble(${i})（同一个置换）`);
  }
  // 与 Python 参考实现的 LUT 逐项一致（前 24 项是从 Python 抄下来的定值）
  eq(toHex(UNSCRAMBLE_LUT.slice(0, 24)), '0001020304050607101112131415161708090a0b0c0d0e0f',
    '★ UNSCRAMBLE_LUT[0..23] 与 Python 一致');
  eq(UNSCRAMBLE_LUT[8], 16, '★ UNSCRAMBLE_LUT[8] = 16（第一版移植在这里栽过：算成了 0）');
  eq(UNSCRAMBLE_LUT[16], 8, '★ UNSCRAMBLE_LUT[16] = 8');
  // 置换表与函数一致
  let lutOk = true;
  for (let i = 0; i < 256; i++) {
    if (UNSCRAMBLE_LUT[i] !== unscramblePalette(i)) lutOk = false;
    if (SCRAMBLE_LUT[i] !== scramblePalette(i)) lutOk = false;
  }
  ok(lutOk, 'SCRAMBLE_LUT / UNSCRAMBLE_LUT 与函数一致');
  // 置换是 256 项上的双射
  const seen = new Set<number>();
  for (let i = 0; i < 256; i++) seen.add(scramblePalette(i));
  eq(seen.size, 256, 'scramble 是 256 项上的双射');
  // 真·逆表 == 自己（自逆的证明）
  const inv = invertPalettePermutation(UNSCRAMBLE_LUT);
  eq(toHex(inv), toHex(UNSCRAMBLE_LUT), '★ 真·逆表与自身逐项相同 ⇒ 置换自逆');

  // packColor / unpackColor 互逆
  for (const c of [0, 0x12345678, 0xff00ff00, 0x00000080, 0xffffffff]) {
    const [r, g, b, a] = unpackColor(c);
    eq(packColor(r, g, b, a), c >>> 0, `packColor(unpackColor(0x${c.toString(16)}))`);
  }
  eq(packColor(0x12, 0x34, 0x56, 0x78), 0x12345678, 'packColor 字节序（r 在高位）');
}

function testBlankSaveAndHeaders(): void {
  section('makeBlankSave（两种布局都要写块头）');
  for (const isLr of [false, true]) {
    const tag = isLr ? 'LR' : '非LR';
    const save = makeBlankSave(isLr);
    eq(save.length, isLr ? LR_SAVE_SIZE : SAVE_SIZE, `${tag}: 空白块长度`);
    // ★ LR 也必须写 4 字节块头（Python 版曾漏掉 ⇒ 游戏直接卡死）
    if (isLr) {
      eq(toHex(save.slice(0, 4)), toHex(LR_EMBLEM_HEADER), `${tag}: ★ 空白块头 = 00 44 00 00`);
    } else {
      eq(toHex(save.slice(0, 12)), toHex(EMBLEM_HEADER), `${tag}: 空白块头 = 12 字节魔数`);
      eq(toHex(save.slice(0x0c, 0x14)), '0000000000000000', `${tag}: 0x0C..0x13 全 0`);
      eq(toHex(save.slice(0x14, 0x1d)), '000000000000000000', `${tag}: 不传 headerTail 时 0x14..0x1C = 0`);
      eq(toHex(save.slice(0x1d, 0x24)), '00000000000000', `${tag}: 0x1D..0x23 全 0`);
    }
    // 校验自洽
    eq(verifyChecksums(save).ok, true, `${tag}: 空白块 18 段校验自洽`);
    // 尾巴规则：全零 ⇒ 补成 01 00*9；alpha ⇒ 强制 0x80
    const alphaPos = FINAL_ALPHA_POS[isLr ? 'true' : 'false'];
    const checkPos = FINAL_CHECK_POS[isLr ? 'true' : 'false'];
    eq(save[alphaPos], PALETTE_ALPHA_OPAQUE, `${tag}: 空白块 alpha = 0x80`);
    eq(toHex(save.slice(checkPos + 1, checkPos + 1 + 10)), toHex(FINAL_TRAILER), `${tag}: 空白块尾巴 = 01 00*9`);
    // 同时满足上游写法
    eq(verifyChecksumsUpstream(save).ok, true, `${tag}: 空白块也满足上游写法`);
    // 幂等
    const again = Uint8Array.from(save);
    applyChecksums(again);
    eq(sha256(again), sha256(save), `${tag}: applyChecksums 幂等`);
  }

  // headerTail / lrHeader 参数
  const tail = Uint8Array.from([0x00, 0xa1, 0x30, 0xdd, 0x85, 0xab, 0x07, 0x80, 0x60]);
  const s = makeBlankSave(false, 0, true, tail);
  eq(toHex(s.slice(0x14, 0x1d)), toHex(tail), 'headerTail 被写进 0x14..0x1C');
  let threw = false;
  try {
    makeBlankSave(false, 0, true, Uint8Array.from([1, 2, 3]));
  } catch {
    threw = true;
  }
  ok(threw, 'headerTail 长度不对时必须报错');

  threw = false;
  try {
    makeBlankSave(true, 0, true, null, Uint8Array.from([1, 2, 3]));
  } catch {
    threw = true;
  }
  ok(threw, 'lrHeader 长度不对时必须报错');

  // base_offset（容器）
  const c = makeBlankSave(false, 0x120);
  eq(c.length, 0x120 + SAVE_SIZE, 'baseOffset 前置了多少字节');
  eq(findOffset(c), 0x120, 'findOffset 找到 baseOffset 处的块');
  eq(findOffsetContiguous(c), 0x120, 'findOffsetContiguous 一致');
  eq(verifyChecksums(c).ok, true, '容器里的空白块校验自洽');
}

function testTailRules(): void {
  section('末段尾巴规则（判定顺序）');
  // ① 全零 ⇒ 补 01 00*9
  const a = makeBlankSave(false);
  const alphaPos = FINAL_ALPHA_POS.false;
  const checkPos = FINAL_CHECK_POS.false;
  Uint8Array.prototype.fill.call(a, 0, alphaPos); // 把末段连同尾巴清零
  applyChecksums(a);
  eq(a[alphaPos], 0x80, '清零点后：alpha 被强制 0x80');
  eq(toHex(a.slice(checkPos + 1, checkPos + 11)), toHex(FINAL_TRAILER), '清零点后：尾巴补成 01 00*9');
  eq(verifyChecksums(a).ok, true, '清零点后：校验自洽');

  // ② 尾巴已有非零真值 ⇒ 原样保留（那是游戏写下的字段）
  const b = makeBlankSave(false);
  b[checkPos + 1] = 0x37;
  b[checkPos + 2] = 0x00;
  b[checkPos + 3] = 0x99;
  applyChecksums(b);
  eq(toHex(b.slice(checkPos + 1, checkPos + 11)), '37009900000000000000'.slice(0, 20), '尾巴有真值 ⇒ 保留');
  eq(verifyChecksums(b).ok, true, '尾巴保留时校验仍自洽（末段校验只吃 alpha 及之前的数据）');
  // ★ 此时"上游写法"也必须成立（尾部 X 01 00*9 让两式恒等；改尾巴会破坏它，这里改的是真值）
  // 上游写法吃的是"数据 + 校验之后的全部尾巴"，所以只要尾巴不是 01 00*9，两式就不等价 ——
  // 这里只断言"真实写法"通过（游戏判据），上游写法交给样本夹具去比。

  // ③ 上游那种"从空白块造"的写法在真实判据下必须不通过（差一个字节的证明）
  const z = makeBlankSave(false);
  Uint8Array.prototype.fill.call(z, 0, FINAL_ALPHA_POS.false);
  // 手写上游算法：末段校验写在 alpha 位（0x4434），输入 = 数据(0x4400..0x4433) + 之后的尾巴
  const zsegs = segmentLayout(false);
  for (let k = 0; k < 17; k++) {
    const seg = zsegs[k];
    z[seg.checkPos] = computeChecksum(z.slice(seg.start, seg.checkPos), seg.dataLen, seg.seed);
  }
  const finalSeg = zsegs[17];
  const head = z.slice(finalSeg.start, FINAL_ALPHA_POS.false);
  const tailAfter = z.slice(FINAL_ALPHA_POS.false + 1, SAVE_SIZE);
  const data = new Uint8Array(head.length + tailAfter.length);
  data.set(head, 0);
  data.set(tailAfter, head.length);
  z[FINAL_ALPHA_POS.false] = computeChecksum(data, finalSeg.dataLen - 1, 0);
  eq(verifyChecksumsUpstream(z).ok, true, '上游写法自洽（对照组）');
  eq(verifyChecksums(z).ok, false, '★ 上游写法在真实判据下必须不通过（这就是破損ファイル的根因）');
}

function testEncodeRoundTrip(): void {
  section('encodeEmblem 往返（提取 → 重新编码 → 再提取逐像素一致）');
  for (const isLr of [false, true]) {
    const tag = isLr ? 'LR' : '非LR';
    const w = 128;
    const h = 128;
    const img = new Uint8Array(w * h * 4);
    // 造一张确定性的图：80 种颜色 + 15% 全透明像素
    const colors: Array<[number, number, number]> = [];
    for (let i = 0; i < 80; i++) colors.push([(i * 7) & 0xff, (i * 13) & 0xff, (i * 29) & 0xff]);
    let seed = 12345;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed;
    };
    for (let i = 0; i < w * h; i++) {
      if (rnd() % 100 < 15) continue; // 保持全透明
      const c = colors[rnd() % colors.length];
      img[i * 4] = c[0];
      img[i * 4 + 1] = c[1];
      img[i * 4 + 2] = c[2];
      img[i * 4 + 3] = 0xff;
    }
    const tail9 = Uint8Array.from([0x00, 0xa1, 0x30, 0xdd, 0x85, 0xab, 0x07, 0x80, 0x60]);
    const blk = encodeEmblem(img, { isLr, headerTail: isLr ? null : tail9 });
    eq(blk.length, isLr ? LR_SAVE_SIZE : SAVE_SIZE, `${tag}: 编码结果长度`);
    eq(verifyChecksums(blk).ok, true, `${tag}: 编码结果 18 段校验`);
    eq(verifyChecksumsUpstream(blk).ok, true, `${tag}: 编码结果也满足上游写法`);
    const back = extractImage(blk, 'acet');
    eq(sha256(back), sha256(img), `${tag}: ★ 往返逐像素一致`);
    const backI0 = extractImage(blk, 'index0');
    eq(sha256(backI0), sha256(img), `${tag}: ★ index0 口径也往返一致（alpha 只有 0/255）`);

    // 未用调色板项填 00 00 00 80；槽 0 保持 00 00 00 00
    const io = isLr ? LR_IMAGE_OFFSET : IMAGE_OFFSET;
    const slot0 = [0, 1, 2, 3].map((ch) => blk[offsetIndex(io + NUM_PIXELS + ch, 0)]);
    eq(toHex(slot0), '00000000', `${tag}: 槽 0 保持 00 00 00 00`);
    let allOpaque = true;
    let alphaValues = new Set<number>();
    for (let k = 1; k < 256; k++) {
      const a = blk[offsetIndex(io + NUM_PIXELS + k * 4 + 3, 0)];
      alphaValues.add(a);
      if (a !== PALETTE_ALPHA_OPAQUE) allOpaque = false;
    }
    ok(allOpaque, `${tag}: 未用调色板项 alpha 一律 0x80（实到 ${Array.from(alphaValues).map((v) => v.toString(16)).join(',')}）`);
    // 填未用项不改变图像
    eq(sha256(extractImage(blk, 'index0')), sha256(img), `${tag}: fillUnused 不改变图像`);
    // usedPaletteSlots 与 injectPixelsToIndices 一致
    const { palette } = injectPixelsToIndices(img);
    eq(usedPaletteSlots(blk).length, palette.length, `${tag}: usedPaletteSlots = 量化出来的颜色数`);
  }
}

function testInjectionEdgeCases(): void {
  section('injectImage 的边界与错误行为');
  // 图像大小不对 ⇒ 报错
  let threw = false;
  try {
    injectImage(makeBlankSave(false), new Uint8Array(4));
  } catch {
    threw = true;
  }
  ok(threw, 'injectImage: 像素数不对必须报错');

  // ★ 颜色数上限的**精确**边界（全部由 Python 参考实现现算核对过）：
  //   palette_map 一开始就有 1 项（透明项 (0,0,0,0)），所以
  //     · 图像里有 255 种颜色 ⇒ map 最终 256 项 ⇒ 最多 256 色，**两者都不抛**
  //     · 图像里有 256 种颜色 ⇒ map 要加第 256 个新项（槽号 256）：
  //         strict=true  在第 257 项之前抛（`size >= 256`）
  //         strict=false 允许它进来（`size > 256` 这条判据要等到第 258 项）⇒ 槽 256
  //                      写进 1 字节索引被截断成 0 ⇒ 静默串色（实测 64 个像素被吃成透明）
  //     · 图像里有 257 种颜色 ⇒ 下一次插入时 `size > 256` 成立 ⇒ **两者都抛**
  const mkImg = (ncolors: number) => {
    const im = new Uint8Array(NUM_PIXELS * 4);
    for (let i = 0; i < NUM_PIXELS; i++) {
      const k = i % ncolors;
      im[i * 4] = k & 0xff;
      im[i * 4 + 1] = (k >> 8) & 0xff;
      im[i * 4 + 2] = 0;
      im[i * 4 + 3] = 0xff;
    }
    return im;
  };
  type Outcome = 'ok' | 'throw';
  const runInject = (ncolors: number, strict: boolean): Outcome => {
    try {
      injectImage(makeBlankSave(false), mkImg(ncolors), strict);
      return 'ok';
    } catch {
      return 'throw';
    }
  };
  eq(runInject(255, true), 'ok', '255 色 + strict=true ⇒ 不抛');
  eq(runInject(255, false), 'ok', '255 色 + strict=false ⇒ 不抛');
  eq(runInject(256, true), 'throw', '★ 256 色 + strict=true ⇒ 抛（第 257 项之前拦住）');
  eq(runInject(256, false), 'ok', '★ 256 色 + strict=false ⇒ 不抛（复刻上游静默截断）');
  eq(runInject(257, true), 'throw', '★ 257 色 ⇒ strict=true 抛');
  eq(runInject(257, false), 'throw', '★ 257 色 ⇒ strict=false **也**抛（上游 `size > 256` 的判据）');

  // 256 色 + strict=false 的产物必须**确实**串色（槽 256 截断成槽 0），这样才能证明
  // 我们复刻的是上游那条"静默失败"路径，而不是提前挡住了它。
  const spilled = makeBlankSave(false);
  injectImage(spilled, mkImg(256), false);
  const spilledSrc = mkImg(256);
  let truncatedToSlot0 = 0;
  for (let i = 0; i < NUM_PIXELS; i++) {
    if (spilled[offsetIndex(IMAGE_OFFSET + i, 0)] === 0 && spilledSrc[i * 4 + 3] === 0xff) truncatedToSlot0 += 1;
  }
  eq(truncatedToSlot0, 64, '★ 256 色 strict=false：64 个像素的索引被截断成槽 0（静默串色）');
  eq(sha256(extractImage(spilled, 'acet')) === sha256(spilledSrc), false,
    '★ 因此往返不一致 —— 这就是上游 256 色的失败方式');

  // alpha 不是 0xFF 的像素一律透明
  const img2 = new Uint8Array(NUM_PIXELS * 4);
  for (let i = 0; i < NUM_PIXELS; i++) {
    img2[i * 4] = 0x11;
    img2[i * 4 + 1] = 0x22;
    img2[i * 4 + 2] = 0x33;
    img2[i * 4 + 3] = 0xfe; // 不是 0xFF
  }
  const b2 = makeBlankSave(false);
  injectImage(b2, img2);
  const back2 = extractImage(b2, 'index0');
  let allTransparent = true;
  for (let i = 0; i < NUM_PIXELS; i++) if (back2[i * 4 + 3] !== 0) allTransparent = false;
  ok(allTransparent, 'injectImage: alpha !== 0xFF ⇒ 全透明');
}

function testExtractModeSemantics(): void {
  section("extractImage 三种 alpha 口径的语义");
  // 造一个 alpha 字节故意"奇怪"的块，验证三种口径的差别
  const blk = makeBlankSave(false);
  const io = IMAGE_OFFSET;
  const pal = (k: number, ch: number) => offsetIndex(io + NUM_PIXELS + k * 4 + ch, 0);
  // 槽 0：给一个非零 RGB，但仍应被 index0 口径当透明
  blk[pal(0, 0)] = 0xff;
  blk[pal(0, 1)] = 0xff;
  blk[pal(0, 2)] = 0xff;
  blk[pal(0, 3)] = 0x40;
  // 槽 1：alpha = 0x40（游戏里的"半透明/非零"）
  blk[pal(1, 0)] = 0x10;
  blk[pal(1, 1)] = 0x20;
  blk[pal(1, 2)] = 0x30;
  blk[pal(1, 3)] = 0x40;
  // 槽 2：alpha = 0x80
  blk[pal(2, 0)] = 0x10;
  blk[pal(2, 1)] = 0x20;
  blk[pal(2, 2)] = 0x30;
  blk[pal(2, 3)] = 0x80;
  // 槽 3：alpha = 0
  blk[pal(3, 0)] = 0x10;
  blk[pal(3, 1)] = 0x20;
  blk[pal(3, 2)] = 0x30;
  blk[pal(3, 3)] = 0x00;
  // 全部像素用槽 0
  for (let i = 0; i < NUM_PIXELS; i++) blk[offsetIndex(io + i, 0)] = 0;
  applyChecksums(blk);

  const a0 = extractImage(blk, 'index0');
  eq(a0[3], 0, "index0: 索引 0 ⇒ alpha 0（游戏口径：背景/透明）");
  eq(toHex([a0[0], a0[1], a0[2]]), 'ffffff', 'index0: RGB 仍按调色板取（不改成黑）');

  const aa = extractImage(blk, 'acet');
  eq(aa[3], 0xff, 'acet: 索引 0 的 alpha 0x40 非零 ⇒ 0xFF');
  eq(toHex([aa[0], aa[1], aa[2]]), 'ffffff', 'acet: RGB 不变');

  const ag = extractImage(blk, 'gs');
  eq(ag[3], Math.min(255, Math.floor((0x40 * 255) / 128)), 'gs: 0x40 → 127（GS 0..0x80 线性映射）');
  eq(Math.min(255, Math.floor((0x40 * 255) / 128)), 127, 'gs 参考值自证');

  // 把像素换成槽 1/2/3，看三种口径对 alpha 的处理
  for (let i = 0; i < NUM_PIXELS; i++) blk[offsetIndex(io + i, 0)] = UNSCRAMBLE_LUT[1];
  applyChecksums(blk);
  eq(extractImage(blk, 'index0')[3], 0xff, 'index0: 索引 1（非 0）⇒ alpha 0xFF');
  eq(extractImage(blk, 'acet')[3], 0xff, 'acet: alpha 0x40 非零 ⇒ 0xFF');
  eq(extractImage(blk, 'gs')[3], 127, 'gs: alpha 0x40 ⇒ 127');

  for (let i = 0; i < NUM_PIXELS; i++) blk[offsetIndex(io + i, 0)] = UNSCRAMBLE_LUT[3];
  applyChecksums(blk);
  eq(extractImage(blk, 'index0')[3], 0xff, 'index0: 槽 3 也按"非 0 ⇒ 不透明"');
  eq(extractImage(blk, 'acet')[3], 0x00, 'acet: 槽 3 的 alpha = 0 ⇒ 0x00');
  eq(extractImage(blk, 'gs')[3], 0x00, 'gs: 槽 3 的 alpha = 0 ⇒ 0');

  // 非法口径
  let threw = false;
  try {
    extractImage(blk, 'nope' as AlphaMode);
  } catch {
    threw = true;
  }
  ok(threw, 'extractImage: 非法 alphaMode 必须报错');
}

function testFindOffset(): void {
  section('findOffset（子序列搜索的坑）与 findOffsetContiguous');
  // 恰好是块大小 ⇒ 不搜索
  eq(findOffset(makeBlankSave(false)), 0, 'findOffset(0x4440) = 0（不搜索）');
  eq(findOffset(makeBlankSave(true)), 0, 'findOffset(0x4420) = 0（不搜索）');

  // 容器：块前有 baseOffset 个 0xAB 填充
  const base = 0x120;
  const cont = new Uint8Array(base + SAVE_SIZE + 0x40).fill(0xab);
  cont.set(makeBlankSave(false), base);
  eq(findOffset(cont), base, 'findOffset(容器) = 块起点');
  eq(findOffsetContiguous(cont), base, 'findOffsetContiguous(容器) = 块起点');

  // 太小的文件 ⇒ 报错
  let threw = false;
  try {
    findOffset(new Uint8Array(100));
  } catch {
    threw = true;
  }
  ok(threw, 'findOffset: 文件太小必须报错');

  // ⚠ 子序列 vs 连续：把魔数的字节"拆散"散布在文件里
  //   （每个魔数字节之间隔一个 0xFF；0x00 也是魔数里的字节，所以照样会推进 j）
  const evil = new Uint8Array(SAVE_SIZE + 64).fill(0xff);
  let p = 0x30;
  for (const b of EMBLEM_HEADER) {
    evil[p] = b;
    p += 2;
  }
  // Python 参考实现在这份数据上也**找不到** ⇒ 两边都必须报错
  let seqThrew = false;
  try {
    findOffset(evil);
  } catch {
    seqThrew = true;
  }
  ok(seqThrew, '★ findOffset(拆散的魔数) 也找不到 ⇒ 与 Python 一致地报错（子序列匹配不等于"随便散着也算"）');
  let contThrew = false;
  try {
    findOffsetContiguous(evil);
  } catch {
    contThrew = true;
  }
  ok(contThrew, '★ findOffsetContiguous 要求连续 ⇒ 找不到');

  // ★ 子序列与连续**真的不同**的情形：魔数被"别的 0x20/0x44..."打断后又能接上
  //   造法：把魔数头 4 字节 `20 44 00 00` 放好，中间插一段"能把 j 推回去"的字节，
  //   使得最终匹配的是**跨过中间噪声的 12 个字节**。
  //   这里用最直观的构造：文件里放 `20 44 00 00` 两次，然后把真正的头"斜着"铺开。
  //   简化判据：只断言两种搜索在同一份**连续**魔数上结果相同（现实里的存档都是这种）。
  const t2 = new Uint8Array(SAVE_SIZE + 0x200).fill(0);
  t2.set(EMBLEM_HEADER, 0x137);
  eq(findOffset(t2), 0x137, '连续魔数：findOffset');
  eq(findOffsetContiguous(t2), 0x137, '连续魔数：findOffsetContiguous 一致');

  // ⚠ Python 版循环结束前还有一次 `if j == len(EMBLEM_HEADER): return n - j`。
  //   它**不是**死代码：最后一次匹配发生在循环内、只把 j 推到 12 却不触发顶部的判断时，
  //   就会由循环之后这一段收尾。魔数恰好贴到文件末尾正是这种情况。
  //   （Python 现算：魔数贴末尾 → 0x4474 = n - 12；本实现必须一样。）
  const tailish = new Uint8Array(SAVE_SIZE + 32).fill(0);
  tailish.set(EMBLEM_HEADER, tailish.length - EMBLEM_HEADER.length);
  eq(findOffset(tailish), tailish.length - EMBLEM_HEADER.length,
    '★ 魔数贴在文件末尾：findOffset = n - 12（走循环之后那次收尾判断）');
  eq(findOffsetContiguous(tailish), tailish.length - EMBLEM_HEADER.length,
    '★ 同一份数据 findOffsetContiguous 也一致');

  // 找不到 ⇒ 报错
  threw = false;
  try {
    findOffset(new Uint8Array(SAVE_SIZE + 10));
  } catch {
    threw = true;
  }
  ok(threw, 'findOffset: 找不到魔数必须报错');

  // saveKind
  eq(saveKind(new Uint8Array(0)), 'unknown', "saveKind(空) = 'unknown'");
  eq(saveKind(new Uint8Array(SAVE_SIZE)), 'emblem-raw', "saveKind(0x4440) = 'emblem-raw'");
  eq(saveKind(new Uint8Array(LR_SAVE_SIZE)), 'emblem-lr', "saveKind(0x4420) = 'emblem-lr'");
  eq(saveKind(cont), 'container', "saveKind(带块的容器) = 'container'");
  eq(saveKind(new Uint8Array(SAVE_SIZE + 10)), 'unknown', "saveKind(大但没魔数) = 'unknown'");

  // findPaletteOffset 的复刻（含上游那两处缺陷）
  const fp = new Uint8Array(0x2000).fill(0xff);
  fp[0x100] = 0x00;
  fp[0x101] = 0x00;
  fp[0x102] = 0x00;
  fp[0x103] = 0x00;
  fp[0x100 + 7] = 0x80;
  fp[0x100 + 11] = 0x80;
  eq(findPaletteOffset(fp), 0x100, 'findPaletteOffset 命中');
  eq(findPaletteOffset(new Uint8Array(0x2000).fill(0xff)), null, 'findPaletteOffset 找不到 ⇒ null');
  // ⚠ 上游 `curr+i % 0x400 == 0x3FF` 因优先级 = `curr + i === 0x3FF`：
  //   只对"靠近文件开头"的位置生效。位置 0x3F7 时 curr+8 = 0x3FF ⇒ i=8 那一项会吃 off=1。
  const fp2 = new Uint8Array(0x3000).fill(0xff);
  const at = 0x3f7; // at + 11 = 0x402 > 0x3FF ⇒ 循环里会命中 off=1 的分支
  fp2[at] = 0;
  fp2[at + 1] = 0;
  fp2[at + 2] = 0;
  fp2[at + 3] = 0;
  fp2[at + 7] = 0x80;
  fp2[at + 11] = 0x80;
  eq(findPaletteOffset(fp2), at, 'findPaletteOffset 在 0x3FF 附近命中（含 off 位移）');
  // Python 参考实现在这两档上的取值（用 python 现算过）：
  eq(findPaletteOffset(new Uint8Array(0x3000).fill(0xff)), null, 'findPaletteOffset(全 FF) ⇒ null');
  const fp3 = new Uint8Array(0x3000).fill(0xff);
  fp3[0] = 0;
  fp3[1] = 0;
  fp3[2] = 0;
  fp3[3] = 0;
  fp3[7] = 0x80;
  fp3[11] = 0x80;
  eq(findPaletteOffset(fp3), 0, 'findPaletteOffset 在偏移 0 处命中');
}

function testFillUnusedPalette(): void {
  section('fillUnusedPalette / usedPaletteSlots');
  const img = new Uint8Array(NUM_PIXELS * 4);
  for (let i = 0; i < NUM_PIXELS; i++) {
    const k = i % 3;
    img[i * 4] = k * 40;
    img[i * 4 + 1] = k * 20;
    img[i * 4 + 2] = k * 60;
    img[i * 4 + 3] = 0xff;
  }
  const blk = makeBlankSave(false);
  injectImage(blk, img);
  // ⚠ 注意：k=0 是 (0,0,60,0x80) —— **不是**全零，所以它会拿到自己的槽（不是槽 0）。
  //   槽 0 只留给"完全透明的像素"。⇒ 3 种颜色各占一槽，共 3 个被引用槽。
  //   （Python 现算：used_palette_slots = [1, 2, 3]）
  const used = usedPaletteSlots(blk);
  eq(used.join(','), '1,2,3', '3 种颜色各占一槽（槽 0 只给全透明像素），被引用槽 = 1,2,3');
  eq(injectImageReturnedSlots(img).join(','), used.join(','), 'usedPaletteSlots 与量化结果一致');

  // fillUnusedPalette：填的项数 = 255 - 已用槽数（槽 0 永远不动）
  const beforeFill = extractImage(blk, 'index0');
  const filled = fillUnusedPalette(blk);
  eq(filled, 252, '★ 填了 252 项（255 - 3 个已用槽；槽 0 不动）');
  eq(extractImage(blk, 'index0').length, beforeFill.length, '图像长度不变');
  // ⚠ 填未用项**会改变末段校验的取值**（末段数据包含 palette[252..255]）——
  //   Python 版也是这样：fill_unused_palette() 之后**不会**自动重算校验，
  //   而末段（第 18 段）恰好覆盖到被填写的槽 ⇒ 校验暂时失效是**预期行为**。
  //   （Python 现算：fill 之后 verify 失败，seg17 got=0x4B want=0xCB；本实现同样。）
  eq(verifyChecksums(blk).ok, false, '★ 填未用项之后末段校验暂时失效（Python 亦然，属预期）');
  const badSeg = verifyChecksums(blk).badSegments;
  eq(badSeg.length, 1, '只有末段失效');
  eq(badSeg[0].name, 'seg17', '失效的是末段（它覆盖 palette 最后几项）');
  // 重算校验后恢复自洽，且图像不变
  applyChecksums(blk);
  eq(verifyChecksums(blk).ok, true, '填完之后 applyChecksums → 恢复自洽');
  eq(sha256(extractImage(blk, 'index0')), sha256(img), '填未用项不改变图像（往返仍一致）');
  // 槽 0 保持全 0（背景/透明）
  const io = IMAGE_OFFSET;
  eq(toHex([0, 1, 2, 3].map((ch) => blk[offsetIndex(io + NUM_PIXELS + ch, 0)])), '00000000',
    '槽 0 保持 00 00 00 00');
  // 1..255 里不在 used 的项都变成 00 00 00 80
  for (let k = 1; k < 256; k++) {
    if (used.includes(k)) continue;
    const px = [0, 1, 2, 3].map((ch) => blk[offsetIndex(io + NUM_PIXELS + k * 4 + ch, 0)]);
    eq(toHex(px), '00000080', `未用槽 ${k} 填成 00 00 00 80`);
  }
  // LR 也走同一套（乱序只在像素索引上体现）
  const blkLr = makeBlankSave(true);
  injectImage(blkLr, img);
  const usedLr = usedPaletteSlots(blkLr);
  eq(usedLr.join(','), '1,2,3', 'LR：3 种颜色各占一槽');
  eq(fillUnusedPalette(blkLr), 252, 'LR：填了 252 项');
}

/** usedPaletteSlots 的对照：直接按"图像里出现过哪些调色板槽"数一遍。 */
function injectImageReturnedSlots(image: Uint8Array): number[] {
  const { indices } = injectPixelsToIndices(image);
  const set = new Set<number>();
  for (const i of indices) set.add(UNSCRAMBLE_LUT[i]);
  return Array.from(set).sort((a, b) => a - b);
}

function testApplyChecksumsUpstreamComparison(): void {
  section('applyChecksums vs 上游直译（前 17 段必须相同，末段故意不同）');
  for (const isLr of [false, true]) {
    const tag = isLr ? 'LR' : '非LR';
    const a = makeBlankSave(isLr);
    // 上游直译：只改末段校验位置（用 Python 版同样的循环）
    const b = Uint8Array.from(a);
    const size = isLr ? LR_SAVE_SIZE : SAVE_SIZE;
    const dangling = isLr ? DANGLING_LR : DANGLING;
    let s = isLr ? SEED_LR : SEED;
    let prevCheck = 0;
    for (let i = 0; i < size; i++) {
      if ((i + 1) % BLOCK === 0) {
        s = (~(s + BLOCK_DATA) + 1) & 0xff;
        prevCheck = i;
        b[prevCheck] = s;
        s = 0;
      } else {
        s = (s + b[i]) & 0xff;
      }
    }
    const finalSeg = segmentLayout(isLr)[17];
    const head = a.slice(finalSeg.start, FINAL_ALPHA_POS[isLr ? 'true' : 'false']);
    const tailAfter = a.slice(FINAL_ALPHA_POS[isLr ? 'true' : 'false'] + 1, size);
    const joined = new Uint8Array(head.length + tailAfter.length);
    joined.set(head, 0);
    joined.set(tailAfter, head.length);
    b[prevCheck + dangling] = computeChecksum(joined, finalSeg.dataLen - 1, 0);

    eq(toHex(b.slice(0, 17 * BLOCK)), toHex(a.slice(0, 17 * BLOCK)), `${tag}: 前 17 段与上游直译逐字节相同`);
    eq(prevCheck + dangling, FINAL_ALPHA_POS[isLr ? 'true' : 'false'], `${tag}: 上游写的是 alpha 那一格`);
    eq(prevCheck + dangling + 1, FINAL_CHECK_POS[isLr ? 'true' : 'false'], `${tag}: 真实位置在它后一个字节`);
    eq(verifyChecksums(a).ok, true, `${tag}: 本实现写的块满足真实判据`);
    eq(verifyChecksumsUpstream(a).ok, true, `${tag}: 本实现写的块也满足上游判据`);
  }
}

function testContainerSamples(entries: Entry[]): void {
  section('真实容器的定位（PSV: findOffset 与 contiguous 一致）');
  // ① 夹具里记录的容器样本（由 make_fixtures.py 现算）
  for (const e of entries.filter((x) => x.checkBytes === undefined)) {
    const p = join(PROJ, e.path.split('/').join('\\'));
    const data = readFile(p);
    eq(data.length, e.size, `${e.path}: 容器大小`);
    eq(sha256(data), e.sha256, `${e.path}: 容器 SHA-256`);
    eq(saveKind(data), e.kind, `${e.path}: saveKind`);
    eq(findOffset(data), e.findOffset, `${e.path}: findOffset`);
    eq(findOffsetContiguous(data), e.findOffsetContiguous, `${e.path}: findOffsetContiguous`);
  }

  // ② 具体断言 PSV 的定位值，并把切出来的块与已有夹具比对
  const psvPath = join(PROJ, 'testdata', 'real', 'BASLUS-20644E02_AC3SL_Emblem3.PSV');
  const psv = readFile(psvPath);
  const off = findOffset(psv);
  eq(off, 0x154, 'PSV 里的徽章块起点 = 0x154');
  eq(findOffsetContiguous(psv), off, '真实容器里两者一致（字节是相邻的）');
  const blk = psv.slice(off, off + SAVE_SIZE);
  eq(verifyChecksums(blk).ok, true, '从 PSV 切出来的块 18 段校验通过');
  eq(sha256(blk), sha256(readFile(join(PROJ, 'testdata', 'real', 'BASLUS-20644E02_rawblock.raw'))),
    '★ PSV 里切出来的块与已有的 rawblock 夹具逐字节相同');
  // ⚠ 语义澄清：对容器**整体**做 18 段校验**会返回 true**，但这不是判据 ——
  //   `verifyChecksums` 只比对 18 个校验字节位置上的值，**不检查文件长度**；
  //   容器把块放在 0x154，这 18 个位置照样落在块内 ⇒ 通过。超出块的那截尾巴完全不看。
  //   （所以"verifyChecksums(容器) === true"并不代表"这是一个合法徽章存档"。
  //     要判断合法性得先 saveKind + 按块切片。）
  eq(verifyChecksums(psv).ok, true,
    '⚠ 容器整体做 18 段校验也会 true（因为不检查长度）——别拿它当"是不是合法存档"的判据');
  eq(saveKind(psv), 'container', '★ 判据是 saveKind = container + 按块切片后再校验');
}

function testRealSaveReconstruction(): void {
  section('★ 关键判据：apply_checksums 作用在真实存档上必须逐字节复原');
  // 直接把夹具里"逐字节复原"的那一项再显式断言一遍（不依赖 manifest 的字段名）
  const paths = [
    'testdata/real/BASLUS-20644E02_rawblock.raw',
    'testdata/real/BISLPS-25169E00.raw',
    'testdata/real/BISLPS-25169E01.raw',
    'testdata/real/BISLPS-25338E00.raw',
    'testdata/real/BISLPS-25338E01.raw',
    'testdata/real/BISLPS-25338E02.raw',
    'testdata/real/BISLPS-25338E03.raw',
    'testdata/real/BISLPS-25338E04.raw',
    'testdata/real/BISLPS-25462EMB_data0.raw',
    'testdata/real/BISLPS-25462EMB_data1.raw',
  ];
  for (const rel of paths) {
    const bytes = readFile(join(PROJ, rel.split('/').join('\\')));
    const cp = Uint8Array.from(bytes);
    applyChecksums(cp);
    eq(sha256(cp), sha256(bytes), `${rel}: 逐字节复原`);
    eq(verifyChecksums(bytes).ok, true, `${rel}: 18/18 校验`);
    eq(verifyChecksumsUpstream(bytes).ok, true, `${rel}: 上游写法也 18/18（两式对真实存档恒等）`);
    // 从零造一份：块头必须与真实存档一致
    const isLr = isLrSave(bytes);
    const tail9 = isLr ? null : headerTailFromSave(bytes);
    const re = encodeEmblem(extractImage(bytes, 'index0'), { isLr, headerTail: tail9, fillUnused: true });
    const n = isLr ? LR_EMBLEM_HEADER.length : IMAGE_OFFSET;
    eq(toHex(re.slice(0, n)), toHex(bytes.slice(0, n)), `${rel}: 从零造的块头与真实存档逐字节一致（前 ${n} 字节）`);
    eq(verifyChecksums(re).ok, true, `${rel}: 从零造的块 18 段校验通过`);
    eq(toHex(re.slice(FINAL_CHECK_POS[isLr ? 'true' : 'false'] + 1,
      FINAL_CHECK_POS[isLr ? 'true' : 'false'] + 11)), toHex(FINAL_TRAILER),
      `${rel}: 从零造的块尾巴 = 01 00*9`);
    // 提取 → 编码 → 提取必须逐像素一致（非 LR 的索引乱序 + LR 的直排都要对）
    const img = extractImage(bytes, 'index0');
    eq(sha256(extractImage(encodeEmblem(img, { isLr, headerTail: tail9 }), 'index0')), sha256(img),
      `${rel}: 提取→编码→提取 逐像素一致`);
  }
}

// --------------------------------------------------------------------------
// 主流程
// --------------------------------------------------------------------------
// --------------------------------------------------------------------------
// ★ 0.19 回归：扩容语义与域外参数（D22 / D25）
// --------------------------------------------------------------------------

/**
 * 这两组断言来自"深审核心层"那一轮，逐条对应一个**实测过的**现象：
 *
 *   · **D22**：代码里原来写着"Python 对越界赋值会静默扩容 bytearray" —— **那是错的**：
 *     Python 只有**切片赋值**才扩容（`b[0x4432:0x4434] = …`），**单下标越界抛 IndexError**
 *     （实测 Python 3.12：`bytearray(4)[0x4434]=1` → IndexError）。
 *     所以 `0x443F`（比 0x4440 差 1 字节）应当像 Python 那样补成 17472 且 18/18；
 *     而 `0x441F` 应当像 Python 一样**抛**，不许"凭空造出一个看起来合法的块"。
 *     另外 `injectImage()` 必须把扩容后的数组**交回调用方**（原先丢弃返回值 ⇒ 校验全没写进去）。
 *
 *   · **D25**：域外参数不许静默降级：`makeBlankSave(false, 1.5)` 原先会被
 *     `new Uint8Array(17473.5)` 截断成 17473 字节、`saveKind()` 变成 `container`；
 *     `injectPixelsToIndices()` 遇到第 257 个颜色时索引 256 会**回绕成 0**（实色变透明洞）。
 */
function testGrowthAndDomainSemantics(): void {
  section('★ 0.19 回归：单下标不扩容 / 切片赋值扩容 / 域外参数报错');

  // ── D22：0x443F ⇒ 靠"尾 10 字节切片赋值"补成 0x4440 且 18/18（Python 同结果）──
  {
    const short = new Uint8Array(SAVE_SIZE - 1); // 0x443F
    const out = applyChecksums(short);
    eq(out.length, SAVE_SIZE, '[D22] applyChecksums(0x443F)：返回值补到 0x4440');
    eq(short.length, SAVE_SIZE - 1, '[D22] 调用方那份**没有**被就地扩容（扩容只体现在返回值上）');
    eq(verifyChecksums(out).ok, true, '[D22] 补完的块 18/18');
  }

  // ── D22：0x441F（比末段 alpha 还短）⇒ 必须抛（Python 是 IndexError）──
  {
    let threw = false;
    let msg = '';
    try {
      applyChecksums(new Uint8Array(0x441f));
    } catch (e) {
      threw = true;
      msg = e instanceof Error ? e.message : String(e);
    }
    eq(threw, true, `[D22] applyChecksums(0x441F) 必须抛（不许凭空造块）${msg ? `：${msg}` : ''}`);
  }

  // ── D22：injectImage 把扩容后的数组交回调用方 ──
  {
    const img = new Uint8Array(NUM_PIXELS * 4);
    for (let i = 0; i < NUM_PIXELS; i++) {
      const k = i % 100;
      img[i * 4] = (k * 2) & 0xff; img[i * 4 + 1] = 0x40; img[i * 4 + 2] = 0x80;
      img[i * 4 + 3] = i % 7 === 0 ? 0 : 0xff;
    }
    const save = new Uint8Array(SAVE_SIZE - 1);
    const grown = injectImage(save, img);
    eq(grown.length, SAVE_SIZE, '[D22] injectImage 的返回值带着扩容后的长度');
    eq(verifyChecksums(grown).ok, true, '[D22] injectImage 之后 18/18（校验真的写进去了）');
  }

  // ── D25：makeBlankSave 的 baseOffset 必须是非负整数；LR + baseOffset 直接拒绝 ──
  {
    let threw1 = false;
    let threw2 = false;
    try { makeBlankSave(false, 1.5); } catch { threw1 = true; }
    try { makeBlankSave(true, 8); } catch { threw2 = true; }
    eq(threw1, true, '[D25] makeBlankSave(false, 1.5) 必须抛（原先静默截断成 17473 字节 ⇒ 判成 container）');
    eq(threw2, true, '[D25] makeBlankSave(true, baseOffset>0) 必须抛（isLrSave 只看总长度，带偏移必然判错档）');
  }

  // ── D25：injectPixelsToIndices 超过 256 项（含透明）必须抛，不许回绕成 0 ──
  {
    const img = new Uint8Array(NUM_PIXELS * 4);
    for (let i = 0; i < NUM_PIXELS; i++) {
      const k = i % 256; // 256 个不透明色 + 透明 = 需要 257 个槽位
      img[i * 4] = k; img[i * 4 + 1] = 0; img[i * 4 + 2] = 0; img[i * 4 + 3] = 0xff;
    }
    let threw = false;
    try { injectPixelsToIndices(img); } catch { threw = true; }
    eq(threw, true, '[D25] 256 个不透明色 ⇒ injectPixelsToIndices 必须抛（Python 也是 ValueError）');
  }

  // ── 顺带：D24 的两条"复制"契约（Uint8Array 路径） ──
  {
    const blk = new Uint8Array(SAVE_SIZE);
    blk.set(EMBLEM_HEADER, 0);
    const tail = headerTailFromSave(blk);
    const before = blk[HEADER_TAIL_OFF];
    tail[0] = before ^ 0xff;
    eq(blk[HEADER_TAIL_OFF], before, '[D24] headerTailFromSave 返回的是拷贝（改它不影响源存档）');
  }
}

function main(): number {
  console.log('=== 徽章格式核心：Python ↔ TypeScript 移植一致性测试 ===');
  console.log(`项目根: ${PROJ}`);

  const manifestPath = join(FIXTURES, 'manifest.json');
  let manifest: { count: number; entries: Entry[] };
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { count: number; entries: Entry[] };
  } catch (e) {
    console.error(`\n✗ 读不到夹具 ${manifestPath}\n  先跑: python web\\test\\make_fixtures.py\n  (${String(e)})`);
    return 1;
  }

  section(`① 夹具逐样本比对（${manifest.entries.length} 个样本）`);
  const emblems = manifest.entries.filter((e) => e.checkBytes !== undefined);
  console.log(`  其中徽章块/存档 ${emblems.length} 个，容器/其它 ${manifest.entries.length - emblems.length} 个`);
  for (const entry of manifest.entries) {
    if (entry.checkBytes === undefined) continue;
    const before = failures.length;
    testSample(entry);
    const okThis = failures.length === before;
    console.log(`  ${okThis ? '✓' : '✗'} ${entry.path}  (${entry.kind}, ${entry.isLr ? 'LR' : '非LR'})`);
  }

  // 自检
  testConstants();
  testSegmentLayout();
  testOffsetIndex();
  testPalettePermutation();
  testBlankSaveAndHeaders();
  testTailRules();
  testApplyChecksumsUpstreamComparison();
  testEncodeRoundTrip();
  testInjectionEdgeCases();
  testExtractModeSemantics();
  testFindOffset();
  testFillUnusedPalette();
  testContainerSamples(manifest.entries);
  testRealSaveReconstruction();
  testGrowthAndDomainSemantics();

  console.log('');
  if (failures.length > 0) {
    console.log('=== 不一致明细 ===');
    for (const f of failures) console.log(`  ✗ ${f}`);
  }
  const total = pass + failures.length;
  console.log(`=== 通过 ${pass} / ${total} ===`);
  return failures.length === 0 ? 0 : 1;
}

process.exitCode = main();
