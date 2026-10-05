# PS2《装甲核心》徽章工具 · 网页版（单文件 HTML）

一个**零安装**的网页工具：把 128×128 的图变成 PS2《装甲核心》认的**徽章存档**，
并安全地写进记忆卡；也能反过来把卡上的徽章导出成 PNG。

> **怎么用（30 秒）**：双击 `web/dist/emblem-tool.html` → 选记忆卡（`.ps2`）→ 选图 → 取景 →〔写入选中槽〕。
> 打开时会先弹一条告知：**本项目没经过完整实机验证，请先自己备份记忆卡**；
> 另一条硬规矩在写入确认框里：**写卡前先完全退出 PCSX2**。
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

### 这个仓库里**没有**什么（都在 `.gitignore` 里，本地才有）

* `out/` —— 4 张真记忆卡镜像（33 MB，机主私有存档）+ 预览图 ⇒ 依赖它们的卡层判据会**明确跳过**。
* `dist/` —— 上游官方发行的二进制（21 MB）⇒ `check.mjs` 里"与官方 exe 交叉验证"那一步会**明确跳过**，
  并给出补上的办法（把 `acet.exe` 放回 `dist/v1.0.2/`，或 `python tools\selftest.py --exe <路径>`）。
* `src/ac-emblem-tool/` —— 上游完整 git 仓库（本机是 clone）；它的本体在
  [mparley/ac-emblem-tool](https://github.com/mparley/ac-emblem-tool)。

### 许可与来源

* 本仓库的代码按 **MIT** 发布（`LICENSE`，`Copyright (c) 2026 victoryplane`）。
* 它建立在对上游 [mparley/ac-emblem-tool](https://github.com/mparley/ac-emblem-tool)（**MIT**，
  © 2021 Marcellus Parley）的**阅读与双向验证**之上 —— "吃透上游 + 用官方二进制与真实存档互验"
  是这份实现的判据来源，见 `_selftest/01-交叉验证报告.md`。
* `testdata/real/` 的第三方真实存档来自 [bucanero/apollo-saves](https://github.com/bucanero/apollo-saves)，
  只作本地测试用，出处与 SHA256 见 `docs/03-来源与校验和.md`。

---

## 下面这份是原来的工作区笔记（含本地目录结构，供对照）

本目录归档并**吃透**了 [mparley/ac-emblem-tool](https://github.com/mparley/ac-emblem-tool)
（`acet` / `ACET-GUI`，MIT）：把 PC 上的 128×128 PNG 塞进 PS2《装甲核心》
（AC2 / AC2AA / AC3 / Silent Line / Nexus / Nine Breaker / Last Raven）的**徽章存档**，也能反过来导出。

> **它是什么**：一份**可脚本化、且拿官方二进制与真实存档双向验证过**的参考实现。
> 上游只有 C++ 源码 + Windows 二进制，格式知识散在 200 行代码里、没有工具链就用不了。
> **它不是什么**：不是 GUI（GUI 你自己做）；**PS1 还没做**（规格差 4:1 面积 / 17:1 色数，见 `docs/01-项目理解/09-真实样本的调色板与索引结构.md`）。

---

## ★ 一页速用（0.19 起：**网页版是主入口**）

```powershell
# 0) 打开工具（单文件、双击即用、零安装）：web\dist\emblem-tool.html
#    选图 → 取景 → 写进记忆卡（顶栏还能开 PCSX2 自检面板确认"游戏实际读哪张卡"）

# 1) 想加工一张图但不写卡（仍可用 Python 那一份）
python tools\prepare_image.py 你的图.png -o ready.png
python tools\prepare_image.py 你的图.png --check-only        # 只检查，不改文件

# 2) 改完格式代码后跑判据（一条命令 = 打包 + 四套 node 测试 + 三条 python 判据）
node web\check.mjs
```

> ★ **0.19 删掉了两个命令行工具**：`tools\acet_cli.py`（看结构 / 提取 / 注入）与
> `tools\check_pcsx2_slots.py`（PCSX2 实际读哪张卡的自检）—— 前者被网页版 + 上游官方
> `dist\v1.0.2\acet.exe` 取代，后者的结论**逐条移植**进了网页版的 PCSX2 面板
> （`web/src/ui/logic/pcsx2.ts`）。两者都在 `_selftest/_archive/清理_2026-10-05.zip` 里，
> 需要时可取回。要"看结构 / 复验 18 段校验"，现在用网页版或
> `python tools\acet_format.py` 的自检输出。

**存档长什么样 / 该放到哪**（`<存档>` = 记忆卡上的一个文件，不是记忆卡镜像）：

| 作品 | 存档长什么样 | 每个存档里是什么 |
|---|---|---|
| AC2 / AC2AA / AC3 / SL / NX / NB | `<盘序列号>E<两位槽号>`（如 `BASLUS-20644E02`），`0x4440` 字节 | 整个文件就是**一枚**徽章 |
| **Last Raven** | `BISLPS-25462EMB\data0` … `data7`，`0x4420` 字节 | 每个 `dataX` 一枚（LR 共用一份 `icon.sys`/`static.ico`） |

★ **LR 必须喂裸 `dataX` 文件**，不要喂记忆卡镜像 —— 布局判定**只看文件大小**，
容器里的 LR 一定会被当成非 LR 解析（见 `docs/01-项目理解/04-记忆卡与存档处理.md` §二）。

★ 实机里怎么看：游戏的**徽章画面**显示的是"当前选中的那个记忆卡 slot 上的卡"，
标题会写 `MEMORY CARD slot 1` / `slot 2`（用户实测：换卡后**退出该画面再进**才会刷新）。

---

## ★★ 三个最容易踩的坑

1. **PCSX2 的记忆卡设置有两层，"每游戏设置"会盖掉全局设置**（2026-10-04 实测踩了一整轮）。
   对话框里写着 Slot 2 = 你的卡，日志里却是 `McdSlot 1 [File]: 另一张卡` —— 那就去
   `gamesettings\<序列号>_<CRC>.ini` 里找 `[MemoryCards]`。
   **进游戏验证前先在网页版最下面那块 PCSX2 自检面板确认一次**（原 `python tools\check_pcsx2_slots.py`
   的结论已逐条移植到 `web/src/ui/logic/pcsx2.ts`，脚本 0.19 已归档）。详见 `docs/01-项目理解/07-限制与已知问题.md` 问题 23。
2. **末段（第 18 段）校验字节的位置**：真实位置是 `0x4435` / LR `0x4415`；上游 `acet` 写在
   `0x4434` / `0x4414`，**差一个字节**。上游平时能用只因为总在已有存档上原地注入；
   从**空白块**造存档会被游戏判 `破損ファイル`。本实现按真实位置写。
   详见 `_selftest/04-末段校验差一字节.md`（★ 主报告）。
3. **`icon.sys@0xDF` 是槽位号，而它落在标题字段内部**（标题区第 31 字节）。
   改标题时若"先清零整段再写标题"，会顺手把槽号抹成 0 ⇒ **NX 五个槽号全 0 会直接卡死**。
   正确顺序：写长度 → 清零并写标题 → **最后**写 `0xDF`。

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

## 最硬的四条证据

1. **与官方二进制交叉验证**：本实现与官方 `acet.exe` 在三种载体上双向读写**逐像素一致**，
   两个官方 exe 各 **25/25** 项断言全过 → `_selftest/01-交叉验证报告.md`
2. **与真实游戏数据验证**：10 份真实徽章存档（SL 美版 1 + SL 日版 2 + NX 5 + LR 2），校验 18/18，
   与官方 exe **65,536 字节全同** → `_selftest/02-真实存档验证.md`，样本 `testdata/real/`
3. **写入链路**：往卡上新建槽位 `data2`（分配 18 簇 + FAT + ECC + dirent + 目录项数），
   实机显示反色恶魔 ⇒ 顺便定案 **"游戏看的是调色板索引 0，不是 alpha 字节"** → `_selftest/03-写入实验_data2.md`
4. **实机回归**：非 LR 从零造 7/7 通过、LR 从零造通过 → `_selftest/04-末段校验差一字节.md` §十四

---

## 目录结构

> ⚠ 这一节描述的是**本地工作区**（`emblem-tool/`）的完整样子 —— 其中 `src/`、`dist/`、`out/`
> 三项目前**不进仓库**（见文件开头"这个仓库里没有什么"），仓库里只有 `docs/`、`tools/`、
> `testdata/`、`web/`、`_selftest/` 与根 `README.md` / `LICENSE` / `.gitignore`。

```
emblem-tool/
├── README.md                 ← 你在这里（一页速用 + 状态表）
├── LICENSE                   MIT（本仓库）
├── .gitignore                排除 out/ dist/ src/ac-emblem-tool/（本地才有）
├── docs/
│   ├── 01-项目理解/
│   │   ├── 01-项目总览.md             是什么、作者、五个发行版、版本号里的坑
│   │   ├── 02-存档格式规范.md         ★ 二进制格式规范（可直接照着写解析器）
│   │   ├── 03-图片处理管线.md          ★ 图片这一块的全部规则
│   │   ├── 04-记忆卡与存档处理.md       ★ 记忆卡/存档这一块（含 PS1 与"上游不做什么"）
│   │   ├── 05-源码导读.md             逐文件导读（GUI 部分只留必要的差异说明）
│   │   ├── 06-版本与分支.md           5 个发行版 / 3 个分支 / 二进制 PE 分析
│   │   ├── 07-限制与已知问题.md        ★ 能踩的坑（分级）+ 使用前检查表
│   │   ├── 08-上游GUI功能清单.md       上游 GUI 有哪些功能（你要做 GUI 时的对照）
│   │   └── 09-真实样本的调色板与索引结构.md ★ 调色板/索引的实测规律 + PS1⇄PS2 差异
│   ├── 02-参考资料/{01-生态调研,02-与本工作区的关联}.md
│   └── 03-来源与校验和.md             每个文件的 SHA256 与下载出处
├── src/ac-emblem-tool/      上游完整 git 仓库（20 提交 / 3 分支 / 5 tag，**未改一个字节**）
├── dist/                    官方发行二进制（5 个版本，原包 + 解包）
├── tools/                   ★ 自建：**交叉验证判据层**（格式核心 + 图像加工 + 与官方 exe 的 selftest；`tools/README.md`）
├── testdata/                测试样品（合成 + **10 份真实存档**，`testdata/README.md`）
├── web/                     ★ 网页端（**单文件 HTML、双击离线、主入口**）：`web/dist/emblem-tool.html` 交付物 ·
│                            `web/SPEC.md` 规格 · `web/CHANGELOG.md` 逐版本变更史 · `web/check.mjs` 一键判据 ·
│                            `web/src/core/` 核心 · `web/src/ui/` 界面 · `web/probe.html` 环境体检
├── out/                     产物：`evidence/`（4 张有实机结论的卡）+ `preview/`（40 张图）
└── _selftest/               ★ 4 份报告 + 回归判据 + 两个归档 zip（`_selftest/README.md`）
```

## 要自己做 GUI 时

* **图像**：抄 `tools/prepare_image.py` 的流程（要点：一律缩放；**缩放后重新二值化 alpha**；
  只对**不透明**像素减色；独立断言 ≤255 色）。
* **格式**：`tools/acet_format.py` 是**零依赖**纯逻辑，端口到任何语言都容易；
  里面的 `verify_checksums()` 是**独立判据**，建议保留。
* **记忆卡/槽位**：网页版最下面那块 PCSX2 自检面板（`web/src/ui/logic/pcsx2.ts`）就是"实机前排除环境问题"的自检；
  记忆卡读写层可复用本工作区已有的 `AC3_CN\tools\30-存档\`（页 512+16 / ECC / FAT / 簇链），
  只接上本目录的徽章编解码，别重写。见 `docs/02-参考资料/02-与本工作区的关联.md` §五。

---

## 溯源与许可

* ★ 本仓库按 **MIT** 发布，版权行 `Copyright (c) 2026 victoryplane`（见 `LICENSE`）。
* 上游：`mparley/ac-emblem-tool`，**MIT**，`Copyright (c) 2021 Marcellus Parley`。
  本仓库**不再分发**上游的源码与二进制（`src/`、`dist/` 已排除），只保留引用与致谢；
  当年做过的事是"**没有改动上游一个字节**，并拿它的发行版当权威实现做双向交叉验证"。
* ★ `v0.0` / `v1.0.0` / `v1.0.1` / `v1.0.2` 的官方发行包里**没有 LICENSE**，只有 `v0.1` 带。
  要再分发那些 `acet.exe`，请连同上游的 LICENSE 一起给。
* `testdata/real/` 里的第三方真实存档来自 [`bucanero/apollo-saves`](https://github.com/bucanero/apollo-saves)，
  只作本地测试用；要再分发请回原仓库取。每个文件的 SHA256 见 `docs/03-来源与校验和.md`。
