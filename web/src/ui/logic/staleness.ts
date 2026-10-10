/**
 * ★ 0.25 新增：**写入前查"这张卡在磁盘上是不是被别人改过了"** —— 纯逻辑，零依赖、可测。
 *
 * ## 为什么需要它（2026-10-06 用户实测踩到）
 *
 * 用户写槽 3 时收到：
 *   `InvalidStateError: An operation that depends on state cached in an interface object was made
 *    but the state had changed since it was read from disk.`
 *
 * 这是 **File System Access API 的"句柄过期"保护**：Chrome 在**选卡那一刻**把文件的
 * 修改时间/大小记在句柄里，之后只要**任何进程**写一次这个文件，句柄就过期，
 * `createWritable()` 直接抛 `InvalidStateError` —— 免得你盖掉别人的改动。
 *
 * 那次的实际情形（用户确认）：**PCSX2 一直开着**，他在游戏里存过徽章 ⇒ 文件在
 * "工具选卡"之后被 PCSX2 写了一次；而这次会话里他**一次都没成功写过**、只有一个标签页、
 * 卡也在本地目录 ⇒ 别的东西动它的可能性基本排除。
 *
 * 原来的行为：一路写到"落盘"那一步才炸，用户看到的是一句英文错 + "内存里的改动还在，可以重试"
 * （而重试**必然**再失败 —— 句柄还是过期的）。所以这里把判断**提到写之前**：
 * 变了就**拒绝这次写入**，并把"哪个文件、什么时候被改的、接下来怎么做"一次说清。
 *
 * ⚠ 本模块只做判断与文案，**不碰句柄、不碰 DOM** ⇒ 两个时间戳怎么比、文案里有没有那三步，
 *   都能在 Node 里直接断言（`ui.test.ts` 有闸门）。
 */

import { humanBytes } from './format.ts';
import { t } from './i18n.ts';

/** 一个文件在某一刻的状态（只需要能区分"变过没有"）。 */
export interface FileStamp {
  /** `File.lastModified`（毫秒）。 */
  mtime: number;
  /** `File.size`（字节）。 */
  size: number;
}

/**
 * 两个时间戳是不是"同一个状态"。
 *
 * ★ 修改时间**或**大小任一不同就算变过 —— 光看大小会漏掉"同长度改写"（PCSX2 写回整张卡时
 *   长度通常不变：记忆卡是定长 8 MB！所以**必须**看 mtime）。
 */
export function stampChanged(seen: FileStamp, now: FileStamp): boolean {
  return seen.mtime !== now.mtime || seen.size !== now.size;
}

