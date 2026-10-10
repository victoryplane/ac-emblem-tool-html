/**
 * ★ 零依赖单文件打包器 —— `web\src\ui\main.ts` → `web\dist\emblem-tool.html`
 *
 *     node web\build.mjs            # 打包 + 自检
 *     node web\build.mjs --check    # 只对**已有**产物做自检（不重新打包）
 *     node web\build.mjs --verbose  # 打印模块图
 *
 * ⚠ **本文件是纯 JavaScript（`.mjs`），不是 TypeScript** —— 里面没有类型标注。
 *   Node 对 `.mjs` 不做类型擦除，写 TS 语法会直接 `SyntaxError`（本构建器第一版就踩了）。
 *   文件末尾的 `export function …` 是给 `web/test/ui.test.ts` 复用自检用的
 *   （测试 import 它，对已有产物做一次独立复核）。
 *
 * ==========================================================================
 * 为什么不引 npm 依赖
 * ==========================================================================
 * 本项目全程零 npm 依赖（没有 `package.json`、没有 `node_modules`）。
 * Node 24 提供 `node:module` 的 **`stripTypeScriptTypes()`**（先实测过它存在，
 * 见启动时那行 `[env] stripTypeScriptTypes = function`），
 * 在本文件里只用于**开发期的类型擦除**；最终用户拿到的产物里一行 TS 都没有。
 *
 * ⚠ `stripTypeScriptTypes(..., { mode: 'strip' })` 的语义是**把类型标注替换成空格**
 *   （不改变字节偏移），所以擦完的文件与源文件**等长、行号一致** —— 这正好让产出的单文件
 *   在报错时行号还能对上源文件。**不要用 `mode: 'transform'`**：它会重排代码
 *   （还会顺手把 `enum` 编译掉），行号就废了；而本项目已规定"只写可擦除语法"
 *   （PORT-NOTES.md §一），所以 `strip` 就够。
 *
 * ==========================================================================
 * import / export 纪律（只支持这一种子集；不支持的**报错并指出文件与行号**）
 * ==========================================================================
 *
 * 支持：
 *   import { a, b } from './x.ts';          // 具名，相对路径，扩展名写全
 *   import { a as c, d } from './x.ts';
 *   import {
 *     a, b,                                 // 允许多行
 *   } from './x.ts';
 *   import './x.ts';                        // 纯副作用
 *   import type { T } from './x.ts';        // 只删不连边
 *   import type T from './x.ts';
 *   import { type T, a } from './x.ts';     // 内联 type 说明符
 *   export const / let / var {…} …
 *   export function f() {}   export class K {}
 *   export { a, b as c };
 *   export type / interface / declare …
 *   export * as ns from './x.ts';           // ★ 唯一支持的 re-export（见下）
 *
 * re-export **一般不支持**（`export {a} from './x.ts'` 与 `export * from './x.ts'` 都报错），
 * 但 `export * as ns from './x.ts'` 支持：它需要"命名空间对象"，实现是 `var ns = require(id)`，
 * 语义与 ESM 一致。
 *
 * ★ 所有 import 语句都被**换行**替换（不是删除），保证产物里每个模块的行号与源文件一致。
 *
 * 不支持（一律抛 `DisciplineError`，消息里带 `<相对路径>:<行号>`）：默认导入、
 * `import * as ns`、`export default`、`import()` / `import.meta`、
 * `export * from` / `export {a} from`、裸模块名、少写扩展名、循环依赖。
 *
 * ==========================================================================
 * 产物自检（**失败即非零退出**）
 * ==========================================================================
 *   ① 只有 1 个文件（先把 dist 清空重建，再确认目录里只有它）；
 *   ② 内联脚本里没有 `import ` / `export ` / `type="module"` / 误嵌套的 `</script`；
 *   ③ 全文没有 `http://` / `https://` / `src="./` / `href="./` / `fetch(` 之类的对外引用；
 *   ④ 打印体积与行数；再做一遍**引导冒烟**（在 `node:vm` 里用最小 DOM 桩把包跑起来），
 *      确认"双击打开"时不会在脚本解析 / 模块初始化阶段就炸。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, rmSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url)); // …\emblem-tool\web
const ENTRY = join(HERE, 'src', 'ui', 'main.ts');
const SHELL = join(HERE, 'index.html');
const CSS = join(HERE, 'styles.css');
const DIST_DIR = join(HERE, 'dist');
const OUT = join(DIST_DIR, 'emblem-tool.html');

// --------------------------------------------------------------------------
// 小工具
// --------------------------------------------------------------------------

class DisciplineError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DisciplineError';
  }
}

const rel = (p) => relative(HERE, p).split(sep).join('/');

function lineOf(src, pos) {
  let n = 1;
  for (let i = 0; i < pos && i < src.length; i++) if (src.charCodeAt(i) === 10) n += 1;
  return n;
}

/** `pos` 处是不是"词首"（前一个字符不是标识符字符）。 */
function atWordStart(src, pos) {
  if (pos === 0) return true;
  const c = src.charCodeAt(pos - 1);
  return !(
    (c >= 97 && c <= 122) ||
    (c >= 65 && c <= 90) ||
    (c >= 48 && c <= 57) ||
    c === 95 ||
    c === 36
  );
}

function lineText(src, pos) {
  let a = pos;
  while (a > 0 && src.charCodeAt(a - 1) !== 10) a -= 1;
  let b = pos;
  while (b < src.length && src.charCodeAt(b) !== 10) b += 1;
  const s = src.slice(a, b).trim();
  return s.length > 120 ? s.slice(0, 117) + '…' : s;
}

function isIdChar(c) {
  return /[A-Za-z0-9_$]/.test(c);
}

/**
 * 从 `src[pos]`（引号/反引号）开始，返回**闭合引号之后**的位置。
 * 模板字面量里遇到 `${` 会**停在那里**（调用方接着按普通代码走，
 * 直到在代码态碰到配对的反引号）。
 */
function skipString(src, pos, state) {
  const quote = src[pos];
  let i = pos + 1;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (state.inTemplate && ch === '$' && src[i + 1] === '{') return i + 2;
    if (ch === quote) return i + 1;
    i += 1;
  }
  return src.length;
}

/** 跳过 `//` 或 `/* *\/` 注释，返回之后的位置。 */
function skipComment(src, pos) {
  if (src[pos + 1] === '/') {
    let i = pos + 2;
    while (i < src.length && src.charCodeAt(i) !== 10) i += 1;
    return i;
  }
  let i = pos + 2;
  while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
  return Math.min(src.length, i + 2);
}

/** 判断 `/` 是正则还是除号（启发式：看上一个非空白字符）。 */
function regexAllowed(src, pos) {
  let i = pos - 1;
  while (i >= 0 && /\s/.test(src[i])) i -= 1;
  if (i < 0) return true;
  const c = src[i];
  if (')]}'.includes(c)) return false;
  if (isIdChar(c)) {
    let j = i;
    while (j >= 0 && isIdChar(src[j])) j -= 1;
    const word = src.slice(j + 1, i + 1);
    return [
      'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
      'case', 'do', 'else', 'yield', 'await',
    ].includes(word);
  }
  return true;
}

function skipRegex(src, pos) {
  let i = pos + 1;
  let inClass = false;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === '\n') return i;
    if (ch === '[') inClass = true;
    else if (ch === ']') inClass = false;
    else if (ch === '/' && !inClass) {
      i += 1;
      while (i < src.length && /[a-z]/i.test(src[i])) i += 1;
      return i;
    }
    i += 1;
  }
  return src.length;
}

/** 跳过 TS 类型表达式：括号/尖括号/花括号配平，到 `,` / `;` / 换行（深度 0）为止。 */
function skipTypeAnnotation(src, pos) {
  let i = pos;
  let depth = 0;
  const state = { inTemplate: false };
  while (i < src.length) {
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      state.inTemplate = ch === '`';
      i = skipString(src, i, state);
      continue;
    }
    if (ch === '/' && (src[i + 1] === '/' || src[i + 1] === '*')) {
      i = skipComment(src, i);
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{' || ch === '<') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}' || ch === '>') depth -= 1;
    else if (depth <= 0 && (ch === ',' || ch === ';')) return i;
    else if (depth <= 0 && (ch === '\n' || ch === '\r')) return i;
    i += 1;
  }
  return i;
}

/** `export function f() {}` → 取 `f`；拿不到就 null。 */
function parseDeclName(src, pos) {
  let i = pos;
  while (i < src.length && /\s/.test(src[i])) i += 1;
  const start = i;
  while (i < src.length && isIdChar(src[i])) i += 1;
  if (i === start) return null;
  return { name: src.slice(start, i), namePos: start };
}

/** `const { a, b: c, d = 1, ...rest } = …` → `['a', 'c', 'd', 'rest']`。 */
function parseBindingNames(src, pos) {
  const names = [];
  let i = pos;
  while (i < src.length && /\s/.test(src[i])) i += 1;
  if (src[i] === '{' || src[i] === '[') {
    let depth = 0;
    let buf = '';
    const flush = () => {
      const t = buf.trim();
      buf = '';
      if (!t) return;
      let name = t;
      const eq = name.indexOf('=');
      if (eq >= 0) name = name.slice(0, eq).trim();
      const colon = name.indexOf(':');
      if (colon >= 0) name = name.slice(colon + 1).trim();
      name = name.replace(/^\.\.\./, '').trim();
      if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) names.push(name);
      else if (name.startsWith('{') || name.startsWith('[')) {
        for (const n of parseBindingNames(name, 0).names) names.push(n);
      }
    };
    while (i < src.length) {
      const ch = src[i];
      if (ch === '{' || ch === '[') {
        if (depth > 0) buf += ch;
        depth += 1;
        i += 1;
        continue;
      }
      if (ch === '}' || ch === ']') {
        depth -= 1;
        i += 1;
        if (depth === 0) {
          flush();
          break;
        }
        buf += ch;
        continue;
      }
      if (ch === ',' && depth === 1) {
        flush();
        i += 1;
        continue;
      }
      if (ch === '\n') {
        i += 1;
        continue;
      }
      buf += ch;
      i += 1;
    }
    // 跳过 `= …` 到 `;` 或换行
    while (i < src.length && src[i] !== ';' && src[i] !== '\n') {
      if (src[i] === '"' || src[i] === "'" || src[i] === '`') {
        i = skipString(src, i, { inTemplate: src[i] === '`' });
        continue;
      }
      i += 1;
    }
    return { names, end: i };
  }
  for (;;) {
    const id = parseDeclName(src, i);
    if (!id) break;
    names.push(id.name);
    i = id.namePos + id.name.length;
    while (i < src.length && /\s/.test(src[i])) i += 1;
    if (src[i] === ':') i = skipTypeAnnotation(src, i + 1);
    while (i < src.length && /\s/.test(src[i])) i += 1;
    if (src[i] === '=') {
      i += 1;
      let depth = 0;
      const st = { inTemplate: false };
      while (i < src.length) {
        const ch = src[i];
        if (ch === '"' || ch === "'" || ch === '`') {
          st.inTemplate = ch === '`';
          i = skipString(src, i, st);
          continue;
        }
        if (ch === '/' && (src[i + 1] === '/' || src[i + 1] === '*')) {
          i = skipComment(src, i);
          continue;
        }
        // ★ `;` 一律是语句终点（与括号深度无关）—— 写 `depth <= 0 && ch === ';'`
        //   会在 `Object.freeze({ … });` 上出事：`}` 把深度降回 1、`)` 再降到 0，
        //   而那之后就没有 `;` 的检查了，扫描会一路吃掉后面整个声明
        //   （构建器第七次踩的坑：`export const GAMES = [...]` 整段被擦成空白）。
        if (ch === ';') break;
        if (ch === '(' || ch === '[' || ch === '{') depth += 1;
        else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
        else if (depth === 0 && ch === ',') break;
        i += 1;
      }
    }
    if (src[i] === ',') {
      i += 1;
      continue;
    }
    break;
  }
  return { names, end: i };
}

// --------------------------------------------------------------------------
// 模块变换
// --------------------------------------------------------------------------


const NAMESPACE_RE = /^import\s*\*\s*as\s+([A-Za-z_$][A-Za-z0-9_$]*)\s+from\s+['"]/;
const DEFAULT_RE = /^import\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:,|from\b)/;

/**
 * 从 `pos` 往前找"上一个真代码字符"（跳过空白与注释——注释在 `mask` 里已经是空白，
 * 所以实际只需要跳过空白；这里用 `mask` 而不是 `src`，就是为了不被注释/字符串干扰）。
 *
 * ⚠ 为什么需要它：`import` / `export` 既是**语句关键字**、也可以是**属性名**
 *   （`obj.import`、`{ export: 1 }` 都是合法 JS，而且掩码抹不掉它们）。
 *   只有"语句起始位置"的那一个才按关键字处理，剩下的必须当普通标识符放过去。
 */
