# 变更历史（逐版本）

> 这个文件是**唯一**的逐版本变更史（0.1 → 现在）。它**不进产物**：用户拿到的单文件 HTML 里
> 只有 `src/ui/logic/version.ts` 那几十行（版本号 + 规则）。
> 0.19 之前那些版本的历史原本写在 `version.ts` 的注释里 —— 打包器不删注释，
> 于是每个用户都在 460 KiB 的产物里白背了 ~15 KB 的历史。

版本号规则（用户 2026-10-05 定）：从 **0.1** 起每次交付 **+0.1**；
**只有用户明确说"可以发布了"才允许进 `1.x`**。开发标记 `M4-UI-N` 另算（每次界面改动 +1）。

---

## 0.26（M4-UI-28）· 开机告知 + 取景拦截 +〔另存为…〕（2026-10-06）

用户三条（原话）：
① "写入选中槽之前要确认用户是否在取景模式，需要弹窗告诉用户手动确认取景才能继续"；
② "整个网页打开的时候，要弹窗告诉用户，该项目未经过测试，请用户自行备份记忆卡"；
③ "导出整卡改成另存为，效果就是另存一张记忆卡"。

**A 类（新增）· 一个"必须点掉才能继续"的弹窗**
* `dom.ts::showModal({title, body, ok})` + 静态结构放 `index.html`（`#modal-host` / `#modal-title` /
  `#modal-body` / `#modal-ok`）+ `styles.css` 的整页遮罩（`position: fixed` ⇒ 点掉之前下面的界面点不到）。
  为什么不直接用 `window.alert()`：样式不可控、连续弹会被浏览器"阻止此页面创建更多对话框"静默吞掉
  （那就等于没提醒）、无头截图/探针里也抓不到它、没法当判据。
  ⚠ 结构写在 HTML 里而不是 JS 现造 —— 这样"代码里引用的每个 id 都要在 index.html 里"那条闸门也管得到它。

**② 开机告知**（`boot()` 里第一件事）：标题「⚠ 本项目未经过完整测试」，正文三句：
没经过完整的实机验证（写卡/删除/新建槽只验证过一部分）→ **请先自己备份记忆卡**（把 `memcards\` 里的
`.ps2` 复制一份到别处）→ 另一条硬规矩：写卡前**完全退出 PCSX2**（它退出时会把手里那份卡写回文件）。
按钮措辞就是「我已知晓，并会自行备份记忆卡」。

**① 写入前拦"还在取景模式"**（`doWrite()` 第一件事）：`isCropActive()` 为真就弹窗、**中止写入**，
并告诉用户"点〔确定取景〕（或〔取消〕）再来"。
★ 为什么不替他自动确定：用户原话是"需要弹窗告诉用户**手动**确认取景才能继续" ⇒ 不调 `confirmCrop()`，
`ui.test.ts` 有一条闸门专门钉住这一点。
（取景没确认之前，参数行还是上一次确定的值 ⇒ 这时候写下去的是"上一次的取景"，与白框里看到的不是一回事。）

**③〔导出整卡〕→〔另存为…〕**（`cardOps.ts::saveCardAs()`，id 改 `btn-save-as`）
* 先走 **`showSaveFilePicker()`**：弹出真正的"另存为"对话框，**位置与文件名由用户选**（建议名 `<原名>_copy.ps2`）
  ⇒ 这才是"另存一张记忆卡"。存完**回读文件逐字节比对**（与写卡同一条规矩），不一致就报错。
* 取消（`AbortError`）⇒ 什么都不做，**不偷偷改成下载**；拿不到那个对话框（老浏览器/被拒）⇒ 退化成下载
  （SPEC.md §三 既有的降级策略）。
* 原文案里的"导出整卡"字样全部换掉（含写前拦截提示里那条"别用它盖回这张卡"）。

**判据**
* `ui.test.ts` 新分节 (n)（**22 条**）：弹窗是整页遮罩且靠 `hidden` 收、开机文案含"没有经过完整的实机验证 /
  请先自己备份记忆卡 / 完全退出 PCSX2"、取景拦截**排在 `writeSlot()` 之前**且**没有**自动 `confirmCrop()`、
  按钮/函数改名到位、`showSaveFilePicker` + 取消不下载 + 回读比对 + 降级下载、老 id 与老函数名不许长回来、
  以及**两处弹窗文案里都没有 markdown 的 `**`**（0.14 踩过：HTML 不认，会原样显示两个星号）。
* `web/tools/screenshot.mjs`：**所有模式**现在都会先 `#modal-ok.click()`（否则截到的全是遮罩），
  并新增 `--boot`（*不*点掉弹窗）⇒ 新截图 `web\_shot_boot.png` = 用户双击产物时看到的第一屏。
* `node web\check.mjs` → **8/8 全绿**（core 2821 · card 1619 · image 1039 · **ui 854**）。
* 产物 **483,696 → 492,228 字节**（+8,532 B），标记 `M4-UI-27 → M4-UI-28`。

---

## 0.25（M4-UI-27）· 写前拦"卡被别人改过" + 删除立刻写回（2026-10-06）

用户实测报了两条错（同时出现）：

```
InvalidStateError: An operation that depends on state cached in an interface object was made
  but the state had changed since it was read from disk.
  （内存里的改动还在，可以重试；也可以改用"导出整卡"下载）
写内存副本失败（BISLPS-25462EMB\data2）：BISLPS-25462EMB 里已经有 data2，拒绝覆盖
```

