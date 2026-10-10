/**
 * ★★ 写入前的自检决策 —— 纯函数，零依赖、不碰 DOM，可被 Node 直接测。
 *
 * ★ 0.19：删掉了两个没人调用的导出（`sameBytes()` 与它的私有 `bytesEqual()`），
 *   并把私有的 `hex()` 换成 `logic/format.ts` 里那一份（同一格式原来有两份实现）。
 *
 * `SPEC.md` §八「可靠性规矩」把顺序钉死了：
 *
 * ```
 *   2. 写入后**必须回读**：逐字节比对 + **18 段校验**独立复核 + ECC 正确性；
 *      任一不符就报错并给出还原方法。
 *   3. **不合规就拒绝写入**（色数超、尺寸错、半透明残留）。
 * ```
 *
 * ⇒ 决策顺序是**先自检、后落盘**，而且自检**只允许放行、不允许"警告后继续"**。
 *   本模块就是那条"放行 / 拒绝"的闸门：它**只输出判断**，不碰任何文件句柄 ——
 *   于是"回读不一致 / 校验不过 / ECC 坏页"这三种情形可以在 Node 里直接构造并断言。
 *
 * ★ 为什么把它抽成独立模块：`main.ts` 里那段逻辑要碰 `FileSystemFileHandle`、
 *   `createWritable()`、下载锚点，在 Node 里根本跑不起来 ⇒ 那样的自检就**没法自动测**。
 *   抽出来之后，"三种失败情形都必须拒绝"是**能自动跑的判据**，而不是"我读了一遍代码"。
 */

/** `emblem.ts::VerifyResult` 的结构子集（避免逻辑层 import 核心层的类型）。 */
export interface ChecksumLike {
  ok: boolean;
  badSegments: Array<{ name: string; offset: number; got: number; expect: number }>;
}

/** 图像合规结论的结构子集（`image.ts::ComplianceResult`）。 */
export interface ComplianceLike {
  ok: boolean;
  issues: string[];
}

export interface ReadbackFacts {
  /** 回读出来的字节（从卡的内存副本上重新读一遍）。 */
  readback: Uint8Array;
  /** 我们期望写进去的字节。 */
  expected: Uint8Array;
  /** 回读内容的 `verifyChecksums()` 结果。 */
  checksums: ChecksumLike;
  /** 相关页里 ECC 不自洽的**绝对页号**列表。 */
  badEccPages: readonly number[];
  /** 图像合规结论（可选；写入路径上一定给）。 */
  compliance?: ComplianceLike | null;
  /** 比对多少个字节就报差异（默认全比）。 */
  compareLimit?: number;
}

export interface Decision {
  /** true = 允许落盘。 */
  proceed: boolean;
  /** 拒绝原因（人话，可直接显示给用户）。 */
  reasons: string[];
  /** 通过了的检查项（显示在成功提示里）。 */
  passed: string[];
  /** 逐字节比对是否完全一致。 */
  byteIdentical: boolean;
  /** 第一个不一致的偏移（`byteIdentical` 为 true 时是 -1）。 */
  firstDiffOffset: number;
  /** 差异字节数（最多统计到 compareLimit）。 */
  diffCount: number;
}

import { hex } from './format.ts';
import { t } from './i18n.ts';

/**
 * 决策。**任何一项不过 ⇒ `proceed: false`**，并且原因里带上具体数字/偏移，
 * 让用户能自己判断"是卡坏了还是工具坏了"。
 */
