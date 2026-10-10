/**
 * 极简 DOM 助手 —— 原生 DOM，零框架（SPEC.md §二：界面建议无框架原生 TS + DOM）。
 *
 * 只有四件事：造元素、清空、找挂载点、显示人话错误。
 * 刻意**不做**虚拟 DOM / 响应式：这个工具的全部状态都是命令式的
 * （一张卡、一张图、8 个槽），重画一次 8 个槽比 diff 便宜得多。
 *
 * ★ 0.19：`humanBytes()` / `hex()` 搬到了 `logic/format.ts` ——
 *   它们是**纯格式化**（与 DOM 无关），而 `logic/writeGuard.ts` 当初为了用 `hex()`
 *   自己抄了一份 ⇒ 同一个格式两份实现。现在只有那一份，本文件只管 DOM。
 */

import { t } from './logic/i18n.ts';

/**
 * `el()` 的属性表。
 * ★ 0.41（审查抓到）：删掉了从来没人用的 `html:`（`innerHTML`）与 `checked` 两个分支 ——
 *   `html:` 尤其危险：本项目是**零注入**口径（所有文字走 `textContent` / `createTextNode`），
 *   留着一个"能塞 HTML"的后门迟早会被人用上。`checked` 全项目（含冒烟）没有使用点。
 *   ⚠ 要加回来请先想清楚：`html:` 等于放弃"不注入"这条纪律。
 */
export type Attrs = Record<string, string | number | boolean | null | undefined | EventListener>;

/** `el('div', { class: 'x', onclick: fn }, '文字', child1, child2)` */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Attrs | null,
  ...children: Array<Node | string | null | undefined>
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class' || k === 'className') {
        node.className = String(v);
      } else if (k === 'text') {
        node.textContent = String(v);
      } else if (k.startsWith('on') && typeof v === 'function') {
        node.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      } else if (k === 'value') {
        (node as HTMLInputElement).value = String(v);
      } else if (k === 'disabled' || k === 'selected') {
        (node as unknown as Record<string, boolean>)[k] = v === true || v === 'true';
      } else {
        node.setAttribute(k, String(v));
      }
    }
  }
  for (const c of children) {
    if (c === null || c === undefined) continue;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

export function clear(node: Element): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const n = document.getElementById(id);
  if (!n) throw new Error(t(`界面缺少必需的挂载点 #${id}（index.html 与 main.ts 不同步）`, `Missing required mount point #${id} (index.html and main.ts are out of sync)`, `UI に必須のマウントポイント #${id} がありません（index.html と main.ts が同期していません）`, `UI에 필수 마운트 지점 #${id}이(가) 없습니다 (index.html과 main.ts가 동기화되지 않음)`));
  return n as T;
}

// --------------------------------------------------------------------------
// 提示条（人话错误）
// --------------------------------------------------------------------------

export type ToastKind = 'info' | 'ok' | 'warn' | 'error';

let toastHost: HTMLElement | null = null;
/**
 * ★ 0.40：屏上还没消失的提示条。
 *
 * 它们是 JS 用 `t()` 拼出来的字符串（`toast('ok', t(…), …)`），切语言时**没法重说**
 * （`toast()` 的入参就是渲染好的文字，30 多个调用点不值得全改成渲染函数）。
 * 所以规则定成：**切语言就把屏上还没消失的提示条收掉** —— 宁可收掉，也不要留一句旧语言的话
 * （同样的信息在状态行 / 写入日志里都有；状态行是会按新语言重说的）。
 */
const liveToasts = new Set<HTMLElement>();

/** ★ 0.40：收掉所有还挂着的提示条（切语言时由 `relayoutForLang()` 调）。 */
export function dismissToasts(): void {
  for (const node of liveToasts) node.remove();
  liveToasts.clear();
}

function host(): HTMLElement {
  if (!toastHost) {
    toastHost = document.getElementById('toasts');
    if (!toastHost) {
      toastHost = document.createElement('div');
      toastHost.id = 'toasts';
      document.body.appendChild(toastHost);
    }
  }
  return toastHost;
}

/**
 * 显示一条提示。**所有失败路径都必须调用它** —— SPEC.md/任务书要求
 * "所有按钮失败时给人话错误，不要静默"。
 */
export function toast(kind: ToastKind, title: string, detail?: string, ms?: number): void {
  const node = el(
    'div',
    { class: `toast toast-${kind}` },
    el('div', { class: 'toast-title', text: title }),
    detail ? el('div', { class: 'toast-body', text: detail }) : null,
  );
  const close = el(
    'button',
    {
      class: 'toast-x',
      title: t('关闭', 'Close', '閉じる', '닫기'),
      onclick: () => {
        liveToasts.delete(node);
        node.remove();
      },
    },
    '×',
  );
  node.appendChild(close);
  host().appendChild(node);
  liveToasts.add(node); // ★ 0.40：切语言时要把还没消失的收掉（见 `liveToasts`）
  const life = ms ?? (kind === 'error' ? 60_000 : kind === 'warn' ? 20_000 : 6000);
  if (life > 0) {
    setTimeout(() => {
      liveToasts.delete(node);
      node.remove();
    }, life);
  }
  node.scrollIntoView?.({ block: 'nearest' });
}

/** 顶层异常兜底：不让人看到"点了没反应"。 */
export function installGlobalErrorHandlers(): void {
  window.addEventListener('error', (ev) => {
    const e = (ev as ErrorEvent).error;
    toast(
      'error',
      t('界面里冒出一个未捕获的错误', 'An uncaught error surfaced in the UI', 'UI で捕捉されないエラーが発生しました', 'UI에서 처리되지 않은 오류가 발생했습니다'),
      e && e.stack ? String(e.stack).split('\n').slice(0, 4).join('\n') : String(ev.message),
    );
  });
  window.addEventListener('unhandledrejection', (ev) => {
    const r = (ev as PromiseRejectionEvent).reason;
    toast(
      'error',
      t('有个异步操作失败了', 'An async operation failed', '非同期処理に失敗しました', '비동기 작업이 실패했습니다'),
      r && r.stack ? String(r.stack).split('\n').slice(0, 4).join('\n') : String(r),
    );
  });
}