**诊断**（用户确认：这次会话一次都没成功写过 / 只有一个标签页 / 卡在本地普通目录 /
**PCSX2 一直开着**）：
* 第 1 条 = **Chrome 的"句柄过期"保护**。Chrome 在**选卡那一刻**把文件的 mtime/size 记在句柄里，
  之后任何进程写一次这个文件，`createWritable()` 就抛 `InvalidStateError` —— 免得盖掉别人的改动。
  那条时间窗里唯一会写卡的就是 **PCSX2**（游戏里存了徽章 / 退出时把卡写回文件）。
* 第 2 条是第 1 条的**后遗症**：第一次尝试已经把 `data2` 写进了**内存副本**（回读自检还过了），
  只有"落盘"那步失败；而模型只在**成功**时重建 ⇒ 再点一次仍按"新建 `data2`"规划，
  撞上 `card.ts::createFileInDir()` 的"已经有 data2，拒绝覆盖"。

**用户选的范围：只做"写前拦截 + 提示"**（`#3` 失败后刷新模型 / `#4` LR 规划看真卡 —— 明确不做，留档）

**A 类（新增）· 写前拦"卡在磁盘上被改过"**
* 新模块 `src/ui/logic/staleness.ts`（纯逻辑、可测）：`stampChanged()`（**mtime 或 size 任一不同**
  就算变过 —— 记忆卡是**定长 8 MB**，光比 size 会漏）、`describeStamp()`、
  `staleFileRefusal()`（给用户看的完整说明：**哪个文件、什么时候变的、接下来三步**，
  外加"别用〔导出整卡〕盖回去"的警告）、`STALE_HANDLE_HINT`（真抛 `InvalidStateError` 时的兜底）。
* `state.ts::LoadedCard.lastSeen`：选卡时记下 `{mtime,size}`，**每次成功落盘后用回读到的那个 File 更新**。
* `cardOps.ts::preflightStale()`：写/删**动手之前**查一次，变了就拒绝。
  ★★ 位置是关键：必须放在**任何内存副本的修改之前** —— 否则"拒绝"会留下一个改过的内存副本，
  而模型还是旧的 ⇒ 再点一次就正好撞上第 2 条错。现在拒绝 = **什么都没发生**。
* `persistCardChange()` 里再查一次（兜底：用户盯着确认框那段时间里文件又被改了）+
  `InvalidStateError` 换成能照做的说明（原来那句"可以重试"是错的 —— 重试必然再失败）。

**B 类（新增）·〔删除槽〕删完立刻写回卡文件**（用户要求："给删除也加入删完就保存记忆卡的功能"）
* 之前删除只改内存副本，然后提示"用〔导出整卡〕或〔写入选中槽〕时才会落盘"。
* 现在：一个确认框（写明"删除后会**立刻写回卡文件**"+ PCSX2 硬提示）→ 内存副本上删 →
  走**同一条** `persistCardChange()`（写前拦截 → 覆盖 → 回读文件逐字节比对）。
  没有写句柄（只读打开）时降级成"下载一份改好的卡"。
* `deleted` 与 `ok` **分开报**：落盘失败时状态行如实说"内存里已删除，但**没有落盘**（磁盘上还是原样）"。
* 落盘段从 `writeSlot()` 里抽成 `persistCardChange()` —— 写入与删除从此共用一条路（含拦截与回读）。

**判据**
* `ui.test.ts` 新分节 (m)（**30 条**）：`stampChanged` 的三种情形（含"只有 mtime 变"这条关键判据）、
  `describeStamp`、`staleFileRefusal` 必须含"文件 / 两个时间 / 三步 / 别用导出整卡 / 没有写盘"、
  以及**位置判据**（`preflightStale()` 必须排在 `writeBlockToTarget()` / `deleteSlotFile()` **之前**）、
  "删除走同一条落盘"、"老那句'还没落盘'已删"。
* **无头 Chrome 探针（走真路点按钮，不是直接调函数）**：
  * 假句柄报告"文件被改过"⇒ `createWritable` **0 次**、日志给出完整说明、
    **内存里也没有 `data3`**（拒绝 = 什么都没发生）；
  * 句柄状态一致 ⇒ `createWritable` **1 次**、写入 8,650,752 字节、
    日志"逐字节比对一致 · 18/18 · 改动页 ECC 全对"、toast"已覆盖…覆盖后回读逐字节一致 ✅"、
    `lastSeen` 已更新；
  * 〔删除槽〕（真点按钮）⇒ `createWritable` **1 次**、整张 8,650,752 字节写回、
    内存里 `data0` 消失、状态行"已删除并写回：已覆盖 Mcd001_TEST.ps2"。
* `node web\check.mjs` → **8/8 全绿**（core 2821 · card 1619 · image 1039 · **ui 830**）。
* 产物 **468,926 → 483,696 字节**（+14,770 B：新模块 + 拦截/删除两段流程 + 说明文案），
  标记 `M4-UI-26 → M4-UI-27`。

> ⚠ 留档：`#3`（失败后刷新模型）与 `#4`（LR 规划先问"有没有 dataN"）**这一轮按用户要求没做**。
> 因为拦截现在排在最前面，"写完但没落盘"只剩两种路径：**用户在确认框按取消**、**权限被拒/回读不一致**。
> 这两条路上再点同一个槽，仍会撞第 2 条错（`已经有 dataN，拒绝覆盖`）—— 想修就是一行的活 + 一处 LR 规划。

---

## 0.24（M4-UI-26）· 自检折叠按钮改成蓝色（2026-10-06）

用户："展开按钮改成其他几个按钮也用的蓝色，不然不够显眼"。

