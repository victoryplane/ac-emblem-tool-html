# tools/ —— 本方自建工具

> ★ **这里的东西是本目录新写的，不是上游的。** 上游源码在 `../src/ac-emblem-tool/`。
> 上游一个字节都没改。
> ★ **0.19 起这里是"交叉验证的判据层"**：网页版（`../web/`）已经是日常使用的入口，
> `tools/` 留下来的作用是**独立判据**（Python 实现与 TS 实现互相证伪），
> 以及 `selftest.py` 那条**唯一与上游官方二进制挂钩**的链路。
> 0.19 删掉的 13 个脚本（`acet_cli.py` / `check_pcsx2_slots.py` / `_selftest` 下 11 个）
> 已打包在 `../_selftest/_archive/清理_2026-10-05.zip`，需要时可取回。

## 为什么要有这一套

上游只有 C++ 源码 + Windows 二进制，好处是权威，坏处是：

* **没有 C++ 工具链就跑不了**（本机确实没装 cmake / cl / g++）；
* **格式知识散在 200 行 C++ 里**，想查"校验怎么算的"得读代码；
* **想批量处理 / 脚本化**很难（错误路径会 `cin.get()` 卡住，见限制问题 4）；
* **没有独立的校验判据** —— 上游"自己写自己验"，读错写错会互相抵消。

所以这里放了一份**独立重写**的 Python 实现。它的价值不只是"能用 Python 跑"，
更在于**它是上游的证伪器**，而且现在也是**网页版 TS 实现的证伪器**：
两份独立实现互相印证，比单实现自己往返可靠得多。

事实上它第一次跑就抓出了本目录最初把"首段校验种子"和"末段校验偏移"写错的两处问题
（详见 `../_selftest/01-交叉验证报告.md` §一）。

---

## 文件清单（0.19 现状）

| 文件 | 依赖 | 作用 |
|---|---|---|
| `acet_format.py` | **零依赖**（只要标准库） | ★ 格式核心：常量、`offset_index`、`unscramble_palette`、`find_offset`、`extract_image`、`inject_image`、`apply_checksums`、**`verify_checksums`（独立判据）**、`verify_checksums_upstream`（上游写法对照）、`encode_emblem`（★ 从零造徽章的推荐入口）、`fill_unused_palette`、`used_palette_slots` |
| ★ `prepare_image.py` | Pillow | **图像前置加工**：任意图 → 合规的 128×128、≤255 色、1 bit 透明 PNG；另有 `--check-only` 检查合规性。★ 网页版的图像夹具生成器直接 import 它取**独立参考结论** |
| `selftest.py` | Pillow | ★ 与**官方 exe** 的交叉验证（三种载体 × 四个方向 = **24 项**断言）。★ **全项目唯一**驱动上游二进制的代码。⚠ 这里原来还有第 25 项 =「顺手跑一遍 `acet_format.py` 自检」，已改成 `web\check.mjs` 里的**独立一步**「③ python：格式核心自检」（覆盖没丢，只是不再算进本脚本的项数） |
| `make_testdata.py` | Pillow | 重建 `../testdata/` 里的合成样品（`synth_*`）；网页版测试**不用**它们（用的是 `testdata/real/*` + `out/evidence/*`） |

**核心与图像 I/O 是分开的**：`acet_format.py` 只处理"128×128×4 字节 RGBA"这个中间表示，
不碰 PNG。所以就算没装 Pillow，格式核心也照样能用、能自检。

> 曾经还有 `acet_cli.py`（Pillow 命令行，替代官方 exe）与 `check_pcsx2_slots.py`
> （实机验证前的 PCSX2 自检）。两者在 0.19 删掉：
> 前者被网页版 + 上游官方 `acet.exe` 取代；后者的结论已**逐条移植**到
> `../web/src/ui/logic/pcsx2.ts`（网页最下面那块自检面板用的就是它）。
> 存档里都还在。

---

## ★ 图像前置：`prepare_image.py`

上游 GUI 里那段"缩放 + 减色 + alpha→mask"的逻辑，独立重写版。

