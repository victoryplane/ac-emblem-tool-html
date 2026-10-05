/**
 * PCSX2 自检 —— 纯逻辑，零依赖、不碰 DOM。
 *
 * 逻辑**逐条照抄** `tools\check_pcsx2_slots.py` 的结论（那是本项目自己实测出来的）：
 *
 *   1. 全局设置 `inis\PCSX2.ini` → `[MemoryCards] Slot1_Filename` / `Slot2_Filename`
 *      （就是「设置 → 记忆卡插槽」对话框写的那个文件）。
 *   2. **每游戏设置 `gamesettings\<序列号>_<CRC>.ini` 会覆盖全局设置** —— 它赢。
 *   3. `logs\emulog.txt` 里 `McdSlot N [File]: xxx.ps2` 才是**事实**，不是设置。
 *   4. ★ 警告：某个每游戏 ini 把 Slot N 钉死成 A，而全局是 B ⇒
 *      **"我在对话框里挂的是哪张卡" ≠ "游戏读的是哪张卡"**。
 *      （本项目实测踩过，见 SPEC.md §三 与 `check_pcsx2_slots.py` 顶部的两个 PCSX2 issue）
 *
 * ⚠ 与 Python 版的三处**刻意差异**（都在这里写明，别当 bug）：
 *   · Python 用 `configparser`，本实现用逐行状态机 —— 因为 `file://` 下只能拿到**文本**，
 *     而且拖进来的 ini 可能是 CRLF / 带 BOM / 键名大小写混写。
 *   · Python 只读 `Slot1/Slot2`（`SLOTS = (1, 2)`）；本实现接受 `Slot1..Slot8`，
 *     但**只把 1/2 当"模拟器界面的两个槽"**（PCSX2 只有两个插槽）。
 *   · 界面 Slot1 = 日志里的 `McdSlot 0`；Slot2 = `McdSlot 1`。
 */

export const PCSX2_SLOTS: readonly number[] = [1, 2];
/** 界面 Slot N → 日志里的 McdSlot 号。 */
export const MCD_SLOT_OF: Record<number, number> = { 1: 0, 2: 1 };

export interface SlotSetting {
  /** true = `SlotN_Enable` 不是 false（缺省视为启用，与 Python 一致）。 */
  enabled: boolean;
  /** 记忆卡文件名（可能是相对 `memcards\` 的文件名，也可能是绝对路径）。 */
  fileName: string;
}

export interface IniFileLike {
  /** 文件名（`PCSX2.ini` / `SLPS-25462_FEBEC38B.ini`）。 */
  name: string;
  /** 文件文本内容。 */
  text: string;
}

export interface BootRecord {
  /** `ELF changed, active CRC XXXXXXXX` 里的 CRC（大写十六进制）。 */
  crc: string;
  /** `McdSlot N [File]: xxx [备注]`。 */
  mcd: Array<{ slot: number; fileName: string; note: string }>;
  /** `isoFile open ok: …`。 */
  iso: string | null;
  /** `Serial: XXXX-XXXXX`。 */
  serial: string | null;
}

export interface EffectiveSlot {
  slot: number;
  /** 生效的记忆卡文件名（空字符串 = 没设置）。 */
  fileName: string;
  /** `'game'`（每游戏覆盖）/ `'global'`（全局）/ `'unset'`。 */
  source: 'game' | 'global' | 'unset';
  /** 覆盖它的每游戏 ini 文件名（`source === 'game'` 时）。 */
  sourceFile: string | null;
  enabled: boolean;
}

export interface Conflict {
  /** 每游戏 ini 文件名。 */
  file: string;
  slot: number;
  /** 每游戏钉死的卡。 */
  gameValue: string;
  /** 全局设置里的卡。 */
  globalValue: string;
}

export interface ActualMount {
  /** 界面的 Slot 号（1/2）。 */
  slot: number;
  /** 日志里实际挂的卡文件名。 */
  fileName: string;
  note: string;
  /** 当前配置推断出来的值（可能不同 —— 那就说明设置只在**下次**启动生效）。 */
  expected: string;
  /** 实际 ≠ 推断。 */
  differs: boolean;
}