* `index.html`：`#btn-pcsx2-toggle` 的 `class="quiet"`（透明底 + 暗色字）→ **`class="primary"`**
  （`#2f4a68` 蓝底，与〔选择记忆卡〕〔选择 PCSX2 目录〕〔写入选中槽〕**同一个蓝**）。
  它是面板头一行里唯一的操作，用低调的透明按钮确实找不到。
* `ui.test.ts` 分节 k2 加两条闸门：按钮必须带 `class="primary"`、不得退回 `quiet`。
* `node web\check.mjs` → **8/8 全绿**（core 2821 · card 1619 · image 1039 · **ui 800**）；
  产物 **468,511 → 468,926 字节**，标记 `M4-UI-25 → M4-UI-26`；截图重拍确认是蓝的。

---

## 0.23（M4-UI-25）· 参数栏收窄 + PCSX2 自检默认折叠（2026-10-06）

用户三条：
① "参数一栏可以把水平宽度缩小了，现在太大了"；
② "自检改成默认折叠起来"；
③ 自检副标题改成 "确认游戏实际会读哪张卡，避免全局设置与独立设置不同导致的记忆卡读取问题"。

**① 参数栏收窄**
* `.upper` 列定义 `minmax(0, 1fr) minmax(260px, 1fr)` → **`minmax(0, 1fr) minmax(190px, 220px)`**。
  参数只有两格（一个下拉 + 一条滑杆），原来占掉 1/3 屏宽（1600px 视口下约 520px）纯属浪费；
  省下来的宽度全给图片格（4× 预览更容易铺满，"已按容器缩放显示"更少出现）。
* 参数栏收窄之后，原来那句副标题「两格：缩放核 / alpha 阈值」把标题挤成了竖排的"参 数" ⇒ 整句删掉
  （下面两格的标签本来就写着"缩放核 / alpha 阈值"，属重复的说明性文字；另外给 `.pane-title` 加了 `white-space: nowrap`，
  这一类"标题被挤成竖排"的 bug 以后不会再出现）。
* 顺带把 `.upper` 那段的注释重写成"列定义的历史"（0.9→0.21 是 2fr/1fr、0.22 右栏换参数、0.23 收窄），
  并删掉已经不适用的"备选方案 ①（挤压右侧工具）"。

**② PCSX2 自检默认折叠**
* `index.html`：头一行常驻（标题 + 副标题 + **〔展开/收起〕** `#btn-pcsx2-toggle`），
  其余整块包进 **`#pcsx2-panel`，初始 `hidden`**（三条入口 + 默认目录提示 + 本次来源 + 结论表 + "这块面板是干什么的"）。
* `main.ts`：新增 `setPcsx2Open(open)`（切 `hidden` + 按钮文案 + `aria-expanded`）；
  〔展开/收起〕接线；boot 时对齐一次初始态；**`setPcsx2Files()` 读到文件后自动展开一次**
  （否则用户点了〔选择 PCSX2 目录〕却看不到结论，会以为没反应）；〔清空〕回到默认折叠态。
  ⚠ 折叠靠 `[hidden]`（`styles.css` 有 `[hidden] { display: none !important }`），**不写** inline `display`
  —— 那样会被 `.row { display: flex }` 盖掉（0.9 踩过这个坑）。
* `styles.css`：`#btn-pcsx2-toggle { margin-left: auto }`，副标题 `flex: 1 1 320px`，头一行允许换行。
* ★ **实测**（无头 Chrome，真点击）：
  `初始 hidden=true/文案「展开」/aria=false/computed display=none` →
  `点一次 hidden=false/「收起」/aria=true/display≠none` → `点两次 收回`。

**③ 副标题换成用户给的那句**（点名"全局设置 vs 每游戏独立设置"这个坑）。

**判据**
* `ui.test.ts` 分节 (j) ①：列定义断言改成新值；分节 k2 由"**无**折叠按钮/默认展开"**翻面**成
  "有按钮、默认文案「展开」、`aria-expanded="false"`、`#pcsx2-panel` 带 `hidden`、三条入口都在面板内部、
  副标题是那句"，并把标题改成"位置、★ 默认折叠、按钮与提示文案"。
* ★★ **顺带修掉一个"假通过"的测试**：k2 原来用 `maskSource(html)` 做判据 —— 那是给 **JS** 写的掩码器
  （认 `//` 与 `/*`），套在 HTML 上会把大半篇 markup 一起抹掉，于是那几条**负向**断言（"不存在折叠按钮"）
  其实**怎么都能过**。改成正向断言之后立刻暴露，现在改成"切掉内联 `<script>` + 去掉 HTML 注释"再比。
* `node web\check.mjs` → **8/8 全绿**（core 2821 · card 1619 · image 1039 · **ui 798**）。
* 产物 **464,891 → 468,175 字节**（+3,285 B：折叠那块的 DOM/JS 与说明注释），标记 `M4-UI-24 → M4-UI-25`。
* 截图重拍并目视确认：参数栏明显变窄、图片格更大、PCSX2 面板折成一行。

---

## 0.22（M4-UI-24）· 不做内置编辑器；右栏改放参数（2026-10-06）

用户："我突然觉得我们是不是没有必要做工具这一栏，毕竟其他优秀的图像处理工具有很多"
→ 讨论（核心价值 = 格式与写卡、不是"能画图"；闭环已存在）后用户选：
**「A 整块删掉」+ 布局「把参数一栏放在右栏」**。

**A 类（删）· 内置像素编辑器取消（原 M4b 关闭）**
* `index.html`：整个 `<aside class="card pane-tools">` 删除（12 个 `.tool-chip` 占位按钮、`.tools-note`
  说明块、"调色板（占位）"与 `#palette-grid`）。
