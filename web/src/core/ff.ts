/**
 * AC: Formula Front（PS2 日版 `SLPS-25461`）徽章存档格式 —— 核心层（零依赖、可被浏览器直接 import）。
 *
 * 依据：2026-10-20 用户在游戏里存出的**唯一一份真实存档**
 *       `BISLPS-25461emb00\BISLPS-25461emb00`（17624 字节），逐字节核过；
 *       读出来的 128×128 像素与用户提供的预览图**完全一致**
 *       （样本与复算方法见 `testdata/real/BISLPS-25461emb00.md`）。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 【布局】（与 AC3 / SL / NX / LR 那套**完全不同**，别套用 `emblem.ts` 的结论）
 *
 *     0x0000..0x3FFF  128×128 索引图：1 像素 1 字节，行距 **128**，
 *                     **没有**校验字节穿插（这是与 0x4440 / 0x4420 布局最大的差别）
 *     0x4000..0x43FF  调色板 256 项 × 4 字节 `[R,G,B,A]`；索引 0 = 透明（A=0x00），其余 A=0xFF
 *     0x4400..0x44C7  200 字节元数据 —— **语义未定**（真实存档里只有 +0x18 是 `82 A0 00 00`，其余全 0）
 *     0x44C8..0x44D7  MD5 = md5(文件前 0x44C8 字节)，**原样 16 字节**、不是十六进制字符串
 *     文件总长        17624 = 0x44D8
 *
 * 【怎么定案的（可复算）】
 *   · 把 `[0, 0x44C8)` 喂给 MD5，输出的 16 字节与文件尾 16 字节**完全相同**
 *     ⇒ 末尾是 MD5，覆盖范围就是"除了它自己以外的全部字节"。
 *   · 用 0x4000 那一份 256 项调色板去解 0x0000..0x3FFF 的索引图，出来的就是用户图里那个
 *     「FFA」三角徽章（红/白/黑），**没有任何错位或乱序**。
 *   · 反方向：把解出来的 RGBA 再量化回同一份调色板、重算 MD5 ⇒ 与原文件**逐字节相同**
 *     （`web/test/core.test.ts` 的 (ff) 分节把这条钉住了）。
 *
 * 【★ 调色板为什么"只读不写"】
 *   真实存档里那 256 项是一个**完整的 16×16 规则色阶**（16 级灰 + 15 个色相 × 16 阶），
 *   连图像**没用到**的项也是规则色阶 —— 这说明它是游戏自己那张固定调色板，而不是
 *   "这次用了哪些颜色"的记录。既然游戏写的是它，本工具就**只在它上面量化**、不替换：
 *   写出去的文件在"调色板"这一维上与游戏产物同形，风险最小。
 *   （⇒ FF 的颜色上限就是游戏调色板那 256 色，与游戏内编辑器给的颜色范围一致。
 *     若将来实机证明游戏会读自定义调色板，再开一个"自带调色板"的档位 —— 不要现在猜。）
 *
 * 【★ 那 200 字节元数据】
 *   `0x4400..0x44C7` 的语义**没有定案**（只有 +0x18 的 `82 A0 00 00` 非零）。
 *   所以写入时**原样保留**（只改图像 + 重算 MD5）—— 不去猜、也不清零。
 *   这也意味着"从零造一份 FF 徽章"必须有一份真实存档当模板；没有模板就**拒绝写**
 *   （与 `games.ts::resolveHeaderTail` 对非 LR 作品常量的态度一致）。
 */

/** FF 徽章存档大小：17624 = 0x44D8。 */
export const FF_SAVE_SIZE = 0x44d8;
/** 索引图起点（就是文件开头，没有存档头）。 */
export const FF_IMAGE_OFF = 0x0000;
/** 调色板起点。 */
export const FF_PALETTE_OFF = 0x4000;
/** 调色板字节数（256 项 × 4 通道）。 */
export const FF_PALETTE_SIZE = 0x400;
/** 未定语义的元数据块起点。 */
export const FF_META_OFF = 0x4400;
/** 元数据块长度（到 MD5 之前）。 */
export const FF_META_LEN = 0xc8;
/** MD5 字段起点。 */
export const FF_MD5_OFF = 0x44c8;
/** MD5 字段长度。 */
export const FF_MD5_LEN = 16;
/** 图像边长（正方形）。 */
export const FF_IMAGE_WIDTH = 128;
export const FF_IMAGE_HEIGHT = 128;
/** 像素数 = 128×128。 */
export const FF_NUM_PIXELS = 0x4000;

/** FF 格式错误（独立于 `emblem.ts::EmblemFormatError`：两边布局无关，也避免循环 import）。 */
export class FfFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FfFormatError';
  }
}

