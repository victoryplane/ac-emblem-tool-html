# 移植笔记：Python 参考实现 → TypeScript 核心

> 记录 `web/src/core/` 与 `../tools/acet_format.py`、`AC3_CN\tools\30-存档\` 的对应关系、
> **验证判据**、以及移植中发现的**语义歧义**。做 UI 之前先读这一份。
>
> ★ **逐版本历史由 git 记录**（`git log`）；本文只写"当前契约"与移植纪律。
> ★ **一条命令跑完全部判据**：`node web\check.mjs`（打包 + 四套 node 测试 + 三条 python 判据）。

## 一、当前状态（2026-10-04 建立，2026-10-08 对齐 0.47）

| 模块 | 文件 | 状态 | 判据（可复跑） |
|---|---|---|---|
| 格式核心 | `src/core/emblem.ts` | ✅ | `node web\test\core.test.ts` → **通过 2846 / 2846** |
| 记忆卡层 | `src/core/card.ts` | ✅ | `node web\test\card.test.ts` → **通过 1640 / 1640** |
| 图像管线 | `src/core/image.ts` | ✅ | `node web\test\image.test.ts` → **通过 1079 / 1079** |

> ⚠ 这三行**故意不写行数**（原来写"843 行 / 1,074 行 / 1,204 行"）：行数每轮都在漂，
> 写在文档里必然过期。要看现在多少行：`(Get-Content web\src\core\emblem.ts).Count`。

夹具由 **Python 参考实现**生成（它是"真值"来源），TS 必须逐字节吻合：

```powershell
python web\test\make_fixtures.py        # → web\test\fixtures\manifest.json（44 个样本）
python web\test\make_card_fixtures.py   # → web\test\fixtures\card-manifest.json
python web\test\make_image_fixtures.py  # → web\test\fixtures\images\（8 张裸 RGBA 输入图）
node   web\test\core.test.ts            # 2846/2846
node   web\test\card.test.ts            # 1640/1640
node   web\test\image.test.ts           # 1079/1079
```

* 样本 = 10 份 `testdata/real/*.raw` + 33 个从 `out/evidence/*.ps2` 只读抽出的徽章块 + 1 个 PSV 容器。
* **零依赖、零构建**：Node 24 原生跑 `.ts`（类型擦除）⇒ 相对 import **必须写全 `.ts` 扩展名**，
  且只能用可擦除语法（不要 `enum` / `namespace` / 构造函数参数属性 / 装饰器）。
* 4 张证据卡只读，夹具脚本每次运行都会 SHA-256 自证"未改动"。

## 二、格式核心（`emblem.ts`）—— 6 个容易搞错的地方

1. ★ **`palette[255].alpha` 就是"末段 alpha 字节"**（`offset_index(0x24+0x4000+255*4+3) = 0x4434`）。
   所以游戏固定写 `0x80` 的不是"额外插入的字节"，而是调色板最后一格的 alpha 通道。
   ⇒ `applyChecksums` 强制 `0x80` 是对的：**42/44 逐字节复原，含全部 10 份真实存档**。
   唯二例外是 `write_data2_inverted.py` 造的**实验块**（`0x4414 = 0x8F`，不是游戏产物；该脚本 0.19 已归档），
   夹具里用 `appliedIdentical: false` + `appliedDiffOffsets` 显式记录，**不算失败**。

2. ★★ **`unscramblePalette` / `scramblePalette` 是同一个自逆置换，不是互逆的一对。**
   Python 只有一个 `unscramble_palette()`，提取与注入共用（`invertPalettePermutation(LUT) === LUT`）。
   写成"正/反两个函数"会让**非 LR 的索引整体错位**（移植第一版就是这么错的）。

3. **调色板乱序重排是对合**（做两次等于没做）—— 非 LR 有、LR 没有；这是两种布局在解码上的唯一算法差别。

4. **末段那 53 / 21 个逻辑字节里，最后 10 个物理上不存在**
   （`offset_index` 给出的位置 ≥ 文件长度）⇒ 它们只是数据流尾部填充，`FINAL_TRAILER` 写在
   **物理**尾部 `0x4436..0x443F`。这也正是"上游那种写早一字节的写法与真实写法**恒等**"的来源：
   尾部形如 `X 01 00*9` 时两式相等。

5. **`fillUnusedPalette` 之后校验会暂时失效**（末段会覆盖调色板最后几项），Python 也**不**自动重算
   ⇒ 正确顺序是 `填充 → applyChecksums`（恢复）→ 再写卡。

6. **`verifyChecksums(容器)` 会返回 `true` 但没意义**（它只比对 18 个校验位置、**不检查文件长度**）。
   ⇒ 判据必须是 `saveKind() === 'container'` + `findOffset()` 切块后再校验。

7. **第 257 色（槽 256）的 4 字节物理位置 = `0x4435..0x4438`，正好压在末段校验字节上**
   （我用 `offset_index` 独立复算确认）⇒ 上游的"静默截断"之所以没捅出更大的娄子，
   是因为校验字节随后把 `0x4435` 覆盖了。**要修这个 bug 必须同时处理这处物理重叠。**
   颜色数边界实测：255 色都不抛；256 色 `strict=true` 抛 / `strict=false` 静默串色 64 px；257 色两者都抛。

## 三、记忆卡层（`card.ts`）—— 7 个坑 + 1 处待实机验证

1. ★ **ECC 公式必须是 `lp0 ^= (~i) & 0x7F`，不是 `& 0xFF`。**
   4 张证据卡实测：`& 0x7F` 匹配 **11,431 页**、`& 0xFF` 匹配 **0 页**。
   ⚠ **PCSX2 不校验 ECC**，所以写错这一位在实机上**完全看不出来**（本项目早先已实测"ECC 不校"）——
   只有拿真卡 dump 逐页反解才判得出来。**别改这一行**（改了等于让历史产物变"非标准"）。

2. **mode 位（我按结构证据复核过 450 个 dirent）**：
   **目录** = `0x8427`(211) + `0xA426`(4，根目录的 `.` 项)；**文件** = `0x8497`(235) ⇒ 取值集合不相交。
   `bit4 / bit5 / bit7` 都能分离；**`bit13(0x2000)` 不是目录位**（目录里只有那 4 个根 `.` 带它）。
   ⇒ 可靠判据是**结构**（该簇能否解析出 `.`/`..` 表）或 mode 值本身；
   **别只按名字判** —— LR 的 `BISLPS-25462EMB` 目录里有个**文件**也叫 `BISLPS-25462EMB`。

3. **dirent 名称区 32 字节填充是 `00`（不是 `FF`）** —— 克隆 dirent 必须整块覆盖。

4. **项数记在「根目录里那个目录 dirent 的 `length`」上**；子目录自己 `.` 项的 length **恒为 0**
   ⇒ `dirCount()` 只对根目录可信；新建文件后要更新的是根目录条目的 length。

5. **FAT 的"空闲"标记是 `0x7FFFFFFF`，不是 `0xFFFFFFFF`**（后者是单簇文件的链尾）
   ⇒ 不能靠 FAT 值判空闲；用"可达簇集合 + 系统区"扫描法，且分配起点**原样保留** `aoff+2`
   （换成"最小空闲簇"就会与已通过实机的卡不一致）。

6. ★ **写坏卡的头号风险 = 分配簇**（少算一个已用簇就会覆盖根目录）。参考实现只是
   "本卡可达簇 + 系统区"，**不是完整分配器**（不看 superblock 的 0x40/0x44 自由簇计数）。

7. **跨句柄读-改-写会让 FAT 写入静默回退、链断** —— `card.test.ts --badhandle` 专门复现了这个坑作为诊断。
   写卡时**必须**从同一个（副本的）句柄读-改-写。

8. ⏳ **待实机验证：目录满时新建槽**。4 张证据卡的 `BISLPS-25462EMB` 全都是 **8/8 满**，
   所以"新建 `data7`"必然要**扩目录簇**（分配新簇 → 接链尾 → 新 dirent 写进新簇第 0 页 → 根条目 length 8→9）。
   这条**没有 Python 参考实现**，TS 与 Python 用的是同一套泛化算法 ⇒ **"两边一致"只证明移植忠实，
   不证明布局正确**。建议实机验一次（顺便把"新 dirent 页的备用区仍是 `FF×16`"也确认了）。

## 四、给 UI 的接口提示

```ts
import { saveKind, isLrSave, findOffset, verifyChecksums, extractImage, encodeEmblem }
  from '../core/emblem.ts';            // ★ 扩展名必须写全
import { readCardFromBuffer, listRoot, listDir, createFileInDir } from '../core/card.ts';

const kind = saveKind(bytes);
// 'emblem-raw'（0x4440，单个非 LR 徽章） / 'emblem-lr'（0x4420，LR 的 dataX）
// 'container'（记忆卡/PSV 等，先 findOffset() 再切块） / 'unknown'
```

* `extractImage(bytes, 'index0')` 才是**游戏里看到的样子**；`'acet'` 用于与官方 exe 对齐；`'gs'` 只作分析。
* `encodeEmblem(rgba, { isLr, headerTail })` 是**从零造**的推荐入口（自动填未用调色板 + 正确末段校验）。
* 写卡流程建议：`createFileInDir` 后**立刻回读**（`readFile`）逐字节比对 + `verifyChecksums` 18 段 + ECC 坏页 = 0。

## 五、图像管线 / 界面 / 构建（M2 · M4）

### M4a ✅ 界面骨架 + 单文件构建（已完成）

```powershell
node web\check.mjs          # ★ 一条命令跑完全部判据（打包 + 四套 node 测试 + 三条 python）
node web\build.mjs           # → web\dist\emblem-tool.html（668.3 KiB / 684,341 字节，双击 file:// 即用）
node web\test\ui.test.ts     # 1293/1293
```

> ★★ **先读这一行**：**UI 契约的主位是 `SPEC.md §四`**（布局 / 交互 / 按钮 / 文案纪律 / "删过的东西别再
> 加回来"都在那里）。本节只写**移植与机制上的坑** —— 也就是"为什么必须这么写"、实测数据、以及
> 浏览器 / 平台层面的陷阱。**同一个事实不在这里再讲一遍全文**；下面出现 `见 SPEC §x` 的地方就是指针。

★ **布局顺序（用户定，`v0.5` 起；`v0.22` 更新）**：顶栏 → 上区（**左 2/3 = 「当前图片」一格**：细工具条 + `#image-drop.stage`；
**右 1/3 = 参数侧栏**）→
8 槽 → 写卡提示/日志 → **PCSX2 自检（整页最底部、全宽、★ 默认折叠、可展开）**。
上区列定义 `minmax(0,1fr) minmax(190px,220px)`（`v0.23` 按用户要求收窄参数列）；断点 **≤1100 上下堆叠**（旧 1400/900/760 已作废）。
★ **`v0.22`：右栏从「工具侧栏」改成「参数侧栏」** —— 用户定了**不做内置像素编辑器**（见下面 M4b 一节），
于是空出来的那一栏给参数（参数原来在 `</main>` 之后独立一整行，`width: 100%`）。
★ **常驻的「原图」面板已按用户要求删除**（DOM + CSS + 挂载点都不留）；
那一格 canvas 是**游戏口径（索引 0）的预览**（0.22 起不再是"将来的编辑画布"）；选图/拖入/Ctrl+V 搬到左格细工具条。
**取景 = 窗口模型**（`ui/cropView.ts` + `ui/logic/cropGeometry.ts`，`v0.6` 重写；用户定的交互）：
**固定白色方框**（框外压暗、角标 `128×128`）+ **任意位置拖拽 = 平移图片** + **滚轮 = 绕框中心缩放** +
〔确定取景〕/〔取消〕（快照回滚）；提示只有一行；取景舞台用**中性深色**（不是棋盘格）。
★ **默认取景 = "填满白框"**（`v0.9`，用户定）：`cropGeometry.fillWindow()` = **窗口边长 = 源图短边、居中** ⇒
打开图片第一眼白框里就是满的、没有透明边。⚠ 上两版（`v0.6`~`v0.8`）是 `size = 长边`（整张图缩进框里、两边留透明），
用户把它当成"图变小了"。**〔↺ 复位/适应〕与〔↺ 恢复到适应〕两个按钮已按用户要求删除**（`v0.9`），
`pipeline.ts::fitManualToTarget()` 也改名成 `fillManualToTarget()`（改判据时别只改 UI、忘了这里）。
★★ **白框最小 = 目标边长（128 源像素）⇒ 不放大**（`v0.11`，用户附截图："如果我选了一片非常小的区域，
图片就会这样（一堆麻点），要不我们限制白框最小取到 128*128"）：`windowBoundsFor(srcW, srcH, target)`
的下限 = `min(target, 源图短边)`（不再是"长边/64"），`MAX_ZOOM` 常量与 `CROP_MAX_ZOOM` 一起删了。
窗口 = 128 ⇒ 烘焙 **1:1**；往里滚会停住，状态行写"★ 已经到最小（1:1…）"。
⚠ 参数行手输的「倍率」也按同一条规矩夹住（`main.ts::applyManual`，上限 = 目标 / min(目标, 短边)）
—— 两条路都得夹，别只改取景视图。源图比 128 小时下限退化成短边（整张取景，不补透明边）。
★ **`[hidden]` 必须靠 CSS 钉住**（`v0.9` 用无头 Chrome 截图抓到的真 bug）：`#crop-actions` 同时带
`.row { display: flex }`，而浏览器默认的 `[hidden] { display: none }` **优先级低于作者写的 class 规则** ⇒
没进取景视图时那行"拖动图片…〔确定取景〕〔取消〕"照样渲染。`styles.css` 顶部有
`[hidden] { display: none !important; }`（**别删**，`ui.test.ts` 有断言）；`.stage-layer[hidden]` 是同一类问题的旧补丁。
★ **唯一原始状态 = "白框框住的源图区间"**，`manualScale/Offset` 都是派生量 ⇒ 所见即所得**构造性成立**，不靠换算正确。
★ 历史坑（`v0.5` 的"确定取景后图片消失"，真凶已证实）：
**界面 `manualOffsetX/Y` 口径是源像素，`core/image.ts` 的 `offsetX/offsetY` 是目标像素**，两者差一个"取反 ×scale"。
漏这步 ⇒ 非方图整体挪出画框 ⇒ 预览**全透明**。实测 `1000×800` 只剩 384/16384 不透明像素、`1024×600` **全空**、
正方形图恰好两套口径都是 0（所以"有时候是好的"）。修法：唯一换算点 `logic/defaults.ts::manualOffsetToTarget()`。
★ 另有两个同源的几何 bug（同轮修掉）：框宽应是 `(targetSize/scale) × k`（**不是** `scale×k×targetSize`）、
拖拽换算屏幕 1px = `1/k` 源像素（改 offset 时要乘回 `scale`）—— 症状都是"能跑但手感全错"，DOM 冒烟测不出来。
★ 〔确定取景〕前有**烘焙自检**（`checkBakeResult`）：源图那块有内容却烘出全空 ⇒ **报错且不关视图**，绝不静默给空白。
★ **内容区一律不出现滚动条**（`v0.4` 起）：舞台/取景容器 `overflow: hidden`，画布**等比自适应**（`max-w/max-h 100%` +
`aspect-ratio: 1/1` + `pixelated`），「预览倍率」是**上限**语义（`pipeline.ts::fitDisplaySize()` 装不下就缩，并提示"已按容器缩放显示"）。
★ **工作区自动填满左格**（`v0.9`；高度下限 `v0.10` 调过）：`.stage` = `flex: 1 1 auto` + `width: 100%` +
`min-height: clamp(320px, 62vh, 760px)`（**兜底必须有**：里面两层都是绝对定位，窄屏堆叠时没有它会塌成 0。
⚠ 62vh 是**量出来的**：4× 预览要 512px ⇒ 舞台要 ≥524px；852px 高的视口上 `56vh` 只有 477px ⇒
预览被压成 465px 并点亮"已按容器缩放显示"，用户报"我希望它是完全展开的"）；
**没有** `aspect-ratio`、**没有** `max-width`（`v0.8` 那版才是"正方形 + 上限 560px + 居中"）。
★★ **`#view-preview` 必须自己有尺寸**（`v0.10` 修的第二个 bug）：它原来没有任何尺寸规则 ⇒ 盒子由
**里面的 canvas** 撑出来，而 canvas 的尺寸是 `fitDisplaySize()` 量了它之后算的 ⇒ **量一次缩一次**
（128→116→104→…→68px）。现在 CSS 给它 `width/height: 100%` + `display: flex` 居中，
`fitDisplaySize()` 改成 `cv.closest('.stage')`（**首选舞台**，`parentElement` 只作兜底）。
白框 = 工作区短边 × 70%（夹 `[120,420]`）⇒ 工作区越大白框越大（如 700×430 ⇒ 301px）。
⚠ `min-height` 与 `.upper` 左列是**两个独立的旋钮**：前者决定"最少多高"、后者决定"多宽"；
`.upper` 旁以注释留了一条未启用备选（`minmax(0,2.4fr) minmax(240px,1fr)` = 宁可挤压右侧工具）。
★ **取景拖动期间绝不跑管线/DOM 重建**（`v0.7` 起的性能契约，有调用计数断言）：`cropView.ts` 里 `applyDrag/applyZoom`
只累加待处理量 + `requestAnimationFrame` 合帧；**唯一提交点**是 `commitWindow()`（〔确定取景〕才跑一次 `prepareEmblem`）。
F12 自查：`EmblemToolCore.ui.pipeline.pipelineStats()` —— 拖动期间应一动不动，确定才 +1。
（旧版每移动一次鼠标要跑 `prepareEmblem` **298 ms** + 整图 `imageStats` **99 ms** ≈ 397 ms，是 60fps 预算的 24 倍 ⇒ 卡。）
★ **没有页脚**：原来那两行说明已删；"**写卡前先完全退出 PCSX2**"这条安全提示只在
`logic/writeGuard.ts::QUIT_PCSX2_WARNING`（写卡确认框）里 — 不要因为"页脚删了"就把它一起删掉。

★ **PCSX2 自检拿到文件的三种方式**（`file://` **不能凭路径读文件**，所以是"一次点击 + 记住位置"）：
1. 主：`showDirectoryPicker({ id:'pcsx2', startIn:'documents' })` —— 选择框开在"文档"、Chrome 按 `id` 记住上次目录；
   递归读三个文件后**立刻出结论表**；句柄尝试存 IndexedDB（失败静默），下次权限仍在就静默自动读（不自动弹框）。
2. 兜底：`<input webkitdirectory multiple>`（主路径不可用/被拒时**自动**切换）。
3. 拖入：三个文件或整个目录（拖目录用 `webkitGetAsEntry()` 递归 —— `dt.files` 不含子文件）。
界面上常驻 `PCSX2 默认目录：C:\Users\M\Documents\PCSX2` 与 `本次来源：…`（后者是判断
"`file://` 下 `showDirectoryPicker` 到底能不能用"的证据）。纯逻辑在 `logic/pcsx2Paths.ts`（可测）。

★ **`v0.30`：〔选择记忆卡〕的选择框尽量开在 `Documents\PCSX2\memcards`**（用户："点击选择记忆卡就自动到该路径下"）：
* ⚠ **不许写路径**：`startIn` 只收"已知文件夹枚举"或**目录句柄** ⇒ 两级候选
  （`main.ts::memcardsHandle` 缓存 + `refreshMemcardsHandle()`）：① 自检那次授权还在 ⇒ `recallPcsx2Handle()`
  → `getDirectoryHandle('memcards')` 拿目录句柄当 `startIn`（**直接开在 memcards**）；② 否则 `'documents'`
  （`C:\Users\M\Documents`，memcards 在下面两层）。两条都不行才退只读兜底。
* ★★ **句柄缓存着用，点击那一下同步取**：`showOpenFilePicker` 要"点击起 5 秒内"的 transient activation，
  中间夹 `await`（开 IDB / 查权限）一旦被卡住就会**手势过期** ⇒ 弹框被拒、静默掉进只读兜底。
  刷新点只有两个：**启动时**与**选完 PCSX2 目录后**（后者是用户最常用的顺序：先自检、再选卡）；
  没缓存时点击**顺手刷一次但不等**（第二次点就开在 memcards）。`ui.test.ts` 分节 (r) 拿掩码源码钉住这段同步性。
* ⚠ 候选阶梯里**只有一处 `isAbort()`**：取消一次不会再弹第二个框。
* 顺带：按钮文字去掉"（可覆盖保存）"、顶栏锁状态的同一个后缀也删（`🔓 文件名`）。

★ **`v0.36`：语言标签"常显双语 + 纯白"**（用户："无论使用那个语言，这个文本都显示双语，
而且要改成纯白色"）：

* `index.html` 的 `#lang-label` 文字**写死** `语言/Language`，并且**不带 `data-en`** ——
  静态文字参与翻译的唯一入口就是 `data-en`（`i18n.ts::applyStaticI18n()` 只认它），
  ⇒ "两态同一句"这条要求等价于"它不参与翻译"。它是全页**唯一**这样的静态标签；
  `ui.test.ts` 分节 (p) ⑤b 同时钉住"它没有 data-en"与"同行的记忆卡 / 作品标签仍然有 data-en"，
  免得日后有人把例外扩成惯例。
* 样式在 `styles.css::.lang-pick .lbl`：`#fff` + `font-weight:600` + 一点 `letter-spacing`
  —— 高亮**只用"字本身"的属性**。⚠ 这条规则里**不许**出现 `text-shadow` / `box-shadow` / `filter` /
  动画（测试反过来断言"一条都不许有"），也**不许**出现 `font-size` / `padding` / `margin`（测试直接断言）。
* ★ **实测**（真产物 `file://` + Edge 154 / 1500px 视口）：中英两态标签文字**逐字节相同**、
  `data-en=false`、`color=rgb(255,255,255)`、`font-size` 仍是 `12.5px`、与语言下拉同一行、
  横向无溢出；对照顶栏其它 `.lbl` = `rgb(139,151,168)`。
* ⚠ **量过的代价**：标签从 2 字/8 字变成 10 字 ⇒ 顶栏折行点**从 900px 提前到 1000px 视口**
  （1050px 起与旧标签完全一致，顶栏高 59px）。顶栏本来就是 `flex-wrap: wrap`，接受。

★ **`v0.34`：面积平均（`smooth`）的支撑区口径定案**（`core/image.ts::supportRange()`）：

* 目标像素的支撑区 = 目标像素矩形映回源空间的那一块；与它有**正面积**交集的源像素 =
  `floor(a) … ceil(b) - 1`（`a/b` = 支撑区两端、源像素单位）。**面积平均的四个采样点
  （`smoothFit` 的 X 权重表 + Y 循环、`smoothStretch` 的 X/Y）全都走这一个函数**。
* ⚠ 下限必须是 `floor(a)`，**不能**是 `ceil(a)`：`ceil` 会把"被**部分**覆盖的那个像素"整块丢掉，
  而放大时（支撑区 ≤ 1 个源像素）那个像素就是唯一的一个 ⇒ 支撑区算成空 ⇒ 整片走"补背景"。
  上界用 `ceil(b) - 1` 是为了排掉零面积擦边（`b` 正好落在整数上）。
* 判据：`image.test.ts::testAreaAverageSupport()` —— 与**本文件独立写的**教科书 box
  （`refBox()`）逐像素对拍（缩小 / 放大 / 非方形目标都覆盖），外加"全不透明的图放大后
  不许出现透明像素"这条回归。**缩放核仍然是两档**（`auto` 只在 nearest / smooth 里选）。

★ **`v0.47`：加日语 / 韩语（四语内联，不用键表）** —— 机制与踩过的坑（契约在 `SPEC.md` §三 / §四）：

* **形态**：`t(zh, en, ja, ko, vars?)`；静态 `data-en` / `data-ja` / `data-ko`（属性对同形
  `data-<lang>-title|placeholder|aria-label`）；`applyStaticI18n()` 的快照机制不变（中文 = DOM 原文），
  只把"二选一"换成"按 `lang` 四选一"（`dataVal(el, lang, attr)` 一处收口）。
  `<html lang>` 按语言写（`HTML_LANG`）—— CSS 的 `html:lang(ja) body` / `html:lang(ko) body` 字体栈靠它。
* ★ **改写是脚本做的**（290 个站点，手改必错），过程中踩到/修掉四个坑，值得记下来：
  1. **注释里的示例会被正则当成真调用**：`i18n.ts`/`dom.ts` 的 JSDoc 里写着 ``t('中文','English')``
     ⇒ 抽取必须走**掩码后的源码**（`maskSource` 找 `t(` 的位置），否则注释里的示例会被改坏。
  2. **模板串里的嵌套反引号不能转义**：像
     `` `${same.map((s) => `${s.dir}\\${s.file}`).join('、')}` ``
     这类值，若把内层 `` ` `` 写成 `` \` `` 就变成"外层模板的文本" ⇒ 语法/语义全错。
     正确做法：新实参一律**模板串**，其中 `${…}` 段**原样保留**，只对**文本段**做 `\`→`\\`、`` ` ``→`` \` ``。
     反过来，值里没有 `${` 时才写单引号串（这时真实换行要转成 `\n`）。
  3. **实参是"字面量拼接"的站点第一批漏了**：`t('a' + 'b', 'c' + 'd')` 那种，按"两个字面量配对"
     的抽取根本匹配不到（22 个站点，多是多行长句与 `t(常量, 'en')`）；它们要**另做一遍**，
     插入点在**尾随逗号之前**（参数表允许尾逗号，插到 `)` 前会得到 `,,`）。
  4. **`\n` 会被"读字面量"那一步吃掉**：`'…：\n· …'` 读成 `…：n· …` ⇒ 那一处（`cardOps` 的不合规明细）
     是**手工改回** `\n` + `・` 的。教训：抽取器必须**区分"转义序列"与原文**，别混成一种字符串。
* **闸门**（都在分节 (p)）：每个 sink 调用 ≥4 个实参（按第 1 层逗号切；**闸门里没有 tsc**，
  少给一个实参只会显示 `undefined`）；每个 `data-en` 元素必须同时有非空 `data-ja`/`data-ko`、
  不许抄中文、`data-ja` 必须含假名、`data-ko` 不许"纯汉字"；产物里四语关键句都在；两条字体栈在。
  `lang-sweep.mjs` 改四语：英/韩不许有汉字、韩必须有谚文、日必须有假名（**日文里汉字合法**，
  所以"无汉字"这条对日文失效 —— 这是本次判据上最实质的一处调整）。
* ⚠ **不采用"每种语言一个文件 + 键"**：唯一收益是"加语言 = 加文件"，而四语就是终点；还要多养
  键集合一致 / 翻译过期检测 / 回退链（回退链会掩盖"这条没翻"）。**以后真加第 5 种语言再迁也不迟**。
* **产物体积**：596 → **668 KiB**（四套文案都内联 —— `file://` 不能按需取语言文件）。

★ **`v0.46`：夹具去掉两个只写不读的字段 + 文档主位收敛**（没有界面改动）：

* **夹具**（生成器 → `card-manifest.json`）：删 `fileDataPattern`（TS 侧连接口都没有）与
  `spareHexSpaced`（只有接口声明、零断言）。**重生成是幂等的** —— 先跑一次未改动的生成器对拍，
  三份产物逐字节相同；改完再生成，深比对只少这两个字段（109,124 → 108,782 B），别的值一个没动，
  四张证据卡的 SHA-256 自证也未变。⚠ 环境变量：`AC_MC_SURVEY_PY` + `AC_MC_PY`（两个都要，
  少一个 `make_card_fixtures.py` 会在 `load_mod` 处炸）。
* ⚠ **核对后否掉的夹具"收窄"**：`manifest.json` 那批"看着可复算"的字段（`finalCheckPos` /
  `appliedSha256` / `appliedDiffOffsets` / `finalTrailer`…）与 `card-manifest.json::constants`
  是**跨语言断言的 Python 那一侧**（`core.test.ts:210-215,233-241` / `card.test.ts:229-244`），
  删掉就把"TS == Python"降级成"TS == TS"。同理 `make_fixtures.py` 的 `source` 字段**保留**：
  生成器自己的汇总 `print` 在读它（`:296-297`）。
* **文档**：`SPEC.md` 头部改成描述**真实政策**，并写明"UI 契约主位 = SPEC §四 / 机制主位 = 本文件"；
  §四 418 → **244 行**（删叙事不删规矩，改完用关键词清单逐条核过）；本文件 `v0.43` 只留机制；
  `README.md` 两处纯复述改成指针。★ **本文件里那些"只此一份"的机制与实测一律没动**。

★ **`v0.45`：只读"可简化点"普查（3 个子代理分域）第一批落地** —— 全是零行为风险的东西：

* **删**：`image.ts` 的 `QuantizeResult.usedColors`（写 2 处、零读者）、`FitOptions.autoNearestColorLimit`
  （唯一用法 `?? 256` 等于被调函数默认值 ⇒ 传与不传等价）、`PrepareOptions.reBinarizeAfterFit`
  （UI 不产、测试不传 ⇒ `!== false` 永真，那一支从未执行）、`card.ts` 的 `Dirent.used`（唯一赋值恒 `true`、
  零读者）。⇒ `selectScaleKernel()` 现在**自己就是**"色数阈值 256"的唯一真值，改判据只改它的默认参数。
* **保留（写清理由）**：`PrepareReport.sourceOpaqueColors` —— `report` 是**有意的调试面**
  （`pipeline.ts` 那段"核心一个字段都没少"），而它是里面**唯一**的"原图实色数"；
  `colorsBefore` 是"二值化+缩放之后"的色数，**不是同一件事**。
* **去掉 9 个没人 import 的 `export`**：`CORE_DEFAULTS` + 8 个"只在定义文件内用且零测试"的
  （`MIN_WINDOW_PX` / `clampOriginFor` / `displayScaleFor` / `PCSX2_SLOTS` / `parseIni` /
  `isEmblemDirName` / `checkBlock` / `buildThumb`）。⚠ 与"抽成纯逻辑好测"那条选型不冲突：
  **另有 20 多个"只有测试用"的导出继续保留**（它们是判据本身）。
* **`writePermHintKey()` 去掉 `'ok'` 档**：唯一调用点前有两道早退 ⇒ 生产不可达。
* ★★ **三条"测试在说谎"**（这一类比死代码重要，因为它们是**假覆盖**）：
  ① 分节 (t) 要求 `selectSlot()` 原文里出现 `renderSlots(` —— 那个字面**只在注释里**（同一个文件里
  (y) 分节打在掩码上的断言说的正好相反）；② `eq(c.drags, 40)` 断言的是 `build.mjs` 刚赋的常量
  （恒真）⇒ 连 `crop.drags` 字段一起删掉（手势次数不是可观测量）；③ 两条 `A || B` 里 `B` ⊂ `A`。
  ⚠ 教训：**打在原文上的"有没有某个调用"断言，会被注释骗过** —— 这类断言一律走 `maskSource()`。
* **删 `web/SIMPLIFY-REVIEW.md`**（250 行，0.19 的清单）：它自己写着"已执行完毕 + 数字是改动前的"，
  而行号/体积全过期 ⇒ 是**错行号地图**。历史留给 `git log`。
* 两处**潜在陷阱**只加注释（不改行为）：`initCropView()` 的 `onRelayout ?? onChange`（回落点是完整管线）、
  `manualToWindow()` 不传 bounds（`targetSize` 变 64 时会静默提交）。
* 判据：`ui.test.ts` 分节 (ac)。**本次普查里被否掉的建议**（免得重复提）：合并四套测试 mini 框架、
  合并两份 JS 扫描器、删 `state.status` 兜底 / `pipelineStats()` / `cropInfo().transform` /
  `resetThumbs()` 两次 / `emblem.ts` 那批对照系导出 —— 理由都写在 `SPEC.md` 的 `★ v0.45` 条里。

★ **`v0.44`：文案里的 `**强调**` 全清（纯文本渠道不许写 markdown 标记）**：

* 依据：这个项目的所有文案都进 `textContent` / `title` / `setAttribute` ⇒ `**` 会**原样显示成星号**
  （不是加粗）。`v0.43` 只顺手清了提示行那两句，这一版把 `src/**` 里剩下的 **29 处**一次清完
  （中文与英文都清：`★ **Not written to disk**` → `★ Not written to disk`）。
  强调改回**文字本身**（`★` / `⚠` / 大写 / 换行分段）。
* ⚠ **注释里的 `**` 不动** —— 那是本项目的文档习惯，不进界面。所以闸门必须能区分"注释"与"字符串"。
* 闸门在 `ui.test.ts` 分节 (ab)：借 `tools/i18n-audit.mjs` 的**词法器**（它本来就懂注释 / 正则 /
  模板插值 / 括号配对）——新增 `auditSource(src, { collect: true })`：把**每一个**字符串字面量都收进来
  （默认模式只报"漏翻的中文"）。判据 = 扫 `src/**` 全部 `.ts`，任何字面量含 `**` 即失败；
  另用一份**故意的**样例自证"注释里的不算、字符串里的（含模板插值里层）都算"。
* ⚠ 顺手删掉那个词法器里**重复了 37 行、永远执行不到**的第二个"字符串"分支（前面那块末尾
  无条件 `continue`）。留着的坏处不是"长"，而是**改字符串处理时以为还有一处要改**。

★ **`v0.43`：提示去重 —— 一个事实只在"一个主位"讲全文**（规则在 `SPEC.md §八 7` ＋ §四 `★ v0.43`）。
这里只记**为什么这么实现**：

* **提示区 `#write-hint` = 主位**：`updateWriteHints()` 见到 `plan.error` 就 `return`
  —— 那两行（`noDirForGameText()` 整句 / "作品常量…"）是同一条事实的复述。
* **机制解释进 `title`**（hover 才看）：`WritePlan.errorDetail` —— 它不帮"怎么办"，所以不占正文位置。
* **状态行 / toast 只留一句话标签**：`WritePlan.errorShort`（`缺作品目录` / `槽位不存在`）。
* ★★ **预检就被拒 = 没发生任何事 ⇒ 不进写入日志**：新标记 `WriteOutcome.refused` 由
  `cardOps.ts::reject()` 产出（只弹一句标签、`lines` **一行都不加** ⇒ `renderLog([])` 让日志框保持收起）。
  顺手把"作品常量（9 字节）= …"那行也改成**预检全过之后**才 push（它原来是第一行 push 的，
  于是一被拒日志框就自己弹出来，里面只有这一句）。
  动作**之后**的失败（内存写入 / 回读自检 / 合规复核 / 磁盘被改过）仍然走 `fail()`：那些必须在日志里留证据。
* ⚠ `refusedNote(zh, en, hintLine?)` 是新的"中英成对"包装（内部 `t(zh + 后缀, en + 后缀)`），
  所以它加进了 `tools/i18n-audit.mjs` 的 `SINKS`；`hintLine=false` 用于"提示行上没有对应正文"的拒绝
  （没开卡 / 图像没准备好 / 没目标槽），不许瞎指"见上方提示行"。
  `refused.note` 是**函数**不是字符串 ⇒ 切语言时状态行能按新语言重说（`plan.errorShort` 用
  `refusedRedo(() => planWriteTarget(...).errorShort)` 重算，纯函数，重跑一遍即可）。
* 判据：`ui.test.ts` 分节 (aa) ＋ `write-probe.mjs` ⑦–⑬（端到端实测：提示区 1 行、日志框收起、
  状态行与提示条各一句标签）。

★ **`v0.42`：修"写权限问得太晚 ⇒ 必然抛 SecurityError"**（**用户实测**抓到的真 bug）：

* **现象**（用户贴的就是这两行）：内存侧全过，最后一行却是英文异常 ——
  `✅ BISLPS-25462EMB\data3（槽 4，覆盖）：… 18 段校验 18/18 · 改动页 ECC 全对 · 图像合规…`
  `❌ 覆盖保存失败：SecurityError: Failed to execute 'requestPermission' on 'FileSystemHandle':`
  `User activation is required to request permissions.`
* **根因**：请求写权限（`FileSystemHandle.requestPermission`）是需要 **transient user activation** 的 API ——
  只有**用户手势起 ~5 秒内**、且中间没被 `confirm()` 这类模态框打断才允许调。旧代码把它放在
  **整条管线 + 落盘确认框之后**（`cardOps.ts::persistCardChange()` 里那句
  `await lc.handle.requestPermission(...)`）⇒ 手势早过期 ⇒ 抛异常 ⇒ 界面只能报"覆盖保存失败"。
  ⚠ 注意：`queryPermission()` **不需要**手势（任何时候都能调），只有 `requestPermission()` 需要。
* **修法**（三层）：
  1. 新增 `logic/writePermission.ts::ensureWritePermission(handle, { allowRequest })` —— 查 / 问 /
     **把 `SecurityError` 翻成 `{ ok:false, reason:'needs-gesture' }`**（不让异常冒泡）。
  2. `main.ts::requestWritePermissionIfNeeded()` 在 `doWrite()` 与〔删除槽〕**一进来**（任何 `await` 之前）
     问一次，结论记在 `state.card.writePerm` 上；拿不到就**提前**弹一句人话（"这次会改为下载"）+
     告诉用户"再点一次试试"，流程照走。
  3. `cardOps.ts::persistCardChange()` **只读结论、永不请求**（`ensureWritePermission(lc.handle, { allowRequest: false })`）；
     拿不到权限就优雅退化成"下载一份改好的卡"，并在消息里说清是哪种原因（手势过期 / 用户拒绝 / 只有读权限）。
     另外给 `SecurityError` 加了专属文案（"再点一次〔写入选中槽〕重试 / 或改用〔另存为〕"）。
* ★ **实测**（真产物 + Edge 154 + **假句柄精确模仿真机失败**：`queryPermission→'prompt'`、
  `requestPermission→抛 SecurityError` 且**计数**、`createWritable→SecurityError`）：
  `requestPermission` **被调用次数 = 1**（就在点击那一刻；**落盘那一步 0 次** —— 这正是旧代码的 bug 点）；
  界面上**没有任何英文异常**；提前那句警告在；日志里内存那几行照旧 ✅；
  最终走的是"…⇒ 已改为下载 Mcd001_embdata2.ps2（先完全退出 PCSX2，再拷回 memcards\\)"。
* 判据：`ui.test.ts` 分节 (z)（24 条）：纯逻辑（授予 / 问一次 / 用户拒绝 / **抛 SecurityError ⇒ ok:false 不冒泡** /
  `allowRequest:false` ⇒ **一次都不问** / 提示键 / 连 `queryPermission` 都没有的老浏览器当"能写" /
  `queryPermission` 自己抛也算 ok:false）＋ 源码规矩（`cardOps.ts` 里**一个 `requestPermission(` 都没有**、
  两条点击路径都调 `requestWritePermissionIfNeeded()`）＋ 产物里不许出现那句英文异常文本。

★ **`v0.41`：把代码审查（3 个子代理：核心层 / 界面层 / 构建与文档）报出来的问题成批修掉**
（这一版没有新功能，全是"会咬人的地方"）：

* **核心层**（`src/core/*` + 三套测试）
  · `headerTailFromSave()` 现在**校验形态**：喂 LR 存档或过短缓冲一律抛 `EmblemFormatError`
    （原来会静默把"图像数据里的 9 个字节"当作品常量返回）。
  · `applyChecksums()` 的**布局判据**从 `isLrSave()`（"必须恰好 0x4420"）改成 `layoutIsLr()`
    （"差最后 1 字节也算 LR"）—— 与 Python 参考实现的"切片赋值补齐"口径一致；`HEAD ↔ 现在` 的
    8×9 差分矩阵证明这是**唯一**的行为差异（`LR_SAVE_SIZE-1`：原来抛 → 现在补成 0x4420 且 18/18）。
  · `nearestStretch()` 取样式改成与 `mapTargetToSource()` 同一条公式（`round((t+0.5)*s/d-0.5)` + 夹取），
    并补了**独立参考实现**的 4×4→8×8 逐像素对拍。
  · `createFileInDir()` 第 4 步的占用集合：`collectUsedClusters()` **并回**刚分配的 18 个数据簇。
    只重收集会让扩目录簇分配回**数据簇**、把刚写的 dirent/数据盖掉（实测：`回读长度 1024`、
    18 段全坏、第二次写入报"簇链只有 1 簇"）—— 这条中间写法被端到端判据当场抓到。
  · `backgroundPixels` 的**口径定案**：它是"输出里逐通道等于背景色的像素数"，**不是**"补了多少背景"；
    `stretch` 两支**不补背景**（数学上铺满目标），所以那一支的数只是"源色撞上背景色"的计数。
  · 清理：删掉无生产调用点的 `chooseKernel()`（口径在 `selectScaleKernel()`）、合并
    `scramble/unscramble` 两条同体函数与同值 LUT、`smoothStretch` 的 `wx` 提到行外、
    显式给 `kernel` 时不再跑一次丢弃的探针、`findFreeSlot` 两段同体循环合一、省掉
    `makeBlankSave` 里那次立刻作废的校验。
  · 新增真卡判据 `card.test.ts::testCreateFileRealCard()`（长度 / 18 簇 / **数据簇与扩目录簇绝对页
    交集为空** / 内容逐字节一致 / 36 页 ECC 全对 / 源卡未改动），并把 D 实验那条"扩簇不许撞数据簇 /
    FAT 块"从**注释改成生效断言**。
* **界面层**：见 `SPEC.md` 的 ★ `v0.41` 条（要点：`blockedWhileBusy()` 挡五条非按钮入口 ·
  `markSelectedSlot()` 只切高亮 · 拖入开卡补 `lastSeen` · `cancelled` 透传 · `setStatusPair` 的 import ·
  取景角标 `content: attr(data-label)` · 死代码与过时注释清理）。
* **构建 / 工具 / 文档**
  · ★★ **`maskSource()` 的静默失败边界**（审查抓到的埋雷）：模板串里出现 `//`（且闭合反引号与那行同行）
    时，旧的两遍启发式把闭合反引号当成"注释里的反引号" ⇒ 扫描器吃到文件尾 ⇒ **其后整份源码被抹空、
    `export` 静默消失**（`transformModule` 只按掩码找 import/export ⇒ 产物缺导出，构建却"成功"）。
    现在 `markComments` 是**一遍正经词法器**（注释 / 字符串 / 模板 / 正则 / `${}` 配对），
    `scanTemplateText` 不再跳过闭合反引号。证据：23 条既有语义用例 + **22 个真实模块的
    `transformModule` 产物逐字节不变**，且"新抹掉的字符数 = 0"（旧掩码多抹的 3107 字符全是真代码）。
  · **`checkHtml()` 的"无任何外部引用"原来看不见 JS 字符串**：新增 ③b —— 对 `<script>` 原文的
    **字符串字面量**扫 `http(s)://` 与 `<link|<img|<script`（唯一放行 SVG 命名空间）。五种注入全报错，
    现有产物仍 `ok=true`。
  · **版本号"硬校验"名不副实**：新增 `checkArtifactVersion()`，`--check` 现在**读产物比对**
    `data-app-version` 与顶栏文本（不一致 ⇒ 非零退出 + "请重新构建"）。
  · **`check.mjs` 不是只读的**：`selftest.py` 不再覆盖被 git 跟踪的 `testdata/sample_A/B_*.png`
    （改写到 `testdata/_work/`），三个 python 脚本都加 `sys.dont_write_bytecode = True`；
    实测跑完 `testdata/` 无变化、`__pycache__` 时间戳不动。
  · **`isMain` 大小写敏感**：改 `samePath()`（Windows 大小写无关 + `realpath`）⇒ `node web\BUILD.MJS`
    不再"不打包、不报错、exit 0"。
  · **`i18n-audit.mjs` 原来 fail-open**：补**正则字面量识别**（`const re = /'/g;` 不再带偏引号配对）
    ＋ 模板 `${…}` 递归扫描（继承"是否已在 `t()` 实参里"，避免把已翻译的插值误报）。
  · **打包器不再把属性名当语句关键字**：`obj.import` / `{ export: 1 }` 正常转换；语句开头的怪
    `export`（如 `export = 1`）**硬报错**，不再静默擦掉中间代码。
  · `make_data7_test.ts` 默认**不碰** PCSX2 memcards（要写必须 `--to-memcards`，目标已存在默认拒绝、
    要 `--force`，并打印醒目警告）；`build.mjs` / `check.mjs` / 该工具都补了"不认识的参数 ⇒ exit 2"；
    官方 exe 路径**只留一处真值**（`selftest.py` 用退出码 2 表示"跳过"）。
  · 文档里 14 处"描述与代码不符"全部对齐（`+0.1` → `+0.01` 三份抄本、过期的行号 / 列宽 / 断点、
    指向 0.19 已归档脚本的说明、`.gitattributes` 里"产物混排 CRLF"实则纯 LF 等）；**行数类数字
    改成不写或注明"唯一来源"**，免得继续漂。
* ★ **实测**：`node web\check.mjs` **全绿 8/8**；`core 2846/2846`、`card 1640/1640`、`image 1079/1079`、
  `ui 1160/1160`（基线 2821 / 1619 / 1071 / 1114）；两条常驻端到端判据
  （`web\tools\lang-sweep.mjs`、`web\tools\write-probe.mjs`）全过。

★ **`v0.40`：把"切语言不同步"这一类一次清干净**（代码审查在 `v0.39` 之后又抓出四处同类的）
＋ **写卡失败不再卡死**（审查抓到的真 bug）：

* **根因（比 `v0.39` 那条更根本）**：**凡把"渲染好的字符串"存进 state / 闭包的，切语言一律换不过来。**
  逐处：

  | 位置 | 原状 | 现在 |
  |---|---|---|
  | `state.ts::state.status` | 存的是 `t()` 渲染好的串 ⇒ 切语言只能**清空** | `setStatus(text, redo?)` 多收**重算函数**；成对文案走新糖 `setStatusPair(zh, en)`；切语言 `relayoutStatus()` 按新语言**重说** |
  | `#crop-readout` + 取景那句状态行 | `layoutCropView()` 只写样式，文字在 `describeWindow()` 里 ⇒ 切语言后读数**停在旧语言** | 新增 `refreshCropText()`（切语言调它；顺带作废舞台尺寸缓存）；`statusLine()` 当 `redo` |
  | `#original-badge`（顶部"文件名 · 尺寸"） | 只由 `refreshImage()` 画 ⇒ 切语言**从不重画**；剪贴板那个名字在**导入那一刻**就被 `t()` 定死 | `renderOriginalBadge()` 导出并进重画名单；state 只存**原文件名 + `clipboard` 标记**，前缀渲染时才 `t()` |
  | 弹窗（开机告知 / 取景中写入拦截） | `showModal({title: t(…), …})` 存下来的是**当时那种语言**（第一稿重放等于重放中文）；而 `#modal-ok` 带 `data-en` ⇒ 切语言后"按钮英文、正文中文" | `showModal(() => ({…}))` 收**渲染函数**；`relayoutModalForLang()` 原样重放（Tab / F12 都能在弹窗开着时切） |
  | `toast()` 提示条 | 入参是渲染好的文字（30+ 个调用点）⇒ 切语言后脚边挂着旧语言的提示（error 活 60 s / warn 20 s） | 规则定成**切语言就收掉**（`dismissToasts()`）：宁可消失，也不留旧语言的话 |

* ★★ **写卡卡死（真 bug）**：`writeSlot()` 的顺序是"**先在内存副本上写** → 弹落盘确认框 → 回读自检"，
  所以**取消或自检不过时内存已经变了**；而 `main.ts` 原来只在 `outcome.ok` 时 `refreshCardViews()` ⇒
  模型还说那一槽是空的 ⇒ 第二次点〔写入选中槽〕撞 `createFileInDir()` 的"已经有 dataN，拒绝覆盖"，
  〔删除槽〕也说"本来就是空的" ⇒ **用户被卡死**（只能重开卡 / 切作品）。
  修法：`writeSlot()` 之后**无论成败都 `refreshCardViews()`**（与〔删除槽〕那条路一致）；
  并且 `WriteOutcome.cancelled` 让界面把"取消"与"被拒绝"分开说。
* ★ **实测**（真产物 + Edge 154）：`setLang('en')` 之后遍历**整页可见文字** ⇒ **含汉字的节点数 = 0**
  （豁免有意双语的 `语言/Language`；收起来的弹窗 / 写卡日志、内联脚本不算）。逐项对照过：
  弹窗三块 / 取景读数与状态行 / 剪贴板那张图的名字 / "已取消取景…"那句状态行，中→英→中 全对得上。
* 判据：`ui.test.ts` 分节 (y)（19 条：`setStatus` 的 redo / `setStatusPair` / `relayoutStatus` /
  `refreshCropText` / `renderOriginalBadge` 与 clipboard / `showModal` 渲染函数与重放 / `dismissToasts` /
  **写卡失败也重建视图** / `WriteOutcome.cancelled`）＋ 分节 (x)（`v0.39` 那条）。
  ⚠ 顺带把 `tools/i18n-audit.mjs` 的"已翻译包装"从写死的 `t` 改成集合 `SINKS = {t, setStatusPair}` ——
  否则新糖里的成对文案会被漏翻闸门误报。

★ **`v0.39`：修"切语言时作品那一段文字不同步"**（用户截图：下拉是 `AC2 ⚠ 未验证`，紧挨着的警告却是
`⚠ Unverified: no real emblem sample.`）：

* **根因**：`main.ts::relayoutForLang()` 的"重画名单"里只有作品**下拉框**（`fillGameSelect()`），
  没有它右边那两块 JS 生成的文字 —— 未验证警告（`slotsView.ts::renderGameNote()` → `#game-note`）
  与"盘序列号不能为空"这类解析失败红字（`#game-error`，原来写在 `onGameChanged()` 里）。
* **修法（结构上让它漏不了）**：把那两块文字抽成**唯一产出点** `main.ts::renderGameBlock()`
  （= `renderGameNote()` + `#game-error` 的清理与写入，返回 `GameCtxResult`），
  然后让三条路都调它：`onGameChanged()`（切作品）· `boot()`（开机）· `relayoutForLang()`（切语言）。
  ⚠ 以后往"作品"这一段加文字，写进 `renderGameBlock()` 就自动被三条路覆盖。
* ★ **实测**（真产物 + Edge 154）：选 `AC2`（未验证）与 `custom` + 空序列号（解析失败）两档，
  中→英→中 来回切，dump 出**下拉选项 / 警告 / 报错红字 / 状态行 / 写卡提示 / 卡信息 / 取景提示 /
  缩放核 / 〔展开〕按钮 / 语言标签** —— 每一项都跟着语言走，没有一处"半中半英"。
  例：`AC2 ⚠ 未验证` + `⚠ 未验证：没有真实徽章样本。` ↔ `AC2 ⚠ unverified` + `⚠ Unverified: no real emblem sample.`。
* 判据：`ui.test.ts` 分节 (x) —— ① 源码结构（`renderGameNote` 只被调 1 次 / `renderGameBlock()` 被调 3 次 /
  切语言名单里有它 / 开机那条老写法已消失）；② **假 DOM 跑真函数**（同一个 `renderGameNote()` 在 zh 给中文、
  在 en 给英文、切回来一致、**已验证的作品不显示任何东西**）；③ 产物里中英两句都在。
  ⚠ 假 DOM 必须给 `document.querySelectorAll`（`setLang()` 会顺手跑 `applyStaticI18n()`，不然会炸）。

★ **`v0.38`：取景白框的边长可以精确调**（用户："在图中红方块位置放一个缩放条，用于控制白框取景的大小，
边上再加一个输入框，可以实时看到目前取景框的大小，也可以修改大小"＋"现在的取景框只能用鼠标缩放，精度不够高"）：

* **控件**：取景动作行（`#crop-actions`）**最左边**是 `白框边长 [滑条 #crop-size-range] [输入框 #crop-size-num] 源像素`
  —— 占的就是原来那句提示的位置（提示没删，挪到控件右边；`styles.css` 里它改成 `flex: 0 0 auto` +
  `white-space: nowrap`，挤了就**整句**折行，不再被从中间掰断）。
* **滑条长度 / 按钮右对齐**（用户第二句："把滑条做长一点"＋"确定取景和取消右对齐"）：
  宽度 `clamp(200px, 30vw, 420px)`（1500px 视口 ⇒ 420px、1000px ⇒ 300px）；
  `#btn-crop-ok { margin-left: auto }` 把两个按钮推到行尾（实测各级视口下〔取消〕右边缘与行右边缘**尾距 0**）。
  ⚠⚠ **踩过的坑（务必别改回类选择器）**：浏览器**内置样式表**里有
  `input[type="range"] { width: 130px; vertical-align: middle }`，它的优先级（0,1,1）
  **高于**类选择器 `.crop-size-range`（0,1,0）⇒ 第一稿写完滑条永远是 **130px**（CDP 量到
  `cssWidth: "130px"`，`CSS.getMatchedStylesForNode` 里两条规则的赢家是内置那条）。
  改成 `#crop-size-range`（id，0,1,0,0）之后才吃到我写的宽度。输入框同样写成 id。
  ⚠ 加长之后动作行在宽屏上折成**两行**（上行 = 控件 + 提示，下行 = 读数 + 右对齐的两个按钮）——
  这是"滑条要长 + 按钮贴右"的直接结果，观感是刻意的两行。
* **数学**：两个控件共用 `cropView.ts::setCropWindowSize()` → `cropGeometry.ts::resizeWindowTo()`
  —— 一步设成目标边长，**锚点 = 白框中心**（与滚轮 `zoomWindowAtCenter()` 同一条规则），
  再夹进 `windowBoundsFor()`（下限 = 128 或源图短边、上限 = 源图长边）。步长 **1 源像素**。
* **只动视觉**：与拖动/滚轮一样不写参数、不跑管线（`build.mjs` 的取景冒烟新增 ②b 步钉住"不跑管线"）。
* **输入框的两条规矩**：`input` 事件里只认合法数字（边打边生效）；**聚焦期间不回写**
  （否则敲"1"想输 180 会先被夹成 128 把字吃掉），`change` / `blur` 时才强制把夹取后的真值写回去。
  滚轮 / 拖动改过之后由 `syncSizeControls()`（在 `describeWindow()` 末尾）把两个控件实时同步。
* **读数去掉冗余**：`#crop-readout` 不再写"白框 N×N 源像素"（那一段现在由输入框承担）——
  实测 1470px 视口下重复那一段会把〔取消〕挤到第二行；现在是 `左上角 (x, y) · 倍率 k` + 到最小时的提示。
* ★ **实测**（真产物 + Edge 154 / 源图 580×604，CDP 驱动）：进视图 ⇒ `min=128 / max=604 / value=580`
  （= 默认"填满"短边，输入框也是 580）；滑条 240 / 128 / 604 ⇒ 窗口边长逐个对上、读数与状态行同步；
  手输 `9999` ⇒ 夹到 604 **且框里的字改成 604**；聚焦时敲 `1` ⇒ 窗口夹到 128、框里的字**保持 "1"**；
  滚轮 3 格（300 → 197.25）⇒ 滑条 / 输入框跟到 `197`。**全程 `prepareEmblem` / 面板刷新次数一次都没涨。**
* 判据：`ui.test.ts` 分节 (w)（DOM 顺序 / 步长 1 / 定宽样式 / 锚点 / 不回写 / 它**不是**被删的那三格参数输入）
  ＋ `build.mjs` 冒烟的 ②b（值 / 下限 / 上限 / 不跑管线）。

★ **`v0.37`：8 格改版 + 槽位区的文字全删 + 〔看目录项（调试）〕改成开关**（用户给的版式：
"上面是槽（序号），下面红色的部分显示图片"，并圈掉三处文本）：

* **格子**：`slotsView.ts` 里每张卡只有两个孩子 —— `el('span', {class:'slot-no'})`（"槽 N"）+ `thumbNode()`。
  原来那三行（`目录\文件名` / 字节数与簇号 / 18 段校验状态）与空槽的两行提示**全部删除**，
  `emptySlotHint()` / `plannedDirName()` 随之消失；空槽只剩一个大「＋」（`.thumb-empty`，34px）。
* **CSS**：`.slot` 从"等宽两列 grid"回到**竖排 flex**（`column` + `gap:6px`）；`.thumb-cv` / `.thumb-empty`
  **去掉了 `max-width` 封顶**（图片占满整格）；`.slot-text` / `.slot-name` / `.slot-meta` / `.slot-check`
  四条规则删除（不留死样式）。
  ★ **实测**（真产物 + 真卡 `Mcd001_embdata2.ps2`，CDP 量 `getBoundingClientRect`）：1500px 视口下
  每格 **345×372**、缩略图 **327×327**（0.31 是 162×162）⇒ 图片面积约 4 倍；整页高度 1783px（会滚动）。
  对比过的另一版：8 列一行（每格 169×195、图 151×151、整页 1227px）—— 选了 4 列，因为用户要的是"图更大"。
  ★ **窄屏断点从 2 列改成 4 列**（原来是 0.31 为"左图右文"配的 2 列）：1100px 视口下 2 列会把图撑到
  **496px** 见方、整页 **3457px**；改 4 列后 ⇒ 图 **235px**、整页 1839px（900px ⇒ 图 185px）。
  各级视口实测都不出横向滚动条。
* **8 槽上方那行摘要整句删除**（用户："这2段文本也删除"）：`slotSummaryText()` / `slotSummary()` /
  `compressDirNames()` 三个只服务这行文案的函数**从 `logic/slots.ts` 删除**；状态行里同样的句子也删
  （开卡 / 切作品 / 写卡完成都不打印），开卡成功时 `setStatus('')` 把启动那句提示清掉。
  ⚠ **"被隐藏了什么不许静默"这条性质没丢**：`#slot-note`（取代 `#slot-summary`，默认 `hidden`）只在
  "本作品在卡上没目录 且 卡上有别的作品的目录"时出现一条警告，`noDirForGameText()` 仍然说同一件事
  （它自己那句"见 8 槽摘要行"也一并改掉了）。
* **〔看目录项（调试）〕开关化**（用户："点开以后再点一下没法收回去，这一点要修复"）：模块级
  `dirDebugLines` 记住"日志框里这份是不是目录项" ⇒ 是则再点 `renderLog([])` 收起，否则重新列。
  别的写日志处（写入 / 删除）改走新加的 `showLog()`，它顺手清掉这份记录 ⇒ "先写卡再点看目录项"
  不会变成"收起"。
  ★ **实测**（真产物 + 真卡，CDP 点三次）：点击前 `#write-log.hidden=true` ⇒ 第 1 下 `false`（9 行）
  ⇒ 第 2 下 `true`（0 行）⇒ 第 3 下 `false`（9 行）。
* 判据：`ui.test.ts` 分节 (s)（DOM 顺序 / CSS 竖排 / 无 `max-width` / 死样式已删）与分节 (v)
  （六串被删文案在**源码与产物里**一个不剩 / 摘要函数不存在 / `setStatus('')` / 开关两条分支 / `#slot-note`）。

★ **`v0.32`：删掉两行"复述槽内容"的文本**（用户："我认为这两行的内容也没有作用，直接删除"）：
* ① `main.ts::updateWriteHints()` 里那行 `槽 N → 目录\文件`（后面还挂着 `（覆盖）` / `（新建文件）` 标注）整行删掉；
  ② `main.ts::selectSlot()` 里 `setStatus()` 那行（选中槽的文件名 / 长度 / 簇号；空槽则是"空，写入时自动建文件"）
  连同尾部的 `renderStatus()` 一起删掉 ⇒ 状态行**不再被"选槽"改写**，只报"真发生了变化"的事
  （切作品 / 写卡结果 / 出错）。
* 删得掉的理由：这两行是"复述"，同样的字段在**落盘确认框**与写入日志里都能看到，
  选中与否卡片自己会高亮（`.slot-selected`）⇒ 复述没有信息量。
  （★ `v0.37` 起槽卡片上也不再写这些字段 —— 卡片只剩槽号 + 缩略图。）
* ⚠ **安全信息一个都没少**：`plan.error`（这一槽为什么写不了）、`plan.warning`、缺目录警告、
  "作品常量可从同作品存档取"四条提示**一个字没动**（`ui.test.ts` 分节 (t) 逐条钉住）；
  "会覆盖哪个文件 / 是不是覆盖 / 请先完全退出 PCSX2"在**落盘确认框**里说
  （`logic/writeGuard.ts::confirmWriteMessage()`，SPEC §三 / §八 4）。
* ⚠⚠ **注释也会被打进产物** ⇒ 这两个函数的注释里**不许**写那几串旧文案（`已选槽` / `字节，首簇` /
  `（覆盖）` / `（新建文件）` / 英文那两串），否则分节 (t) 的"产物里一个字不剩"会被自己的注释弄红。
  另一条判据 `plan.target` 用 `maskSource()` 查 —— 它是**代码标识符**，掩码版才查得准（字符串文案查不了）。

★ **`v0.31`：8 格曾改成"左图右文"**（用户："红框放图片，右边白色的才是放其他所有文本的地方，这样可以让图片看起来更大"）：
* 那一版每张卡是 **缩略图 + `.slot-text`** 两个孩子，所有文字在右列。**`v0.37` 把文字整段删掉之后
  这个版式已经没有意义** ⇒ `.slot` 回到竖排、`.slot-text` 等规则删除（见上一条）。
* ⚠ **尺寸纪律仍然有效**：`thumbNode()` **不许**写 inline 宽高（原来写死 96px，inline 会盖掉 CSS
  ⇒ "更大"失效）；图片尺寸全在 `styles.css`：`.thumb-cv` / `.thumb-empty` = `width:100%` + `aspect-ratio:1/1`
  （`v0.37` 起连 `max-width` 封顶也去掉了，图片占满整格）。
* `ui.test.ts` 分节 (s) 钉住：DOM 顺序、`.slot` 竖排、两个 thumb 类都有 `width:100%` + `aspect-ratio`
  且没有 `max-width`、源码里没有 `cv.style.width`。

★ **8 个槽 = 当前所选作品的槽**（这条第一版实现错了，被用户实测抓出来）：
`logic/slots.ts::filterDirsForGame()` 按**盘序列号**过滤（区域前缀不参与），
`buildGameSlotModel()` = 过滤 + 建模型一站式（让"忘了过滤"在类型上不可能发生）；
`SlotModel::excludedDirNames` 记住"被过滤掉的是哪些目录"，供"本作品没目录"那条警告用
（★ `v0.37`：原来还有一行 `slotSummaryText()` 把它们列出来，那行文案已按用户要求删除）。
同类 bug 的另一面也一起修了：`logic/planWrite.ts::planWriteTargetIn()` 把写入计划抽成**纯函数**
（原来隐式依赖真卡、根本没法测），并且 `cardOps.writeSlot()` 加了**防呆自检** ——
目标目录若不属于当前作品就**拒绝写盘**（否则会出现"下拉框写着 NX，却把 LR 的 `data0` 覆盖掉"）。
★ `v0.21`：这两个函数原来叫 `planWriteTargetsIn()` / `writeSlots()`，入参是 `slotIndices: number[]`
（为〔批量写 8 槽〕写的多目标版本）；批量按钮删除后收成单槽，名字也跟着改成单数。

★ **界面只有「手动」一档取景**（`v0.13`，参数行那个四档下拉已删）：`core/image.ts::fitToTarget()`
里**只有 `manual` 会读 `opts.scale/offsetX/offsetY`**。contain/cover/stretch 是核心自己重算一套 ——
以前那个下拉一选就等于"把你的手动取景丢掉"（而且换图时不会自动切回手动：`fillManualToTarget()`
现在会钉一次 `fitMode = 'manual'`）。`FIT_MODE_LABELS` 也跟着删了；核心四档**没动**，
`ui.test.ts` 里"不许 `#fit-mode` 长回来"有断言。手动这一档能覆盖 contain（滚轮往外滚到底）与 cover（默认）。

★★ **取景动作行里有实时读数**（`v0.12`，`#crop-readout`，就在白框正下方）：`白框 128×128 源像素 ·
左上角 (x, y) · 倍率 k`，到最小接 `· ★ 已到最小（1:1…）` 并换 `at-min` 警示色。
⚠ 以前这些只写进 `#status`，而**状态行在页面最下面**（8 槽那一块）⇒ 取景时看不见（用户："状态行在哪"）。
写它的是 `cropView.ts::setReadout()`（每帧一次 `textContent`、不读布局 ⇒ 不影响性能契约）；`#status` 仍照写。

★ **"实时统计"整块已删**（`v0.17`，用户："我认为实时统计这个部分，整个就没什么作用"）：参数行的 `#stats`
（9 行诊断）+ `#compliance-inline`（合规结论）+ `pipeline.ts::renderStats()` 全没了，参数行只剩
**缩放核 / alpha 阈值**。⚠ 核心 `prepareEmblem()` 的 `report` **一个字段没少**（F12 可查
`EmblemToolCore.ui.state.prepared.report`），**合规闸门也没动**（`writeGuard` 拒绝写入 + 写入日志里的
"图像合规（…）"）。副作用（好的）：`refreshImage()` 不再顺带扫整张源图算 `imageStats()`（~99 ms / 次）。

★★ **导入图片后自动进取景模式**（`v0.16`，用户："改为加载图片后默认启动取景模式"）：导入这件事现在只有**一条真路** ——
`main.ts::applyImportedImage(img, name)`（换 source → `fillManualToTarget()` → `recompute()` → `refreshImage()` →
提示 → **`openCropView()`**），`loadImageFromBlob()` 只剩 `decodeImageFile()` 那一步。
⚠ 它同时挂在 `ui.imageImport.applyImportedImage` 上：**打包冒烟第一步**与**截图探针**都走这条真路
（冒烟断言"导入 ⇒ `isCropActive() === true`"且"窗口 = 源图短边 600"），别再在测试里手抄一遍"导入应该做什么"。
⚠ 截图工具的 `--preview` 因此要**手动** `setCropView(false)` 才能拍到"当前图片"那一版。

★★ **0.19 的两处收口**（简化轮，改代码时别把旧写法带回来）：
* `state.ts::setStatus()` **直接写** `#status`（`state.status` 与 DOM 在同一步更新）⇒
  不会再出现"9 处 `setStatus` 只配了 7 处 `renderStatus`"那种状态行不刷新的 bug；
  `renderStatus()` 现在只管 `#busy` 忙提示与"整批重画"时的兜底。
* `main.ts::refreshCardViews(ctx)` 是"重建模型 + 读缩略图 + 重画槽位 + 卡片信息 + 写卡提示"的**唯一**入口
  （0.19 之前这段在 5 处各抄一遍，其中一个分支漏了 `reloadThumbs()` ⇒ 槽名与缩略图可能来自不同目录）。
* `logic/format.ts`：`hex()` / `humanBytes()` 从 `ui/dom.ts` 抽出来（`writeGuard.ts` 原先自己抄了一份 `hex()`）。

★ **版式改动先用无头 Chrome 看一眼**（`v0.9` 起的规矩）：
`node web\tools\screenshot.mjs [--crop|--crop-min|--preview]`，以及
`--card out\evidence\Mcd001_TEST.ps2`（★ 0.20 新增：走真路的 `drop` 打开一张真卡 ——
**只有这一档看得到下半部分那 8 个槽**）
⇒ 产 `web\_shot.png` / `web\_shot_crop.png` / `web\_shot_crop_min.png` / `web\_shot_preview.png` / `web\_shot_card.png`。
DOM 断言与冒烟**测不出"看起来对不对"** —— `v0.9` 靠它抓到 `[hidden]` 被 `.row { display: flex }` 盖掉那个 bug，
`v0.10` 靠 `--preview` 量到"68px 的预览其实是被容器越量越小"（`--preview` 会真的走一遍导入那条路）。
* **零依赖打包器** `web/build.mjs`（**故意不写行数** —— 每轮都在涨，写死了必然过期）：用 Node 24 的 `module.stripTypeScriptTypes` 擦类型，
  自己解析 `import`/`export` 并打成一个**经典内联脚本**（`file://` 下 `<script type="module">` 会被 CORS 拦掉）。
  带**硬自检**：产物必须单文件、无 `type="module"`、无 `import`/`export`、无任何外部引用，
  再加上**逐模块语法校验**、`node:vm` **引导冒烟**、以及**核心层冒烟**（用打进去的 `encodeEmblem` 真造一块并验 18/18）。
  ⚠ 只支持一套**具名导出 / 具名导入**语法子集（含 `import type`），不支持的一律抛错并给出 `文件:行号` + 原文行
  —— 这是刻意的：宁可构建失败，也不要"打包成功但双击白屏"。
* **界面**（原生 TS + DOM，无框架）：顶栏（记忆卡 / 作品 / **版本号**（真值见 `src/ui/logic/version.ts`） / 语言 / 自检条）·
  上区**两列**：左 =「当前图片」（含工具栏：选择/粘贴图片 · 取景 · 预览倍率 · 文件名尺寸），右 = **参数侧栏**（缩放核 / alpha 阈值）·
  其下：**8 个槽位** + 写卡提示 / 状态行 / 写入日志，最下面「PCSX2 自检」一栏。
  （★ 「原图」面板、「游戏预览」、「编辑器挂载点」、右侧工具侧栏 `.pane-tools` **都早就删了** ——
   `web/index.html` 里没有它们，`ui.test.ts` 还断言产物里不许出现 `class="card pane-tools"`。）
  打开卡优先 `showOpenFilePicker({mode:'readwrite'})` 拿句柄（⇒ 可直接覆盖原卡），不支持则退化为"选文件 + 下载"。
* ★ **版本号**：唯一来源 `src/ui/logic/version.ts::APP_VERSION`（**当前值只在那里**，别在文档里抄第二份 —— 一抄就过期）。
  规则（用户定，原文见该文件头部注释）：**每次交付 +0.01；只有用户明确说"可以发布了"才允许进 1.x 正式版**。
  `build.mjs` 从源码读（不写死第二份）、校验格式，并**读产物比对** `data-app-version` 是否与源码一致
  （不一致 = 产物过期 ⇒ `--check` 也会非零退出）。顶栏原来那句"单文件离线版"已换成它。
* ★ **上区布局**（`styles.css` 是唯一真值，别在这里抄列宽）：`.upper` = **2 列**
  `grid-template-columns: minmax(0, 1fr) minmax(190px, 220px)`（左"当前图片"自适应、右参数侧栏 190–220px）；
  断点 **≤1100px 单列上下堆叠**（旧 1400/900/760 三条已作废）。左格里那张 128×128 画布
  `aspect-ratio: 1/1` + `image-rendering: pixelated`（**等比、绝不拉伸**）。
  ★ 拖图进来时**手动取景的初始值按"填满 128×128 框"算好**（`fillScaleFor × manualZoom` = 短边贴框；
  SPEC §五 ② 的"默认进手动"**未变**，只改初值）—— 否则用户只看到中心一小块被放大，会以为"图没进去"。
* ★ 几处**刻意保守**的取舍（都是"宁可拒绝也不写坏"）：
  * **非 LR 新建槽只在已存在的 `E##` 目录里做**（每个槽是整个存档目录，含 `icon.sys`/图标文件；只建目录会写出游戏不认的半成品）。
    LR 目录里允许中间空缺（实机验过 `data0/1/2/7`），所以 LR 可以直接新建 `dataN`。
  * **覆盖已有槽时不原地扩链**：新块装不进目标簇链就**拒绝**并提示"先删掉这个槽再写"。
  * **非 LR 的 9 字节作品常量**：决策链 = 卡上同作品的真实存档 → 已知登记值（只有 SL 日/美 与 NX 日）→ **拒绝写入**。
    即 AC2 / AC2AA / AC3 / NB / 自定义 在"卡上没有该作品真实存档"时**写不进去** —— 这是**有意的**：
    那 9 字节猜错就会写出游戏判 `破損ファイル` 的块（宁可少写）。
    （将来可以加一个高级选项"手动输入 9 字节作品常量（十六进制）"，让知道自己存档的人自己填。）
* ⏳ **三处没有参考实现、只能靠实机确认**（测试覆盖不到）：
  1. `ui/cardOps.ts::deleteSlotFile()` —— 删除槽（清 dirent 为整页 FF + 释放 FAT 簇 + 调整目录项数）；
  2. `M4a` 的"新建 -> 删除 -> 回读"整链；
  3. 扩目录簇那条（已在 `card.ts` 修好形态，实机验证卡 `out\Mcd001_data7test.ps2` 已备好）。

### M4b ✗ 内置像素编辑器 —— **明确不做**（`v0.22` 定案取消）

原计划：右栏 `.pane-tools` 放 128×128 画板（4×/8× + 网格）· 画笔/橡皮/直线/矩形/椭圆/油漆桶/取色 ·
图层 · 对称 · 选区 · 撤销重做 · 调色板面板。

用户 2026-10-06：「我突然觉得我们是不是没有必要做工具这一栏，毕竟其他优秀的图像处理工具有很多」
⇒ 讨论后选「整块删掉」（`index.html` 的 `.pane-tools`、`#palette-grid`、`main.ts::fillPalettePlaceholder()`、
`styles.css` 的 `.tool-chip/.tools-*/.palette-swatch` 全部删除；`ui.test.ts` 有闸门钉住不许长回来）。

**替代流程**（外部编辑器承担"画"）：〔导出 PNG〕（游戏口径，索引 0 = 透明）→ 外部改 → 拖回来 → 取景 → 写卡。
★ **闭环是无损的，有判据**：128×128 的图取景默认值恰好是恒等（倍率 1 / 偏移 0 ⇒ D20 的恒等短路），
≤255 色 ⇒ `quantizeOpaque()` 返回 `exact`；合起来 = `image.test.ts` 的「★ 0.22 闭环」一节
（导出→重导 **逐像素 diff=0**、透明像素数与实色数不变、索引 0 仍只落在透明像素上、再转一圈不漂移）。
完整理由与代价（"凭空画"要自备画图软件）见 `SPEC.md` §六。

### M2 ✅ 图像管线（已完成；UI 直接调 `prepareEmblem`）

要点：
  * **canvas 只负责解码**（任意图 → RGBA），缩放/二值化/减色全是**纯 TS 函数**（可在 Node 里测）。
  * `'auto'` 缩放核（顺序即优先级，**按实际缩放倍率判**）：① 尺寸相同 → 逐像素复制（不采样）；
    ② **缩小**（实际倍率 < 1；等比取景两轴共用一个倍率）且**两轴都是整数倍**（倍率倒数是整数）→ `nearest`，
    否则 → `smooth`；③ 放大/等比 → 不透明色数 ≤256 选 `nearest`，否则 `smooth`。手动 `kernel` 优先。
    ★ **判据必须落在实际倍率上**，不能落在"源尺寸能否整除目标尺寸"上 —— 实测分歧：`100×256 → 128×128`
    的倍率是 `min(1.28, 0.5) = 0.5`（横向其实是放大），两轴都保真，该走 `nearest`；
    按尺寸整除会误判成 `smooth`（这条是 M2 实现时自己抓到并修掉的判据错误）。
    ★ 规则 ② 的"缩小"= **实际倍率 < 1**（不是"某轴尺寸超过目标"）⇒ `128×100 → 128×128` 判"没缩小"，
    落规则 ③ 看色数（更保硬边）。**2026-10-04 已确认，不再变更。**
  * 行为面证据（不是空口）：300→128 的 `nearest` 实测**漏掉 172/300 个源行**，
    同倍率下 `smooth` 的支撑区覆盖 **300/300** ⇒ 规则 ② 的存在理由有数字支撑。
  * `smooth` = **面积平均**（权重非负和为 1 ⇒ 不会凭空造色、不虚增色数），不是 bicubic/LANCZOS。
  * 减色 = **只对不透明像素**的中位切分；**索引 0 固定留给透明**（游戏口径）。
  * ★ 核心判据：**"已是目标尺寸 + ≤255 色 + 无半透明"的图必须逐像素无损**；再加合规/确定性/几何/感知/**对接**（喂 `encodeEmblem` → 18/18 → 读回逐像素一致）。
  * `despeckle`（收边）**默认关**（它删像素，会破坏无损判据）。⚠ `v0.15` 起**界面没有这个开关**了
    （用户要求删掉三格参数），但字段/核心实现/测试都在 —— 要用它得改代码或走核心 API。
  * ⚠ UI 注意：二次处理同一张图时 `rgba` 不变，但 **`palette`/`indices` 的编号顺序会变** ⇒ 别缓存 indices 跨次使用。