* `main.ts`：`fillPalettePlaceholder()` 与它的 boot 调用删除；原地留一段"为什么不做"的记录
  （核心价值在格式与写卡；编辑器做不过 Aseprite/Photoshop 却要吃掉判据最难写的一块；闭环已存在且无损）。
* `styles.css`：`.pane-tools` / `.tools-grid` / `.tool-chip` / `.tools-note` / `.tools-palette*` /
  `.palette-swatch*` 全部删除，**≤760px 那条断点也跟着删**（它只为 `.pane-tools { min-height: 300px }` 存在）。

**B 类（布局）· 右栏放参数**
* `.pane-params` 从 `</main>` 之后**搬进 `.upper` 的第 2 列**（右栏）；`.params-grid` 由
  "横向成对排 + 自动折行"改成**竖排**（`flex-direction: column`），标签改块级、控件 `width: 100%`。
* ≤900px 那条"每个字段占满整行"的规则也删了（竖排之后没有意义）—— 参数现在跟着 `.upper` 的 1100 断点走。

**C 类（补判据）· "删掉编辑器 ≠ 丢能力"要有见证**
* ★ 新增 `image.test.ts` 的「**0.22 闭环**」一节（11 条）：造一张"像徽章"的 128×128 图（12 色 + 中心一个
  真透明"洞"）→ 按工具的真路走两遍 ⇒ **导出 → 重新导入**后：逐像素 `diff = 0`、透明像素数不变、
  实色数不变、索引 0 仍只落在透明像素上、合规仍通过、再转一圈不漂移、`report.lossless = true` /
  `quantized = false`（没跑中位切分）。
  ★ **真浏览器也走了一遍**（无头 Chrome 探针，不是仿真）：`canvas.toBlob('image/png')` → `createImageBitmap`
  → 真路 `applyImportedImage` ⇒ **`diff = 0 / 16384`**、`transparent 6736 → 6736`、`compliance = true`、
  PNG 2,359 字节。这一步补上了"PNG 编解码本身无损"那半边（核心测试只覆盖到 RGBA）。
* `ui.test.ts`：新增「128×128 的图 ⇒ 默认取景 = 倍率 1 / 偏移 0 = 恒等」（这是闭环无损的导入侧那一半）；
  分节 (j) ⑥ 由"工具占位"翻面成**11 个工具名 + 占位文案 + 死样式"不许长回来"**的闸门；
  ⑦ 改成"参数在 `.upper` 栅格内部 + 竖排 + 旧横排规则已删"。

**验证**：`node web\check.mjs` → **8/8 全绿**（core 2821 · card 1619 · **image 1039** · **ui 790**）。
产物 **465,982 → 464,891 字节（−1,091 B）**，界面开发标记 `M4-UI-23 → M4-UI-24`。
截图重拍并目视确认：左格图更大、右栏是参数、顶栏 `v0.22`。

---

## 0.21（M4-UI-23）· 删〔批量写 8 槽〕+ 修"导出整卡下载两次"（2026-10-06）

用户："批量写 8 槽功能删了，这个没什么实际作用" + 问"导出整卡的作用是什么"。

**A 类（删）·〔批量写 8 槽〕按"彻底"的范围删**
* `index.html`：`#btn-write-all` 按钮删除；`main.ts`：它的 handler（含那句"写进所有 8 个槽"的
  `window.confirm`）与 `setBusy()` 禁用名单里的那一项删除。
* **写入路径随之收成单槽**（多目标那套数组只在批量那条路上用得到）：
  * `logic/planWrite.ts`：`planWriteTargetsIn(input{slotIndices[]})` → **`planWriteTargetIn(input{slotIndex})`**；
    `WritePlan` 的 `targets[] / warnings[] / errors[]` → **`target / warning / error`**（各一个）；
    原来 `for (const i of slotIndices)` 那个循环消失。
  * `cardOps.ts`：`planWriteTargets(ctx, slotIndices[])` → **`planWriteTarget(ctx, slotIndex)`**；
    `writeSlots(ctx, slotIndices[], …)` → **`writeSlot(ctx, slotIndex, …)`**，逐槽循环 + 逐槽回读自检
    收成一段（判据一条没少：合规复核 → 生成块 → 写内存副本 → 回读逐字节/18 段/ECC → 确认 → 落盘/下载）。
  * `main.ts`：`doWrite(slotIndices[])` → `doWrite(slotIndex)`；`updateWriteHints()` 的单目标渲染。
* 判据**没有丢**：`ui.test.ts` 分节 (c3) 里"AC3 8 个槽全拒""LR 视图下 8 个目标都落在 LR 目录"这类
  多目标断言，改成**在测试里循环 8 个槽**（`allSlots()` 助手）+ 单槽断言，条数与改前一致（22 条）。
  另加一节 ⑯：按钮没了 / `doWrite` 不再收数组 / 逻辑层叫 `planWriteTargetIn()` / 写入叫 `writeSlot()`。

**D 类（真 bug）·〔导出整卡〕点一次下载两次**
* `main.ts::bindButtons()` 里 `$('btn-export-card').addEventListener('click', …)` **写了两遍**
  （两段一模一样的代码，0.19 去重时留下的重复块）⇒ 一次点击触发两次下载
  （Chrome 里表现为两个文件 / 一次"允许多文件下载"提示）。
  ★ **实测复现**：把真卡拖进产物后点一次按钮，`URL.createObjectURL` 被调用 **2** 次；
  删掉重复那段之后为 **1** 次。行为本身没变（`exportWholeCard()` 仍把内存里的整张卡另存为
  `<原名>_export.ps2`，不碰原文件），只是不再下两份。

