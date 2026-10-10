/**
 * 写卡"真路"探针（**可选的手工判据**：要浏览器 + 一张真卡，所以不进 `check.mjs`）。
 *
 * ## 它盯的是什么
 *
 * `writeSlot()` 的真实顺序是「**先在内存副本上写** → 弹落盘确认框 → 回读自检 → 有句柄才落盘」。
 * 这条路上有两个只有端到端才能发现的坑（都是这套判据抓出来的）：
 *
 *   ① **取消 ≠ 失败**：用户在确认框按取消时，内存副本**已经改过了** ⇒ 界面必须按"内存里的真相"
 *      重建 8 格，否则模型还说那一槽是空的 ⇒ 第二次写入撞 `已经有 dataN，拒绝覆盖`、〔删除槽〕也说
 *      "本来就是空的" ⇒ **用户卡死**（只能重开卡）。同时状态行要说"已取消"，不能报"被拒绝"。
 *   ② **新槽（新建文件）那条路**：目录已满时要扩目录簇，扩出来的簇**绝不能落在刚分配的数据簇上**
 *      （撞页会把新 dirent / 数据盖掉，回读长度会莫名其妙变成 1 簇）。
 *
 * ## 怎么做到"不写盘也能测"
 *
 * 用 `#card-input` 那条**只读**兜底路打开真卡（拿不到写句柄），再把页面里的 `window.confirm`
 * 覆盖成 `() => false` ⇒ 走"用户按取消"分支：内存改、磁盘**一个字节都不动**（真卡只读打开）。
 *
 * ## 用法
 *
 * ```powershell
 * node web\tools\write-probe.mjs                                  # 默认找 out\evidence\*.ps2
 * node web\tools\write-probe.mjs --card out\evidence\X.ps2         # 指定真卡
 * ```
 *
 * 退出码：0 = 全过；1 = 有失败（并打印是哪一条）。找不到真卡 / 找不到浏览器时**跳过**（退出 0）。
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = resolve(HERE, '..');
const ARTIFACT = join(WEB, 'dist', 'emblem-tool.html');
const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/microsoft-edge',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pickCard() {
  const i = process.argv.indexOf('--card');
  if (i >= 0 && process.argv[i + 1]) return resolve(process.argv[i + 1]);
  const dir = resolve(WEB, '..', 'out', 'evidence');
  if (!existsSync(dir)) return null;
  const f = readdirSync(dir).find((n) => n.toLowerCase().endsWith('.ps2'));
  return f ? join(dir, f) : null;
}

async function main() {
  if (!existsSync(ARTIFACT)) {
    console.log(`⚠ 没有产物 ${ARTIFACT} —— 先跑 node web\\build.mjs（跳过）`);
    return;
  }
  const card = pickCard();
  if (!card || !existsSync(card)) {
    console.log('⚠ 找不到真卡（out\\evidence\\*.ps2，或用 --card 指定）—— 跳过（这是可选手工判据）');
    return;
  }
  const browser = EDGE_CANDIDATES.find((p) => existsSync(p));
  if (!browser) {
    console.log('⚠ 找不到 Chrome / Edge —— 跳过');
    return;
  }
  const profile = mkdtempSync(join(tmpdir(), 'emblem-write-probe-'));
  const port = 9700 + Math.floor(Math.random() * 200);
  const child = spawn(
    browser,
    ['--headless=new', '--disable-gpu', '--no-first-run', `--user-data-dir=${profile}`, '--window-size=1500,1100', `--remote-debugging-port=${port}`, 'file:///' + ARTIFACT.replace(/\\/g, '/').replace(/ /g, '%20')],
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
    console.log(`${ok ? '✅' : '❌'} ${label}${detail ? '  ' + detail : ''}`);
    if (!ok) failures.push(label + (detail ? ' — ' + detail : ''));
  };

  try {
    await send('Runtime.enable');
    await send('Page.enable');
    await send('DOM.enable');
    await sleep(1800);
    await ev(`(function(){var b=document.getElementById('modal-ok'); if(b) b.click(); return 1;})()`);
    await sleep(300);

    // 真卡（只读兜底路）+ "用户在确认框里按取消"
    const doc = await send('DOM.getDocument', { depth: -1 });
    const q = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: '#card-input' });
    await send('DOM.setFileInputFiles', { files: [card], nodeId: q.result.nodeId });
    await sleep(2500);
    const cardName = await ev(`(window.EmblemToolCore.ui.state.card||{}).fileName || ''`);
    if (!cardName) {
      console.log(`❌ 真卡没打开：${card}`);
      failures.push('真卡没打开');
      return;
    }
    console.log(`真卡：${cardName}（只读打开 ⇒ 全程不写盘）`);
    await ev(`window.confirm = function(){ return false; }`);

    // 合成一张不透明图并导入
    await ev(`(function(){
      var w=300,h=300,d=new Uint8ClampedArray(w*h*4);
      for (var y=0;y<h;y++) for (var x=0;x<w;x++){ var o=(y*w+x)*4; d[o]=(x*3)%256; d[o+1]=(y*7)%256; d[o+2]=((x+y)*5)%256; d[o+3]=255; }
      window.EmblemToolCore.ui.imageImport.applyImportedImage({data:d,width:w,height:h,name:'probe.png'},'probe.png');
      return 1; })()`);
    await sleep(900);
    await ev(`window.EmblemToolCore.ui.cropView.cancelCrop()`); // 导入后会自动进取景视图
    await sleep(400);

    const state = () => ev(`(function(){
      var cards=[].slice.call(document.querySelectorAll('.slot'));
      return JSON.stringify({
        occupied: cards.map(function(c){return c.querySelector('canvas')?'1':'0';}).join(''),
        status: document.getElementById('status').textContent,
        log: document.getElementById('write-log').innerText
      }); })()`);

    /**
     * ★ 0.43（用户："我觉得这部分的提示过于重复了"）：把"同一个事实被讲了几遍"量出来。
     *   `hint` = 提示区的每一行（`#write-hint` 的子元素）；`logHidden` = 写入日志框收没收起；
     *   `toasts` = 屏上还没消失的提示条（标题 + 正文）。
     */
    const screens = () => ev(`(function(){
      var hint=document.getElementById('write-hint');
      var log=document.getElementById('write-log');
      var note=document.getElementById('slot-note');
      return JSON.stringify({
        hint: [].slice.call(hint.children).map(function(c){return { text:c.textContent, title:c.getAttribute('title')||'' };}),
        status: document.getElementById('status').textContent,
        logHidden: !!log.hidden,
        log: log.innerText,
        note: note && !note.hidden ? note.innerText : '',
        toasts: [].slice.call(document.querySelectorAll('#toasts .toast')).map(function(t){
          return { title:(t.querySelector('.toast-title')||{}).textContent||'', body:(t.querySelector('.toast-body')||{}).textContent||'' };})
      }); })()`);

    const before = JSON.parse(await state());
    const emptyIdx = before.occupied.indexOf('0');
    if (emptyIdx < 0) {
      console.log('⚠ 这张卡 8 个槽都满了 —— 跳过（换一张有空槽的卡）');
      return;
    }
    await ev(`document.querySelector('.slot[data-slot="${emptyIdx}"]').dispatchEvent(new MouseEvent('click',{bubbles:true}))`);
    await sleep(300);

    // ① 写一次（取消）
    await ev(`document.getElementById('btn-write').click()`);
    await sleep(2500);
    const after = JSON.parse(await state());
    const log1 = after.log;
    note(/逐字节比对一致|checksum/i.test(log1) && !/❌/.test(log1.split('\n')[0] ?? ''), '① 内存写入 + 回读自检通过（日志第一段是 ✅）', JSON.stringify((log1.split('\n')[0] ?? '').slice(0, 70)));
    note(after.occupied[emptyIdx] === '1', '② 取消之后模型已按内存副本重建（那一格出现缩略图）');
    note(/取消/.test(after.status), '③ 状态行如实说"已取消"（不是"被拒绝"）', JSON.stringify(after.status.slice(0, 40)));

    // ④ 再写一次：旧版会撞"拒绝覆盖"卡死，现在应当报"覆盖"
    await ev(`document.getElementById('btn-write').click()`);
    await sleep(2500);
    const again = JSON.parse(await state());
    note(!/拒绝覆盖/.test(again.log), '④ 第二次写入没有撞"已经有…拒绝覆盖"（不卡死）');
    note(/覆盖/.test(again.log), '⑤ 第二次是"覆盖"（说明模型知道那一格已经有文件）');
    note(/18 段校验 18\/18/.test(again.log), '⑥ 第二次回读 18 段校验 18/18');

    // ── ⑦⑧ ★ 0.43：预检被拒那条路 —— 一个事实只在**一个主位**讲全文 ──
    //   造法：切到"卡上没有它的目录"的作品（本卡只有一个作品的目录，随便换个作品即可）。
    const picked = await ev(`(function(){
      var sel=document.getElementById('game-select');
      var opts=[].slice.call(sel.options);
      for (var i=0;i<opts.length;i++){
        sel.value=opts[i].value;
        sel.dispatchEvent(new Event('change',{bubbles:true}));
        var m=window.EmblemToolCore.ui.state.model;
        if (m && m.serial && m.dirNames.length===0) return JSON.stringify({value:opts[i].value,label:opts[i].textContent,serial:m.serial});
      }
      return '';
    })()`);
    if (!picked) {
      console.log('⚠ 这张卡的目录覆盖了所有作品 —— 跳过 ⑦⑧（换一张卡就能测）');
    } else {
      const g = JSON.parse(picked);
      console.log(`切到「${g.label}」（${g.serial}）—— 卡上没有它的目录`);
      await sleep(500);
      const opened = JSON.parse(await screens());
      note(
        !opened.toasts.some((t) => /没有当前作品的徽章目录|no emblem folder for the selected game/i.test(t.title)),
        '⑦ 打开卡 / 切作品**不再弹那条 20 秒 info toast**（状态行 + 8 槽上方已经说了）',
        JSON.stringify(opened.toasts.map((t) => t.title)),
      );
      note(/切作品查看/.test(opened.note), '⑧ 8 槽上方那条常驻警告给了条数 + "切作品查看"', JSON.stringify(opened.note));

      await ev(`document.getElementById('btn-write').click()`);
      await sleep(1200);
      const s = JSON.parse(await screens());
      note(s.hint.length === 1 && /卡上没有目录/.test(s.hint[0].text), '⑨ 提示区**只有一行**（就是拒绝正文）', JSON.stringify(s.hint.map((h) => h.text.slice(0, 40))));
      note(!!s.hint[0].title && /不会新建目录/.test(s.hint[0].title), '⑩ 机制解释在 `title` 上（hover 才看，不占正文）');
      note(s.logHidden && s.log === '', '⑪ ★★ 预检被拒 ⇒ 日志框保持收起（"没发生任何事"不进日志）', JSON.stringify(s.log.slice(0, 40)));
      note(/被拒绝：.*缺作品目录.*见上方提示行/.test(s.status) && !/见右侧日志/.test(s.status), '⑫ 状态行 = "被拒绝：<一句话标签>（见上方提示行）"', JSON.stringify(s.status));
      const last = s.toasts[s.toasts.length - 1] ?? { title: '', body: '' };
      note(/^写入被拒绝/.test(last.title) && /见上方提示行/.test(last.body), '⑬ toast = 一句标签 + 指针（不再抄一遍全文）', JSON.stringify(last));
    }
  } finally {
    ws.close();
    child.kill();
  }

  console.log('\n' + '='.repeat(70));
  if (failures.length === 0) {
    console.log('✅ 写卡真路探针通过（内存写 + 回读自检 + 取消语义 + 不卡死 + 0.43 提示去重）');
  } else {
    console.log(`❌ 写卡真路探针失败 ${failures.length} 条：`);
    for (const f of failures) console.log('   · ' + f);
    process.exitCode = 1;
  }
}

await main();
