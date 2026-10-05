# PS2《装甲核心》徽章工具 · 网页版（单文件 HTML）

一个**零安装**的网页工具：把 128×128 的图变成 PS2《装甲核心》认的**徽章存档**，
并安全地写进记忆卡；也能反过来把卡上的徽章导出成 PNG。

> **怎么用（30 秒）**：下载 `emblem-tool.html`（或直接用 `web/dist/emblem-tool.html`）双击打开 →
> 选记忆卡（`.ps2`）→ 选图 → 取景 →〔写入选中槽〕。
>
> **怎么验证**：`node web\check.mjs`（要 Node 24+）⇒ 打包 + 四套 node 测试 + 三条 python 判据，最后一张总表。
> `python` 没装会自动跳过；本仓库不含的两样东西（真记忆卡镜像 / 上游二进制）对应的判据会**明确跳过并说明**。

### 这个仓库里有什么

| 目录 | 是什么 |
|---|---|
| `web/` | ★ 工具本体：`dist/emblem-tool.html`（**交付物**，双击即用）· `src/core/` 格式与图像核心 · `src/ui/` 界面 · `test/` 四套判据 · `check.mjs` 一键判据 · `SPEC.md` / `README.md` / `CHANGELOG.md` / `PORT-NOTES.md` |
| `docs/` | 项目理解：格式规范、图片管线、记忆卡与存档处理、限制与已知问题、来源与校验和 |
| `tools/` | 交叉验证判据层（python）：`acet_format.py`、`prepare_image.py`、`selftest.py` |
| `testdata/` | 测试样本：合成的 + **10 份真实徽章存档**（第三方来源见下） |
| `_selftest/` | 4 份自检报告 + 真实存档回归判据 + 归档 zip（0.19 清理掉的脚本） |

---

## 状态总表

| 能力 | 状态 |
|---|---|
| 读取（非 LR / LR，10 份真实样本 + 官方 exe 交叉验证 25/25） | ✅ |
| **非 LR 从零造写入**（SL + NX 共 7 槽） | ✅ **实机 7/7 通过** |
| **LR 从零造写入**（`data1`/`data2`） | ✅ 实机通过 |
| **往卡上新建一个槽位**（dirent / FAT / ECC / 目录项数） | ✅ 实机通过（`data2` 实验） |
| 往返保真（提取→注入→再提取逐像素一致） | ✅ |
| 未用调色板项填 `00 00 00 80`（可关） | ✅ 非必需（已证伪"必须填"） |
| 透明度的"游戏口径"`--alpha index0` | ✅ 实机定案 |
| 加一个**全新的存档目录**（`E##` 那一级，含 `icon.sys` + `.ICO`） | ⏳ 未测 |
| AC3 / AC2 / AC2AA / NX / NB 的 `E##` 真实样本 | ⏳ 只有 SL / NX / LR |
| 9 字节作品常量是否被游戏校验 | ⏳ `[待复测]`（照抄真实存档即可，不必赌） |
| PS1 徽章读写 | ⏸ 搁置（两个公开来源校验和矛盾，未定案） |

---

## 许可与来源

* ★ 本仓库按 **MIT** 发布，版权行 `Copyright (c) 2026 victoryplane`（见 `LICENSE`）。
* 它建立在对上游 [mparley/ac-emblem-tool](https://github.com/mparley/ac-emblem-tool)（**MIT**，
  `Copyright (c) 2021 Marcellus Parley`）的**阅读与双向验证**之上 —— "吃透上游 + 拿它的发行版当权威实现，
  与真实存档双向交叉验证"是这份实现的判据来源，见 `_selftest/01-交叉验证报告.md`。
  本仓库**不再分发**上游的源码与二进制，只保留引用与致谢。
* ★ `v0.0` / `v1.0.0` / `v1.0.1` / `v1.0.2` 的官方发行包里**没有 LICENSE**，只有 `v0.1` 带。
  要再分发那些 `acet.exe`，请连同上游的 LICENSE 一起给。
* `testdata/real/` 里的第三方真实存档来自 [`bucanero/apollo-saves`](https://github.com/bucanero/apollo-saves)，
  只作本地测试用；要再分发请回原仓库取。每个文件的 SHA256 见 `docs/03-来源与校验和.md`。
