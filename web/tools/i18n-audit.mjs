/**
 * i18n 审计：找出 `src/ui/**` 里**还没被 `t()` 包住的**中文字符串字面量。
 *
 * ## 为什么需要它
 *
 * 0.28 把界面做成中英双语，做法是"原文就地配对"：`t('中文原句', 'English sentence')`。
 * 这种改法有 300+ 处，**靠眼看是查不干净的**（漏一句 = 英文界面里冒出一句中文）。
 * 这个脚本就是判据：真正的扫描器（懂注释 / 三种引号 / 模板插值 / 括号配对），
 * 而不是正则糊一遍 —— 正则在这份源码上一定会误报（注释里全是反引号与中文）。
 *
 * ## 判定规则
 *
 *   · 跳过注释（`//` 与 `块注释`）；
 *   · 只关心**字符串字面量**（`'…'` / `"…"` / 模板串）里含中日韩字符的那些；
 *   · 如果这个字面量落在某个 `t(...)` 调用的括号里 ⇒ **算已翻译**；
 *   · 其余一律报出来（行号 + 片段）。
 *
 * ⚠ 已知的、**允许**的中文残留由 `ALLOW` 列表显式列出（例如给开发看的 `console.error`），
 *   白名单必须写清理由 —— "反正不报错"不算理由。
 *
 * 用法：`node web/tools/i18n-audit.mjs`（有问题时非零退出）
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url)); // web/tools
const WEB = resolve(HERE, '..');
const UI = join(WEB, 'src', 'ui');

const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uff01-\uff60]/;

/**
 * 允许的中文残留 —— **每条都要写清理由**，"反正不报错"不算理由。
 *
 *   · `logic/i18n.ts` 的 `'中文'`：那是**语言选项自己的名字**（`LANGS`），
 *     语言名就该用各自的语言写（中文用户看到"中文"、英文用户看到"English"），**不该翻译**。
 *   · `logic/games.ts` / `logic/defaults.ts`：这两个文件里的中文是**数据字段**
 *     （作品表 `label`/`note`、缩放核 `label`），英文放在同一行的 `en`/`noteEn` 字段里，
 *     渲染时走 `t(g.label, g.en)` ⇒ 字面量本身当然不会被 `t()` 包住。
 */
const ALLOW = [
  { file: 'logic/i18n.ts', why: '语言选项自己的名字（LANGS）不翻译' },
  { file: 'logic/games.ts', why: '作品表数据：英文在同行的 en / noteEn 字段里' },
  { file: 'logic/defaults.ts', why: '缩放核文案数据：英文在同行的 en 字段里' },
];

/**
 * 逐条放行的**具体文案**（比整文件放行精确，理由也必须写清）。
 *
 * 这两个是"中文原文常量"：`writeGuard.ts::QUIT_PCSX2_WARNING` 与
 * `staleness.ts::STALE_HANDLE_HINT`。它们**只给测试用**（`ui.test.ts` 直接断言这几个中文串），
 * 界面一律走 `quitPcsx2Warning()` / `staleHandleHint()`（那两个是 `t(中文, English)`）。
 * ⚠ 不能把常量本身改成 `t(...)`：那样它的值会在**模块加载时**定死成当时那个语言，
 *   用户运行中切语言就错了。
 */
const ALLOW_TEXT = [
  { text: '请先完全退出 PCSX2', why: 'QUIT_PCSX2_WARNING：只给测试断言用的中文原文常量' },
  { text: '磁盘上的这张卡在工具读过之后又被改过', why: 'STALE_HANDLE_HINT：同上（中文原文常量）' },
  { text: '⇒ 浏览器拒绝往过期句柄上写。请：①', why: 'STALE_HANDLE_HINT：同上' },
  { text: '⚠ 别用〔另存为〕存出来的副本盖回去 —— 内存副本是旧的。', why: 'STALE_HANDLE_HINT：同上' },
];

function listTs(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listTs(p));
    else if (name.endsWith('.ts')) out.push(p);
  }
  return out;
}

/**
 * 扫一个文件，返回"没被 t() 包住的中文字面量"。
 *
 * 状态机（顺序很重要：注释 → 字符串 → 代码）：
 *   · code：遇 `//` `/*` 进注释；遇引号进字符串；遇 `(` `)` 记括号深度；遇 `t(` 记下"当前深度 = t 的深度"
 *   · comment / string：各自记下起始位置，退出时判断要不要报
 */
