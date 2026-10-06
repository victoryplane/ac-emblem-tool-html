# PS2《装甲核心》徽章工具 · 网页版（单文件 HTML）

把任意一张图变成 PS2《装甲核心》认的**徽章存档**并写进记忆卡；也能反过来把卡上的徽章导出成 PNG。
**零安装**：从 [Releases](https://github.com/victoryplane/ac-emblem-tool-html/releases/latest) 下载 `emblem-tool.html`
（或直接用仓库里的 `web/dist/emblem-tool.html`），双击打开就行。

> **English** — A zero-install, single-file web tool for PS2 *Armored Core* emblems: turn almost any image into an
> emblem the game accepts and write it into a memory card, or pull emblems off a card and export them as PNG.
> Grab `emblem-tool.html` from [Releases](https://github.com/victoryplane/ac-emblem-tool-html/releases/latest) and
> double-click it (Chrome/Edge). The interface is Chinese/English — switch it at the top right; English browsers get
> English automatically. **Back up your memory card first, and fully exit PCSX2 before writing.**
> Verified so far: reading (10 real samples), writing and creating slots (non-LR and LR, tested in-game), round-trip
> fidelity. Not verified yet: creating a new `E##` save folder, real samples for AC3 / AC2 / AC2AA / NB, and whether
> the game validates the 9-byte per-game constant.

> **已验证**：读取（10 份真实样本 + 与官方 exe 交叉验证）· 非 LR / LR 写入与新建槽（实机通过）· 往返保真。
> **还没验证**：`E##` 那一级**新建目录** · AC3 / AC2 / AC2AA / NB 的真实样本 · 9 字节作品常量是否被游戏校验 · PS1。
> ⇒ 所以打开页面时会先提醒你：**先自己备份记忆卡**，并且**改卡前完全退出 PCSX2**。

## 怎么用

1. 退出 PCSX2，并备份 `memcards\*.ps2`。
2. 双击 `emblem-tool.html` → 顶栏〔选择记忆卡（可覆盖保存）〕。
3. 把图拖进左上那一格（或点〔选择 / 粘贴图片〕、Ctrl+V）→ **拖动 / 滚轮取景** →〔确定取景〕。
4. 选作品 → 点要写的槽 →〔写入选中槽〕。工具会先回读比对 + 18 段校验 + ECC 自检，全过才落盘。

## 怎么验证

```powershell
node web\check.mjs        # Node 24+：打包 + 四套 node 测试 + 三条 python 判据，最后一张总表
```

仓库里没有的两样东西（真记忆卡镜像 `out/evidence/`、上游二进制 `dist/`）对应的判据会**明确跳过并说明**。

## 仓库里有什么

| 目录 | 是什么 |
|---|---|
| `web/` | ★ 工具本体：`dist/emblem-tool.html`（交付物）· `src/core/` 格式与图像核心 · `src/ui/` 界面 · `test/` 四套判据 · `check.mjs` 一键判据 · `SPEC.md` / `PORT-NOTES.md` |
| `docs/` | 逆向出来的项目理解：格式规范、图片管线、记忆卡与存档处理、限制与已解决的问题、来源与校验和 |
| `tools/` | python 交叉验证判据层（`acet_format.py` / `prepare_image.py` / `selftest.py`） |
| `testdata/` | 测试样本：合成的 + 10 份真实徽章存档 |
| `_selftest/` | 自检报告 + 真实存档回归判据 |

## 许可与来源

按 **MIT** 发布，版权行 `Copyright (c) 2026 victoryplane`（见 `LICENSE`）。
它建立在对上游 [mparley/ac-emblem-tool](https://github.com/mparley/ac-emblem-tool)（MIT，© 2021 Marcellus Parley）
的阅读与双向验证之上；本仓库**不再分发**上游的源码与二进制。
`testdata/real/` 的第三方真实存档来自 [bucanero/apollo-saves](https://github.com/bucanero/apollo-saves)，只作本地测试用。
