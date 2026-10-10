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
 *   · 如果这个字面量落在 `SINKS` 里某个包装调用（`t(...)` / `setStatusPair(...)`）的括号里
 *     ⇒ **算已翻译**（`SINKS` 见下面那段注释）；
 *   · 其余一律报出来（行号 + 片段）。
 *
 * ★ 0.44：`auditSource(src, { collect: true })` 换成"把**每一个**字符串字面量都收进来"
 *   （不管里面有没有中文）。`ui.test.ts` 拿它查另一件事：**用户可见的文字里不许出现 `**强调**`**
 *   —— 这个项目的所有文案都走 `textContent` / `title`（纯文本，不是 markdown）⇒ `**` 会原样显示成星号。
 *   ⚠ 必须借这里的词法器：注释里写 `**` 是本项目的文档习惯，正则糊一遍会把注释也算进来。
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
 * ★ 0.41：这些关键字**后面**的 `/` 是**正则开头**（不是除号）。
 *
 * 为什么需要它：以前扫描器完全不认正则字面量 ⇒ `const re = /'/g;` 里的 `'` 会被当成
 * 字符串开头，它后面所有引号配对全乱、中文漏翻查不出来（fail-open）。
 * 判据就是"上一个非空白字符是这个关键字"（`return /re/`、`typeof /re/`…）。
 */
const REGEX_KEYWORDS = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'case',
  'do',
  'else',
  'yield',
  'await',
]);

/**
 * ★ 0.40：**算作"已翻译"的包装函数** —— 它们的参数就是"中文原文 + 英文"。
 *
 *   · `t(zh, en)` —— 动态文案的正主；
 *   · `setStatusPair(zh, en)` —— `state.ts` 里状态行那个糖：它把**两种语言都留着**，
 *     切语言时能按新语言重说一遍（所以那两个参数同样是"待翻译原文"，不是漏翻）。
 *
 * ★ 0.43：`refusedNote(zh, en, hintLine?)` —— `cardOps.ts` 里"预检拒绝的一句话标签"。
 *   它与 `t` 同形（前两个参数就是中英原文，内部走 `t(zh + 后缀, en + 后缀)`），第三个参数是
 *   **布尔**（要不要加"见上方提示行"的指针）。
 *
 * ⚠ 往这里加名字要慎重：加进来的函数**必须**真的把两种语言都用到（否则等于开了个后门）。
 */
const SINKS = new Set(['t', 'setStatusPair', 'refusedNote']);

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
  { file: 'logic/games.ts', why: '作品表数据：其余语言在同行的 en / ja / ko 与 noteEn / noteJa / noteKo 字段里' },
  { file: 'logic/defaults.ts', why: '缩放核文案数据：其余语言在同行的 en / ja / ko 字段里' },
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
 * ## 0.41 修掉的两个"漏翻查不出来"（fail-open）
 *
 *   ① **正则字面量**以前完全不认识：`const re = /'/g;` 里的 `'` 被当成字符串开头，
 *      于是它后面整段引号配对全乱 —— 实测 `auditSource("const re = /'/g;\nconst s = '没翻译的中文';")`
 *      返回 **0** 处（应为 1）。现在用一个启发式认正则（`/` 前面是 `( , = : [ ! & | ? { } ; return` 之类
 *      的位置、或行首），整段跳过、内部不参与引号配对。
 *   ② **模板插值 `${…}`** 以前整段当空白跳过：插值里的中文（`\`${'没翻译'}\``）漏翻查不出来。
 *      现在把插值里的表达式**按代码继续扫**（递归），中文照旧报出来。
 *
 * ## 状态机
 *
 *   · code：遇 `//` `/*` 进注释；遇引号进字符串；遇正则字面量跳过；
 *           遇 `(` `)` 记括号深度；遇 `t(` / `setStatusPair(` 记下"当前深度"
 *   · comment / string：各自记下起始位置，退出时判断要不要报
 */