**其它**
* `cardOps.ts:590` 那处 0.19 遗留的缩进错位（`};` 缩进 14 格）理正。
* 文档：`SPEC.md` §四 的按钮示意图与按钮清单、`README.md` §三、`PORT-NOTES.md` 的函数改名说明。

**验证（不只是跑测试）** —— 单槽写入在**真卡副本**上端到端走了一遍（无头 Chrome，走真路的
`drop` 开卡 + 真路导入图片 + 点〔写入选中槽〕）：
* 日志：`✅ BISLPS-25462EMB\data5（槽 6，新建）：17.0 KiB · 逐字节比对一致（17440 字节） · 18 段校验 18/18 · 改动页 ECC 全对 · 图像合规`
* 用核心层把刚写进去的 `data5` 再解一次：`kind=emblem-lr`、`verifyChecksums → {"ok":true,"badSegments":[]}`、
  **`extractImage('index0')` 与预览像素 `diff = 0 / 65536`**（逐像素相同）；8 格里那一槽立刻变成"已占用"。
* 同时钉住这次修的 bug：`confirm=1`、**`downloads=1`**（修前实测 2）。
* 判据总表：`node web\check.mjs` → 8/8 全绿（core 2821 · card 1619 · image 1028 · **ui 791**）。

```powershell
node web\check.mjs    # 8/8 全绿
```

---

## 0.20（M4-UI-22）· 删掉 8 格上的 `icon.sys@0xDF` 小字（2026-10-06）

用户问："8 个卡槽那边显示的 `icon.sys@0xDF` 是什么意思" → 解释清楚之后用户选了**「直接删掉」**。

**删了什么**
* `slotsView.ts`：槽位卡右上角那行小字（`el('span', {class:'slot-offset', …})`）连同它的 `.slot-head`
  包装一起删 —— 8 格上原样重复 8 遍、信息量为零。现在每格顶部只剩 `槽 N`。
  `slot-offset` 的悬停提示（"槽位号写在 icon.sys 的 0xDF…"）一并删。
* `styles.css`：`.slot-offset` 与 `.slot-head` 两条规则删除（不留死样式，`ui.test.ts` 分节 (j) 钉住）。
* `logic/slots.ts`：`ICON_SYS_SLOT_OFFSET` 常量删除（删掉显示之后它只剩测试在用 ⇒ 按 0.19 的 A-2 规矩删）；
  对应断言 `eq(ICON_SYS_SLOT_OFFSET, 0xdf)` 换成一条**等价的事实记录**（见下）+ 一条死样式断言 ⇒
  `ui.test.ts` 仍是 **782/782**。
* 产物 **466,253 → 465,883 字节**（−370 B），界面开发标记 `M4-UI-21 → M4-UI-22`。

**顺手做实的两件事（都不是猜的）**
* ★ **逐卡实读复核 `icon.sys@0xDF`**（用工具自己的卡层，`out\evidence\*.ps2` + `out\Mcd001_data7test.ps2`）：
  * 非 LR 的 `E##` 目录里它**就是槽位号**：SL `BISLPS-25169E00`=0 / `E01`=1；NX `E00..E04`=0..4（nxfix 卡）✅
  * **LR 的 `BISLPS-25462EMB` 目录只有一份 `icon.sys`、`0xDF` 恒为 0** ⇒ 在 LR 作品的 8 格上，
    那行小字本来就**没有意义**（LR 是一目录包 8 槽，槽号由 `dataN` 文件名体现）。
    事实与依据写进 `logic/slots.ts` 注释、`SPEC.md` §七、`ui.test.ts` 分节 (c)。
  * 顺带确认：**本工具不写 `icon.sys`**（只有显示与一句警告，没有任何写入路径）⇒
    "改标题时要最后写 0xDF" 这条规矩是给**手动改卡**的人看的，不是本工具的行为。
* `web/tools/screenshot.mjs` 新增 **`--card <路径>`**：把卡的字节塞进 `File`、往 `#card-drop` 派发
  真的 `drop` 事件（= 用户拖卡进来的同一条路）⇒ 之前**没有任何截图档能看到下半部分那 8 个槽**，
  现在有了（默认视口自动放大到 `1500,2300`，产物 `web\_shot_card.png`）。

**文档同步**：`SPEC.md`（版本/体积/M4 行/§七 的 0xDF 事实）、`README.md`（顶栏示例、截图清单、版本号）、
`PORT-NOTES.md`（体积、截图清单、状态日期）。

```powershell
node web\check.mjs        # 8/8 全绿（含 ui 782/782）
node web\tools\screenshot.mjs --card out\evidence\Mcd001_TEST.ps2   # 亲眼看那 8 格
```

---

## 0.19（M4-UI-21）· 简化 + 修 bug（2026-10-05）

用户指示："对该项目的代码进行简化，并审查是否有 bug" → 逐条勾选后执行：

**A 类（删）**
* 死代码 31 处（含 17 行失效 CSS：`.stats*`/`.compliance`/`.field-narrow`/`field-wide`/`warningbtn`/
  `.grow`/`.mono`/`input[type=checkbox]`/`.hint b`）：`CARD_EXT`/`IMG_ACCEPT`、`state.game`（3 写 0 读）、
  `LoadedCard.mode`、`sourceSha` + `sha256Hex()`（每次开卡白算一遍整张 8 MB 卡的 SHA-256）、
  `slotThumbAt()`、`dirExists()`、`WriteOutcome.decision`、`planWriteTargets()` 的 `opts` 注入点、
  `PAGES_PER_CLUSTER`/`ECC_BYTES`/`FAT_LAST`/`readCardFromBytes()`/`readSparePage()`/`writeSparePage()`/
  `cloneImage()`/`PALETTE_COLORS`/`REGION_PREFIX`/`PCSX2_NEEDED`/`PCSX2_TEXT_EXT`/`dirNamesForSlots()`/
  `sameBytes()`/`bytesEqual()`/`SIDE_EFFECT_RE`，以及 4 个只有测试引用的 id
  （`crop-hint`/`pane-tools`/`pane-params`/`pcsx2-bar` —— 元素都留着，只是不再挂 id）。