/** 这份字节像不像 FF 徽章存档 —— 判据只有一条：长度**恰好** 0x44D8。 */
export function isFfSave(bytes: Uint8Array): boolean {
  return bytes.length === FF_SAVE_SIZE;
}

// --------------------------------------------------------------------------
// MD5（零依赖实现；只给 FF 存档用，输入恒为 0x44C8 字节）
// --------------------------------------------------------------------------
//
// ⚠ 浏览器有 crypto.subtle.digest('MD5') 吗？**没有** —— WebCrypto 只保证 SHA-1/256/384/512。
//   所以这里必须自带一份（否则"单文件、离线、零依赖"的约束就破了）。
//   实现是 RFC 1321 的标准写法，逐轮常量由 sin 生成（与参考实现同一来源，不抄表）。

const MD5_S = /* @__PURE__ */ (() =>
  Uint8Array.from([
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ]))();

const MD5_K = /* @__PURE__ */ (() => {
  const k = new Uint32Array(64);
  for (let i = 0; i < 64; i++) k[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0;
  return k;
})();

/** MD5(bytes) → 16 字节。纯函数，不改入参。 */
export function md5(bytes: Uint8Array): Uint8Array {
  const bitLen = bytes.length * 8;
  // 填充：0x80 + 若干 0x00，使 (长度 + 1 + pad) % 64 == 56，再补 8 字节小端位长
  const withPad = new Uint8Array((((bytes.length + 8) >> 6) + 1) << 6);
  withPad.set(bytes);
  withPad[bytes.length] = 0x80;
  const view = new DataView(withPad.buffer);
  // ⚠ 位长按 32 位两段写（超过 2^32 位的输入根本没机会出现：这里恒 0x44C8 字节）
  view.setUint32(withPad.length - 8, (bitLen >>> 0) & 0xffffffff, true);
  view.setUint32(withPad.length - 4, Math.floor(bitLen / 4294967296) >>> 0, true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  const m = new Uint32Array(16);
  for (let off = 0; off < withPad.length; off += 64) {
    for (let i = 0; i < 16; i++) m[i] = view.getUint32(off + i * 4, true);
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;
    for (let i = 0; i < 64; i++) {
      let f: number;
      let g: number;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) & 15;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) & 15;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) & 15;
      }
      const tmp = d;
      d = c;
      c = b;
      const sum = (a + f + MD5_K[i] + m[g]) >>> 0;
      const s = MD5_S[i];
      b = (b + (((sum << s) | (sum >>> (32 - s))) >>> 0)) >>> 0;
      a = tmp;
    }
    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }

  const out = new Uint8Array(16);
  const ov = new DataView(out.buffer);
  ov.setUint32(0, a0, true);
  ov.setUint32(4, b0, true);
  ov.setUint32(8, c0, true);
  ov.setUint32(12, d0, true);
  return out;
}

/** 这份存档应记录的 MD5 = md5(前 0x44C8 字节)。 */
export function ffPayloadMd5(save: Uint8Array): Uint8Array {
  if (save.length < FF_MD5_OFF) {
    throw new FfFormatError(
      'ffPayloadMd5: 缓冲区只有 ' + save.length + ' 字节，装不下前 0x' + FF_MD5_OFF.toString(16) + ' 字节',
    );
  }
  return md5(save.subarray(0, FF_MD5_OFF));
}

// --------------------------------------------------------------------------
// 校验
// --------------------------------------------------------------------------

export interface FfVerifyResult {
  ok: boolean;
  /** 文件里记的 16 字节。 */
  stored: Uint8Array;
  /** 现算的 16 字节。 */
  computed: Uint8Array;
  /** 第一个不同的字节下标（-1 = 全同）。 */
  firstDiff: number;
}

/** 核对末尾 MD5（不做其它判断；长度不对就抛）。 */
export function ffVerify(save: Uint8Array): FfVerifyResult {
  if (save.length !== FF_SAVE_SIZE) {
    throw new FfFormatError(
      'ffVerify: 长度 ' + save.length + ' ≠ ' + FF_SAVE_SIZE + '（0x' + FF_SAVE_SIZE.toString(16) + '），不是 FF 徽章存档',
    );
  }
  const stored = save.slice(FF_MD5_OFF, FF_MD5_OFF + FF_MD5_LEN);
  const computed = ffPayloadMd5(save);
  let firstDiff = -1;
  for (let i = 0; i < FF_MD5_LEN; i++) {
    if (stored[i] !== computed[i]) {
      firstDiff = i;
      break;
    }
  }
  return { ok: firstDiff < 0, stored, computed, firstDiff };
}

/**
 * 把 MD5 结论折成 `emblem.ts::VerifyResult` 的形状，好让它走同一条"回读自检"通道
 * （`logic/writeGuard.ts::verifyWrite` 只认 `{ok, badSegments}`）。
 *
 * 合成出一条 `badSegments`：名字 `MD5`、偏移 = MD5 字段起点 + 第一处不同、got/expect = 那两个字节。
 */
