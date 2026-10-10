/**
 * 中英双语"总扫"——**可选的**手工判据（要浏览器，所以不进 `check.mjs`）。
 *
 * ## 为什么需要它
 *
 * `ui.test.ts` 只能测"纯逻辑 + 源码结构"：`t()` 对不对、`[data-en]` 有没有漏、重画名单里有没有某个函数。
 * 它**测不到"渲染时机"**——`v0.39`/`v0.40` 那一类 bug（切语言后某块文字停在旧语言）全是这么漏过去的，
 * 每次都要等用户截图抓出来。这个脚本就是那条判据：**切到英文，然后遍历整页可见文字，出现汉字即失败**。
 *
 * ## 覆盖的状态（每个状态都"中 → 英 → 中"各扫一遍）
 *
 *   ① 开机弹窗还开着（`#modal-*` 是 JS 写的，最容易漏）
 *   ② 导入一张图（顶部"文件名 · 尺寸"，剪贴板路线带"剪贴板 · "前缀）
 *   ③ 取景视图开着（白框下面那行读数 + 状态行）
 *   ④ 选了未验证作品（下拉选项 + 右边那句警告）
 *   ⑤ 切了作品（状态行那句"已切到…"）
 *
 * ## 豁免（不算失败）
 *
 *   · `#lang-label` / `#lang-select`：语言名**有意**各自用自己的语言写（`语言/Language`、`中文`/`English`）；
 *   · 内联 `<script>` / `<style>` 文本（那是源码，不是界面）；
 *   · `hidden`（或 `display:none`）的节点：收起来的弹窗、没内容的写卡日志 —— 用户看不见它们。
 *
 * ## 用法
 *
 * ```powershell
 * node web\tools\lang-sweep.mjs                 # 用仓库里的产物
 * node web\tools\lang-sweep.mjs --keep-shot     # 顺带把英文态整页截图存到 %TEMP%
 * ```
 *
 * 退出码：0 = 全过；1 = 有某个状态在英文下仍然出现汉字（并打印是哪个节点、什么文字）。
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ARTIFACT = resolve(HERE, '..', 'dist', 'emblem-tool.html');
const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/microsoft-edge',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findBrowser() {
  for (const p of EDGE_CANDIDATES) if (existsSync(p)) return p;
  return null;
}

/** 连 CDP（与 `screenshot.mjs` 同一套手法：**必须** `stdio:'inherit'`，否则无头 Edge 不开口）。 */
async function connect(browser, url, profileDir) {
  const port = 9700 + Math.floor(Math.random() * 200);
  const child = spawn(
    browser,
    ['--headless=new', '--disable-gpu', '--no-first-run', `--user-data-dir=${profileDir}`, '--window-size=1500,1100', `--remote-debugging-port=${port}`, url],
    { stdio: 'inherit' },
  );
  let wsUrl = null;
  for (let i = 0; i < 200 && !wsUrl; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      wsUrl = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)?.webSocketDebuggerUrl ?? null;
    } catch {
      /* 还没起来 */
    }
    if (!wsUrl) await sleep(200);
  }
  if (!wsUrl) {
    child.kill();
    throw new Error('连不上 DevTools 端口');
  }
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error('websocket 打不开'));
  });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  };
  const send = (method, params = {}) =>
    new Promise((res) => {
      const mid = ++id;
      pending.set(mid, res);
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error('页面里抛异常：' + r.result.exceptionDetails.exception?.description);
    return r.result?.result?.value;
  };
  await send('Runtime.enable');
  await send('Page.enable');
  return { child, ws, send, ev };
}