* 只有测试在用的导出：`applyChecksumsUpstream()`(27 行)、`summarizePcsx2()`、`fillWindow()`、
  `screenToSource()`/`sourceToScreen()`（生产里一个调用点都没有）、`selectPcsx2Files()`+`matchPathOf()`、
  `previewOpaque()`、`gameForDirName()`/`headerTailFromHex()`/`slotIndexFromDirName()`、`card.emblemDirs()`、
  `buildSlotModel()`（改为文件内私有）。对应断言**改写成等价判据**（几何换算挪进测试、
  `buildSlotModel` → `buildGameSlotModel(dirs, null)`），判据一条没丢。
* 〔新建槽〕按钮（点下去只弹"这不是独立操作"）。

**B 类（合并 / 收口）**
* `logic/format.ts`：`hex()`/`humanBytes()` 从 `dom.ts` 抽出 —— `writeGuard.ts` 原先又抄了一份 `hex()`。
* `refreshCardViews()`：`main.ts` 里"重建模型+缩略图+槽位+卡片信息+写卡提示"从 5 处手抄收成 1 处
  （那 5 处**已经开始漂**，见 D3）。
* `openHandleDb()`：IndexedDB 的 open 逻辑去重（remember/recall 各一份）。
* `downloadBlob()`：导出整卡与导出 PNG 的下载尾巴去重。
* `CORE_DEFAULTS`：界面没有入口的 4 项（`targetSize`/`fitMode`/`despeckle`/`maxColors`）集中到一处声明。
* `setStatus()` 直接写 `#status`（"忘了配 `renderStatus()`"在结构上不可能再发生）。
* 两处数字格式化函数、`MCD_SLOT_OF` 的重复映射、下拉框"选中项写两遍"、`PARAM_LIMITS` 里 0 读者的三项。
* 打包器 ↔ 外壳的"版本号"契约从 2 条并成 1 条（只认那个占位 span）。
* 逐版本历史从 `version.ts` 搬到这里（产物少背 ~15 KB）。

**C 类（验证）**
* 新增 `web/check.mjs`：一条命令跑完 打包 + 四套 node 测试 + 三条 python 判据，
  并打一张"判据总表"（之前是 `README.md` 里手打的七条命令）。
* 打包器：不认识的命令行参数**报错退出**（原先 `--checks` 这种笔误会被静默忽略）；
  构建冒烟里那条"用真夹具验 saveKind/校验"不再被 `existsSync` 静默跳过。
* 新增回归断言：D18/D19/D24（card 18 条）、D22/D25（core 10 条）、D20/D21/D23（image 7 条）。

**D 类（真 bug，25 条全部修掉）**
* **D18** `card.ts`：超块字段自检（`page_len`/`ppc`/`clusters`/`alloc_offset`/`alloc_end`）+ `sysRead()` 读不满就抛
  + FAT 块簇号自检（`fc >= 1` 且页在卡内）。原先 `ifc[0] = 0xFFFFFFFF` 会让 `ind[]` 静默变 0，
  而 `writeFat()` 把簇 0（**超块自己**）当 FAT 块 ⇒ 实测一写就毁掉 "Sony" 魔数。
* **D19** `readPageRaw/readSpareRaw` 越界抛（不再返回空数组）；`readFile/dirents/findFreeSlot`
  用新的 `clusterInImage()` 在"簇号合法但页不存在"处**截断**（与 Python 的短缓冲一致，不再补零）。
* **D20** `image.ts`："源尺寸 == 目标尺寸 ⇒ 逐像素复制"的短路改成**真正的恒等映射**判定
  （两轴倍率都是 1 且没有偏移）；原先 `manual` 的缩放/偏移会被无条件忽略
  （128×128 源图配 scale=4/offset=-192 会原样返回输入，而 `transform` 却写着 scale:4）。
* **D21** `despeckleRemoved` 只数"二值化后不透明、去杂边后变透明"的像素
  （原先把"被阈值判成透明"的半透明像素也算在去杂边账上：整幅 `alpha=100` + 开收边会报 16384）。
* **D22** `applyChecksums` 的扩容语义与 Python 对齐：**单下标写越界就抛**，
  只有"校验后那 10 字节"（切片赋值）允许扩容；`injectImage()` 把扩容后的数组**交回调用方**
  （原先丢弃返回值 ⇒ 短缓冲上 18 段校验全没写进去还不报错）。顺带纠正两处写错的注释
  （"Python 对越界赋值会静默扩容 bytearray" —— 单下标越界其实是 IndexError）。
* **D23** `stretch` 的 `backgroundPixels` 不再硬写 0（与字段文档一致）；
  `sourceOpaqueColors` 的文档改成"源图（未二值化）的参考值"（判核实际用二值化后的色数）。
* **D24** **Node `Buffer` 输入不再破坏"复制"承诺**：`readCardFromBuffer()` 用 `Uint8Array.from()`
  （`Buffer.prototype.slice` 返回的是**视图**，原先 `copy = true` 在 Buffer 路径上一次都没复制，
  实测会把调用方 Buffer 的前 8 字节改掉）；`readPageRaw/readSpareRaw` 显式复制；
  `headerTailFromSave/lrHeaderFromSave` 显式复制。
