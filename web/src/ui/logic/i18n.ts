/**
 * 界面语言（0.28 起中/英；0.47 起中/日/韩/英四语）—— 四套文案**就地配对**。
 *
 * ## 为什么**仍然不建**"键 → 文案表"（0.47 又核对了一遍，结论没变）
 *
 * 键表的两个毛病：① 中文改了忘改其它语言、键漏了或拼错了，**没有任何东西会报错**；
 * ② 中文原文要在产物里存两遍（HTML 里一遍、词表里一遍）。
 * 0.46 讨论加日语/韩语时评估过"每种语言一个文件 + 键"的方案，最后**没采用**，理由是：
 *   · 键表唯一的真收益是"加一种语言 = 加一个文件"，而**四种语言就是终点**（受众：中日欧美韩），
 *     这笔收益不兑现，却要一直供着它那套设施（键集合一致 / 翻译过期检测 / 回退链，
 *     而回退链本身还会**掩盖"这条没翻"**）；
 *   · 就地配对保住了"**改了中文，日/韩就在同一行瞪着**"这条性质，也保住了源码可读性；
 *   · 那 87 处用模板 `${}` 拼接的文案（运行时**已经插值**才进 `t()`）在键表下**必须逐个改写**，
 *     就地配对则一处都不用动。
 * ⚠ 以后真到第 5 种语言时再迁键表也不迟：每行都已经有四份文案，抽出来就是四张表（脚本可做）。
 *
 * ## 三种承载形态
 *
 *   · **静态 HTML**：中文就是 DOM 原文，其余语言写在属性里 ——
 *     `<button data-en="Crop" data-ja="トリミング" data-ko="자르기">取景</button>`；
 *     属性类（`title` / `placeholder` / `aria-label`）走 `data-<lang>-<attr>`。
 *     启动时把中文原文**快照**下来（`applyStaticI18n` 第一次跑时），切换时按语言写回。
 *   · **动态字符串**：`t('中文', 'English', '日本語', '한국어', vars?)` —— 四份紧挨着。
 *   · **表数据**（作品表 / 缩放核）：`{ label, en, ja, ko, … }`，渲染时才 `t(...)`。
 *
 * ## 语言怎么定（用户 2026-10-06 定）
 *
 *   ① 用户在顶栏手动切过 ⇒ 用他选的（`localStorage`，键见 `LANG_STORAGE_KEY`）；
 *   ② 否则看 `navigator.language`：`zh*`/`en*`/`ja*`/`ko*` 各自命中，**其它一律中文**（默认中文）。
 *   ⚠ 自动判定的结果**不写进 localStorage** —— 只有用户手动切才记，这样"换个浏览器语言"
 *     仍然会跟着走，而手动切过之后就永远听用户的。
 *
 * ## `file://` 上能不能记住
 *
 * 能（Chrome/Firefox 的 `file://` 页面有 `localStorage`）；万一某个环境不给，
 * 读写都包了 try/catch ⇒ **退化成"本次有效"**，不影响启动、不弹错。
 */

export type Lang = 'zh' | 'en' | 'ja' | 'ko';

/** 顶栏下拉里的四项（语言名**不翻译**：各自用母语写）。 */
export const LANGS: ReadonlyArray<{ value: Lang; label: string }> = [
  { value: 'zh', label: '中文' },
  { value: 'en', label: 'English' },
  { value: 'ja', label: '日本語' },
  { value: 'ko', label: '한국어' },
];

/** 兜底语言（用户："默认中文"）。 */
export const DEFAULT_LANG: Lang = 'zh';

/** `localStorage` 的键（测试要断言它固定不变）。 */
export const LANG_STORAGE_KEY: string = 'ac-emblem-tool:lang';

/** `<html lang>` 的值 —— 字体选择 / 断行 / 无障碍都靠它（CSS 里 `:lang(ja)` 也认它）。 */
export const HTML_LANG: Readonly<Record<Lang, string>> = {
  zh: 'zh-CN',
  en: 'en',
  ja: 'ja',
  ko: 'ko',
};

/** 需要"属性承载"的语言（中文 = DOM 原文，没有属性）。顺序即产物里属性的书写顺序。 */
export const DATA_LANGS: readonly Lang[] = ['en', 'ja', 'ko'];

/** 用属性承载的 HTML 属性名（`data-en-title` → `title`，以此类推）。 */
export const ATTR_NAMES: readonly string[] = ['title', 'placeholder', 'aria-label'];

let lang: Lang = DEFAULT_LANG;
const listeners: Array<() => void> = [];

/** 静态元素的**中文原文**快照：`data-*` 管 textContent，`data-*-<attr>` 管属性。 */
const snapshot = new Map<Element, { text: string; attrs: Map<string, string> }>();

export function currentLang(): Lang {
  return lang;
}