```powershell
# 检查一张图是否合规（不改文件）
python tools\prepare_image.py 你的图.png --check-only
#   尺寸 / 不透明色数 / 半透明像素数 三项逐条判，并给结论

# 加工成合规 PNG
python tools\prepare_image.py 任意图.jpg -o ready.png
# ① alpha 二值化(阈值 128)  ② 缩放到 128×128（缩放后再二值化）
# ③ 只对不透明像素减色到 ≤255  ④ 独立复核并断言
```

★ 实测：一张 300×300、**49,444 色**、含 **27,919 个半透明像素**的图，
加工后用**官方 `acet.exe`** 注入**真实存档** → 校验 18/18 通过、读回逐像素一致。

与上游 GUI 的差别（都是有意修掉的坑）：
只有尺寸不符才缩放 → **一律缩放**；缩放后不重判 alpha → **重新二值化**；
减色会把透明像素也算进调色板 → **只算不透明像素**；无复核 → **独立断言 ≤255 色**。

---

## 跑法（三条，全绿才算没坏）

> 网页版那边有 `node ../web/check.mjs` 一条命令跑完全部判据；它内部也会跑下面这三条。

```powershell
python tools\acet_format.py            # 格式核心自检（0 项失败）
python tools\selftest.py               # 与本机官方二进制交叉验证（24/24）
python ..\_selftest\validate_writer.py # 真实存档逐字节复原（10/10）
```

## ★ 末段校验字节按**真实位置**写（这是本目录最重要的一个定案）

非 LR `0x4435` / LR `0x4415`。上游 `acet` 写在 `0x4434` / `0x4414`，**差一个字节**；
它平时能用只因为总在已有存档上原地注入（尾部 11 字节被保留）。从**空白块**造存档
会被游戏判 `破損ファイル` —— 这就是本目录所有非 LR 写入实验失败的原因。
详见 `../_selftest/04-末段校验差一字节.md`。

## ★ alpha 三个档位（上游与游戏用的是**两套不同规则**）

| 档位 | 规则 | 什么时候用 |
|---|---|---|
| `acet`（上游行为） | 任何非零 alpha → `0xFF` | 与**官方 exe 逐像素对齐**、做交叉验证 |
| **`index0`** | ★ **调色板索引 0 透明、其余不透明（忽略 alpha 字节）** | ★ **"游戏里到底长什么样"就用这个**（网页预览也是这一档） |
| `gs` | 按 PS2 GS `0..0x80` 线性映射（`0x40`→127） | ⚠ 分析用；**实机已证明它不是游戏行为** |

★ 依据是**实机实测**（细节见 `../docs/01-项目理解/02-存档格式规范.md` §五）：
把 `data0` 调色板 RGB 全取反（`palette[0]`：`00 00 00 40` → `FF FF FF 40`）写进新槽 `data2`，
游戏里那一格**背景仍是黑的** —— 既不是纯白（按 RGB 画）、也不是 50% 灰（按 alpha 混合）。
⇒ **游戏看的是索引 0，不是 alpha 字节。**

三档对照（角像素 = 背景）：

| 样本 | `palette[0]` | `acet` | **`index0`** | `gs` |
|---|---|---|---|---|
| `data0` 恶魔脸 | `00 00 00 40` | 不透明黑 | **透明** ✅ | 50% 黑 |
| `data1` 红树 | `00 00 00 00` | 透明 | 透明 | 透明 |
| `data2` 反色恶魔 | `FF FF FF 40` | 不透明**白** ❌ | **透明** ✅ | 50% **白** ❌ |

⇒ **只有 `index0` 三个都对**；`acet`/`gs` 在 `data2` 上都与实机不符。

---

## ★ 与官方 exe 的差异（有意为之，不是 bug）

