# 简化 / bug 审查 —— 第一步：只清单，不动代码

> ★★ **本清单已经全部执行完毕**（用户 2026-10-05 勾选：A 全删 / B 全合并 / C9 / D 全修 / Python 清理）。
> 逐条结果见 `CHANGELOG.md` 的 **0.19** 一节；本文保留为"当时的现状快照"——
> 下面的体积/测试数/行数都是**改动前**的值，别再拿它当现状。
>
> 目的：把"能简化的地方"和"真 bug"列成**可以逐条勾选**的表，由用户决定做哪些。
> 每条都带 `文件:行`、可删行数、以及"改了会不会掉能力"。
> 状态：`v0.18 / M4-UI-20`，基线全绿 —— `core 2811/2811`、`card 1601/1601`、`image 1059/1059`、`ui 793/793`。
> 方法：我逐文件通读 `web/src/**`（19 个文件，9,237 行）+ `index.html` + `styles.css` + `build.mjs` 关键段；另开四路并行审阅（死代码 / 核心 bug / UI / 构建器与测试），
> 全部结论都做了"读源码 + 全仓 grep 每个符号的读取点"的交叉核对。本文只列，不改。

---

## 0. 家底（数字都是现算的）

| 部分 | 行数 | 字节 | 说明 |
|---|---|---|---|
| `web/src/**`（**会进产物**） | 9,237 | 411 KB | 核心 3 + 界面 16 文件 |
| `web/index.html` + `web/styles.css`（**会进产物**） | 975 | 41 KB | |
| ↳ 其中**纯注释行** | 3,104 行（30.4%） | **218 KB（占源文件 48%）** | 产物**不删注释** ⇒ 原样进 HTML |
| ↳ 其中代码行 | 6,377 行（62.4%） | 237 KB | |
| 产物 `web/dist/emblem-tool.html` | — | **471,171 B（460.1 KiB）** | = 源文件 455 KB + 打包胶水 ~16 KB；**15 个模块 / 337 个导出** |
| `web/build.mjs` | 2,175 | 83 KB | 其中**验证代码 972 行（45%）**：`smokeBoot` 629 + `checkHtml` 103 + `main()` 守卫 166 |
| `web/test/*.test.ts` 四套 | 5,661 | 313 KB | 其中**样板（harness+路径+夹具加载）566 行**；`ui` 2,039 / `image` 1,508 / `core` 1,076 / `card` 1,038 |
| `web/test/make_*.py` 夹具生成器 | 1,675 | 80 KB | 夹具 44 文件 / 1.72 MB |
| `web/tools/` + `probe.html` | 568 | 29 KB | 截图 + 造实机验证卡 + 文件协议探针 |
| `tools/*.py` + `_selftest/*.py` | 3,804 | — | Python 参考实现与证据脚本 |
| 文档 4 份 | — | 77 KB | `README.md` 32 KB / `SPEC.md` 18 KB / `PORT-NOTES.md` 17 KB / `version.ts` 头部 15 KB |

**三件背景事实**：
1. **`web/` 不在任何版本控制里** —— 全树只有 `src/ac-emblem-tool/.git`（vendored 上游 clone，工作树不含 `web/`）。所以 `image.test.ts:6` 那句"本例已随仓库提交"在本树里不成立。
2. **零自动化**：没有 `package.json` / `node_modules` / CI / Makefile / 任何 `.ps1`；四套 node 测试 + 三条 python 命令全靠手打（`SPEC.md §九`、`_selftest/README.md §二`）。**没有任何脚本调用 `build.mjs`。**
3. **注释占一半**：产物 460 KiB 里约 218 KB 是注释（中文注释 3 字节/字符）。

---

## 1. 可以删的（A 类）

### A-1 零风险（无引用、无测试钉住）—— 约 **210 行**

