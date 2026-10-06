/**
 * 界面语言（0.28）—— 中 / 英两套文案。
 *
 * ## 为什么**不建**"键 → 文案表"
 *
 * 键表的两个必然毛病：① 中文改了忘改英文、键漏了或拼错了，**没有任何东西会报错**；
 * ② 中文原文要在产物里存两遍（HTML 里一遍、词表里一遍）。
 * 所以这里用**原文就地配对**：
 *
 *   · **静态 HTML**：中文就是 DOM 原文，英文写在属性里 —— `<button data-en="Crop">取景</button>`。
 *     启动时把中文原文**快照**下来（`applyStaticI18n` 第一次跑时），切换时二选一写回。
 *     ⇒ 两种语言在同一行，改一个忘改另一个会被 `ui.test.ts` 分节 (p) 抓住。
 *   · **动态字符串**：中文留在它本来在的位置，英文紧挨着 —— `t('已写入 {n} 字节', 'Wrote {n} bytes', {n})`。
 *     ⇒ 可读、可 `grep`，而且"断言产物里有某句中文"那些既有闸门**一条都不用改**。
 *
 * ## 语言怎么定（用户 2026-10-06 定）
 *
 *   ① 用户在顶栏手动切过 ⇒ 用他选的（`localStorage`，键见 `LANG_STORAGE_KEY`）；
 *   ② 否则看 `navigator.language`：`zh*` ⇒ 中文；`en*` ⇒ English；**其它一律中文**（默认中文）。
 *   ⚠ 自动判定的结果**不写进 localStorage** —— 只有用户手动切才记，这样"换个浏览器语言"
 *     仍然会跟着走，而手动切过之后就永远听用户的。
 *
 * ## `file://` 上能不能记住
 *
 * 能（Chrome/Firefox 的 `file://` 页面有 `localStorage`）；万一某个环境不给，
 * 读写都包了 try/catch ⇒ **退化成"本次有效"**，不影响启动、不弹错。
 */

export type Lang = 'zh' | 'en';

/** 顶栏下拉里的两项（语言名**不翻译**：中文就叫中文，英文就叫 English）。 */
export const LANGS: ReadonlyArray<{ value: Lang; label: string }> = [
  { value: 'zh', label: '中文' },
  { value: 'en', label: 'English' },
];

/** 兜底语言（用户："默认中文"）。 */
export const DEFAULT_LANG: Lang = 'zh';

/** `localStorage` 的键（测试要断言它固定不变）。 */
export const LANG_STORAGE_KEY = 'ac-emblem-tool:lang';

let lang: Lang = DEFAULT_LANG;
const listeners: Array<() => void> = [];

/** 静态元素的**中文原文**快照：`data-en` 管 textContent，`data-en-*` 管属性。 */
const snapshot = new Map<Element, { text: string; attrs: Map<string, string> }>();

/** 属性的对应表：`data-en-title` → `title`，以此类推。 */
const ATTR_PAIRS: ReadonlyArray<[string, string]> = [
  ['data-en-title', 'title'],
  ['data-en-placeholder', 'placeholder'],
  ['data-en-aria-label', 'aria-label'],
];

export function currentLang(): Lang {
  return lang;
}

/** 当前是不是英文（便利函数，读起来比 `currentLang() === 'en'` 清楚）。 */
export function isEn(): boolean {
  return lang === 'en';
}

function readSavedLang(): Lang | null {
  try {
    const v = globalThis.localStorage?.getItem(LANG_STORAGE_KEY);
    return v === 'zh' || v === 'en' ? v : null;
  } catch {
    return null; // 没 localStorage（或被禁）⇒ 当作"没存过"
  }
}

function writeSavedLang(l: Lang): void {
  try {
    globalThis.localStorage?.setItem(LANG_STORAGE_KEY, l);
  } catch {
    /* 记不住就算了 —— 只是"下次打开还得重切一次"，不该打断用户 */
  }
}

/** 启动时定语言。规则见文件头（手动 > 浏览器 > 默认中文）。 */
export function detectLang(): Lang {
  return langFromSaved(readSavedLang()) ?? langFromNavigator(String(globalThis.navigator?.language ?? ''));
}