export function ffVerifyChecksums(save: Uint8Array): {
  ok: boolean;
  badSegments: Array<{ name: string; offset: number; got: number; expect: number }>;
} {
  const v = ffVerify(save);
  if (v.ok) return { ok: true, badSegments: [] };
  return {
    ok: false,
    badSegments: [
      {
        name: 'MD5',
        offset: FF_MD5_OFF + v.firstDiff,
        got: v.stored[v.firstDiff],
        expect: v.computed[v.firstDiff],
      },
    ],
  };
}

// --------------------------------------------------------------------------
// 取图 / 写入
// --------------------------------------------------------------------------

/** 这份存档的调色板原始 1024 字节（复制）。 */
export function ffPalette(save: Uint8Array): Uint8Array {
  if (!isFfSave(save)) throw new FfFormatError('ffPalette: 长度 ' + save.length + ' 不是 FF 徽章存档');
  return new Uint8Array(save.subarray(FF_PALETTE_OFF, FF_PALETTE_OFF + FF_PALETTE_SIZE));
}

/**
 * 把 FF 存档解成 128×128 RGBA8888。
 *
 * 口径：**索引 0 = 透明**（它的调色板项 A 本来就是 0x00），其余项按存下来的 A 原样给
 * （真实存档里都是 0xFF）。⇒ 与 AC 那边 `'index0'` 档位是同一个眼睛口径。
 */
export function ffExtractImage(save: Uint8Array): Uint8Array {
  if (!isFfSave(save)) throw new FfFormatError('ffExtractImage: 长度 ' + save.length + ' 不是 FF 徽章存档');
  const out = new Uint8Array(FF_NUM_PIXELS * 4);
  for (let i = 0; i < FF_NUM_PIXELS; i++) {
    const idx = save[FF_IMAGE_OFF + i];
    const o = FF_PALETTE_OFF + idx * 4;
    out[i * 4] = save[o];
    out[i * 4 + 1] = save[o + 1];
    out[i * 4 + 2] = save[o + 2];
    out[i * 4 + 3] = idx === 0 ? 0 : save[o + 3];
  }
  return out;
}

/** 调色板里**不透明**的项号（A ≠ 0）—— 量化的候选集。索引 0 不在里面。 */
export function ffOpaqueSlots(save: Uint8Array): number[] {
  if (!isFfSave(save)) throw new FfFormatError('ffOpaqueSlots: 长度 ' + save.length + ' 不是 FF 徽章存档');
  const out: number[] = [];
  for (let k = 1; k < 256; k++) {
    if (save[FF_PALETTE_OFF + k * 4 + 3] !== 0) out.push(k);
  }
  return out;
}

/**
 * 把 128×128 RGBA 量化到**这份存档自己的调色板**里，就地写索引，然后重算 MD5。
 *
 * 规则：
 *   · alpha < 128 ⇒ 索引 0（透明）；
 *   · 否则在"不透明项"里找 RGB 欧氏距离最近的那个（同色缓存，128×128 最多 16384 次）；
 *   · **调色板与元数据一个字节都不动**（理由见文件头"调色板为什么只读不写"）。
 *
 * 返回**同一个** `save`（就地改），方便调用方接着做回读自检。
 */
export function ffInjectImage(save: Uint8Array, rgba: Uint8Array): Uint8Array {
  if (!isFfSave(save)) throw new FfFormatError('ffInjectImage: 长度 ' + save.length + ' 不是 FF 徽章存档');
  if (rgba.length !== FF_NUM_PIXELS * 4) {
    throw new FfFormatError(
      'ffInjectImage: 图像必须是 ' + FF_NUM_PIXELS + ' 像素（128×128），收到 ' + rgba.length / 4,
    );
  }
  const slots = ffOpaqueSlots(save);
  if (slots.length === 0) {
    throw new FfFormatError('ffInjectImage: 这份存档的调色板里一个不透明项都没有，无法量化（模板坏了？）');
  }
  const cache = new Map<number, number>();
  for (let i = 0; i < FF_NUM_PIXELS; i++) {
    if (rgba[i * 4 + 3] < 128) {
      save[FF_IMAGE_OFF + i] = 0;
      continue;
    }
    const r = rgba[i * 4];
    const g = rgba[i * 4 + 1];
    const b = rgba[i * 4 + 2];
    const key = (r << 16) | (g << 8) | b;
    let hit = cache.get(key);
    if (hit === undefined) {
      let best = slots[0];
      let bestD = Infinity;
      for (const k of slots) {
        const o = FF_PALETTE_OFF + k * 4;
        const dr = r - save[o];
        const dg = g - save[o + 1];
        const db = b - save[o + 2];
        const d = dr * dr + dg * dg + db * db;
        if (d < bestD) {
          bestD = d;
          best = k;
          if (d === 0) break;
        }
      }
      hit = best;
      cache.set(key, hit);
    }
    save[FF_IMAGE_OFF + i] = hit;
  }
  save.set(ffPayloadMd5(save), FF_MD5_OFF);
  return save;
}