export function auditSource(src, outer = {}) {
  const bad = [];
  const n = src.length;
  /** 当前位置。 */
  let i = 0;
  /** 括号深度（只在 code 状态里数）。 */
  let depth = outer.depth ?? 0;
  /** `t(` 调用所在那一层的深度（-1 = 当前不在任何 `t()` 的参数里）。 */
  let tDepth = outer.tDepth ?? -1;
  /** 刚读到的标识符（用来判断 `(` 前面是不是**独立**的 `t`）。 */
  let word = '';
  /** 上一个标识符（允许 `t (` 这种写法：中间只隔了空白）。 */
  let prevIdent = '';

  const lineOf = (pos) => src.slice(0, pos).split('\n').length;
  const isWordChar = (ch) => /[A-Za-z0-9_$]/.test(ch);

  /** `/` 是**除号**（不是正则开头）吗？——判据：看上一个非空白字符。 */
  const divisionHere = (pos) => {
    let k = pos - 1;
    while (k >= 0 && /\s/.test(src[k])) k -= 1;
    if (k < 0) return false;
    const before = src[k];
    if (')]}'.includes(before)) return true;
    if (!isWordChar(before)) return false;
    let s = k;
    while (s >= 0 && isWordChar(src[s])) s -= 1;
    return !REGEX_KEYWORDS.has(src.slice(s + 1, k + 1));
  };

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

    // ── 正则字面量（★ 0.41：必须认，否则里面的引号会把后面的配对全带偏）──
    if (c === '/' && !divisionHere(i)) {
      let j = i + 1;
      let inClass = false;
      while (j < n) {
        if (src[j] === '\\') {
          j += 2;
          continue;
        }
        if (src[j] === '\n') break;
        if (src[j] === '[') inClass = true;
        else if (src[j] === ']') inClass = false;
        else if (src[j] === '/' && !inClass) {
          j += 1;
          while (j < n && /[a-z]/i.test(src[j])) j += 1;
          break;
        }
        j += 1;
      }
      i = j;
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
        // 模板插值 `${…}`：★ 0.41 起**里面的表达式按代码继续扫**（以前整段当空白跳过，
        //   于是 `\`${cond ? '中文甲' : '中文乙'}\`` 这种漏翻永远查不出来）。
        if (quote === '`' && src[j] === '$' && src[j + 1] === '{') {
          let d = 1;
          let e = j + 2;
          while (e < n && d > 0) {
            if (src[e] === '{') d += 1;
            else if (src[e] === '}') d -= 1;
            e += 1;
          }
          const body = src.slice(j + 2, Math.max(j + 2, e - 1));
          // ★ 递归扫表达式，但**继承"是否已经在 t() 参数里"**：`t(\`…${cond ? '甲' : '乙'}\`)`
          //   里那两个中文是**已翻译**的（属于 t 的实参），不该报；漏报的只是
          //   "插值里新起的、不在任何 t() 里的"中文。
          //   ⚠ 括号深度必须**一起传**：`t(\`…${f('甲')}…\`)` 的实参在 depth > tDepth 层。
          const baseLine = lineOf(j + 2) - 1;
          for (const hit of auditSource(body, { depth, tDepth, collect: outer.collect })) {
            bad.push({ ...hit, line: hit.line + baseLine });
          }
          content += ' ';
          j = e;
          continue;
        }
        if (src[j] === quote) break;
        content += src[j];
        j += 1;
      }
      // ★ 判定"在 t() 里"：`tDepth` 记的是 `t(` **那一层**的深度，
      //   而参数里的字面量在 `tDepth + 1` 层（所以条件是 `depth > tDepth`，不是 `!==`）。
      const inT = tDepth >= 0 && depth > tDepth;
      // ★ 0.44：`collect:true` ⇒ 一个不落全收（给 `ui.test.ts` 查文案里的 `**`）
      if (outer.collect) {
        bad.push({ line: lineOf(start), text: content.replace(/\s+/g, ' ').trim() });
      } else if (CJK.test(content) && !inT) {
        bad.push({ line: lineOf(start), text: content.replace(/\s+/g, ' ').trim().slice(0, 90) });
      }
      i = j + 1;
      word = '';
      continue;
    }
    // ⚠ 0.44：这里原来还**重复了一整块**"字符串"分支（37 行）—— 它与上面那块逐字相同，
    //   而上面那块末尾无条件 `continue` ⇒ 它**永远执行不到**（死代码，也没有任何测试依赖它）。
    //   删掉的理由不只是"短一点"：要改字符串处理（例如 0.44 的 `collect`）时，第二块会让人
    //   以为"还有一处也要改"。词法器只有一处，才是能审计的。

    // ── 代码 ──
    if (c === '(') {
      // `t(` / `setStatusPair(` —— 要求那个名字是**独立标识符**
      // （否则 `format(` / `at(` / `mySetStatusPair(` 之类会被误判成包装调用）。
      // `word || prevIdent` 是为了容忍 `t (`（中间只隔空白）这种写法。
      const name = word === '' ? prevIdent : word;
      if (SINKS.has(name)) tDepth = depth;
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