// --------------------------------------------------------------------------
// ★ 0.26：必须点掉才能继续的弹窗
// --------------------------------------------------------------------------

let modalWired = false;
/**
 * ★ 0.40：记住弹窗的**渲染方式**（不是渲染好的字符串）—— 切语言时要用它重放一遍。
 *
 * ⚠ 第一稿存的是 `{title, body}` 字符串，结果重放出来的**还是旧语言**：调用方
 *   `showModal({ title: t('中文','English'), … })` 是在 `t()` **调用那一刻**就把语言定死了，
 *   存下来的字符串只有一种语言。所以入口改成收一个**函数**（`() => ({...})`），
 *   重放时重新 `t()` 一遍才是新语言。
 *
 * 为什么必须重放：`#modal-ok` 是带 `data-en` 的静态元素（`applyStaticI18n()` 会按语言刷它），
 * 而标题 / 正文是 JS 写的（不带 `data-en`）⇒ 不重放就会出现"按钮变英文、正文还是中文"的混搭。
 * 弹窗开着时鼠标点不到语言下拉，但 **Tab 能走到**（没有 focus trap）、F12 也随时能切。
 */
let lastModalRender: (() => ModalContent) | null = null;

/**
 * 弹一个**必须点掉**的对话框（盖住整页，点掉之前下面的东西点不到）。
 *
 * 用它的两处（都是"继续做下去会出事"的场合）：
 *   1. **打开页面时**：本项目没经过完整实机验证，请自行备份记忆卡（`main.ts::boot()`）；
 *   2. **写入前**：人还在取景模式，取景没〔确定〕就用的是上一次的取景（`main.ts::doWrite()`）。
 *
 * 为什么不直接用 `window.alert()`：
 *   · 样式不可控（暗色界面里蹦一个系统白框）；
 *   · 连续弹会被浏览器"阻止此页面创建更多对话框"静默吞掉 —— 那就等于没提醒；
 *   · 无头截图 / 探针里抓不到它，没法当判据。
 *
 * ⚠ 结构在 `index.html` 里（`#modal-host` 等），这里只填字与开关 —— 这样
 *   "代码里引用的每个 id 都要在 index.html 里"那条闸门也管得到它。
 * ⚠ 靠 `hidden` 属性切换（`styles.css` 有 `[hidden] { display: none !important }`），
 *   不写 inline `display`（那会被后面的 class 规则盖掉，0.9 踩过）。
 */
/** 弹窗内容（由调用方给的渲染函数产出，见 `lastModalRender`）。 */
export interface ModalContent {
  title: string;
  body: string;
  ok?: string;
}

/** 把弹窗内容写进 DOM（`showModal()` 与切语言时的重放共用一份）。 */
function fillModal(opts: ModalContent): HTMLElement | null {
  const title = document.getElementById('modal-title');
  const body = document.getElementById('modal-body');
  const ok = document.getElementById('modal-ok');
  if (title) title.textContent = opts.title;
  if (body) body.textContent = opts.body;
  if (ok) ok.textContent = opts.ok ?? t('知道了', 'Got it', '了解', '확인');
  return ok;
}

/**
 * 弹一个必须点掉的对话框。
 *
 * ★ 0.40：入参从"内容对象"改成**渲染函数** —— `showModal(() => ({ title: t(…), body: t(…) }))`。
 *   这样切语言时能原样重放一遍（`relayoutModalForLang()`），不会出现"按钮英文、正文中文"。
 *   ⚠ 直接把 `t()` 的结果传进来是不行的：那串文字在调用那一刻就定死语言了。
 */
export function showModal(render: () => ModalContent): void {
  const host = document.getElementById('modal-host');
  const ok = fillModal(render());
  lastModalRender = render;
  if (ok) {
    if (!modalWired) {
      ok.addEventListener('click', () => {
        const h = document.getElementById('modal-host');
        if (h) h.hidden = true;
      });
      modalWired = true;
    }
    // ⚠ 桩 DOM（`build.mjs::smokeBoot`）里的元素不一定有 focus()；有才调
    if (typeof (ok as HTMLElement).focus === 'function') (ok as HTMLElement).focus();
  }
  if (host) host.hidden = false;
}

/**
 * ★ 0.40：切语言时把**还开着的**弹窗重放一遍（标题 / 正文 / 按钮用同一套新语言）。
 * 没开着就什么都不做；也别在这里动 `hidden` 或焦点（那是 `showModal()` 的事）。
 */
export function relayoutModalForLang(): void {
  if (!lastModalRender) return;
  const host = document.getElementById('modal-host');
  if (!host || host.hidden) return;
  fillModal(lastModalRender());
}


/** 把异步操作包起来：失败时给人话提示，并把错误继续抛给调用方决定怎么收场。 */
export async function guard<T>(what: string, fn: () => Promise<T> | T): Promise<T | undefined> {
  try {
    return await fn();
  } catch (e) {
    const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    // ⚠ `what` 由调用方给：那边已经过 `t()`（见 `main.ts` 的 `guard(t('选择记忆卡', 'Choose memory card'), …)`）
    toast('error', t(`${what}失败`, `${what} failed`, `${what}に失敗`, `${what} 실패`), msg);
    console.error(`[emblem tool] ${what} failed`, e);
    return undefined;
  }
}