/**
 * ★ 推荐入口：把 128×128 RGBA 编成一份 FF 徽章存档。
 *
 * `template` 必须是**卡上一份真实的 FF 存档**（或它的一份拷贝）——调色板与那 200 字节元数据
 * 都从它继承。**没有模板就拒绝**（`null` 会抛 `FfFormatError`）：
 * 那两块的语义没有定案，凭空造一份与"猜 9 字节作品常量"是同一类错误。
 */
export function ffEncodeEmblem(rgba: Uint8Array, template: Uint8Array | null | undefined): Uint8Array {
  if (!template) {
    throw new FfFormatError(
      'ffEncodeEmblem: 没有模板存档 —— FF 的调色板与元数据必须从卡上一份真实 FF 徽章继承，不能凭空造',
    );
  }
  if (!isFfSave(template)) {
    throw new FfFormatError(
      'ffEncodeEmblem: 模板长度 ' + template.length + ' 不是 ' + FF_SAVE_SIZE + '（0x' + FF_SAVE_SIZE.toString(16) + '）',
    );
  }
  const out = new Uint8Array(template);
  return ffInjectImage(out, rgba);
}

/**
 * ★ 0.48：把 `icon.sys` 标题里那两个**全角数字**改成指定槽号（1 起）。
 *
 * 真实 `BISLPS-25461emb00\icon.sys` 的标题字段（0xC0 起）是 **Shift-JIS**、不是常见的 UTF-16LE：
 *
 *     ８２ 60 ８２ 62 ８２ 65 ８２ 65 ８３ 47 83 93 83 75 83 8c 83 80 83 66 81 5b 83 5e ８２ 4f ８２ 50 00
 *     Ａ        Ｃ        Ｆ        Ｆ        エ    ン    ブ    レ    ム    デ    ー    タ    ０        １
 *
 * （同卡的 `BISLPS-25461sav00\icon.sys` 是 `ＡＣＦＦデータ０１`，同一套写法。）
 * ⇒ **新建槽**时只改末尾那两个全角数字，其它字节一个不动 —— 这样与游戏给第 N 槽写的标题同形。
 *
 * `slotNumber1` 是**1 起的槽号**（`emb00` → 1）。找不到那两个数字就抛（模板不是 FF 的 icon.sys）。
 */
export function ffRetitleIconSys(iconSys: Uint8Array, slotNumber1: number): Uint8Array {
  if (!Number.isInteger(slotNumber1) || slotNumber1 < 1 || slotNumber1 > 99) {
    throw new FfFormatError('ffRetitleIconSys: 槽号必须是 1..99 的整数（收到 ' + slotNumber1 + '）');
  }
  const start = 0xc0; // PS2 icon.sys 的标题字段偏移（本作写的是 Shift-JIS，见上）
  if (iconSys.length < start + 6) {
    throw new FfFormatError('ffRetitleIconSys: 文件只有 ' + iconSys.length + ' 字节，不像 icon.sys');
  }
  const out = new Uint8Array(iconSys);
  let end = start;
  while (end < out.length && end < start + 144 && out[end] !== 0) end += 1;
  // 从标题末尾往前找两个连续的全角数字（Shift-JIS 0x824F..0x8258 = ０..９）
  const digits: number[] = [];
  for (let i = end - 2; i >= start && digits.length < 2; i -= 2) {
    if (out[i] === 0x82 && out[i + 1] >= 0x4f && out[i + 1] <= 0x58) {
      digits.unshift(out[i + 1] - 0x4f);
    } else {
      break;
    }
  }
  if (digits.length !== 2) {
    throw new FfFormatError('ffRetitleIconSys: 标题里找不到两个全角数字（这不像 FF 的 icon.sys）');
  }
  const text = String(slotNumber1).padStart(2, '0');
  const at = end - 4;
  out[at] = 0x82;
  out[at + 1] = 0x4f + Number(text[0]);
  out[at + 2] = 0x82;
  out[at + 3] = 0x4f + Number(text[1]);
  return out;
}

/** 尽力判断一份字节是不是"像 FF 徽章存档"（长度对 + MD5 对）。给夹具 / 自检用。 */
export function ffLooksValid(save: Uint8Array): boolean {
  if (!isFfSave(save)) return false;
  try {
    return ffVerify(save).ok;
  } catch {
    return false;
  }
}