| # | 位置 | 内容 | 行 |
|---|---|---|---|
| A1 | `main.ts:73-74` | `CARD_EXT` / `IMG_ACCEPT`（真值在 `index.html:49,83` + `main.ts:99` 各一份 ⇒ 三处重复） | 2 |
| A2 | `main.ts:17,18,45` | **三个未使用的 import**：`saveKind`、`type FitMode`、`dirNameFor` | 3 |
| A3 | `main.ts:719-722` | `if (n > 0) return; return;` 两分支一模一样 | 2 |
| A4 | `main.ts:747-751` | `collectEntryFiles()` 里 `if (depth === 0 && …) { if (depth > 0) return; }` 内层**永假**（死分支） | 5 |
| A5 | `state.ts:55` + `main.ts:207,214,1114` | `state.game` **3 写 0 读** | 5 |
| A6 | `state.ts:26-27,28-29` + `cardOps.ts:49-57,82,83` | `LoadedCard.mode`（写了不读）；**`sourceSha` + `sha256Hex()`（只写不读，代价是每次开卡多一次 8 MiB 复制 + 整卡 SHA-256）** | 15 |
| A7 | `state.ts:86,103-106` | 过期初始 `status`（boot 立刻覆盖）；`slotThumbAt()` 无引用（注释还是抄错的） | 5 |
| A8 | `cardOps.ts:25` | `import { isLrSave }` 未使用 | 1 |
| A9 | `cardOps.ts:43-47` | `FAT_FREE`/`LR_BLOCK_LEN`/`BLOCK_LEN` 把核心常量又抄一遍（`card.ts:86`、`emblem.ts:69,70`）—— 改成 import | 5 |
| A10 | `cardOps.ts:169-171` | `dirExists()` 无引用 | 3 |
| A11 | `cardOps.ts:210-217,225` | `BlockCheck.isLr`/`.kind` 无人读；`checkBlock` 里 `kind==='container' && bytes.length===LR_BLOCK_LEN` **永不成立** | 3 |
| A12 | `cardOps.ts:350-351` | `const raw = card.readPageRaw(page); void raw;` 空操作 | 2 |
| A13 | `cardOps.ts:392-395` + `planWrite.ts:42-43` | `planWriteTargets` 的 `opts` 注入点：**3 个调用点都不传、也没有任何测试调用它**（注释却说"只为测试留"） | 6 |
| A14 | `cardOps.ts:458` + 4 处写 | `WriteOutcome.decision` 写了 4 次读了 0 次（`lastDecision` 只为喂它） | 6 |
| A15 | `cropView.ts:98,158,390,400` | `CropRefs.viewSource` 存了不读；`cropInfo().pending` 返回了没人读 | 4 |
| A16 | `cropView.ts:141-145` | `need()` 与 `dom.ts:49` 的 `$()` 重复（cropView 已 import dom） | 5 |
| A17 | `slotsView.ts:20,25,28,33-44,149` | 缩略图"先建、插入后再画"的机制（`THUMB_CANVAS`+`dataset.rendered`+`paintThumbs`）只为延迟一次绘制；直接在循环里画 | 15 |
| A18 | `writeGuard.ts:67-71,184-187` | `sameBytes()` 无引用；`bytesEqual()` 的唯一调用者就是它 | 9 |
| A19 | `writeGuard.ts:63-65` | 重复的 `hex()`（`dom.ts:64` 已有） | 3 |
| A20 | `pcsx2Paths.ts:19-27` | `PCSX2_NEEDED` / `PCSX2_TEXT_EXT` 全文（含测试）无引用 | 7 |
| A21 | `games.ts:40-41` | `REGION_PREFIX` 无引用（数据在 `prefixForSerial` 里又硬编一遍） | 2 |
| A22 | `slots.ts:256-267` | `dirNamesForSlots()` 无引用 | 12 |
| A23 | `defaults.ts:207-213` | `PARAM_LIMITS` 里 `previewZoom`/`manualScale`/`despeckleMinNeighbors` 三项 0 读者 | 4 |
| A24 | `core/card.ts:74,82,87,1158-1162,477-490` | 死导出：`PAGES_PER_CLUSTER`、`ECC_BYTES`、`FAT_LAST`、`readCardFromBytes`、`readSparePage`/`writeSparePage` | 25 |
| A25 | `core/emblem.ts:200` | `PALETTE_COLORS` 无引用 | 5 |
| A26 | `core/image.ts:358-362` | `cloneImage()` 无引用 | 5 |
| A27 | `build.mjs:344` | `SIDE_EFFECT_RE` 定义了、全文只出现在自己那一行 | 1 |
| A28 | `build.mjs:764,1926,1949,1951` | `transformModule`/`SCRIPT_PLACEHOLDER`/`VERSION_PLACEHOLDER`/`assemble` 导出但外部无人 import（docstring 说"测试会拿它测不支持语法"—— **那个测试从来没写**，见 C1） | 0（改成不导出） |
| A29 | `main.ts:590-622` | `rememberPcsx2Handle`/`recallPcsx2Handle` 里 9 行 `indexedDB.open` 完全一样 | 8 |
| A30 | `cardOps.ts:640-669` | `downloadCard` 与 `exportPng` 的"Blob→URL→`<a download>`→click→remove→30s revoke"尾巴一模一样 | 10 |
| A31 | `styles.css` | **17 行死样式**：`37 .mono`、`75 .grow`、`91 button.warnbtn`、`107 input[type=checkbox]`、`110 .hint b`（唯一 `.hint` 里没有 `<b>`）、`556/557/569/570 .field-narrow/.field-wide`、`573-581 .stats/.stat-*/.compliance`（0.17 删掉的统计面板残渣） | 17 |

> 另外：`.slot-occupied`、`.crop-canvas`、`.lower`、`.placeholder-title/-body` 是"有 class 没有 CSS 规则"（无害，不用管）。

### A-2 只有测试在用（**删 = 改契约，请单独点头**）

| 符号 | 位置 | 测试钉在哪 |
|---|---|---|
| `applyChecksumsUpstream` | `emblem.ts:656-682`（**27 行，最大的单个死代码**） | ⚠ 连测试都没用（`core.test.ts` 只用 `verifyChecksumsUpstream`）。它和它的 27 行长注释是"上游写法"的**书面留档** ⇒ **要不要留请你定** |
| `screenToSource`/`sourceToScreen` | `cropGeometry.ts:260,267` | `ui.test.ts` 分节 (l4) 逐点比对（:1780-1815）—— 生产里拖动=平移，已经不需要屏幕↔源图换算 |
| `fillWindow` | `cropGeometry.ts:158` | :1750, :1876 |
| `summarizePcsx2` | `pcsx2.ts:364` | :798（顶栏摘要 0.10 已删） |
| `selectPcsx2Files` + `matchPathOf` | `pcsx2Paths.ts:42,85` | :1519-1520；与生产在用的 `classifyPcsx2Input` 是**同一件事的两份实现** |
| `previewOpaque` | `image.ts:1401`（33 行） | `image.test.ts` 用它当"预览不骗人"的判据（UI 实际不用它） |
| `gameForDirName`/`headerTailFromHex`/`slotIndexFromDirName` | `games.ts:243,263,320` | :193-201, :275-276 |
| `card.emblemDirs()`、`buildSlotModel` | `card.ts:724`、`slots.ts:163` | `card.test.ts:326`、`ui.test.ts:289` |

> 合计约 **150 行**，但每条都扛着一条判据。删了要同时决定"这条判据不要了"还是"换个写法"。

### A-3 建议删的**按钮**（功能不缺，只是入口骗人）

| # | 位置 | 说明 |
|---|---|---|
| A32 | `index.html:222` + `main.ts:1002-1014` | 〔新建槽〕点下去只弹"新建槽 ≠ 单独的按钮操作…直接点写入选中槽"（14 行 + 一个按钮位）。写入空槽时**本来就会自动新建文件** |
| A33 | 4 个只有测试引用的 id | `crop-hint:107`、`pane-tools:119`、`pane-params:153`、`pcsx2-bar:247` —— `web/src` 里 0 引用。⚠ `pane-tools`/`pane-params` 是给 M4b 编辑器留的锚点，**可能故意留着** ⇒ 请你定 |