/** 扫一遍当前页面：返回"仍然含汉字"的可见节点（英文 / 韩文态用；日文态汉字是合法的）。 */
const SWEEP = `(function(){
  var bad = [];
  var invisible = function(el){
    for (var n = el; n && n.nodeType === 1; n = n.parentElement) {
      if (n.hidden) return true;
      try { if (getComputedStyle(n).display === 'none') return true; } catch (e) {}
    }
    return false;
  };
  var walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  var n;
  while ((n = walk.nextNode())) {
    var el = n.parentElement;
    if (!el) continue;
    if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE') continue;
    if (invisible(el)) continue;
    if (el.id === 'lang-label' || (el.closest && el.closest('#lang-select'))) continue;
    var txt = (n.nodeValue || '').trim();
    if (/[\\u4e00-\\u9fff]/.test(txt)) bad.push((el.id || el.className || el.tagName) + ' :: ' + txt.slice(0, 50));
  }
  return bad;
})()`;

/**
 * ★ 0.47：日语 / 韩语的"确实换过来了"判据。
 *   · 日语：正文里**必须出现假名**（`かな`）—— 汉字在日文里是合法的，所以不能再用"无汉字"，
 *     但"整页一个假名都没有"就说明它还是中文原文（或没切过去）。
 *   · 韩语：正文里**必须出现谚文**（`가-힣`）。
 */
const HAS_KANA = `(function(){
  var walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  var n;
  while ((n = walk.nextNode())) {
    var el = n.parentElement; if (!el) continue;
    if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE') continue;
    if (el.id === 'lang-label' || (el.closest && el.closest('#lang-select'))) continue;
    if (/[\\u3040-\\u30ff]/.test(n.nodeValue || '')) return true;
  }
  return false;
})()`;
const HAS_HANGUL = `(function(){
  var walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  var n;
  while ((n = walk.nextNode())) {
    var el = n.parentElement; if (!el) continue;
    if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE') continue;
    if (el.id === 'lang-label' || (el.closest && el.closest('#lang-select'))) continue;
    if (/[\\uac00-\\ud7af]/.test(n.nodeValue || '')) return true;
  }
  return false;
})()`;