export interface Pcsx2Report {
  /** `inis\PCSX2.ini` 的 `[MemoryCards]`（键 1/2）。 */
  global: Record<number, SlotSetting>;
  /** 每游戏覆盖：文件名 → { 槽 → 设置 }。 */
  overrides: Record<string, Record<number, SlotSetting>>;
  /** emulog 的启动记录（按时间正序）。 */
  boots: BootRecord[];
  /** 最后一次启动（无则 null）。 */
  lastBoot: BootRecord | null;
  /** 下一次启动**实际**会读哪张卡（按配置推断）。 */
  effective: EffectiveSlot[];
  /** 「每游戏覆盖 vs 全局」冲突。 */
  conflicts: Conflict[];
  /** 日志 vs 推断 的差异（只比最后一次启动）。 */
  actualMounts: ActualMount[];
  /** 用户拖进来的文件里有哪些被认出来了（界面显示用）。 */
  recognized: string[];
  /** 红色警告（人话）。 */
  warnings: string[];
  /** 提示级别的话（不是错误）。 */
  notes: string[];
}

// --------------------------------------------------------------------------
// ini 解析
// --------------------------------------------------------------------------

function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/** 逐行取 `[section]` 下的键值。键名大小写**不敏感**（PCSX2 实际写的是精确大小写）。 */
export function parseIni(text: string): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  let section = '';
  const lines = stripBom(text).split(/\r\n|\r|\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;
    const sm = /^\[(.+?)\]$/.exec(line);
    if (sm) {
      section = sm[1].trim().toLowerCase();
      if (!out[section]) out[section] = {};
      continue;
    }
    const eq = line.indexOf('=');
    if (eq < 0 || !section) continue;
    const key = line.slice(0, eq).trim().toLowerCase();
    const val = line.slice(eq + 1).trim();
    out[section][key] = val;
  }
  return out;
}

function parseBool(v: string | undefined, dflt = true): boolean {
  if (v === undefined) return dflt;
  const s = v.trim().toLowerCase();
  if (s === 'false' || s === '0' || s === 'off' || s === 'no') return false;
  if (s === 'true' || s === '1' || s === 'on' || s === 'yes') return true;
  return dflt;
}

/** 从 ini 文本里取 `[MemoryCards]` 的槽位设置；没有的槽不出现。 */
export function memoryCardSlots(iniText: string): Record<number, SlotSetting> {
  const ini = parseIni(iniText);
  const mc = ini['memorycards'];
  const out: Record<number, SlotSetting> = {};
  if (!mc) return out;
  for (const key of Object.keys(mc)) {
    const m = /^slot(\d+)_filename$/.exec(key);
    if (!m) continue;
    const slot = Number(m[1]);
    if (!Number.isInteger(slot) || slot < 1 || slot > 8) continue;
    out[slot] = {
      enabled: parseBool(mc[`slot${slot}_enable`], true),
      fileName: mc[key].trim(),
    };
  }
  // `SlotN_Enable` 有、`SlotN_Filename` 没有 ⇒ 视为空
  for (const key of Object.keys(mc)) {
    const m = /^slot(\d+)_enable$/.exec(key);
    if (!m) continue;
    const slot = Number(m[1]);
    if (out[slot]) continue;
    out[slot] = { enabled: parseBool(mc[key], true), fileName: '' };
  }
  return out;
}

// --------------------------------------------------------------------------
// emulog 解析
// --------------------------------------------------------------------------

/**
 * 按「每次启动」切分 emulog，返回全部启动记录（正序）。
 *
 * 一次启动的边界 = `ELF changed, active CRC XXXXXXXX`。
 * ★ 为什么必须按启动分组（`check_pcsx2_slots.py` 的注释）：日志在整个 PCSX2 进程
 *   生命周期里是累积的，不分组就会把几十次旧启动的插卡记录混在一起，
 *   得出"卡一直在换"的假象。
 * ★ `Serial` / `isoFile` / `McdSlot` 都出现在 `ELF changed` **之前** ⇒ 它们属于
 *   "结束于该 CRC 行"的那一段。
 */