---

## 2. 可以合并 / 去重（B 类）

| # | 内容 | 说明 |
|---|---|---|
| B1 | 两套目录遍历器 | `main.ts:551-572 readTextFilesFromHandle` vs `:734-763 collectEntryFiles`：同样深度 4、同样三个目录名、同样过滤，但**行为不一致**（前者只进 `inis/gamesettings/logs`，后者全遍历）⇒ 合并成一个顺带修掉 |
| B2 | 一条不变式写 5 遍 | "重建模型 + 缩略图 + 槽位 + 提示"在 `main.ts:133-138,:219-222,:209-211,:463-467,:1033-1037` 出现 5 次且**已经开始漂**（错误分支漏了 `reloadThumbs()` ⇒ D3） |
| B3 | `cropView.ts:286,647` | 同一个数字格式化函数写两遍 |
| B4 | `main.ts:848` vs `pcsx2.ts:24` | 界面槽→McdSlot 映射写两遍（`slot===1?0:1` vs `MCD_SLOT_OF`） |
| B5 | `pipeline.ts:137-145` | `recheckFinal()` 再算一遍合规（`prepareEmblem().report.compliance` 已有）；⚠ SPEC §八 2 要求"写前再查一次"⇒ **建议保留**，只去掉恒为 255 的入参 |
| B6 | `state.status` 与 `#status` | 9 处 `setStatus()` 只配了 7 处 `renderStatus()`（漏的 2 处就是 D1）⇒ 把 DOM 写进 `setStatus()`，一处收口 |
| B7 | `cropView.ts:123,250,324` | `frameSide` 与 `frameRectFor(stageBox()).size` 两个来源存同一个数 |
| B8 | `params.manualScale` | 可派生（`= effectiveManualScale(p)`）却还存了一份，3 处写；漏写 `cropView.ts:487` 就会让"收起取景视图"突然要求提交或**静默丢取景** |
| B9 | `slotsView.ts:159-161` + `main.ts:380,416` | 下拉框选中项写两遍（`selected` 属性 + `.value=`），后者在选项缺失时**静默失败** |
| B10 | 常量重复 | `PALETTE_ALPHA_OPAQUE`（`emblem.ts:160` 与 `image.ts:86`，**注释说明是刻意的**、测试钉了相等）；`SLOT_COUNT`/字面量 `8`（4 处）；`LR_FILE_NAMES` vs `` `data${i}` ``（2 处）；`ZOOM_STEP 1.15` 在 build.mjs 与 screenshot.mjs 里各写一遍；`/\/emulog\.(txt\|log)$/` 在 `pcsx2Paths.ts:75,144` 逐字重复 |
| B11 | `UiParams` 12 字段 | 界面真正在改的只有 5 个（`kernel`/`alphaThreshold`/`previewZoom`/`manual*`）；`despeckle`/`despeckleMinNeighbors`/`maxColors`/`fitMode` 恒为常量。⚠ `SPEC §五` 写明这些留给 PS1 ⇒ **取舍点**：建议移进一个 `CORE_DEFAULTS` 常量，`UiParams` 只留界面在改的 |
| B12 | 同一条变更历史写了 **4 遍** | `version.ts` 头部 0.1→0.18（147 行里 **140 行是注释，会进产物**）+ `README.md`（32 KB 逐版本）+ `SPEC.md`（36 处 `v0.x`）+ `PORT-NOTES.md`（25 处）⇒ 建议历史移到 `CHANGELOG.md`，两份设计文档只写"当前契约" |
| B13 | 文档事实已漂 | `PORT-NOTES.md`：`image.test.ts` 995/995（实 1059）、`emblem.ts` 837 行（实 1041）、`build.mjs` 1836 行（实 2175）、`<div id="editor">`（**早就不存在**，现在右栏是 `.pane-tools`）；`SPEC §二` 还写"用 esbuild/Vite 内联"（实际是自写 `build.mjs`）；`docs\03:127` 说 `tools\__pycache__/` "已清理"（实际有 39 KB 的 `.pyc`）；`image.test.ts:6` 说夹具"已随仓库提交"（**本树没有仓库**）|
| B14 | `build.mjs` ↔ `index.html` 的**三条字符串契约** | `<!--BUNDLE-->`、`<link … styles.css>`、`data-app-version="v?"` + `<span class="brand-sub" id="app-version">v?</span>` 的形状 —— 改 HTML 格式就可能构建失败，且只有第三条有测试 |

---

## 3. 测试与构建器（C 类，收益最大但动的是"判据"本身）