async function main() {
  if (!existsSync(ARTIFACT)) {
    console.log(`❌ 找不到产物 ${ARTIFACT} —— 先跑 node web\\build.mjs`);
    process.exitCode = 1;
    return;
  }
  const browser = findBrowser();
  if (!browser) {
    console.log('⚠ 找不到 Chrome / Edge —— 跳过（这条是可选手工判据）');
    return;
  }
  const keepShot = process.argv.includes('--keep-shot');
  const profile = mkdtempSync(join(tmpdir(), 'emblem-lang-sweep-'));
  const { child, ws, send, ev } = await connect(browser, 'file:///' + ARTIFACT.replace(/\\/g, '/').replace(/ /g, '%20'), profile);
  const failures = [];
  const note = (ok, label, detail = '') => {
    console.log(`${ok ? '✅' : '❌'} ${label}${detail ? '  ' + detail : ''}`);
    if (!ok) failures.push(label + (detail ? ' — ' + detail : ''));
  };
  try {
    await sleep(1800);
    const setLang = async (l) => {
      await ev(`window.EmblemToolCore.ui.lang.set(${JSON.stringify(l)})`);
      await sleep(350);
    };
    const sweep = async (stateLabel) => {
      // 英文：不许有汉字
      await setLang('en');
      const badEn = await ev(SWEEP);
      note(
        Array.isArray(badEn) && badEn.length === 0,
        `英文态无汉字：${stateLabel}`,
        badEn.length ? JSON.stringify(badEn.slice(0, 6)) : '',
      );
      // 韩文：不许有汉字，而且必须真的有谚文（否则就是"没切过去"）
      await setLang('ko');
      const badKo = await ev(SWEEP);
      note(
        Array.isArray(badKo) && badKo.length === 0,
        `韩文态无汉字：${stateLabel}`,
        badKo.length ? JSON.stringify(badKo.slice(0, 6)) : '',
      );
      note((await ev(HAS_HANGUL)) === true, `韩文态确实有谚文：${stateLabel}`);
      // 日文：汉字合法 ⇒ 只要求"确实有假名"（全页一个假名都没有 = 还是中文原文）
      await setLang('ja');
      note((await ev(HAS_KANA)) === true, `日文态确实有假名：${stateLabel}`);
      await setLang('zh');
    };

    // ① 开机弹窗还开着
    const modalOpen = await ev(`!document.getElementById('modal-host').hidden`);
    note(modalOpen === true, '① 开机弹窗是开着的（这条最容易漏）');
    await sweep('开机弹窗');

    // ② 导入一张图（剪贴板路线）
    await ev(`document.getElementById('modal-ok').click()`);
    await ev(`(function(){
      var w=120,h=90,d=new Uint8ClampedArray(w*h*4);
      for (var i=0;i<w*h;i++){ d[i*4]=190; d[i*4+1]=40; d[i*4+2]=40; d[i*4+3]=255; }
      window.EmblemToolCore.ui.imageImport.applyImportedImage({data:d,width:w,height:h,name:''}, '', {clipboard:true});
      return 1; })()`);
    await sleep(700);
    await sweep('导入图片（顶部"文件名 · 尺寸"）');

    // ③ 取景视图开着
    await ev(`window.EmblemToolCore.ui.cropView.setCropView(true)`);
    await sleep(400);
    await ev(`window.EmblemToolCore.ui.cropView.setCropWindowSize(128)`);
    await sleep(250);
    await sweep('取景视图（白框读数 + 状态行）');
    await ev(`window.EmblemToolCore.ui.cropView.cancelCrop()`);
    await sleep(300);
    // ⚠ 这里要**断言内容**，不能只看"有字"：v0.40 我在 `main.ts` 里漏了一个 import
    //   （`setStatusPair`），那条路每点一次就抛 ReferenceError，状态行**留着上一句**
    //   （而上一句正好也能正确翻译）⇒ 只看"无汉字"会假过。这条盯的是"那句话本身换过来了"。
    const zhCancel = await ev(`document.getElementById('status').textContent`);
    note(zhCancel.includes('已取消取景'), '③a 取景取消那句状态行是中文的"已取消取景…"', JSON.stringify(zhCancel.slice(0, 36)));
    await setLang('en');
    const enCancel = await ev(`document.getElementById('status').textContent`);
    note(enCancel.includes('Crop cancelled'), '③b 切成英文之后**同一句**换成了 "Crop cancelled…"', JSON.stringify(enCancel.slice(0, 36)));
    await setLang('ja');
    const jaCancel = await ev(`document.getElementById('status').textContent`);
    note(jaCancel.includes('トリミング') && !jaCancel.includes('已取消'), '③c 切成日文之后同一句换成了日文（不是中文）', JSON.stringify(jaCancel.slice(0, 36)));
    await setLang('ko');
    const koCancel = await ev(`document.getElementById('status').textContent`);
    note(koCancel.includes('자르기') && !koCancel.includes('已取消'), '③d 切成韩文之后同一句换成了韩文（不是中文）', JSON.stringify(koCancel.slice(0, 36)));
    await setLang('zh');

    // ④ 选未验证作品
    await ev(`(function(){var s=document.getElementById('game-select');s.value='ac2';s.dispatchEvent(new Event('change'));return 1;})()`);
    await sleep(400);
    await sweep('未验证作品（下拉 + 警告）');

    // ⑤ 切作品（没开卡 ⇒ 界面按设计不报状态行，这里只扫语言；内容断言见 ③a/③b）
    await ev(`(function(){var s=document.getElementById('game-select');s.value='lr-jp';s.dispatchEvent(new Event('change'));return 1;})()`);
    await sleep(400);
    await sweep('切作品');

    if (keepShot) {
      await setLang('en');
      const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      const out = join(tmpdir(), 'emblem-lang-sweep.png');
      writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
      console.log(`\n截图（英文态整页）: ${out}`);
    }
  } finally {
    ws.close();
    child.kill();
  }

  console.log('\n' + '='.repeat(70));
  if (failures.length === 0) {
    console.log('✅ 语言总扫通过：英/韩态整页无汉字、日态确有假名、韩态确有谚文（语言标签豁免）');
  } else {
    console.log(`❌ 语言总扫失败 ${failures.length} 条：`);
    for (const f of failures) console.log('   · ' + f);
    process.exitCode = 1;
  }
}

await main();
