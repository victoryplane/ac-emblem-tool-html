# testdata/ —— 测试样品

分两类，**别混**：

```
testdata/
├── (合成样品)  文件名带 synth_ 前缀，是本目录按格式编码出来的字节，**不是真实存档**
└── real/       ★ 一个**真实的玩家徽章存档**（第三方来源，见下）
```

---

## 一、真实存档 `real/`（★ 最有价值的那两份）

### ① 非 LR：Silent Line（来自公开存档库）

来源：GitHub 公开存档库 [`bucanero/apollo-saves`](https://github.com/bucanero/apollo-saves)
→ `PS2/SLUS20644/00000001.zip`，存档库标注为 **`BASLUS-20644E02: AC3SL Emblem No.3`**
（Silent Line: Armored Core，NTSC-U / SLUS-20644，玩家的第 3 个徽章存档）。

| 文件 | 大小 | 是什么 |
|---|---|---|
| `real/BASLUS-20644E02_AC3SL_Emblem3.PSV` | 56,216 | 原始 `.PSV` 容器（apollo 导出格式）。SHA256 `18DA0D78…CE62` |
| `real/BASLUS-20644E02_rawblock.raw` | 17,472 | 从容器里切出的**裸徽章块**（`0x4440`），可直接喂官方 exe |
| `real/BASLUS-20644E02_extracted.png` | 3,982 | 提取出的徽章 —— 一朵**正立的红玫瑰** |

### ② ★ Last Raven（来自**本工作区自己的 PCSX2 记忆卡**，只读取出）

来源：`C:\Users\M\Documents\PCSX2\memcards\Mcd001.ps2` → 根目录项 `BISLPS-25462EMB`
（`BISLPS-25462` = SLPS-25462 = **AC:LR 日版**）→ `data0` / `data1`。
用 `AC3_CN\tools\30-存档\61_mc_survey.py` 的 `Card` 类**只读**读取，
**未向记忆卡写入任何字节**。

| 文件 | 大小 | 是什么 |
|---|---|---|
| `real/BISLPS-25462EMB_data0.raw` | 17,440 | LR 徽章槽 0（`0x4420`，首 4 字节 `00 44 00 00`）—— **紫蓝色恶魔脸** |
| `real/BISLPS-25462EMB_data0.png` | — | ↑ 提取结果 |
| `real/BISLPS-25462EMB_data1.raw` | 17,440 | LR 徽章槽 1 —— **红色树**（就是游戏里"当前装备"那个） |
| `real/BISLPS-25462EMB_data1.png` | — | ↑ 提取结果 |

★ 这两份补上了此前**最大的空白**：LR 路径此前只有"官方 exe 也这么干"的证据。
实测：判定为 LR、**两份各 18/18 校验通过**、与官方 exe **逐像素 65,536 字节全同**。

★ 与游戏内画面对得上（用户 2026-10-04 截图）：记忆卡界面 10 格 =
`[记忆卡占位图标]` + `[8 个徽章槽 = data0..data7]` + `[当前装备的徽章]`；
`data0` 显在第二格（恶魔脸）、`data1` 在第三格（红树），其余 6 格是 `NEW DATA`。

★ 注意 `data0` 的 `palette[0] = 00 00 00 40`（alpha ≠ 0）⇒ **索引 0 不是透明色**
（详见 `../docs/01-项目理解/02-存档格式规范.md` §五）。

### ③ ★ 从同一张卡上又导出的 7 份（NX 5 + SL 2）

用户在 `Mcd001_embdata2.ps2` 里又存了别的作品的徽章，本目录**只读**批量导出：

| 文件 | 大小 | 内容 |
|---|---|---|
| `real/BISLPS-25338E00.raw` … `E04.raw`（**5 份**）+ 同名 `.png` | 17,472 | **AC Nexus（日版）**的徽章 —— **CREST 企业 logo（红黑）**。5 份**逐字节完全相同**（SHA256 都是 `becd88b1…`） |
| `real/BISLPS-25169E00.raw`、`E01.raw`（**2 份**）+ 同名 `.png` | 17,472 | **AC Silent Line（日版）**的徽章 —— **MIRAGE 企业 logo（蓝白）**。2 份**逐字节完全相同**（SHA256 都是 `34ae580c…`） |

★ 都用 `_selftest/dump_card_emblems.py` 只读取出，**7 份全部 18/18 校验通过**。

⇒ 这带来两条新结论：

1. **NX 与 SL 的 `E##` 徽章存档都是 `0x4440` / 非 LR 布局**（图像偏移 `0x24`、调色板乱序）
   —— 与上游说的"非 LR"一致，**首次在 NX 上验证**。
2. `E##` 存档目录的形状与 `S##` 一样：**数据文件 + `AC*E.ICO` + `icon.sys`** 三个文件。
   （SL 是 `AC3SLE.ICO`、NX 是 `ACNEXUSE.ICO`，都是 37,440 B。）

### 小结

这些样本合起来意味着：**格式理解在非 LR 与 LR 两种布局上都已被真实数据验证**，
而且**跨了三个作品**（Silent Line / Nexus / Last Raven）。
完整报告：`../_selftest/02-真实存档验证.md`。

⚠ **都是第三方的玩家存档**，只作本地测试用；要再分发请回到原始来源取。

**仍未覆盖**：AC3 自己的 `E##`（你卡上只有 `S00`）、以及 AC2 / AC2AA / NX / NB 的 `E##`。

---

## 二、合成样品（非真实存档）

| 文件 | 大小 | 是什么 |
|---|---|---|
| `sample_A_60colors.png` | 677 B | 128×128、56 色、左上角一块全透明的样品图（**合成存档的内容源**，由 `tools\make_testdata.py` 生成） |
| `sample_B_40colors.png` | 688 B | 128×128、41 色的样品图（备选内容源，同上） |
| `synth_ac3_BASLUS-20435E00.raw` | 17,472 (0x4440) | 非 LR 徽章存档，内容 = 图 A |
| `synth_lr_BASLUS-21338EMB_data0.raw` | 17,440 (0x4420) | Last Raven 徽章存档，内容 = 图 A |
| `synth_container_with_emblem.bin` | 17,984 | 0x200 字节前缀 + 非 LR 徽章块（测"靠魔数定位"那条路） |

文件名里的 `BASLUS-20435E00` / `BASLUS-21338EMB` 是**照真实命名规则起的名**（方便直接拖给官方 exe），
但内容全是合成的（图 A 按格式编码）。

`_work/` 是 `selftest.py` / `prepare_image.py` 的临时目录，**可随时删**。
★ 上面那两张 `sample_*.png` 只有 `tools\make_testdata.py` 会重新生成；
`tools\selftest.py` 每次跑出来的 A/B 图写在 `_work\sample_*.png`，**不会**覆盖仓库里这两张
（以前会覆盖 —— 于是每跑一次 `node web\check.mjs`，`git status` 里就多两个被改动的二进制文件）。

---

## 三、全部可重建（合成部分）

```powershell
python tools\make_testdata.py     # 重建合成样品
python tools\selftest.py          # 重建 _work\ 并跑与官方 exe 的交叉验证
```

`real/` 里的三个文件来自下载 + 一次切分，**不能重建**（除非重新下载）。

---

## 四、拿它们干什么

```powershell
# ★ 先用真实存档试 —— 这是最硬的验证（现在的入口是 TypeScript 核心层）
node web\test\core.test.ts          # 10 份 real/*.raw 全部读出来逐字节比对
node web\test\image.test.ts         # 图像管线（含 PNG 往返闭环）

# 官方 exe 也认这份（上游二进制不进仓库，路径按你本机的来）
dist\v1.0.2\acet.exe testdata\real\BASLUS-20644E02_rawblock.raw
# → 生成 .raw.png

# Python 参考实现（零依赖）—— 合成存档随便改，改坏了不心疼
python tools\acet_format.py                       # 核心自检
python tools\selftest.py                          # 与官方 exe 交叉验证（缺 exe 时 exit 2 = 跳过）
python _selftest\validate_writer.py               # 10 份真实存档逐字节复原
```

> ⚠ 上面原来写的是 `python tools\acet_cli.py …`：那个脚本 **0.19 已归档**（`tools\README.md` 有清单）。
> 现在"读一张 .raw 并给出信息"的入口是官方 exe 或 `web\test\core.test.ts`。

★ `synth_*.raw` 与 `real/*.raw` **都可以直接用官方工具读**，
所以它们也适合当"第三方实现正确性"的对照物：任何人写的解析器，
读 `synth_ac3_*.raw` 应得到 `sample_A_60colors.png`，读 `real/*.raw` 应得到那朵红玫瑰。