| # | 内容 | 数字 | 说明 |
|---|---|---|---|
| **C1** | **打包器的报错路径完全没测** | 8 个 `fail()` 分支 | `transformModule` 是**专门导出给测试**去测"不支持的语法要报错"的（docstring 明说），但 `ui.test.ts:102` 只 import 了 5 个别的符号，**没有任何测试 import 它** ⇒ 那 8 条错误路径一条都没跑过。这是我找到的**最大验证缺口** |
| **C2** | `ui.test.ts` 里**对源码文本做正则**的断言 | **~160 条 / 793**，`readFileSync` 41 次 | 例：断言 `main.ts` 里必须出现 `openCropView()`、`styles.css` 里必须有 `[hidden]{display:none!important}`、`cropView.ts` 里 `getBoundingClientRect()` 必须**恰好 2 次**、**不许出现** `prepareEmblem`。三套核心测试（3,622 行）里 **0 条**这类断言 ⇒ 这是"改一处代码要改三处测试"的主因 |
| **C2 两种走法** | ⓐ 能行为化的改成"跑真函数"；ⓑ 纯文案/结构锚点收敛成**一张"可见文案清单"表** | 预估减 **500~900 行** | ⓑ 的代价：文案改动改那张表（但只有一张） |
| **C3** | 产物级断言占 `ui.test.ts` 的 **514/793（65%）** | 分节 (g) 43 + (h) 19 + (h2) 12 + (j) 225 + (k) 58 + (l) 157 | 而且 (g) 是**直接 import build.mjs 的 `checkHtml`** 再跑一遍（`ui.test.ts:102,825`）⇒ 与构建自检**同一条代码路径，不是独立复核** |
| **C4** | `checkHtml` 9 类断言里 **6 类是重复的** | A2-A6、A8 | 真正只有 build 能看的：① dist 里恰好 1 个 html 且名字对；② `<link`/`<img`/`src="http`/`href="http`/`//cdn` 这 5 个模式；③ 版本号"源码常量 ↔ 产物印出来的字"一致。其余可去（代价：发版前那道闸只剩手跑 `ui.test.ts`） |
| **C5** | `smokeBoot()` | **629 行**（DOM 桩 304 + 载荷 289） | 独有价值：**不用浏览器**就能证明"产物能被解析、15 个模块工厂都能跑完、`EmblemToolCore` 挂上了、核心层打包后仍能造出 18/18 的块"。⚠ 但 `getElementById` 每次返回**新的游离 div**，无 CSS/布局 ⇒ 0.9 那个 `[hidden]` bug 它看不见；`showOpenFilePicker`/`showDirectoryPicker`/`indexedDB` 也没打桩 ⇒ **PCSX2 那条路一次都没跑过** |
| **C6** | `ui.test.ts:869-916` 把 smokeBoot 返回的 16 个字段**又断言一遍** | ~50 行 | 与 smokeBoot 内部断言重复。安全下限：只留 `smokeBoot(html).ok === true`。更彻底：把取景冒烟搬进 `screenshot.mjs` 的真 Chrome（它已经会开无头 Chrome 并注入探针），能顺带覆盖冒烟覆盖不到的 PCSX2/文件路径 |
| **C7** | 四套测试各一份 harness | 样板共 566 行 | `ok/eq/section` + 路径常量 + `sha256` + 夹具加载 各写 4 遍 ⇒ 合成 `web/test/_harness.ts` 可减 **100~140 行**。⚠ `card.test.ts` 的 `eq` 用 `JSON.stringify`（其余用 `String`）⇒ 合并会**悄悄改变 194 条断言的比较语义** |
| **C8** | `maskSource()` 手写 JS 词法扫描器 | **303 行** | 注释里记着它**坏过 5 次**且失败是**静默产坏包**。换成 ~20 行正则的前提是接受一条纪律"注释里不写 import/export/反引号字面量" |
| **C9** | **没有任何自动化** | 0 | 建议加 `web\check.mjs`：一条命令跑 build + 四套测试 + 三条 python 判据（不写逻辑，只串命令）。这是**所有"可删行数"估算的前提风险**：删了什么，没有任何东西会提醒你 |
| **C10** | 3 个夹具生成器 | 1,675 行 | `make_card_fixtures.py` 里 ~320 行是**卡层的第三份拷贝**（`Card`/`Writable`：`core/card.ts` 一份、`AC3_CN` 的 `61_mc_survey.py` 一份、它一份）—— 这是**故意的交叉验证**，删了会变成"用被测实现生成期望值"的同义反复 ⇒ **建议保留** |
| **C11** | **几条"自证"断言（给了假信心）** | 4 处 | `card.test.ts:348` `eq(x, x)`；`card.test.ts:953` `eq(0xffffffff, 0xffffffff)`（常量都没 import）；`card.test.ts:309-310` 死三元 `mc.ifc0 === 8 ? 32 : 32`；`image.test.ts:1108-1111` 的**提示文案声称做了跨语言比对，实际没有**。这几条永远不会红，但看起来像覆盖 |

---

## 4. 真 bug（D 类，都可以独立修）

