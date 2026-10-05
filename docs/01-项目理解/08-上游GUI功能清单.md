# 上游 GUI 功能清单（`acet-gui`，v0.1 / `main` / `dev`）

> 目的：给"自己写一个 GUI"提供一份**准确的功能盘点** —— 原版到底做了什么、没做什么、
> 哪些是注释掉的半成品。所有条目都对着源码核过（`src/ac-emblem-tool/acet-gui/`）。
>
> 一句话：**原版 GUI 是"单文件单徽章"的极简查看/注入器** ——
> 一个文件选择器 + 一块画布 + 三个菜单项 + 拖放，没有任何"库/槽/记忆卡"层面的管理。

---

## 一、界面结构

```
┌─ ACET Gui ─────────────────────────────── [菜单栏] ─┐
│ File                        Help                    │
│   Open Save...      Ctrl-O    About                 │
│   Extract Image As... Ctrl-E                        │
│   Inject Image...   Ctrl-I                          │
│   ────────                                          │
│   Exit                                              │
├─────────────────────────────────────────────────────┤
│ [ 文件选择器 wxFilePickerCtrl            ] ← 上，固定高 │
│                                                     │
│                                                     │
│         ImagePanel（画布，可伸缩）                    │
│         最小 384×384，图按窗口尺寸缩放居中             │
│                                                     │
├─────────────────────────────────────────────────────┤
│ [ 状态栏 CreateStatusBar() —— 但从不写入任何文字 ]      │
└─────────────────────────────────────────────────────┘
```

* 窗口标题 `ACET Gui`；`DragAcceptFiles(true)` ⇒ 整个窗口接受拖放。
* 布局 = 垂直 sizer：文件选择器（不伸缩）＋ 画布（`wxEXPAND`，伸缩）。
* `imagePanel->SetMinSize(wxSize(384, 384))`、`sizer->SetSizeHints(this)`。
* ★ **`CreateStatusBar()` 建了（`acet-gui.cpp:99`），但全项目没有任何 `PushStatusText`** ⇒ 状态栏永远是空的。
  （`dev` 分支里出现过几处 `/*GetStatusBar()->PushStatusText(...)*/`，都是注释。）

## 二、真正实现了的功能

| # | 功能 | 触发方式 | 实现 | 备注 |
|---|---|---|---|---|
| 1 | **打开存档并显示徽章** | ① `File > Open Save…`（Ctrl-O）② **文件选择器一选文件就触发** ③ 拖放 | `OnMenuOpenSave` / `OnSavePicked` / `OnFilesDropped` → `ExtractHelper()` | 三条路都做同一件事：`ExtractImage` → 建 128×128 wxImage → `imagePanel->SetImage` |
| 2 | **导出当前图像** | `File > Extract Image As…`（Ctrl-E） | `OnMenuExtract` | 过滤器 `PNG/GIF/BMP/JPEG`；`wxFD_SAVE \| wxFD_OVERWRITE_PROMPT`；存的是**画布上那张图**（不是重新从存档读） |
| 3 | **注入图像** | ① `File > Inject Image…`（Ctrl-I）② 拖放 | `OnMenuInject` / `OnFilesDropped` → `InjectHelper()` | 注入后**自动重新提取并刷新预览** |
| 4 | **拖放智能分流** | 把文件拖到窗口上 | `OnFilesDropped` | 逐个文件：`wxImage::CanRead()` 能读 ⇒ 当图；否则 `FindPaletteOffset()` 认 ⇒ 当存档。**图 + 存档一起拖 = 显示并注入** |
| 5 | **注入前自动备份** | 注入时自动 | `BackupSave()` | 写到 **`<当前工作目录>/acet-backup/<Unix 时间戳>/<文件名>`** |
| 6 | **打开对话框** | 菜单/选择器 | `wxFileDialog dialog(this)` | ⚠ **没有文件名过滤器**（注释里留了个 AC2 的示例正则：`BASLUS-21200E*`） |
| 7 | **注入前的图像适配** | 注入时自动 | `InjectHelper()` | 见 §三（这是 GUI 相对 CLI 的**核心增量**） |
| 8 | **预览：按窗口缩放居中、最近邻** | 自动重绘 | `ImagePanel::OnPaint` | `wxIMAGE_QUALITY_NEAREST`（像素风，不糊）；取窗口宽高较小者当边长，居中画 |
| 9 | **About 对话框** | `Help > About` | `OnMenuAbout` | 一段 6 步使用说明（含"别把 exe 放 Program Files"的提醒） |
| 10 | **全局异常兜底** | 任何未捕获异常 | `ACETGui::OnExceptionInMainLoop` | `wxLogError("Unexpected exception has occurred! …")` 然后**退出程序** |

## 三、GUI 相对 CLI 的**核心增量**：注入前的图像适配

这是 GUI 唯一真正多出来的能力（`acet-gui.cpp:190-243`）：

```cpp
int colors = 256;
if (!image.HasMask()) {
    if (!image.HasAlpha()) { image.InitAlpha(); colors = 255; }   // ① 没有 alpha 就造一个
    image.ConvertAlphaToMask();                                   // ② alpha → 1 bit mask（阈值 128）
}
if (image.GetWidth() > 128 || image.GetHeight() > 128)            // ③ 只缩"大于 128"的
    image.Rescale(128, 128);
if (image.CountColours(colors+1) > colors) {                      // ④ 超色就量化
    wxImage quantized; wxPalette *pal = NULL;
    if (wxQuantize::Quantize(image, quantized, &pal, colors, 0, wxQUANTIZE_FILL_DESTINATION_IMAGE))
        image = quantized;
}
// ⑤ 逐像素 → RGBA 缓冲：透明 (0,0,0,0)，否则 (r,g,b,0xFF)
```

