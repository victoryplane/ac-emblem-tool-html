/**
 * 用**无头 Chrome** 给产物截图 —— 开发期自查用的小工具（**不属于交付物，也不进任何测试套件**）。
 *
 * ## 为什么要有它
 *
 * 界面改动只有两种验证方式：① 让用户打开看一眼；② 自己先看一眼。这一版（v0.9）用它抓到了一个
 * **测试测不到的真 bug**：`#crop-actions` 带 `hidden` 却照样显示 —— 因为浏览器默认的
 * `[hidden] { display: none }` 优先级低于作者写的 `.row { display: flex }`。
 * 冒烟测试、DOM 结构断言全都过，只有"看一眼"能发现。
 *
 * ## 用法
 *
 * ```powershell
 * node web\tools\screenshot.mjs                                  # 默认页面 → web\_shot.png
 * node web\tools\screenshot.mjs --out D:\a.png --size 1600,950
 * node web\tools\screenshot.mjs --crop                           # ★ 假源图 + **走真路导入**（导入即进取景模式）
 * node web\tools\screenshot.mjs --crop-min                       # ★ 同上，再往里滚到底（看"已到最小 1:1"那行）
 * node web\tools\screenshot.mjs --preview                        # ★ 导入后**收起取景视图**（看"当前图片"铺开多大）
 * node web\tools\screenshot.mjs --card out\evidence\Mcd001_TEST.ps2 --size 1500,2300
 *                                                                # ★ 打开一张真卡 → 下半部分那 8 个槽
 * node web\tools\screenshot.mjs --boot                            # ★ 不点掉开机告知弹窗 → web\_shot_boot.png
 * ```
 *
 * 选项：
 *   · `--out <路径>`  输出 PNG（默认 `web\_shot.png`；取景/预览/开卡模式各有自己的默认名）
 *   · `--size W,H`    视口尺寸（默认 `1600,950`，≈ 1080p 上最大化后的内容区）
 *   · `--crop`        注入"假源图 + 走**真路**导入"（`ui.imageImport.applyImportedImage`）——
 *                     0.16 起导入会自动进取景模式，所以这就是取景视图本身
 *   · `--crop-min`    同上，再往里滚到底，用来核对"白框最小 = 128 源像素 / 1:1"那条限制
 *   · `--preview`     导入后再**收起取景视图**，用来核对"当前图片"到底铺开了多大
 *                     （v0.10 的 68px bug 就是这么抓到的）
 *   · `--card <路径>`  ★ 0.20：把这张 `.ps2` 的字节塞进一个 `File`，往 `#card-drop` 派发一个**真的**
 *                     `drop` 事件（= 用户拖卡进来的同一条路）⇒ 用它看**下半部分的 8 个槽**。
 *                     ⚠ 视口要够高，否则 8 格在折线以下：`--size 1500,2300` 是验证过的尺寸。
 *   · `--boot`         ★ 0.26：**不**点掉开机那个"未经过完整测试 / 自行备份"的告知弹窗 ——
 *                     截的就是用户双击产物时看到的第一屏。
 *                     （其它所有模式都会先 `#modal-ok.click()` 把它点掉，否则截到的全是遮罩。）
 *   · `--chrome <路径>` 或环境变量 `CHROME_PATH`（默认在常见安装位置里找 Chrome / Edge）
 *
 * ⚠ 它**只读**产物（复制一份到临时文件里注入脚本，不碰 `web\dist\emblem-tool.html`），
 *   并且用独立的 `--user-data-dir`（临时目录）⇒ 不会动你正在用的浏览器配置。
 * ⚠ 需要本机装了 Chrome/Edge；没装就报错退出（**不是**测试失败）。
 */

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url)); // web/tools
const WEB = resolve(HERE, '..');
const ARTIFACT = join(WEB, 'dist', 'emblem-tool.html');

