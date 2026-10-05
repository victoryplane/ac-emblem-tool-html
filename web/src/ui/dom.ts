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
      } else if (k === 'html') {
        node.innerHTML = String(v);
      } else if (k.startsWith('on') && typeof v === 'function') {
        node.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      } else if (k === 'value') {
        (node as HTMLInputElement).value = String(v);
      } else if (k === 'checked' || k === 'disabled' || k === 'selected') {
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
  if (!n) throw new Error(`界面缺少必需的挂载点 #${id}（index.html 与 main.ts 不同步）`);
  return n as T;
}

// --------------------------------------------------------------------------
// 提示条（人话错误）
// --------------------------------------------------------------------------

export type ToastKind = 'info' | 'ok' | 'warn' | 'error';

let toastHost: HTMLElement | null = null;

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
  const close = el('button', { class: 'toast-x', title: '关闭', onclick: () => node.remove() }, '×');
  node.appendChild(close);
  host().appendChild(node);
  const life = ms ?? (kind === 'error' ? 60_000 : kind === 'warn' ? 20_000 : 6000);
  if (life > 0) setTimeout(() => node.remove(), life);
  node.scrollIntoView?.({ block: 'nearest' });
}

/** 顶层异常兜底：不让人看到"点了没反应"。 */
export function installGlobalErrorHandlers(): void {
  window.addEventListener('error', (ev) => {
    const e = (ev as ErrorEvent).error;
    toast('error', '界面里冒出一个未捕获的错误', e && e.stack ? String(e.stack).split('\n').slice(0, 4).join('\n') : String(ev.message));
  });
  window.addEventListener('unhandledrejection', (ev) => {
    const r = (ev as PromiseRejectionEvent).reason;
    toast('error', '有个异步操作失败了', r && r.stack ? String(r.stack).split('\n').slice(0, 4).join('\n') : String(r));
  });
}

// --------------------------------------------------------------------------
// ★ 0.26：必须点掉才能继续的弹窗
// --------------------------------------------------------------------------

let modalWired = false;

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
export function showModal(opts: { title: string; body: string; ok?: string }): void {
  const host = document.getElementById('modal-host');
  const title = document.getElementById('modal-title');
  const body = document.getElementById('modal-body');
  const ok = document.getElementById('modal-ok');
  if (title) title.textContent = opts.title;
  if (body) body.textContent = opts.body;
  if (ok) {
    ok.textContent = opts.ok ?? '知道了';
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


/** 把异步操作包起来：失败时给人话提示，并把错误继续抛给调用方决定怎么收场。 */
export async function guard<T>(what: string, fn: () => Promise<T> | T): Promise<T | undefined> {
  try {
    return await fn();
  } catch (e) {
    const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    toast('error', `${what}失败`, msg);
    console.error(`[徽章工具] ${what}失败`, e);
    return undefined;
  }
}
