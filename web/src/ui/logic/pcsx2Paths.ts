/**
 * PCSX2 自检的**路径与文件匹配**规则 —— 纯逻辑、零 DOM，可 Node 直接测。
 *
 * 为什么单独一个文件：这部分决定"用户点一次目录选择之后，我们到底读到哪几个文件"，
 * 是**必须能自动回归**的东西（`ui.test.ts` 会拿假的 `webkitRelativePath` 断言）。
 *
 * ## 背景（为什么不能"默认按路径读"）
 *
 * `file://` 页面**不能凭路径读本地文件** —— 这是浏览器的规定，不是我们的选择。
 * 所以"默认找到 `C:\Users\M\Documents\PCSX2`"只能做成
 * "**一次点击到位 + 记住上次的位置**"：
 *   · 目录选择框用 `id: 'pcsx2'`（Chrome 会记住上次选的目录）+ `startIn: 'documents'`；
 *   · 句柄再存进 IndexedDB，下次打开若权限还在就**自动读一遍**，用户一次都不用点。
 */

import { t } from './i18n.ts';

/** 默认的 PCSX2 用户目录（用户机器上就是这个；只作为**提示文案**，不是能读的路径）。 */
export const DEFAULT_PCSX2_DIR = 'C:\\Users\\M\\Documents\\PCSX2';

/** 超过这个大小就不读（`memcards\*.ps2` 是 8 MB，自检完全用不到它们）。 */
export const PCSX2_MAX_TEXT_BYTES = 4 * 1024 * 1024;

/** 取"用于匹配的路径"：优先 `path`，其次 `webkitRelativePath`（`File` 用后者）。 */

