/**
 * 应用版本号 —— **唯一**权威来源。
 *
 * ## 规则（用户 2026-10-05 定）
 *
 *   · 从 **0.1** 起，**每次交付 +0.1**（0.1 → 0.2 → 0.3 …）。
 *   · **只有用户明确说"可以发布了"，才允许进 1.x 正式版。**
 *   · 任何地方要显示版本号都必须 `import { APP_VERSION } from './logic/version.ts'`，
 *     **不许**在 HTML / CSS / 打包器里再写一份字面量。
 *     `build.mjs::readAppVersion()` 也是读这个文件（不是自己写死一份）；
 *     `ui.test.ts` 会断言产物里的版本号与它一致。
 *
 * ## 与 `M4-UI-N` 的区别（两个都保留，别混）
 *
 *   · `APP_VERSION` = 给**用户**看的交付版本（0.25、0.26 …）。
 *   · `UI_BUILD_TAG` = 给**我们**看的开发标记（`M4-UI-28`），用来一眼确认
 *     "用户打开的不是缓存页"；它随每次**界面改动**递增，与 `APP_VERSION` 无关。
 *     两者一起出现在 F12 的 `EmblemToolCore.ui` 上（`version` / `buildTag`）。
 *
 * ## ★ 0.19：逐版本变更历史搬到了 `web/CHANGELOG.md`
 *
 * 原先这个文件里带着 **140 行注释**的 0.1→0.18 变更史，而**打包器不删注释**
 * ⇒ 每个用户下载的 460 KiB 单文件里都白背了 ~15 KB 的历史（还每次交付要在
 * 4 份文档里同步同一件事：本文件 / `README.md` / `SPEC.md` / `PORT-NOTES.md`）。
 * 现在这里只留"规则 + 当前版本号"，历史看 `CHANGELOG.md`（**不进产物**）。
 */

/** 交付版本号（用户可见）。规则见文件头。 */
export const APP_VERSION = '0.26';

/** 界面开发标记（只有我们看；每次界面改动 +1）。 */
export const UI_BUILD_TAG = 'M4-UI-28';

/** `v0.26` 这种带 `v` 前缀的显示形式（界面上统一用它）。 */
export const APP_VERSION_LABEL = `v${APP_VERSION}`;