function atStatementStart(mask, pos) {
  let i = pos - 1;
  while (i >= 0 && /\s/.test(mask[i])) i -= 1;
  if (i < 0) return true; // 文件开头
  const c = mask[i];
  // `;` / `}` ⇒ 上一句结束了；其它情况（`.`、`(`、`,`、标识符…）都是在表达式里
  return c === ';' || c === '}';
}

/** `export` 后面只能跟这些（我们的子集）——其它一律当普通标识符，不碰。 */
const EXPORT_FORMS = new Set([
  'default',
  'type',
  'interface',
  'declare',
  'const',
  'let',
  'var',
  'function',
  'class',
  'async',
]);

/**
 * `export` 的下一个 token 是不是我们认识的导出形式？
 *
 * ⚠ 别用 `/^[A-Za-z]+/` + 集合比：`export:` 这种下一个字符是 `:`，正则取到空串，
 *   会被误判成"认识的导出形式"⇒ 走进报错分支。所以这里按"有没有下一个 token"来判。
 */
function hasExportForm(mask, j) {
  const c = mask[j];
  if (c === '{' || c === '*') return true;
  if (c === undefined || !/[A-Za-z_$]/.test(c)) return false;
  const word = /^[A-Za-z]+/.exec(mask.slice(j, j + 20))?.[0] ?? '';
  return EXPORT_FORMS.has(word);
}

/** 从 `pos` 起第一个引号（`'` / `"` / 反引号）的位置；没有则 -1。 */
function nextQuote(src, pos) {
  for (let i = pos; i < src.length; i++) {
    const c = src[i];
    if (c === "'" || c === '"' || c === '`') return i;
  }
  return -1;
}

/** `'` / `"`（含转义）闭合引号的位置。 */
function closeQuote(src, openPos) {
  const q = src[openPos];
  let i = openPos + 1;
  while (i < src.length) {
    if (src[i] === '\\') {
      i += 2;
      continue;
    }
    if (src[i] === q) return i;
    i += 1;
  }
  return src.length;
}

function fail(file, src, pos, msg) {
  throw new DisciplineError(
    `${file}:${lineOf(src, pos)}\n  ${msg}\n  该行：${lineText(src, pos)}\n` +
      '  （支持的 import/export 子集见 web/build.mjs 顶部注释）',
  );
}

function splitSpecifiers(inner, file, src, pos) {
  const names = [];
  let typeOnly = true;
  for (const p of inner.split(',')) {
    const t = p.trim();
    if (!t) continue;
    if (t.startsWith('type ')) continue; // 内联 type 说明符：只删不连边
    typeOnly = false;
    const m = /^([A-Za-z_$][A-Za-z0-9_$]*)(?:\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*))?$/.exec(t);
    if (!m) fail(file, src, pos, `看不懂的 import 说明符 \`${t}\``);
    names.push(m[2] ?? m[1]);
  }
  return { names, typeOnly };
}

/**
 * ★★ 把源码"掩码"一遍：**注释与字符串字面量的内容换成空格/等长占位**，
 *   其余字节原样保留（长度、换行位置都不变）。
 *
 * 为什么必须有这一步（本构建器第二版踩的坑，值得记下来）：
 *   第一版一边扫边判（遇到 `//` 就跳到行尾），结果**注释里的一个反引号**会被当成
 *   模板字面量的开头，一路"配平"到几百行之后的另一个反引号 —— 于是中间那段真代码
 *   被当成字符串跳过，注释里出现的 `export` 反而被当成真代码报错。
 *   本项目的注释本来就爱写反引号（`像这样`），所以这不是"写得规整就能躲开"的问题。
 *
 * ⇒ 先掩码、再在掩码上找关键字：掩码里**只有真代码**，注释/字符串/正则全部是空白。
 *   这样"关键字在哪一行""说明符长什么样"都只可能来自真代码，扫描器不再有歧义。
 *
 * ⚠ 已导出，供 `web/test/ui.test.ts` 与手工排查复用。
 */
export function maskSource(src) {
  const out = new Array(src.length).fill(' ');

  /**
   * ★★★ 找出**注释区间**（行注释与块注释），返回等长掩码：1 = 注释里的字节。
   *
   * 为什么非要先单独找出注释（本构建器在这一处连踩六次，值得写清楚）：
   *   本项目的中文注释大量使用反引号引用代码词，例如
   *       * ⚠ `findInRoot` / `emblemDirs()` 用的判据是名字（`E\d\d$` | `EMB$`）
   *   这一行里 `${...}` 里的 `$`+`{` 正好拼成模板插值的开头 —— 于是"注释里的
   *   反引号"会把后面几百行真代码（甚至整篇 HTML）当成模板字面量吞掉。
   *   那种错误**不报错**，只会静默产出坏包；所以宁可多写一步，也要先把注释圈出来。
   *
   * 判据：**一遍，就是一个正经词法器**，与下面 `scanCode()` 同一套规则 ——
   *   注释 / 字符串 / 模板串 / 正则字面量 / `${}` 括号配对；
   *   模板串内部只认 `\`、闭合反引号、`${`（**模板里的 `//` 不是注释**）。
   *   没有"同行反引号是否配对"那类启发式 —— 那类启发式对**跨行模板串**必然误判。
   *
   * ⚠⚠ 为什么不能"先粗扫一遍、再拿粗扫结果精确扫一遍"（上一版就是错的）：
   *   粗扫（`rough`）在模板串内部不认 `//` ⇒ 会把 `const s = `a\n// b`;` 第二行
   *   整行标成注释、**连闭合反引号一起**；精确扫（`exact`）再"按注释区间决定反引号
   *   算不算界符" ⇒ 模板串永远闭不上，扫描器一路吃到文件尾 ⇒ 其后整份源码在掩码里
   *   被抹空、`export` 静默消失（**不报错**，只是坏包）。最小复现（实测踩过）：
   *       const s = `a
   *       // b`;
   *       export const K = 2;     ← 修复前这句在掩码里没了
   *   ⇒ 教训：注释扫描**自己就必须是正确的词法器**，不能拿一个会错的粗扫结果当输入。
   */
  const markComments = () => {
    const flags = new Uint8Array(src.length);
    const mark = (from, to) => {
      for (let k = from; k < to && k < src.length; k++) flags[k] = 1;
    };

    /** 跳过字符串（`'` / `"`，含转义），返回闭合引号之后的位置。 */
    const skipQuoted = (pos) => {
      const q = src[pos];
      let i = pos + 1;
      while (i < src.length) {
        if (src[i] === '\\') {
          i += 2;
          continue;
        }
        if (src[i] === q) return i + 1;
        i += 1;
      }
      return i;
    };

    /** 跳过模板串（`${…}` 里的表达式按代码继续扫），返回闭合反引号之后的位置。 */
    const skipTemplate = (pos) => {
      let i = pos + 1;
      while (i < src.length) {
        const ch = src[i];
        if (ch === '\\') {
          i += 2;
          continue;
        }
        if (ch === '`') return i + 1;
        if (ch === '$' && src[i + 1] === '{') {
          i = walk(i + 2, true);
          if (i < src.length && src[i] === '}') i += 1;
          continue;
        }
        i += 1;
      }
      return i;
    };

    /** 词法主循环；`insideExpr` 时遇到配对的 `}` 就停下并返回它的位置。 */
    const walk = (pos, insideExpr) => {
      let i = pos;
      while (i < src.length) {
        const c = src[i];
        const n = src[i + 1];
        if (c === '/' && n === '/') {
          const start = i;
          while (i < src.length && src.charCodeAt(i) !== 10) i += 1;
          mark(start, i);
          continue;
        }
        if (c === '/' && n === '*') {
          const start = i;
          i += 2;
          while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
          i = Math.min(src.length, i + 2);
          mark(start, i);
          continue;
        }
        if (c === '"' || c === "'") {
          i = skipQuoted(i);
          continue;
        }
        if (c === '`') {
          i = skipTemplate(i);
          continue;
        }
        if (c === '/' && regexAllowed(src, i)) {
          i = skipRegex(src, i);
          continue;
        }
        if (insideExpr && c === '}') return i;
        i += 1;
      }
      return i;
    };

    walk(0, false);
    return flags;
  };

  const comment = markComments();

  // ---------- 用注释区间 + JS 词法把每一处"非代码"抹成等长空白 ----------
  const blank = (from, to) => {
    for (let k = from; k < to && k < src.length; k++) out[k] = src[k] === '\n' ? '\n' : ' ';
  };

  /**
   * 在**模板串内部**扫一格：反引号是闭合符、`${` 是插值开头 —— **与注释标记无关**。
   *
   * ⚠ 这里以前写的是 `ch === '`' && !comment[i]`，于是"被误标成注释的闭合反引号"
   *   会被跳过去：扫描器一路吃到文件尾，其后整份源码被抹空（与 `markComments` 那处
   *   是同一个 bug 的两半）。既然 `markComments` 现在是正确的词法器，这里就没有任何
   *   理由再参考 `comment`；退一步说，"扫描器已经进了模板串"本身就说明这个反引号是界符。
   */
  const scanTemplateText = (pos) => {
    let i = pos;
    while (i < src.length) {
      const ch = src[i];
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === '`') return { next: i + 1, kind: 'end' };
      if (ch === '$' && src[i + 1] === '{') return { next: i + 2, kind: 'expr' };
      i += 1;
    }
    return { next: src.length, kind: 'end' };
  };

  /** 扫一段代码（文件顶层，或模板占位符内部）；`insideExpr` 时遇到 `}` 返回。 */
  const scanCode = (pos, insideExpr) => {
    let i = pos;
    while (i < src.length) {
      const c = src[i];
      const n = src[i + 1];

      if (comment[i]) {
        // 整段注释一次抹掉（这里只处理与注释起点重合的情况）
        const start = i;
        while (i < src.length && comment[i]) i += 1;
        blank(start, i);
        continue;
      }
      if (c === '/' && n === '/') {
        const start = i;
        while (i < src.length && src.charCodeAt(i) !== 10) i += 1;
        blank(start, i);
        continue;
      }
      if (c === '/' && n === '*') {
        const start = i;
        i += 2;
        while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
        i = Math.min(src.length, i + 2);
        blank(start, i);
        continue;
      }
      if (c === '"' || c === "'") {
        const start = i;
        i += 1;
        while (i < src.length) {
          if (src[i] === '\\') {
            i += 2;
            continue;
          }
          if (src[i] === c) {
            i += 1;
            break;
          }
          i += 1;
        }
        blank(start, i);
        continue;
      }
      if (c === '`' && !comment[i]) {
        blank(i, i + 1);
        let cur = i + 1;
        for (;;) {
          const seg = scanTemplateText(cur);
          if (seg.kind === 'end') {
            const hasTick = src[seg.next - 1] === '`';
            blank(cur, hasTick ? seg.next - 1 : seg.next);
            if (hasTick) blank(seg.next - 1, seg.next);
            i = seg.next;
            break;
          }
          blank(cur, seg.next - 2);
          blank(seg.next - 2, seg.next);
          const r = scanCode(seg.next, true);
          if (r.end < src.length) blank(r.end, r.end + 1);
          i = r.end + 1;
          cur = i;
        }
        continue;
      }
      if (insideExpr && c === '}') return { end: i };
      if (c === '/' && regexAllowed(src, i)) {
        const start = i;
        i = skipRegex(src, i);
        blank(start, i);
        continue;
      }
      out[i] = c;
      i += 1;
    }
    return { end: src.length };
  };

  scanCode(0, false);
  return out.join('');
}

/**
 * ★ 抽出**字符串字面量的内容**（`'…'` / `"…"` / 模板串的文本段；模板 `${…}` 里递归）。
 *
 * 为什么需要它（`maskSource()` 不够用）：`maskSource()` 是为了"只看真代码"而设计的
 * —— 它把字符串内容一起抹成空格。可 `checkHtml()` 里"产物不许有任何外部引用"这条
 * **恰恰要查字符串里写了什么**：`var u = "http://evil/x.js"` 在掩码里只剩一对引号，
 * 于是那条断言静默放行（实测）。所以要有一个"只保留字符串、别的一律不输出"的口径。
 *
 * 返回 `[{ start, text }]`：`start` 是字面量**内容**在原串里的起始偏移（报错时回切片用）。
 * 反斜杠转义原样保留（查 URL 用不着解码）。
 */
