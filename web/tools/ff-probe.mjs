/**
 * ★ 0.48：FF（Formula Front）**真卡端到端**探针（可选的手工判据：要浏览器 + 一张带 FF 徽章的卡）。
 *
 * 它盯的是"纯逻辑测试看不见"的那一层：作品下拉 → 槽位模型 → 缩略图 → 写入 → 回读自检，
 * 全程走的是页面里真实的那些函数（\`reloadModel()\` / \`buildThumb()\` / \`writeSlot()\`）。
 *
 * 做法与 \`write-probe.mjs\` 相同：用 \`#card-input\` 那条**只读**兜底路打开真卡（拿不到写句柄），
 * 再把 \`window.confirm\` 覆盖成 \`() => false\` ⇒ 只走"内存副本 + 回读自检"，**磁盘一个字节都不动**。
 *
 * 用法：
 *   node web\tools\ff-probe.mjs [--card out\evidence\Mcd001_ff.ps2]
 *
 * 退出码：0 = 全过；1 = 有失败；找不到卡 / 浏览器时**跳过**（退出 0）。
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readCardFromBuffer } from '../src/core/card.ts';
import { ffExtractImage, isFfSave } from '../src/core/ff.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = resolve(HERE, '..');
const ARTIFACT = join(WEB, 'dist', 'emblem-tool.html');
const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/microsoft-edge',
  '/usr/bin/google-chrome',
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 选卡：`--card` 优先；否则在 `out\evidence\*.ps2` 里**找第一张带 FF 徽章目录的卡**。
 * （本机的开发卡叫 `Mcd001_ff.ps2`，但别人不一定这么命名 ⇒ 按内容找，而不是按文件名。）
 */
function pickCard() {
  const i = process.argv.indexOf('--card');
  if (i >= 0 && process.argv[i + 1]) return resolve(process.argv[i + 1]);
  const dir = resolve(WEB, '..', 'out', 'evidence');
  if (!existsSync(dir)) return null;
  for (const name of readdirSync(dir)) {
    if (!name.toLowerCase().endsWith('.ps2')) continue;
    const full = join(dir, name);
    try {
      if (readFfBlockFromCard(full)) return full;
    } catch {
      /* 读不出来的跳过 */
    }
  }
  return null;
}