function argOf(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const crop = process.argv.includes('--crop') || process.argv.includes('--crop-min');
const cropMin = process.argv.includes('--crop-min');
const preview = process.argv.includes('--preview');
/** ★ 0.26：`--boot` = 不点掉开机告知弹窗，截"用户双击打开产物时看到的第一个画面"。 */
const boot = process.argv.includes('--boot');
const cardPath = argOf('--card', null);
/** ★ 0.28：`--lang en` = 切到英文界面再截；★ 0.47 起也收 `ja` / `ko`（默认 `zh`，与产物默认一致）。 */
const lang = argOf('--lang', 'zh');
const size = argOf('--size', cardPath ? '1500,2300' : '1600,950');
const out = resolve(
  argOf(
    '--out',
    join(WEB, boot ? '_shot_boot.png' : cardPath ? '_shot_card.png' : cropMin ? '_shot_crop_min.png' : preview ? '_shot_preview.png' : crop ? '_shot_crop.png' : '_shot.png'),
  ),
);

function findChrome() {
  const explicit = argOf('--chrome', process.env.CHROME_PATH ?? null);
  if (explicit) return explicit;
  const pf = process.env['ProgramFiles'] ?? 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
  const local = process.env['LOCALAPPDATA'] ?? '';
  const candidates = [
    join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    local ? join(local, 'Google', 'Chrome', 'Application', 'chrome.exe') : '',
    join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].filter(Boolean);
  return candidates.find((p) => existsSync(p)) ?? '';
}

/** 造一张 1707×1067 的假源图，并**走真路导入**（`ui.imageImport.applyImportedImage`）。 */
function importScript(extra) {
  return `
  var W = 1707, H = 1067;
  var d = new Uint8ClampedArray(W * H * 4);
  for (var y = 0; y < H; y++) {
    for (var x = 0; x < W; x++) {
      var o = (y * W + x) * 4;
      d[o] = (x * 255 / W) | 0;
      d[o + 1] = (y * 255 / H) | 0;
      d[o + 2] = (((x >> 6) ^ (y >> 6)) & 1) ? 210 : 40;
      d[o + 3] = 255;
    }
  }
  // ★ 0.16 起这条真路会**自动进取景模式**（用户："加载图片后默认启动取景模式"），
  //   所以 --crop 不需要再手动 setCropView(true)，--preview 反而要手动收起来。
  c.ui.imageImport.applyImportedImage({ data: d, width: W, height: H, name: 'probe-1707x1067.png' }, 'probe-1707x1067.png');
  ${extra}
`;
}

/** ★ 0.20：打开一张**真记忆卡** —— 真路：把字节塞进 File，往 `#card-drop` 派发真的 drop 事件。 */
function cardScript(path) {
  const abs = resolve(path);
  if (!existsSync(abs)) throw new Error(`找不到记忆卡 ${abs}`);
  const b64 = readFileSync(abs).toString('base64');
  return `
  var bin = atob("${b64}");
  var u8 = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  var file = new File([u8], ${JSON.stringify(basename(abs))}, { type: 'application/octet-stream' });
  var dt = new DataTransfer();
  dt.items.add(file);
  var zone = document.getElementById('card-drop');
  if (!zone) throw new Error('找不到 #card-drop（产物结构变了？）');
  zone.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
`;
}

/** 把产物复制一份，并在末尾注入探针脚本。 */
function makeProbe(html, mode) {
  const body =
    mode === 'card'
      ? cardScript(cardPath)
      : mode === 'crop'
        ? importScript(cropMin ? 'for (var i = 0; i < 80; i++) c.ui.cropView.applyZoom(1.15); // 一直往里滚 ⇒ 停在"最小（1:1）"\n  c.ui.cropView.flushCropLayout();' : '')
        : mode === 'preview'
          ? importScript(`
  // 收起取景视图 = "按了〔确定取景〕/〔取消〕之后"的样子（导入本身已经自动进取景了）
  c.ui.cropView.setCropView(false);
`)
          : '';
  // ★ 0.28（中英双语）/ ★ 0.47（四语）：`--lang en|ja|ko` ⇒ 先把语言切过去再做事，
  //   截到的就是那种语言的界面（静态外壳靠 `data-*` 刷，JS 生成的那部分靠切语言时的重画）。
  const langLine = lang === 'zh' ? '' : `c.ui.lang.set(${JSON.stringify(lang)});\n  `;
  const inject = `
<script>
(function () {
  // ★ 0.26：产物一打开就会弹"本项目未经过完整测试 / 请自行备份记忆卡"的告知
  //   ⇒ 除 --boot 外，**先把它点掉**，否则截到的全是那层遮罩（这一条是必须的，不是可选）。
  //   ⚠ 这段是**模板字符串内部**：注释里绝不能出现反引号（会提前结束模板）—— 本构建器踩过这个坑。
  var okBtn = document.getElementById('modal-ok');
  if (okBtn) okBtn.click();
  var c = window.EmblemToolCore;
  ${langLine}${body}})();
</script>
`;
  if (!html.includes('</body>')) throw new Error('产物里找不到 </body>（构建产物结构变了？）');
  return html.replace('</body>', inject + '</body>');
}

function main() {
  if (!existsSync(ARTIFACT)) {
    console.error(`找不到构建产物 ${ARTIFACT} —— 先跑 node web/build.mjs`);
    process.exitCode = 1;
    return;
  }
  const chrome = findChrome();
  if (!chrome) {
    console.error('找不到 Chrome / Edge（可以用 --chrome <路径> 或环境变量 CHROME_PATH 指定）');
    process.exitCode = 1;
    return;
  }
  const profile = mkdtempSync(join(tmpdir(), 'emblem-shot-'));
  const tmpHtml = join(profile, 'page.html');
  const mode = boot ? 'boot' : cardPath ? 'card' : preview ? 'preview' : crop ? 'crop' : '';
  if (mode === 'boot') {
    // ★ 0.26 `--boot`：**不**注入任何探针 ⇒ 截到的就是用户双击打开产物时看到的第一个画面
    //   （"本项目未经过完整测试 / 请自行备份记忆卡"那层弹窗）。
    copyFileSync(ARTIFACT, tmpHtml);
  } else {
    // 其余模式都要先把告知弹窗点掉，否则截到的全是遮罩（`makeProbe` 开头那两行）。
    writeFileSync(tmpHtml, makeProbe(readFileSync(ARTIFACT, 'utf8'), mode), 'utf8');
  }
  const url = 'file:///' + tmpHtml.replace(/\\/g, '/').replace(/ /g, '%20');
  const r = spawnSync(
    chrome,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      `--user-data-dir=${profile}`,
      `--window-size=${size}`,
      // ★ 0.28：`--lang en` 时把 **Chrome 自己的语言**也设成 en-US ⇒ `navigator.language` 就是 en-US
      //   ⇒ 一并验证"英文浏览器首次打开自动给 English"这条规则（`Logic/i18n.ts::detectLang`）。
      //   探针里那次 `c.ui.lang.set(...)` 是双保险（手动切换那条路）。
      //   ★ 0.47：`ja` / `ko` 同理（浏览器语言 → 首屏语言）。
      ...(lang === 'en' ? ['--lang=en-US'] : lang === 'ja' ? ['--lang=ja-JP'] : lang === 'ko' ? ['--lang=ko-KR'] : []),
      // ★ 0.20：开卡那一档要留够时间（8 MB 的卡要先 base64 解码再读完整个文件系统）
      `--virtual-time-budget=${mode === 'card' ? 15000 : 6000}`,
      `--screenshot=${out}`,
      url,
    ],
    { stdio: 'ignore' }, // ⚠ 不要 piped stdio（受限沙箱下会 EPERM）；输出只用截图本身
  );
  if (r.error) throw r.error;
  if (!existsSync(out)) {
    console.error(`截图没生成（chrome 退出码 ${r.status}）—— 换个 --out 路径或检查 Chrome 版本`);
    process.exitCode = 1;
    return;
  }
  const bytes = readFileSync(out).length;
  const what = mode === 'card' ? `已打开 ${basename(resolve(cardPath))}` : mode === 'crop' ? '取景视图' : '导入后（预览）';
  console.log(`✅ 截图：${out}（${bytes} 字节，视口 ${size}${mode ? `，${what}` : ''}）`);
}

main();
