/**
 * 纯格式化工具 —— 零依赖、不碰 DOM（所以界面层与逻辑层都能用）。
 *
 * ★ 0.19 抽出来：这两个函数原来放在 `ui/dom.ts`，而 `logic/writeGuard.ts`
 *   为了用它又自己抄了一份 `hex()`（同一个格式，两份实现 ⇒ 迟早悄悄分叉）。
 *   现在只有这一份：`dom.ts` 只管 DOM，格式化都在这儿。
 */

/** 把字节数写成人话。 */
export function humanBytes(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / 1024 / 1024).toFixed(2)} MiB`;
}

/** `0xDF` 这样的十六进制显示（`width` 左补零，例如 `hex(0x1f, 4)` → `0x001F`）。 */
export function hex(n: number, width = 2): string {
  return '0x' + n.toString(16).toUpperCase().padStart(width, '0');
}