| # | 严重度 | 位置 | 现象 / 机制 |
|---|---|---|---|
| **D1** | ★ 低（人人可见） | `main.ts:105`、`:675` | **状态行不刷新**：这两处 `setStatus('已取消…')` 后没有 `renderStatus()`，`#status` 永远停在上一条文字（其余 7 处都配对）。2 行 |
| **D2** | ★★ 中 | `cardOps.ts:92-97` + `main.ts:117,124,915` | **开卡失败后界面还在描述那张卡**：`state.card=null` 返回 `{ok:false}`，三个调用方都只在成功时刷新 ⇒ `#card-info`、8 槽、`#write-hint` 仍显示**上一张卡**，而任何操作都回你"还没有打开记忆卡" |
| **D3** | ★★ 中 | `main.ts:205-212` vs `:218-231` | **切作品失败时漏刷缩略图**：错误分支没有 `reloadThumbs()`/`renderCardInfo()`（成功分支有）⇒ 模型是"不过滤"的、缩略图还是上一次过滤的 ⇒ 可能出现"槽名是 A 目录、缩略图与 18/18 来自 B 目录" |
| **D4** | ★★ 中 | `cardOps.ts:441-452,560` | **写入后 ECC 自检只查首簇**：只覆盖 1 簇 = 2 页；LR 块 17,440 B ÷ 1024 = **18 簇 = 36 页** ⇒ 实际只验 **2/36**。对照：`web/tools/make_data7_test.ts:103` 用的是**全部簇**。修法：把 `touched`（所有改动页）喂进去 |
| **D5** | ★★ 中（**判据静默缩水**） | `web/test/make_fixtures.py:46,238-240` + `core.test.ts:1030-1048` | 夹具生成器把**项目外的绝对路径**（`E:\…\AC3_CN\tools\30-存档\61_mc_survey.py`）当依赖；文件不在时只 `[警告]` 一句，就把 `manifest.json` 从 **44 个样本改写成 11 个**并 **`exit 0`**；而 `core.test.ts` 只按 manifest 循环、**不校验样本数下界** ⇒ 重跑一次生成器就能让核心测试少测 33 个样本还全绿 |
| **D6** | ★ 低（**静默跳过的自检**） | `build.mjs:1631-1642` | 构建冒烟里"用真夹具验 `saveKind`/`verifyChecksums`"被 `if (existsSync(fixture))` 包着，缺夹具**不报错不提示**（整段没有 `else`） |
| **D7** | ★★ 中 | `fixtures/images/image-manifest.json` + `image.test.ts:375-384` | 图像夹具里 `reference.*` 是 Pillow（LANCZOS + MEDIANCUT）算的，测试**硬断言**它 ⇒ Pillow 一升级就红得莫名其妙（8 个 `.rgba` 一个字节没变）。修法：记下 Pillow 版本并核对，或改成统计口径 |
| **D8** | ★★ 中 | `main.ts:63-71` | **写入过程中可以换图**：`setBusy` 只禁用 5 个按钮，`btn-image-open`/`btn-crop` 仍可点；`writeSlots` 在 `await createWritable()/write()/close()/getFile()` 期间挂起 ⇒ 中途导入新图会让预览显示新图、日志却报告旧图写成功。（重复写入**已被挡住** —— `state.busy` 在第一个 `await` 前就置位） |
| **D9** | ★ 低 | `cardOps.ts:335-344` | `deleteSlotFile()` **先释放 FAT** 再检查槽号越界；越界时返回 `{ok:false}`，但内存里的 FAT 已经改过 ⇒ "失败"是半成功 |
| **D10** | ★ 低 | `cardOps.ts:535` | `encodeEmblem(prepared.rgba, …)` 写在**逐槽循环里** ⇒ 8 槽把同一张图编码 8 遍（纯函数，提到循环外即可） |
| **D11** | ★ 低 | `main.ts:121-128` | 走到 `openCardViaInput()` 的唯一原因是 `showOpenFilePicker` 不可用/被拒，提示却让用户"用顶栏的『选择记忆卡（可覆盖保存）』"—— 正是刚失败的那个按钮 |
| **D12** | ★ 低 | `main.ts:516-519,579-582` | **自检结论会过期**：读到 0 个文件时不更新 `pcsx2Files`/`pcsx2Route` ⇒ 面板仍显示上一次的表格，而"本次来源"说的是新选的目录 |
| **D13** | ★ 低 | `cropView.ts:639-643` | `confirmCrop` 失败时开头写死"白框里看不到任何内容"，但失败也可能是"还有半透明像素"或尺寸不符 |
| **D14** | ★ 低 | `slotsView.ts:124-127` | 槽位卡片上按**空格**会选中槽 + **顺便滚动页面**（没 `preventDefault()`） |
| **D15** | ★ 低 | `cropView.ts:319-327` | 同一帧里既滚轮又拖动时，先应用缩放、再用**新的** `win.size` 换算拖动位移 ⇒ 平移量偏差（一帧内、量很小） |
| **D16** | ★ 低 | `cardOps.ts:415-439` | 覆盖已有文件时只写 `need` 簇并**截断 FAT 链**，却**从不更新 dirent 的 `length`**：新块比旧文件短时目录里记的长度偏大（当前两种布局都是定长 ⇒ 撞不上，属隐患） |
| **D17** | ★ 低 | `card.ts:1032` | 扩目录簇时 `slot = dirChain.length * this.ppc` 隐含"ppc 恒为 2"（真卡确实如此），注释没写这条前提 |

### D 类（续）· 深审核心层后又确认的 8 条（全部在**没有测试覆盖的路径**上；我已逐条跑代码复现）