* **D25** 域外参数不再静默降级：`makeBlankSave(false, 1.5)` 抛（原先截断成 17473 字节 ⇒ 判成 `container`）、
  LR + `baseOffset > 0` 抛、`injectPixelsToIndices()` 超过 256 项抛（原先索引 256 回绕成 0 变透明洞）。
* **D1~D17**：状态行不刷新（2 处漏配 `renderStatus()`）；开卡失败后界面仍描述上一张卡；
  切作品失败漏刷缩略图（槽名与缩略图可能来自不同目录）；写入后 ECC 自检只查首簇（18 簇只验 2 页 → 现在验全部改动页）；
  夹具生成器缺外部依赖时把 44 个样本静默改写成 11 个还退出 0（改为报错提示）；构建冒烟缺夹具静默跳过；
  图像夹具参考值绑 Pillow 版本（文档写明）；写入期间可换图（`setBusy` 把图片按钮一并禁用）；
  删除槽先释放 FAT 再校验越界；`encodeEmblem` 逐槽重复编码 8 遍（提到循环外）；
  只读兜底提示自相矛盾；PCSX2 面板读到 0 个文件时保留旧结论；`confirmCrop` 失败文案写死；
  空格键选槽顺带滚页；同一帧内先缩放后平移；覆盖写入不更新 dirent 长度；扩目录簇隐含 `ppc == 2` 前提。
* **FRAGILE 项顺手加固**：`u32le/u16le` 越界抛；`calcEcc` 短缓冲抛；`chain/readFat` 拒绝负数与小数簇号；
  `allocateClusters` 校验簇数；`writeFileIntoClusters` 数据超长抛；`encodeName` 非 ASCII 抛；
  `readPageRaw` 越界抛。

**Python 侧**
* 删掉 10 个"有 TS 等价物且无人调用"的脚本（共 ~2,275 行），删前打包存档到
  `_selftest/_archive/清理_2026-10-05.zip`：`tools/acet_cli.py`、`tools/check_pcsx2_slots.py`、
  `_selftest/{tidy_layout,check_links,dump_dir_slots,check_dirent_bits,audit_slot_map,scan_all_cards,dump_card_emblems}.py`、
  四个 `write_*.py`。**交叉验证链全部保留**（`acet_format.py` / `prepare_image.py` / `selftest.py` /
  `web/test/make_*.py` / `validate_writer.py`）—— 那是"TS == Python"那些断言的唯一依据。

**判据**
```
core 2821/2821 · card 1619/1619 · image 1028/1028 · ui 782/782
python acet_format 0 项失败 · selftest 25/25 · validate_writer 全过
```

---

## 0.18（M4-UI-20）· 又删掉一批说明文字

用户一次粘了 11 句（"这几句话也删掉"）：① 参数行「缩放核」下面那句规则说明；② 8 槽标题旁那句命名规则；
③ **写入日志里那 8 行"欢迎 + ①②③④ + ★ 说明"整块删除**（日志现在**从第一次操作**才有内容，
没内容时整个框隐藏）；④ PCSX2 面板里三句（"（面板常驻在页面最下面）"、"（浏览器不允许网页自己按路径读文件…）"、
"判读方法：拿「实际会读的卡」…"）。
⚠ 删的都是**说明文字**：缩放核规则、槽位命名、PCSX2 结论表与冲突提示、写卡确认框里的
"请先完全退出 PCSX2" 全都在。版本号不再从日志里看 ⇒ 看顶栏；开发标记走 F12 `EmblemToolCore.ui.buildTag`。

## 0.17（M4-UI-19）· "实时统计"整块删除

用户："我认为实时统计这个部分，整个就没什么作用" → 讨论后选"整个删掉"。
参数行的 `#stats` 9 行诊断 + `#compliance-inline` + `pipeline.ts::renderStats()` 全删；
参数行只剩**缩放核 / alpha 阈值**两格。
⚠ 核心一个字段没少（`prepareEmblem()` 的 `report` 照旧），合规仍挡在写卡那一步
（`writeGuard` 拒绝写入并说明原因）。副作用（好的）：`refreshImage()` 不再顺带扫整张源图算 `imageStats()`
（0.8 M 像素 ~99 ms）。

## 0.16（M4-UI-18）· 导入图片后自动进取景模式

用户："改为加载图片后默认启动取景模式"。顺带把"导入之后要做的事"抽成
`main.ts::applyImportedImage(img, name)`（换 source → `fillManualToTarget()` → `recompute()` →
`refreshImage()` → 提示 → `openCropView()`），并挂到 `ui.imageImport.applyImportedImage` 上 ——
打包冒烟与无头截图探针都走这条真路。

## 0.15（M4-UI-17）· 删掉参数行三格

「收边（去杂点）」「减色上限」「取景数值（倍率/X/Y）」按用户要求整块删除
（"我感觉这三个选项都没什么用啊" → 讨论后"三样全删"）。删 UI **不等于删能力**：
`UiParams` 字段、核心实现、默认值（收边关 / 减色 255）与全部测试一个字没动。

## 0.14（M4-UI-16）· 修掉界面上漏出来的 markdown

用户截图里能看到 `默认**关**`、`要**拖拽/滚轮**改` 这类星号（HTML 不认 `**`，只有 `<b>` 才加粗）。
全部改成 `<b>…</b>`；`ui.test.ts` 加闸门：可见文案里不许出现 `**`（注释里不受限）。

## 0.13（M4-UI-15）· 删掉「取景」四档下拉

