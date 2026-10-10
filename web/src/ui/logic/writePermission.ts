/**
 * 写权限（File System Access API）—— **必须在用户手势那一刻问**。
 *
 * ## 这个文件为什么存在（用户实测抓到的真 bug）
 *
 * 用户点〔写入选中槽〕之后看到：
 * ```
 * ✅ BISLPS-25462EMB\data3（槽 4，覆盖）：… 18 段校验 18/18 · 改动页 ECC 全对 · 图像合规…
 * ❌ 覆盖保存失败：SecurityError: Failed to execute 'requestPermission' on 'FileSystemHandle':
 *    （浏览器说：要用户手势才能请求权限）
 * ```
 * 内存写与回读自检**全过了**，最后倒在一句英文的 `SecurityError` 上。原因：
 * 请求写权限（`FileSystemHandle.requestPermission`）属于"**需要 transient activation**"的 API ——
 * 只有**用户手势起 ~5 秒内**（且中间没被 `confirm()` 之类的模态框吃掉）才允许调。
 * 而旧代码是在**写完整条管线 + 弹完落盘确认框之后**才去请求权限 ⇒ 手势早过期 ⇒ 抛异常，
 * 界面只能报"覆盖保存失败"。
 *
 * ## 现在的规矩
 *
 *   · ⚠ **只在点击那一刻问**（`main.ts::requestWritePermissionIfNeeded()`，在 `doWrite` /
 *     〔删除槽〕的**开头**、`confirm()` 之前）⇒ 结果记在 `state.card.writePerm` 上；
 *   · 落盘那一步（`cardOps.ts::persistCardChange()`）**只读结果**，**绝不再调**
 *     请求权限；拿不到就**优雅退化**成"下载一份改好的卡"（这是产品一直承诺的兜底）；
 *   · `queryPermission()` 不需要手势，任何时候都能调（用它做"没提前问过"时的兜底判断）。
 *
 * 另外：`async` 里 `await` 一次就会消耗掉一点时间预算 —— 所以调用点要**放在最前面**，
 * 别夹在别的 `await` 后面（这也是 `ui.test.ts` 分节 (r) 对 `showOpenFilePicker` 那条规矩的同一条道理）。
 */

/** 只看需要的两个方法（Node 测试里用假对象即可，不必真造一个 `FileSystemFileHandle`）。 */
export interface PermHandleLike {
  queryPermission?(desc: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
  requestPermission?(desc: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
}

/** 拿不到写权限的原因（每一种都对应一句不同的人话）。 */
export type WritePermReason =
  /** 拿到了（或这个环境没有权限 API，交给 `createWritable()` 去决定）。 */
  | 'granted'
  /** 查过，没给，而且这次**不许问**（落盘那一步的兜底路径）。 */
  | 'read-only'
  /** 问了，用户/浏览器没同意（`denied`）。 */
  | 'prompt-denied'
  /** 问的时候抛了 —— 十有八九是"没有用户手势"（浏览器抛的 SecurityError）。 */
  | 'needs-gesture';

export interface WritePermResult {
  ok: boolean;
  reason: WritePermReason;
  /** 出错时的原始名字（`SecurityError` / `InvalidStateError` …），只用于给开发看的提示。 */
  detail?: string;
}

/**
 * 查（必要时问）写权限。
 *
 * @param allowRequest `false` = **只查不问**（落盘那一步用 —— 那时候问必抛 `SecurityError`）。
 */
export async function ensureWritePermission(
  handle: PermHandleLike,
  opts: { allowRequest?: boolean } = {},
): Promise<WritePermResult> {
  const allowRequest = opts.allowRequest !== false;
  try {
    if (typeof handle.queryPermission !== 'function') {
      // 没有权限 API（老浏览器 / 桩环境）⇒ 当作"能写"，让 `createWritable()` 去报它自己的错
      return { ok: true, reason: 'granted' };
    }
    const q = await handle.queryPermission({ mode: 'readwrite' });
    if (q === 'granted') return { ok: true, reason: 'granted' };
    if (!allowRequest || typeof handle.requestPermission !== 'function') return { ok: false, reason: 'read-only' };
    const r = await handle.requestPermission({ mode: 'readwrite' });
    return r === 'granted' ? { ok: true, reason: 'granted' } : { ok: false, reason: 'prompt-denied' };
  } catch (e) {
    return { ok: false, reason: 'needs-gesture', detail: e instanceof Error ? e.name : String(e) };
  }
}

/**
 * 给界面用的一句人话（中/英由调用方 `t()` 决定，这里只给出"哪种原因"）。
 *
 * ★ 0.45：联合类型里**没有** `'ok'` —— 唯一调用点（`main.ts::requestWritePermissionIfNeeded()`）
 *   在调它之前已经 `if (r.ok) return`（而且上面还有一道 `lc.writePerm?.ok` 早退）⇒
 *   "拿到了权限"这一档在这里是**不可达**的，留着只会让调用方以为要处理它。
 */
export function writePermHintKey(r: WritePermResult): 'gesture' | 'denied' | 'readonly' {
  if (r.reason === 'needs-gesture') return 'gesture';
  if (r.reason === 'prompt-denied') return 'denied';
  return 'readonly';
}