| # | 严重度 | 位置 | 现象 / 机制（**我实测复现过**） |
|---|---|---|---|
| **D18** | ★★★ 核心 API 可**静默毁掉超块** | `card.ts:199-203,399-403,447-463,507,531` | `sysRead()` 读不到时返回**短/空**缓冲，`u32le()` 越界读 `undefined` 被 `\|` 强转成 **0** ⇒ 超块 `ifc[0] = 0xFFFFFFFF` 的卡**构造不报错**、`ind[]` 全是 0。`readFat`/`writeFat` 只挡 `undefined`/`0xFFFFFFFF`，**`fc === 0` 被当成合法** ⇒ `p0 = sysPage(0,0) = 0`（超块自己）而唯一的边界检查 `p0+1 >= npages` 恰好通过。**实测**：`writeFat(0,…)` 不抛异常，页 0 前 4 字节变成 `ff ff ff ff`（"Sony" 魔数被毁，之后 `new Card()` 直接报"不是 PS2 记忆卡"）；`readFat(0)` 返回 `0x796e6f53`（把 "Sony" 当 FAT 值）。Python 参考实现在 `Card.__init__` 里就 `struct.error` 抛掉 ⇒ 这是 **JS 侧独有的"静默降级成破坏性写入"**。⚠ **对当前界面的影响有限**：`findInRoot` 在垃圾 FAT 上返回 null ⇒ `createFileInDir` 会先报"根目录里没有目录 X"，写路径被挡住。但 `writeFat` 是公开 API，且修复很便宜（校验 `fc`、让 `sysRead` 抛而不是静默返回短缓冲） |
| **D19** | ★★ 中 | `card.ts:399-403,592-597` | `readFile()` 对"在 `clusters` 之内、但在卡镜像之外"的簇返回**全 0**：`readPageRaw` 无边界检查（越界返回空数组），而 `readFile` 仍然 `got += PAGE_SIZE` ⇒ 尾巴留 0。**实测**：8 MB 卡 `readFile(8155,1024)` → **1024 个零字节**；同一簇 Python 参考返回 **0 字节**。可用的最后相对簇是 8150，但 `chain()` 只挡 `cl < 8192`。**界面里可达**：`cardOps.ts:194,260` 对每个槽 `new Uint8Array(card.readFile(e.cluster, e.length))` ⇒ 坏卡会得到"一张全透明缩略图"而不是报错。**且与自己的文档矛盾**（`card.ts:579-583`："链比 n 短时返回的就是实际能读到的长度（**不补零**）—— 保持原版行为"）|
| **D20** | ★★ 中（核心契约） | `image.ts:850-860` | **"源尺寸 == 目标尺寸 ⇒ 逐像素复制"的短路无视 `manual` 的 `scale`/`offsetX/Y`**。注释说"尺寸相同 ⇒ scale=1、没有越界，所以各种取景模式在这里都等价" —— 对 `manual` 是错的（那两个值由调用方给）。**实测**：`prepareEmblem(128×128, {mode:'manual', scale:4, offsetX:-192, offsetY:-192})` 的结果与输入**逐字节相同**、`backgroundPixels=0`；返回的 `transform` 却写着 scale:4/offset:-192 ⇒ `mapTargetToSource` 的自述（"Math.round(结果) 就是被采样的源像素下标"）也不成立。⚠ **我另外核过一条、把它降级**：通过**当前界面**的取景视图**走不到**这个 bug —— 源图恰好 128×128 时 `windowBoundsFor(128,128,128) = {min:128,max:128}`，`clampWindow` 把窗口钉死在 `{size:128,x:0,y:0}`（实测），所以 manual 参数永远是 scale=1/offset=0。⇒ 属"核心 API 契约 bug"，今天用户看不见；一旦放开取景下限、或将来 PS1 的 64 目标尺寸配 64×64 源图，它就会变成"拖了白框但输出不变" |
| **D21** | ★ 低（报告说谎） | `image.ts:1286-1291` | `despeckleRemoved` 算的是"**二值化**变透明的像素"，不是"去杂边删掉的像素"，而紧邻的注释恰好写着"半透明像素…**不能算成**被去杂边删掉"。**实测**：全图 `alpha=100`（阈值 128）+ `despeckle:true` ⇒ `despeckleRemoved = 16384`，而该图不透明像素是 **0**（去杂边什么都没删）。字段文档也写着"未开启 = 0"。界面 0.15 起没有收边入口 ⇒ 只有读 F12 report 的人会被误导 |
| **D22** | ★★ 中（**前提写错了**） | `emblem.ts:510-516,615-617,801-803,853` | **`ensureWritable` 的存在前提是错的**：Python 的 `bytearray` **只有切片赋值**才扩容，**单下标越界赋值抛 `IndexError`**（我实测 Python 3.12：`bytearray(4)[0x4434]=1` → `IndexError: bytearray index out of range`；而 `c[0x4432:0x4434]=b"\x01\x00"` → 扩容到 6）。可代码里两处注释都写着"Python 对越界赋值会静默扩容 bytearray" —— **事实相反**。后果矩阵（全零缓冲，我实测）：`0x443F` → Python 正确补成 17472 且 18/18，而 TS `injectImage` **不报错**、校验 **18 段全不过**（因为 `:853` 丢掉了 `applyChecksums` 的返回值）；`0x441F` → Python 抛 `IndexError`，TS 照样不报错；**0 字节** → Python 抛，TS 的 `applyChecksums` 会**凭空造出一个看起来合法的 17472 字节空白块**。⇒ 除了改代码，那两条注释也要一起纠正 |
| **D23** | ★ 低 | `image.ts:137-138,861-866`；`image.ts:207-208,1382` | 两处 report 字段与文档不符：① `backgroundPixels` 在 `stretch` 两条分支被**硬写成 0**（实测：整幅等于背景色的图 stretch 后 16 个像素等于背景，却报 0）；② `sourceOpaqueColors` 文档说是"`'auto'` 判核的输入"，实际输入是**二值化之后**的色数（实测：1 个不透明色 + 300 个 `alpha=200` 的色 ⇒ 报 1，而判核用的是 257 ⇒ `kernel='smooth'`）。**结论对不对、字段含义不对** |
| **D24** | ★★★（**文档承诺的"复制"在 Node 路径上是假的**） | `card.ts:1143-1156,399-409` + `emblem.ts:943-953` | **`Buffer.prototype.slice` 返回的是视图、不是副本**（与 `Uint8Array.prototype.slice` 相反），而 `card.ts:1143-1152` 的文档恰恰**推荐** Node 调用方传 `fs.readFileSync()` 的 Buffer，并承诺"会先复制一份…写坏也只坏在内存副本上，**源文件/源字节不受影响**"。**实测**：`readCardFromBuffer(readFileSync(卡))`（`copy` 默认 true）之后 `writePageRaw(0, 0x5a…)` **把调用方 Buffer 的前 8 字节改写掉了**（`536f6e7920505332` → `5a5a5a5a5a5a5a5a`），而同样操作传 `Uint8Array` 则调用方毫发无伤（测试里唯一走过的形状）。同源的还有：`readPageRaw`/`readSpareRaw`（注释写"（副本）"，Buffer 底时是视图 —— 实测 `page[0]=0xAB` 直接改到卡镜像）、`headerTailFromSave`/`lrHeaderFromSave`（注释写"slice = 拷贝（**不是视图**）" —— 实测改返回值会改到源字节）。⚠ 当前界面**不受影响**（浏览器给的是 `Uint8Array`，`make_data7_test.ts` 也显式包了 `new Uint8Array(...)`），但这是**文档推荐入口**上的承诺失效，修法也简单（`Uint8Array.from(buf)` 之类显式复制） |
| **D25** | ★ 低 | `emblem.ts:913,862-878` | 两处"域外参数静默降级"：① `makeBlankSave(false, 1.5)` 不报错，`new Uint8Array(baseOffset+size)` 把小数截断 ⇒ 得到 17473 字节、`saveKind` 变成 **`'container'`**（实测；Python 抛 `TypeError`）；② `injectPixelsToIndices` 遇到"256 个不透明色"时把**索引 256 回绕成 0**（实测：调色板 257 项、64 个**并不透明**的像素被写成索引 0 ⇒ 静默变成透明洞；Python 抛 `ValueError`） |