export function stringLiteralSpans(src) {
  const out = [];

  /** 跳过 `//` / `/* *​/` 注释，返回之后的位置。 */
  const skipCommentHere = (pos) => {
    if (src[pos + 1] === '/') {
      let i = pos + 2;
      while (i < src.length && src.charCodeAt(i) !== 10) i += 1;
      return i;
    }
    let i = pos + 2;
    while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
    return Math.min(src.length, i + 2);
  };

  /** 跳过模板串的文本段；遇到 `${` 停下（返回 kind: 'expr'）。 */
  const scanTemplateText = (pos) => {
    let i = pos;
    while (i < src.length) {
      const ch = src[i];
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === '`') return { next: i + 1, kind: 'end' };
      if (ch === '$' && src[i + 1] === '{') return { next: i + 2, kind: 'expr' };
      i += 1;
    }
    return { next: src.length, kind: 'end' };
  };

  /** 扫一段代码；`insideExpr` 时遇到配对的 `}` 停下。 */
  const scan = (pos, insideExpr) => {
    let i = pos;
    while (i < src.length) {
      const c = src[i];
      const n = src[i + 1];
      if (c === '/' && (n === '/' || n === '*')) {
        i = skipCommentHere(i);
        continue;
      }
      if (c === "'" || c === '"') {
        const start = i + 1;
        let j = start;
        while (j < src.length) {
          if (src[j] === '\\') {
            j += 2;
            continue;
          }
          if (src[j] === c) break;
          j += 1;
        }
        out.push({ start, text: src.slice(start, Math.min(j, src.length)) });
        i = j + 1;
        continue;
      }
      if (c === '`') {
        const start = i + 1;
        let cur = start;
        for (;;) {
          const seg = scanTemplateText(cur);
          out.push({ start: cur, text: src.slice(cur, seg.kind === 'end' ? Math.max(cur, seg.next - 1) : seg.next - 2) });
          if (seg.kind === 'end') {
            i = seg.next;
            break;
          }
          const r = scan(seg.next, true);
          i = r.end < src.length ? r.end + 1 : r.end;
          cur = i;
        }
        continue;
      }
      if (c === '/' && regexAllowed(src, i)) {
        i = skipRegex(src, i);
        continue;
      }
      if (insideExpr && c === '}') return { end: i };
      i += 1;
    }
    return { end: src.length };
  };

  scan(0, false);
  return out;
}

/** 从 `pos` 开始找语句的 `;`（含嵌套配平）或换行；返回语句结束位置。 */
function findStatementEnd(src, pos) {
  let i = pos;
  let depth = 0;
  const state = { inTemplate: false };
  while (i < src.length) {
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      state.inTemplate = ch === '`';
      i = skipString(src, i, state);
      continue;
    }
    if (ch === '/' && (src[i + 1] === '/' || src[i + 1] === '*')) {
      i = skipComment(src, i);
      continue;
    }
    if (ch === '{' || ch === '(' || ch === '[') depth += 1;
    else if (ch === '}' || ch === ')' || ch === ']') depth -= 1;
    else if (ch === ';' && depth <= 0) return i + 1;
    else if ((ch === '\n' || ch === '\r') && depth <= 0) return i;
    i += 1;
  }
  return i;
}

/** 校验 import 说明符的写法（相对 + 写全扩展名）。 */
function checkSpec(file, src, pos, spec) {
  if (!spec.startsWith('./') && !spec.startsWith('../')) {
    throw new DisciplineError(
      `${file}:${lineOf(src, pos)}\n  ★ 裸模块名 \`${spec}\` —— 本项目**零依赖**，只允许相对路径 import。\n` +
        '  该行：' + lineText(src, pos),
    );
  }
  if (spec.endsWith('/')) {
    throw new DisciplineError(
      `${file}:${lineOf(src, pos)}\n  ★ 目录 import \`${spec}\` —— 必须指到具体文件。\n  该行：` + lineText(src, pos),
    );
  }
  if (!/\.(ts|js|mjs)$/.test(spec)) {
    throw new DisciplineError(
      `${file}:${lineOf(src, pos)}\n  ★ 相对 import 必须**写全扩展名**（Node 原生跑 .ts 的前提，PORT-NOTES.md §一）。\n` +
        `  收到 \`${spec}\`，期望 \`${spec}.ts\`。\n  该行：` + lineText(src, pos),
    );
  }
}

/**
 * 把一个已经擦过类型的模块源码变成"可被 require"的形式。
 * ⚠ 抛出的 `DisciplineError` 消息里**一定**带 `${file}:${line}`。
 * ⚠ **它没有导出**（`ui.test.ts` 只从本文件 import `maskSource` / `checkHtml` /
 *   `extractScripts` / `readAppVersion` / `smokeBoot`）⇒ 下面那些"不支持的语法要报错"
 *   的分支靠**冒烟**覆盖：`ui.test.ts` 分节 (g)、`checkHtml()`、以及无头 Chrome 走一遍。
 *   要把它们逐条钉死，就得把它 `export` 出去 —— 那会改动测试期望的 API 面，
 *   当前不划算（注释与代码必须一致，所以这里写明"没导出"，别写成"已导出供测试"）。
 */
function transformModule(file, src) {
  const mask = maskSource(src);
  const deps = [];
  const exportNames = [];
  const nsExports = [];
  const assignments = [];

  let out = '';
  let i = 0;

  const take = (from, to) => {
    out += src.slice(from, to);
  };
  /** 用空白/换行替换 [from,to)，保持行号。 */
  const blank = (from, to) => {
    let s = '';
    for (let k = from; k < to; k++) s += src[k] === '\n' ? '\n' : ' ';
    out += s;
  };

  while (i < src.length) {
    const c = mask[i];

    // ⚠ 这里**故意不再自己跳过注释/字符串/模板字面量**：
    //   掩码已经把它们的内容换成空白，所以 `c` 只可能是真代码的字符；
    //   逐字符 `take` 会把原文（含注释、字符串）原样搬过去，不会丢东西。
    //   第一版就是因为在这里"又跳了一次"，被注释里的反引号带偏过。

    // ── import（只在掩码里找，所以注释/字符串里的这六个字母不算）──
    //   ⚠ 只有**语句起始位置**的 `import` 才当关键字：`obj.import` / `{ import: 1 }`
    //     这种属性名是合法代码（掩码抹不掉它），以前会走进下面"找引号"的分支 ——
    //     `nextQuote()` 无边界地向后找引号，`findStatementEnd()` 随后把中间代码整段擦掉。
    if (c === 'i' && mask.startsWith('import', i) && atWordStart(mask, i) && atStatementStart(mask, i)) {
      const after = src[i + 6];
      const isDynamicOrMeta = after === '(' || (after === '.' && src.startsWith('.meta', i + 6));
      const looksLikeStatement =
        isDynamicOrMeta ||
        after === '"' ||
        after === "'" ||
        after === '{' ||
        after === '*' ||
        (after !== undefined && /\s/.test(after));
      if (looksLikeStatement) {
        if (isDynamicOrMeta) {
          fail(
            file,
            src,
            i,
            '不支持动态 `import()` 或 `import.meta`（单文件经典脚本里没有模块加载器）。' +
              '需要"等运行时再加载"就把逻辑写成普通函数。',
          );
        }

        // ★★ 说明符与子句必须回**原文**里取（掩码把引号连内容一起抹成了空白）。
        //   判"是不是纯副作用 import"也就只能看原文里有没有 `from`：
        //   有 `from` ⇒ 具名/命名空间导入；没有 ⇒ `import './x.ts';`。
        const q1 = nextQuote(src, i);
        if (q1 < 0) fail(file, src, i, '看不懂的 import 语句（没找到引号）。');
        const closes = closeQuote(src, q1);
        const specName = src.slice(q1 + 1, closes);
        const clauseSrc = src.slice(i + 6, q1);
        const hasFrom = /\bfrom\b/.test(clauseSrc);
        const stmtEnd = findStatementEnd(src, closes + 1);
        checkSpec(file, src, i, specName);

        if (!hasFrom) {
          // `import './x.ts';` —— 纯副作用，不建本地绑定
          deps.push({ spec: specName, bindings: [], kind: 'side-effect', line: lineOf(src, i) });
          blank(i, stmtEnd);
          i = stmtEnd;
          continue;
        }

        if (NAMESPACE_RE.exec(src.slice(i, q1 + 1))) {
          fail(
            file,
            src,
            i,
            '不支持 `import * as ns from …`（命名空间导入）。请改成具名导入：`import { a, b } from …`。',
          );
        }

        const df = DEFAULT_RE.exec(mask.slice(i, i + 400));
        if (df) {
          fail(
            file,
            src,
            i,
            `不支持默认导入（\`import ${df[1]} from …\`）。本项目一律用具名导出：` +
              '`export function f(){}` + `import { f } from …`。',
          );
        }

        const clause = clauseSrc.trim();
        if (/^type\b/.test(clause)) {
          blank(i, stmtEnd); // import type：只删不连边
          i = stmtEnd;
          continue;
        }
        if (!clause.startsWith('{')) {
          fail(file, src, i, `看不懂的 import 子句 \`${clause}\`（只支持 \`{ a, b }\` 形式）。`);
        }
        const inner = clause.slice(1, clause.lastIndexOf('}'));
        const sp = splitSpecifiers(inner, file, src, i);
        if (!sp.typeOnly) deps.push({ spec: specName, bindings: sp.names, kind: 'named', line: lineOf(src, i) });
        blank(i, stmtEnd);
        i = stmtEnd;
        continue;
      }
      // 不是"语句形式的 import"（属性名 `obj.import`、`{ import: 1 }`，或 `importXyz`
      // 这种已经过了 `atWordStart` 的词）⇒ 当普通标识符，只推进 6 个字符。
      take(i, i + 6);
      i += 6;
      continue;
    }

    // ── export ──
    //   ⚠ 只有**语句起始位置**的 `export` 才当关键字：`obj.export` / `{ export: 1 }`
    //     里的那个是**属性名**，合法代码，掩码也抹不掉它（踩过：`nextQuote()` 会从
    //     它开始向后无边界找引号，`findStatementEnd()` 随后把中间代码整段擦掉）。
    if (c === 'e' && mask.startsWith('export', i) && atWordStart(mask, i) && atStatementStart(mask, i)) {
      const after = mask[i + 6];
      if (after !== undefined && isIdChar(after)) {
        take(i, i + 6);
        i += 6;
        continue;
      }
      let j = i + 6;
      while (j < src.length && /\s/.test(mask[j])) j += 1;
      const word = (/^[A-Za-z]+/.exec(mask.slice(j, j + 20)) ?? [''])[0];

      if (!hasExportForm(mask, j)) {
        // 走到这里说明它是"语句开头的 `export`"，却不是我们认识的任何一种导出形式
        // —— 与其静默擦掉后面的代码，不如直接报错（宁可不打包，也不产出坏包）。
        if (word === '') {
          fail(
            file,
            src,
            i,
            '看不懂的 `export`：不支持 `export = …`（TS 的 CJS 赋值导出），' +
              '也**不允许**把 `export` 当属性名写在语句开头。请改成具名导出。',
          );
        }
        fail(
          file,
          src,
          i,
          `看不懂的导出形式（\`export ${word}\`）。支持的：` +
            '`export const|let|var` / `export function` / `export class` / `export {…}` / ' +
            '`export type` / `export interface` / `export * as ns from …`。',
        );
      }
      if (word === 'default') {
        fail(file, src, i, '不支持 `export default`。请用具名导出（`export function f(){}` / `export const x = …`）。');
      }
      if (word === 'type' || word === 'interface' || word === 'declare') {
        const stmtEnd = findStatementEnd(src, j);
        blank(i, stmtEnd);
        i = stmtEnd;
        continue;
      }
      if (src[j] === '*') {
        const m = /^\*\s*as\s+([A-Za-z_$][A-Za-z0-9_$]*)\s+from\s*['"]([^'"]+)['"]/.exec(src.slice(j));
        if (!m) {
          fail(file, src, i, '不支持 `export * from …`。若确实要转发，请显式命名：`export * as ns from \'./x.ts\'`。');
        }
        const stmtEnd = findStatementEnd(src, j + m[0].length);
        checkSpec(file, src, i, m[2]);
        nsExports.push({ name: m[1], spec: m[2], line: lineOf(src, i) });
        // ★ 它同时也是一个**导出名** —— 只往 nsExports 里塞会漏掉 `exports.ns = ns;`，
        //   于是别的模块 `import { ns } from './x.ts'` 拿到 undefined
        //   （渲染出的 `var ns = require(id);` 只是本模块内的局部变量）。
        //   本构建器实测踩过：`window.EmblemToolCore.emblem` 是 undefined，而"引导"却是成功的。
        exportNames.push(m[1]);
        assignments.push(`exports.${m[1]} = ${m[1]};`);
        blank(i, stmtEnd);
        i = stmtEnd;
        continue;
      }
      if (src[j] === '{') {
        const close = src.indexOf('}', j);
        if (close < 0) fail(file, src, i, 'export 列表没有闭合的 `}`。');
        const inner = src.slice(j + 1, close);
        if (src.slice(close + 1).trimStart().startsWith('from')) {
          fail(
            file,
            src,
            i,
            '不支持 `export { … } from \'./x.ts\'`（转发式 re-export）。请先在本文件里 import 再 export。',
          );
        }
        for (const p of inner.split(',')) {
          const t = p.trim();
          if (!t || t.startsWith('type ')) continue;
          const m = /^([A-Za-z_$][A-Za-z0-9_$]*)(?:\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*))?$/.exec(t);
          if (!m) fail(file, src, i, `看不懂的导出名 \`${t}\`。`);
          const name = m[2] ?? m[1];
          exportNames.push(name);
          assignments.push(`exports.${name} = ${m[1]};`);
        }
        blank(i, close + 1);
        i = close + 1;
        continue;
      }
      if (word === 'const' || word === 'let' || word === 'var') {
        const declStart = j + word.length;
        const bn = parseBindingNames(src, declStart);
        if (bn.names.length === 0) fail(file, src, i, `看不懂的 \`export ${word}\` 声明。`);
        for (const n of bn.names) {
          exportNames.push(n);
          assignments.push(`exports.${n} = ${n};`);
        }
        // ★ 只擦掉 `export ` 这 7 个字符：**先把输出位置推进到 `j`**（声明关键字处），
        //   让正常路径把 `const X = …;` 原样搬过去，再跳到初始化之后的 `bn.end`。
        //   ⚠ 两个坑都踩过：
        //     · `blank(i, bn.end)` → 把 `= 0x4440` 也擦掉 ⇒ `exports.SAVE_SIZE = SAVE_SIZE`
        //       报 `ReferenceError`；
        //     · `i = bn.end` 而不同时把输出推到 `j` ⇒ 整条声明凭空消失、只剩一个 `;`
        //       ⇒ 语法错误。
        blank(i, j);
        i = j;
        take(j, Math.min(bn.end, src.length));
        i = bn.end;
        continue;
      }
      if (word === 'function' || word === 'class' || word === 'async') {
        let k = j + word.length;
        if (word === 'async') {
          while (k < src.length && /\s/.test(src[k])) k += 1;
          if (!src.startsWith('function', k)) fail(file, src, i, '不支持这种 `export async …`（只支持 async function）。');
          k += 8;
        }
        const id = parseDeclName(src, k);
        if (!id) fail(file, src, i, `\`export ${word}\` 后面没有名字（匿名导出不支持）。`);
        exportNames.push(id.name);
        assignments.push(`exports.${id.name} = ${id.name};`);
        blank(i, j);
        i = j;
        continue;
      }
      // ★ 走到这里说明 `hasExportForm()` 已经点头、上面各个分支又都没接住 ——
      //   当前子集里没有这种形式（例如 `export async const …`）。仍然硬报错，
      //   不静默擦除（"擦多了"在别处只会表现为产物白屏，很难查）。
      fail(
        file,
        src,
        i,
        `看不懂的导出形式（\`export ${word || src[j] || ''}\`）。支持的：` +
          '`export const|let|var` / `export function` / `export class` / `export {…}` / ' +
          '`export type` / `export interface` / `export * as ns from …`。',
      );
    }

    take(i, i + 1);
    i += 1;
  }

  const code = out + '\n' + assignments.map((a) => a + '\n').join('');
  return { code, deps, exportNames, nsExports };
}