/** 把 `\` 归一成 `/`，去掉开头的 `./` 与 `/`，压掉重复分隔符。 */
export function normalizeRelPath(p: string): string {
  return String(p ?? '')
    .replace(/\\/g, '/')
    .replace(/^\.?\//, '')
    .replace(/\/{2,}/g, '/');
}

/** 路径里是否**按目录段**包含 `seg`（大小写无关）—— 避免 `inis` 误配到 `inis2`。 */
export function pathHasSegment(p: string, seg: string): boolean {
  const parts = normalizeRelPath(p).toLowerCase().split('/');
  return parts.includes(seg.toLowerCase());
}

/**
 * 这个文件是不是自检要读的？
 *
 * 认三种（目录段判据，大小写无关）：
 *   · `inis/PCSX2.ini`
 *   · `gamesettings/*.ini`
 *   · `logs/emulog.(txt|log)`
 *
 * ⚠ 只按**后缀 + 目录段**判，不做"聪明"的猜测 —— SPEC 的原则是"不做格式猜测"。
 */
export function isPcsx2TextFile(path: string): boolean {
  const lower = normalizeRelPath(path).toLowerCase();
  if (!/\.(ini|txt|log)$/.test(lower)) return false;
  if (pathHasSegment(lower, 'inis') && lower.endsWith('/pcsx2.ini')) return true;
  if (pathHasSegment(lower, 'gamesettings')) return true;
  if (pathHasSegment(lower, 'logs') && /\/(emulog\.(txt|log))$/.test(lower)) return true;
  return false;
}

/**
 * **兜底路径**（`<input webkitdirectory>` 或拖入整个目录）用的分类。
 *
 * 返回按"要读 / 太大 / 无关"分好类的原始对象，调用方再去 `text()`。
 * 这个函数的输入是浏览器的 `File`（它有 `webkitRelativePath` 与 `size`），
 * 但这里只依赖那两个字段 ⇒ Node 里可以拿普通对象测。
 */
export function classifyPcsx2Input<T extends { name: string; size: number; webkitRelativePath?: string }>(
  all: Iterable<T>,
): { read: T[]; skippedTooBig: T[]; skippedOther: T[] } {
  const read: T[] = [];
  const skippedTooBig: T[] = [];
  const skippedOther: T[] = [];
  for (const f of all) {
    const path = normalizeRelPath(f.webkitRelativePath || f.name);
    // 顺序与 selectPcsx2Files 一致：先判"要不要读"，再判大小
    if (!isPcsx2TextFile(path)) {
      skippedOther.push(f);
      continue;
    }
    if (f.size > PCSX2_MAX_TEXT_BYTES) {
      skippedTooBig.push(f);
      continue;
    }
    read.push(f);
  }
  return { read, skippedTooBig, skippedOther };
}

/**
 * 用户"选了一个 PCSX2 目录"之后，给一句话说明**我们实际读到了什么**。
 * 人话、且明确点名缺哪一项（缺 `inis`/`gamesettings`/`logs` 时用户才知道下一步做什么）。
 */
export function describeFoundFiles(paths: readonly string[]): string {
  const norm = paths.map((p) => normalizeRelPath(p).toLowerCase());
  const hasGlobal = norm.some((p) => pathHasSegment(p, 'inis') && p.endsWith('/pcsx2.ini'));
  const hasGame = norm.some((p) => pathHasSegment(p, 'gamesettings'));
  const hasLog = norm.some((p) => pathHasSegment(p, 'logs') && /\/emulog\.(txt|log)$/.test(p));
  const got: string[] = [];
  if (hasGlobal) got.push('inis\\PCSX2.ini');
  if (hasGame) got.push('gamesettings\\*.ini');
  if (hasLog) got.push('logs\\emulog.txt');
  const miss: string[] = [];
  if (!hasGlobal) miss.push(t('inis\\PCSX2.ini（全局设置）', 'inis\\PCSX2.ini (global settings)', 'inis\\PCSX2.ini（グローバル設定）', 'inis\\PCSX2.ini (전역 설정)'));
  if (!hasGame) miss.push(t('gamesettings\\*.ini（每游戏设置）', 'gamesettings\\*.ini (per-game settings)', 'gamesettings\\*.ini（ゲームごとの設定）', 'gamesettings\\*.ini (게임별 설정)'));
  if (!hasLog) miss.push(t('logs\\emulog.txt（运行日志）', 'logs\\emulog.txt (run log)', 'logs\\emulog.txt（実行ログ）', 'logs\\emulog.txt (실행 로그)'));
  if (got.length === 0) {
    return t(
      `这个目录里没有找到 PCSX2 的自检文件（少了 ${miss.join('、')}）—— 请确认选的是 PCSX2 的用户目录（含 inis\\、gamesettings\\、logs\\ 这一层）。`,
      `No PCSX2 files to check were found in this folder (missing ${miss.join(', ')}) - please make sure you picked the PCSX2 user folder (the one that contains inis\\, gamesettings\\ and logs\\).`, `このフォルダには PCSX2 のチェック用ファイルが見つかりません（${miss.join('、')} がありません）—— PCSX2 のユーザーフォルダ（inis\\、gamesettings\\、logs\\ が入っている階層）を選んだか確認してください。`, `이 폴더에서 PCSX2 점검 파일을 찾지 못했습니다 (${miss.join(', ')} 누락) —— PCSX2 사용자 폴더(inis\\, gamesettings\\, logs\\ 가 들어 있는 계층)를 선택했는지 확인하세요.`,
    );
  }
  return t(
    `读到：${got.join('、')}` +
      (miss.length ? `；没找到：${miss.join('、')}（少哪一项就少一路信息，结论还是会给）` : '（三项齐全）'),
    `Found: ${got.join(', ')}` +
      (miss.length
        ? `; not found: ${miss.join(', ')} (each missing item just means less information; the verdict is still produced)`
        : ' (all three present)'), `読み込み：${got.join('、')}${miss.length ? `；見つからない：${miss.join('、')}（足りない項目は情報が減るだけです。判定は出します）` : '（3 つそろっています）'}`, `읽음: ${got.join(', ')}${miss.length ? `; 찾지 못함: ${miss.join(', ')} (없는 항목만큼 정보가 줄 뿐, 판정은 나옵니다)` : ' (세 개 모두 있음)'}`,
  );
}