export function verifyWrite(facts: ReadbackFacts): Decision {
  const reasons: string[] = [];
  const passed: string[] = [];
  const limit = Math.min(
    facts.compareLimit ?? Number.MAX_SAFE_INTEGER,
    Math.max(facts.readback.length, facts.expected.length),
  );

  // ── ① 逐字节比对 ──
  let firstDiffOffset = -1;
  let diffCount = 0;
  const n = Math.min(limit, Math.min(facts.readback.length, facts.expected.length));
  for (let i = 0; i < n; i++) {
    if (facts.readback[i] !== facts.expected[i]) {
      if (firstDiffOffset < 0) firstDiffOffset = i;
      diffCount += 1;
    }
  }
  const lengthMismatch = facts.readback.length !== facts.expected.length;
  const byteIdentical = !lengthMismatch && diffCount === 0;
  if (lengthMismatch) {
    reasons.push(
      t(
        `回读长度 ${facts.readback.length} ≠ 期望 ${facts.expected.length} 字节（写进去的东西没完整落下来）`,
        `Read-back length ${facts.readback.length} != expected ${facts.expected.length} bytes (what we wrote did not land completely)`, `読み戻し長 ${facts.readback.length} ≠ 期待値 ${facts.expected.length} バイト（書き込んだ内容が完全には定着していません）`, `다시 읽은 길이 ${facts.readback.length} ≠ 기대값 ${facts.expected.length}바이트(쓴 내용이 완전히 기록되지 않았습니다)`,
      ),
    );
  } else if (diffCount > 0) {
    reasons.push(
      t(
        `回读与期望不一致：${diffCount} 个字节不同，首个差异在 ${hex(firstDiffOffset)}` +
          `（期望 ${hex(facts.expected[firstDiffOffset])}，实到 ${hex(facts.readback[firstDiffOffset])}）`,
        `Read-back does not match what was expected: ${diffCount} bytes differ, first at ${hex(firstDiffOffset)}` +
          ` (expected ${hex(facts.expected[firstDiffOffset])}, got ${hex(facts.readback[firstDiffOffset])})`, `読み戻しが期待と一致しません：${diffCount} バイトが異なり、最初の相違は ${hex(firstDiffOffset)}（期待 ${hex(facts.expected[firstDiffOffset])}、実際 ${hex(facts.readback[firstDiffOffset])}）`, `다시 읽은 값이 기대와 다릅니다: ${diffCount}바이트가 다르며, 첫 차이는 ${hex(firstDiffOffset)}(기대 ${hex(facts.expected[firstDiffOffset])}, 실제 ${hex(facts.readback[firstDiffOffset])})`,
      ),
    );
  } else {
    passed.push(t(`逐字节比对一致（${facts.readback.length} 字节）`, `Byte-for-byte identical (${facts.readback.length} bytes)`, `バイト単位の比較で一致（${facts.readback.length} バイト）`, `바이트 단위 비교 일치(${facts.readback.length}바이트)`));
  }

  // ── ② 18 段校验独立复核 ──
  if (!facts.checksums || !facts.checksums.ok) {
    const bad = facts.checksums && facts.checksums.badSegments ? facts.checksums.badSegments : [];
    const detail = bad.length
      ? bad
          .slice(0, 6)
          .map((s) =>
            t(
              `${s.name}@${hex(s.offset)} 实到 ${hex(s.got)} 期望 ${hex(s.expect)}`,
              `${s.name}@${hex(s.offset)} got ${hex(s.got)}, expected ${hex(s.expect)}`, `${s.name}@${hex(s.offset)} 実測 ${hex(s.got)} 期待 ${hex(s.expect)}`, `${s.name}@${hex(s.offset)} 실제 ${hex(s.got)} 기대 ${hex(s.expect)}`,
            ),
          )
          .join(t('；', '; ', '；', '; '))
      : t('（没有明细）', '(no details)', '（明細なし）', '(세부 내역 없음)');
    reasons.push(
      t(
        `18 段校验不通过：${bad.length} 段出错 —— ${detail}`,
        `18-segment checksum FAILED: ${bad.length} segment(s) wrong - ${detail}`, `18 セグメントのチェックサム不合格：${bad.length} セグメントでエラー —— ${detail}`, `18개 세그먼트 체크섬 불합격: ${bad.length}개 세그먼트 오류 —— ${detail}`,
      ),
    );
  } else {
    passed.push(t('18 段校验 18/18', '18/18 checksums', '18 セグメントのチェックサム 18/18', '18개 세그먼트 체크섬 18/18'));
  }

  // ── ③ ECC 正确性 ──
  if (facts.badEccPages && facts.badEccPages.length > 0) {
    const list = facts.badEccPages.slice(0, 12).map((p) => String(p)).join(', ');
    reasons.push(
      t(
        `ECC 坏页 ${facts.badEccPages.length} 个（绝对页 ${list}${facts.badEccPages.length > 12 ? ' …' : ''}）` +
          ' —— 备用区与数据不自洽',
        `${facts.badEccPages.length} bad ECC page(s) (absolute pages ${list}${facts.badEccPages.length > 12 ? ' ...' : ''})` +
          ' - the spare area and the data do not agree', `ECC 不良ページ ${facts.badEccPages.length} 個（絶対ページ ${list}${facts.badEccPages.length > 12 ? ' …' : ''}） —— スペアエリアとデータが一致しません`, `ECC 불량 페이지 ${facts.badEccPages.length}개(절대 페이지 ${list}${facts.badEccPages.length > 12 ? ' …' : ''}) —— 스페어 영역과 데이터가 일치하지 않습니다`,
      ),
    );
  } else {
    passed.push(t('改动页 ECC 全对', 'ECC correct on all changed pages', '変更ページの ECC はすべて正しい', '변경된 페이지의 ECC 모두 정상'));
  }

  // ── ④ 图像合规（SPEC.md §八 3）──
  if (facts.compliance && !facts.compliance.ok) {
    reasons.push(
      t(
        `图像不合规：${facts.compliance.issues.join('；')}`,
        `Image is not compliant: ${facts.compliance.issues.join('; ')}`, `画像が不適合：${facts.compliance.issues.join('；')}`, `이미지가 부적합: ${facts.compliance.issues.join('; ')}`,
      ),
    );
  } else if (facts.compliance && facts.compliance.ok) {
    passed.push(t('图像合规（128×128 / 实色 ≤255 / 半透明 0）', 'Image is compliant (128×128 / <=255 colors / 0 semi-transparent)', '画像は適合（128×128 / 実色 ≤255 / 半透明 0）', '이미지 적합(128×128 / 실색 ≤255 / 반투명 0)'));
  }

  return {
    proceed: reasons.length === 0,
    reasons,
    passed,
    byteIdentical,
    firstDiffOffset,
    diffCount,
  };
}