// --------------------------------------------------------------------------
// 模块图
// --------------------------------------------------------------------------

function stripTs(code, file) {
  try {
    return stripTypeScriptTypes(code, { mode: 'strip' });
  } catch (e) {
    throw new DisciplineError(
      `${file}\n  ★ 类型擦除失败：${e instanceof Error ? e.message : String(e)}\n` +
        '  （本项目只写"可擦除语法"：不要 enum / namespace / 装饰器 / 构造函数参数属性）',
    );
  }
}

function resolveSpec(fromAbs, spec, file, line) {
  const target = fileURLToPath(new URL(spec, pathToFileURL(fromAbs)));
  if (!existsSync(target)) {
    throw new DisciplineError(`${file}:${line}\n  ★ 找不到被 import 的文件：${rel(target)}`);
  }
  return target;
}

function collectModules(entry) {
  const idOf = new Map();
  const mods = [];
  const visiting = new Set();

  const visit = (abs, importer) => {
    if (idOf.has(abs)) return idOf.get(abs);
    if (visiting.has(abs)) {
      throw new DisciplineError(
        `① 循环依赖：${rel(abs)}${importer ? `（由 ${rel(importer)} 引入）` : ''}\n` +
          '  单文件打包器不支持环 —— 请把公共部分抽到一个不反向依赖的模块里。',
      );
    }
    visiting.add(abs);
    const file = rel(abs);
    const t = transformModule(file, stripTs(readFileSync(abs, 'utf8'), file));
    const id = mods.length;
    idOf.set(abs, id);
    mods.push({
      path: file,
      abs,
      code: t.code,
      deps: t.deps,
      exportNames: t.exportNames,
      nsExports: t.nsExports,
    });
    for (const d of [...t.deps, ...t.nsExports]) visit(resolveSpec(abs, d.spec, file, d.line), abs);
    visiting.delete(abs);
    return id;
  };

  visit(entry, null);
  return { order: mods, idOf };
}

/**
 * 生成可被**经典 `<script>`** 直接执行的 IIFE 包。
 *
 * 每个模块一个工厂函数；依赖在**函数体开头**用 `require()` 取，
 * 这样"依赖顺序"与"本地绑定名"都由源码里的 `import` 决定，不需要传参。
 */
function renderBundle(mods, idOf, entryId) {
  const ref = (fromAbs, fromFile, spec) => {
    const id = idOf.get(fileURLToPath(new URL(spec, pathToFileURL(fromAbs))));
    if (id === undefined) throw new DisciplineError(`${fromFile}\n  ★ 内部错误：依赖 ${spec} 不在模块图里。`);
    return id;
  };

  const parts = [];
  parts.push('/* 自动生成 —— 不要手改。源：web/src/ui/**  构建器：web/build.mjs */');
  parts.push('(function () {');
  parts.push('"use strict";');
  parts.push('var __m = {};');
  parts.push('var __f = [];');
  parts.push('function __req(id) {');
  parts.push('  if (Object.prototype.hasOwnProperty.call(__m, id)) return __m[id].exports;');
  parts.push('  var f = __f[id];');
  parts.push('  if (!f) throw new Error("模块 " + id + " 不存在");');
  parts.push('  var m = { exports: {} };');
  parts.push('  __m[id] = m;');
  parts.push('  f(__req, m.exports, m);');
  parts.push('  return m.exports;');
  parts.push('}');

  for (const mod of mods) {
    const id = idOf.get(mod.abs);
    const lines = [];
    for (const d of mod.deps) {
      const depId = ref(mod.abs, mod.path, d.spec);
      if (d.kind === 'side-effect') lines.push(`require(${depId}); /* 副作用：${d.spec} */`);
      else lines.push(`var { ${d.bindings.join(', ')} } = require(${depId});`);
    }
    for (const n of mod.nsExports) lines.push(`var ${n.name} = require(${ref(mod.abs, mod.path, n.spec)});`);
    parts.push(`__f[${id}] = function (require, exports, module) { // ${mod.path}`);
    parts.push('// ---- 依赖（由 import 生成；下面的代码行号与源文件一致）----');
    for (const l of lines) parts.push(l);
    parts.push(mod.code);
    parts.push('};');
  }
  parts.push(`__req(${entryId});`);
  parts.push('})();');
  return parts.join('\n');
}

// --------------------------------------------------------------------------
// 自检（导出给 web/test/ui.test.ts 复用）
// --------------------------------------------------------------------------

const SCRIPT_RE = /<script>([\s\S]*?)<\/script>/g;

/**
 * 产物里唯一的那个经典脚本块。
 *
 * ★ 为什么必须**先抹掉 HTML 注释**再用：外壳顶部那段说明性注释里出现了
 *   "script 标签"的字面量写法，直接扫全文会从注释里那个假标签开始配对，
 *   于是 `extractScripts()`"成功"返回了 27 万字节 —— 里面装的是**整篇 HTML**
 *   （冒烟测试因此报 `:root {` 语法错，而"脚本里有 import/export"全都没查出来）。
 *   教训：静态扫描前一定要先把"不是代码的部分"抹掉，再扫。
 */
export function extractScripts(html) {
  const clean = stripHtmlComments(html);
  const out = [];
  const re = new RegExp(SCRIPT_RE.source, 'g');
  let m;
  while ((m = re.exec(clean)) !== null) out.push(m[1]);
  return out;
}

/**
 * 去掉 HTML 注释（`<!-- … -->`，等长替换成空白，保留换行）。
 *
 * ★ 为什么扫描前必须先做这一步：外壳里有一段**说明性注释**会提到标签的写法
 *   （例如"把样式表链接换成内联 style 块"这类说明，或构建器自身的提示），
 *   直接按标签扫全文会把注释里的字面量当成真标签 —— 本构建器实测报过
 *   "只有 1 个脚本却数出 7 个"。用等长替换而不是删除，是为了让报错里的偏移量
 *   仍然能对回原文件。
 */
function stripHtmlComments(html) {
  return html.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '));
}

/**
 * 把产物里**所有**"注释类内容"抹成等长空白，得到一份可以放心做静态扫描的副本：
 *   · HTML 注释（`<!-- … -->`）
 *   · `<style>` 块**整块**
 *   · `<script>` 块里的 JS 注释与字符串内容（用 `maskSource`，因为它懂 JS 词法）
 *
 * ★ 边界很重要（踩过两次）：
 *   1. 先抹 HTML 注释 —— 外壳里那段说明性注释会**引用标签写法**，不抹会把标签数数错；
 *   2. **只在各自的块内**处理 —— 对整篇 HTML 跑"斜杠星号到星号斜杠"的替换会跨越标签
 *      边界、把 `</style>` 与 `<script>` 一起吃掉，于是"1 个脚本"被数成"0 个脚本"；
 *   3. `<style>` 块**整块抹掉**而不是只抹 CSS 注释 —— 本工具没有任何"CSS 里的外部引用"
 *      要查，而 CSS 的花括号会被 `extractScripts` 的正则误当成脚本内容
 *      （实测：`@media { … }` 会把 `<style>` 与 `<script>` 之间的东西卷进"脚本"里）。
 */
function stripMarkupComments(html) {
  let out = stripHtmlComments(html);
  out = out.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, (_m, open, body, close) => open + body.replace(/[^\n]/g, ' ') + close);
  out = out.replace(/(<script\b[^>]*>)([\s\S]*?)(<\/script>)/gi, (_m, open, body, close) => open + maskSource(body) + close);
  return out;
}

/**
 * ★ 产物自检。**任何一条不过 ⇒ `ok: false`**，调用方据此非零退出。
 *
 * 为什么在"能跑起来"之外还要查这些静态项：`file://` 下 `<script type="module">`
 * 会被 CORS 直接拦死，而离线场景里任何一行外部引用都会变成"白屏 + 一个没人看的报错"。
 * 这类失败**不会**在开发机上出现（开发时你总是从 http 打开），所以必须靠静态断言钉住。
 */