export function parseEmulog(text: string): BootRecord[] {
  const lines = stripBom(text).split(/\r\n|\r|\n/);
  const boots: BootRecord[] = [];
  let segStart = 0;
  const flush = (endExclusive: number): void => {
    const s = lines.slice(segStart, endExclusive);
    if (!s.length) return;
    let serial: string | null = null;
    let iso: string | null = null;
    const mcd: BootRecord['mcd'] = [];
    for (const l of s) {
      let m = /(?:^|[^A-Za-z])Serial:\s*(\S+)/.exec(l);
      if (m) serial = m[1].trim();
      m = /isoFile open ok: (.+)$/.exec(l);
      if (m) iso = m[1].trim();
      m = /McdSlot (\d) \[File\]: (\S+)(?: \[([^\]]*)\])?/.exec(l);
      if (m) mcd.push({ slot: Number(m[1]), fileName: m[2], note: (m[3] ?? '').trim() });
    }
    boots.push({ crc: '', mcd, iso, serial });
  };
  for (let i = 0; i < lines.length; i++) {
    const m = /ELF changed, active CRC ([0-9A-Fa-f]{8})/.exec(lines[i]);
    if (!m) continue;
    const before = boots.length;
    flush(i + 1);
    if (boots.length > before) boots[boots.length - 1].crc = m[1].toUpperCase();
    segStart = i + 1;
  }
  // 最后一次 `ELF changed` 之后的插卡记录 = 本次运行中途的热插拔
  if (boots.length) {
    for (let i = segStart; i < lines.length; i++) {
      const m = /McdSlot (\d) \[File\]: (\S+)(?: \[([^\]]*)\])?/.exec(lines[i]);
      if (m) boots[boots.length - 1].mcd.push({ slot: Number(m[1]), fileName: m[2], note: (m[3] ?? '').trim() });
    }
  }
  return boots;
}

// --------------------------------------------------------------------------
// 汇总
// --------------------------------------------------------------------------

/**
 * 关键判据（与 Python 一致）：每游戏 ini 的文件名是 `<序列号>_<CRC>.ini`；
 * 序列号可能只在日志更早的地方出现 ⇒ 退化为按 CRC 找。
 */
export function pickGameIni(overrides: Record<string, Record<number, SlotSetting>>, boot: BootRecord | null): string | null {
  if (!boot || !boot.crc) return null;
  if (boot.serial) {
    const exact = `${boot.serial}_${boot.crc}.ini`;
    if (overrides[exact]) return exact;
  }
  const cand = Object.keys(overrides).find((k) => k.toUpperCase().endsWith(`_${boot.crc}.INI`));
  return cand ?? null;
}