/** FNV-1a（32 位）：页面里也算同一个，用来比对"缩略图/像素"没变或变了。 */
function fnv1a(bytes) {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** 从卡里把 FF 徽章块读出来（判据的"期望值"就从这里来，不是拿工具自己的产物自证）。 */
function readFfBlockFromCard(cardPath) {
  const card = readCardFromBuffer(new Uint8Array(readFileSync(cardPath)));
  for (const e of card.listRoot()) {
    if (e.isDot || !e.isDir) continue;
    if (!/EMB\d\d$/.test(e.name.toUpperCase())) continue;
    for (const k of card.listDir(e.name)) {
      if (k.isDot || k.isDir) continue;
      const bytes = new Uint8Array(card.readFile(k.cluster, k.length));
      if (isFfSave(bytes)) return { dir: e.name, file: k.name, block: bytes };
    }
  }
  return null;
}

async function main() {
  if (!existsSync(ARTIFACT)) {
    console.log('⚠ 没有产物 —— 先跑 node web\build.mjs（跳过）');
    return;
  }
  const card = pickCard();
  if (!card || !existsSync(card)) {
    console.log('⚠ 找不到带 FF 徽章的真卡（out\evidence\Mcd001_ff.ps2，或用 --card 指定）—— 跳过');
    return;
  }
  const browser = EDGE_CANDIDATES.find((p) => existsSync(p));
  if (!browser) {
    console.log('⚠ 找不到 Chrome / Edge —— 跳过');
    return;
  }
  const cardInfo = readFfBlockFromCard(card);
  if (!cardInfo) {
    console.log('⚠ 这张卡上没有 FF 徽章存档 —— 跳过');
    return;
  }
  const expectRgba = ffExtractImage(cardInfo.block);
  const expectHash = fnv1a(expectRgba);
  const cardHashBefore = createHash('sha256').update(readFileSync(card)).digest('hex');
  const mtimeBefore = statSync(card).mtimeMs;
  console.log('真卡：' + card);
  console.log('FF 徽章：' + cardInfo.dir + '\\' + cardInfo.file + '（' + cardInfo.block.length + ' 字节）');

  const profile = mkdtempSync(join(tmpdir(), 'emblem-ff-probe-'));
  const port = 9900 + Math.floor(Math.random() * 90);
  const child = spawn(
    browser,
    ['--headless=new', '--disable-gpu', '--no-first-run', '--user-data-dir=' + profile, '--window-size=1500,1100', '--remote-debugging-port=' + port,
      'file:///' + ARTIFACT.replace(/\\/g, '/').replace(/ /g, '%20')],
    { stdio: 'ignore' },
  );
  let wsUrl = null;
  for (let i = 0; i < 200 && !wsUrl; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
      wsUrl = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)?.webSocketDebuggerUrl ?? null;
    } catch {
      /* 还没起来 */
    }
    if (!wsUrl) await sleep(200);
  }
  if (!wsUrl) {
    child.kill();
    console.log('⚠ 连不上 DevTools 端口 —— 跳过');
    return;
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

  const failures = [];
  const note = (ok, label, detail = '') => {
    console.log((ok ? '✅ ' : '❌ ') + label + (detail ? '  ' + detail : ''));
    if (!ok) failures.push(label + (detail ? ' — ' + detail : ''));
  };

  try {
    await send('Runtime.enable');
    await send('Page.enable');
    await send('DOM.enable');
    await sleep(1800);
    await ev("(function(){var b=document.getElementById('modal-ok'); if(b) b.click(); return 1;})()");
    await sleep(300);

    const doc = await send('DOM.getDocument', { depth: -1 });
    const q = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: '#card-input' });
    await send('DOM.setFileInputFiles', { files: [card], nodeId: q.result.nodeId });
    await sleep(2500);
    const cardName = await ev('(window.EmblemToolCore.ui.state.card||{}).fileName || ""');
    if (!cardName) {
      console.log('❌ 真卡没打开：' + card);
      failures.push('真卡没打开');
      return;
    }
    await ev('window.confirm = function(){ return false; }');

    // ── ① 切到 FF：目录/槽/缩略图 ──
    const ffOpt = await ev("(function(){var s=document.getElementById('game-select');var o=[].slice.call(s.options).filter(function(x){return x.value==='ff-jp';});return o.length?o[0].value:'';})()");
    note(ffOpt === 'ff-jp', '① 作品下拉里有 Formula Front（ff-jp）');
    await ev("(function(){var s=document.getElementById('game-select');s.value='ff-jp';s.dispatchEvent(new Event('change',{bubbles:true}));return 1;})()");
    await sleep(800);

    // ★ 0.48 回归：切到一个**卡上有目录**的作品时，`onGameChanged()` 曾经引用了一个不存在的
    //   `entry` ⇒ `ReferenceError`，页面右下角弹"未捕获的错"。这条断言钉住它不再出现。
    const errToasts = JSON.parse(await ev("(function(){return JSON.stringify([].slice.call(document.querySelectorAll('#toasts .toast')).map(function(t){return (t.querySelector('.toast-title')||{}).textContent||'';}).filter(function(s){return /未捕获|报错|error/i.test(s);}));})()"));
    note(errToasts.length === 0, '①b 切到 FF 之后页面里没有"未捕获的错"提示条', JSON.stringify(errToasts));

    const model = JSON.parse(await ev("(function(){var m=window.EmblemToolCore.ui.state.model;return JSON.stringify({serial:m&&m.serial,dirs:m?m.dirNames:[],occupied:m?m.slots.map(function(s){return !!s.occupied;}):[],files:m?m.slots.map(function(s){return s.fileName;}):[]});})()"));
    note(model.serial === 'SLPS-25461', '② 槽位模型按 FF 的盘序列号过滤（' + model.serial + '）');
    note(model.dirs.join(',') === cardInfo.dir, '③ 认出了 FF 的徽章目录 ' + cardInfo.dir, JSON.stringify(model.dirs));
    note(model.occupied.filter(Boolean).length >= 1, '④ 至少一格被占用（缩略图有内容）');
    note(model.files[0] === cardInfo.file, '⑤ 槽 1 的文件名 = ' + cardInfo.file, JSON.stringify(model.files[0]));

    // ── ② 缩略图像素必须与从卡里独立解出来的 RGBA 一致 ──
    const thumbHash = await ev("(function(){var t=window.EmblemToolCore.ui.state.thumbs[0];if(!t)return 0;var d=t.data,h=0x811c9dc5;for(var i=0;i<d.length;i++){h^=d[i];h=Math.imul(h,0x01000193)>>>0;}return h>>>0;})()");
    note(thumbHash === expectHash, '⑥ 槽 1 缩略图与"从卡里独立解出的 RGBA"逐像素一致', '页面 ' + thumbHash + ' vs 期望 ' + expectHash);
    const thumbInfo = JSON.parse(await ev("(function(){var t=window.EmblemToolCore.ui.state.thumbs[0]||{};return JSON.stringify({ok:!!t.checksumsOk18,detail:t.checksumDetail||''});})()"));
    note(thumbInfo.ok === true && thumbInfo.detail === 'MD5', '⑦ 缩略图带的自检结论是 MD5 通过', JSON.stringify(thumbInfo));

    // ── ③ 导入一张合成图，写入（确认框按取消 ⇒ 只走内存 + 回读自检） ──
    await ev("(function(){var w=200,h=200,d=new Uint8ClampedArray(w*h*4);for(var y=0;y<h;y++)for(var x=0;x<w;x++){var o=(y*w+x)*4;d[o]=230;d[o+1]=40;d[o+2]=40;d[o+3]=(x<40&&y<40)?0:255;}window.EmblemToolCore.ui.imageImport.applyImportedImage({data:d,width:w,height:h,name:'ff.png'},'ff.png');return 1;})()");
    await sleep(900);
    await ev('window.EmblemToolCore.ui.cropView.cancelCrop()');
    await sleep(400);
    await ev("document.querySelector('.slot[data-slot=\"0\"]').dispatchEvent(new MouseEvent('click',{bubbles:true}))");
    await sleep(200);
    await ev("document.getElementById('btn-write').click()");
    await sleep(2500);
    const after = JSON.parse(await ev("(function(){return JSON.stringify({status:document.getElementById('status').textContent,log:document.getElementById('write-log').innerText});})()"));
    note(/MD5 校验通过/.test(after.log), '⑧ 回读自检报的是 MD5 通过（不是"18 段校验"）', JSON.stringify((after.log.split('\n')[0] || '').slice(0, 90)));
    note(/逐字节比对一致/.test(after.log), '⑨ 回读逐字节一致');
    note(!/❌/.test(after.log), '⑩ 日志里没有失败行', JSON.stringify(after.log.slice(0, 120)));
    note(/取消/.test(after.status), '⑪ 状态行如实说"已取消"（只读打开 ⇒ 不落盘）', JSON.stringify(after.status.slice(0, 60)));
    note(/调色板与元数据取自卡上的真实 FF 存档/.test(after.log), '⑫ 日志写明了模板来源（调色板/元数据继承自真实存档）');

    // ── ④ 换过图之后，缩略图必须变（内存副本真的写进去了） ──
    await sleep(300);
    const thumbHash2 = await ev("(function(){var t=window.EmblemToolCore.ui.state.thumbs[0];if(!t)return 0;var d=t.data,h=0x811c9dc5;for(var i=0;i<d.length;i++){h^=d[i];h=Math.imul(h,0x01000193)>>>0;}return h>>>0;})()");
    note(thumbHash2 !== expectHash, '⑬ 写之后槽 1 的缩略图变了（内存副本生效 + 视图已重建）');

    // ── ④b ★ 0.48：往**空的槽 2** 写 ⇒ 工具要能把槽目录按模板建出来 ──
    await ev("document.querySelector('.slot[data-slot=\"1\"]').dispatchEvent(new MouseEvent('click',{bubbles:true}))");
    await sleep(300);
    // ⚠ 这句话要在**点写入之前**取：写成功之后模型里已经有 emb01 了，提示区自然不再说"新建"
    const hintBefore = await ev("document.getElementById('write-hint').innerText");
    await ev("document.getElementById('btn-write').click()");
    await sleep(3000);
    const after2 = JSON.parse(await ev("(function(){return JSON.stringify({status:document.getElementById('status').textContent,log:document.getElementById('write-log').innerText,hint:document.getElementById('write-hint').innerText});})()"));
    note(/新建槽目录\s*BISLPS-25461emb01/.test(after2.log), '④b 新建槽时日志写明"新建槽目录 BISLPS-25461emb01"', JSON.stringify((after2.log.match(/新建槽目录[^\n]*/) || [''])[0].slice(0, 90)));
    note(/MD5 校验通过/.test(after2.log) && /逐字节比对一致/.test(after2.log), '④c 新槽的徽章也过了 MD5 + 逐字节自检（不是"拒绝"）');
    note(!/❌/.test(after2.log), '④d 新槽写入日志里没有失败行', JSON.stringify(after2.log.slice(0, 160)));
    note(/新建/.test(hintBefore), '④e 点写入之前提示区就说了这一槽是"新建"', JSON.stringify(hintBefore.slice(0, 90)));
    const slots2 = await ev("(function(){var c=[].slice.call(document.querySelectorAll('.slot'));return c.map(function(x){return x.querySelector('canvas')?'1':'0';}).join('');})()");
    note(slots2[1] === '1', '④f 重建视图之后**槽 2** 也有缩略图了（内存副本 + 模型都跟上了）', slots2);
    const newDir = await ev("(function(){var m=window.EmblemToolCore.ui.state.model;return m.dirNames.join(',');})()");
    note(/BISLPS-25461emb01/i.test(newDir), '④g 模型里出现了新目录 ' + newDir);

    // ── ⑤ 磁盘一个字节都没动 ──
    await sleep(300);
    const cardHashAfter = createHash('sha256').update(readFileSync(card)).digest('hex');
    note(cardHashAfter === cardHashBefore, '⑭ ★ 磁盘上的卡一个字节都没动（只读打开 + 取消落盘）');
    note(statSync(card).mtimeMs === mtimeBefore, '⑮ 卡的修改时间也没变');
  } finally {
    ws.close();
    child.kill();
  }

  console.log('\n' + '='.repeat(70));
  if (failures.length === 0) {
    console.log('✅ FF 端到端探针通过（模型 / 缩略图 / 写入 / MD5 自检 / 只读安全）');
  } else {
    console.log('❌ FF 端到端探针失败 ' + failures.length + ' 条：');
    for (const f of failures) console.log('   · ' + f);
    process.exitCode = 1;
  }
}

await main();
