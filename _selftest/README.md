# _selftest/ —— 验证证据（4 份报告 + 回归判据 + 归档）

这个目录回答两个问题：**"你怎么知道你写的是对的？"** 和 **"这轮实机到底验了什么？"**

> 2026-10-04 清理过两轮：过程产物先收进 `_archive/`，准备做网页 UI 时又把 `_archive/`
> 与其余一次性实验脚本删掉 —— **代码打包在 `过程脚本存档_2026-10-04.zip`（25 个文件）里，没丢**。
> 2026-10-05（0.19）又清了一轮：**13 个已有 TS 等价物、且无人调用的脚本**打包进
> `_archive/清理_2026-10-05.zip`（45,140 字节）后删除 —— 见下面 §四。

```
_selftest/
├── 01-交叉验证报告.md              与官方 exe 的 25/25 交叉验证
├── 02-真实存档验证.md              10 份真实存档的验证
├── 03-写入实验_data2.md            往卡上新建槽位 + 实机验证
├── 04-末段校验差一字节.md          ★ 主报告：末段校验差一字节（破損ファイル 的真因）+ 实机回归
├── validate_writer.py             ★ 回归判据（改格式代码后必跑）：真实存档逐字节复原
├── _archive/
│   ├── 过程脚本存档_2026-10-04.zip           25 个一次性实验脚本与原始输出
│   └── 清理_2026-10-05.zip                  0.19 删掉的 13 个脚本（可随时取回）
└── README.md
```

## 一、报告

| 报告 | 结论一句话 |
|---|---|
| `01-交叉验证报告.md` | 本目录 Python 实现 vs 官方 `acet.exe`：三种载体双向读写**逐像素一致**，两个官方 exe 各 **25/25** |
| `02-真实存档验证.md` | 10 份**真实**徽章存档（SL 美 1 + SL 日 2 + NX 5 + LR 2）：校验 18/18、与官方 exe **65,536 字节全同** |
| `03-写入实验_data2.md` | **写入链路**打通：往卡上**新建一个槽位 `data2`**（dirent/FAT/ECC/项数），实机显示反色恶魔 ⇒ 顺带定案"游戏看的是**调色板索引 0**" |
| **`04-末段校验差一字节.md`** | ★ **主报告**：上游把末段校验字节写早了一字节 ⇒ 从空白块造存档被判 `破損ファイル`；修正后**实机 7/7 通过**；§十四记下"LR 认 slot 1 / PCSX2 每游戏记忆卡覆盖"那一整轮排查 |

> ⚠ 报告里引用的一些诊断脚本与过程卡**已经清理**（见两个 zip）。那些引用保留为历史记录，
> 结论不依赖它们能否重跑 —— 现在的重跑判据是下面这一条命令。

## 二、跑一遍（一条命令，全绿才算没坏）

```powershell
node ..\web\check.mjs
```

它 = 打包 + 产物自检（含 `node:vm` 引导冒烟与取景冒烟）+ 四套 node 测试
（`core` / `card` / `image` / `ui`）+ 下面三条 python 判据，最后打一张**判据总表**：

```powershell
python tools\acet_format.py            # 格式核心自检（0 项失败）
python tools\selftest.py               # 与官方 exe 交叉验证（25/25）
python _selftest\validate_writer.py    # 真实存档逐字节复原（10/10）
```

★ 全都不需要记忆卡、不改任何文件（`selftest.py` 只在 `testdata/_work/` 里造临时文件）。
⚠ **`testdata/_work/` 现在要手删**：原先负责清它的 `tidy_layout.py` 已在 0.19 被清掉
（见 §四），`tools\README.md` 与 `testdata\README.md` 都记着这个目录"可随时删"。

## 三、四张证据卡是**冻结输入**，不要再造

`out\evidence\Mcd001_{embdata2,final,LRtest2,TEST}.ps2` 是下面这些判据的**活输入**：

* `web\test\card.test.ts`（读写实验的对照卡）
* `web\test\make_card_fixtures.py` → `web\test\fixtures\card-manifest.json`
* `web\test\make_fixtures.py` → 33 个 `web\test\fixtures\blocks\*.raw` → `core.test.ts` 与打包冒烟

它们的生成脚本（`write_data2_inverted.py` / `write_final_test.py` / `write_lrtest2.py` /
`write_all_test.py`）已在 0.19 归档删除 ⇒ **这四张卡现在是冻结证据**：
判据照跑，但**别再重新生成它们**（要改就得从 `_archive\清理_2026-10-05.zip` 里取回脚本）。

## 四、0.19 归档了什么（`_archive\清理_2026-10-05.zip`）

| 归档的文件 | 原位置 | 为什么可以删 |
|---|---|---|
| `acet_cli.py` | `tools/` | Pillow 命令行，被网页版 + 上游官方 `acet.exe` 取代；全仓无人调用 |
| `check_pcsx2_slots.py` | `tools/` | 结论已**逐条移植**到 `web/src/ui/logic/pcsx2.ts`（网页面板用的就是它） |
| `tidy_layout.py` | `_selftest/` | 项目清理（⚠ 删了之后 `testdata/_work/` 要手删） |
| `check_links.py` | `_selftest/` | 文档死链自检（⚠ TS 侧没有等价物，这个能力随之消失） |
| `dump_dir_slots.py` | `_selftest/` | 除了自己没人引用（连本文件的历史清单里都没有） |
| `check_dirent_bits.py` | `_selftest/` | mode 位分析，结论已固化进 `web/src/core/card.ts` 的常量与注释 |
| `audit_slot_map.py` | `_selftest/` | 卡层能力已在 `core/card.ts` / `ui/cardOps.ts` |
| `scan_all_cards.py` | `_selftest/` | 同上（它生成的 `testdata/real/*` 仍在用，见下） |
| `dump_card_emblems.py` | `_selftest/` | 同上（`core/card.ts` 的注释把它当**规格出处**引用） |
| `write_data2_inverted.py` / `write_final_test.py` / `write_lrtest2.py` / `write_all_test.py` | `_selftest/` | 四张证据卡的生成器 ⇒ 归档后那四张卡冻结（见 §三） |

**必须留的**（交叉验证链，一个都不能再删）：`tools\acet_format.py`、`tools\prepare_image.py`、
`tools\selftest.py`、`web\test\make_*.py`、`_selftest\validate_writer.py` ——
"TS == Python 逐字节一致 / 同一口径色数"这些断言的**全部依据**都在它们身上。