> **我排除的"看着像 bug、其实不是"（别改）**：`findOffset()` 的子序列搜索、`findPaletteOffset()` 的 C++ 优先级怪癖、`injectImage(strict=false)` 的静默截断、`unscramblePalette` 自逆、ECC 的 `(~i) & 0x7F`、末段校验的真实位置、`clampWindow` 的"框里不空"、`injectImage` 的 255/256/257 阈值顺序、`chain()` 的环检测与终止性（造了 3000 簇长链 / 100 簇环 / 自环都正常停）、`dirents(root, 0xFFFFFFFF)` 与 `readFile(cl, 0xFFFFFFFF)` 的**内存上界**（被 `chain()` 的 `cl < clusters` 兜住，实测 14 项 / 1 ms，**不会** OOM）、`createFileInDir` 的簇分配不冲突、`extractImage` 两种布局的索引语义、`applyChecksums` 的 trailer/`ensureWritable` 语义、`quantizeOpaque` 在 254/255/256/257/300 色下的行为、`guard()` 里那些带注释的 `catch {}`。
> 格式层（`emblem.ts`）的移植纪律我逐行复核过（Python 参考实现 + 10 份真实存档逐字节复原那条判据）—— **字节级没有发现问题**；上面 D18/D19 在**卡层**、D20~D23 在**图像层**。

### D 类补充 · FRAGILE（今天不错，但一碰就坏；审阅者给了确切的触发输入）

| 位置 | 隐患 |
|---|---|
| `card.ts:399-409` | `readPageRaw`/`readSpareRaw` **无边界检查** —— D18/D19 的总根因。`readSpareRaw(99999)` 返回空数组，于是 `eccOk()` 只会说"ECC 不对"，看不出是越界 |
| `card.ts:199-214` | `u32le`/`u16le` 越界读返回 **0**（`undefined \| x`）；Python 是 `struct.error`。任何新解析的字段都会继承 D18 的失败模式 |
| `card.ts:166-179` | `calcEcc(buf128, offset)` 若给少于 `offset+128` 字节，`CPM[undefined]` 让 `col ^= undefined` **静默无效**（等于对隐式零尾算 ECC）。今天不可达（`writePageRaw` 校验 512），但离"一个短缓冲"只差一步 |
| `card.ts:501-508,559-576` | `chain`/`readFat` 接受**负数与小数**簇号：`chain(-1) === [-1]`、`dataPage(-1,0) === 80`（一个真实无关页）、`readFat(1.5)` 算出错位的 FAT 项。文件数据里到不了（簇号都来自 `u32le`），但公开 API 能到 |
| `card.ts:778-795` | `allocateClusters(n)` 只受 `cur >= allocEnd - 4` 约束，构造时**不校验超块字段** ⇒ `allocEnd = 0xFFFFFFFF` + 大 `n` 会要 ~4.29e9 个条目（OOM/卡死）。`createFileInDir` 用文件长度兜住了，直接调 API 就能踩 |
| `card.ts:1159-1162` | `readCardFromBytes()` **不复制**（与 `readCardFromBuffer` 相反），且没有任何警告 —— 正是旁边那段注释警告的坑（写穿调用方的缓冲） |
| `card.ts:256-262` | `encodeName()` 静默截断到 31 字符、非 ASCII 走 `& 0xff`（Python 的 `name.encode('ascii')` 会抛）⇒ 非 ASCII 文件名会**静默变成乱名**写上卡 |
| `card.ts:601-615` | `writeFileIntoClusters()` 对"比簇链更长"的数据**静默截断**（文档只提了补零） |
| `card.ts:901-915` | `makeDirent()` 测试从没跑到（`createFileInDir:1043-1045` 的兜底分支在测试里是死的）；它写 `parent = 1`、时间戳留 `0xFF` |
| `card.ts:451,591-596,644-649` | `sysRead` 有个**没写进注释的** 512 簇硬上限；且本移植**读完整条链**，而 Python 一到长度就 break —— 结果对正常卡一致，但这正是 D19"补零 vs 短长度"产生差异的原因，还多读了页 |
| `emblem.ts:886-889` | `makeBlankSave(isLr=true, baseOffset>0)` 的参数文档是错的（那段"把 12 字节魔数写在块起点"只对非 LR 成立）：`baseOffset=8` 时总长 ≤ 0x4440 ⇒ `isLrSave` 为假、`base=0`，会得到"块头是 LR、校验布局却是非 LR"的畸形块（实测 `verifyChecksums` 不过）；`baseOffset=0x120` 直接抛。Python 行为相同 ⇒ **移植忠实但文档错**，且没有注释警告"LR + baseOffset 不可用" |
| `image.ts:207-208,137-138,850-855,1286-1288` | 4 处注释与代码不符（就是 D20/D21/D23 那几条，改代码时顺手改注释） |
| `card.ts:579-583` | 注释承诺"不补零"，代码补零（= D19） |

---

## 5. 不建议动（E 类）