export function checkHtml(html) {
  const failures = [];
  const facts = [];

  // ① 单文件
  const files = existsSync(DIST_DIR) ? readdirSync(DIST_DIR).filter((f) => f.endsWith('.html')) : [];
  facts.push({ key: 'dist 里的 html 文件数', value: String(files.length) });
  if (files.length !== 1) failures.push(`dist 里应恰好 1 个 html，实到 ${files.length}：${files.join(', ')}`);
  if (files[0] !== 'emblem-tool.html') failures.push(`产物文件名应为 emblem-tool.html，实到 ${files[0] ?? '(无)'}`);

  // ★ 重活只算一遍：`stripMarkupComments()` 内部要跑 `maskSource()`，`extractScripts()`
  //   也是全量扫 —— 以前在同一份 `html` 上各算了两三次（行为不变，纯浪费）。
  const markup = stripMarkupComments(html);
  const scripts = extractScripts(html);

  // ② <script> 只有一个，且没有 module
  const scriptTagCount = (markup.match(/<script\b/g) ?? []).length;
  const moduleAttr = /type\s*=\s*["']module["']/i.test(markup);
  facts.push({ key: '<script> 标签数', value: String(scriptTagCount) });
  facts.push({ key: 'type="module"', value: moduleAttr ? '存在 ❌' : '不存在 ✅' });
  if (scriptTagCount !== 1) failures.push(`应恰好 1 个 <script>，实到 ${scriptTagCount}`);
  if (moduleAttr) failures.push('产物里出现了 type="module" —— file:// 下会被 CORS 拦死（SPEC.md §一）');

  if (scripts.length === 0) failures.push('没有找到经典的 <script>…</script> 内容');
  const script = scripts.join('\n');
  const scriptMask = maskSource(script); // ★ 注释/字符串已抹掉：只查真代码

  // ③ 脚本里不许有 import / export / 误嵌套的标签
  for (const kw of ['import', 'export']) {
    const m = new RegExp(`\\b${kw}\\b`).exec(scriptMask);
    facts.push({ key: `脚本里 ${kw}`, value: m ? `存在 ❌（偏移 ${m.index}）` : '不存在 ✅' });
    if (m) {
      failures.push(
        `内联脚本里出现 \`${kw}\`（偏移 ${m.index}）：` +
          JSON.stringify(script.slice(Math.max(0, m.index - 70), m.index + 70)),
      );
    }
  }
  const nested = script.indexOf('</script');
  if (nested >= 0) failures.push(`内联脚本里出现 </script（偏移 ${nested}）—— 会把脚本提前截断`);
  const openTag = script.indexOf('<script');
  if (openTag >= 0) failures.push(`内联脚本里出现 <script（偏移 ${openTag}）`);

  // ③b ★ 脚本**字符串字面量**里的对外引用（`maskSource()` 把字符串内容也抹白了 ⇒ ③④ 都看不见它）
  //
  //   为什么必须单独查：产物里写一句 `var u = "http://evil/x.js"`、`"<img src=x.png>"`、
  //   `"<link rel=stylesheet href=a.css>"` 时 —— ③ 查的是掩码后的脚本（字符串只剩引号）、
  //   ④ 查的是 `markup`（同样被掩码），于是**全都看不见**，那条"没有任何外部引用"的断言
  //   形同虚设、静默放行。这里把 `<script>` 块的**原文**过一遍字符串抽取器，只扫字面量内容。
  const literalScans = [
    ['脚本字符串里的 http(s)://', /https?:\/\//i],
    ['脚本字符串里的 link/img/script 标签', /<\s*(link|img|script)\b/i],
  ];
  //   ★ 唯一放行的**字符串**：`createElementNS` 的 SVG 命名空间（标准常量，不是网络引用）。
  const W3C_NS = 'http://www.w3.org/';
  for (const lit of stringLiteralSpans(script)) {
    if (lit.text.includes(W3C_NS)) continue;
    for (const [label, re] of literalScans) {
      const m = re.exec(lit.text);
      if (!m) continue;
      const at = lit.start + m.index;
      facts.push({ key: `外部引用 ${label}`, value: '1 处 ❌' });
      failures.push(
        `产物里有外部引用 \`${label}\`（脚本字符串偏移 ${at}）：` +
          JSON.stringify(script.slice(Math.max(0, at - 70), at + 70)),
      );
    }
  }

  // ④ 全文不许有对外引用（在"抹掉注释与字符串"的副本上扫；字符串里的那一半由 ③b 负责）
  const externals = [
    ['http://', /http:\/\//g],
    ['https://', /https:\/\//g],
    ['src="./', /src\s*=\s*["']\.\//gi],
    ['href="./', /href\s*=\s*["']\.\//gi],
    ['src="http', /src\s*=\s*["']https?:/gi],
    ['href="http', /href\s*=\s*["']https?:/gi],
    ['link 标签', /<link\b/gi],
    ['img 标签', /<img\b/gi],
    ['fetch(', /\bfetch\s*\(/g],
    ['XMLHttpRequest', /\bXMLHttpRequest\b/g],
    ['importScripts', /\bimportScripts\b/g],
    ['//cdn', /\/\/cdn\b/gi],
  ];
  for (const [label, re] of externals) {
    const hits = [];
    const r = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    let m;
    while ((m = r.exec(markup)) !== null) hits.push(m.index);
    facts.push({ key: `外部引用 ${label}`, value: hits.length === 0 ? '0 ✅' : `${hits.length} 处 ❌` });
    if (hits.length) {
      const at = hits[0];
      failures.push(
        `产物里有外部引用 \`${label}\`（${hits.length} 处，首个在偏移 ${at}）：` +
          JSON.stringify(html.slice(Math.max(0, at - 70), at + 70)),
      );
    }
  }

  // ⑤ 中文界面必须有 charset
  if (!/<meta\s+charset\s*=\s*["']utf-8["']\s*>/i.test(html)) {
    failures.push('缺少 <meta charset="utf-8"> —— 中文界面会乱码');
  }
  facts.push({ key: '内联脚本字节数', value: String(script.length) });

  return { ok: failures.length === 0, failures, facts };
}

/**
 * 引导冒烟：在 `node:vm` 里用**最小 DOM 桩**把包跑一遍。
 *
 * 它证明不了"界面长对了"（那要人眼看），但能证明：脚本能被引擎解析（没有残留 TS 语法）、
 * 每个模块工厂都能跑完（没有 `undefined is not a function` 这类模块初始化炸）、
 * `main.ts` 的引导路径跑到了最后（DOM 调用计数 > 阈值）。
 *
 * ⚠ 这是**静态/结构**验证的补充，**不是**"测过浏览器了"。
 */
export function smokeBoot(html) {
  const scripts = extractScripts(html);
  if (scripts.length === 0) return { ok: false, detail: '找不到内联脚本', domCalls: 0 };

  let domCalls = 0;
  /** ★ 新建了几个 canvas（取景拖动期间必须为 0 —— "没有重建 DOM"的判据）。 */
  let canvasCreations = 0;
  const makeCtx = () => ({
    imageSmoothingEnabled: true,
    imageSmoothingQuality: 'low',
    globalAlpha: 1,
    fillStyle: '#000',
    strokeStyle: '#000',
    lineWidth: 1,
    font: '',
    textAlign: 'left',
    getImageData(x, y, w, h) {
      domCalls += 1;
      return { data: new Uint8ClampedArray(Math.max(0, w * h * 4)), width: w, height: h };
    },
    putImageData() {
      domCalls += 1;
    },
    createImageData(w, h) {
      domCalls += 1;
      return { data: new Uint8ClampedArray(Math.max(0, w * h * 4)), width: w, height: h };
    },
    drawImage() {
      domCalls += 1;
    },
    clearRect() {},
    fillRect() {},
    strokeRect() {},
    beginPath() {},
    closePath() {},
    moveTo() {},
    lineTo() {},
    arc() {},
    rect() {},
    fill() {},
    stroke() {},
    save() {},
    restore() {},
    translate() {},
    scale() {},
    setTransform() {},
    measureText: () => ({ width: 0 }),
    fillText() {},
    strokeText() {},
    setLineDash() {},
    getLineDash: () => [],
    createLinearGradient: () => ({ addColorStop() {} }),
  });

  const makeEl = (tag) => ({
    tagName: String(tag).toUpperCase(),
    style: {},
    dataset: {},
    children: [],
    childNodes: [],
    attributes: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    textContent: '',
    innerHTML: '',
    value: '',
    type: '',
    checked: false,
    disabled: false,
    files: null,
    width: 0,
    height: 0,
    scrollTop: 0,
    scrollHeight: 0,
    title: '',
    draggable: false,
    appendChild(c) {
      domCalls += 1;
      this.children.push(c);
      this.childNodes.push(c);
      return c;
    },
    insertBefore(c) {
      domCalls += 1;
      this.children.push(c);
      return c;
    },
    removeChild(c) {
      domCalls += 1;
      const i = this.children.indexOf(c);
      if (i >= 0) this.children.splice(i, 1);
      return c;
    },
    remove() {
      domCalls += 1;
    },
    setAttribute(k, v) {
      domCalls += 1;
      this.attributes[k] = v;
    },
    getAttribute(k) {
      return this.attributes[k] ?? null;
    },
    removeAttribute(k) {
      delete this.attributes[k];
    },
    hasAttribute(k) {
      return k in this.attributes;
    },
    addEventListener() {
      domCalls += 1;
    },
    removeEventListener() {},
    dispatchEvent() {
      return true;
    },
    querySelector() {
      domCalls += 1;
      return makeEl('div');
    },
    querySelectorAll() {
      domCalls += 1;
      return [];
    },
    getContext() {
      domCalls += 1;
      return makeCtx();
    },
    toBlob(cb) {
      domCalls += 1;
      if (typeof cb === 'function') cb(null);
    },
    toDataURL() {
      domCalls += 1;
      return 'data:,';
    },
    focus() {},
    blur() {},
    click() {
      domCalls += 1;
    },
    select() {},
    getBoundingClientRect() {
      domCalls += 1;
      return { x: 0, y: 0, left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
    },
    setPointerCapture() {},
    releasePointerCapture() {},
    replaceChildren() {
      domCalls += 1;
    },
    contains: () => false,
    closest: () => null,
    cloneNode() {
      domCalls += 1;
      return makeEl(tag);
    },
    scrollIntoView() {},
  });

  const documentStub = {
    documentElement: makeEl('html'),
    head: makeEl('head'),
    body: makeEl('body'),
    title: '',
    readyState: 'complete',
    createElement: (tag) => {
      // ★ 数一下 canvas 被新建了几次：取景拖动期间必须是 0（"没有重建 DOM"的可观测判据）
      if (String(tag).toLowerCase() === 'canvas') canvasCreations += 1;
      return makeEl(tag);
    },
    createElementNS: (_ns, tag) => makeEl(tag),
    createTextNode: (t) => ({ nodeType: 3, textContent: t }),
    createDocumentFragment: () => makeEl('fragment'),
    getElementById: (id) => {
      domCalls += 1;
      const e = makeEl('div');
      e.id = id;
      return e;
    },
    querySelector: (sel) => {
      domCalls += 1;
      const e = makeEl('div');
      e.id = String(sel).replace(/^#/, '');
      return e;
    },
    querySelectorAll: () => [],
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => true,
    execCommand: () => true,
    fonts: { ready: Promise.resolve() },
    hidden: false,
    visibilityState: 'visible',
    activeElement: null,
  };

  const windowStub = {
    document: documentStub,
    location: { protocol: 'file:', href: 'file:///x/emblem-tool.html', search: '', hash: '' },
    isSecureContext: true,
    navigator: {
      userAgent: 'node-smoke',
      platform: 'Win32',
      clipboard: { writeText: () => Promise.resolve(), readText: () => Promise.resolve('') },
      language: 'zh-CN',
      languages: ['zh-CN'],
    },
    innerWidth: 1600,
    innerHeight: 900,
    devicePixelRatio: 1,
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    requestAnimationFrame: (cb) => setTimeout(() => cb(0), 0),
    cancelAnimationFrame: () => undefined,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    URL: { createObjectURL: () => 'blob:smoke', revokeObjectURL() {} },
    Blob: class {
      constructor(parts = [], opts = {}) {
        this.parts = parts;
        this.opts = opts;
      }
      get size() {
        return 0;
      }
      text() {
        return Promise.resolve('');
      }
      arrayBuffer() {
        return Promise.resolve(new ArrayBuffer(0));
      }
    },
    File: class {
      constructor(parts = [], name = '', opts = {}) {
        this.parts = parts;
        this.name = name;
        this.opts = opts;
      }
      get size() {
        return 0;
      }
      arrayBuffer() {
        return Promise.resolve(new ArrayBuffer(0));
      }
    },
    FileReader: class {
      constructor() {
        this.result = null;
        this.onload = null;
        this.onerror = null;
      }
      readAsArrayBuffer() {
        this.result = new ArrayBuffer(0);
        if (this.onload) this.onload();
      }
      readAsText() {
        this.result = '';
        if (this.onload) this.onload();
      }
    },
    alert: () => undefined,
    confirm: () => false,
    prompt: () => null,
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    ImageData: class {
      constructor(data, width, height) {
        this.data = data;
        this.width = width;
        this.height = height;
      }
    },
    DOMParser: class {
      parseFromString() {
        return documentStub;
      }
    },
    CustomEvent: class {
      constructor(type, init = {}) {
        this.type = type;
        this.init = init;
      }
    },
    Event: class {
      constructor(type, init = {}) {
        this.type = type;
        this.init = init;
      }
    },
    OffscreenCanvas: class {
      constructor(width, height) {
        this.width = width;
        this.height = height;
      }
      getContext() {
        return makeCtx();
      }
    },
    createImageBitmap: () => Promise.resolve({ width: 1, height: 1, close() {} }),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => true,
    close: () => undefined,
    focus: () => undefined,
  };
  windowStub.window = windowStub;
  windowStub.self = windowStub;
  windowStub.globalThis = windowStub;
  windowStub.top = windowStub;
  windowStub.parent = windowStub;

  const ctx = vm.createContext(windowStub);
  ctx.console = console;
  ctx.TextEncoder = TextEncoder;
  ctx.TextDecoder = TextDecoder;
  for (const k of [
    'Uint8Array', 'Uint8ClampedArray', 'Uint16Array', 'Uint32Array', 'Int32Array', 'Float64Array',
    'ArrayBuffer', 'DataView', 'Promise', 'Map', 'Set', 'WeakMap', 'WeakSet', 'JSON', 'Math', 'Date',
    'Error', 'TypeError', 'RangeError', 'SyntaxError', 'Symbol', 'Object', 'Array', 'Number', 'String',
    'Boolean', 'RegExp', 'Function', 'isNaN', 'isFinite', 'parseInt', 'parseFloat',
    'encodeURIComponent', 'decodeURIComponent', 'Reflect', 'Proxy',
  ]) {
    ctx[k] = globalThis[k];
  }

  try {
    new vm.Script(scripts.join('\n'), { filename: 'emblem-tool.html:inline' }).runInContext(ctx, {
      timeout: 60_000,
    });
  } catch (e) {
    return {
      ok: false,
      detail: `${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}\n${e && e.stack ? e.stack : ''}`,
      domCalls,
    };
  }
  if (domCalls < 200) {
    return { ok: false, detail: `只发生了 ${domCalls} 次 DOM 调用 —— 引导代码似乎没跑完`, domCalls };
  }

  // ★ 再用打包进去的**核心层**跑一次真活：编一个 128×128 的徽章块。
  //   这一条比"引导成功"强得多 —— 它证明 core/*.ts 的类型擦除没有把逻辑擦坏
  //   （第一版曾把 `export const N = 0x4440` 的初始化表达式一起擦掉，产物照样"生成成功"）。
  try {
    const core = windowStub.EmblemToolCore || ctx.EmblemToolCore;
    if (!core || !core.emblem || !core.card) {
      return {
        ok: false,
        detail:
          'window.EmblemToolCore 没有挂上（core 模块没被求值）。' +
          ` booted=${String(windowStub.__EMBLEM_TOOL_BOOTED__)} keys=${Object.keys(windowStub).length}`,
        domCalls,
      };
    }
    if (!core.ui || typeof core.ui.version !== 'string' || !core.ui.version) {
      return { ok: false, detail: 'window.EmblemToolCore.ui.version 不是非空字符串（版本号没被填进去）', domCalls };
    }
    // ⚠ 实色必须 ≤255，否则 injectImage 会拒绝（这是它的正确行为，不是 bug）——
    //   所以这里造的是"20 色调色板图"，而不是"每个像素一个色"。
    const palette = [];
    for (let i = 0; i < 20; i++) palette.push([(i * 13) & 0xff, (i * 41) & 0xff, (i * 97) & 0xff]);
    const rgba = new Uint8ClampedArray(128 * 128 * 4);
    for (let i = 0; i < 128 * 128; i++) {
      const o = i * 4;
      const c = palette[i % palette.length];
      rgba[o] = c[0];
      rgba[o + 1] = c[1];
      rgba[o + 2] = c[2];
      rgba[o + 3] = i % 37 === 0 ? 0 : 255; // 每 37 个像素留一个透明洞
    }
    const isLr = true;
    const block = core.emblem.encodeEmblem(rgba, { isLr });
    const expectLen = isLr ? 0x4420 : 0x4440;
    if (block.length !== expectLen) {
      return { ok: false, detail: `encodeEmblem 产出 ${block.length} 字节 ≠ ${expectLen}`, domCalls };
    }
    const v = core.emblem.verifyChecksums(block);
    if (!v.ok) {
      return { ok: false, detail: `encodeEmblem 的产出 18 段校验不过（${v.badSegments.length} 段）`, domCalls };
    }
    const back = core.emblem.extractImage(block, 'index0');
    if (back.length !== 128 * 128 * 4) {
      return { ok: false, detail: `extractImage 读回 ${back.length} 字节`, domCalls };
    }
    // card 层也要能跑（拿真夹具做一次只读解析）
    // ★ 0.19（D6）：夹具是**随附文件**，缺了说明构建环境不完整 ⇒ 直接失败。
    //   原先 `if (existsSync(fixture))` 包着：夹具缺失时**不报错、不提示**，静默少一条判据。
    const fixture = join(HERE, 'test', 'fixtures', 'blocks', 'Mcd001_final__BISLPS-25462EMB__data0.raw');
    if (!existsSync(fixture)) {
      return {
        ok: false,
        detail: `找不到真夹具 ${rel(fixture)} —— 它是随附文件（web/test/fixtures/blocks/），缺了就不该算构建通过`,
        domCalls,
      };
    }
    {
      const raw = new Uint8Array(readFileSync(fixture));
      const kind = core.emblem.saveKind(raw);
      if (kind !== 'emblem-lr') {
        return { ok: false, detail: `真夹具的 saveKind = ${kind}（应为 emblem-lr）`, domCalls };
      }
      const vv = core.emblem.verifyChecksums(raw);
      if (!vv.ok) {
        return { ok: false, detail: `真夹具的 18 段校验不过（${vv.badSegments.length} 段）`, domCalls };
      }
    }
    // ★★ 取景视图走一遍真实流程。它钉住两件事：
    //    ① v0.6 的 bug：〔确定取景〕之后 128×128 **不能是空的**
    //       （旧代码烘出 0 个不透明像素 = 用户看到的"图片消失"）；
    //    ② v0.7 的性能契约：**取景期间一次管线都不跑**（拖动/滚轮 N 次 ⇒ prepareEmblem 0 次、
    //       面板刷新 0 次、0 个新画布），只有〔确定取景〕那一下各 +1。
    //       实测旧代码每挪一个像素要 53~298 ms（prepareEmblem）+ 10~99 ms（统计面板）。
    const crop = {
      ran: false,
      opaquePixels: -1,
      manualScale: 0,
      offsetX: 0,
      offsetY: 0,
      closed: false,
      prepareDuringDrag: -1,
      refreshDuringDrag: -1,
      canvasesDuringDrag: -1,
      prepareOnConfirm: -1,
      refreshOnConfirm: -1,
      prepareOnCancel: -1,
      prepareOnToggleClean: -1,
      prepareOnToggleDirty: -1,
      movedVisually: false,
      frameStable: false,
      importAutoCrop: false,
      importWindowSize: 0,
      windowSize: 0,
      expectScale: 0,
      expectX: 0,
      expectY: 0,
    };
    try {
      const cropApi = core.ui.cropView;
      const statsApi = core.ui.pipeline;
      if (!cropApi || typeof cropApi.setCropView !== 'function' || typeof cropApi.confirmCrop !== 'function') {
        return { ok: false, detail: 'window.EmblemToolCore.ui.cropView 没有挂上（取景视图没法在冒烟里驱动）', domCalls };
      }
      if (!statsApi || typeof statsApi.pipelineStats !== 'function') {
        return { ok: false, detail: 'window.EmblemToolCore.ui.pipeline.pipelineStats 没有挂上（数不到调用次数）', domCalls };
      }
      for (const fn of ['applyDrag', 'applyZoom', 'flushCropLayout', 'cropInfo']) {
        if (typeof cropApi[fn] !== 'function') {
          return { ok: false, detail: `cropView.${fn}() 没有导出（冒烟没法模拟拖动/缩放）`, domCalls };
        }
      }
      const stat = () => statsApi.pipelineStats();
      const SW = 1024;
      const SH = 600;
      const sdata = new Uint8ClampedArray(SW * SH * 4);
      for (let i = 0; i < SW * SH; i++) {
        sdata[i * 4] = 200;
        sdata[i * 4 + 1] = 120;
        sdata[i * 4 + 2] = 40;
        sdata[i * 4 + 3] = 255;
      }
      core.ui.state.source = { data: sdata, width: SW, height: SH, name: 'smoke-1024x600' };
      const p = core.ui.state.params;
      const fillSide = Math.min(SW, SH);
      const fillScale = 128 / fillSide;

      // ⓪ ★ 0.16：走**真路**导入这张图 ⇒ 必须自动进取景模式，并且参数按"填满白框"算好
      //    （以前这里手抄一遍 `fillManualToTarget()` 的四个字段；现在改成调真函数，
      //      "导入之后到底做了什么"就由真代码负责，测试只断言结果。）
      const importApi = core.ui.imageImport;
      if (!importApi || typeof importApi.applyImportedImage !== 'function') {
        return { ok: false, detail: 'window.EmblemToolCore.ui.imageImport.applyImportedImage 没有挂上', domCalls, crop };
      }
      importApi.applyImportedImage({ data: sdata, width: SW, height: SH, name: 'smoke-1024x600' }, 'smoke-1024x600');
      crop.importAutoCrop = cropApi.isCropActive();
      crop.importWindowSize = cropApi.cropInfo().size;
      if (crop.importAutoCrop !== true) {
        return { ok: false, detail: '★★ 导入图片之后**没有**自动进取景模式（0.16 用户要求）', domCalls, crop };
      }
      if (Math.abs(crop.importWindowSize - fillSide) > 1e-9) {
        return {
          ok: false,
          detail: `导入之后取景窗口边长应是源图短边 ${fillSide}（"填满白框"），实到 ${crop.importWindowSize}`,
          domCalls,
          crop,
        };
      }
      cropApi.setCropView(false); // 收起来，接着走下面那套"进 / 拖 / 确定 / 取消"流程
      const base = stat();

      // ① 进视图：**不跑管线、不改参数**（接着"当前图片"显示）
      cropApi.setCropView(true);
      crop.ran = true;
      const info0 = cropApi.cropInfo();
      if (!info0.active) return { ok: false, detail: 'setCropView(true) 之后 cropInfo().active 不是 true', domCalls, crop };
      if (stat().prepareCalls !== base.prepareCalls || stat().refreshCalls !== base.refreshCalls) {
        return { ok: false, detail: `进视图就跑了管线：${JSON.stringify(stat())} vs ${JSON.stringify(base)}`, domCalls, crop };
      }
      if (
        Math.abs(p.manualScale - fillScale) > 1e-9 ||
        Math.abs(p.manualOffsetX - (SW - fillSide) / 2) > 1e-9 ||
        Math.abs(p.manualOffsetY - (SH - fillSide) / 2) > 1e-9
      ) {
        return {
          ok: false,
          detail: `进取景视图后参数被改动了：倍率 ${p.manualScale}、偏移 (${p.manualOffsetX}, ${p.manualOffsetY})（应保持 ${fillScale} / 居中）`,
          domCalls,
          crop,
        };
      }

      // ② ★ 连续拖动 30 次 + 滚轮 10 次：**一次管线都不能跑**，也不能新建画布
      //   ⚠ 0.45：这里原来还写 `crop.drags = 40`，而 `ui.test.ts` 断言 `crop.drags === 40`
      //     —— 那是**断言一个刚赋进去的常量**（恒真）。手势次数不是可观测量，判据要靠下面
      //     的"调用计数"与 `movedVisually`（视觉真的动了）来立；次数本身只出现在 detail 文案里。
      const canvasesBefore = canvasCreations;
      for (let i = 0; i < 30; i++) cropApi.applyDrag(7, -3);
      for (let i = 0; i < 10; i++) cropApi.applyZoom(1.15);
      cropApi.flushCropLayout();
      const during = stat();
      crop.prepareDuringDrag = during.prepareCalls - base.prepareCalls;
      crop.refreshDuringDrag = during.refreshCalls - base.refreshCalls;
      crop.canvasesDuringDrag = canvasCreations - canvasesBefore;
      const info1 = cropApi.cropInfo();
      crop.movedVisually = info1.transform !== info0.transform;
      crop.frameStable = Math.abs(info1.frameSide - info0.frameSide) < 1e-9 && info1.frameSide > 0;
      if (crop.prepareDuringDrag !== 0) {
        return { ok: false, detail: `★★ 拖动/滚轮期间跑了 ${crop.prepareDuringDrag} 次 prepareEmblem（必须 0）`, domCalls, crop };
      }
      if (crop.refreshDuringDrag !== 0) {
        return { ok: false, detail: `★★ 拖动/滚轮期间刷新了 ${crop.refreshDuringDrag} 次面板（必须 0）`, domCalls, crop };
      }
      if (crop.canvasesDuringDrag !== 0) {
        return { ok: false, detail: `★★ 拖动期间新建了 ${crop.canvasesDuringDrag} 个 canvas（DOM 被重建了）`, domCalls, crop };
      }
      if (!crop.movedVisually) return { ok: false, detail: '拖动之后源图的 transform 没变（视觉没动）', domCalls, crop };
      if (!crop.frameStable) return { ok: false, detail: `白框在取景期间动了：${info0.frameSide} → ${info1.frameSide}`, domCalls, crop };
      if (!(info1.size < info0.size)) return { ok: false, detail: `滚轮没有缩小窗口：${info0.size} → ${info1.size}`, domCalls, crop };
      if (Math.abs(info1.y - info0.y) < 1e-9 && Math.abs(info1.x - info0.x) < 1e-9) {
        return { ok: false, detail: '拖动没有改变窗口位置（视觉动了但窗口没动？）', domCalls, crop };
      }

      // ②b ★ 0.38：滑条 / 输入框那条路（`setCropWindowSize()`）—— 直接给整数边长，**同样不跑管线**
      //   判据三条：给中间的整数 ⇒ 正好是它；给太小 / 太大 ⇒ 夹到 windowBoundsFor() 的上下限。
      {
        const lo = Math.min(128, Math.min(SW, SH));
        const hi = Math.max(SW, SH);
        const want = Math.round((lo + hi) / 2);
        const before = stat();
        cropApi.setCropWindowSize(want);
        crop.setSizeExact = cropApi.cropInfo().size;
        cropApi.setCropWindowSize(lo - 500);
        crop.setSizeLowClamp = cropApi.cropInfo().size;
        cropApi.setCropWindowSize(hi + 5000);
        crop.setSizeHighClamp = cropApi.cropInfo().size;
        crop.setSizePrepareDelta = stat().prepareCalls - before.prepareCalls;
        crop.setSizeRefreshDelta = stat().refreshCalls - before.refreshCalls;
        if (crop.setSizeExact !== want) {
          return { ok: false, detail: `setCropWindowSize(${want}) 之后边长是 ${crop.setSizeExact}`, domCalls, crop };
        }
        if (crop.setSizeLowClamp !== lo) {
          return { ok: false, detail: `给太小的值应夹到下限 ${lo}，实到 ${crop.setSizeLowClamp}`, domCalls, crop };
        }
        if (crop.setSizeHighClamp !== hi) {
          return { ok: false, detail: `给太大的值应夹到上限 ${hi}，实到 ${crop.setSizeHighClamp}`, domCalls, crop };
        }
        if (crop.setSizePrepareDelta !== 0 || crop.setSizeRefreshDelta !== 0) {
          return {
            ok: false,
            detail: `★ 用滑条改白框大小不该跑管线/刷面板（实到 ${crop.setSizePrepareDelta}/${crop.setSizeRefreshDelta}）`,
            domCalls,
            crop,
          };
        }
      }

      // ③ ★ 2026-10-05（v0.9）：〔↺ 复位 / 适应〕按钮已按用户要求**删除**
      //    （"我认为这个按钮没用，删了吧"）⇒ 这里不再有"复位"这一步。
      //    提交之前先把窗口记下来，用它当"窗口 → 参数"的**期望值**（下一步校验）：

      // ④ ★〔确定取景〕：**就这一下**跑管线（一次重算 + 一次面板刷新）
      const winBefore = cropApi.cropInfo();
      crop.windowSize = winBefore.size;
      crop.expectScale = 128 / winBefore.size; // 目标边长 128 / 窗口边长（源像素口径）
      crop.expectX = winBefore.x;
      crop.expectY = winBefore.y;
      cropApi.confirmCrop();
      const onConfirm = stat();
      crop.prepareOnConfirm = onConfirm.prepareCalls - base.prepareCalls;
      crop.refreshOnConfirm = onConfirm.refreshCalls - base.refreshCalls;
      if (crop.prepareOnConfirm !== 1) {
        return { ok: false, detail: `★★ 〔确定取景〕跑了 ${crop.prepareOnConfirm} 次 prepareEmblem（应为 1）`, domCalls, crop };
      }
      if (crop.refreshOnConfirm !== 1) {
        return { ok: false, detail: `★★ 〔确定取景〕刷新了 ${crop.refreshOnConfirm} 次面板（应为 1）`, domCalls, crop };
      }
      crop.closed = cropApi.isCropActive() === false;
      if (!crop.closed) return { ok: false, detail: '〔确定取景〕之后取景视图没有关掉（自检把好的结果也拦了？）', domCalls, crop };
      crop.manualScale = p.manualScale;
      crop.offsetX = p.manualOffsetX;
      crop.offsetY = p.manualOffsetY;
      // ★★ 窗口 → 参数（唯一的换算点，源像素口径）：倍率 = 128/窗口边长、X/Y = 窗口左上角。
      //    旧版这里写死过"适应之后 = 0.125 / (0,−212)"；现在没有"复位"那一步，
      //    期望值只能从**提交前的窗口**推出来 —— 这也正是这个冒烟真正要钉住的那条契约。
      if (Math.abs(p.manualScale - crop.expectScale) > 1e-9) {
        return {
          ok: false,
          detail: `取景倍率 ${p.manualScale} ≠ 128/窗口边长 = ${crop.expectScale}（窗口边长 ${winBefore.size}）`,
          domCalls,
          crop,
        };
      }
      if (Math.abs(p.manualOffsetX - crop.expectX) > 1e-9 || Math.abs(p.manualOffsetY - crop.expectY) > 1e-9) {
        return {
          ok: false,
          detail: `取景偏移 (${p.manualOffsetX}, ${p.manualOffsetY}) ≠ 窗口左上角 (${crop.expectX}, ${crop.expectY})`,
          domCalls,
          crop,
        };
      }
      const prep = core.ui.state.prepared;
      if (!prep) return { ok: false, detail: '〔确定取景〕之后 state.prepared 是空的', domCalls, crop };
      let opaque = 0;
      for (let i = 0; i < prep.rgba.length; i += 4) if (prep.rgba[i + 3] === 255) opaque += 1;
      crop.opaquePixels = opaque;
      if (opaque <= 0) {
        return {
          ok: false,
          detail: `★★ 〔确定取景〕之后 128×128 里一个不透明像素都没有（${opaque}）—— 这就是用户看到的"图片消失"`,
          domCalls,
          crop,
        };
      }

      // ⑤ 〔取消〕：参数没被改过，所以**连管线都不用跑**
      const beforeCancel = stat();
      cropApi.setCropView(true);
      for (let i = 0; i < 5; i++) cropApi.applyDrag(-9, 4);
      cropApi.flushCropLayout();
      cropApi.cancelCrop();
      crop.prepareOnCancel = stat().prepareCalls - beforeCancel.prepareCalls;
      if (crop.prepareOnCancel !== 0) {
        return { ok: false, detail: `★★ 〔取消〕跑了 ${crop.prepareOnCancel} 次 prepareEmblem（应为 0）`, domCalls, crop };
      }
      if (cropApi.isCropActive()) return { ok: false, detail: '〔取消〕之后视图还开着', domCalls, crop };
      if (Math.abs(p.manualScale - crop.expectScale) > 1e-9 || Math.abs(p.manualOffsetY - crop.expectY) > 1e-9) {
        return {
          ok: false,
          detail: `〔取消〕把已确定的参数弄坏了：${p.manualScale} / (${p.manualOffsetX}, ${p.manualOffsetY})`,
          domCalls,
          crop,
        };
      }

      // ⑥ 工具条那个按钮收起来：有未提交的调整时**必须提交**（不许静默丢掉用户刚拖好的取景）
      if (typeof cropApi.toggleCropView !== 'function') {
        return { ok: false, detail: 'cropView.toggleCropView() 没有导出', domCalls, crop };
      }
      const beforeToggle = stat();
      cropApi.setCropView(true); // 没动过 ⇒ 直接收起，不跑管线
      cropApi.toggleCropView();
      crop.prepareOnToggleClean = stat().prepareCalls - beforeToggle.prepareCalls;
      if (crop.prepareOnToggleClean !== 0) {
        return { ok: false, detail: `没调整时收起取景视图跑了 ${crop.prepareOnToggleClean} 次管线（应为 0）`, domCalls, crop };
      }
      cropApi.setCropView(true);
      // 诊断留痕（失败时能一眼看出"窗口到底动没动"）
      const winClean = cropApi.cropInfo();
      // ⚠ 方向要挑**一定动得了**的：前面的 30 次 `applyDrag(7,-3)` 已经把窗口推到 y 的下边界
      //   （600−148.3 = 451.7），再往下拖会被 `clampWindow` 夹住 ⇒ 窗口没变 ⇒ `hasUncommittedWindow()`
      //   为 false ⇒ 收起时不提交（**那是正确行为**，但这条冒烟就测不到"有未提交调整时会提交"了）。
      //   所以这里改成：往上拖 + 往外滚一格（两者都一定改变窗口）。
      cropApi.applyDrag(0, 600);
      cropApi.applyZoom(1 / 1.15);
      cropApi.flushCropLayout();
      const winDirty = cropApi.cropInfo();
      crop.winClean = `${winClean.size.toFixed(3)}@${winClean.x.toFixed(3)},${winClean.y.toFixed(3)}`;
      crop.winDirty = `${winDirty.size.toFixed(3)}@${winDirty.x.toFixed(3)},${winDirty.y.toFixed(3)}`;
      crop.frameSideAtToggle = winClean.frameSide;
      cropApi.toggleCropView();
      crop.prepareOnToggleDirty = stat().prepareCalls - beforeToggle.prepareCalls;
      if (crop.prepareOnToggleDirty !== 1) {
        return {
          ok: false,
          detail:
            `★ 有未提交调整时收起取景视图只跑了 ${crop.prepareOnToggleDirty} 次管线（应为 1 —— 不能静默丢掉调整）` +
            `；窗口 ${crop.winClean} → ${crop.winDirty}（白框 ${crop.frameSideAtToggle}px）`,
          domCalls,
          crop,
        };
      }
      if (cropApi.isCropActive()) return { ok: false, detail: 'toggleCropView() 之后视图还开着', domCalls, crop };
    } catch (e) {
      return {
        ok: false,
        detail: `取景视图冒烟失败：${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`,
        domCalls,
        crop,
      };
    }
    return {
      ok: true,
      detail:
        `引导成功（DOM 调用 ${domCalls} 次）+ 核心层冒烟通过（encodeEmblem/extractImage 18 段校验）` +
        `+ 取景冒烟通过（1024×600 → 倍率 ${crop.manualScale}、偏移 ${crop.offsetX},${crop.offsetY}、` +
        `不透明 ${crop.opaquePixels}/16384；拖动 30 次 + 滚轮 10 次 ⇒ prepareEmblem ${crop.prepareDuringDrag} 次、` +
        `面板刷新 ${crop.refreshDuringDrag} 次、新画布 ${crop.canvasesDuringDrag} 个；` +
        `〔确定取景〕⇒ ${crop.prepareOnConfirm}/${crop.refreshOnConfirm} 次；〔取消〕⇒ ${crop.prepareOnCancel} 次；` +
        `工具条收起 ⇒ ${crop.prepareOnToggleClean}/${crop.prepareOnToggleDirty} 次）`,
      domCalls,
      crop,
    };
  } catch (e) {
    return {
      ok: false,
      detail: `核心层冒烟失败：${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`,
      domCalls,
    };
  }
}

// --------------------------------------------------------------------------
// 组装
// --------------------------------------------------------------------------

const SCRIPT_PLACEHOLDER = '<!--BUNDLE-->';

/**
 * 从 `src/ui/logic/version.ts` 里读出 `APP_VERSION`（**唯一权威来源**）。
 *
 * ★ 故意**不 import 那个模块**：构建器只需要"能读懂一行常量"这一点能力，
 *   不该因为 UI 模块将来多引了一个浏览器专用 API 就跟着挂掉。
 *   也故意**不在 build.mjs 里写死版本号**（写死就有两份、必然漂移）。
 */
export function readAppVersion() {
  const file = join(HERE, 'src', 'ui', 'logic', 'version.ts');
  if (!existsSync(file)) throw new DisciplineError('找不到 src/ui/logic/version.ts（版本号的唯一来源）');
  const text = readFileSync(file, 'utf8');
  const m = /export\s+const\s+APP_VERSION\s*(?::[^=]+)?=\s*['"]([^'"]+)['"]/.exec(text);
  if (!m) {
    throw new DisciplineError(
      "src/ui/logic/version.ts 里找不到 `export const APP_VERSION = '…'`（版本号必须显式写在那里）",
    );
  }
  return m[1];
}

/** 产物里版本号那两处真值的写法（`assemble()` 写进去的就是它）。 */
const ARTIFACT_VERSION_ATTR_RE = /data-app-version="v([^"]*)"/;
const ARTIFACT_VERSION_TEXT_RE = /<span class="brand-sub" id="app-version"[^>]*>([^<]*)<\/span>/;

/**
 * ★★ 产物版本号**硬校验**：产物里印着的版本号必须与 `version.ts::APP_VERSION` 一致。
 *
 * 为什么必须有（0.41 才补上，之前是**假校验**）：以前这里只查"源码里那个常量的格式
 * 是不是 `0.xx`"，于是改了 `version.ts` 之后跑 `node web\build.mjs --check`
 * （旧产物还在）会打印**旧**版本号、报 ✅、exit 0 —— "界面写着 v0.40、源码是 v0.41"
 * 这种事永远查不出来。现在读产物文本比对，不一致就**非零退出**并说清"产物过期了"。
 *
 * 返回"失败原因"数组（空 = 一致）。导出是为了让测试/手工排查能单独打这条判据。
 */
export function checkArtifactVersion(html, appVersion) {
  const failures = [];
  const wantLabel = `v${appVersion}`;
  const m = ARTIFACT_VERSION_ATTR_RE.exec(html);
  const text = ARTIFACT_VERSION_TEXT_RE.exec(html);
  if (!m) {
    failures.push(
      '产物里找不到 `data-app-version="v…"`（版本号占位 span 没被替换？）' +
        ' —— 产物过期或损坏，请重新构建：node web\\build.mjs',
    );
    return failures;
  }
  if (m[1] !== appVersion) {
    failures.push(
      `★ 产物过期了：产物里是 v${m[1]}，而 src/ui/logic/version.ts 里是 ${wantLabel}` +
        ' —— 请重新构建：node web\\build.mjs（--check 只校验已有产物，不会替你重新打包）',
    );
  }
  if (!text) {
    failures.push('产物里找不到版本号 span（`<span class="brand-sub" id="app-version">…</span>`）—— 产物损坏，请重新构建');
  } else if (text[1] !== wantLabel) {
    failures.push(`★ 产物顶栏显示的版本号是 ${text[1]}，与源码里的 ${wantLabel} 不一致 —— 请重新构建：node web\\build.mjs`);
  }
  return failures;
}

/** 外壳里版本号的占位 span（构建时整段替换成带真值的 span —— **只有这一处**契约）。 */
const VERSION_SPAN_RE = /<span class="brand-sub" id="app-version"[^>]*>v\?<\/span>/;

function assemble(shell, css, bundle, appVersion) {
  if (!shell.includes(SCRIPT_PLACEHOLDER)) {
    throw new DisciplineError(`web/index.html 里找不到占位符 ${SCRIPT_PLACEHOLDER}`);
  }
  const linkRe = /[ \t]*<link[^>]*href\s*=\s*["'][^"']*styles\.css["'][^>]*>[ \t]*\r?\n?/i;
  if (!linkRe.test(shell)) throw new DisciplineError('web/index.html 里找不到 <link … styles.css>');
  // ★★ 必须用**替换函数**，不能用替换字符串！
  //   替换字符串里的 `$'` / `$&` / 反引号 是**特殊模式**（分别表示"匹配之后的部分"/
  //   "整个匹配"/"匹配之前的部分"）。而打包出来的代码里到处是 `$('some-id')`
  //   —— 也就是 `$` 后面紧跟一个单引号 —— 于是 `replace()` 会把**整篇 HTML**
  //   塞进那个位置：产物看起来"生成成功"，实际脚本里被插进了几十 KB 的 HTML。
  //   本构建器实测踩过：冒烟测试报 `:root {` 语法错，而且产物里出现了 3 个 DOCTYPE。
  //   替换函数没有这个坑。
  let html = shell.replace(linkRe, () => `<style>\n${css.trim()}\n</style>\n`);

  // 版本号：把外壳里那个占位 span 整段换成真值（**唯一来源仍是 version.ts**）。
  // ★ 0.19（B14）：原来是"两条契约"（先换 `data-app-version` 属性、再用正则换 span 文本）——
  //   现在只有这一条：占位 span 长什么样、换成什么，都在这一个正则里。
  if (appVersion) {
    if (!VERSION_SPAN_RE.test(html)) {
      throw new DisciplineError(
        'web/index.html 里找不到版本号占位 span（应形如 <span class="brand-sub" id="app-version" …>v?</span>）',
      );
    }
    const label = `v${appVersion}`;
    html = html.replace(
      VERSION_SPAN_RE,
      `<span class="brand-sub" id="app-version" data-app-version="${label}">${label}</span>`,
    );
  }

  return html.replace(SCRIPT_PLACEHOLDER, () => `<script>\n${bundle}\n</script>`);
}

// --------------------------------------------------------------------------
// main
// --------------------------------------------------------------------------

function main() {
  const argv = process.argv.slice(2);
  const knownFlags = ['--check', '--verbose'];
  const unknown = argv.filter((a) => a.startsWith('--') && !knownFlags.includes(a));
  if (unknown.length) {
    // ★ 0.19：原先 `--checks` 这种笔误会被静默忽略、然后跑一次完整构建并 exit 0。
    console.error(`✗ 不认识的参数：${unknown.join(' ')}（只支持 ${knownFlags.join(' / ')}）`);
    return 2;
  }
  const checkOnly = argv.includes('--check');
  const verbose = argv.includes('--verbose');
  const banner = '='.repeat(78);

  console.log(banner);
  console.log('徽章工具 · 单文件打包器（零依赖）');
  console.log(banner);
  console.log(`[env] node                 = ${process.version}`);
  console.log(`[env] stripTypeScriptTypes = ${typeof stripTypeScriptTypes}`);
  if (typeof stripTypeScriptTypes !== 'function') {
    console.error(
      '✗ 本构建器依赖 node:module 的 stripTypeScriptTypes（Node ≥ 22.13；本机需 24）。\n' +
        '  没有它就只能引 npm 依赖（typescript / esbuild），而本项目规定零依赖。',
    );
    return 2;
  }

  if (checkOnly) {
    if (!existsSync(OUT)) {
      console.error(`✗ --check：产物不存在：${rel(OUT)}（先跑一次 node web\\build.mjs）`);
      return 2;
    }
    console.log(`[check] 只校验已有产物：${rel(OUT)}`);
  } else {
    for (const [p, what] of [
      [ENTRY, '入口'],
      [SHELL, 'HTML 外壳'],
      [CSS, '样式表'],
    ]) {
      if (!existsSync(p)) {
        console.error(`✗ 找不到${what}：${rel(p)}`);
        return 2;
      }
    }

    console.log('\n--- 1) 收集模块图 ---');
    let mods;
    let idOf;
    try {
      const r = collectModules(ENTRY);
      mods = r.order;
      idOf = r.idOf;
    } catch (e) {
      console.error(`\n✗ 打包失败\n${e instanceof Error ? e.message : String(e)}`);
      return 1;
    }
    if (verbose) {
      for (const m of mods) {
        console.log(
          `   [${idOf.get(m.abs)}] ${m.path}  deps=${m.deps.length + m.nsExports.length} exports=${m.exportNames.length}`,
        );
      }
    }
    console.log(`   模块 ${mods.length} 个，导出共 ${mods.reduce((a, m) => a + m.exportNames.length, 0)} 个`);

    // 防御 ①：每个模块的产物必须**能被 JS 引擎解析**。
    //   这一条是本构建器最值钱的断言：一次"擦多/擦少"在别处只会表现为
    //   "产物生成成功、双击白屏"，而在这里会立刻指名道姓地失败。
    for (const m of mods) {
      try {
        new vm.Script(`(function (require, exports, module) {\n${m.code}\n})`, {
          filename: `${m.path}(transformed)`,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const line = /:(\d+)\b/.exec(msg);
        const ln = line ? Number(line[1]) - 1 : -1;
        const src = m.code.split('\n');
        console.error(
          `\n✗ ${m.path} 变换后的代码**语法不通过**：${msg}\n` +
            (ln > 0
              ? `   第 ${ln} 行附近：${JSON.stringify(src.slice(Math.max(0, ln - 2), ln + 2).join('\n'))}\n`
              : '') +
            '   （这是打包器把某个 import/export 擦错了位置的信号，别忽略）',
        );
        return 1;
      }
    }

    // 防御 ②：模块代码里若残留**真代码**形式的 `require(`，说明有没被识别的语法。
    // ⚠ 只查掩码（注释/字符串已变空白）—— 否则注释里提一句 `require(` 就会误报。
    for (const m of mods) {
      const hit = /\brequire\s*\(/.exec(maskSource(m.code));
      if (hit) {
        console.error(
          `\n✗ ${m.path} 的代码里出现了 \`require(\`（偏移 ${hit.index}）—— ` +
            '本打包器只认识 `import … from …`；请把那段改成 import。',
        );
        return 1;
      }
    }

    console.log('\n--- 2) 组装单文件 ---');
    const entryId = idOf.get(ENTRY);
    if (entryId === undefined) {
      console.error('✗ 内部错误：入口模块不在模块图里');
      return 1;
    }
    let html;
    try {
      html = assemble(
        readFileSync(SHELL, 'utf8'),
        readFileSync(CSS, 'utf8'),
        renderBundle(mods, idOf, entryId),
        readAppVersion(),
      );
    } catch (e) {
      console.error(`\n✗ 组装失败\n${e instanceof Error ? e.message : String(e)}`);
      return 1;
    }

    console.log('\n--- 3) 写产物 ---');
    try {
      rmSync(DIST_DIR, { recursive: true, force: true });
      mkdirSync(DIST_DIR, { recursive: true });
      writeFileSync(OUT, html, 'utf8');
    } catch (e) {
      console.error(`\n✗ 写产物失败：${e instanceof Error ? e.message : String(e)}`);
      return 1;
    }
    console.log(`   ${rel(OUT)}`);
  }

  const html = readFileSync(OUT, 'utf8');

  // ★ 版本号自检：产物里必须真的印着 version.ts 里那个版本号。
  //   （只打印、不比对 = 迟早会出现"界面写着 v0.1、源码是 0.2"这种事。）
  let appVersion = '(读不到)';
  try {
    appVersion = readAppVersion();
  } catch (e) {
    console.error(`\n✗ ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  const versionFailures = [];
  if (!/^0\.\d+$/.test(appVersion)) {
    versionFailures.push(
      `APP_VERSION = "${appVersion}" 不符合规则：应从 0.1 起、**每次交付 +0.01**` +
        '（唯一真值来源见 src/ui/logic/version.ts 文件头；只有用户明确说"可以发布了"才进 1.x）',
    );
  }
  // ★★ 0.41：光比"源码里的版本号格式对不对"是**假校验** —— 改了 `version.ts` 之后
  //   跑 `node web\build.mjs --check`（旧产物还在）会打印旧版本号 + ✅ + exit 0，
  //   "产物写着 v0.40、源码是 v0.41"这种事永远查不出来。所以这里**读产物文本比对**。
  const artifactFailures = checkArtifactVersion(html, appVersion);

  console.log('\n--- 4) 产物自检 ---');
  const res = checkHtml(html);
  for (const f of res.facts) console.log(`   ${String(f.key).padEnd(22, ' ')} : ${f.value}`);

  console.log('\n--- 5) 引导冒烟（node:vm + 最小 DOM 桩）---');
  const smoke = smokeBoot(html);
  console.log(`   ${smoke.ok ? '✅' : '❌'} ${String(smoke.detail).split('\n')[0]}`);
  if (!smoke.ok) console.log(smoke.detail);

  console.log('\n--- 6) 体积与版本 ---');
  const bytes = Buffer.byteLength(html, 'utf8');
  console.log(`   文件     : ${rel(OUT)}`);
  console.log(`   版本号   : v${appVersion}  （来源：src/ui/logic/version.ts::APP_VERSION）`);
  console.log(`   体积     : ${bytes.toLocaleString('en-US')} 字节（${(bytes / 1024).toFixed(1)} KiB）`);
  console.log(`   行数     : ${html.split('\n').length.toLocaleString('en-US')}`);
  console.log(`   内联脚本 : ${extractScripts(html).join('\n').length.toLocaleString('en-US')} 字节`);

  const failures = [...res.failures, ...versionFailures, ...artifactFailures];
  if (!smoke.ok) failures.push(`引导冒烟失败：${smoke.detail}`);

  console.log('\n' + banner);
  if (failures.length === 0) {
    console.log(
      `✅ 自检全过：单文件、无 import/export、无 type="module"、无外部引用、可引导　｜　版本 v${appVersion}`,
    );
    console.log(banner);
    return 0;
  }
  console.log(`❌ 自检失败 ${failures.length} 条：`);
  for (const f of failures) console.log('   · ' + f);
  console.log(banner);
  return 1;
}

/**
 * 本文件是不是"被直接执行"（而不是被 `ui.test.ts` import）？
 *
 * ⚠ Windows 上路径**大小写不敏感**：`node web\BUILD.MJS` 完全合法，而
 *   `resolve()` 会把实参原样保留成 `…\BUILD.MJS` ⇒ 直接字符串比较会 **false**，
 *   于是"不打包、不报错、exit 0"（静默什么都不做，实测踩过）。
 *   `subst` / `junction` 这种"同一文件两个路径"的情况也比不出来，所以两边都过一遍
 *   `realpath`（拿不到就退回 `resolve`），再按平台决定要不要忽略大小写。
 */
function samePath(a, b) {
  if (a === b) return true;
  return process.platform === 'win32' && a.toLowerCase() === b.toLowerCase();
}

const isMain = (() => {
  try {
    const a = process.argv[1];
    if (!a) return false;
    const norm = (p) => {
      try {
        return realpathSync(p);
      } catch {
        return resolve(p);
      }
    };
    const self = fileURLToPath(import.meta.url);
    return samePath(norm(a), norm(self));
  } catch {
    return false;
  }
})();

if (isMain) {
  process.exitCode = main();
}
