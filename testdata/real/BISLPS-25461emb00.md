# BISLPS-25461emb00.raw —— Formula Front（PS2 日版）真实徽章存档

本文件是 `testdata/real/BISLPS-25461emb00.raw` 的来历与复算方法。`web/src/core/ff.ts` 的文件头指向这份说明。

## 来历

* 来源：`C:\Users\M\Documents\PCSX2\memcards\Mcd001_embdata2.ps2`（2026-10-20 00:12 的只读快照，
  SHA-256 `d70acc330b06b52503cf0a8d8d78612bc5cd403f09f4fe0373c809f424f08ab9`）。
* 根目录项 `BISLPS-25461emb00` 里的同名文件，**17624 字节**（`0x44D8`）。
* 用户在游戏里存出的**唯一一份** FF 徽章：红/白/黑的「FFA」三角 logo。
* 取出方式：`web/src/core/card.ts` 的 `Card`（只读）→ `readFile(cluster, length)`，与其它真实样本一样。
  **没有向记忆卡写入任何字节。**

## 文件本身

```
SHA-256  b98642a8be44ac03b05d33448514754d063ad0e87a9dee14eea71947d0780a43
大小     17624 = 0x44D8（17 × 0x400 + 0xD8）
MD5      1589cf6dbf95f150d20cc19468f899b6（= md5(前 0x44C8 字节)，存于 0x44C8..0x44D7）
```

## 怎么自己复算（三条都能在 Node 里一分钟跑完）

```js
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const b = readFileSync('testdata/real/BISLPS-25461emb00.raw');
b.length;                                                    // 17624
createHash('md5').update(b.subarray(0, 0x44c8)).digest('hex'); // 1589cf6d… 与 b.subarray(0x44c8) 全同
```

图像/调色板的解与写走 `web/src/core/ff.ts`：`ffExtractImage()` / `ffEncodeEmblem()`；
把解出来的 RGBA 再编码回去，结果与原文件**逐字节相同**（`web/test/core.test.ts` 的 (ff) 分节钉住）。

## 说明

* 样本是**用户自己的存档**，随仓库分发只为本地测试。
* 那 200 字节元数据（`0x4400..0x44C7`）的语义**没有定案** —— 只有 `+0x18` 的 `82 A0 00 00` 非零。
  所以工具写入时原样保留它，不猜。详见 `../../docs/01-项目理解/02-存档格式规范.md` §九。