| 项 | 理由 |
|---|---|
| `core/emblem.ts` / `card.ts` / `image.ts` 的长注释（约 1,365 行） | 里面是**字节级坑**的定案依据（末段差一字节、`& 0x7F`、mode 位语义、257 色重叠…）。删了就是丢掉"为什么这么写" |
| **Python 判据链**：`acet_format.py`(861) + `prepare_image.py`(197) + `web/test/make_*.py`(1,675) + `validate_writer.py`(120) + `selftest.py`(294) | TS 的**独立判据**（"写入器作用在 10 份真实存档上必须逐字节复原"、"与官方 `acet.exe` 25/25"）。`selftest.py` 还是**唯一**与上游官方二进制挂钩的一环（它 4 小时前还跑过） |
| `dist\v0.0`…`v1.0.2`（21.5 MB）、`testdata/`、`out/evidence/*.ps2` | 上游产物与我方证据卡；`dist\v1.0.2\acet.exe` 正是 `selftest.py` 的默认对照物 |
| `pipelineStats()` 计数、`cropView` 的 rAF 合帧与那几个导出 | 性能契约（"拖动期间不跑管线"）唯一可量化的判据 |
| `FAT_END`/`FAT_FREE`/`FAT_MASK` 三个同名值、`MAX_COLORS` vs `MAX_OPAQUE_COLORS`、测试里手抄的字面量 | `card.ts:85-88` 与 `image.ts:77-79` 都注明了"三个值含义不同"；测试里的重复**就是**交叉判据 |

---

## 6. Python 侧（单独列，你可能想清理）

**可以删的（能力已在 TS 里且无任何消费者）——约 2,275 行：**

| 文件 | 行 | 为什么可删 |
|---|---|---|
| `tools/acet_cli.py` | 222 | Pillow 命令行，已被网页版 + 上游 `acet.exe` 取代；**无脚本调用** |
| `tools/check_pcsx2_slots.py` | 325 | 已 1:1 移植到 `pcsx2.ts`（其 docstring 自称"逐条照抄"） |
| `_selftest/tidy_layout.py` | 222 | 项目清理（**TS 侧无等价物**） |
| `_selftest/check_links.py` | 58 | 文档死链自检（**TS 侧无等价物**） |
| `_selftest/dump_dir_slots.py` | 104 | **除了自己没人引用**，连 `_selftest/README.md` 的清单里都没有 |
| `_selftest/check_dirent_bits.py` | 112 | mode 位分析，结论已固化进 `card.ts` 常量 |
| `_selftest/audit_slot_map.py` | 108 | 卡层能力已在 `card.ts`/`cardOps.ts` |
| `_selftest/scan_all_cards.py` | 101 | 同上（**但它生成的 `testdata/real/*` 是活输入**） |
| `_selftest/dump_card_emblems.py` | 111 | 同上（`card.ts` 的注释把它当**规格出处**引用） |
| `_selftest/write_{data2_inverted,final_test,lrtest2,all_test}.py` | 912 | ⚠ **它们是 `out/evidence/*.ps2` 那 4 张证据卡的生成器，而那是 `card.test.ts` 与构建冒烟的活输入** ⇒ 删了不是"坏掉"而是"再也造不出来"（卡本身必须冻结保留） |

**必须留的**：`acet_format.py`、`prepare_image.py`、`web/test/make_*.py`、`validate_writer.py`、`selftest.py` —— 交叉验证的全部依据。
另外：`tools/__pycache__/acet_format.cpython-312.pyc`（39 KB）确实在，而 `docs\03:127` 说它"已清理" ⇒ 顺手清掉或改文档。

---

## 7. 请你决定

| 组 | 内容 | 预估可减 | 我的建议 |
|---|---|---|---|
| **A-1** | 31 条零风险死代码（含 17 行 CSS） | **~210 行** | **建议一次全做**（零行为变化） |
| **A-2** | 只有测试在用的导出 | ~150 行 + 改测试 | 逐条点名；`selectPcsx2Files`/`matchPathOf`（纯重复）建议做；`applyChecksumsUpstream` 27 行**要你定** |
| **A-3** | 删〔新建槽〕按钮 + 4 个空 id | ~15 行 | 按钮建议删；4 个 id 请你定（M4b 锚点） |
| **B** | B1-B10/B14 是纯去重或结构（~80 行）；B11/B12/B13 是**取舍** | 80~200 行 + 文档 | 建议先做 B1~B6 + B13（文档对齐） |
| **C** | C1（补 8 条报错路径测试）最重要；C2/C3/C6/C11 次之；C9（一键检查）最省心 | **1,000~1,800 行** | **建议 C9 + C1 + C11 先做**，再挑 C2 的ⓑ |
| **D** | **25 条真 bug**（D1~D25） | 净增 ~65 行 | 建议按这个顺序：**D24**（3 行显式复制，把"源字节不受影响"这条承诺变成真的）→ **D18/D19**（核心 API 静默破坏/静默读 0，加边界检查）→ **D1/D2/D3/D4/D8**（用户能撞到的静默出错）→ **D5/D6/D7**（判据完整性）→ **D20**（契约，改短路 + 改注释）→ **D22**（改代码 + 纠正那两条写错的注释）→ 其余（报告字段/文案，顺手） |
| **Python** | §6 里那 10 个脚本 | ~2,275 行 | 建议先只删 `acet_cli.py` + `check_pcsx2_slots.py` + `dump_dir_slots.py`（有 TS 等价、无人调用），`write_*.py` 建议保留 |

粒度随你：说"做 A-1 + D 全部"就行，也可以逐条点名（例如"只做 A6、A32、D1、D4、D18、C9"）。
**我的一句话建议**：`A-1 + A-3(按钮) + D1~D4 + D8 + D18 + D19 + C9`（低风险，且把"静默出错"的面积一次收掉），文档合并（B12/B13）与 C1/C2 的测试改造另开两轮。

> 说明：D18~D25 与那张 FRAGILE 表来自"核心层逐行深审"那一路（它另外跑了 **1136 次 Python↔Node 差分**：43 份真实/夹具徽章块走完"定位→校验→重算→提取×3→调色板→块头"全路径 **43/43 完全一致** ⇒ 格式层在**合法输入**上没有问题，剩下的发现全部需要**畸形输入或域外参数**，只有 D20 与 D24 是正常用法能碰到的）；
> 其中每一条我都自己跑代码复现过（临时脚本都在 `%TEMP%`，项目文件一个字节没动）。D20 的"是否影响用户"我做了额外核对，结论是**当前界面走不到**，所以按"核心契约 bug"而不是"用户可见 bug"归档。