export function auditSource(src) {
  const bad = [];
  const n = src.length;
  let i = 0;
  /** 括号深度（只在 code 状态里数）。 */
  let depth = 0;
  /** `t(` 调用所在那一层的深度（-1 = 当前不在任何 `t()` 的参数里）。 */
  let tDepth = -1;
  /** 刚读到的标识符（用来判断 `(` 前面是不是**独立**的 `t`）。 */
  let word = '';
  /** 上一个标识符（允许 `t (` 这种写法：中间只隔了空白）。 */
  let prevIdent = '';

  const lineOf = (pos) => src.slice(0, pos).split('\n').length;
  const isWordChar = (ch) => /[A-Za-z0-9_$]/.test(ch);

  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];

    // ── 注释 ──
    if (c === '/' && c2 === '/') {
      while (i < n && src[i] !== '\n') i += 1;
      word = '';
      continue;
    }
    if (c === '/' && c2 === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i += 2;
      word = '';
      continue;
    }

    // ── 字符串 ──
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      const start = i;
      let j = i + 1;
      let content = '';
      while (j < n) {
        if (src[j] === '\\') {
          content += src[j] + src[j + 1];
          j += 2;
          continue;
        }
        // 模板插值 `${…}`：里面的表达式是**代码**，但它作为整体属于这个字面量
        if (quote === '`' && src[j] === '$' && src[j + 1] === '{') {
          let d = 1;
          j += 2;
          while (j < n && d > 0) {
            if (src[j] === '{') d += 1;
            else if (src[j] === '}') d -= 1;
            j += 1;
          }
          content += ' ';
          continue;
        }
        if (src[j] === quote) break;
        content += src[j];
        j += 1;
      }
      // ★ 判定"在 t() 里"：`tDepth` 记的是 `t(` **那一层**的深度，
      //   而参数里的字面量在 `tDepth + 1` 层（所以条件是 `depth > tDepth`，不是 `!==`）。
      const inT = tDepth >= 0 && depth > tDepth;
      if (CJK.test(content) && !inT) {
        bad.push({ line: lineOf(start), text: content.replace(/\s+/g, ' ').trim().slice(0, 90) });
      }
      i = j + 1;
      word = '';
      continue;
    }

    // ── 代码 ──
    if (c === '(') {
      // `t(` —— 要求 `t` 是**独立标识符**（否则 `format(` / `at(` 之类会被误判成 t 调用）。
      // `word || prevIdent` 是为了容忍 `t (`（中间只隔空白）这种写法。
      if (word === 't' || (word === '' && prevIdent === 't')) tDepth = depth;
      depth += 1;
      i += 1;
      word = '';
      prevIdent = '';
      continue;
    }
    if (c === ')') {
      depth -= 1;
      if (tDepth >= 0 && depth <= tDepth) tDepth = -1;
      i += 1;
      word = '';
      prevIdent = '';
      continue;
    }
    if (isWordChar(c)) {
      word += c;
    } else {
      // ⚠ 空白**也要**把"当前标识符"收尾：`return t(` 里紧贴 `(` 的是 `t`，不是 `return`。
      if (word) prevIdent = word;
      word = '';
    }
    i += 1;
  }
  return bad;
}

/**
 * 扫整棵 `src/ui/**`（白名单已应用）。
 *
 * 返回 `{ total, skipped, hits: [{ file, bad }] }` —— `ui.test.ts` 分节 (p) 直接吃这个结果，
 * 所以"漏翻"这件事在**每次 `node web\check.mjs`** 里都会被挡住（不只是靠手工跑这个脚本）。
 */
export function auditTree() {
  const hits = [];
  const skipped = [];
  let total = 0;
  for (const f of listTs(UI)) {
    const rel = relative(WEB, f).replace(/\\/g, '/');
    const skip = ALLOW.find((a) => rel.endsWith(a.file));
    if (skip) {
      skipped.push({ file: rel, why: skip.why });
      continue;
    }
    const bad = auditSource(readFileSync(f, 'utf8')).filter((b) => !ALLOW_TEXT.some((a) => b.text.includes(a.text)));
    if (bad.length) {
      total += bad.length;
      hits.push({ file: rel, bad });
    }
  }
  return { total, skipped, hits };
}

function main() {
  const { total, skipped, hits } = auditTree();
  for (const s of skipped) console.log(`· 跳过 ${s.file}（${s.why}）`);
  for (const h of hits) {
    console.log(`\n✗ ${h.file} —— ${h.bad.length} 处：`);
    for (const b of h.bad) console.log(`   ${b.line}: ${b.text}`);
  }
  console.log(total === 0 ? '\n✅ i18n 审计通过：src/ui/** 里没有"漏翻"的中文字面量' : `\n❌ i18n 审计：${total} 处中文字面无 t() 包裹`);
  if (total) process.exitCode = 1;
}

// 作为脚本直接跑时才执行（被 ui.test.ts import 时只导出 auditSource）
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) main();