⇒ 所以 **GUI 能直接吃 PNG/BMP/GIF/JPEG 和任意尺寸的图**，CLI 不能。
⚠ 但 ③ 只缩"大于 128"的 ⇒ **小于 128×128 的图不缩放、随后越界读**（限制问题 5）。
⚠ ② 用的是 `ConvertAlphaToMask()`（阈值 128），与 CLI 的"`alpha != 0xFF` 即透明"**不一致**（限制问题 6）。

## 四、★ 做了却没接上的东西（半成品痕迹）

| 位置 | 情况 |
|---|---|
| `injectButton` / `extractButton` | `wxButton` **被注释掉** —— 原本想做成按钮，最后只留菜单 |
| `bottomSizer` | 建了但没用（按钮那块一起注释掉了） |
| 状态栏文字 | `main` 里**根本不存在**（只建了状态栏）；`dev` 分支里以注释形式出现 |
| `SetClientSize(384, 440)` | 注释掉了（改用 `SetSizeHints`） |
| `ImagePanel::LoadFromFile()` | 定义了，**从没被调用** |
| `ImagePanel::OnSize()` | 定义了，**没 Bind**（那行也注释掉了） |
| `ImagePanel::SetImage()` 里那次 `Scale(w*3, h*3)` | 建了个 3× 位图，但 `OnPaint` 又按窗口尺寸重算一次 ⇒ **那次 3× 缩放是白做的** |
| 打开对话框的文件过滤 | 注释里留了 AC2 的过滤器，实际是空的（什么文件都能选） |

★ 这些加起来说明：**v0.1 就是个"能跑起来的最小 GUI"**，作者自己在发行说明里也写了
*"Now with a half-baked GUI! … It basically mostly works."*

## 五、`dev` 分支多出来的那一个对话框（未发行）

`acet-gui/PS1Dialog.h`（49 行）—— 选了 PS1 存档时弹出来选"记忆卡块 + 徽章槽"：

```
ACETGui → MainFrame::OpenSaveHelper()：
    若 isPS1Save(存档) → PS1Dialog dlg(存档);  取消则直接返回
        ps1MemBlock = dlg.Block();  ps1EmbSlot = dlg.Slot();  ps1IsMOA = dlg.IsMOA();
```

| 控件 | 内容 |
|---|---|
| `wxChoice blockChooser` | `ListPS1MCBlocks()` 的结果，**从索引 1 开始**列出（`"<n> - <存档名>"`，空的显示 `Empty Block`） |
| `wxSpinCtrl slotChooser` | **0..6**（7 个徽章槽），默认 0 |
| `Block()` | `GetSelection() + 1` |
| `Slot()` | `GetValue()` |
| `IsMOA()` | 选的块名里含 **`BASLUS-01030Z`** |

⇒ 这是原版 GUI 里**唯一一处"多个槽位"的概念**，而且只出现在未发行的 PS1 路径里。
⚠ 它依赖 `ListPS1MCBlocks()`，而那个函数**硬要求整张卡（`MC` 头）** ⇒ `.mcs` 单存档走不通（限制问题 17）。

## 六、原版 GUI **没有**的东西（＝你的 GUI 可以补的空间）

按"缺得最明显"排序：

| 缺失 | 说明 |
|---|---|
| **槽位管理** | 只认"一个文件 = 一个徽章"。**不枚举 `data0..data7`、不显示还剩几个槽、不能选槽** |
| **新建徽章** | 必须先有一个已存在的存档文件才能开工；**不能从零造一个徽章存档** |
| **记忆卡层面** | 不解析记忆卡/容器（`.psu`/`.max`/`.PSV`/8MB 镜像），全靠用户先自己导出成裸文件 |
| **批量** | 一次一个文件、一次一张图；没有批量导出/导入 |
| **图像编辑** | 没有调色板查看/编辑、没有索引编辑、没有像素级绘制 |
| **缩放/平移控制** | 预览只能"缩放到窗口、居中"，没有放大镜、没有 1:1 视图 |
| **撤销 / 历史** | 没有 |
| **导出格式选择** | 只能靠对话框的扩展名（PNG/GIF/BMP/JPEG），没有另存为提示 |
| **校验状态显示** | 不显示"这个存档的校验字节现在对不对" |
| **错误可见性** | 出错只出日志/弹窗；**注入失败不会阻止覆盖**（限制问题 12） |

## 七、如果照它做，值得保留 / 值得改的

**值得保留的**

* **拖放分流**（图 vs 存档）—— 交互上很顺手，一个动作覆盖两种意图；
* **画布用最近邻缩放** —— 128×128 的像素图放大后不糊，是对的；
* **注入后自动刷新预览** —— 让人立刻看到结果；
* **自动备份到带时间戳的目录** —— 比单文件 `.backup` 更适合反复试；
* **About 里塞使用说明** —— 省一个帮助窗口。

**值得改的**

* 拖放分流**别用 `FindPaletteOffset()`**（判据本身是坏的，见限制问题 11）；改用"12 字节头 + 18 段校验自洽"这两个硬判据；
* 备份失败要**阻止注入**，而不是只打日志；
* 备份目录别用 `wxGetCwd()`，用可配置的路径；
* 缩放要**一律缩到目标尺寸**（含放大），并在缩放后**重新二值化 alpha**；
* 打开存档后应该**枚举同一目录/同一槽族**（`E00..E07`、`EMB/data0..7`），而不是只认一个文件；
* 把"不透明色数 ≤255"做成**写入前的硬断言**（原版那个差一 bug 就是缺这个，限制问题 2）。