| 行为 | 官方 exe | 本实现（Python 与 TS 一致） | 为什么 |
|---|---|---|---|
| 颜色数溢出（第 257 项） | **静默截断**成索引 0 ⇒ 串色 | **直接报错** | 上游是差一 bug，见限制问题 2 |
| 错误路径 | `cin.get()` 等回车 ⇒ 脚本挂死 | 非零退出码 / 抛异常 | 上游行为没法脚本化 |
| 非 128×128 的图 | 不缩放 ⇒ 写坏数据 | **一律缩放到 128×128** | 上游那条路是越界/写坏 |
| `find_offset` 语义 | **子序列**搜索（有坑） | `find_offset()` 复刻上游；`find_offset_contiguous()` 给正确版 | 既要字节级兼容，也要能查错 |
| **末段（第 18 段）校验字节的位置** | 写在 `0x4434` / `0x4414` | **写在 `0x4435` / `0x4415`** | ★ 上游**差一个字节**（见上） |
| 未用调色板项 | 留 0 | 填 `00 00 00 80` | 游戏自己写的存档里除槽 0 外**没有任何全零项**、alpha 一律 `0x80`；只影响未引用项，不改变图像 |
| 单下标越界写 | Python `bytearray` 会 **IndexError** | 同样抛（不"静默扩容"） | 0.19 定案：只有**切片赋值**才扩容 |

**字节级兼容性已由 `selftest.py` 证明**：本实现写出的存档官方能逐像素读对，
官方写出的存档本实现也能逐像素读对（**24/24 通过**，末段修正后仍然成立 ——
因为当尾部形如 `X 01 00*9` 时两套写法恒等）。

---

## 编程接口（想在别的脚本里调用）

```python
import sys; sys.path.insert(0, r"...\emblem-tool\tools")
import acet_format as af

save = af.read_save_file(r"BASLUS-20435E00")

print(af.save_kind(save))          # 'emblem-raw' / 'emblem-lr' / 'container' / 'unknown'
print(hex(af.find_offset(save)))   # 徽章块起点

ok, bad = af.verify_checksums(save)     # 独立判据：18 段逐段验（按真实末段位置）
ok2, _ = af.verify_checksums_upstream(save)   # 上游那种早一字节的写法（对照用）
rgba = af.extract_image(save)           # 16384*4 字节 RGBA8888

s = bytearray(save)
af.inject_image(s, rgba)                # 就地写；strict=True 时颜色超限会报错
af.write_save_file(r"out.raw", s)

# ★ 从零造一份「游戏能接受」的新徽章 —— 推荐用这个入口：
tail = af.header_tail_from_save(save)          # 非 LR 必须给这 9 字节作品常量，别猜
blk = af.encode_emblem(rgba, is_lr=False, header_tail=tail)   # 自动填未用项 + 正确末段校验
```

常用常量都导出了：`SAVE_SIZE` / `LR_SAVE_SIZE` / `IMAGE_OFFSET` / `LR_IMAGE_OFFSET` /
`SEED` / `SEED_LR` / `EMBLEM_HEADER` / `segment_layout()`，
以及末段相关的 `FINAL_SEG_OFF` / `FINAL_DATA_LEN` / `FINAL_CHECK_POS` / `FINAL_ALPHA_POS` /
`FINAL_TRAILER`。
⚠ `FINAL_CHECK_OFF` / `FINAL_CHECK_OFF_LR` / `DANGLING` / `DANGLING_LR` **保留但语义是
"上游的（错的）写法"**，只做对照用，不要再拿来定位校验位。
格式含义见 `../docs/01-项目理解/02-存档格式规范.md`。

---

## 注意

* ★ **本工具与官方 exe 都用"文件大小"判定布局**，所以判定结果也要人来复核
  （容器里的 LR 会被误判成非 LR，见限制问题 3）。
* `testdata/_work/` 是 `selftest.py` 的临时目录，可随时删
  （⚠ 0.19 删掉了原先负责清理它的 `_selftest/tidy_layout.py`，现在要手删）。
* 对本工作区的意义：这套东西把"PS2 AC 徽章存档"变成了**可脚本化、可批量校验**的对象。
  但**徽章是玩家自绘图案，里面没有游戏文本**，与汉化本体无直接关系 ——
  它的价值在格式情报，见 `../docs/02-参考资料/02-与本工作区的关联.md`。