/** 把时间戳渲染成人读的一行（本地时间；null = 没记到）。 */
export function describeStamp(s: FileStamp | null): string {
  if (!s) return t('未知', 'unknown', '不明', '알 수 없음');
  const d = new Date(s.mtime);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * 写前拦截时给用户看的完整说明（**拒绝这次写入**，磁盘一个字节都不动）。
 *
 * 文案要求（用户实测反馈）：不能只说"失败了" —— 要能照着做。
 * 所以固定包含三件事：**哪个文件、什么时候变的、接下来按哪三步做**，外加一条"别用〔另存为〕存出来的副本盖回去"。
 */
export function staleFileRefusal(opts: { fileName: string; seen: FileStamp; now: FileStamp }): string {
  const { fileName, seen, now } = opts;
  return [
    t(
      `${fileName} 在工具读过之后又被改过了：`,
      `${fileName} was changed again after the tool read it:`, `${fileName} は、ツールが読み込んだあとに再び変更されています：`, `${fileName}은(는) 도구가 읽은 뒤에 다시 변경되었습니다:`,
    ),
    t(
      `　· 工具打开卡时：${describeStamp(seen)}（${humanBytes(seen.size)}）`,
      `  · when the tool opened the card: ${describeStamp(seen)} (${humanBytes(seen.size)})`, `　· ツールがカードを開いた時：${describeStamp(seen)}（${humanBytes(seen.size)}）`, `　· 도구가 카드를 열었을 때: ${describeStamp(seen)}(${humanBytes(seen.size)})`,
    ),
    t(
      `　· 现在　　　　：${describeStamp(now)}（${humanBytes(now.size)}）`,
      `  · now: ${describeStamp(now)} (${humanBytes(now.size)})`, `　· 現在　　　　　　：${describeStamp(now)}（${humanBytes(now.size)}）`, `　· 현재　　　　　　: ${describeStamp(now)}(${humanBytes(now.size)})`,
    ),
    '',
    t(
      '最可能是 PCSX2：它还在运行，或者刚退出时把手里的卡写回了文件（需要在游戏里做的事，',
      'Most likely PCSX2: it is still running, or it wrote its copy of the card back as it exited (anything you needed to do in-game', '最も可能性が高いのは PCSX2 です：まだ実行中であるか、終了時に手持ちのカードをファイルへ書き戻したためです（ゲーム内でやるべきことは、', '가장 가능성이 큰 원인은 PCSX2입니다: 아직 실행 중이거나, 종료할 때 가지고 있던 카드를 파일에 다시 썼기 때문입니다(게임 안에서 해야 할 일은',
    ),
    t(
      '要先做完再退）。也可能是同步盘 / 杀毒替它重写了文件。',
      'has to be finished BEFORE you quit). A sync client or antivirus may also have rewritten the file.', '終了する前に済ませておく必要があります）。同期クライアントやウイルス対策ソフトがファイルを書き換えた可能性もあります。', '종료하기 전에 끝내 두어야 합니다). 동기화 클라이언트나 백신이 파일을 다시 썼을 가능성도 있습니다.',
    ),
    t(
      '⇒ 浏览器拒绝往过期句柄上写，以免覆盖那边的改动。这次没有写盘。',
      '=> The browser refuses to write through a stale handle, so the other side changes are not lost. Nothing was written to disk this time.', '⇒ ブラウザは期限切れのハンドルへの書き込みを拒否し、あちらの変更を上書きしないようにします。今回はディスクに書き込んでいません。', '⇒ 브라우저는 만료된 핸들에 쓰기를 거부하여 상대쪽 변경을 덮어쓰지 않습니다. 이번에는 디스크에 쓰지 않았습니다.',
    ),
    '',
    t('现在这样做：', 'Do this now:', '今からこうしてください：', '지금 이렇게 하세요:'),
    t('　① 完全退出 PCSX2（关窗口，不是 reset）；', '  1) Fully exit PCSX2 (close the window, not a reset);', '　① PCSX2 を完全に終了する（ウィンドウを閉じる。reset ではありません）。', '　① PCSX2를 완전히 종료하세요(창을 닫는 것이며 reset이 아닙니다).'),
    t(
      '　② 回到顶栏〔选择记忆卡〕重新选一次这张卡（重新读盘 ⇒ 句柄就新鲜了）；',
      '  2) Go back to the top bar and choose this card again with Choose memory card (re-reading the card makes the handle fresh);', '　② 上部バーに戻り〔メモリーカードを選択〕でこのカードをもう一度選ぶ（読み直すことでハンドルが新しくなります）。', '　② 상단 표시줄로 돌아가 〔메모리 카드 선택〕으로 이 카드를 다시 한 번 선택하세요(다시 읽으면 핸들이 새로워집니다).',
    ),
    t('　③ 再操作一次（写入 / 删除）。', '  3) Do the operation again (write / delete).', '　③ もう一度操作する（書き込み／削除）。', '　③ 작업을 다시 실행하세요(쓰기 / 삭제).'),
    '',
    t(
      '⚠ 别用〔另存为〕存出来的副本盖回这张卡：内存里的副本是旧的，会抹掉 PCSX2 期间写进去的改动。',
      '⚠ Do not copy the file produced by Save card as back over this card: the in-memory copy is out of date and would wipe out whatever PCSX2 wrote in the meantime.', '⚠ 〔名前を付けて保存〕で書き出したコピーをこのカードに上書きしないでください：メモリ内のコピーは古く、PCSX2 がその間に書き込んだ変更を消してしまいます。', '⚠ 〔다른 이름으로 저장〕으로 만든 사본을 이 카드에 덮어쓰지 마세요: 메모리 내 사본은 오래된 것이어서 PCSX2가 그동안 쓴 변경을 지워 버립니다.',
    ),
  ].join('\n');
}

/**
 * 兜底提示：万一"检查"与"落盘"之间又被改了（`InvalidStateError` 真抛出来时用这句）。
 * 内容与上面同一套步骤，只是短一点、适合放进 toast。
 */
const STALE_HANDLE_HINT_ZH =
  '磁盘上的这张卡在工具读过之后又被改过（最可能是 PCSX2 还在运行 / 刚退出时写回了卡）' +
  '⇒ 浏览器拒绝往过期句柄上写。请：① 完全退出 PCSX2；② 顶栏重新选一次这张卡；③ 再操作一次。' +
  '⚠ 别用〔另存为〕存出来的副本盖回去 —— 内存副本是旧的。';

/**
 * ⚠ 0.28 起**界面请用 `staleHandleHint()`**（它按当前语言取文案）。
 *   这个名字保留中文常量，是为了让 `ui.test.ts` 里"这句提示必须带〔另存为〕那条警告"的断言继续有效
 *   （断言查的就是这个中文串）—— 中文永远是 `t()` 的第一个参数，所以两边不会漂。
 */
export const STALE_HANDLE_HINT = STALE_HANDLE_HINT_ZH;

/** 兜底提示的**当前语言**版本（`InvalidStateError` 真抛出来时放进 toast 用）。 */
export function staleHandleHint(): string {
  return t(
    STALE_HANDLE_HINT_ZH,
    'The card on disk was changed after the tool read it (most likely PCSX2 is still running, or wrote the card back as it exited), ' +
      'so the browser refuses to write through a stale handle. Please: 1) fully exit PCSX2; 2) choose this card again in the top bar; 3) do the operation again. ' +
      '⚠ Do not copy the file produced by Save card as back over it - the in-memory copy is out of date.', `ディスク上のこのカードは、ツールが読んだあとにまた変更されました（PCSX2 がまだ動いているか、終了時にカードを書き戻した可能性が高いです）。そのためブラウザは古いハンドルへの書き込みを拒否します。次のようにしてください：① PCSX2 を完全に終了する；② 上のバーでこのカードをもう一度選ぶ；③ もう一度操作する。⚠ 〔名前を付けて保存〕で作ったファイルをこのカードに上書きしないでください —— メモリ上のコピーは古いままです。`, `디스크의 이 카드는 도구가 읽은 뒤에 다시 변경되었습니다(PCSX2가 아직 실행 중이거나 종료할 때 카드를 되썼을 가능성이 큽니다). 그래서 브라우저가 오래된 핸들에 쓰기를 거부합니다. 이렇게 하세요: ① PCSX2를 완전히 종료합니다; ② 위쪽 바에서 이 카드를 다시 선택합니다; ③ 작업을 다시 합니다. ⚠ 〔다른 이름으로 저장〕으로 만든 파일을 이 카드에 덮어쓰지 마세요 —— 메모리 사본이 오래되었습니다.`,
  );
}
