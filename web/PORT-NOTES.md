# 移植笔记：Python 参考实现 → TypeScript 核心

> 记录 `web/src/core/` 与 `../tools/acet_format.py`、`AC3_CN\tools\30-存档\` 的对应关系、
> **验证判据**、以及移植中发现的**语义歧义**。做 UI 之前先读这一份。
>
> ★ **逐版本变更史在 `CHANGELOG.md`**（唯一来源）；本文只写"当前契约"与移植纪律。
> ★ **一条命令跑完全部判据**：`node web\check.mjs`（打包 + 四套 node 测试 + 三条 python 判据）。

## 一、当前状态（2026-10-04 建立，2026-10-06 对齐 0.26）

| 模块 | 文件 | 状态 | 判据（可复跑） |
|---|---|---|---|
| 格式核心 | `src/core/emblem.ts`（1,064 行） | ✅ | `node web\test\core.test.ts` → **通过 2821 / 2821** |
| 记忆卡层 | `src/core/card.ts`（1,275 行） | ✅ | `node web\test\card.test.ts` → **通过 1619 / 1619** |
| 图像管线 | `src/core/image.ts`（1,412 行） | ✅ | `node web\test\image.test.ts` → **通过 1028 / 1028** |

夹具由 **Python 参考实现**生成（它是"真值"来源），TS 必须逐字节吻合：

```powershell
python web\test\make_fixtures.py        # → web\test\fixtures\manifest.json（44 个样本）
python web\test\make_card_fixtures.py   # → web\test\fixtures\card-manifest.json
python web\test\make_image_fixtures.py  # → web\test\fixtures\images\（8 张裸 RGBA 输入图）
node   web\test\core.test.ts            # 2821/2821
node   web\test\card.test.ts            # 1619/1619
node   web\test\image.test.ts           # 1028/1028
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
node web\build.mjs           # → web\dist\emblem-tool.html（480.7 KiB / 492,228 字节，双击 file:// 即用）
node web\test\ui.test.ts     # 854/854
```

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

★ **8 个槽 = 当前所选作品的槽**（这条第一版实现错了，被用户实测抓出来）：
`logic/slots.ts::filterDirsForGame()` 按**盘序列号**过滤（区域前缀不参与），
`buildGameSlotModel()` = 过滤 + 建模型一站式（让"忘了过滤"在类型上不可能发生）；
摘要行由 `slotSummaryText()` 统一产出，必须写明"卡上还有其它作品：…（切作品查看）"。
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
* **零依赖打包器** `web/build.mjs`（1836 行）：用 Node 24 的 `module.stripTypeScriptTypes` 擦类型，
  自己解析 `import`/`export` 并打成一个**经典内联脚本**（`file://` 下 `<script type="module">` 会被 CORS 拦掉）。
  带**硬自检**：产物必须单文件、无 `type="module"`、无 `import`/`export`、无任何外部引用，
  再加上**逐模块语法校验**、`node:vm` **引导冒烟**、以及**核心层冒烟**（用打进去的 `encodeEmblem` 真造一块并验 18/18）。
  ⚠ 只支持一套**具名导出 / 具名导入**语法子集（含 `import type`），不支持的一律抛错并给出 `文件:行号` + 原文行
  —— 这是刻意的：宁可构建失败，也不要"打包成功但双击白屏"。
* **界面**（原生 TS + DOM，无框架）：顶栏（记忆卡 / 作品 / **版本号 `v0.1`** / 自检条）· 上：原图 | 游戏预览(索引0口径) | 编辑器挂载点 · 下：**8 个槽位**。
  打开卡优先 `showOpenFilePicker({mode:'readwrite'})` 拿句柄（⇒ 可直接覆盖原卡），不支持则退化为"选文件 + 下载"。
* ★ **版本号**：唯一来源 `src/ui/logic/version.ts::APP_VERSION`（现 `0.1` ⇒ 界面显示 `v0.1`）。
  规则（用户定）：**每次交付 +0.1；只有用户明确说"可以发布了"才允许进 1.x 正式版**。
  `build.mjs` 从源码读（不写死第二份）并硬校验 `^0\.\d+$`。顶栏原来那句"单文件离线版"已换成它。
* ★ **上区布局**（曾把"原图"挤成一条缝，被用户实测报出）：`repeat(3, minmax(220px,1fr)) + minmax(260px,320px)`；
  ≤1400px 折两列、≤900px 单列；原图 canvas 用 `object-fit: contain` 等价写法（**等比、绝不拉伸**）；
  128×128 画布 `aspect-ratio: 1/1` + `image-rendering: pixelated`。
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