/**
 * `navigator.language` ⇒ 语言：`zh*` ⇒ 中文；`en*` ⇒ English；**其它（含空值）⇒ 中文**。
 *
 * ★ 拆成纯函数是为了能直接测（Node 里不好替换 `globalThis.navigator`）——
 *   `ui.test.ts` 分节 (p) 拿 `zh-CN` / `en-US` / `ja-JP` / `''` 四种输入钉住这条规则。
 */
export function langFromNavigator(navLang: string): Lang {
  if (/^zh\b/i.test(navLang)) return 'zh';
  if (/^en\b/i.test(navLang)) return 'en';
  return DEFAULT_LANG;
}

/** `localStorage` 里存过的值 ⇒ 语言；不是 `zh`/`en`（含 null / 垃圾值）⇒ `null` = 没存过。 */
export function langFromSaved(v: string | null | undefined): Lang | null {
  return v === 'zh' || v === 'en' ? v : null;
}

/**
 * 取当前语言的文案；`vars` 填 `{name}` 占位（没有 `vars` 时原样返回，不做任何替换）。
 *
 * ⚠ 两种语言**必须都给**，不许写 `t('中文')` —— `ui.test.ts` 分节 (p) 会检查每个
 *   `t(` 调用都有两个字符串参数（用掩码后的源码查，注释里的示例不算）。
 */
export function t(zh: string, en: string, vars?: Record<string, string | number>): string {
  const s = lang === 'en' ? en : zh;
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

/**
 * 把 `[data-en]` / `[data-en-title]` / `[data-en-placeholder]` / `[data-en-aria-label]`
 * 按当前语言写一遍。**第一次调用时先把中文原文拍下来**（所以顺序必须是"先快照、再写"）。
 */
export function applyStaticI18n(root: ParentNode = document): void {
  const snapOf = (el: Element): { text: string; attrs: Map<string, string> } => {
    let s = snapshot.get(el);
    if (!s) {
      s = { text: el.textContent ?? '', attrs: new Map() };
      snapshot.set(el, s);
    }
    return s;
  };

  for (const el of root.querySelectorAll('[data-en]')) {
    const s = snapOf(el);
    const en = el.getAttribute('data-en');
    el.textContent = lang === 'en' && en !== null ? en : s.text;
  }

  for (const [dataAttr, attr] of ATTR_PAIRS) {
    for (const el of root.querySelectorAll(`[${dataAttr}]`)) {
      const s = snapOf(el);
      if (!s.attrs.has(attr)) s.attrs.set(attr, el.getAttribute(attr) ?? '');
      const zhVal = s.attrs.get(attr) ?? '';
      const enVal = el.getAttribute(dataAttr);
      el.setAttribute(attr, lang === 'en' && enVal !== null ? enVal : zhVal);
    }
  }
}

/**
 * 切语言：写 `localStorage`（`persist: false` 时跳过 → 自动判定不写）、
 * 刷静态文案、同步 `<html lang>`、最后通知所有重画回调。
 *
 * 为什么把"通知"放在最后：回调里会读 `currentLang()`，必须已经是新值。
 */
export function setLang(next: Lang, opts: { persist?: boolean } = {}): void {
  const changed = next !== lang;
  lang = next;
  if (opts.persist !== false) writeSavedLang(next);
  // ⚠ `document` 在 Node（测试 / 构建冒烟以外的场景）里不存在 ⇒ 这一段必须能跳过，
  //   否则 `ui.test.ts` 里连 `setLang('en')` 都调不了。
  if (typeof document !== 'undefined') {
    const de = document.documentElement as (HTMLElement & { lang?: string }) | undefined;
    if (de) de.lang = next === 'zh' ? 'zh-CN' : 'en';
    applyStaticI18n();
  }
  if (changed) for (const fn of listeners) fn();
}

/** 注册"语言变了 ⇒ 重画一遍 JS 生成的那部分文字"。返回取消注册的函数。 */
export function onLangChange(fn: () => void): () => void {
  listeners.push(fn);
  return () => {
    const i = listeners.indexOf(fn);
    if (i >= 0) listeners.splice(i, 1);
  };
}
