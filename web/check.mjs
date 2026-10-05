/**
 * ★ 一条命令跑完**全部判据**（0.19 新增，对应审查清单里的 C9）。
 *
 *     node web\check.mjs                 # 打包 + 四套 node 测试 + 三条 python 判据
 *     node web\check.mjs --no-build      # 不重新打包（只跑测试；ui.test.ts 用现有产物）
 *     node web\check.mjs --no-python     # 跳过 python 部分（没装 Python 的机器）
 *     node web\check.mjs --quiet         # 只打印每一段的最后一行
 *
 * 为什么要有它：在这之前，"全套判据"是 `web\README.md` 里**手打的七条命令**
 * （build + core + card + image + ui + 三条 python），没有任何脚本串起来 ⇒
 * 少跑一条、跑错目录、忘了先打包都只能靠人记得。这个文件只做三件事：
 * 按固定顺序跑、把每段的退出码收起来、最后给一张总表。
 * **它不写任何判据逻辑** —— 判据仍然在被调用的那些脚本里。
 *
 * ⚠ 子进程一律 `stdio: 'inherit'`：受限沙箱下 piped stdio 会 EPERM，
 *   而且 inherit 能让失败时的原始输出直接落在终端上（不丢信息）。
 * ⚠ python 不存在时**跳过**（不算失败），因为抓取/解析那几条判据不是产品运行的前提；
 *   但会明确打印"跳过"，避免把"没跑"看成"跑过了"。
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = dirname(fileURLToPath(import.meta.url)); // …\emblem-tool\web
const PROJ = dirname(WEB); // …\emblem-tool
const argv = process.argv.slice(2);
const noBuild = argv.includes('--no-build');
const noPython = argv.includes('--no-python');
const quiet = argv.includes('--quiet');

const results = [];

/** 跑一条命令；返回退出码（命令不存在返回 'missing'）。 */
function run(label, cmd, args, cwd, opts = {}) {
  console.log(`\n${'='.repeat(78)}\n▶ ${label}\n  ${cmd} ${args.join(' ')}\n${'='.repeat(78)}`);
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: false, ...opts });
  if (r.error && r.error.code === 'ENOENT') {
    console.log(`  ⚠ 找不到 ${cmd} ⇒ 跳过`);
    results.push({ label, code: 'missing' });
    return 'missing';
  }
  if (r.error) {
    console.log(`  ✗ 起不来：${r.error.message}`);
    results.push({ label, code: 1 });
    return 1;
  }
  const code = r.status ?? 1;
  results.push({ label, code });
  return code;
}

const node = process.execPath;

// ── ① 打包 + 产物自检（含 node:vm 引导冒烟 + 取景冒烟）──
if (!noBuild) run('① 打包 + 产物自检', node, [join(WEB, 'build.mjs')], PROJ, quiet ? { stdio: 'ignore' } : {});
else console.log('\n（--no-build：跳过打包）');

// ── ② 四套 node 测试（零依赖，Node 原生跑 .ts）──
for (const t of ['core', 'card', 'image', 'ui']) {
  run(`② node 测试：${t}`, node, [join(WEB, 'test', `${t}.test.ts`)], PROJ, quiet ? { stdio: 'ignore' } : {});
}

// ── ③ python 判据（格式核心自检 / 与官方 exe 交叉验证 / 真实存档逐字节复原）──
const py = ['python', 'py'].find((c) => spawnSync(c, ['-c', 'print(1)'], { stdio: 'ignore' }).status === 0);
if (noPython) {
  console.log('\n（--no-python：跳过 python 判据）');
} else if (!py) {
  console.log('\n⚠ 这台机器上没有可用的 python ⇒ 跳过三条 python 判据（不算失败）');
  results.push({ label: '③ python 判据', code: 'missing' });
} else {
  const ev = join(PROJ, 'out', 'evidence', 'Mcd001_embdata2.ps2');
  if (!existsSync(ev)) console.log(`\n⚠ 找不到证据卡 ${ev} ⇒ card 测试里依赖它的两节会**明确跳过并说明**（不算失败）`);
  run('③ python：格式核心自检', py, [join(PROJ, 'tools', 'acet_format.py')], PROJ);
  // ★ 0.26：官方 exe（上游二进制）**不进仓库** ⇒ 别人 clone 下来没它。
  //   这一步是"与官方实现互相读写同一批样本"的交叉验证，缺了就**明确跳过并说明怎么补**，
  //   而不是让它报一个看不出原因的失败（本地有 exe 时行为不变）。
  const officialExe = join(PROJ, 'dist', 'v1.0.2', 'acet.exe');
  if (existsSync(officialExe)) {
    run('③ python：与官方 exe 交叉验证', py, [join(PROJ, 'tools', 'selftest.py')], PROJ);
  } else {
    console.log(`\n⚠ 找不到官方 exe ${officialExe}（上游二进制不进仓库）⇒ 跳过"与官方 exe 交叉验证"。`);
    console.log('  想跑这一步：把官方发布的 acet.exe 放到上面那个路径，或直接');
    console.log('    python tools\\selftest.py --exe <你的 acet.exe>');
    results.push({ label: '③ python：与官方 exe 交叉验证', code: 'missing' });
  }
  run('③ python：真实存档逐字节复原', py, [join(PROJ, '_selftest', 'validate_writer.py')], PROJ);
}

// ── 总表 ──
console.log(`\n${'='.repeat(78)}`);
console.log('判据总表');
console.log('='.repeat(78));
let failed = 0;
let skipped = 0;
for (const r of results) {
  const mark = r.code === 0 ? '✅' : r.code === 'missing' ? '⏭' : '❌';
  if (r.code !== 0 && r.code !== 'missing') failed += 1;
  if (r.code === 'missing') skipped += 1;
  console.log(`  ${mark} ${String(r.label).padEnd(34, ' ')} ${r.code === 'missing' ? '跳过' : r.code === 0 ? '通过' : '失败'}`);
}
console.log('='.repeat(78));
if (failed === 0) {
  console.log(`✅ 全绿${skipped ? `（${skipped} 段跳过）` : ''}`);
  process.exitCode = 0;
} else {
  console.log(`❌ ${failed} 段失败（上面每一段的原始输出都在）`);
  process.exitCode = 1;
}