export function analyzePcsx2(input: {
  /** 拖进来（或从 PCSX2 目录读到）的文件。 */
  files: readonly IniFileLike[];
  /** emulog 文本（可选）。 */
  emulog?: string | null;
}): Pcsx2Report {
  const recognized: string[] = [];
  const warnings: string[] = [];
  const notes: string[] = [];

  let global: Record<number, SlotSetting> = {};
  const overrides: Record<string, Record<number, SlotSetting>> = {};
  let emulogText: string | null = input.emulog ?? null;

  for (const f of input.files) {
    const base = f.name.replace(/^.*[\\/]/, '');
    const low = base.toLowerCase();
    if (low === 'pcsx2.ini') {
      global = memoryCardSlots(f.text);
      recognized.push(`${base}（全局设置）`);
      continue;
    }
    if (low === 'emulog.txt' || low === 'emulog.log') {
      emulogText = f.text;
      recognized.push(`${base}（运行日志）`);
      continue;
    }
    if (low.endsWith('.ini')) {
      const mc = memoryCardSlots(f.text);
      if (Object.keys(mc).length > 0) {
        overrides[base] = mc;
        recognized.push(`${base}（每游戏覆盖）`);
      } else {
        recognized.push(`${base}（没有 [MemoryCards]，忽略）`);
      }
      continue;
    }
    recognized.push(`${base}（不认识，已忽略）`);
  }

  const boots = emulogText ? parseEmulog(emulogText) : [];
  const lastBoot = boots.length ? boots[boots.length - 1] : null;
  const key = pickGameIni(overrides, lastBoot);

  // ── 生效表 ──
  const effective: EffectiveSlot[] = [];
  for (const s of PCSX2_SLOTS) {
    const ov = key ? overrides[key]?.[s] : undefined;
    if (ov) {
      effective.push({ slot: s, fileName: ov.fileName, source: 'game', sourceFile: key, enabled: ov.enabled });
    } else if (global[s]) {
      effective.push({
        slot: s,
        fileName: global[s].fileName,
        source: 'global',
        sourceFile: null,
        enabled: global[s].enabled,
      });
    } else {
      effective.push({ slot: s, fileName: '', source: 'unset', sourceFile: null, enabled: false });
    }
  }

  // ── 冲突（每游戏 vs 全局）──
  const conflicts: Conflict[] = [];
  for (const [file, mc] of Object.entries(overrides)) {
    for (const sStr of Object.keys(mc)) {
      const s = Number(sStr);
      const g = global[s];
      if (!g || g.fileName === undefined) continue;
      if (g.fileName !== mc[s].fileName) {
        conflicts.push({ file, slot: s, gameValue: mc[s].fileName, globalValue: g.fileName });
      }
    }
  }
  for (const c of conflicts) {
    warnings.push(
      `★★ ${c.file} 把 Slot ${c.slot} 钉死在「${c.gameValue || '(空)'}」，而全局设置里是「${c.globalValue || '(空)'}」。` +
        `⇒ 游戏读到的是「${c.gameValue || '(空)'}」，不是你对话框里选的那张。` +
        `改法：编辑该 ini，删掉 [MemoryCards] 的 Slot${c.slot}_Filename 行（先备份），` +
        `或在模拟器里用 Game Properties → reset 取消该覆盖。`,
    );
  }
  if (Object.keys(overrides).length === 0) notes.push('没有任何游戏覆盖记忆卡设置 ✅');

  // ── 日志 vs 推断 ──
  const actualMounts: ActualMount[] = [];
  if (lastBoot) {
    const got: Record<number, { fileName: string; note: string }> = {};
    for (const m of lastBoot.mcd) got[m.slot] = { fileName: m.fileName, note: m.note };
    for (const s of PCSX2_SLOTS) {
      const real = got[MCD_SLOT_OF[s]];
      if (!real) continue;
      const want = effective.find((e) => e.slot === s)?.fileName ?? '';
      const differs = (want || '') !== real.fileName;
      actualMounts.push({ slot: s, fileName: real.fileName, note: real.note, expected: want, differs });
      if (differs) {
        notes.push(
          `上次启动 McdSlot ${MCD_SLOT_OF[s]} 实际挂的是「${real.fileName}」，而现在配置推断是「${want || '(空)'}」` +
            `（若你刚改过设置，这条属正常：设置对**下一次**启动生效）。`,
        );
      }
    }
    if (boots.length > 1) notes.push(`本次进程共 ${boots.length} 次启动；以上只列最后一次。`);
    if (lastBoot.serial || lastBoot.crc) {
      notes.push(`上次运行的游戏：Serial=${lastBoot.serial ?? '(未知)'}  CRC=${lastBoot.crc || '(未知)'}`);
    }
    if (lastBoot.iso) notes.push(`上次运行的 ISO：${lastBoot.iso}`);
  } else if (emulogText) {
    notes.push('emulog 里没找到 `ELF changed, active CRC` —— 可能还没启动过游戏。');
  }
  if (key) {
    notes.push(
      `生效的每游戏配置：gamesettings\\${key}` +
        (overrides[key] ? '' : '（该文件不存在 ⇒ 纯用全局设置）'),
    );
  }

  return { global, overrides, boots, lastBoot, effective, conflicts, actualMounts, recognized, warnings, notes };
}