/**
 * 不给"落盘确认框"的文案里少这句话 —— `SPEC.md` §三 / §八 1 的硬提示。
 *
 * 理由（本项目实测教训）：PCSX2 若还开着，它**退出时会用手里的旧卡写回文件**，
 * 你刚写进去的改动会被覆盖掉。
 */
const QUIT_PCSX2_WARNING_ZH = '请先完全退出 PCSX2';

/** 这句硬提示的**当前语言**版本（落盘确认框里用）。 */
export function quitPcsx2Warning(): string {
  return t(QUIT_PCSX2_WARNING_ZH, 'Fully exit PCSX2 first', `PCSX2 を先に完全に終了してください`, `PCSX2를 먼저 완전히 종료하세요`);
}

/**
 * ⚠ 0.28 起**别再直接用这个常量**：它只有中文（界面要用的走 `quitPcsx2Warning()`）。
 *   保留原名是为了让 `ui.test.ts` 里"这句硬提示必须还在"的断言继续有效
 *   （那条断言查的就是这个中文串；中文永远是 `t()` 的第一个参数，所以两边不会漂）。
 */
export const QUIT_PCSX2_WARNING = QUIT_PCSX2_WARNING_ZH;

/** 落盘确认框的完整文案（"我到底在写哪个文件"必须写清楚，SPEC.md §八 4）。 */
export function confirmWriteMessage(opts: {
  /** 目标文件名（卡文件名或下载名）。 */
  fileName: string;
  /** true = 直接覆盖原文件；false = 只能下载。 */
  overwrite: boolean;
  /** 改动摘要（人类可读，一行一条）。 */
  changes: readonly string[];
}): string {
  const head = opts.overwrite
    ? t(`即将直接覆盖 ${opts.fileName}`, `About to OVERWRITE ${opts.fileName}`, `${opts.fileName} をこれから直接上書きします`, `${opts.fileName}을(를) 곧바로 덮어씁니다`)
    : t(
        `即将下载改好的卡（文件名 ${opts.fileName}）；下载后请自己拷回 memcards\\`,
        `About to DOWNLOAD the modified card (file name ${opts.fileName}); copy it back into memcards\\ yourself afterwards`, `修正したカードをこれからダウンロードします（ファイル名 ${opts.fileName}）。⇒ ダウンロード後はご自身で memcards\\ にコピーし戻してください`, `수정한 카드를 곧 다운로드합니다(파일 이름 ${opts.fileName}). 다운로드 후에는 직접 memcards\\에 다시 복사하세요`,
      );
  return [
    head,
    '',
    ...opts.changes.map((c) => '· ' + c),
    '',
    t(`★ ${QUIT_PCSX2_WARNING}（关窗口，不是 reset）。`, `★ ${quitPcsx2Warning()} (close the window, not a reset).`, `★ ${quitPcsx2Warning()}（ウィンドウを閉じる。reset ではありません）。`, `★ ${quitPcsx2Warning()}(창을 닫는 것이며 reset이 아닙니다).`),
    t(
      '  理由：PCSX2 还在运行时，它退出时会用手里的旧卡把文件写回去，你的改动会被覆盖。',
      '  Why: while PCSX2 is running it keeps its own copy of the card and writes it back on exit, overwriting your changes.', '  理由：PCSX2 の実行中は、終了時に手持ちの古いカードでファイルを書き戻すため、あなたの変更が上書きされてしまいます。', '  이유: PCSX2가 실행 중이면 종료할 때 가지고 있던 옛 카드로 파일을 다시 쓰기 때문에, 당신의 변경이 덮어써집니다.',
    ),
    '',
    t('确认继续？', 'Continue?', '続行しますか？', '계속하시겠습니까?'),
  ].join('\n');
}