export function isLang(v: unknown): v is Lang {
  return v === 'zh' || v === 'en' || v === 'ja' || v === 'ko';
}

function readSavedLang(): Lang | null {
  try {
    return langFromSaved(globalThis.localStorage?.getItem(LANG_STORAGE_KEY));
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
 * `navigator.language` ⇒ 语言：`zh*`/`en*`/`ja*`/`ko*` 各自命中，**其它（含空值）⇒ 中文**。
 *
 * ★ 拆成纯函数是为了能直接测（Node 里不好替换 `globalThis.navigator`）——
 *   `ui.test.ts` 分节 (p) 拿 `zh-CN` / `en-US` / `ja-JP` / `ko-KR` / `fr-FR` / `''` 钉住这条规则。
 */
export function langFromNavigator(navLang: string): Lang {
  if (/^zh\b/i.test(navLang)) return 'zh';
  if (/^en\b/i.test(navLang)) return 'en';
  if (/^ja\b/i.test(navLang)) return 'ja';
  if (/^ko\b/i.test(navLang)) return 'ko';
  return DEFAULT_LANG;
}

/** `localStorage` 里存过的值 ⇒ 语言；不是四种之一（含 null / 垃圾值）⇒ `null` = 没存过。 */
export function langFromSaved(v: string | null | undefined): Lang | null {
  return isLang(v) ? v : null;
}

/**
 * 取当前语言的文案；`vars` 填 `{name}` 占位（没有 `vars` 时原样返回，不做任何替换）。
 *
 * ⚠ **四种语言必须都给**，不许写 `t('中文', 'English')` —— `ui.test.ts` 分节 (p) 会检查每个
 *   `t(` 调用都有**四个**字符串参数（打在掩码后的源码上，注释里的示例不算）。
 */
export function t(
  zh: string,
  en: string,
  ja: string,
  ko: string,
  vars?: Record<string, string | number>,
): string {
  const s = lang === 'zh' ? zh : lang === 'en' ? en : lang === 'ja' ? ja : ko;
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

/** 某个元素在**指定语言**下的属性值；中文（或该属性不存在）⇒ `null`（= 用快照里的原文）。 */
function dataVal(el: Element, l: Lang, attr: string | null): string | null {
  if (l === 'zh') return null;
  return el.getAttribute(attr ? `data-${l}-${attr}` : `data-${l}`);
}

/**
 * 把静态元素按当前语言写一遍。**第一次调用时先把中文原文拍下来**（所以顺序必须是"先快照、再写"）。
 *
 * 覆盖范围：`[data-en]` / `[data-ja]` / `[data-ko]`（textContent）+ 三种属性的
 * `data-<lang>-title` / `-placeholder` / `-aria-label`。
 * ⚠ 元素可能只带其中两三种属性（例如某条只有英日），缺的那种按"中文原文"处理 ——
 *   但 `ui.test.ts` 分节 (p) 要求**可翻译元素三种语言都不缺**（缺了就是漏翻）。
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

  const textSel = DATA_LANGS.map((l) => `[data-${l}]`).join(',');
  for (const el of root.querySelectorAll(textSel)) {
    const s = snapOf(el);
    el.textContent = dataVal(el, lang, null) ?? s.text;
  }

  for (const attr of ATTR_NAMES) {
    const sel = DATA_LANGS.map((l) => `[data-${l}-${attr}]`).join(',');
    for (const el of root.querySelectorAll(sel)) {
      const s = snapOf(el);
      if (!s.attrs.has(attr)) s.attrs.set(attr, el.getAttribute(attr) ?? '');
      el.setAttribute(attr, dataVal(el, lang, attr) ?? s.attrs.get(attr) ?? '');
    }
  }
}

/**
 * 切语言：写 `localStorage`（`persist: false` 时跳过 → 自动判定不写）、
 * 刷静态文案、同步 `<html lang>`、最后通知所有重画回调。
 *
 * 为什么把"通知"放在最后：回调里会读 `currentLang()`，必须已经是新值。
 * ★ `<html lang>` 不只是无障碍：CSS 里 `:lang(ja)` / `:lang(ko)` 的**字体栈**也认它
 *   （中文默认字体 `Microsoft YaHei` 会把日文汉字画成中文字形）。
 */
export function setLang(next: Lang, opts: { persist?: boolean } = {}): void {
  const changed = next !== lang;
  lang = next;
  if (opts.persist !== false) writeSavedLang(next);
  // ⚠ `document` 在 Node（测试 / 构建冒烟以外的场景）里不存在 ⇒ 这一段必须能跳过，
  //   否则 `ui.test.ts` 里连 `setLang('en')` 都调不了。
  if (typeof document !== 'undefined') {
    const de = document.documentElement as (HTMLElement & { lang?: string }) | undefined;
    if (de) de.lang = HTML_LANG[next];
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