用户："取景这四个下拉选项有什么意义呢，我感觉只需要一个就行了"。
理由：`core/image.ts::fitToTarget()` 里**只有 `manual` 会读界面的 `scale/offsetX/offsetY`**，
另外三档会自己重算一套 ⇒ 那个下拉实际是"偷偷把你的取景丢掉"的开关。
现在 `fitMode` 恒为 `'manual'`，导入图片时 `fillManualToTarget()` 再钉一次。
⚠ 核心四档一个都没动（`image.test.ts` 仍在跑 contain/cover/stretch 的几何判据）。

## 0.12（M4-UI-14）· 取景动作行加实时读数

`#crop-readout`（白框正下方）：`白框 128×128 源像素 · 左上角 (x, y) · 倍率 k`，
到最小（1:1）时接 `· ★ 已到最小（1:1，不能再放大）` 并变警示色。
起因：用户问"ok了，然后状态行在哪" —— 那些数字原来只写在页面最下面的 `#status` 里，取景时根本看不到。

## 0.11（M4-UI-13）· 白框最小 = 128 源像素（不许放大）

用户附截图："如果我选了一片非常小的区域，图片就会这样（一堆麻点），要不我们限制白框最小取到 128*128"。
`windowBoundsFor()` 的下限从"长边/64"改成**目标边长 128**：窗口到 128 就是 1:1，再往里滚会**停住**。
源图本身比 128 小时下限退化成短边（= 整张图，仍不补透明边）。`MAX_ZOOM`/`CROP_MAX_ZOOM` 随之删除。

## 0.10（M4-UI-12）· 修"载入图片后预览特别小" + 删两个顶栏元素

① `#view-preview` 原来没有任何尺寸规则 ⇒ 盒子由里面的 canvas 撑出来，而 canvas 尺寸又是
"量了 `#view-preview` 之后"算的 ⇒ **量一次缩一次**（128→116→104→…→68px）。现在它是
`width/height: 100%` 的居中层，`fitDisplaySize()` 改成量 `.stage`；
② 删掉顶栏〔拖入 / 只读选择〕按钮（"没用"）—— 拖入仍是 `#card-drop` 的拖放目标，
只读兜底仍是 `#card-input`（`showOpenFilePicker` 不可用时自动走它）；
③ 删掉顶栏两段："✅ 有实机证据…"与"PCSX2 自检：<摘要>"（**未验证作品的 ⚠ 警告保留**）。

## 0.9（M4-UI-11）· 工作区改成"自动填满" + 默认取景"填满白框"

① `.stage` 去掉 `aspect-ratio` 与 `max-width`，改成"填满左格"（用户："我截图中红圈部分，能不能改成
自动填满或者说适应这一个长方形区域"）；② 打开图片时的默认取景改成"填满白框"（窗口边长 = 源图短边、居中）；
③ 删掉〔↺ 恢复到适应〕与取景里的〔↺ 复位 / 适应〕（"我认为这个按钮没用，删了吧"）；
④ 删掉工具栏后面的"· 实色 N · 半透明 N"与顶栏的"→ 目录名 …"；
⑤ ★ 顺手修掉无头截图抓到的真 bug：`#crop-actions` 同时带 `.row { display: flex }`，
而浏览器默认的 `[hidden] { display: none }` 优先级**低于**作者写的 class 规则 ⇒
没进取景视图时那行也显示。修法：`styles.css` 顶部加 `[hidden] { display: none !important; }`。

## 0.8（M4-UI-10）· 工作区改成正方形

用户："我是指红圈里的一整块，能不能做成方形的，可以挤压右侧的工具" ⇒ `.stage` 加
`aspect-ratio: 1 / 1` + 最大边长 560px + 居中。白框规则一个字没动。**（0.9 又改回填满。）**

## 0.7（M4-UI-9）· 取景拖动不再卡

实测旧代码每挪一个像素就重跑整条管线：`prepareEmblem()` 53~298 ms + `imageStats()` 10~99 ms
⇒ 一次 63~397 ms（60fps 预算只有 16.7 ms）。现在取景期间**只动视觉**（rAF 合帧、指针捕获、
滚轮 `passive:false`），参数与面板一律等〔确定取景〕跑一次；〔取消〕连管线都不跑。
`ui.test.ts` 分节 (l9) 与打包冒烟用**调用计数**钉住这条。

## 0.6（M4-UI-8）· 修"确定取景以后图片消失"

根因两个：① 取景偏移**量纲错位**（界面是源像素、`image.ts` 要目标像素），非方图几乎全空
（1024×600 实测 0/16384 个不透明像素）⇒ 唯一换算点 `manualOffsetToTarget()`；
② 取景框几何算错（少一个 scale、符号反）。取景改成：正中固定白框 + 拖图片 + 滚轮以框心缩放，
确定时加**烘焙自检**（宁可报错，不再静默给空白）。

## 0.5（M4-UI-7）· 上区改成"1 格当前图片 + 右侧工具栏"

取景改成**按需**（在同一格里切视图）。此前是"原图 / 游戏预览 / 编辑器"三格。

## 0.4（M4-UI-6）· 三块视图去掉滚动条

容器 `overflow: hidden`，画布等比自适应；「预览倍率」变成**上限**语义（装不下自动缩小并提示）。

## 0.3（M4-UI-5）· 删页脚两行；上区"一行 3 图 + 参数整行"；深色滚动条。

## 0.2（M4-UI-4）· PCSX2 自检改成"一次点击 + 记住目录"、默认展开、移到页面最下面。

## 0.1（M4-UI-3）· 顶栏显示版本号；原图列不再被挤扁；8 槽跟随所选作品。
